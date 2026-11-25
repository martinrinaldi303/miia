<#
.SYNOPSIS
    Corre todas las pruebas en frio de los cambios del corte del 12-oct-2026.

.DESCRIPTION
    Son pruebas EN FRIO: no necesitan el sistema corriendo, ni Redis, ni MySQL,
    ni tocan produccion. Ejecutan el codigo real de los modulos contra datos
    reales del volcado, en la computadora de Martin.

    Node corre sim6 (defecto 5, class43.js). MinGW64 compila y corre sim7
    (defecto 10, class23.cpp y class24.cpp). Si falta MinGW, sim6 igual corre
    y el script lo dice.

.PARAMETER Verboso
    Muestra tambien el log interno de los modulos, no solo la salida de las
    pruebas.

.EXAMPLE
    .\docs\simulaciones\probar.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\docs\simulaciones\probar.ps1 -Verboso
#>
[CmdletBinding()]
param(
    [switch]$Verboso
)

Set-StrictMode -Version Latest

# La consola tiene que estar en UTF-8 o los acentos y los simbolos salen rotos.
$encodingPrevio = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$AQUI = Split-Path -Parent $MyInvocation.MyCommand.Path
$RAIZ = Split-Path -Parent (Split-Path -Parent $AQUI)
$OUT  = Join-Path $env:TEMP 'miia-sim7'
if (-not (Test-Path $OUT)) { New-Item -ItemType Directory -Path $OUT | Out-Null }

$resultados = @()

function Write-Titulo($texto) {
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkGray
    Write-Host "  $texto" -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkGray
}

function Agregar-Resultado($nombre, $ok, $nota) {
    $script:resultados += [PSCustomObject]@{ Prueba = $nombre; Estado = $(if ($ok) { 'PASA' } else { 'FALLA' }); Nota = $nota }
}

