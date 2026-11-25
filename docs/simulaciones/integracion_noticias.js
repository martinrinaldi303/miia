// ============================================================================
// integracion_noticias.js — prueba de INTEGRACIÓN, no en frío
// ----------------------------------------------------------------------------
// Las simulaciones de esta carpeta importan el módulo y llaman a sus funciones.
// Ésta no: levanta `class11.js` como PROCESO REAL contra un Redis real, le
// inyecta mensajes con la forma exacta de `class1_output` y escucha lo que sale
// por `class18_ingest`.
//
// Prueba lo que ninguna prueba en frío puede: que el módulo arranque, se
// suscriba, sobreviva al debounce y al throttle, y publique de verdad.
//
// REQUIERE Redis en localhost:6379. No toca MySQL ni producción.
//
//   node docs/simulaciones/integracion_noticias.js
// ============================================================================

import { createClient } from "redis";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../..");

let ok = 0, fallas = 0;
const check = (c, msg, extra = "") => {
  if (c) { ok++; console.log(`   [ok] ${msg}${extra ? "   " + extra : ""}`); }
  else { fallas++; console.log(`   [FALLA] ${msg}${extra ? "   " + extra : ""}`); }
};
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

const noticia = (titulo, ticker, sentimiento) => JSON.stringify({
  tipo: "noticia", fuente: "class1", titulo, texto: titulo, snippet: "",
  url: null, ticker, sentimiento, source: "google", ts: new Date().toISOString(),
});

let hijo = null;
const matar = () => { if (hijo && !hijo.killed) { try { hijo.kill("SIGKILL"); } catch (_) {} } };
process.on("exit", matar);
process.on("SIGINT", () => { matar(); process.exit(1); });

(async () => {
  console.log("\n============================================================");
  console.log("  INTEGRACIÓN · class1 → class11 → class18  (procesos reales)");
  console.log("============================================================\n");

  const pub = createClient({ url: "redis://localhost:6379" });
  const sub = createClient({ url: "redis://localhost:6379" });
  await pub.connect(); await sub.connect();
  console.log("1 · Redis");
  check(true, "conectado a localhost:6379");

  // Lo que class11 publique a class18_ingest queda acá.
  const recibido = [];
  await sub.subscribe("class18_ingest", (raw) => {
    try { recibido.push(JSON.parse(raw)); } catch (_) {}
  });
  check(true, "escuchando class18_ingest");

  // ── class11 como proceso real ──────────────────────────────────────────
  console.log("\n2 · class11 como proceso");
  hijo = spawn(process.execPath, [path.join(RAIZ, "scripts/class11.js")],
               { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"],
                 env: { ...process.env, CLASS11_POR_TICKER: "1" } });
  let salida = "";
  hijo.stdout.on("data", d => { salida += d.toString(); });
  hijo.stderr.on("data", d => { salida += d.toString(); });

  await dormir(3500);
  check(hijo.exitCode === null, "el proceso sigue vivo después de arrancar",
        hijo.exitCode === null ? "" : `exitCode=${hijo.exitCode}`);
  check(/Suscrito al canal: class1_output/.test(salida),
        "se suscribió a class1_output");

  // ── inyectar noticias reales ───────────────────────────────────────────
  console.log("\n3 · Inyectando noticias con ticker");
  for (const n of [
    noticia("XLK chip rally record demand", "XLK", "BULLISH"),
    noticia("XLK semiconductor surge again", "XLK", "BULLISH"),
    noticia("XLE oil prices crash decline", "XLE", "BEARISH"),
    noticia("XLF banks report steady quarter", "XLF", "NEUTRAL"),
  ]) { await pub.publish("class1_output", n); await dormir(120); }
  check(true, "4 noticias publicadas a class1_output");

  // debounce 3 s + margen
  console.log("\n4 · Esperando el debounce de class11 (3 s)…");
  await dormir(6000);

  // ── lo que salió ───────────────────────────────────────────────────────
  console.log("\n5 · Lo que class11 publicó");
  check(recibido.length > 0, "publicó algo a class18_ingest", `n=${recibido.length}`);

  const conSymbol = recibido.filter(m => m.symbol);
  const agregado  = recibido.filter(m => !m.symbol);
  check(agregado.length >= 1, "sigue publicando el AGREGADO (compatibilidad)",
        `n=${agregado.length}`);
  check(conSymbol.length >= 2, "y uno POR INSTRUMENTO con `symbol` en la raíz",
        `n=${conSymbol.length}: ${conSymbol.map(m => m.symbol).join(",")}`);

  const syms = new Set(conSymbol.map(m => m.symbol));
  check(syms.has("XLK") && syms.has("XLE"),
        "los tickers que se inyectaron aparecen", [...syms].join(","));

  // La dispersión es lo que hace que el ranking tenga algo que ordenar.
  if (conSymbol.length >= 2) {
    const sc = conSymbol.map(m => m.score);
    const rango = Math.max(...sc) - Math.min(...sc);
    check(rango > 0.01, "los scores DIFIEREN entre instrumentos",
          `rango=${rango.toFixed(4)}`);
  }

  const xlk = conSymbol.find(m => m.symbol === "XLK");
  if (xlk) {
    check(xlk.data?.n_noticias === 2, "XLK cuenta sus 2 titulares",
          `n_noticias=${xlk.data?.n_noticias}`);
    check(xlk.data?.sentimiento_medio === 1, "y su sentimiento sale +1 (2 BULLISH)",
          `sent=${xlk.data?.sentimiento_medio}`);
  } else { check(false, "XLK entre los publicados"); }

  // ── el contrato con class18, sobre el mensaje REAL ─────────────────────
  console.log("\n6 · El contrato con class18 (sobre el mensaje que viajó)");
  if (xlk) {
    // class18 lee VecUtils18.GetStr(root, "symbol") y GetDbl(root, "score").
    check(typeof xlk.symbol === "string", "`symbol` es string en la raíz");
    check(typeof xlk.score === "number", "`score` es número en la raíz",
          `score=${xlk.score?.toFixed(4)}`);
    check(typeof xlk.confianza === "number", "`confianza` es número en la raíz");
  }

  await sub.quit(); await pub.quit();
  matar();

  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — integración class1→class11→class18  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => { console.error("ERROR:", e); matar(); process.exit(1); });
