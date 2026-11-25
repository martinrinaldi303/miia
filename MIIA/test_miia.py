# ==========================================================
# MIIA — Núcleo Python + Interfaz HTTP (v6.2-RT Real-Time Response)
# ==========================================================
# Compatible con MotorLenguaje v5.1 + bloque de TEST de integración completo
# ==========================================================

import os
import sys
import json
import time
import redis
import logging
import threading
import requests
import socket
from datetime import datetime
from flask import Flask, request, jsonify, render_template, send_file
from flask_cors import CORS
from flask_socketio import SocketIO

# ==========================================================
# COMPATIBILIDAD UTF-8
# ==========================================================
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ==========================================================
# IMPORTAR MOTORES
# ==========================================================
try:
    from MotorEmocional import MotorEmocional
    from MotorGrafico import MotorGrafico
    from MotorLenguaje import MotorLenguaje
    from modulo_de_control import ModuloControl
    from MotorMovimiento import MotorMovimiento
except Exception as e:
    print(f"⚠️ Algunos módulos no se pudieron importar: {e}")
    class _Stub:
        def __init__(self, *args, **kwargs): pass
        def procesar(self, x): return {"neutral": 1.0}
        def analizar_consolidado(self, texto=""): return {"neutral": 1.0}
        def responder_pregunta(self, texto, user_id="anonimo"): return {"explicacion": f"Simulación: {texto}"}
        def procesar_evento_desde_app(self, data): return {"respuesta": f"Simulación procesada: {data}"}
        def generar_tts(self, texto, tag): return None
        def reconocer_audio(self, path): return "texto reconocido"
        def generar(self, emoción): return {"accion": "gesto_simulado", "emocion": emoción}
        def actualizar_estado(self, *a, **k): return {"estado": "simulado"}
    MotorEmocional = MotorGrafico = MotorLenguaje = ModuloControl = MotorMovimiento = _Stub

# ==========================================================
# RUTAS BASE
# ==========================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))
SCRIPTS_DIR = os.path.join(ROOT_DIR, "scripts")
PUBLIC_DIR = os.path.join(SCRIPTS_DIR, "publi")
LOG_DIR = os.path.join(ROOT_DIR, "operador", "aprendizaje", "logs")
AUDIO_DIR = os.path.join(BASE_DIR, "audio")

os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)

# ==========================================================
# LOGGING GLOBAL
# ==========================================================
LOG_FILE = os.path.join(LOG_DIR, f"app_miia_{datetime.now().strftime('%Y%m%d')}.log")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout)
    ]
)
log = logging.getLogger("MIIA")
log.info("🚀 Iniciando Núcleo Python MIIA v6.2-RT")

# ==========================================================
# CONFIGURACIÓN REDIS
# ==========================================================
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
REDIS_INPUT = "class25_output"
REDIS_FEEDBACK = "python_feedback"

def conectar_redis(max_reintentos=10, espera=3):
    for intento in range(max_reintentos):
        try:
            r = redis.StrictRedis.from_url(REDIS_URL, decode_responses=True)
            r.ping()
            log.info(f"✅ Conectado a Redis ({REDIS_URL})")
            return r
        except Exception as e:
            log.warning(f"Redis no disponible (intento {intento+1}/{max_reintentos}): {e}")
            time.sleep(espera)
    log.error("❌ Fallo de conexión a Redis tras múltiples intentos.")
    raise SystemExit(1)

redis_client = conectar_redis()
pubsub = redis_client.pubsub(ignore_subscribe_messages=True)
pubsub.subscribe(REDIS_INPUT)

# ==========================================================
# INICIALIZACIÓN DE MOTORES
# ==========================================================
def iniciar_motores():
    global motor_emocional, motor_grafico, motor_lenguaje, modulo_control, motor_movimiento
    try:
        log.info("⚙️ Iniciando motores cognitivos...")
        motor_emocional = MotorEmocional()
        motor_grafico = MotorGrafico()
        motor_lenguaje = MotorLenguaje(tts=True, stt=True)
        modulo_control = ModuloControl()
        motor_movimiento = MotorMovimiento()
        log.info("✅ Todos los motores inicializados correctamente.")
    except Exception as e:
        log.exception(f"❌ Error iniciando motores: {e}")
        motor_emocional = motor_grafico = motor_lenguaje = modulo_control = motor_movimiento = MotorEmocional()
        log.warning("⚙️ Motores simulados en uso (modo fallback).")

iniciar_motores()

# ==========================================================
# FUNCIONES AUXILIARES
# ==========================================================
def _call_emocional(contenido):
    try:
        if hasattr(motor_emocional, "procesar"):
            return motor_emocional.procesar(contenido)
        elif hasattr(motor_emocional, "analizar_consolidado"):
            import asyncio
            return asyncio.run(motor_emocional.analizar_consolidado(texto=str(contenido)))
    except Exception as e:
        log.warning(f"Error en motor emocional: {e}")
    return {"neutral": 1.0}

