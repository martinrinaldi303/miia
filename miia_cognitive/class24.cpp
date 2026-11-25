// class24.cpp — MLP Online con Feedback Real v3.0
// ============================================================
// CAMBIOS v3.0 respecto a v2.2  (⚠ ESTE ES EL FIX IMPORTANTE)
//
//   UNA RED POR (fuente, dimensión) — antes había UNA SOLA red global
//   que se DESTRUÍA a sí misma cada vez que cambiaba la dimensión
//   del vector de entrada.
//
//   PROBLEMA ORIGINAL (v2.2 y anteriores):
//     Los tres puntos de entrada al MLP hacían lo mismo:
//
//         if (inDim != (int)x.size() || W1.empty()) init((int)x.size());
//
//     ...en score(), en trainStep() y en trainSupervised(). Y init()
//     reasigna W1, b1, W2, b2=0, ema=0, seen=0 — o sea, BORRA todo lo
//     aprendido y vuelve a la inicialización aleatoria.
//
//     class19 publica el MISMO envelope a los 4 canales de las redes,
//     y las dimensiones alternan permanentemente:
//
//         class10 mercado        →  64 dims
//         class18 portfolio      →  32 dims
//         class18 impacto/cluster→  12 dims
//         class3  TF-IDF         →  64 dims  (era 128 y la red nunca existió;
//                                             ver class3.cs, 26-sep-2026)
//         texto MiniLM (class19) → 384 dims  (o 64 si cae al fallback)
//
//     Con las fuentes intercalándose, class24 se reseteaba a pesos
//     aleatorios varias veces por MINUTO. Nunca acumuló aprendizaje.
//
//   POR QUÉ NO SE VEÍA EN NINGÚN PANEL:
//     init() NO resetea supervised_count. Entonces el heartbeat mostraba
//     "supervised=1847" creciendo prolijamente mientras los pesos se
//     borraban. La ÚNICA métrica que sobrevivía al reset era justo la
//     que hacía creer que la red estaba aprendiendo.
//
//   SOLUCIÓN:
//     - Un MLP24 por clave "fuente|dim" (mismo criterio que class23, que
//       ya lo hacía bien desde su v2.2). La dimensión va EN LA CLAVE: si
//       una fuente cambia de dimensión se crea una red nueva en vez de
//       destruir la que ya venía entrenando.
//     - init() dejó de existir como método público destructivo. Cada red
//       se construye UNA vez con su dimensión y nunca se re-inicializa.
//       forward/score con dimensión equivocada loguean y devuelven 0.5,
//       nunca pisan pesos. El bug no puede volver por otro camino.
//     - Cada pendiente recuerda la clave de la red que lo produjo, así el
//       feedback entrena la red correcta (antes había una sola).
//     - Semillas distintas por fuente → diversidad real entre redes.
//
//   SE MANTIENE DE v2.2 (no tocado a propósito):
//     - pending con TTL de 80h + thread de limpieza cada 30 min
//     - PENDING_MAX=20000 (tope de seguridad; quien acota es el TTL)
//     - matcheo del feedback por TIEMPO (ventana -900s..+120s)
//     - arquitectura inDim → 64 (relu) → 1 (sigmoid), lr=0.01
//       H fijo en 64 a propósito: class23 usa capas proporcionales, y que
//       las dos redes NO compartan arquitectura es lo que le da diversidad
//       real al ensemble de class25A.
//
//   ✅ RESUELTO 3-sep-2026 — era el PENDIENTE CONOCIDO de arriba:
//     modoEMA() entrenaba hacia su propia EMA sin feedback supervisado.
//     La predicción del comentario original ("contrae la salida hacia una
//     constante") se confirmó midiendo: la red 'mercado' quedó clavada en
//     ema=0.9511 durante 360 heartbeats. Ahora modoEMA() NO entrena — solo
//     registra la EMA. Ver la nota extensa sobre la función.
//
// Entrada: class24_ingest + class24_feedback | Salida: class24_output
// Plataforma: C++17 portable (probado en Ubuntu 22.04 / g++ 11)
// ============================================================

#include "miia_common.h"
#include <random>
#include <cstdint>   // int64_t / INT64_MAX — diagnóstico de lag del feedback
#include <cstdlib>   // std::llabs
#include <fstream>   // persistencia de pesos a JSON

// ════════════════════════════════════════════════════════════
// ORDEN 3 (v3.1) — DOS CORRECCIONES
//
//   1. NORMALIZACIÓN. class24 no normalizaba NADA. El envelope de class19
//      mezcla change (~±0.03), precio/open (~1.0), estado (0/0.5/1), riesgo
//      (0-1) y similitud con crisis (0-1). Con Xavier ~sqrt(2/inDim) y
//      lr=0.01, las dims de magnitud ~1 dominan el gradiente y la dim 3 de
//      ORDEN 1 —el change relativo al promedio, que ES la feature de la
//      etiqueta— era el input más débil de la red.
//      Encima class23 SÍ normalizaba, con normalize_zscore (por muestra):
//      el mismo envelope llegaba a las dos redes con preprocesamiento
//      incompatible, y ninguno de los dos era correcto.
//      Ahora las dos usan RunningNorm (por feature, miia_common.h).
//
//   2. ema/seen CONGELADOS. Solo se tocaban en modoEMA() y trainWith().
//      modoEMA() deja de llamarse al primer outcome supervisado y score()
//      es const → apenas una red empieza a entrenar, su `ema` deja de
//      seguir al mercado y pasa a ser el promedio sobre ejemplos de
//      entrenamiento replayados de hace 48 h, y `seen` se congela respecto
//      del tráfico. Ese número se publicaba como `ema` y se leía en el
//      chequeo semanal como "qué opina la red ahora". No lo era.
//      Ahora hay ema_infer/seen_infer y se publican los dos, rotulados.
//
//   COSTO: PESOS_VERSION 1→2. Los pesos v1 se entrenaron sobre otra
//   distribución de entrada y se descartan al arrancar.
// ════════════════════════════════════════════════════════════
static constexpr const char* TAG         = "class24";
static constexpr const char* CH_IN       = "class24_ingest";
static constexpr const char* CH_FEEDBACK = "class24_feedback";
static constexpr const char* CH_OUT      = "class24_output";

