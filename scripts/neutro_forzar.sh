#!/usr/bin/env bash
# ============================================================================
# neutro_forzar.sh — fuerza el neutro de class25A sin esperar la auto-calibración
# ----------------------------------------------------------------------------
# POR QUÉ EXISTE
#   class25A loguea "⚠ banda descentrada" con neutro=0.583 y score_medio=0.611
#   (desvío +0.0275 sobre 20.500 muestras). La auto-calibración lo va a corregir
#   sola —los dos umbrales dan: 20.500 > MIN_MUESTRAS(500) y 0.0275 >
#   MIN_DESVIO(0.010)— pero recién al cumplirse g_auto_neutro_h (72 h), y con
#   amortiguación 0.50, o sea cerrando la MITAD de la brecha por ciclo.
#
#   Esto lo pone en el valor medido de una, y deja medir el efecto hoy.
#
# QUÉ CAMBIA Y QUÉ NO (no confundirlos)
#   SÍ  — el reparto BUY/SELL/HOLD. Los scores viven 0.028 por ENCIMA del
#         neutro, y por eso hay casi el doble de BUY que de SELL (3.148 vs
#         1.650). Al centrar la banda el mix se equilibra. Eso se ve en minutos.
#   NO  — la exactitud ni el edge. Eso necesita el horizonte de verificación
#         (48 h). Cualquier lectura de accuracy hoy no significa nada.
#   NO  — ticker=GENERAL, label_modo NULL, el argmax de red_dominante, ni el
#         1,2% de cobertura de verificación. El neutro es un escalar contra el
#         que se compara un score: no crea tickers ni verifica nada.
#
# MECÁNICA
#   El archivo state/class25a_neutro.json PISA a la variable de entorno
#   CLASS25A_NEUTRO (class25A.cpp:1433, "pisa el del entorno"). No hay canal
#   Redis de control en caliente, así que hay que reiniciar el proceso.
#   CLASS25A está en CRITICAL_LABELS: el orquestador lo respawnea a los 8 s y
#   los otros ~38 procesos ni se enteran.
#
# COSTO DEL REINICIO (explícito, como corresponde en plena corrida)
#   · se pierde la ventana de muestreo en memoria (g_score_sum/g_score_n) —
#     se rehace en ~1,2 h a 10.191 decisiones/día contra las 500 que pide
#   · se pierde la cola g_snaps — hoy no cuesta nada: la capa 2 de atribución
#     no corre (está detrás de un `else if` que nunca se toma)
#   · NO se pierden los pesos, ni cognitive_decisions, ni el reloj de calibración
#
#   ESTO CAMBIA EL EXPERIMENTO EN CALIENTE. Las decisiones de antes y de después
#   no son comparables. El script deja una marca fechada para poder cortar la
#   serie en el análisis. Anotala en el CSV de la tesis.
#
# Uso:
#   bash neutro_forzar.sh                    # dry-run: mide y muestra, NO toca
#   bash neutro_forzar.sh --aplicar          # aplica y reinicia
#   bash neutro_forzar.sh --aplicar --neutro 0.6106
#   bash neutro_forzar.sh --rollback <sello>
# ============================================================================
set -uo pipefail

ROOT="${MIIA_ROOT:-/opt/miia}"
STATE="$ROOT/operador/aprendizaje/state"
LOGS="$ROOT/operador/aprendizaje/logs"
NEUTRO_F="$STATE/class25a_neutro.json"
SELLO="$(date +%Y%m%d-%H%M%S)"
MARCA="$STATE/neutro_forzado_$SELLO.txt"

APLICAR=0; NEUTRO=""; VENTANA=600; ROLLBACK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --aplicar)  APLICAR=1;;
    --neutro)   NEUTRO="$2"; shift;;
    --ventana)  VENTANA="$2"; shift;;
    --rollback) ROLLBACK="$2"; shift;;
    *) echo "opción desconocida: $1" >&2; exit 1;;
  esac
  shift
done

sql() { mysql -N -B -e "$1" miia_cognitiva 2>/dev/null; }

mix() {  # reparto de señales en los últimos N segundos
  sql "SELECT senal, COUNT(*) FROM cognitive_decisions
       WHERE ts_decision > NOW() - INTERVAL $1 SECOND
       GROUP BY senal ORDER BY 2 DESC;"
}

# ── rollback ────────────────────────────────────────────────────────────────
if [ -n "$ROLLBACK" ]; then
  BK="$STATE/class25a_neutro.json.bak-$ROLLBACK"
  [ -f "$BK" ] || { echo "no existe $BK" >&2; exit 1; }
  cp "$BK" "$NEUTRO_F" && echo "restaurado desde $BK"
  echo "reiniciá class25A para que lo tome:  pkill -f '[c]lass25A'"
  exit 0
fi

echo "════════════════════════════════════════════════════════════"
echo "  neutro_forzar · $SELLO"
echo "════════════════════════════════════════════════════════════"

