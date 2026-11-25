// ============================================================
// class5.js — Procesador de Crisis Históricas (MIIA v2.1)
// ============================================================
//
// ROL: Busca información de crisis históricas financieras,
//      genera PDFs de resumen, persiste en MySQL y publica
//      los fragmentos de texto a class3_ingest para que
//      class3.cs los vectorice con TF-IDF y alimente las
//      redes neuronales (class21-24) via class19.
//
// CAMBIOS v2.1 respecto a v1.9.1:
//
//   1. PUBLICACIÓN A class3_ingest CORREGIDA
//      Antes: publicaba UNA vez con resumenTexto truncado a 2000 chars
//             + vectorObj TF-IDF local embebido en el envelope.
//      Ahora: publica CADA FRAGMENTO por separado (chunks de 500 palabras)
//             con texto limpio. class3.cs vectoriza cada fragmento
//             con su propio TF-IDF acumulativo — más señal semántica
//             para las redes neuronales.
//
//   2. vectorObj TF-IDF LOCAL ELIMINADO del envelope
//      Era redundante y contraproducente: class3.cs genera su
//      propio vector TF-IDF con vocabulario acumulado de todos
//      los documentos. Mandar un vectorObj pre-computado desde
//      class5 con vocabulario distinto era ruido, no señal.
//
//   3. ENVELOPE LIMPIO para class3_ingest
//      Solo: { id, source, type, texto, data.crisis, data.fragmento, ts }
//      class3.cs solo necesita el campo "texto" para vectorizar.
//
//   4. THROTTLE 200ms entre fragmentos
//      Evita ráfagas que saturen class19. Con 15 crisis × ~3 fragmentos
//      = ~45 publicaciones con 200ms de separación = ~9 segundos totales.
//
//   5. TEXTO ENRIQUECIDO: resumen + snippets cuantitativos concatenados
//      El texto enviado a class3 incluye también los snippets de
//      recuperación/pre-crisis, no solo el resumen principal.
//
//   6. Notificación de estado via class5_output (sin cambios de canal).
//   7. Persistencia MySQL, búsqueda Google y PDF sin cambios.
// ============================================================

import path   from "path";
import fs     from "fs";
import axios  from "axios";
import Bottleneck from "bottleneck";
import { createRequire } from "module";
const require  = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import retry   from "async-retry";
import natural  from "natural";
import crypto   from "crypto";
import pino     from "pino";
import pLimit   from "p-limit";
import { createClient } from "redis";
import { fileURLToPath } from "url";
import ini      from "ini";
import { v4 as uuidv4 } from "uuid";
import { getStorageConfig, getLoggingConfig } from "./class38.js";

// ── ESM dirname ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Directorios ────────────────────────────────────────────
const baseDir     = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR    = path.join(baseDir, "logs");
const JSON_DIR    = path.join(baseDir, "json_guardados");
const RAW_DIR     = path.join(baseDir, "raw");
const METRICS_DIR = path.join(baseDir, "metrics");
const CONFIG_DIR  = path.join(baseDir, "config");

for (const dir of [LOGS_DIR, JSON_DIR, RAW_DIR, METRICS_DIR, CONFIG_DIR]) {
  try   { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { console.error(`[class5] mkdir ${dir}:`, e.message); }
}

const NOMBRE_CLASE = "class5";
const LOG_FILE     = path.join(LOGS_DIR, `${NOMBRE_CLASE}.log`);

const logger = pino(
  { level: process.env.LOG_LEVEL || "info", base: { clase: NOMBRE_CLASE } },
  pino.destination({ dest: LOG_FILE, sync: false })
);

async function guardarEvento(tipo, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), tipo, payload }) + "\n";
  try { await fs.promises.appendFile(LOG_FILE, line, "utf8"); }
  catch (e) {
    try { await fs.promises.writeFile(path.join(baseDir, `error_log_${Date.now()}.txt`), line); }
    catch (_) {}
  }
}

