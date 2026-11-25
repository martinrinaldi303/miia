// ============================================================
// class9.js — Gestor de Historial y Resumen de Precios v2.0
// ============================================================
// ROL: Consolida precios históricos por símbolo y genera un
//      score numérico agregado, combinando con pronóstico
//      (class40), riesgo (class41), noticias (class1) y
//      estado sectorial en vivo (class7).
//      TODO el output es float 0-1, nunca strings de texto.
//
// ENTRADAS:
//   class40_output  — pronóstico híbrido
//   class41_output  — riesgo
//   class1_output   — noticias relevantes (AGREGADO)
//   class7_outlets   — estado sectorial (legacy, ya existía)
//   class7_output   — estado sectorial (AGREGADO, canal principal)
//
// SALIDA: class10_ingest — vector numérico
// ============================================================

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { INSTRUMENTOS } from "./universo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LOG_DIR = path.resolve(__dirname, "../operador/aprendizaje/logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "class9.log");

function log(msg, level = "INFO") {
  const line = `[${new Date().toISOString()}] [class9/${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

function logErrorToFile(tag, err) {
  log(`${tag}: ${err?.message || err}`, "ERROR");
}

// ── Config Redis ─────────────────────────────────────────────
const redisConfig = {
  url: "redis://localhost:6379",
  // Entradas (ya existían 40/41/sectorChannel, AGREGAMOS class1 y class7_output)
  inputChannel:  "class40_output",
  inputChannel1: "class41_output",
  sectorChannel: "class7_outlets",   // legacy
  newsChannel:   "class1_output",    // AGREGADO
  marketChannel: "class7_output",    // AGREGADO — canal principal de class7
  // Salidas
  outputChannel: "class9_output",
  exportChannel: "class10_ingest",
};

const redisClient = createClient({ url: redisConfig.url });  // solo subscribe
const redisPub    = createClient({ url: redisConfig.url });  // solo publish

// ── Estado: historial de símbolos + últimas señales externas ──
const class9 = {
  historial: {},        // { symbol: [{price, ts}, ...] }
  historialSector: {},  // { sector: [{change, ts}, ...] }

  registrarPrecio(symbol, price, ts = Date.now()) {
    if (!this.historial[symbol]) this.historial[symbol] = [];
    this.historial[symbol].push({ price: Number(price), ts });
    if (this.historial[symbol].length > 50) this.historial[symbol].shift();
  },

  registrarSector(sector, change, ts = Date.now()) {
    if (!this.historialSector[sector]) this.historialSector[sector] = [];
    this.historialSector[sector].push({ change: Number(change), ts });
    if (this.historialSector[sector].length > 20) this.historialSector[sector].shift();
  },

  /**
   * getResumen — devuelve resumen NUMÉRICO por símbolo.
   * Cada símbolo tiene: precio_actual, score (0-1), volatilidad (0-1).
   * Ya no son objetos de texto — son floats listos para class10.cs.
   */
  getResumen() {
    const resumen = {};
    for (const [symbol, serie] of Object.entries(this.historial)) {
      if (serie.length === 0) continue;
      const precios = serie.map(s => s.price);
      const actual  = precios[precios.length - 1];
      const inicial = precios[0];
      const cambio_pct = inicial !== 0 ? (actual - inicial) / inicial : 0;

      // Score normalizado: -10% a +10% de cambio mapeado a 0-1
      const score = clamp01(0.5 + cambio_pct * 5);

      // Volatilidad: desviación estándar normalizada
      const media = precios.reduce((a,b)=>a+b,0) / precios.length;
      const varianza = precios.reduce((a,b)=>a+(b-media)**2,0) / precios.length;
      const volatilidad = clamp01(Math.sqrt(varianza) / (media || 1) * 10);

      resumen[symbol] = {
        precio_actual: actual,
        cambio_pct:    Number(cambio_pct.toFixed(4)),
        score,            // float 0-1
        volatilidad,      // float 0-1
        muestras:      serie.length,
      };
    }
    return resumen;
  },
};

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

// ── Señales externas acumuladas (para enriquecer el resumen) ──
const señalesExternas = {
  pronostico: null,  // class40
  riesgo:     null,  // class41
  noticia:    null,  // class1
  mercado:    null,  // class7
};

function normalizarPronostico40(data) {
  if (!data?.Ensemble?.Predictions?.length) return { score: 0.5, confianza: 0.3 };
  const preds = data.Ensemble.Predictions;
  const delta = (preds.at(-1).Value - preds[0].Value) / (Math.abs(preds[0].Value) || 1);
  return { score: clamp01(0.5 + delta * 2), confianza: 0.6 };
}

function normalizarRiesgo41(data) {
  if (!data?.RiskMetrics) return { riesgo: 0.5 };
  return { riesgo: clamp01(data.RiskMetrics.RiskScore ?? data.RiskMetrics.ProbDown ?? 0.5) };
}

function normalizarMercado7(data) {
  if (!data?.sectors) return { riesgoGlobal: 0.5 };
  return { riesgoGlobal: clamp01(data.riesgoGlobal, 0.5) };
}

// ── Generar escenario combinando precios + señales externas ──
function generarEscenarioFinanciero(channel) {
  const resumen = class9.getResumen();
  // Permitir generar escenario aunque no haya símbolos individuales, si hay datos de mercado
  const tieneResumen = Object.keys(resumen).length > 0;
  const tieneMercado = señalesExternas.mercado != null;
  if (!tieneResumen && !tieneMercado) return null;

  const p40 = normalizarPronostico40(señalesExternas.pronostico);
  const r41 = normalizarRiesgo41(señalesExternas.riesgo);
  const m7  = normalizarMercado7(señalesExternas.mercado);

  // Score de símbolos: si hay historial real, usarlo; si no, derivar del riesgo global
  let scorePromedioSymbols;
  if (tieneResumen) {
    const scores = Object.values(resumen).map(r => r.score);
    scorePromedioSymbols = scores.reduce((a,b)=>a+b,0) / scores.length;
  } else {
    // Fallback: si el riesgo global es bajo, el mercado está bien (score alto)
    scorePromedioSymbols = 1 - m7.riesgoGlobal;
  }

  // Score final: si solo hay datos de mercado, basarlo principalmente en riesgo global
  const score_final = tieneResumen
    ? clamp01(
        scorePromedioSymbols * 0.5 +
        p40.score * 0.25 +
        (1 - r41.riesgo) * 0.15 +
        (1 - m7.riesgoGlobal) * 0.10
      )
    : clamp01(
        (1 - m7.riesgoGlobal) * 0.70 +   // peso principal: inverso del riesgo
        p40.score * 0.20 +
        (1 - r41.riesgo) * 0.10
      );

  // También calcular score por sector y enriquecer resumen con datos sectoriales
  const sectorResumen = {};
  const sectors = señalesExternas.mercado?.sectors || [];
  if (Array.isArray(sectors)) {
    for (const s of sectors) {
      const t = s.etf || s.sector;
      if (!t) continue;
      const chg  = parseFloat(s.change ?? 0);
      const rsk  = parseFloat(s.riesgo ?? (chg < -0.02 ? 0.65 : chg > 0.02 ? 0.35 : 0.5));
      sectorResumen[t] = {
        precio_actual: s.precio ?? null,
        cambio_pct:    chg,
        score:         clamp01(0.5 + chg * 5),
        volatilidad:   Math.abs(chg),
        riesgo:        rsk,
        sector:        s.sector || t,
      };
    }
  }

  const finalResumen = tieneResumen ? resumen : sectorResumen;

  const confianza = clamp01(
    0.4 + (Object.keys(finalResumen).length / 20) * 0.3 + p40.confianza * 0.3
  );

  return {
    score: score_final,
    confianza,
    probabilidad: score_final,
    channel_origin: channel,
    symbols:  finalResumen,    // sector-enriched cuando no hay precio individual
    sectores: class9.historialSector,
    contexto_externo: {
      pronostico_score: p40.score,
      riesgo_mercado:   r41.riesgo,
      riesgo_global:    m7.riesgoGlobal,
    },
  };
}

// ── Publicación DEBOUNCED del escenario ──────────────────────
// Antes class9 publicaba en CADA mensaje entrante → ~150 publicaciones/seg y
// un bucle de retroalimentación con los motores C# (class9 → class10_ingest →
// vectorial → class40/41_output → class9 → ...). class6, su gemelo, ya usaba
// debounce y publicaba 2/seg; acá se replica el mismo patrón + dedup.
let _debounceTimer = null;
let _ultimoChannel = null;
let _ultimoHash    = null;

function programarEscenario() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    try {
      const escenario = generarEscenarioFinanciero(_ultimoChannel);
      if (!escenario) return;

      // Dedup: firma estable (sin ts/id). Si el escenario no cambió respecto
      // del último publicado, no re-emitir → corta el ciclo cuando las
      // entradas se repiten sin novedad real.
      const firma = JSON.stringify({
        s: escenario.score, c: escenario.confianza,
        p: escenario.probabilidad, sym: escenario.symbols,
      });
      if (firma === _ultimoHash) {
        log("↩️ Escenario sin cambios — no se re-publica (dedup)", "INFO");
        return;
      }
      _ultimoHash = firma;

      const payload = {
        id: crypto.randomUUID(),
        source: "class9",
        type: "financial",
        text: `Resumen financiero: score=${(escenario.score*100).toFixed(1)}% confianza=${(escenario.confianza*100).toFixed(1)}% (${Object.keys(escenario.symbols).length} símbolos)`,
        probabilidad: escenario.probabilidad,
        confianza:    escenario.confianza,
        score:        escenario.score,
        data: escenario,
        ts: new Date().toISOString(),
      };

      try {
        await redisPub.publish(redisConfig.outputChannel, JSON.stringify(payload));
        log(`📤 JSON publicado en ${redisConfig.outputChannel}`, "INFO");
      } catch (outErr) { logErrorToFile("RedisPublishOutput", outErr); }

      // La serie de precios para class40 (26-sep-2026). Ver publicarIngestPronostico.
      await publicarIngestPronostico();

      try {
        await redisPub.publish(redisConfig.exportChannel, JSON.stringify(payload));
        log(`📤 JSON publicado en ${redisConfig.exportChannel}`, "INFO");
        log(`✅ ESCENARIO CONFIRMADO [class9]: score=${(escenario.score*100).toFixed(1)}% ` +
            `confianza=${(escenario.confianza*100).toFixed(1)}% ` +
            `símbolos=${Object.keys(escenario.symbols).length} ` +
            `[pronóstico=${señalesExternas.pronostico?'✓':'✗'} riesgo=${señalesExternas.riesgo?'✓':'✗'} ` +
            `noticia=${señalesExternas.noticia?'✓':'✗'} mercado=${señalesExternas.mercado?'✓':'✗'}]`);
      } catch (expErr) { logErrorToFile("RedisPublishExport", expErr); }
    } catch (e) {
      logErrorToFile("programarEscenario", e);
    }
  }, 2000);   // agrupar señales que llegan casi juntas (igual que class6)
}

// ── Manejador de mensajes Redis ──────────────────────────────
// Solo ACTUALIZA el estado con cada mensaje; publicar va debounced.
async function manejarMensajeRedis(raw, channel) {
  try {
    const data = JSON.parse(raw);
    if (data?.source === "class9") return; // anti-loop directo

    if (channel === redisConfig.inputChannel) {
      señalesExternas.pronostico = data;
      log(`📥 class40_output recibido`);
    } else if (channel === redisConfig.inputChannel1) {
      señalesExternas.riesgo = data;
      log(`📥 class41_output recibido: riskLevel=${data.RiskMetrics?.RiskLevel || "?"}`);
    } else if (channel === redisConfig.newsChannel) {
      señalesExternas.noticia = data;
      log(`📥 class1_output recibido: "${(data.texto||data.text||"").slice(0,60)}"`);
    } else if (channel === redisConfig.marketChannel || channel === redisConfig.sectorChannel) {
      señalesExternas.mercado = data;
      // Registrar precios/sectores en historial
      if (Array.isArray(data.sectors)) {
        for (const s of data.sectors) {
          if (s.sector) class9.registrarSector(s.sector, s.change ?? 0);
          if (s.etf && s.precio != null) class9.registrarPrecio(s.etf, s.precio);
        }
      }
      log(`📥 ${channel} recibido: ${data.sectors?.length || 0} sectores`);
    }

    _ultimoChannel = channel;
    programarEscenario();   // debounced: publica UNA vez tras 2s de calma
  } catch (e) {
    logErrorToFile("manejarMensajeRedis", e);
  }
}

// ── Arranque ───────────────────────────────────────────────
const SOLO_MODULO_9 = process.env.CLASS9_SOLO_MODULO === "1";
if (!SOLO_MODULO_9) (async () => {
  try {
    await redisClient.connect();
    await redisPub.connect();

    await redisClient.subscribe(redisConfig.inputChannel,
      (msg) => manejarMensajeRedis(msg, redisConfig.inputChannel));
    await redisClient.subscribe(redisConfig.inputChannel1,
      (msg) => manejarMensajeRedis(msg, redisConfig.inputChannel1));
    await redisClient.subscribe(redisConfig.sectorChannel,
      (msg) => manejarMensajeRedis(msg, redisConfig.sectorChannel));
    await redisClient.subscribe(redisConfig.newsChannel,
      (msg) => manejarMensajeRedis(msg, redisConfig.newsChannel));
    await redisClient.subscribe(redisConfig.marketChannel,
      (msg) => manejarMensajeRedis(msg, redisConfig.marketChannel));

    log(`📡 Suscrito a: ${redisConfig.inputChannel}`, "INFO");
    log(`📡 Suscrito a: ${redisConfig.inputChannel1}`, "INFO");
    log(`📡 Suscrito a: ${redisConfig.sectorChannel}`, "INFO");
    log(`📡 Suscrito a: ${redisConfig.newsChannel}`, "INFO");
    log(`📡 Suscrito a: ${redisConfig.marketChannel}`, "INFO");
    log(`🚀 Canal de salida interno: ${redisConfig.outputChannel}`, "INFO");
    log(`🔁 Canal de exportación a class10: ${redisConfig.exportChannel}`, "INFO");
    log("✅ class9 v2.0 — Gestor de Precios (numérico) iniciado");
  } catch (e) {
    log(`❌ Error conectando a Redis: ${e.message}`, "ERROR");
  }
})();

// Hooks de prueba en frío. Nada del sistema importa estos símbolos —los módulos
// se hablan sólo por Redis—, así que exportarlos no crea acoplamiento.
export const _test9 = {
  class9,
  señalesExternas,
  publicarIngestPronostico: (...a) => publicarIngestPronostico(...a),
  setPub: (fn) => { redisPub.publish = fn; },   // isOpen es getter-only y no se consulta
  cfg: () => ({ C40_ACTIVO, C40_MIN_PUNTOS, C40_HORIZONTE, C40_THROTTLE_MS }),
  resetThrottle: () => { _c40Ultima = 0; },
};

// ── Serie de precios para class40 (26-sep-2026) ──────────────
// POR QUÉ ACÁ: class40.cs espera `{ticker, sector, horizonDays, series:[{ts,
// close}]}` y estaba suscrito a `class25_output`, que lleva DECISIONES, no una
// serie. Por eso nunca produjo nada: no es que no arrancara, es que parseaba un
// mensaje que no existe en ese canal.
//
// class9 ya mantiene exactamente esa serie (`historial`, 50 puntos por símbolo)
// para su propio resumen, así que no hace falta estado nuevo en ningún lado.
//
// ⚠️ APAGADO POR DEFECTO. Con CLASS40_ACTIVO sin definir no se publica nada y el
// comportamiento de class9 es idéntico al de antes, byte por byte.
const C40_ACTIVO    = process.env.CLASS40_ACTIVO === "1";
const C40_MIN_PUNTOS = Number(process.env.CLASS40_MIN_PUNTOS || 8);
const C40_HORIZONTE  = Number(process.env.CLASS40_HORIZONTE_DIAS || 5);
const C40_THROTTLE_MS = Number(process.env.CLASS40_THROTTLE_MS || 60_000);

const SECTOR_DE = Object.fromEntries(
  (INSTRUMENTOS || []).map(i => [i.ticker, i.sector || ""])
);
let _c40Ultima = 0;

async function publicarIngestPronostico() {
  if (!C40_ACTIVO) return;
  const ahora = Date.now();
  // class9 publica cada vez que llega un class7_output. Sin throttle serían 50
  // mensajes por ciclo de precios; class40 no necesita esa frecuencia.
  if (ahora - _c40Ultima < C40_THROTTLE_MS) return;

  let enviados = 0;
  for (const [symbol, serie] of Object.entries(class9.historial)) {
    // Sin puntos suficientes un pronóstico es ruido con forma de número.
    if (!Array.isArray(serie) || serie.length < C40_MIN_PUNTOS) continue;
    const msg = {
      ticker:      symbol,
      sector:      SECTOR_DE[symbol] || "",
      horizonDays: C40_HORIZONTE,
      // class40 lee `close` y `ts`; class9 los guarda como `price` y `ts`.
      series: serie.map(pt => ({
        ts:    new Date(Number(pt.ts) || Date.now()).toISOString(),
        close: Number(pt.price),
      })).filter(pt => Number.isFinite(pt.close)),
      source: "class9",
      ts: new Date().toISOString(),
    };
    if (msg.series.length < C40_MIN_PUNTOS) continue;
    try {
      await redisPub.publish("class40_ingest", JSON.stringify(msg));
      enviados++;
    } catch (e) { logErrorToFile("RedisPublishC40Ingest", e); }
  }
  if (enviados) {
    _c40Ultima = ahora;
    log(`📤 class40_ingest: ${enviados} series de precios`, "INFO");
  }
}

// ── publishSystemEvent (compat) ─────────────────────────────
const SYSTEM_CHANNELS = { LOG: "system.log", ERROR: "system.error", METRICS: "system.metrics" };
export async function publishSystemEvent(redis, type, payload, source = "unknown") {
  if (!SYSTEM_CHANNELS[type]) return;
  const envelope = { ts: new Date().toISOString(), source, type, payload };
  try { await redis.publish(SYSTEM_CHANNELS[type], JSON.stringify(envelope)); }
  catch (err) { log(`publishSystemEvent error: ${err.message}`, "ERROR"); }
}

export default class9;

process.on("SIGINT",  async () => { await redisClient.quit(); await redisPub.quit(); process.exit(0); });
process.on("SIGTERM", async () => { await redisClient.quit(); await redisPub.quit(); process.exit(0); });