/**
 * sim_metricas.js — prueba en frío de scripts/metricas.js.
 *
 *   node docs/simulaciones/sim_metricas.js
 *
 * metricas.js es puro: recibe el `metricas_context` ya inyectado y sólo formatea.
 * Lo central es la GUARDA ANTI-INFLADO: aunque se inyecte el 97 % (el número que
 * se sacó de la web el 13-sep), no se publica.
 */
import { respuestaMetricas } from "../../scripts/metricas.js";

let ok = 0, fail = 0;
const fallos = [];
function chk(cond, nota) { if (cond) ok++; else { fail++; fallos.push(`  ✗ ${nota}`); } }

// Métricas honestas representativas (como las del panel ~52,7 %).
const M = { accuracy_directional: 52.7, base_rate: 51.9, edge_vs_baseline: 0.8, n_efectivo: 295, edge_significativo: false };

// ── Detección (incluidos los typos que escribió Martín: "asierto", "taza") ──
for (const q of [
  "¿cuál es tu tasa de acierto?",
  "cual es tu tasa de asierto ?",
  "cual es la taza de asierto de modelo MIIA ?",
  "¿qué precisión tenés?",
  "qué tan preciso sos",
]) {
  const r = respuestaMetricas(q, M);
  chk(r !== null && r.includes("52.7%") && r.includes("295"), `detecta y cita el número real: "${q}"`);
}
// La lectura honesta: cuando NO es significativa, lo dice.
chk(/no es una ventaja demostrable/i.test(respuestaMetricas("tu precisión?", M) || ""), "no significativa → lo aclara");
chk(/no asesoramiento/i.test(respuestaMetricas("tu acierto?", M) || ""), "incluye el marco legal");

// Cuando SÍ es significativa, cambia la frase.
const Msig = { ...M, edge_vs_baseline: 3.1, edge_significativo: true };
chk(/significativa/i.test(respuestaMetricas("precisión?", Msig) || ""), "significativa → lo dice");

// ── GUARDA ANTI-INFLADO: el 97 % NO se publica ───────────────────────────────
chk(respuestaMetricas("¿tu precisión?", { ...M, accuracy_directional: 97.0 }) === null, "accuracy 97% (inflado) → null, NO se publica");
chk(respuestaMetricas("¿tu precisión?", { ...M, accuracy_directional: 12.0 }) === null, "accuracy 12% (implausible bajo) → null");
chk(respuestaMetricas("¿tu precisión?", { ...M, n_efectivo: 10 }) === null, "muestra chica (n=10) → null");
chk(respuestaMetricas("¿tu precisión?", { ...M, accuracy_directional: null }) === null, "accuracy null (todo pendiente) → null");
chk(respuestaMetricas("¿tu precisión?", null) === null, "sin metricas_context → null");
chk(respuestaMetricas("¿tu precisión?", undefined) === null, "metricas_context undefined → null");

// ── NEGATIVOS: no es pregunta de métrica → null (aunque haya datos) ──────────
chk(respuestaMetricas("¿qué riesgo tiene XLK?", M) === null, "riesgo de activo → null");
chk(respuestaMetricas("armame un portfolio", M) === null, "portfolio → null");
chk(respuestaMetricas("¿quién te desarrolló?", M) === null, "identidad → null");
chk(respuestaMetricas("hola", M) === null, "saludo → null");

const total = ok + fail;
console.log(`\nsim_metricas: ${ok}/${total} checks en verde`);
if (fail) { console.log(`\n${fail} FALLO(S):\n${fallos.join("\n")}\n`); process.exit(1); }
console.log("Todo OK: tasa de acierto honesta, el inflado no puede filtrarse.\n");
