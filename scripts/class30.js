// =======================
// class30 — Gateway HTTPS/WebSocket/Redis → Python + UI
// =======================

import fs from "fs-extra";
import path from "path";
import http from "http";
import https from "https";
import net  from "net";        // túnel TCP para WebSocket proxy (Socket.IO)
import express from "express";
import compression from "compression";
import chalk from "chalk";
import { WebSocketServer, WebSocket } from "ws";
import Redis from "ioredis";
import crypto from "crypto";
import { URL } from "url";
import { fileURLToPath } from "url";
import jwt            from "jsonwebtoken";
// Las funciones de seguridad de red viven aparte para que la simulación las
// pueda ejercitar sin arrastrar MySQL ni abrir el 8443 (ver seguridad_red.js).
import { ipReal, esProxyConfiable, origenPermitido, ORIGENES_WS,
         mandarHsts, esHostLocal,
         apiRequiereSesion, tokenDelPedido } from "./seguridad_red.js";
// class14 — OAuth Identity Gateway
import { encolarAcotado, topeDesdeEntorno, esDecisionInterna } from "./cola_acotada.js";
import class14        from "./class14.js";
// query directo a MySQL: lo necesita _esAdminEmail (requirePro). class14 no
// exporta `query` en su default, y el admin tiene que resolverse contra la
// tabla `miia_admins`, no contra una variable del navegador.
import { query as sqlQuery } from "./class42.js";
// Mercado Pago SDK
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// MIIA — publishSystemEvent (JS)
// ============================================================
const SYSTEM_CHANNELS = {
  LOG: "system.log",
  ERROR: "system.error",
  METRICS: "system.metrics",
};

export async function publishSystemEvent(redisClientRef, type, payload, source = "unknown") {
  if (!SYSTEM_CHANNELS[type]) return;
  const envelope = {
    ts: new Date().toISOString(),
    source,
    type,
    payload,
  };
  try {
    await redisClientRef.publish(SYSTEM_CHANNELS[type], JSON.stringify(envelope));
  } catch (err) {
    log("publishSystemEvent_error", { err: err && err.message ? err.message : String(err) });
  }
}

// ============================================================
// HELPERS: buildEnvelope (NORMALIZAR TODO MENSAJE A ENVELOPE ESTÁNDAR)
// ============================================================
function buildEnvelope({ source, type, text, data }) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString("hex"),
    source: source || "class30",
    type: type || "event",
    text: typeof text === "string" ? text : "",
    data: data && typeof data === "object" ? data : {},
    ts: new Date().toISOString(),
  };
}

// =======================
// CONFIG
// =======================
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PORT = Number(process.env.PORT || 8443);
const PYTHON_SERVER = process.env.PYTHON_SERVER || "http://localhost:5005";
const CHANNELS = [ "class25_output", "class25a_output",
                   // Instrumentación del panel de flujo (AI Engines). Se cuentan
                   // y se CORTAN en el handler: no se relayean uno por uno.
                   "class23_output", "class24_output", "class24_feedback" ];

// ── Agregador del panel de flujo ─────────────────────────────────────────
// Con ~40 procesos publicando, mandar cada mensaje a cada navegador seria
// devolverle al server la carga que le sacamos en ORDEN 2. Se acumula acá y se
// emite UN tick por segundo, solo si hay alguien mirando.
//
// No consulta la base: `pendientes` ya lo trae el panel desde el endpoint de
// backtesting que la página llama igual. Una query por segundo sobre
// cognitive_decisions seria repetir el error de _marketRet.
const FLUJO_CHANNELS = new Set(["class23_output","class24_output","class24_feedback"]);
const _flujo = { msgs:0, fb:0, redes:{}, senal:"HOLD", conf:0.5 };

// OAuth — credenciales se toman de class14 (que las tiene definidas)
// o de env vars si se quieren sobreescribir en producción
// JWT_SECRET ya no se define acá. Esta constante estaba sin usar —la única
// referencia era el comentario de requireAuth— y tenía un fallback DISTINTO al
// de class14 ("miia-jwt-secret-cambiar" contra "...-cambiar-en-produccion"),
// que fue justamente lo que hizo rechazar tokens en su momento. Toda la
// verificación pasa por class14.verifyToken, que es la única fuente.
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || class14.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || class14.GOOGLE_CLIENT_SECRET || "";
// OAuth callback: usa https://localhost:8443 (ya registrado en Google Console).
// El browser muestra advertencia de cert self-signed → el usuario hace clic en
// "Avanzado → Continuar" UNA sola vez y queda aceptado para la sesión.
// En producción setear OAUTH_CALLBACK=https://tudominio.com
const OAUTH_CALLBACK = process.env.OAUTH_CALLBACK || "https://localhost:8443";

// Mercado Pago
const MP_ACCESS_TOKEN  = process.env.MP_ACCESS_TOKEN  || "";
const mp = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }) : null;

// Precios de suscripción
const PLANES = {
  basico:        { nombre: "MIIA Básico",        precio: 15,  moneda: "USD", dias: 30  },
  pro:           { nombre: "MIIA Pro",            precio: 25,  moneda: "USD", dias: 30  },
  institucional: { nombre: "MIIA Institucional",  precio: 80,  moneda: "USD", dias: 30  },
};
const DEDUPE_TTL_MS = 15000;
const UI_STREAM_MIN_GAP_MS = 100;

const PY_INIT_COOLDOWN_MS = 2000;
const PY_MAX_COOLDOWN_MS = 10000;
let pyCooldownMs = PY_INIT_COOLDOWN_MS;
let pythonCooldownUntil = 0;

const BUFFER_INTERVAL_MS = 90000;
let lastUiStreamSentAt = 0;

// =======================
// WINDOWS-SAFE PATH FIX
// =======================

// ESTRUCTURA DE DIRECTORIOS NORMALIZADA
const rootDir = path.resolve(__dirname, "..");

const certDir = path.join(rootDir, "scripts", "certs");
const logsDir = path.join(rootDir, "operador", "aprendizaje", "logs");
const publicDir = path.join(rootDir, "scripts", "publi");

// Crear carpetas sin duplicar rutas
await fs.ensureDir(logsDir);
await fs.ensureDir(publicDir);

// =======================
// LOG CENTRALIZADO
// =======================
const LOG_FILE = path.join(logsDir, "class30.log");

function log(tipo, payload = {}) {
  const entry = { ts: new Date().toISOString(), tipo, payload };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {}

  const pretty = typeof payload === "string" ? payload : (payload && Object.keys(payload).length ? payload : "");

  console.log(chalk.cyan(`[class30] ${tipo}`), pretty);
}