static constexpr int    H_UNITS      = 64;
// ── TASA DE APRENDIZAJE (1-oct-2026) ─────────────────────────────────────
// Era 0.01, y era demasiado para cómo llegan las etiquetas. Todos los vectores
// de un instrumento en una rueda llevan LA MISMA etiqueta (medido el 18-sep:
// XLE 246/246, XLC 0/259): con 50 instrumentos entran ~19.000 ejemplos por día
// pero sólo 50 etiquetas independientes, repetidas ~380 veces cada una. Con
// 0.01 la red memorizaba el día — es el mecanismo de «se da vuelta entera»
// entre lecturas (ema_inf 0,24 → 0,94 en 24 h).
//
// El valor nuevo sale de sim26_retencion.cpp, que corre ESTA red con ese
// caudal. `CLASS24_LR` lo cambia sin recompilar; `CLASS24_LR=0.01` es el
// comportamiento anterior. La tasa NO se toma del archivo de pesos: manda el
// binario (o el entorno), porque un archivo guardado con 0.01 la devolvería.
static constexpr double LR_ANTERIOR  = 0.01;
static constexpr double LR           = 0.0003;
static double           g_lr         = LR;
// Cap de entradas pendientes. Historia de este número, porque cada valor
// respondía a un caudal distinto y quedarse corto rompe el aprendizaje EN
// SILENCIO (los vectores nuevos no se guardan y 48 h después el feedback no
// encuentra con qué entrenar):
//
//   2000  → asumía "5 señales/hora". El ritmo real era ~120/h → cubría 17 h,
//           menos que el horizonte de 48 h: `supervised` quedaba en 0 para
//           siempre y la red nunca entrenaba.
//   20000 → medido 2026-08-03: 6.018 vectores en 57 h = ~105/h. Con TTL de
//           80 h el régimen era ~8.400 pendientes. Holgado.
//   120000 → ORDEN 1. class10 pasa de emitir 1 vector agregado por minuto a
//           13 (uno por instrumento), y el rate-limit de class19 ahora es POR
//           TICKER. El caudal sube a ~885/h → régimen ~70.800 pendientes.
//           Con el cap viejo se llenaba en ~22 h.
//
// Memoria: ~120k entradas × ~100 dims × 8 B ≈ 100 MB de vectores (~200 MB con
// el overhead del hash map). El server tiene 8,7 GB libres.
// Quien acota de verdad sigue siendo el TTL; el cap es el tope de seguridad.
static constexpr int    PENDING_MAX  = 120000;
// TTL en milisegundos: 80 horas > horizonte máximo de class43 (72h)
static constexpr int64_t PENDING_TTL_MS = 80LL * 60 * 60 * 1000;
static constexpr int    CLEANUP_SEC  = 30 * 60; // limpieza cada 30 minutos
// Tope de ejemplos entrenados por cada mensaje de feedback.
//
// 21-sep-2026 — SUBIDO DE 50 A 150 junto con el defecto 10. Antes el tope se
// repartía entre TODOS los instrumentos de la ventana, así que se llenaba
// siempre y truncar era el régimen normal. Ahora el lote es de un solo
// instrumento: en rueda entran ~600 predicciones por ventana de 15 min entre
// 13 instrumentos más GENERAL, o sea **~43 esperadas por ticker**. Con 50 se
// truncaba en cuanto un instrumento se pasaba un 16 % del promedio, y lo que
// sobraba NO se entrenaba nunca: su feedback ya había pasado, así que quedaba
// esperando al TTL. 150 son 3,5 veces lo esperado.
//
// El tope existe para acotar el trabajo bajo el lock, no por memoria: 150
// vectores de ~100 dimensiones no es nada. Si `lote_truncado` del heartbeat
// deja de ser 0, hay que volver a mirar este número.
static constexpr int    MAX_LOTE_FB  = 150;

// ── Activaciones ────────────────────────────────────────────
static double sigmoid(double x) { return 1.0 / (1.0 + std::exp(-std::max(-500.0, x))); }
static double relu(double x)    { return x > 0 ? x : 0; }
static double dRelu(double x)   { return x > 0 ? 1.0 : 0.0; }

// ── MLP: inDim → 64(relu) → 1(sigmoid) ─────────────────────
// v3.0: la dimensión se fija EN EL CONSTRUCTOR y no cambia nunca más.
// Ya no existe init() re-invocable desde el camino caliente: esa era la
// vía por la que la red se borraba a sí misma.
struct MLP24 {
    int    inDim = 0, H = H_UNITS;
    double lr    = g_lr;
    std::vector<std::vector<double>> W1;
    std::vector<double> b1, W2;
    double b2 = 0, ema = 0;
    int    seen = 0, supervised_count = 0;
    std::string fuente;

    // ── ORDEN 3 ──────────────────────────────────────────────
    // Normalización POR FEATURE. class24 no normalizaba NADA: con Xavier
    // ~sqrt(2/inDim) y lr=0.01, las dims de magnitud ~1.0 (precio/open)
    // dominaban el gradiente y la dim 3 de ORDEN 1 (~0.005, el change
    // relativo al promedio — la feature de la etiqueta) era el input más
    // débil de la red. Ver la nota en miia_common.h.
    RunningNorm norm;

    // EMA y contador de INFERENCIA, separados de los de entrenamiento.
    //
    // El defecto: `ema` y `seen` solo se tocan en modoEMA() y trainWith().
    // Pero modoEMA() deja de llamarse en cuanto llega el primer outcome
    // (`if (supervised_count == 0) red.modoEMA(emb)`) y score() es const.
    // O sea: apenas una red recibe su primer supervisado, su `ema` deja de
    // reflejar el mercado y pasa a ser el promedio de las últimas salidas
    // sobre ejemplos de ENTRENAMIENTO replayados de hace 48 h — y `seen` se
    // congela respecto del tráfico real.
    //
    // Ese `ema` es el que se publica y el que se lee en el chequeo semanal
    // como si fuera "qué opina la red del mercado ahora". No lo era.
    double ema_infer  = 0.0;
    long long seen_infer = 0;

    // Necesario para poder guardarlas en un unordered_map (igual que class23).
    MLP24() = default;

    MLP24(int in, const std::string& src, unsigned seed)
        : inDim(in), fuente(src)
    {
        std::mt19937 rng(seed);
        double s1 = std::sqrt(2.0 / std::max(in, 1));
        double s2 = std::sqrt(2.0 / H);
        std::normal_distribution<double> d1(0, s1), d2(0, s2);
        W1.assign(in, std::vector<double>(H));
        b1.assign(H, 0.0); W2.assign(H, 0.0); b2 = 0;
        for (int i = 0; i < in; i++)
            for (int j = 0; j < H; j++) W1[i][j] = d1(rng);
        for (int j = 0; j < H; j++) W2[j] = d2(rng);
        spdlog::info("[{}] 🧠 Nueva red '{}': {}→{}→1 (sigmoid, lr={})",
                     TAG, src, inDim, H, lr);
    }

    bool listo() const { return inDim > 0 && !W1.empty(); }

    // Guarda contra el bug histórico: si por cualquier razón llega un vector
    // de otra dimensión, se RECHAZA. Antes esto disparaba init() y borraba
    // todos los pesos. Ahora es un no-op ruidoso.
    bool dimOk(const std::vector<double>& x) const {
        if ((int)x.size() == inDim) return true;
        spdlog::warn("[{}] ⚠️ red '{}' esperaba dim={} y llegó dim={} — descartado "
                     "(NO se re-inicializa: eso borraría el aprendizaje)",
                     TAG, fuente, inDim, (int)x.size());
        return false;
    }

    std::pair<std::vector<double>, double> forward(const std::vector<double>& x) const {
        std::vector<double> h(H, 0.0);
        for (int j = 0; j < H; j++) {
            double z = b1[j];
            for (int i = 0; i < inDim; i++) z += W1[i][j] * x[i];
            h[j] = relu(z);
        }
        double z2 = b2;
        for (int j = 0; j < H; j++) z2 += W2[j] * h[j];
        return { h, sigmoid(z2) };
    }

