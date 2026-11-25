"""sim41_lstm_voto.py — ¿qué pasa si el LSTM vota en class25A? (17-nov-2026)

Pedido de Martín: simular, con la base respaldada, darle voto a class44 en el
ranking de class25A. NO es una prueba: es una medición. No toca producción.

QUÉ HACE. Del volcado saca, por (rueda, instrumento):
  · el score medio que MIIA le puso (la decisión real, `decision_modo`),
  · la opinión media del LSTM ese día: prob_buy − prob_sell (de `lstm_predictions`),
  · el cierre (de `precios`).
Y mide el rank IC —la misma definición que el endpoint: predicción de hoy contra
el retorno relativo equiponderado de la SESIÓN SIGUIENTE, ventanas sin solape—
para:
  · MIIA sola (lo que hay hoy),
  · el LSTM solo,
  · MIIA + LSTM con distintos pesos. El caso que importa es w = 1/5: el voto
    parejo por módulo de class25A con un quinto votante.

Cómo se combina. class25A ordena por el promedio de z de cada módulo, y cada z se
mide contra la base PROPIA de cada red. Acá cada señal se estandariza dentro de la
sección del día (z transversal) — dentro de una rueda el orden no cambia, y así
las dos señales quedan en la misma escala antes de mezclarlas. Es una
aproximación: la base de class25A es temporal (EWMA), no transversal.

    python docs/simulaciones/sim41_lstm_voto.py --extraer   # relee el volcado (minutos)
    python docs/simulaciones/sim41_lstm_voto.py             # mide

⚠️ Elegir el mejor peso de la tabla DESPUÉS de verla es sobreajuste: el único
peso fijado de antemano es 1/5 (voto parejo). Y nada vale sin su MDE al lado.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))

import rank_ic                                      # noqa: E402  código de producción
from universo import TICKERS as UNIVERSO            # noqa: E402

VOLCADO  = RAIZ / "MIIA_backup_2026-11-12-02-15-12.sql"
GUARDADO = AQUI / "datos" / "lstm_voto.json"
CORTE    = "2026-10-12"          # primera rueda del brazo nuevo (ranking, 50)

CAMPO = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
ENSEMBLE = re.compile(r"ensemble=([0-9]*\.?[0-9]+)")


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
    ic, il, ip = (_columnas("cognitive_decisions"), _columnas("lstm_predictions"),
                  _columnas("precios"))
    univ = set(UNIVERSO)
    PD = b"INSERT INTO `cognitive_decisions` VALUES "
    PL = b"INSERT INTO `lstm_predictions` VALUES "
    PP = b"INSERT INTO `precios` VALUES "

    miia: dict = {}      # (día, tk) -> [suma, n, {modo: n}]
    lstm: dict = {}      # (día, tk) -> [suma pb-ps, n]
    cierre: dict = {}    # (día, tk) -> (ts, precio)

    for ln in VOLCADO.open("rb"):
        if ln.startswith(PD):
            pref, cual, idx = PD, "d", ic
        elif ln.startswith(PL):
            pref, cual, idx = PL, "l", il
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
            if cual == "d":
                if c[idx["temperatura"]] == "shadow":
                    continue
                ts = c[idx["ts_decision"]]
                if not ts:
                    continue
                sc = _f(c[idx["score"]])
                if sc is None:
                    m = ENSEMBLE.search(c[idx["razon"]] or "")
                    sc = _f(m.group(1)) if m else None
                if sc is None:
                    continue
                modo = c[idx["decision_modo"]] or "sin_marca"
                e = miia.setdefault((ts[:10], tk), [0.0, 0, {}])
                e[0] += sc; e[1] += 1; e[2][modo] = e[2].get(modo, 0) + 1
            elif cual == "l":
                pb, ps = _f(c[idx["prob_buy"]]), _f(c[idx["prob_sell"]])
                ts = c[idx["ts"]]
                if pb is None or ps is None or not ts:
                    continue
                e = lstm.setdefault((ts[:10], tk), [0.0, 0])
                e[0] += pb - ps; e[1] += 1
            else:
                ts, pv = c[idx["ts"]], _f(c[idx["precio"]])
                if not ts or not pv or pv <= 0:
                    continue
                k = (ts[:10], tk)
                if k not in cierre or ts > cierre[k][0]:
                    cierre[k] = (ts, pv)

    dias: dict = {}
    for (d, tk), (s, n, modos) in miia.items():
        r = dias.setdefault(d, {"miia": {}, "lstm": {}, "modo": {}})
        r["miia"][tk] = round(s / n, 6)
        r["modo"][tk] = max(modos, key=modos.get)
    for (d, tk), (s, n) in lstm.items():
        dias.setdefault(d, {"miia": {}, "lstm": {}, "modo": {}})["lstm"][tk] = round(s / n, 6)
    cierres: dict = {}
    for (d, tk), (_ts, pv) in cierre.items():
        cierres.setdefault(d, {})[tk] = pv
    return {"_origen": VOLCADO.name,
            "_que_es": "score medio de MIIA, opinión media del LSTM (pb-ps) y cierre, "
                       "por rueda e instrumento. Sin datos de usuarios.",
            "dias": {d: dias[d] for d in sorted(dias)},
            "cierres": {d: cierres[d] for d in sorted(cierres)}}


def _z(d: dict) -> dict:
    v = list(d.values())
    if len(v) < 2:
        return {}
    m = sum(v) / len(v)
    s = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
    return {k: (x - m) / s for k, x in d.items()} if s > 0 else {}


def ventanas(datos: dict, desde: str, hasta: str, w_lstm: float | None,
             solo_comunes: bool = True, min_inst: int = rank_ic.MIN_INSTRUMENTOS):
    """w_lstm None = sólo MIIA; 1.0 = sólo LSTM; entre medio, la mezcla."""
    cierres = datos["cierres"]
    ses = sorted(cierres)
    rets = {}
    for i in range(1, len(ses)):
        hoy, ayer = ses[i], ses[i - 1]
        r = {tk: p / cierres[ayer][tk] - 1 for tk, p in cierres[hoy].items()
             if cierres[ayer].get(tk)}
        if r and max(abs(x) for x in r.values()) > 0:
            rets[hoy] = r
    con_ret = sorted(rets)
    out, usada = [], ""
    for dia, r in datos["dias"].items():
        if not (desde <= dia < hasta):
            continue
        fut = [s for s in con_ret if s > dia]
        if not fut or fut[0] <= usada:
            continue
        rel = rank_ic.retornos_relativos(rets[fut[0]])
        comunes = set(r["miia"]) & set(r["lstm"]) & set(rel) if solo_comunes else None
        zm = _z({k: v for k, v in r["miia"].items() if (not comunes or k in comunes)})
        zl = _z({k: v for k, v in r["lstm"].items() if (not comunes or k in comunes)})
        sec = []
        for tk in (comunes or set(rel)):
            if tk not in rel:
                continue
            if w_lstm is None:
                if tk not in zm: continue
                s = zm[tk]
            elif w_lstm >= 1.0:
                if tk not in zl: continue
                s = zl[tk]
            else:
                if tk not in zm or tk not in zl: continue
                s = (1 - w_lstm) * zm[tk] + w_lstm * zl[tk]
            sec.append((tk, s, rel[tk]))
        if len(sec) >= min_inst:   # el volcado se corta a mitad de rueda: sin esto entra una sección de 9
            out.append(sec); usada = fut[0]
    return out


def informe(datos: dict, nombre: str, desde: str, hasta: str, min_inst: int = 5):
    print(f"\n── {nombre}  [{desde} → {hasta})")
    filas = [("MIIA sola (hoy)", None), ("LSTM solo", 1.0),
             ("MIIA + LSTM, voto parejo (1/5)", 0.2),
             ("MIIA + LSTM, 1/3", 1 / 3), ("MIIA + LSTM, mitad y mitad", 0.5)]
    base = None
    print(f"   {'variante':34s} {'IC':>7} {'σ':>6} {'vent':>5} {'inst':>5} {'t':>6} {'MDE':>6}  sig")
    for etiqueta, w in filas:
        s = rank_ic.serie_ic(ventanas(datos, desde, hasta, w, min_inst=min_inst))
        if s["rank_ic"] is None:
            print(f"   {etiqueta:34s}   sin ventanas"); continue
        print(f"   {etiqueta:34s} {s['rank_ic']:+7.4f} {s['rank_ic_desvio']:6.3f} "
              f"{s['rank_ic_ventanas']:5d} {s['rank_ic_instrumentos']:5.1f} "
              f"{s['rank_ic_t']:+6.2f} {s['rank_ic_min_detectable']:6.3f}  "
              f"{'SÍ' if s['rank_ic_significativo'] else 'no'}")
        if w is None:
            base = s["rank_ic_serie"]
        if w == 0.2 and base:
            dif = [b - a for a, b in zip(base, s["rank_ic_serie"])]
            if len(dif) > 1:
                m = sum(dif) / len(dif)
                sd = math.sqrt(sum((x - m) ** 2 for x in dif) / (len(dif) - 1))
                mejor = sum(x > 0 for x in dif)
                print(f"   {'  └ diferencia pareada vs MIIA':34s} {m:+7.4f} ± {1.96*sd/math.sqrt(len(dif)):.4f}"
                      f"   (mejora en {mejor} de {len(dif)} ventanas)")


def main() -> int:
    if "--extraer" in sys.argv or not GUARDADO.exists():
        print(f"leyendo {VOLCADO.name} …")
        d = extraer()
        GUARDADO.parent.mkdir(exist_ok=True)
        GUARDADO.write_text(json.dumps(d, ensure_ascii=False), encoding="utf8")
    d = json.loads(GUARDADO.read_text(encoding="utf8"))
    dias = d["dias"]
    con_l = [x for x, r in dias.items() if r["lstm"]]
    print(f"volcado {d['_origen']}: {len(dias)} días con decisiones, "
          f"LSTM con datos {con_l[0] if con_l else '-'} → {con_l[-1] if con_l else '-'}")
    for x in [x for x in dias if x >= CORTE][:1] + [x for x in dias if x >= CORTE][-1:]:
        print(f"   {x}: MIIA {len(dias[x]['miia'])} instr · LSTM {len(dias[x]['lstm'])} instr")
    informe(d, "PRE-CORTE (13 instrumentos, banda)", "2026-06-01", CORTE)
    informe(d, "POST-CORTE (ranking, sólo secciones completas de 50)", CORTE, "2099-01-01", 50)
    return 0


if __name__ == "__main__":
    sys.exit(main())
