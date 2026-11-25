// ============================================================
// class45.js — Motor de Sentimiento de Noticias (MIIA v2.0)
//
// ENTRADAS:
//   class1_output  — artículos/noticias buscados por class1
//   class1_trigger — trigger manual de análisis
//
// SALIDAS:
//   class45_output — señal de sentimiento enriquecida
//   class40_output — crisis input para class25A (sin recompilar C++)
//
// FLUJO:
//   1. Lee artículo de class1_output (título + snippet + fuente)
//   2. Detecta tickers/sectores mencionados
//   3. Calcula score AFINN + ponderación por keywords financieras
//   4. Acumula ventana de 10 artículos por sector
//   5. Publica señal cuando hay suficiente evidencia
//
// ============================================================

import fs        from "node:fs";
import path      from "node:path";
import { fileURLToPath } from "node:url";
import Redis     from "ioredis";
import Sentiment from "sentiment";
import {
  guardarSentimientoSignal, logSistema,
  obtenerPrecioActual, obtenerSentimientoPendienteVerificar, actualizarOutcomeSentimiento,
  obtenerNoticias, actualizarNoticiaSentimiento,
} from "./class42.js";
// FUENTE ÚNICA del universo. `TICKERS_NOTICIAS` es el subconjunto que recibe
// cobertura de noticias; la guarda debajo de TICKER_MAP verifica que esa tabla
// lo cubra entero — si falta uno, ese instrumento no puede tener sentimiento.
import { TICKERS_NOTICIAS as TICKERS_SENT } from "./universo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Paths ──────────────────────────────────────────────────────
const BASE_DIR  = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR  = path.join(BASE_DIR, "logs");
const STATE_DIR = path.join(BASE_DIR, "state");

for (const d of [LOGS_DIR, STATE_DIR])
  fs.mkdirSync(d, { recursive: true });

// ── Logger ─────────────────────────────────────────────────────
const LOG_FILE = path.join(LOGS_DIR, "class45.log");
function log(msg, nivel = "info") {
  const line = `[${new Date().toISOString()}] [class45/${nivel.toUpperCase()}] ${msg}`;
  console[nivel === "error" ? "error" : nivel === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Canales Redis ──────────────────────────────────────────────
const REDIS_URL    = process.env.REDIS_URL || "redis://localhost:6379";
const CH_IN_NEWS   = "class1_output";
const CH_IN_TRIG   = "class1_trigger";
const CH_OUT       = "class45_output";
const CH_OUT_CRISIS = "class40_output";   // class25A lo lee como crisis input

// ── Motor de Sentimiento (AFINN) ───────────────────────────────
const sentiment = new Sentiment();

// ── Palabras clave financieras con peso extra ──────────────────
// Complementan el vocabulario AFINN con términos específicos del mercado
const MARKET_KEYWORDS = {
  // Muy alcistas (+2)
  surge:     2, rally:    2, soar:     2, boom:    2, record:    2,
  breakout:  2, bullish:  2, upgrade:  2, beat:    2, outperform: 2,
  "all-time-high": 2, innovate: 2, "strong earnings": 2,
  // Alcistas (+1)
  gain:      1, rise:     1, grow:     1, profit:  1, positive:  1,
  demand:    1, expand:   1, launch:   1, partner: 1, deal:      1,
  dividend:  1, buyback:  1, approve:  1, recover: 1,
  // Bajistas (-1)
  fall:     -1, drop:    -1, decline: -1, loss:   -1, miss:     -1,
  warning:  -1, weak:    -1, concern: -1, risk:   -1, uncertain:-1,
  cut:      -1, reduce:  -1, downgrade:-1, recall: -1, probe:   -1,
  // Muy bajistas (-2)
  crash:    -2, collapse:-2, bankrupt:-2, fraud:  -2, lawsuit:  -2,
  default:  -2, recession:-2, panic:  -2, crisis: -2, scandal:  -2,
};

// ── Pesos adaptativos por keyword (entrenamiento online) ────────
// Cada keyword de MARKET_KEYWORDS tiene un multiplicador que arranca en 1.0
// (sin efecto) y se ajusta con el tiempo según si, cuando esa keyword apareció
// en un artículo, la predicción resultante (BULLISH/BEARISH) acertó o no contra
// el precio real (ver verificarYEntrenar). Así el motor "entrena" sin reentrenar
// el lexicón AFINN: amplifica las keywords que históricamente predicen bien y
// atenúa las que confunden, en vez de usar un peso fijo para siempre.
const WEIGHTS_FILE = path.join(STATE_DIR, "sentiment_keyword_weights.json");
const WEIGHT_MIN = 0.3, WEIGHT_MAX = 2.0;
const WEIGHT_UP = 1.04, WEIGHT_DOWN = 0.96;   // ajuste por verificación correcta/incorrecta

let keywordWeights = {};
function _loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      keywordWeights = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8")) || {};
      log(`Pesos adaptativos cargados: ${Object.keys(keywordWeights).length} keywords con ajuste`);
    }
  } catch (e) { log(`_loadWeights: ${e.message}`, "warn"); keywordWeights = {}; }
}
function _saveWeights() {
  try { fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(keywordWeights, null, 2)); }
  catch (e) { log(`_saveWeights: ${e.message}`, "warn"); }
}
function _pesoKeyword(kw) { return keywordWeights[kw] ?? 1.0; }
function _ajustarPeso(kw, acierto) {
  const actual = _pesoKeyword(kw);
  const nuevo  = acierto ? Math.min(WEIGHT_MAX, actual * WEIGHT_UP)
                          : Math.max(WEIGHT_MIN, actual * WEIGHT_DOWN);
  keywordWeights[kw] = +nuevo.toFixed(4);
}
_loadWeights();

