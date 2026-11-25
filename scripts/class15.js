// ============================================================
// class15.js — Motor de Portafolios (MIIA v2.0)
// Cambios vs versión anterior:
//   1. Usa ETF reales (XLK, XLF...) en lugar de proxies ficticios (TECH_P)
//   2. Scoring con precio, open, change_pct de la nueva class7
//   3. Pasa riesgoGlobal al payload del portfolio → class17
//   4. Genera portfolio aunque no haya usuarios.json (modo general)
//   5. Un solo cliente Redis (era 3)
// ============================================================

import path     from "path";
import fs       from "fs-extra";
import os       from "os";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import chalk    from "chalk";
import crypto   from "crypto";
import { getStorageConfig, getLoggingConfig } from "./class38.js";
import { guardarPortfolio, logEvento } from "./class42.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir     = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR    = path.join(baseDir, "logs");
const JSON_DIR    = path.join(baseDir, "json_guardados");
const METRICS_DIR = path.join(baseDir, "metrics");
const CONFIG_DIR  = path.join(baseDir, "config");
const usuariosPath = path.join(baseDir, "usuarios.json");
const profilesPath = path.join(baseDir, "usuarios", "profiles.json");

for (const d of [LOGS_DIR, JSON_DIR, METRICS_DIR, CONFIG_DIR,
                  path.dirname(profilesPath)])
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}

const LOG_FILE = path.join(LOGS_DIR, "class15.log");