# ─────────────────────────────────────────────────────────────────────────
# 1 · Defecto 5 — class43.js, con Node
# ─────────────────────────────────────────────────────────────────────────
Write-Titulo 'Defecto 5 - el agregado se valua equiponderado (class43.js)'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'node no esta en el PATH. Instalar Node.js o abrir otra consola.' -ForegroundColor Yellow
    Agregar-Resultado 'sim6 / defecto 5' $false 'falta node'
} else {
    $sim6 = Join-Path $AQUI 'sim6_indice_equiponderado.js'
    $argsSim6 = @($sim6)
    if ($Verboso) { $argsSim6 += '--verboso' }
    & $node.Source $argsSim6
    $ok6 = ($LASTEXITCODE -eq 0)
    Agregar-Resultado 'sim6 / defecto 5' $ok6 'class43.js, 80 ventanas reales'

    # sim8 va ANTES que sim7: regenera el payload que class43 publica, y sim7
    # lo consume. Asi el contrato se verifica fresco en cada corrida, en vez de
    # contra un archivo viejo que ya no se parece a lo que manda class43.
    Write-Titulo 'Contrato class43 -> class23/class24 (el que consume sim7)'
    $sim8 = Join-Path $AQUI 'sim8_contrato_feedback.js'
    $argsSim8 = @($sim8)
    if ($Verboso) { $argsSim8 += '--verboso' }
    & $node.Source $argsSim8
    $ok8 = ($LASTEXITCODE -eq 0)
    Agregar-Resultado 'sim8 / contrato de feedback' $ok8 'los dos caminos de class43'

    Write-Titulo 'class43 / class42 - los cuatro del bloque 2 del corte'
    $sim14 = Join-Path $AQUI 'sim14_class43.js'
    $argsSim14 = @($sim14)
    if ($Verboso) { $argsSim14 += '--verboso' }
    & $node.Source $argsSim14
    Agregar-Resultado 'sim14 / class43 y class42' ($LASTEXITCODE -eq 0) 'defecto 4, duplicacion, cola, stats'

    Write-Titulo 'Universo de instrumentos - fuente unica (config/universo.json)'
    $sim10 = Join-Path $AQUI 'sim10_universo.js'
    & $node.Source @($sim10)
    $ok10 = ($LASTEXITCODE -eq 0)
    Agregar-Resultado 'sim10 / universo unificado' $ok10 'JSON + 2 respaldos + trinquete'

    Write-Titulo 'Cuota del proveedor de precios - class7 con 50 instrumentos'
    $sim16 = Join-Path $AQUI 'sim16_cuota_class7.js'
    & $node.Source @($sim16)
    Agregar-Resultado 'sim16 / cuota de class7' ($LASTEXITCODE -eq 0) 'tope duro, arranque, reentrada'

    Write-Titulo 'Impacto mediatico POR INSTRUMENTO - class11 real'
    $sim19 = Join-Path $AQUI 'sim19_impacto_por_ticker.js'
    & $node.Source @($sim19)
    Agregar-Resultado 'sim19 / impacto por instrumento' ($LASTEXITCODE -eq 0) 'symbol de class1 a class19'

    Write-Titulo 'Par class40 + class41 - pronostico y riesgo'
    $sim20 = Join-Path $AQUI 'sim20_par_class40_41.js'
    & $node.Source @($sim20)
    Agregar-Resultado 'sim20 / par class40+class41' ($LASTEXITCODE -eq 0) 'cableado, ciclo sin ganancia, OFF'

    Write-Titulo 'Envelope de class1 hacia class3 - la cadena de noticias'
    $sim22 = Join-Path $AQUI 'sim22_envelope_class1.js'
    & $node.Source @($sim22)
    Agregar-Resultado 'sim22 / envelope de class1' ($LASTEXITCODE -eq 0) 'el titular y el symbol, no la consulta'

    $sim24 = Join-Path $AQUI 'sim24_cola_class30.js'
    & $node.Source @($sim24)
    Agregar-Resultado 'sim24 / cola de class30' ($LASTEXITCODE -eq 0) 'la fuga de memoria: tope duro'

    # ── INTEGRACION: procesos reales contra un Redis real ──────────────
    # Las de arriba importan el modulo y llaman a sus funciones. Estas levantan
    # el proceso de verdad. Si no hay Redis se SALTEAN: no tener Redis local no
    # es una falla del codigo, y marcarlo como tal ensenaria a ignorar el rojo.
    $redisCli = Join-Path $RAIZ 'redis\redis-cli.exe'
    $hayRedis = $false
    if (Test-Path $redisCli) {
        $pong = & $redisCli -p 6379 ping 2>$null
        if ($pong -match 'PONG') { $hayRedis = $true }
    }
    if ($hayRedis) {
        Write-Titulo 'INTEGRACION - class1 a class11 a class18 (procesos reales)'
        & $node.Source @((Join-Path $AQUI 'integracion_noticias.js'))
        Agregar-Resultado 'int / noticias por instrumento' ($LASTEXITCODE -eq 0) 'class11 real + Redis real'

        Write-Titulo 'INTEGRACION - class18 a class19 (motor .NET real)'
        & $node.Source @((Join-Path $AQUI 'integracion_vectores.js'))
        Agregar-Resultado 'int / symbol por el motor .NET' ($LASTEXITCODE -eq 0) 'el .NET de verdad'

        Write-Titulo 'INTEGRACION - class3 a class19 (el switch, con el .NET real)'
        & $node.Source @((Join-Path $AQUI 'integracion_class3.js'))
        Agregar-Resultado 'int / cadena de class3' ($LASTEXITCODE -eq 0) 'apagado no se suscribe, prendido publica'
    } else {
        Write-Host ''
        Write-Host '  [SALTEADA] integracion: no hay Redis en localhost:6379' -ForegroundColor DarkYellow
        Write-Host '             arrancalo con  .\redis\redis-server.exe  y volve a correr' -ForegroundColor DarkGray
    }

    Write-Titulo 'Portabilidad a Linux - el Ubuntu del server'
    $sim18 = Join-Path $AQUI 'sim18_linux.js'
    & $node.Source @($sim18)
    Agregar-Resultado 'sim18 / portabilidad a Linux' ($LASTEXITCODE -eq 0) 'CRLF, caja, .NET Release, cuota'

    Write-Titulo 'Rendimiento de la API - por que el endpoint tardaba 14 s'
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim12_rendimiento_api.py'))
        Agregar-Resultado 'sim12 / rendimiento de la API' ($LASTEXITCODE -eq 0) 'costo medido + guardas'
    } else {
        Write-Host 'python no esta en el PATH' -ForegroundColor Yellow
        Agregar-Resultado 'sim12 / rendimiento de la API' $false 'falta python'
    }

    Write-Titulo 'Rotacion del LSTM - los 50 sin cuadruplicar las descargas'
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim30_rotacion_lstm.py'))
        Agregar-Resultado 'sim30 / rotacion del LSTM' ($LASTEXITCODE -eq 0) 'reparto parejo, cuota de Yahoo, 3 copias'
    } else {
        Agregar-Resultado 'sim30 / rotacion del LSTM' $false 'falta python'
    }

    Write-Titulo 'Marcador del LSTM - que modelo le gana al promedio'
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim31_marcador_lstm.py'))
        Agregar-Resultado 'sim31 / marcador del LSTM' ($LASTEXITCODE -eq 0) 'acierto vs base, banda, donde se usa'
    } else {
        Agregar-Resultado 'sim31 / marcador del LSTM' $false 'falta python'
    }

    Write-Titulo 'Semana de mercado - la tira del panel de Regimen'
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim33_semana_mercado.py'))
        Agregar-Resultado 'sim33 / semana de mercado' ($LASTEXITCODE -eq 0) 'retornos no precios, dias sin rueda, los 50'
    } else {
        Agregar-Resultado 'sim33 / semana de mercado' $false 'falta python'
    }

    Write-Titulo 'Relay de chat - foco por ticker y correlacion de la respuesta'
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim34_chat_contexto.py'))
        Agregar-Resultado 'sim34 / relay de chat' ($LASTEXITCODE -eq 0) 'ARG no es ARGT, payload acotado, respuesta correlacionada'
    } else {
        Agregar-Resultado 'sim34 / relay de chat' $false 'falta python'
    }

    Write-Titulo 'Rank IC - sesiones cerradas y la beta'
    if ($py) {
        & $py.Source @((Join-Path $AQUI 'sim39_rank_ic_beta.py'))
        Agregar-Resultado 'sim39 / rank IC y beta' ($LASTEXITCODE -eq 0) 'sin la rueda de hoy, IC neutral a beta'
    } else {
        Agregar-Resultado 'sim39 / rank IC y beta' $false 'falta python'
    }

    Write-Titulo 'Motor de lenguaje local - Ollama y la guarda de Redis'
    $sim32 = Join-Path $AQUI 'sim32_llm_local.js'
    & $node.Source @($sim32)
    Agregar-Resultado 'sim32 / motor local + Redis' ($LASTEXITCODE -eq 0) 'cliente Ollama, breaker, router, respawn'

    Write-Titulo 'Chat - router de intenciones, evidencia y redactor (2-nov)'
    $sim35 = Join-Path $AQUI 'sim35_chat_intenciones.js'
    & $node.Source @($sim35)
    Agregar-Resultado 'sim35 / router del chat' ($LASTEXITCODE -eq 0) 'intenciones, NYSE, datos en cada respuesta, validacion'
    $sim36 = Join-Path $AQUI 'sim36_mi_portfolio.js'
    & $node.Source @($sim36)
    Agregar-Resultado 'sim36 / mi portafolio en el chat' ($LASTEXITCODE -eq 0) 'portafolio guardado vs. mercado, sin plantilla'
    $sim37 = Join-Path $AQUI 'sim37_cartera_conversacion.js'
    & $node.Source @($sim37)
    Agregar-Resultado 'sim37 / cartera conversada' ($LASTEXITCODE -eq 0) 'perfil y capital en cualquier orden, pesos que suman 100'
    $sim38 = Join-Path $AQUI 'sim38_ventaja_azar.js'
    & $node.Source @($sim38)
    Agregar-Resultado 'sim38 / ventaja contra el azar' ($LASTEXITCODE -eq 0) 'backend, web y chat dan lo mismo; la captura da +3,9'

    Write-Titulo 'Seguridad - puntos 1, 3 y 4 de la auditoria del 9-sep'
    $sim11 = Join-Path $AQUI 'sim11_seguridad.js'
    & $node.Source @($sim11)
    $ok11 = ($LASTEXITCODE -eq 0)
    Agregar-Resultado 'sim11 / seguridad' $ok11 'bus con auth, IP real, Origin'
    $sim42 = Join-Path $AQUI 'sim42_sesion.js'
    & $node.Source @($sim42)
    Agregar-Resultado 'sim42 / sesion obligatoria' ($LASTEXITCODE -eq 0) 'sin Google no se ve nada; portada publica'
}

