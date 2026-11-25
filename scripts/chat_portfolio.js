/**
 * chat_portfolio.js — «¿el portafolio que me armaste sirve para este mercado?»
 *
 * Vive aparte de class25B por el mismo motivo que chat_router / chat_evidencia /
 * chat_redactor: es lógica pura y se prueba sin levantar nada (sim36).
 *
 * POR QUÉ EXISTE (4-nov-2026)
 * ---------------------------
 * Martín preguntó en el chat «El portafolio que me armaste sirve para este
 * régimen de mercado?» y MIIA le contestó con la plantilla «necesito saber tu
 * tolerancia al riesgo: 1 conservador, 2 moderado, 3 agresivo». Dos causas:
 *
 *   1. El router mandaba TODA mención de «portafolio» a la intención de ARMAR
 *      uno. No había forma de preguntar por el que ya tenía.
 *   2. El perfil vivía sólo en la sesión de class25B: 30 min de TTL y una
 *      sesión nueva por cada recarga de la página. Para el chat, el portafolio
 *      que acababa de armar no existía.
 *
 * Ahora la web guarda el portafolio por usuario (localStorage) y lo manda con
 * cada pregunta; class25B también lo recuerda por user_id. Este módulo lo
 * compara contra el mercado con los MISMOS datos que usa el resto del chat
 * (cotizaciones, ranking transversal, riesgo por activo, régimen del día).
 *
 * LO QUE NO HACE, a propósito: no dice «cambiá X por Y». Dice qué parte del
 * portafolio acompaña la lectura de hoy y cuál va en contra, con números, y que
 * una rueda sola no alcanza para decidir. Es análisis, no asesoramiento.
 */
import { num, pct, sectorES, vistaTicker, agregadoHoy, regimen, nivelRiesgo,
         DEFENSIVOS, CICLICOS } from "./chat_evidencia.js";
import { _test as _red } from "./chat_redactor.js";

const PERFILES = new Set(["conservador", "moderado", "agresivo"]);
const MAX_ACTIVOS = 12;

