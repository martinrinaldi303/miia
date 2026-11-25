"""Rendimiento real de los portafolios de class15, medido sobre un volcado local.

Es la validación offline de `/api/portfolio/rendimiento` (miia_chatbot.py): corre
el MISMO cálculo sobre una copia de la base, sin tocar producción. Si el endpoint
y este script no dan lo mismo sobre el mismo volcado, uno de los dos está mal.

    python docs/simulaciones/sim5_rendimiento_portafolios.py MIIA_backup_....sql

Qué contesta, y por qué existe cada parte:

 1. CUÁNTO RINDEN LOS PORTAFOLIOS. Hasta el 21-sep-2026 nadie lo había medido:
    `portfolio_transactions` y `performance_snapshots` están vacías desde el
    primer día. class15 generó 97.151 portafolios y ninguno se ejecutó ni se
    siguió en el tiempo.

 2. CONTRA QUÉ. Contra la canasta equiponderada de los 13 —que es la pregunta
    honesta, porque class15 elige 8 de esos 13 y los pesa iguales (0,125 en
    776.845 de 776.923 filas): lo único que decide es a cuáles 5 deja afuera—
    y contra el S&P 500 aproximado con los 10 SPDR sectoriales.

 3. CUÁNTO TARDA EN CONTESTARSE. La pregunta "¿cuánto rinde?" tiene mucho peor
    relación señal/ruido que la direccional, porque cada sesión aporta UNA
    observación (el portafolio) en vez de trece (los instrumentos ordenados).
    El bloque final calcula cuántos años hacen falta por tamaño de alfa.

 4. POR QUÉ NO SE ANUALIZA NADA. El mismo S&P, según de qué día se arranque,
    "anualiza" entre -41,5 % y +20,0 %. El bloque de ventanas móviles lo
    muestra: cualquier cifra anualizada sobre tres meses es la ventana, no el
    rendimiento.

Medido el 21-sep-2026 sobre el volcado del 15-sep (56 sesiones, 29-jun a 14-sep):

    horizonte   n    portafolio   canasta 13    diferencia   gana
      1 sesión  55      +0,076 %     +0,046 %   +0,030 %     55 %   ±0,074
      5 ses.    51      +0,205 %     +0,287 %   -0,082 %     41 %   ±0,154
     20 ses.    36      +0,949 %     +1,329 %   -0,380 %     39 %   ±0,346

    S&P 500 aprox. +1,25 % · canasta de los 13 +2,43 % (el período completo)
    alfa anualizado +7,52 %, t = 0,79  ->  RUIDO, no ventaja

TRAMPA: en `portfolio_assets` el ticker NO está en la columna `ticker` (vale ''
o NULL en las 776.923 filas) sino en `symbol`.
"""
import datetime as dt
import re
import statistics as st
import sys
from collections import defaultdict

CANASTA_13 = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLB", "XLU",
              "XLC", "XLRE", "ARGT", "EWZ", "ILF"]
# Pesos aproximados del S&P 500, renormalizados sobre los 10 SPDR que MIIA
# cotiza. Falta XLP (~5 % del índice): es una vara de referencia, no el índice.
SP_PESOS = {"XLK": 33.0, "XLF": 14.0, "XLV": 10.0, "XLY": 10.0, "XLC": 10.0,
            "XLI": 8.0, "XLE": 3.0, "XLU": 2.5, "XLRE": 2.0, "XLB": 2.0}
HORIZONTES = (1, 5, 20)
SESIONES_ANIO = 252

_CAMPO = re.compile(rb"'((?:[^']|'')*)'|NULL|([^,]+)")


def _campos(t):
    out = []
    for m in _CAMPO.finditer(t):
        if m.group(1) is not None:
            out.append(m.group(1).decode("utf8", "replace"))
        elif m.group(2) is not None:
            out.append(m.group(2).decode())
        else:
            out.append(None)
    return out


def _tuplas(ln, pref):
    for t in ln[len(pref):].rstrip(b";\r\n").split(b"),("):
        yield t.lstrip(b"(").rstrip(b")")


def leer(ruta):
    """(activos por portafolio, portafolio -> ts, cierres diarios por ticker)."""
    PA = b"INSERT INTO `portfolio_assets` VALUES "
    PO = b"INSERT INTO `portfolios` VALUES "
    PR = b"INSERT INTO `precios` VALUES "
    act, port, cierre = defaultdict(list), {}, defaultdict(dict)
    with open(ruta, "rb") as f:
        for ln in f:
            if ln.startswith(PA):
                for t in _tuplas(ln, PA):
                    c = _campos(t)
                    if len(c) > 3 and c[3]:
                        act[c[1]].append(c[3])          # c[3] = symbol, NO c[2]
            elif ln.startswith(PO):
                for t in _tuplas(ln, PO):
                    c = _campos(t)
                    if len(c) > 12 and c[3] and c[12]:
                        port[c[3]] = c[12]              # portfolio_id -> ts
            elif ln.startswith(PR):
                for t in _tuplas(ln, PR):
                    c = _campos(t)
                    # Cierre = último precio del día hasta las 22:00 hora server
                    # (el NYSE cierra 16:00 de Nueva York = 22:00 CEST).
                    if len(c) > 7 and c[3] and c[7] and c[7][11:19] <= "22:00:00":
                        cierre[c[1]][c[7][:10]] = float(c[3])
    return act, port, cierre


