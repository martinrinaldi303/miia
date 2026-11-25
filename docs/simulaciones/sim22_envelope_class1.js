// ============================================================================
// sim22_envelope_class1.js — el primer eslabón de la cadena de noticias
// ----------------------------------------------------------------------------
// QUÉ PRUEBA, y por qué existe:
//
// La cadena `class1 → class3 → class19 → redes` ya estaba cableada entera en el
// código desde el primer commit, y no servía de nada por lo que class1 ponía en
// el envelope de `class3_ingest`:
//
//   1. mandaba la FRASE DE BÚSQUEDA ("XLK technology sector ETF") en vez del
//      titular. Medido con el código real de class3 (sim21): la frase da 3 dims
//      activas y class19 exige 10 — o sea que el vector NO PASABA, y el rechazo
//      quedaba sólo en un contador de class19;
//   2. no llevaba el instrumento, aunque class1 ya lo detecta para
//      `class1_output`. Sin instrumento el vector cae en GENERAL, y con el
//      ranking transversal activo GENERAL no emite.
//
// Esta prueba corre `clasificarNoticia` y `buildEnvelope` REALES de class1.
//
//   node docs/simulaciones/sim22_envelope_class1.js [--verboso]
// ============================================================================

const VERBOSO = process.argv.includes("--verboso");

let ok = 0, fallas = 0;
const check = (cond, msg, extra = "") => {
  if (cond) { ok++; console.log(`   [ok] ${msg}${extra ? "   " + extra : ""}`); }
  else { fallas++; console.log(`   [FALLA] ${msg}${extra ? "   " + extra : ""}`); }
};

