// ============================================================
// class7.js — Observador de Mercado + Precios en Tiempo Real
// VERSIÓN 2.0 — Unificado con class43 y pipeline de backtesting
//
// Cambios vs versión anterior:
//   1. Agrega canal class7_output con precios individuales
//      (class43 los necesita para verificar outcomes de señales)
//   2. Formato unificado: { ticker, precio, symbol, close,
//      open, high, low, volume, change_pct, sector, ts }
//   3. También publica batch: { precios: { "XLK": 195.5, ... } }
//   4. Suscribe a class7_watch para trackear tickers custom
//      (class25 puede pedir seguimiento de un ticker específico)
//   5. Mantiene toda la lógica sectorial → class15_ingest
//   6. Se lanza solo sin necesitar startWatcher() externo
// ============================================================

import axios      from "axios";
import Bottleneck from "bottleneck";
import path       from "path";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import fs         from "fs";
import { v4 as uuidv4 } from "uuid";
import { getStorageConfig, getLoggingConfig } from "./class38.js";
import { guardarPrecios } from "./class42.js";
// FUENTE ÚNICA del universo (21-sep-2026). Ver scripts/universo.js.
import { SECTOR_ETF_MAP, POLLING_SEGUNDOS, LLAMADAS_POR_MINUTO,
         resumenUniverso } from "./universo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir    = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR   = path.join(baseDir, "logs");
const JSON_DIR   = path.join(baseDir, "json_guardados");
const METRICS_DIR= path.join(baseDir, "metrics");
const CONFIG_DIR = path.join(baseDir, "config");

for (const d of [LOGS_DIR, JSON_DIR, METRICS_DIR, CONFIG_DIR])
  fs.mkdirSync(d, { recursive: true });

const LOG_FILE = path.join(LOGS_DIR, "class7.log");

