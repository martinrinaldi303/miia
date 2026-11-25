#!/usr/bin/env bash
# ============================================================================
# deploy_linux.sh — Deploy COMPLETO de MIIA en un VPS Ubuntu (como Contabo)
# ----------------------------------------------------------------------------
# Deja el sistema de CERO a EN LÍNEA, de una sola corrida:
#   1. paquetes del sistema (build tools, git, curl, openssl)
#   2. Redis                        (servicio + boot)
#   3. MySQL 8 + base + usuario + ESQUEMA (36 tablas, con guarda anti-pisado)
#   4. Node.js 20 LTS
#   5. Python 3 + venv + torch (CPU) + requirements
#   6. .NET SDK 9 (motor vectorial C#)
#   7. deps del proyecto (npm install)
#   8. compila C++ (Linux) y .NET (Release)
#   9. .env (plantilla si no existe) + certificado TLS self-signed
#  10. build de la web (publi_src -> publi)
#  11. pm2: arranca 'miia' + arranque al bootear (pm2 startup + save)
#  12. firewall: 80/8443 SOLO desde Cloudflare (reusa firewall_cloudflare.sh)
#
# USO (en el server, como root o con sudo, dentro de la carpeta del proyecto):
#   cd /opt/miia                 # o donde subiste el código
#   bash scripts/deploy_linux.sh
#
# IDEMPOTENTE: podés correrlo varias veces. No pisa la base si ya tiene tablas,
# no regenera el cert si ya existe, no duplica reglas de firewall.
#
# INTERRUPTORES (variables de entorno):
#   USAR_PM2=0            no configura pm2 (arrancás a mano con node)
#   APLICAR_FIREWALL=0    no toca el firewall (hacelo aparte)
#   INSTALAR_OLLAMA=1     además instala el motor de lenguaje local (Ollama)
#   CF_FIREWALL_AUTO=1    aplica el firewall sin preguntar (si no, solo --revisar)
#   DOMINIO=miiaia.com    CN del certificado self-signed
#
# Requiere: Ubuntu 20.04/22.04/24.04 y conexión a internet.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"
JOBS="$(nproc 2>/dev/null || echo 2)"

USAR_PM2="${USAR_PM2:-1}"
APLICAR_FIREWALL="${APLICAR_FIREWALL:-1}"
INSTALAR_OLLAMA="${INSTALAR_OLLAMA:-0}"
CF_FIREWALL_AUTO="${CF_FIREWALL_AUTO:-0}"
DOMINIO="${DOMINIO:-miiaia.com}"