    // Modo EMA — ENTRENAMIENTO DESACTIVADO (3-sep-2026).
    //
    // Entrenaba hacia su propia EMA cuando no había outcome supervisado. Es un
    // objetivo auto-referencial sin ancla externa, y tiene un punto fijo en
    // y == ema: ahí el error es cero, los pesos dejan de moverse, y como
    // ema = ema*0.9 + y*0.1 con y == ema, la EMA tampoco se mueve. La salida
    // se contrae a una constante y se queda ahí.
    //
    // MEDIDO en producción antes de este cambio: la red 'mercado' subió de
    // forma monótona 0.8521 → 0.9527 en ~25 escalones y después quedó clavada
    // en 0.9511 durante 360 heartbeats consecutivos, habiendo procesado ~5.000
    // vectores nuevos en ese lapso. Con class24 pesando 0.409 en el ensamble,
    // casi la mitad del criterio de class25A era ese número fijo.
    //
    // Dominaba aun siendo MINORÍA de los pasos (seen 38.876 / sup 30.195, o
    // sea 22% auto-referencial) porque empuja siempre hacia el mismo lado,
    // mientras los pasos supervisados —49.2% correcto / 50.8% incorrecto— se
    // cancelan entre sí. Presión direccionada contra paseo aleatorio.
    //
    // Ahora la EMA se sigue registrando para observabilidad, pero los pesos NO
    // se tocan sin un outcome real de mercado. Una red sin feedback se queda
    // en su inicialización (~0.5, no informativa pero honesta) en vez de
    // derivar hacia una constante arbitraria y afirmarla con confianza alta.
    double modoEMA(const std::vector<double>& x) {
        if (!listo() || !dimOk(x)) return 0.5;
        const double y = forward(x).second;
        ema = (seen == 0) ? y : ema * 0.9 + y * 0.1;
        seen++;
        return 0.0;   // sin pérdida: no hubo entrenamiento
    }

    // Entrenamiento supervisado con outcome real de class43.
    double trainSupervised(const std::vector<double>& x, double outcome) {
        if (!listo() || !dimOk(x)) return 0.0;
        auto [h, y] = forward(x);
        supervised_count++;
        return trainWith(x, h, y, outcome);
    }

    double trainWith(const std::vector<double>& x,
                     const std::vector<double>& h,
                     double y, double target)
    {
        paso(x, h, y, target);
        ema = ema * 0.9 + y * 0.1;
        seen++;
        return 0.5 * (y - target) * (y - target);
    }

    // REPASO (5-oct-2026): un paso de gradiente sobre un ejemplo VIEJO del
    // depósito. NO toca `ema`, `seen` ni `supervised_count`: esos contadores
    // van a la planilla y miden el tráfico real; si el repaso los inflara, la
    // serie de seen/sup se duplicaría el día del corte sin que nada cambiara.
    void repasar(const std::vector<double>& x, double target) {
        if (!listo() || (int)x.size() != inDim) return;
        auto [h, y] = forward(x);
        paso(x, h, y, target);
    }

    void paso(const std::vector<double>& x,
              const std::vector<double>& h,
              double y, double target)
    {
        double err  = y - target;
        double dy   = y * (1 - y);
        double dz2  = err * dy;
        // dh se calcula con W2 ANTES de actualizarlo (si no, el gradiente de la
        // capa 1 usaría pesos ya movidos y el paso quedaría sesgado).
        std::vector<double> dh(H, 0.0);
        for (int j = 0; j < H; j++) dh[j] = dz2 * W2[j] * dRelu(h[j]);
        for (int j = 0; j < H; j++) W2[j] -= lr * dz2 * h[j];
        b2 -= lr * dz2;
        for (int j = 0; j < H; j++) {
            for (int i = 0; i < inDim; i++) W1[i][j] -= lr * dh[j] * x[i];
            b1[j] -= lr * dh[j];
        }
    }

    // Inferencia pura: NUNCA toca pesos. Recibe el vector YA NORMALIZADO.
    double score(const std::vector<double>& x) const {
        if (!listo() || (int)x.size() != inDim) return 0.5;
        const double y = forward(x).second;
        return std::max(0.0, std::min(1.0, y));
    }

    // ORDEN 3 — registro de la EMA de INFERENCIA. Va aparte de score() para
    // que score() siga siendo const y sin efectos: el ingest llama a las dos.
    void registrarInferencia(double y) {
        ema_infer = (seen_infer == 0) ? y : ema_infer * 0.9 + y * 0.1;
        seen_infer++;
    }
};

// ── Entrada del pending map ─────────────────────────────────
// `key` = red que produjo la predicción. Sin esto el feedback no sabría a
// cuál de las redes por fuente entrenar (en v2.2 había una sola).
struct PendingEntry {
    std::vector<double> emb;
    int64_t             ts_ms;   // epoch millis cuando se insertó
    std::string         key;
    // DEFECTO 10 (21-sep-2026): el INSTRUMENTO de esta predicción. Sin este
    // campo el emparejamiento era sólo por hora, así que el vector de XLK se
    // entrenaba con el resultado de XLE y la red no podía aprender a
    // distinguir instrumentos — que es justo la pregunta que se le hace.
    std::string         symbol;
};

// ── Estado ──────────────────────────────────────────────────
// Dos mutexes separados (mismo criterio que class23): el feedback recolecta
// su lote bajo pmtx y entrena bajo mtx, sin anidar locks ni bloquear el
// camino de ingest durante el backprop.
struct State24 {
    mutable std::mutex  mtx;    // protege `redes`
    std::unordered_map<std::string, MLP24> redes;

    mutable std::mutex  pmtx;   // protege `pending`
    std::unordered_map<std::string, PendingEntry> pending;

    std::atomic<uint64_t> total{0}, feedbacks{0}, purgados{0}, rechazados{0};
    // DEFECTO 10: por qué se descartó un feedback, para verlo en el heartbeat
    // en vez de que desaparezca en silencio.
    std::atomic<uint64_t> fb_sin_ticker{0}, fb_no_relativo{0}, fb_otro_ticker{0};
    std::atomic<uint64_t> lote_truncado{0};

    // REPASO (5-oct-2026). Vive bajo `mtx`, igual que las redes que repasa.
    DepositoRepaso repaso;
    bool           repaso_on = true;
};

// ── Helper: timestamp en milisegundos ───────────────────────
// DEFECTO 10: forma canónica del instrumento. Los dos lados —el ingest y el
// feedback— tienen que coincidir dígito por dígito o no matchea nada. Mismo
// criterio que `_esSenalDeMercado` de class43.js: vacío, "unknown" o algo que
// empiece con "class" es el agregado, y se llama GENERAL de los dos lados.
static std::string canonSymbol(std::string s) {
    if (s.empty() || s == "unknown" || s == "UNKNOWN") return "GENERAL";
    if (s.size() >= 5) {
        std::string p5 = s.substr(0, 5);
        for (auto& c : p5) c = (char)std::tolower((unsigned char)c);
        if (p5 == "class") return "GENERAL";
    }
    return s;
}

// DEFECTO 10 — el guard del feedback, en una función PURA a propósito: la
// simulación le pasa el payload REAL que publica class43 (capturado por
// sim8_contrato_feedback.js) y verifica que lo acepta. Si alguien renombra un
// campo en class43.js, el test se pone en rojo en vez de que el entrenamiento
// se apague en silencio tres semanas después.
enum class MotivoFB { Ok, SinTicker, NoRelativo };

