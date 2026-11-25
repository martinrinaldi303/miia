// ============================================================
// class25A.cpp — Motor Cuantitativo de Decisión MIIA v2.1
// ============================================================
// CAMBIOS v2.1 respecto a v2.0:
//   - fmt2() helper para formateo de doubles locale-safe
//     Reemplaza std::to_string(score_ens).substr(0,5) en
//     g_bayes.registrar() que era frágil con locales europeas
//     (podría producir "0,48" con coma decimal en lugar de "0.48")
//   - El texto generado por generarTexto() ya usaba
//     ostringstream con fixed+setprecision(2) y estaba correcto.
//
// ROL: Único decisor numérico del sistema.
//      Reemplaza la parte cuantitativa de class25.js.
//
// ENTRADAS (canales Redis):
//   class21_output  — Filtro Adaptativo
//   class22_output  — Filtro Rígido
//   class23_output  — Red EMA
//   class24_output  — MLP Online
//   class40_output  — Motor Predictivo Híbrido (opcional)
//   class41_output  — Motor de Riesgo (opcional)
//   class25a_feedback — outcomes reales de class43
//
// SALIDA: class25a_output
//   Publica señal estructurada + texto en lenguaje natural
//   que class25B usa para razonar lingüísticamente.
//
// DISEÑO:
//   1. Ventana de 5s: acumula señales de class21-24
//   2. Ensamble ponderado con pesos dinámicos por red
//   3. Capa de crisis: class40/41 ajustan el umbral
//   4. Memoria bayesiana: hash(condiciones) → {aciertos/total}
//   5. Umbral adaptativo: se recalibra cada 50 decisiones
//   6. Genera texto natural: "XLK bajó 3.2% — riesgo alto..."
// ============================================================

#include "miia_common.h"
#include <cstdlib>   // std::getenv / std::stod — config del umbral por magnitud

static constexpr const char* TAG     = "class25A";
static constexpr const char* CH_OUT  = "class25a_output";
static constexpr const char* CH_FB   = "class25a_feedback";

// ── Formateador de doubles: siempre 2 decimales, locale-safe ─
// Reemplaza std::to_string(double) que es frágil con locales y
// puede producir "0,48" (coma decimal) en sistemas europeos.
static std::string fmt2(double v) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2) << v;
    return ss.str();
}

// Canales de entrada
static const std::vector<std::string> CH_REDES = {
    "class21_output","class22_output","class23_output","class24_output"
};
static const std::vector<std::string> CH_CRISIS = {
    "class40_output","class41_output"
};

// ── class44 (LSTM) — ORDEN 2 #8 ─────────────────────────────
// Es el único modelo POR INSTRUMENTO del sistema, con etiquetas escaladas por
// volatilidad y gate SELL calibrado en validación. Hasta ahora solo alimentaba
// el dashboard y le daba precios a class43.
//
// Entra en SOMBRA por defecto: se calcula su aporte al ensemble y se loguea,
// pero NO se aplica a score_final. Mismo criterio que GATE_SELL_SHADOW y
// SHADOW_HOLD_SELL — medir antes de actuar. Se activa con CLASS25A_LSTM_MODO=1
// sin recompilar, una vez que haya datos de si aporta o contradice.
static const std::string CH_LSTM = "class44_output";
static int g_lstm_modo = 0;   // 0 = sombra · 1 = activo en el ensemble

// ── META-INTROSPECCIÓN (class27) — SOMBRA (3-sep-2026) ───────────────
// class27 detecta patrones sobre el propio razonamiento del sistema. El más
// útil acá es `overconfidence` ("Alta confianza sin coherencia"), que es
// exactamente el estado en que estuvo class24 clavada en ema=0.9511: certeza
// alta, información nula. class27 lo venía detectando y NADIE lo consumía.
//
// Entra en SOMBRA: se registra qué amortiguación se aplicaría, sin aplicarla.
// Así no cambia la función de decisión y la serie de la tesis no se parte.
// Para activarlo hace falta una decisión deliberada, con datos de si aporta.
static const std::string CH_META = "class27_output";
static int g_meta_modo = 0;   // 0 = sombra · 1 = aplica la amortiguación

// ── El par class40 + class41 como VOTANTES (26-sep-2026) ────────────────────
// class40 publica su pronóstico en un canal PROPIO (`class40_forecast`) para no
// pisar a class44/class45, que ya usan `class40_output` como proxy de crisis.
static const std::string CH_FC40 = "class40_forecast";

// CLASS25A_VOTANTE_CRISIS=1 los mete en el ensamble como una red más, con el
// MISMO patrón que class44 (g_lstm_modo): entran ANTES del ensamble para heredar
// peso adaptativo, atribución de crédito y presencia en el payload.
//
// ⚠️ Apagado por defecto. Encenderlo cierra un lazo con ganancia: el pronóstico
// y el riesgo pasan a influir decisiones que influyen la serie de precios de la
// que salen. Leer «El par class40 + class41» en las notas internas antes.
static int g_votante_crisis = 0;

// CLASS25A_META_K=1 deja que class27 module CUÁNTAS señales se emiten.
//
// POR QUÉ ASÍ y no como votante: `metaFactor` es GLOBAL —overconfidence y
// quality_drop son propiedades del razonamiento, no de un instrumento— y
// multiplicar todos los z por la misma constante positiva PRESERVA EL ORDEN.
// Un ranking es invariante a escala: ninguna señal global puede cambiar quién
// sale BUY o SELL. Lo que sí puede cambiar, y es lo que un meta-monitor debería
// hacer, es cuántos: con el razonamiento degradado, emitir menos.
static int g_meta_k = 0;

// Contadores para el chequeo: cuánto aporta cada votante nuevo.
static std::atomic<uint64_t> g_v40_usos{0}, g_v41_usos{0}, g_metak_recortes{0};
static std::atomic<uint64_t> g_v40_sin_ticker{0}, g_v41_sin_ticker{0};

// Amortiguación que se aplicaría a la confianza con cada patrón activo.
static constexpr double META_DAMP_OVERCONF = 0.85;
static constexpr double META_DAMP_QDROP    = 0.92;
static constexpr int64_t META_TTL_MS       = 180000;   // 3 min: class27 emite c/30s
static constexpr size_t  META_DEDUP_MAX    = 256;

struct MetaEstado {
    std::mutex mtx;
    bool     overconfidence = false;
    bool     quality_drop   = false;
    int64_t  ts_ms          = 0;
    std::deque<std::string> orden;        // FIFO de hashes, para acotar el set
    std::set<std::string>   vistos;
};
static MetaEstado g_meta;

static int64_t ahora_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

// Factor que se APLICARÍA (o se aplica, si g_meta_modo=1). 1.0 = sin efecto.
static double metaFactor(bool& over_out, bool& drop_out) {
    std::lock_guard<std::mutex> lk(g_meta.mtx);
    over_out = drop_out = false;
    if (g_meta.ts_ms == 0) return 1.0;
    // Una reflexión vieja no describe el estado actual del razonamiento.
    if (ahora_ms() - g_meta.ts_ms > META_TTL_MS) return 1.0;
    over_out = g_meta.overconfidence;
    drop_out = g_meta.quality_drop;
    double f = 1.0;
    if (over_out) f *= META_DAMP_OVERCONF;
    if (drop_out) f *= META_DAMP_QDROP;
    return f;
}

// class44 publica cada ~10 min por ticker y class21-24 llegan por vector, así
// que casi nunca caen en la misma ventana de 5 s. Por eso no se guarda en
// `redes` (que exige coincidencia temporal) sino cacheada por ticker, igual que
// las señales de crisis. TTL generoso porque su horizonte es de 24 h.
static constexpr int LSTM_TTL_MIN = 120;

struct SenalLstm {
    double score_dir = 0.5;   // direccional: 0 bajista · 0.5 neutro · 1 alcista
    double conf      = 0.0;   // prob de la clase ganadora (NO direccional)
    std::string senal;        // BUY / SELL / HOLD
    std::chrono::steady_clock::time_point ts{};
};

// ── Configuración ──────────────────────────────────────────
static constexpr double UMBRAL_BASE    = 0.42;
static constexpr double UMBRAL_MIN     = 0.28;
static constexpr double UMBRAL_MAX     = 0.70;

// ── Umbral por MAGNITUD (rompe el sesgo HOLD/BUY) ──────────
// score_final es DIRECCIONAL: 0 = bajista, 0.5 = neutro, 1 = alcista.
// Compararlo contra un umbral POR ARRIBA sólo detecta convicción alcista:
// un bajista fuerte (0.15) no supera el umbral y sale HOLD. Midiendo la
// DISTANCIA al neutro, las dos direcciones se tratan igual.
//
// Ambos parámetros se leen del entorno para poder ajustar o REVERTIR en
// producción sin recompilar (el binario es un .exe que hay que cross-buildear):
//   CLASS25A_UMBRAL_MAGNITUD=0  → vuelve exactamente al comportamiento viejo
//   CLASS25A_MARGEN_MAX=0.15    → más conservador (menos señales)
//   CLASS25A_NEUTRO=0.47        → centro de la banda (ver abajo)
static constexpr double MARGEN_MIN     = 0.02;   // piso: nunca emitir en el ruido del neutro
static double g_margen_max      = 0.20;
static bool   g_umbral_magnitud = true;

// ── Centro de la banda (neutro empírico) ───────────────────
// v2.2 asumía que el neutro de score_final era 0.5. En producción resultó
// estar en ~0.47: con la banda simétrica en 0.5, SELL quedaba a 0.011 de
// distancia y BUY a 0.051 → 41% SELL y 0% BUY. Se cambió un sesgo por el
// opuesto. El centro ahora es configurable.
//
// CÓMO ELEGIRLO: usar `score_medio` (media móvil que se loguea y se publica
// en cada decisión) leída sobre DÍAS, no minutos. En ventana corta esa media
// refleja la dirección real del mercado, no el sesgo del ensemble — fijar el
// centro con un pantallazo borraría información direccional legítima.
// Default 0.5 = comportamiento v2.2 (no cambia nada hasta configurarlo).
static double g_neutro = 0.5;

// Peso máximo de la memoria bayesiana en el score final. Configurable para
// poder APAGARLA en producción (=0) sin recompilar: es la capa con más
// historia de bugs de las cinco, y durante una corrida larga y desatendida
// conviene poder neutralizarla desde el entorno.
static double g_bayes_peso_max = 0.30;

// Media móvil de score_final (acumulada desde el arranque) para calibrar
// g_neutro con evidencia en vez de a ojo.
static std::mutex g_score_mtx;
static double     g_score_sum = 0.0;
static long long  g_score_n   = 0;

// ════════════════════════════════════════════════════════════════════════
// AUTO-CALIBRACIÓN DEL NEUTRO
// ════════════════════════════════════════════════════════════════════════
//
// El centro de la banda se corre solo: a medida que class23/24 entrenan, sus
// salidas se mueven y con ellas la media de score_final. Un neutro fijo queda
// viejo en días y una de las dos señales se muere de hambre — ya pasó dos veces
// (0.533 con la escala vieja, 0.709 con la del ensemble agregado).
//
// QUÉ SEÑAL SE USA: la media de score_final de la ÚLTIMA VENTANA, no los
// aciertos. El centro es una pregunta de distribución. Calibrar con aciertos
// correría el centro hacia la dirección que más acierta — o sea, hacia la
// tendencia dominante del mercado: perseguir beta en vez de corregir la banda.
// (Los aciertos SÍ gobiernan el margen, en la recalibración de g_umbral.)
//
// GUARDS, para no perseguir ruido:
//   · mínimo de muestras en la ventana
//   · solo mueve si el desvío supera un piso
//   · amortiguación 50/50 contra el valor vigente
//   · clamp al mismo rango que acepta la variable de entorno
//
// El valor calibrado se PERSISTE: si no, cada reinicio volvería al valor del
// entorno, que es justamente el que quedó viejo.
static double g_auto_neutro_h   = 72.0;   // horas entre calibraciones (0 = off)
// ¿Se APLICA lo que mide la calibración, o sólo se informa? Desde el 21-sep-2026
// sólo se informa: con la decisión en z y el ranking transversal, el neutro no
// toca ninguna decisión de instrumento, y aplicarlo sólo hacía derivar un número
// que después nadie podía comparar entre semanas. CLASS25A_APLICAR_NEUTRO=1
// vuelve al comportamiento anterior sin recompilar.
static bool   g_aplicar_neutro  = false;
static constexpr long long AUTO_NEUTRO_MIN_MUESTRAS = 500;
static constexpr double    AUTO_NEUTRO_MIN_DESVIO   = 0.010;  // < esto es ruido
static constexpr double    AUTO_NEUTRO_AMORTIGUA    = 0.50;   // peso del valor nuevo
static fs::path   g_neutro_file;

// ── Horizonte de verificación en modo DEBUG ────────────────────────────
// El horizonte normal sale de la confianza (24/48/72 h, más abajo). Con
// CLASS25A_HORIZONTE_DEBUG_H=1 todas las decisiones se emiten con horizonte
// de 1 h, para que el lazo class43 → class25a_feedback → class23/24 se
// ejercite en una hora en vez de dos días. Sirve para depurar el matcheo
// (hoy `sin match` ≈ 86 %), NO para medir.
//
// Por qué no es un horizonte de medición: dos decisiones sobre el mismo
// ticker separadas por una hora no son apuestas independientes aunque sus
// ventanas no se solapen — comparten régimen intradiario y microestructura.
// Además `n_efectivo` en miia_chatbot.py divide por 172800 s (48 h): con
// horizonte de 1 h ese divisor deja de corresponder al horizonte real.
// Ver la nota de despliegue antes de tocar ese número.
//
// 0 = desactivado (comportamiento normal). Reversible sin recompilar.
static int g_horizonte_debug_h = 0;
static std::chrono::steady_clock::time_point g_ultima_calib;

