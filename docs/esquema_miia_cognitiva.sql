-- MySQL dump 10.13  Distrib 8.0.46, for Linux (x86_64)
--
-- Host: localhost    Database: miia_cognitiva
-- ------------------------------------------------------
-- Server version	8.0.46-0ubuntu0.24.04.4

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `_backup_btstats_20260701`
--

DROP TABLE IF EXISTS `_backup_btstats_20260701`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `_backup_btstats_20260701` (
  `id` int NOT NULL DEFAULT '0',
  `fecha` date NOT NULL,
  `total_verificadas` int DEFAULT '0',
  `correctas` int DEFAULT '0',
  `incorrectas` int DEFAULT '0',
  `pendientes` int DEFAULT '0',
  `accuracy_global` float DEFAULT '0',
  `accuracy_30d` float DEFAULT '0',
  `precision_buy` float DEFAULT '0',
  `precision_sell` float DEFAULT '0',
  `retorno_promedio` float DEFAULT '0',
  `sharpe` float DEFAULT '0',
  `max_drawdown` float DEFAULT '0',
  `ts_calculo` datetime(3) DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `_backup_outcomes_20260701`
--

DROP TABLE IF EXISTS `_backup_outcomes_20260701`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `_backup_outcomes_20260701` (
  `id` bigint NOT NULL DEFAULT '0',
  `senal` enum('BUY','SELL','HOLD','ALERTA','observacion','reflexion') COLLATE utf8mb4_unicode_ci NOT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `outcome_real` enum('correcto','incorrecto','pendiente') COLLATE utf8mb4_unicode_ci DEFAULT 'pendiente',
  `precio_salida` decimal(12,4) DEFAULT NULL,
  `ts_outcome` datetime(3) DEFAULT NULL,
  `accuracy_score` float DEFAULT NULL COMMENT 'Calculado post-cierre del horizonte'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `backtesting_results`
--

DROP TABLE IF EXISTS `backtesting_results`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `backtesting_results` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `run_id` int NOT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `fecha_senal` date NOT NULL,
  `senal_predicha` enum('BUY','SELL','HOLD') COLLATE utf8mb4_unicode_ci NOT NULL,
  `confianza` float DEFAULT NULL,
  `lstm_prediccion` enum('BUY','SELL','HOLD') COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Predicci?n LSTM en el momento de la se?al',
  `precio_entrada` decimal(18,6) DEFAULT NULL,
  `precio_salida` decimal(18,6) DEFAULT NULL,
  `horizonte_horas` int DEFAULT NULL,
  `resultado` enum('correcto','incorrecto','neutral') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `retorno_pct` decimal(8,4) DEFAULT NULL COMMENT '% de ganancia o pérdida',
  PRIMARY KEY (`id`),
  KEY `idx_run_id` (`run_id`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_senal` (`senal_predicha`),
  CONSTRAINT `backtesting_results_ibfk_1` FOREIGN KEY (`run_id`) REFERENCES `backtesting_runs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `backtesting_runs`
--

DROP TABLE IF EXISTS `backtesting_runs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `backtesting_runs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `nombre` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tickers` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Array de tickers analizados',
  `fecha_desde` date NOT NULL,
  `fecha_hasta` date NOT NULL,
  `capital_inicial` decimal(18,2) DEFAULT '10000.00',
  `estado` enum('en_progreso','completado','fallido') COLLATE utf8mb4_unicode_ci DEFAULT 'en_progreso',
  `ts_inicio` datetime DEFAULT CURRENT_TIMESTAMP,
  `ts_fin` datetime DEFAULT NULL,
  `descripcion` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'GENERAL',
  `senal` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT 'HOLD',
  `confianza` decimal(5,4) DEFAULT '0.0000',
  `precio_entrada` decimal(12,4) DEFAULT NULL,
  `horizonte_horas` int DEFAULT '24',
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_estado` (`estado`),
  KEY `idx_fechas` (`fecha_desde`,`fecha_hasta`),
  CONSTRAINT `backtesting_runs_chk_1` CHECK (json_valid(`tickers`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `backtesting_stats`
--

DROP TABLE IF EXISTS `backtesting_stats`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `backtesting_stats` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fecha` date NOT NULL,
  `total_verificadas` int DEFAULT '0',
  `correctas` int DEFAULT '0',
  `incorrectas` int DEFAULT '0',
  `pendientes` int DEFAULT '0',
  `accuracy_global` float DEFAULT '0',
  `accuracy_30d` float DEFAULT '0',
  `precision_buy` float DEFAULT '0',
  `precision_sell` float DEFAULT '0',
  `retorno_promedio` float DEFAULT '0',
  `sharpe` float DEFAULT '0',
  `max_drawdown` float DEFAULT '0',
  `ts_calculo` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `retorno_dia` float DEFAULT NULL,
  `muestras_dia` int DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fecha` (`fecha`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `causal_memory`
--

DROP TABLE IF EXISTS `causal_memory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `causal_memory` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `causa` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `efecto` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `confianza` float DEFAULT '0.5',
  `repeticiones` int DEFAULT '1',
  `ultimo_refuerzo` datetime(3) DEFAULT NULL,
  `contexto` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `ts_creacion` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_causa_efecto` (`causa`(200),`efecto`(200)),
  KEY `idx_confianza` (`confianza`),
  CONSTRAINT `causal_memory_chk_1` CHECK (json_valid(`contexto`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_messages`
--

DROP TABLE IF EXISTS `chat_messages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `session_id` bigint NOT NULL,
  `rol` enum('user','miia') COLLATE utf8mb4_unicode_ci NOT NULL,
  `contenido` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `decision_id` bigint DEFAULT NULL COMMENT 'Si el mensaje incluye una recomendación',
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `decision_id` (`decision_id`),
  KEY `idx_session` (`session_id`),
  KEY `idx_ts` (`ts`),
  CONSTRAINT `chat_messages_ibfk_1` FOREIGN KEY (`session_id`) REFERENCES `chat_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chat_messages_ibfk_2` FOREIGN KEY (`decision_id`) REFERENCES `cognitive_decisions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `chat_sessions`
--

DROP TABLE IF EXISTS `chat_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `chat_sessions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_token` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ts_inicio` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `ts_fin` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `session_token` (`session_token`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `clientes`
--

DROP TABLE IF EXISTS `clientes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `clientes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `session_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pais` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pais_code` varchar(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ciudad` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `region` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `lat` float DEFAULT NULL,
  `lon` float DEFAULT NULL,
  `user_agent` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `plan` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'free',
  `primera_visita` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `ultima_visita` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `total_consultas` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_ip` (`ip`),
  KEY `idx_pais` (`pais`),
  KEY `idx_ts` (`ultima_visita`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `cognitive_decisions`
--

DROP TABLE IF EXISTS `cognitive_decisions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cognitive_decisions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `ticker` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `senal` enum('BUY','SELL','HOLD','ALERTA','observacion','reflexion') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `score` float DEFAULT NULL,
  `confianza` float DEFAULT NULL COMMENT 'float 0.0-1.0',
  `razon` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT 'Razonamiento de class25',
  `horizonte_horas` int DEFAULT '24',
  `temperatura` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'estable|alta|critica|baja',
  `n_filtros` int DEFAULT NULL COMMENT 'Cuántos filtros contribuyeron (class21-24)',
  `outcome_real` enum('correcto','incorrecto','pendiente','cancelado','descartado') COLLATE utf8mb4_unicode_ci DEFAULT 'pendiente',
  `accuracy_score` float DEFAULT NULL COMMENT 'Calculado post-cierre del horizonte',
  `hash_decision` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ts_decision` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `ts_cierre` datetime(3) DEFAULT NULL COMMENT 'Cuando se verificó el outcome',
  `precio_salida` decimal(12,4) DEFAULT NULL,
  `ts_outcome` datetime(3) DEFAULT NULL,
  `precio_entrada` decimal(12,4) DEFAULT NULL,
  `hash_condicion` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `retorno_real` float DEFAULT NULL,
  `retorno_relativo` float DEFAULT NULL,
  `label_modo` varchar(12) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_ts` (`ts_decision`),
  KEY `idx_senal` (`senal`),
  KEY `idx_outcome` (`outcome_real`),
  KEY `idx_outcome_hash` (`outcome_real`,`hash_decision`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `crisis_events`
--

DROP TABLE IF EXISTS `crisis_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crisis_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nombre` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `anio_inicio` year DEFAULT NULL,
  `anio_fin` year DEFAULT NULL,
  `fecha_inicio` date DEFAULT NULL,
  `fecha_fin` date DEFAULT NULL,
  `tipo` enum('crash_bursatil','recesion','inflacion','deflacion','pandemia','guerra','cripto','otro') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `severidad` tinyint DEFAULT NULL,
  `descripcion` text COLLATE utf8mb4_unicode_ci,
  `patron_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Patrón extraído del PDF para comparación',
  `pdf_origen` int DEFAULT NULL COMMENT 'PDF del que se extrajo',
  `ts_carga` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `pdf_origen` (`pdf_origen`),
  KEY `idx_anio` (`anio_inicio`),
  KEY `idx_tipo` (`tipo`),
  CONSTRAINT `crisis_events_ibfk_1` FOREIGN KEY (`pdf_origen`) REFERENCES `pdf_documents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `crisis_events_chk_1` CHECK ((`severidad` between 1 and 10)),
  CONSTRAINT `crisis_events_chk_2` CHECK (json_valid(`patron_json`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `learning_cycles`
--

DROP TABLE IF EXISTS `learning_cycles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `learning_cycles` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `decision_id` bigint DEFAULT NULL,
  `prediccion` float DEFAULT NULL,
  `resultado_real` float DEFAULT NULL,
  `error_delta` float DEFAULT NULL,
  `modulo` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `decision_id` (`decision_id`),
  KEY `idx_modulo` (`modulo`),
  KEY `idx_ts` (`ts`),
  CONSTRAINT `learning_cycles_ibfk_1` FOREIGN KEY (`decision_id`) REFERENCES `cognitive_decisions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `lstm_predictions`
--

DROP TABLE IF EXISTS `lstm_predictions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `lstm_predictions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ticker` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `senal` enum('BUY','SELL','HOLD') COLLATE utf8mb4_general_ci NOT NULL,
  `confianza` decimal(5,4) NOT NULL,
  `prob_buy` decimal(5,4) DEFAULT NULL,
  `prob_hold` decimal(5,4) DEFAULT NULL,
  `prob_sell` decimal(5,4) DEFAULT NULL,
  `horizonte` varchar(8) COLLATE utf8mb4_general_ci NOT NULL DEFAULT '24h',
  `precio_actual` decimal(12,4) DEFAULT NULL,
  `rsi` decimal(6,2) DEFAULT NULL,
  `macd` decimal(10,4) DEFAULT NULL,
  `bb_pct` decimal(6,4) DEFAULT NULL,
  `atr_r` decimal(8,6) DEFAULT NULL,
  `modelo_version` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `publicado` tinyint(1) NOT NULL DEFAULT '0' COMMENT '1 si se public? en Redis',
  `outcome_real` enum('correcto','incorrecto','pendiente') COLLATE utf8mb4_general_ci DEFAULT 'pendiente',
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_senal` (`senal`),
  KEY `idx_ts` (`ts`),
  KEY `idx_pub` (`publicado`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Predicciones del motor LSTM (class44.py)';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `miia_admins`
--

DROP TABLE IF EXISTS `miia_admins`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `miia_admins` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `added_by` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `miia_subscriptions`
--

DROP TABLE IF EXISTS `miia_subscriptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `miia_subscriptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `plan` enum('monthly','annual') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'monthly',
  `status` enum('pending','active','cancelled','expired') COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `mp_preference_id` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `mp_payment_id` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_uid_status` (`user_id`,`status`),
  KEY `idx_email_status` (`email`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `miia_users`
--

DROP TABLE IF EXISTS `miia_users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `miia_users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `nombre` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('active','banned') COLLATE utf8mb4_unicode_ci DEFAULT 'active',
  `consultas` int DEFAULT '0',
  `last_seen` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `noticias`
--

DROP TABLE IF EXISTS `noticias`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `noticias` (
  `id` int NOT NULL AUTO_INCREMENT,
  `titulo` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `snippet` text COLLATE utf8mb4_unicode_ci,
  `fuente` varchar(150) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sentimiento` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'NEUTRAL',
  `url` text COLLATE utf8mb4_unicode_ci,
  `imagen_url` text COLLATE utf8mb4_unicode_ci,
  `ts_publicado` datetime(3) DEFAULT NULL,
  `ts_guardado` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `hash_titulo` varchar(64) COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS (sha2(left(`titulo`,200),256)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hash` (`hash_titulo`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_ts` (`ts_guardado`),
  KEY `idx_sent` (`sentimiento`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `oauth_providers`
--

DROP TABLE IF EXISTS `oauth_providers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `oauth_providers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider_id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_provider` (`provider`,`provider_id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `pdf_documents`
--

DROP TABLE IF EXISTS `pdf_documents`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pdf_documents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nombre` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tipo` enum('crisis_historica','analisis_tecnico','noticia_mercado','libro_finanzas','macro_economico') COLLATE utf8mb4_unicode_ci NOT NULL,
  `fuente` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `fecha_documento` date DEFAULT NULL,
  `fecha_carga` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `texto_completo` longtext COLLATE utf8mb4_unicode_ci,
  `num_paginas` int DEFAULT NULL,
  `tamanio_bytes` int DEFAULT NULL,
  `hash_sha256` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'SHA256 del archivo — evita duplicados',
  `procesado` tinyint(1) DEFAULT '0' COMMENT '0=pendiente, 1=vectorizado',
  `ts_procesado` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `hash_sha256` (`hash_sha256`),
  KEY `idx_tipo` (`tipo`),
  KEY `idx_procesado` (`procesado`),
  KEY `idx_fecha` (`fecha_carga`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `pdf_fragments`
--

DROP TABLE IF EXISTS `pdf_fragments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pdf_fragments` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `pdf_id` int NOT NULL,
  `numero_fragmento` int NOT NULL,
  `texto` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `num_tokens` int DEFAULT NULL,
  `vectorizado` tinyint(1) DEFAULT '0',
  `vector_id` bigint DEFAULT NULL COMMENT 'FK a knowledge_vectors una vez procesado',
  `ts_creacion` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_pdf_id` (`pdf_id`),
  KEY `idx_vectorizado` (`vectorizado`),
  CONSTRAINT `pdf_fragments_ibfk_1` FOREIGN KEY (`pdf_id`) REFERENCES `pdf_documents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `performance_snapshots`
--

DROP TABLE IF EXISTS `performance_snapshots`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `performance_snapshots` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `fecha` date NOT NULL,
  `total_decisiones` int DEFAULT '0',
  `decisiones_correctas` int DEFAULT '0',
  `accuracy_pct` float DEFAULT NULL,
  `sharpe_ratio` float DEFAULT NULL,
  `coherencia_promedio` float DEFAULT NULL,
  `temperatura_dominante` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pdfs_procesados` int DEFAULT '0',
  `vectores_totales` int DEFAULT '0',
  `ts_calculo` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_fecha` (`fecha`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `portfolio_assets`
--

DROP TABLE IF EXISTS `portfolio_assets`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `portfolio_assets` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `portfolio_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `symbol` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sector` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `score` decimal(5,4) DEFAULT '0.0000',
  `momentum` decimal(5,4) DEFAULT '0.0000',
  `riesgo` decimal(5,4) DEFAULT '0.5000',
  `confianza` decimal(5,4) DEFAULT '0.0000',
  `peso` decimal(5,4) DEFAULT '0.0000',
  `precio_entrada` decimal(12,4) DEFAULT NULL,
  `change_pct` decimal(8,4) DEFAULT '0.0000',
  `estado_sector` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'neutral' COMMENT 'up | down | neutral ? estado del sector en el momento',
  `diversificacion` decimal(5,4) DEFAULT '0.0000' COMMENT 'peso de diversificacion calculado por class15',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_port_ticker` (`portfolio_id`,`ticker`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_portfolio_id_str` (`portfolio_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `portfolio_transactions`
--

DROP TABLE IF EXISTS `portfolio_transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `portfolio_transactions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `portfolio_id` varchar(50) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'ref a portfolios.portfolio_id',
  `user_id` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tipo` varchar(30) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'lifecycle_event' COMMENT 'lifecycle_event | rebalance | risk_alert',
  `evento` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'nombre del evento',
  `razon` varchar(200) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'razon del evento',
  `status` varchar(30) COLLATE utf8mb4_general_ci DEFAULT 'stable',
  `confidence` decimal(5,4) DEFAULT '0.0000',
  `risk_level` decimal(5,4) DEFAULT '0.5000',
  `detalle` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'payload extra del lifecycle',
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_portfolio` (`portfolio_id`),
  KEY `idx_tipo` (`tipo`),
  KEY `idx_ts` (`ts`),
  CONSTRAINT `portfolio_transactions_chk_1` CHECK (json_valid(`detalle`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Historial de eventos de ciclo de vida de portafolios (class17 ? class42)';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `portfolios`
--

DROP TABLE IF EXISTS `portfolios`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `portfolios` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'general',
  `descripcion` text COLLATE utf8mb4_unicode_ci,
  `portfolio_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `strategy` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'balanced',
  `status` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT 'stable',
  `confidence` decimal(5,4) DEFAULT '0.0000',
  `risk_level` decimal(5,4) DEFAULT '0.5000',
  `riesgo_global` decimal(5,4) DEFAULT '0.5000',
  `n_activos` int DEFAULT '0',
  `market_ts` datetime(3) DEFAULT NULL,
  `provider` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `interes_diario_pct` decimal(10,4) DEFAULT NULL,
  `interes_mensual_pct` decimal(10,4) DEFAULT NULL,
  `interes_anual_pct` decimal(10,4) DEFAULT NULL,
  `ts_interes` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `portfolio_id` (`portfolio_id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `precios`
--

DROP TABLE IF EXISTS `precios`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `precios` (
  `id` int NOT NULL AUTO_INCREMENT,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sector` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `precio` decimal(12,4) DEFAULT NULL,
  `change_pct` decimal(8,4) DEFAULT NULL,
  `riesgo` decimal(6,4) DEFAULT NULL,
  `score` decimal(6,4) DEFAULT NULL,
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ticker_ts` (`ticker`,`ts`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `sentiment_signals`
--

DROP TABLE IF EXISTS `sentiment_signals`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sentiment_signals` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `ticker` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `senal` enum('BUY','SELL','HOLD') COLLATE utf8mb4_general_ci NOT NULL,
  `sentiment_label` enum('BULLISH','BEARISH','NEUTRAL') COLLATE utf8mb4_general_ci NOT NULL,
  `sentiment_score` decimal(6,4) NOT NULL,
  `confianza` decimal(5,4) NOT NULL,
  `n_articulos` smallint unsigned NOT NULL DEFAULT '0',
  `publicado` tinyint(1) NOT NULL DEFAULT '0',
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `keywords_json` text COLLATE utf8mb4_general_ci,
  `precio_entrada` decimal(12,4) DEFAULT NULL,
  `outcome_real` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ts_outcome` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Se?ales de sentimiento de noticias (class45.js)';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `signals_feed`
--

DROP TABLE IF EXISTS `signals_feed`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `signals_feed` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `senal` enum('BUY','SELL','HOLD','ALERTA') COLLATE utf8mb4_unicode_ci NOT NULL,
  `confianza` float DEFAULT NULL,
  `signal_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `portfolio_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `horizonte_horas` int DEFAULT '24',
  `stop_loss` decimal(12,4) DEFAULT NULL,
  `riesgo` decimal(5,4) DEFAULT '0.5000',
  `texto` text COLLATE utf8mb4_unicode_ci,
  `fuente` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT 'class25B',
  PRIMARY KEY (`id`),
  KEY `idx_user_ts` (`user_id`),
  KEY `idx_ticker` (`ticker`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `subscriptions`
--

DROP TABLE IF EXISTS `subscriptions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `subscriptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `plan` enum('free','pro','enterprise') COLLATE utf8mb4_unicode_ci NOT NULL,
  `estado` enum('activa','cancelada','vencida','trial') COLLATE utf8mb4_unicode_ci DEFAULT 'trial',
  `precio_mensual` decimal(10,2) DEFAULT NULL,
  `moneda` char(3) COLLATE utf8mb4_unicode_ci DEFAULT 'USD',
  `external_id` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID en Stripe / MercadoPago',
  `ts_inicio` datetime DEFAULT CURRENT_TIMESTAMP,
  `ts_vencimiento` datetime DEFAULT NULL,
  `ts_cancelacion` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_estado` (`estado`),
  KEY `idx_vencimiento` (`ts_vencimiento`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `system_events`
--

DROP TABLE IF EXISTS `system_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `modulo` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `evento` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `nivel` enum('INFO','WARN','ERROR','FATAL') COLLATE utf8mb4_unicode_ci DEFAULT 'INFO',
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_modulo` (`modulo`),
  KEY `idx_nivel` (`nivel`),
  KEY `idx_ts` (`ts`),
  CONSTRAINT `system_events_chk_1` CHECK (json_valid(`payload`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `system_log`
--

DROP TABLE IF EXISTS `system_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `fuente` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'class44, class45, class25B, etc.',
  `nivel` enum('debug','info','warn','error','fatal') COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'info',
  `canal_redis` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Canal Redis origen del evento',
  `evento` varchar(128) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Nombre corto del evento',
  `mensaje` text COLLATE utf8mb4_general_ci NOT NULL COMMENT 'Mensaje legible',
  `detalle` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Payload JSON estructurado',
  `stack_trace` text COLLATE utf8mb4_general_ci COMMENT 'Stack trace si es error',
  `ticker` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'Ticker de mercado si aplica',
  `sesion_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_fuente` (`fuente`),
  KEY `idx_nivel` (`nivel`),
  KEY `idx_ts` (`ts`),
  KEY `idx_ticker` (`ticker`),
  CONSTRAINT `system_log_chk_1` CHECK (json_valid(`detalle`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Log centralizado del sistema MIIA ? todos los motores';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `telegram_alerts_sent`
--

DROP TABLE IF EXISTS `telegram_alerts_sent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `telegram_alerts_sent` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `chat_id` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `ticker` varchar(16) COLLATE utf8mb4_general_ci NOT NULL,
  `fuente` varchar(32) COLLATE utf8mb4_general_ci NOT NULL COMMENT 'class44, class45, class25',
  `senal` enum('BUY','SELL','HOLD') COLLATE utf8mb4_general_ci NOT NULL,
  `confianza` decimal(5,4) NOT NULL,
  `mensaje` text COLLATE utf8mb4_general_ci NOT NULL,
  `enviado_ok` tinyint(1) NOT NULL DEFAULT '1',
  `error_msg` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ts` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ticker` (`ticker`),
  KEY `idx_chat` (`chat_id`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Historial de alertas Telegram enviadas (class47.js)';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_actions`
--

DROP TABLE IF EXISTS `user_actions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_actions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `decision_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `senal` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `accion` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `confianza` float DEFAULT NULL,
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_decid` (`decision_id`),
  KEY `idx_accion` (`accion`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_decisions`
--

DROP TABLE IF EXISTS `user_decisions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_decisions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `decision_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `senal` varchar(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ticker` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `confianza` float DEFAULT NULL,
  `texto` text COLLATE utf8mb4_unicode_ci,
  `vista` tinyint(1) DEFAULT '0',
  `ts` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_profiles`
--

DROP TABLE IF EXISTS `user_profiles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_profiles` (
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `nivel_experiencia` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'intermedio',
  `tolerancia_riesgo` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'moderado',
  `sectores_seguidos` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `interacciones` int DEFAULT '0',
  `decisiones_vistas` int DEFAULT '0',
  `ultima_interaccion` datetime(3) DEFAULT NULL,
  `preferencias` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `ts_creacion` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `nivel_conocimiento` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'principiante',
  `capital_disponible` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `onboarding_ok` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`user_id`),
  CONSTRAINT `user_profiles_chk_1` CHECK (json_valid(`sectores_seguidos`)),
  CONSTRAINT `user_profiles_chk_2` CHECK (json_valid(`preferencias`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `user_settings`
--

DROP TABLE IF EXISTS `user_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_settings` (
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `confianza_min_alerta` float DEFAULT '0.7' COMMENT 'Solo alertar si confianza > este valor',
  `activos_seguidos` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT 'Array de tickers favoritos',
  `notif_email` tinyint(1) DEFAULT '1',
  `notif_telegram` tinyint(1) DEFAULT '0',
  `telegram_chat_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `idioma` char(5) COLLATE utf8mb4_unicode_ci DEFAULT 'es',
  `tema_ui` enum('dark','light') COLLATE utf8mb4_unicode_ci DEFAULT 'dark',
  `ts_actualizado` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `user_settings_chk_1` CHECK (json_valid(`activos_seguidos`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` char(60) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'bcrypt',
  `nombre` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `plan` enum('free','pro','enterprise') COLLATE utf8mb4_unicode_ci DEFAULT 'free',
  `api_key` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Generada al registrarse',
  `activo` tinyint(1) DEFAULT '1',
  `ts_registro` datetime DEFAULT CURRENT_TIMESTAMP,
  `ts_ultimo_acceso` datetime DEFAULT NULL,
  `user_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'ID OAuth (google_xxx) ? clase14 y clase42',
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `plan_vencimiento` datetime(3) DEFAULT NULL,
  `ts_creacion` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `ts_ultimo_login` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `api_key` (`api_key`),
  UNIQUE KEY `user_id` (`user_id`),
  KEY `idx_email` (`email`),
  KEY `idx_api_key` (`api_key`),
  KEY `idx_users_uid` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping events for database 'miia_cognitiva'
--

--
-- Dumping routines for database 'miia_cognitiva'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