# ==========================================================
# ESCUCHA REDIS
# ==========================================================
def escuchar_redis():
    log.info(f"📡 Escuchando canal Redis: {REDIS_INPUT}")
    for message in pubsub.listen():
        if message and message.get("type") == "message":
            try:
                data = json.loads(message.get("data", "{}"))
                procesar_evento(data)
            except Exception as e:
                log.warning(f"Mensaje Redis inválido: {e}")

threading.Thread(target=escuchar_redis, daemon=True).start()

# ==========================================================
# PIPELINE COGNITIVO PRINCIPAL
# ==========================================================
def procesar_evento(data):
    try:
        canal = data.get("channel", "desconocido")
        contenido = data.get("data") or data
        log.info(f"🧩 Procesando evento desde {canal}")

        emocion = _call_emocional(contenido)
        respuesta = motor_lenguaje.procesar_evento_desde_app({"user": "sistema", "text": str(contenido)})
        contexto = {"emocion": emocion, "respuesta": respuesta}

        estado = {}
        if hasattr(modulo_control, "actualizar_estado"):
            try:
                estado = modulo_control.actualizar_estado(emocion=emocion, contexto=contexto)
            except Exception:
                estado = {}

        salida = {
            "timestamp": datetime.utcnow().isoformat(),
            "canal_origen": canal,
            "emocion": emocion,
            "respuesta": respuesta,
            "contexto": contexto,
            "estado": estado
        }

        redis_client.publish("class25_output", json.dumps(salida))
        redis_client.publish(REDIS_FEEDBACK, json.dumps(salida))
        socketio.emit("miia_evento", salida, namespace="/", broadcast=True)
        log.info("✅ Evento procesado correctamente.")
    except Exception as e:
        log.exception(f"Error procesando evento: {e}")

# ==========================================================
# SERVIDOR FLASK + SOCKET.IO
# ==========================================================
app = Flask(__name__, static_folder=PUBLIC_DIR, template_folder=PUBLIC_DIR)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

@app.route("/")
def index():
    try:
        return render_template("miia.html")
    except Exception:
        return "<h1>MIIA - Núcleo HTTP</h1><p>Interfaz web no disponible</p>"

@app.route("/miia/input", methods=["POST"])
def recibir_datos():
    try:
        data = request.get_json(force=True)
        user_id = data.get("user", "anonimo")
        texto = (data.get("text") or data.get("mensaje") or "").strip()
        canal = data.get("canal", "class33_input")

        if not texto:
            log.warning("⚠️ /miia/input recibido sin texto válido.")
            return jsonify({"respuesta": "No entendí el mensaje."}), 400

        log.info(f"🧠 [Entrada usuario:{user_id}] {texto}")

        emocion = _call_emocional(texto)
        resultado = motor_lenguaje.procesar_evento_desde_app({"user": user_id, "text": texto})
        texto_respuesta = resultado.get("respuesta", "Estoy procesando la información.")

        salida = {
            "timestamp": datetime.utcnow().isoformat(),
            "user": user_id,
            "canal": canal,
            "emocion": emocion,
            "respuesta": texto_respuesta
        }

        redis_client.publish("class25_output", json.dumps(salida))
        redis_client.publish("python_feedback", json.dumps(salida))
        socketio.emit("miia_evento", salida, namespace="/", broadcast=True)

        return jsonify({"respuesta": texto_respuesta, "emocion": emocion, "estado": "ok"}), 200
    except Exception as e:
        log.exception(f"Error en /miia/input: {e}")
        return jsonify({"respuesta": "Ocurrió un error procesando la solicitud."}), 500

# ==========================================================
# ENDPOINT DE SALUD
# ==========================================================
@app.route("/miia/salud", methods=["GET"])
def salud():
    uptime = round(time.time() - os.getpid(), 2)
    return jsonify({
        "status": "ok",
        "motores": ["emocional", "lenguaje", "grafico", "control", "movimiento", "tts", "stt"],
        "uptime": uptime
    }), 200

