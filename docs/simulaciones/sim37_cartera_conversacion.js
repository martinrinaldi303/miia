#!/usr/bin/env node
/**
 * sim37_cartera_conversacion.js — armar la cartera como una conversación
 * (4-nov-2026).
 *
 * El 4-nov el chat armaba la cartera con un formulario: «Respondé 1, 2 o 3»,
 * no entendía «agrecivo», no aceptaba «agresivo con 10000» de una, y mostraba
 * 6 activos al 3 % (sumaban 18 %). Esta prueba corre conversaciones ENTERAS
 * contra la decisión real (chat_perfil.decidir + chat_router.clasificar), sin
 * levantar nada.
 *
 *   node docs/simulaciones/sim37_cartera_conversacion.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const R = await import("../../scripts/chat_router.js");
const P = await import("../../scripts/chat_perfil.js");
const U = await import("../../scripts/universo.js");
const leer = p => fs.readFileSync(path.join(RAIZ, p), "utf8").replace(/\r\n/g, "\n");

let ok = 0, falla = 0;
function chequear(nombre, cond, nota = "") {
  if (cond) { ok++; console.log(`   [ok]    ${nombre.padEnd(66)} ${nota}`); }
  else { falla++; console.log(`   [NO]    ${nombre.padEnd(66)} ${nota}`); }
}
const OP = { universo: U.TICKERS, reconocidos: U.TICKERS_TEXTO };

/** Corre una conversación y devuelve la acción de cada turno. */
function charla(mensajes, sesion = {}) {
  let t = Date.parse("2026-11-04T18:00:00Z");
  return mensajes.map(m => {
    const it = R.clasificar(m, { ...OP, previo: sesion.chatPrevio || null });
    const d = P.decidir(sesion, m, it, t);
    if (d.accion === "armar") { sesion.carteraTs = t; sesion.chatPrevio = { intencion: "mi_portfolio", tickers: [] }; }
    t += 60_000;
    return { m, accion: d.accion, intencion: it.intencion, perfil: sesion.perfil || null, capital: sesion.capital?.num || null };
  });
}
const pasos = c => c.map(x => x.accion).join(" → ");

// ── 1 ──
console.log("\n1 · Entender perfil y capital como los escribe la gente");
for (const [t, perfil, capital] of [
  ["agrecivo", "agresivo", null], ["agresivo", "agresivo", null], ["Agresibo", "agresivo", null],
  ["consevador", "conservador", null], ["moderdo", "moderado", null],
  ["agresivo con 10000", "agresivo", 10000], ["10000", null, 10000], ["10 mil dólares", null, 10000],
  ["moderado, 5.000 usd", "moderado", 5000], ["100.000 pesos", null, 100000], ["1,5M", null, 1500000],
  ["10k", null, 10000], ["quiero ir a fondo", "agresivo", null], ["no quiero arriesgar mucho", "conservador", null],
  ["algo de riesgo", "moderado", null], ["la 2", "moderado", null], ["3", "agresivo", null],
  ["tengo 3 hijos", null, null], ["hola", null, null],
]) {
  const e = P.entender(t);
  chequear(`«${t}»`, e.perfil === perfil && (e.capital?.num ?? null) === capital,
           `→ ${e.perfil || "-"} · ${e.capital?.texto || "-"}`);
}
chequear("la moneda se reconoce", P.extraerCapital("100.000 pesos").moneda === "ARS" && P.extraerCapital("5000 usd").moneda === "USD");
chequear("«no sé» como capital se entiende", P.entender("no sé").sinCapital === true);