// Persistencia del neutro auto-calibrado.
//
// Epoch en segundos. Se persiste junto al neutro porque steady_clock —el reloj
// con el que se mide el intervalo entre calibraciones— arranca de cero en cada
// proceso y no sobrevive a un reinicio.
static long long epoch_s() {
    return std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

static void guardarNeutro(double v, double media, long long n) {
    try {
        json j = {{"neutro", v}, {"score_medio_ventana", media},
                  {"muestras", n}, {"ts", now_iso()},
                  // `ts` es para que lo lea un humano; `ts_epoch` es el que usa
                  // cargarNeutro para saber cuánto falta para la próxima
                  // calibración. Parsear el ISO de vuelta sería más frágil.
                  {"ts_epoch", epoch_s()}};
        std::ofstream out(g_neutro_file); out << j.dump(2);
    } catch (...) {}
}

// Devuelve el neutro persistido y, en `horas_desde`, cuánto pasó desde que se
// calibró. -1 si el archivo viene de una versión anterior y no tiene ts_epoch.
static bool cargarNeutro(double& destino, double& horas_desde) {
    horas_desde = -1.0;
    try {
        if (!fs::exists(g_neutro_file)) return false;
        std::ifstream in(g_neutro_file); json j; in >> j;
        double v = j.value("neutro", -1.0);
        if (v >= 0.20 && v <= 0.90) {
            destino = v;
            const long long ts = j.value("ts_epoch", 0LL);
            if (ts > 0 && ts <= epoch_s()) horas_desde = (double)(epoch_s() - ts) / 3600.0;
            return true;
        }
    } catch (...) {}
    return false;
}

// ── Snapshot de redes por decisión (atribución de feedback) ─
// class43 verifica la DECISIÓN del ensemble, no cada red por separado: su
// feedback dice "esta decisión acertó", no "class24 acertó". Para repartir
// crédito hay que recordar qué dijo cada red en ese momento. Se indexa por
// hash_condicion, que es lo que vuelve en el feedback.
//
// ════ ORDEN 3 — un caché de 4 h servía un lazo de 48 h ════
//
// EL DEFECTO. Era `map<hash, SnapRedes>` con MAX_SNAPS=800 y una sola
// ranura por hash. A ~4.300 decisiones/día, 800 ranuras se reciclan en
// ~4,5 horas. El feedback de class43 llega al vencer el horizonte: 48 h
// después. Para entonces la entrada estaba, o bien desalojada, o bien
// PISADA por una decisión mucho más nueva del mismo bucket
// (`g_snaps[hash] = ...` sobreescribía).
//
// Las dos fallas eran mudas:
//   · desalojada  → `snap` vacío → el for no itera → CERO actualización de
//                   pesos, y el log "⚖️ Atribución local" solo se imprime
//                   `if (!snap.empty())`;
//   · sobreescrita → el crédito se aplicaba a los scores de OTRA decisión.
//
// Esa es la razón estructural de que los pesos por sub-red midan
// exactamente PESO_INICIAL: la capa 2 de atribución —la ÚNICA que reparte
// por sub-red, y la que corre siempre porque la reconciliación no manda
// `red`— casi nunca encontraba su snapshot. No es falta de entrenamiento;
// más tiempo no lo arregla.
//
// EL ARREGLO. (a) ts en epoch millis, comparable con el decision_ts que
// ahora manda class43; (b) una COLA por hash en vez de una ranura, así una
// decisión nueva no pisa a la vieja que todavía espera su outcome; (c) se
// elige la entrada más cercana al decision_ts y se CONSUME; (d) expiración
// por TTL de 80 h (igual que el pending de class24, > horizonte de 72 h)
// además del tope global.
struct SnapRedes {
    std::map<std::string,double> scores;   // red → score al decidir
    int64_t                      ts_ms;    // epoch millis (comparable con decision_ts)
};
static std::mutex g_snap_mtx;
static std::map<std::string, std::deque<SnapRedes>> g_snaps;
// Tope GLOBAL de snapshots vivos. A 4.300/día, 50.000 son ~11 días — muy por
// encima del horizonte de 72 h. Cada entrada es un mapa de ~10 doubles.
static constexpr size_t MAX_SNAPS       = 50000;
// Tope POR HASH. Era 64, y esa es la causa más probable del defecto 3: un
// hash con ~2-3 decisiones/hora llena 64 lugares en ~24 h, así que cuando
// el feedback llega a las 48 h la entrada correcta ya fue desalojada y se
// elige otra (lag medido: −21 a −25 h). Con el tope igual al global, lo que
// gobierna es el TTL de 80 h y MAX_SNAPS: ~7.500 decisiones/día × 80 h ≈
// 25.000 entradas, la mitad del presupuesto.
static constexpr size_t MAX_SNAPS_HASH  = MAX_SNAPS;
static constexpr int64_t SNAP_TTL_MS    = 80LL * 60 * 60 * 1000;
static size_t g_snaps_total = 0;   // protegido por g_snap_mtx

// ── Capa 2: línea de base por red y reparto de suma cero (11-sep-2026) ──
//
// ESCALA. La capa 2 decidía si una red "se inclinaba al alza" comparando su
// score contra g_neutro — UNA constante para todas. Las redes no comparten
// escala (class22/portfolio vive en 0,93-0,95; class24/cluster en 0,20-0,26):
// una era "alcista" el 100 % de las veces y otra "bajista" el 100 %. No
// opinaban: informaban su escala. Ahora cada red se compara contra SU propia
// media y desvío, sobre los mismos scores que van al snapshot. Vive en memoria:
// tras un reinicio cada red necesita CAPA2_MIN_MUESTRAS antes de volver a
// cobrar (~1 h con el mercado abierto).
//
// ── BASE CON OLVIDO — EWMA (21-sep-2026) ──────────────────────────────────
//
// Era un acumulador de Welford desde el arranque del proceso, SIN OLVIDO. Eso
// producía el defecto que se veía todos los días: medido el 14-sep de 16:34 a
// 22:34 CEST, la emisión fue 46 % -> 3,8 % -> 52 % -> 14 % mientras el umbral
// se movía sólo entre 0,402 y 0,467. El diagnóstico de ese día: «g_base es
// media y desvío acumulados desde el sábado 04:00, casi todo de fin de semana,
// y no representa la rueda».
//
// Y no es sólo la emisión. El z contra esta base decide DOS cosas: el ORDEN del
// ranking transversal —quién sale BUY y quién SELL— y a quién le cobra la capa
// 2. Una red que cambia de nivel (class24/mercado hizo ema 0,89 -> 0,02 -> 0,37
// -> 0,63 -> 0,009 en una semana) deja a la base acumulada midiendo otra cosa.
//
// Media y varianza exponenciales (West 1979):
//     d    = x - media
//     incr = a * d
//     media += incr
//     var    = (1 - a) * (var + d * incr)
//
// El alfa efectivo arranca en 1/n y recién baja al fijo cuando 1/n cae por
// debajo. Sin eso las primeras muestras arrastrarían el cero inicial, y la red
// tardaría en tener base creíble justo después de un reinicio — que es cuando
// más importa, porque g_base vive en memoria y se pierde al reiniciar.
//
// DE DÓNDE SALE LA VIDA MEDIA (ver docs/simulaciones/sim15_base_ewma.py):
// la exigencia es que UNA RUEDA alcance para olvidar el fin de semana. Una
// rueda son ~13.000 actualizaciones por clave (medido el 14-sep: 11.822
// decisiones en 6 h). El 90 % de un escalón son 3,32 vidas medias, así que
// 13.000 / 3,32 ≈ 3.900; se redondea a 5.000, que deja el 90 % en ~1,3 ruedas.
// Se prefiere el lado LENTO a propósito: olvidar de más deja el z en ruido de
// estimación, y eso no aparece en ningún contador — se ve como un ranking que
// ordena cualquier cosa.
//
// CLASS25A_BASE_VIDA_MEDIA=0 vuelve al acumulador sin olvido, sin recompilar.
struct BaseRed { uint64_t n = 0; double media = 0, var = 0; };
static std::map<std::string, BaseRed> g_base;          // protegido por g_snap_mtx
static double g_base_vida_media = 5000.0;              // en MUESTRAS, no en horas
static double g_base_alpha      = 0.0;                 // se deriva al arrancar

// Una sola definición del desvío: las dos lecturas del z —la decisión y la capa
// 2— tienen que usar exactamente la misma, o estarían juzgando contra escalas
// distintas sin que nada lo avise.
static inline double desvioBase(const BaseRed& b) {
    return b.var > 0 ? std::sqrt(b.var) : 0.0;
}

static inline void observarBase(BaseRed& b, double x) {
    b.n += 1;
    const double a    = std::max(g_base_alpha, 1.0 / (double)b.n);
    const double d    = x - b.media;
    const double incr = a * d;
    b.media += incr;
    b.var    = (1.0 - a) * (b.var + d * incr);
}
static constexpr uint64_t CAPA2_MIN_MUESTRAS = 50;
static constexpr double   CAPA2_Z_MIN        = 0.25;   // zona muerta: no opinó
// PRESENCIA. Ver Pesos::actualizarEvento().
static constexpr double   CAPA2_ETA_OK       = 0.01;   // 5 veces menos que el delta de actualizar()
static constexpr double   CAPA2_ETA_ERR      = 0.006;  //   (misma proporción 5:3)
static constexpr double   CAPA2_PISO_REL     = 0.05;   // 5 % de una parte igual del evento
static constexpr double   CAPA2_MEZCLA       = 0.0005; // 0,05 % hacia la media del evento
// Tasa y mezcla elegidas por SIMULACIÓN (11-sep): 16 redes, 4 por evento, la
// tasa real de verificación (~2.200 eventos/día). "Ruido" = la mayor cuando
// ninguna red tiene ventaja, en veces el reparto parejo; "señal" = una red
// que acierta 55 % sobre la mediana, a los 45.000 eventos (~1-oct):
//   eta .05/.03  sin mezcla     ruido 4,1x  señal 46x   (ruido demasiado alto)
//   eta .01/.006 sin mezcla     ruido 2,5x  señal 49x   (el ruido sigue creciendo)
//   eta .01/.006 mezcla 0,05 %  ruido 1,4x  señal 5,3x  <- ELEGIDA: acotada
//   eta .01/.006 mezcla 0,1 %   ruido 1,3x  señal 2,6x  (aplasta la señal)
// Consecuencia buscada: los pesos se mueven MUCHO más despacio que antes. Que
// casi no cambien de un día para otro es el diseño, no una rotura.
// SNAPSHOT EQUIVOCADO (defecto 3). Holgado a propósito: el match correcto da
// lag ≈ 0; 3 h tolera un corrimiento de zona horaria sin dejar pasar los −21 h.
static constexpr int64_t  CAPA2_LAG_MAX_MS   = 3LL * 3600 * 1000;

// ── DECISIÓN EN Z (12-sep-2026) ────────────────────────────────────────────
//
// El ensemble promediaba scores CRUDOS de redes con escalas distintas y
// comparaba ese promedio contra UNA constante (g_neutro). Un snapshot real del
// 11-sep: class21/portfolio 0,881 · class22/portfolio 0,894 · class23/portfolio
// 0,450 · class24/portfolio 0,243. Cada red aportaba su escala, no su opinión,
// así que el centro se movía según QUÉ redes estaban presentes en la ventana.
// Simulado con las medias y desvíos medidos: el centro se corre 0,44 desvíos
// entre la composición de rueda y la de mercado cerrado, y el sesgo se da
// vuelta. Medido en producción: el viernes 11-sep en rueda salieron 8 BUY
// contra 2.485 SELL; el jueves con el mercado cerrado, 428 BUY contra 4 SELL.
//
// Ahora cada red entra en z contra SU propia media (g_base, la misma línea de
// base que usa la capa 2) y el z del ensemble se remapea al 0-1 de siempre
// alrededor de g_neutro. Aguas abajo NO cambia nada: hash bayesiano, score,
// confianza, distancia_neutro, class25B y el panel siguen en la misma escala.
// De paso desaparece el lazo del neutro (defecto 7): score_medio queda centrado
// en g_neutro por construcción, así que la auto-calibración ya no persigue un
// blanco que ella misma mueve.
static constexpr uint64_t DEC_Z_MIN_MUESTRAS = 50;   // igual que la capa 2
static constexpr int      DEC_Z_MIN_MODULOS  = 2;    // con menos, promedio crudo
static double             g_escala_z         = 0.10; // CLASS25A_ESCALA_Z
static std::atomic<uint64_t> g_dec_z{0}, g_dec_crudo{0};

// ══ RANKING TRANSVERSAL (21-sep-2026) ═════════════════════════
//
// El problema que arregla, medido el 15-sep: **MIIA emitió BUY en los 13
// instrumentos a la vez.** En una pregunta relativa eso es contradictorio — no
// pueden los 13 superar a su propio promedio. La causa está en la decisión:
// cada instrumento se compara contra su propia historia (`g_base`, su z) y
// **nunca contra los otros doce**. No había sección transversal en ningún punto
// de la cadena.
//
// La regla nueva: se guarda el último z de cada instrumento con su hora, y al
// decidir sobre uno se mira su PUESTO entre los que tienen z fresco. BUY a los
// k mejores, SELL a los k peores, HOLD al medio.
//
// Tres cosas que esto arregla por construcción, sin parámetros que calibrar:
//
//   1. **La mezcla queda simétrica.** Siempre hay tantos BUY como SELL. El
//      techo del edge sube de ~24 pp (con 76 % SELL, el 15-sep) a ~50 pp.
//   2. **Se cancela la beta.** Comprando los k mejores y vendiendo los k peores
//      de la MISMA ventana, el movimiento común del mercado se va. Es lo que
//      explicaba el patrón monótono de Q1 a Q4 del `beta_test2`.
//   3. **La confianza deja de estar atada a la dirección.** Pasa a ser la
//      distancia del puesto a la mediana: simétrica por definición. Arregla que
//      el balde de 48 h fuera todo BUY (23.063 decisiones, ni una SELL).
//
// **GENERAL no emite.** No tiene sección transversal contra qué compararse, y su
// resultado es justamente la etiqueta «¿subió el mercado?» que contaminó a
// class24 (ver defecto 10). Sin sección no se decide: HOLD.
//
// ⚠️ **Va JUNTO con el defecto 10, nunca antes.** El ranking ordena los scores;
// si las redes no pueden distinguir instrumentos, ordena ruido. La simulación
// sobre el historial dio IC ≈ 0,04 sin significancia, coherente con eso.
//
// Se apaga sin recompilar con CLASS25A_RANKING=0, igual que CLASS25A_ESCALA_Z.
static bool               g_ranking        = true;       // CLASS25A_RANKING
static int                g_rank_min       = 10;         // CLASS25A_RANK_MIN
// k = fracción × n, redondeado, mínimo 1. Con 13 instrumentos da k=2, o sea
// 4 de 13 emitidas = **31 % de emisión**, cerca del objetivo histórico de 25 %.
// Con 100 instrumentos, k=15 y la emisión queda igual: la regla escala sola.
static double             g_rank_fraccion  = 2.0 / 13.0; // CLASS25A_RANK_FRAC
// La misma ventana que usan class23/24 para emparejar feedback. Un z más viejo
// que esto ya no representa al instrumento en este momento.
static constexpr int64_t  RANK_VENTANA_MS  = 15 * 60 * 1000;

struct ZInstr { double z; int64_t ts_ms; };
static std::map<std::string, ZInstr> g_xsec;
static std::mutex                    g_xsec_mtx;
static std::atomic<uint64_t> g_rank_buy{0}, g_rank_sell{0}, g_rank_hold{0},
                             g_rank_sin_seccion{0}, g_rank_agregado{0};
// Feedbacks que traen el campo `red`. Desde el 12-sep class43 manda "" en sus
// dos caminos, así que esto tiene que quedarse en CERO. Si sube, alguien volvió
// a mandar la atribución por módulo y hay que revisarla antes de usarla: la
// regla vieja que la consumía está retirada (ver el handler de CH_FB).
static std::atomic<uint64_t> g_fb_con_red{0};

// ── UMBRAL POR TASA DE EMISIÓN (12-sep-2026) ───────────────────────────────
//
// La regla vieja subía 0,03 si el acierto de las últimas 100 verificaciones
// caía abajo de 45 %, y bajaba 0,02 sólo arriba de 65 %. Con un sistema que
// acierta ~50 % —lo que vale por construcción en la pregunta relativa— la
// muestra cae abajo de 45 % el ~16 % de las veces y pasa 65 % el ~0,1 %.
// Simulado con la regla exacta: 153 subidas contra 1 bajada, el umbral pegado
// al techo 0,70 en menos de 12 h y la emisión en 0,1 %. Era un trinquete, no
// una calibración, y es lo que dejó a MIIA sin emitir el viernes 11-sep.
//
// Ahora el umbral persigue una TASA DE EMISIÓN objetivo (25 % de las
// decisiones: el cuartil más confiable, que es donde la evaluación offline
// encontró la ventaja). Es estacionaria y no depende de que el acierto supere
// un valor imposible. Simulado con desvíos de 0,03, 0,059 y 0,12: converge
// desde 0,42 o desde 0,70 en menos de 6 h y queda estable en ±0,015.
// El acierto se sigue midiendo y logueando; lo que ya no hace es mover nada.
static double             g_emision_obj    = 0.25;   // CLASS25A_EMISION_OBJ
static constexpr int      EMISION_CADA     = 200;    // decisiones entre ajustes
static constexpr size_t   EMISION_VENTANA  = 1000;   // ~70 min de decisiones
static constexpr size_t   EMISION_MIN      = 200;    // no ajustar con menos
static constexpr double   EMISION_PASO     = 0.005;
static constexpr double   EMISION_BANDA    = 0.05;   // zona muerta relativa
static std::deque<bool>   g_emitidas;
static std::mutex         g_emision_mtx;
static fs::path           g_umbral_file;
// El umbral SÍ se persiste. Antes arrancaba siempre en UMBRAL_BASE y daba
// igual, porque el trinquete lo devolvía al techo en pocas horas.
static void guardarUmbral(double u, double tasa) {
    try {
        json j = {{"umbral", u}, {"tasa_emision", tasa},
                  {"objetivo", g_emision_obj}, {"ts", now_iso()},
                  {"ts_epoch", epoch_s()}};
        std::ofstream out(g_umbral_file); out << j.dump(2);
    } catch (...) {}
}
static bool cargarUmbral(double& destino) {
    try {
        if (!fs::exists(g_umbral_file)) return false;
        std::ifstream in(g_umbral_file); json j; in >> j;
        const double v = j.value("umbral", -1.0);
        if (v >= UMBRAL_MIN && v <= UMBRAL_MAX) { destino = v; return true; }
    } catch (...) {}
    return false;
}

static constexpr int    VENTANA_MS     = 5000;   // ms para acumular señales
static constexpr int    RECALIB_CADA   = 50;     // decisiones entre recalibraciones
static constexpr double PESO_INICIAL   = 0.25;

// ── Persistencia ────────────────────────────────────────────
// Pesos y memoria bayesiana en JSON (sin MySQL desde C++)
static fs::path g_pesos_file;
static fs::path g_bayes_file;
static fs::path g_historial_file;

// ── Estado global ────────────────────────────────────────────
struct Pesos {
    std::map<std::string,double> w = {
        {"class21",PESO_INICIAL},{"class22",PESO_INICIAL},
        {"class23",PESO_INICIAL},{"class24",PESO_INICIAL},
        // class44 (LSTM). Se declara siempre para que exista su peso desde el
        // primer día y la adaptación pueda moverlo; solo participa del ensemble
        // si CLASS25A_LSTM_MODO=1 (por defecto entra en sombra).
        {"class44",PESO_INICIAL}
    };
    mutable std::mutex mtx;

    void cargar(const fs::path& f) {
        try {
            if (!fs::exists(f)) return;
            std::ifstream in(f); json j; in >> j;
            std::lock_guard<std::mutex> lk(mtx);
            // Se aceptan claves nuevas (las sub-redes "class24/impacto" no están
            // predeclaradas), pero solo con un valor numérico en rango.
            for (auto& [k,v] : j.items()) {
                if (!v.is_number()) continue;
                const double val = v.get<double>();
                if (val > 0.0 && val <= 1.0) w[k] = val;
            }
            spdlog::info("[{}] Pesos cargados desde disco",TAG);
        } catch(...) {}
    }

    void guardar(const fs::path& f) const {
        try {
            std::lock_guard<std::mutex> lk(mtx);
            json j = w;
            std::ofstream out(f);
            out << j.dump(2);
        } catch(...) {}
    }

    // Alta perezosa: las sub-redes ("class24/impacto") aparecen recién cuando
    // publican por primera vez. Antes esto era `if (!w.count(red)) return;` y
    // cualquier clave no declarada quedaba sin adaptar para siempre.
    void actualizar(const std::string& red, bool acerto) {
        std::lock_guard<std::mutex> lk(mtx);
        if (red.empty()) return;
        if (!w.count(red)) w[red] = PESO_INICIAL;
        // Suavizado exponencial: w = w*0.95 + acierto*0.05
        double delta = acerto ? 0.05 : -0.03;
        w[red] = std::clamp(w[red] + delta * (1.0 - w[red]), 0.10, 0.50);
        // Renormalizar suma = 1.0
        double total = 0;
        for (auto& [k,v] : w) total += v;
        if (total > 0)
            for (auto& [k,v] : w) v /= total;
    }

    // Actualiza el módulo y TODAS sus sub-redes. class43 atribuye a nivel de
    // módulo ("class24"), así que sin esto el crédito explícito no llegaría a
    // las claves compuestas que ahora deciden.
    void actualizarPrefijo(const std::string& base, bool acerto) {
        if (base.empty()) return;
        std::vector<std::string> objetivos;
        {
            std::lock_guard<std::mutex> lk(mtx);
            for (auto& [k, v] : w)
                if (k == base || k.rfind(base + "/", 0) == 0) objetivos.push_back(k);
        }
        if (objetivos.empty()) objetivos.push_back(base);
        for (const auto& k : objetivos) actualizar(k, acerto);
    }

    // ── Actualización por EVENTO — suma cero entre participantes (11-sep-2026) ──
    //
    // DEFECTO (medido 10 y 11-sep): actualizar() renormaliza TODAS las claves
    // en cada llamada. La capa 2 acreditaba a las ~4 redes del snapshot y
    // dividía a las otras ~17, que no estaban: una red perdía peso por NO
    // ESTAR, no por equivocarse. Con el mercado cerrado `mercado` no publica,
    // no entra al snapshot y se hunde — 0,53 en rueda, 0,03 esa madrugada.
    // Los pesos seguían el horario de la bolsa, no el acierto.
    //
    // AHORA un evento sólo redistribuye peso ENTRE SUS PARTICIPANTES: la masa
    // de las redes del snapshot se conserva, las que acertaron le sacan a las
    // que fallaron y las ausentes quedan intactas. Si todas acertaron no hay
    // información relativa: sólo actúa la mezcla hacia la media (CAPA2_MEZCLA).
    //
    // Multiplicativo, (1+eta) / (1-eta), en vez del delta con piso 0,10: con
    // ese piso una red en 1e-12 saltaba a 0,10 la primera vez que aparecía
    // AUNQUE SE EQUIVOCARA (el clamp la levanta igual). Acá resucita sólo
    // acertando: el piso CAPA2_PISO_REL se aplica únicamente a las que acertaron.
    //
    // La capa 1 (actualizar / actualizarPrefijo) no cambia.
    void actualizarEvento(const std::vector<std::pair<std::string,bool>>& ups) {
        if (ups.empty()) return;
        std::lock_guard<std::mutex> lk(mtx);
        // Una clave nueva entra con la media de las que ya existen: darle
        // PESO_INICIAL de golpe le regalaría voz por el solo hecho de aparecer.
        double masa = 0; int existentes = 0;
        for (const auto& u : ups) if (w.count(u.first)) { masa += w[u.first]; existentes++; }
        const double alta = existentes ? masa / existentes : PESO_INICIAL;
        for (const auto& u : ups) if (!w.count(u.first)) { w[u.first] = alta; masa += alta; }
        if (!(masa > 0)) return;

        std::map<std::string,double> nuevo;
        double suma = 0;
        for (const auto& u : ups) {
            const double v = w[u.first] * (u.second ? 1.0 + CAPA2_ETA_OK : 1.0 - CAPA2_ETA_ERR);
            nuevo[u.first] = v; suma += v;
        }
        if (!(suma > 0)) return;
        for (auto& kv : nuevo) kv.second *= masa / suma;      // conserva la masa del evento

        // Mezcla hacia la media del evento ("fixed share"). Controla cuánto se
        // concentra el peso por AZAR cuando ninguna red tiene ventaja; conserva la
        // masa del evento. El valor sale de simular con la tasa de verificación real
        // (ver CAPA2_ETA_OK): mezclar de más aplasta también la ventaja verdadera.
        if (CAPA2_MEZCLA > 0) {
            const double media = masa / (double)nuevo.size();
            for (auto& kv : nuevo) kv.second = (1.0 - CAPA2_MEZCLA) * kv.second + CAPA2_MEZCLA * media;
        }

        // Piso sólo para las que acertaron, financiado por el resto del evento.
        const double piso = CAPA2_PISO_REL * masa / (double)nuevo.size();
        double levantado = 0;
        std::set<std::string> alzadas;
        for (const auto& u : ups)
            if (u.second && nuevo[u.first] < piso) {
                levantado += piso - nuevo[u.first];
                nuevo[u.first] = piso; alzadas.insert(u.first);
            }
        if (levantado > 0) {
            double resto = 0;
            for (const auto& kv : nuevo) if (!alzadas.count(kv.first)) resto += kv.second;
            if (resto > levantado)
                for (auto& kv : nuevo) if (!alzadas.count(kv.first)) kv.second *= (resto - levantado) / resto;
        }
        for (const auto& kv : nuevo) w[kv.first] = kv.second;
    }

    json toJson() const {
        std::lock_guard<std::mutex> lk(mtx);
        return json(w);
    }
};

// Señal de una red neuronal
struct Señal {
    std::string red;
    std::string ticker;
    double      score     = 0.0;
    double      confianza = 0.0;
    std::string tendencia;  // "positiva"|"negativa"|"neutra"
    double      riesgo    = 0.5;
    std::string ts;
    json        raw;
    // false = la red no publicó score/confianza y se usó el default 0.5.
    // Sirve para detectar contratos rotos en vez de tragarlos en silencio:
    // una red sin score mete una CONSTANTE en el ensemble.
    bool        tiene_score = false;
    // Sub-red de origen dentro del módulo ("mercado", "impacto", …). class23 y
    // class24 la publican en el nivel superior; class21/22/44 no la tienen.
    std::string fuente;
};

// ════════════════════════════════════════════════════════════════════════
// ORDEN 1 — UNA VENTANA POR INSTRUMENTO
// ════════════════════════════════════════════════════════════════════════
//
// ANTES: una sola ventana global cuya clave era la RED ("class21".."class24").
// Como class21-24 procesan lo que les llega sin importar de qué instrumento
// venga, una misma decisión podía promediar class21 mirando el vector de
// portfolio, class23 el de mercado y class24 un texto de noticias. El ticker
// que terminaba en la salida era simplemente el último no-GENERAL que hubiera
// entrado en esos 5 segundos.
//
// AHORA: `porTicker[ticker].redes[red]`. Cada instrumento acumula sus propias
// 4 señales y produce SU decisión. Con 13 instrumentos eso da 13 decisiones
// por ciclo en vez de 1 — que es lo que hace que n_efectivo crezca 13× y que
// el edge pase a ser medible.
struct VentanaTicker {
    std::map<std::string,Señal>            redes;   // class21-24 de ESTE ticker
    std::chrono::steady_clock::time_point  inicio;
};

// Pronóstico (class40) o riesgo (class41) de UN instrumento.
struct SenalCrisisT {
    double score = 0.5;      // 0-1 direccional: >0.5 alcista
    double riesgo = 0.5;
    std::chrono::steady_clock::time_point ts{};
};

struct VentanaSignals {
    std::map<std::string, VentanaTicker>   porTicker;
    // Las señales de crisis son de MERCADO, no de instrumento: se comparten
    // entre todas las ventanas abiertas.
    json                           crisis40; // class40_output (proxy de class44/45)
    json                           crisis41; // class41_output (legacy, global)
    // El par REAL publica POR INSTRUMENTO, así que para que pueda mover puestos
    // hay que cachearlo por ticker — igual que lstm44. Con el caché global de
    // arriba todos los instrumentos recibían el mismo número y el aporte al
    // ranking habría sido exactamente cero.
    std::map<std::string, SenalCrisisT> fc40;  // class40_forecast, por ticker
    std::map<std::string, SenalCrisisT> rk41;  // class41_output,  por ticker
    // Última predicción del LSTM por instrumento (ver CH_LSTM arriba).
    std::map<std::string, SenalLstm> lstm44;
    mutable std::mutex             mtx;
    std::atomic<int>               total_decisiones{0};
    std::atomic<int>               aciertos_recientes{0};
    std::deque<bool>               historial_outcomes; // últimas 50
};

// Tope de ventanas simultáneas. El universo son 13 instrumentos + GENERAL;
// 64 deja margen para tickers del chat sin permitir crecimiento sin límite si
// aguas arriba empieza a llegar basura.
static constexpr size_t MAX_VENTANAS = 64;

// Memoria bayesiana en memoria + archivo
//
// ⚠ FIX v2.4 — DOBLE CONTEO (el bug que descentró la banda entera)
//
//   ANTES había UN solo registrar() y se lo llamaba DOS veces por decisión:
//     1) al EMITIR   → registrar(hash, false, ...)   // total++ , aciertos NO
//     2) al VERIFICAR→ registrar(hash, acerto, ...)  // total++ otra vez
//
//   Como `registrar` hacía `e.total++` en los dos casos, cada decisión sumaba
//   2 (o más) al denominador y como mucho 1 al numerador. Consecuencia
//   aritmética, no estadística:
//
//       prob_bayes = aciertos / total  ≤  0.50   SIEMPRE
//
//   ...incluso con 100% de acierto real. Con 77.7% de acierto y cobertura
//   parcial de feedback, prob_bayes vivía entre 0.18 y 0.39.
//
//   Y como peso_bayes satura en 0.30 casi siempre (hay solo 11×11×3 = 363
//   buckets de hash posibles, así que todos superan las 100 muestras rápido):
//
//       score_final = score_ens × 0.70 + (~0.30) × 0.30
//
//   ...el término bayesiano se comía el 30% del rango dinámico Y empujaba el
//   centro hacia abajo. Eso explica DOS síntomas que se venían tratando como
//   propiedades del mercado:
//     · el "neutro empírico ≈ 0.47" (no es el mercado: es este bug)
//     · el techo de |distancia_neutro| ≈ 0.19, que hacía inalcanzable el gate
//       SELL de 0.70 de class25B (exige |dist| ≥ 0.20)
//
//   AHORA hay dos métodos separados:
//     registrarEmision() → solo cuenta `emitidas` (diagnóstico, no mueve nada)
//     registrarOutcome() → único que toca aciertos/total
//
//   `emitidas` vs `total` es además la métrica que faltaba: si emitidas >> total
//   el lazo de feedback está roto de nuevo, y se ve de un vistazo.
struct BayesianMem {
    struct Entry { int aciertos=0; int total=0; int emitidas=0; std::string desc; };
    std::map<std::string,Entry> mem;
    mutable std::mutex mtx;

    // v3 = primer formato con el conteo arreglado. Todo lo persistido con
    // versión menor viene del bug y NO se puede migrar (no hay forma de saber
    // qué parte de `t` era emisión y qué parte verificación) → se descarta.
    static constexpr int VERSION = 3;

    void cargar(const fs::path& f) {
        try {
            if (!fs::exists(f)) return;
            std::ifstream in(f); json j; in >> j;

            int ver = 0;
            if (j.contains("__meta__") && j["__meta__"].is_object())
                ver = j["__meta__"].value("version", 0);

            if (ver < VERSION) {
                spdlog::warn("[{}] ⚠️ {} tiene formato v{} (< v{}): sus totales vienen "
                             "del bug de doble conteo — cada decisión sumaba 2 al "
                             "denominador y como mucho 1 al numerador, así que "
                             "prob_bayes era ≤ 0.50 por construcción. NO es migrable. "
                             "Se DESCARTA y la memoria arranca limpia.",
                             TAG, f.filename().string(), ver, VERSION);
                return;   // mem queda vacía → prob_bayes=0.5 y peso_bayes=0
            }

            std::lock_guard<std::mutex> lk(mtx);
            for (auto& [k,v] : j.items()) {
                if (k == "__meta__") continue;
                mem[k] = { v.value("a",0), v.value("t",0),
                           v.value("e",0), v.value("d",std::string("")) };
            }
            spdlog::info("[{}] Memoria bayesiana v{} cargada: {} condiciones",
                         TAG, ver, mem.size());
        } catch(...) {}
    }

    void guardar(const fs::path& f) const {
        try {
            std::lock_guard<std::mutex> lk(mtx);
            json j;
            j["__meta__"] = {{"version", VERSION}, {"ts", now_iso()}};
            for (auto& [k,e] : mem)
                j[k] = {{"a",e.aciertos},{"t",e.total},{"e",e.emitidas},{"d",e.desc}};
            std::ofstream out(f); out << j.dump(2);
        } catch(...) {}
    }

    // ORDEN 1: el TICKER entra en el hash.
    //
    // Antes la clave era (score, riesgo, tendencia): 11 × 11 × 3 = 363 buckets
    // posibles para TODO el sistema. Con un solo instrumento eso ya era grueso;
    // con 13 instrumentos compartiendo los mismos buckets, la "memoria de
    // condiciones similares" mezclaría XLK con ILF y `g_snaps[hash]` —que se usa
    // para repartir crédito entre class21-24— se pisaría entre tickers.
    std::string hashCondicion(double score, double riesgo, const std::string& tend,
                              const std::string& ticker) {
        // Cuantizar a rangos para agrupar condiciones similares
        int s_bucket = (int)(score * 10);          // 0-10
        int r_bucket = (int)(riesgo * 10);         // 0-10
        std::string key = ticker + ":" +
                          std::to_string(s_bucket) + ":" +
                          std::to_string(r_bucket) + ":" + tend;
        return fnv1a(key).substr(0, 12);
    }

    Entry consultar(const std::string& hash) {
        std::lock_guard<std::mutex> lk(mtx);
        auto it = mem.find(hash);
        return it != mem.end() ? it->second : Entry{};
    }

    // Se llama al EMITIR la decisión. NO toca aciertos/total: en ese momento
    // todavía no se sabe nada del resultado. Solo deja rastro de cuántas veces
    // se decidió bajo esta condición, para poder comparar contra `total`.
    void registrarEmision(const std::string& hash, const std::string& desc) {
        std::lock_guard<std::mutex> lk(mtx);
        auto& e = mem[hash];
        e.emitidas++;
        e.desc = desc;
    }

    // Se llama SOLO cuando class43 verificó el outcome contra precio real.
    // Es el único camino que mueve la probabilidad histórica.
    void registrarOutcome(const std::string& hash, bool acerto, const std::string& desc) {
        std::lock_guard<std::mutex> lk(mtx);
        auto& e = mem[hash];
        e.total++;
        if (acerto) e.aciertos++;
        if (!desc.empty()) e.desc = desc;
    }
};

// ── Globals ─────────────────────────────────────────────────
static Pesos         g_pesos;
static VentanaSignals g_ventana;
static BayesianMem   g_bayes;
static double        g_umbral = UMBRAL_BASE;
static std::mutex    g_umbral_mtx;

// ── Helpers de parseo ────────────────────────────────────────
// Normaliza el nombre del canal a la clave corta del mapa de pesos.
// BUG HISTÓRICO: se guardaba la señal con clave "class24_output" (el canal)
// pero el mapa de pesos usa "class24". Entonces pw.value("class24_output",…)
// NUNCA encontraba la clave y devolvía siempre el default 0.25, y
// Pesos::actualizar() salía en el `if (!w.count(red)) return;` sin hacer nada.
// Resultado: los 4 pesos congelados en 0.25 desde el día uno — el "ensemble
// ponderado con pesos dinámicos" era en realidad un promedio simple fijo.
static std::string normalizarRed(const std::string& canal) {
    const std::string suf = "_output";
    if (canal.size() > suf.size() &&
        canal.compare(canal.size() - suf.size(), suf.size(), suf) == 0)
        return canal.substr(0, canal.size() - suf.size());
    return canal;
}

// ── Clave del ensemble: "class24/impacto" ────────────────────────────────
//
// BUG (5-sep-2026): class23 y class24 mantienen CUATRO redes, una por fuente
// (mercado|64, cluster|12, portfolio|32, impacto|12), y publican UNA señal por
// cada una. class25A las guardaba todas en `redes[normalizarRed(ch)]`, o sea en
// una unica ranura llamada "class24": cada publicacion pisaba a la anterior y
// al cerrarse la ventana sobrevivia SOLO LA ULTIMA QUE LLEGO — elegida por el
// orden de entrega de Redis, no por ningun criterio.
// Efecto: tres de las cuatro opiniones se descartaban en silencio, y una red
// casi sin entrenar (impacto: 0.35 muestras/parametro) tenia la misma chance de
// decidir que una ajustada (mercado: 1.05). El ensemble sorteaba en vez de
// combinar.
static std::string claveEnsemble(const std::string& canal, const std::string& fuente) {
    const std::string base = normalizarRed(canal);
    return fuente.empty() ? base : base + "/" + fuente;
}

// Modulo de una clave compuesta: "class24/impacto" → "class24".
static std::string moduloDe(const std::string& clave) {
    const auto p = clave.find('/');
    return p == std::string::npos ? clave : clave.substr(0, p);
}

static Señal parsearSeñal(const std::string& red, const json& j) {
    Señal s;
    s.red      = normalizarRed(red);
    s.raw      = j;
    s.ts       = j.value("ts", now_iso());
    s.fuente   = j.value("fuente", j.value("data", json::object())
                                    .value("fuente", std::string("")));

    // ── Ticker (ORDEN 1) ─────────────────────────────────────────────────
    // El orden de búsqueda viejo terminaba en `j["origen"]`, que para todo lo
    // que viene de class19 vale "class19". Sumado a que class24 usaba
    // `j["source"]` como fallback, el 100% de las decisiones quedaba rotulado
    // "class19" — y class43, al ver que empieza con "class", las verificaba
    // contra el PROMEDIO del mercado en vez del precio del instrumento.
    // Los 13 tickers eran decorativos: el sistema hacía una sola predicción.
    //
    // Ahora class10 emite un vector por ticker con `symbol`, class19 lo
    // propaga y class23/24 lo etiquetan. Acá se lee de arriba primero.
    s.ticker = j.value("symbol",
               j.value("ticker",
               j.value("data", json::object()).value("symbol",
               j.value("data", json::object()).value("ticker", std::string("")))));
    // Cualquier resto del contrato viejo cae en GENERAL, que es honesto:
    // significa "señal sin instrumento", no "señal de un ticker llamado class19".
    if (s.ticker.empty() || s.ticker == "desconocido" ||
        s.ticker == "unknown" || s.ticker.rfind("class", 0) == 0)
        s.ticker = "GENERAL";

    // Score/confianza — se busca en el nivel superior Y anidado en "data".
    // BUG HISTÓRICO: class21/22 publican confianza/score arriba, pero class24
    // SOLO publica data.score y class23 no publicaba ninguno. Como acá se leía
    // únicamente el nivel superior, ambos caían al default 0.5 → el 50% del
    // ensemble era una CONSTANTE, y encima la única red con backprop real
    // (class24) nunca influyó en una decisión. El default silencioso lo ocultó.
    double sc = j.value("confianza", j.value("score", -1.0));
    if (sc < 0.0 && j.contains("data") && j["data"].is_object()) {
        const json& d = j["data"];
        sc = d.value("confianza", d.value("score", -1.0));
    }
    s.tiene_score = (sc >= 0.0);
    s.confianza   = s.tiene_score ? sc : 0.5;
    s.score       = s.confianza;

    // Tendencia desde senal o score
    std::string senal_str = j.value("senal", std::string(""));
    if (senal_str == "ALTA_CONFIANZA" || senal_str == "CONFIANZA_MEDIA")
        s.tendencia = s.score > 0.5 ? "positiva" : "negativa";
    else if (!senal_str.empty())
        s.tendencia = senal_str;
    else
        s.tendencia = s.score >= 0.55 ? "positiva" :
                      s.score <= 0.35 ? "negativa" : "neutra";

    // Riesgo
    if (j.contains("data") && j["data"].is_object())
        s.riesgo = j["data"].value("meta",json::object()).value("confianza_raw", s.confianza);
    else
        s.riesgo = 1.0 - s.confianza;

    return s;
}

// ── Generador de texto natural ───────────────────────────────
static std::string generarTexto(
    const std::string&            ticker,
    const std::string&            senal,
    double                        score_ensemble,
    double                        confianza,
    double                        riesgo,
    const std::map<std::string,Señal>& redes,
    const Pesos&                  pesos,
    const json&                   crisis40,
    const json&                   crisis41,
    const BayesianMem::Entry&     bayes,
    double                        umbral)
{
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2);

    // Encabezado: acción y movimiento
    std::string nivel_riesgo = riesgo > 0.65 ? "alto" :
                               riesgo > 0.40 ? "moderado" : "bajo";

    // Determinar qué red dominó
    std::string red_dom = "class21";
    double peso_max = 0;
    {
        auto pw = pesos.toJson();
        for (auto& [k,v] : pw.items()) {
            double p = v.get<double>();
            if (p > peso_max && redes.count(k)) { peso_max = p; red_dom = k; }
        }
    }

    // Tendencia dominante entre redes
    int pos=0, neg=0;
    double change_pct = 0;
    for (auto& [k,s] : redes) {
        if (s.tendencia == "positiva") pos++;
        else if (s.tendencia == "negativa") neg++;
        change_pct += s.score;
    }
    if (!redes.empty()) change_pct = (change_pct / redes.size() - 0.5) * 10.0;

    // Texto principal
    std::string direccion = senal == "BUY"  ? "subió" :
                            senal == "SELL" ? "bajó"  : "se mantuvo estable";

    ss << ticker << " " << direccion << " "
       << std::abs(change_pct) << " puntos porcentuales estimados. ";

    ss << "Riesgo " << nivel_riesgo << " (" << riesgo << "). ";

    // Redes
    ss << "Red dominante: " << red_dom << " (peso=" << peso_max << ", score=";
    if (redes.count(red_dom)) ss << redes.at(red_dom).score;
    ss << "). ";

    ss << pos << " de " << redes.size() << " redes indican tendencia positiva. ";

    // Forecast class40
    if (!crisis40.is_null() && crisis40.is_object()) {
        double prob40 = crisis40.value("prob_contraccion",
                        crisis40.value("confianza", 0.0));
        std::string tend40 = crisis40.value("tendencia",
                             crisis40.value("forecast", std::string("")));
        if (!tend40.empty())
            ss << "Forecast class40: " << tend40
               << " con probabilidad " << (int)(prob40*100) << "%. ";
    }

    // Riesgo class41
    if (!crisis41.is_null() && crisis41.is_object()) {
        double risk41 = crisis41.value("riesgo",
                        crisis41.value("risk_level", -1.0));
        if (risk41 >= 0)
            ss << "Riesgo sistémico class41: " << risk41 << ". ";
    }

    // Memoria bayesiana
    if (bayes.total > 0) {
        ss << "Memoria bayesiana: "
           << bayes.aciertos << " de " << bayes.total
           << " condiciones similares históricas confirmaron la señal. ";
    }

    // Umbral y confianza
    ss << "Señal emitida con confianza " << (int)(confianza*100) << "% "
       << "(ensemble=" << score_ensemble
       << " > umbral=" << umbral << ").";

    return ss.str();
}

