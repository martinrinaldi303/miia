// ============================================================
// sim6_indice_equiponderado.js — prueba del DEFECTO 5
// ============================================================
//
// Qué prueba, y por qué importa:
//
//   `_getPrecioCompuesto` (class43.js) devuelve el promedio de PRECIOS de los
//   13 instrumentos. El retorno que sale de ahí es un índice tipo Dow: XLK pesa
//   15,8 % e ILF 2,9 %, un rango de 5,4×. `_marketRet`, en cambio, promedia
//   RETORNOS — que es lo correcto — y es el que usa la reconciliación.
//
//   O sea que los dos caminos de verificación se contradecían entre sí sobre la
//   MISMA decisión GENERAL, y la que decidía era cuál llegaba primero.
//
//   Medido sobre el volcado del 15-sep (31.529 ventanas): difieren 0,11 pp a
//   24 h y 0,19 pp a 48 h, y **le cambian el signo al 4,3 % / 10,8 % de las
//   ventanas**. Cada signo dado vuelta es una etiqueta `absoluto` equivocada
//   que después entrena a class23/24 (ver defecto 10 en las notas internas).
//
// Cómo lo prueba: importa class43 DE VERDAD (modo módulo, sin Redis ni MySQL),
// le inyecta una base falsa que responde con el equiponderado real y le pasa
// ventanas reales de `precios`. No reimplementa la lógica: ejecuta la del
// módulo. Si alguien rompe el arreglo, este test se pone en rojo.
//
//   node docs/simulaciones/sim6_indice_equiponderado.js
//
// Datos: docs/simulaciones/datos/precios_ventanas.json (80 ventanas reales,
// 40 con signo discrepante y 40 concordantes). Se regenera del volcado.

process.env.CLASS43_SOLO_MODULO = "1";

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI  = path.dirname(fileURLToPath(import.meta.url));
const DATOS = JSON.parse(fs.readFileSync(path.join(AQUI, "datos", "precios_ventanas.json"), "utf8"));

