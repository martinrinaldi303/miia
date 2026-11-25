// ============================================================
// sim18_linux.js — ¿esto corre igual en el Ubuntu del server?
// ============================================================
//
// POR QUÉ EXISTE. Todo lo del corte se escribió y se probó en Windows, y el
// 12-oct se despliega en Ubuntu 24.04. Las diferencias que importan no son
// teóricas: este proyecto ya se comió tres de ellas.
//
//   · `.gitattributes` fuerza LF en `*.sh` porque un `.sh` con CRLF falla en
//     Linux con `\r: command not found`.
//   · El log C++ es `class25A.log` con A MAYÚSCULA, y en Windows `class25a.log`
//     abre el mismo archivo; en Linux no existe y el grep falla EN SILENCIO.
//   · `startMotorVectorial()` busca `bin/Release`, y `deploy_server.sh` compila
//     `-c Debug`: en Linux eso lo manda al fallback `dotnet run`, que es un
//     wrapper cuyo PID no es la app — el huérfano de dotnet del 1-ago.
//
// Esta prueba corre en Windows y contesta sobre Linux: es un chequeo estático
// más unas pruebas de comportamiento que sí se pueden hacer de este lado.
//
//   node docs/simulaciones/sim18_linux.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

let ok = 0, fail = 0, avisos = 0;
function chk(cond, titulo, nota = "") {
  if (cond) { ok++;   console.log(`   [ok] ${titulo.padEnd(56)} ${nota}`); }
  else      { fail++; console.log(`   [FALLA] ${titulo.padEnd(53)} ${nota}`); }
}
function aviso(titulo, nota = "") { avisos++; console.log(`   [AVISO] ${titulo.padEnd(53)} ${nota}`); }

/** Todos los archivos del repo con una extensión, sin node_modules ni build. */
function archivos(exts, dirs = ["scripts", "operador", "MIIA", "docs", "miia_cognitive"]) {
  const out = [];
  const excl = /node_modules|[\\/](build|build-mingw|build-win|bin|obj|venv|venv_miiaproject|\.git)[\\/]/;
  const rec = (d) => {
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of e) {
      const p = path.join(d, it.name);
      if (excl.test(p + path.sep)) continue;
      if (it.isDirectory()) rec(p);
      else if (exts.some(x => it.name.endsWith(x))) out.push(p);
    }
  };
  for (const d of dirs) rec(path.join(RAIZ, d));
  return out;
}

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  sim18 · ¿corre igual en el Ubuntu del server?");
console.log("══════════════════════════════════════════════════════════════");
console.log(`      corriendo en: ${process.platform} · node ${process.version}`);

// ── 1 · Fin de línea de los .sh ───────────────────────────────────────────
// Un `.sh` con CRLF falla en Linux con `\r: command not found`. Es el modo de
// fallar más tonto y más caro: el script arranca y muere en la primera línea.
console.log("\n1 · Fin de línea de los scripts de shell");
{
  const shs = archivos([".sh"], ["scripts", "docs"]);
  const conCRLF = shs.filter(f => fs.readFileSync(f).includes(Buffer.from("\r\n")));
  chk(conCRLF.length === 0,
      `los ${shs.length} .sh están en LF`,
      conCRLF.length ? "CON CRLF: " + conCRLF.map(f => path.relative(RAIZ, f)).join(", ")
                     : "ninguno con CRLF");

  // .gitattributes tiene que seguir forzándolo, o el próximo commit desde
  // Windows los vuelve a romper.
  const ga = fs.readFileSync(path.join(RAIZ, ".gitattributes"), "utf8");
  chk(/\*\.sh\s+text\s+eol=lf/.test(ga),
      ".gitattributes fuerza eol=lf en *.sh",
      "sin esto, el próximo commit desde Windows los rompe");
}

