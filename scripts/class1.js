// ============================================================
// class1.js — Buscador autónomo con salida Redis (MIIA)
// VERSIÓN CORREGIDA v1.9.1
//
// Correcciones aplicadas:
//   1. cheerio eliminado — buscarEnGoogle ahora delega a buscarGoogle (API)
//   2. _enviarResultadoRedis y _publicarRedis unificados en un solo publish
//   3. contract.ini centralizado en una función (leerContrato)
//   4. startMicroservice no puede lanzarse dos veces (flag iniciado)
//   5. Términos de búsqueda configurables desde la web via Redis
//
// NUEVO: Criterios de búsqueda configurables desde interfaz web
//   Canal de entrada: "class1_user_queries"
//   Formato: { accion: "add"|"remove"|"replace"|"list", terminos: [...] }
//   Los términos se persisten en config/user_queries.json
// ============================================================

import fs   from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import axios      from "axios";
import Bottleneck from "bottleneck";
import { createClient } from "redis";
import EventEmitter     from "events";
import ini              from "ini";
import crypto           from "crypto";
import { getStorageConfig, getLoggingConfig } from "./class38.js";
import { guardarNoticia } from "./class42.js";
// FUENTE ÚNICA del universo. `TICKERS_NOTICIAS` es el subconjunto que se
// consulta a los proveedores de noticias (hoy los 50); `INSTRUMENTOS` trae el
// sector de cada uno, que es de donde sale la frase cuando no hay una escrita.
import { TICKERS_NOTICIAS, INSTRUMENTOS, resumenUniverso } from "./universo.js";

// ── ESM dirname ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir    = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR   = path.join(baseDir, "logs");
const JSON_DIR   = path.join(baseDir, "json_guardados");
const RAW_DIR    = path.join(baseDir, "raw");
const METRICS_DIR = path.join(baseDir, "metrics");
const CONFIG_DIR = path.join(baseDir, "config");
const BUSQUEDAS_DIR = path.join(baseDir, "resultados_busqueda");

for (const dir of [LOGS_DIR, JSON_DIR, RAW_DIR, METRICS_DIR, CONFIG_DIR, BUSQUEDAS_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.error(`[class1] mkdir ${dir}:`, e.message); }
}

const NOMBRE_CLASE = "class1";
const LOG_FILE     = path.join(LOGS_DIR, `${NOMBRE_CLASE}.log`);
const USER_QUERIES_FILE = path.join(CONFIG_DIR, "user_queries.json");

// ── Config desde class38 ───────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
const logCfg     = (() => { try { return getLoggingConfig()  || {}; } catch { return {}; } })();

// ── Redis channels ─────────────────────────────────────────
const redisConfig = {
  url:            "redis://localhost:6379",
  outputChannel:  "class1_output",
  exportChannel:  "class3_ingest",    // DSL: destino principal de resultados
};

const TRIGGER_CHANNEL    = "class1_trigger";       // trigger de búsqueda inmediata
const USER_QUERIES_CH    = "class1_user_queries";  // ← NUEVO: configuración desde la web

// ── API Keys — SOLO desde config/.env (cargado por class38) ─
// class38 se importa arriba, por lo que process.env ya tiene el .env
// cargado cuando se evalúa este objeto.
export const API_KEYS = {
  google:  { key: process.env.GOOGLE_SEARCH_KEY || "", cx: process.env.GOOGLE_SEARCH_CX || "" },
  bing:    process.env.BING_KEY    || "",
  newsapi: process.env.NEWSAPI_KEY || "",
  finnhub: process.env.FINNHUB_KEY || "",
};

// ── Redis clients ──────────────────────────────────────────
const redisClient     = createClient({ url: redisConfig.url });
const redisSubscriber = createClient({ url: redisConfig.url });

redisClient.on    ("error", e => console.error(`[class1] Redis error: ${e.message}`));
redisSubscriber.on("error", e => console.error(`[class1] RedisSub error: ${e.message}`));

// ── Logger ──────────────────────────────────────────────────
const MAX_LOG_SIZE = 5 * 1024 * 1024;

async function guardarEvento(tipo, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tipo, payload }) + "\n";
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = await fs.promises.stat(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE)
        await fs.promises.rename(LOG_FILE, `${LOG_FILE}.${Date.now()}.bak`);
    }
    await fs.promises.appendFile(LOG_FILE, line, "utf8");
  } catch (e) {
    console.error("[class1] Error guardando log:", e.message);
  }
}

// ── Leer contract.ini (centralizado — antes duplicado 3 veces) ──
function leerContrato() {
  try {
    const contractPath = path.join(CONFIG_DIR, "contract.ini");
    if (!fs.existsSync(contractPath)) return { targetChannel: redisConfig.exportChannel, envelopeType: "plain" };
    const raw      = fs.readFileSync(contractPath, "utf8");
    const contract = ini.parse(raw);
    return {
      targetChannel: contract.contract?.target_channel?.trim() || redisConfig.exportChannel,
      envelopeType:  contract.contract?.envelope?.trim().toLowerCase() || "plain",
    };
  } catch (_) {
    return { targetChannel: redisConfig.exportChannel, envelopeType: "plain" };
  }
}

