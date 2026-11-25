// ============================================================
// class6.js — Motor de Predicción de Hábitos de Consumo v2.0
// ============================================================
// ROL: Genera escenarios de consumo agregados a partir de
//      señales de pronóstico (class40), riesgo (class41),
//      noticias (class1) y mercado (class7).
//      Publica SIEMPRE con campos numéricos float 0-1, nunca
//      strings, para que class10.cs pueda vectorizar sin parsear texto.
//
// ENTRADAS:
//   class40_output — pronóstico híbrido de mercado (ARIMA/SSA/Fourier/LSTM)
//   class41_output — motor de riesgo (probDown, riskScore, volatility)
//   class1_output  — noticias relevantes (texto + score de relevancia)
//   class7_output  — estado sectorial en tiempo real (change, riesgoGlobal)
//
// SALIDA: class10_ingest (vector numérico) + class6_output (log/debug)
//   probabilidad / confianza SIEMPRE como float 0-1, NUNCA string.
// ============================================================

import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";
import ini from "ini";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ─────────────────────────────────────────────────
const CONFIG_DIR = path.resolve(__dirname, "../operador/aprendizaje/config");
const LOG_DIR     = path.resolve(__dirname, "../operador/aprendizaje/logs");
fs.ensureDirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, "class6.log");

