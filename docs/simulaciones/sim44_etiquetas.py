"""sim44_etiquetas.py — ¿las etiquetas con las que aprende MIIA son las que se miden?
(23-nov-2026). Medición sobre el volcado del 12-nov; no toca producción.

Revisa los cuatro errores de etiqueta señalados el 23-nov contra class43.js:

  1 · El camino en memoria le manda a class25A `direccion_real` ABSOLUTA
      (`retorno_pct > 0`, class43.js:931); la reconciliación la manda RELATIVA
      (`retVeredicto > 0`, :1790). La capa 2 cobra con esa dirección.
  2 · El stop-loss recorta el retorno del instrumento ANTES de restarle el
      mercado, y sólo en el camino en memoria.
  3 · En memoria, el precio de salida del instrumento es el precio en vivo al
      verificar; el del mercado sale de la base a la hora exacta del
      vencimiento. Pueden no cubrir el mismo período.
  4 · Precios de fuentes mezcladas (class7 / yfinance vía LSTM).

Cómo: para cada decisión verificada post-corte (`decision_modo='ranking'`,
BUY/SELL, relativa, no sombra) recalcula la etiqueta CANÓNICA —la definición
de la reconciliación: último precio <= t y <= t+h para el instrumento y para
los 50, promedio equiponderado de retornos— y la compara con la guardada.

    python -X utf8 docs/simulaciones/sim44_etiquetas.py --extraer   # relee el volcado (minutos)
    python -X utf8 docs/simulaciones/sim44_etiquetas.py
"""
from __future__ import annotations

import bisect
import json
import math
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))
from universo import TICKERS as UNIVERSO            # noqa: E402

VOLCADO  = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
GUARDADO = AQUI / "datos" / "etiquetas_sim44.json"
DESDE    = "2026-10-08"          # precios desde un poco antes del corte
CAMPO    = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
FMT      = "%Y-%m-%d %H:%M:%S"


def _campos(t: bytes) -> list:
    out = []
    for m in CAMPO.finditer(t):
        if m.group(1) is not None:
            out.append(m.group(1).decode("utf8", "replace"))
        elif m.group(2) is not None:
            out.append(m.group(2).decode().strip())
        else:
            out.append(None)
    return out


def _columnas(tabla: str) -> dict:
    buscar = ("CREATE TABLE `" + tabla + "` (").encode()
    cols, dentro = [], False
    with VOLCADO.open("rb") as f:
        for ln in f:
            if not dentro:
                dentro = ln.startswith(buscar)
                continue
            if ln.startswith(b")"):
                break
            m = re.match(rb"\s+`([a-z_]+)`\s", ln)
            if m:
                cols.append(m.group(1).decode())
    return {c: i for i, c in enumerate(cols)}


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _seg(ts: str) -> float:
    """Segundos de un datetime naive del server. Mismo reloj en las dos tablas
    (DATE_ADD de MySQL tampoco mira el cambio de horario)."""
    return datetime.strptime(ts[:19], FMT).timestamp()


