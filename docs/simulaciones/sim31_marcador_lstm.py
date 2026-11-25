#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sim31 — el marcador por ticker del LSTM: ¿este modelo le gana al promedio?

    python docs/simulaciones/sim31_marcador_lstm.py

Lo pidió Martín el 10-oct-2026: que el esfuerzo se concentre en los modelos que
le ganan al promedio. Esta prueba cubre las dos mitades del pedido:

  · que el número EXISTA y esté bien calculado (secciones 1 a 5), y
  · que se use donde no contamina la medición (sección 7): la prioridad va al
    ENTRENAMIENTO, y la rotación de predicciones sigue siendo pareja.

La sección 3 es la que importa de verdad: un modelo puede tener **100 % de
acierto y cero ventaja**. Es la lección de la tesis puesta en una prueba.
"""
import io
import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "MIIA"))

from marcador import Marcador  # noqa: E402

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
H = 3600_000.0          # una hora en ms


def chequear(nombre, cond, nota=""):
    global _ok, _falla
    if cond:
        _ok += 1
        print("   [ok]    %-56s %s" % (nombre, nota))
    else:
        _falla += 1
        print("   [FALLA] %-56s %s" % (nombre, nota))


def seccion(t):
    print("\n%s" % t)


# ── 1 ───────────────────────────────────────────────────────────────────────
seccion("1 · Puntuar una señal contra el promedio")

m = Marcador(min_n=5)
m.predijo("XLK", "BUY", 1000 * H)
chequear("BUY y el instrumento le ganó al promedio -> ok",
         m.outcome("XLK", 1, 1001 * H) == "ok")
m.predijo("XLK", "BUY", 1002 * H)
chequear("BUY y no le ganó -> err", m.outcome("XLK", 0, 1003 * H) == "err")
m.predijo("XLE", "SELL", 1000 * H)
chequear("SELL y no le ganó -> ok", m.outcome("XLE", 0, 1001 * H) == "ok")
m.predijo("XLE", "SELL", 1002 * H)
chequear("SELL y le ganó -> err", m.outcome("XLE", 1, 1003 * H) == "err")
chequear("el outcome llega como texto y también sirve",
         (lambda mm: (mm.predijo("XLF", "BUY", 1000 * H),
                      mm.outcome("XLF", "1", 1001 * H))[1])(Marcador()) == "ok",
         "class43 publica JSON, el tipo no está garantizado")

# ── 2 ───────────────────────────────────────────────────────────────────────
seccion("2 · Lo que NO se puntea, y se cuenta")

m2 = Marcador()
m2.predijo("XLK", "BUY", 1000 * H)
chequear("una etiqueta `absoluto` se descarta",
         m2.outcome("XLK", 1, 1001 * H, "absoluto") == "absoluto",
         "es la dirección del mercado, no 'le gana al promedio'")
chequear("  y queda contado, no en silencio", m2.descartes["absoluto"] == 1)

m2.predijo("XLU", "HOLD", 1000 * H)
chequear("un HOLD no acierta ni falla (defecto 4)",
         m2.outcome("XLU", 1, 1001 * H) == "hold")
chequear("  y queda contado", m2.descartes["hold"] == 1)

chequear("un outcome sin predicción previa se descarta",
         m2.outcome("EWZ", 1, 1001 * H) == "sin_prediccion")
m2.predijo("ILF", "BUY", 1000 * H)
chequear("una predicción POSTERIOR a la decisión no cuenta",
         m2.outcome("ILF", 1, 999 * H) == "sin_prediccion",
         "no se puede acreditar lo que todavía no se había dicho")
chequear("una predicción más vieja que la ventana se descarta",
         m2.outcome("ILF", 1, (1000 + 80) * H) == "vieja", "ventana de 72 h")
m2.predijo("XLV", "BUY", 1000 * H)
chequear("un outcome que no se puede interpretar se descarta",
         m2.outcome("XLV", "mas o menos", 1001 * H) == "malo")
chequear("el marcador de XLK sigue limpio tras todo eso",
         m2.stats("XLK")["n"] == 0, "los descartes no inflan la muestra")

# ── 3 ───────────────────────────────────────────────────────────────────────
seccion("3 · 100 % de acierto y CERO ventaja (la lección de la tesis)")

m3 = Marcador(min_n=5)
for i in range(40):                       # el instrumento le gana al promedio
    m3.predijo("GANA", "BUY", (i * 10) * H)       # siempre, y el modelo dice BUY
    m3.outcome("GANA", 1, (i * 10 + 1) * H)       # siempre
s3 = m3.stats("GANA")
chequear("acierto 100 %", s3["acierto"] == 100.0, "n=%d" % s3["n"])
chequear("base también 100 %", s3["base"] == 100.0,
         "la estrategia ingenua saca lo mismo")
chequear("edge 0,0 — no demostró NADA", s3["edge"] == 0.0,
         "acertar todo no es tener ventaja")
chequear("y no figura como significativo", not s3["significativo"])

m3b = Marcador(min_n=5)
for i in range(40):
    gano = 1 if i % 2 == 0 else 0         # base 50 %
    acierta = (i % 4 != 3)                # el modelo acierta 30 de 40
    senal = ("BUY" if gano else "SELL") if acierta else ("SELL" if gano else "BUY")
    m3b.predijo("REAL", senal, (i * 10) * H)
    m3b.outcome("REAL", gano, (i * 10 + 1) * H)
s3b = m3b.stats("REAL")
chequear("con base 50 y acierto 75, el edge sí aparece",
         s3b["base"] == 50.0 and s3b["acierto"] == 75.0 and s3b["edge"] == 25.0,
         "acierto %.0f base %.0f edge %+.0f" % (s3b["acierto"], s3b["base"], s3b["edge"]))
chequear("  y supera su propia banda", s3b["significativo"],
         "edge %+.0f contra mde ±%.1f" % (s3b["edge"], s3b["mde"]))

# ── 4 ───────────────────────────────────────────────────────────────────────
seccion("4 · El edge se lee contra su banda, no solo")

m4 = Marcador(min_n=5)
for i in range(10):
    m4.predijo("POCO", "BUY" if i % 2 == 0 else "SELL", (i * 10) * H)
    m4.outcome("POCO", 1 if i % 2 == 0 else 0, (i * 10 + 1) * H)
s4 = m4.stats("POCO")
chequear("con n=10 la banda es ancha", s4["mde"] > 25.0,
         "mde ±%.1f pp con n=%d" % (s4["mde"], s4["n"]))
m4b = Marcador(min_n=5)
for i in range(400):
    gano = 1 if i % 2 == 0 else 0
    acierta = (i % 20 != 19)
    senal = ("BUY" if gano else "SELL") if acierta else ("SELL" if gano else "BUY")
    m4b.predijo("MUCHO", senal, (i * 10) * H)
    m4b.outcome("MUCHO", gano, (i * 10 + 1) * H)
s4b = m4b.stats("MUCHO")
chequear("con n=400 se angosta", s4b["mde"] < 6.0,
         "mde ±%.1f pp con n=%d" % (s4b["mde"], s4b["n"]))
chequear("la banda es 1,96·√(0,25/n), como la de la tesis",
         abs(s4b["mde"] - 100 * 1.96 * (0.25 / s4b["n"]) ** 0.5) < 0.1)

# ── 5 ───────────────────────────────────────────────────────────────────────
seccion("5 · El ranking no ordena ruido")

m5 = Marcador(min_n=30)
# "FLOR" tiene un edge enorme con 5 muestras: NO puede entrar al ranking.
for i in range(5):
    m5.predijo("FLOR", "BUY", (i * 10) * H)
    m5.outcome("FLOR", 1 if i < 4 else 0, (i * 10 + 1) * H)
# "SOLIDO" tiene 60 muestras y un edge chico.
for i in range(60):
    gano = 1 if i % 2 == 0 else 0
    acierta = (i % 10 != 9)
    senal = ("BUY" if gano else "SELL") if acierta else ("SELL" if gano else "BUY")
    m5.predijo("SOLIDO", senal, (i * 10) * H)
    m5.outcome("SOLIDO", gano, (i * 10 + 1) * H)
rank = m5.ranking()
nombres = [t for t, _ in rank]
chequear("el de 5 muestras NO entra al ranking", "FLOR" not in nombres,
         "edge %+.0f con n=5" % m5.stats("FLOR")["edge"])
chequear("el de 60 sí entra", "SOLIDO" in nombres)
chequear("el resumen dice cuántos tienen muestra y cuántos ventaja",
         m5.resumen()["con_muestra"] == 1 and m5.resumen()["tickers_con_dato"] == 2,
         str(m5.resumen()["con_ventaja_demostrada"]) + " con ventaja demostrada")
chequear("el ranking está ordenado por edge",
         all(rank[i][1]["edge"] >= rank[i + 1][1]["edge"] for i in range(len(rank) - 1)))

# ── 6 ───────────────────────────────────────────────────────────────────────
seccion("6 · Persistencia y límites")

d = m5.a_dict()
m6 = Marcador(min_n=30).de_dict(json.loads(json.dumps(d)))
chequear("el ida y vuelta por JSON conserva los números",
         m6.stats("SOLIDO") == m5.stats("SOLIDO"))
roto = {"version": 1, "metricas": {"MAL": {"n": "no es un numero"},
                                   "BIEN": d["metricas"]["SOLIDO"]}}
m6b = Marcador(min_n=30).de_dict(roto)
chequear("una entrada rota se descarta sin perder el resto",
         m6b.stats("BIEN")["n"] == 60 and m6b.stats("MAL")["n"] == 0,
         "la lección de sim29: un ejemplo malo no vacía el depósito")
chequear("un dict basura no explota", Marcador().de_dict("cualquier cosa") is not None)

m7 = Marcador(max_pendientes=50)
for i in range(5000):
    m7.predijo("XLK", "BUY", i * H)
chequear("las predicciones guardadas tienen tope",
         len(m7._predicciones["XLK"]) == 50,
         "5.000 anotadas, 50 guardadas — la lección de class30")

# ── 7 ───────────────────────────────────────────────────────────────────────
seccion("7 · Dónde se usa: el entrenamiento, NO las predicciones")

c44 = io.open(RAIZ / "MIIA" / "class44.py", encoding="utf-8").read()
chequear("class44 usa el marcador", "from marcador import Marcador" in c44)
chequear("lo alimenta con lo que publica", "marcador.predijo(m.ticker" in c44)
chequear("y lo puntea con el feedback de class43",
         "res = marcador.outcome(ticker," in c44 and 'data.get("decision_ts"' in c44)
chequear("filtra por label_modo", 'data.get("label_modo"' in c44,
         "las `absoluto` no contestan la pregunta")

# LA guarda que protege la medicion: la rotacion NO mira el rendimiento.
i_lote = c44.find("proximo_lote([m.ticker for m in listos]")
arg_lote = c44[i_lote:i_lote + 240]
chequear("la rotación de predicciones NO mira el marcador",
         "marcador" not in arg_lote and "intentos" in arg_lote,
         "sesgarla contaminaría el número que se quiere medir")
chequear("la prioridad sólo toca el umbral del reentreno",
         "umbral_fb = FEEDBACK_RETRAIN_THRESHOLD" in c44
         and "if n >= umbral_fb:" in c44)
chequear("y sólo a los que ya tienen muestra",
         '_st["n"] >= MARCADOR_MIN_N and not _st["significativo"]' in c44,
         "al que no se puede juzgar no se le toca nada")
chequear("arranca APAGADA",
         'os.getenv("CLASS44_PRIORIDAD_ENTRENO", "0") == "1"' in c44,
         "la condición para prenderla es tener muestra")
chequear("el marcador se publica en class44_estado",
         '"marcador":   marcador.stats(m.ticker)' in c44
         and '"marcador_resumen"' in c44,
         "para que llegue al panel y al chequeo")
chequear("y se persiste con escritura atómica",
         "tmp.replace(_marcador_path)" in c44)

print("\n%s" % ("PASA" if _falla == 0 else "FALLA"),
      "— marcador del LSTM  (%d checks, %d fallas)" % (_ok + _falla, _falla))
sys.exit(1 if _falla else 0)
