// ============================================================
// class42.js — Cliente MySQL Cognitivo MIIA
// VERSIÓN CORREGIDA v1.9.1 — migrado de mssql → mysql2/promise
//
// CONTRATO DE EXPORTS (idéntico a la versión mssql):
//   guardarDecision          — class25 llama esto
//   guardarAprendizaje       — class24/25 llama esto
//   obtenerUltimasDecisiones — class27 llama esto
//   guardarEstadoCognitivo   — módulos de estado llaman esto
//   obtenerDecisionesPorUsuario
//   query                    — query genérico
//   getSQL                   — retorna el pool (compat)
//   cerrarSQL                — cierra el pool
//
// NUEVAS EXPORTACIONES:
//   guardarPDF, guardarFragmento, vincularCrisisPDF
//   obtenerCrisisPorNombre, insertarCrisisIfNotExists
//   guardarCausal, guardarSnapshot, logEvento
//
// CONFIG en sql.ini (via class38.getConfig("sql")):
//   db_host=localhost
//   db_port=3306
//   db_user=root
//   db_password=
//   db_name=miia_cognitiva
// ============================================================
 
import mysql from "mysql2/promise";
import chalk from "chalk";
import path  from "path";
import { fileURLToPath } from "url";
 
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
 
// ── Config desde class38 ───────────────────────────────────
let cfg = {};
try {
  const { getConfig } = await import("./class38.js");
  cfg = getConfig("sql") || {};
} catch (_) {}
 
// Prioridad: .env / variables de entorno (cargadas por class38) → sql.ini → default.
// Las credenciales viven en operador/aprendizaje/config/.env, no en el código.
const DB_HOST = process.env.DB_HOST || cfg.db_host     || cfg.server   || "localhost";
const DB_PORT = parseInt(process.env.DB_PORT || cfg.db_port || cfg.port || "3306");
const DB_USER = process.env.DB_USER || cfg.db_user     || cfg.user     || "root";
const DB_PASS = process.env.DB_PASS ?? cfg.db_password ?? cfg.password ?? "";
const DB_NAME = process.env.DB_NAME || cfg.db_name     || cfg.database || "miia_cognitiva";
 
// ── Estado del módulo ──────────────────────────────────────
let pool             = null;
let degraded         = false;
let failureCount     = 0;
let openCircuitUntil = 0;
let lastReadFail     = 0;
 
const MAX_FAILURES     = 5;
const CIRCUIT_BREAK_MS = 120_000;
const READ_BACKOFF_MS  = 30_000;
 
// ── Logger ─────────────────────────────────────────────────
function info(msg)  { console.log (chalk.cyan  (`[class42] ${msg}`)); }
function warn(msg)  { console.warn(chalk.yellow(`[class42] ${msg}`)); }
function error(msg) { console.error(chalk.red  (`[class42] ${msg}`)); }

// ── Detección de pérdida de permisos (errno 1044) ──────────
// "Access denied for user ... to database" = el login funciona pero el GRANT
// sobre miia_cognitiva desapareció. Causa conocida: corrupción Aria de
// mysql.db tras un apagado brusco de la PC con XAMPP corriendo.
// El mensaje se emite como máximo 1 vez por minuto para no inundar el log.
let _ultimoAviso1044 = 0;
function _avisarPermisosPerdidos(e) {
  const es1044 = e?.errno === 1044 ||
    /access denied for user .* to database/i.test(e?.message || "");
  if (!es1044) return false;
  if (Date.now() - _ultimoAviso1044 > 60_000) {
    _ultimoAviso1044 = Date.now();
    error("⛔ El usuario MySQL perdió los permisos sobre miia_cognitiva (corrupción de mysql.db tras apagado brusco).");
    error("   Reparación en un comando (como root):");
    if (process.platform === "win32")
      error('   C:\\xampp\\mysql\\bin\\mysql.exe -u root < "operador\\aprendizaje\\config\\reparar_permisos_mysql.sql"');
    else
      error('   mysql -u root < operador/aprendizaje/config/reparar_permisos_mysql.sql');
  }
  return true;
}
 
