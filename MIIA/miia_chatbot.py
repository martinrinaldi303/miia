# ============================================================
# miia_chatbot.py — MIIA Botchat v3.0
# ============================================================
# REEMPLAZA: app.py, MotorLenguaje.py, modulo_de_control.py
#
# PÁGINAS:
#   /           → Chat + Dashboard de mercado (usuarios)
#   /admin      → Panel admin (requiere contraseña)
#   /admin/login→ POST auth admin
#
# DASHBOARD USUARIO:
#   - Datos de mercado por sector con % (no decimales)
#   - Tasa de aciertos histórica de class43
#   - Últimas señales BUY/SELL/HOLD
#   - Chat con MIIA en tiempo real
#
# PANEL ADMIN:
#   - Usuarios en línea ahora
#   - Tasa de consultas / hora
#   - Mapa mundial de conexiones
#   - Tabla de clientes con país, ciudad, plan
#   - Tabla 'clientes' en MySQL
#
# ARRANQUE:
#   uvicorn miia_chatbot:app --host 0.0.0.0 --port 5005
#
# DEPENDENCIAS:
#   pip install fastapi uvicorn redis pyjwt aiomysql httpx python-multipart
# ============================================================

import os, re, json, uuid, asyncio, logging, time, hashlib, hmac, math, warnings, sys, urllib.parse
import datetime as _dt
from decimal import Decimal
warnings.filterwarnings("ignore", category=DeprecationWarning)

def _jsonable(obj):
    """Convierte tipos no serializables (Decimal, datetime, date) a primitivos JSON."""
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return str(obj)
    return obj

# Fix encoding: stdout/stderr en Windows usa cp1252 por defecto → emojis rompen el log
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timedelta
from pathlib  import Path
from typing   import Optional
from collections import defaultdict, deque

import redis.asyncio as aioredis
import aiomysql
import httpx
from contextlib import asynccontextmanager
from fastapi import (FastAPI, WebSocket, WebSocketDisconnect,
                     HTTPException, Request, Depends, Form, Cookie)
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
# FUENTE ÚNICA del universo (21-sep-2026). Ver MIIA/universo.py: la lista
# estaba copiada a mano en más de diez lugares y había drifteado.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from universo import TICKERS as _UNIVERSO, TICKERS_TEXTO as _UNIVERSO_TEXTO

# chat_contexto: lógica pura del relay de chat (foco por ticker + correlación de
# la respuesta). Import DEFENSIVO a propósito: es un archivo NUEVO y si no se sube
# al server, miia_chatbot NO debe caer como el 28-sep con `universo` — degrada al
# comportamiento viejo (sin foco, acepta el primer INFO) y lo dice en el log.
try:
    from chat_contexto import tickers_en_texto, filtrar_por_ticker, clasificar_salida
except Exception as _e_cc:
    logging.getLogger("miia").warning(
        f"chat_contexto no disponible ({_e_cc}); chat sin foco por ticker ni correlación")
    def tickers_en_texto(texto, universo):
        return []
    def filtrar_por_ticker(mapa, tickers, tope=12):
        return mapa if isinstance(mapa, dict) else {}
    def clasificar_salida(data, *, user_id="", sesion=""):
        if not isinstance(data, dict) or data.get("source") != "class25B":
            return "ignorar"
        senal = data.get("senal", "")
        texto = data.get("texto") or data.get("decision") or ""
        return "mia" if (senal in ("INFO", "") and texto) else "ignorar"
# Aparte: si en el server queda un chat_contexto.py VIEJO (sin esta función), el
# import de arriba no debe caerse entero — el chat sólo pierde el portafolio.
try:
    from chat_contexto import portfolio_del_navegador
except Exception:
    def portfolio_del_navegador(raw, max_activos=12):
        return None
import rank_ic

import jwt as pyjwt

# ── Paths ───────────────────────────────────────────────────
BASE_DIR  = Path(__file__).parent
ROOT_DIR  = BASE_DIR.parent
LOG_DIR   = ROOT_DIR / "operador" / "aprendizaje" / "logs"
PUBLI_DIR = ROOT_DIR / "scripts" / "publi"    # index.html unificado
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Carga de .env (credenciales fuera del código) ───────────
# Mismo archivo que carga class38.js para los motores Node.
# No pisa variables ya presentes en el entorno.
def _cargar_dotenv():
    env_path = ROOT_DIR / "operador" / "aprendizaje" / "config" / ".env"
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if not t or t.startswith("#") or "=" not in t:
                continue
            k, _, v = t.partition("=")
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            if not os.getenv(k):
                os.environ[k] = v
    except Exception as e:
        print(f"[BOTCHAT] .env no cargado: {e}")

_cargar_dotenv()

# ── Config ─────────────────────────────────────────────────
REDIS_URL      = os.getenv("REDIS_URL",      "redis://localhost:6379")
PORT           = int(os.getenv("PY_PORT",    "5005"))
# JWT_SECRET — SIN fallback. (30-ago-2026)
#
# Tenía por defecto "miia-jwt-secret-cambiar-en-produccion", el mismo string
# que estaba en class14.js y en este archivo, o sea público para cualquiera con
# acceso al código. Con esa clave se podía:
#   · firmar un JWT de usuario arbitrario (get_current_user lo acepta), y
#   · derivar ADMIN_TOKEN_SECRET = JWT_SECRET + "-admin" y fabricar la cookie
#     de admin, que además no expiraba.
#
# Un default que "funciona" es peor que uno que falla: nadie se entera de que
# está corriendo con la clave pública. Ahora el proceso no arranca sin ella.
JWT_SECRET = os.getenv("JWT_SECRET", "").strip()
if not JWT_SECRET or len(JWT_SECRET) < 32:
    raise RuntimeError(
        "JWT_SECRET no configurado (o menor a 32 caracteres). "
        "Generar con: openssl rand -hex 32 — y exportarlo antes de arrancar."
    )
OAUTH_BASE_URL = os.getenv("OAUTH_BASE_URL", "https://localhost:8443")
MIIA_ENV       = os.getenv("MIIA_ENV",       "local")

DB_HOST        = os.getenv("DB_HOST",   "localhost")
DB_PORT        = int(os.getenv("DB_PORT", "3306"))
DB_USER        = os.getenv("DB_USER",   "root")
DB_PASS        = os.getenv("DB_PASS",   "")
DB_NAME        = os.getenv("DB_NAME",   "miia_cognitiva")

# Admin — contraseña SOLO desde config/.env (ADMIN_PASSWORD).
# Sin ADMIN_PASSWORD configurada, el login admin queda DESACTIVADO
# (hash None nunca coincide) — evita que el hash de "" permita entrar.
_admin_pass = os.getenv("ADMIN_PASSWORD", "")
# Hash con sal y PBKDF2 (antes era SHA-256 sin sal). La sal se genera en cada
# arranque: el hash vive sólo en memoria, así que no hay que migrar nada ni tocar
# el .env. compare_digest evita comparar en tiempo variable.
_ADMIN_SAL = os.urandom(16)
def _hash_admin(clave: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", clave.encode(), _ADMIN_SAL, 200_000)
ADMIN_PASSWORD_HASH = _hash_admin(_admin_pass) if _admin_pass else None
ADMIN_TOKEN_SECRET  = JWT_SECRET + "-admin"

# Cuenta maestra administradora del sitio web (basada en email de Google).
# Es la única que ve AI Engines, el flujo en tiempo real, usuarios y recursos.
# Puede delegar en otros admins (tabla miia_admins).
ADMIN_MASTER_EMAIL  = os.getenv("ADMIN_MASTER_EMAIL", "admin@example.com")

# Mercado Pago
MP_ACCESS_TOKEN     = os.getenv("MP_ACCESS_TOKEN", "").strip()
MP_PUBLIC_KEY       = os.getenv("MP_PUBLIC_KEY", "").strip()

# Marca de arranque del proceso (uptime del panel admin)
_PROCESS_START      = time.time()

# Redis Channels
CH_INPUT   = "class25_ingest"
CH_OUTPUT  = "class25_output"
CH_STREAM  = "ui_stream"
CH_25A     = "class25a_output"
CH_7       = "class7_output"
CH_43      = "class43_output"
CH_LSTM    = "class44_output"    # señales LSTM (class44.py)
CH_SENT    = "class45_output"    # sentimiento noticias (class45.js)

# ── Logger ─────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
    format="[%(asctime)s] [BOTCHAT] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("miia")

# ── Errores de endpoint a archivo ───────────────────────────
# En producción los logs de pm2 están desactivados (llenan memoria), así que
# stdout se pierde. Sin esto, una excepción en un endpoint es invisible: el
# endpoint devuelve estado:"error" y no queda rastro de POR QUÉ.
ERR_LOG = os.getenv(
    "MIIA_ERR_LOG",
    "/opt/miia/operador/aprendizaje/logs/miia_chatbot_errores.log",
)

def _log_error_endpoint(nombre: str, exc: Exception) -> None:
    """Registra el traceback completo, sin volver a lanzar si el logueo falla."""
    import traceback as _tb
    detalle = _tb.format_exc()
    log.warning(f"{nombre}: {type(exc).__name__}: {exc}")
    try:
        os.makedirs(os.path.dirname(ERR_LOG), exist_ok=True)
        with open(ERR_LOG, "a", encoding="utf-8") as fh:
            # _dt = datetime módulo (línea 32); `datetime` a secas es la CLASE
            fh.write(f"\n{'='*70}\n[{_dt.datetime.now().isoformat()}] {nombre}\n{detalle}")
    except Exception:
        pass   # nunca romper el request por no poder escribir el log

# ── FastAPI ─────────────────────────────────────────────────
@asynccontextmanager
async def _lifespan(app: FastAPI):
    # ── startup ──────────────────────────────────────────────
    log.info("🚀 MIIA Botchat v3.0 iniciando...")
    try:
        r = await get_redis(); await r.ping()
        log.info("✅ Redis OK")
    except Exception as e:
        log.error(f"❌ Redis: {e}")
    await init_tables()
    asyncio.create_task(redis_listener())
    asyncio.create_task(admin_broadcaster())
    log.info(f"✅ Listo en puerto {PORT}")
    yield
    # ── shutdown ─────────────────────────────────────────────
    global _redis, _db_pool
    if _redis:   await _redis.close()
    if _db_pool: _db_pool.close(); await _db_pool.wait_closed()

app = FastAPI(title="MIIA Botchat v3", docs_url=None, redoc_url=None,
              lifespan=_lifespan)
app.add_middleware(GZipMiddleware)

# ── CORS ────────────────────────────────────────────────────
# En producción el frontend se sirve same-origin (a través del gateway
# class30 en https://miiaia.com), así que no necesita CORS abierto.
# - CORS_ORIGINS="https://miiaia.com,https://www.miiaia.com" → allowlist exacta.
# - Sin CORS_ORIGINS: en local (MIIA_ENV=local) se permite "*" para el
#   desarrollo; en producción se restringe a PUBLIC_BASE_URL (o se bloquea
#   cross-origin si tampoco está definido).
def _resolve_cors_origins():
    raw = os.getenv("CORS_ORIGINS", "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    if MIIA_ENV == "local":
        return ["*"]
    pub = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    return [pub] if pub else []

_ALLOWED_ORIGINS = _resolve_cors_origins()
log.info(f"CORS origins permitidos: {_ALLOWED_ORIGINS or '(ninguno — cross-origin bloqueado)'}")
app.add_middleware(CORSMiddleware, allow_origins=_ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])

# ── Rate limiting por IP (en memoria, ventana deslizante) ────
# /api/ask y /api/chat: 10 req/min (consumen cuota de Gemini)
# resto de /api/*:      120 req/min (polling legítimo del dashboard)
# La IP real llega en X-Forwarded-For (class30 la propaga al proxear).
_rl_buckets: dict = {}

@app.middleware("http")
async def _rate_limit_mw(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/"):
        ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()
              or (request.client.host if request.client else "?"))
        es_chat = path in ("/api/ask", "/api/chat")
        clave   = f"{'chat' if es_chat else 'api'}:{ip}"
        max_req = 10 if es_chat else 120
        now = time.time()
        ts = _rl_buckets.setdefault(clave, deque())
        while ts and now - ts[0] > 60:
            ts.popleft()
        if len(ts) >= max_req:
            return JSONResponse(
                {"error": "Demasiadas solicitudes. Esperá un momento e intentá de nuevo.",
                 "retry_after_s": 30}, status_code=429)
        ts.append(now)
        # Limpieza ocasional del dict para que no crezca sin límite
        if len(_rl_buckets) > 5000:
            for k in [k for k, v in _rl_buckets.items() if not v or now - v[-1] > 600]:
                _rl_buckets.pop(k, None)
    return await call_next(request)

# ── Redis ───────────────────────────────────────────────────
_redis: Optional[aioredis.Redis] = None
async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, encoding="utf-8",
            decode_responses=True, socket_connect_timeout=5,
            retry_on_timeout=True)
    return _redis

# ── MySQL pool ──────────────────────────────────────────────
_db_pool: Optional[aiomysql.Pool] = None
async def get_db() -> Optional[aiomysql.Pool]:
    global _db_pool
    if _db_pool is None:
        try:
            # PyMySQL codifica la contraseña en latin-1; el hash del usuario se
            # creó con bytes UTF-8 (la contraseña tiene "ñ"). Re-decodificar los
            # bytes UTF-8 como latin-1 hace que PyMySQL envíe los bytes correctos.
            # Para contraseñas ASCII es una transformación identidad (inofensiva).
            _pw = DB_PASS.encode("utf-8").decode("latin1")
            _db_pool = await aiomysql.create_pool(
                host=DB_HOST, port=DB_PORT, user=DB_USER,
                password=_pw, db=DB_NAME,
                charset="utf8mb4", autocommit=True,
                minsize=1, maxsize=20)
        except Exception as e:
            log.warning(f"MySQL no disponible: {e}")
    return _db_pool

async def db_exec(sql: str, params: tuple = ()):
    p = await get_db()
    if not p: return None
    async with p.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            # `params or None`, NO `params`: aiomysql aplica `sql % args` siempre
            # que args no sea None, y una tupla vacía NO es None. Con `()` el
            # driver intentaba formatear el SQL y cualquier % LITERAL explotaba
            # antes de llegar a MySQL — rompía `LIKE 'class%'` y los comentarios
            # que mencionan porcentajes. Fallaba en silencio (5 queries, entre
            # ellas signal_breakdown, que por eso volvía siempre vacío).
            await cur.execute(sql, params or None)
            if sql.strip().upper().startswith("SELECT"):
                return await cur.fetchall()
            return cur.lastrowid

async def init_tables():
    """Crear tabla clientes si no existe."""
    await db_exec("SET SESSION sql_notes = 0")   # silencia el "Table already exists" note
    await db_exec("""
        CREATE TABLE IF NOT EXISTS clientes (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            session_id      VARCHAR(50),
            user_id         VARCHAR(100),
            ip              VARCHAR(45),
            pais            VARCHAR(100),
            pais_code       VARCHAR(5),
            ciudad          VARCHAR(100),
            region          VARCHAR(100),
            lat             FLOAT,
            lon             FLOAT,
            user_agent      VARCHAR(500),
            plan            VARCHAR(20) DEFAULT 'free',
            primera_visita  DATETIME(3) DEFAULT NOW(3),
            ultima_visita   DATETIME(3) DEFAULT NOW(3),
            total_consultas INT DEFAULT 0,
            INDEX idx_ip    (ip),
            INDEX idx_pais  (pais),
            INDEX idx_ts    (ultima_visita)
        )
    """)
    # ── Admins (email-based; cuenta maestra + delegados) ───────
    await db_exec("""
        CREATE TABLE IF NOT EXISTS miia_admins (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            email      VARCHAR(200) NOT NULL UNIQUE,
            added_by   VARCHAR(200),
            created_at DATETIME DEFAULT NOW()
        )
    """)
    await db_exec(
        "INSERT IGNORE INTO miia_admins (email, added_by) VALUES (%s, 'sistema')",
        (ADMIN_MASTER_EMAIL,))
    # ── Usuarios del sitio web (tracking + ban) ────────────────
    await db_exec("""
        CREATE TABLE IF NOT EXISTS miia_users (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            user_id    VARCHAR(100) NOT NULL UNIQUE,
            email      VARCHAR(200),
            nombre     VARCHAR(200),
            status     ENUM('active','banned') DEFAULT 'active',
            consultas  INT DEFAULT 0,
            last_seen  DATETIME,
            created_at DATETIME DEFAULT NOW(),
            INDEX idx_status (status)
        )
    """)
    # ── Suscripciones (Mercado Pago) ───────────────────────────
    # Tabla propia (miia_subscriptions) para NO chocar con la tabla legacy
    # `subscriptions` que tiene otro esquema (plan free/pro/enterprise).
    await db_exec("""
        CREATE TABLE IF NOT EXISTS miia_subscriptions (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            user_id          VARCHAR(100) NOT NULL,
            email            VARCHAR(200),
            plan             ENUM('monthly','annual') NOT NULL DEFAULT 'monthly',
            status           ENUM('pending','active','cancelled','expired') DEFAULT 'pending',
            mp_preference_id VARCHAR(200),
            mp_payment_id    VARCHAR(200),
            expires_at       DATETIME,
            created_at       DATETIME DEFAULT NOW(),
            INDEX idx_uid_status   (user_id, status),
            INDEX idx_email_status (email, status)
        )
    """)

# ── WebSocket manager ───────────────────────────────────────
class WsManager:
    def __init__(self):
        self.users:  list[WebSocket] = []
        self.admins: list[WebSocket] = []
        self.lock = asyncio.Lock()
        # Métricas en tiempo real
        self.consultas_por_hora: deque = deque(maxlen=60)
        self.consultas_ultima_hora = 0
        self._hora_actual = datetime.utcnow().hour

    async def connect(self, ws: WebSocket, tipo: str = "user"):
        await ws.accept()
        async with self.lock:
            if tipo == "admin":
                self.admins.append(ws)
            else:
                self.users.append(ws)

    async def disconnect(self, ws: WebSocket):
        async with self.lock:
            self.users  = [c for c in self.users  if c is not ws]
            self.admins = [c for c in self.admins if c is not ws]

    async def broadcast_users(self, msg: dict):
        text = json.dumps(msg, ensure_ascii=False)
        async with self.lock:
            dead = []
            for ws in self.users:
                try:    await ws.send_text(text)
                except: dead.append(ws)
            for ws in dead:
                self.users = [c for c in self.users if c is not ws]

    async def broadcast_admins(self, msg: dict):
        text = json.dumps(msg, ensure_ascii=False)
        async with self.lock:
            dead = []
            for ws in self.admins:
                try:    await ws.send_text(text)
                except: dead.append(ws)
            for ws in dead:
                self.admins = [c for c in self.admins if c is not ws]

    async def broadcast_all(self, msg: dict):
        await self.broadcast_users(msg)
        await self.broadcast_admins(msg)

    def registrar_consulta(self):
        self.consultas_ultima_hora += 1
        h = datetime.utcnow().hour
        if h != self._hora_actual:
            self.consultas_por_hora.append(self.consultas_ultima_hora)
            self.consultas_ultima_hora = 0
            self._hora_actual = h

ws_manager = WsManager()

# ── Estado del sistema ──────────────────────────────────────
estado = {
    # Mercado (de class7_output)
    "sectores":    {},
    "riesgo_pct":  50,
    "ts_mercado":  None,

    # Accuracy (de class43 vía ui_stream)
    "accuracy_global": 0.0,
    "accuracy_30d":    0.0,
    "total_decisiones": 0,
    "pendientes":       0,
    "sharpe":           0.0,
    "ts_accuracy":     None,

    # Señales recientes
    "ultimas_senales": [],
    "ultima_senal":    None,

    # Portfolio actual (de MySQL via class15/class17)
    "portfolio_actual": None,   # dict con activos y pesos
    "ts_portfolio":     None,
}

historial_decisiones: list = []

# ── Geolocalización IP ──────────────────────────────────────
geo_cache: dict = {}

async def geolocate(ip: str) -> dict:
    if ip in ("127.0.0.1", "localhost", "::1", "testclient"):
        return {"country": "Argentina", "countryCode": "AR",
                "city": "Córdoba", "regionName": "Córdoba",
                "lat": -31.4, "lon": -64.18}
    if ip in geo_cache:
        return geo_cache[ip]
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(
                f"http://ip-api.com/json/{ip}"
                f"?fields=country,countryCode,city,regionName,lat,lon,status")
            data = r.json()
            if data.get("status") == "success":
                geo_cache[ip] = data
                return data
    except Exception:
        pass
    return {"country": "Desconocido", "countryCode": "XX",
            "city": "", "regionName": "", "lat": 0, "lon": 0}

async def registrar_cliente(request: Request, user_id: str = "anonimo",
                             sesion: str = "", plan: str = "free"):
    ip = request.client.host if request.client else "unknown"
    ua = request.headers.get("user-agent", "")[:500]
    geo = await geolocate(ip)
    try:
        await db_exec("""
            INSERT INTO clientes
              (session_id, user_id, ip, pais, pais_code, ciudad, region,
               lat, lon, user_agent, plan, primera_visita, ultima_visita)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(3),NOW(3))
            ON DUPLICATE KEY UPDATE
              ultima_visita   = NOW(3),
              total_consultas = total_consultas + 1,
              plan            = %s,
              user_id         = COALESCE(NULLIF(%s,'anonimo'), user_id)
        """, (sesion, user_id, ip,
              geo.get("country",""), geo.get("countryCode",""),
              geo.get("city",""), geo.get("regionName",""),
              geo.get("lat",0), geo.get("lon",0), ua, plan,
              plan, user_id))
    except Exception as e:
        log.debug(f"registrar_cliente: {e}")

# ── Redis listener ──────────────────────────────────────────
def fmt_pct(v, decimales=1) -> str:
    """Convierte decimal a porcentaje legible: 0.71 → 71.0%"""
    try:
        return f"{float(v)*100:.{decimales}f}%"
    except:
        return "—"

def fmt_change(v) -> str:
    """Formatea cambio de precio: 2.3 → +2.3% / -1.5 → -1.5%"""
    try:
        f = float(v)
        sign = "+" if f >= 0 else ""
        return f"{sign}{f:.1f}%"
    except:
        return "—"

def formatear_decision(data: dict) -> dict:
    senal    = data.get("senal", "HOLD")
    ticker   = data.get("ticker", "GENERAL")
    conf     = float(data.get("confianza", 0))
    riesgo   = float(data.get("riesgo", 0.5))
    horizonte= data.get("horizonte", "48h")
    stop     = float(data.get("stop_loss", 0.03))
    texto    = data.get("texto", data.get("decision", ""))
    ts       = data.get("ts", datetime.utcnow().isoformat())
    emoji    = {"BUY":"🟢","SELL":"🔴","HOLD":"🟡"}.get(senal,"⚪")
    return {
        "id":          data.get("id", str(uuid.uuid4())),
        "ts":          ts,
        "senal":       senal,
        "ticker":      ticker,
        "emoji":       emoji,
        "conf_pct":    fmt_pct(conf),           # "71%"
        "riesgo_pct":  fmt_pct(riesgo),         # "31%"
        "stop_pct":    fmt_pct(stop),           # "3%"
        "horizonte":   horizonte,
        "texto":       texto,
        "confianza":   round(conf, 3),
        "riesgo":      round(riesgo, 3),
        "resumen":     f"{emoji} {senal} {ticker} | {fmt_pct(conf)} confianza | riesgo {fmt_pct(riesgo)}",
    }

async def redis_listener():
    while True:
        try:
            r   = await get_redis()
            pub = r.pubsub()
            await pub.subscribe(CH_OUTPUT, CH_STREAM, CH_25A, CH_7, "class25B_alerts",
                                CH_LSTM, CH_SENT)
            log.info("Redis listener activo")
            async for msg in pub.listen():
                if msg["type"] != "message": continue
                ch = msg["channel"]
                try:
                    data = json.loads(msg["data"])
                except:
                    continue
                try:
                    # ── Decisión lingüística de class25B ──────────────────
                    if ch == CH_OUTPUT:
                        # ── RESPONSABILIDADES ÚNICAS (sin duplicación) ─────
                        # class25B → ÚNICO procesador de chat vía Redis
                        # Python /api/ask → relay HTTP que espera respuesta de class25B
                        # Este redis_listener → solo broadcast de señales de mercado (BUY/SELL/HOLD)
                        #                       NO rebroadcastea respuestas conversacionales
                        #                       (esas ya llegan por HTTP al usuario que preguntó)
                        senal_resp = data.get("senal", "")
                        tipo_resp  = data.get("type", data.get("tipo", ""))
                        es_chat    = senal_resp in ("INFO", "") and tipo_resp in ("respuesta", "")

                        # Guardar en historial interno (para /api/historial, /api/accuracy)
                        if not es_chat:
                            entry = formatear_decision(data)
                            historial_decisiones.append(entry)
                            if len(historial_decisiones) > 200:
                                historial_decisiones.pop(0)
                            estado["ultima_senal"]    = entry
                            estado["ultimas_senales"] = historial_decisiones[-10:]
                            # Solo señales de mercado BUY/SELL/HOLD van al WS de todos
                            await ws_manager.broadcast_all(
                                {"tipo": "decision", "payload": entry})
                        # es_chat=True → la respuesta ya fue entregada por HTTP /api/ask
                        # No hacer nada más: evita duplicados en el browser

                    # ── Heartbeats y métricas (ui_stream) ─────────────────
                    elif ch == "class25B_alerts":
                        # Alerta de crisis — enviar a todos los WebSocket inmediatamente
                        nivel = data.get("nivel", "ATENCION")
                        log.warning(f"🚨 ALERTA [{nivel}]: {data.get('titulo','')}")
                        await ws_manager.broadcast_all({
                            "tipo":    "alerta",
                            "payload": data
                        })

                    elif ch == CH_STREAM:
                        tipo = data.get("type", "")

                        if tipo == "flujo":
                            # Tick del panel de Flujo Cognitivo que agrega
                            # class30 (1/s). Se reenvia tal cual: el panel lee
                            # `payload` y anima el caudal real de mensajes.
                            #
                            # Va PRIMERO porque es el de mayor frecuencia de
                            # todo ui_stream y no necesita ningun tratamiento.
                            await ws_manager.broadcast_all({
                                "tipo":    "flujo",
                                "payload": data
                            })

                        elif tipo == "market_alert":
                            # Alerta via ui_stream
                            await ws_manager.broadcast_all({
                                "tipo":    "alerta",
                                "payload": data.get("alerta", data)
                            })

                        elif tipo == "backtesting":
                            acc_g = float(data.get("accuracy_global", 0))
                            acc_30= float(data.get("accuracy_30d",    0))
                            tot   = int(data.get("total",      0))
                            pend  = int(data.get("pendientes",  0))
                            estado.update({
                                "accuracy_global":  acc_g,
                                "accuracy_30d":     acc_30,
                                "total_decisiones": tot,
                                "pendientes":       pend,
                                "ts_accuracy":      data.get("ts"),
                            })
                            await ws_manager.broadcast_all({"tipo": "accuracy", "payload": {
                                "accuracy_global_pct": fmt_pct(acc_g),
                                "accuracy_30d_pct":    fmt_pct(acc_30),
                                "total":               tot,
                                "pendientes":          pend,
                                "accuracy_global":     acc_g,
                                "accuracy_30d":        acc_30,
                            }})

                        elif tipo in ("signal", "class25B_heartbeat"):
                            await ws_manager.broadcast_all(
                                {"tipo": "stream", "payload": data})

                    # ── Datos de mercado de class7 ─────────────────────────
                    elif ch == CH_7:
                        sectores = data.get("sectors", data.get("sector_state", []))
                        if isinstance(sectores, list) and sectores:
                            # Se parte del estado ANTERIOR en vez de un dict vacío.
                            # class7 falla cotizaciones de a ratos y por ticker, y en
                            # ese caso publica change=0 con precio=null. Al reemplazar
                            # el estado entero, una falla parcial BORRABA los valores
                            # buenos y el panel mostraba "0.00%" — indistinguible de
                            # un mercado plano. Ahora la falla se detecta por
                            # precio=null y se conserva el último dato válido.
                            nuevo = dict(estado.get("sectores") or {})
                            for s in sectores:
                                nombre = s.get("sector", "?")
                                # Cotización fallida → no pisar lo que ya teníamos.
                                if s.get("precio") is None:
                                    if nombre in nuevo:
                                        nuevo[nombre] = {**nuevo[nombre], "stale": True}
                                    continue
                                change = float(s.get("change", s.get("change_pct", 0)))
                                nuevo[nombre] = {
                                    "etf":        s.get("etf", ""),
                                    "change":     change,
                                    "change_str": fmt_change(change),
                                    "state":      s.get("state","neutral"),
                                    "score":      s.get("score", 0.5),
                                    "score_pct":  fmt_pct(s.get("score", 0.5)),
                                    "stale":      False,
                                }
                            riesgo_g = float(data.get("riesgoGlobal", 0.5))
                            estado["sectores"]   = nuevo
                            estado["riesgo_pct"] = round(riesgo_g * 100, 1)
                            estado["ts_mercado"] = data.get("ts")
                            await ws_manager.broadcast_all({"tipo": "mercado", "payload": {
                                "sectores":    nuevo,
                                "riesgo_pct":  estado["riesgo_pct"],
                                "riesgo_str":  f"{estado['riesgo_pct']}%",
                            }})

                    # ── Señal LSTM (class44) ──────────────────────────────
                    elif ch == CH_LSTM:
                        ticker  = data.get("ticker", "?")
                        señal   = data.get("señal", "?")
                        # class48 publica alertas de salud disfrazadas de señal
                        # (ticker="class44", SELL 95%) — NO son
                        # señales de mercado: no persistir, no meter en el
                        # contexto de Gemini, no retransmitir al dashboard
                        if data.get("_alerta_salud") or str(ticker).lower().startswith("class"):
                            continue
                        conf    = data.get("confianza", 0)
                        precio  = data.get("precio_actual", "–")
                        ind     = data.get("indicadores", {})
                        estado.setdefault("lstm_señales", {})[ticker] = data
                        # Persistir en lstm_predictions: la tabla existía pero
                        # nadie la escribía (0 filas) — sin registro no se puede
                        # auditar el accuracy del LSTM ni darle contexto a class25B
                        if ticker != "?" and señal in ("BUY", "SELL", "HOLD") and not data.get("_heartbeat"):
                            try:
                                await db_exec("""
                                    INSERT INTO lstm_predictions
                                        (ticker, senal, confianza, prob_buy, prob_hold, prob_sell,
                                         horizonte, precio_actual, rsi, macd, bb_pct, modelo_version, publicado)
                                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)
                                """, (ticker, señal, float(conf or 0),
                                      data.get("prob_buy"), data.get("prob_hold"), data.get("prob_sell"),
                                      data.get("horizonte", "24h"),
                                      float(precio) if precio not in (None, "–", "") else None,
                                      ind.get("rsi"), ind.get("macd"), ind.get("bb_pct"),
                                      data.get("modelo_version")))
                            except Exception as e:
                                log.debug(f"persist lstm_predictions: {e}")
                        await ws_manager.broadcast_all({
                            "tipo": "lstm_señal",
                            "payload": {
                                "ticker":    ticker,
                                "señal":     señal,
                                "confianza": conf,
                                "precio":    precio,
                                "rsi":       ind.get("rsi"),
                                "macd":      ind.get("macd"),
                                "ts":        data.get("ts"),
                            }
                        })

                    # ── Sentimiento noticias (class45) ────────────────────
                    elif ch == CH_SENT:
                        if not data.get("_heartbeat"):
                            ticker = data.get("ticker", "?")
                            estado.setdefault("sentimiento", {})[ticker] = data
                            await ws_manager.broadcast_all({
                                "tipo": "sentimiento",
                                "payload": data,
                            })

                except Exception as e:
                    log.debug(f"listener handler: {e}")
        except Exception as e:
            log.warning(f"Redis listener caído: {e} — retry 3s")
            await asyncio.sleep(3)

