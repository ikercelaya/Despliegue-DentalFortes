require("dotenv").config();

// Zona horaria de la clínica. Vercel/Lambda corren en UTC y Vercel bloquea la
// env var TZ, así que la forzamos aquí antes de cualquier cálculo de fechas.
process.env.TZ = "Europe/Madrid";

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const { supabase } = require("./lib/db");
const { issueToken, checkPassword, requireAuth } = require("./lib/auth");
const { assignCabinet, CAPACITY_REASONS } = require("./lib/scheduling");

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
    const isFirstVisit = !!body.is_first_visit;
    let cabinet = body.cabinet != null ? Number(body.cabinet) : null;

    // Capacidad y gabinete (reglas de agenda). El personal puede forzar con force:true.
    if (!body.force) {
      const cap = await assignCabinet({
        supabase,
        startISO: body.starts_at,
        endISO: body.ends_at,
        isFirstVisit,
        professionalId: body.professional_id || null,
        desiredCabinet: cabinet, // si el personal eligió gabinete, se valida que esté libre
      });
      if (!cap.ok) {
        return res.status(409).json({ error: CAPACITY_REASONS[cap.reason] || "Sin disponibilidad a esa hora.", reason: cap.reason });
      }
      cabinet = cap.cabinet; // usa el gabinete validado (respeta el elegido si estaba libre)
    }

    const status = body.status || "pending";
    const { data, error } = await supabase
      .from("df_appointments")
      .insert({
        patient_id: body.patient_id || null,
        professional_id: body.professional_id || null,
        treatment_id: body.treatment_id || null,
        cabinet,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        status,
        is_first_visit: isFirstVisit,
        is_urgent: !!body.is_urgent,
        confirmed_at: status === "confirmed" ? new Date().toISOString() : null,
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
    const body = req.body || {};
    const allowed = ["patient_id","professional_id","treatment_id","cabinet","starts_at","ends_at","status","is_first_visit","is_urgent","notes"];
    const patch = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];

    // Revalida capacidad SOLO si el tramo/profesional/tipo/gabinete cambia de verdad
    // (el panel reenvía esos campos aunque no los toques; comparándolos con el valor
    // actual evitamos 409 espurios al editar solo notas/estado, p. ej. al confirmar).
    const touchesScheduleKeys = ["starts_at","ends_at","professional_id","is_first_visit","cabinet"].some((k) => k in patch);
    if (touchesScheduleKeys && !body.force) {
      const { data: cur } = await supabase.from("df_appointments").select("*").eq("id", req.params.id).maybeSingle();
      if (cur) {
        const sameTime = (a, b) => { const x = Date.parse(a), y = Date.parse(b); return !isNaN(x) && !isNaN(y) && x === y; };
        const changed =
          ("starts_at" in patch && !sameTime(patch.starts_at, cur.starts_at)) ||
          ("ends_at" in patch && !sameTime(patch.ends_at, cur.ends_at)) ||
          ("professional_id" in patch && (patch.professional_id || null) !== (cur.professional_id || null)) ||
          ("is_first_visit" in patch && !!patch.is_first_visit !== !!cur.is_first_visit) ||
          ("cabinet" in patch && Number(patch.cabinet || 0) !== Number(cur.cabinet || 0));
        if (changed) {
          const startISO = patch.starts_at || cur.starts_at;
          const endISO = patch.ends_at || cur.ends_at;
          const isFV = "is_first_visit" in patch ? !!patch.is_first_visit : !!cur.is_first_visit;
          const proId = "professional_id" in patch ? (patch.professional_id || null) : cur.professional_id;
          const desired = "cabinet" in patch ? patch.cabinet : cur.cabinet;
          const cap = await assignCabinet({ supabase, startISO, endISO, isFirstVisit: isFV, professionalId: proId, excludeId: cur.id, desiredCabinet: desired });
          if (!cap.ok) {
            return res.status(409).json({ error: CAPACITY_REASONS[cap.reason] || "Sin disponibilidad a esa hora.", reason: cap.reason });
          }
          patch.cabinet = cap.cabinet; // gabinete validado
        }
      }
    }

    // Confirmación: al pasar a 'confirmed' sella la fecha; al reabrir a 'pending' la limpia.
    if (patch.status === "confirmed") patch.confirmed_at = new Date().toISOString();
    else if (patch.status === "pending") patch.confirmed_at = null;

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
// CONFIRMACIÓN DE CITAS + RECORDATORIOS (cadencia 3 días / 1 día / 6 horas)
// -------------------------------------------------------------
// El paciente confirma con un enlace con token (público). Un cron recorre la
// cadencia de recordatorios y, si está activado, autocancela las no confirmadas
// para liberar el hueco.
// =============================================================
const CONFIRM_SECRET = process.env.CONFIRM_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "df-confirm-secret";
const AUTO_CANCEL_HOURS = Number(process.env.AUTO_CANCEL_HOURS || 2);
const AUTO_CANCEL_ENABLED = /^(1|true|si|sí|on)$/i.test(String(process.env.AUTO_CANCEL_ENABLED || ""));

function confirmToken(id) {
  return crypto.createHmac("sha256", CONFIRM_SECRET).update(String(id)).digest("hex").slice(0, 32);
}
function confirmLink(id) {
  return `${PUBLIC_URL}/api/appointments/${id}/confirm?t=${confirmToken(id)}`;
}
function confirmPage(message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dental Fortes</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f0f0f;color:#ececec;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:420px;text-align:center;background:#181818;border:1px solid #2a2a2a;border-radius:16px;padding:32px}
h1{font-size:18px;margin:0 0 8px}p{color:#b8b8b8;margin:0}</style></head>
<body><div class="card"><h1>Dental Fortes</h1><p>${message}</p></div></body></html>`;
}

// Confirmación pública (el paciente pincha el enlace del recordatorio).
app.get("/api/appointments/:id/confirm", async (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  try {
    const id = req.params.id;
    const expBuf = Buffer.from(confirmToken(id));
    const gotBuf = Buffer.from(String(req.query.t || ""));
    const valid = gotBuf.length === expBuf.length && crypto.timingSafeEqual(gotBuf, expBuf);
    if (!valid) return res.status(403).send(confirmPage("Enlace no válido."));
    const { data: appt } = await supabase
      .from("df_appointments").select("id, status").eq("id", id).maybeSingle();
    if (!appt) return res.status(404).send(confirmPage("No hemos encontrado la cita."));
    if (appt.status === "cancelled") {
      return res.status(200).send(confirmPage("Esta cita estaba cancelada. Por favor, contacte con la clínica."));
    }
    if (appt.status !== "pending" && appt.status !== "confirmed") {
      // 'done' / 'no_show': ya no tiene sentido confirmarla.
      return res.status(200).send(confirmPage("Esta cita ya no está activa. Si necesita algo, contacte con la clínica."));
    }
    if (appt.status === "confirmed") {
      return res.status(200).send(confirmPage("Su cita ya estaba confirmada. ¡Le esperamos!"));
    }
    await supabase.from("df_appointments")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", id);
    return res.status(200).send(confirmPage("¡Gracias! Su cita ha quedado confirmada."));
  } catch (err) {
    console.error("[confirm]", err);
    return res.status(500).send(confirmPage("No se ha podido confirmar ahora mismo. Inténtelo más tarde."));
  }
});

// Cadencia de recordatorios: cada tramo se envía una vez dentro de su ventana.
const REMINDER_STEPS = [
  { field: "reminder_3d_at", fromH: 24, toH: 72, label: "3 días" },
  { field: "reminder_1d_at", fromH: 6, toH: 24, label: "1 día" },
  { field: "reminder_6h_at", fromH: 0, toH: 6, label: "6 horas" },
];

function reminderText(appt, _label) {
  const cuando = new Date(appt.starts_at).toLocaleString("es-ES", {
    weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
  });
  const nombre = appt.df_patients?.full_name ? " " + String(appt.df_patients.full_name).split(" ")[0] : "";
  return `Hola${nombre}, le recordamos su cita en Dental Fortes el ${cuando}. ` +
    `Por favor, confírmela para mantenerla: ${confirmLink(appt.id)} ` +
    `Si no se confirma, el hueco podría liberarse. Gracias.`;
}

async function runReminders() {
  const wa = require("./lib/whatsapp");
  const now = Date.now();
  const iso = (h) => new Date(now + h * 3600000).toISOString();
  const result = { sent: 0, cancelled: 0, processed: 0, errors: [], autoCancelEnabled: AUTO_CANCEL_ENABLED };

  // 1) Recordatorios por cada tramo de la cadencia.
  for (const step of REMINDER_STEPS) {
    const { data: appts } = await supabase
      .from("df_appointments")
      .select("id, starts_at, status, df_patients(full_name, phone)")
      .in("status", ["pending", "confirmed"])
      .is(step.field, null)
      .gt("starts_at", iso(step.fromH))
      .lte("starts_at", iso(step.toH));
    for (const a of appts || []) {
      result.processed++;
      const phone = a.df_patients?.phone;
      let sent = false;
      try {
        // Solo tiene sentido recordar las que aún están pendientes de confirmar.
        if (a.status !== "confirmed" && phone && wa.isConfigured()) {
          await wa.sendText(phone, reminderText(a, step.label));
          result.sent++;
          sent = true;
        }
      } catch (e) {
        result.errors.push(`${a.id} (${step.label}): ${e.message}`);
      }
      // Marca el tramo SOLO si el recordatorio se envió de verdad (o si ya está
      // confirmada y no necesita aviso). Si no se pudo avisar, se deja para el
      // próximo intento y NUNCA se autocancela sin haber avisado al paciente.
      if (sent || a.status === "confirmed") {
        await supabase.from("df_appointments").update({ [step.field]: new Date().toISOString() }).eq("id", a.id);
      }
    }
  }

  // 2) Autocancelación de citas NO confirmadas (si está habilitada).
  //    Requiere que ya se les enviara el recordatorio de 6h hace >1h.
  if (AUTO_CANCEL_ENABLED) {
    const graceISO = new Date(now - 3600000).toISOString();
    const { data: toCancel } = await supabase
      .from("df_appointments")
      .select("id, notes")
      .eq("status", "pending")
      .is("confirmed_at", null)
      .not("reminder_6h_at", "is", null)
      .lt("reminder_6h_at", graceISO)
      .gt("starts_at", new Date(now).toISOString())
      .lte("starts_at", iso(AUTO_CANCEL_HOURS));
    for (const a of toCancel || []) {
      await supabase.from("df_appointments").update({
        status: "cancelled",
        auto_cancelled: true,
        notes: [a.notes, "Cancelada automáticamente por falta de confirmación"].filter(Boolean).join(" · "),
      }).eq("id", a.id);
      result.cancelled++;
    }
  }
  return result;
}

function checkCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sin secreto: se permite (protégelo con CRON_SECRET en Vercel)
  if ((req.get("authorization") || "") === `Bearer ${secret}`) return true;
  if (String(req.query.key || "") === secret) return true;
  return false;
}

app.get("/api/cron/reminders", async (req, res) => {
  if (!checkCronAuth(req)) return res.sendStatus(401);
  try {
    const result = await runReminders();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/reminders]", err);
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
    const { name, specialty, color, schedules, is_generalist } = req.body || {};
    if (!name || !specialty) return res.status(400).json({ error: "Faltan datos." });
    const { data: pro, error } = await supabase
      .from("df_professionals").insert({ name, specialty, color: color || "#9ca3af", is_generalist: !!is_generalist })
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
    const allowed = ["name","specialty","color","active","notes","is_generalist"];
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

// Diagnóstico de la conexión con Meta (usa las MISMAS variables que el CRM).
// Sirve para saber si el problema al crear plantillas está en Vercel o en Meta.
app.get("/api/marketing/diagnose", requireAuth, async (_req, res) => {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  const mask = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} caracteres)` : null);
  const report = {
    env: {
      waba_id_set: !!wabaId,
      waba_id: wabaId || null,
      token_set: !!token,
      token_preview: mask(token),
      phone_number_id_set: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      graph_version: META_GRAPH_VERSION,
    },
    checks: {},
    ok: false,
    conclusion: "",
  };

  if (!wabaId || !token) {
    report.conclusion = "Faltan WHATSAPP_BUSINESS_ACCOUNT_ID o WHATSAPP_TOKEN en Vercel. Añádelos y haz Redeploy.";
    return res.json(report);
  }

  // 1) ¿El token puede LEER la WABA configurada? (y en qué estado está)
  try {
    const r = await fetch(`${META_GRAPH_BASE}/${wabaId}?fields=name,id,account_review_status,business_verification_status`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    report.checks.leer_waba = r.ok
      ? { ok: true, nombre: d.name || null, review: d.account_review_status || null, verificacion: d.business_verification_status || null }
      : { ok: false, error: d?.error?.message || `HTTP ${r.status}`, code: d?.error?.code };
  } catch (e) { report.checks.leer_waba = { ok: false, error: e.message }; }

  // 2) ¿El token puede LISTAR plantillas de esa WABA? (mismo permiso que crearlas)
  try {
    const r = await fetch(`${META_GRAPH_BASE}/${wabaId}/message_templates?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json().catch(() => ({}));
    report.checks.listar_plantillas = r.ok
      ? { ok: true, total_muestra: (d.data || []).length }
      : { ok: false, error: d?.error?.message || `HTTP ${r.status}`, code: d?.error?.code };
  } catch (e) { report.checks.listar_plantillas = { ok: false, error: e.message }; }

  // 3) Prueba REAL de creación: crea una plantilla de prueba y la borra.
  //    Es la única forma fiable de saber si el permiso de ESCRITURA funciona.
  try {
    const testName = "crm_diagnostico_" + Date.now();
    const payload = {
      name: testName, category: "UTILITY", language: "es_ES",
      components: [{ type: "BODY", text: "Prueba de diagnostico del CRM. Se elimina automaticamente." }],
    };
    const r = await fetch(`${META_GRAPH_BASE}/${wabaId}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      report.checks.crear_plantilla = { ok: true, nota: "Creación permitida (plantilla de prueba eliminada)." };
      // limpiar la plantilla de prueba
      await fetch(`${META_GRAPH_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(testName)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    } else {
      const e = d?.error || {};
      report.checks.crear_plantilla = {
        ok: false,
        error: e.error_user_msg || e.message || `HTTP ${r.status}`,
        code: e.code, subcode: e.error_subcode,
      };
    }
  } catch (e) { report.checks.crear_plantilla = { ok: false, error: e.message }; }

  const cr = report.checks.crear_plantilla;
  report.ok = !!(cr && cr.ok);
  if (cr && cr.ok) {
    report.conclusion = "¡Todo correcto! El CRM puede crear plantillas en Meta. Ya puedes usar 'Crear plantilla'.";
  } else if (!report.checks.leer_waba?.ok || !report.checks.listar_plantillas?.ok) {
    report.conclusion = "El token o la WABA de Vercel no pueden gestionar esa cuenta. Revisa que WHATSAPP_TOKEN y WHATSAPP_BUSINESS_ACCOUNT_ID en Vercel sean exactamente los que funcionan, y haz Redeploy.";
  } else {
    const review = report.checks.leer_waba?.review;
    let extra = "";
    if (review && review !== "APPROVED") {
      extra = ` OJO: la revisión de la cuenta (account_review_status) está en "${review}", no en "APPROVED". Mientras no esté APPROVED, Meta bloquea crear plantillas. Suele aprobarse sola en unas horas; si no, revisa que el número esté verificado y con método de pago activo.`;
    }
    report.conclusion = "El token puede LEER pero NO CREAR plantillas. Prueba, en este orden: (1) regenerar el token del usuario del sistema (con rol Administrador) y actualizarlo en Vercel, (2) app en modo 'En vivo', (3) 'Acceso avanzado' del permiso whatsapp_business_management." + extra;
  }
  return res.json(report);
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
