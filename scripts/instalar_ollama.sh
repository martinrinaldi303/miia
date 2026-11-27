#!/usr/bin/env bash
# ============================================================================
# instalar_ollama.sh — instala y afina el motor de lenguaje LOCAL en el server
# ----------------------------------------------------------------------------
# Se copia al server y se corre ALLÁ (es lo único de MIIA que no se maneja
# desde la PC, porque instala un paquete del sistema):
#
#     scp scripts/instalar_ollama.sh root@TU_SERVER:/root/
#     ssh root@TU_SERVER "bash /root/instalar_ollama.sh --revisar"   # sólo mira
#     ssh root@TU_SERVER "bash /root/instalar_ollama.sh"             # instala
#
#   --revisar    sólo el preflight: RAM, disco, puerto, systemd, Node. No toca nada.
#   --solo-afinar   salta la instalación y re-aplica las variables de systemd.
#   --quitar     para y deshabilita Ollama (no borra el modelo ni el binario).
#
# NO TOCA MIIA. No reinicia ningún módulo, no escribe en /opt/miia, no entra a
# la base. Ollama queda como un servicio aparte en 127.0.0.1:11434 y MIIA le
# habla por HTTP; si Ollama no está, class25B cae a Gemini y después al
# redactor interno (ver el router MIIA_LLM en class25B).
#
# ⚠️ LA DESCARGA LA CORRÉS VOS, A PROPÓSITO. El paso 2 ejecuta el instalador
# oficial de Ollama, que es un script remoto corriendo como root. No lo hago
# por mi cuenta: el script pide SI antes, y la alternativa auditable (bajar el
# tarball, verificar el sha256 contra el publicado y extraerlo a mano) está
# escrita en el paso 2. Elegí la que te deje tranquilo.
# ============================================================================
set -uo pipefail

MODELO="${MIIA_LLM_MODELO:-gemma3:1b}"
RAM_MIN_MB=3000           # gemma3:1b pide ~1,2 GB (gemma2:2b ~2,1); esto deja margen
DISCO_MIN_MB=4000

ok()   { printf '   \033[32m[OK]\033[0m    %s\n' "$*"; }
avis() { printf '   \033[33m[MIRAR]\033[0m %s\n' "$*"; }
mal()  { printf '   \033[31m[MAL]\033[0m   %s\n' "$*"; }
inf()  { printf '           %s\n' "$*"; }
tit()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

MODO="${1:-instalar}"

# ── quitar ─────────────────────────────────────────────────────────────────
if [[ $MODO == --quitar ]]; then
  tit "Apagando Ollama (el binario y el modelo quedan)"
  systemctl stop ollama 2>/dev/null && ok "parado"
  systemctl disable ollama 2>/dev/null && ok "deshabilitado (no arranca con el server)"
  inf "MIIA sigue andando: class25B cae a Gemini y despues al redactor interno."
  inf "Para volver: systemctl enable --now ollama"
  exit 0
fi

# ── 1 · Preflight ──────────────────────────────────────────────────────────
tit "1 . Preflight (sólo lectura)"
listo=1

if [[ $(id -u) -ne 0 ]]; then mal "hay que correrlo como root"; exit 1; fi
command -v systemctl >/dev/null && ok "systemd presente" || { mal "sin systemd"; exit 1; }

disp=$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)
tot=$(awk '/^MemTotal:/{printf "%d", $2/1024}' /proc/meminfo)
swap_u=$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{printf "%d", (t-f)/1024}' /proc/meminfo)
inf "RAM: total ${tot} MB · disponible ${disp} MB · swap usado ${swap_u} MB"
if (( disp >= RAM_MIN_MB )); then
  ok "hay margen para el modelo (~2,1 GB de pico, ${disp} MB libres)"
else
  mal "sólo ${disp} MB disponibles y el modelo pide ~2,1 GB de pico"
  inf "Con KEEP_ALIVE=5m el costo en reposo es CERO, pero durante el chat sube."
  inf "Si querés igual, bajá a un modelo más chico: MIIA_LLM_MODELO=llama3.2:1b"
  listo=0
