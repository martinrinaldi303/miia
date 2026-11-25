// ============================================================
// sim10_universo.js — que el universo no vuelva a driftear
// ============================================================
//
// Qué encontró este trabajo (21-sep-2026):
//
//   las notas internas decía que había TRES listas de tickers. Son más de diez: class7,
//   class43 (dos veces), class25B (dos veces), class10.cs, class44.py,
//   miia_chatbot.py (dos veces), class1, class45, index.html y el SQL del
//   chequeo. Y habían drifteado de verdad: **class25B.js:3191 no tenía XLRE**
//   —un instrumento que sí se cotiza y sí entra en la medición— pero sí tenía
//   SPY y QQQ, que no se cotizan.
//
//   Con la ampliación de 13 a 100 del 12-oct, diez listas a mano garantizan
//   que los números dejen de reconciliar sin que nadie pueda decir por qué.
//
// Qué verifica:
//
//   1. El JSON, el respaldo de universo.js y el de universo.py dicen lo mismo.
//      (Los respaldos existen para que un JSON roto no deje al sistema sin
//      universo; el precio es que hay tres copias, y esto las ata.)
//   2. Los módulos ya cableados ven exactamente la misma lista.
//   3. La distinción entre medibles y reconocidos-en-texto se mantiene.
//   4. Un JSON roto NO tumba nada: cae al respaldo.
//   5. Busca en el código listas a mano que queden sin cablear, y las nombra.
//
//   node docs/simulaciones/sim10_universo.js

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

let fallos = 0;
const chequear = (que, ok, detalle = "") => {
  console.log(`   ${ok ? "[ok]" : "[NO]"} ${que.padEnd(52)} ${detalle}`);
  if (!ok) fallos++;
};

const U = await import("../../scripts/universo.js");
const JSON_CRUDO = JSON.parse(fs.readFileSync(
  path.join(RAIZ, "operador", "aprendizaje", "config", "universo.json"), "utf8"));

console.log("\n=== Universo de instrumentos — fuente única ==================\n");
console.log(`   ${U.resumenUniverso()}\n`);

// ── 1 · Las tres copias dicen lo mismo ───────────────────────────────────
console.log("1 · El JSON y los dos respaldos");
const delJson     = JSON_CRUDO.instrumentos.map(i => i.ticker);
const delRespaldo = U._RESPALDO_TEST.instrumentos.map(i => i.ticker);
chequear("universo.js: el respaldo coincide con el JSON",
         JSON.stringify(delJson) === JSON.stringify(delRespaldo),
         `${delRespaldo.length} vs ${delJson.length}`);

let pyTickers = [], pyTexto = [], pyRespaldo = [];
try {
  const salida = execFileSync(process.env.PYTHON || "python",
    ["-c",
     "import json,sys;sys.path.insert(0,'MIIA');import universo as u;" +
     "print(json.dumps({'t':list(u.TICKERS),'x':sorted(u.TICKERS_TEXTO)," +
     "'r':[i['ticker'] for i in u._RESPALDO['instrumentos']]}))"],
    { cwd: RAIZ, encoding: "utf8" });
  const j = JSON.parse(salida.trim().split("\n").pop());
  pyTickers = j.t; pyTexto = j.x; pyRespaldo = j.r;
  chequear("universo.py: el respaldo coincide con el JSON",
           JSON.stringify(pyRespaldo) === JSON.stringify(delJson),
           `${pyRespaldo.length} vs ${delJson.length}`);
  chequear("universo.py lee la misma lista que universo.js",
           JSON.stringify(pyTickers) === JSON.stringify(U.TICKERS));
} catch (e) {
  chequear("universo.py se puede importar", false, String(e.message).slice(0, 60));
}

// ── 2 · La distinción medibles / texto ───────────────────────────────────
console.log("\n2 · Medibles contra reconocidos en texto");
// El 26-sep-2026 SPY y QQQ pasaron a ser instrumentos medibles, así que la
// regla vieja ("los medibles NO los incluyen") dejó de valer. Lo que sigue
// valiendo, y es lo que causó el drift del 21-sep, es que NINGÚN ticker esté
// en las dos listas: `reconocidos_en_texto` es sólo para lo que NO se mide.
const enLasDos = U.TICKERS.filter(t => JSON_CRUDO.reconocidos_en_texto.includes(t));
chequear("ningún medible está también en `reconocidos_en_texto`",
         enLasDos.length === 0,
         enLasDos.length ? `duplicados: ${enLasDos.join(",")}` : `${U.TICKERS.length} medibles`);
chequear("los de texto SÍ incluyen BTC y ETH (que no se cotizan)",
         ["BTC", "ETH"].every(t => U.TICKERS_TEXTO.includes(t)),
         `${U.TICKERS_TEXTO.length} en texto`);
chequear("la lista de LSTM es un subconjunto del universo",
         U.TICKERS_LSTM.every(t => U.TICKERS.includes(t)),
         `${U.TICKERS_LSTM.length} con LSTM de ${U.TICKERS.length}`);
chequear("la lista de noticias es un subconjunto del universo",
         U.TICKERS_NOTICIAS.every(t => U.TICKERS.includes(t)),
         `${U.TICKERS_NOTICIAS.length} con noticias`);
chequear("XLRE está en las dos listas (el drift de class25B)",
         U.TICKERS.includes("XLRE") && U.TICKERS_TEXTO.includes("XLRE"));
chequear("todo medible se reconoce en texto",
         U.TICKERS.every(t => U.TICKERS_TEXTO.includes(t)));

