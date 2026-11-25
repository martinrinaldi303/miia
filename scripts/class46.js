// ============================================================
// class46.js — Servidor de Dashboard de Predicciones (MIIA v2.0)
//
// Puente Redis → Socket.IO para el dashboard en tiempo real.
// Escucha en HTTP puerto 3001 (sin SSL, localhost only).
//
// Canales Redis que escucha:
//   class44_output  — señales LSTM (PyTorch)
//   class45_output  — sentimiento de noticias
//   class43_output  — métricas de backtesting
//   class25_output  — decisión final de class25A+B
//   class25a_output — decisión cuantitativa
//   class44_estado  — estado del motor LSTM
//   class45_estado  — estado del motor sentimiento
//
// El HTML dashboard.html se sirve via class30 en puerto 8443.
// ============================================================

import http    from "node:http";
import path    from "node:path";
import fs      from "node:fs";
import { fileURLToPath } from "node:url";
import { Server as SocketIO } from "socket.io";
import Redis   from "ioredis";
import jwt     from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Paths ──────────────────────────────────────────────────────
const BASE_DIR = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR = path.join(BASE_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ── Logger ──────────────────────────────────────────────────────
const LOG_FILE = path.join(LOGS_DIR, "class46.log");
function log(msg, nivel = "info") {
  const line = `[${new Date().toISOString()}] [class46/${nivel.toUpperCase()}] ${msg}`;
  console[nivel === "error" ? "error" : nivel === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Config ──────────────────────────────────────────────────────
const REDIS_URL  = process.env.REDIS_URL  || "redis://localhost:6379";
const DASH_PORT  = Number(process.env.DASH_PORT || 3001);

// ══ CONTROL DE ACCESO DEL BUS (21-sep-2026) ═════════════════════
//
// Hasta hoy este servidor **no tenía autenticación de ningún tipo**, y class30
// lo tunelea en `https://miiaia.com/socket.io/`: se capturaron 241 KB en un
// minuto con `curl`, sin token, con 16 canales adentro — la decisión final, el
// LSTM y los vectores internos de class18.
//
// Escucha sólo en localhost, pero eso no protege nada mientras class30 lo
// exponga: la única defensa real es esta.
const JWT_SECRET = (process.env.JWT_SECRET || "").trim();
const ADMIN_MASTER = (process.env.ADMIN_MASTER_EMAIL || "admin@example.com")
                     .trim().toLowerCase();
if (JWT_SECRET.length < 32) {
  // NO se aborta: class46 no está en CRITICAL_LABELS y morirse acá lo dejaría
  // muerto en silencio hasta el próximo reinicio completo. Se degrada al modo
  // seguro: sin secreto no se puede validar ningún token, así que TODOS los
  // clientes quedan anónimos y sólo ven los canales públicos.
  log("⚠️ JWT_SECRET ausente o menor a 32 caracteres — ningún cliente va a poder " +
      "autenticarse: todos quedan anónimos (sólo canales públicos)", "warn");
}

// ── Niveles por canal, de config/canales_socket.json ─────────────
const NIVELES = { publico: 0, autenticado: 1, admin: 2 };
const ACCESO_RESPALDO = {
  class25_output: "publico",  class44_output: "publico",  class44_estado: "publico",
  class45_estado: "publico",  system_health:  "publico",  class1_output:  "publico",
  class9_output:  "publico",
  class45_output: "autenticado", class43_output: "autenticado",
  class25a_output: "admin",   class18_ingest: "admin",
};
// Subconjunto PUBLICO dentro de un canal que no lo es. class18_ingest lleva
// cuatro flujos: impacto (class11) y regimen (class13), que son las dos
// tarjetas del panel PUBLICO, y portfolio y usuario, que no lo son --
// class14 manda user_id, plan, tolerancia al riesgo y sectores seguidos.
// Cerrar el canal entero (21-sep) apago las dos tarjetas para todos; abrirlo
// entero filtraria los perfiles. El filtro va por `source`, adentro.
const PUBLICO_RESPALDO = { class18_ingest: ["class11", "class13"] };

let ACCESO = ACCESO_RESPALDO;
let PUBLICO_POR_SOURCE = PUBLICO_RESPALDO;
let MAX_CONN_IP = 5, MAX_CONN_MIN = 30;
try {
  const ruta = process.env.MIIA_CANALES_JSON
            || path.join(BASE_DIR, "config", "canales_socket.json");
  const cfg  = JSON.parse(fs.readFileSync(ruta, "utf8"));
  if (cfg.canales && Object.keys(cfg.canales).length) ACCESO = cfg.canales;
  if (cfg.publico_por_source && typeof cfg.publico_por_source === "object")
    PUBLICO_POR_SOURCE = cfg.publico_por_source;
  if (Number(cfg.max_conexiones_por_ip) > 0)          MAX_CONN_IP  = Number(cfg.max_conexiones_por_ip);
  if (Number(cfg.max_conexiones_nuevas_por_minuto)>0) MAX_CONN_MIN = Number(cfg.max_conexiones_nuevas_por_minuto);
  log(`Acceso por canal desde ${ruta}`);
} catch (e) {
  log(`canales_socket.json: ${e.message} — se usa el respaldo interno`, "warn");
}

// Un canal que no figure cae en `admin`. Es el default SEGURO: si mañana
// alguien suma un canal a CANALES y se olvida de este archivo, no se filtra.
function nivelDeCanal(canal) { return ACCESO[canal] || "admin"; }

/** Canales con un subconjunto publico adentro. */
function tieneSubconjuntoPublico(canal) {
  return Array.isArray(PUBLICO_POR_SOURCE[canal]) && PUBLICO_POR_SOURCE[canal].length > 0;
}
/** ¿Este mensaje concreto es de los que cualquiera puede ver? */
function esMensajePublico(canal, data) {
  const lista = PUBLICO_POR_SOURCE[canal];
  if (!Array.isArray(lista)) return false;
  return lista.includes(String(data?.source || ""));
}

/** ¿Qué nivel tiene este cliente? Sin token válido, `publico`. */
function nivelDelHandshake(handshake) {
  const token = handshake?.auth?.token || handshake?.query?.token;
  if (!token || JWT_SECRET.length < 32) return { nivel: "publico", email: null };
  try {
    const u = jwt.verify(String(token), JWT_SECRET);
    const email = String(u?.email || "").trim().toLowerCase();
    return { nivel: email && email === ADMIN_MASTER ? "admin" : "autenticado", email };
  } catch (_) {
    // Token vencido o falso: anónimo, no un rechazo. Cerrar la conexión le
    // rompería la página a un usuario cuyo token simplemente venció.
    return { nivel: "publico", email: null };
  }
}

// Canales que el dashboard necesita visualizar
const CANALES = [
  "class44_output",   // LSTM predicciones
  "class45_output",   // Sentimiento
  "class43_output",   // Backtesting
  "class25_output",   // Decisión final
  "class25a_output",  // Cuantitativo
  "class44_estado",   // Health LSTM
  "class45_estado",   // Health Sentimiento
  "system_health",    // Reporte de salud de class48
  "class9_output",    // Precios históricos + scores por símbolo
  "class18_ingest",   // class11 (impacto) + class13 (régimen de mercado)
  "class1_output",    // Noticias financieras en tiempo real
];

// ── Cache de últimos estados por canal ─────────────────────────
// Permite enviar estado inicial al cliente cuando se conecta
const cache = new Map();
const MAX_HISTORY = 50;  // últimas N entradas por canal
const historial  = new Map();   // canal → [{ data, ts }]

function guardarEnCache(canal, data) {
  cache.set(canal, data);
  if (!historial.has(canal)) historial.set(canal, []);
  const hist = historial.get(canal);
  hist.push({ data, ts: Date.now() });
  if (hist.length > MAX_HISTORY) hist.shift();
}

// ── HTTP Server + Socket.IO ─────────────────────────────────────
const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("MIIA Dashboard Socket.IO OK");
});

const io = new SocketIO(httpServer, {
  cors: {
    // Orígenes permitidos:
    //   8443 → class30 (gateway SSL)
    //   5005 → miia_chatbot.py (acceso directo)
    //   null → archivo abierto localmente (file://)
    // El "*" que había acá anulaba la lista entera: cualquier origen podía
    // conectarse desde un navegador. Se saca. `null` queda para el caso de
    // abrir el HTML como archivo local, que es cómo se depura el panel.
    origin: ["https://miiaia.com", "https://www.miiaia.com",
             "https://localhost:8443", "http://localhost:8443",
             "http://localhost:5005", "null"],
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ["websocket", "polling"],
});

// ── Métricas agregadas ─────────────────────────────────────────
const stats = {
  clients:     0,
  msgRecibidos: 0,
  msgEnviados:  0,
  inicio:       new Date().toISOString(),
};

// ── Socket.IO: eventos de cliente ──────────────────────────────
// ── Límites por IP ─────────────────────────────────────
// El bus emite ~240 KB por minuto. Sin tope, un scraper con veinte conexiones
// multiplica el tráfico de salida y el costo de la VPS.
const _connPorIp = new Map();     // ip → cantidad de sockets vivos
const _nuevasPorIp = new Map();   // ip → [timestamps de la última ventana]

function ipDe(socket) {
  // class30 tunelea desde localhost, así que la IP del socket es siempre
  // 127.0.0.1: la real viene en el header que reenvía el túnel. Es fiable
  // porque este servidor **escucha sólo en localhost** (`listen(PORT,
  // "localhost")`), o sea que el único que puede poner ese header es class30.
  const h = socket.handshake?.headers || {};
  return String(h["x-forwarded-for"] || "").split(",")[0].trim()
      || socket.handshake?.address || "?";
}

io.use((socket, next) => {
  const ip = ipDe(socket);
  const ahora = Date.now();

  const recientes = (_nuevasPorIp.get(ip) || []).filter(t => ahora - t < 60_000);
  if (recientes.length >= MAX_CONN_MIN) {
    log(`⛔ ${ip}: ${recientes.length} conexiones en un minuto — rechazada`, "warn");
    return next(new Error("demasiadas conexiones"));
  }
  recientes.push(ahora);
  _nuevasPorIp.set(ip, recientes);

  if ((_connPorIp.get(ip) || 0) >= MAX_CONN_IP) {
    log(`⛔ ${ip}: ${MAX_CONN_IP} conexiones simultáneas — rechazada`, "warn");
    return next(new Error("demasiadas conexiones simultáneas"));
  }

  const { nivel, email } = nivelDelHandshake(socket.handshake);
  socket.data.nivel = nivel;
  socket.data.email = email;
  socket.data.ip    = ip;
  next();
});

// Limpieza de los mapas de límites: sin esto crecen sin techo, que es el mismo
// defecto que ya se había encontrado en el rate-limit de class30.
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, ts] of _nuevasPorIp) {
    const vivos = ts.filter(t => ahora - t < 60_000);
    if (vivos.length) _nuevasPorIp.set(ip, vivos); else _nuevasPorIp.delete(ip);
  }
  for (const [ip, n] of _connPorIp) if (n <= 0) _connPorIp.delete(ip);
}, 5 * 60_000).unref?.();