// ── Logger ─────────────────────────────────────────────────
function log(msg, nivel = "info") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [class7/${nivel.toUpperCase()}] ${msg}`;
  console[nivel === "error" ? "error" : nivel === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Config class38 ──────────────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
export function getPath(key, fallback = "./") {
  try { const v = storageCfg[key]; return typeof v === "string" && v.trim() ? v : fallback; } catch { return fallback; }
}
export function getLogLevel(d = "info") { try { return getLoggingConfig()?.level || d; } catch { return d; } }
export function shouldRotateLogs() { try { return getLoggingConfig()?.rotate_logs === true; } catch { return false; } }

// ── API Keys — desde config/.env (cargado por class38, importado arriba) ──
export const API_KEYS = {
  finnhub:      process.env.FINNHUB_KEY      || "",
  alphavantage: process.env.ALPHAVANTAGE_KEY || "",
  polygon:      process.env.POLYGON_KEY      || "",
  twelvedata:   process.env.TWELVEDATA_KEY   || "",
};

export function getApiKeys() { return API_KEYS; }

// ── Canales Redis ──────────────────────────────────────────
const REDIS_URL     = process.env.REDIS_URL || "redis://localhost:6379";
const CH_SECTORES   = "class15_ingest"; 
const CH_Vectores   =  "class10_ingest";  
const CH_PRECIOS    = "class7_output";    // precios individuales → class43, class25
const CH_OUTLETS    = "class7_outlets";   // canal legacy
const CH_WATCH      = "class7_watch";     // comandos: trackear tickers custom

// ── ETF proxy por sector ───────────────────────────────────
// SECTOR_ETF_MAP y POLLING_INTERVAL salen de config/universo.json.
// Estaban a mano acá y en otros nueve lugares, y habían drifteado.

// ── Redis clientes ─────────────────────────────────────────
const redisPub = createClient({ url: REDIS_URL });
const redisSub = createClient({ url: REDIS_URL });

redisPub.on("error", e => log(`Redis PUB: ${e.message}`, "warn"));
redisSub.on("error", e => log(`Redis SUB: ${e.message}`, "warn"));

// ── Estado global ──────────────────────────────────────────
let providerClient      = null;
let currentProvider     = null;
let latestSectors       = null;
const preciosCache      = new Map();   // ticker → { precio, open, high, low, volume, ts }
const tickersCustom     = new Set();   // tickers pedidos via class7_watch
// TTL de tickers custom: sin re-pedido en 12h se dejan de pollear.
// Sin esto cada activo consultado en el chat quedaría pollado cada 60s para
// siempre → crecimiento sin límite de `precios` + agotamiento de cuota Finnhub.
const tickersCustomTs   = new Map();   // ticker → ts del último add
const CUSTOM_TTL_MS     = 12 * 3600_000;
let consecutiveErrors   = 0;
const MAX_ERRORS        = 5;
// Sale del JSON. El intervalo NO es lo que protege la cuota — eso lo hace el
// limiter de abajo. Acá sólo se decide cada cuánto se refresca el mercado.
const POLLING_INTERVAL  = POLLING_SEGUNDOS * 1000;

// ══ PRESUPUESTO DE CUOTA DEL PROVEEDOR (26-sep-2026) ════════════════════════
//
// EL DEFECTO, medido sobre el código: no había NINGÚN tope. El promedio del
// polling (13 tickers / 60 s = 13 por minuto) alcanzaba de sobra para las 60
// llamadas/min del plan gratis de Finnhub, así que el tope nunca hizo falta.
// Con 50 instrumentos eso deja de ser cierto por dos caminos distintos:
//
//   1. EL ARRANQUE. La elección de proveedor hacía un `fetchSectors()` COMPLETO
//      de prueba y el primer `executeCycle()` hacía otro: dos barridos enteros
//      en ~20 s. Con 13 eran 26 llamadas y entraban; con 50 son **100 en el
//      primer minuto** — o sea que el corte del 12-oct se pasaba del límite en
//      el minuto uno, y no como un error visible: `fetchQuote` devuelve null en
//      el 429 y se publica `precio: null`. La sección transversal de class10
//      arrancaría a medias y nadie se enteraría.
//   2. EL RÉGIMEN. `tickersCustom` (los que pide el chat por class7_watch, TTL
//      de 12 h) se cobran ADEMÁS de los 50, y tenían su propio limiter de
//      200 ms, o sea que podían ráfagar encima del barrido. 50 + 15 del chat
//      ya se pasa.
//
// EL ARREGLO: un limiter ÚNICO con `reservoir`, que es un tope duro de N
// llamadas por minuto, no una separación mínima entre llamadas. Se aplica
// envolviendo `fetchQuote` en `crearCliente()` — un solo lugar— así cubre
// automáticamente el barrido (que llama a `this.fetchQuote`), los tickers
// custom y cualquier camino que se agregue después. `minTime` reparte las
// llamadas dentro del minuto en vez de gastarlas todas en los primeros
// segundos, que es lo que dispara los 429 aunque el total del minuto entre.
//
// Con 54/min y 50 instrumentos un barrido tarda ~56 s y el intervalo es 90 s:
// entra con 34 s de margen. Si se paga un plan, se cambia `llamadas_por_minuto`
// en universo.json y nada más.
const CUOTA_POR_MINUTO = Math.max(1, LLAMADAS_POR_MINUTO);
const limiterCuota = new Bottleneck({
  maxConcurrent: 1,
  minTime: Math.ceil(60_000 / CUOTA_POR_MINUTO),
  reservoir: CUOTA_POR_MINUTO,
  reservoirRefreshAmount: CUOTA_POR_MINUTO,
  reservoirRefreshInterval: 60_000,
});
let _llamadasProveedor = 0;   // total, para el heartbeat
let _esperaCuotaMs     = 0;   // cuánto se esperó por el tope: si crece, falta cuota

// ── Utilidades ─────────────────────────────────────────────
function clasificarEstado(change, umbral = 0.15) {
  if (change > umbral)  return "up";
  if (change < -umbral) return "down";
  return "neutral";
}

function nowIso() { return new Date().toISOString(); }

// ============================================================
// CLIENTES DE PROVEEDORES
// ============================================================
class FinnhubClient {
  constructor(key) { this.key = key; this.name = "finnhub"; }

  async fetchQuote(symbol) {
    try {
      const r = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${this.key}`, { timeout: 5000 });
      const d = r?.data;
      if (!d || !d.c) return null;
      return {
        symbol,
        close:  +d.c,
        open:   +d.o,
        high:   +d.h,
        low:    +d.l,
        prevClose: +d.pc,
        change_pct: d.o ? +((d.c - d.o) / d.o * 100).toFixed(2) : 0
      };
    } catch (_) { return null; }
  }

  async fetchSectors() {
    const ts = nowIso();
    const results = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
      try {
        const q = await this.fetchQuote(etf);
        results.push({
          sector,
          etf,
          change:    q?.change_pct ?? 0,
          unit:      "pct",
          state:     clasificarEstado(q?.change_pct ?? 0),
          precio:    q?.close ?? null,
          open:      q?.open ?? null,
          high:      q?.high ?? null,
          low:       q?.low ?? null,
          timestamp: ts,
          provider:  this.name
        });
      } catch (_) {
        results.push({ sector, etf, change: 0, unit: "pct", state: "neutral", timestamp: ts, provider: this.name });
      }
    }
    return results;
  }
}

class AlphaVantageClient {
  constructor(key) { this.key = key; this.name = "alphavantage"; }

