"""sim59_vector_volatilidad.py — ¿sumarle al vector de class10 la volatilidad de
1, 5 y 22 días mejora a MIIA? (grupo B de ORDEN 7, 25-nov-2026). Medición; no
toca producción.

Es la prueba que hacía falta ANTES de tocar class10: cambiar el vector crea redes
nuevas (`mercado|25`) y corta la serie de ORDEN 6, así que sólo vale la pena si
mejora algo medible.

Misma cadena que sim51 (vector class10 → dos redes en línea con etiqueta relativa
y repaso → z con olvido → ranking) sobre los 50 ETFs con 5 años de Yahoo, dos
veces: con el vector de hoy (22 dims) y con 3 dims más (volatilidad realizada de
1, 5 y 22 días, en log). Mismo azar en las dos (misma semilla).

Dos preguntas, con lo esperado escrito ANTES de correr:
  1 · dirección a 2 días (lo que MIIA decide hoy): rank IC. Esperado: ~0 en las
      dos; la volatilidad no dice quién le gana al promedio.
  2 · volatilidad a 2 días «de lo que suele» (sim56): rank IC del puntaje de una
      cadena entrenada para eso. Esperado: con las 3 dims sube y se acerca a EWMA
      (+0,138 en sim56), porque recibe hecho lo que antes tenía que adivinar.

Veredicto que decide el grupo B:
  · si la 1 no mejora (diferencia pareada dentro de su banda), cambiar el vector
    de producción NO se justifica: corta la tesis sin ganar nada en lo que decide.

Resultado del 25-nov (50 ETFs, 5 años, ~500 ventanas de 2 días):
  1 · dirección: 22 dims −0,0062 · 25 dims −0,0116 → diferencia −0,005 ± 0,016,
      no se distingue. Se cumplió lo esperado.
  2 · volatilidad: 22 dims +0,115 · 25 dims +0,121 → diferencia +0,005 ± 0,007,
      no se distingue. FALLÓ lo esperado: las 3 dims no la acercan a EWMA (+0,138).
  Veredicto: el grupo B NO va a producción. Cambiar el vector cortaría la serie de
  ORDEN 6 sin mejorar nada medible; para la volatilidad alcanza con la fórmula
  EWMA del grupo A.

    python -X utf8 docs/simulaciones/sim59_vector_volatilidad.py
"""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent


def _cargar(nombre, archivo):
    spec = importlib.util.spec_from_file_location(nombre, AQUI / archivo)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


s50 = _cargar("s50", "sim50_cripto.py")
s51 = _cargar("s51", "sim51_etf_plazos.py")
s56 = _cargar("s56", "sim56_volatilidad.py")
rank_ic = s50.rank_ic
H = 2


def vector_ext(hoy, hist):
    base = s50.vector(hoy, hist)
    out = {}
    for t, v in base.items():
        h = np.array(hist[t] + [hoy[t]])
        v1 = abs(hoy[t])
        v5 = np.sqrt(np.mean(h[-5:] ** 2)); v22 = np.sqrt(np.mean(h[-22:] ** 2))
        out[t] = np.r_[v, np.log(v1 + 1e-5), np.log(v5 + 1e-5), np.log(v22 + 1e-5)]
    return out


def cadena(P, nombres, extra, objetivo, semilla=7):
    """objetivo: 'dir' (le gana al promedio en H) o 'vol' (se mueve más que la mediana)."""
    T = len(P); D = 25 if extra else 22
    R = np.r_[[np.full(len(nombres), np.nan)], P[1:] / P[:-1] - 1]
    g = np.random.default_rng(semilla)
    hist = {n: [] for n in nombres}
    norm = s50.NormLento(D)
    redes = [s50.RedEnLinea(D, 16, 0.01, 1), s50.RedEnLinea(D, 16, 0.003, 2)]
    bases = [s50.BaseEWMA(600), s50.BaseEWMA(600)]
    pend, dep, sc, vistos = {}, [], {}, 0
    for i in range(1, T):
        hoy = {n: R[i, j] for j, n in enumerate(nombres)
               if not np.isnan(R[i, j]) and len(hist[n]) >= s50.HIST_MIN}
        if i - H in pend:
            fut = {}
            for j, n in enumerate(nombres):
                if objetivo == "dir":
                    if not (np.isnan(P[i, j]) or np.isnan(P[i - H, j])):
                        fut[n] = P[i, j] / P[i - H, j] - 1
                else:
                    r = R[i - H + 1:i + 1, j]
                    if not np.isnan(r).any():
                        fut[n] = math.sqrt(float(np.mean(r ** 2)))
            if fut:
                ref = np.mean(list(fut.values())) if objetivo == "dir" else float(np.median(list(fut.values())))
                nuevos = 0
                for n, x in pend.pop(i - H):
                    if n not in fut or fut[n] == ref:
                        continue
                    y = 1.0 if fut[n] > ref else 0.0
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
            vec = vector_ext(hoy, hist) if extra else s50.vector(hoy, hist)
            xs = {n: norm(v) for n, v in vec.items()}
            z = {}
            for n, x in xs.items():
                zs = []
                for red, base in zip(redes, bases):
                    p, _ = red.salida(x)
                    zs.append(base.z(p)); base.observar(p)
                z[n] = float(np.mean(zs))
            sc[i] = z
            pend[i] = list(xs.items())
        for j, n in enumerate(nombres):
            if not np.isnan(R[i, j]):
                hist[n].append(R[i, j])
    return sc, R