# ==========================================================
# BLOQUE DE TEST INTEGRADO (v1.1-R)
# ==========================================================
def test_integracion_miia():
    import redis, socket, requests

    log("🚀 Iniciando TEST COMPLETO DE MIIA...\n")

    REDIS_URL = "redis://localhost:6379"
    FLASK_URL = "http://localhost:5005/miia/salud"
    BLENDER_HOST = "127.0.0.1"
    BLENDER_PORT = 5055

    def test_redis():
        try:
            client = redis.StrictRedis.from_url(REDIS_URL, decode_responses=True)
            client.ping()
            log("✅ Redis responde correctamente.")
            return True
        except Exception as e:
            log(f"Redis no responde: {e}", "ERROR")
            return False

    def test_flask():
        try:
            response = requests.get(FLASK_URL, timeout=5)
            if response.status_code == 200:
                log(f"✅ Flask activo: {response.json()}")
                return True
            else:
                log(f"Flask respondió con error HTTP {response.status_code}", "ERROR")
                return False
        except Exception as e:
            log(f"Flask no responde: {e}", "ERROR")
            return False

    def test_brain_feed():
        try:
            client = redis.StrictRedis.from_url(REDIS_URL, decode_responses=True)
            pubsub = client.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe("class25_output")
            log("⌛ Esperando eventos del cerebro por 8 segundos...")
            start = time.time()
            while time.time() - start < 8:
                message = pubsub.get_message(timeout=1.0)
                if message and message.get("type") == "message":
                    payload = str(message.get("data", ""))[:100]
                    log(f"📡 Evento recibido del cerebro: {payload}...")
                    return True
            log("⚠️ No se recibieron mensajes del cerebro.")
            return False
        except Exception as e:
            log(f"Error escuchando al cerebro: {e}", "ERROR")
            return False

    resultados = {
        "Redis": test_redis(),
        "Flask": test_flask(),
        "Cerebro": test_brain_feed(),
    }

    resumen = "\n===== RESUMEN =====\n"
    for k, v in resultados.items():
        estado = "OK" if v else "ERROR"
        resumen += f"{k:<10}: {estado}\n"

    log(resumen)
    log("✅ Test de MIIA finalizado.\n")

# ==========================================================
# EJECUCIÓN SERVIDOR
# ==========================================================
if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        test_integracion_miia()
    else:
        try:
            PORT = int(os.getenv("PY_PORT", 5005))
            log.info(f"🔓 Servidor HTTP en http://0.0.0.0:{PORT}")
            socketio.run(app, host="0.0.0.0", port=PORT)
        except Exception as e:
            log.exception(f"Error al iniciar servidor Flask: {e}")
# ==========================================================
# BLOQUE DE AUTO-REINICIO INTELIGENTE (v2.0-R)
# ==========================================================
# Supervisa Flask, Redis y Cerebro en tiempo real
# Reinicia procesos caídos automáticamente con registro detallado
# ==========================================================

import subprocess
import psutil

def verificar_proceso(nombre):
    """Verifica si un proceso está activo."""
    for p in psutil.process_iter(attrs=["pid", "name", "cmdline"]):
        try:
            if nombre.lower() in " ".join(p.info["cmdline"]).lower():
                return True
        except Exception:
            continue
    return False


def reiniciar_servicio(nombre, comando, cwd=None):
    """Reinicia un servicio con log detallado."""
    try:
        log(f"♻️ Reiniciando servicio crítico: {nombre}...")
        subprocess.Popen(comando, cwd=cwd or BASE_DIR, shell=True)
        log(f"✅ {nombre} reiniciado correctamente.")
    except Exception as e:
        log(f"❌ No se pudo reiniciar {nombre}: {e}", "ERROR")


def auto_reinicio_monitor():
    """Monitor principal con chequeos cada 15 segundos."""
    log("🛰️ Iniciando monitor de estabilidad MIIA (auto-reinicio activo)...")
    contador = 0
    while True:
        contador += 1
        time.sleep(15)

        # 1️⃣ Redis
        try:
            r = redis.StrictRedis.from_url(REDIS_URL, decode_responses=True)
            r.ping()
        except Exception:
            log("⚠️ Redis no responde. Intentando reinicio...")
            _redis_bin = "redis-server.exe" if os.name == "nt" else "redis-server"
            reiniciar_servicio("Redis", _redis_bin, cwd=os.path.join(ROOT_DIR, "redis"))

        # 2️⃣ Flask
        try:
            response = requests.get("http://localhost:5005/miia/salud", timeout=4)
            if response.status_code != 200:
                log(f"⚠️ Flask responde con código {response.status_code}. Reiniciando...")
                reiniciar_servicio("Flask (app.py)", f"python {os.path.join(BASE_DIR, 'app.py')}")
        except Exception:
            if not verificar_proceso("app.py"):
                log("❌ Flask no responde. Reiniciando app.py...")
                reiniciar_servicio("Flask (app.py)", f"python {os.path.join(BASE_DIR, 'app.py')}")

        # 3️⃣ Cerebro (index.js o index central)
        index_path = os.path.join(ROOT_DIR, "scripts", "index.js")
        if os.path.exists(index_path) and not verificar_proceso("index.js"):
            log("⚠️ Proceso index.js no detectado. Reiniciando...")
            reiniciar_servicio("Cerebro Central (index.js)", f"node {index_path}", cwd=os.path.join(ROOT_DIR, "scripts"))

        # 4️⃣ Log de ciclo
        if contador % 8 == 0:  # cada 2 minutos
            log("✅ Monitor de estabilidad activo y estable.")


# ==========================================================
# ACTIVAR MONITOR DESPUÉS DEL TEST AUTOMÁTICO
# ==========================================================
if __name__ == "__main__" and "--test" in sys.argv:
    threading.Thread(target=auto_reinicio_monitor, daemon=True).start()