function _n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function lista(arr) {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} y ${a[a.length - 1]}`;
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/**
 * Valida y recorta lo que llega del navegador (localStorage, o sea: lo que el
 * usuario quiera poner). Nunca confía en el texto: sólo símbolos, pesos y fecha.
 * @returns {{perfil, monto, ts, activos:[{symbol, peso_pct, sector}]} | null}
 */
export function normalizarPortfolio(raw) {
  if (!raw || typeof raw !== "object") return null;
  const vistos = new Set();
  const activos = [];
  for (const a of (Array.isArray(raw.activos) ? raw.activos : []).slice(0, MAX_ACTIVOS)) {
    if (!a || typeof a !== "object") continue;
    const symbol = String(a.symbol ?? a.ticker ?? "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
    const peso = _n(a.peso_pct ?? a.peso);
    if (!symbol || vistos.has(symbol) || peso == null || peso <= 0 || peso > 100) continue;
    vistos.add(symbol);
    activos.push({ symbol, peso_pct: peso,
                   sector: typeof a.sector === "string" ? a.sector.slice(0, 40) : null });
  }
  if (!activos.length) return null;
  const perfil = PERFILES.has(String(raw.perfil || "").toLowerCase()) ? String(raw.perfil).toLowerCase() : null;
  const monto = (typeof raw.monto === "string" || typeof raw.monto === "number")
    && String(raw.monto).trim() && String(raw.monto) !== "no especificado"
    ? String(raw.monto).replace(/[<>]/g, "").slice(0, 40) : null;
  const t = Date.parse(raw.ts);
  return { perfil, monto, ts: Number.isFinite(t) ? t : null, activos };
}

/**
 * Compara el portafolio contra el panel del mercado (chat_evidencia.armarPanel).
 */
export function evaluarPortfolio(port, P) {
  const hoy = agregadoHoy(P);
  const reg = regimen(P, hoy);
  const total = port.activos.reduce((s, a) => s + a.peso_pct, 0) || 1;
  const filas = port.activos.map(a => ({ ...a, w: a.peso_pct / total, v: vistaTicker(a.symbol, P, hoy) }));
  const fuera = filas.filter(f => !f.v.enUniverso);
  const conHoy = filas.filter(f => f.v.hoy);
  const wHoy = conHoy.reduce((s, f) => s + f.w, 0);
  const cambio = wHoy > 0 ? conHoy.reduce((s, f) => s + f.w * f.v.hoy.cambio, 0) / wHoy : null;
  const relativo = cambio != null && hoy ? cambio - hoy.media : null;

  const aFavor  = filas.filter(f => f.v.rank?.zona === "arriba");
  const enContra = filas.filter(f => f.v.rank?.zona === "abajo");
  const wFavor  = aFavor.reduce((s, f) => s + f.w, 0);
  const wContra = enContra.reduce((s, f) => s + f.w, 0);
  const conRank = filas.filter(f => f.v.rank).length;

  const wDef = filas.filter(f => DEFENSIVOS.includes(f.symbol)).reduce((s, f) => s + f.w, 0);
  const wCic = filas.filter(f => CICLICOS.includes(f.symbol)).reduce((s, f) => s + f.w, 0);

  const conVol = filas.filter(f => f.v.riesgo?.vol != null);
  const wVol = conVol.reduce((s, f) => s + f.w, 0);
  const vol = wVol > 0 ? conVol.reduce((s, f) => s + f.w * f.v.riesgo.vol, 0) / wVol : null;

  const ordHoy = [...conHoy].sort((a, b) => b.v.hoy.cambio - a.v.hoy.cambio);

  // Encaje: una cuenta simple y escrita, no una caja negra. Cada término es
  // un número que el texto después muestra.
  let puntos = 0;
  if (relativo != null) puntos += relativo > 0.25 ? 1 : relativo < -0.25 ? -1 : 0;
  if (conRank) puntos += wFavor - wContra >= 0.25 ? 1 : wContra - wFavor >= 0.25 ? -1 : 0;
  if (reg && (reg.etiqueta === "bajista" || reg.etiqueta === "de crisis")) {
    puntos += wDef >= 0.3 ? 1 : wCic >= 0.5 ? -1 : 0;
  } else if (reg?.etiqueta === "alcista") {
    puntos += wCic >= 0.4 ? 0.5 : wDef >= 0.5 ? -0.5 : 0;
  }
  const hayDatos = conHoy.length > 0 || conRank > 0;
  const encaje = !hayDatos ? null : puntos >= 1.5 ? "alineado" : puntos <= -1.5 ? "desalineado" : "mixto";

  return { hoy, reg, filas, fuera, cambio, relativo, aFavor, enContra, wFavor, wContra, conRank,
           wDef, wCic, vol, mejor: ordHoy[0] || null, peor: ordHoy[ordHoy.length - 1] || null,
           cobertura: conHoy.length, encaje, puntos, riesgo: P.riesgo ?? null, hayDatos,
           enRueda: !!P.mercado?.abierto };
}

function _cuando(ts, ahora) {
  if (!ts) return "";
  const d = Math.floor((ahora - ts) / 86_400_000);
  if (d <= 0) return "hoy";
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${d} días`;
  const f = new Date(ts);
  return `el ${f.getDate()}/${f.getMonth() + 1}`;
}

const w100 = x => `${Math.round(x * 100)}%`;

/**
 * Texto de la respuesta.
 * @param {object} port  normalizarPortfolio(...)
 * @param {object} e     evaluarPortfolio(...)
 * @param {object} op    { semilla, ahora, subtipo: "ajustar"|null, detalle }
 */
