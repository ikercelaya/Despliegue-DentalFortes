require("dotenv").config();

// Zona horaria de la clínica. Vercel/Lambda corren en UTC y Vercel bloquea la
// env var TZ, así que la forzamos aquí antes de cualquier cálculo de fechas.
process.env.TZ = "Europe/Madrid";

const path = require("path");
const express = require("express");

const { supabase } = require("./lib/db");
const { issueToken, checkPassword, requireAuth } = require("./lib/auth");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

function normalizeMetaTemplateName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
}

function extractNumericTemplateVars(text) {
  const found = new Set();
  const re = /{{\s*(\d+)\s*}}/g;
  let match;
  while ((match = re.exec(String(text || "")))) found.add(Number(match[1]));
  return [...found].filter((n) => n > 0).sort((a, b) => a - b);
}

function hasNamedTemplateVars(text) {
  return /{{\s*[^}\d\s][^}]*}}/.test(String(text || ""));
}

function parseExampleValues(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function addTextExamples(component, exampleValues, key) {
  const vars = extractNumericTemplateVars(component.text);
  if (!vars.length) return;
  for (let i = 0; i < vars.length; i++) {
    if (vars[i] !== i + 1) {
      throw new Error(`Las variables de ${key} deben ir seguidas: {{1}}, {{2}}, {{3}}...`);
    }
  }
  const maxVar = Math.max(...vars);
  if (exampleValues.length < maxVar) {
    throw new Error(`Faltan ejemplos para las variables de ${key}. Necesitas ${maxVar} ejemplo(s).`);
  }
  if (key === "body_text") {
    component.example = { body_text: [vars.map((n) => exampleValues[n - 1])] };
  } else {
    component.example = { [key]: [exampleValues[vars[0] - 1]] };
  }
}

app.use(express.json({ limit: "8mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public")));

// --------- Páginas ---------
app.get("/", (_req, res) => res.redirect(302, "/admin"));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// =============================================================
// AUTH
// =============================================================
app.post("/api/auth/login", async (req, res) => {
  const password = String(req.body?.password || "");
  if (!password) return res.status(400).json({ error: "Falta contraseña." });
  const ok = await checkPassword(password);
  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta." });
  const token = issueToken({ role: "admin" });
  return res.json({ token });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ session: req.session }));