// ── Clasificar un artículo: texto, instrumento y sentimiento ───
//
// Esto estaba escrito DOS VECES con la misma regex —una para `class1_output` y
// otra para la tabla `noticias`— así que una corrección en una no llegaba a la
// otra. Desde el 26-sep-2026 hay un tercer consumidor, el envelope de
// `class3_ingest`, que necesita el instrumento: se centraliza en un solo lugar.
const RE_ALZA = /rally|surge|soar|gain|rise|record|bullish|grow|profit|recover|beat/;
const RE_BAJA = /crash|fall|drop|decline|loss|risk|crisis|bankrupt|recession|panic/;

function clasificarNoticia(art) {
  const titulo  = art?.title   || art?.titulo      || "";
  const snippet = art?.snippet || art?.description || art?.descripcion || "";
  const tl      = titulo.toLowerCase();
  const alza    = RE_ALZA.test(tl);
  const baja    = RE_BAJA.test(tl);
  return {
    titulo,
    snippet,
    // EL TEXTO DE LA NOTICIA, que es lo que class3 vectoriza.
    //
    // Hasta el 26-sep-2026 el envelope llevaba la FRASE DE BÚSQUEDA ("XLK
    // technology sector ETF"), que es casi idéntica en cada corrida: el vector
    // TF-IDF salía prácticamente constante y class19 lo habría descartado por
    // redundante (dedup + cambio mínimo). El titular más el copete es lo que
    // varía, y es lo que Martín pidió que class3 procese.
    texto:       `${titulo}. ${snippet}`.trim().slice(0, 1000),
    // Sólo el título, igual que antes: buscar el ticker también en el copete
    // multiplica los falsos positivos (un titular de XLK que menciona a XLE).
    ticker:      TICKERS_ORDENADOS.find(t => tl.includes(t.toLowerCase())) || null,
    sentimiento: alza && !baja ? "BULLISH" : baja && !alza ? "BEARISH" : "NEUTRAL",
  };
}

// ── Construir envelope DSL ─────────────────────────────────
function buildEnvelope(text, data, envelopeType = "plain", symbol = null) {
  const base = {
    id:     crypto.randomUUID(),
    source: "class1",
    type:   "analysis",
    texto:  text,   // campo "texto" del DSL (class3_ingest espera esto)
    text,           // compatibilidad
    data,
    ts:     new Date().toISOString(),
  };
  // El instrumento va en la RAÍZ, que es donde lo lee class3 y después class19.
  //
  // ⚠️ Cuando no hay instrumento NO se manda el campo. Mandar la cadena
  // "GENERAL" es la regresión que se cazó en class18 el 26-sep: class19 elige
  // la métrica de cambio con `symbol !== null` (class19.js:249), así que un
  // "GENERAL" literal le cambia el filtro a todo lo que no tiene instrumento.
  if (symbol) { base.symbol = symbol; base.ticker = symbol; }
  if (envelopeType === "jsonld") {
    const ld = { "@context": "https://example.org/miia/context", "@type": "analysis",
                 timestamp: base.ts, source: "class1", data, id: base.id };
    if (symbol) { ld.symbol = symbol; ld.ticker = symbol; }
    return ld;
  }
  return base;
}

// ══════════════════════════════════════════════════════════
// TÉRMINOS DE BÚSQUEDA CONFIGURABLES DESDE LA WEB
//
// Se persisten en config/user_queries.json.
// La web publica en "class1_user_queries":
//   { accion: "add",     terminos: ["AAPL precio"] }
//   { accion: "remove",  terminos: ["AAPL precio"] }
//   { accion: "replace", terminos: ["nuevo1", "nuevo2"] }
//   { accion: "list" }   → responde en "class1_queries_response"
//
// Términos por defecto (se usan si no hay términos de usuario)
// ══════════════════════════════════════════════════════════

