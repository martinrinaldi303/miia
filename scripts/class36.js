import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { createClient } from "redis";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// -------------------------
// Compatibilidad __dirname
// -------------------------
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
// =======================
// BASE UNIFICADA DE SALIDA
// =======================
// Ajustes de rutas y creación de directorios (sin eliminar nada)
const baseDir = path.join(__dirname, "../operador/aprendizaje/emociones");
const LOGS_DIR = path.join(path.dirname(baseDir), "logs"); // mantener logs en operador/aprendizaje/logs
const JSON_DIR = path.join(baseDir, "json_guardados");
const RAW_DIR = path.join(baseDir, "raw");
const METRICS_DIR = path.join(baseDir, "metrics");
const CONFIG_DIR = path.join(baseDir, "config");

// Crear todas las carpetas necesarias con verificación
for (const dir of [LOGS_DIR, JSON_DIR, RAW_DIR, METRICS_DIR, CONFIG_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(dir)) {
      console.error(`[class36] ❌ Error: No se creó el directorio ${dir}`);
    } else {
      console.log(`[class36] 📁 Directorio verificado: ${dir}`);
    }
  } catch (e) {
    console.error(`[class36] mkdir ${dir} failed:`, e.message);
  }
}

const NOMBRE_CLASE = "class36";
const LOG_FILE = path.join(LOGS_DIR, `${NOMBRE_CLASE}.log`);

// =======================
// LOGGER CENTRALIZADO CON VERIFICACIÓN
// =======================
async function guardarEvento(tipo, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tipo, payload }) + "\n";
  try {
    await fs.promises.appendFile(LOG_FILE, line, "utf8");

    // Verificación de integridad del log
    const stats = await fs.promises.stat(LOG_FILE);
    if (stats.size > 0) {
      console.log(`[class36] ✅ Log actualizado (${(stats.size / 1024).toFixed(2)} KB)`);
    } else {
      console.warn("[class36] ⚠️ Archivo log creado pero vacío.");
    }

    // 🔄 NUEVO: Guardado automático de resultados de búsqueda
    if (tipo && String(tipo).toLowerCase().includes("resultado")) {
      try {
        const fileName = `resultado_${Date.now()}_${Math.random().toString(16).slice(2)}.json`;
        const jsonPath = path.join(JSON_DIR, fileName);
        await fs.promises.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
        console.log(`[class36] 💾 Resultado de búsqueda guardado en ${jsonPath}`);
      } catch (jsonErr) {
        console.warn(`[class36] ⚠️ No se pudo guardar el resultado JSON: ${jsonErr.message}`);
      }
    }

  } catch (e) {
    console.error("[class36] ❌ Error guardando log:", e.message);
    try {
      const fallbackPath = path.join(baseDir, `error_log_fallback_${Date.now()}.txt`);
      await fs.promises.writeFile(fallbackPath, line, "utf8");
      console.warn(`[class36] Log alternativo guardado en ${fallbackPath}`);
    } catch (fallbackError) {
      console.error("[class36] ❌ Error también al crear log alternativo:", fallbackError.message);
    }
  }
}


