// ============================================================
// class19.js — Filtro Vectorial Cognitivo (MIIA v2.0)
// ============================================================
// ROL: Filtro de calidad entre los motores vectoriales y las
//      redes neuronales (class21-24).
//
// FLUJO:
//   class10 (features mercado)  ─┐
//   class18 (features portfolio) ─┼→ class19_ingest
//   class3  (texto documentos)   ─┘         ↓
//                                     [FILTRO class19]
//                                           ↓
//                            class21-24_ingest (redes neuronales C++)
//
// FILTROS APLICADOS:
//   A) Vectores numéricos (class10 / class18):
//      1. Dimensiones activas mínimas (>= MIN_DIMS_ACTIVAS)
//      2. Confianza mínima (>= MIN_CONFIANZA)
//      3. Deduplicación por hash del vector (ventana 60s)
//      4. Rate limit: máx RATE_MAX vectores/minuto hacia las redes
//      5. Coherencia temporal: si el vector cambió poco respecto
//         al anterior del mismo origen, se descarta (mercado quieto)
//
//   B) Texto semántico (class3 / class5):
//      1. Longitud mínima de texto
//      2. Embedding con MiniLM (si disponible)
//      3. Deduplicación por hash de texto
// ============================================================

import fs       from "fs";
import fsp      from "fs/promises";
import path     from "path";
import crypto   from "crypto";
import Redis    from "ioredis";
import { v4 as uuidv4 }  from "uuid";
import { fileURLToPath } from "url";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const OPERATOR_DIR = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR     = path.join(OPERATOR_DIR, "logs");
const METRICS_DIR  = path.join(OPERATOR_DIR, "metrics");
const CONFIG_DIR   = path.join(OPERATOR_DIR, "config");

await Promise.all(
  [LOGS_DIR, METRICS_DIR, CONFIG_DIR]
    .map(d => fsp.mkdir(d, { recursive: true }).catch(() => {}))
);

// ── Config ─────────────────────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
const logCfg     = (() => { try { return getLoggingConfig() || {}; } catch { return {}; } })();

export function getPath(k, f = "./") { try { const v = storageCfg[k]; return typeof v === "string" && v.trim() ? v : f; } catch { return f; } }
export function getLogLevel(d = "info") { try { return logCfg.level || d; } catch { return d; } }
export function shouldRotateLogs()       { try { return logCfg.rotate_logs === true; } catch { return false; } }

// ── Logger ─────────────────────────────────────────────────
const LOG_FILE   = path.join(LOGS_DIR,   "class19.log");
const AUDIT_FILE = path.join(LOGS_DIR,   "class19_audit.log");

