// ============================================================
// class14.js — Identity, Session, OAuth & Decision Gateway v2.1
// ============================================================
//
// CAMBIOS v2.1 respecto a v2.0:
//
//   1. DECISIONES DE USUARIOS → MOTOR VECTORIAL
//      Cada vez que un usuario acepta/ignora/rechaza una señal
//      de class25, class14 publica un mensaje "user_decision"
//      a class18_ingest para que el motor vectorial construya
//      el vector de comportamiento del usuario.
//
//   2. TABLA user_actions (nueva)
//      Registra explícitamente qué hizo el usuario con cada
//      señal: "siguio", "ignoro", "rechazo", "consulto".
//      Diferente a user_decisions (que guarda qué señales VIO).
//
//   3. PERFIL VECTORIZABLE EN CADA CAMBIO
//      registerOAuthUser, activarSuscripcion y updateUserProfile
//      ahora publican también a class18_ingest (además de
//      class14_output) para que el perfil llegue al motor
//      vectorial en cuanto cambia.
//
//   4. ESTADÍSTICAS DE COMPORTAMIENTO
//      getUserStats(): retorna métricas de comportamiento del
//      usuario (cuántas señales siguió, ignoró, su tasa de
//      acierto percibida) para class25B y para el dashboard.
//
// CANALES REDIS:
//   Publica:
//     class14_output   — perfil para class25B (igual que v2.0)
//     class18_ingest   — vectores de usuario para motor vectorial (NUEVO)
//   Escucha:
//     class25_output   — decisiones del sistema para registrar por usuario
//     class14_actions  — acciones explícitas del usuario (NUEVO)
//                        Formato: { user_id, decision_id, accion }
//                        accion: "siguio" | "ignoro" | "rechazo" | "consulto"
//
// EXPORTS:
//   registerOAuthUser, createSession, getUserProfile,
//   updateUserProfile, getSessionUser, verifyToken, generateToken,
//   resolveUser, guardarDecisionUsuario, getDecisionesUsuario,
//   activarSuscripcion, verificarPlan,
//   registrarAccionUsuario, getUserStats  ← NUEVAS
// ============================================================

import fs             from "fs-extra";
import path           from "path";
import crypto         from "crypto";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import jwt             from "jsonwebtoken";
import { getStorageConfig, getLoggingConfig } from "./class38.js";
import {
  query as sqlQuery,
  guardarCausal,
  logEvento,
  guardarUsuario    as sqlGuardarUsuario,
  actualizarPlanUsuario,
} from "./class42.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ─────────────────────────────────────────────────
const REDIS_URL   = process.env.REDIS_URL  || "redis://localhost:6379";
// JWT_SECRET — SIN fallback (30-ago-2026). El default anterior era un string
// público del repositorio: cualquiera podía firmar un token para el user_id o
// el email que quisiera, incluido el de la cuenta maestra. Ver la nota extensa
// en MIIA/miia_chatbot.py. El proceso no arranca sin la variable.
const JWT_SECRET = (process.env.JWT_SECRET || "").trim();
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET no configurado (o menor a 32 caracteres). " +
    "Generar con: openssl rand -hex 32 — y exportarlo antes de arrancar."
  );
}
const JWT_TTL     = process.env.JWT_TTL    || "30d";
const SESSION_TTL = 60 * 60 * 24 * 30;

// Solo Google OAuth — Microsoft y Apple eliminados
// Credenciales SOLO desde config/.env (cargado por class38 vía class42)
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const BASE_DIR        = path.resolve(__dirname, "../operador/aprendizaje");
const LOG_FILE        = path.join(BASE_DIR, "logs", "class14.log");
const CH_OUT_PERFIL   = "class14_output";   // → class25B
const CH_OUT_VECTOR   = "class18_ingest";   // → motor vectorial (NUEVO)
const CH_IN_DECISIONS = "class25_output";   // señales del sistema
const CH_IN_ACTIONS   = "class14_actions";  // acciones explícitas de usuario (NUEVO)

