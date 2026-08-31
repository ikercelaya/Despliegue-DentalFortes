// Interruptores GENERALES del sistema: el asistente de WhatsApp y los recordatorios
// automáticos. Se guardan en df_settings (clave "switches") para poder apagarlos y
// encenderlos desde el panel, sin tocar código ni volver a desplegar.
//
// Además se pueden forzar desde las variables de entorno de Vercel (útil si hay que
// apagarlo sin entrar al panel): BOT_ENABLED=false y REMINDERS_ENABLED=false. Lo que
// esté apagado por entorno manda: el panel no lo puede encender.
const { supabase } = require("./db");

const CLAVE = "switches";
const CACHE_MS = 20000;   // se relee cada 20 s (un mensaje no dispara una consulta extra)
let cache = null;
let cacheAt = 0;

function apagadoPorEntorno(nombre) {
  const v = String(process.env[nombre] == null ? "" : process.env[nombre]).trim().toLowerCase();
  return ["0", "false", "off", "no", "apagado"].includes(v);
}

// Estado actual: { bot, reminders, botDesde, remindersDesde, forzadoEntorno }
async function getSwitches({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  let val = {};
  try {
    const { data } = await supabase.from("df_settings").select("value").eq("key", CLAVE).maybeSingle();
    val = (data && data.value) || {};
  } catch (_e) { val = cache ? { bot: cache.bot, reminders: cache.reminders } : {}; }
  const envBot = apagadoPorEntorno("BOT_ENABLED");
  const envRem = apagadoPorEntorno("REMINDERS_ENABLED");
  const estado = {
    // Por defecto, TODO encendido: solo se apaga si alguien lo apaga expresamente.
    bot: val.bot !== false && !envBot,
    reminders: val.reminders !== false && !envRem,
    botDesde: val.bot === false ? val.bot_at || null : null,
    remindersDesde: val.reminders === false ? val.reminders_at || null : null,
    forzadoEntorno: { bot: envBot, reminders: envRem },
  };
  cache = estado;
  cacheAt = Date.now();
  return estado;
}

// Enciende o apaga uno de los dos. Devuelve el estado resultante.
async function setSwitch(nombre, activo) {
  if (!["bot", "reminders"].includes(nombre)) throw new Error("Interruptor desconocido: " + nombre);
  const { data } = await supabase.from("df_settings").select("value").eq("key", CLAVE).maybeSingle();
  const val = (data && data.value) || {};
  val[nombre] = !!activo;
  val[nombre + "_at"] = activo ? null : new Date().toISOString();
  const { error } = await supabase.from("df_settings")
    .upsert({ key: CLAVE, value: val, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  cache = null;
  return getSwitches({ fresh: true });
}

// Atajos legibles.
async function botActivo() { return (await getSwitches()).bot; }
async function recordatoriosActivos() { return (await getSwitches()).reminders; }

module.exports = { getSwitches, setSwitch, botActivo, recordatoriosActivos };