// ==========================================================
// CONFIG GLOBAL — class38 integrador
// (seguro, fallback automático si falta alguna key)
// ==========================================================
import {
  getStorageConfig,
  getLoggingConfig
} from "./class38.js";

// ==========================================================
// ACCESO SEGURO A CONFIGS
// ==========================================================
const storageCfg = (() => {
  try {
    const cfg = getStorageConfig();
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
})();

const logCfg = (() => {
  try {
    const cfg = getLoggingConfig();
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
})();

// ==========================================================
// HELPERS OPCIONALES ( generico )
// ==========================================================

// Devuelve ruta segura definida en storage.config
export function getPath(key, fallback = "./") {
  try {
    const val = storageCfg[key];
    return typeof val === "string" && val.trim() ? val : fallback;
  } catch {
    return fallback;
  }
}

// Devuelve configuración de logs para esta clase
export function getLogLevel(defaultLevel = "info") {
  try {
    return logCfg.level || defaultLevel;
  } catch {
    return defaultLevel;
  }
}

// Devuelve si el log file debe rotar
export function shouldRotateLogs() {
  try {
    return logCfg.rotate_logs === true;
  } catch {
    return false;
  }
}

// =======================
// HTTPS SERVER
// =======================
const keyPath = path.join(certDir, "pen.key");
const certPath = path.join(certDir, "certen.pem");

if (!(await fs.pathExists(keyPath)) || !(await fs.pathExists(certPath))) {
  console.error(chalk.red("❌ Faltan certificados SSL en: "), certDir);
  process.exit(1);
}

const sslOptions = {
  key: await fs.readFile(keyPath),
  cert: await fs.readFile(certPath),
};

const app = express();
// `X-Powered-By: Express` le regala al atacante el stack y la familia de
// vulnerabilidades a probar. No cuesta nada sacarlo.
app.disable("x-powered-by");

// ══ CABECERAS DE SEGURIDAD (21-sep-2026) ═══════════════════
//
// No había ninguna. Van en el código y no sólo en Cloudflare **a propósito**:
// el origen directo (`https://203.0.113.10:8443/`) se saltea Cloudflare, así
// que una Transform Rule no cubre ese camino. Acá cubren los dos.
//
// La CSP permite lo que la página usa hoy: Tailwind y socket.io por CDN, Google
// para el login, y `unsafe-inline`/`unsafe-eval` porque el build de publi_src
// inyecta el body y los estilos por `document.write`. Sacar esos dos exigiría
// rehacer el empaquetado — anotado, no se toca en este corte.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // HSTS sólo sobre TLS, y NUNCA en localhost (el certificado local es
  // autofirmado y HSTS deja a Chrome sin el «Avanzado → continuar»).
  // La decisión vive en `mandarHsts` de seguridad_red.js —funciones puras— para
  // que `sim11_seguridad.js` la pueda probar sin abrir el 8443. Ver la nota
  // extensa allá.
  if (mandarHsts(req))
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // 16-nov-2026: la consola mostraba bloqueados el beacon de Cloudflare Web
  // Analytics, los iframes y las conexiones de AdSense (doubleclick,
  // adtrafficquality) y el .map de socket.io. Se suman sólo esos orígenes;
  // sin frame-src explícito, los iframes caían en default-src 'self'.
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com " +
      "https://cdn.socket.io https://accounts.google.com https://pagead2.googlesyndication.com " +
      "https://*.googlesyndication.com https://*.adtrafficquality.google " +
      "https://googleads.g.doubleclick.net https://www.googletagservices.com " +
      "https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' wss: https://accounts.google.com https://cdn.socket.io " +
      "https://*.googlesyndication.com https://*.adtrafficquality.google " +
      "https://googleads.g.doubleclick.net https://*.google.com https://cloudflareinsights.com",
    "frame-src 'self' https://accounts.google.com https://googleads.g.doubleclick.net " +
      "https://tpc.googlesyndication.com https://*.googlesyndication.com " +
      "https://*.adtrafficquality.google https://www.google.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));
  next();
});

app.use(compression());
app.use(express.json({ limit: "2mb" }));

// =======================
// RATE LIMITING (por IP, en memoria — sin dependencias externas)
// - /api/ask y /api/chat: 10 req/min (cada request consume cuota de Gemini)
// - resto de /api/*:      120 req/min (dashboard hace polling legítimo)
// Ventana deslizante simple; se limpia cada 5 min para no crecer sin límite.
// =======================
const _rlBuckets = new Map();   // key → [timestamps ms]
function _rateLimit(key, maxReq, ventanaMs) {
  const now = Date.now();
  let arr = _rlBuckets.get(key);
  if (!arr) { arr = []; _rlBuckets.set(key, arr); }
  while (arr.length && now - arr[0] > ventanaMs) arr.shift();
  if (arr.length >= maxReq) return false;
  arr.push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of _rlBuckets)
    if (!arr.length || now - arr[arr.length - 1] > 10 * 60_000) _rlBuckets.delete(k);
}, 5 * 60_000);

app.use("/api", (req, res, next) => {
  const ip = ipReal(req);
  const esChat = req.path === "/ask" || req.path === "/chat";
  const ok = esChat
    ? _rateLimit(`chat:${ip}`, 10, 60_000)
    : _rateLimit(`api:${ip}`, 120, 60_000);
  if (!ok) {
    return res.status(429).json({
      error: "Demasiadas solicitudes. Esperá un momento e intentá de nuevo.",
      retry_after_s: 30,
    });
  }
  next();
});

// ── Sesión obligatoria (20-nov-2026, decisión de Martín) ──────────
// Todo /api exige un JWT válido salvo la lista corta de API_PUBLICAS
// (seguridad_red.js). Va DESPUÉS del rate limit, así un script sin token
// igual consume cupo. `requiere: "login"` le dice a la página que la sesión
// venció o falta, para que mande a entrar con Google en vez de mostrar un error.
// Reversa sin tocar código: MIIA_SESION_OBLIGATORIA=0.
const SESION_OBLIGATORIA = process.env.MIIA_SESION_OBLIGATORIA !== "0";
function _usuarioDelPedido(req) {
  const t = tokenDelPedido(req);
  return t ? class14.verifyToken(t) : null;
}
app.use("/api", (req, res, next) => {
  if (!SESION_OBLIGATORIA || !apiRequiereSesion(req.path)) return next();
  const user = _usuarioDelPedido(req);
  if (!user) return res.status(401).json({ error: "Iniciá sesión con Google para usar MIIA", requiere: "login" });
  req.user = req.user || user;
  next();
});

