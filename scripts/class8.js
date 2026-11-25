// ============================================================
// class8.js — Test en Caliente: Flujo class5 → class6 → class7
// ============================================================
// NO importa los módulos. Usa Redis para inyectar mensajes en
// los canales de entrada y verifica que las respuestas llegan.
//
//   class5  class5_trigger          → class3_ingest
//   class6  class40/41/1/7_output   → class6_output + class10_ingest
//   class7  (timer propio)          → class7_output
//
// Uso: node class8.js           (test completo)
//      node class8.js --quick   (solo Redis)
// ============================================================

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const BASE_DIR   = path.resolve(__dirname, "../operador/aprendizaje");
const REPORTS_DIR = path.join(BASE_DIR, "reports");
const LOGS_DIR    = path.join(BASE_DIR, "logs");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR,    { recursive: true });

const LOG_FILE    = path.join(LOGS_DIR,    "class8.log");
const REPORT_FILE = path.join(REPORTS_DIR, "class8_report.json");
const REDIS_URL   = process.env.REDIS_URL || "redis://localhost:6379";
const QUICK       = process.argv.includes("--quick");

function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [class8/${tipo.toUpperCase()}] ${msg}`;
  const styled = tipo === "ok"    ? chalk.green(line)
               : tipo === "warn"  ? chalk.yellow(line)
               : tipo === "error" ? chalk.red(line)
               : chalk.cyan(line);
  console.log(styled);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Payloads de test ────────────────────────────────────────────
const TS = () => new Date().toISOString();
const mkClass40 = () => JSON.stringify({
  type: "forecast", source: "class8_test",
  probUp: 0.62, probDown: 0.28, confidence: 0.70,
  horizon: "24h", trend: "bullish", ts: TS(),
});
const mkClass41 = () => JSON.stringify({
  type: "risk", source: "class8_test",
  RiskMetrics: { RiskLevel: 0.35, Volatility: 0.18 },
  probDown: 0.28, riskScore: 0.35, ts: TS(),
});
const mkClass1  = () => JSON.stringify({
  type: "news", source: "class8_test",
  titulo: "Mercados positivos — test class8",
  snippet: "La tecnología lidera ganancias del día.",
  relevancia: 0.75, ts: TS(),
});
const mkTrig5   = () => JSON.stringify({ source: "class8_test", accion: "procesar", ts: TS() });

// ── Esperar mensaje en canal con timeout ────────────────────────
function waitOn(sub, canal, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ ok: false, ms }), ms);
    sub.subscribe(canal, msg => {
      clearTimeout(t);
      try { resolve({ ok: true, data: JSON.parse(msg) }); }
      catch { resolve({ ok: true, raw: msg }); }
    }).catch(() => {});
  });
}

async function run() {
  log("═══════════════════════════════════════════");
  log("🔥 class8 — Test en Caliente flujo class5→6→7");
  log("═══════════════════════════════════════════");

  const results = [];
  const t0 = Date.now();

  const pub = createClient({ url: REDIS_URL });
  const sub = pub.duplicate();
  pub.on("error", () => {}); sub.on("error", () => {});

  try {
    await pub.connect(); await sub.connect();
    log("✅ Redis OK", "ok");
    results.push({ test: "redis", ok: true });
  } catch (e) {
    log(`❌ Redis: ${e.message}`, "error");
    results.push({ test: "redis", ok: false, error: e.message });
    return guardarReporte(results, t0);
  }

  if (QUICK) { await pub.disconnect(); await sub.disconnect(); return guardarReporte(results, t0); }

  // ── TEST 1: class7 — ya corre en timer, escuchar class7_output
  log("\n▶ [1/3] class7 → class7_output  (espera 8s señal en vivo)");
  const r7 = await waitOn(sub, "class7_output", 8_000);
  const ticker7 = r7.data?.ticker || r7.data?.symbol || "?";
  log(r7.ok ? `✅ class7 activo — ticker=${ticker7}` : "⚠️  class7 sin señal (¿está corriendo?)", r7.ok ? "ok" : "warn");
  results.push({ test: "class7→class7_output", ok: r7.ok });

  // ── TEST 2: class6 — inyectar inputs, esperar class6_output o class10_ingest
  log("\n▶ [2/3] class6 → class6_output / class10_ingest  (inyectando class40/41/1_output)");
  const p6a = waitOn(sub, "class6_output",  7_000);
  const p6b = waitOn(sub, "class10_ingest", 7_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class40_output", mkClass40());
  await pub.publish("class41_output", mkClass41());
  await pub.publish("class1_output",  mkClass1());
  const [r6a, r6b] = await Promise.all([p6a, p6b]);
  const r6ok = r6a.ok || r6b.ok;
  log(r6ok
    ? `✅ class6 respondió (class6_output=${r6a.ok} / class10_ingest=${r6b.ok})`
    : "⚠️  class6 sin respuesta (¿está corriendo?)", r6ok ? "ok" : "warn");
  results.push({ test: "class6→class6_output+class10_ingest", ok: r6ok,
    class6_output: r6a.ok, class10_ingest: r6b.ok });

  // ── TEST 3: class5 — disparar class5_trigger, esperar class3_ingest
  log("\n▶ [3/3] class5 → class3_ingest  (inyectando class5_trigger)");
  const p5 = waitOn(sub, "class3_ingest", 10_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class5_trigger", mkTrig5());
  const r5 = await p5;
  log(r5.ok
    ? `✅ class5 publicó en class3_ingest`
    : "⚠️  class5 sin respuesta (puede no estar corriendo o PDF pendiente)", r5.ok ? "ok" : "warn");
  results.push({ test: "class5→class3_ingest", ok: r5.ok });

  await pub.disconnect(); await sub.disconnect();
  await guardarReporte(results, t0);
}

function guardarReporte(results, t0) {
  const ok = results.filter(r => r.ok).length;
  log("\n═══════════════════════════════════════════");
  log(`📋 RESULTADO: ${ok}/${results.length} OK`);
  results.forEach(r => log(`  ${r.ok ? "✅" : "⚠️ "} ${r.test}`));
  log("═══════════════════════════════════════════");
  const rep = { ts: new Date().toISOString(), duracion_ms: Date.now() - t0,
    grupo: "class5→6→7", ok, total: results.length, results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));
  log(`📊 Reporte: ${REPORT_FILE}`);
}

run().catch(e => log(`💥 ${e.message}`, "error"));