// 7 temas fijos, uno por sector/mercado que sigue MIIA (XLK, XLF, XLE, XLV, XLY,
// ARGT, EWZ). La frescura la garantizan los adaptadores (Google sort=date +
// dateRestrict, NewsAPI sortBy=publishedAt + from), no la query.
// 13 sectores, uno por cada ETF que sigue MIIA (mismos que el TICKER_MAP de
// class45). Antes eran solo 7: los 6 sectores agregados a class45 (XLI, XLB,
// XLRE, XLU, XLC, ILF) NUNCA se buscaban, así que quedaban en "s/d" de forma
// permanente — no por falta de match, sino porque no llegaba ni una noticia.
// La frescura la garantizan los adaptadores (Google sort=date + dateRestrict,
// NewsAPI sortBy=publishedAt), no la query. class45 matchea sus keywords
// (mayormente en inglés) contra los títulos que devuelven las APIs, que son
// mayormente prensa financiera en inglés — por eso una query en español como
// "petróleo energía" trae y matchea artículos como "Oil prices rise…".
// ── La lista sale del UNIVERSO, no está escrita a mano (26-sep-2026) ───────
//
// Acá había 13 frases fijas. Con el universo en 50, los otros 37 instrumentos
// no tenían cobertura de noticias NUNCA: class45 no encontraba un solo titular
// para ellos y su sentimiento quedaba en "s/d" para siempre — sin error y sin
// que nada lo dijera.
//
// Ahora la lista se deriva de `noticias` en config/universo.json. Las frases
// buenas se conservan una por una (`FRASES`), y cualquier ticker sin frase cae
// a una generada desde su campo `sector`, que es lo que el JSON ya sabe. Así
// agregar un instrumento al universo le da cobertura de noticias sin tocar este
// archivo.
//
// Están EN ESPAÑOL a propósito, pese a que class45 matchea keywords en inglés:
// lo que las APIs filtran por idioma es el titular que devuelven, no la query.
// Una búsqueda de "petróleo energía" trae y matchea "Oil prices rise…".
const FRASES = {
  XLK:  "acciones sector tecnología",
  XLF:  "acciones bancos sector financiero",
  XLE:  "petróleo energía acciones bolsa",
  XLV:  "acciones salud farmacéuticas",
  XLY:  "consumo retail acciones bolsa",
  XLI:  "acciones sector industrial manufactura aeroespacial",
  XLB:  "acciones materiales minería commodities químicos",
  XLRE: "acciones inmobiliario bienes raíces reit",
  XLU:  "acciones utilities servicios públicos energía eléctrica",
  XLC:  "acciones telecom medios streaming comunicaciones",
  XLP:  "acciones consumo básico alimentos bebidas supermercados",
  SPY:  "S&P 500 acciones wall street",
  QQQ:  "nasdaq 100 acciones tecnológicas",
  IWM:  "acciones small caps russell 2000",
  DIA:  "dow jones acciones industriales",
  EFA:  "acciones mercados desarrollados internacionales",
  EEM:  "acciones mercados emergentes",
  EWJ:  "bolsa japón nikkei acciones",
  EWG:  "bolsa alemania dax acciones",
  EWU:  "bolsa reino unido ftse acciones",
  EWL:  "bolsa suiza acciones",
  EWY:  "bolsa corea del sur kospi acciones",
  EWT:  "bolsa taiwán acciones semiconductores",
  EWH:  "bolsa hong kong hang seng acciones",
  EWA:  "bolsa australia acciones minería",
  INDA: "bolsa india sensex nifty acciones",
  FXI:  "bolsa china acciones shanghái",
  EWC:  "bolsa canadá toronto acciones",
  EWW:  "bolsa méxico ipc acciones",
  ARGT: "bolsa argentina merval acciones",
  EWZ:  "bolsa brasil bovespa acciones",
  ILF:  "acciones latinoamérica mercados emergentes",
  SMH:  "semiconductores chips acciones nvidia tsmc",
  XBI:  "biotecnología farmacéuticas acciones fda",
  VNQ:  "reit inmobiliario acciones fondos",
  XOP:  "exploración petróleo gas shale acciones",
  KRE:  "bancos regionales acciones estados unidos",
  ITB:  "construcción viviendas constructoras acciones",
  JETS: "aerolíneas acciones aviación",
  IYT:  "transporte logística ferrocarriles acciones",
  XME:  "minería metales acero acciones",
  GDX:  "mineras de oro acciones lingote",
  XRT:  "retail minorista acciones consumo",
  ARKK: "acciones innovación disruptiva tecnología",
  MTUM: "acciones factor momentum",
  QUAL: "acciones factor calidad balance",
  VTV:  "acciones valor value investing",
  VUG:  "acciones crecimiento growth",
  USMV: "acciones baja volatilidad defensivas",
  IWF:  "acciones crecimiento gran capitalización",
};

/** La frase de un ticker: la escrita a mano, o una derivada de su sector. */
function fraseDe(ticker) {
  if (FRASES[ticker]) return FRASES[ticker];
  const sector = INSTRUMENTOS.find(i => i.ticker === ticker)?.sector;
  // El fallback no es cosmético: es lo que hace que agregar un instrumento al
  // JSON le dé cobertura sin tocar este archivo. El log lo dice, así que si
  // aparece una frase pobre se ve y se mejora a mano.
  const frase = sector ? `acciones ${sector.toLowerCase()} bolsa` : `acciones ${ticker} bolsa`;
  if (!_avisadosSinFrase.has(ticker)) {
    _avisadosSinFrase.add(ticker);
    console.log(`[class1] ℹ️ ${ticker} sin frase propia — se busca "${frase}" ` +
                `(derivada del sector). Agregarla en FRASES si conviene afinarla.`);
  }
  return frase;
}
const _avisadosSinFrase = new Set();

