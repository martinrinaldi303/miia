// ==========================================================
// index.js — ORQUESTADOR GENERAL MIIA v2.0
// Cambios vs v1.9:
//   1. startCppModules() lanza class21-24, class27-29 como .exe
//   2. startJSModules() excluye class21-29 (reemplazadas por C++)
//   3. class25 DIVIDIDA: class25A (C++ cuantitativo) + class25B (JS lingüístico)
//   4. class25A en CPP_MODULES, class25B lanzada explícitamente
//   5. cerrarCanalesRedis() definida antes de SIGINT
// ==========================================================

import { spawn, spawnSync } from "child_process";
import fs               from "fs";
import path             from "path";
import { randomUUID }   from "crypto";
import { createClient } from "redis";
import chalk            from "chalk";
import http             from "http";
import express          from "express";
import { WebSocketServer } from "ws";
import fetch            from "node-fetch";
import { fileURLToPath } from "url";

import {
  loadConfigs,
  enableConfigWatcher,
  getConfig,
  getSystemConfig
} from "../scripts/class38.js";

// ==========================================================
// LIMPIEZA DE LOGS
// ==========================================================
function cleanupLogs() {
  const cfg    = getConfig("cleanup")?.cleanup || {};
  const enabled  = (cfg.enabled    ?? "true").toString().toLowerCase() === "true";
  const delStart = (cfg.delete_on_start ?? "true").toString().toLowerCase() === "true";
  if (!enabled || !delStart) return;

  const maxAge  = parseInt(cfg.max_age_days ?? 5);
  const maxFiles = parseInt(cfg.max_files   ?? 100);
  const paths    = (cfg.paths      ?? "logs").split(";").map(p => p.trim());
  const exts     = (cfg.extensions ?? ".log").split(";").map(e => e.trim());
  const now = Date.now();
  const ageLimit = maxAge * 86400 * 1000;

  paths.forEach(relPath => {
    const full = path.join(process.cwd(), relPath);
    if (!fs.existsSync(full)) return;
    let files = fs.readdirSync(full)
      .filter(f => exts.some(e => f.endsWith(e)))
      .map(f => ({ name: f, path: path.join(full, f), time: fs.statSync(path.join(full, f)).mtimeMs }))
      .sort((a, b) => a.time - b.time);
    files.forEach(f => { if (now - f.time > ageLimit) try { fs.unlinkSync(f.path); } catch {} });
    files = files.filter(f => fs.existsSync(f.path));
    while (files.length > maxFiles) { try { fs.unlinkSync(files.shift().path); } catch {} }
  });
}
cleanupLogs();

// ==========================================================
// CONFIGURACIÓN
// ==========================================================
const configState = (() => { try { const c = loadConfigs(); return c && typeof c === "object" ? c : {}; } catch { return {}; } })();
try { enableConfigWatcher(); console.log("🔁 Watcher de configuración activo."); } catch (e) { console.error("⚠️ Watcher no disponible:", e.message); }

const systemConfig  = getSystemConfig() || {};
const MIIA_VERSION  = systemConfig.version || "2.0.0";
const MAX_SAFE_LOAD = systemConfig.max_load || 0.85;
const PROJECT_NAME  = systemConfig.name || "MIIA System";

// ==========================================================
// RUTAS BASE
// ==========================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const rootDir    = path.resolve(__dirname, "..");
const scriptsDir = path.join(rootDir, "scripts");
const motoresDir = path.join(rootDir, "MIIA_MotoresVectoriales");
const miiaDir    = path.join(rootDir, "MIIA");
const redisDir   = path.join(rootDir, "redis");
const logsDir    = path.join(rootDir, "logs");

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ==========================================================
// PLATAFORMA — Windows vs Linux/Mac
// MIIA se desarrolló en Windows (XAMPP + binarios .exe) pero corre igual en
// Linux (servidor Ubuntu). Este bloque abstrae las diferencias de SO:
//   · binarios C++:  class21.exe (Win)  → class21 (Linux, sin extensión)
//   · Redis:  redis/redis-server.exe (Win) → redis-server del sistema (Linux)
//   · MySQL:  C:/xampp/mysql/bin/*.exe (Win) → mysql/mysqld/... del PATH (Linux)
//   · Python: "python" (Win) → "python3" (Linux)
//   · matar procesos: taskkill (Win) → SIGTERM a los hijos rastreados (Linux)
// ==========================================================
const IS_WIN     = process.platform === "win32";
const EXE        = IS_WIN ? ".exe" : "";                              // sufijo de ejecutables C++
// Intérprete Python. El venv del proyecto GANA sobre el del sistema, en los dos
// sistemas operativos.
//
// La rama de Windows estaba hardcodeada a "python", o sea el intérprete global.
// Ese no tiene instalado requirements.txt (fastapi, torch, aiomysql…), así que
// app.py arrancaba y moría por ImportError — y como se lanza con startProcess,
// el fallo quedaba en el log de un hijo en vez de cortar el arranque.
//
// Lo que cambia por plataforma es la RUTA del venv (Scripts\python.exe contra
// bin/python3), no el criterio. El comportamiento en Linux es el mismo de antes.
const PYTHON_BIN = process.env.PYTHON_BIN || (() => {
  const venv = IS_WIN
    ? path.join(__dirname, "..", "MIIA", "venv", "Scripts", "python.exe")
    : path.join(__dirname, "..", "MIIA", "venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return IS_WIN ? "python" : "python3";
})();

// En Linux, un binario debe tener el bit de ejecución (+x) o spawn falla con
// EACCES. CMake lo deja bien, pero un tar/scp/copia puede quitarlo — así que lo
// garantizamos antes de lanzar cada ejecutable C++. En Windows es no-op.
function ensureExec(p) {
  if (IS_WIN) return;
  try { fs.chmodSync(p, 0o755); } catch (_) {}
}

// ==========================================================
// LOGGER
// ==========================================================
let wss = null;

function log(msg, tipo = "info") {
  try {
    const ts   = new Date().toISOString();
    const line = `[${ts}] [${tipo.toUpperCase()}] ${msg}\n`;
    fs.appendFileSync(path.join(logsDir, "index.log"), line);
    const color = tipo === "error" ? chalk.red : tipo === "warn" ? chalk.yellow : chalk.cyan;
    console.log(color(line.trim()));
    wss?.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: tipo, msg })); });
  } catch (e) { console.error("[LOGGER ERROR]", e.message); }
}

// ==========================================================
// RED DE SEGURIDAD GLOBAL
// ==========================================================
// Hasta el 26-ago-2026 el orquestador no tenía ninguna: cualquier error
// asincrónico sin capturar —de Redis o de donde fuera— mataba el proceso
// entero. pm2 lo levantaba solo, pero cada reinicio cuesta ~48 h de
// entrenamiento supervisado de class23/24, porque el buffer `pending` no se
// persiste (decisión deliberada: son cientos de MB y se reponen dentro del
// TTL de 80 h). O sea: el precio de morir no es el downtime, es el hueco en
// el experimento.
//
// Se registra ACÁ, apenas definido log(), y no al final del archivo: así
// cubre también los errores del arranque.
//
// Se loguea y se SIGUE, en vez de morir. El riesgo conocido de tragarse un
// uncaughtException es quedar en un estado inconsistente; la mitigación es
// dejarlo ruidoso y contable — el tag [NO CAPTURADO] es greppeable y
// medicion_viernes.sh lo cuenta todas las semanas. Si aparece seguido no es
// una excepción para ignorar: es un bug para arreglar.
process.on("uncaughtException", (e) => {
  log(`🛑 [NO CAPTURADO] ${e?.stack || e?.message || e}`, "error");
});
process.on("unhandledRejection", (r) => {
  log(`🛑 [NO CAPTURADO] promesa rechazada: ${r?.stack || r?.message || r}`, "error");
});