// ── Logger ─────────────────────────────────────────────────
function _log(level, msg, data = {}) {
  const line = `[${new Date().toISOString()}] [class14/${level.toUpperCase()}] ${msg} ${
    Object.keys(data).length ? JSON.stringify(data) : ""
  }`;
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Redis ───────────────────────────────────────────────────
const redisPub = createClient({ url: REDIS_URL });
const redisSub = createClient({ url: REDIS_URL });
const redisKV  = createClient({ url: REDIS_URL });

await Promise.all([
  redisPub.connect().catch(e => _log("warn", "Redis PUB", { err: e.message })),
  redisSub.connect().catch(e => _log("warn", "Redis SUB", { err: e.message })),
  redisKV.connect().catch(e  => _log("warn", "Redis KV",  { err: e.message })),
]);

// ── MySQL helpers ───────────────────────────────────────────
async function dbQuery(sql, params = []) {
  try { return await sqlQuery(sql, params); }
  catch (e) { _log("error", "DB error", { sql: sql.slice(0, 80), err: e.message }); return null; }
}

// ── Inicialización de tablas ─────────────────────────────────
async function initTables() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      user_id          VARCHAR(100) NOT NULL UNIQUE,
      email            VARCHAR(255),
      name             VARCHAR(255),
      avatar           VARCHAR(500),
      plan             VARCHAR(20)  DEFAULT 'free',
      plan_vencimiento DATETIME,
      ts_creacion      DATETIME(3)  DEFAULT NOW(3),
      ts_ultimo_login  DATETIME(3),
      INDEX idx_email (email)
    )
  `);
  // Migración: agregar columna user_id si la tabla existía con esquema viejo
  const colCheck = await dbQuery(`
    SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id'
  `).catch(() => null);
  if (colCheck && colCheck[0]?.cnt === 0) {
    await dbQuery(`ALTER TABLE users ADD COLUMN user_id VARCHAR(100) NOT NULL DEFAULT '' AFTER id`).catch(() => {});
    await dbQuery(`ALTER TABLE users ADD UNIQUE INDEX idx_user_id (user_id)`).catch(() => {});
    _log("info", "Migración: columna user_id agregada a tabla users");
  }
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS oauth_providers (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     VARCHAR(100) NOT NULL,
      provider    VARCHAR(30)  NOT NULL,
      provider_id VARCHAR(255) NOT NULL,
      email       VARCHAR(255),
      ts          DATETIME(3)  DEFAULT NOW(3),
      UNIQUE KEY uq_provider (provider, provider_id),
      INDEX idx_user (user_id)
    )
  `);
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id            VARCHAR(100) PRIMARY KEY,
      nivel_experiencia  VARCHAR(20)  DEFAULT 'intermedio',
      tolerancia_riesgo  VARCHAR(20)  DEFAULT 'moderado',
      nivel_conocimiento VARCHAR(20)  DEFAULT 'principiante',
      capital_disponible VARCHAR(50)  DEFAULT NULL,
      sectores_seguidos  JSON,
      interacciones      INT          DEFAULT 0,
      decisiones_vistas  INT          DEFAULT 0,
      onboarding_ok      TINYINT(1)   DEFAULT 0,
      ultima_interaccion DATETIME(3),
      preferencias       JSON,
      ts_creacion        DATETIME(3)  DEFAULT NOW(3)
    )
  `);
  // Agregar columnas nuevas si ya existe la tabla (migracion)
  // MySQL no soporta ADD COLUMN IF NOT EXISTS → consultar information_schema primero
  for (const [col, def] of [
    ["nivel_conocimiento", "VARCHAR(20) DEFAULT 'principiante'"],
    ["capital_disponible", "VARCHAR(50) DEFAULT NULL"],
    ["onboarding_ok",      "TINYINT(1)  DEFAULT 0"],
  ]) {
    const chk = await dbQuery(`
      SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_profiles' AND COLUMN_NAME = ?
    `, [col]).catch(() => null);
    if (chk && chk[0]?.cnt === 0)
      await dbQuery(`ALTER TABLE user_profiles ADD COLUMN \`${col}\` ${def}`).catch(() => {});
  }
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS user_decisions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     VARCHAR(100) NOT NULL,
      decision_id VARCHAR(100),
      senal       VARCHAR(10),
      ticker      VARCHAR(20),
      confianza   FLOAT,
      texto       TEXT,
      vista       TINYINT(1)  DEFAULT 0,
      ts          DATETIME(3) DEFAULT NOW(3),
      INDEX idx_user (user_id),
      INDEX idx_ts   (ts)
    )
  `);
  // NUEVA: acciones explícitas del usuario sobre señales
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS user_actions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     VARCHAR(100) NOT NULL,
      decision_id VARCHAR(100),
      senal       VARCHAR(10),
      ticker      VARCHAR(20),
      accion      VARCHAR(20)  NOT NULL,
      confianza   FLOAT,
      ts          DATETIME(3) DEFAULT NOW(3),
      INDEX idx_user   (user_id),
      INDEX idx_decid  (decision_id),
      INDEX idx_accion (accion)
    )
  `);
  _log("info", "Tablas MySQL verificadas (v2.1)");
}

