"""rank_ic.py — el rank IC, la única métrica que aprovecha la sección transversal.

POR QUÉ EXISTE. El acierto binario (`edge_vs_baseline`) pregunta «¿acertó la
dirección?» decisión por decisión, y así **desperdicia los otros doce
instrumentos de cada ventana**. El rank IC pregunta la que el sistema decide
desde el 21-sep: «¿ordenó bien a los instrumentos entre sí?». Con los mismos
datos detecta señales mucho más chicas, porque cada ventana aporta un
ordenamiento entero en vez de un acierto.

Cuánto más chicas, medido (`sim_ranking.py`, 27 ventanas del 5-ago al 11-sep):

    σ del IC por ventana, con 13 instrumentos      0,279
    IC mínimo detectable en 44 ruedas              0,082
    el IC que está en juego                       ~0,040

⚠️ **Con 13 instrumentos, la corrida del 12-oct al 12-dic NO puede contestar la
pregunta**: harían falta ~119 ventanas, o sea 5,7 meses. Martín decidió el
21-sep dejar el universo en 13, así que esto arranca la serie — no la cierra.
Leer `rank_ic` SIEMPRE junto a `rank_ic_min_detectable`, igual que el edge se
lee junto a `edge_min_detectable`. Un IC de 0,05 con MDE de 0,082 es ruido.

POR QUÉ ES UN MÓDULO APARTE. Todo acá es aritmética pura: sin FastAPI, sin base,
sin red. Así lo puede importar `miia_chatbot.py` en producción y también
`sim13_ensamble.py` en frío, y la prueba ejecuta **el código que corre de
verdad** en vez de una reimplementación que puede diverger sin que nadie lo
note. Es el mismo criterio que `scripts/seguridad_red.js`.
"""

from __future__ import annotations

import math

#: Menos instrumentos que esto y la ventana no se usa: un Spearman sobre 3 o 4
#: puntos toma cualquier valor. Con 5 el |IC| por azar ya tiene σ = 0,5, que
#: sigue siendo enorme — por eso las ventanas se promedian, nunca se leen solas.
MIN_INSTRUMENTOS = 5


