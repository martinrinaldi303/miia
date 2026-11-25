# MIIA v4 — Conclusión del experimento

> **Estado: provisional, con las mediciones al 11-sep-2026 (22:00 CEST).** El
> 11-sep el server de Contabo se dio de baja y ese mismo día se renovó: la corrida
> sigue. La columna «Final» se completa el día que se cierre la medición (ver
> «Cómo cerrar la medición», al final).

---

## 1. La pregunta

¿Puede MIIA —un ensamble de redes que decide BUY/SELL/HOLD sobre ETFs— predecir
mejor que el azar si un instrumento **le va a ganar al promedio** de su universo
en las próximas 48 horas?

La pregunta es **relativa** desde ORDEN 1: se juzga el retorno del instrumento
menos el promedio de los 13, no si "subió". Contra el absoluto, decir "sube"
siempre acertaba ~78-84 % en un mercado alcista sin saber nada. Contra el
relativo, el azar vale ~50 % por construcción, y una ventaja de 3-5 puntos se
puede detectar.

La métrica sale de `/api/backtesting/professional` y se lee en este orden:
`n_efectivo → edge_min_detectable → edge_significativo → edge_vs_baseline`.
`n_efectivo` cuenta ventanas de 48 h que no se solapan, no filas.

## 2. La respuesta, con los números

| | Al 11-sep-2026 | Final |
|---|---|---|
| Días medidos | 42 | … |
| Decisiones verificadas (relativas) | 100.982 | … |
| `n_efectivo` (ventanas de 48 h) | 223 | … (~300 al 28-sep) |
| Ventaja mínima detectable | ±6,5 pp | … (~5,6 pp al 28-sep) |
| Base rate | 51,9 % | … |
| Acierto direccional | 50,0 % | … |
| **Ventaja sobre el baseline** | **−1,9 pp** | … |
| ¿Significativa? | **no** | … |

**Lectura: sin ventaja demostrable.** Los −1,9 puntos están adentro de la banda de
ruido de ±6,5. No quiere decir que MIIA pierda: quiere decir que, con esta
cantidad de datos, no se la puede distinguir de tirar una moneda.

**El techo de este experimento.** La ventaja mínima detectable baja con la raíz
cuadrada de los datos (1,96·√(p(1−p)/n)): para ver una ventaja la mitad de grande
hacen falta cuatro veces más ventanas. A ~5 ventanas por día:

| Ventaja que se puede demostrar | `n_efectivo` | Tiempo de corrida |
|---|---|---|
| 6,5 pp | 223 | 42 días (al 11-sep) |
| ~5,6 pp | ~300 | hasta el 28-sep |
| 2 pp | ~2.400 | ~16 meses |
| 1 pp | ~9.600 | ~5 años |

Una ventaja de 2-3 puntos, que es la plausible en finanzas, **esta corrida no la
podía demostrar aunque existiera.**

## 3. Lo que dice la evaluación fuera de línea

Evaluación de las familias de modelos sobre 7 ETFs con cotizaciones diarias reales
(2024-07 a 2026-07, corte cronológico, sin fuga temporal). Tarea: dirección del
día siguiente.

| Modelo | Acierto | Sharpe | Máxima caída |
|---|---|---|---|
| LSTM (familia de class44) | 51,6 % | +0,58 | −22,0 % |
| Random Forest | 51,3 % | +0,35 | −26,2 % |
| ARIMA | 49,8 % | −0,59 | −53,6 % |
| Baseline ingenuo | 47,4 % | −1,22 | −60,1 % |
| Comprar y mantener | — | +0,44 | −23,7 % |

Coincide con la corrida en vivo: la dirección diaria de un ETF líquido ronda el
52 %. El único resultado con tamaño real es otro: **operando sólo el 25 % más
confiable, el Random Forest sube de 51,2 % a 55,6 % de acierto y su Sharpe de
+0,35 a +3,14.** La confianza del modelo es informativa. La palanca es la
selectividad, no decidir sobre todo.

