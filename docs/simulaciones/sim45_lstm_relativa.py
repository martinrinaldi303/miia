"""sim45_lstm_relativa.py — ¿el LSTM ordenaría mejor si aprendiera la pregunta de MIIA?
(23-nov-2026). Medición sobre el volcado del 12-nov; no toca producción.

class44 entrena «¿el precio sube en las próximas 4 barras horarias?» (absoluto)
y tira la etiqueta relativa que le manda class43. MIIA pregunta «¿le gana al
promedio de los 50 en 48 h?». Esto compara EL MISMO modelo con las dos etiquetas
y lo mide con el rank IC del endpoint (sesión siguiente, retorno relativo).

Límites, dichos de entrada:
  · No hay torch en la PC: el modelo es una red de una capa oculta en numpy sobre
    la secuencia resumida, no la LSTM de 2 capas. Lo que se compara es la ETIQUETA.
  · El volcado sólo tiene precio (no OHLCV ni volumen): de las 28 features de
    class44 se usan las 18 que salen del cierre (RSI, MACD, Bollinger, EMAs,
    momentum, retornos, hora y día).
  · Walk-forward: se reentrena cada 5 sesiones con todo lo anterior (con purga),
    y se predice la sesión siguiente sin mirar el futuro.

    python -X utf8 docs/simulaciones/sim45_lstm_relativa.py --extraer   # relee el volcado
    python -X utf8 docs/simulaciones/sim45_lstm_relativa.py
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))
import rank_ic                                      # noqa: E402  código de producción
from universo import TICKERS as UNIVERSO            # noqa: E402

VOLCADO  = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
GUARDADO = AQUI / "datos" / "lstm_relativa_barras.json"
CAMPO    = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
HORAS    = range(15, 22)        # barras de rueda en hora del server (15:30-22:00)
H_ABS    = 4                    # class44: 4 barras
H_REL    = 14                   # 48 h ≈ 2 sesiones de 7 barras


# ───────────────────────────── extracción ─────────────────────────────

def _campos(t: bytes) -> list:
    out = []
    for m in CAMPO.finditer(t):
        if m.group(1) is not None:
            out.append(m.group(1).decode("utf8", "replace"))
        elif m.group(2) is not None:
            out.append(m.group(2).decode().strip())
        else:
            out.append(None)
    return out


def _columnas(tabla):
    buscar = ("CREATE TABLE `" + tabla + "` (").encode()
    cols, dentro = [], False
    for ln in VOLCADO.open("rb"):
        if not dentro:
            dentro = ln.startswith(buscar)
            continue
        if ln.startswith(b")"):
            break
        m = re.match(rb"\s+`([a-z_]+)`\s", ln)
        if m:
            cols.append(m.group(1).decode())
    return {c: i for i, c in enumerate(cols)}


def extraer():
    ip = _columnas("precios")
    univ = set(UNIVERSO)
    PP = b"INSERT INTO `precios` VALUES "
    ultimo = {}                     # (tk, "AAAA-MM-DD HH") -> (ts, precio)
    for ln in VOLCADO.open("rb"):
        if not ln.startswith(PP):
            continue
        for t in ln[len(PP):].rstrip(b";\r\n").split(b"),("):
            c = _campos(t.lstrip(b"(").rstrip(b")"))
            if len(c) < len(ip):
                continue
            tk, ts = c[ip["ticker"]], c[ip["ts"]]
            try:
                pv = float(c[ip["precio"]])
            except (TypeError, ValueError):
                continue
            if tk not in univ or not ts or pv <= 0 or int(ts[11:13]) not in HORAS:
                continue
            k = (tk, ts[:13])
            if k not in ultimo or ts > ultimo[k][0]:
                ultimo[k] = (ts, pv)
    barras = defaultdict(dict)
    for (tk, h), (_, pv) in ultimo.items():
        barras[h][tk] = pv
    GUARDADO.write_text(json.dumps(barras, separators=(",", ":")), encoding="utf8")
    print(f"barras horarias: {len(barras)} · guardadas en {GUARDADO.name}")
    return barras


# ───────────────────────────── features ─────────────────────────────

def _ema(x, n):
    a, out, e = 2 / (n + 1), np.empty_like(x), x[0]
    for i, v in enumerate(x):
        e = a * v + (1 - a) * e
        out[i] = e
    return out


def features(c, horas):
    """Las 18 de class44 que salen sólo del cierre. c: cierres horarios."""
    n = len(c)
    r1 = np.r_[0, np.diff(c) / c[:-1]]
    up, dn = np.clip(r1, 0, None), np.clip(-r1, 0, None)
    rsi = 100 - 100 / (1 + _ema(up, 27) / (_ema(dn, 27) + 1e-12))   # ~Wilder 14
    macd = (_ema(c, 12) - _ema(c, 26)) / c
    sig = _ema(macd, 9)

    def lag(k):
        o = np.zeros(n)
        o[k:] = c[k:] / c[:-k] - 1
        return o
    m20 = np.array([c[max(0, i - 19):i + 1].mean() for i in range(n)])
    s20 = np.array([c[max(0, i - 19):i + 1].std() + 1e-12 for i in range(n)])
    bb_pct = (c - (m20 - 2 * s20)) / (4 * s20)
    hr = np.array([int(h[11:13]) for h in horas], float)
    dw = np.array([datetime.strptime(h[:10], "%Y-%m-%d").weekday() for h in horas], float)
    F = np.c_[rsi / 100, macd, sig, macd - sig, lag(10), lag(5), bb_pct, 4 * s20 / m20,
              _ema(c, 9) / c, _ema(c, 21) / c, _ema(c, 50) / c, r1, lag(4),
              np.sin(2 * np.pi * hr / 24), np.cos(2 * np.pi * hr / 24),
              np.sin(2 * np.pi * dw / 5), np.cos(2 * np.pi * dw / 5),
              np.array([c[max(0, i - 6):i + 1].std() / c[i] for i in range(n)])]
    return F


# ───────────────────────────── modelo ─────────────────────────────

class Red:
    """Una capa oculta, salida logística. Mismo modelo para las dos etiquetas."""
    def __init__(self, d, h=32, seed=0):
        g = np.random.default_rng(seed)
        self.W1 = g.normal(0, 1 / math.sqrt(d), (d, h)); self.b1 = np.zeros(h)
        self.W2 = g.normal(0, 1 / math.sqrt(h), h); self.b2 = 0.0

    def prob(self, X):
        H = np.tanh(X @ self.W1 + self.b1)
        return 1 / (1 + np.exp(-(H @ self.W2 + self.b2))), H

    def entrenar(self, X, y, epocas=8, lr=0.02, l2=1e-3, lote=256, seed=0):
        g = np.random.default_rng(seed)
        for _ in range(epocas):
            idx = g.permutation(len(X))
            for s in range(0, len(X), lote):
                b = idx[s:s + lote]
                p, H = self.prob(X[b])
                e = (p - y[b]) / len(b)
                dH = np.outer(e, self.W2) * (1 - H ** 2)
                self.W2 -= lr * (H.T @ e + l2 * self.W2); self.b2 -= lr * e.sum()
                self.W1 -= lr * (X[b].T @ dH + l2 * self.W1); self.b1 -= lr * dH.sum(0)


# ───────────────────────────── armado y walk-forward ─────────────────────────────

def main():
    barras = extraer() if ("--extraer" in sys.argv or not GUARDADO.exists()) \
        else json.loads(GUARDADO.read_text(encoding="utf8"))
    horas = sorted(barras)
    # sesión = día con al menos la mitad de los tickers presentes moviéndose
    dias = sorted({h[:10] for h in horas})
    T = len(horas)
    tks = sorted(UNIVERSO)
    P = np.full((T, len(tks)), np.nan)
    for i, h in enumerate(horas):
        for j, tk in enumerate(tks):
            P[i, j] = barras[h].get(tk, np.nan)
    # rellenar hacia adelante (class7 sólo escribe cuando cambia el precio)
    for j in range(len(tks)):
        col = P[:, j]
        for i in range(1, T):
            if np.isnan(col[i]):
                col[i] = col[i - 1]
    # días de rueda: la mitad de los presentes cambió de precio en el día
    dia_de = np.array([h[:10] for h in horas])
    rueda = set()
    for d in dias:
        ii = np.where(dia_de == d)[0]
        a, b = P[ii[0]], P[ii[-1]]
        ok = ~np.isnan(a) & ~np.isnan(b)
        if ok.sum() >= 5 and (np.abs(b[ok] / a[ok] - 1) > 1e-9).mean() >= 0.5:
            rueda.add(d)
    keep = np.array([d in rueda for d in dia_de])
    P, horas, dia_de = P[keep], [h for h, k in zip(horas, keep) if k], dia_de[keep]
    T = len(horas)
    sesiones = sorted(set(dia_de))
    print(f"{T} barras de rueda en {len(sesiones)} sesiones ({sesiones[0]} a {sesiones[-1]}), {len(tks)} instrumentos")

    # features y etiquetas por ticker (sólo donde hay historia propia)
    Fs, Yabs, Yrel = {}, {}, {}
    fwd = lambda k: np.r_[P[k:] / P[:-k] - 1, np.full((k, P.shape[1]), np.nan)]
    R4, R14 = fwd(H_ABS), fwd(H_REL)
    with np.errstate(all='ignore'):
        import warnings; warnings.simplefilter('ignore')
        rel14 = R14 - np.nanmean(R14, axis=1, keepdims=True)
    for j, tk in enumerate(tks):
        c = P[:, j]
        v = ~np.isnan(c)
        if v.sum() < 120:
            continue
        i0 = np.argmax(v)
        F = np.full((T, 18), np.nan)
        F[i0:] = features(c[i0:], horas[i0:])
        F[i0:i0 + 50] = np.nan          # calentamiento de las EMAs
        Fs[j] = F
    print(f"instrumentos con historia suficiente: {len(Fs)}")

    # índice de la última barra de cada sesión = punto de decisión
    ult = {d: max(i for i in range(T) if dia_de[i] == d) for d in sesiones}
    # realizado del endpoint: sesión siguiente, relativo equiponderado
    ses_idx = {d: k for k, d in enumerate(sesiones)}

    def realizado(d, k_ses):
        k = ses_idx[d]
        if k + k_ses >= len(sesiones):
            return None
        a, b = P[ult[d]], P[ult[sesiones[k + k_ses]]]
        r = b / a - 1
        ok = ~np.isnan(r)
        return np.where(ok, r - np.nanmean(r), np.nan)

    def muestras(hasta_i, etiqueta):
        X, y = [], []
        for j, F in Fs.items():
            lab = R4[:, j] if etiqueta == "abs" else rel14[:, j]
            hmax = H_ABS if etiqueta == "abs" else H_REL
            for i in range(0, max(0, hasta_i - hmax)):
                if not np.isnan(F[i]).any() and not np.isnan(lab[i]) and abs(lab[i]) > 1e-9:
                    X.append(F[i]); y.append(1.0 if lab[i] > 0 else 0.0)
        return np.array(X), np.array(y)

    INICIO, CADA, SEMILLAS = 30, 5, 3
    res = {"abs": defaultdict(list), "rel": defaultdict(list), "mom": defaultdict(list)}
    for etiqueta in ("abs", "rel"):
        modelos, mu, sd = None, None, None
        for k in range(INICIO, len(sesiones) - 1):
            d = sesiones[k]
            if (k - INICIO) % CADA == 0:
                X, y = muestras(ult[d] + 1, etiqueta)
                mu, sd = X.mean(0), X.std(0) + 1e-9
                Xn = (X - mu) / sd
                modelos = []
                for s in range(SEMILLAS):
                    m = Red(X.shape[1], seed=s)
                    m.entrenar(Xn, y, seed=s)
                    modelos.append(m)
            i = ult[d]
            js = [j for j, F in Fs.items() if not np.isnan(F[i]).any()]
            if len(js) < rank_ic.MIN_INSTRUMENTOS:
                continue
            Xi = (np.array([Fs[j][i] for j in js]) - mu) / sd
            score = np.mean([m.prob(Xi)[0] for m in modelos], axis=0)
            for kses in (1, 2):
                rr = realizado(d, kses)
                if rr is None:
                    continue
                sec = [(tks[j], float(score[n]), float(rr[j])) for n, j in enumerate(js) if not np.isnan(rr[j])]
                res[etiqueta][kses].append(sec)
                if etiqueta == "abs":   # referencia sin aprender: momentum de 5 barras
                    res["mom"][kses].append([(t, float(Fs[tks.index(t)][i][5]), r) for t, _, r in sec])
        print(f"  {etiqueta}: listo")

    nombres = {"abs": "etiqueta ABSOLUTA 4 h (la de hoy)",
               "rel": "etiqueta RELATIVA 48 h (la de MIIA)",
               "mom": "sin aprender: momentum de 5 barras"}
    # Con 2 sesiones, la ventana de hoy y la de mañana comparten un día: se toma
    # una sí y otra no, o el t sale inflado (la trampa del t = −2,15 del 21-sep).
    for e in res:
        res[e][2] = res[e][2][::2]
    for kses, txt in ((1, "sesión siguiente (la del endpoint)"), (2, "dos sesiones (48 h), sin solapar")):
        print(f"\n── rank IC contra {txt} ──")
        for e in ("abs", "rel", "mom"):
            s = rank_ic.serie_ic(res[e][kses])
            print(f"  {nombres[e]:<40} IC {s['rank_ic']:+.4f} · MDE {s['rank_ic_min_detectable']:.4f} · "
                  f"t {s['rank_ic_t']:+.2f} · ventanas {s['rank_ic_ventanas']} · "
                  f"instrumentos {s['rank_ic_instrumentos']}")
        # diferencia pareada relativa − absoluta, por ventana
        a = rank_ic.serie_ic(res["abs"][kses])["rank_ic_serie"]
        r = rank_ic.serie_ic(res["rel"][kses])["rank_ic_serie"]
        if len(a) == len(r) and len(a) > 2:
            d = np.array(r) - np.array(a)
            err = d.std(ddof=1) / math.sqrt(len(d))
            print(f"  diferencia relativa − absoluta: {d.mean():+.4f} ± {1.96*err:.4f} · "
                  f"mejor en {int((d > 0).sum())} de {len(d)} ventanas")


if __name__ == "__main__":
    main()
