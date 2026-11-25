-- ============================================================
-- reparar_permisos_mysql.sql — Reparación de permisos de MIIA
--
-- CUÁNDO USARLO: si los logs muestran
--   "Access denied for user 'Martin Rinaldi'@'localhost' to database 'miia_cognitiva'"
-- Causa (Windows/XAMPP): un apagado brusco con XAMPP corriendo corrompe la
-- tabla Aria mysql.db → el usuario sigue existiendo pero pierde el GRANT.
--
-- Multiplataforma: funciona en XAMPP/MariaDB (Windows) y MySQL 8 (Linux).
--
-- CÓMO EJECUTARLO (como root, desde la carpeta del proyecto):
--   Windows: C:\xampp\mysql\bin\mysql.exe -u root < "operador\aprendizaje\config\reparar_permisos_mysql.sql"
--   Linux:   sudo mysql < operador/aprendizaje/config/reparar_permisos_mysql.sql
-- ============================================================

-- Reparación de tablas de permisos (best-effort).
-- En MySQL 8 son InnoDB → devuelve una nota "doesn't support repair" (no es error).
-- En MariaDB (XAMPP) son Aria/MyISAM → repara de verdad.
REPAIR TABLE mysql.db;
REPAIR TABLE mysql.tables_priv;

-- El usuario debe existir ANTES del GRANT: MySQL 8 no permite crear un usuario
-- con GRANT (falla con ERROR 1410). CREATE USER IF NOT EXISTS es no-op si ya
-- existe (conserva su contraseña), así que no pisa las credenciales del .env.
CREATE USER IF NOT EXISTS 'Martin Rinaldi'@'localhost';
GRANT ALL PRIVILEGES ON miia_cognitiva.* TO 'Martin Rinaldi'@'localhost';
FLUSH PRIVILEGES;

-- Verificación: debe mostrar "GRANT ALL PRIVILEGES ON `miia_cognitiva`.*"
SHOW GRANTS FOR 'Martin Rinaldi'@'localhost';
