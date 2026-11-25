"""sim49_placebo.py — el placebo de sim47 + sim48 (23-nov-2026).

Pregunta: si en vez de datos reales hubiéramos probado 10 señales AL AZAR,
elegido las 2 mejores y juntado 50/50 (exactamente lo que se hizo en sim47 →
sim48), ¿qué tan seguido saldría un rank IC tan bueno como el de sim48
(+0,0285, sobre su MDE, positivo en las dos mitades)?

Mismos retornos reales que sim48 (14 ETFs de países, apertura → cierre,
relativo), 2.000 repeticiones. Si el resultado real cae en la cola (<5 %),
la selección no lo explica. Si no, lo de sim48 puede ser suerte de elegir.

    python -X utf8 docs/simulaciones/sim49_placebo.py
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("s47", AQUI / "sim47_datos_nuevos.py")
s47 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s47)

REAL_IC, REPETICIONES, SENALES, ELEGIDAS = 0.0285, 2000, 10, 2


def rangos(M):
    """Rangos por fila (sin empates: los datos son continuos)."""
    return M.argsort(1).argsort(1).astype(float)


def ic_por_dia(S, R):
    a = rangos(S); b = rangos(R)
    a -= a.mean(1, keepdims=True); b -= b.mean(1, keepdims=True)
    return (a * b).sum(1) / np.sqrt((a * a).sum(1) * (b * b).sum(1))


def resumen(ics):
    n = len(ics); m = ics.mean(); sd = ics.std(ddof=1)
    mde = 1.96 * sd / np.sqrt(n); h = n // 2
    return m, mde, ics[:h].mean() > 0 and ics[h:].mean() > 0


def main():
    D = json.loads(s47.GUARDADO.read_text(encoding="utf8"))
    dias = sorted(set.intersection(*[set(D[t]) for t in ("SPY", "QQQ", "XLK")]))
    P = [t for t in s47.PAISES if t in D]
    filas = []
    for i in range(1, len(dias)):
        d = dias[i]
        v = []
        for t in P:
            x = D[t].get(d)
            v.append(x[1] / x[0] - 1 if x and x[0] and x[1] else np.nan)
        if not np.isnan(v).any():
            filas.append(v)
    R = np.array(filas)
    R -= R.mean(1, keepdims=True)
    T, K = R.shape
    print(f"{T} sesiones completas · {K} ETFs de países · {REPETICIONES} repeticiones\n")

    g = np.random.default_rng(42)
    mejor_sola, comb, pasa = [], [], 0
    for _ in range(REPETICIONES):
        S = g.standard_normal((SENALES, T, K))
        medias = []
        ics = []
        for s in range(SENALES):
            ic = ic_por_dia(S[s], R)
            ics.append(ic); medias.append(ic.mean())
        top = np.argsort(medias)[-ELEGIDAS:]
        mejor_sola.append(max(medias))
        z = S[top] / S[top].std(2, keepdims=True)
        C = z.mean(0)
        m, mde, estable = resumen(ic_por_dia(C, R))
        comb.append(m)
        if m >= REAL_IC and m > mde and estable:
            pasa += 1
    comb = np.array(comb); mejor_sola = np.array(mejor_sola)
    print("── Qué produce el AZAR con el mismo procedimiento ──")
    print(f"  mejor de 10 señales al azar:   IC típico {np.median(mejor_sola):+.4f} · el 5 % más alto ≥ {np.quantile(mejor_sola, .95):+.4f}")
    print(f"  las 2 mejores juntas (50/50):  IC típico {np.median(comb):+.4f} · el 5 % más alto ≥ {np.quantile(comb, .95):+.4f}")
    print(f"  veces que el azar iguala a sim48 (≥ +{REAL_IC:.4f}, sobre el MDE y estable): "
          f"{pasa} de {REPETICIONES} = {100*pasa/REPETICIONES:.1f} %")
    print("\n  Lectura: < 5 % → la selección no explica sim48 · ≥ 5 % → sim48 puede ser suerte de elegir")


if __name__ == "__main__":
    main()