// ==========================================================
// PROGRESO
// ==========================================================
let progress = 0;
function showProgress(label, inc = 10) {
  progress = Math.min(progress + inc, 100);
  const filled = Math.round(progress / 10);
  const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(10 - filled));
  console.log(`\n[${bar}] ${progress}% — ${label}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==========================================================
// GESTOR DE PROCESOS
// ==========================================================
const activeProcesses = {};

// Módulos que se reinician solos si caen
const CRITICAL_LABELS = new Set([
  "REDIS", "PYTHON", "MOTORVECTORIAL",
  // class1 = buscador de noticias: crítico para que no se corte el feed de noticias
  "CLASS1",
  // class25 reemplazada por class25A (C++) + class25B (JS)
  "CLASS25A", "CLASS25B",
  // C++ — también críticos
  "CLASS21", "CLASS22", "CLASS23", "CLASS24",
  "CLASS27", "CLASS28", "CLASS29",
  // class43 = motor de backtesting y verificación (30-ago-2026).
  // Estaba fuera de la lista, con dos consecuencias:
  //   1. Si moría, la verificación de señales se apagaba EN SILENCIO. Nada
  //      la volvía a levantar hasta el próximo reinicio completo, y el único
  //      síntoma era que `verificadas` dejaba de crecer — invisible salvo
  //      que alguien mirara la medición del viernes.
  //   2. No se podía desplegar de forma quirúrgica: matar el proceso para
  //      que tomara código nuevo lo dejaba muerto, así que cualquier cambio
  //      en class43 obligaba a reiniciar el orquestador entero (48 h de
  //      entrenamiento perdidas por un archivo).
  "CLASS43",
  // class9, class11, class14 y class32 (8-oct-2026). El 7-oct a las 06:31:53
  // unattended-upgrades actualizó redis-server, su instalador reinició Redis
  // y los cuatro murieron EN EL MISMO SEGUNDO con code=1: crean sus clientes
  // de Redis sin .on("error"), así que el SocketClosedUnexpectedlyError los
  // tumba. Quedaron muertos 30 h sin que nada avisara. Desde el corte,
  // class11 publica el impacto POR INSTRUMENTO y es una de las claves con
  // las que class25A ordena: si muere, el ensamble cambia de composición en
  // mitad de la medición. class34 queda AFUERA a propósito: hace un volcado
  // completo de la base al arrancar, y en un ciclo de respawn no pararía.
  "CLASS9", "CLASS11", "CLASS14", "CLASS32"
]);

function startProcess(cmd, args, label, cwd = rootDir, extraEnv = {}) {
  if (activeProcesses[label]) {
    log(`[${label}] ya activo — ignorando`, "warn");
    return activeProcesses[label];
  }

  const proc = spawn(cmd, args, {
    cwd,
    shell: false,   // binarios nativos y comandos del PATH (node/python3/redis-server) resuelven sin shell
    env: { ...process.env, ...extraEnv }
  });

  activeProcesses[label] = proc;
  log(`🚀 [${label}] PID ${proc.pid}`);

  proc.stdout?.on("data", d => log(`[${label}] ${d.toString().trim()}`));
  proc.stderr?.on("data", d => log(`[${label}] ${d.toString().trim()}`, "warn"));

  // Si el proceso NO se pudo lanzar (binario inexistente o sin permiso +x en
  // Linux → ENOENT/EACCES), Node emite "error" y NO emite "exit". Sin este
  // handler la excepción quedaba sin capturar y podía tumbar el orquestador.
  proc.on("error", err => {
    log(`[${label}] no se pudo iniciar: ${err.code || err.message}`, "error");
    if (activeProcesses[label] === proc) delete activeProcesses[label];
    if (CRITICAL_LABELS.has(label.toUpperCase()) && g_running) {
      log(`[${label}] reintento en 8s`, "warn");
      setTimeout(() => reintentar(cmd, args, label, cwd, extraEnv), 8000);
    }
  });

  proc.on("exit", (code, signal) => {
    log(`[${label}] finalizó (code=${code} signal=${signal || "none"})`, "warn");
    if (activeProcesses[label] === proc) delete activeProcesses[label];

    if (CRITICAL_LABELS.has(label.toUpperCase()) && g_running) {
      log(`[${label}] reinicio en 8s`, "warn");
      setTimeout(() => reintentar(cmd, args, label, cwd, extraEnv), 8000);
    }
  });

  return proc;
}

// Flag global para evitar reinicios durante el apagado
let g_running = true;

// ¿El Redis que corre es HIJO nuestro? Se pone en true sólo si lo spawneamos.
// Si reutilizamos el de systemd queda en false y nunca se lo adopta.
let g_redisPropio = false;

// ── El respawn se decide AL DISPARAR, no al programar (11-oct-2026) ─────
//
// Pedido de Martín: que el orquestador no tumbe un Redis que está andando ni
// genere generaciones nuevas ni procesos zombis. `startRedis()` ya reutilizaba
// el Redis vivo y el monitor ya tenía su comentario de por qué NO lo relanza
// (Bug 2). Faltaba el tercer camino, que es el que de verdad hace el bucle:
//
//   1. MIIA arranca mientras systemd reinicia redis-server —el escenario real
//      del 7-oct, con `unattended-upgrade` actualizando el paquete—, los 10
//      pings fallan y MIIA spawnea SU propio redis-server.
//   2. systemd termina y toma el puerto 6379.
//   3. El Redis hijo no puede retenerlo y sale.
//   4. REDIS está en CRITICAL_LABELS → respawn a los 8 s → no puede bindear →
//      sale → respawn… **un proceso que muere cada 8 segundos para siempre**,
//      10.800 por día, y ninguno de los dos Redis es claramente el dueño.
//
// Y había un segundo generador de huérfanos, para cualquier módulo crítico:
// `g_running` se leía al PROGRAMAR el setTimeout, no al dispararlo. Un módulo
// que moría en los 8 s previos al apagado se relanzaba DESPUÉS de apagar todo,
// y quedaba vivo fuera de `activeProcesses` — justo lo que después obliga a
// `limpiarHuerfanos()` en el arranque siguiente.
function reintentar(cmd, args, label, cwd, extraEnv) {
  // (a) ¿seguimos vivos? Si el apagado empezó en estos 8 s, no se relanza nada.
  if (!g_running) {
    log(`[${label}] el apagado ya empezó — no se relanza`, "warn");
    return;
  }
  // (b) ¿alguien más ya sirve lo que este módulo iba a servir?
  if (label.toUpperCase() === "REDIS" && redisResponde()) {
    log("🧩 REDIS murió pero el puerto 6379 lo sigue sirviendo otro "
      + "(systemd) — NO se relanza: node-redis reconecta solo", "warn");
    g_redisPropio = false;
    return;
  }
  startProcess(cmd, args, label, cwd, extraEnv);
}

// ==========================================================
// REDIS
// ==========================================================
const redisUrl = "redis://localhost:6379";

// ¿Redis ya está respondiendo? (evita levantar una 2ª instancia sobre el
// servicio systemd en Linux, o sobre un redis ya abierto en Windows)
function redisResponde() {
  try {
    const cli = IS_WIN ? path.join(redisDir, "redis-cli.exe") : "redis-cli";
    const r = spawnSync(cli, ["-p", "6379", "ping"], { timeout: 3000, encoding: "utf8" });
    return /PONG/i.test(r.stdout || "");
  } catch { return false; }
}

async function startRedis() {
  // Si ya hay un Redis vivo (p.ej. servicio del sistema), no lanzar otro.
  //
  // REINTENTOS (26-ago-2026): cuando needrestart reinicia media máquina por
  // una actualización de libssl, MIIA y redis-server arrancan en el MISMO
  // segundo — verificado, los dos a las 06:32:55. Un único ping puede caer
  // justo en la ventana en que systemd todavía no levantó el suyo, y ahí
  // MIIA spawnearía un Redis propio que después le pelea el puerto al de
  // systemd. En el arranque normal el primer intento acierta y esto no
  // cuesta absolutamente nada.
  for (let intento = 1; intento <= 10; intento++) {
    if (redisResponde()) {
      log(intento === 1
        ? "🧩 Redis ya está corriendo — reutilizando, no se lo toca"
        : `🧩 Redis respondió al intento ${intento} — reutilizando, no se lo toca`);
      g_redisPropio = false;
      return;
    }
    // Cada redisResponde() es un spawnSync de redis-cli que, con el puerto
    // cerrado, tarda ~2 s en volver: los "10 intentos" son ~30 s de reloj, no
    // 10. Sin esta línea la consola se queda muda todo ese rato y parece
    // colgada — el 26-sep eso llevó a cortar el arranque con Ctrl+C dos veces.
    if (intento < 10) {
      log(`⏳ Redis no responde todavía (${intento}/10) — reintentando`);
      await sleep(1000);
    }
  }
  log("⏳ Redis no respondió — se intenta levantarlo", "warn");

  // Windows: binario embebido en redis/redis-server.exe
  const local = path.join(redisDir, "redis-server" + EXE);
  if (fs.existsSync(local)) {
    log(`🧩 Iniciando Redis → ${local}`);
    g_redisPropio = true;
    return startProcess(local, [], "REDIS", redisDir, { REDIS_URL: redisUrl });
  }
  // Linux/Mac: redis-server del sistema (apt install redis-server)
  if (!IS_WIN) {
    log("🧩 Iniciando Redis del sistema (redis-server) — como HIJO de MIIA");
    g_redisPropio = true;
    // El `--pidfile` bajo rootDir no es decorativo: `limpiarHuerfanos()` busca
    // con `pgrep -f "${rootDir}/"`, y la línea de comando de un
    // `redis-server --port 6379` pelado NO contiene rootDir. O sea que un Redis
    // hijo que sobreviviera a una caída del orquestador quedaba invisible para
    // la limpieza del arranque siguiente, reteniendo el puerto sin dueño. Con la
    // ruta en los argumentos, el pgrep lo encuentra y lo limpia. Al de systemd
    // no lo toca nunca: su cmdline es /usr/bin/redis-server, sin rootDir.
    return startProcess("redis-server",
      ["--port", "6379", "--pidfile", path.join(rootDir, "redis-miia.pid")],
      "REDIS", rootDir, { REDIS_URL: redisUrl });
  }
  log("⚠️ redis-server no encontrado — asumiendo Redis ya corriendo", "warn");
}

// ==========================================================
// MYSQL (XAMPP) — arranque verificado + cierre limpio
// Los apagados bruscos corrompen las tablas Aria de privilegios
// (mysql.db) y el GRANT sobre miia_cognitiva se PIERDE aunque la
// auto-reparación de Aria (my.ini) repare la tabla. Defensa doble:
//   1. Al ARRANCAR: asegurarMySQL() levanta mysqld si hace falta y
//      re-aplica los permisos (idempotente) ANTES de iniciar motores.
//   2. Al APAGAR: cerrarMySQL() hace shutdown limpio (mysqladmin)
//      para que Aria/InnoDB persistan sus páginas sin corromperse.
// ==========================================================
// Windows: binarios de XAMPP con ruta absoluta y .exe.
// Linux:   mysql/mysqld/mysqladmin del PATH (apt install mysql-server mysql-client).
const MYSQL_DIR   = process.env.MYSQL_BIN_DIR || (IS_WIN ? "C:/xampp/mysql/bin" : "");
const MYSQL_EXE   = IS_WIN ? path.join(MYSQL_DIR, "mysql.exe")      : "mysql";
const MYSQLD_EXE  = IS_WIN ? path.join(MYSQL_DIR, "mysqld.exe")     : "mysqld";
const MYSQLADMIN  = IS_WIN ? path.join(MYSQL_DIR, "mysqladmin.exe") : "mysqladmin";
const REPARAR_SQL = path.join(rootDir, "operador", "aprendizaje", "config", "reparar_permisos_mysql.sql");
// root local sin contraseña; en el servidor definir DB_ROOT_PASS en config/.env
const _rootArgs   = () => process.env.DB_ROOT_PASS ? [`-p${process.env.DB_ROOT_PASS}`] : [];

// ¿El cliente mysql está disponible? (en Win = ruta .exe; en Linux = está en PATH)
function mysqlBinDisponible() {
  if (IS_WIN) return fs.existsSync(MYSQL_EXE);
  try { return spawnSync(MYSQL_EXE, ["--version"], { timeout: 5000 }).status === 0; }
  catch { return false; }
}

function mysqlResponde() {
  try {
    const r = spawnSync(MYSQLADMIN, ["-u", "root", ..._rootArgs(), "ping"], { timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}

async function asegurarMySQL() {
  if (!mysqlBinDisponible()) {
    log("⚠️ Cliente MySQL no encontrado — se asume servicio externo ya gestionado", "warn");
    return;
  }
  if (!mysqlResponde()) {
    if (IS_WIN) {
      log("🗄️ MySQL no responde — iniciando mysqld (XAMPP)...");
      // Label NO crítico: si muere no se auto-reinicia (evita doble instancia
      // con el panel de XAMPP, que también corrompe las tablas Aria)
      startProcess(MYSQLD_EXE,
        [`--defaults-file=${path.join(MYSQL_DIR, "my.ini")}`, "--standalone"],
        "MYSQL", MYSQL_DIR);
    } else {
      // Linux: MySQL/MariaDB corre como servicio del sistema (systemd). No lo
      // lanzamos nosotros; avisamos para que se arranque con systemctl.
      log("🗄️ MySQL no responde. En Linux arrancá el servicio: sudo systemctl start mysql (o mariadb)", "warn");
    }
    for (let i = 0; i < 15 && !mysqlResponde(); i++) await sleep(2000);
  }
  if (!mysqlResponde()) {
    log("❌ MySQL no arrancó — los motores quedarán en modo degradado", "error");
    return;
  }
  // Re-aplicar permisos SIEMPRE (idempotente): si un corte de luz corrompió
  // mysql.db y la auto-reparación descartó los GRANT, acá se restauran antes
  // de que cualquier motor intente conectarse.
  try {
    const sql = fs.readFileSync(REPARAR_SQL, "utf8");
    const r = spawnSync(MYSQL_EXE,
      ["-u", "root", ..._rootArgs(), "--default-character-set=utf8mb4"],
      { input: sql, timeout: 20000 });
    if (r.status === 0) log("🗄️ MySQL OK — permisos de miia_cognitiva verificados/restaurados");
    else log(`⚠️ Verificación de permisos MySQL: ${String(r.stderr || "").slice(0, 150)}`, "warn");
  } catch (e) { log(`⚠️ asegurarMySQL: ${e.message}`, "warn"); }
}

async function cerrarMySQL() {
  // Linux: MySQL es un servicio del sistema (systemd); NO lo apagamos al cerrar
  // MIIA — otros servicios podrían usarlo y systemd lo gestiona.
  if (!IS_WIN) return;
  if (!fs.existsSync(MYSQLADMIN) || !mysqlResponde()) return;
  log("🗄️ Cerrando MySQL de forma limpia (mysqladmin shutdown)...");
  try {
    spawnSync(MYSQLADMIN, ["-u", "root", ..._rootArgs(), "shutdown"], { timeout: 15000 });
    // Esperar a que termine de persistir (flush de Aria/InnoDB)
    for (let i = 0; i < 10 && mysqlResponde(); i++) await sleep(1000);
    log("🗄️ MySQL cerrado correctamente — tablas persistidas sin riesgo de corrupción");
  } catch (e) { log(`⚠️ cerrarMySQL: ${e.message}`, "warn"); }
}

// ==========================================================
// MÓDULOS JS
// Excluye class21-29 (reemplazadas por C++) y class25 (lanzado aparte)
// ==========================================================

// Clases migradas a C++ — NO lanzar como JS
const CLASES_CPP = new Set([21, 22, 23, 24, 27, 28, 29]);

// Clases que son testers one-shot o utilidades importadas — NO corren como servicios
// class38 es un helper de config (importado, no ejecutable standalone)
// class8/12/16/20 son hot-flow testers (salen con code=0 al terminar)
// class26 es el tester de ejecutables C++ (one-shot)
const CLASES_NO_SERVICIO = new Set([8, 12, 16, 20, 26, 38]);

// class48 se lanza explícitamente después del resto para que los motores
// tengan tiempo de arrancar antes de que el monitor evalúe por primera vez

function startJSModules() {
  if (!fs.existsSync(scriptsDir)) { log("❌ scripts/ no encontrado", "error"); return; }

  const jsFiles = fs.readdirSync(scriptsDir)
    .filter(f => {
      if (!/^class(\d+)\.js$/.test(f)) return false;
      if (f === "index.js" || f === "class25.js" || f === "class25B.js") return false;
      const num = parseInt(f.match(/\d+/)[0]);
      if (CLASES_CPP.has(num))          return false;  // ya hay .exe para estas
      if (CLASES_NO_SERVICIO.has(num))  return false;  // testers / utilidades
      return true;
    });

  log(`⚙️ Iniciando ${jsFiles.length} módulos JS (C++/testers/class25 excluidos)`);

  jsFiles.forEach(f => {
    startProcess("node", [path.join(scriptsDir, f)],
      f.replace(".js", "").toUpperCase(), scriptsDir,
      { PYTHON_SERVER: "http://localhost:5005", REDIS_URL: redisUrl });
  });
}

// ==========================================================
// MÓDULOS C++ — class21-24, class27-29
// ==========================================================
// class25A se lanza explícitamente con startClass25A() — NO incluir aquí
// para evitar el doble arranque que producía "CLASS25A ya activo — ignorando"
const CPP_MODULES = [
  { name: "class21",  label: "CLASS21"  },
  { name: "class22",  label: "CLASS22"  },
  { name: "class23",  label: "CLASS23"  },
  { name: "class24",  label: "CLASS24"  },
  { name: "class27",  label: "CLASS27"  },
  { name: "class28",  label: "CLASS28"  },
  { name: "class29",  label: "CLASS29"  },
];

function startCppModules() {
  log("⚙️ Iniciando módulos cognitivos C++...");
  let iniciados = 0;

  for (const mod of CPP_MODULES) {
    const exePath = path.join(scriptsDir, `${mod.name}${EXE}`);

    if (!fs.existsSync(exePath)) {
      log(`⚠️ ${mod.name}${EXE} no encontrado en scripts/ — saltando`, "warn");
      if (IS_WIN)
        log(`   Para compilar (Windows/MinGW): cd miia_cognitive && cmake -G "MinGW Makefiles" -B build && cmake --build build`, "warn");
      else
        log(`   Para compilar (Linux): bash scripts/build_cpp_linux.sh`, "warn");
      continue;
    }

    ensureExec(exePath);   // Linux: garantizar +x antes de lanzar
    startProcess(exePath, [], mod.label, scriptsDir, { REDIS_URL: redisUrl });
    iniciados++;
  }

  log(`✅ ${iniciados}/${CPP_MODULES.length} módulos C++ iniciados`);
}

// ==========================================================
// class25A — Motor Cuantitativo C++ (reemplaza class25 numérico)
// Suscribe a class21-24 output, class40, class41
// Publica decisión estructurada + texto a class25a_output
// ==========================================================
function startClass25A() {
  const p = path.join(scriptsDir, "class25A" + EXE);
  if (!fs.existsSync(p)) {
    log(`❌ class25A${EXE} no encontrado — ${IS_WIN ? "cmake --build build --target class25A" : "bash scripts/build_cpp_linux.sh"}`, "error");
    return;
  }
  ensureExec(p);   // Linux: garantizar +x antes de lanzar
  log("⚡ Iniciando class25A (Motor Cuantitativo C++)");
  return startProcess(p, [], "CLASS25A", scriptsDir, { REDIS_URL: redisUrl });
}

// ==========================================================
// class25B — Motor Lingüístico JS (reemplaza class25 lingüístico)
// Depende de class25A: recibe de class25a_output
// Razona, enriquece con memoria semántica, publica a class25_output
// ==========================================================
function startClass25B() {
  const p = path.join(scriptsDir, "class25B.js");
  if (!fs.existsSync(p)) {
    log("❌ class25B.js no encontrado en scripts/", "error");
    return;
  }
  log("🧠 Iniciando class25B (Motor Lingüístico JS, heap 4GB)");
  return startProcess(
    "node",
    ["--max-old-space-size=4096", p],
    "CLASS25B",
    scriptsDir,
    {
      PYTHON_SERVER: "http://localhost:5005",
      REDIS_URL:     redisUrl,
    }
  );
}

// ==========================================================
// MOTOR VECTORIAL .NET
// ==========================================================
// `dotnet run` tenía dos problemas, los dos verificados en producción:
//
//   1. Corre en DEBUG. El deploy compila `dotnet build -c Release` y ese binario
//      NO se usaba nunca. Confirmado el 15-ago-2026: el proceso vivo era
//      /opt/miia/MIIA_MotoresVectoriales/bin/Debug/net9.0/MIIA_MotoresVectoriales
//
//   2. Es un WRAPPER: lanza MSBuild y después la app como hijo suyo. El PID que
//      rastrea `activeProcesses` es el del wrapper, así que el SIGTERM de
//      apagadoMaestro le llega a él y no siempre al hijo. Es el huérfano de
//      dotnet del 1-ago que hizo que el pgrep de verificación diera "OK sin
//      procesos" con el motor todavía corriendo.
//
// Ejecutar el DLL directo resuelve las dos: sin build implícito, sin capa
// intermedia, y el PID rastreado ES la app.
function startMotorVectorial() {
  const dll = path.join(motoresDir, "bin", "Release", "net9.0",
                        "MIIA_MotoresVectoriales.dll");
  if (fs.existsSync(dll)) {
    log("🧠 Iniciando motor vectorial (.NET Release)");
    return startProcess("dotnet", [dll], "MOTORVECTORIAL", motoresDir);
  }
  // Fallback al comportamiento viejo: si falta el Release, arrancar degradado
  // es mejor que no arrancar — pero queda dicho en el log por qué.
  const p = path.join(motoresDir, "Program.cs");
  if (fs.existsSync(p)) {
    log(`⚠️ Sin build Release (${dll}) — se cae a 'dotnet run' en Debug. ` +
        `Compilar con: dotnet build -c Release`, "warn");
    return startProcess("dotnet", ["run", "--project", motoresDir],
      "MOTORVECTORIAL", motoresDir);
  }
  log("⚠️ Program.cs no encontrado", "warn");
}

// ==========================================================
// PYTHON
// ==========================================================
function startPythonServer() {
  const p = path.join(miiaDir, "app.py");
  if (!fs.existsSync(p)) { log(`⚠️ app.py no encontrado → ${p}`, "warn"); return; }
  // app.py es el launcher Python: arranca miia_chatbot.py (puerto 5005) + class44.py
  log(`🐍 Iniciando flujo Python via app.py (${PYTHON_BIN})`);
  return startProcess(PYTHON_BIN, [p], "PYTHON", miiaDir, { REDIS_URL: redisUrl });
}

// silencioso=true: no loguear el fallo. Uvicorn tarda ~2-5s en levantar, así
// que durante el arranque el primer chequeo SIEMPRE fallaba y ensuciaba el log.
async function testPythonConnection(silencioso = false) {
  try {
    // `{ timeout: 3000 }` NO existe en node-fetch v3 (se quitó en la v3.0) y se
    // ignoraba en silencio: la petición quedaba sin límite. Con la API colgada
    // —no caída— esta promesa nunca resolvía, y como el monitor periódico la
    // llama cada 20 s sin esperar a la anterior, se acumulaban indefinidamente.
    const r = await fetch("http://localhost:5005/api/health",
                          { signal: AbortSignal.timeout(3000) });
    log(`🐍 Python respondió (${r.status})`);
    return true;
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.type === "system") {
      if (!silencioso) log(`⚠️ Python no accesible: ${e.message}`, "warn");
      return false;
    }
    if (!silencioso) log(`⚠️ Python error no crítico: ${e.message}`, "warn");
    return true;
  }
}

// ==========================================================
// UI HTTP + WEBSOCKET
// ==========================================================
function startHttpUi() {
  const app    = express();
  app.use(express.static(rootDir));
  app.get("/health-ui", (_, res) => res.json({ ok: true, version: MIIA_VERSION }));

  const server = http.createServer(app);
  wss = new WebSocketServer({ server });

  wss.on("connection", ws => {
    log("🌐 UI conectada (WebSocket)");
    ws.send(JSON.stringify({ type: "hello", msg: "MIIA UI conectada", version: MIIA_VERSION }));
  });

  const PORT = process.env.UI_PORT || 8088;
  // Si el puerto ya está tomado (otra instancia de MIIA), NO tirar abajo el
  // orquestador: loguear y seguir. El 'error' del http server también lo
  // emite el WebSocketServer, así que hay que capturarlo o el proceso muere.
  server.on("error", err => {
    if (err.code === "EADDRINUSE")
      log(`🖥️ UI: puerto ${PORT} ya en uso (¿otra instancia de MIIA?) — se omite la UI`, "warn");
    else
      log(`🖥️ UI error: ${err.message}`, "warn");
  });
  wss.on("error", () => {});   // evita que el error se propague como excepción no capturada
  server.listen(PORT, () => log(`🖥️ UI en http://localhost:${PORT}/brain.html`));
}

