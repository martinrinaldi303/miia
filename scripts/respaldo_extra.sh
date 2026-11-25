#!/usr/bin/env bash
# ============================================================================
# respaldo_extra.sh — un respaldo MAS, antes del corte, por las dudas
# ----------------------------------------------------------------------------
#     & "C:\Program Files\Git\bin\bash.exe" scripts/respaldo_extra.sh
#
# El corte ya arma el suyo (paso 3/10, con MIIA detenida) y alcanza para
# volver atras. Este es independiente, se hace AHORA con MIIA andando, y
# cubre el caso que el otro no cubre: que falle el propio paso 3/10.
#
# Mismo alcance que el precorte del corte: codigo, binarios C++, build .NET,
# config (el .env) y state (los pesos). NO copia node_modules, backups/,
# logs/ ni snapshots/ — son ~11 GB que no hacen falta para restaurar.
#
#   --ver     lista que hay DENTRO del ultimo respaldo manual, por path.
#             Un tar que se lee entero no prueba que adentro este lo que hace
#             falta: esto lo cuenta.
#   --bajar   ademas trae el config a la PC (es chico y tiene el .env, que es
#             lo unico irreemplazable que NO quedo en el escritorio)
#
# OJO: el .env tiene las credenciales de la base y de los proveedores.
# Queda en el escritorio y NUNCA va a git.
# ============================================================================
set -uo pipefail

HOST="${MIIA_HOST:-usuario@tu-servidor}"
BAJAR=0; VER=0
[[ ${1:-} == --bajar ]] && BAJAR=1
[[ ${1:-} == --ver ]] && VER=1
SELLO=$(date -u -d '-3 hours' +%Y%m%d-%H%M)       # hora de Argentina
LOCAL="$HOME/Desktop/corte_$(date -u -d '-3 hours' +%F)"

printf '\n\033[1m━━ Respaldo extra de MIIA, con el sistema andando\033[0m\n'
echo "   No detiene nada. Te pide la clave una vez."
echo

if (( VER )); then
  ssh -o ServerAliveInterval=30 "$HOST" 'bash -s' <<'VERREMOTO'
f=$(ls -t /root/miia-respaldo-manual-*.tar.gz 2>/dev/null | head -1)
[[ -n $f ]] || { echo "   no hay ningun respaldo manual"; exit 1; }
echo "   $f  ($(du -h "$f" | cut -f1))"
echo
t=$(mktemp); tar tzf "$f" > "$t" 2>/dev/null || { echo "   el tar no se lee"; exit 1; }
printf '   %-42s %s
' "QUE" "ENTRADAS"
for p in operador/aprendizaje/state/ operador/aprendizaje/config/          MIIA_MotoresVectoriales/bin/Release/ miia_cognitive/ MIIA/ scripts/; do
  printf '   %-42s %s
' "$p" "$(grep -c "^$p" "$t")"
done
echo
echo "   lo que no puede faltar:"
for p in operador/aprendizaje/config/.env          operador/aprendizaje/state/class25a_pesos.json          operador/aprendizaje/state/class23_pesos.json          operador/aprendizaje/state/class24_pesos.json          operador/aprendizaje/state/class25a_neutro.json          operador/index.js scripts/class25A scripts/class23 scripts/class24; do
  if grep -qx "$p" "$t"; then printf '   OK   %s
' "$p"
  else                        printf '   FALTA %s
' "$p"; fi
done
rm -f "$t"
VERREMOTO
  rc=$?; echo; exit $rc
fi

ssh -o ServerAliveInterval=30 "$HOST" SELLO="$SELLO" 'bash -s' <<'REMOTO'
set -uo pipefail
R=/opt/miia
A=$R/operador/aprendizaje
DEST=/root/miia-respaldo-manual-$SELLO.tar.gz
L=$(mktemp)

ok()   { printf '   \342\234\205 %s\n' "$*"; }
mal()  { printf '   \342\235\214 %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }

[[ -d $R ]] || { mal "no existe $R"; exit 1; }

# Mismo alcance que precorte.lst del corte.
for f in operador/aprendizaje/config operador/aprendizaje/state \
         MIIA_MotoresVectoriales/bin/Release operador/index.js \
         scripts miia_cognitive MIIA/class44.py MIIA/miia_chatbot.py \
         MIIA/app.py MIIA/rank_ic.py MIIA/universo.py; do
  [[ -e $R/$f ]] && echo "$f" >> "$L"
done
# scripts/ arrastra publi/ (la web empaquetada): chica, se deja.

libre=$(df -Pm /root | awk 'NR == 2 { print $4 }')
(( libre > 3000 )) || { mal "quedan $libre MB libres"; exit 1; }

t=$SECONDS
tar czf "$DEST" -C "$R" --exclude='node_modules' --exclude='*.log' \
    --exclude='snapshots' --exclude='json_guardados' -T "$L" 2>/dev/null
rc=$?
rm -f "$L"
(( rc == 0 )) || { mal "tar devolvio $rc"; rm -f "$DEST"; exit 1; }
tar tzf "$DEST" > /dev/null 2>&1 || { mal "el tar no se puede leer"; rm -f "$DEST"; exit 1; }

ok "$DEST"
info "$(du -h "$DEST" | cut -f1), $(tar tzf "$DEST" | wc -l) entradas, en $((SECONDS - t)) s"
info "verificado: el tar se lee entero"
echo
info "para restaurar a mano:  tar xzf $DEST -C /opt/miia"
REMOTO

rc=$?
if (( rc != 0 )); then
  echo
  echo "   No se armo el respaldo (codigo $rc). El server no se toco."
  exit $rc
fi

if (( BAJAR )); then
  echo
  printf '\033[1m━━ Traer el config a la PC (chico, tiene el .env)\033[0m\n'
  mkdir -p "$LOCAL/config_server"
  if scp -o ServerAliveInterval=30 -r "$HOST:/opt/miia/operador/aprendizaje/config" "$LOCAL/config_server/" 2>&1; then
    echo "   ✅ en $LOCAL/config_server/"
    echo "   ⚠️  tiene el .env con las credenciales: NUNCA a git."
  else
    echo "   ⚠️  no se pudo bajar; el respaldo del server quedo igual."
  fi
fi

echo
echo "   El corte igual va a armar el suyo a las 18:00, con MIIA detenida."
echo