// ── Crear / reconectar pool ────────────────────────────────
async function connectPool() {
  if (degraded && Date.now() < openCircuitUntil) return null;
  try {
    if (pool) { try { await pool.end(); } catch (_) {} pool = null; }
 
    pool = mysql.createPool({
      host:               DB_HOST,
      port:               DB_PORT,
      user:               DB_USER,
      password:           DB_PASS,
      database:           DB_NAME,
      charset:            "utf8mb4",
      waitForConnections: true,
      connectionLimit:    Number(cfg.pool_max || 5),
      queueLimit:         0,
      connectTimeout:     Number(cfg.connectionTimeout || 15_000),
    });
 
    const conn = await pool.getConnection();
    conn.release();
 
    degraded     = false;
    failureCount = 0;
    info(`✅ MySQL conectado → ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    return pool;
  } catch (e) {
    _avisarPermisosPerdidos(e);   // errno 1044 → mensaje accionable con el fix
    failureCount++;
    if (failureCount >= MAX_FAILURES) {
      degraded         = true;
      openCircuitUntil = Date.now() + CIRCUIT_BREAK_MS;
      error(`Circuit breaker abierto ${CIRCUIT_BREAK_MS/1000}s — ${e.message}`);
    } else {
      warn(`Conexión fallida (${failureCount}/${MAX_FAILURES}): ${e.message}`);
    }
    return null;
  }
}
 
// ── getSQL ─────────────────────────────────────────────────
export async function getSQL() {
  if (pool && !degraded) return pool;
  return await connectPool();
}
 
// ── safeQuery ──────────────────────────────────────────────
// El aviso de breaker abierto se loguea UNA vez por ventana (antes se
// imprimía en cada consulta → decenas de líneas idénticas en el arranque)
let _breakerAvisadoHasta = 0;
async function safeQuery(sql, params = []) {
  if (degraded && Date.now() < openCircuitUntil) {
    if (_breakerAvisadoHasta !== openCircuitUntil) {
      _breakerAvisadoHasta = openCircuitUntil;
      const seg = Math.round((openCircuitUntil - Date.now()) / 1000);
      warn(`safeQuery: circuit breaker abierto — se omiten consultas por ${seg}s`);
    }
    return null;
  }
  let p = pool;
  if (!p) p = await connectPool();
  if (!p) return null;
  try {
    const [rows] = await p.execute(sql, params);
    return rows;
  } catch (e) {
    if (!_avisarPermisosPerdidos(e))
      warn(`safeQuery error: ${e.message} | SQL: ${sql.slice(0, 80)}`);
    failureCount++;
    if (failureCount >= MAX_FAILURES) {
      degraded         = true;
      openCircuitUntil = Date.now() + CIRCUIT_BREAK_MS;
    }
    return null;
  }
}
 
// dbQuery — wrapper público que siempre devuelve un array plano (nunca {recordset:...})
export async function dbQuery(sql, params = []) {
  const rows = await safeQuery(sql, Array.isArray(params) ? params : Object.values(params));
  return Array.isArray(rows) ? rows : [];
}

// ── Migración de columnas faltantes ───────────────────────────
// Agrega columnas que el código espera pero que pueden no existir
// en bases de datos creadas con versiones anteriores del schema.
async function _migrarColumnas() {
  // Tabla de estadísticas acumulativas de backtesting (class43)
  // Persiste métricas aunque la sesión sea nueva (historial en memoria es volátil)
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS backtesting_stats (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      fecha            DATE               NOT NULL,
      total_verificadas INT DEFAULT 0,
      correctas         INT DEFAULT 0,
      incorrectas       INT DEFAULT 0,
      pendientes        INT DEFAULT 0,
      accuracy_global   FLOAT DEFAULT 0,
      accuracy_30d      FLOAT DEFAULT 0,
      precision_buy     FLOAT DEFAULT 0,
      precision_sell    FLOAT DEFAULT 0,
      retorno_promedio  FLOAT DEFAULT 0,
      sharpe            FLOAT DEFAULT 0,
      max_drawdown      FLOAT DEFAULT 0,
      ts_calculo        DATETIME(3) DEFAULT NOW(3),
      UNIQUE KEY uq_fecha (fecha)
    )
  `, []).catch(() => {});

  // Crear tabla precios históricos
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS precios (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      ticker      VARCHAR(20)   NOT NULL,
      sector      VARCHAR(100),
      precio      DECIMAL(12,4),
      change_pct  DECIMAL(8,4),
      riesgo      DECIMAL(6,4),
      score       DECIMAL(6,4),
      ts          DATETIME(3)   DEFAULT NOW(3),
      INDEX idx_ticker_ts (ticker, ts),
      INDEX idx_ts (ts)
    )
  `, []).catch(() => {});

  // Crear tabla noticias si no existe
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS noticias (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      titulo       VARCHAR(500)  NOT NULL,
      snippet      TEXT,
      fuente       VARCHAR(150),
      ticker       VARCHAR(20),
      sentimiento  VARCHAR(20)   DEFAULT 'NEUTRAL',
      url          TEXT,
      imagen_url   TEXT,
      ts_publicado DATETIME(3),
      ts_guardado  DATETIME(3)   DEFAULT NOW(3),
      hash_titulo  VARCHAR(64)   GENERATED ALWAYS AS (SHA2(LEFT(titulo,200),256)) STORED,
      UNIQUE KEY uq_hash (hash_titulo),
      INDEX idx_ticker (ticker),
      INDEX idx_ts     (ts_guardado),
      INDEX idx_sent   (sentimiento)
    )
  `, []).catch(() => {});   // ignorar si la versión MySQL no soporta columnas generadas

  // Alternativa sin columna generada (compatibilidad MySQL 5.7)
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS noticias (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      titulo       VARCHAR(500)  NOT NULL,
      snippet      TEXT,
      fuente       VARCHAR(150),
      ticker       VARCHAR(20),
      sentimiento  VARCHAR(20)   DEFAULT 'NEUTRAL',
      url          TEXT,
      imagen_url   TEXT,
      ts_publicado DATETIME(3),
      ts_guardado  DATETIME(3)   DEFAULT NOW(3),
      INDEX idx_ticker (ticker),
      INDEX idx_ts     (ts_guardado)
    )
  `, []).catch(() => {});

  const migraciones = [
    {t: "cognitive_decisions", c: "precio_salida",     d: "DECIMAL(12,4) DEFAULT NULL"},
    {t: "cognitive_decisions", c: "precio_entrada",    d: "DECIMAL(12,4) DEFAULT NULL"},
    // hash_condicion: firma de condición del ensemble (class25A). Sin persistirla,
    // la reconciliación de class43 no puede devolverle feedback a su memoria
    // bayesiana → quedó en 0 aciertos y arrastraba TODA señal hacia HOLD.
    {t: "cognitive_decisions", c: "hash_condicion",    d: "VARCHAR(32)   DEFAULT NULL"},
    {t: "cognitive_decisions", c: "ts_outcome",        d: "DATETIME(3)   DEFAULT NULL"},
    // decision_modo: "ranking" (BUY a los k mejores / SELL a los k peores de la
    // sección transversal) o "banda" (el z contra el neutro, la regla vieja).
    // Son poblaciones distintas, igual que `label_modo`: sin esta columna no se
    // pueden separar en SQL los dos brazos del corte del 12-oct, y la
    // comparación del experimento se vuelve imposible de hacer después.
    {t: "cognitive_decisions", c: "decision_modo",     d: "VARCHAR(12)   DEFAULT NULL"},
    {t: "cognitive_decisions", c: "accuracy_score",    d: "FLOAT         DEFAULT NULL"},
    // retorno_real: retorno CRUDO del precio/mercado al vencer el horizonte
    // (positivo = subió). Es la materia prima de la equity curve, que ahora se
    // calcula server-side desde acá (agrupando por día de outcome) en vez de
    // depender del buffer en memoria de class43 — que solo veía el goteo de
    // verificaciones en vivo y dejaba la curva trabada en 0 puntos.
    // El signo por estrategia (una SELL gana si baja) se aplica al leer.
    {t: "cognitive_decisions", c: "retorno_real",      d: "FLOAT         DEFAULT NULL"},
    // ── ORDEN 1 (2026-08-03) ────────────────────────────────────────────────
    // retorno_relativo = retorno_del_ticker − promedio de los 13 instrumentos.
    // Es el retorno contra el que ahora se juzga el acierto.
    //
    // POR QUÉ: con el retorno ABSOLUTO el benchmark honesto ("predecir siempre
    // la dirección dominante") acierta ~78% en mercado alcista, y superarlo
    // exige acertar las caídas — lo más difícil que hay. Con el retorno
    // RELATIVO ese benchmark cae a ~50% por construcción, así que un edge de
    // 3-5 pp pasa a ser alcanzable Y detectable.
    //
    // `retorno_real` se conserva como el retorno crudo del instrumento (P&L de
    // la equity curve). Son dos cosas distintas a propósito: la precisión mide
    // habilidad relativa, la curva mide lo que efectivamente hizo el precio.
    {t: "cognitive_decisions", c: "retorno_relativo",  d: "FLOAT         DEFAULT NULL"},
    // Marca de qué etiqueta se usó para juzgar esta fila. Sin esto, las filas
    // pre-Orden-1 (juzgadas contra retorno absoluto) se mezclarían en las
    // mismas métricas que las nuevas y el base_rate saldría de dos poblaciones
    // incomparables — exactamente el tipo de fallo silencioso que veníamos
    // persiguiendo. Las viejas quedan en NULL.
    {t: "cognitive_decisions", c: "label_modo",        d: "VARCHAR(12)   DEFAULT NULL"},
    {t: "user_profiles",      c: "nivel_conocimiento", d: "VARCHAR(20) DEFAULT 'principiante'"},
    {t: "user_profiles",      c: "capital_disponible", d: "VARCHAR(50) DEFAULT NULL"},
    {t: "user_profiles",      c: "onboarding_ok",     d: "TINYINT(1)  DEFAULT 0"},
    {t: "sentiment_signals",  c: "keywords_json",     d: "TEXT          DEFAULT NULL"},
    {t: "sentiment_signals",  c: "precio_entrada",    d: "DECIMAL(12,4) DEFAULT NULL"},
    {t: "sentiment_signals",  c: "outcome_real",      d: "VARCHAR(20)   DEFAULT NULL"},
    {t: "sentiment_signals",  c: "ts_outcome",        d: "DATETIME(3)   DEFAULT NULL"},
    {t: "portfolios",         c: "interes_diario_pct", d: "DECIMAL(10,4) DEFAULT NULL"},
    {t: "portfolios",         c: "interes_mensual_pct",d: "DECIMAL(10,4) DEFAULT NULL"},
    {t: "portfolios",         c: "interes_anual_pct",  d: "DECIMAL(10,4) DEFAULT NULL"},
    {t: "portfolios",         c: "ts_interes",         d: "DATETIME(3)   DEFAULT NULL"},
    // retorno_dia: retorno de ESE día (no acumulado). retorno_promedio guarda
    // el promedio por señal de todo el historial, y componerlo día a día como
    // si fueran retornos independientes inflaba CAGR/Alpha por reanualización.
    // NULL = sin muestra suficiente ese día (≠ 0, que sería "medido y dio cero").
    {t: "backtesting_stats",  c: "retorno_dia",        d: "FLOAT         DEFAULT NULL"},
    {t: "backtesting_stats",  c: "muestras_dia",       d: "INT           DEFAULT 0"},
  ];
  let p = pool; if (!p) p = await connectPool(); if (!p) return;
  for (const {t, c, d} of migraciones) {
    try {
      const [exists] = await p.execute(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`, [t, c]);
      if (!exists.length) await p.execute(`ALTER TABLE \`${t}\` ADD COLUMN \`${c}\` ${d}`);
    } catch (_) {}
  }
  await p.execute(
    `ALTER TABLE cognitive_decisions MODIFY outcome_real ENUM('correcto','incorrecto','pendiente','cancelado','descartado') DEFAULT 'pendiente'`
  ).catch(() => {});
  // Log honesto: si la DB está caída/degradada, la migración NO se completó
  if (degraded) warn("Migración de columnas INCOMPLETA — DB no disponible (se reintentará al reconectar)");
  else info("Migración de columnas completada");
}

// Arrancar conexión al importar y migrar columnas
connectPool().then(() => _migrarColumnas()).catch(() => {});
 
// ══════════════════════════════════════════════════════════
// API COGNITIVA — mismo contrato que versión mssql
// ══════════════════════════════════════════════════════════
 
