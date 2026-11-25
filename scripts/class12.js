// ============================================================
// class12.js — Test en Caliente: Flujo class9 → (skip class10 C#) → class11
// ============================================================
// NO importa los módulos. Inyecta mensajes via Redis y verifica
// que cada motor responde en su canal de salida.
//
//   class9   class40/41/1/7_output → class9_output + class10_ingest
//   class10  C# (.NET) — OMITIDO en este test
//   class11  class40/41/1/7_output → class18_ingest
//
// Uso: node class12.js           (test completo)
//      node class12.js --quick   (solo Redis)
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

const LOG_FILE    = path.join(LOGS_DIR,    "class12.log");
const REPORT_FILE = path.join(REPORTS_DIR, "class12_report.json");
const REDIS_URL   = process.env.REDIS_URL || "redis://localhost:6379";
const QUICK       = process.argv.includes("--quick");

function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [class12/${tipo.toUpperCase()}] ${msg}`;
  console.log(
    tipo === "ok" ? chalk.green(line) : tipo === "warn" ? chalk.yellow(line) :
    tipo === "error" ? chalk.red(line) : chalk.cyan(line)
  );
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

const TS = () => new Date().toISOString();

const mkForecast = () => JSON.stringify({
  type: "forecast", source: "class12_test",
  probUp: 0.58, probDown: 0.32, confidence: 0.68,
  trend: "neutral", horizon: "4h", ts: TS(),
});
const mkRisk = () => JSON.stringify({
  type: "risk", source: "class12_test",
  RiskMetrics: { RiskLevel: 0.40, Volatility: 0.22 },
  probDown: 0.32, riskScore: 0.40, ts: TS(),
});
const mkNews = () => JSON.stringify({
  type: "news", source: "class12_test",
  titulo: "Análisis de mercado — test class12",
  snippet: "Volatilidad moderada en sector energético.",
  relevancia: 0.65, ts: TS(),
});
const mkMarket = () => JSON.stringify({
  type: "market", source: "class12_test",
  sectors: [{ sector: "Technology", etf: "XLK", change: 0.8, riesgoGlobal: 0.35 }],
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
  log("🔥 class12 — Test en Caliente flujo class9→(skip10)→11");
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

  // Payload compartido — class9 y class11 leen los mismos canales
  const inputs = async () => {
    await pub.publish("class40_output", mkForecast());
    await pub.publish("class41_output", mkRisk());
    await pub.publish("class1_output",  mkNews());
    await pub.publish("class7_output",  mkMarket());
  };

  // ── TEST 1: class9 → class9_output + class10_ingest
  log("\n▶ [1/3] class9 → class9_output + class10_ingest  (inyectando class40/41/1/7_output)");
  const p9a = waitOn(sub, "class9_output",  7_000);
  const p9b = waitOn(sub, "class10_ingest", 7_000);
  await new Promise(r => setTimeout(r, 120));
  await inputs();
  const [r9a, r9b] = await Promise.all([p9a, p9b]);
  const r9ok = r9a.ok || r9b.ok;
  log(r9ok
    ? `✅ class9 respondió (class9_output=${r9a.ok} / class10_ingest=${r9b.ok})`
    : "⚠️  class9 sin respuesta (¿está corriendo?)", r9ok ? "ok" : "warn");
  results.push({ test: "class9→class9_output+class10_ingest", ok: r9ok,
    class9_output: r9a.ok, class10_ingest: r9b.ok });

  // ── TEST 2: class10 (C#) — OMITIDO, solo verificar existencia del exe
  log("\n▶ [2/3] class10 — C# OMITIDO en test JS");
  const exe10 = path.resolve(__dirname, "class10.cs");
  // El motor .NET: en Windows es MIIA_MotoresVectoriales.exe; en Linux es un
  // host sin extensión. El .dll existe en ambos SO y es lo que corre `dotnet run`.
  const netBase = path.resolve(__dirname, "../MIIA_MotoresVectoriales/bin/Debug/net9.0/MIIA_MotoresVectoriales");
  const existe10 = fs.existsSync(exe10) ||
    fs.existsSync(netBase + ".dll") ||
    fs.existsSync(netBase + ".exe") ||
    fs.existsSync(netBase);
  log(`  class10 (C#) presente=${existe10} — test delegado a MotorVectorialTester`,
    existe10 ? "ok" : "warn");
  results.push({ test: "class10_C#_skip", ok: true, nota: "C# — test en MotorVectorialTester" });

  // ── TEST 3: class11 → class18_ingest
  log("\n▶ [3/3] class11 → class18_ingest  (inyectando class40/41_output)");
  const p11 = waitOn(sub, "class18_ingest", 8_000);
  await new Promise(r => setTimeout(r, 120));
  await inputs();
  const r11 = await p11;
  log(r11.ok
    ? `✅ class11 publicó en class18_ingest`
    : "⚠️  class11 sin respuesta (¿está corriendo?)", r11.ok ? "ok" : "warn");
  results.push({ test: "class11→class18_ingest", ok: r11.ok });

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
    grupo: "class9→(skip10)→11", ok, total: results.length, results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));
  log(`📊 Reporte: ${REPORT_FILE}`);
}

run().catch(e => log(`💥 ${e.message}`, "error"));
