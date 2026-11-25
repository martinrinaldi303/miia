#!/usr/bin/env bash
# Compila y corre sim9_ranking.cpp contra class25A.
#
# Incluye el .cpp DE PRODUCCIÓN con -DMIIA_SIN_MAIN: ejercita `ubicarEnSeccion`
# y `confianzaPorPuesto` tal cual corren en el server, no una copia.
#
#   bash docs/simulaciones/build_sim9.sh
#
# En Windows necesita MSYS2/MinGW64; en Linux sale de scripts/build_cpp_linux.sh.
# spdlog viene con SPDLOG_FMT_EXTERNAL, así que hace falta -lfmt.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim9"
mkdir -p "$OUT"

[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

CXXFLAGS="-std=c++17 -O1 -I$RAIZ/miia_cognitive -DMIIA_SIN_MAIN"
LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

echo "── compilando sim9 contra class25A ──"
g++ $CXXFLAGS "$AQUI/sim9_ranking.cpp" $LIBS -o "$OUT/sim9.exe"
"$OUT/sim9.exe"
