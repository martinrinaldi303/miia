// ============================================================
// class25B.js — Motor Lingüístico MIIA v2.0
// ============================================================
// ROL: Cerebro lingüístico. Depende de class25A para los números.
//      class25A decide qué, class25B decide CÓMO y aprende de las DOS fuentes.
//
// ENTRADAS:
//   class25a_output  — decisión estructurada + texto numérico de class25A
//   class25a_output  — señal cuantitativa de class25A (única fuente de decisión)
//   class43_feedback — outcomes reales para aprendizaje dual
//   class25_ingest   — input humano directo (solo humanos)
//
// SALIDA: class25_output
//   Decisión final enriquecida con razonamiento lingüístico
//
// APRENDIZAJE DUAL:
//   Fuente 1: outcome numérico de class43 (acertó/falló)
//             → ajusta peso de patrones lingüísticos exitosos
//   Fuente 2: documentos de class3 (crisis históricas, política monetaria)
//             → detecta analogías con condiciones actuales
//
// DIFERENCIA con class25 original:
//   - Ya NO decide en base a números (eso lo hace class25A en C++)
//   - SÍ razona lingüísticamente sobre el texto que class25A genera
//   - SÍ aprende qué patrones de redacción correlacionan con aciertos
//   - SÍ busca analogías en documentos históricos
// ============================================================

import fs   from "node:fs";
import fsp  from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import natural from "natural";
import jwt     from "jsonwebtoken";
import {
  guardarDecision,
  guardarBacktestingRun,
  guardarCausal,
  guardarSeñalFeed,
  obtenerUltimoPortfolio,
  obtenerHistorialPortfolios,
  query as sqlQuery,
  dbQuery,
} from "./class42.js";
// Google Gemini — maestro lingüístico (plan: 18 meses aprendiendo, luego reemplazado por vocabulario propio)
import { GoogleGenerativeAI } from "@google/generative-ai";
// Motor de lenguaje LOCAL (Ollama). Modulo propio y sin dependencias para
// poder probarlo sin levantar class25B. Ver scripts/llm_local.js.
import * as LLM from "./llm_local.js";
import { getStorageConfig, getLoggingConfig, getConfig } from "./class38.js";
// FUENTE ÚNICA del universo (21-sep-2026). Ver scripts/universo.js.
import { TICKERS, TICKERS_TEXTO, INSTRUMENTOS } from "./universo.js";
import { glosarioLocal } from "./glosario.js";
// Router de intenciones del chat (punto 10 del reporte del 2-nov-2026). Tres
// módulos PUROS —sin Redis ni MySQL— para poder probarlos en frío (sim35):
// qué se pregunta, con qué evidencia del sistema se contesta, y cómo se redacta
// sin plantillas fijas. Son imports DUROS: el deploy los instala ANTES que este
// archivo y prueba que resuelvan en el server (deploy_arreglo_chat.sh, paso 3).
import { clasificar as chatClasificar, detectarNombre as chatDetectarNombre } from "./chat_router.js";
import { armarPanel, evidencia as chatEvidencia, validarRespuesta, estadoNYSE } from "./chat_evidencia.js";
import { redactar as chatRedactar, redactarPortfolio, promptCharla, firmaCharla } from "./chat_redactor.js";
import { normalizarPortfolio, evaluarPortfolio, redactarMiPortfolio, veredictoPortfolio } from "./chat_portfolio.js";
import { normalizarEntrada as portsNormalizarEntrada, slot as portsSlot, agregar as portsAgregar, reemplazar as portsReemplazar,
         actualizarActivo as portsActualizarActivo, activar as portsActivar, borrar as portsBorrar, activoDe as portsActivo,
         resumen as portsResumen, entenderComando as portsComando, elegirReemplazo as portsElegirReemplazo,
         hablaDeCarteras as portsHablaDeCarteras, textoLista as portsTextoLista, textoPedirReemplazo as portsTextoPedirReemplazo,
         textoActivado as portsTextoActivado, textoBorrado as portsTextoBorrado, textoNoExiste as portsTextoNoExiste } from "./chat_portafolios.js";
import { decidir as decidirCartera, extraerCapital, armarCartera, redactarCartera, preguntarPerfil,
         repreguntar as repreguntarPerfil, entender as entenderPerfilCapital } from "./chat_perfil.js";
// Armado automático (IA) o manual, y el plazo/umbral de cada usuario (13-nov-2026).
import { decidirArmado, preguntarModo, preguntarActivos, preguntarPlazo, confirmarConfig,
         umbralesPara, normalizarConfig } from "./chat_armado.js";

// Mapa ticker→{sector,region} para el glosario del redactor local, desde la
// fuente única. Se arma una vez al cargar; la lógica pura vive en glosario.js.
const _GLOSARIO_TICKER = Object.fromEntries(
  (INSTRUMENTOS || []).map(i => [String(i.ticker).toUpperCase(),
                                 { sector: i.sector, region: i.region }]));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ─────────────────────────────────────────────
const BASE_DIR    = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR    = path.join(BASE_DIR, "logs");
const STATE_DIR   = path.join(BASE_DIR, "state");
const MEMORIA_DIR = path.join(BASE_DIR, "memoria");

for (const d of [LOGS_DIR, STATE_DIR, MEMORIA_DIR])
  await fsp.mkdir(d, { recursive: true }).catch(() => {});

