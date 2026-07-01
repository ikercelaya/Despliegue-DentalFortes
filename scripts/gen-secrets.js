#!/usr/bin/env node
// =============================================================
// Genera los secretos necesarios para el despliegue en Vercel.
//
//   node scripts/gen-secrets.js "TU_CONTRASEÑA_ADMIN"
//   npm run secrets -- "TU_CONTRASEÑA_ADMIN"
//
// Imprime:
//   - SESSION_SECRET      → cadena aleatoria (firma de sesión)
//   - ADMIN_PASSWORD_HASH → hash bcrypt de la contraseña que pases
//
// Copia ambas líneas tal cual en las Environment Variables de Vercel.
// La contraseña en claro NO se guarda en ningún sitio: solo su hash.
// =============================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const password = process.argv[2];
const sessionSecret = crypto.randomBytes(48).toString("base64url");

console.log("");
console.log("SESSION_SECRET=" + sessionSecret);

if (password) {
  const hash = bcrypt.hashSync(String(password), 10);
  console.log("ADMIN_PASSWORD_HASH=" + hash);
  console.log("");
  console.log("# Contraseña del panel: la que acabas de pasar como argumento.");
} else {
  console.log("# ADMIN_PASSWORD_HASH=<pasa tu contraseña como argumento para generarlo>");
  console.log("#");
  console.log('#   node scripts/gen-secrets.js "MiContraseñaSegura"');
}
console.log("");