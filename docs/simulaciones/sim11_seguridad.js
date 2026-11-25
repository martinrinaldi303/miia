// ============================================================
// sim11_seguridad.js — los puntos abiertos de la auditoría
// ============================================================
//
// Cubre tres de los cinco puntos que la auditoría del 9-sep-2026 dejó abiertos,
// ejecutando el código real:
//
//   1. **El bus salía al público sin autenticación.** class46 no tenía auth de
//      ningún tipo y class30 lo tunelea en `https://miiaia.com/socket.io/`: se
//      capturaron 241 KB en un minuto con `curl`, sin token, con la decisión
//      final, el LSTM y los vectores internos adentro.
//   3. **El rate limit era falsificable.** Tomaba el primer valor de
//      `X-Forwarded-For` sin validar; contra el origen directo —que se saltea
//      Cloudflare— eso lo controla el cliente.
//   4. **WebSockets sin validación de `Origin`**: cualquier página de cualquier
//      dominio podía abrir un socket contra MIIA desde el navegador de un
//      visitante.
//
// Los puntos 2 (Cloudflare se saltea) y 5 (cabeceras) no se prueban acá: el 2
// es firewall y el 5 son headers que se ven con `curl -I` contra el server.
//
//   node docs/simulaciones/sim11_seguridad.js

// Antes de importar class46: lee JWT_SECRET al cargarse.
process.env.JWT_SECRET = process.env.JWT_SECRET
  || "secreto-de-prueba-de-al-menos-32-caracteres-para-sim11";
process.env.ADMIN_MASTER_EMAIL = "admin@example.com";
process.env.CLASS46_SOLO_MODULO = "1";

import jwt  from "jsonwebtoken";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

// El módulo loguea al cargarse; ver sim6.
const _origLog = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0] ?? ""))) _origLog(...a); };

const red = await import("../../scripts/seguridad_red.js");
const { _test: c46 } = await import("../../scripts/class46.js");

let fallos = 0;
const chequear = (que, ok, det = "") => {
  console.log(`   ${ok ? "[ok]" : "[NO]"} ${que.padEnd(54)} ${det}`);
  if (!ok) fallos++;
};

console.log("\n=== Seguridad — puntos 1, 3 y 4 de la auditoría ==============");

// ── PUNTO 3 · la IP no se puede falsificar ───────────────────────────────
console.log("\n3 · El rate limit ya no se puede falsificar");
{
  // Una conexión DIRECTA al 8443 (salteando Cloudflare) que miente su XFF.
  const directa = { socket: { remoteAddress: "8.8.8.8" },
                    headers: { "x-forwarded-for": "1.2.3.4" } };
  chequear("conexión directa: se IGNORA el X-Forwarded-For",
           red.ipReal(directa) === "8.8.8.8", `= ${red.ipReal(directa)}`);

  // Cada pedido con un XFF distinto era la forma de esquivar el límite.
  const inventadas = ["9.9.9.1", "9.9.9.2", "9.9.9.3"].map(f =>
    red.ipReal({ socket: { remoteAddress: "8.8.8.8" },
                 headers: { "x-forwarded-for": f } }));
  chequear("tres XFF distintos dan la MISMA clave de límite",
           new Set(inventadas).size === 1, `→ ${inventadas[0]}`);

  // Desde Cloudflare sí se cree, que es para lo que existe el header.
  const cf = { socket: { remoteAddress: "162.158.1.1" },
               headers: { "cf-connecting-ip": "1.2.3.4" } };
  chequear("desde Cloudflare SÍ se toma la IP real del visitante",
           red.ipReal(cf) === "1.2.3.4", `= ${red.ipReal(cf)}`);

  chequear("Cloudflare está en la lista de confiables",
           red.esProxyConfiable("162.158.1.1") && red.esProxyConfiable("104.16.0.1"));
  chequear("una IP cualquiera NO es confiable",
           !red.esProxyConfiable("8.8.8.8") && !red.esProxyConfiable("200.1.2.3"));
  chequear("localhost sí (los proxies internos)", red.esProxyConfiable("127.0.0.1"));
  chequear("IPv4 mapeada en IPv6 se entiende",
           red.esProxyConfiable("::ffff:127.0.0.1"));
  chequear("una IP basura no rompe nada",
           red.esProxyConfiable("no-es-una-ip") === false &&
           red.esProxyConfiable("999.1.1.1")   === false);
}

// ── PUNTO 4 · Origin en los WebSocket ────────────────────────────────────
console.log("\n4 · Los WebSocket validan el Origin");
{
  const con = (o) => red.origenPermitido({ headers: o ? { origin: o } : {}, socket: {} });
  chequear("miiaia.com pasa",             con("https://miiaia.com"));
  chequear("www.miiaia.com pasa",         con("https://www.miiaia.com"));
  chequear("localhost:8443 pasa",         con("https://localhost:8443"));
  chequear("un dominio ajeno se RECHAZA", !con("https://sitio-malicioso.com"));
  chequear("un subdominio parecido se RECHAZA", !con("https://miiaia.com.evil.net"));
  chequear("sin Origin pasa (curl, los testers)", con(null));
  chequear("mayúsculas no lo esquivan",   con("HTTPS://MIIAIA.COM"));
}

