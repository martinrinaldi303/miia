/**
 * llm_local.js — cliente de Ollama: el motor de lenguaje LOCAL de MIIA.
 *
 * Vive aparte de class25B por el mismo motivo que `cola_acotada.js` y
 * `seguridad_red.js` viven aparte de class30: importar class25B arrastra MySQL,
 * Redis y el SDK de Google, así que la lógica metida ahí adentro no se puede
 * probar. Acá no hay nada que importar más que `node:http`.
 *
 * POR QUÉ `node:http` Y NO `fetch`
 * --------------------------------
 * `fetch` es global desde Node 18. No sabemos con qué Node corre el server y
 * un `ReferenceError: fetch is not defined` dentro de class25B lo dejaría sin
 * redactor — es el modo de fallar del `ModuleNotFoundError` del 28-sep, con
 * otra cara. `node:http` existe desde siempre, habla con localhost igual, y
 * deja poner un timeout DURO (abortando el socket), que `fetch` sin
 * AbortController no da. Cero dependencias nuevas: no hay `npm install` en
 * producción.
 *
 * POR QUÉ UN CORTACIRCUITOS PROPIO
 * --------------------------------
 * Ollama descarga el modelo de RAM cuando pasa `keep_alive` sin pedidos, así
 * que la PRIMERA llamada después de un rato tarda segundos en cargarlo. Sin un
 * breaker, un Ollama caído haría que cada mensaje del chat espere el timeout
 * completo antes de caer al respaldo. Con breaker, el primer fallo cuesta el
 * timeout y los siguientes son instantáneos.
 *
 * LO QUE ESTE MÓDULO NO HACE
 * --------------------------
 * No decide nada. class25B es la única que elige entre local, Gemini y el
 * redactor interno (ver MIIA_LLM allá). Acá sólo se habla con Ollama.
 */
import http from "node:http";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 26-nov-2026: el MODELO se lee también del .env, para cambiarlo reiniciando sólo
// class25B. El orquestador le pasa a cada hijo un snapshot del entorno de cuando
// arrancó, así que poner MIIA_LLM_MODELO en el .env no llegaba sin reiniciar el
// orquestador (que corta la medición). Lo de la línea de comando sigue mandando.
try {
  const _env = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "operador", "aprendizaje", "config", ".env");
  for (const _l of fs.readFileSync(_env, "utf8").split(/\r?\n/)) {
    const _m = _l.match(/^\s*MIIA_LLM_MODELO\s*=\s*(.*)$/);
    if (_m && _m[1].split(" #")[0].trim()) process.env.MIIA_LLM_MODELO = _m[1].split(" #")[0].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* sin .env: queda lo del entorno o el default */ }

// ── Configuración ──────────────────────────────────────────────────────────
// 127.0.0.1 a propósito, y no `localhost`: en el server `localhost` resuelve
// primero a ::1 y si Ollama escucha sólo en IPv4 el pedido falla con ECONNREFUSED
// — es la misma trampa del HSTS en [::1] del 26-sep.
const URL_BASE = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

/** El modelo. Ver «Por qué gemma2:2b» en CLAUDE.md antes de cambiarlo. */
export const MODELO = process.env.MIIA_LLM_MODELO || "gemma2:2b";

/** Timeout duro por pedido. Generoso: la primera llamada incluye cargar el
 *  modelo del disco (~1,6 GB), que en este server son varios segundos. */
// 18 s, no 45. El chat entra por /api/ask de miia_chatbot.py, que ESPERA 22 s
// y despues se rinde: una respuesta que llega a los 31 s la pagina ya la
// descarta (marco la respuesta como mostrada) y el usuario se queda con el
// cartel de "procesando" para siempre. Paso el 11-oct-2026. Un timeout mas
// largo que el presupuesto de quien espera no es tolerancia: es trabajo que
// nadie recoge, y encima se come el tiempo que quedaba para el respaldo.
const TIMEOUT_MS = Number(process.env.MIIA_LLM_TIMEOUT_MS || 18_000);