// ── 3 · El mapa de sectores que usa class7 ───────────────────────────────
console.log("\n3 · El mapa sector → ticker (class7)");
chequear("hay un sector por instrumento",
         Object.keys(U.SECTOR_ETF_MAP).length === U.TICKERS.length,
         `${Object.keys(U.SECTOR_ETF_MAP).length} sectores`);
chequear("ningún sector repetido apunta a dos tickers",
         new Set(Object.values(U.SECTOR_ETF_MAP)).size === U.TICKERS.length);

// ── 4 · Un JSON roto no tumba nada ───────────────────────────────────────
// El respaldo existe justo para esto: cambiar un problema de consistencia por
// uno de disponibilidad sería un mal negocio.
console.log("\n4 · Resistencia a un JSON roto");
{
  const roto = path.join(process.env.TEMP || "/tmp", "universo_roto.json");
  fs.writeFileSync(roto, "{ esto no es json valido", "utf8");
  try {
    // pathToFileURL y no la ruta cruda: en Windows `import("C:\...")` falla con
    // ERR_UNSUPPORTED_ESM_URL_SCHEME porque toma "c:" como protocolo.
    const urlMod = (await import("url")).pathToFileURL(
      path.join(RAIZ, "scripts", "universo.js")).href;
    const salida = execFileSync(process.execPath,
      ["--input-type=module", "-e",
       "const u = await import(process.argv[1]); console.log(u.TICKERS.length + '|' + u.ORIGEN);",
       urlMod],
      { env: { ...process.env, MIIA_UNIVERSO_JSON: roto }, encoding: "utf8", cwd: RAIZ });
    const [n, origen] = salida.trim().split("\n").pop().split("|");
    chequear("con el JSON roto sigue habiendo universo", Number(n) === U.TICKERS.length,
             `${n} instrumentos, origen="${origen}"`);
    chequear("y avisa que está usando el respaldo", origen === "respaldo interno");
  } catch (e) {
    chequear("con el JSON roto no se cae", false, String(e.message).slice(0, 70));
  }
  try { fs.unlinkSync(roto); } catch {}
}

// Al cablear una, bajar PENDIENTES_ESPERADAS. Al llegar a 0, sacar el trinquete.
//
// 26-sep-2026: de 9 a 6. Se cablearon class45 (TICKER_MAP, que tenia 13 de 50 y
// dejaba a 37 instrumentos sin sentimiento posible) y las DOS de class1, que
// tenian 11 simbolos — sin XLRE ni ILF, el mismo drift que el 21-sep encontro en
// class25B. Las 6 que quedan, y por que:
//
//   class10.cs:137   SectorIndex10.ETFs. Solo la usa el fallback sector->etf, y
//                    class7 siempre manda `etf`, asi que hoy no decide nada. El
//                    vector ya NO depende de esta lista (ver DIM_TICKER).
//   miia_check.sh    la version que manda vive en /root/ del server y esta
//                    ADELANTE de la del repo: editar aca crea divergencia.
//                    Se actualiza alla, con el resto del corte.
//   index.html x4    listas de PRESENTACION (rotulos y detección en el chat).
//                    Cablearlas exige un endpoint que sirva el universo, y eso
//                    es ruteo nuevo en class30 — o sea reinicio del orquestador.
const PENDIENTES_ESPERADAS = 6;
console.log("\n5 · Listas a mano que quedan en el código");
// Lo que NO es el universo aunque mencione los tickers, y por qué:
const NO_ES_UNIVERSO = [
  // Pesos del S&P por sector para reconstruir el índice de referencia. Es otra
  // magnitud (ponderaciones del índice real), no la lista de instrumentos.
  { archivo: "MIIA/miia_chatbot.py", contiene: "_SP_PESOS" },
];
const revisar = [
  "scripts/class1.js", "scripts/class7.js", "scripts/class10.cs", "scripts/class19.js",
  "scripts/class25B.js", "scripts/class43.js", "scripts/class45.js",
  "scripts/miia_check.sh", "scripts/publi_src/index.html",
  "MIIA/miia_chatbot.py", "MIIA/class44.py",
];
const pendientes = [];
for (const rel of revisar) {
  const abs = path.join(RAIZ, rel);
  if (!fs.existsSync(abs)) continue;
  const txt = fs.readFileSync(abs, "utf8");
  // Una lista a mano = XLK y XLF a menos de 120 caracteres, fuera de comentario.
  const lineas = txt.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (!/XLK/.test(l) || !/XLF/.test(l)) continue;
    if (/^\s*(\/\/|#|\*|<!--)/.test(l)) continue;      // comentario: no cuenta
    if (NO_ES_UNIVERSO.some(x => x.archivo === rel && l.includes(x.contiene))) continue;
    pendientes.push(`${rel}:${i + 1}`);
  }
}
if (pendientes.length === 0) {
  console.log("   ninguna: todos los módulos revisados leen la fuente única");
} else {
  console.log(`   quedan ${pendientes.length} (esperadas ${PENDIENTES_ESPERADAS}) — ` +
              `cablearlas antes de ampliar a 100:`);
  for (const p of pendientes) console.log(`      · ${p}`);
}
chequear("no apareció ninguna lista a mano nueva",
         pendientes.length <= PENDIENTES_ESPERADAS,
         `${pendientes.length} de ${PENDIENTES_ESPERADAS} permitidas`);

console.log(`\n${fallos === 0 ? "PASA" : "FALLA"} — universo unificado` +
            (pendientes.length ? `  (${pendientes.length} listas sin cablear, conocidas)` : "") + "\n");
process.exit(fallos === 0 ? 0 : 1);
