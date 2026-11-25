#!/usr/bin/env bash
# sim28 — class27 y class28 escriben en anillo: la carpeta queda acotada.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim28"
mkdir -p "$OUT"

[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

g++ -std=c++17 -O1 -I"$RAIZ/miia_cognitive" \
    -finput-charset=UTF-8 -fexec-charset=UTF-8 \
    "$AQUI/sim28_anillo.cpp" $LIBS -o "$OUT/sim28.exe"
"$OUT/sim28.exe" "$RAIZ"
