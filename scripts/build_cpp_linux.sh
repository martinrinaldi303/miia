#!/usr/bin/env bash
# ============================================================
# build_cpp_linux.sh — Compila los módulos cognitivos C++ de MIIA en Linux
# ------------------------------------------------------------
# Los binarios class21.exe … class25A.exe de Windows NO corren en Linux:
# hay que RE-COMPILAR el mismo código fuente (miia_cognitive/*.cpp) con g++.
# El código C++ ya es 100% portable (C++17 estándar, sin APIs de Windows),
# así que solo hace falta instalar las dependencias y compilar.
#
# Produce (sin extensión, copiados a scripts/ por el POST_BUILD del CMake):
#   class21 class22 class23 class24 class27 class28 class29 class25A
#
# Uso:   bash scripts/build_cpp_linux.sh
# Probado en: Ubuntu 20.04 / 22.04 / 24.04 (Debian equivalente)
# ============================================================
set -euo pipefail

echo "════════════════════════════════════════════════════"
echo "   MIIA · Build de módulos C++ (Linux)"
echo "════════════════════════════════════════════════════"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COG_DIR="$ROOT_DIR/miia_cognitive"
BUILD_DIR="$COG_DIR/build-linux"
JOBS="$(nproc 2>/dev/null || echo 2)"

# ── 1. Dependencias del sistema (apt) ───────────────────────
# spdlog y nlohmann-json vienen con su paquete CMake CONFIG en apt.
# hiredis y redis-plus-plus los compilamos de fuente (garantiza el
# find_package(... CONFIG) en cualquier versión de Ubuntu).
echo "▶ [1/4] Instalando dependencias base (apt)…"
sudo apt-get update -y
sudo apt-get install -y \
  build-essential cmake git pkg-config \
  nlohmann-json3-dev libspdlog-dev

# ── 2. hiredis (de fuente → asegura el paquete CMake CONFIG) ─
if [ ! -f /usr/local/lib/cmake/hiredis/hiredis-config.cmake ] && \
   [ ! -f /usr/lib/x86_64-linux-gnu/cmake/hiredis/hiredis-config.cmake ]; then
  echo "▶ [2/4] Compilando hiredis desde fuente…"
  TMP_H="$(mktemp -d)"
  git clone --depth 1 --branch v1.2.0 https://github.com/redis/hiredis.git "$TMP_H/hiredis"
  cmake -S "$TMP_H/hiredis" -B "$TMP_H/hiredis/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$TMP_H/hiredis/build" -j"$JOBS"
  sudo cmake --install "$TMP_H/hiredis/build"
  sudo ldconfig
  rm -rf "$TMP_H"
else
  echo "▶ [2/4] hiredis ya instalado — omitiendo."
fi

# ── 3. redis-plus-plus (no está en apt → de fuente) ─────────
if [ ! -f /usr/local/lib/libredis++.a ] && [ ! -f /usr/lib/libredis++.a ]; then
  echo "▶ [3/4] Compilando redis-plus-plus desde fuente…"
  TMP_R="$(mktemp -d)"
  git clone --depth 1 https://github.com/sewenew/redis-plus-plus.git "$TMP_R/redis-plus-plus"
  cmake -S "$TMP_R/redis-plus-plus" -B "$TMP_R/redis-plus-plus/build" \
    -DREDIS_PLUS_PLUS_BUILD_TEST=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build "$TMP_R/redis-plus-plus/build" -j"$JOBS"
  sudo cmake --install "$TMP_R/redis-plus-plus/build"
  sudo ldconfig
  rm -rf "$TMP_R"
else
  echo "▶ [3/4] redis-plus-plus ya instalado — omitiendo."
fi

# ── 4. Compilar los módulos MIIA ────────────────────────────
# El CMakeLists copia cada binario a ../scripts/ con un POST_BUILD.
echo "▶ [4/4] Compilando miia_cognitive…"
cmake -S "$COG_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" -j"$JOBS"

echo "════════════════════════════════════════════════════"
echo "   ✅ Binarios Linux generados en: $ROOT_DIR/scripts/"
for m in class21 class22 class23 class24 class27 class28 class29 class25A; do
  if [ -x "$ROOT_DIR/scripts/$m" ]; then
    echo "      ✓ $m"
  else
    echo "      ✗ $m  (NO generado — revisá el log de arriba)"
  fi
done
echo "════════════════════════════════════════════════════"
echo "   Ahora podés arrancar todo con:  node operador/index.js"
echo "════════════════════════════════════════════════════"