  async fetchQuote(symbol) {
    try {
      const r = await axios.get(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${this.key}`,
        { timeout: 5000 }
      );
      const q = r?.data?.["Global Quote"];
      if (!q) return null;
      const close = +(q["05. price"] || 0);
      const open  = +(q["02. open"]  || 0);
      return {
        symbol, close, open,
        high:       +(q["03. high"] || 0),
        low:        +(q["04. low"]  || 0),
        volume:     +(q["06. volume"] || 0),
        change_pct: open ? +((close - open) / open * 100).toFixed(2) : 0
      };
    } catch (_) { return null; }
  }

  async fetchSectors() {
    const ts = nowIso();
    const results = [];
    // AlphaVantage tiene endpoint SECTOR
    try {
      const r = await axios.get(
        `https://www.alphavantage.co/query?function=SECTOR&apikey=${this.key}`,
        { timeout: 5000 }
      );
      const data = r?.data?.["Rank A: Real-Time Performance"] || r?.data?.["Real-Time Performance"];
      if (data && typeof data === "object") {
        for (const [sector, val] of Object.entries(data)) {
          const num = parseFloat(String(val).replace("%","").trim()) || 0;
          results.push({
            sector, etf: SECTOR_ETF_MAP[sector] ?? null,
            change: +num.toFixed(2), unit: "pct",
            state: clasificarEstado(num), timestamp: ts, provider: this.name
          });
        }
        if (results.length > 0) return results;
      }
    } catch (_) {}

    // Fallback: ETF por ETF
    for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
      try {
        const q = await this.fetchQuote(etf);
        results.push({
          sector, etf, change: q?.change_pct ?? 0, unit: "pct",
          state: clasificarEstado(q?.change_pct ?? 0),
          precio: q?.close ?? null, open: q?.open ?? null,
          high: q?.high ?? null, low: q?.low ?? null,
          timestamp: ts, provider: this.name
        });
      } catch (_) {
        results.push({ sector, etf, change: 0, unit: "pct", state: "neutral", timestamp: ts, provider: this.name });
      }
    }
    return results;
  }
}

class TwelveDataClient {
  constructor(key) { this.key = key; this.name = "twelvedata"; }

  async fetchQuote(symbol) {
    try {
      const r = await axios.get(
        `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${this.key}`,
        { timeout: 5000 }
      );
      const d = r?.data;
      if (!d || !d.close) return null;
      const close = +d.close, open = +d.open;
      return {
        symbol, close, open,
        high:       +d.high,
        low:        +d.low,
        volume:     +d.volume || 0,
        change_pct: open ? +((close - open) / open * 100).toFixed(2) : 0
      };
    } catch (_) { return null; }
  }

  async fetchSectors() {
    const ts = nowIso();
    const results = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
      try {
        const q = await this.fetchQuote(etf);
        results.push({
          sector, etf, change: q?.change_pct ?? 0, unit: "pct",
          state: clasificarEstado(q?.change_pct ?? 0),
          precio: q?.close ?? null, open: q?.open ?? null,
          high: q?.high ?? null, low: q?.low ?? null,
          timestamp: ts, provider: this.name
        });
      } catch (_) {
        results.push({ sector, etf, change: 0, unit: "pct", state: "neutral", timestamp: ts, provider: this.name });
      }
    }
    return results;
  }
}

class PolygonClient {
  constructor(key) { this.key = key; this.name = "polygon"; }

  async fetchQuote(symbol) {
    try {
      const r = await axios.get(
        `https://api.polygon.io/v2/last/trade/${symbol}?apiKey=${this.key}`,
        { timeout: 5000 }
      );
      const price = r?.data?.results?.p;
      if (!price) return null;
      return { symbol, close: +price, open: +price, high: +price, low: +price, volume: 0, change_pct: 0 };
    } catch (_) { return null; }
  }

  async fetchSectors() {
    const ts = nowIso();
    const results = [];
    for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
      try {
        const q = await this.fetchQuote(etf);
        results.push({
          sector, etf, change: q?.change_pct ?? 0, unit: "pct",
          state: "neutral", precio: q?.close ?? null,
          timestamp: ts, provider: this.name
        });
      } catch (_) {
        results.push({ sector, etf, change: 0, unit: "pct", state: "neutral", timestamp: ts, provider: this.name });
      }
    }
    return results;
  }
}

function crearCliente(nombre, key) {
  let cliente;
  switch (nombre) {
    case "finnhub":      cliente = new FinnhubClient(key);      break;
    case "alphavantage": cliente = new AlphaVantageClient(key); break;
    case "twelvedata":   cliente = new TwelveDataClient(key);   break;
    case "polygon":      cliente = new PolygonClient(key);      break;
    default:             return null;
  }

  // ── Toda llamada al proveedor pasa por el presupuesto de cuota ──────────
  // Se envuelve ACÁ y no en cada cliente a propósito: los cuatro
  // `fetchSectors()` llaman a `this.fetchQuote`, y el barrido de tickers custom
  // también, así que un solo punto cubre todos los caminos —incluido el que
  // alguien agregue mañana— en vez de cuatro que se pueden olvidar.
  const original = cliente.fetchQuote.bind(cliente);
  cliente.fetchQuote = (symbol) => limiterCuota.schedule(() => {
    _llamadasProveedor++;
    return original(symbol);
  });
  return cliente;
}

