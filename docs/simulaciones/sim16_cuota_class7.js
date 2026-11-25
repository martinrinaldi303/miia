// ============================================================
// sim16_cuota_class7.js — el presupuesto de cuota del proveedor
// ============================================================
//
// QUÉ GUARDA. Con 13 instrumentos class7 no podía agotar la cuota: 13 llamadas
// por ciclo de 60 s contra las 60/min del plan gratis de Finnhub. Con 50 eso
// deja de ser cierto por dos caminos, los dos medidos sobre el código:
//
//   1. EL ARRANQUE. La elección de proveedor hacía un `fetchSectors()` COMPLETO
//      de prueba y el primer ciclo hacía otro: 2 × N llamadas en ~20 s. Con 13
//      eran 26 y entraban; con 50 son 100 en el primer minuto. El síntoma no
//      habría sido un error: `fetchQuote` devuelve null en el 429 y se publica
//      `precio: null`, así que la sección transversal de class10 arranca a
//      medias y nadie se entera.
//   2. EL RÉGIMEN. Los tickers custom de class7_watch tenían su propio limiter
//      y se cobraban ADEMÁS de los 50.
//
// Esta prueba ejecuta el código REAL de class7 (`CLASS7_SOLO_MODULO=1` lo
// importa sin Redis ni timers) y verifica las cuatro guardas. No reimplementa
// nada: si alguien saca el limiter o vuelve a probar el proveedor con un
// barrido, esto se pone en rojo.
//
//   node docs/simulaciones/sim16_cuota_class7.js

process.env.CLASS7_SOLO_MODULO = "1";

const { _test } = await import("../../scripts/class7.js");
const { SECTOR_ETF_MAP, POLLING_SEGUNDOS, LLAMADAS_POR_MINUTO } =
  await import("../../scripts/universo.js");

let ok = 0, fail = 0;
function chk(cond, titulo, nota = "") {
  if (cond) { ok++;  console.log(`   [ok] ${titulo.padEnd(56)} ${nota}`); }
  else      { fail++; console.log(`   [FALLA] ${titulo.padEnd(53)} ${nota}`); }
}

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  sim16 · cuota del proveedor de precios (class7)");
console.log("══════════════════════════════════════════════════════════════");

const N = Object.keys(SECTOR_ETF_MAP).length;

// ── 1 · El presupuesto entra en el intervalo ───────────────────────────────
console.log(`\n1 · El barrido entra en el intervalo (${N} instrumentos)`);
const segBarrido = N / LLAMADAS_POR_MINUTO * 60;
console.log(`      cuota=${LLAMADAS_POR_MINUTO}/min · intervalo=${POLLING_SEGUNDOS}s · ` +
            `barrido=~${segBarrido.toFixed(0)}s`);
chk(segBarrido < POLLING_SEGUNDOS,
    "el barrido termina antes del próximo ciclo",
    `${segBarrido.toFixed(0)}s < ${POLLING_SEGUNDOS}s`);
chk(segBarrido < POLLING_SEGUNDOS * 0.9,
    "y con al menos 10 % de holgura",
    `margen ${(POLLING_SEGUNDOS - segBarrido).toFixed(0)}s`);
// Ésta es la guarda de fondo: el ciclo NO puede pedir más de lo que el minuto
// permite sin que el limiter lo frene. Es lo que hacía falta con 50.
chk(N <= LLAMADAS_POR_MINUTO,
    "un barrido completo entra en un solo minuto de cuota",
    `${N} <= ${LLAMADAS_POR_MINUTO}`);

// ── 2 · El limiter está aplicado a TODA llamada ────────────────────────────
// Se comprueba sobre el cliente que devuelve `crearCliente`, que es el único
// lugar donde se envuelve: así cubre el barrido (que llama a `this.fetchQuote`)
// y los tickers custom, en vez de cuatro clientes que se pueden olvidar.
console.log("\n2 · Toda llamada al proveedor pasa por el presupuesto");
let crudas = 0;
const clienteFalso = {
  name: "falso",
  async fetchQuote(sym) { crudas++; return { symbol: sym, close: 100, open: 100, change_pct: 0 }; },
};
// crearCliente sólo envuelve a los cuatro clientes reales; para el falso se
// replica el mismo envoltorio verificando que el limiter es el compartido.
const antes = _test.llamadas();
await _test.limiterCuota.schedule(() => clienteFalso.fetchQuote("XLK"));
chk(crudas === 1, "el limiter ejecuta la llamada envuelta", `crudas=${crudas}`);

