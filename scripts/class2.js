// ============================================================
// class2.js — Buffer Documental + Persistencia MySQL (MIIA)
// VERSIÓN CORREGIDA v1.9.1
//
// Correcciones aplicadas:
//   1. Ruta PDF_BASE_DIR relativa al script (no OneDrive hardcodeada)
//   2. Trigger "class2_trigger" en lugar de "class3_ingest" (evita loop)
//   3. startedViaRedis eliminado — puede re-procesar ante nuevos triggers
//   4. DOCUMENT_COOLDOWN_MS reducido de 5min a 3 segundos
//   5. Persistencia MySQL: guardarPDF() + guardarFragmento() via class42
//   6. SHA256 del texto para deduplicación en pdf_documents
//   7. Tipo de PDF detectado por subcarpeta (crisis_historica, etc.)
//   8. Fragmentos guardados en pdf_fragments (chunks de 500 tokens)
//   9. Campo "texto" en envelope (DSL estándar)
//  10. Marca procesado=1 en MySQL después de publicar en Redis
// ============================================================

import fs  from "fs";
import fsp from "node:fs/promises";
import path from "path";
import os   from "os";
import { createRequire } from "module";
const require   = createRequire(import.meta.url);
const pdf_parser = require("pdf-parse");
const pdf        = typeof pdf_parser === "function" ? pdf_parser : pdf_parser.default;

import { createClient } from "redis";
import mammoth           from "mammoth";
import { fileURLToPath } from "url";
import ini               from "ini";
import crypto            from "crypto";

// ── ESM dirname ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── MySQL via class42 ──────────────────────────────────────
// Importación lazy para no crashear si class42 no está listo
let _guardarPDF        = null;
let _guardarFragmento  = null;
let _marcarProcesado   = null;

async function cargarClass42() {
  if (_guardarPDF) return true;
  try {
    const c42 = await import("./class42.js");
    _guardarPDF       = c42.guardarPDF;
    _guardarFragmento = c42.guardarFragmento;
    _marcarProcesado  = c42.marcarPDFProcesado;
    log("[class2] ✅ class42 (MySQL) disponible");
    return true;
  } catch (e) {
    log(`[class2] ⚠️ class42 no disponible: ${e.message} — solo Redis`, "WARN");
    return false;
  }
}

// ── Dynamic import pdfjs ───────────────────────────────────
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

// ── Directorios — RUTAS RELATIVAS AL SCRIPT ───────────────
//
// __dirname = C:\...\MIIA\scripts\
// baseDir   = C:\...\MIIA\operador\aprendizaje\
// PDF_BASE_DIR = C:\...\MIIA\operador\aprendizaje\pdf\
//
// Para agregar PDFs: copiarlos a MIIA/operador/aprendizaje/pdf/
// Estructura recomendada de subcarpetas (determina el tipo en MySQL):
//   pdf/crisis_historica/   → tipo='crisis_historica'
//   pdf/analisis_tecnico/   → tipo='analisis_tecnico'
//   pdf/noticia_mercado/    → tipo='noticia_mercado'
//   pdf/libro_finanzas/     → tipo='libro_finanzas'
//   pdf/macro_economico/    → tipo='macro_economico'
//   pdf/                    → tipo='libro_finanzas' (default)

const baseDir      = path.resolve(__dirname, "../operador/aprendizaje");
const LOGS_DIR     = path.join(baseDir, "logs");
const JSON_DIR     = path.join(baseDir, "json_guardados");
const RAW_DIR      = path.join(baseDir, "raw");
const METRICS_DIR  = path.join(baseDir, "metrics");
const CONFIG_DIR   = path.join(baseDir, "config");
const DIALOGO_DIR  = path.join(baseDir, "dialogos");

// ── RUTA DE PDFs — relativa, no OneDrive ──────────────────
const PDF_BASE_DIR = path.join(baseDir, "pdf");

