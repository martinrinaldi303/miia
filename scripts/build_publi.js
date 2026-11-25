#!/usr/bin/env node
// ============================================================================
// build_publi.js — empaqueta TODO lo que se sirve en publi/ para que el fuente
//                  servido no sea legible.
// ----------------------------------------------------------------------------
// QUÉ HACE Y QUÉ NO HACE (leer esto antes de creerle nada al script):
//
//   SÍ  — "Ver código fuente" (Ctrl+U), `curl https://miiaia.com/...`,
//         "Guardar página como" y los scrapers tontos devuelven un blob base64.
//   NO  — el panel Elements de DevTools sigue mostrando el DOM ya montado.
//         Eso NO se puede evitar: el navegador tiene que construir el DOM para
//         pintar. Cualquiera con F12 copia el markup igual.
//
//   Sube el costo de copiarte de "Ctrl+U, Ctrl+C" a "abrir DevTools y copiar el
//   DOM". Sube el piso, no pone un techo. No venderlo como protección.
//
// LA OTRA MITAD DEL TRABAJO, QUE NO ES ESTE SCRIPT
//   publi/ se sirve ENTERA con express.static. Ofuscar index.html mientras
//   index.html.bak sigue al lado no sirve de nada. Todo lo que no sea una página
//   o un asset vive fuera de publi/ — ver publi_src/ (fuentes) y publi_bak/.
//
// CÓMO FUNCIONA
//   HTML: el <head> queda en claro SÓLO con lo que necesitan Google y AdSense
//   (title, description, canonical, og:*, el loader de adsbygoogle). No hay nada
//   propio en un <meta>. Todo lo demás —estilos, scripts inline, el <body>
//   entero— se cifra con XOR sobre clave aleatoria por build, se pasa a base64,
//   se parte en trozos y se guardan desordenados. Un bootstrap sincrónico los
//   reordena, desXORea y hace document.write.
//
//   document.write DURANTE EL PARSEO es a propósito: es la única forma de que
//   los <script> del payload (el CDN de Tailwind, su config, los inline) se
//   ejecuten en el mismo orden que en el original. Reconstruir con innerHTML no
//   ejecuta scripts y rompe la página entera.
//
//   JS suelto: mismo empaquetado, ejecutado con eval INDIRECTO — (0,eval)(...).
//   El indirecto corre en scope global, así `var`, `function` y `window.X` se
//   comportan igual que en un <script src> normal. Un eval directo los
//   encerraría en el scope del bootstrap y rompería a quien los use.
//
// USO
//   node scripts/build_publi.js            # publi_src/* -> publi/*
//   node scripts/build_publi.js --check    # no escribe, sólo informa
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const AQUI  = path.dirname(fileURLToPath(import.meta.url));
const SRC   = path.join(AQUI, "publi_src");
const OUT   = path.join(AQUI, "publi");
const CHECK = process.argv.includes("--check");