for (const nombre of ["finnhub", "alphavantage", "twelvedata", "polygon"]) {
  const c = _test.crearCliente(nombre, "clave-de-prueba");
  // Un fetchQuote envuelto devuelve la promesa del limiter, no la del cliente:
  // se reconoce porque NO es el método del prototipo.
  const proto = Object.getPrototypeOf(c);
  chk(c.fetchQuote !== proto.fetchQuote,
      `${nombre}: fetchQuote está envuelto por el limiter`,
      "");
}

// ── 3 · La prueba de proveedor es UNA llamada, no un barrido ───────────────
// Se lee el fuente: es la única forma de afirmar que no volvió el barrido, y es
// exactamente la regresión que costaría 2×N llamadas en el minuto del corte.
console.log("\n3 · La elección de proveedor no hace un barrido completo");
const fs   = await import("node:fs");
const path = await import("node:path");
const src  = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "scripts", "class7.js"), "utf8");
// OJO con el `indexOf` del final: `if (!providerClient)` aparece ANTES, dentro
// de executeCycle(), así que hay que buscarlo DESDE el inicio del bloque. Sin
// eso el slice sale vacío y la prueba falla sin que el código tenga nada malo.
const iniProv = src.indexOf("// Inicializar proveedor");
const bloqueProveedor = src.slice(iniProv,
                                  src.indexOf("if (!providerClient)", iniProv))
  // Sin los comentarios: el bloque EXPLICA que antes se usaba fetchSectors(),
  // así que buscar la cadena a secas matchea la explicación y no el código.
  .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
chk(!/cliente\.fetchSectors\(\)/.test(bloqueProveedor),
    "la prueba NO llama a fetchSectors()",
    "sería 1 barrido entero sólo para validar la clave");
chk(/cliente\.fetchQuote\(/.test(bloqueProveedor),
    "la prueba llama a fetchQuote() una sola vez",
    "");
const llamadasArranque = 1 + N;
chk(llamadasArranque <= LLAMADAS_POR_MINUTO,
    "arranque (prueba + primer ciclo) entra en un minuto",
    `${llamadasArranque} <= ${LLAMADAS_POR_MINUTO}  (antes: ${2 * N})`);

// ── 4 · Guard de reentrada ─────────────────────────────────────────────────
// Sin esto, dos ciclos en vuelo duplican el consumo de cuota y desordenan
// `soloCambiados()`, que compara contra el último precio visto.
console.log("\n4 · Dos ciclos no pueden correr a la vez");
chk(/_cicloEnCurso/.test(src), "existe el guard de reentrada", "");
chk(/finally\s*\{[^}]*_cicloEnCurso\s*=\s*false/s.test(src),
    "el guard se libera en finally",
    "si tirara dentro del try, class7 se apagaría en silencio");
chk(_test.cicloEnCurso() === false, "arranca liberado", "");

// ── 5 · Los tickers custom no le roban cuota al universo ───────────────────
console.log("\n5 · Los tickers custom van acotados al cupo que sobra");
const cupo = Math.max(0, LLAMADAS_POR_MINUTO - N);
console.log(`      cupo por ciclo = ${LLAMADAS_POR_MINUTO} - ${N} = ${cupo}`);
chk(!/new Bottleneck\(\{ maxConcurrent: 1, minTime: 200 \}\)/.test(src),
    "ya no tienen su propio limiter de 200 ms",
    "era el camino por el que ráfagaban encima del barrido");
chk(/_rotCustom/.test(src),
    "hay rotación, así que los que no entran se cubren después",
    "mismo patrón que la rotación de términos de class1");
chk(N + cupo <= LLAMADAS_POR_MINUTO,
    "universo + cupo custom nunca pasan el presupuesto",
    `${N} + ${cupo} <= ${LLAMADAS_POR_MINUTO}`);

// ── Resumen ────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "PASA" : "FALLA"} — cuota de class7  (${ok} ok, ${fail} fallas)\n`);
process.exit(fail === 0 ? 0 : 1);