# ── 1. estado actual ────────────────────────────────────────────────────────
echo
echo "── neutro persistido ──"
[ -f "$NEUTRO_F" ] && cat "$NEUTRO_F" || echo "  (no existe todavía)"

echo
echo "── última lectura del log ──"
ULT="$(grep -ah 'score_medio=' "$LOGS/class25A.log" | tail -1)"
echo "  ${ULT:-sin lecturas}"

# score_medio medido, salvo que lo pasen a mano
if [ -z "$NEUTRO" ]; then
  NEUTRO="$(printf '%s' "$ULT" | grep -oE 'score_medio=[0-9.]+' | cut -d= -f2)"
fi
[ -n "$NEUTRO" ] || { echo "no pude leer score_medio del log — pasalo con --neutro" >&2; exit 1; }

# El cargador valida [0.20, 0.90]; fuera de rango el archivo se ignora entero
# y quedaría el default silenciosamente.
FUERA="$(awk -v v="$NEUTRO" 'BEGIN{print (v<0.20||v>0.90)?1:0}')"
[ "$FUERA" = "0" ] || { echo "neutro $NEUTRO fuera de [0.20,0.90] — se ignoraría" >&2; exit 1; }

echo
echo "── objetivo ──"
echo "  neutro nuevo : $NEUTRO"

# ── 2. baseline ANTES ───────────────────────────────────────────────────────
echo
echo "── reparto de señales, últimos ${VENTANA}s (ANTES) ──"
ANTES="$(mix "$VENTANA")"
echo "${ANTES:-  sin decisiones en la ventana}" | sed 's/^/  /'

if [ "$APLICAR" != "1" ]; then
  echo
  echo "[dry-run] no se tocó nada. Para aplicar:  bash $0 --aplicar"
  exit 0
fi

# ── 3. respaldo y escritura ─────────────────────────────────────────────────
echo
echo "── aplicando ──"
[ -f "$NEUTRO_F" ] && cp "$NEUTRO_F" "$NEUTRO_F.bak-$SELLO" && echo "  respaldo: $NEUTRO_F.bak-$SELLO"

# ts_epoch 48 h atrás: el cargador acredita el tiempo transcurrido, así que la
# auto-calibración vuelve a evaluar en ~24 h en vez de 72. Es la red de
# seguridad — si este valor forzado está mal, el sistema lo corrige solo antes.
TS48="$(( $(date +%s) - 48*3600 ))"
cat > "$NEUTRO_F" <<JSON
{
  "neutro": $NEUTRO,
  "score_medio_ventana": $NEUTRO,
  "muestras": 0,
  "ts": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ts_epoch": $TS48,
  "_origen": "neutro_forzar.sh $SELLO — valor forzado, no auto-calibrado"
}
JSON
echo "  escrito $NEUTRO_F"

# ── 4. reinicio quirúrgico ──────────────────────────────────────────────────
# Truco del corchete: sin él, el pkill matchea su propia línea de comando.
echo
echo "── reinicio quirúrgico de class25A ──"
ANTES_PID="$(pgrep -f '[c]lass25A' | head -1)"
echo "  pid antes: ${ANTES_PID:-ninguno}"
pkill -f '[c]lass25A'
sleep 15
NUEVO_PID="$(pgrep -f '[c]lass25A' | head -1)"
echo "  pid ahora: ${NUEVO_PID:-NINGUNO}"
if [ -z "$NUEVO_PID" ]; then
  echo "  [!] class25A NO volvió. Revisá el orquestador antes de seguir." >&2
  exit 2
fi
[ "$ANTES_PID" = "$NUEVO_PID" ] && echo "  [!] mismo pid — puede no haber reiniciado" >&2

echo
echo "── qué cargó al arrancar ──"
sleep 5
grep -ah -E 'Neutro auto-calibrado|Última calibración|CLASS25A_NEUTRO' "$LOGS/class25A.log" | tail -4 | sed 's/^/  /'

# ── 5. marca del corte ──────────────────────────────────────────────────────
{
  echo "sello=$SELLO"
  echo "ts_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "neutro_forzado=$NEUTRO"
  echo "lectura_previa=$ULT"
  echo "reparto_antes<<"
  echo "$ANTES"
  echo ">>"
} > "$MARCA"
echo
echo "  marca del corte: $MARCA"
echo "  ⚠ anotala en el CSV de la tesis: la serie no es continua a través de este punto."

# ── 6. efecto inmediato ─────────────────────────────────────────────────────
echo
echo "── esperando ${VENTANA}s para medir el efecto ──"
sleep "$VENTANA"
echo
echo "── reparto de señales, últimos ${VENTANA}s (DESPUÉS) ──"
mix "$VENTANA" | sed 's/^/  /'
echo
echo "  ANTES era:"
echo "${ANTES:-  (vacío)}" | sed 's/^/  /'
echo
echo "  Se compara el MIX, no la exactitud. El edge necesita 48 h."
echo "  rollback:  bash $0 --rollback $SELLO"