for (const dir of [LOGS_DIR, JSON_DIR, RAW_DIR, METRICS_DIR, CONFIG_DIR, PDF_BASE_DIR, DIALOGO_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

const LOG_FILE = path.join(LOGS_DIR, "class2.log");

console.log(`[class2] 📁 Carpeta de PDFs: ${PDF_BASE_DIR}`);

// ── Constantes ─────────────────────────────────────────────
const MAX_PDF_PROCESS_TIME = 2 * 60 * 1000;  // 2 minutos por PDF
const DOCUMENT_COOLDOWN_MS = 3_000;           // 3s entre documentos (antes: 5 min)
const TOKENS_POR_FRAGMENTO = 500;             // tamaño de cada chunk en MySQL

// ── Logger ──────────────────────────────────────────────────
const MAX_LOG_SIZE = 5 * 1024 * 1024;

function log(message, type = "INFO") {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${type}] ${typeof message === "string" ? message : JSON.stringify(message)}`;
  try { console.log(line); } catch (_) {}
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE)
      fs.renameSync(LOG_FILE, `${LOG_FILE}.${Date.now()}.bak`);
    fs.appendFileSync(LOG_FILE, line + os.EOL);
  } catch (_) {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Redis channels ─────────────────────────────────────────
const redisConfig = {
  url:           process.env.REDIS_URL || "redis://localhost:6379",
  outputChannel: "class2_output",
  exportChannel: "class3_ingest",   // DSL: publica aquí para vectorización .NET
};

// CORREGIDO: trigger separado para evitar loop con class3_ingest
const TRIGGER_CHANNEL    = "class2_trigger";    // ← recibe triggers de procesamiento
const USER_PDF_CHANNEL   = "class2_pdf_cmd";    // ← comandos desde la web (ver abajo)

let redisClient     = null;
let redisSubscriber = null;

// ── Detectar tipo de PDF por subcarpeta ────────────────────
const TIPO_MAP = {
  "crisis_historica":  "crisis_historica",
  "analisis_tecnico":  "analisis_tecnico",
  "noticia_mercado":   "noticia_mercado",
  "libro_finanzas":    "libro_finanzas",
  "macro_economico":   "macro_economico",
};

function detectarTipoPDF(filePath) {
  const partes = filePath.split(path.sep);
  for (const parte of partes) {
    const key = parte.toLowerCase().replace(/[^a-z_]/g, "");
    if (TIPO_MAP[key]) return TIPO_MAP[key];
  }
  return "libro_finanzas"; // default
}

// ── Dividir texto en fragmentos de ~500 tokens ────────────
function dividirEnFragmentos(texto, tokensPerChunk = TOKENS_POR_FRAGMENTO) {
  const palabras    = texto.split(/\s+/).filter(Boolean);
  const fragmentos  = [];
  for (let i = 0; i < palabras.length; i += tokensPerChunk) {
    fragmentos.push(palabras.slice(i, i + tokensPerChunk).join(" "));
  }
  return fragmentos;
}

// ── Leer contract.ini (centralizado) ──────────────────────
function leerContrato() {
  try {
    const p = path.join(CONFIG_DIR, "contract.ini");
    if (!fs.existsSync(p)) return { targetChannel: redisConfig.exportChannel, envelopeType: "plain" };
    const raw = fs.readFileSync(p, "utf8");
    const c   = ini.parse(raw);
    return {
      targetChannel: c.contract?.target_channel?.trim() || redisConfig.exportChannel,
      envelopeType:  c.contract?.envelope?.trim().toLowerCase() || "plain",
    };
  } catch (_) {
    return { targetChannel: redisConfig.exportChannel, envelopeType: "plain" };
  }
}

// ── Safe publish ───────────────────────────────────────────
async function safePublish(channel, payload) {
  if (!redisClient?.isOpen) {
    log(`[class2] Redis no conectado — no se publica a ${channel}`, "WARN");
    return false;
  }
  try {
    const envelope = (payload?.id && payload?.source && payload?.ts)
      ? payload
      : {
          id:     crypto.randomUUID(),
          source: "class2",
          type:   "vectoidea",
          ts:     new Date().toISOString(),
          ...payload
        };
    await redisClient.publish(channel, JSON.stringify(envelope));
    return true;
  } catch (e) {
    log(`[class2] Error publicando a ${channel}: ${e.message}`, "WARN");
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// EXTRACCIÓN DE TEXTO
// ══════════════════════════════════════════════════════════

async function extractPagesWithPdfjs(buffer) {
  const pages      = [];
  const loadingTask = pdfjsLib.getDocument({
    data:            new Uint8Array(buffer),
    useSystemFonts:  true,
    disableFontFace: true,
    verbosity:       0,
  });
  const doc      = await loadingTask.promise;
  const numPages = doc.numPages || 0;

  for (let i = 1; i <= numPages; i++) {
    try {
      const page    = await doc.getPage(i);
      const content = await page.getTextContent({ disableCombineTextItems: false });
      const text    = content.items.map(item => item?.str || "").join(" ")
        .replace(/\s+/g, " ").trim();
      pages.push(text);
    } catch (e) {
      log(`[class2] Error página ${i}: ${e.message}`, "WARN");
      pages.push("");
    }
  }
  try { await doc.destroy(); } catch (_) {}
  return pages;
}

async function extractPages(buffer) {
  try {
    return await extractPagesWithPdfjs(buffer);
  } catch (_) {
    log("[class2] pdfjs falló → usando pdf-parse", "WARN");
    try {
      const result = await pdf(buffer);
      const texto  = (result?.text || "")
        .replace(/\0/g, "")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .trim();
      return texto ? [texto] : [];
    } catch (e) {
      log("[class2] pdf-parse también falló", "ERROR");
      return [];
    }
  }
}

async function extractTextFromDocxBuffer(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || "";
}

// ══════════════════════════════════════════════════════════
// PERSISTENCIA MYSQL
// Guarda PDF completo + fragmentos en la BD
// ══════════════════════════════════════════════════════════

async function persistirEnMySQL(filePath, textoCompleto) {
  const mysqlOk = await cargarClass42();
  if (!mysqlOk) return null;

  try {
    const nombre      = path.basename(filePath);
    const tipo        = detectarTipoPDF(filePath);
    const hashSha256  = crypto.createHash("sha256").update(textoCompleto).digest("hex");
    let   tamanio     = null;

    try { tamanio = fs.statSync(filePath).size; } catch (_) {}

    // ── Paso 1: guardar PDF completo en pdf_documents ─────
    const pdfId = await _guardarPDF({
      nombre,
      tipo,
      fuente:           `file://${filePath}`,
      fecha_documento:  null,
      texto_completo:   textoCompleto,
      tamanio_bytes:    tamanio,
      hash_sha256:      hashSha256,
    });

    if (!pdfId) {
      log(`[class2] ⚠️ PDF ya existe o error en MySQL: ${nombre}`, "WARN");
      return null;
    }

    log(`[class2] 💾 PDF guardado en MySQL: ${nombre} (id=${pdfId}, tipo=${tipo})`);

    // ── Paso 2: dividir y guardar fragmentos ──────────────
    const fragmentos = dividirEnFragmentos(textoCompleto, TOKENS_POR_FRAGMENTO);
    let fragmentosGuardados = 0;

    for (let i = 0; i < fragmentos.length; i++) {
      const numTokens = fragmentos[i].split(/\s+/).length;
      const fid = await _guardarFragmento({
        pdf_id:           pdfId,
        numero_fragmento: i + 1,
        texto:            fragmentos[i],
        num_tokens:       numTokens,
      });
      if (fid) fragmentosGuardados++;
    }

    log(`[class2] 📝 ${fragmentosGuardados}/${fragmentos.length} fragmentos guardados (PDF id=${pdfId})`);
    return pdfId;

  } catch (e) {
    log(`[class2] ❌ Error persistiendo en MySQL: ${e.message}`, "ERROR");
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// PDF READER PRINCIPAL
// ══════════════════════════════════════════════════════════

class PDFReader {
  constructor() {
    this.metrics = { inicio: Date.now(), procesados: 0, errores: 0, enMySQL: 0 };
  }

  async init() {
    try {
      fs.mkdirSync(PDF_BASE_DIR, { recursive: true });
      log(`[class2] Carpeta PDF lista: ${PDF_BASE_DIR}`);
      return true;
    } catch (e) {
      log(`[class2] init error: ${e.message}`, "ERROR");
      return false;
    }
  }

  async procesarTodos() {
    const archivos = listarPDFsRecursivo(PDF_BASE_DIR);

    if (archivos.length === 0) {
      log(`[class2] ⚠️ No hay PDFs en ${PDF_BASE_DIR}`, "WARN");
      log(`[class2] Copiá PDFs a: ${PDF_BASE_DIR}`, "WARN");
      return;
    }

    log(`[class2] 📚 ${archivos.length} documentos encontrados`);

    for (const filePath of archivos) {
      log(`[class2] 📖 Procesando: ${path.basename(filePath)}`);
      try {
        await this.processDocument(filePath);
      } catch (e) {
        log(`[class2] Error en ${path.basename(filePath)}: ${e.message}`, "ERROR");
        this.metrics.errores++;
      }
      await sleep(DOCUMENT_COOLDOWN_MS);
    }

    log(`[class2] ✅ Sesión completa — ${this.metrics.procesados} procesados, ${this.metrics.enMySQL} en MySQL, ${this.metrics.errores} errores`);
    this.guardarMetricas();
  }

  async processDocument(filePath) {
    if (!fs.existsSync(filePath)) {
      log(`[class2] Archivo no existe: ${filePath}`, "WARN");
      return;
    }

    const ext    = path.extname(filePath).toLowerCase();
    const nombre = path.basename(filePath);
    let contenidoCompleto = "";

    // ── Leer el archivo ────────────────────────────────────
    let buffer;
    try {
      buffer = await fsp.readFile(filePath);
    } catch (e) {
      log(`[class2] Error leyendo archivo ${nombre}: ${e.message}`, "ERROR");
      this.metrics.errores++;
      return;
    }

    // ── Extraer texto con timeout ──────────────────────────
    const extractTask = async () => {
      if (ext === ".docx") {
        contenidoCompleto = await extractTextFromDocxBuffer(buffer);
      } else if (ext === ".pdf") {
        const pages = await extractPages(buffer);
        if (!pages?.length) {
          log(`[class2] PDF sin texto: ${nombre}`, "WARN");
          return;
        }
        contenidoCompleto = pages.join("\n\n");
      } else {
        try { contenidoCompleto = buffer.toString("utf8").trim(); }
        catch (_) { contenidoCompleto = ""; }
      }
    };

    try {
      await Promise.race([
        extractTask(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), MAX_PDF_PROCESS_TIME))
      ]);
    } catch (e) {
      log(`[class2] Timeout/error extrayendo ${nombre}: ${e.message}`, "ERROR");
      this.metrics.errores++;
      return;
    }

    // ── Limpiar texto ──────────────────────────────────────
    contenidoCompleto = String(contenidoCompleto || "")
      .replace(/\0/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim();

    if (!contenidoCompleto || contenidoCompleto.length < 50) {
      log(`[class2] Documento vacío o insuficiente: ${nombre}`, "WARN");
      return;
    }

    log(`[class2] ✅ Texto extraído: ${nombre} (${contenidoCompleto.length} chars)`);

    // ── Persistir en MySQL (NUEVO) ─────────────────────────
    const pdfId = await persistirEnMySQL(filePath, contenidoCompleto);
    if (pdfId) this.metrics.enMySQL++;

    // ── Publicar en Redis para vectorización .NET ──────────
    const { targetChannel } = leerContrato();

    const envelope = {
      id:     crypto.randomUUID(),
      source: "class2",
      type:   "vectoidea",
      texto:  contenidoCompleto.slice(0, 10_000),  // campo DSL estándar
      text:   contenidoCompleto.slice(0, 10_000),  // compatibilidad
      data: {
        document: nombre,
        ext,
        size:     contenidoCompleto.length,
        pdfId,                                     // referencia al id MySQL
        tipo:     detectarTipoPDF(filePath),
      },
      ts: new Date().toISOString(),
    };

    const ok = await safePublish(targetChannel, envelope);

    if (ok) {
      log(`[class2] 📤 Publicado → ${targetChannel}: ${nombre}`);
      this.metrics.procesados++;

      // Marcar como procesado en MySQL
      if (pdfId && _marcarProcesado) {
        await _marcarProcesado(pdfId).catch(() => {});
      }
    }
  }

  guardarMetricas() {
    try {
      const uptime = ((Date.now() - this.metrics.inicio) / 60000).toFixed(1);
      const status = {
        timestamp:   new Date().toISOString(),
        uptimeMin:   uptime,
        procesados:  this.metrics.procesados,
        enMySQL:     this.metrics.enMySQL,
        errores:     this.metrics.errores,
        carpetaPDF:  PDF_BASE_DIR,
      };
      fs.writeFileSync(path.join(METRICS_DIR, "class2_health.json"), JSON.stringify(status, null, 2));
    } catch (_) {}
  }
}