fi
(( swap_u > 2500 )) && avis "el swap ya tiene ${swap_u} MB: mirá que no esté moviéndose (vmstat 1 5)"

libre=$(df -Pm / | awk 'NR==2{print $4}')
inf "disco libre en /: ${libre} MB"
(( libre >= DISCO_MIN_MB )) && ok "alcanza para el binario y el modelo" \
  || { mal "hacen falta ~${DISCO_MIN_MB} MB"; listo=0; }

if ss -ltn 2>/dev/null | grep -q ':11434'; then
  avis "el puerto 11434 YA está escuchando — Ollama probablemente está instalado"
else
  ok "el puerto 11434 está libre"
fi

nv=$(node -v 2>/dev/null || echo "ninguno")
inf "Node del sistema: $nv"
inf "(class25B habla con Ollama por node:http, así que la versión no importa)"

# El cupo de Finnhub NO se toca: Ollama no sale a internet para responder.
ok "esto no gasta cuota de ningún proveedor: el modelo corre acá"

if [[ $MODO == --revisar ]]; then
  printf '\n   %s\n\n' "$( (( listo )) && echo 'Preflight en verde: se puede instalar.' \
                                      || echo 'Preflight con reparos: leé los [MAL] de arriba.' )"
  exit $(( listo ? 0 : 1 ))
fi
(( listo )) || { mal "preflight con reparos — no sigo. Corré --revisar y resolvé."; exit 1; }

# ── 2 · Instalar ───────────────────────────────────────────────────────────
tit "2 . Instalar Ollama"
if command -v ollama >/dev/null; then
  ok "ya está instalado: $(ollama -v 2>&1 | head -1)"
elif [[ $MODO == --solo-afinar ]]; then
  mal "no está instalado y pediste --solo-afinar"; exit 1
else
  cat <<'AVISO'
   El instalador oficial es un script remoto que corre como root:

       curl -fsSL https://ollama.com/install.sh | sh

   La alternativa AUDITABLE, si preferís mirarlo antes:

       curl -fsSL https://ollama.com/install.sh -o /root/ollama-install.sh
       less /root/ollama-install.sh          # leerlo
       sh /root/ollama-install.sh

AVISO
  printf '   Escribí SI para correr el instalador oficial ahora: '
  read -r r
  # Acepta si/Si/SI/s — pedir mayúsculas exactas sólo sirve para cancelar por tipeo.
  case "${r^^}" in
    SI|S) : ;;
    *)    inf "cancelado (escribiste «${r:-nada}»). Nada se instaló."
          inf "Para instalar, volvé a correrlo y contestá: SI"
          exit 0 ;;
  esac
  curl -fsSL https://ollama.com/install.sh | sh || { mal "la instalación falló"; exit 1; }
  command -v ollama >/dev/null || { mal "ollama no quedó en el PATH"; exit 1; }
  ok "instalado: $(ollama -v 2>&1 | head -1)"
fi

# ── 3 · Afinar: las variables que deciden el consumo ───────────────────────
tit "3 . Afinar el consumo (override de systemd)"
D=/etc/systemd/system/ollama.service.d
mkdir -p "$D"
cat > "$D/miia.conf" <<'CONF'
# Puesto por scripts/instalar_ollama.sh de MIIA. Para volver atrás: borrar este
# archivo y `systemctl daemon-reload && systemctl restart ollama`.
[Service]
# SEGURIDAD: sólo loopback. El server tiene 8443 abierto y Cloudflare se puede
# saltear por IP, así que un Ollama en 0.0.0.0 seria un LLM abierto a internet.
Environment="OLLAMA_HOST=127.0.0.1:11434"

# LA decision de consumo: el modelo se descarga de RAM a los 5 min sin pedidos.
# En reposo el costo es CERO y solo durante el chat sube ~2 GB. Con "-1" quedaria
# residente para siempre, que en este server no sobra.
Environment="OLLAMA_KEEP_ALIVE=5m"

