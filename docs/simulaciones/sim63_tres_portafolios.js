// sim63 — hasta 3 portafolios por usuario (26-nov-2026).
// Corre el chat_portafolios.js real y revisa que class25B, el Python y la web
// estén enchufados. node docs/simulaciones/sim63_tres_portafolios.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const P = await import(pathToFileURL(path.join(RAIZ, "scripts/chat_portafolios.js")).href);
const { normalizarPortfolio } = await import(pathToFileURL(path.join(RAIZ, "scripts/chat_portfolio.js")).href);

let ok = 0, mal = 0;
const chequear = (nombre, cond, det = "") => {
  if (cond) ok++; else mal++;
  console.log(`   [${cond ? "ok" : "FALLA"}] ${nombre}${det ? "  — " + det : ""}`);
};
const cartera = (perfil, simbolos, monto = null) => ({
  perfil, monto, ts: "2026-11-26T12:00:00.000Z",
  activos: simbolos.map((s, i) => ({ symbol: s, sector: "x", peso_pct: Math.round(100 / simbolos.length) - (i ? 0 : 0), riesgo_pct: 40, cambio_pct: 1.2, monto: 100 })),
});
const sl = r => P.slot(r, normalizarPortfolio);

console.log("1 · Agregar hasta 3 y no más");
let e = null;
let r = P.agregar(e, sl(cartera("agresivo", ["SPY", "QQQ"], "10000")));  e = r.entrada;
chequear("el primero se guarda y queda activo", r.guardado && e.ports.length === 1 && e.activo === 0);
r = P.agregar(e, sl(cartera("moderado", ["XLV", "XLU"])));  chequear("el segundo queda activo", r.guardado && e.activo === 1);
r = P.agregar(e, sl(cartera("conservador", ["XLP", "XLU"]))); chequear("el tercero queda activo", r.guardado && e.activo === 2);
r = P.agregar(e, sl(cartera("agresivo", ["SMH", "XLK"])));
chequear("con 3, un cuarto NO se guarda", !r.guardado && e.ports.length === 3);
chequear("y el activo no cambia", e.activo === 2);

console.log("2 · Reemplazar, activar y borrar");
chequear("reemplazar el 1 lo deja activo", P.reemplazar(e, 1, sl(cartera("agresivo", ["SMH", "XLK"]))) && e.activo === 0
  && P.activoDe(e).activos.some(a => a.symbol === "SMH"));
chequear("reemplazar un lugar inexistente no hace nada", !P.reemplazar(e, 4, sl(cartera("moderado", ["SPY"]))));
chequear("activar el 2", P.activar(e, 2) && e.activo === 1);
chequear("borrar el 1 corre el activo (2 → 1)", P.borrar(e, 1) && e.ports.length === 2 && e.activo === 0);
chequear("borrar el activo deja uno válido", P.borrar(e, 1) && e.ports.length === 1 && e.activo === 0);
chequear("borrar el último deja la lista vacía", P.borrar(e, 1) && e.ports.length === 0 && P.activoDe(e) === null);

console.log("3 · Migración del formato viejo (un solo portafolio)");
const v1 = { uid: "u_abc1234", guardado: Date.now(), port: cartera("moderado", ["SPY", "IWM"], "5000"), config: { plazo: "medio" } };
const m = P.normalizarEntrada(v1, normalizarPortfolio);
chequear("el viejo pasa a ser el slot 1", m && m.ports.length === 1 && m.activo === 0);
chequear("y conserva la vista para el panel", !!m.ports[0].vista?.activos?.length);
chequear("una entrada rota no explota", P.normalizarEntrada({ ports: [{ port: "x" }, null] }, normalizarPortfolio).ports.length === 0);

console.log("4 · Lo que viaja a la web");
e = P.agregar(null, sl(cartera("agresivo", ["SPY", "QQQ"], "10000"))).entrada;
P.agregar(e, sl({ ...cartera(null, ["EWZ", "ARGT"]), modo: "manual" }));
const res = P.resumen(e);
chequear("resumen con activo 1-based y la lista", res.activo === 2 && res.lista.length === 2 && res.max === 3);
chequear("la etiqueta del automático dice el perfil y el capital", /Agresivo · 10000/.test(res.lista[0].etiqueta), res.lista[0].etiqueta);
chequear("la del manual dice que la armó el usuario", /Armado por vos · EWZ, ARGT/.test(res.lista[1].etiqueta), res.lista[1].etiqueta);
chequear("la vista conserva monto y cambio por activo (el panel los muestra)", res.lista[0].port.activos[0].monto === 100 && res.lista[0].port.activos[0].cambio_pct === 1.2);
chequear("sin portafolios: lista vacía", P.resumen(null).lista.length === 0);