/** Cuánto deja Ollama el modelo en RAM sin pedidos.
 *  Era "5m" (en reposo el costo de RAM era cero). Pasó a "60m" el 8-nov-2026,
 *  decidido por Martín: con 5 min la charla casi siempre encontraba el modelo
 *  DESCARGADO, y cuando Gemini daba 503 (pasó 5 veces el 7-nov) Ollama no llegaba
 *  a cargar y contestar en los 12 s de la charla → salía el respaldo «no me salió
 *  una respuesta a la altura». El costo: ~1,8 GB de RAM mientras haya uso del chat
 *  en la última hora; de noche se descarga solo. Lo manda CADA pedido, así que
 *  pisa al OLLAMA_KEEP_ALIVE del servicio. Reversa: MIIA_LLM_KEEPALIVE=5m. */
const KEEP_ALIVE = process.env.MIIA_LLM_KEEPALIVE || "60m";

/** Ventana de contexto. Cada token de contexto cuesta KV cache, o sea RAM.
 *  2048 alcanza para el prompt del asesor más 3-4 turnos de chat. */
const NUM_CTX = Number(process.env.MIIA_LLM_CTX || 2048);

// ── Cortacircuitos ─────────────────────────────────────────────────────────
const FALLOS_PARA_CORTAR = 3;
const CORTE_BASE_MS = 5 * 60_000;
const CORTE_MAX_MS = 30 * 60_000;

let _fallosSeguidos = 0;
let _cortadoHasta = 0;
let _corteMs = CORTE_BASE_MS;

const _m = {
  llamadas: 0, ok: 0, fallos: 0, cortes: 0,
  ms_total: 0, tokens: 0, ultimo_error: "", ultimo_ms: 0, tps: 0,
};

function _exito(ms, tokens, evalNs = 0) {
  _fallosSeguidos = 0;
  _corteMs = CORTE_BASE_MS;
  _m.ok++; _m.ms_total += ms; _m.ultimo_ms = ms;
  if (tokens > 0) {
    _m.tokens += tokens;
    // La tasa sale de `eval_duration`, que es lo que Ollama tardo GENERANDO.
    // Con el reloj de pared el numero sale inflado cuando el modelo ya estaba
    // cargado y hundido cuando hubo que leerlo del disco: dos cosas distintas
    // en la misma cifra. `ms` queda aparte y es la latencia que el usuario
    // espera de verdad.
    const seg = evalNs > 0 ? evalNs / 1e9 : ms / 1000;
    _m.tps = seg > 0 ? +(tokens / seg).toFixed(1) : 0;
  }
}

function _fallo(msg) {
  _fallosSeguidos++;
  _m.fallos++;
  _m.ultimo_error = String(msg || "").slice(0, 160);
  if (_fallosSeguidos >= FALLOS_PARA_CORTAR) {
    _cortadoHasta = Date.now() + _corteMs;
    _m.cortes++;
    _corteMs = Math.min(_corteMs * 2, CORTE_MAX_MS);
    _fallosSeguidos = 0;
  }
}

/** ¿El cortacircuitos está abierto? */
export function cortado() {
  return Date.now() < _cortadoHasta;
}

/** Minutos que faltan para reintentar, 0 si no está cortado. */
export function cortadoMin() {
  return cortado() ? Math.ceil((_cortadoHasta - Date.now()) / 60_000) : 0;
}

// ── Transporte ─────────────────────────────────────────────────────────────
function pedir(ruta, cuerpo, timeoutMs = TIMEOUT_MS, signal = undefined) {
  return new Promise((resolve, reject) => {
    // 26-nov-2026: cancelable. Cerrar el socket hace que Ollama deje de generar.
    if (signal?.aborted) { const e = new Error("cancelado"); e.name = "AbortError"; return reject(e); }
    let u;
    try { u = new URL(ruta, URL_BASE); } catch (e) { return reject(new Error(`URL invalida: ${e.message}`)); }
    const datos = cuerpo == null ? null : Buffer.from(JSON.stringify(cuerpo), "utf8");

    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: cuerpo == null ? "GET" : "POST",
      headers: datos
        ? { "Content-Type": "application/json", "Content-Length": datos.length }
        : {},
    }, res => {
      const trozos = [];
      res.on("data", d => trozos.push(d));
      res.on("end", () => {
        const txt = Buffer.concat(trozos).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(txt)); }
        catch { reject(new Error(`respuesta no es JSON: ${txt.slice(0, 120)}`)); }
      });
    });

    // El timeout de `http` sólo dispara el evento: hay que destruir el socket
    // a mano o el pedido queda colgado y con él el turno del chat.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs} ms`)));
    req.on("error", e => reject(e));
    if (signal) signal.addEventListener("abort", () => {
      const e = new Error("cancelado"); e.name = "AbortError"; req.destroy(e);
    }, { once: true });
    if (datos) req.write(datos);
    req.end();
  });
}