// ── Detección del ticker en un titular ────────────────────────────────────
// Acá había DOS listas a mano de 11 símbolos, y les faltaban XLRE e ILF: dos
// instrumentos que sí se cotizan y sí se miden, cuyas noticias quedaban sin
// etiquetar. Es el mismo drift que el 21-sep encontró en class25B (que tenía
// SPY y QQQ pero no XLRE).
//
// Ordenado por largo DESCENDENTE porque la detección es `includes()`: si un
// símbolo corto es subcadena de otro más largo, probar primero el largo evita
// que el corto se lo robe. Con los 50 de hoy no hay ningún par así, pero la
// lista la edita el JSON y mañana puede haberlo.
const TICKERS_ORDENADOS = [...TICKERS_NOTICIAS].sort((a, b) => b.length - a.length);

const TERMINOS_DEFAULT = TICKERS_NOTICIAS.map(fraseDe);

function cargarTerminosUsuario() {
  try {
    if (!fs.existsSync(USER_QUERIES_FILE)) return [];
    const raw = fs.readFileSync(USER_QUERIES_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.terminos) ? data.terminos : [];
  } catch (_) { return []; }
}

function guardarTerminosUsuario(terminos) {
  try {
    fs.writeFileSync(
      USER_QUERIES_FILE,
      JSON.stringify({ terminos, ts_actualizado: new Date().toISOString() }, null, 2),
      "utf8"
    );
    console.log(`[class1] 💾 Términos guardados: ${terminos.length} términos`);
  } catch (e) {
    console.error("[class1] Error guardando términos:", e.message);
  }
}

// Índice de rotación de sectores: avanza en cada auto-búsqueda para que la
// cuota de las APIs (que se agota a mitad de corrida y devuelve 429) no
// castigue siempre a los mismos sectores del final de la lista.
let _rotacionSectores = 0;

function getTerminosActivos() {
  const userTerminos = cargarTerminosUsuario();
  return userTerminos.length > 0 ? userTerminos : TERMINOS_DEFAULT;
}

// Procesar comandos de la web interface
async function procesarComandoUsuario(mensaje) {
  try {
    const cmd = JSON.parse(mensaje);
    const accion   = cmd.accion || "";
    const terminos = Array.isArray(cmd.terminos)
      ? cmd.terminos.map(t => String(t).trim()).filter(Boolean)
      : [];

    let actuales = cargarTerminosUsuario();
    let respuesta = {};

    switch (accion) {
      case "add":
        // Agregar términos nuevos sin duplicar
        const nuevos = terminos.filter(t => !actuales.includes(t));
        actuales = [...actuales, ...nuevos];
        guardarTerminosUsuario(actuales);
        respuesta = { ok: true, accion: "add", agregados: nuevos.length, total: actuales.length };
        console.log(`[class1] ➕ Términos agregados: ${nuevos.join(", ")}`);
        break;

      case "remove":
        actuales = actuales.filter(t => !terminos.includes(t));
        guardarTerminosUsuario(actuales);
        respuesta = { ok: true, accion: "remove", total: actuales.length };
        console.log(`[class1] ➖ Términos eliminados: ${terminos.join(", ")}`);
        break;

      case "replace":
        if (terminos.length === 0) {
          respuesta = { ok: false, error: "replace requiere al menos un término" };
        } else {
          guardarTerminosUsuario(terminos);
          actuales = terminos;
          respuesta = { ok: true, accion: "replace", total: actuales.length };
          console.log(`[class1] 🔄 Términos reemplazados: ${actuales.length} términos`);
        }
        break;

      case "buscar_ahora":
        // Disparar búsqueda inmediata con los términos actuales o los provistos
        const toSearch = terminos.length > 0 ? terminos : getTerminosActivos();
        const motor = new BusquedasRealtime();
        motor.ejecutar(toSearch.slice(0, 20)).catch(e =>
          console.error("[class1] Error en búsqueda manual:", e.message)
        );
        respuesta = { ok: true, accion: "buscar_ahora", buscando: toSearch.slice(0, 20) };
        break;

      case "list":
      default:
        respuesta = {
          ok:        true,
          accion:    "list",
          terminos:  actuales,
          defaults:  TERMINOS_DEFAULT,
          usando:    actuales.length > 0 ? "usuario" : "default",
          total:     (actuales.length > 0 ? actuales : TERMINOS_DEFAULT).length,
        };
        break;
    }

    // Responder en canal de respuesta para que la web pueda mostrar el resultado
    if (redisClient.isOpen) {
      await redisClient.publish(
        "class1_queries_response",
        JSON.stringify({ ...respuesta, ts: new Date().toISOString() })
      );
    }

    await guardarEvento("user_query_cmd", respuesta);

  } catch (e) {
    console.error("[class1] Error procesando comando de usuario:", e.message);
  }
}

// ══════════════════════════════════════════════════════════
// FUNCIONES DE BÚSQUEDA
// ══════════════════════════════════════════════════════════