app.use("/", express.static(publicDir));

const server = https.createServer(sslOptions, app);

// =======================
// WEBSOCKET SERVER
// =======================
// ============================================================
// MIDDLEWARE AUTH — verifica JWT en rutas protegidas
// ============================================================
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "") ||
                req.query.token;
  if (!token) return res.status(401).json({ error: "No autorizado" });
  // Delegar a class14.verifyToken para garantizar el mismo JWT_SECRET
  // (class30 y class14 tenían fallbacks distintos → tokens rechazados)
  const user = class14.verifyToken(token);
  if (!user) return res.status(401).json({ error: "Token inválido o expirado" });
  req.user = user;
  next();
}

// ============================================================
// MIDDLEWARE PRO — control de acceso de SUSCRIPCIÓN, server-side
// ============================================================
// Hasta el 30-ago-2026 el paywall vivía SOLO en el navegador
// (`if (window.__miiaIsAdmin) return;` en index.html). `verificarPlan` se
// usaba únicamente para MOSTRAR el plan en /api/me — ningún endpoint de datos
// lo consultaba. Consecuencias:
//   · escribir `window.__miiaIsAdmin = true` en la consola daba Pro gratis;
//   · pegarle directo a la API, sin pasar por el front, ni siquiera requería eso.
//
// Ocultar la UI no es control de acceso. Esto sí lo es.
async function requirePro(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autorizado", requiere: "pro" });

  const user = class14.verifyToken(token);
  if (!user) return res.status(401).json({ error: "Token inválido o expirado" });
  req.user = user;

  // Los admins tienen Pro sin pagar — igual que en la UI, pero verificado acá
  // contra la tabla, no contra una variable del navegador.
  try {
    if (await _esAdminEmail(user.email)) return next();
  } catch (_) { /* si la consulta falla, sigue por la vía normal del plan */ }

  const { plan, activo } = await class14.verificarPlan(user.user_id);
  if (!activo) {
    return res.status(402).json({
      error:  "Se requiere una suscripción activa",
      plan,
      planes: PLANES,
    });
  }
  next();
}

// Admin por tabla, no por confianza en el cliente. Misma fuente que usa el
// panel de Python (miia_admins + cuenta maestra).
const ADMIN_MASTER_EMAIL = (process.env.ADMIN_MASTER_EMAIL || "").trim().toLowerCase();
async function _esAdminEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (ADMIN_MASTER_EMAIL && e === ADMIN_MASTER_EMAIL) return true;
  // class42.query devuelve { recordset, rowsAffected } — no un array pelado.
  const r = await sqlQuery(
    "SELECT 1 FROM miia_admins WHERE LOWER(email)=? LIMIT 1", [e]
  );
  return (r?.recordset?.length ?? 0) > 0;
}

// ============================================================
// OAUTH ROUTES
// ============================================================