// ── 2 · Mayúsculas y minúsculas en las rutas ──────────────────────────────
// Linux distingue. Un `import "./Universo.js"` que en Windows funciona, allá
// tira MODULE_NOT_FOUND al arrancar el módulo.
console.log("\n2 · Mayúsculas en los imports (Linux distingue)");
{
  const js = archivos([".js"], ["scripts", "operador", "docs"]);
  const malas = [];
  for (const f of js) {
    // Se quitan los comentarios ANTES de buscar: la propia cabecera de esta
    // prueba trae un `import "./Universo.js"` como EJEMPLO, y la regex lo
    // matcheaba. Es el mismo error que ya cometi en sim16: buscar una cadena
    // en el fuente sin descartar el texto que la explica.
    const src = fs.readFileSync(f, "utf8")
      .split(/\r?\n/).filter(l => !l.trimStart().startsWith("//")).join("\n");
    const re = /(?:from|import)\s+["'](\.[^"']+\.js)["']/g;
    let m;
    while ((m = re.exec(src))) {
      const destino = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(destino)) { malas.push(`${path.relative(RAIZ, f)} → ${m[1]} (no existe)`); continue; }
      // En Windows existsSync ignora la caja: hay que comparar contra el nombre real.
      const real = fs.readdirSync(path.dirname(destino)).find(n => n.toLowerCase() === path.basename(destino).toLowerCase());
      if (real && real !== path.basename(destino))
        malas.push(`${path.relative(RAIZ, f)} → ${m[1]} pero el archivo es ${real}`);
    }
  }
  chk(malas.length === 0, `los imports de ${js.length} archivos JS coinciden en caja`,
      malas.length ? malas.slice(0, 3).join(" | ") : "");

  // El caso concreto que ya costó tiempo: el log de class25A.
  const cpp = fs.readFileSync(path.join(RAIZ, "miia_cognitive", "class25A.cpp"), "utf8");
  chk(/"class25A\.log"/.test(cpp),
      "class25A escribe class25A.log con A mayúscula",
      "en Linux `class25a.log` no existe y el grep falla en silencio");
}