// ── Config desde class38 ───────────────────────────────────
const storageCfg = (() => { try { return getStorageConfig() || {}; } catch { return {}; } })();
const logCfg     = (() => { try { return getLoggingConfig()  || {}; } catch { return {}; } })();

export function getPath(key, fallback = "./") {
  try { const v = storageCfg[key]; return typeof v === "string" && v.trim() ? v : fallback; }
  catch { return fallback; }
}
export function getLogLevel(d = "info") {
  try { return logCfg.level || d; } catch { return d; }
}
export function shouldRotateLogs() {
  try { return logCfg.rotate_logs === true; } catch { return false; }
}

// ── MySQL via class42 (lazy import) ───────────────────────
let _guardarPDF       = null;
let _guardarFragmento = null;
let _vincularCrisis   = null;
let _obtenerCrisis    = null;
let _insertarCrisis   = null;

async function cargarClass42() {
  if (_guardarPDF) return true;
  try {
    const c42 = await import("./class42.js");
    _guardarPDF       = c42.guardarPDF;
    _guardarFragmento = c42.guardarFragmento;
    _vincularCrisis   = c42.vincularCrisisPDF;
    _obtenerCrisis    = c42.obtenerCrisisPorNombre;
    _insertarCrisis   = c42.insertarCrisisIfNotExists;
    logger.info("[class5] ✅ class42 (MySQL) disponible");
    return true;
  } catch (e) {
    logger.warn(`[class5] class42 no disponible: ${e.message} — sin persistencia MySQL`);
    return false;
  }
}

// ── Redis ──────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redisConfig = {
  url:           REDIS_URL,
  inputChannel:  "class5_input",
  outputChannel: "class5_output",   // notificaciones de estado al sistema
  exportChannel: "class3_ingest",   // → class3.cs → TF-IDF → class19_ingest → redes
};

const TRIGGER_CHANNEL      = "class5_trigger";
const FRAGMENT_THROTTLE_MS = 200;   // ms entre fragmentos para no saturar class3/class19

const redisClient     = createClient({ url: redisConfig.url });
const redisSubscriber = createClient({ url: redisConfig.url });

redisClient.on    ("error", e => logger.error(`[class5] Redis error: ${e.message}`));
redisSubscriber.on("error", e => logger.error(`[class5] RedisSub error: ${e.message}`));

// ── publishSystemEvent ─────────────────────────────────────
const SYSTEM_CHANNELS = { LOG: "system.log", ERROR: "system.error", METRICS: "system.metrics" };

export async function publishSystemEvent(redis, type, payload, source = "unknown") {
  if (!SYSTEM_CHANNELS[type]) return;
  try {
    await redis.publish(SYSTEM_CHANNELS[type], JSON.stringify({
      ts: new Date().toISOString(), source, type, payload
    }));
  } catch (e) { logger.error(`[publishSystemEvent] ${e.message}`); }
}

// ── Crisis históricas ──────────────────────────────────────
const crisisHistoricas = [
  { termino: "Gran Depresión 1929 Estados Unidos",           nombre: "Gran Depresión 1929",        year: "1929" },
  { termino: "Crisis del petróleo 1973",                     nombre: "Crisis del Petróleo 1973",   year: "1973" },
  { termino: "Crisis financiera global 1997 Asia",           nombre: "Crisis Asiática 1997",        year: "1997" },
  { termino: "Crisis rusa 1998",                             nombre: "Crisis Rusa 1998",            year: "1998" },
  { termino: "Crisis económica Argentina 2001",              nombre: "Crisis Argentina 2001",       year: "2001" },
  { termino: "Crisis hipotecaria 2008 Estados Unidos",       nombre: "Crisis Hipotecaria 2008",     year: "2008" },
  { termino: "Crisis de la Eurozona 2010-2014",              nombre: "Crisis Eurozona 2010",        year: "2010" },
  { termino: "Corrección mercado China 2015",                nombre: "Corrección China 2015",       year: "2015" },
  { termino: "Crisis económica Argentina 2018",              nombre: "Crisis Argentina 2018",       year: "2018" },
  { termino: "Crisis de liquidez global 2020 COVID-19",      nombre: "Crisis COVID-19 2020",        year: "2020" },
  { termino: "Crisis energética global 2021-2022",           nombre: "Crisis Energética 2021",      year: "2021" },
  { termino: "Crisis inflacionaria global 2022-2023",        nombre: "Crisis Inflacionaria 2022",   year: "2022" },
  { termino: "Crisis bancaria global 2023",                  nombre: "Crisis Bancaria 2023",        year: "2023" },
  { termino: "Crisis económica Argentina 2023",              nombre: "Crisis Argentina 2023",       year: "2023" },
  { termino: "Crisis de deuda soberana 2024 América Latina", nombre: "Crisis Deuda 2024",           year: "2024" },
];

