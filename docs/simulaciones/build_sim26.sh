#!/usr/bin/env bash
# sim26 — ¿las redes aprenden y retienen entre regímenes? Corre las redes
# reales de class24 y class23. No es una prueba verde/rojo: imprime mediciones.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/miia-sim26"
mkdir -p "$OUT"

[ -d /c/msys64/mingw64/bin ] && export PATH="/c/msys64/mingw64/bin:$PATH"

CXXFLAGS="-std=c++17 -O2 -I$RAIZ/miia_cognitive -DMIIA_SIN_MAIN"
LIBS="-lredis++ -lhiredis -lspdlog -lfmt"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) LIBS="$LIBS -lws2_32" ;; esac

for objetivo in class24 class23; do
  extra=""
  [ "$objetivo" = "class23" ] && extra="-DTESTEAR_CLASS23"
  g++ $CXXFLAGS $extra "$AQUI/sim26_retencion.cpp" $LIBS -o "$OUT/sim26_$objetivo.exe"
  "$OUT/sim26_$objetivo.exe"
done