struct GuardFB {
    bool        acepta = false;
    std::string sym;                       // ya canonicalizado
    std::string modo;                      // label_modo, tal cual viene
    MotivoFB    motivo = MotivoFB::Ok;
};

static GuardFB evaluarFeedback(const json& j) {
    GuardFB g;
    const std::string crudo = j.value("ticker", std::string(""));
    g.sym  = canonSymbol(crudo);
    g.modo = j.value("label_modo", std::string(""));
    // (1) Sin ticker no se puede emparejar por instrumento. Entrenar "a
    //     cualquiera" es exactamente lo que rompía el defecto 10.
    if (crudo.empty())      { g.motivo = MotivoFB::SinTicker;  return g; }
    // (2) Un ticker REAL con etiqueta `absoluto` es la dirección cruda del
    //     instrumento, NO "¿le ganó al promedio?", que es la pregunta que se le
    //     hace a la red. El agregado sí es `absoluto` por definición.
    if (g.sym != "GENERAL" && g.modo != "relativo")
                            { g.motivo = MotivoFB::NoRelativo; return g; }
    g.acepta = true;
    return g;
}


static int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

// ── Clave de red: fuente + dimensión ────────────────────────
// La dimensión va EN LA CLAVE a propósito. class23 recrea la red cuando la
// dimensión de una fuente cambia (destructivo); acá simplemente nace otra red
// y la vieja conserva lo aprendido.
static std::string claveRed(const std::string& fuente, int dim) {
    return fuente + "|" + std::to_string(dim);
}

// ── Obtener o crear la red de una clave ─────────────────────
// Llamar SIEMPRE con st.mtx tomado.
static MLP24& getOrCreate(State24& st, const std::string& fuente, int in_dim) {
    const std::string key = claveRed(fuente, in_dim);
    auto it = st.redes.find(key);
    if (it != st.redes.end()) return it->second;
    // Semilla derivada de la clave: cada fuente arranca en un punto distinto
    // del espacio de pesos → diversidad real en el ensemble de class25A.
    unsigned seed = (unsigned)(std::hash<std::string>{}(key) % 10000u) + 24u;
    st.redes.emplace(key, MLP24(in_dim, key, seed));
    return st.redes.at(key);
}

// ── Limpiar entradas vencidas del pending map ────────────────
static int purgarPending(State24& st) {
    std::lock_guard<std::mutex> lk(st.pmtx);
    int64_t ahora    = now_ms();
    int     purgados = 0;
    for (auto it = st.pending.begin(); it != st.pending.end(); ) {
        if (ahora - it->second.ts_ms > PENDING_TTL_MS) {
            it = st.pending.erase(it);
            purgados++;
        } else {
            ++it;
        }
    }
    if (purgados > 0) st.purgados += purgados;
    return purgados;
}

// ── DEFECTO 10: recolección del lote por (instrumento, hora) ─────
//
// Vive en una función con nombre, y no adentro del lambda del feedback, para
// que la simulación la pueda ejercitar sin Redis ni el sistema corriendo
// (docs/simulaciones/sim7_defecto10.cpp). La lógica es la de producción: el
// test no la reimplementa, la ejecuta.
struct LoteFB {
    std::vector<std::pair<std::string, std::vector<double>>> lote;
    int64_t mejor_delta    = INT64_MAX;  // lag del más cercano DEL MISMO ticker
    size_t  pend_restantes = 0;
    int     otro_ticker    = 0;          // en ventana, de otro instrumento: intactos
    int     truncados      = 0;          // eran suyos y no entraron por el tope
};

static LoteFB recolectarLote(State24& st, const std::string& fb_sym,
                             int64_t dts, int64_t desde, int64_t hasta) {
    LoteFB r;
    std::lock_guard<std::mutex> lk(st.pmtx);
    // Se recorre el mapa entero, sin cortar al llenar el lote: hace falta para
    // contar los truncados y los de otro instrumento. Con el emparejamiento por
    // ticker el lote casi nunca se llena, así que el corte temprano ya no
    // servía de nada. 120.000 comparaciones a ~2.400 feedbacks por día es
    // trabajo despreciable.
    for (auto it = st.pending.begin(); it != st.pending.end(); ) {
        const bool    mismo_sym = (it->second.symbol == fb_sym);
        const int64_t delta     = dts - it->second.ts_ms;
        // El lag se mide contra el MISMO instrumento: si no, informaba el de
        // cualquier vector y no decía nada.
        if (mismo_sym && std::llabs(delta) < std::llabs(r.mejor_delta))
            r.mejor_delta = delta;
        const bool en_ventana = it->second.ts_ms >= desde && it->second.ts_ms <= hasta;
        // DEFECTO 10: (ticker, hora), no sólo hora. Y los de OTRO instrumento
        // NO se borran — esperan el feedback de SU instrumento. Antes se los
        // llevaba puestos el primero que llegara: hasta 50 vectores ajenos por
        // mensaje, entrenados con una etiqueta que no era la suya.
        if (en_ventana && mismo_sym) {
            if ((int)r.lote.size() < MAX_LOTE_FB) {
                r.lote.emplace_back(it->second.key, std::move(it->second.emb));
                it = st.pending.erase(it);
                continue;
            }
            // Era suyo y no entró. NO se borra: así al menos muere por TTL en
            // vez de entrenarse con la etiqueta de otro. Pero es pérdida, y por
            // eso se cuenta y se ve en el heartbeat.
            r.truncados++;
        } else if (en_ventana) {
            r.otro_ticker++;
        }
        ++it;
    }
    r.pend_restantes = st.pending.size();
    return r;
}

// ── FASE 2 del feedback: entrenar el lote (y repasar) ─────────
//
// En una función con nombre por el mismo motivo que recolectarLote: la
// simulación (sim29_repaso.cpp) la ejecuta tal cual, sin Redis.
//
// El repaso sólo se alimenta con etiquetas RELATIVAS de un instrumento real.
// Las del agregado (GENERAL) son la dirección cruda del mercado, la etiqueta
// que el defecto 10 había metido de contrabando: no se guardan para repasar.
// Y sólo se REPASA en ese mismo caso: una red que entrena con una etiqueta
// GENERAL (absoluta) no recibe además ejemplos relativos — sería volver a
// mezclar las dos preguntas, que es lo que arregló el defecto 10.
struct EntrenoFB { int entrenados = 0, huerfanos = 0, repasados = 0; };

static EntrenoFB entrenarLote(State24& st,
                              std::vector<std::pair<std::string, std::vector<double>>>& lote,
                              const std::string& sym, const std::string& modo,
                              int64_t dts, double outcome) {
    EntrenoFB r;
    const bool    alimentar = st.repaso_on && sym != "GENERAL" && modo == "relativo";
    const int64_t dia       = DepositoRepaso::diaDe(dts);
    std::lock_guard<std::mutex> lk(st.mtx);
    for (auto& [key, x] : lote) {
        auto it = st.redes.find(key);
        if (it == st.redes.end()) { r.huerfanos++; continue; }
        // Un ejemplo por (red, instrumento, día): el depósito descarta solo los
        // repetidos, así que se le ofrece cada uno y él decide.
        if (alimentar) st.repaso.agregar(key, sym, dia, x, outcome);
        it->second.trainSupervised(x, outcome);
        r.entrenados++;
        if (alimentar && st.repaso.toca()) {
            if (const auto* e = st.repaso.sortear(key, dia)) {
                it->second.repasar(e->x, e->y);
                r.repasados++;
            }
        }
    }
    return r;
}

