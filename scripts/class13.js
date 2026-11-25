// ============================================================
// class13.js — Motor de Clustering Temporal de Vectores (MIIA v2.1)
// ============================================================
//
// ROL: Agrupa vectores de mercado en clusters usando K-means
//      online (sin librerías externas). Detecta regímenes de
//      mercado similares a los actuales en el historial reciente
//      y publica un "vector de régimen" a class18_ingest.
//
// POR QUÉ EXISTE (diferencia con class11):
//   class11 analiza IMPACTO MEDIÁTICO de noticias individuales
//   (relevancia noticia → score de narrativa).
//   class13 analiza REGÍMENES DE MERCADO en el tiempo
//   (cluster de vectores → etiqueta de régimen actual).
//   Son ángulos complementarios, no duplicados.
//
// ENTRADAS:
//   class40_output — pronóstico híbrido (vector de predicciones)
//   class41_output — riesgo (riskScore, probDown, volatility)
//   class7_output  — estado sectorial (change_pct × 10 sectores)
//
//   NOTA: NO usa class1_output (noticias). Las noticias son
//   señales de alto ruido para clustering. class11 las maneja.
//
// SALIDA: class18_ingest
//   type: "cluster_regime"
//   Campos principales:
//     cluster_id     — índice del cluster actual (0-3)
//     cluster_label  — etiqueta legible (ver CLUSTER_LABELS)
//     distancia      — distancia al centroide (menor = más firme)
//     confianza      — 1 - distancia normalizada
//     vector_regime  — vector 12-dim del régimen detectado
//     n_muestras     — cuántos ciclos conforman el historial
//
// DISEÑO DE K-MEANS ONLINE:
//   K = 4 clusters (regímenes: alcista, bajista, lateral, crisis)
//   Ventana de historial: últimos 60 vectores de entrada
//   Actualización de centroides: media móvil exponencial (α=0.1)
//   Convergencia: no requerida — actualización incremental
//   Sin dependencias externas: todo en JS puro
// ============================================================

import path   from "path";
import fs     from "fs-extra";
import crypto from "crypto";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ──────────────────────────────────────────────
const baseDir = path.resolve(__dirname, "../operador/aprendizaje");
const LOG_DIR = path.join(baseDir, "logs");
fs.ensureDirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, "class13.log");

