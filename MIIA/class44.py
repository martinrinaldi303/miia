#!/usr/bin/env python3
"""
class44.py — Motor LSTM Predictivo de Mercado (MIIA v2.1)

CAMBIOS v2.1 para apuntar al 70-80% de accuracy:

  1. DATOS EN TIEMPO REAL (antes: solo datos diarios "1d")
     Ahora entrena con barras de 1 HORA ("1h") de los últimos 2 años.
     2 años × 252 días × 6.5h mercado = ~3276 barras por ticker
     (vs 504 barras diarias antes → 6.5x más datos de entrenamiento)
     Las barras horarias capturan patrones intradiarios que los datos
     diarios pierden completamente.

  2. CLASS_WEIGHT para corregir desbalance de clases
     Con umbral ±1% en datos DIARIOS: BUY=19%, HOLD=62%, SELL=19%
     Con umbral ±0.5% en datos HORARIOS: BUY≈30%, HOLD≈40%, SELL≈30%
     CrossEntropyLoss sin class_weight aprende a decir HOLD todo el tiempo.
     Ahora: class_weight proporcional a la inversa de la frecuencia de cada clase.
     La red aprende a discriminar BUY y SELL correctamente.

  3. UMBRAL DINÁMICO por ticker (antes: ±1% fijo para todos)
     XLK (tech) es más volátil que XLU (utilities).
     Ahora: umbral = 0.5 × σ_diaria del ticker (calculado en los datos).
     Señales más calibradas a la volatilidad real de cada ETF.

  4. FEATURES ADICIONALES para datos horarios (+8 features, total 28):
     - vwap_r: precio vs VWAP (muy útil en horario)
     - ret1h: retorno de la última hora
     - ret4h: retorno de las últimas 4 horas
     - gap_open: gap entre cierre anterior y apertura
     - hour_sin / hour_cos: hora del día codificada cíclicamente
     - day_sin / day_cos: día de la semana codificado cíclicamente
     La codificación cíclica permite a la LSTM aprender patrones
     por hora del día y día de la semana sin discontinuidades.

  5. ARQUITECTURA MEJORADA para secuencias más largas
     WINDOW: 60 barras (antes 60 diarias ≈ 3 meses)
             Ahora 60 horarias ≈ 2 semanas de mercado
     Hidden: 256 (antes 128) — más capacidad para secuencias horarias
     Dropout: 0.30 (antes 0.25) — más regularización con más datos

  6. PREDICCIÓN EN TIEMPO REAL cada 15 min (sin cambio de intervalo)
     Descarga las últimas 3 semanas de datos horarios para predicción
     (en lugar de 6 meses de datos diarios)

  7. REENTRENAMIENTO cada 3 días (antes 7)
     Con datos horarios, el modelo puede actualizarse más frecuentemente
     sin costo adicional significativo de tiempo de entrenamiento.
"""

import os
import sys
import json
import time
import signal
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd
import redis
import yfinance as yf
import torch
import torch.nn as nn

# Limitar los hilos de PyTorch. "cpu_count - 1" se escribió cuando MIIA era un
# puñado de procesos: con 6 núcleos deja 5 para el training y 1 para TODO el
# resto — 39 procesos entre Node, C++, Python y .NET, más mysqld. Medido el
# 15-ago-2026: con MySQL saturando 5 núcleos, class44 quedaba clavado en 1 y el
# backlog de reentrenamientos crecía sin parar (20 → 337 outcomes en cola).
# Un tercio de la máquina es suficiente para entrenar y deja la cadena viva.
# CLASS44_HILOS lo fija a mano (25-nov-2026: la CPU del server está al límite y
# Ollama, que atiende el chat, necesita 4 núcleos libres para contestar a tiempo).
try:
    _HILOS = int(os.environ.get("CLASS44_HILOS", "0"))
except ValueError:
    _HILOS = 0
