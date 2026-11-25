"""sim12_rendimiento_api.py — por qué /api/backtesting/professional tardaba 14 s.

QUÉ MIDE. Cuántas filas tiene que tocar cada consulta del endpoint, contadas
sobre el volcado real. No es una estimación: se recorre `cognitive_decisions`
y se cuenta cuántas filas pasan cada filtro.

QUÉ GUARDA. Además de medir, revisa el código y falla si vuelve alguno de los
tres patrones que ya costaron caro:

  1. `COALESCE(columna, ...)` en un WHERE — anula cualquier índice. Es el mismo
     error que el propio archivo documenta para `label_modo` y que igual quedó
     en cinco consultas sobre `temperatura`.
  2. Una consulta a `precios` sin cota temporal. Así se llegó a los 13,5 s de
     `/api/portfolio` del 21-sep: traía 1,18 M de filas en cada visita.
  3. Que se pierda el stale-while-revalidate del endpoint lento.

    python docs/simulaciones/sim12_rendimiento_api.py            # rápido
    python docs/simulaciones/sim12_rendimiento_api.py --medir    # re-mide el volcado

La medición tarda varios minutos (el volcado son 1,49 GB), así que queda
guardada en datos/costo_consultas.json y por defecto se lee de ahí.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent.parent
GUARDADO = AQUI / "datos" / "costo_consultas.json"
VOLCADO = RAIZ / "MIIA_backup_2026-09-15-00-29-30.sql"

fallos = 0


def chequear(que: str, ok: bool, detalle: str = "") -> None:
    global fallos
    print(f"   {'[ok]' if ok else '[NO]'} {que:<54} {detalle}")
    if not ok:
        fallos += 1


# ════════════════════════════════════════════════════════════════════
# 1 · La medición sobre el volcado
# ════════════════════════════════════════════════════════════════════
CAMPO = re.compile(rb"'((?:[^'\\]|\\.|'')*)'|NULL|([^,)]+)")


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


def medir() -> dict:
    """Recorre el volcado y cuenta lo que cada consulta tiene que leer."""
    if not VOLCADO.exists():
        raise SystemExit(f"no está el volcado: {VOLCADO}")

    cab = VOLCADO.open("rb").read(3_000_000)
    m = re.search(rb"CREATE TABLE `cognitive_decisions` \((.*?)\n\) ENGINE", cab, re.S)
    if not m:
        raise SystemExit("no se encontró el CREATE TABLE de cognitive_decisions")
    cols = [c.decode() for c in re.findall(rb"^\s+`([a-z_]+)`", m.group(1), re.M)]
    idx = {c: i for i, c in enumerate(cols)}

    PREF = b"INSERT INTO `cognitive_decisions` VALUES "
    tot = shadow = verif_dir = con_retorno = 0
    por_modo: Counter = Counter()
    dias: set = set()

    for ln in VOLCADO.open("rb"):
        if not ln.startswith(PREF):
            continue
        for t in ln[len(PREF):].rstrip(b";\r\n").split(b"),("):
            c = _campos(t.lstrip(b"(").rstrip(b")"))
            if len(c) < len(cols):
                continue
            tot += 1
            if c[idx["temperatura"]] == "shadow":
                shadow += 1
                continue
            if (c[idx["outcome_real"]] in ("correcto", "incorrecto")
                    and c[idx["senal"]] in ("BUY", "SELL")):
                verif_dir += 1
                por_modo[c[idx["label_modo"]]] += 1
                tso, rr = c[idx["ts_outcome"]], c[idx["retorno_real"]]
                if tso and rr not in (None, "NULL"):
                    con_retorno += 1
                    dias.add(tso[:10])

    return {
        "_origen": "MIIA_backup_2026-09-15-00-29-30.sql",
        "_generado_por": "docs/simulaciones/sim12_rendimiento_api.py --medir",
        "filas": tot, "shadow": shadow, "verificadas_direccionales": verif_dir,
        "con_retorno_y_ts": con_retorno, "dias_distintos": len(dias),
        "por_label_modo": {str(k): v for k, v in por_modo.items()},
        "consultas_por_request": 4,
    }


# ════════════════════════════════════════════════════════════════════
def main() -> int:
    print("\n=== Costo de /api/backtesting/professional =====================\n")

    if "--medir" in sys.argv or not GUARDADO.exists():
        print("   midiendo sobre el volcado (tarda unos minutos)…")
        datos = medir()
        GUARDADO.parent.mkdir(parents=True, exist_ok=True)
        GUARDADO.write_text(json.dumps(datos, indent=1), encoding="utf8")
        print(f"   guardado en {GUARDADO.relative_to(RAIZ)}\n")
    else:
        datos = json.loads(GUARDADO.read_text(encoding="utf8"))

    n = datos["filas"]
    leidas = n * datos["consultas_por_request"]
    devueltas = 4 + 1 + 1 + datos["dias_distintos"]

    print("1 · Lo que cuesta una sola visita")
    print(f"      filas en cognitive_decisions   {n:>10,}")
    print(f"        shadow (se descartan)        {datos['shadow']:>10,}")
    print(f"        verificadas direccionales    {datos['verificadas_direccionales']:>10,}"
          f"   ({100*datos['verificadas_direccionales']/n:.1f} %)")
    print(f"        con retorno y ts_outcome     {datos['con_retorno_y_ts']:>10,}")
    print(f"      días distintos del GROUP BY    {datos['dias_distintos']:>10}")
    print(f"      por label_modo                 {datos['por_label_modo']}")
    print()
    print(f"      **{leidas:,} filas leídas por request para devolver {devueltas}**")
    print(f"      ({datos['consultas_por_request']} barridas completas de la tabla)")

    chequear("la tabla es lo bastante grande como para que importe", n > 100_000,
             f"{n:,} filas")
    chequear("el filtro NO es selectivo: hay que leer casi todo",
             datos["verificadas_direccionales"] / n > 0.25,
             f"{100*datos['verificadas_direccionales']/n:.0f} % pasa el filtro")

    # ── 2 · Guardas contra la regresión ─────────────────────────────
    print("\n2 · Que no vuelvan los patrones que ya costaron caro")
    src = (RAIZ / "MIIA" / "miia_chatbot.py").read_text(encoding="utf8")

    coalesce_where = re.findall(r"(?:WHERE|AND)\s+COALESCE\s*\(\s*\w+\s*,[^)]*\)\s*(?:<>|=|!=)",
                                src, re.I)
    chequear("ningún COALESCE(columna,…) en un WHERE", not coalesce_where,
             f"{len(coalesce_where)} encontrados" if coalesce_where else "anula los índices")

    # Cada bloque SQL que toque `precios` tiene que acotar el tiempo.
    #
    # Se saltean los COMENTARIOS: varios describen la consulta vieja sin cota
    # —justamente para dejar constancia de por qué se arregló— y contarlos daría
    # un rojo permanente por documentar bien.
    sin_cota = []
    lineas = src.split("\n")
    for m in re.finditer(r"FROM\s+precios\b", src):
        nlinea = src[:m.start()].count("\n")
        if lineas[nlinea].lstrip().startswith("#"):
            continue
        ini = src.rfind("SELECT", max(0, m.start() - 1500), m.start())
        fin = src.find('"""', m.end())
        bloque = src[ini if ini > 0 else m.start(): fin if fin > 0 else m.end() + 600]
        if not re.search(r"INTERVAL|ts\s*>=|ts\s*>|LIMIT\s+\d", bloque, re.I):
            sin_cota.append(nlinea + 1)
    chequear("toda consulta a `precios` acota el tiempo", not sin_cota,
             f"líneas {sin_cota}" if sin_cota else "1,18 M de filas si no")

    chequear("el endpoint lento sirve lo viejo y refresca atrás",
             "_prof_refrescar" in src and "_PROF_CACHE_MAX" in src,
             "nadie espera los 14 s")
    chequear("una sola tarea de refresco en vuelo",
             "_prof_refrescando" in src, "sin esto, diez visitas = diez recálculos")

    # El TTL tiene que ser MENOR que el ciclo del dashboard para que el dato no
    # envejezca, pero eso sólo funciona con refresco atrás: sin él, 45 < 60
    # significaba que el dashboard fallaba la caché SIEMPRE.
    m_ttl = re.search(r"_PROF_CACHE_TTL\s*=\s*(\d+)", src)
    chequear("el TTL sigue por debajo del ciclo de 60 s del dashboard",
             bool(m_ttl) and int(m_ttl.group(1)) < 60,
             f"TTL={m_ttl.group(1)} s" if m_ttl else "no se encontró")

    # ── 3 · Los índices que faltan ──────────────────────────────────
    print("\n3 · Los índices, para el 12-oct")
    mig = RAIZ / "docs" / "migracion_indices_12oct.sql"
    chequear("está escrita la migración", mig.exists(),
             mig.name if mig.exists() else "falta")
    if mig.exists():
        sql = mig.read_text(encoding="utf8")
        for nombre in ("idx_medicion", "idx_curva_diaria", "idx_ventana_ticker"):
            chequear(f"  {nombre}", nombre in sql)

    esquema = (RAIZ / "docs" / "esquema_miia_cognitiva.sql").read_text(encoding="utf8")
    ya = [i for i in ("idx_medicion", "idx_curva_diaria", "idx_ventana_ticker")
          if i in esquema]
    chequear("todavía NO están en la base (se aplican el 12-oct)", not ya,
             f"ya existen: {ya}" if ya else "pendiente, como corresponde")

    print(f"\n{'PASA' if fallos == 0 else 'FALLA'} — rendimiento de la API\n")
    return 0 if fallos == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
