/**
 * identidad.js — respuestas determinísticas de IDENTIDAD institucional de MIIA.
 *
 * Vive aparte de class25B por el mismo motivo que `glosario.js`, `llm_local.js`,
 * `cola_acotada.js` y `seguridad_red.js`: importar class25B arrastra MySQL, Redis
 * y el resto, así que la lógica metida ahí adentro no se puede probar. Acá no hay
 * nada que importar, y `sim_identidad.js` la corre sin levantar el sistema.
 *
 * POR QUÉ EXISTE
 * -------------
 * Las preguntas de identidad —"¿quién te desarrolló?", "¿qué modelo usás?",
 * "¿cómo funcionás?"— iban al motor local (gemma2:2b), que CONFABULA con lo que
 * no conoce: es el mismo modo de fallar que el "ARG es un indicador de riesgo
 * global" del 15-oct que motivó `glosario.js`. Un 2B preguntado por su propia
 * identidad puede decir que lo hizo Google, que es un modelo de Gemini, o
 * inventar cualquier cosa. Eso contradice la regla de identidad que ya está en
 * los prompts ("sos MIIA y sólo MIIA, nunca nombres a Gemini/Google") y encima
 * gasta tokens y latencia en una respuesta que no cambia nunca.
 *
 * La identidad es un HECHO, no una inferencia: se contesta con texto fijo, sin
 * LLM, antes de construir contexto. El contenido sale de la FASE 2 del pedido de
 * Martín (MIIA — La Mano Invisible, desarrollada por Martín Rinaldi; el motor de
 * lenguaje es una herramienta de comunicación, no todo MIIA).
 *
 * LO QUE ESTE MÓDULO NO HACE
 * --------------------------
 * No decide nada, no habla con nadie, no tiene estado. Sólo mira el texto y
 * devuelve una de tres respuestas, o `null` si la pregunta NO es de identidad
 * (y entonces el flujo normal de class25B sigue como siempre).
 *
 * NUNCA nombra al proveedor del motor de lenguaje, a propósito: es la misma regla
 * que los prompts de `_buildAdvisorPrompt*`. Distingue el ROL del motor de
 * lenguaje (comunicarse) del núcleo cuantitativo (analizar y decidir), que es lo
 * que la FASE 2 pide — sin afirmar que "todo MIIA es de Google" ni lo contrario.
 */

// Cosas por las que el usuario pregunta y que NO son identidad: un activo, un
// portafolio o una métrica. Si aparecen, esto se corre de lado y deja que el
// flujo normal (o la respuesta determinística de riesgo/métricas) conteste.
const _NO_ES_IDENTIDAD =
  /\b(portafolio|portfolio|cartera|activo|activos|invertir|inversi[oó]n|se[ñn]al|ticker|precio|cotiza|precisi[oó]n|accuracy|sharpe|drawdown|rendimiento|riesgo de)\b/i;

// 1) ¿Quién desarrolló MIIA? (creador / dueño / autor del PROYECTO)
const _DEV =
  /(qui[eé]n(es)?|de qui[eé]n)\b[^?]{0,40}\b(desarroll|cre[oóaá]|hizo|program|fund[oó]|constru|invent|dise[ñn][oó]|arm[oó]|detr[aá]s|due[ñn]|creador|autor|padre|fabric)/i;
const _DEV2 =
  /\b(desarroll\w*|cre\w+|program\w*|hizo|fund\w*|constru\w*|invent\w*|dise[ñn]\w*|fabric\w*)\b[^?]{0,20}\bmiia\b/i;
const _DEV3 =
  /\b(tu|su|de)\s+(creador|desarrollador|autor|due[ñn]o|programador|fabricante)\b/i;
// "de quién sos / de quién es MIIA": "quién" sin verbo, que _DEV no cubre.
const _DEV4 =
  /\bde qui[eé]n\s+(sos|es|era|fue|sal[ií]|ven[ií]s)\b/i;

// 2) ¿Qué modelo / tecnología / IA usás?
// Sin `\b` después de `qu[eé]`/`cu[aá]l`: la tilde (é/á) NO es carácter de palabra
// sin el flag unicode, así que `\b` después de ella no se cumple antes de un
// espacio y la pregunta acentuada no matcheaba (lo cazó sim_identidad).
const _MODELO =
  /\b(qu[eé]|cu[aá]l)[^?]{0,25}\b(modelo|ia|inteligencia artificial|tecnolog[ií]as?|llm|motor(\s+de)?\s+lenguaje|red(es)? neuronal(es)?)\b[^?]{0,25}\b(us[aá]s?|utiliz\w*|ten[eé]s|sos|corr[eé]s|hecho|basad\w*|detr[aá]s|integr\w*)/i;
