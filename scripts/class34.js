// ============================================================
// class34.js — Backup automático MySQL (MIIA)
// VERSIÓN CORREGIDA v1.9.1 — migrado de SQL Server → MySQL/XAMPP
//
// Cambios respecto a la versión anterior (SQL Server):
//   1. BACKUP DATABASE T-SQL → mysqldump (XAMPP)
//   2. SELECT DB_NAME() → SELECT DATABASE() (MySQL)
//   3. RESTORE VERIFYONLY → verificación por tamaño de archivo
//   4. icacls MSSQL$SQLEXPRESS → eliminado (no aplica a XAMPP)
//   5. BACKUP_ROOT relativo al proyecto (MIIA/backups/)
//   6. checkTables con TABLE_SCHEMA = DATABASE() (filtra correctamente)
//   7. Detecta mysqldump en XAMPP automáticamente
//
// Backup cada 6 horas → .sql → .zip → máx 10 backups
// ============================================================

import fs   from "fs";
import os   from "os";
import path from "path";
import chalk from "chalk";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import archiver     from "archiver";
import { createClient } from "redis";
import { query, getSQL } from "./class42.js";

// ── ESM dirname ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Crash handlers ─────────────────────────────────────────
process.on("unhandledRejection", e => log(`❌ Rejection: ${e?.message || e}`, "error"));
process.on("uncaughtException",  e => log(`❌ Excepción: ${e?.message || e}`, "error"));

// ── Directorios ────────────────────────────────────────────
// FIX: ruta relativa al proyecto, no hardcodeada a C:/MSSQL_BACKUPS
const BASE_DIR   = path.resolve(__dirname, "../operador/aprendizaje");
const BACKUP_DIR = path.resolve(__dirname, "../backups");   // MIIA/backups/
const LOG_DIR    = path.join(BASE_DIR, "logs");
const LOG_FILE   = path.join(LOG_DIR, "class34.log");

for (const dir of [BACKUP_DIR, LOG_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

console.log(chalk.green(`[class34] 📁 Backups en: ${BACKUP_DIR}`));

// ── Logger ──────────────────────────────────────────────────
function log(msg, tipo = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class34/${tipo}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + os.EOL); } catch (_) {}
  if (tipo === "error") console.error(chalk.red(line));
  else if (tipo === "warn") console.warn(chalk.yellow(line));
  else console.log(chalk.cyan(line));
}

// ── Redis (opcional) ───────────────────────────────────────
let redis = null;
try {
  redis = createClient({ url: "redis://localhost:6379" });
  redis.connect()
    .then(() => log("📡 Redis conectado."))
    .catch(() => {});
} catch (_) { redis = null; }

async function publicarEvento(tipo, payload = {}) {
  if (!redis?.isOpen) return;
  try {
    await redis.publish("class34_eventos", JSON.stringify({
      ts: new Date().toISOString(), tipo, source: "class34", payload
    }));
  } catch (_) {}
}

// ── Config de base de datos ────────────────────────────────
// mysqldump necesita privilegios elevados (RELOAD, PROCESS, LOCK TABLES)
// que el usuario normal no suele tener.  Usamos root (XAMPP default: sin
// password) para el dump; la base y host se leen de sql.ini/.env.
let dbCfg = { host: "localhost", port: 3306, user: "root", password: "", database: "miia_cognitiva" };

try {
  const { getConfig } = await import("./class38.js");
  const cfg = getConfig("sql") || {};
  dbCfg = {
    host:     cfg.db_host     || cfg.server   || dbCfg.host,
    port:     parseInt(cfg.db_port || cfg.port || "3306"),
    user:     "root",
    password: process.env.DB_ROOT_PASS ?? "",
    database: cfg.db_name     || cfg.database || dbCfg.database,
  };
} catch (_) {}

// ── Detectar mysqldump (XAMPP en Windows, PATH en Linux) ───
const IS_WIN = process.platform === "win32";
function detectarMysqldump() {
  const rutas = IS_WIN ? [
    "C:\\xampp\\mysql\\bin\\mysqldump.exe",
    "C:\\xampp\\mysql\\bin\\mysqldump",
    "mysqldump",   // en PATH
  ] : [
    "/usr/bin/mysqldump",
    "/usr/local/bin/mysqldump",
    "/opt/lampp/bin/mysqldump",   // XAMPP para Linux, si se usa
    "mysqldump",   // en PATH
  ];

  for (const ruta of rutas) {
    try {
      execSync(`"${ruta}" --version`, { stdio: "ignore" });
      log(`✅ mysqldump encontrado: ${ruta}`);
      return ruta;
    } catch (_) {}
  }

  log("⚠️ mysqldump no encontrado. Verificar que XAMPP esté instalado.", "warn");
  return null;
}

