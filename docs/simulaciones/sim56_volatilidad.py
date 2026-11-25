"""sim56_volatilidad.py — ¿puede MIIA predecir CUÁNTO se va a mover cada activo en
los próximos 2 días? (24-nov-2026). Medición; no toca producción.

La dirección a 2 días no se pudo predecir en ningún universo (sim45-55). La
volatilidad viene en rachas y es mucho más predecible. Acá se mide eso, con la
misma vara que usa MIIA: el rank IC por ventana de 2 días, sin solapar.

Realizado: volatilidad de los 2 días siguientes, √((r₁² + r₂²)/2), con los
retornos diarios de cierre a cierre.

Pronósticos, todos con información hasta el cierre del día de la decisión:
  · ingenuo      «mañana como hoy»: |retorno de hoy|
  · vol 20 días  desvío de los últimos 20 retornos
  · EWMA         RiskMetrics, λ = 0,94
  · HAR          el modelo estándar de la literatura (Corsi 2009): regresión de
                 la vol futura contra la de 1, 5 y 22 días, en logaritmos, ajustada
                 sólo con el pasado (últimos 500 días, se reajusta cada 20)
  · MIIA         la cadena de MIIA tal cual (vector class10 → dos redes en línea
                 con repaso → z contra base con olvido), con la etiqueta cambiada:
                 «¿se va a mover más que la mediana de los demás?»

Dos preguntas, porque la primera se contesta casi sola:
  1 · ¿Quién se va a mover más? Una parte es fija: EWZ siempre se mueve más que
      XLU. Eso solo ya da un IC alto, sin predecir nada.
  2 · ¿Quién se va a mover más DE LO QUE SUELE moverse? Pronóstico y realizado
      divididos por la vol del último año de cada activo. Ésta es la prueba de
      que se está prediciendo algo y no repitiendo lo de siempre.

Resultado esperado, ESCRITO ANTES de correr:
  · pregunta 1: todos altos (IC > 0,5), el ingenuo el más bajo.
  · pregunta 2: HAR y EWMA claramente positivos (~0,1-0,3), ingenuo menor.
    MIIA positivo pero por debajo de HAR: su vector sólo tiene la vol de 30 días
    y el retorno del día, no la estructura de 1/5/22 días.
  · placebo (MIIA corrida en el tiempo): muy por debajo en la pregunta 2.

Resultado del 24-nov (pregunta 2, la que importa; MDE ~0,02 ETFs y ~0,013 criptos):
                ETFs    criptos
  ingenuo       +0,046  +0,146
  vol 20 días   +0,134  +0,247
  EWMA 0,94     +0,138  +0,252
  HAR           +0,123  +0,238
  MIIA          +0,115  +0,201   (placebo 95 %: +0,041 · +0,030)
  · Se cumplió lo esperado: la volatilidad SÍ se predice, en los dos universos,
    en las dos mitades, y muy por encima del placebo. MIIA también la predice.
  · Pero MIIA no le gana a una fórmula de una línea: EWMA es igual o mejor
    (MIIA − HAR: −0,008 ± 0,017 en ETFs, −0,038 ± 0,014 en criptos).
  · En el tiempo, para cada activo, MIIA sigue peor su propia vol (+0,12 contra
    +0,18 en ETFs; +0,15 contra +0,35 en criptos).
  · Pregunta 1: todos ~0,4-0,5, casi todo es lo fijo (el placebo da +0,43).

Universos: los 50 ETFs (sim47, 5 años) y las 31 criptos de sim50 (2019-2026).
El primer año sólo entrena.

    python -X utf8 docs/simulaciones/sim56_volatilidad.py
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
H, CALENT, LARGO = 2, 260, 250


def _cargar(nombre, archivo):
    spec = importlib.util.spec_from_file_location(nombre, AQUI / archivo)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


s50 = _cargar("s50", "sim50_cripto.py")
s51 = _cargar("s51", "sim51_etf_plazos.py")
rank_ic = s50.rank_ic


# ───────────────────────────── pronósticos clásicos ─────────────────────────────

def clasicos(R):
    T, N = R.shape
    R2 = R ** 2
    ing = np.abs(R)
    v20 = np.full((T, N), np.nan); lar = np.full((T, N), np.nan)
    ew = np.full((T, N), np.nan)
    s2 = np.full(N, np.nan)
    for i in range(T):
        x = R2[i]
        ok = ~np.isnan(x)
        s2 = np.where(np.isnan(s2) & ok, x, s2)
        s2 = np.where(ok, 0.94 * s2 + 0.06 * np.nan_to_num(x), s2)
        ew[i] = np.sqrt(s2)
        if i >= 19:
            v20[i] = np.nanstd(R[i - 19:i + 1], axis=0)
        if i >= LARGO - 1:
            w = R[i - LARGO + 1:i + 1]
            lar[i] = np.where((~np.isnan(w)).sum(0) >= 200, np.nanstd(w, axis=0), np.nan)
    return ing, v20, ew, lar


def media_movil(R2, k):
    out = np.full(R2.shape, np.nan)
    for i in range(k - 1, len(R2)):
        w = R2[i - k + 1:i + 1]
        out[i] = np.where((~np.isnan(w)).sum(0) >= max(1, k - 2), np.nanmean(w, axis=0), np.nan)
    return out


def har(R, RV):
    """Pronóstico HAR en logaritmos, pooled, sólo con el pasado."""
    R2 = R ** 2
    f1, f5, f22 = media_movil(R2, 1), media_movil(R2, 5), media_movil(R2, 22)
    eps = 1e-10
    X = np.stack([np.log(f1 + eps), np.log(f5 + eps), np.log(f22 + eps)], -1)   # (T, N, 3)
    Y = np.log(RV ** 2 + eps)                                                   # vol futura (ya «del futuro»)
    T, N = R.shape
    out = np.full((T, N), np.nan)
    beta = None
    for i in range(CALENT - 20, T):
        if beta is None or i % 20 == 0:
            a = max(30, i - 500)
            b = i - H                     # el realizado de b ya se conoce en i
            Xs = X[a:b].reshape(-1, 3); ys = Y[a:b].reshape(-1)
            ok = ~np.isnan(Xs).any(1) & ~np.isnan(ys)
            if ok.sum() > 500:
                A = np.c_[np.ones(ok.sum()), Xs[ok]]
                beta = np.linalg.lstsq(A, ys[ok], rcond=None)[0]
        if beta is not None:
            p = beta[0] + X[i] @ beta[1:]
            out[i] = np.sqrt(np.exp(p))
    return out


# ───────────────────────────── la cadena de MIIA, con etiqueta de volatilidad ─────────────────────────────

def cadena_vol(P, nombres, semilla=7):
    T = len(P)
    R = np.r_[[np.full(len(nombres), np.nan)], P[1:] / P[:-1] - 1]
    g = np.random.default_rng(semilla)
    hist = {n: [] for n in nombres}
    norm = s50.NormLento(22)
    redes = [s50.RedEnLinea(22, 16, 0.01, 1), s50.RedEnLinea(22, 16, 0.003, 2)]
    bases = [s50.BaseEWMA(600), s50.BaseEWMA(600)]
    pend, dep, out, vistos = {}, [], np.full(P.shape, np.nan), 0
    for i in range(1, T):
        hoy = {n: R[i, j] for j, n in enumerate(nombres)
               if not np.isnan(R[i, j]) and len(hist[n]) >= s50.HIST_MIN}
        if i - H in pend:                                   # madura la vol de los 2 días
            fut = {}
            for j, n in enumerate(nombres):
                r = R[i - H + 1:i + 1, j]
                if not np.isnan(r).any():
                    fut[n] = math.sqrt(float(np.mean(r ** 2)))
            if fut:
                med = float(np.median(list(fut.values())))
                nuevos = 0
                for n, x in pend.pop(i - H):
                    if n not in fut or fut[n] == med:
                        continue
                    y = 1.0 if fut[n] > med else 0.0
                    for red in redes:
                        red.paso(x, y)
                    nuevos += 1
                    if nuevos % 4 == 0 and dep:
                        xv, yv = dep[g.integers(len(dep))]
                        for red in redes:
                            red.paso(xv, yv)
                    vistos += 1
                    if len(dep) < 10000:
                        dep.append((x, y))
                    else:
                        k = g.integers(vistos)
                        if k < 10000:
                            dep[k] = (x, y)
        if len(hoy) >= 10:
            xs = {n: norm(v) for n, v in s50.vector(hoy, hist).items()}
            for n, x in xs.items():
                zs = []
                for red, base in zip(redes, bases):
                    p, _ = red.salida(x)
                    zs.append(base.z(p)); base.observar(p)
                out[i, nombres.index(n)] = float(np.mean(zs))
            pend[i] = list(xs.items())
        for j, n in enumerate(nombres):
            if not np.isnan(R[i, j]):
                hist[n].append(R[i, j])
    return out


# ───────────────────────────── medición ─────────────────────────────

def medir(universo, P, nombres):
    T, N = P.shape
    R = np.r_[[np.full(N, np.nan)], P[1:] / P[:-1] - 1]
    RV = np.full((T, N), np.nan)
    for i in range(T - H):
        RV[i] = np.sqrt(np.mean(R[i + 1:i + 1 + H] ** 2, axis=0))
    ing, v20, ew, lar = clasicos(R)
    F = {"ingenuo (|hoy|)": ing, "vol 20 días": v20, "EWMA 0,94": ew, "HAR": har(R, RV),
         "MIIA (cadena)": cadena_vol(P, nombres)}
    idx = list(range(CALENT, T - H, H))
    print(f"\n══ {universo}: {N} instrumentos · {len(idx)} ventanas de 2 días sin solapar ══")

    def pares(f, relativo):
        out = []
        for i in idx:
            s, r = {}, {}
            for j, n in enumerate(nombres):
                a, b, l = f[i, j], RV[i, j], lar[i, j]
                if np.isnan(a) or np.isnan(b) or b <= 0:
                    continue
                if relativo:
                    if np.isnan(l) or l <= 0:
                        continue
                    # MIIA da un puntaje, no un nivel: no se puede dividir por la vol;
                    # a su rango se le saca el de la vol de siempre (más abajo)
                    s[n] = a if f is F["MIIA (cadena)"] else math.log(max(a, 1e-10) / l)
                    r[n] = math.log(b / l)
                else:
                    s[n] = a; r[n] = b
            if relativo and f is F["MIIA (cadena)"] and len(s) >= 3:
                ks = list(s)
                a_ = np.array([s[k] for k in ks]).argsort().argsort().astype(float)
                l_ = np.array([math.log(lar[i, nombres.index(k)]) for k in ks]).argsort().argsort().astype(float)
                a_ -= a_.mean(); l_ -= l_.mean()
                res_ = a_ - l_ * (a_ @ l_) / (l_ @ l_) if (l_ @ l_) > 0 else a_
                s = {k: float(v) for k, v in zip(ks, res_)}
            if len(s) >= rank_ic.MIN_INSTRUMENTOS:
                out.append((s, r))
        return out

    res = {}
    for preg, rel in (("1 · ¿quién se va a mover más?", False),
                      ("2 · ¿quién se va a mover más DE LO QUE SUELE?", True)):
        print(f"  {preg}")
        for nom, f in F.items():
            pp = pares(f, rel)
            s = rank_ic.serie_ic([[(n, a[n], b[n]) for n in a if n in b] for a, b in pp])
            res[(rel, nom)] = s["rank_ic_serie"]
            extra = ""
            if nom == "MIIA (cadena)":
                pl = s50.placebo_desplazado(pp, 200, 56)
                extra = f" · placebo 95 % {np.quantile(pl, .95):+.3f}"
            ser = s["rank_ic_serie"]; h = len(ser) // 2
            print(f"    {nom:<18} IC {s['rank_ic']:+.3f} · MDE {s['rank_ic_min_detectable']:.3f}"
                  f" · mitades {np.mean(ser[:h]):+.3f}/{np.mean(ser[h:]):+.3f}{extra}")
    a, b = np.array(res[(True, "MIIA (cadena)")]), np.array(res[(True, "HAR")])
    if len(a) == len(b):
        d = a - b
        print(f"  MIIA − HAR en la pregunta 2: {d.mean():+.3f} ± {1.96*d.std(ddof=1)/math.sqrt(len(d)):.3f}"
              f" · MIIA mejor en {100*(d > 0).mean():.0f} % de las ventanas")

    # ¿y en el tiempo? para cada activo, ¿el pronóstico sigue a su propia vol?
    print("  3 · para cada activo, en el tiempo (Spearman pronóstico ↔ realizado, promedio de los activos)")
    for nom, f in F.items():
        cs = []
        for j in range(N):
            a = f[idx, j]; b = RV[idx, j]
            ok = ~np.isnan(a) & ~np.isnan(b)
            if ok.sum() > 50:
                cs.append(np.corrcoef(a[ok].argsort().argsort(), b[ok].argsort().argsort())[0, 1])
        print(f"    {nom:<18} {np.mean(cs):+.3f}")


def main():
    P, dias, nombres = s51.datos()
    print(f"ETFs: {dias[0]} a {dias[-1]}")
    medir("50 ETFs", P, nombres)
    D = json.loads(s50.GUARDADO.read_text(encoding="utf8"))
    dc = sorted(set().union(*[set(v) for v in D.values()]))
    nc = sorted(D)
    Pc = np.full((len(dc), len(nc)), np.nan)
    for j, n in enumerate(nc):
        for i, d in enumerate(dc):
            Pc[i, j] = D[n].get(d, np.nan)
    print(f"\nCriptos: {dc[0]} a {dc[-1]}")
    medir("31 criptos", Pc, nc)


if __name__ == "__main__":
    main()
