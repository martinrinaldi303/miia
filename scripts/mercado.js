/**
 * mercado.js — respuesta determinística de "¿el mercado está abierto o cerrado?".
 *
 * Vive aparte de class25B por el mismo motivo que `glosario.js`, `identidad.js`,
 * `llm_local.js`: importar class25B arrastra MySQL/Redis, así que la lógica metida
 * ahí adentro no se puede probar. Acá no hay nada que importar y `sim_mercado.js`
 * la corre sin levantar el sistema.
 *
 * POR QUÉ EXISTE
 * -------------
 * El 1-nov-2026 a las 23:3x ART (≈21:3x en Nueva York, con el NYSE cerrado) el
 * chat contestó "El mercado está abierto". Es una ALUCINACIÓN del 2B: no tiene
 * reloj ni calendario, así que adivina. El estado del mercado es un HECHO con
 * respuesta exacta —hora de Nueva York + día hábil + feriado—, así que se
 * contesta sin LLM.
 *
 * ALCANCE HONESTO
 * ---------------
 * Horario regular del NYSE: 9:30 a 16:00 hora de Nueva York, lunes a viernes,
 * salvo feriados. NO modela los medios días (cierre 13:00 la víspera de algunos
 * feriados) ni el pre/post-market: para "¿está abierto?" alcanza, y es
 * infinitamente mejor que adivinar. La zona horaria (y por lo tanto el horario
 * de verano) la resuelve `Intl` con `America/New_York`, así que no hay que
 * cablear el offset. La lista de feriados cubre la ventana de medición
 * (2026-2027) y hay que extenderla después.
 */

// Feriados del NYSE (fecha EN HORA DE NUEVA YORK, 'YYYY-MM-DD'). Observados: si
// el feriado cae sábado se corre al viernes, si cae domingo al lunes.
const FERIADOS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const APERTURA_MIN = 9 * 60 + 30;   // 09:30 ET
const CIERRE_MIN   = 16 * 60;       // 16:00 ET

// La pregunta tiene que ser por el ESTADO del mercado/bolsa, no por un activo.
// `aviert` está a propósito: es el typo que Martín escribió en vivo ("avierto").
const _ES_PREGUNTA_MERCADO =
  /\b(mercado|bolsa|nyse|wall\s?street)\b[^?]{0,20}\b(abiert|aviert|cerrad|open|operand|funcionand|activ|oper[aá])/i;
const _ES_PREGUNTA_MERCADO2 =
  /\b(abiert|aviert|cerrad|operand|funcionand)[^?]{0,20}\b(el\s+)?(mercado|la\s+bolsa|nyse|wall)/i;
const _ES_PREGUNTA_MERCADO3 =
  /\b(est[aá]|sigue)\s+(abierto|avierto|cerrado|operando)\b/i;

/** Partes de la hora de Nueva York para un instante dado (independiente del huso
 *  de la máquina que corre esto). */
function _partesET(ahora) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(ahora).map(x => [x.type, x.value]));
  let hh = parseInt(p.hour, 10);
  if (hh === 24) hh = 0;            // algunos motores dan '24' a medianoche
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    diaSemana: p.weekday,           // 'Mon' … 'Sun'
    minutos: hh * 60 + parseInt(p.minute, 10),
  };
}

/**
 * ¿Está abierto el NYSE en `ahora`? Devuelve { abierto, motivo }.
 * @param {Date} ahora  instante a evaluar (default: ahora mismo)
 */
export function estadoMercado(ahora = new Date()) {
  const { fecha, diaSemana, minutos } = _partesET(ahora);
  if (diaSemana === "Sat" || diaSemana === "Sun") return { abierto: false, motivo: "finde" };
  if (FERIADOS.has(fecha))                        return { abierto: false, motivo: "feriado" };
  if (minutos < APERTURA_MIN)                      return { abierto: false, motivo: "pre" };
  if (minutos >= CIERRE_MIN)                       return { abierto: false, motivo: "post" };
  return { abierto: true, motivo: "abierto" };
}

/**
 * Si `texto` pregunta por el estado del mercado, devuelve la respuesta fija;
 * si no, `null` (y el flujo normal de class25B sigue).
 *
 * @param {string} texto
 * @param {Date}   ahora  (inyectable para las pruebas)
 */
export function respuestaMercado(texto, ahora = new Date()) {
  const t = String(texto || "").trim();
  if (!t) return null;
  if (!(_ES_PREGUNTA_MERCADO.test(t) || _ES_PREGUNTA_MERCADO2.test(t) || _ES_PREGUNTA_MERCADO3.test(t)))
    return null;

  const { abierto, motivo } = estadoMercado(ahora);
  const horario = "Opera de 9:30 a 16:00 hora de Nueva York, de lunes a viernes.";
  if (abierto) return `Sí, el mercado (NYSE) está abierto ahora. ${horario}`;

  const porque = motivo === "finde"   ? "es fin de semana"
               : motivo === "feriado" ? "hoy es feriado en el NYSE"
               : motivo === "pre"     ? "todavía no abrió la sesión de hoy"
               : /* post */             "la sesión de hoy ya cerró";
  return `No, el mercado (NYSE) está cerrado: ${porque}. ${horario}`;
}

/** Sólo para las pruebas. */
export const _test = { FERIADOS, APERTURA_MIN, CIERRE_MIN, _partesET };
