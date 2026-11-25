/**
 * chat_evidencia.js — la evidencia con la que el chat contesta, y la validación
 * de lo que redacta el motor de lenguaje.
 *
 * Puro, como `chat_router.js`: sin Redis, sin MySQL, sin red. class25B le pasa
 * un PANEL —una foto de lo que el sistema ya tiene en memoria— y esto devuelve,
 * para cada intención, los hechos con número que la respuesta puede usar.
 *
 * DE DÓNDE SALE CADA DATO (ninguno agrega carga al server)
 * --------------------------------------------------------
 *   ranking       el puesto de cada instrumento en la sección transversal, tal
 *                 cual lo publica class25A en `class25a_output` (`puesto`,
 *                 `puestos_n`, `rank_k`). class25B ya recibe cada mensaje; sólo
 *                 se guarda el último por ticker.
 *   cotizaciones  el `sector_state` de class7 (`class7_output`, cada ~90 s): el
 *                 cambio del día de los 50. Tampoco es una consulta nueva.
 *   amplitud      un anillo de (cuántos suben, promedio) armado con esas mismas
 *                 cotizaciones: es lo que deja ver la tendencia DENTRO del día.
 *   riesgo/lstm/  lo que el Python ya manda en el `human_query` del chat.
 *   sentimiento
 *   métricas      el endpoint de la tesis, que el Python sirve de su caché.
 *
 * LA VALIDACIÓN ("validación de evidencia" del punto 10)
 * -----------------------------------------------------
 * `validarRespuesta()` rechaza lo que el 2B escribe cuando: nombra un proveedor
 * o un módulo interno, da un consejo de compra/venta, se escapa con "no tengo
 * acceso a datos en tiempo real", cita un número que NO está en los hechos, o
 * nombra un instrumento del que no se le pasó ningún dato. Si rechaza, contesta
 * el redactor propio (chat_redactor.js) con los mismos hechos.
 */

// ── Formato es-AR ─────────────────────────────────────────────────────────
export function num(x, dec = 1) {
  if (x == null || !isFinite(x)) return "–";
  return Number(x).toFixed(dec).replace(".", ",");
}
export function pct(x, dec = 1, signo = true) {
  if (x == null || !isFinite(x)) return "–";
  const v = Number(Number(x).toFixed(dec));
  const s = signo && v > 0 ? "+" : "";
  return `${s}${num(v, dec)}%`;
}

// ── Nombres en castellano ─────────────────────────────────────────────────
const SECTOR_ES = {
  "Technology": "tecnología", "Financials": "sector financiero", "Energy": "energía",
  "Healthcare": "salud", "Consumer Discretionary": "consumo discrecional",
  "Industrials": "industria", "Materials": "materiales", "Real Estate": "inmobiliario",
  "Utilities": "servicios públicos", "Communication Services": "comunicaciones",
  "Consumer Staples": "consumo básico", "US Large Cap": "S&P 500",
  "US Nasdaq 100": "Nasdaq 100", "US Small Cap": "small caps de EE.UU.",
  "US Dow 30": "Dow Jones", "Developed ex-US": "desarrollados fuera de EE.UU.",
  "Emerging Markets": "emergentes", "Japan": "Japón", "Germany": "Alemania",
  "United Kingdom": "Reino Unido", "Switzerland": "Suiza", "South Korea": "Corea del Sur",
  "Taiwan": "Taiwán", "Hong Kong": "Hong Kong", "Australia": "Australia", "India": "India",
  "China Large Cap": "China", "Canada": "Canadá", "Mexico": "México",
  "MERVAL": "Argentina (Merval)", "Brazil": "Brasil", "Latin America": "Latinoamérica",
  "Semiconductors": "semiconductores", "Biotech": "biotecnología", "REITs": "REITs inmobiliarios",
  "Oil and Gas E&P": "petroleras", "Regional Banks": "bancos regionales",
  "Homebuilders": "constructoras", "Airlines": "aerolíneas", "Transportation": "transporte",
  "Metals and Mining": "metales y minería", "Gold Miners": "mineras de oro", "Retail": "retail",
  "Disruptive Innovation": "innovación disruptiva", "Factor Momentum": "factor momentum",
  "Factor Quality": "factor calidad", "Factor Value": "factor valor",
  "Factor Growth": "factor crecimiento", "Factor Min Volatility": "factor baja volatilidad",
  "Factor Large Growth": "grandes de crecimiento",
};
const REGION_ES = { US: "EE.UU.", LATAM: "Latinoamérica", APAC: "Asia-Pacífico",
                    EUROPE: "Europa", GLOBAL: "global" };
export function sectorES(s) { return SECTOR_ES[s] || s || ""; }
export function regionES(r) { return REGION_ES[r] || r || ""; }

export const DEFENSIVOS = ["XLU", "XLP", "XLV", "USMV"];
export const CICLICOS   = ["XLY", "XLI", "XLF", "XLB", "IWM", "XLK"];

