#!/usr/bin/env bash
# ============================================================
# miia_check.sh — Diagnóstico del ecosistema MIIA
# ------------------------------------------------------------
# Tres cosas que la versión anterior no hacía:
#
#   1. MIDE EL BUS EN VIVO. Se suscribe a todos los canales por N segundos
#      y construye el grafo real: quién publica, quién escucha, quién está
#      mudo. No se deduce del código: se observa.
#
#   2. BUSCA FIRMAS DE BUG ESTRUCTURAL. Los defectos de este proyecto
#      —constantes silenciosas, modo común entre instrumentos, defaults de
#      0.5, símbolos perdidos— dejan rastro en el tráfico. Cada uno tiene
#      acá un detector.
#
#   3. DISTINGUE [S/D] DE [ROTO]. Una sección vacía tiene que significar
#      UNA sola cosa. La versión con `2>/dev/null` en todos lados hacía que
#      "no pasó nada" y "el chequeo está roto" salieran idénticos — así el
#      grep del neutro sobre `class25a.log` (minúscula, archivo inexistente)
#      falló en silencio durante semanas.
#
# Uso:
#   bash miia_check.sh              # muestreo de 60 s
#   bash miia_check.sh --dur 180    # muestreo largo (mercado cerrado)
#   bash miia_check.sh --rapido     # sin muestreo del bus
# ============================================================

ROOT="${MIIA_ROOT:-/opt/miia}"
L="$ROOT/operador/aprendizaje/logs"
S="$ROOT/operador/aprendizaje/state"
DB="miia_cognitiva"
API="https://miiaia.com/api"
DUR=60
RAPIDO=0
SAMPLE=/tmp/miia_bus_sample.txt

while [ $# -gt 0 ]; do
  case "$1" in
    --dur)    DUR="$2"; shift 2 ;;
    --rapido) RAPIDO=1; shift ;;
    *) shift ;;
  esac
done

ok()    { printf '  \033[32m[OK]\033[0m     %s\n' "$*"; }
sd()    { printf '  \033[33m[S/D]\033[0m    %s\n' "$*"; }
roto()  { printf '  \033[31m[ROTO]\033[0m   %s\n' "$*"; }
alert() { printf '  \033[31m[ALERTA]\033[0m %s\n' "$*"; }
bug()   { printf '  \033[35m[BUG]\033[0m    %s\n' "$*"; }
info()  { printf '           %s\n' "$*"; }
sec()   { printf '\n\033[36m══════ %s ══════\033[0m\n' "$*"; }

# Grep que separa "el archivo no existe" (ROTO) de "no hay coincidencias" (S/D).
grep_chk() {  # archivo patron n_lineas descripcion
  local f="$1" pat="$2" n="${3:-3}" desc="$4" out
  [ -f "$f" ] || { roto "$desc — NO EXISTE $f"; return 2; }
  [ -r "$f" ] || { roto "$desc — sin permiso: $f"; return 2; }
  # Buscar TAMBIÉN en los rotados. class25A escribe a ~895 msg/min y su log rota
  # a los 5 MB: un evento de cadencia horaria (AUTO-NEUTRO cada 72 h, la
  # reconciliación cada 15 min) puede caer entero en un archivo ya rotado.
  # ORDEN CRONOLÓGICO, del más viejo al más nuevo, porque abajo hay un `tail`.
  # Los rotados van primero (.3.gz es más viejo que .1.gz → sort -rV) y el
  # archivo actual último. Al revés, `tail -n` devuelve las coincidencias MÁS
  # VIEJAS y el informe muestra el estado de hace días como si fuera de ahora.
  # Los módulos C++ rotan con spdlog, que NO usa `x.log.1` sino `x.1.log`
  # (`miia_common.h:229`, 3 archivos de 5 MB). Hasta el 16-sep-2026 este grep no
  # los leía y cubría sólo el archivo actual: ~2 h en class25A.
  out="$( { for _r in $(ls -1 "$f".*.gz "$f".[0-9] "${f%.log}".[0-9].log 2>/dev/null | sort -rV); do
              case "$_r" in *.gz) zgrep -ah "$pat" "$_r" 2>/dev/null;;
                            *)    grep  -ah "$pat" "$_r" 2>/dev/null;; esac
            done
            grep -ah "$pat" "$f" 2>/dev/null; } | tail -"$n")"
  if [ -z "$out" ]; then
    # CUÁNTA HISTORIA CUBRE EL ARCHIVO. Sin este dato, "sin coincidencias" es
    # indistinguible de "el archivo arrancó hace dos minutos", y las dos cosas
    # significan lo contrario. Costó una hora de diagnóstico equivocado el
    # 9-sep-2026: se descartó un [BUG] real creyendo que era rotación.
    local cob tam lin
    # La primera línea puede no traer timestamp (banner, continuación de un
    # mensaje multilínea): se buscan los primeros 200 renglones.
    cob="$(head -200 "$f" 2>/dev/null | grep -oE '\[[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:]+' | head -1 | tr -d '[')"
    tam="$(du -h "$f" 2>/dev/null | cut -f1)"
    lin="$(wc -l < "$f" 2>/dev/null)"
    sd "$desc — sin coincidencias de '$pat'"
    printf "           ↳ el archivo cubre desde %s · %s · %s líneas\n" "${cob:-?}" "${tam:-?}" "${lin:-?}"
    printf "           ↳ si la ventana es más corta que la cadencia del evento, esto NO es evidencia\n"
    return 1
  fi
  ok "$desc"; echo "$out" | sed 's/^/           /'; return 0
}

echo "════════════════════════════════════════════════════════════════"
echo "  MIIA · diagnóstico $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  muestreo del bus: ${DUR}s"

# ¿Estaba el mercado abierto durante el muestreo? Es el contexto que decide si
# media sección 4 significa algo. Con el NYSE cerrado, class7 no genera vectores
# nuevos por ticker y TODAS las familias salen GENERAL: eso es el horario, no un
# defecto. Medido el 9-sep-2026: mercado abierto → 14 instrumentos en las
# decisiones; el mismo sistema, 9 h después con el mercado cerrado → 1.
_DOW=$(date -u +%u); _HM=$(date -u +%H%M)   # NYSE: 13:30-20:00 UTC, lunes a viernes
if [ "$_DOW" -le 5 ] && [ "$_HM" -ge 1330 ] && [ "$_HM" -lt 2000 ]; then
  echo "  mercado NYSE: ABIERTO — las secciones 4.x son evaluables"
else
  echo "  mercado NYSE: CERRADO — 4.2/4.3/4.4 miden el camino por instrumento,"
  echo "                que se apaga sin datos nuevos. NO leer sus [BUG] como defecto."
fi
echo "════════════════════════════════════════════════════════════════"

