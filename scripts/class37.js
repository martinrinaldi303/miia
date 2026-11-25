// class37.js — Central Message Bus (ESM) — Refactor queue-based, resilient, non-blocking
// - Batch processing every 100ms
// - Disk spillover for high-rate sources instead of drops
// - UI priority queue
// - persistToHistory buffer for later SQL ingestion
// - ioredis configured with enableOfflineQueue: true
// NOTE: kept original Redis channels unchanged

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import cors from "cors";
import Redis from "ioredis";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------- Config ---------------------------
const NAME = "class37.bus";
const PORT = +(5010);
const REDIS_URL = "redis://localhost:6379";

const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
const DATA_DIR = path.join(baseDir, "central_bus");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const QUEUE_DIR = path.join(DATA_DIR, "queue");
const METRICS_FILE = path.join(DATA_DIR, "metrics.json");
const ROUTING_FILE = path.join(DATA_DIR, "routing.snapshot.json");
for (const d of [DATA_DIR, LOGS_DIR, QUEUE_DIR]) fs.mkdirSync(d, { recursive: true });

//==========================================================
// CONFIG GLOBAL — class38 integrador (safe)
import { getStorageConfig, getLoggingConfig } from "./class38.js";
const storageCfg = (() => { try { const cfg = getStorageConfig(); return cfg && typeof cfg === "object" ? cfg : {}; } catch { return {}; } })();
const logCfg = (() => { try { const cfg = getLoggingConfig(); return cfg && typeof cfg === "object" ? cfg : {}; } catch { return {}; } })();

// ============================================================
// helpers
export function getPath(key, fallback = "./") {
  try { const val = storageCfg[key]; return typeof val === "string" && val.trim() ? val : fallback; } catch { return fallback; }
}
export function getLogLevel(defaultLevel = "info") {
  try { return logCfg.level || defaultLevel; } catch { return defaultLevel; }
}
export function shouldRotateLogs() {
  try { return logCfg.rotate_logs === true; } catch { return false; }
}

// ============================================================
// Observability channels & publishSystemEvent
const SYSTEM_CHANNELS = { LOG: "system.log", ERROR: "system.error", METRICS: "system.metrics" };

let redisForSystem; // will be redisPub reference
export async function publishSystemEvent(type, payload) {
  if (!SYSTEM_CHANNELS[type]) return;
  const envelope = { ts: new Date().toISOString(), source: "class37_bus", type, payload };
  try {
    if (redisForSystem && typeof redisForSystem.publish === "function") {
      await redisForSystem.publish(SYSTEM_CHANNELS[type], JSON.stringify(envelope));
    }
  } catch (err) {
    console.error("[class37] ❌ Error publicando evento de sistema:", err && err.message ? err.message : String(err));
  }
}

// ============================================================
// Tunables & defaults
const MAX_PAYLOAD_BYTES = 1_000_000; // 1MB
const RATE_WINDOW_MS = 5_000;
const RATE_MAX_PER_WINDOW = 200; // per source (we'll increase thresholds dynamically if needed)
const DEDUP_TTL_MS = 5 * 60_000; // 5 minutes

// Batch processing parameters
const BATCH_INTERVAL_MS = 100; // process queues every 100ms
const BATCH_MAX = 100; // max messages to process per batch (total across queues)

// High threshold mode to reduce drops (increase limits)
const HIGH_RATE_THRESHOLD = RATE_MAX_PER_WINDOW * 4; // when source exceeds this, spill to disk

// Topes DUROS (anti-fuga, 23-oct-2026) — defensa estilo cola_acotada. Sólo muerden bajo
// un backup patológico (Redis lento, bucle); en operación normal las colas están casi vacías.
const QUEUE_HARD_CAP = 50_000;            // normalQueue / highPriorityQueue
const DEDUP_HARD_CAP = 100_000;           // dedupCache, además del TTL de 5 min
const HISTORY_FILE_TTL_MS = 60 * 60_000;  // borrar history_buffer_*.jsonl de más de 1 h (nadie los lee)

