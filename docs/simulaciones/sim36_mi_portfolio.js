#!/usr/bin/env node
/**
 * sim36_mi_portfolio.js — «¿el portafolio que me armaste sirve para este
 * régimen de mercado?» (4-nov-2026).
 *
 * El 4-nov esa pregunta, y «¿cómo está hoy mi porfolio en base a este
 * régimen?», recibían la plantilla «necesito saber tu tolerancia al riesgo» o
 * una lectura del mercado que no mencionaba el portafolio. Esta prueba, sin
 * levantar nada:
 *
 *   1. El router distingue «mi portafolio» de «armame uno» (y entiende «porfolio»).
 *   2. Lo que llega del navegador se valida (localStorage lo edita cualquiera).
 *   3. La comparación contra el mercado: cambio ponderado, ranking, régimen.
 *   4. El texto: trae los números, no es la plantilla, no aconseja.
 *   5. Guardas de regresión sobre class25B, el Python y la web.
 *
 *   node docs/simulaciones/sim36_mi_portfolio.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const R = await import("../../scripts/chat_router.js");
const E = await import("../../scripts/chat_evidencia.js");
const MP = await import("../../scripts/chat_portfolio.js");
const U = await import("../../scripts/universo.js");
const leer = p => fs.readFileSync(path.join(RAIZ, p), "utf8").replace(/\r\n/g, "\n");

let ok = 0, falla = 0;
function chequear(nombre, cond, nota = "") {
  if (cond) { ok++; console.log(`   [ok]    ${nombre.padEnd(66)} ${nota}`); }
  else { falla++; console.log(`   [NO]    ${nombre.padEnd(66)} ${nota}`); }
}
const OP = { universo: U.TICKERS, reconocidos: U.TICKERS_TEXTO };
const cl = (t, extra = {}) => R.clasificar(t, { ...OP, ...extra });

// ── 1 ──
console.log("\n1 · El router: «mi portafolio» no es «armame uno»");
for (const [t, esperado, sub] of [
  ["El portafolio que me armaste sirve para este régimen de mercado ?", "mi_portfolio"],
  ["Cómo está hoy mi porfolio en base a este régimen de mercado ?", "mi_portfolio"],
  ["¿cómo está mi cartera?", "mi_portfolio"],
  ["mi portfolio sirve?", "mi_portfolio"],
  ["¿tengo que cambiar mi portafolio?", "mi_portfolio", "ajustar"],
  ["¿el portfolio que me recomendaste aguanta este mercado?", "mi_portfolio"],
  ["armame un portfolio", "portfolio"],
  ["armame un portfolio nuevo para este régimen", "portfolio"],
  ["quiero invertir", "portfolio"],
  ["¿cómo está el mercado?", "resumen"],
  ["¿qué opinás de XLK?", "opinion"],
]) {
  const c = cl(t);
  chequear(`«${t.slice(0, 52)}»`, c.intencion === esperado && (sub === undefined || c.subtipo === sub),
           `→ ${c.intencion}${c.subtipo ? "·" + c.subtipo : ""}`);
}
const prev = { previo: { intencion: "mi_portfolio", tickers: [] } };
chequear("después de hablar de su portafolio, «¿y lo cambio?» sigue en él",
  cl("¿y lo cambio?", prev).intencion === "mi_portfolio" && cl("¿y lo cambio?", prev).subtipo === "ajustar");
chequear("«dale» después de su portafolio lo amplía", cl("dale", prev).destino?.intencion === "mi_portfolio");
chequear("sin ese contexto, «¿y lo cambio?» NO es su portafolio", cl("¿y lo cambio?").intencion !== "mi_portfolio");

// ── 2 ──
console.log("\n2 · Lo que llega del navegador se valida");
const crudo = { perfil: "moderado", monto: "$5000", ts: "2026-11-03T15:00:00Z", activos: [
  { symbol: "XLK", peso_pct: 30, sector: "Technology" }, { symbol: "XLE", peso_pct: 25 },
  { symbol: "XLU", peso_pct: 20 }, { symbol: "<img onerror=x>", peso_pct: 10 },
  { symbol: "EWZ", peso_pct: 15 }, { symbol: "XLK", peso_pct: 50 }, { symbol: "SPY", peso_pct: 900 },
] };
const port = MP.normalizarPortfolio(crudo);
chequear("se queda con los símbolos válidos, sin repetidos ni pesos absurdos",
  port && port.activos.map(a => a.symbol).join(",") === "XLK,XLE,XLU,IMGONERROR,EWZ",
  port?.activos.map(a => a.symbol).join(","));
chequear("ningún símbolo trae caracteres de HTML", port.activos.every(a => /^[A-Z0-9.\-]+$/.test(a.symbol)));
chequear("perfil desconocido → null", MP.normalizarPortfolio({ ...crudo, perfil: "kamikaze" }).perfil === null);
chequear("sin activos → null", MP.normalizarPortfolio({ perfil: "moderado", activos: [] }) === null);
chequear("basura → null", MP.normalizarPortfolio("hola") === null && MP.normalizarPortfolio(null) === null);

// ── 3 ──
console.log("\n3 · La comparación contra el mercado");
const INST = U.TICKERS.map(t => ({ ticker: t, sector: "?", region: "US" }));
const ahora = Date.parse("2026-11-04T19:00:00Z");
function panel(cambios, rank, riesgo = 0.77) {
  const cot = {}; for (const t of U.TICKERS) cot[t] = { cambio: cambios[t] ?? 0.6, precio: 100, ts: ahora };
  return E.armarPanel({ ahora, instrumentos: INST, cotizaciones: cot, ranking: rank, riesgo,
    riesgoActivo: { XLK: { vol: 18, dd: 6 }, XLE: { vol: 28, dd: 11 }, XLU: { vol: 14, dd: 5 } },
    mercado: { abierto: true } });
}
const n = U.TICKERS.length, k = 8;
const rk = (tk, puesto, senal) => ({ senal, puesto, n, k, conf: 0.9, ts: ahora });
const limpio = MP.normalizarPortfolio({ perfil: "moderado", monto: "$5000", ts: "2026-11-03T15:00:00Z",
  activos: [{ symbol: "XLK", peso_pct: 40 }, { symbol: "XLE", peso_pct: 30 }, { symbol: "XLU", peso_pct: 30 }] });

const Pa = panel({ XLK: 1.2, XLE: -0.8, XLU: 0.1 },
  { XLK: rk("XLK", 1, "BUY"), XLE: rk("XLE", n - 2, "SELL"), XLU: rk("XLU", 20, "HOLD") });
const ea = MP.evaluarPortfolio(limpio, Pa);
const esperado = 0.4 * 1.2 + 0.3 * -0.8 + 0.3 * 0.1;
chequear("cambio ponderado por los pesos", Math.abs(ea.cambio - esperado) < 1e-9, `${ea.cambio.toFixed(3)} = ${esperado.toFixed(3)}`);
chequear("relativo = cambio − promedio del universo", Math.abs(ea.relativo - (ea.cambio - ea.hoy.media)) < 1e-9);
chequear("XLK en zona de compra, XLE en zona de venta", ea.aFavor.map(f => f.symbol).join() === "XLK" && ea.enContra.map(f => f.symbol).join() === "XLE");
chequear("volatilidad ponderada de la cartera", Math.abs(ea.vol - (0.4 * 18 + 0.3 * 28 + 0.3 * 14)) < 1e-9, `${ea.vol.toFixed(1)}%`);
chequear("régimen del día alcista (casi todo sube)", ea.reg?.etiqueta === "alcista");

const Pb = panel(Object.fromEntries(U.TICKERS.map(t => [t, -1.2])),
  { XLK: rk("XLK", n - 1, "SELL"), XLE: rk("XLE", n - 3, "SELL") }, 0.85);
const cic = MP.normalizarPortfolio({ perfil: "agresivo", activos: [{ symbol: "XLK", peso_pct: 60 }, { symbol: "XLY", peso_pct: 40 }] });
const eb = MP.evaluarPortfolio(cic, Pb);
chequear("día bajista con cartera cíclica en zona de venta → desalineado", eb.reg?.etiqueta === "bajista" && eb.encaje === "desalineado", `${eb.reg?.etiqueta} · ${eb.encaje}`);
const ec = MP.evaluarPortfolio(limpio, panel({}, {}));
chequear("sin ranking y sin diferencia → encaje mixto, no inventado", ec.encaje === "mixto");
const ed = MP.evaluarPortfolio(limpio, E.armarPanel({ ahora, instrumentos: INST }));
chequear("sin cotizaciones ni ranking → no hay datos (no opina)", ed.hayDatos === false && ed.encaje === null);

// ── 4 ──
console.log("\n4 · El texto");
const ta = MP.redactarMiPortfolio(limpio, ea, { semilla: "a", ahora });
console.log(`        «${ta}»`);
chequear("nombra los activos de SU portafolio", /XLK/.test(ta) && /XLE/.test(ta) && /XLU/.test(ta));
chequear("dice el régimen con amplitud y promedio", /se lee alcista/.test(ta) && /suben \d+ de \d+/.test(ta));
chequear("da el cambio ponderado contra el promedio", /Ponderado por los pesos/.test(ta) && /promedio/.test(ta));
chequear("menciona lo que va en contra (zona de venta)", /XLE.*zona de venta/.test(ta));
chequear("NO es la plantilla de tolerancia al riesgo", !/tolerancia al riesgo/.test(ta));
chequear("aclara que no es asesoramiento", /(no es asesoramiento|no es una recomendaci)/.test(ta));
const tb = MP.redactarMiPortfolio(cic, eb, { semilla: "b", ahora, subtipo: "ajustar" });
console.log(`        «${tb}»`);
chequear("no ordena comprar ni vender", !/\b(compr[aá]lo|vend[eé]lo|te recomiendo (comprar|vender)|deber[ií]as (comprar|vender)|ten[eé]s que (comprar|vender))\b/i.test(ta + tb));
chequear("al preguntar si cambiarlo, señala lo que más va en contra", /lo que más va contra/.test(tb) && /seguir el ruido/.test(tb));
chequear("en día bajista avisa la falta de defensivos", /defensivos/.test(tb));
const td = MP.redactarMiPortfolio(limpio, ed, { semilla: "d", ahora });
chequear("sin datos frescos lo dice en vez de inventar", /no tengo cotizaciones/.test(td));
chequear("sin portafolio guardado: lo dice y ofrece armarlo", /No tengo guardado/.test(MP.sinPortfolio(null)) && /moderado/.test(MP.sinPortfolio("moderado")));
chequear("reproducible con la misma semilla", ta === MP.redactarMiPortfolio(limpio, ea, { semilla: "a", ahora }));

// ── 4b · «¿Lo cambio?»: el sistema decide SÍ / NO / ESPERÁ (13-nov-2026) ──
console.log("\n4b · El veredicto del sistema (cambiar / mantener / esperar)");
{
  const vB = MP.veredictoPortfolio(cic, eb, Pb);
  chequear("60%+ en zona de venta y desalineado → CAMBIAR", vB.decision === "cambiar" && vB.sale[0] === "XLK", JSON.stringify(vB.sale));
  const vA = MP.veredictoPortfolio(limpio, ea, Pa);
  chequear("30% en zona de venta con el resto a favor → ESPERAR", vA.decision === "esperar", vA.decision);
  const sano = MP.normalizarPortfolio({ perfil: "moderado", activos: [{ symbol: "XLK", peso_pct: 50 }, { symbol: "XLU", peso_pct: 50 }] });
  const vS = MP.veredictoPortfolio(sano, MP.evaluarPortfolio(sano, Pa), Pa);
  chequear("nada en zona de venta → MANTENER", vS.decision === "mantener", vS.decision);
  const vD = MP.veredictoPortfolio(limpio, ed, E.armarPanel({ ahora, instrumentos: INST }));
  chequear("sin datos frescos → ESPERAR (no decide a ciegas)", vD.decision === "esperar" && /no tengo/.test(vD.motivos[0]));
  const cons = MP.normalizarPortfolio({ perfil: "conservador", activos: [{ symbol: "XLE", peso_pct: 100 }] });
  const vC = MP.veredictoPortfolio(cons, MP.evaluarPortfolio(cons, Pa), Pa);
  chequear("conservador con volatilidad > 25% → CAMBIAR (no encaja con su perfil)", vC.decision === "cambiar" && /conservador/.test(vC.motivos[0]));
  chequear("a un conservador no le propone reemplazos sin volatilidad medida ≤ 25%",
    vC.candidatos.every(tk => E.vistaTicker(tk, Pa).riesgo?.vol <= 25));
  const tv = MP.redactarMiPortfolio(cic, eb, { semilla: "v", ahora, subtipo: "ajustar", veredicto: vB });
  console.log(`        «${tv}»`);
  chequear("la respuesta ARRANCA con el veredicto", /^Mi lectura con los datos de hoy: sí, conviene revisarlo/.test(tv));
  chequear("dice qué revisar primero y aclara que la decisión es del usuario", /Lo primero a revisar es XLK/.test(tv) && /la decisión es tuya/.test(tv));
  // El motor que lo reescribe NO puede dar vuelta la conclusión ni inventar.
  const evRef = { hechos: [tv] };
  const V = t => E.validarRespuesta(t, evRef, { tickers: U.TICKERS_TEXTO });
  chequear("reescritura fiel pasa", V("Con lo que veo hoy, sí: conviene revisarlo, empezando por XLK, que está en la zona de venta. La decisión es tuya.").ok);
  chequear("reescritura con una cifra inventada se descarta", !V("Sí, conviene revisarlo: XLK cayó 7,3% esta semana.").ok);
  chequear("reescritura que nombra un ETF que no está se descarta", !V("Sí, conviene revisarlo: pasá a SPY.").ok);
  const c25 = fs.readFileSync(path.join(AQUI, "..", "..", "scripts", "class25B.js"), "utf8").replace(/\r\n/g, "\n");
  chequear("class25B: el veredicto lo decide el sistema y el motor sólo lo redacta",
    c25.includes("veredictoPortfolio(port, evP, panelP, umbralesPara(") && c25.includes("_reescribirConMotor(texto, resp, {}, historial,")
    && c25.includes('"cambió la conclusión del sistema"'));
  chequear("class25B: la reescritura valida ESTRICTO con la respuesta del sistema como único hecho",
    c25.includes("const evRef = { ...(ev || {}), hechos: [referencia] };") && c25.includes("validarRespuesta(t, evRef, { tickers: TICKERS_TEXTO })"));
  chequear("class25B: reversa sin recompilar", c25.includes("CLASS25B_CHAT_REESCRIBIR"));
}

// ── 5 ──
console.log("\n5 · Guardas de regresión");
const c25 = leer("scripts/class25B.js");
chequear("class25B importa chat_portfolio", /from "\.\/chat_portfolio\.js"/.test(c25));
chequear("class25B contesta mi_portfolio ANTES de armar el panel general",
  c25.indexOf('ef.intencion === "mi_portfolio"') > 0 && c25.indexOf('ef.intencion === "mi_portfolio"') < c25.indexOf("const ev = chatEvidencia(ef, panel)"));
chequear("class25B recupera el perfil del portafolio guardado (sin repreguntar)", /_hidratarSesion\(sesion, msg\)/.test(c25));
chequear("class25B recuerda el portafolio que arma (los dos caminos)", (c25.match(/_recordarPortfolio\(msg, /g) || []).length >= 3);
chequear("la memoria por usuario está acotada", /PORT_USUARIO_MAX/.test(c25) && /PORT_USUARIO_TTL/.test(c25));
const py = leer("MIIA/miia_chatbot.py");
chequear("el Python reenvía portfolio_usuario a class25B", /"portfolio_usuario": port_usuario/.test(py));
chequear("el import nuevo del Python es defensivo (el server puede tener chat_contexto viejo)",
  /try:\n    from chat_contexto import portfolio_del_navegador\nexcept Exception:/.test(py));
const web = leer("scripts/publi_src/index.html");
chequear("la web guarda el portafolio por usuario en localStorage", /localStorage\.setItem\(_portKey\(\)/.test(web));
chequear("la web lo restaura al cargar", /_restaurarPortfolioGuardado/.test(web));
chequear("la web lo manda con cada pregunta", /portfolio_usuario: _lastChatPortfolioRec \|\| _portfolioGuardado\(\)/.test(web));
chequear("la web sanea lo que lee antes de pintarlo", /function _sanearPortfolio/.test(web) && /_renderChatPortfolioRec\(rec, guardar = true\) \{\n  rec = _sanearPortfolio\(rec\);/.test(web));

// 5-nov-2026: la memoria por usuario vivía sólo en RAM y cada deploy de
// class25B la borraba → «No encuentro una cartera tuya guardada».
chequear("la memoria por usuario se guarda en state/ y se relee al arrancar",
  /class25b_portfolios_usuario\.json/.test(c25) && /^_cargarPortUsuario\(\);$/m.test(c25) && /_guardarPortUsuario\(\)/.test(c25));
chequear("lo leído del disco se valida igual que lo de la web",
  /function _cargarPortUsuario[\s\S]{0,700}normalizarPortfolio\(f\.port\)/.test(c25));
chequear("al apagar se escribe lo pendiente", /async function shutdown\(\)[\s\S]{0,300}_escribirPortUsuario\(\)/.test(c25));
chequear("sin cartera: se contesta el régimen y se pide el perfil (sin «Dale.»)",
  /contexto: "sin_portfolio", regimen: reg/.test(c25));
// La tarjeta de decisión: «1.96 puntos porcentuales estimados» y «Forecast un motor».
{
  const a = web.indexOf("const _NOMBRES_INTERNOS"), b = web.indexOf("function _tickerAmigable");
  const ui = new Function(web.slice(a, b) + "; return _textoDecisionUI;")();
  const crudo = "GENERAL se mantuvo estable 1.96 puntos porcentuales estimados. Riesgo alto (0.69). Red dominante: class22/cluster (peso=0.12, score=0.881). 4 de 4 redes indican tendencia positiva. Forecast class40: alcista con probabilidad 61%. Riesgo sistémico class41: 0.5491. Señal emitida con confianza 51% (ensemble=0.5754 > umbral=0.43).";
  const t = ui(crudo);
  console.log(`        «${t}»`);
  chequear("la tarjeta no muestra «puntos porcentuales estimados»", !/puntos porcentuales/.test(t) && /^Mercado en general: sin señal clara\./.test(t));
  chequear("la tarjeta no muestra el eco de class40/41", !/Forecast|sistémico|un motor interno/.test(t));
  chequear("la tarjeta no deja «( > )» ni corta a mitad de palabra", !/\(\s*>?\s*\)/.test(t) && /[.…]$/.test(t));
  chequear("la red dominante dice qué mira", /red neuronal 2 \(régimen\)/.test(t));
  chequear("una señal de instrumento dice su dirección", /^XLK: señal alcista\./.test(ui("XLK subió 0.3 puntos porcentuales estimados. Riesgo bajo (0.3).")));
}

console.log(`\n${falla ? "FALLA" : "PASA"} — el chat y el portafolio del usuario  (${ok + falla} checks, ${falla} fallas)`);
process.exit(falla ? 1 : 0);