// ============================================================
// ============================================================
// DEDUPLICACIÓN DE ESCRITURAS (10-sep-2026)
// ------------------------------------------------------------
// class7 pollea cada 60 s las 24 h. El NYSE abre 32,5 h de las 168 que tiene la
// semana: el 81 % de los ciclos escribía LA MISMA FILA otra vez.
//
// Costaba tres cosas, y la del disco es la menos importante:
//
//  1. Contaminaba los promedios. `/api/precios` hacía AVG sobre 48 h y quedaba
//     dominado por muestras congeladas — por eso el panel mostraba XLK −0,41 %
//     el día que cerró +0,32 %.
//  2. Inflaba `precios` en ~15.100 filas de relleno por día (~5,5 M al año).
//  3. Y la que importa: class25A seguía decidiendo sobre datos que no se
//     movieron. Esas decisiones nacen SIN INSTRUMENTO —el vector por ticker no
//     se regenera si el precio no cambió— así que salen como GENERAL, class43
//     no puede verificarlas con etiqueta relativa y caen a `absoluto`.
//     Medido el 9-sep: con el mercado abierto las decisiones tenían 14
//     instrumentos; con el mercado cerrado, 1 (GENERAL). Es el 81 % del tiempo.
//     O sea: esto no es una optimización de disco, es el arreglo de ORDEN 1.
//
// Se compara contra el último valor PERSISTIDO, no contra el último publicado:
// el publish a Redis sigue saliendo cada 60 s a propósito, para que class48 no
// dé a class7 por silencioso (su umbral son 15 min) y para que class43 mantenga
// precio fresco en `preciosActuales`, que no tiene guardia de antigüedad.
//
// Por qué esto y no un calendario de mercado: no necesita husos horarios,
// feriados del NYSE ni medios días, y funciona solo para los tickers 24/7 que
// pueden llegar del chat — una cripto sí cambia de noche, así que sí se escribe.
// ============================================================
const ultimoPersistido = new Map();   // ticker → firma del último INSERT
let _persistidos = 0, _omitidos = 0;

function soloCambiados(sectores) {
  const nuevos = [];
  for (const s of sectores) {
    const ticker = s.etf || s.ticker || s.symbol;
    if (!ticker) continue;
    // Misma lectura de campos que usa guardarPrecios() para armar la fila.
    const firma = `${s.precio ?? ""}|${s.change ?? s.change_pct ?? ""}`;
    if (ultimoPersistido.get(ticker) === firma) continue;
    ultimoPersistido.set(ticker, firma);
    nuevos.push(s);
  }
  return nuevos;
}

// ============================================================
// PUBLICAR PRECIO INDIVIDUAL → class7_output
// Formato que necesita class43 para backtesting
// ============================================================
async function publicarPrecio(ticker, datos, sector = null) {
  if (!redisPub.isOpen || !datos?.close) return;
  try {
    const msg = {
      id:         uuidv4(),
      source:     "class7",
      type:       "price_update",
      ticker,
      symbol:     ticker,
      precio:     datos.close,       // formato class43
      close:      datos.close,       // formato class43 alternativo
      open:       datos.open   ?? null,
      high:       datos.high   ?? null,
      low:        datos.low    ?? null,
      volume:     datos.volume ?? null,
      change_pct: datos.change_pct ?? 0,
      sector:     sector ?? null,
      riesgoGlobal: calcularRiesgoGlobal(),
      ts:         nowIso()
    };
    await redisPub.publish(CH_PRECIOS, JSON.stringify(msg));
    preciosCache.set(ticker, { ...datos, ts: nowIso() });
  } catch (e) {
    log(`⚠️ publicarPrecio ${ticker}: ${e.message}`, "warn");
  }
}

// ============================================================
// PUBLICAR BATCH DE PRECIOS → class7_output
// { precios: { "XLK": 195.5, "XLF": 39.2, ... } }
// class43 puede parsear este formato directamente
// ============================================================
async function publicarBatchPrecios(sectores) {
  if (!redisPub.isOpen) return;
  try {
    const precios = {};
    for (const s of sectores) {
      if (s.etf && s.precio != null) {
        precios[s.etf] = s.precio;
        if (s.sector) precios[s.sector] = s.precio; // también por nombre de sector
      }
    }

    const msg = {
      source:  "class7",
      type:    "prices_batch",
      precios,                    // { "XLK": 195.5, ... }
      ts:      nowIso()
    };
    await redisPub.publish(CH_PRECIOS, JSON.stringify(msg));
    log(`📤 Batch de ${Object.keys(precios).length} precios → ${CH_PRECIOS}`);
  } catch (e) {
    log(`⚠️ publicarBatchPrecios: ${e.message}`, "warn");
  }
}

