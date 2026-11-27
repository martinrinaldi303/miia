/**
 * sim32 — el motor de lenguaje LOCAL y la guarda de Redis del orquestador.
 *
 *     node docs/simulaciones/sim32_llm_local.js
 *
 * Qué valida, y por qué cada cosa:
 *
 *   1-4. El cliente de Ollama contra un Ollama FALSO levantado acá: el camino
 *        feliz, el mapeo de turnos, y los cuatro modos de fallar (HTTP malo,
 *        respuesta vacía, timeout, JSON roto). Se corre el código real de
 *        `scripts/llm_local.js`, no una copia.
 *   5.   El cortacircuitos. Sin él, un Ollama caído hace que CADA mensaje del
 *        chat espere el timeout completo antes de caer al respaldo.
 *   6.   `disponible()` y su caché: el router lo llama por mensaje y un
 *        /api/tags por mensaje es gasto al aire.
 *   7.   Guardas de regresión sobre class25B: que el router esté enchufado en
 *        los DOS caminos, que el camino de Gemini siga intacto debajo, y que
 *        `MIIA_LLM=gemini` siga siendo la reversa exacta.
 *   8.   Guardas de regresión sobre operador/index.js: que el respawn decida
 *        AL DISPARAR, que REDIS no se relance si el puerto ya está servido, y
 *        que startRedis siga reutilizando el Redis vivo.
 *
 * No toca la red ni el server: el Ollama falso escucha en 127.0.0.1 en un
 * puerto efímero.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");

let ok = 0, falla = 0;
const chequear = (nombre, cond, nota = "") => {
  if (cond) { ok++; console.log(`   [ok]    ${nombre.padEnd(56)} ${nota}`); }
  else { falla++; console.log(`   [FALLA] ${nombre.padEnd(56)} ${nota}`); }
};
const seccion = t => console.log(`\n${t}`);

// ── Ollama falso ───────────────────────────────────────────────────────────
const visto = { tags: 0, generate: 0, chat: 0, ultimoCuerpo: null };
let modo = "ok";            // ok | vacio | http500 | nojson | colgado
const reiniciar = () => {
  LLM._test.reset();
  visto.tags = visto.generate = visto.chat = 0;
  visto.ultimoCuerpo = null;
};
let modelosTags = ["gemma2:2b"];

const servidor = http.createServer((req, res) => {
  const trozos = [];
  req.on("data", d => trozos.push(d));
  req.on("end", () => {
    const cuerpo = trozos.length ? JSON.parse(Buffer.concat(trozos).toString("utf8")) : null;
    visto.ultimoCuerpo = cuerpo;

    if (req.url.startsWith("/api/tags")) {
      visto.tags++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ models: modelosTags.map(n => ({ name: n })) }));
    }
    if (req.url.startsWith("/api/generate")) visto.generate++;
    if (req.url.startsWith("/api/chat")) visto.chat++;

    if (modo === "colgado") return;                       // nunca contesta
    if (modo === "http500") { res.writeHead(500); return res.end("boom"); }
    if (modo === "nojson") { res.writeHead(200); return res.end("<html>no soy json"); }

    const texto = modo === "vacio" ? "" : "XLK viene firme. Conviene mirar la confianza antes de operar.";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/api/chat")
      ? { message: { role: "assistant", content: texto }, eval_count: 24, eval_duration: 2_000_000_000 }
      : { response: texto, eval_count: 24, eval_duration: 2_000_000_000 }));
  });
});

await new Promise(r => servidor.listen(0, "127.0.0.1", r));
const PUERTO = servidor.address().port;

// El módulo lee OLLAMA_URL al importarse, así que hay que fijarla ANTES.
process.env.OLLAMA_URL = `http://127.0.0.1:${PUERTO}`;
process.env.MIIA_LLM_MODELO = "gemma2:2b";
const LLM = await import("../../scripts/llm_local.js");

// ── 1 ──────────────────────────────────────────────────────────────────────
seccion("1 · Generar: el camino feliz");
reiniciar(); modo = "ok";
{
  const r = await LLM.generar({ prompt: "¿cómo viene XLK?", system: "Sos MIIA.", maxTokens: 120 });
  chequear("devuelve el texto", r.texto.includes("XLK"), `${r.texto.length} chars`);
  chequear("informa tokens y tokens/s", r.tokens === 24 && r.tps > 0, `${r.tokens} tok · ${r.tps} tok/s`);
  chequear("informa el modelo", r.modelo === "gemma2:2b");
  const c = visto.ultimoCuerpo;
  chequear("manda stream:false", c.stream === false, "una respuesta entera, no SSE");
  chequear("manda keep_alive", !!c.keep_alive, `keep_alive=${c.keep_alive}`);
  chequear("manda num_ctx y num_predict", c.options.num_ctx > 0 && c.options.num_predict === 120,
    `ctx=${c.options.num_ctx}`);
  chequear("manda repeat_penalty", c.options.repeat_penalty > 1,
    "sin esto un 2B entra en bucles de repetición");
  chequear("el system va aparte del prompt", c.system === "Sos MIIA." && c.prompt.includes("XLK"));
}

// ── 2 ──────────────────────────────────────────────────────────────────────
seccion("2 · Conversar: el mapeo de turnos");
reiniciar();
{
  const r = await LLM.conversar({
    mensajes: [
      { rol: "system", texto: "Sos MIIA." },
      { rol: "user", texto: "hola" },
      { rol: "assistant", texto: "qué tal" },
      { rol: "user", texto: "¿y XLE?" },
    ],
  });
  const m = visto.ultimoCuerpo.messages;
  chequear("va por /api/chat", visto.chat === 1 && visto.generate === 0,
    "la plantilla de turnos la aplica Ollama, no nosotros");
  chequear("conserva los 4 turnos en orden", m.length === 4 && m[0].role === "system"
    && m[1].role === "user" && m[2].role === "assistant" && m[3].role === "user");
  chequear("un rol desconocido cae a user",
    (await (async () => {
      await LLM.conversar({ mensajes: [{ rol: "robot", texto: "x" }] });
      return visto.ultimoCuerpo.messages[0].role;
    })()) === "user");
  chequear("los mensajes vacíos se descartan",
    (await (async () => {
      await LLM.conversar({ mensajes: [{ rol: "user", texto: "" }, { rol: "user", texto: "hola" }] });
      return visto.ultimoCuerpo.messages.length;
    })()) === 1);
  chequear("sin mensajes útiles, tira",
    await (async () => {
      try { await LLM.conversar({ mensajes: [{ rol: "user", texto: "  " }] }); return false; }
      catch { return true; }
    })());
  chequear("devuelve el texto del assistant", r.texto.includes("XLK"));
}

// ── 3 ──────────────────────────────────────────────────────────────────────
seccion("3 · Los cuatro modos de fallar");
for (const [m, nombre] of [["http500", "HTTP 500"], ["vacio", "respuesta vacía"],
  ["nojson", "respuesta que no es JSON"]]) {
  reiniciar(); modo = m;
  let tiro = false, msg = "";
  try { await LLM.generar({ prompt: "x" }); } catch (e) { tiro = true; msg = e.message; }
  chequear(`${nombre} → tira`, tiro, msg.slice(0, 48));
}
{
  reiniciar(); modo = "colgado";
  const t0 = Date.now();
  let tiro = false;
  try { await LLM.generar({ prompt: "x", timeoutMs: 400 }); } catch { tiro = true; }
  const ms = Date.now() - t0;
  chequear("un Ollama colgado corta por timeout", tiro && ms < 3000, `cortó a los ${ms} ms`);
  chequear("  y el timeout es DURO (destruye el socket)", ms >= 350 && ms < 3000,
    "con `fetch` sin AbortController esto quedaba colgado");
}
{
  reiniciar(); modo = "ok";
  let tiro = false;
  try { await LLM.generar({ prompt: "" }); } catch { tiro = true; }
  chequear("un prompt vacío no sale a la red", tiro && visto.generate === 0);
}

// ── 4 ──────────────────────────────────────────────────────────────────────
seccion("4 · Nada de esto rompe si Ollama no está");
{
  // Un puerto DE VERDAD cerrado: se abre uno al azar y se cierra enseguida.
  // Es el caso «Ollama no instalado todavía», que es como va a arrancar
  // class25B el día del despliegue.
  const sondeo = http.createServer();
  await new Promise(r => sondeo.listen(0, "127.0.0.1", r));
  const muerto = sondeo.address().port;
  await new Promise(r => sondeo.close(r));

  const guardada = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${muerto}`;
  const otro = await import(`../../scripts/llm_local.js?p=${Date.now()}`);
  process.env.OLLAMA_URL = guardada;

  let tiro = false, disp = null;
  try { disp = await otro.disponible(true); } catch { tiro = true; }
  chequear("disponible() con Ollama ausente da false y NO tira", !tiro && disp === false,
    "si tirara, class25B no arrancaría");

  const t0 = Date.now();
  let tiroGen = false;
  try { await otro.generar({ prompt: "hola" }); } catch { tiroGen = true; }
  const ms = Date.now() - t0;
  chequear("generar() falla RÁPIDO, no por timeout", tiroGen && ms < 1500,
    `ECONNREFUSED en ${ms} ms — el chat cae al respaldo sin esperar`);
  chequear("  y el resumen lo dice", otro.resumen().includes("fallos=1"));
}

// ── 5 ──────────────────────────────────────────────────────────────────────
seccion("5 · El cortacircuitos");
{
  reiniciar(); modo = "http500";
  for (let i = 0; i < LLM._test.FALLOS_PARA_CORTAR; i++) {
    try { await LLM.generar({ prompt: "x" }); } catch { /* esperado */ }
  }
  chequear(`${LLM._test.FALLOS_PARA_CORTAR} fallos seguidos lo abren`, LLM.cortado(),
    `faltan ${LLM.cortadoMin()} min`);
  const antes = visto.generate;
  let tiro = false, instantaneo = false;
  const t0 = Date.now();
  try { await LLM.generar({ prompt: "x" }); } catch { tiro = true; instantaneo = Date.now() - t0 < 50; }
  chequear("  cortado, tira al instante", tiro && instantaneo);
  chequear("  y NO sale a la red", visto.generate === antes,
    "es el punto: el chat no espera el timeout en cada mensaje");

  reiniciar(); modo = "ok";
  try { await LLM.generar({ prompt: "x" }); } catch { /* no */ }
  chequear("un éxito resetea la racha", !LLM.cortado());

  reiniciar(); modo = "http500";
  for (let i = 0; i < LLM._test.FALLOS_PARA_CORTAR - 1; i++) {
    try { await LLM.generar({ prompt: "x" }); } catch { /* */ }
  }
  modo = "ok";
  try { await LLM.generar({ prompt: "x" }); } catch { /* */ }
  modo = "http500";
  try { await LLM.generar({ prompt: "x" }); } catch { /* */ }
  chequear("fallos NO consecutivos no lo abren", !LLM.cortado(),
    "cuenta la racha, no el total");
}

