// ============================================================================
// integracion_vectores.js — class18 propagando el símbolo, con el .NET REAL
// ----------------------------------------------------------------------------
// Segunda mitad de la cadena. `integracion_noticias.js` prueba
// class1 → class11 → class18_ingest; ésta prueba el eslabón siguiente:
//
//     class18_ingest → [motor .NET real] → class19_ingest
//
// Es el único lugar donde se puede ver si el `symbol` que agregó class11
// sobrevive al motor vectorial, porque class18 vive dentro del assembly y no
// se puede importar como un módulo.
//
// ⚠️ La prueba clave NO es que el símbolo pase: es que un mensaje SIN símbolo
// siga saliendo sin él. class19 elige la métrica de cambio con `symbol !== null`
// y mandar la cadena "GENERAL" habría cambiado el filtro de tres de las cuatro
// fuentes de class18.
//
// REQUIERE Redis en localhost:6379 y el .NET compilado en Release.
//
//   node docs/simulaciones/integracion_vectores.js
// ============================================================================

import { createClient } from "redis";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "../..");
const DLL  = path.join(RAIZ, "MIIA_MotoresVectoriales/bin/Release/net9.0/MIIA_MotoresVectoriales.dll");

let ok = 0, fallas = 0;
const check = (c, msg, extra = "") => {
  if (c) { ok++; console.log(`   [ok] ${msg}${extra ? "   " + extra : ""}`); }
  else { fallas++; console.log(`   [FALLA] ${msg}${extra ? "   " + extra : ""}`); }
};
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

let motor = null;
const matar = () => { if (motor && !motor.killed) { try { motor.kill("SIGKILL"); } catch (_) {} } };
process.on("exit", matar);
process.on("SIGINT", () => { matar(); process.exit(1); });

// El envelope de impacto tal como lo arma class11 (_runAnalysis).
const impacto = (symbol) => {
  const data = { origen: "class11", symbol, score: 0.62, probabilidad: 0.62,
                 confianza: 0.7, relevanciaReal: 0.5, fuente_real: true,
                 n_noticias: 3, cuota: 0.5, sentimiento_medio: 1 };
  const env = { id: `int-${symbol || "agg"}-${Date.now()}`, source: "class11",
                type: "impact_analysis", text: `impacto ${symbol || "agregado"}`,
                data, ts: new Date().toISOString(),
                probabilidad: 0.62, confianza: 0.7, score: 0.62 };
  if (symbol) { env.symbol = symbol; env.ticker = symbol; }
  return JSON.stringify(env);
};

(async () => {
  console.log("\n============================================================");
  console.log("  INTEGRACIÓN · class18_ingest → [.NET real] → class19_ingest");
  console.log("============================================================\n");

  console.log("1 · Prerrequisitos");
  check(fs.existsSync(DLL), "el .NET está compilado en Release",
        fs.existsSync(DLL) ? "" : "falta: dotnet build -c Release");
  if (!fs.existsSync(DLL)) { console.log("\nSin DLL no se puede seguir.\n"); process.exit(1); }

  const pub = createClient({ url: "redis://localhost:6379" });
  const sub = createClient({ url: "redis://localhost:6379" });
  await pub.connect(); await sub.connect();
  check(true, "Redis conectado");

  const recibido = [];
  await sub.subscribe("class19_ingest", (raw) => {
    try { recibido.push(JSON.parse(raw)); } catch (_) {}
  });

  // ── el motor .NET de verdad ────────────────────────────────────────────
  console.log("\n2 · El motor vectorial");
  motor = spawn("dotnet", [DLL], { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"],
                                   env: { ...process.env } });
  let salida = "";
  motor.stdout.on("data", d => { salida += d.toString(); });
  motor.stderr.on("data", d => { salida += d.toString(); });

  await dormir(9000);
  check(motor.exitCode === null, "el motor sigue vivo",
        motor.exitCode === null ? "" : `exitCode=${motor.exitCode}`);
  check(/class18/.test(salida), "class18 arrancó dentro del assembly");
  // El entrypoint global arranca class10 y class18; class40/41 sólo con su switch.
  check(!/class40.*ACTIVO/.test(salida), "class40 NO arrancó (switch apagado, como debe)");

  // ── con símbolo ────────────────────────────────────────────────────────
  console.log("\n3 · Un impacto CON instrumento");
  recibido.length = 0;
  await pub.publish("class18_ingest", impacto("XLK"));
  await dormir(3000);
  const conSym = recibido.filter(m => m.fuente === "impacto");
  check(conSym.length > 0, "class18 publicó a class19_ingest", `n=${conSym.length}`);
  if (conSym.length) {
    const m = conSym[conSym.length - 1];
    check(m.symbol === "XLK", "y el `symbol` SOBREVIVIÓ al motor", `symbol=${m.symbol}`);
    check(Array.isArray(m.vector) && m.vector.length > 0,
          "con su vector numérico", `dims=${m.vector?.length}`);
  }

  // ── sin símbolo: LA prueba que importa ────────────────────────────────
  console.log("\n4 · Un impacto SIN instrumento (la regresión que se evitó)");
  recibido.length = 0;
  await pub.publish("class18_ingest", impacto(null));
  await dormir(3000);
  const sinSym = recibido.filter(m => m.fuente === "impacto");
  check(sinSym.length > 0, "class18 lo publicó igual", `n=${sinSym.length}`);
  if (sinSym.length) {
    const m = sinSym[sinSym.length - 1];
    // Tiene que ser null/ausente, NUNCA la cadena "GENERAL".
    check(m.symbol === null || m.symbol === undefined,
          "`symbol` viaja como null, no como la cadena 'GENERAL'",
          `symbol=${JSON.stringify(m.symbol)}`);
    // Y así lo resuelve class19 (class19.js:238).
    const comoClass19 = String(
      m.symbol ?? m.ticker ?? m.data?.symbol ?? m.data?.ticker ?? ""
    ).toUpperCase() || null;
    check(comoClass19 === null,
          "class19 lo resolvería a null → sigue comparando por COSENO",
          `→ ${comoClass19}`);
  }

  await sub.quit(); await pub.quit();
  matar();

  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — integración class18 → class19  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => { console.error("ERROR:", e); matar(); process.exit(1); });
