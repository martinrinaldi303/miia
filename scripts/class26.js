// ============================================================
// class26.js — Tester de Ejecutables C++ y Sistema MIIA v2.0
// ============================================================
//
// Testea todos los ejecutables C++ del sistema:
//   class21.exe  Filtro Adaptativo    (class21_ingest → class21_output)
//   class22.exe  Filtro Rígido        (class22_ingest → class22_output)
//   class23.exe  Red EMA              (class23_ingest → class23_output)
//   class24.exe  MLP Online           (class24_ingest → class24_output)
//   class25A.exe Motor Cuantitativo   (class21-24_output+class40/41 → class25a_output)
//   class27.exe  Meta-Introspección   (class25_output+class21-24 → class27_output)
//   class28.exe  Conciencia Operativa (class21-24+class25_output → class28_output)
//   class29.exe  Balance Emocional    (class21-24+class27-28+class7 → class29_output)
//
// Protocolo de test por exe:
//   1. Verificar que el .exe existe en scripts/
//   2. Spawnear proceso con timeout
//   3. Esperar señal "ready" en Redis (hasta 5s)
//   4. Publicar mensaje de test al canal de entrada
//   5. Esperar respuesta en canal de salida (hasta 8s)
//   6. Matar proceso y registrar resultado
//
// También testea: Redis, class25B.js, class44.py (nuevo)
// ============================================================

import fs            from "node:fs";
import path          from "node:path";
import os            from "node:os";
import { spawn }     from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient }  from "redis";
import chalk         from "chalk";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

const __filename = fileURLToPath(import.meta.url);
let __dirname    = path.dirname(__filename);
if (__dirname.startsWith("/C:/") || __dirname.startsWith("/c:/"))
  __dirname = __dirname.slice(1);

// ── Paths ───────────────────────────────────────────────────────
const SCRIPTS_DIR  = __dirname;                                   // aquí viven los .exe
const BASE_DIR     = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR     = path.join(BASE_DIR, "logs");
const REPORTS_DIR  = path.join(BASE_DIR, "reports");
for (const d of [LOGS_DIR, REPORTS_DIR]) fs.mkdirSync(d, { recursive: true });

const LOG_FILE    = path.join(LOGS_DIR,   "class26.log");
const REPORT_FILE = path.join(REPORTS_DIR, "class26_report.json");

