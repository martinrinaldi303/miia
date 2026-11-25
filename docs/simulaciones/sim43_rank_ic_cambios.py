"""sim43_rank_ic_cambios.py — los cambios propuestos al rank IC y al acierto,
medidos sobre la base respaldada (23-nov-2026).

NO es una prueba: es una medición. No toca producción. Usa el volcado del 12-nov
(post-corte = sólo `decision_modo = 'ranking'`, la misma población del endpoint)
y el código real de `MIIA/rank_ic.py`.

Qué compara, cambio por cambio (numeración de la lista del 23-nov):

  1 · Banda del acierto: hoy Wilson sobre `n_efectivo` (cada instrumento de cada
      ventana de 48 h cuenta como independiente) contra el error ENTRE ventanas
      (los 50 instrumentos de una ventana comparten el mismo mercado).
  2/3 · Días sin rueda: el filtro de hoy («algún instrumento se movió») contra
      «se movió al menos la mitad» y contra el calendario del NYSE.
  5 · El orden real del ranking no está en la base (no hay `puesto` ni
      `z_ensemble`). Se mide el sustituto que sí está: la señal PUBLICADA
      (+1 BUY, −1 SELL, 0 HOLD), que es lo que el ranking decidió con su orden.
  6 · t de Student en vez de 1,96, y cuántos instrumentos independientes valen
      de verdad los 50 (por el desvío observado del IC).
  7 · IC alineado con la ventana de la decisión (2 sesiones, 48 h). SÓLO
      EXPLORATORIO: no tiene criterio escrito antes, así que no vale como
      veredicto (ver las notas internas, «sobreajuste»).

    python -X utf8 docs/simulaciones/sim43_rank_ic_cambios.py --extraer   # relee el volcado (minutos)
    python -X utf8 docs/simulaciones/sim43_rank_ic_cambios.py             # mide
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))

import rank_ic                                      # noqa: E402  código de producción
from universo import TICKERS as UNIVERSO            # noqa: E402

VOLCADO  = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
GUARDADO = AQUI / "datos" / "rank_ic_cambios.json"

CAMPO    = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
ENSEMBLE = re.compile(r"ensemble=([0-9]*\.?[0-9]+)")

# Feriados del NYSE dentro del período del volcado (mercado cerrado todo el día).
FERIADOS_NYSE = {"2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26"}


# ───────────────────────────── extracción ─────────────────────────────

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
    cols: list = []
    with VOLCADO.open("rb") as f:
        dentro = False
        for ln in f:
            if not dentro:
                if ln.startswith(buscar):
                    dentro = True
                continue
            if ln.startswith(b")"):
                break
            m = re.match(rb"\s+`([a-z_]+)`\s", ln)
            if m:
                cols.append(m.group(1).decode())
    if not cols:
        raise SystemExit(f"no se encontró el CREATE TABLE de {tabla}")
    return {c: i for i, c in enumerate(cols)}


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def extraer() -> dict:
    if not VOLCADO.exists():
        raise SystemExit(f"no está el volcado: {VOLCADO}")
    ic, ip = _columnas("cognitive_decisions"), _columnas("precios")
    univ = set(UNIVERSO)
    PD = b"INSERT INTO `cognitive_decisions` VALUES "
    PP = b"INSERT INTO `precios` VALUES "

    score: dict = {}     # (día, tk) -> [suma score, n, suma señal, n señal]
    acierto: dict = {}   # (ventana48, tk, señal) -> [ok, n]
    hashes: set = set()
    cierre: dict = {}    # (día, tk) -> (ts, precio)

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
                if not ts or not pv or pv <= 0:
                    continue
                k = (ts[:10], tk)
                if k not in cierre or ts > cierre[k][0]:
                    cierre[k] = (ts, pv)
                continue
            if c[idx["decision_modo"]] != "ranking":
                continue
            if c[idx["temperatura"]] == "shadow":
                continue
            ts = c[idx["ts_decision"]]
            if not ts:
                continue
            senal = c[idx["senal"]]
            sc = _f(c[idx["score"]])
            if sc is None:
                m = ENSEMBLE.search(c[idx["razon"]] or "")
                sc = _f(m.group(1)) if m else None
            e = score.setdefault((ts[:10], tk), [0.0, 0, 0.0, 0])
            if sc is not None:
                e[0] += sc; e[1] += 1
            e[2] += {"BUY": 1.0, "SELL": -1.0}.get(senal, 0.0); e[3] += 1

            out = c[idx["outcome_real"]]
            if (senal in ("BUY", "SELL") and out in ("correcto", "incorrecto")
                    and (c[idx["label_modo"]] or "absoluto") == "relativo"):
                h = c[idx["hash_decision"]]
                if h:
                    if h in hashes:
                        continue          # la copia duplicada no cuenta dos veces
                    hashes.add(h)
                epoch = (datetime.fromisoformat(ts[:19]) - datetime(1970, 1, 1)).total_seconds()
                v48 = int(epoch // 172800)
                a = acierto.setdefault(f"{v48}|{tk}|{senal}", [0, 0])
                a[0] += out == "correcto"; a[1] += 1

    dias: dict = {}
    for (d, tk), (s, n, ss, ns) in score.items():
        r = dias.setdefault(d, {"score": {}, "senal": {}})
        if n:
            r["score"][tk] = round(s / n, 6)
        r["senal"][tk] = round(ss / ns, 6)
    cierres: dict = {}
    for (d, tk), (_ts, pv) in cierre.items():
        cierres.setdefault(d, {})[tk] = pv
    return {"_origen": VOLCADO.name,
            "_que_es": "post-corte (decision_modo=ranking): score medio y señal media por "
                       "rueda e instrumento, aciertos por ventana de 48 h, y cierres. "
                       "Sin datos de usuarios.",
            "dias": {d: dias[d] for d in sorted(dias)},
            "acierto": acierto,
            "cierres": {d: cierres[d] for d in sorted(cierres)}}


# ───────────────────────────── estadística ─────────────────────────────

def _t_pdf(x: float, nu: float) -> float:
    c = math.exp(math.lgamma((nu + 1) / 2) - math.lgamma(nu / 2)) / math.sqrt(nu * math.pi)
    return c * (1 + x * x / nu) ** (-(nu + 1) / 2)


def t_cdf(x: float, nu: float) -> float:
    if x == 0:
        return 0.5
    a, b, n = 0.0, abs(x), 2000            # Simpson sobre la densidad
    h = (b - a) / n
    s = _t_pdf(a, nu) + _t_pdf(b, nu)
    s += sum((4 if i % 2 else 2) * _t_pdf(a + i * h, nu) for i in range(1, n))
    area = s * h / 3
    return 0.5 + area if x > 0 else 0.5 - area


def t_cuantil(p: float, nu: float) -> float:
    lo, hi = 0.0, 50.0
    for _ in range(80):
        m = (lo + hi) / 2
        if t_cdf(m, nu) < p:
            lo = m
        else:
            hi = m
    return (lo + hi) / 2


def phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


# ───────────────────────────── cambios 2/3: días ─────────────────────────────

def retornos(cierres: dict) -> dict:
    ses = sorted(cierres)
    out = {}
    for i in range(1, len(ses)):
        hoy, ayer = ses[i], ses[i - 1]
        out[hoy] = {tk: p / cierres[ayer][tk] - 1 for tk, p in cierres[hoy].items()
                    if cierres[ayer].get(tk)}
    return out


def filtrar_dias(rets: dict, criterio: str) -> dict:
    out = {}
    for d, r in rets.items():
        if not r:
            continue
        movidos = sum(1 for x in r.values() if x != 0.0)
        if criterio == "hoy":
            ok = movidos > 0
        elif criterio == "mitad":
            ok = movidos >= len(r) / 2
        else:  # calendario
            ok = date.fromisoformat(d).weekday() < 5 and d not in FERIADOS_NYSE
        if ok:
            out[d] = r
    return out


# ───────────────────────────── el IC (copia de _rank_ic) ─────────────────────────────

def ventanas_ic(preds: dict, rets: dict, H: int = 1, hasta: str = "2099-01-01",
                desde: str = "2026-10-12"):
    sesiones = sorted(d for d in rets if d < hasta)
    out, usada = [], ""
    for dia in sorted(preds):
        if dia < desde:
            continue
        fut = [s for s in sesiones if s > dia][:H]
        if len(fut) < H or fut[0] <= usada:
            continue
        acum: dict = {}
        for i, s in enumerate(fut):
            for tk, r in rets[s].items():
                if i == 0:
                    acum[tk] = 1.0 + r
                elif tk in acum:
                    acum[tk] *= 1.0 + r
            if i > 0:
                acum = {t: v for t, v in acum.items() if t in rets[s]}
        rel = rank_ic.retornos_relativos({t: v - 1 for t, v in acum.items()})
        sec = [(tk, sc, rel[tk]) for tk, sc in preds[dia].items() if tk in rel]
        if len(sec) >= rank_ic.MIN_INSTRUMENTOS:
            out.append(sec)
            usada = fut[-1]
    return out


def resumen_ic(etiqueta: str, vent: list, student: bool = False) -> dict:
    s = rank_ic.serie_ic(vent)
    n = s["rank_ic_ventanas"]
    if not n or s["rank_ic_desvio"] is None:
        print(f"   {etiqueta:44s} sin ventanas")
        return s
    err = s["rank_ic_desvio"] / math.sqrt(n)
    k = t_cuantil(0.975, n - 1) if student else 1.96
    mde = k * err
    sig = s["rank_ic"] - mde > 0
    print(f"   {etiqueta:44s} {s['rank_ic']:+7.4f} {s['rank_ic_desvio']:6.3f} {n:5d} "
          f"{s['rank_ic_instrumentos']:5.1f} {mde:6.3f}  {'SÍ' if sig else 'no'}")
    s["_mde"] = mde
    return s


# ───────────────────────────── cambio 1: acierto ─────────────────────────────

def acierto(datos: dict):
    celdas = {}
    for clave, (ok, n) in datos["acierto"].items():
        v, tk, senal = clave.split("|")
        celdas[(int(v), tk, senal)] = (ok, n)
    ok_b = sum(ok for (v, t, s), (ok, n) in celdas.items() if s == "BUY")
    tb   = sum(n for (v, t, s), (ok, n) in celdas.items() if s == "BUY")
    ok_s = sum(ok for (v, t, s), (ok, n) in celdas.items() if s == "SELL")
    ts_  = sum(n for (v, t, s), (ok, n) in celdas.items() if s == "SELL")
    tot = tb + ts_
    if not tot:
        print("   sin decisiones verificadas post-corte"); return
    acc = (ok_b + ok_s) / tot
    q = tb / tot
    p = (ok_b + (ts_ - ok_s)) / tot            # fracción que le ganó al promedio
    azar = q * p + (1 - q) * (1 - p)

    # A · como hoy: Wilson sobre n_efectivo (ventana 48 h × instrumento)
    n_ef = len({(v, t) for (v, t, s) in celdas})
    z = 1.96
    ex = acc * n_ef
    den = 1 + z * z / n_ef
    c = (ex / n_ef + z * z / (2 * n_ef)) / den
    hw = z * math.sqrt(acc * (1 - acc) / n_ef + z * z / (4 * n_ef * n_ef)) / den
    lo_a = c - hw

    # B · error ENTRE ventanas (cluster = ventana de 48 h, todos sus instrumentos)
    por_v: dict = {}
    for (v, t, s), (ok, n) in celdas.items():
        e = por_v.setdefault(v, [0.0, 0])
        acierta_azar = azar * n
        e[0] += ok - acierta_azar; e[1] += n
    G = len(por_v)
    edge = sum(a for a, _ in por_v.values()) / tot
    var = G / (G - 1) * sum((a - edge * n) ** 2 for a, n in por_v.values()) / tot ** 2 if G > 1 else float("nan")
    se = math.sqrt(var)
    k = t_cuantil(0.975, G - 1) if G > 1 else float("nan")

    print(f"   decisiones BUY/SELL verificadas (relativo, sin duplicar): {tot}  "
          f"(BUY {tb}, SELL {ts_})")
    print(f"   acierto {acc*100:.1f} %   azar con la misma mezcla {azar*100:.1f} %   "
          f"ventaja {(acc-azar)*100:+.1f} pp")
    print(f"   A · HOY (Wilson, n_efectivo = {n_ef} ventana×instrumento):")
    print(f"       banda ±{hw*100:.1f} pp → piso {lo_a*100:.1f} %  "
          f"→ {'SIGNIFICATIVO' if lo_a > azar else 'no significativo'}")
    print(f"   B · PROPUESTO (error entre {G} ventanas de 48 h, t de Student {k:.2f}):")
    print(f"       ventaja {edge*100:+.1f} ± {k*se*100:.1f} pp  "
          f"→ {'SIGNIFICATIVO' if edge - k*se > 0 else 'no significativo'}")
    if G > 1:
        se_a = hw / 1.96
        deff = (se / se_a) ** 2
        print(f"       la banda es {k*se/hw:.1f} veces la de hoy. Efecto de diseño {deff:.1f}: "
              f"los {n_ef} pares ventana×instrumento valen como ~{n_ef/deff:.0f} independientes")


# ───────────────────────────── main ─────────────────────────────

def main() -> int:
    if "--extraer" in sys.argv or not GUARDADO.exists():
        print(f"leyendo {VOLCADO.name} … (minutos)")
        d = extraer()
        GUARDADO.parent.mkdir(exist_ok=True)
        GUARDADO.write_text(json.dumps(d, ensure_ascii=False), encoding="utf8")
    d = json.loads(GUARDADO.read_text(encoding="utf8"))
    dias = d["dias"]
    print(f"volcado {d['_origen']}: {len(dias)} días con decisiones de ranking "
          f"({min(dias)} → {max(dias)})")
    hasta = max(d["cierres"])    # el volcado se cortó a mitad de rueda: esa sesión no cuenta

    print("\n══ 1 · Banda del acierto")
    acierto(d)

    print("\n══ 2/3 · Días que cuentan como sesión")
    rets = retornos(d["cierres"])
    post = {k: v for k, v in rets.items() if k >= "2026-10-12"}
    hoy_ = filtrar_dias(post, "hoy"); mitad = filtrar_dias(post, "mitad")
    cal = filtrar_dias(post, "calendario")
    finde = [k for k in hoy_ if date.fromisoformat(k).weekday() >= 5 or k in FERIADOS_NYSE]
    print(f"   días con cierres post-corte: {len(post)}")
    print(f"   cuentan como sesión — hoy: {len(hoy_)} · ≥ mitad movida: {len(mitad)} · "
          f"calendario NYSE: {len(cal)}")
    print(f"   sábados/domingos/feriados que HOY cuentan como sesión: {len(finde)} {finde}")
    for k in sorted(set(hoy_) ^ set(cal)):
        r = post[k]
        print(f"     {k} ({['lun','mar','mié','jue','vie','sáb','dom'][date.fromisoformat(k).weekday()]}): "
              f"{sum(1 for x in r.values() if x != 0)} de {len(r)} instrumentos se movieron")

    sc = {k: v["score"] for k, v in dias.items() if v["score"]}
    sn = {k: v["senal"] for k, v in dias.items() if v["senal"]}

    print("\n══ IC post-corte (H = 1 sesión, como el endpoint)")
    print(f"   {'variante':44s} {'IC':>7} {'σ':>6} {'vent':>5} {'inst':>5} {'MDE':>6}  sig")
    base = resumen_ic("HOY (score_final, filtro actual, 1,96)",
                      ventanas_ic(sc, filtrar_dias(rets, "hoy"), 1, hasta))
    resumen_ic("3 · filtro ≥ mitad movida", ventanas_ic(sc, filtrar_dias(rets, "mitad"), 1, hasta))
    resumen_ic("3 · calendario NYSE", ventanas_ic(sc, filtrar_dias(rets, "calendario"), 1, hasta))
    resumen_ic("6 · t de Student en vez de 1,96",
               ventanas_ic(sc, filtrar_dias(rets, "calendario"), 1, hasta), student=True)
    resumen_ic("5 · sustituto: señal publicada (+1/0/−1)",
               ventanas_ic(sn, filtrar_dias(rets, "calendario"), 1, hasta), student=True)
    print("   ── EXPLORATORIO, no vale como veredicto:")
    resumen_ic("7 · alineado con la decisión (H = 2, 48 h)",
               ventanas_ic(sc, filtrar_dias(rets, "calendario"), 2, hasta), student=True)

    print("\n══ 6 · ¿Cuánto valen los 50 instrumentos?")
    sig = base.get("rank_ic_desvio")
    if sig:
        n_ef = 1 + 1 / sig ** 2
        print(f"   σ del IC observado {sig:.3f}; con 50 independientes sería "
              f"{1/math.sqrt(49):.3f}. Equivalen a ~{n_ef:.0f} instrumentos independientes.")
        print("   Proyección con este σ (t de Student), si el IC verdadero fuera 0,04:")
        for nombre, n in (("44 ruedas (12-dic)", 44), ("93 ruedas (26-feb)", 93),
                          ("123 ruedas (12-abr)", 123)):
            err = sig / math.sqrt(n)
            k = t_cuantil(0.975, n - 1)
            p_sig = 1 - phi(k - 0.04 / err)
            print(f"     {nombre:20s} MDE {k*err:.3f}   P(verlo significativo) {p_sig*100:4.0f} %")
    return 0


if __name__ == "__main__":
    sys.exit(main())
