// ============================================================
//  MIIA — CONFIG LOADER UNIVERSAL (ESM, ROBUST v4.3)
//  Snapshot inmutable + opcionales + validación + logs claros
// ============================================================

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";


// ============================================================
// ESM FIX
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// RUTA DE CONFIGURACIONES
// ============================================================
const CONFIG_DIR = path.resolve(__dirname, "../operador/aprendizaje/config");

// ============================================================
// CARGA DE .env — credenciales y secretos (NUNCA en el código)
// Se ejecuta al importar class38, ANTES de que cualquier módulo
// evalúe sus constantes con process.env (los imports de ESM se
// resuelven primero). No pisa variables ya definidas en el
// entorno (el orquestador o el sistema tienen prioridad).
// ============================================================
(function loadDotEnv() {
  try {
    const envPath = path.join(CONFIG_DIR, ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    let cargadas = 0;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      // El valor es todo lo que sigue al primer "=" (admite espacios, @, ñ…)
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = val;
        cargadas++;
      }
    }
    if (cargadas > 0)
      console.log(chalk.cyan(`[class38] 🔐 .env cargado (${cargadas} variables)`));
  } catch (e) {
    console.log(chalk.yellow(`[class38] ⚠ No se pudo cargar .env: ${e.message}`));
  }
})();

// ============================================================
// LISTA ACTUALIZADA DE ARCHIVOS DE CONFIG (solo los de la lista)
// ============================================================
const CONFIG_FILES = {
  buffer_manager:      "buffer_manager.ini",
  class_limits:        "class_limits.ini",
  class_loop_guard:    "class_loop_guard.ini",
  cleanup:             "cleanup.ini",
  cleanup_rules:       "cleanup_rules.ini",
  cognitive_regulator: "cognitive_regulator.ini",
  decision:            "decision.ini",
  flow_limits:         "flow_limits.ini",
  freshness_guard:     "freshness_guard.ini",
  log_sanitizer:       "log_sanitizer.ini",
  logging:             "logging.ini",
  memory_compaction:   "memory_compaction.ini",
  miia:                "miia.ini",
  origin_filter:       "origin_filter.ini",
  rate_limit:          "rate_limit.ini",
  routing:             "routing.ini",
  security:            "security.ini",
  security2:           "security2.ini",
  semantic_dedup:      "semantic_dedup.ini",
  shutdown:            "shutdown.ini",
  shutdown_channels:   "shutdown_channels.ini",
  sql:                 "sql.ini",
  storage:             "storage.ini",
  storage_limits:      "storage_limits.ini",
  stream_throttle:     "stream_throttle.ini",
  terminal_view:       "terminal_view.ini",
  ttl_cleaner:         "ttl_cleaner.ini",
  system:              "system.ini",
contract:            "contract.ini",   
};


// ============================================================
// CONFIGURACIONES OPCIONALES (PUEDEN ESTAR VACÍAS O NO EXISTIR)
// ============================================================
const OPTIONAL_CONFIGS = new Set([
  "buffer_manager",
  "cleanup_rules",
  "cognitive_regulator",
  "freshness_guard",
  "log_sanitizer",
  "memory_compaction",
  "origin_filter",
  "security2",
  "semantic_dedup",
  "shutdown_channels",
  "storage_limits",
  "terminal_view",
  "system",                                     // ← AGREGADO AQUÍ (opcional)
]);

// ============================================================
// ESTADO INTERNO (INMUTABLE)
// ============================================================
let CONFIG_CACHE = Object.freeze({});
let BOOTSTRAPPED = false;
let WATCHER_ACTIVE = false;

// ============================================================
// PARSER INI SEGURO
// ============================================================
function parseIni(raw) {
  const lines = raw.split(/\r?\n/);
  const result = {};
  let current = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = line.match(/^\[(.+)]$/);
    if (section) {
      current = section[1];
      result[current] = {};
      continue;
    }

    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (current) result[current][key] = value;
      else result[key] = value;
    }
  }

  return result;
}

// ============================================================
// LECTOR UNIVERSAL + NORMALIZACIÓN
// ============================================================
function loadUniversal(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;

  const parsed = parseIni(raw);
  if (!parsed || !Object.keys(parsed).length) return null;

  // 🔑 Normalización: si hay UNA sola sección, se desenvuelve
  const keys = Object.keys(parsed);
  if (keys.length === 1 && typeof parsed[keys[0]] === "object") {
    return parsed[keys[0]];
  }

  return parsed;
}

