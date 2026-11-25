-- ============================================================================
-- usuarios_reales.sql — cuánta gente de verdad usa el chat de MIIA (16-nov-2026)
--
-- Correr EN EL SERVER:  mysql miia_cognitiva < usuarios_reales.sql
--
-- ANTES de correrlo, reemplazar en la consulta 2 los dos marcadores
-- 'EMAIL_PROPIO_1' y 'EMAIL_PROPIO_2' por las cuentas propias (la maestra y la
-- personal). No se escriben acá para no dejar datos personales en el repo.
--
-- Qué se descarta, y por qué (medido el 16-nov, cuando TODO el uso era interno):
--   · 127.0.0.1 ............ las pruebas de los deploys, que corren desde el
--                             server. La geolocalización les pone una ciudad por
--                             error: no es una persona.
--   · 160.79.104.0/21 ...... salida de pruebas automatizadas (pruebas automatizadas del chat desde
--                             una sesión). Aparecen como San Francisco.
--   · user_id deploy* / gateway ... pruebas y el reenvío interno de class30.
--   · las IPs propias ...... no se pueden fijar (el proveedor las cambia): se
--                             reconocen con la consulta 3 (las de muchas sesiones
--                             desde la ciudad propia).
--
-- OJO: la web la sirve class30 sin registro. `clientes` sólo anota a quien USA
-- el chat; las visitas a la página se miran en Cloudflare → Web Analytics
-- (confiable desde el 16-nov, cuando se destrabó su script en la CSP).
-- ============================================================================

-- 1 · Sesiones de chat por día, sin pruebas internas
SELECT DATE(ultima_visita)                 AS dia,
       COUNT(*)                            AS sesiones,
       COUNT(DISTINCT ip)                  AS ips_distintas,
       COUNT(DISTINCT user_agent)          AS navegadores_distintos
FROM clientes
WHERE ultima_visita >= NOW() - INTERVAL 30 DAY
  AND ip <> '127.0.0.1'
  AND ip NOT LIKE '160.79.10_.%'          -- 160.79.104-109 (rango de pruebas automatizadas)
  AND COALESCE(user_id,'') NOT LIKE 'deploy%'
  AND COALESCE(user_id,'') <> 'gateway'
GROUP BY dia
ORDER BY dia DESC;

-- 2 · Personas con cuenta, sin las propias
SELECT COUNT(DISTINCT NULLIF(email,''))                        AS personas_con_email,
       SUM(last_seen >= NOW() - INTERVAL 7 DAY)                AS activas_7d,
       SUM(consultas)                                          AS consultas
FROM miia_users
WHERE COALESCE(email,'') <> ''
  AND email NOT IN ('EMAIL_PROPIO_1', 'EMAIL_PROPIO_2');

-- 3 · Quién es quién: IPs de los últimos 30 días (para reconocer las propias)
SELECT ip, pais, ciudad, COUNT(*) AS sesiones,
       MIN(primera_visita) AS desde, MAX(ultima_visita) AS hasta
FROM clientes
WHERE ultima_visita >= NOW() - INTERVAL 30 DAY
  AND ip <> '127.0.0.1'
  AND ip NOT LIKE '160.79.10_.%'
GROUP BY ip, pais, ciudad
ORDER BY sesiones DESC
LIMIT 25;
