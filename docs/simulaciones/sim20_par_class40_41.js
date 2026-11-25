// ============================================================================
// sim20_par_class40_41.js — el par pronóstico + riesgo, y su cableado
// ----------------------------------------------------------------------------
// QUÉ PRUEBA, y por qué:
//
// class40 y class41 llevaban meses sin producir nada, y la explicación fácil
// —«el entrypoint del .NET sólo arranca class10 y class18»— era sólo la mitad.
// La otra mitad es peor: los DOS estaban suscritos a `class25_output`, que
// lleva DECISIONES, y los dos parsean otra cosa.
//
//   class40 parsea {ticker, sector, horizonDays, series:[{ts, close}]}  ← precios
//   class41 parsea  Ensemble.Predictions + CurrentPrice                 ← un pronóstico
//
// O sea que aunque se los arrancara, caían en su guarda y salían. Y class41
// depende de class40: son un PAR.
//
// Esta prueba corre el `publicarIngestPronostico` REAL de class9
// (CLASS9_SOLO_MODULO=1, sin Redis) y verifica el contrato y el cableado.
//
//   node docs/simulaciones/sim20_par_class40_41.js [--verboso]
// ============================================================================

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const AQUI  = path.dirname(fileURLToPath(import.meta.url));
const RAIZ  = path.resolve(AQUI, "../..");
const VERBOSO = process.argv.includes("--verboso");

// El ON se prueba en este proceso: el módulo lee la variable al importarse, así
// que hay que ponerla ANTES del import dinámico.
process.env.CLASS9_SOLO_MODULO = "1";
process.env.CLASS40_ACTIVO     = "1";

let ok = 0, fallas = 0;
const check = (c, msg, extra = "") => {
  if (c) { ok++; console.log(`   [ok] ${msg}${extra ? "   " + extra : ""}`); }
  else { fallas++; console.log(`   [FALLA] ${msg}${extra ? "   " + extra : ""}`); }
};

const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");
// Sin comentarios: si no, un canal NOMBRADO en un comentario cuenta como uso.
const sinComentarios = (t) =>
  t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const _log = console.log;