## 4. Lo que la medición encontró adentro del sistema

El resultado más valioso del proyecto no es un porcentaje de acierto. Es que el
instrumento de medición detectó que **el lazo de aprendizaje no aprendía de los
resultados.** Verificado en el código y medido en producción, del 9 al 11 de
septiembre:

1. **Crédito por escala.** La red "dominante" era la de score crudo más alto. Las
   redes no comparten escala, así que ganaba siempre la misma: simulado con las
   distribuciones reales, 4.000 de 4.000 créditos fueron a `class22/portfolio`.
2. **Crédito por presencia.** Cada crédito renormalizaba las 21 claves, así que
   una red perdía peso por no estar en la decisión, no por equivocarse. Medido: la
   familia `mercado` pasó de 0,00 a 0,53 con la bolsa abierta y cayó a 0,03 esa
   misma noche. **Los pesos seguían el horario de la bolsa.**
3. **El voto de los módulos.** El nivel externo del ensamble usaba una clave que
   también cobraba el crédito de las señales sin fuente. El 11-sep a las 05:33,
   **class24 tenía el 99,995 % del voto.**
4. **El snapshot equivocado.** Cada resultado se le cobraba a la opinión de otra
   decisión, tomada entre 21 y 25 horas después: 64 lugares por condición no
   alcanzaban para un horizonte de 48 h.
5. **La regla vieja no distinguía.** En simulación, una red que acertaba el 50 %
   terminaba con más peso que una que acertaba el 60 %.
6. **Además:** el índice GENERAL promediaba precios en vez de retornos; una HOLD se
   juzgaba como si fuera SELL; el neutro es un lazo con ganancia ≈ −2,1; y el
   umbral de decisión vuelve a su valor inicial en cada reinicio.

Se arreglaron y desplegaron dos cosas: la atribución de class43 el 10-sep, y la
capa 2 de class25A con voto parejo por módulo el **11-sep a las 06:56:37 CEST**.
Verificado en producción: con la bolsa cerrada, los pesos de `mercado` ya no se
mueven.

**Quedó una capa con la regla vieja.** Cuando class43 verifica una señal con
precio en vivo, le dice a class25A qué red acreditar, y ese crédito entra por la
capa 1, que el arreglo no tocó: lleva a la red nombrada al piso de 0,10 aunque se
haya equivocado, y achica a todas las demás. Ese camino sólo corre con la bolsa
abierta y arrancó el viernes 11-sep a la tarde. Al cierre, las cinco claves de
class21 estaban clavadas en ~0,083 y casi todo class23 y class24 en 1e-35,
mientras la capa 2 todavía no había actuado ni una vez. Hasta que se arregle, en
rueda los pesos miden cuántas veces se nombró a cada red, no cuánto acierta.

**Consecuencia para la tesis.** Los −1,9 puntos miden a un sistema cuyos pesos no
aprendían de los resultados. Lo que corre desde el 11-sep es otra población,
porque hay un corte en la serie, y va a haber otro cuando se arregle la capa 1.
Cada población nueva arranca de cero: a ~5 ventanas por día, después de 17 días
(~85 ventanas) la ventaja mínima detectable ronda los **10 puntos**. De las
primeras semanas se puede evaluar la mecánica (pesos que no siguen el reloj,
snapshot correcto), no el rendimiento.

## 5. Cortes en la serie de la tesis

Las decisiones de antes y de después de cada corte no son comparables.

