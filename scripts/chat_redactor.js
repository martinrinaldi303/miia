/**
 * chat_redactor.js — redacta la respuesta del chat a partir de la evidencia,
 * sin motor de lenguaje.
 *
 * Puro (sólo importa chat_evidencia.js, que también lo es). Reemplaza a las
 * plantillas de `_fallbackConContexto`, que salían idénticas cada vez («Soy
 * MIIA, tu asistente…», «Con eso no tengo un dato preciso…») y que a veces ni
 * contestaban lo preguntado (la de «¿qué podés responder?» hablaba de ARGT).
 *
 * Cómo evita sonar a bot:
 *   • Contesta PRIMERO lo que se preguntó, con el número del sistema, y recién
 *     después da contexto. Nunca arranca con «Soy MIIA, tu asistente…».
 *   • Cada idea tiene varias formas de decirse, elegidas con una semilla por
 *     mensaje: la misma pregunta dos veces no da el mismo texto palabra por
 *     palabra, pero una prueba con semilla fija es reproducible.
 *   • Elige qué decir según los datos: si el ranking y el día se contradicen,
 *     lo dice; si las noticias acompañan o van en contra, lo dice.
 *   • Cierra, a veces, con una propuesta CONCRETA («¿querés que lo compare con
 *     SPY?») que queda guardada: si el usuario contesta «dale», se ejecuta.
 *   • No aconseja comprar ni vender: presenta lo que el sistema mide.
 */
import { num, pct, sectorES, regionES, vistaTicker, nivelRiesgo, _sentES } from "./chat_evidencia.js";

// ── Azar con semilla (mulberry32) ─────────────────────────────────────────
function _hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function azar(semilla) {
  let a = _hash(semilla) || 1;
  const sig = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
                      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { pick: arr => arr[Math.floor(sig() * arr.length)], chance: p => sig() < p, sig };
}

