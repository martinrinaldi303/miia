// ============================================================
// class11.js — Analizador de Impacto Mediático v2.0
// ============================================================
// ROL: Evalúa el alcance de información y simula repercusión
//      de narrativas, combinando con pronóstico (class40),
//      riesgo (class41), noticias reales (class1) y mercado
//      (class7). Publica conteos NORMALIZADOS 0-1, no counts
//      absolutos sin escala (likes/shares ya no van crudos).
//
// ENTRADAS:
//   class40_output — pronóstico híbrido
//   class41_output — riesgo
//   class1_output  — noticias reales (AGREGADO — reemplaza simulación)
//   class7_output  — estado sectorial (AGREGADO)
//
// SALIDA: class18_ingest — JSON contractual con score 0-1
// ============================================================

import path from "path";
import fs from "fs-extra";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const LOG_DIR = path.resolve(__dirname, "../operador/aprendizaje/logs");
fs.ensureDirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, "class11.log");

function humanInfo(msg)  { _log(msg, "INFO"); }
function humanWarn(msg)  { _log(msg, "WARN"); }
function humanError(msg) { _log(msg, "ERROR"); }
function _log(msg, level) {
  const line = `[${new Date().toISOString()}] [class11/${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Config Redis ─────────────────────────────────────────────
const redisConfig = {
  url: "redis://localhost:6379",
  // AGREGAMOS class1_output y class7_output a los canales existentes
  inputChannels: ["class40_output", "class41_output", "class1_output", "class7_output"],
};

const redisClient = createClient({ url: redisConfig.url });  // solo subscribe
const redisPub    = createClient({ url: redisConfig.url });  // solo publish

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

// ── Estado de señales externas ───────────────────────────────
const señales = {
  pronostico: null,
  riesgo:     null,
  noticia:    null,           // el ÚLTIMO titular; se conserva por compatibilidad
  noticiasVentana: [],        // los últimos NOTICIAS_MAX dentro del TTL
  mercado:    null,
};

// ── Ventana de titulares (26-sep-2026) ────────────────────────
// `señales.noticia = parsed` pisaba la noticia anterior: el impacto mediático se
// calculaba contra UN titular, el último que llegó. class1 trae varios por
// corrida, así que cuál quedaba era esencialmente aleatorio.
//
// El TTL no es decorativo: sin él, con el mercado cerrado la ventana se quedaría
// con los titulares del viernes y el "impacto" del domingo los seguiría
// midiendo. 6 h cubre una rueda entera y se vacía sola de noche.
const NOTICIAS_MAX    = Number(process.env.CLASS11_NOTICIAS_MAX || 25);
const NOTICIAS_TTL_MS = Number(process.env.CLASS11_NOTICIAS_TTL_MIN || 360) * 60_000;

function agregarNoticia(parsed) {
  const texto = String(parsed?.texto ?? parsed?.text ?? "").trim();
  if (!texto) return;
  const ahora = Date.now();
  // Dedup por texto: class1 republica el mismo titular entre proveedores, y sin
  // esto una noticia repetida tres veces pesaría el triple en el promedio.
  const yaEsta = señales.noticiasVentana.some(n => n.texto === texto);
  // `ticker` y `sentimiento` vienen PLANOS de class1_output (class1.js:559 arma
  // `tickerFlat` con TICKERS_ORDENADOS). Son los dos campos que habilitan el
  // impacto POR INSTRUMENTO: el dato existe desde el primer eslabón y hasta hoy
  // se perdía acá, porque la ventana sólo guardaba el texto.
  if (!yaEsta) señales.noticiasVentana.push({
    texto, ts: ahora, raw: parsed,
    ticker:      String(parsed?.ticker || "").toUpperCase() || null,
    sentimiento: parsed?.sentimiento || null,
  });
  // Purga por TTL y por tope, en ese orden.
  señales.noticiasVentana = señales.noticiasVentana
    .filter(n => ahora - n.ts <= NOTICIAS_TTL_MS)
    .slice(-NOTICIAS_MAX);
}

// ── buildStandardEnvelope (helper interno) ────────────────────
function buildStandardEnvelope(type, text, data) {
  return {
    id: crypto.randomUUID(),
    source: "class11",
    type,
    text,
    data,
    ts: new Date().toISOString(),
  };
}

/**
 * calcularImpactoReal — REEMPLAZA la simulación con Math.random().
 * Ahora usa datos reales de class1 (noticias) cuando están
 * disponibles, y los combina con pronóstico/riesgo/mercado.
 * Todos los outputs son floats 0-1, no counts absolutos.
 */
// ── Contexto compartido (pronóstico / riesgo / mercado) ───────
// Extraído de calcularImpacto el 26-sep-2026: lo usan el agregado y el camino
// por instrumento, y tienen que ser el MISMO número en los dos.
function _contexto() {
  let pronosticoScore = 0.5;
  if (señales.pronostico?.Ensemble?.Predictions?.length) {
    const preds = señales.pronostico.Ensemble.Predictions;
    const delta = (preds.at(-1).Value - preds[0].Value) / (Math.abs(preds[0].Value) || 1);
    pronosticoScore = clamp01(0.5 + delta * 2);
  }
  let riesgoScore = 0.5;
  if (señales.riesgo?.RiskMetrics) {
    riesgoScore = clamp01(señales.riesgo.RiskMetrics.RiskScore ?? 0.5);
  }
  let mercadoScore = 0.5;
  if (señales.mercado?.riesgoGlobal != null) {
    mercadoScore = clamp01(señales.mercado.riesgoGlobal);
  }
  return { pronosticoScore, riesgoScore, mercadoScore };
}

// ── Impacto POR INSTRUMENTO (26-sep-2026) ─────────────────────
// POR QUÉ: class11 calculaba UN score sobre una ventana de titulares de tickers
// MEZCLADOS, y class18 lo publicaba como un vector sin `symbol`. Con el ranking
// transversal activo eso no decide NADA: las ventanas GENERAL no emiten, así que
// el 67 % de la masa de pesos del ensemble queda fuera de toda decisión
// publicada (ver «Cuatro cosas que aparecieron leyendo el código entero»).
//
// El dato por instrumento YA EXISTE: class1_output trae `ticker` y `sentimiento`
// por titular. Se perdía en este módulo.
//
// QUÉ MIDE, y por qué así: para cada instrumento, qué PORCIÓN del flujo de
// noticias habla de él (`cuota`) y con qué signo (`sentimiento`). Es la versión
// por instrumento de lo que el agregado mide en bloque.
//
// ⚠️ Los términos de contexto —riesgo y mercado— son COMUNES a todos los
// instrumentos, así que NO mueven el orden del ranking: suman una constante.
// Lo que ordena es cuota + sentimiento. Es la misma lección que class21/class22
// aportando un término común: si todo lo que agregás es común, no decide.
// APAGADO salvo que se pida. Estuvo en ON desde el corte pero era inerte: la
// ventana de titulares quedaba en 0 porque class1 no mandaba `texto`. Al
// arreglar eso el 10-oct a las 18:31 se encendio solo, y no es un cambio que
// alguien haya decidido: la replica del 10-oct lo midio y lo dejo APAGADO a
// proposito, porque el impacto abre su propia ventana en class25A (las 4
// claves class2X/impacto, sin `mercado`) y mete en la seccion transversal un z
// de solo noticias que pisa al de mercado. Eso cambia lo que el ranking
// ordena, en mitad de la medicion que arranco el 10-oct.
// El AGREGADO no depende de esto: la tarjeta de Impacto Mediatico anda igual.
const POR_TICKER  = process.env.CLASS11_POR_TICKER === "1";
const MAX_TICKERS = Number(process.env.CLASS11_MAX_TICKERS || 12);

function _sentNum(s) {
  const t = String(s || "").toUpperCase();
  if (t === "BULLISH") return 1;
  if (t === "BEARISH") return -1;
  return 0;
}

export function impactoPorTicker() {
  const ventana = señales.noticiasVentana;
  if (!ventana.length) return [];

  const porT = new Map();
  for (const n of ventana) {
    const t = String(n.ticker || "").toUpperCase();
    if (!t) continue;              // sin ticker NO entra: no se inventa un símbolo
    if (!porT.has(t)) porT.set(t, []);
    porT.get(t).push(n);
  }
  if (!porT.size) return [];

  const { pronosticoScore, riesgoScore, mercadoScore } = _contexto();
  const total = ventana.length;

  const salida = [];
  for (const [ticker, arr] of porT) {
    const cuota  = clamp01(arr.length / Math.max(1, total));
    const sentAv = arr.reduce((a, n) => a + _sentNum(n.sentimiento), 0) / arr.length;
    const sent01 = clamp01((sentAv + 1) / 2);

    const score = clamp01(
      cuota   * 0.35 +
      sent01  * 0.25 +
      (1 - riesgoScore)  * 0.20 +
      (1 - mercadoScore) * 0.20
    );

    // La confianza sube con cuántos titulares respaldan al instrumento: uno solo
    // no es evidencia. Se satura a los 10, que es el tamaño util de la ventana.
    const confianza = clamp01(
      0.30 + Math.min(0.40, arr.length / 10) +
      (señales.mercado ? 0.15 : 0) + (señales.riesgo ? 0.15 : 0)
    );

    salida.push({
      ts: new Date().toISOString(),
      origen: "class11",
      symbol: ticker,                    // ← lo que class18 propaga y el ranking usa
      ticker,                            // alias, por si algún consumidor viejo lo lee
      n_noticias: arr.length,
      cuota,
      sentimiento_medio: sentAv,
      score,
      probabilidad: score,
      confianza,
      relevanciaReal: cuota,             // class18 ImpactoExtractor18 dim 2
      fuente_real: true,
      pronosticoScore, riesgoScore, mercadoScore,
      resumen: `Impacto ${ticker}: ${arr.length}/${total} titulares, ` +
               `cuota=${(cuota * 100).toFixed(1)}%, sent=${sentAv.toFixed(2)}`,
    });
  }

  // Tope con prioridad al que más respaldo tiene. Sin esto, una ventana con 25
  // tickers distintos publicaría 25 mensajes por análisis a class18_ingest.
  salida.sort((a, b) => b.n_noticias - a.n_noticias || b.score - a.score);
  return salida.slice(0, MAX_TICKERS);
}

export async function calcularImpacto(terms = []) {
  try {
    if (!Array.isArray(terms)) terms = [];
    const sanitized = terms.filter(t => typeof t === "string" && t.trim().length > 0);
    if (sanitized.length === 0) return null;

    // ── Score de relevancia: coincidencia con la VENTANA de noticias ──
    //
    // Antes se medía contra UN titular (`señales.noticia`, el último que llegó).
    // Ahora se promedia la relevancia sobre los titulares de la ventana, y se
    // reporta el mejor como fuente — que es el que un humano querría ver.
    //
    // Se PROMEDIA y no se toma el máximo: el máximo sobre 25 titulares tiende a
    // 1 por azar (cualquier término aparece en alguno), y eso es exactamente el
    // defecto de las keywords cortas de class45 con otra forma. El promedio mide
    // "cuánto del flujo de noticias habla de esto", que es lo que el módulo dice
    // medir.
    let relevanciaReal = 0;
    let fuenteNoticia = null;
    const ventana = señales.noticiasVentana.length
                  ? señales.noticiasVentana
                  // Sin ventana todavía (primeros segundos), se usa el último.
                  : (señales.noticia ? [{ texto: señales.noticia.texto || señales.noticia.text || "" }] : []);
    if (ventana.length) {
      let suma = 0, mejor = -1;
      for (const n of ventana) {
        const txt = String(n.texto || "").toLowerCase();
        const m   = sanitized.filter(t => txt.includes(t.toLowerCase())).length;
        const rel = m / Math.max(1, sanitized.length);
        suma += rel;
        if (m > 0 && rel > mejor) { mejor = rel; fuenteNoticia = String(n.texto).slice(0, 200); }
      }
      relevanciaReal = clamp01(suma / ventana.length);
    }

    // Los tres scores de contexto viven en _contexto() para que el camino POR
    // INSTRUMENTO use exactamente los mismos y no dos copias que puedan driftear.
    const { pronosticoScore, riesgoScore, mercadoScore } = _contexto();

    // ── Construir "activos" con score real en vez de aleatorio ──
    const activos = [];
    const numActivos = Math.min(8, Math.max(1, Math.ceil(sanitized.length / 3)));
    for (let i = 0; i < numActivos; i++) {
      const relatedTerm = sanitized[i % sanitized.length];
      // Score determinístico basado en el término + contexto real (no Math.random())
      const seedScore = clamp01(
        relevanciaReal * 0.4 + pronosticoScore * 0.3 +
        (1 - riesgoScore) * 0.2 + (1 - mercadoScore) * 0.1
      );
      activos.push({
        id: `ACT${i + 1}`,
        seedTerm: relatedTerm,
        score: seedScore,            // float 0-1, no vector aleatorio
        relevancia: relevanciaReal,
      });
    }

    // ── Métricas normalizadas 0-1 (YA NO counts absolutos crudos) ──
    const metrics = calcularMetricasNormalizadas(sanitized, relevanciaReal, mercadoScore);

    // ── Score de impacto agregado final ──
    const impactScore = clamp01(
      relevanciaReal * 0.35 +
      pronosticoScore * 0.25 +
      (1 - riesgoScore) * 0.20 +
      (1 - mercadoScore) * 0.20
    );

    const confianza = clamp01(
      0.3 + (señales.noticia ? 0.3 : 0) + (señales.pronostico ? 0.2 : 0) + (señales.riesgo ? 0.2 : 0)
    );

    const result = {
      ts: new Date().toISOString(),
      origen: "class11",
      inputTerms: sanitized,
      activos,
      metrics,
      // Campos numéricos planos para class25A y class18.cs
      score:         impactScore,
      probabilidad:  impactScore,
      confianza,
      fuente_real:   !!fuenteNoticia,
      relevanciaReal,                   // class18 ImpactoExtractor18 dim 2
      resumen: `Análisis de impacto: score=${(impactScore*100).toFixed(1)}% sobre ${sanitized.length} términos` +
                (fuenteNoticia ? ` (coincide con noticia real)` : ` (sin coincidencia noticiosa directa)`),
    };

    return result;
  } catch (e) {
    humanError(`Error calculando impacto: ${String(e?.message || e)}`);
    return null;
  }
}

/**
 * calcularMetricasNormalizadas — REEMPLAZA simulateMetricsFromTerms.
 * Antes generaba likes/shares/comments aleatorios sin escala.
 * Ahora genera scores 0-1 basados en relevancia real + contexto de mercado.
 */
function calcularMetricasNormalizadas(terms, relevancia, mercadoRiesgo) {
  const count = terms.length;
  const baseActividad = clamp01(count / 20); // más términos = más "actividad" potencial

  return {
    actividad_score:   clamp01(baseActividad * 0.6 + relevancia * 0.4),
    alcance_score:     clamp01(relevancia * 0.5 + (1 - mercadoRiesgo) * 0.5),
    engagement_score:  clamp01(baseActividad * 0.4 + relevancia * 0.6),
    // Viralidad: mercadoRiesgo + relevancia + actividad base para no quedar en 0
    // cuando señales.noticia es null (sin coincidencia noticiosa directa)
    viralidad_score:   clamp01(mercadoRiesgo * 0.4 + relevancia * 0.4 + baseActividad * 0.2),
  };
}

// ── Throttle: máximo 1 publicación cada THROTTLE_MS ms ──────
// class40/41 publican en ráfagas → sin throttle genera decenas de
// mensajes por minuto innecesarios.
const THROTTLE_MS    = 60_000;   // máx 1 análisis por minuto
const DEBOUNCE_MS    = 3_000;    // esperar 3s de quietud antes de procesar
let   _lastPublish   = 0;
let   _debounceTimer = null;
let   _pendingSignal = false;    // hay señales nuevas pendientes de procesar

function _scheduleAnalysis() {
  _pendingSignal = true;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(_runAnalysis, DEBOUNCE_MS);
}

async function _runAnalysis() {
  _debounceTimer = null;
  if (!_pendingSignal) return;
  _pendingSignal = false;

  const now = Date.now();
  if (now - _lastPublish < THROTTLE_MS) return;  // throttle activo

  // Permitir análisis con solo datos de mercado (class7) cuando no hay noticia ni pronóstico
  // Antes esto bloqueaba — ahora usamos términos de sectores como fallback
  let terms = extraerTerminos(señales.noticia, señales.pronostico);
  if (terms.length === 0) {
    if (!señales.mercado) return;  // sin absolutamente ningún dato, sí salir
    // Extraer términos de sectores en movimiento
    const sectors = señales.mercado.sectors || señales.mercado.sector_state || [];
    if (Array.isArray(sectors)) {
      terms = sectors
        .filter(s => Math.abs(s.change ?? 0) > 0.005)
        .sort((a,b) => Math.abs(b.change??0) - Math.abs(a.change??0))
        .slice(0, 5)
        .map(s => (s.sector || s.etf || "market").toLowerCase());
    }
    if (terms.length === 0) terms = ["market","equity","stocks","economy","finance"];
  }

  const impacto = await calcularImpacto(terms);
  if (!impacto) return;

  const envelope = buildStandardEnvelope("impact_analysis", impacto.resumen, impacto);
  envelope.probabilidad = impacto.probabilidad;
  envelope.confianza    = impacto.confianza;
  envelope.score        = impacto.score;

  const publishChannel = "class18_ingest";
  if (redisPub.isOpen) {
    // 1) El AGREGADO, exactamente como antes. class13 y los consumidores viejos
    //    de class18_ingest no se enteran de nada de lo de abajo.
    await redisPub.publish(publishChannel, JSON.stringify(envelope));
    _lastPublish = Date.now();
    humanInfo(`📤 Impacto publicado (throttle OK): score=${(impacto.score*100).toFixed(1)}%`);

    // 2) Uno POR INSTRUMENTO, con `symbol` en la RAÍZ del envelope —que es donde
    //    class18 lee con VecUtils18.GetStr(root, ...)—. Sin esto el vector cae
    //    en GENERAL y, con el ranking activo, no decide nada.
    if (POR_TICKER) {
      const porT = impactoPorTicker();
      for (const it of porT) {
        const env = buildStandardEnvelope("impact_analysis", it.resumen, it);
        env.probabilidad = it.probabilidad;
        env.confianza    = it.confianza;
        env.score        = it.score;
        env.symbol       = it.symbol;     // ← el campo que propaga class18
        env.ticker       = it.symbol;
        await redisPub.publish(publishChannel, JSON.stringify(env));
      }
      if (porT.length) {
        humanInfo(`📤 Impacto por instrumento: ${porT.length} → ` +
                  porT.map(x => `${x.symbol}:${(x.score * 100).toFixed(0)}%`).join(" "));
      }
    }
  }
}

// ── Manejador unificado de canales ──────────────────────────
async function unifiedHandler(raw, channelName) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.source === "class11") return; // anti-loop

    if (channelName === "class40_output") {
      señales.pronostico = parsed;
      // No loguear cada mensaje — en ráfagas llenan el log
    } else if (channelName === "class41_output") {
      señales.riesgo = parsed;
      // Solo loguear si riskLevel es conocido
      if (parsed.RiskMetrics?.RiskLevel) humanInfo(`📥 class41 riskLevel=${parsed.RiskMetrics.RiskLevel}`);
    } else if (channelName === "class1_output") {
      señales.noticia = parsed;
      // ── VENTANA de titulares, no sólo el último (26-sep-2026) ───────────
      // `señales.noticia = parsed` PISA la noticia anterior, así que el impacto
      // mediático se calculaba contra UN titular: el último que llegó. class1
      // trae noticias en ráfagas de varias por corrida, así que lo que quedaba
      // era esencialmente aleatorio — y con 50 instrumentos es peor, porque
      // cada corrida trae titulares de más sectores y el último pisa a los 49.
      //
      // Se conserva `señales.noticia` (el último) para no cambiar nada de lo
      // que ya lo lee, y se agrega la ventana al lado. El TTL existe porque una
      // noticia de ayer no describe el impacto de ahora.
      agregarNoticia(parsed);
      humanInfo(`📥 class1_output: "${(parsed.texto||parsed.text||"").slice(0,60)}" ` +
                `[ventana: ${señales.noticiasVentana.length}]`);
    } else if (channelName === "class7_output") {
      if (parsed?.type === "sector_state") {
        señales.mercado = parsed;
        humanInfo(`📥 class7_output: riesgo=${(parsed.riesgoGlobal*100).toFixed(1)}%`);
      }
    }

    // Programar análisis con debounce + throttle
    _scheduleAnalysis();

  } catch (e) {
    humanError(`Error procesando mensaje desde ${channelName}: ${String(e?.message || e)}`);
  }
}


/**
 * extraerTerminos — extrae palabras clave relevantes de la
 * noticia actual y/o del ticker del pronóstico, para usar
 * como input de calcularImpacto().
 */
function extraerTerminos(noticia, pronostico) {
  const terms = [];
  if (noticia) {
    const texto = (noticia.texto || noticia.text || "").toLowerCase();
    const palabras = texto.split(/\s+/).filter(w => w.length > 4).slice(0, 10);
    terms.push(...palabras);
  }
  if (pronostico?.Ticker)  terms.push(pronostico.Ticker.toLowerCase());
  if (pronostico?.Sector)  terms.push(pronostico.Sector.toLowerCase());
  return [...new Set(terms)].slice(0, 15);
}

// ── Arranque ───────────────────────────────────────────────
// CLASS11_SOLO_MODULO=1 importa el módulo SIN conectarse a Redis, para poder
// probar la lógica en frío (mismo criterio que CLASS43_SOLO_MODULO). En
// producción la variable no existe y el comportamiento es idéntico.
const SOLO_MODULO = process.env.CLASS11_SOLO_MODULO === "1";

export const _test = {
  señales,
  agregarNoticia,
  impactoPorTicker,
  _contexto,
  cfg: () => ({ POR_TICKER, MAX_TICKERS, NOTICIAS_MAX, NOTICIAS_TTL_MS }),
  reset() {
    señales.noticiasVentana = [];
    señales.noticia = null; señales.pronostico = null;
    señales.riesgo = null;  señales.mercado = null;
  },
};

if (!SOLO_MODULO) (async () => {
  try {
    await redisClient.connect();
    await redisPub.connect();

    for (const ch of redisConfig.inputChannels) {
      await redisClient.subscribe(ch, async (raw) => {
        await unifiedHandler(raw, ch);
      });
      humanInfo(`Suscrito al canal: ${ch}`);
    }

    humanInfo("✅ class11 v2.0 — Analizador de Impacto (numérico) iniciado");
  } catch (e) {
    humanError(`Error conectando a Redis: ${e.message}`);
  }
})();

if (!SOLO_MODULO) process.on("SIGINT",  async () => { await redisClient.quit(); await redisPub.quit(); process.exit(0); });
process.on("SIGTERM", async () => { await redisClient.quit(); await redisPub.quit(); process.exit(0); });