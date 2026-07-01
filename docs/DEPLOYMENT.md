# 🚀 Fase 1 — Despliegue a producción (Supabase + Vercel)

Runbook exacto para pasar el CRM de local a producción. Tiempo estimado: ~1-2 h.
Todo lo de código ya está listo; esto son los pasos de aprovisionamiento en tus paneles.

---

## 0) Antes de empezar — genera los secretos

En local (con Node instalado):

​```bash
npm install
npm run secrets -- "LA_CONTRASEÑA_DEL_PANEL"
​```

Te imprime dos líneas listas para pegar en Vercel:

​```
SESSION_SECRET=...
ADMIN_PASSWORD_HASH=$2a$10$...
​```

> La contraseña en claro nunca se guarda: solo se guarda su hash bcrypt.
> Guarda estas dos líneas en un sitio seguro (gestor de contraseñas).

---

## 1) Supabase — crear proyecto y cargar el esquema

1. [supabase.com](https://supabase.com) → **New project**.
   - Nombre: `dental-fortes`
   - Región: **EU West (Ireland)** (más cerca = menos latencia).
   - Apunta la **Database Password** que pongas.
2. **SQL Editor** → pega y ejecuta **todo** `sql/schema.sql` → debe terminar sin errores
   (la consulta final devuelve las tablas creadas, todas con nombre, ninguna `null`).
3. **SQL Editor** → pega y ejecuta `sql/seed.sql` → debe devolver `profesionales = 7`
   y `tratamientos = 9`.
4. **Settings → API** → copia:
   - **Project URL** → `SUPABASE_URL` (solo el dominio, **sin** `/rest/v1/`).
   - **`service_role` secret** → `SUPABASE_SERVICE_KEY` ⚠️ **la `service_role`, NO la `anon`**.

---

## 2) Vercel — desplegar

1. [vercel.com](https://vercel.com) → **Add New → Project** → importa
   `ikercelaya/Despliegue-DentalFortes`.
   - Framework preset: **Other** (no toca; ya hay `vercel.json`).
2. **Environment Variables** (para `Production`, `Preview` y `Development`):

   | Variable | Valor |
   |----------|-------|
   | `SUPABASE_URL` | `https://xxxxx.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | `eyJ...service_role...` |
   | `ADMIN_PASSWORD_HASH` | el `$2a$10$...` del paso 0 |
   | `SESSION_SECRET` | el del paso 0 |
   | `PUBLIC_URL` | `https://<tu-dominio>.vercel.app` |
   | `TZ` | `Europe/Madrid` |

   > `TZ=Europe/Madrid` es importante: sin ella Vercel corre en UTC y el dashboard
   > cuenta "citas hoy" con el día equivocado en las horas límite.

3. **Deploy**.

---

## 3) Verificación (las 8 secciones online)

Abre `https://<tu-dominio>.vercel.app` → redirige a `/admin` → entra con la contraseña.

- [ ] **Login** entra y persiste al recargar.
- [ ] **Dashboard** carga (0 citas, KPIs a 0).
- [ ] **Agenda** pinta la semana.
- [ ] **Pacientes** — crea uno de prueba y bórralo.
- [ ] **Conversaciones** — vacío (se llena en Fase 2).
- [ ] **Reseñas** — crea una de prueba (5★ → Google, ≤4★ → interna) y bórrala.
- [ ] **Marketing** — crea una campaña borrador.
- [ ] **Profesionales** — aparecen los **7** con sus horarios.
- [ ] **Tratamientos** — aparecen los **9** genéricos.

Salud del servidor: `https://<tu-dominio>.vercel.app/healthz` → `{"ok":true}`.

---

## Notas / gotchas verificados

- **Versión de `@supabase/supabase-js`**: fijada vía `package-lock.json` (2.110.0). Esta
  versión **lanza error al arrancar si `SUPABASE_URL` está vacío** — si el deploy falla
  al iniciar, casi siempre es una env var mal puesta o vacía.
- **`service_role` vs `anon`**: el backend usa `service_role` (permisos totales). Nunca la
  expongas en frontend; solo vive en las env vars de Vercel.
- **Logo**: `public/logo.svg` es un placeholder. Se sustituye por el PNG real en Fase 7.
- **Reseñas**: con estrellas enteras (1-5), el routing manda **5★ → Google** y **1-4★ →
  gestión interna**. Si quieres que un 4★ también vaya a Google, hay que ajustar el umbral
  en `server.js` (`r >= 4.5`).