// ── Google OAuth ────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).send("Google OAuth no configurado");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id",     GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri",  `${OAUTH_CALLBACK}/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         "openid email profile");
  url.searchParams.set("access_type",   "offline");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Código OAuth faltante");

    // Intercambiar código por token
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${OAUTH_CALLBACK}/auth/google/callback`,
        grant_type:    "authorization_code"
      })
    });
    const tokens = await tokenResp.json();
    if (!tokens.access_token) throw new Error("Token Google inválido");

    // Obtener perfil de Google
    const profileResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResp.json();

    // Registrar en class14 → MySQL
    const result = await class14.registerOAuthUser({
      provider:    "google",
      provider_id: profile.id,
      email:       profile.email,
      name:        profile.name,
      avatar:      profile.picture
    });

    // Redirigir al frontend con el JWT
    res.redirect(`/?token=${result.token}&user=${encodeURIComponent(result.name || result.email)}&new=${result.is_new}`);

  } catch (e) {
    log("oauth_google_error", { error: e.message });
    res.status(500).send(`Error OAuth Google: ${e.message}`);
  }
});

// Microsoft y Apple OAuth eliminados — solo Google.
// Links viejos a /auth/microsoft o /auth/apple redirigen a Google.
app.get("/auth/microsoft",          (_, res) => res.redirect("/auth/google"));
app.get("/auth/microsoft/callback", (_, res) => res.redirect("/auth/google"));
app.get("/auth/apple",              (_, res) => res.redirect("/auth/google"));

// ── API de usuario ──────────────────────────────────────────
app.get("/api/me", requireAuth, async (req, res) => {
  const perfil = await class14.getUserProfile(req.user.user_id);
  const plan   = await class14.verificarPlan(req.user.user_id);
  res.json({ ...perfil, ...plan });
});

app.get("/api/mis-decisiones", requireAuth, async (req, res) => {
  const decisiones = await class14.getDecisionesUsuario(req.user.user_id, 50);
  res.json({ decisiones });
});

app.put("/api/perfil", requireAuth, async (req, res) => {
  await class14.updateUserProfile(req.user.user_id, req.body);
  res.json({ ok: true });
});

// ============================================================
// MERCADO PAGO
// ============================================================

app.post("/api/subscription/create", requireAuth, async (req, res) => {
  const plan_id = req.body.plan || "basico";
  const plan    = PLANES[plan_id];
  if (!plan) return res.status(400).json({ error: "Plan inválido" });
  if (!mp)   return res.status(503).json({ error: "Mercado Pago no configurado. Agregar MP_ACCESS_TOKEN." });

  try {
    const preference = new Preference(mp);
    const data = await preference.create({
      body: {
        items: [{
          title:        plan.nombre,
          unit_price:   plan.precio,
          quantity:     1,
          currency_id:  plan.moneda,
        }],
        payer:   { email: req.user.email || "usuario@miia.app" },
        back_urls: {
          success: `${OAUTH_CALLBACK}/api/subscription/success`,
          failure: `${OAUTH_CALLBACK}/api/subscription/failure`,
        },
        notification_url: `${OAUTH_CALLBACK}/api/mercadopago/webhook`,
        external_reference: JSON.stringify({
          user_id: req.user.user_id,
          plan:    plan_id,
          dias:    plan.dias
        }),
        auto_return: "approved",
      }
    });

    log("mp_preference_created", { user_id: req.user.user_id, plan: plan_id });
    res.json({
      preference_id: data.id,
      init_point:    data.init_point,    // URL de pago real
      sandbox_url:   data.sandbox_init_point  // URL de sandbox para pruebas
    });

  } catch (e) {
    log("mp_create_error", { error: e.message });
    res.status(500).json({ error: "Error creando preferencia MP: " + e.message });
  }
});

// Webhook que llama Mercado Pago cuando se procesa un pago
// ── Webhook de MercadoPago ───────────────────────────────────────────────
// Endureció el 30-ago-2026. Antes:
//   · no validaba la firma `x-signature`, así que cualquiera podía invocarlo, y
//   · no era idempotente: `activarSuscripcion` hace
//     `plan_vencimiento = NOW + dias`, o sea que reenviar el MISMO webhook
//     aprobado renovaba la suscripción indefinidamente. Quien pagó una vez
//     podía quedarse Pro para siempre repitiendo su propio payment_id.
//
// Consultar el pago contra la API de MP mitigaba lo primero a medias (no se
// puede inventar un pago), pero no lo segundo en absoluto.
const MP_WEBHOOK_SECRET = (process.env.MP_WEBHOOK_SECRET || "").trim();
// Sin secreto el webhook se rechaza siempre, o sea que **ningún pago activa un
// plan solo**. No es un agujero —es lo seguro— pero fallaba en silencio: se
// veía como "Mercado Pago no anda". Con el cobro pausado no molesta; el día que
// se reactive, esta línea es la que avisa.
if (!MP_WEBHOOK_SECRET)
  log("mp_webhook_sin_secreto", { aviso: "MP_WEBHOOK_SECRET vacío: todo webhook de " +
      "Mercado Pago se va a rechazar y ningún pago va a activar un plan" });

// Firma de MP: manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
// HMAC-SHA256 con el secreto del webhook, comparado contra v1 del header.
function _mpFirmaValida(req) {
  if (!MP_WEBHOOK_SECRET) return null;   // null = "no configurado", ver abajo
  try {
    const sig = String(req.headers["x-signature"] || "");
    const reqId = String(req.headers["x-request-id"] || "");
    const partes = Object.fromEntries(
      sig.split(",").map(p => p.split("=").map(x => x.trim())).filter(p => p.length === 2)
    );
    const { ts, v1 } = partes;
    if (!ts || !v1) return false;

    // Ventana de 5 min: sin esto, una firma válida capturada sirve para siempre.
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

    const id = String(req.body?.data?.id ?? "");
    const manifest = `id:${id};request-id:${reqId};ts:${ts};`;
    const esperado = crypto.createHmac("sha256", MP_WEBHOOK_SECRET)
                           .update(manifest).digest("hex");
    // timingSafeEqual: la comparación con === filtra el secreto por tiempo.
    const a = Buffer.from(esperado, "utf8");
    const b = Buffer.from(String(v1), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Idempotencia: tabla propia, para no depender del esquema de suscripciones.
// El PRIMARY KEY hace el trabajo — el segundo INSERT del mismo pago falla.
let _mpTablaLista = false;
async function _pagoYaProcesado(paymentId) {
  if (!_mpTablaLista) {
    await sqlQuery(`CREATE TABLE IF NOT EXISTS mp_pagos_procesados (
      payment_id VARCHAR(64) PRIMARY KEY,
      ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`, []);
    _mpTablaLista = true;
  }
  const r = await sqlQuery(
    "SELECT 1 FROM mp_pagos_procesados WHERE payment_id=? LIMIT 1", [String(paymentId)]
  );
  return (r?.recordset?.length ?? 0) > 0;
}

app.post("/api/mercadopago/webhook", async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== "payment") return res.sendStatus(200);

    // Firma. Si MP_WEBHOOK_SECRET no está configurado, se RECHAZA: un webhook
    // de pagos sin verificar es peor que uno que no funciona, y el fallo es
    // visible en el log en vez de silencioso.
    const firma = _mpFirmaValida(req);
    if (firma === null) {
      log("mp_webhook_sin_secreto", { payment_id: data?.id });
      return res.sendStatus(200);
    }
    if (firma === false) {
      log("mp_webhook_firma_invalida", { payment_id: data?.id, ip: req.ip });
      return res.sendStatus(200);   // 200 igual: no confirmarle nada a quien sondea
    }

    const payment   = new Payment(mp);
    const paymentData = await payment.get({ id: data.id });

    if (paymentData.status !== "approved") {
      log("mp_webhook_not_approved", { status: paymentData.status, payment_id: data.id });
      return res.sendStatus(200);
    }

    // Extraer info del pago
    const ref = JSON.parse(paymentData.external_reference || "{}");
    const { user_id, plan, dias = 30 } = ref;

    if (user_id && plan) {
      if (await _pagoYaProcesado(data.id)) {
        log("mp_webhook_duplicado", { payment_id: data.id, user_id });
        return res.sendStatus(200);
      }
      // Marcar ANTES de activar. No se mira `rowsAffected` a propósito:
      // class42.query lo arma como `[rows.length]`, que para un INSERT es
      // undefined — condicionar sobre eso bloquearía toda activación.
      //
      // Queda una ventana de carrera mínima entre el SELECT y el INSERT, y su
      // consecuencia es benigna: `activarSuscripcion` SETEA
      // `plan_vencimiento = NOW + dias`, no acumula, así que una doble
      // activación simultánea deja exactamente el mismo vencimiento.
      await sqlQuery(
        "INSERT IGNORE INTO mp_pagos_procesados (payment_id) VALUES (?)", [String(data.id)]
      );

      await class14.activarSuscripcion({
        user_id,
        plan,
        dias,
        mp_payment_id: String(data.id)
      });
      log("mp_subscription_activated", { user_id, plan, payment_id: data.id });
    }

    res.sendStatus(200);
  } catch (e) {
    log("mp_webhook_error", { error: e.message });
    res.sendStatus(200); // siempre 200 para MP
  }
});

// Redireccionamiento post-pago
app.get("/api/subscription/success", requireAuth, async (req, res) => {
  res.redirect("/?payment=success");
});
app.get("/api/subscription/failure", (req, res) => {
  res.redirect("/?payment=failure");
});

// Estado de suscripción
app.get("/api/subscription/status", requireAuth, async (req, res) => {
  const plan = await class14.verificarPlan(req.user.user_id);
  res.json({ ...plan, planes: PLANES });
});

// ============================================================
// PROXY HTTP genérico: reenvía req/res a un backend interno
// ============================================================
function proxyHTTP(req, res, targetPort, targetPath) {
  const opts = {
    hostname: "localhost",
    port:     targetPort,
    path:     targetPath,
    method:   req.method,
    headers:  { ...req.headers, host: `localhost:${targetPort}` },
  };
  const pr = http.request(opts, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  pr.on("error", () => { if (!res.headersSent) res.status(502).end(); });
  req.pipe(pr);
}

// ============================================================
// PROXY Socket.IO → class46.js (puerto 3001)
// index.html conecta a wss://localhost:8443/socket.io/
// class30 re-envía HTTP polling y upgrades WS a port 3001
// ============================================================
const DASH_PORT = Number(process.env.DASH_PORT || 3001);

// Polling HTTP (GET/POST /socket.io/?...)
app.use("/socket.io", (req, res) => {
  // El bus en vivo también exige sesión. Socket.IO no deja poner headers desde
  // el navegador: el token viene en `?token=` (ver tokenDelPedido).
  if (SESION_OBLIGATORIA && !_usuarioDelPedido(req))
    return res.status(401).json({ error: "Iniciá sesión con Google para usar MIIA", requiere: "login" });
  proxyHTTP(req, res, DASH_PORT, "/socket.io" + req.url);
});

// ============================================================
// PROXY REST → miia_chatbot.py (puerto 5005)
// Permite que index.html use URLs relativas (/api/chat, etc.)
// sin mixed-content (todo pasa por HTTPS:8443)
// ============================================================
async function proxyToPython(req, res, apiPath, method = "GET", body = null) {
  try {
    // Propagar la IP real del usuario para que el rate limit del chatbot
    // Python distinga usuarios en vez de ver todo como 127.0.0.1 (el proxy)
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || req.socket?.remoteAddress || "";
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-By": "class30",
        ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
        // Reenviar la credencial del usuario al Python. get_current_user() lee el
        // token del header Authorization (Bearer) o de la cookie miia_token. Sin
        // esto, endpoints como /api/admin/* recibían la petición SIN identidad →
        // get_current_user=None → _require_admin → 403 ("sesión admin no válida")
        // → el panel admin no mostraba recursos ni usuarios.
        ...(req.headers.authorization ? { "Authorization": req.headers.authorization } : {}),
        ...(req.headers.cookie ? { "Cookie": req.headers.cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const r = await fetch(`${PYTHON_SERVER}${apiPath}`, opts);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    log("proxy_python_error", { apiPath, error: e.message });
    res.status(502).json({ ok: false, error: "Python no disponible", detail: e.message });
  }
}

// Chat: /api/ask → class25B HTTP (puerto 5005) — endpoint principal del chat
app.post("/api/ask",          async (req, res) => proxyToPython(req, res, "/api/ask",          "POST", req.body));
// Chat legacy: reenvía mensajes al chatbot y devuelve msg_id
app.post("/api/chat",         async (req, res) => proxyToPython(req, res, "/api/chat",         "POST", req.body));
// Portfolio y historial de decisiones → class25B HTTP
app.get("/api/portfolio",     async (req, res) => proxyToPython(req, res, "/api/portfolio",    "GET"));
app.get("/api/backtesting/historial", async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return proxyToPython(req, res, `/api/backtesting/historial${qs ? "?"+qs : ""}`, "GET");
});
// Backtesting Profesional (equity curve, Sortino, drawdown, etc.) — usado por el panel Backtesting
app.get("/api/backtesting/professional", async (req, res) => {
  return proxyToPython(req, res, "/api/backtesting/professional", "GET");
});
app.get("/api/precios",      async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return proxyToPython(req, res, `/api/precios${qs ? "?"+qs : ""}`, "GET");
});
app.get("/api/noticias",     async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return proxyToPython(req, res, `/api/noticias${qs ? "?"+qs : ""}`, "GET");
});
// Serie de precios de un instrumento — la tarjeta del gráfico en el chat.
// FALTABA, y el síntoma era el de siempre: el Python la sirve (`/api/serie`,
// miia_chatbot.py), `curl localhost:5005` la devuelve, y el navegador recibe
// 404 porque el ruteo de acá es una lista explícita, no un comodín. Lo mismo
// que pasó con /api/portfolio/rendimiento el 21-sep.
app.get("/api/serie", async (req, res) => {
  const qs = Object.keys(req.query||{}).length ? "?" + new URLSearchParams(req.query).toString() : "";
  return proxyToPython(req, res, "/api/serie" + qs, "GET");
});
// Última señal de sentimiento por ticker (hidratación del dashboard)
app.get("/api/sentimiento",  async (req, res) => proxyToPython(req, res, "/api/sentimiento", "GET"));
app.get("/api/historial",     async (req, res) => {
  const qs = Object.keys(req.query||{}).length ? "?" + new URLSearchParams(req.query).toString() : "";
  return proxyToPython(req, res, "/api/historial" + qs, "GET");
});
// Predicciones LSTM y sentimiento (sidebar del chat)
// Señales detalladas = contenido Pro. Es el endpoint que alimenta lo que el
// front tapaba con `_showPaywallBlur()` — ahora el control está acá, donde no
// se puede saltear con la consola del navegador.
app.get("/api/predicciones", requirePro, async (req, res) => proxyToPython(req, res, "/api/predicciones", "GET"));
// Market data y accuracy para el dashboard del chatbot
app.get("/api/market",        async (req, res) => proxyToPython(req, res, "/api/market",       "GET"));
app.get("/api/accuracy",      async (req, res) => proxyToPython(req, res, "/api/accuracy",     "GET"));
// Admin panel → Python
app.get("/api/admin/resources",  async (req, res) => proxyToPython(req, res, "/api/admin/resources", "GET"));
app.get("/api/admin/check",      async (req, res) => proxyToPython(req, res, "/api/admin/check",    "GET"));
app.get("/api/admin/users",      async (req, res) => proxyToPython(req, res, "/api/admin/users",    "GET"));
app.get("/api/admin/admins",     async (req, res) => proxyToPython(req, res, "/api/admin/admins",   "GET"));
app.post("/api/admin/ban",       async (req, res) => proxyToPython(req, res, "/api/admin/ban",      "POST", req.body));
app.post("/api/admin/add-admin", async (req, res) => proxyToPython(req, res, "/api/admin/add-admin","POST", req.body));
app.post("/api/admin/track-user",async (req, res) => proxyToPython(req, res, "/api/admin/track-user","POST", req.body));
// Suscripciones Mercado Pago → Python (el frontend usa /api/subscribe/*)
app.post("/api/subscribe/create", async (req, res) => proxyToPython(req, res, "/api/subscribe/create", "POST", req.body));
app.get("/api/subscribe/status",  async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return proxyToPython(req, res, `/api/subscribe/status${qs ? "?"+qs : ""}`, "GET");
});
app.post("/api/subscribe/webhook",async (req, res) => proxyToPython(req, res, "/api/subscribe/webhook","POST", req.body));
app.post("/api/subscribe/cancel", async (req, res) => proxyToPython(req, res, "/api/subscribe/cancel", "POST", req.body));
// Salud del chatbot Python
app.get("/api/health-python", async (req, res) => proxyToPython(req, res, "/api/health", "GET"));
// Salud del sistema completo (class48 escribe en Redis key miia:health)
app.get("/api/system-health", async (req, res) => {
  try {
    if (redis?.status !== "ready") return res.status(503).json({ ok: false, error: "Redis no disponible" });
    const raw = await redis.get("miia:health");
    if (!raw) return res.status(503).json({ ok: false, error: "Health monitor no disponible aún" });
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// PROXY WEBSOCKET /chat-ws → ws://localhost:5005/ws
// El browser abre wss://localhost:8443/chat-ws
// class30 abre ws://localhost:5005/ws y puentea los mensajes
// ============================================================
const wssChat = new WebSocketServer({ noServer: true });

wssChat.on("connection", (browserWs) => {
  log("chat_ws_proxy_open");
  const pyWs = new WebSocket("ws://localhost:5005/ws");

  pyWs.on("open",    ()    => log("chat_ws_python_open"));
  pyWs.on("message", (data) => {
    if (browserWs.readyState === WebSocket.OPEN)
      browserWs.send(typeof data === "string" ? data : data.toString());
  });
  pyWs.on("close",  ()    => browserWs.terminate());
  pyWs.on("error",  (e)   => log("chat_ws_python_error", { error: e.message }, "warn"));

  browserWs.on("message", (data) => {
    if (pyWs.readyState === WebSocket.OPEN)
      pyWs.send(typeof data === "string" ? data : data.toString());
  });
  browserWs.on("close",  ()    => pyWs.terminate());
  browserWs.on("error",  (e)   => log("chat_ws_browser_error", { error: e.message }, "warn"));
});

// ============================================================
// WEBSOCKET SERVER (general — Redis bridge + señales)
// ============================================================
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

// ── Túnel TCP para WebSocket upgrades ──────────────────────────
// Reenvía un upgrade HTTP a un backend interno (puerto targetPort)
// sin parsear el protocolo WebSocket — transparente para Socket.IO
function tunnelWS(req, socket, head, targetPort) {
  const upstream = net.createConnection({ host: "localhost", port: targetPort });
  upstream.once("connect", () => {
    // Reenviar la petición HTTP Upgrade original
    // Se PISAN los headers de IP que venga poniendo el cliente. class46 confía
    // en `x-forwarded-for` para contar conexiones por IP, y confía porque
    // escucha sólo en localhost — o sea que el único que puede ponérselo es
    // este túnel. Si se reenviara el del cliente, el límite por IP de class46
    // sería tan falsificable como lo era el de acá.
    const OCULTOS = new Set(["host", "x-forwarded-for", "cf-connecting-ip",
                             "x-real-ip", "forwarded"]);
    const hdrs = Object.entries(req.headers)
      .filter(([k]) => !OCULTOS.has(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
      `host: localhost:${targetPort}\r\n` +
      `x-forwarded-for: ${ipReal(req)}\r\n${hdrs}\r\n\r\n`
    );
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error",   () => upstream.destroy());
}

// Distribuir upgrades según la ruta
server.on("upgrade", (req, socket, head) => {
  if (!origenPermitido(req)) {
    log("ws_origen_rechazado", { origen: req.headers.origin, ip: ipReal(req) });
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  // Sesión obligatoria también en los WebSocket: chat, bus y el general.
  if (SESION_OBLIGATORIA && !_usuarioDelPedido(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const url = req.url?.split("?")[0];
  if (url === "/chat-ws") {
    // WS del chatbot Python (puerto 5005)
    wssChat.handleUpgrade(req, socket, head, (ws) => wssChat.emit("connection", ws, req));
  } else if (req.url?.startsWith("/socket.io/")) {
    // WS de Socket.IO dashboard (class46, puerto 3001)
    tunnelWS(req, socket, head, DASH_PORT);
  } else {
    // WS general de class30 (Redis bridge, señales, etc.)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  }
});

// ── Modo módulo, para probar en frío ───────────────────────
// Con `CLASS30_SOLO_MODULO=1` se puede importar este archivo sin abrir el
// puerto 8443, para ejercitar las funciones de seguridad desde
// docs/simulaciones/. En producción la variable no existe. Mismo criterio que
// CLASS43_SOLO_MODULO (ver las notas internas).
if (process.env.CLASS30_SOLO_MODULO !== "1") {
  server.listen(PORT, () => {
    console.log(chalk.green(`🔒 Class30 activo en https://localhost:${PORT}`));
    log("server_start", { port: PORT, python_server: PYTHON_SERVER });
  });
}



