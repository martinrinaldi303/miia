"""Marcador por ticker del LSTM: ¿este modelo le gana al promedio?

Aritmética pura, sin dependencias, por el mismo motivo que `rotacion.py`:
importar class44 arrastra torch, yfinance y redis.

Para qué existe
---------------
Lo pidió Martín el 10-oct-2026: que el esfuerzo se concentre en los modelos que
le están ganando al promedio. **No había con qué**: `val_loss` sólo va al log,
`class44_estado` no publica ninguna métrica de acierto y `lstm_predictions` tiene
73.325 filas con `outcome_real` vacío en todas.

Pero el dato ya viaja por el bus y se tiraba. El feedback de class43 a
`class24_feedback` trae (`class43.js:864`):

    decision_ts   cuándo se tomó la decisión que se está verificando
    outcome       1 si el instrumento le GANÓ al promedio equiponderado, 0 si no
    label_modo    'relativo' | 'absoluto'
    ticker, retorno_pct, ts

`outcome` es exactamente la pregunta de ORDEN 1 — «¿este instrumento le gana al
promedio?» — así que alcanza con aparearlo contra lo que el LSTM decía en ese
momento. `_feedback_listener` lo recibía y usaba **sólo la longitud** del buffer
para decidir cuándo reentrenar.

Las cuatro reglas, y por qué cada una
-------------------------------------
1. **Sólo `label_modo == 'relativo'`.** Las `absoluto` son GENERAL, o sea la
   dirección del mercado: mezclarlas es el defecto 10 otra vez, y además no
   contestan «le gana al promedio» sino «subió».
2. **Sólo BUY y SELL tienen acierto definido.** Un HOLD no acierta ni falla; la
   regla vieja de class43 (defecto 4) trataba todo lo que no era BUY como SELL y
   el corte la arregló. Acá se descarta y se cuenta aparte, igual que allá: una
   etiqueta inventada es peor que una que falta.
3. **El acierto se lee SIEMPRE junto a la base.** `acierto` solo no dice nada —
   es la lección de la tesis—, así que el marcador guarda cuántas veces ese
   instrumento le ganó al promedio **independientemente de lo que dijo el
   modelo**, y el número que importa es `edge = acierto − base`.
4. **Y el edge se lee junto a su banda.** `mde = 1,96·√(0,25/n)`: por debajo de
   eso no hay ventaja demostrada, hay ruido. El ranking lo informa en vez de
   ordenar por un número que no se distingue de cero — es lo que impidió que
   esto fuera la séptima «clave que destaca y rota» de la serie.

⚠️ Qué mide, exactamente, para que nadie lo lea de más
------------------------------------------------------
El feedback de class43 vence a las 24-48 h de la decisión; el horizonte propio
del LSTM son 4 barras horarias. Así que esto mide **«el LSTM decía BUY cuando
class25A decidió, y el instrumento le ganó al promedio en la ventana del
ensamble»** — que es justo la pregunta que hay que contestar para decidir si el
LSTM merece votar en class25A. **No** mide si el LSTM es bueno en su propia tarea
de 4 h. Son dos preguntas distintas y ésta es la que sirve para lo que se quiere.
"""
from __future__ import annotations

from math import sqrt

__all__ = ["Marcador", "MIN_N_DEFECTO"]

#: Mínimo de predicciones puntuadas para que un ticker entre al ranking. 30 es
#: el mismo piso que usa el endpoint de la tesis para empezar a medir sólo el
#: brazo nuevo (`label_modo`), y por debajo de eso el MDE pasa de 18 pp.
MIN_N_DEFECTO = 30

#: Tope de predicciones guardadas por ticker. Sin tope esto es la fuga de
#: class30 otra vez: una lista que sólo crece.
MAX_PENDIENTES = 200

#: Si la última predicción anterior a la decisión tiene más de esto, no se
#: aparea. Es del orden del TTL de los vectores de class24 y los snapshots de
#: class25A (80 h): más viejo que eso no es lo que el modelo "decía" entonces.
VENTANA_H = 72


