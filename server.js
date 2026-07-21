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
const { ensurePaymentForAppointment } = require("./lib/billing");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

// Identificadores en WhatsApp para que el paciente distinga quién le escribe:
// el asistente automático o una persona de recepción. Para cambiar el texto edita
// aquí; para no mostrar un prefijo, define la env var correspondiente a "".
const WA_BOT_PREFIX = process.env.WA_BOT_PREFIX ?? "Asistente virtual";
const WA_HUMAN_PREFIX = process.env.WA_HUMAN_PREFIX ?? "👩‍⚕️ Recepción Dental Fortes";
// Antepone el identificador (en negrita) y un salto de línea al cuerpo del mensaje.
function withWaPrefix(prefix, body) {
  return prefix ? `*${prefix}*\n${body}` : String(body);
}
const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_URL}/api/google/calendar/callback`;

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

function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: GOOGLE_REDIRECT_URI,
  };
}

function requireGoogleConfig() {
  const cfg = googleConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    const err = new Error("Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET en las variables de entorno.");
    err.status = 503;
    throw err;
  }
  return cfg;
}

function googleStateSecret() {
  return process.env.GOOGLE_STATE_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD_HASH || "df-google-state-dev";
}

function googleTokenKey() {
  const secret = process.env.GOOGLE_TOKEN_SECRET || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD_HASH || "df-google-token-dev";
  return crypto.createHash("sha256").update(secret).digest();
}

function signGoogleState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", googleStateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyGoogleState(state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) throw new Error("State OAuth no valido.");
  const expected = crypto.createHmac("sha256", googleStateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("State OAuth no valido.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.professional_id || !payload.exp || Date.now() > payload.exp) throw new Error("State OAuth caducado.");
  return payload;
}

function encryptGoogleToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", googleTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptGoogleToken(value) {
  const [version, ivRaw, tagRaw, encryptedRaw] = String(value || "").split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) throw new Error("Token de Google no valido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", googleTokenKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function adminRedirectWithGoogleStatus(status, message, professionalId) {
  const params = new URLSearchParams({ google_calendar: status });
  if (message) params.set("google_calendar_message", message);
  if (professionalId) params.set("professional_id", professionalId);
  return `${PUBLIC_URL}/admin?${params.toString()}#agenda`;
}

async function exchangeGoogleCode(code) {
  const cfg = requireGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || "Google no devolvio tokens.");
  return data;
}

async function refreshGoogleAccessToken(encryptedRefreshToken) {
  const cfg = requireGoogleConfig();
  const refreshToken = decryptGoogleToken(encryptedRefreshToken);
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.error || "No se pudo renovar el acceso a Google.");
  return data.access_token;
}

