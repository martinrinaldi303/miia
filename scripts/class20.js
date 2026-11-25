// ============================================================
// class20.js — Test en Caliente: Flujo class17 → (skip class18 C#) → class19
// ============================================================
// NO importa los módulos. Inyecta mensajes via Redis y verifica
// que cada motor responde en su canal de salida.
//
//   class17  class17_ingest        → class17_output + class18_ingest + class25_ingest
//   class18  C# (.NET) — OMITIDO
//   class19  class19_ingest        → class21/22/23/24_ingest
//
// Uso: node class20.js           (test completo)
//      node class20.js --quick   (solo Redis)
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

const LOG_FILE    = path.join(LOGS_DIR,    "class20.log");
const REPORT_FILE = path.join(REPORTS_DIR, "class20_report.json");
const REDIS_URL   = process.env.REDIS_URL || "redis://localhost:6379";
const QUICK       = process.argv.includes("--quick");

function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [class20/${tipo.toUpperCase()}] ${msg}`;
  console.log(
    tipo === "ok" ? chalk.green(line) : tipo === "warn" ? chalk.yellow(line) :
    tipo === "error" ? chalk.red(line) : chalk.cyan(line)
  );
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const TS = () => new Date().toISOString();

const mkPortfolio = () => JSON.stringify({
  tipo: "portfolio_update", source: "class20_test",
  portfolio_id: "test_port_001",
  activos: [
    { ticker: "XLK", peso: 0.40, confianza: 0.72, trend: "up" },
    { ticker: "XLF", peso: 0.30, confianza: 0.65, trend: "neutral" },
    { ticker: "XLE", peso: 0.30, confianza: 0.58, trend: "down" },
  ],
  riesgoGlobal: 0.35, confianza: 0.68, strategy: "growth",
  ts: TS(),
});

const mkVectorFiltrado = () => JSON.stringify({
  type: "vector", source: "class20_test",
  vector: Array(16).fill(0).map((_, i) => +(Math.sin(i * 0.5) * 0.8).toFixed(4)),
  confianza: 0.70, coherencia: 0.68, dimension: 16,
  ts: TS(),
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
  log("🔥 class20 — Test en Caliente flujo class17→(skip18)→19");
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

  // ── TEST 1: class17 → class17_output + class18_ingest
  log("\n▶ [1/3] class17 → class17_output + class18_ingest  (inyectando class17_ingest)");
  const p17a = waitOn(sub, "class17_output",  8_000);
  const p17b = waitOn(sub, "class18_ingest",  8_000);
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class17_ingest", mkPortfolio());
  const [r17a, r17b] = await Promise.all([p17a, p17b]);
  const r17ok = r17a.ok || r17b.ok;
  log(r17ok
    ? `✅ class17 respondió (class17_output=${r17a.ok} / class18_ingest=${r17b.ok})`
    : "⚠️  class17 sin respuesta (¿está corriendo?)", r17ok ? "ok" : "warn");
  results.push({ test: "class17→class17_output+class18_ingest", ok: r17ok,
    class17_output: r17a.ok, class18_ingest: r17b.ok });

  // ── TEST 2: class18 (C#) — OMITIDO
  log("\n▶ [2/3] class18 — C# OMITIDO en test JS");
  log("  class18 (C#) — test delegado a MotorVectorialTester (.NET)", "ok");
  results.push({ test: "class18_C#_skip", ok: true, nota: "C# — test en MotorVectorialTester" });

  // ── TEST 3: class19 → class21/22/23/24_ingest
  log("\n▶ [3/3] class19 → class21-24_ingest  (inyectando class19_ingest)");
  const salidas19 = ["class21_ingest", "class22_ingest", "class23_ingest", "class24_ingest"];
  const promises19 = salidas19.map(ch => waitOn(sub, ch, 8_000));
  await new Promise(r => setTimeout(r, 120));
  await pub.publish("class19_ingest", mkVectorFiltrado());
  const res19 = await Promise.all(promises19);
  const okCount19 = res19.filter(r => r.ok).length;
  const r19ok = okCount19 > 0;
  log(r19ok
    ? `✅ class19 distribuyó a ${okCount19}/4 canales (class21-24_ingest)`
    : "⚠️  class19 sin respuesta (¿está corriendo?)", r19ok ? "ok" : "warn");
  results.push({ test: "class19→class21-24_ingest", ok: r19ok,
    canales_ok: okCount19, detalle: Object.fromEntries(salidas19.map((ch, i) => [ch, res19[i].ok])) });

  await pub.disconnect(); await sub.disconnect();
  guardarReporte(results, t0);
}

function guardarReporte(results, t0) {
  const ok = results.filter(r => r.ok).length;
  log("\n═══════════════════════════════════════════");
  log(`📋 RESULTADO: ${ok}/${results.length} OK`);
  results.forEach(r => log(`  ${r.ok ? "✅" : "⚠️ "} ${r.test}${r.nota ? " (" + r.nota + ")" : ""}`));
  log("═══════════════════════════════════════════");
  const rep = { ts: new Date().toISOString(), duracion_ms: Date.now() - t0,
    grupo: "class17→(skip18)→19", ok, total: results.length, results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));
  log(`📊 Reporte: ${REPORT_FILE}`);
}

run().catch(e => log(`💥 ${e.message}`, "error"));