// ==========================================================
// REDIS — monitoreo
// ==========================================================
async function monitorRedis() {
  // ── BUG 1 — la línea que tumbó MIIA el 26-ago-2026 a las 06:32:55 ────────
  // Este era el ÚNICO de los cuatro createClient() del archivo sin handler
  // de "error" (los de visualClient y los dos del árbitro sí lo tenían). En
  // node-redis v4 un evento "error" sin listener es una excepción no
  // capturada que mata el proceso, y el try/catch de abajo no ayudaba: el
  // error se EMITE de forma asincrónica sobre el EventEmitter, no se lanza.
  // Cuando needrestart paró redis-server por la actualización de libssl3, el
  // socket se cerró y un segundo después el orquestador estaba muerto.
  const client = createClient({ url: redisUrl });
  client.on("error", e => log(`⚠️ Monitor Redis: ${e.message}`, "warn"));

  try {
    await client.connect();
    setInterval(async () => {
      try {
        const info = await client.info("memory");
        const used = info.match(/used_memory_human:(.+)\r?\n/)?.[1]?.trim();
        log(`🧠 Redis memoria: ${used}`);
      } catch {
        // ── BUG 2 — por qué acá NO se llama a startRedis() ────────────────
        // En Linux redis-server es un servicio de systemd. Durante un
        // reinicio suyo redisResponde() da false, y startRedis() spawnearía
        // un `redis-server --port 6379` como hijo de MIIA que después le
        // pelea el puerto al de systemd.
        //
        // El 26-ago esto no llegó a pasar sólo porque el Bug 1 mató el
        // proceso en 1 segundo, antes de que corriera este tick de 15 s.
        // Arreglar el Bug 1 sin tocar esto ARMA el Bug 2: el proceso
        // sobreviviría al socket cerrado y 15 s después intentaría levantar
        // un Redis competidor. Van juntos.
        //
        // node-redis v4 reconecta solo y systemd es el dueño del ciclo de
        // vida de Redis. Acá sólo se reporta.
        log("Redis no responde — esperando reconexión automática", "warn");
      }
    }, 15000);
  } catch (e) {
    // Tampoco acá: el arranque de Redis ya lo hace startRedis() en el boot.
    log(`❌ monitorRedis no pudo conectar: ${e.message}`, "error");
  }
}