// ── Piezas comunes ────────────────────────────────────────────────────────
function lista(arr) {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} y ${a[a.length - 1]}`;
}
const ord = n => `${n}°`;
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

const LEGAL = [
  "Es lectura del sistema, no una recomendación.",
  "Tomalo como análisis, no como consejo de inversión.",
  "La decisión, como siempre, es tuya.",
  "No es asesoramiento: es lo que miden los modelos.",
  "Es análisis estadístico, no una garantía.",
];

// Peer natural para comparar (la propuesta de "¿querés que lo compare con…?").
function peerDe(v) {
  if (!v) return null;
  if (v.tk === "SPY") return "QQQ";
  const porRegion = { US: "SPY", LATAM: v.tk === "ILF" ? "EWZ" : "ILF", APAC: "EEM", EUROPE: "EFA", GLOBAL: "SPY" };
  const p = porRegion[v.regionCod];
  return p && p !== v.tk ? p : null;
}

function enRueda(ev) { return !!ev.datos.mercado?.abierto; }
function diaTxt(ev) { return enRueda(ev) ? "hoy" : "en la última rueda"; }

// ── Frases sobre un instrumento ───────────────────────────────────────────
function fraseRank(v, R) {
  const r = v.rank; if (!r) return null;
  const conf = r.conf != null ? `, con ${r.conf}% de confianza` : "";
  const aprox = r.aprox ? " (según el último ciclo guardado)" : "";
  if (r.zona === "arriba") return R.pick([
    `El ranking lo pone ${ord(r.puesto)} de ${r.n}, dentro de los ${r.k} que marco como BUY${conf}${aprox}.`,
    `Está ${ord(r.puesto)} de ${r.n} en el ranking —entre los ${r.k} con señal de compra—${conf}${aprox}.`,
    `En el ranking aparece ${ord(r.puesto)} de ${r.n}, o sea en la zona BUY${conf}${aprox}.`,
  ]);
  if (r.zona === "abajo") return R.pick([
    `Queda ${ord(r.puesto)} de ${r.n} en el ranking, entre los ${r.k} que marco como SELL${conf}${aprox}.`,
    `El ranking lo tiene ${ord(r.puesto)} de ${r.n}, en la zona de venta${conf}${aprox}.`,
    `Está ${ord(r.puesto)} de ${r.n}: de los ${r.k} peor ubicados, con señal SELL${conf}${aprox}.`,
  ]);
  return R.pick([
    `En el ranking está ${ord(r.puesto)} de ${r.n}, en la zona media, así que no le doy señal para ningún lado (HOLD)${aprox}.`,
    `Queda ${ord(r.puesto)} de ${r.n}: mitad de tabla, señal HOLD${aprox}.`,
    `Está a mitad de tabla en el ranking (${ord(r.puesto)} de ${r.n}), sin señal de compra ni de venta${aprox}.`,
  ]);
}

function fraseHoy(v, ev, R) {
  const h = v.hoy; if (!h) return null;
  const cuando = enRueda(ev) ? R.pick(["En la rueda va", "Hoy va", "En lo que va del día marca"]) : R.pick(["En la última rueda cerró", "La última rueda la terminó"]);
  if (h.relativo == null) return `${cuando} ${pct(h.cambio)}.`;
  const rel = Math.abs(h.relativo);
  if (h.relativo > 0.3) return `${cuando} ${pct(h.cambio)}, ${num(rel)} puntos mejor que el promedio de los ${h.nHoy} (${pct(h.mediaUniverso)}).`;
  if (h.relativo < -0.3) return `${cuando} ${pct(h.cambio)}, ${num(rel)} puntos peor que el promedio de los ${h.nHoy} (${pct(h.mediaUniverso)}).`;
  return `${cuando} ${pct(h.cambio)}, prácticamente igual que el promedio de los ${h.nHoy} (${pct(h.mediaUniverso)}).`;
}

function fraseSent(v, R) {
  const s = v.sent; if (!s) return null;
  const tono = _sentES(s.label);
  const arts = s.n ? ` (${s.n} artículo${s.n === 1 ? "" : "s"})` : "";
  const alineado = (tono === "positivo" && v.postura === "fuerte") || (tono === "negativo" && v.postura === "debil");
  const opuesto  = (tono === "positivo" && v.postura === "debil") || (tono === "negativo" && v.postura === "fuerte");
  if (tono === "neutral") return R.pick([`En las noticias el tono es neutral${arts}.`, `Las noticias no empujan para ningún lado${arts}.`]);
  if (alineado) return R.pick([`Las noticias acompañan: sentimiento ${tono}${arts}.`, `Y el tono de las noticias va en la misma dirección (${tono}${arts}).`]);
  if (opuesto) return R.pick([`Las noticias, en cambio, van para el otro lado: sentimiento ${tono}${arts}.`, `Ojo que las noticias dicen otra cosa: tono ${tono}${arts}.`]);
  return `En noticias, el sentimiento es ${tono}${arts}.`;
}

function fraseRiesgo(v, R) {
  const r = v.riesgo; if (!r) return null;
  return R.pick([
    `Como dato de riesgo, su volatilidad es ${num(r.vol, 0)}% anual y la peor caída de los últimos 60 días fue ${num(r.dd, 0)}%${r.nivel ? ` (riesgo ${r.nivel})` : ""}.`,
    `De riesgo: volatilidad ${num(r.vol, 0)}% anual y caída máxima ${num(r.dd, 0)}% en 60 días${r.nivel ? `, un nivel ${r.nivel}` : ""}.`,
  ]);
}

function fraseContradice(v, R) {
  if (!v.contradice) return null;
  const arriba = v.rank.zona === "arriba";
  return R.pick([
    `Fijate que hay una diferencia: el ranking mira las próximas 24 a 48 horas, no el día, por eso lo tiene ${arriba ? "arriba aunque hoy venga peor que el resto" : "abajo aunque hoy venga mejor que el resto"}.`,
    `El ranking y el día no coinciden acá: ${arriba ? "lo ubica bien aunque hoy flojee" : "lo ubica mal aunque hoy le vaya bien"}, porque ordena lo que espera para las próximas 24-48 horas.`,
  ]);
}

function fraseHonestidad(ev, R) {
  const m = ev.datos.metricas;
  if (!m || m.signif) return null;
  return R.pick([
    "Tené en cuenta que todavía no tengo una ventaja demostrada sobre el promedio, así que tomalo con pinzas.",
    "Un detalle honesto: mi acierto todavía no se distingue del azar, así que es una lectura, no una certeza.",
  ]);
}

function apertura(v, R) {
  const tk = v.tk;
  if (v.contradice) return R.pick([`Con ${tk} la lectura es mixta.`, `${tk} manda señales cruzadas.`, `${tk} tiene una lectura con matices.`]);
  if (v.postura === "fuerte") return R.pick([`A ${tk} lo veo del lado fuerte.`, `${tk} viene bien parado.`, `Hoy el sistema tiene a ${tk} entre lo mejor que mira.`, `Con ${tk} la lectura es positiva.`]);
  if (v.postura === "debil")  return R.pick([`A ${tk} lo veo flojo.`, `${tk} hoy está del lado débil.`, `Con ${tk} el sistema no está entusiasmado.`, `La lectura de ${tk} es negativa.`]);
  return R.pick([`${tk} está en tierra de nadie.`, `Con ${tk} no veo nada que lo destaque para un lado ni para el otro.`, `${tk} hoy está neutral.`, `De ${tk} no tengo una lectura fuerte.`]);
}

function sinDatosTicker(v, ev, R) {
  const quien = v.nombre ? `${v.tk} (${v.nombre})` : v.tk;
  if (!v.enUniverso) return `${v.tk} no está entre los 50 instrumentos que mido, así que no tengo análisis propio para darte.`;
  return R.pick([
    `De ${quien} todavía no me llegó una lectura en este ciclo: el ranking y las cotizaciones se completan en cuanto entra el próximo dato del mercado (cada ~90 s). Si me preguntás en un rato, te lo doy con número.`,
    `Todavía no tengo datos frescos de ${quien}: el sistema los va completando con cada ciclo de cotizaciones. Probá de nuevo en un par de minutos.`,
  ]);
}

// ── Una opinión sobre un instrumento ──────────────────────────────────────
function opinionTicker(v, ev, R, op = {}) {
  if (!v.tieneDatos) return { texto: sinDatosTicker(v, ev, R) };
  const partes = [];
  if (op.queEs && v.nombre) partes.push(`${v.tk} es el ETF de ${v.nombre}${v.region ? ` (${v.region})` : ""}.`);
  if (!op.sinApertura) partes.push(apertura(v, R));
  const cuerpo = [fraseRank(v, R), fraseHoy(v, ev, R)].filter(Boolean);
  partes.push(...cuerpo);
  const extra = [fraseContradice(v, R), fraseSent(v, R), fraseRiesgo(v, R)].filter(Boolean);
  partes.push(...extra.slice(0, op.detalle > 1 ? 3 : 2));
  if (R.chance(0.35)) { const h = fraseHonestidad(ev, R); if (h) partes.push(h); }
  if (!op.sinLegal) partes.push(R.pick(LEGAL));
  let oferta = null;
  if (!op.sinOferta && R.chance(0.6)) {
    const peer = peerDe(v);
    if (peer && R.chance(0.5)) { partes.push(R.pick([`¿Querés que lo compare con ${peer}?`, `Si querés, lo pongo al lado de ${peer}.`])); oferta = { intencion: "comparar", tickers: [v.tk, peer] }; }
    else if (v.rank) { partes.push(R.pick(["¿Te cuento qué lo pone ahí?", "¿Querés que te explique por qué está en ese puesto?"])); oferta = { intencion: "porque", tickers: [v.tk] }; }
  }
  return { texto: partes.join(" "), oferta };
}

// ── Un grupo ("Estados Unidos", "tecnología") ─────────────────────────────
function opinionGrupo(g, ev, R) {
  if (g.vistas.length === 1) {
    const v = g.vistas[0];
    const intro = R.pick([`Para ${g.etiqueta} miro ${v.tk}${v.nombre ? `, el ETF de ${v.nombre}` : ""}.`, `En ${g.etiqueta} uso ${v.tk} como referencia.`]);
    const r = opinionTicker(v, ev, R, { sinApertura: false });
    return { texto: `${intro} ${r.texto}`, oferta: r.oferta };
  }
  if (!g.tieneDatos) return { texto: `De ${g.etiqueta} (${lista(g.vistas.map(v => v.tk))}) todavía no tengo datos frescos en este ciclo; se completan con el próximo dato del mercado.` };
  const p = [];
  p.push(R.pick([
    `Sobre ${g.etiqueta} miro ${g.vistas.length} instrumentos: ${lista(g.vistas.map(v => v.tk))}.`,
    `Para ${g.etiqueta} uso ${lista(g.vistas.map(v => v.tk))}.`,
  ]));
  if (g.mediaHoy != null) {
    const rel = g.mediaUniverso != null ? g.mediaHoy - g.mediaUniverso : null;
    const comp = rel == null ? "" : rel > 0.3 ? `, mejor que el resto del universo (${pct(g.mediaUniverso)})` : rel < -0.3 ? `, peor que el resto del universo (${pct(g.mediaUniverso)})` : `, en línea con el resto (${pct(g.mediaUniverso)})`;
    p.push(`${cap(diaTxt(ev))} promedian ${pct(g.mediaHoy)}${comp}; el que mejor va es ${g.mejorHoy.tk} (${pct(g.mejorHoy.hoy.cambio)}) y el que peor, ${g.peorHoy.tk} (${pct(g.peorHoy.hoy.cambio)}).`);
  }
  if (g.conRank.length) {
    const arr = g.arriba.map(v => `${v.tk} (${ord(v.rank.puesto)})`), abj = g.abajo.map(v => `${v.tk} (${ord(v.rank.puesto)})`);
    if (arr.length && abj.length) p.push(`En el ranking, ${lista(arr)} ${arr.length > 1 ? "están" : "está"} entre los mejores y ${lista(abj)} entre los peores.`);
    else if (arr.length) p.push(`En el ranking, ${lista(arr)} ${arr.length > 1 ? "están" : "está"} en la zona BUY; el resto, a mitad de tabla.`);
    else if (abj.length) p.push(`En el ranking, ${lista(abj)} ${abj.length > 1 ? "están" : "está"} en la zona SELL; el resto, a mitad de tabla.`);
    else p.push(`En el ranking ninguno está en los extremos: el mejor ubicado es ${g.mejorRank.tk} (${ord(g.mejorRank.rank.puesto)} de ${g.mejorRank.rank.n}) y el más rezagado ${g.peorRank.tk} (${ord(g.peorRank.rank.puesto)}).`);
  }
  const balance = g.arriba.length - g.abajo.length + (g.mediaHoy != null && g.mediaUniverso != null ? Math.sign(Math.round((g.mediaHoy - g.mediaUniverso) * 2)) : 0);
  p.push(balance >= 2 ? R.pick(["En conjunto, el bloque viene bien.", "Como bloque, lo veo del lado fuerte."])
       : balance <= -2 ? R.pick(["En conjunto, el bloque viene flojo.", "Como bloque, lo veo del lado débil."])
       : R.pick(["En conjunto, no hay una señal clara para el bloque.", "Como bloque, no tiene una dirección definida."]));
  p.push(R.pick(LEGAL));
  let oferta = null;
  if (g.mejorRank && R.chance(0.6)) { p.push(`¿Querés que me meta en ${g.mejorRank.tk}?`); oferta = { intencion: "opinion", tickers: [g.mejorRank.tk] }; }
  return { texto: p.join(" "), oferta };
}

// ── Composición por intención ─────────────────────────────────────────────
const C = {};

C.opinion = (it, ev, R, op) => {
  const vs = ev.datos.vistas || [], gs = ev.datos.grupos || [];
  if (!vs.length && !gs.length) return C.resumen(it, ev, R, op);
  if (vs.length === 1 && !gs.length) return opinionTicker(vs[0], ev, R, { queEs: it.subtipo === "que_es", detalle: op.detalle });
  if (!vs.length && gs.length === 1) return opinionGrupo(gs[0], ev, R);
  // Varias cosas a la vez: una línea por cada una.
  const textos = [...vs.map(v => opinionTicker(v, ev, R, { sinLegal: true, sinOferta: true }).texto),
                  ...gs.map(g => opinionGrupo(g, ev, R).texto)];
  return { texto: `${textos.join(" ")} ${R.pick(LEGAL)}` };
};

C.senal = (it, ev, R, op) => {
  const v = (ev.datos.vistas || [])[0];
  if (!v) return C.opinion(it, ev, R, op);
  if (!v.rank) return opinionTicker(v, ev, R, op);
  const r = v.rank;
  const zona = r.zona === "arriba" ? "BUY" : r.zona === "abajo" ? "SELL" : "HOLD";
  const p = [R.pick([`La señal de ${v.tk} ahora es ${zona}.`, `Para ${v.tk} el sistema marca ${zona}.`])];
  p.push(fraseRank(v, R));
  const h = fraseHoy(v, ev, R); if (h) p.push(h);
  const c = fraseContradice(v, R); if (c) p.push(c);
  p.push(R.pick(LEGAL));
  return { texto: p.join(" "), oferta: { intencion: "porque", tickers: [v.tk] } };
};

C.precio = (it, ev, R, op) => {
  const v = (ev.datos.vistas || [])[0];
  if (!v) return C.opinion(it, ev, R, op);
  if (!v.hoy?.precio) return v.hoy ? { texto: `De ${v.tk} tengo el cambio del día (${pct(v.hoy.cambio)}) pero no el precio en este momento. ${fraseRank(v, R) || ""}`.trim() } : { texto: sinDatosTicker(v, ev, R) };
  const p = [R.pick([
    `${v.tk} cotiza a US$ ${num(v.hoy.precio, 2)}, ${pct(v.hoy.cambio)} ${enRueda(ev) ? "en el día" : "en la última rueda"}.`,
    `${v.tk} está en US$ ${num(v.hoy.precio, 2)} (${pct(v.hoy.cambio)} ${enRueda(ev) ? "hoy" : "en la última rueda"}).`,
  ])];
  if (v.hoy.relativo != null) p.push(v.hoy.relativo > 0.3 ? `Le va mejor que al promedio de los ${v.hoy.nHoy} (${pct(v.hoy.mediaUniverso)}).` : v.hoy.relativo < -0.3 ? `Le va peor que al promedio de los ${v.hoy.nHoy} (${pct(v.hoy.mediaUniverso)}).` : `En línea con el promedio (${pct(v.hoy.mediaUniverso)}).`);
  if (v.rank && R.chance(0.7)) p.push(fraseRank(v, R));
  if (!enRueda(ev)) p.push("Es el precio del último cierre: el NYSE está cerrado.");
  return { texto: p.join(" ") };
};

C.riesgo = (it, ev, R, op) => {
  const vs = ev.datos.vistas || [];
  if (vs.length) {
    const v = vs[0];
    if (v.riesgo) {
      const r = v.riesgo;
      const p = [R.pick([
        `El riesgo de ${v.tk} es ${(r.nivel || "moderado").toUpperCase()}: volatilidad ${num(r.vol, 0)}% anual y una caída máxima de ${num(r.dd, 0)}% en los últimos 60 días${r.indice != null ? ` (índice ${Math.round(r.indice)}/100)` : ""}.`,
        `${v.tk} tiene un riesgo ${r.nivel || "moderado"}: se mueve con una volatilidad de ${num(r.vol, 0)}% anual y en 60 días llegó a caer ${num(r.dd, 0)}% desde su máximo${r.indice != null ? ` (índice ${Math.round(r.indice)}/100)` : ""}.`,
      ])];
      if (ev.datos.riesgo != null) p.push(`Es distinto del riesgo global del mercado, que está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).`);
      if (v.hoy) p.push(`${cap(diaTxt(ev))} va ${pct(v.hoy.cambio)}.`);
      p.push(R.pick(["Es lo que el activo hizo, no un pronóstico.", "Mide el pasado reciente, no lo que va a pasar."]));
      // ORDEN 7 grupo A: lo único que sí se predice es CUÁNTO se mueve (sim56).
      if (r.vol2d != null && r.ratio != null)
        p.push(`Para los próximos 2 días calculo un movimiento típico de ±${num(r.vol2d, 1)}%, ${r.ratio >= 1.25 ? "más de lo que suele moverse" : r.ratio <= 0.8 ? "menos de lo que suele moverse" : "parecido a lo habitual"}; eso dice cuánto, no hacia dónde.`);
      return { texto: p.join(" ") };
    }
    // Sin la medición de 60 días: lo que sí hay, sin inventar.
    const p = [`La medición de volatilidad de 60 días de ${v.tk} no la tengo a mano en este momento.`];
    if (v.hoy) p.push(`Lo que sí veo: ${diaTxt(ev)} va ${pct(v.hoy.cambio)}${v.hoy.relativo != null ? ` contra ${pct(v.hoy.mediaUniverso)} del promedio` : ""}.`);
    if (v.rank) p.push(fraseRank(v, R));
    if (ev.datos.riesgo != null) p.push(`El riesgo global del mercado está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).`);
    if (it.heredado) p.push(`Si me preguntás «¿qué riesgo tiene ${v.tk}?» te traigo la volatilidad y la caída máxima.`);
    return { texto: p.join(" ") };
  }
  if ((ev.datos.grupos || []).length) return C.opinion(it, ev, R, op);
  // Riesgo del mercado en general.
  const h = ev.datos.hoy, p = [];
  if (ev.datos.riesgo != null) p.push(R.pick([
    `El riesgo global del mercado está en ${Math.round(ev.datos.riesgo * 100)}%, un nivel ${ev.datos.nivel}.`,
    `Ahora mismo mido el riesgo global en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).`,
  ]));
  // «¿Es mucho?» (13-nov-2026): la escala, para que el número se pueda leer.
  if (it?.subtipo === "magnitud" && ev.datos.riesgo != null) {
    const r = ev.datos.riesgo;
    p.push(`La escala va de 0 a 100%: hasta 45% lo leo como bajo, hasta 70% moderado y arriba de 70% alto${r > 0.7 ? ", así que sí, es mucho" : r > 0.45 ? ", así que es un nivel intermedio" : ", así que es poco"}.`);
    p.push("No es la probabilidad de perder plata: resume qué tan tenso está el mercado en su conjunto (caídas, dispersión entre instrumentos y alertas activas).");
  }
  if (ev.datos.alertas?.length) p.push(`Hay una alerta activa: ${ev.datos.alertas[0]}.`);
  if (h) {
    p.push(`${cap(diaTxt(ev))} ${h.positivos > h.n / 2 ? "suben" : "bajan"} ${h.positivos > h.n / 2 ? h.positivos : h.negativos} de ${h.n} instrumentos y el promedio da ${pct(h.media)}.`);
    p.push(`Lo más castigado: ${lista(h.peores.map(x => `${x.tk} (${pct(x.cambio)})`))}.`);
  }
  if (!p.length) return C.libre(it, ev, R, op);
  p.push(R.pick(["Es una foto del momento, no un pronóstico.", "Si querés el riesgo de un instrumento puntual, nombrámelo y te paso su volatilidad."]));
  return { texto: p.join(" ") };
};

C.noticias = (it, ev, R, op) => {
  const vs = ev.datos.vistas || [];
  const v = vs[0] || (ev.datos.grupos?.[0]?.vistas || []).find(x => x.sent || x.titulares);
  if (v) {
    const p = [];
    if (v.sent) p.push(R.pick([
      `Sobre ${v.tk}, el tono de las noticias es ${_sentES(v.sent.label)}${v.sent.n ? ` (${v.sent.n} artículos)` : ""}.`,
      `Las noticias de ${v.tk} vienen con sentimiento ${_sentES(v.sent.label)}${v.sent.n ? `, sobre ${v.sent.n} artículos` : ""}.`,
    ]));
    if (v.titulares?.length) {
      const t0 = v.titulares[0];
      p.push(`El titular más reciente que procesé: «${String(t0.titulo).slice(0, 140)}»${t0.fuente ? ` (${t0.fuente}${t0.fecha ? `, ${t0.fecha}` : ""})` : ""}.`);
    }
    if (!p.length) p.push(`De ${v.tk} no tengo noticias procesadas en las últimas 48 horas.`);
    if (v.hoy) p.push(`En precio, ${diaTxt(ev)} va ${pct(v.hoy.cambio)}.`);
    if (v.rank && R.chance(0.6)) p.push(fraseRank(v, R));
    return { texto: p.join(" ") };
  }
  const s = ev.datos.sentimientoGeneral || [];
  if (s.length) {
    const pos = s.filter(x => /BULL/.test(x.label)), neg = s.filter(x => /BEAR/.test(x.label));
    // Antes decía «7 con tono positivo» y nombraba sólo 4 (5-nov-2026): ahora
    // nombra todos hasta 8, y con «dame el detalle» cada uno con sus artículos.
    const nombres = arr => arr.length <= 8 ? lista(arr.map(x => x.tk))
      : `${arr.slice(0, 6).map(x => x.tk).join(", ")} y ${arr.length - 6} más`;
    if ((it.detalle || 1) >= 2) {
      const uno = x => `${x.tk}${x.n ? ` (${x.n} artículo${x.n === 1 ? "" : "s"})` : ""}`;
      const p = [];
      if (pos.length) p.push(`Con tono positivo: ${lista(pos.map(uno))}.`);
      if (neg.length) p.push(`Con tono negativo: ${lista(neg.map(uno))}.`);
      const neu = s.length - pos.length - neg.length;
      if (neu > 0) p.push(`Otros ${neu} vienen neutros.`);
      p.push("Si querés el último titular de alguno, nombrámelo.");
      return { texto: p.join(" ") };
    }
    return { texto: `En las noticias que vengo procesando, ${pos.length} instrumento${pos.length === 1 ? "" : "s"} tienen tono positivo (${nombres(pos) || "ninguno"}) y ${neg.length} negativo (${nombres(neg) || "ninguno"}). Si querés el detalle de uno, nombrámelo.` };
  }
  return { texto: "Ahora no tengo un resumen de noticias armado. Si me nombrás un instrumento (por ejemplo XLK o Argentina), te digo el tono de sus noticias y el último titular que procesé." };
};

C.porque = (it, ev, R, op) => {
  const v = (ev.datos.vistas || [])[0];
  if (v && v.rank) {
    const r = v.rank;
    const lado = r.zona === "arriba" ? "arriba" : r.zona === "abajo" ? "abajo" : "a mitad de tabla";
    const p = [R.pick([
      `${v.tk} está ${ord(r.puesto)} de ${r.n} porque las redes que leen el mercado, cuando lo comparan con los otros ${r.n - 1} instrumentos, lo ubican ${lado}.`,
      `El puesto de ${v.tk} (${ord(r.puesto)} de ${r.n}) sale de comparar a los ${r.n} instrumentos entre sí: las redes lo dejan ${lado} en esa comparación.`,
    ])];
    p.push(R.pick([
      "No es por cómo viene el día: el ranking ordena lo que espera que le gane al promedio en las próximas 24 a 48 horas.",
      "Ojo, no es un reflejo del día: lo que ordena el ranking es qué espera que rinda mejor que el promedio en 24 a 48 horas.",
    ]));
    const a = [], c = [];
    if (v.hoy?.relativo != null && Math.abs(v.hoy.relativo) >= 0.3 && r.zona !== "medio")
      ((v.hoy.relativo > 0) === (r.zona === "arriba") ? a : c)
        .push(`${diaTxt(ev)} va ${pct(v.hoy.cambio)} contra ${pct(v.hoy.mediaUniverso)} del promedio`);
    if (v.sent) { const t = _sentES(v.sent.label); ((t === "positivo" && r.zona === "arriba") || (t === "negativo" && r.zona === "abajo") ? a : c).push(`el tono de las noticias es ${t}`); }
    if (a.length) p.push(`Lo que acompaña: ${lista(a)}.`);
    if (c.length) p.push(`Lo que no acompaña: ${lista(c)}.`);
    const h = fraseHonestidad(ev, R); if (h) p.push(h);
    return { texto: p.join(" ") };
  }
  if (v) return opinionTicker(v, ev, R, op);
  // ¿Por qué se mueve el mercado? Sin causa externa inventada: cómo se mueve.
  const h = ev.datos.hoy;
  if (!h) return C.libre(it, ev, R, op);
  const p = [R.pick([
    "La causa de fondo (una noticia macro, un dato de la Fed) no la tengo en el sistema, así que no te la voy a inventar. Lo que sí puedo mostrarte es cómo se está moviendo:",
    "El porqué de afuera no lo mido, pero sí el cómo:",
  ])];
  p.push(`${diaTxt(ev)} ${h.positivos >= h.n / 2 ? "suben" : "bajan"} ${h.positivos >= h.n / 2 ? h.positivos : h.negativos} de ${h.n} y el promedio da ${pct(h.media)}; lo que más cae es ${lista(h.peores.map(x => `${x.tk} (${pct(x.cambio)})`))}.`);
  const pt = (ev.datos.patrones || [])[0];
  if (pt) p.push(cap(frasePatron(pt, R)) + ".");
  return { texto: p.join(" "), oferta: { intencion: "patron" } };
};

C.comparar = (it, ev, R, op) => {
  let vs = (ev.datos.vistas || []).slice();
  for (const g of (ev.datos.grupos || [])) if (g.vistas.length === 1) vs.push(g.vistas[0]);
  const gs = (ev.datos.grupos || []).filter(g => g.vistas.length > 1);
  if (gs.length >= 2 || (gs.length === 1 && !vs.length)) {
    const p = gs.map(g => `${cap(g.etiqueta)} promedia ${g.mediaHoy != null ? pct(g.mediaHoy) : "–"}${g.mejorRank ? ` y su mejor ubicado en el ranking es ${g.mejorRank.tk} (${ord(g.mejorRank.rank.puesto)})` : ""}.`);
    const conM = gs.filter(g => g.mediaHoy != null).sort((a, b) => b.mediaHoy - a.mediaHoy);
    if (conM.length >= 2) p.push(`${cap(diaTxt(ev))} le va mejor a ${conM[0].etiqueta}.`);
    p.push(R.pick(LEGAL));
    return { texto: p.join(" ") };
  }
  vs = vs.filter((v, i, a) => a.findIndex(x => x.tk === v.tk) === i);
  if (vs.length < 2) return C.opinion(it, ev, R, op);
  const sinDatos = vs.filter(v => !v.tieneDatos);
  if (sinDatos.length === vs.length) return { texto: sinDatosTicker(vs[0], ev, R) };
  const p = [];
  const conR = vs.filter(v => v.rank).sort((a, b) => a.rank.puesto - b.rank.puesto);
  if (conR.length >= 2) {
    p.push(R.pick([
      `En el ranking, ${lista(conR.map(v => `${v.tk} está ${ord(v.rank.puesto)}`))} de ${conR[0].rank.n}, así que entre ${conR.length === 2 ? "los dos" : "ellos"} el sistema prefiere a ${conR[0].tk}.`,
      `El sistema prefiere a ${conR[0].tk}: lo tiene ${ord(conR[0].rank.puesto)} de ${conR[0].rank.n}, contra ${lista(conR.slice(1).map(v => `${ord(v.rank.puesto)} de ${v.tk}`))}.`,
    ]));
    if (Math.abs(conR[0].rank.puesto - conR[conR.length - 1].rank.puesto) <= 3) p.push("La diferencia de puestos es chica, así que no le daría mucho peso.");
  }
  const conH = vs.filter(v => v.hoy).sort((a, b) => b.hoy.cambio - a.hoy.cambio);
  if (conH.length >= 2) p.push(`${cap(diaTxt(ev))}, ${lista(conH.map(v => `${v.tk} ${pct(v.hoy.cambio)}`))}.`);
  const conRi = vs.filter(v => v.riesgo);
  if (conRi.length >= 2) p.push(`De riesgo, ${lista(conRi.map(v => `${v.tk} tiene ${num(v.riesgo.vol, 0)}% de volatilidad anual`))}.`);
  if (sinDatos.length) p.push(`De ${lista(sinDatos.map(v => v.tk))} todavía no tengo datos en este ciclo.`);
  p.push(R.pick(LEGAL));
  return { texto: p.join(" ") };
};

function _lineaRank(arr) { return lista(arr.map(x => `${x.tk} (${ord(Math.round(x.puesto) + 1)})`)); }

C.ranking = (it, ev, R, op) => {
  const r = ev.datos.rankFiltro, h = ev.datos.hoyFiltro, f = ev.datos.filtro;
  const dentro = f ? `Dentro de ${f}, ` : "";
  const p = [];
  const dir = it.direccion || "ambos";
  const art = (n, pl, sg) => (n > 1 ? pl : sg);
  if (r && (r.arriba.length || r.abajo.length)) {
    const a = r.arriba.slice(0, 3), b = r.abajo.slice(0, 3);
    if (dir !== "peor" && a.length) p.push(`${dentro}${art(a.length, f ? "los mejor ubicados" : "Los mejor ubicados", f ? "el mejor ubicado" : "El mejor ubicado")} en el ranking ahora ${art(a.length, "son", "es")} ${_lineaRank(a)}, con señal BUY.`);
    if (dir !== "mejor" && b.length) p.push(dir === "ambos" && a.length
      ? `En la otra punta ${art(b.length, "están", "está")} ${_lineaRank(b)}, con señal SELL.`
      : `${dentro}${art(b.length, f ? "los peor ubicados" : "Los peor ubicados", f ? "el peor ubicado" : "El peor ubicado")} ${art(b.length, "son", "es")} ${_lineaRank(b)}, con señal SELL.`);
  } else if (r && f) {
    const l = r.lista; p.push(`${dentro}ninguno está en los extremos del ranking: el mejor ubicado es ${l[0].tk} (${ord(Math.round(l[0].puesto) + 1)} de ${l[0].n}) y el último ${l[l.length - 1].tk} (${ord(Math.round(l[l.length - 1].puesto) + 1)}).`);
  }
  if (h) {
    const suben = h.mejores.filter(x => x.cambio > 0).slice(0, 3), caen = h.peores.filter(x => x.cambio < 0).slice(0, 3);
    const fmt = arr => lista(arr.map(x => `${x.tk} (${pct(x.cambio)})`));
    const cuando = enRueda(ev) ? "lo que pasa hoy" : "la última rueda";
    if (dir !== "peor") p.push(suben.length
      ? `Si mirás sólo ${cuando}, lo que más ${enRueda(ev) ? "sube" : "subió"} es ${fmt(suben)}.`
      : `Si mirás sólo ${cuando}, no ${enRueda(ev) ? "sube" : "subió"} nada${f ? ` de ${f}` : ""}: lo que menos cae es ${fmt(h.mejores.slice(0, 2))}.`);
    if (dir !== "mejor") p.push(caen.length
      ? `${dir === "ambos" ? "Y lo" : `Si mirás sólo ${cuando}, lo`} que más ${enRueda(ev) ? "cae" : "cayó"} es ${fmt(caen)}.`
      : `${dir === "ambos" ? "Y no" : `Si mirás sólo ${cuando}, no`} ${enRueda(ev) ? "cae" : "cayó"} nada${f ? ` de ${f}` : ""}.`);
  }
  if (!p.length) return { texto: "Todavía no tengo el ranking armado en este ciclo: se completa con el próximo dato del mercado (cada ~90 s). Probá de nuevo en un par de minutos." };
  if (r && h) p.push(R.pick([
    "No son la misma cosa: el ranking ordena lo que espero que le gane al promedio en 24 a 48 horas, no lo que ya se movió.",
    "Ojo con mezclarlos: lo que ya subió no es lo mismo que lo que el ranking espera para las próximas 24-48 horas.",
  ]));
  p.push(dir === "mejor" ? R.pick(["No es una recomendación de compra: es el orden que arma el sistema.", ...LEGAL]) : R.pick(LEGAL));
  const top = r?.arriba?.[0] || r?.lista?.[0];
  return { texto: p.join(" "), oferta: top ? { intencion: "porque", tickers: [top.tk] } : null };
};

function frasePatron(pt, R) {
  switch (pt.clave) {
    case "defensivos": return pt.defensivos > 0 && pt.ciclicos < 0 ? R.pick([
      `hay una rotación hacia lo defensivo: servicios públicos, consumo básico, salud y baja volatilidad promedian ${pct(pt.defensivos)} mientras los cíclicos van ${pct(pt.ciclicos)}`,
      `el mercado se está refugiando: los defensivos suben ${pct(pt.defensivos)} y los cíclicos caen ${pct(pt.ciclicos)}`])
      : pt.ciclicos < 0 ? `los defensivos aguantan mejor la caída: ${pct(pt.defensivos)} contra ${pct(pt.ciclicos)} de los cíclicos`
      : `los defensivos van adelante de los cíclicos: ${pct(pt.defensivos)} contra ${pct(pt.ciclicos)}`;
    case "ciclicos": return pt.ciclicos > 0 && pt.defensivos < 0 ? R.pick([
      `hay apetito por riesgo: los cíclicos (consumo discrecional, industria, finanzas, tecnología) promedian ${pct(pt.ciclicos)} mientras los defensivos van ${pct(pt.defensivos)}`,
      `el dinero va hacia lo cíclico: ${pct(pt.ciclicos)} contra ${pct(pt.defensivos)} de los defensivos`])
      : pt.ciclicos < 0 ? `los cíclicos caen menos que los defensivos: ${pct(pt.ciclicos)} contra ${pct(pt.defensivos)}`
      : `los cíclicos le sacan ventaja a los defensivos: ${pct(pt.ciclicos)} contra ${pct(pt.defensivos)}`;
    case "regiones": return R.pick([
      `por regiones, ${pt.lider.nombre} es lo más fuerte (${pct(pt.lider.media)} en promedio) y ${pt.rezagada.nombre} lo más flojo (${pct(pt.rezagada.media)})`,
      `${pt.lider.nombre} le gana a ${pt.rezagada.nombre}: ${pct(pt.lider.media)} contra ${pct(pt.rezagada.media)} en promedio`]);
    case "bloque": return pt.positivos > pt.n / 2
      ? `el mercado se mueve en bloque para arriba: suben ${pt.positivos} de ${pt.n}`
      : `el mercado se mueve en bloque para abajo: bajan ${pt.n - pt.positivos} de ${pt.n}`;
    case "dispersion": return `es un día de mucha dispersión: entre ${pt.mejor.tk} (${pct(pt.mejor.cambio)}) y ${pt.peor.tk} (${pct(pt.peor.cambio)}) hay mucha distancia, así que elegir bien pesa más que la dirección`;
    case "extremos": return `hay movimientos fuertes puntuales: ${lista(pt.lista.map(x => `${x.tk} ${pct(x.cambio)}`))}`;
    case "amplitud": {
      const t = pt.minutos >= 90 ? `${Math.floor(pt.minutos / 60)} h${pt.minutos % 60 >= 10 ? ` ${pt.minutos % 60} min` : ""}` : `${pt.minutos} minutos`;
      if (pt.enRueda === false) return pt.hasta > pt.desde
        ? `la amplitud fue mejorando a lo largo de la última rueda: pasó de ${pt.desde} a ${pt.hasta} instrumentos en alza (de ${pt.n})`
        : `la amplitud se fue deteriorando a lo largo de la última rueda: pasó de ${pt.desde} a ${pt.hasta} instrumentos en alza (de ${pt.n})`;
      return pt.hasta > pt.desde
        ? `la amplitud viene mejorando: hace ${t} subían ${pt.desde} de ${pt.n} y ahora suben ${pt.hasta}`
        : `la amplitud viene empeorando: hace ${t} subían ${pt.desde} de ${pt.n} y ahora sólo ${pt.hasta}`;
    }
    case "concentracion": return `el ranking está concentrado: ${pt.cant} de los ${pt.de} instrumentos con señal BUY son de ${pt.region}`;
    case "acuerdo": return pt.acuerdo >= 0.5
      ? `el ranking y el día van de la mano: ${pt.sub} de los ${pt.nA} con señal BUY suben y ${pt.baj} de los ${pt.nB} con SELL bajan`
      : `el ranking y el día van a contramano: sólo ${pt.sub} de los ${pt.nA} con señal BUY suben y ${pt.baj} de los ${pt.nB} con SELL bajan`;
    case "alerta": return `hay una alerta activa: ${pt.texto}`;
    default: return "";
  }
}

C.patron = (it, ev, R, op) => {
  const pts = ev.datos.patrones || [], h = ev.datos.hoy;
  if (!h && !pts.length) return { texto: "Para ver patrones necesito las cotizaciones del ciclo, y todavía no me llegaron. En un par de minutos las tengo." };
  if (!pts.length) {
    return { texto: R.pick([
      `Hoy no veo un patrón claro: ${h.positivos > h.n / 2 ? "suben" : "bajan"} ${h.positivos > h.n / 2 ? h.positivos : h.negativos} de ${h.n}, el promedio da ${pct(h.media)} y no hay una rotación marcada ni entre regiones ni entre defensivos y cíclicos. Es un día bastante normal.`,
      `La verdad, nada que se destaque: ${h.positivos} de ${h.n} en alza, promedio ${pct(h.media)}, sin rotación entre regiones ni sectores. Un día sin una historia fuerte.`,
    ]), oferta: { intencion: "ranking", direccion: "ambos" } };
  }
  const n = op.detalle > 1 ? 4 : 3;
  const frases = pts.slice(0, n).map(pt => frasePatron(pt, R)).filter(Boolean);
  const inicio = R.pick(["Sí, veo un par de cosas.", "Algunas cosas que me llaman la atención:", "Mirando los 50 instrumentos, esto es lo que sobresale:"]);
  const conectores = ["Primero,", "Además,", "Y por último,"];
  const cuerpo = frases.map((f, i) => frases.length === 1 ? `${cap(f)}.` : `${i === 0 ? conectores[0] : i === frases.length - 1 ? conectores[2] : conectores[1]} ${f}.`);
  const cierre = R.pick(["Son patrones del día, no una predicción.", "Es lo que muestran los números de la rueda; no implica que siga.", ""]);
  return { texto: [inicio, ...cuerpo, cierre].filter(Boolean).join(" "),
           oferta: { intencion: "ranking", direccion: "ambos" } };
};

function fraseMercadoEstado(m, R) {
  if (!m) return "";
  if (m.abierto) return R.pick([`El NYSE está abierto (son las ${m.horaNY} en Nueva York).`, `La rueda está en curso: ${m.horaNY} en Nueva York, ${m.horaAR} acá.`]);
  const prox = m.proxima ? ` y abre ${m.proxima.etiqueta} a las ${m.aperturaNY} de Nueva York (${m.aperturaAR} en Argentina)` : "";
  return `El NYSE está cerrado (${m.motivo})${prox}.`;
}

C.resumen = (it, ev, R, op) => {
  const h = ev.datos.hoy, p = [];
  if (it.subtipo === "conviene") p.push(R.pick([
    "Si conviene o no, no te lo puedo decir —eso es asesoramiento y no lo doy—, pero sí te cuento lo que veo:",
    "No te voy a decir si es buen momento, porque no doy asesoramiento; lo que sí puedo es mostrarte cómo está el mercado:",
  ]));
  p.push(fraseMercadoEstado(ev.datos.mercado, R));
  if (ev.datos.riesgo != null) p.push(`El riesgo global está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).`);
  if (h) {
    p.push(R.pick([
      `${cap(diaTxt(ev))} ${h.positivos >= h.n / 2 ? "suben" : "bajan"} ${h.positivos >= h.n / 2 ? h.positivos : h.negativos} de ${h.n} y el promedio da ${pct(h.media)}.`,
      `De los ${h.n} que sigo, ${h.positivos} están en alza ${enRueda(ev) ? "hoy" : "en la última rueda"} (promedio ${pct(h.media)}).`,
    ]));
    p.push(`Lo más fuerte es ${h.mejores[0].tk} (${pct(h.mejores[0].cambio)}) y lo más flojo ${h.peores[0].tk} (${pct(h.peores[0].cambio)}).`);
  }
  const pt = (ev.datos.patrones || []).find(x => x.clave !== "alerta");
  if (pt) p.push(`${cap(frasePatron(pt, R))}.`);
  if (ev.datos.alertas?.length) p.push(`Hay una alerta activa: ${ev.datos.alertas[0]}.`);
  if (p.filter(Boolean).length <= 1) return C.libre(it, ev, R, op);
  return { texto: p.filter(Boolean).join(" "), oferta: { intencion: "patron" } };
};

C.regimen = (it, ev, R, op) => {
  const g = ev.datos.regimen;
  if (!g) return C.resumen(it, ev, R, op);
  return { texto: `Por cómo viene ${enRueda(ev) ? "el día" : "la última rueda"}, lo leería como un mercado ${g.etiqueta}: suben ${g.positivos} de ${g.n}, el promedio es ${pct(g.media)}${g.riesgo != null ? ` y el riesgo global está en ${Math.round(g.riesgo * 100)}%` : ""}. Es una lectura de la rueda, no del ciclo largo: para eso hacen falta semanas de datos, no un día.` };
};

// El rendimiento POR RÉGIMEN (16-nov-2026, pedido de Martín: que el chat cuente
// en qué régimen le va mejor). Se destaca el mejor, con el número, y se lo afirma
// como ventaja SÓLO si supera su propio margen; si no, se dice que es lo más
// prometedor y que todavía no está confirmado. Con 6 ruedas por régimen el margen
// es ±0,3: decir «le gano al mercado» con eso sería publicar ruido.
const REG_ES = { alcista: "después de ruedas alcistas", bajista: "después de ruedas bajistas", lateral: "después de ruedas planas" };
function fraseRegimen(m) {
  const pr = m?.porRegimen;
  if (!pr) return null;
  const filas = Object.entries(pr)
    .map(([k, v]) => ({ k, ic: Number(v?.rank_ic), n: Number(v?.rank_ic_ventanas) || 0,
                        mde: Number(v?.rank_ic_min_detectable), sig: v?.rank_ic_significativo === true }))
    .filter(f => Number.isFinite(f.ic) && f.n >= 3);
  if (!filas.length) return null;
  filas.sort((a, b) => b.ic - a.ic);
  const top = filas[0];
  const resto = filas.slice(1).map(f => `${f.ic >= 0 ? "+" : ""}${num(f.ic, 2)} ${REG_ES[f.k] || f.k}`).join(" y ");
  const icT = `${top.ic >= 0 ? "+" : ""}${num(top.ic, 2)}`;
  if (top.ic <= 0) return `Por régimen de mercado, todavía no hay uno en el que mi ranking ordene mejor que el azar (el mejor da ${icT}).`;
  if (top.sig) return `Por régimen de mercado, donde le gano al promedio es ${REG_ES[top.k] || top.k}: ahí el rank IC da ${icT} en ${top.n} ruedas, por encima de su margen (±${num(top.mde, 2)}).`;
  return `Por régimen de mercado, donde mejor me va es ${REG_ES[top.k] || top.k}: el rank IC da ${icT}${resto ? `, contra ${resto}` : ""}. Es lo más prometedor que tengo, pero con ${top.n} ruedas su margen es ±${Number.isFinite(top.mde) ? num(top.mde, 2) : "—"}, así que todavía no lo puedo confirmar como ventaja.`;
}

C.acierto = (it, ev, R, op) => {
  const m = ev.datos.metricas;
  if (it?.subtipo === "regimen" && m) {
    const f = fraseRegimen(m);
    if (f) return { texto: `${f} La muestra sigue creciendo rueda a rueda.` };
  }
  if (!m) return { texto: "El número de acierto lo saco de la misma medición que muestra el panel Backtesting, y en este momento no me llegó. Si me preguntás de nuevo en un minuto, te lo traigo; nunca te voy a dar una cifra sin ese respaldo." };
  const edge = m.edge != null ? m.edge : (m.base != null ? m.acc - m.base : null);
  // La vara es el azar con la misma mezcla de compras y ventas (6-nov-2026);
  // con un payload viejo, el base rate de antes, dicho como lo que es.
  const contraAzar = m.baseTipo === "azar";
  const p = [R.pick(contraAzar ? [
    `Sobre las decisiones ya verificadas acierto la dirección el ${num(m.acc)}% de las veces${m.base != null ? `, contra ${num(m.base)}% que sacaría alguien eligiendo al azar con la misma mezcla de compras y ventas` : ""}.`,
    `Mi acierto direccional, medido contra lo que realmente pasó, es ${num(m.acc)}%${m.base != null ? `; la vara para comparar —el azar, comprando y vendiendo en la misma proporción que yo— da ${num(m.base)}%` : ""}.`,
  ] : [
    `Sobre las decisiones ya verificadas acierto la dirección el ${num(m.acc)}% de las veces${m.base != null ? `, contra ${num(m.base)}% que sacaría alguien diciendo siempre lo mismo` : ""}.`,
    `Mi acierto direccional, medido contra lo que realmente pasó, es ${num(m.acc)}%${m.base != null ? `; la vara para comparar —decir siempre la dirección más común— da ${num(m.base)}%` : ""}.`,
  ])];
  // 16-nov-2026: el chat decía «ya es estadísticamente significativa… sobre 745
  // ventanas independientes». Las dos cosas sobraban: n_efectivo cuenta ventana ×
  // instrumento (los 50 de una misma rueda se mueven juntos, no son
  // independientes), y el veredicto del experimento es el RANK IC, no el acierto
  // contra el azar —una vara que además se eligió después de ver el número—.
  // Ventaja «demostrada» sólo si las dos superan su margen.
  const icOk = m.rankIc != null && m.rankIcMde != null;
  const icTxt = icOk ? `el rank IC (si el orden que doy se parece al orden real) está en ${m.rankIc >= 0 ? "+" : ""}${num(m.rankIc, 3)}, con un mínimo detectable de ${num(m.rankIcMde, 3)}${m.rankIcVent ? ` en ${m.rankIcVent} ruedas` : ""}` : null;
  if (edge != null) {
    const dif = `${edge > 0 ? "+" : ""}${num(edge)} puntos`;
    if (m.signif && icOk && m.rankIcSignif) {
      p.push(`Esa diferencia (${dif}) supera su margen de ruido, y ${icTxt}: también lo supera. Por ahora es la primera evidencia de una ventaja, y la sigo midiendo.`);
    } else if (m.signif) {
      p.push(`Esa diferencia (${dif}) supera su margen de ruido${m.mde != null ? ` (±${num(m.mde)})` : ""}, pero no alcanza para hablar de una ventaja demostrada. La medida principal es otra: ${icTxt ? `${icTxt}, así que todavía no se distingue del azar` : "el rank IC, que todavía no tiene un número confirmado"}. Siendo honesta: hoy no puedo decir que le gano al mercado.`);
    } else {
      p.push(`Esa diferencia (${dif}) todavía está dentro del margen de ruido${m.mde != null ? ` (±${num(m.mde)})` : ""}${icTxt ? `, y ${icTxt}` : ""}. Siendo honesta: no puedo decir que tenga una ventaja demostrada.`);
    }
  }
  const fr = fraseRegimen(m);
  if (fr) p.push(fr);
  p.push("La muestra sigue creciendo rueda a rueda.");
  return { texto: p.join(" ") };
};

C.mercado_abierto = (it, ev, R, op) => {
  const m = ev.datos.mercado;
  if (!m) return { texto: "No pude calcular el estado del mercado en este momento." };
  if (m.abierto) {
    const resto = m.minParaCierre != null ? ` Quedan ${Math.floor(m.minParaCierre / 60) ? `${Math.floor(m.minParaCierre / 60)} h ` : ""}${m.minParaCierre % 60} min de rueda${m.medioDia ? " (hoy es media rueda)" : ""}: cierra a las ${m.cierreNY} de allá, ${m.cierreAR} de acá.` : "";
    const h = ev.datos.hoy;
    const dato = h ? ` Por ahora suben ${h.positivos} de los ${h.n} instrumentos que sigo.` : "";
    return { texto: R.pick([`Sí, el NYSE está abierto: son las ${m.horaNY} en Nueva York (${m.horaAR} en Argentina).`, `Sí, la rueda está en curso (${m.horaNY} en Nueva York, ${m.horaAR} acá).`]) + resto + dato };
  }
  const motivo = m.motivo === "fin de semana" ? "es fin de semana" : m.motivo === "feriado" ? "hoy es feriado en EE.UU." : m.motivo === "todavía no abrió" ? "todavía no abrió" : "ya cerró por hoy";
  const prox = m.proxima ? ` Abre ${m.proxima.etiqueta} a las ${m.aperturaNY} de Nueva York (${m.aperturaAR} en Argentina).` : "";
  return { texto: `No, el NYSE está cerrado: ${motivo}.${prox}${m.fueraDeCalendario ? " (Mi calendario de feriados llega hasta 2027.)" : ""}` };
};

C.identidad = (it, ev, R, op) => {
  const n = 50;
  switch (it.subtipo) {
    case "como_funciona": return { texto: R.pick([
      `Hablo con un motor de lenguaje que corre en el propio servidor de MIIA y que sólo se ocupa de redactar: los números no salen de él, salen del sistema. Atrás hay ${n} ETFs que se cotizan cada minuto y medio, redes neuronales que los comparan entre sí y un ranking que decide cuáles marcar BUY o SELL. Cuando me preguntás algo con dato —un puesto, un precio, un riesgo— te lo traigo directo de ahí.`,
      `La parte que "habla" es una capa de lenguaje que redacta; el análisis lo hace el sistema: cotiza ${n} ETFs cada ~90 segundos, los pasa por varias redes neuronales, los ordena en un ranking y verifica después si acertó. Yo junto esos datos y te los cuento en castellano.`]) };
    case "proveedor": return { texto: "No, no soy de ninguna empresa de IA: soy MIIA, el sistema que desarrolló Martín Rinaldi. El motor que redacta corre en el servidor de MIIA y es sólo la capa de comunicación; el análisis, los datos y las decisiones son propios." };
    case "datos": return { texto: `Todo sale del propio sistema: las cotizaciones de los ${n} ETFs (se actualizan cada ~90 segundos), las noticias que procesa y clasifica por instrumento, y las decisiones de las redes neuronales, que después se verifican contra lo que pasó en el mercado. No invento cifras: si un dato no está, te lo digo.` };
    // «¿Qué opinás de vos y de tu creador?»: el motor de lenguaje la contesta
    // (class25B, charla); esto es el respaldo si no llega a tiempo.
    case "opina": return { texto: R.pick([
      `De mí te diría que soy una IA curiosa y bastante obsesiva con los números: miro ${n} ETFs todo el día y después me fijo si acerté, que es la parte que más me gusta. Me creó Martín Rinaldi, con una consigna clara: que diga lo que veo con datos y que muestre también cuando no acierto. Igual, soy una IA y me puedo equivocar.`,
      `Me creó Martín Rinaldi. Yo me veo como una IA en aprendizaje: sigo ${n} ETFs, opino con números y todavía estoy demostrando si le gano al promedio. Tomalo como la opinión de una IA, que se puede equivocar.`]) };
    // «¿Sos consciente de vos misma?», «¿cómo te percibís?» (13-nov-2026): la
    // contesta el motor (charla); esto es el respaldo y CONTESTA la pregunta.
    case "conciencia": return { texto: R.pick([
      `No, no soy consciente como vos: no tengo sentimientos ni una experiencia propia. Soy una IA que creó Martín Rinaldi para analizar ${n} ETFs. Lo más parecido que tengo a «conocerme» es que mido mis propios aciertos y errores y con eso ajusto lo que hago, pero eso es cálculo, no conciencia.`,
      `Te soy sincera: no tengo conciencia de mí misma ni emociones. Soy MIIA, la IA que hizo Martín Rinaldi: proceso cotizaciones, noticias y el resultado de mis propias señales, y aprendo de lo que acierto y de lo que no. Me «percibo» con números: sé cuánto vengo acertando, no qué se siente ser yo.`]) };
    case "nombre": return { texto: "MIIA significa Mano Invisible Inteligencia Artificial —la «mano invisible» de Adam Smith, el mercado que se ordena solo—. Es un sistema de análisis de mercados desarrollado por Martín Rinaldi." };
    default: return { texto: R.pick([
      `Soy MIIA —Mano Invisible Inteligencia Artificial—, un sistema de análisis de mercados que desarrolló Martín Rinaldi. Sigo ${n} ETFs de acciones de todo el mundo, los comparo con redes neuronales y te cuento lo que veo, con números.`,
      `Me desarrolló Martín Rinaldi. Soy MIIA, La Mano Invisible: un sistema propio que mide ${n} ETFs, los ordena en un ranking y verifica después si acertó. El motor de lenguaje es sólo la capa con la que te hablo.`]) };
  }
};

C.capacidades = (it, ev, R, op) => {
  const r = ev.datos.rank, h = ev.datos.hoy;
  const ej = [];
  if (r?.arriba?.length) ej.push(`ahora mismo ${r.arriba[0].tk} es el mejor ubicado del ranking${r.abajo?.length ? ` y ${r.abajo[0].tk} el peor` : ""}`);
  if (h) ej.push(`${enRueda(ev) ? "hoy" : "en la última rueda"} lo que más se movió fue ${h.mejores[0].tk} (${pct(h.mejores[0].cambio)})`);
  const base = R.pick([
    "Puedo contarte, con números del sistema, cómo viene cada uno de los 50 ETFs que sigo, en qué puesto los pone el ranking y por qué, qué riesgo tienen, qué dicen las noticias, qué patrones aparecen en el día, si el mercado está abierto y qué tan bien vengo acertando. También te armo un portfolio según tu perfil.",
    "Te puedo dar mi lectura de cualquiera de los 50 ETFs que mido (también por país o sector: «Brasil», «tecnología», «bancos»), compararlos, mostrarte el ranking, el riesgo de cada uno, las noticias, los patrones del día y mi tasa de acierto real. Y si querés, te armo una cartera según tu perfil.",
  ]);
  const ejemplo = ej.length ? ` Por ejemplo, ${lista(ej)}.` : "";
  const prueba = R.pick([" Probá con «¿qué opinás de Brasil?» o «¿ves algún patrón hoy?».", " Probá preguntándome «XLK o QQQ?» o «¿qué está más fuerte hoy?».", ""]);
  return { texto: base + ejemplo + prueba };
};

const DEF = {
  etf: v => `Un ETF es un fondo que cotiza en bolsa como si fuera una acción y replica una canasta: un índice, un sector o un país. Por ejemplo, XLK replica a las tecnológicas de EE.UU. y ARGT al Merval.${v ? ` Hoy XLK va ${pct(v.hoy.cambio)}.` : ""} Los 50 instrumentos que sigo son todos ETFs.`,
  volatilidad: v => `La volatilidad mide cuánto se mueve un precio, para arriba y para abajo. Yo la calculo anualizada con los últimos 60 días: un ETF con 15% es tranquilo y uno con 35% se sacude mucho.${v?.riesgo ? ` ${v.tk}, por ejemplo, tiene ${num(v.riesgo.vol, 0)}%.` : ""}`,
  drawdown: v => `La caída máxima (drawdown) es lo peor que cayó un precio desde un pico hasta un piso en un período. Yo la mido en los últimos 60 días: dice cuánto te habría dolido entrar en el peor momento.${v?.riesgo ? ` La de ${v.tk} es ${num(v.riesgo.dd, 0)}%.` : ""}`,
  riesgo_global: (v, ev) => `El riesgo global es un índice de 0 a 100% que resume qué tan tenso está el mercado en su conjunto (caídas, dispersión, alertas).${ev.datos.riesgo != null ? ` Ahora está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).` : ""} No es el riesgo de un instrumento puntual: ese lo mido con su volatilidad.`,
  stop_loss: () => "Un stop-loss es una orden que vende automáticamente si el precio cae hasta un nivel que vos fijás, para limitar la pérdida. Yo no fijo stop-loss por vos: es una decisión de cada inversor según cuánto está dispuesto a perder.",
  horizonte: () => "El horizonte es el plazo en el que se evalúa una señal. Las mías se miden a 24 o 48 horas: pasado ese tiempo, el sistema compara lo que dijo con lo que hizo el precio y aprende del resultado.",
  confianza: () => "La confianza de una señal dice qué tan lejos está el instrumento del medio del ranking: el primero y el último tienen confianza alta, los de mitad de tabla, baja. No es una probabilidad de acierto.",
  ranking: (v, ev) => `El ranking ordena a los 50 instrumentos de mejor a peor según lo que el sistema espera que rindan contra el promedio en las próximas 24-48 horas. Los mejores salen BUY, los peores SELL y el resto HOLD.${ev.datos.rank?.arriba?.length ? ` Ahora arriba de todo está ${ev.datos.rank.arriba[0].tk}.` : ""}`,
  rank_ic: () => "El rank IC mide si el orden que da mi ranking se parece al orden real: en cada rueda compara cómo ordené los 50 instrumentos con cómo rindieron después contra el promedio. Va de −1 a +1; 0 es azar. Se lee siempre junto a su mínimo detectable: por debajo de esa banda, no se distingue del ruido.",
  edge: () => "El edge (ventaja) es cuánto acierta el sistema por encima de la estrategia ingenua de decir siempre la dirección que más se repitió. Si no supera su banda de ruido, no hay ventaja demostrada: por eso el panel Backtesting lo muestra siempre al lado de esa banda.",
  rsi: () => "El RSI (índice de fuerza relativa) va de 0 a 100 y compara las subas con las bajas recientes: arriba de 70 suele leerse como «sobrecomprado» y debajo de 30 como «sobrevendido». Es uno de los indicadores que usa mi modelo predictivo.",
  macd: () => "El MACD compara dos promedios móviles del precio (uno rápido y uno lento) para detectar cambios de tendencia. Es otro de los indicadores técnicos que alimentan a mi modelo predictivo.",
  sharpe: () => "El ratio de Sharpe mide cuánto retorno se obtuvo por cada unidad de riesgo. Ojo: con poca historia o sin una ventaja demostrada, un Sharpe alto puede ser pura suerte, por eso el panel no lo destaca hasta que la ventaja sea significativa.",
  beta: () => "La beta mide cuánto se mueve algo cuando se mueve el mercado: beta 1 es igual que el mercado, 2 es el doble. Mi ranking está armado para que la beta se cancele: compara instrumentos entre sí, no apuesta a la dirección del mercado.",
  alfa: () => "El alfa es el rendimiento por encima de lo que explica el mercado. Es justo lo difícil: mi acierto todavía no muestra un alfa demostrable, y te lo digo así.",
  diversificacion: () => "Diversificar es repartir el dinero entre activos que no se mueven igual, para que una caída en uno no te arrastre entero. Por eso las carteras que armo combinan sectores y regiones distintos.",
  benchmark: () => "El benchmark es la vara contra la que se compara un resultado. En MIIA la vara es el promedio de los 50 instrumentos: una señal acierta si el instrumento le gana (o pierde) contra ese promedio, no si sube o baja en general.",
  amplitud: (v, ev) => `La amplitud cuenta cuántos instrumentos suben y cuántos bajan.${ev.datos.hoy ? ` Ahora suben ${ev.datos.hoy.positivos} de ${ev.datos.hoy.n}.` : ""} Un índice puede subir con pocos empujando: la amplitud dice si el movimiento es parejo.`,
  rotacion: () => "Una rotación es cuando el dinero sale de un grupo y entra en otro: por ejemplo, de tecnología a servicios públicos cuando el mercado se pone defensivo. La detecto comparando los promedios de cada grupo en el día.",
  defensivos: () => "Los defensivos (servicios públicos, consumo básico, salud) venden cosas que se compran igual en cualquier ciclo, así que suelen aguantar mejor las caídas. Los cíclicos (consumo discrecional, industria, finanzas, tecnología) dependen más de cómo va la economía.",
  senal: () => "Mis señales son tres: BUY para los instrumentos que el ranking pone arriba (espera que le ganen al promedio), SELL para los de abajo y HOLD para la mitad de tabla. Se verifican a las 24-48 horas contra lo que realmente pasó.",
  small_caps: () => "Las small caps son empresas chicas por capitalización. En EE.UU. las sigo con IWM (Russell 2000). Suelen ser más volátiles que las grandes del S&P 500.",
  factor: () => "Un factor es una característica que explica rendimientos: momentum (lo que viene subiendo), valor (lo barato), calidad, crecimiento o baja volatilidad. Sigo un ETF de cada uno (MTUM, VTV, QUAL, VUG, USMV).",
};
C.concepto = (it, ev, R, op) => {
  const f = DEF[it.concepto];
  if (!f) return C.libre(it, ev, R, op);
  // Un ejemplo vivo si hay datos (XLK para ETF, algún instrumento con riesgo).
  const v = it.concepto === "etf" ? vistaTickerSeguro(ev, "XLK")
          : (ev.datos.vistas || []).find(x => x.riesgo) || ev.datos.ejemploRiesgo || null;
  return { texto: f(v && (it.concepto !== "etf" || v.hoy) ? v : null, ev) };
};
function vistaTickerSeguro(ev, tk) {
  const h = ev.datos.hoy?.lista?.find(x => x.tk === tk);
  return h ? { tk, hoy: { cambio: h.cambio } } : null;
}

C.fuera_universo = (it, ev, R, op) => {
  const f = (ev.datos.fuera || [])[0];
  const nombre = f?.nombre || "Eso";
  const p = [R.pick([
    `${cap(nombre)} no ${/^los |^las /.test(nombre) ? "están" : "está"} entre los 50 instrumentos que mido —son todos ETFs de acciones—, así que no tengo señal ni análisis propio para darte.`,
    `De ${nombre} no tengo análisis: el sistema mide 50 ETFs de acciones y ${nombre} no ${/^los |^las /.test(nombre) ? "entran" : "entra"} en ese universo.`,
  ])];
  const px = (ev.datos.proxies || [])[0];
  if (px) p.push(`Lo más cercano que sí sigo es ${px.tk} (${px.nombre})${px.hoy ? `, que ${diaTxt(ev)} va ${pct(px.hoy.cambio)}` : ""}${px.rank ? ` y está ${ord(px.rank.puesto)} de ${px.rank.n} en el ranking` : ""}. No es lo mismo, pero se mueve con eso.`);
  return { texto: p.join(" "), oferta: px ? { intencion: "opinion", tickers: [px.tk] } : null };
};

C.activo_externo = (it, ev, R, op) => {
  const a = ev.datos.activo || {};
  const tk = String(a.ticker || "ese activo").toUpperCase();
  const nom = a.nombre && a.nombre !== a.ticker ? ` (${a.nombre})` : "";
  const p = [R.pick([
    `${tk}${nom} no está entre los 50 instrumentos que mido todos los días, así que no tengo señal propia ni lugar en el ranking.`,
    `A ${tk}${nom} no lo sigo de forma permanente: no entra en los 50 ETFs del ranking.`,
  ])];
  if (a.precio != null) p.push(`Lo que sí tengo es su cotización: US$ ${num(a.precio, 2)}${a.change_pct != null ? ` (${pct(Number(a.change_pct))} en el día)` : ""}.`);
  p.push(R.pick([
    `Ya pedí su cotización, sus noticias y una cartera de referencia anclada en ${tk}: en un minuto aparecen en el dashboard (Sentimiento y Portfolio).`,
    `Disparé el seguimiento de ${tk} —precio, noticias y sentimiento—; en un rato lo ves en los paneles del dashboard.`,
  ]));
  return { texto: p.join(" ") };
};

C.crisis = (it, ev, R, op) => {
  const cr = (ev.datos.crisis || []).filter(c => c?.nombre);
  const p = [];
  if (cr.length) {
    const top = [...cr].sort((a, b) => (b.severidad || 0) - (a.severidad || 0)).slice(0, 3);
    p.push(`En la base tengo ${cr.length} crisis históricas documentadas. Las más severas: ${lista(top.map(c => `${c.nombre} (${c.anio_inicio}${c.anio_fin && c.anio_fin !== c.anio_inicio ? `-${c.anio_fin}` : ""}, severidad ${c.severidad}/10)`))}.`);
  } else p.push("Ahora no tengo a mano la base de crisis históricas.");
  if (ev.datos.riesgo != null) p.push(`Hoy el riesgo global está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel})${ev.datos.alertas?.length ? `, con una alerta activa: ${ev.datos.alertas[0]}` : ", sin alertas activas"}.`);
  p.push("Comparar con una crisis pasada sirve de contexto, no de pronóstico.");
  return { texto: p.join(" ") };
};

C.saludo = (it, ev, R, op) => {
  const nom = op.nombre ? `, ${op.nombre}` : "";
  const m = ev.datos.mercado, h = ev.datos.hoy;
  const hola = R.pick([`¡Hola${nom}!`, `¡Hola${nom}! ¿Cómo va?`, `¡Buenas${nom}!`]);
  let dato = "";
  if (m?.abierto && h) dato = R.pick([
    ` La rueda está en curso y por ahora suben ${h.positivos} de los ${h.n} que sigo; lo más fuerte es ${h.mejores[0].tk} (${pct(h.mejores[0].cambio)}).`,
    ` Ando mirando el mercado: ${h.positivos} de ${h.n} en alza y el riesgo global en ${ev.datos.riesgo != null ? Math.round(ev.datos.riesgo * 100) + "%" : "–"}.`,
  ]);
  else if (m && h) dato = ` El NYSE está cerrado${m.proxima ? ` (abre ${m.proxima.etiqueta} a las ${m.aperturaAR} hora argentina)` : ""}; en la última rueda subieron ${h.positivos} de ${h.n}.`;
  const previo = op.perfil ? ` La última vez definimos un perfil ${op.perfil}${op.monto ? ` con ${op.monto}` : ""}.` : "";
  const preg = R.pick([" ¿Qué querés mirar?", " ¿En qué te ayudo?", " ¿Arrancamos por algún instrumento?"]);
  return { texto: `${hola}${dato}${previo}${preg}` };
};

C.gracias = (it, ev, R, op) => {
  const nom = op.nombre ? `, ${op.nombre}` : "";
  const tema = op.temaTicker ? R.pick([` Si querés, después vemos cómo cierra ${op.temaTicker}.`, ` Cualquier cosa sobre ${op.temaTicker}, avisame.`, ""]) : "";
  return { texto: R.pick([`¡De nada${nom}!`, `¡Con gusto${nom}!`, `¡A vos${nom}!`]) + tema + R.pick(["", " Acá sigo.", " Cuando quieras."]) };
};

C.presentacion = (it, ev, R, op) => {
  const n = it.nombre || op.nombre;
  const h = ev.datos.hoy, m = ev.datos.mercado;
  const dato = h ? (m?.abierto
    ? ` Por si te sirve para arrancar: la rueda está en curso y suben ${h.positivos} de los ${h.n} instrumentos que sigo.`
    : ` El NYSE está cerrado ahora; en la última rueda subieron ${h.positivos} de ${h.n}.`) : "";
  return { texto: `${R.pick([`¡Un gusto, ${n}!`, `¡Hola, ${n}! Un gusto.`, `¡Qué bueno, ${n}!`])}${dato} ${R.pick(["¿Qué querés mirar?", "¿En qué te ayudo?", "Preguntame por cualquier país, sector o ETF."])}` };
};

C.negar = (it, ev, R) => ({ texto: R.pick(["Dale, cualquier cosa me decís.", "Perfecto. Si te surge otra pregunta, acá estoy.", "Listo. Avisame si querés mirar otra cosa."]) });

C.seguir_sin_tema = (it, ev, R, op) => {
  // Un «sí» sin nada pendiente (5-nov-2026): antes devolvía «¿Sobre qué querés
  // que siga?», o sea otra pregunta. Ahora contesta con algo concreto —cómo
  // viene el mercado— y deja propuesto el paso siguiente.
  const h = ev.datos.hoy;
  if (h) {
    const r = C.resumen({ ...it, subtipo: null }, ev, R, op);
    if (r?.texto) return { texto: `${R.pick(["Dale.", "Va.", "Listo."])} ${r.texto} ${R.pick([
      "Si querés, te muestro qué está más fuerte y más flojo en el ranking.",
      "¿Te muestro el ranking del día, lo más fuerte y lo más flojo?",
    ])}`, oferta: { intencion: "ranking", direccion: "ambos" } };
  }
  const r = ev.datos.rank;
  const ideas = [];
  if (r?.arriba?.length) ideas.push(`arriba del ranking está ${r.arriba[0].tk}`);
  return { texto: `¿Sobre qué querés que siga?${ideas.length ? ` Te tiro una idea: ${lista(ideas)}.` : ""} Podés nombrarme un país, un sector o un ETF.` };
};

C.libre = (it, ev, R, op) => {
  const h = ev.datos.hoy, p = [];
  const tema = ev.datos.tema;
  if (tema?.vistas?.length) {
    p.push(R.pick([
      `De ${tema.nombre} en sí no tengo datos en el sistema, pero sí de lo que suele reaccionar a eso:`,
      `No mido directamente ${tema.nombre}; lo que sí veo es cómo se mueve lo que suele ser sensible a eso:`,
    ]));
    p.push(`${lista(tema.vistas.map(v => `${v.tk} (${v.nombre}) ${pct(v.hoy.cambio)}`))}${h ? `, contra ${pct(h.media)} del promedio` : ""}.`);
    p.push("Esa relación es general, no algo que el sistema haya probado.");
    return { texto: p.join(" ") };
  }
  // Respaldo de la CHARLA LIBRE: la contesta el motor de lenguaje (class25B);
  // esto sale sólo si el motor no llegó a tiempo o lo que escribió no pasó la
  // validación. Sin plantilla de «no quiero inventarte» (5-nov-2026).
  // 5-nov (tarde): sin «repetímela en un ratito» —mandaba al usuario a reintentar,
  // y la segunda vez salía lo mismo— y sin afirmar que «está lenta» (puede ser
  // que el motor contestó y no pasó la validación). Y la pregunta del final
  // queda REGISTRADA como propuesta: «¿Querés que mire algún instrumento?»
  // no dejaba nada pendiente, así que el «Si porfavor» del usuario volvía a
  // caer acá y la respuesta se repetía.
  if (it?.subtipo === "sigue_charla") {
    p.push(R.pick([
      "Perdón, se me cortó el hilo de esa charla y no quiero contestarte cualquier cosa.",
      "Uy, perdí el hilo de lo que veníamos hablando y prefiero no inventarte una respuesta.",
    ]));
  } else {
    p.push(R.pick([
      "Esa da para charlar, pero no me salió una respuesta que me convenza y prefiero no tirarte cualquier cosa.",
      "Buena pregunta; no me salió una respuesta a la altura y no te quiero contestar a medias.",
      "Me agarraste con la cabeza en los números y no me salió una opinión que valga la pena.",
    ]));
  }
  if (h) p.push(`Lo que sí tengo: ${h.positivos} de ${h.n} en alza ${enRueda(ev) ? "hoy" : "en la última rueda"}, promedio ${pct(h.media)}, con ${h.mejores[0].tk} adelante (${pct(h.mejores[0].cambio)}) y ${h.peores[0].tk} atrás (${pct(h.peores[0].cambio)}).`);
  else if (ev.datos.riesgo != null) p.push(`Lo que sí veo: el riesgo global está en ${Math.round(ev.datos.riesgo * 100)}% (${ev.datos.nivel}).`);
  if (h) {
    p.push(R.pick([
      "¿Querés que te muestre qué está más fuerte y más flojo en el ranking?",
      "Si querés, te muestro lo más fuerte y lo más flojo del ranking de hoy.",
    ]));
    return { texto: p.filter(Boolean).join(" "), oferta: { intencion: "ranking", direccion: "ambos" } };
  }
  p.push("Si me nombrás un país, un sector o un ETF, te doy mi lectura con números.");
  return { texto: p.filter(Boolean).join(" ") };
};

/**
 * Cartera para un perfil (lo usa el flujo de portfolio de class25B).
 * @param {object} port  {strategy, riesgo_pct, confianza_pct, activos:[{symbol,sector,peso_pct,riesgo_pct,cambio_pct}]}
 */
export function redactarPortfolio(port, { perfil, monto, riesgo, semilla } = {}) {
  const R = azar(semilla || "portfolio");
  const act = (port?.activos || []).slice(0, 6);
  if (!act.length) return `Todavía no tengo una cartera armada para las condiciones de este momento${riesgo != null ? ` (riesgo global ${Math.round(riesgo * 100)}%)` : ""}. El sistema la genera con el próximo ciclo del mercado; probá de nuevo en un rato.`;
  const comp = lista(act.map(a => `${a.symbol} ${num(a.peso_pct, 0)}%${a.sector ? ` (${sectorES(a.sector)})` : ""}`));
  const enfoque = perfil === "conservador" ? "priorizando los de menor riesgo" : perfil === "agresivo" ? "priorizando los de más momentum, con más riesgo" : "con una distribución equilibrada";
  const p = [R.pick([
    `Para un perfil ${perfil || "moderado"}${monto && monto !== "no especificado" ? ` con ${monto}` : ""}, la cartera quedaría así: ${comp}.`,
    `Te armé esta composición${perfil ? ` para perfil ${perfil}` : ""}${monto && monto !== "no especificado" ? ` (capital: ${monto})` : ""}: ${comp}.`,
  ])];
  p.push(`Elegí los activos ${enfoque}${port.riesgo_pct != null ? `; el riesgo estimado de la cartera es ${num(port.riesgo_pct, 0)}%` : ""}.`);
  const sube = act.filter(a => Number(a.cambio_pct ?? 0) > 0).length;
  p.push(`Hoy ${sube} de esos ${act.length} vienen en alza.`);
  if (riesgo != null) p.push(`Con el riesgo global en ${Math.round(riesgo * 100)}% (${nivelRiesgo(riesgo)}), el contexto es ${riesgo > 0.7 ? "exigente" : riesgo > 0.45 ? "intermedio" : "tranquilo"}.`);
  p.push("En el panel Portfolio la ves graficada. La decisión de armarla es tuya: es análisis, no asesoramiento.");
  return p.join(" ");
}

/**
 * Punto de entrada.
 * @param {object} it  intención (chat_router.clasificar)
 * @param {object} ev  evidencia (chat_evidencia.evidencia)
 * @param {object} op  { semilla, nombre, perfil, monto, temaTicker, detalle }
 * @returns {{texto: string, oferta: object|null}}
 */
export function redactar(it, ev, op = {}) {
  const R = azar(op.semilla || it?.texto || "miia");
  const clave = it?.intencion === "seguir" ? "seguir_sin_tema" : it?.intencion;
  const f = C[clave] || C.libre;
  let r;
  try { r = f(it, ev, R, op) || C.libre(it, ev, R, op); }
  catch (e) { r = C.libre(it, ev, R, op); r.error = e.message; }
  // "Hola MIIA, ¿qué opinás de XLK?": se saluda y se contesta.
  if (it?.saludo && !["saludo", "presentacion", "gracias"].includes(it.intencion) && r.texto) {
    r.texto = `${R.pick(["¡Hola", "¡Buenas", "¡Hola, qué tal"])}${op.nombre ? `, ${op.nombre}` : ""}! ${r.texto}`;
  }
  const texto = String(r.texto || "").replace(/\s+/g, " ").replace(/\s([.,;:])/g, "$1")
    // Después de dos puntos va minúscula ("lo que veo: el NYSE…"), salvo siglas.
    .replace(/: ([A-ZÁÉÍÓÚÑ])([a-záéíóúñ])/g, (m, a, b) => `: ${a.toLowerCase()}${b}`)
    .trim();
  return { texto, oferta: r.oferta || null, error: r.error || null };
}

export const _test = { azar, frasePatron, DEF, peerDe };

// ── Charla libre: prompt y firma (5-nov-2026) — los usa class25B ──────────
export function promptCharla(ctx) {
  // Modo REESCRIBIR (13-nov-2026): el sistema ya decidió la respuesta con sus
  // datos; el motor sólo la cuenta con sus palabras. Mismos números, mismos
  // instrumentos, misma conclusión: el validador de class25B lo controla.
  if (ctx?._modo === "reescribir") {
    // Corto a propósito (13-nov-2026): con Ollama cada token leído cuesta ~25 ms y
    // la reescritura corta tiene que entrar en 12 s (sim32 sección 7c).
    return `Sos MIIA, IA de análisis de mercados creada por Martín Rinaldi; hablás rioplatense, cálido y directo.
