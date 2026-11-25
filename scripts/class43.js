// ============================================================
// class43.js — Motor de Backtesting y Validación v2.1
// ============================================================
//
// CAMBIOS v2.1:
//
//   1. RETORNO REAL en lugar de binario >0/<0
//      ANTES: outcomeNumero = retorno > 0 ? 1.0 : 0.0
//             Una señal BUY +0.001% valía lo mismo que +3%
//      AHORA: retorno_pct real guardado en historial
//             outcomeNumero = tanh(retorno * 20) escalado a [0,1]
//             Señales con mayor ganancia pesan más en el aprendizaje
//
//   2. SHARPE REAL con retornos porcentuales
//      ANTES: retornos = outcomeNumero - 0.5 (±0.5 siempre)
//      AHORA: retornos = retorno_pct real de cada señal
//             Sharpe refleja la distribución real de ganancias/pérdidas
//
//   3. STOP-LOSS RESPETADO en la verificación
//      Si class25A publicó stop_loss=0.03 y el precio cayó >3%
//      antes del vencimiento, el outcome se calcula al precio
//      del stop-loss, no al precio final. Refleja operación real.
//
//   4. VERIFICACIÓN REACTIVA al precio (no solo por setTimeout)
//      Cada vez que llega un precio nuevo de class7_output,
//      se verifica si alguna señal vencida tiene precio disponible.
//      Elimina el problema de verificación con mercado cerrado.
//
//   5. FEEDBACK ENRIQUECIDO a class24 (MLP C++) y class25A
//      Incluye retorno_pct real, no solo outcome binario.
//      class24 puede aprender la MAGNITUD del error, no solo dirección.
//
//   6. MÉTRICAS NUEVAS en Excel y Redis:
//      - retorno_promedio, retorno_std, mejor_señal, peor_señal
//      - precision_buy, precision_sell (separadas)
//      - hit_rate_por_confianza (¿las señales de alta confianza aciertan más?)
//      - max_drawdown real calculado sobre equity curve
//
//   7. VERIFICACIÓN DIFERIDA con mercado abierto
//      Detecta si el mercado está cerrado y espera el próximo precio válido.
// ============================================================

import Redis       from "ioredis";
import fs          from "fs/promises";
import fsSync      from "fs";
import path        from "path";
import { fileURLToPath } from "url";
import http        from "http";
import ExcelJS     from "exceljs";
import { guardarDecision, actualizarOutcomeReal, obtenerDecisionesPendientes, query as sqlQuery, guardarBacktestingStats, completarPrecioEntrada } from "./class42.js";
// FUENTE ÚNICA del universo (21-sep-2026). Ver scripts/universo.js.
import { TICKERS as UNIVERSO_JSON, resumenUniverso } from "./universo.js";