// ── Logger ────────────────────────────────────────────────────
function log(msg, level = "INFO") {
  const line = `[${new Date().toISOString()}] [class13/${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ── Config ────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const INPUT_CHANNELS = [
  "class40_output",   // pronóstico → vector de predicciones
  "class41_output",   // riesgo → riskScore, probDown, volatility
  "class7_output",    // mercado → change_pct por sector
];
const OUTPUT_CHANNEL = "class18_ingest";

// ── Parámetros K-means ────────────────────────────────────────
const K           = 4;      // 4 regímenes de mercado
const DIM         = 12;     // dimensión del vector de entrada (ver buildVector)
const HISTORY_MAX = 60;     // últimos N vectores para clustering
const ALPHA       = 0.1;    // learning rate para actualización de centroides
const MIN_SAMPLES = 5;      // mínimo de muestras antes de publicar cluster

// Etiquetas de regímenes (asignadas según coordenadas del centroide)
// Se actualizan dinámicamente en labelClusters()
const CLUSTER_LABELS = ["alcista", "bajista", "lateral", "crisis"];

// ── Estado ────────────────────────────────────────────────────

// Señales de entrada (última por canal)
const señales = {
  pronostico: null,   // class40_output
  riesgo:     null,   // class41_output
  mercado:    null,   // class7_output
};

// Historial de vectores (ventana deslizante)
const historial = [];

// Centroides K-means (inicializados con valores neutrales)
const centroides = Array.from({ length: K }, (_, k) => {
  // Inicialización heurística: separar los clusters en el espacio
  // Para evitar arranque con todos los centroides en 0.5
  const base = Array(DIM).fill(0.5);
  if (k === 0) { base[0] = 0.8; base[1] = 0.2; }  // alcista
  if (k === 1) { base[0] = 0.2; base[1] = 0.8; }  // bajista
  if (k === 2) { base[0] = 0.5; base[1] = 0.5; }  // lateral
  if (k === 3) { base[0] = 0.1; base[1] = 0.9; base[2] = 0.9; } // crisis
  return base;
});

// Asignaciones actuales de cada vector histórico a un cluster
const asignaciones = [];

// Contador de ciclos procesados
let nCiclos = 0;

// ── Construcción del vector de entrada (12 dims) ──────────────
//
//  Dims  0- 4: señales de pronóstico class40
//    [0] tendencia (delta predicción normalizado)
//    [1] confianza del ensemble
//    [2] horizonte_corto (1d)
//    [3] horizonte_medio (5d)
//    [4] volatilidad implícita del pronóstico
//
//  Dims  5- 8: señales de riesgo class41
//    [5] riskScore global
//    [6] probDown (probabilidad de caída)
//    [7] volatilidad realizada
//    [8] nivel de riesgo (0=low, 0.5=med, 1=high)
//
//  Dims  9-11: señales de mercado class7
//    [9]  riesgoGlobal sectorial
//   [10]  market_breadth (fracción sectores positivos)
//   [11]  volatilidad sectorial (std de change_pct)
//
function buildVector() {
  const v = Array(DIM).fill(0.5);

  // Bloque pronóstico (class40)
  if (señales.pronostico) {
    const p = señales.pronostico;
    const preds = p?.Ensemble?.Predictions ?? p?.predictions ?? [];
    if (preds.length >= 2) {
      const start = Number(preds[0]?.Value ?? preds[0] ?? 0.5);
      const end   = Number(preds.at(-1)?.Value ?? preds.at(-1) ?? 0.5);
      const delta = (end - start) / (Math.abs(start) || 1);
      v[0] = clamp((delta + 1) / 2);           // tendencia [-1,1] → [0,1]
    }
    v[1] = clamp(Number(p?.confianza ?? p?.confidence ?? 0.5));
    if (preds.length >= 5) {
      v[2] = clamp(Number(preds[0]?.Value ?? 0.5) / 200);   // normalizado heurístico
      v[3] = clamp(Number(preds[4]?.Value ?? 0.5) / 200);
    }
    v[4] = clamp(Number(p?.volatilidad ?? p?.volatility ?? 0.5));
  }

  // Bloque riesgo (class41)
  if (señales.riesgo) {
    const r  = señales.riesgo?.RiskMetrics ?? señales.riesgo;
    v[5] = clamp(Number(r?.RiskScore     ?? r?.riskScore    ?? 0.5));
    v[6] = clamp(Number(r?.ProbDown      ?? r?.probDown     ?? 0.5));
    v[7] = clamp(Number(r?.Volatility    ?? r?.volatility   ?? 0.5));
    const nivel = (r?.RiskLevel ?? r?.riskLevel ?? "").toString().toUpperCase();
    v[8] = nivel === "HIGH" ? 1.0 : nivel === "LOW" ? 0.0 : 0.5;
  }

  // Bloque mercado (class7)
  if (señales.mercado) {
    const m = señales.mercado;
    v[9] = clamp(Number(m?.riesgoGlobal ?? 0.5));

    const sectores = m?.sectors ?? m?.sector_state ?? [];
    if (Array.isArray(sectores) && sectores.length > 0) {
      const cambios = sectores.map(s => Number(s.change ?? s.change_pct ?? 0));
      const positivos = cambios.filter(c => c > 0).length;
      v[10] = clamp(positivos / sectores.length);    // market_breadth

      // Std dev de cambios → volatilidad sectorial
      const mean = cambios.reduce((a, b) => a + b, 0) / cambios.length;
      const std  = Math.sqrt(
        cambios.reduce((a, b) => a + (b - mean) ** 2, 0) / cambios.length
      );
      v[11] = clamp(std / 5);   // normalizar: std=5% → 1.0
    }
  }

  return v;
}

function clamp(v, lo = 0, hi = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0.5;
}

// ── Distancia euclídea ────────────────────────────────────────
function distancia(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

// ── Asignar vector al centroide más cercano ───────────────────
function asignar(vec) {
  let mejorK = 0, mejorDist = Infinity;
  for (let k = 0; k < K; k++) {
    const d = distancia(vec, centroides[k]);
    if (d < mejorDist) { mejorDist = d; mejorK = k; }
  }
  return { cluster: mejorK, distancia: mejorDist };
}

// ── Actualizar centroide con media móvil exponencial ─────────
// α pequeño → centroide se mueve despacio (más estable)
function actualizarCentroide(k, vec) {
  for (let i = 0; i < DIM; i++) {
    centroides[k][i] = (1 - ALPHA) * centroides[k][i] + ALPHA * vec[i];
  }
}

// ── Etiquetar clusters por UMBRAL ABSOLUTO ────────────────────
//
// ANTES se ordenaban los 4 centroides por score y se etiquetaban POR PUESTO:
// el 1º "alcista", el 2º "lateral", el 3º "bajista", el 4º "crisis". O sea que
// SIEMPRE existía exactamente un cluster llamado "bajista" y uno "crisis", sin
// importar lo que hiciera el mercado: con los cuatro centroides francamente
// alcistas, el tercero se seguía llamando bajista. La etiqueta respondía "¿cuál
// de mis centroides quedó tercero?", no "¿está cayendo el mercado?".
// Encima labelClusters() corre en cada ciclo: si dos centroides se cruzaban de
// puesto, la etiqueta saltaba sin que el mercado se moviera.
//
// Ahora cada centroide se evalúa SOLO, contra umbrales fijos. Consecuencia
// deliberada: los cuatro pueden ser "lateral" a la vez. Eso es lo que hace que
// la etiqueta sea falsable — antes no podía decir otra cosa.
const BANDA_LATERAL = 0.06;   // |dirección − 0.5| menor que esto → lateral
const UMBRAL_CRISIS = 0.75;   // riesgo agregado por encima → crisis

function labelClusters() {
  const etiquetas = {};
  for (let k = 0; k < K; k++) {
    const c = centroides[k];
    // Riesgo agregado: riskScore, probDown y nivel de riesgo, los tres en [0,1].
    const riesgo = (c[5] + c[6] + c[8]) / 3;
    // Dirección: tendencia del pronóstico + market_breadth sectorial.
    // Las dos ya vienen en [0,1] con 0.5 = neutro.
    const direccion = (c[0] + c[10]) / 2;

    if (riesgo >= UMBRAL_CRISIS && direccion < 0.5)      etiquetas[k] = "crisis";
    else if (direccion > 0.5 + BANDA_LATERAL)            etiquetas[k] = "alcista";
    else if (direccion < 0.5 - BANDA_LATERAL)            etiquetas[k] = "bajista";
    else                                                 etiquetas[k] = "lateral";
  }
  return etiquetas;
}

// ── Ciclo principal de clustering ────────────────────────────
async function procesarCiclo(redisPub) {
  // Necesitamos al menos mercado O (pronóstico Y riesgo) para construir vector
  const tieneDatos = señales.mercado || (señales.pronostico && señales.riesgo);
  if (!tieneDatos) return;

  const vec = buildVector();

  // Agregar al historial (ventana deslizante)
  historial.push(vec);
  if (historial.length > HISTORY_MAX) historial.shift();

  nCiclos++;

  // Asignar al cluster más cercano y actualizar centroide
  const { cluster, distancia: dist } = asignar(vec);
  actualizarCentroide(cluster, vec);
  asignaciones.push(cluster);
  if (asignaciones.length > HISTORY_MAX) asignaciones.shift();

  // No publicar hasta tener suficientes muestras
  if (historial.length < MIN_SAMPLES) {
    log(`⏳ Acumulando historial (${historial.length}/${MIN_SAMPLES})...`);
    return;
  }

  // Etiquetar clusters con las coordenadas actuales
  const etiquetas = labelClusters();
  const label = etiquetas[cluster] ?? `cluster_${cluster}`;

  // ── Confianza ───────────────────────────────────────────────────────────
  // ANTES: `1 - dist/sqrt(DIM)`. sqrt(12)=3.464 es la diagonal del cubo de 12
  // dimensiones, o sea la distancia entre esquinas OPUESTAS. Pero todas las
  // dims están recortadas a [0,1] y casi todas viven cerca de 0.5, así que las
  // distancias reales a un centroide son de 0.01 a 0.2. La fórmula devolvía
  // ~0.999 SIEMPRE — no medía nada, era un artefacto de dividir por un máximo
  // inalcanzable. (Para marcar 99.9% alcanzaba con dist ≈ 0.0035.)
  //
  // Ahora: MARGEN contra el 2º centroide más cercano. 0 = el vector está a
  // igual distancia de dos clusters (no hay información); 1 = está claramente
  // en uno.
  const distOrd  = centroides.map(c => distancia(vec, c)).sort((a, b) => a - b);
  const d1       = distOrd[0];
  const d2       = distOrd[1] ?? d1;
  const margen   = (d1 + d2) > 0 ? clamp((d2 - d1) / (d2 + d1)) : 0;

  // Cobertura: qué fracción de los tres bloques de entrada llegó DE VERDAD.
  // buildVector() rellena con 0.5 todo lo que falta, así que con class40 y
  // class41 mudos el vector queda casi constante, un centroide se le pega vía
  // la EMA y se lo come todo: estabilidad 100%, un único régimen, 0% lateral.
  // Nada de eso significaba algo y desde afuera era invisible. Multiplicar por
  // la cobertura hace que el hueco se vea en el número.
  const fuentes = {
    pronostico: !!señales.pronostico,
    riesgo:     !!señales.riesgo,
    mercado:    !!señales.mercado,
  };
  const cobertura = Object.values(fuentes).filter(Boolean).length / 3;
  const confianza = clamp(margen * cobertura);

  const distMax  = Math.sqrt(DIM);
  const distNorm = dist / distMax;

  // Estabilidad: % de últimas 10 asignaciones en el mismo cluster
  const recientes   = asignaciones.slice(-10);
  const estabilidad = recientes.filter(a => a === cluster).length / recientes.length;

  // Distribución de regímenes en toda la ventana de historial
  // Permite calcular % neutral/lateral con datos reales
  const etiquetasAll = labelClusters();
  const conteoRegimenes = {};
  for (const asig of asignaciones) {
    const lbl = etiquetasAll[asig] ?? `cluster_${asig}`;
    conteoRegimenes[lbl] = (conteoRegimenes[lbl] || 0) + 1;
  }
  const totalAsig = asignaciones.length || 1;
  const distribucion = Object.fromEntries(
    Object.entries(conteoRegimenes).map(([k, v]) => [k, +(v / totalAsig).toFixed(3)])
  );
  // % neutral = proporción de muestras en cluster "lateral" o "neutral"
  const neutralPct = (conteoRegimenes["lateral"] || 0) + (conteoRegimenes["neutral"] || 0);
  const neutralRatio = +(neutralPct / totalAsig).toFixed(3);

  log(
    `📊 Régimen: [${label}] cluster=${cluster} conf=${(confianza*100).toFixed(1)}% ` +
    `(margen ${(margen*100).toFixed(0)}% × cobertura ${(cobertura*100).toFixed(0)}%) ` +
    `estab=${(estabilidad*100).toFixed(0)}% neutral=${(neutralRatio*100).toFixed(0)}% n=${historial.length}`
  );

  // Construir envelope para class18_ingest
  const envelope = {
    id:     crypto.randomUUID(),
    source: "class13",
    type:   "cluster_regime",
    texto:  `Régimen: ${label} | conf ${(confianza*100).toFixed(1)}% | estab ${(estabilidad*100).toFixed(0)}% | neutral ${(neutralRatio*100).toFixed(0)}%`,
    confianza,
    data: {
      tipo:           "cluster_regime",
      cluster_id:     cluster,
      cluster_label:  label,
      distancia:      parseFloat(dist.toFixed(4)),
      distancia_norm: parseFloat(distNorm.toFixed(4)),
      confianza:      parseFloat(confianza.toFixed(4)),
      margen:         parseFloat(margen.toFixed(4)),
      cobertura:      parseFloat(cobertura.toFixed(4)),
      fuentes,                                // qué bloques de entrada llegaron
      estabilidad:    parseFloat(estabilidad.toFixed(4)),
      neutral_pct:    neutralRatio,           // ← NUEVO: % real de muestras neutral/lateral
      distribucion,                           // ← NUEVO: distribución completa de regímenes
      vector_regime:  vec.map(v => parseFloat(v.toFixed(4))),
      dims:           DIM,
      n_muestras:     historial.length,
      n_ciclos:       nCiclos,
      centroides_preview: centroides.map(c =>
        c.slice(0, 4).map(v => parseFloat(v.toFixed(3)))
      ),
      ts: new Date().toISOString(),
    },
    ts: new Date().toISOString(),
  };

  try {
    await redisPub.publish(OUTPUT_CHANNEL, JSON.stringify(envelope));
    log(`📤 Régimen publicado → ${OUTPUT_CHANNEL}`);
  } catch (e) {
    log(`❌ Error publicando: ${e.message}`, "ERROR");
  }

  // Métricas de sistema (no crítico)
  try {
    await redisPub.publish("system.metrics", JSON.stringify({
      ts:     new Date().toISOString(),
      source: "class13",
      cluster_id:     cluster,
      cluster_label:  label,
      confianza,
      estabilidad,
    }));
  } catch (_) {}
}

// ── Manejador unificado de canales ────────────────────────────
let cicloTimer = null;

function programarCiclo(redisPub) {
  // Debounce: esperar 500ms después de la última señal
  // para tener todas las señales actualizadas antes de procesar
  clearTimeout(cicloTimer);
  cicloTimer = setTimeout(() => procesarCiclo(redisPub), 500);
}

async function unifiedHandler(raw, channelName, redisPub) {
  try {
    const parsed = JSON.parse(raw);

    // Anti-loop
    if (parsed?.source === "class13") return;

    if (channelName === "class40_output") {
      señales.pronostico = parsed;
      log(`📥 class40_output — pronóstico recibido`);
      programarCiclo(redisPub);

    } else if (channelName === "class41_output") {
      señales.riesgo = parsed;
      const nivel = parsed?.RiskMetrics?.RiskLevel ?? "?";
      log(`📥 class41_output — riesgo=${nivel}`);
      programarCiclo(redisPub);

    } else if (channelName === "class7_output") {
      // Solo procesar actualizaciones de sector (no precios individuales)
      if (parsed?.type === "sector_state" || parsed?.sectors || parsed?.sector_state) {
        señales.mercado = parsed;
        const rg = ((parsed?.riesgoGlobal ?? 0.5) * 100).toFixed(1);
        log(`📥 class7_output — riesgoGlobal=${rg}%`);
        programarCiclo(redisPub);
      }
    }

  } catch (e) {
    log(`⚠️ Error procesando ${channelName}: ${e.message}`, "WARN");
  }
}

// ── Arranque ─────────────────────────────────────────────────
(async () => {
  log("=== class13 v2.1 — Motor de Clustering Temporal de Vectores ===");
  log(`📡 Entradas: ${INPUT_CHANNELS.join(", ")}`);
  log(`📤 Salida:   ${OUTPUT_CHANNEL}`);
  log(`🔢 K=${K} clusters | DIM=${DIM} | historial=${HISTORY_MAX} muestras | α=${ALPHA}`);

  const redisSub = createClient({ url: REDIS_URL });
  const redisPub = createClient({ url: REDIS_URL });

  redisSub.on("error", e => log(`Redis SUB: ${e.message}`, "WARN"));
  redisPub.on("error", e => log(`Redis PUB: ${e.message}`, "WARN"));

  try {
    await redisSub.connect();
    await redisPub.connect();
    log("✅ Redis conectado");

    for (const ch of INPUT_CHANNELS) {
      await redisSub.subscribe(ch, async (raw) => {
        await unifiedHandler(raw, ch, redisPub);
      });
      log(`📡 Suscrito: ${ch}`);
    }

    log("✅ class13 operativo — esperando señales de class40/41/7");

    // Heartbeat periódico
    setInterval(() => {
      const tiene = Object.entries(señales)
        .filter(([, v]) => v !== null)
        .map(([k]) => k)
        .join(", ") || "ninguna";
      log(`❤️  ciclos=${nCiclos} historial=${historial.length} señales=[${tiene}]`);
    }, 60_000).unref();

  } catch (e) {
    log(`❌ Error de arranque: ${e.message}`, "ERROR");
    process.exit(1);
  }

  process.on("SIGINT",  async () => {
    log("Cerrando class13...");
    try { await redisSub.quit(); } catch (_) {}
    try { await redisPub.quit(); } catch (_) {}
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    try { await redisSub.quit(); } catch (_) {}
    try { await redisPub.quit(); } catch (_) {}
    process.exit(0);
  });
})();