| Fecha (CEST) | Qué pasó |
|---|---|
| 7-sep | Labor Day: la bolsa de Nueva York estuvo cerrada. No es un defecto |
| 9-sep, 02:33 | Reinicio completo del orquestador |
| 9-sep, 17:57 | Neutro forzado a 0,609 (se revirtió a 0,583) |
| 10-sep, por la tarde | class43: reparto de crédito por desvío propio (capa 1) |
| **11-sep, 06:56:37** | **class25A: capa 2 arreglada y voto parejo por módulo** |
| 11-sep, por la tarde | class43 empieza a verificar en memoria: la capa 1, con la regla vieja, mueve los pesos en rueda |
| **12-sep, 04:00** | **Tres cambios: crédito sólo por la capa 2 (class43), decisión en z y umbral por tasa de emisión (class25A)** |
| **13-sep, 00:28** | **class25B: se apaga el filtro de SELL de confianza 0,70, que con la decisión en z dejaba lo publicado en 97 % BUY** |

## 6. Conclusión

1. **Como sistema, MIIA funciona.** Son 49 módulos en cuatro lenguajes que sólo
   se hablan por un bus, meses en producción, y un lazo de verificación que cerró
   100.982 decisiones contra precios reales.
2. **Como predictor, no mostró ventaja.** En esta corrida su acierto no se
   distingue del azar, y la corrida no tenía potencia para ver una ventaja chica.
3. **La tesis tiene resultado, y es honesto:** negativo, con el instrumento que
   permite afirmarlo, y con el diagnóstico de por qué: el aprendizaje repartía el
   crédito por escala y por presencia, no por acierto.
4. **Para una V5**, en este orden: cerrar bien el lazo de aprendizaje antes de
   sumar módulos; operar con umbral, sólo sobre las predicciones más confiables;
   y darle a la medición el tiempo que pide la raíz cuadrada.

---

## Cómo cerrar la medición

Sirve para el día que se decida cerrar, y conviene repetir el paso 1 antes de
cualquier deploy que toque el aprendizaje. Nada de esto reinicia MIIA. Donde dice
`IP_DEL_SERVER`, va la IP del server.

**1 · Lo aprendido.** Los pesos de las redes, el neutro, la memoria bayesiana y el
LSTM. En el server:

```bash
tar czf /root/miia_aprendido_$(date +%F).tar.gz -C /opt/miia/operador/aprendizaje state models
```

`state/` tiene los JSON de class23, class24, class25A y class44; `models/lstm/`
tiene los `.pt` y los `.pkl` del LSTM. Después, desde Git Bash:

```bash
scp root@IP_DEL_SERVER:'/root/miia_aprendido_*.tar.gz' /d/
```

**2 · La lectura final.** En el server:

```bash
bash /root/miia_check.sh > /root/miia_check_final_$(date +%F).txt 2>&1
```

La sección 7 de esa salida trae los números de la tabla de la sección 2. Para ver
por separado lo de antes y lo de después del arreglo (orientativo: da el acierto
crudo, sin la corrección por solapamiento que hace el endpoint):

```bash
sudo mysql miia_cognitiva -e "SELECT ts_decision >= '2026-09-11 06:56:37' AS post_arreglo, COUNT(*) AS verificadas, ROUND(100*AVG(outcome_real='correcto'),1) AS acierto_pct FROM cognitive_decisions WHERE label_modo='relativo' AND outcome_real IN ('correcto','incorrecto') AND COALESCE(temperatura,'') <> 'shadow' GROUP BY post_arreglo" > /root/tesis_por_periodo.txt
```

Y bajar las tres cosas, que pesan pocos KB pero son la prueba de esta conclusión:
si el server se apaga, ya no se pueden rearmar.

```bash
scp root@IP_DEL_SERVER:'/root/miia_check_final_*.txt' root@IP_DEL_SERVER:/root/tesis_por_periodo.txt root@IP_DEL_SERVER:/root/tesis_semanal.csv /d/
```

**3 · La base con datos: opcional.** Para esta conclusión no hace falta, porque
los números salen de la lectura final. Si igual la querés, el comando está en el
README («Antes de apagar un server»), y tiene que ser antes de apagarlo.

**4 · Completar** la columna «Final» de la sección 2 y el resultado de la
población posterior al arreglo en la sección 4.
