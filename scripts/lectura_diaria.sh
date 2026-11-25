#!/usr/bin/env bash
# lectura_diaria.sh — el chequeo de MIIA, solo, todos los días de rueda.
#
# Corre /root/miia_check.sh --dur 300 a las 15:30 de Nueva York (media hora antes
# del cierre del NYSE, con el mercado ABIERTO, que es cuando las secciones 4.x
# tienen muestra) y guarda la salida en /root/lecturas/AAAA-MM-DD.txt. Le agrega
# al final lo que veníamos pidiendo a mano en cada lectura: free -m, SwapCached,
# la cola de class30 y la línea del repaso de class23 y class24.
#
# NO ES MIIA: vive en /root/, sólo LEE (logs, Redis por 300 s, el endpoint de la
# tesis) y no toca procesos ni state/. Mismo criterio que miia_check.sh.
#
# La hora: el cron corre a los :30 de CADA hora de lunes a viernes, y el script
# sólo sigue si en Nueva York son las 15. Así no depende de la hora del server
# ni de los cambios de horario de Europa (25-oct) y de EE.UU. (1-nov), que no
# caen el mismo día. Una vez por día: si el archivo del día ya existe, no repite.
#
# Instalación (la hace Martín, una vez):
#   scp scripts/lectura_diaria.sh usuario@tu-servidor:/root/
#   ssh usuario@tu-servidor "chmod +x /root/lectura_diaria.sh && mkdir -p /root/lecturas"
#   ssh usuario@tu-servidor "(crontab -l 2>/dev/null; echo '30 * * * 1-5 /bin/bash /root/lectura_diaria.sh >> /root/lecturas/cron.log 2>&1') | crontab -"
#
# Probarlo sin esperar a las 15:30:   bash /root/lectura_diaria.sh --ahora
# Sacarlo:                            crontab -l | grep -v lectura_diaria | crontab -
set -uo pipefail

DIR=/root/lecturas
MIIA_ROOT="${MIIA_ROOT:-/opt/miia}"
LOGS="$MIIA_ROOT/operador/aprendizaje/logs"
mkdir -p "$DIR"

if [ "${1:-}" != "--ahora" ]; then
  [ "$(TZ=America/New_York date +%H)" = "15" ] || exit 0
fi

DIA="$(TZ=America/New_York date +%F)"
OUT="$DIR/$DIA.txt"
if [ -s "$OUT" ] && [ "${1:-}" != "--ahora" ]; then exit 0; fi
[ "${1:-}" = "--ahora" ] && OUT="$DIR/$DIA-$(date +%H%M).txt"

sin_color() { sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g'; }

# La última línea con un patrón, mirando también los rotados de spdlog
# (class24.1.log … .3.log), del más viejo al actual.
ultima() {   # ultima <modulo> <patron>
  local m="$1" p="$2" f files=()
  for f in "$LOGS/$m.3.log" "$LOGS/$m.2.log" "$LOGS/$m.1.log" "$LOGS/$m.log"; do
    [ -f "$f" ] && files+=("$f")
  done
  [ ${#files[@]} -gt 0 ] && grep -ah "$p" "${files[@]}" | tail -1
}

{
  bash /root/miia_check.sh --dur 300 2>&1 | sin_color

  echo
  echo "══════ EXTRA · lectura_diaria.sh ══════"
  echo "--- free -m"
  free -m
  echo "--- meminfo"
  grep -E "SwapCached|SReclaimable" /proc/meminfo
  echo "--- class30 health_check"
  grep -a health_check "$LOGS/class30.log" 2>/dev/null | tail -1
  echo "--- repaso class23"
  ultima class23 "repaso: modo="
  echo "--- repaso class24"
  ultima class24 "repaso: modo="
  echo "--- votantes class25A"
  ultima class25A "votantes:"
  echo "--- tesis (json)"
  curl -s --max-time 25 "https://miiaia.com/api/backtesting/professional" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("{}"); sys.exit(0)
claves = [k for k in d if k.startswith("rank_ic") and k != "rank_ic_serie"]
claves += ["decision_modo", "n_dec_ranking", "n_dec_banda", "n_dec_sin_marca"]
print(json.dumps({k: d.get(k) for k in claves}))
'
  echo "--- regimen OBJETIVO (desde /api/market: amplitud + riesgo)"
  # Etiqueta reproducible del dia, con los umbrales de class13 (lateral ±0.06
  # alrededor de 0.5, crisis riesgo>=75). 'breadth' = fraccion de sectores en
  # verde, que es el proxy de direccion que usa class13 (market_breadth).
  curl -s --max-time 15 "https://miiaia.com/api/market" | python3 -c '
import json, sys
try:    d = json.load(sys.stdin)
except Exception: print("sin dato"); sys.exit(0)
sec = d.get("sectores", {}) or {}
chs = [s.get("change") for s in sec.values() if isinstance(s.get("change"), (int, float))]
r   = d.get("riesgo_num") if isinstance(d.get("riesgo_num"), (int, float)) else 0
if not chs: print("sin dato de sectores"); sys.exit(0)
n = len(chs); up = sum(1 for c in chs if c >= 0); breadth = up / n; avg = sum(chs) / n
if   r >= 75 and breadth < 0.5: lab = "crisis"
elif breadth > 0.56:            lab = "alcista"
elif breadth < 0.44:            lab = "bajista"
else:                           lab = "lateral"
print(f"label={lab} breadth={breadth:.2f} ({up}/{n} verdes) cambio_medio={avg:+.3f} riesgo={r}%")
'
  echo "--- regimen CLASS13 (lo que MIIA detecta — best effort, 8 s de bus)"
  { timeout 8 redis-cli --raw psubscribe class18_ingest 2>/dev/null || true; } \
    | grep -m1 -oE '"cluster_label":"[a-z_0-9]+"' \
    || echo "sin captura (class13 no publico en la ventana; normal con mercado cerrado)"

  echo "══════ FIN ══════"
} > "$OUT" 2>&1

# Se guardan ~6 meses de lecturas; lo más viejo se borra.
ls -1t "$DIR"/20*.txt 2>/dev/null | tail -n +181 | xargs -r rm -f
echo "$(date -Is) lectura guardada en $OUT"