// ============================================================
// PUBLICAR ESTADO SECTORIAL → class15_ingest
// Mantiene compatibilidad con class15 (portfolio)
// ============================================================
async function publicarEstadoSectores(sectores) {
  if (!redisPub.isOpen) return;
  try {
    const ts       = nowIso();
    const provider = currentProvider || "unknown";

    const normalizados = sectores.map(s => {
      const chg = +(s.change ?? 0);
      // Riesgo por sector: mapeo determinístico del cambio porcentual
      // negativo grande → riesgo alto; positivo → riesgo bajo
      const riesgoSector = chg < -3  ? 0.88
                         : chg < -1  ? 0.65
                         : chg <  0  ? 0.45
                         : chg <  1  ? 0.25
                         : chg <  3  ? 0.15
                         :             0.08;
      // Score DIRECCIONAL del sector [0,1]: 0.5 = plano, >0.5 = alcista,
      // <0.5 = bajista, saturando cerca de ±3%. Antes NO se calculaba y el
      // dashboard mostraba 0.5 (50%) constante en los 13 sectores, porque
      // miia_chatbot hacía s.get("score", 0.5) y el campo nunca existía.
      // tanh da una curva suave que no explota con cambios grandes.
      const score = Math.max(0.02, Math.min(0.98, 0.5 + Math.tanh(chg / 3) / 2));
      return {
        sector:    String(s.sector || "Unknown"),
        etf:       s.etf ?? null,
        change:    chg,
        unit:      s.unit === "points" ? "points" : "pct",
        state:     String(s.state || clasificarEstado(chg)),
        score:     +score.toFixed(3),
        riesgo:    +riesgoSector.toFixed(2),
        precio:    s.precio ?? null,
        open:      s.open   ?? null,
        high:      s.high   ?? null,
        low:       s.low    ?? null,
        timestamp: s.timestamp || ts,
        provider:  s.provider  || provider
      };
    });

    // Calcular riesgo global del mercado (usado por class29)
    const riesgoGlobal = calcularRiesgoGlobal(normalizados);

    const payload = {
      source:       "class7",
      type:         "sector_state",
      ts,
      provider,
      riesgoGlobal,
      sectors:      normalizados
    };

    await redisPub.publish(CH_SECTORES, JSON.stringify(payload));
    await redisPub.publish(CH_OUTLETS,  JSON.stringify(payload));  // legacy

    // FIX CRÍTICO: publicar sector_state también a class7_output
    // class10.cs (motor vectorial .NET) escucha class7_output pero solo
    // recibía prices_batch que no produce vectores. Con esta línea recibe
    // el sector_state completo (change_pct, ETFs, riesgoGlobal, estado)
    // y puede construir el vector de 64 dims que alimenta class21-24.
    await redisPub.publish(CH_PRECIOS, JSON.stringify(payload));

    log(`📤 Estado sectorial → ${CH_SECTORES} + ${CH_PRECIOS} (${normalizados.length} sectores, riesgo=${riesgoGlobal.toFixed(3)})`);

    // Persistir SOLO lo que cambió — ver soloCambiados()
    const cambiados = soloCambiados(normalizados);
    _persistidos += cambiados.length;
    _omitidos    += normalizados.length - cambiados.length;
    if (cambiados.length) guardarPrecios(cambiados).catch(() => {});

    // También publicar precios individuales para class43
    await publicarBatchPrecios(normalizados);

    // Publicar cada precio individualmente
    for (const s of normalizados) {
      if (s.etf && s.precio != null) {
        await publicarPrecio(s.etf, {
          close:      s.precio,
          open:       s.open,
          high:       s.high,
          low:        s.low,
          change_pct: s.change
        }, s.sector);
      }
    }

    latestSectors = { sectors: normalizados, timestamp: ts, provider, riesgoGlobal };
    guardarEvento("sector_state", latestSectors);

  } catch (e) {
    log(`❌ publicarEstadoSectores: ${e.message}`, "error");
  }
}

// ============================================================
// CALCULAR RIESGO GLOBAL DEL MERCADO
// Promedio ponderado de cambios negativos
// (usado por class29 para calcular coherencia portafolio)
// ============================================================
function calcularRiesgoGlobal(sectores = null) {
  const datos = sectores || (latestSectors?.sectors ?? []);
  if (!datos.length) return 0.5;
  const declinan = datos.filter(s => s.change < 0);
  if (!declinan.length) return 0.1;   // mercado positivo → bajo riesgo
  const riesgo = declinan.length / datos.length;
  return +riesgo.toFixed(3);
}

// ============================================================
// CYCLE PRINCIPAL: fetch → publicar sectores + precios
// ============================================================
// ── Guard de reentrada (26-sep-2026) ──────────────────────────────────────
// `setInterval(() => executeCycle(), POLLING_INTERVAL)` no espera a que el
// ciclo anterior termine. Con 13 instrumentos un barrido tardaba ~3 s contra 60
// de intervalo y no había forma de solaparse; con 50 y el presupuesto de cuota
// tarda ~56 s contra 90, y un proveedor lento (5 s de timeout por ticker) lo
// pasa. Dos ciclos en vuelo duplican el consumo de cuota y desordenan
// `soloCambiados()`, que compara contra el último precio visto.
let _cicloEnCurso = false;
let _ciclosSaltados = 0;
let _rotCustom = 0;          // rotación de los tickers custom entre ciclos
let _avisoCupoCustom = 0;