// ── Helpers ────────────────────────────────────────────────
function makeBackupName(ext = "sql") {
  const ts = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
  return `MIIA_backup_${ts}.${ext}`;
}

async function compressBackup(sqlPath, zipPath) {
  let attempt = 0;
  while (attempt < 2) {
    attempt++;
    try {
      await new Promise((resolve, reject) => {
        const output  = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        output.on("close", resolve);
        archive.on("error", reject);
        archive.pipe(output);
        archive.file(sqlPath, { name: path.basename(sqlPath) });
        archive.finalize();
      });
      return true;
    } catch (e) {
      log(`⚠️ compressBackup intento ${attempt}: ${e.message}`, "warn");
      if (attempt >= 2) throw e;
    }
  }
}

// Rota los .zip y ademas barre los .sql huerfanos.
//
// El .sql es un INTERMEDIO: se genera, se comprime y se borra en el mismo ciclo
// (ver el unlinkSync de mas abajo). Pero ese unlink se traga los errores en
// silencio, y si algo falla entre el dump y el, la funcion sale por su catch y
// el .sql queda. Hasta ahora no lo borraba NADIE, porque este filtro solo miraba
// .zip — el archivo mas pesado del sistema era el unico sin rotacion.
//
// Medido en produccion el 16-ago-2026:
//   .zip   10 archivos   3.6 GB   ← la rotacion funcionaba bien
//   .sql   33 archivos    28 GB   ← huerfanos desde el 12-jul
//
// Con 120 GB libres y 1.45 GB/dia de backups, eso daba ~83 dias hasta llenar el
// disco. El margen de 1 h evita tocar el .sql de un dump en curso: uno completo
// tarda ~4 min.
const HUERFANO_SQL_MS = 60 * 60 * 1000;

function cleanOldBackups(maxBackups = 10) {
  try {
    const entradas = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith(".zip") || f.endsWith(".sql"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }));

    const zipsViejos = entradas
      .filter(e => e.name.endsWith(".zip"))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(maxBackups);

    const ahora = Date.now();
    const sqlHuerfanos = entradas.filter(
      e => e.name.endsWith(".sql") && ahora - e.mtime > HUERFANO_SQL_MS
    );

    const aBorrar = [...zipsViejos, ...sqlHuerfanos];
    if (!aBorrar.length) return;

    let liberado = 0;
    for (const f of aBorrar) {
      const ruta = path.join(BACKUP_DIR, f.name);
      try {
        liberado += fs.statSync(ruta).size;
        fs.unlinkSync(ruta);
        log(`🧹 Backup eliminado: ${f.name}`);
      } catch (e) {
        log(`⚠️ No pudo eliminar ${f.name}: ${e.message}`, "warn");
      }
    }
    log(`🧹 Rotación: ${zipsViejos.length} .zip + ${sqlHuerfanos.length} .sql huérfanos — ` +
        `${(liberado / 1048576).toFixed(0)} MB liberados`);
  } catch (e) {
    log(`⚠️ Error limpiando backups: ${e.message}`, "warn");
  }
}

// ── Detectar base activa ───────────────────────────────────
// FIX: SELECT DATABASE() en lugar de SELECT DB_NAME() (T-SQL)
let dbName = dbCfg.database;

async function detectarBaseActiva() {
  try {
    const result = await query("SELECT DATABASE() AS nombre");
    if (result?.recordset?.[0]?.nombre) {
      dbName = result.recordset[0].nombre;
      log(`📌 Base activa detectada: ${dbName}`);
    } else {
      dbName = dbCfg.database;
      log(`📌 Usando base de sql.ini: ${dbName}`);
    }
  } catch (e) {
    dbName = dbCfg.database;
    log(`⚠️ Usando base de sql.ini: ${dbName} (${e.message})`, "warn");
  }
}

