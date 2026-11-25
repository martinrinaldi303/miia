/**
 * chat_armado.js — cómo se arma el portafolio y cuánto tiempo se piensa tener
 * (13-nov-2026).
 *
 * Pedido de Martín: «que MIIA le dé las dos opciones de armado, automático por
 * IA o por el mismo usuario, y que el usuario pueda configurar los umbrales de
 * duración del portafolio cuando lo arma».
 *
 *   1. Al pedir un portafolio, MIIA pregunta: ¿lo armo yo (con los datos del
 *      sistema) o lo armás vos? Lo automático es el flujo de siempre
 *      (chat_perfil.js); lo manual entiende «SPY 50, QQQ 30, EWZ 20».
 *   2. Una vez armado, pregunta el PLAZO (corto / medio / largo) y acepta un
 *      umbral propio («avisame si más del 30 % está en venta»). Con eso se
 *      ajustan los umbrales de veredictoPortfolio (chat_portfolio.js): con
 *      plazo largo, una rueda mala pesa menos antes de decir «cambialo».
 *
 * Puro y sin dependencias, como el resto de los chat_*: se prueba sin levantar
 * nada (sim37 sección 8).
 */

function norm(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[¿¡?!.]/g, " ").replace(/\s+/g, " ").trim();
}

// ── 1 · ¿Quién lo arma? ───────────────────────────────────────────────────
const MODO_IA = /\b(automatic\w*|ia|inteligencia artificial|vos|armalo vos|armamelo|hacelo vos|elegi vos|elegilos vos|el sistema|miia|tu|tuyo|sugerime|recomendame|1)\b|^(a|opcion a|la a|la primera|primera)$/;
const MODO_MANUAL = /\b(manual\w*|yo mism[oa]|lo armo yo|los elijo yo|elijo yo|armo yo|mis propios|mi propia|personaliz\w*|a mano|2)\b|^(b|opcion b|la b|la segunda|segunda|yo)$/;

/** «automático» / «lo armo yo» → "ia" | "manual" | null. */
export function entenderModo(texto) {
  const t = norm(texto);
  if (!t) return null;
  const manual = MODO_MANUAL.test(t), ia = MODO_IA.test(t);
  if (manual && !ia) return "manual";
  if (ia && !manual) return "ia";
  return null;
}

// ── 2 · Los activos que elige el usuario ─────────────────────────────────
/**
 * «SPY 50, QQQ 30 y EWZ 20» → [{symbol, peso_pct}] que suma 100. Sin pesos, se
 * reparte parejo. Sólo instrumentos del universo (los únicos que MIIA mide).
 * @returns {{activos: Array, fuera: string[]}}
 */
// «sin EWZ», «sacá XLK»: ese ticker NO es parte de la cartera (13-nov-2026).
const NIEGA = new Set(["SIN", "MENOS", "EXCEPTO", "SALVO", "NO", "SACA", "SACAR", "SACALE", "QUITA", "QUITAR", "VENDER", "VENDO"]);
const esNumero = s => Number.isFinite(Number(String(s || "").replace(",", ".")));

