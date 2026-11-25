#!/usr/bin/env bash
# ============================================================================
# firewall_cloudflare.sh — que el 80/8443 SOLO acepten Cloudflare
# ----------------------------------------------------------------------------
# Corre EN EL SERVER (no en tu PC). El 15-oct/29-oct se midio que el ~47% del
# trafico pega DIRECTO a la IP 203.0.113.10 esquivando Cloudflare: bots,
# scanners, pentest tools y 1.679 intentos de robar /.env. Esta regla los corta
# de un saque y, de paso, vuelve confiable el panel de Cloudflare (porque obliga
# a TODOS a pasar por el proxy).
#
# QUE HACE (con ufw)
#   - deja el SSH (puerto 22) SIEMPRE abierto -> NO te podes quedar afuera.
#   - permite 80 y 8443 SOLO desde los rangos de Cloudflare.
#   - deniega el resto del trafico entrante nuevo (los servicios internos —MySQL,
#     Redis, Python 5005, dashboard— son loopback y ufw los deja pasar solos).
#   - tu sesion SSH actual sobrevive (ufw permite ESTABLISHED).
#
# SEGURIDAD
#   - trae la lista OFICIAL de Cloudflare en vivo; si falla, usa el fallback
#     hardcodeado de abajo (rangos estables hace años).
#   - GUARDA DURA: si la lista final tiene menos de 10 rangos v4, ABORTA. Nunca
#     aplica una allow-list vacia (eso seria tirar el sitio).
#   - el SSH se permite ANTES que cualquier deny.
#
# MODOS
#   bash firewall_cloudflare.sh              (= --revisar) muestra TODO, no toca nada
#   bash firewall_cloudflare.sh --aplicar    aplica la regla
#   bash firewall_cloudflare.sh --revertir   ufw disable (vuelve a abierto)
#
# REVERTIR a mano (si algo sale mal, por SSH que sigue abierto):
#   ufw disable
# ============================================================================
set -uo pipefail

MODO="${1:---revisar}"
PUERTO_SSH="${PUERTO_SSH:-22}"

# Rangos de Cloudflare — FALLBACK por si la descarga en vivo falla. Son los
# publicados en cloudflare.com/ips-v4 y ips-v6, estables hace anios.
CF_V4_FALLBACK="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22
141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13
104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
CF_V6_FALLBACK="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32
2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

ok()  { printf '   \033[32m[OK]\033[0m %s\n' "$*"; }
mal() { printf '\n   \033[31m[MAL] %s\033[0m\n\n' "$*"; exit 1; }
tit() { printf '\n\033[1m-- %s\033[0m\n' "$*"; }
inf() { printf '        %s\n' "$*"; }

command -v ufw >/dev/null 2>&1 || mal "ufw no esta instalado. Instalalo con: apt-get install -y ufw   (y volve a correr)"

# ── Revertir ────────────────────────────────────────────────────────────────
if [[ $MODO == --revertir ]]; then
  tit "Revertir: apagar el firewall (vuelve a estar todo abierto)"
  ufw --force disable
  ok "ufw deshabilitado. El 80/8443 vuelven a aceptar a cualquiera."
  exit 0
fi

# ── Traer los rangos (en vivo, con fallback) ─────────────────────────────────
tit "1 . Rangos de Cloudflare"
V4=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4 2>/dev/null | grep -E '^[0-9]+\.' || true)
V6=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6 2>/dev/null | grep -E '^[0-9a-fA-F]*:' || true)

if [[ $(printf '%s\n' "$V4" | grep -c .) -ge 10 ]]; then
  ok "lista v4 traida EN VIVO de cloudflare.com ($(printf '%s\n' "$V4" | grep -c .) rangos)"
else
  V4=$(printf '%s' "$CF_V4_FALLBACK")
  inf "no pude traer la lista en vivo -> uso el fallback hardcodeado v4"
fi
if [[ $(printf '%s\n' "$V6" | grep -c .) -ge 3 ]]; then
  ok "lista v6 traida EN VIVO ($(printf '%s\n' "$V6" | grep -c .) rangos)"
