"""sim13_ensamble.py — el ensamble entero, contra los datos de la base.

QUÉ ES. Las otras simulaciones prueban una pieza cada una. Ésta arma las
**secciones transversales reales** del volcado —qué score le puso MIIA a cada
uno de los 13 instrumentos en cada rueda, y cuánto rindió cada uno después— y
las hace pasar por las tres capas del corte del 12-oct, en el orden en que
corren en producción:

    class43 (JS)     la vara equiponderada  ->  el retorno relativo
    class25A (C++)   el ranking transversal ->  quién sale BUY y quién SELL
    rank_ic (Python) el rank IC             ->  ¿los ordenó bien?

No necesita el sistema corriendo ni toca producción: lee el volcado, que ya
está en el disco de Martín.

    python docs/simulaciones/sim13_ensamble.py --extraer   # relee el volcado
    python docs/simulaciones/sim13_ensamble.py             # corre las pruebas

La extracción tarda unos minutos (1,49 GB) y queda guardada en
`datos/ventanas_ensamble.json` — un extracto chico y sin datos de usuarios, que
sí se versiona. El volcado NO va a git: tiene PII.

⚠️ LO QUE ESTE TEST NO PRUEBA. Que MIIA vaya a predecir mejor. El rank IC que
mide acá sale de los scores de un sistema que TODAVÍA tiene el defecto 10 (las
redes entrenadas con la etiqueta de otro instrumento). Es la línea de base
contra la que se compara en diciembre, no un pronóstico.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
sys.path.insert(0, str(RAIZ / "MIIA"))

import rank_ic                                      # noqa: E402  el código de producción
from universo import TICKERS as UNIVERSO            # noqa: E402  la fuente única

VOLCADO  = RAIZ / "MIIA_backup_2026-09-15-00-29-30.sql"
GUARDADO = AQUI / "datos" / "ventanas_ensamble.json"

fallos = 0


def chequear(que: str, ok: bool, detalle: str = "") -> None:
    global fallos
    print(f"   {'[ok]' if ok else '[NO]'} {que:<54} {detalle}")
    if not ok:
        fallos += 1


# ════════════════════════════════════════════════════════════════════
# 1 · Extracción del volcado
# ════════════════════════════════════════════════════════════════════
CAMPO = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")
# "(ensemble=0.6123 > umbral=0.42)" — el único lugar donde sobrevivió el score
# de las filas viejas. Ver el comentario de `_rank_ic` en miia_chatbot.py.
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
    """El orden de las columnas, leído del CREATE TABLE del volcado.

    Se RECORRE el archivo en vez de leer los primeros megas: mysqldump escribe
    las tablas por orden alfabético y `precios` cae mucho después del principio.
    Leer una cabecera fija funcionaba para `cognitive_decisions` y fallaba para
    cualquier tabla posterior — que es como se descubrió.

    No se usa `docs/esquema_miia_cognitiva.sql` a propósito: el orden de las
    columnas del INSERT lo define ESTE volcado. Si el esquema del repo quedara
    un ALTER atrás, los campos se leerían corridos y los números saldrían
    plausibles pero de otra columna.
    """
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


def extraer() -> dict:
    if not VOLCADO.exists():
        raise SystemExit(f"no está el volcado: {VOLCADO}")
    ic = _columnas("cognitive_decisions")
    ip = _columnas("precios")
    univ = set(UNIVERSO)

    P_DEC = b"INSERT INTO `cognitive_decisions` VALUES "
    P_PRE = b"INSERT INTO `precios` VALUES "

    acum: dict = {}      # (día, ticker) -> [suma de scores, n, {senal: n}]
    cierre: dict = {}    # (día, ticker) -> (ts más tardío, precio)

    for ln in VOLCADO.open("rb"):
        if ln.startswith(P_DEC):
            es_decision = True
            pref = P_DEC
        elif ln.startswith(P_PRE):
            es_decision = False
            pref = P_PRE
        else:
            continue

        for t in ln[len(pref):].rstrip(b";\r\n").split(b"),("):
            c = _campos(t.lstrip(b"(").rstrip(b")"))

            if es_decision:
                if len(c) < len(ic):
                    continue
                tk = c[ic["ticker"]]
                if tk not in univ:
                    continue
                if c[ic["temperatura"]] == "shadow":
                    continue          # mismo filtro que el endpoint
                ts = c[ic["ts_decision"]]
                if not ts:
                    continue
                # El score: la columna si está (desde el 12-oct), y si no el
                # texto. Hoy la columna es NULL en el 100 % de las filas.
                sc = c[ic["score"]]
                if sc in (None, "NULL", ""):
                    m = ENSEMBLE.search(c[ic["razon"]] or "")
                    if not m:
                        continue
                    sc = m.group(1)
                try:
                    v = float(sc)
                except ValueError:
                    continue
                k = (ts[:10], tk)
                e = acum.setdefault(k, [0.0, 0, {}])
                e[0] += v
                e[1] += 1
                sn = c[ic["senal"]] or "?"
                e[2][sn] = e[2].get(sn, 0) + 1

            else:
                if len(c) < len(ip):
                    continue
                tk = c[ip["ticker"]]
                if tk not in univ:
                    continue
                ts, pr = c[ip["ts"]], c[ip["precio"]]
                if not ts or pr in (None, "NULL"):
                    continue
                try:
                    pv = float(pr)
                except ValueError:
                    continue
                if pv <= 0:
                    continue
                k = (ts[:10], tk)
                if k not in cierre or ts > cierre[k][0]:
                    cierre[k] = (ts, pv)

    ruedas: dict = {}
    for (dia, tk), (suma, n, senales) in acum.items():
        r = ruedas.setdefault(dia, {"dia": dia, "scores": {}, "n": {}, "senales": {}})
        r["scores"][tk] = round(suma / n, 6)
        r["n"][tk] = n
        r["senales"][tk] = senales

    cierres: dict = {}
    for (dia, tk), (_ts, pv) in cierre.items():
        cierres.setdefault(dia, {})[tk] = pv

    return {
        "_origen": VOLCADO.name,
        "_generado_por": "docs/simulaciones/sim13_ensamble.py --extraer",
        "_que_es": ("Secciones transversales reales: el score medio que MIIA le puso a "
                    "cada instrumento en cada rueda, y el cierre de cada instrumento. "
                    "Sin datos de usuarios."),
        "universo": list(UNIVERSO),
        "ruedas":  [ruedas[d] for d in sorted(ruedas)],
        "cierres": {d: cierres[d] for d in sorted(cierres)},
    }


# ════════════════════════════════════════════════════════════════════
# 2 · Las ventanas: predicción de hoy contra el relativo de mañana
# ════════════════════════════════════════════════════════════════════
def armar_ventanas(datos: dict):
    """[(ticker, score, retorno_relativo)] por rueda, sin solapar.

    Misma definición que `_rank_ic` en `miia_chatbot.py`: ventana = sesión,
    predicción = score medio de esa sesión, realizado = retorno relativo de la
    sesión SIGUIENTE. Si las dos no coincidieran, el número del panel y el de
    esta prueba medirían cosas distintas y no habría forma de saber cuál vale.
    """
    cierres = datos["cierres"]
    sesiones = sorted(cierres)

    rets: dict = {}
    for i in range(1, len(sesiones)):
        hoy, ayer = sesiones[i], sesiones[i - 1]
        for tk, p1 in cierres[hoy].items():
            p0 = cierres[ayer].get(tk)
            if p0 and p0 > 0:
                rets.setdefault(hoy, {})[tk] = p1 / p0 - 1.0

    # Días SIN SESIÓN: el fin de semana `precios` sigue teniendo filas —class7
    # publica igual— pero el precio no cambia, así que los 13 retornos dan 0 y
    # no hay orden que medir. Medido acá: 25 de 78 días. Mismo filtro que
    # `_rank_ic` en miia_chatbot.py; si los dos no coincidieran, el número del
    # panel y el de esta prueba saldrían de muestras distintas.
    for d in [d for d, r in rets.items()
              if not r or max(abs(x) for x in r.values()) == 0.0]:
        del rets[d]

    con_ret = sorted(rets)
    ventanas, dias, usada = [], [], ""
    for r in datos["ruedas"]:
        dia = r["dia"]
        fut = [s for s in con_ret if s > dia]
        if not fut:
            continue
        # Sin solape, y se mira el PERÍODO REALIZADO, no el día de la decisión:
        # el sábado y el viernes apuntan los dos al lunes. Contarlos como dos
        # ventanas sería medir la misma sesión dos veces — la trampa que con
        # las ventanas de 20 sesiones daba t = -2,15 en vez de -0,23.
        if fut[0] <= usada:
            continue
        rel = rank_ic.retornos_relativos(rets[fut[0]])
        sec = [(tk, sc, rel[tk]) for tk, sc in r["scores"].items() if tk in rel]
        if sec:
            ventanas.append(sec)
            dias.append(fut[0])       # la sesión MEDIDA, no la de la decisión
            usada = fut[0]
    return ventanas, dias, rets


def kendall_referencia(xs, ys):
    """Implementación INDEPENDIENTE, para que la prueba no se verifique a sí misma.

    Cuenta pares concordantes y discordantes: es el tau de Kendall. No da el
    mismo número que Spearman, pero sí el mismo SIGNO. Alcanza para detectar que
    `rank_ic.spearman` esté dado vuelta o devolviendo cualquier cosa, que es
    contra lo que sirve una referencia — comparar código contra sí mismo no
    prueba nada.
    """
    n = len(xs)
    conc = disc = 0
    for i in range(n):
        for j in range(i + 1, n):
            dx, dy = xs[i] - xs[j], ys[i] - ys[j]
            if dx == 0 or dy == 0:
                continue
            if (dx > 0) == (dy > 0):
                conc += 1
            else:
                disc += 1
    tot = conc + disc
    return (conc - disc) / tot if tot else None


def _buscar_sim9():
    """El binario que compila probar.ps1. Si no está, la sección se saltea."""
    tmp = os.environ.get("TEMP") or "/tmp"
    for cand in (Path(tmp) / "miia-sim7" / "sim9.exe",
                 Path(tmp) / "miia-sim7" / "sim9",
                 AQUI / "sim9.exe",
                 AQUI / "sim9"):
        if cand.exists():
            return cand
    return None


def _entorno_con_mingw() -> dict:
    """PATH con MinGW adelante, para que el .exe encuentre sus DLL.

    Un binario de g++ en Windows depende de `libstdc++-6.dll`, `libgcc_s_seh-1`
    y las de spdlog/fmt, que viven en `C:\\msys64\\mingw64\\bin`. Si esa carpeta
    no está en el PATH, Windows lo mata con 0xC0000135 (DLL no encontrada) ANTES
    de ejecutar una línea, y el código de salida —3221225781— no se parece en
    nada a un fallo del test. Pasó en la primera corrida de sim13 y costó un
    minuto entender que no era un error del C++.

    `probar.ps1` ya deja MinGW en el PATH del proceso, así que ahí sobra; esto
    hace que sim13 también corra solo, desde cualquier consola.
    """
    env = dict(os.environ)
    # Se agrega UNA sola, la primera que exista, y se corta. Prepender las tres
    # dejaba `ucrt64` delante de `mingw64` —el último prepend queda primero— y
    # el binario, compilado con mingw64, cargaba el `libstdc++` de ucrt64:
    # 0xC0000374, corrupción de heap. El error se parece a un bug del C++ y no
    # lo es. Una sola entrada, la que corresponde, y no hay mezcla posible.
    for d in (r"C:\msys64\mingw64\bin", r"C:\msys64\ucrt64\bin", r"C:\MinGW\bin"):
        if Path(d).is_dir():
            if d.lower() not in env.get("PATH", "").lower():
                env["PATH"] = d + os.pathsep + env.get("PATH", "")
            break
    return env


# ════════════════════════════════════════════════════════════════════
def main() -> int:
    print("\n=== El ensamble entero, contra los datos de la base ============")

    if "--extraer" in sys.argv or not GUARDADO.exists():
        print("\n   extrayendo del volcado (tarda unos minutos)…")
        datos = extraer()
        GUARDADO.parent.mkdir(parents=True, exist_ok=True)
        GUARDADO.write_text(json.dumps(datos, indent=1), encoding="utf8")
        print(f"   guardado en {GUARDADO.relative_to(RAIZ)}")
    else:
        datos = json.loads(GUARDADO.read_text(encoding="utf8"))

    ruedas = datos["ruedas"]
    print(f"\n   {len(ruedas)} ruedas con score · {len(datos['cierres'])} con precios "
          f"· universo de {len(datos['universo'])}")

    # ── 1 · ¿Existe la sección transversal? ──────────────────────────
    print("\n1 · La sección transversal, que es lo que el ranking necesita")
    completas = [r for r in ruedas if len(r["scores"]) >= 10]
    chequear("hay ruedas con la sección completa", len(completas) >= 10,
             f"{len(completas)} de {len(ruedas)} con >= 10 instrumentos")
    if ruedas:
        med = sorted(len(r["scores"]) for r in ruedas)[len(ruedas) // 2]
        chequear("la mediana llega al mínimo de class25A (10)", med >= 10,
                 f"mediana = {med} instrumentos por rueda")

    # ── 2 · Lo que MIIA hizo de verdad ───────────────────────────────
    print("\n2 · Lo que el sistema publicó en esas mismas ruedas")
    buy  = sum(s.get("BUY", 0)  for r in ruedas for s in r["senales"].values())
    sell = sum(s.get("SELL", 0) for r in ruedas for s in r["senales"].values())
    hold = sum(s.get("HOLD", 0) for r in ruedas for s in r["senales"].values())
    pct_buy = 100 * buy / (buy + sell) if buy + sell else 0
    # Techo de la ventaja: min(BUY,SELL)/(BUY+SELL). Ver "La métrica de la tesis".
    techo = 100 * min(buy, sell) / (buy + sell) if buy + sell else 0
    print(f"      BUY {buy:,} · SELL {sell:,} · HOLD {hold:,}  ->  {pct_buy:.0f} % BUY")
    print(f"      techo del edge con esa mezcla: {techo:.0f} pp")
    chequear("la mezcla histórica es ASIMÉTRICA (por eso el ranking)",
             abs(pct_buy - 50) > 5, f"{pct_buy:.0f} % BUY, lejos de 50")

    # ── 3 · Las ventanas ─────────────────────────────────────────────
    print("\n3 · Ventanas: score de hoy contra el relativo de mañana")
    ventanas, dias, rets = armar_ventanas(datos)
    chequear("se armaron ventanas suficientes", len(ventanas) >= 10,
             f"{len(ventanas)} ventanas ({dias[0]} a {dias[-1]})" if dias else "0")
    chequear("cada ventana MIDE una sesión distinta (NO se solapan)",
             len(set(dias)) == len(dias), "es lo que dio vuelta el t = -2,15")
    chequear("ninguna ventana cae en un día sin sesión",
             all(any(abs(r) > 0 for _, _, r in v) for v in ventanas),
             "el finde el precio no se mueve y no hay orden que medir")
    if ventanas:
        chequear("los retornos relativos de una ventana suman ~0",
                 all(abs(sum(r for _, _, r in v)) < 1e-9 for v in ventanas[:20]),
                 "equiponderado, como _marketRet")

    # ── 4 · El rank IC, con el código de producción ──────────────────
    print("\n4 · Rank IC — ejecutando MIIA/rank_ic.py, el mismo que el endpoint")
    res = rank_ic.serie_ic(ventanas)
    for k in ("rank_ic", "rank_ic_desvio", "rank_ic_ventanas", "rank_ic_t",
              "rank_ic_min_detectable", "rank_ic_significativo",
              "rank_ic_instrumentos", "rank_ic_sin_orden"):
        print(f"      {k:<24} {res[k]}")
    if res["rank_ic_sin_orden"]:
        print(f"      ({res['rank_ic_sin_orden']} ventana(s) existieron y NO dieron IC: "
              f"o los scores empataron —la firma de una red saturada— o los "
              f"retornos no se movieron.)")

    chequear("el IC cae en un rango posible [-1, 1]",
             res["rank_ic"] is not None and -1 <= res["rank_ic"] <= 1)
    chequear("el promedio de instrumentos no supera el universo",
             res["rank_ic_instrumentos"] <= len(datos["universo"]),
             f"{res['rank_ic_instrumentos']} de {len(datos['universo'])}")
    chequear("el desvío por ventana es el esperable con 13 instrumentos",
             res["rank_ic_desvio"] is not None and 0.15 < res["rank_ic_desvio"] < 0.45,
             f"{res['rank_ic_desvio']} (teórico 1/raiz(12) = 0,289)")
    # Ésta es LA conclusión del 21-sep, y conviene que el test la sostenga sola:
    # con 13 instrumentos no alcanza, y el número que lo dice es el MDE.
    chequear("con 13 instrumentos el MDE queda por encima del IC en juego",
             res["rank_ic_min_detectable"] is not None
             and res["rank_ic_min_detectable"] > 0.04,
             f"MDE {res['rank_ic_min_detectable']} > 0,040 (el IC en juego)")
    chequear("nada se declara significativo por debajo de su propio MDE",
             (res["rank_ic_significativo"] is False)
             == (res["rank_ic"] - res["rank_ic_min_detectable"] <= 0),
             "el mismo criterio que edge_min_detectable")

    # ── 5 · Contra una implementación independiente ──────────────────
    print("\n5 · La aritmética, contra una referencia que no comparte código")
    signos_ok = comparadas_ic = 0
    for v in ventanas:
        xs = [s for _, s, _ in v]
        ys = [r for _, _, r in v]
        a = rank_ic.spearman(xs, ys)
        b = kendall_referencia(xs, ys)
        if a is None or b is None:
            continue
        comparadas_ic += 1
        if (a > 0) == (b > 0) or (abs(a) < 1e-9 and abs(b) < 1e-9):
            signos_ok += 1
    chequear("el signo coincide con Kendall en todas las ventanas",
             comparadas_ic > 0 and signos_ok == comparadas_ic,
             f"{signos_ok}/{comparadas_ic}")
    chequear("una ventana perfecta da IC = 1",
             rank_ic.spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) == 1.0)
    chequear("una ventana al revés da IC = -1",
             rank_ic.spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]) == -1.0)
    chequear("con todos los scores iguales no hay IC (y no explota)",
             rank_ic.spearman([1, 1, 1, 1, 1], [5, 4, 3, 2, 1]) is None,
             "una red saturada no ordena nada")

    # ── 6 · La vara: equiponderado contra compuesto de precios ───────
    print("\n6 · La vara — defecto 5, medido sobre estas mismas sesiones")
    dif_signo = comparadas = 0
    for dia in sorted(rets):
        r = rets[dia]
        if len(r) < 10:
            continue
        pre = datos["cierres"].get(dia, {})
        if any(t not in pre for t in r):
            continue
        equi = sum(r.values()) / len(r)
        # El índice viejo de class43: promedio de PRECIOS, no de retornos. Su
        # retorno es el del promedio, o sea ponderado por precio — XLK (188)
        # pesaba 15,8 % e ILF (35) el 2,9 %.
        ayer = {t: pre[t] / (1 + r[t]) for t in r}
        comp = (sum(pre[t] for t in r) / sum(ayer[t] for t in r)) - 1.0
        comparadas += 1
        if (equi > 0) != (comp > 0):
            dif_signo += 1
    if comparadas:
        print(f"      {dif_signo} de {comparadas} sesiones con el SIGNO del mercado "
              f"dado vuelta ({100*dif_signo/comparadas:.0f} %)")
    chequear("se pudo comparar la vara vieja con la nueva", comparadas >= 10,
             f"{comparadas} sesiones")

    # ── 7 · class25A, el binario real, sobre las secciones reales ────
    print("\n7 · El ranking de class25A sobre estas secciones (C++ compilado)")
    exe = _buscar_sim9()
    if exe is None:
        print("      sim9 no está compilado — lo compila probar.ps1 o build_sim9.sh.")
        print("      (esta sección se saltea; no cuenta como falla)")
    else:
        r = subprocess.run([str(exe), str(GUARDADO)], capture_output=True, text=True,
                           encoding="utf8", errors="replace", env=_entorno_con_mingw())
        marca = "9 ·"
        salida = r.stdout.splitlines()
        desde = next((i for i, l in enumerate(salida) if marca in l), None)
        for l in (salida[desde:] if desde is not None else salida[-12:]):
            if l.strip():
                print("      " + l)
        chequear("class25A ordena las secciones reales sin fallar",
                 r.returncode == 0, f"exit={r.returncode}")

    print(f"\n{'PASA' if fallos == 0 else 'FALLA'} — ensamble contra la base\n")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