// ── Mapa ticker → sector + keywords de detección ──────────────
const TICKER_MAP = [
  // Tecnología
  // OJO: la detección es por substring (lower.includes) → nada de keywords de 1-2
  // chars. "ai" matcheaba said/again/air/available y etiquetaba XLK en casi toda
  // noticia, contaminando el sentimiento con ruido (de ahí los NEUT 0% eternos).
  { ticker: "XLK",  keywords: ["tech","technology","apple","microsoft","google","alphabet","nvidia","artificial intelligence","semiconductor","chip","software","cloud","cyber","aapl","msft","nvda","meta","amazon","tesla"] },
  // Finanzas
  { ticker: "XLF",  keywords: ["bank","finance","financial","federal reserve","interest rate","jpmorgan","goldman","loan","credit","insurance","investment","xlf","jpmorgan chase","bank of america"] },
  // Energía
  { ticker: "XLE",  keywords: ["oil","energy","gas","crude","petroleum","exxon","chevron","opec","barrel","refinery","pipeline","lng","coal","renewable","xle"] },
  // Salud
  { ticker: "XLV",  keywords: ["health","pharma","drug","vaccine","fda","hospital","biotech","cancer","clinical","medicine","pfizer","johnson","xlv"] },
  // Consumo discrecional
  { ticker: "XLY",  keywords: ["retail","consumer","amazon","walmart","luxury","auto","electric vehicle","disney","restaurant","travel","xly"] },
  // Industriales
  { ticker: "XLI",  keywords: ["industrial","manufacturing","factory","boeing","caterpillar","airline","aerospace","defense","freight","railroad","machinery","honeywell","lockheed","fedex","xli"] },
  // Materiales
  // "gold " CON ESPACIO FINAL a propósito: el matcher usa includes() (substring),
  // así que "gold" a secas etiquetaría "Goldman Sachs" como Materiales — el mismo
  // bug que "ai"→"said". El espacio exige que sea palabra suelta ("Gold climbs…",
  // "Gold hits…") y descarta Goldman. Medido sobre el feed real: captura 4 de 5
  // titulares de oro, 0 falsos positivos. "gold mining" sola no capturaba ninguno.
  { ticker: "XLB",  keywords: ["materials","chemical","mining","steel","copper","aluminum","cement","fertilizer","lithium","gold mining","gold ","commodities","dupont","xlb"] },
  // Real Estate
  { ticker: "XLRE", keywords: ["real estate","reit","property","housing","mortgage","homebuilder","office space","rental market","commercial property","xlre"] },
  // Utilities
  { ticker: "XLU",  keywords: ["utility","utilities","power grid","electricity","nuclear plant","water utility","nextera","duke energy","renewable grid","xlu"] },
  // Communication Services
  { ticker: "XLC",  keywords: ["communication services","telecom","media","streaming","netflix","verizon","comcast","advertising","social media","warner","xlc"] },
  // Argentina
  { ticker: "ARGT", keywords: ["argentina","merval","milei","peso","buenos aires","bcra","ypf","galicia","macro","argt","cedear","dolar blue"] },
  // Brasil
  { ticker: "EWZ",  keywords: ["brazil","brasil","petrobras","lula","bolsonaro","ibovespa","real","ewz","vale","itau"] },
  // Latinoamérica (regional)
  { ticker: "ILF",  keywords: ["latin america","latinoamerica","latam","mexico","chile","colombia","peru","emerging markets","mercados emergentes","ilf"] },

  // ── Los 37 del 26-sep-2026 ──────────────────────────────────────────────
  // Antes esta tabla tenía 13 entradas y el universo pasó a 50: los otros 37
  // NO podían recibir sentimiento nunca, porque `detectarTickers` recorre
  // exactamente esta lista. No fallaba: devolvía vacío, y el panel mostraba
  // "s/d" eterno sin que nada lo dijera.
  //
  // Las keywords siguen la regla de arriba: NADA de 1-2 caracteres, y las
  // palabras que son prefijo de otra cosa van con espacio final. El ticker
  // propio va siempre (los titulares suelen nombrarlo).
  // Sectores que faltaban
  { ticker: "XLP",  keywords: ["consumer staples","procter","coca-cola","pepsico","costco","supermarket","grocery","household goods","tobacco","xlp"] },
  // Índices amplios de EE.UU.
  { ticker: "SPY",  keywords: ["s&p 500","sp500","wall street","broad market","index fund","spdr","spy etf"] },
  { ticker: "QQQ",  keywords: ["nasdaq","nasdaq 100","megacap tech","qqq"] },
  { ticker: "IWM",  keywords: ["small cap","small-cap","russell 2000","iwm"] },
  { ticker: "DIA",  keywords: ["dow jones","dow industrials","blue chip","dia etf"] },
  // Internacionales amplios
  { ticker: "EFA",  keywords: ["developed markets","eafe","international equities","efa etf"] },
  { ticker: "EEM",  keywords: ["emerging market equities","em equities","eem etf"] },
  // Países
  { ticker: "EWJ",  keywords: ["japan","japanese stocks","nikkei","topix","bank of japan","yen","ewj"] },
  { ticker: "EWG",  keywords: ["germany","german stocks","dax","bundesbank","ewg"] },
  { ticker: "EWU",  keywords: ["united kingdom","british stocks","ftse","bank of england","pound sterling","ewu"] },
  { ticker: "EWL",  keywords: ["switzerland","swiss stocks","swiss national bank","nestle","roche","ewl"] },
  { ticker: "EWY",  keywords: ["south korea","korean stocks","kospi","samsung electronics","ewy"] },
  { ticker: "EWT",  keywords: ["taiwan","taiwanese stocks","tsmc","taiex","ewt"] },
  { ticker: "EWH",  keywords: ["hong kong","hang seng","ewh"] },
  { ticker: "EWA",  keywords: ["australia","australian stocks","asx","reserve bank of australia","ewa"] },
  { ticker: "INDA", keywords: ["india","indian stocks","sensex","nifty","reserve bank of india","rupee","inda"] },
  { ticker: "FXI",  keywords: ["china","chinese stocks","shanghai composite","pboc","yuan","fxi"] },
  { ticker: "EWC",  keywords: ["canada","canadian stocks","tsx","bank of canada","loonie","ewc"] },
  { ticker: "EWW",  keywords: ["mexico","mexican stocks","bolsa mexicana","banxico","peso mexicano","eww"] },
  // Industrias y temas
  { ticker: "SMH",  keywords: ["semiconductor stocks","chipmaker","chip stocks","foundry","wafer","asml","smh"] },
  { ticker: "XBI",  keywords: ["biotech stocks","biotechnology","clinical trial","gene therapy","fda approval","xbi"] },
  { ticker: "VNQ",  keywords: ["reits","real estate investment trust","vnq"] },
  { ticker: "XOP",  keywords: ["oil exploration","shale","upstream","drilling","rig count","xop"] },
  { ticker: "KRE",  keywords: ["regional bank","regional banks","community bank","deposit flight","kre"] },
  { ticker: "ITB",  keywords: ["homebuilder","home construction","housing starts","lennar","d.r. horton","itb"] },
  { ticker: "JETS", keywords: ["airline","airlines","air travel","delta air","united airlines","jet fuel","jets etf"] },
  { ticker: "IYT",  keywords: ["transportation stocks","trucking","railroad","logistics","ups ","freight rates","iyt"] },
  { ticker: "XME",  keywords: ["metals and mining","iron ore","steelmaker","nucor","freeport","xme"] },
  { ticker: "GDX",  keywords: ["gold miner","gold miners","newmont","barrick","bullion","gdx"] },
  { ticker: "XRT",  keywords: ["retailers","retail sales","department store","e-commerce sales","xrt"] },
  { ticker: "ARKK", keywords: ["disruptive innovation","cathie wood","ark invest","arkk"] },
  // Factores
  { ticker: "MTUM", keywords: ["momentum factor","momentum stocks","mtum"] },
  { ticker: "QUAL", keywords: ["quality factor","quality stocks","qual etf"] },
  { ticker: "VTV",  keywords: ["value stocks","value factor","value investing","vtv"] },
  { ticker: "VUG",  keywords: ["growth stocks","growth factor","vug"] },
  { ticker: "USMV", keywords: ["low volatility","minimum volatility","defensive stocks","usmv"] },
  { ticker: "IWF",  keywords: ["large cap growth","russell 1000 growth","iwf"] },
];

