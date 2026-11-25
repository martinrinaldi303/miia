// =======================
// class4.js — Módulo de Control y Verificación General (ESM)
// VERSIÓN CORREGIDA v1.9.2
//
// Correcciones aplicadas:
//   1. CRÍTICO: leerYProcesarPDF(termino) eliminado
//      Antes pasaba el término de búsqueda como ruta de archivo
//      → ENOENT: 'tecnología cuántica' no es una ruta
//      Ahora escanea la carpeta PDF real y triggerea class2 via Redis
//   2. Tarea PDF separada de tarea Google
//      Google busca en la web, PDF escanea archivos reales
//   3. Heartbeat con .unref() para no bloquear el proceso
//   4. leerYProcesarPDF ya no se importa (class2 lo maneja internamente)
// =======================

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import Redis from "ioredis";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

// ── ESM dirname ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Solo importar buscarEnGoogle de class1 ─────────────────
// leerYProcesarPDF NO se importa aquí — class2 lo maneja
// class4 trigerea class2 via Redis en lugar de llamarlo directo
import { buscarEnGoogle } from "./class1.js";

// ── Config desde class38 ───────────────────────────────────
const storageCfg = (() => {
  try { const c = getStorageConfig(); return c && typeof c === "object" ? c : {}; }
  catch { return {}; }
})();
const logCfg = (() => {
  try { const c = getLoggingConfig(); return c && typeof c === "object" ? c : {}; }
  catch { return {}; }
})();

// ── Rutas base ─────────────────────────────────────────────
const BASE_DIR     = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR     = path.join(BASE_DIR, "logs");
const JSON_DIR     = path.join(BASE_DIR, "json_guardados");
const PDF_BASE_DIR = path.join(BASE_DIR, "pdf");       // carpeta real de PDFs
const LOG_FILE     = path.join(LOGS_DIR, "class4.log");
const ERRORES_FILE = path.join(LOGS_DIR, "class4_errores.json");

for (const dir of [LOGS_DIR, JSON_DIR, PDF_BASE_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ── Redis ──────────────────────────────────────────────────
const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true });
redis.connect().catch(() => {});