export function redactarMiPortfolio(port, e, op = {}) {
  const R = _red.azar(op.semilla || "mi_portfolio");
  const ahora = op.ahora || Date.now();
  const comp = lista(port.activos.slice(0, 6).map(a => `${a.symbol} ${num(a.peso_pct, 0)}%`));
  const cuando = _cuando(port.ts, ahora);
  const p = [];

  p.push(R.pick([
    `Tu portafolio${port.perfil ? ` (perfil ${port.perfil}` + (port.monto ? `, ${port.monto})` : ")") : ""}${cuando ? `, armado ${cuando},` : ""} es ${comp}.`,
    `Tomo el portafolio que te armé${cuando ? ` ${cuando}` : ""}${port.perfil ? `, perfil ${port.perfil}` : ""}: ${comp}.`,
  ]));

  if (!e.hayDatos) {
    p.push("Ahora no tengo cotizaciones ni ranking frescos para compararlo; probá de nuevo en unos minutos.");
    return p.join(" ");
  }

  const cuandoMerc = e.enRueda ? "hoy" : "en la última rueda";
  if (e.reg) {
    p.push(`El mercado ${cuandoMerc} se lee ${e.reg.etiqueta}: suben ${e.reg.positivos} de ${e.reg.n}, promedio ${pct(e.reg.media)}`
      + `${e.riesgo != null ? `, riesgo global ${Math.round(e.riesgo * 100)}% (${nivelRiesgo(e.riesgo)})` : ""}.`);
  }
  if (e.cambio != null) {
    const rel = e.relativo;
    p.push(`Ponderado por los pesos, tu portafolio va ${pct(e.cambio)}`
      + (rel != null ? `, ${Math.abs(rel) < 0.1 ? "prácticamente igual que el promedio" : `${num(Math.abs(rel), 1)} puntos ${rel > 0 ? "por encima" : "por debajo"} del promedio`}` : "")
      + (e.mejor && e.peor && e.mejor.v.hoy.cambio - e.peor.v.hoy.cambio >= 0.1
        ? `; lo mejor es ${e.mejor.symbol} (${pct(e.mejor.v.hoy.cambio)}) y lo más flojo ${e.peor.symbol} (${pct(e.peor.v.hoy.cambio)})` : "")
      + ".");
  }
  if (e.conRank) {
    const fav = e.aFavor.map(f => f.symbol), con = e.enContra.map(f => f.symbol);
    if (fav.length || con.length) {
      p.push([
        fav.length ? `En el ranking del sistema, ${lista(fav)} (${w100(e.wFavor)} del portafolio) ${fav.length > 1 ? "están" : "está"} en la zona de compra` : "",
        con.length ? `${fav.length ? "y " : "En el ranking del sistema, "}${lista(con)} (${w100(e.wContra)}) ${con.length > 1 ? "están" : "está"} en la zona de venta` : "",
      ].filter(Boolean).join(" ") + ".");
    } else {
      p.push("En el ranking del sistema ninguno de tus activos está en los extremos: todos en la zona media.");
    }
  }
  if (e.reg && (e.reg.etiqueta === "bajista" || e.reg.etiqueta === "de crisis")) {
    p.push(e.wDef >= 0.3
      ? `Tenés ${w100(e.wDef)} en sectores defensivos, que en días así suelen aguantar mejor.`
      : `Casi no tenés defensivos (${w100(e.wDef)}) y ${w100(e.wCic)} es cíclico, que es lo que más suele sufrir en días así.`);
  } else if (e.reg?.etiqueta === "alcista" && e.wCic >= 0.4) {
    p.push(`${w100(e.wCic)} está en sectores cíclicos, que son los que suelen acompañar los días de suba.`);
  }
  if (e.vol != null) {
    const alta = e.vol > 25, perf = port.perfil;
    p.push(`La volatilidad ponderada es de ${num(e.vol, 0)}% anual`
      + (perf === "conservador" && alta ? ", alta para un perfil conservador"
        : perf === "agresivo" && e.riesgo != null && e.riesgo > 0.7 ? "; con el riesgo global alto, un perfil agresivo queda más expuesto a una baja"
        : "") + ".");
  }
  if (e.fuera.length) p.push(`${lista(e.fuera.map(f => f.symbol))} no ${e.fuera.length > 1 ? "los mido" : "lo mido"}, así que quedan fuera de la cuenta.`);

  const veredicto = {
    alineado: "Con esa foto, tu portafolio está alineado con lo que muestra el mercado.",
    desalineado: "Con esa foto, tu portafolio va en contra de lo que muestra el mercado.",
    mixto: "Con esa foto, el encaje con el mercado es mixto: hay partes a favor y partes en contra.",
  }[e.encaje];
  if (veredicto) p.push(veredicto);

  // «¿Lo cambio?»: el veredicto del sistema va PRIMERO (13-nov-2026).
  if (op.subtipo === "ajustar" && op.veredicto) {
    return [textoVeredicto(op.veredicto), ...p.slice(1, 3)].join(" ").replace(/\s+/g, " ").trim();
  }
  if (op.subtipo === "ajustar" || (op.detalle || 1) >= 2) {
    if (e.enContra.length) {
      const peor = [...e.enContra].sort((a, b) => b.w - a.w)[0];
      p.push(`Si pensás revisarlo, lo que más va contra la lectura actual es ${peor.symbol} (${w100(peor.w)} del portafolio`
        + `${peor.v.hoy ? `, ${pct(peor.v.hoy.cambio)} hoy` : ""}).`);
    } else if (e.peor) {
      p.push(`No hay nada en zona de venta; lo más flojo ${cuandoMerc} es ${e.peor.symbol}.`);
    }
    p.push("Igual, cambiar la cartera por una o dos ruedas suele ser seguir el ruido.");
  }
  p.push(R.pick([
    "Es una lectura de la rueda, no del ciclo largo, y no es asesoramiento: la decisión es tuya.",
    "Ojo: es la foto de una rueda, no una tendencia, y no es una recomendación de compra o venta.",
  ]));
  if (op.subtipo !== "ajustar") p.push(R.pick([
    "Si querés, preguntame por alguno de tus activos o pedime que te arme uno nuevo con los datos de hoy.",
    "¿Querés que mire alguno de tus activos en detalle?",
  ]));
  return p.join(" ").replace(/\s+/g, " ").trim();
}