// ── Verificar que hay tablas en la base ────────────────────
// FIX: TABLE_SCHEMA = DATABASE() para no contar tablas de otras bases
async function checkTables() {
  try {
    const result = await query(
      `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_TYPE = 'BASE TABLE'`
    );
    const total = result?.recordset?.[0]?.total ?? 0;
    return Number(total) > 0;
  } catch (e) {
    log(`⚠️ Error verificando tablas: ${e.message}`, "warn");
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// BACKUP PRINCIPAL — mysqldump
// Reemplaza BACKUP DATABASE T-SQL (SQL Server) por mysqldump (MySQL/XAMPP)
// ══════════════════════════════════════════════════════════

let isRunning = false;

// Tablas de las que se guarda la ESTRUCTURA pero no las FILAS.
//
// Medido el 20-ago-2026: los backups de las 12:06 y las 18:06 fallaron los dos
// por `mysqldump timeout (5min)`. Los de las 00:06 y 06:06 del mismo día habían
// pasado, pero tardando 7 y 8 minutos contando el zip — o sea que el dump venía
// rozando el límite y ese día lo cruzó.
//
// La causa no es el timeout: es qué se está copiando. `user_decisions` tiene
// 6,3 M filas y 5,1 GB — el 98% de la base — y es un log de QUÉ SEÑALES VIO EL
// USUARIO (class14.js:546), no dato del experimento. Copiarla cada 6 h hace que
// el dump tarde minutos, sature un núcleo de mysqld y desaloje el buffer pool
// entero, para respaldar lo único que sí se puede reconstruir.
//
// Es el mismo criterio que backup_tesis.sh ya aplicaba a mano; nunca había
// llegado al backup automático. Sacando sus filas, el dump baja de ~5 GB a
// ~200 MB y termina en segundos.
//
// Se guarda igual el CREATE TABLE (pasada 2). class14.js:179 la recrearía sola
// al arrancar, pero un restore no debería depender de que MIIA levante primero.
const TABLAS_SIN_DATOS = ["user_decisions"];

// Cota de seguridad, no el mecanismo de control: con las tablas de arriba
// afuera, el dump tarda segundos. Si alguna vez vuelve a acercarse a esto, el
// problema es que otra tabla creció, no que el timeout sea corto.
const DUMP_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutos

async function backupSQL() {
  if (isRunning) {
    log("⚠️ Backup ya en ejecución, ignorando.", "warn");
    return;
  }
  isRunning = true;

  try {
    log("📦 Iniciando backup MySQL (mysqldump)...");

    // Detectar base activa
    if (!dbName) await detectarBaseActiva();
    if (!dbName) {
      log("❌ No se pudo determinar la base activa. Backup cancelado.", "error");
      return;
    }

    // Verificar tablas
    const hayTablas = await checkTables();
    if (!hayTablas) {
      log("⚠️ Base vacía o sin tablas. Backup cancelado.", "warn");
      return;
    }

    // Detectar mysqldump
    const mysqldump = detectarMysqldump();
    if (!mysqldump) {
      log("❌ mysqldump no disponible. Backup cancelado.", "error");
      return;
    }

    // Nombre de archivo
    const sqlName = makeBackupName("sql");
    const sqlPath = path.join(BACKUP_DIR, sqlName);

    log(`📌 Destino: ${sqlPath}`);

    // Ejecutar mysqldump
    const argsBase = [
      `--host=${dbCfg.host}`,
      `--port=${dbCfg.port}`,
      `--user=${dbCfg.user}`,
      ...(dbCfg.password ? [`--password=${dbCfg.password}`] : []),
      "--single-transaction",
      "--routines",
      "--triggers",
      "--add-drop-table",
    ];

    // Pasada 1 — todo, menos las FILAS de TABLAS_SIN_DATOS.
    const argsDatos = [
      ...argsBase,
      ...TABLAS_SIN_DATOS.map(t => `--ignore-table=${dbName}.${t}`),
      "--result-file", sqlPath,
      dbName,
    ];

    // Pasada 2 — solo el CREATE TABLE de esas tablas. Tarda milisegundos y se
    // anexa al mismo .sql, así el archivo final restaura una base completa.
    const structPath = `${sqlPath}.estructura`;
    const argsEstructura = [
      ...argsBase,
      "--no-data",
      "--result-file", structPath,
      dbName,
      ...TABLAS_SIN_DATOS,
    ];

    const correrDump = (args, etiqueta) => new Promise((resolve, reject) => {
      const proc = spawn(mysqldump, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      let cortado = false;

      // El timer se limpia al terminar. Antes quedaba vivo los 5 minutos
      // completos incluso después de un dump exitoso, y disparaba un kill()
      // sobre un proceso ya muerto.
      const timer = setTimeout(() => {
        cortado = true;
        proc.kill();
        reject(new Error(`mysqldump timeout (${DUMP_TIMEOUT_MS / 60000}min) en ${etiqueta}`));
      }, DUMP_TIMEOUT_MS);

      proc.stderr.on("data", d => stderr += d.toString());

      proc.on("close", code => {
        if (cortado) return;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`mysqldump falló (code ${code}) en ${etiqueta}: ${stderr.slice(0, 200)}`));
      });

      proc.on("error", e => {
        if (cortado) return;
        clearTimeout(timer);
        reject(new Error(`mysqldump error en ${etiqueta}: ${e.message}`));
      });
    });

    // Un dump cortado por timeout deja su --result-file a medio escribir. Se
    // borra antes de cada intento para no acumular parciales de varios GB:
    // el 20-ago quedaron dos en /opt/miia/backups tras los fallos de las 12 y 18.
    const limpiarParciales = () => {
      for (const p of [sqlPath, structPath]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
      }
    };

    // Reintento: el error 1684 ("concurrent DDL statement") es transitorio —
    // ocurre si un ALTER TABLE (migración) corre justo durante el dump.
    // Reintentamos hasta 3 veces esperando a que la migración termine.
    let ultimoError;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        limpiarParciales();
        await correrDump(argsDatos, "datos");

        if (TABLAS_SIN_DATOS.length) {
          await correrDump(argsEstructura, "estructura");
          fs.appendFileSync(sqlPath, fs.readFileSync(structPath));
          try { fs.unlinkSync(structPath); } catch {}
          log(`🗜️  Sin filas de: ${TABLAS_SIN_DATOS.join(", ")} (estructura incluida)`);
        }

        ultimoError = null;
        break;
      } catch (e) {
        ultimoError = e;
        const transitorio = /concurrent DDL|1684|Lock wait timeout|1205/i.test(e.message);
        if (intento < 3 && transitorio) {
          log(`⚠️ Backup: error transitorio (intento ${intento}/3), reintentando en 10s…`, "warn");
          await new Promise(r => setTimeout(r, 10_000));
        } else {
          break;
        }
      }
    }
    if (ultimoError) { limpiarParciales(); throw ultimoError; }

    // Verificar archivo generado
    if (!fs.existsSync(sqlPath)) {
      throw new Error("El archivo .sql no fue creado.");
    }
    const stats = fs.statSync(sqlPath);
    if (stats.size < 500) {
      throw new Error(`El archivo .sql es sospechosamente pequeño (${stats.size} bytes).`);
    }
    log(`✅ .sql creado: ${(stats.size / 1024).toFixed(1)} KB`);

    // Comprimir a ZIP
    const zipName = makeBackupName("zip");
    const zipPath = path.join(BACKUP_DIR, zipName);
    await compressBackup(sqlPath, zipPath);

    // Verificar ZIP
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size <= 0) {
      throw new Error("El archivo .zip no fue creado correctamente.");
    }
    const zipStats = fs.statSync(zipPath);
    log(`✅ ZIP creado: ${(zipStats.size / 1024).toFixed(1)} KB`);

    // Eliminar .sql (queda solo el .zip)
    try { fs.unlinkSync(sqlPath); } catch (_) {}

    // Rotar backups antiguos
    cleanOldBackups(10);

    log("✅ Backup completado correctamente.");
    await publicarEvento("backup_ok", {
      archivo: zipName,
      tamanio: zipStats.size,
      base:    dbName,
    });

  } catch (e) {
    log(`❌ Backup falló: ${e.message}`, "error");
    await publicarEvento("backup_error", { error: e.message });
  } finally {
    isRunning = false;
  }
}