def ventanas_dir(P, nombres, sc):
    T = len(P); out = []
    for i in [i for i in sorted(sc) if i >= 250 and i + H < T][::H]:
        r = P[i + H] / P[i] - 1; m = np.nanmean(r)
        rr = {nombres[j]: r[j] - m for j in range(len(nombres)) if not np.isnan(r[j])}
        out.append([(n, s, rr[n]) for n, s in sc[i].items() if n in rr])
    return out


def ventanas_vol(P, nombres, sc, R):
    """Pregunta 2 de sim56: realizado = log(vol 2d / vol del último año); al
    puntaje se le saca, en rangos, la parte de la vol de siempre."""
    T = len(P); out = []
    for i in [i for i in sorted(sc) if i >= 260 and i + H < T][::H]:
        ks, a, l, rv = [], [], [], []
        for j, n in enumerate(nombres):
            if n not in sc[i]:
                continue
            fut = R[i + 1:i + 1 + H, j]; w = R[i - 249:i + 1, j]
            if np.isnan(fut).any() or (~np.isnan(w)).sum() < 200:
                continue
            lar = np.nanstd(w); v2 = math.sqrt(float(np.mean(fut ** 2)))
            if lar <= 0 or v2 <= 0:
                continue
            ks.append(n); a.append(sc[i][n]); l.append(math.log(lar)); rv.append(math.log(v2 / lar))
        if len(ks) < rank_ic.MIN_INSTRUMENTOS:
            continue
        a = np.array(a).argsort().argsort().astype(float); l = np.array(l).argsort().argsort().astype(float)
        a -= a.mean(); l -= l.mean()
        res = a - l * (a @ l) / (l @ l) if (l @ l) > 0 else a
        out.append([(k, float(x), r) for k, x, r in zip(ks, res, rv)])
    return out


def resumen(nom, w):
    s = rank_ic.serie_ic(w)
    print(f"  {nom:<34} IC {s['rank_ic']:+.4f} · MDE {s['rank_ic_min_detectable']:.4f} · n {s['rank_ic_ventanas']}")
    return np.array(s["rank_ic_serie"])


def pareada(nom, a, b):
    if len(a) != len(b) or len(a) < 3:
        print(f"  {nom}: series de distinto largo"); return
    d = b - a
    e = 1.96 * d.std(ddof=1) / math.sqrt(len(d))
    print(f"  {nom}: {d.mean():+.4f} ± {e:.4f} → {'MEJORA' if d.mean() - e > 0 else 'EMPEORA' if d.mean() + e < 0 else 'no se distingue'}")


def main():
    P, dias, nombres = s51.datos()
    print(f"{len(nombres)} ETFs · {len(dias)} ruedas ({dias[0]} a {dias[-1]})\n")
    print("── 1 · Dirección a 2 días (lo que MIIA decide) ──")
    s22, R = cadena(P, nombres, False, "dir"); s25, _ = cadena(P, nombres, True, "dir")
    a = resumen("vector de hoy (22 dims)", ventanas_dir(P, nombres, s22))
    b = resumen("vector + vol 1/5/22 días (25)", ventanas_dir(P, nombres, s25))
    pareada("diferencia 25 − 22", a, b)
    print("\n── 2 · Volatilidad a 2 días, «más de lo que suele» (sim56: EWMA +0,138) ──")
    v22, _ = cadena(P, nombres, False, "vol"); v25, _ = cadena(P, nombres, True, "vol")
    a = resumen("vector de hoy (22 dims)", ventanas_vol(P, nombres, v22, R))
    b = resumen("vector + vol 1/5/22 días (25)", ventanas_vol(P, nombres, v25, R))
    pareada("diferencia 25 − 22", a, b)


if __name__ == "__main__":
    main()
