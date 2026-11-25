// sim24 — la fuga de memoria de class30: la cola hacia el Python no tenía tope.
//
// Corre la función real (scripts/cola_acotada.js) con el caudal medido en
// producción y verifica que class30.js la use en los dos lugares donde la cola
// crece. No importa class30: arrastra class14/class42, que se conectan a MySQL.
//
//   node docs/simulaciones/sim24_cola_class30.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encolarAcotado, topeDesdeEntorno, esDecisionInterna } from "../../scripts/cola_acotada.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
let fallos = 0, n = 0;
function check(nombre, ok, detalle = "") {
  n++;
  if (!ok) fallos++;
  console.log(`${ok ? "  ok  " : " FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}

// Un día de rueda: 16.000 decisiones entran, 960 salen (una cada 90 s).
function simularDia(max, entran = 16000, salen = 960) {
  const cola = [];
  let descartados = 0, enviados = [], pico = 0;
  const cada = Math.floor(entran / salen);
  for (let i = 0; i < entran; i++) {
    descartados += encolarAcotado(cola, { id: i }, max);
    if (cola.length > pico) pico = cola.length;
    if (i % cada === cada - 1 && cola.length) enviados.push({ item: cola.shift(), ahora: i });
  }
  return { cola, descartados, enviados, pico };
}

console.log("\n1 · El defecto: sin tope, la cola crece sin límite");
const sinTope = simularDia(Infinity);
check("sin tope quedan ~15.000 objetos retenidos por día", sinTope.cola.length > 14000,
      `${sinTope.cola.length} en cola`);
const atrasoViejo = sinTope.enviados.at(-1).ahora - sinTope.enviados.at(-1).item.id;
check("y lo que sale tiene casi un día de atraso", atrasoViejo > 14000, `atraso ${atrasoViejo} decisiones`);

console.log("\n2 · Con el tope");
const MAX = 200;
const r = simularDia(MAX);
check("la cola nunca pasa del tope", r.pico <= MAX, `pico ${r.pico}`);
check("al final del día sigue acotada", r.cola.length <= MAX, `${r.cola.length}`);
check("se sigue despachando al mismo ritmo (960 por día)", r.enviados.length >= 950, `${r.enviados.length}`);
check("lo descartado + lo enviado + lo que queda = lo que entró",
      r.descartados + r.enviados.length + r.cola.length === 16000);
const atraso = r.enviados.at(-1).ahora - r.enviados.at(-1).item.id;
check("lo que sale es reciente (atraso ≤ tope)", atraso <= MAX, `atraso ${atraso} decisiones`);
check("se descarta lo MÁS VIEJO, no lo nuevo", r.cola.at(-1).id === 15999);
check("conserva el orden FIFO", r.cola.every((x, i) => i === 0 || x.id > r.cola[i - 1].id));

console.log("\n3 · Treinta días seguidos (la corrida entera)");
const cola30 = [];
for (let i = 0; i < 16000 * 30; i++) encolarAcotado(cola30, i, MAX);
check("30 días de caudal dejan la cola en el tope, no en 450.000", cola30.length === MAX);

console.log("\n4 · Bordes");
const c = [];
check("debajo del tope no descarta nada", encolarAcotado(c, 1, 3) === 0 && c.length === 1);
encolarAcotado(c, 2, 3); encolarAcotado(c, 3, 3);
check("al pasar el tope descarta uno", encolarAcotado(c, 4, 3) === 1 && c.join() === "2,3,4");
check("tope 1 deja sólo el último", (() => { const x = [1, 2, 3]; encolarAcotado(x, 4, 1); return x.join() === "4"; })());
check("entorno vacío → 200", topeDesdeEntorno(undefined) === 200);
check("entorno basura → 200", topeDesdeEntorno("abc") === 200 && topeDesdeEntorno("0") === 200 && topeDesdeEntorno("-5") === 200);
check("entorno válido se respeta", topeDesdeEntorno("50") === 50);

console.log("\n5 · class30.js usa el tope (guarda contra la regresión)");
const src = fs.readFileSync(path.join(AQUI, "..", "..", "scripts", "class30.js"), "utf8");
check("importa cola_acotada.js", /from "\.\/cola_acotada\.js"/.test(src));
check("no queda ningún pyQueue.push sin tope", !/pyQueue\.push\(/.test(src));
check("enqueueForPython pasa por encolarAcotado", /encolarAcotado\(pyQueue, payload, PY_QUEUE_MAX\)/.test(src));
check("el reencolado al frente respeta el tope",
      /if \(pyQueue\.length < PY_QUEUE_MAX\) pyQueue\.unshift\(data\)/.test(src));
check("ningún unshift sin guarda", (src.match(/pyQueue\.unshift\(/g) || []).length === 1);
check("el health_check informa descartados y RSS", /queue_descartados/.test(src) && /rss_mb/.test(src));

console.log("\n6 · Las decisiones de class25A no se reenvían al Python");
check("class25a_output se corta por canal", esDecisionInterna("class25a_output", { type: "x", text: "y" }));
check("y por tipo, aunque llegue por otro canal",
      esDecisionInterna("class25_output", { type: "decision_cuantitativa", text: "XLK subió" }));
check("una respuesta de chat NO es decisión interna",
      !esDecisionInterna("class25_output", { type: "respuesta", text: "hola" }));
check("dato nulo o sin tipo no explota",
      !esDecisionInterna("class25_output", null) && !esDecisionInterna("ui_stream", {}));
check("class30 corta ANTES de encolar",
      src.indexOf("esDecisionInterna(channel, data)") > 0 &&
      src.indexOf("esDecisionInterna(channel, data)") < src.indexOf("enqueueForPython(payloadEnvelope)"));
check("y tiene interruptor de reversa", /CLASS30_REENVIAR_DECISIONES/.test(src));
// El otro lado del contrato: class25B ya las descartaba. Si alguien saca ese
// filtro, cortar acá deja de ser "sin efecto" y hay que volver a pensarlo.
const src25b = fs.readFileSync(path.join(AQUI, "..", "..", "scripts", "class25B.js"), "utf8");
check("class25B sigue descartando esos textos (filtro anti-loop)",
      /puntos porcentuales estimados/.test(src25b) && /Input interno ignorado/.test(src25b));
const cpp = fs.readFileSync(path.join(AQUI, "..", "..", "miia_cognitive", "class25A.cpp"), "utf8");
check("y class25A sigue firmando type=decision_cuantitativa", /\{"type",\s*"decision_cuantitativa"\}/.test(cpp));

console.log(`\n${fallos === 0 ? "✅" : "❌"} sim24: ${n - fallos}/${n} checks`);
process.exit(fallos === 0 ? 0 : 1);