// ── Disponibilidad ─────────────────────────────────────────────────────────
let _dispCache = { ts: 0, ok: false, modelos: [] };
const DISP_TTL_MS = 30_000;

/**
 * ¿Ollama responde y tiene el modelo descargado?
 *
 * Se cachea 30 s: lo llama el router en cada mensaje del chat y un `/api/tags`
 * por mensaje es gasto al aire. Con `forzar` se saltea la caché (el arranque).
 */
export async function disponible(forzar = false) {
  if (!forzar && Date.now() - _dispCache.ts < DISP_TTL_MS) return _dispCache.ok;
  try {
    const r = await pedir("/api/tags", null, 4000);
    const modelos = (r?.models || []).map(m => String(m.name || ""));
    // Ollama devuelve "gemma2:2b"; si alguien configuró "gemma2" sin tag,
    // igual tiene que reconocerlo.
    const base = MODELO.split(":")[0];
    const ok = modelos.some(n => n === MODELO || n.split(":")[0] === base);
    _dispCache = { ts: Date.now(), ok, modelos };
    return ok;
  } catch {
    _dispCache = { ts: Date.now(), ok: false, modelos: [] };
    return false;
  }
}

/** Los modelos que Ollama tiene bajados (de la última comprobación). */
export function modelosVistos() { return [..._dispCache.modelos]; }

// ── Generación ─────────────────────────────────────────────────────────────
function _opciones({ maxTokens, temperatura }) {
  return {
    num_predict: Number(maxTokens || 700),
    temperature: Number(temperatura ?? 0.7),
    num_ctx: NUM_CTX,
    // Sin esto el modelo entra en bucles de repetición, que en un 2B es
    // bastante común y en una respuesta al usuario se ve muy mal.
    repeat_penalty: 1.15,
  };
}

