// Detección rudimentaria de idioma (ES / CA) — pensada para el futuro bot.
// Heurística por palabras clave catalanas. Sirve también para clasificar pacientes.

const CA_WORDS = /\b(amb|sense|hola(?:r)?|bona\s+tarda|bon\s+dia|gr[aà]cies|si\s+us\s+plau|vols(?:t[eé])?s?|av(?:ui|iat)|dem[àa]|tu|jo|ell|nosaltres|aix[oò]|aqu[ií]|all[àa]|m[eè]s|menys|tamb[eé]|qu[èe]|on|quan|per\s+qu[èe])\b/i;

function detectLanguage(text) {
  const raw = String(text || "").trim();
  if (!raw) return "es";
  return CA_WORDS.test(raw) ? "ca" : "es";
}

module.exports = { detectLanguage };
