import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

// =======================
// COMPATIBILIDAD __dirname (ESM SAFE)
// =======================
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
    if (redisClientRef?.isOpen) {
      await redisClientRef.publish(SYSTEM_CHANNELS[type], JSON.stringify(envelope));
    }
  } catch (err) {
    console.error("[publishSystemEvent] Error publishing", err?.message || err);
  }
}

// =======================
// BASE UNIFICADA DE SALIDA
// =======================
const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR = path.join(baseDir, "logs");
const JSON_DIR = path.join(baseDir, "json_guardados");
const RAW_DIR = path.join(baseDir, "raw");
const METRICS_DIR = path.join(baseDir, "metrics");
const CONFIG_DIR = path.join(baseDir, "config");

for (const dir of [LOGS_DIR, JSON_DIR, RAW_DIR, METRICS_DIR, CONFIG_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[class31] 📁 Directorio verificado: ${dir}`);
  } catch (e) {
    console.error(`[class31] ❌ mkdir ${dir} failed:`, e.message);
  }
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
// VARIABLES GLOBALES
// =======================
const NOMBRE_CLASE = "class31";
const LOG_FILE = path.join(LOGS_DIR, `${NOMBRE_CLASE}.log`);
const DATASET_FILE = path.join(JSON_DIR, "dataset_class31.json");

// =======================
// LOGGER CENTRALIZADO
// =======================
function log(msg, tipo = "info") {
  const ts = new Date().toISOString();
  const color =
    tipo === "error" ? chalk.red :
    tipo === "warn"  ? chalk.yellow :
    chalk.cyan;
  const line = `[${ts}] [${NOMBRE_CLASE}/${tipo}] ${msg}`;
  console.log(color(line));
  try { fs.appendFileSync(LOG_FILE, line + os.EOL); } catch {}
}


// =======================
// CONFIGURACIÓN REDIS
// =======================
const REDIS_URL = "redis://localhost:6379";

// Canales del cerebro distribuido (filtrados por class19)
const CHANNELS = [
  "class21_output", // Procesamiento emocional avanzado
  "class22_output", // Lenguaje y decisiones contextuales
  "class23_output", // Análisis gráfico y visual cognitivo
  "class24_output", // Coordinador de coherencia multimodal
];

// Canal de salida y feedback
const OUTPUT_CHANNEL = "class31_output"; // Dataset consolidado
const FEEDBACK_CHANNEL = "class25_ingest"; // Feedback real al cerebro

// =======================
// VARIABLES DE ESTADO
// =======================
let dataset = [];
let lastMessages = {};
let metrics = {
  totalMsgs: 0,
  msgPerChannel: {},
  coherencia: [],
  estabilidad: [],
  alertas: [],
};

// =======================
// FUNCIONES DE ANÁLISIS
// =======================
function evaluarCoherencia({ mercado, portafolio, emocion }) {
  try {
    const riesgoGlobal = mercado?.riesgoGlobal ?? 0.5;
    const riesgoPort =
      portafolio && portafolio.length
        ? portafolio.map((a) => a.peso || 0).reduce((a, b) => a + b, 0) / portafolio.length
        : 0.5;

    const emociones = Object.values(emocion || {}).filter(v => typeof v === "number");
    const emLevel = emociones.length
      ? emociones.reduce((a, b) => a + b, 0) / emociones.length
      : 0.5;

    const coherencia = 1 - Math.abs(riesgoGlobal - riesgoPort);
    const equilibrio = 1 - Math.abs(coherencia - emLevel);
    return Number(((coherencia + equilibrio) / 2).toFixed(3));
  } catch {
    return 0.5;
  }
}

// =======================
// CONEXIÓN REDIS
// =======================
const client = createClient({ url: REDIS_URL });
const publisher = createClient({ url: REDIS_URL });

client.on("error", (e) => log(`Redis SUB error: ${e.message}`, "error"));
publisher.on("error", (e) => log(`Redis PUB error: ${e.message}`, "error"));

(async () => {
  try {
    await client.connect();
    await publisher.connect();
    log("📡 Conectado a Redis — escuchando canales de datos...");
  } catch (e) {
    log(`❌ Error conectando a Redis: ${e.message}`, "error");
    setTimeout(() => process.exit(1), 5000);
    return;
  }

  // =======================
  // SUBSCRIPCIÓN A CANALES
  // =======================
  for (const ch of CHANNELS) {
    try {
      await client.subscribe(ch, async (msg) => {
        try {
          const data = JSON.parse(msg);
          await processMessage(ch, data);
        } catch {
          await processMessage(ch, { raw: msg });
        }
      });
      log(`📡 Suscrito a canal: ${ch}`);
    } catch (err) {
      log(`⚠️ Error al suscribirse a ${ch}: ${err.message}`, "warn");
    }
  }

  log("✅ CLASS31 (Entrenamiento Guiado) inicializado correctamente.");
})();

// =======================
// PROCESAMIENTO DE MENSAJES
// =======================
export async function processMessage(channel, data) {
  try {
    metrics.totalMsgs++;
    metrics.msgPerChannel[channel] = (metrics.msgPerChannel[channel] || 0) + 1;
    lastMessages[channel] = data;

    // Combinar contexto completo cuando haya info suficiente
    if (
      lastMessages.class21_output &&
      lastMessages.class22_output &&
      lastMessages.class23_output &&
      lastMessages.class24_output
    ) {
      const combo = {
        timestamp: new Date().toISOString(),
        emocional: lastMessages.class21_output,
        lenguaje: lastMessages.class22_output,
        grafico: lastMessages.class23_output,
        coherente: lastMessages.class24_output,
      };

      // Análisis de coherencia emocional / contextual
      const emocion = combo.emocional?.emocion || {};
      const coherencia = evaluarCoherencia({
        mercado: combo.grafico,
        portafolio: combo.coherente?.portafolio || [],
        emocion,
      });

      metrics.coherencia.push(coherencia);
      if (metrics.coherencia.length > 100) metrics.coherencia.shift();

      const record = { ...combo, coherencia };
      dataset.push(record);
      // Cap en memoria: `dataset` crecía sin techo. El archivo ya estaba
      // acotado por el slice(-1000) del guardado, pero el array no.
      if (dataset.length > 1000) dataset.splice(0, dataset.length - 1000);
      log(`🧠 Interacción analizada (coherencia=${coherencia})`);
      guardarDataset(record);

      // Publicar dataset consolidado como envelope en OUTPUT_CHANNEL
      try {
        if (publisher?.isOpen) {
          const datasetEnvelope = {
            id: randomUUID(),
            source: "class31",
            type: "analysis",
            text: "Registro de entrenamiento guiado",
            data: record,
            ts: new Date().toISOString(),
          };
          await publisher.publish(OUTPUT_CHANNEL, JSON.stringify(datasetEnvelope));
        }
      } catch (e) {
        log(`⚠️ Error publicando dataset envelope: ${e.message}`, "warn");
      }

      await enviarFeedback(record);

      // ── BARRERA: consumir el lote ────────────────────────────────────
      // Sin esto, la condición de arriba queda VERDADERA PARA SIEMPRE apenas
      // los cuatro canales publican una vez. A partir de ahí, cada mensaje de
      // CUALQUIERA de los 4 disparaba el bloque entero: evaluarCoherencia,
      // escritura a disco y dos publish. No eran "3 mensajes repetidos" — era
      // el pipeline completo corriendo por cada mensaje que llegaba.
      //
      // Con ORDEN 1 publicando por instrumento, el caudal de class21-24 se
      // multiplicó por 13 y el desperdicio con él: 29 % → 54,6 % de CPU, el
      // mayor consumidor del servidor, trabajando para que class25B descarte
      // el resultado por el filtro `type !== "human_query"`.
      //
      // Al vaciar el buffer, el próximo combo exige cuatro mensajes NUEVOS.
      lastMessages = {};
    }
  } catch (e) {
    log(`❌ Error en processMessage: ${e.message}`, "error");
  }
}

// =======================
// GUARDAR DATASET LOCAL
// =======================
let _datasetCorruptoAvisado = false;

// Carga inicial: UNA lectura al arrancar, en vez de una por mensaje.
// `dataset` pasa a ser la fuente de verdad en memoria y el archivo, su reflejo.
try {
  if (fs.existsSync(DATASET_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATASET_FILE, "utf-8"));
    if (Array.isArray(parsed)) dataset = parsed.slice(-1000);
  }
} catch (_) {
  log("⚠️ dataset_class31.json corrupto — se regenera desde cero", "warn");
  _datasetCorruptoAvisado = true;
}

// ── Guardado diferido ────────────────────────────────────────────────
// ANTES: cada llamada hacía readFileSync + JSON.parse + JSON.stringify CON
// indentación + writeFileSync sobre ~1000 registros (~2 MB), de forma síncrona
// y bloqueando el event loop. Se llamaba en cada mensaje de class21-24.
// Con el caudal por instrumento de ORDEN 1, esa función sola explica la mayor
// parte del 54,6 % de CPU que consumía este módulo.
//
// AHORA: el registro ya está en `dataset` (memoria); acá solo se marca que hay
// cambios y un flush periódico escribe. Sin lectura, sin indentación, y dos
// escrituras por minuto en vez de miles. El formato del archivo no cambia.
let _datasetSucio = false;

export function guardarDataset(record) {
  if (record) _datasetSucio = true;
}

function flushDataset() {
  if (!_datasetSucio) return;
  try {
    fs.writeFileSync(DATASET_FILE, JSON.stringify(dataset.slice(-1000)), "utf-8");
    _datasetSucio = false;
  } catch (err) {
    log(`❌ Error guardando dataset: ${err.message}`, "error");
  }
}
setInterval(flushDataset, 30_000);
process.on("SIGTERM", flushDataset);
process.on("SIGINT",  flushDataset);

// =======================
// ENVIAR FEEDBACK AL CEREBRO (class25_ingest) — envelope contractual
// =======================
export async function enviarFeedback(record) {
  try {
    if (!publisher?.isOpen) {
      log("Redis publisher not open; skipping enviarFeedback", "warn");
      return;
    }

    const envelope = {
      id: randomUUID(),
      source: "class31",
      type: "metric",
      text: "Aprendizaje guiado multimodal consolidado",
      data: {
        coherencia: record.coherencia,
        emociones: record.emocional?.emocion || {},
        lenguaje: record.lenguaje || {},
        grafico: record.grafico || {},
      },
      ts: new Date().toISOString(),
    };

    await publisher.publish(FEEDBACK_CHANNEL, JSON.stringify(envelope));
    log(`📤 Feedback contractual enviado a class25_ingest`);
  } catch (err) {
    log(`⚠️ Error enviando feedback: ${err.message}`, "warn");
  }
}

// =======================
// MONITOREO DE ESTADO
// =======================
setInterval(() => {
  try {
    const promedioCoherencia =
      metrics.coherencia.length ? metrics.coherencia.reduce((a, b) => a + b, 0) / metrics.coherencia.length : 0;
    const status = {
      ts: new Date().toISOString(),
      total: metrics.totalMsgs,
      promedioCoherencia: promedioCoherencia.toFixed(3),
      canales: metrics.msgPerChannel,
    };
    const metricsPath = path.join(METRICS_DIR, "metrics_class31.json");
    fs.writeFileSync(metricsPath, JSON.stringify(status, null, 2), "utf-8");
    log(`📊 Métricas actualizadas (coherencia promedio=${promedioCoherencia.toFixed(3)})`);
  } catch (e) {
    log(`⚠️ Error actualizando métricas: ${e.message}`, "warn");
  }
}, 30000);

// Exports
export {
  evaluarCoherencia,
 log,
};