// class1 y class38 escriben al importarse y tapan las líneas de la prueba.
const _log = console.log, _warn = console.warn, _err = console.error;
if (!VERBOSO) {
  const filtrar = (orig) => (...a) => {
    const t = String(a[0] ?? "");
    if (/^\[class\d|^\[\d{4}-|^\[INFO|^\[DEBUG/.test(t)) return;
    orig(...a);
  };
  console.log = filtrar(_log); console.warn = filtrar(_warn); console.error = filtrar(_err);
}

// Un artículo con la forma que devuelven los adaptadores de class1.
const art = (title, snippet = "") => ({ title, snippet, url: "https://x/y" });

(async () => {
  const m = await import("../../scripts/class1.js");
  const T = m._test1;
  console.log = _log; console.warn = _warn; console.error = _err;

  console.log("\n============================================================");
  console.log("  sim22 · el envelope de class1 hacia class3 (código real)");
  console.log("============================================================\n");

  // ── 1 · el TEXTO es la noticia, no la consulta ───────────────────────────
  console.log("1 · El texto que viaja es la noticia");
  const c1 = T.clasificarNoticia(
    art("XLK Technology Select Sector SPDR rises as chip demand stays strong",
        "Semiconductor makers led the advance after upbeat guidance."));
  check(c1.texto.includes("chip demand") && c1.texto.includes("Semiconductor makers"),
        "el titular Y el copete entran en `texto`", `${c1.texto.length} caracteres`);
  check(!c1.texto.includes("sector ETF news"), "y la frase de búsqueda no aparece");

  // ── 2 · el instrumento ───────────────────────────────────────────────────
  console.log("\n2 · El instrumento sale del titular");
  check(c1.ticker === "XLK", "detecta el ticker", `ticker=${c1.ticker}`);
  const c2 = T.clasificarNoticia(art("Wall Street ends mixed as investors await the Fed"));
  check(c2.ticker === null, "y si no hay instrumento devuelve null", `ticker=${c2.ticker}`);
  // Sólo el título, igual que antes del 26-sep: mirar también el copete
  // multiplica los falsos positivos.
  const c3 = T.clasificarNoticia(art("Wall Street ends mixed", "XLE and XLF both slipped."));
  check(c3.ticker === null, "el copete NO fabrica un instrumento", `ticker=${c3.ticker}`);

  // ── 3 · el sentimiento, el mismo que ya usaba class1_output ──────────────
  console.log("\n3 · El sentimiento no cambió de definición");
  check(c1.sentimiento === "BULLISH", "un titular de suba es BULLISH", c1.sentimiento);
  check(T.clasificarNoticia(art("XLE oil prices crash on demand fears")).sentimiento === "BEARISH",
        "uno de baja es BEARISH");
  check(T.clasificarNoticia(art("XLF banks report quarterly figures")).sentimiento === "NEUTRAL",
        "y uno sin señal es NEUTRAL");
  // La regex estaba escrita DOS veces (class1_output y la tabla `noticias`).
  // Ahora sale de un solo lugar: los dos destinos no pueden divergir.
  const mixto = T.clasificarNoticia(art("XLK shares rally but analysts warn of a crash"));
  check(mixto.sentimiento === "NEUTRAL",
        "con señales de los dos lados queda NEUTRAL, como la regla vieja", mixto.sentimiento);

  // ── 4 · el envelope: el símbolo en la RAÍZ ───────────────────────────────
  console.log("\n4 · El envelope que lee class3");
  const env = T.buildEnvelope(c1.texto, { query: "XLK technology sector ETF" }, "plain", c1.ticker);
  check(env.symbol === "XLK" && env.ticker === "XLK",
        "`symbol` y `ticker` están en la raíz (donde los lee class3)");
  check(env.texto === c1.texto && env.text === c1.texto,
        "`texto` y `text` llevan la noticia (los dos, por el DSL v1.9 y v2.0)");
  check(env.data?.query === "XLK technology sector ETF",
        "y la consulta NO se pierde: sigue en `data.query`");

  // ── 5 · LA prueba que importa: sin instrumento, NO va "GENERAL" ──────────
  //
  // class19 resuelve el símbolo y elige la MÉTRICA DE CAMBIO con
  // `symbol !== null` (class19.js:249). Un "GENERAL" literal haría que los
  // vectores sin instrumento pasen de compararse por coseno a delta_max. Es la
  // misma regresión que se cazó en class18 el 26-sep, por el mismo camino.
  console.log("\n5 · Sin instrumento no se inventa un símbolo");
  const envSin = T.buildEnvelope("Wall Street ends mixed. Investors await the Fed.",
                                 { query: "market news" }, "plain", null);
  check(!("symbol" in envSin) && !("ticker" in envSin),
        "el campo no está, ni vacío ni con la cadena \"GENERAL\"",
        `claves=${Object.keys(envSin).join(",")}`);
  const comoClass19 = String(
    envSin.symbol ?? envSin.ticker ?? envSin.data?.symbol ?? envSin.data?.ticker ?? ""
  ).toUpperCase() || null;
  check(comoClass19 === null, "class19 lo resolvería a null → sigue comparando por coseno",
        `→ ${comoClass19}`);

  // Y el mismo criterio que aplica class3 del otro lado (ProgramAdaptado.SymbolDe):
  // si alguna vez volviera "GENERAL", class3 también lo descarta.
  console.log("\n6 · Las dos puntas coinciden");
  const envCon = T.buildEnvelope("x", {}, "plain", "EWZ");
  check(envCon.symbol === "EWZ", "class1 manda EWZ");
  check(String(envCon.symbol).toUpperCase() === "EWZ",
        "y class3 lo normaliza igual (mayúsculas, sin espacios)");

  // ── 6 · jsonld, que es la otra rama del contrato ─────────────────────────
  console.log("\n7 · La rama jsonld del contrato");
  const ld = T.buildEnvelope("x", { query: "q" }, "jsonld", "XLV");
  check(ld["@type"] === "analysis", "sigue siendo un envelope jsonld");
  check(ld.symbol === "XLV" && ld.ticker === "XLV",
        "y también lleva el instrumento (antes lo perdía)");
  const ldSin = T.buildEnvelope("x", { query: "q" }, "jsonld", null);
  check(!("symbol" in ldSin), "sin instrumento, tampoco lo inventa");

  // ── 7 · el tope de texto ────────────────────────────────────────────────
  console.log("\n8 · El texto tiene tope");
  const largo = T.clasificarNoticia(art("XLK sube", "palabra ".repeat(400)));
  check(largo.texto.length <= 1000, "no manda más de 1000 caracteres por mensaje",
        `${largo.texto.length}`);

  // ── 8 · el universo, no una lista a mano ────────────────────────────────
  console.log("\n9 · Los tickers salen de la fuente única");
  check(Array.isArray(T.TICKERS_ORDENADOS) && T.TICKERS_ORDENADOS.length >= 13,
        "la lista viene de universo.json", `n=${T.TICKERS_ORDENADOS.length}`);
  // Ordenada por largo descendente: si no, "XL" (si existiera) le ganaría a
  // "XLK" y etiquetaría mal. Es el mismo criterio de class45.
  const largos = T.TICKERS_ORDENADOS.map(t => t.length);
  check(largos.every((l, i) => i === 0 || largos[i - 1] >= l),
        "y ordenada de más largo a más corto, para no cortar un ticker por su prefijo");

  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — envelope de class1 hacia class3  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => {
  console.log = _log; console.error = _err;
  console.error("ERROR:", e);
  process.exit(1);
});