const _MODELO2 =
  /\b(us[aá]s|sos|corr[eé]s|est[aá]s? hecho con|basad[oa] en|con)\b[^?]{0,15}\b(gemini|chat\s?gpt|gpt|openai|google|gemma|llama|claude|deepseek|mistral|ollama|un llm|una ia)\b/i;
const _MODELO3 =
  /\bqu[eé]\s+(ia|llm|modelo|tecnolog[ií]a)\b[^?]{0,15}\b(sos|us[aá]s|ten[eé]s)/i;

// 3) ¿Cómo funcionás / qué sos / qué integrás? (sólo cuando refiere a MIIA o al
//    bot en segunda persona — "cómo funciona el mercado" NO cae acá).
const _COMO =
  /\b(c[oó]mo|de qu[eé])[^?]{0,10}\b(funcion[aá]s|est[aá]s hecho|trabaj[aá]s|te compon[eé]s|est[aá]s? construid)/i;
const _COMO2 =
  /\b(c[oó]mo funciona|de qu[eé] se compone|qu[eé] es|qu[eé] son)\s+miia\b/i;
const _COMO3 =
  /\bqu[eé]\s+(tecnolog[ií]as?|motores|redes|sistemas?|m[oó]dulos)\b[^?]{0,12}\b(integr\w*|ten[eé]s|us[aá]s|tiene|compon)/i;
const _COMO4 =
  /\b(qu[eé]\s+(pod[eé]s|sab[eé]s)\s+hacer|para qu[eé]\s+serv[ií]s|qu[eé]\s+hac[eé]s\b)/i;

// ── Las tres respuestas (fijas, institucionales, FASE 2) ─────────────────────
const R_DEV =
  "Soy MIIA — La Mano Invisible, un sistema modular de análisis financiero " +
  "desarrollado por Martín Rinaldi. Martín creó el proyecto y su arquitectura: " +
  "los motores cuantitativos, las redes neuronales, el análisis de mercado y de " +
  "noticias, la memoria y el aprendizaje por resultados. Mi motor de lenguaje es " +
  "una herramienta aparte que uso sólo para comunicarme — no es todo MIIA.";

const R_MODELO =
  "Mi núcleo son motores propios de MIIA: redes neuronales, análisis cuantitativo " +
  "de mercado, procesamiento de noticias, análisis de sentimiento, memoria causal " +
  "y aprendizaje basado en resultados verificados. Para conversar uso un motor de " +
  "lenguaje que corre local, dentro de MIIA, y que es sólo la capa de comunicación: " +
  "el análisis y las señales los hacen los motores cuantitativos, no el modelo de " +
  "lenguaje. No dependo de servicios externos de IA para esto.";

const R_COMO =
  "MIIA — La Mano Invisible — es un sistema modular de análisis financiero: integra " +
  "motores cuantitativos, redes neuronales, análisis de mercado y de noticias, " +
  "sentimiento, memoria y aprendizaje por resultados verificados. Analizo el mercado " +
  "en tiempo real y emito señales con su nivel de confianza y de riesgo. Te doy " +
  "información y análisis para que decidas por tu cuenta: no soy un asesor financiero.";

/**
 * ¿Es `texto` una pregunta de identidad institucional? Devuelve la respuesta
 * fija, o `null` si no lo es (y el flujo normal de class25B sigue).
 *
 * Orden de prioridad: desarrollador → modelo → cómo/qué es. Es el orden de lo
 * más específico a lo más general, para que "¿qué modelo usás?" no caiga en la
 * respuesta genérica de "qué es MIIA".
 *
 * @param {string} texto  la pregunta del usuario
 * @returns {string|null}
 */
export function respuestaIdentidad(texto) {
  const t = String(texto || "").trim();
  if (!t) return null;

  // Un activo / portafolio / métrica puntual NO es identidad, aunque la frase
  // tenga la palabra "modelo" o "cómo funciona". Que lo conteste el flujo normal.
  if (_NO_ES_IDENTIDAD.test(t)) return null;

  if (_DEV.test(t) || _DEV2.test(t) || _DEV3.test(t) || _DEV4.test(t)) return R_DEV;
  if (_MODELO.test(t) || _MODELO2.test(t) || _MODELO3.test(t)) return R_MODELO;
  if (_COMO.test(t) || _COMO2.test(t) || _COMO3.test(t) || _COMO4.test(t)) return R_COMO;
  return null;
}

/** Sólo para las pruebas: expone los textos y los detectores. */
export const _test = { R_DEV, R_MODELO, R_COMO };