// ── Socket.IO: eventos de cliente ────────────────────────
io.on("connection", (socket) => {
  stats.clients++;
  const nivel = socket.data.nivel || "publico";
  const ip    = socket.data.ip || "?";
  _connPorIp.set(ip, (_connPorIp.get(ip) || 0) + 1);

  // El cliente entra a una SALA por cada canal que tiene permitido. Después el
  // broadcast va a la sala del canal, no a todos: el filtro queda en un solo
  // lugar y no puede olvidarse en un emit nuevo.
  const permitidos = CANALES.filter(c => NIVELES[nivel] >= NIVELES[nivelDeCanal(c)]);
  for (const c of permitidos) socket.join(`canal:${c}`);

  // El que NO tiene el canal entero pero el canal tiene subconjunto publico
  // entra a la sala parcial. Nunca a las dos: el emit une salas y duplicaria.
  const parciales = CANALES.filter(c => !permitidos.includes(c) && tieneSubconjuntoPublico(c));
  for (const c of parciales) socket.join(`canal:${c}:pub`);

  log(`Cliente conectado id=${socket.id} nivel=${nivel} ` +
      `canales=${permitidos.length}/${CANALES.length} ip=${ip} total=${stats.clients}`);

  // Que el cliente sepa qué le va a llegar, en vez de ver canales vacíos sin
  // saber por qué. La página puede usarlo para no mostrar paneles muertos.
  socket.emit("acceso", { nivel, canales: permitidos, canales_parciales: parciales });

  // Historial inicial — sólo de los canales permitidos.
  for (const [canal, hist] of historial.entries()) {
    if (hist.length === 0) continue;
    if (permitidos.includes(canal)) {
      socket.emit("historial", { canal, datos: hist.slice(-10) });
    } else if (parciales.includes(canal)) {
      // Sin esto la tarjeta queda en "-" hasta la proxima publicacion real,
      // que para el regimen son varios minutos.
      const vis = hist.filter(h => esMensajePublico(canal, h?.data));
      if (vis.length) socket.emit("historial", { canal, datos: vis.slice(-10) });
    }
  }

  socket.emit("server_stats", stats);

  socket.on("disconnect", () => {
    stats.clients--;
    const n = (_connPorIp.get(ip) || 1) - 1;
    if (n > 0) _connPorIp.set(ip, n); else _connPorIp.delete(ip);
    log(`Cliente desconectado id=${socket.id} total=${stats.clients}`);
  });

  socket.on("ping_dash", () => socket.emit("pong_dash", { ts: Date.now() }));
});

