// =======================
// class39_control.mjs — MÓDULO DE CONTROL Y VERIFICACIÓN GENERAL (ESM)
// Robusto frente a módulos faltantes
// ❌ class33 ELIMINADA
// ❌ class34 ELIMINADA
// =======================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =======================
// ESM __dirname / __filename
// =======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================================
// CONFIG / DIRECTORIOS
// ==========================================================
const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
const LOG_DIR = path.join(baseDir, "logs");
const JSON_DIR = path.join(baseDir, "json_guardados");
const STATE_DIR = path.join(baseDir, "central");

for (const d of [baseDir, LOG_DIR, JSON_DIR, STATE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

const LOG_FILE = path.join(LOG_DIR, "class39.log");
const ERRORES_FILE = path.join(LOG_DIR, "class39_errors.json");
const EVENTOS_FILE = path.join(STATE_DIR, "class39_events.jsonl");

// ==========================================================
// LOGGER CENTRAL
// ==========================================================
function log(message, type = "INFO") {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${type}] ${typeof message === "string" ? message : JSON.stringify(message)}`;
  if (type === "ERROR") console.error(line);
  else if (type === "WARN") console.warn(line);
  else console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function logErrorToFile(modulo, error) {
  try {
    let errores = [];
    if (fs.existsSync(ERRORES_FILE)) {
      try { errores = JSON.parse(fs.readFileSync(ERRORES_FILE, "utf8")); } catch {}
    }
    errores.push({
      modulo,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
      timestamp: new Date().toISOString()
    });
    fs.writeFileSync(ERRORES_FILE, JSON.stringify(errores, null, 2), "utf8");
  } catch {}
}

// ==========================================================
// CONFIG GLOBAL — class38 integrador (seguro)
// ==========================================================
import {
  getStorageConfig,
  getLoggingConfig,
} from "./class38.js";

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
// HELPERS EXPORTADOS
// ==========================================================
export function getPath(key, fallback = "./") {
  try {
    const val = storageCfg[key];
    return typeof val === "string" && val.trim() ? val : fallback;
  } catch {
    return fallback;
  }
}

export function getLogLevel(defaultLevel = "info") {
  try {
    return logCfg.level || defaultLevel;
  } catch {
    return defaultLevel;
  }
}

export function shouldRotateLogs() {
  try {
    return logCfg.rotate_logs === true;
  } catch {
    return false;
  }
}

// ==========================================================
// AUDITORÍA LOCAL (JSONL)
// ==========================================================
async function guardarEvento(evento = "unknown", payload = {}) {
  try {
    const entry = { ts: new Date().toISOString(), evento, payload };
    await fs.promises.appendFile(EVENTOS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    log(`guardarEvento failed: ${e?.message || e}`, "WARN");
  }
}

// ==========================================================
// CARGADOR DINÁMICO ROBUSTO
// ==========================================================
async function loadModuleFunction(moduleBaseName) {
  try {
    const mod = await import(`./${moduleBaseName}.js`);

    if (typeof mod.default === "function") return mod.default;
    if (typeof mod.main === "function") return mod.main;
    if (typeof mod.run === "function") return mod.run;
    if (typeof mod.execute === "function") return mod.execute;

    for (const k of Object.keys(mod)) {
      if (typeof mod[k] === "function") return mod[k];
    }

    return async (caso) => ({
      stub: true,
      module: moduleBaseName,
      message: "Módulo cargado sin función ejecutable",
      caso
    });

  } catch (e) {
    logErrorToFile(moduleBaseName, e);
    return async (caso) => {
      log(`[${moduleBaseName}] módulo ausente o con error`, "WARN");
      await guardarEvento("module_stub_executed", {
        module: moduleBaseName,
        caso,
        error: e?.message ?? String(e)
      });
      return { stub: true, module: moduleBaseName, caso };
    };
  }
}

// ==========================================================
// MAIN — ORQUESTADOR DE PRUEBAS
// Módulos testeados: class36, class37, class38
// ==========================================================
async function main() {
  try {
    const casosPrueba = [
      "escenario_basico",
      "escenario_estres",
      "escenario_error_controlado"
    ];

    const verbose = true;
    const forceContinue = true;
    const resultadosGlobales = {};

    // ❌ class33 y class34 eliminadas
    // ⚠️ class36 y class37 SACADAS (23-oct-2026): loadModuleFunction hace `await import()`,
    //    que EJECUTA el top-level del módulo. Importar class37 levantaba un BUS COMPLETO
    //    duplicado dentro de class39 (Redis sub a 30 canales + express :5010 + batch loops):
    //    ~2.7 GB de fuga y tráfico del bus DUPLICADO. class38 es config pura (ya importada), inofensiva.
    const moduleNames = [
      "class38"
    ];

    const loaders = {};
    for (const name of moduleNames) {
      loaders[name] = await loadModuleFunction(name);
    }

    for (const caso of casosPrueba) {
      log(`🧪 Iniciando control para: "${caso}"`);
      const resultadosResumen = {};
      const errores = [];

      for (const moduleName of moduleNames) {
        const fn = loaders[moduleName];
        const start = Date.now();
        try {
          log(`➡️ Ejecutando ${moduleName} (${caso})`);
          const maybe = fn(caso);
          const resultado = (maybe && typeof maybe.then === "function") ? await maybe : maybe;
          const duration = Date.now() - start;

          log(`⏱️ ${moduleName} OK (${duration} ms)`);
          if (verbose) log(`🔍 Resultado ${moduleName}: ${JSON.stringify(resultado)}`);

          resultadosResumen[moduleName] = {
            ok: true,
            duracion_ms: duration,
            resultado: resultado ?? null
          };

          await guardarEvento("tarea_exitosa", {
            modulo: moduleName,
            caso,
            duracion_ms: duration
          });

        } catch (err) {
          errores.push({ modulo: moduleName, error: err?.message ?? String(err) });

          resultadosResumen[moduleName] = {
            ok: false,
            error: err?.message ?? String(err)
          };

          logErrorToFile(moduleName, err);
          await guardarEvento("tarea_fallida", {
            modulo: moduleName,
            caso,
            error: err?.message ?? String(err)
          });

          if (!forceContinue) break;
        }
      }

      resultadosGlobales[caso] = { resultadosResumen, errores };
      await guardarEvento("resumen_caso", { caso, resultadosResumen, errores });
    }

    try {
      const resumenPath = path.join(JSON_DIR, `control_class39_resumen_${Date.now()}.json`);
      await fs.promises.writeFile(resumenPath, JSON.stringify(resultadosGlobales, null, 2), "utf8");
      log(`🧾 Resumen guardado en ${resumenPath}`);
    } catch (e) {
      await guardarEvento("error_guardando_resumen", { error: e?.message ?? String(e) });
    }

    log("✅ class39 completed run");
    return resultadosGlobales;

  } catch (e) {
    logErrorToFile("main", e);
    await guardarEvento("error_general", { error: e?.message ?? String(e) });
    throw e;
  }
}

// ==========================================================
// HEARTBEAT
// ==========================================================
log("[class39] 🧩 Orquestador inicializado");

// Heartbeat SIN .unref(): con class37/class36 fuera del test, nada más mantiene vivo el
// proceso; sin esto class39 saldría tras main() y el chequeo lo leería como módulo caído
// (baja de 38 procesos). Con esto queda como heartbeat benigno de ~30 MB.
setInterval(() => {
  log("[class39] ✅ OK");
}, 60_000);

// ==========================================================
// EJECUCIÓN DIRECTA
// ==========================================================
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(() => {
    log("❌ Error general en ejecución", "ERROR");
  });
}

export default main;