// ── Rutas de trabajo ───────────────────────────────────────
const pdfDir = path.join(baseDir, "pdf", "historia_de_crisis");
fs.mkdirSync(pdfDir, { recursive: true });

// ── API Google ─────────────────────────────────────────────
// Claves SOLO desde .env (GOOGLE_SEARCH_KEY/CX via class38). Sin fallback
// hardcodeado: una clave en el código fuente queda expuesta al publicar.
const GOOGLE_API_KEY = process.env.GOOGLE_CSE_KEY || process.env.GOOGLE_SEARCH_KEY || "";
const GOOGLE_CX      = process.env.GOOGLE_CSE_CX  || process.env.GOOGLE_SEARCH_CX  || "";

const googleLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 1200 });

const cacheBusquedaPath = path.join(pdfDir, "cache_busquedas.json");
let cacheBusquedas = {};
try {
  if (fs.existsSync(cacheBusquedaPath))
    cacheBusquedas = JSON.parse(fs.readFileSync(cacheBusquedaPath, "utf8"));
} catch (_) {}

function guardarCache() {
  try { fs.writeFileSync(cacheBusquedaPath, JSON.stringify(cacheBusquedas, null, 2), "utf8"); }
  catch (e) { logger.error(`Error guardando cache: ${e.message}`); }
}

async function buscarEnGoogleAPI(termino) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  if (cacheBusquedas[termino]) return cacheBusquedas[termino];

  try {
    const resultados = await googleLimiter.schedule(() =>
      retry(async () => {
        const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
          params: { key: GOOGLE_API_KEY, cx: GOOGLE_CX, q: termino },
          timeout: 10000,
        });
        return res.data.items || [];
      }, { retries: 3, factor: 2, minTimeout: 1000,
           onRetry: (e, i) => logger.warn(`Retry ${i} para: ${termino} — ${e.message}`) })
    );
    cacheBusquedas[termino] = resultados;
    guardarCache();
    return resultados;
  } catch (e) {
    logger.error(`Error búsqueda Google: ${termino} — ${e.message}`);
    return [];
  }
}

// ── Helpers ────────────────────────────────────────────────
function calcularHashArchivo(ruta) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("sha256");
    const stream = fs.createReadStream(ruta);
    stream.on("error", reject);
    stream.on("data",  chunk => hash.update(chunk));
    stream.on("end",   () => resolve(hash.digest("hex")));
  });
}

async function verificarPDF(rutaPdf) {
  try {
    const data = await retry(() => pdfParse(fs.readFileSync(rutaPdf)), {
      retries: 3, factor: 2, minTimeout: 500
    });
    if (!data.text || data.text.trim().length < 100) return false;
    const palabrasClave = ["crisis", "recesión", "quiebra", "deuda", "inflación", "mercado"];
    return palabrasClave.some(p => data.text.toLowerCase().includes(p));
  } catch (e) {
    logger.error(`Error verificando PDF: ${e.message}`);
    return false;
  }
}

