"""sim47_datos_nuevos.py — ¿algún dato que NO sale del precio ordena los 50 ETFs?
(23-nov-2026). Medición; no toca producción.

Las cinco fuentes propuestas el 23-nov, cada una con su hipótesis y su SIGNO
escritos ANTES de correr (si se elige el signo después, es sobreajuste):

  1 · Otros mercados (horario distinto). Para los ETFs de un país asiático, el
      índice local de la mañana siguiente ya cerró cuando abre Nueva York.
      1a  validación: ese índice predice el GAP de apertura del ETF (tiene que dar
          muy positivo; si no, los datos están mal alineados).
      1b  la prueba: ¿predice además el tramo apertura → cierre? Signo esperado: +.
  2 · Precio del ETF contra lo que vale su contenido. No hay NAV histórico
      gratis: se usa el índice del país (moneda local) como proxy. Brecha del día =
      retorno del ETF − retorno del índice. Signo esperado: − (el ETF que
      se adelantó a su contenido devuelve).
  3 · Otros mercados como variables: tasa a 10 años, dólar, petróleo y VIX del
      día t. Un modelo por ETF aprende (sólo con el pasado, 250 sesiones) cómo
      responde su retorno relativo de t+1; la predicción es la señal.
  4 · Flujos. No hay acciones en circulación históricas gratis: proxy = volumen
      en dólares anormal (contra su media de 20 días), con el sentido del día.
      Señal = −(retorno relativo del día × volumen anormal). Signo esperado: +
      (lo que se movió con mucho volumen corrige).
  5 · Noticias: el sentimiento que MIIA ya guardó (class45, `sentiment_signals`
      del volcado del 12-nov). Signo esperado: +.
  Extra, sólo precio con otro plazo: rebote semanal (−retorno de 5 días, contra
  los 5 siguientes) y tendencia de 12-1 meses (contra el mes siguiente). Signo +.

Realizado, salvo donde se dice: retorno de la sesión siguiente MENOS el promedio
equiponderado de la sección (la definición del endpoint), medido con
`rank_ic.serie_ic` de producción. Ventanas sin solapar.

⚠️ Son ~10 pruebas: por azar, alguna puede salir «significativa». Para tomarla en
serio tiene que superar su MDE con el signo escrito arriba Y mantenerse en las
dos mitades del período.

Resultado del 23-nov (1.254 sesiones, nov-2021 a nov-2026), leído con cuidado:
  · 3 (macro) da IC +0,08, pero TODO sale del dólar y el petróleo, que cierran
    una hora después que las acciones; tasa y VIX dan 0, y con un día de retraso
    desaparece. Lo más probable es información del futuro, NO señal.
  · 2 da +0,035, pero el control sin índice da +0,028: es casi todo el REBOTE
    diario del ETF de país (precio), probablemente ruido del cierre. El índice
    agrega ~0,007.
  · 1b da +0,028 contra un MDE de 0,026: al borde, una de ~10 pruebas.
  · 4, 5 y los plazos largos: ruido.

Datos: históricos diarios de Yahoo Finance (5 años, sin cuenta) y el volcado.
    python -X utf8 docs/simulaciones/sim47_datos_nuevos.py --bajar   # descarga (~1 min)
    python -X utf8 docs/simulaciones/sim47_datos_nuevos.py
"""
from __future__ import annotations

import json
import math
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))
import rank_ic                                      # noqa: E402
from universo import TICKERS as UNIVERSO            # noqa: E402

VOLCADO  = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
GUARDADO = AQUI / "datos" / "datos_externos_yahoo.json"