// ── Silenciar el log del módulo ──────────────────────────────────────────
// class38 y class43 escriben una línea por verificación: ~150 de ruido que
// tapan las 8 de la prueba. Se filtra por el formato del módulo —`[clase]` o
// `[fecha]`, y las líneas del cargador de INI— en vez de redirigir stderr,
// que en PowerShell 5.1 no se puede hacer limpio sobre un .exe nativo.
// Con `--verboso` sale todo.
if (!process.argv.includes("--verboso")) {
  const original = console.log;
  console.log = (...a) => {
    const linea = String(a[0] ?? "");
    if (/^\[/.test(linea) || /\.ini\s*$/.test(linea)) return;
    original(...a);
  };
}

const { _test } = await import("../../scripts/class43.js");
const { verificarOutcome, _getPrecioCompuesto, _marketRetCache,
        señalesEnCurso, preciosActuales, setSql, setOutcomeWriter } = _test;

// ── Base falsa: responde lo que _marketRet le preguntaría a MySQL ──────────
let retEsperado = null;
setSql(async () => ({ recordset: [{ ret: retEsperado }] }));

// ── Captura de lo que se habría escrito en cognitive_decisions ─────────────
let escrito = null;
setOutcomeWriter(async (id, outcome, precioSalida, retorno, rel, labelModo) => {
  escrito = { id, outcome, precioSalida, retorno, rel, labelModo };
  return true;
});

const prom = o => Object.values(o).reduce((s, v) => s + v, 0) / Object.keys(o).length;

async function correr(caso, tipo) {
  señalesEnCurso.clear();
  preciosActuales.clear();
  _marketRetCache.clear();
  escrito = null;

  const pEntrada = prom(caso.p0);
  retEsperado    = caso.ret_equiponderado;

  // Los precios de SALIDA son los que ve class43 al verificar.
  const ahora = Date.now();
  for (const [t, p] of Object.entries(caso.p1)) preciosActuales.set(t, { precio: p, ts: ahora });

  const id = "sim6-" + caso.ts + "-" + caso.h;
  señalesEnCurso.set(id, {
    id, tipo, ticker: "GENERAL", confianza: 0.6, horizonte: caso.h + "h",
    stop_loss: 0, hash_condicion: null, red_dominante: "",
    precio_entrada: pEntrada, precio_stop: null,
    ts_entrada: new Date(caso.ts).getTime(),
    ts_vencimiento: 0, verificado: false,
  });

  await verificarOutcome(id);
  return escrito;
}

// ── Chequeo previo: el compuesto de PRECIOS sigue siendo el viejo ──────────
{
  const c = DATOS.casos[0];
  preciosActuales.clear();
  for (const [t, p] of Object.entries(c.p1)) preciosActuales.set(t, { precio: p, ts: Date.now() });
  const comp = _getPrecioCompuesto("GENERAL")?.precio;
  const esperado = prom(c.p1);
  const ok = Math.abs(comp - esperado) < 1e-6;
  console.log("0 · _getPrecioCompuesto sigue siendo el promedio de precios: " + (ok ? "sí" : "NO") +
              " (" + comp?.toFixed(4) + " vs " + esperado.toFixed(4) + ")");
  if (!ok) { console.error("   el fixture no corresponde a este código"); process.exit(1); }
}

// ── Prueba 1 · el retorno guardado es el EQUIPONDERADO ─────────────────────
let n = 0, okRet = 0, saltados = 0;
const fallos = [];
for (const caso of DATOS.casos) {
  const r = await correr(caso, "BUY");
  if (!r || r.outcome === "descartado") { saltados++; continue; }
  n++;
  if (Math.abs(r.retorno - caso.ret_equiponderado) < 1e-9) okRet++;
  else fallos.push({ ts: caso.ts, h: caso.h, guardado: r.retorno,
                     esperado: caso.ret_equiponderado, viejo: caso.ret_precio_ponderado });
}
console.log("\n1 · Retorno guardado == equiponderado: " + okRet + "/" + n +
            (saltados ? "   (" + saltados + " descartados por veredicto ~0)" : ""));
for (const f of fallos.slice(0, 5))
  console.log("      ✗ " + f.ts + " h=" + f.h + ": guardó " + f.guardado +
              " — esperaba " + f.esperado + " (viejo " + f.viejo + ")");

// ── Prueba 2 · la fila queda coherente: (salida−entrada)/entrada == retorno ─
let okCoh = 0, m = 0;
for (const caso of DATOS.casos) {
  const r = await correr(caso, "BUY");
  if (!r || r.outcome === "descartado") continue;
  m++;
  const pEntrada  = prom(caso.p0);
  const implicito = (r.precioSalida - pEntrada) / pEntrada;
  if (Math.abs(implicito - r.retorno) < 1e-9) okCoh++;
}
console.log("2 · La fila es coherente consigo misma ((salida−entrada)/entrada == retorno): " + okCoh + "/" + m);

// ── Prueba 3 · en las ventanas discrepantes, la ETIQUETA cambia ────────────
// Es el punto de todo el arreglo: no es un ajuste de tercer decimal, da vuelta
// el veredicto. Para un BUY, "correcto" es retorno > 0.
let disc = 0, flip = 0;
const ejemplos = [];
for (const caso of DATOS.casos) {
  if ((caso.ret_precio_ponderado > 0) === (caso.ret_equiponderado > 0)) continue;
  const r = await correr(caso, "BUY");
  if (!r || r.outcome === "descartado") continue;
  disc++;
  const etiquetaVieja = caso.ret_precio_ponderado > 0 ? "correcto" : "incorrecto";
  if (r.outcome !== etiquetaVieja) {
    flip++;
    if (ejemplos.length < 4) ejemplos.push(
      caso.ts + " h=" + caso.h + ": precios " + (caso.ret_precio_ponderado * 100).toFixed(3) +
      " % → " + etiquetaVieja + " | equipond. " + (caso.ret_equiponderado * 100).toFixed(3) +
      " % → " + r.outcome);
  }
}
console.log("3 · Ventanas de signo discrepante en las que la etiqueta se da vuelta: " + flip + "/" + disc);
for (const e of ejemplos) console.log("      " + e);

// ── Prueba 4 · un ticker REAL no se toca ───────────────────────────────────
// El arreglo es solo para el agregado. Una señal de instrumento tiene que
// seguir valuándose con su propio precio y con etiqueta relativa.
{
  const c = DATOS.casos.find(x => x.h === 24) ?? DATOS.casos[0];
  señalesEnCurso.clear(); preciosActuales.clear(); _marketRetCache.clear(); escrito = null;
  retEsperado = c.ret_equiponderado;
  for (const [t, p] of Object.entries(c.p1)) preciosActuales.set(t, { precio: p, ts: Date.now() });
  const id = "sim6-xlk";
  señalesEnCurso.set(id, {
    id, tipo: "BUY", ticker: "XLK", confianza: 0.6, horizonte: "24h", stop_loss: 0,
    precio_entrada: c.p0.XLK, precio_stop: null,
    ts_entrada: new Date(c.ts).getTime(), ts_vencimiento: 0, verificado: false,
  });
  await verificarOutcome(id);
  const propio = (c.p1.XLK - c.p0.XLK) / c.p0.XLK;
  const ok = escrito && Math.abs(escrito.retorno - propio) < 1e-9 && escrito.labelModo === "relativo";
  console.log("4 · Un ticker real (XLK) sigue usando su propio precio y etiqueta relativa: " + (ok ? "sí" : "NO"));
  if (!ok) console.log("      guardó retorno=" + escrito?.retorno + " modo=" + escrito?.labelModo +
                       " — esperaba " + propio + " / relativo");
}

const bien = okRet === n && okCoh === m && flip === disc && n > 0 && disc > 0;
console.log("\n" + (bien ? "✅ PASA" : "❌ FALLA") + " — " + DATOS.n_discrepancias_disponibles + " de " +
            (DATOS.n_discrepancias_disponibles + DATOS.n_concordancias_disponibles) +
            " ventanas del volcado tenían el signo dado vuelta con el índice viejo.");
process.exit(bien ? 0 : 1);