export function entenderActivos(texto, universo = []) {
  const uni = new Set(universo.map(x => String(x).toUpperCase()));
  // Se conserva la grafía ORIGINAL: un ticker que el sistema no mide sólo se avisa
  // como «afuera» si el usuario lo escribió como ticker (en mayúsculas, o con un
  // peso al lado). Antes «quiero armar una cartera…» contestaba «dejé afuera ARMAR, UNA».
  const orig = String(texto || "").replace(/[,;+%]/g, " ").split(/\s+/).filter(Boolean);
  const tok = orig.map(o => o.toUpperCase());
  const activos = [], fuera = [], vistos = new Set();
  for (let i = 0; i < tok.length; i++) {
    const w = tok[i].replace(/[^A-Z0-9.]/g, "");
    if (!/^[A-Z]{2,5}$/.test(w)) continue;
    const previa = (tok[i - 1] || "").replace(/[^A-ZÁÉÍÓÚ]/g, "").normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (!uni.has(w)) {
      const pareceTicker = /[A-Z]/.test(orig[i]) && orig[i] === orig[i].toUpperCase() || esNumero(tok[i + 1]);
      if (pareceTicker && w.length >= 3 && !["CON", "LOS", "QUIERO", "PONE", "PONER"].includes(w)) fuera.push(w);
      continue;
    }
    if (NIEGA.has(previa)) continue;
    if (vistos.has(w)) continue;
    vistos.add(w);
    const n = Number(String(tok[i + 1] || "").replace(",", "."));
    activos.push({ symbol: w, peso: Number.isFinite(n) && n > 0 && n <= 100 ? n : null });
  }
  if (!activos.length) return { activos: [], fuera, explicitos: 0, sumaExplicita: 0 };
  const conPeso = activos.filter(a => a.peso != null);
  const suma = conPeso.reduce((s, a) => s + a.peso, 0);
  const sinPeso = activos.length - conPeso.length;
  const resto = Math.max(0, 100 - suma);
  const crudos = activos.map(a => a.peso != null ? a.peso : (sinPeso ? (conPeso.length ? resto : 100) / sinPeso : 0));
  const total = crudos.reduce((s, x) => s + x, 0) || 1;
  // Enteros que suman 100 exacto (resto mayor).
  const exactos = crudos.map(x => x * 100 / total);
  const ent = exactos.map(Math.floor);
  let falta = 100 - ent.reduce((s, x) => s + x, 0);
  exactos.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (falta > 0) { ent[i]++; falta--; } });
  return { activos: activos.map((a, i) => ({ symbol: a.symbol, peso_pct: ent[i] })).filter(a => a.peso_pct > 0), fuera,
           explicitos: conPeso.length, sumaExplicita: suma };
}

/**
 * ¿El mensaje DESCRIBE una cartera, o sólo nombra un ticker? (13-nov-2026)
 * «¿Conviene sacar XLK de mi cartera?» nombra XLK y dice «cartera», y antes
 * reemplazaba la cartera guardada por XLK 100 %. Una composición es: dos o más
 * activos con pesos escritos que suman ~100, o una lista de dos o más que no es
 * una pregunta. Un ticker solo dentro de una pregunta es una pregunta.
 */
export function pareceComposicion(lista, texto = "") {
  if (!lista?.activos?.length) return false;
  if ((lista.explicitos || 0) >= 2 && lista.sumaExplicita >= 95 && lista.sumaExplicita <= 105) return true;
  const pregunta = /[?¿]/.test(String(texto)) || /^(que|como|cual|cuanto|por que|y (el|la|los|las|si)|conviene|deberia|me conviene)\b/.test(norm(texto));
  if (pregunta) return false;
  return lista.activos.length >= 2 || (lista.explicitos || 0) >= 1;
}

// Verbo de ARMAR un portafolio: «armame…», «quiero un portfolio con…», «invertir en…».
const ARMA_VERBO = /\b(armame\w*|armar|arma|armo|armemos|armalo|hace(me)? (un|una)|quiero (un|una) (nuev[oa] )?(portafolio|portfolio|porfolio|cartera)|(un|una|nuev[oa]) (portafolio|portfolio|porfolio|cartera) con|invertir en)\b/;
const POSESIVO = /\b(mi|mis) (portafolio|portfolio|porfolio|cartera|inversion\w*)\b/;

// ── 3 · El plazo y los umbrales ───────────────────────────────────────────
// Los umbrales de veredictoPortfolio según el plazo. Lo de por defecto (medio)
// es lo que ya usaba chat_portfolio. Con plazo corto se avisa antes; con largo
// hace falta más peso en contra para decir «cambialo», porque a ese plazo una
// lectura de 24-48 h del ranking es casi ruido.
export const PLAZOS = {
  corto: { etiqueta: "corto (semanas)",        contraCambiar: 0.30, contraEsperar: 0.15, ruedas: 5 },
  medio: { etiqueta: "medio (1 a 3 meses)",    contraCambiar: 0.40, contraEsperar: 0.20, ruedas: 21 },
  largo: { etiqueta: "largo (más de 3 meses)", contraCambiar: 0.60, contraEsperar: 0.30, ruedas: 63 },
};