// ── «¿Lo cambio?»: el veredicto del sistema (13-nov-2026) ─────────────────
// Pedido de Martín: que MIIA diga SÍ, NO o ESPERÁ, basado en los datos. Es una
// regla escrita, con umbrales fijos, para que el motor de lenguaje sólo la
// REDACTE y no la decida (el motor es un 2B: no puede elegir esto él).
//
//   ESPERAR  sin datos frescos (cobertura < mitad del portafolio)
//   CAMBIAR  el perfil no encaja con el riesgo (conservador con vol > 25 %)
//   CAMBIAR  ≥ 40 % del peso en la zona de venta del ranking Y encaje desalineado
//   ESPERAR  ≥ 20 % en zona de venta (señales encontradas: una rueda es ruido)
//   MANTENER el resto
// El ranking mide 24-48 h: «cambiar» se lee como «lo que el sistema ve hoy va
// en contra», nunca como certeza. La decisión final es del usuario.
export const UMBRAL = { contraCambiar: 0.40, contraEsperar: 0.20, volConservador: 25 };

export function veredictoPortfolio(port, e, P, umbrales = null) {
  // Los umbrales los puede fijar el usuario al armarlo (plazo o su propio %,
  // chat_armado.js, 13-nov-2026); si no, los de siempre.
  const U = { ...UMBRAL, ...(umbrales || {}) };
  const motivos = [];
  const sale = [...(e.enContra || [])].sort((a, b) => b.w - a.w).map(f => f.symbol);
  const enPort = new Set(port.activos.map(a => a.symbol));
  const conservador = port.perfil === "conservador";
  // Reemplazos: lo de arriba del ranking que no tiene, y si es conservador, sólo
  // los de volatilidad medida ≤ 25 %.
  const hoy = agregadoHoy(P);
  const candidatos = Object.keys(P?.rk || {})
    .filter(tk => !enPort.has(tk))
    .map(tk => vistaTicker(tk, P, hoy))
    .filter(v => v.rank?.zona === "arriba" && (!conservador || (v.riesgo?.vol != null && v.riesgo.vol <= U.volConservador)))
    .sort((a, b) => a.rank.puesto - b.rank.puesto).slice(0, 2).map(v => v.tk);

  if (!e.hayDatos || e.cobertura < Math.ceil(port.activos.length / 2)) {
    return { decision: "esperar", motivos: ["no tengo cotizaciones o ranking frescos para la mayoría de tus activos"], sale: [], candidatos: [] };
  }
  if (conservador && e.vol != null && e.vol > U.volConservador) {
    motivos.push(`la volatilidad ponderada es ${num(e.vol, 0)}% anual, alta para un perfil conservador`);
    return { decision: "cambiar", motivos, sale, candidatos, umbrales: U };
  }
  if (e.wContra >= U.contraCambiar && e.encaje === "desalineado") {
    motivos.push(`${w100(e.wContra)} del portafolio (${lista(sale)}) está en la zona de venta del ranking`);
    if (e.relativo != null && Math.abs(e.relativo) >= 0.1) motivos.push(`va ${num(Math.abs(e.relativo), 1)} puntos ${e.relativo >= 0 ? "por encima" : "por debajo"} del promedio`);
    return { decision: "cambiar", motivos, sale, candidatos, umbrales: U };
  }
  if (e.wContra >= U.contraEsperar) {
    motivos.push(`${w100(e.wContra)} (${lista(sale)}) está en la zona de venta, pero el resto no acompaña esa lectura`);
    return { decision: "esperar", motivos, sale, candidatos: [], umbrales: U };
  }
  motivos.push(e.wFavor > 0 ? `${w100(e.wFavor)} está en la zona de compra y nada pesa en la de venta` : "ninguno de tus activos está en la zona de venta del ranking");
  return { decision: "mantener", motivos, sale: [], candidatos: [], umbrales: U };
}

