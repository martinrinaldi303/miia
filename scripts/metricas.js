/**
 * metricas.js — respuesta determinística de "¿cuál es tu tasa de acierto?".
 *
 * Vive aparte de class25B por el mismo motivo que `glosario.js`, `identidad.js`,
 * `mercado.js`: la lógica pura se prueba sin levantar el sistema (`sim_metricas`).
 *
 * POR QUÉ EXISTE
 * -------------
 * El 1-nov-2026, a "¿cuál es tu tasa de acierto?", el chat contestó "No tengo
 * tasas de acierto, ya que no soy asesor financiero" — una esquiva del 2B. MIIA
 * SÍ tiene el número, y está público en el panel (Precisión hist. 52,7%). Es un
 * HECHO, se contesta sin LLM.
 *
 * DE DÓNDE SALE EL NÚMERO, Y POR QUÉ NO EL INFLADO
 * -----------------------------------------------
 * El número honesto es `accuracy_directional` de `/api/backtesting/professional`
 * (el mismo del panel): accuracy direccional sobre ventanas verificadas, contra
 * `base_rate` (predecir siempre la dirección dominante). NO es la
 * `backtesting_stats.accuracy_global`, que está INFLADA (el "97 %" que se sacó de
 * la web el 13-sep: class43 guarda como correctas el total histórico y como
 * incorrectas sólo las de memoria). El chatbot inyecta el número honesto en
 * `metricas_context` por el bus; acá SÓLO se formatea, con una guarda que
 * rechaza cualquier valor implausible (fuera de 30-70 %) — así ni inyectando el
 * 97 % por error se podría publicar.
 *
 * LECTURA HONESTA, no un titular
 * ------------------------------
 * Se lee la accuracy JUNTO con base_rate, la ventaja y si es significativa
 * (las notas internas: "edge_vs_baseline solo, sin n_efectivo, no distingue señal de
 * ruido"; "nada que le gane a Buffett"). Por eso la respuesta dice el número, la
 * base y que todavía no es una ventaja demostrable cuando no lo es.
 */

const _ES_METRICA  = /\b(precisi[oó]n|a[sc]iert\w*|accuracy|sharpe|efectiv\w*|edge|ventaja)\b/i;
const _ES_METRICA2 = /\bta[sz]a\s+de\s+a[sc]iert/i;              // "tasa/taza de acierto/asierto"
const _ES_METRICA3 = /\b(qu[eé]\s+tan\s+(preciso|acertad)|cu[aá]nto\s+acert[aá]s?)\b/i;

function _num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

/**
 * Si `texto` pregunta por la precisión/tasa de acierto del sistema y hay métricas
 * plausibles en `m`, devuelve la respuesta honesta; si no, `null`.
 *
 * @param {string} texto
 * @param {Object} m  metricas_context inyectado por el chatbot:
 *                    { accuracy_directional, base_rate, edge_vs_baseline,
 *                      n_efectivo, edge_significativo }
 */
export function respuestaMetricas(texto, m) {
  const t = String(texto || "").trim();
  if (!t) return null;
  if (!(_ES_METRICA.test(t) || _ES_METRICA2.test(t) || _ES_METRICA3.test(t))) return null;
  if (!m || typeof m !== "object") return null;

  const acc = _num(m.accuracy_directional);
  const n   = _num(m.n_efectivo);
  // Guarda ANTI-INFLADO: un número honesto de dirección vive cerca del 50 %.
  // Fuera de 30-70 %, o con muestra chica, no se publica (se cae al flujo normal).
  if (acc === null || acc < 30 || acc > 70) return null;
  if (n === null || n < 30) return null;

  const base = _num(m.base_rate);
  const edge = _num(m.edge_vs_baseline);
  const sig  = m.edge_significativo === true;

  let r = `Mi precisión direccional es del ${acc}% sobre ${n} ventanas verificadas`;
  if (base !== null) {
    r += `, contra un ${base}% de la estrategia base (predecir siempre la dirección dominante)`;
    if (edge !== null) {
      r += ` — una ventaja de ${edge >= 0 ? "+" : ""}${edge} pp`;
      r += sig
        ? ", estadísticamente significativa."
        : ", que todavía está dentro del margen de ruido, así que no es una ventaja demostrable aún.";
    } else r += ".";
  } else r += ".";
  r += " Es información del análisis de MIIA, no asesoramiento: la decisión final es tuya.";
  return r;
}

export const _test = { _ES_METRICA };