// ---------- INPUT CHANNELS (listen) ----------
const INPUT_CHANNELS = [
  "class1_output","class24_output","class23_output","class22_output","class21_output","class5_output","class6_output","class7_output","class8_output","class9_output",
  "class10_ingest","class3_ingest","class14_resolved","class14_resolve","class14_output","class18_ingest",
  "class25_output","class27_output","class28_output","class29_output",
  "ui_stream","miia.input.text","miia.semantic.analysis","miia.semantic.metrics",
  "motor_emocional_state","motor_lenguaje_state","modulo_de_control_estado",
  "class40_output","class41_output","class17_ingest","class15_ingest","class35_output",
];

// ---------- DESTINATIONS (unchanged) ----------
const DEST = {
  cerebroIn:  "class25_ingest",
  cerebroOut: "class25_output",
  textoOut:   "class25_output_texto",
  ui:         "ui_stream",
  FiltroHUP:  "class19_ingest",    // FIX: era "class19_input" → canal correcto
  mercado:    "class10_ingest",    // FIX: faltaba definición → ROUTES lo usaba como undefined
  portafolios:"class17_ingest",    // FIX: era "class17_input"
  usuarios:   "class14_ingest",    // FIX: era "class14_input"
  pred6:      "class6_ingest",
  pred9:      "class9_ingest",
  pred13:     "class13_ingest",
  c21: "class21_ingest",
  c22: "class22_ingest",
  c23: "class23_ingest",
  c24: "class24_ingest",
  c27: "class27_ingest",
  c28: "class28_ingest",
  miia_text_in: "miia.input.text",
  miia_semantic: "miia.semantic.analysis"
};

// Allow/Deny topics
let allowTopics = new Set(["news","pdf","doc","market","portfolio","user","predict","semantic","equivalence","cognitive","signal","event","chat"]);
let denyTopics = new Set([]);