// ==========================================================
// PUENTE VISUAL Redis → WebSocket UI
// ==========================================================
const REDIS_CHANNELS = [
  "class1_output","class2_output","class3_output","class4_output",
  "class5_output","class6_output","class7_output","class8_output",
  "class9_output","class10_output","class11_output","class12_output",
  "class13_output","class14_output","class15_output","class16_output",
  "class17_output","class18_output","class19_output","class20_output",
  "class21_output","class22_output","class23_output","class24_output",
  "class25_output","class27_output","class28_output","class29_output",
  "class40_output","class41_output",
  // FIX: canal de class25A → class25B
  "class25a_output","class25a_feedback",
  // señales listo class25A
  "class25A_ready",
  "class17_ingest","class15_ingest",
  "class3_ingest","class10_ingest","class18_ingest","class25_ingest",
  "class14_resolve","class14_resolved",
  "motor_emocional_state","motor_lenguaje_state","modulo_de_control_estado",
  "ui_stream","python_feedback","miia_evento",
  "miia.input.text","miia.semantic.analysis","miia.semantic.metrics",
  // Señales de listo C++
  "class21_ready","class22_ready","class23_ready","class24_ready",
  "class27_ready","class28_ready","class29_ready",
];

let visualClient = null;

async function startVisualBridge() {
  visualClient = createClient({ url: redisUrl });
  visualClient.on("error", e => log(`Redis visual error: ${e.message}`, "warn"));
  await visualClient.connect();

  for (const ch of REDIS_CHANNELS) {
    await visualClient.subscribe(ch, msg => {
      let payload;
      try { payload = JSON.parse(msg); } catch { payload = msg; }
      wss?.clients.forEach(c => {
        if (c.readyState === 1)
          c.send(JSON.stringify({ channel: ch, message: payload, ts: Date.now() }));
      });

      // Log de señales de listo de módulos C++ y class25A
      if (ch.endsWith("_ready")) log(`✅ ${ch} recibido`);
      // Log decisiones de class25A antes de que lleguen a class25B
      if (ch === "class25a_output") {
        try {
          const d = JSON.parse(msg);
          log(`⚡ [CLASS25A] ${d.senal} ${d.ticker} conf=${d.confianza?.toFixed(3)}`);
        } catch (_) {}
      }
    });
  }
  log(`✅ Puente visual activo (${REDIS_CHANNELS.length} canales)`);
}