def rangos(valores: list[float]) -> list[float]:
    """Rangos de 1 a n. Los empates reciben el rango PROMEDIO del grupo.

    El promedio no es un detalle: los scores empatan de verdad. Una red
    saturada contesta lo mismo para los 13 instrumentos (medido el 18-sep:
    class24/mercado entre 0,000 y 0,015), y sin promediar el rango el orden
    lo terminaría decidiendo el orden de recorrido de un diccionario. El IC
    pasaría a medir cómo itera un `dict`.
    """
    n = len(valores)
    orden = sorted(range(n), key=lambda i: valores[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and valores[orden[j + 1]] == valores[orden[i]]:
            j += 1
        medio = (i + j) / 2.0 + 1.0          # rangos base 1
        for k in range(i, j + 1):
            out[orden[k]] = medio
        i = j + 1
    return out


def spearman(xs: list[float], ys: list[float]) -> float | None:
    """Correlación de rangos. `None` si no se puede calcular.

    Se hace como Pearson SOBRE LOS RANGOS y no con la fórmula abreviada
    `1 - 6Σd²/(n³-n)`: esa versión sólo vale sin empates, y acá los hay.
    """
    n = len(xs)
    if n < 2 or len(ys) != n:
        return None
    rx, ry = rangos(xs), rangos(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    vx  = sum((a - mx) ** 2 for a in rx)
    vy  = sum((b - my) ** 2 for b in ry)
    if vx <= 0 or vy <= 0:          # todos los scores iguales, o todos los retornos
        return None
    return cov / math.sqrt(vx * vy)


def retornos_relativos(retornos: dict[str, float]) -> dict[str, float]:
    """Retorno de cada instrumento MENOS el promedio equiponderado de la ventana.

    Equiponderado y no compuesto de precios: es el defecto 5. Promediar
    **precios** hace que XLK (188) pese 15,8 % del índice e ILF (35) el 2,9 %,
    y el signo del retorno relativo se daba vuelta en el 4,3 % de las ventanas
    de 24 h y el 10,8 % de las de 48 h, sesgado 4 a 1 hacia «el mercado bajó».
    `_marketRet` de class43 ya promedia retornos; acá se usa el mismo criterio
    para que la vara del rank IC y la de la etiqueta sean la misma.
    """
    if not retornos:
        return {}
    medio = sum(retornos.values()) / len(retornos)
    return {t: r - medio for t, r in retornos.items()}


def betas_previas(rets_por_sesion: dict[str, dict[str, float]], hasta: str,
                  ventana: int = 60, minimo: int = 15) -> dict[str, float]:
    """Beta de cada instrumento contra el promedio equiponderado, con las
    sesiones ANTERIORES a `hasta` (nunca la que se va a medir: sería mirar el
    futuro). `rets_por_sesion` = {fecha: {ticker: retorno}}.

    POR QUÉ (16-nov-2026). El retorno RELATIVO (instrumento − promedio) no
    neutraliza la beta: un ETF de beta 1,5 «le gana al promedio» en los días de
    suba y pierde en los de baja, sin que nadie haya elegido nada. Si el score del
    ranking se parece a la beta —los volátiles arriba—, el IC de cada día sigue
    al mercado: grande y positivo cuando sube, grande y negativo cuando baja, y
    su promedio da ~0 con un desvío enorme. Eso NO es selección: es una apuesta
    a la dirección del mercado vestida de ranking.
    """
    previas = sorted(d for d in rets_por_sesion if d < hasta)[-ventana:]
    mercado = {d: sum(r.values()) / len(r) for d in previas if (r := rets_por_sesion[d])}
    tks = {t for d in previas for t in rets_por_sesion[d]}
    out = {}
    for t in tks:
        pares = [(rets_por_sesion[d][t], mercado[d]) for d in previas
                 if t in rets_por_sesion[d] and d in mercado]
        if len(pares) < minimo:
            continue
        xs = [m for _, m in pares]; ys = [r for r, _ in pares]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        vx = sum((x - mx) ** 2 for x in xs)
        if vx <= 0:
            continue
        out[t] = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / vx
    return out


def retornos_residuales(retornos: dict[str, float], betas: dict[str, float]) -> dict[str, float]:
    """Retorno de cada instrumento MENOS lo que explica su beta: r − β·mercado,
    centrado. Sólo los instrumentos con beta conocida."""
    if not retornos:
        return {}
    m = sum(retornos.values()) / len(retornos)
    res = {t: r - betas[t] * m for t, r in retornos.items() if t in betas}
    if not res:
        return {}
    c = sum(res.values()) / len(res)
    return {t: v - c for t, v in res.items()}


def correlacion(xs: list[float], ys: list[float]) -> float | None:
    """Pearson simple. `None` si no se puede."""
    n = len(xs)
    if n < 3 or len(ys) != n:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    vx = sum((x - mx) ** 2 for x in xs); vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(vx * vy)


def ic_de_ventana(seccion: list[tuple[str, float, float]],
                  min_instrumentos: int = MIN_INSTRUMENTOS) -> float | None:
    """IC de UNA ventana. `seccion` = [(ticker, score, retorno_relativo), …]."""
    if len(seccion) < min_instrumentos:
        return None
    return spearman([s for _, s, _ in seccion], [r for _, _, r in seccion])


def serie_ic(ventanas: list[list[tuple[str, float, float]]],
             min_instrumentos: int = MIN_INSTRUMENTOS) -> dict:
    """Agrega las ventanas en el número que se lee.

    ⚠️ **Las ventanas tienen que ser NO SOLAPADAS.** Es el error que el 21-sep
    casi produce un hallazgo falso en el rendimiento de los portafolios: con
    ventanas de 20 sesiones corridas de a una, el `t` daba −2,15; sin solapar,
    −0,23. Acá cada ventana es una sesión distinta, así que no se solapan — pero
    quien arme la lista tiene que mantener esa propiedad.
    """
    # Se guarda el tamaño JUNTO con el IC, en la misma pasada. Contarlos por
    # separado —los instrumentos sobre las ventanas grandes, el IC sobre las
    # que dieron número— daba `rank_ic_instrumentos = 17,5` con un universo de
    # 13, o sea un promedio imposible. Lo cazó `sim13` en su primera corrida.
    pares = []
    for v in ventanas:
        ic = ic_de_ventana(v, min_instrumentos)
        if ic is not None:
            pares.append((ic, len(v)))
    ics = [ic for ic, _ in pares]
    n = len(ics)
    if n == 0:
        return {"rank_ic": None, "rank_ic_desvio": None, "rank_ic_ventanas": 0,
                "rank_ic_t": None, "rank_ic_min_detectable": None,
                "rank_ic_significativo": None, "rank_ic_instrumentos": None,
                "rank_ic_sin_orden": len(ventanas), "rank_ic_serie": []}

    medio = sum(ics) / n
    # Desvío MUESTRAL (n-1). Con 27 ventanas la diferencia contra el
    # poblacional es del 2 %, pero es el estimador correcto y el `t` lo usa.
    desvio = (math.sqrt(sum((x - medio) ** 2 for x in ics) / (n - 1))
              if n > 1 else None)

    t = mde = signif = None
    if desvio is not None and desvio > 0:
        err = desvio / math.sqrt(n)
        t   = medio / err
        # El IC más chico que esta medición puede distinguir del azar. Si el
        # observado es menor, el número que se está mirando es ruido — no
        # importa qué signo tenga. Mismo criterio que `edge_min_detectable`.
        mde = 1.96 * err
        # Una cola: la afirmación es «ordena BIEN», no «ordena distinto del
        # azar». Que el IC quede fuera por abajo no es una ventaja al revés.
        signif = bool(medio - mde > 0)

    instr = sum(k for _, k in pares) / n

    return {
        "rank_ic":                round(medio, 4),
        "rank_ic_desvio":         round(desvio, 4) if desvio is not None else None,
        "rank_ic_ventanas":       n,
        "rank_ic_t":              round(t, 2) if t is not None else None,
        "rank_ic_min_detectable": round(mde, 4) if mde is not None else None,
        "rank_ic_significativo":  signif,
        "rank_ic_instrumentos":   round(instr, 1),
        # Ventanas que existieron pero no dieron IC: todos los scores iguales
        # (una red saturada no ordena nada) o muy pocos instrumentos. Si este
        # número crece, el ranking se está quedando sin sección transversal y
        # el IC medio pasa a calcularse sobre otra muestra sin que se note.
        "rank_ic_sin_orden":      len(ventanas) - n,
        # La serie cruda, para el Excel y para el gráfico. Es lo que en marzo
        # va a tener 5-6 meses acumulados, que es cuando el número empieza a
        # valer: sin guardarla, cada lectura arranca de cero.
        "rank_ic_serie":          [round(x, 4) for x in ics],
    }
