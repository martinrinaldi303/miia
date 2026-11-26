// chat_portafolios.js — hasta 3 portafolios por usuario (26-nov-2026).
//
// Pedido de Martín: «que cada usuario pueda tener hasta 3 portafolios». Se
// guardan en la CUENTA (class25B, state/class25b_portfolios_usuario.json), no en
// el navegador, así se ven igual en el celular y en la PC. Uno está ACTIVO: es el
// que el chat usa cuando le preguntan «¿mi portafolio sirve?».
//
// Puro: sin Redis, sin disco, sin class25B. class25B guarda y publica; acá vive
// la lógica (qué slot, qué comando, qué etiqueta) para poder probarla.

export const MAX_PORTAFOLIOS = 3;

const NUM = { "1": 1, "2": 2, "3": 3, uno: 1, una: 1, dos: 2, tres: 3,
  primer: 1, primero: 1, primera: 1, segundo: 2, segunda: 2, tercer: 3, tercero: 3, tercera: 3 };
const NUM_RE = "(1|2|3|uno|una|dos|tres|primer[oa]?|segund[oa]|tercer[oa]?)";
const CARTERA = "(?:portafolios?|portfolios?|porfolios?|portafolio|carteras?)";

function plegar(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}
function numDe(s) { return NUM[String(s || "").trim()] || null; }

/**
 * Lo que ve la web: la cartera completa (pesos, montos, riesgo, cambio del día),
 * saneada. `port` (normalizado) es lo que usa el análisis; esto es sólo para mostrar.
 */
export function sanearVista(rec) {
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.activos)) return null;
  const num = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const activos = rec.activos.slice(0, 12).map(a => ({
    symbol: String(a?.symbol || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10),
    sector: typeof a?.sector === "string" ? a.sector.slice(0, 40) : null,
    peso_pct: num(a?.peso_pct) || 0,
    riesgo_pct: num(a?.riesgo_pct),
    cambio_pct: num(a?.cambio_pct),
    monto: num(a?.monto) > 0 ? num(a.monto) : null,
  })).filter(a => a.symbol && a.peso_pct > 0 && a.peso_pct <= 100);
  if (!activos.length) return null;
  return {
    perfil: ["conservador", "moderado", "agresivo"].includes(rec.perfil) ? rec.perfil : null,
    monto: (typeof rec.monto === "string" || typeof rec.monto === "number") ? String(rec.monto).slice(0, 40) : null,
    riesgo_pct: num(rec.riesgo_pct),
    modo: rec.modo === "manual" ? "manual" : null,
    ts: typeof rec.ts === "string" ? rec.ts.slice(0, 40) : (Number.isFinite(rec.ts) ? new Date(rec.ts).toISOString() : null),
    activos,
  };
}

/** Un slot: {port (normalizado, para analizar), vista (para mostrar), guardado}. */
export function slot(rec, normalizarPortfolio, ahora = Date.now()) {
  const port = normalizarPortfolio(rec);
  if (!port) return null;
  return { port, vista: sanearVista(rec), guardado: ahora };
}

/** Entrada vacía o migrada del formato viejo ({port, guardado}). */
export function normalizarEntrada(raw, normalizarPortfolio, ahora = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  let ports = [];
  if (Array.isArray(raw.ports)) {
    for (const s of raw.ports.slice(0, MAX_PORTAFOLIOS)) {
      const p = normalizarPortfolio(s?.port);
      if (p) ports.push({ port: p, vista: sanearVista(s?.vista), guardado: Number.isFinite(s?.guardado) ? s.guardado : ahora });
    }
  } else if (raw.port) {                              // formato v1: un solo portafolio
    const p = normalizarPortfolio(raw.port);
    if (p) ports.push({ port: p, vista: sanearVista(raw.port), guardado: Number.isFinite(raw.guardado) ? raw.guardado : ahora });
  }
  let activo = Number.isInteger(raw.activo) ? raw.activo : 0;
  if (activo < 0 || activo >= ports.length) activo = ports.length ? ports.length - 1 : 0;
  return { ports, activo, config: raw.config || null,
           guardado: Number.isFinite(raw.guardado) ? raw.guardado : ahora };
}

export function activoDe(e) { return e?.ports?.[e.activo]?.port || null; }
export function lleno(e) { return (e?.ports?.length || 0) >= MAX_PORTAFOLIOS; }

