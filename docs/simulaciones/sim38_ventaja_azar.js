/**
 * sim38 — la ventaja contra el AZAR con la misma mezcla BUY/SELL (6-nov-2026)
 *
 * El panel mostraba «Ventaja real −1,2 pp»: acierto 53,9 % contra un base rate
 * de 55,1 % (decir siempre «le gana al promedio»). Con la mezcla 50/50 del
 * ranking ese base rate no es el azar, y el edge viejo sólo dependía de las SELL.
 * Ahora la vara es lo que acierta un sistema SIN información con la misma
 * mezcla: azar = q·p + (1−q)·(1−p).
 *
 * El cálculo vive en CUATRO lugares, y esta prueba los pone a dar lo mismo:
 *   · `_ventaja_vs_azar` de MIIA/miia_chatbot.py (se extrae con `ast` y se
 *     corre sola: importar el módulo arrastra FastAPI y la base);
 *   · `_miiaVentajaAzar` de publi_src/index.html y de que-es-miia.html (el
 *     respaldo para cuando el Python todavía no se desplegó);
 *   · `ventajaVsAzar` de scripts/chat_evidencia.js (el chat).
 *
 *   node docs/simulaciones/sim38_ventaja_azar.js
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const leer = rel => fs.readFileSync(path.join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

let ok = 0, falla = 0;
function chequear(nombre, cond, nota = "") {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { falla++; console.log(`  ✗ ${nombre}${nota !== "" ? `  → ${nota}` : ""}`); }
}
function seccion(t) { console.log(`\n${t}`); }
const cerca = (a, b, tol = 0.051) => a != null && b != null && Math.abs(a - b) <= tol;
const r1 = x => Math.round(x * 10) / 10;

// ── Casos, en CONTEOS (como los ve el backend) ─────────────────────────────
// t = cuánto le ganan al promedio los elegidos cualquiera sea la señal;
// s = habilidad. P(le ganó | BUY) = 0,5+t+s, P(le ganó | SELL) = 0,5+t−s.
const CASOS = {
  // Los números del panel del 6-nov: BUY 59,0 %, SELL 48,8 %, mitad y mitad.
  captura:     { ok_buy: 5900, tot_buy: 10000, ok_sell: 4880, tot_sell: 10000 },
  // 97 % BUY, CERO habilidad, inclinación +5 pp: `acierto − 50` daría +4,7.
  un_lado:     { ok_buy: 5335, tot_buy: 9700, ok_sell: 135, tot_sell: 300 },
  // Sin habilidad ni inclinación.
  nulo:        { ok_buy: 5000, tot_buy: 10000, ok_sell: 5000, tot_sell: 10000 },
  // 70 % BUY, habilidad 4 pp, inclinación 3 pp → 4·0,7·0,3·4 = 3,36.
  desparejo:   { ok_buy: 3990, tot_buy: 7000, ok_sell: 1530, tot_sell: 3000 },
  // Sólo BUY: un sistema de un lado no puede mostrar ventaja.
  solo_buy:    { ok_buy: 600, tot_buy: 1000, ok_sell: 0, tot_sell: 0 },
  // Peor que el azar: BUY 45 %, SELL 47 %.
  peor:        { ok_buy: 4500, tot_buy: 10000, ok_sell: 4700, tot_sell: 10000 },
};

// Lo que mostraría el payload VIEJO (sin los campos nuevos) para cada caso.
function payloadViejo(c) {
  const n = c.tot_buy + c.tot_sell;
  const up = c.ok_buy + (c.tot_sell - c.ok_sell);
  const acc = (c.ok_buy + c.ok_sell) / n * 100;
  const base = Math.max(up, n - up) / n * 100;
  return {
    accuracy_directional: r1(acc), base_rate: r1(base), edge_vs_baseline: r1(r1(acc) - r1(base)),
    precision_buy:  c.tot_buy  ? r1(c.ok_buy  / c.tot_buy  * 100) : null,
    precision_sell: c.tot_sell ? r1(c.ok_sell / c.tot_sell * 100) : null,
  };
}

// ── 1 · El backend: `_ventaja_vs_azar` de miia_chatbot.py, corrida sola ─────
seccion("1 · miia_chatbot.py: _ventaja_vs_azar, extraída con ast y corrida sola");
const PY = `
import ast, json, sys
src = open(sys.argv[1], encoding="utf-8").read()
mod = ast.parse(src)
fn = [n for n in mod.body if isinstance(n, ast.FunctionDef) and n.name == "_ventaja_vs_azar"]
assert len(fn) == 1, "no está _ventaja_vs_azar a nivel de módulo"
ns = {}
exec(compile(ast.Module(body=fn, type_ignores=[]), "_ventaja_vs_azar", "exec"), ns)
casos = json.loads(sys.argv[2])
print(json.dumps({k: ns["_ventaja_vs_azar"](**v) for k, v in casos.items()}))
`;
let BACK = null;
for (const exe of ["python3", "python", "py"]) {
  const r = spawnSync(exe, ["-I", "-c", PY, path.join(RAIZ, "MIIA", "miia_chatbot.py"), JSON.stringify(CASOS)],
                      { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) { BACK = JSON.parse(r.stdout.trim()); break; }
  if (r.status !== null && r.status !== 0 && !r.error && r.stderr && /Traceback|Error/.test(r.stderr)) {
    chequear(`${exe} corre la función`, false, r.stderr.trim().split("\n").pop());
    break;
  }
}
if (!BACK) {
  console.log("  ⚠ no hay Python: se saltean las comparaciones contra el backend");
} else {
  const c = BACK.captura;
  chequear("la captura: azar 50,0 %", c.azar_mezcla === 50.0, c.azar_mezcla);
  chequear("la captura: ventaja +3,9 pp (antes −1,2)", c.edge_vs_azar === 3.9, c.edge_vs_azar);
  chequear("la captura: inclinación común +5,1 pp", c.sesgo_comun === 5.1, c.sesgo_comun);
  chequear("la captura: acierto balanceado 53,9 %", c.acierto_balanceado === 53.9, c.acierto_balanceado);
  chequear("un solo lado sin habilidad: ventaja 0, no +4,7",
    Math.abs(BACK.un_lado.edge_vs_azar) <= 0.1 && r1(payloadViejo(CASOS.un_lado).accuracy_directional - 50) === 4.7,
    BACK.un_lado.edge_vs_azar);
  chequear("sin habilidad ni inclinación: 0", BACK.nulo.edge_vs_azar === 0 && BACK.nulo.azar_mezcla === 50, JSON.stringify(BACK.nulo));
  chequear("mezcla 70/30: 4·q·(1−q)·s = 3,4", BACK.desparejo.edge_vs_azar === 3.4, BACK.desparejo.edge_vs_azar);
  chequear("sólo BUY: ventaja 0 (el techo de la tesis se conserva)",
    BACK.solo_buy.edge_vs_azar === 0 && BACK.solo_buy.sesgo_comun === null, JSON.stringify(BACK.solo_buy));
  chequear("peor que el azar da negativo", BACK.peor.edge_vs_azar === -4.0, BACK.peor.edge_vs_azar);
  const vacio = spawnSync(BACK ? "python3" : "python", ["-I", "-c",
    PY.replace("casos = json.loads(sys.argv[2])", "casos = {'v': dict(ok_buy=0, tot_buy=0, ok_sell=0, tot_sell=0)}"),
    path.join(RAIZ, "MIIA", "miia_chatbot.py")], { encoding: "utf8" });
  if (vacio.status === 0) chequear("sin verificadas: todo None, no 0", JSON.parse(vacio.stdout).v.edge_vs_azar === null);
}

// ── 2 · La web: _miiaVentajaAzar, en index.html y que-es-miia.html ─────────
seccion("2 · la web: _miiaVentajaAzar (respaldo si el Python no está desplegado)");
function extraer(rel) {
  const s = leer(rel);
  const i0 = s.indexOf("// <ventaja-azar>"), i1 = s.indexOf("// </ventaja-azar>");
  if (i0 < 0 || i1 < 0) return null;
  return s.slice(i0, i1).split("\n").map(l => l.trim()).join("\n");
}
const srcIndex = extraer("scripts/publi_src/index.html");
const srcLanding = extraer("scripts/publi_src/que-es-miia.html");
chequear("index.html tiene el bloque", srcIndex != null);
chequear("que-es-miia.html tiene el bloque", srcLanding != null);
chequear("las dos copias de la web son idénticas", srcIndex === srcLanding);
const webFn = srcIndex ? new Function(`${srcIndex}\nreturn _miiaVentajaAzar;`)() : null;

const E = await import(pathToFileURL(path.join(RAIZ, "scripts", "chat_evidencia.js")).href);

if (webFn) {
  const cap = webFn({ ...payloadViejo(CASOS.captura), accuracy_ci_low: 49.9 });
  chequear("con el payload de producción: azar 50,0", cap.azar_mezcla === 50.0, cap.azar_mezcla);
  chequear("con el payload de producción: ventaja +3,9", cap.edge_vs_azar === 3.9, cap.edge_vs_azar);
  chequear("con IC [49,9 …] no es significativa (49,9 < 50,0)", cap.edge_azar_significativo === false);
  chequear("con IC [50,3 …] sí lo sería",
    webFn({ ...payloadViejo(CASOS.captura), accuracy_ci_low: 50.3 }).edge_azar_significativo === true);
  chequear("deja intactos base_rate y edge_vs_baseline", cap.base_rate === 55.1 && cap.edge_vs_baseline === -1.2,
    `${cap.base_rate} / ${cap.edge_vs_baseline}`);
  const conBack = webFn({ ...payloadViejo(CASOS.captura), azar_mezcla: 50.2, edge_vs_azar: 3.7 });
  chequear("si el backend manda los campos, se usan tal cual", conBack.azar_mezcla === 50.2 && conBack.edge_vs_azar === 3.7);
  chequear("sin precisión por señal no inventa nada",
    webFn({ accuracy_directional: 53.9, base_rate: 55.1 }).edge_vs_azar === undefined);
  chequear("un payload nulo no rompe", webFn(null) === null);

  // ── 3 · Las cuatro copias dan lo mismo ──────────────────────────────────
  seccion("3 · las cuatro copias coinciden");
  for (const [k, c] of Object.entries(CASOS)) {
    const pv = payloadViejo(c);
    const w = webFn({ ...pv });
    const ch = E.ventajaVsAzar(pv, pv.accuracy_directional);
    chequear(`${k}: web y chat idénticos`, w.edge_vs_azar === ch?.edge && w.azar_mezcla === ch?.azar,
      `${w.edge_vs_azar}/${ch?.edge}`);
    // Contra el backend, con la tolerancia del redondeo a un decimal de los
    // campos que tiene el respaldo (acierto y precisión por señal).
    if (BACK) chequear(`${k}: respaldo ≈ backend (±0,15 pp)`,
      cerca(w.edge_vs_azar, BACK[k].edge_vs_azar, 0.15) && cerca(w.azar_mezcla, BACK[k].azar_mezcla, 0.15),
      `${w.edge_vs_azar} vs ${BACK[k].edge_vs_azar}`);
  }
  // Barrido: 400 combinaciones de mezcla, inclinación y habilidad.
  let peor = 0, n = 0, distintas = 0;
  for (let qi = 1; qi <= 9; qi++) for (let ti = -4; ti <= 4; ti += 2) for (let si = -6; si <= 6; si += 2) {
    const q = qi / 10, t = ti / 100, s = si / 100, N = 20000;
    const tb = Math.round(N * q), ts = N - tb;
    const c = { ok_buy: Math.round(tb * (0.5 + t + s)), tot_buy: tb,
                ok_sell: Math.round(ts * (1 - (0.5 + t - s))), tot_sell: ts };
    const pv = payloadViejo(c);
    const w = webFn({ ...pv }), ch = E.ventajaVsAzar(pv, pv.accuracy_directional);
    if (w.edge_vs_azar !== ch.edge) distintas++;
    // La forma cerrada: acierto − azar = 4·q·(1−q)·s.
    peor = Math.max(peor, Math.abs(w.edge_vs_azar - 4 * q * (1 - q) * s * 100));
    n++;
  }
  chequear(`barrido de ${n}: web y chat nunca difieren`, distintas === 0, distintas);
  chequear(`barrido de ${n}: el respaldo sigue la fórmula cerrada (±0,25 pp)`, peor <= 0.25, peor.toFixed(3));

  // Al azar, contra la cuenta EXACTA del backend sobre los conteos. Incluye lo
  // que rompió la primera versión: BUY y SELL que aciertan casi igual con una
  // mezcla despareja (ahí la mezcla no se puede despejar del acierto solo).
  let semilla = 7, peorX = 0, peorRk = 0;
  const rnd = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) {
    const q = 0.02 + rnd() * 0.96, t = (rnd() - 0.5) * 0.12, s = (rnd() - 0.5) * 0.12, N = 20000;
    const tb = Math.round(N * q), ts = N - tb;
    const c = { ok_buy: Math.round(tb * (0.5 + t + s)), tot_buy: tb, ok_sell: Math.round(ts * (0.5 - t + s)), tot_sell: ts };
    const up = (c.ok_buy + ts - c.ok_sell) / N, acc = (c.ok_buy + c.ok_sell) / N;
    const exacto = (acc - (tb / N * up + ts / N * (1 - up))) * 100;
    const err = Math.abs(webFn({ ...payloadViejo(c) }).edge_vs_azar - exacto);
    peorX = Math.max(peorX, err);
    if (q > 0.4 && q < 0.6) peorRk = Math.max(peorRk, err);
  }
  chequear("4000 al azar: el respaldo queda a ±0,3 pp de la cuenta exacta", peorX <= 0.3, peorX.toFixed(3));
  chequear("y a ±0,2 pp con la mezcla del ranking (40-60 % BUY)", peorRk <= 0.2, peorRk.toFixed(3));
}

// ── 4 · El chat ────────────────────────────────────────────────────────────
seccion("4 · el chat dice lo mismo que el panel");
{
  const pv = payloadViejo(CASOS.captura);
  const m = E.normalizarMetricas({ ...pv, edge_min_detectable: 4.0, n_efectivo: 594, accuracy_ci_low: 49.9 });
  chequear("endpoint con precisión por señal → azar 50, +3,9", m.baseTipo === "azar" && m.base === 50 && m.edge === 3.9,
    JSON.stringify(m));
  chequear("y no la da por significativa", m.signif === false);
  const viejo = E.normalizarMetricas({ accuracy_directional: 53.9, base_rate: 55.1, edge_vs_baseline: -1.2 });
  chequear("metricas_context viejo (sin precisión) → base rate, rotulado como tal",
    viejo.baseTipo === "mayoria" && viejo.edge === -1.2);
  const nuevo = E.normalizarMetricas({ accuracy_directional: 53.9, azar_mezcla: 50, edge_vs_azar: 3.9,
                                       edge_azar_significativo: false, base_rate: 55.1 });
  chequear("con los campos del backend nuevo se usan directo", nuevo.baseTipo === "azar" && nuevo.edge === 3.9);
  chequear("la guarda anti-inflado sigue", E.normalizarMetricas({ ...pv, accuracy_directional: 97 }) === null);
  const D = await import(pathToFileURL(path.join(RAIZ, "scripts", "chat_redactor.js")).href);
  const R = await import(pathToFileURL(path.join(RAIZ, "scripts", "chat_router.js")).href);
  const it = R.clasificar ? R.clasificar("¿cuál es tu tasa de acierto?", {}) : { intencion: "acierto" };
  const ev = { datos: { metricas: m }, hechos: [] };
  let texto = "";
  try { texto = D.redactar(it, ev, { semilla: "a" }).texto; } catch (e) { texto = String(e); }
  chequear("la respuesta nombra el azar y el +3,9", /azar/.test(texto) && /3,9|3\.9/.test(texto), texto.slice(0, 120));
  chequear("y no dice que haya ventaja demostrada", /no puedo decir que tenga una ventaja demostrada/.test(texto));
}

// ── 5 · Guardas sobre el código ────────────────────────────────────────────
seccion("5 · guardas: lo que no puede volver a pasar");
{
  const py = leer("MIIA/miia_chatbot.py");
  chequear("el payload SIGUE trayendo base_rate y edge_vs_baseline (la serie de la hoja Tesis)",
    /"base_rate":\s+base_rate/.test(py) && /"edge_vs_baseline":\s+edge_vs_baseline/.test(py));
  chequear("el payload trae azar_mezcla, edge_vs_azar y su significancia",
    /"azar_mezcla":\s+azar_mezcla/.test(py) && /"edge_vs_azar":\s+edge_vs_azar/.test(py) &&
    /"edge_azar_significativo":\s+edge_azar_significativo/.test(py));
  chequear("la significancia es acc_ci_low > azar_mezcla (una cola)", /acc_ci_low > azar_mezcla/.test(py));
  chequear("_metricas_para_chat le pasa al chat el azar y la precisión por señal",
    /"edge_vs_azar":\s+d\.get\("edge_vs_azar"\)/.test(py) && /"precision_buy":\s+d\.get\("precision_buy"\)/.test(py));
  const web = leer("scripts/publi_src/index.html");
  chequear("el panel pasa el payload por _miiaVentajaAzar", /const d = _miiaVentajaAzar\(await r\.json\(\)\)/.test(web));
  chequear("el panel muestra edge_vs_azar, no edge_vs_baseline",
    /const edge = d\.edge_vs_azar/.test(web) && /const e\s+= d\.edge_vs_azar/.test(web) &&
    !/const edge = d\.edge_vs_baseline/.test(web) && !/const e\s+= d\.edge_vs_baseline/.test(web));
  chequear("Sharpe/Sortino se muestran con el MISMO criterio de significancia",
    /_edgeDemostrado = d\.edge_azar_significativo === true/.test(web));
  const land = leer("scripts/publi_src/que-es-miia.html");
  chequear("la portada usa la misma significancia", /d\.edge_azar_significativo === true/.test(land) &&
    !/d\.edge_significativo === true/.test(land));
  const c25 = leer("scripts/class25B.js");
  chequear("class25B pide el endpoint si el metricas_context es viejo",
    /mc\.edge_vs_azar != null \|\| mc\.precision_buy != null/.test(c25));
}

// ── 6 · Lo que dice HOY, para no leerlo de más ─────────────────────────────
seccion("6 · la lectura del 6-nov, con su banda");
{
  // Wilson al 95 % sobre n_efectivo = 594, como el endpoint.
  const n = 594, p = 0.539, z = 1.96, z2 = z * z, den = 1 + z2 / n;
  const centro = (p + z2 / (2 * n)) / den;
  const margen = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  const lo = (centro - margen) * 100;
  chequear("banda ±4,0 pp, como el panel", r1(margen * 100) === 4.0, (margen * 100).toFixed(2));
  chequear("+3,9 queda DENTRO: el piso del IC (49,9) no supera al azar (50,0)", r1(lo) === 49.9 && lo < 50, lo.toFixed(2));
}

console.log(`\n${falla === 0 ? "PASA" : "FALLA"} — ventaja contra el azar con la misma mezcla  (${ok + falla} checks, ${falla} fallas)`);
process.exit(falla ? 1 : 0);
