// ============================================================
// universo.js — la lista de instrumentos, en UN solo lugar
// ============================================================
//
// Por qué existe (21-sep-2026):
//
//   La lista de tickers estaba copiada a mano en más de diez lugares: class7,
//   class43 (dos veces), class25B (dos veces), class10.cs, class44.py,
//   miia_chatbot.py (dos veces), class1, class45, index.html y el SQL del
//   chequeo. Y habían drifteado de verdad: **class25B tenía SPY y QQQ pero no
//   tenía XLRE**, que sí se cotiza y sí entra en la medición.
//
//   El plan del 12-oct amplía de 13 a 100 instrumentos. Ampliar con la lista
//   copiada en diez lados hace que los números dejen de reconciliar y que
//   nadie pueda decir por qué.
//
// Cómo funciona: lee config/universo.json. Si el archivo falta, está roto o
// tiene una lista vacía, **devuelve la copia de respaldo de abajo y lo dice en
// el log**. Ningún módulo se queda sin universo por un JSON mal editado — eso
// sería cambiar un problema de consistencia por uno de disponibilidad.
//
//   import { TICKERS, SECTOR_ETF_MAP, TICKERS_TEXTO } from "./universo.js";

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RUTA = process.env.MIIA_UNIVERSO_JSON
          || path.join(AQUI, "..", "operador", "aprendizaje", "config", "universo.json");

// ── Copia de respaldo ─────────────────────────────────────────────────────
// Tiene que ser IDÉNTICA al JSON. `sim10_universo.js` lo verifica, así que si
// alguien edita uno y se olvida del otro, el test se pone en rojo.
const RESPALDO = {
  polling_segundos: 90,
  llamadas_por_minuto: 54,
  instrumentos: [
    { ticker: "XLK",   sector: "Technology",               region: "US" },
    { ticker: "XLF",   sector: "Financials",               region: "US" },
    { ticker: "XLE",   sector: "Energy",                   region: "US" },
    { ticker: "XLV",   sector: "Healthcare",               region: "US" },
    { ticker: "XLY",   sector: "Consumer Discretionary",   region: "US" },
    { ticker: "XLI",   sector: "Industrials",              region: "US" },
    { ticker: "XLB",   sector: "Materials",                region: "US" },
    { ticker: "XLRE",  sector: "Real Estate",              region: "US" },
    { ticker: "XLU",   sector: "Utilities",                region: "US" },
    { ticker: "XLC",   sector: "Communication Services",   region: "US" },
    { ticker: "XLP",   sector: "Consumer Staples",         region: "US" },
    { ticker: "SPY",   sector: "US Large Cap",             region: "US" },
    { ticker: "QQQ",   sector: "US Nasdaq 100",            region: "US" },
    { ticker: "IWM",   sector: "US Small Cap",             region: "US" },
    { ticker: "DIA",   sector: "US Dow 30",                region: "US" },
    { ticker: "EFA",   sector: "Developed ex-US",          region: "GLOBAL" },
    { ticker: "EEM",   sector: "Emerging Markets",         region: "GLOBAL" },
    { ticker: "EWJ",   sector: "Japan",                    region: "APAC" },
    { ticker: "EWG",   sector: "Germany",                  region: "EUROPE" },
    { ticker: "EWU",   sector: "United Kingdom",           region: "EUROPE" },
    { ticker: "EWL",   sector: "Switzerland",              region: "EUROPE" },
    { ticker: "EWY",   sector: "South Korea",              region: "APAC" },
    { ticker: "EWT",   sector: "Taiwan",                   region: "APAC" },
    { ticker: "EWH",   sector: "Hong Kong",                region: "APAC" },
    { ticker: "EWA",   sector: "Australia",                region: "APAC" },
    { ticker: "INDA",  sector: "India",                    region: "APAC" },
    { ticker: "FXI",   sector: "China Large Cap",          region: "APAC" },
    { ticker: "EWC",   sector: "Canada",                   region: "US" },
    { ticker: "EWW",   sector: "Mexico",                   region: "LATAM" },
    { ticker: "ARGT",  sector: "MERVAL",                   region: "LATAM" },
    { ticker: "EWZ",   sector: "Brazil",                   region: "LATAM" },
    { ticker: "ILF",   sector: "Latin America",            region: "LATAM" },
    { ticker: "SMH",   sector: "Semiconductors",           region: "US" },
    { ticker: "XBI",   sector: "Biotech",                  region: "US" },
    { ticker: "VNQ",   sector: "REITs",                    region: "US" },
    { ticker: "XOP",   sector: "Oil and Gas E&P",          region: "US" },
    { ticker: "KRE",   sector: "Regional Banks",           region: "US" },
    { ticker: "ITB",   sector: "Homebuilders",             region: "US" },
    { ticker: "JETS",  sector: "Airlines",                 region: "US" },
    { ticker: "IYT",   sector: "Transportation",           region: "US" },
    { ticker: "XME",   sector: "Metals and Mining",        region: "US" },
    { ticker: "GDX",   sector: "Gold Miners",              region: "US" },
    { ticker: "XRT",   sector: "Retail",                   region: "US" },
    { ticker: "ARKK",  sector: "Disruptive Innovation",    region: "US" },
    { ticker: "MTUM",  sector: "Factor Momentum",          region: "US" },
    { ticker: "QUAL",  sector: "Factor Quality",           region: "US" },
    { ticker: "VTV",   sector: "Factor Value",             region: "US" },
    { ticker: "VUG",   sector: "Factor Growth",            region: "US" },
    { ticker: "USMV",  sector: "Factor Min Volatility",    region: "US" },
    { ticker: "IWF",   sector: "Factor Large Growth",      region: "US" },
  ],
  reconocidos_en_texto: ["BTC", "ETH", "VOO", "VTI", "IVV", "GLD", "SLV", "TLT", "AGG", "USO"],
  noticias: [
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLB", "XLRE", "XLU", "XLC", "XLP", "SPY",
    "QQQ", "IWM", "DIA", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWL", "EWY", "EWT", "EWH",
    "EWA", "INDA", "FXI", "EWC", "EWW", "ARGT", "EWZ", "ILF", "SMH", "XBI", "VNQ", "XOP",
    "KRE", "ITB", "JETS", "IYT", "XME", "GDX", "XRT", "ARKK", "MTUM", "QUAL", "VTV", "VUG",
    "USMV", "IWF"
  ],
  lstm: [
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLB", "XLRE", "XLU", "XLC", "XLP", "SPY",
    "QQQ", "IWM", "DIA", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWL", "EWY", "EWT", "EWH",
    "EWA", "INDA", "FXI", "EWC", "EWW", "ARGT", "EWZ", "ILF", "SMH", "XBI", "VNQ", "XOP",
    "KRE", "ITB", "JETS", "IYT", "XME", "GDX", "XRT", "ARKK", "MTUM", "QUAL", "VTV", "VUG",
    "USMV", "IWF"
  ],
};

