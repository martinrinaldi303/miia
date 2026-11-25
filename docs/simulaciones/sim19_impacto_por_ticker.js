// ============================================================================
// sim19_impacto_por_ticker.js — el impacto mediático POR INSTRUMENTO
// ----------------------------------------------------------------------------
// QUÉ PRUEBA, y por qué existe:
//
// Hasta el 26-sep-2026 la cadena de noticias perdía el instrumento en el
// segundo eslabón. class1 detecta el ticker de cada titular (TICKERS_ORDENADOS)
// y lo publica en `class1_output`; class11 lo tiraba y calculaba UN score sobre
// una ventana de titulares de tickers MEZCLADOS; class18 lo publicaba sin
// `symbol`; y con el ranking transversal activo los vectores GENERAL no emiten.
// Resultado: el 67 % de la masa de `class25a_pesos.json` quedaba fuera de toda
// decisión publicada.
//
// Esta prueba corre el CÓDIGO REAL de class11 (CLASS11_SOLO_MODULO=1, sin Redis
// ni MySQL) y verifica que el instrumento sobreviva de punta a punta.
//
//   node docs/simulaciones/sim19_impacto_por_ticker.js [--verboso]
// ============================================================================

const VERBOSO = process.argv.includes("--verboso");
process.env.CLASS11_SOLO_MODULO = "1";

let ok = 0, fallas = 0;
const check = (cond, msg, extra = "") => {
  if (cond) { ok++; console.log(`   [ok] ${msg}${extra ? "   " + extra : ""}`); }
  else { fallas++; console.log(`   [FALLA] ${msg}${extra ? "   " + extra : ""}`); }
};

