#!/usr/bin/env bash
# ============================================================
# start_predictivo.sh — Arranca los motores predictivos MIIA (Linux)
# Equivalente Linux de start_predictivo.ps1.
#
# NOTA: en producción normalmente NO usás esto: el orquestador
#       `node operador/index.js` levanta TODO el sistema. Este script
#       es solo para arrancar a mano el subconjunto predictivo.
#
# Uso:   bash scripts/start_predictivo.sh
# ============================================================
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPTS/.." && pwd)"

echo "======================================="
echo "  MIIA — Motores Predictivos (Linux)"
echo "======================================="

# ── 0. Redis ────────────────────────────────────────────────
echo "[0/4] Verificando Redis…"
if redis-cli -p 6379 ping >/dev/null 2>&1; then
  echo "  Redis ya corriendo."
else
  echo "  Iniciando Redis…"
  sudo systemctl start redis-server 2>/dev/null || redis-server --daemonize yes
  sleep 2
  echo "  Redis OK"
fi

# ── 1. class44.py — Motor LSTM ──────────────────────────────
echo "[1/4] class44.py — Motor LSTM Predictivo"
( cd "$SCRIPTS" && nohup python3 class44.py > "$ROOT/logs/class44.out" 2>&1 & )
echo "  Iniciado (entrena en background ~5-10 min por ticker)."
sleep 2

# ── 2. class45.js — Sentimiento ─────────────────────────────
echo "[2/4] class45.js — Motor de Sentimiento"
( cd "$ROOT" && nohup node --experimental-vm-modules "$SCRIPTS/class45.js" > "$ROOT/logs/class45.out" 2>&1 & )
echo "  Iniciado (escucha class1_output)."
sleep 1

# ── 3. class46.js — Dashboard WebSocket ─────────────────────
echo "[3/4] class46.js — Dashboard Socket.IO (puerto 3001)"
( cd "$ROOT" && nohup node "$SCRIPTS/class46.js" > "$ROOT/logs/class46.out" 2>&1 & )
echo "  Iniciado."
sleep 1

# ── 4. miia_chatbot.py — Chat (puerto 5005) ─────────────────
echo "[4/4] miia_chatbot.py — Chat Python (puerto 5005)"
( cd "$ROOT/MIIA" && nohup python3 -m uvicorn miia_chatbot:app --host 0.0.0.0 --port 5005 > "$ROOT/logs/chatbot.out" 2>&1 & )
echo "  Iniciado."

echo "======================================="
echo "  Motores arrancados."
echo "  Chat    : http://localhost:5005"
echo "  Gateway : https://localhost:8443/"
echo "  NOTA: class44 entrena la LSTM la primera vez (~10 min)."
echo "======================================="
