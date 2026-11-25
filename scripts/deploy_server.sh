#!/usr/bin/env bash
# ============================================================
# deploy_server.sh — Instalación COMPLETA de MIIA en un servidor Ubuntu
# ------------------------------------------------------------
# Hace TODO de una: instala dependencias del sistema (Node, Python,
# Redis, MySQL, .NET/C#, build tools C++), instala deps del proyecto,
# RECOMPILA los módulos C++ a binarios Linux (los .exe de Windows NO
# corren en Linux), compila el motor .NET, configura la base de datos
# y deja el sistema listo para arrancar.
#
# USO (en el servidor, dentro de la carpeta del proyecto):
#   cd /opt/miia          # o donde hayas subido el código
#   bash scripts/deploy_server.sh
#
# Requiere: Ubuntu 20.04/22.04/24.04 y un usuario con sudo.
# Es idempotente: podés correrlo varias veces sin romper nada.
# ============================================================
set -euo pipefail

# ── Ubicación: el script vive en scripts/, la raíz es el padre ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
JOBS="$(nproc 2>/dev/null || echo 2)"

echo "════════════════════════════════════════════════════════"
echo "   MIIA · Deploy completo en Ubuntu"
echo "   Proyecto: $ROOT_DIR"
echo "════════════════════════════════════════════════════════"

# ── Preflight ───────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""      # ya somos root
else
  SUDO="sudo"
  command -v sudo >/dev/null || { echo "❌ Necesitás sudo o correr como root"; exit 1; }
fi
if ! grep -qiE "ubuntu|debian" /etc/os-release 2>/dev/null; then
  echo "⚠️  Este script está pensado para Ubuntu/Debian. Continuando igual…"
fi

export DEBIAN_FRONTEND=noninteractive

# ── 1. Paquetes base del sistema ────────────────────────────
echo ""
echo "▶ [1/9] Paquetes base (build tools, git, curl)…"
$SUDO apt-get update -y
$SUDO apt-get install -y \
  build-essential cmake git pkg-config curl wget unzip ca-certificates \
  nlohmann-json3-dev libspdlog-dev

# ── 2. Redis ────────────────────────────────────────────────
echo ""
echo "▶ [2/9] Redis…"
$SUDO apt-get install -y redis-server
$SUDO systemctl enable --now redis-server
redis-cli ping >/dev/null 2>&1 && echo "   ✓ Redis responde (PONG)" || echo "   ⚠️ Redis no responde aún"

# ── 3. MySQL ────────────────────────────────────────────────
echo ""
echo "▶ [3/9] MySQL server (reemplaza a XAMPP en Linux)…"
$SUDO apt-get install -y mysql-server
$SUDO systemctl enable --now mysql

# ── 4. Node.js 20 LTS ───────────────────────────────────────
echo ""
echo "▶ [4/9] Node.js 20 LTS…"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '[0-9]+' | head -1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
echo "   ✓ node $(node -v)  npm $(npm -v)"

# ── 5. Python 3 + venv ──────────────────────────────────────
echo ""
echo "▶ [5/9] Python 3 + venv…"
$SUDO apt-get install -y python3 python3-pip python3-venv
echo "   ✓ $(python3 --version)"

# ── 6. .NET SDK 9 (motor vectorial C#) ──────────────────────
echo ""
echo "▶ [6/9] .NET SDK 9 (C#)…"
if ! command -v dotnet >/dev/null 2>&1; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  $SUDO bash /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet
  $SUDO ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
fi
echo "   ✓ dotnet $(dotnet --version 2>/dev/null || echo '(revisar PATH)')"

# ── 7. Dependencias del proyecto (Node + Python) ────────────
echo ""
echo "▶ [7/9] npm install…"
npm install

echo ""
echo "▶ [7/9] Python venv + requirements…"
if [ ! -d MIIA/venv ]; then python3 -m venv MIIA/venv; fi
# torch CPU primero (servidor sin GPU → rueda liviana)
MIIA/venv/bin/pip install --upgrade pip
MIIA/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
MIIA/venv/bin/pip install -r MIIA/requirements.txt

# ── 8. Compilar C++ (Linux) y motor .NET ────────────────────
echo ""
echo "▶ [8/9] Compilando módulos C++ (Linux)…"
bash scripts/build_cpp_linux.sh

echo ""
echo "▶ [8/9] Compilando motor vectorial .NET…"
# TIENE que ser Release. `startMotorVectorial()` (operador/index.js) busca
# bin/Release/net9.0/MIIA_MotoresVectoriales.dll y, si no está, se cae a
# `dotnet run` — que es un WRAPPER: lanza MSBuild y después la app como hijo
# suyo, así que el PID que el orquestador rastrea no es el de la app y el
# SIGTERM del apagado no siempre le llega. Es el huérfano de dotnet del 1-ago
# que hizo que el pgrep de verificación diera "OK sin procesos" con el motor
# todavía corriendo. Acá decía `-c Debug`, o sea que una reinstalación con este
# script dejaba al orquestador en el fallback para siempre.
( cd MIIA_MotoresVectoriales && dotnet build -c Release ) || echo "   ⚠️ dotnet build falló — revisar arriba"
if [ ! -f MIIA_MotoresVectoriales/bin/Release/net9.0/MIIA_MotoresVectoriales.dll ]; then
  echo "   ⚠️ No quedó bin/Release/net9.0/MIIA_MotoresVectoriales.dll:"
  echo "      el orquestador va a caer a 'dotnet run' en Debug y lo va a decir en el log."
fi

# ── 9. Base de datos MySQL ──────────────────────────────────
echo ""
echo "▶ [9/9] Configurando base de datos…"
# Leer credenciales del .env (formato KEY=valor, sin comillas → parseamos a mano
# para respetar el espacio en 'Martin Rinaldi' y los acentos del password).
ENV_FILE="operador/aprendizaje/config/.env"
getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//'; }
DB_NAME="$(getenv DB_NAME)"; DB_NAME="${DB_NAME:-miia_cognitiva}"
DB_USER="$(getenv DB_USER)"; DB_USER="${DB_USER:-Martin Rinaldi}"
DB_PASS="$(getenv DB_PASS)"; DB_PASS="${DB_PASS:?falta DB_PASS en operador/aprendizaje/config/.env}"

$SUDO mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "   ✓ Base '$DB_NAME' y usuario '$DB_USER' listos"

# Cargar/restaurar permisos base si existe el script SQL
if [ -f operador/aprendizaje/config/reparar_permisos_mysql.sql ]; then
  $SUDO mysql < operador/aprendizaje/config/reparar_permisos_mysql.sql 2>/dev/null || true
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "   ✅ MIIA instalada."
echo "════════════════════════════════════════════════════════"
echo "   Falta 1 cosa antes de arrancar:"
echo "   · Editá  operador/aprendizaje/config/.env  y descomentá el"
echo "     bloque de dominio (MIIA_ENV=production, PUBLIC_BASE_URL, etc.)"
echo ""
echo "   Arrancar MIIA:"
echo "       node operador/index.js"
echo ""
echo "   Para que arranque sola al reiniciar el server, ver systemd en"
echo "   DEPLOY_LINUX.md (sección 10)."
echo "════════════════════════════════════════════════════════"