// ── Thread de feedback: outcomes reales de class43 ──────────
static void feedback_loop(State24& st) {
    while (g_running.load()) {
        try {
            sw::redis::ConnectionOptions o;
            o.host = "127.0.0.1"; o.port = 6379;
            o.connect_timeout = std::chrono::milliseconds(3000);
            o.socket_timeout  = std::chrono::seconds(0);
            Redis fbR(o); auto sub = fbR.subscriber();

            sub.on_message([&](std::string /*ch*/, std::string raw) {
                try {
                    auto j = json::parse(raw);
                    double  outcome = j.value("outcome", -1.0);
                    int64_t dts     = j.value("decision_ts", (int64_t)0);
                    if (outcome < 0.0 || outcome > 1.0 || dts <= 0) return;

                    // ── DEFECTO 10 (21-sep-2026) ──────────────────────
                    // class43 YA manda el `ticker` y el `label_modo` en los dos
                    // caminos (memoria y reconciliación). class24 no los usaba.
                    //
                    // (1) Sin ticker no se puede emparejar: se descarta y se
                    //     cuenta. Entrenar "a cualquiera" es lo que rompía esto.
                    // (2) Un ticker REAL con etiqueta `absoluto` es la dirección
                    //     cruda del instrumento, NO "¿le ganó al promedio?", que
                    //     es la pregunta que se le hace a la red. No entrena.
                    //     El agregado (GENERAL) sí es `absoluto` por definición
                    //     —no tiene relativo posible— y entrena a los vectores
                    //     GENERAL, que son los suyos.
                    const GuardFB g = evaluarFeedback(j);
                    const std::string& fb_sym  = g.sym;
                    const std::string& fb_modo = g.modo;
                    if (!g.acepta) {
                        if (g.motivo == MotivoFB::SinTicker) {
                            if (++st.fb_sin_ticker == 1)
                                spdlog::warn("[{}] ⚠️ Feedback SIN ticker — no se puede emparejar "
                                             "por instrumento. ¿class43 viejo?", TAG);
                        } else {
                            if (++st.fb_no_relativo % 500 == 1)
                                spdlog::warn("[{}] ⚠️ {} con label_modo='{}' (no relativo) — "
                                             "no entrena [{} acumulados]",
                                             TAG, fb_sym, fb_modo, st.fb_no_relativo.load());
                        }
                        return;
                    }

                    // Matcheo por TIEMPO: los vectores que alimentaron la
                    // decisión se procesaron en los ~segundos/minutos previos a
                    // que se persistiera. No hay id 1:1 porque una decisión
                    // agrega muchas predicciones.
                    // Ventana de 15 min: class24 predice EN RÁFAGAS con huecos
                    // de varios minutos, mientras class25B escribe decisiones
                    // cada ~22 s. Medido en producción (2026-07-31): última
                    // predicción 14:59:40 vs decisión 15:03:53 → 253 s de
                    // separación, fuera de la ventana anterior de 180 s.
                    const int64_t desde = dts - 900000;  // 15 min antes
                    const int64_t hasta = dts + 120000;  // 2 min de holgura

                    // FASE 1 — recolectar el lote bajo pmtx (sin entrenar).
                    LoteFB fb = recolectarLote(st, fb_sym, dts, desde, hasta);
                    auto&         lote           = fb.lote;
                    const int64_t mejor_delta    = fb.mejor_delta;
                    const size_t  pend_restantes = fb.pend_restantes;
                    const int     otro_ticker    = fb.otro_ticker;

                    if (lote.empty()) {
                        if (mejor_delta != INT64_MAX)
                            spdlog::warn("[{}] ⚠️ Feedback {} sin match — lag más cercano: {}s "
                                         "(ventana: -900s..+120s, pending={}, "
                                         "{} en ventana de otro instrumento)",
                                         TAG, fb_sym, mejor_delta / 1000,
                                         (int)pend_restantes, otro_ticker);
                        return;
                    }

                    // FASE 2 — entrenar bajo mtx, cada ejemplo en SU red, y repasar.
                    const EntrenoFB en = entrenarLote(st, lote, fb_sym, fb_modo, dts, outcome);
                    const int entrenados = en.entrenados, huerfanos = en.huerfanos;

                    if (entrenados > 0) {
                        st.feedbacks += entrenados;
                        // Se arma a mano en vez de con fmt::format: según cómo esté
                        // compilado spdlog en el server (bundled vs SPDLOG_FMT_EXTERNAL)
                        // el símbolo `fmt::` puede no estar disponible sin incluir
                        // <fmt/core.h>. Un std::string no depende de eso.
                        std::string extra;
                        if (huerfanos > 0)
                            extra = " [" + std::to_string(huerfanos) + " huérfanas: red ya no existe]";
                        st.fb_otro_ticker += otro_ticker;
                        st.lote_truncado  += fb.truncados;
                        if (fb.truncados > 0)
                            spdlog::warn("[{}] ⚠️ {} truncó {} vectores propios por "
                                         "MAX_LOTE_FB={} — se pierden por TTL",
                                         TAG, fb_sym, fb.truncados, MAX_LOTE_FB);
                        spdlog::info("[{}] 🎯 Entrenadas {} predicciones de {} [{}] "
                                     "(dir={:.0f}) feedbacks={} lag={}s "
                                     "(+{} en ventana de otro instrumento, intactos){}",
                                     TAG, entrenados, fb_sym, fb_modo, outcome,
                                     st.feedbacks.load(), mejor_delta / 1000,
                                     otro_ticker, extra);
                    }
                } catch (...) {}
            });

            sub.subscribe(CH_FEEDBACK);
            spdlog::info("[{}] 📡 Suscrito a {}", TAG, CH_FEEDBACK);
            while (g_running.load()) sub.consume();

        } catch (const std::exception& e) {
            if (g_running.load()) {
                spdlog::warn("[{}] Feedback: {} — 3s", TAG, e.what());
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        }
    }
}

// ── Thread de limpieza de pending vencidos ───────────────────
static void cleanup_loop(State24& st) {
    while (g_running.load()) {
        std::this_thread::sleep_for(std::chrono::seconds(CLEANUP_SEC));
        if (!g_running.load()) break;
        int n = purgarPending(st);
        size_t remaining;
        { std::lock_guard<std::mutex> lk(st.pmtx); remaining = st.pending.size(); }
        if (n > 0)
            spdlog::info("[{}] 🗑️  Purgados {} pending vencidos (TTL={}h). Restantes: {}",
                         TAG, n, PENDING_TTL_MS / 3600000, remaining);
    }
}

// ════════════════════════════════════════════════════════════
// PERSISTENCIA DE PESOS
// ════════════════════════════════════════════════════════════
// Hasta v3.0 los pesos vivían SOLO en RAM. Cualquier crash, deploy, reboot o
// `kill -9` borraba meses de entrenamiento sin dejar rastro — y como el
// heartbeat sigue mostrando redes con seen/sup creciendo desde cero, la pérdida
// era indistinguible de un arranque normal.
//
// Medido en producción: dos incidentes en cuatro días, seis días de
// entrenamiento perdidos. class25A ya persistía (bayes/neutro/pesos); class23 y
// class24 eran los únicos dos módulos que nunca escribían a disco.
//
// Se guarda periódicamente y NO en el apagado. Motivo empírico: en el incidente
// del 11-ago `pm2 stop` no mató a los hijos y hubo que usar `kill -9`, que no
// dispara ningún handler. Un "guardar al salir" no se habría ejecutado nunca.
// El guardado periódico es el mecanismo principal; el del cierre, un extra.
//
// NO se persiste `pending`: son hasta 120.000 vectores de entrada (cientos de
// MB) y se reponen solos dentro del TTL de 80 h. Los pesos son el activo
// acumulado; los pendientes, reemplazables.
// v2 (ORDEN 3): la entrada pasó de cruda a RunningNorm (por feature). Los
// pesos v1 se entrenaron sobre otra distribución de entrada; cargarlos daría
// una red que puntúa números plausibles sin significado. Se descartan.
static constexpr int PESOS_VERSION = 2;
static fs::path g_pesos_file;
static fs::path g_repaso_file;     // state/class24_repaso.json (5-oct-2026)
static int      g_save_min = 60;   // CLASS24_SAVE_MIN

static void guardarPesos(const State24& st) {
    if (g_pesos_file.empty()) return;
    try {
        json redes = json::object();
        size_t nRedes = 0;
        {
            std::lock_guard<std::mutex> lk(st.mtx);
            for (const auto& [k, r] : st.redes) {
                if (!r.listo()) continue;
                redes[k] = {
                    {"inDim", r.inDim}, {"H", r.H}, {"fuente", r.fuente},
                    {"lr", r.lr}, {"b2", r.b2}, {"ema", r.ema},
                    {"seen", r.seen}, {"supervised_count", r.supervised_count},
                    {"b1", r.b1}, {"W2", r.W2}, {"W1", r.W1},
                    // ORDEN 3. El normalizador es parte del contrato de entrada:
                    // sin él, los pesos recargados verían otra escala.
                    {"norm", r.norm.toJson()},
                    {"ema_infer", r.ema_infer}, {"seen_infer", r.seen_infer}
                };
                nRedes++;
            }
        }
        json j = {
            {"__meta__", {{"version", PESOS_VERSION}, {"modulo", TAG},
                          {"H_UNITS", H_UNITS}, {"ts", now_ms()}, {"redes", nRedes}}},
            {"redes", redes}
        };
        // Escritura ATÓMICA: si el proceso muere a mitad del dump, el archivo
        // bueno sigue intacto. Sin esto, un kill en el peor momento destruye
        // exactamente lo que este código existe para proteger.
        fs::path tmp = g_pesos_file; tmp += ".tmp";
        { std::ofstream out(tmp); if (!out) return; out << j.dump(); }
        fs::rename(tmp, g_pesos_file);
        spdlog::info("[{}] 💾 pesos guardados: {} redes → {}", TAG, nRedes,
                     g_pesos_file.filename().string());
    } catch (const std::exception& e) {
        spdlog::warn("[{}] no se pudieron guardar los pesos: {}", TAG, e.what());
    }
}

static bool cargarPesos(State24& st) {
    if (g_pesos_file.empty() || !fs::exists(g_pesos_file)) {
        spdlog::info("[{}] sin pesos previos — las redes arrancan desde cero", TAG);
        return false;
    }
    try {
        std::ifstream in(g_pesos_file);
        json j; in >> j;

        const int ver = j.value("__meta__", json::object()).value("version", 0);
        if (ver != PESOS_VERSION) {
            spdlog::warn("[{}] ⚠️ pesos v{} != v{} — se descartan (formato viejo)",
                         TAG, ver, PESOS_VERSION);
            return false;
        }
        const int hGuardado = j.value("__meta__", json::object()).value("H_UNITS", -1);
        if (hGuardado != H_UNITS) {
            spdlog::warn("[{}] ⚠️ pesos con H={} pero el binario usa H={} — se descartan",
                         TAG, hGuardado, H_UNITS);
            return false;
        }

        // Referencia al objeto VIVO dentro de `j`. Con
        // `j.value("redes", json::object()).items()` se itera sobre un temporal
        // que muere al final de la expresión → referencia colgante.
        if (!j.contains("redes") || !j["redes"].is_object()) {
            spdlog::warn("[{}] ⚠️ archivo de pesos sin sección 'redes' — se descarta", TAG);
            return false;
        }
        const json& redesJ = j["redes"];

        int cargadas = 0, rechazadas = 0;
        std::lock_guard<std::mutex> lk(st.mtx);
        for (auto& [k, r] : redesJ.items()) {
            MLP24 m;
            m.inDim            = r.value("inDim", 0);
            m.H                = r.value("H", H_UNITS);
            m.fuente           = r.value("fuente", std::string(""));
            m.lr               = g_lr;   // manda el binario/entorno, no el archivo
            m.b2               = r.value("b2", 0.0);
            m.ema              = r.value("ema", 0.0);
            m.seen             = r.value("seen", 0);
            m.supervised_count = r.value("supervised_count", 0);
            m.b1               = r.value("b1", std::vector<double>{});
            m.W2               = r.value("W2", std::vector<double>{});
            m.W1               = r.value("W1", std::vector<std::vector<double>>{});
            m.ema_infer        = r.value("ema_infer", 0.0);
            m.seen_infer       = r.value("seen_infer", (long long)0);

            // Validación de forma. Es la salvaguarda que faltaba en v2: cargar
            // una matriz de dimensión equivocada y dejar que el forward la use
            // sería peor que arrancar de cero, porque produce números plausibles.
            const bool formaOk =
                m.inDim > 0 && m.H == H_UNITS &&
                (int)m.W1.size() == m.inDim &&
                (m.W1.empty() || (int)m.W1[0].size() == m.H) &&
                (int)m.b1.size() == m.H &&
                (int)m.W2.size() == m.H;
            if (!formaOk) {
                spdlog::warn("[{}] ⚠️ red '{}' con forma inconsistente "
                             "(inDim={} W1={}x{} b1={} W2={}) — descartada",
                             TAG, k, m.inDim, m.W1.size(),
                             m.W1.empty() ? 0 : m.W1[0].size(), m.b1.size(), m.W2.size());
                rechazadas++;
                continue;
            }
            // ORDEN 3: mismo criterio que la validación de forma. Unos pesos sin
            // su normalizador se entrenaron sobre otra escala de entrada —
            // usarlos produce números plausibles sin significado, que es
            // exactamente el modo de falla contra el que existe este proyecto.
            if (!r.contains("norm") || !m.norm.fromJson(r["norm"], (size_t)m.inDim)) {
                spdlog::warn("[{}] ⚠️ red '{}' sin normalizador válido — descartada "
                             "(los pesos se entrenaron sobre otra escala)", TAG, k);
                rechazadas++;
                continue;
            }
            st.redes[k] = std::move(m);
            cargadas++;
        }
        spdlog::info("[{}] 💾 pesos restaurados: {} redes cargadas, {} descartadas",
                     TAG, cargadas, rechazadas);
        for (const auto& [k, r] : st.redes)
            spdlog::info("[{}]   ↻ red='{}' dim={} seen={} sup={} ema_inf={:.4f} "
                         "ema_train={:.4f} norm_n={}",
                         TAG, k, r.inDim, r.seen, r.supervised_count,
                         r.ema_infer, r.ema, r.norm.n);
        return cargadas > 0;
    } catch (const std::exception& e) {
        spdlog::warn("[{}] pesos ilegibles ({}) — se arranca desde cero", TAG, e.what());
        return false;
    }
}

// La simulación incluye este .cpp con -DMIIA_SIN_MAIN para ejercitar la lógica
// real sin arrancar el proceso. En produccion la macro no existe.
#ifndef MIIA_SIN_MAIN
int main() {
    std::signal(SIGINT,  miia_signal);
    std::signal(SIGTERM, miia_signal);

    fs::path base = fs::current_path() / ".." / "operador" / "aprendizaje";
    try { fs::create_directories(base / "logs");
          fs::create_directories(base / "central");
          fs::create_directories(base / "state"); } catch (...) {}
    init_logger(TAG, (base / "logs" / "class24.log").string());

    // Mismo directorio que usa class25A para su estado persistido.
    g_pesos_file  = base / "state" / "class24_pesos.json";
    g_repaso_file = base / "state" / "class24_repaso.json";
    if (const char* e = std::getenv("CLASS24_SAVE_MIN")) {
        try {
            int v = std::stoi(e);
            if (v >= 1 && v <= 1440) g_save_min = v;
            else spdlog::warn("[{}] CLASS24_SAVE_MIN={} fuera de [1,1440] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }

    if (const char* e = std::getenv("CLASS24_LR")) {
        try {
            const double v = std::stod(e);
            if (v > 0.0 && v <= 0.1) g_lr = v;
            else spdlog::warn("[{}] CLASS24_LR={} fuera de (0, 0.1] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }

    spdlog::info("[{}] ══ MLP Online v3.0 | una red por (fuente,dim) | H={} lr={} ══",
                 TAG, H_UNITS, g_lr);
    if (g_lr != LR)
        spdlog::warn("[{}] ⚠️ tasa de aprendizaje {} por CLASS24_LR (la del binario es {})",
                     TAG, g_lr, LR);
    if (RunningNorm::legado())
        spdlog::warn("[{}] ⚠️ normalizador en modo LEGADO (ventana ~1000): la red no ve "
                     "el nivel del régimen", TAG);
    else
        spdlog::info("[{}] 📐 normalizador con ventana lenta: {:.0f} muestras",
                     TAG, RunningNorm::ventana());
    spdlog::info("[{}] {} + {} → {}", TAG, CH_IN, CH_FEEDBACK, CH_OUT);
    spdlog::info("[{}] Pending: cap={} TTL={}h limpieza={}min",
                 TAG, PENDING_MAX, PENDING_TTL_MS / 3600000, CLEANUP_SEC / 60);

    auto pub = connect_redis(TAG);
    if (!pub) { spdlog::error("[{}] Sin Redis.", TAG); return 1; }
    publish_ready(*pub, TAG, CH_IN);

    State24 st;

    // Restaurar lo aprendido ANTES de levantar los threads: si el feedback
    // entrara primero, getOrCreate() crearía redes vacías con las mismas claves
    // y la carga posterior las pisaría (o peor, entrenaría contra una y
    // publicaría la otra).
    cargarPesos(st);

    // REPASO: después de los pesos, porque un ejemplo sólo se carga si su red
    // existe y tiene la misma dimensión.
    configurar_repaso("CLASS24", TAG, st.repaso, st.repaso_on);
    if (st.repaso_on) {
        std::unordered_map<std::string, int> dims;
        { std::lock_guard<std::mutex> lk(st.mtx);
          for (const auto& [k, r] : st.redes) dims[k] = r.inDim; }
        std::lock_guard<std::mutex> lk(st.mtx);
        cargar_repaso(g_repaso_file, st.repaso, dims, TAG);
    }

    // Guardado periódico. Duerme de a 1 s para que el apagado sea inmediato en
    // vez de esperar hasta una hora.
    std::thread saveThread([&]() {
        while (g_running.load()) {
            for (int i = 0; i < g_save_min * 60 && g_running.load(); i++)
                std::this_thread::sleep_for(std::chrono::seconds(1));
            if (!g_running.load()) break;
            guardarPesos(st);
            if (st.repaso_on) guardar_repaso(g_repaso_file, st.repaso, st.mtx, TAG);
        }
        // Intento final: sirve si el cierre fue ordenado (SIGTERM). Con kill -9
        // no corre, y por eso el periódico es el que manda.
        guardarPesos(st);
        if (st.repaso_on) guardar_repaso(g_repaso_file, st.repaso, st.mtx, TAG);
    });
    saveThread.detach();
    spdlog::info("[{}] 💾 persistencia activa: cada {} min → {}",
                 TAG, g_save_min, g_pesos_file.string());

    // Thread de feedback (outcomes reales)
    std::thread fbThread(feedback_loop, std::ref(st));
    fbThread.detach();

    // Thread de limpieza de pending vencidos
    std::thread cleanThread(cleanup_loop, std::ref(st));
    cleanThread.detach();

    // Heartbeat — ahora por red. Si alguna vuelve a mostrar seen=0 sostenido,
    // o el número de redes crece sin techo, hay un contrato roto aguas arriba.
    std::thread hb([&]() {
        while (g_running.load()) {
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if (!g_running.load()) break;
            size_t pend;
            { std::lock_guard<std::mutex> lk(st.pmtx); pend = st.pending.size(); }
            double cobertura = st.total.load() > 0
                ? (double)st.feedbacks.load() / st.total.load() * 100.0
                : 0.0;
            std::lock_guard<std::mutex> lk(st.mtx);
            spdlog::info("[{}] ❤️  total={} redes={} feedbacks={} pending={} "
                         "purgados={} rechazados={} cobertura={:.1f}%",
                         TAG, st.total.load(), st.redes.size(), st.feedbacks.load(),
                         pend, st.purgados.load(), st.rechazados.load(), cobertura);
            // DEFECTO 10 — los tres motivos por los que un feedback no entrena.
            // `otro_ticker` NO es una pérdida: son vectores que quedaron intactos
            // esperando el feedback de SU instrumento. Antes se los llevaba puestos
            // el primer mensaje que cayera en la ventana. `no_relativo` sí es
            // pérdida, y mide cuántas veces class43 no pudo calcular el relativo.
            spdlog::info("[{}]   defecto10: sin_ticker={} no_relativo={} "
                         "otro_ticker_preservados={} lote_truncado={}",
                         TAG, st.fb_sin_ticker.load(), st.fb_no_relativo.load(),
                         st.fb_otro_ticker.load(), st.lote_truncado.load());
            // REPASO — prefijo fijo para que el chequeo diario lo lea.
            spdlog::info("[{}]   {}", TAG, linea_repaso(st.repaso, st.repaso_on));
            for (auto& [k, r] : st.redes)
                // ORDEN 3 — las DOS emas, rotuladas. `ema_inf` es lo que la red
                // opina del mercado que entra; `ema_tr` es el promedio sobre los
                // ejemplos de entrenamiento (de hace ~48 h). Antes se publicaba
                // solo la segunda, con el nombre de la primera.
                spdlog::info("[{}]   red='{}' dim={} seen={} sup={} inf={} "
                             "ema_inf={:.4f} ema_tr={:.4f} norm_n={}",
                             TAG, k, r.inDim, r.seen, r.supervised_count,
                             r.seen_infer, r.ema_infer, r.ema, r.norm.n);
        }
    });
    hb.detach();

    // Loop principal
    while (g_running.load()) {
        try {
            sw::redis::ConnectionOptions o;
            o.host = "127.0.0.1"; o.port = 6379;
            o.connect_timeout = std::chrono::milliseconds(3000);
            o.socket_timeout  = std::chrono::seconds(0);
            Redis subR(o); auto sub = subR.subscriber();

            sub.on_message([&](std::string /*ch*/, std::string raw) {
                try {
                    auto j = json::parse(raw);
                    if (j.value("source", "") == TAG) return;

                    if (j.contains("type") && j["type"].is_string() &&
                        j["type"].get<std::string>() != "vector") return;

                    const json  emptyObj = json::object();
                    const json& d = (j.contains("data") && j["data"].is_object())
                                    ? j["data"] : emptyObj;

                    std::vector<double> emb;
                    if (j.contains("vector") && j["vector"].is_array()) {
                        emb = sanitize(j["vector"]);
                    } else if (!d.empty()) {
                        if (d.contains("embedding"))   emb = sanitize(d["embedding"]);
                        else if (d.contains("vector")) emb = sanitize(d["vector"]);
                    }
                    if (emb.empty()) return;

                    // Fuente del vector — MISMO criterio que class23. Es lo que
                    // decide a qué red va. Antes class24 ni lo miraba: por eso
                    // todo caía en una sola red que se pisaba a sí misma.
                    const std::string fuente = j.value("fuente",
                                               j.value("origen",
                                               j.value("source", std::string("desconocido"))));
                    const int in_dim = (int)emb.size();
                    const std::string key = claveRed(fuente, in_dim);

                    // ── ORDEN 1: el ticker real, no el nombre del filtro ──────
                    // El fallback viejo era `j["source"]`, que vale "class19"
                    // SIEMPRE (es quien publica). Por eso el 100% de las
                    // decisiones quedaba rotulado "class19" y class43 las
                    // verificaba contra el promedio del mercado en vez de
                    // contra el precio del instrumento.
                    // Ahora class10 manda `symbol` y class19 lo propaga; si
                    // igual falta, se marca GENERAL — que es honesto — en vez
                    // de inventar un ticker que no existe.
                    std::string symbol = j.value("symbol",
                                         j.value("ticker",
                                         d.value("symbol",
                                         d.value("ticker", std::string("")))));
                    symbol = canonSymbol(symbol);  // DEFECTO 10: misma forma que el feedback
                    std::string id     = j.value("id", make_id(TAG));
                    int64_t     ts_now = now_ms();

                    double s, ema_val, ema_train; bool supervised; size_t n_redes;
                    {
                        std::lock_guard<std::mutex> lk(st.mtx);
                        auto& red = getOrCreate(st, fuente, in_dim);
                        // ORDEN 3: normalizar UNA vez. El vector normalizado es
                        // el que se puntúa y el que se guarda en pending, para
                        // que el entrenamiento de dentro de 48 h vea exactamente
                        // esto y no lo que diga el normalizador de ese momento.
                        red.norm.observar(emb);
                        emb = red.norm.aplicar(emb);
                        // Fallback EMA mientras esta red puntual no vio outcomes.
                        // Es POR RED: que 'mercado' ya tenga feedback no debe
                        // sacar a 'documento' de su modo de arranque.
                        if (red.supervised_count == 0) red.modoEMA(emb);
                        s          = red.score(emb);
                        red.registrarInferencia(s);   // ORDEN 3: EMA de inferencia
                        ema_val    = red.ema_infer;   // ← la de INFERENCIA, no la de train
                        ema_train  = red.ema;
                        supervised = (red.supervised_count > 0);
                        n_redes    = st.redes.size();
                    }

                    // Guardar para el feedback futuro, con la clave de SU red.
                    bool guardado = false;
                    {
                        std::lock_guard<std::mutex> lk(st.pmtx);
                        if ((int)st.pending.size() < PENDING_MAX) {
                            st.pending[id] = PendingEntry{ std::move(emb), ts_now, key, symbol };
                            guardado = true;
                        }
                    }
                    if (!guardado) {
                        st.rechazados++;
                        spdlog::warn("[{}] ⚠️ Pending lleno ({}) — vector {} no guardado",
                                     TAG, PENDING_MAX, id.substr(0, 8));
                    }

                    st.total++;

                    json result = {
                        {"id",     id},
                        {"source", TAG},
                        {"type",   "analysis"},
                        {"text",   "Neural score " + std::to_string(s).substr(0, 6)},
                        // NIVEL SUPERIOR además de data: class25A busca
                        // confianza/score arriba primero. Publicarlo en los dos
                        // lados evita que un cambio de contrato lo devuelva al
                        // default silencioso de 0.5.
                        {"confianza", s},
                        {"score",     s},
                        {"fuente",    fuente},
                        // Ticker en el NIVEL SUPERIOR: class25A agrupa su
                        // ventana de 5 s por instrumento y lo lee de acá.
                        {"symbol",    symbol},
                        {"ticker",    symbol},
                        {"data", {
                            {"parentId",            j.value("id", "")},
                            {"symbol",              symbol},
                            {"score",               s},
                            // ORDEN 3: `ema` pasa a ser la de INFERENCIA — lo que
                            // la red opina del mercado que está entrando. La de
                            // entrenamiento se publica aparte, rotulada, para no
                            // volver a leer una por la otra.
                            {"ema",                 ema_val},
                            {"ema_train",           ema_train},
                            {"hiddenUnits",         H_UNITS},
                            {"red",                 key},
                            {"in_dim",              in_dim},
                            {"supervised",          supervised},
                            {"feedbacks_recibidos", (int)st.feedbacks.load()},
                            {"redes_total",         (int)n_redes},
                            {"pending_ttl_h",       (int)(PENDING_TTL_MS / 3600000)}
                        }},
                        {"ts", now_iso()}
                    };
                    pub->publish(CH_OUT, result.dump());
                    spdlog::info("[{}] 📤 red='{}' {} score={:.4f} supervised={}",
                                 TAG, key, symbol, s, supervised ? "SI" : "no");

                } catch (const json::exception& e) {
                    spdlog::warn("[{}] JSON: {}", TAG, e.what());
                } catch (...) {}
            });

            sub.subscribe(CH_IN);
            spdlog::info("[{}] 📡 Suscrito a {}", TAG, CH_IN);
            while (g_running.load()) sub.consume();

        } catch (const std::exception& e) {
            if (g_running.load()) {
                spdlog::warn("[{}] {}", TAG, e.what());
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        }
    }
    return 0;
}
#endif  // MIIA_SIN_MAIN
