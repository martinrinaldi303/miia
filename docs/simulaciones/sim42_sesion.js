// ============================================================
// sim42_sesion.js — sesión obligatoria con Google (20-nov-2026)
// ============================================================
//
// Decisión de Martín: para ver o usar MIIA hay que entrar con Google. Quedan
// públicas sólo las páginas informativas. Esto prueba las dos mitades:
//
//   1. La puerta de class30 (las funciones puras de seguridad_red.js y que
//      class30 las aplique a /api, a /socket.io y a los upgrades WebSocket).
//   2. El guardián de index.html, ejecutado de verdad en un contexto falso de
//      navegador: con token vigente entra, sin token o vencido va a la portada,
//      y la vuelta del login (?token=) se guarda antes que nada.
//
//   node docs/simulaciones/sim42_sesion.js
import fs   from "node:fs";
import path from "node:path";
import vm   from "node:vm";
import { fileURLToPath } from "node:url";
import { apiRequiereSesion, tokenDelPedido, API_PUBLICAS } from "../../scripts/seguridad_red.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
const leer = p => fs.readFileSync(path.join(RAIZ, p), "utf8").replace(/\r\n/g, "\n");

let ok = 0, mal = 0;
function check(nombre, cond, extra = "") {
  if (cond) { ok++; console.log(`  [OK]   ${nombre}`); }
  else      { mal++; console.log(`  [FALLA] ${nombre}${extra ? " — " + extra : ""}`); }
}

// ── 1 · Qué rutas exigen sesión ─────────────────────────────
console.log("1 · rutas de /api");
for (const r of ["/precios", "/portfolio", "/ask", "/chat", "/serie", "/admin/users", "/market", "/predicciones"])
  check(`${r} exige sesión`, apiRequiereSesion(r));
check("la portada pública ve la evidencia", !apiRequiereSesion("/backtesting/professional"));
check("los webhooks de pago no exigen sesión", !apiRequiereSesion("/mercadopago/webhook") && !apiRequiereSesion("/subscribe/webhook"));
check("con barra final o query igual se reconoce", !apiRequiereSesion("/backtesting/professional/") && !apiRequiereSesion("/health-python?x=1"));
check("una ruta parecida NO se cuela", apiRequiereSesion("/backtesting/professionalX") && apiRequiereSesion("/backtesting/historial"));
check("la lista pública es corta (≤ 6)", API_PUBLICAS.size <= 6, `tiene ${API_PUBLICAS.size}`);

// ── 2 · De dónde sale el token ──────────────────────────────
console.log("2 · el token del pedido");
check("header Bearer", tokenDelPedido({ headers: { authorization: "Bearer abc.def" }, url: "/api/x" }) === "abc.def");
check("bearer en minúsculas", tokenDelPedido({ headers: { authorization: "bearer xyz" }, url: "/" }) === "xyz");
check("?token= para los WebSocket", tokenDelPedido({ headers: {}, url: "/chat-ws?token=t1" }) === "t1");
check("socket.io con más parámetros", tokenDelPedido({ headers: {}, url: "/socket.io/?EIO=4&transport=websocket&token=t2" }) === "t2");
check("sin nada → null", tokenDelPedido({ headers: {}, url: "/api/precios" }) === null);
check("Bearer vacío no cuenta", tokenDelPedido({ headers: { authorization: "Bearer " }, url: "/" }) === null);

// ── 3 · class30 aplica la puerta ────────────────────────────
console.log("3 · class30");
const c30 = leer("scripts/class30.js");
const iGate   = c30.indexOf("apiRequiereSesion(req.path)");
const iStatic = c30.indexOf('app.use("/", express.static(publicDir))');
const iRuta   = c30.indexOf('app.get("/api/precios"');
check("hay puerta en /api", iGate > 0);
check("la puerta va antes que las rutas de datos", iGate > 0 && iGate < iRuta);
check("y antes que los estáticos", iGate > 0 && iGate < iStatic);
const sio = c30.slice(c30.indexOf('app.use("/socket.io"'), c30.indexOf('app.use("/socket.io"') + 400);
check("el polling de Socket.IO exige sesión", /_usuarioDelPedido\(req\)/.test(sio));
const up = c30.slice(c30.indexOf('server.on("upgrade"'), c30.indexOf('server.on("upgrade"') + 900);
check("el upgrade WebSocket exige sesión", /401 Unauthorized/.test(up) && /_usuarioDelPedido\(req\)/.test(up));
check("la sesión se valida con class14.verifyToken (mismo secreto)", /class14\.verifyToken\(t\)/.test(c30));
check("hay reversa sin código (MIIA_SESION_OBLIGATORIA=0)", /MIIA_SESION_OBLIGATORIA/.test(c30));