// ── Guarda: la tabla tiene que cubrir el universo ──────────────────────────
// Si mañana se agrega un instrumento al JSON y nadie le escribe keywords acá,
// ese instrumento NO puede recibir sentimiento — y el síntoma es "s/d" eterno,
// no un error. Este aviso al arrancar es lo único que lo delata.
{
  const cubiertos = new Set(TICKER_MAP.map(t => t.ticker));
  const sinCubrir = TICKERS_SENT.filter(t => !cubiertos.has(t));
  if (sinCubrir.length)
    console.warn(`[class45] ⚠️ ${sinCubrir.length} instrumentos del universo SIN keywords ` +
                 `— no van a recibir sentimiento nunca: ${sinCubrir.join(", ")}. ` +
                 `Agregarlos a TICKER_MAP.`);
  else
    console.log(`[class45] ✅ keywords para los ${cubiertos.size} instrumentos del universo`);
  const deMas = [...cubiertos].filter(t => !TICKERS_SENT.includes(t));
  if (deMas.length)
    console.log(`[class45] ℹ️ ${deMas.length} con keywords que ya no están en el universo: ` +
                `${deMas.join(", ")} — inofensivo, pero se puede limpiar`);
}

// ── Ventana acumuladora de artículos por ticker ───────────────
// REGLA DE DISEÑO: el TTL debe cubrir el tiempo que tardan en llegar WINDOW_SIZE
// artículos del MISMO sector. Si expiran más rápido de lo que llegan, la ventana
// nunca alcanza el mínimo y el sector queda sin sentimiento PARA SIEMPRE.
//
// Historia: con SIZE=3 / TTL=30min era imposible juntar 3 noticias de un sector en
// media hora (class1 trae pocas: come HTTP 429 de Google). Sólo llegaban a 3 los
// tickers que el bug de keywords cortas ("ai"/"ev"/"bac") matcheaba en TODA
// noticia — el ruido era lo único que producía sentimiento. Arreglada la
// detección, ese TTL habría dejado la columna Sent. vacía de forma permanente.
//
// Calibrado para el caudal real (~1 artículo por sector por día):
//   · 2 artículos tardan ~2 días en llegar → TTL de 72h los cubre con margen.
//   · Esperados en ventana ≈ tasa × TTL = 1/día × 3 días = 3 ≥ SIZE=2. ✔
// Trade-off asumido: evidencia más fina (2 artículos) y de hasta 3 días. Con este
// caudal no se puede tener cobertura Y frescura — se elige cobertura, porque un
// sentimiento tibio pero REAL vale más que un "s/d" eterno.
const WINDOW_SIZE   = 2;                    // artículos por ticker antes de publicar
const WINDOW_TTL_MS = 72 * 60 * 60 * 1000;  // 72h: ventana de acumulación
const CONF_UMBRAL   = 0.30;  // umbral bajado: 0.30 es suficiente para señal útil
const MAX_TEXT_LEN  = 2000;  // truncar artículos grandes para evitar crash en sentiment