/** Agrega uno nuevo y lo deja activo. Si ya hay 3, no toca nada y avisa. */
export function agregar(e, sl, ahora = Date.now()) {
  const ent = e || { ports: [], activo: 0, config: null, guardado: ahora };
  if (!sl || lleno(ent)) return { entrada: ent, guardado: false };
  ent.ports.push(sl);
  ent.activo = ent.ports.length - 1;
  ent.guardado = ahora;
  return { entrada: ent, guardado: true };
}

/** Pisa el slot n (1-3) y lo deja activo. */
export function reemplazar(e, n, sl, ahora = Date.now()) {
  const i = n - 1;
  if (!e || !sl || i < 0 || i >= e.ports.length) return false;
  e.ports[i] = sl;
  e.activo = i;
  e.guardado = ahora;
  return true;
}

/** Actualiza el activo (o lo crea si no hay ninguno): la copia que manda la web. */
export function actualizarActivo(e, sl, ahora = Date.now()) {
  const ent = e || { ports: [], activo: 0, config: null, guardado: ahora };
  if (!sl) return ent;
  if (!ent.ports.length) return agregar(ent, sl, ahora).entrada;
  ent.ports[ent.activo] = sl;
  ent.guardado = ahora;
  return ent;
}

export function activar(e, n) {
  const i = n - 1;
  if (!e || i < 0 || i >= e.ports.length) return false;
  e.activo = i;
  return true;
}

export function borrar(e, n) {
  const i = n - 1;
  if (!e || i < 0 || i >= e.ports.length) return false;
  e.ports.splice(i, 1);
  if (!e.ports.length) e.activo = 0;
  else if (e.activo > i) e.activo -= 1;
  else if (e.activo >= e.ports.length) e.activo = e.ports.length - 1;
  return true;
}

const PERFIL_LBL = { conservador: "Conservador", moderado: "Moderado", agresivo: "Agresivo" };
function fechaCorta(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(d)) return "";
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d.getDate()}-${meses[d.getMonth()]}`;
}

/** «Agresivo · 10000 · 26-nov» o «Manual · SPY, QQQ… · 26-nov». */
export function etiqueta(port) {
  if (!port) return "";
  const partes = [];
  if (port.modo === "manual") {
    partes.push("Armado por vos");
    const s = (port.activos || []).slice(0, 3).map(a => a.symbol).join(", ");
    if (s) partes.push(s + ((port.activos || []).length > 3 ? "…" : ""));
  } else {
    partes.push(PERFIL_LBL[port.perfil] || "Portafolio");
    if (port.monto && port.monto !== "no especificado") partes.push(String(port.monto));
  }
  const f = fechaCorta(port.ts);
  if (f) partes.push(f);
  return partes.join(" · ");
}

/** Lo que viaja a la web: el activo y la lista (número 1-3, etiqueta y cartera). */
export function resumen(e) {
  if (!e || !e.ports?.length) return { activo: null, lista: [], max: MAX_PORTAFOLIOS };
  return {
    activo: e.activo + 1,
    max: MAX_PORTAFOLIOS,
    lista: e.ports.map((s, i) => ({ n: i + 1, etiqueta: etiqueta(s.vista || s.port), port: s.vista || s.port })),
  };
}

/**
 * ¿El mensaje es un comando sobre los portafolios?
 *   «mis portafolios» / «cuántos portafolios tengo» → listar
 *   «usá el portafolio 2» / «pasame a la cartera dos» → activar
 *   «borrá el portafolio 3» / «eliminá la cartera tres» → borrar
 */
export function entenderComando(texto) {
  const t = plegar(texto);
  if (!t) return null;
  let m = t.match(new RegExp(`\\b(?:borra|borrar|borrame|elimina|eliminar|eliminame|saca|sacar|quita|quitar)\\b[^0-9]{0,25}?\\b${CARTERA}\\s*(?:numero|nro\\.?|n°|#)?\\s*${NUM_RE}\\b`));
  if (!m) m = t.match(new RegExp(`\\b(?:borra|borrar|borrame|elimina|eliminar|eliminame|saca|sacar|quita|quitar)\\b\\s+(?:el|la)\\s+${NUM_RE}\\b`));
  if (m) return { accion: "borrar", n: numDe(m[1]) };
  m = t.match(new RegExp(`\\b(?:usa|usar|usame|activa|activar|cambia|cambiame|cambiar|pasa|pasame|pasar|elegi|elijo|mostra|mostrame|mira|mirame|abri|abrime|quiero|volve|volver)\\b[^0-9]{0,25}?\\b${CARTERA}\\s*(?:numero|nro\\.?|n°|#)?\\s*${NUM_RE}\\b`));
  if (m) return { accion: "activar", n: numDe(m[1]) };
  // «mostrame el segundo portafolio», «usá la primera cartera»
  m = t.match(new RegExp(`\\b(?:usa|usar|usame|activa|activar|cambia|cambiame|pasa|pasame|elegi|elijo|mostra|mostrame|mira|mirame|abri|abrime|volve)\\b\\s+(?:a\\s+)?(?:el|la|mi)?\\s*${NUM_RE}\\s+${CARTERA}\\b`));
  if (m) return { accion: "activar", n: numDe(m[1]) };
  m = t.match(new RegExp(`^(?:el|la)?\\s*${CARTERA}\\s*(?:numero|nro\\.?|n°|#)?\\s*${NUM_RE}\\s*[?!.]*$`));
  if (m) return { accion: "activar", n: numDe(m[1]) };
  if (new RegExp(`\\b(?:mis|cuantos|cuantas|cuales son mis|lista(?:me)? (?:de )?mis|ver mis|ver los|ver las)\\s+${CARTERA}\\b`).test(t)
      || new RegExp(`\\bque ${CARTERA} tengo\\b`).test(t)) return { accion: "listar" };
  return null;
}