torch.set_num_threads(_HILOS if _HILOS >= 1 else max(1, (os.cpu_count() or 2) // 3))
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import MinMaxScaler
import joblib
import ta

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).resolve().parent.parent / "operador" / "aprendizaje"
MODELS_DIR = BASE_DIR / "models" / "lstm"
LOGS_DIR   = BASE_DIR / "logs"
STATE_DIR  = BASE_DIR / "state"

for _d in [MODELS_DIR, LOGS_DIR, STATE_DIR]:
    _d.mkdir(parents=True, exist_ok=True)

# ── Logger ─────────────────────────────────────────────────────────────────────
LOG_FILE = LOGS_DIR / "class44.log"
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [class44/%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("class44")

# ── Configuración ──────────────────────────────────────────────────────────────
REDIS_URL     = os.environ.get("REDIS_URL", "redis://localhost:6379")
CH_OUT_LSTM   = "class44_output"
CH_OUT_CRISIS = "class40_output"
CH_ESTADO     = "class44_estado"
CH_SENT       = "class45_output"   # sentimiento por ticker (corroboración SELL)
CH_RISK       = "class41_output"   # riesgo de mercado (corroboración SELL)
# class43 publica outcomes reales de cada señal verificada
CH_FEEDBACK   = "class24_feedback"   # {ticker, outcome, retorno_pct, ts}

# Reentrenar un ticker cuando acumula N outcomes nuevos desde el último train
FEEDBACK_RETRAIN_THRESHOLD = 20

# Piso de tiempo entre reentrenamientos guiados de un MISMO ticker.
#
# FEEDBACK_RETRAIN_THRESHOLD=20 se calibró cuando el sistema emitía ~1 decisión
# por ventana: 20 outcomes por ticker tardaban días en juntarse y la cola del
# _TRAIN_GATE quedaba vacía casi todo el tiempo. Con ORDEN 1 son 13 decisiones
# por ventana, el umbral se alcanza en horas para los 13 tickers a la vez, y el
# semáforo —que evita el entrenamiento PARALELO, no el CONTINUO— pasa a tener
# siempre a alguien esperando.
#
# Medido el 15-ago-2026: 16 reentrenamientos guiados con el backlog creciendo
# (20 → 174 → 194 → 312 → 337 outcomes), o sea que ya no llegaba a drenar.
#
# El piso es temporal y no por volumen a propósito: si mañana el caudal vuelve a
# cambiar, un umbral de conteo se descalibra igual que se descalibró éste.
# RETRAIN_DAYS=7 gobierna el reentrenamiento programado; esto gobierna el
# guiado, que es el que ORDEN 1 multiplicó.
FEEDBACK_RETRAIN_MIN_H = 24
# 25-nov-2026: con 50 modelos y un piso de 24 h había ~50 entrenamientos por día:
# class44 tenía 2 núcleos ocupados casi todo el tiempo (top: ~200 % de CPU) y le
# quitaba la CPU a Ollama, que atiende el chat. class44 está en SOMBRA (no vota),
# así que entrenar menos no cambia ninguna decisión. Ahora el piso es de 7 días
# (igual que RETRAIN_DAYS): ~7 entrenamientos por día en vez de ~50.
# Reversa sin tocar código: CLASS44_RETRAIN_MIN_H=24.
try:
    FEEDBACK_RETRAIN_MIN_H = float(os.environ.get("CLASS44_RETRAIN_MIN_H", "168"))
except ValueError:
    FEEDBACK_RETRAIN_MIN_H = 168.0

# Semáforo global: serializa el entrenamiento de los 7 modelos. En un VPS de 1 CPU,
# entrenarlos en paralelo (7 hilos) satura CPU/RAM y hace thrashing → nunca terminan.
# Con el semáforo entrenan de a uno (cola), lento pero estable y sí completan.
_TRAIN_GATE = threading.Semaphore(1)

# ── QUÉ MODELA class44: los 50 del universo (10-oct-2026) ──────────────────
#
# Historia corta: eran 7, pasó a 13, y desde el 10-oct son los 50 — decidido por
# Martín, para que el LSTM tenga la misma cobertura que el resto del sistema y
# para que, de acá a unos meses, si en producción se despega del azar, se lo
# pueda conectar como votante de class25A. La asimetría importaba justo por eso:
# con la etiqueta de ORDEN 1 —"¿este instrumento le gana al promedio?"— unos
# tickers con aportante LSTM y otros sin él no son comparables.
#
# ⚠️ LA CUENTA DE RAM QUE ESTABA ACÁ ESTABA MAL, y por eso esto no se hizo antes.
# Decía "~3,85× los modelos, entre 1,5 y 2 GB más", suponiendo que los 1.526 MB
# de RSS de class44 escalan con la cantidad de modelos. NO escalan: son la línea
# de base de PyTorch, que es FIJA. Medido en producción el 21 y el 22-sep, sin
# reentrenamientos: creció 6 MB un día y bajó 3 MB el otro, con 13 modelos
# cargados. La arquitectura de LSTMPredictor son 498.947 parámetros —
# 4·256·(28+256) + 4·128·(256+128) + los dos Linear, más los bias— o sea
# **1,90 MB en float32 por modelo**: 24,7 MB los 13 y 95,2 MB los 50.
#
#   Pasar de 13 a 50 modelos cargados cuesta 70 MB, no 2 GB.
#
# EL COSTO REAL es otro, y es el que resuelve la rotación de PRED_POR_CICLO:
# predecir() baja datos de Yahoo en CADA predicción (ver `_descargar`), no sólo
# al entrenar. Ver el comentario de PRED_POR_CICLO, más abajo.
#
# El arranque NO necesita nada nuevo: los que no tienen modelo en disco entrenan
# solos, y `_TRAIN_GATE` (semáforo de 1) ya los serializa, descarga incluida —
# así que no hay 37 descargas simultáneas ni 37 datasets en memoria a la vez.
# Lo que hay es tiempo: 37 entrenamientos en fila, cada uno bajando 2 años de
# barras horarias. Tarda un día o dos y los 13 que ya tienen .pt siguen
# prediciendo normal mientras los nuevos se van sumando de a uno. `_training` se
# marca ANTES del acquire(), así que los 37 que esperan turno quedan fuera del
# ciclo de predicción y no consumen lugar en la rotación.
#
# Lo que sigue pendiente, y es la CONDICIÓN para conectarlo a class25A:
# `lstm_predictions` tiene 73.325 filas y ninguna con `outcome_real`. El camino
# existe —`_feedback_listener` ya recibe el ticker y el retorno real de class43
# por `class24_feedback`— pero sólo se usa la LONGITUD del buffer para decidir
# cuándo reentrenar: el resultado se tira. Sin aparearlo contra la predicción que
# se hizo, en unos meses no hay con qué contestar "¿mejoró del azar?". Y un
# val_loss por debajo de ln 3 = 1,0986 NO sirve como prueba: es la validación de
# su propio split, ya pasó dos veces con XLK (1,0428 el 30-sep y 1,0384 el 3-oct)
# y no significó nada en producción.
# FUENTE ÚNICA del universo (21-sep-2026). Ver MIIA/universo.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from universo import TICKERS_LSTM as _LSTM, TICKERS as _UNIVERSO
from rotacion import proximo_lote, ciclos_por_ronda, descargas_por_dia
from marcador import Marcador
TICKERS = list(_LSTM)
if len(TICKERS) != len(_UNIVERSO):
    log.warning(
        "class44 modela %d de %d instrumentos (lista `lstm` de universo.json). "
        "Los %d que faltan NO tienen predicción LSTM, y con la etiqueta de "
        "ORDEN 1 eso los vuelve no comparables con los que sí la tienen. Hoy "
        "class25A lo tolera porque el LSTM está en sombra (peso 1e-323); el día "
        "que se lo active en el ensemble, esta asimetría invalida la comparación "
        "entre instrumentos y hay que ampliar la lista PRIMERO.",
        len(TICKERS), len(_UNIVERSO), len(_UNIVERSO) - len(TICKERS))
else:
    log.info("class44 modela los %d instrumentos del universo, sin asimetría",
             len(TICKERS))

# v2.1: barras horarias para entrenamiento
INTERVALO_TRAIN    = "1h"        # antes "1d"
PERIODO_TRAIN      = "2y"        # 2 años de datos horarios
PERIODO_PRED       = "2mo"       # 2 meses → ~260 barras horarias (antes "3wk"=105 < WINDOW+100=160)

WINDOW             = 60          # barras de lookback (60h ≈ 2 semanas)
PRED_INTERVAL      = 15 * 60     # predicción cada 15 min
ESTADO_INTERVAL    = 5  * 60     # estado cada 5 min
RETRAIN_DAYS       = 7           # reentrenar cada 7 días (menos carga en el VPS)

# ── Rotación de predicciones (10-oct-2026, con el universo en 50) ──────────
#
# `predecir()` llama a `_descargar()`, o sea a `yf.download`, en CADA predicción
# y no sólo al entrenar. El ciclo es SERIAL y cada descarga tiene timeout=30.
# Con 50 tickers y PRED_INTERVAL de 15 min eso serían 4.800 descargas de Yahoo
# por día (con 13 eran 1.248) y un ciclo que en el peor caso tarda 25 min contra
# un intervalo de 15. No hay limiter, ni caché, ni manejo de 429: una descarga
# fallida devuelve None y el ticker se saltea en silencio. Es el mismo defecto
# de cuota que el corte arregló en class7, donde la lección fue que el promedio
# no protege: protege el tope.
#
# La asimetría que lo resuelve: la barra es HORARIA y el ciclo es de 15 min, así
# que 3 de cada 4 descargas traen la misma barra y el modelo recibe la misma
# entrada. Predecir los 50 en cada ciclo es pagar cuatro veces lo mismo.
#
# Con 13 por ciclo cada ticker se predice una vez por hora y el gasto queda
# idéntico al de 13 tickers cada 15 min: 1.248 descargas/día, ~1.200 mensajes
# diarios a class44_output y 6,5 min de ciclo en el peor caso. Lo último importa
# para el panel: la grilla se llena del historial de class46, que son 10
# mensajes por canal, así que lo que no se puede bajar es el CAUDAL del bus.
# Mismo patrón que la rotación de class1 para las noticias.
#
#   0 (o >= cuántos modelos haya listos) = sin rotación, el camino de antes.
PRED_POR_CICLO = int(os.getenv("CLASS44_PRED_POR_CICLO", "13"))

# ── Prioridad de entrenamiento por rendimiento (10-oct-2026) ──────────
#
# Pedido de Martín: que el esfuerzo vaya a los modelos que le están ganando al
# promedio. VA ACÁ Y NO EN LAS PREDICCIONES, y la diferencia no es de forma:
#
#   · Darle más turnos de PREDICCIÓN a los que vienen ganando sesga la muestra
#     que después se usa para medir si el LSTM sirve: es seleccionar por
#     rendimiento pasado y medir el agregado sobre lo seleccionado — el mismo
#     mecanismo del gate de SELL de class25B, que dejó a las redes aprendiendo
#     sólo de las BUY. Y es circular: el número que queremos leer en unos meses
#     para decidir si vota en class25A quedaría contaminado por la regla que lo
#     generó. Además el rank IC necesita la sección transversal COMPLETA en
#     cada ventana. Por eso la rotación de arriba es pareja y no se toca.
#   · El ENTRENAMIENTO no produce filas medidas, y ahí sí hay un recurso
#     escaso: `_TRAIN_GATE` es un semáforo de 1 y con 50 tickers la cola es
#     larga.
#
# Arranca APAGADO porque hoy no hay un solo ticker con muestra: la condición
# para prenderlo es que el marcador tenga tickers con n >= min_n. Encenderlo
# antes es ordenar ruido, que es lo que les pasó a las seis claves de peso que
# "destacaron" y rotaron en tres meses y medio.
#
# Y es auto-limitado por diseño: SÓLO afecta a los tickers que ya tienen
# muestra suficiente, y lo único que hace es pedirle más outcomes al que no
# demostró ventaja antes de gastarle un turno. Nunca congela a nadie.
PRIORIDAD_ENTRENO = os.getenv("CLASS44_PRIORIDAD_ENTRENO", "0") == "1"
PRIORIDAD_FACTOR  = float(os.getenv("CLASS44_PRIORIDAD_FACTOR", "2.0"))
MARCADOR_MIN_N    = int(os.getenv("CLASS44_MARCADOR_MIN_N", "30"))
CONF_UMBRAL        = 0.40        # confianza mínima para publicar (bajado de 0.60 → 0.40)
# ── Gate asimétrico del SELL (umbral dinámico, auto-calibrado en el reentreno) ──
# En un mercado alcista el edge honesto vive SOLO en los SELL: un SELL de baja
# convicción (prob_sell apenas gana el argmax) tiene <50% de acierto y DESTRUYE
# edge. El piso arranca fijo y cada reentreno lo re-calibra sobre el set de
# validación (SIN censura: ve todos los candidatos, no solo los que pasaron el
# gate anterior) buscando la precisión objetivo con volumen suficiente, con EMA
# y clamp de seguridad. Ver _calibrar_sell_umbral().
SELL_CONF_MIN      = 0.55        # piso inicial del gate SELL (se auto-calibra al entrenar)
SELL_CONF_BAND     = (0.45, 0.65)  # clamp de seguridad del umbral dinámico [lo, hi]
SELL_CALIB_TARGET  = 0.55        # precisión SELL objetivo en el set de validación
SELL_CALIB_MIN_N   = 20          # mín. candidatos SELL en validación para mover el umbral
SELL_CALIB_EMA     = 0.5         # amortiguación: peso del corte nuevo vs el previo (0..1)
# ── Corroboración multi-motor del SELL (veto por contradicción) ──
# Un SELL que pasó el gate de confianza se VETA (→ HOLD) si otro motor lo
# contradice con datos FRESCOS: class45 (sentimiento del ticker claramente
# alcista) o class41 (riesgo de mercado LOW → mercado tranquilo, SELL poco
# probable). Fail-open: si el dato falta o está viejo NO veta, así una caída de
# class45/41 nunca apaga todos los SELL. Sube precisión sin exigir cobertura densa.
SELL_CORROBORA      = True         # activar/desactivar el gate de corroboración
SELL_CORR_TTL_S     = 3 * 3600     # antigüedad máx. del dato corroborante (3h)
SELL_SENT_BULL_VETO = 0.15         # sentiment_score >= esto (BULLISH) → veta el SELL
# 25-nov-2026: la MISMA pregunta que verifica class43. Antes class44 aprendía
# «¿el precio sube en 4 horas?» (absoluto) y class43 verifica «¿le ganó al
# promedio del universo?» (relativo, ORDEN 1): el LSTM nunca se entrenó en la
# pregunta de MIIA, y su marcador lo medía en otra. Ahora la etiqueta es el
# retorno a HORIZONTE_BARRAS menos el promedio equiponderado de los 50 ETFs en
# esas mismas barras (ver _benchmark_fwd).
# Horizonte: las BUY/SELL que emite el ranking tienen confianza > 0,65 → class43
# las verifica a 24 h, o sea UNA rueda. En barras horarias de Yahoo una rueda del
# NYSE son 7 barras (9:30 … 15:30), así que relativa = 7 barras.
# class44 SIGUE EN SOMBRA: no vota en class25A, no cambia ninguna decisión.
# Reversa: CLASS44_ETIQUETA=absoluta (vuelve a 4 barras absolutas).
ETIQUETA_RELATIVA  = os.environ.get("CLASS44_ETIQUETA", "relativa").strip().lower() != "absoluta"
try:
    _H_REL = int(os.environ.get("CLASS44_HORIZONTE_BARRAS", "7"))
except ValueError:
    _H_REL = 7
HORIZONTE          = f"{_H_REL}h" if ETIQUETA_RELATIVA else "4h"   # barras horarias
# Lo que se guarda con cada modelo: un modelo entrenado con otra pregunta no se
# compara con el nuevo ni se conserva (ver necesita_reentrenamiento y entrenar).
ETIQUETA_ID        = f"{'relativa' if ETIQUETA_RELATIVA else 'absoluta'}_{HORIZONTE}"
# Barras hacia adelante para la ETIQUETA = MISMO horizonte que trackea class43.
# 1 barra = 1h (INTERVALO_TRAIN="1h"), así que "4h" → 4 barras. Antes la etiqueta
# miraba 1 barra (1h) mientras class43 medía el resultado a 4h → un acierto
# direccional a 1h igual perdía plata en el hold real. Ahora coinciden.
HORIZONTE_BARRAS   = int(HORIZONTE.replace("h", "")) or 1   # 4

# Entrenamiento
BATCH_SIZE  = 64    # más grande con más datos
EPOCHS      = 150   # más épocas con más datos
LR          = 5e-4  # lr más bajo para convergencia estable
EARLY_STOP  = 15    # paciencia mayor

# Version de arquitectura/features. Se guarda en el checkpoint y `cargar()`
# rechaza los que no coinciden. Hace falta porque el arreglo de la lstm2 NO
# cambia ninguna forma del state_dict (lstm2 sigue siendo LSTM(256,128)): sin
# este guardia, los .pt viejos cargarian sin error con pesos sin sentido.
#   v1 = lstm2 sobre 1 paso + features de precio crudo
#   v2 = lstm2 sobre la secuencia completa + features estacionarios + VWAP real
ARCH_VERSION = 2

# ── Features (28 en total, vs 20 antes) ───────────────────────────────────────
FEATURE_COLS = [
    # OHLCV normalizados (5)
    "close_n", "open_n", "high_n", "low_n", "vol_n",
    # Momentum (8)
    "rsi", "macd", "macd_signal", "macd_hist",
    "stoch_k", "stoch_d", "mom10", "ret5",
    # Volatilidad / Bandas (3)
    "bb_pct", "bb_width", "atr_r",
    # Tendencia (3)
    "ema9_r", "ema21_r", "ema50_r",
    # Volumen (1)
    "obv_n",
    # NUEVOS para datos horarios (8)
    "vwap_r",    # precio vs VWAP
    "ret1h",     # retorno última hora
    "ret4h",     # retorno últimas 4 horas
    "gap_open",  # gap apertura vs cierre anterior
    "hour_sin",  # hora del día (sin)
    "hour_cos",  # hora del día (cos)
    "day_sin",   # día de la semana (sin)
    "day_cos",   # día de la semana (cos)
]
N_FEATURES = len(FEATURE_COLS)  # 28


# ── Arquitectura LSTM v2.1 ─────────────────────────────────────────────────────
class LSTMPredictor(nn.Module):
    """2-layer LSTM → Dense(64) → Dense(3). Hidden=256 para datos horarios."""

    def __init__(self, n_features: int = N_FEATURES, hidden: int = 256):
        super().__init__()
        self.lstm1 = nn.LSTM(n_features, hidden, batch_first=True)
        self.drop1 = nn.Dropout(0.30)
        self.lstm2 = nn.LSTM(hidden, 128, batch_first=True)
        self.drop2 = nn.Dropout(0.30)
        self.fc1   = nn.Linear(128, 64)
        self.bn1   = nn.BatchNorm1d(64)   # BatchNorm para estabilizar entrenamiento
        self.relu  = nn.ReLU()
        self.fc2   = nn.Linear(64, 3)     # logits: [SELL=0, HOLD=1, BUY=2]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # ANTES: se tomaba out[:, -1, :] tras lstm1 y se re-envolvia como
        # secuencia de largo 1, asi que lstm2 recibia UN solo paso temporal.
        # Una LSTM sobre un paso no tiene dinamica que modelar: degeneraba en
        # una densa con compuertas y la red era, de hecho, de una sola capa.
        out, _ = self.lstm1(x)              # (B, T, 256)
        out    = self.drop1(out)            # (B, T, 256)  ← secuencia completa
        out, _ = self.lstm2(out)            # (B, T, 128)
        out    = self.drop2(out[:, -1, :])  # (B, 128)     ← ultimo paso recien aca
        out    = self.relu(self.bn1(self.fc1(out)))
        return self.fc2(out)


# ── Ingeniería de features v2.1 ────────────────────────────────────────────────
def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    """28 features para datos horarios OHLCV."""
    c = df["Close"].astype(float)
    h = df["High"].astype(float)
    l = df["Low"].astype(float)
    v = df["Volume"].astype(float)
    o = df["Open"].astype(float)

    # ── Indicadores técnicos (igual que v2.0) ─────────────────────────────────
    df["rsi"]         = ta.momentum.RSIIndicator(c, 14).rsi()
    _macd             = ta.trend.MACD(c)
    df["macd"]        = _macd.macd()
    df["macd_signal"] = _macd.macd_signal()
    df["macd_hist"]   = _macd.macd_diff()
    df["stoch_k"]     = ta.momentum.StochasticOscillator(h, l, c, 14, 3).stoch()
    df["stoch_d"]     = ta.momentum.StochasticOscillator(h, l, c, 14, 3).stoch_signal()
    df["mom10"]       = ta.momentum.ROCIndicator(c, 10).roc()
    df["ret5"]        = c.pct_change(5)

    _bb               = ta.volatility.BollingerBands(c, 20, 2)
    df["bb_pct"]      = _bb.bollinger_pband()
    df["bb_width"]    = _bb.bollinger_wband()
    _atr              = ta.volatility.AverageTrueRange(h, l, c, 14).average_true_range()
    df["atr_r"]       = _atr / c.replace(0, np.nan)

    df["ema9_r"]      = ta.trend.EMAIndicator(c, 9).ema_indicator()  / c.replace(0, np.nan)
    df["ema21_r"]     = ta.trend.EMAIndicator(c, 21).ema_indicator() / c.replace(0, np.nan)
    df["ema50_r"]     = ta.trend.EMAIndicator(c, 50).ema_indicator() / c.replace(0, np.nan)
    # ── Niveles crudos → ratios estacionarios ─────────────────────────────────
    # ANTES estas seis columnas eran el precio y el volumen TAL CUAL (el sufijo
    # _n mentia). Con MinMaxScaler ajustado al primer 80% cronologico —o sea a
    # datos de hace ~2 anios— cualquier precio actual por encima de aquel maximo
    # escala a >1: fuera del rango que la red vio jamas. En un ETF con dos anios
    # de mercado alcista eso no es un riesgo, es una certeza. `obv_n` era peor:
    # acumulado monotono, siempre fuera de rango.
    # Se eligio geometria INTRABARRA en vez de c/ema21: eso ultimo es exactamente
    # 1/ema21_r, un feature que ya estaba en la lista — habria gastado un slot en
    # un duplicado. La forma de la vela, en cambio, es informacion que el modelo
    # no tenia, y es estacionaria por construccion.
    _rango = (h - l).replace(0, np.nan)
    _volm  = v.rolling(50).mean().replace(0, np.nan)
    _obv   = ta.volume.OnBalanceVolumeIndicator(c, v).on_balance_volume()

    df["obv_n"]   = _obv.diff(5) / _volm      # presion neta de 5 barras, escalada
    df["close_n"] = (c - l) / _rango          # donde cerro dentro del rango [0,1]
    df["open_n"]  = o / c                     # apertura vs cierre
    df["high_n"]  = h / c                     # mecha superior
    df["low_n"]   = l / c                     # mecha inferior
    df["vol_n"]   = v / _volm

    # ── NUEVOS: features horarios ──────────────────────────────────────────────

    # VWAP ratio (precio vs precio promedio ponderado por volumen del día)
    # Aproximación: VWAP = cumsum(precio_típico × volumen) / cumsum(volumen) por día
    # ANTES era (H+L+C)/3 / C: sin volumen, sin cumsum, sin agrupar por dia.
    # Valia ~1.0 siempre y no era un VWAP. Ahora si: acumulado intradiario,
    # reseteado cada dia, causal (solo barras hasta la actual inclusive).
    typical_price   = (h + l + c) / 3
    _dia            = pd.Series(pd.DatetimeIndex(df.index).normalize(), index=df.index)
    _pv             = (typical_price * v).groupby(_dia).cumsum()
    _vv             = v.groupby(_dia).cumsum().replace(0, np.nan)
    df["vwap_r"]    = c / (_pv / _vv)

    # Retornos a corto plazo horarios
    df["ret1h"]     = c.pct_change(1)    # retorno de la última barra
    df["ret4h"]     = c.pct_change(4)    # retorno de las últimas 4 horas

    # Gap apertura vs cierre anterior
    df["gap_open"]  = (o - c.shift(1)) / c.shift(1).replace(0, np.nan)

    # ── Codificación cíclica de tiempo ────────────────────────────────────────
    # Permite a la LSTM aprender patrones por hora/día sin discontinuidades
    # (23 → 0 y 0 → 1 son contiguos con sin/cos, no con enteros)
    if hasattr(df.index, "hour"):
        hour = df.index.hour.astype(float)
        dow  = df.index.dayofweek.astype(float)
    else:
        # Para índices timezone-aware o DatetimeTZDtype
        try:
            idx = pd.DatetimeIndex(df.index)
            hour = idx.hour.astype(float)
            dow  = idx.dayofweek.astype(float)
        except Exception:
            hour = pd.Series(12.0, index=df.index)
            dow  = pd.Series(2.0,  index=df.index)

    df["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    df["day_sin"]  = np.sin(2 * np.pi * dow  / 5)
    df["day_cos"]  = np.cos(2 * np.pi * dow  / 5)

    return df


# ── El promedio del universo, para la etiqueta relativa ───────────────────
# Retorno a H barras de CADA ETF, promediado por hora (equiponderado, igual que
# _marketRet de class43). Se baja una vez cada 12 h y se reusa: todo entrenamiento
# corre dentro del _TRAIN_GATE, así que no hay descargas en paralelo.
_BENCH = {"ts": 0.0, "h": None, "serie": None}
_BENCH_TTL_S = 12 * 3600


def _benchmark_fwd(horizon: int) -> "pd.Series | None":
    if (_BENCH["serie"] is not None and _BENCH["h"] == horizon
            and time.time() - _BENCH["ts"] < _BENCH_TTL_S):
        return _BENCH["serie"]
    fwds = []
    for tk in TICKERS:
        try:
            df = yf.download(tk, period=PERIODO_TRAIN, interval=INTERVALO_TRAIN,
                             auto_adjust=True, progress=False, multi_level_index=False,
                             timeout=30)
            if df is None or df.empty or "Close" not in df.columns:
                continue
            c = df["Close"].astype(float)
            fwds.append((c.shift(-horizon) / c - 1).rename(tk))
        except Exception as e:
            log.warning(f"benchmark: {tk} no se pudo bajar ({e})")
    if len(fwds) < max(5, len(TICKERS) // 2):
        log.warning(f"benchmark: sólo {len(fwds)} de {len(TICKERS)} ETFs — sin etiqueta relativa")
        return None
    serie = pd.concat(fwds, axis=1).mean(axis=1, skipna=True)
    _BENCH.update(ts=time.time(), h=horizon, serie=serie)
    log.info(f"benchmark: promedio de {len(fwds)} ETFs a {horizon} barras, {len(serie)} horas")
    return serie


def _fwd_relativo(close: pd.Series, horizon: int) -> "pd.Series | None":
    """Retorno a `horizon` barras menos el promedio del universo (absoluto si se
    apagó la etiqueta relativa; None si no se pudo armar el promedio)."""
    fwd = close.shift(-horizon) / close - 1
    if not ETIQUETA_RELATIVA:
        return fwd
    bench = _benchmark_fwd(horizon)
    if bench is None:
        return None
    return fwd - bench.reindex(close.index)


def _umbral_relativo(fwd_rel: pd.Series) -> tuple[float, float]:
    """0,5 σ del retorno RELATIVO al horizonte, sólo con el tramo de entrenamiento."""
    s = float(fwd_rel.dropna().std() or 0.0)
    u = float(np.clip(0.5 * s, 0.001, 0.10))
    return u, -u


def _calcular_umbral_dinamico(close: pd.Series, horizon: int = 1) -> tuple[float, float]:
    """
    Calcula umbrales BUY/SELL dinámicos basados en la volatilidad del ticker
    AL HORIZONTE de la señal. Umbral = 0.5 × σ del retorno a 'horizon' barras.
    Retorna (label_up, label_down) como fracciones decimales.
    """
    # Retorno horario
    ret_hourly = close.pct_change().dropna()
    sigma_h    = ret_hourly.std()
    # Volatilidad del retorno a 'horizon' barras ≈ σ_1barra × √horizon.
    # Sin escalar, un umbral de 1h aplicado a un movimiento de 4h clasificaría
    # casi todo como BUY/SELL (casi ningún HOLD).
    sigma_hz   = sigma_h * np.sqrt(max(horizon, 1))
    # Umbral: 0.5 sigma al horizonte, mínimo 0.2%, máximo 2%
    umbral = float(np.clip(0.5 * sigma_hz, 0.002, 0.02))
    return umbral, -umbral


def _calibrar_sell_umbral(probs_val: np.ndarray, y_val: np.ndarray,
                          prev: float) -> tuple[float, dict]:
    """
    Umbral dinámico del gate SELL, calibrado sobre el set de VALIDACIÓN.

    Clave: la validación NO tiene censura — contiene todos los candidatos a SELL
    (altos y bajos), a diferencia de los outcomes verificados en vivo, que solo
    ven los SELL que ya pasaron el gate anterior (sesgo de selección → el umbral
    solo sabría subir). Acá se mide la curva precisión-vs-corte real.

    Busca el MENOR prob_sell (más volumen) cuyo grupo emitido como SELL alcanza
    SELL_CALIB_TARGET de precisión con volumen suficiente; amortigua contra el
    valor previo (EMA) y recorta a la banda segura. Si hay pocos candidatos SELL,
    NO mueve el umbral (devuelve `prev`) — así arranca estable con pocos datos.
    """
    lo, hi = SELL_CONF_BAND
    sell_p   = probs_val[:, 0]
    es_sell  = probs_val.argmax(axis=1) == 0          # el modelo emitiría SELL
    n_cand   = int(es_sell.sum())
    info = {"prev": round(float(prev), 4), "cand": n_cand,
            "elegido": None, "precision": None, "n": 0, "movido": False}

    # Guard de muestra mínima: sin SELL suficientes, no se toca el umbral.
    if n_cand < SELL_CALIB_MIN_N:
        info["motivo"] = "pocos_candidatos"
        info["nuevo"]  = round(float(prev), 4)
        return float(prev), info

    best = None
    for t in np.round(np.arange(lo, hi + 1e-9, 0.01), 2):
        mask = es_sell & (sell_p >= t)
        n    = int(mask.sum())
        if n < max(SELL_CALIB_MIN_N // 2, 5):
            continue
        prec = float((y_val[mask] == 0).mean())        # 0 == SELL real (mercado bajó)
        if prec >= SELL_CALIB_TARGET:
            best = (float(t), prec, n)                 # menor t que cumple → máx. volumen
            break

    if best is None:
        # Ningún corte alcanza el objetivo → tender al tope (más selectivo).
        target_t = hi
        info["motivo"] = "objetivo_inalcanzable"
    else:
        target_t, prec, n = best
        info.update(elegido=round(target_t, 2), precision=round(prec, 3), n=n,
                    motivo="ok")

    ema   = SELL_CALIB_EMA * target_t + (1.0 - SELL_CALIB_EMA) * float(prev)
    new_t = float(np.clip(ema, lo, hi))
    info["movido"] = abs(new_t - float(prev)) > 1e-6
    info["nuevo"]  = round(new_t, 4)
    return new_t, info


def _make_labels(close: pd.Series, label_up: float = 0.005, label_down: float = -0.005,
                 horizon: int = 1, fwd: "pd.Series | None" = None) -> pd.Series:
    """
    Retorno a 'horizon' barras hacia adelante con umbrales dinámicos.
    horizon DEBE coincidir con el horizonte que trackea class43 (HORIZONTE_BARRAS),
    para que lo que el modelo aprende a predecir sea lo mismo que después se mide.
    """
    if fwd is None:                            # `fwd` = el retorno RELATIVO si viene
        fwd = close.shift(-horizon) / close - 1
    labels = pd.Series(1, index=close.index)   # HOLD por defecto
    labels[fwd >  label_up]   = 2              # BUY
    labels[fwd <  label_down] = 0              # SELL
    return labels


def _make_sequences(feat: np.ndarray, labels: np.ndarray):
    X, y = [], []
    for i in range(WINDOW, len(feat)):
        X.append(feat[i - WINDOW:i])
        y.append(labels[i])
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int64)


def _calcular_class_weights(y: np.ndarray) -> torch.Tensor:
    """
    Pesos inversamente proporcionales a la frecuencia de cada clase.
    Corrige el desbalance HOLD>>BUY≈SELL.
    """
    counts  = np.bincount(y, minlength=3).astype(float)
    total   = counts.sum()
    # Peso = total / (n_clases × count_clase)
    weights = total / (3.0 * np.maximum(counts, 1))
    log.info(f"Class weights: SELL={weights[0]:.2f} HOLD={weights[1]:.2f} BUY={weights[2]:.2f}")
    return torch.tensor(weights, dtype=torch.float32)


# ── Motor por ticker ───────────────────────────────────────────────────────────
class MotorLSTM:
    def __init__(self, ticker: str):
        self.ticker       = ticker
        self.model: LSTMPredictor | None = None
        self.scaler       = MinMaxScaler()
        self.trained_at: datetime | None = None
        self._model_path  = MODELS_DIR / f"lstm_{ticker}.pt"
        self._scaler_path = MODELS_DIR / f"scaler_{ticker}.pkl"
        self._state_path  = STATE_DIR  / f"class44_{ticker}.json"
        self._training    = False
        self._label_up    = 0.005    # umbral dinámico (se actualiza al entrenar)
        self._label_down  = -0.005
        self._sell_conf_min = SELL_CONF_MIN   # gate SELL dinámico (se calibra al entrenar)
        self._etiqueta    = "absoluta_4h"     # con qué pregunta se entrenó (los viejos: absoluta)

    def _load_state(self):
        try:
            s = json.loads(self._state_path.read_text(encoding="utf-8"))
            raw = s.get("trained_at")
            if raw:
                self.trained_at = datetime.fromisoformat(raw)
            self._label_up   = s.get("label_up",   0.005)
            self._label_down = s.get("label_down", -0.005)
            self._sell_conf_min = s.get("sell_conf_min", SELL_CONF_MIN)
            self._etiqueta   = s.get("etiqueta", "absoluta_4h")
        except Exception:
            pass

    def _save_state(self):
        try:
            self._state_path.write_text(json.dumps({
                "ticker":     self.ticker,
                "trained_at": self.trained_at.isoformat() if self.trained_at else None,
                "label_up":   self._label_up,
                "label_down": self._label_down,
                "sell_conf_min": self._sell_conf_min,
                "etiqueta":   self._etiqueta,
                "intervalo":  INTERVALO_TRAIN,
                "n_features": N_FEATURES,
            }), encoding="utf-8")
        except Exception:
            pass

    def necesita_reentrenamiento(self) -> bool:
        if self.trained_at is None:
            return True
        if self._etiqueta != ETIQUETA_ID:     # entrenado con otra pregunta
            return True
        return (datetime.now() - self.trained_at).days >= RETRAIN_DAYS

    def _descargar(self, periodo: str = PERIODO_TRAIN,
                   intervalo: str = INTERVALO_TRAIN,
                   min_bars: int | None = None) -> pd.DataFrame | None:
        # min_bars distinto según contexto:
        #   entrenamiento → WINDOW + 100 (calidad alta)
        #   predicción    → WINDOW + 60  (EMA50 warmup + lookback)
        if min_bars is None:
            min_bars = WINDOW + 100
        try:
            # timeout: sin esto, si Yahoo se cuelga/limita, la descarga bloquea el
            # hilo indefinidamente — y con el entrenamiento serializado eso frena
            # la cola entera (los demás modelos nunca entrenan).
            df = yf.download(
                self.ticker, period=periodo, interval=intervalo,
                auto_adjust=True, progress=False, multi_level_index=False,
                timeout=30
            )
            if df.empty or len(df) < min_bars:
                log.warning(f"[{self.ticker}] Datos insuficientes ({len(df)} barras, mín={min_bars})")
                return None
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            for col in ["Open", "High", "Low", "Close", "Volume"]:
                if col not in df.columns:
                    log.warning(f"[{self.ticker}] Columna faltante: {col}")
                    return None
            return df
        except Exception as e:
            log.error(f"[{self.ticker}] Error descargando ({intervalo}/{periodo}): {e}")
            return None

    def entrenar(self) -> bool:
        if self._training:
            log.info(f"[{self.ticker}] Entrenamiento ya en curso")
            return False
        self._training = True
        # Serializar: espera su turno para que solo un modelo entrene a la vez.
        # acquire() va JUSTO antes del try (sin nada en el medio) para garantizar
        # que el finally SIEMPRE libere el semáforo. Si quedara algo entre acquire
        # y try que fallara, el gate quedaría tomado para siempre → cola frenada.
        _TRAIN_GATE.acquire()
        try:
            log.info(f"[{self.ticker}] Descargando {PERIODO_TRAIN} de datos {INTERVALO_TRAIN}...")
            df = self._descargar(periodo=PERIODO_TRAIN, intervalo=INTERVALO_TRAIN)
            if df is None:
                return False

            df = _build_features(df).dropna()
            if len(df) < WINDOW + 100:
                log.warning(f"[{self.ticker}] Pocas filas tras dropna: {len(df)}")
                return False

            log.info(f"[{self.ticker}] Dataset: {len(df)} barras horarias "
                     f"({len(df)/6.5/252:.1f} años equivalentes)")

            # ── Punto de corte train/val, en índice de SECUENCIA ────────────────
            # Antes había TRES cortes distintos: el scaler indexaba barras
            # (len(feat_raw)*0.80), el split indexaba secuencias (len(X)*0.80) y el
            # umbral de etiqueta miraba la serie entera. Con 3276 barras el scaler
            # se ajustaba hasta la barra 2620 mientras validación arrancaba en la
            # 2569 → 51 barras de validación entraban en el fit. Ahora los tres
            # respetan el mismo límite. len(X) tras el recorte de HORIZONTE_BARRAS
            # es len(df) - WINDOW - H, así que este índice sirve para los dos usos.
            n_seq = len(df) - WINDOW - HORIZONTE_BARRAS
            if n_seq < 100:
                log.warning(f"[{self.ticker}] Secuencias insuficientes: {n_seq}")
                return False
            split = int(n_seq * 0.80)

            # Umbral dinámico calibrado a la volatilidad del ticker.
            # Solo con el tramo de entrenamiento: sigma sobre la serie completa
            # define las etiquetas de validación con un estadístico que ya la vio.
            fwd_s = _fwd_relativo(df["Close"], HORIZONTE_BARRAS)
            if fwd_s is None:
                log.warning(f"[{self.ticker}] Sin el promedio del universo: no se entrena "
                            f"(la etiqueta relativa lo necesita)")
                return False
            if ETIQUETA_RELATIVA:
                label_up, label_down = _umbral_relativo(fwd_s.iloc[:split])
            else:
                label_up, label_down = _calcular_umbral_dinamico(
                    df["Close"].iloc[:split], HORIZONTE_BARRAS)
            self._label_up   = label_up
            self._label_down = label_down
            log.info(f"[{self.ticker}] Etiqueta {ETIQUETA_ID} · umbrales: "
                     f"up={label_up:.3%} down={label_down:.3%}")

            labels_s    = _make_labels(df["Close"], label_up, label_down,
                                       horizon=HORIZONTE_BARRAS, fwd=fwd_s)
            feat_raw    = df[FEATURE_COLS].values

            # Guardrail: conservar modelo y scaler ANTERIORES para comparar al final.
            # Un reentreno solo debe reemplazar al modelo previo si VALIDA MEJOR,
            # para que el auto-reentrenamiento no degrade el modelo persiguiendo ruido.
            prev_model  = self.model if self._etiqueta == ETIQUETA_ID else None
            prev_scaler = None
            if prev_model is not None and self._scaler_path.exists():
                try:    prev_scaler = joblib.load(self._scaler_path)
                except Exception: prev_model = None

            # Anti-fuga de datos: el scaler se AJUSTA solo con el tramo de
            # entrenamiento (primer 80% cronológico). Si se ajustara con todo
            # el dataset, los min/max del futuro (validación) se filtrarían al
            # escalado → val_loss optimista y modelo que no generaliza.
            # NOTA: aún NO se persiste — recién se guarda si el modelo nuevo gana.
            new_scaler  = MinMaxScaler()
            new_scaler.fit(feat_raw[:split])   # justo hasta donde arranca validación
            feat_scaled = new_scaler.transform(feat_raw)

            X, y = _make_sequences(feat_scaled, labels_s.values)
            # Las últimas HORIZONTE_BARRAS filas no tienen retorno forward válido
            # (shift(-H) → NaN, que _make_labels deja como HOLD falso). Se recortan
            # para no entrenar con etiquetas fabricadas.
            X, y = X[:-HORIZONTE_BARRAS], y[:-HORIZONTE_BARRAS]

            # Distribución de clases
            vals, cnts = np.unique(y, return_counts=True)
            dist = {int(v): int(c) for v, c in zip(vals, cnts)}
            log.info(f"[{self.ticker}] Clases: SELL={dist.get(0,0)} HOLD={dist.get(1,0)} BUY={dist.get(2,0)}")

            assert len(X) == n_seq, f"n_seq={n_seq} distinto de len(X)={len(X)}"

            # Purga: la última secuencia de train abarca WINDOW barras y su etiqueta
            # mira HORIZONTE_BARRAS más allá, así que sin este recorte los últimos
            # WINDOW+H ejemplos comparten barras con el tramo de validación.
            _purga  = WINDOW + HORIZONTE_BARRAS
            _fin_tr = max(1, split - _purga)
            X_tr, y_tr   = X[:_fin_tr], y[:_fin_tr]
            X_val, y_val = X[split:],   y[split:]

            # Class weights para corregir desbalance
            class_weights = _calcular_class_weights(y_tr)

            # drop_last: nn.BatchNorm1d en modo train lanza "Expected more than 1
            # value per channel" si el último batch trae 1 sola muestra. Con
            # len(X_tr) % 64 == 1 ese ticker fallaba y el except genérico lo
            # registraba como "Error en entrenamiento" sin decir por qué.
            tr_dl = DataLoader(TensorDataset(torch.tensor(X_tr), torch.tensor(y_tr)),
                               batch_size=BATCH_SIZE, shuffle=True,
                               drop_last=len(X_tr) > BATCH_SIZE)
            val_dl = DataLoader(TensorDataset(torch.tensor(X_val), torch.tensor(y_val)),
                                batch_size=BATCH_SIZE)

            self.model = LSTMPredictor(N_FEATURES)
            opt   = torch.optim.Adam(self.model.parameters(), lr=LR, weight_decay=1e-4)
            # CrossEntropyLoss CON class_weight — corrección del desbalance
            crit  = nn.CrossEntropyLoss(weight=class_weights)
            sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, patience=7, factor=0.5)

            best_loss, patience_c, best_state = float("inf"), 0, None

            for epoch in range(1, EPOCHS + 1):
                self.model.train()
                for xb, yb in tr_dl:
                    opt.zero_grad()
                    crit(self.model(xb), yb).backward()
                    nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)  # gradient clipping
                    opt.step()

                self.model.eval()
                val_l = []
                with torch.no_grad():
                    for xb, yb in val_dl:
                        val_l.append(crit(self.model(xb), yb).item())
                v_loss = float(np.mean(val_l))
                sched.step(v_loss)

                if v_loss < best_loss:
                    best_loss  = v_loss
                    patience_c = 0
                    best_state = {k: v.clone() for k, v in self.model.state_dict().items()}
                else:
                    patience_c += 1
                    if patience_c >= EARLY_STOP:
                        log.info(f"[{self.ticker}] Early stop época {epoch}, val_loss={best_loss:.4f}")
                        break

                if epoch % 20 == 0:
                    log.info(f"[{self.ticker}] Época {epoch} val_loss={v_loss:.4f}")

            if best_state:
                self.model.load_state_dict(best_state)
            self.model.eval()

            # ── Guardrail: aceptar el modelo nuevo SOLO si valida mejor ──────────
            # Se compara la accuracy de validación del modelo nuevo vs el anterior
            # sobre el MISMO tramo de validación (cada uno con su propio scaler).
            # Se decide por PÉRDIDA, no por accuracy. El entrenamiento optimiza
            # cross-entropy ponderada —los class_weights empujan a propósito fuera
            # de la clase mayoritaria— así que un modelo mejor calibrado podía
            # tener PEOR accuracy y era rechazado: objetivos en conflicto, 236
            # rechazos contra 47 aceptados. La accuracy se sigue logueando.
            # Los pesos promedian 1 por construcción (total/(3·count) sumado sobre
            # las tres clases), así que la pérdida ponderada sigue comparándose
            # contra el azar de ln(3)=1.0986.
            def _val_metrics(model, scaler) -> tuple[float, float]:
                fs = scaler.transform(feat_raw)
                Xa, ya = _make_sequences(fs, labels_s.values)
                Xa, ya = Xa[:-HORIZONTE_BARRAS], ya[:-HORIZONTE_BARRAS]
                Xv, yv = Xa[split:], ya[split:]
                if len(Xv) == 0:
                    return float("inf"), 0.0
                model.eval()
                with torch.no_grad():
                    logits = model(torch.tensor(Xv))
                    loss   = float(crit(logits, torch.tensor(yv)).item())
                    acc    = float((logits.argmax(1).numpy() == yv).mean())
                return loss, acc

            new_loss, new_acc = _val_metrics(self.model, new_scaler)
            if prev_model is not None and prev_scaler is not None:
                try:
                    old_loss, old_acc = _val_metrics(prev_model, prev_scaler)
                    if old_loss <= new_loss:
                        log.info(f"[{self.ticker}] ⏸️ Reentreno DESCARTADO: nuevo "
                                 f"loss={new_loss:.4f}/acc={new_acc:.1%} no supera al anterior "
                                 f"loss={old_loss:.4f}/acc={old_acc:.1%} — se conserva el previo")
                        self.model = prev_model            # revertir al anterior
                        self.trained_at = datetime.now()   # evita reintentar de inmediato
                        self._save_state()
                        return True
                except Exception as e:
                    log.warning(f"[{self.ticker}] No se pudo comparar con el modelo previo: {e}")

            # El nuevo gana (o no había anterior) → recién ahora se persiste todo
            self.scaler = new_scaler
            joblib.dump(self.scaler, self._scaler_path)
            log.info(f"[{self.ticker}] ✅ Modelo nuevo aceptado "
                     f"(val_loss={new_loss:.4f} vs azar 1.0986, val_acc={new_acc:.1%})")

            # ── Auto-calibración del umbral SELL sobre validación (sin censura) ──
            # Se reconstruye el MISMO tramo de validación que _val_metrics y se calibra
            # el gate SELL con las probabilidades softmax del modelo aceptado.
            try:
                _fsv = self.scaler.transform(feat_raw)
                _Xa, _ya = _make_sequences(_fsv, labels_s.values)
                _Xa, _ya = _Xa[:-HORIZONTE_BARRAS], _ya[:-HORIZONTE_BARRAS]
                _Xv, _yv = _Xa[split:], _ya[split:]
                if len(_Xv) > 0:
                    with torch.no_grad():
                        _pv = torch.softmax(self.model(torch.tensor(_Xv)), dim=1).numpy()
                    _prev = getattr(self, "_sell_conf_min", SELL_CONF_MIN)
                    self._sell_conf_min, _ci = _calibrar_sell_umbral(_pv, _yv, _prev)
                    log.info(f"[{self.ticker}] Gate SELL: {_prev:.3f} → "
                             f"{self._sell_conf_min:.3f} (cand={_ci['cand']}, "
                             f"prec={_ci['precision']}, {_ci['motivo']})")
            except Exception as e:
                log.warning(f"[{self.ticker}] Calibración SELL omitida: {e}")
                if not hasattr(self, "_sell_conf_min"):
                    self._sell_conf_min = SELL_CONF_MIN

            torch.save({
                "state_dict": self.model.state_dict(),
                "arch":       ARCH_VERSION,
                "n_features": N_FEATURES,
                "label_up":   label_up,
                "label_down": label_down,
                "sell_conf_min": self._sell_conf_min,
                "etiqueta":   ETIQUETA_ID,
            }, self._model_path)

            self.trained_at = datetime.now()
            self._etiqueta  = ETIQUETA_ID
            self._save_state()
            log.info(f"[{self.ticker}] ✅ Entrenamiento OK. best_val_loss={best_loss:.4f}")
            return True

        except Exception as e:
            log.error(f"[{self.ticker}] Error en entrenamiento: {e}")
            return False
        finally:
            self._training = False
            _TRAIN_GATE.release()

    def cargar(self) -> bool:
        if not self._model_path.exists() or not self._scaler_path.exists():
            return False
        try:
            ckpt = torch.load(self._model_path, map_location="cpu", weights_only=False)
            # El arreglo de la lstm2 NO cambia ninguna forma del state_dict, así que
            # un .pt v1 cargaría sin error con pesos que ya no significan nada. Y los
            # features cambiaron de escala, o sea que el scaler viejo tampoco sirve.
            _arch = ckpt.get("arch", 1)
            if _arch != ARCH_VERSION:
                log.info(f"[{self.ticker}] Checkpoint arch=v{_arch} distinto de "
                         f"v{ARCH_VERSION} — descartado, se reentrena de cero")
                self._model_path.unlink(missing_ok=True)
                self._scaler_path.unlink(missing_ok=True)
                self.trained_at = None
                return False
            self.model = LSTMPredictor(ckpt.get("n_features", N_FEATURES))
            self.model.load_state_dict(ckpt["state_dict"])
            self.model.eval()
            self.scaler      = joblib.load(self._scaler_path)
            self._label_up   = ckpt.get("label_up",   0.005)
            self._label_down = ckpt.get("label_down", -0.005)
            self._sell_conf_min = ckpt.get("sell_conf_min", SELL_CONF_MIN)
            self._load_state()
            log.info(f"[{self.ticker}] Modelo cargado (entrenado: {self.trained_at}, "
                     f"umbral: {self._label_up:.3%})")
            return True
        except Exception as e:
            log.warning(f"[{self.ticker}] No se pudo cargar modelo: {e}")
            # Mismatch de arquitectura → borrar archivos obsoletos para reentrenar limpiamente
            if "size mismatch" in str(e) or "Missing key" in str(e) or "Unexpected key" in str(e):
                log.info(f"[{self.ticker}] Arquitectura cambiada — borrando modelo obsoleto para reentrenar")
                try:
                    self._model_path.unlink(missing_ok=True)
                    self._scaler_path.unlink(missing_ok=True)
                except Exception:
                    pass
            return False

    def predecir(self) -> dict | None:
        if self.model is None or self._training:
            return None

        # Descarga datos horarios recientes para predicción
        # min_bars = WINDOW + 60: EMA50 necesita 50 períodos de warmup + WINDOW para la secuencia
        df = self._descargar(periodo=PERIODO_PRED, intervalo=INTERVALO_TRAIN,
                             min_bars=WINDOW + 60)
        if df is None:
            return None

        df = _build_features(df).dropna()
        if len(df) < WINDOW:
            log.warning(f"[{self.ticker}] Insuficientes barras ({len(df)} < {WINDOW})")
            return None

        try:
            feat = self.scaler.transform(df[FEATURE_COLS].values)
            seq  = torch.tensor(feat[-WINDOW:], dtype=torch.float32).unsqueeze(0)

            self.model.eval()
            with torch.no_grad():
                probs = torch.softmax(self.model(seq), dim=1).squeeze().numpy()

            idx_max   = int(np.argmax(probs))
            # Gate asimétrico del SELL (umbral dinámico auto-calibrado): si el
            # argmax es SELL pero prob_sell no supera el piso → reclasificar a HOLD.
            # Un SELL de baja convicción tiene <50% de acierto y destruye edge.
            _sell_min = getattr(self, "_sell_conf_min", SELL_CONF_MIN)
            if idx_max == 0 and float(probs[0]) < _sell_min:
                idx_max = 1
            # Corroboración multi-motor: un SELL sobreviviente se veta (→ HOLD) si
            # class45 (sentimiento alcista) o class41 (riesgo de mercado LOW) lo
            # contradicen con datos frescos. Fail-open ante datos ausentes/viejos.
            _corr_veto = None
            if idx_max == 0:
                _ok_corr, _corr_info = _corroborar_sell(self.ticker)
                _corr_veto = _corr_info.get("veto")
                if not _ok_corr:
                    idx_max = 1
            señal_map = {0: "SELL", 1: "HOLD", 2: "BUY"}
            señal     = señal_map[idx_max]
            confianza = float(probs[idx_max])

            def _safe(v):
                val = float(v)
                return None if np.isnan(val) or np.isinf(val) else round(val, 4)

            return {
                "tipo":          "prediccion_lstm",
                "fuente":        "class44",
                "ticker":        self.ticker,
                "señal":         señal,
                "confianza":     round(confianza, 4),
                "prob_buy":      round(float(probs[2]), 4),
                "prob_hold":     round(float(probs[1]), 4),
                "prob_sell":     round(float(probs[0]), 4),
                # prob_contraccion: probabilidad de que el mercado BAJE = prob_sell.
                # class25A lee este campo de class40_output para su capa de crisis
                # (si >0.60 sube el umbral → más conservador). Antes caía al
                # fallback `confianza` (la confianza del LSTM, direction-agnostic):
                # un BUY confiado se leía como "viene un crash" y ponía a class25A
                # más conservador AL REVÉS, alimentando el sesgo HOLD. Ahora la
                # capa de crisis reacciona a la probabilidad BAJISTA real.
                "prob_contraccion": round(float(probs[0]), 4),
                # tendencia direccional para el texto del forecast en class25A.
                "tendencia":     "bajista" if señal == "SELL" else "alcista" if señal == "BUY" else "lateral",
                "horizonte":     HORIZONTE,
                "etiqueta":      self._etiqueta,   # relativa_7h = ¿le gana al promedio en una rueda?
                "precio_actual": _safe(df["Close"].iloc[-1]),
                "umbral_usado":  round(self._label_up, 4),
                "sell_conf_min": round(getattr(self, "_sell_conf_min", SELL_CONF_MIN), 4),
                "sell_corr_veto": _corr_veto,
                "n_features":    N_FEATURES,
                "intervalo":     INTERVALO_TRAIN,
                "indicadores": {
                    "rsi":    _safe(df["rsi"].iloc[-1]),
                    "macd":   _safe(df["macd"].iloc[-1]),
                    "bb_pct": _safe(df["bb_pct"].iloc[-1]),
                    "atr_r":  _safe(df["atr_r"].iloc[-1]),
                    "ret1h":  _safe(df["ret1h"].iloc[-1]),
                    "vwap_r": _safe(df["vwap_r"].iloc[-1]),
                },
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        except Exception as e:
            log.error(f"[{self.ticker}] Error en predicción: {e}")
            return None


# ── Redis helpers ──────────────────────────────────────────────────────────────
def _conectar_redis() -> redis.Redis | None:
    try:
        r = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5)
        r.ping()
        log.info("Redis conectado")
        return r
    except Exception as e:
        log.warning(f"Redis no disponible: {e}")
        return None


def _publicar(r: redis.Redis, payload: dict) -> bool:
    msg = json.dumps(payload, ensure_ascii=False)
    try:
        r.publish(CH_OUT_LSTM,   msg)
        r.publish(CH_OUT_CRISIS, msg)
        return True
    except Exception as e:
        log.error(f"Error publicando: {e}")
        return False


def _publicar_estado(r: redis.Redis, motores: list, marcador=None):
    try:
        estado = {
            "fuente":    "class44",
            "version":   "2.1",
            "intervalo": INTERVALO_TRAIN,
            "ts":        datetime.now(timezone.utc).isoformat(),
            "tickers": [
                {
                    "ticker":     m.ticker,
                    "modelo":     "cargado" if m.model else "sin_modelo",
                    "entrenando": m._training,
                    "trained_at": m.trained_at.isoformat() if m.trained_at else None,
                    "umbral":     round(m._label_up, 4),
                    "sell_conf_min": round(getattr(m, "_sell_conf_min", SELL_CONF_MIN), 4),
                    # ¿Este modelo le gana al promedio? acierto / base / edge /
                    # mde. Va acá para que llegue al panel y al chequeo sin tocar
                    # la base: hoy no hay NINGUNA métrica de acierto por ticker.
                    "marcador":   marcador.stats(m.ticker) if marcador else None,
                }
                for m in motores
            ],
            "marcador_resumen": marcador.resumen() if marcador else None,
        }
        r.publish(CH_ESTADO, json.dumps(estado))
    except Exception:
        pass


# ── Corroboración multi-motor del SELL (sentimiento class45 + riesgo class41) ──
_corr_lock  = threading.Lock()
_sent_cache: dict = {}                                          # ticker -> {score, label, ts}
_risk_cache: dict = {"level": None, "score": None, "ts": 0.0}   # riesgo de mercado (global)


def _corroborar_sell(ticker: str) -> tuple[bool, dict]:
    """¿Se permite emitir el SELL? Veta si un motor lo CONTRADICE con datos frescos.
    Fail-open: datos ausentes o viejos NO vetan. Devuelve (permitido, info)."""
    info: dict = {"sent": None, "risk": None, "veto": None}
    if not SELL_CORROBORA:
        return True, info
    now = time.time()
    with _corr_lock:
        s  = _sent_cache.get(str(ticker).upper())
        rk = dict(_risk_cache)
    # class45: un sentimiento marcadamente alcista contradice un SELL.
    if s and (now - s["ts"]) <= SELL_CORR_TTL_S:
        info["sent"] = round(s["score"], 3)
        if s["score"] >= SELL_SENT_BULL_VETO or s["label"] == "BULLISH":
            info["veto"] = "sentimiento_bullish"
            return False, info
    # class41: riesgo de mercado LOW (mercado tranquilo) contradice un SELL.
    if rk.get("level") and (now - rk["ts"]) <= SELL_CORR_TTL_S:
        info["risk"] = rk["level"]
        if rk["level"] == "LOW":
            info["veto"] = "riesgo_low"
            return False, info
    return True, info


def _corroboracion_listener():
    """Cachea sentimiento (class45, por ticker) y riesgo de mercado (class41) para
    el gate de corroboración del SELL. Reconecta solo; nunca bloquea la predicción."""
    while not _stop.is_set():
        try:
            rc = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5)
            ps = rc.pubsub(ignore_subscribe_messages=True)
            ps.subscribe(CH_SENT, CH_RISK)
            log.info(f"Corroboración listener activo → {CH_SENT}, {CH_RISK}")
            for msg in ps.listen():
                if _stop.is_set():
                    break
                if msg["type"] != "message":
                    continue
                try:
                    ch   = msg["channel"]
                    data = json.loads(msg["data"])
                    now  = time.time()
                    if ch == CH_SENT:
                        tk = str(data.get("ticker", "")).upper()
                        if tk:
                            with _corr_lock:
                                _sent_cache[tk] = {
                                    "score": float(data.get("sentiment_score", 0.0)),
                                    "label": str(data.get("sentiment_label", "NEUTRAL")),
                                    "ts":    now,
                                }
                    elif ch == CH_RISK:
                        rm  = data.get("RiskMetrics") or data.get("riskMetrics") or {}
                        lvl = rm.get("RiskLevel") or rm.get("riskLevel")
                        scr = rm.get("RiskScore") or rm.get("riskScore")
                        if lvl is not None:
                            with _corr_lock:
                                _risk_cache["level"] = str(lvl).upper()
                                _risk_cache["score"] = float(scr) if scr is not None else None
                                _risk_cache["ts"]    = now
                except Exception as e:
                    log.debug(f"Corroboración parse: {e}")
        except Exception as e:
            log.warning(f"Corroboración listener error: {e} — retry 10s")
            _stop.wait(timeout=10)


# ── Bucle principal ────────────────────────────────────────────────────────────
_stop = threading.Event()

def _sig_handler(sig, _frame):
    log.info(f"Señal {sig} — cerrando class44")
    _stop.set()

signal.signal(signal.SIGINT,  _sig_handler)
signal.signal(signal.SIGTERM, _sig_handler)


def main():
    log.info("=" * 60)
    log.info("class44 v2.1 — Motor LSTM Predictivo (datos horarios)")
    log.info(f"Tickers:   {len(TICKERS)} — {TICKERS}")
    if 0 < PRED_POR_CICLO < len(TICKERS):
        log.info(f"Rotación:  {PRED_POR_CICLO} por ciclo · "
                 f"{ciclos_por_ronda(len(TICKERS), PRED_POR_CICLO)} ciclos por ronda · "
                 f"{descargas_por_dia(len(TICKERS), PRED_POR_CICLO, PRED_INTERVAL)} "
                 f"descargas/día "
                 f"(sin rotar serían "
                 f"{descargas_por_dia(len(TICKERS), 0, PRED_INTERVAL)})")
    else:
        log.info(f"Rotación:  apagada — los {len(TICKERS)} en cada ciclo, "
                 f"{descargas_por_dia(len(TICKERS), 0, PRED_INTERVAL)} descargas/día")
    log.info(f"Prioridad de entreno por rendimiento: "
             f"{'ACTIVA' if PRIORIDAD_ENTRENO else 'apagada'} "
             f"(x{PRIORIDAD_FACTOR:g} al que no demostró ventaja con n>={MARCADOR_MIN_N})")
    log.info(f"Intervalo: {INTERVALO_TRAIN} | Ventana: {WINDOW}h ≈ 2 semanas")
    log.info(f"Features:  {N_FEATURES} (vs 20 en v2.0)")
    log.info(f"Umbral:    dinámico por ticker (calibrado a volatilidad)")
    log.info(f"Clase_weight: activado (corrige bias HOLD)")
    log.info(f"Predicción cada: {PRED_INTERVAL // 60} min | Conf min: {CONF_UMBRAL:.0%}")
    log.info("=" * 60)

    motores      = [MotorLSTM(t) for t in TICKERS]
    motor_idx    = {m.ticker: m for m in motores}

    # Marcador por ticker: ¿este modelo le gana al promedio? El dato sale del
    # feedback de class43, que ya llegaba y se tiraba. Ver MIIA/marcador.py.
    marcador = Marcador(min_n=MARCADOR_MIN_N)
    _marcador_path = STATE_DIR / "class44_marcador.json"
    try:
        marcador.de_dict(json.loads(_marcador_path.read_text(encoding="utf-8")))
        log.info("Marcador: %s", marcador.resumen())
    except FileNotFoundError:
        log.info("Marcador: sin historia previa (arranca de cero)")
    except Exception as e:
        log.warning("Marcador: no pude leer %s (%s) — arranca de cero",
                    _marcador_path.name, e)

    def _guardar_marcador():
        # Escritura atómica: un corte en el medio no deja el archivo a medias.
        try:
            tmp = _marcador_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(marcador.a_dict()), encoding="utf-8")
            tmp.replace(_marcador_path)
        except Exception as e:
            log.warning("Marcador: no pude guardar (%s)", e)
    # Buffer de outcomes reales por ticker (de class43 via class24_feedback)
    feedback_buf: dict[str, list] = {t: [] for t in TICKERS}

    for m in motores:
        if not m.cargar():
            log.info(f"[{m.ticker}] Sin modelo — entrenando...")
            threading.Thread(target=m.entrenar, daemon=True, name=f"train-{m.ticker}").start()
        elif m.necesita_reentrenamiento():
            log.info(f"[{m.ticker}] Desactualizado — reentrenando...")
            threading.Thread(target=m.entrenar, daemon=True, name=f"retrain-{m.ticker}").start()

    # ── Hilo: suscribe a class24_feedback (outcomes de class43) ──────────────
    def _feedback_listener():
        while not _stop.is_set():
            try:
                rf = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5)
                ps = rf.pubsub(ignore_subscribe_messages=True)
                ps.subscribe(CH_FEEDBACK)
                log.info(f"Feedback listener activo → {CH_FEEDBACK}")
                for msg in ps.listen():
                    if _stop.is_set():
                        break
                    if msg["type"] != "message":
                        continue
                    try:
                        data   = json.loads(msg["data"])
                        ticker = data.get("ticker", "").upper()
                        retorno_pct = float(data.get("retorno_pct", 0))
                        outcome     = str(data.get("outcome", 0.5))
                        if ticker not in motor_idx:
                            continue

                        # Puntuar al modelo. `outcome` de class43 vale 1 si el
                        # instrumento le GANÓ al promedio equiponderado, o sea
                        # la pregunta de ORDEN 1, y `decision_ts` dice de qué
                        # momento, para aparearlo con lo que el LSTM decía ahí.
                        res = marcador.outcome(ticker,
                                               data.get("outcome", None),
                                               data.get("decision_ts", 0),
                                               data.get("label_modo", ""))
                        if res in ("ok", "err"):
                            st = marcador.stats(ticker)
                            log.info(f"[{ticker}] marcador: {res} — "
                                     f"n={st['n']} acierto={st['acierto']}% "
                                     f"base={st['base']}% edge={st['edge']:+.1f} "
                                     f"(mde ±{st['mde']})")

                        feedback_buf.setdefault(ticker, []).append({
                            "retorno_pct": retorno_pct,
                            "outcome":     outcome,
                            "ts":          data.get("ts", ""),
                        })
                        n = len(feedback_buf[ticker])
                        # Del buffer sólo se usa la LONGITUD (acá y en el clear).
                        # Con el piso temporal puede acumular horas de outcomes,
                        # así que se acota: sin esto son ~20.000 dicts por ticker
                        # por día al caudal de ORDEN 1, guardados para nada.
                        if n > 5000:
                            del feedback_buf[ticker][:-5000]
                        log.info(f"[{ticker}] Outcome recibido: retorno={retorno_pct:+.2%} "
                                 f"({n}/{FEEDBACK_RETRAIN_THRESHOLD} para reentrenar)")
                        # Reentrenar cuando acumula N nuevos outcomes. Con la
                        # prioridad encendida, al que YA tiene muestra y no
                        # demostró ventaja se le pide más antes de gastarle un
                        # turno del semáforo. Al que todavía no tiene muestra no
                        # se le toca el umbral: no hay con qué juzgarlo.
                        umbral_fb = FEEDBACK_RETRAIN_THRESHOLD
                        if PRIORIDAD_ENTRENO:
                            _st = marcador.stats(ticker)
                            if _st["n"] >= MARCADOR_MIN_N and not _st["significativo"]:
                                umbral_fb = int(FEEDBACK_RETRAIN_THRESHOLD
                                                * PRIORIDAD_FACTOR)
                        if n >= umbral_fb:
                            m = motor_idx[ticker]
                            # Horas desde el último entrenamiento de ESTE ticker.
                            # Sin el piso, con el caudal de ORDEN 1 la cola del
                            # _TRAIN_GATE no se vacía nunca: el semáforo evita el
                            # entrenamiento paralelo, no el continuo.
                            horas = ((datetime.now() - m.trained_at).total_seconds() / 3600.0
                                     if m.trained_at else float("inf"))
                            if m._training:
                                pass
                            elif horas < FEEDBACK_RETRAIN_MIN_H:
                                # El buffer NO se limpia: cuando pase el piso,
                                # entrena con todo lo acumulado. Se loguea de a
                                # poco para no escribir una línea por mensaje.
                                if n % 100 == 0:
                                    log.info(f"[{ticker}] {n} outcomes en cola — último train hace "
                                             f"{horas:.1f}h (< {FEEDBACK_RETRAIN_MIN_H}h), se pospone")
                            else:
                                log.info(f"[{ticker}] {n}/{umbral_fb} outcomes → "
                                         f"reentrenamiento guiado")
                                feedback_buf[ticker].clear()
                                threading.Thread(target=m.entrenar, daemon=True,
                                                 name=f"fb-retrain-{ticker}").start()
                    except Exception as e:
                        log.warning(f"Feedback parse error: {e}")
            except Exception as e:
                log.warning(f"Feedback listener error: {e} — retry 10s")
                _stop.wait(timeout=10)

    threading.Thread(target=_feedback_listener, daemon=True, name="feedback").start()
    threading.Thread(target=_corroboracion_listener, daemon=True, name="corrobora").start()

    r: redis.Redis | None = None
    ultimo_pred   = 0.0
    ultimo_estado = 0.0
    # ticker -> cuántas veces se intentó predecirlo. Lo lee proximo_lote() para
    # repartir por turno: elige siempre entre los menos atendidos, así que la
    # diferencia entre el que más y el que menos salió no pasa de 1. Cuenta
    # INTENTOS y no éxitos, para que un ticker que falla siempre no se quede con
    # la cabeza de la cola.
    intentos: dict[str, int] = {}

    while not _stop.is_set():
        now = time.time()

        if r is None:
            r = _conectar_redis()
            if r is None:
                _stop.wait(timeout=10)
                continue

        if now - ultimo_estado >= ESTADO_INTERVAL:
            _publicar_estado(r, motores, marcador)
            _guardar_marcador()
            log.info("Marcador: %s", marcador.resumen())
            ultimo_estado = now

        if now - ultimo_pred >= PRED_INTERVAL:
            # Sólo entran los que pueden predecir: los que están entrenando o sin
            # modelo quedan afuera del reparto en vez de gastar un lugar de la
            # rotación. Con los 37 nuevos entrenando en fila al arrancar, eso deja
            # a los 13 que ya tienen .pt con su cadencia de siempre.
            listos    = [m for m in motores if m.model is not None and not m._training]
            entrenando = sum(1 for m in motores if m._training)
            if listos:
                lote  = proximo_lote([m.ticker for m in listos], PRED_POR_CICLO,
                                     intentos)
                ciclo = [motor_idx[t] for t in lote]
                # El intento se cuenta para TODO el lote antes de predecir: si el
                # ciclo se corta por la mitad (Redis caído) los que no llegaron
                # esperan una ronda, que es mejor que repetir siempre los mismos.
                for t in lote:
                    intentos[t] = intentos.get(t, 0) + 1
            else:
                ciclo = []
            log.info(f"Ciclo: {len(ciclo)} de {len(motores)} "
                     f"(listos {len(listos)}, entrenando {entrenando})")

            for m in ciclo:
                pred = m.predecir()
                if pred is None:
                    continue

                señal  = pred["señal"]
                conf   = pred["confianza"]
                precio = pred["precio_actual"]
                umbral = pred["umbral_usado"]
                log.info(f"[{m.ticker}] {señal} conf={conf:.2%} precio={precio} umbral={umbral:.3%}")

                # Publicar siempre; marcar con "low_conf" si está por debajo del umbral
                # para que la interfaz pueda mostrarla con indicador visual distinto
                pred["low_conf"] = conf < CONF_UMBRAL
                ok = _publicar(r, pred)
                if not ok:
                    r = None
                    break
                # Lo que el modelo dijo, para puntuarlo cuando venza el outcome.
                marcador.predijo(m.ticker, señal, now * 1000.0)
                if conf >= CONF_UMBRAL:
                    log.info(f"[{m.ticker}] ✅ Señal publicada → {CH_OUT_LSTM}")
                else:
                    log.info(f"[{m.ticker}] ⚠️ Señal publicada (baja confianza {conf:.2%})")

                if m.necesita_reentrenamiento() and not m._training:
                    threading.Thread(target=m.entrenar, daemon=True,
                                     name=f"retrain-{m.ticker}").start()

            ultimo_pred = now

        _stop.wait(timeout=30)

    log.info("class44 detenido correctamente")


if __name__ == "__main__":
    main()