// ── Lógica de decisión ───────────────────────────────────────
// ORDEN 1: procesa la ventana de UN instrumento. El ticker ya no se deduce de
// las señales (era "el último no-GENERAL que entró") — es la clave del grupo.
// ── ¿Es el agregado, sin sección transversal? ─────────────────
// Mismo criterio que `_esSenalDeMercado` de class43.js y que `canonSymbol` de
// class23/24: si los tres no coinciden, un instrumento cae en un lado de un
// módulo y en el otro del siguiente.
static bool esAgregado(const std::string& t) {
    if (t.empty() || t == "GENERAL" || t == "unknown") return true;
    if (t.size() >= 5) {
        std::string p5 = t.substr(0, 5);
        for (auto& c : p5) c = (char)std::tolower((unsigned char)c);
        if (p5 == "class") return true;
    }
    return false;
}

// Normaliza el ticker de un mensaje externo: MAYÚSCULAS, y vacío si es el
// agregado. Devolver "" y no "GENERAL" es deliberado — quien llama descarta,
// porque un pronóstico del agregado no puede mover un ranking por instrumento.
static std::string canonTicker(std::string t) {
    for (auto& c : t) c = (char)std::toupper((unsigned char)c);
    while (!t.empty() && (t.back() == ' ' || t.back() == '	')) t.pop_back();
    return esAgregado(t) ? std::string() : t;
}

