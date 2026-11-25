<#
================================================================================
 deploy_windows.ps1 — Deploy COMPLETO de MIIA en Windows Server
--------------------------------------------------------------------------------
 Equivalente de deploy_linux.sh para Windows Server (2019 / 2022 / 2025).
 Deja el sistema de CERO a EN LÍNEA:
   1. Chocolatey (gestor de paquetes)        7. deps npm + venv Python + torch CPU
   2. Node 20, Python 3, .NET SDK 9, Git     8. compila C++ (MinGW/MSYS2) + .NET
   3. MySQL 8  + base + usuario + ESQUEMA     9. .env + certificado TLS
   4. Redis (Memurai, drop-in para Windows)  10. build de la web (publi)
   5. OpenSSL, NSSM                          11. pm2 + arranque al bootear
   6. (opcional) Ollama local                12. Windows Firewall (solo Cloudflare)

 USO (PowerShell COMO ADMINISTRADOR, en la carpeta del proyecto):
   cd C:\miia
   powershell -ExecutionPolicy Bypass -File .\scripts\deploy_windows.ps1

 PARÁMETROS:
   -Dominio miiaia.com     CN del certificado self-signed
   -NoFirewall             no toca el Firewall de Windows
   -NoPm2                  no configura pm2 (arrancás a mano con node)
   -WithOllama             además instala el motor de lenguaje local
   -SkipCpp                saltea el build de C++ (el paso más frágil; hacelo aparte)
   -AplicarFirewall        aplica el firewall sin modo revisión

 ⚠  REALIDADES de Windows (leé DEPLOY.md):
   · Redis NO tiene build oficial de Windows → se usa Memurai (Developer edition
     es gratis para dev/test; para PRODUCCIÓN real conviene WSL2 o Memurai pago).
   · El build de C++ con MinGW es el paso más delicado (redis-plus-plus se compila
     de fuente). Si falla, el script sigue y te dice cómo terminarlo a mano.
   · La alternativa MÁS robusta en Windows es correr el stack Linux dentro de
     WSL2 y usar deploy_linux.sh. Ver DEPLOY.md.
================================================================================
#>
[CmdletBinding()]
param(
  [string]$Dominio = "miiaia.com",
  [switch]$NoFirewall,
  [switch]$NoPm2,
  [switch]$WithOllama,
  [switch]$SkipCpp,
  [switch]$AplicarFirewall
)
$ErrorActionPreference = "Stop"
$ROOT = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $ROOT

function Tit($m){ Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok ($m){ Write-Host "   OK  $m" -ForegroundColor Green }
function Wrn($m){ Write-Host "   !   $m" -ForegroundColor Yellow }
function Die($m){ Write-Host "`nX  $m" -ForegroundColor Red; exit 1 }

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   MIIA  ·  Deploy completo en Windows Server"
Write-Host "   Proyecto: $ROOT"
Write-Host "============================================================" -ForegroundColor Cyan

# ── Preflight: admin ──────────────────────────────────────────────────────────
$esAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) { Die "Tenés que correr esto en PowerShell COMO ADMINISTRADOR." }