async function guardarDecision(payload = {}) {
  const start = Date.now();
  try {
    if (!payload || typeof payload !== "object") {
      warn("guardarDecision: payload inválido");
      return { ok: false };
    }
 
    const ticker    = String(payload.ticker    || payload.externalId || "").slice(0, 20);
    const senal     = String(payload.senal     || payload.decision   || "observacion").slice(0, 20);
    const confianza = typeof payload.confianza === "number" ? payload.confianza
                    : typeof payload.confidence === "number" ? payload.confidence : 0.5;
    const razon     = String(payload.razon     || payload.contexto || payload.context || "").slice(0, 5000);
    const temp      = String(payload.temperatura || "estable").slice(0, 20);
    const nFiltros  = parseInt(payload.n_filtros || 0);
    const horizonte = parseInt(payload.horizonte_horas || payload.horizonte || 24);
    const hash      = payload.hash_decision || payload.externalId || payload.id || null;
    // Precio de entrada al momento de la señal — imprescindible para que
    // class43 pueda verificar el outcome aunque el sistema se reinicie
    const pEntrada  = payload.precio_entrada != null && isFinite(parseFloat(payload.precio_entrada))
                    ? parseFloat(payload.precio_entrada) : null;

    // Firma de condición del ensemble — la llave para que class43 pueda cerrar el
    // lazo de aprendizaje con la memoria bayesiana de class25A.
    const hashCond  = String(payload.hash_condicion || "").slice(0, 32) || null;

    // ── El score, por fin en su columna (21-sep-2026) ───────────────────────
    // La columna `score` existe desde siempre y estaba SIEMPRE en NULL: 0 de
    // 102.971 filas de septiembre. El número que toma la decisión sobrevivía
    // sólo dentro de una frase en castellano —"(ensemble=0.6123 > umbral=0.42)"—
    // y para medir el rank IC había que parsear texto con SUBSTRING_INDEX.
    // class25A ya lo publicaba en el payload; lo que faltaba era escribirlo.
    //
    // `=== "number"` y no `parseFloat`: un score ausente tiene que quedar NULL,
    // no 0. Un 0 se leería como "el sistema dijo que no le gana a nadie", que es
    // una afirmación fuerte y falsa — el mismo tipo de número plausible que
    // mide otra cosa contra el que viene trabajando todo el proyecto.
    const score = typeof payload.score === "number" && isFinite(payload.score)
                ? payload.score
                : (typeof payload.score_final === "number" && isFinite(payload.score_final)
                   ? payload.score_final : null);

    // "ranking" | "banda": qué regla decidió. Separa los dos brazos del corte.
    const modoDec = ["ranking", "banda"].includes(String(payload.decision_modo))
                  ? String(payload.decision_modo) : null;

    const result = await safeQuery(
      `INSERT INTO cognitive_decisions
         (ticker, senal, confianza, razon, horizonte_horas,
          temperatura, n_filtros, hash_decision, precio_entrada, hash_condicion,
          score, decision_modo, ts_decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [ticker, senal, confianza, razon, horizonte, temp, nFiltros, hash, pEntrada, hashCond,
       score, modoDec]
    );
 
    if (!result) { degraded = true; return { ok: false, degraded: true }; }
 
    const latency = Date.now() - start;
    info(`Decisión persistida (${senal} ${ticker} conf=${confianza.toFixed(2)}) ⏱ ${latency}ms`);
    return { ok: true, id: result.insertId, latency };
  } catch (e) {
    warn(`guardarDecision error: ${e?.message}`);
    degraded = true;
    return { ok: false, error: e?.message };
  }
}
 
async function guardarAprendizaje(payload = {}) {
  const start = Date.now();
  try {
    if (!payload || typeof payload !== "object") {
      warn("guardarAprendizaje: payload inválido");
      return { ok: false };
    }
 
    const origen      = String(payload.origen    || "unknown").slice(0, 50);
    const prediccion  = typeof payload.prediccion  === "number" ? payload.prediccion  : null;
    const resultado   = typeof payload.resultado   === "number" ? payload.resultado   : null;
    const errorDelta  = typeof payload.error_delta === "number" ? payload.error_delta : null;
    const contenido   = String(payload.contenido   || "").slice(0, 4000);
    const peso        = typeof payload.peso === "number" ? payload.peso : 1.0;
 
    const result = await safeQuery(
      `INSERT INTO learning_cycles (modulo, prediccion, resultado_real, error_delta, ts)
       VALUES (?, ?, ?, ?, NOW(3))`,
      [origen, prediccion, resultado, errorDelta]
    );
 
    if (contenido) {
      await safeQuery(
        `INSERT INTO system_events (modulo, evento, payload, nivel) VALUES (?, ?, ?, ?)`,
        [origen, "aprendizaje", JSON.stringify({ contenido, peso }), "INFO"]
      );
    }
 
    if (!result) { degraded = true; return { ok: false, degraded: true }; }
 
    const latency = Date.now() - start;
    info(`Aprendizaje persistido (origen=${origen}) ⏱ ${latency}ms`);
    return { ok: true, latency };
  } catch (e) {
    warn(`guardarAprendizaje error: ${e?.message}`);
    degraded = true;
    return { ok: false, error: e?.message };
  }
}
 
async function guardarEstadoCognitivo(payload = {}) {
  const start = Date.now();
  try {
    if (!payload || typeof payload !== "object") {
      warn("guardarEstadoCognitivo: payload inválido");
      return { ok: false };
    }
 
    const modulo  = String(payload.modulo  || "cerebro").slice(0, 50);
    const estado  = String(payload.estado  || "unknown").slice(0, 100);
    const detalle = payload.detalle ?? null;
    const nivel   = ["INFO","WARN","ERROR","FATAL"].includes(payload.nivel)
                  ? payload.nivel : "INFO";
 
    const result = await safeQuery(
      `INSERT INTO system_events (modulo, evento, payload, nivel) VALUES (?, ?, ?, ?)`,
      [modulo, estado, JSON.stringify(detalle || {}), nivel]
    );
 
    if (!result) { degraded = true; return { ok: false, degraded: true }; }
 
    const latency = Date.now() - start;
    info(`Estado cognitivo persistido (${modulo}/${estado}) ⏱ ${latency}ms`);
    return { ok: true, latency };
  } catch (e) {
    warn(`guardarEstadoCognitivo error: ${e?.message}`);
    degraded = true;
    return { ok: false, error: e?.message };
  }
}
 
async function obtenerUltimasDecisiones(limit = 50) {
  if (lastReadFail && Date.now() - lastReadFail < READ_BACKOFF_MS) return [];
  try {
    const rows = await safeQuery(
      `SELECT id, ticker, senal, confianza, razon,
              temperatura, outcome_real, accuracy_score,
              ts_decision AS ts,
              ticker      AS external_id,
              senal       AS decision,
              razon       AS contexto
       FROM cognitive_decisions
       ORDER BY ts_decision DESC LIMIT ?`,
      [Math.max(1, Math.min(limit, 200))]
    );
    lastReadFail = 0;
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    lastReadFail = Date.now();
    warn(`obtenerUltimasDecisiones error: ${e?.message}`);
    return [];
  }
}
 
async function obtenerDecisionesPorUsuario(externalId, limit = 20) {
  try {
    if (!externalId) return [];
    const rows = await safeQuery(
      `SELECT id, ticker, senal, confianza, razon, ts_decision AS ts
       FROM cognitive_decisions WHERE ticker = ? ORDER BY ts_decision DESC LIMIT ?`,
      [String(externalId).slice(0, 20), Math.max(1, Math.min(limit, 100))]
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    warn(`obtenerDecisionesPorUsuario error: ${e?.message}`);
    return [];
  }
}
 
export async function query(sqlText, params = {}) {
  try {
    const paramsArr = Array.isArray(params) ? params : Object.values(params);
    const rows = await safeQuery(sqlText, paramsArr);
    return rows ? { recordset: rows, rowsAffected: [rows.length] } : null;
  } catch (e) {
    warn(`query error: ${e?.message}`);
    return null;
  }
}
 
export async function cerrarSQL() {
  try {
    if (pool) { await pool.end(); pool = null; info("Pool MySQL cerrado."); }
  } catch (e) { warn(`cerrarSQL error: ${e?.message}`); }
}
 
// ══════════════════════════════════════════════════════════
// API DOCUMENTAL — class2 y class5
// ══════════════════════════════════════════════════════════
 
export async function guardarPDF({ nombre, tipo, fuente = null, fecha_documento = null, texto_completo, num_paginas = null, tamanio_bytes = null, hash_sha256 }) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    // Truncar a 4MB para respetar max_allowed_packet de MySQL
    const MAX_PDF_CHARS = 4 * 1024 * 1024;
    const textoTruncado = texto_completo && texto_completo.length > MAX_PDF_CHARS
      ? texto_completo.slice(0, MAX_PDF_CHARS)
      : texto_completo;
    const [result] = await p.execute(
      `INSERT IGNORE INTO pdf_documents (nombre, tipo, fuente, fecha_documento, texto_completo, num_paginas, tamanio_bytes, hash_sha256, procesado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [nombre, tipo, fuente, fecha_documento, textoTruncado, num_paginas, tamanio_bytes, hash_sha256]
    );
    if (result.insertId === 0) {
      const rows = await safeQuery("SELECT id FROM pdf_documents WHERE hash_sha256 = ? LIMIT 1", [hash_sha256]);
      return rows?.[0]?.id || null;
    }
    info(`PDF guardado: ${nombre} (id=${result.insertId})`);
    return result.insertId;
  } catch (e) { warn(`guardarPDF error: ${e?.message}`); return null; }
}
 
export async function guardarFragmento({ pdf_id, numero_fragmento, texto, num_tokens = null }) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    const [result] = await p.execute(
      `INSERT INTO pdf_fragments (pdf_id, numero_fragmento, texto, num_tokens) VALUES (?, ?, ?, ?)`,
      [pdf_id, numero_fragmento, texto, num_tokens]
    );
    return result.insertId;
  } catch (e) { warn(`guardarFragmento error: ${e?.message}`); return null; }
}
 
