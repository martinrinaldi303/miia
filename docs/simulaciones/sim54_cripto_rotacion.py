"""sim54_cripto_rotacion.py — portafolio de MIIA sobre criptos, sólo comprado,
con reglas para rotar menos (24-nov-2026). Medición; no toca producción.

La objeción de Martín: MIIA arma un portafolio diversificado, no opera un
activo por vez, así que las comisiones no deberían comerse la ganancia. La
prueba del 24-nov (fila «sin reglas») mostró que el ranking cambia tanto que en
cada rebalanceo se reemplaza más de la mitad del portafolio. Acá se prueban dos
reglas para rotar menos, FIJADAS ANTES de mirar:

  · suavizado: el puntaje es el promedio de los últimos m días (m = 1, 5, 10)
  · margen: entra si está en el 15 % de arriba; sale sólo si cae fuera del 30 %

Portafolio: pesos iguales entre las criptos elegidas, rebalanceo cada 2 días (el
plazo de MIIA) y cada 7. Se compara contra tener TODAS por partes iguales sin
tocar nada. Comisión 0,1 % por operación (exchange grande, sin descuentos), cobrada
sólo sobre lo que cambia. Desde el 2º año (el 1º sólo entrena).

Placebo: las mismas reglas con puntajes AL AZAR que también se suavizan, 100 veces.
Así se ve cuánto de la ganancia (o de la rotación) sale de las reglas y no de MIIA.

⚠️ Son 12 combinaciones: alguna puede dar positiva por azar. Lo que cuenta es
que la ganancia neta supere su margen de error y al placebo.

    python -X utf8 docs/simulaciones/sim54_cripto_rotacion.py
"""
from __future__ import annotations

import importlib.util
import json
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
COMISION = 0.001
ENTRA, SALE = 0.15, 0.30


def datos():
    D = json.loads(s50.GUARDADO.read_text(encoding="utf8")) if s50.GUARDADO.exists() else s50.bajar()
    nombres = sorted(D)
    dias = sorted(set().union(*[set(v) for v in D.values()]))
    P = np.full((len(dias), len(nombres)), np.nan)
    for j, n in enumerate(nombres):
        for i, d in enumerate(dias):
            P[i, j] = D[n].get(d, np.nan)
    return P, dias, nombres


def matriz_scores(scores, T, nombres):
    """{día: {moneda: z}} → matriz T × monedas (NaN donde no hay puntaje)."""
    idx = {n: j for j, n in enumerate(nombres)}
    Z = np.full((T, len(nombres)), np.nan)
    for i, v in scores.items():
        for n, z in v.items():
            Z[i, idx[n]] = z
    return Z


def suavizar(Z, m):
    """Promedio de los últimos m puntajes disponibles de cada moneda (sólo pasado)."""
    if m == 1:
        return Z
    out = np.full_like(Z, np.nan)
    for j in range(Z.shape[1]):
        col = Z[:, j]
        ok = np.where(~np.isnan(col))[0]
        if len(ok) == 0:
            continue
        c = np.cumsum(col[ok])
        prom = np.array([(c[k] - (c[k - m] if k >= m else 0)) / min(m, k + 1) for k in range(len(ok))])
        out[ok, j] = prom
    return out


def portafolio(P, nombres, Z, H, margen, dias_ok):
    """Z: matriz de puntajes YA suavizados. Devuelve (extra, rotación) por período."""
    T = len(P)
    dias = [i for i in dias_ok if i >= 365 and i + H < T][::H]
    tenidas, extra, rot = set(), [], []
    for i in dias:
        sc = {nombres[j]: Z[i, j] for j in range(len(nombres)) if not np.isnan(Z[i, j])}
        idx = {n: j for j, n in enumerate(nombres)}
        ok = [n for n in sc if not np.isnan(P[i + H, idx[n]])]
        orden = sorted(ok, key=sc.get, reverse=True)
        k_in = max(1, round(len(ok) * ENTRA))
        if margen:
            k_out = max(k_in, round(len(ok) * SALE))
            quedan = {n for n in tenidas if n in orden[:k_out]}
            nuevas = [n for n in orden[:k_in] if n not in quedan]
            elegidas = set(quedan) | set(nuevas[:max(0, k_in - len(quedan))])
            if not elegidas:
                elegidas = set(orden[:k_in])
        else:
            elegidas = set(orden[:k_in])
        w_new = {n: 1 / len(elegidas) for n in elegidas}
        w_old = {n: 1 / len(tenidas) for n in tenidas} if tenidas else {}
        rot.append(sum(abs(w_new.get(n, 0) - w_old.get(n, 0)) for n in set(w_new) | set(w_old)))
        r = {n: P[i + H, idx[n]] / P[i, idx[n]] - 1 for n in ok}
        extra.append(np.mean([r[n] for n in elegidas]) - np.mean(list(r.values())))
        tenidas = elegidas
    return np.array(extra), np.array(rot)


def main():
    P, dias, nombres = datos()
    print(f"{len(nombres)} criptos · {len(dias)} días ({dias[0]} a {dias[-1]}) · comisión {100*COMISION:.1f} % por operación\n")
    g = np.random.default_rng(54)
    for H in (2, 7):
        scores = s51.cadena(P, nombres, H)
        Z = matriz_scores(scores, len(P), nombres)
        dias_ok = sorted(scores)
        mascara = ~np.isnan(Z)
        print(f"══ rebalanceo cada {H} días ══")
        for m in (1, 5, 10):
            Zs = suavizar(Z, m)
            for margen in (False, True):
                ex, rot = portafolio(P, nombres, Zs, H, margen, dias_ok)
                neto = ex - rot * COMISION
                e = 1.96 * neto.std(ddof=1) / math.sqrt(len(neto))
                # placebo: mismas reglas, puntajes al azar (también suavizados)
                pl = []
                for _ in range(100):
                    Zr = np.where(mascara, g.standard_normal(Z.shape), np.nan)
                    exr, rotr = portafolio(P, nombres, suavizar(Zr, m), H, margen, dias_ok)
                    pl.append((exr - rotr * COMISION).mean())
                pl = np.array(pl)
                nom = f"promedio {m:2d} día{'s' if m > 1 else ' '} · {'con margen' if margen else 'sin margen'}"
                base = " ← la prueba anterior (sin reglas)" if (m == 1 and not margen) else ""
                print(f"  {nom:<34} rotación {100*rot.mean()/2:5.1f} % del portafolio · extra bruto {100*ex.mean():+.3f} %"
                      f" · costo {100*(rot*COMISION).mean():.3f} % · NETO {100*neto.mean():+.3f} % ± {100*e:.3f}"
                      f" · placebo neto {100*pl.mean():+.3f} % (95 % ≤ {100*np.quantile(pl,.95):+.3f}){base}")
        print()
    print("  (rotación = parte del portafolio que se vende y se recompra en cada rebalanceo)")


if __name__ == "__main__":
    main()
