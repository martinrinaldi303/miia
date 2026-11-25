-- ============================================================
-- Índices para /api/backtesting/professional — para el corte del 12-oct-2026
-- ============================================================
--
-- POR QUÉ. El endpoint tarda 14,1 s de forma sostenida (medido en las lecturas
-- del 16, 17, 18 y 21-sep). La causa, medida sobre el volcado del 15-sep con
-- `perf.py`: hace **cuatro barridas completas** de `cognitive_decisions` para
-- devolver 55 filas.
--
--   filas en cognitive_decisions          384.188
--     de ellas shadow (excluidas)          64.101
--     verificadas direccionales           150.635   (39,2 %)
--     con retorno y ts_outcome            147.001   (38,3 %)
--     días distintos del GROUP BY              49
--
--   modo_rows    devuelve   4 filas tras leer 384.188
--   totals_rows  devuelve   1 fila  tras leer 384.188
--   vol_rows     devuelve   1 fila  tras leer 384.188
--   dias_rows    devuelve  49 filas tras leer 384.188
--   ──────────────────────────────────────────────────────
--   TOTAL por request                  1.536.752 filas
--
-- Los índices que ya existen (`idx_senal`, `idx_outcome`, `idx_outcome_hash`)
-- no sirven para esto: son de una sola columna y el optimizador prefiere el
-- barrido antes que ir al índice y volver a la fila 150.000 veces.
--
-- CUÁNDO. En el corte del 12-oct, ANTES de levantar el orquestador. En MySQL
-- 8.0 estos ALTER son online (INPLACE, LOCK=NONE), así que se podrían correr
-- en caliente — pero con la tabla en ~500.000 filas tardan minutos y compiten
-- por I/O con la corrida. No vale la pena hacerlo durante el congelamiento.
--
-- CÓMO. Uno por uno, mirando el tiempo de cada uno:
--
--   mysql -u miia -p miia_cognitiva < docs/migracion_indices_12oct.sql
--
-- Y DESPUÉS: regenerar el esquema, que es la única forma de rearmar la base.
--
--   mysqldump --no-data miia_cognitiva > docs/esquema_miia_cognitiva.sql
--
-- CÓMO VERIFICAR que sirvieron, antes y después:
--
--   EXPLAIN ANALYZE SELECT ... ;      -- tiene que decir "Index" y no "Table scan"
--   SELECT ... ;                      -- y el endpoint bajar de 14 s a menos de 2
--
-- SI ALGO SALE MAL: un índice se saca sin riesgo y sin perder datos.
--   ALTER TABLE cognitive_decisions DROP INDEX idx_medicion;

-- ── 1 · La consulta de medición ─────────────────────────────────────────
-- Cubre modo_rows, totals_rows y vol_rows: las tres filtran por temperatura y
-- outcome_real, y agrupan o cuentan por senal y label_modo.
--
-- El orden de las columnas NO es arbitrario: primero las de igualdad más
-- selectivas del filtro (`temperatura` descarta el 17 % de entrada,
-- `outcome_real` y `senal` acotan al 39 %), y `label_modo` al final porque es
-- por lo que se agrupa. Con este orden la consulta se resuelve **dentro del
-- índice**, sin ir a la fila.
ALTER TABLE cognitive_decisions
  ADD INDEX idx_medicion (temperatura, outcome_real, senal, label_modo);

-- ── 2 · La curva diaria ─────────────────────────────────────────────────
-- `dias_rows` agrupa por DATE(ts_outcome) y promedia retorno_real sobre las
-- 147.001 filas verificadas. Poniendo ts_outcome y retorno_real en el índice,
-- el motor no necesita leer ninguna fila: es un recorrido del índice y nada
-- más. El índice es mucho más angosto que la fila (la tabla tiene `razon`,
-- que es texto largo), así que además entra mejor en el buffer pool.
--
-- OJO: `GROUP BY DATE(ts_outcome)` aplica una función a la columna, así que el
-- índice NO evita la agrupación — evita el acceso a la fila, que es lo caro.
-- Agrupar por el día con índice de verdad exigiría una columna generada, y no
-- vale la pena por 49 grupos.
ALTER TABLE cognitive_decisions
  ADD INDEX idx_curva_diaria (outcome_real, senal, ts_outcome, retorno_real);

-- ── 3 · El tamaño de muestra efectivo ───────────────────────────────────
-- n_efectivo hace COUNT(DISTINCT CONCAT(ventana, ticker)) sobre ts_decision y
-- ticker. `idx_ticker` y `idx_ts` existen por separado y ninguno alcanza: hace
-- falta el par. Es la métrica que encabeza la lectura de la tesis, así que
-- conviene que no sea la que cuesta.
ALTER TABLE cognitive_decisions
  ADD INDEX idx_ventana_ticker (ts_decision, ticker);

-- ── Lo que NO se hace acá, y por qué ────────────────────────────────────
--
-- **Fusionar las cuatro consultas en una.** Se puede: las tres primeras leen la
-- misma tabla y se podrían resolver en UNA pasada con agregación condicional,
-- calculando las dos poblaciones (`relativo` y `absoluto`) a la vez y dejando
-- que Python elija. Serían 1.536.752 filas leídas → 768.376, o sea 2×.
--
-- No se hace en este commit **a propósito**: esa consulta calcula `n_efectivo`,
-- el acierto y el edge, que son LA métrica de la tesis, y no hay forma de
-- verificar el SQL sin una base con los datos. Un CASE mal puesto cambiaría el
-- número en silencio, que es exactamente el modo de falla contra el que este
-- proyecto viene trabajando.
--
-- Se hace el 12-oct, con la base delante, corriendo la vieja y la nueva sobre
-- los mismos datos y comparando campo por campo. Hasta entonces, el usuario ya
-- no espera: el endpoint sirve la respuesta guardada y refresca por atrás.