export async function vincularCrisisPDF(crisis_id, pdf_id, patron_json = null) {
  try {
    const p = pool || await connectPool();
    if (!p) return false;
    await p.execute(
      `UPDATE crisis_events SET pdf_origen = ?, patron_json = COALESCE(?, patron_json) WHERE id = ?`,
      [pdf_id, patron_json ? JSON.stringify(patron_json) : null, crisis_id]
    );
    info(`PDF ${pdf_id} vinculado a crisis_event ${crisis_id}`);
    return true;
  } catch (e) { warn(`vincularCrisisPDF error: ${e?.message}`); return false; }
}
 
export async function obtenerCrisisPorNombre(nombre, anio = null) {
  try {
    if (anio) {
      const rows = await safeQuery("SELECT id, nombre, tipo FROM crisis_events WHERE anio_inicio = ? OR anio_fin = ? LIMIT 1", [anio, anio]);
      if (rows?.length) return rows[0];
    }
    const rows = await safeQuery("SELECT id, nombre, tipo FROM crisis_events WHERE nombre LIKE ? LIMIT 1", [`%${String(nombre).slice(0, 20)}%`]);
    return rows?.[0] || null;
  } catch (e) { warn(`obtenerCrisisPorNombre error: ${e?.message}`); return null; }
}
 
export async function insertarCrisisIfNotExists({ nombre, anio_inicio, anio_fin, tipo = "otro", severidad = 5, descripcion = "" }) {
  try {
    const existente = await obtenerCrisisPorNombre(nombre, anio_inicio);
    if (existente) return existente.id;
    const p = pool || await connectPool();
    if (!p) return null;
    const [result] = await p.execute(
      `INSERT INTO crisis_events (nombre, anio_inicio, anio_fin, tipo, severidad, descripcion) VALUES (?, ?, ?, ?, ?, ?)`,
      [nombre, anio_inicio, anio_fin, tipo, severidad, descripcion]
    );
    info(`Nueva crisis: ${nombre} (id=${result.insertId})`);
    return result.insertId;
  } catch (e) { warn(`insertarCrisisIfNotExists error: ${e?.message}`); return null; }
}
 
export async function guardarCausal({ causa, efecto, confianza = 0.5 }) {
  try {
    const p = pool || await connectPool();
    if (!p) return;
    await p.execute(
      `INSERT INTO causal_memory (causa, efecto, confianza, repeticiones, ultimo_refuerzo)
       VALUES (?, ?, ?, 1, NOW(3))
       ON DUPLICATE KEY UPDATE
         repeticiones = repeticiones + 1,
         confianza = LEAST(1.0, confianza + 0.05),
         ultimo_refuerzo = NOW(3)`,
      [causa, efecto, confianza]
    );
  } catch (e) { warn(`guardarCausal error: ${e?.message}`); }
}
 
export async function guardarSnapshot({ fecha, total_decisiones = 0, decisiones_correctas = 0, accuracy_pct = null, sharpe_ratio = null, coherencia_promedio = null, temperatura_dominante = null, pdfs_procesados = 0, vectores_totales = 0 }) {
  try {
    const p = pool || await connectPool();
    if (!p) return;
    await p.execute(
      `INSERT INTO performance_snapshots (fecha, total_decisiones, decisiones_correctas, accuracy_pct, sharpe_ratio, coherencia_promedio, temperatura_dominante, pdfs_procesados, vectores_totales)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_decisiones = VALUES(total_decisiones),
         decisiones_correctas = VALUES(decisiones_correctas),
         accuracy_pct = VALUES(accuracy_pct),
         sharpe_ratio = VALUES(sharpe_ratio),
         coherencia_promedio = VALUES(coherencia_promedio),
         temperatura_dominante = VALUES(temperatura_dominante),
         pdfs_procesados = VALUES(pdfs_procesados),
         vectores_totales = VALUES(vectores_totales),
         ts_calculo = NOW(3)`,
      [fecha, total_decisiones, decisiones_correctas, accuracy_pct, sharpe_ratio, coherencia_promedio, temperatura_dominante, pdfs_procesados, vectores_totales]
    );
  } catch (e) { warn(`guardarSnapshot error: ${e?.message}`); }
}
 
export async function logEvento(modulo, evento, payload = {}, nivel = "INFO") {
  try {
    const p = pool || await connectPool();
    if (!p) return;
    await p.execute(
      `INSERT INTO system_events (modulo, evento, payload, nivel) VALUES (?, ?, ?, ?)`,
      [modulo, evento, JSON.stringify(payload), nivel]
    );
  } catch (_) {}
}
 
// ══════════════════════════════════════════════════════════
// BACKTESTING — class43 y class25
// ══════════════════════════════════════════════════════════

// ── actualizarOutcomeReal ──────────────────────────────────
// Llamada por class43 cuando el horizonte venció.
// Busca la decisión por hash_decision (= externalId del signal)
// y actualiza outcome_real + precio_salida + ts_outcome.
// ORDEN 1: se agregan `retornoRelativo` y `labelModo`.
//   retornoReal      → retorno crudo del instrumento (materia prima de la equity curve)
//   retornoRelativo  → retorno − promedio de los 13 (lo que juzga el acierto)
//   labelModo        → "relativo" | "absoluto"; NULL en las filas pre-Orden-1
// Ambos son opcionales: si no llegan, el comportamiento es idéntico al anterior.
export async function actualizarOutcomeReal(externalId, outcome, precioSalida = null,
                                            retornoReal = null, retornoRelativo = null,
                                            labelModo = null) {
  try {
    if (!externalId) return false;

    const validos = ["correcto", "incorrecto", "pendiente", "cancelado", "descartado"];
    const outcomeFinal = validos.includes(outcome) ? outcome : "pendiente";

    // retorno_real: solo un número finito real; cualquier otra cosa → NULL
    // (NaN/Infinity romperían la equity curve al componerse).
    const retFinal = Number.isFinite(retornoReal) ? +Number(retornoReal).toFixed(6) : null;
    const relFinal = Number.isFinite(retornoRelativo) ? +Number(retornoRelativo).toFixed(6) : null;
    const modoFinal = (labelModo === "relativo" || labelModo === "absoluto") ? labelModo : null;

    // class43 puede pasar:
    //   (A) UUID string como hash_decision — "c43_1719..." o "0b17d383-..."
    //   (B) Integer string como id DB        — "97", "103", etc. (restauradas de MySQL)
    const numId = parseInt(externalId, 10);
    const esId  = !isNaN(numId) && String(numId) === String(externalId).trim();

    const result = await safeQuery(
      `UPDATE cognitive_decisions
       SET outcome_real     = ?,
           precio_salida    = ?,
           retorno_real     = ?,
           retorno_relativo = ?,
           label_modo       = ?,
           ts_outcome       = NOW(3)
       WHERE outcome_real = 'pendiente'
         AND (hash_decision = ?
              OR (? IS NOT NULL AND id = ?))
       LIMIT 1`,
      [outcomeFinal, precioSalida ?? null, retFinal, relFinal, modoFinal,
       externalId, esId ? numId : null, esId ? numId : null]
    );

    if (result && result.affectedRows > 0) {
      info(`Outcome actualizado: ${String(externalId).slice(0,16)} → ${outcomeFinal} precio_salida=${precioSalida ?? "null"} retorno=${retFinal ?? "null"} rel=${relFinal ?? "null"} modo=${modoFinal ?? "-"}`);
      return true;
    }

    warn(`actualizarOutcomeReal: sin filas afectadas para ${String(externalId).slice(0,16)}`);
    return false;
  } catch (e) {
    warn(`actualizarOutcomeReal error: ${e?.message}`);
    return false;
  }
}