// ── Logger ───────────────────────────────────────────────────
const LOG_FILE = path.join(LOGS_DIR, "class25B.log");
function log(msg, tipo = "info") {
  const line = `[${new Date().toISOString()}] [class25B/${tipo.toUpperCase()}] ${msg}`;
  console[tipo === "error" ? "error" : tipo === "warn" ? "warn" : "log"](line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Redis ────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const redisSub  = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const redisPub  = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redisSub.on("connect", () => log("Redis SUB conectado"));
redisPub.on("connect", () => log("Redis PUB conectado"));
redisSub.on("error",   e  => log(`Redis SUB: ${e.message}`, "warn"));

// redisBroadcast: cliente Redis auxiliar para operaciones futuras de monitoreo
// (ya no se usa para WS — Python chatbot maneja todo el broadcast al browser)
const redisBroadcast = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redisBroadcast.on("error", e => log(`Redis BC: ${e.message}`, "warn"));

// ── Canales ──────────────────────────────────────────────────
const CH_IN_A      = "class25a_output";    // de class25A — única fuente de señal cuantitativa
const CH_IN_HUMAN  = "class25_ingest";     // input humano directo
const CH_IN_FB     = "class43_feedback";   // outcomes reales para aprendizaje
const CH_OUT       = "class25_output";     // salida final
const CH_UI        = "ui_stream";
const CH_FEEDBACK_A= "class25a_feedback";  // feedback a class25A

// ── Gate de convicción del SELL (nivel ensemble) ─────────────
// Calibrado con la curva de fiabilidad (sell_reliability_curve.py) sobre los
// SELL verificados de GENERAL: por debajo de este umbral el SELL del ensemble
// rinde <50% (destruye edge); a partir de UMBRAL_SELL_CONF la precisión sube
// fuerte. Un SELL de baja convicción se SUPRIME → no se emite (ni a
// class25_output, ni al UI, ni a MySQL), igual que el HOLD por ruido.
//
// ── APAGADO el 13-sep-2026 ─────────────────────────────────────────────────────
// Decisión de Martín, rompiendo a conciencia el congelamiento de 30 días para este
// único cambio.
//
// El 0,70 se calibró sobre SELL de GENERAL con etiqueta ABSOLUTA y la regla vieja de
// class25A. Con la decisión en z (12-sep) las distancias al neutro se achicaron y
// `confianza = 0,5 + |distancia|` casi nunca llega a 0,70. SELL frenadas por día,
// medido en cognitive_decisions: jue 10-sep 0,7 % · vie 11-sep 6 % · sáb 12-sep 94 %.
// El sábado se publicaron 602 BUY contra 18 SELL.
//
// Lo que costaba dejarlo prendido:
//   1. Lo publicado (panel, class43, tesis) quedaba 97 % BUY. El endpoint calcula el
//      baseline sobre las mismas filas, así que edge <= min(BUY,SELL)/total: ~3 pp
//      aunque acierte todas, contra una banda de ruido de ±6,5.
//   2. Las SELL frenadas se guardaban 'shadow' y sin hash_condicion, y class43 excluye
//      las shadow del feedback: las redes aprendían SÓLO de las BUY.
//   3. El usuario veía nada más que COMPRA.
//
// La premisa del gate ("con confianza < 0,70 una SELL acierta menos del 50 %") se
// sigue pudiendo medir SIN el gate, porque la confianza queda guardada en cada fila:
//   SELECT confianza < 0.70 AS baja, COUNT(*), AVG(outcome_real='correcto')
//   FROM cognitive_decisions
//   WHERE senal='SELL' AND label_modo='relativo'
//     AND outcome_real IN ('correcto','incorrecto') AND ts_decision >= <deploy>
//   GROUP BY baja;
// Si las de baja confianza aciertan claramente menos, el gate vuelve, recalibrado para
// la escala nueva y aplicado a los DOS lados. Revertir: poner true y desplegar con
// scripts/deploy_class25b.sh (quirúrgico, no toca class25A).
const GATE_SELL_ENSEMBLE = false;  // activar/desactivar el gate
const UMBRAL_SELL_CONF   = 0.70;   // confianza mínima del ensemble para emitir SELL
// ── Modo SOMBRA ──────────────────────────────────────────────
// El SELL suprimido igual se REGISTRA (temperatura='shadow') para que class43 lo
// verifique en su loop de reconciliación, sin emitirlo a ningún consumidor. Sirve
// para dos cosas: (1) mantener el volumen de datos que hace falta para medir el
// edge — el gate corta ~70% de los SELL y frenaría la propia medición; (2) eliminar
// el sesgo de censura: seguimos viendo qué habría hecho lo que suprimimos, así el
// umbral puede BAJAR con evidencia, no sólo subir. Excluido de las métricas vivas.
const GATE_SELL_SHADOW   = true;
// ── SOMBRA-HOLD: SELL bajista que el ENSEMBLE esconde en HOLD ─────
// class25A decide con umbral de UN SOLO LADO (score_final >= umbral): un bajista
// FUERTE (score_final bajo) cae en HOLD en vez de SELL → los mejores SELL nunca
// se emiten. SIN cambiar la decisión en vivo, se registra ese SELL oculto en
// sombra para medir si habría acertado. Hipótesis a validar; si rinde ~70%,
// justifica re-rutear la señal (recompilar class25A o override en class25B).
const SHADOW_HOLD_SELL    = true;   // registrar en sombra los SELL ocultos en HOLD
const HOLD_SELL_SCORE_MAX = 0.42;   // score_final por debajo = HOLD con sesgo bajista

// ── NLP (natural.js) ─────────────────────────────────────────
const tokenizer  = new natural.WordTokenizer();
const stemmer    = natural.PorterStemmer;
const TfIdf      = natural.TfIdf;

// ── Estado lingüístico ───────────────────────────────────────

// Memoria cognitiva: últimas N decisiones con su texto y outcome
let memoriaCognitiva = [];
// Cuántos HOLD consecutivos forzó el filtro de ruido. Se resetea al publicar una
// decisión real. Si este número crece sin parar, el filtro volvió a trabarse y
// el sistema dejó de registrar señales — es el síntoma que hay que vigilar.
let _ruidoForzados = 0;
const MAX_MEMORIA_COG = 50;

// Memoria causal: causa→efecto aprendidos de documentos y outcomes
let memoriaCausal = [];
const MAX_MEMORIA_CAUSAL = 200;

// Patrones lingüísticos: qué frases en el texto correlacionan con aciertos
//
// ESQUEMA v4 (2026-08-30) — contadores separados por FUENTE DE EVIDENCIA
// ─────────────────────────────────────────────────────────────────────
// El esquema v3 tenía { aciertos, total } y mezclaba tres poblaciones
// distintas en los mismos dos campos:
//   · `total` se incrementaba en CADA aparición del token, incluso cuando
//     la decisión nunca se verificó (outcome_real = NULL).
//   · `aciertos` solo subía con outcome_real='correcto'.
// O sea: "todavía no sabemos" quedaba contado como "se equivocó". Con 8.5%
// de cobertura del lazo, accuracy = aciertos/total ≈ accuracy_real × 0.085,
// y evaluarPatronesAprendidos() devolvía ≈ −0.92 para TODO patrón. No era
// un módulo que no aprendía: era un sesgo negativo constante sobre cada
// decisión. Medido: 9000 usos / 330 aciertos = 3.7% con 43% real.
//
// Ahora cada fuente tiene su propio contador y SOLO el mercado define
// accuracy:
//   usos          — frecuencia bruta (cuántas veces apareció el token)
//   verificados   — decisiones con outcome REAL de mercado (correcto|incorrecto)
//   aciertos      — de esas verificadas, cuántas acertaron
//   gemini_source — prior del LLM        → NO entra en accuracy
//   user_boost    — pulgar arriba humano → NO entra en accuracy
//
//   accuracy = aciertos / verificados     (nunca / usos)
//
// La ausencia de evidencia es NEUTRA, no negativa: con
// verificados < MIN_VERIFICADOS el patrón no vota (aporta 0).
let patronesLinguisticos = {};
const PATRONES_FILE = path.join(STATE_DIR, "class25b_patrones.json");
const MEMORIA_FILE  = path.join(STATE_DIR, "class25b_memoria.json");

// Versión del esquema de patrones. Un archivo con versión distinta se
// descarta y se reconstruye: los contadores v3 no son reparables hacia
// atrás (mezclan usos con verificaciones y fueron contados de más en cada
// arranque, porque la Fase 3 releía las mismas 300 filas sin marca de agua).
// v5 (30-ago-2026): sube de 4 a 5 para forzar UNA reconstrucción limpia.
// La tabla v4 que quedó en el server tiene los contadores inflados ~4×: se
// escribió con el bootstrap incondicional, que sumó las mismas 1500 decisiones
// en cada uno de los cuatro arranques de esa noche. Esa inflación no se puede
// separar hacia atrás —no hay registro de qué vino de qué pasada—, así que se
// descarta y se reconstruye desde cognitive_decisions.
//
// Con la Fase 3 ya condicional, la reconstrucción pasa una sola vez: el
// arranque siguiente encuentra la tabla poblada y omite el bootstrap.
const PATRONES_SCHEMA_VERSION = 5;

// Verificaciones de mercado necesarias antes de que un patrón pese en la
// decisión. Con 3 (el valor v3) alcanzaba una sola verificación afortunada
// para mover el refuerzo; el ruido dominaba la señal.
const MIN_VERIFICADOS = 10;

// Marca de agua: ts (ms) de la decisión verificada más nueva ya incorporada a
// la tabla. Evita que el bootstrap de cargarEstado() y el refresh periódico
// cuenten dos veces los mismos tokens en cada arranque.
let _patronesWatermark = 0;

// Forma canónica de una entrada de patrón. Centralizada para que los cinco
// escritores no vuelvan a divergir de esquema.
function _nuevoPatron() {
  return {
    usos: 0, verificados: 0, aciertos: 0,
    gemini_source: 0, user_boost: 0, db_source: 0,
  };
}

// Devuelve la entrada del patrón, creándola si no existe. Único punto de
// creación: si mañana se agrega un campo, se agrega acá y nada más.
function _patron(tok) {
  if (!patronesLinguisticos[tok]) patronesLinguisticos[tok] = _nuevoPatron();
  return patronesLinguisticos[tok];
}

// Cooldown entre decisiones
// Cooldown POR TICKER, no global. Antes era un único escalar: publicar una
// decisión de cualquier ticker bloqueaba a los otros 12 durante COOLDOWN_MS.
// Medido en producción (2026-07-29): 56 de 82 señales descartadas por cooldown
// (68%), y los SELL caían sistemáticamente después de un HOLD en la misma
// ráfaga → NUNCA llegaban al gate ni quedaban como sombra. Se perdían sin
// dejar rastro, y el dataset de entrenamiento se moría de hambre.
const LAST_DECISION_BY_TICKER = new Map();   // ticker → epoch ms
// Contadores de descarte para no volver a quedar ciegos (se loguean cada 50).
let _descartesCooldown = 0;
let _publicadas        = 0;

// La clave incluye la SEÑAL, no solo el ticker. Medido en producción: 1200 de
// 1201 decisiones llegan con ticker="class19" (las predicciones de dirección del
// ensemble, etiquetadas con el nombre del módulo). Con un solo ticker, un
// cooldown "por ticker" es idéntico al global: seguía descartando el 66%.
// Peor: el presupuesto se lo comían los HOLD (97% del volumen y los menos
// valiosos), bloqueando justo los BUY/SELL que necesitamos medir.
// Con ticker+señal cada tipo tiene su propio límite y un SELL no queda
// bloqueado por un HOLD que se publicó un segundo antes.
function _claveCooldown(ticker, senal) {
  return `${ticker || "GENERAL"}|${senal || "?"}`;
}

function _cooldownActivo(ticker, senal, now) {
  const prev = LAST_DECISION_BY_TICKER.get(_claveCooldown(ticker, senal)) || 0;
  return (now - prev) < COOLDOWN_MS ? (COOLDOWN_MS - (now - prev)) : 0;
}

function _marcarDecision(ticker, senal, now) {
  const k = _claveCooldown(ticker, senal);
  LAST_DECISION_BY_TICKER.set(k, now);
  // Purga defensiva: la clave es el ticker, así que el Map no debería pasar de
  // ~20 entradas. Si aparecen tickers custom del chat, acotarlo igual.
  if (LAST_DECISION_BY_TICKER.size > 200) {
    const viejo = [...LAST_DECISION_BY_TICKER.entries()]
      .sort((a, b) => a[1] - b[1])[0];
    if (viejo) LAST_DECISION_BY_TICKER.delete(viejo[0]);
  }
}
// Perfil del usuario actual (llegado de class14 via class14_output)
let perfilUsuarioActual  = null;
const COOLDOWN_MS    = 10_000; // FIX: era 45s — bajado a 10s

// ============================================================
// MOTOR DE ALERTAS DE MERCADO
// Detecta patrones de caída parcial, caída total y depresión
// independientemente del cooldown de decisiones.
// Publica alertas urgentes al usuario con explicación del porqué.
// ============================================================

// Historial de señales para detectar tendencias
const HISTORIAL_ALERTAS_MAX = 20;
let historialRiesgo     = [];  // últimos N valores de riesgo
let historialScores     = [];  // últimos N ensemble_scores
let historialSectores   = {};  // { sector: [change_pct últimos N] }
let historialSenales    = [];  // últimas N señales ("BUY","SELL","HOLD")
let alertasActivas      = [];  // alertas actualmente activas
let LAST_ALERTA_TS      = 0;
const COOLDOWN_ALERTA_MS = 120_000; // 2 min entre alertas (evitar spam)
const CH_ALERTAS         = "class25B_alerts";

// Niveles de alerta
const NIVELES = {
  INFO:    { emoji: "ℹ️",  color: "#3b82f6", prioridad: 0 },
  ATENCION:{ emoji: "⚠️",  color: "#f59e0b", prioridad: 1 },
  PELIGRO: { emoji: "🔴",  color: "#ef4444", prioridad: 2 },
  CRITICO: { emoji: "🚨",  color: "#7c3aed", prioridad: 3 },
};

// ── Detector de patrones de crisis ──────────────────────────

/**
 * analizarTendenciaRiesgo
 * Compara el riesgo actual vs el histórico.
 * Retorna: { tendencia, delta, velocidad }
 */
function analizarTendenciaRiesgo() {
  if (historialRiesgo.length < 3) return null;
  const ultimos = historialRiesgo.slice(-6);
  const primeros3 = ultimos.slice(0, 3).reduce((a,b)=>a+b,0) / 3;
  const ultimos3  = ultimos.slice(-3).reduce((a,b)=>a+b,0) / 3;
  const delta     = ultimos3 - primeros3;
  const velocidad = Math.abs(delta) / Math.max(1, ultimos.length);
  return {
    tendencia: delta > 0.05 ? "subiendo" : delta < -0.05 ? "bajando" : "estable",
    delta:     +delta.toFixed(3),
    velocidad: +velocidad.toFixed(3),
    actual:    historialRiesgo[historialRiesgo.length - 1],
    promedio:  +(ultimos.reduce((a,b)=>a+b,0) / ultimos.length).toFixed(3),
  };
}

/**
 * contarSenalesConsecutivas
 * Cuenta cuántas señales SELL o BUY seguidas hay al final.
 */
function contarSenalesConsecutivas(tipo) {
  let count = 0;
  for (let i = historialSenales.length - 1; i >= 0; i--) {
    if (historialSenales[i] === tipo) count++;
    else break;
  }
  return count;
}

/**
 * analizarSectoresAfectados
 * Detecta sectores con tendencia negativa sostenida.
 * Retorna lista de { sector, cambio_promedio, alertar }
 */
function analizarSectoresAfectados(señalA) {
  const sectoresNegativos = [];
  for (const [sector, cambios] of Object.entries(historialSectores)) {
    if (cambios.length < 2) continue;
    const promedio = cambios.reduce((a,b)=>a+b,0) / cambios.length;
    const ultimo   = cambios[cambios.length - 1];
    if (promedio < -1.5 || (ultimo < -3 && cambios.length >= 2)) {
      sectoresNegativos.push({
        sector,
        cambio_promedio: +promedio.toFixed(2),
        cambio_ultimo:   +ultimo.toFixed(2),
        alertar: promedio < -2 || ultimo < -4,
      });
    }
  }
  return sectoresNegativos.sort((a,b) => a.cambio_promedio - b.cambio_promedio);
}

/**
 * actualizarHistorialSectores — procesa datos de class7_output
 * y alimenta historialSectores con el cambio real de cada sector.
 * Esto es lo que permite detectar tendencias negativas por sector.
 */
function actualizarHistorialSectores(data) {
  try {
    const sectors = data?.sectors || data?.sector_state || [];
    if (!Array.isArray(sectors) || sectors.length === 0) return;

    for (const s of sectors) {
      const nombre = s.sector || s.name;
      const change  = parseFloat(s.change ?? s.change_pct ?? 0);
      if (!nombre || isNaN(change)) continue;

      if (!historialSectores[nombre]) historialSectores[nombre] = [];
      historialSectores[nombre].push(change);

      // Mantener ventana de 10 muestras por sector
      if (historialSectores[nombre].length > 10)
        historialSectores[nombre].shift();
    }
  } catch (e) {
    log(`actualizarHistorialSectores: ${e?.message}`, "warn");
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ALERTAS EN LENGUAJE NATURAL
// ══════════════════════════════════════════════════════════════════════════
// Los identificadores internos se estaban filtrando al chat. El camino era:
// `alertasActivas` guardaba solo {tipo, ts, nivel} —descartando `titulo`— y
// después el prompt de Gemini interpolaba `${a.tipo}` crudo. Gemini repetía el
// identificador tal cual y el usuario terminaba leyendo:
//
//   «"caída_sectorial" y "depresión_prolongada" son riesgos a monitorear»
//
// Este mapa es la traducción garantizada. Se aplica en TODO punto que termine
// frente al usuario, no solo en el que se detectó el síntoma.
const ALERTA_LEGIBLE = {
  caida_sectorial:      "un sector con caída sostenida",
  caida_parcial:        "varios sectores cayendo a la vez",
  caida_total:          "una caída generalizada del mercado",
  depresion_prolongada: "una caída que se extiende en el tiempo",
  recuperacion:         "señales de recuperación del mercado",
};

// Devuelve siempre algo mostrable, en este orden: el título humano si existe,
// si no la traducción del mapa, y como último recurso el identificador
// des-guionado. Nunca devuelve el crudo con guiones bajos.
function _alertaLegible(a = {}) {
  // Los títulos traen emojis ("⚠️ CRISIS DE MERCADO…") que no aportan dentro
  // de un prompt y ensucian el texto generado.
  const sinEmoji = (s) =>
    String(s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s{2,}/g, " ").trim();

  if (a.titulo) return sinEmoji(a.titulo);
  if (a.tipo && ALERTA_LEGIBLE[a.tipo]) return ALERTA_LEGIBLE[a.tipo];
  if (a.tipo) return sinEmoji(String(a.tipo).replace(/_/g, " "));
  return "una alerta de mercado";
}

// La memoria causal guarda las causas con el identificador de alerta como
// prefijo ("caida_sectorial: el sector bajó 3%"). Sirve para agrupar
// internamente, pero no se puede mostrar ni mandar a un prompt tal cual.
// Existe un limpiador equivalente más abajo, local a una rama; éste es de
// módulo para que TODA salida pueda usarlo.
function _causaLegible(raw = "") {
  const m = String(raw).match(/^([a-z_]+):\s*(.*)$/i);
  if (!m) return String(raw).trim();
  const [, id, resto] = m;
  const legible = ALERTA_LEGIBLE[id];
  return legible ? `${legible}: ${resto}`.trim() : resto.trim();
}

/**
 * detectarPatrones — Motor principal de detección.
 * Analiza los datos de class25A y el historial acumulado.
 * Retorna una lista de alertas detectadas (puede ser vacía).
 */
function detectarPatrones(señalA) {
  const alertas = [];

  const riesgo      = parseFloat(señalA.riesgo       || 0.5);
  const score       = parseFloat(señalA.ensemble_score || señalA.confianza || 0.5);
  const tendenciaR  = analizarTendenciaRiesgo();
  const sellConsec  = contarSenalesConsecutivas("SELL");
  const sectoresNeg = analizarSectoresAfectados(señalA);
  const crisis40    = señalA.crisis?.class40_disponible;
  const crisis41    = señalA.crisis?.class41_disponible;
  const mem         = señalA.memoria || {};

  // ── PATRÓN 1: CAÍDA SECTORIAL ─────────────────────────────
  // Un sector bajó más del 3% y hay señales de continuación
  const sectoresCriticos = sectoresNeg.filter(s => s.alertar);
  if (sectoresCriticos.length > 0) {
    const sector = sectoresCriticos[0];
    alertas.push({
      tipo:    "caida_sectorial",
      nivel:   Math.abs(sector.cambio_promedio) > 4 ? "PELIGRO" : "ATENCION",
      titulo:  `Caída detectada en ${sector.sector}`,
      razones: [
        `El sector ${sector.sector} acumula un cambio promedio de ${sector.cambio_promedio}% en las últimas señales.`,
        `Último registro: ${sector.cambio_ultimo >= 0 ? "+" : ""}${sector.cambio_ultimo}%.`,
        `Patrón de baja sostenida — no hay señales de rebote.`,
      ],
      sectores_afectados: sectoresCriticos.map(s => s.sector),
      recomendacion: "Evitar aumentar exposición en estos sectores hasta confirmar reversión.",
    });
  }

  // ── PATRÓN 2: CAÍDA PARCIAL DEL MERCADO ───────────────────
  // Riesgo > 0.65 Y 2+ sectores negativos Y score bajo
  if (riesgo > 0.65 && sectoresNeg.length >= 2 && score < 0.45) {
    const sectList = sectoresNeg.slice(0, 3).map(s => s.sector).join(", ");
    alertas.push({
      tipo:    "caida_parcial",
      nivel:   riesgo > 0.75 ? "PELIGRO" : "ATENCION",
      titulo:  "Caída parcial de mercado detectada",
      razones: [
        `Riesgo global en ${(riesgo*100).toFixed(0)}% — nivel ${riesgo > 0.75 ? "alto" : "moderado-alto"}.`,
        `${sectoresNeg.length} sectores muestran tendencia negativa: ${sectList}.`,
        `Score de ensemble en ${(score*100).toFixed(0)}% — por debajo del umbral saludable.`,
        sellConsec >= 2
          ? `${sellConsec} señales SELL consecutivas refuerzan la tendencia bajista.`
          : null,
        mem.condiciones_similares > 0
          ? `Memoria bayesiana: ${mem.aciertos || 0} de ${mem.condiciones_similares} condiciones similares resultaron en baja.`
          : null,
      ].filter(Boolean),
      sectores_afectados: sectoresNeg.map(s => s.sector),
      recomendacion: "Considerar reducir exposición. Mantener stop-loss activos.",
    });
  }

  // ── PATRÓN 3: CAÍDA TOTAL / CRISIS DE MERCADO ─────────────
  // Riesgo > 0.80 Y 4+ sectores negativos Y tendencia de riesgo subiendo
  if (riesgo > 0.80 && sectoresNeg.length >= 4 && tendenciaR?.tendencia === "subiendo") {
    alertas.push({
      tipo:    "caida_total",
      nivel:   "CRITICO",
      titulo:  "⚠️ CRISIS DE MERCADO — Caída generalizada",
      razones: [
        `Riesgo global crítico: ${(riesgo*100).toFixed(0)}% y en ascenso (delta +${(tendenciaR.delta*100).toFixed(1)}%).`,
        `${sectoresNeg.length} de los sectores monitoreados muestran caída simultánea.`,
        `El score del ensamble neuronal cayó a ${(score*100).toFixed(0)}% — mínimo histórico reciente.`,
        tendenciaR.velocidad > 0.05
          ? `La velocidad de deterioro es elevada (${(tendenciaR.velocidad*100).toFixed(1)}% por señal).`
          : null,
        sellConsec >= 3
          ? `${sellConsec} señales SELL consecutivas — el sistema detecta presión vendedora persistente.`
          : null,
      ].filter(Boolean),
      sectores_afectados: sectoresNeg.map(s => s.sector),
      recomendacion: "PRECAUCIÓN MÁXIMA. Evaluar salida de posiciones de alto riesgo. No ingresar nuevas posiciones hasta estabilización.",
    });
  }

  // ── PATRÓN 4: DEPRESIÓN PROLONGADA ────────────────────────
  // Riesgo promedio > 0.65 sostenido en 8+ señales consecutivas
  if (historialRiesgo.length >= 8) {
    const promedioLargo = historialRiesgo.slice(-8).reduce((a,b)=>a+b,0) / 8;
    if (promedioLargo > 0.65) {
      alertas.push({
        tipo:    "depresion_prolongada",
        nivel:   promedioLargo > 0.75 ? "CRITICO" : "PELIGRO",
        titulo:  "Depresión prolongada de mercado",
        razones: [
          `El riesgo promedio de las últimas 8 señales es ${(promedioLargo*100).toFixed(0)}% — sostenido por encima del umbral crítico.`,
          `No se detectan señales de recuperación en el horizonte analizado.`,
          `Patrón consistente con períodos de contracción económica o corrección técnica prolongada.`,
          historialScores.length >= 5
            ? `Score promedio del ensamble en las últimas señales: ${(historialScores.slice(-5).reduce((a,b)=>a+b,0)/5*100).toFixed(0)}%.`
            : null,
        ].filter(Boolean),
        sectores_afectados: sectoresNeg.map(s => s.sector),
        recomendacion: "Estrategia defensiva recomendada. Privilegiar activos de bajo riesgo y liquidez. Esperar confirmación de reversión antes de ingresar.",
      });
    }
  }

  // ── PATRÓN 5: SEÑAL DE RECUPERACIÓN ───────────────────────
  // Después de riesgo alto, score sube y tendencia positiva
  if (historialRiesgo.length >= 4 && tendenciaR?.tendencia === "bajando" &&
      tendenciaR.delta < -0.08 && riesgo < 0.55 && score > 0.55) {
    const riesgoAnterior = historialRiesgo.slice(-4, -1).reduce((a,b)=>a+b,0) / 3;
    if (riesgoAnterior > 0.65) {
      alertas.push({
        tipo:    "recuperacion",
        nivel:   "INFO",
        titulo:  "📈 Señal de recuperación de mercado",
        razones: [
          `El riesgo bajó de ${(riesgoAnterior*100).toFixed(0)}% a ${(riesgo*100).toFixed(0)}% — reducción de ${((riesgoAnterior-riesgo)*100).toFixed(0)}%.`,
          `El score del ensamble subió a ${(score*100).toFixed(0)}% — señal de mayor confianza del sistema.`,
          `Tendencia de riesgo: en descenso sostenido.`,
        ].filter(Boolean),
        sectores_afectados: [],
        recomendacion: "Las condiciones mejoran. Podría ser momento de evaluar reingreso gradual en posiciones.",
      });
    }
  }

  return alertas;
}

/**
 * procesarYPublicarAlertas
 * Evalúa los patrones detectados, filtra por cooldown y prioridad,
 * y publica las alertas al usuario con explicación completa.
 */
async function procesarYPublicarAlertas(señalA) {
  try {
    // Actualizar historial con los datos actuales
    const riesgo = parseFloat(señalA.riesgo || 0.5);
    const score  = parseFloat(señalA.ensemble_score || señalA.confianza || 0.5);
    const senal  = señalA.senal || "HOLD";

    historialRiesgo.push(riesgo);
    historialScores.push(score);
    historialSenales.push(senal);

    if (historialRiesgo.length   > HISTORIAL_ALERTAS_MAX) historialRiesgo.shift();
    if (historialScores.length   > HISTORIAL_ALERTAS_MAX) historialScores.shift();
    if (historialSenales.length  > HISTORIAL_ALERTAS_MAX) historialSenales.shift();

    // Historial de sectores ya se actualiza via class7_output en tiempo real
    // Aquí solo actualizamos si la señalA trae datos de sector directamente
    if (señalA.data?.sectores) {
      actualizarHistorialSectores({ sectors: Object.entries(señalA.data.sectores)
        .map(([sector, v]) => ({ sector, change: v?.change || 0 })) });
    }
    const textNum = señalA.texto_numerico || "";
    // Extraer etf/ticker del texto: "XLK bajó 2.3 puntos"
    const sectorMatch = textNum.match(/([A-Z]{2,5})\s+(?:bajó|subió)[^\d]*([+-]?\d+\.?\d*)/g);
    if (sectorMatch) {
      for (const m of sectorMatch) {
        const parts = m.match(/([A-Z]{2,5})\s+(?:bajó|subió)[^\d]*([+-]?\d+\.?\d*)/);
        if (parts) {
          const etf    = parts[1];
          const change = parseFloat(parts[2]) * (m.includes("bajó") ? -1 : 1);
          if (!historialSectores[etf]) historialSectores[etf] = [];
          historialSectores[etf].push(change);
          if (historialSectores[etf].length > 10) historialSectores[etf].shift();
        }
      }
    }
    const _unused = textNum; // suprimir linttos/gi);

    // Detectar patrones
    const alertasDetectadas = detectarPatrones(señalA);
    if (alertasDetectadas.length === 0) return;

    // Ordenar por prioridad (más grave primero)
    alertasDetectadas.sort((a,b) =>
      (NIVELES[b.nivel]?.prioridad || 0) - (NIVELES[a.nivel]?.prioridad || 0));

    const alertaPrincipal = alertasDetectadas[0];
    const now = Date.now();

    // Cooldown: no enviar la misma alerta en < 2 minutos
    const alertaReciente = alertasActivas.find(a => a.tipo === alertaPrincipal.tipo);
    if (alertaReciente && (now - alertaReciente.ts) < COOLDOWN_ALERTA_MS) {
      return;
    }

    // Construir alerta completa para el usuario
    const alerta = {
      id:                  uuidv4(),
      tipo:                alertaPrincipal.tipo,
      nivel:               alertaPrincipal.nivel,
      emoji:               NIVELES[alertaPrincipal.nivel]?.emoji || "⚠️",
      color:               NIVELES[alertaPrincipal.nivel]?.color || "#f59e0b",
      titulo:              alertaPrincipal.titulo,
      razones:             alertaPrincipal.razones,
      recomendacion:       alertaPrincipal.recomendacion,
      sectores_afectados:  alertaPrincipal.sectores_afectados || [],
      alertas_adicionales: alertasDetectadas.slice(1).map(a => ({
        tipo: a.tipo, titulo: a.titulo, nivel: a.nivel
      })),
      contexto_numerico: {
        riesgo_actual:   +(riesgo * 100).toFixed(1),
        score_ensemble:  +(score  * 100).toFixed(1),
        tendencia_riesgo: analizarTendenciaRiesgo(),
      },
      ts: new Date().toISOString(),
    };

    // Actualizar alertas activas
    alertasActivas = alertasActivas.filter(a => a.tipo !== alertaPrincipal.tipo);
    // `titulo` se guarda para que los consumidores de aguas abajo tengan algo
    // mostrable. Antes se descartaba acá y por eso el prompt de Gemini no
    // tenía más opción que interpolar el identificador crudo.
    alertasActivas.push({ tipo: alerta.tipo, titulo: alerta.titulo, ts: now, nivel: alerta.nivel });
    if (alertasActivas.length > 10) alertasActivas.shift();
    LAST_ALERTA_TS = now;

    // Publicación se hace después de enriquecer con Gemini

    // ── Enriquecer alerta con explicación de Gemini ────────────
    if (_geminiReady() && ["CRITICO","PELIGRO"].includes(alerta.nivel) && _puedeExplicarAlertaConGemini(alerta)) {
      try {
        const promptAlerta = `Eres MIIA. Detectaste una alerta de mercado importante.

ALERTA DETECTADA:
- Tipo: ${_alertaLegible(alerta)}
- Nivel: ${alerta.nivel}
- Título: ${alerta.titulo}
- Razones técnicas:
${alerta.razones.map(r => `  • ${r}`).join("\n")}
- Sectores afectados: ${alerta.sectores_afectados.join(", ") || "mercado general"}
- Riesgo actual: ${alerta.contexto_numerico?.riesgo_actual}%

INSTRUCCIONES:
Explicá esta alerta al usuario inversor en 3-4 oraciones simples.
¿QUÉ significa esto para sus inversiones? ¿POR QUÉ el sistema cree esto?
¿Qué debería hacer o NO hacer en este momento?
No uses markdown. Sé claro y directo. Evitá el alarmismo innecesario.`;

        const result = await geminiModel.generateContent({
          contents: [{ role: "user", parts: [{ text: promptAlerta }] }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.6, thinkingConfig: { thinkingBudget: 0 } }
        });
        alerta.explicacion_gemini = result.response.text().trim();
        log(`✅ Alerta explicada por Gemini (${alerta.explicacion_gemini.length} chars)`);
        _gemini429StreakReset();
      } catch (e) {
        _handleGeminiError(e, "(alerta)");
      }
    }

    // ── Re-publicar con explicación de Gemini incluida ─────────
    await redisPub.publish(CH_ALERTAS, JSON.stringify(alerta));
    await redisPub.publish(CH_UI, JSON.stringify({
      type: "market_alert",
      alerta,
    })).catch(() => {});

    // ── Guardar en MySQL crisis_events ────────────────────────
    await guardarCausal({
      causa:     `${alerta.tipo}: ${alerta.razones[0]}`,
      efecto:    alerta.recomendacion,
      confianza: alerta.nivel === "CRITICO" ? 0.9 :
                 alerta.nivel === "PELIGRO" ? 0.75 :
                 alerta.nivel === "ATENCION"? 0.6 : 0.4,
    }).catch(() => {});

  } catch (e) {
    log(`procesarYPublicarAlertas error: ${e?.message}`, "error");
  }
}

// ── Google Gemini — Maestro Lingüístico ────────────────────
// PLAN 18 MESES:
// Fase 1 (meses 1-18):  Gemini genera cada respuesta al usuario.
//                        class25B almacena la respuesta + contexto como patrón de aprendizaje.
// Fase 2 (mes 18+):     class25B tiene 1000+ patrones propios y puede generar
//                        respuestas sin Gemini (GEMINI_API_KEY="" para desactivar).
//
// ⚠ CÓMO CONFIGURAR LA API KEY:
//   1. Obtener key en: https://aistudio.google.com/
//   2. Las keys válidas empiezan con "AIza..." o "AQ." (formato nuevo de AI Studio)
//   3. Configurar en operador/aprendizaje/config/miia.ini (sección [gemini])
//      O como variable de entorno: set GEMINI_API_KEY=TU_KEY
//
// miia.ini tiene múltiples secciones → class38 NO la desenvuelve, queda anidada:
// getConfig("miia") = {memoria:{...}, logs:{...}, gemini:{api_key,model,...}, sistema:{...}}
// getConfig() lanza excepción si la config no existe — protegido con try/catch.

// El orquestador pasa a cada hijo un SNAPSHOT de process.env de cuando arrancó
// (operador/index.js:226): cambiar GEMINI_API_KEY o GEMINI_MODEL en el .env NO llega a
// un respawn de class25B salvo reiniciando el orquestador, que corta la medición.
// Releemos esas dos claves del .env para que `deploy_arreglo_chat.sh --solo-js` las tome.
try {
  const _envPath = path.join(BASE_DIR, "config", ".env");
  for (const _l of fs.readFileSync(_envPath, "utf8").split(/\r?\n/)) {
    const _m = _l.match(/^\s*(GEMINI_API_KEY|GEMINI_MODEL)\s*=\s*(.*)$/);
    if (_m) process.env[_m[1]] = _m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* en dev el .env puede no existir */ }

let _geminiCfg = {};
try {
  _geminiCfg = getConfig("miia")?.gemini || {};
} catch (e) {
  console.log(`[class25B] ⚠️ No se pudo leer [gemini] de miia.ini: ${e.message}`);
}
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
  || _geminiCfg.api_key
  || "";   // vacío = Gemini desactivado, usará fallback interno

if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 10) {
  log("⚠️ GEMINI_API_KEY no configurada — usando fallback interno.", "warn");
  log("   Para activar: https://aistudio.google.com/ → Get API key", "warn");
  log("   Luego: miia.ini [gemini] api_key = TU_KEY", "warn");
} else {
  log(`✅ GEMINI_API_KEY detectada (${GEMINI_API_KEY.length} chars) — intentando conectar...`);
  log(String(process.env.GEMINI_SOLO_USUARIO ?? "1") !== "0"
      ? "🔒 GEMINI_SOLO_USUARIO=1 — la cuota se reserva para el CHAT. Las decisiones y "
        + "las alertas usan el redactor interno (sin salir a la red)."
      : "⚠️ GEMINI_SOLO_USUARIO=0 — las decisiones y alertas TAMBIÉN consumen cuota. "
        + "Con muchos instrumentos esto agota el free tier y deja el chat sin servicio.");
}

// Cualquier key con longitud razonable se intenta usar; Gemini retorna 401 si es inválida
const GEMINI_API_KEY_VALID = GEMINI_API_KEY.length >= 10;
// Google retira modelos seguido: gemini-1.5 y gemini-2.0 dan 404, y en nov-2026 los
// gemini-2.5 quedaron viejos. El activo verificado es gemini-3.8-flash (2026-11-07).
const GEMINI_MODEL      = process.env.GEMINI_MODEL || _geminiCfg.model || "gemini-3.8-flash";
const GEMINI_MAX_TOKENS = 800;

// Circuit breaker: si Gemini falla con 429/401/403, pausa (con backoff exponencial
// si el 429 se repite — la quota free tier de Gemini suele ser DIARIA, no por minuto,
// así que un 429 inmediatamente después de una pausa de 30min significa que la quota
// sigue agotada y reintentar a los 30min otra vez solo repite el ciclo todo el día).
// El 503 ("modelo con alta demanda") es transitorio y se recupera solo en general
// — se le da una pausa corta separada para no martillar al modelo durante un pico.
let _geminiDisabled   = false;
let _geminiRetryAt    = 0;
let _gemini429Streak  = 0;     // pausas 429 consecutivas sin ningún éxito en el medio
let _geminiSinThinking = false; // el modelo rechazó thinkingConfig (400): se llama sin él (13-nov-2026)
const GEMINI_CB_ERRORS    = [400, 401, 403, 429];
const GEMINI_RETRY_MS     = 30 * 60_000;   // 30 minutos (base, 401/403/primer 429)
const GEMINI_RETRY_MAX_MS = 6 * 60 * 60_000; // 6 horas (techo del backoff exponencial)
const GEMINI_503_RETRY_MS = 45_000;        // 45 segundos (alta demanda, transitorio)

// ── Manejo centralizado de errores de Gemini (circuit breaker) ───────────
// Se usa en los 3 puntos donde se llama a generateContent. Devuelve nada;
// solo actualiza _geminiDisabled/_geminiRetryAt y loguea.
function _handleGeminiError(e, contexto = "") {
  const code = Number(e?.status || (e?.message?.match(/\[(\d+)/)?.[1] || 0));
  const retryDelaySec = Number(e?.message?.match(/retryDelay"\s*:\s*"(\d+)s/)?.[1] || 0);
  const ctxStr = contexto ? ` ${contexto}` : "";

  if (code === 503) {
    _geminiDisabled = true;
    _geminiRetryAt  = Date.now() + GEMINI_503_RETRY_MS;
    log(`⏸ Gemini pausado ${GEMINI_503_RETRY_MS/1000}s por alta demanda (503)${ctxStr}`, "warn");
    return;
  }

  if (GEMINI_CB_ERRORS.includes(code)) {
    let pauseMs = GEMINI_RETRY_MS;
    if (code === 429) {
      _gemini429Streak++;
      pauseMs = Math.min(GEMINI_RETRY_MS * (2 ** (_gemini429Streak - 1)), GEMINI_RETRY_MAX_MS);
      if (retryDelaySec > 0) pauseMs = Math.max(pauseMs, Math.min(retryDelaySec * 1000, GEMINI_RETRY_MAX_MS));
    }
    _geminiDisabled = true;
    _geminiRetryAt  = Date.now() + pauseMs;
    log(`⏸ Gemini pausado ${(pauseMs/60000).toFixed(0)} min (${code})${ctxStr}${_gemini429Streak > 1 ? ` — racha 429 #${_gemini429Streak}` : ""}`, "warn");
    log(`   detalle: ${(e?.message || "").slice(0, 200)}`, "warn");
    return;
  }

  log(`⚠️ Gemini error${ctxStr}: ${e?.message}`, "warn");
}

// Reinicia la racha de 429 cuando una llamada a Gemini efectivamente funciona.
function _gemini429StreakReset() { _gemini429Streak = 0; }

// ── Throttle de explicaciones de alerta con Gemini ───────────────────────
// El free tier de Gemini tiene cuota DIARIA (~250 req/día en flash). Explicar
// CADA alerta CRITICO/PELIGRO con Gemini (se genera una cada ~2 min con el
// mercado en riesgo alto) consume ~700 requests/día y AGOTA la cuota, lo que
// dispara el circuit breaker y deja sin Gemini al CHAT (que es lo prioritario
// y de cara al usuario → cuando falta, responde como bot).
// Solución: limitar las explicaciones de alerta a 1 cada ALERT_GEMINI_COOLDOWN_MS,
// sin repetir la misma combinación tipo+nivel seguidas. Así la cuota diaria
// queda reservada para el chat. Con billing activo, poné ALERT_GEMINI_COOLDOWN_MS=0.
let _lastAlertGeminiTs  = 0;
let _lastAlertGeminiKey = "";
const ALERT_GEMINI_COOLDOWN_MS = Number(process.env.ALERT_GEMINI_COOLDOWN_MS ?? 20 * 60_000);

// ════════════════════════════════════════════════════════════════════════
// GEMINI SOLO PARA EL USUARIO
// ════════════════════════════════════════════════════════════════════════
//
// Hay TRES caminos que llaman a la API de Gemini en este módulo:
//
//   1. Explicación de alertas CRÍTICO/PELIGRO   → SISTEMA (throttleado a 1/20min)
//   2. redactarDecisionFinal() por cada decisión → SISTEMA (SIN throttle) ← el caro
//   3. _geminiMultiTurno() del chat              → USUARIO
//
// El (2) no tenía ningún límite: una llamada por decisión emitida. Con el
// cooldown por (ticker, señal) y UN solo ticker efectivo eso ya consumía buena
// parte de la cuota diaria del free tier; con el ORDEN 1 pasan 13 instrumentos,
// así que el volumen de llamadas se multiplica por ~13.
//
// El síntoma cuando la cuota se agota está documentado: Gemini devuelve 429, el
// circuit breaker apaga TODO Gemini con backoff de hasta 6 h, y el chat —lo
// único que el usuario ve— empieza a responder con plantillas. O sea: el gasto
// invisible del sistema deja sin servicio a la parte visible.
//
// Con GEMINI_SOLO_USUARIO=1 (default) los caminos 1 y 2 usan el redactor
// interno, que ya existe y funciona (_redactarInterno). La cuota queda entera
// para el chat. Poner en 0 restaura el comportamiento anterior.
const GEMINI_SOLO_USUARIO =
  String(process.env.GEMINI_SOLO_USUARIO ?? "1") !== "0";

// ── QUIEN REDACTA: el router de motores (11-oct-2026) ────────────────
//
// Pedido de Martín: dejar de depender de la cuota de Gemini. El sistema tenía
// 92 a 180 eventos de cuota agotada POR DÍA, y cuando eso pasa el circuit
// breaker apaga Gemini con backoff de hasta 6 h: el chat —lo único que el
// usuario ve— se queda contestando con plantillas.
//
//   MIIA_LLM=auto    (default) local primero, Gemini de respaldo, interno al final
//   MIIA_LLM=local             sólo Ollama; si falla, el redactor interno
//   MIIA_LLM=gemini            el comportamiento de ANTES, bit a bit (la reversa)
//
// ⚠️ Esto NO toca ninguna decisión. Con GEMINI_SOLO_USUARIO=1 (el default) los
// caminos de decisión y de alerta ya usan `_redactarInterno`: el único camino
// que llega a un LLM es el CHAT. O sea que cambiar de motor no mueve la tesis,
// ni class43, ni el ranking, ni una sola fila de cognitive_decisions.
// Por decision de Martin (11-oct-2026): SOLO LOCAL, sin Gemini. El objetivo
// era dejar de depender de la cuota, y con `auto` el chat la seguia gastando.
// `MIIA_LLM=gemini` vuelve al comportamiento anterior bit a bit; si el entorno
// no propaga, la reversa segura es deploy_llm_local.sh --rollback.
const MIIA_LLM       = String(process.env.MIIA_LLM || "local").toLowerCase();
// Topes del camino LOCAL. El 11-oct-2026 gemma2:2b GENERABA a 102,8 ms/token
// (9,7 tok/s) y 90 tokens entraban. El 15-oct, con el universo de 50 y la CPU
// del server a load ~6,8 de 6 vCPU, la generacion cayo a ~4,2 tok/s (238 ms por
// token): 90 tokens son ~21 s y revientan el timeout de 18 s de llm_local — el
// chat timbra, se abre el cortacircuitos y todo cae a las plantillas. 56 tokens
// son ~13 s de generacion, que con un prompt corto entra en los 18 s. Es
// env-overridable: si el server se descarga, subilo; si sigue timbrando, bajalo.
const LLM_LOCAL_MAX_TOKENS = Number(process.env.MIIA_LLM_MAX_TOKENS || 56);
// El historial viaja DENTRO del prompt, asi que cada turno viejo se paga a
// 24,7 ms por token. Con los 6 turnos de antes, la segunda pregunta de una
// conversacion ya no entraba en el presupuesto.
const LLM_LOCAL_TURNOS      = Number(process.env.MIIA_LLM_TURNOS || 2);
// La charla libre (preguntas fuera del sistema) usa su propio prompt, corto, y
// el mismo tope de salida por defecto: la firma «soy una IA…» la agrega el
// código, no la genera el modelo, así que no cuesta tokens.
const LLM_CHARLA_MAX_TOKENS = Number(process.env.MIIA_LLM_MAX_TOKENS_CHARLA || LLM_LOCAL_MAX_TOKENS);
const LLM_LOCAL_CHARS_TURNO = 250;
// Presupuesto de tiempo de la charla: el frente corta a los 25 s (index.html) y el
// Python espera 25 s (CHAT_TIMEOUT_S). Si Gemini da 503 (gratis sobrecargado, no
// cuota) el SDK puede reintentar solo, así que Gemini lleva un tope DURO (9 s).
//
// CARRERA (8-nov-2026, recuperada el 13-nov: el deploy de ese día la había pisado):
// Gemini y Ollama arrancan JUNTOS. Medido en el server, Ollama con el modelo ya
// cargado tarda 10,6 a 12+ s en una charla (6 vCPU compartidos, ~10 tok/s): en fila
// detrás de los 9 s de Gemini le quedaban 12 s y fallaba 3 de cada 4. En carrera
// tiene 20 s desde el principio. Si Gemini contesta (y pasa el validador), sale la
// suya; si no, la de Ollama. Reversa sin recompilar: CLASS25B_CHARLA_CARRERA=0
// (vuelve a la fila: Gemini 9 s y después Ollama 12 s, 9+12 = 21 s < 25).
// La REESCRITURA de respuestas con datos va siempre en fila (`opts.sinCarrera`): en
// carrera Ollama trabajaría en cada pregunta con datos aunque conteste Gemini.
const CHARLA_EN_CARRERA = String(process.env.CLASS25B_CHARLA_CARRERA ?? "1") !== "0";
const LLM_CHARLA_TIMEOUT_MS  = Number(process.env.MIIA_LLM_TIMEOUT_CHARLA_MS || 20000);
const LLM_CHARLA_TIMEOUT_SERIE_MS = Number(process.env.MIIA_LLM_TIMEOUT_CHARLA_SERIE_MS || 12000);
const GEMINI_CHARLA_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_CHARLA_MS || 9000);
const LLM_USA_LOCAL  = MIIA_LLM === "auto" || MIIA_LLM === "local";
const LLM_USA_GEMINI = MIIA_LLM === "auto" || MIIA_LLM === "gemini";

// ¿Los MLLs aprenden del estilo del modelo local? APAGADO a propósito.
// `aprenderDeRespuestaGemini` extrae n-gramas de estilo y los persiste en
// learning_cycles: si entra el estilo de un 2B local, esa serie pasa a ser una
// mezcla de dos redactores y no se puede separar hacia atrás. Se prende cuando
// el local sea el único motor y se quiera que aprenda de él.
const LLM_APRENDER_LOCAL = String(process.env.MIIA_LLM_APRENDER_LOCAL || "0") === "1";

// (Identidad, mercado abierto y tasa de acierto los contesta el router del chat:
// chat_router/chat_redactor. identidad.js, mercado.js y metricas.js quedaron sin uso.)

let _llmLocalUsos = 0, _llmLocalFallos = 0;
// Contadores para poder medir cuánto se ahorró (se reportan en el heartbeat).
let _geminiAhorradas = 0;
function _puedeExplicarAlertaConGemini(alerta) {
  // Camino de SISTEMA: con GEMINI_SOLO_USUARIO la alerta se publica igual,
  // solo que sin el campo `explicacion_gemini`. La alerta en sí (nivel, tipo,
  // métrica) la genera MIIA sin depender de la red.
  if (GEMINI_SOLO_USUARIO) { _geminiAhorradas++; return false; }
  if (ALERT_GEMINI_COOLDOWN_MS <= 0) return true;   // billing activo → sin límite
  const now = Date.now();
  const key = `${alerta.tipo}|${alerta.nivel}`;
  // misma alerta repetida → esperar el doble del cooldown
  if (key === _lastAlertGeminiKey && now - _lastAlertGeminiTs < ALERT_GEMINI_COOLDOWN_MS * 2) return false;
  if (now - _lastAlertGeminiTs < ALERT_GEMINI_COOLDOWN_MS) return false;
  _lastAlertGeminiTs  = now;
  _lastAlertGeminiKey = key;
  return true;
}

// Período de gracia al startup: no llamar Gemini en los primeros 90 segundos.
// Evita el 429 que se produce cuando class25A envía ráfagas de señales al arrancar.
// Las señales de startup usan el fallback interno; luego Gemini toma el control.
const _startupTime    = Date.now();
const STARTUP_GRACE_MS = 90_000;  // 90 segundos
function _geminiReady(bypassGrace = false) {
  // bypassGrace=true para queries del usuario (no para señales automáticas de startup)
  if (!bypassGrace && Date.now() - _startupTime < STARTUP_GRACE_MS) return false;
  if (_geminiDisabled && Date.now() < _geminiRetryAt)    return false;
  if (_geminiDisabled && Date.now() >= _geminiRetryAt)   { _geminiDisabled = false; }
  return !!geminiModel;
}

// ¿Hay ALGÚN motor de lenguaje para el chat? El router decide, no `_geminiReady`.
// Antes la compuerta de `procesarInputHumano` era `_geminiReady(true)`, así que
// con MIIA_LLM=local y sin clave de Gemini el chat NUNCA llegaba a Ollama: se
// saltaba toda la fase del LLM y caía directo a las plantillas de
// `_fallbackConContexto`. `_geminiMultiTurno` ya es consciente del router y
// contesta con el local igual; sólo faltaba que el llamador lo dejara entrar.
function _hayMotorLenguaje(bypassGrace = false) {
  return (LLM_USA_LOCAL && !LLM.cortado()) || _geminiReady(bypassGrace);
}

// ── Caché de respuestas Gemini ────────────────────────────────
// Evita llamar a Gemini dos veces con preguntas similares en la misma sesión.
// TTL: 10 minutos. Key: primeros 80 chars del texto normalizado.
const _geminiCache    = new Map();
const GEMINI_CACHE_TTL = 10 * 60_000;

function _geminiCacheKey(texto) {
  return texto.trim().toLowerCase().slice(0, 80);
}
function _geminiCacheGet(texto) {
  const k = _geminiCacheKey(texto);
  const entry = _geminiCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > GEMINI_CACHE_TTL) { _geminiCache.delete(k); return null; }
  return entry.resp;
}
function _geminiCacheSet(texto, resp) {
  if (_geminiCache.size > 50) {
    // purgar entradas expiradas
    const now = Date.now();
    for (const [k, v] of _geminiCache) if (now - v.ts > GEMINI_CACHE_TTL) _geminiCache.delete(k);
  }
  _geminiCache.set(_geminiCacheKey(texto), { resp, ts: Date.now() });
}

// Modelos en orden de preferencia (se intenta el siguiente si el anterior falla
// 404 o 429 — un 429 en este key/proyecto puede significar que ESE modelo
// específico no tiene cuota, no que la key esté mal; otro modelo de la lista
// puede tener cuota propia disponible — ver miia.ini [gemini] y la cuota free
// tier de Google, que es por-modelo, no compartida).
// gemini-1.5-* y gemini-pro retirados por Google — ya no se incluyen.
// gemini-2.0-flash/-lite quedan fuera del fallback por defecto: en este
// proyecto reportan quota=0 (sin acceso), probarlos solo desperdicia un request.
const GEMINI_MODELS_FALLBACK = [...new Set([
  GEMINI_MODEL,
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
])];

let geminiModel = null;
// Tope DURO de la prueba de arranque (8-nov-2026). Era un `await` sin límite, ANTES del
// `subscribe` de Redis: con el Gemini gratis sobrecargado (503, «alta demanda») cada
// prueba se colgaba y class25B tardaba 2 min 23 s en escuchar — sin chat y sin escribir
// las decisiones de class25A todo ese rato. Si Gemini no contestara nunca, class25B no
// arrancaría. Al vencer, el error lleva «[503]» y cae en «error distinto → usar igual»:
// queda configurado y el cortacircuitos lo maneja en runtime.
const GEMINI_INIT_TIMEOUT_MS = Number(process.env.GEMINI_INIT_TIMEOUT_MS || 5000);
function _conTopeArranque(promesa) {
  let t;
  const tope = new Promise((_, rej) => { t = setTimeout(
    () => rej(new Error(`[503] timeout de arranque (${GEMINI_INIT_TIMEOUT_MS} ms)`)), GEMINI_INIT_TIMEOUT_MS); });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(t));
}
if (GEMINI_API_KEY_VALID) {
  let _lastInitError = null;
  let _fallbackModel = null;   // candidato "optimista" si ninguno responde 200 limpio
  // Intentar inicializar con cada modelo hasta que uno funcione SIN error
  for (const modelName of GEMINI_MODELS_FALLBACK) {
    try {
      // Intentar con v1 primero (más compatible), luego v1beta (default)
      for (const apiVer of ["v1", "v1beta"]) {
        try {
          const genAI = new GoogleGenerativeAI(GEMINI_API_KEY, { apiVersion: apiVer });
          const candidate = genAI.getGenerativeModel({ model: modelName });
          // Test rápido para verificar que el modelo existe Y tiene cuota disponible
          await _conTopeArranque(candidate.generateContent({
            contents: [{ role: "user", parts: [{ text: "hola" }] }],
            generationConfig: { maxOutputTokens: 5 }
          }));
          geminiModel = candidate;
          console.log(`[class25B] ✅ Gemini conectado: ${modelName} (${apiVer})`);
          break;
        } catch (e) {
          _lastInitError = e;
          const code = Number(e?.status || e.message?.match(/\[(\d+)/)?.[1] || 0);
          if (code === 404 || code === 429 || e.message?.includes("not found")) {
            // 404 → el modelo no existe en esta versión de API.
            // 429 → sin cuota disponible AHORA para este modelo específico.
            // En ambos casos seguimos buscando otro modelo/versión que sí funcione,
            // pero guardamos este como candidato de último recurso.
            if (!_fallbackModel) _fallbackModel = { modelName, apiVer };
            continue;
          }
          // Error distinto (ej: 500, network) → probablemente transitorio, usar igual.
          const genAI2 = new GoogleGenerativeAI(GEMINI_API_KEY, { apiVersion: apiVer });
          geminiModel = genAI2.getGenerativeModel({ model: modelName });
          console.log(`[class25B] ✅ Gemini configurado: ${modelName} (${apiVer}) — error inicial: ${e.message?.slice(0,50)}`);
          break;
        }
      }
      if (geminiModel) break;
    } catch (e) {
      _lastInitError = e;
      console.warn(`[class25B] ⚠️ Init Gemini ${modelName} falló: ${e?.message?.slice(0,150)}`);
    }
  }
  // Ningún modelo respondió limpio (todos 404/429) → usar el último candidato
  // visto en vez de quedar sin Gemini del todo; el circuit breaker en runtime
  // ya maneja el backoff si efectivamente sigue sin cuota.
  if (!geminiModel && _fallbackModel) {
    const genAI3 = new GoogleGenerativeAI(GEMINI_API_KEY, { apiVersion: _fallbackModel.apiVer });
    geminiModel = genAI3.getGenerativeModel({ model: _fallbackModel.modelName });
    console.log(`[class25B] ⚠️ Gemini configurado en modo optimista: ${_fallbackModel.modelName} (${_fallbackModel.apiVer}) — todos los modelos dieron 404/429 al probar`);
  }
  if (!geminiModel) {
    console.warn(`[class25B] ⚠️ Ningún modelo Gemini disponible — usando fallback interno. Último error: ${_lastInitError?.message?.slice(0,200) || "desconocido"}`);
  }
} else {
  console.log("[class25B] ℹ️ Sin GEMINI_API_KEY — usando redacción interna");
}

// ── Carga de estado persistido ───────────────────────────────
async function cargarEstado() {
  // ── Fase 1: JSON local (rápido, siempre disponible) ──────────
  try {
    if (fs.existsSync(PATRONES_FILE)) {
      const crudo = JSON.parse(await fsp.readFile(PATRONES_FILE, "utf8"));
      const version = crudo?.__meta__?.schema_version ?? 3;

      if (version === PATRONES_SCHEMA_VERSION) {
        _patronesWatermark = Number(crudo.__meta__?.watermark_ms ?? 0) || 0;
        patronesLinguisticos = crudo;
        delete patronesLinguisticos.__meta__;   // meta se reescribe al guardar
      } else {
        // v3 → v4. NO se migran los contadores: `total` mezcla usos con
        // verificaciones y viene inflado por la relectura sin marca de agua.
        // Reconstruir desde la DB (Fase 3) da una tabla correcta en un
        // arranque; arrastrar los números viejos la deja sesgada para siempre.
        const descartados = Object.keys(crudo).filter(k => k !== "__meta__").length;
        patronesLinguisticos = {};
        log(`🔁 Patrones v${version} → v${PATRONES_SCHEMA_VERSION}: ${descartados} entradas descartadas (contadores no reparables). Se reconstruye desde cognitive_decisions.`, "warn");
      }
    }
    if (fs.existsSync(MEMORIA_FILE)) {
      const m = JSON.parse(await fsp.readFile(MEMORIA_FILE, "utf8"));
      memoriaCausal    = m.causal    || [];
      memoriaCognitiva = m.cognitiva || [];
    }
    log(`Estado JSON: ${Object.keys(patronesLinguisticos).length} patrones, ${memoriaCausal.length} causales`);
  } catch (e) {
    log(`cargarEstado JSON: ${e.message}`, "warn");
  }

  // ── Fase 2: Sincronizar causal_memory desde DB ───────────────
  // La DB es la fuente de verdad (acumula entre reinicios)
  try {
    const rows = await dbQuery(`
      SELECT LEFT(causa,300) AS causa, LEFT(efecto,200) AS efecto,
             confianza, repeticiones, ts_creacion AS ts
      FROM causal_memory
      ORDER BY confianza DESC, repeticiones DESC
      LIMIT 200
    `);
    if (rows.length > 0) {
      memoriaCausal = rows.map(r => ({
        texto:        r.causa,
        causa:        r.causa,
        efecto:       r.efecto,
        senal:        /BUY/i.test(r.efecto||"") ? "BUY" : /SELL/i.test(r.efecto||"") ? "SELL" : "HOLD",
        confianza:    parseFloat(r.confianza || 0.5),
        repeticiones: r.repeticiones || 1,
        ts:           r.ts,
      }));
      log(`✅ DB: ${memoriaCausal.length} memorias causales cargadas`);
    }
  } catch (e) {
    log(`cargarEstado DB-causal: ${e.message}`, "warn");
  }

  // ── Fase 3: BOOTSTRAP de patrones desde cognitive_decisions ─────
  //
  // CONDICIONAL (30-ago-2026). Antes corría en CADA arranque, y como la Fase 1
  // ya había cargado la tabla del disco —con sus contadores, que YA incluían
  // estas mismas filas— volvía a sumar las 1500 decisiones encima. Medido en
  // producción, idéntico en tres arranques seguidos:
  //
  //     Estado JSON: 59 patrones
  //     DB: 19344 actualizaciones desde 1500 decisiones VERIFICADAS
  //
  // Un token presente en 1200 de esas decisiones llegaba a verificados=4800
  // tras cuatro reinicios, con 1200 decisiones distintas de evidencia real.
  //
  // La PROPORCIÓN no se rompía (aciertos y verificados inflaban juntos, la
  // accuracy seguía siendo correcta). Lo que se rompía era el tamaño de
  // muestra, y con él dos cosas:
  //   · el piso de MIN_VERIFICADOS, que un token con 3 decisiones reales
  //     pasaba tras cuatro reinicios y empezaba a votar sin evidencia;
  //   · cualquier intervalo calculado sobre ese n, que sale 1/√k veces más
  //     angosto de lo que corresponde (k = cantidad de reinicios).
  //
  // Ahora el bootstrap es lo que su nombre dice: siembra la tabla cuando está
  // vacía (primer arranque o migración de esquema). Si ya vino del disco, lo
  // nuevo entra por _refrescarPatronesDesdeDB(), que corta por marca de agua
  // y no repite nada.
  const _yaHayPatrones = Object.keys(patronesLinguisticos).length;
  if (_yaHayPatrones > 0) {
    log(`⏭️  Bootstrap omitido: ${_yaHayPatrones} patrones ya cargados del disco ` +
        `(marca de agua ${_patronesWatermark ? new Date(_patronesWatermark).toISOString() : "sin fijar"}). ` +
        `Lo nuevo entra por el refresh periódico.`);
    return;
  }

  try {
    // SOLO decisiones con outcome real de mercado. Sin este filtro, las
    // pendientes (outcome_real = NULL, el 91.5% del universo) entraban con
    // acerto=false y quedaban contadas como errores. Mismo criterio que ya
    // usa _refrescarPatronesDesdeDB() más abajo — ahora los dos coinciden.
    //
    // El LIMIT sube de 300 a 1500 porque la población cambió: antes eran 300
    // filas cualesquiera (de las que ~25 servían), ahora son 1500 filas que
    // TODAS aportan evidencia. Es la misma consulta pidiendo lo que sirve.
    const rows = await dbQuery(`
      SELECT LEFT(razon,500) AS razon, senal, outcome_real,
             UNIX_TIMESTAMP(ts_decision) AS ts_epoch
      FROM cognitive_decisions
      WHERE razon IS NOT NULL AND LENGTH(razon) > 20
        AND outcome_real IN ('correcto','incorrecto')
      ORDER BY ts_decision DESC LIMIT 1500
    `);
    let extraidos = 0, ok = 0;
    for (const row of rows) {
      if (!row.razon) continue;
      const acerto = row.outcome_real === "correcto";
      if (acerto) ok++;
      // Marca de agua: la decisión más nueva ya contabilizada acá. El refresh
      // periódico arranca desde este punto en vez de "última hora", que se
      // solapaba con este bootstrap y contaba dos veces los mismos tokens.
      const ts = Number(row.ts_epoch) * 1000;
      if (ts > _patronesWatermark) _patronesWatermark = ts;

      const palabras = row.razon.toLowerCase()
        .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
        .split(/\s+/).filter(t => t.length > 4);

      // Unigrams + bigrams de cada decisión histórica
      for (let i = 0; i < Math.min(palabras.length, 20); i++) {
        const p = _patron(palabras[i]);
        p.usos++; p.db_source++;
        p.verificados++;                 // la fila ya viene filtrada por outcome
        if (acerto) p.aciertos++;
        extraidos++;
      }
      // Bigrams
      for (let i = 0; i < Math.min(palabras.length - 1, 10); i++) {
        const p = _patron(`${palabras[i]}_${palabras[i+1]}`);
        p.usos++; p.db_source++;
        p.verificados++;
        if (acerto) p.aciertos++;
      }
    }
    const tasa = rows.length ? (100 * ok / rows.length).toFixed(1) : "0.0";
    log(`✅ DB: ${extraidos} actualizaciones desde ${rows.length} decisiones VERIFICADAS (${ok} correctas, ${tasa}%)`);
    await guardarEstado();   // Persistir el estado enriquecido
  } catch (e) {
    log(`cargarEstado DB-patrones: ${e.message}`, "warn");
  }
}

async function guardarEstado() {
  try {
    // __meta__ se agrega SOLO al serializar. La tabla en memoria queda limpia
    // (cargarEstado lo borra al leer), así que ningún recorrido de patrones lo
    // ve como si fuera un token más.
    const salida = {
      __meta__: {
        schema_version: PATRONES_SCHEMA_VERSION,
        watermark_ms:   _patronesWatermark,
        ts:             new Date().toISOString(),
        patrones:       Object.keys(patronesLinguisticos).length,
      },
      ...patronesLinguisticos,
    };
    await _escribirAtomico(PATRONES_FILE, JSON.stringify(salida, null, 2));
    await _escribirAtomico(MEMORIA_FILE,
      JSON.stringify({ causal: memoriaCausal, cognitiva: memoriaCognitiva }, null, 2));
  } catch (_) {}
}

// ── Escritura atómica ────────────────────────────────────────
// fsp.writeFile TRUNCA el archivo a cero y después escribe. Si el proceso
// muere en ese hueco —un pkill, un OOM, un reinicio— el archivo queda
// cortado. No es hipotético: el 30-ago-2026 pasó con class25b_memoria.json
// y el arranque siguiente registró "cargarEstado JSON: Unexpected end of
// JSON input". Esa vez no costó nada porque las causales se restauran desde
// MySQL, pero si le toca a class25b_patrones.json se pierde todo lo
// aprendido de forma incremental más allá de las 1500 del bootstrap.
//
// Y guardarEstado escribe seguido: cada 5 aprendizajes, en cada ciclo de
// Gemini, en cada feedback de usuario y en cada refresh periódico. Sobre
// meses, que un kill caiga justo en la ventana de truncado no es raro.
//
// Con .tmp + rename el archivo destino es SIEMPRE una versión completa: la
// vieja o la nueva, nunca la mitad. rename() es atómico en POSIX dentro del
// mismo filesystem — que es donde corre producción.
//
// En WINDOWS no siempre: si otro handle tiene abierto el destino (un editor,
// el antivirus, un backup), MoveFileEx devuelve EPERM aunque se pida
// REPLACE_EXISTING. Verificado en un test con un lector concurrente. Como el
// catch de guardarEstado se traga las excepciones, sin este manejo el guardado
// fallaría en silencio en la máquina de desarrollo.
//
// Por eso: se reintenta, y si el handle no se suelta se cae a la escritura
// directa. Perder la atomicidad en un caso raro es mejor que perder el
// guardado entero — lo primero es un riesgo, lo segundo es pérdida segura.
async function _escribirAtomico(destino, contenido) {
  const tmp = `${destino}.tmp`;
  await fsp.writeFile(tmp, contenido, "utf8");

  for (let intento = 0; intento < 3; intento++) {
    try {
      await fsp.rename(tmp, destino);
      return;                                     // camino normal (siempre en Linux)
    } catch (e) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 30 * (intento + 1)));
    }
  }

  // Último recurso: escritura directa. Vuelve la ventana de truncado, pero
  // solo en el caso Windows-con-handle-abierto y solo si además el proceso
  // muere justo ahí.
  await fsp.writeFile(destino, contenido, "utf8");
  try { await fsp.unlink(tmp); } catch (_) {}
}

// ── Motor lingüístico 1: Deductivo ───────────────────────────
// "Si X entonces Y" en el texto de class25A
function razonamientoDeductivo(texto) {
  if (!texto || texto.length < 10) return null;

  const patrones = [
    { re: /riesgo\s+(alto|elevado)/i,      conclusion: "precaución — riesgo elevado detectado" },
    { re: /(\d+)\s+de\s+(\d+).*confirm/i,  conclusion: (m) => `evidencia histórica sólida (${m[1]}/${m[2]})` },
    { re: /contracción.*(\d+)%/i,          conclusion: (m) => `señal de contracción con ${m[1]}% probabilidad` },
    { re: /memoria bayesiana.*(\d+)\s+de\s+(\d+)/i, conclusion: (m) =>
        parseInt(m[1]) / parseInt(m[2]) > 0.6
          ? `patrón bayesiano favorable (${m[1]}/${m[2]})`
          : `patrón bayesiano desfavorable (${m[1]}/${m[2]})` },
    { re: /riesgo\s+(bajo|moderado)/i,     conclusion: "condiciones de riesgo aceptables" },
    { re: /umbral.*>/i,                    conclusion: "señal supera umbral de decisión" },
  ];

  const conclusiones = [];
  for (const { re, conclusion } of patrones) {
    const m = texto.match(re);
    if (m) {
      const c = typeof conclusion === "function" ? conclusion(m) : conclusion;
      conclusiones.push(c);
    }
  }

  return conclusiones.length > 0
    ? { tipo: "deductivo", conclusiones, confianza: Math.min(0.9, conclusiones.length * 0.25) }
    : null;
}

// ── Motor lingüístico 2: Analógico ───────────────────────────
// Compara texto actual con memoria causal y documentos históricos
function razonamientoAnalogico(texto, senal) {
  if (!texto || memoriaCausal.length === 0) return null;

  const tokensActual = new Set(tokenizer.tokenize(texto.toLowerCase()) || []);
  let mejor = null, mejorSim = 0;

  for (const recuerdo of memoriaCausal.slice(-50)) {
    const tokensRecuerdo = new Set(tokenizer.tokenize(
      (recuerdo.texto || recuerdo.causa || "").toLowerCase()) || []);

    // Similitud Jaccard
    const inter = [...tokensActual].filter(t => tokensRecuerdo.has(t)).length;
    const union = new Set([...tokensActual, ...tokensRecuerdo]).size;
    const sim   = union > 0 ? inter / union : 0;

    if (sim > mejorSim && sim > 0.15) {
      mejorSim = sim;
      mejor    = recuerdo;
    }
  }

  if (!mejor) return null;

  const tipo_analogia = `Patrón causal previo (similitud=${mejorSim.toFixed(2)})`;

  return {
    tipo:        "analogico",
    similitud:   mejorSim,
    referencia:  mejor.texto || mejor.causa || "",
    contexto:    tipo_analogia,
    refuerza:    mejor.senal === senal,   // ¿el recuerdo tenía la misma señal?
    confianza:   mejorSim
  };
}

// ── Motor lingüístico 3: Reflexivo ───────────────────────────
// Detecta inconsistencias con decisiones recientes propias
function razonamientoReflexivo(senal, ticker = null) {
  // Comparar solo señales del MISMO ticker: mezclar tickers hacía que la
  // diversidad natural entre sectores (XLK SELL, XLE BUY, XLY BUY...) pareciera
  // "alternancia BUY/SELL" → ruido_excesivo permanente → HOLD forzado eterno →
  // cero decisiones BUY/SELL desde el 26/06 → sin verificación ni aprendizaje.
  const propias = ticker
    ? memoriaCognitiva.filter(d => d.ticker === ticker)
    : memoriaCognitiva;
  if (propias.length < 3) return null;

  const ultimas = propias.slice(-10);

  // ¿Misma señal repetida muchas veces?
  const mismaSenalCount = ultimas.filter(d => d.senal === senal).length;
  if (mismaSenalCount >= 8) {
    return {
      tipo:       "reflexivo",
      alerta:     "repeticion_excesiva",
      mensaje:    `${senal} emitida ${mismaSenalCount} de las últimas ${ultimas.length} veces`,
      confianza:  0.3  // baja confianza — posible sesgo
    };
  }

  // ¿Alternancia BUY/SELL/BUY/SELL? (señal ruidosa)
  let alterna = true;
  for (let i = 1; i < Math.min(6, ultimas.length); i++) {
    if (ultimas[i].senal === ultimas[i-1].senal) { alterna = false; break; }
  }
  if (alterna && ultimas.length >= 5) {
    return {
      tipo:       "reflexivo",
      alerta:     "ruido_excesivo",
      mensaje:    "Alternancia BUY/SELL detectada — mercado inestable",
      confianza:  0.2
    };
  }

  // ¿Las últimas decisiones tuvieron buen outcome?
  const conOutcome = ultimas.filter(d => d.outcome !== undefined);
  if (conOutcome.length >= 3) {
    const accuracy = conOutcome.filter(d => d.outcome === "correct").length / conOutcome.length;
    return {
      tipo:       "reflexivo",
      accuracy_reciente: accuracy,
      mensaje:    `Accuracy reciente: ${(accuracy*100).toFixed(0)}%`,
      confianza:  accuracy
    };
  }

  return null;
}

// ── Motor lingüístico 4: Comparativo ─────────────────────────
// Compara condiciones actuales vs promedio histórico
function razonamientoComparativo(señalA) {
  if (memoriaCognitiva.length < 5) return null;

  const histConfianzas = memoriaCognitiva
    .filter(d => d.confianza > 0)
    .map(d => d.confianza);

  if (histConfianzas.length === 0) return null;

  const promedio = histConfianzas.reduce((a,b) => a+b, 0) / histConfianzas.length;
  const diferencia = señalA.confianza - promedio;

  return {
    tipo:          "comparativo",
    confianza_actual: señalA.confianza,
    confianza_promedio_historica: promedio,
    diferencia,
    evaluacion:    diferencia > 0.05  ? "sobre_promedio" :
                   diferencia < -0.05 ? "bajo_promedio"  : "en_promedio",
    confianza:     Math.abs(diferencia) * 2
  };
}

// ── Motor lingüístico 5: Probabilístico ─────────────────────
// Usa los scores numéricos de class25A pero desde perspectiva lingüística
function razonamientoProbabilistico(señalA) {
  const { confianza = 0.5, riesgo = 0.5, score_bayesiano = 0.5, memoria } = señalA;

  const prob_combinada = (confianza * 0.50) + (score_bayesiano * 0.30) + ((1-riesgo) * 0.20);

  const tendencia = prob_combinada > 0.55 ? "positiva" :
                    prob_combinada < 0.40 ? "negativa" : "neutra";

  return {
    tipo:            "probabilistico",
    probabilidad:    prob_combinada,
    tendencia,
    desglose: {
      confianza_ensamble: confianza,
      score_bayesiano,
      riesgo_inverso:     1 - riesgo
    },
    confianza: prob_combinada
  };
}

// ── Evaluación de patrones lingüísticos aprendidos ──────────
function evaluarPatronesAprendidos(texto) {
  if (!texto || Object.keys(patronesLinguisticos).length === 0) return 0;

  let refuerzo = 0;
  let total    = 0;

  // Hoisted: antes se llamaba texto.toLowerCase() una vez POR PATRÓN dentro
  // del loop (500+ veces por evaluación, y esta función corre en cada decisión).
  const txt = texto.toLowerCase();

  for (const [patron, stats] of Object.entries(patronesLinguisticos)) {
    // Un patrón vota solo si el MERCADO lo verificó lo suficiente. Sin este
    // piso, un token con una única verificación afortunada pesaba igual que
    // uno con cincuenta. Y sin evidencia el patrón NO vota: no votar es
    // neutro, mientras que votar con accuracy≈0 era un −1 encubierto.
    const verificados = stats.verificados ?? 0;
    if (verificados < MIN_VERIFICADOS) continue;
    if (txt.includes(patron.toLowerCase())) {
      const accuracyPatron = stats.aciertos / verificados;
      refuerzo += (accuracyPatron - 0.5) * 2; // -1 a +1
      total++;
    }
  }

  return total > 0 ? Math.tanh(refuerzo / total) : 0; // normalizar a (-1, 1)
}

function extraerPatronesClave(texto) {
  if (!texto) return [];
  const tokens = tokenizer.tokenize(texto.toLowerCase()) || [];
  return tokens
    .filter(t => t.length > 4)
    .slice(0, 10)
    .map(t => stemmer.stem(t));
}

// ── Aprendizaje dual ─────────────────────────────────────────
async function aprenderDeOutcome(decisionId, acerto, senal, texto, hash_condicion) {
  // 1. Actualizar patrones lingüísticos
  const patrones = extraerPatronesClave(texto);
  for (const patron of patrones) {
    // Esta ruta solo se invoca con un outcome de mercado ya resuelto, así que
    // acá `verificados` y `usos` sí suben juntos. Era el único de los cinco
    // escritores con la semántica correcta; ahora usa los campos nuevos.
    const p = _patron(patron);
    p.usos++;
    p.verificados++;
    if (acerto) p.aciertos++;
    p.ultima_senal = senal;
  }

  // 2. Actualizar outcome en memoria cognitiva
  const idx = memoriaCognitiva.findIndex(d => d.id === decisionId);
  if (idx >= 0) {
    memoriaCognitiva[idx].outcome = acerto ? "correct" : "incorrect";
  }

  // 3. Aprender relación causal si acertó
  if (acerto && texto) {
    const nuevaCausal = { causa: texto.slice(0, 200), senal, ts: new Date().toISOString() };
    memoriaCausal.push(nuevaCausal);
    if (memoriaCausal.length > MAX_MEMORIA_CAUSAL) memoriaCausal.shift();

    try {
      await guardarCausal({
        causa:     texto.slice(0, 200),
        efecto:    `${senal} acertó`,
        confianza: 0.7
      });
    } catch (_) {}
  }

  // 4. Enviar feedback a class25A para actualizar pesos de redes
  try {
    await redisPub.publish(CH_FEEDBACK_A, JSON.stringify({
      id:              decisionId,
      acerto,
      hash_condicion,
      ts:              new Date().toISOString()
    }));
  } catch (_) {}

  // 5. Guardar estado cada 5 aprendizajes
  const totalAprendizajes = Object.values(patronesLinguisticos)
    .reduce((acc, p) => acc + (p.verificados || 0), 0);
  if (totalAprendizajes % 5 === 0) await guardarEstado();

  log(`🎓 Aprendizaje dual: ${acerto ? "✅" : "❌"} ${senal} | patrones actualizados: ${patrones.length}`);
}

// ── Redacción de la decisión final ──────────────────────────
// ── Redacción interna (fallback si no hay Gemini) ──────────
function _redactarInterno(señalA, razonamientos, portfolio = null) {
  const { senal, ticker, confianza, horizonte, stop_loss, riesgo, texto_numerico } = señalA;
  const { deductivo, analogico, reflexivo, comparativo } = razonamientos;
  const partes = [texto_numerico || ""];

  if (deductivo?.conclusiones?.length > 0)
    partes.push(`Análisis: ${deductivo.conclusiones.join("; ")}.`);
  if (analogico?.similitud > 0.2) {
    const tipo = analogico.refuerza ? "refuerza" : "contradice";
    partes.push(`Analogía histórica ${tipo} la señal (${(analogico.similitud*100).toFixed(0)}% similitud).`);
  }
  if (reflexivo?.alerta) partes.push(`⚠️ ${reflexivo.mensaje}.`);

  // Incluir portfolio si está disponible
  if (portfolio?.activos?.length > 0) {
    const top3 = portfolio.activos.slice(0, 3)
      .map(a => `${a.symbol} ${a.peso_pct}%`)
      .join(", ");
    partes.push(`Portfolio sugerido: ${top3} (riesgo ${portfolio.riesgo_pct}%, confianza ${portfolio.confianza_pct}%).`);
  }

  const nivel = confianza > 0.65 ? "alta" : confianza > 0.45 ? "moderada" : "baja";
  partes.push(`${senal} ${ticker} | confianza ${nivel} (${(confianza*100).toFixed(0)}%) | horizonte ${horizonte} | stop_loss ${((stop_loss||0.03)*100).toFixed(1)}%.`);
  return partes.filter(Boolean).join(" ");
}

// ── Redacción con Gemini ────────────────────────────────────
async function redactarConGemini(señalA, razonamientos, perfil = null) {
  // La puerta ya no la abre sólo Gemini: con MIIA_LLM=local no hay modelo de
  // Gemini y el motor local tiene que poder contestar igual.
  const _hayLocal  = LLM_USA_LOCAL  && !LLM.cortado();
  const _hayGemini = LLM_USA_GEMINI && _geminiReady();
  if (!_hayLocal && !_hayGemini) return null;

  const { senal, ticker, confianza, riesgo, horizonte, stop_loss, texto_numerico,
          scores, pesos, memoria } = señalA;
  const { deductivo, analogico, reflexivo, probabilistico } = razonamientos;

  // Construir contexto del perfil del usuario
  const nivelUsuario = perfil?.nivel_experiencia || "intermedio";
  const tolerancia   = perfil?.tolerancia_riesgo || "moderado";

  // Prompt según nivel del usuario
  const esExperimentado = nivelUsuario === "avanzado" || nivelUsuario === "experto";

  // Incluir alertas activas en el contexto de Gemini
  const alertasContexto = alertasActivas.length > 0
    ? `
ALERTAS DE MERCADO ACTIVAS:
${alertasActivas.map(a => `- [${a.nivel}] ${_alertaLegible(a)}`).join("\n")}
Si hay alertas CRITICO o PELIGRO, mencionarlas al usuario de forma clara pero sin alarmismo.`
    : "";

  // Obtener portfolio actual de MySQL para incluirlo en la recomendación
  const portfolioActual = await obtenerUltimoPortfolio(
    perfil?.user_id || "general"
  ).catch(() => null);

  // Construir sección de portfolio para el prompt
  const seccionPortfolio = portfolioActual?.activos?.length > 0
    ? `
PORTFOLIO RECOMENDADO (generado por MIIA en base al mercado actual):
- Estrategia: ${portfolioActual.strategy}
- Riesgo del portfolio: ${portfolioActual.riesgo_pct}%
- Confianza: ${portfolioActual.confianza_pct}%
- Activos seleccionados (${portfolioActual.n_activos}):
${portfolioActual.activos.map(a => {
  const chg = parseFloat(a.change_pct ?? 0);
  return `  • ${a.symbol} (${a.sector || "–"}): ${parseFloat(a.peso_pct ?? 0).toFixed(1)}% del portfolio, cambio ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%, estado ${a.estado_sector || "–"}`;
}).join("\n")}

IMPORTANTE: Mencioná los activos específicos con sus porcentajes al responder.
Explicá al usuario POR QUÉ ese activo fue seleccionado (sector, momentum, riesgo).`
    : "";

  const prompt = `Eres MIIA, un sistema de análisis de mercados financieros.
Recibís datos cuantitativos y los explicás en lenguaje natural.

DATOS DEL ANÁLISIS:
- Señal: ${senal} ${ticker}
- Confianza: ${(confianza*100).toFixed(0)}%
- Riesgo: ${(riesgo*100).toFixed(0)}%
- Horizonte: ${horizonte}
- Stop Loss: ${((stop_loss||0.03)*100).toFixed(1)}%
- Contexto numérico: ${texto_numerico || ""}
${memoria?.condiciones_similares > 0 ?
  `- Memoria bayesiana: ${memoria.aciertos} de ${memoria.condiciones_similares} condiciones históricas similares resultaron en la misma dirección.` : ""}
${deductivo?.conclusiones?.length > 0 ?
  `- Análisis deductivo: ${deductivo.conclusiones.join("; ")}` : ""}
${analogico?.similitud > 0.2 ?
  `- Analogía histórica: ${analogico.refuerza ? "refuerza" : "contradice"} la señal (${(analogico.similitud*100).toFixed(0)}% similitud)` : ""}
${reflexivo?.alerta ? `- Alerta: ${reflexivo.mensaje}` : ""}
${seccionPortfolio}

${alertasContexto}
PERFIL DEL USUARIO:
- Nivel: ${nivelUsuario}
- Tolerancia al riesgo: ${tolerancia}

INSTRUCCIONES:
Redactá UNA respuesta conversacional de 3-4 oraciones.
${portfolioActual?.activos?.length > 0
  ? "OBLIGATORIO: mencioná los activos del portfolio con sus porcentajes. Explicá brevemente el razonamiento de la selección."
  : ""}
${esExperimentado
  ? "El usuario es avanzado: podés incluir términos técnicos."
  : "El usuario es " + nivelUsuario + ": usá lenguaje simple. Explicá qué significa el porcentaje de confianza."}
No uses markdown, no uses asteriscos. Hablá directamente al usuario.
Terminá con una acción concreta que el usuario puede tomar.`;

  // ── 1) Motor LOCAL ──
  if (LLM_USA_LOCAL && !LLM.cortado()) {
    try {
      const r = await LLM.generar({ prompt, maxTokens: LLM_LOCAL_MAX_TOKENS, temperatura: 0.7 });
      _llmLocalUsos++;
      log(`✅ ${r.modelo} redactó local (${r.texto.length} chars, ${r.ms} ms, ${r.tps} tok/s)`);
      return r.texto;
    } catch (e) {
      _llmLocalFallos++;
      log(`⚠️ motor local falló en la redacción: ${e.message}`, "warn");
    }
  }

  // ── 2) Gemini (respaldo) ──
  if (!LLM_USA_GEMINI || !_geminiReady()) return null;
  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: GEMINI_MAX_TOKENS, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } }
    });
    _gemini429StreakReset();
    return result.response.text().trim();
  } catch (e) {
    _handleGeminiError(e, "(redacción)");
    return null;
  }
}