console.log("5 · Comandos del chat");
const casos = [
  ["mis portafolios", "listar"], ["¿cuántos portafolios tengo?", "listar"], ["que carteras tengo", "listar"],
  ["usá el portafolio 2", "activar", 2], ["pasame a la cartera dos", "activar", 2], ["usar portafolio número 3", "activar", 3],
  ["el portafolio 1", "activar", 1], ["mostrame el segundo portafolio", "activar", 2], ["cambiá a la cartera tres", "activar", 3],
  ["borrá el portafolio 3", "borrar", 3], ["eliminá la cartera 1", "borrar", 1], ["borra el 2", "borrar", 2],
  ["¿mi portafolio sirve para este mercado?", null], ["armame un portafolio", null], ["borrá mi cartera", null],
  ["qué opinás de XLK", null], ["dale", null],
];
for (const [txt, acc, n] of casos) {
  const c = P.entenderComando(txt);
  const bien = acc === null ? c === null : (c?.accion === acc && (n === undefined || c.n === n));
  chequear(`«${txt}» → ${acc || "nada"}${n ? " " + n : ""}`, bien, JSON.stringify(c));
}

console.log("6 · Elegir cuál reemplazar");
for (const [txt, esp] of [["el 2", 2], ["la tercera", 3], ["1", 1], ["cancelar", "cancelar"], ["no, dejalo", "cancelar"], ["mejor no", "cancelar"], ["qué opinás de XLK", null]]) {
  chequear(`«${txt}» → ${esp}`, P.elegirReemplazo(txt) === esp, String(P.elegirReemplazo(txt)));
}

console.log("7 · Textos");
e = P.agregar(null, sl(cartera("agresivo", ["SPY"]))).entrada;
P.agregar(e, sl(cartera("moderado", ["XLV"]))); P.agregar(e, sl(cartera("conservador", ["XLP"])));
chequear("la pregunta de reemplazo lista los 3 y ofrece cancelar", /1\).*2\).*3\)/.test(P.textoPedirReemplazo(e)) && /cancelar/.test(P.textoPedirReemplazo(e)));
chequear("la lista marca el activo", /\(la activa\)/.test(P.textoLista(e)));
chequear("sin portafolios lo dice y ofrece armar uno", /armame un portafolio/.test(P.textoLista(null)));

console.log("8 · Enchufes (class25B, Python, web)");
const c25 = fs.readFileSync(path.join(RAIZ, "scripts/class25B.js"), "utf8").replace(/\r\n/g, "\n");
chequear("class25B importa chat_portafolios.js", c25.includes("from " + '"./chat_portafolios' + '.js"'));
chequear("el router mira los portafolios antes que nada", /_hidratarSesion\(sesion, msg\);\n\s*if \(await _chatPortafolios\(texto, msg, sesion\)\) return true;/.test(c25));
chequear("la clave es la cuenta y, si no, el navegador", c25.includes("msg?.clave_portafolio || msg?.user_id"));
chequear("cada respuesta lleva la lista", c25.includes("reply.mis_portafolios = portsResumen(_entradaPort(msg))"));
chequear("con 3 no guarda y pregunta", c25.includes('sesion.paso = "reemplazar_portafolio"'));
chequear("el archivo guarda el resumen para el Python", c25.includes("resumen: portsResumen(e)"));
const py = fs.readFileSync(path.join(RAIZ, "MIIA/miia_chatbot.py"), "utf8");
chequear("el Python manda la clave en /api/ask", py.includes('"clave_portafolio":  _clave_portafolio(request, user_id)'));
chequear("y devuelve la lista", py.includes('"mis_portafolios": data.get("mis_portafolios")'));
chequear("/api/portfolio trae la lista", py.includes('"mis_portafolios":  mis_ports'));
const web = fs.readFileSync(path.join(RAIZ, "scripts/publi_src/index.html"), "utf8");
chequear("la web aplica la lista del chat", web.includes("if (d.mis_portafolios) _aplicarMisPortafolios(d.mis_portafolios);"));
chequear("la web confirma antes de borrar", web.includes("¿Borrar el portafolio ${n}? No se puede deshacer."));
chequear("la ✕ de las conversaciones se ve en el celular", web.includes(".conv-del { opacity: 1 !important;"));

console.log(`\n${mal ? "FALLA" : "OK"} — tres portafolios  (${ok + mal} checks, ${mal} fallas)`);
process.exit(mal ? 1 : 0);
