"""sim52_otros_activos.py — la cadena de MIIA sobre otros tipos de activos, 5 años
(24-nov-2026). Medición; no toca producción.

Misma cadena que sim50/sim51 (vector class10 → dos redes en línea con etiqueta
relativa y repaso → z con olvido → ranking k = n × 2/13), mismo placebo y la
misma medición, sobre cinco universos distintos de Yahoo Finance (5 años,
diario), a 2 ruedas (el plazo de hoy) y a 5 (una semana):

  acciones grandes de EE.UU. · acciones argentinas (ADR en Nueva York) ·
  monedas contra el dólar · materias primas (futuros continuos) · bonos (ETF)

Costos de ida y vuelta por posición, supuestos por tipo de activo (spread +
comisión de un broker minorista): acciones EE.UU. 0,05 % · ADR argentinos 0,20 %
· monedas 0,02 % · futuros 0,05 % · bonos 0,03 %.

⚠️ Advertencias:
  · Sesgo de supervivencia: las listas son las de HOY (más fuerte en acciones).
  · Los futuros continuos de Yahoo tienen saltos al cambiar de contrato: meten
    ruido en materias primas.
  · El «cierre» de las monedas en Yahoo es ~medianoche de Londres; dentro del
    universo de monedas todas usan la misma hora, así que el orden es comparable.
  · Son 10 mediciones (5 universos × 2 plazos): alguna puede salir «buena» por
    azar. Vale sólo si supera el placebo con margen Y se sostiene en las dos mitades.

    python -X utf8 docs/simulaciones/sim52_otros_activos.py --bajar   # descarga (~2 min)
    python -X utf8 docs/simulaciones/sim52_otros_activos.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
GUARDADO = AQUI / "datos" / "otros_activos_yahoo.json"


def _cargar(nombre, archivo):
    spec = importlib.util.spec_from_file_location(nombre, AQUI / archivo)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


s47 = _cargar("s47", "sim47_datos_nuevos.py")
s51 = _cargar("s51", "sim51_etf_plazos.py")

UNIVERSOS = {
    "Acciones grandes de EE.UU.": (0.0005, [
        "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "BRK-B", "JPM", "V",
        "UNH", "XOM", "JNJ", "PG", "MA", "HD", "CVX", "MRK", "ABBV", "PEP",
        "KO", "AVGO", "COST", "WMT", "BAC", "MCD", "CSCO", "CRM", "ADBE", "TMO",
        "NFLX", "AMD", "INTC", "DIS", "NKE", "ORCL", "PFE", "CAT", "BA", "GS"]),
    "Acciones argentinas (ADR)": (0.0020, [
        "GGAL", "YPF", "PAM", "BMA", "CEPU", "TGS", "LOMA", "CRESY", "IRS", "SUPV",
        "TEO", "EDN", "BBAR", "CAAP", "TX", "MELI", "GLOB", "DESP"]),
    "Monedas contra el dólar": (0.0002, [
        "EURUSD=X", "JPY=X", "GBPUSD=X", "AUDUSD=X", "CAD=X", "CHF=X", "NZDUSD=X", "MXN=X",
        "BRL=X", "ZAR=X", "TRY=X", "INR=X", "KRW=X", "CNY=X", "SEK=X", "NOK=X", "PLN=X", "CLP=X"]),
    "Materias primas (futuros)": (0.0005, [
        "CL=F", "BZ=F", "NG=F", "HO=F", "RB=F", "GC=F", "SI=F", "HG=F", "PL=F", "PA=F",
        "ZC=F", "ZW=F", "ZS=F", "KC=F", "SB=F", "CC=F", "CT=F", "LE=F", "HE=F", "OJ=F"]),
    "Bonos (ETF)": (0.0003, [
        "TLT", "IEF", "SHY", "IEI", "LQD", "HYG", "JNK", "EMB", "TIP", "AGG",
        "BND", "MUB", "BNDX", "VCIT", "VCSH", "GOVT", "MBB", "SHV"]),
}
PLAZOS = {"2 días (hoy)": 2, "1 semana": 5}


def bajar():
    datos = {}
    for _, (_, sims) in UNIVERSOS.items():
        for s in sims:
            for intento in range(3):
                try:
                    datos[s] = s47._yahoo(s)
                    break
                except Exception as e:
                    if intento == 2:
                        print(f"  ⚠️ {s}: {e}")
                    time.sleep(2)
            time.sleep(0.3)
    GUARDADO.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf8")
    print(f"bajados {len(datos)} símbolos → {GUARDADO.name}")
    return datos


def matriz(D, sims):
    nombres = [s for s in sims if s in D and len(D[s]) > 300]
    dias = sorted(set().union(*[set(D[s]) for s in nombres]))
    P = np.full((len(dias), len(nombres)), np.nan)
    for j, s in enumerate(nombres):
        for i, d in enumerate(dias):
            v = D[s].get(d)
            if v and v[1] and v[1] > 0:
                P[i, j] = v[1]
    # un día con menos de la mitad de los instrumentos no es una rueda del universo
    ok = (~np.isnan(P)).sum(1) >= len(nombres) / 2
    return P[ok], [d for d, k in zip(dias, ok) if k], nombres


def main():
    import urllib.parse  # noqa: F401  (lo usa s47._yahoo)
    D = bajar() if ("--bajar" in sys.argv or not GUARDADO.exists()) else \
        json.loads(GUARDADO.read_text(encoding="utf8"))
    filas = []
    for univ, (costo, sims) in UNIVERSOS.items():
        P, dias, nombres = matriz(D, sims)
        print(f"\n══ {univ}: {len(nombres)} instrumentos · {len(dias)} ruedas ({dias[0]} a {dias[-1]}) ══")
        for nom, H in PLAZOS.items():
            r = s51.medir(P, nombres, s51.cadena(P, nombres, H), H)
            veredicto = ("SEÑAL" if r["ic"] > r["mde"] and r["pct"] < 5 and r["m1"] > 0 and r["m2"] > 0
                         else "ruido")
            print(f"  {nom:<13} rank IC {r['ic']:+.4f} (MDE {r['mde']:.4f}, t {r['t']:+.2f}, n {r['n']})"
                  f" · placebo 95 % {r['p95']:+.4f} · azar la iguala {r['pct']:5.1f} %"
                  f" · mitades {r['m1']:+.3f}/{r['m2']:+.3f} → {veredicto}")
            print(f"  {'':<13} ventaja {100*(r['acc']-r['azar']):+.1f} ± {100*r['hw']:.1f} pp"
                  f" · comprar mejores / vender peores: bruto {100*r['sp']:+.3f} % ± {100*r['sp_e']:.3f}"
                  f" · neto ({100*costo:.2f} %): {100*(r['sp']-2*costo):+.3f} % por período")
            filas.append((univ, nom, r["ic"], r["mde"], r["pct"], r["sp"] - 2 * costo, veredicto))
    print("\n── Resumen ──")
    for u, n, ic, mde, pct, neto, v in filas:
        print(f"  {u:<28} {n:<13} IC {ic:+.4f} · MDE {mde:.4f} · azar {pct:5.1f} % · neto {100*neto:+.3f} % → {v}")


if __name__ == "__main__":
    main()
