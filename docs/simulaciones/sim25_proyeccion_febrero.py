"""sim25_proyeccion_febrero.py — qué puede decir la medición a fin de febrero de 2027.

QUÉ ES. Una proyección Monte Carlo de la corrida que arranca el 12-oct-2026 con
el corte entero (ORDEN 6, 50 instrumentos, ranking transversal). NO es una prueba:
no devuelve verde o rojo. Devuelve probabilidades.

QUÉ USA DE VERDAD
  · el extracto del volcado (`datos/ventanas_ensamble.json`): los scores que MIIA
    le puso a cada instrumento en 32 ruedas y los cierres de 79 días;
  · `armar_ventanas` de sim13 y `rank_ic.serie_ic` de PRODUCCIÓN: el número que
    sale acá se calcula con el mismo código que va a calcularlo el endpoint;
  · el calendario real del NYSE entre el 12-oct-2026 y el 26-feb-2027;
  · los retornos relativos diarios REALES de los 13 instrumentos, para que el
    spread y el acierto salgan en la escala del mercado y no en una inventada.

QUÉ NO PUEDE SABER, y es lo único que importa: cuál es el IC VERDADERO del
sistema después del arreglo del defecto 10. Eso no está en ningún dato: es lo que
la corrida viene a medir. La simulación contesta otra pregunta —«dado un IC
verdadero, qué va a mostrar la pantalla»— y después la pondera con una creencia
que está escrita abajo, a la vista, para poder discutirla.

    python docs/simulaciones/sim25_proyeccion_febrero.py
"""

from __future__ import annotations

import importlib.util
import json
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path
from statistics import NormalDist

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))
import rank_ic                                              # noqa: E402  producción

_spec = importlib.util.spec_from_file_location("sim13", AQUI / "sim13_ensamble.py")
sim13 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sim13)

SEMILLA = 20261012
N_UNIVERSO = 50
K = round(N_UNIVERSO * 2 / 13)            # g_rank_fraccion = 2/13 → 8 de 50 por lado
CORRIDAS = 1500
ND = NormalDist()

# ── Calendario ──────────────────────────────────────────────────────
FERIADOS = {date(2026, 11, 26), date(2026, 12, 25), date(2027, 1, 1),
            date(2027, 1, 18), date(2027, 2, 15)}


def ruedas(desde: date, hasta: date) -> int:
    n, d = 0, desde
    while d <= hasta:
        if d.weekday() < 5 and d not in FERIADOS:
            n += 1
        d += timedelta(days=1)
    return n


CORTE = date(2026, 10, 12)
# Se descarta la primera rueda (ventana de borde con decisiones del sistema viejo)
# y la última no tiene todavía su retorno del día siguiente.
HITOS = {"12-dic-2026": ruedas(CORTE, date(2026, 12, 11)) - 2,
         "15-ene-2027": ruedas(CORTE, date(2027, 1, 15)) - 2,
         "26-feb-2027": ruedas(CORTE, date(2027, 2, 26)) - 2}


# ── Lo medido: el brazo de control ──────────────────────────────────
def control():
    datos = json.loads((AQUI / "datos" / "ventanas_ensamble.json").read_text(encoding="utf-8"))
    ventanas, dias, _ = sim13.armar_ventanas(datos)
    res = rank_ic.serie_ic(ventanas)
    pool = [r for v in ventanas for _, _, r in v]           # retornos relativos reales
    return res, pool, dias


def autocorr1(xs):
    m = sum(xs) / len(xs)
    num = sum((xs[i] - m) * (xs[i + 1] - m) for i in range(len(xs) - 1))
    den = sum((x - m) ** 2 for x in xs)
    return num / den if den else 0.0


# ── Una sección transversal sintética con IC verdadero dado ─────────
def seccion(rng: random.Random, pool, ic: float, n: int = N_UNIVERSO):
    """Retornos: muestreados de los relativos REALES, recentrados (suman 0, como
    contra la vara equiponderada). Score: correlacionado con el ORDEN del retorno
    de modo que el Spearman esperado sea `ic`."""
    rets = [rng.choice(pool) + rng.gauss(0, 1e-9) for _ in range(n)]   # el ruido rompe empates
    m = sum(rets) / n
    rets = [r - m for r in rets]
    orden = sorted(range(n), key=lambda i: rets[i])
    z = [0.0] * n
    for puesto, i in enumerate(orden):
        z[i] = ND.inv_cdf((puesto + 0.5) / n)
    rho = 2 * math.sin(math.pi * ic / 6)          # Pearson en normales ↔ Spearman
    q = math.sqrt(max(0.0, 1 - rho * rho))
    return [(str(i), rho * z[i] + q * rng.gauss(0, 1), rets[i]) for i in range(n)]


