# Convierte la salida de miia_check.sh (o de lectura_diaria.sh) en filas para la
# planilla. Lo que hasta el 5-oct-2026 se armaba a mano en cada lectura.
#
# Uso:
#   python docs/planilla/leer_chequeo.py lectura.txt [otra.txt ...]          → imprime el JSON
#   python docs/planilla/leer_chequeo.py --cargar lectura.txt [otra.txt ...]  → respalda y carga
#   python docs/planilla/leer_chequeo.py --probar                             → prueba contra un chequeo real
#
# La fecha sale del encabezado del chequeo (hora del server, CEST o CET) y se
# pasa a hora de Argentina, que es como se carga desde el 22-sep.
#
# Las notas que arma son SÓLO los números y las alarmas que el propio chequeo
# marca. La lectura con criterio —qué significa, contra qué predicción— no se
# automatiza: se agrega aparte. Un campo que no está en el texto queda en null
# (celda vacía), nunca en un valor inventado.
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

AQUI = Path(__file__).resolve().parent
PLANILLA = Path(r"C:\Users\martin\Desktop\redes_neuronales_de_miia.xlsx")
OFFSET_TZ = {"CEST": 2, "CET": 1, "UTC": 0, "GMT": 0}
ART = -3


def num(s):
    try:
        return float(str(s).replace(",", "."))
    except (TypeError, ValueError):
        return None


def buscar(patron, texto, grupo=1, conv=num):
    m = re.search(patron, texto, re.M)
    return conv(m.group(grupo)) if m else None


def fecha_art(texto):
    m = re.search(r"diagnóstico\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}\s+([A-Z]{3,4})", texto)
    if not m:
        raise ValueError("no encuentro el encabezado «diagnóstico AAAA-MM-DD hh:mm:ss TZ»")
    local = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M")
    tz = m.group(2)
    if tz not in OFFSET_TZ:
        raise ValueError(f"zona horaria desconocida en el encabezado: {tz}")
    return local - timedelta(hours=OFFSET_TZ[tz] - ART)


def proceso(texto, nombre):
    """RSS en MB de un proceso del top 5 de la sección 1 (null si no entró al top)."""
    return buscar(r"^\s+(\d+) MB\s+[\d.]+ d\s+" + re.escape(nombre) + r"\s*$", texto)


def pesos(texto):
    claves = dict(re.findall(r"^\s+(class2[1-4](?:/\w+)?|class44)\s+([\d.]+)\s*$", texto, re.M))
    if not claves:
        return None
    fam = {"mercado": 0.0, "cluster": 0.0, "impacto": 0.0, "portfolio": 0.0, "pelado": 0.0}
    for k, v in claves.items():
        v = float(v)
        if "/" in k:
            f = k.split("/")[1]
            if f in fam:
                fam[f] += v
        elif k != "class44":
            fam["pelado"] += v
    modulos = {m: sum(float(v) for k, v in claves.items() if k == m or k.startswith(m + "/"))
               for m in ("class21", "class22", "class23", "class24")}
    return fam, modulos, {k: float(v) for k, v in claves.items()}


def red24(texto, prefijo):
    """La línea de class24 de una red. Para `mercado` prefiere |22 (después del corte)."""
    filas = re.findall(r"\[class24\]\s+red='(\w+)\|(\d+)' dim=\d+ seen=(\d+) sup=(\d+) inf=\d+ "
                       r"ema_inf=([\d.]+)", texto)
    candidatas = [f for f in filas if f[0] == prefijo]
    if not candidatas:
        return None
    candidatas.sort(key=lambda f: (f[1] != "22", f[1]))   # |22 primero
    _, dim, seen, sup, ema = candidatas[0]
    return {"dim": int(dim), "seen": int(seen), "sup": int(sup), "ema": float(ema)}


def repaso(texto, modulo):
    m = re.search(r"--- repaso " + modulo + r"\s*\n.*?repaso: modo=(\w+) ejemplos=(\d+) .*?repasados=(\d+)",
                  texto)
    return (m.group(1), int(m.group(2)), int(m.group(3))) if m else None


