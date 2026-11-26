"""¿class23 y class24 votan lo mismo? — sólo lee una captura de class25a_output.

La captura la hace /root/captura_votos.sh en el server (cron del 27-nov, 3 muestras
de 15 min en rueda). Bajarla y analizarla, en Git Bash:

    scp -r miia:/root/votos ./votos && cat votos/*.txt > votos.txt
    python -X utf8 docs/planilla/votos_redes.py votos.txt

Qué mide. class25a_output trae en `scores` el score crudo de cada red para el
instrumento. Dentro de un ciclo (los 50 instrumentos de un barrido de class7),
la correlación de Spearman entre las columnas de dos redes dice si ORDENAN a los
instrumentos igual. Spearman no depende de la escala, así que el crudo da lo
mismo que el z que usa el ranking.

    rho > 0,7   votan casi lo mismo: separarles los datos tiene sentido
    rho < 0,3   ya opinan distinto: no hace falta tocarlas
"""
import json
import statistics
import sys
from itertools import combinations

REDES = ["class21/mercado", "class22/mercado", "class23/mercado", "class24/mercado", "class44"]
CICLO_S = 60       # mensajes separados por más de esto pertenecen a ciclos distintos
MIN_INSTR = 10     # un ciclo con menos instrumentos no se usa


def rangos(xs):
    orden = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(orden):
        j = i
        while j + 1 < len(orden) and xs[orden[j + 1]] == xs[orden[i]]:
            j += 1
        for k in range(i, j + 1):
            r[orden[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(a, b):
    ra, rb = rangos(a), rangos(b)
    ma, mb = statistics.fmean(ra), statistics.fmean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = (sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb)) ** 0.5
    return num / den if den else None


def leer(path):
    with open(path, "rb") as f:
        crudo = f.read()
    if crudo[:2] in (b"\xff\xfe", b"\xfe\xff"):
        sys.exit("El archivo está en UTF-16: se capturó desde PowerShell. Capturar desde Git Bash.")
    msgs = []
    for linea in crudo.decode("utf-8", errors="replace").splitlines():
        ts, _, carga = linea.partition("\t")
        if not carga.startswith("{"):
            continue
        try:
            d = json.loads(carga)
        except json.JSONDecodeError:
            continue
        t = str(d.get("ticker", "")).upper()
        if not t or t == "GENERAL" or not isinstance(d.get("scores"), dict):
            continue
        try:
            msgs.append((int(ts), t, d["scores"]))
        except ValueError:
            continue
    return msgs


def ciclos(msgs):
    """Corta en ciclos por silencio o cuando un instrumento se repite."""
    out, actual, ult = [], {}, None
    for ts, t, sc in msgs:
        if actual and (t in actual or ts - ult > CICLO_S):
            out.append(actual)
            actual = {}
        actual[t] = sc
        ult = ts
    if actual:
        out.append(actual)
    return [c for c in out if len(c) >= MIN_INSTR]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    msgs = leer(sys.argv[1])
    cs = ciclos(msgs)
    print(f"mensajes por instrumento: {len(msgs)}   ciclos usables: {len(cs)}")
    if not cs:
        print("Sin ciclos: ¿estaba la rueda abierta? Con el mercado cerrado todo es GENERAL.")
        return

    presentes = [r for r in REDES if any(r in sc for c in cs for sc in c.values())]
    print("redes presentes:", ", ".join(presentes))
    print()
    print(f"{'par':36} {'rho medio':>9} {'desvío':>7} {'ciclos':>6}")
    for a, b in combinations(presentes, 2):
        rs = []
        for c in cs:
            pares = [(sc[a], sc[b]) for sc in c.values() if a in sc and b in sc]
            if len(pares) >= MIN_INSTR:
                r = spearman([p[0] for p in pares], [p[1] for p in pares])
                if r is not None:
                    rs.append(r)
        if rs:
            de = statistics.pstdev(rs) if len(rs) > 1 else 0.0
            print(f"{a + ' vs ' + b:36} {statistics.fmean(rs):>+9.3f} {de:>7.3f} {len(rs):>6}")

    # Cuánto varía cada red entre instrumentos: una red casi constante no ordena nada.
    print()
    print(f"{'red':18} {'dispersión media entre instrumentos':>36}")
    for r in presentes:
        ds = [statistics.pstdev([sc[r] for sc in c.values() if r in sc])
              for c in cs if sum(r in sc for sc in c.values()) >= MIN_INSTR]
        if ds:
            print(f"{r:18} {statistics.fmean(ds):>36.4f}")


if __name__ == "__main__":
    main()