// ── El puesto de un instrumento en la sección transversal ─────────
struct Puesto {
    bool   hay = false; // ¿había sección? (suficientes instrumentos con z fresco)
    double pos = -1;    // 0 = el mejor de la ventana. Fraccionario con empates.
    int  n   = 0;       // cuántos instrumentos compiten
    int  k   = 0;       // cuántos a cada punta
    double z = 0.0;
};

// Confianza por POSICIóN: distancia del puesto a la mediana, normalizada a
// [0,5 , 1]. Simétrica por construcción — el mejor y el peor de la ventana dan
// exactamente el mismo número. En una función aparte para que la simulación
// pueda verificar esa simetría sin levantar nada.
static double confianzaPorPuesto(const Puesto& p) {
    if (!p.hay || p.n <= 1) return 0.5;
    const double mediana = (p.n - 1) / 2.0;
    return std::clamp(0.5 + std::fabs(p.pos - mediana) / (double)(p.n - 1), 0.5, 1.0);
}

// Guarda el z de este instrumento y devuelve su puesto entre los que tienen z
// de los últimos RANK_VENTANA_MS. Está en una función con nombre —y no adentro
// de procesarVentana— para que la simulación la ejercite sin Redis, igual que
// `recolectarLote` en class23/24.
static Puesto ubicarEnSeccion(const std::string& ticker, double z, int64_t ahora) {
    Puesto p; p.z = z;
    std::lock_guard<std::mutex> lk(g_xsec_mtx);
    g_xsec[ticker] = ZInstr{ z, ahora };

    // Purgar los vencidos acá mismo: el mapa tiene a lo sumo un puado de
    // entradas (13 hoy, 100 después del 12-oct), así que barrerlo es gratis.
    for (auto it = g_xsec.begin(); it != g_xsec.end(); ) {
        if (ahora - it->second.ts_ms > RANK_VENTANA_MS) it = g_xsec.erase(it);
        else ++it;
    }

    p.n = (int)g_xsec.size();
    if (p.n < g_rank_min) return p;     // sin sección no se decide: HOLD

    // Puesto = cuántos tienen z ESTRICTAMENTE mayor. Los empates comparten el
    // mejor puesto, que es lo correcto: si dos instrumentos tienen el mismo z
    // no hay razón para preferir a uno, y el desempate por nombre del mapa
    // sería una decisión alfabética disfrazada de señal.
    // Los empatados se reparten el puesto PROMEDIO del grupo, no el mejor.
    //
    // Antes compartían el mejor, y sobre datos reales eso rompe justo lo que el
    // ranking viene a arreglar: si los 13 scores empatan —una red saturada
    // contesta lo mismo para todos, medido el 18-sep— los 13 quedaban en el
    // puesto 0 y los 13 salían BUY. Es exactamente la patología del 15-sep
    // («MIIA emitió BUY en los 13 instrumentos a la vez») reaparecida por otro
    // camino. Con el promedio, un empate total pone a todos en la mediana y no
    // emite nadie, que es la respuesta correcta: sin dispersión no hay orden.
    //
    // Es la misma regla que usa `rangos()` en `MIIA/rank_ic.py` para el
    // Spearman. Que la decisión y la medición traten los empates igual no es
    // cosmético: si difirieran, el IC mediría un orden que el sistema no tomó.
    int mayores = 0, empatados = 0;
    for (const auto& [t, zi] : g_xsec) {
        if (t == ticker) continue;
        if      (zi.z > z) mayores++;
        else if (zi.z == z) empatados++;
    }
    p.pos = (double)mayores + (double)empatados / 2.0;

    // ── class27 modula CUÁNTAS señales, no cuáles (26-sep-2026) ─────────
    // `metaFactor` es global, y un ranking es invariante a escala: multiplicar
    // todos los z por la misma constante positiva no mueve un solo puesto. Así
    // que la única forma de que una señal global cambie decisiones es cambiar
    // el TAMAÑO de las puntas. Con el razonamiento degradado —sobreconfianza o
    // caída de calidad— MIIA emite menos, que es lo que un meta-monitor debería
    // provocar.
    double fraccion = g_rank_fraccion;
    if (g_meta_k == 1) {
        bool mo = false, md = false;
        const double mf = metaFactor(mo, md);
        if (mf < 1.0) { fraccion *= mf; g_metak_recortes++; }
    }
    p.k   = std::max(1, (int)std::lround(p.n * fraccion));
    // Con k tan grande que las dos puntas se tocan no quedaría HOLD posible y
    // la mitad peor sería "la mejor" de la otra punta. 2k < n siempre.
    p.k   = std::min(p.k, (p.n - 1) / 2);
    p.k   = std::max(p.k, 1);
    p.hay = true;
    return p;
}