# ── 0. Preflight: ¿estoy desplegando la ÚLTIMA versión del código? ─────────────
Tit "0/12 · Verificación del código a desplegar"
if (Get-Command git -ErrorAction SilentlyContinue) {
  $rama = (git rev-parse --abbrev-ref HEAD 2>$null)
  $sha  = (git rev-parse --short HEAD 2>$null)
  if ($rama) { Ok "Rama: $rama  ·  commit: $sha" }
  if (git status --porcelain 2>$null) { Wrn "Hay cambios SIN commitear — se despliegan tal cual están en disco" }
} else { Wrn "git no está en PATH: despliego los archivos tal cual están en disco" }
# class25B importa ./llm_local.js y ./glosario.js (ESM). Si importa uno ausente,
# muere con ERR_MODULE_NOT_FOUND y el orquestador la respawnea en bucle (28-sep).
if (Test-Path "scripts\class25B.js") {
  $c25 = Get-Content "scripts\class25B.js" -Raw
  foreach ($dep in @("llm_local","glosario")) {
    if (($c25 -match ('"\./' + $dep + '\.js"')) -and -not (Test-Path "scripts\$dep.js")) {
      Die "class25B importa ./$dep.js y NO existe -> arrancaria en respawn loop. Falta scripts\$dep.js (rama arreglo-chat-presupuesto)."
    }
  }
}
$faltanChat = @("scripts\class25B.js","scripts\llm_local.js","scripts\glosario.js","MIIA\chat_contexto.py") | Where-Object { -not (Test-Path $_) }
if ($faltanChat) { Wrn ("Faltan archivos del chat local: " + ($faltanChat -join ", ") + " -- checkout viejo? El chat no tendria Ollama.") }
else { Ok "Chat local completo (class25B + llm_local + glosario + chat_contexto)" }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

# ── 1. Chocolatey ─────────────────────────────────────────────────────────────
Tit "1/12 · Chocolatey (gestor de paquetes)"
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [System.Net.ServicePointManager]::SecurityProtocol = 3072
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  Refresh-Path
}
Ok "choco $(choco --version)"

function Choco-Install($pkg, [string]$extra=""){
  Write-Host "   · instalando $pkg ..."
  choco install $pkg -y --no-progress $extra | Out-Null
  Refresh-Path
}

# ── 2. Runtimes: Node 20, Python, .NET 9, Git, OpenSSL, NSSM ──────────────────
Tit "2/12 · Node 20 · Python 3 · .NET SDK 9 · Git · OpenSSL · NSSM"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Choco-Install "nodejs-lts" }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Choco-Install "python" }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Choco-Install "dotnet-sdk" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Choco-Install "git" }
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) { Choco-Install "openssl.light" }
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { Choco-Install "nssm" }
Refresh-Path
Ok "node $(node -v) · python $(python --version 2>&1) · dotnet $(dotnet --version)"

# ── 3. MySQL 8 + base + usuario + esquema ─────────────────────────────────────
Tit "3/12 · MySQL 8 + base de datos"
if (-not (Get-Service MySQL* -ErrorAction SilentlyContinue)) { Choco-Install "mysql" }
Start-Service MySQL* -ErrorAction SilentlyContinue
Refresh-Path
# mysql.exe en PATH (choco lo pone en C:\tools\mysql\current\bin)
$mysql = (Get-Command mysql.exe -ErrorAction SilentlyContinue).Source
if (-not $mysql) { $mysql = (Get-ChildItem "C:\tools\mysql\current\bin\mysql.exe" -ErrorAction SilentlyContinue | Select -First 1).FullName }
if (-not $mysql) { Wrn "No encontré mysql.exe — el paso de base quedó pendiente (ver DEPLOY.md)"; }