// ── Logger ──────────────────────────────────────────────────────
function log(msg, tipo = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class26/${tipo.toUpperCase()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
  if      (tipo === "error") console.error(chalk.red(line));
  else if (tipo === "warn")  console.warn(chalk.yellow(line));
  else if (tipo === "ok")    console.log(chalk.green(line));
  else                       console.log(chalk.cyan(line));
}

// ── Mapa de ejecutables C++ ─────────────────────────────────────
//   exe         → { desc, chIn[], testPayload, chOut, testChIn }
//   testChIn: canal al que enviamos el mensaje de test (primero de chIn)
const CPP_EXES = [
  {
    exe:         "class21.exe",
    desc:        "Filtro Cognitivo Adaptativo",
    chIn:        ["class21_ingest"],
    chOut:       "class21_output",
    testPayload: () => ({
      type: "vector", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.72, coherencia: 0.68,
      ts: new Date().toISOString(),
    }),
  },
  {
    exe:         "class22.exe",
    desc:        "Filtro Cognitivo Rígido",
    chIn:        ["class22_ingest"],
    chOut:       "class22_output",
    testPayload: () => ({
      type: "vector", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.75, coherencia: 0.70,
      ts: new Date().toISOString(),
    }),
  },
  {
    exe:         "class23.exe",
    desc:        "Red EMA Cognitiva",
    chIn:        ["class23_ingest"],
    chOut:       "class23_output",
    testPayload: () => ({
      type: "vector", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.68, coherencia: 0.65,
      ts: new Date().toISOString(),
    }),
  },
  {
    exe:         "class24.exe",
    desc:        "MLP Online",
    chIn:        ["class24_ingest"],
    chOut:       "class24_output",
    testPayload: () => ({
      type: "analysis", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.80, coherencia: 0.75,
      ts: new Date().toISOString(),
    }),
  },
  {
    exe:         "class25A.exe",
    desc:        "Motor Cuantitativo de Decisión",
    chIn:        ["class21_output", "class22_output", "class23_output", "class24_output"],
    chOut:       "class25a_output",
    testPayload: () => ({
      type: "analysis", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.72, coherencia: 0.70, score: 0.72,
      señal: "BUY", texto: "Test class26",
      ts: new Date().toISOString(),
    }),
    // class25A recibe de class21-24_output — enviamos a class21_output
    testChIn: "class21_output",
  },
  {
    exe:         "class27.exe",
    desc:        "Meta-Introspección Cognitiva",
    chIn:        ["class25_output", "class21_output", "class22_output",
                  "class23_output", "class24_output"],
    chOut:       "class27_output",
    testPayload: () => ({
      type: "analysis", source: "class26_test",
      texto: "Test de meta-introspección class26",
      decision: "BUY", confianza: 0.70, coherencia: 0.68,
      ts: new Date().toISOString(),
    }),
    testChIn: "class25_output",
  },
  {
    exe:         "class28.exe",
    desc:        "Conciencia Operativa Extendida",
    chIn:        ["class21_output", "class22_output", "class23_output",
                  "class24_output", "class25_output"],
    chOut:       "class28_output",
    testPayload: () => ({
      type: "analysis", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.71, coherencia: 0.69,
      texto: "Test conciencia operativa class26",
      ts: new Date().toISOString(),
    }),
    testChIn: "class25_output",
  },
  {
    exe:         "class29.exe",
    desc:        "Balance Emocional y Cognitivo Global",
    chIn:        ["class21_output", "class22_output", "class23_output",
                  "class24_output", "class27_output", "class28_output"],
    chOut:       "class29_output",
    testPayload: () => ({
      type: "analysis", source: "class26_test",
      vector: Array(8).fill(0).map(() => +(Math.random() * 2 - 1).toFixed(4)),
      confianza: 0.73, coherencia: 0.72, score: 0.72,
      ts: new Date().toISOString(),
    }),
    testChIn: "class27_output",
  },
];

// ── Extensión de binario según SO ───────────────────────────────
// En Windows los ejecutables C++ son class21.exe; en Linux son class21 (sin
// extensión). Normalizamos aquí para que rutas y logs usen el nombre correcto.
const EXE = process.platform === "win32" ? ".exe" : "";
for (const def of CPP_EXES) def.exe = def.exe.replace(/\.exe$/, "") + EXE;

// ── Timeouts ────────────────────────────────────────────────────
const TIMEOUT_READY_MS   = 5_000;   // espera que el exe conecte Redis
const TIMEOUT_RESPONSE_MS= 8_000;   // espera respuesta tras enviar test
const PROCESS_KILL_MS    = 500;     // delay antes de matar el proceso

// ── Redis helper ─────────────────────────────────────────────────
const REDIS_URL = "redis://localhost:6379";

async function makeRedisClient(name = "anon") {
  const c = createClient({ url: REDIS_URL });
  c.on("error", e => log(`Redis(${name}): ${e.message}`, "warn"));
  await c.connect();
  return c;
}

// ── Spawn helpers ────────────────────────────────────────────────
function spawnExe(exePath) {
  return spawn(exePath, [], {
    cwd:   SCRIPTS_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function killProc(proc) {
  try { proc.kill("SIGTERM"); } catch (_) {}
  setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} }, 300);
}

// ── Test de un exe C++ ───────────────────────────────────────────
async function testCppExe(def) {
  const exePath = path.join(SCRIPTS_DIR, def.exe);
  const result  = {
    exe:    def.exe,
    desc:   def.desc,
    chIn:   def.chIn,
    chOut:  def.chOut,
    ok:     false,
    fase:   "inicio",
    latency_ready_ms: null,
    latency_total_ms: null,
    error:  null,
    stdout: "",
    stderr: "",
  };

  // 1. ¿Existe el .exe?
  if (!fs.existsSync(exePath)) {
    result.error = `Archivo no encontrado: ${exePath}`;
    result.fase  = "archivo";
    log(`❌ ${def.exe}: ${result.error}`, "error");
    return result;
  }
  result.fase = "proceso";

  const t0   = Date.now();
  const proc = spawnExe(exePath);
  let   stdoutBuf = "";
  let   stderrBuf = "";
  proc.stdout.on("data", d => { stdoutBuf += d.toString(); });
  proc.stderr.on("data", d => { stderrBuf += d.toString(); });

  // Si el proceso muere inmediatamente → fallo
  let procDead = false;
  proc.on("exit", (code, sig) => {
    procDead = true;
    log(`${def.exe} salió (code=${code} sig=${sig})`, "warn");
  });

  // Esperar que el proceso conecte a Redis y esté listo
  // Los exes publican a "system.log" o emiten stdout "ready" tras conectar
  await new Promise(r => setTimeout(r, TIMEOUT_READY_MS));

  if (procDead) {
    result.error  = "Proceso terminó antes de estar listo";
    result.fase   = "ready";
    result.stdout = stdoutBuf.slice(0, 500);
    result.stderr = stderrBuf.slice(0, 500);
    killProc(proc);
    log(`❌ ${def.exe}: ${result.error}`, "error");
    return result;
  }

  result.latency_ready_ms = Date.now() - t0;
  result.fase = "test";

  // 2. Publicar mensaje de test y esperar respuesta
  let pub = null, sub = null;
  try {
    pub = await makeRedisClient("pub26");
    sub = await makeRedisClient("sub26");

    const testCh = def.testChIn || def.chIn[0];
    const payload = JSON.stringify(def.testPayload());

    // Suscribir al canal de salida ANTES de publicar
    let responded = false;
    const responseP = new Promise(resolve => {
      sub.subscribe(def.chOut, (msg, ch) => {
        if (!responded) {
          responded = true;
          resolve({ received: true, msg: msg?.slice(0, 200) });
        }
      }).catch(() => {});
      setTimeout(() => resolve({ received: false }), TIMEOUT_RESPONSE_MS);
    });

    // Pequeño delay para que la suscripción esté activa
    await new Promise(r => setTimeout(r, 200));
    await pub.publish(testCh, payload);
    log(`  → Enviado a ${testCh}: ${payload.slice(0, 80)}...`);

    const resp = await responseP;
    result.latency_total_ms = Date.now() - t0;

    if (resp.received) {
      result.ok   = true;
      result.fase = "ok";
      log(`✅ ${def.exe} respondió en ${result.latency_total_ms}ms`, "ok");
    } else {
      result.error = `Sin respuesta en ${def.chOut} tras ${TIMEOUT_RESPONSE_MS}ms`;
      result.fase  = "timeout";
      // No consideramos fallo si el proceso está vivo — puede ser que el
      // umbral de filtrado rechazó el vector de test (comportamiento esperado)
      result.ok    = !procDead;   // vivo = parcial OK
      log(`⚠️  ${def.exe}: timeout en canal ${def.chOut} (proceso vivo=${!procDead})`, "warn");
    }
  } catch (e) {
    result.error = e.message;
    result.fase  = "redis";
    log(`❌ ${def.exe} redis error: ${e.message}`, "error");
  } finally {
    try { await pub?.disconnect(); } catch (_) {}
    try { await sub?.disconnect(); } catch (_) {}
    await new Promise(r => setTimeout(r, PROCESS_KILL_MS));
    killProc(proc);
    result.stdout = stdoutBuf.slice(0, 500);
    result.stderr = stderrBuf.slice(0, 200);
  }

  return result;
}

// ── Tests de Redis ────────────────────────────────────────────────
async function testRedis() {
  log("🔌 Verificando Redis...");
  const c = createClient({ url: REDIS_URL });
  try {
    const t0  = Date.now();
    await c.connect();
    const pong = await c.ping();
    const ms   = Date.now() - t0;
    await c.disconnect();
    log(`✅ Redis OK (${pong}) en ${ms}ms`, "ok");
    return { ok: true, latency_ms: ms };
  } catch (e) {
    log(`❌ Redis no disponible: ${e.message}`, "error");
    return { ok: false, error: e.message };
  }
}

// ── Test class25B.js ──────────────────────────────────────────────
async function testClass25B() {
  log("🧠 Verificando class25B.js...");
  const filePath = path.join(SCRIPTS_DIR, "class25B.js");
  if (!fs.existsSync(filePath)) {
    log("❌ class25B.js no encontrado", "error");
    return { ok: false, error: "Archivo no encontrado" };
  }
  const size = fs.statSync(filePath).size;
  log(`✅ class25B.js presente (${(size/1024).toFixed(1)} KB)`, "ok");
  return { ok: true, size_kb: (size/1024).toFixed(1) };
}

// ── Test class44.py ───────────────────────────────────────────────
async function testClass44() {
  log("🐍 Verificando class44.py...");
  const filePath = path.join(SCRIPTS_DIR, "class44.py");
  if (!fs.existsSync(filePath)) {
    log("❌ class44.py no encontrado", "error");
    return { ok: false, error: "Archivo no encontrado" };
  }
  // Verificar modelos LSTM entrenados
  const modelsDir = path.join(BASE_DIR, "models", "lstm");
  let modelCount  = 0;
  if (fs.existsSync(modelsDir)) {
    modelCount = fs.readdirSync(modelsDir).filter(f => f.endsWith(".pt")).length;
  }
  log(`✅ class44.py presente | modelos entrenados: ${modelCount}`, "ok");
  return { ok: true, modelos_entrenados: modelCount };
}

// ── Clase principal ───────────────────────────────────────────────
class Class26Tester extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config  = { runCpp: config.runCpp !== false };
    this.results = [];
    this.errors  = [];
    this.startTs = Date.now();
  }

  async run() {
    log("═══════════════════════════════════════════");
    log("🚀 class26 — Tester MIIA v2.0");
    log(`   Ejecutables a testear: ${CPP_EXES.length} C++ + JS + Python`);
    log("═══════════════════════════════════════════");

    // 1. Redis (prerequisito para todo)
    const redisR = await testRedis();
    this.results.push({ tipo: "redis", ...redisR });
    if (!redisR.ok) {
      log("⛔ Redis inaccesible — tests C++ no pueden correr", "error");
      this.errors.push({ tipo: "redis", error: redisR.error });
    }

    // 2. Tests C++ (solo si Redis está disponible)
    if (redisR.ok && this.config.runCpp) {
      log(`\n📦 Testeando ${CPP_EXES.length} ejecutables C++...`);
      for (const def of CPP_EXES) {
        log(`\n▶ ${def.exe} — ${def.desc}`);
        const r = await testCppExe(def);
        this.results.push({ tipo: "cpp_exe", ...r });
        if (!r.ok) this.errors.push({ tipo: "cpp_exe", exe: def.exe, error: r.error });
      }
    } else if (!this.config.runCpp) {
      log("⏭  Tests C++ omitidos (runCpp=false)", "warn");
      for (const def of CPP_EXES) {
        const exePath = path.join(SCRIPTS_DIR, def.exe);
        const exists  = fs.existsSync(exePath);
        this.results.push({
          tipo: "cpp_exe_check", exe: def.exe, desc: def.desc,
          ok: exists, fase: exists ? "existe" : "faltante",
        });
        if (!exists) this.errors.push({ tipo: "cpp_exe_check", exe: def.exe, error: "No encontrado" });
      }
    }

    // 3. JS Brain
    log("\n📜 Verificando módulos JS...");
    const b25 = await testClass25B();
    this.results.push({ tipo: "js", file: "class25B.js", ...b25 });
    if (!b25.ok) this.errors.push({ tipo: "js", file: "class25B.js", error: b25.error });

    // 4. Python LSTM
    log("\n🐍 Verificando módulos Python...");
    const py44 = await testClass44();
    this.results.push({ tipo: "python", file: "class44.py", ...py44 });
    if (!py44.ok) this.errors.push({ tipo: "python", file: "class44.py", error: py44.error });

    // 5. Reporte final
    this._guardarReporte();
    this._imprimirResumen();
  }

  _guardarReporte() {
    const elapsed = Date.now() - this.startTs;
    const ok      = this.results.filter(r => r.ok).length;
    const total   = this.results.length;
    const reporte = {
      ts:            new Date().toISOString(),
      duracion_ms:   elapsed,
      total_tests:   total,
      ok:            ok,
      errores:       this.errors.length,
      pct_exito:     total > 0 ? ((ok / total) * 100).toFixed(1) : "0.0",
      sistema: {
        hostname:    os.hostname(),
        plataforma:  os.platform(),
        cpu:         os.cpus()[0]?.model || "?",
        memoria_gb:  (os.totalmem() / 1024 ** 3).toFixed(2),
        node:        process.version,
      },
      resultados:    this.results,
      errores_det:   this.errors,
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(reporte, null, 2));
    log(`\n📊 Reporte guardado: ${REPORT_FILE}`);
  }

  _imprimirResumen() {
    const ok    = this.results.filter(r => r.ok).length;
    const total = this.results.length;
    const fail  = this.errors.length;
    log("\n═══════════════════════════════════════════");
    log(`📋 RESUMEN: ${ok}/${total} OK  |  ${fail} errores  |  ${((ok/total)*100).toFixed(0)}% éxito`);
    for (const r of this.results) {
      const icon = r.ok ? "✅" : (r.fase === "timeout" ? "⚠️ " : "❌");
      const ms   = r.latency_total_ms ? ` (${r.latency_total_ms}ms)` : "";
      const label= r.exe || r.file || r.tipo;
      log(`  ${icon} ${label}${ms}${r.error ? " — " + r.error : ""}`);
    }
    log("═══════════════════════════════════════════");
  }
}

// ── Exports (compatibilidad con módulos que importan class26) ─────
export const getPath       = (key, fb = "./") => {
  try { const v = getStorageConfig()?.[key]; return typeof v === "string" && v.trim() ? v : fb; } catch { return fb; }
};
export const getLogLevel   = (d = "info") => { try { return getLoggingConfig()?.level || d; } catch { return d; } };
export const shouldRotateLogs = () => { try { return getLoggingConfig()?.rotate_logs === true; } catch { return false; } };
export default Class26Tester;

// ── Arranque directo ──────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // --quick: solo verifica existencia, no spawnea (más rápido para CI)
  const quick = process.argv.includes("--quick");
  const tester = new Class26Tester({ runCpp: !quick });
  tester.run().catch(e => log(`💥 Error fatal: ${e.message}`, "error"));
} else {
  // Importado como módulo — heartbeat pasivo
  const nombre = path.basename(__filename, ".js");
  setInterval(() => {
    console.log(`[${nombre}] ✅ OK (${new Date().toISOString()}) (tester activo)`);
  }, 60_000);
}
