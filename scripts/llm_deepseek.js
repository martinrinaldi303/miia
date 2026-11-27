/**
 * llm_deepseek.js — cliente de DeepSeek, tercer motor de la CHARLA (26-nov-2026).
 *
 * Por qué existe: el Gemini gratis da 503 («alta demanda») y 429 (cuota) seguido
 * —el 26-nov los tres modelos flash dieron 503 a la vez— y Ollama en este server
 * no siempre entra en los 20 s. DeepSeek es pago por uso y habla el formato de
 * OpenAI (`/chat/completions`), así que alcanza con `node:https`: cero
 * dependencias nuevas, nada de `npm install` en producción.
 *
 * Lo que NO hace: decidir. class25B elige el orden de los motores y valida lo
 * que vuelve con el mismo validador que a Gemini y a Ollama. Sólo se usa en la
 * charla (y en la reescritura de respuestas), nunca en las decisiones.
 *
 * Variables (en el .env; class25B las relee del archivo al arrancar):
 *   CLASS25B_DEEPSEEK=1         lo prende (por defecto apagado)
 *   DEEPSEEK_API_KEY=...        la clave (NUNCA en el código ni en el chat)
 *   DEEPSEEK_MODEL=deepseek-chat
 *   DEEPSEEK_URL=https://api.deepseek.com
 *   DEEPSEEK_TIMEOUT_MS=12000
 */
import https from "node:https";
import http  from "node:http";   // sólo para las pruebas contra un servidor local

const cfg = () => ({
  activo:  String(process.env.CLASS25B_DEEPSEEK || "0") === "1",
  clave:   String(process.env.DEEPSEEK_API_KEY || "").trim(),
  modelo:  process.env.DEEPSEEK_MODEL || "deepseek-chat",
  base:    (process.env.DEEPSEEK_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  timeout: Number(process.env.DEEPSEEK_TIMEOUT_MS || 12_000),
});

// ── Estado y cortacircuitos ────────────────────────────────────────────────
// 3 fallos seguidos → pausa 5 min, duplicando hasta 30. Una clave rechazada
// (401) o sin saldo (402) pausa 60 min: reintentar en cada mensaje no lo arregla.
const st = { llamadas: 0, ok: 0, fallos: 0, seguidos: 0, pausaHasta: 0, pausaMs: 5 * 60_000,
             msTotal: 0, ultimoError: "" };

export function disponible() {
  const c = cfg();
  return c.activo && c.clave.length >= 10 && Date.now() >= st.pausaHasta;
}

function _falla(msg, codigo = 0) {
  st.fallos++; st.seguidos++; st.ultimoError = String(msg).slice(0, 120);
  if (codigo === 401 || codigo === 402) {
    st.pausaHasta = Date.now() + 60 * 60_000;
  } else if (st.seguidos >= 3) {
    st.pausaHasta = Date.now() + st.pausaMs;
    st.pausaMs = Math.min(st.pausaMs * 2, 30 * 60_000);
    st.seguidos = 0;
  }
}

export function resumen() {
  const c = cfg();
  const pausa = Date.now() < st.pausaHasta ? ` pausado ${Math.ceil((st.pausaHasta - Date.now()) / 60_000)} min` : "";
  return `deepseek: activo=${c.activo ? "SI" : "NO"} clave=${c.clave ? c.clave.length + "c" : "no"} modelo=${c.modelo}`
    + ` llamadas=${st.llamadas} ok=${st.ok} fallos=${st.fallos}`
    + ` ms_medio=${st.ok ? Math.round(st.msTotal / st.ok) : 0}${pausa}`
    + (st.ultimoError ? ` ultimo_error="${st.ultimoError}"` : "");
}

/**
 * mensajes: [{rol: "system"|"user"|"assistant", texto}]
 * Devuelve { texto, ms, modelo }. Tira Error en cualquier falla (AbortError si
 * se canceló desde afuera: eso NO cuenta como falla del motor).
 */
export function conversar({ mensajes, maxTokens = 300, temperatura = 0.8, timeoutMs, signal } = {}) {
  const c = cfg();
  if (!c.activo || c.clave.length < 10) return Promise.reject(new Error("deepseek apagado o sin clave"));
  const tope = Number(timeoutMs || c.timeout);
  const cuerpo = JSON.stringify({
    model: c.modelo,
    messages: (mensajes || []).map(m => ({
      role: m.rol === "system" ? "system" : m.rol === "assistant" ? "assistant" : "user",
      content: String(m.texto || ""),
    })),
    max_tokens: maxTokens,
    temperature: temperatura,
    stream: false,
  });
  st.llamadas++;
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    let terminado = false;
    const fin = (err, val) => {
      if (terminado) return; terminado = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", alAbortar);
      if (err) {
        if (err.name !== "AbortError") _falla(err.message, err.codigo || 0);
        reject(err);
      } else {
        st.ok++; st.seguidos = 0; st.pausaMs = 5 * 60_000; st.msTotal += val.ms;
        resolve(val);
      }
    };
    const url = new URL(c.base + "/chat/completions");
    const req = (url.protocol === "http:" ? http : https).request({
      hostname: url.hostname, port: url.port || (url.protocol === "http:" ? 80 : 443), path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${c.clave}`,
                 "Content-Length": Buffer.byteLength(cuerpo) },
    }, res => {
      let datos = "";
      res.setEncoding("utf8");
      res.on("data", d => { datos += d; if (datos.length > 2_000_000) req.destroy(); });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          const e = new Error(`HTTP ${res.statusCode}: ${datos.slice(0, 100)}`); e.codigo = res.statusCode;
          return fin(e);
        }
        try {
          const j = JSON.parse(datos);
          const texto = String(j?.choices?.[0]?.message?.content || "").trim();
          fin(null, { texto, ms: Date.now() - t0, modelo: j?.model || c.modelo });
        } catch (e) { fin(new Error(`respuesta inválida: ${e.message}`)); }
      });
    });
    const timer = setTimeout(() => { fin(new Error(`timeout ${tope} ms`)); req.destroy(); }, tope);
    const alAbortar = () => {
      const e = new Error("cancelado"); e.name = "AbortError";
      fin(e); req.destroy();
    };
    if (signal) {
      if (signal.aborted) return alAbortar();
      signal.addEventListener("abort", alAbortar, { once: true });
    }
    req.on("error", e => fin(e));
    req.write(cuerpo);
    req.end();
  });
}

export const _test = { st, cfg };
