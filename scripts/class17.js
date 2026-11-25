// ============================================================
// class17.js — Portfolio Lifecycle Adapter (MIIA v2.0)
// Cambios vs versión anterior:
//   1. REDIS_CLASS25_INGEST definido (antes referenciado pero nunca definido → crash)
//   2. Suscrito a class7_output para actualizar marketState.riesgoGlobal en tiempo real
//   3. riesgoGlobal tomado del payload de class15 (que ahora lo incluye)
//   4. Wait de 5 segundos eliminado — arranca directo
//   5. typo "clase18_ingest" → "class18_ingest" en logs
// ============================================================

import fs     from "fs-extra";
import path   from "path";
import chalk  from "chalk";
import Redis  from "ioredis";
import pino   from "pino";
import { fileURLToPath } from "url";
import { getStorageConfig, getLoggingConfig } from "./class38.js";
import ini    from "ini";
import { v4 as uuidv4 } from "uuid";
import {
  logEvento,
  guardarPortfolio,
  registrarTransaccionPortfolio,
} from "./class42.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir    = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR   = path.join(baseDir, "logs");
const JSON_DIR   = path.join(baseDir, "json_guardados");
const METRICS_DIR= path.join(baseDir, "metrics");

for (const d of [LOGS_DIR, JSON_DIR, METRICS_DIR])
  try { fs.ensureDirSync(d); } catch (_) {}

const HIST_FILE = path.join(JSON_DIR, "historial_portafolios.jsonl");

// ── Redis ──────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Canales de entrada
const REDIS_INPUT          = "class17_ingest";    // portfolios de class15
const REDIS_CLASS25_OUTPUT = "class25_output";    // señales cognitivas de class25
const REDIS_CLASS7_OUTPUT  = "class7_output";     // precios y riesgo de class7

// Canales de salida
const REDIS_CLASS18_INGEST = "class18_ingest";    // → motor vectorial .NET
const REDIS_CLASS17_OUTPUT = "class17_output";    // lifecycle signals
const REDIS_CLASS25_INGEST = "class25_ingest";    // FIX: antes no definido → crash

// ── Config class38 ─────────────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
export function getPath(k, d = "./") { try { const v = storageCfg[k]; return typeof v === "string" && v.trim() ? v : d; } catch { return d; } }
export function getLogLevel(d = "info") { try { return getLoggingConfig()?.level || d; } catch { return d; } }
export function shouldRotateLogs() { try { return getLoggingConfig()?.rotate_logs === true; } catch { return false; } }

// ── Logger ─────────────────────────────────────────────────
const logger = pino({ name: "class17", level: process.env.LOG_LEVEL || "info", base: null });

function logInfo (msg, meta) { try { logger.info(meta||{}, msg); } catch { console.log(chalk.cyan(msg), meta||""); } }
function logWarn (msg, meta) { try { logger.warn(meta||{}, msg); } catch { console.warn(chalk.yellow(msg), meta||""); } }
function logError(msg, meta) { try { logger.error(meta||{}, msg); } catch { console.error(chalk.red(msg), meta||""); } }

// ── Redis clientes ─────────────────────────────────────────
const pub = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);

pub.on("connect", () => logInfo(`🔌 Redis PUB → ${REDIS_URL}`));
sub.on("connect", () => logInfo(`🔌 Redis SUB → ${REDIS_URL}`));
pub.on("error",   e  => logWarn("Redis PUB error", { err: e?.message }));
sub.on("error",   e  => logWarn("Redis SUB error", { err: e?.message }));

// ── Estado de mercado ──────────────────────────────────────
let marketState = {
  riesgoGlobal: 0.5,
  sectores:     []
};