// =============================================================
// DASHBOARD — KPIs genéricos
// =============================================================
app.get("/api/dashboard/stats", requireAuth, async (_req, res) => {
  try {
    const now = new Date();
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
    const in7days = new Date(now); in7days.setDate(in7days.getDate() + 7);
    const startWeek = new Date(now); startWeek.setDate(now.getDate() - now.getDay() + 1); startWeek.setHours(0, 0, 0, 0);

    // KPI 1 — citas hoy
    const { count: citasHoy } = await supabase
      .from("df_appointments")
      .select("id", { count: "exact", head: true })
      .gte("starts_at", startToday.toISOString())
      .lte("starts_at", endToday.toISOString())
      .in("status", ["pending", "confirmed"]);

    // KPI 2 — citas próximos 7 días
    const { count: citas7 } = await supabase
      .from("df_appointments")
      .select("id", { count: "exact", head: true })
      .gte("starts_at", now.toISOString())
      .lte("starts_at", in7days.toISOString())
      .in("status", ["pending", "confirmed"]);

    // KPI 3 — pacientes nuevos esta semana
    const { count: pacientesNuevos } = await supabase
      .from("df_patients")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startWeek.toISOString());

    // Resumen extra: distribución por estado
    const { data: porEstado } = await supabase
      .from("df_appointments")
      .select("status")
      .gte("starts_at", startWeek.toISOString());

    const distribucion = (porEstado || []).reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      citasHoy: citasHoy || 0,
      citasProximos7Dias: citas7 || 0,
      pacientesNuevosEstaSemana: pacientesNuevos || 0,
      distribucionSemana: distribucion,
    });
  } catch (err) {
    console.error("[dashboard]", err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// AGENDA / CITAS
// =============================================================
app.get("/api/appointments", requireAuth, async (req, res) => {
  try {
    const { from, to, professional_id, status } = req.query;
    let q = supabase
      .from("df_appointments")
      .select("*, df_patients(id, full_name, phone), df_professionals(id, name, specialty, color), df_treatments(id, name, duration_minutes)")
      .order("starts_at", { ascending: true });
    if (from) q = q.gte("starts_at", from);
    if (to) q = q.lte("starts_at", to);
    if (professional_id) q = q.eq("professional_id", professional_id);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ appointments: data });
  } catch (err) {
    console.error("[appointments/list]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/appointments", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.starts_at || !body.ends_at) return res.status(400).json({ error: "Faltan fechas." });
    const { data, error } = await supabase
      .from("df_appointments")
      .insert({
        patient_id: body.patient_id || null,
        professional_id: body.professional_id || null,
        treatment_id: body.treatment_id || null,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        status: body.status || "pending",
        is_first_visit: !!body.is_first_visit,
        is_urgent: !!body.is_urgent,
        source: body.source || "manual",
        notes: body.notes || null,
      })
      .select()
      .single();
    if (error) throw error;
    return res.json({ appointment: data });
  } catch (err) {
    console.error("[appointments/create]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/appointments/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["patient_id","professional_id","treatment_id","starts_at","ends_at","status","is_first_visit","is_urgent","notes"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_appointments")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    return res.json({ appointment: data });
  } catch (err) {
    console.error("[appointments/update]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/appointments/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_appointments").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PACIENTES
// =============================================================
app.get("/api/patients", requireAuth, async (req, res) => {
  try {
    const { q, state, tag, limit } = req.query;
    let query = supabase
      .from("df_patients")
      .select("id, full_name, phone, email, birth_date, language, patient_state, tags, marketing_consent, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(Math.min(500, Number(limit) || 200));
    if (state) query = query.eq("patient_state", state);
    if (tag) query = query.contains("tags", [tag]);
    if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ patients: data });
  } catch (err) {
    console.error("[patients/list]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/patients", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.full_name) return res.status(400).json({ error: "Falta nombre." });
    const { data, error } = await supabase
      .from("df_patients")
      .insert({
        full_name: body.full_name,
        phone: body.phone || null,
        email: body.email || null,
        birth_date: body.birth_date || null,
        language: body.language || "es",
        patient_state: body.patient_state || "higiene",
        tags: Array.isArray(body.tags) ? body.tags : [],
        notes: body.notes || null,
        marketing_consent: !!body.marketing_consent,
      })
      .select()
      .single();
    if (error) throw error;
    return res.json({ patient: data });
  } catch (err) {
    console.error("[patients/create]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/patients/:id", requireAuth, async (req, res) => {
  try {
    const { data: patient, error } = await supabase
      .from("df_patients").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!patient) return res.status(404).json({ error: "Paciente no encontrado." });
    const [{ data: pending }, { data: history }, { data: payments }, { data: appointments }] = await Promise.all([
      supabase.from("df_patient_pending").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_patient_history").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_patient_payments").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_appointments")
        .select("*, df_professionals(name, specialty), df_treatments(name)")
        .eq("patient_id", req.params.id).order("starts_at", { ascending: false }).limit(50),
    ]);
    return res.json({ patient, pending: pending || [], history: history || [], payments: payments || [], appointments: appointments || [] });
  } catch (err) {
    console.error("[patients/get]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/patients/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["full_name","phone","email","birth_date","language","patient_state","tags","notes","marketing_consent","dni"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_patients").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    return res.json({ patient: data });
  } catch (err) {
    console.error("[patients/update]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/patients/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_patients").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Subrecursos del paciente
app.post("/api/patients/:id/pending", requireAuth, async (req, res) => {
  try {
    const { description, treatment_id } = req.body || {};
    if (!description) return res.status(400).json({ error: "Falta descripción." });
    const { data, error } = await supabase
      .from("df_patient_pending")
      .insert({ patient_id: req.params.id, description, treatment_id: treatment_id || null })
      .select().single();
    if (error) throw error;
    return res.json({ pending: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/patients/:id/pending/:pid", requireAuth, async (req, res) => {
  try {
    const patch = {};
    if ("done" in req.body) {
      patch.done = !!req.body.done;
      patch.done_at = patch.done ? new Date().toISOString() : null;
    }
    if ("description" in req.body) patch.description = req.body.description;
    const { data, error } = await supabase
      .from("df_patient_pending").update(patch).eq("id", req.params.pid).select().single();
    if (error) throw error;
    return res.json({ pending: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/patients/:id/history", requireAuth, async (req, res) => {
  try {
    const { note, appointment_id } = req.body || {};
    if (!note) return res.status(400).json({ error: "Falta nota." });
    const { data, error } = await supabase
      .from("df_patient_history")
      .insert({ patient_id: req.params.id, note, appointment_id: appointment_id || null })
      .select().single();
    if (error) throw error;
    return res.json({ history: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/patients/:id/payments", requireAuth, async (req, res) => {
  try {
    const { amount_eur, paid, concept, notes, appointment_id } = req.body || {};
    if (amount_eur == null) return res.status(400).json({ error: "Falta importe." });
    const { data, error } = await supabase
      .from("df_patient_payments").insert({
        patient_id: req.params.id,
        amount_eur,
        paid: !!paid,
        paid_at: paid ? new Date().toISOString() : null,
        concept: concept || null,
        notes: notes || null,
        appointment_id: appointment_id || null,
      }).select().single();
    if (error) throw error;
    return res.json({ payment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PROFESIONALES
// =============================================================
app.get("/api/professionals", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_professionals")
      .select("*, df_professional_schedules(*)")
      .order("name", { ascending: true });
    if (error) throw error;
    return res.json({ professionals: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/professionals", requireAuth, async (req, res) => {
  try {
    const { name, specialty, color, schedules } = req.body || {};
    if (!name || !specialty) return res.status(400).json({ error: "Faltan datos." });
    const { data: pro, error } = await supabase
      .from("df_professionals").insert({ name, specialty, color: color || "#9ca3af" })
      .select().single();
    if (error) throw error;
    if (Array.isArray(schedules) && schedules.length) {
      const rows = schedules.map(s => ({
        professional_id: pro.id,
        weekday: Number(s.weekday),
        start_time: s.start_time,
        end_time: s.end_time,
      }));
      await supabase.from("df_professional_schedules").insert(rows);
    }
    return res.json({ professional: pro });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/professionals/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","specialty","color","active","notes"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_professionals").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    if (Array.isArray(req.body.schedules)) {
      await supabase.from("df_professional_schedules").delete().eq("professional_id", req.params.id);
      const rows = req.body.schedules.map(s => ({
        professional_id: req.params.id,
        weekday: Number(s.weekday),
        start_time: s.start_time,
        end_time: s.end_time,
      }));
      if (rows.length) await supabase.from("df_professional_schedules").insert(rows);
    }
    return res.json({ professional: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// TRATAMIENTOS
// =============================================================
app.get("/api/treatments", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_treatments").select("*").order("name", { ascending: true });
    if (error) throw error;
    return res.json({ treatments: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/treatments", requireAuth, async (req, res) => {
  try {
    const { name, duration_minutes, description, is_first_visit } = req.body || {};
    if (!name) return res.status(400).json({ error: "Falta nombre." });
    const { data, error } = await supabase
      .from("df_treatments").insert({
        name,
        duration_minutes: Number(duration_minutes) || 30,
        description: description || null,
        is_first_visit: !!is_first_visit,
      }).select().single();
    if (error) throw error;
    return res.json({ treatment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/treatments/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","duration_minutes","description","active","is_first_visit"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_treatments").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    return res.json({ treatment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/treatments/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_treatments").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// CONVERSACIONES (placeholder para el bot que se integra después)
// =============================================================
app.get("/api/conversations", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_conversations")
      .select("id, customer_name, customer_phone, customer_email, language, channel, status, is_urgent, bot_enabled, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ conversations: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations/:id", requireAuth, async (req, res) => {
  try {
    const { data: conv } = await supabase
      .from("df_conversations").select("*").eq("id", req.params.id).maybeSingle();
    if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });
    const { data: messages } = await supabase
      .from("df_messages").select("*").eq("conversation_id", req.params.id).order("created_at");
    return res.json({ ...conv, messages: messages || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversations/:id/reply", requireAuth, async (req, res) => {
  try {
    const content = String(req.body?.content || "").trim();
    if (!content) return res.status(400).json({ error: "Mensaje vacío." });
    const { error } = await supabase.from("df_messages")
      .insert({ conversation_id: req.params.id, role: "admin", content });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversations/:id/toggle-bot", requireAuth, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const { error } = await supabase.from("df_conversations")
      .update({ bot_enabled: enabled }).eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversations/:id/close", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_conversations")
      .update({ status: "closed" }).eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Eliminar conversación (los mensajes se borran en cascada por la FK).
app.delete("/api/conversations/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_conversations").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// RESEÑAS (flujo 4.5/5: <=4 → interno, >4 → Google)
// =============================================================
app.get("/api/reviews", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_reviews")
      .select("*, df_patients(id, full_name, phone)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ reviews: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/reviews", requireAuth, async (req, res) => {
  try {
    const { patient_id, appointment_id, rating, comment } = req.body || {};
    if (rating == null) return res.status(400).json({ error: "Falta rating." });
    const r = Number(rating);
    const routed_to = r >= 4.5 ? "google" : "internal";
    const { data, error } = await supabase
      .from("df_reviews").insert({
        patient_id: patient_id || null,
        appointment_id: appointment_id || null,
        rating: r,
        comment: comment || null,
        routed_to,
      }).select().single();
    if (error) throw error;
    return res.json({ review: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/reviews/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["status","internal_resolution"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_reviews").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    return res.json({ review: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// CAMPAÑAS DE MARKETING
// =============================================================
app.get("/api/campaigns", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_campaigns").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return res.json({ campaigns: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/campaigns", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim();

    // Formato nuevo: segments[] (puede incluir "custom:Nombre").
    // Compatibilidad con el formato antiguo (segment único).
    let segments = Array.isArray(b.segments) ? b.segments.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!segments.length && b.segment) segments = [String(b.segment).trim()];
    const templateName = String(b.template_name || b.message_template || "").trim();

    if (!name) return res.status(400).json({ error: "Falta el nombre de la campaña." });
    if (!segments.length) return res.status(400).json({ error: "Selecciona al menos un segmento." });

    const STANDARD = ["por_edad", "por_tratamiento", "presupuestos_no_aceptados", "inactivos", "manual"];
    // La columna 'segment' tiene CHECK: guardamos ahí el primer segmento estándar (o 'manual').
    const primarySegment = segments.find((s) => STANDARD.includes(s)) || "manual";
    const customSegments = segments.filter((s) => s.startsWith("custom:")).map((s) => s.slice(7));

    const baseConfig = b.segment_config && typeof b.segment_config === "object" ? b.segment_config : {};
    const segment_config = {
      ...baseConfig,
      segments,
      treatments: Array.isArray(b.treatments) ? b.treatments : (baseConfig.treatments || []),
      age_ranges: Array.isArray(b.age_ranges) ? b.age_ranges : (baseConfig.age_ranges || []),
      custom_segments: customSegments,
      template_name: templateName,
    };

    const { data, error } = await supabase
      .from("df_campaigns").insert({
        name,
        segment: primarySegment,
        segment_config,
        message_template: templateName, // columna NOT NULL: guardamos el nombre de la plantilla
        scheduled_at: b.scheduled_at || null,
        status: b.scheduled_at ? "scheduled" : "draft",
      }).select().single();
    if (error) throw error;
    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/campaigns/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","segment","segment_config","message_template","status","scheduled_at"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    const { data, error } = await supabase
      .from("df_campaigns").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    return res.json({ campaign: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Listar las plantillas creadas en Meta (para el desplegable de campañas).
app.get("/api/marketing/templates", requireAuth, async (_req, res) => {
  try {
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || "";
    const token = process.env.WHATSAPP_TOKEN || "";
    if (!wabaId || !token) return res.json({ templates: [], configured: false });

    const url = `${META_GRAPH_BASE}/${wabaId}/message_templates?limit=200&fields=name,status,category,language`;
    const metaRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const metaData = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      const detail = metaData?.error?.error_user_msg || metaData?.error?.message || `Meta Graph ${metaRes.status}`;
      return res.status(502).json({ error: detail, templates: [], configured: true });
    }
    return res.json({ templates: metaData.data || [], configured: true });
  } catch (err) {
    return res.status(500).json({ error: err.message, templates: [] });
  }
});

// Crear plantillas de WhatsApp en Meta desde el apartado Marketing.
app.post("/api/marketing/templates", requireAuth, async (req, res) => {
  try {
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || "";
    const token = process.env.WHATSAPP_TOKEN || "";
    if (!wabaId || !token) {
      return res.status(500).json({
        error: "Faltan WHATSAPP_BUSINESS_ACCOUNT_ID o WHATSAPP_TOKEN en las variables de entorno.",
      });
    }

    const name = normalizeMetaTemplateName(req.body?.name);
    const category = String(req.body?.category || "MARKETING").trim().toUpperCase();
    const language = String(req.body?.language || "es_ES").trim();
    const headerText = String(req.body?.header_text || "").trim();
    const bodyText = String(req.body?.body_text || "").trim();
    const footerText = String(req.body?.footer_text || "").trim();
    const bodyExamples = parseExampleValues(req.body?.body_examples);
    const headerExamples = parseExampleValues(req.body?.header_examples);

    if (!name) return res.status(400).json({ error: "Falta el nombre de la plantilla." });
    if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(category)) {
      return res.status(400).json({ error: "Categoría de plantilla no válida." });
    }
    if (!language) return res.status(400).json({ error: "Falta el idioma de la plantilla." });
    if (!bodyText) return res.status(400).json({ error: "Falta el texto principal de la plantilla." });
    if (bodyText.length > 1024) return res.status(400).json({ error: "El texto principal supera 1024 caracteres." });
    if (headerText.length > 60) return res.status(400).json({ error: "El encabezado supera 60 caracteres." });
    if (footerText.length > 60) return res.status(400).json({ error: "El pie supera 60 caracteres." });
    if (hasNamedTemplateVars(headerText) || hasNamedTemplateVars(bodyText) || hasNamedTemplateVars(footerText)) {
      return res.status(400).json({
        error: "Meta solo acepta variables numeradas como {{1}}, {{2}}. No uses {{nombre}} en plantillas de Meta.",
      });
    }

    const components = [];
    if (headerText) {
      const header = { type: "HEADER", format: "TEXT", text: headerText };
      addTextExamples(header, headerExamples.length ? headerExamples : bodyExamples, "header_text");
      components.push(header);
    }

    const body = { type: "BODY", text: bodyText };
    addTextExamples(body, bodyExamples, "body_text");
    components.push(body);

    if (footerText) components.push({ type: "FOOTER", text: footerText });

    const payload = {
      name,
      category,
      language,
      allow_category_change: req.body?.allow_category_change !== false,
      components,
    };

    const metaRes = await fetch(`${META_GRAPH_BASE}/${wabaId}/message_templates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const metaData = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      const detail = metaData?.error?.error_user_msg || metaData?.error?.message || `Meta Graph ${metaRes.status}`;
      return res.status(502).json({ error: detail, meta: metaData });
    }

    return res.json({
      template: metaData,
      submitted: { name, category, language },
    });
  } catch (err) {
    console.error("[marketing/template]", err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// CHATBOT — chat web público (Fase 2)
// =============================================================
// CORS: el widget se embebe en la web de la clínica (otro dominio) y llama aquí.
app.options("/api/chat", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  return res.sendStatus(204);
});

app.post("/api/chat", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Mensaje vacío." });
    if (message.length > 2000) return res.status(400).json({ error: "Mensaje demasiado largo." });

    const { handleMessage } = require("./lib/bot");
    const result = await handleMessage({
      channel: "web",
      token: req.body?.token || null,
      name: req.body?.name || null,
      text: message,
    });
    return res.json({
      reply: result.reply,
      token: result.conversation?.access_token || req.body?.token || null,
      language: result.language,
    });
  } catch (err) {
    console.error("[chat]", err);
    return res.status(500).json({ error: "No se ha podido procesar el mensaje." });
  }
});

// =============================================================
// WHATSAPP — webhook (Fase 2b / Cloud API de Meta)
// =============================================================
// Verificación del webhook (Meta hace un GET con hub.challenge).
app.get("/api/whatsapp/webhook", (req, res) => {
  const wa = require("./lib/whatsapp");
  const challenge = wa.verifyChallenge(req.query);
  if (challenge) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Recepción de mensajes entrantes.
app.post("/api/whatsapp/webhook", async (req, res) => {
  const wa = require("./lib/whatsapp");
  if (!wa.verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
    return res.sendStatus(403);
  }
  try {
    const { handleMessage } = require("./lib/bot");
    for (const m of wa.parseIncoming(req.body)) {
      if (!m.text) {
        await wa.sendText(m.from, "De momento solo puedo leer mensajes de texto. ¿Me lo escribe, por favor?").catch(() => {});
        continue;
      }
      const result = await handleMessage({ channel: "whatsapp", phone: m.from, name: m.name, text: m.text });
      if (result.reply) {
        await wa.sendText(m.from, result.reply).catch((e) => console.error("[wa send]", e.message));
      }
    }
  } catch (err) {
    console.error("[whatsapp]", err);
  }
  // Siempre 200 para que Meta no reintente en bucle.
  return res.sendStatus(200);
});

// =============================================================
// 404
// =============================================================
app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada", path: req.path }));

app.listen(PORT, () => {
  console.log(`Dental Fortes CRM listo en ${PUBLIC_URL} (puerto ${PORT})`);
});

module.exports = app;