// ── completarPrecioEntrada ─────────────────────────────────
// LA DUPLICACION DE FILAS (medida el 14-sep-2026, historica desde el 15-jun).
//
// Cada BUY/SELL se guardaba DOS veces: class25B inserta la decision (con
// hash_condicion, score y decision_modo, sin precio_entrada) y class43, al
// recibirla por class25_output, insertaba OTRA fila (con precio_entrada y sin
// hash_condicion). Medido: 172.927 filas = 91.029 decisiones, y en todas las
// semanas filas = 2 x hash_decision distintos.
//
// Que inflaba: verificadas, pendientes, n_redundancia y cualquier "+104.000
// decisiones" del resumen de venta. La tesis NO cambiaba —el acierto por filas
// daba 49,82 % y por decisiones 49,85 %— porque las dos copias comparten
// resultado, pero ningun conteo de volumen era real.
//
// AHORA class43 COMPLETA la fila de class25B en vez de insertar la suya. Las
// dos comparten `hash_decision`, que es la llave.
//
// Devuelve true si completo una fila. Si devuelve false, la fila de class25B
// todavia no existe: class25B publica a Redis ANTES de escribir en MySQL, asi
// que hay una ventana de milisegundos en la que class43 llega primero. El
// llamador reintenta; recien despues inserta.
export async function completarPrecioEntrada(externalId, precioEntrada) {
  if (!externalId || precioEntrada == null || !isFinite(precioEntrada)) return false;
  try {
    const result = await safeQuery(
      `UPDATE cognitive_decisions
          SET precio_entrada = ?
        WHERE hash_decision  = ?
          AND precio_entrada IS NULL
        ORDER BY id DESC
        LIMIT 1`,
      [parseFloat(precioEntrada), String(externalId).slice(0, 64)]
    );
    return !!(result && result.affectedRows > 0);
  } catch (e) {
    warn(`completarPrecioEntrada error: ${e?.message}`);
    return false;
  }
}

// ── obtenerDecisionesPendientes ────────────────────────────
// Llamada por class25 (verificador de horizonte) y class43.
// Retorna decisiones BUY/SELL con outcome_real = 'pendiente'
// de las últimas N horas — para saber cuáles ya vencieron.
export async function obtenerDecisionesPendientes(horas = 24) {
  if (lastReadFail && Date.now() - lastReadFail < READ_BACKOFF_MS) return [];
  try {
    const horasSafe = Math.max(1, Math.min(Number(horas) || 24, 720)); // máx 30 días
    const rows = await safeQuery(
      `SELECT
         id,
         ticker,
         senal,
         confianza,
         hash_decision   AS external_id,
         horizonte_horas AS horizonte,
         precio_entrada,
         hash_condicion,
         temperatura,
         ts_decision     AS created_at,
         ts_decision     AS ts
       FROM cognitive_decisions
       WHERE outcome_real  = 'pendiente'
         AND senal         IN ('BUY', 'SELL')
         AND ts_decision   >= NOW() - INTERVAL ? HOUR
         -- ── BLOQUEO DE CABEZA DE COLA (medido el 16-sep-2026) ──────────────
         -- Sin esta condicion la consulta traia las 500 pendientes mas viejas
         -- SIN mirar si ya habian vencido. Las de 48 h, todavia en vuelo,
         -- llenaban la ventana y tapaban a las de 24 h que SI estaban listas:
         -- cada ciclo verificaba entre 63 y 135 de 500, y una decision de 24 h
         -- terminaba verificandose cerca de las 48.
         --
         -- No se perdia entrenamiento —los vectores de class24 y los snapshots
         -- de class25A duran 80 h y se buscan por la hora de la decision— pero
         -- el primer subconjunto verificado de cada dia quedaba sesgado hacia
         -- las primeras horas, que es un sesgo de muestreo sobre la medicion.
         --
         -- horizonte_horas puede venir en NULL en filas viejas: COALESCE a 24,
         -- que es el default del INSERT. Es una funcion sobre la columna, pero
         -- del lado del VALOR, no del filtro indexable: el rango sobre
         -- ts_decision sigue usando el indice.
         AND ts_decision + INTERVAL COALESCE(horizonte_horas, 24) HOUR <= NOW()
       ORDER BY ts_decision ASC
       LIMIT 500`,
      [horasSafe]
    );
    lastReadFail = 0;
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    lastReadFail = Date.now();
    warn(`obtenerDecisionesPendientes error: ${e?.message}`);
    return [];
  }
}

// ── guardarBacktestingRun ──────────────────────────────────
// Registra una corrida de backtesting en backtesting_runs.
// class43 la usa para registrar cada ciclo de validación.
export async function guardarBacktestingRun({
  nombre           = "auto",
  descripcion      = "",
  ticker           = "GENERAL",
  senal            = "HOLD",
  confianza        = 0,
  precio_entrada   = null,
  horizonte        = 24,
  ts_inicio        = null,
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    const [result] = await p.execute(
      `INSERT INTO backtesting_runs
         (nombre, descripcion, ticker, senal, confianza,
          precio_entrada, horizonte_horas, ts_inicio, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW(3)), 'activo')`,
      [
        String(nombre).slice(0, 100),
        String(descripcion).slice(0, 500),
        String(ticker).slice(0, 20),
        String(senal).slice(0, 10),
        typeof confianza === "number" ? confianza : 0,
        precio_entrada ?? null,
        Math.max(1, parseInt(horizonte) || 24),
        ts_inicio ?? null,
      ]
    );

    info(`BacktestingRun guardado: ${nombre} ${senal} ${ticker} (id=${result.insertId})`);
    return result.insertId;
  } catch (e) {
    warn(`guardarBacktestingRun error: ${e?.message}`);
    return null;
  }
}

// ── marcarPDFProcesado ─────────────────────────────────────
// Llamada por class2 después de vectorizar y publicar un PDF.
// Marca el PDF como procesado en pdf_documents.
export async function marcarPDFProcesado(pdfId) {
  try {
    if (!pdfId) return false;
    await safeQuery(
      `UPDATE pdf_documents SET procesado = 1, ts_procesado = NOW(3) WHERE id = ?`,
      [pdfId]
    );
    return true;
  } catch (e) {
    warn(`marcarPDFProcesado error: ${e?.message}`);
    return false;
  }
}

// ============================================================
// PORTFOLIOS — tablas: portfolios, portfolio_assets,
//              portfolio_transactions, signals_feed
// ============================================================

/**
 * guardarPortfolio — guarda el portfolio principal y sus activos.
 * Llamado desde class17.js después de validar el portfolio.
 * Usa INSERT IGNORE para no duplicar (portfolio_id es UNIQUE).
 */