// ── Anti-duplicados ────────────────────────────────────────
const recentPortfolios = new Map();   // id → timestamp (reemplaza Set infinito)
// TTL del dedup: 5 minutos.
// Con Set infinito, cuando class18 (.NET) arranca después de los módulos JS,
// class17 ya había procesado la primera publicación de cada portfolio y
// rechazaba todas las siguientes como duplicados → class18 nunca recibía nada.
// Con TTL corto, class17 re-procesa portfolios cada 5 min → class18 vectoriza.
const DEDUP_TTL_MS = 5 * 60_000;

function isDuplicate(id) {
  if (!id) return false;
  const now  = Date.now();
  const seen = recentPortfolios.get(id);
  if (seen && now - seen < DEDUP_TTL_MS) return true;
  recentPortfolios.set(id, now);
  // Purgar entradas vencidas para no crecer indefinidamente
  if (recentPortfolios.size > 500) {
    for (const [k, ts] of recentPortfolios)
      if (now - ts > DEDUP_TTL_MS) recentPortfolios.delete(k);
  }
  return false;
}

// ── Contract.ini ───────────────────────────────────────────
function loadContract() {
  try {
    const p = path.join(baseDir, "config", "contract.ini");
    if (!fs.existsSync(p)) return null;
    return ini.parse(fs.readFileSync(p, "utf8"));
  } catch (_) { return null; }
}
const CONTRACT = loadContract();

// ── buildContractEnvelope ──────────────────────────────────
export function buildContractEnvelope(type, text, data) {
  return { id: uuidv4(), source: "class17", type, text, data, ts: new Date().toISOString() };
}

// ── Rotar historial ────────────────────────────────────────
async function rotateHistoryIfNeeded() {
  try {
    if (!(await fs.pathExists(HIST_FILE))) return;
    const stats = await fs.stat(HIST_FILE);
    if (stats.size > 20 * 1024 * 1024) {
      const bak = HIST_FILE.replace(".jsonl", `_${Date.now()}.jsonl`);
      await fs.move(HIST_FILE, bak);
      logInfo("History rotated", { bak });
    }
  } catch (_) {}
}

async function appendHistory(entry) {
  try {
    await rotateHistoryIfNeeded();
    const minimal = {
      ts:           new Date().toISOString(),
      portfolio_id: entry.portfolio_id,
      user_id:      entry.user_id,
      status:       entry.status,
      reason:       entry.reason ?? null
    };
    await fs.appendFile(HIST_FILE, JSON.stringify(minimal) + "\n", "utf8");
  } catch (_) {}
}

// ── Helpers ────────────────────────────────────────────────
function safeNum(v, fallback = 0.5) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

// ============================================================
// EVALUAR LIFECYCLE DEL PORTFOLIO
// Ahora usa riesgoGlobal tanto del payload como del marketState
// ============================================================
async function evaluarLifecycle(portfolio) {
  try {
    const details = Array.isArray(portfolio.details) ? portfolio.details : [];

    // Riesgo del portfolio: de los details o del payload de class15
    let avgRisk = 0, nRisk = 0;
    for (const d of details) {
      const r = safeNum(d.riesgo ?? d.risk ?? null, null);
      if (r !== null) { avgRisk += r; nRisk++; }
    }
    avgRisk = nRisk ? avgRisk / nRisk : 0.5;

    // Concentración por sector
    const porSector = {};
    for (const d of details) {
      const sec = (d.sector || "sin_sector").toString();
      porSector[sec] = (porSector[sec] || 0) + (Number(d.peso ?? d.weight ?? 0) || 0);
    }
    const totalPeso    = Object.values(porSector).reduce((a,b) => a + b, 0) || 1;
    const maxConc      = Math.max(...Object.values(porSector).map(v => v / totalPeso), 0);

    // Riesgo global: del payload de class15 (que ahora lo incluye) o del marketState
    const riesgoGlobal    = safeNum(portfolio.riesgoGlobal ?? marketState.riesgoGlobal, 0.5);
    const riesgoAnterior  = safeNum(portfolio.market_risk_prev ?? riesgoGlobal, riesgoGlobal);
    const deltarRiesgo    = riesgoGlobal - riesgoAnterior;

    // Determinar estado
    let status = "stable", reason = null, event_to_publish = null;

    if (maxConc >= 0.6) {
      status           = "needs_rebalance";
      reason           = "sector_concentration";
      event_to_publish = { event: "rebalance_suggested", reason };
    } else if (deltarRiesgo > 0.15) {
      status           = "risk_increased";
      reason           = "market_risk_change";
      event_to_publish = { event: "risk_alert", reason };
    } else if (riesgoGlobal > 0.7) {
      status           = "high_risk";
      reason           = "global_risk_high";
      event_to_publish = { event: "risk_alert", reason };
    }

    const riskLevel  = +(riesgoGlobal * 0.6 + avgRisk * 0.4).toFixed(3);
    const confidence = +(Math.max(0, 1 - (riskLevel * 0.7 + maxConc * 0.3))).toFixed(3);

    return { status, reason, confidence, risk_level: riskLevel, event_to_publish };

  } catch (e) {
    logWarn("evaluarLifecycle error (fallback stable)", { err: e?.message });
    return { status: "stable", reason: null, confidence: 0.5, risk_level: 0.5, event_to_publish: null };
  }
}

