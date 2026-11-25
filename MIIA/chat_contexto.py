# -*- coding: utf-8 -*-
"""
chat_contexto.py — lógica pura del relay de chat de `miia_chatbot.py`.

Vive aparte por el mismo motivo que `rank_ic.py`, `rotacion.py` y `marcador.py`:
importar `miia_chatbot` arrastra FastAPI, aioredis y aiomysql, así que la lógica
metida ahí adentro NO se puede probar. Acá no hay nada que importar más que `re`,
así que `sim34` la corre sin levantar el sistema.

Este módulo NO decide nada, NO habla con nadie y NO tiene estado: sólo transforma
datos. El único que orquesta es el endpoint `/api/ask` (ver `miia_chatbot.py`).

Tres funciones, cada una ataca un pedazo del fallo del chat:

  • tickers_en_texto   → enfocar el contexto por ticker en vez de mandar los 50
  • filtrar_por_ticker → acotar `lstm_context`/`sentimiento_context` del payload
  • clasificar_salida  → correlacionar la respuesta con ESTA consulta
                         (antes `/api/ask` devolvía el PRIMER INFO de cualquiera)
"""
import re

# user_id que NO distinguen a un usuario concreto: con cualquiera de estos no se
# puede correlacionar por usuario y hay que caer al comportamiento viejo.
_ANON = frozenset({"", "anonimo", "anónimo", "anon", "default", "usuario", "none", "null"})


def tickers_en_texto(texto, universo):
    """Tickers del `universo` mencionados en `texto`, en MAYÚSCULAS y sin repetir.

    Usa límite de palabra MANUAL (el ticker no pegado a otra letra o dígito), a
    propósito más estricto que el `includes()` de class25B: así "DÍA"→DIA,
    "MEDIA"→DIA, "ARGENTINA"→ARGT y "SPYWARE"→SPY NO se confunden con un ticker.
    El acento ya ayuda (DÍA tiene Í, no I), pero el borde lo cubre siempre.
    """
    up = (texto or "").upper()
    if not up:
        return []
    out = []
    for t in (universo or ()):
        tu = str(t).upper().strip()
        if not tu:
            continue
        if re.search(rf"(?<![A-Z0-9]){re.escape(tu)}(?![A-Z0-9])", up):
            out.append(tu)
    # Orden estable (no el del set del universo, que es no determinista).
    return sorted(set(out))


def filtrar_por_ticker(mapa, tickers, tope=12):
    """Acota un mapa `{ticker: datos}` para que no viaje entero en cada mensaje.

    - Si hay `tickers` mencionados → sólo esas claves que existan en el mapa
      (para la pregunta "¿señal de XLK?" viaja XLK y nada más).
    - Si no hay ninguno → a lo sumo `tope` entradas (el chat general no necesita
      los 50; mandar los 50 es payload al pedo y prompt inflado).

    Preserva los valores tal cual; no copia en profundidad.
    """
    if not isinstance(mapa, dict) or not mapa:
        return {}
    if tickers:
        tset = {str(t).upper() for t in tickers}
        return {k: v for k, v in mapa.items() if str(k).upper() in tset}
    if tope is None or tope < 0:
        return dict(mapa)
    return dict(list(mapa.items())[:tope])


def clasificar_salida(data, *, user_id="", sesion=""):
    """¿Qué es este mensaje de `class25_output` respecto de ESTA consulta?

    Devuelve:
      "ignorar" → no es una respuesta de chat (decisión de mercado BUY/SELL/HOLD,
                  heartbeat, otra fuente): `/api/ask` debe seguir esperando.
      "mia"     → es la respuesta a esta consulta, O no hay con qué distinguir
                  (anónimo + sin sesión): se acepta para no colgar el chat.
      "ajena"   → es una respuesta de chat de OTRA sesión/usuario: NO devolverla.

    Correlación: class25B hace eco de `msg.session_id` y `msg.user_id` en
    `_publicarRespuesta`. `/api/ask` ahora manda `session_id` (= la sesión del
    front), así que vuelve y se puede emparejar. El `user_id` sirve de respaldo
    cuando no es anónimo. Sin ninguno de los dos, se acepta (como hacía antes).

    ⚠️ Para dos anónimos concurrentes SIN sesión no hay forma de distinguir sin
    que class25B devuelva el `msg_id` de la consulta (hoy genera uno nuevo). Eso
    es un arreglo de class25B, no de acá; mientras tanto se cae al comportamiento
    viejo (aceptar el primero), que es lo que ya pasaba.
    """
    if not isinstance(data, dict):
        return "ignorar"
    if data.get("source") != "class25B":
        return "ignorar"
    senal = data.get("senal", "")
    texto = data.get("texto") or data.get("decision") or ""
    if senal not in ("INFO", "") or not texto:
        return "ignorar"

    r_sid = str(data.get("session_id") or "").strip()
    r_uid = str(data.get("user_id") or "").strip()
    q_sid = str(sesion or "").strip()
    q_uid = str(user_id or "").strip()

    # 1) Correlación por sesión (la más fiable cuando el front manda una).
    if q_sid and r_sid:
        return "mia" if r_sid == q_sid else "ajena"
    # 2) Respaldo por usuario, sólo si identifica a alguien.
    if q_uid and q_uid.lower() not in _ANON and r_uid:
        return "mia" if r_uid == q_uid else "ajena"
    # 3) Sin correlador utilizable → aceptar (comportamiento viejo, no cuelga).
    return "mia"


def portfolio_del_navegador(raw, max_activos=12):
    """El portafolio que la web guarda por usuario (localStorage) y manda con cada
    pregunta del chat. Viene del navegador, o sea que se valida y se recorta: sólo
    símbolos, pesos, perfil, monto y fecha. Devuelve None si no hay nada usable.

    Existe desde el 4-nov-2026: sin esto class25B no sabía qué portafolio le
    había armado al usuario y contestaba «¿cuál es tu tolerancia al riesgo?».
    """
    if not isinstance(raw, dict):
        return None
    activos, vistos = [], set()
    for a in (raw.get("activos") or [])[:max_activos]:
        if not isinstance(a, dict):
            continue
        sym = "".join(c for c in str(a.get("symbol") or a.get("ticker") or "").upper()
                      if c.isalnum() or c in ".-")[:10]
        try:
            peso = float(a.get("peso_pct", a.get("peso")))
        except (TypeError, ValueError):
            continue
        if not sym or sym in vistos or not (0 < peso <= 100):
            continue
        vistos.add(sym)
        sector = a.get("sector")
        activos.append({"symbol": sym, "peso_pct": round(peso, 2),
                        "sector": str(sector)[:40] if isinstance(sector, str) else None})
    if not activos:
        return None
    perfil = str(raw.get("perfil") or "").lower()
    monto = raw.get("monto")
    return {
        "perfil": perfil if perfil in ("conservador", "moderado", "agresivo") else None,
        "monto": str(monto)[:40] if isinstance(monto, (str, int, float)) and str(monto).strip() else None,
        "ts": str(raw.get("ts"))[:40] if raw.get("ts") else None,
        "activos": activos,
    }