wss.on("connection", (ws) => {
  clients.add(ws);

  try {
    ws.send(JSON.stringify({
      type: "hello",
      msg: "Class30 conectado al ecosistema MIIA"
    }));
  } catch {}

  log("ws_connect", { total: clients.size });

  ws.on("close", () => {
    clients.delete(ws);
    log("ws_disconnect", { total: clients.size });
  });

  ws.on("error", (e) => log("ws_error", { error: e.message }));
});

// Tick del panel de flujo: un objeto chico por segundo, publicado a `ui_stream`.
//
// NO usa broadcast() local. El `wss` general de class30 no lo escucha nadie: el
// navegador se conecta a /chat-ws, que este mismo proceso tunelea al WebSocket
// del Python (ver el server.on("upgrade") de arriba). Por eso `clients.size`
// vale 0 aunque la pagina este abierta y con el footer en "WebSocket: ON".
//
// El camino que SI llega al navegador es:
//   class30 → redis(ui_stream) → miia_chatbot.py → ws_manager → /chat-ws
//
// Dos detalles del contrato:
//   · El Python lee `type`, no `tipo` (ver el `elif ch == CH_STREAM`).
//   · `origin:"class30"` hace que este mismo proceso descarte su propio mensaje
//     en el guard anti-eco; el Python no mira ese campo y lo procesa igual.
// El rate-limit de ui_stream es de 100 ms, asi que 1 tick/s no lo roza.
setInterval(() => {
  try {
    redis.publish("ui_stream", JSON.stringify({
      type: "flujo", origin: "class30", ts: Date.now(),
      msgs: _flujo.msgs, feedback_cerrados: _flujo.fb,
      redes: _flujo.redes, senal: _flujo.senal, conf: _flujo.conf,
    }));
  } catch (_) {}
  _flujo.msgs = 0; _flujo.fb = 0;
}, 1000).unref?.();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
      } catch (e) {
        log("broadcast_error", { error: e.message });
      }
    }
  }
}