export async function buscarGoogle(query, timeoutMs = 8000) {
  const { key, cx } = API_KEYS.google;
  if (!key || !cx || key === "TU_API_KEY_GOOGLE") return [];
  try {
    const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: { key, cx, q: query, num: 3, sort: "date", dateRestrict: "d14" },
      timeout: timeoutMs,
    });
    return (res.data.items || []).map(i => ({
      title:   i.title,
      url:     i.link,
      snippet: i.snippet,
      source:  "google",
    }));
  } catch (e) {
    await guardarEvento("google_error", { query, error: e.message });
    return [];
  }
}

export async function buscarBing(query, timeoutMs = 8000) {
  const key = API_KEYS.bing;
  if (!key || key === "TU_API_KEY_BING") return [];
  try {
    const res = await axios.get("https://api.bing.microsoft.com/v7.0/news/search", {
      params:  { q: query, count: 3, mkt: "es-AR" },
      headers: { "Ocp-Apim-Subscription-Key": key },
      timeout: timeoutMs,
    });
    return (res.data.value || []).map(i => ({
      title:       i.name,
      url:         i.url,
      snippet:     i.description,
      publishedAt: i.datePublished,
      source:      "bing",
    }));
  } catch (e) {
    await guardarEvento("bing_error", { query, error: e.message });
    return [];
  }
}

export async function buscarNewsAPI(query, timeoutMs = 8000) {
  const key = API_KEYS.newsapi;
  if (!key || key === "TU_API_KEY_NEWSAPI") return [];
  try {
    const desde = new Date(Date.now() - 14 * 24 * 3600_000).toISOString().slice(0, 10);
    const res = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, language: "es", pageSize: 3, sortBy: "publishedAt", from: desde, apiKey: key },
      timeout: timeoutMs,
    });
    return (res.data.articles || []).map(a => ({
      title:       a.title,
      url:         a.url,
      snippet:     a.description,
      publishedAt: a.publishedAt,
      source:      a.source?.name || "newsapi",
    }));
  } catch (e) {
    await guardarEvento("newsapi_error", { query, error: e.message });
    return [];
  }
}

export async function buscarFinnhub(query, timeoutMs = 8000) {
  const key = API_KEYS.finnhub;
  if (!key || key === "TU_API_KEY_FINNHUB") return [];
  try {
    const res = await axios.get("https://finnhub.io/api/v1/news", {
      params: { category: "general", token: key },
      timeout: timeoutMs,
    });
    const todas = res.data || [];
    // Filtro por titular: los términos de búsqueda suelen estar en español y los
    // titulares de Finnhub en inglés → el match exacto casi nunca ocurre y el
    // feed entero se descartaba (la única fuente sana aportaba 0). Si el filtro
    // no encuentra nada, devolver igual las más recientes: el feed ya es
    // financiero-general y class45 hace su propia detección de sector después.
    // El dedup por hash de título evita re-ingerir las repetidas.
    const filtradas = todas.filter(i => i.headline?.toLowerCase().includes(query.toLowerCase()));
    // El fallback SOLO admite artículos con contexto financiero. Sin este segundo
    // filtro entraban deportes/espectáculos del feed general — ej. real: "Spain
    // beat Argentina to win World Cup" fue etiquetado ARGT (keyword país por
    // substring) y el AFINN ("win","beat") lo puntuó ALCISTA → sentimiento del
    // sector Argentina inflado por un partido de fútbol.
    const FIN_RE = /market|stock|share|earning|econom|inflation|\bfed\b|rate|bank|crypto|bitcoin|\boil\b|\bgas\b|bond|dollar|euro|\bipo\b|merger|acquisition|profit|revenue|forecast|gdp|trade|tariff|invest|treasury|nasdaq|s&p|dow\b/i;
    const fallbackFin = todas.filter(i => FIN_RE.test(`${i.headline ?? ""} ${i.summary ?? ""}`));
    return (filtradas.length > 0 ? filtradas : fallbackFin)
      .slice(0, 3)
      .map(i => ({
        title:       i.headline,
        url:         i.url,
        snippet:     i.summary,
        publishedAt: i.datetime ? new Date(i.datetime * 1000).toISOString() : null,
        source:      "finnhub",
      }));
  } catch (e) {
    await guardarEvento("finnhub_error", { query, error: e.message });
    return [];
  }
}

// ── buscarEnGoogle — FIX: delegaba a cheerio (no instalado)
// Ahora delega a buscarGoogle (API real). Mismo contrato de retorno.
export async function buscarEnGoogle(query = "") {
  if (!query || query.trim().length === 0) return [];
  const resultados = await buscarGoogle(query);
  // Adaptar formato para compatibilidad con class4 que espera {titulo, link, descripcion}
  return resultados.map(r => ({
    titulo:      r.title,
    link:        r.url,
    descripcion: r.snippet || "",
    source:      r.source,
  }));
}