c_tit() { printf '\n\033[1;36m══ %s\033[0m\n' "$*"; }
c_ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }
c_wrn() { printf '   \033[33m⚠\033[0m %s\n' "$*"; }
c_err() { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

echo "════════════════════════════════════════════════════════════"
echo "   MIIA · Deploy completo en Ubuntu"
echo "   Proyecto: $ROOT_DIR"
echo "   pm2=$USAR_PM2  firewall=$APLICAR_FIREWALL  ollama=$INSTALAR_OLLAMA"
echo "════════════════════════════════════════════════════════════"

# ── Preflight: root/sudo + SO ───────────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null || c_err "Necesitás sudo o correr como root"
  SUDO="sudo"
fi
grep -qiE "ubuntu|debian" /etc/os-release 2>/dev/null || c_wrn "Pensado para Ubuntu/Debian. Sigo igual…"
export DEBIAN_FRONTEND=noninteractive

# ── 0. Preflight: ¿estoy desplegando la ÚLTIMA versión del código? ───────────
c_tit "0/12 · Verificación del código a desplegar"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  c_ok "Rama: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)  ·  commit: $(git rev-parse --short HEAD 2>/dev/null)"
  [ -n "$(git status --porcelain 2>/dev/null)" ] && c_wrn "Hay cambios SIN commitear — se despliegan tal cual están en disco"
else
  c_wrn "No es un checkout de git: despliego los archivos tal cual están en disco"
fi
# class25B importa ./llm_local.js y ./glosario.js (ESM). Si importa uno que NO
# está en disco, muere con ERR_MODULE_NOT_FOUND y el orquestador la respawnea en
# bucle (CLASS25B está en CRITICAL_LABELS). Es la lección del 28-sep: diffear antes.
if [ -f scripts/class25B.js ]; then
  for dep in llm_local glosario; do
    if grep -q "\"\./$dep\.js\"" scripts/class25B.js && [ ! -f "scripts/$dep.js" ]; then
      c_err "class25B importa ./$dep.js y NO existe en disco → arrancaría en respawn loop. Falta scripts/$dep.js (está en la rama arreglo-chat-presupuesto)."
    fi
  done
fi
FALTAN_CHAT=""
for f in scripts/class25B.js scripts/llm_local.js scripts/glosario.js MIIA/chat_contexto.py; do
  [ -f "$f" ] || FALTAN_CHAT="$FALTAN_CHAT $f"
done
if [ -n "$FALTAN_CHAT" ]; then
  c_wrn "Faltan archivos del chat local:$FALTAN_CHAT"
  c_wrn "Parece un checkout viejo (p.ej. 'main'): el chat NO tendría el motor local (Ollama)."
else
  c_ok "Chat local completo (class25B + llm_local + glosario + chat_contexto)"
fi

# ── 1. Paquetes base ────────────────────────────────────────────────────────
c_tit "1/12 · Paquetes base del sistema"
$SUDO apt-get update -y
$SUDO apt-get install -y \
  build-essential cmake git pkg-config curl wget unzip ca-certificates openssl \
  nlohmann-json3-dev libspdlog-dev
c_ok "build tools, git, curl, openssl"

# ── 2. Redis ────────────────────────────────────────────────────────────────
c_tit "2/12 · Redis"
$SUDO apt-get install -y redis-server
$SUDO systemctl enable --now redis-server
sleep 1
redis-cli ping >/dev/null 2>&1 && c_ok "Redis responde (PONG)" || c_wrn "Redis no respondió aún"

# ── 3. MySQL 8 + base + usuario + esquema ───────────────────────────────────
c_tit "3/12 · MySQL 8 + base de datos"
$SUDO apt-get install -y mysql-server
$SUDO systemctl enable --now mysql

# Credenciales del .env (si ya existe). Si no, defaults; el .env se crea en el paso 9.
ENV_FILE="operador/aprendizaje/config/.env"
getenv() { if [ -f "$ENV_FILE" ]; then grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//'; fi; return 0; }
DB_NAME="$(getenv DB_NAME)"; DB_NAME="${DB_NAME:-miia_cognitiva}"
DB_USER="$(getenv DB_USER)"; DB_USER="${DB_USER:-miia}"
DB_PASS="$(getenv DB_PASS)"

if [ -z "$DB_PASS" ]; then
  # Sin clave en el .env todavía: generamos una y la dejamos anotada para el paso 9.
  DB_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  DB_PASS_GENERADA=1
  c_wrn "No había DB_PASS en el .env → generé una: la escribo en el .env en el paso 9"
fi

$SUDO mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
c_ok "Base '$DB_NAME' y usuario '$DB_USER' listos"

# Esquema: SOLO si la base está vacía (evita el DROP TABLE del dump sobre datos vivos).
N_TABLAS="$($SUDO mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME';" 2>/dev/null || echo 0)"
if [ "${N_TABLAS:-0}" -eq 0 ] && [ -f docs/esquema_miia_cognitiva.sql ]; then
  $SUDO mysql "$DB_NAME" < docs/esquema_miia_cognitiva.sql
  c_ok "Esquema cargado (36 tablas) desde docs/esquema_miia_cognitiva.sql"
elif [ "${N_TABLAS:-0}" -gt 0 ]; then
  c_wrn "La base YA tiene $N_TABLAS tablas → NO cargo el esquema (no piso datos)"
else
  c_wrn "No encontré docs/esquema_miia_cognitiva.sql → class42 creará las 3 tablas mínimas al arrancar"
fi
[ -f operador/aprendizaje/config/reparar_permisos_mysql.sql ] && \
  $SUDO mysql < operador/aprendizaje/config/reparar_permisos_mysql.sql 2>/dev/null || true

# ── 4. Node.js 20 LTS ───────────────────────────────────────────────────────
c_tit "4/12 · Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '[0-9]+' | head -1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
c_ok "node $(node -v)  ·  npm $(npm -v)"

# ── 5. Python 3 + venv + torch + requirements ───────────────────────────────
c_tit "5/12 · Python 3 + venv"
$SUDO apt-get install -y python3 python3-pip python3-venv
[ -d MIIA/venv ] || python3 -m venv MIIA/venv
MIIA/venv/bin/pip install --upgrade pip -q
# torch CPU primero (server sin GPU → rueda liviana, ~200 MB en vez de ~2 GB)
MIIA/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu -q
MIIA/venv/bin/pip install -r MIIA/requirements.txt -q
c_ok "$(MIIA/venv/bin/python --version) + torch(CPU) + requirements"

# ── 6. .NET SDK 9 ───────────────────────────────────────────────────────────
c_tit "6/12 · .NET SDK 9 (motor vectorial C#)"
if ! command -v dotnet >/dev/null 2>&1; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
  $SUDO bash /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet
  $SUDO ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
fi
c_ok "dotnet $(dotnet --version 2>/dev/null || echo '(revisar PATH)')"

# ── 7. Dependencias del proyecto (npm) ──────────────────────────────────────
c_tit "7/12 · npm install"
npm install --no-audit --no-fund
c_ok "node_modules listo"

# ── 8. Compilar C++ (Linux) y .NET (Release) ────────────────────────────────
c_tit "8/12 · Compilando C++ (Linux) + motor .NET"
bash scripts/build_cpp_linux.sh
( cd MIIA_MotoresVectoriales && dotnet build -c Release ) \
  || c_wrn "dotnet build falló — revisá el log"
if [ ! -f MIIA_MotoresVectoriales/bin/Release/net9.0/MIIA_MotoresVectoriales.dll ]; then
  c_wrn "No quedó el .dll Release: el orquestador caería a 'dotnet run' en Debug"
else
  c_ok "MIIA_MotoresVectoriales.dll (Release)"
fi

# ── 9. .env + certificado TLS ───────────────────────────────────────────────
c_tit "9/12 · .env + certificado TLS"
if [ ! -f "$ENV_FILE" ]; then
  cp operador/aprendizaje/config/.env.example "$ENV_FILE"
  # Metemos las credenciales de base que ya usamos para crear el usuario
  sed -i "s|^DB_NAME=.*|DB_NAME=$DB_NAME|; s|^DB_USER=.*|DB_USER=$DB_USER|; s|^DB_PASS=.*|DB_PASS=$DB_PASS|" "$ENV_FILE"
  sed -i "s|^# PYTHON_BIN=.*|PYTHON_BIN=$ROOT_DIR/MIIA/venv/bin/python|" "$ENV_FILE"
  FALTA_ENV=1
  c_wrn "Creé $ENV_FILE desde la plantilla. FALTAN los secretos (JWT, APIs, Gemini, OAuth)."
else
  # El .env ya existía: si generamos una DB_PASS nueva, la sincronizamos
  if [ "${DB_PASS_GENERADA:-0}" = "1" ]; then
    grep -qE "^DB_PASS=" "$ENV_FILE" && sed -i "s|^DB_PASS=.*|DB_PASS=$DB_PASS|" "$ENV_FILE" || echo "DB_PASS=$DB_PASS" >> "$ENV_FILE"
  fi
  c_ok ".env ya existe — lo respeto"
fi

# JWT_SECRET: si está vacío, lo generamos (el proceso no arranca sin ≥32 chars)
if [ -f "$ENV_FILE" ] && [ -z "$(getenv JWT_SECRET)" ]; then
  JWT="$(openssl rand -hex 32)"
  grep -qE "^JWT_SECRET=" "$ENV_FILE" && sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT|" "$ENV_FILE" || echo "JWT_SECRET=$JWT" >> "$ENV_FILE"
  c_ok "JWT_SECRET generado (64 hex)"
fi

# Certificado del origen. Cloudflare hace el TLS público; el origen puede ir con
# un self-signed (lo mejor sería un Cloudflare Origin Certificate, ver DEPLOY.md).
CERT_DIR="scripts/certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/pen.key" ] || [ ! -f "$CERT_DIR/certen.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERT_DIR/pen.key" -out "$CERT_DIR/certen.pem" \
    -subj "/CN=$DOMINIO" \
    -addext "subjectAltName=DNS:$DOMINIO,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/pen.key"
  c_ok "Certificado self-signed generado (CN=$DOMINIO, 10 años)"
else
  c_ok "Certificado ya existe en $CERT_DIR"
fi

# ── 10. Build de la web ─────────────────────────────────────────────────────
c_tit "10/12 · Build de la web (publi_src → publi)"
if [ -f scripts/build_publi.js ]; then
  node scripts/build_publi.js && c_ok "publi/ empaquetado" || c_wrn "build_publi falló"
else
  c_wrn "No encontré scripts/build_publi.js"
fi

# ── 11. pm2 ─────────────────────────────────────────────────────────────────
if [ "$USAR_PM2" = "1" ]; then
  c_tit "11/12 · pm2 (arranque + boot)"
  command -v pm2 >/dev/null 2>&1 || $SUDO npm install -g pm2
  # El orquestador ES el único proceso pm2: él spawnea los ~38 restantes.
  if pm2 describe miia >/dev/null 2>&1; then
    pm2 restart miia --update-env
    c_ok "pm2: 'miia' reiniciada"
  else
    pm2 start operador/index.js --name miia --time
    c_ok "pm2: 'miia' arrancada"
  fi
  pm2 save
  # Arranque al bootear. pm2 startup imprime el comando real (con env PATH=...);
  # lo ejecutamos acá. Si corre como root suele configurarlo solo.
  STARTUP_CMD="$(pm2 startup systemd 2>/dev/null | grep -E '^(sudo )?env ' | tail -1 || true)"
  if [ -n "$STARTUP_CMD" ]; then
    eval "$STARTUP_CMD" && c_ok "pm2 arrancará al bootear" || c_wrn "corré a mano:  $STARTUP_CMD"
  else
    c_ok "pm2 startup configurado (o ya estaba)"
  fi
else
  c_tit "11/12 · pm2 — OMITIDO (USAR_PM2=0)"
  c_wrn "Arrancá a mano con:  node operador/index.js"
fi

# ── 12. Firewall (Cloudflare) ───────────────────────────────────────────────
if [ "$APLICAR_FIREWALL" = "1" ] && [ -f scripts/firewall_cloudflare.sh ]; then
  c_tit "12/12 · Firewall — 80/8443 solo desde Cloudflare"
  $SUDO apt-get install -y ufw >/dev/null 2>&1 || true
  if [ "$CF_FIREWALL_AUTO" = "1" ]; then
    $SUDO bash scripts/firewall_cloudflare.sh --aplicar
  else
    $SUDO bash scripts/firewall_cloudflare.sh     # modo --revisar (no toca nada)
    c_wrn "Firewall en modo REVISAR. Para aplicarlo:"
    echo  "        sudo bash scripts/firewall_cloudflare.sh --aplicar"
    echo  "   (en un server LIMPIO aplica bien; si ya tenía reglas abiertas 80/443/8443,"
    echo  "    primero borralas: ufw delete allow 8443 ; etc.)"
  fi
else
  c_tit "12/12 · Firewall — OMITIDO"
fi

# ── Resumen final ───────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "   ✅ MIIA instalada."
echo "════════════════════════════════════════════════════════════"
if [ "${FALTA_ENV:-0}" = "1" ]; then
  echo "   ⚠  FALTA completar los secretos en:"
  echo "        $ENV_FILE"
  echo "      (JWT ya se generó; faltan FINNHUB_KEY, GEMINI_API_KEY, GOOGLE_*, MP_*, etc.)"
  echo "      Después:  pm2 restart miia --update-env   (o  node operador/index.js)"
  echo ""
fi
echo "   Verificar:"
echo "     pm2 status                 # 'miia' en 'online'"
echo "     pm2 logs miia --lines 60   # el arranque de los ~38 procesos"
echo "     bash scripts/miia_check.sh # diagnóstico completo"
echo ""
echo "   Web: Cloudflare (443) → origen 8443. Apuntá el DNS de $DOMINIO"
echo "        a la IP del server con el proxy (nube naranja) ENCENDIDO."
echo "════════════════════════════════════════════════════════════"