def una_corrida(rng, pool, ic, n_ruedas):
    ventanas = [seccion(rng, pool, ic) for _ in range(n_ruedas)]
    # El ranking: BUY a los K mejores scores, SELL a los K peores.
    ok = tot = 0
    spreads = []
    for v in ventanas:
        o = sorted(v, key=lambda x: x[1])
        peores, mejores = o[:K], o[-K:]
        ok += sum(1 for _, _, r in mejores if r > 0) + sum(1 for _, _, r in peores if r < 0)
        tot += 2 * K
        spreads.append(sum(r for _, _, r in mejores) / K - sum(r for _, _, r in peores) / K)
    return ventanas, ok / tot, spreads


def leer(ventanas, hasta):
    return rank_ic.serie_ic(ventanas[:hasta])


def pct(x):
    return f"{100 * x:5.1f} %"


def main() -> int:
    rng = random.Random(SEMILLA)
    res, pool, dias = control()
    ics = res["rank_ic_serie"]

    print("═" * 78)
    print(" 1 · Lo que hay medido (volcado del 15-sep, código de producción)")
    print("═" * 78)
    print(f"   ventanas reales      {res['rank_ic_ventanas']}  ({dias[0]} a {dias[-1]})")
    print(f"   rank IC              {res['rank_ic']:+.4f}   σ {res['rank_ic_desvio']:.4f}   "
          f"t {res['rank_ic_t']}   MDE {res['rank_ic_min_detectable']}")
    print(f"   significativo        {res['rank_ic_significativo']}")
    print(f"   autocorrelación lag-1 de los IC reales: {autocorr1(ics):+.2f}  "
          f"(cerca de 0 = las ventanas son independientes)")
    sd_ret = math.sqrt(sum(r * r for r in pool) / len(pool))
    print(f"   dispersión real del retorno relativo diario: {100 * sd_ret:.2f} %")

    print()
    print("═" * 78)
    print(" 2 · El calendario")
    print("═" * 78)
    for h, n in HITOS.items():
        se = (1 / math.sqrt(N_UNIVERSO - 1)) / math.sqrt(n)
        print(f"   al {h}:  {n:3d} ventanas   →  IC mínimo detectable ≈ {1.96 * se:.3f}")

    n_max = max(HITOS.values())

    print()
    print("═" * 78)
    print(f" 3 · Si el IC verdadero fuera X, qué mostraría la pantalla ({CORRIDAS} corridas c/u)")
    print("═" * 78)
    print("   IC verdadero │ P(significativo) al 12-dic · 15-ene · 26-feb │ acierto │ spread/día │ P(IC medido < 0) en feb")
    tabla = {}
    for ic in (-0.02, 0.0, 0.02, 0.03, 0.04, 0.06):
        sig = {h: 0 for h in HITOS}
        neg = 0
        aciertos, spr, sigmas = [], [], []
        for _ in range(CORRIDAS):
            v, ac, sp = una_corrida(rng, pool, ic, n_max)
            for h, n in HITOS.items():
                if leer(v, n)["rank_ic_significativo"]:
                    sig[h] += 1
            fin = leer(v, n_max)
            neg += fin["rank_ic"] < 0
            sigmas.append(fin["rank_ic_desvio"])
            aciertos.append(ac)
            spr.append(sum(sp) / len(sp))
        tabla[ic] = {h: sig[h] / CORRIDAS for h in HITOS}
        print(f"     {ic:+.2f}      │      {pct(sig['12-dic-2026'] / CORRIDAS)}   {pct(sig['15-ene-2027'] / CORRIDAS)}   "
              f"{pct(sig['26-feb-2027'] / CORRIDAS)}        │ {pct(sum(aciertos) / CORRIDAS)} │ "
              f"{100 * sum(spr) / CORRIDAS:+.3f} %  │ {pct(neg / CORRIDAS)}")
    print(f"   σ del IC por ventana con {N_UNIVERSO} instrumentos, simulado: {sum(sigmas) / len(sigmas):.4f} "
          f"(teórico {1 / math.sqrt(N_UNIVERSO - 1):.4f}; con 13 se midió {res['rank_ic_desvio']:.4f})")

    print()
    print("═" * 78)
    print(" 4 · La apuesta: integrando sobre lo que se puede creer del IC verdadero")
    print("═" * 78)
    # CREENCIA, a la vista. Punto de partida escéptico N(0; 0,03): la mayoría de las
    # señales candidatas no ordenan nada y un factor débil real anda en 0,02-0,05.
    # Se actualiza con las ventanas reales del control. NO incluye ningún optimismo
    # por el arreglo del defecto 10: eso es justo lo que no se sabe.
    previo_m, previo_sd = 0.0, 0.03
    dato_m = res["rank_ic"]
    dato_se = res["rank_ic_desvio"] / math.sqrt(res["rank_ic_ventanas"])
    w0, w1 = 1 / previo_sd ** 2, 1 / dato_se ** 2
    post_m = (w0 * previo_m + w1 * dato_m) / (w0 + w1)
    post_sd = math.sqrt(1 / (w0 + w1))
    print(f"   previo escéptico N({previo_m:.2f}; {previo_sd:.2f})  +  control {dato_m:+.4f} ± {dato_se:.4f}")
    print(f"   →  IC verdadero ~ N({post_m:+.4f}; {post_sd:.4f})")

    def integrar(media, sd, etiqueta):
        c = {"sig": {h: 0 for h in HITOS}, "borde": 0, "ruido": 0, "neg": 0}
        medidos = []
        N = 3000
        for _ in range(N):
            ic = rng.gauss(media, sd)
            v, _, _ = una_corrida(rng, pool, ic, n_max)
            for h, n in HITOS.items():
                if leer(v, n)["rank_ic_significativo"]:
                    c["sig"][h] += 1
            fin = leer(v, n_max)
            medidos.append(fin["rank_ic"])
            if fin["rank_ic_significativo"]:
                pass
            elif fin["rank_ic"] > fin["rank_ic_min_detectable"] / 2:
                c["borde"] += 1
            elif fin["rank_ic"] < -fin["rank_ic_min_detectable"]:
                c["neg"] += 1
            else:
                c["ruido"] += 1
        medidos.sort()
        print(f"\n   {etiqueta}")
        print(f"     significativo al 12-dic {pct(c['sig']['12-dic-2026'] / N)} · "
              f"15-ene {pct(c['sig']['15-ene-2027'] / N)} · 26-feb {pct(c['sig']['26-feb-2027'] / N)}")
        print(f"     a fin de febrero:  significativo y positivo {pct(c['sig']['26-feb-2027'] / N)}")
        print(f"                        positivo «al borde» (más de medio MDE, sin llegar) {pct(c['borde'] / N)}")
        print(f"                        indistinguible de cero {pct(c['ruido'] / N)}")
        print(f"                        negativo fuera de la banda {pct(c['neg'] / N)}")
        print(f"     IC medido en febrero: mediana {medidos[N // 2]:+.3f}, "
              f"80 % entre {medidos[N // 10]:+.3f} y {medidos[9 * N // 10]:+.3f}")

    integrar(post_m, post_sd, "A · Sólo lo medido (el arreglo del defecto 10 no suma nada)")
    integrar(post_m + 0.015, post_sd, "B · El arreglo suma +0,015 de IC (optimista: NO hay dato que lo respalde)")
    integrar(0.0, 0.01, "C · Pesimista: no hay señal (IC verdadero ≈ 0)")

    print()
    print("═" * 78)
    print(" 5 · Y si no se desplegara nada (13 instrumentos, el sistema de hoy)")
    print("═" * 78)
    n13 = HITOS["26-feb-2027"] + res["rank_ic_ventanas"]
    se13 = res["rank_ic_desvio"] / math.sqrt(n13)
    print(f"   {n13} ventanas con σ {res['rank_ic_desvio']:.3f} → MDE {1.96 * se13:.3f} "
          f"(contra {1.96 / math.sqrt(N_UNIVERSO - 1) / math.sqrt(HITOS['26-feb-2027']):.3f} con el corte)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
