/**
 * chat_perfil.js — armar la cartera del usuario como una conversación, no como
 * un formulario (4-nov-2026).
 *
 * POR QUÉ EXISTE
 * --------------
 * El flujo viejo de class25B era un formulario de dos pasos con frases fijas:
 * «Respondé 1 para conservador, 2 para moderado o 3 para agresivo» y después
 * «¿con cuánto capital…?». Martín escribió «agrecivo» y recibió la plantilla de
 * nuevo; tampoco se podía decir todo junto («agresivo con 10 mil»). Y la cartera
 * mostraba 6 activos al 3 % cada uno (sumaban 18 %): se recortaba una cartera de
 * 31 sin volver a repartir el 100 %.
 *
 * Acá vive la parte pura (se prueba en sim37 sin levantar nada):
 *   • entender(texto)    → perfil y capital, con errores de tipeo, sinónimos,
 *                          en cualquier orden y en un solo mensaje.
 *   • armarCartera(...)  → la selección por perfil con pesos que SUMAN 100 y,
 *                          si hay capital, el monto de cada activo.
 *   • textos             → preguntas y respuestas con variaciones, que muestran
 *                          ejemplos en vez de exigir un formato.
 */
import { num, pct, sectorES, nivelRiesgo } from "./chat_evidencia.js";
import { _test as _red } from "./chat_redactor.js";