# ─────────────────────────────────────────────────────────────────────────
# 2 · Defecto 10 — class23.cpp y class24.cpp, con MinGW64
# ─────────────────────────────────────────────────────────────────────────
Write-Titulo 'Defecto 10 - emparejar por (instrumento, hora) (class23/class24)'

# g++ del PATH; si no esta, los lugares donde suele vivir MSYS2.
$gpp = Get-Command g++ -ErrorAction SilentlyContinue
if (-not $gpp) {
    $candidatos = @(
        'C:\msys64\mingw64\bin',
        'C:\msys64\ucrt64\bin',
        'C:\MinGW\bin',
        "$env:ProgramFiles\mingw64\bin"
    )
    foreach ($dir in $candidatos) {
        if (Test-Path (Join-Path $dir 'g++.exe')) {
            $env:PATH = "$dir;$env:PATH"
            $gpp = Get-Command g++ -ErrorAction SilentlyContinue
            Write-Host "MinGW encontrado en $dir" -ForegroundColor DarkGray
            break
        }
    }
}

if (-not $gpp) {
    Write-Host ''
    Write-Host 'No se encontro g++ (MinGW64).' -ForegroundColor Yellow
    Write-Host 'El defecto 10 es C++ y sin compilador no se puede probar aca.' -ForegroundColor Yellow
    Write-Host 'Se instala con MSYS2: https://www.msys2.org  y despues:' -ForegroundColor DarkGray
    Write-Host '  pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-hiredis mingw-w64-x86_64-redis-plus-plus mingw-w64-x86_64-spdlog mingw-w64-x86_64-nlohmann-json' -ForegroundColor DarkGray
    Agregar-Resultado 'sim7 / defecto 10' $false 'falta MinGW64'
} else {
    $sim7 = Join-Path $AQUI 'sim7_defecto10.cpp'
    $incDir = Join-Path $RAIZ 'miia_cognitive'

    # spdlog en MSYS2 viene con SPDLOG_FMT_EXTERNAL: sin -lfmt fallan cientos
    # de "undefined reference to fmt::v12::" que no tienen que ver con el codigo.
    $libs = @('-lredis++', '-lhiredis', '-lspdlog', '-lfmt', '-lws2_32')

    foreach ($modulo in @('class24', 'class23')) {
        Write-Host ''
        Write-Host "-- compilando sim7 contra $modulo --" -ForegroundColor DarkGray
        $exe = Join-Path $OUT "sim7_$modulo.exe"
        $flags = @('-std=c++17', '-O1', "-I$incDir", '-DMIIA_SIN_MAIN')
        if ($modulo -eq 'class23') { $flags += '-DTESTEAR_CLASS23' }

        & $gpp.Source ($flags + @($sim7) + $libs + @('-o', $exe))
        if ($LASTEXITCODE -ne 0) {
            Write-Host "fallo la compilacion de $modulo" -ForegroundColor Red
            Agregar-Resultado "sim7 / defecto 10 ($modulo)" $false 'no compila'
            continue
        }

        # El payload que capturo sim8: el test lo pasa por el guard real del C++.
        $contrato = Join-Path $AQUI 'datos\feedback_class43.json'
        & $exe $contrato
        $okCpp = ($LASTEXITCODE -eq 0)
        Agregar-Resultado "sim7 / defecto 10 ($modulo)" $okCpp '684 vectores + contrato + tope'
    }

    # ── Ranking transversal (class25A) ───────────────────────────────────
    Write-Titulo 'Ranking transversal - BUY a los k mejores, SELL a los k peores (class25A)'
    $sim9 = Join-Path $AQUI 'sim9_ranking.cpp'
    $exe9 = Join-Path $OUT 'sim9.exe'
    & $gpp.Source (@('-std=c++17', '-O1', "-I$incDir", '-DMIIA_SIN_MAIN') + @($sim9) + $libs + @('-o', $exe9))
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'fallo la compilacion de sim9' -ForegroundColor Red
        Agregar-Resultado 'sim9 / ranking transversal' $false 'no compila'
    } else {
        & $exe9
        Agregar-Resultado 'sim9 / ranking transversal' ($LASTEXITCODE -eq 0) 'simetria, beta y escala a 100'
    }

    # ── class21: coherencia multilingue y voto siempre ───────────────────
    # -finput-charset/-fexec-charset explicitos: el .cpp tiene titulares con
    # tildes, en cirilico y en chino, y son EL punto de la prueba. Sin esto,
    # MSYS2 puede leerlos con la codepage del sistema y el pliegue de acentos
    # se probaria contra bytes que no son los que llegan en produccion.
    Write-Titulo 'class21 - coherencia en cualquier idioma y voto siempre'
    $sim23 = Join-Path $AQUI 'sim23_class21.cpp'
    $exe23 = Join-Path $OUT 'sim23.exe'
    $flags23 = @('-std=c++17', '-O1', "-I$incDir", '-DMIIA_SIN_MAIN',
                 '-finput-charset=UTF-8', '-fexec-charset=UTF-8')
    & $gpp.Source ($flags23 + @($sim23) + $libs + @('-o', $exe23))
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'fallo la compilacion de sim23' -ForegroundColor Red
        Agregar-Resultado 'sim23 / class21 multilingue' $false 'no compila'
    } else {
        & $exe23
        Agregar-Resultado 'sim23 / class21 multilingue' ($LASTEXITCODE -eq 0) 'acentos, otro alfabeto, publica siempre'
    }

    # ── Normalizador con ventana lenta y tasa de class24 ─────────────────
    Write-Titulo 'Redes - ventana lenta del normalizador y tasa de class24'
    $sim27 = Join-Path $AQUI 'sim27_norm_tasa.cpp'
    $exe27 = Join-Path $OUT 'sim27.exe'
    & $gpp.Source ($flags23 + @($sim27) + $libs + @('-o', $exe27))
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'fallo la compilacion de sim27' -ForegroundColor Red
        Agregar-Resultado 'sim27 / normalizador y tasa' $false 'no compila'
    } else {
        & $exe27
        Agregar-Resultado 'sim27 / normalizador y tasa' ($LASTEXITCODE -eq 0) 'el regimen se ve, legado exacto, tasa del binario'
    }

    # ── class27 y class28: archivos en anillo ────────────────────────────
    Write-Titulo 'class27 y class28 - archivos en anillo, sin acumular'
    $sim28 = Join-Path $AQUI 'sim28_anillo.cpp'
    $exe28 = Join-Path $OUT 'sim28.exe'
    & $gpp.Source (@('-std=c++17', '-O1', "-I$incDir", '-finput-charset=UTF-8', '-fexec-charset=UTF-8') + @($sim28) + $libs + @('-o', $exe28))
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'fallo la compilacion de sim28' -ForegroundColor Red
        Agregar-Resultado 'sim28 / archivos en anillo' $false 'no compila'
    } else {
        & $exe28 $RAIZ
        Agregar-Resultado 'sim28 / archivos en anillo' ($LASTEXITCODE -eq 0) 'carpeta acotada, se recrea si la borran'
    }

    # ── class23 y class24: repaso de ejemplos viejos (5-oct-2026) ────────
    Write-Titulo 'class23 y class24 - repaso de ejemplos viejos'
    $sim29 = Join-Path $AQUI 'sim29_repaso.cpp'
    foreach ($obj in @('class24', 'class23')) {
        $exe29 = Join-Path $OUT "sim29_$obj.exe"
        $extra29 = @()
        if ($obj -eq 'class23') { $extra29 = @('-DTESTEAR_CLASS23') }
        & $gpp.Source ($flags23 + $extra29 + @($sim29) + $libs + @('-o', $exe29))
        if ($LASTEXITCODE -ne 0) {
            Write-Host "fallo la compilacion de sim29 ($obj)" -ForegroundColor Red
            Agregar-Resultado "sim29 / repaso $obj" $false 'no compila'
        } else {
            & $exe29
            Agregar-Resultado "sim29 / repaso $obj" ($LASTEXITCODE -eq 0) 'dias anteriores, no infla seen/sup, apagado = antes'
        }
    }
}

