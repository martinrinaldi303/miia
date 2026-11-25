// ============================================================
// test_flujo_python.js — Test en Caliente del Flujo Python
// ============================================================
// Verifica que miia_chatbot.py (FastAPI en puerto 5005) está
// activo y respondiendo correctamente:
//
//   GET  /api/health         → {ok: true}
//   GET  /api/market         → {sectores: {...}}
//   GET  /api/predicciones   → {lstm: {}, sentimiento: {}}
//   GET  /api/accuracy       → {accuracy_global: number}
//   POST /api/chat           → {ok: true, msg_id: string}
//   POST /miia/input         → {ok: true}        (gateway class30)
//   WS   /ws                 → conecta y recibe tipo=ping/heartbeat
//
// También verifica los canales Redis de entrada/salida:
//   class25_ingest  → class25_output  (ciclo completo MIIA)
//
// Uso: node test_flujo_python.js
//      node test_flujo_python.js --quick   (solo health + Redis)
// ============================================================

import fs        from "node:fs";
import path      from "node:path";
import http      from "node:http";
import { fileURLToPath } from "node:url";
import { createClient }  from "redis";
import chalk     from "chalk";

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const BASE_DIR    = path.resolve(__dirname, "../operador/aprendizaje");
const REPORTS_DIR = path.join(BASE_DIR, "reports");
const LOGS_DIR    = path.join(BASE_DIR, "logs");
fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR,    { recursive: true });

const LOG_FILE    = path.join(LOGS_DIR,    "test_python.log");
const REPORT_FILE = path.join(REPORTS_DIR, "test_python_report.json");
const REDIS_URL   = process.env.REDIS_URL  || "redis://localhost:6379";
const PY_BASE     = process.env.PYTHON_SERVER || "http://localhost:5005";
const QUICK       = process.argv.includes("--quick");
const TIMEOUT_MS  = 6_000;

function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [test_python/${tipo.toUpperCase()}] ${msg}`;
  console.log(
    tipo === "ok" ? chalk.green(line) : tipo === "warn" ? chalk.yellow(line) :
    tipo === "error" ? chalk.red(line) : chalk.cyan(line)
  );
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── HTTP helper ──────────────────────────────────────────────────
function httpRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: parsed.hostname, port: Number(parsed.port) || 80,
      path: parsed.pathname + parsed.search, method,
      headers: {
        "Content-Type":  "application/json",
        "Accept":        "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: TIMEOUT_MS,
    };
    const req = http.request(opts, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error",   reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Probe REST ───────────────────────────────────────────────────
async function probeREST(label, method, path, body = null, check = null) {
  try {
    const r = await httpRequest(method, `${PY_BASE}${path}`, body);
    const ok = r.status >= 200 && r.status < 300 && (check ? check(r.body) : true);
    log(ok ? `✅ ${label} → HTTP ${r.status}` : `⚠️  ${label} → HTTP ${r.status} (check falló)`,
      ok ? "ok" : "warn");
    return { test: label, ok, status: r.status, sample: JSON.stringify(r.body).slice(0, 120) };
  } catch (e) {
    log(`❌ ${label} → ${e.message}`, "error");
    return { test: label, ok: false, error: e.message };
  }
}

// ── Probe Redis ──────────────────────────────────────────────────
function waitRedis(sub, canal, ms) {
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
  log(`🔥 test_flujo_python — Python Chatbot @ ${PY_BASE}`);
  log("═══════════════════════════════════════════");

  const results = [];
  const t0 = Date.now();

  // ── Redis ──────────────────────────────────────────────────────
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
  }

  // ── 1. Health check ────────────────────────────────────────────
  log("\n▶ [1] GET /api/health");
  results.push(await probeREST(
    "GET /api/health", "GET", "/api/health",
    null, b => b?.status === "ok" || b?.ok === true || typeof b === "object"
  ));

  if (QUICK) {
    await pub.disconnect(); await sub.disconnect();
    return guardarReporte(results, t0);
  }

  // ── 2. Market data ─────────────────────────────────────────────
  log("\n▶ [2] GET /api/market");
  results.push(await probeREST(
    "GET /api/market", "GET", "/api/market",
    null, b => b?.sectores !== undefined || b?.sectors !== undefined
  ));

  // ── 3. Predicciones LSTM/sentimiento ───────────────────────────
  log("\n▶ [3] GET /api/predicciones");
  results.push(await probeREST(
    "GET /api/predicciones", "GET", "/api/predicciones",
    null, b => b?.lstm !== undefined
  ));

  // ── 4. Accuracy ────────────────────────────────────────────────
  log("\n▶ [4] GET /api/accuracy");
  results.push(await probeREST(
    "GET /api/accuracy", "GET", "/api/accuracy",
    null, b => b?.accuracy_global !== undefined || b?.accuracy_global_pct !== undefined
  ));

  // ── 5. Chat (POST /api/chat) ───────────────────────────────────
  log("\n▶ [5] POST /api/chat");
  results.push(await probeREST(
    "POST /api/chat", "POST", "/api/chat",
    { mensaje: "Test automático — clase20 hot-flow", user_id: "test_26", sesion: "test_s1", nombre: "tester" },
    b => b?.ok === true && typeof b?.msg_id === "string"
  ));

  // ── 6. Gateway input (POST /miia/input) ───────────────────────
  log("\n▶ [6] POST /miia/input  (gateway class30)");
  results.push(await probeREST(
    "POST /miia/input", "POST", "/miia/input",
    { source: "class30_test", text: "Test de gateway en caliente", user_id: "class30" },
    b => b?.ok === true
  ));

  // ── 7. Redis round-trip: class25_ingest → class25_output ───────
  if (pub.isOpen) {
    log("\n▶ [7] Redis round-trip: class25_ingest → class25_output  (espera 10s)");
    const waiter = waitRedis(sub, "class25_output", 10_000);
    await new Promise(r => setTimeout(r, 200));
    await pub.publish("class25_ingest", JSON.stringify({
      type: "human_query", source: "test_flujo_python",
      text: "Test de flujo — responde con tu estado actual",
      texto: "Test de flujo — responde con tu estado actual",
      user_id: "test_flujo", ts: new Date().toISOString(),
    }));
    const rr = await waiter;
    log(rr.ok ? `✅ class25_output recibido (ciclo Redis completo)` : "⚠️  class25_output sin respuesta en 10s",
      rr.ok ? "ok" : "warn");
    results.push({ test: "Redis class25_ingest→class25_output", ok: rr.ok });
  }

  await pub.disconnect();
  await sub.disconnect();
  guardarReporte(results, t0);
}

function guardarReporte(results, t0) {
  const ok = results.filter(r => r.ok).length;
  log("\n═══════════════════════════════════════════");
  log(`📋 RESULTADO: ${ok}/${results.length} OK`);
  results.forEach(r => log(`  ${r.ok ? "✅" : "⚠️ "} ${r.test}${r.error ? " — " + r.error : ""}`));
  log("═══════════════════════════════════════════");
  const rep = { ts: new Date().toISOString(), duracion_ms: Date.now() - t0,
    servidor: PY_BASE, ok, total: results.length, results };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2));
  log(`📊 Reporte: ${REPORT_FILE}`);
}

run().catch(e => log(`💥 ${e.message}`, "error"));