// ==========================================================
// ÁRBITRO COGNITIVO
// ==========================================================
let arbiterRedis = null;   // cliente PUBLISHER del árbitro
let arbiterSub   = null;   // cliente SUBSCRIBER del árbitro (separado)
let arbiterReady = false;
let arbiterStarting = false;

const ARBITER_STATE = {
  lastHashBySession: new Map(),
  repetitionCount: new Map(),
  cooldownUntil: new Map(),
  lastWarnAt: new Map(),
  processedIds: new Map(),   // capa 4: id → ts (dedup global por id de paquete)
  rate: new Map(),           // capa 6: sesión → [timestamps] (rate-limit)
};

const MAX_REPETITIONS = 3;
const HASH_WINDOW_MS  = 30_000;
const COOLDOWN_MS     = 60_000;
const WARN_THROTTLE_MS = 5_000;
// Capa 3 — Hop count: un paquete que dio más de MAX_HOPS saltos está en loop
const MAX_HOPS        = 15;
// Capa 6 — Rate limit por sesión: máx N mensajes en la ventana
const RATE_MAX        = 50;
const RATE_WINDOW_MS  = 10_000;
const ID_TTL_MS       = 60_000;   // capa 4 — TTL del cache de ids

function normalizeText(t = "") {
  return t.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}