const ventanas = new Map();   // ticker → [{ score, ts }]

// ── Anti-ráfaga ────────────────────────────────────────────────
// (1) Dedup de artículos por título: class1 re-publica los MISMOS artículos al
//     bus en cada ciclo de búsqueda (su dedup por hash solo frena la DB, no
//     Redis). Sin esto, un artículo re-entraba a la ventana una y otra vez —
//     caso real: "Spain beat Argentina" generó 56 señales ARGT idénticas.
// (2) Cooldown de emisión por ticker: la ventana emitía CADA vez que llegaba a
//     WINDOW_SIZE (una tanda de 30 noticias de energía → 15 señales XLE en 1
//     minuto). Con cooldown, la ventana sigue acumulando y emite como mucho una
//     señal por ticker cada EMIT_COOLDOWN_MS — con MÁS evidencia, no menos.
const _vistos          = new Set();            // títulos ya procesados (FIFO acotado)
const _VISTOS_MAX      = 500;
const _emitidoUlt      = new Map();            // ticker → ts de última emisión
const EMIT_COOLDOWN_MS = 10 * 60 * 1000;       // máx. 1 señal por ticker cada 10 min

function getVentana(ticker) {
  if (!ventanas.has(ticker)) ventanas.set(ticker, []);
  const now = Date.now();
  // Purgar artículos fuera de TTL
  const fresh = ventanas.get(ticker).filter(e => now - e.ts < WINDOW_TTL_MS);
  ventanas.set(ticker, fresh);
  return fresh;
}

// ── Análisis de un artículo ────────────────────────────────────
function analizarTexto(texto) {
  if (!texto || typeof texto !== "string") return { score: 0, comparative: 0, kws: [] };

  const lower = texto.toLowerCase();

  // Score AFINN base
  const base = sentiment.analyze(texto);

  // Bonus por keywords financieras, escalado por el peso adaptativo de cada
  // keyword (1.0 = sin ajuste; sube si esa keyword viene acertando, baja si confunde)
  let bonus = 0;
  const kws = [];
  for (const [kw, weight] of Object.entries(MARKET_KEYWORDS)) {
    if (lower.includes(kw)) {
      bonus += weight * _pesoKeyword(kw);
      kws.push(kw);
    }
  }

  // bonus * 0.5 (antes 0.3): con titulares cortos el comparative de AFINN es
  // minúsculo (±0.1 típico) y el bonus de keywords era casi todo el señal útil.
  const rawScore = base.comparative + bonus * 0.5;
  return { score: rawScore, words: base.words, bonus, kws };
}

// ── Tickers dinámicos (pedidos on-demand desde el chat) ─────────
// El chatbot publica en class45_track {ticker, keywords} cuando el usuario
// pregunta por un activo específico (ej: YPF). class45 lo agrega a su mapa
// de detección para etiquetar noticias y emitir sentimiento de ESE activo,
// no solo de los 7 sectores fijos. Persiste entre reinicios.
const DYN_TICKERS_FILE = path.join(STATE_DIR, "class45_dynamic_tickers.json");
const dynamicTickers = new Map();   // ticker → keywords[]

function _loadDynamicTickers() {
  try {
    if (fs.existsSync(DYN_TICKERS_FILE)) {
      const d = JSON.parse(fs.readFileSync(DYN_TICKERS_FILE, "utf8")) || {};
      for (const [t, kws] of Object.entries(d)) dynamicTickers.set(t, kws);
      if (dynamicTickers.size)
        log(`Tickers dinámicos cargados: ${[...dynamicTickers.keys()].join(", ")}`);
    }
  } catch (e) { log(`_loadDynamicTickers: ${e.message}`, "warn"); }
}
function _saveDynamicTickers() {
  try {
    fs.writeFileSync(DYN_TICKERS_FILE,
      JSON.stringify(Object.fromEntries(dynamicTickers), null, 2));
  } catch (_) {}
}
function registrarTickerDinamico(ticker, keywords = []) {
  const T = String(ticker || "").toUpperCase();
  if (!T) return;
  // Mínimo 3 caracteres: la detección es por substring (includes), y una
  // keyword de 2 letras como "ko" matchearía dentro de "kosovo"/"kodak",
  // etiquetando noticias ajenas al activo.
  const kws = [...new Set([T.toLowerCase(), ...keywords.map(k => String(k).toLowerCase())])]
    .filter(k => k.length >= 3);
  if (!kws.length) { log(`⚠️ Ticker dinámico ${T} sin keywords válidas (≥3 chars) — ignorado`, "warn"); return; }
  dynamicTickers.set(T, kws);
  _saveDynamicTickers();
  log(`🎯 Ticker dinámico registrado: ${T} [${kws.join(", ")}]`);
}
_loadDynamicTickers();