static void procesarVentana(std::unique_ptr<Redis>& pub, const std::string& ticker) {
    std::map<std::string,Señal> redes_snap;
    json crisis40_snap = json::object();
    json crisis41_snap = json::object();
    SenalLstm lstm_snap; bool lstm_fresco = false;
    SenalCrisisT fc40_snap, rk41_snap;
    bool fc40_fresco = false, rk41_fresco = false;
    {
        std::lock_guard<std::mutex> lk(g_ventana.mtx);
        auto it = g_ventana.porTicker.find(ticker);
        if (it == g_ventana.porTicker.end() || it->second.redes.empty()) {
            if (it != g_ventana.porTicker.end()) g_ventana.porTicker.erase(it);
            return;
        }
        redes_snap   = std::move(it->second.redes);
        // El LSTM se cachea por ticker (no cae en la ventana de 5 s) y solo se
        // usa si es reciente: una predicción vieja es peor que ninguna.
        {
            auto itl = g_ventana.lstm44.find(ticker);
            if (itl != g_ventana.lstm44.end()) {
                const auto edad = std::chrono::duration_cast<std::chrono::minutes>(
                                      std::chrono::steady_clock::now() - itl->second.ts).count();
                if (edad <= LSTM_TTL_MIN) { lstm_snap = itl->second; lstm_fresco = true; }
            }
        }
        crisis40_snap= g_ventana.crisis40.is_null() ? json::object() : g_ventana.crisis40;
        crisis41_snap= g_ventana.crisis41.is_null() ? json::object() : g_ventana.crisis41;
        // El par REAL, por instrumento. Mismo TTL que el LSTM: un pronóstico
        // viejo es peor que ninguno.
        {
            auto i40 = g_ventana.fc40.find(ticker);
            if (i40 != g_ventana.fc40.end()) {
                const auto edad = std::chrono::duration_cast<std::chrono::minutes>(
                                      std::chrono::steady_clock::now() - i40->second.ts).count();
                if (edad <= LSTM_TTL_MIN) { fc40_snap = i40->second; fc40_fresco = true; }
            }
            auto i41 = g_ventana.rk41.find(ticker);
            if (i41 != g_ventana.rk41.end()) {
                const auto edad = std::chrono::duration_cast<std::chrono::minutes>(
                                      std::chrono::steady_clock::now() - i41->second.ts).count();
                if (edad <= LSTM_TTL_MIN) { rk41_snap = i41->second; rk41_fresco = true; }
            }
        }
        g_ventana.porTicker.erase(it);   // ventana consumida
    }

    // En modo ACTIVO el LSTM entra como una red más, ANTES del ensamble, para
    // que herede todo lo que ya existe: peso adaptativo, atribución de crédito
    // en el feedback y presencia en el payload publicado. Insertarlo después
    // habría dejado su peso clavado en PESO_INICIAL para siempre.
    if (lstm_fresco && g_lstm_modo == 1) {
        Señal s44;
        s44.red         = "class44";
        s44.ticker      = ticker;
        s44.score       = lstm_snap.score_dir;
        s44.confianza   = lstm_snap.score_dir;
        s44.riesgo      = 0.5;   // el LSTM no publica riesgo: neutro, no inventado
        s44.tiene_score = true;
        s44.tendencia   = lstm_snap.score_dir > 0.5 ? "positiva"
                        : lstm_snap.score_dir < 0.5 ? "negativa" : "neutra";
        redes_snap["class44"] = s44;
    }

    // ── class40 y class41 como VOTANTES (26-sep-2026) ───────────────────────
    // Mismo patrón que class44: entran ANTES del ensamble para heredar peso
    // adaptativo, atribución de crédito y presencia en el payload. Insertarlos
    // después los dejaría con el peso clavado en PESO_INICIAL para siempre.
    //
    // Sólo entran con score POR INSTRUMENTO: si el pronóstico o el riesgo
    // fueran el mismo número para todos, sumarían una constante y el orden del
    // ranking no se movería ni un puesto. Por eso el caché es por ticker.
    if (g_votante_crisis == 1) {
        if (fc40_fresco) {
            Señal s40;
            s40.red         = "class40";
            s40.ticker      = ticker;
            s40.score       = fc40_snap.score;
            s40.confianza   = 1.0 - fc40_snap.riesgo;  // menos incertidumbre, más confianza
            s40.riesgo      = fc40_snap.riesgo;
            s40.tiene_score = true;
            s40.tendencia   = fc40_snap.score > 0.5 ? "positiva"
                            : fc40_snap.score < 0.5 ? "negativa" : "neutra";
            redes_snap["class40"] = s40;
            g_v40_usos++;
        }
        if (rk41_fresco) {
            Señal s41;
            s41.red         = "class41";
            s41.ticker      = ticker;
            s41.score       = rk41_snap.score;
            s41.confianza   = rk41_snap.score;
            s41.riesgo      = rk41_snap.riesgo;
            s41.tiene_score = true;
            s41.tendencia   = rk41_snap.score > 0.5 ? "positiva"
                            : rk41_snap.score < 0.5 ? "negativa" : "neutra";
            redes_snap["class41"] = s41;
            g_v41_usos++;
        }
    }

    // 1. Ensamble ponderado en DOS NIVELES
    //
    // Nivel interno: las sub-redes de un módulo (class24/mercado,
    // class24/impacto, …) compiten entre sí con su peso adaptativo.
    // Nivel externo: el módulo conserva su peso frente a class21/22/44.
    //
    // El segundo nivel no es cosmético. Con un solo nivel, pasar de 4 claves a
    // ~10 le habría dado a class23+class24 el 80% del voto de un día para el
    // otro — un cambio de balance que nadie decidió. Con una sola sub-red por
    // módulo el resultado es idéntico al del código anterior.
    auto pw = g_pesos.toJson();

    // ¿Hay alguna red con score REAL? Si la hay, las que cayeron al default 0.5
    // por contrato roto se EXCLUYEN en vez de meter una constante en la
    // decisión. El flag ya existía y se usaba para el snapshot de atribución y
    // para el warning, pero no acá: una red rota votaba y encima quedaba fuera
    // del reparto de crédito, así que su peso no se movía nunca.
    bool hay_score_real = false;
    for (const auto& kv : redes_snap)
        if (kv.second.tiene_score) { hay_score_real = true; break; }

    struct AcumMod { double score_w = 0, riesgo_w = 0, peso_w = 0;
                     double z_w = 0, zpeso_w = 0; };
    std::map<std::string, AcumMod> por_modulo;

    // Copia de la línea de base bajo el lock: son ~21 entradas y evita tomar
    // g_snap_mtx una vez por red adentro del loop.
    std::map<std::string, BaseRed> bases_dec;
    { std::lock_guard<std::mutex> lk(g_snap_mtx); bases_dec = g_base; }

    for (auto& [clave, señal] : redes_snap) {
        if (hay_score_real && !señal.tiene_score) continue;
        const double p = pw.value(clave, PESO_INICIAL);
        auto& a = por_modulo[moduloDe(clave)];
        a.score_w  += señal.score  * p;
        a.riesgo_w += señal.riesgo * p;
        a.peso_w   += p;
        // z contra su propia base. Una red sin base suficiente (arranque en
        // frío) no entra al z; si no entra ninguna, se decide con el crudo.
        auto b = bases_dec.find(clave);
        if (b != bases_dec.end() && b->second.n >= DEC_Z_MIN_MUESTRAS) {
            const double sd = desvioBase(b->second);
            if (sd > 1e-9) {
                a.z_w     += ((señal.score - b->second.media) / sd) * p;
                a.zpeso_w += p;
            }
        }
    }

    double score_total = 0, peso_total = 0;
    double riesgo_total = 0;
    double z_total = 0; int z_mods = 0;
    for (auto& [mod, a] : por_modulo) {
        if (a.peso_w <= 0) continue;
        if (a.zpeso_w > 0) { z_total += a.z_w / a.zpeso_w; z_mods++; }
        // NIVEL EXTERNO: voto IGUAL por módulo (11-sep-2026, decidido por Martín).
        //
        // Antes era pw.value(mod): la clave PELADA del módulo ("class24"), que es la
        // MISMA clave que cobra el crédito de los mensajes que llegan sin `fuente`.
        // Una clave con dos papeles: el voto de un módulo entero subía o bajaba según
        // acertara su señal sin fuente, y la renormalización hacía el resto. Medido:
        // el jueves 10-sep a la noche los cuatro módulos votaban casi parejo
        // (0,00029 / 0,00031 / 0,00034 / 0,00037); el viernes 11-sep a las 05:33
        // class24 tenía el 99,995 % del voto. Justo lo que este segundo nivel vino a
        // evitar: "un cambio de balance que nadie decidió". El aprendizaje queda en
        // el nivel interno, entre las sub-redes de cada módulo.
        const double pm = PESO_INICIAL;
        score_total  += (a.score_w  / a.peso_w) * pm;
        riesgo_total += (a.riesgo_w / a.peso_w) * pm;
        peso_total   += pm;
    }

    if (peso_total <= 0) return;
    double score_ens = score_total / peso_total;
    double riesgo    = riesgo_total / peso_total;

    // Ver «DECISIÓN EN Z». El z del ensemble (voto parejo por módulo, igual que
    // el crudo) vuelve a la escala 0-1 centrada en g_neutro, así que todo lo
    // que está aguas abajo sigue leyendo los mismos números de siempre.
    // `z_ens` sale del `if` porque el ranking transversal lo necesita: es la
    // magnitud comparable ENTRE instrumentos (cada red ya viene normalizada
    // contra su propia media y desvío en `g_base`). `score_final` no sirve para
    // ordenar: le entra el refuerzo bayesiano, que es por condición y no por
    // instrumento, y contaminaría la sección transversal con algo que no es
    // comparable entre tickers.
    double z_ens = 0.0;
    bool   hay_z = false;
    if (g_escala_z > 0.0 && z_mods >= DEC_Z_MIN_MODULOS) {
        z_ens = z_total / (double)z_mods;
        hay_z = true;
        score_ens = std::clamp(g_neutro + z_ens * g_escala_z, 0.0, 1.0);
        g_dec_z++;
    } else {
        g_dec_crudo++;
    }

    // Prueba observable de que el arreglo funciona: si N > M, en esta ventana
    // entraron VARIAS sub-redes del mismo módulo — las que antes se pisaban.
    // Se loguea una vez por combinación distinta para no inundar el log.
    if (redes_snap.size() > por_modulo.size()) {
        static std::mutex mtx_combo;
        static std::set<std::string> combos;
        const std::string combo = std::to_string(redes_snap.size()) + "/" +
                                  std::to_string(por_modulo.size());
        bool nueva;
        { std::lock_guard<std::mutex> lk(mtx_combo); nueva = combos.insert(combo).second; }
        if (nueva)
            spdlog::info("[{}] 🔀 {} sub-redes en {} módulos — antes sobrevivía 1 por módulo",
                         TAG, redes_snap.size(), por_modulo.size());
    }

    // ── SOMBRA class44 ───────────────────────────────────────────────────
    // Se calcula qué habría dado el ensemble CON el LSTM y se registra, sin
    // tocar la decisión. En unas semanas la comparación entre el delta y el
    // outcome real dice si conviene encenderlo — y con qué peso.
    if (lstm_fresco && g_lstm_modo != 1) {
        const double p44   = pw.value("class44", PESO_INICIAL);
        const double con44 = (score_total + lstm_snap.score_dir * p44)
                           / (peso_total  + p44);
        spdlog::info("[{}] 🔦 [SOMBRA-44] {} ens={:.4f} con_lstm={:.4f} "
                     "delta={:+.4f} | lstm_dir={:.4f} senal={} conf={:.2f}",
                     TAG, ticker, score_ens, con44, con44 - score_ens,
                     lstm_snap.score_dir, lstm_snap.senal, lstm_snap.conf);
    }

    // 2. Capa de crisis (class40/41 modifican umbral)
    double mult_umbral = 1.0;
    double umbral_actual;
    {
        std::lock_guard<std::mutex> lk(g_umbral_mtx);
        umbral_actual = g_umbral;
    }

    if (!crisis40_snap.empty()) {
        double prob_cont = crisis40_snap.value("prob_contraccion",
                           crisis40_snap.value("confianza", 0.0));
        if (prob_cont > 0.60) mult_umbral *= 1.35; // más conservador
        if (prob_cont > 0.80) mult_umbral *= 1.20; // más conservador aún
    }
    if (!crisis41_snap.empty()) {
        double risk41 = crisis41_snap.value("riesgo",
                        crisis41_snap.value("risk_level", 0.5));
        if (risk41 > 0.70) mult_umbral *= 1.25;
        if (risk41 < 0.25 && score_ens > 0.60) mult_umbral *= 0.90; // señal fuerte en riesgo bajo
    }

    double umbral_efectivo = std::clamp(umbral_actual * mult_umbral,
                                         UMBRAL_MIN, UMBRAL_MAX);

    // 3. Determinar tendencia dominante
    int pos=0, neg=0;
    for (auto& [k,s] : redes_snap) {
        if (s.tendencia == "positiva") pos++;
        else if (s.tendencia == "negativa") neg++;
    }
    std::string tendencia = pos > neg ? "positiva" :
                            neg > pos ? "negativa" : "neutra";

    // ── SOMBRA-META (3-sep-2026) ─────────────────────────────────────
    // Registra qué amortiguación aplicaría la meta-introspección de class27,
    // SIN aplicarla. Mismo criterio que SOMBRA-44 y SOMBRA-HOLD: medir antes
    // de actuar. Con CLASS25A_META_MODO=1 pasa a multiplicar score_ens.
    {
        bool m_over = false, m_drop = false;
        const double m_f = metaFactor(m_over, m_drop);
        if (m_f < 1.0) {
            spdlog::info("[{}] 🌓 SOMBRA-META {} score_ens={:.4f} → {:.4f} "
                         "(factor={:.2f} overconf={} qdrop={}) {}",
                         TAG, ticker, score_ens, score_ens * m_f, m_f,
                         m_over, m_drop,
                         g_meta_modo ? "APLICADO" : "no aplicado");
            if (g_meta_modo) score_ens *= m_f;
        }
    }

    // 4. Consultar memoria bayesiana
    std::string hash = g_bayes.hashCondicion(score_ens, riesgo, tendencia, ticker);
    auto mem_entry   = g_bayes.consultar(hash);
    double prob_bayes = (mem_entry.total > 0)
                      ? (double)mem_entry.aciertos / mem_entry.total
                      : 0.5;

    // Peso de la memoria bayesiana crece con más datos
    double peso_bayes = std::min(g_bayes_peso_max, mem_entry.total / 100.0);

    // ── Aplicación DIRECCIONAL de la bayesiana (v2.4) ────────────────
    //
    // ANTES:  score_final = score_ens*(1-w) + prob_bayes*w
    //
    // Eso mezcla dos magnitudes de UNIDADES DISTINTAS:
    //   · score_ens  es DIRECCIONAL  (0 bajista · g_neutro neutro · 1 alcista)
    //   · prob_bayes es una FIABILIDAD: P(la decisión fue correcta), y "correcta"
    //     significa cosas opuestas según la señal — un SELL acierta cuando el
    //     precio BAJA.
    //
    // Con la fórmula vieja, "en esta condición el SELL funcionó el 80% de las
    // veces" sumaba +0.80×w al score, o sea EMPUJABA HACIA BUY: la memoria
    // peleaba justo contra las ventas que ella misma había validado. Es un error
    // de signo, no de calibración.
    //
    // Además el promedio ponderado comprimía el rango útil: con w=0.30 el score
    // conservaba solo el 70% de su escala, y por eso |distancia_neutro| tenía un
    // techo de ~0.19 — inalcanzable para el gate SELL de 0.70 de class25B, que
    // exige ≥0.20. Los dos síntomas salen de la misma línea.
    //
    // AHORA la memoria actúa como un FACTOR DE REFUERZO sobre la distancia al
    // neutro, no como un sumando:
    //
    //     refuerzo    = 1 + (prob_bayes - 0.5) · 2 · peso_bayes     ∈ [1-w, 1+w]
    //     score_final = neutro + (score_ens - neutro) · refuerzo
    //
    //   prob_bayes = 0.5 (sin evidencia) → refuerzo = 1 → no mueve nada
    //   prob_bayes > 0.5 → amplifica la convicción, en la dirección que sea
    //   prob_bayes < 0.5 → la atenúa
    //
    // Es multiplicativo sobre la DISTANCIA, no aditivo sobre el score. Eso
    // importa: la primera versión de este fix aplicaba
    // `score_ens + signo·(prob_bayes-0.5)·w`, que introduce un SALTO en el
    // neutro — con w=0.30 y prob_bayes=0.78 el |dist| mínimo pasaba a ser 0.084,
    // por encima de MARGEN_MIN (0.02), y el HOLD se volvía inalcanzable: todas
    // las decisiones habrían salido BUY o SELL. La forma multiplicativa es
    // continua en el neutro y conserva el HOLD.
    //
    // Se puede anular sin recompilar con CLASS25A_BAYES_PESO_MAX=0.
    const double refuerzo_bayes = 1.0 + (prob_bayes - 0.5) * 2.0 * peso_bayes;
    double score_final = std::clamp(
        g_neutro + (score_ens - g_neutro) * refuerzo_bayes, 0.0, 1.0);

    // 5. Decisión — umbral por MAGNITUD, simétrico en ambas direcciones
    //
    // ANTES:  if (score_final >= umbral_efectivo)
    //             senal = tendencia == "positiva" ? "BUY" : "SELL";
    //
    // score_final es direccional (0 bajista / 0.5 neutro / 1 alcista) pero se
    // comparaba contra un umbral por ARRIBA. Dos consecuencias:
    //   a) un bajista FUERTE (0.15) nunca superaba el umbral → salía HOLD;
    //   b) el único SELL posible era "score alto + tendencia negativa", una
    //      banda contradictoria que captura bajistas DÉBILES.
    // O sea: el ensemble escondía sus mejores ventas y emitía las peores.
    //
    // AHORA se mide la distancia al neutro y la dirección la da el propio
    // score_final, que es lo que se está midiendo (antes la daba `tendencia`,
    // un voto de redes que podía contradecir al score).
    // Guardar qué dijo cada red en esta condición, para poder atribuirle el
    // resultado cuando class43 devuelva el outcome (ver handler de CH_FB).
    {
        std::lock_guard<std::mutex> lk(g_snap_mtx);
        SnapRedes sn;
        sn.ts_ms = ahora_ms();
        for (auto& [k, sg] : redes_snap)
            if (sg.tiene_score) {
                sn.scores[k] = sg.score;   // solo redes con score REAL
                // Línea de base de la capa 2 (ver g_base): los mismos scores que
                // después se juzgan, así se compara contra la población correcta.
                observarBase(g_base[k], sg.score);
            }
        if (!sn.scores.empty()) {
            // ORDEN 3: se APILA, no se pisa. Una decisión nueva del mismo
            // bucket ya no borra a la que todavía espera su outcome a 48 h.
            auto& cola = g_snaps[hash];
            cola.push_back(std::move(sn));
            g_snaps_total++;
            while (cola.size() > MAX_SNAPS_HASH) { cola.pop_front(); g_snaps_total--; }

            // Purga amortizada por TTL: barrer en cada decisión sería O(n) con
            // n ~ decenas de miles. Cada 500 inserciones alcanza — el TTL es de
            // 80 h y el tope global es la red de seguridad.
            static uint64_t desdePurga = 0;
            if (++desdePurga >= 500) {
                desdePurga = 0;
                const int64_t corte = sn.ts_ms - SNAP_TTL_MS;
                for (auto it = g_snaps.begin(); it != g_snaps.end(); ) {
                    auto& q = it->second;
                    while (!q.empty() && q.front().ts_ms < corte) { q.pop_front(); g_snaps_total--; }
                    if (q.empty()) it = g_snaps.erase(it); else ++it;
                }
            }
            // Tope global: si aun con el TTL se pasa, se tira lo más viejo de
            // la cola más larga. No debería dispararse nunca.
            while (g_snaps_total > MAX_SNAPS) {
                auto peor = g_snaps.end();
                for (auto it = g_snaps.begin(); it != g_snaps.end(); ++it)
                    if (peor == g_snaps.end() || it->second.size() > peor->second.size()) peor = it;
                if (peor == g_snaps.end() || peor->second.empty()) break;
                peor->second.pop_front(); g_snaps_total--;
                if (peor->second.empty()) g_snaps.erase(peor);
            }
        }
    }

    // Media móvil de score_final: sirve para calibrar g_neutro con datos.
    // Se acumula SIEMPRE (incluso en modo unilateral) para poder medir el
    // neutro real del ensemble antes de activar el modo magnitud.
    double score_medio;
    long long score_n_ventana;
    {
        std::lock_guard<std::mutex> lk(g_score_mtx);
        g_score_sum += score_final;
        g_score_n   += 1;
        score_medio  = g_score_sum / (double)g_score_n;
        score_n_ventana = g_score_n;
    }

    // ── Auto-calibración del neutro cada g_auto_neutro_h horas ───────────
    // Se hace acá (no en un hilo aparte) porque necesita la media de la
    // ventana que se acaba de actualizar, y así queda serializado con ella.
    if (g_auto_neutro_h > 0.0) {
        const auto ahora_c = std::chrono::steady_clock::now();
        const double horas = std::chrono::duration<double, std::ratio<3600>>(
                                 ahora_c - g_ultima_calib).count();
        if (horas >= g_auto_neutro_h) {
            g_ultima_calib = ahora_c;
            if (score_n_ventana < AUTO_NEUTRO_MIN_MUESTRAS) {
                spdlog::warn("[{}] 📐 auto-neutro OMITIDO: {} muestras (< {}). "
                             "Se reintenta en {:.0f} h.", TAG, score_n_ventana,
                             AUTO_NEUTRO_MIN_MUESTRAS, g_auto_neutro_h);
            } else {
                const double desvio = score_medio - g_neutro;
                if (std::fabs(desvio) < AUTO_NEUTRO_MIN_DESVIO) {
                    spdlog::info("[{}] 📐 auto-neutro: desvío {:+.4f} < {:.3f} — "
                                 "la banda ya está centrada, no se toca.",
                                 TAG, desvio, AUTO_NEUTRO_MIN_DESVIO);
                } else {
                    const double previo = g_neutro;
                    // Amortiguación ADAPTATIVA.
                    //
                    // Con 50% fijo, corregir un error inicial de 0.16 tomaba 4
                    // ciclos = 12 días emitiendo con la banda descentrada.
                    // Pero un desvío grande no es ruido: es una calibración mal
                    // puesta, y conviene corregirla casi de una. Uno chico sí
                    // puede ser ruido, y ahí el 50% evita perseguirlo.
                    //
                    // El corte en 0.10 son 5× el margen de emisión (0.02): por
                    // encima de eso la banda está objetivamente mal ubicada.
                    const double amort = (std::fabs(desvio) > 0.10)
                                       ? 0.90 : AUTO_NEUTRO_AMORTIGUA;
                    double nuevo = previo * (1.0 - amort) + score_medio * amort;
                    nuevo = std::clamp(nuevo, 0.20, 0.90);

                    // ── EL NEUTRO YA NO SE APLICA: es un termómetro ──────────
                    // Desde la decisión en z (12-sep) el neutro se cancela en la
                    // banda —`score_final - g_neutro` es z × 0,10 × refuerzo, sin
                    // el neutro— y el 99,4 % de las decisiones sale por ahí. Con
                    // el ranking transversal encima, el neutro no toca ninguna
                    // decisión de instrumento: un desplazamiento igual para los 13
                    // no cambia un solo puesto.
                    //
                    // Lo que SÍ hacía era caminar. Serie medida: 0,6114 (14-sep)
                    // → 0,6033 (17) → 0,5887 (20), con el desvío cambiando de
                    // signo. No es deriva estructural: el desvío es 0,10 × el
                    // promedio de z del ensamble, así que el neutro venía
                    // siguiendo la SATURACIÓN de las redes de mercado. Como
                    // termómetro es informativo; como valor aplicado sólo mueve
                    // el ~0,6 % de decisiones que todavía deciden con el crudo
                    // —casi todas en la primera hora después de un reinicio— y
                    // las vuelve no comparables con las de antes.
                    //
                    // Se sigue midiendo y logueando; no se aplica ni se persiste.
                    // `CLASS25A_APLICAR_NEUTRO=1` lo devuelve al comportamiento
                    // anterior sin recompilar.
                    if (g_aplicar_neutro) {
                        g_neutro = nuevo;
                        guardarNeutro(nuevo, score_medio, score_n_ventana);
                        spdlog::warn("[{}] 📐 AUTO-NEUTRO {:.4f} → {:.4f} "
                                     "(score_medio={:.4f} desvío={:+.4f} n={}) — persistido",
                                     TAG, previo, nuevo, score_medio, desvio, score_n_ventana);
                    } else {
                        spdlog::info("[{}] 🌡️ neutro OBSERVADO (no se aplica): "
                                     "{:.4f} → habría ido a {:.4f} "
                                     "(score_medio={:.4f} desvío={:+.4f} n={}). "
                                     "Un desvío que crece sostenido es saturación "
                                     "de las redes, no descentrado de la banda.",
                                     TAG, previo, nuevo, score_medio, desvio, score_n_ventana);
                    }
                }
            }
            // Reiniciar la ventana: la media acumulada desde el arranque le da
            // cada vez menos peso a lo nuevo y dejaría de detectar la deriva.
            {
                std::lock_guard<std::mutex> lk(g_score_mtx);
                g_score_sum = 0.0;
                g_score_n   = 0;
            }
        }
    }

    std::string senal  = "HOLD";
    double      margen = 0.0;
    Puesto      puesto;
    bool        por_ranking = false;

    // ── 5.a · RANKING TRANSVERSAL ───────────────────────────
    // BUY a los k mejores de la ventana, SELL a los k peores, HOLD al medio.
    // Tres casos en los que NO decide el ranking, y los tres salen HOLD o caen
    // a la banda, pero ninguno emite a ciegas:
    //   · el agregado (GENERAL) no tiene contra qué compararse → HOLD;
    //   · sin z (arranque en frío, menos de 2 módulos) no hay magnitud
    //     comparable → cae a la banda, que es la regla vieja;
    //   · con menos de `g_rank_min` instrumentos frescos no hay sección
    //     transversal → HOLD. Es el caso del mercado cerrado, y es correcto
    //     que no emita: 12 de las 13 ventanas no existen.
    if (g_ranking && esAgregado(ticker)) {
        g_rank_agregado++;                       // HOLD, y no cae a la banda
        por_ranking = true;
    } else if (g_ranking && hay_z) {
        puesto = ubicarEnSeccion(ticker, z_ens, ahora_ms());
        por_ranking = true;
        if (puesto.hay) {
            if      (puesto.pos < puesto.k)             { senal = "BUY";  g_rank_buy++;  }
            else if (puesto.pos >= puesto.n - puesto.k) { senal = "SELL"; g_rank_sell++; }
            else                                          g_rank_hold++;
        } else {
            g_rank_sin_seccion++;
        }
    } else if (g_umbral_magnitud) {
        // Mapear el umbral [MIN,MAX] al margen [MARGEN_MIN, g_margen_max]
        // conservando la semántica "más crisis ⇒ más evidencia requerida".
        margen = (umbral_efectivo - UMBRAL_MIN) / (UMBRAL_MAX - UMBRAL_MIN)
                 * g_margen_max;
        margen = std::clamp(margen, MARGEN_MIN, g_margen_max);
        // Distancia al neutro CONFIGURADO (no al 0.5 asumido): con el centro
        // corrido, la banda quedaba asimétrica y mataba una de las dos señales.
        const double dist = score_final - g_neutro;
        if      (dist >=  margen) senal = "BUY";
        else if (dist <= -margen) senal = "SELL";
    } else {
        if (score_final >= umbral_efectivo)
            senal = tendencia == "positiva" ? "BUY" : "SELL";
    }

    // Ventana para el control del umbral por tasa de emisión (ver EMISION_*).
    // Con el ranking la emisión es ESTRUCTURAL — 2k de n por construcción— y el
    // umbral no toca ninguna decisión. Si se le siguiera dando de comer, el
    // control lo empujaría a un extremo y lo PERSISTIRÍA, dejando basura para el
    // día que alguien ponga CLASS25A_RANKING=0. Por eso la ventana la alimenta
    // sólo la banda, que es a quien el umbral gobierna.
    if (!por_ranking) {
        std::lock_guard<std::mutex> lk(g_emision_mtx);
        g_emitidas.push_back(senal != "HOLD");
        if (g_emitidas.size() > EMISION_VENTANA) g_emitidas.pop_front();
    }

    // Confianza por MAGNITUD, no por score crudo.
    // Con `confianza = score_final`, un SELL fuerte (score 0.15) declaraba
    // confianza 0.15 — y el gate de class25B (SELL ≥ 0.70) lo mataba SIEMPRE.
    // Sin esto, arreglar la decisión no sirve de nada: las ventas nuevas
    // morirían igual una capa más abajo.
    // 0.5 + |score-0.5| deja el BUY IDÉNTICO al de antes y espeja el SELL.
    // CONFIANZA POR POSICIÓN cuando decide el ranking.
    //
    // Es distancia del puesto a la mediana, normalizada: **simétrica por
    // construcción**. Arregla el hallazgo del 15-sep —la confianza estaba atada
    // a la DIRECCIÓN: el grupo confiable era 25-42 puntos más BUY que el dudoso,
    // y las 23.063 decisiones de horizonte 48 h eran TODAS BUY—. Con
    // `0.5 + |score-neutro|` eso salía de que la cola positiva de z era más
    // gorda; con el puesto no puede pasar, porque el mejor y el peor están a la
    // misma distancia de la mediana.
    //
    // Se calcula siempre que haya sección, no sólo cuando emite: un instrumento
    // del medio tiene poca convicción, y eso es cierto y útil para el horizonte.
    double confianza;
    if (puesto.hay && puesto.n > 1) {
        confianza = confianzaPorPuesto(puesto);
    } else if (g_umbral_magnitud) {
        confianza = std::clamp(0.5 + std::fabs(score_final - g_neutro), 0.0, 1.0);
    } else {
        confianza = std::clamp(score_final, 0.0, 1.0);
    }

    // 6. Stop loss dinámico basado en riesgo
    double stop_loss = 0.02 + riesgo * 0.04; // 2%-6%

    // 7. Horizonte basado en confianza
    // OJO: todo horizonte emitido acá tiene que existir en el mapa HORIZONTE_MS
    // de scripts/class43.js. Ese lookup cae a 24 h en silencio si la clave falta
    // — así vivió meses el "48h" sin estar en el mapa: vencía a 24 h y se
    // valorizaba a 48 h.
    int horizonte_h = g_horizonte_debug_h > 0
                    ? g_horizonte_debug_h
                    : (confianza > 0.65 ? 24 : confianza > 0.50 ? 48 : 72);

    // 8. Generar texto natural para class25B
    std::string texto = generarTexto(
        ticker, senal, score_ens, confianza, riesgo,
        redes_snap, g_pesos,
        crisis40_snap, crisis41_snap,
        mem_entry, umbral_efectivo
    );

    // 9. Construir scores y pesos
    json scores_j, pesos_j;
    for (auto& [k,s] : redes_snap) {
        scores_j[k] = s.score;
        pesos_j[k]  = pw.value(k, PESO_INICIAL);
    }

    // 10. Publicar a class25a_output
    json output = {
        {"id",               make_id(TAG)},
        {"source",           TAG},
        {"type",             "decision_cuantitativa"},
        // Decisión estructurada
        {"senal",            senal},
        {"ticker",           ticker},
        {"confianza",        confianza},
        {"horizonte",        std::to_string(horizonte_h) + "h"},
        {"horizonte_horas",  horizonte_h},
        {"stop_loss",        stop_loss},
        {"riesgo",           riesgo},
        // Texto para class25B
        {"texto_numerico",   texto},
        {"text",             texto},
        {"texto",            texto},
        // Contexto numérico completo
        {"scores",           scores_j},
        {"pesos",            pesos_j},
        {"ensemble_score",   score_ens},
        {"score_bayesiano",  prob_bayes},
        {"score_final",      score_final},
        {"umbral_efectivo",  umbral_efectivo},
        {"umbral_base",      umbral_actual},
        {"tendencia",        tendencia},
        // Modo de umbral + margen aplicado: permite auditar desde class43/SQL
        // si una señal salió con la lógica nueva o la vieja, y con qué exigencia.
        {"umbral_modo",      g_umbral_magnitud ? "magnitud" : "unilateral"},
        {"margen_efectivo",  margen},
        // ── Ranking transversal ─────────────────────────────
        // `decision_modo` permite separar en SQL lo decidido por ranking de lo
        // decidido por la banda — son poblaciones distintas, como `label_modo`.
        {"decision_modo",    por_ranking ? "ranking" : "banda"},
        // `pos` es fraccionario cuando hay empate; al payload va redondeado,
        // que es lo que se lee. La decisión usa el valor exacto.
        {"puesto",           puesto.hay ? (int)std::lround(puesto.pos) : -1},
        {"puestos_n",        puesto.hay ? puesto.n   : 0},
        {"rank_k",           puesto.hay ? puesto.k   : 0},
        {"z_ensemble",       hay_z ? z_ens : 0.0},
        // `score` a nivel superior: la columna `score` de cognitive_decisions
        // está SIEMPRE en NULL (0 de 102.971 filas de septiembre) y el número que
        // toma la decisión sobrevivía sólo dentro de una frase en castellano.
        // class25A ya lo publica acá; falta que class25B lo escriba en la fila.
        {"score",            score_final},
        // Distancia al neutro con signo: <0 bajista, >0 alcista. Es la medida
        // de convicción real, independiente de la señal finalmente emitida.
        {"distancia_neutro", score_final - g_neutro},
        // Centro en uso + media móvil observada: comparar ambos dice si el
        // centro está bien calibrado (si score_medio se aleja de neutro de
        // forma sostenida durante días, hay que reajustar CLASS25A_NEUTRO).
        {"neutro",           g_neutro},
        {"score_medio",      score_medio},
        {"score_muestras",   (long long)g_score_n},
        {"hash_condicion",   hash},
        {"memoria", {
            {"condiciones_similares", mem_entry.total},
            {"aciertos",             mem_entry.aciertos},
            {"probabilidad_historica",prob_bayes},
            // Diagnóstico del lazo de feedback: `emitidas` cuenta decisiones
            // tomadas bajo esta condición y `total` las que volvieron
            // verificadas de class43. Si emitidas >> total de forma sostenida,
            // el feedback se está perdiendo y la bayesiana está ciega —
            // exactamente el síntoma que antes quedaba enmascarado porque las
            // emisiones se contaban como fallos.
            {"emitidas",             mem_entry.emitidas},
            {"peso_aplicado",        peso_bayes}
        }},
        {"crisis", {
            {"multiplicador_umbral",  mult_umbral},
            {"class40_disponible",    !crisis40_snap.empty()},
            {"class41_disponible",    !crisis41_snap.empty()}
        }},
        {"redes_activas",    (int)redes_snap.size()},
        {"ts",               now_iso()},
        {"final",            true}
    };

    try {
        pub->publish(CH_OUT, output.dump());
        spdlog::info("[{}] 📤 {} {} conf={:.3f} score={:.3f}>umbral={:.3f} redes={}",
            TAG, senal, ticker, confianza, score_final,
            umbral_efectivo, (int)redes_snap.size());
        spdlog::info("[{}] 📝 {}", TAG, texto.substr(0, 120));
    } catch (const std::exception& e) {
        spdlog::error("[{}] publish error: {}", TAG, e.what());
    }

    // 11. Registrar la EMISIÓN en la bayesiana (todavía sin outcome).
    // Antes esto llamaba a registrar(hash, false, ...), que incrementaba `total`
    // como si fuera una verificación FALLIDA — el bug de doble conteo. Ahora solo
    // suma a `emitidas`, que no participa del cálculo de prob_bayes.
    g_bayes.registrarEmision(hash, tendencia + " score=" + fmt2(score_ens));
    if (g_ventana.total_decisiones % 20 == 0)
        g_bayes.guardar(g_bayes_file);

    g_ventana.total_decisiones++;

    // Reporte periódico del neutro empírico. Es el dato con el que se elige
    // CLASS25A_NEUTRO: si score_medio se mantiene lejos del neutro configurado
    // durante días, la banda está descentrada y una de las dos señales se
    // muere de hambre (v2.2: neutro=0.5 con score_medio≈0.47 → 0% BUY).
    if (g_ventana.total_decisiones % 100 == 0) {
        spdlog::info("[{}] 📐 neutro={:.3f} | score_medio={:.4f} ({} muestras) | "
                     "desvío={:+.4f}{}", TAG, g_neutro, score_medio, g_score_n,
                     score_medio - g_neutro,
                     std::fabs(score_medio - g_neutro) > 0.02
                         ? "  ⚠ banda descentrada — revisar CLASS25A_NEUTRO" : "");
    }

    // 12. El acierto se REPORTA, pero ya no mueve el umbral (ver el bloque
    // «UMBRAL POR TASA DE EMISIÓN»: con un sistema de ~50 % la regla vieja era
    // un trinquete que terminaba siempre en el techo y dejaba de emitir).
    if (g_ventana.total_decisiones % RECALIB_CADA == 0 &&
        g_ventana.historial_outcomes.size() >= 20) {
        int ac = 0;
        for (bool b : g_ventana.historial_outcomes) if (b) ac++;
        const double accuracy = (double)ac / g_ventana.historial_outcomes.size();
        spdlog::info("[{}] 📊 acierto reciente {:.1f}% sobre {} resultados "
                     "(informativo: ya no mueve el umbral)",
                     TAG, accuracy * 100, g_ventana.historial_outcomes.size());
    }

    // 13. Control del umbral por TASA DE EMISIÓN.
    // Paso logarítmico: si el sistema está mudo (tasa ~0) corrige rápido; cerca
    // del objetivo, de a 0,005. Simulado: converge en menos de 6 h desde 0,70 y
    // queda estable en ±0,015 con cualquiera de las dispersiones plausibles.
    // Con el ranking activo el umbral no gobierna ninguna decisión de
    // instrumento, así que recalibrarlo es mover un número que nadie lee — y
    // peor, persistirlo. Se congela en el valor que tenga.
    if (!g_ranking && g_ventana.total_decisiones % EMISION_CADA == 0) {
        size_t n = 0, emitidas = 0;
        {
            std::lock_guard<std::mutex> lk(g_emision_mtx);
            n = g_emitidas.size();
            for (bool b : g_emitidas) if (b) emitidas++;
        }
        if (n >= EMISION_MIN) {
            const double tasa = (double)emitidas / (double)n;
            double u_prev, u_new;
            {
                std::lock_guard<std::mutex> lk(g_umbral_mtx);
                u_prev = g_umbral;
                const double mult = std::clamp(
                    std::fabs(std::log(std::max(tasa, 0.002) / g_emision_obj)) / std::log(2.0),
                    1.0, 6.0);
                const double paso = EMISION_PASO * mult;
                if      (tasa > g_emision_obj * (1.0 + EMISION_BANDA))
                    g_umbral = std::min(UMBRAL_MAX, g_umbral + paso);
                else if (tasa < g_emision_obj * (1.0 - EMISION_BANDA))
                    g_umbral = std::max(UMBRAL_MIN, g_umbral - paso);
                u_new = g_umbral;
            }
            if (std::fabs(u_new - u_prev) > 1e-9) {
                guardarUmbral(u_new, tasa);
                spdlog::info("[{}] 🔧 Umbral {:.3f} → {:.3f} (emisión {:.1f}%, "
                             "objetivo {:.0f}%, ventana {})",
                             TAG, u_prev, u_new, tasa * 100, g_emision_obj * 100, n);
            }
        }
    }
}