# ETF → (índice local, moneda, True si la cotización es «moneda local por dólar»)
PAISES = {
    "EWJ": ("^N225", "JPY=X", True),  "EWY": ("^KS11", "KRW=X", True),
    "EWT": ("^TWII", "TWD=X", True),  "EWH": ("^HSI", "HKD=X", True),
    "FXI": ("^HSI", "HKD=X", True),   "INDA": ("^NSEI", "INR=X", True),
    "EWA": ("^AXJO", "AUDUSD=X", False),
    "EWG": ("^GDAXI", "EURUSD=X", False), "EWU": ("^FTSE", "GBPUSD=X", False),
    "EWL": ("^SSMI", "CHF=X", True),
    "EWC": ("^GSPTSE", "CAD=X", True), "EWW": ("^MXX", "MXN=X", True),
    "EWZ": ("^BVSP", "BRL=X", True),  "ARGT": ("^MERV", "ARS=X", True),
}
ASIA = ["EWJ", "EWY", "EWT", "EWH", "FXI", "INDA", "EWA"]
MACRO = ["^TNX", "DX-Y.NYB", "CL=F", "^VIX"]


# ───────────────────────────── descarga ─────────────────────────────

def _yahoo(sim):
    u = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sim)}?range=5y&interval=1d"
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    d = json.loads(urllib.request.urlopen(req, timeout=40).read())["chart"]["result"][0]
    off = d["meta"].get("gmtoffset", 0)
    q = d["indicators"]["quote"][0]
    out = {}
    for i, ts in enumerate(d["timestamp"]):
        c = q["close"][i]
        if c is None:
            continue
        dia = datetime.fromtimestamp(ts + off, timezone.utc).strftime("%Y-%m-%d")
        out[dia] = [q["open"][i], c, q["volume"][i]]
    return out


def bajar():
    import urllib.parse  # noqa: F401
    simbolos = set(UNIVERSO) | set(MACRO)
    for idx, fx, _ in PAISES.values():
        simbolos |= {idx, fx}
    datos = {}
    for s in sorted(simbolos):
        for intento in range(3):
            try:
                datos[s] = _yahoo(s)
                break
            except Exception as e:
                if intento == 2:
                    print(f"  ⚠️ {s}: {e}")
                time.sleep(2)
        time.sleep(0.4)
    GUARDADO.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf8")
    print(f"bajados {len(datos)} de {len(simbolos)} símbolos → {GUARDADO.name}")
    return datos


def sentimiento():
    """Sentimiento medio por (día de rueda de NY, ticker) desde el volcado."""
    CAMPO = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
    cols, dentro = [], False
    for ln in VOLCADO.open("rb"):
        if not dentro:
            dentro = ln.startswith(b"CREATE TABLE `sentiment_signals` (")
            continue
        if ln.startswith(b")"):
            break
        m = re.match(rb"\s+`([a-z_]+)`\s", ln)
        if m:
            cols.append(m.group(1).decode())
    ic = {c: i for i, c in enumerate(cols)}
    acc = defaultdict(list)
    P = b"INSERT INTO `sentiment_signals` VALUES "
    for ln in VOLCADO.open("rb"):
        if not ln.startswith(P):
            continue
        for t in ln[len(P):].rstrip(b";\r\n").split(b"),("):
            c = []
            for m in CAMPO.finditer(t.lstrip(b"(").rstrip(b")")):
                c.append(m.group(1).decode("utf8", "replace") if m.group(1) is not None
                         else (m.group(2).decode().strip() if m.group(2) is not None else None))
            if len(c) < len(ic):
                continue
            ts, tk = c[ic["ts"]], c[ic["ticker"]]
            try:
                sc = float(c[ic["sentiment_score"]])
            except (TypeError, ValueError):
                continue
            dt = datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
            if dt.hour >= 22:            # después del cierre de NY (hora del server)
                dt += timedelta(days=1)
            acc[(dt.strftime("%Y-%m-%d"), tk)].append(sc)
    return {k: float(np.mean(v)) for k, v in acc.items()}


# ───────────────────────────── medición ─────────────────────────────

def medir(nombre, ventanas, signo="+"):
    s = rank_ic.serie_ic(ventanas)
    if not s["rank_ic_ventanas"]:
        print(f"  {nombre:<54} sin ventanas")
        return
    serie = s["rank_ic_serie"]
    mitad = len(serie) // 2
    m1, m2 = np.mean(serie[:mitad]), np.mean(serie[mitad:])
    sup = s["rank_ic"] - s["rank_ic_min_detectable"] > 0
    estable = (m1 > 0) and (m2 > 0)
    veredicto = "SEÑAL" if (sup and estable) else ("supera el MDE pero no en las dos mitades" if sup else "ruido")
    print(f"  {nombre:<54} IC {s['rank_ic']:+.4f} · MDE {s['rank_ic_min_detectable']:.4f} · "
          f"t {s['rank_ic_t']:+.2f} · n {s['rank_ic_ventanas']:4d} · mitades {m1:+.3f}/{m2:+.3f} → {veredicto}")


