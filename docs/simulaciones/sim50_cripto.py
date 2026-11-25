"""sim50_cripto.py — la cadena entera de MIIA sobre las criptomonedas más grandes,
con placebo (23-nov-2026). Medición; no toca producción.

Lo mismo que hace MIIA con los 50 ETFs, pero sobre ~30 criptos (sin stablecoins
ni versiones envueltas), con barras diarias de Yahoo desde 2019:

  class10   vector por moneda: lo propio (retorno del día, retorno relativo,
            volatilidad, puesto, z contra su historia) + la distribución de
            todas (amplitud, dispersión, cuantiles, asimetría de Bowley, tamaño)
  class23/24  dos redes que aprenden EN LÍNEA con la etiqueta RELATIVA a 48 h,
            normalizador lento, repaso de ejemplos viejos (1 cada 4). Tasas
            distintas (rápida/lenta), como class23 y class24
  class25A  z de cada red contra su base con olvido (EWMA), voto parejo,
            RANKING transversal: BUY a los k mejores, SELL a los k peores,
            k = n × 2/13 (la fracción de producción)
  class43   etiqueta relativa a 48 h contra el promedio equiponderado
  endpoint  acierto, azar con la misma mezcla (Cohen), ventaja con banda entre
            ventanas de 48 h (t de Student), y rank IC por día (sin solapar)

Comparaciones, con el SIGNO escrito antes de correr:
  · rebote de 1 día (−retorno de ayer): +    · tendencia de 7 días: +
  · tendencia de 28 días: +   (la literatura cripto encuentra tendencia a 1-4 semanas)
  · PLACEBO: la señal de MIIA corrida en el tiempo contra los retornos (500 veces),
    que conserva su persistencia (24-nov; antes eran rankings al azar por ventana).

⚠️ Sesgo de supervivencia: la lista es la de HOY. Las monedas que se hundieron
y salieron del top no están, así que en 2019-2021 se mide un universo elegido
con el diario del lunes. Afecta más a la tendencia que al rebote.

⚠️ Las redes ven UN ejemplo por moneda y por día (en producción, ~380 por
etiqueta), así que las tasas se escalan: 0,01 y 0,003 en vez de 0,001 y 0,0003.

    python -X utf8 docs/simulaciones/sim50_cripto.py --bajar   # descarga (~1 min)
    python -X utf8 docs/simulaciones/sim50_cripto.py
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))
import rank_ic                                      # noqa: E402  código de producción

GUARDADO = AQUI / "datos" / "cripto_yahoo.json"
DESDE = 1546300800                      # 2019-01-01 UTC

# Las más grandes por capitalización (nov-2026), sin stablecoins ni envueltas.
# Algunas tienen un id numérico en Yahoo; se prueban alternativas en orden.
CRIPTOS = {
    "BTC": ["BTC-USD"], "ETH": ["ETH-USD"], "BNB": ["BNB-USD"], "SOL": ["SOL-USD"],
    "XRP": ["XRP-USD"], "ADA": ["ADA-USD"], "DOGE": ["DOGE-USD"], "TRX": ["TRX-USD"],
    "AVAX": ["AVAX-USD"], "DOT": ["DOT-USD", "DOT1-USD"], "LINK": ["LINK-USD"],
    "LTC": ["LTC-USD"], "BCH": ["BCH-USD"], "XLM": ["XLM-USD"], "ATOM": ["ATOM-USD"],
    "ETC": ["ETC-USD"], "XMR": ["XMR-USD"], "FIL": ["FIL-USD"], "HBAR": ["HBAR-USD"],
    "ICP": ["ICP-USD"], "NEAR": ["NEAR-USD"], "UNI": ["UNI7083-USD", "UNI-USD"],
    "AAVE": ["AAVE-USD"], "ALGO": ["ALGO-USD"], "VET": ["VET-USD"], "SHIB": ["SHIB-USD"],
    "APT": ["APT21794-USD"], "SUI": ["SUI20947-USD"], "POL": ["POL28321-USD"],
    "EOS": ["EOS-USD"], "XTZ": ["XTZ-USD"],
}
HIST_MIN, H = 60, 2                     # días de historia para entrar · horizonte 48 h
FRACCION = 2 / 13                       # la de class25A
SEMILLA = 7


# ───────────────────────────── datos ─────────────────────────────

def bajar():
    datos = {}
    for nom, sims in CRIPTOS.items():
        for s in sims:
            try:
                u = (f"https://query1.finance.yahoo.com/v8/finance/chart/{s}"
                     f"?period1={DESDE}&period2={int(time.time())}&interval=1d")
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                d = json.loads(urllib.request.urlopen(req, timeout=40).read())["chart"]["result"][0]
                c = d["indicators"]["quote"][0]["close"]
                serie = {datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"): v
                         for ts, v in zip(d.get("timestamp", []), c) if v}
                if len(serie) > HIST_MIN:
                    datos[nom] = serie
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if nom not in datos:
            print(f"  ⚠️ {nom}: sin datos en Yahoo, queda afuera")
    GUARDADO.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf8")
    print(f"bajadas {len(datos)} de {len(CRIPTOS)} criptos → {GUARDADO.name}")
    return datos


# ───────────────────────────── piezas de MIIA ─────────────────────────────

class NormLento:
    """RunningNorm con ventana lenta y arranque 1/n (miia_common.h)."""
    def __init__(self, d, ventana=5000):
        self.m = np.zeros(d); self.v = np.ones(d); self.n = 0; self.w = ventana

    def __call__(self, x, actualizar=True):
        if actualizar:
            self.n += 1
            a = max(1 / self.n, 1 / self.w)
            dx = x - self.m
            self.m += a * dx
            self.v = (1 - a) * (self.v + a * dx * dx)
        return (x - self.m) / np.sqrt(self.v + 1e-12)


class RedEnLinea:
    """MLP online (class24): una capa oculta, salida logística, SGD de a un ejemplo."""
    def __init__(self, d, h, lr, seed):
        g = np.random.default_rng(seed)
        self.W1 = g.normal(0, 1 / math.sqrt(d), (d, h)); self.b1 = np.zeros(h)
        self.W2 = g.normal(0, 1 / math.sqrt(h), h); self.b2 = 0.0
        self.lr = lr

    def salida(self, x):
        h = np.tanh(x @ self.W1 + self.b1)
        return 1 / (1 + math.exp(-(h @ self.W2 + self.b2))), h

    def paso(self, x, y):
        p, h = self.salida(x)
        e = p - y
        dh = e * self.W2 * (1 - h * h)
        self.W2 -= self.lr * (e * h + 1e-4 * self.W2); self.b2 -= self.lr * e
        self.W1 -= self.lr * (np.outer(x, dh) + 1e-4 * self.W1); self.b1 -= self.lr * dh


class BaseEWMA:
    """g_base de class25A: media y desvío con olvido (West), arranque 1/n."""
    def __init__(self, vida_media):
        self.a_min = 1 - 0.5 ** (1 / vida_media); self.n = 0; self.m = 0.0; self.s = 0.0

    def z(self, x):
        return (x - self.m) / math.sqrt(self.s) if self.n >= 50 and self.s > 0 else 0.0

    def observar(self, x):
        self.n += 1
        a = max(1 / self.n, self.a_min)
        d = x - self.m
        self.m += a * d
        self.s = (1 - a) * (self.s + a * d * d)


def vector(ret_hoy, hist):
    """class10: 8 propias + 4 compartidas + 10 de distribución = 22 dims."""
    tks = list(ret_hoy)
    r = np.array([ret_hoy[t] for t in tks])
    rel = r - r.mean()
    orden = r.argsort().argsort() / max(1, len(r) - 1)
    q = np.quantile(r, [.1, .25, .5, .75, .9])
    iqr = q[3] - q[1]
    bowley = (q[3] + q[1] - 2 * q[2]) / iqr if iqr > 0 else 0.0
    comun = [r.mean(), (r > 0).mean(), r.std(), np.mean([np.mean(hist[t][-7:]) for t in tks])]
    dist = list(q) + [r.max(), r.min(), bowley, iqr, min(1, len(r) / 100)]
    out = {}
    for k, t in enumerate(tks):
        h = np.array(hist[t][-30:])
        vol = h.std() if len(h) > 5 else 0.0
        zt = (r[k] - h.mean()) / vol if vol > 0 else 0.0
        propias = [r[k], np.sign(r[k]), rel[k], vol, orden[k], zt, np.mean(hist[t][-7:]), np.mean(hist[t][-28:])]
        out[t] = np.array(propias + comun + dist, float)
    return out


def banda_entre_ventanas(ok_n):
    """ok_n: [(aciertos, n)] por ventana de 48 h → (acierto, semiancho) con t."""
    G = len(ok_n); N = sum(n for _, n in ok_n)
    if G < 2 or N == 0:
        return float("nan"), float("nan")
    acc = sum(a for a, _ in ok_n) / N
    var = G / (G - 1) * sum((a - acc * n) ** 2 for a, n in ok_n) / (N * N)
    t = 1.96 if G > 200 else {True: 2.0}.get(G > 60, 2.1)
    return acc, t * math.sqrt(var)


def _ic_dia(s: dict, r: dict):
    """Spearman entre dos dicts sobre los nombres comunes (None si no hay orden)."""
    ks = [k for k in s if k in r]
    if len(ks) < rank_ic.MIN_INSTRUMENTOS:
        return None
    a = np.array([s[k] for k in ks]); b = np.array([r[k] for k in ks])
    if a.std() == 0 or b.std() == 0:
        return None
    a = a.argsort().argsort().astype(float); b = b.argsort().argsort().astype(float)
    a -= a.mean(); b -= b.mean()
    return float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum()))


def placebo_desplazado(pares, reps, semilla):
    """Placebo que CONSERVA la persistencia de la señal: la serie de scores se
    corre en el tiempo (circular) contra la de retornos, sin mezclar nombres.

    El placebo anterior mezclaba los nombres al azar en cada ventana por
    separado. Eso rompe la persistencia que tiene cualquier señal real (los
    mismos activos tienden a quedar arriba varios días), así que el azar casi
    nunca alcanzaba el IC de MIIA y la comparación salía demasiado favorable.
    Verificado el 24-nov sobre sim52 (bonos a 1 semana): el placebo viejo decía
    que el azar igualaba a MIIA el 1,1 % de las veces; éste, el 8,0 %.
    """
    g = np.random.default_rng(semilla)
    n = len(pares)
    margen = max(20, n // 20)            # lejos del desplazamiento 0, que es la señal real
    out = []
    for _ in range(reps):
        k = int(g.integers(margen, n - margen))
        v = [_ic_dia(pares[(t + k) % n][0], pares[t][1]) for t in range(n)]
        v = [x for x in v if x is not None]
        out.append(np.mean(v) if v else 0.0)
    return np.array(out)


# ───────────────────────────── corrida ─────────────────────────────

def main():
    D = bajar() if ("--bajar" in sys.argv or not GUARDADO.exists()) else \
        json.loads(GUARDADO.read_text(encoding="utf8"))
    dias = sorted(set().union(*[set(v) for v in D.values()]))
    nombres = sorted(D)
    T = len(dias)
    P = np.full((T, len(nombres)), np.nan)
    for j, n in enumerate(nombres):
        for i, d in enumerate(dias):
            P[i, j] = D[n].get(d, np.nan)
    R = np.r_[[np.full(len(nombres), np.nan)], P[1:] / P[:-1] - 1]
    print(f"{len(nombres)} criptos · {T} días ({dias[0]} a {dias[-1]})")

    g = np.random.default_rng(SEMILLA)
    hist = {n: [] for n in nombres}
    norm = NormLento(22)
    redes = [RedEnLinea(22, 16, 0.01, 1), RedEnLinea(22, 16, 0.003, 2)]   # «class23», «class24»
    bases = [BaseEWMA(600), BaseEWMA(600)]
    pendientes = {}                     # día → [(nombre, x normalizado)]
    deposito = []                       # repaso: (x, y, día)
    vistos = 0                          # ejemplos ofrecidos al reservorio
    scores = {}                         # día → {nombre: z_ens}
    comparaciones = {"rebote 1 día": {}, "tendencia 7 días": {}, "tendencia 28 días": {}}

    for i in range(1, T):
        d = dias[i]
        hoy = {n: R[i, j] for j, n in enumerate(nombres)
               if not np.isnan(R[i, j]) and len(hist[n]) >= HIST_MIN}
        # ── class43 + entrenamiento: maduran las decisiones de hace H días ──
        if i - H in pendientes:
            futuro = {}
            for j, n in enumerate(nombres):
                a, b = P[i - H, j], P[i, j]
                if not (np.isnan(a) or np.isnan(b)):
                    futuro[n] = b / a - 1
            if futuro:
                m = np.mean(list(futuro.values()))
                nuevos = 0
                for n, x in pendientes.pop(i - H):
                    if n not in futuro or abs(futuro[n] - m) < 1e-9:
                        continue
                    y = 1.0 if futuro[n] > m else 0.0
                    for red in redes:
                        red.paso(x, y)
                    nuevos += 1
                    if nuevos % 4 == 0 and deposito:             # repaso: 1 viejo cada 4
                        xv, yv, _ = deposito[g.integers(len(deposito))]
                        for red in redes:
                            red.paso(xv, yv)
                    vistos += 1
                    if len(deposito) < 10000:
                        deposito.append((x, y, i - H))
                    else:
                        k = g.integers(vistos)
                        if k < 10000:
                            deposito[k] = (x, y, i - H)
        # ── class10 → redes → class25A ──
        if len(hoy) >= 10:
            vec = vector(hoy, hist)
            xs = {n: norm(v) for n, v in vec.items()}
            z = {}
            for n, x in xs.items():
                zs = []
                for red, base in zip(redes, bases):
                    p, _ = red.salida(x)
                    zs.append(base.z(p)); base.observar(p)
                z[n] = float(np.mean(zs))
            scores[i] = z
            pendientes[i] = list(xs.items())
            comparaciones["rebote 1 día"][i] = {n: -hoy[n] for n in hoy}
            comparaciones["tendencia 7 días"][i] = {n: float(np.prod(1 + np.array(hist[n][-6:] + [hoy[n]])) - 1) for n in hoy}
            comparaciones["tendencia 28 días"][i] = {n: float(np.prod(1 + np.array(hist[n][-27:] + [hoy[n]])) - 1) for n in hoy}
        for j, n in enumerate(nombres):
            if not np.isnan(R[i, j]):
                hist[n].append(R[i, j])

    # ── el panel ──
    def realizado(i, k):
        if i + k >= T:
            return None
        r = P[i + k] / P[i] - 1
        ok = ~np.isnan(r)
        return {nombres[j]: r[j] - np.nanmean(r) for j in range(len(nombres)) if ok[j]}

    def panel(nom, S, solo_ic=False):
        dias_ok = sorted(S)
        w1 = []
        for i in dias_ok:
            rr = realizado(i, 1)
            if rr:
                w1.append([(n, s, rr[n]) for n, s in S[i].items() if n in rr])
        w2 = []
        for i in dias_ok[::2]:
            rr = realizado(i, 2)
            if rr:
                w2.append([(n, s, rr[n]) for n, s in S[i].items() if n in rr])
        s1, s2 = rank_ic.serie_ic(w1), rank_ic.serie_ic(w2)
        linea = (f"  {nom:<24} rank IC 1 día {s1['rank_ic']:+.4f} (MDE {s1['rank_ic_min_detectable']:.4f}, t {s1['rank_ic_t']:+.2f})"
                 f" · 48 h {s2['rank_ic']:+.4f} (MDE {s2['rank_ic_min_detectable']:.4f})")
        if solo_ic:
            return s1["rank_ic"]
        # decisiones BUY/SELL con k = n × 2/13, verificadas a 48 h, ventanas de 48 h
        ventanas, nb, ns, up_n, tot = {}, 0, 0, 0, 0
        spread = []
        for i in dias_ok:
            rr = realizado(i, H)
            if not rr:
                continue
            orden = sorted(S[i], key=S[i].get)
            k = max(1, round(len(orden) * FRACCION))
            lb = [rr[n] for n in orden[-k:] if n in rr]; ls = [rr[n] for n in orden[:k] if n in rr]
            if lb and ls and i % 2 == 0:            # posiciones de 48 h sin solapar
                spread.append(np.mean(lb) - np.mean(ls))
            for n, senal in [(n, "SELL") for n in orden[:k]] + [(n, "BUY") for n in orden[-k:]]:
                if n not in rr or abs(rr[n]) < 1e-9:
                    continue
                gano = rr[n] > 0
                ok = gano if senal == "BUY" else not gano
                a = ventanas.setdefault(i // 2, [0, 0]); a[0] += ok; a[1] += 1
                nb += senal == "BUY"; ns += senal == "SELL"; up_n += gano; tot += 1
        acc, hw = banda_entre_ventanas([tuple(v) for v in ventanas.values()])
        q, p = nb / tot, up_n / tot
        azar = q * p + (1 - q) * (1 - p)
        print(linea)
        print(f"  {'':<24} acierto {100*acc:.1f} % · azar {100*azar:.1f} % · ventaja {100*(acc-azar):+.1f} ± {100*hw:.1f} pp"
              f" · {tot} decisiones en {len(ventanas)} ventanas de 48 h")
        sp = np.array(spread)
        e = 1.96 * sp.std(ddof=1) / math.sqrt(len(sp))
        # costo de ida y vuelta por posición (comisión + spread de un exchange grande)
        print(f"  {'':<24} comprar los k mejores y vender los k peores, 48 h: bruto {100*sp.mean():+.3f} % ± {100*e:.3f}"
              f" · neto con 0,1 %: {100*(sp.mean()-0.002):+.3f} % · con 0,2 %: {100*(sp.mean()-0.004):+.3f} %")
        return s1["rank_ic"]

    print("\n── La cadena de MIIA (vector class10 → redes en línea → z con olvido → ranking) ──")
    ic_miia = panel("MIIA sobre criptos", scores)
    mitad = sorted(scores)[len(scores) // 2]
    print("  por mitades:")
    panel("  primera mitad", {i: v for i, v in scores.items() if i < mitad})
    panel("  segunda mitad", {i: v for i, v in scores.items() if i >= mitad})

    print("\n── Señales simples de precio (mismas decisiones y misma medición) ──")
    for nom, S in comparaciones.items():
        panel(nom, S)

    print("\n── Placebo: la señal de MIIA corrida en el tiempo ──")
    pares = [(scores[i], realizado(i, 1)) for i in sorted(scores) if realizado(i, 1)]
    ics = placebo_desplazado(pares, 500, 49)
    pct = (ics >= ic_miia).mean() * 100
    print(f"  rank IC del placebo: típico {np.median(ics):+.4f} · el 5 % más alto ≥ {np.quantile(ics, .95):+.4f} "
          f"· el placebo iguala a MIIA ({ic_miia:+.4f}) el {pct:.1f} % de las veces")

if __name__ == "__main__":
    main()