// ══════════════════════════════════════════════════════════
// LOOP PRINCIPAL
// ══════════════════════════════════════════════════════════

// Intervalo entre backups completos.
//
// Era 30 min, calibrado cuando la base pesaba poco. Medido el 15-ago-2026:
// `user_decisions` sola tiene 6,3 M filas y 5,1 GB (el 98% de la base), y cada
// mysqldump tarda ~4 min leyéndola entera. Con innodb_buffer_pool_size en su
// default de 128 MB, ese barrido DESALOJA la caché completa cada media hora —
// `buff/cache` saltó de 2 GB a 8,2 GB en 12 min — y deja a todas las demás
// consultas leyendo de disco.
//
// 6 h mantiene la protección real (10 backups = 2,5 días de cobertura) sin
// tener el disco y la caché en barrido permanente. Si hiciera falta más
// granularidad, la respuesta es binlog incremental, no dumps completos seguidos.
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000;  // 6 horas

function startMainLoop() {
  log("🔁 class34 (MySQL Edition) iniciada.");
  log(`📁 Backups en: ${BACKUP_DIR}`);
  log(`⏱️  Intervalo: ${BACKUP_INTERVAL / 60000} minutos`);
  log(`🗄️  Base: ${dbName}`);

  // Inicializar: detectar base
  detectarBaseActiva().then(() => {
    // Backup inmediato al arrancar
    backupSQL().catch(e => log(`❌ Error en backup inicial: ${e.message}`, "error"));
  });

  // Backup periódico
  const intervalId = setInterval(() => {
    backupSQL().catch(e => log(`❌ Error en backup programado: ${e.message}`, "error"));
  }, BACKUP_INTERVAL);

  // .unref() para no bloquear el proceso
  intervalId.unref();

  return {
    stop: () => { clearInterval(intervalId); log("⏹️ Loop detenido."); },
    intervalId,
  };
}

const mainLoopHandle = startMainLoop();

export { startMainLoop, mainLoopHandle, backupSQL, detectarBaseActiva };