// --------------------------- Logger ---------------------------
function log(line, type = "info") {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${NAME}/${type}] ${line}`;
  console.log(type === "error" ? chalk.red(msg) : type === "warn" ? chalk.yellow(msg) : msg);
  try { fs.appendFileSync(path.join(LOGS_DIR, "bus.log"), msg + "\n"); } catch {}
}

// --------------------------- ioredis clients (enableOfflineQueue true) ---------------------------
const redisOptions = { maxRetriesPerRequest: null, enableOfflineQueue: true };
const redisPub = new Redis(REDIS_URL, redisOptions);
const redisSub = new Redis(REDIS_URL, redisOptions);
redisForSystem = redisPub;

redisPub.on("connect", () => log(`Redis conectado (pub) → ${REDIS_URL}`));
redisSub.on("connect", () => log(`Redis conectado (sub) → ${REDIS_URL}`));
redisPub.on("error", (e) => log(`RedisPub error: ${e && e.message ? e.message : String(e)}`, "error"));
redisSub.on("error", (e) => log(`RedisSub error: ${e && e.message ? e.message : String(e)}`, "error"));

// --------------------------- Métricas ---------------------------
const metrics = {
  startedAt: new Date().toISOString(),
  hostname: os.hostname(),
  inCount: 0,
  outCount: 0,
  dropped: 0,
  dedupHits: 0,
  oversized: 0,
  denied: 0,
  rateLimited: 0,
  backlogWritten: 0,
  backlogDrained: 0,
  last: {}
};
function flushMetrics() {
  metrics.last = { ts: new Date().toISOString() };
  try { fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2), "utf8"); } catch {}
}
setInterval(flushMetrics, 10_000).unref();

// --------------------------- Dedup + Rate ---------------------------
const dedupCache = new Map(); // hash -> ts
const rateMap = new Map(); // source -> {count, windowStart, spillCount}

function gcDedup() {
  const now = Date.now();
  for (const [h, ts] of dedupCache) {
    if (now - ts > DEDUP_TTL_MS) dedupCache.delete(h);
  }
}
setInterval(gcDedup, 30_000).unref();

function shouldRateLimit(source) {
  const now = Date.now();
  const key = source || "unknown";
  let st = rateMap.get(key);
  if (!st) { st = { count: 0, windowStart: now, spillCount: 0 }; rateMap.set(key, st); }
  if (now - st.windowStart > RATE_WINDOW_MS) { st.count = 0; st.windowStart = now; }
  st.count += 1;
  // if extremely high, indicate spill needed
  if (st.count > HIGH_RATE_THRESHOLD) return "spill";
  if (st.count > RATE_MAX_PER_WINDOW) return "throttle";
  return null;
}

// --------------------------- Envelope helpers ---------------------------
function hashPayload(obj) {
  try { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); } catch { return crypto.randomBytes(16).toString("hex"); }
}

function normalizeEnvelope(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(raw); } catch { o = { type: "raw", payload: raw }; }
  }
  const now = new Date().toISOString();
  const guessTopic =
    o.topic ||
    (o.fromUI && "ui") ||
    (o.origen === "interfaz_local" && "ui") ||
    (o.source === "interfaz_local" && "ui") ||
    (o.adapter && "news") ||
    (o.file && "pdf") ||
    (o.market && "market") ||
    (o.portfolio && "portfolio") ||
    (o.user && "user") ||
    (o.analysis && "semantic") ||
    (o.equivalence && "equivalence") ||
    "event";

  const env = {
    id: o.id || uuidv4(),
    ts: o.ts || now,
    traceId: o.traceId || uuidv4(),
    topic: String(guessTopic).toLowerCase(),
    source: String(o.source || o.origen || o.origin || "unknown").toLowerCase(),
    type: String(o.type || "data").toLowerCase(),
    payload: o.payload ?? o.data ?? o,
    meta: {
      channel: o.meta?.channel || null,
      version: o.meta?.version || "1",
      risk: o.meta?.risk ?? null,
      tags: o.meta?.tags || []
    }
  };

  if (o.adapter === "NEWSAPI" && o.data) {
    env.topic = "news";
    env.source = env.source || "class1";
    env.type = "article";
    env.payload = {
      title: o.data.title,
      url: o.data.url,
      snippet: o.data.snippet,
      publishedAt: o.data.publishedAt,
      source: o.data.source
    };
  }

  return env;
}

// Validate basic schema & sizes (does NOT perform rate-limit action)
function validateBasicEnvelope(env) {
  if (!env || typeof env !== "object") return "envelope inválido";
  if (!env.id || !env.ts || !env.traceId) return "faltan campos id/ts/traceId";
  if (!env.topic || !env.source || typeof env.payload === "undefined") return "faltan topic/source/payload";
  if (denyTopics.has(env.topic)) return `topic denegado: ${env.topic}`;
  if (!allowTopics.has(env.topic)) return `topic no permitido: ${env.topic}`;
  const size = Buffer.byteLength(JSON.stringify(env.payload), "utf8");
  if (size > MAX_PAYLOAD_BYTES) { metrics.oversized++; return `payload demasiado grande (${size} bytes)`; }
  return null;
}

// --------------------------- Backlog Disco ---------------------------
async function writeBacklog(env) {
  const file = path.join(QUEUE_DIR, `${Date.now()}_${env.id}.json`);
  try {
    await fsp.writeFile(file, JSON.stringify(env), "utf8");
    metrics.backlogWritten++;
    return true;
  } catch (e) {
    log(`Backlog write error: ${e && e.message ? e.message : String(e)}`, "error");
    return false;
  }
}

async function drainBacklog() {
  try {
    const files = (await fsp.readdir(QUEUE_DIR)).filter(f => f.endsWith(".json")).sort();
    for (const f of files) {
      const fp = path.join(QUEUE_DIR, f);
      const raw = await fsp.readFile(fp, "utf8");
      const env = JSON.parse(raw);
      // push back into normal queue for processing by batch loop
      normalQueue.push(env);
      await fsp.unlink(fp).catch(() => {});
      metrics.backlogDrained++;
    }
    return true;
  } catch (e) {
    log(`Backlog drain error: ${e && e.message ? e.message : String(e)}`, "error");
    return false;
  }
}
setInterval(drainBacklog, 15_000).unref();

// --------------------------- Routing Rules ---------------------------
const ROUTES = [
  { when: { any: true }, to: [DEST.cerebroIn] },
  { when: { topic: "semantic" }, to: [DEST.cerebroIn, DEST.textoOut] },
  { when: { topic: "equivalence" }, to: [DEST.cerebroIn] },
  { when: { topic: "market" }, to: [DEST.cerebroIn, DEST.mercado] },
  { when: { topic: "portfolio" }, to: [DEST.cerebroIn, DEST.portafolios] },
  { when: { topic: "user" }, to: [DEST.cerebroIn, DEST.usuarios] },
  { when: { source: "class6" }, to: [DEST.cerebroIn, DEST.pred6] },
  { when: { source: "class9" }, to: [DEST.cerebroIn, DEST.pred9] },
  { when: { source: "class13" }, to: [DEST.cerebroIn, DEST.pred13] },
  { when: { source: "class21" }, to: [DEST.cerebroIn, DEST.c22, DEST.c23, DEST.c24] },
  { when: { source: "class22" }, to: [DEST.cerebroIn, DEST.c21, DEST.c23] },
  { when: { source: "class23" }, to: [DEST.cerebroIn, DEST.c24] },
  { when: { source: "class24" }, to: [DEST.cerebroIn, DEST.c21] },
  { when: { source: "class27" }, to: [DEST.cerebroIn, DEST.c28] },
  { when: { source: "class28" }, to: [DEST.cerebroIn, DEST.c27] },
  { when: { source: "class25", type: "respuesta_semantica" }, to: [DEST.ui, DEST.textoOut] },
  { when: { source: "interfaz_local" }, to: [DEST.cerebroIn] },
  { when: { topic: "ui" }, to: [DEST.cerebroIn] },
];
try { fs.writeFileSync(ROUTING_FILE, JSON.stringify(ROUTES, null, 2), "utf8"); } catch {}

// Match helper
function matches(env, cond) {
  if (cond.any) return true;
  if (cond.topic && env.topic !== cond.topic) return false;
  if (cond.source && env.source !== cond.source) return false;
  if (cond.type && env.type !== cond.type) return false;
  return true;
}

// --------------------------- Publication helper ---------------------------
async function publishSafe(channel, payload) {
  try {
    await redisPub.publish(channel, JSON.stringify(payload));
    metrics.outCount++;
    return true;
  } catch (e) {
    log(`publishSafe fallo (${channel}): ${e && e.message ? e.message : String(e)}`, "warn");
    return false;
  }
}

// Fanout limiter unchanged (used by publishParallel)
class Limiter {
  constructor(n) { this.n = n; this.cur = 0; this.q = []; }
  _next() {
    if (this.q.length === 0 || this.cur >= this.n) return;
    const { fn, resolve, reject } = this.q.shift();
    this.cur++;
    Promise.resolve()
      .then(fn)
      .then((v) => { this.cur--; resolve(v); this._next(); })
      .catch((e) => { this.cur--; reject(e); this._next(); });
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      this._next();
    });
  }
}
const fanoutLimiter = new Limiter(6);

function prepareForRouting(env) {
  try {
    env.meta = env.meta || {};
    if (!env.meta.bornAt) env.meta.bornAt = Date.now();
    if (!Array.isArray(env.meta.path)) env.meta.path = [];
    env.meta.path.push({ at: new Date().toISOString(), by: NAME, ch: env.meta.channel || null });
    env.meta.hops = (env.meta.hops || 0) + 1;
    const age = Date.now() - Number(env.meta.bornAt);
    if (age > 120_000) return { drop: true, reason: `ttl_expired ${age}ms>120000ms` };
    if (env.meta.hops > 6) return { drop: true, reason: `too_many_hops (${env.meta.hops}>6)` };
    return { drop: false };
  } catch (e) {
    return { drop: true, reason: `prepare_failed:${e && e.message ? e.message : String(e)}` };
  }
}

async function publishParallel(channels, payload) {
  if (!Array.isArray(channels) || channels.length === 0) return true;
  const tasks = channels.map(ch =>
    fanoutLimiter.run(async () => {
      try {
        await redisPub.publish(ch, JSON.stringify(payload));
        return { ch, ok: true };
      } catch (e) {
        return { ch, ok: false, err: e };
      }
    })
  );
  const settled = await Promise.all(tasks);
  const oks = settled.filter(r => r.ok).length;
  const fails = settled.filter(r => !r.ok);
  metrics.outCount += oks;
  if (fails.length) {
    log(`fanout: ${oks}/${channels.length} ok; fallas: ${fails.map(f => f.ch).join(", ")}`, "warn");
  }
  if (oks === 0) {
    await writeBacklog(payload);
    return false;
  }
  return true;
}

// --------------------------- Prioritized internal queues ---------------------------
const highPriorityQueue = []; // UI, heartbeats, system
const normalQueue = [];       // everything else

// --------------------------- Persist-to-history buffer (pre-SQL) ---------------------------
const historyBuffer = [];
const HISTORY_FLUSH_COUNT = 200;
const HISTORY_FLUSH_INTERVAL_MS = 10_000;

export function persistToHistory(env) {
  try {
    historyBuffer.push({ ts: Date.now(), env });
    // non-blocking: flush handled by interval
  } catch (e) {
    log(`persistToHistory error: ${e && e.message ? e.message : String(e)}`, "warn");
  }
}

async function flushHistoryToFile() {
  if (historyBuffer.length === 0) return;
  const toFlush = historyBuffer.splice(0, historyBuffer.length);
  const file = path.join(DATA_DIR, `history_buffer_${Date.now()}.jsonl`);
  try {
    const stream = fs.createWriteStream(file, { flags: "a" });
    for (const item of toFlush) {
      stream.write(JSON.stringify(item) + "\n");
    }
    stream.end();
    // prune: borrar history_buffer_*.jsonl de más de 1 h. Nadie los lee (eran para una
    // ingesta SQL que no existe) y se creaban ~8.640/día → acumulaban inodos y presión de swap.
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(DATA_DIR)) {
        const m = /^history_buffer_(\d+)\.jsonl$/.exec(f);
        if (m && now - Number(m[1]) > HISTORY_FILE_TTL_MS) {
          try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {}
        }
      }
    } catch {}
  } catch (e) {
    log(`flushHistoryToFile error: ${e && e.message ? e.message : String(e)}`, "warn");
    // push back on failure
    historyBuffer.unshift(...toFlush);
  }
}
setInterval(flushHistoryToFile, HISTORY_FLUSH_INTERVAL_MS).unref();

// --------------------------- Dedup+rate-aware enqueue (non-blocking) ---------------------------
function isHighPriority(env) {
  if (!env) return false;
  if (env.topic === "ui") return true;
  if (env.type === "heartbeat" || env.type === "status") return true;
  if (env.meta && env.meta.priority === "high") return true;
  return false;
}

async function enqueueEnvelope(env) {
  try {
    // dedup
    const h = hashPayload({ topic: env.topic, source: env.source, type: env.type, payload: env.payload });
    if (dedupCache.has(h)) { metrics.dedupHits++; return; }
    dedupCache.set(h, Date.now());
    // tope duro además del TTL: descarta la entrada más vieja (orden de inserción) si se desborda
    if (dedupCache.size > DEDUP_HARD_CAP) { const k = dedupCache.keys().next().value; dedupCache.delete(k); }

    // basic validation
    const basicErr = validateBasicEnvelope(env);
    if (basicErr) {
      metrics.dropped++;
      log(`drop (validation): ${basicErr} traceId=${env.traceId}`, "warn");
      return;
    }

    // rate-limit check and spill to disk if needed
    const rl = shouldRateLimit(env.source);
    if (rl === "throttle") {
      // store to disk instead of dropping
      const wrote = await writeBacklog(env);
      if (wrote) {
        log(`Rate-limit: spilled to disk for source ${env.source} traceId=${env.traceId}`, "warn");
        metrics.rateLimited++;
        return;
      } else {
        // if disk write fails, still avoid dropping silently: increment dropped and return
        metrics.dropped++;
        log(`Rate-limit and spill failed, dropping message source=${env.source}`, "error");
        return;
      }
    } else if (rl === "spill") {
      // extremely high rate: immediate disk spill
      const wrote = await writeBacklog(env);
      if (wrote) {
        log(`High burst: immediate spill to disk for ${env.source}`, "warn");
        metrics.rateLimited++;
        return;
      } else {
        metrics.dropped++;
        return;
      }
    }

    // persist minimal to history buffer for later SQL ingestion
    try { persistToHistory({ id: env.id, source: env.source, topic: env.topic, ts: env.ts }); } catch {}

    // enqueue to appropriate internal queue (non-blocking) — con tope duro: si se desborda,
    // descarta lo MÁS VIEJO (el nuevo es más relevante) y lo cuenta en metrics.dropped
    if (isHighPriority(env)) {
      if (highPriorityQueue.length >= QUEUE_HARD_CAP) { highPriorityQueue.shift(); metrics.dropped++; }
      highPriorityQueue.push(env);
    } else {
      if (normalQueue.length >= QUEUE_HARD_CAP) { normalQueue.shift(); metrics.dropped++; }
      normalQueue.push(env);
    }
  } catch (e) {
    log(`enqueueEnvelope error: ${e && e.message ? e.message : String(e)}`, "error");
  }
}

// --------------------------- Batch processor (every 100ms) ---------------------------
async function processBatch() {
  try {
    let batch = [];
    // prioritize highPriorityQueue
    while (batch.length < BATCH_MAX && highPriorityQueue.length > 0) {
      batch.push(highPriorityQueue.shift());
    }
    // then normalQueue until batch full
    while (batch.length < BATCH_MAX && normalQueue.length > 0) {
      batch.push(normalQueue.shift());
    }

    if (batch.length === 0) return; // nothing to do

    // process batch concurrently but limited by fanoutLimiter inside publishParallel
    // For each env, routeEnvelopeV2 (unchanged) - we process sequentially to avoid spikes
    for (const env of batch) {
      try {
        await routeEnvelopeV2(env);
      } catch (e) {
        // If routing failed (e.g., Redis transient), push to disk backlog so we don't lose data
        log(`routeEnvelopeV2 failed for ${env.traceId}: ${e && e.message ? e.message : String(e)} — spilling to disk`, "warn");
        await writeBacklog(env);
      }
    }
  } catch (e) {
    log(`processBatch error: ${e && e.message ? e.message : String(e)}`, "error");
  }
}
setInterval(processBatch, BATCH_INTERVAL_MS).unref();

// --------------------------- routeEnvelopeV2 (reused) ---------------------------
// kept mostly as-is but without dedup/rate (those handled in enqueueEnvelope)
async function routeEnvelopeV2(env, isDraining = false) {
  try {
    const prep = prepareForRouting(env);
    if (prep.drop) {
      metrics.dropped++;
      log(`drop (guard): ${prep.reason} traceId=${env.traceId}`, "warn");
      return true;
    }
    let destinations = [];
    for (const r of ROUTES) {
      if (matches(env, r.when)) destinations.push(...r.to);
    }
    if (destinations.length === 0) destinations = [DEST.cerebroIn];
    const ok = await publishParallel(destinations, env);
    if (!ok && !isDraining) {
      await writeBacklog(env);
      return false;
    }
    return ok;
  } catch (e) {
    log(`routeEnvelopeV2 error: ${e && e.message ? e.message : String(e)}`, "error");
    return false;
  }
}

// --------------------------- Subscriber (push to internal queue) ---------------------------
async function start() {
  try {
    await redisSub.subscribe(...INPUT_CHANNELS);
    log(`📡 ${NAME} suscrito a: ${INPUT_CHANNELS.join(", ")}`);

    redisSub.on("message", async (ch, raw) => {
      try {
        metrics.inCount++;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        const candidate = (parsed && parsed.data) ? parsed.data : parsed;
        const env0 = normalizeEnvelope(candidate);
        env0.meta.channel = ch;

        // Instead of processing immediately, enqueue for batch processing
        await enqueueEnvelope(env0);
      } catch (e) {
        metrics.dropped++;
        log(`parse/enqueue error [${ch}]: ${e && e.message ? e.message : String(e)}`, "warn");
      }
    });

    // heartbeat publisher
    setInterval(async () => {
      try {
        const rssMb = Math.round(process.memoryUsage().rss / 1048576);
        const backlogN = (await fsp.readdir(QUEUE_DIR)).length;
        // instrumentación anti-fuga (23-oct-2026): si rss_mb sube pero las estructuras quedan
        // chatas, el leak es a nivel V8/ioredis y la mitigación es un reinicio liviano programado.
        log(`heartbeat rss=${rssMb}MB qN=${normalQueue.length} qH=${highPriorityQueue.length} ` +
            `dedup=${dedupCache.size} rate=${rateMap.size} histBuf=${historyBuffer.length} backlog=${backlogN} dropped=${metrics.dropped}`);
        const hb = {
          id: uuidv4(),
          ts: new Date().toISOString(),
          traceId: uuidv4(),
          topic: "event",
          source: NAME,
          type: "heartbeat",
          payload: {
            inCount: metrics.inCount,
            outCount: metrics.outCount,
            dropped: metrics.dropped,
            rss_mb: rssMb,
            qNormal: normalQueue.length,
            qHigh: highPriorityQueue.length,
            dedupSize: dedupCache.size,
            rateSize: rateMap.size,
            historyBuf: historyBuffer.length,
            backlog: backlogN,
            allowTopics: Array.from(allowTopics),
            denyTopics: Array.from(denyTopics),
          },
          meta: { version: "1" }
        };
        await publishSafe("class10_heartbeat", hb);
      } catch {}
    }, 15_000).unref();

  } catch (e) {
    log(`start error: ${e && e.message ? e.message : String(e)}`, "error");
    throw e;
  }
}

// --------------------------- HTTP API ---------------------------
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", async (_req, res) => {
  try {
    const backlog = await fsp.readdir(QUEUE_DIR);
    res.json({
      status: "ok",
      ts: new Date().toISOString(),
      host: os.hostname(),
      pid: process.pid,
      redis: REDIS_URL,
      inCount: metrics.inCount,
      outCount: metrics.outCount,
      dropped: metrics.dropped,
      backlog: backlog.length,
      allowTopics: Array.from(allowTopics),
      denyTopics: Array.from(denyTopics),
      channels: INPUT_CHANNELS
    });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/inject", async (req, res) => {
  try {
    const env = normalizeEnvelope(req.body || {});
    const basicErr = validateBasicEnvelope(env);
    if (basicErr) return res.status(400).json({ error: basicErr });
    await enqueueEnvelope(env);
    res.json({ ok: true, traceId: env.traceId });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

app.post("/topics/allow", (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [req.body];
    for (const t of arr) allowTopics.add(String(t).toLowerCase());
    res.json({ ok: true, allowTopics: Array.from(allowTopics) });
  } catch (e) { res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});
app.post("/topics/deny", (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : [req.body];
    for (const t of arr) denyTopics.add(String(t).toLowerCase());
    res.json({ ok: true, denyTopics: Array.from(denyTopics) });
  } catch (e) { res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});
app.post("/topics/reset", (_req, res) => {
  allowTopics = new Set(["news","pdf","doc","market","portfolio","user","predict","semantic","equivalence","cognitive","signal","event","chat"]);
  denyTopics = new Set();
  res.json({ ok: true, allowTopics: Array.from(allowTopics), denyTopics: Array.from(denyTopics) });
});

app.get("/routes", (_req, res) => { res.json(ROUTES); });

app.get("/backlog", async (_req, res) => {
  try {
    const files = (await fsp.readdir(QUEUE_DIR)).filter(f => f.endsWith(".json")).sort().slice(0, 50);
    res.json(files);
  } catch (e) { res.status(500).json({ error: e && e.message ? e.message : String(e) }); }
});

app.post("/backlog/drain", async (_req, res) => {
  const ok = await drainBacklog();
  res.json({ ok });
});

app.get("/metrics", (_req, res) => {
  res.json({ ...metrics, now: new Date().toISOString() });
});

app.listen(PORT, () => log(`🚌 ${NAME} HTTP en http://localhost:${PORT}`));

// --------------------------- Boot ---------------------------
start().catch(e => {
  log(`Fallo al iniciar suscripción: ${e && e.message ? e.message : String(e)}`, "error");
  // Cierre limpio: no process.exit() abrupto — dejar que el proceso termine naturalmente
  // para que Redis pueda cerrar sus conexiones
  setTimeout(() => process.exit(1), 2000);
});

// --------------------------- Exports ---------------------------
export {
  log,
  normalizeEnvelope,
  validateBasicEnvelope as validateEnvelope,
  routeEnvelopeV2,
  drainBacklog,
  writeBacklog,
  publishSafe,
  metrics,
  allowTopics,
  denyTopics,
  
  start
};