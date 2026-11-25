#!/usr/bin/env bash
# traer_lecturas.sh — baja del server las lecturas diarias y las carga en la planilla.
#
#   bash docs/planilla/traer_lecturas.sh
#
# 1. Copia /root/lecturas/*.txt del server a C:\Users\martin\Desktop\lecturas_miia\
#    (pide la contraseña del server una vez, como cualquier scp).
# 2. Las convierte con leer_chequeo.py y las carga con actualizar_planilla.py,
#    haciendo antes el respaldo del día de la planilla.
#
# Se puede correr las veces que se quiera: una fila con la misma fecha y hora que
# otra ya cargada se ignora. El Excel tiene que estar CERRADO.
#
# Las notas que quedan son automáticas (sólo números). La lectura con criterio
# se sigue haciendo aparte y se escribe en la nota a mano o desde el asistente.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="${MIIA_SERVER:-root@TU_SERVER}"
DEST="/c/Users/martin/Desktop/lecturas_miia"
mkdir -p "$DEST"

echo "bajando lecturas de $SERVER ..."
scp -q "$SERVER:/root/lecturas/20*.txt" "$DEST/"

n=$(ls -1 "$DEST"/20*.txt 2>/dev/null | wc -l)
echo "$n lecturas en $DEST"
[ "$n" -gt 0 ] || exit 0

PYTHONIOENCODING=utf-8 python "$AQUI/leer_chequeo.py" --cargar "$DEST"/20*.txt