# ── Admin broadcast periódico ───────────────────────────────
async def admin_broadcaster():
    while True:
        await asyncio.sleep(10)
        try:
            await ws_manager.broadcast_admins({"tipo": "admin_ping", "payload": {
                "online_now":      len(ws_manager.users),
                "consultas_hora":  ws_manager.consultas_ultima_hora,
                "ts":              time.time(),
            }})
        except Exception:
            pass

# ── Auth ────────────────────────────────────────────────────
def get_current_user(request: Request) -> Optional[dict]:
    token = (request.headers.get("Authorization","").replace("Bearer ","") or
             request.query_params.get("token","") or
             request.cookies.get("miia_token",""))
    if not token: return None
    try:   return pyjwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except: return None

def verify_admin(request: Request) -> bool:
    # Solo cookie. Antes también aceptaba ?admin_token=... por query string, que
    # queda en logs de acceso, en el header Referer, en el historial del
    # navegador y en cualquier captura de pantalla del panel.
    token = request.cookies.get("miia_admin", "")
    if not token:
        return False
    try:
        # require=["exp"] hace que un token sin expiración sea RECHAZADO, no
        # aceptado por omisión — que es lo que pasaba con los emitidos antes.
        datos = pyjwt.decode(token, ADMIN_TOKEN_SECRET, algorithms=["HS256"],
                             options={"require": ["exp"]})
        return datos.get("admin") is True
    except Exception:
        return False

def make_admin_token() -> str:
    # El `hasattr(pyjwt, "sign")` de antes era SIEMPRE falso —PyJWT expone
    # `encode`, no `sign`— así que la rama con `exp` nunca corría y todos los
    # tokens de admin se emitían SIN expiración: bearers permanentes.
    return pyjwt.encode(
        {
            "admin": True,
            "iat":   datetime.utcnow(),
            "exp":   datetime.utcnow() + timedelta(hours=8),
        },
        ADMIN_TOKEN_SECRET,
        algorithm="HS256",
    )

# ── Modelos ─────────────────────────────────────────────────
class ChatMsg(BaseModel):
    mensaje:  str
    user_id:  str = "anonimo"
    sesion:   str = ""
    nombre:   str = "Usuario"

# ── Rutas ───────────────────────────────────────────────────

@app.get("/brait", response_class=HTMLResponse)
async def brait(request: Request):
    """Sirve Brait.html — interfaz conversacional inteligente de MIIA."""
    await registrar_cliente(request, user_id="anonimo", plan="free")
    brait_path = PUBLI_DIR / "Brait.html"
    if brait_path.exists():
        return FileResponse(str(brait_path))
    return HTMLResponse("<h1>Brait</h1><p>Brait.html no encontrado en scripts/publi/</p>", status_code=503)

@app.get("/ayuda.html", response_class=HTMLResponse)
@app.get("/ayuda", response_class=HTMLResponse)
async def ayuda(request: Request):
    """Sirve ayuda.html — guía completa de la interfaz de MIIA."""
    ayuda_path = PUBLI_DIR / "ayuda.html"
    if ayuda_path.exists():
        return FileResponse(str(ayuda_path))
    return HTMLResponse("<h1>Ayuda</h1><p>ayuda.html no encontrado en scripts/publi/</p>", status_code=503)

@app.get("/legal.html", response_class=HTMLResponse)
@app.get("/legal", response_class=HTMLResponse)
async def legal(request: Request):
    """Sirve legal.html — Términos, Privacidad y Aviso de Riesgo (MIIA S.A.)."""
    legal_path = PUBLI_DIR / "legal.html"
    if legal_path.exists():
        return FileResponse(str(legal_path))
    return HTMLResponse("<h1>Legal</h1><p>legal.html no encontrado en scripts/publi/</p>", status_code=503)

@app.get("/assets/{filename:path}")
async def assets(filename: str):
    """Sirve archivos estáticos (imágenes, etc.) desde scripts/publi/assets/.
    Necesario para el mapa de flujo (assets/mapa_flujo.png) y otros recursos."""
    # Evitar path traversal
    safe = os.path.normpath(filename).replace("\\", "/")
    if safe.startswith("..") or safe.startswith("/"):
        raise HTTPException(404, "No encontrado")
    fpath = PUBLI_DIR / "assets" / safe
    if fpath.exists() and fpath.is_file():
        return FileResponse(str(fpath))
    raise HTTPException(404, "No encontrado")

@app.get("/", response_class=HTMLResponse)
async def index(request: Request, token: str = ""):
    """Sirve index.html desde scripts/publi/ — interfaz unificada de MIIA."""
    await registrar_cliente(request,
        user_id = "anonimo", plan = "free")
    index_path = PUBLI_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    # Fallback si no se encuentra el archivo (nunca debería ocurrir)
    return HTMLResponse("<h1>MIIA</h1><p>index.html no encontrado en scripts/publi/</p>", status_code=503)

@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    if not verify_admin(request):
        return HTMLResponse(content=ADMIN_LOGIN_HTML)
    return HTMLResponse(content=ADMIN_DASHBOARD_HTML)

@app.post("/admin/login")
async def admin_login(password: str = Form(...)):
    if ADMIN_PASSWORD_HASH is None or not hmac.compare_digest(_hash_admin(password), ADMIN_PASSWORD_HASH):
        return HTMLResponse(content=ADMIN_LOGIN_HTML.replace(
            "<!--ERROR-->", '<p style="color:#ef4444;margin-top:8px">Contraseña incorrecta</p>'), status_code=401)
    token = make_admin_token()
    r = RedirectResponse("/admin", status_code=303)
    r.set_cookie("miia_admin", token, httponly=True, max_age=28800)
    return r

@app.post("/api/chat")
async def chat(body: ChatMsg, request: Request,
               r: aioredis.Redis = Depends(get_redis)):
    if not body.mensaje.strip():
        raise HTTPException(400, "Mensaje vacío")
    msg_id = str(uuid.uuid4())
    await r.publish(CH_INPUT, json.dumps({
        "id": msg_id, "source": "botchat", "type": "human_query",
        "text": body.mensaje.strip(), "texto": body.mensaje.strip(),
        "user_id": body.user_id, "nombre": body.nombre,
        "sesion": body.sesion, "ts": datetime.utcnow().isoformat(),
    }, ensure_ascii=False))
    ws_manager.registrar_consulta()
    await registrar_cliente(request, user_id=body.user_id,
                            sesion=body.sesion)
    return JSONResponse({"ok": True, "msg_id": msg_id})


class ChatMsgV2(BaseModel):
    mensaje:   str
    user_id:   str  = "anonimo"
    sesion:    str  = ""
    nombre:    str  = "Usuario"
    historial: list = []   # historial de conversación [{rol, txt}] para contexto MLLs

# ════════════════════════════════════════════════════════════
# ANÁLISIS ON-DEMAND DE ACTIVOS PEDIDOS EN EL CHAT
# "¿me recomendás acciones de YPF?" → detectar el activo → orquestar:
#   class7_watch    → cotización inmediata del activo
#   class1_trigger  → búsqueda de noticias del activo
#   class45_track   → sentimiento del activo (ticker dinámico)
#   class15_request → portfolio diversificado anclado en el activo
# La cotización y el portfolio se esperan unos segundos y se adjuntan a la
# respuesta del chat; noticias y sentimiento llegan al dashboard por WS.
# ════════════════════════════════════════════════════════════
_ACTIVOS_CONOCIDOS = {
    # Argentina (ADRs en NYSE)
    "ypf": "YPF", "galicia": "GGAL", "ggal": "GGAL", "pampa": "PAM",
    "banco macro": "BMA", "central puerto": "CEPU", "edenor": "EDN",
    "loma negra": "LOMA", "supervielle": "SUPV", "telecom": "TEO",
    "ternium": "TX", "tenaris": "TS", "vista": "VIST", "cresud": "CRESY",
    "mercadolibre": "MELI", "mercado libre": "MELI", "globant": "GLOB",
    "bioceres": "BIOX", "irsa": "IRS",
    # EEUU / global
    "apple": "AAPL", "tesla": "TSLA", "microsoft": "MSFT", "google": "GOOGL",
    "alphabet": "GOOGL", "amazon": "AMZN", "nvidia": "NVDA", "meta": "META",
    "netflix": "NFLX", "coca cola": "KO", "coca-cola": "KO", "ko": "KO", "disney": "DIS",
    "boeing": "BA", "intel": "INTC", "amd": "AMD", "palantir": "PLTR",
    # Cripto y commodities (proxy ETF / par USD)
    "bitcoin": "BTC-USD", "btc": "BTC-USD", "ethereum": "ETH-USD", "eth": "ETH-USD",
    "oro": "GLD", "gold": "GLD", "plata": "SLV", "petroleo": "USO", "petróleo": "USO",
    # Bonos argentinos (sin cotización en APIs de EEUU, pero se disparan
    # noticias + sentimiento igual)
    "al30": "AL30", "gd30": "GD30", "al35": "AL35", "gd35": "GD35", "ae38": "AE38",
}
_PALABRAS_INTENCION = ("recomend", "invert", "inversion", "inversión", "comprar",
    "vender", "conviene", "accion", "acción", "acciones", "bono", "bonos",
    "cedear", "etf", "analiz", "análisis", "analisis", "opin", "cotiza",
    "precio de", "como esta", "cómo está", "como anda", "cómo anda",
    "portafolio", "portfolio", "que pensas", "qué pensás", "que opinas", "qué opinás")
# Los 13 que se cotizan MÁS los que sólo se reconocen al parsear texto
# (SPY, QQQ, BTC, ETH). Esa distinción es justo la que se había perdido: esta
# lista tenía 15 símbolos y se usaba como si fueran los medibles.
_TICKERS_SISTEMA = set(_UNIVERSO_TEXTO)
_STOP_UPPER = {"MIIA", "USD", "ARS", "IA", "OK", "HOLA", "ETF", "LSTM", "API",
               "BUY", "SELL", "HOLD", "PDF", "EEUU", "USA", "NYSE", "CEO",
               "GPT", "AI", "MERVAL", "SP", "SL", "TP",
               # Palabras comunes en español que un usuario puede escribir en
               # mayúsculas — sin esto "QUE ME RECOMENDAS HOY" detectaría "QUE"
               "QUE", "PARA", "HOY", "ALGO", "COMO", "CUAL", "MEJOR", "PUEDO",
               "DEBO", "TENGO", "DIME", "DAME", "POR", "CON", "LOS", "LAS",
               "UNA", "UNO", "MAS", "BUEN", "DIA", "AHORA", "ANDA", "ESTA",
               "BIEN", "BONO", "BONOS", "PLAZO", "PESOS", "DOLAR", "AHORRO",
               "GRACIA", "TODO", "NADA", "MUY", "SI", "NO", "ME", "MI", "TU",
               "BUENO", "BUENA", "MALO", "MALA", "VALE", "PENA", "SIRVE",
               "TODOS", "TODAS", "OTRO", "OTRA", "ESTO", "ESO", "ESE", "ESA"}

def _detectar_activo(mensaje: str):
    """Devuelve (ticker, nombre, confiable). `confiable=True` si vino del
    diccionario de activos conocidos; False si solo lo sugiere el regex de
    mayúsculas — en ese caso el orquestador exige cotización real antes de
    registrar el ticker en class45/class15 (evita registrar palabras sueltas)."""
    low = mensaje.lower()
    if not any(p in low for p in _PALABRAS_INTENCION):
        return None, None, False
    for nombre, ticker in _ACTIVOS_CONOCIDOS.items():
        if re.search(rf"\b{re.escape(nombre)}\b", low):
            return ticker, nombre, True
    # Ticker explícito en mayúsculas ("analizá VIST") — mínimo 3 letras:
    # los de 2 (KO, BA, TS, TX) vienen del diccionario; en el regex chocarían
    # con demasiadas palabras cortas del español (ES, LA, UN, YA...)
    for tok in re.findall(r"\b[A-Z]{3,5}(?:-USD|\.BA)?\b", mensaje):
        if tok in _STOP_UPPER or tok in _TICKERS_SISTEMA:
            continue
        return tok, tok, False
    return None, None, False

async def _orquestar_analisis_activo(ticker: str, nombre: str, user_id: str,
                                     sesion: str, confiable: bool = True):
    """Dispara el pipeline on-demand y espera cotización (≤3s) y portfolio (≤2.5s).

    Si `confiable=False` (el ticker vino del regex de mayúsculas, no del
    diccionario), primero se valida que exista cotización real; sin cotización
    se retira el watch y se aborta — evita que una palabra suelta en mayúsculas
    quede registrada como ticker en class45/class15 y contamine el sentimiento.
    Devuelve None si el activo no se pudo validar.
    """
    res = {"ticker": ticker, "nombre": nombre, "precio": None,
           "change_pct": None, "portfolio": None}
    request_id = str(uuid.uuid4())
    r = await get_redis()
    sub = aioredis.from_url(REDIS_URL, encoding="utf-8",
                            decode_responses=True, socket_connect_timeout=3)
    try:
        ps = sub.pubsub()
        await ps.subscribe("class7_output", "class15_response")

        # 1) Cotización: class7 hace fetch inmediato al recibir el watch-add
        await r.publish("class7_watch", json.dumps(
            {"accion": "add", "tickers": [ticker], "sector": nombre}))

        loop = asyncio.get_running_loop()
        gen  = ps.listen().__aiter__()

        async def _esperar(cond, timeout_s):
            fin = loop.time() + timeout_s
            while loop.time() < fin:
                try:
                    m = await asyncio.wait_for(gen.__anext__(),
                                               timeout=max(0.1, fin - loop.time()))
                except (asyncio.TimeoutError, StopAsyncIteration):
                    return
                if m.get("type") != "message":
                    continue
                try:
                    d = json.loads(m["data"])
                except Exception:
                    continue
                if cond(m["channel"], d):
                    return

        # 2) Esperar la cotización hasta 3s
        def _es_quote(ch, d):
            if ch == "class7_output" and str(d.get("ticker", "")).upper() == ticker:
                res["precio"]     = d.get("precio") or d.get("close")
                res["change_pct"] = d.get("change_pct")
                return True
            return False
        await _esperar(_es_quote, 3.0)

        # Ticker de regex sin cotización real → no es un activo: abortar limpio
        if not confiable and res["precio"] is None:
            await r.publish("class7_watch", json.dumps(
                {"accion": "remove", "tickers": [ticker]}))
            log.info(f"🚫 '{ticker}' sin cotización — descartado como activo")
            return None

        # 3) Noticias del activo → class1 → class45
        await r.publish("class1_trigger", json.dumps({
            "origen": "chat_activo", "motivo": "analisis_activo", "ticker": ticker,
            "queries": [f"{nombre} {ticker} noticias hoy",
                        f"{ticker} stock news today",
                        f"{nombre} acciones análisis"],
            "ts": datetime.utcnow().isoformat()}, ensure_ascii=False))
        # 4) Sentimiento: registrar ticker dinámico en class45
        kws = sorted({nombre.lower(), ticker.lower()} - {""})
        await r.publish("class45_track", json.dumps(
            {"ticker": ticker, "keywords": kws}, ensure_ascii=False))

        # 5) Portfolio anclado en el activo (con la cotización si llegó)
        await r.publish("class15_request", json.dumps({
            "request_id": request_id, "ticker": ticker, "nombre": nombre,
            "user_id": user_id or "chat", "session_id": sesion or None,
            "quote": {"precio": res["precio"], "change_pct": res["change_pct"]},
        }, ensure_ascii=False))

        def _es_portfolio(ch, d):
            if ch == "class15_response" and d.get("request_id") == request_id:
                res["portfolio"] = d.get("portfolio")
                return True
            return False
        await _esperar(_es_portfolio, 2.5)
    finally:
        try:
            await sub.aclose()
        except Exception:
            pass
    return res


async def _resolver_activo(task, tkr, nom, espera_s=6.0):
    """Espera (acotado) el pipeline del activo que corre en paralelo y arma
    `(activo_ctx, portfolio_rec)`. El pipeline se autotermina en ≤5,5 s (sus
    propios timeouts internos), así que esto casi siempre devuelve al instante
    cuando class25B ya contestó. Si no llega a tiempo, devuelve el foco por
    ticker sin precio y sin portfolio: el precio igual llega al dashboard por WS.
    """
    activo_ctx = {"ticker": tkr, "nombre": nom or tkr, "precio": None, "change_pct": None}
    portfolio_rec = None
    if task is None:
        return activo_ctx, portfolio_rec
    try:
        res = await asyncio.wait_for(task, timeout=max(0.1, espera_s))
    except asyncio.TimeoutError:
        task.cancel()
        return activo_ctx, portfolio_rec
    except Exception as e:
        log.debug(f"_resolver_activo: {e}")
        return activo_ctx, portfolio_rec
    if res:
        activo_ctx = {"ticker": res["ticker"], "nombre": res["nombre"],
                      "precio": res["precio"], "change_pct": res["change_pct"]}
        _p = res.get("portfolio") or {}
        if _p.get("details"):
            portfolio_rec = {
                "perfil": f"enfocado en {tkr}",
                "monto":  None,
                "activos": [{
                    "symbol":     d.get("symbol"),
                    "peso_pct":   round(float(d.get("peso", 0) or 0) * 100, 1),
                    "riesgo_pct": round(float(d.get("riesgo", 0.5) or 0.5) * 100, 1),
                    "cambio_pct": round(float(d.get("change_pct", 0) or 0), 2),
                } for d in _p["details"]],
            }
    return activo_ctx, portfolio_rec