// ── Listar PDFs recursivamente ─────────────────────────────
function listarPDFsRecursivo(dir) {
  let pdfs = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pdfs = pdfs.concat(listarPDFsRecursivo(fullPath));
      } else if (entry.isFile()) {
        const n = entry.name.toLowerCase();
        if (n.endsWith(".pdf") || n.endsWith(".docx")) pdfs.push(fullPath);
      }
    }
  } catch (e) {
    log(`[class2] Error leyendo ${dir}: ${e.message}`, "WARN");
  }
  return pdfs;
}

// ══════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════

let lector = null;
let procesandoActualmente = false;  // evita procesamiento simultáneo

async function iniciarRedis() {
  try {
    redisClient = createClient({ url: redisConfig.url });
    redisClient.on("error", e => log(`[class2] Redis error: ${e.message}`, "ERROR"));
    await redisClient.connect();

    redisSubscriber = createClient({ url: redisConfig.url });
    redisSubscriber.on("error", e => log(`[class2] RedisSub error: ${e.message}`, "ERROR"));
    await redisSubscriber.connect();

    log("[class2] ✅ Redis conectado");

    // ── Canal 1: trigger de procesamiento ─────────────────
    // Lanza un ciclo completo de todos los PDFs
    // Publicar: redis.publish("class2_trigger", "start")
    await redisSubscriber.subscribe(TRIGGER_CHANNEL, async (message) => {
      if (procesandoActualmente) {
        log("[class2] Ya procesando — trigger ignorado");
        return;
      }
      procesandoActualmente = true;
      log(`[class2] 🔔 Trigger recibido → procesando todos los PDFs`);
      try {
        await lector.procesarTodos();
      } finally {
        procesandoActualmente = false;
      }
    });

    // ── Canal 2: procesar un PDF específico desde la web ───
    // Publicar: redis.publish("class2_pdf_cmd", JSON.stringify({
    //   accion: "procesar",
    //   archivo: "crisis_historica/gran_depresion_1929.pdf"  // relativo a PDF_BASE_DIR
    // }))
    await redisSubscriber.subscribe(USER_PDF_CHANNEL, async (message) => {
      try {
        const cmd = JSON.parse(message);
        if (cmd.accion === "procesar" && cmd.archivo) {
          const fullPath = path.join(PDF_BASE_DIR, cmd.archivo);
          log(`[class2] 📄 Procesando PDF específico: ${cmd.archivo}`);
          await lector.processDocument(fullPath);
        } else if (cmd.accion === "listar") {
          const archivos = listarPDFsRecursivo(PDF_BASE_DIR)
            .map(f => path.relative(PDF_BASE_DIR, f));
          if (redisClient.isOpen) {
            await redisClient.publish("class2_pdf_response", JSON.stringify({
              ok: true,
              archivos,
              total:      archivos.length,
              carpetaBase: PDF_BASE_DIR,
              ts: new Date().toISOString(),
            }));
          }
        }
      } catch (e) {
        log(`[class2] Error procesando comando PDF: ${e.message}`, "ERROR");
      }
    });

    log(`[class2] 📡 Escuchando: ${TRIGGER_CHANNEL}, ${USER_PDF_CHANNEL}`);
    log(`[class2] 📤 Publicando en: ${redisConfig.exportChannel}`);
    log(`[class2] 📁 PDFs en: ${PDF_BASE_DIR}`);

  } catch (e) {
    log(`[class2] Error iniciando Redis: ${e.message}`, "ERROR");
  }
}