function log(msg, level = "INFO") {
  const line = `[${new Date().toISOString()}] [class6/${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const redisConfig = {
  url:            "redis://localhost:6379",
  // ── Entradas: ya escuchaba 40/41, AGREGAMOS class1 y class7 ──
  inputChannel:   "class40_output",   // pronóstico híbrido
  inputChannel2:  "class41_output",   // riesgo
  inputChannel3:  "class1_output",    // noticias (relevancia/contexto)
  inputChannel4:  "class7_output",    // estado sectorial en vivo
  // ── Salidas ──
  outputChannel:  "class6_output",    // log/debug interno
  exportChannel:  "class10_ingest",   // vector numérico → motor vectorial
};

const redisSub = createClient({ url: redisConfig.url });
const redisPub = createClient({ url: redisConfig.url });

redisSub.on("error", (err) => log(`Redis SUB error: ${err.message}`, "ERROR"));
redisPub.on("error", (err) => log(`Redis PUB error: ${err.message}`, "ERROR"));

// ── Estado acumulado de las 4 fuentes (ventana corta) ───────
const estado = {
  pronostico: null,   // último class40_output
  riesgo:     null,   // último class41_output
  noticia:    null,   // última class1_output relevante
  mercado:    null,   // último class7_output (sector_state)
  ultimaActualizacion: {},
};

// ── Helpers de normalización (clamp a 0-1 SIEMPRE) ──────────
function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * normalizarPronostico — extrae confianza/dirección del pronóstico
 * híbrido de class40 (ARIMA/SSA/Fourier/LSTM ensamblados).
 */
function normalizarPronostico(data) {
  if (!data?.Ensemble?.Predictions?.length) return { score: 0.5, confianza: 0.3 };

  const preds = data.Ensemble.Predictions;
  const primero = preds[0];
  const ultimo  = preds[preds.length - 1];

  // Dirección: ¿el valor sube o baja a lo largo del horizonte?
  const delta = (ultimo.Value - primero.Value) / (Math.abs(primero.Value) || 1);
  const score = clamp01(0.5 + delta * 2); // amplificar para sensibilidad

  // Confianza: inversamente proporcional al ancho del intervalo (Upper-Lower)
  const anchoPromedio = preds.reduce((a, p) => a + (p.Upper - p.Lower), 0) / preds.length;
  const anchoRelativo = anchoPromedio / (Math.abs(primero.Value) || 1);
  const confianza = clamp01(1 - anchoRelativo, 0.4);

  return { score, confianza, delta };
}

/**
 * normalizarRiesgo — extrae score de riesgo de class41
 * (probDown, riskScore ya vienen 0-1 desde C#).
 */
function normalizarRiesgo(data) {
  if (!data?.RiskMetrics) return { riesgo: 0.5, confianza: 0.3 };
  const rm = data.RiskMetrics;
  return {
    riesgo:    clamp01(rm.RiskScore ?? rm.ProbDown ?? 0.5),
    probDown:  clamp01(rm.ProbDown, 0.5),
    confianza: 0.7, // class41 siempre da métricas calculadas, confianza fija alta
  };
}

/**
 * normalizarNoticia — convierte relevancia textual de class1
 * en un score 0-1. Si no hay score explícito, usa longitud/keywords
 * como proxy de relevancia (mejor que ignorar la noticia).
 */
function normalizarNoticia(data) {
  if (!data) return { relevancia: 0, presente: false };
  const texto = (data.texto || data.text || "").toLowerCase();
  if (!texto) return { relevancia: 0, presente: false };

  // Si class1 ya incluye un score de relevancia, usarlo directo
  if (typeof data.data?.relevancia === "number")
    return { relevancia: clamp01(data.data.relevancia), presente: true };

  // Proxy simple: keywords de impacto económico
  const keywords = ["crisis", "caída", "recesión", "inflación", "tasas",
                     "quiebra", "default", "devaluación", "shock"];
  const hits = keywords.filter(k => texto.includes(k)).length;
  const relevancia = clamp01(hits / keywords.length * 1.5);
  return { relevancia, presente: true, hits };
}

/**
 * normalizarMercado — usa el sector_state de class7 (riesgoGlobal,
 * change por sector) ya viene numérico, solo lo extraemos.
 */
function normalizarMercado(data) {
  if (!data?.sectors) return { riesgoGlobal: 0.5, cambioPromedio: 0 };
  const riesgoGlobal = clamp01(data.riesgoGlobal, 0.5);
  const cambioPromedio = data.sectors.reduce((a, s) => a + (s.change || 0), 0)
                        / Math.max(1, data.sectors.length);
  return { riesgoGlobal, cambioPromedio };
}

/**
 * generarEscenarioConsumo — combina las 4 fuentes en un escenario
 * de consumo agregado, TODO numérico, sin strings de probabilidad.
 */
function generarEscenarioConsumo() {
  const p = normalizarPronostico(estado.pronostico);
  const r = normalizarRiesgo(estado.riesgo);
  const n = normalizarNoticia(estado.noticia);
  const m = normalizarMercado(estado.mercado);

  // Nivel de consumo proyectado: combinación ponderada
  // (pronóstico de mercado 35%, riesgo invertido 30%, mercado actual 25%, noticias 10%)
  const nivel_consumo = clamp01(
    p.score * 0.35 +
    (1 - r.riesgo) * 0.30 +
    (1 - m.riesgoGlobal) * 0.25 +
    (1 - n.relevancia) * 0.10
  );

  // Confianza del escenario: promedio ponderado de confianzas de cada fuente
  const confianza = clamp01(
    p.confianza * 0.4 + r.confianza * 0.3 + (n.presente ? 0.6 : 0.3) * 0.3
  );

  return {
    nivel_consumo,       // float 0-1 — NUNCA string
    confianza,           // float 0-1
    probabilidad: nivel_consumo,  // alias explícito para class25A
    componentes: {
      pronostico_score:   p.score,
      pronostico_delta:   p.delta ?? 0,
      riesgo_mercado:     r.riesgo,
      riesgo_global:      m.riesgoGlobal,
      cambio_promedio:    m.cambioPromedio,
      relevancia_noticia: n.relevancia,
    },
    fuentes_activas: {
      pronostico: !!estado.pronostico,
      riesgo:     !!estado.riesgo,
      noticia:    !!estado.noticia,
      mercado:    !!estado.mercado,
    },
  };
}

// ── Publicación con contrato (campos numéricos garantizados) ──
async function publishWithContract(payloadCore) {
  if (!redisPub.isOpen) {
    log("Redis no conectado, no se puede publicar.", "WARN");
    return false;
  }

  let contract = null;
  try {
    const contractPath = path.join(CONFIG_DIR, "contract.ini");
    if (fs.existsSync(contractPath)) {
      const raw = await fs.promises.readFile(contractPath, "utf8");
      contract = ini.parse(raw);
    }
  } catch { contract = null; }

  let targetChannel = redisConfig.exportChannel;
  if (contract?.contract?.target_channel) {
    targetChannel = contract.contract.target_channel.trim();
  }

  // Validar que los campos numéricos son REALMENTE números antes de publicar
  const probabilidad = typeof payloadCore.probabilidad === "number"
    ? payloadCore.probabilidad : Number(payloadCore.probabilidad) || 0.5;
  const confianza = typeof payloadCore.confianza === "number"
    ? payloadCore.confianza : Number(payloadCore.confianza) || 0.5;

  const envelope = {
    id:     randomUUID(),
    source: "class6",
    type:   "consumption_forecast",
    text:   `Escenario de consumo: nivel=${(payloadCore.nivel_consumo*100).toFixed(1)}% confianza=${(confianza*100).toFixed(1)}%`,
    // Campos numéricos planos en el nivel superior — class10.cs los lee directo
    probabilidad,
    confianza,
    score:      payloadCore.nivel_consumo,
    data:       payloadCore,
    ts:         new Date().toISOString(),
  };

  try {
    await redisPub.publish(targetChannel, JSON.stringify(envelope));
    log(`📤 Escenario publicado en ${targetChannel} | prob=${probabilidad.toFixed(3)} conf=${confianza.toFixed(3)}`);
    return true;
  } catch (err) {
    log(`Error publicando: ${err.message}`, "ERROR");
    return false;
  }
}

// ── Procesar y publicar escenario cuando hay datos suficientes ──
let debounceTimer = null;
function programarEscenario() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    // Necesitamos al menos 2 de las 4 fuentes para generar un escenario útil
    const fuentesDisponibles = [estado.pronostico, estado.riesgo, estado.noticia, estado.mercado]
      .filter(Boolean).length;

    if (fuentesDisponibles < 2) {
      log(`⏳ Esperando más fuentes (${fuentesDisponibles}/4 disponibles)`, "INFO");
      return;
    }

    const escenario = generarEscenarioConsumo();
    await publishWithContract(escenario);

    // Log explícito del escenario para auditoría (CONFIRMACIÓN EN LOG pedida)
    log(`✅ ESCENARIO CONFIRMADO: consumo=${(escenario.nivel_consumo*100).toFixed(1)}% ` +
        `confianza=${(escenario.confianza*100).toFixed(1)}% ` +
        `fuentes=${fuentesDisponibles}/4 ` +
        `[pronóstico=${estado.pronostico?'✓':'✗'} riesgo=${estado.riesgo?'✓':'✗'} ` +
        `noticia=${estado.noticia?'✓':'✗'} mercado=${estado.mercado?'✓':'✗'}]`);
  }, 2000); // esperar 2s para agrupar señales que llegan casi juntas
}

// ── Handlers por canal ───────────────────────────────────────
function handlePronostico(raw) {
  try {
    const data = JSON.parse(raw);
    estado.pronostico = data;
    estado.ultimaActualizacion.pronostico = Date.now();
    log(`📥 class40_output recibido: ${data.Ticker || data.Sector || "?"}`);
    programarEscenario();
  } catch (e) {
    log(`Error parseando class40_output: ${e.message}`, "WARN");
  }
}

function handleRiesgo(raw) {
  try {
    const data = JSON.parse(raw);
    estado.riesgo = data;
    estado.ultimaActualizacion.riesgo = Date.now();
    log(`📥 class41_output recibido: riskLevel=${data.RiskMetrics?.RiskLevel || "?"}`);
    programarEscenario();
  } catch (e) {
    log(`Error parseando class41_output: ${e.message}`, "WARN");
  }
}

function handleNoticia(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.source === "class6") return; // anti-loop
    estado.noticia = data;
    estado.ultimaActualizacion.noticia = Date.now();
    log(`📥 class1_output recibido: "${(data.texto || data.text || "").slice(0, 60)}"`);
    programarEscenario();
  } catch (e) {
    log(`Error parseando class1_output: ${e.message}`, "WARN");
  }
}

function handleMercado(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.type !== "sector_state") return; // ignorar otros tipos de class7
    estado.mercado = data;
    estado.ultimaActualizacion.mercado = Date.now();
    log(`📥 class7_output recibido: ${data.sectors?.length || 0} sectores, riesgo=${(data.riesgoGlobal*100).toFixed(1)}%`);
    programarEscenario();
  } catch (e) {
    log(`Error parseando class7_output: ${e.message}`, "WARN");
  }
}

// ── Arranque ───────────────────────────────────────────────
(async () => {
  try {
    await redisSub.connect();
    await redisPub.connect();

    await redisSub.subscribe(redisConfig.inputChannel,  handlePronostico);
    await redisSub.subscribe(redisConfig.inputChannel2, handleRiesgo);
    await redisSub.subscribe(redisConfig.inputChannel3, handleNoticia);
    await redisSub.subscribe(redisConfig.inputChannel4, handleMercado);

    log(`📡 Suscrito a: ${redisConfig.inputChannel}, ${redisConfig.inputChannel2}, ` +
        `${redisConfig.inputChannel3}, ${redisConfig.inputChannel4}`);
    log(`🚀 Salida numérica → ${redisConfig.exportChannel}`);
    log("✅ class6 v2.0 — Motor de Consumo (numérico) iniciado");
  } catch (e) {
    log(`❌ Error conectando a Redis: ${e.message}`, "ERROR");
  }
})();

// ── publishSystemEvent (compat) ─────────────────────────────
const SYSTEM_CHANNELS = { LOG: "system.log", ERROR: "system.error", METRICS: "system.metrics" };
export async function publishSystemEvent(redis, type, payload, source = "unknown") {
  if (!SYSTEM_CHANNELS[type]) return;
  const envelope = { ts: new Date().toISOString(), source, type, payload };
  try { await redis.publish(SYSTEM_CHANNELS[type], JSON.stringify(envelope)); }
  catch (err) { log(`publishSystemEvent error: ${err.message}`, "ERROR"); }
}

process.on("SIGINT",  async () => { await redisSub.quit(); await redisPub.quit(); process.exit(0); });
process.on("SIGTERM", async () => { await redisSub.quit(); await redisPub.quit(); process.exit(0); });