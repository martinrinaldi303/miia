-- ============================================================
-- migration_fix_columns.sql
-- Agrega las columnas que class42.js espera y la DB no tiene.
-- Ejecutar una vez con MySQL corriendo:
--   mysql -u root miia_cognitiva < migration_fix_columns.sql
-- ============================================================

USE miia_cognitiva;

-- portfolios
ALTER TABLE portfolios
  ADD COLUMN IF NOT EXISTS portfolio_id    VARCHAR(50)   DEFAULT NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS strategy        VARCHAR(50)   DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS status          VARCHAR(30)   DEFAULT 'stable',
  ADD COLUMN IF NOT EXISTS confidence      DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_level      DECIMAL(5,4)  DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS riesgo_global   DECIMAL(5,4)  DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS n_activos       INT           DEFAULT 0,
  ADD COLUMN IF NOT EXISTS market_ts       DATETIME(3)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS provider        VARCHAR(50)   DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS ts              DATETIME(3)   DEFAULT CURRENT_TIMESTAMP(3);

-- portfolio_assets
ALTER TABLE portfolio_assets
  ADD COLUMN IF NOT EXISTS symbol          VARCHAR(20)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sector          VARCHAR(50)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS score           DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS momentum        DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS riesgo          DECIMAL(5,4)  DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS confianza       DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS peso            DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS precio_entrada  DECIMAL(12,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS change_pct      DECIMAL(8,4)  DEFAULT 0;

-- signals_feed
ALTER TABLE signals_feed
  ADD COLUMN IF NOT EXISTS signal_id       VARCHAR(50)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS portfolio_id    VARCHAR(50)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horizonte_horas INT           DEFAULT 24,
  ADD COLUMN IF NOT EXISTS stop_loss       DECIMAL(12,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS riesgo          DECIMAL(5,4)  DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS texto           TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS fuente          VARCHAR(30)   DEFAULT 'class25B';

-- backtesting_runs
ALTER TABLE backtesting_runs
  ADD COLUMN IF NOT EXISTS descripcion     VARCHAR(500)  DEFAULT '',
  ADD COLUMN IF NOT EXISTS ticker          VARCHAR(20)   DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS senal           VARCHAR(10)   DEFAULT 'HOLD',
  ADD COLUMN IF NOT EXISTS confianza       DECIMAL(5,4)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS precio_entrada  DECIMAL(12,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS horizonte_horas INT           DEFAULT 24;

-- signals_feed: user_id tiene FK a users.id pero el sistema inserta "general"
-- que no existe en users → FK violation al guardar señales de class25B
-- Eliminar FK: user_id aquí es un label, no una clave relacional real
ALTER TABLE signals_feed DROP FOREIGN KEY IF EXISTS signals_feed_ibfk_1;

-- ============================================================
-- FLUJO PORTAFOLIOS: columnas adicionales en portfolio_assets
-- ============================================================
ALTER TABLE portfolio_assets
  ADD COLUMN IF NOT EXISTS estado_sector   VARCHAR(20)  DEFAULT 'neutral',
  ADD COLUMN IF NOT EXISTS diversificacion DECIMAL(5,4) DEFAULT 0;

-- ============================================================
-- FLUJO PORTAFOLIOS: portfolio_transactions con esquema correcto
-- (drop + recrear — tabla siempre vacía en primera ejecución)
-- ============================================================
DROP TABLE IF EXISTS portfolio_transactions;
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  portfolio_id VARCHAR(50)  NOT NULL,
  user_id      VARCHAR(100) DEFAULT NULL,
  tipo         VARCHAR(30)  NOT NULL DEFAULT 'lifecycle_event',
  evento       VARCHAR(50)  DEFAULT NULL,
  razon        VARCHAR(200) DEFAULT NULL,
  status       VARCHAR(30)  DEFAULT 'stable',
  confidence   DECIMAL(5,4) DEFAULT 0,
  risk_level   DECIMAL(5,4) DEFAULT 0.5,
  detalle      JSON         DEFAULT NULL,
  ts           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_portfolio (portfolio_id),
  INDEX idx_ts        (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- TIPOS DE COLUMNAS: user_id y portfolio_id eran INT
-- pero el código inserta strings ("general", "port_001", UUIDs)
-- ============================================================
ALTER TABLE portfolios
  DROP FOREIGN KEY IF EXISTS portfolios_ibfk_1;
ALTER TABLE portfolios
  MODIFY COLUMN user_id VARCHAR(100) NOT NULL DEFAULT 'general';

ALTER TABLE portfolio_assets
  DROP FOREIGN KEY IF EXISTS portfolio_assets_ibfk_1;
ALTER TABLE portfolio_assets
  MODIFY COLUMN portfolio_id VARCHAR(50) NOT NULL;

ALTER TABLE backtesting_runs
  DROP FOREIGN KEY IF EXISTS backtesting_runs_ibfk_1;
ALTER TABLE backtesting_runs
  MODIFY COLUMN user_id VARCHAR(100) DEFAULT NULL;

ALTER TABLE signals_feed
  MODIFY COLUMN user_id VARCHAR(100) DEFAULT NULL;

SELECT 'Migración completada OK' AS resultado;