function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h.toString();
}
// Capa 5 — Hash estructural: sobre los campos que definen la decisión, no solo
// el texto (un espacio de más rompía el hash de texto y el loop se colaba).
function hashEstructural(p) {
  const partes = [
    p.decision, p.tipo, p.senal, p.origin || p.source, p.ticker,
    p.vector, p.accion, p.confianza, p.horizonte,
  ].map(v => (v == null ? "" : String(v)));
  return simpleHash(partes.join("|"));
}
function limpiarCooldowns(now) {
  for (const [sid, until] of ARBITER_STATE.cooldownUntil.entries())
    if (now >= until) {
      ARBITER_STATE.cooldownUntil.delete(sid);
      ARBITER_STATE.repetitionCount.delete(sid);
      ARBITER_STATE.lastHashBySession.delete(sid);
    }
  // Capa 4 — purgar ids viejos del cache
  for (const [id, ts] of ARBITER_STATE.processedIds.entries())
    if (now - ts > ID_TTL_MS) ARBITER_STATE.processedIds.delete(id);
}

async function arbitrarMensaje(payload) {
  try {
    if (!arbiterReady || !arbiterRedis) return;
    if (!payload || typeof payload !== "object") return;

    const now = Date.now();
    limpiarCooldowns(now);

    // ── Capa 7 — NUNCA reprocesar un paquete del propio árbitro ──
    // (era la causa raíz: el árbitro publicaba a class25_output —su input— y
    //  se re-escuchaba a sí mismo, sin este guard, creando el loop)
    if (payload.source === "arbiter") return;

    // ── Capa 1 — UUID obligatorio ──
    if (!payload.id) payload.id = randomUUID();

    // ── Capa 4 — Cache global de ids: si ya lo procesó, descartar ──
    if (ARBITER_STATE.processedIds.has(payload.id)) return;

    // ── Capa 3 — Hop count: muere aunque cambie texto/hash/canal ──
    payload.hops = (payload.hops || 0) + 1;
    if (payload.hops > MAX_HOPS) {
      log(`🛑 [ÁRBITRO] Loop por hops (${payload.hops}) id=${String(payload.id).slice(0,8)}`, "warn");
      return;
    }

    // ── Capa 2 — Historial de módulos: si ya pasó por el árbitro, descartar ──
    payload.history ??= [];
    if (payload.history.includes("arbiter")) return;
    payload.history.push("arbiter");

    // A partir de acá el paquete se considera "en proceso" → registrar id
    ARBITER_STATE.processedIds.set(payload.id, now);

    const sessionId = payload.session_id || payload.user_id || "global";

    // ── Capa 6 — Rate limit por sesión (50 msg / 10 s → bloquear) ──
    const marcas = (ARBITER_STATE.rate.get(sessionId) || []).filter(t => now - t < RATE_WINDOW_MS);
    marcas.push(now);
    ARBITER_STATE.rate.set(sessionId, marcas);
    if (marcas.length > RATE_MAX) {
      ARBITER_STATE.cooldownUntil.set(sessionId, now + COOLDOWN_MS);
      const lastWarn = ARBITER_STATE.lastWarnAt.get(sessionId) || 0;
      if (now - lastWarn > WARN_THROTTLE_MS) {
        log(`⛔ [ÁRBITRO] Rate-limit: sesión ${sessionId} bloqueada (${marcas.length} msg/${RATE_WINDOW_MS/1000}s)`, "warn");
        ARBITER_STATE.lastWarnAt.set(sessionId, now);
      }
      return;
    }

    const cooldownUntil = ARBITER_STATE.cooldownUntil.get(sessionId);
    if (cooldownUntil && now < cooldownUntil) return;

    const texto = payload.decision || payload.texto || payload.respuesta || "";
    if (!texto || texto.length < 5) return;

    // ── Capa 5 — Doble hash: texto + estructural ──
    const hash = simpleHash(normalizeText(texto)) + ":" + hashEstructural(payload);
    const prev = ARBITER_STATE.lastHashBySession.get(sessionId);

    if (prev && prev.hash === hash && now - prev.ts < HASH_WINDOW_MS) {
      const count = (ARBITER_STATE.repetitionCount.get(sessionId) || 0) + 1;
      ARBITER_STATE.repetitionCount.set(sessionId, count);
      const lastWarn = ARBITER_STATE.lastWarnAt.get(sessionId) || 0;
      if (now - lastWarn > WARN_THROTTLE_MS) {
        log(`🛑 [ÁRBITRO] Loop por hash (${count}) sesión=${sessionId}`, "warn");
        ARBITER_STATE.lastWarnAt.set(sessionId, now);
      }
      if (count >= MAX_REPETITIONS) {
        ARBITER_STATE.cooldownUntil.set(sessionId, now + COOLDOWN_MS);
        log(`⛔ [ÁRBITRO] Sesión en cooldown por repetición: ${sessionId}`, "warn");
        return;
      }
    } else {
      ARBITER_STATE.repetitionCount.set(sessionId, 0);
    }

    ARBITER_STATE.lastHashBySession.set(sessionId, { hash, ts: now });

    const esFinal = payload.final === true || payload.tipo === "decision_final";
    if (!esFinal) return;

    // El paquete a distribuir hereda id/history/hops (para que aguas abajo
    // también puedan cortar el loop) y se marca source:"arbiter".
    const paquete = {
      ...payload, source: "arbiter", ts: new Date().toISOString(),
      sentTo: payload.sentTo ? [...payload.sentTo] : [],
    };
    // class25_output ELIMINADO del TARGET: es el canal de ENTRADA del árbitro.
    // Publicar ahí era el self-loop. El resto son canales de salida legítimos.
    const TARGET = [
      "class41_output","class40_output","ui_stream",
      "class21_output","class22_output","class23_output","class24_output",
      "class27_output","class28_output","class29_output",
    ];
    // sentTo: el paquete recuerda a qué canales ya fue → nunca vuelve al mismo
    for (const ch of TARGET) {
      if (paquete.sentTo.includes(ch)) continue;
      paquete.sentTo.push(ch);
      await arbiterRedis.publish(ch, JSON.stringify(paquete));
    }
    log("✅ [ÁRBITRO] Decisión distribuida");
  } catch (e) { log(`❌ Árbitro: ${e.message}`, "error"); }
}