/** «a un mes», «largo plazo», «unas semanas», «un año» → "corto"|"medio"|"largo"|null. */
export function entenderPlazo(texto) {
  const t = norm(texto);
  if (/\b(corto( plazo)?|(unas?|pocas?|1|2|3|dos|tres) semanas?|semanal\w*|dias|trading|rapido)\b|^1$/.test(t)) return "corto";
  if (/\b(largo( plazo)?|anos?|ano|un ano|(6|seis|12|doce|9|nueve|4|cuatro|5|cinco) meses|varios meses|mucho tiempo|jubil\w*)\b|^3$/.test(t)) return "largo";
  if (/\b(medio( plazo)?|mediano( plazo)?|(un|1|2|dos|3|tres) mes(es)?|mensual\w*|un par de meses|trimestr\w*)\b|^2$/.test(t)) return "medio";
  return null;
}

/** «avisame si más del 35 % está en venta» → 0.35, o null. */
export function entenderUmbral(texto) {
  const t = norm(texto);
  const m = t.match(/(\d{1,2}(?:[.,]\d)?)\s*(%|por ?ciento)/);
  if (!m) return null;
  if (!/(venta|contra|avis|cambi|revis|alert|umbral|baj)/.test(t)) return null;
  const v = Number(m[1].replace(",", ".")) / 100;
  return v >= 0.05 && v <= 0.95 ? v : null;
}

/** Lo que entiende de la configuración, o null si no dijo nada de eso. */
export function entenderConfig(texto) {
  const plazo = entenderPlazo(texto), umbral = entenderUmbral(texto);
  if (!plazo && umbral == null) return null;
  return { ...(plazo ? { plazo } : {}), ...(umbral != null ? { contraCambiar: umbral } : {}) };
}

/** Configuración guardada → umbrales que usa veredictoPortfolio. */
export function umbralesPara(config) {
  const base = PLAZOS[config?.plazo] || PLAZOS.medio;
  const contraCambiar = Number.isFinite(config?.contraCambiar) ? config.contraCambiar : base.contraCambiar;
  // El «esperá» queda a la mitad del «cambialo» si el usuario puso el suyo.
  const contraEsperar = Number.isFinite(config?.contraCambiar) ? Math.min(base.contraEsperar, contraCambiar / 2) : base.contraEsperar;
  return { contraCambiar, contraEsperar, plazo: config?.plazo || "medio", personalizado: Number.isFinite(config?.contraCambiar) };
}

/** Valida lo que viene de disco o de la web. */
export function normalizarConfig(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  if (PLAZOS[c.plazo]) out.plazo = c.plazo;
  const v = Number(c.contraCambiar);
  if (Number.isFinite(v) && v >= 0.05 && v <= 0.95) out.contraCambiar = Math.round(v * 100) / 100;
  return Object.keys(out).length ? out : null;
}