// ── Normalización ─────────────────────────────────────────────────────────
function norm(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[¿¡!?"“”«»]/g, " ").replace(/\s+/g, " ").trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 9;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ── Perfil ────────────────────────────────────────────────────────────────
const PALABRAS = {
  // «seguro/segura» NO van sueltas: «sí, seguro» es un sí, no un perfil (5-nov).
  // Van como frase en FRASES («algo seguro», «lo más seguro»).
  conservador: ["conservador", "conservadora", "conservadores", "prudente", "cauteloso", "cautelosa", "tranquilo", "tranqui"],
  moderado:    ["moderado", "moderada", "moderados", "equilibrado", "equilibrada", "intermedio", "intermedia", "balanceado", "balanceada", "medio"],
  agresivo:    ["agresivo", "agresiva", "agresivos", "arriesgado", "arriesgada", "audaz", "osado", "osada", "jugado", "jugada"],
};
// Palabras que valen SÓLO escritas tal cual (6-nov: «perfil mixto» no se
// entendía). Sin tolerancia de tipeo: con ella «mismos», «central», «textos» y
// «combinar» quedaban a dos letras y daban moderado.
const EXACTAS = { mixto: "moderado", mixta: "moderado", mixtos: "moderado", combinado: "moderado",
  combinada: "moderado", neutro: "moderado", neutra: "moderado", neutral: "moderado" };
// Frases que valen más que una palabra suelta (y se miran ANTES: «no quiero
// arriesgar» es conservador aunque contenga «arriesg»).
const FRASES = [
  // 6-nov: los verbos («arriesgo mucho», «ariesgo poco», con o sin la doble r)
  // no llegaban a ninguna palabra: «ariesgo mucho» se iba al riesgo del mercado.
  [/\ba?rr?iesg\w*\s+(poco|nada)\b|\bno me (quiero )?a?rr?iesg|\bno (quiero |me gusta |busco )?(arriesgar|perder|riesgo)|\b(poco|bajo|minimo|nada de) riesgo|cuidar (el|mi) (capital|plata)|no perder|\b(algo|lo mas|bien|bastante|muy|mas) segur[oa]\b|\bperfil segur[oa]\b/, "conservador"],
  [/\ba?rr?iesg\w*\s+(algo|un poco|mas o menos|lo justo|normal)\b|\b(algo|un poco) de riesgo|riesgo (medio|moderado|intermedio)|ni mucho ni poco|termino medio|mitad y mitad/, "moderado"],
  [/\ba?rr?iesg\w*\s+(mucho|bastante|todo|fuerte|a full|sin miedo)\b|\bme la juego|\bme (banco|aguanto|bancaria) (el |mucho |bastante )?riesgo|\bme gusta (el )?riesgo|\b(mucho|alto|bastante) riesgo|riesgo alto|maximo rendimiento|maxima ganancia|a fondo|todo o nada|\bmax(imo)?\b/, "agresivo"],
];

// Palabras comunes que están a un error de tipeo de un perfil y NO lo son
// (medido el 5-nov): «seguí» quedaba a 2 letras de «seguro» y, con una cartera
// recién armada, «dale, seguí» la rearmaba como conservadora; «medios» (de
// prensa) y «media» daban moderado, «usado» y «jugar» agresivo.
const NO_PERFIL = new Set(["segui", "seguir", "sigue", "siga", "sigan", "seguime", "seguro", "segura", "seguros",
  "usado", "usada", "usados", "observador", "moderno", "moderna", "modernos", "media", "medias", "medios",
  "medida", "jugar", "juego", "juegos", "pasado", "modelo", "modelos", "agregado", "agregar", "agresion",
  "servidor", "moderador", "moderar", "remedio", "osados"]);

/** El perfil escrito en `texto` (tolera errores de tipeo), o null. */
export function extraerPerfil(texto) {
  const t = norm(texto);
  if (!t) return null;
  // «1», «la 2», «opción 3», «el tercero»: sólo si el mensaje es eso.
  const op = t.match(/^(?:(?:la|el|opcion|opción|nro|numero)\s*)?([123])(?:\s*(?:\)|\.|-|°))?$/);
  if (op) return ["conservador", "moderado", "agresivo"][Number(op[1]) - 1];
  const ord = t.match(/^(?:el |la )?(primer[oa]?|segund[oa]|tercer[oa]?)$/);
  if (ord) return /^prim/.test(ord[1]) ? "conservador" : /^seg/.test(ord[1]) ? "moderado" : "agresivo";
  for (const [re, p] of FRASES) if (re.test(t)) return p;
  for (const tok of t.split(/[^a-zñ]+/)) if (EXACTAS[tok]) return EXACTAS[tok];
  let mejor = null, dist = 9;
  for (const tok of t.split(/[^a-zñ]+/).filter(w => w.length >= 4 && !NO_PERFIL.has(w))) {
    for (const [perfil, lista] of Object.entries(PALABRAS)) {
      for (const w of lista) {
        // Tolerancia según el largo: «agrecivo», «agresibo», «consevador», «moderdo».
        const tope = w.length >= 9 ? 2 : w.length >= 6 ? 2 : 1;
        const d = lev(tok, w);
        if (d <= tope && d < dist) { dist = d; mejor = perfil; }
      }
    }
  }
  return mejor;
}

// ── Capital ───────────────────────────────────────────────────────────────
/**
 * El capital escrito en `texto`: «10000», «10.000», «10k», «10 mil»,
 * «$5.000», «5000 usd», «100.000 pesos», «1 millón», «1,5M».
 * @returns {{num:number, moneda:"USD"|"ARS"|null, texto:string}|null}
 */
export function extraerCapital(texto) {
  const t = norm(texto);
  if (!t) return null;
  if (/^(?:(?:la|el|opcion|numero)\s*)?[123](?:\s*[).°-])?$/.test(t)) return null;   // es la opción, no plata
  const re = /(u\$s|us\$|usd|\$|ars)?\s*(\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(k\b|mil\b|millon(?:es)?\b|mm\b|m\b|lucas?\b|palos?\b)?\s*(usd\b|u\$s|dolares?\b|dls\b|verdes\b|pesos?\b|ars\b)?/g;
  let m, mejor = null;
  while ((m = re.exec(t))) {
    const [, pre, cifra, mult, suf] = m;
    let n;
    if (/^\d{1,3}(?:[.\s]\d{3})+$/.test(cifra)) n = Number(cifra.replace(/[.\s]/g, ""));
    else n = Number(cifra.replace(",", "."));
    if (!Number.isFinite(n)) continue;
    if (mult) {
      if (/^(k|mil|lucas?)/.test(mult)) n *= 1000;
      else if (/^(millon|mm|m$|palos?)/.test(mult)) n *= 1_000_000;
    }
    const tieneMarca = !!(pre || mult || suf);
    if (n < 10 || (!tieneMarca && n < 100)) continue;   // «3 activos», «2 años»: no es plata
    if (!tieneMarca && Number.isInteger(n) && n >= 1900 && n <= 2100) continue;   // «el 2026»: es un año
    let moneda = null;
    if (/ars|peso/.test(`${pre || ""} ${suf || ""}`)) moneda = "ARS";
    else if (/u\$s|us\$|usd|dolar|dls|verdes/.test(`${pre || ""} ${suf || ""}`)) moneda = "USD";
    else if (/\bpesos?\b/.test(t)) moneda = "ARS";
    else if (/\b(dolares?|usd|u\$s)\b/.test(t)) moneda = "USD";
    if (!mejor || n > mejor.num) mejor = { num: Math.round(n * 100) / 100, moneda };
  }
  if (!mejor) return null;
  return { ...mejor, texto: formatoMonto(mejor.num, mejor.moneda) };
}

export function formatoMonto(n, moneda = null) {
  const s = Number(n).toLocaleString("es-AR", { maximumFractionDigits: n < 100 ? 2 : 0 });
  return moneda === "ARS" ? `$${s} pesos` : moneda === "USD" ? `US$ ${s}` : `$${s}`;
}

/** Todo lo que el mensaje dice sobre la cartera, en cualquier orden. */
export function entender(texto) {
  const t = norm(texto);
  return {
    perfil: extraerPerfil(texto),
    capital: extraerCapital(texto),
    sinCapital: /(no (se|tengo|quiero decir|importa)|da igual|despues|saltea|skip|cualquier(a)?|ninguno|sin capital|prefiero no)/.test(t),
  };
}

// ── La cartera ────────────────────────────────────────────────────────────
const N_POR_PERFIL = { conservador: 5, moderado: 6, agresivo: 6 };

/** Reparte 100 en `n` partes enteras que suman exactamente 100. */
export function repartir(n) {
  const base = Math.floor(100 / n), resto = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
}

/**
 * Elige los activos según el perfil y les da pesos que SUMAN 100.
 * @param {Array} activos  [{symbol, sector, riesgo_pct, cambio_pct|change_pct}]
 */
export function armarCartera(activos, perfil, capital = null) {
  const lista = (activos || []).filter(a => a && a.symbol);
  if (!lista.length) return [];
  const riesgo = a => Number(a.riesgo_pct ?? 50);
  const cambio = a => Number(a.cambio_pct ?? a.change_pct ?? 0);
  let orden;
  if (perfil === "conservador") orden = [...lista].sort((a, b) => riesgo(a) - riesgo(b));
  else if (perfil === "agresivo") orden = [...lista].sort((a, b) => (cambio(b) - cambio(a)) || (riesgo(b) - riesgo(a)));
  else {
    // Moderado: mitad de los de menos riesgo y mitad de los de más momentum,
    // sin repetir, para que de verdad quede en el medio.
    const porRiesgo = [...lista].sort((a, b) => riesgo(a) - riesgo(b));
    const porCambio = [...lista].sort((a, b) => cambio(b) - cambio(a));
    orden = [];
    for (let i = 0; orden.length < lista.length && i < lista.length; i++) {
      for (const a of [porRiesgo[i], porCambio[i]]) if (a && !orden.includes(a)) orden.push(a);
    }
  }
  const elegidos = orden.slice(0, Math.min(N_POR_PERFIL[perfil] || 6, orden.length));
  const pesos = repartir(elegidos.length);
  return elegidos.map((a, i) => ({
    symbol: a.symbol, sector: a.sector || null, peso_pct: pesos[i],
    riesgo_pct: a.riesgo_pct ?? null, cambio_pct: cambio(a),
    monto: capital?.num ? Math.round(capital.num * pesos[i]) / 100 : null,
  }));
}

// ── Textos ────────────────────────────────────────────────────────────────
function lista(arr) {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} y ${a[a.length - 1]}`;
}

/**
 * Pregunta por el perfil (y de paso el capital), mostrando ejemplos, no un menú.
 * @param {object} op  { semilla, nombre, capital, contexto, regimen }
 *   contexto "sin_portfolio": preguntó por SU cartera y no hay ninguna guardada.
 *   regimen  {etiqueta, positivos, n, media, riesgo, enRueda} para contestar la
 *            parte de la pregunta que sí se puede contestar («¿sirve para este
 *            régimen?»): cómo se lee el mercado hoy.
 */
export function preguntarPerfil({ semilla, nombre, capital, contexto, regimen, evitar } = {}) {
  const R = _red.azar(semilla || "perfil");
  const hola = nombre ? `${nombre}, ` : "";
  const ya = capital ? ` Anoto ${capital.texto}.` : "";
  if (contexto === "sin_portfolio") {
    // 5-nov-2026: era «No encuentro una cartera tuya guardada. Dale. ¿Qué tan
    // arriesgado querés que sea?» — el «Dale» pegado sin que nadie hubiera
    // pedido nada, y la pregunta del régimen sin contestar.
    const p = [cap(R.pick([
      `${hola}no encuentro una cartera tuya guardada para comparar.`,
      `${hola}todavía no tengo guardada una cartera tuya.`,
    ]))];
    if (regimen) {
      const cuando = regimen.enRueda === false ? "en la última rueda" : "hoy";
      p.push(`Del mercado sí te puedo decir que ${cuando} se lee ${regimen.etiqueta}: suben ${regimen.positivos} de ${regimen.n}, `
        + `promedio ${pct(regimen.media)}${regimen.riesgo != null ? `, riesgo global ${Math.round(regimen.riesgo * 100)}% (${nivelRiesgo(regimen.riesgo)})` : ""}.`);
    }
    p.push(R.pick([
      `Si me decís tu perfil —por ejemplo «moderado con 10 mil dólares» o «prefiero no arriesgar»—, te armo una con los datos de hoy y te digo cómo encaja con este mercado.${ya}`,
      `Contame qué tanto riesgo te banca (podés escribirlo como te salga: «agresivo», «algo tranqui», «moderado con 5000 USD») y te armo una para compararla con este mercado.${ya}`,
    ]));
    return p.join(" ");
  }
  // 6-nov: si la vuelve a pedir, no repetir la misma frase palabra por palabra.
  const ops = [
    `${cap(hola)}contame cómo te llevás con el riesgo y te la armo con los datos de hoy.${ya} Podés escribirlo como te salga, por ejemplo «agresivo con 10 mil dólares» o «prefiero no arriesgar mucho».`,
    `${cap(hola)}para armarla necesito saber qué tanto riesgo te banca.${ya} Decímelo con tus palabras: «moderado, 5000 USD», «quiero ir a fondo», «algo tranqui»…`,
    `Dale${nombre ? `, ${nombre}` : ""}. ¿Qué tan arriesgado querés que sea?${ya} Si me decís también con cuánto vas a invertir, te paso los montos; por ejemplo «conservador con $200.000 pesos».`,
  ].map(cap);
  const quedan = evitar ? ops.filter(o => o !== evitar) : ops;
  return R.pick(quedan.length ? quedan : ops);
}

/** Cuando el mensaje no trae un perfil reconocible, sin volver a tirar el menú. */
export function repreguntar(texto, { semilla } = {}) {
  const R = _red.azar(`${semilla || ""}|${texto}`);
  return R.pick([
    `No me quedó claro qué tanto riesgo querés asumir con «${String(texto).slice(0, 40)}». ¿Lo pensás más bien tranqui, en el medio o a fondo?`,
    "Perdón, no llegué a entender el perfil. ¿Te inclinás por cuidar el capital, por algo equilibrado o por buscar el máximo rendimiento aunque haya más riesgo?",
    "No lo pesqué del todo. Decímelo como quieras, por ejemplo «poco riesgo», «moderado» o «agresivo con 10 mil».",
  ]);
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/**
 * La cartera armada, en lenguaje natural.
 * @param {Array} cartera   armarCartera(...)
 * @param {object} op       { perfil, capital, riesgoCartera, riesgoGlobal, semilla, nombre, ajuste, intro }
 *   intro: una frase que va adelante (p. ej. «no encontré la anterior…»).
 */
export function redactarCartera(cartera, op = {}) {
  const R = _red.azar(op.semilla || "cartera");
  if (!cartera.length) {
    return `Todavía no tengo los datos del mercado de este ciclo para armarla${op.riesgoGlobal != null ? ` (el riesgo global está en ${Math.round(op.riesgoGlobal * 100)}%)` : ""}. Dame unos minutos y volvé a pedírmela.`;
  }
  const conMonto = cartera.every(a => a.monto != null);
  const items = cartera.map(a => {
    const s = sectorES(a.sector);
    return `${a.symbol} ${a.peso_pct}%${conMonto ? ` (${formatoMonto(a.monto, op.capital?.moneda)})` : ""}${s ? ` — ${s.toLowerCase()}` : ""}`;
  });
  const p = [];
  if (op.intro) p.push(op.intro);
  const quien = op.perfil ? `perfil ${op.perfil}` : "tu perfil";
  const plata = op.capital ? ` con ${op.capital.texto}` : "";
  p.push(op.ajuste
    ? R.pick([`Listo, la ajusté a ${quien}${plata}: ${lista(items)}.`, `Hecho. Para ${quien}${plata} quedaría así: ${lista(items)}.`])
    : R.pick([
      `Para ${quien}${plata}, te la armaría así: ${lista(items)}.`,
      `Pensando en ${quien}${plata}, esta es la cartera que veo hoy: ${lista(items)}.`,
      `Te propongo esto para ${quien}${plata}: ${lista(items)}.`,
    ]));
  const criterio = op.perfil === "conservador"
    ? "Elegí los de menor volatilidad, repartidos en partes iguales para no depender de uno solo."
    : op.perfil === "agresivo"
      ? "Prioricé los que vienen con más impulso, que también son los que más se pueden mover en contra."
      : "Mezclé los de menor riesgo con los que vienen con más impulso, en partes iguales.";
  p.push(criterio);
  const suben = cartera.filter(a => a.cambio_pct > 0).length;
  const extras = [];
  if (op.riesgoCartera != null) extras.push(`el riesgo estimado de la cartera es ${num(op.riesgoCartera, 0)}%`);
  extras.push(`${suben} de los ${cartera.length} ${suben === 1 ? "viene" : "vienen"} en alza hoy`);
  if (op.riesgoGlobal != null) extras.push(`el riesgo global del mercado está en ${Math.round(op.riesgoGlobal * 100)}% (${nivelRiesgo(op.riesgoGlobal)})`);
  p.push(cap(lista(extras)) + ".");
  if (!op.capital) p.push(R.pick([
    "Si me decís con cuánto pensás invertir, te paso cuánto iría a cada uno.",
    "Si querés, decime el capital y te lo paso en montos.",
  ]));
  p.push(R.pick([
    "La guardé en el panel Portfolio; cuando quieras preguntame si sigue sirviendo para el mercado. Es análisis, no asesoramiento: la decisión es tuya.",
    "Queda guardada en el panel Portfolio para que la compares con el mercado cuando quieras. No es una recomendación de compra: la decisión es tuya.",
  ]));
  return p.join(" ").replace(/\s+/g, " ").trim();
}

export const _test = { lev, norm };

// ── La decisión de cada turno (pura, para probar conversaciones enteras) ──
const NO_ES_TEMA_NUEVO = new Set(["libre", "seguir", "negar", "gracias", "saludo", "portfolio", "presentacion"]);

/**
 * Qué hacer con este mensaje respecto de la cartera. Modifica `sesion`
 * (perfil, capital, paso) y devuelve la acción:
 *   {accion: "armar", ajuste}       → armar y publicar la cartera
 *   {accion: "preguntar"}           → preguntar el perfil (con ejemplos)
 *   {accion: "repreguntar"}         → no se entendió: preguntar de otra forma
 *   {accion: "nada"}                → no es sobre la cartera: sigue el router
 * @param {object} sesion  estado de la charla (paso, perfil, capital, carteraTs)
 * @param {string} texto
 * @param {object} it      intención del router (chat_router.clasificar)
 */
export function decidir(sesion, texto, it, ahora = Date.now()) {
  const dice = entender(texto);
  const palabras = String(texto || "").trim().split(/\s+/).filter(Boolean).length;
  const esperando = ["esperando_perfil", "esperando_riesgo", "esperando_capital"].includes(sesion.paso);
  const reciente = sesion.carteraTs && ahora - sesion.carteraTs < 30 * 60_000;
  const temaNuevo = !NO_ES_TEMA_NUEVO.has(it?.intencion);

  if (esperando) {
    // «no sé» sólo cuenta como respuesta si lo que faltaba era la plata.
    if (dice.perfil || dice.capital || (dice.sinCapital && sesion.perfil)) {
      if (dice.capital) sesion.capital = dice.capital;
      if (dice.perfil) sesion.perfil = dice.perfil;
      if (sesion.perfil) { sesion.paso = null; return { accion: "armar", ajuste: false }; }
      return { accion: "preguntar" };   // dijo la plata, falta el perfil
    }
    if (temaNuevo) { sesion.paso = null; return { accion: "nada" }; }
    return { accion: "repreguntar" };
  }
  if (reciente && palabras <= 10 && !temaNuevo && (dice.perfil || dice.capital)) {
    if (dice.capital) sesion.capital = dice.capital;
    if (dice.perfil) sesion.perfil = dice.perfil;
    return { accion: "armar", ajuste: true };
  }
  // «Soy agresivo», «mi perfil es conservador» suelto: está diciendo su perfil
  // de inversor, no charlando (6-nov: se iba al motor de lenguaje).
  const declara = it?.intencion === "libre" && dice.perfil && palabras <= 6
    && /\b(soy|mi perfil|perfil|me considero)\b/.test(norm(texto));
  const pide = it?.intencion === "portfolio" || declara
    || (it?.intencion === "libre" && dice.perfil && dice.capital && palabras <= 12);
  if (pide) {
    if (dice.perfil) sesion.perfil = dice.perfil;
    if (dice.capital) sesion.capital = dice.capital;
    if (sesion.perfil) { sesion.paso = null; return { accion: "armar", ajuste: false }; }
    sesion.paso = "esperando_perfil";
    return { accion: "preguntar" };
  }
  return { accion: "nada" };
}