// ── 2 ──
console.log("\n2 · Conversaciones enteras");
let c = charla(["mi portafolio actual sirve para el reguimen de mercado ?"], { paso: "esperando_perfil" });
c = charla(["armame un portfolio", "agrecivo", "10000"]);
console.log(`        ${pasos(c)}`);
chequear("la de la captura del 4-nov: «agrecivo» arma la cartera al toque", c[0].accion === "preguntar" && c[1].accion === "armar" && c[1].perfil === "agresivo");
chequear("y «10000» después ajusta la cartera con montos (no repregunta)", c[2].accion === "armar" && c[2].capital === 10000);
c = charla(["armame un portfolio agresivo de 5000"]);
chequear("todo en un mensaje: arma directo", c[0].accion === "armar" && c[0].perfil === "agresivo" && c[0].capital === 5000, pasos(c));
c = charla(["agresivo con 10 mil dólares"]);
chequear("«agresivo con 10 mil dólares» suelto también arma", c[0].accion === "armar" && c[0].capital === 10000, pasos(c));
c = charla(["quiero invertir", "tengo 20000 usd", "moderado"]);
chequear("primero la plata y después el perfil: pregunta sólo lo que falta", pasos(c) === "preguntar → preguntar → armar" && c[2].capital === 20000, pasos(c));
c = charla(["armame un portfolio", "mmm no sé bien", "moderado"]);
chequear("si no entiende, repregunta distinto y no tira el menú", c[1].accion === "repreguntar" && c[2].accion === "armar", pasos(c));
c = charla(["armame un portfolio", "¿qué es un ETF?"]);
chequear("si cambia de tema, se contesta lo nuevo", c[1].accion === "nada", pasos(c));
c = charla(["armame un portfolio", "moderado", "pasala a conservador"]);
chequear("recién armada, «pasala a conservador» la ajusta", c[2].accion === "armar" && c[2].perfil === "conservador", pasos(c));
c = charla(["armame un portfolio"], { perfil: "moderado" });
chequear("si ya sabe el perfil (memoria), no lo vuelve a preguntar", c[0].accion === "armar", pasos(c));
c = charla(["¿cómo está el mercado?", "¿qué opinás de XLK?"]);
chequear("las preguntas que no son de cartera siguen su camino", c.every(x => x.accion === "nada"), pasos(c));

// ── 3 ──
console.log("\n3 · La cartera: pesos que suman 100 y montos");
const act = Array.from({ length: 31 }, (_, i) => ({ symbol: `T${i}`, sector: "Technology", riesgo_pct: 20 + i, cambio_pct: (i % 7) - 3 }));
for (const perfil of ["conservador", "moderado", "agresivo"]) {
  const k = P.armarCartera(act, perfil, P.extraerCapital("10000"));
  const suma = k.reduce((s, a) => s + a.peso_pct, 0), plata = k.reduce((s, a) => s + a.monto, 0);
  chequear(`${perfil}: ${k.length} activos, pesos suman 100 y montos suman el capital`, suma === 100 && Math.abs(plata - 10000) < 0.01, `${suma}% · $${plata}`);
}
const cons = P.armarCartera(act, "conservador"), agr = P.armarCartera(act, "agresivo");
chequear("conservador elige los de menor riesgo", cons.every(a => a.riesgo_pct <= 24));
chequear("agresivo elige los de más impulso", agr.every(a => a.cambio_pct >= 2));
chequear("sin activos no inventa cartera", P.armarCartera([], "moderado").length === 0);

// ── 4 ──
console.log("\n4 · Los textos");
const cap = P.extraerCapital("10 mil usd");
const t1 = P.redactarCartera(P.armarCartera(act, "agresivo", cap), { perfil: "agresivo", capital: cap, riesgoCartera: 40, riesgoGlobal: 0.73, semilla: "a" });
console.log(`        «${t1}»`);
chequear("trae los montos de cada activo", /US\$ 1\.700/.test(t1));
chequear("no trae las plantillas viejas", !/Respondé 1|tolerancia al riesgo|1️⃣/.test(t1));
const preg = P.preguntarPerfil({ semilla: "b" });
console.log(`        «${preg}»`);
chequear("la pregunta muestra ejemplos, no un menú 1-2-3", /por ejemplo|«/.test(preg) && !/Respondé 1|1️⃣/.test(preg));
chequear("la pregunta empieza con mayúscula", /^[A-ZÁÉÍÓÚÑ¿]/.test(preg));
chequear("varía entre mensajes", new Set(["a", "b", "c", "d", "e", "f"].map(s => P.preguntarPerfil({ semilla: s }))).size >= 2);
const rep = P.repreguntar("mmm no sé bien", { semilla: "x" });
chequear("repreguntar no es el menú viejo", !/Respondé 1/.test(rep));
const t2 = P.redactarCartera(P.armarCartera(act, "moderado"), { perfil: "moderado", semilla: "c" });
chequear("sin capital, ofrece pasarla a montos", /capital|cuánto/.test(t2));