// El módulo escribe ~10 líneas por corrida y tapan las de la prueba.
const _log = console.log;
if (!VERBOSO) {
  console.log = (...a) => {
    const t = String(a[0] ?? "");
    if (/^\[\d{4}-|^\[class11/.test(t)) return;
    _log(...a);
  };
}

const noticia = (titulo, ticker, sentimiento) => ({
  tipo: "noticia", fuente: "class1", titulo,
  texto: titulo, snippet: "", url: null,
  ticker, sentimiento, source: "google", ts: new Date().toISOString(),
});

(async () => {
  const m = await import("../../scripts/class11.js");
  const T = m._test;

  console.log("\n============================================================");
  console.log("  sim19 · impacto mediático POR INSTRUMENTO (class11 real)");
  console.log("============================================================\n");

  // ── 1 · el ticker y el sentimiento sobreviven a la ventana ───────────────
  console.log("1 · La ventana conserva lo que class1 manda");
  T.reset();
  T.agregarNoticia(noticia("XLK chip rally record", "XLK", "BULLISH"));
  const v0 = T.señales.noticiasVentana[0];
  check(v0?.ticker === "XLK", "guarda el ticker", `ticker=${v0?.ticker}`);
  check(v0?.sentimiento === "BULLISH", "guarda el sentimiento", `sent=${v0?.sentimiento}`);

  // ── 2 · un instrumento por ticker, con symbol ────────────────────────────
  console.log("\n2 · Un resultado por instrumento");
  T.reset();
  for (const n of [
    noticia("XLK chip rally record",      "XLK", "BULLISH"),
    noticia("XLK semis surge again",      "XLK", "BULLISH"),
    noticia("XLK demand grows",           "XLK", "BULLISH"),
    noticia("XLE oil drop crash",         "XLE", "BEARISH"),
    noticia("XLF banks steady",           "XLF", "NEUTRAL"),
  ]) T.agregarNoticia(n);

  const r = T.impactoPorTicker();
  check(r.length === 3, "tres instrumentos distintos", `n=${r.length}`);
  check(r.every(x => typeof x.symbol === "string" && x.symbol.length > 0),
        "todos traen `symbol`", r.map(x => x.symbol).join(","));

  const xlk = r.find(x => x.symbol === "XLK");
  const xle = r.find(x => x.symbol === "XLE");
  const xlf = r.find(x => x.symbol === "XLF");

  check(Math.abs(xlk.cuota - 3 / 5) < 1e-9, "la cuota es la porción real del flujo",
        `XLK=${xlk.cuota.toFixed(3)} (3 de 5)`);
  check(xlk.sentimiento_medio === 1 && xle.sentimiento_medio === -1 && xlf.sentimiento_medio === 0,
        "el sentimiento medio sale con signo",
        `XLK=${xlk.sentimiento_medio} XLE=${xle.sentimiento_medio} XLF=${xlf.sentimiento_medio}`);

  // ── 3 · LO QUE IMPORTA: los scores DIFIEREN entre instrumentos ───────────
  // Si dieran todos lo mismo, el ranking no tendría nada que ordenar y todo
  // este trabajo sería invisible. Es la misma trampa que class21/class22
  // aportando un término común a los 50.
  console.log("\n3 · Los scores distinguen instrumentos (si no, no ordena nada)");
  const scores = r.map(x => x.score);
  const disp = Math.max(...scores) - Math.min(...scores);
  check(disp > 0.05, "hay dispersión transversal real", `rango=${disp.toFixed(4)}`);
  check(xlk.score > xlf.score && xlf.score > xle.score,
        "el orden sigue cuota+sentimiento",
        `XLK=${xlk.score.toFixed(3)} > XLF=${xlf.score.toFixed(3)} > XLE=${xle.score.toFixed(3)}`);

  // ── 4 · sin ticker NO se inventa un símbolo ──────────────────────────────
  console.log("\n4 · Un titular sin ticker no fabrica un instrumento");
  T.reset();
  T.agregarNoticia(noticia("markets mixed today", null, "NEUTRAL"));
  T.agregarNoticia(noticia("fed meeting ahead", undefined, "NEUTRAL"));
  check(T.impactoPorTicker().length === 0,
        "sin ticker no sale ningún instrumento", `n=${T.impactoPorTicker().length}`);

  // ── 5 · la confianza crece con el respaldo ───────────────────────────────
  console.log("\n5 · La confianza sube con cuántos titulares respaldan");
  T.reset();
  T.agregarNoticia(noticia("EWZ one", "EWZ", "NEUTRAL"));
  const conf1 = T.impactoPorTicker()[0].confianza;
  for (let i = 0; i < 9; i++) T.agregarNoticia(noticia(`EWZ n${i}`, "EWZ", "NEUTRAL"));
  const conf10 = T.impactoPorTicker()[0].confianza;
  check(conf10 > conf1, "10 titulares dan más confianza que 1",
        `1→${conf1.toFixed(3)}  10→${conf10.toFixed(3)}`);

  // ── 6 · el tope existe, y prioriza al que más respaldo tiene ─────────────
  console.log("\n6 · Tope de instrumentos por análisis");
  T.reset();
  const { MAX_TICKERS, NOTICIAS_MAX } = T.cfg();
  // Un titular por ticker para 20 tickers distintos (entran NOTICIAS_MAX).
  for (let i = 0; i < 20; i++) T.agregarNoticia(noticia(`t${i} headline`, `TK${i}`, "NEUTRAL"));
  // y uno con respaldo claro, que tiene que entrar sí o sí
  for (let i = 0; i < 5; i++) T.agregarNoticia(noticia(`XLV big ${i}`, "XLV", "BULLISH"));
  const r6 = T.impactoPorTicker();
  check(r6.length <= MAX_TICKERS, `no pasa de MAX_TICKERS (${MAX_TICKERS})`, `n=${r6.length}`);
  check(r6[0].symbol === "XLV", "prioriza al de más respaldo", `primero=${r6[0].symbol}`);
  check(T.señales.noticiasVentana.length <= NOTICIAS_MAX,
        `la ventana respeta su tope (${NOTICIAS_MAX})`, `n=${T.señales.noticiasVentana.length}`);

  // ── 7 · EL CONTRATO con class18 ─────────────────────────────────────────
  // class18 lee el símbolo con VecUtils18.GetStr(root, "symbol"), o sea en la
  // RAÍZ del envelope. Si class11 lo pusiera sólo dentro de `data`, class18 no
  // lo encontraría y todo esto sería invisible. Se replica acá el armado del
  // envelope tal como lo hace _runAnalysis.
  console.log("\n7 · El contrato: dónde tiene que estar el símbolo");
  T.reset();
  T.agregarNoticia(noticia("ILF latam rally", "ILF", "BULLISH"));
  const it = T.impactoPorTicker()[0];
  const env = { id: "x", source: "class11", type: "impact_analysis", text: it.resumen,
                data: it, ts: new Date().toISOString(),
                probabilidad: it.probabilidad, confianza: it.confianza,
                score: it.score, symbol: it.symbol, ticker: it.symbol };
  check(env.symbol === "ILF", "`symbol` está en la RAÍZ (lo que lee class18)", `symbol=${env.symbol}`);

  // Y la cadena exacta con la que class19 lo resuelve (class19.js:238).
  const comoLoLeeClass19 = String(
    env.symbol ?? env.ticker ?? env.data?.symbol ?? env.data?.ticker ?? ""
  ).toUpperCase() || null;
  check(comoLoLeeClass19 === "ILF", "class19 lo resolvería igual", `→ ${comoLoLeeClass19}`);

  // ── 8 · la regresión que casi se cuela ──────────────────────────────────
  // class18 manda NULL —no la cadena "GENERAL"— cuando no hay instrumento,
  // porque class19 elige la MÉTRICA DE CAMBIO con `symbol !== null`. Con
  // "GENERAL" literal, cluster/usuario/portfolio pasarían de coseno a delta_max.
  console.log("\n8 · Sin instrumento, class19 tiene que seguir viendo null");
  const envSin = { symbol: null, ticker: null, data: {} };
  const resuelto = String(
    envSin.symbol ?? envSin.ticker ?? envSin.data?.symbol ?? envSin.data?.ticker ?? ""
  ).toUpperCase() || null;
  check(resuelto === null, "un envelope sin símbolo resuelve a null (no a 'GENERAL')",
        `→ ${resuelto}`);
  const esNumericoMercado = ("cluster" === "mercado") || (resuelto !== null);
  check(esNumericoMercado === false,
        "cluster sigue comparándose por coseno, como antes", `numerico=${esNumericoMercado}`);

  // ── 9 · El trinquete que faltaba (10-oct-2026) ─────────────────────────
  //
  // POR_TICKER estuvo en ON desde el corte, pero INERTE: la ventana quedaba en
  // 0 porque class1 no mandaba `texto`. Al arreglar class1 el 10-oct 18:31 se
  // encendio solo, en mitad de la medicion, sin que nadie lo decidiera. La
  // replica del 10-oct ya lo habia medido y lo habia dejado apagado A
  // PROPOSITO: el impacto abre su propia ventana en class25A y mete en la
  // seccion transversal un z de solo noticias que pisa al de mercado.
  //
  // Esta seccion existe para que, si alguien vuelve a prenderlo, sea una
  // DECISION y no un efecto secundario.
  console.log("");
  console.log("9 · El impacto por instrumento viaja APAGADO");
  const cfg = T.cfg();
  check(cfg.POR_TICKER === false,
        "POR_TICKER apagado por defecto",
        "prenderlo cambia lo que el ranking ordena");
  check(process.env.CLASS11_POR_TICKER === undefined,
        "y no hay variable de entorno que lo prenda en la prueba");
  // La funcion sigue andando: lo que esta apagado es la PUBLICACION.
  check(typeof T.impactoPorTicker === "function",
        "impactoPorTicker sigue existiendo y probada arriba",
        "apagada la publicacion, no el calculo");

  // ── resumen ─────────────────────────────────────────────────────────────
  console.log = _log;
  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — impacto por instrumento  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => { console.log = _log; console.error("ERROR:", e); process.exit(1); });
