"""universo.py — la lista de instrumentos, en UN solo lugar (lado Python).

Espejo exacto de ``scripts/universo.js``. Ver el comentario de ese archivo para
el porqué: la lista estaba copiada a mano en más de diez lugares y había
drifteado (class25B tenía SPY y QQQ pero no XLRE, que sí se cotiza y sí se
mide). Con la ampliación de 13 a 100 del 12-oct, eso vuelve los números
irreconciliables.

Si ``config/universo.json`` falta o está roto, devuelve la copia de respaldo de
abajo y lo avisa: ningún proceso se queda sin universo por un JSON mal editado.

    from universo import TICKERS, TICKERS_TEXTO
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_AQUI = Path(__file__).resolve().parent
_RUTA = Path(os.environ.get(
    "MIIA_UNIVERSO_JSON",
    _AQUI.parent / "operador" / "aprendizaje" / "config" / "universo.json"))

# Tiene que ser IDÉNTICA al JSON. `sim10_universo.js` lo verifica: si alguien
# edita uno y se olvida del otro, el test se pone en rojo.
_RESPALDO = {
    "polling_segundos": 90,
    "llamadas_por_minuto": 54,
    "instrumentos": [
        {"ticker": "XLK",  "sector": "Technology",              "region": "US"},
        {"ticker": "XLF",  "sector": "Financials",              "region": "US"},
        {"ticker": "XLE",  "sector": "Energy",                  "region": "US"},
        {"ticker": "XLV",  "sector": "Healthcare",              "region": "US"},
        {"ticker": "XLY",  "sector": "Consumer Discretionary",  "region": "US"},
        {"ticker": "XLI",  "sector": "Industrials",             "region": "US"},
        {"ticker": "XLB",  "sector": "Materials",               "region": "US"},
        {"ticker": "XLRE", "sector": "Real Estate",             "region": "US"},
        {"ticker": "XLU",  "sector": "Utilities",               "region": "US"},
        {"ticker": "XLC",  "sector": "Communication Services",  "region": "US"},
        {"ticker": "XLP",  "sector": "Consumer Staples",        "region": "US"},
        {"ticker": "SPY",  "sector": "US Large Cap",            "region": "US"},
        {"ticker": "QQQ",  "sector": "US Nasdaq 100",           "region": "US"},
        {"ticker": "IWM",  "sector": "US Small Cap",            "region": "US"},
        {"ticker": "DIA",  "sector": "US Dow 30",               "region": "US"},
        {"ticker": "EFA",  "sector": "Developed ex-US",         "region": "GLOBAL"},
        {"ticker": "EEM",  "sector": "Emerging Markets",        "region": "GLOBAL"},
        {"ticker": "EWJ",  "sector": "Japan",                   "region": "APAC"},
        {"ticker": "EWG",  "sector": "Germany",                 "region": "EUROPE"},
        {"ticker": "EWU",  "sector": "United Kingdom",          "region": "EUROPE"},
        {"ticker": "EWL",  "sector": "Switzerland",             "region": "EUROPE"},
        {"ticker": "EWY",  "sector": "South Korea",             "region": "APAC"},
        {"ticker": "EWT",  "sector": "Taiwan",                  "region": "APAC"},
        {"ticker": "EWH",  "sector": "Hong Kong",               "region": "APAC"},
        {"ticker": "EWA",  "sector": "Australia",               "region": "APAC"},
        {"ticker": "INDA", "sector": "India",                   "region": "APAC"},
        {"ticker": "FXI",  "sector": "China Large Cap",         "region": "APAC"},
        {"ticker": "EWC",  "sector": "Canada",                  "region": "US"},
        {"ticker": "EWW",  "sector": "Mexico",                  "region": "LATAM"},
        {"ticker": "ARGT", "sector": "MERVAL",                  "region": "LATAM"},
        {"ticker": "EWZ",  "sector": "Brazil",                  "region": "LATAM"},
        {"ticker": "ILF",  "sector": "Latin America",           "region": "LATAM"},
        {"ticker": "SMH",  "sector": "Semiconductors",          "region": "US"},
        {"ticker": "XBI",  "sector": "Biotech",                 "region": "US"},
        {"ticker": "VNQ",  "sector": "REITs",                   "region": "US"},
        {"ticker": "XOP",  "sector": "Oil and Gas E&P",         "region": "US"},
        {"ticker": "KRE",  "sector": "Regional Banks",          "region": "US"},
        {"ticker": "ITB",  "sector": "Homebuilders",            "region": "US"},
        {"ticker": "JETS", "sector": "Airlines",                "region": "US"},
        {"ticker": "IYT",  "sector": "Transportation",          "region": "US"},
        {"ticker": "XME",  "sector": "Metals and Mining",       "region": "US"},
        {"ticker": "GDX",  "sector": "Gold Miners",             "region": "US"},
        {"ticker": "XRT",  "sector": "Retail",                  "region": "US"},
        {"ticker": "ARKK", "sector": "Disruptive Innovation",   "region": "US"},
        {"ticker": "MTUM", "sector": "Factor Momentum",         "region": "US"},
        {"ticker": "QUAL", "sector": "Factor Quality",          "region": "US"},
        {"ticker": "VTV",  "sector": "Factor Value",            "region": "US"},
        {"ticker": "VUG",  "sector": "Factor Growth",           "region": "US"},
        {"ticker": "USMV", "sector": "Factor Min Volatility",   "region": "US"},
        {"ticker": "IWF",  "sector": "Factor Large Growth",     "region": "US"},
    ],
    "reconocidos_en_texto": ["BTC", "ETH", "VOO", "VTI", "IVV", "GLD", "SLV", "TLT", "AGG", "USO"],
    "noticias": [
        "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLB", "XLRE", "XLU", "XLC", "XLP",
        "SPY", "QQQ", "IWM", "DIA", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWL", "EWY", "EWT",
        "EWH", "EWA", "INDA", "FXI", "EWC", "EWW", "ARGT", "EWZ", "ILF", "SMH", "XBI",
        "VNQ", "XOP", "KRE", "ITB", "JETS", "IYT", "XME", "GDX", "XRT", "ARKK", "MTUM",
        "QUAL", "VTV", "VUG", "USMV", "IWF"
    ],
    "lstm": [
        "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLB", "XLRE", "XLU", "XLC", "XLP",
        "SPY", "QQQ", "IWM", "DIA", "EFA", "EEM", "EWJ", "EWG", "EWU", "EWL", "EWY", "EWT",
        "EWH", "EWA", "INDA", "FXI", "EWC", "EWW", "ARGT", "EWZ", "ILF", "SMH", "XBI",
        "VNQ", "XOP", "KRE", "ITB", "JETS", "IYT", "XME", "GDX", "XRT", "ARKK", "MTUM",
        "QUAL", "VTV", "VUG", "USMV", "IWF"
    ],
}


def _cargar():
    try:
        with open(_RUTA, encoding="utf8") as f:
            datos = json.load(f)
        instr = datos.get("instrumentos")
        if not isinstance(instr, list) or not instr:
            raise ValueError("`instrumentos` vacío o no es una lista")
        for i in instr:
            if not isinstance(i, dict) or not str(i.get("ticker", "")).strip():
                raise ValueError("hay un instrumento sin `ticker`")
        return datos, str(_RUTA)
    except Exception as e:                      # noqa: BLE001 — se quiere atrapar todo
        # print y no logging: esto se importa antes de que el proceso arme su
        # logger, y quedarse sin universo seria peor que arrancar con el respaldo.
        print(f"[universo] {_RUTA}: {e} — se usa la copia de respaldo "
              f"({len(_RESPALDO['instrumentos'])} instrumentos)")
        return _RESPALDO, "respaldo interno"


_DATOS, ORIGEN = _cargar()

#: Los instrumentos que se cotizan y se miden, en el orden del archivo.
TICKERS: tuple[str, ...] = tuple(i["ticker"] for i in _DATOS["instrumentos"])

#: ticker -> {"sector": ..., "region": ...}
INSTRUMENTOS: dict[str, dict] = {
    i["ticker"]: {"sector": i.get("sector"), "region": i.get("region")}
    for i in _DATOS["instrumentos"]
}

#: Los que se reconocen al PARSEAR TEXTO: los medibles más SPY/QQQ/BTC/ETH.
#: NO usar para medir ni para pedir precios — esa es justo la distinción que se
#: había perdido (_TICKERS_SISTEMA tenía 15 porque alguien sumó SPY y QQQ ahí).
TICKERS_TEXTO: frozenset[str] = frozenset(
    TICKERS + tuple(_DATOS.get("reconocidos_en_texto", ())))

#: Subconjunto que se consulta a los proveedores de noticias (cuotas).
TICKERS_NOTICIAS: tuple[str, ...] = tuple(_DATOS.get("noticias") or TICKERS)

#: Subconjunto que modela class44 (LSTM). Es MAS CHICO que el universo a
#: proposito: class44 arma un modelo por ticker y es el segundo proceso mas
#: caro del server. Ver el comentario `_lstm` en universo.json.
TICKERS_LSTM: tuple[str, ...] = tuple(_DATOS.get("lstm") or TICKERS)

POLLING_SEGUNDOS: int = int(_DATOS.get("polling_segundos") or 60)


def resumen_universo() -> str:
    """Una línea para el log de arranque."""
    return (f"{len(TICKERS)} instrumentos ({','.join(TICKERS[:4])}…) desde "
            f"{'RESPALDO' if ORIGEN == 'respaldo interno' else 'universo.json'}")