// ── 4 · El guardián de index.html, ejecutado ────────────────
console.log("4 · guardián de index.html");
const html = leer("scripts/publi_src/index.html");
const a = html.indexOf("<script data-claro>");
const guard = html.slice(a + "<script data-claro>".length, html.indexOf("</script>", a));
check("es el primer script de la página", a > 0 && a < html.indexOf("<script", html.indexOf("<head")) + 5 || a === html.indexOf("<script"));

function jwtFalso(expSeg) {
  const b = o => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b({ alg: "HS256" })}.${b({ email: "x@y.z", exp: expSeg })}.firma`;
}
function correr({ search = "", guardado = null, protocolo = "https:", puerto = "" } = {}) {
  const store = new Map(guardado ? [["miia_jwt", guardado]] : []);
  const ctx = {
    location: { search, protocol: protocolo, port: puerto, origin: "https://miiaia.com", replaced: null,
                replace(u) { this.replaced = u; } },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                    removeItem: k => store.delete(k) },
    URLSearchParams, atob: s => Buffer.from(s, "base64").toString("binary"), JSON, Date, Headers,
    window: {}, Promise,
  };
  ctx.window.fetch = async () => ({ status: 200 });
  vm.runInNewContext(guard, ctx);
  return { destino: ctx.location.replaced, store, fetch: ctx.window.fetch };
}
const ahora = Math.floor(Date.now() / 1000);
check("sin token → portada", correr().destino === "/que-es-miia.html?entrar=1");
check("token vigente → entra", correr({ guardado: jwtFalso(ahora + 86400) }).destino === null);
const venc = correr({ guardado: jwtFalso(ahora - 10) });
check("token vencido → portada y se borra", venc.destino === "/que-es-miia.html?entrar=1" && !venc.store.has("miia_jwt"));
check("basura en vez de token → portada", correr({ guardado: "no-es-un-jwt" }).destino !== null);
const vuelta = correr({ search: `?token=${jwtFalso(ahora + 86400)}&user=Martin` });
check("vuelta del login: entra y guarda el token", vuelta.destino === null && vuelta.store.has("miia_jwt"));
check("modo local (:5005) no exige nada", correr({ protocolo: "http:", puerto: "5005" }).destino === null);

// el fetch envuelto pone el header en /api y no fuera
{
  const tk = jwtFalso(ahora + 86400);
  const store = new Map([["miia_jwt", tk]]);
  let visto = null;
  const ctx = {
    location: { search: "", protocol: "https:", port: "", origin: "https://miiaia.com", replace() {} },
    localStorage: { getItem: k => store.get(k) ?? null, setItem() {}, removeItem() {} },
    URLSearchParams, atob: s => Buffer.from(s, "base64").toString("binary"), JSON, Date, Headers, Promise,
    window: { fetch: async (u, o) => { visto = o; return { status: 200 }; } },
  };
  vm.runInNewContext(guard, ctx);
  await ctx.window.fetch("/api/precios");
  check("fetch a /api lleva Authorization", visto?.headers?.get?.("Authorization") === `Bearer ${tk}`);
  visto = "sin-tocar";
  await ctx.window.fetch("https://cdn.socket.io/x.js");
  check("fetch a otro sitio NO lleva el token", visto === undefined);
}

// ── 5 · El resto de la web ──────────────────────────────────
console.log("5 · sockets y portada");
check("el WebSocket del chat manda el token", /new WebSocket\(_wsUrl\(\)\)/.test(html));
check("Socket.IO manda el token", /query:\{token:_tokenSesion\(\)\}/.test(html));
check("cerrar sesión vuelve a la portada", /Sin sesión no se puede usar MIIA/.test(html));
const portada = leer("scripts/publi_src/que-es-miia.html");
check("la portada tiene 'Entrar con Google'", (portada.match(/href="\/auth\/google"/g) || []).length >= 2);
check("la portada NO redirige sola al panel (sin bucle)", !/location\.replace\(/.test(portada));

console.log(`\n${ok} OK · ${mal} fallas`);
process.exit(mal ? 1 : 0);