// =======================
// REDIS ROBUSTO (ANTI ECONNRESET)
// =======================

function createRedisClient(label) {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    reconnectOnError: () => true,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 2000);
      log("redis_retry", { label, attempt: times, delay });
      return delay;
    }
  });

  client.on("connect", () => log("redis_connect", { label }));
  client.on("ready", () => log("redis_ready", { label }));
  client.on("reconnecting", () => log("redis_reconnecting", { label }));
  client.on("close", () => log("redis_closed", { label }));

  client.on("error", (e) => {
    log("redis_error", {
      label,
      error: e && e.message ? e.message : String(e)
    });
  });

  return client;
}

const redis = createRedisClient("publisher");
const redisSub = createRedisClient("subscriber");

// Proteger subscribe automático
async function subscribeChannels() {
  try {
    await redisSub.subscribe(...CHANNELS);
    log("redis_subscribed", { channels: CHANNELS });
    console.log(chalk.cyan(`📡 Escuchando: ${CHANNELS.join(", ")}`));
  } catch (e) {
    log("redis_subscribe_fail", { error: e.message });
    setTimeout(subscribeChannels, 3000);
  }
}

redisSub.on("ready", () => {
  subscribeChannels();
});

// =======================
// BLOQUE: ENVÍO SEMÁNTICO AL MOTOR (class35 / cerebro semántico)
// =======================
const SEMANTIC_INPUT_CH = "miia.input.text";