// Toda consulta SQL de este módulo pasa por `_sql`, no por `sqlQuery` directo.
// Es una indirección de una línea que permite inyectar una base falsa desde las
// simulaciones (`_test.setSql`) y probar la verificación contra datos reales del
// volcado sin levantar MySQL. En producción vale exactamente `sqlQuery`.
let _sql = sqlQuery;
// Misma indirección para la escritura del outcome: las simulaciones capturan
// lo que se habría guardado en vez de escribirlo.
let _actualizarOutcomeReal = actualizarOutcomeReal;
// Misma indirección para leer la cola de pendientes.
let _obtenerPendientes = obtenerDecisionesPendientes;
// Y para completar la fila que ya escribió class25B (ver la duplicación de
// filas en class42.js). `_filaExiste` es la consulta de confirmación para las
// señales sin precio, donde no hay nada que completar.
let _completarPrecio = completarPrecioEntrada;
// El INSERT de respaldo y la persistencia de estadísticas, también inyectables:
// sin esto una prueba en frío escribiría en la base de verdad.
let _guardarDecision = guardarDecision;
let _guardarStats    = guardarBacktestingStats;
async function _filaExiste(hash) {
  try {
    const r = await _sql(
      "SELECT 1 FROM cognitive_decisions WHERE hash_decision = ? LIMIT 1",
      [String(hash).slice(0, 64)]);
    const filas = Array.isArray(r) ? r : (r?.recordset ?? []);
    return filas.length > 0;
  } catch (_) { return false; }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir    = path.resolve(__dirname, "../operador/aprendizaje");
const metricsDir = path.join(baseDir, "metrics");
const cacheDir   = path.join(baseDir, "cache", "class43");
const logsDir    = path.join(baseDir, "logs");

for (const d of [metricsDir, cacheDir, logsDir])
  fsSync.mkdirSync(d, { recursive: true });

// ── Logger ─────────────────────────────────────────────────
const LOG_FILE = path.join(logsDir, "class43.log");
function log(msg, nivel = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class43/${nivel.toUpperCase()}] ${msg}`;
  console[nivel === "error" ? "error" : nivel === "warn" ? "warn" : "log"](line);
  try { fsSync.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Canales Redis ──────────────────────────────────────────
const REDIS_URL         = process.env.REDIS_URL || "redis://localhost:6379";
const CH_CLASS25_OUTPUT = "class25_output";
const CH_CLASS25_BT     = "class25_backtesting";
const CH_LSTM_PRICES    = "class44_output";   // precios reales de ETFs por ticker
const CH_MARKET_PRICES  = "class7_output";
const CH_OUTPUT         = "class43_output";
const CH_FEEDBACK_MLP    = "class24_feedback";   // feedback al MLP C++
const CH_FEEDBACK_NEURAL = "class23_feedback";   // feedback a la red de class23
const CH_FEEDBACK_25A   = "class25a_feedback";  // feedback a class25A
// class25B escucha "class43_feedback" desde siempre, pero NADIE publicaba ahí
// (canal huérfano, verificado en todo el codebase) → su aprendizaje lingüístico
// y el feedback que reenvía a class25A nunca se ejecutaron ni una vez.
const CH_FEEDBACK_25B   = "class43_feedback";   // feedback a class25B
const CH_UI             = "ui_stream";

// ── Horizontes en ms ───────────────────────────────────────
// BUG HISTÓRICO: faltaba la clave "48h", que es la que más emite class25A
// (class25A.cpp: confianza>0.65 ? 24 : confianza>0.50 ? 48 : 72). El lookup
// `HORIZONTE_MS[h] ?? HORIZONTE_MS["24h"]` la resolvía al fallback de 24 h,
// así que las señales de 48 h VENCÍAN a las 24 h — mientras _precioHistorico
// y _marketRet las valorizaban a 48 h (`Number(d.horizonte) || 48`, más abajo).
// Dos horizontes distintos para la misma señal, sin ningún error visible.
//
// El mapa es una whitelist: cualquier horizonte que no esté acá se degrada a
// 24 h en silencio. Al agregar un horizonte nuevo en class25A, agregarlo acá.
const HORIZONTE_MS = {
  "1h":   1*3600000,   // modo debug del lazo de feedback (ver HORIZONTE_DEBUG_H)
  "4h":   4*3600000,
  "24h": 24*3600000,
  "48h": 48*3600000,   // ← faltaba: el horizonte modal del ensemble
  "72h": 72*3600000,
};

// ── Estado global ──────────────────────────────────────────
let redisSub = null;
let redisPub = null;

// Señales en seguimiento
// id → { tipo, ticker, confianza, horizonte, precio_entrada,
//         stop_loss, ts_entrada, ts_vencimiento, hash_condicion,
//         red_dominante, vector_id }
const señalesEnCurso = new Map();

// Precios más recientes por ticker + timestamp del precio
const preciosActuales = new Map();  // ticker → { precio, ts }

// Historial con retornos reales
const historialDecisiones = [];
const MAX_HISTORIAL = 5000;

// ── Métricas ───────────────────────────────────────────────
const metricas = {
  total:           0,
  correctas:       0,
  incorrectas:     0,
  pendientes:      0,
  accuracy_global: 0,
  accuracy_30d:    0,
  precision_buy:   0,
  precision_sell:  0,
  retorno_promedio: 0,
  retorno_std:      0,
  mejor_señal:      0,
  peor_señal:       0,
  sharpe:           0,
  max_drawdown:     0,
  // Señales cuyo ticker está fuera de UNIVERSO_MKT (GENERAL, classN…): no
  // pueden recibir etiqueta relativa. Declarado acá para que aparezca siempre
  // en el payload de métricas, incluso en 0, y el panel no vea el campo
  // aparecer de la nada a mitad de una serie.
  no_medibles:      0,
  ultima_actualizacion: null
};

// ============================================================
// MOTORES DE CÁLCULO
// ============================================================
const RiskEngine = {
  // Sharpe anualizado con protección contra std≈0 (float precision)
  // Si todos los retornos son idénticos → std es ~0 por aritmética flotante → Sharpe explota
  sharpe(retornos_pct, rfDiario = 0.01 / 252) {
    if (retornos_pct.length < 2) return 0;
    const mean = retornos_pct.reduce((a, b) => a + b, 0) / retornos_pct.length;
    const vol  = this.std(retornos_pct);
    // Umbral 1e-4 (antes 1e-7): retornos casi idénticos (caso degenerado, ej.
    // batch verificado con el mismo proxy) producían raw enorme → cap 10 clavado
    if (vol < 1e-4) return 0;                    // std demasiado pequeño → 0
    const raw = (mean - rfDiario) / vol * Math.sqrt(252);  // anualizado
    const clamped = Math.max(-10, Math.min(10, raw));       // cap ±10
    return +clamped.toFixed(4);
  },
  std(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const varr = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return Math.sqrt(varr);
  },
  // Max drawdown sobre equity curve acumulada
  maxDrawdown(retornos_pct) {
    if (!retornos_pct.length) return 0;
    let equity = 1.0, peak = 1.0, maxDD = 0;
    for (const r of retornos_pct) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return +maxDD.toFixed(4);
  }
};

// ============================================================
// ESCALAR RETORNO REAL A [0,1] PARA FEEDBACK DE MLP
// Usa tanh para que ganancias grandes valgan mucho más que pequeñas
// y pérdidas grandes castiguen más que pequeñas.
//   retorno=0%    → 0.5 (neutral)
//   retorno=+5%   → ~0.85
//   retorno=+10%  → ~0.95
//   retorno=-5%   → ~0.15
//   retorno=-10%  → ~0.05
// ============================================================
function retornoAOutcome(retorno_pct, esBuy) {
  // Retorno desde la perspectiva de la señal
  // Si es BUY: retorno positivo = bueno. Si es SELL: retorno negativo = bueno
  const retornoSignal = esBuy ? retorno_pct : -retorno_pct;
  // Escalar: factor 20 hace que ±5% produzca tanh(±1) ≈ ±0.76
  const scaled = Math.tanh(retornoSignal * 20);
  // Mapear [-1,1] → [0,1]
  return +(0.5 + scaled * 0.5).toFixed(4);
}

// ============================================================
// ATRIBUCIÓN DE CRÉDITO — qué red mandó de verdad en la decisión
// ============================================================
//
// EL DEFECTO (verificado 10-sep-2026). Era el argmax del score CRUDO:
//
//     Object.entries(señal.scores).sort((a,b) => b[1]-a[1])[0]?.[0]
//
// Las redes NO comparten escala. Medido en producción: `class22/portfolio`
// vive entre 0,93 y 0,95; `class24/cluster` entre 0,20 y 0,26. Con un argmax
// plano gana SIEMPRE la misma — no por acertar, sino por devolver el número
// más grande. Las otras quince no reciben señal de aprendizaje nunca.
// Ese es el motivo estructural de que los pesos por sub-red no se despeguen
// de PESO_INICIAL: no es falta de tiempo corriendo, y más días no lo arreglan.
//
// EL ARREGLO. Cada red se compara contra SÍ MISMA. Se mantienen media y
// desvío corrientes de su propio score (Welford, O(1) y sin guardar historia)
// y el crédito va a la que más se apartó de SU normal EN LA DIRECCIÓN que la
// decisión terminó tomando. Una red plana en 0,94 deja de cobrar por vivir
// arriba: sólo cobra cuando se mueve de verdad. Es scale-invariante, que es
// exactamente lo que le faltaba al argmax.
//
// DEVOLVER "" ES PARTE DEL ARREGLO, no un caso de borde. class25A lee este
// campo como `if (!red.empty()) {…} else if (!hash_condicion.empty()) {…}`:
// con "" cae a la capa 2, que reparte por snapshot entre TODAS las redes.
// Acreditar a nadie es neutro; acreditar a la equivocada corrompe los pesos
// en cada feedback. Ante la duda, no atribuir.
const RED_MIN_MUESTRAS = Math.max(10, +(process.env.C43_RED_MIN_MUESTRAS ?? 50));
const RED_Z_MIN        = Math.max(0,  +(process.env.C43_RED_Z_MIN        ?? 0.5));

const _estRed = new Map();   // red → { n, media, m2 }
const _atrib  = { z: 0, sin_stat: 0, sin_lean: 0, sin_scores: 0 };

// Welford: media y varianza corrientes en una pasada, sin acumular muestras.
function _observarScores(scores) {
  if (!scores || typeof scores !== "object") return;
  for (const [red, v] of Object.entries(scores)) {
    const x = +v;
    if (!Number.isFinite(x)) continue;
    let e = _estRed.get(red);
    if (!e) { e = { n: 0, media: 0, m2: 0 }; _estRed.set(red, e); }
    e.n += 1;
    const d = x - e.media;
    e.media += d / e.n;
    e.m2    += d * (x - e.media);
  }
}

// Cuántos desvíos propios se apartó esta red de su media. null = todavía no
// se puede afirmar nada: o hay pocas muestras, o la red es una CONSTANTE
// (desvío ~0), y una constante no aporta información aunque su score sea alto.
function _zDe(red, x) {
  const e = _estRed.get(red);
  if (!e || e.n < RED_MIN_MUESTRAS) return null;
  const sd = Math.sqrt(e.m2 / Math.max(1, e.n - 1));
  if (!(sd > 1e-9)) return null;
  return (x - e.media) / sd;
}

function redDominante(scores, tipo) {
  if (!scores || typeof scores !== "object") { _atrib.sin_scores++; return ""; }
  // BUY premia haberse inclinado al alza; SELL, a la baja.
  const signo = tipo === "SELL" ? -1 : 1;
  let mejor = "", mejorZ = -Infinity, hubo = false;
  for (const [red, v] of Object.entries(scores)) {
    const x = +v;
    if (!Number.isFinite(x)) continue;
    const z = _zDe(red, x);
    if (z == null) continue;
    hubo = true;
    const zDir = signo * z;
    if (zDir > mejorZ) { mejorZ = zDir; mejor = red; }
  }
  if (!hubo)              { _atrib.sin_stat++; return ""; }   // calentando
  if (mejorZ < RED_Z_MIN) { _atrib.sin_lean++; return ""; }   // nadie se jugó
  _atrib.z++;
  return mejor;
}

// ============================================================
// PROCESAR SEÑAL ENTRANTE
// ============================================================
// ── _persistirPrecioEntrada ───────────────────────────────────────────────
// class25B publica a Redis ANTES de escribir en MySQL, asi que class43 puede
// llegar primero por milisegundos. Se reintenta con espera creciente antes de
// decidir que la fila no existe.
//
// El INSERT de respaldo NO se saca: si class25B no pudo guardar (base caida,
// por ejemplo), sin el la decision no queda registrada en ningun lado y se
// pierde la verificacion entera. Vuelve a duplicar en ese caso — que es raro,
// queda logueado, y es preferible a perder el dato.
const REINTENTOS_COMPLETAR = [400, 1200, 3000];   // ms

async function _persistirPrecioEntrada(id, precioEntrada, señal, tipo, ticker,
                                       confianza, horizonte) {
  try {
    if (precioEntrada != null) {
      for (let i = 0; i < REINTENTOS_COMPLETAR.length; i++) {
        if (await _completarPrecio(id, precioEntrada)) {
          metricas.filas_completadas = (metricas.filas_completadas || 0) + 1;
          return;
        }
        await new Promise(r => setTimeout(r, REINTENTOS_COMPLETAR[i]));
      }
    } else {
      // Sin precio no hay nada que completar, y la fila de class25B ya existe.
      // Un reintento alcanza para confirmar que esta; si no, se inserta.
      await new Promise(r => setTimeout(r, REINTENTOS_COMPLETAR[0]));
      if (await _filaExiste(id)) return;
    }

    metricas.filas_duplicadas = (metricas.filas_duplicadas || 0) + 1;
    log(`⚠️ ${String(id).slice(0,12)}: no aparecio la fila de class25B → se inserta ` +
        `(duplicadas=${metricas.filas_duplicadas})`, "warn");
    await _guardarDecision({
      origen: "class25", externalId: id, decision: tipo,
      contexto: señal.texto ?? señal.decision ?? "",
      rationale: señal.rationale ?? [],
      confianza, ticker, horizonte,
      precio_entrada: precioEntrada,
    });
  } catch (e) {
    log(`⚠️ _persistirPrecioEntrada: ${e?.message}`, "warn");
  }
}

async function procesarSeñal(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.source === "class43") return;

    const señal = data?.data ?? data;
    if (!señal || typeof señal !== "object") return;
    // La estadística por red se alimenta con TODAS las decisiones, incluidas
    // las HOLD que se descartan tres líneas más abajo. El punto de comparación
    // tiene que ser el comportamiento NORMAL de la red; con el filtro de HOLD
    // delante, la media quedaba condicionada a "ya se decidió operar" y el
    // z-score medía contra una referencia sesgada (~28% de las decisiones).
    _observarScores(señal.scores);


    const tipo = señal.senal ?? señal.signal ?? señal.tipo;
    if (!["BUY","SELL","HOLD"].includes(tipo)) return;
    if (tipo === "HOLD") return;

    const id        = señal.id ?? `c43_${Date.now()}`;
    const ticker    = señal.ticker    ?? "GENERAL";
    const confianza = +(señal.confianza ?? señal.confidence ?? 0);
    const horizonte = señal.horizonte  ?? "24h";
    const stop_loss = +(señal.stop_loss ?? 0.03);   // stop-loss del emisor
    const hash_cond = señal.hash_condicion ?? "";    // para feedback a class25A
    const red_dom   = redDominante(señal.scores, tipo);
    const ts        = señal.ts ? new Date(señal.ts).getTime() : Date.now();

    if (señalesEnCurso.has(id)) return;

    // ── RECHAZO EN LA PUERTA: lo que no se puede verificar, no se rastrea ──
    // Un ticker fuera de UNIVERSO_MKT (GENERAL, class19, classN…) no tiene
    // precio propio, así que nunca obtiene etiqueta relativa —_esSenalDeMercado
    // lo excluye en verificarOutcome()— y su único destino posible es
    // "descartado" tras MAX_RETRIES_SIN_PRECIO reintentos.
    //
    // Rastrearlos igual costaba tres cosas: inflaban `pendientes` (llegó a
    // ~53.600), quemaban CPU de reconciliación por cada ciclo, y los pocos que
    // sí cerraban lo hacían con etiqueta ABSOLUTA (base rate ~78%) alimentando
    // el feedback de class25A con una pregunta distinta de la que mide la
    // tesis. Menos volumen de aprendizaje, pero del que sirve.
    // MODO SOMBRA POR DEFECTO (30-ago-2026). Medido en el log de producción:
    // las decisiones siguen llegando con ticker="GENERAL" — la propagación
    // aguas arriba NO está resuelta. Con rechazo activo, class43 descartaría
    // el 100% de las señales y el lazo de feedback se iría a cero.
    //
    // Así que por ahora solo se CUENTA lo que se rechazaría. El contador
    // `no_medibles` vs `total` es la medición directa del cuello de botella:
    // cuando baje, la propagación está arreglada y recién ahí se activa el
    // rechazo con C43_RASTREAR_NO_MEDIBLES=0. Sin reinstalar nada.
    const esMedible = UNIVERSO_MKT.includes(ticker);
    if (!esMedible) {
      metricas.no_medibles = (metricas.no_medibles || 0) + 1;
      if (!_noMedibleAvisado.has(ticker)) {
        _noMedibleAvisado.add(ticker);
        log(`🚫 ${ticker} fuera de UNIVERSO_MKT → NO verificable con etiqueta relativa. ` +
            `Se rastrea igual (modo sombra). Aviso único por ticker.`, "warn");
      }
      if (!RASTREAR_NO_MEDIBLES) return;   // solo descarta si se activa el flag
    }

    const precioData  = _getPrecioCompuesto(ticker);
    const precioEntrada = precioData?.precio ?? null;

    log(`📥 ${tipo} ${ticker} conf=${confianza} horizonte=${horizonte} stop=${(stop_loss*100).toFixed(1)}%${precioData?.composite ? " [compuesto]" : ""}`);

    señalesEnCurso.set(id, {
      id, tipo, ticker, confianza, horizonte,
      stop_loss,
      hash_condicion: hash_cond,
      red_dominante:  red_dom,
      precio_entrada: precioEntrada,
      precio_stop:    precioEntrada ? precioEntrada * (tipo === "BUY" ? (1 - stop_loss) : (1 + stop_loss)) : null,
      ts_entrada:     ts,
      ts_vencimiento: ts + (HORIZONTE_MS[horizonte] ?? HORIZONTE_MS["24h"]),
      verificado:     false,
    });

    metricas.pendientes++;

    // ── UNA fila por decision, no dos (21-sep-2026) ───────────────────────
    // class25B ya inserto esta decision al publicarla: comparten
    // `hash_decision`. Lo unico que class43 agrega es `precio_entrada`, asi
    // que COMPLETA esa fila en vez de insertar una segunda.
    //
    // Se lanza DESACOPLADO (sin await) a proposito: la decision ya esta en
    // `senalesEnCurso`, el tracking no depende de esto, y encadenar reintentos
    // de base al bucle de mensajes lo frenaria. Si falla, se pierde el
    // precio_entrada persistido —la senal se sigue verificando en memoria— y
    // queda contado en `metricas.sin_completar`.
    _persistirPrecioEntrada(id, precioEntrada, señal, tipo, ticker, confianza, horizonte);

    log(`⏱️ Tracking iniciado: ${id.slice(0,12)} [${tipo} ${ticker}]`);

    // Publicar métricas inmediatamente para que el dashboard refleje
    // el nuevo pendiente sin esperar el ciclo de 5 minutos
    publicarMetricas().catch(() => {});

  } catch (e) {
    log(`⚠️ procesarSeñal: ${e.message}`, "warn");
  }
}

// ============================================================
// VERIFICAR OUTCOME — ahora con retorno real y stop-loss
// ============================================================
// Reintentos antes de descartar una señal sin precio disponible.
// Las señales agregadas (GENERAL / classN) vencen antes de que class7
// publique precios al arrancar → se re-encolan en vez de spamear WARN.
const MAX_RETRIES_SIN_PRECIO = 30;
// Retorno mínimo para que una verificación direccional sea MEDIBLE.
// Si |retorno| < RET_EPSILON la ventana estuvo (casi) congelada — típico de
// señales cuyo horizonte cae entero en fin de semana / mercado cerrado: el
// precio no se movió, retorno = 0 exacto, y el veredicto `BUY ? ret>0 : ret<0`
// marcaría "incorrecto" a CUALQUIER señal (0 no es >0 ni <0). Un movimiento
// nulo no confirma ni refuta una predicción de dirección → se descarta
// (fuera de métricas y del feedback de aprendizaje), igual que "sin precio".
const RET_EPSILON = 1e-4;   // 0.01%
// Set para avisar UNA sola vez por ticker (evita 22 líneas idénticas de
// "Sin precio para class19"). Se limpia cuando llegan precios frescos.
const _sinPrecioAvisado = new Set();

// ── Señales no medibles (fuera de UNIVERSO_MKT) ──────────────────────────
// Por defecto 1 = SE RASTREAN (comportamiento actual, sin cambios). Pasar a 0
// solo cuando la propagación del ticker esté arreglada aguas arriba y las
// decisiones lleguen con XLK/XLF/… en vez de GENERAL. Activarlo antes vacía
// el lazo de feedback: hoy el 100% de las señales llega como GENERAL.
const RASTREAR_NO_MEDIBLES = (process.env.C43_RASTREAR_NO_MEDIBLES ?? "1") === "1";
const _noMedibleAvisado = new Set();

// ── Horizonte vencido con mercado cerrado ────────────────────────────────
// Una señal cuyo horizonte cae entero en fin de semana / feriado tiene
// retVeredicto ≈ 0 y hoy se descarta para siempre. Pero la señal no es
// inválida: el que no corrió fue el reloj. En vez de tirarla, se corre el
// vencimiento a la próxima sesión, hasta MAX_PRORROGAS veces.
const MAX_PRORROGAS       = 3;
const PRORROGA_MS         = 24 * 60 * 60 * 1000;

// ── Retorno del MERCADO sobre el horizonte ───────────────────────────────
// Promedio equiponderado del retorno de los ETFs reales entre ts_decision y
// ts_decision+horizonte. Es el término que convierte el retorno absoluto en
// relativo: `retornoRel = retorno − mkt`.
//
// SUBIDA A SCOPE DE MÓDULO (antes vivía dentro de bootstrap()). Ese detalle de
// alcance es la razón por la que ORDEN 1 solo llegó a la mitad del sistema:
// `reconciliarPendientesDB()` está dentro de bootstrap y podía usarla, pero
// `verificarOutcome()` es una función de módulo y no la veía. Resultado: dos
// caminos de verificación escribiendo la misma tabla con criterios distintos —
// la reconciliación juzgando contra el promedio de los 13, y el camino en
// memoria contra el retorno absoluto, que es la pregunta que ORDEN 1 reemplazó.
//
// El comentario de reconciliarPendientesDB dice "el camino en memoria casi no
// corre". Era cierto cuando se escribió; tras el reinicio del 11-ago pasó a
// atender casi todo, y ahí se hizo visible: 433 verificaciones con la etiqueta
// vieja y `label_modo` en NULL.
//
// Solo depende de _sql, importado a nivel de módulo.
// ── Universo del benchmark ───────────────────────────────────────────────
// `mkt` define la etiqueta relativa (retornoRel = retorno − mkt): es lo que
// JUZGA el acierto y lo que se les enseña a las redes como dirección. Por eso
// el universo es una DECISIÓN, no un descubrimiento.
//
// Antes salía de `SELECT DISTINCT ticker FROM precios WHERE ts > NOW()-45d`,
// con dos problemas medidos en producción el 15-ago-2026:
//
//   1) CORRECTITUD. Devolvía 18 tickers, no 13: MELI, DIS, TSLA, YPF y NFLX
//      entraban al promedio. Son símbolos consultados desde el chat en julio y
//      sin datos de precio desde entonces (último: 9 a 17-jul). Como las dos
//      subconsultas son `ts <= X ORDER BY ts DESC LIMIT 1` SIN cota inferior,
//      para cualquier decisión posterior p1 y p0 devuelven el MISMO precio
//      viejo → (p1-p0)/p0 = 0 exacto, y el `WHERE p0>0 AND p1>0` los deja
//      pasar. Cinco ceros dentro del AVG: `mkt` salía a 13/18 = 72% de su
//      valor real, sesgando retornoRel hacia arriba de forma sistemática y
//      rompiendo el balance ~50/50 "por construcción" que es la premisa entera
//      de ORDEN 1 (base_rate observado: 64.4%, esperado ~50%).
//      Siguen en `precios` A PROPÓSITO: class45 los usa para sentimiento y el
//      chat para consultas. Lo que no pueden es entrar al benchmark de precios.
//
//   2) COSTO. La derivada no dependía de NINGÚN parámetro —devolvía siempre lo
//      mismo— y se recalculaba en cada llamada: 903 ms leyendo 681.808 filas
//      para devolver 18 (EXPLAIN ANALYZE, 15-ago). Ningún índice lo arregla:
//      el filtro `ts > NOW()-45d` deja pasar el 99.3% de la tabla, así que no
//      hay filas que saltear. Con la reconciliación llamándola por cada
//      pendiente, mysqld llegó a 487% de CPU (5 de 6 núcleos) con cinco copias
//      idénticas corriendo en paralelo.
//
// Mismo conjunto que vectoriza class10 y que entrena class44 (TICKERS).
const UNIVERSO_MKT = UNIVERSO_JSON;   // config/universo.json
const _UNIV_SQL = UNIVERSO_MKT.map(() => "SELECT ? AS ticker").join(" UNION ALL ");

const _marketRetCache = new Map();
async function _marketRet(tsDecision, horizonteH) {
  // Corte barato ANTES de consultar. `DATE_ADD(?) <= NOW(3)` vive en el WHERE
  // exterior, o sea que se evalúa DESPUÉS de materializar la derivada: el caso
  // más común (horizonte sin vencer) pagaba la query entera para descartarla.
  // Y como el null no se cachea —a propósito, ver abajo— la repetía en cada
  // ciclo de reconciliación, con ~53.600 pendientes en tracking.
  //
  // El guard de SQL se conserva y sigue siendo la autoridad. Los relojes se
  // verificaron alineados (MySQL CEST == sistema, 15-ago); el margen de 2 h es
  // seguro contra un cambio futuro de zona horaria, no la corrección de uno.
  const vence = new Date(tsDecision).getTime() + horizonteH * 3600e3;
  if (!Number.isFinite(vence) || vence > Date.now() + 2 * 3600e3) return null;

  let key = null;
  // La clave es el instante EXACTO de la decisión (23-nov-2026). Era la HORA
  // (`toISOString().slice(0,13)`): todas las decisiones de una misma hora
  // recibían el mercado de la primera que se calculó, aunque empezaran hasta
  // 59 min después, mientras el instrumento sí se medía desde su minuto real.
  // Medido con sim44 sobre 88.965 decisiones post-corte: daba vuelta el 6,7 %
  // de las etiquetas. Por minuto quedaba en 1,15 % (class7 escribe cada ~90 s).
  // Con la clave exacta la caché casi no pega, y está bien: son 100 búsquedas
  // por idx_ticker_ts, unos milisegundos por decisión verificada.
  try { key = `${new Date(tsDecision).toISOString()}|${horizonteH}`; } catch {}
  if (key && _marketRetCache.has(key)) return _marketRetCache.get(key);

  // Se cachea la PROMESA en curso, no el resultado. Con el valor, entre el
  // has() y el await hay una ventana en la que N llamadas concurrentes con la
  // misma clave fallan el chequeo y disparan N queries idénticas — el
  // processlist del 15-ago mostró cinco a la vez.
  const enCurso = (async () => {
    const r = await _sql(
      `SELECT AVG((p1 - p0) / p0) AS ret FROM (
         SELECT
           (SELECT precio FROM precios WHERE ticker = t.ticker AND precio > 0
              AND ts <= DATE_ADD(?, INTERVAL ? HOUR) ORDER BY ts DESC LIMIT 1) AS p1,
           (SELECT precio FROM precios WHERE ticker = t.ticker AND precio > 0
              AND ts <= ? ORDER BY ts DESC LIMIT 1) AS p0
         FROM (${_UNIV_SQL}) t
       ) x
       WHERE p0 > 0 AND p1 > 0 AND DATE_ADD(?, INTERVAL ? HOUR) <= NOW(3)`,
      // 18 parámetros en ORDEN TEXTUAL: p1(2) · p0(1) · universo(13) · WHERE(2).
      // La derivada está en el FROM, o sea DESPUÉS de las subconsultas del
      // SELECT: si alguna vez se mueve de lugar hay que reordenar este array.
      // Un `?` corrido acá no tira error — devuelve un número equivocado.
      [tsDecision, horizonteH, tsDecision, ...UNIVERSO_MKT, tsDecision, horizonteH]
    );
    const v = r?.recordset?.[0]?.ret;
    return v != null ? Number(v) : null;
  })();

  if (key) _marketRetCache.set(key, enCurso);
  let ret = null;
  try { ret = await enCurso; } catch { ret = null; }
  // Cachear SOLO valores reales. NULL significa casi siempre "horizonte aún no
  // vencido" — condición TEMPORAL que no puede congelarse: cachear null dejaba
  // la señal inverificable para siempre. Por eso la promesa se BORRA si resolvió
  // en null, en vez de quedar pegada en el Map.
  if (key) {
    if (ret == null) _marketRetCache.delete(key);
    else {
      if (_marketRetCache.size > 500) _marketRetCache.clear();
      _marketRetCache.set(key, ret);
    }
  }
  return ret;
}

// ¿La señal es de mercado agregado (sin instrumento)? Ahí no hay relativo
// posible: sería mercado − mercado = 0. Mismo criterio que la reconciliación.
function _esSenalDeMercado(ticker) {
  return /^class/i.test(ticker || "") || ticker === "GENERAL";
}

async function verificarOutcome(id) {
  const señal = señalesEnCurso.get(id);
  if (!señal || señal.verificado) return;

  const precioData   = _getPrecioCompuesto(señal.ticker);
  let   precioSalida = precioData?.precio ?? null;
  const pEntrada     = señal.precio_entrada;

  // ── DEFECTO 5 (21-sep-2026): el agregado se valúa EQUIPONDERADO ────────
  // `_getPrecioCompuesto` devuelve el promedio de PRECIOS de los 13, así que el
  // retorno que sale de él es un índice tipo Dow: XLK pesa 15,8 % e ILF 2,9 %,
  // un rango de 5,4×. Medido sobre el volcado del 15-sep, 31.529 ventanas: contra
  // el equiponderado de RETORNOS difiere 0,11 pp a 24 h y 0,19 pp a 48 h, y
  // **le cambia el signo al 4,3 % (24 h) y al 10,8 % (48 h) de las ventanas**.
  // Esas son etiquetas `absoluto` dadas vuelta que después entrenan a class23/24
  // (ver defecto 10), y además subestima el retorno medio: 0,014 % contra 0,035 %.
  //
  // La reconciliación YA lo hacía bien —usa `_marketRet`, que promedia retornos—,
  // así que los dos caminos de verificación se contradecían entre sí sobre la MISMA
  // decisión. Ahora los dos usan la misma vara.
  //
  // Se reescribe `precioSalida` en vez de tocar el cálculo de abajo: así
  // `(precioSalida − pEntrada) / pEntrada` da exactamente `mkt`, la fila queda
  // coherente consigo misma para quien lea la base, y el resto de la función
  // —stop-loss, prórrogas, feedback— no cambia ni una línea.
  //
  // Si `_marketRet` no puede valuar todavía, se REINTENTA y después se descarta:
  // no se cae al índice viejo. Una etiqueta tarde es mejor que una equivocada.
  if (_esSenalDeMercado(señal.ticker) && pEntrada && precioSalida) {
    const horizonteH = parseInt(señal.horizonte, 10) || 48;
    const mkt = await _marketRet(new Date(señal.ts_entrada), horizonteH);
    if (mkt == null) {
      señal._retries = (señal._retries || 0) + 1;
      if (señal._retries <= MAX_RETRIES_SIN_PRECIO) {
        if (!_sinPrecioAvisado.has(señal.ticker)) {
          _sinPrecioAvisado.add(señal.ticker);
          log(`⏳ ${señal.ticker}: el índice equiponderado no valúa aún — se reintenta`, "warn");
        }
        return;                // NO marcar verificado → reintenta el próximo ciclo
      }
      precioSalida = null;     // agotados los reintentos → rama "sin precio" → descartado
    } else {
      precioSalida = pEntrada * (1 + mkt);
    }
  }

  let outcome       = "pendiente";
  let outcomeNumero = 0.5;
  let retorno_pct   = 0;
  // ORDEN 1 — declarados acá para que lleguen vivos al UPDATE de MySQL.
  //   retorno_pct → retorno crudo del instrumento (P&L, alimenta la equity curve)
  //   retornoRel  → retorno − promedio de los 13 (lo que JUZGA el acierto)
  //   labelModo   → "relativo" | "absoluto"; separa poblaciones incomparables
  //   retVeredicto→ el relativo si existe, si no el absoluto. Es lo que juzga
  //                 el acierto Y lo que se les enseña a las redes como dirección.
  let retornoRel = null, labelModo = "absoluto", retVeredicto = 0;

  // ── Caso especial: señal restaurada sin precio de entrada ────────
  // Antes se "verificaba" con el change_pct compuesto del mercado en el momento
  // de la verificación — un proxy inválido: no es el retorno del ticker durante
  // el horizonte de la señal, y como es el MISMO número para todas las señales
  // del batch, un día de mercado en alza marcaba TODAS las BUY como correctas y
  // TODAS las SELL/HOLD como incorrectas (eso produjo BUY 23/23, SELL 0/28 en
  // la DB y un Sharpe clavado en el cap de 10). Sin precio de entrada real la
  // señal NO se puede verificar honestamente → se descarta y no cuenta en las
  // métricas de precisión.
  if (!pEntrada && precioSalida) {
    outcome = "descartado";
    log(`🗑️ ${id.slice(0,12)}: ${señal.tipo} ${señal.ticker} sin precio_entrada → descartado (no verificable)`);
  } else if (pEntrada && precioSalida) {
    retorno_pct = (precioSalida - pEntrada) / pEntrada;

    // Verificar stop-loss: si el precio tocó el stop, usar precio stop
    let precioEfectivo = precioSalida;
    let stopActivado   = false;

    if (señal.precio_stop) {
      const stopTocado = señal.tipo === "BUY"
        ? precioSalida <= señal.precio_stop
        : precioSalida >= señal.precio_stop;
      if (stopTocado) {
        precioEfectivo = señal.precio_stop;
        retorno_pct    = (precioEfectivo - pEntrada) / pEntrada;
        stopActivado   = true;
        log(`🛑 Stop-loss activado ${señal.ticker}: ${(retorno_pct*100).toFixed(2)}%`);
      }
    }

    // ── ORDEN 1: retorno RELATIVO ───────────────────────────────────────
    // Mismo criterio que reconciliarPendientesDB(). Sin esto, este camino
    // juzgaba con el retorno ABSOLUTO —"¿subió el mercado?", cuyo baseline
    // trivial acierta ~78%— mientras el otro juzgaba contra el promedio de los
    // 13, con baseline ~50%. Dos preguntas distintas escribiendo la misma
    // columna, y la de acá además llegaba al feedback de las redes.
    if (!_esSenalDeMercado(señal.ticker)) {
      const horizonteH = parseInt(señal.horizonte, 10) || 48;
      // Date, no string: es lo que mysql2 devuelve en los SELECT y lo que le
      // pasa la reconciliación, así que la conversión de zona horaria es
      // idéntica en los dos caminos. Un string ISO en UTC los desalinearía.
      const mkt = await _marketRet(new Date(señal.ts_entrada), horizonteH);
      if (mkt != null) { retornoRel = retorno_pct - mkt; labelModo = "relativo"; }
    }
    retVeredicto = retornoRel != null ? retornoRel : retorno_pct;

    if (Math.abs(retVeredicto) < RET_EPSILON) {
      // Veredicto ~0 = no medible. Se evalúa sobre el retorno del VEREDICTO, no
      // sobre el crudo: un ticker puede moverse 1% (absoluto ≠ 0) y empatar
      // exacto con el promedio (relativo = 0) — ahí tampoco hay nada que
      // confirmar ni refutar sobre habilidad relativa.
      // PRÓRROGA antes de descartar. Un veredicto ~0 casi siempre significa
      // que el horizonte cayó entero en mercado cerrado (fin de semana o
      // feriado): el precio no se movió porque no hubo sesión, no porque la
      // predicción fuera indistinguible. Descartarla ahí tira evidencia buena
      // por un problema de calendario — y con horizontes de 24-48 h, cae en
      // fin de semana ~2 de cada 7 veces.
      //
      // Se corre el vencimiento un día y se reintenta, hasta MAX_PRORROGAS.
      // Si tras las prórrogas el veredicto sigue en ~0, ahí sí es un empate
      // real contra el promedio y se descarta como antes.
      // Solo se prorrogan tickers REALES. Para un agregado (GENERAL/classN) el
      // veredicto ~0 no viene del calendario sino de que no tiene precio propio
      // — prorrogarlo lo dejaría 3 días más en `señalesEnCurso` sin ninguna
      // chance de resolverse, y hoy el 100% de las señales son de ese tipo:
      // sería inflar el backlog de pendientes (ya llegó a ~53.600) por nada.
      const prorrogable = UNIVERSO_MKT.includes(señal.ticker);
      señal._prorrogas = (señal._prorrogas || 0) + 1;
      if (prorrogable && señal._prorrogas <= MAX_PRORROGAS) {
        señal.ts_vencimiento = Date.now() + PRORROGA_MS;
        log(`📅 ${id.slice(0,12)}: ${señal.tipo} ${señal.ticker} veredicto ~0 ` +
            `(${(retVeredicto*100).toFixed(3)}% ${labelModo}) → prórroga ` +
            `${señal._prorrogas}/${MAX_PRORROGAS} (mercado cerrado)`);
        return;   // NO marcar verificado, NO borrar → se reevalúa mañana
      }

      outcome       = "descartado";
      outcomeNumero = 0.5;   // neutro → tampoco dispara feedback de aprendizaje
      log(`⚪ ${id.slice(0,12)}: ${señal.tipo} ${señal.ticker} veredicto ~0 ` +
          `(${(retVeredicto*100).toFixed(3)}% ${labelModo}) tras ${MAX_PRORROGAS} prórrogas → descartado (empate real)`);
    } else {
    const esBuy  = señal.tipo === "BUY";
    const esSell = señal.tipo === "SELL";

    // ── DEFECTO 4 (21-sep-2026): sólo BUY y SELL tienen acierto definido ──
    // Era `esBuy ? ret > 0 : ret < 0`, o sea que TODO lo que no fuera BUY se
    // juzgaba con la regla del SELL. Un HOLD "acertaba" únicamente si el
    // instrumento perdía contra el promedio, que no es una definición
    // defendible de acierto para una decisión de no hacer nada.
    //
    // Hoy no debería entrar ninguna: procesarSeñal descarta las HOLD y la
    // consulta de pendientes filtra `senal IN ('BUY','SELL')`. Pero la regla
    // vieja no fallaba, contestaba — y una etiqueta inventada que entra al
    // entrenamiento es peor que una que falta. Si aparece algo distinto se
    // descarta y se avisa.
    if (!esBuy && !esSell) {
      outcome       = "descartado";
      outcomeNumero = 0.5;
      log(`⚪ ${id.slice(0,12)}: señal "${señal.tipo}" sin acierto definido → descartada`, "warn");
    } else {
    // Magnitud sobre el retorno del VEREDICTO: es el objetivo que se está
    // midiendo. Viaja como informativo (outcome_magnitud), no como target.
    outcomeNumero = retornoAOutcome(retVeredicto, esBuy);

    // Outcome texto: sigue siendo correcto/incorrecto para legibilidad
    const acerto = esBuy ? retVeredicto > 0 : retVeredicto < 0;
    outcome      = acerto ? "correcto" : "incorrecto";

    log(`🎯 ${id.slice(0,12)}: ${señal.tipo} ${señal.ticker} | ` +
        `entrada=${pEntrada.toFixed(2)} salida=${precioEfectivo.toFixed(2)} ` +
        `retorno=${(retorno_pct*100).toFixed(2)}%` +
        (labelModo === "relativo" ? ` rel=${(retornoRel*100).toFixed(2)}%` : "") +
        ` → ${outcome} [${labelModo}] ` +
        `[outcome_mlp=${outcomeNumero.toFixed(3)}${stopActivado ? " STOP" : ""}]`);
    }
    }
  } else {
    // Sin precio disponible todavía (típico al arrancar: las señales vencidas
    // se re-verifican ANTES de que class7 publique precios). En lugar de
    // spamear un WARN por señal y descartarla, la dejamos en cola para
    // reintentar cuando lleguen los precios. Solo se descarta tras agotar
    // los reintentos.
    señal._retries = (señal._retries || 0) + 1;
    if (señal._retries <= MAX_RETRIES_SIN_PRECIO) {
      // Avisar una sola vez por ticker (evita el spam "Sin precio para class19")
      if (!_sinPrecioAvisado.has(señal.ticker)) {
        _sinPrecioAvisado.add(señal.ticker);
        log(`⏳ Sin precio para ${señal.ticker} aún — se reintentará al llegar precios`, "warn");
      }
      return;  // NO marcar verificado, NO borrar → reintenta el próximo ciclo
    }
    outcome = "descartado";
    log(`🗑️ ${id.slice(0,12)}: ${señal.ticker} sin precio tras ${señal._retries} reintentos → descartado`);
  }

  // Marcar como verificado antes de cualquier await
  señal.verificado = true;

  // Actualizar MySQL — persistir el retorno crudo solo en verificaciones reales
  // (descartado no tiene retorno medible). Alimenta la equity curve server-side.
  try {
    const retParaDb = (outcome === "correcto" || outcome === "incorrecto") ? retorno_pct : null;
    const relParaDb = (outcome === "correcto" || outcome === "incorrecto") ? retornoRel : null;
    // Los 6 argumentos, igual que reconciliarPendientesDB(). Faltaban los dos
    // últimos: `labelModo` quedaba en su default null y el COALESCE del panel
    // mandaba la fila a la población "absoluto". Por eso el contador de filas
    // relativas quedó congelado en 616 mientras se verificaban ~200 por día.
    await _actualizarOutcomeReal(id, outcome, precioSalida, retParaDb, relParaDb, labelModo);
  } catch (e) {
    log(`⚠️ actualizarOutcomeReal: ${e.message}`, "warn");
  }

  // Feedback a las redes C++ (class24 MLP + class23 neural)
  //
  // ⚠ FIX — este publish estaba ROTO POR PARTIDA DOBLE:
  //
  //   1) No mandaba `decision_ts`, y class24/class23 hacen
  //        if (outcome < 0 || outcome > 1 || dts <= 0) return;
  //      → el 100% de estos mensajes se descartaba en silencio.
  //
  //   2) Mandaba `outcome: outcomeNumero`, que es retornoAOutcome() — o sea
  //      "CUÁNTO acertó la señal", con el signo ya invertido para los SELL.
  //      Pero las redes usan ese target para aprender DIRECCIÓN de mercado
  //      (class25A lee su score como >0.5 = alcista). Con ese target, un SELL
  //      acertado (precio bajó) enseñaba "1" igual que un BUY acertado
  //      (precio subió): la etiqueta pasaba a ser "acertó" en vez de "subió",
  //      que es casi ortogonal a la dirección.
  //
  //      Si alguien hubiera agregado solo el decision_ts sin mirar esto, las
  //      redes habrían empezado a entrenar con la etiqueta invertida en la
  //      mitad de los casos — peor que el camino muerto.
  //
  // Ahora usa EXACTAMENTE el mismo contrato que reconciliarPendientesDB()
  // (ver más abajo): outcome = DIRECCIÓN real del mercado. El escalado por
  // magnitud viaja aparte, en `outcome_magnitud`, por si algún consumidor
  // futuro lo quiere — pero ningún entrenamiento lo usa como target.
  // ts_entrada puede venir NaN de una restauración con ts_ms corrupto. Sin
  // decision_ts válido las redes descartan el mensaje igual, pero en silencio:
  // mejor saltearlo acá y dejar rastro que mandar un NaN y no enterarse.
  // El guard aplica SOLO al feedback de las redes — el de class25A (más abajo)
  // no usa decision_ts y no debe verse afectado.
  const _dts = Number(señal.ts_entrada);
  const _dtsOk = Number.isFinite(_dts) && _dts > 0;
  if (outcomeNumero !== 0.5 && redisPub && !_dtsOk)
    log(`⚠️ ${id.slice(0,12)}: ts_entrada inválido (${señal.ts_entrada}) — ` +
        `sin feedback a class23/24 para esta señal`, "warn");

  if (outcomeNumero !== 0.5 && redisPub && _dtsOk) {
    try {
      const fbRed = JSON.stringify({
        vector_id:        id,
        // Matcheo por TIEMPO: las redes guardan sus predicciones con timestamp
        // y entrenan las que cayeron en la ventana de esta decisión.
        decision_ts:      _dts,
        // DIRECCIÓN, no "acertó" — y desde ORDEN 1, dirección RELATIVA.
        // Era `retorno_pct > 0`, o sea la dirección del mercado. Con eso las
        // redes aprendían "¿sube el mercado?" mientras el sistema las consulta
        // para "¿este instrumento le gana al promedio?". El objetivo que se
        // entrena tiene que ser el mismo que se mide.
        outcome:          retVeredicto > 0 ? 1 : 0,
        outcome_magnitud: outcomeNumero,             // informativo, no es target
        retorno_pct:      +retorno_pct.toFixed(4),
        retorno_relativo: retornoRel != null ? +retornoRel.toFixed(4) : null,
        label_modo:       labelModo,
        ticker:           señal.ticker,
        tipo:             señal.tipo,
        origen:           "verificacion_memoria",
        ts:               new Date().toISOString()
      });
      // A las DOS redes. Antes solo se publicaba a class24: class23 quedaba
      // fuera del lazo en este camino sin ninguna razón.
      await redisPub.publish(CH_FEEDBACK_MLP,    fbRed);
      await redisPub.publish(CH_FEEDBACK_NEURAL, fbRed);
    } catch (e) {
      log(`⚠️ feedback a redes NO publicado: ${e?.message}`, "warn");
    }
  }

  // Feedback a class25A (pesos de redes + memoria bayesiana).
  // Va en su PROPIO bloque: no usa decision_ts, así que un ts_entrada corrupto
  // no debe dejar a class25A sin outcome.
  if (outcomeNumero !== 0.5 && redisPub) {
    try {
      await redisPub.publish(CH_FEEDBACK_25A, JSON.stringify({
        // CAMBIO 12-sep-2026: ya NO se manda la red dominante.
        //
        // Mandarla activaba la capa 1 de class25A (`actualizarPrefijo` →
        // `actualizar`), que sigue con la regla vieja: lleva al piso de 0,10 a
        // la red nombrada AUNQUE SE HAYA EQUIVOCADO y divide a todas las demás
        // al renormalizar. Medido el viernes 11-sep en rueda: los pesos de
        // class23 y class24 cayeron a 1e-35 en cuatro horas. Simulado a 10 días
        // con una red que acierta 55 % contra quince que aciertan 50 %: con la
        // capa 1 prendida, la separación entre la red buena y el azar es 0,000;
        // con el crédito yendo entero a la capa 2, 0,339.
        //
        // El z-score de `redDominante()` se sigue calculando y logueando —sirve
        // para el diagnóstico—, pero el reparto lo hace la capa 2, que compara a
        // CADA red contra sí misma y sólo redistribuye entre las presentes.
        red:             "",
        acerto:          outcome === "correcto",
        // ORDEN 3 — sin esto, class25A no puede elegir CUÁL snapshot de
        // hash_condicion corresponde a esta decisión. Su caché tenía una sola
        // ranura por hash y la pisaba cada decisión nueva del mismo bucket; con
        // la cola por hash, el decision_ts es lo que desambigua.
        decision_ts:     _dts,
        retorno_pct:     +retorno_pct.toFixed(4),
        outcomeNumero,
        hash_condicion:  señal.hash_condicion,
        ticker:          señal.ticker,
        tipo:            señal.tipo,
        // Paridad de contrato con reconciliarPendientesDB(). class25A reparte
        // crédito entre class21-24 leyendo `direccion_real` (capa 1) y, si no
        // viene, deduciéndola de `senal`+`acerto` (capa 2). Este payload no
        // mandaba NINGUNO de los dos — mandaba `tipo` — así que las dos capas
        // salían con dir=0 y la atribución local no corría nunca.
        senal:           señal.tipo,
        // RELATIVA, igual que la reconciliación (23-nov-2026). Era
        // `retorno_pct > 0`, la dirección ABSOLUTA: la capa 2 de class25A
        // cobraba con «¿subió?» en el 52 % de las verificaciones (las de este
        // camino) y con «¿le ganó al promedio?» en el resto. sim44: dirección
        // equivocada en el 19,8 % de las de este camino.
        direccion_real:  retVeredicto > 0 ? "up" : "down",
        confianza:       señal.confianza,
        ts:              new Date().toISOString()
      }));
      log(`🤖 Feedback class25A: ${señal.tipo} ${señal.ticker} acerto=${outcome === "correcto"} ret=${(retorno_pct*100).toFixed(2)}%`);
    } catch (_) {}
  }

  // Actualizar historial y métricas
  señalesEnCurso.delete(id);
  metricas.pendientes = Math.max(0, metricas.pendientes - 1);

  // "descartado" se persiste en MySQL (para que no se re-restaure como pendiente)
  // pero NO entra al historial: no es un acierto ni un error, no debe mover métricas
  if (outcome !== "pendiente" && outcome !== "descartado") {
    historialDecisiones.push({
      id,
      tipo:         señal.tipo,
      ticker:       señal.ticker,
      confianza:    señal.confianza,
      horizonte:    señal.horizonte,
      outcome,
      outcomeNumero,
      retorno_pct:  +retorno_pct.toFixed(4),
      ts:           Date.now()
    });
    if (historialDecisiones.length > MAX_HISTORIAL)
      historialDecisiones.shift();

    actualizarMetricas();
    await publicarMetricas();
  }
}

// ============================================================
// ACTUALIZAR MÉTRICAS con retornos reales
// ============================================================
function actualizarMetricas() {
  const total     = historialDecisiones.length;
  const correctas = historialDecisiones.filter(d => d.outcome === "correcto").length;

  metricas.total       = total;
  metricas.correctas   = correctas;
  metricas.incorrectas = total - correctas;
  // Pendientes = señales actualmente en tracking (en memoria)
  metricas.pendientes  = señalesEnCurso.size;
  metricas.accuracy_global = total > 0 ? +(correctas / total).toFixed(4) : 0;

  // Rolling 30 días
  const cutoff30d = Date.now() - 30 * 24 * 3600000;
  const recientes = historialDecisiones.filter(d => d.ts >= cutoff30d);
  const ok30d     = recientes.filter(d => d.outcome === "correcto").length;
  metricas.accuracy_30d = recientes.length > 0 ? +(ok30d / recientes.length).toFixed(4) : 0;

  // Precision separada por tipo
  const buys  = historialDecisiones.filter(d => d.tipo === "BUY");
  const sells = historialDecisiones.filter(d => d.tipo === "SELL");
  metricas.precision_buy  = buys.length  > 0 ? +(buys.filter(d => d.outcome === "correcto").length  / buys.length).toFixed(4)  : 0;
  metricas.precision_sell = sells.length > 0 ? +(sells.filter(d => d.outcome === "correcto").length / sells.length).toFixed(4) : 0;

  // P&L real de la estrategia (en % como decimal, ej. 0.023 = 2.3%).
  // IMPORTANTE: una SELL gana cuando el precio BAJA, así que su P&L es -retorno_pct
  // (el retorno crudo del precio). Sin este ajuste de signo, las ventas acertadas
  // restaban al Sharpe/Sortino y lo dejaban sistemáticamente negativo.
  // Solo retornos distintos de 0: las decisiones restauradas de MySQL llegan con
  // retorno_pct=0 (desconocido) y no deben entrar en Sharpe/drawdown. Con menos
  // de 5 retornos reales las métricas de riesgo no son significativas → null.
  const retornos = historialDecisiones
    .filter(d => d.retorno_pct !== 0)
    .map(d => d.tipo === "SELL" ? -d.retorno_pct : d.retorno_pct);

  if (retornos.length >= 5) {
    metricas.retorno_promedio = +(retornos.reduce((a,b) => a+b, 0) / retornos.length).toFixed(4);
    metricas.retorno_std      = +RiskEngine.std(retornos).toFixed(4);
    metricas.mejor_señal      = +Math.max(...retornos).toFixed(4);
    metricas.peor_señal       = +Math.min(...retornos).toFixed(4);
    metricas.sharpe           = RiskEngine.sharpe(retornos);
    metricas.max_drawdown     = RiskEngine.maxDrawdown(retornos);
  } else {
    metricas.retorno_promedio = 0;
    metricas.sharpe           = null;
    metricas.max_drawdown     = null;
  }

  // ── Retorno del DÍA (no acumulado) ──────────────────────────────
  // retorno_promedio de arriba es el promedio por señal de TODO el historial.
  // backtesting_stats guarda una fila por día y miia_chatbot.py compone esas
  // filas como si fueran retornos diarios independientes → la equity curve
  // terminaba siendo N copias del mismo número acumulado, y CAGR/Alpha salían
  // de reanualizar ese único valor (×252). Persistimos además el retorno de
  // HOY para que la curva tenga variación real día a día.
  // null (no 0) cuando no hay muestra suficiente: 0 significaría "medido y
  // dio cero", y compondría la curva con un día plano inventado.
  const inicioHoy = new Date();
  inicioHoy.setHours(0, 0, 0, 0);
  const retornosHoy = historialDecisiones
    .filter(d => d.ts >= inicioHoy.getTime() && d.retorno_pct !== 0)
    .map(d => d.tipo === "SELL" ? -d.retorno_pct : d.retorno_pct);
  metricas.retorno_dia = retornosHoy.length >= 5
    ? +(retornosHoy.reduce((a,b) => a+b, 0) / retornosHoy.length).toFixed(6)
    : null;
  metricas.muestras_dia = retornosHoy.length;

  metricas.ultima_actualizacion = new Date().toISOString();

  log(`📊 Precisión=${(metricas.accuracy_global*100).toFixed(1)}% | ` +
      `30d=${(metricas.accuracy_30d*100).toFixed(1)}% | ` +
      `BUY=${(metricas.precision_buy*100).toFixed(1)}% SELL=${(metricas.precision_sell*100).toFixed(1)}% | ` +
      `ret_prom=${(metricas.retorno_promedio*100).toFixed(2)}% | ` +
      `sharpe=${metricas.sharpe} | total=${total}`);
}

// ============================================================
// CONTEO GLOBAL — con anti-estampida
// ============================================================
// El agregado de cognitive_decisions no tiene WHERE: cuatro SUM sobre las
// 186.977 filas de la tabla, escaneo completo cada vez.
//
// publicarMetricas() se llama desde cuatro lugares, y dos son POR EVENTO: en
// cada señal nueva (más abajo, ~línea 265) y en cada verificación (~654). Con
// ~10.500 decisiones diarias y lotes de reconciliación de hasta 270
// verificaciones seguidas, eso son cientos de escaneos completos disparados
// más rápido de lo que cada uno tarda — se apilan.
//
// Medido el 22-ago-2026 con el vigía: CINCO copias simultáneas de esta misma
// query, mysqld al 382%. Es exactamente la estampida que ORDEN 2 ya había
// arreglado en `_marketRet`, reapareciendo en otra consulta.
//
// Dos capas, como allá:
//   · TTL — son contadores acumulados sobre 187 mil filas; que tengan 30
//     segundos de antigüedad no cambia nada en el dashboard.
//   · Promesa compartida — si ya hay una consulta en vuelo, los demás
//     llamantes esperan ESA en vez de lanzar la suya.
//
// Si la query falla se devuelve el último valor conocido en vez de ceros:
// un cero transitorio haría que el panel muestre "0 decisiones" y que los
// Math.max() de abajo pisen los contadores en memoria.
const CONTEO_TTL_MS = 30_000;
let _conteoCache   = { ts: 0, datos: null };
let _conteoEnVuelo = null;

async function _conteoGlobal() {
  const ahora = Date.now();
  if (_conteoCache.datos && ahora - _conteoCache.ts < CONTEO_TTL_MS)
    return _conteoCache.datos;
  if (_conteoEnVuelo) return _conteoEnVuelo;

  _conteoEnVuelo = (async () => {
    try {
      const rows = await _sql(`
        SELECT COUNT(*) AS total,
               SUM(outcome_real='correcto')  AS correctas,
               -- ── backtesting_stats INFLADO (visible en la web hasta el 13-sep) ──
               -- El panel mostraba ~97 % de acierto. No era un error de calculo:
               -- guardarBacktestingStats recibia correctas del conteo HISTORICO
               -- de la base y incorrectas del contador EN MEMORIA, que arranca
               -- en cero con cada reinicio del proceso. El cociente comparaba
               -- meses de aciertos contra las horas de errores desde el ultimo
               -- arranque. Ahora los dos salen de la misma consulta y de la misma
               -- poblacion.
               SUM(outcome_real='incorrecto') AS incorrectas,
               -- Verificadas = ya tienen resultado real (correcto|incorrecto). La
               -- precisión debe dividirse por ESTAS, no por el total: el total
               -- incluye pendientes, HOLD y descartadas → hundía el % a ~2%.
               SUM(outcome_real IN ('correcto','incorrecto')) AS verificadas,
               -- Pendientes: solo BUY/SELL (las HOLD no se trackean ni verifican,
               -- quedarían 'pendiente' para siempre inflando el contador)
               SUM(outcome_real='pendiente' AND senal IN ('BUY','SELL')) AS pendientes
        FROM cognitive_decisions
        -- Las SOMBRA nunca se emitieron: son SELL que el gate de class25B
        -- suprimio. Contarlas como salida del sistema es contar lo que el
        -- sistema decidio NO hacer. Ademas /api/backtesting/professional las
        -- excluye, asi que sin este filtro los dos numeros no reconcilian y no
        -- hay forma de saber cual esta mal.
        --
        -- (temperatura IS NULL OR temperatura <> 'shadow') y no
        -- COALESCE(temperatura,'') <> 'shadow': son equivalentes —un NULL
        -- nunca iguala a 'shadow'— pero envolver la columna en una funcion
        -- anula cualquier indice.
        WHERE (temperatura IS NULL OR temperatura <> 'shadow')
        LIMIT 1
      `, []);
      const row = Array.isArray(rows) ? rows[0] : rows?.recordset?.[0];
      const datos = {
        total:       parseInt(row?.total       || 0),
        correctas:   parseInt(row?.correctas   || 0),
        incorrectas: parseInt(row?.incorrectas || 0),
        verificadas: parseInt(row?.verificadas || 0),
        pendientes:  parseInt(row?.pendientes  || 0),
      };
      _conteoCache = { ts: Date.now(), datos };
      return datos;
    } catch (_) {
      return _conteoCache.datos
          || { total: 0, correctas: 0, incorrectas: 0, verificadas: 0, pendientes: 0 };
    } finally {
      _conteoEnVuelo = null;
    }
  })();
  return _conteoEnVuelo;
}

// ============================================================
// PUBLICAR MÉTRICAS
// ============================================================
async function publicarMetricas() {
  if (!redisPub) return;

  // Obtener total real desde la DB (incluye sesiones anteriores)
  const _c = await _conteoGlobal();
  const totalDB       = _c.total;
  const correctasDB   = _c.correctas;
  const incorrectasDB = _c.incorrectas;
  const verificadasDB = _c.verificadas;
  const pendientesDB  = _c.pendientes;

  // Usar el mayor entre memoria e histórico DB
  const totalFinal     = Math.max(metricas.total, totalDB);        // señales generadas (display)
  const correctasFinal = Math.max(metricas.correctas, correctasDB);
  // El par del de arriba. Sin esto, backtesting_stats guardaba `correctas` del
  // histórico y `incorrectas` sólo de memoria: el panel mostraba ~97 % de
  // acierto porque comparaba meses contra horas.
  const incorrectasFinal = Math.max(metricas.incorrectas, incorrectasDB);
  const pendientesFinal= Math.max(metricas.pendientes, pendientesDB, señalesEnCurso.size);
  // Precisión = aciertos / VERIFICADAS (no sobre el total, que incluye pendientes,
  // HOLD y descartadas). metricas.total en memoria ya es el conteo de verificadas.
  const verificadasFinal = Math.max(metricas.total, verificadasDB);
  const accFinal       = verificadasFinal > 0 ? +(correctasFinal / verificadasFinal).toFixed(4) : 0;

  const payload = {
    source: "class43", type: "metrics",
    ...metricas,
    total:          totalFinal,
    correctas:      correctasFinal,
    // También en el payload de Redis: el dashboard y class18 leen de acá, y
    // servirles `correctas` histórica contra `incorrectas` de memoria es el
    // mismo 97 % por otro canal.
    incorrectas:    incorrectasFinal,
    pendientes:     pendientesFinal,
    accuracy_global: accFinal,
    señales_activas: señalesEnCurso.size,
    ts: new Date().toISOString()
  };
  try {
    await redisPub.publish(CH_OUTPUT, JSON.stringify(payload));
    await redisPub.publish(CH_UI, JSON.stringify({
      type:             "backtesting",
      accuracy_global:  accFinal,
      accuracy_30d:     metricas.accuracy_30d,
      precision_buy:    metricas.precision_buy,
      precision_sell:   metricas.precision_sell,
      retorno_promedio: metricas.retorno_promedio,
      sharpe:           metricas.sharpe,
      total:            totalFinal,
      pendientes:       pendientesFinal,
      señales_activas:  señalesEnCurso.size,
      ts:               payload.ts
    }));
    // Motor vectorial: ahora incluye retorno real
    await redisPub.publish("class18_ingest", JSON.stringify({
      source:           "class43",
      type:             "validation_metrics",
      accuracy:         metricas.accuracy_global,
      sharpe:           metricas.sharpe,
      retorno_promedio: metricas.retorno_promedio,
      precision_buy:    metricas.precision_buy,
      precision_sell:   metricas.precision_sell,
      total:            metricas.total,
      ts:               payload.ts
    }));
    // Persistir estadísticas en MySQL (acumulo histórico aunque reinicie)
    _guardarStats({
      total:          totalFinal,
      correctas:      correctasFinal,
      incorrectas:    incorrectasFinal,
      pendientes:     pendientesFinal,
      accuracy_global:  accFinal,
      accuracy_30d:     metricas.accuracy_30d,
      precision_buy:    metricas.precision_buy,
      precision_sell:   metricas.precision_sell,
      retorno_promedio: metricas.retorno_promedio,
      // Retorno de HOY: es el que compone la equity curve en el panel
      // Backtesting Profesional. retorno_promedio queda como acumulado para
      // los consumidores que ya lo leían (chat, Excel, dashboard).
      retorno_dia:      metricas.retorno_dia,
      muestras_dia:     metricas.muestras_dia,
      sharpe:           metricas.sharpe,
      max_drawdown:     metricas.max_drawdown,
    }).catch(() => {});

  } catch (e) {
    log(`⚠️ publicarMetricas: ${e.message}`, "warn");
  }
}

// ============================================================
// RESOLVER DE PRECIO COMPUESTO
// Para señales GENERAL o classN (nombres internos de class25A) que no tienen
// un precio de mercado real, usa el promedio de todos los ETFs como proxy.
// Esto permite verificar outcomes para señales de mercado agregadas.
// ============================================================
// ── Guardia de frescura (10-sep-2026) ──────────────────────────────────────
// `preciosActuales` es un Map en memoria SIN caducidad: devuelve el último
// precio que llegó, tenga un minuto o tres días. Y class7 —que lo alimenta—
// NO está en CRITICAL_LABELS, así que si muere queda muerto en silencio.
// Sin esta guardia, class43 seguiría verificando contra un precio congelado
// para siempre, y el único síntoma sería que `verificadas` deja de tener
// sentido: exactamente la familia de defectos de ORDEN 1-3.
//
// NO bloquea a propósito. Devolver null acá dispararía MAX_RETRIES_SIN_PRECIO
// y apagaría la verificación entera — el remedio sería peor. Avisa y expone la
// edad en `edad_ms`; bloquear es una decisión aparte y con su propia medición.
const PRECIO_EDAD_MAX_MS = 30 * 60_000;   // 30 min = 2× el umbral de class48 para class7
let _avisosPrecioViejo = 0;

function _chequearFrescura(p, ticker) {
  if (!p || !p.ts) return p;
  const edad = Date.now() - p.ts;
  if (edad > PRECIO_EDAD_MAX_MS) {
    // Rate-limit: con ~4.000 verificaciones por ciclo, loguear todas inundaría
    // un log que ya acumula GB. El primero y después 1 de cada 100.
    const n = ++_avisosPrecioViejo;
    if (n === 1 || n % 100 === 0)
      log(`⚠️ Precio de ${ticker} tiene ${Math.round(edad / 60000)} min ` +
          `(máx ${PRECIO_EDAD_MAX_MS / 60000}) — ¿class7 sigue vivo? ` +
          `[${n} acumulados]`, "warn");
  }
  return { ...p, edad_ms: edad };
}

function _getPrecioCompuesto(ticker) {
  // 1. Búsqueda directa (ETF real: XLK, XLF, XLV, etc.)
  const direct = preciosActuales.get(ticker) ?? preciosActuales.get((ticker || "").toUpperCase());
  if (direct) return _chequearFrescura(direct, ticker);

  // 2. Señal de mercado agregado → promedio ponderado de todos los ETFs.
  // Prefijo classN (sin $): cubre también "class18_vectorial" y variantes —
  // antes no matcheaba, quedaba sin precio y spameaba "Sin precio para..."
  const esAgregado = !ticker || ticker === "GENERAL" || /^class\d+/i.test(ticker);
  if (esAgregado) {
    // Misma lista que UNIVERSO_MKT: eran dos copias a mano del mismo universo,
    // en el mismo archivo, que podían diferir sin que nadie lo viera.
    const etfKeys = UNIVERSO_MKT;
    const available = etfKeys
      .map(k => preciosActuales.get(k))
      .filter(p => p && p.precio > 0);

    if (available.length === 0) {
      // Fallback: cualquier precio disponible
      const all = [...preciosActuales.values()].filter(p => p.precio > 0);
      if (all.length === 0) return null;
      const avg = all.reduce((s, p) => s + p.precio, 0) / all.length;
      return _chequearFrescura({ precio: avg, ts: Math.max(...all.map(p => p.ts)), composite: true, n: all.length }, ticker);
    }

    const avg    = available.reduce((s, p) => s + p.precio, 0) / available.length;
    const ts     = Math.max(...available.map(p => p.ts));
    // change_pct compuesto: promedio de cambios de todos los ETFs (% directo)
    const chgArr = available.map(p => p.change_pct).filter(c => c != null);
    const avgChg = chgArr.length ? chgArr.reduce((s, c) => s + parseFloat(c), 0) / chgArr.length : null;
    log(`📊 Precio compuesto "${ticker}": $${avg.toFixed(2)} chg:${avgChg != null ? avgChg.toFixed(2)+"%" : "–"} (${available.length} ETFs)`);
    return _chequearFrescura({ precio: avg, ts, composite: true, n: available.length, change_pct: avgChg }, ticker);
  }

  return null;
}

// ============================================================
// PRECIOS DE class7_output — con timestamp para verificación reactiva
// ============================================================
function procesarPrecioMercado(raw) {
  try {
    const data  = JSON.parse(raw);
    const ahora = Date.now();

    const registrar = (ticker, precio, change_pct = null) => {
      if (!ticker) return;
      const p = parseFloat(precio);
      if (isFinite(p) && p > 0) {
        const entry = { precio: p, ts: ahora, change_pct };
        preciosActuales.set(ticker, entry);
        preciosActuales.set(ticker.toUpperCase(), entry);
      }
    };

    // Formato 1: {precios: {XLK: 180.88, ...}}
    const precios = data?.precios ?? data?.data?.precios;
    if (precios && typeof precios === "object" && !Array.isArray(precios))
      for (const [t, p] of Object.entries(precios)) registrar(t, p);

    // Formato 2: campo ticker + precio individual
    if (data?.ticker) registrar(data.ticker, data.precio ?? data.close ?? data.price, data.change_pct ?? null);
    if (data?.symbol) registrar(data.symbol, data.precio ?? data.close ?? data.price, data.change_pct ?? null);

    // Formato 3: array sectors de class7 → extraer ETF + precio + change_pct
    if (Array.isArray(data?.sectors)) {
      for (const s of data.sectors) {
        const t   = s.etf || s.ticker || s.symbol;
        const p   = s.precio ?? s.price ?? s.close ?? s.last;
        const chg = s.change_pct ?? s.change ?? null;
        if (t && p) registrar(t, p, chg);
      }
    }

    // Llegaron precios frescos → permitir re-avisar si vuelve a faltar alguno
    if (_sinPrecioAvisado.size > 0) _sinPrecioAvisado.clear();

    // Verificación REACTIVA: revisar señales vencidas ahora que llegó precio fresco
    _verificarSenalesVencidas(ahora);
  } catch (_) {}
}

// Procesar precios desde class44_output (fuente más confiable: Yahoo Finance directo)
function procesarPrecioLSTM(raw) {
  try {
    const data  = JSON.parse(raw);
    const ahora = Date.now();
    const t = data?.ticker;
    const p = data?.precio_actual ?? data?.precio ?? data?.price;
    if (t && p) {
      const pf = parseFloat(p);
      if (isFinite(pf) && pf > 0) {
        preciosActuales.set(t, { precio: pf, ts: ahora });
        preciosActuales.set(t.toUpperCase(), { precio: pf, ts: ahora });
        log(`💰 Precio class44: ${t} = $${pf.toFixed(2)}`);
        _verificarSenalesVencidas(ahora);
      }
    }
  } catch (_) {}
}

// Helper: verificar señales vencidas con precios disponibles
function _verificarSenalesVencidas(ahora) {
  const hayPrecios = preciosActuales.size > 0;
  for (const [id, señal] of señalesEnCurso.entries()) {
    if (señal.verificado) continue;
    if (ahora < señal.ts_vencimiento) continue;
    // Ticker real → esperar SU precio. Agregado (GENERAL/classN) → basta con
    // que haya algún precio cargado (se resuelve por promedio compuesto).
    const esAgregado = !señal.ticker || señal.ticker === "GENERAL" || /^class\d+/i.test(señal.ticker);
    if (preciosActuales.has(señal.ticker) || (esAgregado && hayPrecios)) {
      verificarOutcome(id).catch(() => {});
    }
  }
}

// ============================================================
// EXCEL — incluye retornos reales y nuevas métricas
// ============================================================
async function exportarExcel() {
  try {
    const wb  = new ExcelJS.Workbook();

    // Hoja 1: Resumen
    const ws1 = wb.addWorksheet("Precisión Global");
    ws1.columns = [
      { header: "Total señales",      key: "total",       width: 16 },
      { header: "Correctas",          key: "ok",          width: 12 },
      { header: "Incorrectas",        key: "fail",        width: 14 },
      { header: "Precisión global",   key: "acc",         width: 18 },
      { header: "Precisión 30d",      key: "acc30",       width: 16 },
      { header: "Precisión BUY",      key: "pBuy",        width: 14 },
      { header: "Precisión SELL",     key: "pSell",       width: 14 },
      { header: "Retorno promedio %", key: "retProm",     width: 20 },
      { header: "Retorno std %",      key: "retStd",      width: 16 },
      { header: "Mejor señal %",      key: "mejorSenal",  width: 14 },
      { header: "Peor señal %",       key: "peorSenal",   width: 14 },
      { header: "Sharpe",             key: "sharpe",      width: 10 },
      { header: "Max Drawdown",       key: "maxDD",       width: 14 },
      { header: "Pendientes",         key: "pend",        width: 12 },
      { header: "Actualizado",        key: "ts",          width: 25 },
    ];
    ws1.addRow({
      total:      metricas.total,
      ok:         metricas.correctas,
      fail:       metricas.incorrectas,
      acc:        metricas.accuracy_global,
      acc30:      metricas.accuracy_30d,
      pBuy:       metricas.precision_buy,
      pSell:      metricas.precision_sell,
      retProm:    +(metricas.retorno_promedio * 100).toFixed(3),
      retStd:     +(metricas.retorno_std * 100).toFixed(3),
      mejorSenal: +(metricas.mejor_señal * 100).toFixed(3),
      peorSenal:  +(metricas.peor_señal * 100).toFixed(3),
      sharpe:     metricas.sharpe,
      maxDD:      metricas.max_drawdown,
      pend:       metricas.pendientes,
      ts:         metricas.ultima_actualizacion ?? ""
    });

    // Hoja 2: Historial con retornos reales
    const ws2 = wb.addWorksheet("Historial Detallado");
    ws2.columns = [
      { header: "ID",           key: "id",         width: 20 },
      { header: "Tipo",         key: "tipo",        width: 8  },
      { header: "Ticker",       key: "ticker",      width: 12 },
      { header: "Confianza",    key: "conf",        width: 12 },
      { header: "Horizonte",    key: "horizonte",   width: 12 },
      { header: "Outcome",      key: "outcome",     width: 12 },
      { header: "Retorno %",    key: "retorno",     width: 12 },
      { header: "Outcome MLP",  key: "outNum",      width: 14 },
    ];
    for (const d of historialDecisiones.slice(-1000)) {
      ws2.addRow({
        id:       String(d.id ?? "").slice(0, 20),
        tipo:     d.tipo,
        ticker:   d.ticker,
        conf:     d.confianza,
        horizonte: d.horizonte,
        outcome:  d.outcome,
        retorno:  +(d.retorno_pct * 100).toFixed(3),
        outNum:   d.outcomeNumero
      });
    }

    // Hoja 3: Análisis por confianza
    const ws3 = wb.addWorksheet("Análisis Confianza");
    ws3.columns = [
      { header: "Banda confianza", key: "banda",   width: 18 },
      { header: "Total",           key: "total",   width: 10 },
      { header: "Correctas",       key: "ok",      width: 12 },
      { header: "Precisión %",     key: "prec",    width: 14 },
      { header: "Retorno prom %",  key: "retProm", width: 16 },
    ];
    const bandas = [[0.60,0.65],[0.65,0.70],[0.70,0.75],[0.75,0.80],[0.80,0.85],[0.85,1.00]];
    for (const [lo, hi] of bandas) {
      const grupo = historialDecisiones.filter(d => d.confianza >= lo && d.confianza < hi);
      if (grupo.length === 0) continue;
      const okG     = grupo.filter(d => d.outcome === "correcto").length;
      const retProm = grupo.reduce((a, d) => a + d.retorno_pct, 0) / grupo.length;
      ws3.addRow({
        banda:   `${(lo*100).toFixed(0)}%-${(hi*100).toFixed(0)}%`,
        total:   grupo.length,
        ok:      okG,
        prec:    +((okG / grupo.length * 100).toFixed(1)),
        retProm: +(retProm * 100).toFixed(3)
      });
    }

    await wb.xlsx.writeFile(path.join(metricsDir, "MIIA_backtesting.xlsx"));
    log("📊 Excel exportado con retornos reales");
  } catch (e) {
    log(`⚠️ exportarExcel: ${e.message}`, "warn");
  }
}

// ============================================================
// HEALTH SERVER
// ============================================================
function startHealthServer(port = 9200) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status:           "ok",
        accuracy_global:  metricas.accuracy_global,
        accuracy_30d:     metricas.accuracy_30d,
        precision_buy:    metricas.precision_buy,
        precision_sell:   metricas.precision_sell,
        retorno_promedio: metricas.retorno_promedio,
        sharpe:           metricas.sharpe,
        total_señales:    metricas.total,
        pendientes:       metricas.pendientes,
        uptime_s:         Math.floor(process.uptime()),
        ts:               new Date().toISOString()
      }));
    } else { res.writeHead(404); res.end("not found"); }
  });
  server.listen(port, () => log(`🏥 Health en http://localhost:${port}/health`));
  return server;
}