def extraer() -> dict:
    ic, ip = _columnas("cognitive_decisions"), _columnas("precios")
    univ = set(UNIVERSO)
    PD = b"INSERT INTO `cognitive_decisions` VALUES "
    PP = b"INSERT INTO `precios` VALUES "
    ticks: dict = {t: [] for t in univ}
    dec: dict = {}
    for ln in VOLCADO.open("rb"):
        if ln.startswith(PD):
            pref, cual, idx = PD, "d", ic
        elif ln.startswith(PP):
            pref, cual, idx = PP, "p", ip
        else:
            continue
        for t in ln[len(pref):].rstrip(b";\r\n").split(b"),("):
            c = _campos(t.lstrip(b"(").rstrip(b")"))
            if len(c) < len(idx):
                continue
            tk = c[idx["ticker"]]
            if tk not in univ:
                continue
            if cual == "p":
                ts, pv = c[idx["ts"]], _f(c[idx["precio"]])
                if ts and pv and pv > 0 and ts >= DESDE:
                    ticks[tk].append((_seg(ts), pv))
                continue
            if c[idx["decision_modo"]] != "ranking" or c[idx["temperatura"]] == "shadow":
                continue
            if c[idx["senal"]] not in ("BUY", "SELL"):
                continue
            if c[idx["outcome_real"]] not in ("correcto", "incorrecto"):
                continue
            if c[idx["label_modo"]] != "relativo":
                continue
            h = c[idx["hash_decision"]] or c[idx["id"]]
            if h in dec:
                continue
            dec[h] = [tk, c[idx["senal"]], c[idx["ts_decision"]][:19],
                      int(c[idx["horizonte_horas"]] or 24),
                      _f(c[idx["precio_entrada"]]), _f(c[idx["precio_salida"]]),
                      _f(c[idx["retorno_real"]]), _f(c[idx["retorno_relativo"]]),
                      c[idx["outcome_real"]], (c[idx["ts_outcome"]] or "")[:19]]
    for t in ticks:
        ticks[t].sort()
    print(f"decisiones verificadas: {len(dec)} · ticks: {sum(len(v) for v in ticks.values())}")

    # ── recalcular con la definición de la reconciliación ──
    tsl = {t: [x[0] for x in v] for t, v in ticks.items()}

    def precio(tk, s):
        i = bisect.bisect_right(tsl[tk], s) - 1
        return ticks[tk][i][1] if i >= 0 else None

    cache_mkt: dict = {}

    def mkt(s0, h):
        k = (s0, h)
        if k not in cache_mkt:
            rs = []
            for tk in univ:
                p0, p1 = precio(tk, s0), precio(tk, s0 + h * 3600)
                if p0 and p1:
                    rs.append((p1 - p0) / p0)
            cache_mkt[k] = sum(rs) / len(rs) if rs else None
        return cache_mkt[k]

    filas = []
    for tk, senal, ts, h, pe, ps, rr, rrel, out, tso in dec.values():
        s0 = _seg(ts)
        p0h, p1h = precio(tk, s0), precio(tk, s0 + h * 3600)
        m = mkt(s0, h)
        if not (p0h and p1h and m is not None):
            continue
        filas.append([tk, senal, ts, h,
                      round(pe or 0, 4), round(ps or 0, 4),
                      None if rr is None else round(rr, 6),
                      None if rrel is None else round(rrel, 6),
                      1 if out == "correcto" else 0,
                      round(p0h, 4), round(p1h, 4), round(m, 7),
                      # lo que daría la caché por MINUTO del arreglo del 23-nov
                      round(mkt(s0 - s0 % 60, h) or 0, 7),
                      round((_seg(tso) - s0) / 3600 - h, 2) if tso else None])
    datos = {"campos": ["ticker", "senal", "ts", "h", "pe", "ps", "ret_real", "ret_rel",
                        "correcto", "p0_hist", "p1_hist", "mkt_hist", "mkt_minuto", "atraso_h"],
             "filas": filas}
    GUARDADO.write_text(json.dumps(datos, separators=(",", ":")), encoding="utf8")
    print(f"guardadas {len(filas)} filas en {GUARDADO.name}")
    return datos


# ───────────────────────────── medición ─────────────────────────────

def _pct(a, b):
    return 100.0 * a / b if b else float("nan")


def resumen(nombre, F, etiqueta):
    """acierto, azar de Cohen con la mezcla, ventaja, y cuánto le ganan al
    promedio los BUY y los SELL (la inclinación común)."""
    n = len(F)
    nb = sum(1 for r in F if r["senal"] == "BUY")
    up = [etiqueta(r) for r in F]
    ok = sum(1 for r, u in zip(F, up) if (u > 0) == (r["senal"] == "BUY"))
    q, p = nb / n, sum(1 for u in up if u > 0) / n
    azar = q * p + (1 - q) * (1 - p)
    gb = _pct(sum(1 for r, u in zip(F, up) if r["senal"] == "BUY" and u > 0), nb)
    gs = _pct(sum(1 for r, u in zip(F, up) if r["senal"] == "SELL" and u > 0), n - nb)
    print(f"  {nombre:<34} acierto {_pct(ok, n):5.1f} · azar {100*azar:5.1f} · "
          f"ventaja {_pct(ok, n) - 100*azar:+5.1f} · le ganó al promedio: BUY {gb:4.1f} SELL {gs:4.1f}")