// ============================================================
// PROCESAR PORTFOLIO — pipeline principal
// ============================================================
export async function procesarPortafolio(portfolio) {
  if (!portfolio || typeof portfolio !== "object") return;

  const required = ["portfolio_id", "user_id", "assets", "details"];
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(portfolio, k)) {
      logWarn("procesarPortafolio: campo faltante", { missing: k });
      return;
    }
  }

  if (isDuplicate(portfolio.portfolio_id)) {
    logWarn("Duplicado ignorado", { portfolio_id: portfolio.portfolio_id });
    return;
  }

  const evaluation = await evaluarLifecycle(portfolio);
  logInfo(`📊 Lifecycle: ${portfolio.portfolio_id} → ${evaluation.status}`, {
    confidence: evaluation.confidence,
    risk:       evaluation.risk_level
  });

  // ── GUARDAR EN MySQL ──────────────────────────────────────
  // FIX: class17 procesaba portfolios pero no los persistía en DB
  // Ahora guarda en portfolios + portfolio_assets en paralelo
  try {
    await guardarPortfolio({
      portfolio_id:  portfolio.portfolio_id,
      user_id:       portfolio.user_id       ?? "general",
      strategy:      portfolio.strategy      ?? "balanced",
      status:        evaluation.status,
      confidence:    evaluation.confidence,
      risk_level:    evaluation.risk_level,
      riesgo_global: portfolio.riesgoGlobal  ?? marketState.riesgoGlobal,
      n_activos:     (portfolio.assets || []).length,
      assets:        portfolio.assets        ?? [],
      details:       portfolio.details       ?? [],
      market_ts:     portfolio.market_ts     ?? null,
      provider:      portfolio.provider      ?? "unknown",
    });

    // Si hay evento de lifecycle (rebalanceo, alerta riesgo) — registrar transacción
    if (evaluation.event_to_publish) {
      await registrarTransaccionPortfolio({
        portfolio_id: portfolio.portfolio_id,
        user_id:      portfolio.user_id ?? "general",
        tipo:         "lifecycle_event",
        evento:       evaluation.event_to_publish.event,
        razon:        evaluation.event_to_publish.reason,
        status:       evaluation.status,
        confidence:   evaluation.confidence,
        risk_level:   evaluation.risk_level,
        detalle:      { riesgo_global: portfolio.riesgoGlobal, assets: portfolio.assets },
      });
    }
  } catch (dbErr) {
    logWarn("Error guardando portfolio en MySQL (no bloquea pipeline)", {
      err: dbErr?.message, portfolio_id: portfolio.portfolio_id
    });
  }

  // 1. Publicar lifecycle → class17_output
  try {
    const env = buildContractEnvelope("lifecycle",
      `Lifecycle ${portfolio.portfolio_id}`,
      { portfolio_id: portfolio.portfolio_id, user_id: portfolio.user_id, evaluation }
    );
    await pub.publish(REDIS_CLASS17_OUTPUT, JSON.stringify(env));
  } catch (e) { logWarn("class17_output publish error", { err: e?.message }); }

  // 2. Publicar portfolio enriquecido → class18_ingest (motor vectorial .NET)
  try {
    const payload = {
      portfolio_id: portfolio.portfolio_id,
      user_id:      portfolio.user_id,
      strategy:     portfolio.strategy || "balanced",
      confidence:   portfolio.confidence ?? portfolio.confianza ?? evaluation.confidence,
      riesgoGlobal: portfolio.riesgoGlobal ?? marketState.riesgoGlobal,
      evaluation,
      details:      (portfolio.details || []).map(d => ({
        symbol:         d.symbol     ?? null,
        sector:         d.sector     ?? null,
        score:          d.score      != null ? +Number(d.score).toFixed(6)    : null,
        momentum:       d.momentum   != null ? +Number(d.momentum).toFixed(6) : null,
        riesgo:         d.riesgo     != null ? +Number(d.riesgo).toFixed(6)   : null,
        peso:           d.peso       != null ? +Number(d.peso).toFixed(4)     : null,
        precio_entrada: d.precio_entrada ?? null,
        change_pct:     d.change_pct     ?? null,
        estado_sector:  d.estado_sector  ?? null,
        explicacion:    d.explicacion ? String(d.explicacion) : null,
      })),
      portafolio:   portfolio.portafolio ?? portfolio.details ?? [],
      ts:           new Date().toISOString()
    };
    const env = buildContractEnvelope("portfolio_generated",
      `Portfolio ${portfolio.portfolio_id}`, payload);
    await pub.publish(REDIS_CLASS18_INGEST, JSON.stringify(env));
    logInfo(`📤 → ${REDIS_CLASS18_INGEST}`, { portfolio_id: portfolio.portfolio_id });
  } catch (e) { logWarn("class18_ingest publish error", { err: e?.message }); }

  // 3. Publicar señal cognitiva → class25_ingest (FIX: antes sin definir)
  try {
    const env = buildContractEnvelope("cognitive_signal",
      `Cognitive signal ${portfolio.portfolio_id}`,
      { portfolio_id: portfolio.portfolio_id, user_id: portfolio.user_id, evaluation }
    );
    await pub.publish(REDIS_CLASS25_INGEST, JSON.stringify(env));
  } catch (_) {}

  // 4. Si hay evento → publicar a class18_ingest también
  if (evaluation.event_to_publish) {
    try {
      const env = buildContractEnvelope("lifecycle_event",
        `Lifecycle event ${portfolio.portfolio_id}`,
        { portfolio_id: portfolio.portfolio_id, user_id: portfolio.user_id,
          event: evaluation.event_to_publish.event, reason: evaluation.event_to_publish.reason }
      );
      await pub.publish(REDIS_CLASS18_INGEST, JSON.stringify(env));
    } catch (_) {}
  }

  // 5. Persistir en MySQL via class42
  try {
    await logEvento("class17", "portfolio_procesado", {
      portfolio_id: portfolio.portfolio_id,
      user_id:      portfolio.user_id,
      status:       evaluation.status,
      confidence:   evaluation.confidence
    });
  } catch (_) {}

  await appendHistory({
    portfolio_id: portfolio.portfolio_id,
    user_id:      portfolio.user_id,
    status:       evaluation.status,
    reason:       evaluation.reason
  });

  return evaluation;
}