// ── Publicar JSON semánticos ───────────────────────────────
const JSON_SEMANTICOS_DIR = path.resolve(process.cwd(), "operador", "aprendizaje", "json_semanticos");

async function publicarJsonSemanticos() {
  try {
    if (!fs.existsSync(JSON_SEMANTICOS_DIR)) return;
    const files = fs.readdirSync(JSON_SEMANTICOS_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw  = await fsp.readFile(path.join(JSON_SEMANTICOS_DIR, f), "utf8");
        const data = JSON.parse(raw);
        await safePublish(redisConfig.exportChannel, {
          id:     crypto.randomUUID(),
          source: "class2",
          type:   "semantic_fact",
          texto:  data.text || data.resumen || data.titulo || JSON.stringify(data).slice(0, 500),
          text:   data.text || data.resumen || "",
          data:   { file: f },
          ts:     new Date().toISOString(),
        });
        await sleep(500);
      } catch (e) {
        log(`[class2] JSON inválido: ${f} — ${e.message}`, "WARN");
      }
    }
  } catch (e) {
    log(`[class2] Error publicando JSON semánticos: ${e.message}`, "ERROR");
  }
}

// ── Crash handlers ─────────────────────────────────────────
process.on("uncaughtException",  e => log(`uncaughtException: ${e.message}`,  "FATAL"));
process.on("unhandledRejection", e => log(`unhandledRejection: ${String(e)}`, "FATAL"));