// Tope de tamaño del log: evita que un flujo alto de mensajes llene el disco.
// class19 llegó a escribir 135 GB en class19.log. Se chequea el tamaño cada 500
// escrituras (no en cada una, para no hacer statSync en el camino caliente) y se
// vacía el archivo al superar el cap. Simple y a prueba de balas.
const LOG_MAX_BYTES = 30 * 1024 * 1024;   // 30 MB
let _logWrites = 0;
function log(msg, tipo = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class19/${tipo.toUpperCase()}] ${msg}`;
  console[tipo === "error" ? "error" : tipo === "warn" ? "warn" : "log"](line);
  try {
    if ((++_logWrites % 500) === 0) {
      try { if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0); } catch (_) {}
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

async function audit(event, data = {}) {
  try {
    await fsp.appendFile(
      AUDIT_FILE,
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n",
      "utf8"
    );
  } catch (_) {}
}

// ── Redis ──────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: true });
const redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: true });

redisSub.on("connect", () => log("Redis SUB conectado"));
redisPub.on("connect", () => log("Redis PUB conectado"));
redisSub.on("error",   e  => log(`Redis SUB: ${e.message}`, "warn"));
redisPub.on("error",   e  => log(`Redis PUB: ${e.message}`, "warn"));

// ── Canales ────────────────────────────────────────────────
const INPUT_CHANNEL   = "class19_ingest";
const TARGET_CHANNELS = ["class21_ingest","class22_ingest","class23_ingest","class24_ingest"];

// ============================================================
// PARÁMETROS DEL FILTRO
// ============================================================
const FILTRO = {
  // Vector numérico: mínimo de dimensiones con valor significativo (>0.001)
  MIN_DIMS_ACTIVAS:    10,          // de 64 dims, al menos 10 deben ser != 0

  // Vector numérico: confianza mínima (confianza = dims_activas / total_dims)
  MIN_CONFIANZA:       0.15,        // 15% de dims activas como mínimo

  // Deduplicación de vectores: TTL en milisegundos
  DEDUP_TTL_MS:        60_000,      // ignorar vectores idénticos por 60 segundos

  // Rate limit hacia las redes neuronales: máximo por minuto por origen
  RATE_MAX_POR_MINUTO: 10,          // máx 10 vectores/min de la misma fuente

  // ── Cambio mínimo respecto al vector anterior ──────────────────────────
  //
  // ⚠ ORDEN 1: la métrica ahora depende del TIPO de dato. Antes se usaba
  // coseno para todo, y eso mataba sistemáticamente los vectores de mercado.
  //
  // MEDIDO en producción (2026-08-03, class19_audit.log): los vectores de
  // class10_vectorial/mercado caían siempre en la banda 0.005–0.020 contra un
  // umbral de 0.020. Uno fue rechazado con cambio=0.0199726 — por 0.0000274.
  // En 57 h la red `mercado|64` de class24 recibió NUEVE vectores.
  //
  // La razón es geométrica: 1 − cos(v, v+δ) ≈ |δ|²/(2|v|²), así que exigir
  // 0.02 equivale a pedir |δ|/|v| ≥ 0.20 — un cambio del 20% en la DIRECCIÓN
  // del vector. Como el vector está dominado por valores medios (~0.5) que
  // casi no se mueven, un rally del 1% en los 13 sectores genera |δ|/|v| ≈ 0.11.
  // Nunca alcanza. El filtro pensado para "no reenviar con el mercado quieto"
  // terminaba descartando el mercado EN MOVIMIENTO.
  //
  // El coseno mide ÁNGULO y es correcto para embeddings de texto normalizados
  // (de ahí venía el 0.02). Para una serie de precios la magnitud es la señal,
  // no la dirección → se usa el delta máximo por componente.
  MIN_CAMBIO_COSENO:   0.02,        // texto/embeddings: cambio angular ≥ 2%
  // Vectores numéricos: basta con que UNA componente se mueva esto.
  // Escala: NormChange usa 0.1 por punto porcentual, así que 0.002 ≈ 0.02 pp
  // de variación — por encima del ruido de redondeo y por debajo de cualquier
  // movimiento real de mercado.
  MIN_DELTA_NUMERICO:  0.002,

  // Texto: longitud mínima para ser procesado
  MIN_TEXT_LENGTH:     20,
};

// ── Estado interno del filtro ──────────────────────────────
const dedupCache    = new Map(); // hash → timestamp
const rateTracker   = new Map(); // origen → { count, windowStart }
const lastVector    = new Map(); // origen → ultimo vector publicado

// Métricas
const stats = {
  received:          0,
  pasadoRedes:       0,
  rechazadoDims:     0,
  rechazadoConf:     0,
  rechazadoDedup:    0,
  rechazadoRate:     0,
  rechazadoCambio:   0,
  texto:             0,
  errores:           0,
  // ORDEN 1: cuántos vectores pasó cada instrumento. Es la verificación
  // directa del rediseño — si acá hay 13 claves con conteos parejos, el
  // ticker está llegando a las redes. Si está vacío, no.
  porTicker:         {},
};

// ── GC del dedup cache cada 2 min ──────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [h, ts] of dedupCache)
    if (now - ts > FILTRO.DEDUP_TTL_MS) dedupCache.delete(h);
}, 120_000).unref();

// ============================================================
// FUNCIONES MATEMÁTICAS
// ============================================================
function hashVector(vec) {
  // Hash rápido del vector redondeando a 3 decimales
  const rounded = vec.map(v => Math.round(v * 1000) / 1000);
  return crypto.createHash("sha1").update(JSON.stringify(rounded)).digest("hex");
}

function cosineSimilitud(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function dimsActivas(vec) {
  return vec.filter(v => Math.abs(v) > 0.001).length;
}

// Delta máximo por componente. Para vectores numéricos de mercado es la medida
// correcta de "cambió algo": el coseno mide ángulo y en estos vectores el
// ángulo casi no se mueve aunque los precios sí (ver nota en FILTRO).
function deltaMax(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

// ============================================================
// FILTRO A — VECTORES NUMÉRICOS (class10, class18)
// ============================================================
async function filtrarVectorNumerico(msg) {
  const vec = msg.vector;
  if (!Array.isArray(vec) || vec.length === 0) return;

  const origen = msg.source || "desconocido";
  const fuente = msg.fuente || "desconocido"; // "mercado" o "portfolio"

  // ── ORDEN 1: el símbolo del instrumento ────────────────────────────────
  // class10 ahora emite un vector POR TICKER con `symbol` arriba y en data.
  // Sin esto, aguas abajo todo terminaba rotulado "class19" (porque class24
  // leía `symbol` con fallback a `source`) y class43 verificaba cada decisión
  // contra el PROMEDIO del mercado — o sea, 13 instrumentos decorativos y una
  // sola predicción real, con base rate ~78%.
  const symbol = String(
    msg.symbol ?? msg.ticker ?? msg.data?.symbol ?? msg.data?.ticker ?? ""
  ).toUpperCase() || null;

  // Clave de estado: el dedup, el rate-limit y la comparación con el vector
  // anterior tienen que ser POR INSTRUMENTO. Con la clave vieja (solo origen)
  // los 13 tickers del lote compartían un único cupo de 10/min —descartando 3
  // de entrada— y `lastVector` comparaba XLK contra ILF, que no significa nada.
  const clave = symbol ? `${origen}|${symbol}` : origen;

  // ¿Es un vector numérico de mercado? Decide qué métrica de cambio se usa.
  const esNumericoMercado = fuente === "mercado" || symbol !== null;

  // Limpiar valores no numéricos
  const vecClean = vec.map(v => { const n = Number(v); return Number.isFinite(n) ? n : 0; });

  // ── FILTRO 1: Dimensiones activas mínimas ─────────────────
  const activas = dimsActivas(vecClean);
  if (activas < FILTRO.MIN_DIMS_ACTIVAS) {
    stats.rechazadoDims++;
    await audit("rechazado_dims", { origen, fuente, activas, minReq: FILTRO.MIN_DIMS_ACTIVAS });
    return;
  }

  // ── FILTRO 2: Confianza mínima ────────────────────────────
  const confianza = typeof msg.confianza === "number"
    ? msg.confianza
    : activas / vecClean.length;

  if (confianza < FILTRO.MIN_CONFIANZA) {
    stats.rechazadoConf++;
    await audit("rechazado_confianza", { origen, fuente, confianza, minReq: FILTRO.MIN_CONFIANZA });
    return;
  }

  // ── FILTRO 3: Deduplicación ───────────────────────────────
  const hash = hashVector(vecClean);
  const now  = Date.now();
  if (dedupCache.has(hash)) {
    stats.rechazadoDedup++;
    return; // vector idéntico dentro de la ventana de 60s
  }
  dedupCache.set(hash, now);

  // ── FILTRO 4: Rate limit POR INSTRUMENTO ─────────────────
  const rate = rateTracker.get(clave) || { count: 0, windowStart: now };
  if (now - rate.windowStart > 60_000) {
    rate.count = 0; rate.windowStart = now;
  }
  rate.count++;
  rateTracker.set(clave, rate);

  if (rate.count > FILTRO.RATE_MAX_POR_MINUTO) {
    stats.rechazadoRate++;
    return; // demasiados vectores del mismo instrumento en el último minuto
  }

  // ── FILTRO 5: Cambio mínimo respecto al vector anterior ──
  // La métrica depende del tipo de dato (ver la nota larga en FILTRO):
  //   · numérico de mercado → delta máximo por componente
  //   · texto/embeddings    → distancia coseno
  const anterior = lastVector.get(clave);
  if (anterior) {
    let cambio, minReq, metrica;
    if (esNumericoMercado) {
      cambio  = deltaMax(anterior, vecClean);
      minReq  = FILTRO.MIN_DELTA_NUMERICO;
      metrica = "delta_max";
    } else {
      cambio  = 1 - cosineSimilitud(anterior, vecClean);
      minReq  = FILTRO.MIN_CAMBIO_COSENO;
      metrica = "coseno";
    }
    if (cambio < minReq) {
      stats.rechazadoCambio++;
      await audit("rechazado_sin_cambio", { origen, fuente, symbol, metrica, cambio, minReq });
      return; // no cambió lo suficiente para reenviar
    }
  }
  lastVector.set(clave, vecClean);

  // ── Todos los filtros pasados → enviar a redes neuronales ─
  // El símbolo viaja arriba Y dentro de data: class23/class24 lo etiquetan en
  // su salida y class25A agrupa su ventana de 5 s por instrumento. `source`
  // sigue siendo "class19", así que sin el campo `symbol` explícito class24
  // volvería a caer en su fallback y rotularía todo como "class19".
  const envelope = JSON.stringify({
    id:          msg.id || uuidv4(),
    source:      "class19",
    origen,
    fuente,
    ...(symbol ? { symbol, ticker: symbol } : {}),
    type:        "vector",
    vector:      vecClean,          // vector numérico original intacto
    dimension:   vecClean.length,
    dims_activas: activas,
    confianza,
    data:        { ...(msg.data || {}), ...(symbol ? { symbol, ticker: symbol } : {}) },
    ts:          new Date().toISOString(),
  });

  await Promise.all(TARGET_CHANNELS.map(ch => redisPub.publish(ch, envelope)));

  stats.pasadoRedes++;
  if (symbol) stats.porTicker[symbol] = (stats.porTicker[symbol] || 0) + 1;
  log(`✅ Vector [${symbol || fuente}] → redes | dims=${vecClean.length} activas=${activas} conf=${confianza.toFixed(3)}`);
  await audit("vector_pasado_redes", { origen, fuente, symbol, activas, confianza, hash: hash.slice(0, 8) });
}

// ============================================================
// FILTRO B — TEXTO SEMÁNTICO (class3, class5, class2)
// MiniLM solo se carga si hay documentos de texto disponibles
// ============================================================
let embedder = null;
let embedderDisponible = false;

async function cargarEmbedder() {
  try {
    log("⏳ Cargando modelo MiniLM para texto semántico...");
    const { pipeline } = await import("@xenova/transformers");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    embedderDisponible = true;
    log("✅ Modelo embeddings cargado.");
  } catch (e) {
    log(`⚠️  MiniLM no disponible: ${e.message} — texto usará hash vectorial`, "warn");
  }
}

async function textoAVector(text) {
  if (embedderDisponible && embedder) {
    try {
      const out = await embedder(text.slice(0, 512), { pooling: "mean", normalize: true });
      return Array.from(out.data);
    } catch (_) {}
  }
  // Fallback determinístico si MiniLM no está disponible
  const hash = crypto.createHash("sha256").update(text).digest();
  return Array.from({ length: 64 }, (_, i) => (hash[i % 32] / 255) * 2 - 1);
}

const textDedup = new Map(); // hash texto → timestamp

async function filtrarTexto(msg) {
  const text = msg.text || msg.texto || "";
  if (!text || text.trim().length < FILTRO.MIN_TEXT_LENGTH) return;

  // Dedup por hash de texto
  const hashT = crypto.createHash("sha1").update(text).digest("hex");
  const now   = Date.now();
  if (textDedup.has(hashT) && now - textDedup.get(hashT) < 300_000) return; // 5 min
  textDedup.set(hashT, now);

  const vec = await textoAVector(text);
  if (!vec || vec.length === 0) return;

  const envelope = JSON.stringify({
    id:          msg.id || uuidv4(),
    source:      "class19",
    origen:      msg.source || "desconocido",
    fuente:      "documento",
    type:        "vector",
    vector:      vec,
    dimension:   vec.length,
    dims_activas: dimsActivas(vec),
    confianza:   0.5,
    data:        { tipo: "texto_semantico", chars: text.length },
    ts:          new Date().toISOString(),
  });

  await Promise.all(TARGET_CHANNELS.map(ch => redisPub.publish(ch, envelope)));

  stats.texto++;
  stats.pasadoRedes++;
  log(`📄 Texto [${msg.source}] → redes | chars=${text.length}`);
}

// ============================================================
// ROUTER PRINCIPAL
// Clasifica el mensaje y aplica el filtro correcto
// ============================================================
async function procesarMensaje(channel, raw) {
  stats.received++;
  try {
    if (!raw || raw.length > 2_000_000) return;

    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    if (!msg || typeof msg !== "object") return;

    // Detectar si es un vector numérico
    const esVectorNumerico =
      (Array.isArray(msg.vector) && msg.vector.length > 0) ||
      (msg.source || "").endsWith("_vectorial") ||
      msg.fuente === "mercado" ||
      msg.fuente === "portfolio";

    if (esVectorNumerico) {
      await filtrarVectorNumerico(msg);
      return;
    }

    // Detectar si es texto semántico
    const text = msg.text || msg.texto || "";
    if (text.trim().length >= FILTRO.MIN_TEXT_LENGTH) {
      await filtrarTexto(msg);
      return;
    }

  } catch (e) {
    stats.errores++;
    log(`❌ procesarMensaje: ${e.message}`, "error");
  }
}

// ============================================================
// SUSCRIPCIÓN
// ============================================================
await redisSub.subscribe(INPUT_CHANNEL);

redisSub.on("message", async (channel, msg) => {
  if (channel === INPUT_CHANNEL) {
    try { await procesarMensaje(channel, msg); }
    catch (e) { log(`❌ handler: ${e.message}`, "error"); }
  }
});

log("🚀 Filtro vectorial cognitivo iniciado");
log(`Subscrito a ${INPUT_CHANNEL}`);
log(`Escuchando ${INPUT_CHANNEL}`);
log(`Filtros: dims_min=${FILTRO.MIN_DIMS_ACTIVAS} conf_min=${FILTRO.MIN_CONFIANZA} cambio_min=${FILTRO.MIN_CAMBIO_COSENO} rate=${FILTRO.RATE_MAX_POR_MINUTO}/min`);

// ── Heartbeat ──────────────────────────────────────────────
setInterval(async () => {
  const mem = process.memoryUsage().rss / 1024 / 1024;
  log(`[Metrics] Memoria: ${mem.toFixed(2)} MB | Queue: 0 | Buckets: 0`);

  const hb = {
    ts:               Date.now(),
    items:            stats.received,
    pasado_redes:     stats.pasadoRedes,
    rechazado_dims:   stats.rechazadoDims,
    rechazado_conf:   stats.rechazadoConf,
    rechazado_dedup:  stats.rechazadoDedup,
    rechazado_rate:   stats.rechazadoRate,
    rechazado_cambio: stats.rechazadoCambio,
    texto:            stats.texto,
    errores:          stats.errores,
    dedup_cache_size: dedupCache.size,
  };

  await redisPub.publish("ui_stream", JSON.stringify({
    type: "class19_heartbeat",
    data: hb,
  })).catch(() => {});

  log(`❤️  recibidos=${stats.received} → redes=${stats.pasadoRedes} (dims=${stats.rechazadoDims} conf=${stats.rechazadoConf} dedup=${stats.rechazadoDedup} rate=${stats.rechazadoRate} cambio=${stats.rechazadoCambio})`);
}, 30_000);

// ── Guardar métricas en disco ──────────────────────────────
setInterval(async () => {
  try {
    await fsp.writeFile(
      path.join(METRICS_DIR, "class19_stats.json"),
      JSON.stringify({ ts: new Date().toISOString(), filtro: FILTRO, stats }, null, 2),
      "utf8"
    );
  } catch (_) {}
}, 60_000).unref();

// ── Cargar MiniLM en background ────────────────────────────
setTimeout(() => cargarEmbedder(), 3000);

// ── Shutdown ───────────────────────────────────────────────
async function shutdown() {
  log("🛑 Shutdown Class19...");
  try { await redisSub.quit(); } catch (_) {}
  try { await redisPub.quit(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException",  e => log(`uncaughtException: ${e.message}`,  "error"));
process.on("unhandledRejection", e => log(`unhandledRejection: ${String(e)}`, "error"));

export default { stats, FILTRO };