async function enviarAMotorSemantico(texto, userId = "anonimo") {
  try {
    if (
      /(inversi[oó]n|mercado|riesgo|emocion|contexto|an[aá]lisis|plan|meta)/i.test(
        texto
      )
    ) {
      const semanticEnvelope = {
        id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString("hex"),
        text: texto,
        user_id: userId,
        context: {
          source: "class30",
          type: "semantic_request"
        },
        ts: new Date().toISOString()
      };

      await redis.publish(
        SEMANTIC_INPUT_CH,
        JSON.stringify(semanticEnvelope)
      );

      log("semantic_publish", {
        user: userId,
        preview: texto.slice(0, 80),
      });
    }
  } catch (err) {
    log("semantic_publish_error", { error: err.message });
  }
}

log("semantic_integration_ready", { channel: SEMANTIC_INPUT_CH });

// =======================
// CACHE DE DEDUPE
// =======================
const seen = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [sig, ts] of seen.entries()) {
    if (now - ts > DEDUPE_TTL_MS) {
      seen.delete(sig);
    }
  }
}, 5000).unref();

function signature(channel, dataObj) {
  const stable = JSON.stringify(dataObj);
  return crypto
    .createHash("sha1")
    .update(channel + "|" + stable)
    .digest("hex");
}

// =======================
// COLA HACIA PYTHON (rate-limit + buffer)
// =======================
// TOPE DURO (1-oct-2026). Sin tope, ésta era la fuga de memoria de class30:
// entran ~16.000 decisiones por día y sale una cada BUFFER_INTERVAL_MS (960 por
// día). Ver cola_acotada.js. `CLASS30_PY_QUEUE_MAX` lo cambia sin tocar código.
const PY_QUEUE_MAX = topeDesdeEntorno(process.env.CLASS30_PY_QUEUE_MAX);
const REENVIAR_DECISIONES = process.env.CLASS30_REENVIAR_DECISIONES === "1";
let decisionesNoReenviadas = 0;
const pyQueue = [];
let pyQueueDescartados = 0;
let pyProcessing = false;
let lastPythonSendAt = 0;

function enqueueForPython(payload) {
  const last = pyQueue[pyQueue.length - 1];
  try {
    if (last && JSON.stringify(last) === JSON.stringify(payload)) {
      return;
    }
  } catch {}
  pyQueueDescartados += encolarAcotado(pyQueue, payload, PY_QUEUE_MAX);
  if (!pyProcessing) {
    process.nextTick(() => processPythonQueue());
  }
}

function jitter(ms) {
  const delta = Math.floor(ms * 0.1);
  return ms + Math.floor((Math.random() * 2 - 1) * delta);
}

const pyURL = new URL(PYTHON_SERVER);

function sendToPythonOnce(envelope) {
  return new Promise((resolve) => {
    const now = Date.now();

    // enfriamiento si falló antes
    if (now < pythonCooldownUntil) {
      log("python_skipped_cooldown", {
        until: new Date(pythonCooldownUntil).toISOString(),
      });
      return resolve(false);
    }

    // respetar buffer mínimo entre envíos
    const sinceLast = now - lastPythonSendAt;
    if (sinceLast < BUFFER_INTERVAL_MS) {
      const wait = BUFFER_INTERVAL_MS - sinceLast;
      log("python_buffer_wait", { wait_ms: wait });
      setTimeout(() => resolve(false), wait);
      return;
    }

    const data = JSON.stringify(envelope);
    const client = pyURL.protocol === "https:" ? https : http;

    const options = {
      hostname: pyURL.hostname,
      port: pyURL.port
        ? Number(pyURL.port)
        : pyURL.protocol === "https:"
        ? 443
        : 80,
      path: "/miia/input",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "X-Origin": "class30",
      },
      timeout: 5000,
    };

    const req = client.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        log("python_response", {
          code: res.statusCode,
          response: responseData.slice(0, 400),
        });

        if (res.statusCode >= 200 && res.statusCode < 300) {
          lastPythonSendAt = Date.now();
          pyCooldownMs = PY_INIT_COOLDOWN_MS;
          return resolve(true);
        }

        pythonCooldownUntil = Date.now() + pyCooldownMs;
        pyCooldownMs = Math.min(pyCooldownMs * 2, PY_MAX_COOLDOWN_MS);
        log("python_backoff", {
          cooldown_ms: pyCooldownMs,
          code: res.statusCode,
        });
        resolve(false);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("request_timeout"));
    });

    req.on("error", (err) => {
      log("python_send_error", {
        error: err && (err.message || String(err)),
      });
      pythonCooldownUntil = Date.now() + pyCooldownMs;
      pyCooldownMs = Math.min(pyCooldownMs * 2, PY_MAX_COOLDOWN_MS);
      resolve(false);
    });

    try {
      req.write(data);
    } catch {}

    req.end();
  });
}

