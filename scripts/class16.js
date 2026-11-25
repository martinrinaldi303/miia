// ============================================================
// class16.js — Test en Caliente: Flujo class13 → class14 → class15
// ============================================================
// NO importa los módulos. Inyecta mensajes via Redis y verifica
// que cada motor responde en su canal de salida.
//
//   class13  class40/41/1/7_output → class18_ingest
//   class14  class25_output        → class14_output
//   class15  class15_ingest        → class17_ingest + class18_ingest
//
// Uso: node class16.js           (test completo)
//      node class16.js --quick   (solo Redis)
// ============================================================

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import chalk from "chalk";

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const BASE_DIR    = path.resolve(__dirname, "../operador/aprendizaje");
const REPORTS_DIR = path.join(BASE_DIR, "reports");
const LOGS_DIR    = path.join(BASE_DIR, "logs");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR,    { recursive: true });

const LOG_FILE    = path.join(LOGS_DIR,    "class16.log");
const REPORT_FILE = path.join(REPORTS_DIR, "class16_report.json");
const REDIS_URL   = process.env.REDIS_URL || "redis://localhost:6379";
const QUICK       = process.argv.includes("--quick");

function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [class16/${tipo.toUpperCase()}] ${msg}`;
  console.log(
    tipo === "ok" ? chalk.green(line) : tipo === "warn" ? chalk.yellow(line) :
    tipo === "error" ? chalk.red(line) : chalk.cyan(line)
  );
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const TS = () => new Date().toISOString();

const mkForecast = () => JSON.stringify({
  type: "forecast", source: "class16_test",
  probUp: 0.65, probDown: 0.25, confidence: 0.72, trend: "bullish", ts: TS(),
});
const mkRisk = () => JSON.stringify({
  type: "risk", source: "class16_test",
  RiskMetrics: { RiskLevel: 0.30, Volatility: 0.15 },
  riskScore: 0.30, ts: TS(),
});
const mkDecision = () => JSON.stringify({
  type: "analysis", source: "class16_test",
  texto: "Señal alcista en tecnología — test class16",
  decision: "BUY", ticker: "XLK", confianza: 0.72,
  ts: TS(),
});
const mkSector = () => JSON.stringify({
  type: "sector_update", source: "class16_test",
  sectors: [{ sector: "Technology", etf: "XLK", change: 1.2,
              change_pct: 1.2, riesgoGlobal: 0.30, state: "up" }],
  riesgoGlobal: 0.30, ts: TS(),
});

function waitOn(sub, canal, ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ ok: false }), ms);
    sub.subscribe(canal, msg => {
      clearTimeout(t);
      try { resolve({ ok: true, data: JSON.parse(msg) }); }
      catch { resolve({ ok: true }); }
    }).catch(() => {});
  });
}

async function run() {
  log("═══════════════════════════════════════════");
  log("🔥 class16 — Test en Caliente flujo class13→14→15");
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

  if (QUICK) {
    await pub.disconnect(); await sub.disconnect();
    return guardarReporte(results, t0);
  }

  // ── TEST 1: class13 → class18_ingest
  log("\n▶ [1/3] class13 → class18_ingest  (inyectando class40/41_output)");
  const p13 = waitOn(sub, "class18_ingest", 8_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class40_output", mkForecast());
  await pub.publish("class41_output", mkRisk());
  await pub.publish("class1_output",  JSON.stringify({
    type: "news", titulo: "Test class16", snippet: "Impacto mediático test", relevancia: 0.70, ts: TS(),
  }));
  const r13 = await p13;
  log(r13.ok ? `✅ class13 publicó en class18_ingest` : "⚠️  class13 sin respuesta",
    r13.ok ? "ok" : "warn");
  results.push({ test: "class13→class18_ingest", ok: r13.ok });

  // ── TEST 2: class14 → class14_output
  log("\n▶ [2/3] class14 → class14_output  (inyectando class25_output)");
  const p14 = waitOn(sub, "class14_output", 6_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class25_output", mkDecision());
  const r14 = await p14;
  log(r14.ok ? `✅ class14 respondió en class14_output`
    : "⚠️  class14 sin respuesta (puede no reaccionar a esta señal)", r14.ok ? "ok" : "warn");
  results.push({ test: "class14→class14_output", ok: r14.ok });

  // ── TEST 3: class15 → class17_ingest + class18_ingest
  log("\n▶ [3/3] class15 → class17_ingest + class18_ingest  (inyectando class15_ingest)");
  const p15a = waitOn(sub, "class17_ingest", 8_000);
  const p15b = waitOn(sub, "class18_ingest", 8_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class15_ingest", mkSector());
  const [r15a, r15b] = await Promise.all([p15a, p15b]);
  const r15ok = r15a.ok || r15b.ok;
  log(r15ok
    ? `✅ class15 respondió (class17_ingest=${r15a.ok} / class18_ingest=${r15b.ok})`
    : "⚠️  class15 sin respuesta (¿está corriendo?)", r15ok ? "ok" : "warn");
  results.push({ test: "class15→class17_ingest+class18_ingest", ok: r15ok,
    class17_ingest: r15a.ok, class18_ingest: r15b.ok });

  await pub.disconnect(); await sub.disconnect();
  guardarReporte(results, t0);
}

function guardarReporte(results, t0) {
  const ok = results.filter(r => r.ok).length;
  log("\n═══════════════════════════════════════════");
  log(`📋 RESULTADO: ${ok}/${results.length} OK`);
  results.forEach(r => log(`  ${r.ok ? "✅" : "⚠️ "} ${r.test}`));
  log("═══════════════════════════════════════════");
  const rep = { ts: new Date().toISOString(), duracion_ms: Date.now() - t0,
    grupo: "class13→14→15", ok, total: results.length, results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));
  log(`📊 Reporte: ${REPORT_FILE}`);
}

run().catch(e => log(`💥 ${e.message}`, "error"));