// ── 3 · Separadores de ruta escritos a mano ───────────────────────────────
console.log("\n3 · Rutas con backslash escritas a mano");
{
  const fuentes = archivos([".js", ".py"], ["scripts", "operador", "MIIA"]);
  const sospechosas = [];
  for (const f of fuentes) {
    const src = fs.readFileSync(f, "utf8");
    src.split("\n").forEach((l, i) => {
      if (l.trimStart().startsWith("//") || l.trimStart().startsWith("#")) return;
      // Una ruta relativa con backslash entre dos nombres: "operador\aprendizaje"
      if (/["'][^"']*[A-Za-z0-9_)\]]\\[A-Za-z0-9_]/.test(l) && !/\\\\/.test(l) && !/\\n|\\r|\\t|\\d|\\s|\\w|\\.|\\\/|\\\[|\\\(/.test(l))
        sospechosas.push(`${path.relative(RAIZ, f)}:${i + 1}`);
    });
  }
  chk(sospechosas.length === 0,
      "ninguna ruta relativa con backslash en JS/Python de producción",
      sospechosas.length ? sospechosas.slice(0, 4).join(" ") : `${fuentes.length} archivos`);
}

// ── 4 · El build .NET que el orquestador espera ───────────────────────────
console.log("\n4 · El motor .NET: Release contra Debug");
{
  const idx = fs.readFileSync(path.join(RAIZ, "operador", "index.js"), "utf8");
  chk(/bin",\s*"Release",\s*"net9\.0"/.test(idx) || /bin[\\/]Release/.test(idx),
      "startMotorVectorial busca bin/Release/net9.0",
      "si falta, cae a `dotnet run` en Debug: wrapper con PID equivocado");

  // deploy_server.sh (16-nov) y deploy_linux.sh (18-nov) se borraron: sin script
  // de instalación esto queda como aviso. Recuperables con git show.
  const nomDs = ["deploy_server.sh", "deploy_linux.sh"]
    .find(n => fs.existsSync(path.join(RAIZ, "scripts", n)));
  const ds = nomDs ? fs.readFileSync(path.join(RAIZ, "scripts", nomDs), "utf8") : "";
  const compilaDebug = /dotnet build -c Debug/.test(ds);
  if (!nomDs)
    aviso("no hay script de instalación del server", "no se pudo revisar el build .NET");
  else if (compilaDebug)
    aviso(`${nomDs} compila -c Debug, no Release`,
          "el orquestador va a caer al fallback `dotnet run`");
  else
    chk(true, `${nomDs} compila Release`, "");

  // El entrypoint: el StartupObject sin namespace resuelve al del namespace
  // GLOBAL, que es el de class10.cs. Si alguien le pone namespace a ese
  // archivo, pasa a resolver al tester de una pasada y MOTORVECTORIAL sale con
  // codigo 0 — y esta en CRITICAL_LABELS, asi que el orquestador lo respawnea
  // cada 8 s con class10 y class18 muertos.
  const csproj = fs.readFileSync(
    path.join(RAIZ, "MIIA_MotoresVectoriales", "MIIA_MotoresVectoriales.csproj"), "utf8");
  chk(/<StartupObject>MotorVectorialTester<\/StartupObject>/.test(csproj),
      "el csproj fija StartupObject = MotorVectorialTester", "");
  const c10 = fs.readFileSync(path.join(RAIZ, "scripts", "class10.cs"), "utf8");
  chk(/^public static class MotorVectorialTester/m.test(c10) && !/^namespace /m.test(c10),
      "class10.cs declara ese tipo en el namespace GLOBAL",
      "es el entrypoint real; si se le pone namespace, gana el tester de una pasada");
}

// ── 5 · Binarios con y sin .exe ───────────────────────────────────────────
console.log("\n5 · Los binarios C++ sin extensión en Linux");
{
  const idx = fs.readFileSync(path.join(RAIZ, "operador", "index.js"), "utf8");
  chk(/const IS_WIN\s*=\s*process\.platform === "win32"/.test(idx) &&
      /const EXE\s*=\s*IS_WIN \? "\.exe" : ""/.test(idx),
      "el orquestador deriva el sufijo .exe de la plataforma", "");
  chk(/function ensureExec/.test(idx) && /chmodSync\(p, 0o755\)/.test(idx),
      "y le pone +x a cada binario antes de lanzarlo",
      "un scp/tar puede quitar el bit y spawn falla con EACCES");
  // El build de Linux tiene que existir y copiar a scripts/.
  chk(fs.existsSync(path.join(RAIZ, "scripts", "build_cpp_linux.sh")),
      "existe scripts/build_cpp_linux.sh", "los .exe de Windows NO corren en Linux");
}

// ── 6 · Lo que agregó este corte, mirado con ojos de Linux ────────────────
console.log("\n6 · Los archivos nuevos del corte");
{
  const nuevos = [
    "scripts/universo.js", "scripts/seguridad_red.js", "MIIA/universo.py",
    "MIIA/rank_ic.py", "operador/aprendizaje/config/universo.json",
    "operador/aprendizaje/config/canales_socket.json",
  ];
  const faltan = nuevos.filter(f => !fs.existsSync(path.join(RAIZ, f)));
  chk(faltan.length === 0, `los ${nuevos.length} archivos nuevos existen`,
      faltan.length ? faltan.join(", ") : "");

  // universo.json se resuelve con path.join desde el módulo, no con una ruta
  // absoluta de Windows: es lo que lo hace portable.
  const u = fs.readFileSync(path.join(RAIZ, "scripts", "universo.js"), "utf8");
  chk(/path\.join\(AQUI, "\.\.", "operador", "aprendizaje", "config", "universo\.json"\)/.test(u),
      "universo.js arma la ruta con path.join", "portable sin cambios");
  const up = fs.readFileSync(path.join(RAIZ, "MIIA", "universo.py"), "utf8");
  chk(/_AQUI\.parent \/ "operador" \/ "aprendizaje" \/ "config" \/ "universo\.json"/.test(up),
      "universo.py usa pathlib, no concatenación", "");

  // Y los dos tienen que caer al respaldo si el JSON falta — que es el caso de
  // un deploy a medias, donde se subió el .js y no el .json.
  chk(/copia de respaldo/.test(u) && /copia de respaldo/.test(up),
      "los dos caen al respaldo si el JSON no está",
      "cubre un deploy a medias: .js subido, .json no");
}

// ── 7 · Números: JS no depende de la locale, Python sí puede ──────────────
console.log("\n7 · Formato de números con LANG=es_AR.UTF-8");
{
  // `toFixed` y `Number()` en JS son independientes de la locale por
  // especificación (sólo `toLocaleString` no lo es). Se verifica que el código
  // nuevo no use toLocaleString para NADA que después se parsee o se guarde.
  const nuevos = ["scripts/universo.js", "scripts/class7.js", "scripts/seguridad_red.js"];
  const conLocale = [];
  for (const f of nuevos) {
    const src = fs.readFileSync(path.join(RAIZ, f), "utf8");
    src.split("\n").forEach((l, i) => {
      if (/toLocaleString|toLocaleDateString|Intl\./.test(l) && !l.trimStart().startsWith("//"))
        conLocale.push(`${f}:${i + 1}`);
    });
  }
  chk(conLocale.length === 0, "el código nuevo no usa toLocaleString",
      conLocale.length ? conLocale.join(" ") : "toFixed y Number son locale-independientes");

  // Prueba de comportamiento: los números que class7 publica tienen que ser los
  // mismos con cualquier LANG. Se verifica el caso que importa — el parseFloat
  // de un precio del proveedor y el toFixed de la salida.
  const antes = (0.123456).toFixed(4);
  chk(antes === "0.1235", "toFixed usa punto decimal siempre", `"${antes}"`);
  chk(Number("55.72") === 55.72 && parseFloat("55.72") === 55.72,
      "Number/parseFloat leen punto decimal siempre", "");
}

// ── 8 · El presupuesto de cuota, con la aritmética del server ─────────────
console.log("\n8 · El barrido de precios en el server (50 instrumentos)");
{
  const { TICKERS, POLLING_SEGUNDOS, LLAMADAS_POR_MINUTO } =
    await import("../../scripts/universo.js");
  const n = TICKERS.length;
  const segBarrido = n / LLAMADAS_POR_MINUTO * 60;
  console.log(`      ${n} instrumentos · cuota ${LLAMADAS_POR_MINUTO}/min · ` +
              `intervalo ${POLLING_SEGUNDOS}s → barrido ~${segBarrido.toFixed(0)}s`);
  chk(segBarrido < POLLING_SEGUNDOS * 0.9,
      "el barrido entra en el intervalo con holgura",
      `${segBarrido.toFixed(0)}s de ${POLLING_SEGUNDOS}s`);
  // En el server el timeout de axios es 5 s por ticker. El peor caso realista
  // —que el proveedor tarde, no que falle— tiene que seguir entrando.
  const peorCaso = n * 5;
  if (peorCaso > POLLING_SEGUNDOS)
    aviso("si el proveedor tarda 5 s por ticker, el ciclo se pasa",
          `${peorCaso}s > ${POLLING_SEGUNDOS}s — lo cubre el guard de reentrada`);
  else
    chk(true, "incluso con 5 s por ticker el ciclo entra", `${peorCaso}s`);
  // El guard de reentrada es lo que hace que ese caso no duplique el consumo.
  const c7 = fs.readFileSync(path.join(RAIZ, "scripts", "class7.js"), "utf8");
  chk(/_cicloEnCurso/.test(c7) && /finally/.test(c7),
      "y el guard de reentrada evita que dos ciclos se solapen",
      "sin él, un proveedor lento duplica el consumo de cuota");
}

// ── 9 · Lo que NO se puede probar desde acá ───────────────────────────────
console.log("\n9 · Lo que esta prueba NO puede contestar");
console.log("      · que los binarios C++ compilen con g++ 13 de Ubuntu 24.04:");
console.log("        los .exe de MinGW no corren allá. Sólo lo prueba");
console.log("        `bash scripts/build_cpp_linux.sh` EN el server (paso 2.5).");
console.log("      · que el proveedor de precios responda desde la IP del server.");
console.log("      · que MySQL 8.0.46 acepte el ALTER de `decision_modo`:");
console.log("        `_migrarColumnas` lo hace al arrancar y sólo se ve allá.");
console.log("      · el rendimiento real con 9 M de filas en `precios`.");

console.log(`\n${fail === 0 ? "PASA" : "FALLA"} — portabilidad a Linux  ` +
            `(${ok} ok, ${fail} fallas, ${avisos} avisos)\n`);
process.exit(fail === 0 ? 0 : 1);
