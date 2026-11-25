#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sim34 — el relay de chat de miia_chatbot.py: foco por ticker y correlación.

    python docs/simulaciones/sim34_chat_contexto.py

Arregla en frío lo que destrababa el presupuesto del chat (15-oct-2026). Las
tres capturas de Martín del 15-oct mostraban respuestas genéricas/equivocadas;
una de las causas estaba del lado de Python:

  · el pipeline del activo BLOQUEABA 5,5 s antes de publicar, comiéndose el
    presupuesto de class25B/Ollama → timeout "MIIA está procesando";
  · se mandaban los 50 instrumentos enteros en cada mensaje y class25B sólo
    usaba el del ticker preguntado — el dato de XLK viajaba y se desperdiciaba;
  · /api/ask devolvía el PRIMER INFO de cualquiera, sin correlacionar.

La lógica pura vive en `MIIA/chat_contexto.py` (sin FastAPI/Redis) y esta prueba
la corre sin levantar el sistema, igual que sim30/sim31. La sección 4 son guardas
de regresión que LEEN `miia_chatbot.py` (no lo importan: arrastra FastAPI) y
verifican que el cableado siga enchufado.

Lo que esta prueba NO cubre, a propósito: la orquestación async del endpoint (que
el activo corra en paralelo de verdad) se verifica leyendo el código, no con un
unit test — necesitaría FastAPI y Redis arriba.
"""
import io
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "MIIA"))

from chat_contexto import tickers_en_texto, filtrar_por_ticker, clasificar_salida  # noqa: E402

# La consola de Windows arranca en cp1252 y un emoji tira UnicodeEncodeError EN
# EL PRINT: la prueba "falla" por el idioma de la terminal, no por el código.
# probar.ps1 pone la consola en UTF-8; a mano no, así que no se depende de eso.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_ok = 0
_falla = 0

# Universo de prueba (inyectado): no se depende de universo.json. DIA y SPY están
# a propósito, porque son los que chocan con palabras del español ("DÍA", "SPY").
UNIV = ("XLK", "XLF", "XLE", "XLV", "ARGT", "EWZ", "DIA", "SPY", "SMH", "QQQ")


def chequear(nombre, cond, nota=""):
    global _ok, _falla
    if cond:
        _ok += 1
        print("   [ok]    %-58s %s" % (nombre, nota))
    else:
        _falla += 1
        print("   [FALLA] %-58s %s" % (nombre, nota))


def seccion(t):
    print("\n%s" % t)


# ── 1 ───────────────────────────────────────────────────────────────────────
seccion("1 · tickers_en_texto — enfocar el contexto, sin inventar tickers")

chequear("'¿Qué significa la señal de XLK?' -> [XLK]",
         tickers_en_texto("¿Qué significa la señal de XLK?", UNIV) == ["XLK"],
         "la captura 3: XLK sí viaja")
chequear("'Qué es ARG?' -> []  (ARG no es ARGT)",
         tickers_en_texto("Qué es ARG?", UNIV) == [],
         "la captura 2: no se manda contexto equivocado")
chequear("'comprá ARGT y EWZ' -> [ARGT, EWZ] ordenado",
         tickers_en_texto("comprá ARGT y EWZ", UNIV) == ["ARGT", "EWZ"])
chequear("minúsculas: 'la señal de xlk' -> [XLK]",
         tickers_en_texto("la señal de xlk", UNIV) == ["XLK"])
chequear("'buen día' NO detecta DIA (acento) ",
         tickers_en_texto("buen día, ¿algo hoy?", UNIV) == [],
         "DÍA tiene Í, no I")
chequear("'MEDIA' NO detecta DIA (límite de palabra)",
         tickers_en_texto("hay MEDIA jornada", UNIV) == [],
         "DIA pegado a otra letra no cuenta")
chequear("'XLKING' NO detecta XLK",
         tickers_en_texto("pregunta sobre XLKING", UNIV) == [])
chequear("con puntuación pegada: '(XLK).' -> [XLK]",
         tickers_en_texto("mirá (XLK).", UNIV) == ["XLK"])
chequear("texto vacío -> []", tickers_en_texto("", UNIV) == [])
chequear("sin tickers -> []", tickers_en_texto("hola, ¿cómo va?", UNIV) == [])
chequear("universo vacío -> []", tickers_en_texto("señal de XLK", ()) == [])

# Integración contra el universo REAL (si universo.json carga): el caso exacto
# de la captura. Si no carga, no se penaliza —es una guarda extra, no el núcleo—.
try:
    from universo import TICKERS_TEXTO as _REAL  # noqa: E402
    chequear("universo real: ARGT está y 'ARG' NO lo dispara",
             "ARGT" in _REAL and tickers_en_texto("Qué es ARG?", _REAL) == [],
             "el caso real de la captura 2")
    chequear("universo real: 'señal de XLK' -> [XLK]",
             tickers_en_texto("¿Qué significa la señal de XLK?", _REAL) == ["XLK"])
except Exception as _e:
    print("   [s/d]   universo real no cargó (%s) — se omiten 2 checks" % _e)


# ── 2 ───────────────────────────────────────────────────────────────────────
seccion("2 · filtrar_por_ticker — acotar el payload")

MAPA = {"XLK": {"s": "BUY"}, "EWZ": {"s": "SELL"}, "DIA": {"s": "HOLD"}}

chequear("con [XLK] -> sólo XLK",
         filtrar_por_ticker(MAPA, ["XLK"]) == {"XLK": {"s": "BUY"}})
chequear("case-insensitive: ['xlk'] -> XLK",
         list(filtrar_por_ticker(MAPA, ["xlk"]).keys()) == ["XLK"])
chequear("ticker que no está en el mapa -> {}",
         filtrar_por_ticker(MAPA, ["AAPL"]) == {})
chequear("sin tickers, tope=2 -> 2 entradas",
         len(filtrar_por_ticker(MAPA, [], tope=2)) == 2,
         "el chat general no manda los 50")
chequear("sin tickers, tope=None -> mapa entero",
         len(filtrar_por_ticker(MAPA, [], tope=None)) == 3)
chequear("mapa vacío -> {}", filtrar_por_ticker({}, ["XLK"]) == {})
chequear("mapa None -> {}", filtrar_por_ticker(None, ["XLK"]) == {})
chequear("preserva el valor por identidad (no copia)",
         filtrar_por_ticker(MAPA, ["XLK"])["XLK"] is MAPA["XLK"])


# ── 3 ───────────────────────────────────────────────────────────────────────
seccion("3 · clasificar_salida — devolver la respuesta a QUIEN preguntó")


def c(data, user_id="", sesion=""):
    return clasificar_salida(data, user_id=user_id, sesion=sesion)


DEC = {"source": "class25B", "senal": "BUY", "texto": "XLK sube"}
chequear("decisión de mercado (senal=BUY) -> ignorar", c(DEC) == "ignorar",
         "no es chat; /api/ask sigue esperando")
chequear("otra fuente -> ignorar",
         c({"source": "class44", "senal": "INFO", "texto": "x"}) == "ignorar")
chequear("respuesta sin texto -> ignorar",
         c({"source": "class25B", "senal": "INFO", "texto": ""}) == "ignorar")
chequear("no es dict -> ignorar", c("nope") == "ignorar")

MIA_S = {"source": "class25B", "senal": "INFO", "texto": "hola",
         "session_id": "s1", "user_id": "anonimo"}
chequear("chat con MI sesión -> mia", c(MIA_S, sesion="s1") == "mia")
chequear("chat con OTRA sesión -> ajena",
         c({**MIA_S, "session_id": "s2"}, sesion="s1") == "ajena",
         "antes se devolvía la respuesta del otro usuario")

MIA_U = {"source": "class25B", "senal": "INFO", "texto": "x", "user_id": "u42"}
chequear("chat con MI user (no anónimo, sin sesión) -> mia",
         c(MIA_U, user_id="u42") == "mia")
chequear("chat con OTRO user -> ajena",
         c({**MIA_U, "user_id": "u99"}, user_id="u42") == "ajena")

chequear("anónimo + sin sesión -> mia (fallback, no cuelga)",
         c({"source": "class25B", "senal": "INFO", "texto": "x",
            "user_id": "anonimo"}, user_id="anonimo", sesion="") == "mia",
         "sin correlador se acepta, como antes")
chequear("tengo sesión pero la respuesta no la trae + anónimo -> mia (no cuelga)",
         c({"source": "class25B", "senal": "INFO", "texto": "x",
            "user_id": "anonimo"}, user_id="anonimo", sesion="s1") == "mia")
chequear("senal '' (vacía) también es chat -> mia",
         c({"source": "class25B", "senal": "", "texto": "x",
            "session_id": "s1"}, sesion="s1") == "mia")
chequear("usa el campo 'decision' si no hay 'texto'",
         c({"source": "class25B", "senal": "INFO", "decision": "x",
            "session_id": "s1"}, sesion="s1") == "mia")


# ── 4 ───────────────────────────────────────────────────────────────────────
seccion("4 · Guardas de regresión sobre miia_chatbot.py (se lee, no se importa)")

src = io.open(RAIZ / "MIIA" / "miia_chatbot.py", encoding="utf-8").read()

chequear("importa chat_contexto",
         "from chat_contexto import tickers_en_texto, filtrar_por_ticker, clasificar_salida" in src)
chequear("el import es DEFENSIVO (no cae como el 28-sep)",
         "except Exception as _e_cc:" in src and "def clasificar_salida(data" in src,
         "archivo nuevo: si no se sube, degrada, no tumba la API")
chequear("CHAT_TIMEOUT_S como variable de entorno",
         'os.environ.get("CHAT_TIMEOUT_S"' in src)
chequear("el pipeline del activo corre en PARALELO (create_task)",
         "asyncio.create_task(\n                _orquestar_analisis_activo(" in src)
chequear("ya NO se await-ea el activo en línea antes de publicar",
         "await _orquestar_analisis_activo(" not in src,
         "ese await serial era el que comía 5,5 s del presupuesto")
chequear("existe el reversa CHAT_ACTIVO_BLOQUEA",
         'os.environ.get("CHAT_ACTIVO_BLOQUEA"' in src)
chequear("publica session_id para poder correlacionar",
         '"sesion": sesion, "session_id": sesion,' in src)
chequear("acota lstm_context por ticker",
         'filtrar_por_ticker(estado.get("lstm_señales", {}), _tks)' in src)
chequear("acota sentimiento_context por ticker",
         'filtrar_por_ticker(estado.get("sentimiento", {}), _tks)' in src)
chequear("el bucle de espera correlaciona la respuesta",
         "clasificar_salida(data, user_id=user_id, sesion=sesion)" in src
         and 'if clase != "mia":' in src)
chequear("define y usa _resolver_activo",
         "async def _resolver_activo(" in src and "await _resolver_activo(" in src)
chequear("el finally cancela la task del activo si quedó colgada",
         "orq_task.cancel()" in src)


print("\n%s" % ("PASA" if _falla == 0 else "FALLA"),
      "— relay de chat (chat_contexto)  (%d checks, %d fallas)" % (_ok + _falla, _falla))
sys.exit(1 if _falla else 0)
