#!/usr/bin/env bash
# sim27 — guarda de regresión de la ventana lenta del normalizador y la tasa de class24.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim27"
mkdir -p "$OUT"

[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

g++ -std=c++17 -O1 -I"$RAIZ/miia_cognitive" -DMIIA_SIN_MAIN \
    -finput-charset=UTF-8 -fexec-charset=UTF-8 \
    "$AQUI/sim27_norm_tasa.cpp" $LIBS -o "$OUT/sim27.exe"
"$OUT/sim27.exe"