// Mientras Redis todavía no está arriba, node-redis reintenta solo y emite un
// error por intento. En Windows muchos llegan con `message` VACÍO, así que la
// línea salía como "⚠️ Árbitro SUB:" pelada: trece de esas seguidas parecen una
// rotura y no lo son. El árbitro arranca EN PARALELO con startRedis(), que
// tarda ~30 s en decidirse a levantar Redis, y se conecta solo apenas está.
let arbitroErrN = 0;
function logArbitroErr(lado, e) {
  const msg = (e && (e.message || e.code)) || "Redis todavía no acepta conexiones";
  if (arbitroErrN++ % 10 === 0)
    log(`⚠️ Árbitro ${lado}: ${msg} — esperando a Redis (reintento ${arbitroErrN})`, "warn");
}

async function iniciarArbitro() {
  if (arbiterReady || arbiterStarting) return;
  arbiterStarting = true;
  log("⏱️ [ÁRBITRO] Iniciando...");
  await sleep(5000);
  try {
    // Cliente SUB — solo escucha class25_output
    const sub = createClient({ url: redisUrl });
    sub.on("error", e => logArbitroErr("SUB", e));
    await sub.connect();
    await sub.subscribe("class25_output", async msg => {
      try { await arbitrarMensaje(JSON.parse(msg)); } catch {}
    });
    arbiterSub = sub;

    // Cliente PUB — separado para poder publicar sin conflicto de modo
    const pub = createClient({ url: redisUrl });
    pub.on("error", e => logArbitroErr("PUB", e));
    await pub.connect();
    arbiterRedis    = pub;   // usado en arbitrarMensaje() para publish

    arbiterReady    = true;
    arbiterStarting = false;
    log("🧠 Árbitro conectado y operativo (sub+pub separados)");
  } catch (e) {
    arbiterStarting = false;
    throw e;
  }
}

// ==========================================================
// CIERRE DE CANALES REDIS
// ==========================================================
async function cerrarCanalesRedis() {
  try {
    if (visualClient?.isOpen)  await visualClient.quit();
    if (arbiterSub?.isOpen)    await arbiterSub.quit();
    if (arbiterRedis?.isOpen)  await arbiterRedis.quit();
    log("📡 Canales Redis cerrados");
  } catch (e) { log(`Error cerrando Redis: ${e.message}`, "warn"); }
}

// ==========================================================
// ORQUESTADOR PRINCIPAL
// ==========================================================
// ==========================================================
// LIMPIEZA DE HUÉRFANOS AL ARRANCAR
// ==========================================================
// `apagadoMaestro` manda SIGTERM a los hijos rastreados, pero eso SOLO corre si
// el orquestador llega a ejecutarlo. pm2 usa un kill_timeout de 1600 ms por
// defecto, y el apagado hace `await cerrarCanalesRedis()` y `cerrarMySQL()`
// (spawnSync con timeout de 15 s) antes de llegar a matar a nadie: si pm2 manda
// SIGKILL en el medio, los hijos sobreviven.
//
// Y `startProcess` solo evita duplicados DENTRO de una misma vida del proceso:
// `activeProcesses` arranca vacío en cada boot, así que no ve a los
// supervivientes y lanza todo de nuevo. Quedan dos generaciones conviviendo.
//
// Medido el 11-ago-2026: class30.js y class43.js con 5 días de vida contra 47
// minutos del resto, el puerto 8443 retenido por el proceso viejo y el sitio
// caído; más dos `app.py` con un `class44.py` cada uno entrenando los mismos
// modelos y pisándose los archivos.
//
// Por eso la limpieza va acá y no solo en el apagado: éste es el único punto
// que funciona pase lo que pase antes — SIGKILL, OOM o corte de luz.
function limpiarHuerfanos() {
  if (IS_WIN) return 0;   // en Windows lo cubre taskkill dentro de apagadoMaestro
  try {
    // Acotado a la ruta de instalación: no puede tocar procesos ajenos del
    // servidor. Un `pkill -f python` sí podría, y por eso no se usa.
    const salida  = spawnSync("pgrep", ["-f", `${rootDir}/`], { encoding: "utf8" });
    // Excluirse a sí mismo es imprescindible: la línea de comando de este mismo
    // proceso contiene rootDir y el pgrep lo encuentra.
    const propios = new Set([process.pid, process.ppid]);
    const pids = (salida.stdout || "")
      .split("\n")
      .map(s => parseInt(s.trim(), 10))
      .filter(p => Number.isInteger(p) && p > 0 && !propios.has(p));

    if (!pids.length) { log("🧹 Sin huérfanos de arranques previos"); return 0; }

    log(`🧹 ${pids.length} proceso(s) sobrevivientes de un arranque anterior: ${pids.join(" ")}`, "warn");
    for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }

    // Segunda pasada. Un huérfano que retiene un puerto hace fallar el bind del
    // módulo nuevo, y ese fallo es SILENCIOSO: el sistema arranca "bien" y el
    // gateway no responde. Es peor que matarlo a la fuerza.
    spawnSync("sleep", ["3"]);
    let duros = 0;
    for (const p of pids) {
      try { process.kill(p, 0); process.kill(p, "SIGKILL"); duros++; } catch { /* ya murió */ }
    }
    if (duros) log(`🧹 ${duros} no respondieron a SIGTERM → SIGKILL`, "warn");
    log(`🧹 Limpieza completa: ${pids.length} proceso(s) de la generación anterior`);
    return pids.length;
  } catch (e) {
    log(`🧹 Limpieza de huérfanos falló: ${e.message}`, "warn");
    return 0;
  }
}