export async function guardarPortfolio({
  portfolio_id,
  user_id       = "general",
  strategy      = "balanced",
  status        = "stable",
  confidence    = 0,
  risk_level    = 0.5,
  riesgo_global = 0.5,
  n_activos     = 0,
  assets        = [],   // array de strings (símbolos)
  details       = [],   // array de objetos con datos por activo
  market_ts     = null,
  provider      = "unknown",
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    // 1. Insertar portfolio principal
    const [res] = await p.execute(
      `INSERT IGNORE INTO portfolios
         (portfolio_id, user_id, strategy, status, confidence,
          risk_level, riesgo_global, n_activos, market_ts, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(portfolio_id).slice(0, 50),
        String(user_id).slice(0, 100),
        String(strategy).slice(0, 50),
        String(status).slice(0, 30),
        typeof confidence  === "number" ? confidence  : 0,
        typeof risk_level  === "number" ? risk_level  : 0.5,
        typeof riesgo_global === "number" ? riesgo_global : 0.5,
        assets.length || n_activos,
        market_ts ?? null,
        String(provider).slice(0, 50),
      ]
    );

    // Si ya existía (insertId=0 con IGNORE) salir sin duplicar assets
    if (!res.insertId) {
      info(`Portfolio ya existe: ${portfolio_id}`);
      return null;
    }

    const portfolio_db_id = res.insertId;

    // 2. Insertar activos en portfolio_assets
    if (details.length > 0) {
      for (const d of details) {
        await p.execute(
          `INSERT IGNORE INTO portfolio_assets
             (portfolio_id, symbol, sector, score, momentum,
              riesgo, confianza, peso, precio_entrada, change_pct,
              estado_sector, diversificacion)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(portfolio_id).slice(0, 50),
            String(d.symbol    || "").slice(0, 20),
            String(d.sector    || "").slice(0, 50),
            typeof d.score     === "number" ? d.score     : 0,
            typeof d.momentum  === "number" ? d.momentum  : 0,
            typeof d.riesgo    === "number" ? d.riesgo    : 0,
            typeof d.confianza === "number" ? d.confianza : 0,
            typeof d.peso      === "number" ? d.peso      : 0,
            d.precio_entrada ?? null,
            typeof d.change_pct === "number" ? d.change_pct : 0,
            String(d.estado_sector   || "neutral").slice(0, 20),
            typeof d.diversificacion === "number" ? d.diversificacion : 0,
          ]
        ).catch(e => warn(`portfolio_assets insert error: ${e?.message} (${d.symbol})`));
      }
    }

    info(`Portfolio guardado: ${portfolio_id} | ${assets.length} activos | id=${portfolio_db_id}`);
    return portfolio_db_id;

  } catch (e) {
    warn(`guardarPortfolio error: ${e?.message}`);
    return null;
  }
}

/**
 * registrarTransaccionPortfolio — registra un evento de lifecycle
 * (rebalanceo, alerta de riesgo, etc.) en portfolio_transactions.
 * Llamado desde class17 cuando evaluarLifecycle detecta un evento.
 */
export async function registrarTransaccionPortfolio({
  portfolio_id,
  user_id       = "general",
  tipo          = "lifecycle_event",  // lifecycle_event | rebalance | risk_alert
  evento        = null,               // event_to_publish.event
  razon         = null,               // event_to_publish.reason
  status        = "stable",
  confidence    = 0,
  risk_level    = 0.5,
  detalle       = null,               // JSON extra
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    const [res] = await p.execute(
      `INSERT INTO portfolio_transactions
         (portfolio_id, user_id, tipo, evento, razon,
          status, confidence, risk_level, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(portfolio_id).slice(0, 50),
        String(user_id).slice(0, 100),
        String(tipo).slice(0, 30),
        evento   ? String(evento).slice(0, 50)  : null,
        razon    ? String(razon).slice(0, 100) : null,
        String(status).slice(0, 30),
        typeof confidence === "number" ? confidence : 0,
        typeof risk_level === "number" ? risk_level : 0.5,
        detalle  ? JSON.stringify(detalle).slice(0, 2000) : null,
      ]
    );
    return res.insertId;

  } catch (e) {
    warn(`registrarTransaccionPortfolio error: ${e?.message}`);
    return null;
  }
}

/**
 * guardarSeñalFeed — registra una señal de class25B en signals_feed.
 * Permite al usuario ver el historial de señales en la UI.
 */
export async function guardarSeñalFeed({
  signal_id    = null,
  user_id      = "general",
  portfolio_id = null,
  senal        = "HOLD",
  ticker       = "GENERAL",
  confianza    = 0,
  horizonte    = 24,
  stop_loss    = null,
  riesgo       = 0.5,
  texto        = "",
  fuente       = "class25B",
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    // user_id NULL cuando es "general" para evitar FK violation
    // (signals_feed.user_id referencia users.id; "general" no existe en users)
    const uid = (user_id && user_id !== "general") ? String(user_id).slice(0, 100) : null;

    const [res] = await p.execute(
      `INSERT INTO signals_feed
         (signal_id, user_id, portfolio_id, senal, ticker,
          confianza, horizonte_horas, stop_loss, riesgo, texto, fuente)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        signal_id    ? String(signal_id).slice(0, 50)    : null,
        uid,
        portfolio_id ? String(portfolio_id).slice(0, 50) : null,
        String(senal).slice(0, 10),
        String(ticker).slice(0, 20),
        typeof confianza  === "number" ? confianza  : 0,
        Math.max(1, parseInt(horizonte) || 24),
        stop_loss != null ? Number(stop_loss) : null,
        typeof riesgo     === "number" ? riesgo     : 0.5,
        String(texto).slice(0, 3000),
        String(fuente).slice(0, 30),
      ]
    );
    return res.insertId;

  } catch (e) {
    warn(`guardarSeñalFeed error: ${e?.message}`);
    return null;
  }
}

/**
 * guardarUsuario — guarda o actualiza usuario en tabla 'users'.
 * Llamado desde class14.js al hacer OAuth.
 */
export async function guardarUsuario({
  user_id,
  email       = null,
  name        = null,
  avatar      = null,
  provider    = null,
  provider_id = null,
  plan        = "free",
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    // Upsert: crear si no existe, actualizar login si existe
    await p.execute(
      `INSERT INTO users
         (user_id, email, name, avatar, plan, ts_ultimo_login)
       VALUES (?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE
         name            = COALESCE(VALUES(name), name),
         avatar          = COALESCE(VALUES(avatar), avatar),
         ts_ultimo_login = NOW(3)`,
      [
        String(user_id).slice(0, 100),
        email       ? String(email).slice(0, 255)  : null,
        name        ? String(name).slice(0, 255)   : null,
        avatar      ? String(avatar).slice(0, 500) : null,
        String(plan).slice(0, 20),
      ]
    );

    // Guardar user_settings si no existe
    await p.execute(
      `INSERT IGNORE INTO user_settings (user_id) VALUES (?)`,
      [String(user_id).slice(0, 100)]
    ).catch(() => {});

    info(`Usuario guardado/actualizado: ${user_id}`);
    return user_id;

  } catch (e) {
    warn(`guardarUsuario error: ${e?.message}`);
    return null;
  }
}

/**
 * actualizarPlanUsuario — actualiza plan y vencimiento.
 * Llamado desde class14 cuando Mercado Pago confirma pago.
 */
export async function actualizarPlanUsuario({
  user_id,
  plan           = "basico",
  dias           = 30,
  mp_payment_id  = null,
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return false;

    const vencimiento = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

    await p.execute(
      `UPDATE users
       SET plan = ?, plan_vencimiento = ?
       WHERE user_id = ?`,
      [String(plan).slice(0, 20), vencimiento, String(user_id)]
    );

    // Registrar en subscriptions si existe esa tabla
    await p.execute(
      `INSERT IGNORE INTO subscriptions
         (user_id, plan, mp_payment_id, fecha_inicio, fecha_vencimiento, estado)
       VALUES (?, ?, ?, NOW(3), ?, 'activa')`,
      [
        String(user_id).slice(0, 100),
        String(plan).slice(0, 20),
        mp_payment_id ? String(mp_payment_id).slice(0, 100) : null,
        vencimiento,
      ]
    ).catch(() => {}); // silencioso si la tabla tiene esquema diferente

    info(`Plan actualizado: ${user_id} → ${plan} (vence ${vencimiento.toISOString()})`);
    return true;

  } catch (e) {
    warn(`actualizarPlanUsuario error: ${e?.message}`);
    return false;
  }
}


// ── Exports mismo contrato que versión mssql ──────────────
// getSQL, cerrarSQL, query ya tienen "export" inline arriba
export {
  guardarDecision,
  guardarAprendizaje,
  obtenerUltimasDecisiones,
  guardarEstadoCognitivo,
  obtenerDecisionesPorUsuario,
};

// ============================================================
// PORTFOLIOS — Consulta para recomendación al usuario
// ============================================================

/**
 * obtenerUltimoPortfolio — trae el portfolio más reciente
 * con todos sus activos y pesos para mostrarlo al usuario.
 * Llamado desde class25B antes de redactar con Gemini.
 */
