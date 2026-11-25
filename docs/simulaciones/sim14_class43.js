// ============================================================
// sim14_class43.js — los cuatro de class43/class42
// ============================================================
//
// Ejecuta el código REAL de class43 (`CLASS43_SOLO_MODULO=1`, sin Redis ni
// MySQL) y verifica los cuatro puntos que quedaban del bloque §2 del corte:
//
//   Defecto 4   `acerto` trataba TODO lo que no fuera BUY como si fuera SELL.
//               Un HOLD "acertaba" sólo si el instrumento perdía.
//   Duplicación Cada BUY/SELL se guardaba DOS veces: class25B insertaba la
//               decisión y class43, al recibirla, insertaba otra. Medido:
//               172.927 filas = 91.029 decisiones, desde el 15-jun.
//   Cabeza de   La consulta de pendientes traía las 500 más viejas sin mirar
//   cola        si habían vencido: las de 48 h tapaban a las de 24 h.
//   Stats       backtesting_stats guardaba `correctas` del histórico de la
//   inflado     base e `incorrectas` sólo de memoria → ~97 % de acierto.
//
//   node docs/simulaciones/sim14_class43.js

process.env.CLASS43_SOLO_MODULO = "1";

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

// El módulo escribe ~150 líneas por corrida y tapaba las de la prueba. Mismo
// filtro que sim6: se descarta lo que tenga el formato del módulo.
const _log = console.log;
const VERBOSO = process.argv.includes("--verboso");
console.log = (...a) => {
  const t = String(a[0] ?? "");
  if (VERBOSO || !(/^\[/.test(t) || /^[📥⏱️🎯⚪⚠️🔄📡📤===]/.test(t))) _log(...a);
};

const { _test: c43 } = await import("../../scripts/class43.js");

let fallos = 0;
const chequear = (que, ok, det = "") => {
  _log(`   ${ok ? "[ok]" : "[NO]"} ${que.padEnd(54)} ${det}`);
  if (!ok) fallos++;
};

_log("\n=== class43 / class42 — los cuatro del bloque §2 ==============");

// ════════════════════════════════════════════════════════════════════
// 1 · Defecto 4 — sólo BUY y SELL tienen acierto definido
// ════════════════════════════════════════════════════════════════════
_log("\n1 · Defecto 4 — un HOLD no 'acierta' porque el instrumento pierda");
{
  const escrituras = [];
  c43.setOutcomeWriter(async (id, outcome, precio, ret, rel, modo) => {
    escrituras.push({ id, outcome, ret, rel, modo });
    return true;
  });
  c43.setRedisPub({ publish: async () => 1 });

  // Un precio que hace perder al instrumento contra el promedio: con la regla
  // vieja, ésa era justo la condición para que un HOLD saliera "correcto".
  c43.preciosActuales.set("XLK", { precio: 90,  ts: Date.now() });
  c43.preciosActuales.set("XLF", { precio: 110, ts: Date.now() });
  c43.preciosActuales.set("XLE", { precio: 110, ts: Date.now() });

  const base = (tipo) => ({
    id: `sim14_${tipo}`, tipo, ticker: "XLK", confianza: 0.8, horizonte: "24h",
    stop_loss: 0.99, hash_condicion: "h", red_dominante: "",
    precio_entrada: 100, precio_stop: null,
    ts_entrada: Date.now() - 25 * 3600 * 1000,
    ts_vencimiento: Date.now() - 3600 * 1000,
    verificado: false,
  });

  for (const tipo of ["SELL", "HOLD", "ALERTA", "observacion"]) {
    escrituras.length = 0;
    c43.señalesEnCurso.set(`sim14_${tipo}`, base(tipo));
    await c43.verificarOutcome(`sim14_${tipo}`);
    const e = escrituras[0];
    if (tipo === "SELL") {
      // XLK cae 10 % contra un promedio que sube: un SELL acierta.
      chequear("un SELL con el instrumento cayendo: correcto",
               e && e.outcome === "correcto", e ? e.outcome : "sin escritura");
    } else {
      chequear(`"${tipo}" NO se juzga con la regla del SELL`,
               e && e.outcome === "descartado",
               e ? e.outcome : "sin escritura");
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// 2 · La duplicación — completar la fila, no insertar otra
// ════════════════════════════════════════════════════════════════════
_log("\n2 · Una fila por decisión, no dos");
{
  // Caso normal: la fila de class25B ya está.
  let completados = 0, insertados = 0;
  c43.setCompletador(async () => { completados++; return true; });
  c43.setGuardador(async () => { insertados++; return { ok: true }; });

  await c43._persistirPrecioEntrada("dec-1", 188.5, {}, "BUY", "XLK", 0.8, "24h");
  chequear("con la fila de class25B presente: se COMPLETA",
           completados === 1 && insertados === 0,
           `completadas=${completados} insertadas=${insertados}`);

  // La carrera real: class25B publica a Redis ANTES de escribir en MySQL, así
  // que el primer intento puede no encontrar la fila.
  completados = 0; insertados = 0;
  let intentos = 0;
  c43.setCompletador(async () => { intentos++; return intentos >= 2; });
  await c43._persistirPrecioEntrada("dec-2", 188.5, {}, "BUY", "XLK", 0.8, "24h");
  chequear("si class25B todavía no escribió: se REINTENTA",
           intentos === 2 && insertados === 0,
           `intentos=${intentos} insertadas=${insertados}`);

  // Y si de verdad no aparece, se inserta: perder la decisión sería peor que
  // duplicarla, y queda contado.
  completados = 0; insertados = 0;
  c43.setCompletador(async () => false);
  const antes = c43.metricasRef().filas_duplicadas || 0;
  await c43._persistirPrecioEntrada("dec-3", 188.5, {}, "BUY", "XLK", 0.8, "24h");
  chequear("si la fila NUNCA aparece: se inserta de respaldo",
           insertados === 1, `insertadas=${insertados}`);
  chequear("y el respaldo queda CONTADO, no en silencio",
           (c43.metricasRef().filas_duplicadas || 0) === antes + 1,
           `filas_duplicadas=${c43.metricasRef().filas_duplicadas}`);

  c43.setCompletador(null);
  c43.setGuardador(null);
}

// ════════════════════════════════════════════════════════════════════
// 3 · backtesting_stats — correctas e incorrectas, de la misma fuente
// ════════════════════════════════════════════════════════════════════
_log("\n3 · El 97 % del panel: correctas del histórico, incorrectas de memoria");
{
  // Una base falsa con la proporción real medida el 15-sep: ~50 % de acierto.
  c43.setSql(async () => [{
    total: 100000, correctas: 24900, incorrectas: 25100,
    verificadas: 50000, pendientes: 11000,
  }]);
  const publicado = [];
  c43.setRedisPub({ publish: async (canal, msg) => {
    try { publicado.push([canal, JSON.parse(msg)]); } catch (_) {}
    return 1;
  }});
  const guardado = [];
  c43.setStatsWriter((p) => { guardado.push(p); });
  c43.resetConteo();

  // El proceso arrancó hace poco: en memoria casi no hay errores todavía.
  // Ésa es exactamente la condición que producía el 97 %.
  const m = c43.metricasRef();
  m.correctas = 5; m.incorrectas = 3; m.total = 8;

  await c43.publicarMetricas();

  const st = guardado[0];
  chequear("se guardaron estadísticas", !!st);
  if (st) {
    const acc = st.correctas / (st.correctas + st.incorrectas) * 100;
    chequear("incorrectas sale del histórico, no de memoria",
             st.incorrectas === 25100, `incorrectas=${st.incorrectas} (memoria: 3)`);
    chequear("el acierto deja de ser ~97 %", acc > 40 && acc < 60,
             `${acc.toFixed(1)} % (con el bug: ${(st.correctas/(st.correctas+3)*100).toFixed(1)} %)`);
  }
  const met = publicado.find(([c]) => c && c.includes("output"));
  chequear("el payload de Redis lleva el mismo número",
           met && met[1].incorrectas === 25100,
           met ? `incorrectas=${met[1].incorrectas}` : "sin payload");

  c43.setSql(null);
  c43.setStatsWriter(null);
}

// ════════════════════════════════════════════════════════════════════
// 4 · Las consultas de class42 — lo que no se puede ejecutar, se lee
// ════════════════════════════════════════════════════════════════════
// Estas dos viven en SQL y no hay base contra la cual correrlas. Lo que sí se
// puede es verificar que la condición está escrita: es una guarda contra la
// regresión, no una prueba de que MySQL la resuelve bien. Eso se comprueba el
// 12-oct con EXPLAIN.
_log("\n4 · class42.js — la cola de pendientes y la fila única");
{
  const src = fs.readFileSync(path.join(RAIZ, "scripts", "class42.js"), "utf8");

  chequear("la cola de pendientes filtra lo que YA venció",
           /ts_decision\s*\+\s*INTERVAL\s+COALESCE\(horizonte_horas,\s*24\)\s+HOUR\s*<=\s*NOW\(\)/i
             .test(src),
           "sin esto las de 48 h tapan a las de 24 h");
  chequear("sigue ordenando por la más vieja",
           /ORDER BY ts_decision ASC/.test(src));

  chequear("existe completarPrecioEntrada",
           /export async function completarPrecioEntrada/.test(src));
  chequear("y actualiza UNA sola fila, la que aún no tiene precio",
           /UPDATE cognitive_decisions[\s\S]{0,400}?precio_entrada IS NULL[\s\S]{0,120}?LIMIT 1/i
             .test(src),
           "sin el IS NULL, un reintento pisaría el precio bueno");

  const c43src = fs.readFileSync(path.join(RAIZ, "scripts", "class43.js"), "utf8");
  chequear("class43 ya no inserta la decisión en el camino normal",
           !/procesarSeñal[\s\S]{0,4000}?await guardarDecision\(/.test(c43src),
           "el INSERT sólo queda como respaldo");

  // El patrón que ya costó caro dos veces: envolver la columna en una función
  // anula cualquier índice. Vale igual en JS que en Python.
  // Se saltean los COMENTARIOS: los dos módulos explican por qué se sacó el
  // COALESCE, y contarlos daría un rojo permanente por documentar bien. Es el
  // mismo falso positivo que ya tuvo sim12 con una línea de Python.
  const sinComentarios = (t) => t.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|--|\*)/.test(l)).join("\n");
  for (const [nombre, texto] of [["class42", sinComentarios(src)],
                                 ["class43", sinComentarios(c43src)]]) {
    const malos = (texto.match(/COALESCE\s*\(\s*temperatura\s*,[^)]*\)\s*<>/gi) || []);
    chequear(`${nombre}: ningún COALESCE(temperatura,…) en un WHERE`,
             malos.length === 0,
             malos.length ? `${malos.length} encontrados` : "indexable");
  }
}

_log(`\n${fallos === 0 ? "PASA" : "FALLA"} — class43 / class42\n`);
process.exit(fallos === 0 ? 0 : 1);