// ==========================================================
// ORQUESTADOR PRINCIPAL (continúa)
// ==========================================================
(async () => {
  log(`🚀 Iniciando ${PROJECT_NAME} v${MIIA_VERSION}`);
  console.log("• Proyecto:", PROJECT_NAME);
  console.log("• Versión:", MIIA_VERSION);

  // ANTES que nada: no arrancar sobre los restos del arranque anterior.
  limpiarHuerfanos();

  showProgress("Arranque inicial", 5);

  // 0. MYSQL — verificar/arrancar y restaurar permisos ANTES que los motores
  // (los módulos JS conectan a MySQL apenas arrancan via class42)
  await asegurarMySQL();
  showProgress("MySQL verificado", 5);

  // 1. REDIS
  await startRedis();
  await sleep(8000);
  showProgress("Redis iniciado", 5);

  // 2. MÓDULOS JS (excluye class21-29 y class25)
  startJSModules();
  showProgress("Módulos JS activos", 15);
  await sleep(10000);

  // 3. MOTOR VECTORIAL .NET
  startMotorVectorial();
  showProgress("Motor vectorial .NET iniciado", 10);
  await sleep(5000);

  // 4. MÓDULOS C++ (class21-24, class27-29)
  startCppModules();
  showProgress("Módulos C++ iniciados", 15);
  await sleep(5000);

  // 5. PYTHON
  startPythonServer();
  await sleep(4000);   // gracia inicial: uvicorn tarda unos segundos en bindear
  let retry = 0;
  // silencioso=true durante el boot: los fallos esperables no van al log
  while (!(await testPythonConnection(true)) && retry < 20) {
    retry++;
    if (retry % 5 === 0) { log(`🔄 Reintentando Python (${retry})`); startPythonServer(); }
    await sleep(2500);
  }
  if (retry >= 20) log("❌ Python no respondió", "error");
  else showProgress("Python sincronizado", 10);

  // 6. CLASS25A — Motor Cuantitativo C++ (arranca primero — necesita redes activas)
  startClass25A();
  showProgress("class25A iniciado (Motor Cuantitativo C++)", 5);
  await sleep(4000);

  // 6b. CLASS25B — Motor Lingüístico JS (depende de class25A)
  startClass25B();
  showProgress("class25B iniciado (Motor Lingüístico JS)", 5);
  await sleep(3000);

  // 7. UI
  startHttpUi();
  showProgress("UI activa", 5);

  // 8. PUENTE VISUAL Redis → WebSocket
  await startVisualBridge();
  showProgress("Puente visual activo", 5);

  // 9. MONITOR Redis
  monitorRedis();

  // 10. class48 — Health Monitor (arranque diferido 5min para que motores levanten)
  setTimeout(() => {
    const p48 = path.join(scriptsDir, "class48.js");
    if (fs.existsSync(p48)) {
      startProcess("node", [p48], "CLASS48", scriptsDir, { REDIS_URL: redisUrl });
      log("🩺 class48 Health Monitor iniciado (primera evaluación en 5 min)");
    }
  }, 5 * 60_000);

  // 11. Monitor Python periódico
  setInterval(async () => {
    if (!(await testPythonConnection())) {
      log("⚠️ Python caído → reinicio", "warn");
      startPythonServer();
    }
  }, 20000);

  showProgress("Sistema operativo", 5);
  log(`✅ ${PROJECT_NAME} v${MIIA_VERSION} completamente operativo`);
  log(`📊 Módulos JS activos: ${Object.keys(activeProcesses).filter(k => !["CLASS21","CLASS22","CLASS23","CLASS24","CLASS27","CLASS28","CLASS29"].includes(k)).length}`);
  const cppActivos = CPP_MODULES.filter(m => activeProcesses[m.label]).length;
  log(`⚡ Módulos C++ activos: ${cppActivos}/${CPP_MODULES.length} (incluye class25A)`);
  log(`🧠 Cerebro: class25A=${activeProcesses["CLASS25A"] ? "✅" : "❌"} class25B=${activeProcesses["CLASS25B"] ? "✅" : "❌"}`);
})();

// ==========================================================
// ÁRBITRO (arranque paralelo)
// ==========================================================
(async () => {
  const MAX = 10;
  let attempts = 0;
  while (!arbiterReady && attempts < MAX) {
    try { attempts++; await iniciarArbitro(); return; }
    catch { log(`⏳ Redis no disponible para Árbitro (${attempts}/${MAX})`, "warn"); await sleep(3000); }
  }
  if (!arbiterReady) log("❌ Árbitro NO pudo inicializarse", "error");
})();

// ==========================================================
// APAGADO CONTROLADO
// ==========================================================
let _apagando = false;
async function apagadoMaestro(origen = "SIGINT") {
  if (_apagando) return;   // evitar doble ejecución (SIGINT + SIGTERM)
  _apagando = true;
  console.log(`\n\n🛑 Apagado maestro detectado (${origen})...`);
  g_running = false;

  let cfg = {};
  try { const c = getConfig("shutdown"); cfg = c && typeof c === "object" ? c : {}; } catch {}

  const toBool = v => typeof v === "string" ? v.toLowerCase() === "true" : !!v;
  const toNum  = (v, d) => isNaN(parseInt(v)) ? d : parseInt(v);

  const killRedis     = toBool(cfg.kill_redis    ?? false);
  const killChildren  = toBool(cfg.kill_child_processes ?? true);
  const killDotnet    = toBool(cfg.kill_dotnet   ?? true);
  const killPython    = toBool(cfg.kill_python   ?? true);
  const shutdownMysql = toBool(cfg.shutdown_mysql ?? true);
  const grace         = toNum(cfg.grace_period_ms ?? 1500, 1500);

  // Los hijos se matan PRIMERO, antes de cualquier await que pueda no terminar.
  // Estaba al final, después de `cerrarCanalesRedis()` y de los killByName: si
  // pm2 mandaba SIGKILL en el medio (kill_timeout 1600 ms por defecto), este
  // bloque no llegaba a ejecutarse nunca y los hijos quedaban vivos. Ese es el
  // origen de los huérfanos que después obligan a limpiarHuerfanos() al arrancar.
  if (killChildren) {
    const n = Object.keys(activeProcesses).length;
    Object.values(activeProcesses).forEach(p => { try { p.kill("SIGTERM"); } catch {} });
    if (n) console.log(`🛑 SIGTERM a ${n} proceso(s) hijo(s)`);
  }

  await cerrarCanalesRedis();

  async function killByName(name) {
    // En Linux se usa SIGTERM a los hijos rastreados (killChildren, más arriba):
    // app.py, dotnet y redis quedan como hijos directos y se cierran ahí. Evitamos
    // un `pkill -f python` que mataría procesos ajenos del servidor.
    if (!IS_WIN) return;
    try { const { execSync } = await import("child_process"); execSync(`taskkill /F /IM ${name}`, { stdio: "ignore" }); } catch {}
  }

  if (killRedis)  await killByName("redis-server.exe");
  if (killPython) { await killByName("python.exe"); await killByName("python3.exe"); }
  if (killDotnet) await killByName("dotnet.exe");

  // (el SIGTERM a los hijos se movió al principio de esta función)

  // ÚLTIMO paso antes de salir: cerrar MySQL LIMPIO (con los motores ya
  // apagados, no queda nadie escribiendo). Esto evita la corrupción de las
  // tablas Aria de privilegios que causaba "Access denied to database".
  if (shutdownMysql) await cerrarMySQL();

  console.log(`⏳ Esperando ${grace}ms...`);
  setTimeout(() => { console.log("🟢 MIIA apagada correctamente."); process.exit(0); }, grace);
}

process.on("SIGINT",  () => apagadoMaestro("SIGINT"));
process.on("SIGTERM", () => apagadoMaestro("SIGTERM"));
// Cierre de la ventana de consola en Windows también dispara el apagado limpio
process.on("SIGHUP",  () => apagadoMaestro("SIGHUP"));