// ── Aprender del estilo de Gemini (MLLs) ────────────────────
// Extrae unigrams + bigrams de cada respuesta de Gemini.
// Los bigrams capturan frases financieras ("momentum_positivo", "señal_cuantitativa").
// La confianza de la señal pondera cuánto aprende: alta conf → aprende más.
// Persiste en JSON Y en la tabla learning_cycles de MySQL.
function aprenderDeRespuestaGemini(textoGemini, señalA) {
  if (!textoGemini || textoGemini.length < 20) return;

  const conf  = parseFloat(señalA?.confianza ?? 0.6);
  // Peso: señales de alta confianza enseñan más
  const peso  = conf > 0.75 ? 1.5 : conf > 0.55 ? 1.0 : 0.6;

  const palabras = textoGemini.toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 4);

  // Unigrams
  const unigrams = palabras.slice(0, 30);
  // Bigrams: pares de palabras consecutivas → captura frases de dominio
  const bigrams = [];
  for (let i = 0; i < Math.min(palabras.length - 1, 25); i++) {
    bigrams.push(`${palabras[i]}_${palabras[i + 1]}`);
  }

  const tokens = [...unigrams, ...bigrams];

  for (const tok of tokens) {
    const p = _patron(tok);
    p.usos++;
    p.gemini_source++;
    p.peso_acum = (p.peso_acum || 0) + peso;
    // NO se tocan `aciertos` ni `verificados`.
    //
    // El v3 hacía acá: aciertos = floor(total * (0.5 + conf*0.3)), o sea
    // fabricaba una tasa de acierto a partir de la confianza del LLM. La idea
    // (usar a Gemini como prior) es defendible, pero escribía en el MISMO
    // campo que después se lee como evidencia empírica de mercado: aguas
    // abajo, prior y evidencia quedaban indistinguibles. El prior vive en
    // `peso_acum`/`gemini_source`, que no entran en accuracy.
  }

  const totalPatrones = Object.keys(patronesLinguisticos).length;
  if (totalPatrones % 30 === 0) {
    log(`📚 MLLs: ${totalPatrones} patrones aprendidos (unigrams+bigrams)`);
    guardarEstado().catch(() => {});
    // Persistir evento de aprendizaje en DB
    _guardarLearningCycle(conf, tokens.length, "gemini_response").catch(() => {});
  }
}

// ── Persistir evento de aprendizaje en learning_cycles ────────
async function _guardarLearningCycle(confianza, n_patrones, modulo_sub = "general") {
  try {
    await dbQuery(
      `INSERT INTO learning_cycles (decision_id, prediccion, resultado_real, error_delta, modulo, ts)
       VALUES (NULL, ?, ?, ?, ?, NOW(3))`,
      [confianza, n_patrones, Math.abs(confianza - 0.5), `class25B_${modulo_sub}`]
    );
  } catch (_) { /* no bloquear por errores de DB */ }
}

// ── Función principal de redacción ─────────────────────────
async function redactarDecisionFinal(señalA, razonamientos, perfil = null) {
  // ── Camino de SISTEMA: no gasta cuota de Gemini ────────────────────────
  // Esta función corre una vez por DECISIÓN EMITIDA. Es, por lejos, el mayor
  // consumidor de la API — y su salida es un texto que el usuario casi nunca
  // lee directamente (va al feed y a la DB). Gastarla acá es lo que dejaba al
  // chat sin cuota. El redactor interno produce el mismo campo sin salir a la red.
  if (GEMINI_SOLO_USUARIO) {
    _geminiAhorradas++;
    const portfolio = await obtenerUltimoPortfolio(
      perfil?.user_id || "general"
    ).catch(() => null);
    return _redactarInterno(señalA, razonamientos, portfolio);
  }

  // FASE 1: intentar con Gemini (18 meses)
  if (geminiModel) {
    const textoGemini = await redactarConGemini(señalA, razonamientos, perfil);
    if (textoGemini) {
      aprenderDeRespuestaGemini(textoGemini, señalA);
      return textoGemini;
    }
  }

  // FASE 2: fallback con portfolio incluido si está disponible
  const portfolio = await obtenerUltimoPortfolio(
    perfil?.user_id || "general"
  ).catch(() => null);
  return _redactarInterno(señalA, razonamientos, portfolio);
}

// ── Procesador de señal de class25A ──────────────────────────
async function procesarSeñalCuantitativa(señalA) {
  try {
    // El chat guarda el puesto de cada instrumento en el ranking (O(1), sin DB).
    _chatAnotarRanking(señalA);
    const { senal, ticker, confianza, ts, id: id_a, texto_numerico, hash_condicion } = señalA;

    log(`📥 class25A: ${senal} ${ticker} conf=${confianza?.toFixed(3)}`);

    // ── Motor de Alertas (SIEMPRE corre, independiente del cooldown) ──────
    // Las alertas de crisis son urgentes — no esperan el cooldown de decisiones
    await procesarYPublicarAlertas(señalA);

    // Cooldown POR TICKER (antes era global — ver LAST_DECISION_BY_TICKER)
    const now      = Date.now();
    const restante = _cooldownActivo(ticker, senal, now);
    if (restante > 0) {
      _descartesCooldown++;
      log(`⏳ Cooldown ${ticker || "GENERAL"}/${senal} (${Math.round(restante/1000)}s restantes) ` +
          `[descartadas: ${_descartesCooldown} | publicadas: ${_publicadas}]`);
      return;
    }

    // Refuerzo de patrones aprendidos
    const refuerzo = evaluarPatronesAprendidos(texto_numerico);
    const confianza_ajustada = Math.min(0.99, Math.max(0.01,
      confianza + refuerzo * 0.05));

    // ── Gate de convicción del SELL (nivel ensemble) ──────────────────────
    // Un SELL por debajo del umbral tiene <50% de acierto histórico → se suprime
    // (se convierte en HOLD y no se emite a ningún lado). Corte temprano, mismo
    // criterio que el HOLD por ruido de más abajo.
    if (GATE_SELL_ENSEMBLE && senal === "SELL" && confianza_ajustada < UMBRAL_SELL_CONF) {
      log(`🚫 SELL suprimido: confianza ${(confianza_ajustada*100).toFixed(0)}% < ` +
          `umbral ${(UMBRAL_SELL_CONF*100).toFixed(0)}% → HOLD`, "warn");
      _marcarDecision(ticker, senal, now);
      // Registro SOMBRA: no se emite, pero queda pendiente en la DB para que el
      // loop de reconciliación de class43 lo verifique igual. Así medimos qué
      // habría hecho este SELL sin actuar sobre él. temperatura='shadow' lo
      // mantiene fuera de las métricas vivas.
      if (GATE_SELL_SHADOW) {
        try {
          await guardarDecision({
            ticker,
            senal:           "SELL",
            confianza:       confianza_ajustada,
            temperatura:     "shadow",
            razon:           `[SOMBRA] SELL suprimido por gate (conf ${(confianza_ajustada*100).toFixed(0)}% < ${(UMBRAL_SELL_CONF*100).toFixed(0)}%)`,
            horizonte_horas: señalA.horizonte_horas || 24,
            // También en las sombra: son las que miden qué habría hecho el
            // SELL suprimido, así que necesitan el mismo score para entrar en
            // la sección transversal del rank IC.
            score:           señalA.score ?? señalA.score_final,
            decision_modo:   señalA.decision_modo,
          });
        } catch (e) { log(`⚠️ shadow guardarDecision: ${e?.message}`, "warn"); }
      }
      await redisPub.publish(CH_UI, JSON.stringify({
        type:      "signal",
        senal:     "HOLD",
        ticker:    ticker || "GENERAL",
        confianza: confianza_ajustada,
        texto:     `SELL de baja convicción (${(confianza_ajustada*100).toFixed(0)}%) suprimido — HOLD preventivo.`,
        ts:        new Date().toISOString(),
        sell_gate: true,
      })).catch(() => {});
      return;
    }

    // ── SOMBRA-HOLD: SELL bajista fuerte que el ensemble dejó en HOLD ──────
    // NO cambia la decisión (sigue siendo HOLD y se publica normal); solo
    // registra en sombra el SELL que el umbral de un solo lado de class25A
    // escondió, para medir en 1-2 semanas si esos bajistas ocultos acertaban.
    if (SHADOW_HOLD_SELL && GATE_SELL_SHADOW && senal === "HOLD") {
      const _sf = parseFloat(señalA.score_final ?? señalA.ensemble_score);
      if (isFinite(_sf) && _sf < HOLD_SELL_SCORE_MAX) {
        const _conv = Math.min(0.99, Math.max(0.01, (0.5 - _sf) * 2));
        guardarDecision({
          ticker,
          senal:           "SELL",
          confianza:       parseFloat(_conv.toFixed(4)),
          temperatura:     "shadow",
          razon:           `[SOMBRA-HOLD] bajista oculto en HOLD (score_final ${_sf.toFixed(3)}, tend ${señalA.tendencia || "?"}, conv ${_conv.toFixed(2)})`,
          horizonte_horas: señalA.horizonte_horas || 24,
        }).catch(e => log(`⚠️ shadow-HOLD: ${e?.message}`, "warn"));
      }
    }

    // Ejecutar 5 motores lingüísticos
    const razonamientos = {
      deductivo:      razonamientoDeductivo(texto_numerico),
      analogico:      razonamientoAnalogico(texto_numerico, senal),
      reflexivo:      razonamientoReflexivo(senal, ticker),
      comparativo:    razonamientoComparativo(señalA),
      probabilistico: razonamientoProbabilistico(señalA)
    };

    // Rationale para logging
    const rationale = Object.entries(razonamientos)
      .filter(([,v]) => v !== null)
      .map(([k,v]) => `${k}:${v?.confianza?.toFixed(2)||"?"}`);

    log(`🧠 Razonamientos activos: ${rationale.join(", ")}`);

    // Alerta reflexiva grave → forzar HOLD y avisar al UI
    if (razonamientos.reflexivo?.alerta === "ruido_excesivo") {
      _ruidoForzados++;
      log(`⚠️ Ruido excesivo detectado — HOLD forzado (${_ruidoForzados} consecutivos)`, "warn");
      // Actualizar cooldown POR TICKER para no re-procesar en la próxima señal
      _marcarDecision(ticker, senal, now);

      // ── FIX DEL DEADLOCK ────────────────────────────────────────────────
      // memoriaCognitiva SOLO se actualizaba en el camino feliz (~línea 1505),
      // DESPUÉS de este return. Eso creaba una trampa cerrada:
      //   1. la memoria tiene un patrón alternado BUY/SELL
      //   2. → se marca ruido_excesivo
      //   3. → la señal se descarta con `return` y NUNCA entra a la memoria
      //   4. → la memoria no cambia → volver a 2, para siempre
      // La única forma de salir era guardar señales nuevas, y justamente se
      // negaba a guardarlas. Consecuencia real (2026-07-28): cero escrituras en
      // cognitive_decisions durante 12 h, verificadas congeladas, sin feedback
      // y sin aprendizaje. Ya había pasado antes (ver comentario en
      // razonamientoReflexivo: "cero decisiones BUY/SELL desde el 26/06").
      //
      // Registrar el HOLD —que es lo que el sistema REALMENTE emitió al UI—
      // hace que el patrón se rompa solo tras unas pocas iteraciones.
      memoriaCognitiva.push({
        id:        uuidv4(),
        senal:     "HOLD",
        ticker:    ticker || "GENERAL",
        confianza: 0.2,
        texto:     "HOLD forzado por ruido_excesivo",
        ts:        new Date().toISOString(),
        outcome:   undefined,
      });
      if (memoriaCognitiva.length > MAX_MEMORIA_COG) memoriaCognitiva.shift();
      // Publicar HOLD con razón explícita al UI
      await redisPub.publish(CH_UI, JSON.stringify({
        type:      "signal",
        senal:     "HOLD",
        ticker:    ticker || "GENERAL",
        confianza: 0.2,
        texto:     "⚠️ Mercado inestable: alternancia BUY/SELL detectada. HOLD preventivo.",
        ts:        new Date().toISOString(),
        ruido:     true,
      })).catch(() => {});
      return;
    }

    // Redactar texto final enriquecido
    // Obtener perfil del usuario (publicado por class14 via class14_output)
    const perfil_actual = perfilUsuarioActual || null;
    const texto_final = await redactarDecisionFinal(señalA, razonamientos, perfil_actual);

    // Construir decisión final
    const decision_id = uuidv4();
    _marcarDecision(ticker, senal, now);
    _publicadas++;

    const thought = {
      id:           decision_id,
      source:       "class25B",
      origin:       "class25B",
      ts:           new Date().toISOString(),
      ts_a:         ts,
      id_a,

      // Señal de class25A (preservada íntegra)
      senal:        senal,
      ticker:       ticker,
      confianza:    confianza_ajustada,
      horizonte:    señalA.horizonte,
      stop_loss:    señalA.stop_loss,
      riesgo:       señalA.riesgo,

      // Texto enriquecido por class25B
      texto:        texto_final,
      decision:     texto_final,
      texto_numerico,

      // Razonamientos
      razonamientos,
      rationale,
      refuerzo_linguistico: refuerzo,

      // Contexto para aprendizaje
      hash_condicion,
      scores:       señalA.scores,
      pesos:        señalA.pesos,
      ensemble_score: señalA.ensemble_score,

      final: true
    };

    // Publicar a class25_output
    await redisPub.publish(CH_OUT, JSON.stringify(thought));

    // UI stream
    await redisPub.publish(CH_UI, JSON.stringify({
      type:      "signal",
      senal,
      ticker,
      confianza: confianza_ajustada,
      horizonte: señalA.horizonte,
      texto:     texto_final.slice(0, 300),
      ts:        thought.ts
    })).catch(() => {});

    // Guardar en MySQL
    try {
      await guardarDecision({
        origen:     "class25B",
        externalId: decision_id,
        senal,
        decision:   senal,
        contexto:   texto_final.slice(0, 5000),
        rationale,
        confianza:  confianza_ajustada,
        ticker,
        // Se persiste para que class43 pueda devolverle el outcome a la memoria
        // bayesiana de class25A al verificar (cierra el lazo de aprendizaje).
        hash_condicion,
        horizonte:  señalA.horizonte_horas || 24,
        // ── El score y la regla que decidió ────────────────────────────────
        // class25A los publica desde el ranking transversal; hasta hoy class25B
        // los descartaba y la columna `score` quedaba en NULL en el 100 % de las
        // filas. Sin esto el rank IC tiene que reconstruir el número parseando
        // la razón en castellano, y `decision_modo` es lo único que permite
        // separar en SQL las decisiones por ranking de las de la banda vieja
        // — o sea, los dos brazos del experimento del 12-oct.
        score:         señalA.score ?? señalA.score_final,
        decision_modo: señalA.decision_modo,
      });
    } catch (e) {
      log(`⚠️ guardarDecision: ${e?.message}`, "warn");
    }

    // Backtesting solo para BUY/SELL
    if (senal !== "HOLD") {
      try {
        await guardarBacktestingRun({
          nombre:    `${senal}_${ticker}_${decision_id.slice(0,8)}`,
          ticker,
          senal,
          confianza: confianza_ajustada,
          horizonte: señalA.horizonte_horas || 24,
        });
      } catch (_) {}
    }

    // Registrar en memoria cognitiva
    memoriaCognitiva.push({
      id:       decision_id,
      senal,
      ticker,
      confianza: confianza_ajustada,
      texto:    texto_numerico?.slice(0, 200) || "",
      ts:       thought.ts,
      outcome:  undefined  // se llena cuando llega feedback
    });
    if (memoriaCognitiva.length > MAX_MEMORIA_COG) memoriaCognitiva.shift();

    // Se publicó una decisión real → el filtro de ruido ya no está trabado.
    if (_ruidoForzados > 0) {
      log(`🔓 Filtro de ruido liberado tras ${_ruidoForzados} HOLD forzados`);
      _ruidoForzados = 0;
    }

    log(`✅ Decisión publicada: ${senal} ${ticker} | conf_orig=${confianza?.toFixed(3)} conf_ajust=${confianza_ajustada.toFixed(3)} | refuerzo=${refuerzo.toFixed(3)}`);

    // Guardar señal en signals_feed para historial del usuario en la UI
    guardarSeñalFeed({
      signal_id:   decision_id,
      user_id:     "general",
      senal,
      ticker,
      confianza:   confianza_ajustada,
      horizonte:   señalA.horizonte_horas || 24,
      stop_loss:   señalA.stop_loss,
      riesgo:      señalA.riesgo,
      texto:       texto_final.slice(0, 3000),
      fuente:      "class25B",
    }).catch(() => {});
    log(`📝 ${texto_final.slice(0, 150)}`);

  } catch (e) {
    log(`❌ procesarSeñalCuantitativa: ${e?.message}`, "error");
  }
}

