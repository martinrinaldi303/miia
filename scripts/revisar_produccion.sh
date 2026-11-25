#!/usr/bin/env bash
# ============================================================================
# revisar_produccion.sh — SOLO LECTURA. Busca OTROS errores, no repite el chequeo.
# ----------------------------------------------------------------------------
#     bash /c/Users/martin/Desktop/MIIA/scripts/revisar_produccion.sh
#
# miia_check.sh ya mide el bus, la tesis y el aprendizaje. Esto busca otra cosa:
# el MODO DE FALLAR que aparecio dos veces el 10-oct -- un modulo que recibe
# mensajes y los descarta TODOS en silencio, sin un solo error en el log.
# class11 con la ventana en 0 era exactamente eso, y no lo veia nadie.
#
#   --horas N   cuanto mirar hacia atras (por defecto: desde el corte)
#
# No corre nada en MIIA, no reinicia, no escribe. Una sola conexion.
# ============================================================================
set -uo pipefail

HOST="${MIIA_HOST:-usuario@tu-servidor}"
HORAS="${2:-}"
[[ ${1:-} == --horas && -n ${2:-} ]] && HORAS=$2 || HORAS=""

printf '\n\033[1m== Revision de produccion (solo lectura)\033[0m\n'
echo "   Te pide la clave una vez."
echo

ssh -o ServerAliveInterval=30 "$HOST" HORAS="$HORAS" 'bash -s' <<'REMOTO'
IDX=/opt/miia/logs/index.log
L=/opt/miia/operador/aprendizaje/logs
CORTE="2026-10-10 23:04"          # hora del server

ok()   { printf '   \033[32m[OK]\033[0m    %s\n' "$*"; }
avis() { printf '   \033[33m[MIRAR]\033[0m %s\n' "$*"; }
mal()  { printf '   \033[31m[MAL]\033[0m   %s\n' "$*"; }
inf()  { printf '           %s\n' "$*"; }
tit()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

# ── 1 · Que este todo vivo ─────────────────────────────────────────────────
tit "1 . Procesos"
n=$(pgrep -fc '[/]opt/miia' 2>/dev/null || echo 0)
g=$(pgrep -fc '[o]perador/index.js' 2>/dev/null || echo 0)
[[ $g == 1 ]] && ok "una sola generacion del orquestador" || mal "hay $g orquestadores"
inf "procesos MIIA: $n"
falta=""
for m in class1 class2 class4 class5 class6 class7 class9 class11 class13 class14 \
         class15 class17 class19 class25B class30 class31 class32 class34 class36 \
         class37 class39 class42 class43 class45 class46 class48; do
  pgrep -f "[${m:0:1}]${m:1}\.js" >/dev/null || falta="$falta $m"
done
[[ -z $falta ]] && ok "los modulos JS estan todos" || mal "NO corren:$falta"
v=0; for b in class21 class22 class23 class24 class25A class27 class28 class29; do
  ps -eo args= | grep -q "scripts/$b\$" && v=$((v+1)); done
[[ $v == 8 ]] && ok "los 8 C++ vivos" || mal "solo $v de 8 C++"

# ── 2 · EL modo de fallar del 10-oct: recibe y descarta TODO ───────────────
tit "2 . Descarte silencioso (recibe y tira todo, sin error)"
inf "class11, ventana de titulares -- fue el defecto de hoy:"
u=$(grep -a 'class1_output:' "$IDX" | tail -1)
if [[ -z $u ]]; then avis "class11 no registro ningun titular"
elif echo "$u" | grep -qE 'ventana: 0\]'; then
  mal "la ventana vuelve a estar en 0 -- el texto no llega"
  inf "$(echo "$u" | tail -c 150)"
else
  ok "la ventana se llena  ->  $(echo "$u" | grep -oE 'ventana: [0-9]+')"