function detectarTickers(texto) {
  if (!texto) return [];
  const lower = texto.toLowerCase();
  const found = new Set();
  for (const { ticker, keywords } of TICKER_MAP) {
    if (keywords.some(kw => lower.includes(kw))) found.add(ticker);
  }
  // Tickers dinámicos pedidos desde el chat
  for (const [ticker, keywords] of dynamicTickers) {
    if (keywords.some(kw => lower.includes(kw))) found.add(ticker);
  }
  return [...found];
}

// Normaliza score crudo a [-1, +1] con tanh.
// Divisor 0.75 (antes 3): con la escala anterior un BULLISH exigía media de
// score crudo > 0.77, algo inalcanzable con titulares — el 100% de las señales
// guardadas en sentiment_signals salía NEUTRAL con score 0.00–0.03. Con /0.75
// una media de 0.15 (un par de keywords en la ventana) ya produce ~0.20.
function normalizar(score) {
  return Math.tanh(score / 0.75);
}

// Umbral ±0.15 (antes ±0.25): coherente con la nueva escala; score exactamente
// 0 sigue siendo NEUTRAL, pero evidencia real de keywords ya mueve la etiqueta.
function etiqueta(normScore) {
  if (normScore >  0.15) return "BULLISH";
  if (normScore < -0.15) return "BEARISH";
  return "NEUTRAL";
}

// ── Construcción y publicación de señal ───────────────────────
function construirSeñal(ticker, ventana) {
  const scores  = ventana.map(e => e.score);
  const media   = scores.reduce((a, b) => a + b, 0) / scores.length;
  const normSc  = normalizar(media);
  const absNorm = Math.abs(normSc);
  const label   = etiqueta(normSc);
  // Keywords únicas de todos los artículos de la ventana — se guardan junto a la
  // señal para poder atribuirles el acierto/error cuando se verifique el outcome real.
  const kwsVentana = [...new Set(ventana.flatMap(e => e.kws || []))];

  return {
    tipo:            "sentimiento_noticias",
    fuente:          "class45",
    ticker,
    señal:           label === "BULLISH" ? "BUY" : label === "BEARISH" ? "SELL" : "HOLD",
    confianza:       parseFloat(absNorm.toFixed(4)),
    sentiment_score: parseFloat(normSc.toFixed(4)),
    sentiment_label: label,
    n_articulos:     ventana.length,
    keywords:        kwsVentana,
    ts:              new Date().toISOString(),
  };
}

// ── Procesamiento de mensajes de class1 ───────────────────────
function procesarArticulo(rawMsg) {
  try {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // class1 puede envolver en {tipo, payload} o publicar directamente
    // También puede ser un array de artículos
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.resultados)
        ? data.resultados
        : [data.payload ?? data];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      // class1 anida el resultado en item.data.data (envelope DSL)
      const nested     = item.data?.data || item.data || {};
      const tituloRaw  = String(item.titulo  || item.title   || nested.title   || nested.titulo  || "");
      const snippetRaw = String(item.snippet || item.extract || nested.snippet || nested.description || nested.descripcion || item.text || item.resumen || "");
      // Truncar para evitar que sentiment.analyze() se cuelgue con textos enormes
      const texto = `${tituloRaw} ${snippetRaw}`.slice(0, MAX_TEXT_LEN);

      if (!texto.trim()) continue;

      // Dedup por título (ver bloque Anti-ráfaga): mismo artículo → una sola vez.
      const _hTit = tituloRaw.trim().toLowerCase().slice(0, 80);
      if (_hTit) {
        if (_vistos.has(_hTit)) continue;
        _vistos.add(_hTit);
        if (_vistos.size > _VISTOS_MAX) _vistos.delete(_vistos.values().next().value);
      }

      const tickers = detectarTickers(texto);
      if (tickers.length === 0) continue;

      const { score, kws } = analizarTexto(texto);
      log(`Artículo → [${tickers}] score=${score.toFixed(2)} | "${tituloRaw.slice(0, 50)}"`);

      for (const ticker of tickers) {
        const ventana = getVentana(ticker);
        ventana.push({ score, ts: Date.now(), kws });

        if (ventana.length >= WINDOW_SIZE) {
          // Cooldown de emisión (ver bloque Anti-ráfaga): si emitimos hace poco,
          // NO publicar todavía — la ventana se conserva y sigue acumulando
          // evidencia; la señal saldrá al pasar el cooldown, más informada.
          const _ahora = Date.now();
          if (_ahora - (_emitidoUlt.get(ticker) || 0) < EMIT_COOLDOWN_MS) continue;
          _emitidoUlt.set(ticker, _ahora);
          const señal = construirSeñal(ticker, ventana);
          ventana.length = 0;

          // Antes: si la confianza no superaba CONF_UMBRAL, la ventana entera se
          // descartaba SIN publicar nada — el frontend nunca recibía ni siquiera
          // un NEUTRAL para ese ticker, dejando sentState vacío la mayor parte
          // del tiempo. Ahora siempre se publica (NEUTRAL/baja confianza incluido)
          // para que el dashboard tenga un dato real y actualizado por ticker.
          publicar(señal).catch(() => {});
          if (señal.confianza < CONF_UMBRAL) {
            log(`[${ticker}] Sentimiento de baja confianza conf=${señal.confianza.toFixed(3)} (publicado como ${señal.sentiment_label})`);
          }
        }
      }
    }
  } catch (e) {
    log(`❌ procesarArticulo: ${e.message}`, "error");
  }
}