export async function obtenerUltimoPortfolio(user_id = "general") {
  try {
    const p = pool || await connectPool();
    if (!p) return null;

    // Obtener el portfolio más reciente
    const [rows] = await p.execute(`
      SELECT p.portfolio_id, p.strategy, p.status,
             ROUND(p.confidence * 100, 1)  AS confianza_pct,
             ROUND(p.risk_level * 100, 1)  AS riesgo_pct,
             ROUND(p.riesgo_global * 100, 1) AS riesgo_global_pct,
             p.n_activos, p.ts
      FROM portfolios p
      WHERE p.user_id = ? OR p.user_id = 'general'
      ORDER BY p.ts DESC
      LIMIT 1
    `, [user_id]);

    if (!rows || rows.length === 0) return null;
    const port = rows[0];

    // Obtener activos de ese portfolio
    const [assets] = await p.execute(`
      SELECT symbol, sector,
             ROUND(peso * 100, 1)       AS peso_pct,
             ROUND(change_pct, 1)       AS change_pct,
             ROUND(score * 100, 1)      AS score_pct,
             ROUND(riesgo * 100, 1)     AS riesgo_pct,
             ROUND(confianza * 100, 1)  AS confianza_pct,
             estado_sector
      FROM portfolio_assets
      WHERE portfolio_id = ?
      ORDER BY peso DESC
      LIMIT 10
    `, [port.portfolio_id]);

    return {
      ...port,
      activos: assets || [],
      // Texto compacto para el prompt de Gemini
      resumen_texto: (assets || [])
        .map(a => {
          const chg = parseFloat(a.change_pct ?? 0);
          return `${a.symbol} (${a.sector}) — peso: ${parseFloat(a.peso_pct ?? 0).toFixed(1)}%, `
               + `cambio: ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%, `
               + `estado: ${a.estado_sector}`;
        })
        .join(" | "),
    };
  } catch (e) {
    warn(`obtenerUltimoPortfolio error: ${e?.message}`);
    return null;
  }
}

/**
 * obtenerHistorialPortfolios — últimos N portfolios para mostrar
 * en el panel de usuario o en el admin.
 */
export async function obtenerHistorialPortfolios(user_id = "general", limit = 5) {
  try {
    const p = pool || await connectPool();
    if (!p) return [];
    const [rows] = await p.execute(`
      SELECT portfolio_id, strategy, status,
             ROUND(confidence * 100, 1)  AS confianza_pct,
             ROUND(risk_level * 100, 1)  AS riesgo_pct,
             n_activos, ts
      FROM portfolios
      WHERE user_id = ? OR user_id = 'general'
      ORDER BY ts DESC
      LIMIT ?
    `, [user_id, limit]);
    return rows || [];
  } catch (e) {
    warn(`obtenerHistorialPortfolios error: ${e?.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════
// NUEVAS TABLAS — Motores predictivos (2026-06-18)
// ══════════════════════════════════════════════════════════

/**
 * logSistema — escribe en system_log (tabla nueva, más detallada que system_events).
 * @param {object} opts
 *   fuente       {string}  'class44', 'class45', etc.
 *   nivel        {string}  'debug'|'info'|'warn'|'error'|'fatal'
 *   evento       {string}  nombre corto del evento
 *   mensaje      {string}  texto legible
 *   detalle      {object}  payload JSON (opcional)
 *   stack_trace  {string}  stack trace si error (opcional)
 *   ticker       {string}  ticker de mercado (opcional)
 *   canal_redis  {string}  canal Redis origen (opcional)
 *   sesion_id    {string}  (opcional)
 *   user_id      {string}  (opcional)
 */
export async function logSistema({
  fuente = "sistema", nivel = "info", evento = "evento",
  mensaje = "", detalle = null, stack_trace = null,
  ticker = null, canal_redis = null, sesion_id = null, user_id = null,
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return;
    await p.execute(
      `INSERT INTO system_log
         (fuente, nivel, canal_redis, evento, mensaje, detalle, stack_trace, ticker, sesion_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fuente, nivel, canal_redis, evento, mensaje,
       detalle ? JSON.stringify(detalle) : null,
       stack_trace, ticker, sesion_id, user_id]
    );
  } catch (_) {}
}

/**
 * guardarPrediccionLSTM — persiste una predicción de class44 en lstm_predictions.
 */
export async function guardarPrediccionLSTM({
  ticker, senal, confianza, prob_buy = null, prob_hold = null, prob_sell = null,
  horizonte = "24h", precio_actual = null, rsi = null, macd = null,
  bb_pct = null, atr_r = null, modelo_version = null, publicado = 0,
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    const [res] = await p.execute(
      `INSERT INTO lstm_predictions
         (ticker, senal, confianza, prob_buy, prob_hold, prob_sell,
          horizonte, precio_actual, rsi, macd, bb_pct, atr_r, modelo_version, publicado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticker, senal, confianza, prob_buy, prob_hold, prob_sell,
       horizonte, precio_actual, rsi, macd, bb_pct, atr_r, modelo_version, publicado ? 1 : 0]
    );
    return res.insertId;
  } catch (e) { warn(`guardarPrediccionLSTM error: ${e?.message}`); return null; }
}

/**
 * guardarSentimientoSignal — persiste señal de sentimiento (class45) en sentiment_signals.
 */
export async function guardarSentimientoSignal({
  ticker, senal, sentiment_label, sentiment_score,
  confianza, n_articulos = 0, publicado = 0,
  keywords = null, precio_entrada = null,
} = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    const [res] = await p.execute(
      `INSERT INTO sentiment_signals
         (ticker, senal, sentiment_label, sentiment_score, confianza, n_articulos, publicado, keywords_json, precio_entrada)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ticker, senal, sentiment_label, sentiment_score, confianza, n_articulos, publicado ? 1 : 0,
       keywords && keywords.length ? JSON.stringify(keywords) : null,
       precio_entrada != null ? precio_entrada : null]
    );
    return res.insertId;
  } catch (e) { warn(`guardarSentimientoSignal error: ${e?.message}`); return null; }
}

/**
 * obtenerSentimientoPendienteVerificar — señales de sentimiento (class45) sin outcome_real,
 * dentro de una ventana de horas [horasMin, horasMaxAge] desde que se publicaron.
 * horasMin da tiempo a que el precio se mueva; horasMaxAge evita verificar señales viejísimas.
 */
export async function obtenerSentimientoPendienteVerificar(horasMin = 4, horasMaxAge = 72) {
  if (lastReadFail && Date.now() - lastReadFail < READ_BACKOFF_MS) return [];
  try {
    const rows = await safeQuery(
      `SELECT id, ticker, sentiment_label, keywords_json, precio_entrada, ts
       FROM sentiment_signals
       WHERE outcome_real IS NULL
         AND precio_entrada IS NOT NULL
         AND ts <= NOW() - INTERVAL ? HOUR
         AND ts >= NOW() - INTERVAL ? HOUR
       ORDER BY ts ASC
       LIMIT 200`,
      [horasMin, horasMaxAge]
    );
    lastReadFail = 0;
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    lastReadFail = Date.now();
    warn(`obtenerSentimientoPendienteVerificar error: ${e?.message}`);
    return [];
  }
}

/**
 * actualizarOutcomeSentimiento — marca el resultado real (correcto/incorrecto/neutral)
 * de una señal de sentimiento ya verificada contra el precio real.
 */
export async function actualizarOutcomeSentimiento(id, outcomeReal) {
  try {
    if (!id) return false;
    const validos = ["correcto", "incorrecto", "neutral"];
    const outcome = validos.includes(outcomeReal) ? outcomeReal : "neutral";
    const result = await safeQuery(
      `UPDATE sentiment_signals
       SET outcome_real = ?, ts_outcome = NOW(3)
       WHERE id = ? AND outcome_real IS NULL`,
      [outcome, id]
    );
    return !!(result && result.affectedRows > 0);
  } catch (e) {
    warn(`actualizarOutcomeSentimiento error: ${e?.message}`);
    return false;
  }
}


// ══════════════════════════════════════════════════════════
// BACKTESTING STATS — guardar y obtener acumulado histórico
// ══════════════════════════════════════════════════════════

export async function guardarBacktestingStats(stats = {}) {
  const p = pool || await connectPool();
  if (!p) return;
  const hoy = new Date().toISOString().slice(0, 10);
  await safeQuery(`
    INSERT INTO backtesting_stats
      (fecha, total_verificadas, correctas, incorrectas, pendientes,
       accuracy_global, accuracy_30d, precision_buy, precision_sell,
       retorno_promedio, retorno_dia, muestras_dia, sharpe, max_drawdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      total_verificadas = GREATEST(total_verificadas, VALUES(total_verificadas)),
      correctas         = GREATEST(correctas, VALUES(correctas)),
      incorrectas       = GREATEST(incorrectas, VALUES(incorrectas)),
      pendientes        = VALUES(pendientes),
      accuracy_global   = VALUES(accuracy_global),
      accuracy_30d      = VALUES(accuracy_30d),
      precision_buy     = VALUES(precision_buy),
      precision_sell    = VALUES(precision_sell),
      retorno_promedio  = VALUES(retorno_promedio),
      retorno_dia       = VALUES(retorno_dia),
      muestras_dia      = VALUES(muestras_dia),
      sharpe            = VALUES(sharpe),
      max_drawdown      = VALUES(max_drawdown),
      ts_calculo        = NOW(3)
  `, [
    hoy,
    stats.total         || 0,
    stats.correctas     || 0,
    stats.incorrectas   || 0,
    stats.pendientes    || 0,
    stats.accuracy_global  || 0,
    stats.accuracy_30d     || 0,
    stats.precision_buy    || 0,
    stats.precision_sell   || 0,
    stats.retorno_promedio || 0,
    // ?? null (no || 0): un retorno diario de 0 real y "sin muestra" son
    // cosas distintas y la equity curve debe poder distinguirlas.
    stats.retorno_dia  ?? null,
    stats.muestras_dia ?? 0,
    stats.sharpe           || 0,
    stats.max_drawdown     || 0,
  ]).catch(() => {});
}