// ── Backup / Restore ───────────────────────────────────────
async function backupJSON() {
  try {
    await fs.writeFile(
      path.join(metricsDir, "class43_backup.json"),
      JSON.stringify({ metricas, historial: historialDecisiones.slice(-1000), ts: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (_) {}
}

async function cargarHistorialPrevio() {
  // ── Paso 1: JSON en disco (rápido, último backup) ─────────
  let jsonDecisiones = 0;
  try {
    const raw  = await fs.readFile(path.join(metricsDir, "class43_backup.json"), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.historial) && data.historial.length > 0) {
      historialDecisiones.push(...data.historial.slice(-1000));
      jsonDecisiones = historialDecisiones.length;
      log(`📂 Backup JSON cargado: ${jsonDecisiones} decisiones`);
    }
  } catch (_) {}

  // ── Paso 2: MySQL — decisiones verificadas ────────────────
  // Carga las que no estén ya en el historial cargado desde JSON
  try {
    const idsEnMemoria = new Set(historialDecisiones.map(d => d.id));
    const _qr2 = await _sql(`
      SELECT id, senal AS tipo, ticker, confianza,
             outcome_real AS outcome,
             UNIX_TIMESTAMP(ts_decision)*1000 AS ts_ms
      FROM cognitive_decisions
      WHERE outcome_real IN ('correcto','incorrecto')
      ORDER BY ts_decision DESC
      LIMIT 2000
    `, []);
    const rows = (Array.isArray(_qr2) ? _qr2 : (_qr2?.recordset ?? [])) || [];

    let nuevas = 0;
    for (const r of rows) {
      if (idsEnMemoria.has(r.id)) continue;
      historialDecisiones.push({
        id:          r.id,
        tipo:        r.tipo,
        ticker:      r.ticker || "GENERAL",
        confianza:   parseFloat(r.confianza || 0),
        outcome:     r.outcome,
        retorno_pct: 0,  // no disponible desde este registro histórico
        ts:          Number(r.ts_ms),
      });
      nuevas++;
    }
    if (nuevas > 0) log(`📊 MySQL verificadas cargadas: +${nuevas} (total ${historialDecisiones.length})`);
  } catch (e) {
    log(`⚠️ cargarHistorialPrevio MySQL verificadas: ${e.message}`, "warn");
  }

  // ── Paso 3: MySQL — señales PENDIENTES → reconstruir señalesEnCurso ──
  // Este es el bug principal: al reiniciar se perdían todas las señales en tracking
  try {
    const _qr3 = await _sql(`
      SELECT id, senal AS tipo, ticker, confianza,
             horizonte_horas, precio_entrada,
             UNIX_TIMESTAMP(ts_decision)*1000 AS ts_ms
      FROM cognitive_decisions
      WHERE outcome_real = 'pendiente'
        AND ts_decision > DATE_SUB(NOW(), INTERVAL 7 DAY)
        -- SOMBRA fuera del tracking en memoria: son SELL que el gate de class25B
        -- SUPRIMIÓ (nunca se emitieron). Si se restauraran acá, al verificarse
        -- entrarían a historialDecisiones → accuracy/backtesting_stats/feedback
        -- como si fueran decisiones reales. Las verifica SOLO la reconciliación
        -- DB (reconciliarPendientesDB), que escribe el outcome sin tocar métricas.
        AND (temperatura IS NULL OR temperatura <> 'shadow')
      ORDER BY ts_decision DESC
      LIMIT 500
    `, []);
    const rows = (Array.isArray(_qr3) ? _qr3 : (_qr3?.recordset ?? [])) || [];

    let restauradas = 0;
    for (const r of rows) {
      if (señalesEnCurso.has(String(r.id))) continue;
      // HOLD nunca se trackea (procesarSeñal las descarta) — restaurarlas hacía
      // que se verificaran con lógica de SELL y salieran siempre "incorrecto"
      if (r.tipo === "HOLD") continue;
      // horizonte_horas es int (ej: 24) → convertir a clave de HORIZONTE_MS ("24h")
      const horas       = Number(r.horizonte_horas || 24);
      const horizonte   = `${horas}h`;
      const tsEntrada   = Number(r.ts_ms);
      const horizonteMs = HORIZONTE_MS[horizonte] ?? HORIZONTE_MS["24h"];
      // precio_entrada restaurado desde MySQL: la señal sobrevive reinicios
      // y puede verificarse honestamente contra el precio real de salida.
      // (Las señales viejas guardadas antes de esta columna llegan con null
      // y se descartan al vencer — comportamiento honesto ya existente.)
      const pEntradaDB = r.precio_entrada != null ? parseFloat(r.precio_entrada) : null;
      señalesEnCurso.set(String(r.id), {
        id:             String(r.id),
        tipo:           r.tipo,
        ticker:         r.ticker || "GENERAL",
        confianza:      parseFloat(r.confianza || 0),
        horizonte,
        precio_entrada: pEntradaDB,
        precio_stop:    pEntradaDB ? pEntradaDB * (r.tipo === "BUY" ? 0.97 : 1.03) : null,
        stop_loss:      0.03,   // default conservador
        ts_entrada:     tsEntrada,
        ts_vencimiento: tsEntrada + horizonteMs,
        hash_condicion: null,
        red_dominante:  "",
        verificado:     false,
      });
      metricas.pendientes++;
      restauradas++;
    }
    if (restauradas > 0)
      log(`⏱️ ${restauradas} señales pendientes restauradas desde MySQL`);
  } catch (e) {
    log(`⚠️ cargarHistorialPrevio MySQL pendientes: ${e.message}`, "warn");
  }

  // ── Calcular métricas con todo lo cargado ──────────────────
  if (historialDecisiones.length > 0 || señalesEnCurso.size > 0) {
    actualizarMetricas();
    log(`📂 Estado restaurado: ${historialDecisiones.length} historial | ${señalesEnCurso.size} pendientes`);
  } else {
    log(`📂 Historial cargado: 0 decisiones (primera ejecución)`);
  }

  // ── Verificación diferida de señales vencidas ─────────────
  // Se ejecuta 8 segundos después del arranque para dar tiempo a que
  // lleguen los primeros precios de class7/class44 (necesarios para
  // _getPrecioCompuesto). Esto resuelve señales GENERAL/classN que
  // quedaron stuck sin precio de entrada.
  setTimeout(() => {
    const ahora = Date.now();
    let vencidas = 0;
    for (const [id, señal] of señalesEnCurso) {
      if (!señal.verificado && señal.ts_vencimiento < ahora) {
        vencidas++;
        verificarOutcome(id).catch(() => {});
      }
    }
    if (vencidas > 0)
      log(`⏰ Verificación retroactiva: ${vencidas} señales vencidas en cola`);
  }, 8000);
}

// ============================================================
// ARRANQUE PRINCIPAL
// ============================================================
// ══ Reconciliación de pendientes — SACADA DE bootstrap() el 21-sep-2026 ══
//
// Estas dos funciones vivían como closures adentro de bootstrap(), donde
// ninguna prueba las podía alcanzar. Y son el camino que hace el ~95 % de las
// verificaciones (el de memoria «casi no corre»), así que todo lo que se
// arregle acá —el defecto 4, la duplicación de filas, el bloqueo de cabeza de
// cola— no se podía probar sin levantar el sistema entero.
//
// El movimiento es mecánico: no usaban NADA del alcance de bootstrap (que no
// declara ninguna variable antes de este punto), sólo símbolos de módulo.
// Ahora `_test` las expone y `sim8` captura el feedback que publican.

const _precioHistorico = async (ticker, tsDecision, horizonteH) => {
  try {
    const r = await _sql(
      `SELECT precio FROM precios
       WHERE ticker = ? AND precio > 0
         AND ts <= DATE_ADD(?, INTERVAL ? HOUR)
         AND DATE_ADD(?, INTERVAL ? HOUR) <= NOW(3)
       ORDER BY ts DESC LIMIT 1`,
      [ticker, tsDecision, horizonteH, tsDecision, horizonteH]
    );
    const p = r?.recordset?.[0]?.precio;
    return p != null ? Number(p) : null;
  } catch { return null; }
};
// _marketRet() y _marketRetCache se movieron a SCOPE DE MÓDULO (ver arriba de
// verificarOutcome). Estar acá adentro era lo que impedía que el camino en
// memoria juzgara con el retorno relativo. Las llamadas de este bloque siguen
// funcionando sin cambios: resuelven por alcance léxico.
const reconciliarPendientesDB = async () => {
  try {
    const pend = await _obtenerPendientes(720);
    if (!pend.length) return;
    const ahora = Date.now();
    let verif = 0, descart = 0, fbEnviados = 0, fbFallidos = 0, sinHash = 0, reconstruidas = 0;
    let sinAcierto = 0;   // señales que no son BUY ni SELL (ver defecto 4)
    for (const d of pend) {
      const idRef      = d.external_id || String(d.id);
      const horizonteH = Number(d.horizonte) || 48;
      const esMercado  = /^class/i.test(d.ticker || "") || d.ticker === "GENERAL";
      let retorno = null, precioSalida = null;
      // ── ORDEN 1: retorno RELATIVO ────────────────────────────────────────
      // `retorno`    = lo que hizo el precio del instrumento (P&L, equity curve)
      // `retornoRel` = retorno − promedio de los 13 (lo que juzga el acierto)
      //
      // El acierto pasa a medirse contra el relativo porque el benchmark del
      // absoluto ("predecir siempre la dirección dominante") acierta ~78% en
      // mercado alcista: superarlo exige acertar las caídas. Contra el
      // promedio de la sección transversal, ese benchmark vale ~50% por
      // construcción, y ahí un edge de 3-5 pp es alcanzable y detectable.
      let retornoRel = null, labelModo = "absoluto";
      if (esMercado) {
        // Señal sin instrumento: no hay relativo posible (sería mercado −
        // mercado = 0). Se sigue verificando contra el absoluto, y queda
        // marcada como "absoluto" para no mezclarla con las nuevas.
        retorno = await _marketRet(d.created_at, horizonteH);
      } else {
        // ── Reconstrucción del precio de entrada ────────────────────────
        // Medido el 17-ago-2026: 28.417 pendientes con ticker REAL y
        // `precio_entrada` en NULL. Sin él, `pEntrada` daba 0, `precioSalida`
        // quedaba null y la fila se saltaba SIN log ni contador.
        //
        // Y como la query pide las 500 más viejas en orden ASC, la
        // reconciliación volvía a agarrar exactamente las mismas cada 15 min
        // y nunca alcanzaba a las 51.000 que venían atrás. Bloqueo de cabeza
        // de cola, silencioso. El descarte a los 7 días lo destraba solo,
        // pero tirando la población relativa que la medición necesita.
        //
        // El precio de entrada SÍ es recuperable: es el último de `precios`
        // para ese ticker en el ts de la decisión. Esto NO es el proxy que se
        // descartó antes (el change_pct compuesto del mercado al momento de
        // verificar): es el precio real del instrumento en el momento real de
        // la decisión, la misma fuente que usa el precio de salida.
        let pEntrada = Number(d.precio_entrada);
        if (!pEntrada) {
          const rec = await _precioHistorico(d.ticker, d.created_at, 0);
          if (rec && rec > 0) { pEntrada = rec; reconstruidas++; }
        }
        precioSalida = pEntrada ? await _precioHistorico(d.ticker, d.created_at, horizonteH) : null;
        if (pEntrada && precioSalida) {
          retorno = (precioSalida - pEntrada) / pEntrada;
          const mkt = await _marketRet(d.created_at, horizonteH);
          if (mkt != null) { retornoRel = retorno - mkt; labelModo = "relativo"; }
        }
      }
      // Contra qué se juzga: el relativo si existe, si no el absoluto.
      const retVeredicto = retornoRel != null ? retornoRel : retorno;
      if (retorno != null) {
        // Retorno ~0 = no medible. Se evalúa sobre el retorno del VEREDICTO:
        // un ticker puede moverse 1% (absoluto ≠ 0) y aun así empatar
        // exactamente con el promedio (relativo = 0) — y ahí tampoco hay
        // nada que confirmar ni refutar sobre habilidad relativa.
        if (Math.abs(retVeredicto) < RET_EPSILON) {
          if (await _actualizarOutcomeReal(idRef, "descartado", null)) descart++;
          continue;
        }
        // DEFECTO 4: la consulta de pendientes ya filtra BUY/SELL, pero si
        // alguna vez deja de hacerlo, esta línea etiquetaría a las HOLD con la
        // regla del SELL en vez de saltearlas. Se verifica acá y no se confía
        // en el filtro de la consulta.
        if (d.senal !== "BUY" && d.senal !== "SELL") { sinAcierto++; continue; }
        const acerto = d.senal === "BUY" ? retVeredicto > 0 : retVeredicto < 0;
        // retorno    → equity curve (P&L crudo del instrumento)
        // retornoRel → lo que juzgó el acierto
        // labelModo  → separa las filas nuevas de las pre-Orden-1
        if (await _actualizarOutcomeReal(idRef, acerto ? "correcto" : "incorrecto",
                                        precioSalida, retorno, retornoRel, labelModo)) {
          verif++;
          // ── Cierre del lazo de aprendizaje ──────────────────────────────
          // Este loop verifica CASI TODO (el camino en memoria casi no corre),
          // pero nunca avisaba el resultado a nadie: la memoria bayesiana de
          // class25A quedó en 0 aciertos sobre miles de condiciones y terminó
          // arrastrando cada señal hacia HOLD. Se EXCLUYEN las sombra: nunca
          // se emitieron, así que no deben enseñarle al ensemble.
          const esSombra = String(d.temperatura || "") === "shadow";
          if (!esSombra && !d.hash_condicion) sinHash++;
          if (!esSombra && d.hash_condicion && redisPub) {
            const fb = JSON.stringify({
              acerto,
              hash_condicion: d.hash_condicion,
              // ORDEN 3 — desambigua qué snapshot de class25A corresponde a
              // esta decisión. Es la MISMA expresión que usa fbRed más abajo:
              // las dos capas tienen que hablar del mismo instante.
              decision_ts:    new Date(d.created_at || d.ts).getTime(),
              decision_id:    idRef,
              hash_decision:  d.external_id || null,
              ticker:         d.ticker,
              senal:          d.senal,
              retorno_pct:      +Number(retorno).toFixed(4),
              retorno_relativo: retornoRel != null ? +Number(retornoRel).toFixed(4) : null,
              label_modo:       labelModo,
              // Dirección REAL, explícita. class25A la necesita para repartir
              // crédito entre class21-24 (capa 1 de atribución); si falta, la
              // deduce de senal+acerto (capa 2). Mandarla acá evita que ambas
              // capas dependan de la misma inferencia.
              // ORDEN 1: "up" significa ahora "le ganó al promedio", no "subió".
              // Es la dirección que efectivamente se está prediciendo.
              direccion_real: retVeredicto > 0 ? "up" : "down",
              origen:         "reconciliacion",
              ts:             new Date().toISOString(),
            });
            // NO silenciar el fallo: si estos publish se pierden, la memoria
            // bayesiana nunca aprende y el síntoma ("a": 0 eterno) sería
            // idéntico al bug que este código vino a arreglar. Se contabilizan
            // y se reportan en el resumen del ciclo.
            try {
              await redisPub.publish(CH_FEEDBACK_25A, fb);  // memoria bayesiana
              await redisPub.publish(CH_FEEDBACK_25B, fb);  // aprendizaje lingüístico
              // Entrenamiento supervisado de las redes C++. Antes solo se
              // publicaba desde verificarOutcome (el camino EN MEMORIA, que
              // "casi no corre"): class24 tiene trainSupervised() pero casi
              // nunca recibía outcomes, así que entrenaba a ciegas con su EMA.
              // La reconciliación hace el 95% de las verificaciones — es acá
              // donde tiene que llegar el feedback.
              const fbRed = JSON.stringify({
                // Matcheo por TIEMPO, no por id: class25A agrega una ventana
                // de muchas predicciones en UNA decisión, así que no hay
                // mapeo 1:1. Las redes guardan sus predicciones con timestamp
                // y entrenan las que cayeron en la ventana de esta decisión.
                decision_ts: new Date(d.created_at || d.ts).getTime(),
                // Target = 1 si el instrumento LE GANÓ AL PROMEDIO de los 13,
                // 0 si no. Antes era "¿subió el mercado?", una etiqueta con
                // 78% de unos: entrenar contra eso hace que la red converja a
                // predecir la prior — que es exactamente lo que se observó
                // (portfolio|32 llegó a ema=0.7893 ≈ base rate en una tarde).
                // La etiqueta relativa está balanceada ~50/50 por
                // construcción, así que la red tiene algo que aprender.
                outcome:     retVeredicto > 0 ? 1 : 0,
                retorno_pct: +Number(retorno).toFixed(4),
                retorno_relativo: retornoRel != null ? +Number(retornoRel).toFixed(4) : null,
                label_modo:  labelModo,
                ticker:      d.ticker,
                origen:      "reconciliacion",
                ts:          new Date().toISOString(),
              });
              await redisPub.publish(CH_FEEDBACK_MLP, fbRed);   // class24 (MLP)
              await redisPub.publish(CH_FEEDBACK_NEURAL, fbRed); // class23
              fbEnviados++;
            } catch (e) {
              fbFallidos++;
              if (fbFallidos === 1) log(`⚠️ feedback NO publicado: ${e?.message}`, "warn");
            }
          }
        }
        continue;
      }
      // No verificable aún: descartar solo si venció hace > 7 días (para no
      // atascar la cola). Si es reciente, sigue pendiente y se reintenta.
      const creado      = new Date(d.created_at || d.ts).getTime();
      const vencidoHace = ahora - (creado + horizonteH * 3600000);
      if (vencidoHace > 7 * 24 * 3600000) {
        if (await _actualizarOutcomeReal(idRef, "descartado", null)) descart++;
      }
    }
    if (verif || descart || reconstruidas)
      log(`🔄 Reconciliación DB: ${verif} verificadas, ${descart} descartadas ` +
          (reconstruidas ? `, ${reconstruidas} con precio_entrada reconstruido` : "") +
          `(de ${pend.length} pendientes) | feedback: ${fbEnviados} enviados` +
          (fbFallidos ? `, ${fbFallidos} FALLIDOS` : "") +
          (sinHash    ? `, ${sinHash} sin hash_condicion (decisiones previas al fix)` : "") +
          (sinAcierto ? `, ${sinAcierto} SIN ACIERTO DEFINIDO (no son BUY ni SELL)` : ""));
  } catch (e) { log(`⚠️ reconciliarPendientesDB: ${e.message}`, "warn"); }
};


async function bootstrap() {
  log("=== class43 Motor de Backtesting v2.1 — Retornos Reales ===");
  log(`📡 Escucha: ${CH_CLASS25_OUTPUT}, ${CH_CLASS25_BT}, ${CH_MARKET_PRICES}`);
  log(`📤 Publica: ${CH_OUTPUT}, ${CH_FEEDBACK_MLP}, ${CH_FEEDBACK_25A}, ${CH_UI}`);

  await cargarHistorialPrevio();

  redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  redisSub.on("error", e => log(`RedisSub: ${e.message}`, "warn"));
  redisPub.on("error", e => log(`RedisPub: ${e.message}`, "warn"));
  redisSub.on("connect", () => log("✅ Redis sub conectado"));
  redisPub.on("connect", () => {
    log("✅ Redis pub conectado");
    // Publicar métricas inmediatamente para que el dashboard
    // muestre los valores restaurados desde MySQL al arrancar
    setTimeout(() => publicarMetricas().catch(() => {}), 1500);
  });

  await redisSub.subscribe(CH_CLASS25_OUTPUT, CH_CLASS25_BT, CH_MARKET_PRICES, CH_LSTM_PRICES);
  log(`📡 Escucha: +${CH_LSTM_PRICES} (precios reales de ETFs)`);

  redisSub.on("message", async (ch, raw) => {
    try {
      if (ch === CH_CLASS25_OUTPUT || ch === CH_CLASS25_BT)
        await procesarSeñal(raw);
      else if (ch === CH_MARKET_PRICES)
        procesarPrecioMercado(raw);
      else if (ch === CH_LSTM_PRICES)
        procesarPrecioLSTM(raw);   // precios reales de ETFs desde class44
    } catch (e) {
      log(`⚠️ handler ${ch}: ${e.message}`, "warn");
    }
  });

  // Métricas + backup cada 5 min
  setInterval(async () => {
    actualizarMetricas();
    await publicarMetricas();
    await backupJSON();
  }, 5 * 60 * 1000);

  // Excel cada hora (no cada 5 min — reduce I/O)
  setInterval(() => exportarExcel(), 60 * 60 * 1000);
  exportarExcel(); // primer export al arrancar

  // Limpieza de señales muy vencidas sin precio (gracia de 30 min)
  setInterval(() => {
    const ahora = Date.now();
    for (const [id, señal] of señalesEnCurso.entries()) {
      if (!señal.verificado && ahora >= señal.ts_vencimiento + 30 * 60 * 1000) {
        log(`⏰ Verificación forzada (sin precio 30min): ${id.slice(0,12)}`);
        verificarOutcome(id).catch(() => {});
      }
    }
  }, 15 * 60 * 1000);

  // ── Reconciliación de pendientes desde la DB ─────────────────
  // FIX: obtenerDecisionesPendientes estaba DEFINIDA pero NUNCA se llamaba, así
  // que las decisiones de la DB solo se verificaban si class43 las tenía en
  // memoria (se pierden en cada reinicio) → el 95% quedaba "pendiente" para
  // siempre. Este loop recarga las pendientes y las verifica contra el precio
  // HISTÓRICO al horizonte (calculado en SQL para evitar líos de timezone; usar
  // el precio ACTUAL sesgaría todo en un mercado alcista).
  setTimeout(() => reconciliarPendientesDB().catch(() => {}), 60_000);
  setInterval(() => reconciliarPendientesDB().catch(() => {}), 15 * 60 * 1000);

  // Heartbeat
  setInterval(() => {
    log(`❤️  total=${metricas.total} acc=${(metricas.accuracy_global*100).toFixed(1)}% ` +
        `ret=${(metricas.retorno_promedio*100).toFixed(2)}% sharpe=${metricas.sharpe} ` +
        `pendientes=${metricas.pendientes}`);
  }, 60 * 1000).unref();

  // Reparto de crédito: la medición directa del arreglo del 10-sep.
  // `por z` son las decisiones que SÍ atribuyeron a una red concreta; el resto
  // cae a la capa 2 de class25A (snapshot). Si `por z` se queda en 0 con las
  // redes ya calentadas, RED_Z_MIN está demasiado alto (C43_RED_Z_MIN).
  setInterval(() => {
    const tot = _atrib.z + _atrib.sin_stat + _atrib.sin_lean + _atrib.sin_scores;
    if (!tot) return;
    const pct = (_atrib.z / tot * 100).toFixed(0);
    log(`⚖️  atribución: ${_atrib.z} por z-score (${pct}%) | ` +
        `${_atrib.sin_lean} sin inclinación, ${_atrib.sin_stat} sin estadística, ` +
        `${_atrib.sin_scores} sin scores | ${_estRed.size} redes observadas`);
  }, 5 * 60 * 1000).unref();

  startHealthServer(9200);
  log("✅ class43 operativo — verificación reactiva a precios de class7");
}

process.on("uncaughtException",  e => log(`uncaughtException: ${e.message}`, "error"));
process.on("unhandledRejection", e => log(`unhandledRejection: ${String(e)}`, "error"));
process.on("SIGINT", async () => {
  log("Cerrando...");
  await backupJSON();
  try { if (redisSub) await redisSub.quit(); } catch (_) {}
  try { if (redisPub) await redisPub.quit(); } catch (_) {}
  process.exit(0);
});

// ── Modo módulo, para testear en local ────────────────────────────────
// Con `CLASS43_SOLO_MODULO=1` el archivo se puede importar SIN arrancar nada:
// ni Redis, ni MySQL, ni el health server, ni el timer que mantiene vivo el
// proceso. Agregado el 21-sep-2026 para poder probar los cambios del corte del
// 12-oct contra datos reales antes de desplegarlos (docs/simulaciones/).
// En producción la variable no existe, así que el comportamiento es idéntico.
const _SOLO_MODULO = process.env.CLASS43_SOLO_MODULO === "1";

if (!_SOLO_MODULO) {
  bootstrap().catch(async e => {
    log(`❌ Bootstrap: ${e.message}`, "error");
    await new Promise(r => setTimeout(r, 10000));
    bootstrap().catch(e2 => log(`❌ Reintento: ${e2.message}`, "error"));
  });

  setInterval(() => {}, 60000);
}

export default {
  metricas:       () => ({ ...metricas }),
  señalesActivas: () => señalesEnCurso.size,
  historial:      () => historialDecisiones.slice(-100)
};

// Se exportan SOLO para las simulaciones. Nada del sistema los importa: los
// módulos se hablan por Redis (ver las notas internas, «El bus es lo único que une el
// sistema»), así que agregar exports no crea acoplamiento entre módulos.
export const _test = {
  reconciliarPendientesDB,
  _precioHistorico,
  setPendientesReader: (fn) => { _obtenerPendientes = fn || obtenerDecisionesPendientes; },
  setRedisPub: (fn) => { redisPub = fn; },
  setSql: (fn) => { _sql = fn || sqlQuery; },
  setOutcomeWriter: (fn) => { _actualizarOutcomeReal = fn || actualizarOutcomeReal; },
  setCompletador: (fn) => { _completarPrecio = fn || completarPrecioEntrada; },
  setGuardador:   (fn) => { _guardarDecision = fn || guardarDecision; },
  setStatsWriter: (fn) => { _guardarStats    = fn || guardarBacktestingStats; },
  // El conteo global se cachea 30 s. Sin poder vaciarlo, una prueba que inyecta
  // una base falsa sigue leyendo lo que quedó de la llamada anterior.
  resetConteo:    () => { _conteoCache = { ts: 0, datos: null }; },
  _persistirPrecioEntrada,
  _conteoGlobal,
  publicarMetricas,
  metricasRef:    () => metricas,
  procesarSeñal,
  verificarOutcome,
  _getPrecioCompuesto,
  _marketRet,
  _marketRetCache,
  _esSenalDeMercado,
  señalesEnCurso,
  preciosActuales,
  UNIVERSO_MKT,
};