@app.post("/api/ask")
async def ask_sync(request: Request):
    """Endpoint síncrono del chat: publica a class25B con historial y activo en
    paralelo, espera la respuesta (motor local Ollama / Gemini de respaldo) y la
    devuelve por HTTP, correlacionada con ESTA consulta. Timeout: CHAT_TIMEOUT_S."""
    try:
        raw  = await request.json()
    except Exception:
        raise HTTPException(400, "JSON inválido")

    mensaje  = str(raw.get("mensaje", "")).strip()
    if not mensaje:
        raise HTTPException(400, "Mensaje vacío")

    user_id  = str(raw.get("user_id",  "anonimo"))
    sesion   = str(raw.get("sesion",   ""))
    nombre   = str(raw.get("nombre",   "Usuario"))
    historial= raw.get("historial", [])   # [{rol, txt}] del frontend
    # El portafolio que la web guarda por usuario (localStorage): class25B lo
    # compara contra el mercado cuando le preguntan «¿mi portafolio sirve?».
    port_usuario = portfolio_del_navegador(raw.get("portfolio_usuario"))

    msg_id  = str(uuid.uuid4())
    # Presupuesto del chat. El comentario viejo decía "Gemini ~5s": quedó
    # obsoleto con el motor LOCAL (gemma2:2b), que en frío genera a ~100 ms/token
    # y tiene un timeout DURO de 18 s en llm_local.js; sumando el armado de
    # contexto de class25B (~2-4 s) el piso real es ~20-22 s. Variable para poder
    # subirlo en el server SIN redeploy (ojo con el timeout del navegador).
    TIMEOUT = float(os.environ.get("CHAT_TIMEOUT_S", "25"))

    # ── ¿Pregunta por un activo puntual? (ej: "acciones de YPF") ──
    # Antes esto BLOQUEABA hasta 5,5 s (cotización 3 s + portfolio 2,5 s) ANTES
    # de publicar la consulta, comiéndose el presupuesto de class25B: con el
    # motor local esos 5,5 s eran la diferencia entre contestar y el timeout
    # ("MIIA está procesando"). Ahora el pipeline del activo corre EN PARALELO
    # (create_task) y la consulta se publica YA con el foco en el ticker; la
    # cotización/portfolio se adjuntan cuando el texto está listo (para entonces
    # el pipeline casi siempre terminó). El precio igual llega al dashboard por
    # WS. Reversa: CHAT_ACTIVO_BLOQUEA=1 vuelve al orden viejo (serial).
    activo_ctx = None
    portfolio_rec_activo = None
    orq_task = None
    _tkr = _nom = _conf = None
    try:
        _tkr, _nom, _conf = _detectar_activo(mensaje)
        if _tkr:
            # El foco en el ticker ya viaja (precio=None → class25B dice
            # "cotización solicitada"); el precio real llega por WS al dashboard.
            activo_ctx = {"ticker": _tkr, "nombre": _nom or _tkr,
                          "precio": None, "change_pct": None}
            orq_task = asyncio.create_task(
                _orquestar_analisis_activo(_tkr, _nom or _tkr, user_id, sesion, _conf))
            if os.environ.get("CHAT_ACTIVO_BLOQUEA", "0") == "1":
                activo_ctx, portfolio_rec_activo = await _resolver_activo(
                    orq_task, _tkr, _nom)
                orq_task = None
            log.info(f"🎯 Activo on-demand: {_tkr} (pipeline en paralelo)")
    except Exception as e:
        log.warning(f"orquestador de activo: {e}")

    redis_sub = aioredis.from_url(REDIS_URL, encoding="utf-8",
                                  decode_responses=True,
                                  socket_connect_timeout=3)
    try:
        pubsub = redis_sub.pubsub()
        await pubsub.subscribe(CH_OUTPUT)

        # Publicar la consulta a class25_ingest con historial para contexto MLLs.
        # El contexto por ticker se ACOTA a lo mencionado: antes viajaban los 50
        # instrumentos enteros en CADA mensaje y class25B sólo usaba el del ticker
        # preguntado (y en el camino local ni eso). `session_id` viaja para que
        # class25B lo eche de vuelta y /api/ask pueda emparejar la respuesta con
        # ESTA consulta en vez de devolver el primer INFO de cualquiera.
        _tks = tickers_en_texto(mensaje, _UNIVERSO_TEXTO)
        r = await get_redis()
        await r.publish(CH_INPUT, json.dumps({
            "id": msg_id, "source": "botchat", "type": "human_query",
            "text": mensaje, "texto": mensaje,
            "user_id": user_id, "nombre": nombre,
            "sesion": sesion, "session_id": sesion,
            "historial": historial,   # contexto multi-turno para Gemini
            "lstm_context":      _jsonable(filtrar_por_ticker(estado.get("lstm_señales", {}), _tks)),
            "sentimiento_context": _jsonable(filtrar_por_ticker(estado.get("sentimiento", {}), _tks)),
            # El riesgo también de los activos del portafolio, para que class25B
            # pueda dar la volatilidad ponderada de la cartera.
            "riesgo_context":    _jsonable(filtrar_por_ticker(await _riesgo_activos(),
                                 list(dict.fromkeys(list(_tks) + [a["symbol"] for a in (port_usuario or {}).get("activos", [])])))),
            "portfolio_usuario": port_usuario,
            "metricas_context":  _metricas_para_chat(),   # tasa de acierto HONESTA (panel), o None
            "activo_context":    activo_ctx,   # análisis on-demand del activo pedido
            "ts": datetime.utcnow().isoformat(),
        }, ensure_ascii=False))
        ws_manager.registrar_consulta()

        # Esperar respuesta con timeout real usando asyncio.wait_for
        loop       = asyncio.get_running_loop()   # py3.10+: no DeprecationWarning
        deadline   = loop.time() + TIMEOUT
        listen_gen = pubsub.listen().__aiter__()

        while loop.time() < deadline:
            remaining = max(0.5, deadline - loop.time())
            try:
                msg = await asyncio.wait_for(listen_gen.__anext__(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            except StopAsyncIteration:
                break

            if msg.get("type") != "message":
                continue
            try:
                data = json.loads(msg["data"])
            except Exception:
                continue

            clase = clasificar_salida(data, user_id=user_id, sesion=sesion)
            if clase != "mia":
                # "ignorar" = decisión de mercado/heartbeat (lo difunde el
                # redis_listener aparte). "ajena" = respuesta de chat de OTRA
                # sesión: NO devolvérsela a este usuario. En los dos casos, seguir.
                continue

            texto = data.get("texto", data.get("decision", ""))
            senal = data.get("senal", "")
            # Respuesta de chat: NO broadcast WS (ya llega por HTTP abajo).
            # Solo guardamos en historial para /api/historial.
            entry = formatear_decision(data)
            historial_decisiones.append(entry)
            if len(historial_decisiones) > 200:
                historial_decisiones.pop(0)
            await registrar_cliente(request, user_id=user_id, sesion=sesion)
            # El pipeline del activo corrió EN PARALELO: resolverlo ahora. Para
            # cuando class25B contestó casi siempre ya terminó → instantáneo.
            if orq_task is not None:
                _restante = max(0.1, deadline - loop.time())
                activo_ctx, portfolio_rec_activo = await _resolver_activo(
                    orq_task, _tkr, _nom, min(6.0, _restante))
                orq_task = None
            return JSONResponse({
                "ok": True, "msg_id": msg_id,
                "texto": texto, "senal": senal, "fuente": "class25B",
                # Prioridad: el que armó class25B; si no, el portfolio anclado
                # que generó class15 para el activo consultado
                "portfolio_recomendado": data.get("portfolio_recomendado")
                                         or portfolio_rec_activo,
                "activo": activo_ctx,
            })

    except Exception as e:
        log.warning(f"/api/ask error: {e}")
    finally:
        # Timeout o error: el pipeline del activo pudo quedar corriendo. Se
        # cancela para no filtrar una task (se autotermina igual en ≤5,5 s, pero
        # no dejamos basura). El watch/noticias/sentimiento ya se dispararon.
        if orq_task is not None and not orq_task.done():
            orq_task.cancel()
        try:
            await pubsub.unsubscribe(CH_OUTPUT)
            await redis_sub.aclose()
        except Exception:
            pass

    return JSONResponse({
        "ok": False, "msg_id": msg_id,
        "texto": "MIIA está procesando. Si no responde, verificá que class25B esté activo.",
        "fuente": "timeout",
    })

@app.post("/miia/input")
async def miia_input(request: Request, r: aioredis.Redis = Depends(get_redis)):
    """Endpoint que class30 usa para reenviar mensajes del gateway al chatbot."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "JSON inválido")
    texto = (body.get("text") or body.get("texto") or body.get("contenido") or "").strip()
    if not texto:
        return JSONResponse({"ok": True, "skipped": True})
    msg_id = str(uuid.uuid4())
    await r.publish(CH_INPUT, json.dumps({
        "id":     msg_id,
        "source": body.get("source", "class30"),
        "type":   "human_query",
        "text":   texto,
        "texto":  texto,
        "user_id": body.get("user_id", "gateway"),
        "ts":     datetime.utcnow().isoformat(),
    }, ensure_ascii=False))
    ws_manager.registrar_consulta()
    return JSONResponse({"ok": True, "msg_id": msg_id})

@app.get("/api/predicciones")
async def predicciones():
    """Devuelve las últimas señales LSTM y sentimiento para la UI."""
    return JSONResponse({
        "lstm":       estado.get("lstm_señales", {}),
        "sentimiento": estado.get("sentimiento", {}),
        "ultima_senal": estado.get("ultima_senal"),
    })

@app.get("/api/market")
async def market_data():
    """Datos de mercado en formato % limpio."""
    sectores_fmt = {}
    for nombre, s in estado["sectores"].items():
        sectores_fmt[nombre] = {
            **s,
            "change_str": fmt_change(s["change"]),
            "score_pct":  fmt_pct(s.get("score", 0.5)),
            "color":      "#10b981" if s["change"] >= 0 else "#ef4444",
        }
    return JSONResponse({
        "sectores":    sectores_fmt,
        "riesgo_pct":  f"{estado['riesgo_pct']}%",
        "riesgo_num":  estado["riesgo_pct"],
        "ts_mercado":  estado["ts_mercado"],
    })

@app.get("/api/accuracy")
async def accuracy():
    """Tasa de aciertos — fuente primaria: MySQL cognitive_decisions."""
    # ── 1. Totales desde MySQL ────────────────────────────────
    totals = None
    try:
        totals = (await db_exec("""
            SELECT
                COUNT(*)                                                      AS total,
                SUM(outcome_real = 'correcto')                                AS correctas,
                SUM(outcome_real = 'incorrecto')                              AS incorrectas,
                SUM((outcome_real = 'pendiente' OR outcome_real IS NULL)
                    AND senal IN ('BUY','SELL'))                              AS pendientes,
                -- Confianza SOLO de señales direccionales. Un HOLD tiene
                -- confianza ~46% por definición (es el bucket "ninguna de las
                -- dos"), y hoy los HOLD son ~72% de la tabla: promediarlos
                -- arrastraba el número global hacia 46% y parecía que el
                -- modelo perdía confianza. No la perdía: cambiaba la mezcla.
                AVG(CASE WHEN senal IN ('BUY','SELL') THEN confianza END)     AS conf_prom,
                SUM(senal IN ('BUY','SELL'))                                  AS total_direccionales,
                AVG(CASE WHEN senal = 'HOLD' THEN confianza END)              AS conf_hold,
                SUM(CASE WHEN outcome_real='correcto' AND senal='BUY'  THEN 1 ELSE 0 END) AS ok_buy,
                SUM(CASE WHEN senal='BUY'  AND outcome_real IN ('correcto','incorrecto') THEN 1 ELSE 0 END) AS tot_buy,
                SUM(CASE WHEN outcome_real='correcto' AND senal='SELL' THEN 1 ELSE 0 END) AS ok_sell,
                SUM(CASE WHEN senal='SELL' AND outcome_real IN ('correcto','incorrecto') THEN 1 ELSE 0 END) AS tot_sell
            FROM cognitive_decisions
            -- Incluye las señales DIRECCIONALES del ensemble (class19/GENERAL/
            -- class18_vectorial): son la señal principal y class43 las verifica
            -- contra el retorno promedio de ETFs. Excluirlas dejaba la métrica vacía.
            -- Excluye las SOMBRA: SELL que el gate de class25B suprimió y que se
            -- registran sólo para medir qué habrían hecho (no se emitieron nunca).
            WHERE (temperatura IS NULL OR temperatura <> 'shadow')
        """) or [])[0]
    except Exception as e:
        # Antes era `pass` a secas: con MySQL fallando, el endpoint caía al
        # fallback de Redis y seguía devolviendo números creíbles, así que el
        # fallo era INVISIBLE. Fue lo que enmascaró el bug del `%` literal.
        _log_error_endpoint("/api/accuracy (totales MySQL)", e)

    def _safe_float(v):
        try: return float(v) if v is not None else 0.0
        except: return 0.0
    # Aplicar conversión a toda la fila MySQL (puede tener Decimal, datetime)
    if totals: totals = _jsonable(totals)

    correctas   = _safe_float(totals.get("correctas"))   if totals else 0.0
    incorrectas = _safe_float(totals.get("incorrectas")) if totals else 0.0
    pendientes  = _safe_float(totals.get("pendientes"))  if totals else 0.0
    total_db    = _safe_float(totals.get("total"))       if totals else 0.0
    ok_buy      = _safe_float(totals.get("ok_buy"))      if totals else 0.0
    tot_buy     = _safe_float(totals.get("tot_buy"))     if totals else 0.0
    ok_sell     = _safe_float(totals.get("ok_sell"))     if totals else 0.0
    tot_sell    = _safe_float(totals.get("tot_sell"))    if totals else 0.0
    conf_prom   = _safe_float(totals.get("conf_prom"))   if totals else 0.0

    verificadas = correctas + incorrectas
    ag_db  = correctas / verificadas if verificadas > 0 else estado["accuracy_global"]
    # Sin señales verificadas de ese tipo → None (el frontend muestra "–", no "0.0%").
    # Un 0.0% se leería como "todas las señales erradas"; sin datos ≠ error.
    buy_db  = ok_buy  / tot_buy  if tot_buy  > 0 else (estado.get("precision_buy")  or None)
    sell_db = ok_sell / tot_sell if tot_sell > 0 else (estado.get("precision_sell") or None)

    # Usar el mayor entre Redis y MySQL
    ag  = max(ag_db,  estado["accuracy_global"])
    a30 = estado["accuracy_30d"]
    pend_total = int(max(pendientes, estado["pendientes"]))
    total_total= int(max(total_db,  estado["total_decisiones"]))

    # ── 2. Historial 30d por día ─────────────────────────────
    rows = []
    try:
        rows = await db_exec("""
            SELECT DATE(ts) as fecha,
                   COUNT(*) as total,
                   SUM(outcome_real='correcto')   as correctas,
                   SUM(outcome_real='incorrecto') as incorrectas,
                   SUM(outcome_real='pendiente' OR outcome_real IS NULL) as pendientes_dia
            FROM cognitive_decisions
            WHERE ts > DATE_SUB(NOW(), INTERVAL 30 DAY)
              AND ticker NOT LIKE 'class%' AND ticker <> 'GENERAL'
            GROUP BY DATE(ts)
            ORDER BY fecha DESC
        """) or []
    except Exception:
        pass

    historial = []
    for r in rows or []:
        tot = int(r.get("total", 0))
        cor = int(r.get("correctas", 0) or 0)
        inc = int(r.get("incorrectas", 0) or 0)
        ver = cor + inc
        acc = cor / ver if ver > 0 else None
        historial.append({
            "fecha":       str(r.get("fecha", "")),
            "total":       tot,
            "correctas":   cor,
            "incorrectas": inc,
            "pendientes":  int(r.get("pendientes_dia", 0) or 0),
            "acc_pct":     fmt_pct(acc) if acc is not None else "pendiente",
        })

    return JSONResponse({
        "accuracy_global":     round(ag * 100, 1),
        "accuracy_global_pct": fmt_pct(ag),
        "accuracy_30d":        round(a30 * 100, 1),
        "accuracy_30d_pct":    fmt_pct(a30),
        "precision_buy":       round(buy_db * 100, 1)  if buy_db  is not None else None,
        "precision_sell":      round(sell_db * 100, 1) if sell_db is not None else None,
        # Confianza de BUY/SELL únicamente (los HOLD la hundían hacia ~46%).
        "confianza_promedio":  round(conf_prom * 100, 1) if conf_prom else None,
        "confianza_hold":      round(_safe_float(totals.get("conf_hold")) * 100, 1) if totals else None,
        "total_direccionales": int(_safe_float(totals.get("total_direccionales"))) if totals else 0,
        "total_decisiones":    total_total,
        "verificadas":         int(verificadas),
        "pendientes":          pend_total,
        "historial_30d":       historial,
        "mejor_que_azar":      ag > 0.50,
        # Honesto: si la consulta a MySQL falló, `totals` quedó None y estos
        # números vienen SOLO del estado en Redis. Decir "mysql+redis" siempre
        # hacía indistinguible un fallback silencioso de una lectura sana.
        "fuente":              "mysql+redis" if totals else "redis (mysql no disponible)",
        "ts":                  estado["ts_accuracy"],
    })

# ── Cierres diarios por ticker, compartidos y cacheados ────────────────────
# SOLO RENDIMIENTO: los números que salen de acá son los mismos.
#
# El mismo problema que se arregló el 22-ago en `_retornos_diarios_mercado`,
# en la función de al lado, que quedó afuera de aquel arreglo. Medido en
# producción el 21-sep-2026: **/api/portfolio tardaba 13,5 s en CADA visita**.
# La consulta pedía `SELECT ticker, precio, ts FROM precios` sin agrupar, con
# una cota de 400 días que no recorta nada porque la tabla tiene tres meses:
# se traía 1.180.000 filas para después quedarse, en Python, con un puñado de
# precios base.
#
# Ahora se piden CIERRES DIARIOS —un renglón por ticker y día, ~900 en total—
# y se cachean 5 min, igual que los retornos del mercado. Un cierre de un día
# ya pasado no cambia; el del día en curso es el último precio del día, que es
# exactamente lo que la función usaba como "precio actual".
_CIERRES_TTL = 300
_cierres_cache: dict = {"ts": 0.0, "datos": None}


async def _cierres_diarios():
    """{ticker: [(fecha, precio), …]} ordenado, con el último tick del día en curso."""
    ahora = time.time()
    if _cierres_cache["datos"] is not None and ahora - _cierres_cache["ts"] < _CIERRES_TTL:
        return _cierres_cache["datos"]
    # Los 13 que se COTIZAN, no `_TICKERS_SISTEMA` (que suma SPY/QQQ/BTC/ETH,
    # los que solo se reconocen al parsear texto del chat). Pedirle a `precios`
    # tickers que no existen no rompe nada, pero es la misma confusion que
    # produjo el drift del universo -- y aca decide quien entra en el promedio.
    etfs = tuple(sorted(_UNIVERSO))
    marks = ",".join(["%s"] * len(etfs))
    rows = await db_exec(f"""
        SELECT t.ticker, t.f, p.precio
        FROM (SELECT ticker, DATE(ts) AS f, MAX(ts) AS mx
              FROM precios
              WHERE precio IS NOT NULL AND precio > 0
                AND ts >= NOW() - INTERVAL %s DAY
                AND ticker IN ({marks})
              GROUP BY ticker, DATE(ts)) t
        JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
        ORDER BY t.ticker, t.f
    """, (400,) + etfs) or []
    series: dict = {}
    for r in rows:
        series.setdefault(r["ticker"], []).append(
            (datetime.strptime(str(r["f"]), "%Y-%m-%d"), float(r["precio"])))
    _cierres_cache.update({"ts": ahora, "datos": series})
    return series


async def _semana_mercado(sesiones: int = 7):
    """Cómo se movió el mercado en las últimas N sesiones, equiponderado.

    Alimenta la tira semanal del panel «Régimen de Mercado». Reusa
    `_cierres_diarios()` —cacheado y con el GROUP BY correcto— en vez de otra
    consulta sobre `precios`: con 50 instrumentos esa tabla crece rápido y una
    consulta sin agrupar es la precondición 2 del corte.

    Se promedian RETORNOS, no precios. Promediar precios deja que manden los ETF
    caros —es el defecto 5, que el corte del 10-oct arregló en class43— y acá
    daría un «mercado» que es en realidad XLK con tres amigos.

    ⚠️ Los días SIN RUEDA no se ven solos: `precios` sigue teniendo filas el fin
    de semana porque class7 publica igual, y lo que no cambia es el precio. Un
    día en el que TODOS los instrumentos dan exactamente 0 no es un mercado
    plano: es un día que no existió, y contarlo aplana la semana con ceros
    inventados. Es el mismo filtro que `rank_ic` aplica por el mismo motivo.
    """
    try:
        series = await _cierres_diarios()
        if not series:
            return []
        # El cambio de cada ticker se mide contra SU cierre anterior, no contra
        # una fecha común: si a un instrumento le falta un día, se saltea solo
        # en vez de contaminar el promedio del resto.
        por_fecha: dict = {}
        for pares in series.values():
            for i in range(1, len(pares)):
                p0 = pares[i - 1][1]
                f1, p1 = pares[i]
                if p0 and p0 > 0:
                    por_fecha.setdefault(f1, []).append((p1 / p0 - 1) * 100.0)

        salida = []
        for f in sorted(por_fecha):
            vs = por_fecha[f]
            if len(vs) < 3 or all(abs(v) < 1e-9 for v in vs):
                continue
            salida.append({
                "fecha":      f.strftime("%Y-%m-%d"),
                "cambio_pct": round(sum(vs) / len(vs), 3),
                "suben":      sum(1 for v in vs if v > 0),
                "n":          len(vs),
            })
        return salida[-max(1, min(int(sesiones), 30)):]
    except Exception as e:
        log.warning(f"_semana_mercado error: {e}")
        return []


async def _calcular_interes_portfolio(portfolio_id: str, activos: list):
    """Interés ganado del portfolio (diario / mensual / anual) en %.

    Rendimiento ponderado por peso de cada activo, calculado contra el
    histórico real de la tabla `precios`. Si el histórico disponible es más
    corto que el horizonte (ej: 3 días de datos para el horizonte anual), el
    valor se anualiza/extrapola por capitalización compuesta y se informa
    `dias_datos` para que la UI lo etiquete como proyección.
    Persiste el resultado en las columnas interes_*_pct de `portfolios`.
    """
    try:
        symbols = [a.get("symbol") for a in activos if a.get("symbol")]
        if not symbols:
            return None
        pesos = {a["symbol"]: float(a.get("peso_pct") or 0) / 100.0
                 for a in activos if a.get("symbol")}
        # Cierres diarios cacheados en vez de la tabla entera: ver el bloque de
        # arriba. La cota de 400 días vive ahora en `_cierres_diarios()`, y se
        # piden 400 y no 365 para que `_ret_desde` encuentre un precio base real
        # en el borde del horizonte anual en vez de caer al fallback de serie[0].
        todas = await _cierres_diarios()
        series = {s: todas[s] for s in symbols if len(todas.get(s, ())) >= 2}
        if not series:
            return None

        now = datetime.now()

        def _ret_desde(serie, cutoff):
            """Retorno desde el precio vigente en `cutoff` hasta el último."""
            base = None
            for ts, p in serie:
                if ts <= cutoff:
                    base = p
                else:
                    break
            if base is None:
                base = serie[0][1]   # histórico más corto que el horizonte
            ultimo = serie[-1][1]
            return (ultimo / base) - 1.0 if base > 0 else 0.0

        w_total = r_dia = r_mes = r_full = 0.0
        dias_datos = 0.0
        for sym, serie in series.items():
            w = pesos.get(sym, 0.0)
            if w <= 0 or len(serie) < 2:
                continue
            w_total += w
            r_dia  += w * _ret_desde(serie, now - timedelta(hours=24))
            r_mes  += w * _ret_desde(serie, now - timedelta(days=30))
            r_full += w * _ret_desde(serie, now - timedelta(days=365))
            ventana = (serie[-1][0] - serie[0][0]).total_seconds() / 86400.0
            dias_datos = max(dias_datos, ventana)
        if w_total <= 0:
            return None

        r_dia, r_mes, r_full = r_dia / w_total, r_mes / w_total, r_full / w_total
        dias = max(dias_datos, 0.5)

        # Extrapolar por capitalización compuesta cuando faltan datos
        if dias < 30:
            r_mes = (1.0 + r_mes) ** (30.0 / dias) - 1.0
        r_anual = (1.0 + r_full) ** (365.0 / dias) - 1.0 if dias < 365 else r_full

        interes = {
            "diario_pct":  round(r_dia   * 100, 4),
            "mensual_pct": round(r_mes   * 100, 4),
            "anual_pct":   round(r_anual * 100, 4),
            "dias_datos":  round(dias, 1),
            "proyectado":  dias < 365,   # True si mensual/anual son extrapolados
        }

        await db_exec("""
            UPDATE portfolios
            SET interes_diario_pct = %s, interes_mensual_pct = %s,
                interes_anual_pct = %s, ts_interes = NOW(3)
            WHERE portfolio_id = %s
        """, (interes["diario_pct"], interes["mensual_pct"],
              interes["anual_pct"], portfolio_id))
        return interes
    except Exception as e:
        log.warning(f"_calcular_interes_portfolio: {e}")
        return None

@app.get("/api/portfolio")
async def get_portfolio(request: Request):
    """
    Retorna el portfolio más reciente generado por class15/class17.
    Incluye activos con pesos en %, cambio de precio, sector y riesgo.
    """
    user = get_current_user(request)
    user_id = user.get("user_id", "general") if user else "general"

    # Obtener portfolio principal
    port_rows = await db_exec("""
        SELECT portfolio_id, strategy, status,
               ROUND(confidence * 100, 1)    AS confianza_pct,
               ROUND(risk_level * 100, 1)    AS riesgo_pct,
               ROUND(riesgo_global * 100, 1) AS riesgo_global_pct,
               n_activos, ts
        FROM portfolios
        WHERE user_id = %s OR user_id = 'general'
        ORDER BY ts DESC
        LIMIT 1
    """, (user_id,)) or []

    if not port_rows:
        return JSONResponse({"portfolio": None, "activos": [],
                             "msg": "Sin portfolio disponible aún"})

    port = dict(port_rows[0])

    # Obtener activos del portfolio
    asset_rows = await db_exec("""
        SELECT symbol, sector,
               ROUND(peso * 100, 1)       AS peso_pct,
               ROUND(change_pct, 1)       AS change_pct,
               ROUND(score * 100, 1)      AS score_pct,
               ROUND(riesgo * 100, 1)     AS riesgo_pct,
               ROUND(confianza * 100, 1)  AS confianza_pct,
               estado_sector
        FROM portfolio_assets
        WHERE portfolio_id = %s
        ORDER BY peso DESC
        LIMIT 10
    """, (port["portfolio_id"],)) or []

    activos = [_jsonable(dict(a)) for a in (asset_rows or [])]

    # Enriquecer con color según change_pct
    for a in activos:
        chg = float(a.get("change_pct", 0) or 0)
        a["color"]      = "#10b981" if chg >= 0 else "#ef4444"
        a["change_str"] = f"+{chg:.1f}%" if chg >= 0 else f"{chg:.1f}%"

    # Riesgo REAL por activo (vol + drawdown). try/except: si falla, /api/portfolio
    # tiene que seguir contestando igual que antes — no se rompe lo que anda.
    try:
        _ra = await _riesgo_activos()
        for a in activos:
            r = _ra.get(a.get("symbol"))
            if r:
                a["vol_pct"]        = r["vol_pct"]
                a["drawdown_pct"]   = r["drawdown_pct"]
                a["riesgo_vol_pct"] = r["riesgo_vol_pct"]
                a["vol_2d_pct"]     = r.get("vol_2d_pct")
                a["ratio_vol"]      = r.get("ratio_vol")
                a["mas_movido"]     = r.get("mas_movido", False)
        # Pronóstico a 2 días de TODO el universo, del más al menos movido respecto
        # de lo habitual. Viaja dentro de /api/portfolio porque class30 sólo deja
        # pasar los endpoints de su lista (un endpoint nuevo exigiría reiniciarlo).
        volatilidad_2d = sorted(
            ({"ticker": tk, "vol_2d_pct": r.get("vol_2d_pct"), "ratio_vol": r.get("ratio_vol"),
              "mas_movido": r.get("mas_movido", False), "menos_movido": r.get("menos_movido", False)}
             for tk, r in _ra.items() if r.get("ratio_vol") is not None),
            key=lambda x: -x["ratio_vol"])
    except Exception as e:
        volatilidad_2d = []
        log.warning(f"/api/portfolio: riesgo por activo no disponible ({type(e).__name__})")

    port = _jsonable(port)

    # Historial de portfolios recientes (últimos 5 para el panel)
    hist_rows = await db_exec("""
        SELECT portfolio_id,
               ROUND(confidence * 100, 1)  AS confianza_pct,
               ROUND(risk_level  * 100, 1) AS riesgo_pct,
               strategy, n_activos, ts
        FROM portfolios
        WHERE user_id = %s OR user_id = 'general'
        ORDER BY ts DESC
        LIMIT 5
    """, (user_id,)) or []
    historial_port = [_jsonable(dict(r)) for r in hist_rows]

    # Interés ganado (diario / mensual / anual) — calculado desde `precios`
    # y persistido en las columnas interes_*_pct de `portfolios`
    interes = await _calcular_interes_portfolio(port["portfolio_id"], activos)

    # Guardar en estado global para WebSocket
    estado["portfolio_actual"] = {"portfolio": port, "activos": activos}
    estado["ts_portfolio"]     = port.get("ts")

    # La medición de rendimiento viaja DENTRO de esta respuesta porque class30
    # no rutea /api/portfolio/rendimiento (ver la nota en ese endpoint). El
    # try/except no es decorativo: si el cálculo falla, /api/portfolio tiene que
    # seguir contestando exactamente como antes. No se rompe lo que funciona
    # para agregarle algo. El cálculo está cacheado 5 min, así que el costo por
    # visita es cero casi siempre.
    try:
        rendimiento = await _rendimiento_cacheado()
    except Exception as e:
        log.warning(f"/api/portfolio: rendimiento no disponible ({type(e).__name__})")
        rendimiento = None

    return JSONResponse({
        "portfolio":        port,
        "activos":          activos,
        "interes":          interes,
        "rendimiento":      rendimiento,
        "volatilidad_2d":   volatilidad_2d,
        "historial_reciente": historial_port,
        "ts":               port.get("ts"),
    })

@app.get("/api/stats")
async def stats():
    return JSONResponse({
        "online_now":      len(ws_manager.users),
        "consultas_hora":  ws_manager.consultas_ultima_hora,
        "total_decisiones":estado["total_decisiones"],
        "accuracy_pct":    fmt_pct(estado["accuracy_global"]),
        "senal_actual":    estado["ultima_senal"],
    })

@app.get("/api/historial")
async def historial_route(n: int = 20):
    """Historial de decisiones — in-memory primero, MySQL como fallback."""
    if historial_decisiones:
        return JSONResponse({"decisiones": historial_decisiones[-n:], "fuente": "memoria"})
    # Fallback: leer de MySQL signals_feed
    try:
        # signals_feed no tiene columna 'ts' → ordenar por id (auto-increment = cronológico)
        rows = await db_exec("""
            SELECT id, senal, ticker, confianza, riesgo,
                   horizonte_horas, texto
            FROM signals_feed
            ORDER BY id DESC
            LIMIT %s
        """, (n,)) or []
        decisiones = []
        for r in rows:
            horas = int(r.get("horizonte_horas") or 24)
            decisiones.append({
                "senal":     r.get("senal", "–"),
                "ticker":    r.get("ticker", "–"),
                "confianza": float(r.get("confianza") or 0),
                "riesgo":    float(r.get("riesgo") or 0),
                "horizonte": f"{horas}h",
                "texto":     r.get("texto", ""),
                "ts":        str(r.get("id", "")),  # usar id como proxy de timestamp
                "conf_pct":  fmt_pct(float(r.get("confianza") or 0)),
            })
        return JSONResponse({"decisiones": decisiones, "fuente": "mysql"})
    except Exception as e:
        log.warning(f"historial fallback MySQL: {e}")
        return JSONResponse({"decisiones": [], "fuente": "vacio"})

# ══════════════════════════════════════════════════════════════════
# Retornos diarios del mercado — consulta compartida y cacheada
# ══════════════════════════════════════════════════════════════════
# SOLO RENDIMIENTO: el cálculo es idéntico al que había, línea por línea.
# Lo único que cambia es cuántas veces se paga y cuánto lee.
#
# Esta consulta vivía DUPLICADA en /api/backtesting/professional y en
# /api/precios, sin cota temporal y sin caché: cada visita de cada usuario
# agrupaba `precios` entero dos veces. Medido con performance_schema el
# 22-ago-2026:
#
#   24.076 s acumulados · 5.122 ejecuciones · 4.700 ms de promedio
#
# Dos cambios, ninguno toca los números:
#   · Caché de 5 min — el último precio de un día ya cerrado no cambia.
#   · Cota de VENTANA_METRICAS_DIAS — hoy `precios` tiene ~55 días, así que
#     no excluye ni una fila; existe para que la consulta no se degrade sola
#     a medida que la tabla crezca.
VENTANA_METRICAS_DIAS = 365
_MKT_CACHE_TTL        = 300   # 5 min

_mkt_cache: dict = {"ts": 0.0, "rets": None}


async def _retornos_diarios_mercado():
    """Retorno diario equiponderado de los ETFs del sistema.

    Lista de floats, uno por día. Misma salida que el bloque que reemplaza.
    """
    ahora = time.time()
    if _mkt_cache["rets"] is not None and ahora - _mkt_cache["ts"] < _MKT_CACHE_TTL:
        return _mkt_cache["rets"]

    _etfs  = tuple(sorted(_UNIVERSO))   # los 13 medibles, no los de texto
    _marks = ",".join(["%s"] * len(_etfs))
    d_rows = await db_exec(f"""
        SELECT t.ticker, t.f, p.precio
        FROM (SELECT ticker, DATE(ts) AS f, MAX(ts) AS mx
              FROM precios
              WHERE precio IS NOT NULL AND precio > 0
                AND ts >= NOW() - INTERVAL %s DAY
                AND ticker IN ({_marks})
              GROUP BY ticker, DATE(ts)) t
        JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
        ORDER BY t.ticker, t.f
    """, (VENTANA_METRICAS_DIAS,) + _etfs) or []

    por_dia, prev = {}, {}
    for r in d_rows:
        tk, f, pr = r["ticker"], str(r["f"]), float(r["precio"])
        if tk in prev and prev[tk] > 0:
            por_dia.setdefault(f, []).append(pr / prev[tk] - 1.0)
        prev[tk] = pr

    rets = [sum(v) / len(v) for _, v in sorted(por_dia.items()) if v]
    _mkt_cache.update({"ts": ahora, "rets": rets})
    return rets


# ── Riesgo POR ACTIVO — volatilidad realizada + drawdown (16-oct-2026) ───────
# El `riesgo` que viene de class7 es un proxy simple del cambio de precio del
# día. Esto lo complementa con una medida descriptiva REAL calculada del
# histórico de `precios`: volatilidad realizada anualizada y caída máxima
# (drawdown) en una ventana. NO es un pronóstico — es lo que el activo HIZO.
#
# Vive acá (Python, no en class7) a propósito: así se despliega con el relanzado
# de app.py (~20 s) y NO exige reiniciar el orquestador ni resetear la medición
# (centroides de class13, g_base/umbral/neutro de class25A). class7 no está en
# CRITICAL_LABELS, así que tocarlo allá habría costado un reinicio completo.
RIESGO_VENTANA_DIAS = 60
_RIESGO_CACHE_TTL   = 600   # 10 min: el riesgo no cambia minuto a minuto
_riesgo_cache       = {"ts": 0.0, "data": None}

async def _riesgo_activos():
    """{ticker: {vol_pct, drawdown_pct, riesgo_vol_pct}} de los últimos
    RIESGO_VENTANA_DIAS. Cacheado. Nunca tira excepción al llamador."""
    ahora = time.time()
    if _riesgo_cache["data"] is not None and ahora - _riesgo_cache["ts"] < _RIESGO_CACHE_TTL:
        return _riesgo_cache["data"]
    try:
        etfs  = tuple(sorted(_UNIVERSO))
        marks = ",".join(["%s"] * len(etfs))
        rows = await db_exec(f"""
            SELECT t.ticker, p.precio
            FROM (SELECT ticker, DATE(ts) f, MAX(ts) mx
                  FROM precios
                  WHERE precio IS NOT NULL AND precio > 0
                    AND ts >= NOW() - INTERVAL %s DAY
                    AND ticker IN ({marks})
                  GROUP BY ticker, DATE(ts)) t
            JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
            ORDER BY t.ticker, t.f
        """, (RIESGO_VENTANA_DIAS + 5,) + etfs) or []
    except Exception as e:
        log.warning(f"_riesgo_activos: consulta falló ({type(e).__name__})")
        return _riesgo_cache["data"] or {}

    series = {}
    for r in rows:
        series.setdefault(r["ticker"], []).append(float(r["precio"]))

    out = {}
    for tk, px in series.items():
        # 6 cierres = 5 retornos: alcanza para una vol aproximada. Los 37
        # instrumentos nuevos tienen 6-7 días de historia (el universo pasó a 50
        # a fin de septiembre); con <10 quedaban todos afuera y el portafolio,
        # armado con ellos, no mostraba riesgo. Firma más fino a medida que
        # juntan historia.
        if len(px) < 6:
            continue
        rets = [px[i] / px[i-1] - 1.0 for i in range(1, len(px)) if px[i-1] > 0]
        if len(rets) < 4:
            continue
        m   = sum(rets) / len(rets)
        var = sum((x - m) ** 2 for x in rets) / (len(rets) - 1)
        vol_anual = (var ** 0.5) * (252 ** 0.5)          # fracción anualizada
        # ── Pronóstico de volatilidad a 2 días (EWMA λ=0,94, ORDEN 7 grupo A) ──
        # Lo único que las simulaciones encontraron que SÍ se predice: cuánto se
        # va a mover cada activo (sim56: rank IC +0,138 en ETFs sobre lo habitual
        # de cada uno), y esta fórmula de una línea lo hace igual o mejor que la
        # cadena de MIIA. NO dice hacia dónde. `ratio_vol` > 1 = más movido de lo
        # que suele. Sólo informa: no entra en ninguna decisión ni en la tesis.
        s2 = rets[0] ** 2
        for x in rets[1:]:
            s2 = 0.94 * s2 + 0.06 * x * x
        vol_hab = var ** 0.5
        vol2d   = (s2 ** 0.5) * (2 ** 0.5)               # desvío de los próximos 2 días
        ratio   = (s2 ** 0.5) / vol_hab if vol_hab > 0 else None
        pico, dd = px[0], 0.0                            # drawdown máximo
        for v in px:
            if v > pico:
                pico = v
            caida = (pico - v) / pico if pico > 0 else 0.0
            if caida > dd:
                dd = caida
        # score 0-100: 60% vol (satura en 45% anual) + 40% drawdown (satura en 25%)
        score = min(1.0, 0.6 * min(1.0, vol_anual / 0.45) + 0.4 * min(1.0, dd / 0.25)) * 100
        out[tk] = {
            "vol_pct":        round(vol_anual * 100, 1),
            "drawdown_pct":   round(dd * 100, 1),
            "riesgo_vol_pct": round(score),
            "vol_2d_pct":     round(vol2d * 100, 2),
            "ratio_vol":      None if ratio is None else round(ratio, 2),
            "mas_movido":     bool(ratio is not None and ratio >= 1.25),
            "menos_movido":   bool(ratio is not None and ratio <= 0.80),
        }
    _riesgo_cache.update({"ts": ahora, "data": out})
    return out


# ── Caché de respuesta de /api/backtesting/professional ─────────────────────
# Medido en producción el 30-ago-2026: el endpoint tarda 4,6-6,1 s. Son cinco
# agregaciones sobre 207.833 decisiones y 67.637 verificadas, y NO había caché
# a nivel de respuesta — cada visita las recalculaba enteras.
#
# Eso tenía dos costos:
#   1. Visible: que-es-miia.html abortaba el fetch a los 8 s y mostraba "—" en
#      toda la sección "Estado de la medición", con el endpoint sano detrás.
#   2. Invisible: el dashboard lo consulta cada 60 s y la portada en cada
#      visita, así que mysqld recalculaba lo mismo sin parar.
#
# Son métricas agregadas sobre meses de historia: no cambian en 45 s. El TTL
# es más corto que el ciclo de 60 s del dashboard, así que este nunca ve un
# número más viejo que su propio período de refresco.
# ⚠️ **El TTL de 45 s hacía que la caché no sirviera para su consumidor
# principal.** El dashboard consulta cada 60 s, y 45 < 60, así que **todas** sus
# visitas caían en frío y pagaban el cálculo entero. El comentario de arriba
# elegía ese número para que el dashboard "nunca vea un dato más viejo que su
# propio refresco", y el efecto fue el contrario al buscado.
#
# La forma correcta de tener las dos cosas es **servir lo viejo y refrescar
# atrás** (stale-while-revalidate, 21-sep-2026): apenas vence, la request que
# llega recibe el dato guardado AL INSTANTE y dispara el recálculo en segundo
# plano. Nadie espera nunca los 14 s, y el dato no envejece más de un ciclo.
_PROF_CACHE_TTL   = 45     # a partir de acá se refresca atrás
_PROF_CACHE_MAX   = 900    # 15 min: más viejo que esto ya no se sirve, se espera
_prof_cache: dict = {"ts": 0.0, "datos": None}
_prof_refrescando = False  # ¿hay un recálculo en vuelo?


def _metricas_para_chat():
    """Métricas HONESTAS para el chat (las mismas del panel), desde la caché del
    endpoint profesional. Devuelve un dict chico o None, y NUNCA lanza: si la
    caché está vacía o algo falla, el chat cae al flujo normal (como hoy).

    Usa `accuracy_directional` (accuracy direccional sobre ventanas verificadas,
    contra `base_rate`), NO `backtesting_stats.accuracy_global`, que está INFLADA
    (el "97 %" que se sacó de la web el 13-sep). class25B/metricas.js igual rechaza
    cualquier valor fuera de 30-70 %, así que el inflado no puede filtrarse ni por
    error. Lo lee class25B de `metricas_context`."""
    try:
        d = _prof_cache.get("datos")
        if not isinstance(d, dict):
            return None
        if d.get("accuracy_directional") is None:
            return None
        return {
            "accuracy_directional": d.get("accuracy_directional"),
            "base_rate":            d.get("base_rate"),
            "edge_vs_baseline":     d.get("edge_vs_baseline"),
            "n_efectivo":           d.get("n_efectivo"),
            "edge_significativo":   d.get("edge_significativo"),
            # La ventaja contra el azar con la misma mezcla (la del panel).
            "azar_mezcla":          d.get("azar_mezcla"),
            "edge_vs_azar":         d.get("edge_vs_azar"),
            "edge_azar_significativo": d.get("edge_azar_significativo"),
            "edge_min_detectable":  d.get("edge_min_detectable"),
            "precision_buy":        d.get("precision_buy"),
            "precision_sell":       d.get("precision_sell"),
        }
    except Exception:
        return None

# El lock se crea PEREZOSAMENTE, no a nivel de módulo. Hasta Python 3.9,
# asyncio.Lock() construido fuera de un event loop se ataba al loop vigente en
# ese momento y después fallaba con "attached to a different loop". Desde 3.10
# es seguro, pero crearlo acá adentro funciona en las dos y evita depender de
# la versión que tenga el server. Cuando esta función corre ya hay loop, y en
# asyncio de un solo hilo no hay carrera: entre el chequeo y la asignación no
# hay ningún await donde se pueda intercalar otra corrutina.
_prof_lock = None


async def _prof_refrescar():
    """Recalcula y guarda en la caché. Corre en segundo plano."""
    global _prof_refrescando, _prof_lock
    if _prof_lock is None:
        _prof_lock = asyncio.Lock()
    try:
        async with _prof_lock:
            resp = await _backtesting_professional_calc()
            try:
                datos = json.loads(resp.body)
                if datos.get("estado") != "error":
                    _prof_cache["ts"]    = time.time()
                    _prof_cache["datos"] = datos
            except Exception:
                pass
    except Exception as e:
        log.warning("refresco de /backtesting/professional falló: %s", e)
    finally:
        _prof_refrescando = False


@app.get("/api/backtesting/professional")
async def backtesting_professional():
    """Envoltorio con caché. El cálculo real vive en _backtesting_professional_calc."""
    global _prof_lock, _prof_refrescando
    ahora = time.time()
    edad  = ahora - _prof_cache["ts"]

    if _prof_cache["datos"] is not None:
        if edad < _PROF_CACHE_TTL:
            return JSONResponse(_prof_cache["datos"])
        if edad < _PROF_CACHE_MAX:
            # VENCIDA pero utilizable: se devuelve YA y se refresca atrás. Es
            # lo que hace que nadie espere los 14 s. Una sola tarea en vuelo:
            # sin la bandera, diez visitas seguidas lanzan diez recálculos.
            if not _prof_refrescando:
                _prof_refrescando = True
                asyncio.create_task(_prof_refrescar())
            return JSONResponse(_prof_cache["datos"])
        # Más de 15 min: servir esto sería mentir. Se espera el cálculo.

    if _prof_lock is None:
        _prof_lock = asyncio.Lock()

    # El lock evita la estampida: sin él, N visitas simultáneas con la caché
    # fría lanzan N veces las mismas cinco consultas contra mysqld.
    async with _prof_lock:
        # Revalidar: mientras esperábamos el lock, otro pudo haberla llenado.
        ahora = time.time()
        if _prof_cache["datos"] is not None and ahora - _prof_cache["ts"] < _PROF_CACHE_TTL:
            return JSONResponse(_prof_cache["datos"])

        resp = await _backtesting_professional_calc()

        # Las respuestas de error NO se cachean: servir un error en frío
        # durante 45 s es peor que pagar el recálculo. La rama de except
        # marca estado="error", así que alcanza con mirar ese campo.
        try:
            datos = json.loads(resp.body)
            if datos.get("estado") != "error":
                _prof_cache["ts"]    = time.time()
                _prof_cache["datos"] = datos
        except Exception:
            pass   # si no se puede parsear, se devuelve igual y no se cachea

        return resp


# ── Rank IC: la medición que aprovecha los 13 instrumentos ──────────────────
#
# El acierto binario pregunta «¿acertó la dirección?» una decisión por vez, y
# tira los otros doce instrumentos de la ventana. El rank IC pregunta lo que el
# sistema decide desde el ranking transversal: «¿los ordenó bien entre sí?».
#
# La aritmética vive en `MIIA/rank_ic.py`, aparte y sin base de datos, para que
# `sim13_ensamble.py` pruebe el código que corre de verdad. Acá va sólo de dónde
# salen los números.
#
# LA DEFINICIÓN, que hay que dejar fija para que la serie signifique algo:
#
#   ventana     = una sesión de mercado.
#   predicción  = score medio de ESE instrumento en ESA sesión, HOLD incluidas.
#                 Se usan las HOLD a propósito: el score existe igual (el 93 %
#                 de las filas lo trae) y quedarse sólo con lo emitido deja la
#                 sección en los 2k que el ranking publica, que es justo la
#                 parte donde el orden ya se decidió. Con la sección truncada el
#                 IC mide otra cosa y da más alto.
#   realizado   = retorno relativo de la sesión SIGUIENTE: el del instrumento
#                 menos el promedio equiponderado de los 13 de esa sesión.
#   IC          = Spearman entre los dos ordenamientos.
#
# Las ventanas son NO SOLAPADAS por construcción: una por sesión, con horizonte
# de una sesión. Con RANK_IC_HORIZONTE > 1 se saltea de a H sesiones para que
# sigan sin solaparse — es el error que el 21-sep casi produce un hallazgo falso
# (t = −2,15 solapando, −0,23 sin solapar).
RANK_IC_DIAS      = 180   # cota de la consulta; la serie vive en el Excel
RANK_IC_HORIZONTE = 1     # sesiones hacia adelante


async def _rank_ic():
    """Calcula el rank IC sobre las sesiones con datos. Nunca tira excepción."""
    try:
        etfs  = tuple(sorted(_UNIVERSO))
        marks = ",".join(["%s"] * len(etfs))

        # `score` está SIEMPRE en NULL para lo viejo (0 de 102.971 filas de
        # septiembre): el número que toma la decisión sobrevivía sólo dentro de
        # una frase en castellano, «(ensemble=0.6123 > umbral=0.42)».
        # class25B ya lo escribe en la columna desde el corte del 12-oct, así
        # que el COALESCE de abajo es el puente entre las dos épocas y se puede
        # sacar cuando no queden filas viejas.
        #
        # Se extrae con SUBSTRING_INDEX y no con REGEXP_SUBSTR: las funciones de
        # texto son estándar y baratas; el regex de MySQL 8 es ICU y cambia de
        # comportamiento entre versiones. `LOCATE(...) > 0` en vez de `LIKE
        # '%…%'` porque esta consulta lleva parámetros y un `%` literal habría
        # que escribirlo `%%` — una fuente de errores mudos.
        filas = await db_exec(f"""
            SELECT DATE(ts_decision) AS dia, ticker,
                   AVG(CASE WHEN score IS NOT NULL THEN score
                            ELSE CAST(SUBSTRING_INDEX(
                                   SUBSTRING_INDEX(razon,'ensemble=',-1),' ',1)
                                 AS DECIMAL(10,6)) END) AS sc,
                   COUNT(*) AS n
            FROM cognitive_decisions
            WHERE ts_decision >= NOW() - INTERVAL %s DAY
              AND (temperatura IS NULL OR temperatura <> 'shadow')
              AND ticker IN ({marks})
              -- POST-CORTE SOLAMENTE. El rank IC pool-eaba 180 días = brazo de
              -- control (13 instrumentos, banda) + régimen nuevo (50, ranking),
              -- contra la regla «no mezclar antes y después del corte». La tesis
              -- ya filtra así (decision_modo); el rank IC no lo hacía, y por eso
              -- σ salía 0,30 —inflada por las ventanas de 13— y el ancho medio
              -- daba 21,5 en vez de 50 (medido 2-nov: 50 instrumentos/rueda
              -- post-corte, pero el promedio lo hundían las ventanas pre-corte).
              -- Con el filtro, σ refleja los 50 del régimen nuevo (~0,14).
              AND decision_modo = 'ranking'
              AND (score IS NOT NULL OR LOCATE('ensemble=', razon) > 0)
            GROUP BY DATE(ts_decision), ticker
            ORDER BY dia ASC
        """, (RANK_IC_DIAS,) + etfs) or []

        scores: dict = {}
        for r in filas:
            if r.get("sc") is None:
                continue
            scores.setdefault(str(r["dia"]), {})[str(r["ticker"])] = float(r["sc"])
        if not scores:
            return rank_ic.serie_ic([])

        # Retornos diarios por instrumento, de los cierres ya cacheados.
        series = await _cierres_diarios()
        rets: dict = {}
        for tk, serie in series.items():
            prev = None
            for f, pr in serie:
                if prev is not None and prev > 0:
                    rets.setdefault(f.strftime("%Y-%m-%d"), {})[tk] = pr / prev - 1.0
                prev = pr

        # ⚠️ Los días SIN SESIÓN hay que sacarlos, y no se ven solos. El sábado
        # y el domingo `precios` sigue teniendo filas —class7 publica igual,
        # ~15 mensajes por minuto— pero el precio no cambia, así que los 13
        # retornos dan 0 y el retorno relativo también. Una ventana así no tiene
        # orden que medir: el Spearman no existe, y si se la contara como
        # ventana válida con IC 0 diluiría el promedio hacia cero sin aportar
        # una sola observación. Medido sobre el volcado: 25 de 78 días.
        for d in [d for d, r in rets.items()
                  if not r or max(abs(x) for x in r.values()) == 0.0]:
            del rets[d]

        # ⚠️ La sesión de HOY no está cerrada (16-nov-2026). `_cierres_diarios`
        # trae «el último tick del día en curso», así que la ventana de ayer se
        # medía contra la rueda de hoy A MEDIO CAMINO: su IC cambiaba durante el
        # día (0,0161 → 0,0150 entre dos lecturas del mismo lunes) y el panel
        # publicaba un número que todavía no existía. Sólo sesiones cerradas.
        hoy = datetime.now().strftime("%Y-%m-%d")
        sesiones = sorted(d for d in rets if d < hoy)
        if len(sesiones) < 2:
            return rank_ic.serie_ic([])

        H = max(1, int(RANK_IC_HORIZONTE))
        ventanas, usada_hasta = [], ""
        # Diagnóstico de beta (16-nov-2026): el mismo IC contra el retorno
        # RESIDUAL (r − β·mercado), y cuánto sigue el IC de cada día al mercado.
        ventanas_res, ic_y_mercado = [], []
        # IC por régimen (16-nov-2026): el régimen es el de la sesión ANTERIOR a la
        # medida —lo que el sistema sabía al decidir—, por el promedio de los 50:
        # > +0,3 % alcista, < −0,3 % bajista, entre medio lateral.
        por_regimen: dict = {"alcista": [], "lateral": [], "bajista": []}
        for dia in sorted(scores):
            fut = [s for s in sesiones if s > dia][:H]
            if len(fut) < H:
                continue          # todavía no venció: no se inventa el futuro
            # Sin solape: lo que se compara es el PERÍODO REALIZADO, no el día
            # de la decisión. Con H = 1 las ventanas de dos días seguidos miden
            # sesiones distintas y las dos valen; con H = 2 la de mañana
            # compartiría una sesión con la de hoy y hay que saltearla. Mirar el
            # día en vez del período descartaba la mitad de la muestra.
            if fut[0] <= usada_hasta:
                continue
            # Retorno compuesto de las H sesiones, por instrumento. Sólo los que
            # cotizaron las H sesiones — un instrumento al que le falte un día
            # no es comparable con los demás.
            acum: dict = {}
            for i, s in enumerate(fut):
                for tk, r in rets[s].items():
                    if i == 0:
                        acum[tk] = 1.0 + r
                    elif tk in acum:
                        acum[tk] *= (1.0 + r)
                if i > 0:
                    acum = {t: v for t, v in acum.items() if t in rets[s]}
            brutos = {t: v - 1.0 for t, v in acum.items()}
            rel = rank_ic.retornos_relativos(brutos)
            seccion = [(tk, sc, rel[tk]) for tk, sc in scores[dia].items()
                       if tk in rel]
            if seccion:
                ventanas.append(seccion)
                usada_hasta = fut[-1]
                mkt = sum(brutos.values()) / len(brutos) if brutos else 0.0
                ic_d = rank_ic.ic_de_ventana(seccion)
                if ic_d is not None:
                    ic_y_mercado.append((ic_d, mkt))
                    previas = [d for d in sesiones if d < fut[0]]
                    if previas and rets.get(previas[-1]):
                        mp = sum(rets[previas[-1]].values()) / len(rets[previas[-1]]) * 100
                        por_regimen["alcista" if mp > 0.3 else "bajista" if mp < -0.3 else "lateral"].append(seccion)
                res = rank_ic.retornos_residuales(brutos, rank_ic.betas_previas(rets, fut[0]))
                sec_res = [(tk, sc, res[tk]) for tk, sc in scores[dia].items() if tk in res]
                if sec_res:
                    ventanas_res.append(sec_res)

        out = rank_ic.serie_ic(ventanas)
        # ⚠️ Leer junto al rank IC oficial. Si `rank_ic_corr_mercado` es alto
        # (|ρ| > ~0,5), el IC de cada día lo decide hacia dónde fue el mercado:
        # el ranking está ordenando por beta, y el promedio ~0 con σ ~0,3 es
        # eso, no ruido. El IC neutral a beta es el que mide selección.
        neutro = rank_ic.serie_ic(ventanas_res)
        out["rank_ic_beta_neutro"]                = neutro["rank_ic"]
        out["rank_ic_beta_neutro_desvio"]         = neutro["rank_ic_desvio"]
        out["rank_ic_beta_neutro_min_detectable"] = neutro["rank_ic_min_detectable"]
        out["rank_ic_beta_neutro_significativo"]  = neutro["rank_ic_significativo"]
        out["rank_ic_beta_neutro_ventanas"]       = neutro["rank_ic_ventanas"]
        rho = rank_ic.correlacion([a for a, _ in ic_y_mercado], [b for _, b in ic_y_mercado])
        out["rank_ic_corr_mercado"] = round(rho, 3) if rho is not None else None
        # Leer cada régimen con SU mínimo detectable: con pocas ruedas por régimen
        # el margen es enorme, y elegir el mejor de tres después de mirarlos es la
        # forma canónica de fabricar un falso positivo.
        out["rank_ic_por_regimen"] = {
            k: {kk: v[kk] for kk in ("rank_ic", "rank_ic_ventanas", "rank_ic_min_detectable", "rank_ic_significativo")}
            for k, v in ((k, rank_ic.serie_ic(vs)) for k, vs in por_regimen.items())
        }
        return out
    except Exception as e:
        log.warning("rank IC: %s", e)
        return rank_ic.serie_ic([])


def _t975(gl: int) -> float:
    """Cuantil 0,975 de la t de Student con `gl` grados de libertad (23-nov-2026).

    Sin scipy: integra la densidad con Simpson y busca por bisección. Con pocas
    ventanas de 48 h (13 en el volcado del 12-nov) el 1,96 de la normal se queda
    corto: con 12 grados de libertad el cuantil es 2,18.
    """
    if gl <= 0:
        return float("nan")
    if gl > 200:
        return 1.96
    c = math.exp(math.lgamma((gl + 1) / 2) - math.lgamma(gl / 2)) / math.sqrt(gl * math.pi)
    def pdf(x):
        return c * (1 + x * x / gl) ** (-(gl + 1) / 2)
    def cdf(x, n=400):
        h = x / n
        s_ = pdf(0) + pdf(x) + sum((4 if i % 2 else 2) * pdf(i * h) for i in range(1, n))
        return 0.5 + s_ * h / 3
    lo, hi = 0.0, 20.0
    for _ in range(50):
        m = (lo + hi) / 2
        if cdf(m) < 0.975:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def _ventaja_vs_azar(ok_buy, tot_buy, ok_sell, tot_sell):
    """La ventaja contra el AZAR con la misma mezcla de BUY y SELL (6-nov-2026).

    Función pura, sin base ni FastAPI: `sim38_ventaja_azar.js` la extrae de este
    archivo y la corre sola, junto con las dos copias de la web y del chat.

    POR QUÉ NO ALCANZA `base_rate`. `base_rate = max(subió, bajó) / total` es lo
    que acierta quien dice SIEMPRE la dirección que más salió en la muestra. Con
    la etiqueta relativa eso no es «el azar»: si los instrumentos que MIIA elige
    —los que compra Y los que vende— le ganan al promedio el 55 % de las veces,
    «decir siempre BUY» acierta 55 %. El ranking no puede seguir esa estrategia:
    compra los k mejores y vende los k peores, mitad y mitad por construcción.
    Y con «subió» de mayoría el edge viejo depende SÓLO del acierto de las SELL:

        edge_vs_baseline = (2·ok_sell − tot_sell) / total

    Las BUY no mueven ese número, acierten o no (la identidad de la novena
    lectura, al revés). Medido el 6-nov: BUY 59,0 %, SELL 48,8 %, mezcla 50/50
    → base 55,1 % y edge −1,2, aunque las compras acierten 9 pp más que el azar.

    LO QUE MIDE ESTO. El acierto que tendría un sistema SIN información con la
    misma proporción de BUY (q) sobre la misma proporción de «le ganó al
    promedio» (p): `azar = q·p + (1−q)·(1−p)` — el «acuerdo esperado por azar»
    de Cohen. La ventaja es `acierto − azar`, y se puede escribir así:

        edge_vs_azar = 4·q·(1−q) · (acierto_balanceado − 50)

    · con la mezcla 50/50 del ranking, azar = 50 y edge = acierto − 50;
    · la inclinación común (que los elegidos le ganen al promedio cualquiera sea
      la señal) se CANCELA: no premia ni castiga a MIIA por algo que no decide;
    · un sistema de un solo lado (97 % BUY) no puede mostrar ventaja aunque el
      mercado lo acompañe: es el «techo» de la tesis, que se conserva. Por eso
      NO se usa un 50 fijo: con 97 % BUY y cero habilidad, `acierto − 50` daría
      +4,7 pp sólo por la inclinación.

    `sesgo_comun` es esa inclinación: (acierto_BUY − acierto_SELL) / 2. No es
    MIIA: es cuánto le ganan al promedio, en general, los instrumentos elegidos.
    """
    n = (tot_buy or 0) + (tot_sell or 0)
    if n <= 0:
        return {"azar_mezcla": None, "edge_vs_azar": None,
                "acierto_balanceado": None, "sesgo_comun": None}
    q   = tot_buy / n
    p   = (ok_buy + (tot_sell - ok_sell)) / n          # le ganó al promedio
    acc = (ok_buy + ok_sell) / n
    azar = q * p + (1 - q) * (1 - p)
    out = {"azar_mezcla": round(azar * 100, 1),
           "edge_vs_azar": round((acc - azar) * 100, 1),
           "acierto_balanceado": None, "sesgo_comun": None}
    if tot_buy > 0 and tot_sell > 0:
        a_b, a_s = ok_buy / tot_buy, ok_sell / tot_sell
        out["acierto_balanceado"] = round((a_b + a_s) / 2 * 100, 1)
        out["sesgo_comun"]        = round((a_b - a_s) / 2 * 100, 1)
    return out


async def _backtesting_professional_calc():
    """Equity curve, CAGR, Sortino, Alpha, Beta, drawdown curve — métricas profesionales."""
    import math
    try:
        # retorno_dia = retorno de ESE día; retorno_promedio = acumulado por señal
        # de todo el historial. Para componer una equity curve hay que usar el
        # primero: componer el acumulado día a día reanualizaba el mismo número
        # N veces e inflaba CAGR/Alpha (ver class43.actualizarMetricas).
        stats_rows = await db_exec("""
            SELECT fecha, retorno_promedio, retorno_dia, muestras_dia,
                   sharpe, max_drawdown,
                   accuracy_global, precision_buy, precision_sell,
                   total_verificadas, correctas, incorrectas, pendientes
            FROM backtesting_stats
            ORDER BY fecha ASC LIMIT 120
        """) or []
        stats_rows = [_jsonable(dict(r)) for r in stats_rows]

        # Detectar estado "todo pendiente": todos los rows tienen accuracy=0 y retorno=0
        todo_pendiente = all(
            float(r.get("accuracy_global") or 0) == 0 and
            float(r.get("retorno_promedio") or 0) == 0
            for r in stats_rows
        ) if stats_rows else True

        # ── ORDEN 1: no mezclar poblaciones con etiquetas distintas ──────────
        # Desde el rediseño, el acierto se juzga contra el retorno RELATIVO
        # (ticker − promedio de los 13), cuyo base rate es ~50%. Las filas
        # anteriores se juzgaron contra el retorno ABSOLUTO, con base rate ~78%.
        # Promediar las dos daría un base_rate intermedio que no corresponde a
        # ninguna estrategia real, y un edge que no significa nada — el mismo
        # tipo de fallo silencioso que el resto de este módulo viene evitando.
        #
        # Se mide sobre UNA sola población: la relativa en cuanto tenga muestra
        # suficiente, la absoluta mientras tanto.
        MIN_FILAS_RELATIVO = 30
        modo_rows = await db_exec("""
            SELECT COALESCE(label_modo,'absoluto') AS modo, COUNT(*) AS n
            FROM cognitive_decisions
            -- `(temperatura IS NULL OR temperatura <> 'shadow')` y no
            -- `COALESCE(temperatura,'') <> 'shadow'`: son equivalentes —un NULL
            -- nunca iguala a 'shadow'— pero envolver la columna en una función
            -- anula cualquier índice. Es el mismo motivo por el que `label_modo`
            -- ya se comparaba sin COALESCE unas líneas más abajo; acá había
            -- quedado de la forma vieja en cinco consultas.
            WHERE outcome_real IN ('correcto','incorrecto')
              AND senal IN ('BUY','SELL')
              AND (temperatura IS NULL OR temperatura <> 'shadow')
            GROUP BY 1
        """) or []
        _por_modo = {str(r["modo"]): int(r["n"] or 0) for r in modo_rows}
        n_relativo = _por_modo.get("relativo", 0)
        n_absoluto = _por_modo.get("absoluto", 0)
        label_modo = "relativo" if n_relativo >= MIN_FILAS_RELATIVO else "absoluto"
        # Literal validado contra lista blanca (no interpolación de entrada).
        #
        # Sin COALESCE sobre la columna: envolverla en una función anula
        # cualquier índice y fuerza full scan. Las dos formas son EQUIVALENTES
        # —un NULL nunca iguala a 'relativo'— pero ésta es indexable.
        #
        # Nota sobre 'relativo_v1': las filas etiquetadas antes del fix del
        # universo del benchmark (15-ago-2026, mkt promediaba 18 tickers en vez
        # de 13) quedan marcadas así y el `= 'relativo'` exacto las deja afuera
        # solo. Es el mismo mecanismo con el que label_modo separó absoluto de
        # relativo: poblaciones medidas con criterios distintos no se mezclan.
        _filtro_modo = ("AND label_modo = 'relativo'"
                        if label_modo == "relativo"
                        else "AND (label_modo IS NULL OR label_modo = 'absoluto')")

        # ── decision_modo: los DOS BRAZOS del corte del 12-oct ───────────────
        #
        # `label_modo` separa con qué etiqueta se juzgó la fila. `decision_modo`
        # separa QUÉ REGLA la decidió: 'ranking' (BUY a los k mejores de la
        # sección transversal / SELL a los k peores) o 'banda' (el z contra el
        # neutro, la regla vieja). Son dos sistemas distintos, igual que
        # relativo y absoluto son dos preguntas distintas.
        #
        # ⚠️ LA COLUMNA SE AGREGÓ PARA ESTO Y EL ENDPOINT NO LA LEÍA. Sin este
        # filtro, a partir del 12-oct `accuracy`, `edge` y `n_efectivo` son un
        # promedio de los dos brazos — el mismo error que agregar 'relativo' con
        # 'absoluto', con la columna ya puesta al lado para evitarlo. Y es el
        # número que va al panel y a la hoja Tesis, así que la contaminación no
        # se ve: se lee como continuidad de la serie.
        #
        # Misma mecánica que label_modo: mientras el brazo nuevo no tenga muestra
        # se mide TODO (así la serie no se corta el día del corte, cuando
        # 'ranking' tiene 3 filas), y en cuanto la tenga se mide sólo el nuevo.
        # El valor vigente y los dos conteos van en el payload, para que el corte
        # de régimen sea visible en vez de silencioso.
        MIN_FILAS_RANKING = 30
        dec_rows = await db_exec("""
            SELECT COALESCE(decision_modo,'(sin marca)') AS modo, COUNT(*) AS n
            FROM cognitive_decisions
            WHERE outcome_real IN ('correcto','incorrecto')
              AND senal IN ('BUY','SELL')
              AND (temperatura IS NULL OR temperatura <> 'shadow')
            GROUP BY 1
        """) or []
        _por_dec = {str(r["modo"]): int(r["n"] or 0) for r in dec_rows}
        n_ranking = _por_dec.get("ranking", 0)
        n_banda   = _por_dec.get("banda", 0)
        n_sin_marca = _por_dec.get("(sin marca)", 0)
        decision_modo = "ranking" if n_ranking >= MIN_FILAS_RANKING else "todos"
        # Literal de lista blanca, no interpolación de entrada. Sin COALESCE
        # sobre la columna: envolverla anula el índice, y un NULL nunca iguala a
        # 'ranking' de todas formas.
        _filtro_dec = ("AND decision_modo = 'ranking'"
                       if decision_modo == "ranking" else "")

        # NO usar f-string acá: los comentarios SQL de abajo contienen `[{}]`,
        # que en una f-string se interpreta como expresión vacía y rompe el
        # parseo del módulo entero. El filtro se concatena al final.
        totals_rows = await db_exec("""
            SELECT COUNT(*) AS total,
                   SUM(outcome_real='correcto')   AS correctas,
                   SUM(outcome_real='incorrecto') AS incorrectas,
                   -- Pendientes: solo BUY/SELL — las HOLD no se trackean/verifican
                   SUM((outcome_real='pendiente' OR outcome_real IS NULL)
                       AND senal IN ('BUY','SELL')) AS pendientes,
                   -- Solo direccionales: los HOLD (~72% de la tabla) tienen
                   -- confianza ~46% por construcción y hundían el promedio.
                   AVG(CASE WHEN senal IN ('BUY','SELL') THEN confianza END) AS conf_prom,
                   SUM(senal IN ('BUY','SELL')) AS total_direccionales,
                   AVG(CASE WHEN senal = 'HOLD' THEN confianza END) AS conf_hold,
                   SUM(CASE WHEN outcome_real='correcto' AND senal='BUY'  THEN 1 ELSE 0 END) AS ok_buy,
                   SUM(CASE WHEN senal='BUY'  AND outcome_real IN ('correcto','incorrecto') THEN 1 ELSE 0 END) AS tot_buy,
                   SUM(CASE WHEN outcome_real='correcto' AND senal='SELL' THEN 1 ELSE 0 END) AS ok_sell,
                   SUM(CASE WHEN senal='SELL' AND outcome_real IN ('correcto','incorrecto') THEN 1 ELSE 0 END) AS tot_sell,
                   -- ── TAMAÑO DE MUESTRA EFECTIVO ──────────────────────────
                   -- Las decisiones NO son muestras independientes. Hoy todas
                   -- predicen el MISMO subyacente (el promedio de los ETFs: el
                   -- ticker se pierde en class19 y class43 las verifica contra
                   -- _marketRet) en ventanas de horizonte que se solapan casi
                   -- por completo. 1200 SELL en un día no son 1200 apuestas:
                   -- son ~1200 copias de la misma apuesta sobre la misma
                   -- ventana de mercado.
                   --
                   -- La unidad estadística real es (ventana de horizonte no
                   -- solapada × instrumento distinto). 172800 s = 48 h, que es
                   -- el horizonte modal que trackea class43.
                   --
                   -- Cuando se propague el ticker de punta a punta, este número
                   -- va a subir solo (hasta ~13× por ventana) — o sea que
                   -- también sirve para verificar que ese arreglo funcionó.
                   -- OJO: la columna es `ts_decision` (ver el INSERT de
                   -- class42.js). class43 la ve como `created_at` porque la
                   -- aliasea en su propio SELECT — usar ese nombre acá hace que
                   -- TODA esta query tire excepción y el `or [{}]` de abajo la
                   -- convierta en ceros, sin que se note en ningún lado.
                   COUNT(DISTINCT CASE
                       WHEN senal IN ('BUY','SELL')
                        AND outcome_real IN ('correcto','incorrecto')
                       THEN CONCAT(FLOOR(UNIX_TIMESTAMP(ts_decision)/172800),
                                   '|', COALESCE(ticker,'GENERAL'))
                   END) AS n_efectivo
            FROM cognitive_decisions
            -- Incluye las señales DIRECCIONALES del ensemble (class19, class18_vectorial,
            -- GENERAL): son la señal PRINCIPAL del sistema y class43 las verifica contra
            -- el retorno promedio de los ETFs (_marketRet). Excluirlas dejaba el edge
            -- vacío cuando el dataset es mayormente direccional (el caso normal).
            -- Excluye las SOMBRA: SELL que el gate de class25B suprimió y que se
            -- registran sólo para medir qué habrían hecho (no se emitieron nunca).
            WHERE (temperatura IS NULL OR temperatura <> 'shadow')
        """ + _filtro_modo + " " + _filtro_dec) or [{}]
        totals = _jsonable(dict(totals_rows[0])) if totals_rows else {}

        # Aciertos POR VENTANA DE 48 h (23-nov-2026), para la banda del acierto.
        # Los 50 instrumentos de una ventana comparten el mismo mercado: no son
        # 50 observaciones independientes. La banda sale del error ENTRE ventanas.
        ventanas_48h = await db_exec("""
            SELECT FLOOR(UNIX_TIMESTAMP(ts_decision)/172800) AS v,
                   SUM(outcome_real='correcto') AS ok,
                   COUNT(*) AS n
            FROM cognitive_decisions
            WHERE senal IN ('BUY','SELL')
              AND outcome_real IN ('correcto','incorrecto')
              AND (temperatura IS NULL OR temperatura <> 'shadow')
        """ + _filtro_modo + " " + _filtro_dec + """
            GROUP BY 1
        """) or []

        def sf(v):
            try: return float(v) if v is not None else 0.0
            except: return 0.0

        # ── VOLUMEN: sin filtrar por label_modo ──────────────────────────────
        # `total` y `pendientes` son conteos de VOLUMEN, no de medición, y no
        # deben filtrarse por etiqueta.
        #
        # El motivo: `label_modo` se escribe recién al VERIFICAR (en
        # actualizarOutcomeReal), así que toda fila pendiente lo tiene en NULL →
        # el COALESCE la manda a 'absoluto' → con el filtro 'relativo' quedaban
        # todas afuera. El panel habría mostrado "En tracking: 0" y "Señales
        # totales" cayendo de 34.000 a 3.000, que se lee como "el sistema dejó
        # de trackear" cuando en realidad sigue funcionando igual.
        #
        # Es exactamente el patrón que este módulo viene evitando: un número
        # plausible que mide otra cosa. La medición (accuracy, edge, precisión,
        # n_efectivo) SÍ se filtra — el volumen no.
        vol_rows = await db_exec("""
            SELECT COUNT(*) AS total,
                   SUM((outcome_real='pendiente' OR outcome_real IS NULL)
                       AND senal IN ('BUY','SELL')) AS pendientes
            FROM cognitive_decisions
            WHERE (temperatura IS NULL OR temperatura <> 'shadow')
        """) or [{}]
        vol = _jsonable(dict(vol_rows[0])) if vol_rows else {}

        total       = int(sf(vol.get("total", 0)))
        correctas   = sf(totals.get("correctas", 0))
        incorrectas = sf(totals.get("incorrectas", 0))
        pendientes  = int(sf(vol.get("pendientes", 0)))
        # `verificadas` SÍ queda sobre la población medida: es el tamaño de la
        # muestra sobre la que se calculan accuracy y edge, no un conteo de
        # volumen. Con la etiqueta relativa activa se lee como "de 34.000
        # decisiones totales, 3.000 están medidas bajo el criterio actual".
        verificadas = correctas + incorrectas
        ok_buy   = sf(totals.get("ok_buy", 0));   tot_buy  = sf(totals.get("tot_buy", 0))
        ok_sell  = sf(totals.get("ok_sell", 0));  tot_sell = sf(totals.get("tot_sell", 0))
        conf_prom = sf(totals.get("conf_prom", 0))

        # ── SKILL HONESTO vs. baseline ───────────────────────────────
        # En un mercado con tendencia, "acertar la dirección" se infla. El
        # benchmark honesto es "predecir SIEMPRE la dirección dominante": su
        # accuracy = base_rate. edge = accuracy de MIIA − base_rate (>0 = ventaja
        # real / skill; <=0 = no le gana al naive → sin ventaja demostrada).
        # Se deriva de los conteos: BUY correcto o SELL incorrecto ⇒ el mercado
        # subió; BUY incorrecto o SELL correcto ⇒ el mercado bajó.
        _tbs = tot_buy + tot_sell
        base_rate = edge_vs_baseline = accuracy_directional = None
        if _tbs > 0:
            _up   = ok_buy + (tot_sell - ok_sell)
            _down = (tot_buy - ok_buy) + ok_sell
            base_rate            = round(max(_up, _down) / _tbs * 100, 1)
            accuracy_directional = round((ok_buy + ok_sell) / _tbs * 100, 1)
            edge_vs_baseline     = round(accuracy_directional - base_rate, 1)

        # ── La ventaja contra el AZAR con la misma mezcla (6-nov-2026) ──────
        # Es la que muestra el panel. `base_rate` y `edge_vs_baseline` siguen
        # en el payload SIN CAMBIOS: los leen miia_check.sh, la hoja Tesis y la
        # lectura diaria, y cambiarles el significado cortaría esa serie en
        # silencio. Ver `_ventaja_vs_azar` para el porqué.
        _va = _ventaja_vs_azar(ok_buy, tot_buy, ok_sell, tot_sell)
        azar_mezcla  = _va["azar_mezcla"]
        edge_vs_azar = _va["edge_vs_azar"]

        # ── POTENCIA DE LA MEDICIÓN ──────────────────────────────────
        # Sin esto, `edge_vs_baseline = 0.0` es ambiguo entre dos cosas
        # completamente distintas:
        #   (a) "medimos bien y no hay ventaja"      → resultado real
        #   (b) "no tenemos muestra para ver nada"   → no es un resultado
        #
        # `n_efectivo` (ver la query) cuenta ventanas de 48 h no solapadas ×
        # instrumento, que es la unidad independiente de verdad. El intervalo
        # de Wilson se calcula sobre ESE n, no sobre el conteo de señales:
        # usar 22.772 señales correlacionadas daría un intervalo ~40× más
        # angosto que el real y convertiría ruido en "hallazgo".
        n_efectivo   = int(sf(totals.get("n_efectivo", 0)))
        n_redundancia = round(_tbs / n_efectivo, 1) if n_efectivo > 0 else None

        acc_ci_low = acc_ci_high = None
        edge_min_detectable = None
        edge_significativo  = None
        edge_azar_significativo = None
        n_ventanas_48h = None
        # ── LA BANDA, POR VENTANAS DE 48 h (23-nov-2026) ─────────────────────
        # Antes: Wilson sobre `n_efectivo`, o sea cada (ventana × instrumento)
        # como independiente. Pero los 50 instrumentos de una ventana comparten
        # el mismo mercado: medido sobre el volcado del 12-nov (`sim43`), el
        # efecto de diseño es ~2 y la banda real es 1,6 veces la de Wilson. Con
        # Wilson el panel daba +4,0 pp «significativo»; con el error entre
        # ventanas, +4,0 ± 6,0, no significativo. Ahora la unidad es la ventana
        # de 48 h: error estándar de conglomerados (estimador de razón) y t de
        # Student con G − 1 grados de libertad. Los nombres de los campos no
        # cambian: la web y el chat los leen igual.
        _vk = [(sf(r.get("ok")), sf(r.get("n"))) for r in ventanas_48h if sf(r.get("n")) > 0]
        _G = len(_vk)
        _N = sum(n for _, n in _vk)
        if _G >= 2 and _N > 0 and accuracy_directional is not None:
            n_ventanas_48h = _G
            _acc = sum(a for a, _ in _vk) / _N
            _var = _G / (_G - 1) * sum((a - _acc * n) ** 2 for a, n in _vk) / (_N * _N)
            _hw = _t975(_G - 1) * math.sqrt(_var)
            acc_ci_low  = max(0.0, _acc - _hw) * 100
            acc_ci_high = min(1.0, _acc + _hw) * 100
            # El edge más chico que esta medición distingue del azar.
            edge_min_detectable = round(_hw * 100, 1)
            # Test de una cola: hay ventaja sólo si la vara queda POR DEBAJO
            # de la banda del acierto (el 14-ago un test de dos colas mostraba
            # −28,8 pp como «ventaja demostrada»).
            edge_significativo = bool(acc_ci_low > base_rate)
            # Con la mezcla 50/50 del ranking el azar vale 50 sin error propio.
            if azar_mezcla is not None:
                edge_azar_significativo = bool(acc_ci_low > azar_mezcla)
            acc_ci_low  = round(acc_ci_low, 1)
            acc_ci_high = round(acc_ci_high, 1)

        precision_buy  = (ok_buy  / tot_buy  * 100) if tot_buy  > 0 else None
        precision_sell = (ok_sell / tot_sell * 100) if tot_sell > 0 else None

        # ── Equity curve desde cognitive_decisions (server-side) ─────
        # Antes se leía backtesting_stats.retorno_dia, que lo escribía el buffer
        # EN MEMORIA de class43 — y ese buffer solo veía el goteo de
        # verificaciones en vivo, no la reconciliación DB (que verifica el 95%).
        # Resultado: la curva quedaba trabada en 0 puntos para siempre.
        # Ahora se calcula del retorno REAL persistido por decisión, agrupado por
        # el día en que se midió el outcome:
        #   · signo por estrategia: una SELL gana cuando el precio BAJA → -retorno
        #   · shadow excluidas (nunca se emitieron)
        #   · mínimo 5 verificadas/día: por debajo, el promedio es ruido → se omite
        #     el día (no se rellena con 0, que aplanaría Sharpe/drawdown)
        dias_rows = await db_exec("""
            SELECT DATE(ts_outcome) AS dia,
                   AVG(CASE WHEN senal = 'SELL' THEN -retorno_real ELSE retorno_real END) AS ret_dia,
                   COUNT(*) AS n
            FROM cognitive_decisions
            WHERE outcome_real IN ('correcto','incorrecto')
              AND retorno_real IS NOT NULL
              AND senal IN ('BUY','SELL')
              AND (temperatura IS NULL OR temperatura <> 'shadow')
              AND ts_outcome IS NOT NULL
            GROUP BY DATE(ts_outcome)
            HAVING n >= 5
            ORDER BY dia ASC
        """) or []
        dias_reales = [
            (str(r["dia"]), float(r["ret_dia"]))
            for r in dias_rows
            if r.get("ret_dia") is not None
        ]

        # La performance de la ESTRATEGIA ahora vive en dias_reales (cognitive_
        # decisions), no en backtesting_stats. "Todo pendiente" = aún no hay ni un
        # día con retornos reales medidos → se muestra el proxy de mercado. El
        # cálculo original sobre backtesting_stats (arriba) queda obsoleto porque
        # esas filas tienen retorno_promedio=0 y darían todo_pendiente=True aunque
        # ya haya datos reales — lo que borraría la curva nueva.
        todo_pendiente = (len(dias_reales) == 0)

        equity_curve, bench_curve, drawdown_curve = [], [], []
        equity, bench = 100.0, 100.0
        bench_daily = (1.10 ** (1/252)) - 1
        peak_equity, max_dd = 100.0, 0.0

        for i, (_f, ret) in enumerate(dias_reales):
            equity *= (1 + ret)
            bench  *= (1 + bench_daily)
            equity_curve.append({"i": i, "v": round(equity - 100, 2)})
            bench_curve.append({"i":  i, "v": round(bench  - 100, 2)})
            if equity > peak_equity: peak_equity = equity
            dd = (equity - peak_equity) / peak_equity * 100
            drawdown_curve.append({"i": i, "v": round(dd, 2)})
            if dd < max_dd: max_dd = dd

        # ── Retorno ACUMULADO real, capturado ANTES del escalado anualizado ──
        # Más abajo la curva se escala para que su extremo valga el CAGR (así la
        # línea del benchmark es visible en el mismo eje). El frontend tomaba ESE
        # último punto y lo rotulaba "Retorno acumulado": con 60 días medidos
        # mostraba +25,37 % —que es el CAGR— cuando el acumulado real era +5,54 %.
        # El escalado es deliberado y se queda; lo que faltaba era tener el número
        # sin escalar para la tarjeta. 28-sep-2026.
        ret_acumulado = round(equity - 100, 2)

        # CAGR — anualizar exige historia real. Con 12 días el exponente es 21:
        # cualquier deriva diminuta se amplifica a dos dígitos. Se exigen 60
        # días medidos (~3 meses de mercado) antes de mostrar un anualizado;
        # por debajo el frontend muestra "–", que es la respuesta honesta.
        MIN_DIAS_CAGR = 60
        cagr = None
        n_days = len(dias_reales)
        if n_days >= MIN_DIAS_CAGR and equity > 0:
            try: cagr = round(((equity / 100) ** (252 / n_days) - 1) * 100, 2)
            except: pass

        # Sharpe and Sortino from individual returns.
        # Mínimo de días: con 2-3 retornos el ratio es puro ruido. Por debajo de
        # MIN_DIAS_RATIOS se muestra "–" (más honesto que un número inestable).
        MIN_DIAS_RATIOS = 10
        returns = [r for _f, r in dias_reales]
        sharpe_val, sortino_val, avg_ret = None, None, 0.0
        if returns:
            avg_ret = sum(returns) / len(returns)
        if len(returns) >= MIN_DIAS_RATIOS:
            var_all = sum((r - avg_ret)**2 for r in returns) / len(returns)
            std_all = math.sqrt(var_all) if var_all > 0 else 0
            if std_all > 0:
                sharpe_val = round(avg_ret / std_all * math.sqrt(252), 3)
            neg = [r for r in returns if r < 0]
            if neg:
                # Downside deviation estándar (Sortino): suma de retornos negativos
                # al cuadrado dividida por el TOTAL de períodos (no solo los negativos).
                down_var = sum(r**2 for r in neg) / len(returns)
                down_std = math.sqrt(down_var) if down_var > 0 else 0
                if down_std > 0:
                    sortino_val = round(avg_ret / down_std * math.sqrt(252), 3)
            elif std_all > 0:
                # Sin retornos negativos: no hay downside deviation → Sortino → +∞.
                # Centinela 999 = "∞" en el frontend. Antes se hacía Sharpe×3, que
                # fabricaba un valor finito arbitrario (contradecía "no fabricar métricas").
                sortino_val = 999.0 if avg_ret > 0 else None
        # NOTA: se eliminó el override `db_sharpe = stats_rows[-1].sharpe`. Tomaba
        # el Sharpe de class43 (capado a 10 y calculado sobre OTRA población, su
        # buffer en memoria) y pisaba el valor honesto de arriba — era el origen
        # del "Sharpe 10.00" que se veía con la estrategia sin datos.

        # Alpha y Beta reales por covarianza contra un proxy de mercado
        # (promedio equiponderado de los ETFs en `precios`, retornos diarios).
        # La fórmula anterior (beta=cagr/10, alpha=cagr-beta*10) daba alpha≡0
        # SIEMPRE por identidad algebraica — era una métrica fabricada.
        # Se exigen ≥5 días emparejados estrategia/mercado; si no hay histórico
        # suficiente se devuelve None y el frontend muestra "–".
        alpha, beta = None, None
        try:
            # Proxy de mercado solo con ETFs sectoriales (sin tickers custom del chat)
            _etfs  = tuple(sorted(_UNIVERSO))   # los 13 medibles, no los de texto
            _marks = ",".join(["%s"] * len(_etfs))
            # Cota temporal (solo rendimiento): sin ella agrupaba la historia
            # completa de `precios` —1.076 ms × 4.054 ejecuciones medidos el
            # 22-ago— para emparejar contra `dias_reales`, que sale de
            # backtesting_stats con LIMIT 120. Con 55 días en la tabla hoy no
            # excluye ninguna fila: está para que no se degrade al crecer.
            mkt_rows = await db_exec(f"""
                SELECT DATE(ts) AS f, AVG(change_pct) AS chg
                FROM precios
                WHERE change_pct IS NOT NULL
                  AND ts >= NOW() - INTERVAL %s DAY
                  AND ticker IN ({_marks})
                GROUP BY DATE(ts)
                ORDER BY f ASC
            """, (VENTANA_METRICAS_DIAS,) + _etfs) or []
            mkt = {str(r["f"]): float(r["chg"] or 0) / 100.0 for r in mkt_rows}
            # Emparejar SOLO días con retorno diario medido de ambos lados.
            # Antes se usaba retorno_promedio (acumulado por señal): ese valor
            # está clavado cerca de cero por construcción — lo dominan miles de
            # HOLD — mientras mb es un retorno de mercado genuino. El resultado
            # era alpha ≈ −beta × mercado: con el mercado subiendo, alpha caía
            # sin piso y NUNCA podía dar positivo. No medía la estrategia.
            pares = [(ret, mkt[f]) for f, ret in dias_reales if f in mkt]
            # 30 días emparejados: por debajo, la covarianza es ruido y el ×252
            # convierte ese ruido en un alpha de dos dígitos que parece real.
            MIN_PARES_ALPHA = 30
            if len(pares) >= MIN_PARES_ALPHA:
                sa = [a for a, _ in pares]; sb = [b for _, b in pares]
                ma, mb = sum(sa) / len(sa), sum(sb) / len(sb)
                cov  = sum((a - ma) * (b - mb) for a, b in pares) / len(pares)
                varb = sum((b - mb) ** 2 for b in sb) / len(sb)
                # Exigir retornos de estrategia REALES (no todos cero): sin señales
                # verificadas los retornos son 0 y beta/alpha darían 0.00 "calculado"
                # — un número sin significado que el frontend mostraría como real.
                hay_retornos = any(abs(a) > 1e-12 for a in sa)
                if varb > 1e-10 and hay_retornos:
                    beta  = round(cov / varb, 2)
                    # alpha anualizado en %: exceso de retorno diario × 252
                    alpha = round((ma - beta * mb) * 252 * 100, 2)
        except Exception as e:
            log.warning(f"alpha/beta: {e}")

        # 30d history table
        # Precisión = correctas / (correctas + incorrectas) — decisiones VERIFICADAS.
        # La columna total_verificadas de backtesting_stats en realidad guarda el
        # total de señales (incluye pendientes), no sirve como denominador.
        # Sin verificadas ese día → acc_pct None y el frontend muestra "–".
        hist_30d = []
        for row in list(reversed(stats_rows))[:30]:
            tot_s = int(row.get("total_verificadas") or 0)
            cor_v = int(row.get("correctas") or 0)
            inc_v = int(row.get("incorrectas") or 0)
            verif = cor_v + inc_v
            acc   = round(cor_v / verif * 100, 1) if verif > 0 else None
            hist_30d.append({"fecha": str(row.get("fecha","")), "total": tot_s,
                              "correctas": cor_v, "verificadas": verif, "acc_pct": acc})
        hist_30d.reverse()

        # ── Desglose de señales por tipo ────────────────────────
        signal_breakdown = []
        try:
            sb_rows = await db_exec("""
                SELECT senal, COUNT(*) AS n,
                       ROUND(AVG(confianza)*100,1) AS conf_avg,
                       SUM(outcome_real='correcto') AS correctas,
                       SUM(outcome_real='incorrecto') AS incorrectas,
                       SUM(outcome_real IS NULL OR outcome_real='pendiente') AS pendientes
                FROM cognitive_decisions
                WHERE ticker NOT LIKE 'class%' AND ticker <> 'GENERAL'
                GROUP BY senal
                ORDER BY n DESC
            """) or []
            signal_breakdown = [_jsonable(dict(r)) for r in sb_rows]
        except Exception: pass

        # ── Normalizar curvas a escala anualizada para que el benchmark SPY sea visible ──
        # Con pocos días de datos (ej. 4), la curva SPY crece ~0.15% mientras MIIA puede
        # ir a +8%. La escala 60:1 hace invisible la línea punteada. Solución: cuando hay
        # CAGR real, proyectar ambas curvas linealmente a su equivalente anual (CAGR% y 10%).
        if not todo_pendiente and cagr is not None and equity_curve:
            n_pts = len(equity_curve)
            spy_annual = 10.0
            # Escalar la curva REAL compuesta a su equivalente anualizado (endpoint = CAGR)
            # CONSERVANDO su forma (picos/valles). Antes se reemplazaba por una recta
            # cagr*(i+1)/n_pts, lo que borraba la volatilidad real y forzaba drawdown ≡ 0.
            final_v = equity_curve[-1]["v"]
            escala  = (cagr / final_v) if abs(final_v) > 1e-9 else 0.0
            equity_curve = [{"i": p["i"], "v": round(p["v"] * escala, 2)} for p in equity_curve]
            bench_curve  = [{"i": i, "v": round(spy_annual * (i + 1) / n_pts, 2)} for i in range(n_pts)]
            # ⚠️ El DRAWDOWN no se re-escala, y esto es un arreglo (28-sep-2026).
            # Antes se recalculaba desde la curva ya escalada, así que el gráfico
            # bajaba a −7,0 % mientras la tarjeta mostraba −2,4 % — que es el
            # valor REAL, porque `max_dd` sale del loop de arriba y nunca se
            # escala. O sea que la tarjeta contradecía a su propio gráfico.
            # `drawdown_curve` ya viene de ese mismo loop: misma fuente que
            # `max_drawdown`, que es justo lo que el comentario de la tarjeta
            # («la tarjeta y la curva usan la MISMA fuente») decía que pasaba.

        # ── Equity curve desde precios cuando backtesting_stats es todo-cero ─
        # Resetear equity_curve: las 2 rows de backtesting_stats tienen retorno=0 → curva plana
        # En su lugar usamos el cambio real de los ETFs en precios como proxy
        if todo_pendiente:
            equity_curve, bench_curve, drawdown_curve = [], [], []
            try:
                # change_pct ya en % (2.57 = 2.57%). Agrupar por fecha+hora sin DATE_FORMAT
                # (DATE_FORMAT con %Y falla en aiomysql con params vacíos)
                price_rows = await db_exec("""
                    SELECT DATE(ts) AS fecha, HOUR(ts) AS hora_n,
                           ROUND(AVG(change_pct), 4) AS chg_pct_avg
                    FROM precios
                    WHERE ts > DATE_SUB(NOW(), INTERVAL 48 HOUR)
                      AND change_pct IS NOT NULL
                    GROUP BY fecha, hora_n
                    ORDER BY fecha ASC, hora_n ASC
                    LIMIT 50
                """) or []
                if price_rows and len(price_rows) > 1:
                    eq_proxy, bch_proxy = 100.0, 100.0
                    bch_hourly = (1.10 ** (1/252/24)) - 1
                    for i, pr in enumerate(price_rows):
                        chg_pct = float(pr.get("chg_pct_avg") or 0)
                        chg = chg_pct / 100.0  # % → decimal
                        eq_proxy  *= (1 + chg)
                        bch_proxy *= (1 + bch_hourly)
                        equity_curve.append({"i": i, "v": round(eq_proxy - 100, 3)})
                        bench_curve.append({"i": i, "v": round(bch_proxy - 100, 3)})
                    log.info(f"Equity curve proxy: {len(equity_curve)} pts desde precios (chg_avg={chg_pct:.2f}%)")
            except Exception as e:
                log.warning(f"equity curve proxy: {e}")

        # Forzar nulls en métricas de precisión cuando todo está pendiente
        if todo_pendiente:
            sharpe_val   = None
            sortino_val  = None
            cagr         = None

        # ── Métricas proxy del MERCADO en tiempo real ────────────────
        # Mientras no haya señales verificadas, Sharpe/Sortino/CAGR/Drawdown
        # de la ESTRATEGIA no existen (serían fabricados). Para que el panel
        # muestre valores reales en vivo, se calculan las métricas del MERCADO
        # (canasta equiponderada de los ETFs del sistema, retornos diarios de
        # `precios`) y el frontend las etiqueta claramente como "mercado (proxy)"
        # — el mismo criterio que ya usa la equity curve.
        proxy = None
        try:
            if sharpe_val is None or cagr is None:
                rets = await _retornos_diarios_mercado()
                if len(rets) >= 2:
                    mmean = sum(rets) / len(rets)
                    var   = sum((x - mmean) ** 2 for x in rets) / len(rets)
                    p_sharpe = round(mmean / (var ** 0.5) * (252 ** 0.5), 2) if var > 0 else None
                    neg = [x for x in rets if x < 0]
                    p_sortino = None
                    if neg:
                        dvar = sum(x * x for x in neg) / len(neg)
                        if dvar > 0:
                            p_sortino = round(mmean / (dvar ** 0.5) * (252 ** 0.5), 2)
                    eq, peak, mdd = 1.0, 1.0, 0.0
                    for x in rets:
                        eq *= (1 + x)
                        peak = max(peak, eq)
                        mdd  = min(mdd, (eq - peak) / peak)
                    dias   = len(rets)
                    p_cagr = round((eq ** (252.0 / dias) - 1) * 100, 2)
                    proxy = {"sharpe": p_sharpe, "sortino": p_sortino, "cagr": p_cagr,
                             "max_drawdown": round(abs(mdd) * 100, 2), "dias": dias}
        except Exception as e:
            log.warning(f"proxy metrics: {e}")

        # ── Max drawdown desde la equity curve REAL ──────────────────
        # max_dd se calcula arriba sobre la curva compuesta de dias_reales
        # (cognitive_decisions). Antes se prefería stats_rows[-1].max_drawdown,
        # pero ese valor sale del buffer en memoria de class43 (otra población,
        # cap-prone) y contradecía la curva mostrada. Ahora la tarjeta y la curva
        # usan la MISMA fuente.
        max_dd_pct = round(abs(max_dd), 2)

        # ── Rank IC — el detector principal desde el corte del 12-oct ─
        # Va DENTRO de este endpoint y no en uno propio por una razón concreta:
        # class30 no es un proxy con comodín — su ruteo a Python es una lista
        # explícita endpoint por endpoint (`class30.js:686`), y agregar una ruta
        # exige reiniciar el orquestador entero. Un `/api/backtesting/rank_ic`
        # daría 404 desde el navegador, igual que le pasó a
        # `/api/portfolio/rendimiento` el 21-sep.
        #
        # El costo es una consulta más sobre `cognitive_decisions`, acotada a
        # RANK_IC_DIAS y por lo tanto indexable con `idx_ventana_ticker`. Con el
        # stale-while-revalidate de arriba, nadie la espera.
        ric = await _rank_ic()

        equity_annualized = (not todo_pendiente and cagr is not None and bool(equity_curve))
        return JSONResponse({
            "proxy":              proxy,
            "sharpe":             sharpe_val,
            "sortino":            sortino_val,
            "cagr":               cagr,
            # Sin señales verificadas no hay drawdown ni retorno medidos:
            # None → el frontend muestra "–" (0.0 significaría "medido y es cero")
            "max_drawdown":       max_dd_pct if not todo_pendiente else None,
            # Retorno acumulado del período medido, SIN anualizar. La tarjeta
            # "Retorno acumulado" tiene que leer este campo y NO el último punto
            # de `equity_curve`, que va escalado a % anualizado (ver arriba).
            "retorno_acumulado":  ret_acumulado if not todo_pendiente else None,
            "alpha":              alpha,
            "beta":               beta,
            "precision_buy":      round(precision_buy, 1)  if precision_buy  is not None else None,
            "precision_sell":     round(precision_sell, 1) if precision_sell is not None else None,
            # Skill honesto: accuracy vs. "predecir siempre la dirección dominante"
            "base_rate":            base_rate,             # accuracy del naive (benchmark)
            "accuracy_directional": accuracy_directional,  # accuracy de MIIA (direccional)
            "edge_vs_baseline":     edge_vs_baseline,       # vs. «decir siempre la dirección más común» (serie vieja)
            # La ventaja que muestra el panel desde el 6-nov: contra el azar con
            # la misma mezcla BUY/SELL. Con el ranking (50/50) es acierto − 50.
            "azar_mezcla":          azar_mezcla,            # % que acierta un sistema sin información con esa mezcla
            "edge_vs_azar":         edge_vs_azar,           # acierto − azar_mezcla
            "edge_azar_significativo": edge_azar_significativo,  # azar_mezcla por debajo del IC
            "acierto_balanceado":   _va["acierto_balanceado"],   # (acierto BUY + acierto SELL) / 2
            "sesgo_comun":          _va["sesgo_comun"],     # pp que los elegidos le ganan al promedio, cualquiera sea la señal
            # ── Potencia de la medición ──────────────────────────────
            # Leer SIEMPRE el edge junto a estos campos. `edge_vs_baseline`
            # solo,  sin `n_efectivo` y `edge_min_detectable`, no distingue
            # "no hay ventaja" de "no hay muestra".
            "n_efectivo":           n_efectivo,           # ventanas 48h × instrumento
            "n_redundancia":        n_redundancia,        # señales por muestra independiente
            # ── ORDEN 1: contra qué se está midiendo ──────────────────────
            # "relativo" → ¿el ticker le ganó al promedio de los 13? base ~50%
            # "absoluto" → ¿subió el mercado? base ~78% (población pre-rediseño)
            # Sin este campo, un base_rate de 50% y uno de 78% se verían iguales
            # en el panel y no habría forma de saber cuál se está leyendo.
            "label_modo":           label_modo,
            "n_label_relativo":     n_relativo,
            "n_label_absoluto":     n_absoluto,
            # Los dos brazos del corte del 12-oct. `decision_modo` dice sobre
            # cuál se está midiendo: "todos" mientras el brazo nuevo no tenga
            # muestra, "ranking" en cuanto la tenga. Leer el edge sin mirar esto
            # es leer un promedio de dos sistemas distintos.
            "decision_modo":        decision_modo,
            "n_dec_ranking":        n_ranking,
            "n_dec_banda":          n_banda,
            "n_dec_sin_marca":      n_sin_marca,
            "n_ventanas_48h":       n_ventanas_48h,       # unidad de la banda (23-nov)
            "accuracy_ci_low":      acc_ci_low,           # Wilson 95% sobre n_efectivo
            "accuracy_ci_high":     acc_ci_high,
            "edge_min_detectable":  edge_min_detectable,  # pp: por debajo de esto es ruido
            "edge_significativo":   edge_significativo,   # base_rate fuera del IC
            "total_decisiones":   total,
            "verificadas":        int(verificadas),
            "pendientes":         pendientes,
            "retorno_promedio":   round(avg_ret, 6) if not todo_pendiente else None,
            # Confianza de las señales DIRECCIONALES (BUY/SELL), no de la tabla
            # entera. Se exponen también el desglose y el conteo para que el
            # panel pueda decir sobre qué población está midiendo.
            "confianza_promedio": round(conf_prom * 100, 1) if conf_prom else None,
            "confianza_hold":     round(sf(totals.get("conf_hold", 0)) * 100, 1) or None,
            "total_direccionales": int(sf(totals.get("total_direccionales", 0))),
            "dias_medidos":       n_days,
            "dias_min_cagr":      MIN_DIAS_CAGR,
            "equity_curve":       equity_curve,
            "benchmark_curve":    bench_curve,
            "drawdown_curve":     drawdown_curve,
            "historial_30d":      hist_30d,
            "signal_breakdown":   signal_breakdown,
            "estado":             "pending" if todo_pendiente else "ok",
            "equity_proxy":       todo_pendiente and len(equity_curve) > 0,
            "equity_annualized":  equity_annualized,
            # ── Rank IC ──────────────────────────────────────────────
            # `rank_ic` · `rank_ic_desvio` · `rank_ic_ventanas` · `rank_ic_t` ·
            # `rank_ic_min_detectable` · `rank_ic_significativo` ·
            # `rank_ic_instrumentos` · `rank_ic_serie`.
            #
            # ⚠️ Leerlo como se lee el edge: `rank_ic` SOLO, sin
            # `rank_ic_min_detectable`, no distingue «no ordena» de «no hay
            # muestra». Con 13 instrumentos el MDE en 44 ruedas es 0,082 y el IC
            # en juego es ~0,040: hasta marzo lo esperable es NO concluyente.
            **ric,
        })
    except Exception as e:
        # Traceback COMPLETO a archivo: los logs de pm2 están desactivados en el
        # server (llenan memoria), así que un `log.warning` con solo el mensaje
        # dejaba el fallo invisible y obligaba a subir scripts de diagnóstico.
        _log_error_endpoint("/api/backtesting/professional", e)
        return JSONResponse({"sharpe": None, "sortino": None, "cagr": None,
                             "equity_curve": [], "drawdown_curve": [], "benchmark_curve": [],
                             "signal_breakdown": [], "estado": "error", "equity_proxy": False,
                             # Tipo de excepción (no el mensaje: puede llevar SQL
                             # o rutas internas). Suficiente para orientar sin
                             # exponer nada en un endpoint público.
                             "error_tipo": type(e).__name__})

# ══════════════════════════════════════════════════════════════════
# /api/portfolio/rendimiento — ¿los portafolios le ganan al mercado?
# ══════════════════════════════════════════════════════════════════
# Por qué existe: hasta el 21-sep-2026 el sistema no tenía NINGUNA medición de
# lo que rinden sus portafolios. `portfolio_transactions` y
# `performance_snapshots` están vacías desde el primer día — class15 generó
# 97.151 portafolios y ninguno se ejecutó ni se siguió en el tiempo. Lo único
# que mostraba el panel era `interes_anual_pct`: el retorno PASADO de la canasta
# extrapolado a un año con (1+r)^(365/días). Sobre los 2.489 que lo tienen
# calculado da mediana +39,5 % y máximo +212,9 % anual — el doble y diez veces
# el historial de Buffett. No es un rendimiento: es un artefacto de anualizar
# una ventana de tres meses.
#
# Acá se mide lo que sí se puede afirmar:
#   · un portafolio por sesión (el último generado antes del cierre),
#   · su retorno a 1, 5 y 20 sesiones,
#   · contra la canasta equiponderada de los 13 y contra el S&P 500,
#   · con la banda de error al lado de CADA número.
#
# NO vive en class15 a propósito, por dos razones. La de diseño: el que arma
# los portafolios no puede ser el que se califica a sí mismo. La operativa:
# class15 NO está en CRITICAL_LABELS (`operador/index.js:185`), así que
# desplegarlo exige reiniciar el orquestador entero; a este proceso lo relanza
# app.py en ~20 s sin tocar a class44 ni a las redes.
#
# TRAMPA de `portfolio_assets`: el ticker NO está en la columna `ticker` —vale
# '' o NULL en las 776.923 filas— sino en `symbol`. Costó una ronda de
# depuración el 21-sep-2026.
#
# Los números que devuelve se validan contra
# `docs/simulaciones/sim5_rendimiento_portafolios.py`, que corre el mismo
# cálculo sobre un volcado local.

# Pesos aproximados del S&P 500 por sector, renormalizados sobre los 10 SPDR
# que MIIA cotiza. FALTA XLP (consumo básico, ~5 % del índice), y los pesos son
# de referencia, no los oficiales del día: por eso el campo se llama
# `sp500_aprox` y el panel lo rotula "aprox.". Sirve de vara, no de benchmark.
_SP_PESOS = {"XLK": 33.0, "XLF": 14.0, "XLV": 10.0, "XLY": 10.0, "XLC": 10.0,
             "XLI": 8.0, "XLE": 3.0, "XLU": 2.5, "XLRE": 2.0, "XLB": 2.0}
# Los medibles, del universo compartido. El nombre dice 13 por costumbre;
# después del 12-oct van a ser 100 y el código no cambia.
_CANASTA_13 = _UNIVERSO
_HORIZONTES = (1, 5, 20)
_SESIONES_ANIO = 252

_REND_CACHE_TTL = 300          # un cierre diario no cambia en 5 min
_rend_cache: dict = {"ts": 0.0, "datos": None}
_rend_lock = None


def _banda95(v):
    """(media, semiancho al 95 %, t de Student). Con n < 2 no hay banda."""
    n = len(v)
    if n == 0:
        return None, None, None
    m = sum(v) / n
    if n < 2:
        return m, None, None
    sd = (sum((x - m) ** 2 for x in v) / (n - 1)) ** 0.5
    ee = sd / (n ** 0.5)
    if ee <= 0:
        return m, 0.0, None
    return m, 1.96 * ee, m / ee


async def _rendimiento_cacheado():
    """El cálculo con caché de 5 min. Lo comparten el endpoint de abajo y
    /api/portfolio, que hoy es el único de los dos que llega al navegador."""
    global _rend_lock
    ahora = time.time()
    if _rend_cache["datos"] is not None and ahora - _rend_cache["ts"] < _REND_CACHE_TTL:
        return _rend_cache["datos"]
    if _rend_lock is None:
        _rend_lock = asyncio.Lock()
    async with _rend_lock:
        ahora = time.time()
        if _rend_cache["datos"] is not None and ahora - _rend_cache["ts"] < _REND_CACHE_TTL:
            return _rend_cache["datos"]
        datos = await _rendimiento_portafolios_calc()
        if datos.get("estado") != "error":
            _rend_cache.update({"ts": time.time(), "datos": datos})
        return datos


@app.get("/api/portfolio/rendimiento")
async def portfolio_rendimiento():
    """⚠️ Hoy este path NO llega desde miiaia.com: da 404.

    class30 no es un proxy con comodín — su ruteo a Python es una lista
    explícita endpoint por endpoint (`class30.js:686` y alrededores), y
    `/api/portfolio/rendimiento` no está en ella. Verificado en producción el
    21-sep-2026: `curl localhost:5005/api/portfolio/rendimiento` devuelve el
    JSON, y `fetch('/api/portfolio/rendimiento')` desde la página devuelve 404.

    Agregar la ruta en class30 exige reiniciar el orquestador ENTERO, porque
    class30 no está en CRITICAL_LABELS: eso cuesta los vectores pendientes de
    class24, la cola de snapshots de class25A y la ventana del neutro. No vale
    la pena por una ruta. Por eso el panel lee el mismo dato desde
    `/api/portfolio`, que sí está ruteado.

    Este endpoint queda para diagnóstico desde el server y para cuando class30
    sume la ruta, en el corte de después del 12-oct.
    """
    return JSONResponse(await _rendimiento_cacheado())


async def _rendimiento_portafolios_calc():
    try:
        marks = ",".join(["%s"] * len(_CANASTA_13))
        # Cierre diario = último precio de cada día hábil hasta las 22:00 hora
        # del server. El NYSE cierra 16:00 de Nueva York = 17:00 en Argentina =
        # 22:00 CEST. Sin ese corte entran escrituras de after-hours y el
        # "cierre" deja de ser el cierre.
        #
        # OJO con el cambio de horario: Europa sale del horario de verano el
        # 25-oct y EE.UU. el 1-nov. Entre esas dos fechas el cierre cae 21:00
        # en el server. El corte de 22:00 sigue siendo válido (toma de más, no
        # de menos), pero si alguna vez se afina, tenerlo presente.
        filas = await db_exec(f"""
            SELECT t.ticker, t.f, p.precio
            FROM (SELECT ticker, DATE(ts) AS f, MAX(ts) AS mx
                  FROM precios
                  WHERE precio IS NOT NULL AND precio > 0
                    AND ts >= NOW() - INTERVAL %s DAY
                    AND TIME(ts) <= '22:00:00'
                    AND DAYOFWEEK(ts) BETWEEN 2 AND 6
                    AND ticker IN ({marks})
                  GROUP BY ticker, DATE(ts)) t
            JOIN precios p ON p.ticker = t.ticker AND p.ts = t.mx
            ORDER BY t.f
        """, (VENTANA_METRICAS_DIAS,) + _CANASTA_13) or []

        cierre: dict = {}
        for r in filas:
            cierre.setdefault(r["ticker"], {})[str(r["f"])] = float(r["precio"])
        if len(cierre) < len(_CANASTA_13):
            return {"estado": "sin_datos", "motivo": "faltan tickers en `precios`",
                    "tickers_con_precio": sorted(cierre)}

        # Sesión = día con cierre de LOS 13. Si falta uno, la canasta de ese día
        # no es comparable con la de los otros y la ventana se descarta entera.
        ses = sorted(set.intersection(*[set(v) for v in cierre.values()]))
        idx = {f: i for i, f in enumerate(ses)}
        if len(ses) < 5:
            return {"estado": "sin_datos", "motivo": "menos de 5 sesiones completas",
                    "sesiones": len(ses)}

        def ret(tk, a, b):
            pa, pb = cierre[tk].get(a), cierre[tk].get(b)
            return None if not pa or not pb or pa <= 0 else pb / pa - 1.0

        def ret_cesta(tks, a, b, pesos=None):
            v = [(tk, ret(tk, a, b)) for tk in tks]
            v = [(tk, x) for tk, x in v if x is not None]
            if not v:
                return None
            if pesos is None:
                return sum(x for _, x in v) / len(v)
            tot = sum(pesos[tk] for tk, _ in v)
            return sum(pesos[tk] * x for tk, x in v) / tot if tot > 0 else None

        # Un portafolio por sesión: el último generado antes del cierre.
        port = await db_exec("""
            SELECT p.portfolio_id, DATE(p.ts) AS f
            FROM portfolios p
            JOIN (SELECT DATE(ts) AS f, MAX(ts) AS mx
                  FROM portfolios
                  WHERE ts >= NOW() - INTERVAL %s DAY AND TIME(ts) <= '22:00:00'
                  GROUP BY DATE(ts)) u ON u.mx = p.ts
        """, (VENTANA_METRICAS_DIAS,)) or []
        del_dia = {str(r["f"]): r["portfolio_id"] for r in port if r["portfolio_id"]}

        activos: dict = {}
        ids = tuple(sorted({pid for f, pid in del_dia.items() if f in idx}))
        if ids:
            m2 = ",".join(["%s"] * len(ids))
            # `symbol`, NO `ticker`: ver la trampa documentada arriba.
            for r in await db_exec(f"""
                SELECT portfolio_id, symbol FROM portfolio_assets
                WHERE portfolio_id IN ({m2}) AND symbol IS NOT NULL AND symbol <> ''
            """, ids) or []:
                activos.setdefault(r["portfolio_id"], []).append(r["symbol"])

        horizontes, exceso_1s = [], []
        for h in _HORIZONTES:
            dif_c, dif_s, rp_l, rc_l, rs_l = [], [], [], [], []
            dif_indep = []          # ventanas que NO se solapan (paso de h sesiones)
            for f in ses:
                i = idx[f]
                if i + h >= len(ses):
                    continue
                b = ses[i + h]
                tks = [t for t in activos.get(del_dia.get(f, ""), []) if t in cierre]
                if len(tks) < 4:          # un portafolio de menos de 4 activos no es una cartera
                    continue
                rp = ret_cesta(tks, f, b)
                rc = ret_cesta(_CANASTA_13, f, b)
                rs = ret_cesta(list(_SP_PESOS), f, b, _SP_PESOS)
                if rp is None or rc is None or rs is None:
                    continue
                rp_l.append(rp * 100); rc_l.append(rc * 100); rs_l.append(rs * 100)
                dif_c.append((rp - rc) * 100); dif_s.append((rp - rs) * 100)
                if i % h == 0:
                    dif_indep.append((rp - rc) * 100)
                if h == 1:
                    exceso_1s.append(rp - rc)
            if not dif_c:
                continue
            mc, bc, tc = _banda95(dif_c)
            ms, bs, _ = _banda95(dif_s)
            # La significancia sale SIEMPRE de las ventanas independientes.
            # Con las solapadas, el 21-sep-2026 el horizonte de 20 sesiones daba
            # t = -2,15 sobre 36 ventanas: pasaría por significativo, pero esas
            # 36 ventanas comparten 19 sesiones de 20 con su vecina y en realidad
            # son ~2,8 observaciones. Publicar ese -2,15 como hallazgo sería
            # exactamente el error que este endpoint existe para no cometer.
            _, bi, ti = _banda95(dif_indep)
            signif = bool(ti is not None and abs(ti) > 1.96 and len(dif_indep) >= 5)
            horizontes.append({
                "sesiones": h, "n": len(dif_c),
                "portafolio_pct": round(sum(rp_l) / len(rp_l), 4),
                "canasta_pct":    round(sum(rc_l) / len(rc_l), 4),
                "sp500_pct":      round(sum(rs_l) / len(rs_l), 4),
                "dif_canasta_pct": round(mc, 4),
                "banda_canasta":   round(bc, 4) if bc is not None else None,
                "dif_sp500_pct":   round(ms, 4),
                "banda_sp500":     round(bs, 4) if bs is not None else None,
                "gana_canasta_pct": round(sum(1 for x in dif_c if x > 0) / len(dif_c) * 100, 1),
                # `t` sale de las ventanas solapadas y es OPTIMISTA: se informa
                # para poder comparar con el script offline, no para decidir.
                "t": round(tc, 2) if tc is not None else None,
                "ventanas_solapadas": h > 1,
                "n_independiente": len(dif_indep),
                "t_independiente": round(ti, 2) if ti is not None else None,
                "banda_independiente": round(bi, 4) if bi is not None else None,
                "significativo": signif,
            })

        # Alfa anualizado: SIEMPRE con su t al lado. Un alfa sin t no significa
        # nada — sobre 55 sesiones este mismo cálculo dio +7,5 % con t = 0,79.
        alfa = None
        if len(exceso_1s) >= 5:
            m, _, t = _banda95(exceso_1s)
            sd = (sum((x - m) ** 2 for x in exceso_1s) / (len(exceso_1s) - 1)) ** 0.5
            vol_an = sd * (_SESIONES_ANIO ** 0.5) * 100
            alfa = {
                "anual_pct": round(m * _SESIONES_ANIO * 100, 2),
                "volatilidad_anual_pct": round(vol_an, 2),
                "t": round(t, 2) if t is not None else None,
                "significativo": bool(t is not None and abs(t) > 1.96),
                "sesiones": len(exceso_1s),
                # Cuánto alfa haría falta para que ESTA cantidad de sesiones lo
                # distinga del azar. Es el equivalente de `edge_min_detectable`
                # de la tesis, y es el número que dice si la pregunta se puede
                # contestar con los datos que hay.
                "min_detectable_anual_pct": round(
                    1.96 * vol_an / ((len(exceso_1s) / _SESIONES_ANIO) ** 0.5), 1),
            }

        # ── TODOS los portafolios de la base, no uno por sesión ─────────────
        # La lectura completa que pidió Martín. Dos cuidados:
        #
        # 1. COSTO. Traer los 97.151 portafolios con sus 776.923 activos cada
        #    vez sería absurdo, así que la consulta agrupa EN SQL y devuelve un
        #    renglón por (sesión, composición) con cuántas copias tiene: ~1.086
        #    renglones, porque class15 repite la misma cartera unas 57 veces.
        #
        # 2. HONESTIDAD. Esas 57 copias NO son 57 observaciones. Se informan
        #    las tres bandas —la ingenua que las trata como independientes, la
        #    de una por sesión y la de ventanas sin solapar— justamente para que
        #    se vea la diferencia: a 20 sesiones la ingenua sale 194 veces más
        #    angosta y convertiría un resultado sin significancia en un hallazgo
        #    aplastante. El veredicto sale SIEMPRE de la última.
        universo = None
        try:
            filas_u = await db_exec("""
                SELECT f, comp, COUNT(*) AS n FROM (
                    SELECT DATE(p.ts) AS f, p.portfolio_id,
                           GROUP_CONCAT(a.symbol ORDER BY a.symbol) AS comp
                    FROM portfolios p
                    JOIN portfolio_assets a ON a.portfolio_id = p.portfolio_id
                    WHERE p.ts >= NOW() - INTERVAL %s DAY
                      AND TIME(p.ts) <= '22:00:00'
                      AND a.symbol IS NOT NULL AND a.symbol <> ''
                    GROUP BY p.portfolio_id, DATE(p.ts)
                ) x GROUP BY f, comp
            """, (VENTANA_METRICAS_DIAS,)) or []
            tot_row = await db_exec("SELECT COUNT(*) AS n FROM portfolios") or []

            por_ses: dict = {}
            medidos = 0
            for r_ in filas_u:
                f_ = str(r_["f"])
                if f_ not in idx:
                    continue
                tks = tuple(t for t in (r_["comp"] or "").split(",") if t in cierre)
                if len(tks) < 4:
                    continue
                n_ = int(r_["n"])
                medidos += n_
                por_ses.setdefault(f_, []).append((tks, n_))

            hz = []
            for h in _HORIZONTES:
                sn = snd = snd2 = 0.0        # acumuladores ponderados globales
                medias, indep = [], []
                for f_ in sorted(por_ses):
                    i = idx[f_]
                    if i + h >= len(ses):
                        continue
                    b_ = ses[i + h]
                    rc = ret_cesta(_CANASTA_13, f_, b_)
                    if rc is None:
                        continue
                    sn_f = snd_f = 0.0
                    for tks, n_ in por_ses[f_]:
                        rp = ret_cesta(list(tks), f_, b_)
                        if rp is None:
                            continue
                        d_ = (rp - rc) * 100
                        sn_f += n_; snd_f += n_ * d_
                        sn += n_; snd += n_ * d_; snd2 += n_ * d_ * d_
                    if sn_f > 0:
                        medias.append(snd_f / sn_f)
                        if i % h == 0:
                            indep.append(medias[-1])
                if len(medias) < 2 or sn < 2:
                    continue
                m_ = snd / sn
                var = max((snd2 - sn * m_ * m_) / (sn - 1), 0.0)
                ing = 1.96 * (var / sn) ** 0.5            # trata las copias como independientes
                _, b_ses, _ = _banda95(medias)
                _, b_ind, t_ind = _banda95(indep)
                hz.append({
                    "sesiones": h,
                    "portafolios": int(sn),
                    "dif_canasta_pct": round(sum(medias) / len(medias), 4),
                    "banda_ingenua": round(ing, 4),
                    "banda_por_sesion": round(b_ses, 4) if b_ses is not None else None,
                    "banda_independiente": round(b_ind, 4) if b_ind is not None else None,
                    "n_independiente": len(indep),
                    "significativo": bool(t_ind is not None and abs(t_ind) > 1.96
                                          and len(indep) >= 5),
                })
            pares = sum(len(v) for v in por_ses.values())
            universo = {
                "portafolios_en_base": int(tot_row[0]["n"]) if tot_row else None,
                "medidos": medidos,
                "sesiones": len(por_ses),
                "observaciones_distintas": pares,
                "copias_por_observacion": round(medidos / pares, 1) if pares else None,
                "horizontes": hz,
                "nota": ("Son TODOS los portafolios de la base, no una muestra. Pero cada "
                         "cartera se repite decenas de veces —class15 emite una por minuto y "
                         "cambia poco—, así que las copias no son observaciones nuevas. La "
                         "banda que vale es la de ventanas sin solapar."),
            }
        except Exception as e:
            # Nunca romper la medición principal por la lectura completa.
            _log_error_endpoint("/api/portfolio/rendimiento[universo]", e)

        f0, f1 = ses[0], ses[-1]
        dias = (datetime.strptime(f1, "%Y-%m-%d") - datetime.strptime(f0, "%Y-%m-%d")).days
        acum = {
            "canasta_13_pct": round((ret_cesta(_CANASTA_13, f0, f1) or 0) * 100, 2),
            "sp500_aprox_pct": round((ret_cesta(list(_SP_PESOS), f0, f1, _SP_PESOS) or 0) * 100, 2),
        }
        # El acumulado NO se anualiza a propósito. Anualizar 77 días da
        # cualquier cosa: el mismo S&P, según la fecha de arranque, sale entre
        # -41,5 % y +20,0 % anual. Se informa el período tal cual y punto.

        h20 = next((x for x in horizontes if x["sesiones"] == 20), None)
        if h20 is None:
            veredicto = "Todavía no hay ventanas de un mes completas para juzgar."
        elif h20["significativo"]:
            veredicto = ("El portafolio se separa de la canasta de forma estadísticamente "
                         f"significativa ({h20['dif_canasta_pct']:+.2f} pp a 20 sesiones).")
        else:
            veredicto = (f"A 20 sesiones el portafolio rinde {h20['dif_canasta_pct']:+.2f} pp "
                         f"contra la canasta, con una banda de ±{h20['banda_canasta']:.2f} sobre "
                         f"{h20['n_independiente']} ventanas independientes. "
                         f"No se distingue de tener los {len(_CANASTA_13)} instrumentos: sin ventaja demostrable.")

        return {
            "estado": "ok",
            "periodo": {"desde": f0, "hasta": f1, "sesiones": len(ses), "dias_corridos": dias},
            "acumulado": acum,
            "horizontes": horizontes,
            "universo": universo,
            "alfa": alfa,
            "veredicto": veredicto,
            "notas": [
                "El primer cuadro mide un portafolio por sesión (el último antes del cierre); "
                "el segundo, TODOS los de la base. Dan el mismo resultado.",
                f"La canasta de {len(_CANASTA_13)} es equiponderada; el S&P es aproximado con 10 ETFs "
                "sectoriales ponderados por peso de índice (falta XLP).",
                "Las ventanas de 5 y 20 sesiones se solapan, así que sus bandas son optimistas.",
                "Ningún número está anualizado salvo el alfa, que va con su t al lado.",
            ],
        }
    except Exception as e:
        _log_error_endpoint("/api/portfolio/rendimiento", e)
        return {"estado": "error", "error_tipo": type(e).__name__}


@app.get("/api/backtesting/historial")
async def backtesting_historial(dias: int = 30):
    """Historial acumulativo de métricas de backtesting desde MySQL."""
    try:
        rows = await db_exec(f"""
            SELECT fecha,
                   total_verificadas, correctas, pendientes,
                   ROUND(accuracy_global*100,1)  AS acc_pct,
                   ROUND(accuracy_30d*100,1)     AS acc30_pct,
                   ROUND(precision_buy*100,1)    AS buy_pct,
                   ROUND(precision_sell*100,1)   AS sell_pct,
                   ROUND(retorno_promedio*100,2) AS retorno_pct,
                   ROUND(sharpe,3)               AS sharpe,
                   ROUND(max_drawdown*100,1)     AS drawdown_pct
            FROM backtesting_stats
            WHERE fecha >= DATE_SUB(CURDATE(), INTERVAL %s DAY)
            ORDER BY fecha DESC LIMIT 60
        """, (dias,)) or []
        # Agregar conteo real de cognitive_decisions
        totals = await db_exec("""
            SELECT COUNT(*) AS total,
                   SUM(outcome_real='correcto')    AS correctas,
                   SUM(outcome_real='incorrecto')  AS incorrectas,
                   SUM(outcome_real='pendiente' OR outcome_real IS NULL) AS pendientes
            FROM cognitive_decisions
            WHERE ticker NOT LIKE 'class%' AND ticker <> 'GENERAL'
        """) or []
        row = totals[0] if totals else {}
        return JSONResponse({
            "ok": True,
            "historial": [_jsonable(dict(r)) for r in rows],
            "totales_db": _jsonable(dict(row)) if row else {},
        })
    except Exception as e:
        log.warning(f"/api/backtesting/historial error: {e}")
        return JSONResponse({"ok": True, "historial": [], "totales_db": {}})

@app.get("/api/precios")
async def precios_route(ticker: str = None, horas: int = 24):
    """Precios históricos por sector desde tabla precios."""
    try:
        horas = max(1, min(int(horas), 24 * 30))   # tope: la ventana entra en un INTERVAL sano
        cond = "AND ticker=%s" if ticker else ""
        vals = (horas, ticker.upper()) if ticker else (horas,)
        # ÚLTIMA fila por ticker, no el promedio de la ventana.
        #
        # Antes esto devolvía AVG(precio), AVG(change_pct) y AVG(riesgo) sobre la
        # ventana completa. El front la pide con horas=48, así que el "cambio" del
        # panel Sectores era el promedio de las muestras intradía de DOS sesiones:
        # un número que puede salir con el signo OPUESTO al movimiento real del día.
        # Verificado contra cierres reales del 8-sep-2026:
        #     XLU   panel +0,93 %   real +0,86 %    coincide
        #     XLK   panel −0,41 %   real +0,32 %    signo invertido
        #     XLRE  panel +0,54 %   real −0,07 %    signo invertido
        # Y como `riesgo` en class7.js:401 es una función escalón de change_pct,
        # heredaba el error entero: XLK cerró en positivo (riesgo 0,25 por la propia
        # fórmula) y el panel mostraba 38 %.
        #
        # Es el mismo defecto que ya se corrigió abajo para el Sharpe —promediar
        # snapshots intradía del mismo cambio diario da un número sin interpretación—
        # sólo que acá había sobrevivido en tres columnas más.
        #
        # El patrón GROUP BY + JOIN sobre MAX(ts) es el que ya usa
        # _retornos_diarios_mercado(); se evitan funciones de ventana a propósito
        # (ver la nota de /api/serie sobre MySQL vs MariaDB).
        rows = await db_exec(f"""
            SELECT a.ticker, a.sector,
                   ROUND(p.precio,     2) AS precio_actual,
                   ROUND(p.change_pct, 4) AS cambio_actual,
                   ROUND(p.riesgo,     4) AS riesgo_actual,
                   ROUND(p.score,      4) AS score_actual,
                   a.precio_prom, a.cambio_prom, a.riesgo_prom, a.score_prom,
                   a.muestras, a.ultima_ts
            FROM (SELECT ticker, sector,
                         MAX(ts)                  AS mx,
                         MAX(ts)                  AS ultima_ts,
                         COUNT(*)                 AS muestras,
                         ROUND(AVG(precio),2)     AS precio_prom,
                         ROUND(AVG(change_pct),4) AS cambio_prom,
                         ROUND(AVG(riesgo),4)     AS riesgo_prom,
                         ROUND(AVG(score),4)      AS score_prom
                  FROM precios
                  WHERE ts > DATE_SUB(NOW(), INTERVAL %s HOUR) {cond}
                  GROUP BY ticker, sector) a
            JOIN precios p ON p.ticker = a.ticker AND p.ts = a.mx
            ORDER BY a.ultima_ts DESC
        """, vals) or []
        # Sharpe desde retornos DIARIOS reales del conjunto de ETFs.
        # Antes: AVG/STDDEV de change_pct sobre muestras de ~5 segundos ×√252 —
        # eso no es un Sharpe (promedia snapshots intradía del mismo cambio
        # diario, el resultado no tiene interpretación). Ahora: último precio
        # por ticker por día → retorno diario equiponderado del conjunto →
        # Sharpe anualizado. Con <5 retornos diarios devuelve None ("–").
        sharpe = None
        try:
            # Solo ETFs sectoriales del sistema: los tickers custom pedidos en el
            # chat (YPF, BTC-USD…) no deben entrar en el "mercado" equiponderado.
            # La consulta vive en _retornos_diarios_mercado(), compartida con
            # /api/backtesting/professional: antes eran dos copias del mismo SQL
            # y cada endpoint la pagaba entera por separado.
            rets = await _retornos_diarios_mercado()
            if len(rets) >= 5:
                m = sum(rets) / len(rets)
                var = sum((x - m) ** 2 for x in rets) / len(rets)
                if var > 0:
                    sharpe = round(m / (var ** 0.5) * (252 ** 0.5), 3)
        except Exception as e:
            log.warning(f"sharpe precios: {e}")
        # Nombres honestos + shim de compatibilidad.
        #
        # El front en producción lee `precio_promedio`, `cambio_pct` y `riesgo`, y
        # los muestra como si fueran el valor de AHORA — de hecho hace
        # `precio_actual: p.precio_promedio`. Se les carga el valor actual para que
        # el panel quede bien SIN redesplegar la web (este fix se despliega matando
        # sólo el proceso Python). Los promedios verdaderos de la ventana quedan
        # disponibles en `*_prom_ventana`, que es lo que esos nombres siempre
        # debieron significar.
        #
        # Cuando se toque el front, que lea `precio_actual` / `cambio_actual` /
        # `riesgo_actual` y se borren las tres claves legacy de abajo.
        precios, vistos = [], set()
        for r in rows:
            d  = _jsonable(dict(r))
            tk = d.get("ticker")
            if tk in vistos:      # el JOIN duplica si dos filas comparten el mismo ts
                continue
            vistos.add(tk)
            precios.append({
                "ticker":              tk,
                "sector":              d.get("sector"),
                "precio_actual":       d.get("precio_actual"),
                "cambio_actual":       d.get("cambio_actual"),
                "riesgo_actual":       d.get("riesgo_actual"),
                "score_actual":        d.get("score_actual"),
                "precio_prom_ventana": d.get("precio_prom"),
                "cambio_prom_ventana": d.get("cambio_prom"),
                "riesgo_prom_ventana": d.get("riesgo_prom"),
                "score_prom_ventana":  d.get("score_prom"),
                "muestras":            d.get("muestras"),
                "ultima_ts":           d.get("ultima_ts"),
                "ventana_horas":       horas,
                # --- claves legacy: valor ACTUAL, no promedio (ver nota arriba) ---
                "precio_promedio":     d.get("precio_actual"),
                "cambio_pct":          d.get("cambio_actual"),
                "riesgo":              d.get("riesgo_actual"),
                "score":               d.get("score_actual"),
            })
        return JSONResponse({
            "ok": True,
            "precios": precios,
            "sharpe":  sharpe,
            # Va DENTRO de /api/precios y no en un endpoint propio: el ruteo de
            # class30 es una lista explicita endpoint por endpoint, asi que una
            # ruta nueva daria 404 desde el navegador y agregarla exige reiniciar
            # el orquestador entero. Ya paso con /api/portfolio/rendimiento y con
            # /api/serie; un campo mas en una ruta que YA esta ruteada no.
            "semana": await _semana_mercado(),
        })
    except Exception as e:
        log.warning(f"/api/precios error: {e}")
        return JSONResponse({"ok": True, "precios": [], "sharpe": None, "semana": []})

@app.get("/api/serie")
async def serie_route(ticker: str, horas: int = 24, puntos: int = 40):
    """Serie de precios de UN instrumento, lista para dibujar un sparkline.

    Por qué existe: /api/precios devuelve AGREGADOS (AVG sobre la ventana), que
    sirven para una tabla pero no para un gráfico — no hay forma de dibujar una
    línea con un promedio. class7 escribe ~1 fila por minuto por ticker, o sea
    1440 por día: mandarlas crudas al navegador sería absurdo para una línea de
    100px de ancho.

    El submuestreo se hace en Python y no en SQL a propósito. La versión SQL
    necesitaba GROUP_CONCAT o funciones de ventana para quedarse con el último
    precio de cada bucket, y las dos son frágiles (límite de group_concat_max_len,
    diferencias entre MySQL y MariaDB). Traer 1440 filas por el índice
    idx_ticker_ts y recorrerlas una vez es más barato que depurar eso.
    """
    try:
        tk = (ticker or "").upper().strip()
        if not tk or not re.fullmatch(r"[A-Z0-9.\-]{1,12}", tk):
            return JSONResponse({"ok": False, "error": "ticker inválido", "serie": []})

        horas  = max(1, min(int(horas), 24 * 30))
        puntos = max(8, min(int(puntos), 200))

        rows = await db_exec("""
            SELECT ts, precio
            FROM precios
            WHERE ticker = %s AND ts > DATE_SUB(NOW(), INTERVAL %s HOUR)
              AND precio IS NOT NULL AND precio > 0
            ORDER BY ts ASC
        """, (tk, horas)) or []

        vals = [(r["ts"], float(r["precio"])) for r in rows]
        if len(vals) < 2:
            return JSONResponse({"ok": True, "ticker": tk, "serie": [], "n": len(vals)})

        # Submuestreo: se toma el ÚLTIMO valor de cada bucket, no el promedio.
        # Promediar suaviza justo lo que el gráfico tiene que mostrar (el
        # movimiento), y además dejaría el último punto sin coincidir con el
        # precio actual que se muestra al lado.
        if len(vals) > puntos:
            paso = len(vals) / puntos
            muestra = [vals[min(int((i + 1) * paso) - 1, len(vals) - 1)] for i in range(puntos)]
        else:
            muestra = vals

        precios = [p for _, p in muestra]
        p_ini, p_fin = vals[0][1], vals[-1][1]

        return JSONResponse({
            "ok":       True,
            "ticker":   tk,
            "serie":    [round(p, 4) for p in precios],
            "n":        len(vals),               # filas reales detrás del dibujo
            "horas":    horas,
            "precio":   round(p_fin, 4),
            "minimo":   round(min(precios), 4),
            "maximo":   round(max(precios), 4),
            "cambio_pct": round((p_fin - p_ini) / p_ini * 100, 2) if p_ini else None,
            "desde":    muestra[0][0].isoformat() if hasattr(muestra[0][0], "isoformat") else str(muestra[0][0]),
            "hasta":    muestra[-1][0].isoformat() if hasattr(muestra[-1][0], "isoformat") else str(muestra[-1][0]),
        })
    except Exception as e:
        log.warning(f"/api/serie error: {e}")
        # Falla hacia serie vacía: el front dibuja nada, nunca una línea inventada.
        return JSONResponse({"ok": False, "ticker": ticker, "serie": []})


@app.get("/api/sentimiento")
async def sentimiento_route():
    """Última señal de sentimiento por ticker desde sentiment_signals.

    Permite al dashboard hidratar el panel 'Sentimiento de Noticias' y la
    columna Sent. de Sectores al cargar la página, sin esperar a que class45
    publique una señal nueva por WebSocket.
    """
    try:
        rows = await db_exec("""
            SELECT s.ticker, s.senal, s.sentiment_label, s.sentiment_score,
                   s.confianza, s.n_articulos, s.ts
            FROM sentiment_signals s
            INNER JOIN (
                SELECT ticker, MAX(id) AS max_id
                FROM sentiment_signals
                WHERE ticker IS NOT NULL AND ticker != 'GENERAL'
                GROUP BY ticker
            ) ult ON ult.max_id = s.id
            ORDER BY s.ts DESC
        """) or []
        señales = [_jsonable(dict(r)) for r in rows]
        return JSONResponse({"ok": True, "senales": señales, "total": len(señales)})
    except Exception as e:
        log.warning(f"/api/sentimiento error: {e}")
        return JSONResponse({"ok": True, "senales": [], "total": 0})

@app.get("/api/noticias")
async def noticias_route(n: int = 30, ticker: str = None, sentimiento: str = None):
    """Últimas noticias desde la tabla noticias de MySQL."""
    try:
        conds, vals = [], []
        if ticker:     conds.append("ticker = %s");     vals.append(ticker.upper())
        if sentimiento: conds.append("sentimiento = %s"); vals.append(sentimiento.upper())
        where = f"WHERE {' AND '.join(conds)}" if conds else ""
        # Ordenar por ts_guardado (cuándo MIIA ingirió la noticia), NO por
        # ts_publicado: las fuentes suelen traer artículos con fechas viejas o
        # nulas, que quedaban sepultados y hacían que las noticias nuevas no
        # aparecieran en el panel. La fecha mostrada sigue siendo la de publicación
        # si existe, pero el orden refleja lo más recién encontrado.
        rows = await db_exec(f"""
            SELECT id, titulo, snippet, fuente, ticker, sentimiento,
                   url, imagen_url,
                   COALESCE(ts_publicado, ts_guardado) AS ts
            FROM noticias {where}
            ORDER BY ts_guardado DESC
            LIMIT %s
        """, (*vals, min(n, 100))) or []
        noticias = [_jsonable(dict(r)) for r in rows]
        return JSONResponse({"ok": True, "noticias": noticias, "total": len(noticias)})
    except Exception as e:
        log.warning(f"/api/noticias error: {e}")
        return JSONResponse({"ok": True, "noticias": [], "total": 0})

@app.get("/api/health")
async def health(r: aioredis.Redis = Depends(get_redis)):
    try:    await r.ping(); redis_ok = True
    except: redis_ok = False
    return JSONResponse({"status":"ok" if redis_ok else "degraded",
                         "redis":redis_ok, "ts":datetime.utcnow().isoformat()},
                        status_code=200 if redis_ok else 503)

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    from fastapi.responses import Response
    return Response(status_code=204)

# ── OAuth Google callback en puerto 5005 (HTTP, sin cert) ──
# class30 (HTTPS:8443) redirige el callback aquí cuando OAUTH_CALLBACK=http://localhost:5005
# Luego este endpoint redirige al usuario a la UI con el token JWT.
@app.get("/auth/google/callback")
async def oauth_google_callback(request: Request, code: str = None, error: str = None):
    if error or not code:
        return RedirectResponse(f"/?error={error or 'oauth_cancelled'}")
    try:
        import httpx as _httpx
        GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
        GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
        callback_url         = f"{OAUTH_BASE_URL}/auth/google/callback"

        async with _httpx.AsyncClient(timeout=10) as client:
            # Intercambiar código por token
            token_r = await client.post("https://oauth2.googleapis.com/token", data={
                "code":          code,
                "client_id":     GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri":  callback_url,
                "grant_type":    "authorization_code",
            })
            tokens = token_r.json()
            access_token = tokens.get("access_token")
            if not access_token:
                return RedirectResponse("/?error=token_exchange_failed")

            # Obtener perfil del usuario
            profile_r = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            profile = profile_r.json()

        # Registrar en Redis → class14 via redisPub
        r   = await get_redis()
        uid = "g_" + profile.get("id", "")[:16]
        tok = jwt.encode(
            {"user_id": uid, "email": profile.get("email"), "name": profile.get("name"),
             "exp": datetime.utcnow() + timedelta(hours=24)},
            # Usa la constante del módulo, no un getenv con OTRO default. El
            # fallback de acá ("miia-jwt-secret-cambiar") ni siquiera coincidía
            # con el de arriba, así que un token emitido en este login no
            # verificaba después contra JWT_SECRET.
            JWT_SECRET,
            algorithm="HS256"
        )
        await r.publish("class14_actions", json.dumps({
            "type":     "oauth_login",
            "provider": "google",
            "user_id":  uid,
            "email":    profile.get("email"),
            "name":     profile.get("name"),
            "avatar":   profile.get("picture"),
            "ts":       datetime.utcnow().isoformat(),
        }))
        name_enc = urllib.parse.quote(profile.get("name") or "")
        return RedirectResponse(f"/?token={tok}&user={name_enc}&new=0")
    except Exception as e:
        log.warning(f"OAuth Google callback error: {e}")
        return RedirectResponse(f"/?error=oauth_error")

@app.get("/auth/google")
async def oauth_google_start(request: Request):
    GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
    if not GOOGLE_CLIENT_ID:
        return JSONResponse({"error": "Google OAuth no configurado"}, status_code=503)
    callback_url = f"{OAUTH_BASE_URL}/auth/google/callback"
    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  callback_url,
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "offline",
        "prompt":        "select_account",
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
    return RedirectResponse(url)

# ════════════════════════════════════════════════════════════
# ADMIN WEB (basado en email de Google) — cuenta maestra
# ════════════════════════════════════════════════════════════
async def _es_admin_email(email: str) -> bool:
    """True si el email está en miia_admins (o es la cuenta maestra)."""
    if not email:
        return False
    if email.lower() == ADMIN_MASTER_EMAIL.lower():
        return True
    rows = await db_exec("SELECT 1 FROM miia_admins WHERE LOWER(email)=LOWER(%s) LIMIT 1", (email,))
    return bool(rows)

def _email_de_request(request: Request) -> str:
    user = get_current_user(request)
    return (user or {}).get("email", "") if user else ""

async def _require_admin(request: Request) -> str:
    email = _email_de_request(request)
    if not await _es_admin_email(email):
        raise HTTPException(403, "Acceso exclusivo del administrador")
    return email

@app.get("/api/admin/check")
async def admin_check(request: Request):
    email = _email_de_request(request)
    return JSONResponse({"ok": True, "is_admin": await _es_admin_email(email), "email": email})

@app.get("/api/admin/resources")
async def admin_resources(request: Request):
    # En producción requiere sesión admin válida. En local (testing) se permite
    # sin token para que el panel de recursos funcione mientras se prueba en
    # localhost (CPU/Mem/uptime no son datos sensibles). Producción sin cambios.
    if MIIA_ENV != "local":
        await _require_admin(request)
    cpu_pct = mem_pct = None
    mem_used_mb = mem_total_mb = None
    try:
        import psutil
        cpu_pct = psutil.cpu_percent(interval=0.2)
        vm = psutil.virtual_memory()
        mem_pct = vm.percent
        mem_used_mb = round((vm.total - vm.available) / 1024 / 1024)
        mem_total_mb = round(vm.total / 1024 / 1024)
    except Exception:
        # Fallback sin psutil: usar os.getloadavg y /proc si están disponibles
        try:
            import os as _os
            load = _os.getloadavg()[0] if hasattr(_os, "getloadavg") else 0
            cpu_count = _os.cpu_count() or 1
            cpu_pct = min(100.0, (load / cpu_count) * 100)
        except Exception:
            pass
    # Formato en HORAS TOTALES, sin acumular días: para el reloj del
    # experimento "347h" es más legible que "14d 11h" — se compara directo
    # contra los horizontes de 48h y contra las ventanas de entrenamiento.
    def _fmt(seg: int) -> str:
        seg = max(0, int(seg))
        h, m, s = seg // 3600, (seg % 3600) // 60, seg % 60
        return f"{h}h {m}m {s}s"

    # ── Uptime: tres relojes distintos, no uno ──────────────────────────────
    # El panel mostraba `time.time() - _PROCESS_START`, o sea la vida del
    # proceso PYTHON. Eso confunde: al reiniciar solo el chatbot (que se puede
    # hacer sin tocar el resto) el panel decía "Uptime 3h" y se leía como
    # "el sistema se reinició hace 3 horas" — cuando el server llevaba 27 días
    # arriba y las redes 13 horas entrenando sin interrupción.
    #
    # Un rótulo genérico sobre el reloj equivocado es peor que no mostrarlo.
    # Ahora se exponen los tres, cada uno con su nombre:
    #   sistema  → boot del server
    #   miia     → arranque de class24, que es EL RELOJ DEL EXPERIMENTO:
    #              class23/24 no persisten pesos, así que su hora de arranque
    #              marca desde cuándo el entrenamiento es continuo
    #   chatbot  → este proceso (lo que se mostraba antes)
    # Disco (16-nov-2026, pedido de Martín): la partición donde vive MIIA.
    disk_pct = disk_used_gb = disk_total_gb = None
    try:
        import shutil as _sh
        _du = _sh.disk_usage("/opt/miia" if os.path.isdir("/opt/miia") else ".")
        disk_total_gb = round(_du.total / 1024**3, 1)
        disk_used_gb  = round(_du.used / 1024**3, 1)
        disk_pct      = round(_du.used / _du.total * 100, 1) if _du.total else None
    except Exception:
        pass

    up_chatbot = time.time() - _PROCESS_START
    up_sistema = None
    up_miia    = None
    try:
        import psutil as _ps
        up_sistema = time.time() - _ps.boot_time()
        for _p in _ps.process_iter(["pid", "cmdline", "create_time"]):
            _cl = " ".join(_p.info.get("cmdline") or [])
            if "/opt/miia/scripts/class24" in _cl:
                up_miia = time.time() - _p.info["create_time"]
                break
    except Exception:
        pass

    return JSONResponse({
        "ok": True,
        "cpu_pct":      cpu_pct,
        "mem_pct":      mem_pct,
        "mem_used_mb":  mem_used_mb,
        "mem_total_mb": mem_total_mb,
        # `uptime` = EL RELOJ DEL EXPERIMENTO (class24), no el del server.
        #
        # Es el número que de verdad importa: class23/24 no persisten pesos, así
        # que su hora de arranque marca desde cuándo el entrenamiento es
        # continuo. El del server (27 días) no dice nada sobre la corrida —
        # el server puede llevar meses arriba con las redes reseteadas ayer.
        #
        # Si class24 no está corriendo cae al del sistema, y si falta psutil
        # al del chatbot (comportamiento viejo).
        "uptime":         _fmt(up_miia if up_miia is not None
                               else (up_sistema if up_sistema is not None else up_chatbot)),
        "uptime_sistema": _fmt(up_sistema) if up_sistema is not None else None,
        "uptime_miia":    _fmt(up_miia)    if up_miia    is not None else None,
        "uptime_chatbot": _fmt(up_chatbot),
        # el mismo reloj que `uptime`, en segundos, para que la web lo muestre en días
        "uptime_seg":     int(up_miia if up_miia is not None
                              else (up_sistema if up_sistema is not None else up_chatbot)),
        "disk_pct":       disk_pct,
        "disk_used_gb":   disk_used_gb,
        "disk_total_gb":  disk_total_gb,
        "ws_conns":     len(ws_manager.users) + len(ws_manager.admins),
        "online_now":   len(ws_manager.users),
    })

@app.get("/api/admin/users")
async def admin_users(request: Request):
    await _require_admin(request)
    rows = await db_exec("""
        SELECT u.user_id, u.email, u.nombre, u.status, u.consultas, u.last_seen,
               s.plan, s.status AS sub_status, s.expires_at
        FROM miia_users u
        LEFT JOIN miia_subscriptions s
               ON s.user_id = u.user_id AND s.status = 'active'
        ORDER BY u.last_seen DESC
        LIMIT 200
    """) or []
    return JSONResponse({"ok": True, "users": [_jsonable(dict(r)) for r in rows]})

@app.post("/api/admin/ban")
async def admin_ban(request: Request):
    admin_email = await _require_admin(request)
    body = await request.json()
    user_id = body.get("user_id")
    action  = body.get("action", "ban")
    new_status = "banned" if action == "ban" else "active"
    await db_exec("UPDATE miia_users SET status=%s WHERE user_id=%s", (new_status, user_id))
    log.info(f"⚙ Admin {admin_email}: {action} → {user_id}")
    return JSONResponse({"ok": True, "user_id": user_id, "status": new_status})

@app.get("/api/admin/admins")
async def admin_list_admins(request: Request):
    await _require_admin(request)
    rows = await db_exec("SELECT email, added_by, created_at FROM miia_admins ORDER BY created_at") or []
    return JSONResponse({"ok": True, "admins": [_jsonable(dict(r)) for r in rows]})

@app.post("/api/admin/add-admin")
async def admin_add_admin(request: Request):
    admin_email = await _require_admin(request)
    body = await request.json()
    nuevo = (body.get("email") or "").strip()
    if not nuevo or "@" not in nuevo:
        return JSONResponse({"ok": False, "error": "Email inválido"}, status_code=400)
    await db_exec("INSERT IGNORE INTO miia_admins (email, added_by) VALUES (%s, %s)", (nuevo, admin_email))
    log.info(f"⚙ Admin {admin_email} agregó admin → {nuevo}")
    return JSONResponse({"ok": True, "email": nuevo})

@app.post("/api/admin/track-user")
async def admin_track_user(request: Request):
    """Registra/actualiza el uso de un usuario (llamado desde el frontend)."""
    body = await request.json()
    user_id = body.get("user_id")
    if not user_id:
        return JSONResponse({"ok": True})
    # SEGURIDAD: email y nombre salen del TOKEN verificado por Google, NUNCA del
    # body (que el cliente controla y podía inyectar cualquier email en el panel).
    # Sin sesión válida se registra el uso sin email (usuario anónimo).
    _u      = get_current_user(request)
    _email  = (_u or {}).get("email", "") or ""
    _nombre = (_u or {}).get("name",  "") or ""
    await db_exec("""
        INSERT INTO miia_users (user_id, email, nombre, consultas, last_seen)
        VALUES (%s, %s, %s, 1, NOW())
        ON DUPLICATE KEY UPDATE
            consultas = consultas + 1,
            last_seen = NOW(),
            email  = COALESCE(NULLIF(VALUES(email), ''),  email),
            nombre = COALESCE(NULLIF(VALUES(nombre), ''), nombre)
    """, (user_id, _email, _nombre))
    # ¿El usuario está baneado? Informar al frontend para bloquearlo
    row = await db_exec("SELECT status FROM miia_users WHERE user_id=%s LIMIT 1", (user_id,))
    banned = bool(row) and row[0].get("status") == "banned"
    return JSONResponse({"ok": True, "banned": banned})

# ════════════════════════════════════════════════════════════
# SUSCRIPCIONES — Mercado Pago
# ════════════════════════════════════════════════════════════
@app.post("/api/subscribe/create")
async def subscribe_create(request: Request):
    if not MP_ACCESS_TOKEN:
        return JSONResponse({"ok": False, "error": "Mercado Pago no configurado (falta MP_ACCESS_TOKEN)"}, status_code=503)
    body    = await request.json()
    plan    = body.get("plan", "monthly")
    user_id = body.get("user_id", "anon")
    email   = body.get("email", "")
    # Moneda y precios configurables por env. Default: USD 20 / 180.
    # Nota: MP Argentina (site MLA) normalmente opera en ARS; si el checkout
    # de MP rechaza USD, cambiar MP_CURRENCY=ARS y los precios a pesos.
    moneda  = os.getenv("MP_CURRENCY", "USD").strip().upper()
    precio_mensual = int(os.getenv("MP_PRECIO_MENSUAL", "20"))
    precio_anual   = int(os.getenv("MP_PRECIO_ANUAL",   "180"))
    precio  = precio_anual if plan == "annual" else precio_mensual
    titulo  = "MIIA Pro — Plan Anual" if plan == "annual" else "MIIA Pro — Plan Mensual"

    # URL base para back_urls / webhook. Se puede fijar una URL pública con la
    # env var PUBLIC_BASE_URL (producción). En local, request.base_url es
    # http://localhost:5005 y Mercado Pago RECHAZA `auto_return` con URLs
    # localhost/http → error 400 "auto_return invalid. back_url.success must
    # be defined". Por eso auto_return y notification_url solo se envían cuando
    # la base es pública (https y no localhost).
    public_base = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    base = public_base or str(request.base_url).rstrip("/")
    is_public = (base.startswith("https://")
                 and "localhost" not in base
                 and "127.0.0.1" not in base)

    preference = {
        "items": [{"title": titulo, "quantity": 1, "unit_price": precio, "currency_id": moneda}],
        "back_urls": {
            "success": f"{base}/subscribe/success",
            "failure": f"{base}/subscribe/failure",
            "pending": f"{base}/subscribe/pending",
        },
        "external_reference": f"{user_id}_{plan}_{int(time.time())}",
        "statement_descriptor": "MIIA PRO",
    }
    # auto_return + notification_url requieren URL pública válida (MP los rechaza
    # en localhost). En local se omiten: el pago funciona igual, solo que MP
    # muestra su propia pantalla de resultado sin redirigir de vuelta.
    if is_public:
        preference["auto_return"]     = "approved"
        preference["notification_url"] = f"{base}/api/subscribe/webhook"
    if email:
        preference["payer"] = {"email": email}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.mercadopago.com/checkout/preferences",
                headers={"Authorization": f"Bearer {MP_ACCESS_TOKEN}",
                         "Content-Type": "application/json"},
                json=preference)
        if r.status_code != 201:
            log.warning(f"MP preference error {r.status_code}: {r.text[:300]}")
            return JSONResponse({"ok": False, "error": "Error al crear preferencia en Mercado Pago",
                                 "detail": r.json() if r.text else None}, status_code=502)
        pref = r.json()
        await db_exec("""
            INSERT INTO miia_subscriptions (user_id, email, plan, mp_preference_id, status, created_at)
            VALUES (%s, %s, %s, %s, 'pending', NOW())
        """, (user_id, email, plan, pref.get("id")))
        return JSONResponse({
            "ok": True,
            "init_point":         pref.get("init_point"),
            "sandbox_init_point": pref.get("sandbox_init_point"),
            "preference_id":      pref.get("id"),
        })
    except Exception as e:
        log.warning(f"subscribe_create error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

@app.get("/api/subscribe/status")
async def subscribe_status(user_id: str = "anon", email: str = ""):
    # Reconocer la suscripción por user_id O por email (así un usuario
    # registrado con Google es recordado aunque cambie de dispositivo/sesión).
    rows = await db_exec("""
        SELECT plan, status, expires_at FROM miia_subscriptions
        WHERE (user_id=%s OR (email<>'' AND email=%s))
          AND status='active'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC LIMIT 1
    """, (user_id, email)) or []
    active = bool(rows)
    return JSONResponse({
        "ok": True,
        "subscribed": active,
        "plan":       rows[0].get("plan") if active else None,
        "expires_at": _jsonable(rows[0].get("expires_at")) if active else None,
    })

@app.post("/api/subscribe/webhook")
async def subscribe_webhook(request: Request):
    try:
        wb = await request.json()
    except Exception:
        wb = {}
    if wb.get("type") == "payment" and wb.get("data", {}).get("id") and MP_ACCESS_TOKEN:
        pay_id = wb["data"]["id"]
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(
                    f"https://api.mercadopago.com/v1/payments/{pay_id}",
                    headers={"Authorization": f"Bearer {MP_ACCESS_TOKEN}"})
            pay = r.json()
            if pay.get("status") == "approved":
                ref = pay.get("external_reference", "")
                parts = ref.split("_")
                uid  = parts[0] if parts else ""
                plan = parts[1] if len(parts) > 1 else "monthly"
                dias = 365 if plan == "annual" else 31
                # 1) Activar la suscripción propia (autoritativa para el paywall)
                await db_exec("""
                    UPDATE miia_subscriptions
                    SET status='active', mp_payment_id=%s,
                        expires_at = DATE_ADD(NOW(), INTERVAL %s DAY)
                    WHERE user_id=%s AND plan=%s AND status='pending'
                """, (str(pay_id), dias, uid, plan))
                # 2) Integrar con el sistema existente: marcar plan 'pro' en `users`
                #    (class14/class42 leen users.plan / plan_vencimiento). Se hace
                #    por user_id y por el email guardado en la suscripción.
                sub = await db_exec(
                    "SELECT email FROM miia_subscriptions WHERE user_id=%s AND plan=%s ORDER BY created_at DESC LIMIT 1",
                    (uid, plan))
                sub_email = sub[0].get("email") if sub else ""
                await db_exec("""
                    UPDATE users SET plan='pro',
                        plan_vencimiento = DATE_ADD(NOW(3), INTERVAL %s DAY)
                    WHERE user_id=%s OR (email IS NOT NULL AND email<>'' AND email=%s)
                """, (dias, uid, sub_email or "\x00"))
                log.info(f"✅ Suscripción activada: {uid} plan={plan} (email={sub_email})")
        except Exception as e:
            log.warning(f"webhook error: {e}")
    return JSONResponse({"ok": True})

@app.post("/api/subscribe/cancel")
async def subscribe_cancel(request: Request):
    """Botón de baja (Res. 424/2020 AR): cancela la suscripción de forma
    INMEDIATA y devuelve la cuenta al plan gratuito. Tan fácil como suscribirse."""
    body    = await request.json()
    user_id = body.get("user_id", "")
    email   = (body.get("email") or "").strip()
    if not user_id and not email:
        return JSONResponse({"ok": False, "error": "Falta user_id o email"}, status_code=400)
    # 1) Cancelar toda suscripción activa/pendiente del usuario (por uid o email)
    await db_exec("""
        UPDATE miia_subscriptions SET status='cancelled'
        WHERE (user_id=%s OR (email<>'' AND email=%s))
          AND status IN ('active','pending')
    """, (user_id, email))
    # 2) Downgrade inmediato en `users` (lo que leen class14/class42)
    await db_exec("""
        UPDATE users SET plan='free', plan_vencimiento=NULL
        WHERE user_id=%s OR (email IS NOT NULL AND email<>'' AND email=%s)
    """, (user_id, email or "\x00"))
    log.info(f"🔻 Baja de suscripción inmediata: uid={user_id} email={email}")
    return JSONResponse({"ok": True, "cancelled": True, "plan": "free"})

# ── Admin API ───────────────────────────────────────────────
@app.get("/api/admin/dashboard")
async def admin_dashboard(request: Request):
    if not verify_admin(request):
        raise HTTPException(403, "No autorizado")
    # Clientes de MySQL
    clientes = await db_exec("""
        SELECT pais, pais_code, ciudad, ip, user_id, plan,
               total_consultas, ultima_visita
        FROM clientes
        ORDER BY ultima_visita DESC
        LIMIT 100
    """) or []
    por_pais  = defaultdict(int)
    for c in clientes or []:
        pais = c.get("pais","Desconocido") or "Desconocido"
        por_pais[pais] += 1
    top_paises = sorted(por_pais.items(), key=lambda x: -x[1])[:15]

    return JSONResponse({
        "online_now":       len(ws_manager.users),
        "admins_online":    len(ws_manager.admins),
        "consultas_hora":   ws_manager.consultas_ultima_hora,
        "total_clientes":   len(clientes or []),
        "top_paises":       [{"pais":p,"count":n} for p,n in top_paises],
        "ultimos_clientes": list(clientes or [])[:20],
        "accuracy_pct":     fmt_pct(estado["accuracy_global"]),
        "total_decisiones": estado["total_decisiones"],
        "ts":               datetime.utcnow().isoformat(),
    })

# ── WebSocket ───────────────────────────────────────────────
@app.websocket("/ws")
async def ws_user(ws: WebSocket):
    await ws_manager.connect(ws, "user")
    try:
        # Enviar estado inicial — _jsonable previene TypeError por Decimal/datetime
        try:
            await ws.send_text(json.dumps({"tipo": "init", "payload": _jsonable({
                "accuracy_global_pct": fmt_pct(estado["accuracy_global"]),
                "accuracy_30d_pct":    fmt_pct(estado["accuracy_30d"]),
                "total_decisiones":    estado["total_decisiones"],
                "riesgo_pct":          f"{estado['riesgo_pct']}%",
                "sectores":            estado["sectores"],
                "ultimas_senales":     historial_decisiones[-5:],
                "confianza_promedio":  round(float(estado.get("confianza_promedio", 0)) * 100, 1),
            })}))
        except Exception as e:
            log.warning(f"ws init send error: {e}")
            return  # No cerrar con error, simplemente no enviar init

        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=25)
                m   = json.loads(raw)
                if m.get("tipo") == "ping":
                    try:
                        await ws.send_text(json.dumps({"tipo":"pong","ts":time.time()}))
                    except Exception:
                        break  # cliente desconectado
            except asyncio.TimeoutError:
                # Heartbeat — si falla, cliente se desconectó → cerrar limpiamente
                try:
                    await ws.send_text(json.dumps({"tipo":"heartbeat","ts":time.time()}))
                except Exception:
                    break
            except WebSocketDisconnect:
                break
            except Exception:
                break  # cualquier otro error → cerrar sin crash
    finally:
        await ws_manager.disconnect(ws)

@app.websocket("/ws/admin")
async def ws_admin(ws: WebSocket, admin_token: str = ""):
    try:
        pyjwt.decode(admin_token, ADMIN_TOKEN_SECRET, algorithms=["HS256"])
    except:
        await ws.close(code=4001); return
    await ws_manager.connect(ws, "admin")
    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=30)
                m   = json.loads(raw)
                if m.get("tipo") == "ping":
                    await ws.send_text(json.dumps({"tipo":"pong","ts":time.time()}))
            except asyncio.TimeoutError:
                await ws.send_text(json.dumps({
                    "tipo":"admin_update","payload":{
                        "online_now":     len(ws_manager.users),
                        "consultas_hora": ws_manager.consultas_ultima_hora,
                    }
                }))
            except WebSocketDisconnect:
                break
    finally:
        await ws_manager.disconnect(ws)

# Startup y shutdown manejados por _lifespan (ver definición junto a FastAPI())

# ============================================================
# HTML — CHAT UI CON DASHBOARD DE MERCADO
# ============================================================

CHAT_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<meta name="theme-color" content="#0a0e1a">
<title>MIIA — Análisis de Mercados</title>
<style>
:root{{
  --bg:#0a0e1a;--s1:#111827;--s2:#1a2236;--bd:#1e2d45;
  --tx:#e2e8f0;--mt:#64748b;--ac:#3b82f6;
  --by:#10b981;--sl:#ef4444;--hd:#f59e0b;
  --r:10px;--fn:'Inter','Segoe UI',system-ui,sans-serif;
}}
*{{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}}
html,body{{height:100%;overflow:hidden}}
body{{background:var(--bg);color:var(--tx);font-family:var(--fn);
     display:flex;flex-direction:column}}

/* ── HEADER ── */
header{{background:var(--s1);border-bottom:1px solid var(--bd);
        padding:10px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;
        position:relative;z-index:10}}
.logo{{width:30px;height:30px;background:var(--ac);border-radius:7px;
       display:flex;align-items:center;justify-content:center;
       font-weight:900;font-size:13px;color:#fff;flex-shrink:0}}
.hinfo h1{{font-size:14px;font-weight:700;white-space:nowrap}}
.hinfo span{{font-size:11px;color:var(--mt)}}
.sdot{{width:7px;height:7px;border-radius:50%;background:#10b981;
       box-shadow:0 0 5px #10b981;animation:pu 2s infinite;flex-shrink:0}}
@keyframes pu{{0%,100%{{opacity:1}}50%{{opacity:.4}}}}
.hright{{margin-left:auto;display:flex;gap:6px;align-items:center}}
.hbtn{{padding:5px 10px;border-radius:7px;border:1px solid var(--bd);
       background:var(--s2);color:var(--tx);font-size:11px;font-weight:600;
       cursor:pointer;text-decoration:none;display:flex;align-items:center;
       gap:4px;white-space:nowrap;transition:border-color .2s}}
.hbtn:hover{{border-color:var(--ac)}}
.user-ok{{font-size:11px;color:var(--by);font-weight:600;white-space:nowrap}}

/* ── ALERTA ZONE ── */
#alert-zone{{display:none;padding:0 14px 8px;flex-shrink:0;max-height:120px;overflow-y:auto}}
.alert-banner{{display:flex;align-items:center;gap:8px;padding:8px 12px;
               border-radius:8px;margin-bottom:4px;cursor:pointer;
               border:1px solid;font-size:12px;transition:opacity .2s}}
.alert-banner:hover{{opacity:.85}}

/* ── LAYOUT PRINCIPAL ── */
.main{{flex:1;display:flex;overflow:hidden;position:relative}}

/* ── SIDEBAR (desktop: fija; mobile: panel deslizable) ── */
aside{{width:240px;background:var(--s1);border-right:1px solid var(--bd);
       overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;
       gap:0;transition:transform .3s ease}}
aside::-webkit-scrollbar{{width:3px}}
aside::-webkit-scrollbar-thumb{{background:var(--bd);border-radius:2px}}
.aside-inner{{padding:10px;display:flex;flex-direction:column;gap:8px}}

/* ── CARDS ── */
.card{{background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);
       padding:10px 12px}}
.card-title{{font-size:10px;color:var(--mt);text-transform:uppercase;
             letter-spacing:.5px;margin-bottom:7px;font-weight:700}}
.acc-big{{font-size:30px;font-weight:900;line-height:1}}
.acc-sub{{font-size:10px;color:var(--mt);margin-top:2px}}
.acc-row{{display:flex;justify-content:space-between;margin-top:6px;font-size:11px}}
.senal-badge{{display:inline-block;padding:3px 9px;border-radius:6px;
              font-weight:700;font-size:11px;letter-spacing:.3px}}
.BUY{{background:#064e3b;color:var(--by);border:1px solid var(--by)}}
.SELL{{background:#450a0a;color:var(--sl);border:1px solid var(--sl)}}
.HOLD{{background:#451a03;color:var(--hd);border:1px solid var(--hd)}}
.senal-meta{{font-size:11px;color:var(--mt);margin-top:5px;line-height:1.5}}
.sector-row{{margin-bottom:5px}}
.sector-name{{font-size:11px;color:var(--mt);margin-bottom:2px;
              display:flex;justify-content:space-between}}
.sector-bar-wrap{{height:4px;background:var(--bd);border-radius:2px;overflow:hidden}}
.sector-bar{{height:4px;border-radius:2px;transition:width .5s}}
.p-row{{display:flex;align-items:center;gap:5px;margin-bottom:5px;font-size:11px}}
.p-symbol{{font-weight:700;min-width:36px}}
.p-bar-wrap{{flex:1;height:4px;background:var(--bd);border-radius:2px;overflow:hidden}}
.p-bar{{height:4px;border-radius:2px}}
.p-pct{{font-weight:700;font-size:11px;min-width:30px;text-align:right}}
.p-change{{font-size:10px;min-width:36px;text-align:right}}
/* Alertas */
.alerta-card{{border-radius:8px;padding:10px 12px;margin-bottom:4px;
              border-left:3px solid;font-size:12px}}
.alerta-titulo{{font-size:13px;font-weight:700;margin-bottom:5px;
                display:flex;align-items:center;gap:6px}}
.alerta-razon{{font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:3px}}
.alerta-razon::before{{content:"• ";opacity:.6}}
.alerta-rec{{font-size:11px;margin-top:6px;padding:6px 8px;
             background:rgba(0,0,0,.25);border-radius:5px;line-height:1.5}}
.alerta-rec strong{{display:block;margin-bottom:2px;font-size:10px;
                    text-transform:uppercase;letter-spacing:.4px;opacity:.7}}
.alerta-badge{{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;border:1px solid}}

/* ── CHAT AREA ── */
.chat-area{{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}}
#chat{{flex:1;overflow-y:auto;padding:14px 16px;
       display:flex;flex-direction:column;gap:9px}}
#chat::-webkit-scrollbar{{width:3px}}
#chat::-webkit-scrollbar-thumb{{background:var(--bd);border-radius:2px}}
.msg{{max-width:85%;animation:fi .2s ease}}
@keyframes fi{{from{{opacity:0;transform:translateY(4px)}}to{{opacity:1;transform:none}}}}
.mu{{align-self:flex-end}}.mb{{align-self:flex-start}}
.bb{{padding:10px 13px;border-radius:var(--r);font-size:14px;
     line-height:1.55;white-space:pre-wrap}}
.mu .bb{{background:var(--ac);color:#fff;border-bottom-right-radius:3px}}
.mb .bb{{background:var(--s2);border:1px solid var(--bd);border-bottom-left-radius:3px}}
.ts{{font-size:10px;color:var(--mt);margin-top:3px}}
.mu .ts{{text-align:right}}
/* Decision card */
.dc{{background:var(--s2);border:1px solid var(--bd);
     border-radius:var(--r);padding:11px 13px}}
.dc-head{{display:flex;align-items:center;gap:7px;margin-bottom:6px;flex-wrap:wrap}}
.dc-txt{{color:#cbd5e1;line-height:1.55;margin-bottom:8px;font-size:13px}}
.dc-meta{{display:flex;gap:10px;flex-wrap:wrap}}
.dm{{display:flex;flex-direction:column;gap:1px}}
.dl{{font-size:10px;color:var(--mt);text-transform:uppercase}}
.dv{{font-size:13px;font-weight:600}}
/* Typing */
.typing{{display:flex;gap:4px;align-items:center;
         padding:10px 13px;background:var(--s2);
         border-radius:var(--r);width:fit-content}}
.typing span{{width:6px;height:6px;background:var(--mt);border-radius:50%;
              animation:bo 1s infinite}}
.typing span:nth-child(2){{animation-delay:.2s}}
.typing span:nth-child(3){{animation-delay:.4s}}
@keyframes bo{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-5px)}}}}

/* ── FOOTER INPUT ── */
footer{{background:var(--s1);border-top:1px solid var(--bd);
        padding:10px 14px;flex-shrink:0}}
.ir{{display:flex;gap:8px;align-items:flex-end}}
#msg{{flex:1;background:var(--s2);border:1px solid var(--bd);color:var(--tx);
      padding:10px 13px;border-radius:var(--r);font-size:15px;
      font-family:var(--fn);resize:none;outline:none;
      min-height:42px;max-height:100px;transition:border-color .2s;
      -webkit-appearance:none}}
#msg:focus{{border-color:var(--ac)}}
#msg::placeholder{{color:var(--mt)}}
#btn{{background:var(--ac);color:#fff;border:none;padding:10px 14px;
      border-radius:var(--r);cursor:pointer;font-size:14px;font-weight:600;
      height:42px;white-space:nowrap;transition:opacity .2s;flex-shrink:0}}
#btn:active{{opacity:.7}}
#btn:disabled{{opacity:.4;cursor:not-allowed}}
.hint{{font-size:10px;color:var(--mt);margin-top:4px}}

/* ── BOTTOM NAV (mobile only) ── */
.bottom-nav{{display:none;background:var(--s1);border-top:1px solid var(--bd);
             padding:8px 0 max(8px, env(safe-area-inset-bottom));
             flex-shrink:0}}
.bnav-inner{{display:flex;justify-content:space-around}}
.bnav-btn{{display:flex;flex-direction:column;align-items:center;gap:2px;
           padding:6px 16px;color:var(--mt);font-size:10px;cursor:pointer;
           border:none;background:none;transition:color .2s}}
.bnav-btn.active{{color:var(--ac)}}
.bnav-icon{{font-size:18px;line-height:1}}

/* ── SIDEBAR OVERLAY (mobile) ── */
.sidebar-overlay{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);
                  z-index:50;backdrop-filter:blur(2px)}}

/* ═══════════════════════════════════════
   RESPONSIVE — MOBILE (≤ 768px)
   ═══════════════════════════════════════ */
@media (max-width: 768px) {{
  /* Header simplificado */
  .hinfo h1{{font-size:13px}}
  .hbtn span{{display:none}}  /* ocultar texto, solo icono */

  /* Sidebar: panel deslizable desde izquierda */
  aside{{position:fixed;left:0;top:0;bottom:0;z-index:100;
         width:280px;transform:translateX(-100%);
         box-shadow:4px 0 20px rgba(0,0,0,.5)}}
  aside.open{{transform:translateX(0)}}
  .aside-inner{{padding-top:60px}}  /* espacio para el header */
  .sidebar-overlay{{display:block;opacity:0;pointer-events:none;
                    transition:opacity .3s}}
  .sidebar-overlay.open{{opacity:1;pointer-events:all}}

  /* Chat */
  #chat{{padding:12px 12px;gap:8px}}
  .msg{{max-width:92%}}
  .bb{{font-size:14px;padding:9px 12px}}
  .dc-meta{{gap:8px}}

  /* Input */
  footer{{padding:8px 10px}}
  #msg{{font-size:16px;padding:10px 12px}}  /* 16px evita zoom en iOS */
  #btn{{padding:10px 12px;font-size:14px}}

  /* Bottom nav visible */
  .bottom-nav{{display:block}}

  /* Alert zone */
  #alert-zone{{padding:0 10px 6px;max-height:100px}}

  /* Stats dentro del sidebar */
  .acc-big{{font-size:26px}}
}}

/* ═══════════════════════════════════════
   RESPONSIVE — TABLET (769px–1024px)
   ═══════════════════════════════════════ */
@media (min-width:769px) and (max-width:1024px) {{
  aside{{width:200px}}
  .card-title{{font-size:10px}}
  .acc-big{{font-size:26px}}
}}

/* ═══════════════════════════════════════
   RESPONSIVE — DESKTOP WIDE (>1024px)
   ═══════════════════════════════════════ */
@media (min-width:1025px) {{
  aside{{width:250px}}
  #chat{{padding:18px 22px}}
  .msg{{max-width:78%}}
  footer{{padding:12px 20px}}
}}
</style>
</head>
<body>

<header>
  <div class="logo">M</div>
  <div class="hinfo">
    <h1>MIIA</h1>
    <span id="stxt">Conectando...</span>
  </div>
  <div class="sdot" id="sdot"></div>
  <div class="hright">
    {user_block}
    <a class="hbtn" href="/admin" title="Admin">⚙️<span> Admin</span></a>
  </div>
</header>

<!-- ZONA ALERTAS -->
<div id="alert-zone"></div>

<!-- OVERLAY MOBILE -->
<div class="sidebar-overlay" id="overlay" onclick="closeSidebar()"></div>

<div class="main">
<!-- ── SIDEBAR ── -->
<aside id="sidebar">
  <div class="aside-inner">

    <!-- Accuracy -->
    <div class="card">
      <div class="card-title">🎯 Tasa de Aciertos</div>
      <div class="acc-big" id="acc-global">—</div>
      <div class="acc-sub">precisión global</div>
      <div class="acc-row">
        <span>30d: <strong id="acc-30">—</strong></span>
        <span style="color:var(--mt)" id="acc-total"></span>
      </div>
    </div>

    <!-- Señal actual -->
    <div class="card">
      <div class="card-title">📡 Última Señal</div>
      <div id="senal-now" style="color:var(--mt);font-size:12px">Sin señal aún</div>
    </div>

    <!-- Riesgo -->
    <div class="card">
      <div class="card-title">⚡ Riesgo de Mercado</div>
      <div style="font-size:26px;font-weight:800" id="riesgo-pct">—</div>
      <div style="height:5px;background:var(--bd);border-radius:3px;margin-top:8px;overflow:hidden">
        <div id="riesgo-bar" style="height:5px;border-radius:3px;transition:width .5s"></div>
      </div>
    </div>

    <!-- Sectores -->
    <div class="card">
      <div class="card-title">📊 Sectores</div>
      <div id="sectores-list" style="color:var(--mt);font-size:12px">Cargando...</div>
    </div>

    <!-- Portfolio -->
    <div class="card">
      <div class="card-title">💼 Portfolio MIIA</div>
      <div id="portfolio-list" style="color:var(--mt);font-size:12px">Cargando...</div>
    </div>

  </div>
</aside>

<!-- ── CHAT AREA ── -->
<div class="chat-area">
  <div id="chat">
    <div class="msg mb">
      <div class="bb">
        👋 Hola{user_hi}. Soy <strong>MIIA</strong>.<br><br>
        Analizá mercados conmigo. Preguntame sobre sectores, activos o señales.<br>
        <em>Ej: "¿Cómo está tecnología?" · "¿Compro XLK?" · "¿Hay riesgo?"</em>
      </div>
      <div class="ts">MIIA v3.0</div>
    </div>
  </div>
  <footer>
    <div class="ir">
      <textarea id="msg" placeholder="Consultá sobre el mercado..." rows="1"></textarea>
      <button id="btn" onclick="send()">Enviar</button>
    </div>
    <div class="hint">No es asesoramiento financiero.</div>
  </footer>
</div>
</div>

<!-- BOTTOM NAV (solo mobile) -->
<div class="bottom-nav">
  <div class="bnav-inner">
    <button class="bnav-btn active" id="nav-chat" onclick="showTab('chat')">
      <span class="bnav-icon">💬</span>Chat
    </button>
    <button class="bnav-btn" id="nav-market" onclick="toggleSidebar()">
      <span class="bnav-icon">📊</span>Mercado
    </button>
    <button class="bnav-btn" onclick="location='/admin'">
      <span class="bnav-icon">⚙️</span>Admin
    </button>
  </div>
</div>

<script>
// ── Estado ───────────────────────────────────────────────
const chat   = document.getElementById('chat');
const inp    = document.getElementById('msg');
const btn    = document.getElementById('btn');
const sdot   = document.getElementById('sdot');
const stxt   = document.getElementById('stxt');
const sidebar= document.getElementById('sidebar');
const overlay= document.getElementById('overlay');
let ws, typing;
let SES = 'S' + Math.random().toString(36).substr(2,8).toUpperCase();
const USER_ID   = '{user_id}';
const USER_NAME = '{user_name}';
const isMobile  = () => window.innerWidth <= 768;

const alertasActivas = new Map();
const COLORES = {{
  CRITICO:  {{ bg:"#1e0730", border:"#7c3aed", txt:"#c4b5fd" }},
  PELIGRO:  {{ bg:"#1c0505", border:"#ef4444", txt:"#fca5a5" }},
  ATENCION: {{ bg:"#1c1005", border:"#f59e0b", txt:"#fcd34d" }},
  INFO:     {{ bg:"#0f1928", border:"#3b82f6", txt:"#93c5fd" }},
}};

// ── Sidebar mobile ───────────────────────────────────────
function toggleSidebar() {{
  const open = sidebar.classList.contains('open');
  if (open) closeSidebar(); else openSidebar();
}}
function openSidebar() {{
  sidebar.classList.add('open');
  overlay.classList.add('open');
  document.getElementById('nav-market').classList.add('active');
  document.getElementById('nav-chat').classList.remove('active');
}}
function closeSidebar() {{
  sidebar.classList.remove('open');
  overlay.classList.remove('open');
  document.getElementById('nav-market').classList.remove('active');
  document.getElementById('nav-chat').classList.add('active');
}}
function showTab(tab) {{
  if (tab === 'chat') closeSidebar();
}}

// ── WebSocket ────────────────────────────────────────────
function conectar() {{
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => {{
    sdot.style.background = '#10b981';
    sdot.style.boxShadow  = '0 0 5px #10b981';
    stxt.textContent = 'Activo';
    loadData();
    setInterval(loadData, 60000);
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({{tipo:'ping'}})), 20000);
  }};
  ws.onclose = () => {{
    sdot.style.background = '#ef4444';
    stxt.textContent = 'Reconectando...';
    setTimeout(conectar, 3000);
  }};
  ws.onerror = () => ws.close();
  ws.onmessage = ({{data}}) => {{
    try {{
      const m = JSON.parse(data);
      if      (m.tipo === 'init')      onInit(m.payload);
      else if (m.tipo === 'decision')  {{ rmTyping(); showDecision(m.payload); btn.disabled = false; }}
      else if (m.tipo === 'accuracy')  showAccuracy(m.payload);
      else if (m.tipo === 'mercado')   showMercado(m.payload);
      else if (m.tipo === 'alerta')    showAlerta(m.payload);
      else if (m.tipo === 'stream') {{
        const p = m.payload;
        if (p.type === 'market_alert') showAlerta(p.alerta || p);
      }}
    }} catch(_) {{}}
  }};
}}

// ── Inicialización con datos existentes ──────────────────
function onInit(p) {{
  if (p.accuracy_global_pct) showAccuracy(p);
  if (p.sectores) showMercado(p);
  if (p.ultimas_senales?.length) showUltimaSenal(p.ultimas_senales.at(-1));
}}

// ── Cargar datos del servidor ────────────────────────────
async function loadData() {{
  try {{
    const [acc, mkt, pf] = await Promise.all([
      fetch('/api/accuracy').then(r => r.json()),
      fetch('/api/market').then(r => r.json()),
      fetch('/api/portfolio').then(r => r.json()),
    ]);
    showAccuracy(acc);
    showMercado(mkt);
    showPortfolio(pf);
  }} catch(_) {{}}
}}

// ── Accuracy ─────────────────────────────────────────────
function showAccuracy(p) {{
  const ag  = p.accuracy_global_pct || p.accuracy_global || '—';
  const a30 = p.accuracy_30d_pct    || p.accuracy_30d    || '—';
  const el  = document.getElementById('acc-global');
  el.textContent = ag;
  const num = parseFloat(String(ag)) || 0;
  el.style.color = num >= 60 ? '#10b981' : num >= 50 ? '#f59e0b' : '#ef4444';
  document.getElementById('acc-30').textContent    = a30;
  const tot = p.total || p.total_decisiones || 0;
  document.getElementById('acc-total').textContent = tot ? `${{tot}} señales` : '';
}}

// ── Mercado ───────────────────────────────────────────────
function showMercado(p) {{
  const r   = p.riesgo_num ?? parseFloat(p.riesgo_pct) ?? 0;
  const rEl = document.getElementById('riesgo-pct');
  rEl.textContent = typeof r === 'number' ? r + '%' : String(r);
  const bar = document.getElementById('riesgo-bar');
  bar.style.width      = Math.min(r, 100) + '%';
  bar.style.background = r >= 70 ? '#ef4444' : r >= 40 ? '#f59e0b' : '#10b981';

  const sec = p.sectores || {{}};
  const el  = document.getElementById('sectores-list');
  if (!Object.keys(sec).length) {{ el.textContent = 'Sin datos'; return; }}
  el.innerHTML = Object.entries(sec).map(([n, s]) => {{
    const ch  = parseFloat(s.change || 0);
    const w   = Math.min(100, Math.abs(ch) * 10);
    const col = ch >= 0 ? '#10b981' : '#ef4444';
    return `<div class="sector-row">
      <div class="sector-name">
        <span>${{s.etf || n.slice(0,7)}}</span>
        <span style="color:${{col}};font-weight:700">${{s.change_str || ch+'%'}}</span>
      </div>
      <div class="sector-bar-wrap">
        <div class="sector-bar" style="width:${{w}}%;background:${{col}}"></div>
      </div>
    </div>`;
  }}).join('');
}}

// ── Portfolio ─────────────────────────────────────────────
function showPortfolio(data) {{
  const el = document.getElementById('portfolio-list');
  if (!data?.activos?.length) {{
    el.innerHTML = '<span style="color:var(--mt)">Sin portfolio aún</span>';
    return;
  }}
  const p   = data.portfolio;
  const tot = data.activos.reduce((s, a) => s + parseFloat(a.peso_pct || 0), 0) || 100;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:7px;font-size:11px">
      <span style="color:var(--mt)">${{p.strategy || 'balanced'}}</span>
      <span>Riesgo <strong style="color:${{parseFloat(p.riesgo_pct)>60?'#ef4444':parseFloat(p.riesgo_pct)>35?'#f59e0b':'#10b981'}}">${{p.riesgo_pct}}%</strong></span>
    </div>
    ${{data.activos.map(a => {{
      const w = Math.max(3, Math.round(parseFloat(a.peso_pct) / tot * 100));
      return `<div class="p-row">
        <span class="p-symbol">${{a.symbol}}</span>
        <div class="p-bar-wrap"><div class="p-bar" style="width:${{w}}%;background:${{a.color||'var(--ac)'}}"></div></div>
        <span class="p-pct" style="color:${{a.color||'var(--tx)'}}">${{a.peso_pct}}%</span>
        <span class="p-change" style="color:${{a.color||'var(--mt)'}}">${{a.change_str||''}}</span>
      </div>`;
    }}).join('')}}
    <div style="font-size:10px;color:var(--mt);margin-top:5px;text-align:right">
      ${{p.confianza_pct}}% confianza · ${{p.n_activos}} activos
    </div>`;
}}

// ── Última señal ──────────────────────────────────────────
function showUltimaSenal(d) {{
  if (!d) return;
  const col = {{ BUY:'BUY', SELL:'SELL', HOLD:'HOLD' }}[d.senal] || 'HOLD';
  document.getElementById('senal-now').innerHTML =
    `<span class="senal-badge ${{col}}">${{d.senal}}</span>
     <div class="senal-meta">${{d.ticker}} · ${{d.conf_pct||''}} conf<br>
     Riesgo ${{d.riesgo_pct||''}} · ${{d.horizonte||''}}</div>`;
  fetch('/api/portfolio').then(r=>r.json()).then(showPortfolio).catch(()=>{{}});
}}

// ── Alertas ───────────────────────────────────────────────
function showAlerta(alerta) {{
  if (!alerta?.tipo) return;
  const col = COLORES[alerta.nivel] || COLORES.ATENCION;
  const now = Date.now();

  // Card completa en el chat
  const div = document.createElement('div');
  div.className = 'msg mb';
  div.id = `alerta-${{alerta.id || alerta.tipo}}`;

  const razonesHtml = (alerta.razones || [])
    .map(r => `<div class="alerta-razon">${{esc(r)}}</div>`).join('');

  const geminiHtml = alerta.explicacion_gemini
    ? `<div style="margin-top:8px;padding:8px;background:rgba(255,255,255,.05);
                   border-radius:6px;font-size:12px;color:#cbd5e1;line-height:1.6;
                   border-left:2px solid rgba(255,255,255,.2)">
         <span style="font-size:10px;color:var(--mt);text-transform:uppercase;
                      letter-spacing:.5px;display:block;margin-bottom:4px">Análisis MIIA</span>
         ${{esc(alerta.explicacion_gemini)}}
       </div>` : '';

  const sectoresHtml = alerta.sectores_afectados?.length
    ? `<div style="font-size:11px;color:var(--mt);margin-top:5px">
         Sectores: <strong>${{alerta.sectores_afectados.join(', ')}}</strong>
       </div>` : '';

  div.innerHTML = `
    <div class="alerta-card" style="background:${{col.bg}};border-left-color:${{col.border}}">
      <div class="alerta-titulo">
        <span>${{alerta.emoji || '⚠️'}}</span>
        <span style="color:${{col.txt}}">${{esc(alerta.titulo || '')}}</span>
        <span class="alerta-badge" style="background:${{col.border}}22;color:${{col.txt}};border-color:${{col.border}}">
          ${{alerta.nivel}}
        </span>
      </div>
      ${{razonesHtml}}
      ${{sectoresHtml}}
      ${{geminiHtml}}
      ${{alerta.recomendacion ? `
        <div class="alerta-rec">
          <strong>💡 Recomendación</strong>
          ${{esc(alerta.recomendacion)}}
        </div>` : ''}}
    </div>
    <div class="ts">MIIA Alertas · ${{new Date(alerta.ts || now).toLocaleTimeString('es-AR')}}</div>`;

  chat.appendChild(div);
  scroll();

  // Banner compacto en zona superior
  const zone = document.getElementById('alert-zone');
  zone.style.display = 'block';
  let banner = document.getElementById(`banner-${{alerta.tipo}}`);
  if (!banner) {{
    banner = document.createElement('div');
    banner.id = `banner-${{alerta.tipo}}`;
    zone.appendChild(banner);
  }}
  banner.className = 'alert-banner';
  banner.style.cssText = `background:${{col.bg}};border-color:${{col.border}};color:${{col.txt}}`;
  banner.innerHTML = `
    <span>${{alerta.emoji || '⚠️'}}</span>
    <span style="flex:1;font-weight:600">${{esc(alerta.titulo || '')}}</span>
    <span onclick="this.parentElement.style.display='none'" style="cursor:pointer;opacity:.6;padding:0 4px">✕</span>`;
  banner.onclick = e => {{
    if (e.target.tagName !== 'SPAN' || e.target.textContent !== '✕') {{
      const el = document.getElementById(`alerta-${{alerta.id || alerta.tipo}}`);
      el?.scrollIntoView({{behavior:'smooth'}});
    }}
  }};
  alertasActivas.set(alerta.tipo, alerta);
}}

// ── Chat ──────────────────────────────────────────────────
async function send() {{
  const txt = inp.value.trim();
  if (!txt || btn.disabled) return;
  addMsg(txt, 'user');
  inp.value = '';
  inp.style.height = 'auto';
  btn.disabled = true;
  showTyping();
  // Cerrar sidebar en mobile al enviar
  if (isMobile()) closeSidebar();
  try {{
    await fetch('/api/chat', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ mensaje: txt, user_id: USER_ID, nombre: USER_NAME, sesion: SES }})
    }});
  }} catch(e) {{
    rmTyping();
    addMsg('⚠️ Sin conexión.', 'bot');
    btn.disabled = false;
  }}
}}

function addMsg(txt, tipo) {{
  const d = document.createElement('div');
  d.className = 'msg ' + (tipo === 'user' ? 'mu' : 'mb');
  d.innerHTML = `<div class="bb">${{esc(txt)}}</div>
    <div class="ts">${{new Date().toLocaleTimeString('es-AR')}}</div>`;
  chat.appendChild(d);
  scroll();
}}

function showDecision(d) {{
  const col = {{BUY:'BUY',SELL:'SELL',HOLD:'HOLD'}}[d.senal] || 'HOLD';
  const div = document.createElement('div');
  div.className = 'msg mb';
  div.innerHTML = `<div class="dc">
    <div class="dc-head">
      <span class="senal-badge ${{col}}">${{d.senal}}</span>
      <strong>${{d.ticker}}</strong>
      <span style="font-size:10px;color:var(--mt)">${{new Date(d.ts||Date.now()).toLocaleString('es-AR')}}</span>
    </div>
    <div class="dc-txt">${{esc(d.texto||d.resumen||'')}}</div>
    <div class="dc-meta">
      <div class="dm"><span class="dl">Confianza</span><span class="dv">${{d.conf_pct||'—'}}</span></div>
      <div class="dm"><span class="dl">Riesgo</span><span class="dv">${{d.riesgo_pct||'—'}}</span></div>
      <div class="dm"><span class="dl">Horizonte</span><span class="dv">${{d.horizonte||'—'}}</span></div>
      <div class="dm"><span class="dl">Stop Loss</span><span class="dv">${{d.stop_pct||'—'}}</span></div>
    </div>
  </div><div class="ts">MIIA · ${{d.senal}}</div>`;
  chat.appendChild(div);
  showUltimaSenal(d);
  scroll();
}}

function showTyping() {{
  rmTyping();
  const d = document.createElement('div');
  d.className = 'msg mb'; d.id = 'ty';
  d.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  chat.appendChild(d);
  scroll();
}}
function rmTyping() {{ const e = document.getElementById('ty'); if (e) e.remove(); }}
function scroll()   {{ requestAnimationFrame(() => {{ chat.scrollTop = chat.scrollHeight; }}); }}
function esc(s)     {{
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}}

// ── Input textarea ────────────────────────────────────────
inp.addEventListener('input', () => {{
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 100) + 'px';
}});
inp.addEventListener('keydown', e => {{
  if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {{
    e.preventDefault(); send();
  }}
}});

// ── Swipe para abrir/cerrar sidebar en mobile ─────────────
let touchStartX = 0;
document.addEventListener('touchstart', e => {{ touchStartX = e.touches[0].clientX; }}, {{passive:true}});
document.addEventListener('touchend', e => {{
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (!isMobile()) return;
  if (dx > 60 && touchStartX < 30) openSidebar();   // swipe right desde borde
  if (dx < -60 && sidebar.classList.contains('open')) closeSidebar();
}}, {{passive:true}});

conectar();
</script>
</body>
</html>"""

_CHAT_HTML_TEMPLATE = CHAT_HTML

def CHAT_HTML_F(**kwargs):
    user_name  = kwargs.get("user_name","")
    oauth_base = kwargs.get("oauth_base", OAUTH_BASE_URL)
    user_id    = kwargs.get("user_id","anonimo")
    if user_name:
        user_block = f'<span class="user-ok">✅ {user_name}</span>'
        user_hi    = f", <strong>{user_name}</strong>"
    else:
        user_block = f'''<a class="hbtn" href="{oauth_base}/auth/google">
          <svg width="12" height="12" viewBox="0 0 24 24"><path fill="#EA4335" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Google</a>
        <a class="hbtn" href="{oauth_base}/auth/microsoft">
          <svg width="12" height="12" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
          Microsoft</a>'''
        user_hi = ""
    return (CHAT_HTML
            .replace("{user_block}", user_block)
            .replace("{user_hi}", user_hi)
            .replace("{user_name}", user_name)
            .replace("{user_id}", user_id)
            .replace("{oauth_base}", oauth_base))

# (ruta GET / definida arriba — esta era una copia duplicada eliminada)

# ── Admin HTML ──────────────────────────────────────────────

ADMIN_LOGIN_HTML = """<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>MIIA Admin</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0a0e1a;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;
     display:flex;align-items:center;justify-content:center;height:100vh}}
.box{{background:#111827;border:1px solid #1e2d45;border-radius:14px;
      padding:32px;width:340px;text-align:center}}
.logo{{font-size:32px;font-weight:900;color:#3b82f6;margin-bottom:4px}}
h2{{font-size:16px;font-weight:700;margin-bottom:4px}}
p{{font-size:12px;color:#64748b;margin-bottom:24px}}
input[type=password]{{width:100%;background:#1a2236;border:1px solid #1e2d45;
  color:#e2e8f0;padding:11px 14px;border-radius:9px;font-size:14px;
  outline:none;margin-bottom:12px}}
input:focus{{border-color:#3b82f6}}
button{{width:100%;background:#3b82f6;color:#fff;border:none;
  padding:11px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer}}
button:hover{{opacity:.9}}
<!--ERROR-->
</style></head>
<body>
<div class="box">
  <div class="logo">M</div>
  <h2>Panel de Administración</h2>
  <p>MIIA v3.0 — Acceso restringido</p>
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Contraseña de administrador" autofocus>
    <button type="submit">Ingresar</button>
  </form>
</div>
</body></html>"""

ADMIN_DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MIIA Admin Dashboard</title>
<style>
:root{--bg:#0a0e1a;--s1:#111827;--s2:#1a2236;--bd:#1e2d45;--tx:#e2e8f0;
     --mt:#64748b;--ac:#3b82f6;--by:#10b981;--sl:#ef4444;--hd:#f59e0b;--r:10px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font-family:'Inter',system-ui,sans-serif;min-height:100vh}
header{background:var(--s1);border-bottom:1px solid var(--bd);padding:12px 24px;
       display:flex;align-items:center;gap:12px}
.logo{font-size:18px;font-weight:900;color:var(--ac)}
header h1{font-size:14px;font-weight:700}
.badge{background:#451a03;color:var(--hd);border:1px solid var(--hd);
       padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700}
.sdot{width:8px;height:8px;border-radius:50%;background:#10b981;
      box-shadow:0 0 5px #10b981;animation:pu 2s infinite;margin-left:auto}
@keyframes pu{0%,100%{opacity:1}50%{opacity:.4}}
.container{max-width:1400px;margin:0 auto;padding:20px}
/* Stats cards */
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat-card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:16px}
.stat-label{font-size:10px;color:var(--mt);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.stat-val{font-size:32px;font-weight:900;line-height:1}
.stat-sub{font-size:11px;color:var(--mt);margin-top:3px}
.green{color:#10b981} .red{color:#ef4444} .blue{color:#3b82f6} .yellow{color:#f59e0b}
/* Sections */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.panel{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:16px}
.panel-title{font-size:11px;color:var(--mt);text-transform:uppercase;
             letter-spacing:.5px;margin-bottom:12px;font-weight:700}
/* Países */
.pais-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px}
.pais-bar-wrap{flex:1;height:5px;background:var(--bd);border-radius:3px;overflow:hidden}
.pais-bar{height:5px;border-radius:3px;background:var(--ac)}
.pais-count{font-weight:700;font-size:12px;min-width:25px;text-align:right;color:var(--mt)}
/* Tabla clientes */
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 10px;color:var(--mt);font-weight:600;
   font-size:10px;text-transform:uppercase;border-bottom:1px solid var(--bd)}
td{padding:8px 10px;border-bottom:1px solid #0d1525}
tr:hover td{background:#0d1525}
.plan-badge{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700}
.free{background:#1e2d45;color:var(--mt)}
.basico{background:#1d4ed8;color:#93c5fd}
.pro{background:#064e3b;color:#6ee7b7}
.institucional{background:#451a03;color:#fcd34d}
/* Consultas chart */
.chart-wrap{display:flex;align-items:flex-end;gap:3px;height:60px;margin-top:8px}
.bar-item{flex:1;background:var(--ac);border-radius:2px 2px 0 0;
          min-height:2px;transition:height .3s;opacity:.7}
.bar-item:hover{opacity:1}
/* online pulse */
.pulse-dot{display:inline-block;width:8px;height:8px;border-radius:50%;
           background:#10b981;box-shadow:0 0 6px #10b981;
           animation:pu 2s infinite;margin-right:5px;vertical-align:middle}
/* mapa países flags */
.flag{font-size:16px}
</style>
</head>
<body>
<header>
  <span class="logo">M</span>
  <h1>MIIA — Panel de Administración</h1>
  <span class="badge">ADMIN</span>
  <div class="sdot" id="adot"></div>
</header>

<div class="container">
  <!-- KPIs -->
  <div class="grid4">
    <div class="stat-card">
      <div class="stat-label">🟢 En Línea Ahora</div>
      <div class="stat-val green" id="a-online">—</div>
      <div class="stat-sub"><span class="pulse-dot"></span>usuarios activos</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">📊 Consultas / Hora</div>
      <div class="stat-val blue" id="a-qhora">—</div>
      <div class="stat-sub">mensajes recibidos</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">👥 Total Clientes</div>
      <div class="stat-val" id="a-total">—</div>
      <div class="stat-sub">registrados en DB</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">🎯 Accuracy MIIA</div>
      <div class="stat-val yellow" id="a-acc">—</div>
      <div class="stat-sub" id="a-dec">— decisiones</div>
    </div>
  </div>

  <div class="grid2">
    <!-- Top países -->
    <div class="panel">
      <div class="panel-title">🌍 Distribución por País</div>
      <div id="paises-list">Cargando...</div>
    </div>

    <!-- Consultas por hora (mini chart) -->
    <div class="panel">
      <div class="panel-title">📈 Consultas por Hora</div>
      <div class="chart-wrap" id="chart-bars">
        <div style="font-size:11px;color:var(--mt)">Acumulando datos...</div>
      </div>
      <div style="font-size:10px;color:var(--mt);margin-top:6px" id="chart-label">Últimas horas</div>
    </div>
  </div>

  <!-- Tabla clientes -->
  <div class="panel">
    <div class="panel-title">👥 Últimos Clientes</div>
    <table>
      <thead>
        <tr>
          <th>País</th><th>Ciudad</th><th>IP</th><th>Usuario</th>
          <th>Plan</th><th>Consultas</th><th>Última visita</th>
        </tr>
      </thead>
      <tbody id="clientes-tbody">
        <tr><td colspan="7" style="color:var(--mt);text-align:center">Cargando...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
const ADMIN_TOKEN = document.cookie.match(/miia_admin=([^;]+)/)?.[1] || '';
const PAISES_FLAGS = {
  'Argentina':'🇦🇷','Brazil':'🇧🇷','Brasil':'🇧🇷','Chile':'🇨🇱',
  'Uruguay':'🇺🇾','Paraguay':'🇵🇾','Peru':'🇵🇪','Perú':'🇵🇪',
  'Colombia':'🇨🇴','Mexico':'🇲🇽','México':'🇲🇽','United States':'🇺🇸',
  'España':'🇪🇸','Spain':'🇪🇸','Desconocido':'🌐','Unknown':'🌐',
};
const PLAN_LABELS = {free:'free',basico:'basico',pro:'pro',institucional:'institucional'};

let consultasHist = [];

async function loadDashboard() {
  try {
    const d = await fetch('/api/admin/dashboard').then(r=>r.json());
    document.getElementById('a-online').textContent = d.online_now || 0;
    document.getElementById('a-qhora').textContent  = d.consultas_hora || 0;
    document.getElementById('a-total').textContent  = d.total_clientes || 0;
    document.getElementById('a-acc').textContent    = d.accuracy_pct || '—';
    document.getElementById('a-dec').textContent    = `${d.total_decisiones||0} decisiones`;

    // Países
    const pl = document.getElementById('paises-list');
    if(d.top_paises?.length) {
      const max = d.top_paises[0].count || 1;
      pl.innerHTML = d.top_paises.map(p => {
        const flag = PAISES_FLAGS[p.pais] || '🌐';
        const w = Math.max(2, Math.round(p.count/max*100));
        return `<div class="pais-row">
          <span class="flag">${flag}</span>
          <span style="min-width:90px;font-size:12px">${p.pais}</span>
          <div class="pais-bar-wrap"><div class="pais-bar" style="width:${w}%"></div></div>
          <span class="pais-count">${p.count}</span>
        </div>`;
      }).join('');
    } else pl.innerHTML = '<span style="color:var(--mt);font-size:12px">Sin datos aún</span>';

    // Tabla clientes
    const tb = document.getElementById('clientes-tbody');
    if(d.ultimos_clientes?.length) {
      tb.innerHTML = d.ultimos_clientes.map(c => {
        const flag = PAISES_FLAGS[c.pais] || '🌐';
        const plan = c.plan || 'free';
        const ts = c.ultima_visita ? new Date(c.ultima_visita).toLocaleString('es-AR') : '—';
        return `<tr>
          <td>${flag} ${c.pais||'—'}</td>
          <td>${c.ciudad||'—'}</td>
          <td style="font-family:monospace;font-size:11px;color:var(--mt)">${c.ip||'—'}</td>
          <td style="color:var(--mt);font-size:11px">${(c.user_id||'anonimo').slice(0,20)}</td>
          <td><span class="plan-badge ${plan}">${plan}</span></td>
          <td style="text-align:right;font-weight:700">${c.total_consultas||0}</td>
          <td style="color:var(--mt);font-size:11px">${ts}</td>
        </tr>`;
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" style="color:var(--mt);text-align:center">Sin clientes registrados aún</td></tr>';
    }

    // Chart consultas
    consultasHist.push(d.consultas_hora || 0);
    if(consultasHist.length > 12) consultasHist.shift();
    renderChart();

  } catch(e) { console.warn('Dashboard error:', e); }
}

function renderChart() {
  const wrap = document.getElementById('chart-bars');
  if(!consultasHist.length) return;
  const max = Math.max(...consultasHist, 1);
  wrap.innerHTML = consultasHist.map((v,i) => {
    const h = Math.max(2, Math.round(v/max*55));
    return `<div class="bar-item" style="height:${h}px" title="${v} consultas"></div>`;
  }).join('');
}

// WebSocket admin
function conectarWs() {
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/admin?admin_token=${ADMIN_TOKEN}`);
  ws.onopen = () => {
    document.getElementById('adot').style.background='#10b981';
    setInterval(()=>ws.readyState===1&&ws.send(JSON.stringify({tipo:'ping'})),20000);
  };
  ws.onclose = () => {
    document.getElementById('adot').style.background='#ef4444';
    setTimeout(conectarWs, 3000);
  };
  ws.onmessage = ({data}) => {
    try {
      const m = JSON.parse(data);
      if(m.tipo === 'admin_update') {
        document.getElementById('a-online').textContent = m.payload.online_now || 0;
        document.getElementById('a-qhora').textContent  = m.payload.consultas_hora || 0;
      }
    } catch(_) {}
  };
}

loadDashboard();
setInterval(loadDashboard, 15000);
conectarWs();
</script>
</body>
</html>"""

# ── Entry point ─────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    # BIND A LOOPBACK (30-ago-2026). Estaba en "0.0.0.0", o sea escuchando en
    # todas las interfaces. El único cliente legítimo es class30, que proxea a
    # http://localhost:5005 — nada necesita alcanzarlo desde afuera.
    #
    # Con 0.0.0.0, cualquiera que llegue al puerto 5005 se saltea class30 por
    # completo: su rate limiter, su `requireAuth` y el `requirePro` que gatea
    # las señales Pro. `/api/predicciones` acá no tiene ningún control propio
    # —devuelve los datos directo— y `/admin` también se sirve desde este
    # proceso. Depender de que un firewall tape el puerto es un único punto de
    # falla; el bind correcto es la defensa que no se puede desconfigurar.
    #
    # MIIA_BIND permite volver a exponerlo si algún día hace falta, pero el
    # valor por defecto es el seguro.
    uvicorn.run("miia_chatbot:app", host=os.getenv("MIIA_BIND", "127.0.0.1"),
                port=PORT, reload=(MIIA_ENV=="local"), log_level="info")