// ══════════════════════════════════════════════════════════
// CLASE PRINCIPAL DE BÚSQUEDAS
// ══════════════════════════════════════════════════════════

export class Busquedas extends EventEmitter {
  constructor() {
    super();
    this.limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1500 });
    this.adapters = [
      { name: "GOOGLE",  fn: buscarGoogle  },
      { name: "BING",    fn: buscarBing    },
      { name: "NEWSAPI", fn: buscarNewsAPI },
      { name: "FINNHUB", fn: buscarFinnhub },
    ];
  }

  async buscarSecuencial(query) {
    for (const adapter of this.adapters) {
      try {
        const result = await this.limiter.schedule(() => adapter.fn(query));
        if (result?.length > 0) {
          console.log(`[class1] ${adapter.name} → ${result.length} resultados para: "${query}"`);
          return { adapter: adapter.name, data: result[0] };
        }
      } catch (e) {
        await guardarEvento(`${adapter.name}_fail`, { query, error: e.message });
      }
    }
    return null;
  }
}

export class BusquedasRealtime extends Busquedas {
  constructor() { super(); }

  async ejecutar(queries = []) {
    if (!Array.isArray(queries) || queries.length === 0) {
      console.warn("[class1] No se proporcionaron consultas.");
      return [];
    }

    const { targetChannel, envelopeType } = leerContrato();
    const resultados = [];

    for (const query of queries) {
      try {
        console.log(`[class1] 🔎 Buscando: "${query}"`);
        const found = await this.buscarSecuencial(query);

        if (!found || !found.data?.title) {
          await guardarEvento("sin_resultados", { query });
          continue;
        }

        resultados.push({ query, ...found });

        // ── ÚNICO punto de publicación a Redis ─────────────
        //
        // El texto, el instrumento y el sentimiento se calculan UNA VEZ y los
        // usan los tres destinos: el envelope DSL (→ class3), `class1_output`
        // (→ class11, class45, el feed) y la tabla `noticias`. Antes la misma
        // regex estaba escrita dos veces y el envelope no llevaba nada de esto.
        const cls  = clasificarNoticia(found.data);
        const art  = found.data;

        const envelope = buildEnvelope(cls.texto, { query, ...found }, envelopeType, cls.ticker);

        if (redisClient.isOpen) {
          await redisClient.publish(targetChannel, JSON.stringify(envelope));
          // También publicar a class1_output con formato plano para class45, class11 y el feed
          await redisClient.publish(redisConfig.outputChannel, JSON.stringify({
            tipo:        "noticia",
            fuente:      "class1",
            titulo:      cls.titulo,
            snippet:     cls.snippet,
            // `texto` lo leen class11 (lo DESCARTA si falta: la ventana queda
            // en 0), class9 y class6. Faltaba desde siempre y no molestaba
            // porque nadie filtraba por el; la ventana de titulares del corte
            // del 10-oct le puso un filtro que nada podia pasar. Confirmado en
            // produccion: 'class1_output: "" [ventana: 0]' con titulares llegando.
            texto:       cls.texto,
            url:         art.url     || art.link     || null,
            ticker:      cls.ticker,
            sentimiento: cls.sentimiento,
            source:      found.adapter,
            ts:          new Date().toISOString(),
          }));
          console.log(`[class1] 📤 Publicado → ${targetChannel} + ${redisConfig.outputChannel} | "${query}" (${found.adapter})${cls.ticker ? " [" + cls.ticker + "]" : ""}`);
        } else {
          console.warn(`[class1] Redis no conectado — resultado no enviado: "${query}"`);
        }

        // ── Persistir en tabla noticias ───────────────────────
        guardarNoticia({
          titulo:      cls.titulo.slice(0, 490),
          snippet:     cls.snippet || null,
          fuente:      art.source || art.fuente || found.adapter,
          ticker:      cls.ticker,
          sentimiento: cls.sentimiento,
          url:         art.link || art.url || null,
          imagen_url:  art.image || art.thumbnail || art.urlToImage || null,
          ts_publicado: art.publishedAt || null,
        }).catch(() => {});

        await guardarEvento("resultado_enviado", {
          query,
          adapter: found.adapter,
          canal:   targetChannel,
        });

      } catch (e) {
        console.error(`[class1] Error en búsqueda "${query}":`, e.message);
        await guardarEvento("buscar_error", { query, error: e.message });
      }
    }

    await guardarEvento("sesion_completada", {
      ts:       new Date().toISOString(),
      total:    resultados.length,
      queries:  queries.length,
    });

    console.log(`[class1] ✅ Sesión completada. ${resultados.length}/${queries.length} resultados.`);
    return resultados;
  }
}

// ══════════════════════════════════════════════════════════
// BOOT — microservicio
// ══════════════════════════════════════════════════════════

let iniciado = false;  // ← evita doble arranque

