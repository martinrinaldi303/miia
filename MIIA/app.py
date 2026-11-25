#!/usr/bin/env python3
"""
app.py — Lanzador del Flujo Python MIIA
========================================
Punto de entrada Python para el orquestador (operador/index.js).

Inicia y supervisa los subprocesos Python del sistema:
  1. miia_chatbot.py  — FastAPI chat + market dashboard (puerto 5005)
  2. class44.py       — Motor LSTM predictivo de mercado (corre en background)

NO tiene motores propios ni lógica de negocio.
Toda la lógica vive en miia_chatbot.py y class44.py.

Health check: index.js sondea http://localhost:5005/api/health
              que responde miia_chatbot.py directamente.
"""

import os
import sys
import time
import signal
import logging
import subprocess
import threading
from pathlib import Path

# Fix: stdout/stderr en Windows usa cp1252 por defecto → emojis y flechas se ven garbled
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8", errors="replace")

# ── Rutas ───────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent        # .../MIIA/MIIA/
ROOT_DIR = BASE_DIR.parent                         # .../MIIA/
LOG_DIR  = ROOT_DIR / "operador" / "aprendizaje" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Logger ───────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [app.py/%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_DIR / "app_python.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("app")

# ── Entorno ──────────────────────────────────────────────────────
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
PYTHON    = sys.executable   # ruta al mismo intérprete que corre este script

# ── Servicios a gestionar ────────────────────────────────────────
# Cada entrada: {nombre, cmd, cwd, proc, critico}
# critico=True → se reinicia automáticamente si cae
_services: list[dict] = []


def _lanzar(svc: dict) -> None:
    """Arranca un servicio y guarda el Popen en svc['proc']."""
    p = subprocess.Popen(
        svc["cmd"],
        cwd=str(svc["cwd"]),
        env={**os.environ, "REDIS_URL": REDIS_URL},
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    svc["proc"] = p
    log.info(f"[{svc['nombre']}] Iniciado — PID {p.pid}")


def iniciar_servicio(nombre: str, cmd: list[str],
                     cwd: Path | None = None,
                     critico: bool = True) -> dict:
    svc = {
        "nombre":  nombre,
        "cmd":     cmd,
        "cwd":     cwd or BASE_DIR,
        "proc":    None,
        "critico": critico,
    }
    _services.append(svc)
    _lanzar(svc)
    return svc


def _supervisor():
    """Hilo: revisa cada 15 s si algún proceso crítico cayó y lo reinicia."""
    while True:
        time.sleep(15)
        for svc in _services:
            if not svc["critico"]:
                continue
            p = svc["proc"]
            if p is not None and p.poll() is not None:
                log.warning(
                    f"[{svc['nombre']}] Cayó (code={p.returncode}) "
                    f"— reiniciando en 5s"
                )
                time.sleep(5)
                _lanzar(svc)


def _apagar(sig, _frame):
    log.info("Señal de cierre recibida — terminando subprocesos Python...")
    for svc in _services:
        p = svc.get("proc")
        if p and p.poll() is None:
            try:
                p.terminate()
                log.info(f"[{svc['nombre']}] Terminado (PID {p.pid})")
            except Exception as e:
                log.warning(f"[{svc['nombre']}] Error al terminar: {e}")
    log.info("app.py — flujo Python detenido.")
    sys.exit(0)


signal.signal(signal.SIGINT,  _apagar)
signal.signal(signal.SIGTERM, _apagar)


# ── Arranque ─────────────────────────────────────────────────────
def main():
    log.info("=" * 55)
    log.info("  app.py — Lanzador Flujo Python MIIA")
    log.info(f"  REDIS_URL  : {REDIS_URL}")
    log.info(f"  BASE_DIR   : {BASE_DIR}")
    log.info("=" * 55)

    # 1. FastAPI chatbot — puerto 5005
    #    index.js testea /api/health en este puerto
    chatbot = BASE_DIR / "miia_chatbot.py"
    if not chatbot.exists():
        log.error(f"miia_chatbot.py no encontrado en {chatbot}")
        sys.exit(1)
    iniciar_servicio("miia_chatbot", [PYTHON, str(chatbot)], cwd=BASE_DIR, critico=True)

    # Pequeña espera para que uvicorn levante antes de arrancar los siguientes
    time.sleep(4)

    # 2. Motor LSTM predictivo
    lstm = BASE_DIR / "class44.py"
    if lstm.exists():
        iniciar_servicio("class44_lstm", [PYTHON, str(lstm)], cwd=BASE_DIR, critico=True)
    else:
        log.warning(f"class44.py no encontrado en {lstm} — saltando LSTM")

    # Supervisor en hilo daemon
    threading.Thread(target=_supervisor, daemon=True, name="supervisor").start()
    log.info("Supervisión activa. Flujo Python iniciado.")

    # Loop de vida del proceso principal
    try:
        while True:
            time.sleep(30)
            vivos   = [s["nombre"] for s in _services if s["proc"] and s["proc"].poll() is None]
            caidos  = [s["nombre"] for s in _services if s["proc"] and s["proc"].poll() is not None]
            log.info(f"Estado — vivos: {vivos}  |  caídos: {caidos}")
    except KeyboardInterrupt:
        _apagar(None, None)


if __name__ == "__main__":
    main()