// ── Logger ──────────────────────────────────────────────────
function log(message, type = "INFO") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${type}] ${message}`;
  console.log(type === "ERROR" ? chalk.red(line) : chalk.cyan(line));
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

function logErrorToFile(modulo, error) {
  try {
    let errores = [];
    if (fs.existsSync(ERRORES_FILE))
      errores = JSON.parse(fs.readFileSync(ERRORES_FILE, "utf8"));
    errores.push({ modulo, message: error.message, timestamp: new Date().toISOString() });
    fs.writeFileSync(ERRORES_FILE, JSON.stringify(errores, null, 2));
  } catch (_) {}
}

// ── guardarEvento ──────────────────────────────────────────
async function guardarEvento(tipo, payload = {}) {
  const evento = { ts: new Date().toISOString(), tipo, source: "class4", payload };
  try { await redis.publish("class4_eventos", JSON.stringify(evento)); } catch (_) {}
  try {
    await fs.promises.appendFile(
      path.join(LOGS_DIR, "class4_eventos.log"),
      JSON.stringify(evento) + "\n", "utf8"
    );
  } catch (_) {}
}

// ── Helpers de config ──────────────────────────────────────
export function getPath(key, fallback = "./") {
  try { const v = storageCfg[key]; return typeof v === "string" && v.trim() ? v : fallback; }
  catch { return fallback; }
}
export function getLogLevel(d = "info") {
  try { return logCfg.level || d; } catch { return d; }
}
export function shouldRotateLogs() {
  try { return logCfg.rotate_logs === true; } catch { return false; }
}

// ── Métricas ───────────────────────────────────────────────
let metricasGlobales = { busquedasGoogle: 0, pdfsEncontrados: 0, errores: 0 };

async function guardarMetricas() {
  try {
    await fs.promises.writeFile(
      path.join(JSON_DIR, "class4_metricas.json"),
      JSON.stringify({ ...metricasGlobales, ts: new Date().toISOString() }, null, 2),
      "utf8"
    );
    log(`📊 Métricas: ${metricasGlobales.busquedasGoogle} búsquedas Google, ${metricasGlobales.pdfsEncontrados} PDFs`);
  } catch (e) { log(`Error guardando métricas: ${e.message}`, "ERROR"); }
}

// ── Escanear PDFs reales ────────────────────────────────────
// FIX: en lugar de leerYProcesarPDF(termino), lista archivos reales
function listarPDFsDisponibles(dir = PDF_BASE_DIR) {
  const pdfs = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pdfs.push(...listarPDFsDisponibles(fullPath));
      } else if (entry.isFile()) {
        const n = entry.name.toLowerCase();
        if (n.endsWith(".pdf") || n.endsWith(".docx")) pdfs.push(fullPath);
      }
    }
  } catch (_) {}
  return pdfs;
}

// ── Triggear class2 para procesar PDFs ────────────────────
async function triggerearClass2() {
  try {
    if (!redis.status || redis.status !== "ready") return false;
    await redis.publish("class2_trigger", "start");
    log("📤 Trigger enviado a class2 para procesar PDFs");
    return true;
  } catch (e) {
    log(`Error triggereando class2: ${e.message}`, "WARN");
    return false;
  }
}

// ── Función principal ──────────────────────────────────────
async function main() {
  const terminosBusqueda = [
    "tecnología cuántica",
    "mercados financieros",
    "inteligencia artificial aplicada",
    "biotecnología avanzada",
    "energías renovables",
  ];

  const verbose       = true;
  const forceContinue = true;
  const resultadosGlobales = {};

  // ── TAREA 1: Búsquedas Google ──────────────────────────
  log("🔎 Iniciando búsquedas Google...");

  for (const termino of terminosBusqueda) {
    log(`\n🔎 Buscando: "${termino}"`);
    const start = Date.now();
    try {
      const resultado = await buscarEnGoogle(termino);
      const duration  = Date.now() - start;
      log(`⏱️ Google: ${duration}ms`);

      if (verbose) console.log(`🔍 Google "${termino}":`, resultado?.length ?? 0, "resultados");

      if (!resultado || !Array.isArray(resultado) || resultado.length === 0) {
        throw new Error("Sin resultados válidos de Google.");
      }

      metricasGlobales.busquedasGoogle += resultado.length;
      resultadosGlobales[termino] = { googleCount: resultado.length };

      await guardarEvento("google_exitoso", { termino, count: resultado.length, duracion_ms: duration });

    } catch (err) {
      log(`❌ Google "${termino}": ${err?.message ?? err}`, "ERROR");
      logErrorToFile("Google", err instanceof Error ? err : new Error(String(err)));
      metricasGlobales.errores++;
      await guardarEvento("google_fallido", { termino, error: err?.message ?? String(err) });
      if (!forceContinue) { log("⚠️ Deteniendo por error crítico.", "WARN"); break; }
    }
  }

  // ── TAREA 2: PDFs — escanear carpeta real y triggear class2 ──
  // FIX CRÍTICO: NO llamar leerYProcesarPDF(termino)
  // Los términos de búsqueda son strings, NO rutas de archivo
  // class2 maneja los PDFs internamente desde su carpeta
  log("\n📁 Verificando PDFs disponibles...");

  try {
    const pdfsEncontrados = listarPDFsDisponibles(PDF_BASE_DIR);
    metricasGlobales.pdfsEncontrados = pdfsEncontrados.length;

    if (pdfsEncontrados.length > 0) {
      log(`📚 ${pdfsEncontrados.length} PDFs encontrados en ${PDF_BASE_DIR}`);
      pdfsEncontrados.slice(0, 5).forEach(p => log(`  📄 ${path.relative(PDF_BASE_DIR, p)}`));

      // Triggear class2 para que los procese y los guarde en MySQL
      const triggered = await triggerearClass2();
      if (triggered) {
        log("✅ class2 triggerado — procesará PDFs y los guardará en MySQL");
      }

      await guardarEvento("pdfs_encontrados", {
        total:   pdfsEncontrados.length,
        carpeta: PDF_BASE_DIR,
        muestra: pdfsEncontrados.slice(0, 5).map(p => path.basename(p)),
      });

    } else {
      log(`⚠️ No hay PDFs en ${PDF_BASE_DIR}`, "WARN");
      log(`📋 Para agregar PDFs: copiar archivos a ${PDF_BASE_DIR}`, "WARN");
      log("📋 Subcarpetas: crisis_historica/, analisis_tecnico/, libro_finanzas/", "WARN");
      await guardarEvento("sin_pdfs", { carpeta: PDF_BASE_DIR });
    }

  } catch (err) {
    log(`❌ Error verificando PDFs: ${err?.message ?? err}`, "ERROR");
    logErrorToFile("PDF", err instanceof Error ? err : new Error(String(err)));
    metricasGlobales.errores++;
  }

  // ── Guardar resumen ────────────────────────────────────
  try {
    const resumenPath = path.join(JSON_DIR, `control_resumen_${Date.now()}.json`);
    await fs.promises.writeFile(
      resumenPath,
      JSON.stringify(resultadosGlobales, null, 2), "utf8"
    );
    log(`🧾 Resumen guardado: ${resumenPath}`);
    await guardarMetricas();
  } catch (err) {
    log(`❌ Error guardando resumen: ${err?.message ?? err}`, "ERROR");
  }
}

// ── Heartbeat ──────────────────────────────────────────────
const nombreClase = path.basename(__filename).replace(".js", "");
log(`🧩 ${nombreClase} inicializado.`);
log(`📁 Carpeta PDFs: ${PDF_BASE_DIR}`);
setInterval(() => log(`✅ OK (orquestador activo)`), 60000).unref();

// ── Lanzar ─────────────────────────────────────────────────
main().catch(async (err) => {
  log(`❌ Error general: ${err?.message ?? err}`, "ERROR");
  await guardarEvento("error_general", { error: err?.message ?? String(err) });
});