// ── Redis suscripción ──────────────────────────────────────────
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// on("connect") solo para logging — NO llamar subscribe() aquí.
// ioredis re-suscribe automáticamente en cada reconexión; llamar subscribe()
// dentro de on("connect") provoca doble-suscripción → "subscriber mode" error → loop.
redisSub.on("connect", () => log("Redis SUB conectado"));
redisSub.on("error",   e  => log(`Redis: ${e.message}`, "warn"));

// Suscribir una sola vez al arranque
redisSub.subscribe(...CANALES)
  .then(() => log(`Suscrito a: ${CANALES.join(", ")}`))
  .catch(e  => log(`Error subscribiendo: ${e.message}`, "error"));

redisSub.on("message", (canal, msg) => {
  stats.msgRecibidos++;
  let data;
  try { data = JSON.parse(msg); } catch (_) { data = { raw: msg }; }

  guardarEnCache(canal, data);

  // Broadcast SÓLO a la sala del canal: los clientes que no tienen nivel para
  // él no están en la sala. Antes era `io.emit`, o sea todos, sin excepción.
  // Si el mensaje es del subconjunto publico, va tambien a la sala parcial.
  // io.to(a).to(b) es la UNION: un socket en las dos lo recibe una sola vez.
  const sala = esMensajePublico(canal, data)
             ? io.to(`canal:${canal}`).to(`canal:${canal}:pub`)
             : io.to(`canal:${canal}`);
  sala.emit("dato", { canal, data, ts: Date.now() });
  stats.msgEnviados += io.sockets.adapter.rooms.get(`canal:${canal}`)?.size || 0;
});

