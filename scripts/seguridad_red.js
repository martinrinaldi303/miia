// ============================================================
// seguridad_red.js — de quién viene un pedido, y si se le cree
// ============================================================
//
// Por qué está aparte (21-sep-2026): son funciones PURAS, y sacándolas de
// class30 la simulación las puede ejercitar sin arrastrar class14 y class42
// —que intentan conectarse a MySQL al importarse— ni abrir el 8443.
//
// Cubren dos de los cinco puntos abiertos de la auditoría del 9-sep:
//   · punto 3, el rate limit falsificable por `X-Forwarded-For`;
//   · punto 4, los WebSocket sin validación de `Origin`.
//
//   import { ipReal, origenPermitido } from "./seguridad_red.js";

// ══ IP REAL DEL CLIENTE (21-sep-2026) ════════════════════════
//
// El rate limit tomaba el primer valor de `X-Forwarded-For` sin validar nada.
// Contra el origen directo (`https://203.0.113.10:8443/`, que se saltea
// Cloudflare) **el cliente controla ese header**: mandar uno distinto en cada
// pedido vuelve el límite decorativo.
//
// La regla correcta: el header se cree SÓLO si quien lo manda es un proxy
// conocido. Si la conexión viene de cualquier otro lado, vale la IP del socket
// y los headers se ignoran.
//
// La lista es la de Cloudflare (cloudflare.com/ips). **Hay que refrescarla si
// Cloudflare la cambia**; se puede pisar con MIIA_PROXIES_CONFIABLES, una lista
// de CIDR separados por coma. El arreglo de fondo del punto 2 sigue siendo el
// firewall: que 8443 sólo acepte conexiones de Cloudflare.
export const PROXIES_CONFIABLES = (process.env.MIIA_PROXIES_CONFIABLES ||
  "173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22," +
  "141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20," +
  "197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13," +
  "104.24.0.0/14,172.64.0.0/13,131.0.72.0/22," +
  "127.0.0.0/8"           // el propio host: los proxies internos
).split(",").map(x => x.trim()).filter(Boolean).map(cidr => {
  const [base, bitsTxt] = cidr.split("/");
  const bits = Number(bitsTxt);
  const n = base.split(".").reduce((a, o) => (a << 8 >>> 0) + (Number(o) & 255), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return { red: (n & mask) >>> 0, mask };
});

function _aEntero(ip) {
  const limpio = String(ip || "").replace(/^::ffff:/, "");
  const p = limpio.split(".");
  if (p.length !== 4) return null;                    // IPv6 puro: no se compara
  let n = 0;
  for (const o of p) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = ((n << 8 >>> 0) + v) >>> 0;
  }
  return n;
}

export function esProxyConfiable(ip) {
  const n = _aEntero(ip);
  if (n === null) return false;
  return PROXIES_CONFIABLES.some(({ red, mask }) => ((n & mask) >>> 0) === red);
}

/** La IP del cliente, o la del socket si los headers no son de fiar. */
export function ipReal(req) {
  const socketIp = req.socket?.remoteAddress || "?";
  if (!esProxyConfiable(socketIp)) return socketIp;   // conexión directa
  return String(req.headers["cf-connecting-ip"] || "").trim()
      || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || socketIp;
}


// ══ ¿EL PEDIDO ES A UN HOST LOCAL? (26-sep-2026) ═════════════════
//
// Decide si mandar HSTS. Vive acá y no dentro del middleware de class30 por el
// mismo motivo que las otras dos de este archivo: **así se puede probar sin
// abrir el 8443 ni arrastrar class14/class42, que intentan conectarse a MySQL
// al importarse.** La lógica es exactamente la que estaba en el middleware.
//
// POR QUÉ NO SE MANDA HSTS A LOCALHOST. El certificado local es autofirmado, y
// con HSTS puesto Chrome deja de ofrecer el «Avanzado → continuar»: la pantalla
// de ERR_CERT_AUTHORITY_INVALID se vuelve un callejón sin salida y la interfaz
// local queda inalcanzable. Peor, `includeSubDomains` sobre `localhost` fuerza
// https en CUALQUIER otro proyecto que el navegador abra en localhost, y la
// marca dura un año en su caché (se borra a mano en
// chrome://net-internals/#hsts → Delete domain security policies → localhost).
//
// Se mira el header `Host`, no la IP del socket: es el nombre con el que el
// NAVEGADOR va a guardar la marca de HSTS, que es lo que importa. En producción
// el Host es miiaia.com y el header sale igual que siempre.
//
// Costo medido: 126 ns por request (3 M de llamadas). Para sumar 1 ms harían
// falta ~8.000 requests; la `stat` que `express.static` hace antes de cada ruta
// /api cuesta 38.000 ns, o sea 305 veces más. No es un punto de latencia.
// ⚠️ EL IPv6 NO SE PARTE CON split(":") — la primera versión de esta guarda sí,
// y por eso dejaba pasar HSTS a `[::1]`. `"[::1]:8443".split(":")[0]` devuelve
// `"["`, no `"[::1]"`, porque el literal tiene dos puntos adentro. Y eso no es
// un caso de borde: **Chrome en Windows resuelve `localhost` a `::1` primero**,
// así que entrar por `https://[::1]:8443` traía de vuelta exactamente el
// callejón sin salida del certificado que esta guarda viene a evitar.
//
// Un host IPv6 en el header `Host` va SIEMPRE entre corchetes (RFC 3986), así
// que el corchete es el discriminante: si está, el host termina en el `]`.
function hostSinPuerto(raw) {
  const h = String(raw || "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const cierre = h.indexOf("]");
    return cierre > 0 ? h.slice(1, cierre) : h.slice(1);   // sin corchetes
  }
  return h.split(":")[0];
}

