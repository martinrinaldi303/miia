"""sim51_etf_plazos.py — la cadena de MIIA sobre los 50 ETFs con 5 años de
historia, y con tres plazos de predicción: 2 días (el de hoy), 1 semana y 1 mes.
(24-nov-2026). Medición; no toca producción.

Contesta dos preguntas de Martín:
  1 · Si MIIA hubiera arrancado con años de historia de precios, ¿habría aprendido
      a ordenar los 50 ETFs?
  2 · ¿Mejora si en vez de 48 h predice a una semana o a un mes?

Usa las piezas de sim50 (vector class10, dos redes en línea con etiqueta
relativa y repaso, z contra base con olvido, ranking k = n × 2/13) y los datos
diarios de Yahoo que bajó sim47 (5 años, sólo días de rueda del NYSE).

Para cada plazo H (en ruedas: 2, 5, 21):
  · las redes aprenden la etiqueta relativa a H ruedas (madura H ruedas después)
  · rank IC contra el retorno relativo de las H ruedas siguientes, con ventanas
    SIN SOLAPAR (una cada H ruedas)
  · acierto contra el azar con la misma mezcla, banda entre ventanas
  · comprar los k mejores / vender los k peores por H ruedas, bruto y con
    costo de ida y vuelta de 0,05 % y 0,10 % por posición
  · placebo: la señal corrida en el tiempo, 1.000 veces, mismas ventanas

⚠️ Con plazos largos hay MUCHAS menos ventanas independientes (5 años ≈ 600 de
2 días, 250 de una semana, 60 de un mes): la medición se vuelve más gruesa.

    python -X utf8 docs/simulaciones/sim51_etf_plazos.py
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
s47 = _cargar("s47", "sim47_datos_nuevos.py")
rank_ic = s50.rank_ic
PLAZOS = {"2 días (hoy)": 2, "1 semana": 5, "1 mes": 21}


def datos():
    if not s47.GUARDADO.exists():
        s47.bajar()
    D = json.loads(s47.GUARDADO.read_text(encoding="utf8"))
    nombres = [t for t in s47.UNIVERSO if t in D]
    dias = sorted(set.intersection(*[set(D[t]) for t in ("SPY", "QQQ", "XLK")]))
    P = np.full((len(dias), len(nombres)), np.nan)
    for j, n in enumerate(nombres):
        for i, d in enumerate(dias):
            v = D[n].get(d)
            if v and v[1]:
                P[i, j] = v[1]
    return P, dias, nombres


def cadena(P, nombres, H, semilla=7):
    """La cadena de MIIA con horizonte H ruedas. Devuelve {día: {ticker: z}}."""
    T = len(P)
    R = np.r_[[np.full(len(nombres), np.nan)], P[1:] / P[:-1] - 1]
    g = np.random.default_rng(semilla)
    hist = {n: [] for n in nombres}
    norm = s50.NormLento(22)
    redes = [s50.RedEnLinea(22, 16, 0.01, 1), s50.RedEnLinea(22, 16, 0.003, 2)]
    bases = [s50.BaseEWMA(600), s50.BaseEWMA(600)]
    pendientes, deposito, scores = {}, [], {}
    vistos = 0
    for i in range(1, T):
        hoy = {n: R[i, j] for j, n in enumerate(nombres)
               if not np.isnan(R[i, j]) and len(hist[n]) >= s50.HIST_MIN}
        if i - H in pendientes:                       # maduran las de hace H ruedas
            fut = {nombres[j]: P[i, j] / P[i - H, j] - 1 for j in range(len(nombres))
                   if not (np.isnan(P[i, j]) or np.isnan(P[i - H, j]))}
            if fut:
                m = np.mean(list(fut.values()))
                nuevos = 0
                for n, x in pendientes.pop(i - H):
                    if n not in fut or abs(fut[n] - m) < 1e-9:
                        continue
                    y = 1.0 if fut[n] > m else 0.0
                    for red in redes:
                        red.paso(x, y)
                    nuevos += 1
                    if nuevos % 4 == 0 and deposito:
                        xv, yv = deposito[g.integers(len(deposito))]
                        for red in redes:
                            red.paso(xv, yv)
                    vistos += 1
                    if len(deposito) < 10000:
                        deposito.append((x, y))
                    else:
                        k = g.integers(vistos)
                        if k < 10000:
                            deposito[k] = (x, y)
        if len(hoy) >= 10:
            xs = {n: norm(v) for n, v in s50.vector(hoy, hist).items()}
            z = {}
            for n, x in xs.items():
                zs = []
                for red, base in zip(redes, bases):
                    p, _ = red.salida(x)
                    zs.append(base.z(p)); base.observar(p)
                z[n] = float(np.mean(zs))
            scores[i] = z
            pendientes[i] = list(xs.items())
        for j, n in enumerate(nombres):
            if not np.isnan(R[i, j]):
                hist[n].append(R[i, j])
    return scores


def medir(P, nombres, scores, H, calentamiento=250):
    T = len(P)
    dias = [i for i in sorted(scores) if i >= calentamiento and i + H < T][::H]   # sin solapar

    def rel(i):
        r = P[i + H] / P[i] - 1
        m = np.nanmean(r)
        return {nombres[j]: r[j] - m for j in range(len(nombres)) if not np.isnan(r[j])}

    ventanas, spread, ok_n, nb, up, tot = [], [], [], 0, 0, 0
    for i in dias:
        rr = rel(i)
        ventanas.append([(n, s, rr[n]) for n, s in scores[i].items() if n in rr])
        orden = sorted([n for n in scores[i] if n in rr], key=scores[i].get)
        k = max(1, round(len(orden) * s50.FRACCION))
        spread.append(np.mean([rr[n] for n in orden[-k:]]) - np.mean([rr[n] for n in orden[:k]]))
        a = n_ = 0
        for n, senal in [(n, "SELL") for n in orden[:k]] + [(n, "BUY") for n in orden[-k:]]:
            if abs(rr[n]) < 1e-9:
                continue
            gano = rr[n] > 0
            a += gano if senal == "BUY" else not gano
            n_ += 1; nb += senal == "BUY"; up += gano; tot += 1
        ok_n.append((a, n_))
    s = rank_ic.serie_ic(ventanas)
    acc, hw = s50.banda_entre_ventanas(ok_n)
    q, p = nb / tot, up / tot
    azar = q * p + (1 - q) * (1 - p)
    sp = np.array(spread)
    # placebo: la señal corrida en el tiempo contra los retornos (conserva su
    # persistencia; ver s50.placebo_desplazado)
    plac = s50.placebo_desplazado([(scores[i], rel(i)) for i in dias], 1000, 51)
    serie = s["rank_ic_serie"]; h = len(serie) // 2
    return dict(ic=s["rank_ic"], mde=s["rank_ic_min_detectable"], t=s["rank_ic_t"], n=s["rank_ic_ventanas"],
                m1=np.mean(serie[:h]), m2=np.mean(serie[h:]), acc=acc, hw=hw, azar=azar,
                sp=sp.mean(), sp_e=1.96 * sp.std(ddof=1) / math.sqrt(len(sp)),
                p95=np.quantile(plac, .95), pct=(plac >= s["rank_ic"]).mean() * 100)


def main():
    P, dias, nombres = datos()
    print(f"{len(nombres)} ETFs · {len(dias)} ruedas ({dias[0]} a {dias[-1]}) · "
          f"el primer año sólo entrena (no se mide)\n")
    for nom, H in PLAZOS.items():
        r = medir(P, nombres, cadena(P, nombres, H), H)
        print(f"── {nom} ({H} ruedas) ──")
        print(f"  rank IC {r['ic']:+.4f} · MDE {r['mde']:.4f} · t {r['t']:+.2f} · {r['n']} ventanas sin solapar"
              f" · mitades {r['m1']:+.3f}/{r['m2']:+.3f}")
        print(f"  placebo: el 5 % más alto ≥ {r['p95']:+.4f} · el placebo iguala a MIIA el {r['pct']:.1f} % de las veces")
        print(f"  acierto {100*r['acc']:.1f} % · azar {100*r['azar']:.1f} % · ventaja {100*(r['acc']-r['azar']):+.1f} ± {100*r['hw']:.1f} pp")
        print(f"  comprar k mejores / vender k peores por período: bruto {100*r['sp']:+.3f} % ± {100*r['sp_e']:.3f}"
              f" · neto 0,05 %: {100*(r['sp']-0.001):+.3f} % · neto 0,10 %: {100*(r['sp']-0.002):+.3f} %\n")


if __name__ == "__main__":
    main()