// ── 4b ──
console.log("\n4b · Palabras que NO son un perfil (5-nov-2026)");
// «seguí» estaba a 2 letras de «seguro» → conservador; con una cartera recién
// armada, «dale, seguí» la REARMABA. «medios», «usado», «jugar» igual.
for (const f of ["dale, seguí", "sí, seguro", "seguir", "lo leí en los medios", "un auto usado", "quiero jugar", "observador"]) {
  chequear(`«${f}» no es un perfil`, P.extraerPerfil(f) === null, `→ ${P.extraerPerfil(f)}`);
}
chequear("«algo seguro» sí es conservador", P.extraerPerfil("quiero algo seguro") === "conservador");
chequear("«en el medio» sigue siendo moderado", P.extraerPerfil("en el medio") === "moderado");
chequear("«el 2026» es un año, no un capital", P.extraerCapital("¿cómo cierra el 2026?") === null);
chequear("«2000 dólares» sigue siendo capital", P.extraerCapital("2000 dolares")?.num === 2000);
const sR = {};
const hR = charla(["armame un portafolio agresivo con 10 mil dolares", "dale, seguí", "sí, seguro"], sR);
chequear("después de la cartera, «dale, seguí» no la rearma", hR[1].accion !== "armar", `→ ${hR[1].accion}`);
chequear("«sí, seguro» tampoco la pasa a conservador", hR[2].accion !== "armar" && sR.perfil === "agresivo", `perfil ${sR.perfil}`);
const sinP = P.preguntarPerfil({ semilla: "a", contexto: "sin_portfolio",
  regimen: { etiqueta: "alcista", positivos: 35, n: 50, media: 0.4, riesgo: 0.69, enRueda: true } });
console.log(`        «${sinP}»`);
chequear("sin cartera guardada: sin el «Dale.» suelto", !/\bDale\b/.test(sinP));
chequear("sin cartera guardada: contesta el régimen con datos", /se lee alcista/.test(sinP) && /35 de 50/.test(sinP));
chequear("sin cartera guardada: pide el perfil con ejemplos", /«/.test(sinP));
chequear("la cartera nueva puede decir que la anterior no estaba",
  /^No encontré/.test(P.redactarCartera(P.armarCartera(act, "moderado"), { perfil: "moderado", semilla: "c", intro: "No encontré la anterior." })));

// ── 4c ──
console.log("\n4c · La captura del 6-nov: «perfil mixto», «ariesgo mucho» y la pregunta repetida");
const s6 = {};
const h6 = charla(["arme un portafolio de invercion 50 mil dolares  de perfil mixto"], s6);
chequear("«perfil mixto» con 50 mil: arma de una, moderado", h6[0].accion === "armar" && s6.perfil === "moderado" && s6.capital?.num === 50000,
  `${pasos(h6)} · ${s6.perfil} · ${s6.capital?.num}`);
const s6b = {};
const h6b = charla(["armame un portafolio", "ariesgo mucho"], s6b);
chequear("esperando el perfil, «ariesgo mucho» es agresivo (no el riesgo del mercado)",
  h6b[1].accion === "armar" && s6b.perfil === "agresivo", `${pasos(h6b)} · ${s6b.perfil}`);
for (const [f, p] of [["arriesgo mucho", "agresivo"], ["me arriesgo poco", "conservador"], ["arriesgo un poco", "moderado"],
                      ["no me arriesgo", "conservador"], ["me la juego", "agresivo"], ["mixta", "moderado"]]) {
  chequear(`«${f}» → ${p}`, P.extraerPerfil(f) === p, `→ ${P.extraerPerfil(f)}`);
}
for (const f of ["los mismos de siempre", "el banco central", "los textos", "combinar sectores", "¿cuál es el riesgo?"]) {
  chequear(`«${f}» no es un perfil`, P.extraerPerfil(f) === null, `→ ${P.extraerPerfil(f)}`);
}
const q1 = P.preguntarPerfil({ semilla: "q", capital: { texto: "US$ 50.000" } });
let repite = 0;
for (let i = 0; i < 30; i++) if (P.preguntarPerfil({ semilla: "q" + i, capital: { texto: "US$ 50.000" }, evitar: q1 }) === q1) repite++;
chequear("si la vuelve a pedir, no repite la misma frase", repite === 0, `${repite} de 30`);