def leer(texto):
    texto = texto.replace("\r\n", "\n")
    f = fecha_art(texto)
    fecha = f.strftime("%Y-%m-%d %H:%M")
    abierto = "mercado NYSE: ABIERTO" in texto or ("mercado NYSE: CERRADO" not in texto and
                                                   "mercado NYSE" in texto and "ABIERTO" in texto)
    rueda = "en rueda" if abierto else "mercado cerrado"

    # ── Pesos ───────────────────────────────────────────────
    filas = {"Pesos": [], "Tesis": [], "Redes": [], "Recursos": [], "Corte": []}
    hb = re.search(r"umbral=([\d.]+) emisión=([\d.]+)% .*?z=(\d+)/(\d+)", texto)
    p = pesos(texto)
    if p:
        fam, mod, _ = p
        umbral = float(hb.group(1)) if hb else None
        emision = float(hb.group(2)) / 100 if hb else None
        z = round(int(hb.group(3)) / int(hb.group(4)), 4) if hb and int(hb.group(4)) else None
        nota = ("[automática, " + rueda + "] por módulo: " +
                " · ".join(f"{m} {v:.4f}".replace(".", ",") for m, v in mod.items()) + ".")
        filas["Pesos"].append([fecha, round(fam["mercado"], 4), round(fam["cluster"], 4),
                               round(fam["impacto"], 4), round(fam["portfolio"], 4),
                               round(fam["pelado"], 4), umbral, emision, z, nota])

    # ── Tesis ───────────────────────────────────────────────
    n_ef = buscar(r"^\s+n_efectivo\s+:\s+([\d.]+)", texto)
    if n_ef is not None:
        base = buscar(r"^\s+base_rate\s+:\s+([\d.]+)", texto)
        acierto = buscar(r"^\s+accuracy_directional\s+:\s+([\d.]+)", texto)
        sig = buscar(r"^\s+edge_significativo\s+:\s+(\w+)", texto, conv=str)
        pend = buscar(r"pendientes BUY/SELL=(\d+)", texto)
        venc = buscar(r"YA VENCIDAS=(\d+)", texto)
        nota = "[automática]"
        if venc is not None:
            nota += f" vencidas {int(venc)}."
        filas["Tesis"].append([
            fecha, int(n_ef), buscar(r"^\s+edge_min_detectable\s+:\s+([-\d.]+)", texto),
            round(base / 100, 4) if base is not None else None,
            round(acierto / 100, 4) if acierto is not None else None,
            buscar(r"^\s+edge_vs_baseline\s+:\s+([-\d.]+)", texto),
            "si" if sig == "True" else "no",
            int(buscar(r"^\s+verificadas\s+:\s+(\d+)", texto) or 0) or None,
            int(buscar(r"^\s+dias_medidos\s+:\s+(\d+)", texto) or 0) or None,
            int(pend) if pend is not None else None, nota])

    # ── Redes (class24) ─────────────────────────────────────
    r = {k: red24(texto, k) for k in ("mercado", "portfolio", "impacto", "cluster")}
    if any(r.values()):
        g = lambda k, c: r[k][c] if r[k] else None
        nota = "[automática]"
        if r["mercado"]:
            nota += f" red de mercado = mercado|{r['mercado']['dim']}."
        filas["Redes"].append([fecha, g("mercado", "ema"), g("portfolio", "ema"), g("impacto", "ema"),
                               g("cluster", "ema"), g("mercado", "seen"), g("mercado", "sup"),
                               g("portfolio", "seen"), g("portfolio", "sup"), g("impacto", "seen"),
                               g("impacto", "sup"), g("cluster", "seen"), g("cluster", "sup"), nota])

    # ── Recursos ────────────────────────────────────────────
    ram = buscar(r"RAM (\d+)% —", texto)
    if ram is not None:
        disco = buscar(r"disco (\d+)%", texto)
        load = buscar(r"load ([\d.]+) ", texto)
        edad = buscar(r"orquestador pid=\d+ edad=(\d+)s", texto)
        disp = buscar(r"disponible (\d+) MB", texto)
        cache = buscar(r"caché (\d+) MB", texto)
        nota = "[automática]"
        if disp is not None:
            nota += f" disponible {int(disp)} MB, caché {int(cache or 0)} MB."
        filas["Recursos"].append([fecha, round(ram / 100, 4), round(disco / 100, 4) if disco is not None else None,
                                  load, proceso(texto, "mysqld"), proceso(texto, "class44.py"),
                                  proceso(texto, "class30.js"), proceso(texto, "miia_chatbot.py"),
                                  round(edad / 86400, 1) if edad else None, nota])

    # ── Corte (rank IC, repaso, memoria) ────────────────────
    tj = re.search(r"--- tesis \(json\)\s*\n(\{.*\})", texto)
    t = {}
    if tj:
        try:
            t = json.loads(tj.group(1))
        except json.JSONDecodeError:
            t = {}
    m44 = re.search(r"señales=\{([^}]*)\}", texto)
    pct_buy = None
    if m44 and abierto:
        cuenta = dict((k, int(v)) for k, v in re.findall(r"'(\w+)': (\d+)", m44.group(1)))
        b, s = cuenta.get("BUY", 0), cuenta.get("SELL", 0)
        pct_buy = round(b / (b + s), 4) if b + s else None
    r23, r24 = repaso(texto, "class23"), repaso(texto, "class24")
    cola = buscar(r'"queue_len":(\d+)', texto)
    swap = buscar(r"^Swap:\s+\d+\s+(\d+)", texto)
    swc = buscar(r"^SwapCached:\s+(\d+) kB", texto)
    hay_algo = t or r23 or r24 or cola is not None or swap is not None
    if hay_algo:
        sig_ic = t.get("rank_ic_significativo")
        nota = "[automática, " + rueda + "]"
        if r23 and r23[0] != "ACTIVO":
            nota += " repaso de class23 APAGADO."
        if r24 and r24[0] != "ACTIVO":
            nota += " repaso de class24 APAGADO."
        if not abierto:
            nota += " % BUY sin dato: con el mercado cerrado la muestra es toda GENERAL."
        filas["Corte"].append([
            fecha, t.get("rank_ic"), t.get("rank_ic_min_detectable"), t.get("rank_ic_ventanas"),
            t.get("rank_ic_desvio"), None if sig_ic is None else ("si" if sig_ic else "no"),
            t.get("decision_modo"), pct_buy,
            r23[1] if r23 else None, r23[2] if r23 else None,
            r24[1] if r24 else None, r24[2] if r24 else None,
            int(cola) if cola is not None else None, int(swap) if swap is not None else None,
            round(swc / 1024) if swc is not None else None, nota])
    return {k: v for k, v in filas.items() if v}


