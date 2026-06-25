# Dental Fortes — CRM

> CRM clínico para Dental Fortes (Sant Boi de Llobregat). Versión base lista para producción y preparada para integrar el chatbot (Web + WhatsApp) en una **Fase 2** posterior.

## ✨ Qué incluye esta versión (v1)

- 🔐 **Login** con contraseña (bcrypt + token firmado).
- 📊 **Dashboard** con 3 KPIs: citas hoy · próximos 7 días · pacientes nuevos esta semana.
- 📅 **Agenda** semanal por profesional (lunes-viernes 9-20 h), filtros por especialista, alta/edición/borrado de citas con autocompletado de paciente.
- 👥 **Pacientes**: CRUD, ficha completa (datos, historial, pendientes, citas, cobros), estados (higiene/reposición/control), etiquetas, idioma (ES/CA), consentimiento marketing.
- 💬 **Conversaciones** (placeholder): la pantalla está montada y conectada a la BD para que cuando se integre el bot en Fase 2 aparezcan automáticamente. Permite pausar bot, responder a mano y cerrar.
- ⭐ **Reseñas**: alta de valoraciones con routing automático (≥4.5★ → Google, <4.5 → gestión interna por Juan).
- 📣 **Campañas**: crear campañas de marketing por segmento (inactivos, edad, tratamiento, presupuestos no aceptados).
- 👨‍⚕️ **Profesionales**: gestión completa con horarios semanales por franjas. **Ya pre-cargados los 7 del PDF**.
- 🧰 **Tratamientos**: catálogo con duración y marcado de primera visita. **Hay 9 tratamientos genéricos pre-cargados** que el cliente debe completar.

## 🎨 Identidad visual

- Paleta: grises y plata sobre fondo oscuro (la del logo).
- Tipografía: del sistema (-apple-system / Segoe UI / Roboto).

> ⚠️ El ZIP incluye `public/logo.svg` como **placeholder**. **Sustitúyelo por el PNG real** (renómbralo a `logo.svg` o cambia las dos referencias en `admin.html` por `/logo.png`).

## 🗂️ Estructura

```
dental-fortes-crm/
├── server.js                 Express + todas las rutas
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
├── README.md
├── lib/
│   ├── db.js                 Cliente Supabase (service_role)
│   ├── auth.js               Login, bcrypt, token de sesión
│   └── i18n.js               Detección ES/CA (para el bot)
├── public/
│   ├── admin.html            SPA: login + las 8 secciones
│   └── logo.svg              ← REEMPLAZAR por el PNG real
└── sql/
    ├── schema.sql            Esquema completo (ejecutar primero)
    └── seed.sql              Datos iniciales (los 7 profesionales)
```

---

## 🚀 Despliegue paso a paso

### 1️⃣ Crea proyecto en Supabase