# ---------------------------------------------------------------------
# 3 - El ensamble entero contra los datos de la base
# ---------------------------------------------------------------------
# Va AL FINAL a proposito: su seccion 7 corre el sim9.exe que se acaba de
# compilar sobre las secciones transversales reales del volcado. Si no hay
# compilador, esa seccion se saltea sola y el resto igual corre.
Write-Titulo 'El ensamble entero - secciones reales del volcado'
$py2 = Get-Command python -ErrorAction SilentlyContinue
if (-not $py2) {
    Write-Host 'python no esta en el PATH' -ForegroundColor Yellow
    Agregar-Resultado 'sim13 / ensamble contra la base' $false 'falta python'
} else {
    $sim13 = Join-Path $AQUI 'sim13_ensamble.py'
    $argsSim13 = @($sim13)
    # La extraccion del volcado tarda minutos; por defecto se lee el extracto
    # ya guardado en datos/. -Verboso la fuerza a releer el volcado entero.
    if ($Verboso) { $argsSim13 += '--extraer' }
    & $py2.Source $argsSim13
    Agregar-Resultado 'sim13 / ensamble contra la base' ($LASTEXITCODE -eq 0) 'rank IC + ranking + vara'

    # sim15 va despues de sim13 porque usa el mismo extracto del volcado, y
    # despues de compilar sim9 porque el C++ verifica contra su modelo.
    Write-Titulo 'Base con olvido (EWMA) - el parametro, antes de escribirlo'
    & $py2.Source @((Join-Path $AQUI 'sim15_base_ewma.py'))
    Agregar-Resultado 'sim15 / base con olvido' ($LASTEXITCODE -eq 0) 'vida media 5.000 muestras'
}

