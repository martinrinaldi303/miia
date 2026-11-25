# ============================================================
# start_predictivo.ps1 — Arranca los 5 motores predictivos MIIA
# Ejecutar desde: C:\Users\Usuario\OneDrive\Escritorio\MIIA\scripts\
# ============================================================

$ROOT   = Split-Path -Parent $PSScriptRoot
$SCRIPTS = $PSScriptRoot

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  MIIA — Motores Predictivos (4)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# ── Verificar Redis ─────────────────────────────────────────
Write-Host "[0/4] Verificando Redis..." -ForegroundColor Yellow
$redis = Get-Process -Name "redis-server" -ErrorAction SilentlyContinue
if (-not $redis) {
    Write-Host "  Iniciando Redis..." -ForegroundColor Gray
    Start-Process -FilePath "$ROOT\redis\redis-server.exe" -WindowStyle Minimized
    Start-Sleep 2
    Write-Host "  Redis OK" -ForegroundColor Green
} else {
    Write-Host "  Redis ya corriendo (PID $($redis.Id))" -ForegroundColor Green
}

# ── 1. class44.py — Motor LSTM (Python) ────────────────────
Write-Host ""
Write-Host "[1/4] class44.py — Motor LSTM Predictivo" -ForegroundColor Yellow
Start-Process -FilePath "python" `
    -ArgumentList "$SCRIPTS\class44.py" `
    -WorkingDirectory $SCRIPTS `
    -WindowStyle Normal
Write-Host "  Iniciado. Entrenará modelos en background (~5-10 min por ticker)." -ForegroundColor Green

Start-Sleep 2

# ── 2. class45.js — Motor de Sentimiento ───────────────────
Write-Host ""
Write-Host "[2/4] class45.js — Motor de Sentimiento de Noticias" -ForegroundColor Yellow
Start-Process -FilePath "node" `
    -ArgumentList "--experimental-vm-modules", "$SCRIPTS\class45.js" `
    -WorkingDirectory $ROOT `
    -WindowStyle Minimized
Write-Host "  Iniciado. Escucha class1_output." -ForegroundColor Green

Start-Sleep 1

# ── 3. class46.js — Dashboard WebSocket ────────────────────
Write-Host ""
Write-Host "[3/4] class46.js — Dashboard Socket.IO (puerto 3001)" -ForegroundColor Yellow
Start-Process -FilePath "node" `
    -ArgumentList "$SCRIPTS\class46.js" `
    -WorkingDirectory $ROOT `
    -WindowStyle Minimized
Write-Host "  Iniciado. Dashboard en: http://localhost:3002/dashboard.html" -ForegroundColor Green

Start-Sleep 1

# ── 4. miia_chatbot.py — Chat Python (puerto 5005) ────────
Write-Host ""
Write-Host "[4/4] miia_chatbot.py — Chat Python (puerto 5005)" -ForegroundColor Yellow
$chatbot = "$ROOT\MIIA\miia_chatbot.py"
Start-Process -FilePath "python" `
    -ArgumentList "-m", "uvicorn", "miia_chatbot:app", "--host", "0.0.0.0", "--port", "5005" `
    -WorkingDirectory "$ROOT\MIIA" `
    -WindowStyle Normal
Write-Host "  Iniciado. Chat en: http://localhost:5005" -ForegroundColor Green
Write-Host "  Via class30: https://localhost:8443/chat.html" -ForegroundColor Green

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  Todos los motores arrancados." -ForegroundColor Cyan
Write-Host ""
Write-Host "  Dashboard : http://localhost:3002/dashboard.html" -ForegroundColor White
Write-Host "  Chat      : http://localhost:5005" -ForegroundColor White
Write-Host "  Gateway   : https://localhost:8443/chat.html" -ForegroundColor White
Write-Host ""
Write-Host "  NOTA: class44 entrenara LSTM la primera vez (~10 min)." -ForegroundColor Gray
Write-Host "  Señales comenzaran a llegar cuando termine el entrenamiento." -ForegroundColor Gray
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""