/** Con 3 guardados: ¿cuál reemplazar? Devuelve 1-3, "cancelar" o null. */
export function elegirReemplazo(texto) {
  const t = plegar(texto);
  if (!t) return null;
  if (/\b(cancela|cancelar|ninguno|ninguna|no la guardes|no lo guardes|deja|dejalo|dejala|mejor no|no)\b/.test(t)) return "cancelar";
  const m = t.match(new RegExp(`\\b${NUM_RE}\\b`));
  return m ? numDe(m[1]) : null;
}

/** ¿Parece hablar de carteras? Para decidir si un mensaje sin número sigue la pregunta. */
export function hablaDeCarteras(texto) {
  return new RegExp(`\\b${CARTERA}\\b|\\breemplaz|\\bpisa`).test(plegar(texto));
}

// ── Textos ─────────────────────────────────────────────────────────────────
function listaTexto(e) {
  return e.ports.map((s, i) => `${i + 1}) ${etiqueta(s.vista || s.port)}${i === e.activo ? " (la activa)" : ""}`).join(" · ");
}

export function textoLista(e) {
  if (!e?.ports?.length) return "Todavía no tenés portafolios guardados. Pedime «armame un portafolio» y lo guardo en tu cuenta (podés tener hasta 3).";
  const n = e.ports.length;
  return `Tenés ${n} de ${MAX_PORTAFOLIOS} portafolios: ${listaTexto(e)}. `
    + "Cuando me preguntás por «tu portafolio» uso el activo. Para cambiar, decime «usá el portafolio 2»; para borrar uno, «borrá el portafolio 3».";
}

export function textoPedirReemplazo(e) {
  return `Ya tenés ${MAX_PORTAFOLIOS} portafolios guardados: ${listaTexto(e)}. `
    + "¿Cuál reemplazo con el nuevo? Decime 1, 2 o 3, o «cancelar» si preferís no guardarlo.";
}

export function textoActivado(e) {
  const s = e.ports[e.activo];
  return `Listo, ahora uso el portafolio ${e.activo + 1} (${etiqueta(s?.vista || s?.port)}). Preguntame «¿mi portafolio sirve para este mercado?» y lo analizo.`;
}

export function textoBorrado(e, n) {
  if (!e?.ports?.length) return `Listo, borré el portafolio ${n}. No te queda ninguno guardado; cuando quieras, pedime «armame un portafolio».`;
  return `Listo, borré el portafolio ${n}. Te quedan ${e.ports.length}: ${listaTexto(e)}.`;
}

export function textoNoExiste(e, n) {
  const k = e?.ports?.length || 0;
  return k ? `No tenés un portafolio ${n}: tenés ${k}. ${listaTexto(e)}.`
           : "Todavía no tenés portafolios guardados. Pedime «armame un portafolio» y lo guardo en tu cuenta.";
}