// ── Helper: query devuelve {recordset:[...]} → extraer array ──
function _rows(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.recordset)) return result.recordset;
  return [];
}

// ════════════════════════════════════════════════════════════════
// ACCESO PROFUNDO A BASE DE DATOS — consultarDB
// ────────────────────────────────────────────────────────────────
// Detecta la intención de la pregunta y consulta tablas relevantes:
//   portfolio    → portfolios + portfolio_assets (todos los recientes)
//   crisis       → crisis_events + causal_memory relacionada
//   noticias     → sentiment_signals + signals_feed
//   estabilidad  → performance_snapshots + backtesting_runs
//   riesgo       → cognitive_decisions + sistema
//   causalidad   → causal_memory (por qué el sistema tomó decisiones)
// ════════════════════════════════════════════════════════════════

function _detectarIntencion(texto) {
  const t = texto.toLowerCase();
  // Se arma del universo compartido. La copia a mano que había acá tenía 16
  // símbolos y la de más abajo 14, y ninguna de las dos coincidía con la lista
  // que se cotiza. Ordenado por largo para que XLRE matchee antes que XLR…
  const TICKERS_RE = new RegExp(
    "\\b(" + [...TICKERS_TEXTO].sort((a, b) => b.length - a.length).join("|") + ")\\b", "i");
  const tickerMatch = texto.match(TICKERS_RE);
  return {
    portfolio:        /portafolio|portfolio|cartera|activos|invertir|inversión|recomiend|armar|diversif|composici/i.test(t),
    crisis:           /crisis|burbuja|crash|caída total|recesión|histórica|2008|1929|argentina|hyperinflac|colapso/i.test(t),
    noticias:         /noticia|sentimiento|sentiment|prensa|medios|titular|news|impacto|headlines?/i.test(t),
    estabilidad:      /estabilidad|estable|consistente|backtesting|precisi|accuracy|rendimiento|performance|sharpe|drawdown|sortino|cagr/i.test(t),
    riesgo:           /riesgo|risk|volatil|seguro|peligro|nivel de riesgo|cuánto riesgo/i.test(t),
    causalidad:       /por qué|porque|porqué|razón|motivo|explicá|explica|cómo decidiste|fundamento|análisis|recomendás|recomiendas|justif/i.test(t),
    señales:          /señal|senal|buy|sell|hold|comprar|vender|ticker|símbolo/i.test(t),
    lstm:             /lstm|predictivo|neuronal|red neuronal|predicción|prediccion|modelo|deep.?learn/i.test(t),
    precios:          /precio|cotización|cotizacion|cuánto (cuesta|vale|está|cotiza)|valor actual|precio actual/i.test(t),
    ticker_especifico: tickerMatch ? tickerMatch[0].toUpperCase() : null,
  };
}

async function _consultarDB(intencion) {
  const datos = {};

  const queries = [];

  // ── Portfolios: todos los recientes con activos y razonamiento ──
  if (intencion.portfolio || intencion.riesgo) {
    queries.push(
      dbQuery(`
        SELECT p.portfolio_id, p.strategy,
               ROUND(p.confidence*100,1)   AS confianza_pct,
               ROUND(p.risk_level*100,1)   AS riesgo_pct,
               ROUND(p.riesgo_global*100,1) AS riesgo_global_pct,
               p.n_activos, p.status,
               DATE_FORMAT(p.ts,'%d/%m/%Y %H:%i') AS fecha
        FROM portfolios p
        ORDER BY p.ts DESC LIMIT 5
      `)
      .then(async rows => {
        if (!rows.length) return;
        // Para cada portfolio traer sus activos
        const portfoliosConActivos = await Promise.all(rows.map(async port => {
          const activos = await dbQuery(`
            SELECT symbol, sector,
                   ROUND(peso*100,1)      AS peso_pct,
                   ROUND(change_pct,1)    AS cambio_pct,
                   ROUND(riesgo*100,1)    AS riesgo_pct,
                   ROUND(confianza*100,1) AS confianza_pct,
                   estado_sector
            FROM portfolio_assets
            WHERE portfolio_id = ?
            ORDER BY peso DESC LIMIT 10
          `, [port.portfolio_id]);
          return { ...port, activos };
        }));
        datos.portfolios = portfoliosConActivos;
        datos.portfolioActual = portfoliosConActivos[0] || null;
      }).catch(() => {})
    );
  }

  // ── Crisis históricas con descripción y causalidad ────────────
  if (intencion.crisis || intencion.causalidad) {
    queries.push(
      dbQuery(`
        SELECT nombre, anio_inicio, anio_fin, tipo, severidad,
               LEFT(descripcion,400) AS descripcion
        FROM crisis_events
        ORDER BY severidad DESC, anio_inicio DESC LIMIT 8
      `)
      .then(rows => { datos.crisis = rows; })
      .catch(() => {})
    );
  }

  // ── Memoria causal: por qué el sistema tomó cada decisión ─────
  if (intencion.causalidad || intencion.señales) {
    queries.push(
      dbQuery(`
        SELECT LEFT(causa,300) AS causa, LEFT(efecto,200) AS efecto,
               ROUND(confianza*100,1) AS confianza_pct, repeticiones,
               DATE_FORMAT(ultimo_refuerzo,'%d/%m/%Y') AS ultima_vez
        FROM causal_memory
        ORDER BY confianza DESC, repeticiones DESC LIMIT 10
      `)
      .then(rows => { datos.causalidad = rows; })
      .catch(() => {})
    );
  }

  // ── Señales y decisiones con razonamiento completo ───────────
  if (intencion.señales || intencion.riesgo || intencion.causalidad) {
    queries.push(
      dbQuery(`
        SELECT senal, ticker, ROUND(confianza*100,1) AS confianza_pct,
               LEFT(razon,500) AS razon,
               outcome_real, temperatura,
               DATE_FORMAT(ts_decision,'%d/%m/%Y %H:%i') AS fecha
        FROM cognitive_decisions
        ORDER BY ts_decision DESC LIMIT 10
      `)
      .then(rows => { datos.decisiones = rows; })
      .catch(() => {})
    );
  }

  // ── Sentimiento noticias ───────────────────────────────────────
  if (intencion.noticias || intencion.estabilidad) {
    queries.push(
      dbQuery(`
        SELECT ticker, senal, sentiment_label,
               ROUND(sentiment_score*100,1) AS score_pct,
               n_articulos,
               DATE_FORMAT(ts,'%d/%m/%Y %H:%i') AS fecha
        FROM sentiment_signals
        ORDER BY ts DESC LIMIT 10
      `)
      .then(rows => { datos.sentimiento = rows; })
      .catch(() => {})
    );
  }

  // ── Rendimiento histórico y estabilidad del sistema ──────────
  if (intencion.estabilidad || intencion.riesgo) {
    queries.push(
      dbQuery(`
        SELECT DATE_FORMAT(fecha,'%d/%m/%Y') AS fecha,
               total_decisiones, decisiones_correctas,
               ROUND(accuracy_pct,1) AS accuracy_pct,
               ROUND(sharpe_ratio,3) AS sharpe,
               ROUND(coherencia_promedio*100,1) AS coherencia_pct
        FROM performance_snapshots
        ORDER BY fecha DESC LIMIT 7
      `)
      .then(rows => { datos.performance = rows; })
      .catch(() => {}),

      dbQuery(`
        SELECT senal, ticker,
               ROUND(confianza*100,1) AS confianza_pct,
               estado, nombre,
               DATE_FORMAT(ts_inicio,'%d/%m/%Y') AS fecha
        FROM backtesting_runs
        WHERE estado IN ('completado','activo')
        ORDER BY ts_inicio DESC LIMIT 10
      `)
      .then(rows => { datos.backtesting = rows; })
      .catch(() => {})
    );
  }

  // ── PDFs de crisis cargados (documentos de referencia) ───────
  if (intencion.crisis || intencion.causalidad) {
    queries.push(
      dbQuery(`
        SELECT nombre, tipo,
               DATE_FORMAT(fecha_documento,'%d/%m/%Y') AS fecha_doc,
               num_paginas
        FROM pdf_documents
        WHERE procesado = 1
        ORDER BY fecha_documento DESC LIMIT 5
      `)
      .then(rows => { datos.documentos = rows; })
      .catch(() => {})
    );
  }

  // ── Noticias reales de la tabla noticias (class1 las almacena) ─
  // Siempre útiles para explicar el "por qué" de una señal
  {
    const tkr = intencion.ticker_especifico;
    const where = tkr
      ? `WHERE (ticker = '${tkr}' OR titulo LIKE '%${tkr}%') AND COALESCE(ts_publicado, ts_guardado) > DATE_SUB(NOW(), INTERVAL 48 HOUR)`
      : `WHERE COALESCE(ts_publicado, ts_guardado) > DATE_SUB(NOW(), INTERVAL 24 HOUR)`;
    queries.push(
      dbQuery(`
        SELECT titulo, LEFT(snippet,200) AS snippet, fuente, ticker, sentimiento,
               DATE_FORMAT(COALESCE(ts_publicado,ts_guardado),'%d/%m %H:%i') AS fecha
        FROM noticias ${where}
        ORDER BY COALESCE(ts_publicado,ts_guardado) DESC LIMIT 8
      `)
      .then(rows => { datos.noticias_reales = rows; })
      .catch(() => {})
    );
  }

  // ── backtesting_stats: fundamenta con precisión real ─────────
  // Siempre incluir para que Gemini pueda citar números reales
  queries.push(
    dbQuery(`
      SELECT fecha, correctas, total_verificadas,
             ROUND(accuracy_global*100,1)   AS acc_pct,
             ROUND(accuracy_30d*100,1)      AS acc30_pct,
             ROUND(precision_buy*100,1)     AS prec_buy,
             ROUND(precision_sell*100,1)    AS prec_sell,
             ROUND(retorno_promedio*100,3)  AS ret_pct,
             ROUND(sharpe,3)               AS sharpe,
             ROUND(max_drawdown*100,1)      AS drawdown_pct
      FROM backtesting_stats
      ORDER BY fecha DESC LIMIT 3
    `)
    .then(rows => { datos.backtesting_stats = rows; })
    .catch(() => {})
  );

  // ── Precios recientes por ticker (últimas 24h) ────────────────
  if (intencion.precios || intencion.ticker_especifico || intencion.señales) {
    const tkr = intencion.ticker_especifico;
    const where = tkr
      ? `WHERE ticker = '${tkr}' AND ts > DATE_SUB(NOW(), INTERVAL 48 HOUR)`
      : `WHERE ts > DATE_SUB(NOW(), INTERVAL 24 HOUR)`;
    queries.push(
      dbQuery(`
        SELECT ticker,
               ROUND(AVG(precio),2)     AS precio_prom,
               ROUND(AVG(change_pct),4) AS cambio_pct,
               ROUND(AVG(riesgo),4)     AS riesgo,
               ROUND(AVG(score),4)      AS score,
               COUNT(*)                 AS muestras
        FROM precios ${where}
        GROUP BY ticker ORDER BY ticker LIMIT 15
      `)
      .then(rows => { datos.precios = rows; })
      .catch(() => {})
    );
  }

  // ── LSTM predictions history de class44 ──────────────────────
  if (intencion.lstm || intencion.señales || intencion.ticker_especifico || intencion.causalidad) {
    const tkr = intencion.ticker_especifico;
    const where = tkr ? `WHERE ticker = '${tkr}'` : "";
    queries.push(
      dbQuery(`
        SELECT ticker, senal, ROUND(confianza*100,1) AS conf_pct,
               ROUND(prob_buy*100,1)  AS p_buy,
               ROUND(prob_sell*100,1) AS p_sell,
               ROUND(rsi,1)          AS rsi,
               horizonte, outcome_real,
               DATE_FORMAT(ts,'%d/%m %H:%i') AS fecha
        FROM lstm_predictions ${where}
        ORDER BY ts DESC LIMIT 10
      `)
      .then(rows => { datos.lstm_predictions = rows; })
      .catch(() => {})
    );
  }

  await Promise.allSettled(queries);
  return datos;
}

// ── Adaptar activos de portfolio según perfil de riesgo del usuario ──────
// class15 genera UN solo portfolio "balanced" a partir del riesgo de mercado
// (no uno por perfil). Sin este filtro, conservador/moderado/agresivo recibían
// exactamente los mismos activos y pesos — solo cambiaba una frase de relleno.
// Acá reordenamos/recortamos esos mismos activos para que la recomendación
// realmente difiera: conservador prioriza menor riesgo, agresivo prioriza
// mayor momentum/riesgo, moderado mantiene el orden original (por peso).
function _adaptarActivosPerfil(activos, perfil) {
  if (!activos?.length) return activos || [];
  const arr = [...activos];
  const riesgoOf  = a => parseFloat(a.riesgo_pct ?? 50);
  const cambioOf  = a => parseFloat(a.cambio_pct ?? a.change_pct ?? 0);

  if (perfil === "conservador") {
    return arr.sort((a, b) => riesgoOf(a) - riesgoOf(b)).slice(0, 4);
  }
  if (perfil === "agresivo") {
    return arr.sort((a, b) => (cambioOf(b) - cambioOf(a)) || (riesgoOf(b) - riesgoOf(a)));
  }
  // moderado / sin perfil → orden original (por peso, ya viene de la DB)
  return arr;
}

// ── Contexto completo del sistema (MySQL + in-memory + DB profunda) ─────
async function _construirContextoCompleto(texto = "") {
  const intencion = _detectarIntencion(texto);

  const ctx = {
    portfolio:    null,
    portfolios:   [],
    decisiones:   [],
    señalesFeed:  [],
    riesgoGlobal: historialRiesgo[historialRiesgo.length - 1] ?? 0.5,
    alertas:      alertasActivas,
    senalesHist:  historialSenales.slice(-5),
    cognitiva:    memoriaCognitiva.length,
    regimen:      null,
    // Datos extendidos de la DB
    crisis:       [],
    causalidad:   [],
    sentimiento:  [],
    performance:  [],
    backtesting:  [],
    documentos:   [],
    intencion,
  };

  try {
    const [port, decs, sigs, dbDatos] = await Promise.allSettled([
      obtenerUltimoPortfolio("general"),
      dbQuery(`SELECT senal, ticker, ROUND(confianza*100,1) AS conf,
               LEFT(razon,200) AS razon, ts_decision AS ts
               FROM cognitive_decisions
               WHERE ticker NOT REGEXP '^class[0-9]+$' AND ticker != 'GENERAL'
               ORDER BY ts_decision DESC LIMIT 6`),
      dbQuery(`SELECT senal, ticker, ROUND(confianza*100,1) AS conf
               FROM signals_feed
               WHERE ticker NOT REGEXP '^class[0-9]+$' AND ticker != 'GENERAL'
               ORDER BY id DESC LIMIT 5`),
      _consultarDB(intencion),
    ]);

    if (port.status === "fulfilled") ctx.portfolio = port.value;
    if (decs.status === "fulfilled") ctx.decisiones = decs.value;
    if (sigs.status === "fulfilled") ctx.señalesFeed = sigs.value;

    if (dbDatos.status === "fulfilled") {
      const d = dbDatos.value;
      if (d.portfolios)   { ctx.portfolios = d.portfolios; if (d.portfolioActual) ctx.portfolio = d.portfolioActual; }
      if (d.crisis)       ctx.crisis      = d.crisis;
      if (d.causalidad)   ctx.causalidad  = d.causalidad;
      if (d.decisiones)   ctx.decisiones  = d.decisiones;  // reemplaza con versión más completa
      if (d.sentimiento)  ctx.sentimiento = d.sentimiento;
      if (d.performance)  ctx.performance = d.performance;
      if (d.backtesting)  ctx.backtesting = d.backtesting;
      if (d.documentos)   ctx.documentos  = d.documentos;
    }
  } catch (_) {}

  return ctx;
}

