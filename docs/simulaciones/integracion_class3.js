// ============================================================================
// integracion_class3.js — la cadena de noticias entera, con el .NET REAL
// ----------------------------------------------------------------------------
// Tercera prueba de integración. Las otras dos cubren:
//     integracion_noticias.js   class1 → class11 → class18_ingest
//     integracion_vectores.js   class18_ingest → [.NET] → class19_ingest
// Ésta cubre el camino que Martín pidió:
//
//     class3_ingest → [motor .NET real, CLASS3_ACTIVO=1] → class19_ingest
//
// Es el único lugar donde se puede ver si el INTERRUPTOR funciona, porque class3
// vive dentro del assembly y no se puede importar como módulo. Y prueba las dos
// cosas que ninguna prueba en frío puede:
//
//   · que con CLASS3_ACTIVO=1 el motor se suscriba y publique de verdad;
//   · que SIN la variable no se suscriba a nada — que es como viaja el 12-oct.
//
// REQUIERE Redis en localhost:6379 y el .NET compilado en Release.
//
//   node docs/simulaciones/integracion_class3.js
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

// El envelope tal como lo arma class1 (buildEnvelope, verificado por sim22).
const envelope = (texto, symbol) => {
  const e = {
    id: `int3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: "class1", type: "analysis",
    texto, text: texto,
    data: { query: "consulta de prueba" },
    ts: new Date().toISOString(),
  };
  if (symbol) { e.symbol = symbol; e.ticker = symbol; }
  return JSON.stringify(e);
};

const NOTICIAS = [
  ["XLK Technology Select Sector SPDR rises as chip demand stays strong. Semiconductor makers led the advance after upbeat guidance from several suppliers.", "XLK"],
  ["Energy stocks slide after crude oil futures drop on demand worries. Refiners fell sharply during afternoon trading in New York.", "XLE"],
  ["Financial sector ETF gains as banks report better than expected earnings. Net interest margins widened across regional lenders this quarter.", "XLF"],
];

const arrancarMotor = (env) => {
  const p = spawn("dotnet", [DLL], {
    cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  p._salida = "";
  p.stdout.on("data", d => { p._salida += d.toString(); });
  p.stderr.on("data", d => { p._salida += d.toString(); });
  return p;
};

(async () => {
  console.log("\n============================================================");
  console.log("  INTEGRACIÓN · class3_ingest → [.NET real] → class19_ingest");
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

  // ── 2 · SIN la variable: class3 no tiene que existir ─────────────────────
  //
  // Es como viaja al server el 12-oct. Si se suscribiera igual, subirlo
  // "apagado" no sería gratis y el corte tendría un cambio más sin anunciar.
  console.log("\n2 · Sin CLASS3_ACTIVO no se suscribe a nada");
  motor = arrancarMotor({ CLASS3_ACTIVO: "", CLASS40_ACTIVO: "", CLASS41_ACTIVO: "" });
  await dormir(9000);
  check(motor.exitCode === null, "el motor arranca igual",
        motor.exitCode === null ? "" : `exitCode=${motor.exitCode}`);
  check(!/class3adapt/.test(motor._salida), "class3 NO aparece en el log");
  recibido.length = 0;
  await pub.publish("class3_ingest", envelope(NOTICIAS[0][0], NOTICIAS[0][1]));
  await dormir(2500);
  check(recibido.filter(m => m.fuente === "web").length === 0,
        "y una noticia publicada no produce ningún vector", `n=${recibido.length}`);
  matar();
  await dormir(1500);

  // ── 3 · CON la variable: la cadena entera ───────────────────────────────
  console.log("\n3 · Con CLASS3_ACTIVO=1, la cadena funciona");
  motor = arrancarMotor({ CLASS3_ACTIVO: "1" });
  await dormir(11000);
  check(motor.exitCode === null, "el motor sigue vivo con class3 adentro",
        motor.exitCode === null ? "" : `exitCode=${motor.exitCode}`);
  check(/class3 ACTIVO/.test(motor._salida), "el entrypoint lo anuncia");
  check(/Suscrito → class3_ingest/.test(motor._salida) || /class3_ingest/.test(motor._salida),
        "y class3 se suscribió a class3_ingest");

  recibido.length = 0;
  for (const [texto, symbol] of NOTICIAS) {
    await pub.publish("class3_ingest", envelope(texto, symbol));
    await dormir(400);
  }
  await dormir(4000);

  const vectores = recibido.filter(m => m.fuente === "web");
  check(vectores.length >= 3, "las tres noticias salieron como vector",
        `n=${vectores.length}`);

  if (vectores.length) {
    const dims = new Set(vectores.map(v => v.dimension));
    check(dims.size === 1 && dims.has(64),
          "todos con 64 dims → la red es web|64, una sola",
          `dims=${[...dims].join(",")}`);

    const syms = vectores.map(v => v.symbol).filter(Boolean);
    check(syms.length >= 3, "y con el instrumento puesto", syms.join(","));

    const v0 = vectores[0];
    check(Array.isArray(v0.vector) && v0.vector.length === 64,
          "el vector viaja completo");
    check(v0.vector.every(x => Number.isFinite(x) && x >= 0 && x <= 1),
          "todo en [0,1], sin NaN");
    check(typeof v0.confianza === "number" && v0.confianza >= 0.15,
          "la confianza pasa el mínimo de class19 (0.15)",
          `conf=${v0.confianza?.toFixed(3)}`);
    const activas = v0.vector.filter(x => x > 0.001).length;
    check(activas >= 10, "y las dims activas pasan su mínimo (10)", `activas=${activas}`);

    // LO QUE IMPORTA: que los vectores DIFIERAN. Si las tres noticias dieran
    // el mismo vector, la red recibiría un término común a los 50 instrumentos
    // y no movería un puesto del ranking.
    if (vectores.length >= 2) {
      const cos = (a, b) => {
        let p = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return p / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      };
      const c = cos(vectores[0].vector, vectores[1].vector);
      check(c < 0.9, "dos noticias distintas dan vectores distintos",
            `coseno=${c.toFixed(3)}`);
    }
  }

  // ── 4 · un mensaje SIN instrumento sigue viajando sin él ────────────────
  //
  // class2 y class5 también publican en class3_ingest (fragmentos de PDF) y no
  // traen ticker. class19 elige la métrica de cambio con `symbol !== null`, así
  // que mandar "GENERAL" le cambiaría el filtro. Es la regresión de class18.
  console.log("\n4 · Un fragmento sin instrumento (class2 / class5)");
  recibido.length = 0;
  await pub.publish("class3_ingest", envelope(
    "La crisis de 2008 comenzo con el colapso del mercado hipotecario subprime en Estados Unidos y se extendio al sistema bancario global durante los meses siguientes.",
    null));
  await dormir(3000);
  const sinSym = recibido.filter(m => m.fuente === "web");
  check(sinSym.length >= 1, "el fragmento también se vectoriza", `n=${sinSym.length}`);
  if (sinSym.length) {
    const m = sinSym[sinSym.length - 1];
    check(m.symbol === undefined || m.symbol === null,
          "`symbol` NO viaja (ni como \"GENERAL\")", `symbol=${JSON.stringify(m.symbol)}`);
    const comoClass19 = String(
      m.symbol ?? m.ticker ?? m.data?.symbol ?? m.data?.ticker ?? ""
    ).toUpperCase() || null;
    check(comoClass19 === null, "class19 lo resolvería a null → compara por coseno",
          `→ ${comoClass19}`);
  }

  await sub.quit(); await pub.quit();
  matar();

  console.log("\n------------------------------------------------------------");
  console.log(fallas === 0
    ? `PASA — integración class3 → class19  (${ok} ok, 0 fallas)`
    : `FALLA — ${fallas} de ${ok + fallas}`);
  console.log("------------------------------------------------------------\n");
  process.exit(fallas === 0 ? 0 : 1);
})().catch(e => { console.error("ERROR:", e); matar(); process.exit(1); });