fi
inf "contadores de descarte de class23/class24 (el contrato con class43):"
for k in sin_ticker no_relativo lote_truncado; do
  x=$(grep -ah "$k" "$L"/class2[34]*.log 2>/dev/null | tail -1 | grep -oE "$k=[0-9]+" | tail -1)
  [[ -n $x ]] && { if [[ ${x##*=} == 0 ]]; then ok "$x"; else avis "$x  (si crece, el contrato se rompio)"; fi; } \
               || inf "$k: sin dato todavia"
done
x=$(grep -ac 'sin match' "$L"/class2[34]*.log 2>/dev/null | paste -sd+ | bc 2>/dev/null)
inf "feedbacks 'sin match': ${x:-0}  (algunos son normales)"

# ── 3 · Errores de verdad, desde el corte ──────────────────────────────────
tit "3 . Errores en los logs desde el corte ($CORTE)"
inf "excluye los conocidos: cuota de Gemini, google_error de class1, 429"
tmp=$(mktemp)
awk -v c="$CORTE" 'index($0,c)>0{f=1} f' "$IDX" 2>/dev/null \
  | grep -aiE 'error|exception|ECONNREFUSED|ENOTFOUND|cannot find|undefined is not|unhandled' \
  | grep -aviE 'google_error|newsapi_error|finnhub_error|cuota|quota|429|error: 0|errores=0' \
  > "$tmp"
ne=$(wc -l < "$tmp")
if [[ $ne == 0 ]]; then ok "ningun error nuevo en index.log desde el corte"
else
  avis "$ne lineas con error. Por modulo:"
  grep -aoE '\[CLASS[0-9]+[A-Z]?\]' "$tmp" | sort | uniq -c | sort -rn | head -8 | sed 's/^/           /'
  inf "las 3 ultimas:"
  tail -3 "$tmp" | cut -c1-150 | sed 's/^/           /'
fi
rm -f "$tmp"

# ── 4 · Los testigos del corte: lo que TIENE que estar ─────────────────────
tit "4 . Testigos del corte"
chk() { if { grep -a "$2" "$IDX"; grep -ah "$2" "$L"/*.log 2>/dev/null; } 2>/dev/null | grep -q .; then
          ok "$1"; else mal "$1  -- NO aparece"; fi; }
chk "ranking transversal activo"      "Ranking transversal: ACTIVO"
chk "base de z con olvido (EWMA)"     "Base de z: EWMA"
chk "class10 con 22 dims"             "mercado|22"
chk "class24 con la tasa nueva"       "lr=0.0003"
chk "repaso de ejemplos viejos"       "repaso ACTIVO"
chk "auto-neutro aplicado"            "SE APLICA"
if grep -a 'Impacto por instrumento' "$IDX" | tail -1 | grep -q "$(date -d '-30 min' '+%Y-%m-%dT%H')"; then
  mal "class11 SIGUE publicando por instrumento (deberia estar apagado)"
else
  ok "class11 no publica por instrumento (apagado, como debe)"
fi

# ── 5 · Que el sistema siga produciendo ────────────────────────────────────
tit "5 . Que siga produciendo"
hb=$(grep -ah 'decisiones=' "$L"/class25A*.log 2>/dev/null | tail -1)
[[ -n $hb ]] && inf "$(echo "$hb" | grep -oE 'decisiones=[0-9]+ umbral=[0-9.]+ emision=[0-9.]+%' | tail -1)"
rec=$(grep -a 'Reconciliacion DB\|Reconciliación DB' "$IDX" | tail -1)
[[ -n $rec ]] && inf "ultima reconciliacion: $(echo "$rec" | grep -oE '[0-9]+ verificadas' | head -1)" \
              || avis "sin ciclo de reconciliacion en el log"

# ── 6 · Lo que publica y nadie escucha ─────────────────────────────────────
tit "6 . Canales huerfanos (trabajo tirado, no es rotura)"
inf "miia_check.sh los lista con --dur 300; aca solo el recordatorio"
inf "los conocidos: class10_heartbeat, class27_input, class28_ingest,"
inf "class30_output, class32_output, class34_output, class36_output, system.metrics"

printf '\n\033[1m-- Fin. Nada de esto cambio nada.\033[0m\n'
REMOTO
rc=$?
echo
(( rc == 0 )) || echo "   (la conexion devolvio $rc)"
echo