// ── PUNTO 1 · el bus pide credencial ─────────────────────────────────────
console.log("\n1 · El bus ya no sale al público entero");
{
  const nivelDe = (token) =>
    c46.nivelDelHandshake(token ? { auth: { token } } : {}).nivel;

  chequear("sin token: anónimo", nivelDe(null) === "publico",
           `= ${nivelDe(null)}`);
  chequear("un token inventado: anónimo, no un error",
           nivelDe("no.es.un.token") === "publico");

  const tokenUsuario = jwt.sign({ user_id: 7, email: "alguien@gmail.com" },
                                process.env.JWT_SECRET);
  chequear("token válido: autenticado", nivelDe(tokenUsuario) === "autenticado");

  const tokenAdmin = jwt.sign({ user_id: 1, email: "ADMIN@Example.com" },
                              process.env.JWT_SECRET);
  chequear("la cuenta maestra: admin (sin importar mayúsculas)",
           nivelDe(tokenAdmin) === "admin");

  const tokenOtroSecreto = jwt.sign({ email: "x@y.com" }, "otro-secreto-cualquiera-largo");
  chequear("token firmado con otro secreto: anónimo",
           nivelDe(tokenOtroSecreto) === "publico");

  // Qué ve cada nivel
  const permitidos = (nivel) =>
    c46.CANALES.filter(c => c46.NIVELES[nivel] >= c46.NIVELES[c46.nivelDeCanal(c)]);
  const pub = permitidos("publico"), aut = permitidos("autenticado"), adm = permitidos("admin");

  console.log(`      anónimo ve ${pub.length}/${c46.CANALES.length} canales · ` +
              `autenticado ${aut.length} · admin ${adm.length}`);
  chequear("el anónimo NO ve los internos",
           !pub.includes("class25a_output") && !pub.includes("class18_ingest"),
           "class25a_output y class18_ingest cerrados");
  chequear("el admin los ve", adm.includes("class25a_output") && adm.includes("class18_ingest"));
  chequear("el anónimo sigue viendo el showcase",
           pub.includes("class25_output") && pub.includes("class44_output") &&
           pub.includes("class1_output"), "la página pública no queda a oscuras");
  chequear("cada nivel ve al menos lo del anterior",
           pub.every(c => aut.includes(c)) && aut.every(c => adm.includes(c)));

  // FAIL-CLOSED: un canal que nadie clasificó no se filtra.
  chequear("un canal sin clasificar cae en `admin` (default seguro)",
           c46.nivelDeCanal("canal_inventado_manana") === "admin");
}

// ── El JSON y el respaldo de class46 coinciden ───────────────────────────
console.log("\n5 · La configuración y su respaldo");
{
  const cfg = JSON.parse(fs.readFileSync(
    path.join(RAIZ, "operador", "aprendizaje", "config", "canales_socket.json"), "utf8"));
  const delJson = Object.keys(cfg.canales).sort();
  const enUso   = Object.keys(c46.ACCESO).sort();
  chequear("class46 carga el JSON, no el respaldo",
           JSON.stringify(delJson) === JSON.stringify(enUso),
           `${enUso.length} canales`);
  const sinClasificar = c46.CANALES.filter(c => !cfg.canales[c]);
  chequear("todos los canales suscriptos están clasificados",
           sinClasificar.length === 0,
           sinClasificar.length ? sinClasificar.join(",") : "");
}