// ── Redis ──────────────────────────────────────────────────────
const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

redisSub.on("connect", () => log("Redis SUB conectado"));
redisPub.on("connect", () => log("Redis PUB conectado"));
redisSub.on("error",   e  => log(`Redis SUB: ${e.message}`, "warn"));
redisPub.on("error",   e  => log(`Redis PUB: ${e.message}`, "warn"));

async function publicar(payload) {
  const msg = JSON.stringify(payload);
  redisPub.publish(CH_OUT,        msg).catch(() => {});
  redisPub.publish(CH_OUT_CRISIS, msg).catch(() => {});
  log(`Señal publicada → ${payload.ticker} ${payload.señal} conf=${payload.confianza}`);

  // Precio de entrada — referencia para verificar más tarde si BULLISH/BEARISH acertó
  let precioEntrada = null;
  try {
    const p = await obtenerPrecioActual(payload.ticker);
    precioEntrada = p?.precio != null ? parseFloat(p.precio) : null;
  } catch (_) {}

  // Persistir en MySQL
  guardarSentimientoSignal({
    ticker:          payload.ticker,
    senal:           payload.señal,
    sentiment_label: payload.sentiment_label,
    sentiment_score: payload.sentiment_score,
    confianza:       payload.confianza,
    n_articulos:     payload.n_articulos || 0,
    publicado:       1,
    keywords:        payload.keywords || [],
    precio_entrada:  precioEntrada,
  }).catch(() => {});
  logSistema({
    fuente:  "class45",
    nivel:   "info",
    evento:  "sentimiento_publicado",
    mensaje: `${payload.ticker} → ${payload.señal} (${payload.sentiment_label}) conf=${payload.confianza}`,
    ticker:  payload.ticker,
    canal_redis: CH_OUT,
  }).catch(() => {});
}

// Publicar estado periódico + heartbeat a class45_output
// class48 monitorea class45_output con 90min timeout. Si no hay noticias
// procesadas, class45 publicará un heartbeat para que class48 no lo declare muerto.
function publicarEstado() {
  const ts   = new Date().toISOString();
  const est  = {
    fuente:   "class45",
    ts,
    ventanas: Object.fromEntries(
      [...ventanas.entries()].map(([t, v]) => [t, v.length])
    ),
  };
  redisPub.publish("class45_estado",  JSON.stringify(est)).catch(() => {});
  // Heartbeat mínimo a class45_output para mantener class48 satisfecho
  redisPub.publish("class45_output", JSON.stringify({
    tipo:            "heartbeat",
    fuente:          "class45",
    ticker:          "GENERAL",
    señal:           "HOLD",
    confianza:       0,
    sentiment_score: 0,
    sentiment_label: "NEUTRAL",
    n_articulos:     0,
    ts,
    _heartbeat:      true,
  })).catch(() => {});
}

// ── Suscripciones ──────────────────────────────────────────────
const CH_TRACK = "class45_track";   // registro de tickers dinámicos desde el chat
await redisSub.subscribe(CH_IN_NEWS, CH_IN_TRIG, CH_TRACK);

redisSub.on("message", (channel, msg) => {
  if (channel === CH_IN_NEWS || channel === CH_IN_TRIG) {
    procesarArticulo(msg);
  } else if (channel === CH_TRACK) {
    try {
      const d = JSON.parse(msg);
      registrarTickerDinamico(d.ticker, d.keywords || []);
      // Analizar de inmediato las noticias ya guardadas en DB con el mapa
      // ampliado — así el sentimiento del activo aparece sin esperar 10 min
      analizarSectoresDesdeDB().catch(() => {});
    } catch (_) {}
  }
});

// ── Trigger periódico a class1 ─────────────────────────────────
// class1 solo busca cuando recibe un trigger. Si nadie lo envía,
// class45 nunca recibe artículos y queda silencioso.
// class45 envía un trigger propio cada 30 minutos para mantener
// el flujo de noticias activo sin depender de señales externas.
let _rotEtf = 0;   // rotación de los ETF que se piden a class1 por trigger
async function triggerClass1() {
  // Combinar búsquedas de ETFs + noticias generales financieras
  // Sale del universo, no de una lista a mano de 7. Y ROTA: pedir 50 queries de
  // una agota la cuota de class1 en una sola corrida (el tope son 25 términos),
  // así que se consultan 6 por vez y el universo entero se cubre en ~9 triggers,
  // o sea ~4,5 h con el trigger de 30 min.
  const CUPO_ETF = Number(process.env.SENT_ETF_POR_TRIGGER || 6);
  const _n   = TICKERS_SENT.length;
  const _rot = (_rotEtf * CUPO_ETF) % Math.max(1, _n);
  _rotEtf++;
  const etfQueries = [...TICKERS_SENT.slice(_rot), ...TICKERS_SENT.slice(0, _rot)]
    .slice(0, CUPO_ETF)
    .map(t => `${t} stock news today`);

  // Noticias generales de mercados argentinos y globales
  const newsQueries = [
    "Argentina mercado bolsa noticias hoy",
    "Wall Street stocks news today",
    "Federal Reserve interest rates news",
    "S&P 500 market update",
    "Argentina riesgo pais economia noticias",
    "Brazil economy markets news",
    "commodities oil gold news today",
  ];

  // Alternar: en número impar de minutos → ETFs, par → noticias generales
  const minuto = new Date().getMinutes();
  const queries = minuto % 2 === 0 ? etfQueries : newsQueries;

  const payload = JSON.stringify({
    origen:  "class45",
    motivo:  "periodic_sentiment",
    ticker:  "GENERAL",
    queries,
    ts:      new Date().toISOString(),
  });
  try {
    await redisPub.publish("class1_trigger", payload);
    log(`🔔 Trigger enviado a class1 (${queries.length} búsquedas, ciclo ${minuto%2===0?"ETF":"noticias"})`);
  } catch (e) {
    log(`⚠️ Error enviando trigger a class1: ${e.message}`, "warn");
  }
}