# Cada slot paralelo reserva su PROPIO KV cache: con el default la RAM se
# multiplica por 4 sin que nadie lo pida. El chat de MIIA es de a un mensaje.
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_MAX_QUEUE=8"
CONF
# CPU: SIN tope. Se probó CPUQuota=500% (reservar 1 núcleo) y la medición real
# del 15-oct lo desaconsejó: con 5 núcleos el 2B bajó a 5,2 tok/s, y a esa
# velocidad el chat se va a ~26 s, por encima de los 22 s de timeout del Python
# → chat mudo. El pico de 100 % que el tope evitaba es esporádico (~15 s por
# respuesta, con el server normalmente en load 0,2-1,3) e inocuo para la
# medición. Conclusión: mejor el chat rápido a 6 núcleos que un núcleo reservado.
systemctl daemon-reload
ok "override escrito en $D/miia.conf"
inf "HOST=127.0.0.1 · KEEP_ALIVE=5m · NUM_PARALLEL=1 · MAX_LOADED=1 · CPU sin tope (ver nota)"

systemctl enable ollama >/dev/null 2>&1
systemctl restart ollama
sleep 3
systemctl is-active --quiet ollama && ok "el servicio está activo" || { mal "no arrancó"; journalctl -u ollama -n 20 --no-pager | sed 's/^/        /'; exit 1; }

if ss -ltn | grep -q '127.0.0.1:11434'; then
  ok "escucha SÓLO en 127.0.0.1:11434"
elif ss -ltn | grep -q ':11434'; then
  mal "escucha en algo que no es loopback — revisá el override:"
  ss -ltn | grep 11434 | sed 's/^/        /'
else
  mal "nadie escucha en 11434"; exit 1
fi

# ── 4 · El modelo ──────────────────────────────────────────────────────────
tit "4 . El modelo: $MODELO"
if ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$MODELO"; then
  ok "ya está bajado"
else
  inf "bajando (1-2 GB, tarda unos minutos)…"
  ollama pull "$MODELO" || { mal "no se pudo bajar $MODELO"; exit 1; }
  ok "bajado"
fi
ollama list | sed 's/^/        /'

# ── 5 · Prueba real, con números ───────────────────────────────────────────
tit "5 . Prueba real (mide lo que le va a costar al chat)"
antes=$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)
t0=$(date +%s%3N)
RESP=$(curl -s --max-time 120 http://127.0.0.1:11434/api/generate -d "$(cat <<JSON
{"model":"$MODELO",
 "prompt":"En dos oraciones y en castellano rioplatense: que significa que un ETF sectorial le gane al promedio de su universo?",
 "stream":false,"keep_alive":"5m","options":{"num_predict":120,"num_ctx":2048,"temperature":0.7}}
JSON
)")
t1=$(date +%s%3N)
durante=$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo)

txt=$(printf '%s' "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("response","").strip())' 2>/dev/null)
tk=$(printf '%s' "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("eval_count",0))' 2>/dev/null)
ns=$(printf '%s' "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("eval_duration",0))' 2>/dev/null)

if [[ -z ${txt:-} ]]; then
  mal "no contestó. Respuesta cruda:"; printf '%s\n' "${RESP:0:400}" | sed 's/^/        /'; exit 1
fi
ok "contestó ${#txt} caracteres"
inf "«$(printf '%s' "$txt" | head -c 220)…»"
inf "latencia de pared: $(( t1 - t0 )) ms   (incluye cargar el modelo del disco)"
[[ ${ns:-0} -gt 0 ]] && inf "velocidad real: $(awk -v t="$tk" -v n="$ns" 'BEGIN{printf "%.1f", t/(n/1e9)}') tok/s sobre $tk tokens"
inf "RAM disponible: ${antes} MB antes → ${durante} MB con el modelo cargado"
inf "            o sea que el modelo ocupa ~$(( antes - durante )) MB mientras está vivo"

tit "Listo"
inf "Ollama corre aparte de MIIA y MIIA todavía NO lo usa."
inf "Para que lo use: bash scripts/deploy_llm_local.sh  (desde la PC)"
inf "Para ver si el modelo está cargado ahora: ollama ps"
echo
