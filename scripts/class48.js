// ============================================================
// class48.js — Monitor de Salud del Sistema MIIA
// ============================================================
// Suscribe a los canales críticos de Redis y rastrea cuándo
// publicó por última vez cada motor. Cada 2 minutos publica
// un reporte de salud a system_health y ui_stream.
//
// Si un canal crítico lleva más de MAX_SILENCIO_MS sin publicar
// se marca como "muerto" y se alerta vía ui_stream.
//
// Canales monitoreados y su frecuencia esperada:
//   class7_output       — cada 60s  (precios de mercado)
//   class44_output      — cada 15min (LSTM)
//   class25_output      — actividad  (decisiones)
//   class25a_output     — actividad  (cuantitativo)
//   class45_output      — actividad  (sentimiento noticias)
//   class43_output      — actividad  (backtesting)
//   class21/22/23/24_output — actividad (redes C++)
//
// Salidas:
//   system_health       — reporte completo (lo lee class46 → dashboard)
//   ui_stream           — heartbeat simplificado
//   miia:health         — Redis hash para /api/system-health (REST)
// ============================================================

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const BASE_DIR   = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR   = path.join(BASE_DIR, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

const LOG_FILE  = path.join(LOGS_DIR, "class48.log");
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

function log(msg, nivel = "info") {
  const line = `[${new Date().toISOString()}] [class48/${nivel.toUpperCase()}] ${msg}`;
  console[nivel === "error" ? "error" : nivel === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Canales a monitorear con su timeout máximo de silencio ──────
const CANALES = [
  // Motor                    Canal                    Silencio máx (ms)
  { motor: "class7",   ch: "class7_output",   maxMs: 15 * 60_000, critico: false },
  { motor: "class44",  ch: "class44_output",  maxMs: 20 * 60_000, critico: true  },
  { motor: "class45",  ch: "class45_output",  maxMs: 90 * 60_000, critico: false },
  { motor: "class25B", ch: "class25_output",  maxMs: 60 * 60_000, critico: true  },
  { motor: "class25A", ch: "class25a_output", maxMs: 60 * 60_000, critico: true  },
  { motor: "class43",  ch: "class43_output",  maxMs:  3 * 3600_000, critico: false },
  { motor: "class21",  ch: "class21_output",  maxMs: 60 * 60_000, critico: false },
  { motor: "class22",  ch: "class22_output",  maxMs: 60 * 60_000, critico: false },
  { motor: "class23",  ch: "class23_output",  maxMs: 60 * 60_000, critico: false },
  { motor: "class24",  ch: "class24_output",  maxMs: 60 * 60_000, critico: false },
];

// ── Estado ────────────────────────────────────────────────────────
const lastSeen   = new Map();   // canal → timestamp ms
const alertedAt  = new Map();   // canal → timestamp último alerta (evita spam)
const ALERT_COOLDOWN_MS = 30 * 60_000;  // no re-alertar por 30 min
const CHECK_INTERVAL_MS =  2 * 60_000;  // evaluar cada 2 min
const inicio = Date.now();

// ── Redis ──────────────────────────────────────────────────────────
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

redisSub.on("connect", () => log("Redis SUB conectado"));
redisPub.on("connect", () => log("Redis PUB conectado"));
redisSub.on("error",   e  => log(`Redis SUB: ${e.message}`, "warn"));
redisPub.on("error",   e  => log(`Redis PUB: ${e.message}`, "warn"));

// Suscribir a todos los canales monitoreados
redisSub.subscribe(...CANALES.map(c => c.ch))
  .then(() => log(`Monitoreando ${CANALES.length} canales`))
  .catch(e  => log(`Error suscribiendo: ${e.message}`, "error"));

redisSub.on("message", (canal, _msg) => {
  lastSeen.set(canal, Date.now());
});

// ── Evaluación de salud ────────────────────────────────────────────
function evaluar() {
  const ahora   = Date.now();
  const uptime  = Math.floor((ahora - inicio) / 60_000);
  const estado  = [];

  for (const def of CANALES) {
    const ts   = lastSeen.get(def.ch);
    const seen = ts != null;
    const secs = seen ? Math.floor((ahora - ts) / 1000) : null;
    const dead = seen ? (ahora - ts) > def.maxMs : uptime > 5; // si pasaron 5min de arranque sin señal

    estado.push({
      motor:     def.motor,
      canal:     def.ch,
      critico:   def.critico,
      ok:        !dead,
      ultimo_ms: ts ?? null,
      silencio_s: secs,
      max_silencio_min: Math.floor(def.maxMs / 60_000),
    });

    if (dead && def.critico) {
      const lastAlert = alertedAt.get(def.ch) || 0;
      if (ahora - lastAlert > ALERT_COOLDOWN_MS) {
        alertedAt.set(def.ch, ahora);
        log(`ALERTA: ${def.motor} silencioso ${secs != null ? secs + "s" : "desde inicio"}`, "warn");
      }
    }
  }

  const todos_ok     = estado.every(e => e.ok);
  const criticos_ok  = estado.filter(e => e.critico).every(e => e.ok);
  const motores_ok   = estado.filter(e => e.ok).length;

  const reporte = {
    ts:           new Date().toISOString(),
    uptime_min:   uptime,
    sistema:      todos_ok ? "ok" : criticos_ok ? "degradado" : "critico",
    motores_ok,
    motores_total: estado.length,
    canales:       estado,
  };

  // Publicar reporte completo
  const msg = JSON.stringify(reporte);
  redisPub.publish("system_health", msg).catch(() => {});
  redisPub.publish("ui_stream", JSON.stringify({
    type:   "health",
    status: reporte.sistema,
    ok:     motores_ok,
    total:  estado.length,
    ts:     reporte.ts,
  })).catch(() => {});

  // Guardar en clave Redis para el endpoint REST
  redisPub.set("miia:health", msg, "EX", 300).catch(() => {});  // TTL 5 min

  const dead = estado.filter(e => !e.ok).map(e => e.motor);
  if (dead.length > 0) {
    log(`Estado: ${motores_ok}/${estado.length} OK | Muertos: ${dead.join(", ")}`, "warn");
  } else {
    log(`Estado: ${motores_ok}/${estado.length} OK | Sistema ${reporte.sistema}`);
  }

  return reporte;
}

// Evaluar periódicamente
setInterval(evaluar, CHECK_INTERVAL_MS);
// Primera evaluación después de 5 min (dejar que los motores arranquen)
setTimeout(evaluar, 5 * 60_000);

log("class48 — Monitor de Salud activo");
log(`Canales: ${CANALES.map(c => c.ch).join(", ")}`);