// ── Stats periódicas ───────────────────────────────────────────
setInterval(() => {
  io.emit("server_stats", stats);
}, 10_000);

// ── Arranque ───────────────────────────────────────────────────
// Si el puerto ya está tomado (otra instancia / proceso huérfano), NO tirar
// abajo el módulo con un 'error' no capturado: loguear y reintentar en 5s.
httpServer.on("error", err => {
  if (err.code === "EADDRINUSE") {
    log(`puerto ${DASH_PORT} ya en uso (¿otra instancia de MIIA?) — reintentando en 5s`, "warn");
    setTimeout(() => {
      try { httpServer.close(); } catch (_) {}
      httpServer.listen(DASH_PORT, "localhost");
    }, 5000);
  } else {
    log(`http server error: ${err.message}`, "error");
  }
});
// ── Modo módulo, para probar en frío ───────────────────────
// `CLASS46_SOLO_MODULO=1` importa sin abrir el puerto ni suscribirse a Redis.
if (process.env.CLASS46_SOLO_MODULO !== "1") {
  httpServer.listen(DASH_PORT, "localhost", () => {
    log(`class46 Dashboard WebSocket escuchando en http://localhost:${DASH_PORT}`);
    log(`Canales Redis: ${CANALES.join(", ")}`);
  });
}

// Sólo para docs/simulaciones/. Nada del sistema las importa.
export const _test = { nivelDelHandshake, nivelDeCanal, NIVELES, ACCESO, CANALES,
                       tieneSubconjuntoPublico, esMensajePublico, PUBLICO_POR_SOURCE };