// ── Verificación de outcomes + entrenamiento online ──────────────
// Revisa señales publicadas hace VERIFY_HORAS_MIN–VERIFY_HORAS_MAX horas que
// todavía no tienen outcome_real, compara el precio actual del ticker contra
// el precio_entrada guardado al publicar, decide si la predicción acertó, y
// ajusta el peso (keywordWeights) de cada keyword que participó en esa señal.
// Esto es lo que hace que class45 "entrene" con el tiempo en vez de usar
// siempre los mismos pesos fijos de MARKET_KEYWORDS.
const VERIFY_HORAS_MIN  = 4;     // dar tiempo a que el precio se mueva
const VERIFY_HORAS_MAX  = 72;    // no verificar señales demasiado viejas
const UMBRAL_MOVIMIENTO = 0.3;   // % mínimo de cambio para considerar que el precio "se movió"
const UMBRAL_NEUTRAL    = 1.5;   // % de cambio a partir del cual un NEUTRAL se considera fallado

async function verificarYEntrenar() {
  try {
    const pendientes = await obtenerSentimientoPendienteVerificar(VERIFY_HORAS_MIN, VERIFY_HORAS_MAX);
    if (!pendientes.length) return;

    let verificadas = 0, ajustes = 0;
    for (const row of pendientes) {
      const precioActual = await obtenerPrecioActual(row.ticker);
      if (!precioActual?.precio || !row.precio_entrada) continue;

      const entrada = parseFloat(row.precio_entrada);
      const actual  = parseFloat(precioActual.precio);
      if (!entrada || !Number.isFinite(actual)) continue;
      const cambioPct = ((actual - entrada) / entrada) * 100;

      let outcome;
      if (row.sentiment_label === "BULLISH") {
        outcome = cambioPct >  UMBRAL_MOVIMIENTO ? "correcto"
                : cambioPct < -UMBRAL_MOVIMIENTO ? "incorrecto" : "neutral";
      } else if (row.sentiment_label === "BEARISH") {
        outcome = cambioPct < -UMBRAL_MOVIMIENTO ? "correcto"
                : cambioPct >  UMBRAL_MOVIMIENTO ? "incorrecto" : "neutral";
      } else {
        outcome = Math.abs(cambioPct) <= UMBRAL_NEUTRAL ? "correcto" : "incorrecto";
      }

      const ok = await actualizarOutcomeSentimiento(row.id, outcome);
      if (!ok) continue;
      verificadas++;

      // Ajustar el peso de cada keyword que participó en esta señal
      if (outcome !== "neutral") {
        let kws = [];
        try { kws = JSON.parse(row.keywords_json || "[]"); } catch (_) {}
        for (const kw of kws) { _ajustarPeso(kw, outcome === "correcto"); ajustes++; }
      }
    }

    if (verificadas > 0) {
      _saveWeights();
      log(`🎓 Entrenamiento: ${verificadas} señales verificadas (${VERIFY_HORAS_MIN}-${VERIFY_HORAS_MAX}h), ${ajustes} ajustes de peso aplicados`);
    }
  } catch (e) {
    log(`❌ verificarYEntrenar: ${e.message}`, "error");
  }
}

// ── Lectura/corrección de la tabla noticias (MySQL, vía class42) ─────────
// class1 guarda cada artículo en `noticias` con un sentimiento adivinado por
// keywords simples (no es el motor real). class45 ahora lee esa tabla con
// obtenerNoticias() y, cuando su propio análisis (AFINN + pesos adaptativos)
// difiere del valor guardado, lo corrige con actualizarNoticiaSentimiento().
// Así el dashboard (que lee /api/noticias directo de esta tabla) termina
// mostrando el sentimiento real de class45 en vez de la estimación de class1.
const _noticiasDBVistas = new Set();   // ids ya evaluados en esta sesión (evita reprocesar)

async function sincronizarNoticiasDB() {
  try {
    const rows = await obtenerNoticias({ limit: 50 });
    if (!rows.length) return;

    let corregidas = 0, evaluadas = 0;
    for (const row of rows) {
      if (_noticiasDBVistas.has(row.id)) continue;
      _noticiasDBVistas.add(row.id);

      const texto = `${row.titulo || ""} ${row.snippet || ""}`.slice(0, MAX_TEXT_LEN);
      if (!texto.trim()) continue;

      const { score } = analizarTexto(texto);
      const labelReal = etiqueta(normalizar(score));
      evaluadas++;

      if (labelReal !== row.sentimiento) {
        const ok = await actualizarNoticiaSentimiento(row.id, labelReal);
        if (ok) corregidas++;
      }
    }

    // Evitar que el Set de vistos crezca sin límite en sesiones muy largas
    if (_noticiasDBVistas.size > 3000) {
      const it = _noticiasDBVistas.values();
      for (let i = 0; i < 1000; i++) _noticiasDBVistas.delete(it.next().value);
    }

    if (evaluadas > 0) {
      log(`📰 DB noticias: ${evaluadas} evaluadas, ${corregidas} sentimientos corregidos (class1 estimado → class45 real)`);
    }
  } catch (e) {
    log(`❌ sincronizarNoticiasDB: ${e.message}`, "error");
  }
}

