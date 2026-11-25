import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { createClient } from "redis";
import { fileURLToPath } from "url";


// ==========================================================
// COMPATIBILIDAD ESM (__dirname / __filename)
// ==========================================================
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
    logError("[publishSystemEvent] Error publishing", { err: err && err.message ? err.message : String(err) });
  }
}

// ==========================================================
// BASE UNIFICADA DE SALIDA
// ==========================================================
const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
const dirs = {
  logs: path.join(baseDir, "logs"),
  json: path.join(baseDir, "json_guardados"),
  raw: path.join(baseDir, "raw"),
  metrics: path.join(baseDir, "metrics"),
  config: path.join(baseDir, "config"),
};

// Crear todas las carpetas necesarias con verificación
for (const d of Object.values(dirs)) {
  try {
    fs.mkdirSync(d, { recursive: true });
    console.log(`[class32] 📁 Directorio verificado: ${d}`);
  } catch (e) {
    console.error(`[class32] ❌ mkdir ${d} failed:`, e.message);
  }
}

const NOMBRE_CLASE = "class32";
const LOG_FILE = path.join(dirs.logs, `${NOMBRE_CLASE}.log`);

// ==========================================================
// LOGGER CENTRALIZADO
// ==========================================================
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
// ==========================================================
// CREAR ARCHIVO JSON BASE PARA LOS DUMPS DE REDIS
// ==========================================================
const DUMP_FILE = path.join(dirs.json, "redis_dump_auto.json");
try {
  if (!fs.existsSync(DUMP_FILE)) {
    fs.writeFileSync(DUMP_FILE, "[]", "utf-8");
    log(`🆕 Archivo base creado: ${DUMP_FILE}`);
  } else {
    log(`✅ Archivo JSON base detectado: ${DUMP_FILE}`);
  }
} catch (err) {
  log(`❌ Error creando archivo JSON base: ${err.message}`, "error");
}

// ==========================================================
// CONFIGURACIÓN REDIS
// ==========================================================
const REDIS_URL = "redis://localhost:6379";
const MAX_MEMORY_BYTES = 50_000_000; // 50 MB
const SAVE_INTERVAL = 60_000; // 60 s

const client = createClient({ url: REDIS_URL });
await client.connect();
log("📡 Conectado a Redis (class32)");

// ==========================================================
// FUNCIÓN PRINCIPAL: CONSOLIDAR MEMORIA
// ==========================================================
async function consolidarMemoria() {
  try {
    const info = await client.info("memory");
    const usedBytes = parseInt(info.match(/used_memory:(\d+)/)?.[1] || "0", 10);
    const usedHuman = info.match(/used_memory_human:(.+)\r?\n/)?.[1]?.trim() || "N/A";
    log(`💾 Redis usa ${usedHuman} (${usedBytes} bytes)`);

    if (usedBytes < MAX_MEMORY_BYTES) return;

    log("⚠️ Redis sobrecargado — descargando a JSON…");

    // Obtener todas las claves
    const keys = await client.keys("*");
    if (!keys.length) {
      log("ℹ️ No hay claves que descargar.");
      return;
    }

    const snapshot = {};
    for (const key of keys) {
      try {
        const val = await client.get(key);
        snapshot[key] = JSON.parse(val);
      } catch {
        snapshot[key] = await client.get(key);
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpFile = path.join(dirs.json, `redis_dump_${ts}.json`);
    fs.writeFileSync(dumpFile, JSON.stringify(snapshot, null, 2), "utf-8");
    log(`📤 Datos guardados en ${dumpFile}`);

    // Rotar dumps: conservar los 10 más recientes
    const files = fs.readdirSync(dirs.json)
      .filter(f => f.startsWith("redis_dump_"))
      .sort()
      .reverse();

    if (files.length > 10) {
      const toDelete = files.slice(10);
      for (const f of toDelete) {
        fs.unlinkSync(path.join(dirs.json, f));
      }
      log(`♻️ Rotación: eliminados ${toDelete.length} dumps antiguos.`);
    }

    // Limpiar Redis manteniendo solo las N claves más recientes
    const KEEP = 200;
    if (keys.length > KEEP) {
      const toDelete = keys.slice(0, keys.length - KEEP);
      for (const k of toDelete) await client.del(k);
      log(`🧹 Limpiadas ${toDelete.length} claves antiguas; ${KEEP} conservadas.`);
    } else {
      log("ℹ️ Claves totales por debajo del límite, no se limpia.");
    }
  } catch (e) {
    log(`❌ Error consolidando memoria: ${e.message}`, "error");
  }
}

// ==========================================================
// MONITOREO CONTINUO
// ==========================================================
setInterval(consolidarMemoria, SAVE_INTERVAL);
log("🧠 class32 activa — chequeando Redis cada 60 s.");

// ==========================================================
// APAGADO SEGURO
// ==========================================================
process.on("SIGINT", async () => {
  log("🛑 Cerrando conexión Redis…");
  await client.quit();
  process.exit(0);
});