// Nodos del <head> que quedan EN CLARO. Todo lo que no matchee acá se cifra.
// Criterio: si un crawler lo necesita para entender o monetizar la página, no se
// cifra. Nada de esto es código propio.
const EN_CLARO = [
  /^<meta\b/i,
  /^<title\b/i,
  /^<base\b/i,
  /^<link\b[^>]*rel=["']?(canonical|icon|shortcut|apple-touch-icon|manifest)/i,
  // Recursos EXTERNOS: quedan en claro por obligación, no por comodidad.
  // Chrome interviene y BLOQUEA un <script src> de otro origen que sea
  // parser-blocking y llegue por document.write cuando la conexión es lenta
  // (chromestatus 5718547946799104). Si eso le pasa al CDN de Tailwind, la
  // página carga sin un solo estilo. Fuera del payload el riesgo desaparece —
  // y de paso el navegador arranca esas descargas antes de descifrar nada.
  // Son URLs de terceros: no hay nada propio que esconder ahí.
  /^<script\b[^>]*\bsrc=["']?https?:\/\//i,
  /^<link\b[^>]*rel=["']?(stylesheet|preconnect|dns-prefetch|preload)/i,
  // Escotilla explícita: <script data-claro> no se cifra.
  // La necesita el guardián de primera visita de index.html, que hace
  // location.replace(). Llamado desde un script que llegó por document.write la
  // navegación NO prospera —probado: el original redirige, el empaquetado se
  // queda— y aunque prosperara, redirigir DESPUÉS de descifrar 430 KB anula el
  // motivo de existir del guardián, que es cortar antes de bajar nada.
  /^<script\b[^>]*\bdata-claro\b/i,
];

// Un nodo de markup por match: comentario, script, style, title o etiqueta suelta.
const NODO = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<title\b[\s\S]*?<\/title\s*>|<[a-zA-Z!\/][^>]*>/g;

function partirHead(interior) {
  const claro = [], cifrado = [];
  let fin = 0, m;
  NODO.lastIndex = 0;
  while ((m = NODO.exec(interior)) !== null) {
    const suelto = interior.slice(fin, m.index);
    if (suelto.trim()) cifrado.push(suelto);
    (EN_CLARO.some((r) => r.test(m[0])) ? claro : cifrado).push(m[0]);
    fin = m.index + m[0].length;
  }
  const cola = interior.slice(fin);
  if (cola.trim()) cifrado.push(cola);
  return { claro, cifrado };
}

// XOR + base64 + trozos desordenados.
function empaquetar(texto) {
  const clave = crypto.randomBytes(24);
  const bytes = Buffer.from(texto, "utf8");
  const xor = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) xor[i] = bytes[i] ^ clave[i % clave.length];
  const b64 = xor.toString("base64");

  const TROZO = 1200;
  const trozos = [];
  for (let i = 0; i < b64.length; i += TROZO) trozos.push(b64.slice(i, i + TROZO));

  // orden[i] = posición dentro de `mezclados` del trozo i-ésimo del base64.
  const pos = trozos.map((_, i) => i);
  for (let i = pos.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pos[i], pos[j]] = [pos[j], pos[i]];
  }
  const mezclados = new Array(trozos.length);
  trozos.forEach((t, i) => { mezclados[pos[i]] = t; });

  return { trozos: mezclados, orden: pos, clave: Array.from(clave) };
}

// Deja el texto descifrado en `_t`. Nombres sin significado a propósito.
function descifrador({ trozos, orden, clave }) {
  return `var _a=${JSON.stringify(trozos)},_o=${JSON.stringify(orden)},` +
         `_k=${JSON.stringify(clave)},_s="",_i=0;` +
         `for(;_i<_o.length;_i++)_s+=_a[_o[_i]];` +
         `var _b=atob(_s),_n=_b.length,_u=new Uint8Array(_n);` +
         `for(_i=0;_i<_n;_i++)_u[_i]=_b.charCodeAt(_i)^_k[_i%_k.length];` +
         `var _t=new TextDecoder("utf-8").decode(_u);_a=_o=_k=_s=_b=_u=null;`;
}

const bootstrapHTML = (p) => `<script>(function(){${descifrador(p)}document.write(_t);})();</script>`;
const bootstrapJS   = (p) => `(function(){${descifrador(p)}(0,eval)(_t);})();`;

// Con JS apagado el <body> queda vacío. <style> es contenido legal dentro de un
// <noscript> en el <head>; el ::before evita tener que escribir markup ahí.
const SIN_JS =
  `<noscript><style>html,body{background:#0A0A0A;margin:0}` +
  `body::before{content:"Esta página necesita JavaScript activado.";` +
  `display:block;padding:32px;font:15px system-ui,sans-serif;color:#E2E8F0}</style></noscript>`;

function construirHTML(fuente) {
  const mHtml  = fuente.match(/<html[^>]*>/i);
  const mHeadA = fuente.match(/<head[^>]*>/i);
  const iHeadZ = fuente.search(/<\/head\s*>/i);

  // panel_flujo.html no tiene <html>, <head> ni <body>: es un fragmento y el
  // navegador le arma la estructura solo. Se cifra entero y se le pone una
  // cáscara mínima; el tokenizador igual rescata su <meta charset> y su <title>.
  const suelto   = !mHtml || !mHeadA || iHeadZ === -1;
  const abreHtml = suelto ? "<html lang=\"es\">" : mHtml[0];

  const iHeadA   = suelto ? 0 : fuente.indexOf(mHeadA[0]) + mHeadA[0].length;
  const interior = suelto ? fuente : fuente.slice(iHeadA, iHeadZ);
  const resto    = suelto ? "" : fuente.slice(iHeadZ); // desde </head> hasta el final

  const { claro, cifrado } = partirHead(interior);
  const payload = cifrado.join("\n") + "\n" + resto;

  // El archivo termina en el bootstrap: el payload trae el </head>, el <body> y
  // el </html>. Nada de markup estático después, o se duplicaría al parsear.
  return "<!DOCTYPE html>\n" + abreHtml + "\n<head>\n" +
         claro.join("\n") + "\n" + SIN_JS + "\n" +
         bootstrapHTML(empaquetar(payload)) + "\n";
}

const construirJS = (fuente) => bootstrapJS(empaquetar(fuente)) + "\n";

// ---------------------------------------------------------------------------

if (!fs.existsSync(SRC)) {
  console.error(`falta ${SRC} — ahí van los fuentes en claro, fuera de publi/ (que se sirve entera)`);
  process.exit(1);
}

const archivos = fs.readdirSync(SRC).filter((f) => /\.(html|js)$/i.test(f)).sort();
let escritos = 0;

for (const arch of archivos) {
  const fuente = fs.readFileSync(path.join(SRC, arch), "utf8");
  const esHTML = /\.html$/i.test(arch);
  const salida = esHTML ? construirHTML(fuente) : construirJS(fuente);

  const antes = fuente.length, despues = salida.length;
  const pct = (((despues - antes) / antes) * 100).toFixed(0);
  const metas = esHTML ? (salida.match(new RegExp("<meta[ />]", "gi")) || []).length : 0;

  console.log(
    `${CHECK ? "[check] " : ""}${arch.padEnd(20)} ` +
    `${String(antes).padStart(7)} B -> ${String(despues).padStart(7)} B (+${pct}%)  ` +
    (esHTML ? `${metas} meta en claro` : "js envuelto")
  );

  if (!CHECK) { fs.writeFileSync(path.join(OUT, arch), salida, "utf8"); escritos++; }
}

console.log(CHECK ? `\n${archivos.length} archivos verificados (no se escribió nada).`
                  : `\n${escritos} archivos escritos en ${OUT}.`);