class Marcador:
    """Puntúa, por ticker, las señales del LSTM contra el promedio."""

    def __init__(self, min_n=MIN_N_DEFECTO, max_pendientes=MAX_PENDIENTES,
                 ventana_h=VENTANA_H):
        self.min_n = int(min_n)
        self.max_pendientes = int(max_pendientes)
        self.ventana_ms = float(ventana_h) * 3600_000.0
        #: ticker -> [(ts_ms, senal)], en orden de llegada
        self._predicciones: dict[str, list] = {}
        #: ticker -> contadores
        self._m: dict[str, dict] = {}
        #: por qué se descartó algo, para que el silencio no parezca éxito
        self.descartes = {"absoluto": 0, "hold": 0, "sin_prediccion": 0,
                          "vieja": 0, "malo": 0}

    # ── Entrada ────────────────────────────────────────────────────────────
    def predijo(self, ticker, senal, ts_ms):
        """Anota lo que el modelo dijo, para poder puntuarlo cuando venza."""
        if not ticker:
            return
        lista = self._predicciones.setdefault(ticker, [])
        lista.append((float(ts_ms), str(senal or "").upper()))
        if len(lista) > self.max_pendientes:
            del lista[:-self.max_pendientes]

    def outcome(self, ticker, gano_al_promedio, decision_ts_ms, label_modo="relativo"):
        """Puntúa la predicción que estaba en pie cuando se tomó la decisión.

        Devuelve "ok", "err" o el motivo del descarte. `gano_al_promedio` es el
        campo `outcome` de class43: 1 si le ganó al promedio equiponderado.
        """
        if str(label_modo).lower() != "relativo":
            self.descartes["absoluto"] += 1
            return "absoluto"
        try:
            # class43 manda 1 o 0; el default historico del listener era 0.5, que
            # no es ni una cosa ni la otra. Lo que no sea interpretable se cuenta
            # y se descarta: una etiqueta inventada es peor que una que falta.
            gano = float(gano_al_promedio) > 0.5
        except (TypeError, ValueError):
            self.descartes["malo"] += 1
            return "malo"

        senal = self._senal_vigente(ticker, decision_ts_ms)
        if senal is None:
            return self._ultimo_descarte

        # La base NO depende de lo que dijo el modelo: es cuántas veces ese
        # instrumento le ganó al promedio. Sin esto, `acierto` no significa nada.
        m = self._m.setdefault(ticker, {"n": 0, "aciertos": 0, "gano": 0,
                                        "buy": 0, "sell": 0})

        if senal not in ("BUY", "SELL"):
            # El HOLD sí cuenta para la base —es una ventana observada— pero no
            # tiene acierto definido. Separarlo es la regla del defecto 4.
            self.descartes["hold"] += 1
            return "hold"

        m["n"] += 1
        m["gano"] += 1 if gano else 0
        m["buy"] += 1 if senal == "BUY" else 0
        m["sell"] += 1 if senal == "SELL" else 0
        acerto = (senal == "BUY") == gano
        m["aciertos"] += 1 if acerto else 0
        return "ok" if acerto else "err"

    def _senal_vigente(self, ticker, decision_ts_ms):
        """La última señal anterior a la decisión, si no está demasiado vieja."""
        lista = self._predicciones.get(ticker) or []
        dts = float(decision_ts_ms or 0)
        mejor = None
        for ts, senal in lista:
            if ts <= dts and (mejor is None or ts > mejor[0]):
                mejor = (ts, senal)
        if mejor is None:
            self.descartes["sin_prediccion"] += 1
            self._ultimo_descarte = "sin_prediccion"
            return None
        if dts - mejor[0] > self.ventana_ms:
            self.descartes["vieja"] += 1
            self._ultimo_descarte = "vieja"
            return None
        return mejor[1]

    _ultimo_descarte = "sin_prediccion"

    # ── Lectura ────────────────────────────────────────────────────────────
    def stats(self, ticker):
        """Acierto, base, edge y la banda de ruido de ESE ticker."""
        m = self._m.get(ticker)
        if not m or m["n"] == 0:
            return {"n": 0, "acierto": None, "base": None, "edge": None,
                    "mde": None, "significativo": False, "buy": 0, "sell": 0}
        n = m["n"]
        acierto = 100.0 * m["aciertos"] / n
        # La base: la estrategia ingenua de decir siempre la direccion
        # mayoritaria, igual que `base_rate` del endpoint de la tesis.
        p_gano = m["gano"] / n
        base = 100.0 * max(p_gano, 1.0 - p_gano)
        edge = acierto - base
        mde = 100.0 * 1.96 * sqrt(0.25 / n)
        return {"n": n, "acierto": round(acierto, 1), "base": round(base, 1),
                "edge": round(edge, 1), "mde": round(mde, 1),
                "significativo": edge > mde, "buy": m["buy"], "sell": m["sell"]}

    def ranking(self, tickers=None):
        """Los tickers con muestra suficiente, del mejor edge al peor.

        Sólo entran los que llegan a `min_n`: con menos, el edge no se distingue
        de cero y ordenar por él es ordenar ruido. Es lo que le pasó a las seis
        claves de peso que "destacaron" en tres meses y medio y rotaron todas.
        """
        cands = list(tickers) if tickers is not None else list(self._m)
        filas = []
        for t in cands:
            s = self.stats(t)
            if s["n"] >= self.min_n:
                filas.append((t, s))
        filas.sort(key=lambda f: (-f[1]["edge"], -f[1]["n"], f[0]))
        return filas

    def resumen(self):
        """Una línea para el heartbeat: cuántos medidos y cuántos demostrados."""
        medidos = [t for t in self._m if self._m[t]["n"] >= self.min_n]
        demostrados = [t for t in medidos if self.stats(t)["significativo"]]
        return {
            "tickers_con_dato": len(self._m),
            "con_muestra": len(medidos),
            "min_n": self.min_n,
            "con_ventaja_demostrada": len(demostrados),
            "mejores": [t for t, _ in self.ranking()[:5]],
            "descartes": dict(self.descartes),
        }

    # ── Persistencia ───────────────────────────────────────────────────────
    def a_dict(self):
        return {"version": 1, "min_n": self.min_n,
                "metricas": {t: dict(v) for t, v in self._m.items()},
                "descartes": dict(self.descartes)}

    def de_dict(self, d):
        """Carga lo guardado. Un ticker con forma rara se descarta solo.

        Las predicciones EN VUELO no se guardan a propósito: tras un reinicio no
        hay con qué aparear los outcomes de las decisiones anteriores, y
        apareárselos a una predicción nueva seria inventar el dato. Se pierden
        unas pocas ventanas, igual que los snapshots de class25A.
        """
        if not isinstance(d, dict):
            return self
        for t, v in (d.get("metricas") or {}).items():
            try:
                self._m[str(t)] = {
                    "n": int(v["n"]), "aciertos": int(v["aciertos"]),
                    "gano": int(v["gano"]), "buy": int(v.get("buy", 0)),
                    "sell": int(v.get("sell", 0)),
                }
            except Exception:
                continue
        for k, v in (d.get("descartes") or {}).items():
            if k in self.descartes:
                try:
                    self.descartes[k] = int(v)
                except Exception:
                    pass
        return self