// ── 6 ──────────────────────────────────────────────────────────────────────
seccion("6 · disponible() y su caché");
{
  reiniciar(); modo = "ok"; modelosTags = ["gemma2:2b", "llama3.2:1b"];
  chequear("ve el modelo configurado", await LLM.disponible(true) === true);
  const antes = visto.tags;
  await LLM.disponible();
  chequear("la segunda consulta sale de la caché", visto.tags === antes,
    "30 s de TTL: el router lo llama por mensaje");
  chequear("  y forzar la saltea", await (async () => {
    const a = visto.tags; await LLM.disponible(true); return visto.tags > a;
  })());

  LLM._test.reset(); modelosTags = ["gemma2"];
  chequear("reconoce el modelo sin tag", await LLM.disponible(true) === true,
    "gemma2 vale por gemma2:2b");

  LLM._test.reset(); modelosTags = ["llama3.2:1b"];
  chequear("si el modelo NO está bajado, da false", await LLM.disponible(true) === false,
    "Ollama vivo pero sin el modelo = no sirve");
  modelosTags = ["gemma2:2b"];

  const m = LLM.metricas();
  chequear("las métricas traen lo que el heartbeat necesita",
    "modelo" in m && "ms_medio" in m && "cortado" in m && "keep_alive" in m);
  chequear("resumen() es una línea", LLM.resumen().includes("llm_local:") && !LLM.resumen().includes("\n"));
}