// ── El subconjunto publico dentro de class18_ingest (10-oct-2026) ────────
//
// Cerrar class18_ingest el 21-sep apago el Regimen y el Impacto Mediatico del
// panel PUBLICO, para todos los visitantes, y se vio recien el 10-oct. Pero
// abrirlo entero filtraria lo que manda class14: user_id, plan, tolerancia al
// riesgo y sectores seguidos de cada usuario. El filtro va adentro, por
// `source`. Esta seccion es la que impide que alguien lo "arregle" abriendolo.
console.log("");
console.log("5.1 · El subconjunto publico de class18_ingest");
{
  const cfg = JSON.parse(fs.readFileSync(
    path.join(RAIZ, "operador", "aprendizaje", "config", "canales_socket.json"), "utf8"));

  chequear("el JSON y el respaldo de class46 coinciden",
           JSON.stringify(cfg.publico_por_source) === JSON.stringify(c46.PUBLICO_POR_SOURCE));

  chequear("class18_ingest sigue siendo `admin` como canal",
           c46.nivelDeCanal("class18_ingest") === "admin",
           "el filtro NO lo abre");

  chequear("pero tiene subconjunto publico",
           c46.tieneSubconjuntoPublico("class18_ingest") === true);

  // Lo que SI tiene que pasar: las dos tarjetas del panel publico.
  chequear("class13 (regimen) pasa",
           c46.esMensajePublico("class18_ingest", { source: "class13", type: "cluster_regime" }) === true);
  chequear("class11 (impacto) pasa",
           c46.esMensajePublico("class18_ingest", { source: "class11" }) === true);

  // LO QUE NO: es el punto entero de esta seccion.
  chequear("class14 NO pasa  <-- user_id, plan, tolerancia, sectores",
           c46.esMensajePublico("class18_ingest", {
             source: "class14", type: "profile_update", user_id: "u-123",
             plan: "pro", perfil: { tolerancia_riesgo: "agresivo" } }) === false,
           "perfiles de usuario");
  chequear("class15 (portfolio) NO pasa",
           c46.esMensajePublico("class18_ingest", { source: "class15" }) === false);
  chequear("class17 (portfolio) NO pasa",
           c46.esMensajePublico("class18_ingest", { source: "class17" }) === false);
  chequear("un source desconocido NO pasa",
           c46.esMensajePublico("class18_ingest", { source: "class99" }) === false,
           "lista blanca, no negra");
  chequear("sin campo `source` NO pasa",
           c46.esMensajePublico("class18_ingest", { data: {} }) === false);

  // Un canal sin subconjunto no se abre por accidente.
  chequear("class25a_output no tiene subconjunto publico",
           c46.tieneSubconjuntoPublico("class25a_output") === false);
  chequear("y ningun mensaje suyo pasa",
           c46.esMensajePublico("class25a_output", { source: "class25A" }) === false);
  chequear("un canal inventado tampoco",
           c46.tieneSubconjuntoPublico("canal_inventado_manana") === false);

  // El anonimo tiene que terminar con los 7 publicos + la sala parcial.
  const nivel = "publico";
  const permitidos = c46.CANALES.filter(c => c46.NIVELES[nivel] >= c46.NIVELES[c46.nivelDeCanal(c)]);
  const parciales  = c46.CANALES.filter(c => !permitidos.includes(c) && c46.tieneSubconjuntoPublico(c));
  chequear("un anonimo NO tiene class18_ingest entero",
           !permitidos.includes("class18_ingest"));
  chequear("pero SI entra a su sala parcial",
           parciales.includes("class18_ingest"),
           "de ahi salen Regimen e Impacto");
  chequear("y las salas no se solapan",
           permitidos.every(c => !parciales.includes(c)),
           "estar en las dos duplicaria cada mensaje");
}

// ── Punto 5 · HSTS: en produccion si, en localhost no ────────────────────
//
// El 26-sep la web local dejo de abrir: con HSTS puesto, Chrome ya no ofrece el
// «Avanzado → continuar» sobre un certificado autofirmado, y
// ERR_CERT_AUTHORITY_INVALID se vuelve un callejon sin salida. La guarda por
// `Host` lo arregla — pero la PRIMERA version se partia con split(":"), que
// sobre [::1]:8443 devuelve "[" en vez de "[::1]", asi que el loopback IPv6
// seguia recibiendo HSTS. Y Chrome en Windows resuelve `localhost` a ::1
// PRIMERO, o sea que el caso de borde era el caso normal.
console.log("");
console.log("6 · HSTS — produccion si, loopback no (el 26-sep tumbo la web local)");
{
  const hsts = (host, secure = true, proto = "https") =>
    red.mandarHsts({ secure, headers: { host, "x-forwarded-proto": proto } });

  // Produccion: el header tiene que salir igual que siempre.
  chequear("miiaia.com recibe HSTS",           hsts("miiaia.com") === true);
  chequear("www.miiaia.com:8443 tambien",      hsts("www.miiaia.com:8443") === true);
  chequear("el origen directo por IP tambien", hsts("203.0.113.10:8443") === true,
           "se saltea Cloudflare, asi que el header tiene que ir en el codigo");

  // Loopback: NO, por los cuatro caminos con que se lo puede escribir.
  chequear("localhost NO recibe HSTS",         hsts("localhost:8443") === false);
  chequear("y en mayusculas tampoco",          hsts("LOCALHOST:8443") === false);
  chequear("127.0.0.1 tampoco",                hsts("127.0.0.1:8443") === false);
  chequear("cualquier 127.x.x.x tampoco",      hsts("127.1.2.3:8443") === false,
           "todo el /8 es loopback");
  chequear("[::1] tampoco  <-- el bug del split",
           hsts("[::1]:8443") === false,
           "Chrome en Windows resuelve localhost a ::1 primero");
  chequear("[::1] sin puerto tampoco",         hsts("[::1]") === false);
  chequear("el v6 expandido tampoco",          hsts("[0:0:0:0:0:0:0:1]:8443") === false);

  // Y no se pasa de largo: un IPv6 PUBLICO si tiene que llevar HSTS.
  chequear("un IPv6 publico SI lleva HSTS",    hsts("[2001:db8::1]:8443") === true,
           "la guarda es para loopback, no para todo IPv6");

  // Sin TLS no se manda nunca: por HTTP plano el header no hace nada.
  chequear("sin TLS no se manda",              hsts("miiaia.com", false, "http") === false);
  // Un pedido sin `Host` no es local: ante la duda, se protege.
  chequear("sin cabecera Host se manda igual", hsts("") === true, "fail-safe hacia proteger");
}

console.log(`\n${fallos === 0 ? "PASA" : "FALLA"} — seguridad\n`);
process.exit(fallos === 0 ? 0 : 1);
