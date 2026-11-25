-- ¿La vara del acierto está sesgada? — 6-nov-2026. SOLO LEE, no toca nada.
--
-- El acierto RELATIVO compara cada instrumento contra el promedio de los 50
-- (_marketRet, class43.js). Sus subconsultas buscan el último precio con
-- `ts <= X` SIN cota inferior: si un instrumento deja de actualizarse, p1 = p0
-- y entra al promedio como un 0 exacto. Ya pasó el 15-ago (base rate 64,4 %).
-- Con el mercado en suba, esos ceros bajan el promedio y hacen que "le ganen"
-- más instrumentos de los que corresponde: es una explicación candidata del
-- 55,1 % del panel. Si todos los 50 tienen precios frescos, queda descartada.
--
-- Desde Git Bash, en la carpeta del repo:
--   ssh root@TU_SERVER "mysql miia_cognitiva -t" < docs/planilla/frescura_benchmark.sql

-- 1 · Los 12 instrumentos con MENOS precios distintos en 7 días.
--     Sano: todos con decenas o cientos. Sospechoso: 0-1, o "ultimo" de hace días.
SELECT u.t AS ticker,
       MAX(p.ts) AS ultimo,
       COUNT(DISTINCT p.precio) AS precios_distintos_7d
FROM (SELECT 'XLK' AS t UNION ALL SELECT 'XLF' AS t UNION ALL SELECT 'XLE' AS t UNION ALL SELECT 'XLV' AS t UNION ALL SELECT 'XLY' AS t UNION ALL SELECT 'XLI' AS t UNION ALL SELECT 'XLB' AS t UNION ALL SELECT 'XLRE' AS t UNION ALL SELECT 'XLU' AS t UNION ALL SELECT 'XLC' AS t UNION ALL SELECT 'XLP' AS t UNION ALL SELECT 'SPY' AS t UNION ALL SELECT 'QQQ' AS t UNION ALL SELECT 'IWM' AS t UNION ALL SELECT 'DIA' AS t UNION ALL SELECT 'EFA' AS t UNION ALL SELECT 'EEM' AS t UNION ALL SELECT 'EWJ' AS t UNION ALL SELECT 'EWG' AS t UNION ALL SELECT 'EWU' AS t UNION ALL SELECT 'EWL' AS t UNION ALL SELECT 'EWY' AS t UNION ALL SELECT 'EWT' AS t UNION ALL SELECT 'EWH' AS t UNION ALL SELECT 'EWA' AS t UNION ALL SELECT 'INDA' AS t UNION ALL SELECT 'FXI' AS t UNION ALL SELECT 'EWC' AS t UNION ALL SELECT 'EWW' AS t UNION ALL SELECT 'ARGT' AS t UNION ALL SELECT 'EWZ' AS t UNION ALL SELECT 'ILF' AS t UNION ALL SELECT 'SMH' AS t UNION ALL SELECT 'XBI' AS t UNION ALL SELECT 'VNQ' AS t UNION ALL SELECT 'XOP' AS t UNION ALL SELECT 'KRE' AS t UNION ALL SELECT 'ITB' AS t UNION ALL SELECT 'JETS' AS t UNION ALL SELECT 'IYT' AS t UNION ALL SELECT 'XME' AS t UNION ALL SELECT 'GDX' AS t UNION ALL SELECT 'XRT' AS t UNION ALL SELECT 'ARKK' AS t UNION ALL SELECT 'MTUM' AS t UNION ALL SELECT 'QUAL' AS t UNION ALL SELECT 'VTV' AS t UNION ALL SELECT 'VUG' AS t UNION ALL SELECT 'USMV' AS t UNION ALL SELECT 'IWF' AS t) u
LEFT JOIN precios p
  ON p.ticker = u.t AND p.precio > 0 AND p.ts >= NOW() - INTERVAL 7 DAY
GROUP BY u.t
ORDER BY precios_distintos_7d ASC, ultimo ASC
LIMIT 12;

-- 2 · Por día, cuántos de los 50 tuvieron al menos un precio.
--     Los días de rueda tienen que dar 50. Los fines de semana dan menos (normal:
--     class7 sólo escribe cuando el precio cambia).
SELECT DATE(ts) AS dia, DAYNAME(ts) AS dia_semana, COUNT(DISTINCT ticker) AS con_precio
FROM precios
WHERE ts >= NOW() - INTERVAL 30 DAY AND precio > 0
  AND ticker IN ('XLK','XLF','XLE','XLV','XLY','XLI','XLB','XLRE','XLU','XLC','XLP','SPY','QQQ','IWM','DIA','EFA','EEM','EWJ','EWG','EWU','EWL','EWY','EWT','EWH','EWA','INDA','FXI','EWC','EWW','ARGT','EWZ','ILF','SMH','XBI','VNQ','XOP','KRE','ITB','JETS','IYT','XME','GDX','XRT','ARKK','MTUM','QUAL','VTV','VUG','USMV','IWF')
GROUP BY DATE(ts), DAYNAME(ts)
ORDER BY dia;
