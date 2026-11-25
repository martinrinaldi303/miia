// ============================================================
// sim8_contrato_feedback.js — el CONTRATO entre class43 y el C++
// ============================================================
//
// Qué problema resuelve:
//
//   Desde el arreglo del defecto 10 (21-sep-2026), class23 y class24 DEPENDEN
//   de que class43 les mande `ticker` y `label_modo` en el mensaje de feedback.
//   Si ese contrato se rompe —otro nombre de campo, otra capitalización, un
//   publisher que no los manda— el guard del C++ descarta TODO y el
//   entrenamiento se apaga. Es un modo de falla silencioso y se parece mucho a
//   «el sistema anda pero no aprende»: exactamente el patrón que ya costó un
//   mes con la capa 1.
//
//   Nada lo probaba. sim7 usaba un pending armado a mano, no un mensaje real.
//
// Qué hace este archivo:
//
//   Ejecuta los DOS caminos de verificación de class43 —el de memoria y el de
//   reconciliación, que hace el ~95 % del trabajo— con Redis y MySQL falsos,
//   y captura textualmente lo que publica en `class23_feedback` y
//   `class24_feedback`. Lo guarda en datos/feedback_class43.json.
//
//   Después `sim7_defecto10.cpp` lee ese archivo y lo pasa por el guard REAL
//   del C++. Si alguien renombra un campo en class43.js, este archivo lo
//   captura con el nombre nuevo y el test de C++ se pone en rojo.
//
//   Es un contrato vivo: no una copia del payload escrita a mano, que se
//   desactualiza sin que nadie se entere.
//
//   node docs/simulaciones/sim8_contrato_feedback.js

process.env.CLASS43_SOLO_MODULO = "1";

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI   = path.dirname(fileURLToPath(import.meta.url));
const DESTINO = path.join(AQUI, "datos", "feedback_class43.json");