function cargar() {
  try {
    const crudo = JSON.parse(fs.readFileSync(RUTA, "utf8"));
    if (!Array.isArray(crudo.instrumentos) || crudo.instrumentos.length === 0)
      throw new Error("`instrumentos` vacío o no es una lista");
    for (const i of crudo.instrumentos)
      if (!i || typeof i.ticker !== "string" || !i.ticker.trim())
        throw new Error("hay un instrumento sin `ticker`");
    return { datos: crudo, origen: RUTA };
  } catch (e) {
    // console.warn y no `log()`: este módulo lo importan procesos que todavía
    // no armaron su logger, y quedarse sin universo por un JSON roto sería peor
    // que arrancar con la copia de respaldo.
    console.warn(`[universo] ${RUTA}: ${e.message} — se usa la copia de respaldo ` +
                 `(${RESPALDO.instrumentos.length} instrumentos)`);
    return { datos: RESPALDO, origen: "respaldo interno" };
  }
}

const { datos, origen } = cargar();

/** Los instrumentos que se cotizan y se miden, en el orden del archivo. */
export const TICKERS = datos.instrumentos.map(i => i.ticker);

/** sector → ticker. Es lo que class7 necesita para mapear lo que devuelve el proveedor. */
export const SECTOR_ETF_MAP = Object.fromEntries(
  datos.instrumentos.filter(i => i.sector).map(i => [i.sector, i.ticker]));

/** ticker → {sector, region}. */
export const INSTRUMENTOS = datos.instrumentos;

/**
 * Los que se reconocen al PARSEAR TEXTO: los medibles más SPY/QQQ/BTC/ETH.
 * NO usar para medir ni para pedir precios — esa distinción es justo la que se
 * había perdido (_TICKERS_SISTEMA tenía 15 porque alguien sumó SPY y QQQ ahí).
 */
export const TICKERS_TEXTO = [...TICKERS, ...(datos.reconocidos_en_texto || [])];

/** Subconjunto que se consulta a los proveedores de noticias (cuotas). */
export const TICKERS_NOTICIAS = (datos.noticias && datos.noticias.length)
                              ? datos.noticias : TICKERS;

/**
 * Subconjunto que modela class44 (LSTM). Es MÁS CHICO que el universo a
 * propósito: class44 arma un modelo por ticker y es el segundo proceso más
 * caro del server. Ver el comentario `_lstm` en universo.json.
 */
export const TICKERS_LSTM = (datos.lstm && datos.lstm.length)
                          ? datos.lstm : TICKERS;

export const POLLING_SEGUNDOS = Number(datos.polling_segundos) || 60;

/**
 * Presupuesto DURO de llamadas por minuto al proveedor de precios.
 * Lo aplica class7 con un limiter con reservoir sobre TODA llamada. Ver el
 * comentario `_llamadas_por_minuto` en universo.json: con 13 instrumentos el
 * arranque gastaba 26 llamadas y entraba en las 60 del plan gratis; con 50 son
 * 100 en ~20 s y se pasa. Esto lo vuelve una garantía en vez de un promedio.
 */
export const LLAMADAS_POR_MINUTO = Number(datos.llamadas_por_minuto) || 54;

export const ORIGEN = origen;

/** Sólo para `sim10_universo.js`: verifica que el respaldo no driftee del JSON. */
export const _RESPALDO_TEST = RESPALDO;

/** Para el log de arranque de cada módulo. */
export function resumenUniverso() {
  return `${TICKERS.length} instrumentos (${TICKERS.slice(0, 4).join(",")}…) ` +
         `desde ${origen === "respaldo interno" ? "RESPALDO" : "universo.json"}`;
}

export default { TICKERS, SECTOR_ETF_MAP, INSTRUMENTOS, TICKERS_TEXTO,
                 TICKERS_NOTICIAS, TICKERS_LSTM, POLLING_SEGUNDOS,
                 LLAMADAS_POR_MINUTO, ORIGEN, resumenUniverso };
