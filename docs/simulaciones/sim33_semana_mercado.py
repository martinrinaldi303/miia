# -*- coding: utf-8 -*-
"""sim33 — la tira semanal del panel de Régimen, con el código REAL.

No reimplementa nada: extrae `_semana_mercado` del fuente de `miia_chatbot.py`
y lo ejecuta contra series de cierres armadas a mano. Importar el módulo entero
arrastraría FastAPI, aioredis y el driver de MySQL —ninguno hace falta para
probar una aritmética— así que se saca la función sola, que es el mismo criterio
con el que `sim7` incluye los .cpp de producción.

    python docs/simulaciones/sim33_semana_mercado.py
"""
import asyncio, io, os, re, sys
from datetime import datetime

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FUENTE = os.path.join(RAIZ, "MIIA", "miia_chatbot.py")

ok = fallas = 0
def chequear(nombre, cond, nota=""):
    global ok, fallas
    if cond: ok += 1;     print("   [ok]    %-52s %s" % (nombre, nota))
    else:    fallas += 1; print("   [FALLA] %-52s %s" % (nombre, nota))

def seccion(t): print("\n%s" % t)

# ── extraer la función real ────────────────────────────────────────────────
src = io.open(FUENTE, encoding="utf-8").read()
m = re.search(r"^async def _semana_mercado\(.*?(?=^async def |^def |^@app\.)", src, re.S | re.M)
if not m:
    print("   [FALLA] no encontre _semana_mercado en miia_chatbot.py"); sys.exit(1)

_series = {}
async def _cierres_diarios():          # el doble: devuelve lo que le pongamos
    return _series
class _Log:
    def warning(self, *a, **k): pass
log = _Log()

ns = {"_cierres_diarios": _cierres_diarios, "log": log}
exec(compile(m.group(0), "miia_chatbot.py:_semana_mercado", "exec"), ns)
semana_mercado = ns["_semana_mercado"]

def correr(series, **kw):
    global _series
    _series = series
    return asyncio.run(semana_mercado(**kw))

def d(s): return datetime.strptime(s, "%Y-%m-%d")

# ── 1 ──────────────────────────────────────────────────────────────────────
seccion("1 · El promedio es de RETORNOS, no de precios")
# XLK caro sube 1 %, ILF barato baja 1 %, XLV queda plano. Equiponderado da 0;
# un indice de PRECIOS daria +0,55 %, porque XLK pesa 200 e ILF 35.
r = correr({
    "XLK": [(d("2026-10-05"), 200.0), (d("2026-10-06"), 202.0)],
    "ILF": [(d("2026-10-05"),  35.0), (d("2026-10-06"),  34.65)],
    "XLV": [(d("2026-10-05"), 170.0), (d("2026-10-06"), 170.0)],
})
chequear("el caro y el barato se cancelan", len(r) == 1 and abs(r[0]["cambio_pct"]) < 0.001,
         "con un indice de PRECIOS mandaria el caro: es el defecto 5")
chequear("cuenta los que suben", r[0]["suben"] == 1 and r[0]["n"] == 3)
chequear("menos de 3 instrumentos no es una sesion publicable",
         correr({"A": [(d("2026-10-05"), 10.0), (d("2026-10-06"), 11.0)],
                 "B": [(d("2026-10-05"), 10.0), (d("2026-10-06"),  9.0)]}) == [],
         "una seccion transversal de 2 no dice nada del mercado")

# ── 2 ──────────────────────────────────────────────────────────────────────
seccion("2 · Los dias SIN RUEDA no se cuentan")
base = {t: [(d("2026-10-09"), 100.0), (d("2026-10-10"), 101.0),
            (d("2026-10-11"), 101.0), (d("2026-10-12"), 101.0)]
        for t in ("A", "B", "C", "D")}
r = correr(base)
chequear("el sabado y el domingo quedan afuera", len(r) == 1 and r[0]["fecha"] == "2026-10-10",
         "precios tiene filas igual: lo que no cambia es el precio")

# ── 3 ──────────────────────────────────────────────────────────────────────
seccion("3 · Un instrumento al que le falta un dia no contamina")
r = correr({
    "A": [(d("2026-10-05"), 100.0), (d("2026-10-06"), 102.0)],
    "B": [(d("2026-10-05"), 100.0), (d("2026-10-06"), 104.0)],
    "C": [(d("2026-10-05"), 100.0), (d("2026-10-06"), 100.6)],
    # D sin el 05: su cambio del 06 no se puede calcular y se saltea
    "D": [(d("2026-10-06"), 999.0), (d("2026-10-07"), 1200.0)],
})
chequear("el dia 06 promedia solo A, B y C", any(x["fecha"] == "2026-10-06" and x["n"] == 3 for x in r))
chequear("y da 2,2 %", any(x["fecha"] == "2026-10-06" and abs(x["cambio_pct"] - 2.2) < 0.01 for x in r))
chequear("el 07, con un solo instrumento, no se publica",
         not any(x["fecha"] == "2026-10-07" for x in r), "menos de 3 no es una seccion transversal")

# ── 4 ──────────────────────────────────────────────────────────────────────
seccion("4 · El tope de sesiones y los bordes")
muchos = {t: [(datetime(2026, 9, 1 + i), 100.0 + i * (1 + hash(t) % 3)) for i in range(25)]
          for t in ("A", "B", "C", "D", "E")}
r = correr(muchos)
chequear("devuelve 7 sesiones por defecto", len(r) == 7)
chequear("y son las ULTIMAS", r[-1]["fecha"] == "2026-09-25")
chequear("sesiones=3 devuelve 3", len(correr(muchos, sesiones=3)) == 3)
chequear("pide 999 y queda topeado en 30", len(correr(muchos, sesiones=999)) <= 30)
chequear("sin datos devuelve lista vacia", correr({}) == [])
chequear("un precio en 0 no tira ZeroDivision",
         correr({"A": [(d("2026-10-05"), 0.0), (d("2026-10-06"), 10.0)],
                 "B": [(d("2026-10-05"), 10.0), (d("2026-10-06"), 11.0)],
                 "C": [(d("2026-10-05"), 10.0), (d("2026-10-06"), 11.0)]}) is not None)

# ── 5 ──────────────────────────────────────────────────────────────────────
seccion("5 · Guardas de regresion sobre el endpoint y la pagina")
chequear("el campo viaja DENTRO de /api/precios", '"semana": await _semana_mercado()' in src,
         "una ruta nueva daria 404: el ruteo de class30 es una lista explicita")
chequear("reusa _cierres_diarios y no otra consulta a precios",
         "await _cierres_diarios()" in m.group(0) and "SELECT" not in m.group(0),
         "precondicion 2 del corte: nada sin GROUP BY sobre precios")
html = io.open(os.path.join(RAIZ, "scripts", "publi_src", "index.html"), encoding="utf-8").read()
chequear("la pagina la dibuja", "function renderSemanaMercado" in html and "renderSemanaMercado(d.semana)" in html)
chequear("la tabla de Markets ya no esta topeada en 13",
         "const tableHtml = sectors.map(s => {" in html and "sectors.slice(0, 13)" not in html,
         "class7 publica los 50 y el Python los reenvia enteros")
chequear("el sidebar elige por movimiento, no por orden del JSON",
         "_mov(y) - _mov(x)).slice(0, 13)" in html,
         "los primeros 13 dejaban afuera a ARGT, EWZ e ILF")

print("\n%s — semana de mercado  (%d ok, %d fallas)\n"
      % ("PASA" if fallas == 0 else "FALLA", ok, fallas))
sys.exit(1 if fallas else 0)