async function executeCycle() {
  if (!providerClient) {
    log("Sin proveedor — ciclo saltado", "warn");
    return;
  }
  if (_cicloEnCurso) {
    _ciclosSaltados++;
    if (_ciclosSaltados % 5 === 1)
      log(`⏭️ Ciclo anterior todavía en curso — se saltea este tick ` +
          `(${_ciclosSaltados} salteados). Si crece, el barrido tarda más que ` +
          `POLLING_INTERVAL: subir polling_segundos o llamadas_por_minuto.`, "warn");
    return;
  }
  _cicloEnCurso = true;
  const _t0Ciclo = Date.now();

  try {
    const sectores = await providerClient.fetchSectors();
    if (!Array.isArray(sectores) || sectores.length === 0) {
      log("Proveedor devolvió sectores vacíos", "warn");
      consecutiveErrors++;
      return;
    }

    await publicarEstadoSectores(sectores);

    // Purgar tickers custom vencidos (sin re-pedido en CUSTOM_TTL_MS)
    for (const T of tickersCustom) {
      const ts = tickersCustomTs.get(T) ?? 0;
      if (Date.now() - ts > CUSTOM_TTL_MS) {
        tickersCustom.delete(T);
        tickersCustomTs.delete(T);
        log(`⌛ Ticker custom ${T} expirado (12h sin re-pedido) — se deja de pollear`);
      }
    }

    // ── Tickers custom de class7_watch, con lo que queda del presupuesto ────
    //
    // Antes tenían su PROPIO limiter de 200 ms, así que se cobraban encima del
    // barrido sin contar contra la cuota: 50 instrumentos + 15 del chat se
    // pasan de 60/min. Ahora van por el limiter compartido (lo aplica
    // `crearCliente`) y además se ACOTAN a lo que sobra del minuto, para que un
    // chat activo no le robe llamadas al universo, que es lo que se mide.
    //
    // Los que no entran no se pierden: `_rotCustom` corre el punto de arranque
    // en cada ciclo, así que a lo largo de varios ciclos se cubren todos. Es la
    // misma rotación que usa class1 con los términos de noticias.
    if (tickersCustom.size > 0) {
      const cupo = Math.max(0, CUOTA_POR_MINUTO - Object.keys(SECTOR_ETF_MAP).length);
      const todos = [...tickersCustom];
      if (cupo === 0) {
        if (_avisoCupoCustom++ % 20 === 0)
          log(`⚠️ Sin cupo de cuota para tickers custom: ${Object.keys(SECTOR_ETF_MAP).length} ` +
              `instrumentos ya consumen las ${CUOTA_POR_MINUTO} llamadas/min. ` +
              `Los ${todos.length} del chat no se refrescan — subir llamadas_por_minuto ` +
              `o bajar el universo.`, "warn");
      } else {
        const rot     = _rotCustom % todos.length;
        _rotCustom++;
        const rotados = [...todos.slice(rot), ...todos.slice(0, rot)].slice(0, cupo);
        if (todos.length > cupo)
          log(`⏭️ ${todos.length} tickers custom y cupo de ${cupo}: se refrescan ` +
              `${rotados.length} (rotación desde #${rot}); el resto en los ciclos siguientes`);
        for (const ticker of rotados) {
          try {
            const q = await providerClient.fetchQuote?.(ticker);
            if (q) {
              await publicarPrecio(ticker, q);
              // Persistir historial del ticker custom (gráficos + verificación
              // de sentimiento de class45 necesitan filas en `precios`)
              if (q.close) guardarPrecios([{ ticker, sector: "custom",
                precio: q.close, change: q.change_pct ?? 0 }]).catch(() => {});
            }
          } catch (_) {}
        }
      }
    }

    consecutiveErrors = 0;
    log(`✅ Ciclo completo en ${((Date.now() - _t0Ciclo) / 1000).toFixed(1)}s ` +
        `(${sectores.length} sectores, ${tickersCustom.size} tickers custom, ` +
        `${_llamadasProveedor} llamadas acumuladas)`);

  } catch (e) {
    log(`❌ executeCycle: ${e.message}`, "error");
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_ERRORS) {
      log(`⚠️ ${MAX_ERRORS} errores consecutivos — cambiando proveedor`, "warn");
      await cambiarProveedor();
      consecutiveErrors = 0;
    }
  } finally {
    // En `finally` y no al final del try: si el barrido tira, sin esto el flag
    // queda en true y NINGÚN ciclo posterior vuelve a correr — class7 se apaga
    // en silencio, que es justo el modo de falla que este módulo ya tuvo.
    _cicloEnCurso = false;
  }
}

// ── Cambiar proveedor por fallback ─────────────────────────
const PROVIDERS_ORDER = ["finnhub", "alphavantage", "twelvedata", "polygon"];

async function cambiarProveedor() {
  const idx = PROVIDERS_ORDER.indexOf(currentProvider ?? "");
  const next = PROVIDERS_ORDER[(idx + 1) % PROVIDERS_ORDER.length];
  const key  = API_KEYS[next];
  if (!key) return;
  try {
    const client = crearCliente(next, key);
    if (client) {
      providerClient  = client;
      currentProvider = next;
      log(`🔄 Proveedor cambiado a: ${next}`);
    }
  } catch (_) {}
}