def juntar(archivos):
    out = {}
    for a in archivos:
        texto = Path(a).read_text(encoding="utf-8", errors="replace")
        for hoja, filas in leer(texto).items():
            out.setdefault(hoja, []).extend(filas)
    return out


def cargar(archivos):
    datos = juntar(archivos)
    if not datos:
        print("no salió ninguna fila de esos archivos")
        return 1
    hoy = datetime.now().strftime("%Y%m%d")
    resp = PLANILLA.with_name(f"redes_neuronales_de_miia.respaldo-{hoy}.xlsx")
    if PLANILLA.exists() and not resp.exists():
        shutil.copy2(PLANILLA, resp)
        print(f"respaldo: {resp.name}")
    tmp = AQUI / "_nuevas_automaticas.json"
    tmp.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
    try:
        return subprocess.call([sys.executable, str(AQUI / "actualizar_planilla.py"), str(tmp)])
    finally:
        tmp.unlink(missing_ok=True)


def probar():
    """Contra un chequeo REAL (el del 4-oct, cargado a mano ese día). Los números
    esperados son los que se cargaron a mano en la planilla."""
    texto = (AQUI / "prueba" / "chequeo_20261004.txt").read_text(encoding="utf-8")
    texto_extra = texto + (
        "\n══════ EXTRA · lectura_diaria.sh ══════\n--- free -m\n"
        "               total        used        free      shared  buff/cache   available\n"
        "Mem:           11960        6744        1500          10        3512        5216\n"
        "Swap:           4095        1732        2363\n--- meminfo\n"
        "SwapCached:       492544 kB\nSReclaimable:    3202000 kB\n--- class30 health_check\n"
        '[x] health_check {"uptime":2142000,"queue_len":306500}\n--- repaso class23\n'
        "[x] [info] [class23]   repaso: modo=ACTIVO ejemplos=1200 redes=1 agregados=1200 reemplazados=0 "
        "repasados=8000 sin_viejos=50 cada=4 tope=10000\n--- repaso class24\n--- tesis (json)\n"
        '{"rank_ic": 0.031, "rank_ic_min_detectable": 0.061, "rank_ic_ventanas": 9, "rank_ic_desvio": 0.14, '
        '"rank_ic_significativo": false, "decision_modo": "ranking"}\n══════ FIN ══════\n')
    d = leer(texto_extra)
    ok = total = 0

    def chk(cond, que):
        nonlocal ok, total
        total += 1
        ok += bool(cond)
        print(("   [OK]    " if cond else "   [FALLA] ") + que)

    chk(d["Pesos"][0][0] == "2026-10-04 16:37", "fecha 21:37 CEST → 16:37 ART: " + d["Pesos"][0][0])
    chk(d["Pesos"][0][1:6] == [0.1863, 0.2868, 0.212, 0.1585, 0.1562],
        "familias = las cargadas a mano el 4-oct: " + str(d["Pesos"][0][1:6]))
    chk(d["Pesos"][0][6:9] == [0.372, 0.235, 0.9961], "umbral, emisión y z: " + str(d["Pesos"][0][6:9]))
    chk(d["Tesis"][0][1:10] == [340, 5.3, 0.517, 0.505, -1.2, "no", 179582, 65, 2511],
        "tesis = la cargada a mano: " + str(d["Tesis"][0][1:10]))
    chk(d["Redes"][0][1:13] == [0.8886, 0.9217, 0.7717, 0.9157, 91342, 86092, 19100, 18058, 12092, 11447,
                                32036, 30462], "redes = las cargadas a mano")
    chk(d["Recursos"][0][1:9] == [0.56, 0.28, 0.36, 2633, 1049, 1198, None, 24.8],
        "recursos = los cargados a mano (chatbot fuera del top 5 → vacío): " + str(d["Recursos"][0][1:9]))
    c = d["Corte"][0]
    chk(c[1:8] == [0.031, 0.061, 9, 0.14, "no", "ranking", None],
        "corte: rank IC del json, y % BUY vacío con el mercado cerrado: " + str(c[1:8]))
    chk(c[8:15] == [1200, 8000, None, None, 306500, 1732, 481],
        "corte: repaso class23, class24 sin línea → vacío, cola, swap y swap en caché: " + str(c[8:15]))
    sin_extra = leer(texto)
    chk("Corte" not in sin_extra, "un chequeo a mano, sin los extras, no inventa una fila de Corte")
    abierto = texto.replace("mercado NYSE: CERRADO", "mercado NYSE: ABIERTO").replace(
        "señales={'HOLD': 14, 'BUY': 3}", "señales={'HOLD': 100, 'BUY': 30, 'SELL': 10}") + texto_extra[len(texto):]
    chk(leer(abierto)["Corte"][0][7] == 0.75, "en rueda, % BUY de la muestra: 30 de 40 = 75 %")
    cet = texto.replace("21:37:19 CEST", "20:37:19 CET")
    chk(leer(cet)["Pesos"][0][0] == "2026-10-04 16:37", "después del 25-oct el server dice CET: misma hora ART")
    print(f"\n   {ok} de {total}")
    return 0 if ok == total else 1


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__ or "uso: leer_chequeo.py [--cargar|--probar] archivo.txt ...")
        return 1
    if args[0] == "--probar":
        return probar()
    if args[0] == "--cargar":
        return cargar(args[1:])
    print(json.dumps(juntar(args), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