// ── 7 ──────────────────────────────────────────────────────────────────────
seccion("7 · Guardas de regresión sobre class25B");
{
  const c = fs.readFileSync(path.join(RAIZ, "scripts", "class25B.js"), "utf8");
  // El especificador va partido a proposito: sim18 escanea los imports de todo
  // archivo .js y un literal asi adentro de un includes() le parece un import
  // real de `docs/simulaciones/./llm_local.js`, que no existe. Antes que aflojar
  // ese escaner —que es el que cuida la caja de los imports en Linux—, se parte
  // la cadena aca.
  const _esp = 'import * as LLM from "./' + 'llm_local.js"';
  chequear("importa el motor local", c.includes(_esp));
  chequear("tiene el router MIIA_LLM, y por defecto SOLO LOCAL",
    c.includes('process.env.MIIA_LLM || "local"') && c.includes("LLM_USA_LOCAL") && c.includes("LLM_USA_GEMINI"),
    "decisión de Martín el 11-oct-2026: el chat no gasta cuota de Gemini");
  chequear("el CHAT ya no lo cierra `_geminiReady` solo",
    /const hayLocal  = LLM_USA_LOCAL  && !LLM\.cortado\(\)( && !opts\.soloGemini)?;/.test(c)
    && c.includes("if (!hayLocal && !hayGemini && !hayDeepseek) return null;"),
    "con MIIA_LLM=local no hay modelo de Gemini y hay que contestar igual");
  chequear("el CHAT intenta local y usa el historial", c.includes("await LLM.conversar({ mensajes"));
  chequear("la REDACCIÓN intenta local", c.includes("await LLM.generar({ prompt, maxTokens: LLM_LOCAL_MAX_TOKENS"));
  chequear("el CHAT usa el prompt COMPACTO, no el de Gemini",
    c.includes("texto: charla ? promptCharla(ctx) : _buildAdvisorPromptLocal(texto, ctx)"),
    "el de Gemini son 1.027 tokens = 25 s sólo de lectura en esta CPU");
  chequear("el prompt compacto conserva el marco legal y la identidad",
    /function _buildAdvisorPromptLocal[\s\S]*?NO sos asesor financiero[\s\S]*?nunca nombres a Gemini/.test(c),
    "es una página pública de información financiera: eso no se recorta por latencia");
  chequear("el historial local está acotado",
    c.includes("slice(-LLM_LOCAL_TURNOS)") && c.includes("LLM_LOCAL_CHARS_TURNO"),
    "cada turno viejo se paga a 24,7 ms por token dentro del prompt");
  chequear("el camino de Gemini sigue INTACTO debajo",
    (c.match(/geminiModel\.generateContent\(\{/g) || []).length === 3,
    "las 3 llamadas originales siguen ahí (la de charla envuelta en Promise.race con tope de 9 s): `MIIA_LLM=gemini` es la reversa");
  chequear("Gemini sigue condicionado al router (no se llama a ciegas)",
    c.includes("if (!LLM_USA_GEMINI || !_geminiReady()) return null;")
    && c.includes("return hayGemini ? await correrGemini() : null;"),
    "correrGemini sólo se invoca si hayGemini");
  chequear("en la charla libre, Gemini PRIMERO y Ollama de respaldo",
    c.includes("if (opts.geminiPrimero && hayGemini)")
    && c.includes("return hayLocal ? await correrLocal(LLM_CHARLA_TIMEOUT_SERIE_MS) : null;")
    && c.includes("return await pLocal;"),
    "Gemini rápido para opinar; cuando se queda sin cuota (429) cae a Ollama, así MIIA nunca se queda callada");
  chequear("la charla habilita Gemini aunque MIIA_LLM=local",
    c.includes("(opts.geminiPrimero ? true : LLM_USA_GEMINI) && _geminiReady(bypassGrace)")
    && c.includes('process.env.CLASS25B_CHARLA_GEMINI ?? "1"')
    && c.includes("{ geminiPrimero: CHARLA_GEMINI_PRIMERO, validar: validarCharla }"),
    "los datos siguen por el redactor determinístico; esto es sólo para opinar");
  // 13-nov-2026: «no me salió una respuesta» aunque un motor podía contestar.
  chequear("la charla valida CADA motor: lo descartado prueba el siguiente",
    c.includes("const _sirve = (txt, motor) =>")
    && c.includes('if (!_sirve(respuesta, "gemini")) return null;')
    && c.includes('if (!_sirve(r.texto, "local")) return null;'),
    "antes un descarte (o un texto vacío) de Gemini iba directo al respaldo sin probar Ollama");
  {
    const ig = c.indexOf('if (!_sirve(respuesta, "gemini")) return null;');
    const il = c.indexOf('if (!_sirve(r.texto, "local")) return null;');
    const cg = c.indexOf("_geminiCacheSet(_claveCache, respuesta);");
    const cl = c.indexOf("_geminiCacheSet(_claveCache, r.texto);");
    chequear("lo descartado NO se cachea (se valida antes de guardar)",
      ig > 0 && il > 0 && cg > ig && cl > il,
      "cacheado, la misma pregunta caía al respaldo 10 min sin llamar a ningún motor");
  }
  chequear("un texto vacío o bloqueado de Gemini no corta la cadena",
    c.includes("try { respuesta = String(result.response.text() || \"\").trim(); }"),
    "`text()` tira con SAFETY: eso es una respuesta vacía, no una falla para pausar Gemini");
  chequear("un 400 por thinkingConfig se reintenta sin él (sin pausar Gemini 30 min)",
    c.includes("_geminiSinThinking = true;") && /\/thinking\|budget\/i/.test(c),
    "y el reintento va dentro del mismo tope de 9 s (Promise.race sobre _pGemini)");
  chequear("los MLLs NO aprenden del modelo local por defecto",
    c.includes('process.env.MIIA_LLM_APRENDER_LOCAL || "0"')
    && c.includes("if (LLM_APRENDER_LOCAL && !tarde) aprenderDeRespuestaGemini"),
    "mezclar dos redactores en learning_cycles no se separa hacia atrás");
  // El fix de tiempos del 7-nov: la charla tiene que ENTRAR en los 25 s del frente
  // aun con un Gemini que da 503 y reintenta. Ollama en charla corta a 12 s y Gemini
  // lleva un tope duro de 9 s; el `[503]` hace que _handleGeminiError lo pause.
  chequear("la charla acota el tiempo de Ollama (respaldo rápido)",
    c.includes("const correrLocal = async (timeoutMs = charla ? LLM_CHARLA_TIMEOUT_MS : undefined")
    && c.includes("timeoutMs, signal });"),
    "sin esto, un 503 de Gemini + Ollama 18 s se pasa de los 25 s y el chat queda mudo");
  chequear("Gemini en charla lleva un tope DURO que lo pausa al colgarse",
    c.includes("Promise.race") && c.includes("[503] gemini timeout charla"),
    "un 503 que el SDK reintenta no puede comerse el presupuesto de 25 s");
  {
    // 8-nov: en CARRERA los dos arrancan juntos, así que el peor caso es el mayor de
    // los dos topes (no la suma); en fila (CLASS25B_CHARLA_CARRERA=0, y la reescritura
    // de respuestas con datos) es la suma. Medido esa noche: Ollama con el modelo
    // cargado tarda 10,6-12+ s en una charla, así que en carrera necesita más de 12 s.
    const gTO = Number(c.match(/GEMINI_TIMEOUT_CHARLA_MS\s*\|\|\s*(\d+)/)?.[1] || 0);
    const oTO = Number(c.match(/MIIA_LLM_TIMEOUT_CHARLA_MS\s*\|\|\s*(\d+)/)?.[1] || 0);
    const sTO = Number(c.match(/MIIA_LLM_TIMEOUT_CHARLA_SERIE_MS\s*\|\|\s*(\d+)/)?.[1] || 0);
    chequear("en carrera, el peor caso entra en los 25 s con margen",
      gTO > 0 && oTO > 0 && Math.max(gTO, oTO) <= 21000,
      `max(Gemini ${gTO}, Ollama ${oTO}) = ${Math.max(gTO, oTO)} ms ≤ 21000 (frente y Python: 25 s)`);
    chequear("y Ollama tiene más de los 12 s en que fallaba",
      oTO > 14000, `Ollama ${oTO} ms (medido: 10,6-12+ s con el modelo cargado)`);
    chequear("en fila (reversa y reescritura), Gemini + Ollama entran en los 25 s",
      gTO > 0 && sTO > 0 && gTO + sTO < 25000, `Gemini ${gTO} + Ollama ${sTO} = ${gTO + sTO} ms < 25000`);
  }
  chequear("la charla corre Gemini y Ollama en CARRERA por defecto",
    c.includes('process.env.CLASS25B_CHARLA_CARRERA ?? "1"')
    && /if \(hayLocal && CHARLA_EN_CARRERA && !opts\.sinCarrera\)[\s\S]{0,900}const pLocal = correrLocal\(LLM_CHARLA_TIMEOUT_MS, estado, ctrl\.signal\);[\s\S]{0,80}const g = await correrGemini\(\);/.test(c),
    "Ollama arranca ANTES de esperar a Gemini, no después de su fallo (8-nov; el deploy del 13-nov la había pisado)");
  chequear("si contestó Gemini, la de Ollama llega tarde y no pisa la caché",
    c.includes('if (g) { estado.gano = "gemini"; ctrl.abort(); return g; }') && c.includes("if (!tarde) _geminiCacheSet(_claveCache, r.texto);"));
  // 26-nov-2026: si contesta Gemini se CANCELA Ollama. Sin esto la charla siguiente
  // esperaba en fila detrás de una respuesta que nadie usaba, vencía y abría el
  // cortacircuitos del motor local.
  chequear("si contestó Gemini, se cancela el pedido a Ollama",
    c.includes("const ctrl = new AbortController();") && c.includes("ctrl.abort(); return g;"));
  chequear("la cancelación no cuenta como falla del motor local",
    c.includes('if (e?.name === "AbortError") return null;'));
  chequear("la respuesta del chat devuelve el id de la consulta",
    c.includes("query_id:   msg.id || null,"),
    "sin esto /api/ask empareja sólo por sesión y dos mensajes seguidos se cruzan");
  chequear("la reescritura de respuestas con datos NO corre en carrera",
    /_geminiMultiTurno\(texto, \{ _modo: "reescribir"[\s\S]{0,300}sinCarrera: true/.test(c),
    "en carrera Ollama trabajaría en cada pregunta con datos aunque conteste Gemini");
  chequear("la prueba de Gemini al arrancar tiene tope (antes colgaba el arranque 2 min)",
    /await _conTopeArranque\(candidate\.generateContent\(/.test(c)
    && Number(c.match(/GEMINI_INIT_TIMEOUT_MS \|\| (\d+)/)?.[1] || 0) <= 10000
    && c.indexOf("_conTopeArranque(candidate") < c.indexOf("await redisSub.subscribe("),
    "sin tope, un Gemini colgado deja a class25B sin escuchar el chat ni las decisiones");
  chequear("en fila, Ollama usa el tope corto (no 9 + 20 > 25)",
    c.includes("return hayLocal ? await correrLocal(LLM_CHARLA_TIMEOUT_SERIE_MS) : null;"));
  chequear("el heartbeat informa el motor y sus fallos",
    c.includes("motor=${MIIA_LLM} local_ok=${_llmLocalUsos}") && c.includes("llm_local_modelo:"));
  chequear("GEMINI_SOLO_USUARIO sigue en 1 por defecto",
    c.includes('String(process.env.GEMINI_SOLO_USUARIO ?? "1") !== "0"'),
    "por eso cambiar de motor no toca ninguna decisión");
}

// ── 7b ─────────────────────────────────────────────────────────────────────
seccion("7b · El presupuesto de latencia, con la aritmética real");
{
  // Esto NO prueba el código: hace la cuenta que el 11-oct-2026 no se hizo y
  // dejó el chat mudo. Las constantes salen de lo que Ollama midió de SÍ MISMO
  // en el server (`prompt eval` y `eval time` de su propio log), no de una
  // estimación. Si alguien agranda el prompt o sube el tope de salida, esto se
  // pone en rojo ANTES de desplegar, que es la única forma de no repetirlo.
  const MS_POR_TOKEN_LEIDO    = 24.7;   // 1.027 tokens en 25.328 ms
  const MS_POR_TOKEN_GENERADO = 102.8;  // 59 tokens en 5.962 ms
  const PRESUPUESTO_MS = 22000;         // /api/ask de miia_chatbot.py se rinde acá
  const OBJETIVO_MS    = 18000;         // y queremos terminar antes, con margen

  // Normalizar CRLF→LF: en Windows (donde corre esta prueba antes del deploy) los
  // .js están en CRLF, y el parser de abajo acota la función con "\n}\n". Con CRLF
  // ese patrón no matchea nunca (tras el `}` viene `\r`) → indexOf da -1 → se medía
  // TODO el archivo como prompt (464 s, imposible; el real son ~250 tokens).
  const c  = fs.readFileSync(path.join(RAIZ, "scripts", "class25B.js"), "utf8").replace(/\r\n/g, "\n");
  const ll = fs.readFileSync(path.join(RAIZ, "scripts", "llm_local.js"), "utf8").replace(/\r\n/g, "\n");

  // Ojo con el `return \`` del .map() de sectores, que viene ANTES del prompt:
  // anclar en el primero que aparezca hace contar el codigo del medio como si
  // fuera texto, y el presupuesto sale inflado. Se ancla en el texto mismo.
  const fnIni = c.indexOf("function _buildAdvisorPromptLocal");
  const fn    = c.slice(fnIni, c.indexOf("\n}\n", fnIni));
  const prompt = fn.slice(fn.indexOf("return `Sos MIIA") + 8, fn.lastIndexOf("`;"));
  // ~3,3 caracteres por token en castellano, de la medición real.
  const tokensPrompt = Math.round(prompt.length / 3.3);

  const tope = Number((c.match(/MIIA_LLM_MAX_TOKENS \|\| (\d+)/) || [])[1]);
  const tout = Number(String((ll.match(/MIIA_LLM_TIMEOUT_MS \|\| ([\d_]+)/) || [])[1]).replace(/_/g, ""));

  const msLectura    = tokensPrompt * MS_POR_TOKEN_LEIDO;
  const msGeneracion = tope * MS_POR_TOKEN_GENERADO;
  const msTotal      = msLectura + msGeneracion;

  console.log(`        prompt ~${tokensPrompt} tokens = ${(msLectura / 1000).toFixed(1)} s`
    + ` + ${tope} tokens de salida = ${(msGeneracion / 1000).toFixed(1)} s`
    + `  →  ${(msTotal / 1000).toFixed(1)} s de peor caso`);

  chequear("el peor caso entra en el objetivo de 18 s", msTotal < OBJETIVO_MS,
    `da ${(msTotal / 1000).toFixed(1)} s — acortá el prompt o bajá MIIA_LLM_MAX_TOKENS`);
  chequear("y con margen contra los 22 s de /api/ask", msTotal < PRESUPUESTO_MS * 0.85);
  chequear("el timeout del cliente cae DENTRO del presupuesto", tout > 0 && tout < PRESUPUESTO_MS,
    "si el cliente espera más que el Python, la respuesta llega cuando ya nadie escucha");
  chequear("el timeout deja terminar al peor caso", tout > msTotal,
    "cortar justo antes de la última palabra es peor que no intentar");
  chequear("el bloque estable del prompt va ANTES del volátil",
    prompt.indexOf("Sin markdown") < prompt.indexOf("AHORA:"),
    "Ollama cachea el prefijo: con el riesgo arriba, cada mensaje lo invalida");
}

// ── 7c ─────────────────────────────────────────────────────────────────────
seccion("7c · La reescritura con Ollama: sólo respuestas cortas, y que entren en 12 s");
{
  // 13-nov-2026: la reescritura de las respuestas con datos va a Gemini primero y
  // a Ollama SÓLO si la respuesta del sistema es corta. Una larga (600 caracteres)
  // no entra nunca: ~450 tokens de prompt + ~150 de salida ≈ 26 s. Esta cuenta usa
  // el prompt REAL (promptCharla en modo reescribir) y el PEOR caso: el prefijo
  // frío en Ollama, la referencia al tope y una pregunta larga.
  const MS_LEIDO = 24.7, MS_ESCRITO = 102.8;
  const c = fs.readFileSync(path.join(RAIZ, "scripts", "class25B.js"), "utf8");
  const chars  = Number((c.match(/CLASS25B_REESCRIBIR_LOCAL_CHARS\s*\|\|\s*(\d+)/) || [])[1]);
  const tokens = Number((c.match(/CLASS25B_REESCRIBIR_LOCAL_TOKENS\s*\|\|\s*(\d+)/) || [])[1]);
  const tout   = Number((c.match(/MIIA_LLM_TIMEOUT_CHARLA_SERIE_MS \|\| (\d+)/) || [])[1]);   // va en fila
  const { promptCharla } = await import(pathToFileURL(path.join(RAIZ, "scripts", "chat_redactor.js")).href);
  const prompt = promptCharla({ _modo: "reescribir", _referencia: "x".repeat(chars) });
  const tokPrompt = Math.round(prompt.length / 3.3) + Math.round(80 / 3.3);   // + una pregunta de 80 caracteres
  const ms = tokPrompt * MS_LEIDO + tokens * MS_ESCRITO;
  console.log(`        reescritura local: prompt ~${tokPrompt} tokens + ${tokens} de salida → ${(ms / 1000).toFixed(1)} s (tope ${tout / 1000} s)`);
  chequear("las constantes de la reescritura local existen", chars > 0 && tokens > 0 && tout > 0, `${chars}/${tokens}/${tout}`);
  chequear("el peor caso de la reescritura local entra en el tope de Ollama", ms < tout,
    `da ${(ms / 1000).toFixed(1)} s — bajá CLASS25B_REESCRIBIR_LOCAL_CHARS o _TOKENS`);
  chequear("la reescritura local va SIN historial", /localTurnos:\s*0/.test(c));
  chequear("una respuesta larga sin Gemini sale YA (no espera a Ollama)",
    /if \(!corta && !\(CHARLA_GEMINI_PRIMERO && \(_geminiReady\(true\) \|\| DS\.disponible\(\)\)\)\) return null;/.test(c));
  chequear("y con Gemini, la larga no cae a Ollama (soloGemini)", /soloGemini:\s*!corta/.test(c));
}

// ── 8 ──────────────────────────────────────────────────────────────────────
seccion("8 · Guardas de regresión sobre operador/index.js");
{
  const c = fs.readFileSync(path.join(RAIZ, "operador", "index.js"), "utf8");
  chequear("existe `reintentar`", c.includes("function reintentar(cmd, args, label, cwd, extraEnv)"));
  chequear("los DOS respawns pasan por él",
    (c.match(/setTimeout\(\(\) => reintentar\(cmd, args, label, cwd, extraEnv\), 8000\)/g) || []).length === 2,
    "exit y error");
  chequear("ya no quedó ningún respawn directo",
    !c.includes("setTimeout(() => startProcess(cmd, args, label, cwd, extraEnv), 8000)"));
  chequear("revisa g_running AL DISPARAR",
    /function reintentar[\s\S]{0,400}if \(!g_running\)/.test(c),
    "un módulo que muere en los 8 s previos al apagado ya no revive después");
  chequear("REDIS no se relanza si el puerto ya está servido",
    /label\.toUpperCase\(\) === "REDIS" && redisResponde\(\)/.test(c),
    "es el bucle de 10.800 procesos por día");
  chequear("startRedis sigue reutilizando el Redis vivo",
    c.includes("reutilizando, no se lo toca") && /if \(redisResponde\(\)\)[\s\S]{0,260}return;/.test(c));
  chequear("lleva la cuenta de si el Redis es nuestro", c.includes("let g_redisPropio = false;"));
  chequear("el Redis hijo queda visible para limpiarHuerfanos",
    c.includes('"--pidfile", path.join(rootDir, "redis-miia.pid")'),
    "pgrep -f rootDir no veía un `redis-server --port 6379` pelado");
  chequear("el monitor sigue sin relanzar Redis",
    c.includes("Redis no responde — esperando reconexión automática"),
    "el Bug 2 documentado sigue cubierto");
  chequear("REDIS sigue en CRITICAL_LABELS", /CRITICAL_LABELS = new Set\(\[\s*\n?\s*"REDIS"/.test(c),
    "la guarda es la que lo hace seguro, no sacarlo de la lista");
}

// ── 9 ──────────────────────────────────────────────────────────────────────
seccion("9 · El chat llega a Ollama y el prompt deja de salir genérico (15-oct)");
{
  const GLO = await import("../../scripts/glosario.js");
  const mapa = { XLK:  { sector: "Technology", region: "US" },
                 ARGT: { sector: "MERVAL",     region: "LATAM" },
                 DIA:  { sector: "US Dow 30",  region: "US" } };

  // 9.a — el glosario (módulo puro): grounding real, sin inventar
  chequear("glosario: 'señal de XLK' -> definición real",
    GLO.glosarioLocal("¿Qué significa la señal de XLK?", mapa)
      === "GLOSARIO: XLK = ETF de Technology (US).",
    "antes el 2B contestaba 'ARG es un indicador de riesgo global', inventado");
  chequear("glosario: 'Qué es ARG?' -> vacío (ARG no es ARGT)",
    GLO.glosarioLocal("Qué es ARG?", mapa) === "");
  chequear("glosario: 'buen día' NO dispara DIA (límite de palabra)",
    GLO.glosarioLocal("buen día, ¿algo hoy?", mapa) === "");
  chequear("glosario: sin mapa -> vacío", GLO.glosarioLocal("XLK", null) === "");
  chequear("glosario: respeta el tope de definiciones",
    GLO.glosarioLocal("XLK ARGT DIA", mapa, 2).split(";").length === 2);

  // 9.b — guardas de regresión sobre class25B
  const c = fs.readFileSync(path.join(RAIZ, "scripts", "class25B.js"), "utf8");
  chequear("la compuerta del chat es el ROUTER, no `_geminiReady`",
    c.includes("if (_hayMotorLenguaje(true)) {")
    && c.includes("function _hayMotorLenguaje(bypassGrace = false)"),
    "sin esto, con MIIA_LLM=local el chat nunca llegaba a Ollama");
  chequear("el paso de portfolio también usa el router",
    c.includes("if (_hayMotorLenguaje()) {"));
  chequear("_geminiMultiTurno devuelve {texto, motor}",
    c.includes('return { texto: r.texto, motor: "local" };')
    && c.includes('return { texto: respuesta, motor: "gemini" };')
    && c.includes('return { texto: cached, motor: "cache" };'));
  chequear("el chat NO aprende del motor local en el llamador",
    c.includes('if (_r.motor === "gemini") {')
    && /if \(_r\.motor === "gemini"\) \{[\s\S]{0,180}aprenderDeRespuestaGemini/.test(c),
    "learning_cycles no se mezcla con el 2B");
  chequear("el prompt local usa el glosario de la fuente única",
    c.includes("glosarioLocal(texto, _GLOSARIO_TICKER)")
    && c.includes("INSTRUMENTOS"));
  chequear("el prompt local inyecta el dato del ticker en foco",
    c.includes("const foco = (ctx._tickerFocus || [])")
    && /porTicker = foco\.length[\s\S]{0,120}_lstmExtra/.test(c),
    "el dato de XLK llegaba a ctx y el prompt lo tiraba");
  chequear("el prompt local tiene la regla anti-confabulación",
    c.includes("en vez de inventar"));
  chequear("el tope de salida bajo para entrar en el server cargado (<= 60)",
    Number((c.match(/MIIA_LLM_MAX_TOKENS \|\| (\d+)/) || [])[1]) <= 60,
    "a 4,2 tok/s del 15-oct, 90 tokens revientan el timeout de 18 s");

  // 9.c — el fallback contesta "que es X" SIN LLM y SIN mencionar a Gemini
  chequear("el fallback contesta un ticker con dato real (def + senal)",
    c.includes("es el ETF de ${g.sector}")
    && c.includes("const _tkrFoco = ((ctx._tickerFocus || [])[0]"),
    "cuando Ollama esta sobrecargado, 'que es XLK' igual responde con dato");
  chequear("el fallback ya NO menciona a Gemini en el texto al usuario",
    !c.includes("cuando Gemini está disponible"),
    "era la plantilla vieja; el chat es independiente de Gemini");
}

// ── 10 ─────────────────────────────────────────────────────────────────────
// Las capturas del 13-nov-2026: «¿Qué es un ETFs?» y «¿sos consciente de vos
// misma?» contestaban «no me salió una respuesta». Las guardas de texto de la
// sección 7 dicen que el código ESTÁ; ésta corre `_geminiMultiTurno` DE VERDAD
// (copiado de class25B, con motores falsos) y dice que la cadena FUNCIONA.
// Contra el class25B anterior falla 8 de estos 11.
seccion("10 · La cadena de motores de la charla, corrida (13-nov)");
{
  const fuente = fs.readFileSync(path.join(RAIZ, "scripts", "class25B.js"), "utf8").replace(/\r\n/g, "\n");
  const i0 = fuente.indexOf("async function _geminiMultiTurno(");
  const cuerpo = fuente.slice(i0, fuente.indexOf("\n}\n", i0) + 3);
  const crypto = await import("node:crypto");
  function armar({ gemini, local, deepseek = null }) {
    const st = { cache: new Map(), llamadasG: 0, llamadasL: 0, llamadasD: 0, abortosD: 0, cfgs: [], errores: [], sinThinking: false, descartadas: 0 };
    const env = {
      LLM_USA_LOCAL: true, LLM_USA_GEMINI: false, LLM_LOCAL_TURNOS: 2, LLM_LOCAL_CHARS_TURNO: 250, LLM_CHARLA_TURNOS: 1, LLM_CHARLA_CHARS_TURNO: 160,
      LLM_CHARLA_MAX_TOKENS: 56, LLM_LOCAL_MAX_TOKENS: 56, LLM_CHARLA_TIMEOUT_MS: 12000, LLM_CHARLA_TIMEOUT_SERIE_MS: 12000, CHARLA_EN_CARRERA: true, GEMINI_CHARLA_TIMEOUT_MS: 200,
      LLM_APRENDER_LOCAL: false, crypto,
      LLM: { cortado: () => false, conversar: async o => { st.llamadasL++; return local(o); } },
      DS: { disponible: () => !!deepseek,
            conversar: o => { st.llamadasD++;
              if (o.signal) o.signal.addEventListener("abort", () => st.abortosD++, { once: true });
              return deepseek(o); } },
      geminiModel: { generateContent: req => { st.llamadasG++; st.cfgs.push(req.generationConfig); return gemini(req); } },
      _geminiReady: () => true, log: () => {},
      _geminiCacheGet: k => st.cache.get(k) ?? null, _geminiCacheSet: (k, v) => st.cache.set(k, v),
      promptCharla: () => "PROMPT", _buildAdvisorPrompt: () => "P", _buildAdvisorPromptLocal: () => "P",
      aprenderDeRespuestaGemini: () => {}, _gemini429StreakReset: () => {},
      _handleGeminiError: e => st.errores.push(e.message),
      _chatStats: { get descartadas() { return st.descartadas; }, set descartadas(v) { st.descartadas = v; } },
    };
    const nombres = Object.keys(env);
    const f = new Function(...nombres, "st",
      `let _geminiSinThinking = st.sinThinking; let _llmLocalUsos = 0, _llmLocalFallos = 0;
       const __f = ${cuerpo.replace("async function _geminiMultiTurno", "async function")};
       return async (...a) => { const r = await __f(...a); st.sinThinking = _geminiSinThinking; return r; };`);
    return { st, correr: f(...nombres.map(n => env[n]), st) };
  }
  const resp = t => ({ response: { text: () => t } });
  const localOk = t => async () => ({ texto: t, modelo: "falso", ms: 1, tps: 1 });
  const opts = { geminiPrimero: true, validar: t => /INVALIDA/.test(t) ? { ok: false, motivo: "prueba" } : { ok: true } };
  const ctx = { _modo: "charla", _hechos: "h" };

  { const { st, correr } = armar({ gemini: async () => resp("Respuesta INVALIDA de Gemini."), local: localOk("La del local.") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("Gemini descartado por el validador → contesta Ollama", r?.motor === "local" && st.llamadasL === 1);
    chequear("lo descartado NO queda en la caché", ![...st.cache.values()].some(v => /INVALIDA/.test(v)));
    const r2 = await correr("hola", ctx, [], true, opts);
    chequear("la 2ª vez sale de la caché lo VALIDADO", r2?.motor === "cache" && r2.texto === "La del local."); }
  { const { correr } = armar({ gemini: async () => resp(""), local: localOk("La del local.") });
    chequear("Gemini vacío → contesta Ollama", (await correr("hola", ctx, [], true, opts))?.motor === "local"); }
  { const { st, correr } = armar({ gemini: async () => ({ response: { text: () => { throw new Error("Response was blocked due to SAFETY"); } } }),
                                 local: localOk("La del local.") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("Gemini bloqueado (text() tira) → Ollama, sin pausar Gemini", r?.motor === "local" && st.errores.length === 0); }
  { const { st, correr } = armar({ gemini: async req => { if (req.generationConfig.thinkingConfig) {
        const e = new Error("[400 Bad Request] Thinking budget is not supported for this model"); e.status = 400; throw e; }
        return resp("Gemini sin thinking contesta."); }, local: localOk("no debería") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("400 por thinkingConfig → reintenta sin él y contesta Gemini",
      r?.motor === "gemini" && st.llamadasG === 2 && !st.cfgs[1].thinkingConfig && st.errores.length === 0);
    chequear("y queda recordado para las próximas", st.sinThinking === true); }
  { const { st, correr } = armar({ gemini: async () => { const e = new Error("[400 Bad Request] API key not valid"); e.status = 400; throw e; },
                                 local: localOk("La del local.") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("otro 400 (la clave) NO se reintenta: breaker + Ollama", r?.motor === "local" && st.llamadasG === 1 && st.errores.length === 1); }
  { const { st, correr } = armar({ gemini: () => new Promise(ok => setTimeout(() => ok(resp("tarde")), 1000)), local: localOk("A tiempo.") });
    const t0 = Date.now(); const r = await correr("hola", ctx, [], true, opts);
    chequear("Gemini colgado → corta por el tope y contesta Ollama",
      r?.motor === "local" && Date.now() - t0 < 900 && /\[503\]/.test(st.errores[0] || ""), `${Date.now() - t0} ms`); }
  { const { st, correr } = armar({ gemini: async () => resp("Respuesta INVALIDA."), local: localOk("Local INVALIDA.") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("los dos descartados → null (el llamador usa el respaldo)", r === null && st.descartadas === 2); }
  { const { st, correr } = armar({ gemini: async () => resp(""), local: localOk("La del local.") });
    const r = await correr("hola", {}, [], true, {});
    chequear("el camino de DATOS no cambia: local primero, sin validador", r?.motor === "local" && st.llamadasG === 0); }
  // La reescritura (13-nov-2026): larga → sólo Gemini; corta → Ollama sin historial.
  { const { st, correr } = armar({ gemini: async () => resp("Respuesta INVALIDA."), local: localOk("no debería") });
    const r = await correr("hola", { _modo: "reescribir", _referencia: "ref" }, [], true, { ...opts, soloGemini: true });
    chequear("soloGemini: Gemini descartado → null, SIN llamar a Ollama", r === null && st.llamadasL === 0); }
  { let visto = null;
    const { correr } = armar({ gemini: async () => resp(""), local: async o => { visto = o; return { texto: "Corta y bien.", modelo: "f", ms: 1, tps: 1 }; } });
    const hist = [{ rol: "user", txt: "antes" }, { rol: "assistant", txt: "respuesta" }];
    const r = await correr("hola", { _modo: "reescribir", _referencia: "ref2" }, hist, true, { ...opts, localTurnos: 0, localMaxTokens: 60 });
    chequear("corta: Ollama recibe SÓLO el sistema y la pregunta (slice(-0) no cuela el historial)",
      r?.motor === "local" && visto?.mensajes?.length === 2 && visto.mensajes[1].texto === "hola", JSON.stringify(visto?.mensajes?.map(m => m.rol)));
    chequear("corta: con el tope de salida propio", visto?.maxTokens === 60); }
  // DeepSeek, tercer motor (26-nov-2026).
  { const g503 = async () => { const e = new Error("[503] alta demanda"); e.status = 503; throw e; };
    const dsOk = t => async () => ({ texto: t, ms: 5, modelo: "deepseek-chat" });
    { const { st, correr } = armar({ gemini: g503, local: localOk("La del local."), deepseek: dsOk("La de DeepSeek.") });
      const r = await correr("hola", ctx, [], true, opts);
      chequear("DeepSeek: Gemini 503 → contesta DeepSeek y se cancela Ollama", r?.motor === "deepseek" && st.llamadasD === 1); }
    { const { st, correr } = armar({ gemini: async () => resp("Gemini contesta."),
                                   local: localOk("no debería"),
                                   deepseek: () => new Promise(ok => setTimeout(() => ok({ texto: "DS tarde", ms: 300 }), 300)) });
      const r = await correr("hola", { ...ctx, _hechos: "h2" }, [], true, opts);
      chequear("DeepSeek: si Gemini gana, DeepSeek se cancela", r?.motor === "gemini" && st.abortosD === 1); }
    { const { st, correr } = armar({ gemini: g503, local: localOk("La del local."), deepseek: dsOk("DeepSeek INVALIDA.") });
      const r = await correr("hola", { ...ctx, _hechos: "h3" }, [], true, opts);
      chequear("DeepSeek: los dos de la nube fallan → Ollama", r?.motor === "local"); }
    { const { st, correr } = armar({ gemini: g503, local: localOk("no debería"), deepseek: dsOk("DeepSeek larga.") });
      const r = await correr("hola", { _modo: "reescribir", _referencia: "ref9" }, [], true, { ...opts, soloGemini: true, sinCarrera: true });
      chequear("DeepSeek: reescritura larga sin Gemini → DeepSeek, sin Ollama", r?.motor === "deepseek" && st.llamadasL === 0); }
    { let visto = null;
      const { correr } = armar({ gemini: g503, local: async o => { visto = o; return { texto: "Local corta.", modelo: "f", ms: 1, tps: 1 }; } });
      const hist = [{ rol: "user", txt: "x".repeat(400) }, { rol: "assistant", txt: "y".repeat(400) }];
      await correr("hola", { ...ctx, _hechos: "h4" }, hist, true, opts);
      chequear("charla en Ollama: 1 turno de historial de 160 caracteres como mucho",
        visto?.mensajes?.length === 3 && visto.mensajes[1].texto.length === 160, JSON.stringify(visto?.mensajes?.map(m => m.texto.length))); }
    { const { st, correr } = armar({ gemini: async () => resp(""), local: localOk("La del local."), deepseek: dsOk("no debería") });
      await correr("hola", {}, [], true, {});
      chequear("DeepSeek: el camino de DATOS no lo usa", st.llamadasD === 0); }
  }
  // La CARRERA (8-nov), recuperada el 13-nov y combinada con la validación de hoy.
  { let tL0 = null, tG = null;
    const { st, correr } = armar({
      gemini: () => new Promise(ok => setTimeout(() => { tG = Date.now(); ok(resp("Gemini contesta bien.")); }, 120)),
      local: async () => { tL0 = Date.now(); await new Promise(r => setTimeout(r, 300)); return { texto: "Ollama tarde.", modelo: "f", ms: 1, tps: 1 }; } });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("carrera: Ollama ARRANCA antes de que Gemini termine", tL0 !== null && tG !== null && tL0 <= tG);
    chequear("carrera: si Gemini contesta bien, sale la de Gemini", r?.motor === "gemini");
    await new Promise(r2 => setTimeout(r2, 350));
    chequear("carrera: la de Ollama llega tarde y NO pisa la caché ni cuenta como descartada",
      [...st.cache.values()].every(v => v === "Gemini contesta bien.") && st.descartadas === 0); }
  { const { st, correr } = armar({ gemini: async () => resp("Respuesta INVALIDA."), local: localOk("La del local, a tiempo.") });
    const r = await correr("hola", ctx, [], true, opts);
    chequear("carrera + validador: Gemini descartado → vale la de Ollama, que ya venía corriendo",
      r?.motor === "local" && st.llamadasL === 1 && st.descartadas === 1); }
  { const { st, correr } = armar({ gemini: async () => resp("Gemini contesta bien."), local: localOk("no debería") });
    const r = await correr("hola", { _modo: "reescribir", _referencia: "ref3" }, [], true, { ...opts, sinCarrera: true });
    chequear("sinCarrera (reescritura): con Gemini bien, Ollama NI SE LLAMA", r?.motor === "gemini" && st.llamadasL === 0); }
}

// ── 11 ─────────────────────────────────────────────────────────────────────
// 8-nov-2026: con keep_alive de 5 min la charla casi siempre encontraba el modelo
// descargado, y cuando Gemini daba 503 Ollama no llegaba en los 12 s de la charla.
// (Recuperada el 13-nov: el deploy de ese día la había pisado en class25B.)
seccion("11 · Ollama cargado 60 min + precalentar al abrir el chat");
reiniciar(); modo = "ok";
{
  chequear("keep_alive por defecto 60m (era 5m)", LLM.metricas().keep_alive === "60m",
    `keep_alive=${LLM.metricas().keep_alive}`);
  await LLM.conversar({ mensajes: [{ rol: "user", texto: "hola" }], maxTokens: 20 });
  chequear("cada pedido manda keep_alive 60m (pisa al del servicio)", visto.ultimoCuerpo?.keep_alive === "60m");

  reiniciar(); modo = "ok";
  const llamadas0 = LLM.metricas().llamadas;
  chequear("precalentar arranca", LLM.precalentar() === true);
  await new Promise(r => setTimeout(r, 150));
  const c = visto.ultimoCuerpo || {};
  chequear("precalentar va a /api/generate SIN prompt (sólo carga)", visto.generate === 1 && !("prompt" in c),
    `generate=${visto.generate}`);
  chequear("y con keep_alive 60m", c.keep_alive === "60m");
  chequear("no cuenta como llamada ni toca el breaker", LLM.metricas().llamadas === llamadas0 && !LLM.cortado());
  chequear("a lo sumo uno cada 4 min", LLM.precalentar() === false && visto.generate === 1);
  // 8-nov: si el num_ctx del precalentado no es el del chat, Ollama recarga el modelo
  // en la primera charla (~12 s en frío) y la charla corta: el precalentado no sirve.
  const ctxPre = c.options?.num_ctx;
  await LLM.conversar({ mensajes: [{ rol: "user", texto: "hola" }], maxTokens: 20 });
  const ctxChat = visto.ultimoCuerpo?.options?.num_ctx;
  chequear("y con el MISMO num_ctx que el chat (si no, Ollama recarga el modelo)",
    Number.isFinite(ctxPre) && ctxPre === ctxChat, `precalentar=${ctxPre} chat=${ctxChat}`);

  reiniciar(); modo = "ok";
  for (let i = 0; i < LLM._test.FALLOS_PARA_CORTAR; i++) LLM._test.marcarFallo("x");
  chequear("con el cortacircuitos abierto no precalienta", LLM.precalentar() === false && visto.generate === 0);
  reiniciar();

  const c25 = fs.readFileSync(path.join(RAIZ, "scripts/class25B.js"), "utf8");
  chequear("class25B precalienta al entrar al router del chat",
    /async function _chatConRouter[\s\S]{0,600}LLM\.precalentar\(\)/.test(c25));
  chequear("y se apaga sin recompilar (MIIA_LLM_PRECALENTAR=0)", c25.includes('process.env.MIIA_LLM_PRECALENTAR ?? "1"'));
}

servidor.close();
console.log(`\n${falla === 0 ? "PASA" : "FALLA"} — motor local + guarda de Redis  (${ok + falla} checks, ${falla} fallas)`);
process.exit(falla ? 1 : 0);