$DB_NAME = "miia_cognitiva"; $DB_USER = "miia"
$DB_PASS = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 20 | ForEach-Object {[char]$_})
if ($mysql) {
  # choco instala MySQL con root SIN password por defecto. Creamos base + usuario.
  $sql = @"
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
"@
  $sql | & $mysql --user=root 2>$null
  Ok "Base '$DB_NAME' y usuario '$DB_USER' listos"

  # Esquema SOLO si la base está vacía (el dump trae DROP TABLE → no pisar datos)
  $n = (& $mysql --user=root -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME';" 2>$null | Out-String).Trim()
  if (($n -eq '' -or [int]$n -eq 0) -and (Test-Path "docs\esquema_miia_cognitiva.sql")) {
    Get-Content "docs\esquema_miia_cognitiva.sql" -Raw | & $mysql --user=root $DB_NAME 2>$null
    Ok "Esquema cargado (36 tablas)"
  } elseif ([int]$n -gt 0) { Wrn "La base YA tiene $n tablas → NO cargo el esquema" }
}

# ── 4. Redis (Memurai) ────────────────────────────────────────────────────────
Tit "4/12 · Redis para Windows (Memurai)"
if (-not (Get-Service Memurai -ErrorAction SilentlyContinue)) {
  try { Choco-Install "memurai-developer" }
  catch { Wrn "No se pudo instalar Memurai por choco. Bajalo de https://www.memurai.com/get-memurai e instalalo a mano. (Alternativa: Redis en WSL2 — ver DEPLOY.md)" }
}
Start-Service Memurai -ErrorAction SilentlyContinue
if (Get-Service Memurai -ErrorAction SilentlyContinue) { Ok "Memurai (Redis 6379) corriendo como servicio" }
else { Wrn "Redis NO está corriendo. MIIA no arranca sin Redis — resolvelo antes de seguir." }

# ── 5. Dependencias del proyecto (npm) ────────────────────────────────────────
Tit "5/12 · npm install"
npm install --no-audit --no-fund
Ok "node_modules listo"

# ── 6. Python venv + torch CPU + requirements ─────────────────────────────────
Tit "6/12 · Python venv + torch(CPU) + requirements"
if (-not (Test-Path "MIIA\venv")) { python -m venv MIIA\venv }
$pyvenv = "MIIA\venv\Scripts\python.exe"
& $pyvenv -m pip install --upgrade pip -q
& $pyvenv -m pip install torch --index-url https://download.pytorch.org/whl/cpu -q
& $pyvenv -m pip install -r MIIA\requirements.txt -q
Ok "venv + torch + requirements"

# ── 7. Compilar .NET (Release) ────────────────────────────────────────────────
Tit "7/12 · Motor vectorial .NET (Release)"
Push-Location MIIA_MotoresVectoriales
try { dotnet build -c Release | Out-Null; Ok "MIIA_MotoresVectoriales.dll (Release)" }
catch { Wrn "dotnet build falló — revisá el log" }
Pop-Location

# ── 8. Compilar C++ con MinGW (MSYS2) — EL PASO MÁS FRÁGIL ─────────────────────
if ($SkipCpp) {
  Tit "8/12 · C++ — SALTEADO (-SkipCpp)"
  Wrn "Compilá a mano con MSYS2 MinGW64: ver el bloque de abajo en DEPLOY.md"
} else {
  Tit "8/12 · Compilando C++ con MinGW (MSYS2)"
  if (-not (Test-Path "C:\tools\msys64\usr\bin\bash.exe")) { Choco-Install "msys2" }
  $bash = "C:\tools\msys64\usr\bin\bash.exe"
  if (Test-Path $bash) {
    # toolchain + cmake + deps; redis-plus-plus NO está en MSYS2 → de fuente.
    $cmds = @'
set -e
pacman -Sy --noconfirm --needed mingw-w64-x86_64-toolchain mingw-w64-x86_64-cmake \
  mingw-w64-x86_64-nlohmann-json mingw-w64-x86_64-spdlog mingw-w64-x86_64-fmt \
  mingw-w64-x86_64-hiredis git
export PATH=/mingw64/bin:$PATH
# redis-plus-plus de fuente (si no está instalado en el prefijo mingw64)
if [ ! -f /mingw64/lib/cmake/redis++/redis++-config.cmake ]; then
  tmp=$(mktemp -d); git clone --depth 1 https://github.com/sewenew/redis-plus-plus "$tmp/rpp"
  cmake -G "MinGW Makefiles" -S "$tmp/rpp" -B "$tmp/rpp/build" \
    -DREDIS_PLUS_PLUS_BUILD_TEST=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/mingw64
  cmake --build "$tmp/rpp/build" -j
  cmake --install "$tmp/rpp/build"
fi
# el proyecto (el CMakeLists copia los binarios a ../scripts/)
cd "$(cygpath "%ROOT%")/miia_cognitive"
cmake -G "MinGW Makefiles" -B build-mingw -DCMAKE_BUILD_TYPE=Release
cmake --build build-mingw -j
'@
    $cmds = $cmds -replace "%ROOT%", $ROOT
    $tmpSh = Join-Path $env:TEMP "miia_build_cpp.sh"
    # MSYS2 necesita el script con LF, no CRLF
    [IO.File]::WriteAllText($tmpSh, ($cmds -replace "`r`n","`n"))
    $msysPath = & "C:\tools\msys64\usr\bin\cygpath.exe" $tmpSh
    try {
      & "C:\tools\msys64\usr\bin\env.exe" MSYSTEM=MINGW64 $bash -lc "bash '$msysPath'"
      $faltan = @("class21","class22","class23","class24","class27","class28","class29","class25A") |
        Where-Object { -not (Test-Path "scripts\$_.exe") }
      if ($faltan.Count -eq 0) { Ok "8 binarios C++ generados en scripts\" }
      else { Wrn ("Faltan binarios: " + ($faltan -join ", ") + " — terminá el build a mano (DEPLOY.md)") }
    } catch { Wrn "El build de C++ falló. No es fatal: terminalo a mano con MSYS2 MinGW64 (DEPLOY.md). El resto del deploy ya quedó." }
  } else { Wrn "MSYS2 no quedó instalado — instalalo y compilá el C++ aparte" }
}

# ── 9. .env + certificado TLS ─────────────────────────────────────────────────
Tit "9/12 · .env + certificado TLS"
$envFile = "operador\aprendizaje\config\.env"
if (-not (Test-Path $envFile)) {
  Copy-Item "operador\aprendizaje\config\.env.example" $envFile
  # 64 hex chars CON reemplazo (Get-Random -Count no sirve: pediría 64 de 16)
  $jwt = -join (1..64 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  (Get-Content $envFile) `
    -replace '^DB_NAME=.*', "DB_NAME=$DB_NAME" `
    -replace '^DB_USER=.*', "DB_USER=$DB_USER" `
    -replace '^DB_PASS=.*', "DB_PASS=$DB_PASS" `
    -replace '^JWT_SECRET=.*', "JWT_SECRET=$jwt" `
    -replace '^# PYTHON_BIN=.*', "PYTHON_BIN=$ROOT\MIIA\venv\Scripts\python.exe" |
    Set-Content $envFile -Encoding UTF8
  $script:FALTA_ENV = $true
  Wrn "Creé $envFile desde la plantilla (DB + JWT ya puestos). FALTAN los secretos (APIs, Gemini, OAuth, MP)."
} else { Ok ".env ya existe — lo respeto" }

# Certificado del origen (Cloudflare hace el TLS público; mejor un Origin Cert)
New-Item -ItemType Directory -Force -Path "scripts\certs" | Out-Null
if (-not (Test-Path "scripts\certs\pen.key") -or -not (Test-Path "scripts\certs\certen.pem")) {
  & openssl req -x509 -newkey rsa:2048 -nodes -days 3650 `
    -keyout "scripts\certs\pen.key" -out "scripts\certs\certen.pem" `
    -subj "/CN=$Dominio" -addext "subjectAltName=DNS:$Dominio,DNS:localhost,IP:127.0.0.1" 2>$null
  Ok "Certificado self-signed generado (CN=$Dominio)"
} else { Ok "Certificado ya existe" }

# ── 10. Build de la web ───────────────────────────────────────────────────────
Tit "10/12 · Build de la web (publi_src → publi)"
if (Test-Path "scripts\build_publi.js") { node scripts\build_publi.js; Ok "publi\ empaquetado" }
else { Wrn "No encontré scripts\build_publi.js" }

# ── 11. pm2 + arranque al bootear ─────────────────────────────────────────────
if (-not $NoPm2) {
  Tit "11/12 · pm2 (arranque + boot)"
  if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { npm install -g pm2 pm2-windows-startup | Out-Null; Refresh-Path }
  pm2 describe miia *>$null
  if ($LASTEXITCODE -eq 0) { pm2 restart miia --update-env } else { pm2 start operador\index.js --name miia --time }
  pm2 save
  # Boot en Windows: pm2-windows-startup registra una tarea que hace 'pm2 resurrect'
  try { pm2-startup install | Out-Null; Ok "pm2 arrancará al bootear (pm2-windows-startup)" }
  catch { Wrn "pm2-startup falló. Alternativa robusta: NSSM (ver DEPLOY.md) — nssm install MIIA node operador\index.js" }
  Ok "pm2: 'miia' corriendo"
} else { Tit "11/12 · pm2 — OMITIDO"; Wrn "Arrancá a mano:  node operador\index.js" }

# ── 12. Firewall de Windows (solo Cloudflare) ─────────────────────────────────
if (-not $NoFirewall) {
  Tit "12/12 · Windows Firewall — 80/8443 solo desde Cloudflare"
  # Windows bloquea TODO el inbound por defecto, así que solo agregamos los ALLOW
  # restringidos a los rangos de Cloudflare. RDP (3389) ya tiene su regla default.
  try {
    $cf = (Invoke-WebRequest "https://www.cloudflare.com/ips-v4" -UseBasicParsing).Content -split "`n" | Where-Object { $_ -match '^\d' }
    $cf6 = (Invoke-WebRequest "https://www.cloudflare.com/ips-v6" -UseBasicParsing).Content -split "`n" | Where-Object { $_ -match ':' }
  } catch {
    $cf = @("173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22")
    $cf6 = @("2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32")
  }
  $rangos = @($cf; $cf6) | Where-Object { $_ }
  if ($rangos.Count -lt 10) { Die "Lista de Cloudflare vacía/corta: NO aplico (abriría/cerraría mal)." }
  if ($AplicarFirewall) {
    Get-NetFirewallRule -DisplayName "MIIA-CF-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "MIIA-CF-web" -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort 80,8443 -RemoteAddress $rangos | Out-Null
    Ok "80 y 8443 permitidos SOLO desde $($rangos.Count) rangos de Cloudflare. El resto, bloqueado por default."
    Wrn "Revisá que NO haya otra regla inbound abriendo 80/8443 a 'Any': Get-NetFirewallRule | ? Enabled | ..."
  } else {
    Wrn "Firewall en modo REVISIÓN. Para aplicarlo, re-corré con -AplicarFirewall."
    Write-Host ("        rangos CF detectados: " + $rangos.Count)
  }
} else { Tit "12/12 · Firewall — OMITIDO" }

# ── Opcional: Ollama ──────────────────────────────────────────────────────────
if ($WithOllama) {
  Tit "Extra · Ollama (motor de lenguaje local)"
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Choco-Install "ollama" }
  try { ollama pull gemma2:2b; Ok "gemma2:2b descargado" } catch { Wrn "ollama pull falló — hacelo a mano: ollama pull gemma2:2b" }
}

# ── Resumen ───────────────────────────────────────────────────────────────────
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "   OK  MIIA instalada en Windows Server." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
if ($script:FALTA_ENV) {
  Write-Host "   !  FALTA completar los secretos en:  $envFile" -ForegroundColor Yellow
  Write-Host "      (DB y JWT ya están; faltan FINNHUB_KEY, GEMINI_API_KEY, GOOGLE_*, MP_*)"
  Write-Host "      Después:  pm2 restart miia --update-env"
}
Write-Host "   Verificar:  pm2 status  ·  pm2 logs miia --lines 60"
Write-Host "   Web: Cloudflare (443) -> origen 8443. Apuntá el DNS de $Dominio al server (proxy ON)."
Write-Host "   Credencial de base generada (si era fresh):  DB_USER=$DB_USER  (clave en el .env)"