// ── 5 ──
console.log("\n5 · Guardas de regresión");
const c25 = leer("scripts/class25B.js");
chequear("class25B decide con chat_perfil.decidir", /decidirCartera\(sesion, texto, it\)/.test(c25));
chequear("el router ya no cae al formulario viejo (return false para portfolio)", !/if \(!sesion\.perfil\) return false;/.test(c25));
const web = leer("scripts/publi_src/index.html");
chequear("el panel muestra el monto de cada activo", /a\.monto != null/.test(web));

// ── 8 · Armado automático o manual, y el plazo (13-nov-2026) ─────────────
console.log("\n8 · ¿Lo armo yo o lo armás vos? Y el plazo que define cuándo revisarlo");
{
  const A = await import("../../scripts/chat_armado.js");
  const MP = await import("../../scripts/chat_portfolio.js");
  const OPr = { universo: U.TICKERS, reconocidos: U.TICKERS_TEXTO };
  const paso = (s, t) => A.decidirArmado(s, t, R.clasificar(t, OPr), { universo: U.TICKERS });

  const s1 = {};
  chequear("«armame un portafolio» → MIIA pregunta el modo (IA o vos)", paso(s1, "armame un portafolio").accion === "preguntar_modo" && s1.paso === "esperando_modo");
  chequear("la pregunta ofrece las DOS opciones", /A\).*IA|automático/.test(A.preguntarModo({ semilla: "x" })) && /B\)/.test(A.preguntarModo({ semilla: "x" })));
  chequear("«lo armo yo» → pide los ETFs", paso(s1, "lo armo yo").accion === "preguntar_activos" && s1.paso === "esperando_activos");
  const m = paso(s1, "SPY 50, QQQ 30 y EWZ 20");
  chequear("«SPY 50, QQQ 30 y EWZ 20» → arma a mano con esos pesos", m.accion === "armar_manual"
    && m.activos.map(a => `${a.symbol}${a.peso_pct}`).join() === "SPY50,QQQ30,EWZ20", JSON.stringify(m.activos));
  const sinPeso = A.entenderActivos("XLK XLV GDX", U.TICKERS);
  chequear("sin porcentajes reparte parejo y suma 100", sinPeso.activos.reduce((x, a) => x + a.peso_pct, 0) === 100 && sinPeso.activos.length === 3);
  const parcial = A.entenderActivos("SPY 60 QQQ EWZ", U.TICKERS);
  chequear("con un peso y dos sin peso, el resto se reparte (60/20/20)", parcial.activos.map(a => a.peso_pct).join() === "60,20,20");
  const fuera = A.entenderActivos("SPY 50 NVDA 50", U.TICKERS);
  chequear("un ticker que no mido queda afuera y se avisa", fuera.activos.length === 1 && fuera.fuera.includes("NVDA"));
  chequear("«quiero un portfolio con XLK y XLV» arma a mano aunque el router lo lea como opinión",
    paso({}, "Quiero un portfolio con XLK y XLV").accion === "armar_manual");

  // 13-nov-2026: una PREGUNTA sobre la cartera que ya tiene no la reemplaza.
  // Antes cada una de estas pisaba la cartera guardada con «XLK 100 %» (o el
  // ticker nombrado) y la escribía en state/.
  for (const f of ["¿Conviene sacar XLK de mi cartera?", "¿Cómo va XLK en mi cartera?", "¿Qué peso tiene SPY en mi portafolio?",
                   "¿EWZ le suma riesgo a mi cartera?", "¿debería agregar ARGT a mi portfolio?", "comparar mi cartera con SPY"]) {
    const r = paso({}, f);
    chequear(`«${f}» NO arma una cartera nueva`, r.accion !== "armar_manual", r.accion);
  }
  chequear("«mi cartera es SPY 60 y QQQ 40» sí la guarda (pesos que suman 100)", paso({}, "mi cartera es SPY 60 y QQQ 40").accion === "armar_manual");
  chequear("«quiero armar mi cartera con XLK y XLV» sí arma", paso({}, "quiero armar mi cartera con XLK y XLV").accion === "armar_manual");
  chequear("esperando el modo, «¿qué opinás de XLK?» es otra pregunta, no una cartera de XLK",
    paso({ paso: "esperando_modo" }, "¿qué opinás de XLK?").accion === "nada");
  chequear("esperando la lista, un ticker solo («XLK») sí vale", paso({ paso: "esperando_activos" }, "XLK").accion === "armar_manual");
  chequear("esperando la lista, «¿qué es XLK?» no arma", paso({ paso: "esperando_activos" }, "¿qué es XLK?").accion !== "armar_manual");
  chequear("«sin EWZ» no mete EWZ en la cartera", !A.entenderActivos("XLK y XLV sin EWZ", U.TICKERS).activos.some(a => a.symbol === "EWZ"));
  chequear("palabras comunes no se avisan como «afuera» (antes: «ARMAR, UNA»)",
    A.entenderActivos("quiero armar una cartera con XLK y XLV", U.TICKERS).fuera.length === 0);

  const s2 = {};
  paso(s2, "armame un portafolio");
  chequear("«automático» → sigue el armado por IA de siempre", paso(s2, "automático").accion === "seguir_ia" && s2.modoArmado === "ia");
  chequear("la segunda vez no repregunta el modo", paso(s2, "armame un portafolio").accion === "seguir_ia");

  // Plazo y umbral
  for (const [t, pl] of [["a largo plazo", "largo"], ["unas semanas", "corto"], ["un mes", "medio"], ["3", "largo"], ["1", "corto"], ["por un año", "largo"]]) {
    chequear(`«${t}» → plazo ${pl}`, A.entenderPlazo(t) === pl, String(A.entenderPlazo(t)));
  }
  chequear("«avisame si más del 25% está en venta» → umbral 0,25", A.entenderUmbral("avisame si más del 25% está en venta") === 0.25);
  chequear("un % sin contexto de aviso NO es un umbral («subió 3%»)", A.entenderUmbral("subió 3%") === null);
  const s3 = { paso: "esperando_plazo" };
  const c = paso(s3, "a largo plazo");
  chequear("tras armar, «a largo plazo» guarda la config", c.accion === "config" && c.config.plazo === "largo" && s3.paso === null);
  chequear("si no contesta el plazo, sigue la charla (no se traba)", paso({ paso: "esperando_plazo" }, "que opinas de XLK?").accion === "nada");
  chequear("después se puede cambiar: «pasá mi portafolio a corto plazo»", paso({}, "pasá mi portafolio a corto plazo").config?.plazo === "corto");
  chequear("los umbrales por plazo: corto 30 % · medio 40 % · largo 60 %",
    A.umbralesPara({ plazo: "corto" }).contraCambiar === 0.3 && A.umbralesPara(null).contraCambiar === 0.4 && A.umbralesPara({ plazo: "largo" }).contraCambiar === 0.6);
  chequear("un umbral propio pisa el del plazo y el «esperá» queda a la mitad",
    A.umbralesPara({ plazo: "largo", contraCambiar: 0.3 }).contraCambiar === 0.3 && A.umbralesPara({ contraCambiar: 0.3 }).contraEsperar === 0.15);
  chequear("la config basura del disco se descarta", A.normalizarConfig({ plazo: "eterno", contraCambiar: 7 }) === null);

  // El mismo portafolio con 45 % en venta: corto → cambiar, largo → esperar.
  const port = { perfil: "moderado", activos: [{ symbol: "XLK", peso_pct: 45 }, { symbol: "XLV", peso_pct: 55 }] };
  const ev = { hayDatos: true, cobertura: 2, wContra: 0.45, wFavor: 0, encaje: "desalineado", enContra: [{ symbol: "XLK", w: 0.45 }], vol: 15, relativo: -0.5 };
  const vC = MP.veredictoPortfolio(port, ev, { rk: {}, cotiz: {}, inst: {} }, A.umbralesPara({ plazo: "corto" }));
  const vL = MP.veredictoPortfolio(port, ev, { rk: {}, cotiz: {}, inst: {} }, A.umbralesPara({ plazo: "largo" }));
  chequear("mismo portafolio: plazo corto → CAMBIAR, plazo largo → ESPERAR", vC.decision === "cambiar" && vL.decision === "esperar", `${vC.decision}/${vL.decision}`);
  chequear("el texto del veredicto dice con qué plazo se midió", /tu plazo largo/.test(MP.textoVeredicto(vL)));
  chequear("la confirmación dice el umbral en números", /60%/.test(A.confirmarConfig({ plazo: "largo" }, { semilla: "a" })));

  const c25 = leer("scripts/class25B.js");
  chequear("class25B corre el armado ANTES del flujo de perfil", c25.indexOf("decidirArmado(sesion, texto, it") < c25.indexOf("decidirCartera(sesion, texto, it)"));
  chequear("class25B guarda la config por usuario en state/ (sobrevive a reinicios)", c25.includes("config: e.config || null") && c25.includes("config: normalizarConfig(f.config)"));
  chequear("la copia de la web (sin config) no borra la config guardada", c25.includes("config: prev?.config || null"));

  // 16-nov-2026 (probado en vivo en miiaia.com): con el menú A/B abierto,
  // «¿Debería vender todo?» y «¿Quién gana el Mundial?» recibían el menú otra vez,
  // y «Armame un portafolio, soy moderado con 10000» también, aunque ya decía el perfil.
  const pasoP = (s, t) => A.decidirArmado(s, t, R.clasificar(t, OPr), { universo: U.TICKERS, perfilDicho: !!P.entender(t).perfil });
  const sM = {};
  chequear("«armame…, soy moderado con 10000» lo arma MIIA, sin el menú A/B",
    pasoP(sM, "Armame un portafolio, soy moderado con 10000").accion === "seguir_ia");
  const sV = {}; pasoP(sV, "Armame un portafolio");
  chequear("con el menú abierto, «¿Debería vender todo?» cierra el menú", pasoP(sV, "¿Debería vender todo?").accion === "nada" && !sV.paso);
  const sW = {}; pasoP(sW, "Armame un portafolio");
  chequear("con el menú abierto, «¿Quién creés que gana el próximo Mundial?» cierra el menú",
    pasoP(sW, "¿Quién creés que gana el próximo Mundial?").accion === "nada" && !sW.paso);
  const sX = {}; pasoP(sX, "Armame un portafolio");
  chequear("contestar el menú con el perfil («moderado») es elegir que lo arme MIIA", pasoP(sX, "moderado").accion === "seguir_ia");
  const sY = {}; pasoP(sY, "Armame un portafolio");
  chequear("«automático…, armalo vos con lo que veas mejor» sigue siendo la opción A",
    pasoP(sY, "automático por favor, armalo vos con lo que veas mejor").accion === "seguir_ia");
  const sZ = {}; pasoP(sZ, "Armame un portafolio");
  const z1 = pasoP(sZ, "mmm").accion, z2 = pasoP(sZ, "eh").accion;
  chequear("el menú se repregunta UNA vez; a la segunda sigue la charla", z1 === "preguntar_modo" && z2 === "nada" && !sZ.paso, `${z1}/${z2}`);
  const sB = {}; pasoP(sB, "Armame un portafolio");
  chequear("«la b» sigue abriendo el armado manual", pasoP(sB, "la b").accion === "preguntar_activos");
  chequear("class25B le pasa a decidirArmado si el mensaje ya trae el perfil", c25.includes("perfilDicho: !!entenderPerfilCapital(texto).perfil"));
}

console.log(`\n${falla ? "FALLA" : "PASA"} — la cartera como conversación  (${ok + falla} checks, ${falla} fallas)`);
process.exit(falla ? 1 : 0);
