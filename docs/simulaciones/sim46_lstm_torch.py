"""sim46_lstm_torch.py — sim45 con la LSTM DE VERDAD de class44 (PyTorch).
(23-nov-2026). Medición sobre el volcado del 12-nov; no toca producción.

Misma pregunta que sim45 —¿ordena mejor con la etiqueta relativa de MIIA que con
la absoluta de 4 h?— pero con la arquitectura exacta de `class44.LSTMPredictor`:
LSTM(256) → Dropout 0,3 → LSTM(128) → Dropout 0,3 → Dense(64)+BatchNorm+ReLU →
salida; Adam lr 5e-4, weight_decay 1e-4, ventana de 60 barras horarias.

Diferencias con producción, dichas de entrada:
  · Una red para los 50 (pooled), no una por ticker: con ~600 barras por ticker
    en el volcado, una red de 500 mil parámetros por instrumento sólo memoriza.
    class44 entrena con 2 años de barras de Yahoo, que acá no están.
  · Salida de 2 clases (sube/baja contra la etiqueta), no 3 (SELL/HOLD/BUY).
  · 18 de las 28 features (las que salen sólo del cierre; ver sim45).

Necesita PyTorch:
    python -X utf8 docs/simulaciones/sim46_lstm_torch.py
"""
from __future__ import annotations

import importlib.util
import math
import sys
import time
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from torch import nn

warnings.simplefilter("ignore")
AQUI = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sim45", AQUI / "sim45_lstm_relativa.py")
s45 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s45)
rank_ic = s45.rank_ic

WINDOW, EPOCAS_MAX, PACIENCIA, LOTE = 60, 12, 3, 64
CADA, INICIO, SEMILLAS = 10, 30, 2
torch.set_num_threads(6)


class LSTMPredictor(nn.Module):
    """Copia de class44.LSTMPredictor (salida de 2 clases en vez de 3)."""
    def __init__(self, n_features, hidden=256):
        super().__init__()
        self.lstm1 = nn.LSTM(n_features, hidden, batch_first=True)
        self.drop1 = nn.Dropout(0.30)
        self.lstm2 = nn.LSTM(hidden, 128, batch_first=True)
        self.drop2 = nn.Dropout(0.30)
        self.fc1 = nn.Linear(128, 64)
        self.bn1 = nn.BatchNorm1d(64)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(64, 2)

    def forward(self, x):
        out, _ = self.lstm1(x)
        out = self.drop1(out)
        out, _ = self.lstm2(out)
        out = self.drop2(out[:, -1, :])
        return self.fc2(self.relu(self.bn1(self.fc1(out))))


def preparar():
    import json
    barras = json.loads(s45.GUARDADO.read_text(encoding="utf8")) if s45.GUARDADO.exists() else s45.extraer()
    horas = sorted(barras)
    tks = sorted(s45.UNIVERSO)
    T = len(horas)
    P = np.full((T, len(tks)), np.nan)
    for i, h in enumerate(horas):
        for j, tk in enumerate(tks):
            P[i, j] = barras[h].get(tk, np.nan)
    for j in range(len(tks)):
        for i in range(1, T):
            if np.isnan(P[i, j]):
                P[i, j] = P[i - 1, j]
    dia = np.array([h[:10] for h in horas])
    rueda = set()
    for d in sorted(set(dia)):
        ii = np.where(dia == d)[0]
        a, b = P[ii[0]], P[ii[-1]]
        ok = ~np.isnan(a) & ~np.isnan(b)
        if ok.sum() >= 5 and (np.abs(b[ok] / a[ok] - 1) > 1e-9).mean() >= 0.5:
            rueda.add(d)
    keep = np.array([d in rueda for d in dia])
    return P[keep], [h for h, k in zip(horas, keep) if k], dia[keep], tks


