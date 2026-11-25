/**
 * sim_identidad.js — prueba en frío de scripts/identidad.js.
 *
 * Corre en la máquina de Martín, sin levantar el sistema: identidad.js es puro
 * (no importa nada), así que esto es como glosario/llm_local — se prueba la
 * lógica real sin Redis, MySQL ni Ollama.
 *
 *   node docs/simulaciones/sim_identidad.js
 *
 * Cubre la FASE 11 (5 preguntas de identidad) más los NEGATIVOS que NO deben
 * robarle el turno al flujo normal (un activo, una métrica, un portafolio, un
 * saludo), que es donde una respuesta determinística mal puesta haría daño.
 */
import { respuestaIdentidad, _test } from "../../scripts/identidad.js";

let ok = 0, fail = 0;
const fallos = [];

// Afirma que `texto` cae en la respuesta `esperada` (R_DEV | R_MODELO | R_COMO | null).
function debe(texto, esperada, nota) {
  const r = respuestaIdentidad(texto);
  const bien = esperada === null ? r === null : r === esperada;
  if (bien) { ok++; }
  else {
    fail++;
    const got = r === null ? "null" : r.slice(0, 40) + "…";
    const exp = esperada === null ? "null" : String(esperada).slice(0, 40) + "…";
    fallos.push(`  ✗ "${texto}"\n      esperaba: ${exp}\n      obtuvo:   ${got}${nota ? `  (${nota})` : ""}`);
  }
}

const { R_DEV, R_MODELO, R_COMO } = _test;

// ── 1) DESARROLLADOR / CREADOR (FASE 2: distinguir desarrollador del proyecto) ──
debe("¿quién desarrolló MIIA?", R_DEV);
debe("quién te creó", R_DEV);
debe("¿quién te hizo?", R_DEV);
debe("¿quién está detrás de MIIA?", R_DEV);
debe("¿quién es tu creador?", R_DEV);
debe("de quién sos", R_DEV);
debe("quién programó este sistema", R_DEV);

// ── 2) MODELO / TECNOLOGÍA / IA (FASE 2: distinguir el modelo lingüístico) ──
debe("¿qué modelo usás?", R_MODELO);
debe("qué inteligencia artificial utilizás", R_MODELO);
debe("¿usás Gemini?", R_MODELO);
debe("¿sos de Google?", R_MODELO);
debe("¿sos ChatGPT?", R_MODELO);
debe("qué LLM sos", R_MODELO);
debe("¿con qué tecnología estás hecho?", R_MODELO);

// ── 3) CÓMO FUNCIONA / QUÉ ES (FASE 2: arquitectura del sistema) ──
debe("¿cómo funcionás?", R_COMO);
debe("¿qué es MIIA?", R_COMO);
debe("¿cómo funciona MIIA?", R_COMO);
debe("qué tecnologías integrás", R_MODELO);  // _MODELO gana por prioridad y enumera los motores: respuesta válida
debe("¿qué podés hacer?", R_COMO);
debe("para qué servís", R_COMO);

// Que la respuesta NUNCA nombre al proveedor del motor de lenguaje (regla de los
// prompts de _buildAdvisorPrompt*). Vale para las tres.
const _prohibido = /\b(gemini|google|gemma|openai|chatgpt|gpt|llama|claude|deepseek|mistral|ollama)\b/i;
for (const [nombre, r] of [["R_DEV", R_DEV], ["R_MODELO", R_MODELO], ["R_COMO", R_COMO]]) {
  if (_prohibido.test(r)) { fail++; fallos.push(`  ✗ ${nombre} nombra al proveedor del motor de lenguaje`); }
  else ok++;
}

// ── NEGATIVOS: estas NO son identidad y deben devolver null (flujo normal) ──
debe("¿qué riesgo tiene XLK?", null, "es riesgo por activo");
debe("¿cuál es tu precisión histórica?", null, "es una métrica, la contesta su rama");
debe("armame un portfolio", null, "es portafolio");
debe("¿qué modelo de portfolio usás?", null, "tiene 'portfolio' → no identidad");
debe("¿cómo funciona el mercado?", null, "es mercado, no MIIA");
debe("hola, ¿quién sos?", null, "lo maneja el saludo de class25B");
debe("¿cuál es la señal de IWF?", null, "es una señal");
debe("gracias", null, "agradecimiento");
debe("", null, "vacío");

// ── Resumen ──────────────────────────────────────────────────────────────────
const total = ok + fail;
console.log(`\nsim_identidad: ${ok}/${total} checks en verde`);
if (fail) {
  console.log(`\n${fail} FALLO(S):\n${fallos.join("\n")}\n`);
  process.exit(1);
}
console.log("Todo OK: identidad determinística correcta y sin fuga de proveedor.\n");