await initTables().catch(e => _log("warn", "initTables error", { err: e.message }));

// ============================================================
// PUBLICAR PERFIL → MOTOR VECTORIAL (class18_ingest)
// Llamado en cada evento que cambia el estado del usuario.
// class18.cs lo recibirá como type:"profile_update" o
// type:"user_decision" y construirá un vector de 6 dims.
// ============================================================
async function publicarPerfilVectorial(user_id, tipo = "profile_update", extra = {}) {
  try {
    const perfil = await getUserProfile(user_id);
    if (!perfil) return;

    const msg = {
      id:      crypto.randomUUID(),
      source:  "class14",
      type:    tipo,
      user_id,
      plan:    perfil.plan || "free",
      perfil: {
        nivel_experiencia: perfil.nivel_experiencia || "intermedio",
        tolerancia_riesgo: perfil.tolerancia_riesgo || "moderado",
        interacciones:     perfil.interacciones     || 0,
        decisiones_vistas: perfil.decisiones_vistas || 0,
        sectores_seguidos: perfil.sectores_seguidos || [],
      },
      ...extra,
      ts: new Date().toISOString(),
    };

    if (redisPub.isOpen) {
      await redisPub.publish(CH_OUT_VECTOR, JSON.stringify(msg));
      _log("info", `📤 perfil vectorial → ${CH_OUT_VECTOR}`,
        { user_id, tipo, plan: perfil.plan });
    }
  } catch (e) {
    _log("warn", "publicarPerfilVectorial error", { err: e.message, user_id });
  }
}

// ============================================================
// OAUTH — REGISTRO / LOGIN
// ============================================================
export async function registerOAuthUser({
  provider, provider_id, email = "", name = "", avatar = ""
}) {
  try {
    if (!provider || !provider_id)
      throw new Error("provider y provider_id son requeridos");

    const existing = await dbQuery(
      "SELECT user_id FROM oauth_providers WHERE provider=? AND provider_id=?",
      [provider, provider_id]
    );

    let user_id, is_new = false;

    if (existing && existing.length > 0) {
      // Login existente — actualizar datos y timestamp
      user_id = existing[0].user_id;
      await dbQuery(
        "UPDATE users SET ts_ultimo_login=NOW(3), name=COALESCE(?,name), avatar=COALESCE(?,avatar) WHERE user_id=?",
        [name || null, avatar || null, user_id]
      );
      _log("info", "Login OAuth existente", { provider, user_id });
    } else {
      // Nuevo usuario — usar INSERT IGNORE para manejar duplicados de email
      user_id = "u_" + crypto.createHash("sha1")
        .update(`${provider}:${provider_id}:${Date.now()}`)
        .digest("hex").slice(0, 20);
      is_new = true;

      // INSERT IGNORE: si el email ya existe no falla, simplemente no inserta
      const inserted = await dbQuery(
        `INSERT IGNORE INTO users (user_id, email, name, avatar, ts_creacion, ts_ultimo_login)
         VALUES (?, ?, ?, ?, NOW(3), NOW(3))`,
        [user_id, email || null, name || null, avatar || null]
      );

      // Si no se insertó (email duplicado), recuperar el user_id existente por email
      if (!inserted?.length && email) {
        const byEmail = await dbQuery(
          "SELECT user_id FROM users WHERE email=? LIMIT 1",
          [email]
        );
        if (byEmail?.length) {
          user_id = byEmail[0].user_id;
          is_new  = false;
          await dbQuery(
            "UPDATE users SET ts_ultimo_login=NOW(3), name=COALESCE(?,name), avatar=COALESCE(?,avatar) WHERE user_id=?",
            [name || null, avatar || null, user_id]
          );
          _log("info", "Login OAuth — email ya existía, recuperado", { provider, user_id, email });
        }
      }

      // oauth_providers: INSERT IGNORE también
      await dbQuery(
        `INSERT IGNORE INTO oauth_providers (user_id, provider, provider_id, email)
         VALUES (?, ?, ?, ?)`,
        [user_id, provider, provider_id, email || null]
      );

      // user_profiles: INSERT IGNORE
      await dbQuery(
        `INSERT IGNORE INTO user_profiles (user_id, sectores_seguidos, preferencias, ts_creacion)
         VALUES (?, ?, ?, NOW(3))`,
        [user_id, JSON.stringify([]), JSON.stringify({})]
      );

      if (is_new) {
        _log("info", "Usuario OAuth creado", { provider, user_id, email });
        await sqlGuardarUsuario({ user_id, email, name, avatar, provider, provider_id, plan: "free" })
              .catch(e => _log("warn", "sqlGuardarUsuario error", { err: e?.message }));
      }
    }

    const token = jwt.sign({ user_id, email, name, provider }, JWT_SECRET, { expiresIn: JWT_TTL });
    const session_id = "s_" + uuidv4().replace(/-/g, "").slice(0, 20);

    await redisKV.set(
      `class14:session:${session_id}`,
      JSON.stringify({ user_id, email, name, provider, token }),
      { EX: SESSION_TTL }
    ).catch(() => {});

    // → class25B (igual que v2.0)
    const perfil = await getUserProfile(user_id);
    await redisPub.publish(CH_OUT_PERFIL, JSON.stringify({
      type: "profile_update", user_id, session_id, email, name, provider,
      plan: perfil?.plan || "free", perfil, ts: new Date().toISOString()
    })).catch(() => {});

    // → class18_ingest (NUEVO v2.1)
    await publicarPerfilVectorial(user_id, "profile_update",
      { session_id, provider, is_new });

    return { user_id, session_id, token, is_new, email, name };
  } catch (e) {
    _log("error", "registerOAuthUser error", { err: e.message, provider });
    throw e;
  }
}