// ── 4 · Lo que dice MIIA ──────────────────────────────────────────────────
const pct = x => `${Math.round(x * 100)}%`;
function pick(arr, semilla) { let h = 0; for (const c of String(semilla || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return arr[h % arr.length]; }

export function preguntarModo({ semilla = "", nombre = null } = {}) {
  const hola = nombre ? `${nombre}, ` : "";
  return pick([
    `Dale, ${hola}¿cómo preferís armarlo? A) Lo armo yo, con IA y los datos del sistema según tu perfil. B) Lo armás vos: decime qué ETFs y qué porcentaje (por ejemplo «SPY 50, QQQ 30, EWZ 20») y yo lo analizo.`,
    `Lo podemos armar de dos formas, ${hola}elegí: A) automático, lo arma MIIA con el ranking y tu perfil de riesgo, o B) a tu manera, me pasás los ETFs y los pesos («XLK 40, XLV 30, EWZ 30») y te digo cómo encaja con el mercado.`,
  ], semilla);
}

export function preguntarActivos({ semilla = "", fuera = [] } = {}) {
  const nota = fuera.length ? ` (${fuera.slice(0, 3).join(", ")} no ${fuera.length > 1 ? "están" : "está"} entre los 50 ETFs que mido)` : "";
  return pick([
    `Perfecto, armalo vos${nota}. Pasame los ETFs con su porcentaje, por ejemplo «SPY 50, QQQ 30, EWZ 20». Si no ponés porcentajes, los reparto parejo.`,
    `Dale${nota}. Decime qué ETFs querés y cuánto de cada uno, tipo «XLK 40 XLV 30 GDX 30». Sin porcentajes, va todo en partes iguales.`,
  ], semilla);
}

export function preguntarPlazo({ semilla = "" } = {}) {
  return pick([
    "¿Por cuánto tiempo pensás mantenerlo? 1) corto, semanas; 2) medio, 1 a 3 meses; 3) largo, más de 3 meses. Con eso ajusto cuándo te digo que lo revises. Si querés tu propio umbral, decime «avisame si más del 30 % está en venta».",
    "Una cosa más: ¿a qué plazo lo pensás? Corto (semanas), medio (1-3 meses) o largo (más de 3 meses). Según eso, más o menos sensible te aviso si conviene cambiarlo. También podés fijar el tuyo: «avisame si más del 35 % está en zona de venta».",
  ], semilla);
}

export function confirmarConfig(config, { semilla = "" } = {}) {
  const u = umbralesPara(config);
  const p = PLAZOS[u.plazo];
  return pick([
    `Listo: plazo ${p.etiqueta}. Te voy a decir que lo cambies cuando ${pct(u.contraCambiar)} o más del portafolio esté en la zona de venta del ranking (y que esperes desde ${pct(u.contraEsperar)})${u.personalizado ? ", como pediste" : ""}. Lo podés cambiar cuando quieras: «pasalo a largo plazo» o «avisame si más del 25 % está en venta». Preguntame «¿lo cambio?» cuando quieras la lectura.`,
    `Anotado, plazo ${p.etiqueta}: el aviso de «cambialo» salta con ${pct(u.contraCambiar)} del portafolio en zona de venta, y el de «esperá» con ${pct(u.contraEsperar)}${u.personalizado ? " (tu umbral)" : ""}. Si querés otro plazo o tu propio porcentaje, decímelo. Para la lectura del día, preguntame «¿conviene cambiarlo?».`,
  ], semilla);
}

/**
 * El turno del armado. Va ANTES que el flujo de perfil de siempre.
 * @returns {{accion: "nada"|"preguntar_modo"|"preguntar_activos"|"armar_manual"|"seguir_ia"|"config"|"preguntar_plazo",
 *            activos?, fuera?, config?}}
 */
export function decidirArmado(sesion, texto, it, { universo = [], perfilDicho = false } = {}) {
  const t = norm(texto);
  const modo = entenderModo(texto);
  const cfg = entenderConfig(texto);
  const lista = entenderActivos(texto, universo);
  // Mientras MIIA espera la lista, «XLK, XLV» o «SPY 60 QQQ 40» son la lista;
  // «¿qué opinás de XLK?» es otra pregunta (antes armaba XLK 100 %).
  const esLista = pareceComposicion(lista, texto);
  const temaNuevo = !["libre", "seguir", "negar", "gracias", "portfolio", "mi_portfolio", "presentacion"].includes(it?.intencion)
    && !esLista;
  // 16-nov-2026: con el menú A/B abierto, «¿Debería vender todo?» o «¿Quién gana
  // el Mundial?» (el router los lee como `libre`) volvían a recibir el menú, una
  // y otra vez. Una pregunta larga o un mensaje largo que no nombra un modo ni
  // trae ETFs no es una respuesta al menú: es otro tema, y el menú se cierra.
  const palabras = t ? t.split(" ").length : 0;
  const modoFuerte = /(automatic|manual|opcion [ab]\b|armalo|armamelo|hacelo vos|lo armo yo|armo yo|elijo yo|a mano|inteligencia artificial)/.test(t);
  // Un modo dicho con todas las letras («automático», «lo armo yo») o en pocas
  // palabras («la A», «armalo vos») cuenta como respuesta aunque el router lo lea
  // como otra cosa («…con lo que veas mejor» suena a ranking).
  const respondeModo = !!modo && (modoFuerte || palabras <= 5);
  const otraCosa = !esLista && !respondeModo && !perfilDicho
    && (/\?/.test(String(texto || "")) ? palabras >= 3 : palabras > 6);
  const cerrarMenu = () => { sesion.paso = null; sesion.menuInsistencias = 0; return { accion: "nada" }; };
  // Una sola repregunta del menú: a la segunda que no contesta, se sigue la charla.
  const insistir = (r) => {
    sesion.menuInsistencias = (sesion.menuInsistencias || 0) + 1;
    if (sesion.menuInsistencias > 1) return cerrarMenu();
    return r;
  };

  // Esperando el plazo después de armar.
  if (sesion.paso === "esperando_plazo") {
    if (cfg) { sesion.paso = null; return { accion: "config", config: cfg }; }
    sesion.paso = null;
    if (/^(no|despues|mas tarde|da igual|no se|dejalo|cualquiera)\b/.test(t)) return { accion: "config", config: { plazo: "medio" } };
    // No contestó el plazo: sigue con lo que preguntó (queda en «medio»).
    return { accion: "nada" };
  }
  // Esperando qué modo de armado.
  if (sesion.paso === "esperando_modo") {
    if (esLista) { sesion.paso = null; sesion.menuInsistencias = 0; return { accion: "armar_manual", ...lista, config: cfg }; }
    if (otraCosa || (temaNuevo && !respondeModo && !perfilDicho)) return cerrarMenu();
    if (modo === "manual") { sesion.paso = "esperando_activos"; sesion.menuInsistencias = 0; return { accion: "preguntar_activos", fuera: lista.fuera }; }
    // Contestar con el perfil («moderado», «soy conservador») es elegir que lo arme MIIA.
    if (modo === "ia" || perfilDicho) { sesion.paso = null; sesion.menuInsistencias = 0; sesion.modoArmado = "ia"; return { accion: "seguir_ia", config: cfg }; }
    return insistir({ accion: "preguntar_modo" });
  }
  // Esperando la lista de ETFs.
  if (sesion.paso === "esperando_activos") {
    // Acá un ticker solo SÍ vale («XLK»): MIIA acaba de pedir la lista. Lo que no
    // vale es un ticker dentro de una pregunta.
    const pregunta = /[?¿]/.test(String(texto));
    if (esLista || (lista.activos.length && !pregunta)) { sesion.paso = null; sesion.menuInsistencias = 0; return { accion: "armar_manual", ...lista, config: cfg }; }
    if (otraCosa || (temaNuevo && !respondeModo && !perfilDicho)) return cerrarMenu();
    if (modo === "ia" || perfilDicho) { sesion.paso = null; sesion.menuInsistencias = 0; sesion.modoArmado = "ia"; return { accion: "seguir_ia", config: cfg }; }
    return insistir({ accion: "preguntar_activos", fuera: lista.fuera });
  }
  // Un pedido de portafolio nuevo: primero el modo, salvo que ya lo haya dicho.
  if (it?.intencion === "portfolio") {
    sesion.menuInsistencias = 0;
    if (lista.activos.length && (esLista || ARMA_VERBO.test(t))) return { accion: "armar_manual", ...lista, config: cfg };
    if (modo === "manual") { sesion.paso = "esperando_activos"; return { accion: "preguntar_activos", fuera: lista.fuera }; }
    // «Armame un portafolio, soy moderado con 10000»: si ya dio el perfil, quiere
    // que lo arme MIIA; el menú A/B sólo le haría repetir lo que ya dijo.
    if (modo === "ia" || perfilDicho || sesion.modoArmado === "ia") { sesion.modoArmado = "ia"; return { accion: "seguir_ia", config: cfg }; }
    sesion.paso = "esperando_modo";
    return { accion: "preguntar_modo" };
  }
  // «Quiero un portfolio con XLK y XLV»: el router lo lee como opinión por los
  // tickers, pero está armando uno a mano. Hace falta un verbo de ARMAR, o que
  // describa una composición con pesos («mi cartera es SPY 50 y QQQ 50»).
  // «¿Conviene sacar XLK de MI cartera?» o «¿cómo va XLK en mi cartera?» son
  // preguntas sobre la que YA tiene: van al análisis, no la reemplazan
  // (13-nov-2026: antes la pisaban con XLK 100 % y la guardaban en state/).
  if (lista.activos.length && /\b(portafolio|portfolio|porfolio|cartera|invertir)\b/.test(t)) {
    const armando = ARMA_VERBO.test(t) && !(POSESIVO.test(t) && !esLista);
    const declara = (lista.explicitos || 0) >= 2 && lista.sumaExplicita >= 95 && lista.sumaExplicita <= 105;
    if (armando || declara) return { accion: "armar_manual", ...lista, config: cfg };
  }
  // Cambiar el plazo o el umbral de SU portafolio en cualquier momento.
  if (cfg && (it?.intencion === "mi_portfolio" || /(portafolio|portfolio|porfolio|cartera|plazo|avisame|umbral)/.test(t))) {
    return { accion: "config", config: cfg };
  }
  return { accion: "nada" };
}

export const _test = { norm };