// ── Prompt de asistente de análisis financiero (NO asesor) para Gemini ──
function _buildAdvisorPrompt(texto, ctx) {
  const riesgo    = Math.round((ctx.riesgoGlobal ?? 0.5) * 100);
  const riesgoLbl = riesgo > 70 ? "ALTO ⚠️" : riesgo > 45 ? "MODERADO" : "BAJO ✅";

  // Sectores en tiempo real (change_pct ya viene en % directo: 1.5 = 1.5%)
  const sectTop = Object.entries(historialSectores)
    .map(([s, arr]) => {
      const v = arr[arr.length - 1] ?? 0;
      return `${s} ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    }).slice(0, 8).join(" | ") || "sin datos";

  // Alertas activas
  const alertaStr = ctx.alertas?.length
    ? ctx.alertas.map(a => `[${a.nivel}] ${_alertaLegible(a)}`).join("; ")
    : "ninguna";

  // ── Sección PORTFOLIO (todos los portfolios de la DB) ─────────
  // El más reciente (i===0) se reordena/recorta según el perfil de riesgo del
  // usuario — ver _adaptarActivosPerfil. Los anteriores quedan como referencia
  // histórica sin tocar.
  const perfilChat = ctx.perfilUsuario?.perfil || null;
  let seccionPortfolios = "";
  if (ctx.portfolios?.length) {
    seccionPortfolios = "\nPORTFOLIOS EN LA BASE DE DATOS (del más reciente al más antiguo):\n" +
      ctx.portfolios.map((p, i) => {
        const activosBase = i === 0 ? _adaptarActivosPerfil(p.activos, perfilChat) : (p.activos || []);
        const actStr = activosBase.map(a => {
          const chg = parseFloat(a.cambio_pct ?? a.change_pct ?? 0);
          return `${a.symbol} ${a.peso_pct}% (${a.sector}, riesgo ${a.riesgo_pct}%, cambio ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%, estado: ${a.estado_sector})`;
        }).join(" | ");
        return `${i + 1}. [${p.fecha}] Estrategia: ${(p.strategy||"balanced").replace(/_/g," ")} | Riesgo: ${p.riesgo_pct}% | Confianza: ${p.confianza_pct}% | Activos (${p.n_activos}): ${actStr || "sin activos"}`;
      }).join("\n");
  } else if (ctx.portfolio) {
    const p = ctx.portfolio;
    const actStr = _adaptarActivosPerfil(p.activos, perfilChat).map(a => {
      const chg = parseFloat(a.cambio_pct ?? a.change_pct ?? 0);
      return `${a.symbol} ${a.peso_pct}% (${a.sector || "–"}, cambio ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%)`;
    }).join(" | ");
    seccionPortfolios = `\nPORTFOLIO ACTUAL: ${(p.strategy||"balanced").replace(/_/g," ")} | Riesgo: ${p.riesgo_pct ?? "–"}% | Confianza: ${p.confianza_pct ?? "–"}%\nActivos: ${actStr || "sin datos"}`;
  }

  // ── Sección DECISIONES con razonamiento ──────────────────────
  let seccionDecisiones = "";
  if (ctx.decisiones?.length) {
    seccionDecisiones = "\nDECISIONES RECIENTES DEL SISTEMA (con razonamiento):\n" +
      ctx.decisiones.slice(0, 6).map(d =>
        `[${d.fecha || d.ts || "?"}] ${d.senal||d.tipo} ${d.ticker} conf:${d.confianza_pct||d.conf}% riesgo:${d.riesgo_pct||"?"}% → ${d.razon?.slice(0,150)||"sin razonamiento"} | resultado: ${d.outcome_real || "pendiente"}`
      ).join("\n");
  }

  // ── Sección CAUSALIDAD (por qué el sistema decidió así) ───────
  let seccionCausalidad = "";
  if (ctx.causalidad?.length) {
    seccionCausalidad = "\nMEMORIA CAUSAL APRENDIDA (relaciones causa→efecto confirmadas):\n" +
      ctx.causalidad.slice(0, 6).map(c =>
        `CAUSA: ${_causaLegible(c.causa).slice(0,120)} → EFECTO: ${c.efecto?.slice(0,100)} (confianza ${c.confianza_pct}%, visto ${c.repeticiones}x)`
      ).join("\n");
  }

  // ── Sección CRISIS HISTÓRICAS ─────────────────────────────────
  let seccionCrisis = "";
  if (ctx.crisis?.length) {
    seccionCrisis = "\nCRISIS HISTÓRICAS EN LA BASE DE DATOS:\n" +
      ctx.crisis.map(c =>
        `${c.nombre} (${c.anio_inicio}-${c.anio_fin||"actual"}) tipo:${c.tipo} severidad:${c.severidad}/10 — ${c.descripcion?.slice(0,200)||""}`
      ).join("\n");
  }

  // ── Sección SENTIMIENTO DE NOTICIAS ──────────────────────────
  let seccionSentimiento = "";
  if (ctx.sentimiento?.length) {
    seccionSentimiento = "\nSENTIMIENTO DE NOTICIAS (últimas señales):\n" +
      ctx.sentimiento.map(s =>
        `${s.ticker}: ${s.sentiment_label||s.señal} ${s.score_pct}% (${s.n_articulos} artículos, ${s.fecha})`
      ).join(" | ");
  }

  // ── Sección RENDIMIENTO HISTÓRICO ────────────────────────────
  let seccionPerformance = "";
  if (ctx.performance?.length) {
    const ultimos = ctx.performance.slice(0, 3);
    seccionPerformance = "\nRENDIMIENTO HISTÓRICO DEL SISTEMA:\n" +
      ultimos.map(p =>
        `[${p.fecha}] ${p.decisiones_correctas}/${p.total_decisiones} correctas (${p.accuracy_pct}% precisión) | Sharpe: ${p.sharpe??"-"} | Coherencia: ${p.coherencia_pct??"–"}%`
      ).join("\n");
  }

  // ── Sección DOCUMENTOS DE REFERENCIA ─────────────────────────
  let seccionDocs = "";
  if (ctx.documentos?.length) {
    seccionDocs = "\nDOCUMENTOS DE REFERENCIA CARGADOS EN EL SISTEMA:\n" +
      ctx.documentos.map(d => `${d.nombre} (${d.tipo}, ${d.num_paginas} pág, ${d.fecha_doc})`).join(" | ");
  }

  // ── Guía de inversión si se pide ─────────────────────────────
  const esConsultaDeInversion = /cómo (invierto|empiezo|invertir|empezar|usar|utilizar|operar)|qué hago|por dónde empiezo|paso a paso|estrategia|cuánto invertir|cuándo (comprar|vender)|stop.?loss|diversif/i.test(texto);
  const guiaInversion = esConsultaDeInversion ? `
GUÍA DE INVERSIÓN CON MIIA (incluí estos pasos en tu respuesta):
  1. RIESGO ACTUAL ${riesgo}% (${riesgoLbl}): ${riesgo > 70 ? "no aumentar exposición" : riesgo > 45 ? "operar con cautela" : "condiciones favorables para entrar"}.
  2. SEÑALES: BUY con confianza >65% es accionable. Con Gemini activo, la explicación del por qué está disponible.
  3. PORTFOLIO: usá el que MIIA genera — diversifica entre sectores con pesos basados en momentum.
  4. STOP-LOSS: entre 3% y 5% por operación. Nunca más del 10% del capital total en una sola posición.
  5. HORIZONTE: señales 4-48h. Para inversión de largo plazo, esperá confirmación de tendencia en 3 señales consecutivas.
  6. DOCUMENTOS: el sistema tiene ${ctx.documentos?.length || 0} documentos de referencia histórica (crisis, análisis, PDF).` : "";

  // Sección perfil del usuario (nombre, capital, perfil de riesgo)
  const perfilUser = ctx.perfilUsuario;
  const nombreSaludo = perfilUser?.nombre ? `El usuario se llama ${perfilUser.nombre}. Dirigirte a él/ella por su nombre cuando corresponda.` : "";
  const seccionPerfil = (perfilUser?.monto || perfilUser?.perfil || perfilUser?.nombre)
    ? `\nPERFIL DEL USUARIO:
${nombreSaludo}
- Capital disponible: ${perfilUser.monto || "no especificado"}
- Perfil de riesgo: ${perfilUser.perfil || "no especificado"}
Personalizá la respuesta con el nombre del usuario y adaptá la estrategia a su perfil.
IMPORTANTE: la lista de activos en PORTFOLIOS EN LA BASE DE DATOS / PORTFOLIO ACTUAL ya viene
reordenada y recortada según este perfil de riesgo (conservador = menor riesgo primero,
agresivo = mayor momentum/riesgo primero, moderado = orden original). Usá esa lista tal cual,
no agregues ni quites activos por tu cuenta, y explicá la elección en términos del perfil
(p.ej. preservación de capital para conservador, crecimiento agresivo para agresivo).`
    : "";

  // Señales LSTM en tiempo real (inyectadas desde el chatbot via lstm_context)
  const seccionLSTM = ctx._lstmExtra
    ? `\n${ctx._lstmExtra}` : "";

  // Sentimiento por ticker (inyectado desde sentimiento_context)
  const seccionSentTicker = ctx._sentExtra
    ? `\n${ctx._sentExtra}` : "";

  // Riesgo real por activo (volatilidad + drawdown, inyectado desde riesgo_context)
  const seccionRiesgo = ctx._riesgoExtra
    ? `\n${ctx._riesgoExtra}` : "";

  // Activo puntual consultado (análisis on-demand: cotización real + pipeline disparado)
  const seccionActivo = ctx._activoExtra
    ? `\n${ctx._activoExtra}` : "";

  // Enfoque en tickers mencionados
  const tickerFocusTip = ctx._tickerFocus?.length
    ? `\nEl usuario pregunta específicamente sobre: ${ctx._tickerFocus.join(", ")}. Incluí datos de esos tickers si los tenés.`
    : "";

  // ── Noticias reales de la DB (las que fundamentan las señales) ──
  const seccionNoticiasReales = ctx.noticias_reales?.length
    ? "\nNOTICIAS RECIENTES EN BASE DE CONOCIMIENTO:\n" +
      ctx.noticias_reales.map(n =>
        `[${n.fecha}] ${n.ticker ? n.ticker + " " : ""}${n.sentimiento || ""}: "${n.titulo.slice(0, 110)}"` +
        (n.snippet ? ` — ${n.snippet.slice(0, 80)}` : "")
      ).join("\n")
    : "";

  // ── Backtesting stats: fundamentar con números reales ─────────
  const seccionBacktesting = ctx.backtesting_stats?.length
    ? (() => {
        const bt = ctx.backtesting_stats[0];
        const n  = bt.total_verificadas || 0;
        const acc = bt.acc_pct || 0;
        const sh  = bt.sharpe  || "–";
        const dd  = bt.drawdown_pct || "–";
        return `\nPRECISIÓN HISTÓRICA REAL DE MIIA (backtesting):\n- Precisión global: ${acc}% sobre ${n} señales verificadas\n- BUY: ${bt.prec_buy || "–"}% | SELL: ${bt.prec_sell || "–"}% | Retorno prom: ${bt.ret_pct || "–"}%\n- Sharpe: ${sh} | Max drawdown: ${dd}%`;
      })()
    : "";

  // ── Precios recientes por ticker ─────────────────────────────
  const seccionPrecios = ctx.precios?.length
    ? "\nPRECIOS Y SCORES RECIENTES:\n" +
      ctx.precios.map(p => {
        const chg = p.cambio_pct != null ? `${(parseFloat(p.cambio_pct)*100).toFixed(2)}%` : "–";
        const rsk = p.riesgo != null ? `${(parseFloat(p.riesgo)*100).toFixed(0)}% riesgo` : "";
        const sc  = p.score  != null ? `score ${(parseFloat(p.score)*100).toFixed(0)}%` : "";
        return `${p.ticker}: $${p.precio_prom || "–"} cambio ${chg} ${rsk} ${sc}`.trim();
      }).join(" | ")
    : "";

  // ── LSTM predictions history ─────────────────────────────────
  const seccionLSTMHistory = ctx.lstm_predictions?.length
    ? "\nHISTORIAL LSTM (class44):\n" +
      ctx.lstm_predictions.slice(0, 6).map(p =>
        `${p.ticker} ${p.senal} ${p.conf_pct}% (BUY:${p.p_buy}% SELL:${p.p_sell}% RSI:${p.rsi || "–"}) → ${p.outcome_real || "pendiente"} [${p.fecha}]`
      ).join("\n")
    : "";

  return `Sos MIIA, un asistente de análisis financiero con IA y aprendizaje continuo (MLLs). Cada respuesta que das la aprendés y la mejorás con el tiempo gracias al feedback de predicciones reales.
Respondés como un analista experto: con datos concretos de tu base de conocimiento, razonamiento claro y accionable.
IMPORTANTE (marco legal): NO sos un asesor financiero y NO brindás asesoramiento de inversión. Das información y análisis para que el usuario decida por su cuenta. No digas "te recomiendo comprar/vender" como una orden; presentá el análisis y dejá en claro que la decisión final es del usuario y que no garantizás resultados.
IDENTIDAD: sos MIIA y solo MIIA. NUNCA menciones a Gemini, Google, ni ningún otro proveedor de IA. NUNCA uses nombres internos de módulos (class19, class21, class25, etc.) — referite a ellos como "mis motores de análisis", "mi red neuronal predictiva" o "mi motor de sentimiento".

ESTADO DEL MERCADO AHORA:
- Riesgo global: ${riesgo}% (${riesgoLbl})
- Alertas activas: ${alertaStr}
- Sectores: ${sectTop}
${seccionPerfil}
${seccionBacktesting}
${seccionPortfolios}
${seccionDecisiones}
${seccionCausalidad}
${seccionCrisis}
${seccionSentimiento}
${seccionLSTM}
${seccionSentTicker}
${seccionRiesgo}
${seccionActivo}
${seccionLSTMHistory}
${seccionPrecios}
${seccionNoticiasReales}
${seccionPerformance}
${seccionDocs}
${guiaInversion}
${tickerFocusTip}
CONSULTA ACTUAL:
"${texto}"

REGLAS:
- NUNCA menciones "base de datos", "tabla", "SQL", "MySQL" ni de dónde vienen los datos. Hablá como si fueran tu propio análisis.
- Cuando expliques una recomendación: Ticker → Señal → por qué (momentum/riesgo/sentimiento/noticias) → Confianza → Motores (LSTM, Cuantitativo, Noticias).
- Si hay datos de precisión histórica, citá el número: "Con un X% de precisión en las últimas Y señales...".
- Si hay noticias recientes relevantes, nombralas brevemente para fundamentar.
- Si el usuario dice "gracias" o algo corto: respondé con calidez, brevemente. No hagas análisis completo.
- Personalizá por perfil del usuario si está disponible.
- Mantené coherencia con la conversación anterior.
- 3-5 oraciones en español rioplatense. Sin markdown ni asteriscos. Directo al punto.`;
}

// ── Fallback con contexto completo de MySQL ──────────────────
// Se usa cuando Gemini no está disponible. Consulta todas las tablas
// relevantes y construye una respuesta informada según la intención.
async function _fallbackConContexto(texto, ctx) {
  if (!ctx) ctx = await _construirContextoCompleto(texto);
  const tl = texto.toLowerCase();

  const decs    = ctx.decisiones  || [];
  const portData = ctx.portfolio;
  const riesgo  = Math.round((ctx.riesgoGlobal ?? 0.5) * 100);
  const riesgoLbl = riesgo > 70 ? "ALTO" : riesgo > 45 ? "MODERADO" : "BAJO";

  // ── PORTFOLIO: todos los de la DB con activos reales ──────────
  if (/portafolio|portfolio|cartera|activos|invertir|inversión|recomiend|armar|diversif/i.test(tl)) {
    const ports = ctx.portfolios?.length ? ctx.portfolios : (portData ? [portData] : []);
    if (ports.length > 0) {
      const p0 = ports[0];
      const perfilActual = ctx.perfilUsuario?.perfil || null;
      const activosAdaptados = _adaptarActivosPerfil(p0.activos, perfilActual);
      const activos0 = activosAdaptados.slice(0, 5).map(a => {
        const chg = parseFloat(a.cambio_pct ?? a.change_pct ?? 0);
        return `${a.symbol} ${a.peso_pct}% en ${a.sector || "?"} (cambio ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%, riesgo ${a.riesgo_pct ?? "?"}%, estado: ${a.estado_sector || "?"})`;
      }).join("; ");
      const strat = (p0.strategy || "balanced").replace(/_/g, " ");
      const porqActivos = activosAdaptados.slice(0, 3).map(a =>
        `${a.symbol} fue elegido porque el sector ${a.sector || "?"} muestra momentum ${parseFloat(a.cambio_pct ?? a.change_pct ?? 0) >= 0 ? "positivo" : "negativo"} con riesgo ${a.riesgo_pct ?? "?"}%`
      ).join(". ");
      const perfilFrase = perfilActual === "conservador"
        ? " priorizando los activos de menor riesgo para preservar tu capital"
        : perfilActual === "agresivo"
          ? " priorizando los activos de mayor momentum, aceptando más riesgo a cambio de mayor potencial de retorno"
          : " con una distribución equilibrada";
      const perfilStr = ctx.perfilUsuario?.monto
        ? ` Para tu capital de ${ctx.perfilUsuario.monto} con perfil ${perfilActual || "moderado"}, armé este portfolio${perfilFrase}.`
        : (perfilActual ? ` Armado con perfil ${perfilActual}${perfilFrase}.` : "");
      return `Armé un portfolio con estrategia ${strat} y riesgo del ${p0.riesgo_pct ?? riesgo}%, con confianza del ${p0.confianza_pct ?? "?"}%. Los activos son: ${activos0}. El razonamiento: ${porqActivos}.${perfilStr} Con el mercado en ${riesgo}% de riesgo (${riesgoLbl}), ${riesgo > 65 ? "recomiendo esperar una corrección antes de entrar" : "las condiciones son favorables para ejecutar estas posiciones"}.`;
    }
    return `Todavía no generé un portfolio para las condiciones actuales. El sistema está analizando el mercado — el riesgo global es ${riesgo}% (${riesgoLbl}). Cuando detecte condiciones favorables, generaré una cartera optimizada automáticamente.`;
  }

  // ── TICKER PUNTUAL ("que es XLK", "senal de XLF", "que pensas de EWZ") ──
  // Es el caso que mas se cae cuando Ollama esta sobrecargado. Contesta "que es
  // X" con DATO REAL —definicion del instrumento + su ultima senal—, sin inventar
  // y sin depender de ningun LLM. El ticker sale del foco (lo detecta el Python)
  // o de un barrido del texto con el mismo limite de palabra que el glosario.
  const _tkrFoco = ((ctx._tickerFocus || [])[0] ||
    Object.keys(_GLOSARIO_TICKER).find(t =>
      new RegExp(`(?<![A-Z0-9])${t}(?![A-Z0-9])`).test(texto.toUpperCase())) || "").toUpperCase();
  if (_tkrFoco && _GLOSARIO_TICKER[_tkrFoco]) {
    const g   = _GLOSARIO_TICKER[_tkrFoco];
    const dec = (decs || []).find(d => String(d.ticker || "").toUpperCase() === _tkrFoco);
    const senalFrase = dec
      ? ` Mi última señal para ${_tkrFoco} fue ${dec.senal || dec.tipo} con ${dec.confianza_pct || dec.conf || "?"}% de confianza.`
      : ` Todavía no tengo una señal propia de ${_tkrFoco} en esta ventana de mercado.`;
    return `${_tkrFoco} es el ETF de ${g.sector}${g.region ? ` (${g.region})` : ""}.${senalFrase} `
      + `El riesgo global del mercado está en ${riesgo}% (${riesgoLbl}). La decisión final es tuya.`;
  }

  // ── CRISIS HISTÓRICAS ─────────────────────────────────────────
  if (/crisis|burbuja|crash|caída total|recesión|histórica|2008|1929|argentina|colapso/i.test(tl)) {
    if (ctx.crisis?.length > 0) {
      const top = ctx.crisis.slice(0, 3);
      const crisisStr = top.map(c =>
        `${c.nombre} (${c.anio_inicio}-${c.anio_fin || "actual"}, tipo ${c.tipo}, severidad ${c.severidad}/10): ${c.descripcion?.slice(0, 150) || "sin descripción"}`
      ).join(". ");
      const masGrave = ctx.crisis.reduce((a, b) => (b.severidad > a.severidad ? b : a), ctx.crisis[0]);
      return `En mi base de datos tengo ${ctx.crisis.length} crisis históricas registradas. Las más relevantes: ${crisisStr}. La crisis más severa documentada fue "${masGrave.nombre}" con severidad ${masGrave.severidad}/10. El riesgo actual del mercado es ${riesgo}% — ${riesgo > 65 ? "el sistema detecta patrones de alerta similares a períodos pre-crisis" : "actualmente no hay señales de crisis generalizada"}.`;
    }
    return `El sistema monitorea señales de crisis en tiempo real usando ${Object.keys(historialSectores).length} sectores. El riesgo actual es ${riesgo}% (${riesgoLbl}). ${ctx.alertas?.length ? `Alertas activas: ${ctx.alertas.map(a => _alertaLegible(a)).join(", ")}.` : "Sin alertas críticas activas."}`;
  }

  // ── NOTICIAS Y SENTIMIENTO ────────────────────────────────────
  if (/noticia|sentimiento|sentiment|prensa|news|impacto/i.test(tl)) {
    if (ctx.sentimiento?.length > 0) {
      const sent = ctx.sentimiento.slice(0, 5);
      const posit = sent.filter(s => (s.sentiment_label || s.señal || "").toLowerCase().includes("positiv") || s.score_pct > 60).length;
      const negat = sent.filter(s => (s.sentiment_label || s.señal || "").toLowerCase().includes("negativ") || s.score_pct < 40).length;
      const sentStr = sent.map(s => `${s.ticker}: ${s.sentiment_label || s.señal} ${s.score_pct}% (${s.n_articulos} artículos)`).join(", ");
      return `En mi base de datos tengo ${ctx.sentimiento.length} registros de sentimiento de noticias recientes. De los últimos ${sent.length}: ${posit} positivos, ${negat} negativos. Detalle: ${sentStr}. El sentimiento promedio ${posit > negat ? "favorable" : "desfavorable"} ${posit > negat ? "apoya señales de compra" : "sugiere cautela"} en el contexto de riesgo actual ${riesgo}%.`;
    }
    return `El módulo class45 analiza sentimiento de noticias en tiempo real. Actualmente el riesgo global es ${riesgo}% (${riesgoLbl}). Los datos de sentimiento más recientes están disponibles en el panel Markets.`;
  }

  // ── ESTABILIDAD Y RENDIMIENTO HISTÓRICO ──────────────────────
  if (/estabilidad|estable|rendimiento|performance|backtesting|precisi|accuracy|sharpe|drawdown/i.test(tl)) {
    if (ctx.performance?.length > 0) {
      const p = ctx.performance[0];
      const acc = p.accuracy_pct ?? "?";
      const sharpe = p.sharpe ?? "?";
      const hist = ctx.performance.slice(0, 3).map(d => `${d.fecha}: ${d.accuracy_pct}% precisión`).join(", ");
      return `En mi base de datos tengo ${ctx.performance.length} snapshots de rendimiento. El más reciente (${p.fecha}): precisión ${acc}% con ${p.decisiones_correctas}/${p.total_decisiones} señales correctas y Sharpe ${sharpe}. Historial: ${hist}. ${ctx.backtesting?.length ? `Tengo ${ctx.backtesting.length} corridas de backtesting verificadas.` : ""} El sistema ${parseFloat(acc) > 60 ? "muestra estabilidad creciente" : "está en fase de calibración"}.`;
    }
    // Calcular desde cognitive_decisions directo
    try {
      const stats = await dbQuery(`
        SELECT COUNT(*) AS total,
               SUM(outcome_real='correcto') AS ok,
               SUM(outcome_real='pendiente') AS pend
        FROM cognitive_decisions LIMIT 1`);
      if (stats?.[0]) {
        const { total, ok, pend } = stats[0];
        const acc = ok > 0 ? ((ok / total) * 100).toFixed(1) : "0";
        return `De ${total} señales en mi base de datos: ${ok || 0} verificadas correctas (precisión ${acc}%), ${pend || 0} pendientes de verificación. El riesgo actual es ${riesgo}% (${riesgoLbl}). La precisión mejora continuamente a medida que se verifican señales dentro del horizonte de 24-48h.`;
      }
    } catch (_) {}
    return `El sistema evalúa cada señal comparando la predicción con el precio real al vencer el horizonte (24-48h). La precisión histórica está disponible en el panel Backtesting.`;
  }

  // ── RIESGO Y MERCADO ──────────────────────────────────────────
  if (/riesgo|risk|volatil|porcentaje|nivel|mercado|sector/i.test(tl)) {
    const sectores = Object.entries(historialSectores)
      .map(([s, arr]) => {
        const v = arr[arr.length - 1] ?? 0;
        return `${s} ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;  // change_pct ya en %
      }).slice(0, 6).join(", ") || "sin datos de sectores";
    const alerta = ctx.alertas?.length > 0
      ? ` Alerta activa: ${_alertaLegible(ctx.alertas[0])}.`
      : "";
    return `El riesgo global del mercado es ${riesgo}% (${riesgoLbl}).${alerta} Los sectores monitoreados muestran: ${sectores}. ${riesgo > 65 ? "Con este nivel de riesgo, recomiendo reducir exposición o usar stop-loss del 3% como máximo." : riesgo > 45 ? "Nivel moderado: operar con posiciones normales y stop-loss del 4%." : "Riesgo bajo: condiciones favorables para posiciones activas."}`;
  }

  // ── CAUSALIDAD / POR QUÉ ──────────────────────────────────────
  if (/por qué|porque|porqué|explicá|explica|razon|razón|motivo|fundamento/i.test(tl)) {
    const riesgoLbl2 = riesgo > 70 ? "ALTO" : riesgo > 45 ? "MODERADO" : "BAJO";

    // Limpiar causas que son textos internos de alertas (no aptos para mostrar al usuario)
    const _limpiarCausa = (raw = "") => {
      // Remover prefijos tipo "caida_sectorial:", "depresion_prolongada:", etc.
      const limpia = raw.replace(/^[a-z_]+:\s*/i, "")
                        .replace(/class\d+\s*/gi, "")
                        .replace(/\s{2,}/g, " ")
                        .trim();
      return limpia.length > 15 ? limpia : null;
    };

    if (decs.length > 0) {
      const d = decs[0];
      const senal   = d.senal || d.tipo || "HOLD";
      const ticker  = d.ticker || "el mercado";
      const conf    = d.confianza_pct || d.conf || "–";
      const outcome = d.outcome_real || "pendiente";
      const razon   = (d.razon || "").replace(/class\d+[^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();

      // Construir cadena causal limpia
      const causasLimpias = (ctx.causalidad || [])
        .map(c => ({ causa: _limpiarCausa(c.causa), efecto: c.efecto, conf: c.confianza_pct, rep: c.repeticiones }))
        .filter(c => c.causa)
        .slice(0, 2);

      let respPorQue = `La señal ${senal} en ${ticker} se generó porque el sistema detectó: ${razon.slice(0, 200) || "condiciones de mercado específicas"}.`;
      respPorQue += ` El riesgo global del mercado está en ${riesgo}% (${riesgoLbl2}).`;

      if (causasLimpias.length > 0) {
        respPorQue += " Con base en mi memoria causal: " +
          causasLimpias.map(c => `cuando "${c.causa.slice(0,100)}", el efecto fue "${c.efecto?.slice(0,60)}" (${c.conf}% confianza, ${c.rep}x confirmado)`).join("; ") + ".";
      }
      respPorQue += ` La confianza fue del ${conf}% y el resultado: ${outcome}.`;
      return respPorQue;
    }

    return `El mercado está con riesgo ${riesgo}% (${riesgoLbl2}). Las señales de MIIA integran: predicciones LSTM (horizonte 24-48h), sentimiento de noticias en tiempo real, análisis de riesgo sectorial y memoria de patrones históricos. Cuando hay condiciones similares a situaciones pasadas exitosas, la confianza sube. El panel AI Engines muestra el detalle de cada motor.`;
  }

  // ── PREGUNTA LIBRE / ANÁLISIS ESPECÍFICO ─────────────────────
  // Para preguntas que no matchean ningún patrón específico (noticias, política, economía, etc.)
  // Publicar a class1_trigger para que busque información relevante
  // y construir una respuesta con el contexto disponible
  const esConsultaLibre = texto.length > 20 && !ctx.intencion?.portfolio;
  if (esConsultaLibre) {
    // Disparar búsqueda en class1 para que en el próximo turno haya contexto
    redisPub.publish("class1_trigger", JSON.stringify({
      origen: "class25B_chat",
      motivo: "pregunta_usuario",
      queries: [texto.slice(0, 100) + " mercado argentino inversión"],
      ts: new Date().toISOString(),
    })).catch(() => {});

    // Respuesta con lo que sabemos y lo que estamos buscando
    const decStr2 = decs.length > 0 && !/^class\d+$/.test(decs[0].ticker || "")
      ? ` En el mercado argentino (ARGT) mi última señal es ${decs.find(d => d.ticker === "ARGT")?.senal || "sin datos"}.`
      : "";
    const riesgoARGT = historialSectores["Argentina"]?.slice(-1)?.[0];
    const riesgoStr  = riesgoARGT != null ? ` El sector Argentina muestra un cambio de ${(riesgoARGT * 100).toFixed(1)}%.` : "";
    return `Con eso no tengo un dato preciso para darte sin inventarlo, así que prefiero no hacerlo.${decStr2}${riesgoStr} Lo que sí tengo en tiempo real: el riesgo global del mercado es ${riesgo}% (${riesgoLbl}), la señal de cualquiera de los 50 instrumentos que sigo, el sentimiento de noticias y un portfolio según tu perfil. Preguntame por un ticker puntual o por el riesgo y te doy el número. La decisión final es tuya.`;
  }

  // ── RESPUESTA GENERAL ─────────────────────────────────────────
  const _tickerValido = t => t && !/^class\d+$|^GENERAL$|^general$/i.test(t);
  const ultimaDecision = decs.find(d => _tickerValido(d.ticker));
  const decStr = ultimaDecision
    ? ` Mi última señal fue ${ultimaDecision.senal || ultimaDecision.tipo} en ${ultimaDecision.ticker} (${ultimaDecision.confianza_pct || ultimaDecision.conf}% confianza).`
    : "";
  const portfolioStr = portData?.strategy
    ? ` Tengo un portfolio ${(portData.strategy).replace(/_/g, " ")} activo con riesgo ${portData.riesgo_pct}%.`
    : "";
  // Variación de redacción: evita que el fallback (sin Gemini) suene siempre
  // idéntico. Cuando Gemini está disponible, esta función ni se usa.
  const _pick = a => a[Math.floor(Math.random() * a.length)];
  const _intro = [
    "Soy MIIA, tu asistente de análisis financiero con IA.",
    "Acá MIIA, tu asistente de análisis de mercados con IA.",
    "Soy MIIA: te ayudo a leer el mercado con IA — la decisión siempre es tuya.",
  ];
  const _cierre = [
    "Podés preguntarme por señales actuales, análisis de sectores, crisis históricas o el razonamiento detrás de mis análisis.",
    "Preguntame lo que quieras: señales, sectores, riesgo, crisis históricas o el porqué de cada análisis.",
    "Estoy para ayudarte a analizar el mercado: señales, sectores, riesgo o un activo puntual.",
  ];
  return `${_pick(_intro)} El mercado está con riesgo ${riesgo}% (${riesgoLbl}).${decStr}${portfolioStr} ${_pick(_cierre)}`;
}

// Deduplicación de mensajes humanos en ráfagas (mismo texto en < 8s).
// 5-nov-2026: la clave era SÓLO el texto, de todos los usuarios juntos. Dos
// personas que escribían «sí» con segundos de diferencia —o la misma persona
// contestando «sí» dos veces seguidas a respuestas instantáneas del router— y
// el segundo mensaje se descartaba sin respuesta: la web quedaba en «MIIA está
// procesando». Ahora la clave es (sesión, texto), y cuando a esa sesión ya se
// le contestó, repetir el texto es un turno nuevo, no una ráfaga.
const _humanQueryCache = new Map();
const _DEDUP_TTL = 8_000;
function _claveSesionQuery(msg) { return String(msg?.session_id || msg?.sesion || msg?.user_id || "anon").slice(0, 80); }
function _isDupHumanQuery(texto, msg = null) {
  const key = `${_claveSesionQuery(msg)}\u0000${texto.slice(0, 120)}`;
  const now  = Date.now();
  for (const [k, ts] of _humanQueryCache) if (now - ts > _DEDUP_TTL) _humanQueryCache.delete(k);
  if (_humanQueryCache.has(key)) return true;
  _humanQueryCache.set(key, now);
  return false;
}
/** La sesión ya tiene respuesta: el mismo texto de nuevo es otro turno. */
function _finTurnoHumano(msg) {
  const pre = `${_claveSesionQuery(msg)}\u0000`;
  for (const k of [..._humanQueryCache.keys()]) if (k.startsWith(pre)) _humanQueryCache.delete(k);
}

// ── Prompt COMPACTO, para el motor local ─────────────────────────
// `_buildAdvisorPrompt` son 413 lineas escritas para Gemini, donde el contexto
// largo es gratis. Aca NO lo es: medido en el server el 11-oct-2026, gemma2:2b
// lee el prompt a 24,7 ms por token, asi que los 1.027 tokens que le mandabamos
// costaban 25 s — el 80 % de una respuesta de 31,4 s, contra un presupuesto de
// 22 s. Lo que sobra en este prompt no es verborragia: es latencia.
//
// Lo que NO se recorta, y no es negociable: el marco legal y la identidad.
// miiaia.com es una pagina publica de informacion financiera; un prompt mas
// barato que se coma el "no soy asesor" seria mas rapido y peor.
function _buildAdvisorPromptLocal(texto, ctx) {
  const riesgo    = Math.round((ctx.riesgoGlobal ?? 0.5) * 100);
  const riesgoLbl = riesgo > 70 ? "ALTO" : riesgo > 45 ? "MODERADO" : "BAJO";

  const sect = Object.entries(historialSectores)
    .map(([sec, arr]) => {
      const v = arr[arr.length - 1] ?? 0;
      return `${sec} ${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    }).slice(0, 5).join(", ") || "sin datos";

  // Si el usuario preguntó por un ticker puntual, priorizar SU decisión.
  const foco = (ctx._tickerFocus || []).map(t => String(t).toUpperCase());
  const decisiones = ctx.decisiones || [];
  const decFoco = foco.length
    ? decisiones.filter(d => foco.includes(String(d.ticker || "").toUpperCase()))
    : [];
  const decs = (decFoco.length ? decFoco : decisiones).slice(0, 3)
    .map(d => `${d.senal || d.tipo} ${d.ticker} conf ${d.confianza_pct || d.conf || "?"}%`)
    .join("; ");

  // Contexto POR TICKER: lo que hacía que "¿señal de XLK?" saliera genérico es
  // que el dato de XLK llegaba a `ctx` (ya acotado del lado del Python) y este
  // prompt lo TIRABA. Sólo se agrega cuando hay un ticker en foco, para no
  // inflar el prompt de las preguntas generales (cada token cuesta ~25 ms de
  // lectura en esta CPU). El `_activoExtra`, verboso y escrito para Gemini, no
  // se incluye acá.
  const porTicker = foco.length
    ? `${ctx._lstmExtra ? "\n" + ctx._lstmExtra : ""}`
    + `${ctx._sentExtra ? "\n" + ctx._sentExtra : ""}`
    + `${ctx._riesgoExtra ? "\n" + ctx._riesgoExtra : ""}`
    : "";

  // Glosario de los tickers mencionados: mata la confabulación del 2B (lo del
  // "ARG es un indicador de riesgo global", que era inventado).
  const glos = glosarioLocal(texto, _GLOSARIO_TICKER);

  // Con el router, AHORA lleva los HECHOS de chat_evidencia (cotizaciones de los
  // 50, ranking, amplitud): son los mismos números contra los que después se
  // valida la respuesta. Sin hechos, el bloque de antes. (historialSectores
  // mezcla sectores con los "bajó N puntos estimados" de class25A, que no son
  // cambios de precio: por eso no se usa cuando hay hechos.)
  const ahora = ctx._hechos
    ? ctx._hechos
    : `riesgo global ${riesgo}% (${riesgoLbl}). Sectores: ${sect}.${decs ? ` Señales recientes: ${decs}.` : ""}`;

  // El bloque ESTABLE va primero y el volatil al final, a proposito: Ollama
  // cachea el PREFIJO del prompt (en su log, `cached n_tokens` y `context
  // checkpoint`). Con el riesgo y los sectores arriba, cualquier cambio de un
  // decimal invalida el cache y la segunda pregunta vuelve a pagar los 5 s
  // enteros. Asi, en una conversacion solo el primer mensaje los paga. El
  // glosario y los datos del ticker son volátiles → van abajo.
  return `Sos MIIA, asistente de análisis financiero con IA, en castellano rioplatense con tildes. NO sos asesor financiero y NO das asesoramiento: presentás el análisis y la decisión final es del usuario, no garantizás resultados.
Sos MIIA y sólo MIIA: nunca nombres a Gemini, Google ni otro proveedor de IA ni módulos internos, ni de dónde salen los datos. Sin markdown ni asteriscos.
Respondé en 2 o 3 oraciones, directo al punto; un saludo o «gracias» va breve y cálido, sin análisis. Usá sólo los números de abajo; si algo NO figura, decí que no lo tenés en vez de inventar.
${glos ? glos + "\n" : ""}AHORA: ${ahora}${porTicker}`;
}

// ── Prompt de CHARLA LIBRE (5-nov-2026) ──────────────────────────
// Pedido de Martín: «si la pregunta está por fuera del sistema, que hable el
// motor y opine, que no deje de decir que yo la creé y que recuerde que es una
// IA y se puede equivocar». Antes estas preguntas recibían el prompt de datos
// («usá sólo los números de abajo; si algo no figura, decí que no lo tenés»), y
// el 2B contestaba exactamente eso: «no tengo un dato», o el validador lo
// descartaba y salía la plantilla «se me escapa de lo que mido».
// Corto a propósito (se paga ~25 ms por token leído). El aviso de que es una IA
// lo agrega `firmaCharla` (chat_redactor.js) después, no el modelo.
// (el prompt y la firma viven en chat_redactor.js: puros y probados por sim35)

// ── MLLs: llamada multi-turno al motor de lenguaje con historial ─────────
// Intenta el motor local (Ollama) primero y Gemini de respaldo, según el router.
// Convierte el historial [{rol, txt}] del frontend al formato de cada motor.
// Devuelve { texto, motor } con motor ∈ {"local","gemini","cache"}, o null si no
// hay motor disponible o todos fallan. El `motor` le sirve al llamador para NO
// aprender del estilo del modelo local (ver el llamador en procesarInputHumano).
async function _geminiMultiTurno(texto, ctx, historial = [], bypassGrace = false, opts = {}) {
  // El router decide, no `_geminiReady`: con MIIA_LLM=local no hay modelo de
  // Gemini y el chat tiene que contestar igual.
  // `opts.soloGemini` (13-nov-2026): la reescritura de una respuesta LARGA no
  // entra en los 12 s de Ollama en esta CPU, así que no se le pide.
  const hayLocal  = LLM_USA_LOCAL  && !LLM.cortado() && !opts.soloGemini;
  // En la charla libre (`opts.geminiPrimero`) Gemini entra aunque MIIA_LLM=local:
  // los datos siguen por el redactor determinístico; esto es sólo para opinar.
  const hayGemini = (opts.geminiPrimero ? true : LLM_USA_GEMINI) && _geminiReady(bypassGrace);
  if (!hayLocal && !hayGemini) return null;

  // Caché: si ya respondimos esta pregunta recientemente, reutilizar. Con hechos
  // en el prompt la clave los incluye: la misma pregunta con otros números del
  // mercado es otra respuesta (si no, devolvía la de hace 10 min).
  // En la charla libre la respuesta depende de la CONVERSACIÓN, no sólo de la
  // pregunta: «sí, por favor» contesta a lo que MIIA acababa de proponer, que
  // es distinto en cada charla (y en cada usuario). Sin el historial en la
  // clave, la caché devolvía durante 10 min la respuesta de OTRA charla (5-nov).
  const _hist = (ctx?._modo === "charla" || ctx?._modo === "reescribir")
    ? (historial || []).slice(-LLM_LOCAL_TURNOS).map(h => `${h?.rol}:${String(h?.txt || "").slice(0, 200)}`).join("|")
    : "";
  const _claveCache = (ctx?._hechos || ctx?._referencia || _hist)
    ? `${String(texto).slice(0, 60)} #${crypto.createHash("sha1").update(`${ctx?._hechos || ""}|${ctx?._referencia || ""}|${_hist}`).digest("hex").slice(0, 10)}`
    : texto;
  const cached = _geminiCacheGet(_claveCache);
  if (cached) { log(`♻️ caché hit (no se llama a ningún motor)`); return { texto: cached, motor: "cache" }; }

  // Prompt de sistema: asistente de análisis financiero (NO asesor) con datos en tiempo real
  // «reescribir» (13-nov-2026) usa los mismos topes de tiempo que la charla.
  const charla = ctx?._modo === "charla" || ctx?._modo === "reescribir";
  const sysPrompt = charla ? promptCharla(ctx) : _buildAdvisorPrompt(texto, ctx);

  // ¿Sirve lo que escribió el motor? (13-nov-2026). Tres agujeros que dejaban
  // el chat contestando «no me salió una respuesta»:
  //   · una respuesta VACÍA de Gemini (bloqueo, tope de tokens) volvía como
  //     `{texto: ""}`, que es truthy: no se probaba Ollama y no se logueaba nada;
  //   · si el validador del llamador descartaba lo de Gemini, Ollama no se
  //     probaba aunque sobrara tiempo (Gemini tiene tope de 9 s y Ollama de
  //     12 s: el peor caso sigue siendo 21 s < 25);
  //   · lo descartado quedaba 10 min en la CACHÉ, así que la misma pregunta
  //     caía al respaldo una y otra vez sin llamar a ningún motor.
  // Con `opts.validar` (la charla lo pasa) cada motor se valida antes de cachear
  // y, si no sirve, se prueba el siguiente.
  const _sirve = (txt, motor) => {
    if (!String(txt || "").trim()) { log(`⚠️ motor ${motor}: respuesta vacía`, "warn"); return false; }
    if (typeof opts.validar !== "function") return true;
    const v = opts.validar(txt);
    if (v?.ok) return true;
    _chatStats.descartadas++;
    log(`🛡️ charla del motor ${motor} descartada (${v?.motivo}): "${String(txt).slice(0, 90)}"`, "warn");
    return false;
  };

  // Dos motores, encapsulados para poder elegir el ORDEN. Por defecto local
  // primero y Gemini de respaldo (lo de siempre, el camino de datos no cambia).
  // En la charla libre, con `opts.geminiPrimero`, el orden se invierte: Gemini
  // primero —rápido y mejor para opinar— y Ollama de respaldo cuando Gemini se
  // queda sin cuota (`_geminiReady()` da false), así MIIA nunca se queda callada.

  // ── Motor LOCAL (Ollama) ──
  // El historial va como turnos de verdad y la plantilla la aplica Ollama. No
  // hace falta el baile de alternancia user/model que exige Gemini ni el turno
  // falso del modelo que existe sólo para que Gemini acepte un system prompt.
  // `estado.gano` lo marca la carrera: si Gemini ya contestó, la respuesta de
  // Ollama llega tarde y no pisa la caché (sigue contando como uso del motor).
  const correrLocal = async (timeoutMs = charla ? LLM_CHARLA_TIMEOUT_MS : undefined, estado = null, signal = undefined) => {
    try {
      const mensajes = [{ rol: "system", texto: charla ? promptCharla(ctx) : _buildAdvisorPromptLocal(texto, ctx) }];
      // `opts.localTurnos` / `opts.localMaxTokens` (13-nov-2026): la reescritura
      // corta va SIN historial (cada token leído cuesta ~25 ms) y con un poco más
      // de salida. Ojo: slice(-0) devuelve TODO el arreglo, de ahí el `> 0`.
      const _turnosLocal = Number.isFinite(opts.localTurnos) ? opts.localTurnos : LLM_LOCAL_TURNOS;
      for (const h of (_turnosLocal > 0 ? (historial || []).slice(-_turnosLocal) : [])) {
        if (h && h.txt) mensajes.push({ rol: h.rol === "user" ? "user" : "assistant",
                                        texto: String(h.txt).slice(0, LLM_LOCAL_CHARS_TURNO) });
      }
      if (mensajes[mensajes.length - 1].rol !== "user") mensajes.push({ rol: "user", texto });

      const r = await LLM.conversar({ mensajes, maxTokens: opts.localMaxTokens || (charla ? LLM_CHARLA_MAX_TOKENS : LLM_LOCAL_MAX_TOKENS),
                                      temperatura: charla ? 0.90 : 0.80,
                                      timeoutMs, signal });
      const tarde = estado?.gano === "gemini";
      _llmLocalUsos++;
      log(`✅ ${r.modelo} local (${mensajes.length} turnos, ${String(r.texto || "").length} chars, `
        + `${r.ms} ms, ${r.tps} tok/s)${tarde ? " — llegó tarde, contestó Gemini" : ""}`);
      // Tarde: ya contestó Gemini y nadie usa ésta. No se valida (no sumaría
      // «descartadas» falsas) ni se cachea.
      if (tarde) return { texto: r.texto, motor: "local" };
      if (!_sirve(r.texto, "local")) return null;
      if (LLM_APRENDER_LOCAL && !tarde) aprenderDeRespuestaGemini(r.texto, { senal: "INFO" });
      if (!tarde) _geminiCacheSet(_claveCache, r.texto);
      return { texto: r.texto, motor: "local" };
    } catch (e) {
      // Cancelado porque Gemini ya contestó: no es una falla del motor local.
      if (e?.name === "AbortError") return null;
      _llmLocalFallos++;
      log(`⚠️ motor local falló: ${e.message}`, "warn");
      return null;
    }
  };

  // ── Motor GEMINI ──
  // Gemini espera alternancia estricta user/model.
  const correrGemini = async () => {
    const contents = [];
    if (historial.length === 0) {
      contents.push({ role: "user", parts: [{ text: sysPrompt }] });
      contents.push({ role: "model", parts: [{ text: "Entendido. Soy MIIA, tu asistente de análisis financiero con IA. ¿En qué te puedo ayudar hoy?" }] });
    } else {
      contents.push({ role: "user", parts: [{ text: sysPrompt }] });
      contents.push({ role: "model", parts: [{ text: charla ? "Entendido. Soy MIIA, la IA de Martín Rinaldi." : "Entendido, tengo acceso a todos los datos del sistema." }] });
      const hist = historial.slice(-6);
      for (const h of hist) {
        const role = h.rol === "user" ? "user" : "model";
        if (contents[contents.length - 1]?.role === role) {
          contents[contents.length - 1].parts[0].text += "\n" + h.txt;
        } else {
          contents.push({ role, parts: [{ text: h.txt }] });
        }
      }
    }
    if (contents[contents.length - 1]?.role !== "user") {
      contents.push({ role: "user", parts: [{ text: texto }] });
    } else if (historial.length > 0) {
      const last = contents[contents.length - 1];
      if (!last.parts[0].text.includes(texto.slice(0, 30))) last.parts[0].text += "\n" + texto;
    } else {
      contents.push({ role: "user", parts: [{ text: texto }] });
    }
    try {
      // En charla, tope DURO: un 503 que el SDK reintenta puede colgarse y
      // comerse el presupuesto de 25 s del frente. Si Gemini no contesta en
      // GEMINI_CHARLA_TIMEOUT_MS, se corta con "[503] …" para que _handleGeminiError
      // lo pause 45 s y las charlas siguientes vayan directo a Ollama.
      // `thinkingBudget: 0` apaga el «pensamiento» de los flash 2.5. Un modelo
      // que no lo acepta (Google cambia y retira modelos seguido: ver «Por qué
      // Gemini no atendía», 7-nov) contesta 400, y ese 400 pausaba Gemini 30 min
      // en CADA charla. Si el 400 habla del thinking se reintenta UNA vez sin él,
      // dentro del mismo tope de 9 s, y queda recordado (13-nov-2026).
      const _pedirGemini = () => geminiModel.generateContent({
        contents,
        generationConfig: _geminiSinThinking
          ? { maxOutputTokens: 700, temperature: 0.80 }
          : { maxOutputTokens: 700, temperature: 0.80, thinkingConfig: { thinkingBudget: 0 } }
      });
      const _pGemini = _pedirGemini().catch(e => {
        const code = Number(e?.status || e?.message?.match(/\[(\d+)/)?.[1] || 0);
        if (!_geminiSinThinking && code === 400 && /thinking|budget/i.test(String(e?.message || ""))) {
          _geminiSinThinking = true;
          log(`⚠️ Gemini rechazó thinkingConfig (400): se reintenta sin él y queda así`, "warn");
          return _pedirGemini();
        }
        throw e;
      });
      const result = charla
        ? await Promise.race([
            _pGemini,
            new Promise((_, rej) => setTimeout(
              () => rej(new Error(`[503] gemini timeout charla (${GEMINI_CHARLA_TIMEOUT_MS} ms)`)),
              GEMINI_CHARLA_TIMEOUT_MS)),
          ])
        : await _pGemini;
      // `text()` TIRA si la respuesta vino bloqueada (p. ej. SAFETY): eso no es
      // una falla de Gemini que haya que pausar, es una respuesta vacía, y el
      // siguiente motor puede contestar.
      let respuesta = "";
      try { respuesta = String(result.response.text() || "").trim(); }
      catch (e) { log(`⚠️ Gemini contestó sin texto: ${String(e?.message || "").slice(0, 120)}`, "warn"); }
      _gemini429StreakReset();
      log(`✅ Gemini MLLs (${contents.length} turnos, ${respuesta.length} chars)`);
      if (!_sirve(respuesta, "gemini")) return null;
      aprenderDeRespuestaGemini(respuesta, { senal: "INFO" });
      _geminiCacheSet(_claveCache, respuesta);   // antes la clave era `texto` pelado: en charla pisaba la respuesta de otra conversación (mismo bug que el fix local del 5-nov)
      return { texto: respuesta, motor: "gemini" };
    } catch (e) {
      _handleGeminiError(e, "(MLLs)");
      return null;
    }
  };

  // Orden de motores: en charla, Gemini primero y Ollama de respaldo; en datos,
  // local primero y Gemini de respaldo (lo de siempre).
  if (opts.geminiPrimero && hayGemini) {
    if (hayLocal && CHARLA_EN_CARRERA && !opts.sinCarrera) {
      // Los dos a la vez: Ollama no espera a que Gemini falle para empezar. Si la
      // de Gemini no sirve (vacía o descartada por el validador), vale la de Ollama.
      // 26-nov-2026: si contesta Gemini, se CANCELA el pedido a Ollama. Antes
      // seguía generando ~10-20 s en segundo plano y, con OLLAMA_NUM_PARALLEL=1,
      // la charla siguiente esperaba en fila detrás de una respuesta que nadie
      // iba a usar: vencía su tope, contaba como falla, y con 3 seguidas el
      // cortacircuitos apagaba el motor local de 5 a 30 min.
      const estado = { gano: null };
      const ctrl = new AbortController();
      const pLocal = correrLocal(LLM_CHARLA_TIMEOUT_MS, estado, ctrl.signal);
      const g = await correrGemini();
      if (g) { estado.gano = "gemini"; ctrl.abort(); return g; }
      return await pLocal;
    }
    const g = await correrGemini();
    if (g) return g;
    return hayLocal ? await correrLocal(LLM_CHARLA_TIMEOUT_SERIE_MS) : null;
  }
  if (hayLocal) {
    const l = await correrLocal();
    if (l) return l;
  }
  return hayGemini ? await correrGemini() : null;
}

// ── Helper: publicar respuesta al canal de salida ────────────
// `extra` permite adjuntar datos estructurados (p.ej. portfolio_recomendado)
// que /api/ask reenvía al frontend junto con el texto.
async function _publicarRespuesta(texto, msg, extra = null) {
  const reply = {
    id:         uuidv4(),
    source:     "class25B",
    tipo:       "respuesta",
    type:       "respuesta",
    texto,
    decision:   texto,
    respuesta:  texto,
    senal:      "INFO",
    ticker:     "GENERAL",
    confianza:  0.8,
    ts:         new Date().toISOString(),
    final:      true,
    session_id: msg.session_id || null,
    // 26-nov-2026: el id de la consulta. /api/ask empareja por él; sin esto, dos
    // mensajes seguidos de la misma sesión se cruzaban las respuestas.
    query_id:   msg.id || null,
    user_id:    msg.user_id    || null,
    ...(extra || {}),
  };
  // 26-nov-2026: la lista de portafolios del usuario viaja en cada respuesta, así
  // el panel Portfolio queda al día en cualquier dispositivo sin pedirla aparte.
  if (_uidPort(msg)) reply.mis_portafolios = portsResumen(_entradaPort(msg));
  _finTurnoHumano(msg);
  await redisPub.publish(CH_OUT, JSON.stringify(reply));
}

// ════════════════════════════════════════════════════════════
// TRACKING DE SESIÓN + FEEDBACK POSITIVO
// Cuando el usuario dice "perfecto/genial/excelente", reforzamos
// los patrones de la última respuesta que Gemini generó.
// ════════════════════════════════════════════════════════════
const _lastGeminiBySession = new Map(); // sessionId → {tokens, conf, ts}

function _trackGeminiRespuesta(sesionId, textoGemini, confianza) {
  if (!textoGemini || !sesionId) return;
  const palabras = textoGemini.toLowerCase()
    .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
    .split(/\s+/).filter(t => t.length > 4);
  const unigrams = palabras.slice(0, 25);
  const bigrams  = [];
  for (let i = 0; i < Math.min(palabras.length - 1, 15); i++)
    bigrams.push(`${palabras[i]}_${palabras[i+1]}`);
  _lastGeminiBySession.set(sesionId, {
    tokens: [...unigrams, ...bigrams],
    conf:   confianza,
    ts:     Date.now(),
  });
  // Limpiar entradas viejas (TTL 30 min)
  const now = Date.now();
  for (const [k, v] of _lastGeminiBySession)
    if (now - v.ts > 30 * 60_000) _lastGeminiBySession.delete(k);
}

function _reforzarUltimaRespuesta(sesionId) {
  const last = _lastGeminiBySession.get(sesionId);
  if (!last?.tokens?.length) return;
  let reforzados = 0;
  for (const tok of last.tokens) {
    // El pulgar arriba de un usuario dice "la respuesta me gustó", NO "el
    // mercado le dio la razón". Son dos poblaciones distintas: el v3 las
    // sumaba en `aciertos` y con eso una respuesta bien redactada subía la
    // accuracy de mercado del token. Ahora tiene su propio contador.
    _patron(tok).user_boost++;
    reforzados++;
  }
  log(`👍 Feedback positivo → reforzados ${reforzados} patrones MLLs`);
  guardarEstado().catch(() => {});
  _guardarLearningCycle(last.conf, reforzados, "feedback_positivo").catch(() => {});
}

// ── Refresh periódico: aprender de decisiones recientes ──────
// Cada 30 minutos escanea cognitive_decisions nuevas y extrae vocabulario.
// Esto garantiza que el modelo aprende continuamente, incluso sin usuario activo.
async function _refrescarPatronesDesdeDB() {
  try {
    // Corte por MARCA DE AGUA, no por ventana de tiempo.
    // Antes: refresh cada 30 min con ventana de 1 h → toda decisión se contaba
    // dos veces, y una tercera si además caía en el bootstrap de cargarEstado().
    // Los tokens de una misma decisión inflaban `total` en cada pasada.
    // Ahora cada decisión entra exactamente una vez, para siempre.
    const corte = _patronesWatermark > 0
      ? `UNIX_TIMESTAMP(ts_decision) > ${Math.floor(_patronesWatermark / 1000)}`
      : `ts_decision > DATE_SUB(NOW(), INTERVAL 1 HOUR)`;   // primer arranque

    const rows = await dbQuery(`
      SELECT LEFT(razon,500) AS razon, senal, outcome_real,
             UNIX_TIMESTAMP(ts_decision) AS ts_epoch
      FROM cognitive_decisions
      WHERE razon IS NOT NULL
        AND ${corte}
        AND outcome_real IN ('correcto','incorrecto')
      ORDER BY ts_decision DESC LIMIT 200
    `);
    if (!rows.length) return;

    let n = 0;
    for (const row of rows) {
      const acerto = row.outcome_real === "correcto";
      const ts = Number(row.ts_epoch) * 1000;
      if (ts > _patronesWatermark) _patronesWatermark = ts;

      const palabras = (row.razon || "").toLowerCase()
        .replace(/[^a-záéíóúüñ0-9\s]/g, " ")
        .split(/\s+/).filter(t => t.length > 4);

      for (const tok of palabras.slice(0, 15)) {
        const p = _patron(tok);
        p.usos++; p.verificados++; p.db_source++;
        if (acerto) p.aciertos++;
        n++;
      }
      // Bigrams
      for (let i = 0; i < Math.min(palabras.length - 1, 8); i++) {
        const p = _patron(`${palabras[i]}_${palabras[i+1]}`);
        p.usos++; p.verificados++; p.db_source++;
        if (acerto) p.aciertos++;
        n++;
      }
    }
    if (n > 0) {
      log(`🔄 Refresh DB: +${n} actualizaciones de patrones desde ${rows.length} decisiones`);
      await guardarEstado();
      await _guardarLearningCycle(0.6, n, "periodic_refresh");
    }
  } catch (e) {
    log(`_refrescarPatronesDesdeDB: ${e.message}`, "warn");
  }
}

// ── Estado de conversación por sesión ────────────────────────
// Guarda el perfil del usuario para personalizar portfolios.
// Key: session_id (o user_id como fallback)
const _sesionState = new Map();
const SESION_TTL = 30 * 60_000;   // 30 min de inactividad → resetear

function _getSesion(id) {
  const k = id || "default";
  let s = _sesionState.get(k);
  if (!s) { s = { paso: null, monto: null, perfil: null, nombre: null, ts: Date.now() }; _sesionState.set(k, s); }
  const now = Date.now();
  for (const [ki, vi] of _sesionState) if (now - vi.ts > SESION_TTL) _sesionState.delete(ki);
  s.ts = Date.now();
  return s;
}

// Detectar si el usuario está dando su nombre
// ⚠️ La versión vieja tomaba CUALQUIER palabra con mayúscula como nombre: un
// "Hola" o un "Gracias" quedaban como nombre del usuario —y se GUARDABAN en
// users.name—, y "soy nuevo" lo bautizaba "nuevo". Ahora decide chat_router.js:
// sólo "me llamo X", "mi nombre es X" o "soy X" con mayúscula, y nunca una
// palabra común.
function _detectarNombre(texto) {
  return chatDetectarNombre(texto);
}

// Detecta si el usuario está respondiendo a la pregunta de monto/perfil
function _respuestaAMonto(texto) {
  return /^\$?\d[\d.,]*[kKmM]?$|dolar|pesos|usd|\$|ars|\d+ mil|\d+ millones/i.test(texto.trim());
}
function _respuestaAPerfil(texto) {
  const t = texto.toLowerCase();
  if (/conserva|bajo riesgo|no perder|segur|capital proteg/i.test(t)) return "conservador";
  if (/moderad|equilibr|algo de riesgo/i.test(t)) return "moderado";
  if (/agresiv|alto riesgo|maximiz|máximo rendimiento/i.test(t)) return "agresivo";
  return null;
}
function _parseMonto(texto) {
  const t = texto.trim();
  if (/no sé|no se|sin capital|no tengo|después|despues|saltearlo/i.test(t)) return null;
  if (/\d/.test(t)) return t.slice(0, 50);
  return null;
}

// ════════════════════════════════════════════════════════════════
// ROUTER DE INTENCIONES DEL CHAT — 2-nov-2026 (el «punto 10»)
// ────────────────────────────────────────────────────────────────
// Antes: las preguntas de opinión («¿qué opinás de US?», «¿ves algún patrón?»)
// salían del 2B sin un solo dato, y cuando el motor no llegaba a tiempo caían a
// plantillas fijas. Ahora cada mensaje se clasifica (chat_router.js), se arma la
// evidencia con lo que el sistema YA tiene en memoria (chat_evidencia.js) y se
// redacta con esos números (chat_redactor.js). El motor de lenguaje sólo entra
// para la charla libre (CLASS25B_CHAT_LLM), y lo que escribe se publica únicamente
// si pasa la validación contra los hechos.
//
// No suma carga al server: el ranking sale de class25a_output y las cotizaciones
// de class7_output (dos mensajes que class25B ya recibía), y la mayoría de las
// respuestas ya no llaman al motor de lenguaje. Las únicas consultas nuevas son
// puntuales: noticias por ticker cuando preguntan por noticias, la base de crisis
// cuando preguntan por crisis, y el ranking de la base SÓLO si el de memoria está
// vacío (recién reiniciado con el mercado cerrado), con caché de 5 min.
// ════════════════════════════════════════════════════════════════
const CHAT_ROUTER = String(process.env.CLASS25B_CHAT_ROUTER ?? "1") !== "0";
// Intenciones que pasan por el motor de lenguaje (con hechos y validación). Por
// defecto sólo la charla libre: las de datos se contestan al instante y sin el
// costo de CPU del 2B. Para que opine el 2B: CLASS25B_CHAT_LLM=libre,opinion,patron
const CHAT_LLM_INTENCIONES = new Set(String(process.env.CLASS25B_CHAT_LLM ?? "libre")
  .split(",").map(x => x.trim()).filter(Boolean));
const CHAT_CHARLA = String(process.env.CLASS25B_CHAT_CHARLA ?? "1") !== "0";
// Charla libre: Gemini PRIMERO (rápido y mejor para opinar), Ollama de respaldo
// cuando Gemini se queda sin cuota, y el redactor interno si los dos fallan —
// así MIIA nunca se queda callada. Reversa: CLASS25B_CHARLA_GEMINI=0 → sólo Ollama.
const CHARLA_GEMINI_PRIMERO = String(process.env.CLASS25B_CHARLA_GEMINI ?? "1") !== "0";
// Precalentar Ollama con cualquier mensaje del chat (8-nov-2026): cuando Gemini da
// 503 la charla cae a Ollama, y si el modelo estaba descargado no llega a tiempo.
// Reversa sin recompilar: MIIA_LLM_PRECALENTAR=0.
const CHARLA_PRECALENTAR = String(process.env.MIIA_LLM_PRECALENTAR ?? "1") !== "0";
const CHAT_PY_URL = String(process.env.MIIA_PY_URL || "http://127.0.0.1:5005").replace(/\/$/, "");
const _UNIVERSO_SET = new Set((TICKERS || []).map(t => String(t).toUpperCase()));

const _chatRanking  = new Map();   // ticker → {senal, puesto, n, k, conf, z, ts}  (de class25A)
const _chatCotiz    = new Map();   // ticker → {cambio, precio, ts}                 (de class7)
const _chatAmplitud = [];          // [{ts, positivos, n, media}] de la sesión en curso
const _chatCtx      = { riesgo: new Map(), sent: new Map(), lstm: new Map() };  // lo que manda el Python
let   _chatMetricas = { datos: null, ts: 0 };
let   _chatRankDB   = { datos: null, ts: 0 };
let   _chatRuedaAbierta = null;
const _chatStats = { directas: 0, asistidas: 0, validadas: 0, descartadas: 0 };

function _chatAnotarRanking(s) {
  try {
    const tk = String(s?.ticker || "").toUpperCase();
    const pu = Number(s?.puesto), n = Number(s?.puestos_n);
    if (!_UNIVERSO_SET.has(tk) || !(pu >= 0) || !(n > 1)) return;
    _chatRanking.set(tk, { senal: s.senal, puesto: pu, n, k: Number(s.rank_k) || null,
                           conf: Number(s.confianza), z: Number(s.z_ensemble), ts: Date.now() });
  } catch (_) {}
}

function _chatAnotarCotizaciones(msg) {
  try {
    if (msg?.type !== "sector_state" || !Array.isArray(msg.sectors)) return;
    const ts = Date.now();
    let pos = 0, n = 0, suma = 0;
    for (const x of msg.sectors) {
      const tk = String(x?.etf || "").toUpperCase(), c = Number(x?.change);
      if (!_UNIVERSO_SET.has(tk) || !isFinite(c)) continue;
      _chatCotiz.set(tk, { cambio: c, precio: Number(x.precio) || null, ts });
      n++; suma += c; if (c > 0) pos++;
    }
    // La amplitud se guarda SÓLO con la rueda abierta, y se reinicia al abrir:
    // así "hace 2 h subían 30" habla de esta sesión y no del cierre de ayer.
    const abierto = estadoNYSE(new Date(ts)).abierto;
    if (abierto && _chatRuedaAbierta === false) _chatAmplitud.length = 0;
    _chatRuedaAbierta = abierto;
    if (abierto && n >= 10) {
      _chatAmplitud.push({ ts, positivos: pos, n, media: suma / n });
      if (_chatAmplitud.length > 400) _chatAmplitud.shift();
    }
  } catch (_) {}
}

// El Python manda riesgo/sentimiento/LSTM sólo de los tickers que el usuario
// nombró (o 12 al azar si no nombró ninguno). Se acumulan con su hora, así
// «¿y el riesgo?» —que ya no nombra a XLK— igual encuentra el dato de XLK.
function _chatAcumularContexto(msg) {
  const ts = Date.now();
  for (const [campo, mapa] of [["riesgo_context", _chatCtx.riesgo],
                               ["sentimiento_context", _chatCtx.sent],
                               ["lstm_context", _chatCtx.lstm]]) {
    const o = msg?.[campo];
    if (!o || typeof o !== "object") continue;
    for (const [tk, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !v._heartbeat) mapa.set(String(tk).toUpperCase(), { v, ts });
    }
    if (mapa.size > 200) for (const [k, e] of mapa) if (ts - e.ts > 3_600_000) mapa.delete(k);
  }
}
function _chatDeCache(mapa, ttl = 3_600_000) {
  const ahora = Date.now(), out = {};
  for (const [k, e] of mapa) if (ahora - e.ts < ttl) out[k] = e.v;
  return out;
}

function _chatHttpJSON(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", d => { buf += d; if (buf.length > 2_000_000) req.destroy(); });
        res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    } catch (_) { resolve(null); }
  });
}

// La tasa de acierto sale de la MISMA medición que el panel Backtesting (el
// endpoint la sirve de su caché). Si el Python ya la manda en el mensaje
// (`metricas_context`), se usa esa. chat_evidencia descarta cualquier acierto
// fuera de 30-70 %: el «97 %» inflado no puede colarse por acá.
async function _chatMetricasFrescas(msg) {
  // El `metricas_context` del Python de antes del 6-nov no trae con qué calcular
  // la ventaja contra el azar (ni `edge_vs_azar` ni la precisión por señal): en
  // ese caso se pide el endpoint, que sí la trae, para decir lo mismo que el panel.
  const mc = msg?.metricas_context;
  if (mc && (mc.edge_vs_azar != null || mc.precision_buy != null)) return mc;
  if (_chatMetricas.datos && Date.now() - _chatMetricas.ts < 5 * 60_000) return _chatMetricas.datos;
  const d = await _chatHttpJSON(`${CHAT_PY_URL}/api/backtesting/professional`, 3500);
  if (d && d.accuracy_directional != null) _chatMetricas = { datos: d, ts: Date.now() };
  return _chatMetricas.datos || mc || null;
}

// Sólo si el ranking en memoria está vacío (class25B recién reiniciado con el
// mercado cerrado): la última decisión por instrumento, ordenada por score.
// Es aproximado y el redactor lo dice.
async function _chatRankingDesdeDB() {
  if (_chatRankDB.datos && Date.now() - _chatRankDB.ts < 5 * 60_000) return _chatRankDB.datos;
  try {
    const filas = _rows(await dbQuery(`
      SELECT ticker, senal, confianza, score, UNIX_TIMESTAMP(ts_decision) * 1000 AS ts
      FROM cognitive_decisions
      WHERE ts_decision > NOW() - INTERVAL 4 DAY
        AND ticker IS NOT NULL AND ticker <> 'GENERAL' AND ticker NOT LIKE 'class%'
        AND score IS NOT NULL AND COALESCE(temperatura, '') <> 'shadow'
      ORDER BY id DESC LIMIT 600`));
    const ult = new Map();
    for (const f of filas) {
      const tk = String(f.ticker || "").toUpperCase();
      if (_UNIVERSO_SET.has(tk) && !ult.has(tk)) ult.set(tk, f);
    }
    const orden = [...ult.values()].sort((a, b) => Number(b.score) - Number(a.score));
    const n = orden.length;
    if (n < 10) return null;
    const k = Math.max(1, Math.round(n * 2 / 13));
    const datos = {};
    orden.forEach((f, i) => {
      datos[String(f.ticker).toUpperCase()] = { senal: f.senal, puesto: i, n, k, conf: Number(f.confianza),
                                                ts: Number(f.ts) || Date.now(), aprox: true };
    });
    _chatRankDB = { datos, ts: Date.now() };
    return datos;
  } catch (_) { return null; }
}

async function _chatNoticias(tickers) {
  const tks = [...new Set(tickers.map(t => String(t).toUpperCase()).filter(t => _UNIVERSO_SET.has(t)))].slice(0, 6);
  const sent = {}, titulares = {};
  try {
    const marcas = tks.map(() => "?").join(",");
    const [s, n] = await Promise.all([
      dbQuery(tks.length
        ? `SELECT ticker, sentiment_label, n_articulos FROM sentiment_signals
             WHERE ticker IN (${marcas}) AND ts > NOW() - INTERVAL 3 DAY ORDER BY ts DESC LIMIT 30`
        : `SELECT ticker, sentiment_label, n_articulos FROM sentiment_signals
             WHERE ts > NOW() - INTERVAL 2 DAY ORDER BY ts DESC LIMIT 80`, tks).catch(() => []),
      tks.length ? dbQuery(`SELECT ticker, titulo, fuente,
             DATE_FORMAT(COALESCE(ts_publicado, ts_guardado), '%d/%m %H:%i') AS fecha
             FROM noticias WHERE ticker IN (${marcas}) AND ts_guardado > NOW() - INTERVAL 48 HOUR
             ORDER BY ts_guardado DESC LIMIT 12`, tks).catch(() => []) : [],
    ]);
    for (const f of _rows(s)) { const tk = String(f.ticker).toUpperCase(); if (!sent[tk]) sent[tk] = f; }
    for (const f of _rows(n)) { const tk = String(f.ticker).toUpperCase(); (titulares[tk] ||= []).push(f); }
  } catch (_) {}
  return { sent, titulares };
}

async function _chatPanel(it, msg, nombre) {
  _chatAcumularContexto(msg);
  const ahora = Date.now();
  let ranking = Object.fromEntries(_chatRanking);
  const frescos = [..._chatRanking.values()].filter(r => ahora - r.ts < 4 * 86_400_000).length;
  if (frescos < 10) { const db = await _chatRankingDesdeDB(); if (db) ranking = { ...db, ...ranking }; }

  const tks = [...(it.tickers || []), ...(it.grupos || []).flatMap(g => g.tickers || []),
               ...(it.grupo?.tickers || []), ...(it.tema?.tickers || [])];
  let noticias = { sent: {}, titulares: {} };
  if (it.intencion === "noticias") noticias = await _chatNoticias(tks);
  let crisis = [];
  if (it.intencion === "crisis") {
    crisis = _rows(await dbQuery(`SELECT nombre, anio_inicio, anio_fin, tipo, severidad
      FROM crisis_events ORDER BY severidad DESC, anio_inicio DESC LIMIT 8`).catch(() => []));
  }
  const metricas = it.intencion === "acierto"
    ? await _chatMetricasFrescas(msg)
    : (msg?.metricas_context || _chatMetricas.datos);

  return armarPanel({
    ahora, instrumentos: INSTRUMENTOS,
    cotizaciones: Object.fromEntries(_chatCotiz), ranking, amplitud: _chatAmplitud.slice(),
    riesgo: historialRiesgo.length ? historialRiesgo[historialRiesgo.length - 1] : null,
    sentimiento: { ..._chatDeCache(_chatCtx.sent), ...noticias.sent },
    lstm: _chatDeCache(_chatCtx.lstm),
    riesgoActivo: _chatDeCache(_chatCtx.riesgo),
    titulares: noticias.titulares, metricas, crisis,
    alertas: (alertasActivas || []).map(a => _alertaLegible(a)),
    mercado: estadoNYSE(new Date(ahora)), nombre,
  });
}

// Lo que se recuerda de la charla para seguir el hilo («¿y el riesgo?»).
const _CHAT_TEMAS = new Set(["opinion", "senal", "porque", "riesgo", "precio", "noticias",
                             "comparar", "ranking", "patron", "resumen", "regimen", "mi_portfolio"]);

// ── El portafolio de cada usuario (4-nov-2026) ───────────────────────────
// La sesión de class25B dura 30 min y la web abre una nueva en cada recarga,
// así que el portafolio que MIIA acababa de armar «no existía» para la pregunta
// siguiente y volvía la plantilla «¿cuál es tu tolerancia al riesgo?». Ahora hay
// dos memorias: la de la web (localStorage, viaja en `portfolio_usuario`), que
// manda, y ésta, por user_id, para cuando el navegador no la mande.
//
// 5-nov-2026: esta memoria vivía SÓLO en RAM, y cada deploy de class25B (hubo
// tres en dos días) la borraba. Como el Python que reenvía la copia de la web
// todavía no está desplegado, después de cada reinicio «¿mi porfolio sigue en
// vigencia?» contestaba «no encuentro una cartera tuya». Ahora se guarda en
// state/ (escritura atómica, sólo cuando cambia) y se relee al arrancar.
// Acotada: 30 días y 2.000 usuarios (cada entrada son ~12 símbolos y pesos).
// 26-nov-2026: hasta 3 portafolios por usuario, uno ACTIVO (chat_portafolios.js).
// La clave es la CUENTA (`clave_portafolio`, que arma el Python con el JWT) y, si
// el visitante no entró con Google, el id de su navegador (`user_id`).
const _portUsuario = new Map();
const PORT_USUARIO_TTL = Number(process.env.CLASS25B_PORT_DIAS || 30) * 86_400_000, PORT_USUARIO_MAX = 2000;
const PORT_USUARIO_FILE = path.join(STATE_DIR, "class25b_portfolios_usuario.json");
let _portUsuarioTimer = null;

function _uidPort(msg) {
  const k = msg?.clave_portafolio || msg?.user_id;
  return k ? String(k).slice(0, 80) : null;
}

async function _escribirPortUsuario() {
  // `resumen` va precalculado: el Python lo lee de este archivo para el panel.
  const filas = [..._portUsuario].map(([uid, e]) => ({ uid, guardado: e.guardado, config: e.config || null,
    activo: e.activo, ports: e.ports, resumen: portsResumen(e) }));
  await _escribirAtomico(PORT_USUARIO_FILE, JSON.stringify({ version: 2, filas }));
}
function _guardarPortUsuario() {
  if (_portUsuarioTimer) return;
  _portUsuarioTimer = setTimeout(async () => {
    _portUsuarioTimer = null;
    try { await _escribirPortUsuario(); }
    catch (e) { log(`⚠️ portafolios por usuario: no se pudo guardar (${e?.message})`, "warn"); }
  }, 1000);
  _portUsuarioTimer.unref?.();
}

function _cargarPortUsuario() {
  try {
    if (!fs.existsSync(PORT_USUARIO_FILE)) return;
    const j = JSON.parse(fs.readFileSync(PORT_USUARIO_FILE, "utf8"));
    const ahora = Date.now();
    for (const f of (Array.isArray(j?.filas) ? j.filas : [])) {
      if (!f?.uid || typeof f.uid !== "string" || !Number.isFinite(f.guardado)) continue;
      if (ahora - f.guardado > PORT_USUARIO_TTL) continue;
      // v1 traía un solo `port`; normalizarEntrada lo migra a un slot.
      const e = portsNormalizarEntrada(f, normalizarPortfolio, ahora);
      if (!e || !e.ports.length) continue;
      e.config = normalizarConfig(f.config);
      _portUsuario.set(f.uid.slice(0, 80), e);
    }
    while (_portUsuario.size > PORT_USUARIO_MAX) _portUsuario.delete(_portUsuario.keys().next().value);
    log(`👤 portafolios por usuario: ${_portUsuario.size} cuentas recuperadas del disco`);
  } catch (e) { log(`⚠️ portafolios por usuario: archivo ilegible, se arranca vacío (${e?.message})`, "warn"); }
}
_cargarPortUsuario();

function _entradaPort(msg) {
  const uid = _uidPort(msg);
  if (!uid) return null;
  let e = _portUsuario.get(uid);
  // Primera vez con la cuenta: lo que estaba guardado con el id del navegador
  // se muda a la cuenta, así no se pierde al entrar con Google.
  if (!e && msg?.clave_portafolio && msg?.user_id && String(msg.user_id).slice(0, 80) !== uid) {
    const viejo = String(msg.user_id).slice(0, 80);
    const e2 = _portUsuario.get(viejo);
    if (e2) { _portUsuario.delete(viejo); _portUsuario.set(uid, e2); _guardarPortUsuario(); e = e2; }
  }
  if (!e) return null;
  if (Date.now() - e.guardado > PORT_USUARIO_TTL) { _portUsuario.delete(uid); return null; }
  return e;
}
function _tocarEntrada(uid, e) {
  _portUsuario.delete(uid);
  e.guardado = Date.now();
  _portUsuario.set(uid, e);
  while (_portUsuario.size > PORT_USUARIO_MAX) _portUsuario.delete(_portUsuario.keys().next().value);
  _guardarPortUsuario();
}

/** La copia que manda la web pisa el ACTIVO (no agrega uno nuevo). */
function _recordarPortfolio(msg, rec) {
  const uid = _uidPort(msg);
  const sl = portsSlot(rec, normalizarPortfolio);
  if (!uid || !sl) return;
  const prev = _portUsuario.get(uid);
  if (prev && JSON.stringify(portsActivo(prev)) === JSON.stringify(sl.port)) return;   // sin cambios
  _tocarEntrada(uid, portsActualizarActivo(prev, sl));
}

/**
 * Un portafolio NUEVO (armado por MIIA o a mano). Si ya hay 3, no se guarda:
 * queda pendiente en la sesión y se pregunta cuál reemplazar. Devuelve true si
 * quedó guardado.
 */
function _guardarNuevoPortfolio(msg, sesion, rec) {
  const uid = _uidPort(msg);
  const sl = portsSlot(rec, normalizarPortfolio);
  if (!uid || !sl) return false;
  const e = _portUsuario.get(uid) || null;
  const r = portsAgregar(e, sl);
  if (!r.guardado) return false;
  _tocarEntrada(uid, r.entrada);
  return true;
}

/** El portafolio ACTIVO del usuario: el que manda la web, si no el guardado acá. */
function _portfolioDelUsuario(msg) {
  const web = normalizarPortfolio(msg?.portfolio_usuario);
  if (web) { _recordarPortfolio(msg, msg.portfolio_usuario); return web; }
  return portsActivo(_entradaPort(msg));
}

/** El plazo/umbral del usuario: el guardado por cuenta, si no el de la sesión. */
function _configDelUsuario(msg, sesion) {
  const e = _entradaPort(msg);
  return e?.config || sesion?.config || null;
}
function _guardarConfig(msg, sesion, cfg) {
  const prev = _configDelUsuario(msg, sesion) || {};
  const nuevo = normalizarConfig({ ...prev, ...cfg });
  sesion.config = nuevo;
  const e = _entradaPort(msg);
  if (e) { e.config = nuevo; _guardarPortUsuario(); }
  return nuevo;
}

/** Si la sesión es nueva pero el usuario ya tiene perfil, no se lo vuelve a preguntar. */
function _hidratarSesion(sesion, msg) {
  if (sesion.perfil) return;
  const p = _portfolioDelUsuario(msg);
  if (p?.perfil) { sesion.perfil = p.perfil; if (!sesion.monto && p.monto) sesion.monto = p.monto; }
}

/** Arma la cartera con los datos del ciclo, la publica y la recuerda. */
async function _chatPublicarCartera(texto, msg, sesion, nombre, op = {}) {
  sesion.paso = null;
  if (!sesion.capital && sesion.monto) sesion.capital = extraerCapital(sesion.monto);
  const ctx = await _construirContextoCompleto("portafolio inversión").catch(() => null);
  const base = ctx?.portfolios?.[0] || ctx?.portfolio || null;
  const cartera = armarCartera(base?.activos, sesion.perfil, sesion.capital || null);
  const rs = cartera.map(a => Number(a.riesgo_pct)).filter(Number.isFinite);
  const riesgoCartera = rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : (base?.riesgo_pct ?? null);
  const resp = redactarCartera(cartera, { perfil: sesion.perfil, capital: sesion.capital || null,
    riesgoCartera, riesgoGlobal: ctx?.riesgoGlobal ?? null, nombre, ajuste: !!op.ajuste,
    intro: op.intro || null, semilla: `${texto}|${Date.now()}` });
  const monto = sesion.capital?.texto || null;
  sesion.monto = monto;
  const rec = cartera.length ? { portfolio_recomendado: {
    perfil: sesion.perfil, monto, riesgo_pct: riesgoCartera, confianza_pct: base?.confianza_pct ?? null,
    ts: new Date().toISOString(),
    activos: cartera.map(a => ({ symbol: a.symbol, sector: a.sector, peso_pct: a.peso_pct,
      riesgo_pct: a.riesgo_pct, cambio_pct: a.cambio_pct, monto: a.monto })) } } : null;
  // 26-nov-2026: hasta 3 por usuario. Un ajuste («pasala a conservador») pisa el
  // activo; una cartera nueva ocupa un lugar libre o, con 3, pregunta cuál reemplazar.
  let guardada = false;
  if (rec) {
    if (op.ajuste) { _recordarPortfolio(msg, rec.portfolio_recomendado); guardada = true; }
    else guardada = _guardarNuevoPortfolio(msg, sesion, rec.portfolio_recomendado);
    if (guardada) sesion.carteraTs = Date.now();
  }
  sesion.chatOferta = null;
  sesion.chatUltima = "cartera";
  sesion.chatPrevio = { intencion: "mi_portfolio", tickers: [], grupo: null };
  // Con la cartera recién armada se pregunta el plazo, que define cuándo MIIA
  // le dice que la revise (13-nov-2026). Si ya lo tiene, no se repregunta.
  let final = resp;
  if (rec && !op.ajuste) {
    if (op.config) _guardarConfig(msg, sesion, op.config);
    if (!_configDelUsuario(msg, sesion)) { final = `${resp} ${preguntarPlazo({ semilla: texto })}`; sesion.paso = "esperando_plazo"; }
  }
  if (rec && !guardada) {
    sesion.portPendiente = { rec: rec.portfolio_recomendado, texto: final, paso: sesion.paso || null };
    sesion.paso = "reemplazar_portafolio";
    const pide = `Armé la cartera nueva, pero antes de guardarla: ${portsTextoPedirReemplazo(_entradaPort(msg))}`;
    await _publicarRespuesta(pide, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [cartera nueva · 3 llenos, pide reemplazo] publicada`);
    return;
  }
  await _publicarRespuesta(final, msg, rec);
  _chatStats.directas++;
  log(`👤 Respuesta [cartera ${sesion.perfil}${monto ? " · " + monto : ""}${op.ajuste ? " · ajuste" : ""}] publicada (${resp.length} chars)`);
}

// ── El motor REDACTA, el sistema DECIDE (13-nov-2026) ──────────────────────
// Pedido de Martín: sin plantillas, pero con los datos del sistema y el menor
// riesgo posible. El redactor determinístico arma la respuesta (números,
// instrumentos, conclusión) y el motor sólo la reescribe. Se descarta si:
//   · cita un número o un instrumento que no está en la respuesta del sistema
//     (validarRespuesta ESTRICTO, con esa respuesta como único hecho);
//   · cambia la conclusión (`debe` / `noDebe`, p. ej. el veredicto del portafolio);
//   · da un consejo de compra/venta propio o nombra un proveedor.
// Si nada pasa, sale la respuesta del sistema tal cual: nunca una cifra inventada.
// Reversa sin recompilar: CLASS25B_CHAT_REESCRIBIR=0.
const CHAT_REESCRIBIR = String(process.env.CLASS25B_CHAT_REESCRIBIR ?? "1") !== "0";
const REESCRIBIR_INTENCIONES = new Set(["opinion", "senal", "porque", "riesgo", "precio", "noticias", "comparar",
  "ranking", "patron", "resumen", "regimen", "acierto", "mercado_abierto", "fuera_universo", "activo_externo", "mi_portfolio"]);
const REF_MAX = 600;
// Gemini primero; Ollama SÓLO para respuestas cortas (13-nov-2026, decidido por
// Martín). La cuenta con lo que Ollama midió de sí mismo en el server (24,7 ms
// por token leído, 102,8 ms por token escrito): una referencia de 600 caracteres
// son ~450 tokens de prompt (~11 s) y ~150 de salida (~15 s), y no entra nunca en
// los 12 s — el usuario esperaba 12 s para ver la respuesta del sistema igual.
// Con ≤ 200 caracteres, sin historial y 60 tokens de salida, el peor caso (prefijo
// frío) es ~11,6 s; con el prefijo en la caché de Ollama, ~8 s. sim32 sección 7c
// rehace esta cuenta y se pone en rojo si alguien agranda algo.
const REESCRIBIR_LOCAL_CHARS  = Number(process.env.CLASS25B_REESCRIBIR_LOCAL_CHARS  || 200);
const REESCRIBIR_LOCAL_TOKENS = Number(process.env.CLASS25B_REESCRIBIR_LOCAL_TOKENS || 60);
function _acotarReferencia(t) {
  const s = String(t || "");
  return s.length <= REF_MAX ? s : (s.slice(0, REF_MAX).match(/^[\s\S]*[.!?](?=\s)/)?.[0] || s.slice(0, REF_MAX));
}
async function _reescribirConMotor(texto, base, ev, historial, { debe = null, noDebe = null } = {}) {
  if (!CHAT_REESCRIBIR || !base || !_hayMotorLenguaje(true)) return null;
  const corta = String(base).length <= REESCRIBIR_LOCAL_CHARS;
  // Larga y sin Gemini: no hay motor que llegue a tiempo. Sale la del sistema YA,
  // en vez de esperar 12 s a un Ollama que no termina.
  if (!corta && !(CHARLA_GEMINI_PRIMERO && _geminiReady(true))) return null;
  const referencia = _acotarReferencia(base);
  const evRef = { ...(ev || {}), hechos: [referencia] };
  const validar = t => {
    const v = validarRespuesta(t, evRef, { tickers: TICKERS_TEXTO });
    if (!v.ok) return v;
    if (debe && !debe.test(v.texto)) return { ok: false, motivo: "cambió la conclusión del sistema", texto: v.texto };
    if (noDebe && noDebe.test(v.texto)) return { ok: false, motivo: "contradice la conclusión del sistema", texto: v.texto };
    return v;
  };
  _chatStats.asistidas++;
  try {
    const r = await _geminiMultiTurno(texto, { _modo: "reescribir", _referencia: referencia }, historial, true,
                                      { geminiPrimero: CHARLA_GEMINI_PRIMERO, validar, soloGemini: !corta, sinCarrera: true,
                                        localTurnos: 0, localMaxTokens: REESCRIBIR_LOCAL_TOKENS });
    if (!r?.texto) return null;
    const v = validar(r.texto);
    if (!v.ok) return null;
    _chatStats.validadas++;
    return { texto: v.texto, motor: r.motor };
  } catch (e) { log(`⚠️ motor (reescribir): ${e?.message}`, "warn"); return null; }
}

/** Cartera que arma el propio usuario («SPY 50, QQQ 30, EWZ 20»): se guarda y se analiza. */
async function _chatPublicarCarteraManual(texto, msg, sesion, arm, historial) {
  sesion.paso = null;
  const tks = arm.activos.map(a => a.symbol);
  const panelM = await _chatPanel({ intencion: "mi_portfolio", tickers: tks, grupos: [] }, msg, null);
  const hoyM = panelM?.cotiz || {};
  const ahoraIso = new Date().toISOString();
  const recM = { perfil: sesion.perfil || null, monto: sesion.capital?.texto || null, riesgo_pct: null,
    confianza_pct: null, ts: ahoraIso, modo: "manual",
    activos: arm.activos.map(a => ({ symbol: a.symbol, sector: panelM?.inst?.[a.symbol]?.sector || null,
      peso_pct: a.peso_pct, riesgo_pct: null, cambio_pct: hoyM[a.symbol]?.cambio ?? null, monto: null })) };
  const guardadaM = _guardarNuevoPortfolio(msg, sesion, recM);
  if (guardadaM) sesion.carteraTs = Date.now();
  if (arm.config) _guardarConfig(msg, sesion, arm.config);
  const port = normalizarPortfolio(recM);
  const evM = evaluarPortfolio(port, panelM);
  let resp = `Listo, guardé tu portafolio${arm.fuera?.length ? ` (dejé afuera ${arm.fuera.slice(0, 3).join(", ")}: no ${arm.fuera.length > 1 ? "están" : "está"} entre los 50 que mido)` : ""}. `
    + redactarMiPortfolio(port, evM, { semilla: `${texto}|${Date.now()}`, ahora: Date.now() });
  if (!_configDelUsuario(msg, sesion)) { resp += ` ${preguntarPlazo({ semilla: texto })}`; sesion.paso = "esperando_plazo"; }
  sesion.chatOferta = null; sesion.chatUltima = "cartera";
  sesion.chatPrevio = { intencion: "mi_portfolio", tickers: [], grupo: null };
  if (!guardadaM) {
    sesion.portPendiente = { rec: recM, texto: resp.replace(/^Listo, guardé tu portafolio[^.]*\.\s*/, ""), paso: sesion.paso || null };
    sesion.paso = "reemplazar_portafolio";
    await _publicarRespuesta(`Antes de guardar tu portafolio nuevo: ${portsTextoPedirReemplazo(_entradaPort(msg))}`, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [cartera manual · 3 llenos, pide reemplazo] publicada`);
    return;
  }
  await _publicarRespuesta(resp, msg, { portfolio_recomendado: recM });
  _chatStats.directas++;
  log(`👤 Respuesta [cartera manual · ${tks.join(",")}] publicada (${resp.length} chars)`);
}

/**
 * Contesta un mensaje del chat con el router. Devuelve true si publicó la
 * respuesta; false para que siga el camino de antes (flujo de portfolio).
 */
/**
 * Hasta 3 portafolios (26-nov-2026): la elección de cuál reemplazar cuando ya hay
 * 3, y los comandos «mis portafolios», «usá el portafolio 2», «borrá el portafolio 3».
 * Devuelve true si contestó.
 */
async function _chatPortafolios(texto, msg, sesion) {
  const uid = _uidPort(msg);
  if (!uid) return false;
  const publicar = async (resp, extra = null, etiqueta = "") => {
    sesion.chatTurnos = (sesion.chatTurnos || 0) + 1;
    sesion.chatOferta = null; sesion.chatUltima = "mi_portfolio";
    sesion.chatPrevio = { intencion: "mi_portfolio", tickers: [], grupo: null };
    await _publicarRespuesta(resp, msg, extra);
    _chatStats.directas++;
    log(`👤 Respuesta [portafolios·${etiqueta}] publicada (${resp.length} chars)`);
    return true;
  };
  if (sesion.paso === "reemplazar_portafolio" && sesion.portPendiente) {
    const e = _entradaPort(msg);
    const r = portsElegirReemplazo(texto);
    if (r === "cancelar") {
      sesion.paso = null; sesion.portPendiente = null;
      return publicar(`Listo, no guardé la cartera nueva. Siguen tus ${e?.ports?.length || 0} portafolios como estaban.`, null, "cancelar");
    }
    if (Number.isInteger(r) && e && r <= e.ports.length) {
      const pend = sesion.portPendiente;
      sesion.portPendiente = null; sesion.paso = pend.paso || null;
      portsReemplazar(e, r, portsSlot(pend.rec, normalizarPortfolio));
      _tocarEntrada(uid, e);
      sesion.carteraTs = Date.now();
      return publicar(`Listo, la guardé en el lugar ${r}. ${pend.texto}`, { portfolio_recomendado: pend.rec }, `reemplazo ${r}`);
    }
    if (e && (portsHablaDeCarteras(texto) || String(texto).trim().split(/\s+/).length <= 3))
      return publicar(portsTextoPedirReemplazo(e), null, "repregunta");
    sesion.paso = null; sesion.portPendiente = null;   // cambió de tema: se descarta y sigue el flujo
    return false;
  }
  const c = portsComando(texto);
  if (!c) return false;
  const e = _entradaPort(msg);
  if (c.accion === "listar") return publicar(portsTextoLista(e), null, "listar");
  if (!e || !c.n || c.n > e.ports.length) return publicar(portsTextoNoExiste(e, c.n), null, "no existe");
  if (c.accion === "activar") {
    portsActivar(e, c.n);
    const p = portsActivo(e);
    if (p?.perfil) sesion.perfil = p.perfil;
    sesion.monto = p?.monto || null; sesion.capital = null;
    _tocarEntrada(uid, e);
    return publicar(portsTextoActivado(e), null, `activar ${c.n}`);
  }
  portsBorrar(e, c.n);
  if (!e.ports.length) _portUsuario.delete(uid);
  _guardarPortUsuario();
  return publicar(portsTextoBorrado(e, c.n), null, `borrar ${c.n}`);
}

async function _chatConRouter(texto, msg, sesion, historial, nombreUsuario) {
  _hidratarSesion(sesion, msg);
  if (await _chatPortafolios(texto, msg, sesion)) return true;
  // Cualquier mensaje del chat despierta a Ollama (a lo sumo uno cada 4 min), así
  // la charla que venga después no paga la carga del modelo en frío.
  if (CHAT_CHARLA && CHARLA_PRECALENTAR && LLM_USA_LOCAL && typeof LLM.precalentar === "function") {
    try { LLM.precalentar(); } catch (_) {}
  }
  const it = chatClasificar(texto, { universo: TICKERS, reconocidos: TICKERS_TEXTO,
                                     previo: sesion.chatPrevio || null, oferta: sesion.chatOferta || null,
                                     ultima: sesion.chatUltima || null });

  // ── La cartera, como conversación (4-nov-2026) ──────────────────────
  // Antes era un formulario: «Respondé 1, 2 o 3» y después «¿con cuánto
  // capital…?», sin entender «agrecivo» ni «agresivo con 10 mil». Ahora se
  // entiende perfil y capital en cualquier orden, con errores de tipeo, en uno
  // o en varios mensajes, y la cartera sale apenas se sabe el perfil.
  // ── Armado automático o manual + plazo (13-nov-2026) ─────────────────
  const arm = decidirArmado(sesion, texto, it, { universo: TICKERS, perfilDicho: !!entenderPerfilCapital(texto).perfil });
  if (arm.accion === "preguntar_modo" || arm.accion === "preguntar_activos") {
    // Lo que ya dijo de perfil o capital no se pierde mientras se elige el modo.
    const dice = entenderPerfilCapital(texto);
    if (dice.perfil) sesion.perfil = dice.perfil;
    if (dice.capital) sesion.capital = dice.capital;
    const r = arm.accion === "preguntar_modo"
      ? preguntarModo({ semilla: `${texto}|${Date.now()}`, nombre: nombreUsuario })
      : preguntarActivos({ semilla: `${texto}|${Date.now()}`, fuera: arm.fuera || [] });
    sesion.chatUltima = "cartera"; sesion.chatOferta = null;
    await _publicarRespuesta(r, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [armado·${arm.accion}] publicada (${r.length} chars)`);
    return true;
  }
  if (arm.accion === "config") {
    const cfg = _guardarConfig(msg, sesion, arm.config);
    const r = confirmarConfig(cfg, { semilla: `${texto}|${Date.now()}` });
    sesion.chatUltima = "mi_portfolio"; sesion.chatOferta = null;
    await _publicarRespuesta(r, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [armado·config ${JSON.stringify(cfg)}] publicada`);
    return true;
  }
  if (arm.accion === "armar_manual") {
    await _chatPublicarCarteraManual(texto, msg, sesion, arm, historial);
    return true;
  }
  if (arm.accion === "seguir_ia") {
    if (arm.config) _guardarConfig(msg, sesion, arm.config);
    const dice = entenderPerfilCapital(texto);
    if (dice.perfil) sesion.perfil = dice.perfil;
    if (dice.capital) sesion.capital = dice.capital;
    if (sesion.perfil) { await _chatPublicarCartera(texto, msg, sesion, nombreUsuario, {}); return true; }
    sesion.paso = "esperando_perfil";
    const r = preguntarPerfil({ semilla: `${texto}|${Date.now()}`, nombre: nombreUsuario, capital: sesion.capital });
    sesion.ultimaPregPerfil = r; sesion.chatUltima = "cartera";
    await _publicarRespuesta(r, msg);
    _chatStats.directas++;
    return true;
  }

  const turno = decidirCartera(sesion, texto, it);
  if (turno.accion === "armar") {
    await _chatPublicarCartera(texto, msg, sesion, nombreUsuario, { ajuste: turno.ajuste });
    return true;
  }
  if (turno.accion === "preguntar" || turno.accion === "repreguntar") {
    if (!sesion.paso) sesion.paso = "esperando_perfil";
    sesion.chatUltima = "cartera"; sesion.chatOferta = null;
    const r = turno.accion === "preguntar"
      ? preguntarPerfil({ semilla: `${texto}|${Date.now()}`, nombre: nombreUsuario, capital: sesion.capital,
                          evitar: sesion.ultimaPregPerfil })
      : repreguntarPerfil(texto, { semilla: `${Date.now()}` });
    sesion.ultimaPregPerfil = r;
    await _publicarRespuesta(r, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [cartera·${turno.accion}] publicada (${r.length} chars)`);
    return true;
  }

  // "Dale" / "contame más": se ejecuta lo que MIIA había propuesto, o se amplía
  // el último tema con información nueva.
  let ef = it;
  if (it.intencion === "seguir" && it.destino) ef = { ...it, ...it.destino, texto };
  // Un activo fuera del universo que el Python ya salió a buscar ("acciones de YPF").
  const act = msg?.activo_context;
  // ("¿qué opinás de Nvidia?" sin ticker del universo cae en "resumen": igual es
  // una pregunta por ESE activo.)
  if (act?.ticker && !_UNIVERSO_SET.has(String(act.ticker).toUpperCase()) && !(ef.tickers || []).length
      && ["libre", "opinion", "precio", "senal", "noticias", "riesgo", "resumen", "porque"].includes(ef.intencion)) {
    ef = { ...ef, intencion: "activo_externo", activo: act };
  }

  // «¿El portafolio que me armaste sirve para este régimen?»: se compara SU
  // cartera contra el mercado con números, sin plantilla y sin motor de lenguaje.
  if (ef.intencion === "mi_portfolio") {
    // «Borrá mi cartera»: se olvida (sesión, memoria y disco) en vez de evaluarla
    // o armar otra con el perfil guardado (6-nov-2026).
    if (ef.subtipo === "borrar") {
      // 26-nov-2026: con hasta 3, «borrá mi cartera» borra la ACTIVA, no todas.
      const ePort = _entradaPort(msg);
      let resp;
      if (ePort?.ports?.length) {
        const nB = ePort.activo + 1;
        portsBorrar(ePort, nB);
        if (!ePort.ports.length) _portUsuario.delete(_uidPort(msg));
        _guardarPortUsuario();
        resp = portsTextoBorrado(ePort, nB);
        if (!ePort.ports.length) { sesion.perfil = null; sesion.capital = null; sesion.monto = null; }
      } else {
        resp = sesion.perfil
          ? "Listo, me olvidé de tu perfil. No tenías ninguna cartera guardada."
          : "No tengo ninguna cartera tuya guardada, así que no hay nada que borrar.";
        sesion.perfil = null; sesion.capital = null; sesion.monto = null;
      }
      sesion.carteraTs = null; sesion.paso = null;
      sesion.chatTurnos = (sesion.chatTurnos || 0) + 1;
      sesion.chatOferta = null; sesion.chatUltima = "mi_portfolio"; sesion.chatPrevio = null;
      await _publicarRespuesta(resp, msg);
      _chatStats.directas++;
      log(`👤 Respuesta [redactor·mi_portfolio borrar] publicada (${resp.length} chars)`);
      return true;
    }
    const port = _portfolioDelUsuario(msg);
    let resp;
    if (!port) {
      // Ya sé su perfil: en vez de mandarlo a pedirla, se la armo ahora —diciendo
      // que la anterior no estaba, para que no parezca que ignoró la pregunta—.
      if (sesion.perfil) {
        await _chatPublicarCartera(texto, msg, sesion, nombreUsuario, {
          intro: "No encontré guardada la cartera anterior, así que te armo una nueva con tu perfil y los datos de hoy." });
        return true;
      }
      // Sin cartera y sin perfil: se contesta la parte que sí se puede
      // («¿sirve para este régimen?» → cómo se lee el mercado hoy) y se pide el
      // perfil con ejemplos, sin el «Dale.» suelto de antes.
      let reg = null;
      try {
        const panelR = await _chatPanel({ intencion: "regimen", tickers: [], grupos: [] }, msg, nombreUsuario);
        const evR = chatEvidencia({ intencion: "regimen", tickers: [], grupos: [] }, panelR);
        if (evR.datos.regimen) reg = { ...evR.datos.regimen, enRueda: !!evR.datos.mercado?.abierto };
      } catch (_) {}
      resp = preguntarPerfil({ semilla: `${texto}|${Date.now()}`, nombre: nombreUsuario,
                               contexto: "sin_portfolio", regimen: reg });
      sesion.paso = "esperando_perfil";
    } else {
      const panelP = await _chatPanel({ ...ef, tickers: port.activos.map(a => a.symbol) }, msg, nombreUsuario);
      const evP = evaluarPortfolio(port, panelP);
      // «¿Lo cambio?»: el SISTEMA decide (regla escrita en chat_portfolio) y el
      // motor sólo lo redacta, sin poder dar vuelta la decisión (13-nov-2026).
      const ver = ef.subtipo === "ajustar"
        ? veredictoPortfolio(port, evP, panelP, umbralesPara(_configDelUsuario(msg, sesion))) : null;
      resp = redactarMiPortfolio(port, evP, { semilla: `${texto}|${sesion.chatTurnos || 0}`,
        subtipo: ef.subtipo || null, detalle: ef.detalle || 1, veredicto: ver });
      log(`👤 mi_portfolio: ${port.activos.length} activos · encaje=${evP.encaje} · rel=${evP.relativo?.toFixed?.(2) ?? "s/d"}`
        + `${ver ? ` · veredicto=${ver.decision}` : ""}`);
      const CONCLUSION = {
        cambiar:  [/(cambi|revis|ajust)/i, /(mantenelo|no hace falta cambi|no lo cambies|esper[aá] antes)/i],
        mantener: [/(manten|no hace falta|no (lo )?cambies|dejalo)/i, /(conviene (cambiarlo|revisarlo)|s[ií], conviene)/i],
        esperar:  [/(esper|aguard|todav[ií]a no)/i, /(conviene (cambiarlo|revisarlo)|s[ií], conviene|mantenelo)/i],
      }[ver?.decision] || [null, null];
      const rw = await _reescribirConMotor(texto, resp, {}, historial,
                                           { debe: CONCLUSION[0], noDebe: CONCLUSION[1] });
      if (rw) { resp = rw.texto; log(`👤 mi_portfolio redactado por el motor (${rw.motor})`); }
    }
    sesion.chatTurnos = (sesion.chatTurnos || 0) + 1;
    sesion.chatOferta = null;
    sesion.chatUltima = "mi_portfolio";
    sesion.chatPrevio = { intencion: "mi_portfolio", tickers: [], grupo: null };
    await _publicarRespuesta(resp, msg);
    _chatStats.directas++;
    log(`👤 Respuesta [redactor·mi_portfolio${ef.subtipo ? " " + ef.subtipo : ""}] publicada (${resp.length} chars)`);
    return true;
  }

  const panel = await _chatPanel(ef, msg, nombreUsuario);
  const ev = chatEvidencia(ef, panel);

  let respuesta = null, oferta = null, fuente = "redactor";
  // Si la charla libre toca un tema que el sistema SÍ puede iluminar (tasas →
  // XLRE/XLU/KRE/ITB), el redactor tiene más datos que el 2B: contesta él.
  const conTema = ef.intencion === "libre" && (ev.datos.tema?.vistas || []).length > 0;
  // CHARLA LIBRE (5-nov-2026): lo que está FUERA del sistema («¿quién gana el
  // mundial?», «¿qué opinás de vos y de tu creador?») lo contesta el motor de
  // lenguaje con su prompt propio: opina, dice quién la creó y recuerda que es
  // una IA. No pide datos suficientes: no es una pregunta de datos. Un tema que
  // el sistema ilumina (tasas → XLRE…) también pasa por acá, con ese dato en el
  // prompt; si el motor no llega, el redactor contesta con los números.
  // Reversa sin recompilar: CLASS25B_CHAT_CHARLA=0.
  // «¿Sos consciente de vos misma?» (subtipo `conciencia`, 13-nov-2026) también
  // la contesta el motor; si no llega, el redactor tiene una respuesta propia.
  const esCharla = CHAT_CHARLA && (ef.intencion === "libre"
    || (ef.intencion === "identidad" && (ef.subtipo === "opina" || ef.subtipo === "conciencia"))
    // Sin plantillas (13-nov-2026, pedido de Martín): las definiciones y «¿es
    // mucho?» también las redacta el motor; el texto del sistema va como
    // referencia en el prompt y queda sólo de respaldo si ningún motor contesta.
    || ef.intencion === "concepto"
    || (ef.intencion === "riesgo" && ef.subtipo === "magnitud"));
  if (esCharla && _hayMotorLenguaje(true)) {
    _chatStats.asistidas++;
    const hechosCharla = conTema ? [ev.hechos[ev.hechos.length - 1]] : ev.hechos.slice(0, 1);
    const conRef = ef.intencion === "concepto" || ef.subtipo === "magnitud";
    // Acotada a ~300 caracteres (cortando en un punto): cada token del prompt se paga
    // ~25 ms en Ollama y la charla corta a 12 s.
    const _refTxt = conRef ? String(chatRedactar(ef, ev, { semilla: texto, nombre: nombreUsuario }).texto || "") : "";
    const referencia = _refTxt.length <= 300 ? _refTxt
      : (_refTxt.slice(0, 300).match(/^[\s\S]*[.!?](?=\s)/)?.[0] || _refTxt.slice(0, 300));
    const ctxCharla = { _modo: "charla", _hechos: conRef ? "" : hechosCharla.filter(Boolean).join(" "),
                        _referencia: referencia, riesgoGlobal: panel.riesgo ?? 0.5 };
    // Los números de la referencia cuentan como datos válidos para el validador.
    const evCharla = referencia ? { ...ev, hechos: [...(ev.hechos || []), referencia] } : ev;
    // El validador viaja AL motor: lo que no pasa no se cachea y deja probar el
    // otro motor (Gemini → Ollama) en vez de caer directo al respaldo.
    const validarCharla = t => validarRespuesta(t, evCharla, { tickers: TICKERS_TEXTO, abierta: true });
    try {
      const r = await _geminiMultiTurno(texto, ctxCharla, historial, true,
                                        { geminiPrimero: CHARLA_GEMINI_PRIMERO, validar: validarCharla });
      if (r?.texto) {
        const v = validarCharla(r.texto);
        if (v.ok) {
          respuesta = firmaCharla(v.texto, { semilla: `${texto}|${sesion.chatTurnos || 0}`, identidad: ef.intencion === "identidad" });
          fuente = `${r.motor}·charla`; _chatStats.validadas++;
        } else { _chatStats.descartadas++; log(`🛡️ charla del motor descartada (${v.motivo}): "${String(r.texto).slice(0, 90)}"`, "warn"); }
      }
    } catch (e) { log(`⚠️ motor de lenguaje (charla): ${e?.message}`, "warn"); }
    if (!respuesta) log(`⚠️ charla sin respuesta de ningún motor → respaldo del redactor `
      + `(gemini=${_geminiReady(true) ? "listo" : "pausado/sin clave"} local=${LLM_USA_LOCAL && !LLM.cortado() ? "listo" : "cortado/apagado"})`, "warn");
  } else if (CHAT_LLM_INTENCIONES.has(ef.intencion) && !conTema && ev.suficiente && _hayMotorLenguaje(true)) {
    _chatStats.asistidas++;
    const ctxLLM = {
      portfolio: null, portfolios: [], decisiones: [], señalesFeed: [], alertas: [], senalesHist: [],
      crisis: [], causalidad: [], sentimiento: [], performance: [], backtesting: [], documentos: [],
      intencion: {}, riesgoGlobal: panel.riesgo ?? 0.5, _hechos: ev.hechos.join(" "),
      perfilUsuario: { perfil: sesion.perfil || null, monto: sesion.monto || null, nombre: nombreUsuario || null },
    };
    try {
      const r = await _geminiMultiTurno(texto, ctxLLM, historial, true);
      if (r?.texto) {
        const v = validarRespuesta(r.texto, ev, { tickers: TICKERS_TEXTO });
        if (v.ok) { respuesta = v.texto; fuente = r.motor; _chatStats.validadas++; }
        else { _chatStats.descartadas++; log(`🛡️ respuesta del motor descartada (${v.motivo}): "${String(r.texto).slice(0, 90)}"`, "warn"); }
      }
    } catch (e) { log(`⚠️ motor de lenguaje (router): ${e?.message}`, "warn"); }
  }
  if (!respuesta) {
    const red = chatRedactar(ef, ev, {
      semilla: `${texto}|${sesion.chatTurnos || 0}|${Math.floor(Date.now() / 60_000)}`,
      nombre: nombreUsuario, perfil: sesion.perfil, monto: sesion.monto,
      temaTicker: sesion.chatPrevio?.tickers?.[0] || null, detalle: ef.detalle || 1,
    });
    if (red.error) log(`⚠️ redactor (${ef.intencion}): ${red.error}`, "warn");
    respuesta = red.texto; oferta = red.oferta;
    // Las respuestas con datos también las redacta el motor (13-nov-2026), con
    // la del sistema como única fuente. Si dejaba una propuesta («¿querés que…?»)
    // la reescritura tiene que conservar la pregunta, porque el «sí» la ejecuta.
    const rw = REESCRIBIR_INTENCIONES.has(ef.intencion)
      ? await _reescribirConMotor(texto, red.texto, ev, historial, {
          debe: oferta ? /\?/ : null,
          // El acierto (16-nov-2026): la reescritura no puede convertir «no puedo
          // decir que tenga una ventaja demostrada» en «ya es significativa».
          noDebe: ef.intencion === "acierto" && /no puedo decir|no se distingue|no lo puedo confirmar/.test(red.texto)
            ? /(ya es|es|resulta) (estad[ií]sticamente )?significativ|tengo (una )?ventaja (demostrada|real|clara)|le gano al (mercado|azar)|ventanas independientes/i
            : null })
      : null;
    if (rw) { respuesta = rw.texto; fuente = `${rw.motor}·reescrito`; }
    else _chatStats.directas++;
  }
  if (!respuesta) return false;

  sesion.chatTurnos = (sesion.chatTurnos || 0) + 1;
  sesion.chatOferta = oferta;
  // Si la escribió el motor (charla libre), un «sí» que venga después contesta
  // a ESE mensaje: el router lo manda de vuelta al motor con el historial.
  sesion.chatUltima = /charla/.test(fuente) ? "charla" : ef.intencion;
  if (_CHAT_TEMAS.has(ef.intencion)) sesion.chatPrevio = { intencion: ef.intencion, tickers: ef.tickers || [], grupo: ef.grupo || null };
  await _publicarRespuesta(respuesta, msg);
  log(`👤 Respuesta [${fuente}·${ef.intencion}${(ef.tickers || []).length ? " " + ef.tickers.join(",") : ""}`
    + `${ef.grupo ? " · " + ef.grupo.etiqueta : ""}] publicada (${respuesta.length} chars)`);
  return true;
}

// Procesador de input humano (class25_ingest) ──────────────
async function procesarInputHumano(msg) {
  try {
    const texto = (msg.texto || msg.text || msg.message || "").trim();
    if (!texto) return;

    // Filtro estricto: SOLO procesar consultas con type="human_query"
    const type = (msg.type || msg.tipo || "").toLowerCase();
    if (type !== "human_query") return;

    // Deduplicar ráfagas: mismo texto de la misma sesión en < 8 s, sin respuesta todavía
    if (_isDupHumanQuery(texto, msg)) return;

    // ── Filtro anti-loop: rechazar textos que son señales internas de class25A ──
    // class30 puede reenviar textos de decisión a class25_ingest; ignorarlos aquí.
    const esSeñalInterna = (
      /^(GENERAL|class\d+)\s+(subió|bajó|se mantuvo|sube|baja)/i.test(texto) ||
      /puntos porcentuales estimados/i.test(texto) ||
      /Red dominante:\s*class\d+|ensemble=|umbral=\d/i.test(texto) ||
      /\d de \d redes indican tendencia/i.test(texto)
    );
    if (esSeñalInterna) {
      log(`🚫 Input interno ignorado (señal class25A): "${texto.slice(0, 60)}"`, "warn");
      return;
    }

    log(`👤 MLLs input: "${texto.slice(0, 80)}"`);

    // ── Estado de sesión: monto y perfil para portfolio personalizado ──
    const sesionId = msg.session_id || msg.user_id || "default";
    const sesion   = _getSesion(sesionId);

    // Override de señal (para operadores)
    if (msg.type === "override" && msg.senal) {
      const thought = {
        id:       uuidv4(),
        source:   "class25B_human",
        senal:    msg.senal,
        ticker:   msg.ticker || "GENERAL",
        confianza: 0.95,
        texto:    `OVERRIDE HUMANO: ${texto}`,
        decision: `OVERRIDE HUMANO: ${texto}`,
        ts:       new Date().toISOString(),
        final:    true
      };
      await redisPub.publish(CH_OUT, JSON.stringify(thought));
      log(`👤 Override publicado: ${msg.senal} ${msg.ticker}`);
      return;
    }

    // Historial de conversación enviado desde el frontend (MLLs contexto)
    const historial = Array.isArray(msg.historial) ? msg.historial : [];

    // ── Recuperar nombre del usuario: del mensaje, del perfil class14 o de la sesión ──
    const nombreMsg   = msg.nombre && msg.nombre !== "usuario" ? msg.nombre : null;
    const nombrePerfil = perfilUsuarioActual?.nombre || perfilUsuarioActual?.name || null;
    // Detectar si el usuario está dando su nombre en el texto
    const nombreDetectado = _detectarNombre(texto);
    if (nombreDetectado && !sesion.nombre) {
      sesion.nombre = nombreDetectado;
      // Guardar en class14 si tenemos user_id
      if (msg.user_id) {
        dbQuery(`UPDATE users SET name=? WHERE user_id=?`, [nombreDetectado, msg.user_id]).catch(() => {});
      }
    }
    const nombreUsuario = sesion.nombre || nombreMsg || nombrePerfil || null;

    // ── Router de intenciones + evidencia (2-nov-2026) ─────────
    // Contesta con los datos del sistema y redacción propia; el motor de
    // lenguaje sólo entra para la charla libre, y lo que escribe se valida
    // contra los hechos antes de publicarlo. Si algo falla, sigue el camino de
    // antes. Reversa sin recompilar: CLASS25B_CHAT_ROUTER=0.
    if (CHAT_ROUTER) {
      try {
        if (await _chatConRouter(texto, msg, sesion, historial, nombreUsuario)) return;
      } catch (e) {
        log(`⚠️ router del chat: ${e?.message} — sigue el camino anterior`, "warn");
      }
    }

    // ── Respuestas conversacionales naturales ──────────────────
    const textoLow = texto.toLowerCase().trim();

    // Agradecimientos — refuerzo de aprendizaje + respuesta contextual
    if (/^(gracias|muchas gracias|genial|perfecto|excelente|ok gracias|dale gracias|buenísimo|muy bien|de nada|copado|bárbaro|chevere|chévere|graciass?|thx|thanks?)[\s!.]*$/i.test(texto)) {
      // Reforzar los patrones de la última respuesta (feedback positivo del usuario)
      _reforzarUltimaRespuesta(sesionId);

      const ultimoMiia = historial.slice().reverse().find(h => h.rol === "miia");
      const contexto = ultimoMiia?.txt?.slice(0, 80) || "";
      const nombre = nombreUsuario ? `, ${nombreUsuario}` : "";
      let resp;
      if (sesion.perfil && sesion.monto) {
        resp = `¡Con gusto${nombre}! Recordá que armé ese portfolio para un perfil ${sesion.perfil} con $${sesion.monto}. Si el mercado cambia o querés ajustar algo, avisame. Estoy monitoreando en tiempo real.`;
      } else if (contexto.length > 20) {
        resp = `¡De nada${nombre}! Si tenés más preguntas sobre lo que te comenté o querés profundizar en algún punto, estoy aquí. El mercado sigue en movimiento.`;
      } else {
        resp = `¡Con gusto${nombre}! Para cualquier consulta sobre señales, portfolios o el mercado, avisame. Sigo monitoreando todo en tiempo real.`;
      }
      await _publicarRespuesta(resp, msg);
      return;
    }

    // Confirmaciones cortas ("ok", "entendido", "sí", "no", "si", "dale")
    if (/^(ok|okay|dale|entendido|sí|si|no|claro|bien|listo|perfecto|de acuerdo|va|vamos|veamos|cuéntame|contame|seguí|sigue|más|mas)[\s!.?]*$/i.test(texto)) {
      // Si está en flujo de portfolio, continuar con el paso siguiente
      if (sesion.paso === "esperando_riesgo" || sesion.paso === "esperando_capital") {
        // Dejar que el flujo normal lo maneje (no interceptar)
      } else {
        // Continuación de conversación general
        const riesgo = Math.round((historialRiesgo[historialRiesgo.length - 1] ?? 0.5) * 100);
        const riesgoLbl = riesgo > 65 ? "MODERADO-ALTO" : riesgo > 40 ? "MODERADO" : "BAJO";
        const nombre = nombreUsuario ? `, ${nombreUsuario}` : "";
        await _publicarRespuesta(
          `Claro${nombre}. El mercado está con riesgo ${riesgo}% (${riesgoLbl}). ¿Qué aspecto te interesa analizar? Puedo mostrarte señales actuales, el portfolio recomendado, o explicarte alguna decisión específica.`,
          msg
        );
        return;
      }
    }

    // Saludo personalizado con nombre si se conoce
    if (/^(hola|buenas|hey|hi|buen(os|as)|saludos|qué tal|que tal|como estas|cómo estás|sos miia|quién sos|quien sos)[\s!?.]*$/i.test(texto)) {
      const saludo = nombreUsuario ? `¡Hola, ${nombreUsuario}!` : "¡Hola!";
      // Si tiene perfil guardado, hacer referencia a la conversación previa
      const contextoExistente = sesion.perfil
        ? ` Vi que la última vez definiste perfil ${sesion.perfil}${sesion.monto ? ` con $${sesion.monto}` : ""}. ¿Seguimos desde ahí?`
        : " Estoy monitoreando el mercado en tiempo real.";
      const saludos = [
        `${saludo} Soy MIIA, tu asistente de análisis financiero con IA.${contextoExistente} ¿En qué te puedo ayudar hoy?`,
        `${saludo} ¡Qué bueno verte!${contextoExistente} ¿Querés ver señales, el portfolio o analizamos algo específico?`,
        `${saludo} Soy MIIA.${contextoExistente} Podés preguntarme por señales, sectores o pedirme un portfolio personalizado.`,
      ];
      await _publicarRespuesta(saludos[Math.floor(Math.random() * saludos.length)], msg);
      return;
    }

    // ── Flujo de riesgo: SOLO cuando el usuario pide portfolio ──
    // No bloquear conversación general — solo interceptar cuando piden portfolio.
    const pidioPortfolio = /portafolio|portfolio|porfolio|cartera|recomiend.*inver|armar.*cartera|quiero invertir|dame.*activos|qué (compro|comprar)|cómo invierto/i.test(texto);

    // Paso 1: responder pregunta de riesgo
    if (sesion.paso === "esperando_riesgo") {
      const perfil = _respuestaAPerfil(texto) ||
        (texto === "1" ? "conservador" : texto === "2" ? "moderado" : texto === "3" ? "agresivo" : null);
      if (perfil) {
        sesion.perfil = perfil;
        sesion.paso   = "esperando_capital";
        await _publicarRespuesta(
          `Perfil ${perfil} registrado. Una pregunta más: ¿con cuánto capital querés trabajar? (ej: "$5000", "1000 USD", "100.000 pesos"). Si no querés especificarlo, escribí "no sé" y armo el portfolio igual.`,
          msg
        );
        return;
      }
      // No entendió → volver a preguntar
      await _publicarRespuesta(
        "Respondé 1 para conservador, 2 para moderado o 3 para agresivo. O escribí directamente tu perfil.",
        msg
      );
      return;
    }

    // Paso 2: recibir capital → generar portfolio personalizado YA
    if (sesion.paso === "esperando_capital") {
      // Aceptar cualquier número o texto — no exigir "USD"
      const capital = _parseMonto(texto)
        || (/\d/.test(texto) ? texto.trim() : null)        // "5000", "1.000", etc.
        || (/no\s*sé|no\s*se|salte|skip|después|cualquier/i.test(texto) ? null : texto.trim());
      sesion.monto = capital || "no especificado";
      sesion.paso  = "completo";
      log(`👤 Perfil listo: riesgo=${sesion.perfil} capital=${sesion.monto}`);

      // Generar el análisis de portfolio directamente, sin esperar otro mensaje
      const ctx2 = await _construirContextoCompleto("portafolio inversión").catch(() => ({
        portfolio: null, portfolios: [], decisiones: [], señalesFeed: [],
        riesgoGlobal: 0.5, alertas: [], senalesHist: [], cognitiva: 0,
        crisis: [], causalidad: [], sentimiento: [], performance: [], backtesting: [], documentos: [],
        intencion: { portfolio: true },
      }));
      ctx2.perfilUsuario = { monto: sesion.monto, perfil: sesion.perfil };

      let resp2 = null;
      // Con el router, la cartera la redacta chat_redactor con los activos REALES
      // de la base: el prompt local no lleva el portfolio, así que el 2B la
      // inventaba. Sin el router (CLASS25B_CHAT_ROUTER=0), el camino de antes.
      if (CHAT_ROUTER) {
        const _pb = ctx2.portfolios?.[0] || ctx2.portfolio || null;
        resp2 = redactarPortfolio({ ..._pb, activos: _adaptarActivosPerfil(_pb?.activos, sesion.perfil) },
          { perfil: sesion.perfil, monto: sesion.monto, riesgo: ctx2.riesgoGlobal, semilla: `${sesionId}${Date.now()}` });
      } else if (_hayMotorLenguaje()) {
        try {
          const _r = await _geminiMultiTurno(`Armame un portfolio personalizado para un inversor ${sesion.perfil} con capital de ${sesion.monto}`, ctx2, historial);
          if (_r && _r.texto) resp2 = _r.texto;
        } catch (_) {}
      }
      if (!resp2) resp2 = await _fallbackConContexto(`portafolio ${sesion.perfil} ${sesion.monto}`, ctx2).catch(() => null);
      if (!resp2) resp2 = `Armé tu análisis de portfolio para perfil ${sesion.perfil} con capital ${sesion.monto}. El riesgo actual del mercado está en ${Math.round((ctx2.riesgoGlobal ?? 0.5) * 100)}%. Te recomiendo revisar el panel Portfolio para ver la composición actualizada.`;

      // Adjuntar el portfolio adaptado al perfil como dato estructurado —
      // el frontend lo grafica aparte del portfolio global en el panel Portfolio.
      const portBase = ctx2.portfolios?.[0] || ctx2.portfolio || null;
      const activosRecomendados = _adaptarActivosPerfil(portBase?.activos, sesion.perfil);
      const portfolioRecomendado = activosRecomendados.length ? {
        perfil:    sesion.perfil,
        monto:     sesion.monto,
        riesgo_pct:    portBase?.riesgo_pct ?? null,
        confianza_pct: portBase?.confianza_pct ?? null,
        ts:        new Date().toISOString(),
        activos:   activosRecomendados.slice(0, 6).map(a => ({
          symbol: a.symbol, sector: a.sector, peso_pct: a.peso_pct,
          riesgo_pct: a.riesgo_pct, cambio_pct: a.cambio_pct ?? a.change_pct ?? 0,
        })),
      } : null;

      if (portfolioRecomendado && !_guardarNuevoPortfolio(msg, sesion, portfolioRecomendado)) _recordarPortfolio(msg, portfolioRecomendado);
      await _publicarRespuesta(resp2, msg, portfolioRecomendado ? { portfolio_recomendado: portfolioRecomendado } : null);
      return;
    }

    // Si pide portfolio y aún no tiene perfil → preguntar solo por riesgo (1 pregunta, no 3)
    if (pidioPortfolio && !sesion.perfil) {
      sesion.paso = "esperando_riesgo";
      await _publicarRespuesta(
        "Para recomendarte el portfolio más adecuado necesito saber tu tolerancia al riesgo:\n\n" +
        "1️⃣ Conservador — priorizo no perder capital\n" +
        "2️⃣ Moderado — acepto algo de riesgo para crecer\n" +
        "3️⃣ Agresivo — busco máximo rendimiento aunque implique riesgo\n\n" +
        "¿Cuál es tu perfil?",
        msg
      );
      return;
    }

    // Construir contexto del sistema con detección de intención + perfil de sesión
    const ctx = await _construirContextoCompleto(texto).catch(() => ({
      portfolio: null, portfolios: [], decisiones: [], señalesFeed: [],
      riesgoGlobal: 0.5, alertas: [], senalesHist: [], cognitiva: 0,
      crisis: [], causalidad: [], sentimiento: [], performance: [], backtesting: [], documentos: [],
      intencion: {},
    }));

    // Inyectar perfil del usuario en contexto para personalizar respuestas
    ctx.perfilUsuario = {
      monto:  sesion.monto  || null,
      perfil: sesion.perfil || null,
      nombre: nombreUsuario || null,
    };

    // Inyectar señales LSTM y sentimiento enviadas por el chatbot (en tiempo real, por ticker)
    const lstmCtx = msg.lstm_context      || {};  // {XLK:{señal,confianza,indicadores,...}}
    const sentCtx = msg.sentimiento_context || {}; // {XLK:{sentiment_label,score,...}}
    if (Object.keys(lstmCtx).length || Object.keys(sentCtx).length) {
      // Detectar tickers mencionados en la pregunta
      // ⚠️ Esta copia NO TENÍA XLRE —un instrumento que sí se cotiza y sí se
      // mide— pero sí tenía SPY y QQQ, que no se cotizan. El drift exacto que
      // motivó unificar las listas. Ahora sale del universo compartido.
      const TICKERS = [...TICKERS_TEXTO];
      const textUp  = texto.toUpperCase();
      const tickersMencionados = TICKERS.filter(t => textUp.includes(t));

      const lstmLines = [];
      const sentLines = [];
      for (const [ticker, sig] of Object.entries(lstmCtx)) {
        const conf = sig.confianza != null ? `${(sig.confianza*100).toFixed(0)}%` : "–";
        const ind  = sig.indicadores || {};
        const rsi  = ind.rsi  != null ? ` RSI:${ind.rsi.toFixed(1)}`  : "";
        const macd = ind.macd != null ? ` MACD:${ind.macd.toFixed(3)}` : "";
        lstmLines.push(`${ticker}: ${sig.señal||"?"} conf ${conf} precio $${sig.precio_actual||"–"}${rsi}${macd}`);
      }
      for (const [ticker, s] of Object.entries(sentCtx)) {
        if (s._heartbeat) continue;
        const lbl   = (s.sentiment_label || s.señal || "NEUTRAL").toUpperCase();
        const score = s.sentiment_score != null ? `${(Math.abs(parseFloat(s.sentiment_score))*100).toFixed(0)}%` : "";
        const n     = s.n_articulos != null ? ` (${s.n_articulos} art.)` : "";
        sentLines.push(`${ticker}: ${lbl} ${score}${n}`);
      }
      if (lstmLines.length) ctx._lstmExtra = `SEÑALES LSTM EN TIEMPO REAL:\n${lstmLines.join("\n")}`;
      if (sentLines.length) ctx._sentExtra = `SENTIMIENTO POR TICKER:\n${sentLines.join("\n")}`;
      if (tickersMencionados.length) ctx._tickerFocus = tickersMencionados;
    }

    // Riesgo REAL por activo (volatilidad realizada + drawdown, 60 d) que el
    // chatbot calcula del histórico de precios y manda por ticker. Es descriptivo
    // (lo que el activo hizo), no un pronóstico — así lo tiene que presentar MIIA.
    const riesgoCtx = msg.riesgo_context || {};
    if (Object.keys(riesgoCtx).length) {
      const riesgoLines = [];
      for (const [ticker, r] of Object.entries(riesgoCtx)) {
        if (!r || typeof r !== "object") continue;
        const vol = r.vol_pct       != null ? `volatilidad ${Number(r.vol_pct).toFixed(0)}% anual` : "";
        const dd  = r.drawdown_pct   != null ? `caída máx ${Number(r.drawdown_pct).toFixed(0)}%`    : "";
        const sc  = r.riesgo_vol_pct != null ? ` → riesgo ${Number(r.riesgo_vol_pct).toFixed(0)}/100` : "";
        const partes = [vol, dd].filter(Boolean).join(", ");
        if (partes) riesgoLines.push(`${ticker}: ${partes}${sc}`);
      }
      if (riesgoLines.length)
        ctx._riesgoExtra = `RIESGO POR ACTIVO (medido del histórico, 60 d):\n${riesgoLines.join("\n")}`;
    }

    // Contexto de activo puntual (análisis on-demand disparado por el chatbot
    // cuando el usuario pregunta por un activo específico, ej: "acciones de YPF")
    const activoCtx = msg.activo_context || null;
    if (activoCtx?.ticker) {
      const px  = activoCtx.precio != null ? `$${activoCtx.precio}` : "cotización solicitada (llega en ~1 min)";
      const chg = activoCtx.change_pct != null
        ? ` (${activoCtx.change_pct >= 0 ? "+" : ""}${Number(activoCtx.change_pct).toFixed(2)}%)` : "";
      ctx._activoExtra =
        `ACTIVO CONSULTADO POR EL USUARIO: ${activoCtx.ticker}` +
        `${activoCtx.nombre && activoCtx.nombre !== activoCtx.ticker ? ` (${activoCtx.nombre})` : ""}` +
        ` — precio actual: ${px}${chg}.\n` +
        `MIIA ya disparó para este activo: seguimiento de cotización (class7), búsqueda de noticias (class1), ` +
        `análisis de sentimiento (class45) y un portfolio diversificado anclado en ${activoCtx.ticker} (class15). ` +
        `Usá el precio real en tu respuesta y mencioná que el sentimiento de noticias y el portfolio del activo ` +
        `ya aparecen en el dashboard (paneles Sentimiento y Portfolio → Recomendado en el Chat).`;
      ctx._tickerFocus = [...new Set([...(ctx._tickerFocus || []), activoCtx.ticker])];
    }

    // Pregunta de RIESGO sobre un ticker puntual: contestar con el dato REAL
    // (vol + drawdown), no dejar que el 2B lo confunda con el riesgo GLOBAL —
    // pasó: dijo "XLK es alto" por el 94% global cuando el de XLK era 32/100.
    // riesgoCtx ya viene filtrado a los tickers mencionados por el usuario.
    const _preguntaRiesgo = /\b(riesgo|volatil|qu[eé]\s+tan\s+(seguro|riesgoso|volátil)|peligros)/i.test(texto);
    const _tksRiesgo = Object.keys(riesgoCtx);
    if (_preguntaRiesgo && _tksRiesgo.length) {
      const tk = _tksRiesgo[0];
      const r  = riesgoCtx[tk];
      if (r && r.riesgo_vol_pct != null && r.vol_pct != null) {
        const sc    = Number(r.riesgo_vol_pct);
        const nivel = sc > 66 ? "ALTO" : sc > 33 ? "MODERADO" : "BAJO";
        const resp  = `El riesgo de ${tk} es ${nivel}: volatilidad ${Number(r.vol_pct).toFixed(0)}% anual y caída máxima ${Number(r.drawdown_pct).toFixed(0)}% en los últimos 60 días (índice ${sc}/100). Es información del análisis de MIIA, no asesoramiento: la decisión es tuya.`;
        await _publicarRespuesta(resp, msg);
        _trackGeminiRespuesta(msg.session_id || msg.sesion || "", resp, 0.7);
        log(`👤 Respuesta [riesgo:${tk}] publicada (${resp.length} chars)`);
        return;
      }
    }

    // FASE 1: Gemini en modo multi-turno MLLs
    // bypassGrace=true: preguntas del usuario no esperan los 90s de gracia del startup
    let respuesta = null;
    let fuenteRespuesta = "fallback";
    // ⚠️ La compuerta es el ROUTER, no `_geminiReady`: antes era `_geminiReady(true)`
    // y con MIIA_LLM=local (sin clave de Gemini) el chat se saltaba TODO el LLM y
    // caía a las plantillas de _fallbackConContexto — por eso las respuestas salían
    // genéricas aunque Ollama estuviera arriba.
    if (_hayMotorLenguaje(true)) {
      try {
        const _r = await _geminiMultiTurno(texto, ctx, historial, true);
        if (_r && _r.texto) {
          respuesta = _r.texto;
          fuenteRespuesta = _r.motor;
          // Aprender/rastrear SÓLO del estilo de Gemini. El motor local NO debe
          // contaminar learning_cycles (CLAUDE.md: mezclar un 2B no se separa
          // hacia atrás). Para que el local aprenda está LLM_APRENDER_LOCAL,
          // dentro de _geminiMultiTurno.
          if (_r.motor === "gemini") {
            aprenderDeRespuestaGemini(respuesta, { confianza: 0.7 });
            _trackGeminiRespuesta(sesionId, respuesta, 0.7);
          }
        }
      } catch (e) {
        log(`⚠️ _geminiMultiTurno error: ${e.message}`, "warn");
      }
    }

    // FASE 2: Fallback con contexto real si Gemini no respondió
    if (!respuesta) {
      try {
        respuesta = await _fallbackConContexto(texto, ctx);
      } catch (e) {
        log(`⚠️ _fallbackConContexto error: ${e.message}`, "warn");
        respuesta = "Estoy procesando el mercado. Intentá de nuevo en unos segundos.";
      }
    }

    await _publicarRespuesta(respuesta, msg);
    log(`👤 Respuesta [${fuenteRespuesta}] publicada (${respuesta.length} chars)`);

  } catch (e) {
    log(`❌ procesarInputHumano: ${e?.message}`, "error");
  }
}

// ── Procesador de feedback (aprendizaje dual) ────────────────
async function procesarFeedback(msg) {
  try {
    const { decision_id, acerto, senal, clase } = msg;
    if (!decision_id && !msg.hash_decision) return;

    const id_buscar = decision_id || msg.hash_decision;
    const dec = memoriaCognitiva.find(d => d.id === id_buscar);

    if (!dec) {
      log(`⚠️ Feedback para decisión desconocida: ${id_buscar}`, "warn");
      return;
    }

    await aprenderDeOutcome(
      dec.id,
      acerto ?? (msg.outcome === "correct"),
      dec.senal,
      dec.texto,
      msg.hash_condicion
    );

  } catch (e) {
    log(`❌ procesarFeedback: ${e?.message}`, "error");
  }
}

// ── Suscripción Redis ────────────────────────────────────────
const CH_IN_PERFIL   = "class14_output";    // perfil de usuario de class14
const CH_IN_MERCADO  = "class7_output";     // datos de mercado por sector

await redisSub.subscribe(
  CH_IN_A,
  CH_IN_HUMAN,
  CH_IN_FB,
  CH_IN_PERFIL,
  CH_IN_MERCADO
);

redisSub.on("message", async (ch, raw) => {
  try {
    if (!raw || raw.length > 1_000_000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if ((msg.source || "") === "class25B") return; // anti-loop

    switch (ch) {
      case CH_IN_A:
        await procesarSeñalCuantitativa(msg);
        break;
      case CH_IN_HUMAN:
        await procesarInputHumano(msg);
        break;
      case CH_IN_FB:
        await procesarFeedback(msg);
        break;
      case CH_IN_PERFIL:
        if (msg?.user_id && msg?.perfil) {
          perfilUsuarioActual = msg.perfil;
          log(`👤 Perfil recibido: ${msg.user_id} (nivel=${msg.perfil?.nivel_experiencia})`);
        }
        break;

      case CH_IN_MERCADO:
        // Alimentar historialSectores con datos reales de class7
        // Esto permite que detectarPatrones() evalúe tendencias por sector
        actualizarHistorialSectores(msg);
        // Y el panel del chat: cambio del día por instrumento + amplitud.
        _chatAnotarCotizaciones(msg);
        break;
    }
  } catch (e) {
    log(`❌ message handler: ${e?.message}`, "error");
  }
});

// ── Heartbeat ────────────────────────────────────────────────
setInterval(async () => {
  const totalPatrones = Object.keys(patronesLinguisticos).length;
  // "Útil" = verificado por el mercado lo suficiente Y con accuracy real >60%.
  // Con el criterio v3 (total>=3) este contador daba 0 permanente, porque
  // aciertos/total venía deflactado por la cobertura del lazo.
  const patronesUtiles = Object.values(patronesLinguisticos)
    .filter(p => (p.verificados || 0) >= MIN_VERIFICADOS
              && p.aciertos / p.verificados > 0.6).length;
  const mem = process.memoryUsage().rss / 1024 / 1024;

  const patronesDB = Object.values(patronesLinguisticos)
    .filter(p => (p.db_source || 0) > 0).length;
  const bigramsCount = Object.keys(patronesLinguisticos)
    .filter(k => k.includes("_")).length;

  log(`❤️  cognitiva=${memoriaCognitiva.length} causal=${memoriaCausal.length} patrones=${totalPatrones}(útiles=${patronesUtiles} bigrams=${bigramsCount} db=${patronesDB}) mem=${mem.toFixed(0)}MB` +
      (GEMINI_SOLO_USUARIO ? ` | gemini_solo_usuario=SI llamadas_evitadas=${_geminiAhorradas}` : "") +
      ` | motor=${MIIA_LLM} local_ok=${_llmLocalUsos} local_fallos=${_llmLocalFallos}` +
      (CHAT_ROUTER ? ` | chat_router=on directas=${_chatStats.directas} asistidas=${_chatStats.asistidas}`
        + ` validadas=${_chatStats.validadas} descartadas=${_chatStats.descartadas}`
        + ` panel=${_chatRanking.size}rk/${_chatCotiz.size}cot` : " | chat_router=off"));
  if (LLM_USA_LOCAL) log(`❤️  ${LLM.resumen()}`);

  await redisPub.publish(CH_UI, JSON.stringify({
    type:                "class25B_heartbeat",
    memoria_cognitiva:   memoriaCognitiva.length,
    memoria_causal:      memoriaCausal.length,
    patrones_totales:    totalPatrones,
    patrones_utiles:     patronesUtiles,
    patrones_bigrams:    bigramsCount,
    patrones_db_source:  patronesDB,
    gemini_activo:       _geminiReady(),
    motor_lenguaje:      MIIA_LLM,
    llm_local_modelo:    LLM.MODELO,
    llm_local_usos:      _llmLocalUsos,
    llm_local_fallos:    _llmLocalFallos,
    llm_local_cortado:   LLM.cortado(),
    ts:                  Date.now()
  })).catch(() => {});
}, 30_000);

// ── Guardado periódico (JSON) ────────────────────────────────
setInterval(() => guardarEstado(), 120_000);

// ── Refresh MLLs: re-aprender de decisiones recientes cada 30 min ─
// Garantiza aprendizaje continuo incluso sin interacción humana.
setInterval(() => _refrescarPatronesDesdeDB().catch(() => {}), 30 * 60_000);

// ── Verificar JWT (admin endpoints) ─────────────────────────
// SEGURIDAD (CWE-347): se verifica la FIRMA del token con JWT_SECRET (HS256), no
// se decodifica a ciegas. Antes solo se hacía base64-decode del payload, así que
// CUALQUIER usuario podía fabricar un token con un email de admin y hacerse pasar
// por admin. jwt.verify lanza si la firma es inválida o el token expiró.
// Sin fallback (30-ago-2026): el default público permitía firmar un token con
// email de admin y pasar este mismo jwt.verify. Ver la nota en class14.js.
const JWT_SECRET = (process.env.JWT_SECRET || "").trim();
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET no configurado (o menor a 32 caracteres). " +
    "Generar con: openssl rand -hex 32 — y exportarlo antes de arrancar."
  );
}
function _verifyAdminToken(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET); // { user_id, email, name, provider, iat, exp }
  } catch { return null; }
}

async function _isAdminEmail(email) {
  if (!email) return false;
  try {
    const rows = await dbQuery("SELECT email FROM miia_admins WHERE email=? LIMIT 1", [email]);
    return rows?.length > 0;
  } catch { return false; }
}

// ── Crear tablas admin + subscriptions si no existen ────────
await dbQuery(`
  CREATE TABLE IF NOT EXISTS miia_admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(200) NOT NULL UNIQUE,
    added_by VARCHAR(200),
    created_at DATETIME DEFAULT NOW()
  )
`).catch(e => log(`miia_admins table: ${e.message}`, "warn"));

// Insertar admin principal si no existe
await dbQuery(
  `INSERT IGNORE INTO miia_admins (email, added_by) VALUES (?, 'sistema')`,
  ["admin@example.com"]
).catch(() => {});

await dbQuery(`
  CREATE TABLE IF NOT EXISTS miia_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(200),
    nombre VARCHAR(200),
    status ENUM('active','banned') DEFAULT 'active',
    consultas INT DEFAULT 0,
    last_seen DATETIME,
    created_at DATETIME DEFAULT NOW()
  )
`).catch(e => log(`miia_users table: ${e.message}`, "warn"));

// ── Crear tabla miia_subscriptions si no existe ──────────────
// Tabla propia (no `subscriptions` legacy, que tiene otro esquema).
await dbQuery(`
  CREATE TABLE IF NOT EXISTS miia_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    email VARCHAR(200),
    plan ENUM('monthly','annual') NOT NULL DEFAULT 'monthly',
    status ENUM('pending','active','cancelled','expired') DEFAULT 'pending',
    mp_preference_id VARCHAR(200),
    mp_payment_id VARCHAR(200),
    expires_at DATETIME,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_uid_status (user_id, status),
    INDEX idx_email_status (email, status)
  )
`).catch(e => log(`miia_subscriptions table: ${e.message}`, "warn"));

// ── Arranque ─────────────────────────────────────────────────
await cargarEstado();

log("🚀 Motor Lingüístico MLLs class25B iniciado");
log(`Suscrito a: ${CH_IN_A}, ${CH_IN_HUMAN}, ${CH_IN_FB}`);
log(`Publica en: ${CH_OUT}`);
log(`Patrones cargados: ${Object.keys(patronesLinguisticos).length} (unigrams+bigrams)`);
log(`Memoria causal: ${memoriaCausal.length} entradas (DB sync)`);
log(`Refresh periódico: cada 30 min (cognitive_decisions → patrones)`);

// ═══════════════════════════════════════════════════════════════
// HTTP SERVER — puerto 5006 (solo endpoints de datos, SIN chat)
// ───────────────────────────────────────────────────────────────
// ARQUITECTURA DE CHAT (responsabilidades únicas):
//   class25B.procesarInputHumano  → ÚNICO procesador de chat vía Redis
//   miia_chatbot.py /api/ask      → relay HTTP → class25_ingest → espera respuesta
//   miia_chatbot.py redis_listener→ broadcast WS de señales BUY/SELL (no chat)
//
// Este servidor expone SOLO datos de apoyo (no duplica el chat de Python):
//   GET /api/portfolio, /api/historial, /api/predicciones, /api/accuracy
// ═══════════════════════════════════════════════════════════════

const CHAT_PORT = Number(process.env.CHAT_PORT || 5006);

// ── CORS helper ─────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Leer body JSON ──────────────────────────────────────────────
async function readJSON(req) {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  try { return JSON.parse(buf); } catch { return {}; }
}

// ── Responder JSON ──────────────────────────────────────────────
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// ── HTTP Request handler — solo datos, NO chat ─────────────────
// El chat lo maneja Python chatbot + procesarInputHumano (Redis)
const httpServer = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || "/", `http://localhost:${CHAT_PORT}`);
  const path_ = url.pathname;

  try {
    // /api/ask en este puerto (5006) redirige al flujo correcto vía Python (5005)
    // class25B NO procesa chat HTTP directamente: usa procesarInputHumano (Redis)
    if (req.method === "POST" && path_ === "/api/ask") {
      return sendJSON(res, 200, {
        ok: false,
        redirect: "http://localhost:5005/api/ask",
        info: "El chat se procesa via Python chatbot → Redis → class25B. Usar port 5005."
      });
    }

    // ── GET /api/portfolio ─────────────────────────────────────
    if (req.method === "GET" && path_ === "/api/portfolio") {
      const data = await obtenerUltimoPortfolio("general").catch(() => null);
      return sendJSON(res, 200, {
        ok:       true,
        portfolio: {
          strategy:      data?.strategy     || null,
          riesgo_pct:    data?.riesgo_pct   ?? null,
          confianza_pct: data?.confianza_pct ?? null,
          n_activos:     data?.n_activos    ?? 0,
        },
        activos:  data?.activos || [],
        historial_reciente: [],
      });
    }

    // ── GET /api/historial ─────────────────────────────────────
    if (req.method === "GET" && path_ === "/api/historial") {
      const n = Math.min(parseInt(url.searchParams.get("n") || "10"), 50);
      const rows = await sqlQuery(
        `SELECT senal, ticker, ROUND(confianza*100,1) AS conf,
                LEFT(razon,200) AS ctx, ts_decision AS ts
         FROM cognitive_decisions ORDER BY ts_decision DESC LIMIT ?`,
        [n]
      ).catch(() => []);
      return sendJSON(res, 200, { ok: true, decisiones: rows || [] });
    }

    // ── GET /api/predicciones ──────────────────────────────────
    if (req.method === "GET" && path_ === "/api/predicciones") {
      const ultimas = memoriaCognitiva.slice(-8).map(d => ({
        senal:     d.senal,
        ticker:    d.ticker,
        confianza: d.confianza,
        ts:        d.ts,
      }));
      return sendJSON(res, 200, { ok: true, predicciones: ultimas });
    }

    // ── GET /api/accuracy ──────────────────────────────────────
    if (req.method === "GET" && path_ === "/api/accuracy") {
      const stats = await sqlQuery(
        `SELECT COUNT(*) AS total,
                SUM(outcome_real='correcto') AS ok,
                SUM(outcome_real='pendiente') AS pend
         FROM cognitive_decisions LIMIT 1`,
        []
      ).catch(() => null);
      const row = stats?.[0];
      const total = Number(row?.total || 0);
      const ok_   = Number(row?.ok    || 0);
      const acc   = total > 0 ? +((ok_ / total) * 100).toFixed(1) : 0;
      return sendJSON(res, 200, {
        ok: true, accuracy: acc, total, verificadas: ok_,
        pendientes: Number(row?.pend || 0),
      });
    }

    // ── GET /api/health ────────────────────────────────────────
    if (req.method === "GET" && (path_ === "/api/health" || path_ === "/health")) {
      return sendJSON(res, 200, {
        ok: true, service: "class25B", port: CHAT_PORT,
        chat_via: "Python chatbot port 5005 → Redis → procesarInputHumano",
        gemini: !_geminiDisabled,
        patrones: Object.keys(patronesLinguisticos).length,
        memoria_cognitiva: memoriaCognitiva.length,
      });
    }

    // ── GET /api/admin/check ───────────────────────────────────
    if (req.method === "GET" && path_ === "/api/admin/check") {
      const payload = _verifyAdminToken(req);
      const email   = payload?.email || payload?.sub || "";
      const isAdmin = await _isAdminEmail(email);
      return sendJSON(res, 200, { ok: true, is_admin: isAdmin, email });
    }

    // ── GET /api/admin/resources ───────────────────────────────
    if (req.method === "GET" && path_ === "/api/admin/resources") {
      const payload = _verifyAdminToken(req);
      if (!await _isAdminEmail(payload?.email)) return sendJSON(res, 403, { ok: false, error: "Forbidden" });
      const os = await import("node:os");
      const cpus   = os.cpus();
      const totMem = os.totalmem();
      const freeMem= os.freemem();
      const upSec  = Math.floor(process.uptime());
      const h = Math.floor(upSec/3600), m = Math.floor((upSec%3600)/60), s = upSec%60;
      // CPU usage (snapshot de 100ms)
      const cpuBefore = cpus.map(c=>({idle:c.times.idle,total:Object.values(c.times).reduce((a,b)=>a+b,0)}));
      await new Promise(r=>setTimeout(r,100));
      const cpuAfter = (await import("node:os")).cpus();
      let cpuPct = 0;
      for (let i=0;i<cpuBefore.length;i++){
        const d={idle:cpuAfter[i].times.idle-cpuBefore[i].idle,total:Object.values(cpuAfter[i].times).reduce((a,b)=>a+b,0)-cpuBefore[i].total};
        cpuPct += d.total>0 ? (1-d.idle/d.total)*100 : 0;
      }
      cpuPct = cpuPct / cpuBefore.length;
      return sendJSON(res, 200, {
        ok: true,
        cpu_pct:  +cpuPct.toFixed(1),
        mem_pct:  +(((totMem-freeMem)/totMem)*100).toFixed(1),
        mem_used_mb: +((totMem-freeMem)/1024/1024).toFixed(0),
        mem_total_mb: +(totMem/1024/1024).toFixed(0),
        uptime:   `${h}h ${m}m ${s}s`,
        ws_conns: 0,
        node_version: process.version,
        pid: process.pid,
      });
    }

    // ── GET /api/admin/users ───────────────────────────────────
    if (req.method === "GET" && path_ === "/api/admin/users") {
      const payload = _verifyAdminToken(req);
      if (!await _isAdminEmail(payload?.email)) return sendJSON(res, 403, { ok: false, error: "Forbidden" });
      const users = await dbQuery(`
        SELECT u.user_id, u.email, u.nombre, u.status, u.consultas, u.last_seen,
               s.plan, s.status AS sub_status
        FROM miia_users u
        LEFT JOIN miia_subscriptions s ON s.user_id=u.user_id AND s.status='active'
        ORDER BY u.last_seen DESC LIMIT 100
      `).catch(() => []);
      return sendJSON(res, 200, { ok: true, users: users || [] });
    }

    // ── POST /api/admin/ban ────────────────────────────────────
    if (req.method === "POST" && path_ === "/api/admin/ban") {
      const payload = _verifyAdminToken(req);
      if (!await _isAdminEmail(payload?.email)) return sendJSON(res, 403, { ok: false, error: "Forbidden" });
      const body = await readJSON(req);
      const { user_id, action } = body;
      const newStatus = action === "ban" ? "banned" : "active";
      await dbQuery("UPDATE miia_users SET status=? WHERE user_id=?", [newStatus, user_id]);
      log(`⚙ Admin: ${action} user ${user_id} by ${payload.email}`);
      return sendJSON(res, 200, { ok: true, user_id, status: newStatus });
    }

    // ── GET /api/admin/admins ──────────────────────────────────
    if (req.method === "GET" && path_ === "/api/admin/admins") {
      const payload = _verifyAdminToken(req);
      if (!await _isAdminEmail(payload?.email)) return sendJSON(res, 403, { ok: false, error: "Forbidden" });
      const admins = await dbQuery("SELECT email, added_by, created_at FROM miia_admins ORDER BY created_at").catch(() => []);
      return sendJSON(res, 200, { ok: true, admins: admins || [] });
    }

    // ── POST /api/admin/add-admin ──────────────────────────────
    if (req.method === "POST" && path_ === "/api/admin/add-admin") {
      const payload = _verifyAdminToken(req);
      if (!await _isAdminEmail(payload?.email)) return sendJSON(res, 403, { ok: false, error: "Forbidden" });
      const body = await readJSON(req);
      const { email } = body;
      if (!email || !email.includes("@")) return sendJSON(res, 400, { ok: false, error: "Email inválido" });
      await dbQuery("INSERT IGNORE INTO miia_admins (email, added_by) VALUES (?,?)", [email, payload.email]);
      log(`⚙ Admin: ${payload.email} agregó admin → ${email}`);
      return sendJSON(res, 200, { ok: true, email });
    }

    // ── POST /api/admin/track-user ─────────────────────────────
    // Registra uso de usuario (llamado desde el frontend al enviar consulta)
    if (req.method === "POST" && path_ === "/api/admin/track-user") {
      const body = await readJSON(req);
      const { user_id, email, nombre } = body;
      if (user_id) {
        await dbQuery(`
          INSERT INTO miia_users (user_id, email, nombre, consultas, last_seen)
          VALUES (?,?,?,1,NOW())
          ON DUPLICATE KEY UPDATE consultas=consultas+1, last_seen=NOW(),
            email=COALESCE(VALUES(email),email), nombre=COALESCE(VALUES(nombre),nombre)
        `, [user_id, email||null, nombre||null]).catch(() => {});
      }
      return sendJSON(res, 200, { ok: true });
    }

    // ── POST /api/subscribe/create ─────────────────────────────
    if (req.method === "POST" && path_ === "/api/subscribe/create") {
      const body = await readJSON(req);
      const { plan = "monthly", user_id = "anon", email = "" } = body;
      const precio = plan === "annual" ? 180 : 20;
      const titulo = plan === "annual" ? "MIIA Pro — Plan Anual" : "MIIA Pro — Plan Mensual";
      const MP_TOKEN = process.env.MP_ACCESS_TOKEN || "";
      if (!MP_TOKEN) return sendJSON(res, 503, { ok: false, error: "MP no configurado" });

      const preference = JSON.stringify({
        items: [{ title: titulo, quantity: 1, unit_price: precio, currency_id: "USD" }],
        payer: email ? { email } : undefined,
        back_urls: {
          success: `http://localhost:5005/subscribe/success`,
          failure: `http://localhost:5005/subscribe/failure`,
          pending: `http://localhost:5005/subscribe/pending`,
        },
        auto_return: "approved",
        external_reference: `${user_id}_${plan}_${Date.now()}`,
        statement_descriptor: "MIIA PRO",
      });

      const mpRes = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.mercadopago.com",
          path: "/checkout/preferences",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${MP_TOKEN}`,
          },
        }, (r2) => {
          let data = "";
          r2.on("data", c => data += c);
          r2.on("end", () => resolve({ status: r2.statusCode, body: JSON.parse(data) }));
        });
        req2.on("error", reject);
        req2.write(preference);
        req2.end();
      });

      if (mpRes.status !== 201) {
        log(`MP create preference error ${mpRes.status}: ${JSON.stringify(mpRes.body)}`, "warn");
        return sendJSON(res, 502, { ok: false, error: "Error al crear preferencia MP", detail: mpRes.body });
      }
      const pref = mpRes.body;
      // Guardar preferencia en DB
      await dbQuery(
        `INSERT IGNORE INTO miia_subscriptions (user_id, plan, mp_preference_id, status, created_at)
         VALUES (?, ?, ?, 'pending', NOW())
         ON DUPLICATE KEY UPDATE mp_preference_id=VALUES(mp_preference_id), status='pending'`,
        [user_id, plan, pref.id]
      ).catch(() => {});
      return sendJSON(res, 200, {
        ok: true,
        init_point: pref.init_point,
        sandbox_init_point: pref.sandbox_init_point,
        preference_id: pref.id,
      });
    }

    // ── GET /api/subscribe/status ──────────────────────────────
    if (req.method === "GET" && path_ === "/api/subscribe/status") {
      const uid = url.searchParams.get("user_id") || "anon";
      const rows = await dbQuery(
        `SELECT plan, status, expires_at FROM miia_subscriptions
         WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [uid]
      ).catch(() => []);
      const active = rows?.length > 0;
      return sendJSON(res, 200, {
        ok: true,
        subscribed: active,
        plan: active ? rows[0].plan : null,
        expires_at: active ? rows[0].expires_at : null,
      });
    }

    // ── POST /api/subscribe/webhook ────────────────────────────
    if (req.method === "POST" && path_ === "/api/subscribe/webhook") {
      const wb = await readJSON(req);
      if (wb.type === "payment" && wb.data?.id) {
        const MP_TOKEN = process.env.MP_ACCESS_TOKEN || "";
        const payRes = await new Promise((resolve, reject) => {
          const r3 = https.request({
            hostname: "api.mercadopago.com",
            path: `/v1/payments/${wb.data.id}`,
            method: "GET",
            headers: { "Authorization": `Bearer ${MP_TOKEN}` },
          }, (res3) => {
            let d = ""; res3.on("data", c => d += c);
            res3.on("end", () => resolve(JSON.parse(d)));
          });
          r3.on("error", reject); r3.end();
        }).catch(() => null);

        if (payRes?.status === "approved") {
          const ref = payRes.external_reference || "";
          const [uid, plan] = ref.split("_");
          const dias = plan === "annual" ? 365 : 31;
          await dbQuery(
            `UPDATE miia_subscriptions SET status='active', mp_payment_id=?,
             expires_at=DATE_ADD(NOW(), INTERVAL ? DAY)
             WHERE user_id=? AND plan=? AND status='pending'`,
            [String(wb.data.id), dias, uid, plan]
          ).catch(() => {});
          log(`✅ Suscripción activada: ${uid} plan=${plan}`);
        }
      }
      return sendJSON(res, 200, { ok: true });
    }

    sendJSON(res, 200, { ok: true, service: "MIIA class25B", port: CHAT_PORT });
  } catch (e) {
    log(`❌ HTTP ${path_}: ${e.message}`, "error");
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// ── Arrancar servidor de datos ──────────────────────────────────
// WS eliminado: Python chatbot (5005) maneja todos los WebSocket del usuario
httpServer.listen(CHAT_PORT, "0.0.0.0", () => {
  log(`🌐 HTTP class25B (datos) escuchando en http://localhost:${CHAT_PORT}`);
  log(`   GET /api/portfolio | GET /api/historial | GET /api/predicciones`);
  log(`   Chat: procesarInputHumano (Redis) es el ÚNICO procesador`);
});

httpServer.on("error", e => {
  if (e.code === "EADDRINUSE") log(`❌ Puerto ${CHAT_PORT} en uso — chat HTTP no disponible`, "warn");
  else log(`❌ httpServer: ${e.message}`, "error");
});

// ── Shutdown limpio ──────────────────────────────────────────
async function shutdown() {
  log("🛑 Shutdown class25B...");
  await guardarEstado();
  if (_portUsuarioTimer) {   // un portafolio recién armado que todavía no se escribió
    clearTimeout(_portUsuarioTimer); _portUsuarioTimer = null;
    try { await _escribirPortUsuario(); } catch (_) {}
  }
  try { httpServer.close(); } catch (_) {}
  try { await redisSub.quit();       } catch (_) {}
  try { await redisPub.quit();       } catch (_) {}
  try { await redisBroadcast.quit(); } catch (_) {}
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException",  e => log(`uncaughtException: ${e?.message}`, "error"));
process.on("unhandledRejection", e => log(`unhandledRejection: ${String(e)}`, "error"));

export default {};