// ============================================================
// INICIO
// ============================================================
(async () => {
  try {
    // FIX: sin espera de 5 segundos — arranca directo
    // FIX: eliminado REDIS_CLASS18_INGEST de la lista de suscripción
    // class17 publica EN class18_ingest → no debe suscribirse a su propio canal de salida
    // Antes: recibía sus propios mensajes y los descartaba con return (desperdicio)
    await sub.subscribe(
      REDIS_INPUT,
      REDIS_CLASS25_OUTPUT,
      REDIS_CLASS7_OUTPUT    // actualiza riesgoGlobal desde class7
    );

    sub.on("message", async (ch, msg) => {
      try {
        if (!msg || msg.length > 500_000) return;
        let data; try { data = JSON.parse(msg); } catch { return; }

        // ── Precios/riesgo de class7 → actualizar marketState ──
        if (ch === REDIS_CLASS7_OUTPUT) {
          if (data?.type === "sector_state") {
            marketState.riesgoGlobal = data.riesgoGlobal ?? marketState.riesgoGlobal;
            marketState.sectores     = data.sectors       ?? marketState.sectores;
          } else if (data?.type === "prices_batch" && data.precios) {
            // precios actualizados — no necesitamos acción especial aquí
          }
          return;
        }

        // ── Señales de class25 ────────────────────────────────
        if (ch === REDIS_CLASS25_OUTPUT) {
          logInfo("Señal de class25_output", { type: data?.type, senal: data?.senal });
          // Si es una decisión de mercado actualizar riesgo de contexto
          if (data?.senal === "SELL" && data?.confianza > 0.7) {
            marketState.riesgoGlobal = Math.min(0.9, marketState.riesgoGlobal + 0.05);
          }
          return;
        }

        // ── Portfolios desde class15 ──────────────────────────
        if (ch === REDIS_INPUT) {
          if (!data || typeof data !== "object") return;

          if (!data.portfolio_id || typeof data.portfolio_id !== "string") return;
          if (!data.user_id      || typeof data.user_id      !== "string") return;
          if (!Array.isArray(data.assets))  return;
          if (!Array.isArray(data.details)) return;

          if (isDuplicate(data.portfolio_id)) return;

          if (data.type === "portfolio_generated") {
            await procesarPortafolio(data);
          }
        }

      } catch (e) {
        logError("Error en message handler", { err: e?.message, ch });
      }
    });

    logInfo(`✅ class17 suscrito a: ${REDIS_INPUT}, ${REDIS_CLASS25_OUTPUT}, ${REDIS_CLASS7_OUTPUT}`);
    logInfo(`📤 Publica en: ${REDIS_CLASS18_INGEST}, ${REDIS_CLASS17_OUTPUT}, ${REDIS_CLASS25_INGEST}`);

    // Heartbeat
    setInterval(async () => {
      try {
        const env = buildContractEnvelope("heartbeat", "class17 heartbeat",
          { riesgoGlobal: marketState.riesgoGlobal, status: "alive" });
        await pub.publish("system.metrics", JSON.stringify(env));
      } catch (_) {}
    }, 30000);

    logInfo(`❤️  class17 operativo | riesgoGlobal=${marketState.riesgoGlobal}`);

  } catch (e) {
    logError("Fatal iniciando class17", { err: e?.message });
    process.exit(1);
  }
})();

// ── publishSystemEvent ────────────────────────────────────
const SYSTEM_CHANNELS = { LOG: "system.log", ERROR: "system.error", METRICS: "system.metrics" };
export async function publishSystemEvent(redisRef, type, payload, source = "unknown") {
  if (!SYSTEM_CHANNELS[type]) return;
  try { await redisRef.publish(SYSTEM_CHANNELS[type], JSON.stringify({ ts: new Date().toISOString(), source, type, payload })); }
  catch (e) { logError("publishSystemEvent", { err: e?.message }); }
}

process.on("uncaughtException",  e => logError("uncaughtException",  { err: e?.message }));
process.on("unhandledRejection", e => logError("unhandledRejection", { err: String(e) }));
process.on("SIGINT",  () => { pub.quit(); sub.quit(); process.exit(0); });
process.on("SIGTERM", () => { pub.quit(); sub.quit(); process.exit(0); });

export default { procesarPortafolio };