1. [supabase.com](https://supabase.com) → **New project**.
2. Nombre: `dental-fortes`. Región: `EU West (Ireland)`.
3. Apunta la contraseña que pongas (la necesitarás para acceder a la BD).
4. **SQL Editor** → pega y ejecuta el contenido de **`sql/schema.sql`**.
5. **SQL Editor** → pega y ejecuta **`sql/seed.sql`** (carga los 7 profesionales y 9 tratamientos genéricos).
6. **Settings → API** → copia:
   - **Project URL** → será `SUPABASE_URL` (solo el dominio, **sin** `/rest/v1/`).
   - **`service_role` secret** → será `SUPABASE_SERVICE_KEY` (¡NO la `anon`!).

### 2️⃣ Genera el hash de la contraseña del admin

En tu equipo local (Node debe estar instalado):

```bash
npm install bcryptjs
node -e "console.log(require('bcryptjs').hashSync('TU_PASSWORD_AQUI', 10))"
```

Copia el hash que devuelve (empieza por `$2a$10$...`). Será tu `ADMIN_PASSWORD_HASH`.

### 3️⃣ Sube el código a GitHub

```bash
cd dental-fortes-crm
git init
git add .
git commit -m "feat: CRM Dental Fortes v1"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/dental-fortes-crm.git
git push -u origin main
```

### 4️⃣ Despliega en Vercel

1. [vercel.com](https://vercel.com) → **Add New → Project**.
2. Importa el repo de GitHub.
3. **Settings → Environment Variables** → añade estas (mismas para `Production`, `Preview` y `Development`):

| Variable | Valor |
|----------|-------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJ...service_role...` |
| `ADMIN_PASSWORD_HASH` | el hash bcrypt del paso 2 |
| `SESSION_SECRET` | cadena aleatoria larga (32+ caracteres) |
| `PUBLIC_URL` | `https://dental-fortes-crm.vercel.app` (o el dominio que te dé Vercel) |

4. **Deploy**.

### 5️⃣ Sustituye el logo

1. Sube el PNG real a `public/` con el nombre `logo.png`.
2. En `public/admin.html`, **busca** las dos referencias a `/logo.svg` y cámbialas por `/logo.png`. Hay 2 ocurrencias (login y sidebar).
3. Commit + push → Vercel redeploya solo.

### 6️⃣ Comprueba que funciona

- Abre `https://tu-dominio.vercel.app` → te redirige a `/admin`.
- Mete la contraseña (la que pusiste para generar el hash).
- Deberías ver el **Dashboard** con 0 citas y los 7 profesionales ya cargados en la sección **Profesionales**.

---

## 🔌 Cómo se integrará el chatbot (Fase 2 — próxima entrega)

El CRM ya tiene preparada toda la infraestructura para recibir conversaciones del bot:

### Tablas listas

- `df_conversations` — una por lead (web o WhatsApp).
- `df_messages` — mensajes (user / assistant / admin).
- `df_appointments` — el bot insertará citas con `source = 'bot_web'` o `'bot_whatsapp'`.
- `df_patients` — el bot puede crear el paciente si no existe.

### Endpoints que el bot reutilizará

- `POST /api/appointments` — para crear citas desde el bot.
- `GET /api/professionals` + `GET /api/treatments` — para que el bot conozca disponibilidad y catálogo.
- `POST /api/conversations` + `POST /api/messages` — para guardar la conversación (se añadirán en Fase 2).

### Flujo previsto

```
Cliente (WhatsApp o Web)
     ↓
Bot (Claude) — filtro de urgencia → ¿dolor real? sí → marca is_urgent=true
     ↓
Cualifica: motivo, paciente nuevo/existente, día/franja preferida
     ↓
Comprueba disponibilidad → propone hueco → confirma
     ↓
Inserta df_appointments con status='pending' + source='bot_web|bot_whatsapp'
     ↓
Aparece en la AGENDA del panel admin → Recepción la confirma (status='confirmed')
```

---

## 🛠️ Desarrollo local

```bash
cp .env.example .env
# edita .env con tus credenciales reales
npm install
npm start
```

Servidor en `http://localhost:3000`. Login en `http://localhost:3000/admin`.

---

## 📋 Pendientes para Fase 2 (chatbot)

- [ ] Integrar Anthropic (Claude) — copiar `lib/claude.js` de Renovebot adaptado.
- [ ] Integrar WhatsApp Cloud API — copiar `lib/whatsapp.js` y configurar webhook (la app ya está creada en Meta).
- [ ] Detección ES/CA del bot (módulo `lib/i18n.js` ya base lista).
- [ ] Endpoint `POST /api/chat` (web) y `POST /api/whatsapp/webhook` (WhatsApp).
- [ ] Widget embebible para la web de Dental Fortes (`public/widget.js`).
- [ ] System prompt en `lib/prompt.js` + base de conocimiento en `info/*.txt`.
- [ ] Sistema de recordatorios (Vercel Cron o Supabase pg_cron):
  - −3 días antes (9:00-12:00).
  - −1 día antes (9:00-11:00, agresivo).
  - Mismo día 15:00 → si no contesta, cancelar.

---

## ⚠️ Seguridad

- **NO subas `.env`** al repo (ya está en `.gitignore`).
- La `SUPABASE_SERVICE_KEY` tiene permisos totales — no la expongas en frontend, solo en variables de entorno del servidor.
- Cambia `SESSION_SECRET` por algo realmente aleatorio en producción.
- `ADMIN_PASSWORD_HASH` está bien con bcrypt cost 10 (estándar).

---

*Proyecto desarrollado por **Propulsa** ([ia-propulsa.com](https://ia-propulsa.com)).*