Write-Titulo 'Vector de class10 - universo dinamico (C#, datos reales)'
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) {
    & $dotnet.Source @('run', '--project', (Join-Path $AQUI 'sim17_class10'), '-v', 'quiet', '--nologo')
    Agregar-Resultado 'sim17 / vector de class10' ($LASTEXITCODE -eq 0) '13 vs 50, 22 dims, locale es-AR'
} else {
    Write-Host 'dotnet no esta en el PATH' -ForegroundColor Yellow
    Agregar-Resultado 'sim17 / vector de class10' $false 'falta dotnet'
}

Write-Titulo 'Vector de noticias de class3 - ancho fijo (C#)'
if ($dotnet) {
    & $dotnet.Source @('run', '--project', (Join-Path $AQUI 'sim21_class3'), '-v', 'quiet', '--nologo')
    Agregar-Resultado 'sim21 / vector de class3' ($LASTEXITCODE -eq 0) '64 dims fijas, hash estable, symbol'
} else {
    Agregar-Resultado 'sim21 / vector de class3' $false 'falta dotnet'
}

# ─────────────────────────────────────────────────────────────────────────
# Resumen
# ─────────────────────────────────────────────────────────────────────────
Write-Titulo 'Resumen'
$resultados | Format-Table -AutoSize


$fallaron = @($resultados | Where-Object { $_.Estado -ne 'PASA' })
if ($fallaron.Count -eq 0) {
    Write-Host 'Todo en verde.' -ForegroundColor Green
    $codigo = 0
} else {
    Write-Host "$($fallaron.Count) prueba(s) sin pasar." -ForegroundColor Red
    $codigo = 1
}
Write-Host ''

try { [Console]::OutputEncoding = $encodingPrevio } catch {}
exit $codigo
