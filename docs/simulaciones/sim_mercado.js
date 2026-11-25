/**
 * sim_mercado.js — prueba en frío de scripts/mercado.js.
 *
 *   node docs/simulaciones/sim_mercado.js
 *
 * mercado.js es puro: la hora de Nueva York la resuelve `Intl` a partir del
 * instante (Date), así que inyectando un instante UTC fijo el resultado es
 * determinista en cualquier máquina, sin importar su huso. Cubre el caso de la
 * foto (domingo 21:3x ET → "abierto" era alucinación), los bordes de apertura y
 * cierre, un feriado, y que el horario de verano (EDT/EST) se maneje solo.
 */
import { respuestaMercado, estadoMercado, _test } from "../../scripts/mercado.js";

let ok = 0, fail = 0;
const fallos = [];
function chk(cond, nota) { if (cond) ok++; else { fail++; fallos.push(`  ✗ ${nota}`); } }

const D = s => new Date(s);

// ── estadoMercado: abierto/cerrado con instantes UTC fijos ───────────────────
// (tras el fin del horario de verano el 1-nov-2026, ET = UTC-5)
// La foto: domingo 1-nov-2026 21:31 ET = 2-nov 02:31 UTC → CERRADO (fin de semana)
chk(estadoMercado(D("2026-11-02T02:31:00Z")).abierto === false, "domingo 21:31 ET → cerrado (era la alucinación 'abierto')");
chk(estadoMercado(D("2026-11-02T02:31:00Z")).motivo === "finde", "domingo → motivo finde");
// Lunes 2-nov-2026 10:00 ET = 15:00 UTC → ABIERTO
chk(estadoMercado(D("2026-11-02T15:00:00Z")).abierto === true, "lunes 10:00 ET → abierto");
// Lunes 09:00 ET = 14:00 UTC → cerrado (pre-apertura)
chk(estadoMercado(D("2026-11-02T14:00:00Z")).abierto === false, "lunes 09:00 ET → cerrado (pre)");
chk(estadoMercado(D("2026-11-02T14:00:00Z")).motivo === "pre", "lunes 09:00 → motivo pre");
// Lunes 16:30 ET = 21:30 UTC → cerrado (post-cierre)
chk(estadoMercado(D("2026-11-02T21:30:00Z")).abierto === false, "lunes 16:30 ET → cerrado (post)");
chk(estadoMercado(D("2026-11-02T21:30:00Z")).motivo === "post", "lunes 16:30 → motivo post");
// Bordes exactos: 09:30 ET abre, 16:00 ET cierra
chk(estadoMercado(D("2026-11-02T14:30:00Z")).abierto === true,  "lunes 09:30 ET exacto → abierto");
chk(estadoMercado(D("2026-11-02T21:00:00Z")).abierto === false, "lunes 16:00 ET exacto → cerrado");
// Feriado: Thanksgiving jueves 26-nov-2026, 11:00 ET = 16:00 UTC → cerrado
chk(estadoMercado(D("2026-11-26T16:00:00Z")).abierto === false, "Thanksgiving 11:00 ET → cerrado");
chk(estadoMercado(D("2026-11-26T16:00:00Z")).motivo === "feriado", "Thanksgiving → motivo feriado");

// ── Horario de verano manejado solo: 09:30 ET debe dar minutos=570 en las dos ──
chk(_test._partesET(D("2026-07-15T13:30:00Z")).minutos === 570, "verano (EDT, UTC-4): 13:30 UTC = 09:30 ET");
chk(_test._partesET(D("2026-01-15T14:30:00Z")).minutos === 570, "invierno (EST, UTC-5): 14:30 UTC = 09:30 ET");

// ── respuestaMercado: detección y texto ──────────────────────────────────────
const abierto = D("2026-11-02T15:00:00Z");   // lunes 10:00 ET
const cerrado = D("2026-11-02T02:31:00Z");   // domingo 21:31 ET
chk(/abierto ahora/i.test(respuestaMercado("¿el mercado está abierto o cerrado?", abierto) || ""), "pregunta estándar en horario → 'abierto ahora'");
chk(/cerrado/i.test(respuestaMercado("el mercado esta avierto o cerrado ?", cerrado) || ""), "typo 'avierto' + fin de semana → 'cerrado'");
chk(/fin de semana/i.test(respuestaMercado("¿está abierto el mercado?", cerrado) || ""), "domingo → menciona fin de semana");

// ── NEGATIVOS: no es una pregunta de mercado → null ──────────────────────────
chk(respuestaMercado("¿qué riesgo tiene XLK?", abierto) === null, "riesgo de activo → null");
chk(respuestaMercado("armame un portfolio", abierto) === null, "portfolio → null");
chk(respuestaMercado("¿quién te desarrolló?", abierto) === null, "identidad → null");
chk(respuestaMercado("¿cuánto vale XLK?", abierto) === null, "precio → null");
chk(respuestaMercado("", abierto) === null, "vacío → null");

const total = ok + fail;
console.log(`\nsim_mercado: ${ok}/${total} checks en verde`);
if (fail) { console.log(`\n${fail} FALLO(S):\n${fallos.join("\n")}\n`); process.exit(1); }
console.log("Todo OK: estado del NYSE correcto y sin adivinar.\n");
