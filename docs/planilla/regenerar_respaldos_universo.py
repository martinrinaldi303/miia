"""Regenera las copias de respaldo del universo en los dos loaders.

scripts/universo.js y MIIA/universo.py traen cada uno una copia EN CODIGO de
config/universo.json, para que el sistema arranque igual si el archivo falta o
esta roto. sim10_universo.js verifica que las tres coincidan.

Copiarlas a mano es exactamente el drift que ese test vigila (el 21-sep se
encontro que class25B tenia SPY y QQQ pero NO XLRE). Este script las genera
del JSON, asi que no pueden separarse.

    python docs/planilla/regenerar_respaldos_universo.py
"""
import json
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
JSON = RAIZ / "operador" / "aprendizaje" / "config" / "universo.json"
JS = RAIZ / "scripts" / "universo.js"
PY = RAIZ / "MIIA" / "universo.py"

# Las listas largas se cortan a este ancho para que el diff sea legible.
ANCHO = 92


def _lista(tickers: list[str], sangria: str, comillas: str) -> str:
    """Una lista de tickers repartida en varias lineas."""
    lineas, actual = [], sangria
    for i, t in enumerate(tickers):
        pieza = f"{comillas}{t}{comillas}" + ("," if i < len(tickers) - 1 else "")
        if len(actual) + len(pieza) + 1 > ANCHO and actual.strip():
            lineas.append(actual.rstrip())
            actual = sangria
        actual += pieza + " "
    if actual.strip():
        lineas.append(actual.rstrip())
    return "\n".join(lineas)


def bloque_js(d: dict) -> str:
    anchos = max(len(i["ticker"]) for i in d["instrumentos"]) + 2
    anchos_s = max(len(i.get("sector") or "") for i in d["instrumentos"]) + 3
    filas = []
    for i in d["instrumentos"]:
        tk = f'"{i["ticker"]}",'.ljust(anchos + 2)
        se = f'"{i.get("sector","")}",'.ljust(anchos_s + 2)
        filas.append(f'    {{ ticker: {tk} sector: {se} region: "{i.get("region","")}" }},')
    return (
        "const RESPALDO = {\n"
        f"  polling_segundos: {d['polling_segundos']},\n"
        f"  llamadas_por_minuto: {d['llamadas_por_minuto']},\n"
        "  instrumentos: [\n"
        + "\n".join(filas) + "\n"
        "  ],\n"
        f"  reconocidos_en_texto: [{', '.join(chr(34)+t+chr(34) for t in d['reconocidos_en_texto'])}],\n"
        "  noticias: [\n" + _lista(d["noticias"], "    ", '"') + "\n  ],\n"
        "  lstm: [\n" + _lista(d["lstm"], "    ", '"') + "\n  ],\n"
        "};"
    )


def bloque_py(d: dict) -> str:
    anchos = max(len(i["ticker"]) for i in d["instrumentos"]) + 3
    anchos_s = max(len(i.get("sector") or "") for i in d["instrumentos"]) + 4
    filas = []
    for i in d["instrumentos"]:
        tk = f'"{i["ticker"]}",'.ljust(anchos)
        se = f'"{i.get("sector","")}",'.ljust(anchos_s)
        filas.append(f'        {{"ticker": {tk} "sector": {se} "region": "{i.get("region","")}"}},')
    return (
        "_RESPALDO = {\n"
        f'    "polling_segundos": {d["polling_segundos"]},\n'
        f'    "llamadas_por_minuto": {d["llamadas_por_minuto"]},\n'
        '    "instrumentos": [\n'
        + "\n".join(filas) + "\n"
        "    ],\n"
        f'    "reconocidos_en_texto": [{", ".join(chr(34)+t+chr(34) for t in d["reconocidos_en_texto"])}],\n'
        '    "noticias": [\n' + _lista(d["noticias"], "        ", '"') + "\n    ],\n"
        '    "lstm": [\n' + _lista(d["lstm"], "        ", '"') + "\n    ],\n"
        "}"
    )


def reemplazar(ruta: Path, patron: str, nuevo: str) -> None:
    texto = ruta.read_text(encoding="utf-8")
    nuevo_texto, n = re.subn(patron, lambda _: nuevo, texto, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f"{ruta.name}: no se encontro el bloque de respaldo")
    ruta.write_text(nuevo_texto, encoding="utf-8", newline="")
    print(f"  {ruta.name}: respaldo regenerado")


def main() -> None:
    d = json.loads(JSON.read_text(encoding="utf-8"))
    print(f"universo.json: {len(d['instrumentos'])} instrumentos, "
          f"{len(d['noticias'])} con noticias, {len(d['lstm'])} con LSTM")
    reemplazar(JS, r"const RESPALDO = \{.*?\n\};", bloque_js(d))
    reemplazar(PY, r"_RESPALDO = \{.*?\n\}\n", bloque_py(d) + "\n")


if __name__ == "__main__":
    main()