def main():
    P, horas, dia, tks = preparar()
    T = len(horas)
    ses = sorted(set(dia))
    ult = {d: max(i for i in range(T) if dia[i] == d) for d in ses}
    fwd = lambda k: np.r_[P[k:] / P[:-k] - 1, np.full((k, P.shape[1]), np.nan)]
    R4, R14 = fwd(s45.H_ABS), fwd(s45.H_REL)
    rel14 = R14 - np.nanmean(R14, axis=1, keepdims=True)
    Fs = {}
    for j in range(len(tks)):
        c = P[:, j]
        v = ~np.isnan(c)
        if v.sum() < 120:
            continue
        i0 = np.argmax(v)
        F = np.full((T, 18), np.nan)
        F[i0:] = s45.features(c[i0:], horas[i0:])
        F[i0:i0 + 50] = np.nan
        Fs[j] = F
    print(f"{T} barras · {len(ses)} sesiones · {len(Fs)} instrumentos · ventana {WINDOW}")

    def secuencia(j, i):
        if i - WINDOW + 1 < 0:
            return None
        x = Fs[j][i - WINDOW + 1:i + 1]
        return None if np.isnan(x).any() else x

    def muestras(hasta_i, etiqueta, paso=2):
        lab = R4 if etiqueta == "abs" else rel14
        hmax = s45.H_ABS if etiqueta == "abs" else s45.H_REL
        X, y = [], []
        for j in Fs:
            for i in range(WINDOW, max(WINDOW, hasta_i - hmax), paso):
                x = secuencia(j, i)
                if x is not None and not np.isnan(lab[i, j]) and abs(lab[i, j]) > 1e-9:
                    X.append(x); y.append(1 if lab[i, j] > 0 else 0)
        return np.array(X, np.float32), np.array(y)

    def entrenar(X, y, seed):
        torch.manual_seed(seed)
        n = len(X); corte = int(n * 0.85)          # validación cronológica, como class44
        m = LSTMPredictor(X.shape[2])
        opt = torch.optim.Adam(m.parameters(), lr=5e-4, weight_decay=1e-4)
        w = torch.tensor(n / (2 * np.bincount(y, minlength=2).clip(1)), dtype=torch.float32)
        crit = nn.CrossEntropyLoss(weight=w)
        Xt, yt = torch.from_numpy(X), torch.from_numpy(y)
        mejor, estado, sin_mejora = 1e9, None, 0
        g = torch.Generator().manual_seed(seed)
        for _ in range(EPOCAS_MAX):
            m.train()
            idx = torch.randperm(corte, generator=g)
            for s in range(0, corte, LOTE):
                b = idx[s:s + LOTE]
                if len(b) < 2:
                    continue
                opt.zero_grad()
                crit(m(Xt[b]), yt[b]).backward()
                opt.step()
            m.eval()
            with torch.no_grad():
                vl = crit(m(Xt[corte:]), yt[corte:]).item()
            if vl < mejor - 1e-4:
                mejor, estado, sin_mejora = vl, {k: v.clone() for k, v in m.state_dict().items()}, 0
            else:
                sin_mejora += 1
                if sin_mejora >= PACIENCIA:
                    break
        m.load_state_dict(estado); m.eval()
        return m, mejor

    def realizado(d, k):
        i = ses.index(d)
        if i + k >= len(ses):
            return None
        r = P[ult[ses[i + k]]] / P[ult[d]] - 1
        return r - np.nanmean(r)

    res = {e: defaultdict(list) for e in ("abs", "rel")}
    for etiqueta in ("abs", "rel"):
        t0 = time.time()
        modelos = mu = sd = None
        for k in range(INICIO, len(ses) - 1):
            d = ses[k]
            if (k - INICIO) % CADA == 0:
                X, y = muestras(ult[d] + 1, etiqueta)
                mu = X.reshape(-1, X.shape[2]).mean(0); sd = X.reshape(-1, X.shape[2]).std(0) + 1e-9
                Xn = ((X - mu) / sd).astype(np.float32)
                modelos = []
                for s in range(SEMILLAS):
                    m, vl = entrenar(Xn, y, s)
                    modelos.append(m)
                print(f"  {etiqueta} · sesión {d}: {len(X)} secuencias, val_loss {vl:.4f} (azar ln2 = 0,6931)"
                      f" · {time.time()-t0:.0f} s")
            i = ult[d]
            js = [j for j in Fs if secuencia(j, i) is not None]
            if len(js) < rank_ic.MIN_INSTRUMENTOS:
                continue
            Xi = torch.from_numpy(((np.array([secuencia(j, i) for j in js]) - mu) / sd).astype(np.float32))
            with torch.no_grad():
                score = np.mean([torch.softmax(m(Xi), 1)[:, 1].numpy() for m in modelos], axis=0)
            for kses in (1, 2):
                rr = realizado(d, kses)
                if rr is not None:
                    res[etiqueta][kses].append([(tks[j], float(score[n]), float(rr[j]))
                                                for n, j in enumerate(js) if not np.isnan(rr[j])])
    for e in res:
        res[e][2] = res[e][2][::2]          # 48 h sin solapar
    nom = {"abs": "etiqueta ABSOLUTA 4 h (la de hoy)", "rel": "etiqueta RELATIVA 48 h (la de MIIA)"}
    for kses, txt in ((1, "sesión siguiente (la del endpoint)"), (2, "dos sesiones (48 h), sin solapar")):
        print(f"\n── LSTM de class44 · rank IC contra {txt} ──")
        for e in ("abs", "rel"):
            s = rank_ic.serie_ic(res[e][kses])
            print(f"  {nom[e]:<38} IC {s['rank_ic']:+.4f} · MDE {s['rank_ic_min_detectable']:.4f} · "
                  f"t {s['rank_ic_t']:+.2f} · ventanas {s['rank_ic_ventanas']}")
        a = rank_ic.serie_ic(res["abs"][kses])["rank_ic_serie"]
        r = rank_ic.serie_ic(res["rel"][kses])["rank_ic_serie"]
        if len(a) == len(r) > 2:
            d = np.array(r) - np.array(a)
            print(f"  diferencia relativa − absoluta: {d.mean():+.4f} ± {1.96*d.std(ddof=1)/math.sqrt(len(d)):.4f}"
                  f" · mejor en {int((d > 0).sum())} de {len(d)}")


if __name__ == "__main__":
    main()