else
  V6=$(printf '%s' "$CF_V6_FALLBACK")
  inf "v6 en vivo no disponible -> uso el fallback hardcodeado v6"
fi

N4=$(printf '%s\n' "$V4" | grep -c .)
# ⚠️ LA GUARDA QUE EVITA TIRAR EL SITIO: sin rangos no se aplica NADA.
[[ $N4 -ge 10 ]] || mal "la lista de Cloudflare quedo vacia o corta ($N4 v4). NO aplico: seria denegar a TODOS, incluido Cloudflare, y cerrar miiaia.com."
ok "lista final: $N4 rangos v4 + $(printf '%s\n' "$V6" | grep -c .) v6  (guarda OK, >=10)"
printf '%s\n' "$V4" | tr '\n' ' ' | fold -s -w 78 | sed 's/^/        /'

# ── Contexto: que hay escuchando y como esta ufw hoy ─────────────────────────
tit "2 . Estado actual del server (para revisar antes de aplicar)"
inf "puertos PUBLICOS escuchando (0.0.0.0 / [::]) — solo deberian ser 22, 80, 8443:"
ss -ltn 2>/dev/null | awk 'NR==1 || $4 ~ /0\.0\.0\.0:|\[::\]:|\*:/' | sed 's/^/        /'
inf ""
inf "ufw hoy:"
ufw status verbose 2>/dev/null | sed 's/^/        /' || inf "(ufw inactivo)"

# ── Lo que se va a hacer ─────────────────────────────────────────────────────
tit "3 . Lo que va a aplicar --aplicar"
inf "ufw allow ${PUERTO_SSH}/tcp                 # SSH SIEMPRE (no te quedas afuera)"
inf "ufw allow 22/tcp                            # por si cambiaste PUERTO_SSH, dejamos 22 igual"
inf "por cada rango CF:  ufw allow proto tcp from <rango> to any port 80,8443"
inf "ufw default deny incoming                   # el resto, denegado"
inf "ufw --force enable"
inf ""
inf "los servicios internos (MySQL 3306, Redis 6379, Python 5005, dash 3001, UI 8088)"
inf "son loopback: ufw los deja pasar solos. Tu sesion SSH actual sobrevive."

if [[ $MODO != --aplicar ]]; then
  printf '\n   \033[33m--revisar: no toque nada. Si esta todo bien, corre:  bash %s --aplicar\033[0m\n\n' "$(basename "$0")"
  exit 0
fi

# ── Aplicar ──────────────────────────────────────────────────────────────────
tit "4 . Aplicando"
# SSH PRIMERO, pase lo que pase.
ufw allow "${PUERTO_SSH}/tcp" >/dev/null && ok "SSH (${PUERTO_SSH}/tcp) permitido"
[[ $PUERTO_SSH == 22 ]] || ufw allow 22/tcp >/dev/null

# ufw permite agrupar varios puertos con 'port 80,8443'
aplicados=0
while read -r r; do
  [[ -n $r ]] || continue
  ufw allow proto tcp from "$r" to any port 80,8443 >/dev/null 2>&1 && aplicados=$((aplicados+1))
done <<< "$V4"
while read -r r; do
  [[ -n $r ]] || continue
  ufw allow proto tcp from "$r" to any port 80,8443 >/dev/null 2>&1 || true
done <<< "$V6"
ok "80/8443 permitidos desde $aplicados rangos de Cloudflare"

ufw default deny incoming >/dev/null && ok "default: deny incoming"
ufw default allow outgoing >/dev/null 2>&1
yes | ufw enable >/dev/null 2>&1 || ufw --force enable >/dev/null 2>&1
ok "ufw ACTIVO"

tit "5 . Como quedo"
ufw status numbered 2>/dev/null | sed 's/^/        /'
echo
ok "Listo. Probá que miiaia.com SIGUE abriendo (por Cloudflare)."
inf "Y que la IP directa YA NO:  curl -m 5 -k https://203.0.113.10:8443/  deberia colgar/timeout."
inf "Si algo se rompio:  ufw disable   (o:  bash $(basename "$0") --revertir)"
echo