// ============================================================
// MANEJAR COMANDOS DE class7_watch
// Permite que class25 / class43 pidan seguir un ticker
// redis.publish("class7_watch", JSON.stringify({
//   accion: "add",    tickers: ["AAPL","BTC-USD"]
//   accion: "remove", tickers: ["AAPL"]
//   accion: "list"
// }))
// ============================================================
async function manejarWatch(raw) {
  try {
    const cmd = JSON.parse(raw);
    if (cmd.accion === "add" && Array.isArray(cmd.tickers)) {
      const nuevos = [];
      for (const t of cmd.tickers) {
        const T = String(t).toUpperCase();
        if (!tickersCustom.has(T)) nuevos.push(T);
        tickersCustom.add(T);
        tickersCustomTs.set(T, Date.now());   // renovar TTL en cada pedido
      }
      log(`➕ Tickers en seguimiento: ${[...tickersCustom].join(", ")}`);
      // Fetch INMEDIATO de los nuevos: el chat pide análisis on-demand y no
      // puede esperar hasta 60s al próximo ciclo de polling. Publica en
      // class7_output y persiste en `precios` (historial + /api/precios +
      // precio_entrada para que class45 verifique sentimiento del ticker).
      for (const T of nuevos) {
        try {
          const q = await providerClient?.fetchQuote?.(T);
          if (q?.close) {
            await publicarPrecio(T, q);
            guardarPrecios([{ ticker: T, sector: cmd.sector || "custom",
                              precio: q.close, change: q.change_pct ?? 0 }]).catch(() => {});
            log(`⚡ Quote inmediato ${T}: $${q.close} (${q.change_pct ?? 0}%)`);
          } else {
            log(`⚠️ Sin cotización para ${T} en ${currentProvider}`, "warn");
          }
        } catch (e) {
          log(`⚠️ Quote inmediato ${T}: ${e.message}`, "warn");
        }
      }
    } else if (cmd.accion === "remove" && Array.isArray(cmd.tickers)) {
      for (const t of cmd.tickers) {
        const T = String(t).toUpperCase();
        tickersCustom.delete(T);
        tickersCustomTs.delete(T);
      }
    } else if (cmd.accion === "list") {
      if (redisPub.isOpen) {
        await redisPub.publish("class7_watch_response", JSON.stringify({
          tickers: [...tickersCustom],
          sectoresETF: Object.values(SECTOR_ETF_MAP),
          ts: nowIso()
        }));
      }
    }
  } catch (_) {}
}

// ── Guardar evento en log ──────────────────────────────────
async function guardarEvento(tipo, payload) {
  try {
    const line = JSON.stringify({ ts: nowIso(), tipo, payload }) + "\n";
    await fs.promises.appendFile(LOG_FILE, line, "utf8");
  } catch (_) {}
}

// ── Heartbeat de métricas ──────────────────────────────────
async function guardarMetricas() {
  try {
    const m = {
      ts:         nowIso(),
      provider:   currentProvider,
      sectores:   latestSectors?.sectors?.length ?? 0,
      riesgo:     latestSectors?.riesgoGlobal ?? 0,
      tickers:    tickersCustom.size,
      errores:    consecutiveErrors
    };
    await fs.promises.writeFile(
      path.join(METRICS_DIR, "class7_health.json"),
      JSON.stringify(m, null, 2), "utf8"
    );
  } catch (_) {}
}

// ============================================================
// BOOT
// ============================================================
// ── Modo módulo, para probar en frío ──────────────────────────────────────
// Con `CLASS7_SOLO_MODULO=1` el archivo se importa SIN conectar a Redis, sin
// pedir un solo precio y sin abrir timers. Es el mismo criterio que
// CLASS43_SOLO_MODULO y CLASS30_SOLO_MODULO (ver las notas internas): la prueba ejecuta
// el código de producción en vez de reimplementarlo. En producción la variable
// no existe y el comportamiento es idéntico.
const _SOLO_MODULO = process.env.CLASS7_SOLO_MODULO === "1";

