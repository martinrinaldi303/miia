#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sim30 — la rotación de predicciones del LSTM, con el universo en 50.

    python docs/simulaciones/sim30_rotacion_lstm.py

Qué valida, y por qué cada cosa:

  1. La rotación cubre a TODOS en una ronda. Si no, hay tickers que nunca se
     predicen y el panel los muestra en blanco para siempre.
  2. Nadie se queda con la cabeza de la cola. Es el bloqueo que la consulta de
     pendientes de class42 tenía con las decisiones de 48 h: un ticker que falla
     siempre no puede dejar a los otros 49 sin predecir.
  3. Apagada (`CLASS44_PRED_POR_CICLO=0`) devuelve la lista entera, o sea el
     camino de antes bit a bit. Toda reversa del proyecto se prueba así.
  4. La cuenta de descargas a Yahoo, que es el recurso que de verdad se gasta —
     en código, para que no se separe del comentario.
  5. Guardas de regresión sobre class44.py: que la rotación siga enchufada y que
     `_TRAIN_GATE` siga serializando (todo el argumento de "no hay 37 descargas
     simultáneas al arrancar" se apoya en ese semáforo).
  6. Que las tres copias del universo digan lo mismo sobre la lista `lstm`.
     sim10 compara `instrumentos`, no ésta: editar el JSON y olvidarse de
     `regenerar_respaldos_universo.py` es justo el drift que nadie vería.

No importa class44.py: eso arrastra torch, yfinance y redis, que no están en la
máquina de Martín. Por eso la aritmética vive en MIIA/rotacion.py, aparte.
"""
import io
import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "MIIA"))

from rotacion import proximo_lote, ciclos_por_ronda, descargas_por_dia  # noqa: E402

# La consola de Windows arranca en cp1252 y un caracter que no este en esa
# codepage tira UnicodeEncodeError EN EL PRINT, o sea que la prueba "falla" por
# el idioma de la terminal y no por el codigo. probar.ps1 pone la consola en
# UTF-8; corrido a mano no, asi que el script no depende de eso.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_ok = 0
_falla = 0


def chequear(nombre, cond, nota=""):
    global _ok, _falla
    if cond:
        _ok += 1
        print("   [ok]    %-58s %s" % (nombre, nota))
    else:
        _falla += 1
        print("   [FALLA] %-58s %s" % (nombre, nota))


def seccion(t):
    print("\n%s" % t)


PRED_INTERVAL = 15 * 60          # el de class44.py
K = 13                           # el default de CLASS44_PRED_POR_CICLO
U50 = ["T%02d" % i for i in range(50)]

# ── 1 ───────────────────────────────────────────────────────────────────────
seccion("1 · La rotación reparte y cubre a todos")

ronda = ciclos_por_ronda(len(U50), K)
chequear("una ronda de 50 con 13 por ciclo son 4 ciclos", ronda == 4, "ronda=%d" % ronda)

veces = {}
for c in range(ronda):
    lote = proximo_lote(U50, K, veces)
    chequear("el ciclo %d trae exactamente 13" % (c + 1), len(lote) == K, "%d" % len(lote))
    chequear("  y sin repetidos dentro del ciclo", len(set(lote)) == len(lote))
    for t in lote:
        veces[t] = veces.get(t, 0) + 1

sin_predecir = [t for t in U50 if veces.get(t, 0) == 0]
chequear("tras una ronda, los 50 se intentaron al menos una vez",
         not sin_predecir, "sin predecir: %d" % len(sin_predecir))

# Muchas rondas: el reparto tiene que quedar parejo, no favorecer a los primeros.
# Esta es la propiedad que la primera version NO tenia (min=10 max=14 en 40
# ciclos, porque ordenaba por la hora del ultimo intento y los empates los
# rompia la posicion en la lista).
veces = {}
for c in range(40):
    for t in proximo_lote(U50, K, veces):
        veces[t] = veces.get(t, 0) + 1
peor = max(veces[t] for t in U50) - min(veces[t] for t in U50)
chequear("en 40 ciclos nadie queda relegado", peor <= 1,
         "min=%d max=%d" % (min(veces[t] for t in U50), max(veces[t] for t in U50)))

# La garantia vale para cualquier cantidad de ciclos, no solo 40.
for n_ciclos in (1, 7, 23, 100, 313):
    v = {}
    for _ in range(n_ciclos):
        for t in proximo_lote(U50, K, v):
            v[t] = v.get(t, 0) + 1
    d = max(v.get(t, 0) for t in U50) - min(v.get(t, 0) for t in U50)
    chequear("  en %d ciclos la diferencia sigue en 1 o menos" % n_ciclos, d <= 1,
             "diferencia %d" % d)

chequear("el reparto es determinista (mismo estado, mismo lote)",
         proximo_lote(U50, K, veces) == proximo_lote(U50, K, veces))

chequear("un ticker nuevo va primero",
         "NUEVO" in proximo_lote(U50 + ["NUEVO"], K, dict(veces)),
         "entra sin esperar la ronda")

# ── 2 ───────────────────────────────────────────────────────────────────────
seccion("2 · Nadie se queda con la cabeza de la cola")

# "T00" falla siempre. Se cuenta el INTENTO, así que avanza igual.
veces = {}
for c in range(12):
    for t in proximo_lote(U50, K, veces):
        veces[t] = veces.get(t, 0) + 1   # el intento, falle o no
chequear("el que falla siempre no acapara",
         veces["T00"] <= max(veces[t] for t in U50),
         "T00 se intentó %d veces, el máximo es %d"
         % (veces["T00"], max(veces[t] for t in U50)))
chequear("y los demás siguen prediciéndose",
         min(veces[t] for t in U50) >= 3,
         "el que menos, %d veces en 12 ciclos" % min(veces[t] for t in U50))

# El contraejemplo, corrido: si se contara el ÉXITO, T00 se queda en 0 para
# siempre y sale en TODOS los ciclos, robandole el lugar a otro cada vez.
v_exito, salio = {}, 0
for c in range(12):
    lote = proximo_lote(U50, K, v_exito)
    if "T00" in lote:
        salio += 1
    for t in lote:
        if t != "T00":                   # T00 falla => no se cuenta
            v_exito[t] = v_exito.get(t, 0) + 1
nunca = sum(1 for t in U50 if v_exito.get(t, 0) == 0 and t != "T00")
chequear("contando el éxito, T00 saldría en los 12 ciclos", salio == 12,
         "salió %d de 12, y dejaría a %d sin predecir nunca" % (salio, nunca))

# ── 3 ───────────────────────────────────────────────────────────────────────
seccion("3 · Apagada = el camino de antes, exacto")

chequear("k=0 devuelve la lista entera", proximo_lote(U50, 0, {}) == U50)
chequear("k negativo también", proximo_lote(U50, -1, {}) == U50)
chequear("k >= n devuelve la lista entera, en su orden",
         proximo_lote(U50, 50, {}) == U50 and proximo_lote(U50, 99, {}) == U50)
chequear("con 13 tickers y el default 13 no hay rotación",
         proximo_lote(U50[:13], K, {}) == U50[:13], "es el comportamiento de hoy")
chequear("una lista vacía no explota", proximo_lote([], K, {}) == [])

# ── 4 ───────────────────────────────────────────────────────────────────────
seccion("4 · La cuenta de descargas a Yahoo")

hoy13 = descargas_por_dia(13, K, PRED_INTERVAL)
c50_rot = descargas_por_dia(50, K, PRED_INTERVAL)
c50_sin = descargas_por_dia(50, 0, PRED_INTERVAL)
chequear("13 tickers hoy: 1.248/día", hoy13 == 1248, "%d" % hoy13)
chequear("50 SIN rotar: 4.800/día", c50_sin == 4800, "%d  <- el problema" % c50_sin)
chequear("50 CON rotación: lo mismo que 13 hoy", c50_rot == hoy13,
         "%d = %d" % (c50_rot, hoy13))
peor_sin = 50 * 30 / 60.0
peor_rot = K * 30 / 60.0
chequear("y el ciclo serial entra en el intervalo de 15 min",
         peor_rot < 15 <= peor_sin,
         "peor caso %.1f min con rotación, %.1f min sin ella" % (peor_rot, peor_sin))
chequear("cada ticker se predice 1 vez por hora",
         ciclos_por_ronda(50, K) * (PRED_INTERVAL / 3600.0) == 1.0,
         "4 ciclos x 15 min")

# ── 5 ───────────────────────────────────────────────────────────────────────
seccion("5 · Guardas de regresión sobre class44.py")

c44 = io.open(RAIZ / "MIIA" / "class44.py", encoding="utf-8").read()
chequear("class44 importa la rotación", "from rotacion import proximo_lote" in c44)
chequear("PRED_POR_CICLO sale del entorno",
         'os.getenv("CLASS44_PRED_POR_CICLO"' in c44)
chequear("el ciclo de predicción usa el lote, no `motores`",
         "for m in ciclo:" in c44 and "proximo_lote([m.ticker for m in listos]" in c44)
chequear("y el intento se cuenta antes de predecir",
         "intentos[t] = intentos.get(t, 0) + 1" in c44)
chequear("_TRAIN_GATE sigue serializando el entrenamiento",
         "_TRAIN_GATE = threading.Semaphore(1)" in c44,
         "sin esto habría 37 descargas simultáneas al arrancar")
i_flag = c44.find("self._training = True")
i_gate = c44.find("_TRAIN_GATE.acquire()")
chequear("_training se marca ANTES del acquire",
         0 < i_flag < i_gate,
         "los que esperan turno quedan fuera del ciclo")
chequear("sigue bajando de Yahoo en cada predicción",
         "self._descargar(periodo=PERIODO_PRED" in c44,
         "si alguien agrega caché, la cuenta de arriba cambia")

# ── 6 ───────────────────────────────────────────────────────────────────────
seccion("6 · Las tres copias del universo, sobre la lista `lstm`")

d = json.loads(io.open(RAIZ / "operador" / "aprendizaje" / "config" / "universo.json",
                       encoding="utf-8").read())
lstm_json = list(d["lstm"])
instr = [i["ticker"] for i in d["instrumentos"]]

import universo as upy  # noqa: E402
lstm_py = list(upy._RESPALDO["lstm"])

js = io.open(RAIZ / "scripts" / "universo.js", encoding="utf-8").read()
m = re.search(r"\n  lstm: \[(.*?)\]", js, re.S)
lstm_js = re.findall(r'"([A-Z]+)"', m.group(1)) if m else []

chequear("el respaldo de universo.py coincide con el JSON", lstm_py == lstm_json,
         "%d vs %d" % (len(lstm_py), len(lstm_json)))
chequear("el respaldo de universo.js coincide con el JSON", lstm_js == lstm_json,
         "%d vs %d" % (len(lstm_js), len(lstm_json)))
chequear("y lo que exporta el loader es esa lista",
         list(upy.TICKERS_LSTM) == lstm_json, "%d con LSTM" % len(upy.TICKERS_LSTM))
chequear("todos los del LSTM están en el universo",
         all(t in instr for t in lstm_json))
if len(lstm_json) == len(instr):
    chequear("el LSTM cubre el universo entero, sin asimetría",
             True, "%d de %d" % (len(lstm_json), len(instr)))
else:
    chequear("asimetría: hay instrumentos sin LSTM",
             "esta asimetría invalida la comparación" in c44,
             "%d de %d, y class44 lo avisa al arrancar" % (len(lstm_json), len(instr)))

# ── Resumen ────────────────────────────────────────────────────────────────
print("\n%s" % ("PASA" if _falla == 0 else "FALLA"),
      "— rotación del LSTM  (%d checks, %d fallas)" % (_ok + _falla, _falla))
sys.exit(1 if _falla else 0)