def main():
    if "--extraer" in sys.argv or not GUARDADO.exists():
        datos = extraer()
    else:
        datos = json.loads(GUARDADO.read_text(encoding="utf8"))
    C = datos["campos"]
    F = [dict(zip(C, f)) for f in datos["filas"]]
    for r in F:
        r["ret_can"] = (r["p1_hist"] - r["p0_hist"]) / r["p0_hist"]
        r["rel_can"] = r["ret_can"] - r["mkt_hist"]
        r["up_guard"] = (r["correcto"] == 1) == (r["senal"] == "BUY")
        # ¿qué camino la verificó? La reconciliación escribe el precio histórico
        # exacto a t+h; la memoria escribe el precio en vivo al verificar.
        r["camino"] = ("reconciliacion"
                       if r["ps"] and abs(r["ps"] - r["p1_hist"]) <= 0.00015 + 1e-6 * r["p1_hist"]
                       else "memoria")
    n = len(F)
    print(f"\n{n} decisiones BUY/SELL verificadas, relativas, post-corte (ranking)\n")

    print("── Qué camino las verificó ──")
    for cam in ("reconciliacion", "memoria"):
        G = [r for r in F if r["camino"] == cam]
        at = sorted(r["atraso_h"] for r in G if r["atraso_h"] is not None)
        med = at[len(at) // 2] if at else float("nan")
        print(f"  {cam:<15} {len(G):6d} ({_pct(len(G), n):4.1f} %) · atraso mediano de la verificación {med:+.1f} h")

    print("\n── Error 3: etiqueta guardada contra la canónica (precios a t y t+h exactos) ──")
    for cam in ("reconciliacion", "memoria", None):
        G = [r for r in F if cam is None or r["camino"] == cam]
        if not G:
            continue
        flip = sum(1 for r in G if r["up_guard"] != (r["rel_can"] > 0))
        print(f"  {cam or 'todas':<15} cambian {flip:5d} de {len(G):6d} = {_pct(flip, len(G)):4.1f} %")
    M = [r for r in F if r["camino"] == "memoria"]
    if M:
        # ¿de dónde sale la diferencia? lado instrumento vs lado mercado
        d_inst = [r["ret_real"] - r["ret_can"] for r in M if r["ret_real"] is not None]
        d_mkt = [(r["ret_real"] - r["ret_rel"]) - r["mkt_hist"] for r in M
                 if r["ret_real"] is not None and r["ret_rel"] is not None]
        mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")
        print(f"  en memoria: retorno del instrumento guardado − canónico: media {100*mean(d_inst):+.3f} pp, "
              f"|media| {100*mean([abs(x) for x in d_inst]):.3f} pp")
        print(f"              mercado restado − mercado canónico:         media {100*mean(d_mkt):+.4f} pp")
        # sesgo: ¿el error de etiqueta va con el mercado?
        sube = [r for r in M if r["mkt_hist"] > 0]
        baja = [r for r in M if r["mkt_hist"] <= 0]
        for nom, G in (("mercado subió", sube), ("mercado bajó", baja)):
            if G:
                a_up = sum(1 for r in G if r["up_guard"] and not r["rel_can"] > 0)
                a_dn = sum(1 for r in G if not r["up_guard"] and r["rel_can"] > 0)
                print(f"              {nom:<14} n={len(G):5d}: pasó a «le ganó» {a_up:4d} · pasó a «perdió» {a_dn:4d}")

    print("\n── Error 5 (nuevo): _marketRet cachea el mercado POR HORA ──")
    # class43.js:_marketRet usa como clave `ISO(tsDecision).slice(0,13)|h`: todas
    # las decisiones de la misma hora reciben el retorno de mercado de la primera
    # que se calculó, aunque empiecen hasta 59 min después.
    from collections import defaultdict
    grupos = defaultdict(set)
    for r in F:
        if r["ret_real"] is not None and r["ret_rel"] is not None:
            grupos[(r["ts"][:13], r["h"])].add(round(r["ret_real"] - r["ret_rel"], 5))
    g5 = [len(v) for v in grupos.values()]
    print(f"  grupos (hora, horizonte): {len(g5)} · con un único mercado guardado: {_pct(sum(1 for x in g5 if x == 1), len(g5)):.0f} %")
    cache = [r for r in F if r["ret_real"] is not None and r["ret_rel"] is not None]
    cf = sum(1 for r in cache if ((r["ret_can"] - (r["ret_real"] - r["ret_rel"])) > 0) != (r["rel_can"] > 0))
    print(f"  mismo retorno del instrumento, mercado de la caché contra el exacto: cambian {cf} de {len(cache)} = {_pct(cf, len(cache)):.1f} %")
    R0 = [r for r in cache if r["camino"] == "reconciliacion"]
    resto = sum(1 for r in R0 if r["up_guard"] != ((r["ret_can"] - (r["ret_real"] - r["ret_rel"])) > 0))
    print(f"  en las de la reconciliación, sacando la caché quedan {resto} diferencias de {len(R0)} = {_pct(resto, len(R0)):.2f} %")

    mf = sum(1 for r in F if ((r["ret_can"] - r["mkt_minuto"]) > 0) != (r["rel_can"] > 0))
    print(f"  con el ARREGLO (caché por minuto, mercado desde el inicio del minuto): "
          f"cambian {mf} de {n} = {_pct(mf, n):.2f} %")

    print("\n── Error 1: dirección que recibe la capa 2 de class25A ──")
    for cam in ("memoria", "reconciliacion"):
        G = [r for r in F if r["camino"] == cam and r["ret_real"] is not None]
        if not G:
            continue
        if cam == "memoria":   # manda sign(retorno_pct), el absoluto
            mal = sum(1 for r in G if (r["ret_real"] > 0) != (r["rel_can"] > 0))
        else:
            mal = sum(1 for r in G if r["up_guard"] != (r["rel_can"] > 0))
        print(f"  {cam:<15} {mal:5d} de {len(G):6d} con la dirección equivocada = {_pct(mal, len(G)):4.1f} %")

    print("\n── Error 2: stop-loss (simulado sobre la canónica; sólo existe en memoria) ──")
    for stop in (0.02, 0.03, 0.06):
        cambia = 0
        for r in F:
            ret = r["ret_can"]
            if r["senal"] == "BUY" and ret <= -stop:
                ret = -stop
            elif r["senal"] == "SELL" and ret >= stop:
                ret = stop
            if ((ret - r["mkt_hist"]) > 0) != (r["rel_can"] > 0):
                cambia += 1
        print(f"  stop {100*stop:.0f} %: la etiqueta cambia en {cambia} de {n} = {_pct(cambia, n):.2f} %")

    print("\n── Lo que mide la tesis con cada etiqueta ──")
    resumen("guardada (la de hoy)", F, lambda r: 1 if r["up_guard"] else -1)
    resumen("canónica (reconciliación pura)", F, lambda r: r["rel_can"])
    if M:
        R = [r for r in F if r["camino"] == "reconciliacion"]
        print("  sólo las de cada camino:")
        resumen("  memoria · guardada", M, lambda r: 1 if r["up_guard"] else -1)
        resumen("  memoria · canónica", M, lambda r: r["rel_can"])
        if R:
            resumen("  reconciliación", R, lambda r: r["rel_can"])

    # ── qué le cambia al aprendizaje ──
    flips = sum(1 for r in F if r["up_guard"] != (r["rel_can"] > 0))
    f = flips / n
    print("\n── Qué le cambia al aprendizaje ──")
    print(f"  fracción de etiquetas de entrenamiento distintas de la canónica: {100*f:.1f} %")
    print(f"  una señal real llega a las redes multiplicada por (1 − 2f) = {1 - 2*f:.3f}"
          f"  → se pierde {100*(2*f):.1f} % de la señal")


if __name__ == "__main__":
    main()