// ── Calendario del NYSE ───────────────────────────────────────────────────
// Feriados y medias ruedas 2026-2027 (calendario oficial del NYSE). Fuera de
// ese rango vale la regla de lunes a viernes y se avisa.
const FERIADOS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const MEDIA_RUEDA = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Respaldo si el Node no trae la zona America/New_York (un build con ICU
// recortado): horario de verano de EE.UU. = del 2.º domingo de marzo al 1.er
// domingo de noviembre, a las 2:00 locales.
function _partesNYSinIntl(fecha) {
  const y = fecha.getUTCFullYear();
  const domingo = (mes, n) => { const d = new Date(Date.UTC(y, mes, 1)); const off = (7 - d.getUTCDay()) % 7; return 1 + off + (n - 1) * 7; };
  const iniDST = Date.UTC(y, 2, domingo(2, 2), 7), finDST = Date.UTC(y, 10, domingo(10, 1), 6);
  const off = fecha.getTime() >= iniDST && fecha.getTime() < finDST ? -240 : -300;
  const l = new Date(fecha.getTime() + off * 60000);
  const y2 = l.getUTCFullYear(), m = l.getUTCMonth() + 1, d = l.getUTCDate();
  return { y: y2, m, d, h: l.getUTCHours(), mi: l.getUTCMinutes(), wd: l.getUTCDay(), off,
           iso: `${y2}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}
function _partesNY(fecha) {
  try { return _partesNYIntl(fecha); } catch (_) { return _partesNYSinIntl(fecha); }
}
function _partesNYIntl(fecha) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(fecha);
  const g = k => f.find(p => p.type === k)?.value;
  const y = +g("year"), m = +g("month"), d = +g("day"), h = +g("hour") % 24, mi = +g("minute");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  const off = Math.round((Date.UTC(y, m - 1, d, h, mi) - Math.floor(fecha.getTime() / 60000) * 60000) / 60000);
  return { y, m, d, h, mi, wd, off, iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}
function _hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
function _habil(iso, wd) { return wd >= 1 && wd <= 5 && !FERIADOS.has(iso); }

/** Estado del NYSE en `fecha` (por defecto, ahora). Horario regular 9:30-16:00 ET. */
export function estadoNYSE(fecha = new Date()) {
  const p = _partesNY(fecha);
  const difAR = (-180 - p.off) / 60;            // Argentina es UTC-3 todo el año
  const ahora = p.h * 60 + p.mi;
  const ABRE = 570, CIERRA = MEDIA_RUEDA.has(p.iso) ? 780 : 960;
  const hab = _habil(p.iso, p.wd);
  let abierto = false, motivo;
  if (!hab) motivo = (p.wd === 0 || p.wd === 6) ? "fin de semana" : "feriado";
  else if (ahora < ABRE) motivo = "todavía no abrió";
  else if (ahora >= CIERRA) motivo = "ya cerró";
  else { abierto = true; motivo = MEDIA_RUEDA.has(p.iso) ? "media rueda" : "rueda normal"; }

  // Próxima apertura.
  let proxima = null;
  if (!abierto) {
    for (let i = (hab && ahora < ABRE) ? 0 : 1; i <= 7; i++) {
      const q = _partesNY(new Date(fecha.getTime() + i * 86400000));
      if (_habil(q.iso, q.wd)) {
        proxima = { etiqueta: i === 0 ? "hoy" : i === 1 ? "mañana" : `el ${DIAS[q.wd]}`,
                    dia: DIAS[q.wd], iso: q.iso, enDias: i };
        break;
      }
    }
  }
  return {
    abierto, motivo, medioDia: MEDIA_RUEDA.has(p.iso), diaNY: DIAS[p.wd], isoNY: p.iso,
    horaNY: _hhmm(ahora), horaAR: _hhmm(ahora + difAR * 60),
    aperturaNY: "9:30", aperturaAR: _hhmm(ABRE + difAR * 60),
    cierreNY: _hhmm(CIERRA), cierreAR: _hhmm(CIERRA + difAR * 60),
    minParaCierre: abierto ? CIERRA - ahora : null,
    proxima, fueraDeCalendario: p.y > 2027,
  };
}

// ── Panel ─────────────────────────────────────────────────────────────────
// Un dato que FALTA queda en null. `Number(null)` y `Number("")` dan 0, y eso
// hacía decir «riesgo global 0% (bajo)» cuando todavía no había llegado ningún
// riesgo (5-nov-2026): un faltante se leía como el valor más tranquilizador.
function _n(x) { if (x == null || x === "") return null; const v = Number(x); return isFinite(v) ? v : null; }

/** Normaliza lo que manda class25B (tolerante a campos faltantes). */
export function armarPanel(raw = {}) {
  const ahora = _n(raw.ahora) ?? Date.now();
  const inst = {};
  for (const i of (raw.instrumentos || [])) {
    if (i?.ticker) inst[String(i.ticker).toUpperCase()] = { sector: i.sector, region: i.region };
  }
  const universo = Object.keys(inst);

  // Cotizaciones de los instrumentos del universo.
  const cotiz = {};
  for (const [tk, c] of Object.entries(raw.cotizaciones || {})) {
    const T = tk.toUpperCase();
    if (!inst[T] || !c) continue;
    const cambio = _n(c.cambio ?? c.change ?? c.change_pct);
    if (cambio == null) continue;
    cotiz[T] = { cambio, precio: _n(c.precio ?? c.close), ts: _n(c.ts) };
  }

  // Ranking: la última sección transversal. Se toman las entradas de los
  // ~30 min previos a la más nueva, para que los puestos sean comparables.
  const rk = {};
  const entradas = Object.entries(raw.ranking || {})
    .map(([tk, r]) => [tk.toUpperCase(), r])
    .filter(([tk, r]) => inst[tk] && r && _n(r.puesto) != null && _n(r.puesto) >= 0 && _n(r.n) > 1);
  const tsMax = Math.max(0, ...entradas.map(([, r]) => _n(r.ts) || 0));
  for (const [tk, r] of entradas) {
    if (tsMax && _n(r.ts) && tsMax - _n(r.ts) > 30 * 60000) continue;
    rk[tk] = {
      senal: String(r.senal || "HOLD").toUpperCase(), puesto: _n(r.puesto), n: _n(r.n),
      k: _n(r.k) || Math.max(1, Math.round(_n(r.n) * 2 / 13)),
      conf: _n(r.conf ?? r.confianza), z: _n(r.z), ts: _n(r.ts), aprox: !!r.aprox,
    };
  }

  const sent = {};
  for (const [tk, s] of Object.entries(raw.sentimiento || {})) {
    if (!s || s._heartbeat) continue;
    const lbl = String(s.label ?? s.sentiment_label ?? s.señal ?? "").toUpperCase();
    const n = _n(s.n ?? s.n_articulos);
    if (!lbl) continue;
    sent[tk.toUpperCase()] = { label: lbl, n };
  }
  const lstm = {};
  for (const [tk, l] of Object.entries(raw.lstm || {})) {
    if (!l) continue;
    const senal = String(l.senal ?? l.señal ?? "").toUpperCase();
    if (!senal) continue;
    let conf = _n(l.conf ?? l.confianza);
    if (conf != null && conf <= 1) conf *= 100;
    lstm[tk.toUpperCase()] = { senal, conf, rsi: _n(l.rsi ?? l.indicadores?.rsi) };
  }
  const riesgoActivo = {};
  for (const [tk, r] of Object.entries(raw.riesgoActivo || {})) {
    if (!r) continue;
    const vol = _n(r.vol ?? r.vol_pct), dd = _n(r.dd ?? r.drawdown_pct), ind = _n(r.indice ?? r.riesgo_vol_pct);
    if (vol == null) continue;
    riesgoActivo[tk.toUpperCase()] = { vol, dd, indice: ind,
                                       vol2d: _n(r.vol_2d_pct), ratio: _n(r.ratio_vol) };
  }
  const titulares = {};
  for (const [tk, arr] of Object.entries(raw.titulares || {})) {
    if (Array.isArray(arr) && arr.length) titulares[tk.toUpperCase()] = arr.slice(0, 3);
  }

  return {
    ahora, inst, universo, cotiz, rk, sent, lstm, riesgoActivo, titulares,
    riesgo: _n(raw.riesgo), amplitud: Array.isArray(raw.amplitud) ? raw.amplitud : [],
    metricas: normalizarMetricas(raw.metricas), alertas: (raw.alertas || []).filter(Boolean),
    mercado: raw.mercado || estadoNYSE(new Date(ahora)),
    crisis: raw.crisis || [], portfolio: raw.portfolio || null,
    perfil: raw.perfil || null, monto: raw.monto || null, nombre: raw.nombre || null,
  };
}

/**
 * Métricas de la tesis. Acepta el payload de /api/backtesting/professional o el
 * `metricas_context` que el Python inyecta en el chat. Guarda anti-inflado: un
 * acierto fuera de 30-70 % no es el número honesto (el «97 %» de
 * backtesting_stats que se sacó de la web el 13-sep) y se descarta.
 */
export function normalizarMetricas(m) {
  if (!m || typeof m !== "object") return null;
  const acc  = _n(m.accuracy_directional ?? m.accuracy ?? m.acc);
  if (acc == null || acc < 30 || acc > 70) return null;
  const mde = _n(m.edge_min_detectable ?? m.mde), n = _n(m.n_efectivo ?? m.n);
  const rankIc = _n(m.rank_ic), rankIcMde = _n(m.rank_ic_min_detectable);
  const rankIcVent = _n(m.rank_ic_ventanas);
  const rs = m.rank_ic_significativo;
  const rankIcSignif = rs === true || rs === "true" || rs === 1;
  const porRegimen = m.rank_ic_por_regimen && typeof m.rank_ic_por_regimen === "object" ? m.rank_ic_por_regimen : null;
  // La vara es el AZAR con la misma mezcla de BUY y SELL (6-nov-2026), el mismo
  // número que el panel: ver ventajaVsAzar. Si el payload no trae con qué
  // calcularlo, queda el base rate de antes, rotulado como tal.
  const va = ventajaVsAzar(m, acc);
  if (va) {
    const s = m.edge_azar_significativo;
    return { acc, base: va.azar, edge: va.edge, baseTipo: "azar",
             signif: s === true || s === "true" || s === 1 ||
                     (s == null && _n(m.accuracy_ci_low) != null && _n(m.accuracy_ci_low) > va.azar),
             mde, n, rankIc, rankIcMde, rankIcVent, rankIcSignif, porRegimen };
  }
  const base = _n(m.base_rate ?? m.base);
  const edge = _n(m.edge_vs_baseline ?? m.edge) ?? (base != null ? +(acc - base).toFixed(1) : null);
  const signif = m.edge_significativo ?? m.significativo;
  return {
    acc, base, edge, baseTipo: "mayoria", signif: signif === true || signif === "true" || signif === 1,
    mde, n, rankIc, rankIcMde, rankIcVent, rankIcSignif, porRegimen,
  };
}

/**
 * La ventaja contra el AZAR con la misma mezcla BUY/SELL. Copia de
 * `_miiaVentajaAzar` (publi_src/index.html y que-es-miia.html) y de
 * `_ventaja_vs_azar` (miia_chatbot.py); sim38 verifica que las cuatro coincidan.
 * Usa los campos del backend si vienen; si no, los calcula con la precisión de
 * cada señal. Devuelve null si no hay con qué.
 */
export function ventajaVsAzar(m, acc = _n(m?.accuracy_directional)) {
  if (!m || acc == null) return null;
  const azarB = _n(m.azar_mezcla), edgeB = _n(m.edge_vs_azar);
  if (azarB != null && edgeB != null) return { azar: azarB, edge: edgeB };
  const aBuy = _n(m.precision_buy), aSell = _n(m.precision_sell), base = _n(m.base_rate);
  if (aBuy == null && aSell == null) return null;
  // La fracción de BUY (q) no viene en el payload: se busca la que mejor
  // reproduce el acierto y el base rate que sí vienen (mínimos cuadrados sobre
  // 2001 valores; con datos exactos los reproduce justo, y con el redondeo a un
  // decimal el error queda en ±0,25 pp). Con un solo lado, q es 0 o 1 y la
  // ventaja da 0: un sistema de un solo lado no puede mostrar ventaja.
  let q = aBuy == null ? 0 : aSell == null ? 1 : 0.5;
  let p = aBuy == null ? 100 - aSell : aBuy;            // % que le ganó al promedio
  if (aBuy != null && aSell != null) {
    let mejor = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const qi = i / 2000, pi = qi * aBuy + (1 - qi) * (100 - aSell);
      const e = (qi * aBuy + (1 - qi) * aSell - acc) ** 2
              + (base != null ? (Math.max(pi, 100 - pi) - base) ** 2 : 0)
              + 1e-6 * (qi - 0.5) ** 2;                 // empate → la mezcla pareja
      if (e < mejor) { mejor = e; q = qi; p = pi; }
    }
  }
  const azar = q * p + (1 - q) * (100 - p);
  return { azar: Math.round(azar * 10) / 10, edge: Math.round((acc - azar) * 10) / 10 };
}

// ── Agregados ─────────────────────────────────────────────────────────────
function _mediana(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; }
function _cuantil(s, q) { if (!s.length) return null; const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1)))); return s[i]; }
function _media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

/** Cómo viene el día: amplitud, promedio, extremos, dispersión, regiones. */
export function agregadoHoy(P, filtro = null) {
  const lista = Object.entries(P.cotiz)
    .filter(([tk]) => !filtro || filtro.includes(tk))
    .map(([tk, c]) => ({ tk, cambio: c.cambio }))
    .sort((a, b) => b.cambio - a.cambio);
  if (!lista.length) return null;
  const valores = lista.map(x => x.cambio);
  const ord = [...valores].sort((a, b) => a - b);
  const porRegion = {};
  for (const x of lista) {
    const r = P.inst[x.tk]?.region || "?";
    (porRegion[r] ||= []).push(x.cambio);
  }
  const regiones = Object.entries(porRegion)
    .filter(([, a]) => a.length >= 2)
    .map(([r, a]) => ({ region: r, nombre: regionES(r), media: _media(a), n: a.length }))
    .sort((a, b) => b.media - a.media);
  return {
    n: lista.length, positivos: valores.filter(v => v > 0).length,
    negativos: valores.filter(v => v < 0).length,
    media: _media(valores), mediana: _mediana(valores),
    mejores: lista.slice(0, 3), peores: lista.slice(-3).reverse(),
    dispersion: _cuantil(ord, 0.9) - _cuantil(ord, 0.1), regiones, lista,
  };
}

/** La sección transversal del ranking, ordenada del mejor al peor. */
export function agregadoRanking(P, filtro = null) {
  const lista = Object.entries(P.rk)
    .filter(([tk]) => !filtro || filtro.includes(tk))
    .map(([tk, r]) => ({ tk, ...r }))
    .sort((a, b) => a.puesto - b.puesto);
  if (!lista.length) return null;
  const n = Math.max(...lista.map(x => x.n));
  const k = Math.max(...lista.map(x => x.k));
  const arriba = lista.filter(x => x.senal === "BUY");
  const abajo  = lista.filter(x => x.senal === "SELL").sort((a, b) => b.puesto - a.puesto);
  const regionesArriba = {};
  for (const x of arriba) { const r = P.inst[x.tk]?.region; if (r) regionesArriba[r] = (regionesArriba[r] || 0) + 1; }
  return { lista, n, k, arriba, abajo, regionesArriba, aprox: lista.some(x => x.aprox),
           ts: Math.max(...lista.map(x => x.ts || 0)) || null };
}

/** Todo lo que el sistema sabe de UN instrumento. */
export function vistaTicker(tk, P, hoy = agregadoHoy(P)) {
  const T = String(tk).toUpperCase();
  const inst = P.inst[T] || {};
  const v = { tk: T, nombre: sectorES(inst.sector), region: regionES(inst.region),
              regionCod: inst.region || null, enUniverso: !!P.inst[T] };
  const r = P.rk[T];
  if (r) {
    const zona = r.puesto < r.k ? "arriba" : r.puesto >= r.n - r.k ? "abajo" : "medio";
    v.rank = { senal: r.senal, puesto: Math.round(r.puesto) + 1, n: r.n, k: r.k,
               conf: r.conf != null ? Math.round(r.conf <= 1 ? r.conf * 100 : r.conf) : null,
               z: r.z, zona, aprox: r.aprox,
               edadMin: r.ts ? Math.round((P.ahora - r.ts) / 60000) : null };
  }
  const c = P.cotiz[T];
  if (c) {
    const pos = hoy ? hoy.lista.findIndex(x => x.tk === T) + 1 : null;
    v.hoy = { cambio: c.cambio, precio: c.precio,
              relativo: hoy ? c.cambio - hoy.media : null, mediaUniverso: hoy?.media ?? null,
              puestoHoy: pos || null, nHoy: hoy?.n ?? null };
  }
  if (P.sent[T])         v.sent = P.sent[T];
  if (P.lstm[T])         v.lstm = P.lstm[T];
  if (P.riesgoActivo[T]) {
    const ra = P.riesgoActivo[T];
    const ind = ra.indice;
    v.riesgo = { ...ra, nivel: ind == null ? null : ind > 66 ? "alto" : ind > 33 ? "moderado" : "bajo" };
  }
  if (P.titulares[T])    v.titulares = P.titulares[T];

  // Postura: lo que el sistema "opina", con su motivo.
  let puntos = 0;
  if (v.rank) puntos += v.rank.zona === "arriba" ? 2 : v.rank.zona === "abajo" ? -2 : 0;
  if (v.hoy?.relativo != null) puntos += v.hoy.relativo > 0.5 ? 1 : v.hoy.relativo < -0.5 ? -1 : 0;
  if (v.sent) puntos += /BULL|POSIT/.test(v.sent.label) ? 0.5 : /BEAR|NEGAT/.test(v.sent.label) ? -0.5 : 0;
  v.postura = !v.rank && !v.hoy ? null : puntos >= 2 ? "fuerte" : puntos <= -2 ? "debil" : "neutral";
  v.contradice = !!(v.rank && v.hoy?.relativo != null &&
    ((v.rank.zona === "arriba" && v.hoy.relativo < -0.5) || (v.rank.zona === "abajo" && v.hoy.relativo > 0.5)));
  v.tieneDatos = !!(v.rank || v.hoy || v.sent || v.riesgo);
  return v;
}

/** Un grupo ("Estados Unidos" = SPY, QQQ, IWM, DIA) resumido. */
export function vistaGrupo(etiqueta, tickers, P, hoy = agregadoHoy(P)) {
  const vistas = tickers.map(t => vistaTicker(t, P, hoy)).filter(v => v.enUniverso);
  const conRank = vistas.filter(v => v.rank).sort((a, b) => a.rank.puesto - b.rank.puesto);
  const conHoy = vistas.filter(v => v.hoy).sort((a, b) => b.hoy.cambio - a.hoy.cambio);
  return {
    etiqueta, vistas, conRank, conHoy,
    arriba: conRank.filter(v => v.rank.zona === "arriba"),
    abajo: conRank.filter(v => v.rank.zona === "abajo"),
    mediaHoy: conHoy.length ? _media(conHoy.map(v => v.hoy.cambio)) : null,
    mediaUniverso: hoy?.media ?? null,
    mejorRank: conRank[0] || null, peorRank: conRank[conRank.length - 1] || null,
    mejorHoy: conHoy[0] || null, peorHoy: conHoy[conHoy.length - 1] || null,
    tieneDatos: vistas.some(v => v.tieneDatos),
  };
}

/** Patrones del día, ordenados por fuerza. Cada uno con sus números. */
export function patrones(P, hoy = agregadoHoy(P), rank = agregadoRanking(P)) {
  const out = [];
  if (hoy) {
    // Rotación defensivos vs. cíclicos.
    const med = l => { const v = l.map(t => P.cotiz[t]?.cambio).filter(x => x != null); return v.length >= 2 ? _media(v) : null; };
    const d = med(DEFENSIVOS), c = med(CICLICOS);
    if (d != null && c != null && Math.abs(d - c) >= 0.6) {
      out.push({ clave: d > c ? "defensivos" : "ciclicos", fuerza: Math.abs(d - c),
                 defensivos: d, ciclicos: c });
    }
    // Rotación entre regiones.
    if (hoy.regiones.length >= 2) {
      const a = hoy.regiones[0], b = hoy.regiones[hoy.regiones.length - 1];
      if (a.media - b.media >= 0.6) out.push({ clave: "regiones", fuerza: a.media - b.media, lider: a, rezagada: b });
    }
    // Movimiento en bloque o día de mucha dispersión.
    const fr = hoy.positivos / hoy.n;
    if (fr >= 0.8 || fr <= 0.2) out.push({ clave: "bloque", fuerza: Math.abs(fr - 0.5) * 4, positivos: hoy.positivos, n: hoy.n, media: hoy.media });
    else if (hoy.dispersion >= 3) out.push({ clave: "dispersion", fuerza: hoy.dispersion / 2, dispersion: hoy.dispersion, mejor: hoy.mejores[0], peor: hoy.peores[0] });
    // Movimientos fuertes de un solo instrumento.
    const fuertes = hoy.lista.filter(x => Math.abs(x.cambio) >= 3);
    if (fuertes.length && fuertes.length <= 5) out.push({ clave: "extremos", fuerza: Math.max(...fuertes.map(x => Math.abs(x.cambio))) / 2, lista: fuertes });
  }
  // Tendencia de la amplitud dentro de la sesión.
  const ses = (P.amplitud || []).filter(a => a && a.n >= 10 && P.ahora - a.ts < 8 * 3600000);
  if (ses.length >= 4) {
    const i = ses[0], f = ses[ses.length - 1];
    const dif = f.positivos - i.positivos;
    if (Math.abs(dif) >= 6) out.push({ clave: "amplitud", fuerza: Math.abs(dif) / 5, desde: i.positivos, hasta: f.positivos, n: f.n,
                                         minutos: Math.round((f.ts - i.ts) / 60000), enRueda: !!P.mercado?.abierto });
  }
  // Concentración del ranking: cuando los BUY se amontonan en una región.
  if (rank && rank.arriba.length >= 4) {
    const [reg, cant] = Object.entries(rank.regionesArriba).sort((a, b) => b[1] - a[1])[0] || [];
    const peso = Object.values(P.inst).filter(i => i.region === reg).length / Math.max(1, Object.keys(P.inst).length);
    if (reg && cant / rank.arriba.length >= Math.max(0.6, peso + 0.25)) {
      out.push({ clave: "concentracion", fuerza: (cant / rank.arriba.length) * 2, region: regionES(reg), cant, de: rank.arriba.length });
    }
  }
  // ¿El ranking va en la misma dirección que el día?
  if (rank && hoy && rank.arriba.length >= 3 && rank.abajo.length >= 3) {
    const sub = rank.arriba.filter(x => (P.cotiz[x.tk]?.cambio ?? 0) > 0).length;
    const baj = rank.abajo.filter(x => (P.cotiz[x.tk]?.cambio ?? 0) < 0).length;
    const acuerdo = (sub + baj) / (rank.arriba.length + rank.abajo.length);
    if (acuerdo >= 0.75 || acuerdo <= 0.25) out.push({ clave: "acuerdo", fuerza: Math.abs(acuerdo - 0.5) * 3, acuerdo, sub, nA: rank.arriba.length, baj, nB: rank.abajo.length });
  }
  for (const a of (P.alertas || []).slice(0, 1)) out.push({ clave: "alerta", fuerza: 1.5, texto: a });
  return out.sort((a, b) => b.fuerza - a.fuerza);
}

/** Régimen "objetivo" del día, por amplitud, promedio y riesgo. */
export function regimen(P, hoy = agregadoHoy(P)) {
  if (!hoy) return null;
  const fr = hoy.positivos / hoy.n, r = P.riesgo;
  let etiqueta = "lateral";
  if (r != null && r > 0.8 && hoy.media < -1.5) etiqueta = "de crisis";
  else if (fr >= 0.6 && hoy.media > 0.3) etiqueta = "alcista";
  else if (fr <= 0.4 && hoy.media < -0.3) etiqueta = "bajista";
  return { etiqueta, positivos: hoy.positivos, n: hoy.n, media: hoy.media, riesgo: r };
}

export function nivelRiesgo(r) {
  if (r == null) return null;
  return r > 0.7 ? "alto" : r > 0.45 ? "moderado" : "bajo";
}

// ── Hechos en texto (lo que ve el motor de lenguaje) ──────────────────────
function _hechoTicker(v) {
  const h = [];
  const nom = v.nombre ? ` (${v.nombre})` : "";
  if (v.rank) h.push(`${v.tk}${nom}: puesto ${v.rank.puesto} de ${v.rank.n} en el ranking, señal ${v.rank.senal}${v.rank.conf != null ? `, confianza ${v.rank.conf}%` : ""}.`);
  if (v.hoy) h.push(`${v.tk} hoy ${pct(v.hoy.cambio)}${v.hoy.mediaUniverso != null ? ` (promedio de los ${v.hoy.nHoy}: ${pct(v.hoy.mediaUniverso)})` : ""}.`);
  if (v.riesgo) h.push(`${v.tk} riesgo 60 días: volatilidad ${num(v.riesgo.vol, 0)}% anual, caída máxima ${num(v.riesgo.dd, 0)}%.`);
  if (v.sent) h.push(`${v.tk} noticias: sentimiento ${_sentES(v.sent.label)}${v.sent.n ? ` (${v.sent.n} artículos)` : ""}.`);
  return h;
}
export function _sentES(l) {
  return /BULL|POSIT/.test(l) ? "positivo" : /BEAR|NEGAT/.test(l) ? "negativo" : "neutral";
}
function _hechoMercado(P, hoy) {
  const h = [];
  const m = P.mercado;
  if (m) h.push(`NYSE ${m.abierto ? "abierto" : `cerrado (${m.motivo})`}.`);
  if (P.riesgo != null) h.push(`Riesgo global ${Math.round(P.riesgo * 100)}% (${nivelRiesgo(P.riesgo)}).`);
  if (hoy) {
    h.push(`Suben ${hoy.positivos} de ${hoy.n}; promedio ${pct(hoy.media)}.`);
    h.push(`Mejor ${hoy.mejores[0].tk} ${pct(hoy.mejores[0].cambio)}; peor ${hoy.peores[0].tk} ${pct(hoy.peores[0].cambio)}.`);
  }
  return h;
}

// ── Evidencia por intención ───────────────────────────────────────────────
/**
 * @param {object} intento  salida de chat_router.clasificar
 * @param {object} P        salida de armarPanel
 * @returns {{intencion, hechos: string[], datos: object, suficiente: boolean}}
 */
export function evidencia(intento, P) {
  const it = intento?.intencion || "libre";
  const hoy = agregadoHoy(P);
  const rank = agregadoRanking(P);
  const tks = intento?.tickers || [];
  const grupos = (intento?.grupos?.length ? intento.grupos : (intento?.grupo ? [intento.grupo] : []));
  const datos = { hoy, rank, mercado: P.mercado, riesgo: P.riesgo, nivel: nivelRiesgo(P.riesgo),
                  alertas: P.alertas, metricas: P.metricas, nombre: P.nombre };
  let hechos = [];
  let suficiente = true;

  const conTickers = () => {
    datos.vistas = (intento?.tickers || []).map(t => vistaTicker(t, P, hoy));
    datos.grupos = grupos.filter(g => !(intento?.tickers || []).some(t => g.tickers.length === 1 && g.tickers[0] === t))
      .map(g => vistaGrupo(g.etiqueta, g.tickers, P, hoy));
    for (const v of datos.vistas) hechos.push(..._hechoTicker(v));
    for (const g of datos.grupos) {
      hechos.push(`${g.etiqueta}: ${g.vistas.map(v => v.tk).join(", ")}.`);
      for (const v of g.vistas) hechos.push(..._hechoTicker(v).slice(0, 2));
    }
    suficiente = datos.vistas.some(v => v.tieneDatos) || datos.grupos.some(g => g.tieneDatos);
  };

  switch (it) {
    case "opinion": case "senal": case "porque": case "riesgo": case "precio":
    case "noticias": case "comparar":
      if (!tks.length && !grupos.length) {
        // Sin instrumento: hablar del mercado (riesgo/noticias/porqué genéricos).
        hechos = _hechoMercado(P, hoy);
        datos.sentimientoGeneral = Object.entries(P.sent).map(([tk, x]) => ({ tk, ...x }));
        datos.patrones = patrones(P, hoy, rank);
        suficiente = hechos.length > 0;
      } else conTickers();
      if (P.metricas) datos.metricas = P.metricas;
      break;
    case "ranking": {
      const filtro = grupos.length ? grupos.flatMap(g => g.tickers) : null;
      datos.rankFiltro = agregadoRanking(P, filtro);
      datos.hoyFiltro = agregadoHoy(P, filtro);
      datos.filtro = grupos[0]?.etiqueta || null;
      const r = datos.rankFiltro, h = datos.hoyFiltro;
      if (r?.arriba.length) hechos.push(`Arriba del ranking: ${r.arriba.slice(0, 4).map(x => `${x.tk} (${Math.round(x.puesto) + 1}°)`).join(", ")}.`);
      if (r?.abajo.length) hechos.push(`Abajo del ranking: ${r.abajo.slice(0, 4).map(x => `${x.tk} (${Math.round(x.puesto) + 1}°)`).join(", ")}.`);
      if (h) hechos.push(`Hoy suben más: ${h.mejores.map(x => `${x.tk} ${pct(x.cambio)}`).join(", ")}; bajan más: ${h.peores.map(x => `${x.tk} ${pct(x.cambio)}`).join(", ")}.`);
      suficiente = !!(r || h);
      break;
    }
    case "patron":
      datos.patrones = patrones(P, hoy, rank);
      hechos = _hechoMercado(P, hoy);
      suficiente = !!hoy;
      break;
    case "resumen": case "regimen":
      datos.patrones = patrones(P, hoy, rank);
      datos.regimen = regimen(P, hoy);
      hechos = _hechoMercado(P, hoy);
      if (rank?.arriba.length) hechos.push(`Ranking: arriba ${rank.arriba.slice(0, 3).map(x => x.tk).join(", ")}; abajo ${rank.abajo.slice(0, 3).map(x => x.tk).join(", ")}.`);
      suficiente = !!(hoy || P.riesgo != null);
      break;
    case "acierto":
      suficiente = !!P.metricas;
      if (P.metricas) hechos.push(`Acierto ${num(P.metricas.acc)}% contra ${P.metricas.baseTipo === "azar" ? "un azar de" : "base"} ${num(P.metricas.base)}%; ventaja ${num(P.metricas.edge)} puntos, margen ±${num(P.metricas.mde)}.`);
      break;
    case "mercado_abierto":
      hechos = _hechoMercado(P, null).slice(0, 1);
      break;
    case "activo_externo":
      datos.activo = intento?.activo || null;
      hechos = _hechoMercado(P, hoy).slice(1, 3);
      break;
    case "fuera_universo":
      datos.fuera = intento?.fuera || [];
      datos.proxies = datos.fuera.flatMap(f => f.proxy || []).map(t => vistaTicker(t, P, hoy)).filter(v => v.tieneDatos);
      break;
    case "concepto": {
      const tkR = Object.keys(P.riesgoActivo)[0];
      if (tkR) datos.ejemploRiesgo = vistaTicker(tkR, P, hoy);
      hechos = _hechoMercado(P, hoy).slice(1, 2);
      break;
    }
    case "crisis":
      datos.crisis = P.crisis || [];
      hechos = _hechoMercado(P, hoy).slice(1, 2);
      break;
    case "libre": default: {
      hechos = _hechoMercado(P, hoy);
      if (intento?.tema?.tickers?.length) {
        datos.tema = { nombre: intento.tema.nombre, vistas: intento.tema.tickers.map(t => vistaTicker(t, P, hoy)).filter(v => v.hoy) };
        if (datos.tema.vistas.length) hechos.push(`Lo más sensible a ${intento.tema.nombre}: ${datos.tema.vistas.map(v => `${v.tk} ${pct(v.hoy.cambio)}`).join(", ")}.`);
      }
      datos.patrones = patrones(P, hoy, rank);
      suficiente = hechos.length > 0;
      break;
    }
  }
  // Tope: el prompt local se paga a ~25 ms por token.
  hechos = hechos.slice(0, 8);
  return { intencion: it, hechos, datos, suficiente };
}

// ── Validación de lo que redacta el motor de lenguaje ─────────────────────
const PROHIBIDO = /\b(gemini|google|openai|chat ?gpt|gpt-?\d|llama|gemma|ollama|anthropic|claude|mistral|deepmind|class ?\d{1,2}[ab]?)\b/i;
const PROHIBIDO_INTERNO = /\b(gemma|ollama|llama ?\d|class ?\d{1,2}[ab]?)\b/i;
const AUTORIA_AJENA = /(soy|fui (cread|entrenad|desarrollad|hech)[oa]|me (cre[oó]|entren[oó]|desarroll[oó]|hizo|hicieron|crearon|entrenaron)|mi (creador|desarrollador|modelo|motor) es)[^.!?]{0,50}\b(google|openai|chat ?gpt|gemini|meta|microsoft|anthropic|claude|mistral|deepmind)\b/i;
// En la charla libre (op.abierta) MIIA SÍ puede decir que es una IA: lo que se
// sigue rechazando es escaparse con «no tengo acceso a datos en tiempo real».
const EVASIVO_ABIERTA = /(no tengo acceso a (datos|informaci[oó]n|internet)|soy (solo |s[oó]lo )?un modelo de lenguaje|no puedo (acceder|ver|consultar) (datos|el mercado|informaci)|mi (conocimiento|entrenamiento) (llega|termina|es hasta)|fecha de corte|no tengo (datos|informaci[oó]n) en tiempo real)/i;
const EVASIVO = /(no tengo acceso a (datos|informaci[oó]n|internet)|como (modelo|ia|inteligencia artificial) de lenguaje|soy (solo |s[oó]lo )?un modelo de lenguaje|no puedo (acceder|ver|consultar) (datos|el mercado|informaci)|mi (conocimiento|entrenamiento) (llega|termina|es hasta)|fecha de corte|no tengo (datos|informaci[oó]n) en tiempo real)/i;
const CONSEJO = /(te (recomiendo|aconsejo|sugiero) (comprar|vender|invertir|entrar|salir)|deber[ií]as (comprar|vender|invertir)|compr[aá]( lo| la)? (ya|ahora)|vend[eé]( lo| la)? (ya|ahora)|es (una )?(buena|excelente) (compra|inversi[oó]n|oportunidad)|garantiz|seguro que (sube|baja))/i;

// Elogios al creador (16-nov-2026, pedido de Martín): «que no diga que Martín
// es tan bueno ni que es un genio». El motor de lenguaje tiende a adornar al
// creador; la oración que lo elogia se saca y el resto de la respuesta queda.
const ELOGIO = /\b(genio|genial|geni[ao]s|brillante|brillantez|crack|capo|groso|visionari[oa]|talentos[oa]|talento|incre[ií]ble|excepcional|extraordinari[oa]|admir\w*|orgull\w*|maestr[oa]|el mejor|la mejor|un grande|gran (creador|persona|trabajo|mente|programador|desarrollador)|buen[oa] (trabajo|creador)|lo m[aá]ximo|cari[nñ]o)\b/i;
export function sinElogioCreador(texto) {
  const partes = String(texto || "").split(/(?<=[.!?])\s+/);
  const quedan = partes.filter(o => !(/(mart[ií]n|mi creador|me cre[oó]|quien me (hizo|cre[oó]))/i.test(o) && ELOGIO.test(o)));
  return { texto: quedan.join(" ").trim(), quitadas: partes.length - quedan.length };
}

function _numerosDe(texto) {
  return (String(texto).match(/[-+]?\d+(?:[.,]\d+)?/g) || []).map(x => Number(x.replace(",", ".")));
}

/**
 * ¿La respuesta del motor se puede publicar?
 * @returns {{ok: boolean, motivo: string|null, texto: string}}  texto ya limpio
 */
export function validarRespuesta(texto, ev, op = {}) {
  let s = String(texto || "").replace(/[*#_`]+/g, "").replace(/\s+/g, " ").trim();
  // Cortada a mitad de oración (tope de tokens): se recorta a la última completa.
  if (s && !/[.!?…)»]$/.test(s)) {
    const i = Math.max(s.lastIndexOf(". "), s.lastIndexOf("! "), s.lastIndexOf("? "));
    if (i > 20) s = s.slice(0, i + 1);
    else if (op.abierta) {
      // Charla libre (5-nov-2026): con el tope de 56 tokens del 2B, una opinión
      // de UNA oración larga se cortaba antes del primer punto y se descartaba
      // entera —y el usuario recibía el respaldo—. Se rescata hasta la última
      // pausa natural (coma, punto y coma, «pero», «y») si queda algo con cuerpo.
      const cortes = [", ", "; ", " pero ", " y ", " aunque ", " porque "].map(c => s.lastIndexOf(c));
      const j = Math.max(...cortes);
      if (j < 40) return { ok: false, motivo: "cortada a mitad de oración", texto: s };
      s = s.slice(0, j).replace(/[\s,;:—-]+$/, "") + ".";
    } else return { ok: false, motivo: "cortada a mitad de oración", texto: s };
  }
  s = sinElogioCreador(s).texto;
  if (s.length < 20) return { ok: false, motivo: "vacía o demasiado corta", texto: s };
  // En la charla libre se puede opinar de Google o de ChatGPT como de cualquier
  // empresa; lo que no puede es decir que la hicieron ellos, ni nombrar el motor
  // interno (gemma/ollama) o un módulo.
  if (op.abierta ? (PROHIBIDO_INTERNO.test(s) || AUTORIA_AJENA.test(s)) : PROHIBIDO.test(s)) {
    return { ok: false, motivo: "nombra un proveedor o un módulo interno", texto: s };
  }
  if ((op.abierta ? EVASIVO_ABIERTA : EVASIVO).test(s)) return { ok: false, motivo: "se escapa de la pregunta", texto: s };
  if (CONSEJO.test(s) && !/\bno (te )?(recomiendo|aconsejo)/i.test(s)) return { ok: false, motivo: "da un consejo de compra/venta", texto: s };

  // Números: todo número con decimales o con % tiene que estar en los hechos.
  const permitidos = new Set();
  for (const h of (ev?.hechos || [])) for (const n of _numerosDe(h)) { permitidos.add(n); permitidos.add(Math.abs(n)); permitidos.add(Math.round(Math.abs(n))); }
  for (const n of [24, 48, 50, 100, 2026, 2027, 9, 16, 30]) permitidos.add(n);
  const cerca = n => [...permitidos].some(p => Math.abs(p - n) <= Math.max(0.15, Math.abs(p) * 0.03));
  // En la charla libre se puede hablar de cualquier cosa con números (un año,
  // un resultado, una edad): sólo se controlan los PORCENTAJES, que es la forma
  // en que el 2B inventa cifras de mercado («subió 4,5%»).
  const conNumero = (op.abierta
    ? s.match(/[-+]?\d+(?:[.,]\d+)?\s?%/g)
    : s.match(/[-+]?\d+(?:[.,]\d+)?\s?%|[-+]?\d+[.,]\d+|\b\d{2,}\b/g)) || [];
  for (const raw of conNumero) {
    const n = Math.abs(Number(raw.replace(/[%\s+]/g, "").replace(",", ".")));
    if (n >= 1900 && n <= 2100) continue;          // años
    if (!cerca(n)) return { ok: false, motivo: `cita un número que no está en los datos (${raw.trim()})`, texto: s };
  }
  // Instrumentos: sólo los que aparecen en los hechos.
  const conocidos = new Set((op.tickers || []).map(t => String(t).toUpperCase()));
  const enHechos = new Set(((ev?.hechos || []).join(" ").match(/\b[A-Z]{2,5}\b/g) || []));
  // En la charla libre (13-nov-2026) nombrar un ETF como EJEMPLO es lo normal:
  // «un ETF es un fondo que cotiza en bolsa, como SPY, que replica el S&P 500».
  // Antes eso descartaba la respuesta entera («nombra SPY sin datos») y el
  // usuario recibía «no me salió una respuesta». Lo que se sigue rechazando es
  // atribuirle algo que sería un dato: un número o una dirección en esa oración.
  const oraciones = s.split(/(?<=[.!?])\s+/);
  // (Un entero suelto no es un dato: «el S&P 500», «el Russell 2000» son nombres.)
  const DATO_ATRIBUIDO = /\d+(?:[.,]\d+)?\s?%|\d+[.,]\d+|\$\s?\d|\d+\s?(d[oó]lares|usd|u\$s|puntos)\b|\b(sub\w*|baj\w*|ca[eé]\w*|cay\w*|gan\w*|pierd\w*|perd\w*|compr\w*|vend\w*|alcist\w*|bajist\w*|buy|sell|hold|ranking|puesto|se[nñ]al\w*)\b/i;
  for (const tk of (s.match(/\b[A-Z]{2,5}\b/g) || [])) {
    if (!conocidos.has(tk) || enHechos.has(tk)) continue;
    if (op.abierta && !oraciones.some(o => new RegExp(`\\b${tk}\\b`).test(o) && DATO_ATRIBUIDO.test(o))) continue;
    return { ok: false, motivo: `nombra ${tk} sin datos`, texto: s };
  }
  // Dirección: no puede contradecir la señal del instrumento en foco.
  for (const v of (ev?.datos?.vistas || [])) {
    if (!v.rank) continue;
    const frases = s.split(/(?<=[.!?])\s+/).filter(f => f.includes(v.tk));
    const opuesto = v.rank.senal === "BUY" ? /\b(SELL|vender|venta|bajista|d[eé]bil)\b/i
                  : v.rank.senal === "SELL" ? /\b(BUY|comprar|compra|alcista|fuerte)\b/i : null;
    if (opuesto && frases.some(f => opuesto.test(f) && !/\bno\b/i.test(f))) {
      return { ok: false, motivo: `contradice la señal ${v.rank.senal} de ${v.tk}`, texto: s };
    }
  }
  return { ok: true, motivo: null, texto: s };
}

// Expuesto para las pruebas (sim35 compara el respaldo sin Intl contra Intl).
export const _test = { _partesNYIntl, _partesNYSinIntl };