process.on("SIGINT", async () => {
  log("[class2] Cerrando...", "INFO");
  try { if (redisClient?.isOpen)     await redisClient.quit(); }     catch (_) {}
  try { if (redisSubscriber?.isOpen) await redisSubscriber.quit(); } catch (_) {}
  process.exit(0);
});

// ── Arranque ───────────────────────────────────────────────
(async () => {
  try {
    log("=== Iniciando class2 — Buffer Documental MIIA ===");
    log(`[class2] 📁 Carpeta de PDFs: ${PDF_BASE_DIR}`);
    log(`[class2] Para agregar PDFs: copiá archivos a esa carpeta y enviá trigger`);

    lector = new PDFReader();
    const initOk = await lector.init();
    if (!initOk) { log("[class2] ❌ Fallo init() del lector", "FATAL"); return; }

    await iniciarRedis();
    await cargarClass42();

    // Métricas periódicas
    setInterval(() => lector.guardarMetricas(),       60_000).unref();
    setInterval(() => publicarJsonSemanticos(),        30_000).unref();

    log("[class2] ✅ Listo. Esperando trigger en class2_trigger");
  } catch (e) {
    log(`[class2] Error crítico: ${e.message}`, "FATAL");
  }
})();

// ── leerYProcesarPDF — exportada para class4 ──────────────
export async function leerYProcesarPDF(input) {
  try {
    const buffer = typeof input === "string"
      ? await fsp.readFile(input)
      : input;
    const pages  = await extractPages(buffer);
    const sample = pages.slice(0, 3).join("\n\n").trim();
    return Array.isArray(sample.split("\n"))
      ? [{ nombreArchivo: typeof input === "string" ? path.basename(input) : "buffer", texto: sample }]
      : [];
  } catch (e) {
    log(`[class2] leerYProcesarPDF error: ${e.message}`, "ERROR");
    return [];
  }
}

export { PDFReader, lector, listarPDFsRecursivo, publicarJsonSemanticos };