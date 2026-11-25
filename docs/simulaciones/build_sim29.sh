#!/usr/bin/env bash
# sim29 — el repaso de ejemplos viejos de class23 y class24, contra el código real.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim29"
mkdir -p "$OUT"

[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

CXXFLAGS="-std=c++17 -O1 -I$RAIZ/miia_cognitive -DMIIA_SIN_MAIN -finput-charset=UTF-8 -fexec-charset=UTF-8"
LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

estado=0
for objetivo in class24 class23; do
  extra=""
  [ "$objetivo" = "class23" ] && extra="-DTESTEAR_CLASS23"
  g++ $CXXFLAGS $extra "$AQUI/sim29_repaso.cpp" $LIBS -o "$OUT/sim29_$objetivo.exe"
  "$OUT/sim29_$objetivo.exe" || estado=1
done
exit $estado