// ── Sentimiento por sector desde la tabla noticias (DB) ─────────────────
// El flujo Redis (class1_output → ventanas) solo emite señal cuando llegan
// 3 artículos frescos del MISMO ticker en 30 min — con pocas noticias eso
// deja a la mayoría de los sectores sin sentimiento ("–" en el dashboard).
// Esta pasada lee las noticias ya guardadas en MySQL, detecta a qué sectores
// aplica cada una (columna ticker + keywords en título/snippet) y publica una
// señal agregada por sector aunque no haya tráfico nuevo en Redis.
const NEWS_DB_HORAS = 48;          // ventana de noticias consideradas
const REPUB_MIN_MS  = 2 * 3600_000; // re-publicar sin cambios como máximo cada 2h
const _ultimaSeñalDB = new Map();   // ticker → { label, score, ts }

async function analizarSectoresDesdeDB() {
  try {
    const rows = await obtenerNoticias({ limit: 100 });
    if (!rows.length) return;

    const corte = Date.now() - NEWS_DB_HORAS * 3600_000;
    const porTicker = new Map();

    for (const row of rows) {
      const tsRow = new Date(row.ts_publicado || row.ts_guardado).getTime();
      if (Number.isFinite(tsRow) && tsRow < corte) continue;

      const texto = `${row.titulo || ""} ${row.snippet || ""}`.slice(0, MAX_TEXT_LEN);
      if (!texto.trim()) continue;

      const tickers = new Set(detectarTickers(texto));
      if (row.ticker && row.ticker !== "GENERAL")
        tickers.add(String(row.ticker).toUpperCase());
      if (!tickers.size) continue;

      const { score, kws } = analizarTexto(texto);
      for (const t of tickers) {
        if (!porTicker.has(t)) porTicker.set(t, []);
        porTicker.get(t).push({ score, ts: Date.now(), kws });
      }
    }

    let publicadas = 0;
    for (const [ticker, arts] of porTicker) {
      const señal = construirSeñal(ticker, arts);
      señal.origen_datos = "noticias_db";

      // Dedup: publicar solo si la etiqueta o el score cambiaron, o si pasó
      // REPUB_MIN_MS desde la última publicación (refresco de "vigencia")
      const prev = _ultimaSeñalDB.get(ticker);
      const cambio = !prev
        || prev.label !== señal.sentiment_label
        || Math.abs(prev.score - señal.sentiment_score) > 0.05
        || Date.now() - prev.ts > REPUB_MIN_MS;
      if (!cambio) continue;

      _ultimaSeñalDB.set(ticker, {
        label: señal.sentiment_label,
        score: señal.sentiment_score,
        ts:    Date.now(),
      });
      await publicar(señal);
      publicadas++;
    }

    if (porTicker.size) {
      const detalle = [...porTicker.entries()].map(([t, a]) => `${t}(${a.length})`).join(", ");
      log(`🗞️ Sentimiento por sector desde DB noticias: ${detalle} — ${publicadas} señales publicadas`);
    }
  } catch (e) {
    log(`❌ analizarSectoresDesdeDB: ${e.message}`, "error");
  }
}

// Trigger inmediato al arrancar (delay de 5s para que class1 esté listo)
setTimeout(triggerClass1, 5_000);

// Trigger periódico cada 30 minutos
setInterval(triggerClass1, 30 * 60_000);

// Verificación/entrenamiento: primera pasada a los 2 min (deja tiempo a que
// haya señales con precio_entrada), después cada 20 min
setTimeout(verificarYEntrenar, 2 * 60_000);
setInterval(verificarYEntrenar, 20 * 60_000);

// Sincronizar tabla noticias: primera pasada a los 90s, después cada 15 min
setTimeout(sincronizarNoticiasDB, 90_000);
setInterval(sincronizarNoticiasDB, 15 * 60_000);

// Sentimiento por sector desde DB noticias: primera pasada a los 60s
// (apenas conecta MySQL), después cada 10 min
setTimeout(analizarSectoresDesdeDB, 60_000);
setInterval(analizarSectoresDesdeDB, 10 * 60_000);

// Estado cada 2 min (antes era 5 → class48 lo daba por muerto antes del primer heartbeat)
setInterval(publicarEstado, 2 * 60_000);
publicarEstado(); // publicar inmediatamente al arrancar

// Handlers globales para evitar crash silencioso
process.on("uncaughtException",  e => log(`❌ uncaughtException: ${e.message}`, "error"));
process.on("unhandledRejection", e => log(`❌ unhandledRejection: ${String(e)}`, "error"));

log("class45 — Motor de Sentimiento de Noticias activo");
log(`Escuchando: ${CH_IN_NEWS}, ${CH_IN_TRIG}`);
log(`Publicando: ${CH_OUT}, ${CH_OUT_CRISIS}`);
log(`Ventana: ${WINDOW_SIZE} artículos | Umbral: ${CONF_UMBRAL} | TextMax: ${MAX_TEXT_LEN} chars`);
log("🔔 Trigger automático a class1: al arrancar + cada 30 min");
log("📰 Sincronización con tabla noticias (class42): a los 90s + cada 15 min");