// ============================================================
// PERFIL DE USUARIO
// ============================================================
export async function getUserProfile(user_id) {
  try {
    const rows = await dbQuery(
      `SELECT u.user_id, u.email, u.name, u.avatar, u.plan, u.plan_vencimiento,
              p.nivel_experiencia, p.tolerancia_riesgo, p.nivel_conocimiento,
              p.capital_disponible, p.onboarding_ok,
              p.sectores_seguidos, p.interacciones, p.decisiones_vistas,
              p.ultima_interaccion, p.preferencias
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.user_id
       WHERE u.user_id = ?`,
      [user_id]
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    if (!r || typeof r !== "object") return null;   // guard contra undefined en rows[0]
    const _parseJSON = (v, fallback) => {
      if (!v) return fallback;
      if (typeof v === "object") return v;
      try { return JSON.parse(v); } catch { return fallback; }
    };
    return {
      ...r,
      sectores_seguidos: _parseJSON(r.sectores_seguidos, []),
      preferencias:      _parseJSON(r.preferencias,      {}),
    };
  } catch (e) {
    _log("warn", "getUserProfile error", { err: e.message, user_id });
    return null;
  }
}

export async function updateUserProfile(user_id, campos = {}) {
  try {
    const sets = [], vals = [];
    if (campos.nivel_experiencia)  { sets.push("nivel_experiencia=?");  vals.push(campos.nivel_experiencia); }
    if (campos.tolerancia_riesgo)  { sets.push("tolerancia_riesgo=?");  vals.push(campos.tolerancia_riesgo); }
    if (campos.nivel_conocimiento) { sets.push("nivel_conocimiento=?"); vals.push(campos.nivel_conocimiento); }
    if (campos.capital_disponible) { sets.push("capital_disponible=?"); vals.push(String(campos.capital_disponible)); }
    if (campos.onboarding_ok != null) { sets.push("onboarding_ok=?"); vals.push(campos.onboarding_ok ? 1 : 0); }
    if (campos.sectores_seguidos)  { sets.push("sectores_seguidos=?");  vals.push(JSON.stringify(campos.sectores_seguidos)); }
    if (campos.preferencias)       { sets.push("preferencias=?");       vals.push(JSON.stringify(campos.preferencias)); }
    sets.push("interacciones = interacciones + 1", "ultima_interaccion = NOW(3)");
    vals.push(user_id);

    await dbQuery(`UPDATE user_profiles SET ${sets.join(", ")} WHERE user_id=?`, vals);
    _log("info", "Perfil actualizado", { user_id });

    // → motor vectorial: refleja el cambio de perfil inmediatamente
    await publicarPerfilVectorial(user_id, "profile_update", { campos_actualizados: Object.keys(campos) });
    // → class25B: actualizar perfil para respuestas personalizadas
    await redisPub.publish("class14_output", JSON.stringify({
      type: "profile_update", user_id,
      perfil: { ...campos, ts: new Date().toISOString() }
    })).catch(() => {});
  } catch (e) {
    _log("warn", "updateUserProfile error", { err: e.message, user_id });
  }
}

// ============================================================
// ESTADÍSTICAS DE COMPORTAMIENTO (NUEVA v2.1)
// Retorna métricas de comportamiento del usuario para class25B
// y para el dashboard de admin.
// ============================================================
export async function getUserStats(user_id) {
  try {
    const rows = await dbQuery(
      `SELECT
         accion,
         COUNT(*) as total
       FROM user_actions
       WHERE user_id = ?
       GROUP BY accion`,
      [user_id]
    );

    const stats = { siguio: 0, ignoro: 0, rechazo: 0, consulto: 0, total: 0 };
    for (const r of (rows || [])) {
      stats[r.accion] = Number(r.total) || 0;
      stats.total += stats[r.accion];
    }

    // Tasa de adhesión: de las señales que vio, qué porcentaje siguió
    stats.tasa_adhesion = stats.total > 0
      ? parseFloat((stats.siguio / stats.total).toFixed(4))
      : null;

    // Últimas 5 acciones
    const recientes = await dbQuery(
      `SELECT decision_id, senal, ticker, accion, ts
       FROM user_actions WHERE user_id=?
       ORDER BY ts DESC LIMIT 5`,
      [user_id]
    ) || [];

    return { user_id, ...stats, recientes };
  } catch (e) {
    _log("warn", "getUserStats error", { err: e.message, user_id });
    return { user_id, total: 0, tasa_adhesion: null, recientes: [] };
  }
}

// ============================================================
// REGISTRAR ACCIÓN EXPLÍCITA DEL USUARIO (NUEVA v2.1)
// Llamada desde class30 cuando el usuario interactúa con una
// señal en la UI (botón "Seguir señal" / "Ignorar").
// También escucha el canal class14_actions para acciones
// enviadas desde la UI (class30).
// ============================================================
export async function registrarAccionUsuario({
  user_id, decision_id, senal, ticker, accion, confianza = null
}) {
  try {
    if (!user_id || !accion) return;
    const accionValida = ["siguio", "ignoro", "rechazo", "consulto"];
    if (!accionValida.includes(accion)) {
      _log("warn", "Acción inválida", { accion, user_id });
      return;
    }

    // Guardar en MySQL
    await dbQuery(
      `INSERT INTO user_actions (user_id, decision_id, senal, ticker, accion, confianza)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id, decision_id || null, senal || null,
       ticker || null, accion, confianza != null ? Number(confianza) : null]
    );

    // Actualizar perfil: incrementar interacciones
    await dbQuery(
      `UPDATE user_profiles SET interacciones = interacciones + 1,
       ultima_interaccion = NOW(3) WHERE user_id=?`,
      [user_id]
    );

    _log("info", `📋 Acción registrada: ${accion}`,
      { user_id, decision_id, senal, ticker });

    // → class18_ingest: vector de usuario con la acción recién tomada
    await publicarPerfilVectorial(user_id, "user_decision", {
      decision_id,
      senal,
      ticker,
      accion_usuario: accion,    // class18.cs lee este campo para dim 4
      confianza_senal: confianza,
    });

  } catch (e) {
    _log("warn", "registrarAccionUsuario error", { err: e.message, user_id });
  }
}

// ============================================================
// SESIÓN / JWT
// ============================================================
export async function createSession(user_id, metadata = {}) {
  const session_id = "s_" + uuidv4().replace(/-/g, "").slice(0, 20);
  await redisKV.set(
    `class14:session:${session_id}`,
    JSON.stringify({ user_id, ...metadata }),
    { EX: SESSION_TTL }
  ).catch(() => {});
  return session_id;
}

export async function getSessionUser(session_id) {
  try {
    const raw = await redisKV.get(`class14:session:${session_id}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_TTL });
}

// ============================================================
// DECISIONES POR USUARIO (ver qué señales recibió)
// ============================================================
export async function guardarDecisionUsuario({ user_id, decision }) {
  try {
    await dbQuery(
      `INSERT INTO user_decisions (user_id, decision_id, senal, ticker, confianza, texto)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user_id, decision.id, decision.senal, decision.ticker,
       decision.confianza, (decision.texto || "").slice(0, 2000)]
    );
    await dbQuery(
      `UPDATE user_profiles SET decisiones_vistas = decisiones_vistas + 1,
       ultima_interaccion = NOW(3) WHERE user_id=?`,
      [user_id]
    );
  } catch (e) {
    _log("warn", "guardarDecisionUsuario error", { err: e.message, user_id });
  }
}

export async function getDecisionesUsuario(user_id, limit = 50) {
  try {
    return await dbQuery(
      `SELECT * FROM user_decisions WHERE user_id=? ORDER BY ts DESC LIMIT ?`,
      [user_id, limit]
    ) || [];
  } catch { return []; }
}

// ============================================================
// RESOLUCIÓN DE USUARIO (backward compat)
// ============================================================
export async function resolveUser(source, external_id) {
  if (!external_id) return `u_anon_${Date.now()}`;
  try {
    const rows = await dbQuery(
      "SELECT user_id FROM oauth_providers WHERE provider=? AND provider_id=?",
      [source, String(external_id)]
    );
    let user_id;
    if (rows && rows.length > 0) {
      user_id = rows[0].user_id;
    } else {
      user_id = "u_" + crypto.createHash("sha1")
        .update(`${source}:${external_id}`).digest("hex").slice(0, 20);
      await dbQuery(`INSERT IGNORE INTO users (user_id, ts_creacion) VALUES (?, NOW(3))`, [user_id]);
      await dbQuery(`INSERT IGNORE INTO oauth_providers (user_id, provider, provider_id) VALUES (?, ?, ?)`,
        [user_id, source, String(external_id)]);
      await dbQuery(`INSERT IGNORE INTO user_profiles (user_id, ts_creacion) VALUES (?, NOW(3))`, [user_id]);
    }
    // Publicar a class14_resolved
    const session_id = await createSession(user_id);
    await redisPub.publish("class14_resolved", JSON.stringify({
      external_id: String(external_id),
      user_id,
      session_id,
      source,
      ts: new Date().toISOString(),
    })).catch(() => {});
    return user_id;
  } catch (e) {
    _log("warn", "resolveUser error", { err: e.message });
    return `u_fallback_${Date.now()}`;
  }
}

// Normaliza un evento de entrada (valida campos requeridos)
export function normalizeEvent(event) {
  const required = ["source", "external_id", "user_id", "session_id", "text", "ts"];
  const normalized = {
    source:      event.source      || "unknown",
    external_id: String(event.external_id || ""),
    user_id:     event.user_id     || "",
    session_id:  event.session_id  || "",
    text:        String(event.text || event.texto || ""),
    metadata:    event.metadata    || {},
    ts:          event.ts          || new Date().toISOString(),
  };
  for (const k of required) {
    if (!normalized[k]) throw new Error(`Campo requerido faltante: ${k}`);
  }
  return normalized;
}

// Publica un evento normalizado a class25_ingest
export async function publishEvent(event) {
  const payload = {
    ...event,
    type:   "human_query",
    texto:  event.text,
    source: event.source,
    id:     crypto.createHash("sha1")
      .update(`${event.session_id}:${event.ts}`).digest("hex").slice(0, 16),
  };
  await redisPub.publish("class25_ingest", JSON.stringify(payload));
  _log("info", "publishEvent → class25_ingest",
    { session_id: event.session_id, source: event.source });
}

// ============================================================
// PLAN / SUSCRIPCIÓN
// ============================================================
export async function activarSuscripcion({ user_id, plan, dias = 30, mp_payment_id = null }) {
  try {
    const vencimiento = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
    await dbQuery(
      `UPDATE users SET plan=?, plan_vencimiento=? WHERE user_id=?`,
      [plan, vencimiento, user_id]
    );
    _log("info", "Suscripción activada", { user_id, plan, dias, mp_payment_id });

    await actualizarPlanUsuario({ user_id, plan, dias, mp_payment_id })
          .catch(e => _log("warn", "actualizarPlanUsuario error", { err: e?.message }));

    const perfil = await getUserProfile(user_id);

    // → class25B
    await redisPub.publish(CH_OUT_PERFIL, JSON.stringify({
      type: "subscription_activated", user_id, plan,
      vencimiento: vencimiento.toISOString(), perfil, ts: new Date().toISOString()
    })).catch(() => {});

    // → class18_ingest: el plan cambió, actualizar vector de usuario
    await publicarPerfilVectorial(user_id, "subscription_activated", { plan, mp_payment_id });

    return true;
  } catch (e) {
    _log("error", "activarSuscripcion error", { err: e.message, user_id });
    return false;
  }
}

export async function verificarPlan(user_id) {
  try {
    const rows = await dbQuery(
      "SELECT plan, plan_vencimiento FROM users WHERE user_id=?",
      [user_id]
    );
    if (!rows || rows.length === 0) return { plan: "free", activo: false };
    const { plan, plan_vencimiento } = rows[0];
    const activo = plan !== "free" &&
      (!plan_vencimiento || new Date(plan_vencimiento) > new Date());
    return { plan, activo, vencimiento: plan_vencimiento };
  } catch { return { plan: "free", activo: false }; }
}

// ============================================================
// LISTENERS REDIS
// ============================================================

// 1. class25_output → guardar decisión + rutear a class14_ui:{session_id}
await redisSub.subscribe(CH_IN_DECISIONS, async (raw) => {
  try {
    const decision = JSON.parse(raw);
    if (!decision) return;

    // Rutear respuesta al canal de sesión específica
    if (decision.session_id) {
      await redisPub.publish(`class14_ui:${decision.session_id}`, raw).catch(() => {});
    }

    if (!decision.senal) return;
    const keys = await redisKV.keys("class14:session:*").catch(() => []);
    for (const key of keys.slice(0, 100)) {
      const sesData = await redisKV.get(key).catch(() => null);
      if (!sesData) continue;
      const ses = JSON.parse(sesData);
      if (ses?.user_id) {
        await guardarDecisionUsuario({ user_id: ses.user_id, decision });
      }
    }
  } catch (_) {}
}).catch(e => _log("warn", "Subscribe decisions error", { err: e.message }));

// 2. class14_actions → acciones explícitas del usuario (desde UI)
//    Formato esperado: { user_id, decision_id, senal, ticker, accion, confianza? }
//    Fuente: class30 (UI)
await redisSub.subscribe(CH_IN_ACTIONS, async (raw) => {
  try {
    const msg = JSON.parse(raw);
    if (!msg?.user_id || !msg?.accion) return;
    _log("info", `📥 Acción via ${CH_IN_ACTIONS}`,
      { user_id: msg.user_id, accion: msg.accion });
    await registrarAccionUsuario(msg);
  } catch (e) {
    _log("warn", "Subscribe actions error", { err: e.message });
  }
}).catch(e => _log("warn", "Subscribe class14_actions error", { err: e.message }));

_log("info", "✅ class14 v2.1 Identity & Decision Gateway iniciado");
_log("info", `📡 Escucha: ${CH_IN_DECISIONS} | ${CH_IN_ACTIONS}`);
_log("info", `📤 Publica: ${CH_OUT_PERFIL} | ${CH_OUT_VECTOR}`);
_log("info", `OAuth: ${GOOGLE_CLIENT_ID ? "Google ✓" : "Google — CLIENT_ID no configurado"}`);

// ── Exports ─────────────────────────────────────────────────
export default {
  registerOAuthUser,
  getUserProfile,
  updateUserProfile,
  createSession,
  getSessionUser,
  verifyToken,
  generateToken,
  resolveUser,
  normalizeEvent,
  publishEvent,
  guardarDecisionUsuario,
  getDecisionesUsuario,
  registrarAccionUsuario,
  getUserStats,
  activarSuscripcion,
  verificarPlan,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
};