// ── Logger ─────────────────────────────────────────────────
function log(msg, nivel = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class15/${nivel.toUpperCase()}] ${msg}`;
  const color = nivel === "error" ? chalk.red : nivel === "warn" ? chalk.yellow : chalk.green;
  try { console.log(color(line)); } catch { console.log(line); }
  try { fs.appendFileSync(LOG_FILE, line + os.EOL, "utf8"); } catch (_) {}
}

// ── Config ─────────────────────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
export function getPath(k, d = "./") { try { const v = storageCfg[k]; return typeof v === "string" && v.trim() ? v : d; } catch { return d; } }
export function getLogLevel(d = "info") { try { return getLoggingConfig()?.level || d; } catch { return d; } }
export function shouldRotateLogs() { try { return getLoggingConfig()?.rotate_logs === true; } catch { return false; } }

// ── Redis ──────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CH_IN     = "class15_ingest";    // recibe de class7
const CH_OUT    = "class17_ingest";    // envía a class17
const CH_vectores = "class18_ingest"; // publica de vectores 

let redisPub = null;
let redisSub = null;

// ── Estado de mercado ──────────────────────────────────────
let estadoMercado = null;  // último payload de class7

// ── Helpers numéricos ──────────────────────────────────────
function safe(v, fallback = 0.5) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

// ── Leer perfil de usuario ─────────────────────────────────
async function leerPerfil(userId) {
  try {
    if (!userId) return null;
    if (!(await fs.pathExists(profilesPath))) return null;
    const profiles = await fs.readJson(profilesPath);
    return profiles?.[userId] ?? null;
  } catch (_) { return null; }
}

// ── Scoring con datos reales de class7 ────────────────────
// Antes: score=0.5 para todos (datos ficticios)
// Ahora: score basado en precio, change_pct, state de class7
function calcularScore(sector) {
  // change normalizado: change en % → 0-1
  const changePct   = Number(sector.change ?? 0);
  const changeNorm  = Math.max(0, Math.min(1, (changePct + 5) / 10)); // -5% → 0, +5% → 1

  // estado del sector
  const stateScore  = sector.state === "up" ? 0.7
                    : sector.state === "down" ? 0.3 : 0.5;

  // confianza: si tenemos precio real > sin precio
  const tienePrecio = sector.precio != null ? 0.8 : 0.5;

  return +(changeNorm * 0.5 + stateScore * 0.3 + tienePrecio * 0.2).toFixed(4);
}

function calcularRiesgo(sector, riesgoGlobal = 0.5) {
  // sectores a la baja tienen más riesgo
  const sectorRisk = sector.state === "down" ? 0.7
                   : sector.state === "up"   ? 0.3 : 0.5;
  return +(riesgoGlobal * 0.5 + sectorRisk * 0.5).toFixed(4);
}

// ============================================================
// CREAR PORTAFOLIO desde datos sectoriales de class7
// Usa los ETF reales (XLK, XLF...) como activos candidatos
// ============================================================
async function crearPortafolio(userId = "general", sessionId = null, opciones = {}) {
  if (!estadoMercado?.sectors?.length) {
    throw new Error("Sin datos de mercado — esperando class7");
  }

  const sectores      = estadoMercado.sectors;
  const riesgoGlobal  = estadoMercado.riesgoGlobal ?? 0.5;
  const profile       = userId !== "general" ? await leerPerfil(userId) : null;

  // ── Cuántos activos entran (26-sep-2026) ────────────────────────────────
  //
  // Era 8 fijo. Con 13 instrumentos eso es elegir 8 de 13: se dejan 5 afuera y
  // la cartera se parece bastante a tener todo. Con el universo en 50, 8 de 50
  // es una apuesta MUCHO más concentrada, y eso rompe dos cosas a la vez:
  //
  //   1. **El control negativo del experimento.** La sección 6.1 de las notas internas
  //      congeló «portafolio vs canasta, 20 sesiones = −0,380 pp» como control
  //      NEGATIVO: «class15 sigue igual, si se mueve sin que lo toquemos, algo
  //      más cambió». Con 8 de 50 se mueve solo — y no por class15.
  //   2. **La potencia de la medición.** El alfa mínimo detectable ya es 20,7 %
  //      anual con 44 ruedas; concentrar más sube la volatilidad y por lo tanto
  //      ese mínimo. El portafolio pasaría a medir menos, no más.
  //
  // Así que la fracción se mantiene, no el número: 8 de 13 son el 62 %, y con
  // 50 eso da 31. Es lo único que deja la comparación con el brazo de control
  // en pie — y ojo: **el control igual se corta**, porque la canasta contra la
  // que se compara también pasó de 13 a 50 instrumentos. Lo que se conserva es
  // el GRADO de concentración, no la comparabilidad.
  //
  // `CLASS15_MAX_ACTIVOS` lo fija a mano sin tocar código, y `CLASS15_FRACCION`
  // cambia la fracción. Con `maxActivos` en las opciones, manda la opción.
  const FRACCION_DEFECTO = Number(process.env.CLASS15_FRACCION || (8 / 13));
  const nCandidatos = sectores.filter(s => s.etf).length;
  const maxPorFraccion = Math.max(4, Math.round(nCandidatos * FRACCION_DEFECTO));

  let estrategia     = opciones.strategy ?? "balanced";
  // Los paréntesis no son estilo: mezclar `??` con `||` sin ellos es un
  // SyntaxError en JS, y el módulo no arranca.
  let maxActivos     = opciones.maxActivos
                    ?? (Number(process.env.CLASS15_MAX_ACTIVOS) || maxPorFraccion);
  // El límite por sector escala igual: con 50 instrumentos hay ~50 sectores
  // distintos, así que 2 por sector ya no acota nada — pero se deja, porque con
  // pocos candidatos (mercado cerrado, proveedor caído) sigue siendo la guarda
  // que evita una cartera de 8 tecnológicas.
  let porSectorLimit = 2;
  if (!opciones.maxActivos && !process.env.CLASS15_MAX_ACTIVOS && nCandidatos > 20)
    console.log(`[class15] 📐 ${nCandidatos} candidatos → maxActivos=${maxActivos} ` +
                `(${(FRACCION_DEFECTO * 100).toFixed(0)} % del universo, la misma ` +
                `fracción que 8 de 13). El control negativo de la sección 6.1 de ` +
                `las notas internas NO es comparable con esto: la canasta también cambió.`);

  if (profile?.preferences) {
    const p = profile.preferences.profundidad || profile.preferences.risk_tolerance || "";
    if (p === "baja" || p.includes("low"))  { estrategia = "conservative"; porSectorLimit = 1; }
    if (p === "alta" || p.includes("high")) { estrategia = "aggressive";   porSectorLimit = 3; }
  }

  // Candidatos con ETF reales y scoring de datos reales
  const candidatos = sectores
    .filter(s => s.etf)   // solo sectores con ETF real
    .map(s => ({
      symbol:     s.etf,             // ← ETF real (XLK, XLF...) en lugar de TECH_P
      sector:     s.sector,
      score:      calcularScore(s),
      riesgo:     calcularRiesgo(s, riesgoGlobal),
      confianza:  safe(s.change != null ? 0.7 : 0.5),
      precio:     s.precio ?? null,
      open:       s.open   ?? null,
      change_pct: s.change ?? 0,
      state:      s.state  ?? "neutral",
    }))
    .sort((a, b) => b.score - a.score || a.riesgo - b.riesgo);

  // Seleccionar activos respetando límite por sector
  const seleccionados = [];
  const porSector     = {};

  for (const c of candidatos) {
    if (seleccionados.length >= maxActivos) break;
    const cnt = porSector[c.sector] ?? 0;
    if (cnt < porSectorLimit) {
      seleccionados.push(c);
      porSector[c.sector] = cnt + 1;
    }
  }

  // Diversificación
  const nSectores      = Object.keys(porSector).length;
  const diversificacion = seleccionados.length
    ? Math.min(1, nSectores / Math.max(1, seleccionados.length))
    : 0;

  const details = seleccionados.map(c => ({
    symbol:         c.symbol,
    sector:         c.sector,
    score:          +(c.score * diversificacion).toFixed(4),
    momentum:       c.score,
    riesgo:         c.riesgo,
    confianza:      c.confianza,
    diversificacion,
    precio_entrada: c.precio,
    change_pct:     c.change_pct,
    estado_sector:  c.state,
    peso:           +(1 / Math.max(1, seleccionados.length)).toFixed(4),
    explicacion:    [
      c.state === "up"   ? "Sector al alza"    : null,
      c.state === "down" ? "Sector a la baja"  : null,
      c.riesgo < 0.35    ? "Riesgo bajo"        : null,
      c.score  > 0.65    ? "Momentum positivo"  : null,
    ].filter(Boolean).join("; ") || "Sector neutral"
  }));

  const confianza = details.length
    ? +(details.reduce((s, d) => s + d.score, 0) / details.length).toFixed(3)
    : 0;

  // Portfolio ID determinístico
  const seed = JSON.stringify({
    userId, sessionId,
    ts: estadoMercado.ts,
    symbols: seleccionados.map(c => c.symbol).sort()
  });
  const portfolioId = "p_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 20);

  const portafolio = {
    source:       "class15",
    type:         "portfolio_generated",
    user_id:      userId,
    session_id:   sessionId ?? null,
    portfolio_id: portfolioId,
    strategy:     estrategia,
    assets:       seleccionados.map(c => c.symbol),
    details,
    confianza,
    confidence:   confianza,
    riesgoGlobal,     // ← nuevo: class17 lo usa para lifecycle
    portafolio:   details, // compat alias
    generated_at: new Date().toISOString(),
    market_ts:    estadoMercado.ts,
    provider:     estadoMercado.provider ?? "unknown"
  };

  log(`📊 Portfolio generado: ${portfolioId} | ${seleccionados.length} activos | riesgo=${riesgoGlobal}`);

  // Persistir en MySQL también desde class15 como backup
  // class17 hace el guardado principal con la evaluación de lifecycle;
  // este es un pre-guardado sin evaluación para no perder datos si class17 falla
  guardarPortfolio({
    portfolio_id:  portfolioId,
    user_id:       userId      ?? "general",
    strategy:      estrategia  ?? "balanced",
    status:        "pending",   // class17 lo actualizará con el lifecycle real
    confidence:    confianza,
    risk_level:    riesgoGlobal,
    riesgo_global: riesgoGlobal,
    n_activos:     seleccionados.length,
    assets:        seleccionados.map(c => c.symbol),
    details,
    market_ts:     estadoMercado.ts ?? null,
    provider:      estadoMercado.provider ?? "unknown",
  }).catch(e => log(`⚠️ guardarPortfolio (pre-save): ${e?.message}`, "warn"));

  return portafolio;
}

// ============================================================
// PORTFOLIO ON-DEMAND ANCLADO EN UN ACTIVO (pedido desde el chat)
// El chatbot publica en class15_request:
//   { ticker: "YPF", nombre: "YPF", user_id, quote: {precio, change_pct} }
// Se arma un portfolio con el activo pedido como ancla (30% del peso) y
// se completa con los mejores ETF sectoriales del último estado de mercado.
// Responde por class15_response (el chatbot lo adjunta a la respuesta HTTP)
// y publica a class17_ingest para el lifecycle/persistencia normal.
// ============================================================
const CH_REQUEST  = "class15_request";
const CH_RESPONSE = "class15_response";
const PESO_ANCLA  = 0.30;

async function crearPortafolioAnclado(req) {
  const ticker = String(req.ticker || "").toUpperCase();
  if (!ticker) throw new Error("class15_request sin ticker");
  if (!estadoMercado?.sectors?.length)
    throw new Error("Sin datos de mercado — esperando class7");

  const riesgoGlobal = estadoMercado.riesgoGlobal ?? 0.5;
  const quote        = req.quote || {};
  const changeAncla  = Number(quote.change_pct ?? 0);

  // Activo ancla: los datos reales que consiguió class7; sin datos → neutro
  const ancla = {
    symbol:         ticker,
    sector:         req.sector || req.nombre || "Solicitado en chat",
    score:          0.6,                       // ancla elegida por el usuario
    momentum:       0.6,
    riesgo:         +(riesgoGlobal * 0.5 + (changeAncla < 0 ? 0.35 : 0.25)).toFixed(4),
    confianza:      quote.precio != null ? 0.7 : 0.4,
    diversificacion: 0,
    precio_entrada: quote.precio ?? null,
    change_pct:     changeAncla,
    estado_sector:  changeAncla > 0.15 ? "up" : changeAncla < -0.15 ? "down" : "neutral",
    peso:           PESO_ANCLA,
    explicacion:    `Activo solicitado por el usuario en el chat`,
  };

  // Complemento: mejores ETF sectoriales (excluyendo el ancla si coincide)
  const candidatos = estadoMercado.sectors
    .filter(s => s.etf && s.etf !== ticker)
    .map(s => ({
      symbol: s.etf, sector: s.sector,
      score: calcularScore(s), riesgo: calcularRiesgo(s, riesgoGlobal),
      confianza: safe(s.change != null ? 0.7 : 0.5),
      precio: s.precio ?? null, change_pct: s.change ?? 0,
      state: s.state ?? "neutral",
    }))
    .sort((a, b) => b.score - a.score || a.riesgo - b.riesgo)
    .slice(0, 5);

  const pesoResto = candidatos.length ? +((1 - PESO_ANCLA) / candidatos.length).toFixed(4) : 0;
  const detalleResto = candidatos.map(c => ({
    symbol: c.symbol, sector: c.sector,
    score: c.score, momentum: c.score, riesgo: c.riesgo, confianza: c.confianza,
    diversificacion: 0,
    precio_entrada: c.precio, change_pct: c.change_pct, estado_sector: c.state,
    peso: pesoResto,
    explicacion: `Diversificación sectorial junto a ${ticker}`,
  }));

  const details   = [ancla, ...detalleResto];
  const nSectores = new Set(details.map(d => d.sector)).size;
  const divers    = Math.min(1, nSectores / Math.max(1, details.length));
  details.forEach(d => { d.diversificacion = divers; });

  const confianza = +(details.reduce((s, d) => s + (d.score ?? 0.5), 0) / details.length).toFixed(3);
  const estrategia = `enfocado_${ticker}`;
  const portfolioId = "p_" + crypto.createHash("sha1")
    .update(JSON.stringify({ ticker, u: req.user_id, ts: Date.now() }))
    .digest("hex").slice(0, 20);

  const portafolio = {
    source: "class15", type: "portfolio_generated",
    user_id: req.user_id || "chat",
    session_id: req.session_id ?? null,
    portfolio_id: portfolioId,
    strategy: estrategia,
    ticker_ancla: ticker,
    assets: details.map(d => d.symbol),
    details, portafolio: details,
    confianza, confidence: confianza,
    riesgoGlobal,
    generated_at: new Date().toISOString(),
    market_ts: estadoMercado.ts,
    provider: estadoMercado.provider ?? "unknown",
  };

  guardarPortfolio({
    portfolio_id: portfolioId, user_id: req.user_id || "chat",
    strategy: estrategia, status: "pending",
    confidence: confianza, risk_level: riesgoGlobal, riesgo_global: riesgoGlobal,
    n_activos: details.length, assets: portafolio.assets, details,
    market_ts: estadoMercado.ts ?? null, provider: estadoMercado.provider ?? "unknown",
  }).catch(e => log(`⚠️ guardarPortfolio (anclado): ${e?.message}`, "warn"));

  return portafolio;
}

async function procesarRequest(raw) {
  try {
    const req = JSON.parse(raw);
    const p   = await crearPortafolioAnclado(req);
    log(`🎯 Portfolio anclado en ${p.ticker_ancla}: ${p.assets.join(", ")}`);

    if (redisPub?.isOpen) {
      // Respuesta directa al chatbot (adjunta al HTTP de /api/ask)
      await redisPub.publish(CH_RESPONSE, JSON.stringify({
        request_id: req.request_id ?? null,
        ticker:     p.ticker_ancla,
        portfolio:  p,
        ts:         new Date().toISOString(),
      }));
      // Flujo normal: lifecycle (class17) + vectorización
      await redisPub.publish(CH_OUT, JSON.stringify(p));
      await redisPub.publish(CH_vectores, JSON.stringify(p));
    }
  } catch (e) {
    log(`⚠️ procesarRequest: ${e.message}`, "warn");
    // Avisar el fallo al chatbot para que no espere el timeout completo
    try {
      const req = JSON.parse(raw);
      if (redisPub?.isOpen) await redisPub.publish(CH_RESPONSE, JSON.stringify({
        request_id: req.request_id ?? null, error: e.message, ts: new Date().toISOString(),
      }));
    } catch (_) {}
  }
}

// ── Procesar mensaje de class7 ─────────────────────────────
async function procesarEstadoMercado(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.sectors)) return;
    if (data.source === "class15") return; // anti-loop

    estadoMercado = {
      ts:           data.ts || new Date().toISOString(),
      source:       data.source || "class7",
      provider:     data.provider || "unknown",
      riesgoGlobal: data.riesgoGlobal ?? 0.5,
      sectors:      data.sectors
    };

    log(`📥 Mercado actualizado: ${data.sectors.length} sectores riesgo=${estadoMercado.riesgoGlobal}`);

    // Publicar portfolio
    try {
      const portafolio = await crearPortafolio("general", null);
      if (redisPub?.isOpen) {
        // → class17_ingest: lifecycle adapter enriquece y reenvía a class18
        await redisPub.publish(CH_OUT, JSON.stringify(portafolio));
        log(`📤 Portfolio → ${CH_OUT} (${portafolio.assets.length} activos)`);

        // → class18_ingest directamente: vectorización inmediata sin esperar class17
        // (CH_vectores era dead code — ahora se usa para redundancia en la vectorización)
        await redisPub.publish(CH_vectores, JSON.stringify(portafolio));
        log(`📤 Portfolio → ${CH_vectores} (vectorización directa)`);
      }
    } catch (e) {
      log(`⚠️ Error generando portfolio: ${e.message}`, "warn");
    }

    // Si hay usuarios registrados, generar portfolio por usuario
    try {
      if (await fs.pathExists(usuariosPath)) {
        const raw    = await fs.readJson(usuariosPath);
        const users  = Array.isArray(raw?.usuarios) ? raw.usuarios : (Array.isArray(raw) ? raw : []);
        for (const u of users) {
          const uid = u.user_id || u.user || u.nombre;
          if (!uid) continue;
          try {
            const p = await crearPortafolio(uid, u.session_id ?? null);
            if (redisPub?.isOpen) await redisPub.publish(CH_OUT, JSON.stringify(p));
          } catch (e) {
            log(`⚠️ Portfolio para ${uid}: ${e.message}`, "warn");
          }
        }
      }
    } catch (_) {}

  } catch (e) {
    log(`❌ procesarEstadoMercado: ${e.message}`, "error");
  }
}

// ── Boot ───────────────────────────────────────────────────
let _iniciado = false;

export async function start() {
  if (_iniciado) return;
  _iniciado = true;

  try {
    redisPub = createClient({ url: REDIS_URL });
    redisSub = createClient({ url: REDIS_URL });

    redisPub.on("error", e => log(`Redis PUB: ${e.message}`, "warn"));
    redisSub.on("error", e => log(`Redis SUB: ${e.message}`, "warn"));

    await Promise.all([redisPub.connect(), redisSub.connect()]);
    log(`✅ Redis conectado | ${CH_IN} → ${CH_OUT}`);

    await redisSub.subscribe(CH_IN, procesarEstadoMercado);
    log(`📡 Suscrito a ${CH_IN}`);

    // Pedidos on-demand desde el chat (portfolio anclado en un activo)
    await redisSub.subscribe(CH_REQUEST, procesarRequest);
    log(`📡 Suscrito a ${CH_REQUEST} (portfolios on-demand del chat)`);

    // Heartbeat
    setInterval(() => {
      log(`❤️  sectores=${estadoMercado?.sectors?.length ?? 0} riesgo=${estadoMercado?.riesgoGlobal ?? "n/a"}`);
    }, 30000).unref();

  } catch (e) {
    _iniciado = false;
    log(`❌ start error: ${e.message}`, "error");
    setTimeout(() => start(), 5000);
  }
}

export async function stop() {
  try { if (redisSub?.isOpen) await redisSub.quit(); } catch (_) {}
  try { if (redisPub?.isOpen) await redisPub.quit(); } catch (_) {}
  _iniciado = false;
  log("Detenido.");
}

export async function getUltimoEstadoMercado() {
  return estadoMercado;
}

export { crearPortafolio };

// Auto-start
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch(e => { log(`Fatal: ${e.message}`, "error"); process.exit(1); });
  process.stdin.resume();
  process.on("SIGINT",  async () => { await stop(); process.exit(0); });
  process.on("SIGTERM", async () => { await stop(); process.exit(0); });
}