def main():
    D = bajar() if ("--bajar" in sys.argv or not GUARDADO.exists()) else \
        json.loads(GUARDADO.read_text(encoding="utf8"))
    tks = [t for t in UNIVERSO if t in D]
    dias = sorted(set.intersection(*[set(D[t]) for t in ("SPY", "QQQ", "XLK")]))
    N = len(dias)
    print(f"{len(tks)} ETFs · {N} sesiones ({dias[0]} a {dias[-1]})\n")

    def serie(sim, campo=1):
        x = D.get(sim, {})
        return np.array([x[d][campo] if d in x and x[d][campo] is not None else np.nan for d in dias], float)

    C = {t: serie(t) for t in tks}
    O = {t: serie(t, 0) for t in tks}
    V = {t: serie(t, 2) for t in tks}
    ret = {t: np.r_[np.nan, C[t][1:] / C[t][:-1] - 1] for t in tks}

    def rel(vals):
        """dict tk->valor → dict tk->valor − promedio (sólo los presentes)."""
        ok = {k: v for k, v in vals.items() if not np.isnan(v)}
        if not ok:
            return {}
        m = np.mean(list(ok.values()))
        return {k: v - m for k, v in ok.items()}

    def siguiente(i, universo=None):
        u = universo or tks
        return rel({t: ret[t][i + 1] for t in u}) if i + 1 < N else {}

    def ventana(score, realizado):
        return [(t, score[t], realizado[t]) for t in score
                if t in realizado and not np.isnan(score[t])]

    # Índices en moneda LOCAL, sin convertir. El «cierre» diario de Yahoo para
    # las monedas es cerca de la medianoche de Londres, horas DESPUÉS del cierre
    # de Nueva York: convertir con él metía información del futuro (la primera
    # corrida daba 1b = +0,047 con moneda y +0,028 sin ella).
    def local(idx):
        I = serie(idx)
        for k in range(1, N):
            if np.isnan(I[k]):
                I[k] = I[k - 1]
        return I

    ILOC = {t: local(PAISES[t][0]) for t in PAISES if PAISES[t][0] in D}
    iret = {t: np.r_[np.nan, ILOC[t][1:] / ILOC[t][:-1] - 1] for t in ILOC}

    print("── 1 · Otros mercados: el índice asiático de la mañana siguiente ──")
    asia = [t for t in ASIA if t in iret]
    v_gap, v_oc = [], []
    for i in range(1, N - 1):
        sc = {t: iret[t][i + 1] for t in asia}
        gap = rel({t: O[t][i + 1] / C[t][i] - 1 for t in asia})
        oc = rel({t: C[t][i + 1] / O[t][i + 1] - 1 for t in asia})
        v_gap.append(ventana(sc, gap)); v_oc.append(ventana(sc, oc))
    medir("1a validación: predice el gap de apertura", v_gap)
    medir("1b la prueba: predice apertura → cierre", v_oc)

    print("\n── 2 · ETF contra su contenido (índice local como proxy del NAV) ──")
    paises = list(iret)
    v2, vc = [], []
    for i in range(1, N - 1):
        v2.append(ventana({t: -(ret[t][i] - iret[t][i]) for t in paises}, siguiente(i, paises)))
        vc.append(ventana({t: -ret[t][i] for t in paises}, siguiente(i, paises)))
    medir("2 · −(ETF − índice local) → sesión siguiente", v2)
    medir("   control: sólo −retorno del ETF (sin índice)", vc)

    print("\n── 3 · Tasas, dólar, petróleo y VIX (modelo por ETF, sólo pasado) ──")
    # El dólar (DX-Y.NYB) y el petróleo (CL=F) son futuros que cierran a las
    # 17:00 de NY, una hora DESPUÉS que las acciones: su «cierre» trae
    # información posterior. Por eso se mide cada variable y con un día extra.
    REL = np.full((N, len(tks)), np.nan)
    for i in range(1, N):
        r = rel({t: ret[t][i] for t in tks})
        for j, t in enumerate(tks):
            REL[i, j] = r.get(t, np.nan)

    def modelo(vars_, lag=0, VENT=250, LAMBDA=1.0):
        M = np.c_[[np.r_[np.nan, np.diff(serie(s)) / np.abs(serie(s)[:-1])] for s in vars_]].T
        V = []
        for i in range(VENT + 2, N - 1 - lag):
            X = M[i - VENT:i - 1 - lag]; Y = REL[i - VENT + 1 + lag:i]   # sólo pasado
            ok = ~np.isnan(X).any(1)
            if ok.sum() < 100 or np.isnan(M[i]).any():
                continue
            mu, sd = X[ok].mean(0), X[ok].std(0) + 1e-12
            Xs = (X[ok] - mu) / sd
            A = Xs.T @ Xs + LAMBDA * np.eye(Xs.shape[1])
            sc = {}
            for j, t in enumerate(tks):
                y = Y[ok, j]
                if np.isnan(y).any():
                    continue
                b = np.linalg.solve(A, Xs.T @ (y - y.mean()))
                sc[t] = float(((M[i] - mu) / sd) @ b)
            V.append(ventana(sc, rel({t: ret[t][i + 1 + lag] for t in tks})))
        return V

    medir("3 · las 4 del día → sesión siguiente", modelo(MACRO))
    for s_ in MACRO:
        medir(f"     sólo {s_}", modelo([s_]))
    medir("   sólo tasa y VIX (cierran antes que las acciones)", modelo(["^TNX", "^VIX"]))
    medir("   las 4, con un día extra de retraso", modelo(MACRO, lag=1))

    print("\n── 4 · Volumen anormal como proxy de flujos ──")
    v4 = []
    for i in range(21, N - 1):
        sc = {}
        r = rel({t: ret[t][i] for t in tks})
        for t in tks:
            dv = C[t][i - 20:i] * V[t][i - 20:i]
            if t in r and np.all(dv > 0) and V[t][i] > 0:
                sc[t] = -r[t] * math.log(C[t][i] * V[t][i] / dv.mean())
        v4.append(ventana(sc, siguiente(i)))
    medir("4 · −(retorno relativo × volumen anormal) → siguiente", v4)

    print("\n── 5 · Noticias: sentimiento de class45 (volcado del 12-nov) ──")
    S = sentimiento()
    v5 = []
    for i in range(N - 1):
        d = dias[i]
        sc = {t: S[(d, t)] for t in tks if (d, t) in S}
        if len(sc) >= rank_ic.MIN_INSTRUMENTOS:
            v5.append(ventana(sc, siguiente(i)))
    medir("5 · sentimiento del día → sesión siguiente", v5)
    print(f"     días con sentimiento de ≥5 ETFs: {len(v5)} · pares (día, ETF) en el volcado: {len(S)}")

    print("\n── Extra · sólo precio, otro plazo (ventanas sin solapar) ──")
    v6, v7 = [], []
    for i in range(5, N - 5, 5):
        sc = rel({t: C[t][i] / C[t][i - 5] - 1 for t in tks})
        sc = {t: -v for t, v in sc.items()}
        v6.append(ventana(sc, rel({t: C[t][i + 5] / C[t][i] - 1 for t in tks})))
    for i in range(252, N - 21, 21):
        sc = rel({t: C[t][i - 21] / C[t][i - 252] - 1 for t in tks})
        v7.append(ventana(sc, rel({t: C[t][i + 21] / C[t][i] - 1 for t in tks})))
    medir("rebote semanal: −(5 días) → 5 días siguientes", v6)
    medir("tendencia 12-1 meses → mes siguiente", v7)


if __name__ == "__main__":
    import urllib.parse  # noqa: F401
    main()
