/**
 * glosario.js — definiciones de tickers para el redactor LOCAL de MIIA.
 *
 * Vive aparte de class25B por el mismo motivo que `cola_acotada.js`,
 * `seguridad_red.js` y `llm_local.js`: importar class25B arrastra MySQL, Redis y
 * el SDK de Google, así que la lógica metida ahí adentro no se puede probar. Acá
 * no hay nada que importar.
 *
 * POR QUÉ EXISTE
 * -------------
 * El motor local (gemma2:2b) confabula con lo que no conoce: el 15-oct-2026, a
 * la pregunta "¿Qué es ARG?", contestó "ARG es un indicador de riesgo global" —
 * inventado (ARGT es el ETF del MERVAL). Darle la definición REAL del ticker en
 * el prompt lo frena. El mapa ticker→{sector,region} sale de la fuente única
 * (INSTRUMENTOS de universo.js); acá sólo está la lógica de armado.
 */

// Escapa lo que sea especial en una regex (los tickers son [A-Z0-9] pero por si
// algún día entra uno con punto, tipo BRK.B).
function _escapar(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hasta `max` definiciones de los tickers de `mapa` mencionados en `texto`.
 *
 * Usa límite de palabra MANUAL (el ticker no pegado a otra letra o dígito), el
 * mismo criterio que `chat_contexto.py` del lado Python: "ARG" NO dispara ARGT,
 * "DÍA"/"MEDIA" NO disparan DIA, "XLKING" NO dispara XLK. Devuelve "" si no hay
 * ninguno, así el prompt no suma una línea vacía.
 *
 * @param {string} texto  la pregunta del usuario
 * @param {Object} mapa   { TICKER: { sector, region } }  (inyectado, puro)
 * @param {number} max    tope de definiciones (default 3)
 */
export function glosarioLocal(texto, mapa, max = 3) {
  const up = String(texto || "").toUpperCase();
  if (!up || !mapa) return "";
  const defs = [];
  for (const t of Object.keys(mapa)) {
    const tu = String(t).toUpperCase();
    if (!tu) continue;
    if (new RegExp(`(?<![A-Z0-9])${_escapar(tu)}(?![A-Z0-9])`).test(up)) {
      const g = mapa[t] || {};
      const sector = g.sector || g.nombre || "";
      if (!sector) continue;
      defs.push(`${tu} = ETF de ${sector}${g.region ? ` (${g.region})` : ""}`);
      if (defs.length >= max) break;
    }
  }
  return defs.length ? `GLOSARIO: ${defs.join("; ")}.` : "";
}