function resumirTextoAvanzado(texto, maxPalabras = 500) {
  const limpio  = texto.replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, " ").trim();
  const palabras = limpio.split(" ");
  return palabras.length > maxPalabras
    ? palabras.slice(0, maxPalabras).join(" ") + "..."
    : limpio;
}

function extraerMetricasCuantitativas(textos) {
  const r = { caidaIndicePercent: null, duracionRecuperacionMeses: null };
  for (const t of textos) {
    const m = t.match(/(\d{1,3}(?:\.\d+)?)\s?%/);
    if (m) { r.caidaIndicePercent = parseFloat(m[1]); break; }
  }
  return r;
}

// Dividir texto en fragmentos de N palabras.
// Cada fragmento es un documento independiente para class3.cs.
function dividirEnFragmentos(texto, palabrasPorFragmento = 500) {
  const palabras = texto.split(/\s+/).filter(Boolean);
  const fragmentos = [];
  for (let i = 0; i < palabras.length; i += palabrasPorFragmento)
    fragmentos.push(palabras.slice(i, i + palabrasPorFragmento).join(" "));
  return fragmentos;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Persistir crisis en MySQL ──────────────────────────────
async function persistirCrisisEnMySQL(crisis, resumenTexto, rutaArchivo) {
  const mysqlOk = await cargarClass42();
  if (!mysqlOk) return null;

  try {
    const hashTexto  = crypto.createHash("sha256").update(resumenTexto).digest("hex");
    let tamanioBytes = null;
    try { tamanioBytes = fs.statSync(rutaArchivo).size; } catch (_) {}

    const pdfId = await _guardarPDF({
      nombre:          `resumen_${crisis.year}_${crisis.nombre.slice(0, 50)}.pdf`,
      tipo:            "crisis_historica",
      fuente:          `Google Search: ${crisis.termino}`,
      fecha_documento: `${crisis.year}-01-01`,
      texto_completo:  resumenTexto,
      tamanio_bytes:   tamanioBytes,
      hash_sha256:     hashTexto,
    });

    if (!pdfId) {
      logger.warn(`PDF ya existe o error MySQL: ${crisis.nombre}`);
      return null;
    }

    logger.info(`[class5] 💾 PDF en MySQL: ${crisis.nombre} (id=${pdfId})`);

    const fragmentos = dividirEnFragmentos(resumenTexto, 500);
    for (let i = 0; i < fragmentos.length; i++) {
      await _guardarFragmento({
        pdf_id:           pdfId,
        numero_fragmento: i + 1,
        texto:            fragmentos[i],
        num_tokens:       fragmentos[i].split(/\s+/).length,
      });
    }
    logger.info(`[class5] 📝 ${fragmentos.length} fragmentos guardados en MySQL (${crisis.nombre})`);

    const anio = parseInt(crisis.year, 10);
    let crisisEvent = await _obtenerCrisis(crisis.nombre, anio);

    if (!crisisEvent) {
      const nuevaId = await _insertarCrisis({
        nombre:      crisis.nombre,
        anio_inicio: anio,
        anio_fin:    anio + 1,
        tipo:        "crash_bursatil",
        severidad:   5,
        descripcion: resumenTexto.slice(0, 500),
      });
      if (nuevaId) crisisEvent = { id: nuevaId };
    }

    if (crisisEvent?.id) {
      const patronJson = {
        keywords: resumenTexto.toLowerCase()
          .split(/\s+/).filter(w => w.length > 5).slice(0, 20),
        anio:    crisis.year,
        termino: crisis.termino,
      };
      await _vincularCrisis(crisisEvent.id, pdfId, patronJson);
      logger.info(`[class5] 🔗 crisis_event ${crisisEvent.id} ↔ PDF ${pdfId}`);
    }

    return pdfId;
  } catch (e) {
    logger.error(`[class5] Error persistiendo MySQL: ${e.message}`);
    return null;
  }
}

// ── Publicar fragmentos a class3_ingest → class3.cs ───────
// Cada fragmento = un documento independiente para el TF-IDF
// acumulativo de class3.cs. class3.cs vectoriza y publica
// a class19_ingest → class21/22/23/24 (redes neuronales C++).
//
// Envelope mínimo: solo "texto" + metadata de trazabilidad.
// NO se incluye vectorObj ni TF-IDF pre-computado — eso es
// trabajo de class3.cs, no de class5.
async function publicarFragmentosAClass3(crisis, fragmentos, pdfId) {
  if (!redisClient?.isOpen) {
    logger.warn("[class5] Redis no conectado — fragmentos no publicados");
    return 0;
  }

  let publicados = 0;

  for (let i = 0; i < fragmentos.length; i++) {
    const fragmento = fragmentos[i];
    if (!fragmento || fragmento.trim().length < 30) continue;

    const envelope = {
      id:     uuidv4(),
      source: "class5",
      type:   "crisis_historica",
      texto:  fragmento,   // class3.cs lee "texto" para vectorizar
      text:   fragmento,   // compatibilidad con versiones anteriores
      data: {
        crisis:    crisis.nombre,
        year:      crisis.year,
        termino:   crisis.termino,
        fragmento: i + 1,
        total:     fragmentos.length,
        pdfId:     pdfId || null,
      },
      ts: new Date().toISOString(),
    };

    try {
      await redisClient.publish(redisConfig.exportChannel, JSON.stringify(envelope));
      publicados++;

      logger.info(
        `[class5] 📤 → ${redisConfig.exportChannel} | ` +
        `${crisis.nombre} frag ${i + 1}/${fragmentos.length} ` +
        `(${fragmento.split(/\s+/).length} palabras)`
      );

      // Throttle: no saturar class3.cs ni class19
      if (i < fragmentos.length - 1) await sleep(FRAGMENT_THROTTLE_MS);

    } catch (e) {
      logger.error(`[class5] Error publicando fragmento ${i + 1}: ${e.message}`);
    }
  }

  return publicados;
}

// ══════════════════════════════════════════════════════════
// ANÁLISIS PRINCIPAL
// ══════════════════════════════════════════════════════════

let procesandoActualmente = false;

async function analizarCrisis(queriesOverride = null) {
  if (procesandoActualmente) {
    logger.warn("[class5] Ya procesando — trigger ignorado");
    return [];
  }
  procesandoActualmente = true;

  try {
    logger.info(`[class5] 🚀 Analizando ${crisisHistoricas.length} crisis históricas`);
    logger.info(`[class5] 📤 Fragmentos → ${redisConfig.exportChannel} (class3.cs → redes)`);

    const limit = pLimit(1);   // una crisis a la vez para no saturar Google API

    async function procesarUnaCrisis(crisis) {
      try {
        logger.info(`[class5] Procesando: ${crisis.nombre}`);

        // 1) Búsqueda Google
        let resultados = [];
        if (Array.isArray(queriesOverride) && queriesOverride.length > 0) {
          for (const q of queriesOverride) {
            const r = await buscarEnGoogleAPI(q);
            resultados.push(...(r || []));
          }
        } else {
          resultados = await buscarEnGoogleAPI(crisis.termino);
        }

        resultados = (resultados || []).filter(r => r.link?.startsWith("https://"));
        if (resultados.length === 0) {
          logger.warn(`[class5] Sin resultados: ${crisis.nombre}`);
          return { crisis: crisis.nombre, status: "sin_resultados" };
        }

        // 2) Texto desde snippets de búsqueda
        const textoBase = resultados
          .map(r => r.snippet || "")
          .filter(Boolean)
          .join(" ");

        const resumenTexto = resumirTextoAvanzado(textoBase);

        // 3) Dedup por hash en disco
        const nombreArchivo = `resumen_${crisis.year}.pdf`;
        const rutaArchivo   = path.join(pdfDir, nombreArchivo);
        let generarPdf      = true;

        if (fs.existsSync(rutaArchivo)) {
          const hashExistente = await calcularHashArchivo(rutaArchivo);
          const resumenHash   = crypto.createHash("sha256").update(resumenTexto).digest("hex");
          if (hashExistente === resumenHash) {
            logger.info(`[class5] PDF sin cambios (hash match): ${crisis.nombre}`);
            generarPdf = false;
          }
        }

        // 4) Generar PDF
        if (generarPdf) {
          const { default: PDFDocument } = await import("pdfkit");
          await new Promise((resolve, reject) => {
            const doc    = new PDFDocument({ margin: 40, size: "A4",
              info: { Title: `Resumen crisis ${crisis.nombre}`, Author: "MIIA" } });
            const stream = fs.createWriteStream(rutaArchivo);
            doc.pipe(stream);
            doc.font("Times-Bold").fontSize(16).text(`Resumen: ${crisis.nombre}`, { align: "center" });
            doc.moveDown();
            doc.font("Times-Roman").fontSize(12).text(resumenTexto, { align: "justify", lineGap: 4 });
            doc.end();
            stream.on("finish", resolve);
            stream.on("error",  reject);
          });
          logger.info(`[class5] 📄 PDF generado: ${rutaArchivo}`);
        }

        // 5) Validar PDF
        const esValido = await verificarPDF(rutaArchivo);
        if (!esValido) {
          logger.warn(`[class5] PDF inválido: ${crisis.nombre}`);
          return { crisis: crisis.nombre, status: "pdf_invalido" };
        }

        // 6) Búsquedas cuantitativas adicionales (pre/post crisis)
        const year = parseInt(crisis.year, 10);
        const busquedasMercado = [
          `balance mercado antes crisis ${crisis.nombre} ${year - 1}`,
          `recuperación económica post crisis ${crisis.nombre} ${year + 1}`,
        ];
        const snippetsCuantitativos = [];
        for (const consulta of busquedasMercado) {
          const r = (await buscarEnGoogleAPI(consulta) || [])
            .filter(r => r.link?.startsWith("https://"));
          snippetsCuantitativos.push(...r.map(r => r.snippet || ""));
        }
        const metricasCuantitativas = extraerMetricasCuantitativas(snippetsCuantitativos);

        // Texto enriquecido = resumen + contexto pre/post crisis
        const textoEnriquecido = snippetsCuantitativos.length > 0
          ? resumenTexto + " " + snippetsCuantitativos.join(" ")
          : resumenTexto;

        // 7) Persistir en MySQL
        const pdfId = await persistirCrisisEnMySQL(crisis, textoEnriquecido, rutaArchivo);

        // 8) Archivo maestro en disco
        fs.writeFileSync(
          path.join(pdfDir, `maestro_${crisis.year}.json`),
          JSON.stringify({
            crisis: crisis.nombre, year: crisis.year,
            resumenTexto: textoEnriquecido,
            metricasCuantitativas,
            rutaPDF: rutaArchivo,
            pdfId,
            fechaGeneracion: new Date().toISOString(),
          }, null, 2), "utf8"
        );

        // 9) PUBLICAR FRAGMENTOS A class3_ingest
        // El texto enriquecido se divide en chunks de 500 palabras.
        // class3.cs vectoriza cada uno con TF-IDF y lo envía a
        // class19_ingest → class21-24 (redes neuronales C++).
        const fragmentos = dividirEnFragmentos(textoEnriquecido, 500);
        const publicados = await publicarFragmentosAClass3(crisis, fragmentos, pdfId);

        logger.info(
          `[class5] ✅ ${crisis.nombre} — ` +
          `${publicados}/${fragmentos.length} fragmentos → class3_ingest`
        );

        // 10) Notificar estado al sistema via class5_output
        if (redisClient?.isOpen) {
          await redisClient.publish(redisConfig.outputChannel, JSON.stringify({
            id:     uuidv4(),
            source: "class5",
            type:   "crisis_procesada",
            data: {
              crisis:                crisis.nombre,
              year:                  crisis.year,
              pdfId,
              fragmentos_publicados: publicados,
              fragmentos_totales:    fragmentos.length,
              metricasCuantitativas,
              rutaPDF:               rutaArchivo,
            },
            ts: new Date().toISOString(),
          })).catch(() => {});
        }

        return {
          crisis:     crisis.nombre,
          status:     "procesada",
          rutaPDF:    rutaArchivo,
          pdfId,
          fragmentos: publicados,
        };

      } catch (e) {
        logger.error(`[class5] Error procesando ${crisis.nombre}: ${e.message}`);
        return { crisis: crisis.nombre, status: "error", error: e.message };
      }
    }

    const promesas   = crisisHistoricas.map(c => limit(() => procesarUnaCrisis(c)));
    const resultados = await Promise.allSettled(promesas);

    const ok       = resultados.filter(r => r.status === "fulfilled" && r.value?.status === "procesada").length;
    const errores  = resultados.filter(r => r.status !== "fulfilled" || r.value?.status === "error").length;
    const totalFrag = resultados
      .filter(r => r.status === "fulfilled")
      .reduce((s, r) => s + (r.value?.fragmentos || 0), 0);

    logger.info(
      `[class5] 🏁 Finalizado — ${ok}/${crisisHistoricas.length} OK, ` +
      `${errores} errores, ${totalFrag} fragmentos → class3.cs → redes`
    );
    return resultados;

  } finally {
    procesandoActualmente = false;
  }
}

// ══════════════════════════════════════════════════════════
// BOOT — Redis y suscripciones
// ══════════════════════════════════════════════════════════
(async () => {
  try {
    await redisClient.connect();
    await redisSubscriber.connect();
    logger.info("[class5] ✅ Redis conectado");

    // Canal input (mensajes del sistema)
    try {
      await redisSubscriber.subscribe(redisConfig.inputChannel, manejarMensajeRedis);
      logger.info(`[class5] 📡 Suscrito → ${redisConfig.inputChannel}`);
    } catch (e) { logger.warn(`No se pudo suscribir a ${redisConfig.inputChannel}: ${e.message}`); }

    // Canal trigger — dispara analizarCrisis()
    // Uso: redis.publish("class5_trigger", "start")
    //      redis.publish("class5_trigger", JSON.stringify({ queries: ["Argentina default 2023"] }))
    try {
      await redisSubscriber.subscribe(TRIGGER_CHANNEL, async (message) => {
        logger.info(`[class5] 🔔 Trigger recibido en ${TRIGGER_CHANNEL}`);
        let queries = null;
        try {
          const parsed = JSON.parse(message);
          if (Array.isArray(parsed.queries)) queries = parsed.queries;
        } catch (_) {}
        await analizarCrisis(queries);
      });
      logger.info(`[class5] 📡 Suscrito → ${TRIGGER_CHANNEL}`);
    } catch (e) { logger.warn(`No se pudo suscribir a ${TRIGGER_CHANNEL}: ${e.message}`); }

    logger.info(`[class5] 📤 Fragmentos → ${redisConfig.exportChannel} (class3.cs → class19 → redes)`);
    logger.info(`[class5] 📤 Estado    → ${redisConfig.outputChannel}`);
    logger.info(`[class5] ✅ Listo. Esperando trigger en ${TRIGGER_CHANNEL}`);

  } catch (e) {
    logger.error(`[class5] Error conectando a Redis: ${e.message}`);
  }
})();

async function manejarMensajeRedis(message) {
  try { logger.info(`[class5] 📩 Mensaje en ${redisConfig.inputChannel}: ${message}`); }
  catch (e) { logger.error(`Error manejando mensaje: ${e.message}`); }
}

process.on("uncaughtException",  e => logger.error(`uncaughtException: ${e.message}`));
process.on("unhandledRejection", e => logger.error(`unhandledRejection: ${String(e)}`));

// ── Exports ────────────────────────────────────────────────
export {
  analizarCrisis,
  buscarEnGoogleAPI,
  verificarPDF,
  pdfDir as operadorDir,
  crisisHistoricas,
};