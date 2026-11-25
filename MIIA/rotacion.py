"""Rotación de predicciones del LSTM — aritmética pura, sin dependencias.

Vive aparte de `class44.py` a propósito, por el mismo motivo que
`scripts/seguridad_red.js` y `scripts/cola_acotada.js` viven aparte de class30:
importar class44 arrastra torch, yfinance y redis, así que la lógica metida ahí
adentro **no se puede probar**. Acá no hay nada que importar más que la stdlib.

El problema que resuelve
------------------------
`MotorLSTM.predecir()` llama a `_descargar()`, o sea a `yf.download`, en CADA
predicción y no sólo al entrenar. El ciclo de predicción es SERIAL y cada
descarga tiene `timeout=30`. Con los 50 instrumentos del universo y un ciclo de
15 minutos eso son **4.800 descargas de Yahoo por día** (con 13 eran 1.248) y un
ciclo que en el peor caso tarda 25 minutos contra un intervalo de 15. No hay
limiter, ni caché, ni manejo de 429: una descarga fallida devuelve `None` y el
ticker se saltea en silencio.

La asimetría que lo resuelve: **la barra es horaria y el ciclo es de 15 min**,
así que 3 de cada 4 descargas traen la misma barra y el modelo recibe la misma
entrada. Predecir los 50 en cada ciclo es pagar cuatro veces lo mismo.

Rotando 13 por ciclo, cada ticker se predice una vez por hora y el gasto queda
idéntico al de 13 tickers cada 15 minutos — en descargas, en CPU y en caudal del
bus, que es lo que llena la grilla del panel desde el historial de class46.
Es el mismo patrón de rotación que class1 usa para las noticias.
"""
from __future__ import annotations

from math import ceil

__all__ = ["proximo_lote", "ciclos_por_ronda", "descargas_por_dia"]


def proximo_lote(tickers, k, intentos):
    """Los `k` tickers que MENOS veces se intentaron.

    `intentos` es ``{ticker: cuántas veces se intentó}``; uno que no figura nunca
    se intentó y por lo tanto va primero.

    ⚠️ Cuenta INTENTOS y no ÉXITOS, y eso no es un detalle: un ticker que falla
    siempre —un ETF sin suficientes barras horarias, un 429 de Yahoo que no se
    va— se quedaría con la cabeza de la cola y dejaría a todos los demás sin
    predecir **nunca**. Es el mismo bloqueo de cabeza de cola que la consulta de
    pendientes de class42 tenía con las decisiones de 48 h, y no se repite.

    ⚠️ Y cuenta intentos, no "hace cuánto que no se intenta". La primera versión
    ordenaba por la hora del último intento y rompía los empates por la posición
    en la lista: con 50 tickers y lotes de 13, los primeros de la lista se colaban
    sistemáticamente en el borde del lote y en 40 ciclos salían 14 veces contra 10
    de los últimos. Lo cazó `sim30`. Ordenando por el contador el reparto tiene
    garantía: siempre se elige entre los menos atendidos, así que la diferencia
    entre el que más y el que menos salió **no puede pasar de 1**.

    Los empates se rompen por la posición en `tickers`, así que el reparto es
    determinista y reproducible: dos corridas con el mismo estado dan el mismo
    lote.

    `k <= 0` o `k >= len(tickers)` devuelve la lista entera, sin rotar — el
    camino de antes, bit a bit.
    """
    lista = list(tickers)
    if k <= 0 or k >= len(lista):
        return lista
    orden = sorted(range(len(lista)),
                   key=lambda i: (int(intentos.get(lista[i], 0)), i))
    return [lista[i] for i in orden[:k]]


def ciclos_por_ronda(n_tickers, k):
    """Cuántos ciclos tarda la rotación en cubrir a todos una vez."""
    if k <= 0 or k >= n_tickers:
        return 1
    return ceil(n_tickers / k)


def descargas_por_dia(n_tickers, k, intervalo_s):
    """Descargas a Yahoo por día, que es el recurso que de verdad se gasta.

    Sin rotación son `n_tickers` por ciclo; con rotación son `k`, pase lo que
    pase con el tamaño de la lista. Esto está en código y no sólo en un
    comentario para que la cuenta no se separe de lo que hace el programa.
    """
    por_ciclo = n_tickers if (k <= 0 or k >= n_tickers) else k
    ciclos_dia = 86400.0 / float(intervalo_s)
    return int(round(por_ciclo * ciclos_dia))