// ── Main ─────────────────────────────────────────────────────
// La simulación incluye este .cpp con -DMIIA_SIN_MAIN para ejercitar la lógica
// real sin arrancar el proceso. En producción la macro no existe.
#ifndef MIIA_SIN_MAIN
int main() {
    std::signal(SIGINT,  miia_signal);
    std::signal(SIGTERM, miia_signal);

    fs::path base = fs::current_path() / ".." / "operador" / "aprendizaje";
    fs::create_directories(base / "logs");
    fs::create_directories(base / "state");
    g_pesos_file    = base / "state" / "class25a_pesos.json";
    g_bayes_file    = base / "state" / "class25a_bayes.json";
    g_neutro_file   = base / "state" / "class25a_neutro.json";
    g_historial_file= base / "state" / "class25a_historial.json";
    g_umbral_file   = base / "state" / "class25a_umbral.json";

    // Config del umbral por magnitud desde el entorno (revertible sin recompilar)
    // ── Vida media de la base (en MUESTRAS) ─────────────────────────────
    // 0 = acumulador sin olvido, el comportamiento anterior al 21-sep. Es el
    // rollback: si despues del corte el ranking ordena raro, esto lo revierte
    // sin recompilar ni volver al binario viejo.
    if (const char* e = std::getenv("CLASS25A_BASE_VIDA_MEDIA")) {
        try {
            const double v = std::stod(e);
            if (v >= 0.0 && v <= 1e7) g_base_vida_media = v;
        } catch (...) { /* valor invalido -> se conserva el default */ }
    }
    g_base_alpha = g_base_vida_media > 0.0
                 ? 1.0 - std::pow(0.5, 1.0 / g_base_vida_media)
                 : 0.0;
    if (g_base_vida_media > 0.0)
        spdlog::info("[{}] 🧮 Base de z: EWMA, vida media {:.0f} muestras "
                     "(alfa {:.3e}) — ~{:.1f} ruedas para el 90 % de un cambio "
                     "de nivel. Antes era acumulada desde el arranque.",
                     TAG, g_base_vida_media, g_base_alpha,
                     3.32 * g_base_vida_media / 13000.0);
    else
        spdlog::warn("[{}] 🧮 Base de z: ACUMULADA sin olvido "
                     "(CLASS25A_BASE_VIDA_MEDIA=0) — es el comportamiento viejo: "
                     "no representa la rueda.", TAG);

    // El neutro se mide siempre; aplicarlo es opcional y por defecto NO.
    if (const char* e = std::getenv("CLASS25A_APLICAR_NEUTRO"))
        g_aplicar_neutro = !(std::string(e) == "0" || std::string(e) == "false");

    if (const char* e = std::getenv("CLASS25A_UMBRAL_MAGNITUD"))
        g_umbral_magnitud = !(std::string(e) == "0" || std::string(e) == "false");
    if (const char* e = std::getenv("CLASS25A_MARGEN_MAX")) {
        try {
            double v = std::stod(e);
            if (v > 0.0 && v <= 0.5) g_margen_max = v;
        } catch (...) { /* valor inválido → se conserva el default */ }
    }
    // Centro de la banda. El rango es solo un filtro anti-tipeo.
    //
    // ⚠ Era [0.30,0.70], calibrado suponiendo que el ensemble vivía cerca de 0.5.
    // MEDIDO en producción (2026-08-01, n=13 en 180 s): ensemble_score ≈ 0.709.
    // O sea que el valor CORRECTO caía fuera del rango y se descartaba con un
    // warning, cayendo al default 0.5 — peor que el valor mal calibrado que
    // reemplazaba. El techo, pensado como una red de seguridad, rechazaba
    // justamente la calibración buena.
    //
    // La razón de fondo: class21/22 solo publican por encima de su propio umbral
    // (score = conf·0.65 + estab·0.25 + coher·0.10, todas magnitudes NO negativas
    // y censuradas por abajo), así que el ensemble crudo no tiene por qué estar
    // centrado en 0.5 — y de hecho no lo está.
    if (const char* e = std::getenv("CLASS25A_NEUTRO")) {
        try {
            double v = std::stod(e);
            if (v >= 0.20 && v <= 0.90) g_neutro = v;
            else spdlog::warn("[{}] CLASS25A_NEUTRO={} fuera de [0.20,0.90] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → se conserva el default */ }
        // ⚠ El fix del doble conteo CAMBIA la escala de score_final: antes el
        // término bayesiano restaba ~0.09 fijo (prob_bayes quedaba en ~0.30 por
        // el bug) y ahora arranca en 0 y refuerza la dirección en vez de
        // sesgarla. Un CLASS25A_NEUTRO calibrado contra la escala VIEJA queda
        // demasiado bajo → todo saldría BUY.
        spdlog::warn("[{}] ⚠️ CLASS25A_NEUTRO={} viene del entorno. Si fue calibrado "
                     "ANTES del fix v2.4, está sobre la escala vieja y va a sesgar "
                     "todo a BUY. Recomendado: quitarlo (default 0.5), dejar correr "
                     "unos días y recalibrarlo con el score_medio que se loguea "
                     "cada 100 decisiones.", TAG, g_neutro);
    }
    // ── class44 al ensemble (ORDEN 2 #8) ─────────────────────────────────
    // 0 = sombra (default): se mide su aporte sin aplicarlo. 1 = activo.
    if (const char* e = std::getenv("CLASS25A_LSTM_MODO")) {
        try {
            int v = std::stoi(e);
            if (v == 0 || v == 1) g_lstm_modo = v;
            else spdlog::warn("[{}] CLASS25A_LSTM_MODO={} inválido (0|1) — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }
    spdlog::info("[{}] 🔦 class44 (LSTM): modo {} — {}", TAG,
                 g_lstm_modo == 1 ? "ACTIVO" : "SOMBRA",
                 g_lstm_modo == 1 ? "participa del ensemble"
                                  : "se mide su aporte sin aplicarlo");

    // Meta-introspección de class27 — mismo patrón que el LSTM: entra en
    // sombra y se activa deliberadamente cuando haya datos de si aporta.
    if (const char* e = std::getenv("CLASS25A_META_MODO")) {
        try {
            int v = std::stoi(e);
            if (v == 0 || v == 1) g_meta_modo = v;
            else spdlog::warn("[{}] CLASS25A_META_MODO={} inválido (0|1) — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }
    spdlog::info("[{}] 🧠 class27 (meta): modo {} — {}", TAG,
                 g_meta_modo == 1 ? "ACTIVO" : "SOMBRA",
                 g_meta_modo == 1 ? "amortigua la confianza"
                                  : "se registra qué amortiguaría, sin aplicarlo");

    // ── class27 modulando k ──────────────────────────────────────────────
    if (const char* e = std::getenv("CLASS25A_META_K")) {
        try {
            int v = std::stoi(e);
            if (v == 0 || v == 1) g_meta_k = v;
            else spdlog::warn("[{}] CLASS25A_META_K={} inválido (0|1) — se ignora", TAG, v);
        } catch (...) { }
    }
    spdlog::info("[{}] 🎚️  class27 sobre k: {} — {}", TAG,
                 g_meta_k == 1 ? "ACTIVO" : "apagado",
                 g_meta_k == 1 ? "con razonamiento degradado se emiten MENOS señales"
                               : "k fijo; class27 no cambia cuántas se emiten");

    // ── El par class40 + class41 como votantes ───────────────────────────
    if (const char* e = std::getenv("CLASS25A_VOTANTE_CRISIS")) {
        try {
            int v = std::stoi(e);
            if (v == 0 || v == 1) g_votante_crisis = v;
            else spdlog::warn("[{}] CLASS25A_VOTANTE_CRISIS={} inválido (0|1)", TAG, v);
        } catch (...) { }
    }
    spdlog::info("[{}] 🗳️  class40+class41 como votantes: {} — {}", TAG,
                 g_votante_crisis == 1 ? "ACTIVO" : "apagado",
                 g_votante_crisis == 1
                   ? "entran al ensamble POR INSTRUMENTO (lazo con ganancia: ver las notas internas)"
                   : "sólo alimentan la capa de crisis, que el ranking no lee");

    // ── Horizonte de debug ───────────────────────────────────────────────
    // CLASS25A_HORIZONTE_DEBUG_H=1 → todas las decisiones con horizonte 1 h.
    // Solo valores que existan en HORIZONTE_MS de class43.js: {1,4,24,48,72}.
    if (const char* e = std::getenv("CLASS25A_HORIZONTE_DEBUG_H")) {
        try {
            int v = std::stoi(e);
            if (v == 0 || v == 1 || v == 4 || v == 24 || v == 48 || v == 72) {
                g_horizonte_debug_h = v;
                if (v > 0)
                    spdlog::warn("[{}] ⚠️ HORIZONTE DEBUG = {} h — TODAS las decisiones "
                                 "usan este horizonte. Es para depurar el lazo de "
                                 "feedback, NO para medir: n_efectivo divide por 48 h.",
                                 TAG, v);
            } else {
                spdlog::warn("[{}] CLASS25A_HORIZONTE_DEBUG_H={} no está en HORIZONTE_MS "
                             "de class43.js — se ignora (caería a 24 h en silencio)", TAG, v);
            }
        } catch (...) { /* valor inválido → default */ }
    }
    // ── Auto-calibración del neutro ──────────────────────────────────────
    // CLASS25A_AUTO_NEUTRO_H = horas entre calibraciones (0 = desactivada).
    if (const char* e = std::getenv("CLASS25A_AUTO_NEUTRO_H")) {
        try {
            double v = std::stod(e);
            if (v >= 0.0 && v <= 720.0) g_auto_neutro_h = v;
            else spdlog::warn("[{}] CLASS25A_AUTO_NEUTRO_H={} fuera de [0,720] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }
    // El valor persistido GANA sobre el del entorno: es el que la propia
    // calibración midió, mientras que el del entorno queda viejo por
    // definición (es el motivo por el que existe esta función).
    // ── El reloj de calibración también se restaura ──────────────────────
    // `g_ultima_calib` es un steady_clock, que arranca de cero en cada proceso.
    // Inicializarlo siempre en now() reiniciaba la cuenta de 72 h en CADA
    // reinicio: entre el 5 y el 15-ago hubo reinicios el 5, el 11 y el 13, así
    // que la auto-calibración llegó a dispararse UNA sola vez en diez días
    // mientras la banda se corría (desvío −0.0337 → −0.0257, empeorando).
    //
    // Un sistema que se reinicia más seguido que su período de calibración
    // nunca calibra — y el síntoma es justamente el que se quería evitar:
    // g_neutro viejo y una de las dos señales muriéndose de hambre.
    //
    // Ahora se descuenta el tiempo transcurrido desde la última calibración
    // persistida. El clamp a g_auto_neutro_h evita que un archivo muy viejo
    // dispare la calibración con la primera decisión, antes de que la ventana
    // junte AUTO_NEUTRO_MIN_MUESTRAS.
    double horas_desde = -1.0;
    if (g_auto_neutro_h > 0.0) {
        double persistido = g_neutro;
        if (cargarNeutro(persistido, horas_desde)) {
            spdlog::info("[{}] 📐 Neutro auto-calibrado cargado de disco: {:.4f} "
                         "(pisa el del entorno)", TAG, persistido);
            g_neutro = persistido;
        }
    }
    g_ultima_calib = std::chrono::steady_clock::now();
    if (horas_desde > 0.0) {
        const double credito = std::min(horas_desde, g_auto_neutro_h);
        g_ultima_calib -= std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                              std::chrono::duration<double, std::ratio<3600>>(credito));
        spdlog::info("[{}] 📐 Última calibración hace {:.1f} h — próxima en {:.1f} h "
                     "(el reloj ya no se reinicia con el proceso)",
                     TAG, horas_desde, std::max(0.0, g_auto_neutro_h - credito));
    }

    // Peso máximo de la memoria bayesiana (0 = capa desactivada)
    if (const char* e = std::getenv("CLASS25A_BAYES_PESO_MAX")) {
        try {
            double v = std::stod(e);
            if (v >= 0.0 && v <= 0.60) g_bayes_peso_max = v;
            else spdlog::warn("[{}] CLASS25A_BAYES_PESO_MAX={} fuera de [0,0.60] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → se conserva el default */ }
    }

    // Palancas de los cambios del 12-sep, revertibles sin recompilar:
    // CLASS25A_ESCALA_Z=0 vuelve a decidir con el promedio crudo.
    if (const char* e = std::getenv("CLASS25A_ESCALA_Z")) {
        try {
            const double v = std::stod(e);
            if (v >= 0.0 && v <= 1.0) g_escala_z = v;
        } catch (...) { /* valor inválido → se conserva el default */ }
    }
    if (const char* e = std::getenv("CLASS25A_EMISION_OBJ")) {
        try {
            const double v = std::stod(e);
            if (v > 0.01 && v <= 0.90) g_emision_obj = v;
        } catch (...) { /* valor inválido → se conserva el default */ }
    }
    // Ranking transversal (21-sep). CLASS25A_RANKING=0 vuelve a la banda.
    if (const char* e = std::getenv("CLASS25A_RANKING")) {
        g_ranking = !(std::string(e) == "0" || std::string(e) == "false");
    }
    if (const char* e = std::getenv("CLASS25A_RANK_MIN")) {
        try {
            const int v = std::stoi(e);
            if (v >= 2 && v <= 1000) g_rank_min = v;
        } catch (...) { }
    }
    if (const char* e = std::getenv("CLASS25A_RANK_FRAC")) {
        try {
            const double v = std::stod(e);
            if (v > 0.0 && v < 0.5) g_rank_fraccion = v;
        } catch (...) { }
    }
    spdlog::info("[{}] 📊 Ranking transversal: {} (min={} instrumentos, "
                 "fracción={:.3f} → emisión estructural {:.0f}%)",
                 TAG, g_ranking ? "ACTIVO" : "apagado", g_rank_min, g_rank_fraccion,
                 2.0 * g_rank_fraccion * 100.0);

    init_logger(TAG, (base / "logs" / "class25A.log").string());
    spdlog::info("[{}] ══ Motor Cuantitativo MIIA v2.4 ══", TAG);
    spdlog::info("[{}] FIX v2.4: la bayesiana ya no cuenta las emisiones como "
                 "fallos (prob_bayes dejaba de estar acotada a ≤0.50)", TAG);
    spdlog::info("[{}] Salida: {}", TAG, CH_OUT);
    spdlog::info("[{}] Umbral inicial: {:.3f}", TAG, g_umbral);
    spdlog::info("[{}] Modo umbral: {} (margen_max={:.3f}, neutro={:.3f})", TAG,
                 g_umbral_magnitud ? "MAGNITUD (simétrico BUY/SELL)"
                                   : "UNILATERAL (comportamiento previo)",
                 g_margen_max, g_neutro);
    spdlog::info("[{}] Bayesiana: peso_max={:.2f} ({}), aplicación DIRECCIONAL",
                 TAG, g_bayes_peso_max,
                 g_bayes_peso_max <= 0.0 ? "DESACTIVADA" : "activa");
    if (g_auto_neutro_h > 0.0)
        spdlog::info("[{}] Auto-neutro: cada {:.0f} h desde score_medio "
                     "(mín {} muestras, desvío mín {:.3f}, amortiguación {:.0f}%) — {}",
                     TAG, g_auto_neutro_h, AUTO_NEUTRO_MIN_MUESTRAS,
                     AUTO_NEUTRO_MIN_DESVIO, AUTO_NEUTRO_AMORTIGUA * 100,
                     g_aplicar_neutro
                       ? "SE APLICA (CLASS25A_APLICAR_NEUTRO=1)"
                       : "sólo se OBSERVA: en modo z el neutro se cancela y el "
                         "ranking no lo usa. Sirve de termómetro de saturación.");
    else
        spdlog::info("[{}] Auto-neutro: DESACTIVADO (CLASS25A_AUTO_NEUTRO_H=0)", TAG);

    // Cargar estado persistido
    g_pesos.cargar(g_pesos_file);
    g_bayes.cargar(g_bayes_file);
    {
        double u = g_umbral;
        if (cargarUmbral(u)) {
            std::lock_guard<std::mutex> lk(g_umbral_mtx);
            g_umbral = u;
            spdlog::info("[{}] Umbral persistido cargado: {:.3f}", TAG, u);
        } else {
            spdlog::info("[{}] Sin umbral persistido: arranca en {:.3f}", TAG, g_umbral);
        }
    }
    spdlog::info("[{}] Decisión en z: escala={:.3f} ({}), emisión objetivo {:.0f}%",
                 TAG, g_escala_z,
                 g_escala_z > 0.0 ? "activa, con base propia por red"
                                  : "DESACTIVADA (promedio crudo)",
                 g_emision_obj * 100);

    auto pub = connect_redis(TAG);
    if (!pub) { spdlog::error("[{}] Sin Redis pub.", TAG); return 1; }

    // Heartbeat
    std::thread hb([&]() {
        while (g_running.load()) {
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if (!g_running.load()) break;
            double u; { std::lock_guard<std::mutex> lk(g_umbral_mtx); u = g_umbral; }
            auto pw = g_pesos.toJson();
            // Pesos por FUENTE (suma de las sub-redes de cada familia). Hasta el
            // 11-sep imprimía las claves peladas class21-24, que eran el voto de cada
            // módulo; desde que el nivel externo vota parejo ya no significan eso.
            double f_mer = 0, f_clu = 0, f_imp = 0, f_por = 0;
            for (auto& [k, v] : pw.items()) {
                const double p = v.get<double>();
                if      (k.size() > 8  && k.compare(k.size() - 8,  8,  "/mercado")   == 0) f_mer += p;
                else if (k.size() > 8  && k.compare(k.size() - 8,  8,  "/cluster")   == 0) f_clu += p;
                else if (k.size() > 8  && k.compare(k.size() - 8,  8,  "/impacto")   == 0) f_imp += p;
                else if (k.size() > 10 && k.compare(k.size() - 10, 10, "/portfolio") == 0) f_por += p;
            }
            size_t n_em = 0, em = 0;
            {
                std::lock_guard<std::mutex> lk(g_emision_mtx);
                n_em = g_emitidas.size();
                for (bool b : g_emitidas) if (b) em++;
            }
            spdlog::info("[{}] ❤️  decisiones={} umbral={:.3f} emisión={:.1f}% (obj {:.0f}%) "
                         "z={}/{} voto por módulo=parejo "
                         "pesos por fuente: mercado={:.2f} cluster={:.2f} impacto={:.2f} portfolio={:.2f}",
                TAG, g_ventana.total_decisiones.load(), u,
                n_em ? (double)em / (double)n_em * 100.0 : 0.0, g_emision_obj * 100,
                g_dec_z.load(), g_dec_z.load() + g_dec_crudo.load(),
                f_mer, f_clu, f_imp, f_por);
            // Ranking: la mezcla TIENE que salir simétrica (buy ≈ sell). Si no,
            // hay instrumentos entrando y saliendo de la sección a destiempo.
            if (g_ranking) {
                const uint64_t rb = g_rank_buy.load(), rs = g_rank_sell.load(),
                               rh = g_rank_hold.load();
                const uint64_t rt = rb + rs + rh;
                size_t vivos; { std::lock_guard<std::mutex> lk(g_xsec_mtx); vivos = g_xsec.size(); }
                spdlog::info("[{}]   ranking: buy={} sell={} hold={} → emisión {:.1f}% | "
                             "sección={} instrumentos (min {}) | sin_sección={} agregado={}",
                             TAG, rb, rs, rh,
                             rt ? (double)(rb + rs) / (double)rt * 100.0 : 0.0,
                             vivos, g_rank_min,
                             g_rank_sin_seccion.load(), g_rank_agregado.load());
                // ── Aporte de los votantes nuevos (26-sep-2026) ──────────
                // Una línea propia y con prefijo fijo `votantes:` para que
                // miia_check.sh la encuentre con un grep y pueda DIFERENCIAR
                // cuánto aporta cada uno, en vez de mirar un número agregado.
                spdlog::info("[{}]   votantes: class40={} class41={} "
                             "sin_ticker40={} sin_ticker41={} meta_k_recortes={} "
                             "modo_votante={} modo_meta_k={}",
                             TAG, g_v40_usos.load(), g_v41_usos.load(),
                             g_v40_sin_ticker.load(), g_v41_sin_ticker.load(),
                             g_metak_recortes.load(),
                             g_votante_crisis == 1 ? "ACTIVO" : "off",
                             g_meta_k == 1 ? "ACTIVO" : "off");
                if (g_fb_con_red.load())
                    spdlog::warn("[{}]   ⚠️ {} feedbacks trajeron `red` — la capa 1 está "
                                 "retirada, así que ese crédito NO se está aplicando. "
                                 "Revisar class43 antes de volver a usarlo.",
                                 TAG, g_fb_con_red.load());
            }
        }
    });
    hb.detach();

    // Timer de ventana: procesa si pasaron VENTANA_MS sin nueva señal
    std::thread timer([&]() {
        while (g_running.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            std::vector<std::string> vencidas;
            {
                std::lock_guard<std::mutex> lk(g_ventana.mtx);
                // ORDEN 1: barrer TODAS las ventanas vencidas, no una sola.
                // Cada instrumento tiene su propio reloj: XLK puede completar
                // sus 4 redes en 2 s y EWZ vencer por timeout a los 5 s.
                const auto ahora = std::chrono::steady_clock::now();
                for (auto& [tk, v] : g_ventana.porTicker) {
                    if (v.redes.empty()) continue;
                    if (ahora - v.inicio > std::chrono::milliseconds(VENTANA_MS))
                        vencidas.push_back(tk);
                }
            }
            // Fuera del lock: procesarVentana vuelve a tomarlo.
            for (const auto& tk : vencidas) procesarVentana(pub, tk);
        }
    });
    timer.detach();

    // Loop principal de suscripción
    while (g_running.load()) {
        try {
            sw::redis::ConnectionOptions o;
            o.host="127.0.0.1"; o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);
            o.socket_timeout=std::chrono::seconds(0);
            Redis subR(o);
            auto sub = subR.subscriber();

            sub.on_message([&](std::string ch, std::string raw) {
                try {
                    auto j = json::parse(raw);
                    if (j.value("source","") == TAG) return;

                    // ── FILTRO ANTI-ECO EN TODOS LOS CANALES (10-oct-2026) ──
                    // El árbitro (operador/index.js, TARGET) reparte la decisión
                    // final de class25B con source:"arbiter" en class21-24_output
                    // y class40/41_output, los mismos canales que se escuchan acá.
                    // Llega con el ticker del instrumento y sin `fuente`, así que
                    // armaba una ventana propia con las claves peladas (class21…
                    // class24) cuyo score era la `confianza` de la decisión
                    // anterior. Con la confianza por posición, un SELL de 0,99
                    // volvía como voto alcista y salía BUY 2 s después. Medido en
                    // la réplica del 10-oct: el 72 % de las BUY/SELL salía del
                    // eco; con este filtro, una decisión por instrumento y por
                    // ciclo, todas de la red de mercado. El filtro de class27_output
                    // de abajo (por `origen`) queda igual.
                    if (j.value("source","") == "arbiter") return;

                    // ── Meta-introspección de class27 ───────────────────────
                    if (ch == CH_META) {
                        // FILTRO ANTI-ECO: el árbitro (index.js) republica la
                        // decisión final DENTRO de class27_output con
                        // source:"arbiter". Aceptarla realimentaría a class25A
                        // con su propia salida. class27 estampa origen:"class27";
                        // el árbitro no. Ese campo separa lo legítimo del eco.
                        if (j.value("origen", "") != "class27") return;

                        // DEDUP por hash: class27 emite cada 30 s y repite la
                        // misma reflexión mientras el patrón siga activo.
                        const std::string h = j.value("hash", "");
                        if (h.empty()) return;

                        bool over = false, drop = false;
                        if (j.contains("kinds") && j["kinds"].is_array()) {
                            for (const auto& k : j["kinds"]) {
                                if (!k.is_string()) continue;
                                const std::string s = k.get<std::string>();
                                if (s == "overconfidence") over = true;
                                else if (s == "quality_drop") drop = true;
                            }
                        }
                        {
                            std::lock_guard<std::mutex> lk(g_meta.mtx);
                            if (g_meta.vistos.count(h)) return;   // ya procesada
                            g_meta.vistos.insert(h);
                            g_meta.orden.push_back(h);
                            while (g_meta.orden.size() > META_DEDUP_MAX) {
                                g_meta.vistos.erase(g_meta.orden.front());
                                g_meta.orden.pop_front();
                            }
                            g_meta.overconfidence = over;
                            g_meta.quality_drop   = drop;
                            g_meta.ts_ms          = ahora_ms();
                        }
                        spdlog::info("[{}] 🧠 meta class27: overconfidence={} quality_drop={} "
                                     "hash={} modo={}", TAG, over, drop, h.substr(0, 8),
                                     g_meta_modo ? "ACTIVO" : "sombra");
                        return;
                    }

                    // ── Feedback de class43 → actualizar pesos y bayesiana ──
                    if (ch == CH_FB) {
                        std::string red    = j.value("red", "");
                        bool acerto        = j.value("acerto", false);
                        std::string hash_c = j.value("hash_condicion", "");

                        // ── DEFECTO 2 — RESUELTO AL REVÉS de lo anotado ─────
                        // El plan decía: «el `if/else` hace excluyentes las dos
                        // capas; cambiarlo por `if` las vuelve redundantes de
                        // verdad, que es lo que el comentario ya afirmaba».
                        // **Esa nota quedó vieja el 12-sep** y seguirla ahora
                        // sería un retroceso.
                        //
                        // Qué pasó en el medio: la capa 1 usaba la regla vieja
                        // —`actualizar()`, que hace clamp a [0,10 , 0,50] y
                        // RENORMALIZA las 21 claves en cada llamada—, así que
                        // premiaba a la red nombrada aunque se hubiera
                        // equivocado y dividía a todas las demás. Medido el
                        // viernes 11-sep en rueda: los pesos de class23 y
                        // class24 cayeron a 1e-35 en cuatro horas. Simulado a
                        // 10 días (`sim1_credito.js`) con una red que acierta
                        // 55 % contra quince que aciertan 50 %: **con la capa 1
                        // prendida la separación entre la red buena y el azar
                        // es 0,000; con el crédito yendo entero a la capa 2, es
                        // 0,339.** El 12-sep se desplegó que class43 mande
                        // `red: ""` justamente para apagarla.
                        //
                        // O sea que volver las dos capas redundantes no las
                        // hace más robustas: re-arma la regla que tapa el
                        // aprendizaje de la otra. La capa 2 ya juzga a CADA red
                        // contra su propia línea de base y sólo redistribuye
                        // entre las presentes — hace el trabajo completo.
                        //
                        // Así que la capa 1 se retira. `red` se sigue leyendo
                        // sólo para CONTAR: si un cambio futuro en class43
                        // vuelve a mandarla, el contador lo dice en el
                        // heartbeat en vez de que la regla vieja se encienda
                        // sola y en silencio.
                        if (!red.empty()) g_fb_con_red++;

                        if (!hash_c.empty()) {
                            // Dirección real: explícita de class43, o deducida.
                            // (BUY acertó ⇒ subió; SELL acertó ⇒ bajó)
                            int dir = 0;
                            std::string dr = j.value("direccion_real", "");
                            if      (dr == "up")   dir =  1;
                            else if (dr == "down") dir = -1;
                            else {
                                std::string sfb = j.value("senal", "");
                                if (sfb == "BUY" || sfb == "SELL")
                                    dir = ((sfb == "BUY") == acerto) ? 1 : -1;
                            }
                            if (dir != 0) {
                                // ORDEN 3 — selección por CERCANÍA temporal.
                                // class43 ahora manda decision_ts en este mismo
                                // payload. Con la cola por hash, se elige la
                                // entrada que corresponde a ESTA decisión y no
                                // "la última que quedó" (que con 4.300
                                // decisiones/día era casi siempre otra).
                                const int64_t dts25 = j.value("decision_ts", (int64_t)0);
                                std::map<std::string,double> snap;
                                std::map<std::string,BaseRed> bases;   // copia bajo el lock
                                int64_t lag_ms = 0; bool hubo = false, lejano = false;
                                {
                                    std::lock_guard<std::mutex> lk(g_snap_mtx);
                                    auto it = g_snaps.find(hash_c);
                                    if (it != g_snaps.end() && !it->second.empty()) {
                                        auto& q = it->second;
                                        size_t best = 0;
                                        if (dts25 > 0) {
                                            int64_t mejor = INT64_MAX;
                                            for (size_t i = 0; i < q.size(); i++) {
                                                const int64_t d = std::llabs(dts25 - q[i].ts_ms);
                                                if (d < mejor) { mejor = d; best = i; }
                                            }
                                            lag_ms = dts25 - q[best].ts_ms;
                                        } else {
                                            // Sin decision_ts (payload viejo): la
                                            // más antigua. La reconciliación
                                            // procesa ORDER BY ts_decision ASC,
                                            // así que FIFO es la mejor apuesta.
                                            best = 0;
                                        }
                                        // DEFECTO 3 (medido 10/11-sep): lag de -21
                                        // a -25 h. La entrada correcta ya había sido
                                        // desalojada y se elegía la más cercana que
                                        // quedaba: el resultado de una decisión se le
                                        // cobraba a la opinión de otra, tomada un día
                                        // después. Más allá de CAPA2_LAG_MAX_MS no es
                                        // el snapshot de esta decisión: no se usa NI
                                        // se consume, puede ser el de otra que
                                        // todavía no volvió.
                                        if (dts25 > 0 && std::llabs(lag_ms) > CAPA2_LAG_MAX_MS) {
                                            lejano = true;
                                        } else {
                                            snap = q[best].scores;
                                            for (const auto& kv : snap) {
                                                auto b = g_base.find(kv.first);
                                                if (b != g_base.end()) bases[kv.first] = b->second;
                                            }
                                            // CONSUMIR: cada outcome corresponde a
                                            // una decisión. Dejarla acumularía
                                            // crédito repetido sobre el mismo
                                            // snapshot.
                                            // ptrdiff_t, no long: en Windows long
                                            // son 32 bits y en Linux 64.
                                            q.erase(q.begin() + (std::ptrdiff_t)best);
                                            g_snaps_total--;
                                            if (q.empty()) g_snaps.erase(it);
                                            hubo = true;
                                        }
                                    }
                                }
                                // Cada red se juzga contra SU línea de base, no
                                // contra g_neutro (ver g_base). Sin base todavía,
                                // constante, o dentro de la zona muerta: no cobra
                                // ni paga. El reparto es de suma cero entre las
                                // que sí opinaron (ver Pesos::actualizarEvento).
                                std::vector<std::pair<std::string,bool>> ups;
                                int n_ok = 0, n_err = 0, n_sinbase = 0, n_neutra = 0;
                                for (const auto& kv : snap) {
                                    auto b = bases.find(kv.first);
                                    if (b == bases.end() || b->second.n < CAPA2_MIN_MUESTRAS) { n_sinbase++; continue; }
                                    const double sd = desvioBase(b->second);
                                    if (!(sd > 1e-9)) { n_sinbase++; continue; }   // constante: no opina
                                    const double z = (kv.second - b->second.media) / sd;
                                    if (std::fabs(z) < CAPA2_Z_MIN) { n_neutra++; continue; }
                                    const bool ok = (z > 0) == (dir > 0);
                                    if (ok) n_ok++; else n_err++;
                                    ups.emplace_back(kv.first, ok);
                                }
                                if (!ups.empty()) g_pesos.actualizarEvento(ups);
                                if (hubo)
                                    spdlog::info("[{}] ⚖️ Atribución local: {} redes ({} ok {} err {} sin base {} neutras), dir={} lag={}s",
                                                 TAG, snap.size(), n_ok, n_err, n_sinbase, n_neutra,
                                                 dir > 0 ? "sube" : "baja", lag_ms / 1000);
                                else if (lejano) {
                                    static std::atomic<uint64_t> lejos{0};
                                    const uint64_t n = ++lejos;
                                    if (n == 1 || n % 100 == 0)
                                        spdlog::warn("[{}] ⚠️ Snapshot descartado: lag={}s (> {}s), es la opinión "
                                                     "de otra decisión; los pesos NO se tocan [{} acumulados]",
                                                     TAG, lag_ms / 1000, CAPA2_LAG_MAX_MS / 1000, n);
                                }
                                else {
                                    // NO silencioso: que el snapshot falte es
                                    // justamente el defecto que ORDEN 3 vino a
                                    // corregir. Si esto sigue apareciendo, el
                                    // arreglo no alcanzó.
                                    // Rate-limit: el primero y después 1 de
                                    // cada 100 — con 112 feedbacks por ciclo de
                                    // reconciliación, loguear todos inundaría un
                                    // log que ya acumula GB.
                                    static std::atomic<uint64_t> sin_snap{0};
                                    const uint64_t n = ++sin_snap;
                                    if (n == 1 || n % 100 == 0)
                                        spdlog::warn("[{}] ⚠️ Sin snapshot para hash={} (dts={}) — "
                                                     "los pesos por sub-red NO se actualizan "
                                                     "[{} acumulados]",
                                                     TAG, hash_c.substr(0, 8), dts25, n);
                                }
                            }
                        }
                        if (!hash_c.empty()) {
                            g_bayes.registrarOutcome(hash_c, acerto, "feedback_class43");
                        }
                        // Registrar en historial de accuracy
                        {
                            std::lock_guard<std::mutex> lk(g_ventana.mtx);
                            g_ventana.historial_outcomes.push_back(acerto);
                            if ((int)g_ventana.historial_outcomes.size() > 100)
                                g_ventana.historial_outcomes.pop_front();
                        }
                        g_pesos.guardar(g_pesos_file);
                        spdlog::info("[{}] 🎯 Feedback: red={} acerto={}", TAG, red, acerto);
                        return;
                    }

                    // ── Señales de crisis (class40/41) — siempre actualizadas ──
                    if (ch == "class40_output") {
                        std::lock_guard<std::mutex> lk(g_ventana.mtx);
                        g_ventana.crisis40 = j;
                        return;
                    }
                    if (ch == "class41_output") {
                        {   // compat: el caché global que ya existía
                            std::lock_guard<std::mutex> lk(g_ventana.mtx);
                            g_ventana.crisis41 = j;
                        }
                        // Y, si lo mandó el class41 REAL, además por instrumento.
                        //
                        // OJO CON LOS NOMBRES: class41 publica
                        // `riskMetrics.riskScore` / `.probDown` (camelCase), y el
                        // parseo de arriba busca `riesgo` / `risk_level`. O sea
                        // que aunque class41 hubiera corrido, el valor caía al
                        // default 0.5 y no aportaba nada. Es el mismo tipo de
                        // desajuste de contrato que lo tenía muerto.
                        const std::string tk41 = canonTicker(j.value("ticker", ""));
                        if (!tk41.empty() && j.contains("riskMetrics") &&
                            j["riskMetrics"].is_object()) {
                            const auto& rm = j["riskMetrics"];
                            const double rs = rm.value("riskScore", -1.0);
                            const double pd = rm.value("probDown",  -1.0);
                            if (rs >= 0.0 || pd >= 0.0) {
                                SenalCrisisT c;
                                // Más riesgo de caída ⇒ más bajista. probDown es
                                // directamente la probabilidad bajista; si no
                                // viene, se usa riskScore.
                                const double bajista = pd >= 0.0 ? pd : rs;
                                c.score  = std::clamp(1.0 - bajista, 0.0, 1.0);
                                c.riesgo = std::clamp(rs >= 0.0 ? rs : bajista, 0.0, 1.0);
                                c.ts     = std::chrono::steady_clock::now();
                                std::lock_guard<std::mutex> lk(g_ventana.mtx);
                                g_ventana.rk41[tk41] = c;
                            }
                        } else if (tk41.empty()) {
                            g_v41_sin_ticker++;
                        }
                        return;
                    }

                    // ── Pronóstico REAL de class40, por instrumento ────────────
                    if (ch == CH_FC40) {
                        const std::string tk40 = canonTicker(j.value("ticker", ""));
                        if (tk40.empty()) { g_v40_sin_ticker++; return; }
                        if (!j.contains("ensemble") || !j["ensemble"].is_object()) return;
                        const auto& preds = j["ensemble"]["predictions"];
                        if (!preds.is_array() || preds.size() < 2) return;
                        const double v0 = preds.front().value("value", 0.0);
                        const double vN = preds.back().value("value", 0.0);
                        if (std::abs(v0) < 1e-9) return;
                        // Pendiente del pronóstico → 0-1 direccional, la misma
                        // forma que usa class11 para su `pronosticoScore`.
                        const double delta = (vN - v0) / std::abs(v0);
                        SenalCrisisT c;
                        c.score  = std::clamp(0.5 + delta * 2.0, 0.0, 1.0);
                        // El ancho del intervalo es incertidumbre: sirve de riesgo.
                        double ancho = 0.0; int n = 0;
                        for (const auto& pr : preds) {
                            const double up = pr.value("upper", 0.0);
                            const double lo = pr.value("lower", 0.0);
                            if (up != 0.0 || lo != 0.0) { ancho += std::abs(up - lo); n++; }
                        }
                        c.riesgo = n > 0 ? std::clamp(ancho / n / std::abs(v0) * 5.0, 0.0, 1.0) : 0.5;
                        c.ts     = std::chrono::steady_clock::now();
                        std::lock_guard<std::mutex> lk(g_ventana.mtx);
                        g_ventana.fc40[tk40] = c;
                        return;
                    }

                    // ── LSTM por instrumento (class44) ──────────────────────
                    // NO se usa `confianza`: class44 publica ahí prob de la clase
                    // GANANDORA (probs[idx_max]), que es agnóstica a la dirección
                    // — un SELL convencido y un BUY convencido publican 0.85 los
                    // dos. Leerla como score direccional metería los SELL fuertes
                    // al ensemble como señal alcista. Es el mismo error que ya se
                    // corrigió el 24-jul en el canal de crisis, donde su confianza
                    // cruda se leía como "prob de crash".
                    //
                    // El score direccional sale de la softmax completa:
                    //   dir = prob_buy + 0.5·prob_hold  =  0.5 + (prob_buy − prob_sell)/2
                    // que da 0 con SELL puro, 0.5 con HOLD puro y 1 con BUY puro.
                    if (ch == CH_LSTM) {
                        const std::string tk = j.value("ticker", j.value("symbol", std::string("")));
                        if (tk.empty()) return;
                        if (!j.contains("prob_buy") || !j.contains("prob_sell")) {
                            static bool avisado = false;
                            if (!avisado) {
                                avisado = true;
                                spdlog::warn("[{}] ⚠️ class44 sin prob_buy/prob_sell — no se puede "
                                             "derivar dirección, se ignora su aporte", TAG);
                            }
                            return;
                        }
                        SenalLstm sl;
                        const double pb = j.value("prob_buy",  0.0);
                        const double ph = j.value("prob_hold", 0.0);
                        sl.score_dir = std::clamp(pb + 0.5 * ph, 0.0, 1.0);
                        sl.conf      = j.value("confianza", 0.0);
                        sl.senal     = j.value("senal", std::string(""));
                        sl.ts        = std::chrono::steady_clock::now();
                        std::lock_guard<std::mutex> lk(g_ventana.mtx);
                        g_ventana.lstm44[tk] = sl;
                        return;
                    }

                    // ── Señales de redes neuronales (class21-24) ─────────────
                    Señal s = parsearSeñal(ch, j);
                    bool completa = false;
                    {
                        std::lock_guard<std::mutex> lk(g_ventana.mtx);

                        // ORDEN 1: la señal va a la ventana de SU instrumento.
                        // Si el ticker es nuevo se abre una ventana con su
                        // propio reloj de 5 s.
                        if (g_ventana.porTicker.size() >= MAX_VENTANAS &&
                            !g_ventana.porTicker.count(s.ticker)) {
                            static bool avisado = false;
                            if (!avisado) {
                                avisado = true;
                                spdlog::warn("[{}] ⚠️ {} ventanas simultáneas — se ignoran "
                                             "tickers nuevos. Revisar qué llega de class19.",
                                             TAG, MAX_VENTANAS);
                            }
                            return;
                        }
                        auto& v = g_ventana.porTicker[s.ticker];
                        if (v.redes.empty())
                            v.inicio = std::chrono::steady_clock::now();
                        // Clave COMPUESTA ("class24/impacto"): antes era solo
                        // el módulo, así que las cuatro sub-redes de class23 y
                        // class24 compartían ranura y se pisaban entre sí.
                        v.redes[claveEnsemble(ch, s.fuente)] = s;
                        // "Completa" cuenta MÓDULOS distintos, no entradas: las
                        // cuatro sub-redes de class24 siguen siendo un módulo a
                        // efectos de saber si ya llegaron class21/22/23/24.
                        {
                            std::set<std::string> mods;
                            for (const auto& kv : v.redes) mods.insert(moduloDe(kv.first));
                            completa = (mods.size() >= 4);
                        }
                        // Contrato roto = constante silenciosa en el ensemble.
                        // Se avisa UNA vez por red para no spamear el log.
                        if (!s.tiene_score) {
                            static std::set<std::string> avisadas;
                            if (avisadas.insert(s.red).second)
                                spdlog::warn("[{}] ⚠️ {} NO publica score/confianza "
                                             "(ni arriba ni en data) → se EXCLUYE del ensemble "
                                             "mientras otra red sí publique. Revisar su payload.", TAG, s.red);
                        }

                    }

                    // Si este instrumento ya juntó sus 4 redes, se decide ya.
                    // La lectura vieja de `g_ventana.redes.size()` estaba FUERA
                    // del lock — data race además de global.
                    if (completa) procesarVentana(pub, s.ticker);

                } catch (const json::exception& e) {
                    spdlog::warn("[{}] JSON: {}", TAG, e.what());
                } catch (const std::exception& e) {
                    spdlog::warn("[{}] handler: {}", TAG, e.what());
                }
            });

            // Suscribir a todos los canales
            sub.subscribe(CH_FB);
            for (const auto& ch : CH_REDES)  sub.subscribe(ch);
            for (const auto& ch : CH_CRISIS) sub.subscribe(ch);
            sub.subscribe(CH_LSTM);
            sub.subscribe(CH_META);   // class27 — meta-introspección (sombra)
            sub.subscribe(CH_FC40);   // class40 — pronóstico real, por instrumento

            spdlog::info("[{}] 📡 Suscrito a {} canales", TAG,
                         3 + CH_REDES.size() + CH_CRISIS.size());

            while (g_running.load()) sub.consume();

        } catch (const std::exception& e) {
            if (g_running.load()) {
                spdlog::warn("[{}] Reconectando: {}", TAG, e.what());
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        }
    }

    // Guardar estado al salir
    g_pesos.guardar(g_pesos_file);
    g_bayes.guardar(g_bayes_file);
    spdlog::info("[{}] ✅ Shutdown limpio.", TAG);
    return 0;
}
#endif  // MIIA_SIN_MAIN