// El módulo escribe ~150 líneas por corrida; ver sim6.
if (!process.argv.includes("--verboso")) {
  const original = console.log;
  console.log = (...a) => {
    const linea = String(a[0] ?? "");
    if (/^\[/.test(linea) || /\.ini\s*$/.test(linea)) return;
    original(...a);
  };
}

const { _test } = await import("../../scripts/class43.js");
const { verificarOutcome, reconciliarPendientesDB, _marketRetCache,
        señalesEnCurso, preciosActuales,
        setSql, setOutcomeWriter, setRedisPub,
        setPendientesReader } = _test;

// ── Redis falso: guarda lo publicado, no lo manda a ningún lado ───────────
const publicado = [];
setRedisPub({
  publish: async (canal, raw) => { publicado.push({ canal, json: JSON.parse(raw) }); },
});

setOutcomeWriter(async () => true);

// ── MySQL falso ───────────────────────────────────────────────────────────
// `_marketRet` pregunta por el retorno equiponderado; `_precioHistorico` por
// el precio de un ticker. Se distinguen por la forma de la consulta.
const RET_MERCADO = 0.0031;        // +0,31 % el índice en la ventana
const PRECIO_ENTRADA = 185.40, PRECIO_SALIDA = 188.10;   // XLK: +1,46 %
setSql(async (sql) => {
  if (/AVG\(\(p1 - p0\)/.test(sql)) return { recordset: [{ ret: RET_MERCADO }] };
  if (/SELECT precio FROM precios/.test(sql)) {
    // El primer pedido del camino de reconciliación es la entrada (horizonte 0).
    const esEntrada = /INTERVAL \?\s*HOUR/.test(sql) && _pedidos++ === 0;
    return { recordset: [{ precio: esEntrada ? PRECIO_ENTRADA : PRECIO_SALIDA }] };
  }
  return { recordset: [] };
});
let _pedidos = 0;

const hace = (h) => new Date(Date.now() - h * 3600e3);

// ═════════════════════════════════════════════════════════════════════════
// 1 · Camino EN MEMORIA (verificarOutcome)
// ═════════════════════════════════════════════════════════════════════════
async function memoria(ticker, tipo) {
  señalesEnCurso.clear(); preciosActuales.clear(); _marketRetCache.clear();
  const ahora = Date.now();
  for (const t of ["XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU","XLC","ARGT","EWZ","ILF"])
    preciosActuales.set(t, { precio: t === "XLK" ? PRECIO_SALIDA : 100, ts: ahora });

  const id = `sim8-mem-${ticker}`;
  señalesEnCurso.set(id, {
    id, tipo, ticker, confianza: 0.72, horizonte: "24h", stop_loss: 0,
    hash_condicion: "hash-sim8", red_dominante: "class24/mercado",
    precio_entrada: ticker === "XLK" ? PRECIO_ENTRADA : 100,
    precio_stop: null, ts_entrada: hace(30).getTime(), ts_vencimiento: 0,
    verificado: false,
  });
  const antes = publicado.length;
  await verificarOutcome(id);
  return publicado.slice(antes);
}

// ═════════════════════════════════════════════════════════════════════════
// 2 · Camino de RECONCILIACIÓN (el que hace el ~95 %)
// ═════════════════════════════════════════════════════════════════════════
async function reconciliacion(ticker, senal) {
  _marketRetCache.clear(); _pedidos = 0;
  setPendientesReader(async () => ([{
    id: 90001, external_id: `sim8-rec-${ticker}`, ticker, senal,
    horizonte: 24, created_at: hace(30), ts: hace(30),
    precio_entrada: ticker === "XLK" ? PRECIO_ENTRADA : null,
    hash_condicion: "hash-sim8-rec", temperatura: null,
  }]));
  const antes = publicado.length;
  await reconciliarPendientesDB();
  setPendientesReader(null);
  return publicado.slice(antes);
}

// ═════════════════════════════════════════════════════════════════════════
const casos = [];
const registrar = (nombre, msgs) => {
  const fb = msgs.filter(m => m.canal === "class23_feedback" || m.canal === "class24_feedback");
  console.log(`   ${nombre.padEnd(34)} ${fb.length} mensaje(s) a las redes` +
              (fb.length ? `  ticker=${fb[0].json.ticker} label_modo=${fb[0].json.label_modo}` : ""));
  if (fb.length) casos.push({ caso: nombre, canal: fb[0].canal, payload: fb[0].json });
  return fb.length > 0;
};

console.log("\nCapturando el feedback REAL que class43 publica a class23/class24\n");
console.log("1 · Camino en memoria (verificarOutcome)");
const okA = registrar("instrumento real (XLK, BUY)", await memoria("XLK", "BUY"));
const okB = registrar("agregado (GENERAL, BUY)",     await memoria("GENERAL", "BUY"));

console.log("\n2 · Camino de reconciliación (~95 % de las verificaciones)");
const okC = registrar("instrumento real (XLK, BUY)", await reconciliacion("XLK", "BUY"));
const okD = registrar("agregado (GENERAL, BUY)",     await reconciliacion("GENERAL", "BUY"));

// ── Chequeos del lado JS ──────────────────────────────────────────────────
console.log("\n3 · El contrato, del lado de class43");
let fallos = 0;
const chequear = (q, ok, det = "") => {
  console.log(`   ${ok ? "[ok]" : "[NO]"} ${q}${det ? "  " + det : ""}`);
  if (!ok) fallos++;
};
chequear("los cuatro casos publican feedback", okA && okB && okC && okD);
for (const c of casos) {
  chequear(`${c.caso.slice(0, 26).padEnd(26)} trae 'ticker'`,      "ticker"      in c.payload, `= ${JSON.stringify(c.payload.ticker)}`);
  chequear(`${c.caso.slice(0, 26).padEnd(26)} trae 'label_modo'`,  "label_modo"  in c.payload, `= ${JSON.stringify(c.payload.label_modo)}`);
  chequear(`${c.caso.slice(0, 26).padEnd(26)} trae 'decision_ts'`, "decision_ts" in c.payload);
  chequear(`${c.caso.slice(0, 26).padEnd(26)} trae 'outcome'`,     "outcome"     in c.payload);
}
const conXLK = casos.filter(c => c.payload.ticker === "XLK");
chequear("XLK sale siempre con label_modo='relativo'",
         conXLK.length > 0 && conXLK.every(c => c.payload.label_modo === "relativo"),
         `${conXLK.length} caso(s)`);

// ── Guardar para que lo consuma el test de C++ ────────────────────────────
const salida = {
  _origen: "generado por docs/simulaciones/sim8_contrato_feedback.js",
  _que_es: "Lo que class43.js publica TEXTUALMENTE en class23_feedback / class24_feedback. " +
           "Lo consume sim7_defecto10.cpp para verificar que el guard del C++ lo acepta. " +
           "Si alguien renombra un campo en class43.js, este archivo cambia y sim7 falla.",
  _regenerar: "node docs/simulaciones/sim8_contrato_feedback.js",
  casos,
};
fs.writeFileSync(DESTINO, JSON.stringify(salida, null, 1), "utf8");
console.log(`\n   escrito ${path.relative(process.cwd(), DESTINO)} (${casos.length} payloads)`);

console.log(`\n${fallos === 0 ? "PASA" : "FALLA"} — contrato class43 -> class23/class24\n`);
process.exit(fallos === 0 ? 0 : 1);