async function processPythonQueue() {
  pyProcessing = true;
  try {
    while (pyQueue.length) {
      const data = pyQueue.shift();
      if (!data) break;

      // CORRECCIÓN 2 — construir envelope para python y enviarlo
      const envelope = buildEnvelope({
        source: "class30",
        type: "gateway_forward",
        text:
          typeof data.contenido === "string"
            ? data.contenido
            : typeof data.texto === "string"
            ? data.texto
            : typeof data.text === "string"
            ? data.text
            : JSON.stringify(data),
        data: data,
      });

      // mark that it passed through class30
      envelope.data = envelope.data || {};
      envelope.data.__via_class30 = true;

      const sent = await sendToPythonOnce(envelope);
      if (!sent) {
        // if sending failed, requeue this envelope at the front and stop processing now
        // Sólo si hay lugar: si mientras tanto la cola se llenó, este es el más
        // viejo y es justo el que el tope descarta.
        if (pyQueue.length < PY_QUEUE_MAX) pyQueue.unshift(data);
        else pyQueueDescartados++;
        break;
      }
      // small jittered delay could be added if desired, but original logic uses buffer interval
    }
  } catch (err) {
    log("process_python_queue_error", { error: err && err.message ? err.message : String(err) });
  } finally {
    pyProcessing = false;
  }
}

// =======================
// PROCESAR MENSAJES REDIS
// =======================
redisSub.on("message", (channel, message) => {
  try {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      data = { raw: String(message) };
    }

    // evitar loops eco
    if (data && (data.origin === "class30" || data.__via_class30 === true)) {
      log("skip_echo", { channel });
      return;
    }

    // ── Instrumentación del panel de flujo ──────────────────────────────
    // Estos canales se CUENTAN y se cortan acá: no siguen al broadcast.
    // Formas reales de los payloads:
    //   class23 → { fuente, data:{ metrics:{ ema, supervised } } }
    //   class24 → { fuente, data:{ ema, red:"mercado|64" } }
    if (FLUJO_CHANNELS.has(channel)) {
      try {
        if (channel === "class24_feedback") {
          _flujo.fb++;
        } else {
          _flujo.msgs++;
          const d   = (data && data.data) || {};
          const ema = (d.metrics && d.metrics.ema) ?? d.ema;
          const sup = (d.metrics && d.metrics.supervised) ?? d.supervised ?? 0;
          const key = (data && data.fuente) || String(d.red || "").split("|")[0];
          if (key && ema != null) _flujo.redes[key] = { ema: +ema, sup: +sup };
        }
      } catch (_) {}
      return;
    }
    // class25a_output SÍ sigue al broadcast normal; solo le espiamos la señal.
    if (channel === "class25a_output" && data) {
      const s = data.senal     ?? (data.data && data.data.senal);
      const c = data.confianza ?? (data.data && data.data.confianza);
      if (s) _flujo.senal = String(s);
      if (c != null) _flujo.conf = +c;
    }

    // rate-limit UI stream
    if (channel === "ui_stream") {
      const now = Date.now();
      if (now - lastUiStreamSentAt < UI_STREAM_MIN_GAP_MS) {
        return;
      }
      lastUiStreamSentAt = now;
    }

    const sig = signature(channel, data);
    if (seen.has(sig)) {
      log("dedupe_drop", { channel });
      return;
    }
    seen.set(sig, Date.now());

    const evento = {
      ts: Date.now(),
      source: channel,
      data,
    };

    log("redis_event", { channel });

    // broadcast normalized envelope to websocket clients
    try {
      const broadcastEnv = buildEnvelope({
        source: "class30",
        type: "brain_update",
        text: typeof data.text === "string" ? data.text : "",
        data: evento,
      });
      broadcast(broadcastEnv);
    } catch (e) {
      log("broadcast_error", { error: e && e.message ? e.message : String(e) });
    }

    // CORRECCIÓN 4 — NO REENVÍES TODO A PYTHON: require contract with type & text
    if (!data.type || !data.text) {
      log("skip_noncontract_message", { reason: "missing_type_or_text" });
      return;
    }

    // Las decisiones de class25A no viajan al Python (1-oct-2026): class25B las
    // descarta siempre del otro lado. Ver `esDecisionInterna` en cola_acotada.js.
    // `CLASS30_REENVIAR_DECISIONES=1` vuelve al comportamiento anterior.
    if (!REENVIAR_DECISIONES && esDecisionInterna(channel, data)) {
      decisionesNoReenviadas++;
      return;
    }

    // prepare envelope/data for python queue
    const dataWithFlags = Object.assign({}, data, { __via_class30: true });
    const payloadEnvelope = buildEnvelope({
      source: "class30",
      type: data.type || "event",
      text: data.text,
      data: dataWithFlags,
    });

    enqueueForPython(payloadEnvelope);

    // enviar texto relevante al motor semántico (contract)
    if (typeof data.text === "string") {
      enviarAMotorSemantico(data.text, data.user || data.userId || "anonimo");
    }
  } catch (e) {
    log("redis_message_error", { channel, error: e && e.message ? e.message : String(e) });
  }
});

// =======================
// WATCHDOG / HEALTHCHECK
// =======================
setInterval(() => {
  log("health_check", {
    uptime: process.uptime(),
    redis: redis.status,
    connected: redis.status === "ready",
    clients: clients.size,
    seen_cache: seen.size,
    python_cooldown_ms: Math.max(0, pythonCooldownUntil - Date.now()),
    python_server: PYTHON_SERVER,
    queue_len: pyQueue.length,
    queue_max: PY_QUEUE_MAX,
    queue_descartados: pyQueueDescartados,
    decisiones_no_reenviadas: decisionesNoReenviadas,
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    buffer_interval_ms: BUFFER_INTERVAL_MS,
  });
}, 20000).unref();

// =======================
// CIERRE LIMPIO
// =======================
process.on("SIGINT", async () => {
  log("shutdown", {});
  try {
    redis.disconnect();
    redisSub.disconnect();
  } catch {}

  for (const ws of clients) {
    try {
      ws.close();
    } catch {}
  }

  server.close(() => process.exit(0));
});

process.on("uncaughtException", (err) => {
  log("uncaughtException", { error: err && err.message ? err.message : String(err) });
});

process.on("unhandledRejection", (reason) => {
  log("unhandledRejection", { error: String(reason) });
});