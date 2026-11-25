"""sim48_combinado_extremos.py — juntar las dos señales que sobrevivieron en sim47
y operar sólo los extremos (23-nov-2026). Medición; no toca producción.

Sólo los 14 ETFs de países (son los únicos donde esas señales existen). Decisión
a la APERTURA de NY del día t+1, con lo que ya se sabe a esa hora:
  A · retorno del índice local del día t+1 (Asia; Europa y América todavía no
      cerraron, valen 0 → no opinan)
  B · −(retorno del ETF el día t − retorno de su índice el día t)  (rebote)
Combinación FIJADA ANTES de mirar: promedio de los z-scores de A y B, 50/50,
sin ajustar nada a los datos. Realizado: apertura → cierre de t+1, relativo al
promedio de los 14.

Además del rank IC se mide lo que se ganaría comprando los k mejores y vendiendo
los k peores, con un costo de ida y vuelta por posición. Costos supuestos
(spread + impacto, ETFs de países): 0,05 % y 0,10 % por operación.

    python -X utf8 docs/simulaciones/sim48_combinado_extremos.py   # usa los datos de sim47
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("s47", AQUI / "sim47_datos_nuevos.py")
s47 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s47)
rank_ic = s47.rank_ic
ASIA_SET = set(s47.ASIA)


def main():
    if not s47.GUARDADO.exists():
        s47.bajar()
    D = json.loads(s47.GUARDADO.read_text(encoding="utf8"))
    dias = sorted(set.intersection(*[set(D[t]) for t in ("SPY", "QQQ", "XLK")]))
    N = len(dias)

    def serie(sim, campo=1):
        x = D.get(sim, {})
        return np.array([x[d][campo] if d in x and x[d][campo] is not None else np.nan for d in dias], float)

    def ff(a):
        a = a.copy()
        for k in range(1, N):
            if np.isnan(a[k]):
                a[k] = a[k - 1]
        return a

    P = [t for t in s47.PAISES if t in D and s47.PAISES[t][0] in D]
    C = {t: serie(t) for t in P}; O = {t: serie(t, 0) for t in P}
    I = {t: ff(serie(s47.PAISES[t][0])) for t in P}
    r = {t: np.r_[np.nan, C[t][1:] / C[t][:-1] - 1] for t in P}
    ir = {t: np.r_[np.nan, I[t][1:] / I[t][:-1] - 1] for t in P}

    def z(d):
        v = np.array(list(d.values()))
        s = v.std()
        return {k: (x - v.mean()) / s if s > 0 else 0.0 for k, x in d.items()}

    VA, VB, VC, spreads = [], [], [], {k: [] for k in (1, 2, 3)}
    for i in range(1, N - 1):
        A = {t: (ir[t][i + 1] if t in ASIA_SET else 0.0) for t in P}
        B = {t: -(r[t][i] - ir[t][i]) for t in P}
        R = {t: C[t][i + 1] / O[t][i + 1] - 1 for t in P}
        ok = [t for t in P if not any(np.isnan(x) for x in (A[t], B[t], R[t]))]
        if len(ok) < 8:
            continue
        m = np.mean([R[t] for t in ok])
        R = {t: R[t] - m for t in ok}
        A = {t: A[t] for t in ok}; B = {t: B[t] for t in ok}
        za, zb = z(A), z(B)
        S = {t: 0.5 * za[t] + 0.5 * zb[t] for t in ok}
        VA.append([(t, A[t], R[t]) for t in ok])
        VB.append([(t, B[t], R[t]) for t in ok])
        VC.append([(t, S[t], R[t]) for t in ok])
        orden = sorted(ok, key=lambda t: S[t])
        for k in spreads:
            spreads[k].append(np.mean([R[t] for t in orden[-k:]]) - np.mean([R[t] for t in orden[:k]]))

    print(f"{len(VC)} sesiones · {len(P)} ETFs de países\n")
    print("── rank IC (apertura → cierre, relativo) ──")
    for nom, V in (("A · índice asiático de la mañana", VA), ("B · rebote del ETF contra su índice", VB),
                   ("A + B, 50/50 fijado antes", VC)):
        s = rank_ic.serie_ic(V)
        ser = s["rank_ic_serie"]; h = len(ser) // 2
        print(f"  {nom:<38} IC {s['rank_ic']:+.4f} · MDE {s['rank_ic_min_detectable']:.4f} · t {s['rank_ic_t']:+.2f}"
              f" · mitades {np.mean(ser[:h]):+.3f}/{np.mean(ser[h:]):+.3f}")

    print("\n── operar sólo los extremos: comprar los k mejores, vender los k peores, cada día ──")
    for k, x in spreads.items():
        x = np.array(x)
        media, err = x.mean(), x.std(ddof=1) / math.sqrt(len(x))
        acierto = (x > 0).mean() * 100
        neto = {c: media - 2 * c for c in (0.0005, 0.0010)}      # ida y vuelta, las dos patas
        anual = lambda v: (1 + v) ** 252 - 1
        print(f"  k={k}: bruto {100*media:+.3f} % por día ± {196*err:.3f} · días ganadores {acierto:.1f} %"
              f" · neto con 0,05 %: {100*neto[0.0005]:+.3f} % · con 0,10 %: {100*neto[0.0010]:+.3f} %")
    print("\n  (el «por día» NO se anualiza a propósito: cualquier número que le gane a Buffett"
          " está mal leído)")


if __name__ == "__main__":
    main()