export async function obtenerHistorialBacktesting(dias = 30) {
  try {
    const p = pool || await connectPool();
    if (!p) return [];
    const rows = await safeQuery(`
      SELECT fecha, total_verificadas, correctas, pendientes,
             ROUND(accuracy_global*100,1) AS acc_pct,
             ROUND(accuracy_30d*100,1)    AS acc30_pct,
             ROUND(precision_buy*100,1)   AS buy_pct,
             ROUND(precision_sell*100,1)  AS sell_pct,
             ROUND(retorno_promedio*100,2) AS retorno_pct,
             ROUND(sharpe,3)              AS sharpe,
             ROUND(max_drawdown*100,1)    AS drawdown_pct
      FROM backtesting_stats
      WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY fecha DESC LIMIT 60
    `, [dias]);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════════
// PRECIOS HISTÓRICOS — guardar y obtener
// ══════════════════════════════════════════════════════════

export async function guardarPrecios(sectores = []) {
  if (!sectores.length) return;
  const p = pool || await connectPool();
  if (!p) return;
  for (const s of sectores) {
    const ticker = s.etf || s.ticker || s.symbol;
    if (!ticker) continue;
    await safeQuery(
      `INSERT INTO precios (ticker, sector, precio, change_pct, riesgo, score)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ticker.slice(0,20),
        (s.sector || "").slice(0,100),
        s.precio != null ? parseFloat(s.precio) : null,
        parseFloat(s.change ?? s.change_pct ?? 0),
        parseFloat(s.riesgo ?? 0.5),
        parseFloat(s.score ?? 0.5),
      ]
    ).catch(() => {});
  }
}

export async function obtenerPreciosHistoricos(ticker = null, horas = 24) {
  const p = pool || await connectPool();
  if (!p) return [];
  const cond = ticker ? "AND ticker=?" : "";
  const vals = ticker
    ? [horas, ticker]
    : [horas];
  const rows = await safeQuery(
    `SELECT ticker, sector, precio, change_pct, riesgo, score, ts
     FROM precios
     WHERE ts > DATE_SUB(NOW(), INTERVAL ? HOUR) ${cond}
     ORDER BY ts DESC LIMIT 200`,
    vals
  );
  return Array.isArray(rows) ? rows : [];
}

export async function obtenerPrecioActual(ticker) {
  const p = pool || await connectPool();
  if (!p) return null;
  const rows = await safeQuery(
    `SELECT ticker, sector, precio, change_pct, riesgo, score, ts
     FROM precios WHERE ticker=? ORDER BY ts DESC LIMIT 1`,
    [ticker]
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Calcular Sharpe ratio simple desde precios históricos
export async function calcularSharpeRatio(horas = 48) {
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    const rows = await safeQuery(
      `SELECT AVG(change_pct) AS media, STDDEV(change_pct) AS std, COUNT(*) AS n
       FROM precios WHERE ts > DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [horas]
    );
    if (!rows?.[0] || !rows[0].std || rows[0].std === 0) return null;
    const { media, std } = rows[0];
    return parseFloat(((media / std) * Math.sqrt(252)).toFixed(3));
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════
// NOTICIAS — guardar y obtener
// ══════════════════════════════════════════════════════════

// ── Saneamiento de contenido externo ─────────────────────────────────────
// Las noticias las scrapea class1 de internet: son entrada NO CONFIABLE. Antes
// se guardaban con un .slice() y nada más, y el front las interpolaba en
// innerHTML → XSS almacenado (30-ago-2026). El front ya escapa, pero eso
// protege a UN consumidor; la fila en la DB la puede leer el panel Python, un
// export, un cliente futuro. Se sanea en el borde de entrada.
//
// No se escapa a entidades acá a propósito: eso rompería el texto para quien
// lo consuma correctamente. Se ELIMINAN las construcciones peligrosas.
function _limpiarTexto(v, max) {
  if (v == null) return null;
  const s = String(v)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|style|svg|link|meta)\b[^>]*>/gi, "")
    .replace(/<[^>]*>/g, "")            // cualquier resto de etiqueta
    .replace(/\bon\w+\s*=/gi, "")       // onerror=, onload=, onclick=…
    .replace(/javascript:/gi, "")
    .replace(/[\x00-\x1F\x7F]/g, " ")   // caracteres de control
    .trim();
  return s ? s.slice(0, max) : null;
}

// Solo http/https. Una URL con otro esquema (javascript:, data:) no se guarda.
function _limpiarUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(s)) return null;
  return s.slice(0, 2000);
}

/**
 * guardarNoticia — persiste un artículo en la tabla noticias.
 * Usa INSERT IGNORE para evitar duplicados por URL o título.
 */
export async function guardarNoticia({
  titulo, snippet = null, fuente = null, ticker = null,
  sentimiento = "NEUTRAL", url = null, imagen_url = null,
  ts_publicado = null,
} = {}) {
  if (!titulo?.trim()) return null;
  try {
    const p = pool || await connectPool();
    if (!p) return null;
    const [res] = await p.execute(
      `INSERT IGNORE INTO noticias
         (titulo, snippet, fuente, ticker, sentimiento, url, imagen_url, ts_publicado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        _limpiarTexto(titulo, 490),
        _limpiarTexto(snippet, 3000),
        _limpiarTexto(fuente, 140),
        _limpiarTexto(ticker, 20),
        _limpiarTexto(sentimiento, 20),
        _limpiarUrl(url),
        _limpiarUrl(imagen_url),
        ts_publicado ? new Date(ts_publicado) : null,
      ]
    );
    return res?.insertId || null;
  } catch (e) { warn(`guardarNoticia error: ${e?.message}`); return null; }
}

/**
 * obtenerNoticias — últimas N noticias, opcionalmente filtradas por ticker.
 */
export async function obtenerNoticias({ limit = 30, ticker = null, sentimiento = null } = {}) {
  try {
    const p = pool || await connectPool();
    if (!p) return [];
    const conds = [], vals = [];
    if (ticker)     { conds.push("ticker = ?");     vals.push(ticker); }
    if (sentimiento){ conds.push("sentimiento = ?"); vals.push(sentimiento); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    // LIMIT no se puede bindear como parámetro en prepared statements de mysql2
    // (→ "Incorrect arguments to mysqld_stmt_execute"). Se inyecta como entero saneado.
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 30, 100));
    const [rows] = await p.execute(
      `SELECT id, titulo, snippet, fuente, ticker, sentimiento, url, imagen_url,
              ts_publicado, ts_guardado
       FROM noticias ${where}
       ORDER BY COALESCE(ts_publicado, ts_guardado) DESC
       LIMIT ${lim}`,
      vals
    );
    return Array.isArray(rows) ? rows : [];
  } catch (e) { warn(`obtenerNoticias error: ${e?.message}`); return []; }
}

/**
 * actualizarNoticiaSentimiento — corrige el sentimiento de una noticia ya guardada.
 * Usado por class45 para reemplazar el sentimiento estimado por keywords (class1)
 * con el análisis real del motor de sentimiento (AFINN + pesos adaptativos).
 */
export async function actualizarNoticiaSentimiento(id, sentimiento) {
  try {
    if (!id || !sentimiento) return false;
    const p = pool || await connectPool();
    if (!p) return false;
    const [res] = await p.execute(
      `UPDATE noticias SET sentimiento = ? WHERE id = ?`,
      [String(sentimiento).slice(0, 20), id]
    );
    return res?.affectedRows > 0;
  } catch (e) { warn(`actualizarNoticiaSentimiento error: ${e?.message}`); return false; }
}