/** El veredicto en texto (respaldo y referencia para el motor). */
export function textoVeredicto(v) {
  const que = { cambiar: "Mi lectura con los datos de hoy: sí, conviene revisarlo.",
                mantener: "Mi lectura con los datos de hoy: no hace falta cambiarlo, mantenelo.",
                esperar: "Mi lectura con los datos de hoy: esperá antes de tocarlo." }[v.decision];
  const p = [que, `Motivo: ${v.motivos.join("; ")}.`];
  if (v.decision === "cambiar" && v.sale.length) p.push(`Lo primero a revisar es ${lista(v.sale.slice(0, 2))}.`);
  if (v.decision === "cambiar" && v.candidatos.length) p.push(`Arriba del ranking están ${lista(v.candidatos)}.`);
  if (v.decision === "esperar" && v.sale.length) p.push(`Si en las próximas ruedas ${lista(v.sale.slice(0, 2))} sigue abajo, ahí sí conviene revisarlo.`);
  if (v.umbrales?.plazo) p.push(`Lo mido con tu plazo ${v.umbrales.plazo}: aviso de cambio desde ${Math.round(v.umbrales.contraCambiar * 100)}% en zona de venta.`);
  p.push("Es la lectura del sistema a 24-48 horas, no una certeza: la decisión es tuya.");
  return p.join(" ");
}

/** Respuesta cuando el usuario pregunta por «su» portafolio y no hay ninguno guardado. */
export function sinPortfolio(perfil) {
  return perfil
    ? `No tengo guardado un portafolio tuyo para comparar. Si querés, te armo uno para perfil ${perfil} con los datos de hoy: decime «armame un portfolio».`
    : "No tengo guardado un portafolio tuyo para comparar. Si querés te armo uno con los datos de hoy: ¿cuál es tu perfil? 1 conservador, 2 moderado o 3 agresivo.";
}

export const _test = { _cuando };