def medir(act, port, cierre):
    ses = sorted(set.intersection(*[set(cierre[t]) for t in CANASTA_13]))
    ses = [f for f in ses if dt.date.fromisoformat(f).weekday() < 5]
    idx = {f: i for i, f in enumerate(ses)}

    def ret(tk, a, b):
        pa, pb = cierre[tk].get(a), cierre[tk].get(b)
        return None if not pa or not pb or pa <= 0 else pb / pa - 1.0

    def cesta(tks, a, b, pesos=None):
        v = [(t, ret(t, a, b)) for t in tks]
        v = [(t, x) for t, x in v if x is not None]
        if not v:
            return None
        if pesos is None:
            return sum(x for _, x in v) / len(v)
        tot = sum(pesos[t] for t, _ in v)
        return sum(pesos[t] * x for t, x in v) / tot if tot else None

    # Un portafolio por sesión: el último generado antes del cierre.
    del_dia = {}
    for pid, ts in port.items():
        f = ts[:10]
        if f in idx and ts[11:19] <= "22:00:00" and ts > del_dia.get(f, ("", ""))[0]:
            del_dia[f] = (ts, pid)

    f0, f1 = ses[0], ses[-1]
    dias = (dt.date.fromisoformat(f1) - dt.date.fromisoformat(f0)).days
    print(f"Periodo {f0} a {f1}  ({len(ses)} sesiones, {dias} dias corridos)\n")
    print(f"  S&P 500 aproximado : {cesta(list(SP_PESOS), f0, f1, SP_PESOS) * 100:+7.2f} %")
    print(f"  Canasta de los 13  : {cesta(CANASTA_13, f0, f1) * 100:+7.2f} %")

    print(f"\n{'horizonte':>11} {'n':>4} {'portafolio':>12} {'canasta 13':>12} "
          f"{'diferencia':>12} {'gana':>6} {'t':>7}")
    exceso_1s = []
    for h in HORIZONTES:
        dif, rp_l, rc_l = [], [], []
        indep = []          # ventanas que NO se solapan: una cada h sesiones
        for f in ses:
            i = idx[f]
            if i + h >= len(ses):
                continue
            b = ses[i + h]
            tks = [t for t in act.get(del_dia.get(f, ("", ""))[1], []) if t in cierre]
            if len(tks) < 4:
                continue
            rp, rc = cesta(tks, f, b), cesta(CANASTA_13, f, b)
            if rp is None or rc is None:
                continue
            rp_l.append(rp * 100); rc_l.append(rc * 100); dif.append((rp - rc) * 100)
            if i % h == 0:
                indep.append((rp - rc) * 100)
            if h == 1:
                exceso_1s.append(rp - rc)
        if not dif:
            continue
        m = st.mean(dif)
        ee = st.stdev(dif) / len(dif) ** 0.5 if len(dif) > 1 else 0
        gana = sum(1 for x in dif if x > 0) / len(dif) * 100
        sol = " (ventanas solapadas)" if h > 1 else ""
        print(f"{h:>8} ses {len(dif):>4} {st.mean(rp_l):>11.3f}% {st.mean(rc_l):>11.3f}% "
              f"{m:>+11.3f}% {gana:>5.0f}% {m/ee if ee else 0:>+7.2f}   +/-{1.96*ee:.3f}{sol}")
        # La significancia sale SIEMPRE de las ventanas independientes. Con las
        # solapadas, el horizonte de 20 sesiones daba t = -2,15 sobre 36
        # ventanas que en realidad son ~2,8 observaciones: pasaría por hallazgo.
        if h > 1:
            ti = None
            if len(indep) > 1 and st.stdev(indep) > 0:
                ti = st.mean(indep) / (st.stdev(indep) / len(indep) ** 0.5)
            ok = ti is not None and abs(ti) > 1.96 and len(indep) >= 5
            txt_t = f"{ti:+.2f}" if ti is not None else "s/d"
            print(f"{'':>13}sin solapar: n={len(indep)}  t={txt_t}"
                  f"   -> {'SIGNIFICATIVO' if ok else 'no significativo'}")

    # ── Alfa: NUNCA sin su t al lado ────────────────────────────────────────
    n = len(exceso_1s)
    m, sd = st.mean(exceso_1s), st.stdev(exceso_1s)
    vol_an = sd * SESIONES_ANIO ** 0.5 * 100
    t = m / (sd / n ** 0.5)
    print(f"\nALFA sobre la canasta: {m * SESIONES_ANIO * 100:+.2f} % anual  ·  "
          f"volatilidad {vol_an:.2f} %  ·  t = {t:+.2f}   "
          f"({'significativo' if abs(t) > 1.96 else 'RUIDO: hace falta |t| > 1,96'})")
    print(f"Alfa minimo detectable con {n} sesiones: "
          f"{1.96 * vol_an / (n / SESIONES_ANIO) ** 0.5:.1f} % anual\n")
    print("Cuanto hay que medir para demostrar un alfa, con esta volatilidad:")
    for a in (1, 3, 5, 10, 20):
        anios = (1.96 * vol_an / a) ** 2
        print(f"   alfa {a:>2} % anual -> {anios:>6.1f} anos ({anios * SESIONES_ANIO:>7.0f} ruedas)")

    # ── Por qué no se anualiza nada ─────────────────────────────────────────
    print("\nPOR QUE NO SE ANUALIZA: el mismo indice, segun de que dia se arranque")
    print(f"{'arranca':>12} {'dias':>5} {'S&P bruto':>10} {'S&P ANUALIZADO':>16}")
    for i in range(0, len(ses) - 3, max(1, len(ses) // 8)):
        a, d = ses[i], (dt.date.fromisoformat(f1) - dt.date.fromisoformat(ses[i])).days
        r = cesta(list(SP_PESOS), a, f1, SP_PESOS)
        print(f"{a:>12} {d:>5} {r*100:>9.2f}% {((1+r)**(365/max(d,1))-1)*100:>15.1f}%")


def redundancia(act, port, cierre):
    """Los 97.151 portafolios, no uno por sesión. Y cuántos son de verdad.

    Martín pidió rehacer la lectura con TODOS los portafolios de la base, que
    es la pregunta correcta: ¿cambia la respuesta si uso los 97.151 en vez de
    56? La respuesta es que no cambia el número y sí cambia —falsamente— la
    precisión. Este bloque existe para dejarlo demostrado con sus datos.
    """
    ses = sorted(set.intersection(*[set(cierre[t]) for t in CANASTA_13]))
    ses = [f for f in ses if dt.date.fromisoformat(f).weekday() < 5]
    idx = {f: i for i, f in enumerate(ses)}

    def cesta(tks, a, b):
        v = [cierre[t][b] / cierre[t][a] - 1.0 for t in tks
             if cierre[t].get(a) and cierre[t].get(b) and cierre[t][a] > 0]
        return sum(v) / len(v) if v else None

    por_ses, comps = {}, set()
    usables = 0
    for pid, ts in port.items():
        f = ts[:10]
        if f not in idx or ts[11:19] > "22:00:00":
            continue
        tks = tuple(sorted(t for t in act.get(pid, []) if t in cierre))
        if len(tks) < 4:
            continue
        usables += 1
        por_ses.setdefault(f, []).append(tks)
        comps.add((f, tks))

    print(f"\n{'='*78}\nTODOS LOS PORTAFOLIOS, NO UNO POR SESION\n{'='*78}")
    print(f"portafolios en la base        : {len(port)}")
    print(f"con activos y dentro de sesion: {usables}")
    print(f"sesiones cubiertas            : {len(por_ses)}")
    print(f"pares (sesion, composicion)   : {len(comps)}  <- observaciones DISTINTAS")
    print(f"redundancia                   : {usables/max(len(comps),1):.1f} copias por observacion\n")
    print(f"{'horizonte':>10} {'dif':>9} {'banda ingenua':>15} {'por sesion':>12} "
          f"{'sin solapar':>13}  veredicto")
    for h in HORIZONTES:
        todos, x_ses, x_ind = [], [], []
        for f in sorted(por_ses):
            i = idx[f]
            if i + h >= len(ses):
                continue
            b = ses[i + h]
            rc = cesta(CANASTA_13, f, b)
            difs = [(cesta(list(cp), f, b) - rc) * 100 for cp in por_ses[f]
                    if cesta(list(cp), f, b) is not None]
            if not difs:
                continue
            todos += difs
            x_ses.append(sum(difs) / len(difs))
            if i % h == 0:
                x_ind.append(x_ses[-1])
        if len(x_ses) < 2:
            continue
        ing = 1.96 * st.stdev(todos) / len(todos) ** 0.5
        hon = 1.96 * st.stdev(x_ses) / len(x_ses) ** 0.5
        ind = 1.96 * st.stdev(x_ind) / len(x_ind) ** 0.5 if len(x_ind) > 1 else None
        m = st.mean(x_ses)
        ok = ind is not None and abs(m) > ind and len(x_ind) >= 5
        print(f"{h:>7} ses {m:>+8.3f}% {'+/-'+format(ing,'.4f'):>15} "
              f"{'+/-'+format(hon,'.3f'):>12} "
              f"{('+/-'+format(ind,'.3f')) if ind else 's/d':>13} (n={len(x_ind):>2})  "
              f"{'SIGNIFICATIVO' if ok else 'no significativo'}")
    print("\nLa banda 'ingenua' trata a los 97.151 como observaciones independientes.")
    print("No lo son: hay ~57 copias de cada par (sesion, composicion). A 20 sesiones")
    print("esa banda sale 194 veces mas angosta que la honesta y convertiria un -0,28 %")
    print("sin significancia en un hallazgo aplastante. Mas filas NO es mas informacion.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    datos = leer(sys.argv[1])
    medir(*datos)
    redundancia(*datos)