function _evalNs(r) {
  const n = Number(r?.eval_duration || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _tokens(r) {
  const n = Number(r?.eval_count || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Una sola vuelta: system + prompt → texto.
 * Devuelve `{ texto, ms, tokens, tps, modelo }`. Tira si falla.
 */
export async function generar({ prompt, system = "", maxTokens, temperatura, timeoutMs } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("prompt vacio");
  if (cortado()) throw new Error(`cortacircuitos abierto (${cortadoMin()} min)`);

  _m.llamadas++;
  const t0 = Date.now();
  try {
    const r = await pedir("/api/generate", {
      model: MODELO,
      prompt: String(prompt),
      ...(system ? { system: String(system) } : {}),
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: _opciones({ maxTokens, temperatura }),
    }, timeoutMs);

    const texto = String(r?.response || "").trim();
    if (!texto) throw new Error("respuesta vacia");
    const ms = Date.now() - t0;
    const tk = _tokens(r);
    _exito(ms, tk, _evalNs(r));
    return { texto, ms, tokens: tk, tps: _m.tps, modelo: MODELO };
  } catch (e) {
    _fallo(e.message);
    throw e;
  }
}

/**
 * Conversación con historial: `mensajes` es [{rol, texto}] con rol
 * "system" | "user" | "assistant".
 *
 * Va por `/api/chat` y no por `/api/generate` porque Ollama aplica solo la
 * plantilla de turnos del modelo. Armarla a mano —como hay que hacer con
 * Gemini, que exige alternancia estricta user/model— es justamente de donde
 * salen los prompts mal formados.
 */
export async function conversar({ mensajes, maxTokens, temperatura, timeoutMs, signal } = {}) {
  const msgs = (mensajes || [])
    .filter(m => m && m.texto && String(m.texto).trim())
    .map(m => ({
      role: ["system", "user", "assistant"].includes(m.rol) ? m.rol : "user",
      content: String(m.texto),
    }));
  if (!msgs.length) throw new Error("sin mensajes");
  if (cortado()) throw new Error(`cortacircuitos abierto (${cortadoMin()} min)`);

  _m.llamadas++;
  const t0 = Date.now();
  try {
    const r = await pedir("/api/chat", {
      model: MODELO,
      messages: msgs,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: _opciones({ maxTokens, temperatura }),
    }, timeoutMs, signal);

    const texto = String(r?.message?.content || "").trim();
    if (!texto) throw new Error("respuesta vacia");
    const ms = Date.now() - t0;
    const tk = _tokens(r);
    _exito(ms, tk, _evalNs(r));
    return { texto, ms, tokens: tk, tps: _m.tps, modelo: MODELO };
  } catch (e) {
    if (e?.name !== "AbortError") _fallo(e.message);   // cancelar no es fallar
    throw e;
  }
}

// ── Precalentar (8-nov-2026) ─────────────────────────────────────────────
// El primer mensaje de una conversación («Hola MIIA») lo contesta el router sin
// motor, así que la pregunta siguiente pagaba la carga del modelo del disco
// (~1,6 GB) DENTRO de los 12 s de la charla. Un pedido sin prompt a
// /api/generate hace que Ollama sólo cargue el modelo y lo deje vivo KEEP_ALIVE.
// Va fuera del cortacircuitos y de las métricas: no es una respuesta al usuario.
// A lo sumo uno cada 4 min (con KEEP_ALIVE de 60 m alcanza y sobra).
const PRECALENTAR_CADA_MS = 4 * 60_000;
let _ultimoPrecalentar = 0;
export function precalentar() {
  if (cortado() || Date.now() - _ultimoPrecalentar < PRECALENTAR_CADA_MS) return false;
  _ultimoPrecalentar = Date.now();
  // Con el MISMO num_ctx que manda conversar(): si no coincide, Ollama tiene que
  // recargar el modelo en el primer chat. Pasó el 7-nov (23:22 ART): el precalentado
  // cargaba con el contexto por defecto (4096), la charla pedía 2048, Ollama
  // recargaba del disco (~12 s), la charla cortaba a los 12 s y la carga se abortaba.
  pedir("/api/generate", { model: MODELO, keep_alive: KEEP_ALIVE, stream: false,
                           options: { num_ctx: NUM_CTX } }, 60_000)
    .catch(() => { _ultimoPrecalentar = 0; });   // si falló, el próximo mensaje reintenta
  return true;
}

/** Métricas para el heartbeat de class25B. */
export function metricas() {
  return {
    ...(_m),
    modelo: MODELO,
    url: URL_BASE,
    keep_alive: KEEP_ALIVE,
    num_ctx: NUM_CTX,
    ms_medio: _m.ok ? Math.round(_m.ms_total / _m.ok) : 0,
    cortado: cortado(),
    corte_min: cortadoMin(),
  };
}

/** Una línea para el log. */
export function resumen() {
  const m = metricas();
  return `llm_local: modelo=${m.modelo} llamadas=${m.llamadas} ok=${m.ok} `
       + `fallos=${m.fallos} ms_medio=${m.ms_medio} tps=${m.tps}`
       + (m.cortado ? ` CORTADO(${m.corte_min}min)` : "")
       + (m.ultimo_error ? ` ultimo_error="${m.ultimo_error}"` : "");
}

/** Sólo para las pruebas: reinicia contadores y breaker. */
export const _test = {
  reset() {
    _fallosSeguidos = 0; _cortadoHasta = 0; _corteMs = CORTE_BASE_MS;
    _dispCache = { ts: 0, ok: false, modelos: [] };
    _ultimoPrecalentar = 0;
    Object.assign(_m, { llamadas: 0, ok: 0, fallos: 0, cortes: 0, ms_total: 0, tokens: 0, ultimo_error: "", ultimo_ms: 0, tps: 0 });
  },
  marcarFallo: _fallo,
  marcarExito: _exito,
  FALLOS_PARA_CORTAR,
  URL_BASE,
};