async function startMicroservice() {
  if (iniciado) {
    console.warn("[class1] Ya iniciado — ignorando llamada duplicada");
    return;
  }
  iniciado = true;

  try {
    console.log("[class1] 🚀 Iniciando microservicio de búsquedas...");

    if (!redisClient.isOpen)     await redisClient.connect();
    if (!redisSubscriber.isOpen) await redisSubscriber.connect();

    console.log("[class1] ✅ Redis conectado.");
    console.log(`[class1] 📡 Escuchando: ${TRIGGER_CHANNEL}, ${USER_QUERIES_CH}`);
    console.log(`[class1] 📤 Publicando en: ${redisConfig.exportChannel}`);

    // ── Canal 1: trigger de búsqueda (desde index.js, class4,
    //            o automático desde class40/class41 — OPCIÓN A) ──
    await redisSubscriber.subscribe(TRIGGER_CHANNEL, async (message) => {
      try {
        let queries = [];
        let origen  = "manual";   // por defecto, si no viene especificado
        let motivo  = null;
        let ticker  = null;
        let sector  = null;

        try {
          const parsed = JSON.parse(message);
          queries = Array.isArray(parsed.queries) ? parsed.queries
                  : Array.isArray(parsed)         ? parsed
                  : [];

          // class40/class41 mandan { origen, motivo, ticker, sector, queries, ts }
          if (parsed.origen) origen = parsed.origen;
          if (parsed.motivo) motivo = parsed.motivo;
          if (parsed.ticker) ticker = parsed.ticker;
          if (parsed.sector) sector = parsed.sector;
        } catch (_) {
          // Mensaje no es JSON — ignorar
        }

        if (queries.length === 0) {
          // Sin queries explícitas → usar términos activos
          queries = getTerminosActivos();
          console.log(`[class1] Trigger sin queries — usando ${queries.length} términos activos`);
        }

        // Log explícito del origen — clave para distinguir triggers
        // automáticos (OPCIÓN A: class40/class41) de los manuales
        // (web, cron, class4). Esto queda en el log para auditoría
        // y para medir cuánto está disparando el sistema por sí mismo.
        if (origen === "class40" || origen === "class41") {
          console.log(
            `[class1] 🤖 Trigger AUTOMÁTICO disparado por ${origen} ` +
            `(motivo: ${motivo || "no especificado"}` +
            (ticker ? `, ticker: ${ticker}` : "") +
            (sector ? `, sector: ${sector}` : "") +
            `) — investigando ${queries.length} términos.`
          );
        } else {
          console.log(`[class1] 🧑 Trigger MANUAL (origen: ${origen}) — investigando ${queries.length} términos.`);
        }

        await guardarEvento("trigger_recibido", { origen, motivo, ticker, sector, queries });

        const motor = new BusquedasRealtime();
        await motor.ejecutar(queries.slice(0, 50));
      } catch (e) {
        console.error("[class1] Error procesando trigger:", e.message);
      }
    });

    // ── Canal 2: configuración de términos desde la web ──────
    await redisSubscriber.subscribe(USER_QUERIES_CH, async (message) => {
      await procesarComandoUsuario(message);
    });

    // Mostrar términos activos al arrancar
    const activos = getTerminosActivos();
    console.log(`[class1] 🔍 Términos activos: ${activos.length} (${cargarTerminosUsuario().length > 0 ? "usuario" : "default"})`);

    // Heartbeat
    setInterval(() => {
      console.log(`[class1] ❤️ heartbeat | términos: ${getTerminosActivos().length}`);
    }, 30000).unref();

    // ── Auto-búsqueda periódica (autosuficiencia) ─────────────────
    // class1 se disparaba SOLO por trigger externo (class40/41, motor vectorial
    // .NET). Si ese motor falla, class1 dejaba de buscar noticias indefinidamente
    // (pasó: 6 días sin noticias nuevas). Este auto-trigger lo hace independiente:
    // busca con los términos activos cada NEWS_AUTOSEARCH_MS (default 6h), pase lo
    // que pase con el resto del sistema (~32 requests/día, dentro del free tier).
    // Cada 8h por default (3 corridas/día). Era 24h en código pero el server lo
    // pisaba con NEWS_AUTOSEARCH_MS=28800000; ahora el default ES 8h, así que la
    // cadencia se mantiene aunque la variable de entorno se pierda.
    const AUTOBUSQUEDA_MS = Number(process.env.NEWS_AUTOSEARCH_MS || 8 * 60 * 60_000);
    const autoBusqueda = async () => {
      try {
        // Los 13 sectores son ESTRUCTURALES: se buscan SIEMPRE. Antes se usaba
        // getTerminosActivos(), que devuelve usuario O default (excluyentes) —
        // un solo término de usuario borraba toda la cobertura sectorial y
        // dejaba media tabla en "s/d". Ahora la base sectorial va siempre, más
        // los términos del usuario, deduplicados y con los sectores primero
        // (así el tope nunca los deja afuera).
        const userTerms = cargarTerminosUsuario();
        // ROTACIÓN del punto de inicio. Las APIs devuelven 429 (cuota agotada)
        // a mitad de la corrida, y como el orden era SIEMPRE el mismo, los
        // sectores del final nunca llegaban a consultarse. Medido en producción
        // (2026-07-31): la query de utilities —9ª de 13— recibía 429 de Google y
        // NewsAPI en cada corrida, y XLU quedaba sin noticias de forma
        // permanente ("s/d" eterno en el panel).
        // Rotando el arranque, cada sector accede a cuota fresca por turnos.
        // Tope por corrida: con 8 h (3 corridas/día), 25 × 3 = 75 llamadas/día,
        // dentro de la cuota free de Google y NewsAPI (100/día cada una).
        const tope = Number(process.env.NEWS_TERMS_PER_RUN || 25);
        // Se reservan slots para el usuario. Con 13 sectores entraban los 13 más
        // 12 términos del usuario y no hacía falta pensarlo; con 50 sectores, si
        // los sectores se quedan con los 25 slots el usuario no consulta NUNCA.
        const CUPO_USUARIO = Math.min(userTerms.length, Number(process.env.NEWS_USER_SLOTS || 5));
        const cupoSectores = Math.max(1, tope - CUPO_USUARIO);

        // ── LA ROTACIÓN AVANZA DE A `cupoSectores`, NO DE A UNO ────────────
        // Avanzaba de a uno. Con 13 términos y tope 25 eso no se notaba —
        // entraban todos en cada corrida— pero con 50 y cupo 20, avanzar de a
        // uno significa que el término #50 recién se consulta a la corrida 31:
        // **diez días** a 3 corridas por día. Avanzando de a `cupoSectores`, los
        // 50 se cubren en ceil(50/20) = 3 corridas, o sea un día.
        const n       = TERMINOS_DEFAULT.length;
        const rot     = (_rotacionSectores * cupoSectores) % n;
        _rotacionSectores++;
        const rotados = [...TERMINOS_DEFAULT.slice(rot), ...TERMINOS_DEFAULT.slice(0, rot)]
                          .slice(0, cupoSectores);
        const queries = [...new Set([...rotados, ...userTerms.slice(0, CUPO_USUARIO)])];
        const vueltas = Math.ceil(n / cupoSectores);
        console.log(`[class1] ⏰ Auto-búsqueda — ${queries.length} términos ` +
                    `(${rotados.length} de ${n} instrumentos desde #${rot} + ` +
                    `${Math.min(userTerms.length, CUPO_USUARIO)} de ${userTerms.length} del usuario, ` +
                    `tope ${tope}) — el universo entero se cubre cada ${vueltas} corridas`);
        await new BusquedasRealtime().ejecutar(queries.slice(0, tope));
      } catch (e) {
        console.error(`[class1] Auto-búsqueda error: ${e.message}`);
      }
    };
    setTimeout(autoBusqueda, 30_000);            // primera corrida ~30s tras arrancar
    setInterval(autoBusqueda, AUTOBUSQUEDA_MS);  // luego cada 8h

  } catch (e) {
    console.error("[class1] Error iniciando microservicio:", e.message);
    iniciado = false;
    setTimeout(startMicroservice, 5000);
  }
}