if (!VERBOSO) {
  console.log = (...a) => {
    const t = String(a[0] ?? "");
    if (/^\[\d{4}-|^\[class9/.test(t)) return;
    _log(...a);
  };
}

(async () => {
  const m = await import("../../scripts/class9.js");
  const T = m._test9;

  console.log("\n============================================================");
  console.log("  sim20 · el par class40 + class41 (class9 real)");
  console.log("============================================================\n");

  // ── 1 · la serie sale con la forma que class40 PARSEA ───────────────────
  console.log("1 · El contrato con class40");
  const publicado = [];
  T.setPub((ch, payload) => { publicado.push({ ch, msg: JSON.parse(payload) }); return Promise.resolve(1); });

  const ahora = Date.now();
  for (let i = 0; i < 12; i++) T.class9.registrarPrecio("XLK", 180 + i * 0.5, ahora - (12 - i) * 60_000);
  for (let i = 0; i < 12; i++) T.class9.registrarPrecio("XLE", 90 - i * 0.2,  ahora - (12 - i) * 60_000);
  T.class9.registrarPrecio("XLF", 40, ahora);           // 1 solo punto: no alcanza

  T.resetThrottle();
  await T.publicarIngestPronostico();

  check(publicado.length === 2, "publica sólo los símbolos con historial suficiente",
        `n=${publicado.length} (XLF tiene 1 punto)`);
  check(publicado.every(p => p.ch === "class40_ingest"), "va a `class40_ingest`",
        publicado.map(p => p.ch).join(","));

  const msg = publicado.find(p => p.msg.ticker === "XLK")?.msg;
  // Los cuatro campos que class40.EntradaMercado declara con [JsonPropertyName].
  for (const campo of ["ticker", "sector", "horizonDays", "series"]) {
    check(msg?.[campo] !== undefined, `trae \`${campo}\``,
          campo === "series" ? `n=${msg?.series?.length}` : String(msg?.[campo]));
  }
  check(Array.isArray(msg.series) && msg.series.every(p => typeof p.ts === "string" && Number.isFinite(p.close)),
        "cada punto es {ts: string, close: number}", `ej: ${JSON.stringify(msg.series[0])}`);
  check(msg.sector === "Technology", "el sector sale de universo.json", `XLK → ${msg.sector}`);

  // class9 guarda `price`; class40 lee `close`. Si esa traducción se cae, class40
  // recibe series de NaN y no lo dice: devuelve un pronóstico plano.
  check(msg.series[0].close === 180 && msg.series.at(-1).close === 185.5,
        "el precio se traduce a `close` sin perder el valor",
        `${msg.series[0].close} … ${msg.series.at(-1).close}`);

  // ── 2 · el throttle ─────────────────────────────────────────────────────
  console.log("\n2 · El throttle (class9 publica en cada class7_output)");
  publicado.length = 0;
  await T.publicarIngestPronostico();
  check(publicado.length === 0, "una segunda llamada inmediata no publica", `n=${publicado.length}`);

  // ── 3 · APAGADO por defecto, en un proceso limpio ───────────────────────
  console.log("\n3 · Apagado por defecto");
  const hijo = execFileSync(process.execPath, ["-e", `
    process.env.CLASS9_SOLO_MODULO = "1";
    import("${pathToFileURL(path.join(RAIZ, "scripts/class9.js")).href}").then(async m => {
      const T = m._test9; let n = 0;
      T.setPub(() => { n++; return Promise.resolve(1); });
      for (let i = 0; i < 12; i++) T.class9.registrarPrecio("XLK", 180 + i, Date.now());
      T.resetThrottle();
      await T.publicarIngestPronostico();
      console.log(JSON.stringify({ activo: T.cfg().C40_ACTIVO, publicados: n }));
    });
  `], { encoding: "utf8", env: { ...process.env, CLASS40_ACTIVO: "" } });
  const r3 = JSON.parse(hijo.trim().split("\n").filter(l => l.startsWith("{")).pop());
  check(r3.activo === false, "sin CLASS40_ACTIVO el switch está en OFF");
  check(r3.publicados === 0, "y no publica ni un mensaje", `n=${r3.publicados}`);

  // ── 4 · el cableado de los dos .cs ──────────────────────────────────────
  console.log("\n4 · Los canales de class40 y class41");
  const c40 = sinComentarios(leer("scripts/class40.cs"));
  const c41 = sinComentarios(leer("scripts/class41.cs"));

  check(c40.includes('"class40_ingest"'),   "class40 lee `class40_ingest`");
  check(c40.includes('"class40_forecast"'), "class40 escribe `class40_forecast`");
  check(c41.includes('"class40_forecast"'), "class41 lee `class40_forecast`");
  check(c41.includes('"class41_output"'),   "class41 escribe `class41_output`");

  // ── 5 · LA AUTO-REFERENCIA, que es el motivo del recableado ─────────────
  // Los dos leían `class25_output`: el pronóstico y el riesgo se alimentaban de
  // las decisiones que ayudan a tomar. Si alguien lo revierte, esto se pone rojo.
  console.log("\n5 · Ya no leen la salida del propio sistema");
  check(!c40.includes('"class25_output"'), "class40 NO lee `class25_output`");
  check(!c41.includes('"class25_output"'), "class41 NO lee `class25_output`");

  // ── 6 · class40 no pisa a los dos suplentes que ya existen ──────────────
  // `class40_output` lo publican class45 (sentimiento como proxy de crisis) y
  // class44 (LSTM) desde el primer commit. Un tercer productor los pisaría.
  console.log("\n6 · No se pisa a los productores que ya están");
  check(!c40.includes('"class40_output"'),
        "class40 NO publica en `class40_output` (lo usan class44 y class45)");
  const c45 = sinComentarios(leer("scripts/class45.js"));
  check(c45.includes("class40_output"), "y class45 lo sigue publicando, intacto");

  // ── 7 · EL CICLO EXISTE, y lo que importa es que no tenga ganancia ──────
  //
  // Sin adornos: `class9 → class40_ingest → class40 → class40_forecast →
  // class41 → class41_output → class9` ES un ciclo, porque class9 se suscribe a
  // `class41_output` (inputChannel1). No se puede evitar sin que class41 deje de
  // llegar a sus consumidores, que es justamente para lo que se conecta.
  //
  // Lo que SÍ se puede garantizar, y es lo que decide si el lazo es peligroso,
  // es que la GANANCIA sea cero por el camino que importa: lo que class9 le
  // manda a class40 es `historial`, que lo llena ÚNICAMENTE `registrarPrecio`
  // desde class7. El riesgo de class41 cae en `señalesExternas.riesgo`, que
  // alimenta el resumen de class9_output y NO la serie.
  //
  // O sea: class41 no puede influir en lo que class40 recibe. Se prueba
  // poniendo un riesgo extremo y verificando que el mensaje no cambie ni un byte.
  console.log("\n7 · El ciclo class9 → class40 → class41 → class9 (existe: ¿tiene ganancia?)");
  const c9 = sinComentarios(leer("scripts/class9.js"));
  check(c9.includes("class40_ingest"), "class9 alimenta `class40_ingest`");
  check(c9.includes("class41_output"),
        "y class9 SÍ lee `class41_output` → el ciclo existe, no se disimula");

  // El `ts` del envoltorio es la hora de envío y cambia entre llamadas, así que
  // se saca ANTES de comparar. Sin esto la prueba sólo pasa cuando las dos
  // llamadas caen en el mismo milisegundo — o sea, de forma intermitente.
  const sinTs = (arr) => JSON.stringify(arr.map(({ ts, ...resto }) => resto));

  publicado.length = 0;
  T.resetThrottle();
  await T.publicarIngestPronostico();
  const antes = sinTs(publicado.map(p => p.msg));

  T.señalesExternas.riesgo = { RiskMetrics: { RiskScore: 0.99, RiskLevel: "HIGH", ProbDown: 0.97 } };
  publicado.length = 0;
  T.resetThrottle();
  await T.publicarIngestPronostico();
  const despues = sinTs(publicado.map(p => p.msg));

  check(antes === despues && antes.length > 0,
        "con riesgo HIGH la serie que recibe class40 es IDÉNTICA → ganancia 0",
        `${publicado.length} mensajes, ${antes.length} bytes comparados`);

  // ── 8 · el entrypoint, apagado ──────────────────────────────────────────
  console.log("\n8 · El entrypoint arranca el par sólo con el switch");
  const c10 = leer("scripts/class10.cs");
  check(c10.includes('GetEnvironmentVariable("CLASS40_ACTIVO") == "1"'),
        "class40 detrás de CLASS40_ACTIVO");
  check(c10.includes('GetEnvironmentVariable("CLASS41_ACTIVO") == "1"'),
        "class41 detrás de CLASS41_ACTIVO");
  check(c10.includes("Program10.RunAsync(args)"),
        "class10 sigue bloqueando el proceso principal (no se rompió el entrypoint)");

  // ── 9 · los votantes en class25A: apagados, y con contadores ────────────
  // El modo de fallar que importa acá es «encendido y aportando cero», que no
  // da ningún error. Por eso los contadores van al heartbeat con prefijo fijo
  // `votantes:` y el chequeo tiene una sección que los lee.
  console.log("\n9 · class40/41 como votantes de class25A");
  const c25 = leer("miia_cognitive/class25A.cpp");

  check(/static int g_votante_crisis = 0;/.test(c25),
        "CLASS25A_VOTANTE_CRISIS arranca APAGADO");
  check(/static int g_meta_k = 0;/.test(c25),
        "CLASS25A_META_K arranca APAGADO");
  check(c25.includes('sub.subscribe(CH_FC40)'),
        "class25A se suscribe a `class40_forecast`");
  check(c25.includes('redes_snap["class40"]') && c25.includes('redes_snap["class41"]'),
        "los dos entran al ensamble como una red más (el patrón de class44)");
  check(/g_ventana\.fc40\[tk40\]/.test(c25) && /g_ventana\.rk41\[tk41\]/.test(c25),
        "y se cachean POR TICKER — si fueran globales no moverían un puesto");

  // class27 sobre k: tiene que tocar la FRACCIÓN, no el z. Si alguien lo mueve
  // a multiplicar z_ens, deja de cambiar decisiones (el orden es invariante a
  // escala) y vuelve a ser trabajo invisible.
  check(/fraccion \*= mf;/.test(c25),
        "class27 modula la FRACCIÓN de k, no el z");
  check(!/z_ens \*= /.test(c25),
        "y NO multiplica z_ens (eso no cambiaría ningún puesto)");

  // La línea que lee el chequeo, con sus siete campos.
  const hb = c25.match(/votantes: class40=\{\}[^"]*/);
  check(!!hb, "el heartbeat emite la línea `votantes:`");
  for (const campo of ["class40=", "class41=", "sin_ticker40=", "sin_ticker41=",
                       "meta_k_recortes=", "modo_votante=", "modo_meta_k="]) {
    check(c25.includes(campo), `  el heartbeat trae \`${campo}\``);
  }

  // Y que la sección del chequeo exista y busque ese prefijo.
  const chk = leer("scripts/miia_check.sh");
  check(chk.includes('10 · VOTANTES NUEVOS'), "miia_check.sh tiene la sección 10");
  check(chk.includes('grep -ah "votantes:"'), "y busca el prefijo `votantes:`");

  console.log = _log;
  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — par class40+class41  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => { console.log = _log; console.error("ERROR:", e); process.exit(1); });