# ════════════════════════════════════════════════════════════
sec "1 · INFRAESTRUCTURA"
# ════════════════════════════════════════════════════════════
D=$(df -h / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
[ "$D" -lt 85 ] && ok "disco ${D}%" || alert "disco ${D}% — revisar backups y logs"
info "MySQL $(du -sh /var/lib/mysql 2>/dev/null | cut -f1) · logs $(du -sh "$L" 2>/dev/null | cut -f1)"
# ── Memoria ────────────────────────────────────────────────
# El valor de un día no dice nada; la PENDIENTE sí. Medido entre el 10 y el
# 20-sep-2026: +1,35 a +1,56 puntos por día (160-190 MB), sin aplanarse.
#
# Lo que hay que mirar es `available`, no `used`: `used` ya descuenta el caché,
# pero el caché es reclamable y por eso `available` es el margen de verdad.
# La VPS NO tiene swap (verificado 20-sep-2026), así que no hay aterrizaje
# suave: si `available` llega a 0 el kernel mata el proceso de mayor RSS —hoy
# mysqld (2,9 GB, de los cuales 2 GB son buffer pool y no crecen) y después
# class44 (1,3 GB, PyTorch, el candidato a la pérdida)—. Un módulo que muera
# así y no esté en CRITICAL_LABELS queda muerto en silencio.
read -r MT MU MC MA MSW <<< "$(free -m | awk '/^Mem:/{t=$2;u=$3;c=$6;a=$7} /^Swap:/{s=$2} END{print t+0,u+0,c+0,a+0,s+0}')"
R=$(( MU * 100 / (MT > 0 ? MT : 1) ))
[ "$R" -lt 85 ] && ok "RAM ${R}% — ${MU} de ${MT} MB" || alert "RAM ${R}% — ${MU} de ${MT} MB"
[ "$MA" -gt 1024 ] \
  && ok "disponible ${MA} MB · caché ${MC} MB" \
  || alert "disponible ${MA} MB — abajo de 1 GB: el kernel está por matar algo"
[ "$MSW" -gt 0 ] \
  && info "swap ${MSW} MB" \
  || info "sin swap — agregarlo son 30 s y no reinicia nada (fallocate/mkswap/swapon)"

# Historial propio del chequeo: una línea por corrida, para tener la pendiente.
# Vive en /root junto al script, no toca nada de MIIA.
HRAM="${MIIA_RAM_HIST:-/root/.miia_ram.log}"
AHORA=$(date +%s)
printf '%s %s %s\n' "$AHORA" "$MU" "$MA" >> "$HRAM" 2>/dev/null
TASA=""
[ -f "$HRAM" ] && TASA=$(awk -v ahora="$AHORA" -v mu="$MU" '
  $1 <= ahora - 43200 { tr=$1; ur=$2 }        # la referencia más reciente con 12 h o más
  END { if (tr != "") printf "%.0f %.0f", (mu-ur)/((ahora-tr)/86400), (ahora-tr)/3600 }' "$HRAM")
if [ -n "$TASA" ]; then
  read -r D_MB D_H <<< "$TASA"
  if [ "$D_MB" -gt 20 ] 2>/dev/null; then
    DIAS=$(( (MA - 1024) / D_MB ))
    [ "$DIAS" -gt 14 ] \
      && info "tendencia +${D_MB} MB/día (sobre ${D_H} h) — ${DIAS} días hasta quedar en 1 GB" \
      || alert "tendencia +${D_MB} MB/día — quedan ~${DIAS} días de margen"
  else
    info "tendencia ${D_MB} MB/día (sobre ${D_H} h) — estable"
  fi
else
  info "tendencia: hace falta una corrida anterior de 12 h o más (historial: $HRAM)"
fi

# Desglose para la hoja Recursos de la planilla. El RSS de ps viene en KB.
info "procesos más pesados (RSS · días arriba):"
ps -eo rss=,etimes=,args= --sort=-rss 2>/dev/null | head -5 | awk '
  { cmd=$3; for (i=3; i<=NF; i++) if ($i ~ /[.]js$|[.]py$/) cmd=$i
    n=split(cmd, p, "/")
    printf "           %8.0f MB  %5.1f d  %s\n", $1/1024, $2/86400, p[n] }'
info "load $(awk '{print $1,$2,$3}' /proc/loadavg) sobre $(nproc) núcleos"
redis-cli ping >/dev/null 2>&1 \
  && ok "Redis OK · $(redis-cli INFO memory | grep -oP 'used_memory_human:\K[^\r]*')" \
  || alert "Redis NO responde"
mysqladmin status >/dev/null 2>&1 && ok "MySQL OK" || alert "MySQL NO responde"

# ════════════════════════════════════════════════════════════
sec "2 · GENERACIÓN DE PROCESOS"
# ════════════════════════════════════════════════════════════
# Corchete obligatorio: sin él el patrón matchea al propio shell. Produjo
# falsos positivos el 30-ago y el 8-sep.
ORQ=$(pgrep -f "[o]perador/index.js" | head -1)
NORQ=$(pgrep -cf "[o]perador/index.js")
if [ -z "$ORQ" ]; then
  alert "NO hay orquestador"
else
  EDAD=$(ps -o etimes= -p "$ORQ" | tr -d ' ')
  V=0; H=0
  while read -r pid ppid et _; do
    [ "$et" -gt $((EDAD+60)) ] 2>/dev/null && V=$((V+1))
    [ "$ppid" = "1" ] && H=$((H+1))
  done < <(ps -eo pid,ppid,etimes,args | grep "[/]opt/miia" | grep -v grep)
  info "orquestador pid=$ORQ edad=${EDAD}s · procesos MIIA=$(ps -eo args | grep -c '[/]opt/miia')"
  { [ "$NORQ" -eq 1 ] && [ "$V" -eq 0 ] && [ "$H" -eq 0 ]; } \
    && ok "UNA SOLA GENERACIÓN" \
    || alert "orquestadores=$NORQ más_viejos=$V reparentados=$H"
fi
# Los binarios C++ NO aparecen en ps con la ruta /opt/miia/scripts/ — verificado
# 8-sep. Un `pgrep -f` por ruta no matchea y da un falso "caído". Va por nombre.
CAIDOS=""
for m in class21 class22 class23 class24 class25A class27 class28 class29; do
  pgrep -x "$m" >/dev/null || CAIDOS="$CAIDOS $m"
done
[ -z "$CAIDOS" ] && ok "los 8 módulos C++ vivos" || alert "C++ caídos:$CAIDOS"

# ════════════════════════════════════════════════════════════
if [ "$RAPIDO" -eq 0 ]; then
sec "3 · GRAFO DEL BUS — medido, no deducido"
# ════════════════════════════════════════════════════════════
echo "  muestreando todos los canales por ${DUR}s…"
timeout "${DUR}" redis-cli --raw psubscribe '*' > "$SAMPLE" 2>/dev/null || true

if [ ! -s "$SAMPLE" ]; then
  roto "el muestreo no capturó NADA — ¿Redis vivo? ¿el sistema publica?"
else
  # PUBSUB CHANNELS = canales con al menos un suscriptor SUBSCRIBE.
  # Cruzarlo con lo publicado da los dos tipos de huérfano.
  redis-cli --raw PUBSUB CHANNELS > /tmp/miia_subs.txt 2>/dev/null

  python3 - "$SAMPLE" /tmp/miia_subs.txt "$DUR" <<'PY'
import sys, collections
sample, subs_f, dur = sys.argv[1], sys.argv[2], float(sys.argv[3])

# Formato de `redis-cli --raw psubscribe`: pmessage / patron / canal / payload.
# El payload NO siempre es una sola línea: si trae un salto literal (ui_stream
# manda texto arbitrario a alto caudal), asumir bloques fijos de 4 desincroniza
# la máquina de estados y a partir de ahí se atribuyen payloads al canal
# equivocado. Eso generó [BUG] de contrato falsos el 8-sep.
# Acá el payload se acumula hasta el próximo 'pmessage', que es el único
# delimitador confiable.
cnt = collections.Counter(); first = {}
st = 0; ch = None; buf = []
def cerrar():
    global ch, buf
    if ch is not None:
        cnt[ch] += 1
        first.setdefault(ch, '\n'.join(buf)[:500])
    ch = None; buf = []
for line in open(sample, encoding='utf-8', errors='ignore'):
    line = line.rstrip('\n')
    if line == 'pmessage':
        cerrar(); st = 1; continue
    if st == 1: st = 2; continue          # patrón
    if st == 2: ch = line; st = 3; continue  # canal
    if st == 3: buf.append(line)          # payload (1..N líneas)
cerrar()

try:    subs = set(l.strip() for l in open(subs_f) if l.strip())
except: subs = set()
pubs = set(cnt)

print(f"  \033[32m[OK]\033[0m     {len(pubs)} canales con tráfico · {sum(cnt.values())} mensajes en {dur:.0f}s")
print()
print("           canal                         msgs   msg/min  suscriptores")
for c, n in cnt.most_common(40):
    tiene = "sí" if c in subs else "\033[31mNADIE\033[0m"
    print(f"           {c:28s} {n:6d}  {n/dur*60:7.1f}  {tiene}")

huerf = sorted(pubs - subs)
mudos = sorted(subs - pubs)
print()
if huerf:
    print(f"  \033[35m[BUG]\033[0m    {len(huerf)} canales PUBLICAN y NADIE ESCUCHA — trabajo tirado:")
    for c in huerf: print(f"           · {c}")
else:
    print("  \033[32m[OK]\033[0m     ningún canal publica al vacío")
print()
if mudos:
    print(f"  \033[33m[S/D]\033[0m    {len(mudos)} canales con suscriptor pero SIN tráfico en {dur:.0f}s:")
    for c in mudos: print(f"           · {c}")
    print("           (con mercado cerrado varios son normales — repetir con --dur 300 en rueda)")
else:
    print("  \033[32m[OK]\033[0m     todo canal escuchado tuvo tráfico")
PY
fi
fi

# ════════════════════════════════════════════════════════════
if [ "$RAPIDO" -eq 0 ] && [ -s "$SAMPLE" ]; then
sec "4 · FIRMAS DE BUG ESTRUCTURAL"
# ════════════════════════════════════════════════════════════
python3 - "$SAMPLE" <<'PY'
import sys, json, collections, statistics as st_

sample = sys.argv[1]
msgs = collections.defaultdict(list)
# Mismo delimitador robusto que la sección 3: el payload se acumula hasta el
# próximo 'pmessage'. Un payload multilínea rompía el bloque fijo de 4 y hacía
# que se atribuyeran mensajes al canal equivocado.
state = 0; ch = None; buf = []
def cerrar():
    global ch, buf
    if ch is not None and buf:
        try: msgs[ch].append(json.loads('\n'.join(buf)))
        except Exception: pass
    ch = None; buf = []
for line in open(sample, encoding='utf-8', errors='ignore'):
    line = line.rstrip('\n')
    if line == 'pmessage':
        cerrar(); state = 1; continue
    if state == 1: state = 2; continue
    if state == 2: ch = line; state = 3; continue
    if state == 3: buf.append(line)
cerrar()

def g(d, *ks, default=None):
    for k in ks:
        if isinstance(d, dict) and k in d and d[k] is not None: return d[k]
    dd = d.get('data') if isinstance(d, dict) else None
    if isinstance(dd, dict):
        for k in ks:
            if k in dd and dd[k] is not None: return dd[k]
    return default

OK   = lambda s: print(f"  \033[32m[OK]\033[0m     {s}")
SD   = lambda s: print(f"  \033[33m[S/D]\033[0m    {s}")
BUG  = lambda s: print(f"  \033[35m[BUG]\033[0m    {s}")
ALERT = lambda s: print(f"  \033[31m[ALERTA]\033[0m {s}")
INFO = lambda s: print(f"           {s}")

# ── 4.1 · Redes que publican una CONSTANTE ──────────────────
# Firma del "contrato roto": la red no publica score y class25A usa 0.5 fijo,
# o su salida se contrajo a una constante (trainStep auto-referencial).
print("\n  4.1 · ¿alguna red publica una constante?")
grupos = collections.defaultdict(list)
for c in ('class21_output','class22_output','class23_output','class24_output'):
    for m in msgs.get(c, []):
        s = g(m, 'score', 'confianza')
        if isinstance(s, (int, float)):
            grupos[(c, str(g(m, 'fuente', default='-')))].append(float(s))
if not grupos:
    SD("sin señales de redes en la muestra")
# MUESTRA MÍNIMA = 20, no 3.
# Con n=3 un desvío estándar no distingue una red colapsada de tres lecturas
# parecidas por azar. El 10-sep-2026, con el mercado cerrado y n=3, esta sección
# emitió cuatro [BUG] de redes "casi constantes" que con el mercado abierto
# variaban normalmente. Un [BUG] falso cuesta más que un [S/D]: manda a arreglar
# lo que no está roto.
N_MIN_CONST = 20
# SATURACIÓN (agregado el 18-sep-2026). Una red cuya salida entera queda pegada a
# un borde no opina, aunque su σ no sea cero: el 18-sep class24/mercado contestaba
# entre 0,000 y 0,015 (σ 0,0046) y class23/mercado entre 0,001 y 0,013, para los 13
# instrumentos, y esta sección las daba por [OK] «varía». El daño está en la
# decisión: en z contra una base sin olvido, una red clavada abajo da «baja» para
# todos los instrumentos a la vez (y clavada arriba, «sube»), y arrastra el día
# entero a un solo lado; ese día salió 91 % SELL. Borde de 0,03 y no de 0,02 para
# agarrar también casos como portfolio el 14-sep (ema_inf 0,9926).
SAT_BORDE = 0.03
saturadas = []
for (c, f), vals in sorted(grupos.items()):
    if len(vals) < N_MIN_CONST:
        INFO(f"{c}/{f}: n={len(vals)} (< {N_MIN_CONST}) — muestra insuficiente, no evaluable"); continue
    sd_ = st_.pstdev(vals)
    tag = f"{c}/{f}"
    lo_, hi_ = min(vals), max(vals)
    if sd_ < 1e-9:
        BUG(f"{tag}: CONSTANTE en {vals[0]:.4f} sobre {len(vals)} msgs — contrato roto o red colapsada")
    elif hi_ <= SAT_BORDE or lo_ >= 1 - SAT_BORDE:
        lado = "ABAJO (empuja a SELL)" if hi_ <= SAT_BORDE else "ARRIBA (empuja a BUY)"
        ALERT(f"{tag}: SATURADA {lado} — contesta entre {lo_:.3f} y {hi_:.3f} "
              f"(σ={sd_:.4f}, n={len(vals)})")
        saturadas.append(tag)
    elif sd_ < 0.002:
        BUG(f"{tag}: casi constante (σ={sd_:.5f}, n={len(vals)}) — sospechoso")
    else:
        OK(f"{tag}: varía (σ={sd_:.4f}, n={len(vals)}, rango {min(vals):.3f}-{max(vals):.3f})")
    if abs(st_.mean(vals) - 0.5) < 1e-6 and sd_ < 1e-9:
        INFO("  ↑ exactamente 0.5000 = el DEFAULT silencioso de class25A")
if saturadas:
    INFO(f"↳ {len(saturadas)} red(es) saturada(s): dan el mismo voto para todos los instrumentos,")
    INFO("  así que la mezcla del día se va para un solo lado (mirar BUY/SELL en 4.4). No es una")
    INFO("  rotura: es el síntoma de entrenar en línea persiguiendo el último lote de etiquetas")
    INFO("  contra una base sin olvido. La del 15-sep (class24/mercado en 0,02) salió sola en dos días.")

# ── 4.2 · symbol por fuente (el bug de class18) ─────────────
# class18.cs no lee ni emite symbol, así que portfolio/impacto/cluster llegan
# sin él y class21-24 los rotulan GENERAL. Solo `mercado` (class10) es por
# instrumento → las otras 3 sub-redes votan SOLO en ventanas GENERAL, que son
# la población de etiqueta ABSOLUTA que la tesis excluye.
print("\n  4.2 · ¿el ticker llega a todas las familias de features?")
porf   = collections.defaultdict(set)
cuenta = collections.Counter()
for c in ('class23_output','class24_output'):
    for m in msgs.get(c, []):
        fu = str(g(m, 'fuente', default='-'))
        porf[fu].add(str(g(m, 'symbol', 'ticker', default='GENERAL')))
        cuenta[fu] += 1
if not porf:
    SD("sin salidas de class23/24 en la muestra")
# Mismo criterio que 4.1: sin muestra no hay veredicto. Con el mercado cerrado
# el camino por instrumento se apaga —class7 deja de generar vectores nuevos—
# así que TODAS las familias salen GENERAL. Eso es el horario, no un defecto,
# y reportarlo como [BUG] manda a buscar un problema que aparece solo de noche.
for f, syms in sorted(porf.items()):
    reales = syms - {'GENERAL', 'None', '-', 'class19', 'unknown'}
    if reales:
        OK(f"fuente '{f}': {len(reales)} instrumentos reales ({', '.join(sorted(reales)[:6])}…)")
    elif cuenta[f] < N_MIN_CONST:
        INFO(f"fuente '{f}': solo GENERAL, pero n={cuenta[f]} (< {N_MIN_CONST}) — no evaluable")
    else:
        BUG(f"fuente '{f}': SOLO GENERAL en {cuenta[f]} msgs — nunca vota por instrumento")

# ── 4.3 · Modo común entre instrumentos ─────────────────────
# El bug de class21/22 pre-ORDEN 3: estado global → el mismo número para los
# 13. Este detector verifica que el fix se sostenga.
print("\n  4.3 · ¿algún módulo entrega el MISMO número a instrumentos distintos?")
for c in ('class21_output','class22_output','class23_output','class24_output'):
    porT = collections.defaultdict(list)
    for m in msgs.get(c, []):
        s = g(m, 'score', 'confianza')
        t = str(g(m, 'symbol', 'ticker', default='GENERAL'))
        if isinstance(s, (int, float)) and t not in ('GENERAL','None','-'):
            porT[t].append(round(float(s), 4))
    if len(porT) < 2:
        INFO(f"{c}: {len(porT)} instrumento(s) en la muestra — no evaluable"); continue
    medias = {t: st_.mean(v) for t, v in porT.items()}
    disp = st_.pstdev(list(medias.values()))
    if disp < 1e-6:
        BUG(f"{c}: los {len(medias)} instrumentos reciben EL MISMO valor ({list(medias.values())[0]:.4f}) — modo común")
    elif disp < 0.005:
        BUG(f"{c}: dispersión entre instrumentos casi nula (σ={disp:.5f}) — sospechoso")
    else:
        OK(f"{c}: {len(medias)} instrumentos con valores distintos (σ={disp:.4f})")

# ── 4.4 · La ventana del ensemble ───────────────────────────
print("\n  4.4 · decisiones de class25A")
dec = msgs.get('class25a_output', [])
if not dec:
    SD("sin decisiones en la muestra (con mercado cerrado puede ser normal)")
else:
    señales = collections.Counter(str(g(m, 'senal', default='?')) for m in dec)
    tick    = collections.Counter(str(g(m, 'ticker', 'symbol', default='GENERAL')) for m in dec)
    dist    = [float(g(m, 'distancia_neutro', default=0) or 0) for m in dec]
    INFO(f"n={len(dec)} · señales={dict(señales)}")
    INFO(f"instrumentos={len(tick)} · top: {', '.join(f'{k}={v}' for k,v in tick.most_common(5))}")
    if len(tick) == 1 and 'GENERAL' in tick:
        BUG("TODAS las decisiones son GENERAL — ORDEN 1 no está produciendo por instrumento")
    elif len(tick) >= 5:
        OK(f"{len(tick)} instrumentos distintos deciden — ORDEN 1 activo")
    if dist and st_.pstdev(dist) < 1e-6:
        BUG(f"distancia_neutro constante en {dist[0]:.4f} — el score no se mueve")
    elif dist:
        OK(f"distancia_neutro varía (σ={st_.pstdev(dist):.4f})")

# ── 4.5 · Payloads sin los campos que el consumidor busca ───
# Familia "contrato roto": el publisher cambia el nivel del campo y el
# consumidor cae a su default sin que nadie se entere.
print("\n  4.5 · contratos de payload")
# El contrato es el que LEE class25A, no un nombre de campo elegido acá.
# `class25A.cpp` acepta alias y anidamiento:
#     score  ← j["confianza"] | j["score"] | j["data"][...]
#     ticker ← j["symbol"] | j["ticker"] | j["data"][...]
# Exigir sólo 'score' daba [BUG] en class21/22, que publican `confianza` — un
# falso positivo que estuvo en todos los informes y sobre el que se construyó
# una cadena causal equivocada (10-sep-2026).
#
# `fuente` NO se exige: su ausencia es legítima —la familia '-' es la más
# numerosa y lleva los 13 instrumentos— y class25A la maneja mandando esos
# mensajes a la clave de peso del módulo pelado (`claveEnsemble`).
req = {
    'class21_output': [('score','confianza'), ('symbol','ticker')],
    'class22_output': [('score','confianza'), ('symbol','ticker')],
    'class23_output': [('score','confianza'), ('symbol','ticker')],
    'class24_output': [('score','confianza'), ('symbol','ticker')],
    'class25a_output':[('senal',),            ('ticker','symbol')],
}
for c, campos in req.items():
    ms = msgs.get(c, [])
    if not ms: SD(f"{c}: sin muestra"); continue
    faltan = [alias[0] for alias in campos
              if sum(1 for m in ms if g(m, *alias) is not None) < len(ms)*0.9]
    if faltan: BUG(f"{c}: el campo {faltan} (ni sus alias) falta en >10% de los mensajes")
    else:      OK(f"{c}: contrato completo ({len(ms)} msgs)")
# Informativo, no veredicto: cuántos mensajes llegan sin `fuente` declarada.
for c in ('class23_output','class24_output'):
    ms = msgs.get(c, [])
    if ms:
        sinf = sum(1 for m in ms if g(m,'fuente') is None)
        if sinf: INFO(f"{c}: {sinf}/{len(ms)} sin `fuente` → van a la clave de peso del módulo pelado")
PY
fi

# ════════════════════════════════════════════════════════════
sec "5 · APIs INTERNAS"
# ════════════════════════════════════════════════════════════
# `health` a secas NO existe en el gateway público: class30 expone
# `health-python` (proxy al /api/health del chatbot, que vive en el 5005
# loopback) y `system-health` (lee la key miia:health que escribe class48).
# Pedir /api/health daba 404 en todos los informes — un [ALERTA] permanente que
# no correspondía a ningún problema, y de esos hay que huir: acostumbran a
# ignorar las alertas de verdad.
for ep in health-python system-health backtesting/professional accuracy precios noticias; do
  R=$(curl -s -o /tmp/miia_api.out -w '%{http_code} %{time_total}' --max-time 25 "$API/$ep" 2>/dev/null)
  CODE=${R%% *}; T=${R##* }
  SZ=$(wc -c < /tmp/miia_api.out 2>/dev/null || echo 0)
  if [ "$CODE" = "200" ]; then
    if [ "$SZ" -lt 20 ]; then bug "/$ep → 200 pero payload de ${SZ}B — respuesta vacía disfrazada de OK"
    elif grep -q '"degradado": *true\|"fuente": *"fallback"' /tmp/miia_api.out 2>/dev/null; then
      alert "/$ep → 200 pero DEGRADADO (fallback) — el número no es real"
    else ok "/$ep → 200 en ${T}s (${SZ}B)"; fi
  elif [ "$CODE" = "000" ]; then roto "/$ep → sin respuesta (timeout o conexión)"
  else alert "/$ep → HTTP $CODE"; fi
done
# El traceback del backend: un except silencioso deja el panel en cero y se ve
# igual que "todavía no hay datos".
if [ -f "$ROOT/../miia_chatbot_errores.log" ] || [ -f "$ROOT/MIIA/miia_chatbot_errores.log" ]; then
  EL=$(ls -1 "$ROOT"/MIIA/miia_chatbot_errores.log "$ROOT"/../miia_chatbot_errores.log 2>/dev/null | head -1)
  N=$(grep -c "Traceback" "$EL" 2>/dev/null || echo 0)
  [ "$N" -gt 0 ] && alert "$N tracebacks en $EL — últimos:" && tail -3 "$EL" | sed 's/^/           /' || ok "sin tracebacks del backend"
fi

# ════════════════════════════════════════════════════════════
sec "6 · PROVEEDORES EXTERNOS (inferido — no se consume cuota)"
# ════════════════════════════════════════════════════════════
echo "  frescura de precios (el proxy honesto de si los proveedores andan):"
VP=$(mysql -D "$DB" -N -B -e "
  SELECT CONCAT(ticker,' ',TIMESTAMPDIFF(MINUTE,MAX(ts),NOW()),'min')
  FROM precios WHERE ticker IN
   ('XLK','XLF','XLE','XLV','XLY','XLI','XLB','XLRE','XLU','XLC','ARGT','EWZ','ILF')
  GROUP BY ticker HAVING TIMESTAMPDIFF(MINUTE,MAX(ts),NOW()) > 90;" 2>/tmp/e)
if [ -s /tmp/e ]; then roto "MySQL: $(head -1 /tmp/e)"
elif [ -z "$VP" ]; then ok "los 13 instrumentos con precio de <90 min"
else alert "precios rancios:"; echo "$VP" | tr '\n' ' ' | sed 's/^/           /'; echo; fi

echo "  errores por proveedor (class1 — noticias):"
if [ -f "$L/class1.log" ]; then
  OUT=$(grep -ohE '"tipo":"[a-z]+_(error|enviado)"' "$L/class1.log" | sort | uniq -c | sort -rn | head -8)
  [ -n "$OUT" ] && echo "$OUT" | sed 's/^/           /' || sd "el log existe pero no tiene eventos tipificados"
else roto "falta $L/class1.log"; fi

echo "  cuota de Gemini (429 = el chat cae a plantilla):"
if [ -f "$L/class25B.log" ]; then
  N429=$(grep -ac "429\|quota\|RESOURCE_EXHAUSTED" "$L/class25B.log")
  [ "$N429" -gt 0 ] && alert "$N429 eventos de cuota agotada en el log" || ok "sin agotamiento de cuota registrado"
else sd "sin log de class25B"; fi

grep_chk "$L/class44.log" "val_loss" 3 "LSTM — comparar contra ln(3)=1.0986; igual o mayor = al azar"

# ════════════════════════════════════════════════════════════
sec "7 · LA TESIS — leer EN ESTE ORDEN"
# ════════════════════════════════════════════════════════════
# El JSON va a un ARCHIVO y se pasa por argumento. Con `echo | python3 - <<PY`
# el heredoc ocupa stdin y el pipe se descarta: json.load(sys.stdin) recibía
# vacío y el chequeo reportaba [ROTO] sobre un endpoint que respondía 200.
curl -s --max-time 25 "$API/backtesting/professional" > /tmp/miia_tesis.json
if [ ! -s /tmp/miia_tesis.json ]; then
  roto "el endpoint no respondió — el número NO se pudo leer"
else
  python3 - /tmp/miia_tesis.json <<'PY' || roto "el endpoint devolvió algo que no es JSON"
import sys, json
d = json.load(open(sys.argv[1])); g = lambda k, v=0: d.get(k, v)
n, emin, edge, sig = g('n_efectivo'), g('edge_min_detectable'), g('edge_vs_baseline'), g('edge_significativo')
for k in ('n_efectivo','n_redundancia','edge_min_detectable','base_rate',
          'accuracy_directional','edge_vs_baseline','edge_significativo',
          'verificadas','dias_medidos'):
    print(f"           {k:22s}: {d.get(k,'—')}")
print()
try:
    n, emin, edge = float(n), float(emin), float(edge)
    if n < 30:
        print(f"  \033[33m[S/D]\033[0m    n_efectivo={n:.0f} < 30 — NO hay veredicto. El edge no se lee.")
    elif abs(edge) <= emin:
        print(f"  \033[32m[OK]\033[0m     edge {edge:+.2f} pp DENTRO de la banda de ruido (±{emin}).")
        print("           Lectura correcta: 'sin ventaja demostrable'. NO es una noticia.")
    elif sig:
        print(f"  \033[32m[OK]\033[0m     edge {edge:+.2f} pp SUPERA ±{emin} y da significativo — primer resultado real.")
    else:
        print(f"  \033[33m[S/D]\033[0m    edge {edge:+.2f} pp supera ±{emin} pero el test no da significativo.")
except Exception as e:
    print(f"  \033[31m[ROTO]\033[0m   no se pudo evaluar: {e}")
PY
fi

echo "  poblaciones (relativo y absoluto NUNCA se agregan):"
POB=$(mysql -D "$DB" -N -B -e "
  SELECT COALESCE(label_modo,'(null)'), COUNT(*) FROM cognitive_decisions
  WHERE outcome_real IN ('correcto','incorrecto')
    AND COALESCE(temperatura,'') <> 'shadow' GROUP BY 1;" 2>/dev/null)
[ -n "$POB" ] && echo "$POB" | awk '{printf "           %-12s %s\n",$1,$2}' || sd "sin decisiones verificadas"

echo "  tickers distintos por día (la prueba de ORDEN 1 — debería tender a 13):"
TK=$(mysql -D "$DB" -N -B -e "
  SELECT DATE(ts_decision), COUNT(DISTINCT ticker), COUNT(*) FROM cognitive_decisions
  WHERE label_modo='relativo' AND outcome_real IN ('correcto','incorrecto')
  GROUP BY 1 ORDER BY 1 DESC LIMIT 5;" 2>/dev/null)
[ -n "$TK" ] && echo "$TK" | awk '{printf "           %s tickers=%-3s n=%s\n",$1,$2,$3}' || sd "sin filas relativas verificadas"

# ════════════════════════════════════════════════════════════
sec "8 · APRENDIZAJE"
# ════════════════════════════════════════════════════════════
grep_chk "$L/class24.log" "ema_inf=" 4 "class24 sub-redes (ema_inf = inferencia, ema_tr = entrenamiento)"
grep_chk "$L/class23.log" "norm_n=" 4 "class23 sub-redes"
grep_chk "$L/class21.log" "tickers=" 1 "class21 estado por instrumento (ORDEN 3)"
grep_chk "$L/class22.log" "tickers=" 1 "class22 estado por instrumento (ORDEN 3)"

COB=$(grep -ah "cobertura=" "$L/class24.log" 2>/dev/null | tail -1 | grep -oP 'cobertura=\K[0-9.]+')
if [ -z "$COB" ]; then sd "class24 aún no reporta cobertura (normal en las 48 h post-reinicio)"
elif awk "BEGIN{exit !($COB < 30)}"; then alert "cobertura ${COB}% — el sin_match sigue abierto: las redes casi no entrenan"
else ok "cobertura ${COB}%"; fi

# OJO: class25A.log con A MAYÚSCULA. class25a.log no existe.
grep_chk "$L/class25A.log" "AUTO-NEUTRO" 3 "auto-calibración del neutro"
grep_chk "$L/class25A.log" "Atribución local" 2 "crédito por sub-red (ORDEN 3)"
grep_chk "$L/class25A.log" "Sin snapshot" 2 "fallos de atribución — si es sostenido, el fix de g_snaps no alcanzó"

# Heartbeat de class25A (cada 30 s, `class25A.cpp:1780`): umbral, tasa de emisión,
# decisiones por z y pesos por fuente. Agregado el 16-sep-2026 a pedido de Martín,
# para no tener que pedirlo con un ssh aparte. Sólo lee.
# Sale de un hilo propio: que esté fresco dice que el proceso vive, no que esté
# decidiendo. Eso lo dice `decisiones`, que cuenta desde el último arranque del
# proceso: si baja entre dos lecturas, class25A se reinició.
# spdlog no fuerza la escritura (`miia_common.h:229`, sin flush_on ni flush_every):
# el archivo se escribe por bloques y, con poco tráfico, va minutos atrasado. Medido
# el 16-sep a las 22:49, con el mercado cerrado: 110 s. Por eso la alarma salta a
# los 10 min y no a los 2.
HB=""
for _f in "$L/class25A.log" "$L/class25A.1.log"; do   # spdlog rota a class25A.1.log
  [ -f "$_f" ] && HB="$(grep -ah "emisión=" "$_f" 2>/dev/null | tail -1)"
  [ -n "$HB" ] && break
done
if [ ! -f "$L/class25A.log" ]; then
  roto "heartbeat de class25A — NO EXISTE $L/class25A.log"
elif [ -z "$HB" ]; then
  sd "heartbeat de class25A — sin líneas 'emisión=' en class25A.log ni en class25A.1.log"
else
  HB_TS=$(echo "$HB" | grep -oP '^\[\K[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}')
  HB_EDAD=""
  if [ -n "$HB_TS" ] && HB_EP=$(date -d "$HB_TS" +%s 2>/dev/null); then HB_EDAD=$(( $(date +%s) - HB_EP )); fi
  if [ -z "$HB_EDAD" ]; then sd "heartbeat de class25A — la línea no trae una hora legible"
  elif [ "$HB_EDAD" -gt 600 ]; then alert "heartbeat de class25A de hace ${HB_EDAD} s (sale cada 30 s): el proceso puede estar colgado o muerto"
  else
    ok "heartbeat de class25A (umbral · emisión · z) de hace ${HB_EDAD} s"
    if [ "$HB_EDAD" -gt 60 ]; then info "↳ normal hasta 10 min: el log se escribe por bloques y con poco tráfico va atrasado"; fi
  fi
  echo "$HB" | sed 's/^/           /'
  HB_DEC=$(echo "$HB" | grep -oP 'decisiones=\K[0-9]+')
  HB_UMB=$(echo "$HB" | grep -oP 'umbral=\K[0-9.]+')
  HB_EMI=$(echo "$HB" | grep -oP 'emisión=\K[0-9.]+')
  HB_OBJ=$(echo "$HB" | grep -oP '\(obj \K[0-9.]+')
  HB_ZN=$(echo "$HB" | grep -oP ' z=\K[0-9]+')
  HB_ZT=$(echo "$HB" | grep -oP ' z=[0-9]+/\K[0-9]+')
  awk -v u="$HB_UMB" -v e="$HB_EMI" -v o="$HB_OBJ" -v zn="$HB_ZN" -v zt="$HB_ZT" -v d="$HB_DEC" 'BEGIN{
    # Margen de la banda (`class25A.cpp:1363`): UMBRAL_MIN 0,28, UMBRAL_MAX 0,70,
    # margen máximo 0,20 salvo que CLASS25A_MARGEN_MAX diga otra cosa.
    if (u != "") {
      m = (u - 0.28) / 0.42 * 0.20; if (m < 0.02) m = 0.02; if (m > 0.20) m = 0.20
      printf "           ↳ umbral %s → margen %.3f\n", u, m
    }
    # Zona muerta del control: el objetivo ±5 por ciento relativo (EMISION_BANDA).
    if (e != "" && o != "") {
      lo = o * 0.95; hi = o * 1.05
      if (e + 0 > hi) q = "arriba de la banda: el umbral está subiendo"
      else if (e + 0 < lo) q = "debajo de la banda: el umbral está bajando"
      else q = "dentro de la banda"
      printf "           ↳ emisión %s%% (objetivo %s%%, banda %.2f-%.2f%%): %s\n", e, o, lo, hi, q
      printf "             es la de las últimas 1.000 decisiones: al cierre de la rueda cae de un lado o del otro\n"
    }
    if (zt + 0 > 0) {
      pz = 100 * zn / zt
      nota = (pz < 95) ? " (menos de 95 por ciento: normal en la primera hora después de un reinicio)" : ""
      printf "           ↳ decisión en z: %.1f%% (%s de %s)%s\n", pz, zn, zt, nota
    }
    if (d != "") printf "           ↳ decisiones desde el último arranque de class25A: %s (si baja entre lecturas, se reinició)\n", d
  }'
fi

echo "  pesos del ensemble:"
if [ -f "$S/class25a_pesos.json" ]; then
  python3 - "$S/class25a_pesos.json" "$L/class25A.log" <<'PY'
import json, sys, os
w = json.load(open(sys.argv[1]))
for k, v in sorted(w.items()): print(f"           {k:24s} {v:.4f}")

# ¿La atribución por sub-red CORRIÓ alguna vez? Sin eso, cualquier diferencia
# entre pesos es deriva de renormalización, no crédito aprendido.
# Contar TAMBIÉN en los rotados: class25A rota a los 5 MB y es el módulo más
# ruidoso del sistema. Leyendo sólo el archivo actual, este bloque declaraba
# "NUNCA se logueó" mientras la sección de arriba mostraba atribuciones reales
# del 7-sep — dos veredictos opuestos en el mismo informe (visto el 10-sep-2026).
# Y los de spdlog (`class25A.1.log`…`.3.log`; el .3 es el más viejo): hasta el
# 16-sep-2026 no se leían, y el número era sólo el del archivo actual (~2 h).
# Aun leyéndolos, los logs cubren unas horas: el número NO es un acumulado. Por eso
# se informa la ventana que cubren y la tasa por hora.
import glob, gzip, re, datetime as _dt
_base = sys.argv[2]
_arch = (sorted(glob.glob(_base + '.*'), reverse=True)
         + sorted(glob.glob(_base[:-len('.log')] + '.[0-9].log'), reverse=True)
         + [_base])
atrib, desde = 0, None
for _p in _arch:
    try:
        _op = gzip.open if _p.endswith('.gz') else open
        with _op(_p, 'rt', errors='ignore') as f:
            for l in f:
                if desde is None:
                    _m = re.match(r'\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})', l)
                    if _m: desde = _dt.datetime.fromisoformat(_m.group(1) + ' ' + _m.group(2))
                if 'Atribución local' in l: atrib += 1
    except Exception: pass
horas = (_dt.datetime.now() - desde).total_seconds() / 3600 if desde else 0
cubre = (f"en las últimas {horas:.1f} h ({atrib / horas:.{0 if atrib / horas >= 10 else 1}f} por hora; es lo que cubren "
         f"los logs de class25A, no un acumulado)") if horas > 0 else "(los logs no traen hora legible)"

# Pistas de que la diferencia es ARTEFACTO y no aprendizaje:
#  · valores por debajo del piso de clamp (0.10) solo salen de renormalizar
#  · un peso en ~0 es una red que nunca recibe crédito (p.ej. class44 en sombra)
bajo_piso = sorted(k for k, v in w.items() if 0 < v < 0.10)
en_cero   = sorted(k for k, v in w.items() if v < 0.0005)

if len({round(v, 4) for v in w.values()}) == 1:
    print("  \033[33m[S/D]\033[0m    todos idénticos — el crédito por sub-red no se movió")
elif atrib == 0:
    # Ya no es [BUG]: con la capa 2 (desde el 11-sep) un fin de semana entero puede
    # pasar sin verificaciones con snapshot (medido del 12 al 14-sep), y los logs
    # cubren horas.
    print(f"  \033[33m[S/D]\033[0m    ninguna 'Atribución local' {cubre}")
    print("           si sigue así más de un día hábil, el crédito no está llegando a la capa 2")
else:
    print(f"  \033[32m[OK]\033[0m     pesos diferenciados: {atrib} atribuciones reales {cubre}")
if bajo_piso:
    print(f"           ↳ por debajo del piso de clamp 0.10 (solo posible renormalizando): {', '.join(bajo_piso)}")
if en_cero:
    print(f"  \033[33m[S/D]\033[0m    peso ≈0 en {', '.join(en_cero)} — si se enciende, entra sin voz")
PY
else roto "falta $S/class25a_pesos.json"; fi

# ════════════════════════════════════════════════════════════
sec "9 · VERIFICACIÓN"
# ════════════════════════════════════════════════════════════
grep_chk "$L/class43.log" "Reconciliación DB" 3 "ciclo de reconciliación (cada 15 min)"
# DOS números, no uno. El total cuenta también las HOLD, que class43 NO rastrea
# ni verifica (class43.js:945): quedan pendiente PARA SIEMPRE y el total nunca
# puede bajar de ese piso — un criterio tipo "menos de 5.000" es inalcanzable por
# construcción. La serie histórica (18.288 → 23.146 → 21.161) se midió con el
# total, así que se sigue imprimiendo para que siga siendo comparable. Lo que
# drena de verdad es la cola BUY/SELL: la misma que muestra el panel (class43.js:948).
P=$(mysql -D "$DB" -N -B -e "SELECT COUNT(*) FROM cognitive_decisions WHERE outcome_real='pendiente';" 2>/dev/null)
PBS=$(mysql -D "$DB" -N -B -e "SELECT COUNT(*) FROM cognitive_decisions WHERE outcome_real='pendiente' AND senal IN ('BUY','SELL');" 2>/dev/null)
# Vencidas vs en vuelo: con ~5.000 BUY/SELL por día y horizonte de 48 h, hay ~10.000
# en vuelo POR DISEÑO. Un total de 13.000 no dice si la cola está al día o trabada;
# esto sí. Si VENC ≈ 0, la reconciliación está al día aunque el total sea alto.
VENC=$(mysql -D "$DB" -N -B -e "SELECT COUNT(*) FROM cognitive_decisions WHERE outcome_real='pendiente' AND senal IN ('BUY','SELL') AND ts_decision + INTERVAL COALESCE(horizonte_horas,48) HOUR <= NOW();" 2>/dev/null)
DS=$(mysql -D "$DB" -N -B -e "SELECT COUNT(*) FROM cognitive_decisions WHERE outcome_real='descartado' AND ts_decision > NOW()-INTERVAL 7 DAY;" 2>/dev/null)
if [ -n "$P" ]; then
  info "pendientes BUY/SELL=${PBS:-?}  ← la cola que drena (la misma del panel)"
  info "  de ésas, YA VENCIDAS=${VENC:-?} — lo que debería estar verificado; el resto está en vuelo, no atrasado"
  [ "${VENC:-0}" -gt 2000 ] && alert "cola trabada: ${VENC} vencidas sin verificar — la reconciliación toma 500 por ciclo en orden ASC (class42.js:716); si la cabeza no se resuelve, no avanza"
  info "pendientes total=$P (incluye $(( P - ${PBS:-0} )) HOLD que nunca se verifican — serie histórica) · descartados 7d=$DS"
  [ "${PBS:-0}" -gt 40000 ] && alert "backlog alto — verificar que la reconciliación drene"
else roto "no se pudo consultar pendientes"; fi


# ════════════════════════════════════════════════════════════════
# BLOQUE AGREGADO EL 26-sep-2026 — pegable tal cual en /root/miia_check.sh
# Va ANTES del banner final. No depende de nada de las otras secciones salvo
# de los helpers (sec/ok/info/alert/sd/roto) y de $L (carpeta de logs).
# ════════════════════════════════════════════════════════════════
sec "10 · VOTANTES NUEVOS — class40 · class41 · class27"

# POR QUÉ ESTA SECCIÓN: hasta el 26-sep los tres estaban muertos o en sombra, y
# el chequeo no los distinguía de "no hay dato". Ahora cada uno tiene su
# interruptor y esta sección dice, por separado, si están encendidos y CUÁNTO
# aportan — que es distinto de si el proceso vive.
#
# class25A escribe una línea con prefijo fijo `votantes:` en cada heartbeat.
VOT=""
for _f in "$L/class25A.log" "$L/class25A.1.log" "$L/class25A.2.log"; do
  [ -f "$_f" ] && VOT="$(grep -ah "votantes:" "$_f" 2>/dev/null | tail -1)"
  [ -n "$VOT" ] && break
done

if [ ! -f "$L/class25A.log" ]; then
  roto "votantes — NO EXISTE $L/class25A.log"
elif [ -z "$VOT" ]; then
  sd "votantes — sin línea 'votantes:' (binario anterior al 12-oct, o aún sin heartbeat)"
else
  echo "$VOT" | sed 's/^/           /'
  V_MODO=$(echo "$VOT" | grep -oP 'modo_votante=\K[A-Za-z]+')
  V_MK=$(echo "$VOT"   | grep -oP 'modo_meta_k=\K[A-Za-z]+')
  V40=$(echo "$VOT"    | grep -oP 'class40=\K[0-9]+')
  V41=$(echo "$VOT"    | grep -oP 'class41=\K[0-9]+')
  VS40=$(echo "$VOT"   | grep -oP 'sin_ticker40=\K[0-9]+')
  VS41=$(echo "$VOT"   | grep -oP 'sin_ticker41=\K[0-9]+')
  VMK=$(echo "$VOT"    | grep -oP 'meta_k_recortes=\K[0-9]+')

  # ── class40 + class41 como votantes ──────────────────────────
  if [ "${V_MODO:-off}" != "ACTIVO" ]; then
    info "class40/class41: votantes APAGADOS (CLASS25A_VOTANTE_CRISIS=1 los enciende)"
    info "  ↳ es lo esperado hasta que se decida encenderlos: hoy sólo alimentan"
    info "    la capa de crisis, y el ranking no lee esa rama"
  else
    ok "class40/class41: votantes ACTIVOS"
    info "  aportes desde el arranque: class40=${V40:-0}  class41=${V41:-0}"
    # Encendido y sin aportes = el par no está llegando. Es el modo de fallar
    # silencioso: no hay error, simplemente nunca entran al ensamble.
    if [ "${V40:-0}" -eq 0 ] && [ "${V41:-0}" -eq 0 ]; then
      alert "encendidos pero con CERO aportes — el par no está llegando a class25A."
      alert "  revisar en orden: (1) CLASS40_ACTIVO/CLASS41_ACTIVO en el motor .NET,"
      alert "  (2) que class9 publique class40_ingest, (3) que el .NET se haya recompilado"
    elif [ "${V40:-0}" -eq 0 ]; then
      alert "class41 aporta pero class40 NO: sin pronóstico, class41 se queda sin entrada"
    elif [ "${V41:-0}" -eq 0 ]; then
      info "class40 aporta y class41 todavía no — normal en los primeros minutos"
    fi
    # Relación entre los dos: class41 se alimenta de class40, así que no puede
    # aportar mucho más que él. Si lo hace, algo más está publicando ahí.
    if [ "${V40:-0}" -gt 0 ] && [ "${V41:-0}" -gt $(( ${V40:-0} * 2 )) ]; then
      alert "class41 aporta más del doble que class40 — ¿otro productor en class41_output?"
    fi
  fi

  # ── El contrato del ticker ───────────────────────────────────
  # Mismo criterio que `sin_ticker` de class23/24: si sube, el mensaje dejó de
  # traer instrumento y el aporte al ranking se apaga EN SILENCIO, porque un
  # pronóstico sin ticker no puede mover un puesto.
  if [ "${VS40:-0}" -gt 0 ] || [ "${VS41:-0}" -gt 0 ]; then
    alert "mensajes SIN ticker: class40=${VS40:-0} class41=${VS41:-0} — se descartan."
    alert "  el contrato se rompió: sin instrumento no hay aporte transversal posible"
  else
    ok "contrato del ticker: 0 mensajes sin instrumento en los dos"
  fi

  # ── class27 sobre k ──────────────────────────────────────────
  # class27 NO puede cambiar QUIÉN sale BUY/SELL: su factor es global y un
  # ranking es invariante a escala. Lo que cambia es CUÁNTOS.
  if [ "${V_MK:-off}" != "ACTIVO" ]; then
    info "class27 sobre k: apagado (CLASS25A_META_K=1) — k fijo, emisión estructural"
  else
    ok "class27 sobre k: ACTIVO — ${VMK:-0} recortes de k desde el arranque"
    if [ "${VMK:-0}" -eq 0 ]; then
      info "  ↳ 0 recortes = class27 no detectó sobreconfianza ni caída de calidad."
      info "    Es lo normal: sólo recorta cuando el razonamiento se degrada"
    else
      info "  ↳ cada recorte bajó k, o sea que MIIA emitió MENOS señales, no otras."
      info "    Contrastar con la emisión del heartbeat: tiene que verse más baja"
    fi
  fi
fi

# El k efectivo se lee de la línea `ranking:`, que ya existe. Verlo al lado del
# contador de recortes es lo que permite decir si class27 está teniendo efecto.
RK="$(grep -ah "ranking: buy=" "$L/class25A.log" 2>/dev/null | tail -1)"
[ -n "$RK" ] && echo "$RK" | sed 's/^/           /'

echo
echo "════════════════════════════════════════════════════════════════"
echo "  [OK] hay dato · [S/D] no hay dato aún · [ROTO] el chequeo falló"
echo "  [BUG] firma de defecto estructural · [ALERTA] hay dato y es malo"
echo
echo "  · [S/D] y [ROTO] NO son lo mismo. Esa distinción es el punto."
echo "  · La tesis se lee: n_efectivo → edge_min → significativo → edge."
echo "  · Con mercado cerrado, repetir con --dur 300 antes de creerle a un [BUG]."
echo "════════════════════════════════════════════════════════════════"