async function googleCalendarRequest(professional, method, pathPart, body) {
  if (!professional?.google_calendar_refresh_token || !professional.google_calendar_sync_enabled) {
    throw new Error("El profesional no tiene Google Calendar sincronizado.");
  }
  const accessToken = await refreshGoogleAccessToken(professional.google_calendar_refresh_token);
  const r = await fetch(`${GOOGLE_CALENDAR_BASE}${pathPart}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch (_e) { data = { error: text }; }
  }
  if (!r.ok) {
    const err = new Error(data.error?.message || data.error_description || data.error || `Google Calendar error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function getGoogleProfessional(professionalId) {
  if (!professionalId) return null;
  const { data, error } = await supabase
    .from("df_professionals")
    .select("id, name, google_calendar_id, google_calendar_refresh_token, google_calendar_sync_enabled")
    .eq("id", professionalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function deleteGoogleEventForProfessional(professionalId, eventId) {
  if (!professionalId || !eventId) return;
  const professional = await getGoogleProfessional(professionalId);
  if (!professional?.google_calendar_refresh_token) return;
  const calendarId = encodeURIComponent(professional.google_calendar_id || "primary");
  const googleEventId = encodeURIComponent(eventId);
  try {
    await googleCalendarRequest(professional, "DELETE", `/calendars/${calendarId}/events/${googleEventId}`);
  } catch (err) {
    if (![404, 410].includes(err.status)) throw err;
  }
}

function buildGoogleEvent(appointment) {
  const patientName = appointment.df_patients?.full_name || "Paciente";
  const treatmentName = appointment.df_treatments?.name || "Cita";
  const professionalName = appointment.df_professionals?.name || "Dental Fortes";
  const lines = [
    `Paciente: ${patientName}`,
    `Tratamiento: ${treatmentName}`,
    `Profesional CRM: ${professionalName}`,
    "",
    "Evento sincronizado automaticamente desde Dental Fortes CRM.",
  ];
  return {
    summary: `Dental Fortes - ${patientName}`,
    description: lines.join("\n"),
    start: { dateTime: appointment.starts_at, timeZone: "Europe/Madrid" },
    end: { dateTime: appointment.ends_at, timeZone: "Europe/Madrid" },
    reminders: { useDefault: true },
    extendedProperties: { private: { dental_fortes_appointment_id: appointment.id } },
  };
}

async function loadAppointmentForGoogle(id) {
  const { data, error } = await supabase
    .from("df_appointments")
    .select("id, patient_id, professional_id, treatment_id, starts_at, ends_at, status, google_event_id, df_patients(full_name), df_professionals(id, name, google_calendar_id, google_calendar_refresh_token, google_calendar_sync_enabled), df_treatments(name)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function syncAppointmentToGoogle(appointmentId, previous = null) {
  const appointment = await loadAppointmentForGoogle(appointmentId);
  if (!appointment) return { action: "missing" };

  if (previous?.professional_id && previous.professional_id !== appointment.professional_id && previous.google_event_id) {
    await deleteGoogleEventForProfessional(previous.professional_id, previous.google_event_id);
    appointment.google_event_id = null;
    await supabase.from("df_appointments").update({
      google_event_id: null,
      google_synced_at: null,
    }).eq("id", appointment.id);
  }

  const shouldSync = appointment.status === "confirmed" &&
    appointment.professional_id &&
    appointment.df_professionals?.google_calendar_refresh_token &&
    appointment.df_professionals?.google_calendar_sync_enabled;

  if (!shouldSync) {
    const shouldRemoveEvent = ["pending", "cancelled"].includes(appointment.status);
    if (appointment.google_event_id && appointment.professional_id) {
      if (shouldRemoveEvent) {
        await deleteGoogleEventForProfessional(appointment.professional_id, appointment.google_event_id);
        await supabase.from("df_appointments").update({
          google_event_id: null,
          google_synced_at: null,
          google_sync_error: null,
        }).eq("id", appointment.id);
        return { action: "deleted" };
      }
      return { action: "kept" };
    }
    return { action: "skipped" };
  }

  const professional = appointment.df_professionals;
  const calendarId = encodeURIComponent(professional.google_calendar_id || "primary");
  const body = buildGoogleEvent(appointment);
  let googleEvent;

  try {
    if (appointment.google_event_id) {
      googleEvent = await googleCalendarRequest(
        professional,
        "PATCH",
        `/calendars/${calendarId}/events/${encodeURIComponent(appointment.google_event_id)}?sendUpdates=none`,
        body
      );
    } else {
      googleEvent = await googleCalendarRequest(
        professional,
        "POST",
        `/calendars/${calendarId}/events?sendUpdates=none`,
        body
      );
    }
  } catch (err) {
    if (appointment.google_event_id && [404, 410].includes(err.status)) {
      googleEvent = await googleCalendarRequest(
        professional,
        "POST",
        `/calendars/${calendarId}/events?sendUpdates=none`,
        body
      );
    } else {
      await supabase.from("df_appointments").update({ google_sync_error: err.message }).eq("id", appointment.id);
      await supabase.from("df_professionals").update({ google_calendar_sync_error: err.message }).eq("id", professional.id);
      throw err;
    }
  }

  await supabase.from("df_appointments").update({
    google_event_id: googleEvent.id || appointment.google_event_id,
    google_synced_at: new Date().toISOString(),
    google_sync_error: null,
  }).eq("id", appointment.id);
  await supabase.from("df_professionals").update({
    google_calendar_last_sync_at: new Date().toISOString(),
    google_calendar_sync_error: null,
  }).eq("id", professional.id);
  return { action: appointment.google_event_id ? "updated" : "created", google_event_id: googleEvent.id };
}

async function syncProfessionalGoogleCalendar(professionalId) {
  const professional = await getGoogleProfessional(professionalId);
  if (!professional) throw new Error("Profesional no encontrado.");
  if (!professional.google_calendar_refresh_token || !professional.google_calendar_sync_enabled) {
    throw new Error("Este profesional aun no ha vinculado Google Calendar.");
  }
  const from = new Date();
  from.setDate(from.getDate() - 1);
  const { data, error } = await supabase
    .from("df_appointments")
    .select("id")
    .eq("professional_id", professionalId)
    .gte("starts_at", from.toISOString())
    .order("starts_at", { ascending: true })
    .limit(500);
  if (error) throw error;

  const result = { synced: 0, skipped: 0, deleted: 0, errors: [] };
  for (const row of data || []) {
    try {
      const item = await syncAppointmentToGoogle(row.id);
      if (item.action === "created" || item.action === "updated") result.synced++;
      else if (item.action === "deleted") result.deleted++;
      else result.skipped++;
    } catch (err) {
      result.errors.push({ id: row.id, error: err.message });
    }
  }
  await supabase.from("df_professionals").update({
    google_calendar_last_sync_at: new Date().toISOString(),
    google_calendar_sync_error: result.errors[0]?.error || null,
  }).eq("id", professionalId);
  return result;
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

// Facturación del dashboard (con filtros: tratamiento, profesional, edad, periodo).
app.get("/api/dashboard/billing", requireAuth, async (req, res) => {
  try {
    const { from, to, treatment_id, professional_id, age_min, age_max } = req.query;
    const ageMin = age_min ? Number(age_min) : null;
    const ageMax = age_max ? Number(age_max) : null;
    const fromT = from ? Date.parse(from) : null;
    const toT = to ? Date.parse(to) : null;

    const [{ data: appts }, { data: pays }, { data: reviewsData }] = await Promise.all([
      supabase.from("df_appointments")
        .select("id, starts_at, status, treatment_id, professional_id, df_professionals(name), df_treatments(name), df_patients(birth_date)"),
      supabase.from("df_patient_payments")
        .select("amount_eur, paid, paid_at, created_at, appointment_id, df_patients(birth_date)"),
      supabase.from("df_reviews").select("rating, created_at"),
    ]);
    const apptMap = Object.fromEntries((appts || []).map((a) => [a.id, a]));

    const now = new Date();
    const ageOf = (bd) => {
      if (!bd) return null;
      const d = new Date(bd); if (isNaN(d.getTime())) return null;
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
      return age;
    };
    const filterAge = ageMin != null || ageMax != null;
    const ageOk = (age) => (ageMin == null || (age != null && age >= ageMin)) && (ageMax == null || (age != null && age <= ageMax));
    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const monthKey = (s) => { const d = new Date(s); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };

    // Facturación (a partir de los cobros)
    let totalFacturado = 0, totalPendiente = 0, numPagos = 0, numPendientes = 0;
    const byTreatment = {}, byMonth = {}, byProfFacturado = {};
    for (const p of pays || []) {
      const a = p.appointment_id ? apptMap[p.appointment_id] : null;
      const tId = a ? a.treatment_id : null;
      const pId = a ? a.professional_id : null;
      const tName = (a && a.df_treatments && a.df_treatments.name) || "Otros";
      const pName = (a && a.df_professionals && a.df_professionals.name) || "Sin profesional";
      const bd = (a && a.df_patients && a.df_patients.birth_date) || (p.df_patients && p.df_patients.birth_date) || null;
      if (treatment_id && tId !== treatment_id) continue;
      if (professional_id && pId !== professional_id) continue;
      if (filterAge && !ageOk(ageOf(bd))) continue;
      const refDate = p.paid ? (p.paid_at || p.created_at) : ((a && a.starts_at) || p.created_at);
      const rt = Date.parse(refDate);
      if (fromT && rt < fromT) continue;
      if (toT && rt > toT) continue;
      const amt = Number(p.amount_eur) || 0;
      if (p.paid) {
        totalFacturado += amt; numPagos++;
        byTreatment[tName] = (byTreatment[tName] || 0) + amt;
        const mk = monthKey(p.paid_at || p.created_at);
        byMonth[mk] = (byMonth[mk] || 0) + amt;
        byProfFacturado[pName] = (byProfFacturado[pName] || 0) + amt;
      } else {
        totalPendiente += amt; numPendientes++;
      }
    }

    // Citas por profesional (para las métricas por profesional).
    // Se cuenta cada cita UNA sola vez (dedupe defensivo por id).
    const byProfCitas = {};
    const byProfOutcome = {};   // { prof: { done, noShow } } para el % de citas atendidas
    const byTreatmentCitas = {}; // { tratamiento: nº de citas } para las métricas por tratamiento
    const vistas = new Set();
    for (const a of appts || []) {
      if (!a || vistas.has(a.id)) continue;
      vistas.add(a.id);
      if (a.status === "cancelled") continue;
      const pName = (a.df_professionals && a.df_professionals.name) || "Sin profesional";
      const tName = (a.df_treatments && a.df_treatments.name) || "Otros";
      if (treatment_id && a.treatment_id !== treatment_id) continue;
      if (professional_id && a.professional_id !== professional_id) continue;
      if (filterAge && !ageOk(ageOf(a.df_patients && a.df_patients.birth_date))) continue;
      const rt = Date.parse(a.starts_at);
      if (fromT && rt < fromT) continue;
      if (toT && rt > toT) continue;
      byProfCitas[pName] = (byProfCitas[pName] || 0) + 1;
      byTreatmentCitas[tName] = (byTreatmentCitas[tName] || 0) + 1;
      const oc = byProfOutcome[pName] || (byProfOutcome[pName] = { done: 0, noShow: 0 });
      if (a.status === "done") oc.done++;
      else if (a.status === "no_show") oc.noShow++;
    }

    // Meses a mostrar: uno por mes NATURAL dentro del rango pedido, así el nº de barras
    // coincide con el periodo (3 meses => 3 barras) sin meses de relleno de más. Para "Todo"
    // (sin fecha desde) se arranca en el primer mes con datos.
    const firstDataKey = Object.keys(byMonth).sort()[0];
    const startBase = fromT
      ? new Date(fromT)
      : (firstDataKey ? new Date(firstDataKey + "-01T00:00:00") : new Date(now.getFullYear(), now.getMonth(), 1));
    const endBase = toT ? new Date(toT) : now;
    let cursor = new Date(startBase.getFullYear(), startBase.getMonth(), 1);
    const endMonth = new Date(endBase.getFullYear(), endBase.getMonth(), 1);
    const meses = [];
    let guardM = 0;
    while (cursor <= endMonth && guardM < 120) {
      meses.push({ key: cursor.getFullYear() + "-" + String(cursor.getMonth() + 1).padStart(2, "0"), y: cursor.getFullYear() });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      guardM++;
    }
    if (!meses.length) meses.push({ key: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"), y: now.getFullYear() });
    // Si el rango cruza varios años, añadimos el año a la etiqueta para no confundir meses.
    const multiYear = meses[0].y !== meses[meses.length - 1].y;
    const byMonthArr = meses.map((m) => {
      const d = new Date(m.key + "-01T00:00:00");
      let label = d.toLocaleDateString("es-ES", { month: "short" });
      if (multiYear) label += " " + String(m.y).slice(-2);
      return { month: m.key, label, amount: round2(byMonth[m.key] || 0) };
    });

    // Valoración media de cliente: media de TODAS las reseñas del periodo (a nivel de clínica;
    // las reseñas no van asociadas a un profesional concreto). Se muestra en estadísticas.
    let ratingSum = 0, ratingCount = 0;
    for (const rv of reviewsData || []) {
      const rt = Date.parse(rv.created_at);
      if (fromT && rt < fromT) continue;
      if (toT && rt > toT) continue;
      const val = Number(rv.rating);
      if (!isFinite(val)) continue;
      ratingSum += val; ratingCount++;
    }
    const review = { avg: ratingCount ? round2(ratingSum / ratingCount) : null, count: ratingCount };
    const byTreatmentArr = Object.entries(byTreatment).map(([name, amount]) => ({ name, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
    const profNames = new Set([...Object.keys(byProfCitas), ...Object.keys(byProfFacturado)]);
    const byProfessional = [...profNames]
      .map((name) => {
        const oc = byProfOutcome[name] || { done: 0, noShow: 0 };
        return {
          name,
          citas: byProfCitas[name] || 0,
          facturado: round2(byProfFacturado[name] || 0),
          atendidas: oc.done,
          no_asistidas: oc.noShow,
        };
      })
      .sort((a, b) => b.facturado - a.facturado || b.citas - a.citas);

    // Citas por tratamiento (conteo) para el gráfico de sectores y el de barras.
    const byTreatmentCitasArr = Object.entries(byTreatmentCitas)
      .map(([name, citas]) => ({ name, citas }))
      .sort((a, b) => b.citas - a.citas);

    return res.json({
      totalFacturado: round2(totalFacturado),
      totalPendiente: round2(totalPendiente),
      numPagos, numPendientes,
      byTreatment: byTreatmentArr,
      byTreatmentCitas: byTreatmentCitasArr,
      byMonth: byMonthArr,
      byProfessional,
      review,
    });
  } catch (err) {
    console.error("[billing]", err);
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// NOTIFICACIONES — eventos recientes del CRM (para el panel de la campana)
// =============================================================
app.get("/api/notifications", requireAuth, async (_req, res) => {
  try {
    const LIM = 20;
    const [appts, reviews, msgs] = await Promise.all([
      supabase.from("df_appointments")
        .select("id, created_at, confirmed_at, reminder_3d_at, reminder_1d_at, reminder_6h_at, starts_at, status, source, df_patients(full_name), df_treatments(name)")
        .order("created_at", { ascending: false }).limit(60),
      supabase.from("df_reviews")
        .select("id, created_at, rating, comment, routed_to").order("created_at", { ascending: false }).limit(LIM),
      supabase.from("df_messages")
        .select("id, created_at, content, df_conversations(customer_name, channel)")
        .eq("role", "user").order("created_at", { ascending: false }).limit(LIM),
    ]);
    const events = [];
    const fmtWhen = (s) => { try { return new Date(s).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }); } catch (_e) { return ""; } };
    const REM = { reminder_3d_at: "3 días", reminder_1d_at: "1 día", reminder_6h_at: "6 horas" };

    for (const a of appts.data || []) {
      const paciente = a.df_patients?.full_name || "Paciente";
      const trat = a.df_treatments?.name || "cita";
      if (a.created_at) {
        events.push({ id: `appt:${a.id}`, type: "cita", at: a.created_at,
          text: `Nueva cita — ${paciente} · ${trat} · ${fmtWhen(a.starts_at)}` });
      }
      if (a.confirmed_at) {
        events.push({ id: `conf:${a.id}`, type: "confirmada", at: a.confirmed_at,
          text: `Cita confirmada — ${paciente} · ${fmtWhen(a.starts_at)}` });
      }
      for (const f of Object.keys(REM)) {
        if (a[f]) events.push({ id: `rem:${a.id}:${f}`, type: "recordatorio", at: a[f],
          text: `Recordatorio (${REM[f]}) enviado — ${paciente}` });
      }
    }
    for (const r of reviews.data || []) {
      const stars = r.rating != null ? `${r.rating}★` : "";
      events.push({ id: `rev:${r.id}`, type: "resena", at: r.created_at,
        text: `Nueva reseña ${stars}${r.comment ? " — " + String(r.comment).slice(0, 60) : ""}`.trim() });
    }
    for (const m of msgs.data || []) {
      const quien = m.df_conversations?.customer_name || "Cliente";
      events.push({ id: `msg:${m.id}`, type: "mensaje", at: m.created_at,
        text: `Mensaje de ${quien} — ${String(m.content || "").slice(0, 60)}` });
    }

    events.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    return res.json({ notifications: events.slice(0, 40) });
  } catch (err) {
    console.error("[notifications]", err);
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

    // Cobro automático: si el tratamiento tiene precio, genera un cobro pendiente.
    await ensurePaymentForAppointment(supabase, {
      appointmentId: data.id, patientId: data.patient_id,
      treatmentId: data.treatment_id, startsAt: data.starts_at,
    }).catch((e) => console.error("[appointments/pago]", e.message));
    if (data.status === "confirmed") {
      await syncAppointmentToGoogle(data.id).catch((e) => console.error("[google-calendar/create]", e.message));
    }

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
    const { data: before, error: beforeError } = await supabase
      .from("df_appointments")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return res.status(404).json({ error: "Cita no encontrada." });

    // Revalida capacidad SOLO si el tramo/profesional/tipo/gabinete cambia de verdad
    // (el panel reenvía esos campos aunque no los toques; comparándolos con el valor
    // actual evitamos 409 espurios al editar solo notas/estado, p. ej. al confirmar).
    const touchesScheduleKeys = ["starts_at","ends_at","professional_id","is_first_visit","cabinet"].some((k) => k in patch);
    if (touchesScheduleKeys && !body.force) {
      const cur = before;
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
    await syncAppointmentToGoogle(data.id, before).catch((e) => console.error("[google-calendar/update]", e.message));
    return res.json({ appointment: data });
  } catch (err) {
    console.error("[appointments/update]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/appointments/:id", requireAuth, async (req, res) => {
  try {
    const { data: before } = await supabase
      .from("df_appointments")
      .select("id, professional_id, google_event_id")
      .eq("id", req.params.id)
      .maybeSingle();
    const { error } = await supabase.from("df_appointments").delete().eq("id", req.params.id);
    if (error) throw error;
    if (before?.google_event_id) {
      await deleteGoogleEventForProfessional(before.professional_id, before.google_event_id)
        .catch((e) => console.error("[google-calendar/delete]", e.message));
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Marcar una cita como PAGADA: registra (o actualiza) el cobro del tratamiento de esa
// cita con el importe confirmado. Aparece en Facturación y en la ficha del paciente.
app.post("/api/appointments/:id/pay", requireAuth, async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from("df_appointments")
      .select("id, patient_id, treatment_id, df_treatments(name)")
      .eq("id", req.params.id).maybeSingle();
    if (!appt) return res.status(404).json({ error: "Cita no encontrada." });
    if (!appt.patient_id) return res.status(400).json({ error: "La cita no tiene paciente asociado." });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: "Importe no válido." });
    const concept = appt.df_treatments?.name || "Cita";
    const nowISO = new Date().toISOString();
    // Si ya había un cobro para esta cita, se actualiza; si no, se crea (pagado).
    const { data: existing } = await supabase
      .from("df_patient_payments").select("id").eq("appointment_id", appt.id).limit(1).maybeSingle();
    let payment;
    if (existing) {
      const { data, error } = await supabase.from("df_patient_payments")
        .update({ amount_eur: amount, paid: true, paid_at: nowISO, concept })
        .eq("id", existing.id).select().single();
      if (error) throw error;
      payment = data;
    } else {
      const { data, error } = await supabase.from("df_patient_payments")
        .insert({ patient_id: appt.patient_id, appointment_id: appt.id, amount_eur: amount, paid: true, paid_at: nowISO, concept })
        .select().single();
      if (error) throw error;
      payment = data;
    }
    return res.json({ payment });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Facturación de un día: cobros PAGADOS ese día (paciente, tratamiento, importe) + total.
app.get("/api/billing", requireAuth, async (req, res) => {
  try {
    const dateStr = String(req.query.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const dayStart = new Date(dateStr + "T00:00:00.000Z").getTime();
    const dayEnd = dayStart + 86400000;
    const { data: pays } = await supabase
      .from("df_patient_payments")
      .select("id, amount_eur, paid, paid_at, concept, patient_id, df_patients(full_name)")
      .eq("paid", true)
      .order("paid_at", { ascending: false });
    const rows = (pays || []).filter((p) => {
      const t = Date.parse(p.paid_at || "");
      return isFinite(t) && t >= dayStart && t < dayEnd;
    }).map((p) => ({
      id: p.id,
      patient: p.df_patients?.full_name || "—",
      treatment: p.concept || "—",
      amount: Number(p.amount_eur) || 0,
      paid_at: p.paid_at,
    }));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    return res.json({ date: dateStr, total: Math.round((total + Number.EPSILON) * 100) / 100, count: rows.length, rows });
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
// =============================================================
// GOOGLE CALENDAR - OAuth por profesional
// =============================================================
app.post("/api/professionals/:id/google/connect-url", requireAuth, async (req, res) => {
  try {
    const cfg = requireGoogleConfig();
    const { data: professional, error } = await supabase
      .from("df_professionals")
      .select("id, name")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!professional) return res.status(404).json({ error: "Profesional no encontrado." });

    const state = signGoogleState({
      professional_id: professional.id,
      iat: Date.now(),
      exp: Date.now() + 10 * 60 * 1000,
      nonce: crypto.randomBytes(12).toString("base64url"),
    });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return res.json({ url: `${GOOGLE_OAUTH_URL}?${params.toString()}` });
  } catch (err) {
    console.error("[google-calendar/connect-url]", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/google/calendar/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(302, adminRedirectWithGoogleStatus("error", String(req.query.error_description || req.query.error)));
    }
    const code = String(req.query.code || "");
    if (!code) throw new Error("Google no ha devuelto codigo OAuth.");
    const state = verifyGoogleState(req.query.state);
    const tokens = await exchangeGoogleCode(code);
    if (!tokens.refresh_token) {
      throw new Error("Google no ha devuelto refresh_token. Vuelve a conectar y acepta de nuevo los permisos.");
    }
    const { error } = await supabase
      .from("df_professionals")
      .update({
        google_calendar_id: "primary",
        google_calendar_refresh_token: encryptGoogleToken(tokens.refresh_token),
        google_calendar_sync_enabled: true,
        google_calendar_connected_at: new Date().toISOString(),
        google_calendar_sync_error: null,
      })
      .eq("id", state.professional_id);
    if (error) throw error;
    await syncProfessionalGoogleCalendar(state.professional_id).catch((e) => console.error("[google-calendar/initial-sync]", e.message));
    return res.redirect(302, adminRedirectWithGoogleStatus("connected", "", state.professional_id));
  } catch (err) {
    console.error("[google-calendar/callback]", err);
    return res.redirect(302, adminRedirectWithGoogleStatus("error", err.message));
  }
});

app.post("/api/professionals/:id/google/sync", requireAuth, async (req, res) => {
  try {
    const result = await syncProfessionalGoogleCalendar(req.params.id);
    return res.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    console.error("[google-calendar/sync]", err);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/professionals/:id/google/disconnect", requireAuth, async (req, res) => {
  try {
    const { data: appointments } = await supabase
      .from("df_appointments")
      .select("id, google_event_id")
      .eq("professional_id", req.params.id)
      .not("google_event_id", "is", null);
    for (const appt of appointments || []) {
      await deleteGoogleEventForProfessional(req.params.id, appt.google_event_id).catch(() => {});
    }
    await supabase.from("df_appointments").update({
      google_event_id: null,
      google_synced_at: null,
      google_sync_error: null,
    }).eq("professional_id", req.params.id);
    const { error } = await supabase.from("df_professionals").update({
      google_calendar_refresh_token: null,
      google_calendar_sync_enabled: false,
      google_calendar_connected_at: null,
      google_calendar_last_sync_at: null,
      google_calendar_sync_error: null,
    }).eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("[google-calendar/disconnect]", err);
    return res.status(500).json({ error: err.message });
  }
});

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
    const { error: updateError } = await supabase.from("df_appointments")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() }).eq("id", id);
    if (updateError) throw updateError;
    await syncAppointmentToGoogle(id).catch((e) => console.error("[google-calendar/confirm]", e.message));
    return res.status(200).send(confirmPage("¡Gracias! Su cita ha quedado confirmada."));
  } catch (err) {
    console.error("[confirm]", err);
    return res.status(500).send(confirmPage("No se ha podido confirmar ahora mismo. Inténtelo más tarde."));
  }
});

// Cadencia de recordatorios CONFIGURABLE (horas antes de la cita). Los 3 tramos
// se guardan siempre en estas 3 columnas, en orden descendente (más lejano primero).
const REMINDER_FIELDS = ["reminder_3d_at", "reminder_1d_at", "reminder_6h_at"];
const DEFAULT_REMINDER_OFFSETS = [72, 24, 6]; // 3 días, 1 día, 6 horas

function fmtOffset(h) {
  h = Number(h) || 0;
  if (h >= 24 && h % 24 === 0) { const d = h / 24; return `${d} día${d === 1 ? "" : "s"}`; }
  return `${h} h`;
}

async function getReminderConfig() {
  try {
    const { data } = await supabase.from("df_settings").select("value").eq("key", "reminder_cadence").maybeSingle();
    const val = (data && data.value) || {};
    const template = typeof val.template === "string" ? val.template : "";
    let offs = val.offsets;
    if (Array.isArray(offs) && offs.length === 3 && offs.every((n) => Number(n) > 0)) {
      return { offsets: offs.map(Number).sort((a, b) => b - a), template };
    }
    return { offsets: DEFAULT_REMINDER_OFFSETS.slice(), template };
  } catch (_e) {}
  return { offsets: DEFAULT_REMINDER_OFFSETS.slice(), template: "" };
}

// Tramos [{field, fromH, toH, label}] a partir de los offsets (horas antes de la cita).
function buildReminderSteps(offsets) {
  return offsets.map((h, i) => ({
    field: REMINDER_FIELDS[i],
    fromH: offsets[i + 1] || 0,
    toH: h,
    label: fmtOffset(h),
  }));
}

function reminderText(appt, _label) {
  const cuando = new Date(appt.starts_at).toLocaleString("es-ES", {
    weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
  });
  const nombre = appt.df_patients?.full_name ? " " + String(appt.df_patients.full_name).split(" ")[0] : "";
  return `Hola${nombre}, le recordamos su cita en Dental Fortes el ${cuando}. ` +
    `Por favor, confírmela para mantenerla: ${confirmLink(appt.id)} ` +
    `Si no se confirma, el hueco podría liberarse. Gracias.`;
}

// Envía el recordatorio de una cita: por PLANTILLA de Meta si hay una configurada (rellena
// {{1}}=nombre, {{2}}=cuándo según cuántas variables tenga), o por texto normal si no.
async function sendReminderMessage(wa, phone, appt, templateName, tplInfo) {
  if (templateName && tplInfo) {
    const nombre = appt.df_patients?.full_name ? String(appt.df_patients.full_name).split(" ")[0] : "paciente";
    const cuando = new Date(appt.starts_at).toLocaleString("es-ES", {
      weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
    });
    const params = [nombre, cuando].slice(0, tplInfo.bodyVarCount);
    return wa.sendTemplate(phone, templateName, tplInfo.language, params);
  }
  return wa.sendText(phone, reminderText(appt));
}

async function runReminders() {
  const wa = require("./lib/whatsapp");
  const now = Date.now();
  const iso = (h) => new Date(now + h * 3600000).toISOString();
  const result = { sent: 0, cancelled: 0, processed: 0, errors: [], autoCancelEnabled: AUTO_CANCEL_ENABLED };

  const { offsets, template } = await getReminderConfig();
  const steps = buildReminderSteps(offsets);
  // Si hay una plantilla de Meta configurada, cargamos sus datos UNA vez (idioma y nº de
  // variables) para enviar los recordatorios como plantilla (necesario fuera de la ventana
  // de 24h). Si falla o no hay plantilla, se cae al texto normal.
  let remTpl = null;
  if (template && wa.isConfigured()) { try { remTpl = await fetchApprovedTemplate(template); } catch (_e) { remTpl = null; } }

  // 1) Recordatorios por cada tramo de la cadencia.
  for (const step of steps) {
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
          await sendReminderMessage(wa, phone, a, template, remTpl);
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

// Lista de próximas citas + estado de recordatorios (para el apartado Recordatorios).
app.get("/api/reminders", requireAuth, async (_req, res) => {
  try {
    const cfg = await getReminderConfig();
    const { data, error } = await supabase
      .from("df_appointments")
      .select("id, starts_at, status, confirmed_at, reminder_3d_at, reminder_1d_at, reminder_6h_at, auto_cancelled, df_patients(full_name, phone), df_professionals(name), df_treatments(name)")
      .in("status", ["pending", "confirmed"])
      .gte("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(300);
    if (error) throw error;
    return res.json({ config: cfg, appointments: data || [] });
  } catch (err) {
    console.error("[reminders/list]", err);
    return res.status(500).json({ error: err.message });
  }
});

// Config de la cadencia (offsets en horas).
app.get("/api/reminders/config", requireAuth, async (_req, res) => {
  return res.json(await getReminderConfig());
});
app.put("/api/reminders/config", requireAuth, async (req, res) => {
  try {
    let offsets = (req.body && req.body.offsets) || [];
    offsets = offsets.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (offsets.length !== 3) return res.status(400).json({ error: "Indica 3 valores (en horas) mayores que 0." });
    offsets.sort((a, b) => b - a);
    const template = typeof req.body.template === "string" ? req.body.template.trim() : "";
    const { error } = await supabase.from("df_settings")
      .upsert({ key: "reminder_cadence", value: { offsets, template }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
    return res.json({ offsets, template });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Envío MANUAL de recordatorio a una cita (el bot manda el mensaje por WhatsApp).
app.post("/api/appointments/:id/send-reminder", requireAuth, async (req, res) => {
  try {
    const wa = require("./lib/whatsapp");
    const { data: a } = await supabase
      .from("df_appointments")
      .select("id, starts_at, status, df_patients(full_name, phone)")
      .eq("id", req.params.id).maybeSingle();
    if (!a) return res.status(404).json({ error: "Cita no encontrada." });
    const phone = a.df_patients && a.df_patients.phone;
    if (!phone) return res.status(400).json({ error: "El paciente no tiene teléfono en su ficha." });
    if (!wa.isConfigured()) return res.status(400).json({ error: "WhatsApp no está configurado (falta token o número de teléfono)." });
    try {
      await wa.sendText(phone, reminderText(a));
    } catch (e) {
      return res.status(502).json({ error: "No se pudo enviar por WhatsApp: " + e.message });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// URGENCIAS PENDIENTES (las registra el bot; recepción las gestiona)
// =============================================================
app.get("/api/urgencies", requireAuth, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const { data, error } = await supabase
      .from("df_urgencies")
      .select("*, df_patients(id, full_name, phone)")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ urgencies: data || [] });
  } catch (err) {
    console.error("[urgencies/list]", err);
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/urgencies/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["status", "appointment_id", "summary", "customer_name", "customer_phone", "patient_id"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from("df_urgencies").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    return res.json({ urgency: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PACIENTES
// =============================================================
app.get("/api/patients", requireAuth, async (req, res) => {
  try {
    const { q, state, tag, treatment_id, limit } = req.query;
    let query = supabase
      .from("df_patients")
      .select("id, full_name, phone, email, birth_date, language, patient_state, tags, marketing_consent, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(Math.min(500, Number(limit) || 200));
    if (state) query = query.eq("patient_state", state);
    if (tag) query = query.contains("tags", [tag]);
    // Filtro por tratamiento: solo los pacientes etiquetados con ese tratamiento.
    if (treatment_id) {
      const { data: links } = await supabase
        .from("df_patient_treatments").select("patient_id").eq("treatment_id", treatment_id);
      const ids = (links || []).map((l) => l.patient_id);
      if (!ids.length) return res.json({ patients: [] });
      query = query.in("id", ids);
    }
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
    const [{ data: pending }, { data: history }, { data: payments }, { data: appointments }, { data: trLinks }] = await Promise.all([
      supabase.from("df_patient_pending").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_patient_history").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_patient_payments").select("*").eq("patient_id", req.params.id).order("created_at", { ascending: false }),
      supabase.from("df_appointments")
        .select("*, df_professionals(name, specialty), df_treatments(name)")
        .eq("patient_id", req.params.id).order("starts_at", { ascending: false }).limit(50),
      supabase.from("df_patient_treatments").select("treatment_id, df_treatments(id, name)").eq("patient_id", req.params.id),
    ]);
    const treatments = (trLinks || []).map((l) => ({ id: l.treatment_id, name: l.df_treatments?.name || "—" }));
    return res.json({ patient, pending: pending || [], history: history || [], payments: payments || [], appointments: appointments || [], treatments });
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
    const { note, appointment_id, treatment_id } = req.body || {};
    const cleanNote = String(note || "").trim();
    // El apunte de historial puede llevar una nota, un tratamiento (etiqueta para
    // segmentar campañas) o ambos. Al menos uno de los dos.
    if (!cleanNote && !treatment_id) return res.status(400).json({ error: "Añade una nota o un tratamiento." });
    let history = null;
    if (cleanNote) {
      const { data, error } = await supabase
        .from("df_patient_history")
        .insert({ patient_id: req.params.id, note: cleanNote, appointment_id: appointment_id || null })
        .select().single();
      if (error) throw error;
      history = data;
    }
    // Si se indica tratamiento, se etiqueta al paciente (sin duplicar).
    if (treatment_id) {
      await supabase
        .from("df_patient_treatments")
        .upsert({ patient_id: req.params.id, treatment_id }, { onConflict: "patient_id,treatment_id", ignoreDuplicates: true });
    }
    return res.json({ history });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Etiquetas de tratamiento por paciente (grupos para segmentar campañas) ---
app.post("/api/patients/:id/treatments", requireAuth, async (req, res) => {
  try {
    const treatment_id = req.body?.treatment_id;
    if (!treatment_id) return res.status(400).json({ error: "Falta el tratamiento." });
    const { error } = await supabase
      .from("df_patient_treatments")
      .upsert({ patient_id: req.params.id, treatment_id }, { onConflict: "patient_id,treatment_id", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/patients/:id/treatments/:treatmentId", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("df_patient_treatments")
      .delete().eq("patient_id", req.params.id).eq("treatment_id", req.params.treatmentId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Grupos por tratamiento (etiquetado masivo desde Configuración de Pacientes) ---
// Lista los pacientes de un grupo (los etiquetados con ese tratamiento).
app.get("/api/treatments/:id/patients", requireAuth, async (req, res) => {
  try {
    const { data: links } = await supabase
      .from("df_patient_treatments").select("patient_id").eq("treatment_id", req.params.id);
    const ids = (links || []).map((l) => l.patient_id);
    if (!ids.length) return res.json({ patients: [] });
    const { data: patients } = await supabase
      .from("df_patients").select("id, full_name, phone, email").in("id", ids).order("full_name");
    return res.json({ patients: patients || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Añade pacientes a un grupo (individual o masivo).
app.post("/api/treatments/:id/patients", requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.patient_ids) ? req.body.patient_ids : [];
    if (!ids.length) return res.status(400).json({ error: "No hay pacientes que añadir." });
    const rows = ids.map((pid) => ({ patient_id: pid, treatment_id: req.params.id }));
    const { error } = await supabase
      .from("df_patient_treatments").upsert(rows, { onConflict: "patient_id,treatment_id", ignoreDuplicates: true });
    if (error) throw error;
    return res.json({ ok: true, added: ids.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/treatments/:id/patients/:patientId", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("df_patient_treatments")
      .delete().eq("treatment_id", req.params.id).eq("patient_id", req.params.patientId);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PRESUPUESTOS (primera visita) — aceptado / pendiente de aceptación
// =============================================================
app.get("/api/budgets", requireAuth, async (_req, res) => {
  try {
    // Pacientes con al menos una PRIMERA VISITA (ahí se ofrece el presupuesto).
    const { data: firstVisits } = await supabase
      .from("df_appointments")
      .select("patient_id, starts_at, df_patients(id, full_name, phone), df_treatments(name)")
      .eq("is_first_visit", true)
      .neq("status", "cancelled")
      .not("patient_id", "is", null)
      .order("starts_at", { ascending: false });
    // Un registro por paciente (su primera visita más reciente).
    const byPatient = {};
    for (const a of firstVisits || []) {
      if (!a.patient_id || byPatient[a.patient_id]) continue;
      byPatient[a.patient_id] = {
        patient_id: a.patient_id,
        full_name: a.df_patients?.full_name || "—",
        phone: a.df_patients?.phone || null,
        first_visit_at: a.starts_at,
        treatment: a.df_treatments?.name || null,
      };
    }
    const { data: budgets } = await supabase.from("df_patient_budgets").select("patient_id, status");
    const statusById = Object.fromEntries((budgets || []).map((b) => [b.patient_id, b.status]));
    const list = Object.values(byPatient).map((p) => ({ ...p, status: statusById[p.patient_id] || "pendiente" }));
    return res.json({ budgets: list });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/budgets/:patientId", requireAuth, async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim();
    if (!["pendiente", "aceptado"].includes(status)) return res.status(400).json({ error: "Estado no válido." });
    const { error } = await supabase
      .from("df_patient_budgets")
      .upsert({ patient_id: req.params.patientId, status, updated_at: new Date().toISOString() }, { onConflict: "patient_id" });
    if (error) throw error;
    return res.json({ ok: true });
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

// Editar un cobro: marcar pagado/pendiente, cambiar importe, concepto o notas.
app.patch("/api/patients/:id/payments/:pid", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if ("amount_eur" in body) patch.amount_eur = Number(body.amount_eur) || 0;
    if ("concept" in body) patch.concept = body.concept || null;
    if ("notes" in body) patch.notes = body.notes || null;
    if ("paid" in body) {
      patch.paid = !!body.paid;
      patch.paid_at = patch.paid ? new Date().toISOString() : null;
    }
    const { data, error } = await supabase
      .from("df_patient_payments").update(patch).eq("id", req.params.pid).select().single();
    if (error) throw error;
    return res.json({ payment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PROFESIONALES
// =============================================================
// Reemplaza los rangos de vacaciones de un profesional por los recibidos.
async function saveProfessionalVacations(professionalId, vacations) {
  if (!Array.isArray(vacations)) return;
  await supabase.from("df_professional_time_off").delete().eq("professional_id", professionalId);
  const rows = vacations
    .filter((v) => v && v.start_date && v.end_date)
    .map((v) => ({
      professional_id: professionalId,
      start_date: String(v.start_date).slice(0, 10),
      end_date: String(v.end_date).slice(0, 10),
      note: v.note || null,
    }));
  if (rows.length) await supabase.from("df_professional_time_off").insert(rows);
}

app.get("/api/professionals", requireAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("df_professionals")
      .select("id, name, specialty, color, active, is_generalist, notes, created_at, updated_at, google_calendar_id, google_calendar_email, google_calendar_sync_enabled, google_calendar_connected_at, google_calendar_last_sync_at, google_calendar_sync_error, df_professional_schedules(*), df_professional_time_off(*)")
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
    await saveProfessionalVacations(pro.id, req.body.vacations);
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
    if (Array.isArray(req.body.vacations)) await saveProfessionalVacations(req.params.id, req.body.vacations);
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
      .from("df_treatments").select("*, df_treatment_professionals(professional_id)").order("name", { ascending: true });
    if (error) throw error;
    // Aplana los profesionales vinculados a cada tratamiento en un array de IDs.
    const treatments = (data || []).map((t) => {
      const professional_ids = (t.df_treatment_professionals || []).map((x) => x.professional_id);
      const { df_treatment_professionals, ...rest } = t;
      return { ...rest, professional_ids };
    });
    return res.json({ treatments });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Sincroniza la lista de profesionales que cubren un tratamiento (borra y reinserta).
async function syncTreatmentProfessionals(treatmentId, ids) {
  if (!Array.isArray(ids)) return;
  await supabase.from("df_treatment_professionals").delete().eq("treatment_id", treatmentId);
  const rows = [...new Set(ids.filter(Boolean))].map((pid) => ({ treatment_id: treatmentId, professional_id: pid }));
  if (rows.length) await supabase.from("df_treatment_professionals").insert(rows);
}

app.post("/api/treatments", requireAuth, async (req, res) => {
  try {
    const { name, duration_minutes, description, is_first_visit, price_eur } = req.body || {};
    if (!name) return res.status(400).json({ error: "Falta nombre." });
    const { data, error } = await supabase
      .from("df_treatments").insert({
        name,
        duration_minutes: Number(duration_minutes) || 30,
        description: description || null,
        is_first_visit: !!is_first_visit,
        price_eur: price_eur === "" || price_eur == null ? null : Number(price_eur),
      }).select().single();
    if (error) throw error;
    if (Array.isArray(req.body?.professional_ids)) await syncTreatmentProfessionals(data.id, req.body.professional_ids);
    return res.json({ treatment: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/treatments/:id", requireAuth, async (req, res) => {
  try {
    const allowed = ["name","duration_minutes","description","active","is_first_visit","price_eur"];
    const patch = {};
    for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
    if ("price_eur" in patch) patch.price_eur = patch.price_eur === "" || patch.price_eur == null ? null : Number(patch.price_eur);
    let data = null;
    if (Object.keys(patch).length) {
      const r = await supabase.from("df_treatments").update(patch).eq("id", req.params.id).select().single();
      if (r.error) throw r.error;
      data = r.data;
    }
    // Profesionales que cubren el tratamiento (no es columna de df_treatments).
    if (Array.isArray(req.body?.professional_ids)) await syncTreatmentProfessionals(req.params.id, req.body.professional_ids);
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

    // Si la conversación es de WhatsApp, hay que ENTREGAR el mensaje por la Cloud API,
    // no solo guardarlo (si solo se guarda, el paciente nunca lo recibe en su chat).
    const { data: conv } = await supabase.from("df_conversations")
      .select("channel, customer_phone").eq("id", req.params.id).maybeSingle();

    if (conv?.channel === "whatsapp") {
      if (!conv.customer_phone) {
        return res.status(400).json({ error: "La conversación no tiene teléfono para enviar por WhatsApp." });
      }
      const wa = require("./lib/whatsapp");
      if (!wa.isConfigured()) {
        return res.status(503).json({ error: "WhatsApp no está configurado en el servidor (falta token o phone number id)." });
      }
      try {
        // Identifica que responde una persona de recepción (no el bot).
        await wa.sendText(conv.customer_phone, withWaPrefix(WA_HUMAN_PREFIX, content));
      } catch (e) {
        // Lo más habitual: fuera de la ventana de 24 h de WhatsApp, o token caducado.
        return res.status(502).json({ error: "No se pudo entregar por WhatsApp: " + e.message });
      }
    }

    // Guardamos el texto limpio (sin prefijo); en el CRM el rol ya distingue quién habló.
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
    const allowed = ["status","internal_resolution","reviewed"];
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
      manual_patient_ids: Array.isArray(b.manual_patient_ids) ? b.manual_patient_ids : (baseConfig.manual_patient_ids || []),
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

// Resuelve los pacientes que caen en un segmento de campaña (union/OR entre los segmentos
// con criterio automático: edad, tratamiento, inactivos, presupuestos). Devuelve la lista
// de pacientes coincidentes con sus datos. Lo usan la previsualización y el envío, para que
// el "N seleccionados" y a quién se envía sean SIEMPRE lo mismo.
async function matchCampaignPatients({ segments = [], treatments = [], ageRanges = [], manualPatientIds = [] }) {
  const wantEdad = segments.includes("por_edad");
  const wantTrat = segments.includes("por_tratamiento");
  const wantInact = segments.includes("inactivos");
  const wantPresu = segments.includes("presupuestos_no_aceptados");
  const manualIds = (manualPatientIds || []).map((x) => String(x)).filter(Boolean);
  const manualSet = new Set(manualIds);
  const hasManual = manualSet.size > 0;
  // Si no hay ningún criterio (ni segmento automático ni pacientes elegidos a mano), no se
  // puede contar/enviar automáticamente.
  if (!(wantEdad || wantTrat || wantInact || wantPresu || hasManual)) return null;

  const { data: patients } = await supabase
    .from("df_patients").select("id, full_name, birth_date, phone, marketing_consent");
  const now = new Date();
  const ageOf = (bd) => {
    if (!bd) return null;
    const d = new Date(bd); if (isNaN(d.getTime())) return null;
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
  };
  const apptsByPatient = {};
  if (wantTrat || wantInact) {
    const { data: appts } = await supabase
      .from("df_appointments").select("patient_id, treatment_id, starts_at").neq("status", "cancelled");
    for (const a of appts || []) {
      if (!a.patient_id) continue;
      (apptsByPatient[a.patient_id] = apptsByPatient[a.patient_id] || []).push(a);
    }
  }
  // Etiquetas de tratamiento asignadas a mano (df_patient_treatments): así los pacientes
  // importados sin historial de citas también entran en el segmento "por tratamiento".
  const taggedTreatByPatient = {};
  if (wantTrat) {
    const { data: tags } = await supabase.from("df_patient_treatments").select("patient_id, treatment_id");
    for (const t of tags || []) {
      if (!t.patient_id) continue;
      (taggedTreatByPatient[t.patient_id] = taggedTreatByPatient[t.patient_id] || new Set()).add(String(t.treatment_id));
    }
  }
  const pendingByPatient = {};
  if (wantPresu) {
    const { data: pays } = await supabase.from("df_patient_payments").select("patient_id, paid");
    for (const p of pays || []) { if (!p.paid && p.patient_id) pendingByPatient[p.patient_id] = true; }
  }
  const INACT_MONTHS = 6;
  const inactCutoff = new Date(now.getFullYear(), now.getMonth() - INACT_MONTHS, now.getDate()).getTime();
  const treatList = (treatments || []).map((t) => String(t));
  const treatSet = new Set(treatList);

  const matched = [];
  for (const pt of patients || []) {
    let match = false;
    if (wantEdad && ageRanges.length) {
      const age = ageOf(pt.birth_date);
      if (age != null && ageRanges.some((r) => {
        const min = r.min != null ? Number(r.min) : 0;
        const max = r.max != null ? Number(r.max) : min;
        return age >= min && age <= max;
      })) match = true;
    }
    if (!match && wantTrat && treatSet.size) {
      const list = apptsByPatient[pt.id] || [];
      const tagged = taggedTreatByPatient[pt.id];
      if (list.some((a) => a.treatment_id && treatSet.has(String(a.treatment_id)))) match = true;
      else if (tagged && [...treatSet].some((tid) => tagged.has(tid))) match = true;
    }
    if (!match && wantInact) {
      const list = apptsByPatient[pt.id] || [];
      const last = list.reduce((mx, a) => Math.max(mx, Date.parse(a.starts_at) || 0), 0);
      if (!last || last < inactCutoff) match = true;
    }
    if (!match && wantPresu && pendingByPatient[pt.id]) match = true;
    // Pacientes elegidos a mano (segmento manual).
    if (!match && manualSet.has(String(pt.id))) match = true;
    if (match) matched.push(pt);
  }
  return matched;
}

// Extrae la configuración de segmento (segments/treatments/age_ranges) de una campaña.
function campaignSegmentInput(campaign) {
  const cfg = (campaign && campaign.segment_config) || {};
  const segments = Array.isArray(cfg.segments) && cfg.segments.length
    ? cfg.segments.map((s) => String(s))
    : (campaign && campaign.segment ? [String(campaign.segment)] : []);
  return {
    segments,
    treatments: Array.isArray(cfg.treatments) ? cfg.treatments : [],
    ageRanges: Array.isArray(cfg.age_ranges) ? cfg.age_ranges : [],
    manualPatientIds: Array.isArray(cfg.manual_patient_ids) ? cfg.manual_patient_ids : [],
  };
}

// Previsualización: cuenta cuántos pacientes caen en el segmento elegido, para mostrar
// "N pacientes seleccionados" al crear la campaña.
app.post("/api/campaigns/preview", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const matched = await matchCampaignPatients({
      segments: Array.isArray(b.segments) ? b.segments.map((s) => String(s)) : [],
      treatments: Array.isArray(b.treatments) ? b.treatments : [],
      ageRanges: Array.isArray(b.age_ranges) ? b.age_ranges : [],
      manualPatientIds: Array.isArray(b.manual_patient_ids) ? b.manual_patient_ids : [],
    });
    if (matched == null) return res.json({ count: null, withPhone: null, manualOnly: true });
    const withPhone = matched.filter((p) => p.phone).length;
    return res.json({ count: matched.length, withPhone });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Busca en Meta la plantilla APROBADA por nombre y devuelve su idioma y nº de variables
// del cuerpo ({{1}}, {{2}}…), para poder enviarla con los parámetros correctos.
async function fetchApprovedTemplate(name) {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.WABA_ID || "";
  const token = process.env.WHATSAPP_TOKEN || "";
  if (!wabaId || !token) throw new Error("WhatsApp/Meta no configurado (WABA ID o token).");
  const url = `${META_GRAPH_BASE}/${wabaId}/message_templates?limit=200&fields=name,status,language,components`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.error_user_msg || data?.error?.message || `Meta Graph ${r.status}`);
  const matches = (data.data || []).filter((t) => t.name === name);
  if (!matches.length) throw new Error(`La plantilla "${name}" no existe en Meta.`);
  const tpl = matches.find((t) => t.status === "APPROVED") || matches[0];
  if (tpl.status !== "APPROVED") throw new Error(`La plantilla "${name}" no está aprobada (estado: ${tpl.status}).`);
  const body = (tpl.components || []).find((c) => c.type === "BODY");
  const varNums = [...String(body?.text || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const bodyVarCount = varNums.length ? Math.max(...varNums) : 0;
  return { language: tpl.language, bodyVarCount };
}

// Normaliza un teléfono a formato internacional para WhatsApp (solo dígitos, con prefijo
// de país). Un móvil español de 9 dígitos (empieza por 6/7/8/9) se prefija con 34.
function normalizeWaPhone(raw) {
  let p = String(raw || "").replace(/\D/g, "");
  if (!p) return null;
  if (p.length === 9 && /^[6789]/.test(p)) p = "34" + p;          // móvil ES sin prefijo
  if (p.length < 8) return null;                                   // demasiado corto: no válido
  return p;
}

// ENVÍO MANUAL ("Enviar ahora"): manda la plantilla de la campaña a los pacientes del
// segmento. Se procesa por lotes (BATCH); al reintentar continúa con los que aún no se han
// intentado (df_campaign_recipients). Solo se envía a pacientes con teléfono y que no hayan
// hecho opt-out (marketing_consent = false). Requiere plantilla con 0 o 1 variable (nombre).
app.post("/api/campaigns/:id/send", requireAuth, async (req, res) => {
  const BATCH = 100;
  const CONCURRENCY = 6;
  try {
    const wa = require("./lib/whatsapp");
    if (!wa.isConfigured()) return res.status(400).json({ error: "WhatsApp no está configurado en el servidor." });

    const { data: campaign, error: cErr } = await supabase
      .from("df_campaigns").select("*").eq("id", req.params.id).single();
    if (cErr || !campaign) return res.status(404).json({ error: "Campaña no encontrada." });
    if (campaign.status === "cancelled") return res.status(400).json({ error: "La campaña está cancelada." });

    const templateName = campaign.message_template || (campaign.segment_config || {}).template_name;
    if (!templateName) return res.status(400).json({ error: "La campaña no tiene plantilla de Meta asignada." });

    // Datos de la plantilla (idioma + nº de variables) para enviar con los parámetros justos.
    let tplInfo;
    try { tplInfo = await fetchApprovedTemplate(templateName); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (tplInfo.bodyVarCount > 1) {
      return res.status(400).json({ error: `La plantilla "${templateName}" tiene ${tplInfo.bodyVarCount} variables. El envío automático solo admite plantillas con 0 o 1 variable (el nombre del paciente).` });
    }

    const matched = await matchCampaignPatients(campaignSegmentInput(campaign));
    if (matched == null) {
      return res.status(400).json({ error: "El segmento es manual/personalizado: no hay destinatarios calculables automáticamente." });
    }
    // Destinatarios: cualquiera con un teléfono utilizable (se normaliza a formato
    // internacional). La gestión del consentimiento de marketing es responsabilidad de la
    // clínica; para poder probar/enviar no se exige la marca (que por defecto es false).
    const eligible = matched
      .map((p) => ({ ...p, waPhone: normalizeWaPhone(p.phone) }))
      .filter((p) => p.waPhone);
    if (eligible.length === 0) {
      return res.status(400).json({ error: "Ningún paciente del segmento tiene un teléfono válido para enviar por WhatsApp." });
    }

    // Excluye a quien ya se haya INTENTADO (enviado o fallado) en esta campaña.
    const { data: already } = await supabase
      .from("df_campaign_recipients").select("patient_id").eq("campaign_id", campaign.id);
    const attempted = new Set((already || []).map((r) => r.patient_id));
    const pending = eligible.filter((p) => !attempted.has(p.id));

    // Todos los elegibles ya se habían intentado: no hay nada nuevo que enviar.
    if (pending.length === 0) {
      if (campaign.status !== "sent") {
        await supabase.from("df_campaigns").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", campaign.id);
      }
      return res.json({ sent: 0, failed: 0, remaining: 0, totalEligible: eligible.length, alreadyAll: true, done: true });
    }
    const batch = pending.slice(0, BATCH);

    let sent = 0, failed = 0, lastError = null;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (pt) => {
        const firstName = String(pt.full_name || "").trim().split(/\s+/)[0] || "";
        const params = tplInfo.bodyVarCount === 1 ? [firstName || "paciente"] : [];
        try {
          await wa.sendTemplate(pt.waPhone, templateName, tplInfo.language, params);
          sent++;
          await supabase.from("df_campaign_recipients").insert({ campaign_id: campaign.id, patient_id: pt.id, status: "sent", sent_at: new Date().toISOString() }).then(() => {}, () => {});
        } catch (e) {
          failed++; lastError = e.message;
          await supabase.from("df_campaign_recipients").insert({ campaign_id: campaign.id, patient_id: pt.id, status: "failed" }).then(() => {}, () => {});
        }
      }));
    }

    const remaining = Math.max(0, pending.length - batch.length);
    // Si ya no queda nadie por intentar, la campaña queda ENVIADA.
    if (remaining === 0) {
      await supabase.from("df_campaigns").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", campaign.id);
    }
    return res.json({
      sent, failed, remaining,
      totalEligible: eligible.length,
      skippedNoPhone: matched.length - eligible.length,
      error_detail: failed && !sent ? lastError : undefined,
      done: remaining === 0,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Elimina (cancela) una campaña. Al borrarla se cancela: ya no queda programada ni se
// enviará. Los destinatarios asociados se borran en cascada (ON DELETE CASCADE).
app.delete("/api/campaigns/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("df_campaigns").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ ok: true });
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

    const url = `${META_GRAPH_BASE}/${wabaId}/message_templates?limit=200&fields=name,status,category,language,components`;
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
        // Identifica que responde el asistente automático.
        await wa.sendText(m.from, withWaPrefix(WA_BOT_PREFIX, result.reply)).catch((e) => console.error("[wa send]", e.message));
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