// Wrapper de logging sencillo usado en el archivo
function log(msg, level = "INFO") {
  const ts = new Date().toISOString();
  const text = typeof msg === "string" ? msg : JSON.stringify(msg);
  const out = `[${ts}] [class36/${level}] ${text}`;
  if (level === "ERROR" || level === "WARN") console.error(out);
  else console.log(out);
  // intentar guardar de forma no bloqueante
  guardarEvento(level, msg).catch(() => {});
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
// CONFIG REDIS
// =======================
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
const redisPub = createClient({ url: REDIS_URL });

redis.on("error", (e) => log(`Redis error: ${e.message}`, "ERROR"));
redisPub.on("error", (e) => log(`RedisPub error: ${e.message}`, "ERROR"));

await redis.connect();
await redisPub.connect();
log("📡 Redis conectado correctamente.");

// =======================
// CACHÉ DE COHERENCIA — suscripción real a los canales
// =======================
// calcularCoherenciaGlobal() hacía `redis.get("class29_output")` sobre nombres
// de CANALES pub/sub. Los mensajes de pub/sub no crean claves, y nadie hace
// SET de esas tres, así que el GET devolvía null siempre: `mensajes` quedaba
// vacío, `valores.length` era 0 y la función retornaba el default 0.5 en cada
// llamada. Loggeaba "🧩 Coherencia global: 50.0% (estable)" para siempre —
// una constante con forma de medición.
//
// Un cliente de Redis en modo suscriptor no puede ejecutar otros comandos, por
// eso se duplica en vez de reusar `redis`.
const CANALES_COHERENCIA = ["class28_output", "class29_output", "class31_output"];
const COHERENCIA_TTL_MS  = 5 * 60_000;   // más viejo que esto no es "actual"
const _ultimoPorCanal    = new Map();    // canal → { datos, ts }

try {
  const subCoherencia = redis.duplicate();
  subCoherencia.on("error", (e) => log(`RedisSub error: ${e.message}`, "ERROR"));
  await subCoherencia.connect();
  for (const canal of CANALES_COHERENCIA) {
    await subCoherencia.subscribe(canal, (raw) => {
      try {
        const msg = JSON.parse(raw);
        // Anti-eco: class36 publica sus propios health_ping DENTRO de estos
        // mismos canales. Sin este filtro, un ping pisa el último estado real
        // en la caché y la coherencia queda intermitente según el timing.
        // Verificado escuchando class29_output el 1-sep-2026:
        //   {"source":"class36","type":"health_ping","msg":"ping de class29"}
        if (msg?.source === "class36" || msg?.type === "health_ping") return;
        _ultimoPorCanal.set(canal, { datos: msg, ts: Date.now() });
      } catch { /* mensaje no-JSON: se ignora, no rompe la suscripción */ }
    });
  }
  log(`🧩 Suscripto a ${CANALES_COHERENCIA.length} canales de coherencia.`);
} catch (e) {
  log(`⚠️ No se pudo suscribir a canales de coherencia: ${e.message}`, "WARN");
}

// =======================
// MODULOS MONITOREADOS
// =======================
const MODULOS = {
  class27: "Memoria Analítica",
  class28: "Conciencia Cognitiva",
  class29: "Balance Global",
  class30: "Servidor Interplataforma",
  class31: "Aprendizaje Guiado",
  class32: "Memoria Distribuida",
  class34: "Respaldo Integral"
};

// Estado inicial
let estadoModulos = {};
for (const k of Object.keys(MODULOS))
  estadoModulos[k] = { status: "desconocido", latencia: null, ultimoPing: null, errores: 0 };

// =======================
// TEST DE LATENCIA REDIS
// =======================
async function testRedisLatency() {
  const key = `ping_${crypto.randomUUID()}`;
  const start = performance.now();
  try {
    await redis.set(key, "pong", { EX: 5 });
    await redis.get(key);
    const dur = performance.now() - start;
    log(`⏱️ Redis latency OK: ${dur.toFixed(2)} ms`);
    return dur;
  } catch (e) {
    log(`❌ Error de latencia Redis: ${e.message}`, "ERROR");
    return null;
  }
}

// =======================
// CHEQUEO DE MÓDULOS ACTIVOS
// =======================
async function verificarModulo(nombre) {
  const canal = `${nombre}_output`;
  const testMsg = {
    source: "class36",
    type: "health_ping",
    ts: new Date().toISOString(),
    msg: `ping de ${nombre}`
  };

  try {
    const t0 = performance.now();
    // publish es fire-and-forget; medir tiempo hasta resolución de promesa
    await redisPub.publish(canal, JSON.stringify(testMsg));
    const elapsed = performance.now() - t0;

    estadoModulos[nombre] = {
      status: "activo",
      latencia: elapsed.toFixed(2),
      ultimoPing: new Date().toISOString(),
      errores: 0
    };
    log(`✅ ${nombre} (${MODULOS[nombre]}) ping enviado en ${elapsed.toFixed(2)} ms.`);
  } catch (err) {
    estadoModulos[nombre].status = "inactivo";
    estadoModulos[nombre].errores++;
    log(`⚠️ ${nombre} no responde: ${err.message}`, "WARN");
  }
}

// =======================
// ESCANEO GLOBAL
// =======================
async function cicloDiagnostico() {
  const redisLatency = await testRedisLatency();
  for (const nombre of Object.keys(MODULOS)) {
    await verificarModulo(nombre);
  }

  const resumen = {
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    redisLatency,
    modulos: estadoModulos,
  };

  const resumenPath = path.join(METRICS_DIR, "class36_resumen.json");
  try {
    fs.writeFileSync(resumenPath, JSON.stringify(resumen, null, 2));
  } catch (e) {
    log(`⚠️ No se pudo escribir ${resumenPath}: ${e.message}`, "WARN");
  }

  await redisPub.publish("ui_stream", JSON.stringify({
    type: "diagnostico_global",
    color: "#00ccff",
    resumen
  }));

  await redisPub.publish("class36_output", JSON.stringify({
    source: "class36",
    resumen
  }));

  log("📊 Diagnóstico completo publicado.");
}

// =======================
// WATCHDOG PRINCIPAL
// =======================
setInterval(async () => {
  try {
    await cicloDiagnostico();
  } catch (e) {
    log(`❌ Error en cicloDiagnostico: ${e.message}`, "ERROR");
  }
}, 60_000); // cada 60 segundos

log("🧠 class36 iniciada — monitoreando módulos 27–34...");

// ==========================================================
// class36.js — PARTE 2/2
// ==========================================================
// Diagnóstico cognitivo, stress-test y reporte al cerebro
// ==========================================================

// =======================
// FUNCIÓN DE COHERENCIA GLOBAL
// =======================
function calcularCoherenciaGlobal() {
  try {
    const ahora = Date.now();
    const valores = [];
    const fuentes = [];

    for (const canal of CANALES_COHERENCIA) {
      const e = _ultimoPorCanal.get(canal);
      if (!e) continue;
      // Un dato de hace media hora no describe la coherencia de AHORA. Antes
      // no había frescura porque tampoco había datos.
      if (ahora - e.ts > COHERENCIA_TTL_MS) continue;

      // El campo viaja ANIDADO en `data`, no arriba. Verificado en producción
      // el 1-sep-2026 escuchando class29_output:
      //   {"data":{"coherencia":1.0,"n_muestras":0,...},"text":"Balance coh:1.000"}
      // Se buscan las dos ubicaciones porque no todos los emisores del sistema
      // usan el mismo envoltorio.
      const m = e.datos;
      const d = m?.data;

      // El emisor declara sobre cuántas muestras calculó. Con n_muestras = 0
      // su "coherencia" es su propio valor por defecto, no una medición.
      // Verificado en producción (1-sep-2026): class29 publica
      // {"coherencia":1.0,"n_muestras":0}, o sea coherencia PERFECTA sobre
      // CERO datos. Aceptarlo convertiría el "sin datos" honesto de acá en un
      // 100% tranquilizador — exactamente el error que este arreglo vino a
      // corregir, un nivel más arriba.
      const nm = m?.n_muestras ?? d?.n_muestras;
      if (typeof nm === "number" && nm <= 0) continue;

      const v = typeof m?.coherencia === "number" ? m.coherencia
              : typeof d?.coherencia === "number" ? d.coherencia
              : typeof m?.valor      === "number" ? m.valor
              : typeof d?.valor      === "number" ? d.valor
              : null;
      // El default 0.5 de antes metía un valor inventado por cada mensaje sin
      // campo de coherencia. Ahora un mensaje que no la trae simplemente no vota.
      if (v === null || !Number.isFinite(v)) continue;
      valores.push(v);
      fuentes.push(canal.replace("_output", ""));
    }

    // SIN DATOS ≠ 0.5. Devolver 0.5 hacía que "no medí nada" fuera
    // indistinguible de "medí y da justo el punto medio" — y como el estado
    // 0.5 cae en "estable", el sistema se reportaba sano sin haber mirado.
    if (!valores.length) {
      log("🧩 Coherencia global: sin datos frescos en los canales (nada que promediar)");
      return { coherencia: null, estado: "sin_datos", fuentes: [], n: 0 };
    }

    const coherenciaProm = valores.reduce((a, b) => a + b, 0) / valores.length;
    const estado =
      coherenciaProm > 0.75 ? "alineado"
      : coherenciaProm > 0.5 ? "estable"
      : "desalineado";

    log(`🧩 Coherencia global: ${(coherenciaProm * 100).toFixed(1)}% (${estado}) ` +
        `sobre ${valores.length}/${CANALES_COHERENCIA.length} canales [${fuentes.join(", ")}]`);
    return { coherencia: coherenciaProm, estado, fuentes, n: valores.length };
  } catch (e) {
    log(`⚠️ Error calculando coherencia global: ${e.message}`, "WARN");
    return { coherencia: null, estado: "indefinido", fuentes: [], n: 0 };
  }
}

// =======================
// STRESS TEST DE REDIS
// =======================
async function stressTestRedis(iter = 50) {
  const start = performance.now();
  let ok = 0;
  for (let i = 0; i < iter; i++) {
    const key = `stress_${i}_${crypto.randomUUID()}`;
    try {
      await redis.set(key, "ping", { EX: 3 });
      await redis.get(key);
      ok++;
    } catch {}
  }
  const dur = performance.now() - start;
  const prom = dur / iter;
  log(`🔥 Stress test Redis: ${ok}/${iter} ops, avg ${(prom).toFixed(2)} ms/op`);
  return { total: iter, exitos: ok, promedioMs: prom };
}

// =======================
// REPORTE GLOBAL AL CEREBRO
// =======================
async function enviarReporteCerebro() {
  const coherencia = await calcularCoherenciaGlobal();
  const redisLatency = await testRedisLatency();

  const reporte = {
    type: "diagnostico_global",
    origin: "class36",
    timestamp: new Date().toISOString(),
    coherencia,
    redisLatency,
    modulos: estadoModulos,
    host: os.hostname(),
  };

  await redisPub.publish("class25_ingest", JSON.stringify(reporte));
  log("🧠 Reporte global enviado al cerebro (class25_ingest).");
}

// =======================
// CICLO PRINCIPAL EXTENDIDO
// =======================
async function cicloPrincipal() {
  try {
    log("🚀 Iniciando diagnóstico completo...");
    await cicloDiagnostico();
    await enviarReporteCerebro();

    const stress = await stressTestRedis(30);
    await redisPub.publish("ui_stream", JSON.stringify({
      type: "stress_test",
      color: stress.promedioMs < 5 ? "#00ff00" : "#ffaa00",
      detalle: stress
    }));

    const resumenFinal = {
      timestamp: new Date().toISOString(),
      coherencia: await calcularCoherenciaGlobal(),
      stress,
      modulos: estadoModulos
    };

    const resumenPath = path.join(METRICS_DIR, `class36_diagnostico_${Date.now()}.json`);
    try {
      fs.writeFileSync(resumenPath, JSON.stringify(resumenFinal, null, 2));
      log(`📄 Diagnóstico global guardado en ${resumenPath}`);
    } catch (e) {
      log(`⚠️ No se pudo escribir ${resumenPath}: ${e.message}`, "WARN");
    }
  } catch (err) {
    log(`❌ Error en cicloPrincipal: ${err.message}`, "ERROR");
  }
}

// Ejecutar diagnóstico cada 5 minutos
setInterval(cicloPrincipal, 300_000);

// =======================
// CIERRE ORDENADO
// =======================
process.on("SIGINT", async () => {
  log("🛑 class36 cerrando conexiones...");
  try {
    await redis.quit();
    await redisPub.quit();
  } catch {}
  log("✅ Redis cerrado correctamente.");
  process.exit(0);
});

process.on("uncaughtException", (err) =>
  log(`❌ Excepción no controlada: ${err.message}`, "ERROR")
);
process.on("unhandledRejection", (reason) =>
  log(`⚠️ Promesa no manejada: ${reason}`, "WARN")
);

log("🏁 class36 lista: monitoreo, coherencia y test activo.");

export {
  log,
  guardarEvento,
  testRedisLatency,
  verificarModulo,
  cicloDiagnostico,
  calcularCoherenciaGlobal,
  stressTestRedis,
  enviarReporteCerebro,
  cicloPrincipal,
  estadoModulos,
  MODULOS,
  redis,
  redisPub,
};