#!/usr/bin/env bash
# Compila y corre sim7_defecto10.cpp contra class23 y class24.
#
# Incluye los .cpp DE PRODUCCIÓN con -DMIIA_SIN_MAIN: la prueba ejercita la
# función que corre en el server, no una copia. Si alguien rompe el
# emparejamiento por (instrumento, hora), esto se pone en rojo.
#
#   bash docs/simulaciones/build_sim7.sh
#
# En Windows necesita MSYS2/MinGW64 (g++ + hiredis + redis-plus-plus), que es
# el mismo toolchain con el que ya se compilaba a mano. En Linux sale de
# scripts/build_cpp_linux.sh. Los binarios quedan fuera del repo.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim7"
mkdir -p "$OUT"

# MinGW en Windows; en Linux ya está en el PATH.
[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

CXXFLAGS="-std=c++17 -O1 -I$RAIZ/miia_cognitive -DMIIA_SIN_MAIN"
# spdlog en MSYS2 viene con SPDLOG_FMT_EXTERNAL, asi que hace falta -lfmt.
# Es la misma trampa que documenta las notas internas sobre fmt:: en los logs del C++.
LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
# Winsock: lo necesita hiredis en Windows.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

rc=0
for objetivo in class24 class23; do
  extra=""
  [ "$objetivo" = "class23" ] && extra="-DTESTEAR_CLASS23"
  echo "── compilando sim7 contra $objetivo ──"
  g++ $CXXFLAGS $extra "$AQUI/sim7_defecto10.cpp" $LIBS -o "$OUT/sim7_$objetivo.exe"
  "$OUT/sim7_$objetivo.exe" "$RAIZ/docs/simulaciones/datos/feedback_class43.json" || rc=1
done

exit $rc