// Reconexión sin duplicar el arranque
redisClient.on("end", () => {
  console.warn("[class1] Redis desconectado.");
  iniciado = false;
  setTimeout(startMicroservice, 3000);
});

// Crash protection
process.on("uncaughtException",  e => console.error("[class1] uncaughtException:",  e));
process.on("unhandledRejection", e => console.error("[class1] unhandledRejection:", e));

// Arrancar
// Arrancar SOLO si se ejecuta directamente.
//
// class4.js hace `import { buscarEnGoogle } from "./class1.js"` — quiere una
// sola funcion, pero en ESM importar EJECUTA el top-level del modulo. Sin este
// guard, startMicroservice() arrancaba una SEGUNDA instancia completa dentro
// del proceso de class4: otro loop de autobusqueda, otra suscripcion a Redis y
// el DOBLE de consumo de cuota de Google y NewsAPI.
//
// Medido el 16-ago-2026 en /root/.pm2/logs/miia-out.log:
//     2289 lineas [CLASS4] [class1]   contra   2280 [CLASS1] [class1]
// Nueve de diferencia sobre 4.500: el mismo codigo corriendo dos veces.
//
// Mismo patron que ya usa class26.js para su modo tester.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMicroservice();
}

// ══════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════
export default {
  BusquedasRealtime,
  Busquedas,
  redisClient,
  redisConfig,
  buscarEnGoogle,
  buscarGoogle,
  buscarBing,
  buscarNewsAPI,
  buscarFinnhub,
  guardarEvento,
  getTerminosActivos,
};

// Sólo para las pruebas en frío de docs/simulaciones. Ningún módulo importa
// esto: los módulos se hablan por Redis, así que exportarlo no acopla nada.
export const _test1 = { buildEnvelope, clasificarNoticia, TICKERS_ORDENADOS };