// ============================================================
// CARGA ATÓMICA DE CONFIGURACIONES
// ============================================================
function loadConfigsSnapshot() {
  const next = {};
  let errors = 0;

  console.log(chalk.cyan("[class38] 🔄 Cargando configuraciones…"));

  for (const [key, file] of Object.entries(CONFIG_FILES)) {
    const filePath = path.join(CONFIG_DIR, file);

    try {
      const cfg = loadUniversal(filePath);

      if (!cfg || !Object.keys(cfg).length) {
        if (OPTIONAL_CONFIGS.has(key)) {
          next[key] = Object.freeze({});
          console.log(chalk.yellow(`  🟡 ${file} (opcional vacío)`));
          continue;
        } else {
          console.log(chalk.red(`  🔴 ${file} (vacío o inválido)`));
          errors++;
          continue;
        }
      }

      next[key] = Object.freeze(cfg);
      console.log(chalk.green(`  🟢 ${file}`));
    } catch (err) {
      console.log(chalk.red(`  ❌ ${file} → ${err.message}`));
      errors++;
    }
  }

  if (errors > 0) {
    console.log(
      chalk.red(
        `[class38] ❌ Falló la carga (${errors} errores). Config NO aplicada.`
      )
    );
    return false;
  }

  CONFIG_CACHE = Object.freeze(next);
  console.log(chalk.green("[class38] ✅ Configuraciones aplicadas correctamente."));
  return true;
}

// ============================================================
// BOOTSTRAP (1 SOLA VEZ, DETERMINÍSTICO)
// ============================================================
export function bootstrapConfig({ watcher = false, report = false } = {}) {
  if (BOOTSTRAPPED) return;
  BOOTSTRAPPED = true;

  // Crear carpetas base
  const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
  for (const d of ["logs", "json_guardados", "raw", "metrics", "config"]) {
    fs.mkdirSync(path.join(baseDir, d), { recursive: true });
  }

  console.log(`[class38] 📌 Config dir: ${CONFIG_DIR}`);

  const ok = loadConfigsSnapshot();
  if (!ok) {
    throw new Error("[class38] Configuración inválida. Abortando arranque.");
  }

  if (watcher) enableConfigWatcher();
  if (report) reportConfigStatus();
}

// ============================================================
// GETTERS PÚBLICOS (CONTRATO FIRME)
// ============================================================
export function loadConfigs() {
  if (!BOOTSTRAPPED) bootstrapConfig();
  return CONFIG_CACHE;
}

export const getConfig = (name) => {
  const cfg = loadConfigs()[name];
  if (!cfg) {
    throw new Error(`[class38] Config '${name}' no disponible`);
  }
  return cfg;
};

export const getSQLConfig = () => getConfig("sql");
export const getStorageConfig = () => getConfig("storage");
export const getLoggingConfig = () => getConfig("logging");
export const getSystemConfig = () => getConfig("system");

// ============================================================
// WATCHER SEGURO (NO ROMPE RUNTIME)
// ============================================================
export function enableConfigWatcher() {
  if (WATCHER_ACTIVE) return;
  WATCHER_ACTIVE = true;

  fs.watch(CONFIG_DIR, (_, file) => {
    if (!file || !Object.values(CONFIG_FILES).includes(file)) return;

    console.log(chalk.yellow(`[class38] 🔄 Cambio detectado → ${file}`));

    const ok = loadConfigsSnapshot();
    if (!ok) {
      console.log(
        chalk.red("[class38] ⚠ Cambio rechazado (config inválida).")
      );
    }
  });

  console.log(chalk.cyan("[class38] 👀 Watcher activo (seguro)."));
}

// ============================================================
// REPORTE MANUAL DE ESTADO
// ============================================================
export function reportConfigStatus() {
  const loaded = loadConfigs();
  let ok = 0;

  console.log("\n[class38] 🔍 Estado de configuraciones:\n");

  for (const file of Object.values(CONFIG_FILES)) {
    const key = Object.keys(CONFIG_FILES).find(
      k => CONFIG_FILES[k] === file
    );
    if (loaded[key]) {
      ok++;
      console.log(chalk.green(`  🟢 ${file}`));
    } else {
      console.log(chalk.red(`  🔴 ${file}`));
    }
  }

  console.log(
    chalk.cyan(
      `\n[class38] ✔ Activas: ${ok} / ${Object.keys(CONFIG_FILES).length}\n`
    )
  );
}