export function esHostLocal(req) {
  const host = hostSinPuerto(req?.headers?.host);
  return host === "localhost" || host === "127.0.0.1"
      || host === "::1"       || host === "0:0:0:0:0:0:0:1"
      // 127.0.0.0/8 entero: 127.0.0.1 es el habitual, pero cualquier 127.x.x.x
      // es loopback y un certificado autofirmado le pega igual.
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** ¿Corresponde mandar `Strict-Transport-Security` en esta respuesta? */
export function mandarHsts(req) {
  const sobreTls = !!(req?.secure || req?.headers?.["x-forwarded-proto"] === "https");
  return sobreTls && !esHostLocal(req);
}


// ══ ORIGEN PERMITIDO EN LOS WEBSOCKETS (21-sep-2026) ═════════════
//
// El upgrade no validaba `Origin`, así que cualquier página de cualquier
// dominio podía abrir un WebSocket contra MIIA desde el navegador de un
// visitante y leer el bus con SU sesión. La política del mismo origen no se
// aplica a WebSocket: acá hay que chequearlo a mano.
//
// Un cliente que NO es un navegador (curl, un script) no manda `Origin`, y eso
// se deja pasar: bloquearlo rompería los testers y no agregaría seguridad — un
// script puede poner el Origin que quiera. Lo que esto corta es el ataque
// cruzado desde el navegador de un tercero, que es distinto y sí se puede.
export const ORIGENES_WS = (process.env.MIIA_ORIGENES_WS ||
  "https://miiaia.com,https://www.miiaia.com,https://localhost:8443,http://localhost:8443"
).split(",").map(o => o.trim().toLowerCase()).filter(Boolean);

export function origenPermitido(req) {
  const o = String(req.headers.origin || "").trim().toLowerCase();
  if (!o) return true;                       // no es un navegador
  if (ORIGENES_WS.includes(o)) return true;
  try {
    const h = new URL(o).hostname;           // el origen directo, para depurar
    if (h === "localhost" || h === "127.0.0.1") return true;
    if (h === String(req.socket?.localAddress || "").replace(/^::ffff:/, "")) return true;
  } catch (_) {}
  return false;
}



// ══ SESIÓN OBLIGATORIA (20-nov-2026) ══════════════════════════════
//
// Decisión de Martín: para ver o usar cualquier cosa de MIIA hay que entrar
// con Google. Las páginas informativas (que-es-miia, metodología, glosario,
// ayuda, legal) siguen públicas —Google exige una portada y una política de
// privacidad públicas para verificar el login, y AdSense y los buscadores sólo
// ven eso—; los datos, el chat y el bus en vivo, no.
//
// La puerta está en class30, que es la única entrada pública: si el control
// viviera sólo en la página, cualquiera le pegaría a la API directo.

// Rutas de /api que quedan abiertas, y por qué cada una:
export const API_PUBLICAS = new Set([
  "/backtesting/professional",   // la portada pública (que-es-miia) muestra la evidencia
  "/mercadopago/webhook",        // lo llama Mercado Pago, sin sesión; se valida por firma HMAC
  "/subscribe/webhook",          // ídem, camino del Python
  "/subscription/failure",       // Mercado Pago redirige el navegador acá, sin el header
  "/health-python",              // monitoreo
  "/system-health",              // monitoreo
]);

/** ¿Esta ruta de /api (sin el prefijo `/api`) exige sesión? */
export function apiRequiereSesion(ruta) {
  const r = String(ruta || "").split("?")[0].replace(/\/+$/, "") || "/";
  return !API_PUBLICAS.has(r);
}

/**
 * El token de un pedido: el header `Authorization: Bearer …` o, si no hay,
 * `?token=` en la URL. El segundo existe porque un navegador NO puede ponerle
 * headers a un WebSocket ni a las peticiones de Socket.IO: la única forma de
 * mandar la sesión en el upgrade es la URL.
 */
export function tokenDelPedido(req) {
  const h = String(req?.headers?.authorization || "");
  if (/^bearer\s+/i.test(h)) {
    const t = h.replace(/^bearer\s+/i, "").trim();
    if (t) return t;
  }
  try {
    const u = new URL(String(req?.url || "/"), "http://x");
    const t = u.searchParams.get("token");
    if (t) return t;
  } catch (_) {}
  return null;
}
