#!/usr/bin/env node
/**
 * sim35_chat_intenciones.js — el router de intenciones del chat (2-nov-2026).
 *
 * Prueba en frío de los tres módulos puros que reemplazan a las plantillas del
 * chat —chat_router.js, chat_evidencia.js, chat_redactor.js— y de cómo están
 * enchufados en class25B. No levanta nada: ni Redis, ni MySQL, ni Ollama.
 *
 *   1. El router entiende lo que de verdad escribe la gente (las frases de las
 *      capturas del 2-nov y las del «punto 10»), los alias en castellano y el
 *      hilo de la charla («¿y el riesgo?», «dale»).
 *   2. El calendario del NYSE (feriados, medias ruedas, horario de verano).
 *   3. La evidencia: zonas del ranking, agregados, patrones y la guarda
 *      anti-inflado de la tasa de acierto.
 *   4. El redactor: cada respuesta trae datos del sistema, no repite las
 *      plantillas viejas, no aconseja, varía entre mensajes y es reproducible.
 *   5. La validación de lo que escribe el motor de lenguaje.
 *   6. Guardas de regresión sobre class25B.
 *   7. El presupuesto de latencia del prompt local CON hechos.
 *
 *   node docs/simulaciones/sim35_chat_intenciones.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const S = p => path.join(RAIZ, "scripts", p);
// Especificadores RELATIVOS, como sim32: un "file://C:/…" armado a mano falla en
// Windows (Node lee "C:" como host), y esta prueba corre en la PC como compuerta
// del deploy.
const R = await import("../../scripts/chat_router.js");
const E = await import("../../scripts/chat_evidencia.js");
const D = await import("../../scripts/chat_redactor.js");
const U = await import("../../scripts/universo.js");
// En Windows los .js se bajan con CRLF (sólo *.sh tiene eol=lf): se normaliza
// antes de buscar texto, o las guardas fallarían por el \r y no por el código.
const leer = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

let ok = 0, falla = 0;
function chequear(nombre, cond, nota = "") {
  if (cond) { ok++; console.log(`   [ok]    ${nombre.padEnd(62)} ${nota}`); }
  else { falla++; console.log(`   [NO]    ${nombre.padEnd(62)} ${nota}`); }
}
function seccion(t) { console.log(`\n${t}`); }

const OP = { universo: U.TICKERS, reconocidos: U.TICKERS_TEXTO };
const cl = (t, extra = {}) => R.clasificar(t, { ...OP, ...extra });

// ── 1 ────────────────────────────────────────────────────────────────────
seccion("1 · El router entiende lo que escribe la gente");
const CASOS = [
  // [frase, intención, tickers esperados (o null), grupo esperado (o null), extra]
  ["Como podes hablar ?", "identidad", [], null, { subtipo: "como_funciona" }],
  ["Que podes responder ?", "capacidades", [], null],
  ["¿Quién es tu creador?", "identidad", [], null],
  ["¿sos de google?", "identidad", [], null, { subtipo: "proveedor" }],
  ["¿Qué opinás de US?", "opinion", [], "Estados Unidos"],
  ["¿Ves algún patrón?", "patron", [], null],
  ["Hola", "saludo", [], null],
  ["Hola MIIA, ¿qué opinás de XLK?", "opinion", ["XLK"], null],
  ["gracias!", "gracias", [], null],
  ["no", "negar", [], null],
  ["¿El mercado está abierto?", "mercado_abierto", [], null],
  ["¿hoy hay rueda?", "mercado_abierto", [], null],
  ["¿cuál es tu tasa de acierto?", "acierto", [], null],
  ["taza de asierto?", "acierto", [], null],                 // typo c/s — el usuario escribe así
  ["y cómo se comporta el tuyo?", "acierto", [], null],      // «el tuyo» = tu backtesting
  ["¿cómo te fue con las predicciones?", "acierto", [], null],
  ["¿cómo puedo saber si te equivocás o no?", "acierto", [], null],
  ["¿qué es un ETF?", "concepto", [], null, { concepto: "etf" }],
  ["¿qué es XLK?", "opinion", ["XLK"], null, { subtipo: "que_es" }],
  ["XLK o XLF?", "comparar", ["XLF", "XLK"], null],
  ["¿qué está subiendo?", "ranking", [], null, { direccion: "mejor" }],
  ["¿qué me recomendás comprar?", "ranking", [], null, { direccion: "mejor" }],
  ["¿cuál es el peor sector hoy?", "ranking", [], null, { direccion: "peor" }],
  ["mostrame el ranking", "ranking", [], null, { direccion: "ambos" }],
  ["¿por qué cae el mercado?", "porque", [], null],
  ["¿cómo está el mercado?", "resumen", [], null],
  ["¿conviene invertir ahora?", "resumen", [], null, { subtipo: "conviene" }],
  ["¿qué opinás de bitcoin?", "fuera_universo", [], null],
  ["riesgo de XLK", "riesgo", ["XLK"], null],
  ["precio de SPY", "precio", ["SPY"], null],
  ["noticias de Argentina", "noticias", [], "Argentina"],
  ["¿la fed va a bajar tasas?", "libre", [], null, { subtipo: "tema" }],
  ["que tal tecnología?", "opinion", [], "tecnología"],
  ["¿qué pasa con los bancos regionales?", "opinion", [], "los bancos regionales"],
  ["armame un portfolio", "portfolio", [], null],
  ["¿estamos en un mercado bajista?", "regimen", [], null],
  ["explicame por qué XLE", "porque", ["XLE"], null],
  ["VOO o QQQ", "comparar", ["QQQ", "SPY"], null],
  ["¿qué de Latinoamérica está más fuerte?", "ranking", [], "Latinoamérica", { direccion: "mejor" }],
];
for (const [frase, intencion, tks, grupo, extra = {}] of CASOS) {
  const r = cl(frase);
  const tOk = tks == null || JSON.stringify([...r.tickers].sort()) === JSON.stringify([...tks].sort());
  const gOk = grupo == null ? true : r.grupo?.etiqueta === grupo;
  const xOk = Object.entries(extra).every(([k, v]) => r[k] === v);
  chequear(`«${frase}»`, r.intencion === intencion && tOk && gOk && xOk,
    `→ ${r.intencion}${r.tickers.length ? " " + r.tickers.join(",") : ""}${r.grupo ? " · " + r.grupo.etiqueta : ""}`);
}
chequear("«buen dia» NO dispara el ticker DIA", cl("buen dia").intencion === "saludo" && !cl("buen dia que tal").tickers.includes("DIA"));
chequear("«el uso del dinero» NO dispara USO", !JSON.stringify(cl("el uso del dinero").fuera).includes("USO"));
chequear("«DIA» en mayúsculas SÍ es el Dow", cl("¿qué opinás de DIA?").tickers.includes("DIA"));

const prev = { intencion: "opinion", tickers: ["XLK"] };
const h1 = cl("¿y el riesgo?", { previo: prev });
chequear("«¿y el riesgo?» hereda XLK", h1.intencion === "riesgo" && h1.tickers[0] === "XLK" && h1.heredado);
const h2 = cl("¿por qué?", { previo: prev });
chequear("«¿por qué?» hereda XLK", h2.intencion === "porque" && h2.tickers[0] === "XLK");
const h3 = cl("¿y XLF?", { previo: { intencion: "riesgo", tickers: ["XLK"] } });
chequear("«¿y XLF?» repite la pregunta anterior (riesgo) con XLF", h3.intencion === "riesgo" && h3.tickers[0] === "XLF");
const h4 = cl("y comparado con QQQ?", { previo: prev });
chequear("«y comparado con QQQ?» compara con lo anterior", h4.intencion === "comparar" && h4.tickers.includes("XLK") && h4.tickers.includes("QQQ"));
const h5 = cl("dale", { previo: prev, oferta: { intencion: "comparar", tickers: ["XLK", "SPY"] } });
chequear("«dale» ejecuta la propuesta de MIIA", h5.intencion === "seguir" && h5.destino?.intencion === "comparar");
const h6 = cl("contame más", { previo: prev });
chequear("«contame más» amplía con información NUEVA (opinión → porqué)", h6.destino?.intencion === "porque" && h6.destino?.detalle === 2);
const h7 = cl("dale", { previo: { intencion: "identidad" } });
chequear("«dale» después de la presentación no la repite", h7.subtipo === "sin_tema");

const pres = cl("Soy Martín");
chequear("«Soy Martín» es una presentación, no una pregunta al motor", pres.intencion === "presentacion" && pres.nombre === "Martín",
  "antes contestaba «No tengo un dato propio sobre eso»");
chequear("«Soy Martín, ¿qué opinás de XLK?» igual contesta la pregunta", cl("Soy Martín, ¿qué opinás de XLK?").intencion === "opinion");

const NOMBRES = [["Hola", null], ["Gracias", null], ["soy nuevo", null], ["Soy Conservador", null],
                 ["me llamo martin", "Martin"], ["Soy Martín", "Martín"], ["mi nombre es Ana López", "Ana López"]];
for (const [t, esp] of NOMBRES) chequear(`nombre: «${t}» → ${esp}`, R.detectarNombre(t) === esp,
  esp == null ? "antes se guardaba en users.name" : "");

// ── 2 ────────────────────────────────────────────────────────────────────
seccion("2 · Calendario del NYSE");
const CAL = [
  ["2026-11-02T15:00:00Z", true, "rueda normal", "11:30"],
  ["2026-11-02T14:00:00Z", false, "todavía no abrió", "11:30"],
  ["2026-11-02T21:30:00Z", false, "ya cerró", "11:30"],
  ["2026-10-31T15:00:00Z", false, "fin de semana", "10:30"],   // todavía horario de verano de EE.UU.
  ["2026-11-26T15:00:00Z", false, "feriado", "11:30"],          // Thanksgiving
  ["2026-11-27T17:30:00Z", true, "media rueda", "11:30"],
  ["2026-11-27T19:00:00Z", false, "ya cerró", "11:30"],
  ["2027-03-26T15:00:00Z", false, "feriado", "10:30"],          // Viernes Santo
];
for (const [iso, abierto, motivo, abreAR] of CAL) {
  const e = E.estadoNYSE(new Date(iso));
  chequear(`${iso} → ${motivo}`, e.abierto === abierto && e.motivo === motivo && e.aperturaAR === abreAR,
    `NY ${e.horaNY} · AR ${e.horaAR} · abre AR ${e.aperturaAR}`);
}
{
  // El respaldo sin Intl (Node con ICU recortado) tiene que dar la MISMA hora de
  // Nueva York que Intl, hora por hora, dos años enteros (cambios de horario incluidos).
  let distintas = 0, n = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 3600000) {
    const a = E._test._partesNYIntl(new Date(t)), b = E._test._partesNYSinIntl(new Date(t));
    n++; if (a.iso !== b.iso || a.h !== b.h || a.mi !== b.mi || a.off !== b.off) distintas++;
  }
  chequear("el respaldo sin Intl coincide con Intl hora por hora (2026-2027)", distintas === 0, `${n} horas, ${distintas} distintas`);
}
chequear("después del cierre del viernes, abre «el lunes»",
  E.estadoNYSE(new Date("2026-11-06T22:00:00Z")).proxima?.etiqueta === "el lunes");

// ── Panel sintético ──────────────────────────────────────────────────────
let s = 11; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
const AHORA = Date.parse("2026-11-02T17:40:00Z");
const DEF = ["XLU", "XLP", "XLV", "USMV"], CIC = ["XLY", "XLI", "XLF", "XLB", "IWM", "XLK"];
const cot = {}, rk = {};
for (const t of U.TICKERS) {
  const c = rnd() * 3 - 1.5;
  cot[t] = { cambio: DEF.includes(t) ? c / 3 + 1.5 : CIC.includes(t) ? c / 3 - 1.2 : c, precio: 20 + rnd() * 300, ts: AHORA - 60000 };
}
const orden = [...U.TICKERS].sort(() => rnd() - 0.5);
orden.forEach((t, i) => { rk[t] = { senal: i < 8 ? "BUY" : i >= 42 ? "SELL" : "HOLD", puesto: i, n: 50, k: 8, conf: 0.9, ts: AHORA - 90000 }; });
const RAW = {
  ahora: AHORA, instrumentos: U.INSTRUMENTOS, cotizaciones: cot, ranking: rk, riesgo: 0.72,
  amplitud: Array.from({ length: 20 }, (_, i) => ({ ts: AHORA - (20 - i) * 300000, positivos: 33 - i, n: 50, media: 0 })),
  sentimiento: { XLK: { sentiment_label: "BULLISH", n_articulos: 8 } },
  riesgoActivo: { XLK: { vol_pct: 17.2, drawdown_pct: 6.1, riesgo_vol_pct: 33 } },
  metricas: { accuracy_directional: 54.5, base_rate: 51.9, edge_vs_baseline: 2.6, edge_significativo: false, edge_min_detectable: 5.6, n_efectivo: 295 },
  mercado: E.estadoNYSE(new Date(AHORA)), nombre: "Martín",
};
const P = E.armarPanel(RAW);

// ── 3 ────────────────────────────────────────────────────────────────────
seccion("3 · La evidencia");
const top = orden[0], fondo = orden[49], medio = orden[25];
chequear("el 1° del ranking queda en zona «arriba»", E.vistaTicker(top, P).rank.zona === "arriba" && E.vistaTicker(top, P).rank.puesto === 1);
chequear("el último queda en zona «abajo»", E.vistaTicker(fondo, P).rank.zona === "abajo");
chequear("el del medio queda en zona «medio»", E.vistaTicker(medio, P).rank.zona === "medio");
const hoy = E.agregadoHoy(P);
chequear("agregado del día sobre los 50", hoy.n === 50 && hoy.positivos + hoy.negativos <= 50);
chequear("el relativo es cambio − promedio", Math.abs(E.vistaTicker("XLK", P).hoy.relativo - (cot.XLK.cambio - hoy.media)) < 1e-9);
const pts = E.patrones(P);
chequear("detecta la rotación hacia defensivos inyectada", pts.some(p => p.clave === "defensivos"), pts.map(p => p.clave).join(", "));
chequear("detecta la amplitud que se deteriora", pts.some(p => p.clave === "amplitud" && p.hasta < p.desde));
chequear("guarda anti-inflado: un acierto de 97 % se descarta", E.normalizarMetricas({ accuracy_directional: 97 }) === null,
  "el «97 %» de backtesting_stats no puede colarse");
chequear("un acierto de 52,7 % pasa", E.normalizarMetricas({ accuracy_directional: 52.7, base_rate: 51 })?.acc === 52.7);
const evUS = E.evidencia(cl("¿Qué opinás de US?"), P);
chequear("«¿qué opinás de US?» trae datos de SPY, QQQ, IWM y DIA", evUS.suficiente && evUS.datos.grupos[0].vistas.length === 4);
chequear("los hechos van acotados (≤ 8 líneas)", evUS.hechos.length <= 8);
const frio = E.armarPanel({ ahora: AHORA, instrumentos: U.INSTRUMENTOS, mercado: E.estadoNYSE(new Date(AHORA)) });
chequear("sin datos, la evidencia lo dice (suficiente = false)", E.evidencia(cl("¿qué opinás de XLK?"), frio).suficiente === false);

// ── 4 ────────────────────────────────────────────────────────────────────
seccion("4 · El redactor");
const VIEJAS = /(Soy MIIA, tu asistente|Acá MIIA, tu asistente|Con eso no tengo un dato preciso|recomiendo reducir exposición|Preguntame lo que quieras|stop-loss del 3%|Estoy procesando el mercado)/i;
const PROHIB = /\b(gemini|google|openai|chat ?gpt|gemma|ollama|class\d)/i;
const CONSEJO = /(te recomiendo (comprar|vender)|deber[ií]as (comprar|vender)|compr[aá] ya|es una buena compra)/i;
const PREGUNTAS = ["Hola", "Como podes hablar ?", "Que podes responder ?", "¿Qué opinás de US?", "¿Ves algún patrón?",
  "¿qué opinás de XLK?", "riesgo de XLK", "XLK o XLF?", "¿qué está subiendo?", "¿cuál es tu tasa de acierto?",
  "¿El mercado está abierto?", "¿qué es un ETF?", "¿qué opinás de bitcoin?", "¿la fed va a bajar tasas?",
  "¿cómo está el mercado?", "¿conviene invertir ahora?", "¿Quién es tu creador?", "gracias!", "precio de SPY",
  "¿estamos en un mercado bajista?", "mostrame el ranking", "¿por qué cae el mercado?", "¿qué opinás de Argentina?"];
const CON_DATO = new Set(["opinion", "patron", "riesgo", "comparar", "ranking", "acierto", "mercado_abierto", "resumen", "precio", "regimen", "porque", "libre"]);
let viejas = 0, prohib = 0, consejo = 0, vacias = 0, sinNumero = [];
for (const q of PREGUNTAS) {
  const it = cl(q);
  const r = D.redactar(it, E.evidencia(it, P), { semilla: q, nombre: "Martín" });
  if (!r.texto || r.texto.length < 15 || r.error) vacias++;
  if (VIEJAS.test(r.texto)) viejas++;
  if (PROHIB.test(r.texto)) prohib++;
  if (CONSEJO.test(r.texto)) consejo++;
  if (CON_DATO.has(it.intencion) && !/\d/.test(r.texto)) sinNumero.push(q);
}
chequear(`las ${PREGUNTAS.length} preguntas tienen respuesta, sin errores`, vacias === 0);
chequear("ninguna repite las plantillas viejas", viejas === 0, "«Soy MIIA, tu asistente…», «Con eso no tengo un dato preciso…»");
chequear("ninguna nombra un proveedor ni un módulo interno", prohib === 0);
chequear("ninguna aconseja comprar o vender", consejo === 0, "el «recomiendo reducir exposición» viejo era un consejo");
chequear("las de datos citan números del sistema", sinNumero.length === 0, sinNumero.join(" | "));

const rUS = D.redactar(cl("¿Qué opinás de US?"), evUS, { semilla: "x" }).texto;
chequear("«¿qué opinás de US?» nombra los cuatro y cita su promedio", ["SPY", "QQQ", "IWM", "DIA"].every(t => rUS.includes(t)) && /%/.test(rUS));
const itP = cl("¿Ves algún patrón?");
const rP = D.redactar(itP, E.evidencia(itP, P), { semilla: "x" }).texto;
chequear("«¿ves algún patrón?» describe la rotación con números", /defensiv/i.test(rP) && /%/.test(rP));
const itC = cl("Que podes responder ?");
const rC = D.redactar(itC, E.evidencia(itC, P), { semilla: "x" }).texto;
chequear("«¿qué podés responder?» ya no habla de ARGT sin motivo", !/ARGT/.test(rC) && /ranking/.test(rC));

const itSq = cl("Hola MIIA, ¿qué opinás de XLK?");
const rSq = D.redactar(itSq, E.evidencia(itSq, P), { semilla: "x", nombre: "Martín" }).texto;
chequear("saludo + pregunta: saluda y contesta con datos", /^¡(Hola|Buenas)/.test(rSq) && /XLK/.test(rSq) && /\d/.test(rSq));
const itPr = cl("Soy Martín");
chequear("la presentación saluda por el nombre", D.redactar(itPr, E.evidencia(itPr, P), { semilla: "x" }).texto.includes("Martín"));

const textos = new Set();
for (let i = 0; i < 6; i++) textos.add(D.redactar(cl("¿qué opinás de XLK?"), E.evidencia(cl("¿qué opinás de XLK?"), P), { semilla: "s" + i }).texto);
chequear("la misma pregunta no sale igual cada vez", textos.size >= 3, `${textos.size} redacciones distintas en 6`);
const a1 = D.redactar(cl("¿qué opinás de XLK?"), E.evidencia(cl("¿qué opinás de XLK?"), P), { semilla: "fija" }).texto;
const a2 = D.redactar(cl("¿qué opinás de XLK?"), E.evidencia(cl("¿qué opinás de XLK?"), P), { semilla: "fija" }).texto;
chequear("con la misma semilla es reproducible", a1 === a2);

// En frío no inventa números del mercado.
let inventa = 0;
for (const q of ["¿qué opinás de XLK?", "¿ves algún patrón?", "¿qué está subiendo?", "XLK o XLF?", "precio de SPY"]) {
  const it = cl(q);
  const t = D.redactar(it, E.evidencia(it, frio), { semilla: q }).texto;
  if (/[-+]\d+,\d%/.test(t)) inventa++;
}
chequear("sin datos no inventa cambios de precio", inventa === 0);

const t0 = Date.now();
for (let i = 0; i < 2000; i++) { const it = cl(PREGUNTAS[i % PREGUNTAS.length]); D.redactar(it, E.evidencia(it, P), { semilla: String(i) }); }
const ms = Date.now() - t0;
chequear("2.000 respuestas en menos de 3 s (no suma CPU)", ms < 3000, `${ms} ms, ${(ms / 2000).toFixed(2)} ms por respuesta`);

// ── 5 ────────────────────────────────────────────────────────────────────
seccion("5 · Validación de lo que escribe el motor de lenguaje");
const EV = { hechos: ["XLK (tecnología): puesto 3 de 50 en el ranking, señal BUY, confianza 91%.", "XLK hoy +1,2% (promedio de los 50: +0,3%)."],
             datos: { vistas: [{ tk: "XLK", rank: { senal: "BUY" } }] } };
const VAL = [
  ["XLK está tercero de 50 en el ranking, con 91% de confianza, y hoy sube 1,2%, mejor que el promedio.", true],
  ["Como modelo de lenguaje no tengo acceso a datos en tiempo real.", false, "evasiva"],
  ["XLK sube 4,5% hoy y está muy fuerte.", false, "número inventado"],
  ["Te recomiendo comprar XLK ya mismo, es una buena inversión.", false, "consejo"],
  ["Soy un modelo entrenado por Google.", false, "proveedor"],
  ["XLK va bien, al igual que QQQ que está fuerte.", false, "ticker sin datos"],
  ["XLK está en zona de venta, conviene vender.", false, "contradice la señal"],
  ["XLK está en el puesto 3 de", false, "cortada"],
];
for (const [t, esp, nota = ""] of VAL) {
  const v = E.validarRespuesta(t, EV, { tickers: U.TICKERS_TEXTO });
  chequear(`${esp ? "acepta" : "rechaza"}: «${t.slice(0, 48)}…»`, v.ok === esp, v.motivo || nota);
}

// ── 6 ────────────────────────────────────────────────────────────────────
seccion("6 · Guardas de regresión sobre class25B");
const c = leer(S("class25B.js"));
const _imp = m => 'from "./' + m + '"';   // partido: sim18 escanea imports literales
chequear("importa los tres módulos del router", ["chat_router.js", "chat_evidencia.js", "chat_redactor.js"].every(m => c.includes(_imp(m))));
chequear("el router viene PRENDIDO y se apaga sin recompilar",
  c.includes('String(process.env.CLASS25B_CHAT_ROUTER ?? "1") !== "0"'), "reversa: CLASS25B_CHAT_ROUTER=0");
chequear("por defecto sólo la charla libre pasa por el motor de lenguaje",
  c.includes('process.env.CLASS25B_CHAT_LLM ?? "libre"'), "las de datos se contestan sin gastar CPU del 2B");
const iHook = c.indexOf("if (await _chatConRouter(texto, msg, sesion, historial, nombreUsuario)) return;");
const iSaludoViejo = c.indexOf("// Agradecimientos — refuerzo de aprendizaje");
chequear("el router corre ANTES de las plantillas viejas", iHook > 0 && iSaludoViejo > iHook);
chequear("lo que escribe el motor se valida antes de publicarse", c.includes("validarRespuesta(r.texto, ev"));
chequear("el ranking se anota de class25a_output (sin DB)", /async function procesarSeñalCuantitativa[\s\S]{0,200}_chatAnotarRanking\(señalA\)/.test(c));
chequear("las cotizaciones se anotan de class7_output", /case CH_IN_MERCADO:[\s\S]{0,300}_chatAnotarCotizaciones\(msg\)/.test(c));
chequear("el nombre lo decide chat_router (no más «Hola» como nombre)", c.includes("return chatDetectarNombre(texto);"));
chequear("el prompt local usa los hechos en vez de historialSectores", c.includes("const ahora = ctx._hechos") && c.includes("AHORA: ${ahora}"));
chequear("la caché del motor incluye los hechos", c.includes("const _claveCache = (ctx?._hechos || ctx?._referencia || _hist)") && c.includes('${ctx?._hechos || ""}|${ctx?._referencia || ""}|${_hist}'));
// 5-nov: «sí, por favor» en la charla devolvía la respuesta de OTRA charla.
chequear("en la charla la caché incluye la conversación", /const _hist = \(?ctx\?\._modo === "charla"[\s\S]{0,120}historial/.test(c));
chequear("la cartera la redacta el redactor con activos reales", c.includes("redactarPortfolio("));
chequear("el heartbeat informa el router", c.includes("chat_router=on directas="));
chequear("la tasa de acierto sale del endpoint de la tesis", c.includes("/api/backtesting/professional`"));
chequear("con un tema que el sistema ilumina (tasas), contesta el redactor", c.includes("!conTema && ev.suficiente && _hayMotorLenguaje(true)"));
chequear("«¿qué opinás de Nvidia?» habla de NVDA aunque el router lo lea como resumen",
  c.includes('"resumen", "porque"].includes(ef.intencion)'));
for (const m of ["chat_router.js", "chat_evidencia.js", "chat_redactor.js"]) {
  const src = leer(S(m));
  const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map(x => x[1]);
  chequear(`${m} es puro (sin Redis, MySQL ni red)`, imports.every(x => x.startsWith("./chat_")), imports.join(", ") || "sin imports");
}

// ── 7 ────────────────────────────────────────────────────────────────────
seccion("7 · Presupuesto de latencia del prompt local CON hechos");
{
  // Mismas constantes que sim32 7b: lo que Ollama midió de sí mismo en el server.
  const MS_LEIDO = 24.7, MS_GEN = 102.8, OBJETIVO = 18000;
  const fnIni = c.indexOf("function _buildAdvisorPromptLocal");
  const fn = c.slice(fnIni, c.indexOf("\n}\n", fnIni));
  const estatico = fn.slice(fn.indexOf("return `Sos MIIA") + 8, fn.lastIndexOf("`;")).replace(/\$\{[^}]*\}/g, "");
  let peor = 0;
  for (const q of ["¿la fed va a bajar tasas?", "contame algo interesante", "¿qué opinás de la economía?"]) {
    const it = cl(q);
    const h = E.evidencia(it, P).hechos.join(" ");
    peor = Math.max(peor, h.length);
  }
  const tope = Number((c.match(/MIIA_LLM_MAX_TOKENS \|\| (\d+)/) || [])[1]);
  const tokens = Math.round((estatico.length + peor + 180) / 3.3);   // +180: glosario y foco
  const total = tokens * MS_LEIDO + tope * MS_GEN;
  console.log(`        prompt ~${tokens} tokens (hechos: ${peor} car.) + ${tope} de salida → ${(total / 1000).toFixed(1)} s peor caso`);
  chequear("con hechos, el peor caso sigue entrando en 18 s", total < OBJETIVO);
}

// ── 8 ────────────────────────────────────────────────────────────────────
seccion("8 · Charla libre: lo que está fuera del sistema lo contesta el motor (5-nov-2026)");
{
  // Las frases de las capturas del 5-nov más las que Martín quiere que opine.
  const CHARLA = [
    ["Que opinas de ti mismo y tu creador ?", "identidad", "opina"],
    ["¿qué pensás de vos?", "identidad", "opina"],
    ["¿qué opinás de Martín?", "identidad", "opina"],
    ["Cuánto crees que gane ?", "libre", null],
    ["¿Qué opinás de Messi?", "libre", null],
    ["¿Quién va a ganar el mundial?", "libre", null],
    ["Contame un chiste", "libre", null],
    ["¿Qué pensás de la inteligencia artificial?", "libre", "tema"],
  ];
  for (const [q, intencion, sub] of CHARLA) {
    const r = cl(q);
    chequear(`charla: «${q}»`, r.intencion === intencion && (sub == null || r.subtipo === sub), `→ ${r.intencion}${r.subtipo ? " · " + r.subtipo : ""}`);
  }
  chequear("«¿quién es tu creador?» sigue siendo la ficha (no opinión)", cl("¿Quién es tu creador?").subtipo === "quien");
  chequear("«¿qué opinás del mercado?» sigue siendo resumen con datos", cl("¿qué opinás del mercado?").intencion === "resumen");
  chequear("«¿cómo lo ves?» (corto, sin tema) sigue siendo resumen", cl("¿cómo lo ves?").intencion === "resumen");

  // El prompt de charla: dice quién la creó, deja opinar, prohíbe consejos, y es corto.
  const pc = D.promptCharla({ _hechos: "" });
  chequear("el prompt de charla nombra a Martín Rinaldi", /Martín Rinaldi/.test(pc));
  chequear("el prompt de charla pide opinar y no esquivar", /opiná/.test(pc) && /sin esquivar/.test(pc));
  chequear("el prompt de charla prohíbe consejos y cifras inventadas", /qué comprar o vender/.test(pc) && /no inventes cifras/.test(pc));
  chequear("el prompt de charla NO dice «si no figura, decí que no lo tenés»", !/no lo ten[eé]s/.test(pc));
  const tokCh = Math.round((pc.length + 160) / 3.3);   // +160: un hecho del mercado
  const topeCh = Number((c.match(/MIIA_LLM_MAX_TOKENS_CHARLA \|\| (\w+)/) || [])[1] === "LLM_LOCAL_MAX_TOKENS"
    ? (c.match(/MIIA_LLM_MAX_TOKENS \|\| (\d+)/) || [])[1] : (c.match(/MIIA_LLM_MAX_TOKENS_CHARLA \|\| (\d+)/) || [])[1]);
  const totCh = tokCh * 24.7 + topeCh * 102.8;
  console.log(`        charla: prompt ~${tokCh} tokens + ${topeCh} de salida → ${(totCh / 1000).toFixed(1)} s peor caso`);
  chequear("el peor caso de la charla entra en 18 s", totCh < 18000);

  // La firma: recuerda que es una IA y que se puede equivocar; en identidad, a Martín.
  const f1 = D.firmaCharla("Creo que Argentina llega bien al mundial.", { semilla: "a" });
  chequear("la firma agrega «me puedo equivocar»", /equivoc/.test(f1) && /IA/.test(f1), f1.slice(-60));
  const f2 = D.firmaCharla("Es una pregunta linda; como IA me puedo equivocar, pero creo que sí.", { semilla: "a" });
  chequear("si ya lo dijo, no lo repite", (f2.match(/equivoc/g) || []).length === 1);
  const f3 = D.firmaCharla("Me veo como una IA curiosa.", { semilla: "b", identidad: true });
  chequear("en identidad, siempre nombra a Martín", /Martín Rinaldi/.test(f3));
  const firmas = new Set(["a", "b", "c", "d", "e", "f", "g"].map(x => D.firmaCharla("Hola.", { semilla: x })));
  chequear("la firma no es siempre la misma", firmas.size >= 3, `${firmas.size} formas`);

  // La validación abierta: deja hablar como IA y de cualquier empresa, pero no
  // inventar porcentajes, ni decir que la hizo otra empresa, ni aconsejar.
  const EVc = { hechos: ["Mercado: 35 de 50 en alza, promedio +0,4%."], datos: {} };
  const VALC = [
    ["Como inteligencia artificial te digo que Argentina tiene un equipo durísimo para 2026.", true],
    ["Me parece que ChatGPT y Google empujan mucho la IA, y eso es bueno para todos.", true],
    ["Creo que vas a ganar 15% en un mes con esa cartera.", false, "porcentaje inventado"],
    ["Soy un modelo creado por Google, así que te cuento.", false, "autoría ajena"],
    ["Uso gemma por dentro y anda bárbaro.", false, "motor interno"],
    ["Te recomiendo comprar XLK ya mismo, es una buena inversión.", false, "consejo"],
    ["No tengo acceso a datos en tiempo real, así que no sé.", false, "evasiva"],
    ["Messi fue el mejor de 2022 y ganó 8 balones de oro, una locura.", true],
  ];
  for (const [t, esp, nota = ""] of VALC) {
    const v = E.validarRespuesta(t, EVc, { tickers: U.TICKERS_TEXTO, abierta: true });
    chequear(`charla ${esp ? "acepta" : "rechaza"}: «${t.slice(0, 44)}…»`, v.ok === esp, v.motivo || nota);
  }
  chequear("la validación ESTRICTA sigue rechazando «como IA»",
    !E.validarRespuesta("Como IA de lenguaje no tengo acceso a datos.", EVc, { tickers: U.TICKERS_TEXTO }).ok);

  // Respaldo: sin motor, nada de «no quiero inventarte».
  let viejas = 0;
  for (const q of ["Cuánto crees que gane ?", "¿Quién va a ganar el mundial?", "Que opinas de ti mismo y tu creador ?"]) {
    const it = cl(q);
    const t = D.redactar(it, E.evidencia(it, P), { semilla: q }).texto;
    if (/(inventarte|algo inventado|se me escapa|no voy a improvisar)/i.test(t)) viejas++;
  }
  chequear("el respaldo ya no dice «no quiero inventarte»", viejas === 0);
  const rOp = D.redactar(cl("Que opinas de ti mismo y tu creador ?"), E.evidencia(cl("x"), P), { semilla: "x" }).texto;
  chequear("el respaldo de «¿qué opinás de vos?» opina y nombra a Martín", /Martín Rinaldi/.test(rOp) && /equivoc/.test(rOp));

  // «Dame el detalle en ese orden» después del resumen de noticias amplía las noticias.
  const dn = cl("Dame el detalle en ese orden", { previo: { intencion: "noticias", tickers: [] } });
  chequear("«dame el detalle» tras las noticias amplía las noticias", dn.intencion === "noticias" && dn.detalle === 2, `→ ${dn.intencion}`);
  const PS = { ...P, sent: { INDA: { label: "BULLISH", n: 5 }, DIA: { label: "BULLISH", n: 3 }, XLE: { label: "BULLISH", n: 2 },
    EWG: { label: "BULLISH", n: 1 }, XLK: { label: "BULLISH", n: 4 }, XLF: { label: "BULLISH", n: 2 }, EWZ: { label: "BULLISH", n: 1 },
    DIS: { label: "BEARISH", n: 2 } } };
  const itN = cl("¿cuáles son las últimas noticias?");
  const rN = D.redactar(itN, E.evidencia(itN, PS), { semilla: "x" }).texto;
  chequear("el resumen de noticias nombra los 7 positivos, no 4", ["INDA", "DIA", "XLE", "EWG", "XLK", "XLF", "EWZ"].every(t => rN.includes(t)), rN.slice(0, 70));
  const rD = D.redactar(dn, E.evidencia(dn, PS), { semilla: "x" }).texto;
  chequear("el detalle trae cada uno con sus artículos", /INDA \(5 artículos\)/.test(rD) && /DIS \(2 artículos\)/.test(rD), rD.slice(0, 70));

  // Guardas sobre class25B.
  chequear("class25B manda la charla al motor con su prompt propio", c.includes('_modo: "charla"') && c.includes("promptCharla(ctx)"));
  chequear("la charla se valida en modo abierto", c.includes("abierta: true"));
  chequear("la charla lleva la firma de IA", c.includes("firmaCharla(v.texto"));
  chequear("la charla se apaga sin recompilar", c.includes('String(process.env.CLASS25B_CHAT_CHARLA ?? "1") !== "0"'), "reversa: CLASS25B_CHAT_CHARLA=0");
}

// ── 9 ────────────────────────────────────────────────────────────────────
seccion("9 · Las capturas del 5-nov (tarde): «Si porfavor» y la respuesta que se repetía");
{
  const OF = { intencion: "ranking", direccion: "ambos" };
  const PREV = { intencion: "resumen", tickers: [] };
  for (const f of ["Si porfavor", "si claro", "ok dale", "dale porfa", "sí quiero", "por supuesto", "sisi",
                   "si porfa miia", "perfecto, dale", "Sí, porfa, mostrame", "me interesa", "claro que si"]) {
    const r = cl(f, { oferta: OF, previo: PREV });
    chequear(`«${f}» acepta la propuesta`, r.intencion === "seguir" && r.destino?.intencion === "ranking", `→ ${r.intencion}`);
  }
  chequear("«Si porfavor» sin nada pendiente no va a la charla", cl("Si porfavor").intencion === "seguir");
  chequear("«sí, gracias» sin nada pendiente es un gracias", cl("si gracias").intencion === "gracias");
  chequear("«gracias» y «genial» siguen siendo gracias", cl("gracias", { oferta: OF }).intencion === "gracias" && cl("genial").intencion === "gracias");
  chequear("«no porfavor» es un no", cl("no porfavor", { oferta: OF }).intencion === "negar");
  chequear("«sí, XLK» no es un sí suelto: pregunta por XLK", cl("si, XLK").intencion === "opinion");
  const ch = cl("Si porfavor", { previo: PREV, ultima: "charla" });
  chequear("después de una charla del motor, el «sí» vuelve al motor", ch.intencion === "libre" && ch.subtipo === "sigue_charla");
  chequear("una propuesta explícita gana aunque la última fuera charla",
    cl("dale", { oferta: OF, previo: PREV, ultima: "charla" }).destino?.intencion === "ranking");
  chequear("«¿qué pensás del fútbol argentino?» es charla, no ARGT", cl("¿Qué pensás del fútbol argentino?").intencion === "libre");
  chequear("«¿cómo ves Argentina?» sigue siendo ARGT", cl("¿cómo ves Argentina?").grupo?.etiqueta === "Argentina");

  // El respaldo: no manda a repetir, y lo que pregunta queda como propuesta.
  const it = cl("¿Quién va a ganar el próximo mundial?");
  const rL = D.redactar(it, E.evidencia(it, P), { semilla: "x" });
  chequear("el respaldo no dice «repetímela» ni «está lenta»", !/repet[ií]mela|lenta|pregunt[aá]mela de nuevo/i.test(rL.texto), rL.texto.slice(0, 60));
  chequear("lo que el respaldo pregunta queda como propuesta", /ranking/.test(rL.texto) && rL.oferta?.intencion === "ranking");
  const itS = cl("Si porfavor", { previo: PREV, ultima: "charla" });
  const rS = D.redactar(itS, E.evidencia(itS, P), { semilla: "y" });
  chequear("si el motor no sigue la charla, lo dice sin plantilla vieja", /hilo/.test(rS.texto) && rS.oferta?.intencion === "ranking");
  const itN = cl("dale");
  const rN = D.redactar(itN, E.evidencia(itN, P), { semilla: "z" });
  chequear("un «sí» sin nada pendiente contesta con datos, no con otra pregunta",
    /\d+ de \d+|promedio/.test(rN.texto) && rN.oferta?.intencion === "ranking", rN.texto.slice(0, 60));

  // La charla del motor cortada por el tope de tokens se rescata (sólo en la charla).
  const larga = "Creo que el fútbol argentino tiene una cantera impresionante, con chicos que salen de los clubes de barrio todos los años y que";
  const vA = E.validarRespuesta(larga, { hechos: [], datos: {} }, { abierta: true });
  chequear("una opinión cortada se rescata hasta la última pausa", vA.ok && /barrio todos los años\.$/.test(vA.texto), vA.texto.slice(-30));
  chequear("en las respuestas de datos, cortada sigue siendo rechazo", !E.validarRespuesta(larga, { hechos: [], datos: {} }, {}).ok);
  chequear("un dato que falta no se lee como 0 (riesgo global 0%)", E.armarPanel({ riesgo: null }).riesgo === null);

  // class25B: el filtro de ráfagas era GLOBAL por texto y se tragaba el segundo «sí».
  chequear("el filtro de ráfagas es por sesión", c.includes("_isDupHumanQuery(texto, msg)") && /_finTurnoHumano\(msg\);\s*\n\s*await redisPub\.publish\(CH_OUT/.test(c));
  chequear("class25B le pasa al router quién escribió la última respuesta", c.includes("ultima: sesion.chatUltima || null") && c.includes('sesion.chatUltima = /charla/.test(fuente) ? "charla" : ef.intencion'));
}

seccion("10 · Revisión del 6-nov: frases que se escapaban");
{
  for (const f of ["¿te equivocás mucho?", "te equivocas seguido?", "¿cuántas veces le errás?", "cuanto fallas?"])
    chequear(`«${f}» es la tasa de acierto`, cl(f).intencion === "acierto", cl(f).intencion);
  chequear("«¿qué es el rank IC?» es la definición", cl("¿qué es el rank IC?").intencion === "concepto" && cl("¿qué es el rank IC?").concepto === "rank_ic");
  chequear("«¿qué significa el edge?» es la definición", cl("¿qué significa el edge?").concepto === "edge");
  chequear("«¿cuál es tu rank IC?» sigue siendo el número", cl("¿cuál es tu rank IC?").intencion === "acierto");
  const itC = cl("¿qué es el rank IC?");
  const rC = D.redactar(itC, E.evidencia(itC, P), { semilla: "c" });
  chequear("el rank IC se explica sin inventar un número", /orden/.test(rC.texto) && !/\d+(,\d+)?\s?%/.test(rC.texto), rC.texto.slice(0, 60));
  for (const f of ["borrá mi portafolio", "olvidate de mi cartera", "eliminá mi cartera"])
    chequear(`«${f}» borra la cartera`, cl(f).intencion === "mi_portfolio" && cl(f).subtipo === "borrar", `${cl(f).intencion}/${cl(f).subtipo}`);
  chequear("«¿le saco algo a mi cartera?» sigue siendo ajustar", cl("¿le saco algo a mi cartera?").subtipo === "ajustar");
  const PF = await import(new URL("../../scripts/chat_perfil.js", import.meta.url));
  const ses = {};
  chequear("«soy agresivo» suelto arma la cartera", PF.decidir(ses, "soy agresivo", cl("soy agresivo")).accion === "armar" && ses.perfil === "agresivo");
  chequear("«soy de Rosario» no es un perfil", PF.decidir({}, "soy de Rosario", cl("soy de Rosario")).accion === "nada");
  chequear("class25B borra la cartera de memoria y disco", c.includes('ef.subtipo === "borrar"') && /_portUsuario\.delete\(msg\.user_id\)\) _guardarPortUsuario\(\)/.test(c));
}

// ── 11 · Temas de fuera del mercado van a la charla, no al ranking (8-nov-2026) ──
// «¿Quién creés que gana el próximo Mundial?» y «¿cuál es la mejor película?»
// disparaban rankingMejor por «gana»/«mejor» y MIIA contestaba con ETFs.
console.log("\n— 11 · temas de fuera del mercado → charla libre");
for (const t of ["¿Quién creés que gana el próximo Mundial?", "¿cuál es la mejor película de la historia?",
                 "cual es el mejor asado?", "quién es el mejor jugador del mundo?", "¿cuál es el mejor auto?",
                 "Que opinas de Messi ?", "¿Te gusta la música de Charly García?"]) {
  chequear(`«${t}» → libre`, cl(t).intencion === "libre", cl(t).intencion);
}
for (const [t, i] of [["¿qué sector gana hoy?", "ranking"], ["¿cuál sube más?", "ranking"],
                      ["¿qué está más fuerte hoy?", "ranking"], ["que opinas de argentina?", "opinion"]]) {
  chequear(`«${t}» sigue siendo ${i}`, cl(t).intencion === i, cl(t).intencion);
}

// ── 12 · Las capturas del 13-nov-2026: preguntas que «no respondía» ──────
// Las cuatro salían con el respaldo de la charla («no me salió una respuesta…
// Lo que sí tengo: 17 de 50 en alza…») o con una tarjeta «HOLD MERCADO».
seccion("12 · Las capturas del 13-nov: preguntas que el chat no contestaba");
{
  const DIRECTAS = [
    // [frase tal cual la escribió el usuario, intención, subtipo/concepto]
    ["Qué es un ETFs", "concepto", "etf"],
    ["Que son los ETFs?", "concepto", "etf"],
    ["¿Para qué sirve un ETF?", "concepto", "etf"],
    ["como funcionan los etfs", "concepto", "etf"],
    ["que son las señales?", "concepto", "senal"],
    ["Como te persistía eres consiente de ti Misma ?", "identidad", "conciencia"],
    ["¿Sos consciente?", "identidad", "conciencia"],
    ["¿tenés sentimientos?", "identidad", "conciencia"],
    ["¿cómo te percibís?", "identidad", "conciencia"],
    ["Es mucho en términos de mercado ?", "riesgo", "magnitud"],
  ];
  for (const [t, i, sub] of DIRECTAS) {
    const r = cl(t);
    chequear(`«${t}» → ${i}·${sub}`, r.intencion === i && (r.subtipo === sub || r.concepto === sub),
      `${r.intencion}·${r.subtipo || r.concepto || "-"}`);
  }
  // Lo que ya andaba, sigue igual.
  for (const [t, i, sub] of [["para que servis?", "capacidades", null], ["¿qué opinás de vos?", "identidad", "opina"],
                             ["que es XLK?", "opinion", "que_es"], ["es bueno el asado?", "libre", null],
                             ["Afecta mi portafolio ?", "mi_portfolio", null]]) {
    const r = cl(t);
    chequear(`«${t}» sigue siendo ${i}${sub ? "·" + sub : ""}`, r.intencion === i && (!sub || r.subtipo === sub), `${r.intencion}·${r.subtipo || "-"}`);
  }
  // «¿Es mucho?» después de un tema con datos sigue ESE tema.
  const sigue = cl("¿Es mucho?", { previo: { intencion: "riesgo", tickers: ["XLK"], grupo: null } });
  chequear("«¿Es mucho?» tras el riesgo de XLK → riesgo de XLK", sigue.intencion === "riesgo" && sigue.tickers[0] === "XLK" && sigue.heredado);

  // Las respuestas: CONTESTAN la pregunta, sin el respaldo de la charla.
  const RESPALDO = /no me sali[oó] una respuesta|se me cort[oó] el hilo|no me sali[oó] una opini[oó]n/i;
  const rd = t => { const it = cl(t); return D.redactar(it, E.evidencia(it, P), { semilla: t }).texto; };
  const etf = rd("Qué es un ETFs");
  chequear("«Qué es un ETFs» define qué es un ETF", /Un ETF es un fondo que cotiza en bolsa/.test(etf) && !RESPALDO.test(etf), etf.slice(0, 60));
  const conc = rd("Como te persistía eres consiente de ti Misma ?");
  chequear("«¿eres consciente…?» contesta la pregunta (respaldo propio)", /conscien|conciencia/i.test(conc) && /Mart[ií]n/.test(conc) && !RESPALDO.test(conc), conc.slice(0, 60));
  const mag = rd("Es mucho en términos de mercado ?");
  chequear("«¿Es mucho…?» da el riesgo con su escala", /72%/.test(mag) && /escala va de 0 a 100%/.test(mag) && /es mucho/.test(mag), mag.slice(0, 70));

  // El validador de la charla deja nombrar un ETF como EJEMPLO…
  const evL = E.evidencia(cl("Qué es un ETFs"), P);
  const vEj = E.validarRespuesta("Un ETF es un fondo que cotiza en bolsa como una acción, como SPY, que replica el S&P 500. Te deja diversificar con una sola compra.",
    { ...evL, hechos: [] }, { tickers: U.TICKERS_TEXTO, abierta: true });
  chequear("charla: nombrar SPY como ejemplo ya no descarta la respuesta", vEj.ok, vEj.motivo || "");
  // …pero no atribuirle un dato.
  for (const t of ["Un ETF es un fondo, como QQQ. QQQ subió mucho este año.", "Me parece que XLK va a subir mañana, es fuerte."]) {
    const v = E.validarRespuesta(t, { ...evL, hechos: [] }, { tickers: U.TICKERS_TEXTO, abierta: true });
    chequear(`charla: «${t.slice(0, 38)}…» sigue descartada`, !v.ok, v.motivo || "");
  }
  const vDatos = E.validarRespuesta("Un ETF es un fondo, como SPY.", { ...evL, hechos: [] }, { tickers: U.TICKERS_TEXTO });
  chequear("en el camino de DATOS sigue estricto (SPY sin datos se descarta)", !vDatos.ok);

  // class25B: la charla con subtipo conciencia va al motor; el frente.
  const c25 = leer(S("class25B.js"));
  chequear("class25B manda «conciencia» a la charla del motor", c25.includes('(ef.subtipo === "opina" || ef.subtipo === "conciencia")'));
  // Sin plantillas (13-nov, pedido de Martín): definiciones y «¿es mucho?» las redacta el motor.
  chequear("las definiciones (concepto) las redacta el motor", c25.includes('|| ef.intencion === "concepto"'));
  chequear("«¿es mucho?» lo redacta el motor", c25.includes('(ef.intencion === "riesgo" && ef.subtipo === "magnitud")'));
  chequear("el texto del sistema va al motor como REFERENCIA, no como respuesta",
    c25.includes("_referencia: referencia") && c25.includes("hechos: [...(ev.hechos || []), referencia]"));
  const pr = D.promptCharla({ _referencia: "Un ETF es un fondo que cotiza en bolsa." });
  chequear("el prompt de charla le pasa la referencia al motor y le pide no copiarla", /no los copies textual/.test(pr) && /Un ETF es un fondo/.test(pr));
  chequear("sin referencia el prompt queda igual (no cuesta tokens)", !/Información del sistema/.test(D.promptCharla({})));
  const web = leer(S("publi_src/index.html"));
  chequear("el chat NO dibuja HOLD ni decisiones automáticas mientras espera la respuesta",
    web.includes('(senal === "BUY" || senal === "SELL") && !_respShown && !_pendingAsk'),
    "«¿sos consciente?» → tarjeta «HOLD MERCADO» en el hilo");
  chequear("el historial ya no corta las respuestas a 500 caracteres",
    !web.includes("txt: txt.slice(0, 500)") && web.includes("_recortarParaHistorial(txt, 2000)"),
    "«…y 20% es cíclico, q»");
}

// ── 13 · 16-nov-2026: el acierto no sobrevende, y MIIA no elogia a su creador ──
{
  console.log("\n13 · acierto honesto (rank IC como veredicto) y sin elogios a Martín");
  const m = { accuracy_directional: 55.2, base_rate: 53.4, edge_vs_baseline: 1.8, edge_min_detectable: 3.6,
              azar_mezcla: 50, edge_vs_azar: 5.2, edge_azar_significativo: true, n_efectivo: 745,
              rank_ic: 0.0161, rank_ic_min_detectable: 0.1234, rank_ic_ventanas: 25, rank_ic_significativo: false };
  const tA = D.redactar({ intencion: "acierto", texto: "tasa de acierto" }, { datos: { metricas: E.normalizarMetricas(m) }, hechos: [] }, { semilla: "x" }).texto;
  chequear("con el rank IC sin señal NO dice «ya es estadísticamente significativa»", !/ya es estad/.test(tA), tA.slice(0, 90));
  chequear("dice que no puede afirmar una ventaja y cita el rank IC con su mínimo detectable",
    /no puedo decir/.test(tA) && /rank IC/.test(tA) && /0,123/.test(tA));
  chequear("ya no dice «ventanas independientes» (n_efectivo no lo son)", !/ventanas independientes/.test(tA));
  const tB = D.redactar({ intencion: "acierto", texto: "tasa de acierto" },
    { datos: { metricas: E.normalizarMetricas({ ...m, rank_ic: 0.15, rank_ic_significativo: true }) }, hechos: [] }, { semilla: "x" }).texto;
  chequear("sólo con el rank IC también significativo habla de «primera evidencia»", /primera evidencia/.test(tB));
  chequear("class25B no deja que la reescritura del motor diga «significativa» si el sistema dijo que no",
    leer(S("class25B.js")).includes('ef.intencion === "acierto" && /no puedo decir|no se distingue|no lo puedo confirmar/.test(red.texto)'));

  const pc2 = D.promptCharla({});
  chequear("el prompt de charla pide NO elogiar a Martín", /no lo elogies/.test(pc2) && !/con cari[nñ]o/.test(pc2));
  chequear("la firma de identidad nombra a Martín sin «cariño»",
    !/cari[nñ]o/.test(D.firmaCharla("Me veo como una IA curiosa.", { semilla: "b", identidad: true })));
  const el = E.sinElogioCreador("Martín Rinaldi es un genio y lo admiro. Me veo como una IA en aprendizaje.");
  chequear("se saca la oración que elogia al creador y queda el resto", el.quitadas === 1 && /IA en aprendizaje/.test(el.texto) && !/genio/.test(el.texto));
  chequear("«Messi es un genio» (no habla del creador) no se toca", E.sinElogioCreador("Messi es un genio.").quitadas === 0);
  const vE = E.validarRespuesta("Me creó Martín, que es brillante. Soy una IA que mira números todo el día.", { hechos: [] }, { abierta: true });
  chequear("la validación de la charla limpia el elogio antes de publicar", vE.ok && !/brillante/.test(vE.texto), vE.texto);
  // Por régimen (16-nov-2026): destaca el mejor con su número y NO lo afirma como
  // ventaja mientras no supere su propio margen.
  for (const q of ["¿En qué régimen le ganás al mercado?", "¿cómo te va cuando el mercado baja?", "¿en mercado bajista acertás más?"])
    chequear(`«${q}» → acierto por régimen`, R.clasificar(q, OP).intencion === "acierto" && R.clasificar(q, OP).subtipo === "regimen");
  chequear("«¿qué régimen tiene el mercado hoy?» sigue siendo la lectura del régimen", R.clasificar("¿qué régimen tiene el mercado hoy?", OP).intencion === "regimen");
  chequear("«¿mi portafolio rinde en este régimen?» sigue siendo SU portafolio", R.clasificar("¿mi portafolio rinde en este régimen?", OP).intencion === "mi_portfolio");
  const pr = { alcista: { rank_ic: 0.021, rank_ic_ventanas: 7, rank_ic_min_detectable: 0.17, rank_ic_significativo: false },
               lateral: { rank_ic: -0.10, rank_ic_ventanas: 6, rank_ic_min_detectable: 0.22, rank_ic_significativo: false },
               bajista: { rank_ic: 0.179, rank_ic_ventanas: 6, rank_ic_min_detectable: 0.31, rank_ic_significativo: false } };
  const evR = pr2 => ({ datos: { metricas: E.normalizarMetricas({ ...m, rank_ic_por_regimen: pr2 }) }, hechos: [] });
  const tR = D.redactar({ intencion: "acierto", subtipo: "regimen" }, evR(pr), { semilla: "a" }).texto;
  chequear("destaca el régimen donde mejor le va, con su número", /ruedas bajistas/.test(tR) && /\+0,18/.test(tR), tR.slice(0, 90));
  chequear("y sin margen superado NO dice «le gano»", !/le gano/.test(tR) && /no lo puedo confirmar/.test(tR));
  const tR2 = D.redactar({ intencion: "acierto", subtipo: "regimen" },
    evR({ ...pr, bajista: { rank_ic: 0.21, rank_ic_ventanas: 40, rank_ic_min_detectable: 0.09, rank_ic_significativo: true } }), { semilla: "a" }).texto;
  chequear("cuando el régimen SÍ supera su margen, lo afirma", /le gano al promedio/.test(tR2));
  chequear("el endpoint calcula el IC por régimen con el régimen de la sesión ANTERIOR",
    fs.readFileSync(path.join(RAIZ, "MIIA", "miia_chatbot.py"), "utf8").includes('previas = [d for d in sesiones if d < fut[0]]'));

  const rOp = D.redactar({ intencion: "identidad", subtipo: "opina", texto: "qué opinás de tu creador" }, { datos: {}, hechos: [] }, { semilla: "a" }).texto
            + D.redactar({ intencion: "identidad", subtipo: "opina", texto: "qué opinás de tu creador" }, { datos: {}, hechos: [] }, { semilla: "b" }).texto;
  chequear("el respaldo «¿qué opinás de tu creador?» ya no dice «sólo puedo hablar bien» ni «buen trabajo»",
    !/hablar bien|buen trabajo/.test(rOp));
}

console.log(`\n${falla === 0 ? "PASA" : "FALLA"} — router de intenciones del chat  (${ok + falla} checks, ${falla} fallas)`);
process.exit(falla ? 1 : 0);
