#!/usr/bin/env bash
# Compila y corre sim23_class21.cpp.
#
# Incluye class21.cpp DE PRODUCCIÓN con -DMIIA_SIN_MAIN: la prueba ejercita
# `coherencia_dominio` y `armarSalida21` tal como corren en el server, no una
# copia. Si alguien vuelve a poner la coherencia en castellano-sin-tildes, o
# hace que class21 se calle cuando no pasa su umbral, esto se pone en rojo.
#
#   bash docs/simulaciones/build_sim23.sh
#
# En Windows necesita MSYS2/MinGW64 (g++ + hiredis + redis-plus-plus). En Linux
# sale de scripts/build_cpp_linux.sh. Los binarios quedan fuera del repo.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim23"
mkdir -p "$OUT"

# MinGW en Windows; en Linux ya está en el PATH.
[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

# -finput-charset/-fexec-charset explícitos: el archivo tiene titulares en
# castellano con tildes, en cirílico y en chino, y son EL punto de la prueba.
# Sin esto, MSYS2 puede leerlos con la codepage del sistema y el pliegue de
# acentos se probaría contra bytes que no son los que llegan en producción.
CXXFLAGS="-std=c++17 -O1 -I$RAIZ/miia_cognitive -DMIIA_SIN_MAIN"
CXXFLAGS="$CXXFLAGS -finput-charset=UTF-8 -fexec-charset=UTF-8"
# spdlog en MSYS2 viene con SPDLOG_FMT_EXTERNAL, así que hace falta -lfmt.
LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

echo "── compilando sim23 (class21 real) ──"
g++ $CXXFLAGS "$AQUI/sim23_class21.cpp" $LIBS -o "$OUT/sim23.exe"
"$OUT/sim23.exe"