if (!_SOLO_MODULO) (async () => {
  try {
    log("=== class7 Observador de Mercado v2.0 ===");
    log(`🌐 Universo: ${resumenUniverso()}`);
    // Se loguea el presupuesto Y el tiempo que implica: así, si alguien sube el
    // universo sin mirar la cuota, la línea dice sola que el barrido no entra en
    // el intervalo — en vez de descubrirlo por 429 tres semanas después.
    {
      const n = Object.keys(SECTOR_ETF_MAP).length;
      const seg = (n / CUOTA_POR_MINUTO * 60);
      log(`🎛️ Cuota: ${CUOTA_POR_MINUTO} llamadas/min (tope duro) · ${n} instrumentos ` +
          `→ barrido ~${seg.toFixed(0)}s contra un intervalo de ${POLLING_SEGUNDOS}s`);
      if (seg > POLLING_SEGUNDOS * 0.9)
        log(`⚠️ El barrido (~${seg.toFixed(0)}s) no entra con holgura en ${POLLING_SEGUNDOS}s: ` +
            `los ciclos se van a saltear. Subir polling_segundos o llamadas_por_minuto ` +
            `en config/universo.json.`, "warn");
    }
    log(`📤 Publica en: ${CH_PRECIOS} (precios + sectores) + ${CH_SECTORES} (sectores)`);
    log(`📡 Escucha: ${CH_WATCH} (tickers custom)`);

    // Conectar Redis
    await Promise.all([redisPub.connect(), redisSub.connect()]);
    log("✅ Redis conectado");

    // Suscribir a class7_watch
    await redisSub.subscribe(CH_WATCH, manejarWatch);
    log(`📡 Suscrito a ${CH_WATCH}`);

    // Inicializar proveedor
    //
    // ── La prueba es UNA cotización, no un barrido entero (26-sep-2026) ────
    // Era `await cliente.fetchSectors()`, o sea N llamadas sólo para saber si
    // la clave sirve — y el primer `executeCycle()`, tres líneas más abajo,
    // repetía las mismas N. Con 13 instrumentos eran 26 llamadas y entraban en
    // las 60/min; con 50 son 100 en el primer minuto. Una sola cotización
    // prueba exactamente lo mismo (clave válida + proveedor respondiendo) y
    // deja las otras 49 del minuto para el ciclo real.
    const TICKER_PRUEBA = Object.values(SECTOR_ETF_MAP)[0] || "XLK";
    for (const nombre of PROVIDERS_ORDER) {
      const key = API_KEYS[nombre];
      if (!key) continue;
      try {
        const cliente = crearCliente(nombre, key);
        const prueba  = await cliente.fetchQuote(TICKER_PRUEBA);
        if (prueba && Number.isFinite(prueba.close) && prueba.close > 0) {
          providerClient  = cliente;
          currentProvider = nombre;
          log(`✅ Proveedor: ${nombre} (prueba con ${TICKER_PRUEBA} = ${prueba.close})`);
          break;
        }
        log(`⚠️ ${nombre}: no devolvió precio para ${TICKER_PRUEBA}`, "warn");
      } catch (e) {
        log(`⚠️ ${nombre}: ${e.message}`, "warn");
      }
    }

    if (!providerClient) {
      log("⚠️ Sin proveedor disponible — modo offline (republicará caché)", "warn");
    }

    // Primer ciclo inmediato
    await executeCycle();

    // Ciclo periódico
    setInterval(() => executeCycle(), POLLING_INTERVAL);

    // Métricas cada 2 minutos
    setInterval(() => guardarMetricas(), 2 * 60 * 1000).unref();

    // Heartbeat
    setInterval(() => {
      // persistidos/omitidos: la prueba observable de la deduplicación.
      // Con el mercado abierto omitidos debería ser bajo; con el mercado
      // cerrado debería tender al 100 %. Si de día omite casi todo, el
      // proveedor está devolviendo dato congelado y hay que mirar eso.
      const _tot = _persistidos + _omitidos;
      log(`❤️  sectores=${latestSectors?.sectors?.length ?? 0} riesgo=${(latestSectors?.riesgoGlobal ?? 0).toFixed(3)} tickers=${tickersCustom.size} ` +
          `escrituras=${_persistidos} omitidas=${_omitidos}` +
          (_tot ? ` (${((_omitidos / _tot) * 100).toFixed(0)}% ahorrado)` : ""));
      // Cuota: `pendientes` es la cola del limiter. Si es > 0 de forma
      // sostenida, el barrido no entra en el presupuesto y hay que subir
      // llamadas_por_minuto o el intervalo. Si `salteados` crece, el ciclo tarda
      // más que POLLING_INTERVAL.
      const cola = limiterCuota.counts();
      log(`   cuota: ${CUOTA_POR_MINUTO}/min · ${_llamadasProveedor} llamadas totales · ` +
          `en cola=${cola.QUEUED ?? 0} ejecutando=${cola.RUNNING ?? 0} · ` +
          `ciclos salteados=${_ciclosSaltados}`);
    }, 30 * 1000).unref();

    log("✅ class7 operativo");

  } catch (e) {
    log(`❌ Boot error: ${e.message}`, "error");
    setTimeout(() => process.exit(1), 3000);
  }
})();

process.on("uncaughtException",  e => log(`uncaughtException: ${e.message}`, "error"));
process.on("unhandledRejection", e => log(`unhandledRejection: ${String(e)}`, "error"));
process.on("SIGINT", async () => {
  log("Cerrando...");
  try { await redisPub.quit(); } catch (_) {}
  try { await redisSub.quit(); } catch (_) {}
  process.exit(0);
});

// ── Exports ────────────────────────────────────────────────
export async function getLatestSectors() {
  return latestSectors || { sectors: [], timestamp: null, provider: null };
}
export async function snapshotOnce() {
  await executeCycle();
  return latestSectors;
}
export function startWatcher(opts = {}) {
  log("startWatcher() llamado — class7 v2 arranca automáticamente al iniciarse");
}

// Se exportan SOLO para `docs/simulaciones/sim16_cuota_class7.js`. Nada del
// sistema los importa: los módulos se hablan por Redis, así que agregar exports
// no crea acoplamiento (mismo criterio que `_test` en class43.js).
export const _test = {
  crearCliente,
  limiterCuota,
  CUOTA_POR_MINUTO,
  POLLING_INTERVAL,
  llamadas: () => _llamadasProveedor,
  cicloEnCurso: () => _cicloEnCurso,
  executeCycle,
  setProveedor: (c) => { providerClient = c; currentProvider = "falso"; },
  tickersCustom,
  tickersCustomTs,
};
export function stopWatcher() {
  log("stopWatcher() — usar SIGINT para detener");
}