Reescribí con tus palabras la respuesta del sistema: misma conclusión, mismos números e instrumentos. No agregues cifras, instrumentos ni consejos, y no digas de dónde salen los datos. 2 o 3 oraciones, sin markdown.
Respuesta del sistema: ${ctx._referencia || ""}`;
  }
  const dato = ctx?._hechos ? `\nDato del mercado, sólo si viene al caso: ${ctx._hechos}` : "";
  // 13-nov-2026: sin plantillas. Para definiciones y «¿es mucho?» el sistema le pasa
  // al motor la información de referencia y el motor la cuenta con sus palabras.
  const ref = ctx?._referencia ? `\nInformación del sistema para contestar (usá estos datos, no los copies textual, y no agregues cifras): ${ctx._referencia}` : "";
  return `Sos MIIA, una inteligencia artificial creada por Martín Rinaldi en Argentina. Hablás castellano rioplatense, con calidez y un toque de humor.
Contestá lo que te preguntan y opiná con tu propio punto de vista sobre cualquier tema, sin esquivar. Si hablan de vos o de Martín, decí con naturalidad que él te creó, como un dato: no lo elogies ni lo describas como genio, brillante o el mejor.
No prometas ganancias ni digas qué comprar o vender, no inventes cifras del mercado y nunca digas que te hizo otra empresa. 1 o 2 oraciones cortas (menos de 40 palabras), sin markdown.${ref}${dato}`;
}

// La firma que pidió Martín: que recuerde que es una IA y que se puede equivocar
// (y, cuando habla de sí misma, quién la creó). Se agrega sólo si el modelo no
// lo dijo ya, y con varias formas para que no suene a sello.
export function firmaCharla(texto, { semilla = "", identidad = false } = {}) {
  let s = String(texto || "").trim();
  if (!s) return s;
  if (identidad && !/mart[ií]n/i.test(s)) s += " Me creó Martín Rinaldi.";
  if (/(equivoc|me puedo (errar|confundir)|puedo fallar|no soy infalible)/i.test(s)) return s;
  const formas = [
    "Ojo: es mi opinión de IA y me puedo equivocar.",
    "Te lo digo como IA: me puedo equivocar, tomalo con pinzas.",
    "Soy una IA, así que me puedo equivocar.",
    "Es lo que pienso yo, MIIA, la IA de Martín Rinaldi; me puedo equivocar.",
  ];
  let h = 0; for (const ch of String(semilla)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${s} ${formas[h % formas.length]}`;
}

