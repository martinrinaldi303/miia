// class23.cpp — Filtro Neural Adaptativo v2.3
// ============================================================
// ORDEN 3 (v2.3) — TRES CORRECCIONES
//
//   1. NORMALIZACIÓN. Usaba normalize_zscore(), que centra cada vector
//      contra su propia media ENTRE DIMENSIONES. Eso borra el nivel (si los
//      13 sectores suben lo mismo, el vector normalizado sale IDÉNTICO) y
//      mezcla unidades incompatibles. En el vector de ORDEN 1 resta el
//      promedio transversal otra vez, justo encima de la dim 3 que ES la
//      feature de la etiqueta. Ahora usa RunningNorm (por feature,
//      miia_common.h) — el MISMO código que class24, que hasta ahora no
//      normalizaba nada. Las dos redes recibían el mismo envelope de
//      class19 y lo preprocesaban distinto.
//
//   2. CLAVE DE RED. Keyeaba por `fuente` pelada y RECREABA la red si
//      llegaba otra dimensión, destruyendo pesos, ema, seen y supervised.
//      Es el mismo defecto que ORDEN 0 Fix 3 sacó de class24 — y la
//      cabecera de class24 afirmaba que class23 ya lo tenía arreglado
//      "desde su v2.2". No era cierto. Ahora la clave es "fuente|dim".
//
//   3. TOPE DE PENDING. Se insertaba sin condición; solo el TTL acotaba.
//      Ahora PENDING_MAX=120000 con contador de rechazos, igual que class24.
//
//   COSTO: PESOS_VERSION 1→2. Los pesos v1 se entrenaron sobre otra
//   distribución de entrada, así que se descartan al arrancar. No es
//   pérdida real: ese entrenamiento se hizo sobre una representación que
//   tenía borrada la señal.
//
// CAMBIOS v2.2 respecto a v2.1:
//
//   IN_DIM AHORA ES DINÁMICO (antes hardcodeado a 384)
//
//   PROBLEMA ORIGINAL:
//     IN_DIM = 384 con resize_vec() hacía padding a cero para
//     todos los vectores del sistema:
//       class18 portfolio  32 dims → 352 entradas siempre cero
//       class18 impacto    12 dims → 372 entradas siempre cero
//       class10 mercado    64 dims → 320 entradas siempre cero
//       class3  TF-IDF    128 dims → 256 entradas siempre cero
//     La red aprendía esos pesos como "siempre cero" y los ignoraba,
//     desperdiciando el 84%-97% de su capacidad de representación.
//
//   SOLUCIÓN IMPLEMENTADA — Arquitectura adaptativa por fuente:
//     La red se inicializa con IN_DIM del PRIMER vector que recibe.
//     Si llega un vector de dimensión diferente, se crea una red
//     nueva para esa fuente ("mercado", "portfolio", "impacto", etc.)
//     Cada fuente tiene su propia instancia de MLP23 con la dimensión
//     correcta. No hay padding ni truncado: la red procesa exactamente
//     lo que llega.
//
//   ARQUITECTURA POR FUENTE:
//     fuente="mercado"   64 → 32 → 16 → 8  (class10)
//     fuente="portfolio" 32 → 16 → 8  → 4  (class18)
//     fuente="impacto"   12 → 8  → 4  → 4  (class18)
//     fuente="cluster"   12 → 8  → 4  → 4  (class18)
//     fuente="usuario"   12 → 8  → 4  → 4  (class18)
//     fuente="web"       64 → 32 → 16 → 8  (class3 TF-IDF)
//       ⚠️ 26-sep-2026: eran 128 y NUNCA existió esta red, porque class3 no
//       arrancaba. Ahora su vector es de ancho FIJO 64 (feature hashing) y la
//       clave es web|64. Detrás de CLASS3_ACTIVO, apagado hasta que se decida.
//     fuente desconocida: usa IN_DIM del primer vector recibido
//
//   CAPAS OCULTAS PROPORCIONALES:
//     H1 = IN_DIM / 2   (mín 4)
//     H2 = IN_DIM / 4   (mín 2)
//     OUT = max(4, IN_DIM / 8)
//     Softmax en la última capa (igual que v2.1)
//
// Entrada: class23_ingest | Salida: class23_output
// ============================================================

#include "miia_common.h"
#include <random>
#include <cstdint>   // int64_t / INT64_MAX — diagnóstico de lag del feedback
#include <cstdlib>   // std::llabs
#include <fstream>   // persistencia de pesos a JSON

static constexpr const char* TAG    = "class23";
static constexpr const char* CH_IN       = "class23_ingest";
static constexpr const char* CH_OUT      = "class23_output";
static constexpr const char* CH_FEEDBACK = "class23_feedback";
static constexpr double      LR          = 0.001;

// ── Activaciones ────────────────────────────────────────────
static double relu(double x)    { return x > 0 ? x : 0; }
static double dRelu(double a)   { return a > 0 ? 1.0 : 0.0; }
static double sigmoid(double x) { return 1.0 / (1.0 + std::exp(-std::max(-500.0, x))); }

// ── Capa densa con Xavier init ───────────────────────────────
struct Layer {
    int in_n, out_n;
    std::vector<std::vector<double>> W;
    std::vector<double> b, z, a;

    Layer() = default;
    Layer(int in, int out, unsigned seed = 42) : in_n(in), out_n(out) {
        std::mt19937 rng(seed);
        double sc = std::sqrt(2.0 / (in + out));
        std::normal_distribution<double> d(0.0, sc);
        W.assign(out, std::vector<double>(in));
        b.assign(out, 0.0); z.resize(out); a.resize(out);
        for (int o = 0; o < out; o++)
            for (int i = 0; i < in; i++) W[o][i] = d(rng);
    }

    void forward(const std::vector<double>& x, bool use_relu) {
        for (int o = 0; o < out_n; o++) {
            z[o] = b[o];
            for (int i = 0; i < in_n; i++) z[o] += W[o][i] * x[i];
            a[o] = use_relu ? relu(z[o]) : z[o];
        }
    }

    void softmax() {
        double mx = *std::max_element(z.begin(), z.end());
        double sum = 0.0;
        for (int o = 0; o < out_n; o++) { a[o] = std::exp(z[o] - mx); sum += a[o]; }
        for (int o = 0; o < out_n; o++) a[o] /= sum;
    }
};

// ── Red adaptativa con cabeza ESCALAR y aprendizaje ──────────
// v2.0 — Rediseño. La versión anterior terminaba en softmax(out_dim) y derivaba
// su "score" como sum(|a|)/out_dim; como un softmax suma 1 por definición, ese
// score era la CONSTANTE 1/out_dim, independiente de la entrada. Además nunca
// entrenaba (no existía backward y LR estaba declarado sin usarse) y no
// publicaba score/confianza, así que class25A la leía como 0.5 fijo.
// Ahora: in → in/2 → in/4 → 1 (sigmoid), con backprop supervisado por los
// outcomes reales de class43 — misma arquitectura de aprendizaje que class24,
// pero más profunda (aporta diversidad real al ensemble).
struct MLP23 {
    int in_dim, h1_dim, h2_dim;
    Layer L1, L2;
    std::vector<double> W3;      // capa de salida h2 → 1
    double b3 = 0.0;
    double lr = LR;
    double ema = 0.0;
    int    seen = 0, supervised = 0;
    std::string fuente;
    // ORDEN 3: normalización POR FEATURE, propia de esta red. Antes se usaba
    // normalize_zscore(), que centra cada vector contra su media ENTRE
    // dimensiones y borra el nivel. Ver la nota en miia_common.h.
    RunningNorm norm;

    static int h1(int in) { return std::max(4, in / 2); }
    static int h2(int in) { return std::max(2, in / 4); }

    MLP23() = default;
    MLP23(int in, const std::string& src, unsigned seed_base = 23)
        : in_dim(in), h1_dim(h1(in)), h2_dim(h2(in)), fuente(src)
    {
        L1 = Layer(in_dim, h1_dim, seed_base);
        L2 = Layer(h1_dim, h2_dim, seed_base + 1);
        std::mt19937 rng(seed_base + 2);
        std::normal_distribution<double> d(0.0, std::sqrt(2.0 / (h2_dim + 1)));
        W3.assign(h2_dim, 0.0);
        for (int j = 0; j < h2_dim; j++) W3[j] = d(rng);
        spdlog::info("[{}] 🧠 Nueva red '{}': {}→{}→{}→1 (sigmoid, entrenable)",
                     TAG, src, in_dim, h1_dim, h2_dim);
    }

    // Devuelve el score direccional en [0,1] (>0.5 alcista).
    //
    // ORDEN 3: recibe el vector YA NORMALIZADO. El normalizador vive en la
    // red (`norm`) pero se aplica AFUERA, en el ingest, porque el vector
    // normalizado es el que se guarda en `pendientes`: el entrenamiento que
    // llega 48 h después tiene que ver exactamente lo que vio la inferencia,
    // no lo que diga el normalizador de ese momento.
    double forward(const std::vector<double>& x_norm) {
        auto xn = x_norm;
        xn.resize(in_dim, 0.0);
        L1.forward(xn, true);
        L2.forward(L1.a, true);
        double z = b3;
        for (int j = 0; j < h2_dim; j++) z += W3[j] * L2.a[j];
        double y = sigmoid(z);
        ema = (seen == 0) ? y : ema * 0.9 + y * 0.1;
        seen++;
        return y;
    }

    // Backprop supervisado. `x_norm` es la entrada NORMALIZADA que generó la
    // predicción (la que se guardó en `pendientes`) y `target` la DIRECCIÓN
    // real: 1 = el instrumento le ganó al promedio, 0 = no.
    //
    // OJO — el comentario viejo decía "1 = acertó, 0 = falló". Eso era el
    // contrato PREVIO a ORDEN 0 Fix 4, y contradecía a forward(), que produce
    // un score DIRECCIONAL. class43 manda dirección desde entonces
    // (`outcome: retVeredicto > 0 ? 1 : 0`); el comentario había quedado
    // viejo y era una trampa para quien viniera a "corregir" el payload.
    //
    // Se re-hace el forward para tener las activaciones intermedias del
    // ejemplo correcto: el feedback llega horas después y para entonces las
    // cachés ya fueron pisadas.
    double trainSupervised(const std::vector<double>& x_norm, double target) {
        const double y = paso(x_norm, target);
        supervised++;
        return y;
    }

    // REPASO (5-oct-2026): un paso sobre un ejemplo VIEJO del depósito. No toca
    // `supervised` ni `seen`: van a la planilla y miden el tráfico real.
    void repasar(const std::vector<double>& x_norm, double target) {
        if ((int)x_norm.size() != in_dim) return;
        paso(x_norm, target);
    }

    double paso(const std::vector<double>& x_norm, double target) {
        auto xn = x_norm;
        xn.resize(in_dim, 0.0);
        L1.forward(xn, true);
        L2.forward(L1.a, true);
        double z = b3;
        for (int j = 0; j < h2_dim; j++) z += W3[j] * L2.a[j];
        const double y = sigmoid(z);

        // Salida: dL/dz3 = (y - t) * y * (1 - y)
        const double dz3 = (y - target) * y * (1.0 - y);
        std::vector<double> dh2(h2_dim, 0.0);
        for (int j = 0; j < h2_dim; j++) {
            dh2[j] = dz3 * W3[j] * dRelu(L2.a[j]);
            W3[j] -= lr * dz3 * L2.a[j];
        }
        b3 -= lr * dz3;

        // Capa 2 → capa 1
        std::vector<double> dh1(h1_dim, 0.0);
        for (int o = 0; o < h2_dim; o++) {
            for (int i = 0; i < h1_dim; i++) {
                dh1[i] += dh2[o] * L2.W[o][i];
                L2.W[o][i] -= lr * dh2[o] * L1.a[i];
            }
            L2.b[o] -= lr * dh2[o];
        }
        // Capa 1 → entrada
        for (int o = 0; o < h1_dim; o++) {
            const double g = dh1[o] * dRelu(L1.a[o]);
            for (int i = 0; i < in_dim; i++) L1.W[o][i] -= lr * g * xn[i];
            L1.b[o] -= lr * g;
        }
        return y;
    }
};

// ── Estado: un MLP por fuente ────────────────────────────────
// ORDEN 3 — clave compuesta "fuente|dim", igual que class24 desde su v3.0.
// La cabecera de class24 afirmaba que class23 ya usaba este criterio "desde
// su v2.2". Era falso: class23 keyeaba por `fuente` pelada y RECREABA la red
// (destruyendo los pesos) si llegaba otra dimensión para la misma fuente.
// El disparo realista es el fallback de class19: sin MiniLM, el texto pasa
// de 384 dims a un vector SHA-256 de 64 → la red "web" nacía de cero.
static std::string claveRed(const std::string& fuente, int dim) {
    return fuente + "|" + std::to_string(dim);
}

// DEFECTO 10 (21-sep-2026): forma canónica del instrumento. El ingest y el
// feedback tienen que coincidir dígito por dígito o no matchea nada. Mismo
// criterio que `_esSenalDeMercado` de class43.js. Idéntico al de class24.
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


struct State23 {
    mutable std::mutex mtx;
    // Clave = "fuente|dim" ("mercado|64", "impacto|12", …)
    std::unordered_map<std::string, MLP23> redes;
    std::atomic<uint64_t> total{0}, ok{0}, feedbacks{0}, purgados{0}, rechazados{0};
    // DEFECTO 10: por qué se descartó un feedback, para verlo en el heartbeat.
    std::atomic<uint64_t> fb_sin_ticker{0}, fb_no_relativo{0}, fb_otro_ticker{0};
    std::atomic<uint64_t> lote_truncado{0};

    // REPASO (5-oct-2026). Vive bajo `mtx`, igual que las redes que repasa.
    DepositoRepaso repaso;
    bool           repaso_on = true;

    // Entradas a la espera de outcome: el feedback de class43 llega horas
    // después (horizonte 24-72h), así que hay que conservar el vector que
    // produjo cada predicción para poder entrenar con él.
    struct Pend {
        std::string clave;          // "fuente|dim" — la red que lo produjo
        std::vector<double> x;      // vector YA NORMALIZADO (ORDEN 3)
        int64_t ts_ms;   // epoch millis, para matchear con decision_ts
        // DEFECTO 10 (21-sep-2026): el INSTRUMENTO. Sin él el emparejamiento
        // era sólo por hora y el vector de XLK se entrenaba con el resultado
        // de XLE — la red no podía aprender a distinguir instrumentos.
        std::string symbol;
    };
    mutable std::mutex pmtx;
    std::unordered_map<std::string, Pend> pendientes;

    // ORDEN 3 — tope de seguridad. class24 tenía PENDING_MAX desde su v3.0;
    // acá se insertaba sin condición y lo único que acotaba era el TTL. Con
    // un pico de caudal aguas arriba no había techo. Quien acota de verdad
    // sigue siendo el TTL; esto es el tope.
    static constexpr size_t PENDING_MAX = 120000;

    uint64_t _insertsDesdePurga = 0;

    // Devuelve false si no se guardó (tope alcanzado).
    bool guardarPendiente(const std::string& id, const std::string& clave,
                          const std::vector<double>& x, const std::string& symbol) {
        std::lock_guard<std::mutex> lk(pmtx);
        if (pendientes.size() >= PENDING_MAX && !pendientes.count(id)) {
            rechazados++;
            return false;
        }
        const int64_t ahora = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        pendientes[id] = Pend{clave, x, ahora, symbol};
        // Purga por TTL (80h > horizonte máximo de 72h, igual que class24).
        // AMORTIZADA: barrer O(n) en cada insert sería carísimo con el buffer
        // grande que exige el horizonte de 48-72h. Se barre cada 1000 inserts.
        // El TTL acota la memoria (~48-80h de vectores hasta que llega feedback).
        if (++_insertsDesdePurga >= 1000) {
            _insertsDesdePurga = 0;
            const int64_t TTL_MS = 80LL * 60 * 60 * 1000;
            for (auto it = pendientes.begin(); it != pendientes.end(); ) {
                if (ahora - it->second.ts_ms > TTL_MS) { it = pendientes.erase(it); purgados++; }
                else ++it;
            }
        }
        return true;
    }

    size_t pendientesSize() const {
        std::lock_guard<std::mutex> lk(pmtx);
        return pendientes.size();
    }
};

// ── Obtener o crear la red para una fuente/dimensión ─────────
//
// ORDEN 3: la dimensión va EN LA CLAVE. Si una fuente cambia de dimensión
// nace una red nueva en lugar de destruirse la existente — mismo criterio
// que class24 v3.0. El `it->second = MLP23(...)` que había acá borraba
// pesos, ema, seen y supervised de un plumazo, dejando solo un warn en un
// log que acumula GB.
static MLP23& getOrCreate(State23& st,
                           const std::string& fuente,
                           int in_dim)
{
    const std::string key = claveRed(fuente, in_dim);
    auto it = st.redes.find(key);
    if (it != st.redes.end()) return it->second;

    // Semilla derivada de la CLAVE (no solo de la fuente): dos redes de la
    // misma fuente con dimensiones distintas arrancan de puntos distintos,
    // que es diversidad real y no la misma init repetida.
    unsigned seed = (unsigned)(std::hash<std::string>{}(key)) % 10000 + 23;
    st.redes.emplace(key, MLP23(in_dim, fuente, seed));
    return st.redes.at(key);
}

// ── Hilo de feedback: outcomes reales de class43 → backprop ──
// Sin esto la red nunca aprendía: la v1 no tenía backward NI suscripción a
// ningún canal de feedback, así que sus pesos quedaban en la init aleatoria.
// ── DEFECTO 10: recolección del lote por (instrumento, hora) ─────
//
// Igual que en class24, y por el mismo motivo: en una función con nombre para
// que la simulación la pueda ejercitar sin Redis (docs/simulaciones/sim7).
// Tope de ejemplos por mensaje de feedback. Mismo criterio y mismo número que
// class24 (ver el comentario largo en class24.cpp): antes el tope se repartía
// entre todos los instrumentos y truncar era el régimen normal; ahora el lote
// es de un solo ticker, con ~43 esperados por ventana de rueda.
static constexpr int MAX_LOTE_FB23 = 150;

struct LoteFB23 {
    std::vector<std::pair<std::string, std::vector<double>>> lote;
    int64_t mejor_delta = INT64_MAX;  // lag del más cercano DEL MISMO ticker
    int     otro_ticker = 0;          // en ventana, de otro instrumento: intactos
    int     truncados   = 0;          // eran suyos y no entraron por el tope
};

static LoteFB23 recolectarLote23(State23& st, const std::string& fb_sym,
                                 int64_t dts, int64_t desde, int64_t hasta) {
    LoteFB23 r;
    std::lock_guard<std::mutex> lk(st.pmtx);
    // Recorre el mapa entero a propósito: hace falta para contar truncados y
    // ajenos, y con el emparejamiento por ticker el lote casi nunca se llena,
    // así que cortar temprano ya no servía de nada.
    for (auto it = st.pendientes.begin(); it != st.pendientes.end(); ) {
        const bool    mismo_sym = (it->second.symbol == fb_sym);
        const int64_t delta     = dts - it->second.ts_ms;
        if (mismo_sym && std::llabs(delta) < std::llabs(r.mejor_delta))
            r.mejor_delta = delta;
        const bool en_ventana = it->second.ts_ms >= desde && it->second.ts_ms <= hasta;
        // (ticker, hora), no sólo hora. Los de OTRO instrumento quedan intactos
        // esperando el feedback de SU instrumento.
        if (en_ventana && mismo_sym) {
            if ((int)r.lote.size() < MAX_LOTE_FB23) {
                r.lote.emplace_back(it->second.clave, std::move(it->second.x));
                it = st.pendientes.erase(it);
                continue;
            }
            // Era suyo y no entró. No se borra: muere por TTL en vez de
            // entrenarse con una etiqueta ajena. Igual es pérdida: se cuenta.
            r.truncados++;
        } else if (en_ventana) {
            r.otro_ticker++;
        }
        ++it;
    }
    return r;
}

// ── FASE 2 del feedback: entrenar el lote (y repasar) ─────────
// Igual que class24 (ver el comentario allá): función con nombre para que
// sim29 la ejecute, y el repaso sólo se alimenta con etiquetas RELATIVAS de un
// instrumento real.
// Y sólo se REPASA en ese mismo caso: una red que entrena con una etiqueta
// GENERAL (absoluta) no recibe además ejemplos relativos — sería volver a
// mezclar las dos preguntas, que es lo que arregló el defecto 10.
struct EntrenoFB23 { int entrenados = 0, huerfanos = 0, repasados = 0; };

static EntrenoFB23 entrenarLote23(State23& st,
                                  std::vector<std::pair<std::string, std::vector<double>>>& lote,
                                  const std::string& sym, const std::string& modo,
                                  int64_t dts, double target) {
    EntrenoFB23 r;
    const bool    alimentar = st.repaso_on && sym != "GENERAL" && modo == "relativo";
    const int64_t dia       = DepositoRepaso::diaDe(dts);
    std::lock_guard<std::mutex> lk(st.mtx);
    for (auto& [clave, x] : lote) {
        auto it = st.redes.find(clave);
        if (it == st.redes.end()) { r.huerfanos++; continue; }
        if (alimentar) st.repaso.agregar(clave, sym, dia, x, target);
        // x ya viene normalizado desde el ingest (ORDEN 3).
        it->second.trainSupervised(x, target);
        r.entrenados++;
        if (alimentar && st.repaso.toca()) {
            if (const auto* e = st.repaso.sortear(clave, dia)) {
                it->second.repasar(e->x, e->y);
                r.repasados++;
            }
        }
    }
    return r;
}

static void feedback_loop(State23& st) {
    while (g_running.load()) {
        try {
            sw::redis::ConnectionOptions o;
            o.host = "127.0.0.1"; o.port = 6379;
            o.connect_timeout = std::chrono::milliseconds(3000);
            o.socket_timeout  = std::chrono::seconds(0);
            Redis fbR(o);
            auto sub = fbR.subscriber();
            sub.on_message([&st](std::string, std::string raw) {
                try {
                    auto j = json::parse(raw);
                    // Target = dirección real del mercado (1=subió, 0=bajó).
                    double target = j.value("outcome", -1.0);
                    int64_t dts   = j.value("decision_ts", (int64_t)0);
                    if (target < 0.0 || target > 1.0 || dts <= 0) return;

                    // ── DEFECTO 10 (21-sep-2026) ──────────────────────
                    // Igual que class24. class43 ya manda `ticker` y
                    // `label_modo` en los dos caminos; acá no se usaban.
                    // Un ticker REAL con etiqueta `absoluto` es la dirección
                    // cruda del instrumento, no "¿le ganó al promedio?", que es
                    // la pregunta que se le hace a la red: no entrena. El
                    // agregado (GENERAL) sí es `absoluto` por definición y
                    // entrena a los vectores GENERAL, que son los suyos.
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

                    // Matcheo por TIEMPO (no por id): se entrenan las
                    // predicciones que cayeron en la ventana de la decisión.
                    // Una decisión agrega muchas predicciones → no hay 1:1.
                    // Ventana ANCHA: el lag entre procesar el vector y que
                    // class25B persista la decisión es variable (ventana de 5 s
                    // de class25A + Gemini + escritura). 12 s era una apuesta que
                    // podía no matchear nada. Ver class24 para el detalle.
                    // 15 min: class24/class23 predicen en RÁFAGAS con huecos de
                    // minutos, no de forma continua. Ver class24.cpp para la
                    // medición que motivó el cambio (180 s dejaba afuera
                    // decisiones separadas 253 s de su predicción).
                    const int64_t desde = dts - 900000;  // 15 min antes
                    const int64_t hasta = dts + 120000;  // 2 min de holgura

                    // Recolectar los ejemplos de la ventana (bajo pmtx) y
                    // entrenar después (bajo mtx) para no anidar los locks.
                    LoteFB23 fb = recolectarLote23(st, fb_sym, dts, desde, hasta);
                    auto&         lote        = fb.lote;
                    const int64_t mejor_delta = fb.mejor_delta;
                    const int     otro_ticker = fb.otro_ticker;
                    if (lote.empty()) {
                        if (mejor_delta != INT64_MAX)
                            spdlog::warn("[{}] ⚠️ Feedback {} sin match — lag más cercano: {}s "
                                         "(ventana: -900s..+120s, {} en ventana de "
                                         "otro instrumento)",
                                         TAG, fb_sym, mejor_delta / 1000, otro_ticker);
                        return;
                    }
                    const EntrenoFB23 en = entrenarLote23(st, lote, fb_sym, fb_modo, dts, target);
                    const int entrenados = en.entrenados, huerfanos = en.huerfanos;
                    if (entrenados > 0) {
                        st.feedbacks += entrenados;
                        // Igual que class24: no fabricar el string con fmt::,
                        // que según cómo esté compilado spdlog puede no estar.
                        std::string extra;
                        if (huerfanos > 0)
                            extra = " [" + std::to_string(huerfanos) + " huérfanas: red ya no existe]";
                        st.fb_otro_ticker += otro_ticker;
                        st.lote_truncado  += fb.truncados;
                        if (fb.truncados > 0)
                            spdlog::warn("[{}] ⚠️ {} truncó {} vectores propios por "
                                         "MAX_LOTE_FB23={} — se pierden por TTL",
                                         TAG, fb_sym, fb.truncados, MAX_LOTE_FB23);
                        spdlog::info("[{}] 🎓 Entrenadas {} predicciones de {} [{}] "
                                     "(dir={:.0f}) total_sup={} lag={}s "
                                     "(+{} en ventana de otro instrumento, intactos){}",
                                     TAG, entrenados, fb_sym, fb_modo, target,
                                     st.feedbacks.load(), mejor_delta / 1000,
                                     otro_ticker, extra);
                    }
                } catch (...) { /* mensaje malformado: ignorar */ }
            });
            sub.subscribe(CH_FEEDBACK);
            spdlog::info("[{}] 📡 Suscrito a {} (entrenamiento)", TAG, CH_FEEDBACK);
            while (g_running.load()) sub.consume();
        } catch (const std::exception& e) {
            if (g_running.load()) {
                spdlog::warn("[{}] feedback: {} — reintentando en 3s", TAG, e.what());
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        }
    }
}

// ════════════════════════════════════════════════════════════
// PERSISTENCIA DE PESOS
// ════════════════════════════════════════════════════════════
// Ver la nota extensa en class24.cpp: mismo problema, misma solución. Los
// pesos vivían solo en RAM y cada caída del proceso borraba el entrenamiento
// acumulado sin dejar rastro visible.
//
// Particularidad de class23: `Layer` guarda z y a como buffers de trabajo que
// el constructor dimensiona. Al restaurar desde JSON hay que redimensionarlos a
// mano — si quedan vacíos, forward() escribe fuera de rango y el proceso muere.
// v2 (ORDEN 3): la clave de red pasó de "fuente" a "fuente|dim" y la entrada
// pasó de normalize_zscore (por muestra) a RunningNorm (por feature). Los
// pesos v1 se entrenaron sobre OTRA distribución de entrada: cargarlos daría
// una red que puntúa números plausibles sin significado. Se descartan.
static constexpr int PESOS_VERSION = 2;
static fs::path g_pesos_file;
static fs::path g_repaso_file;     // state/class23_repaso.json (5-oct-2026)
static int      g_save_min = 60;   // CLASS23_SAVE_MIN

static json layerToJson(const Layer& L) {
    return json{{"in_n", L.in_n}, {"out_n", L.out_n}, {"W", L.W}, {"b", L.b}};
}

static bool layerFromJson(const json& j, Layer& L) {
    L.in_n  = j.value("in_n", 0);
    L.out_n = j.value("out_n", 0);
    L.W     = j.value("W", std::vector<std::vector<double>>{});
    L.b     = j.value("b", std::vector<double>{});
    if (L.in_n <= 0 || L.out_n <= 0) return false;
    if ((int)L.W.size() != L.out_n || (int)L.b.size() != L.out_n) return false;
    for (const auto& fila : L.W) if ((int)fila.size() != L.in_n) return false;
    // Buffers de trabajo: el constructor los dimensiona, la deserialización no.
    L.z.assign(L.out_n, 0.0);
    L.a.assign(L.out_n, 0.0);
    return true;
}

static void guardarPesos(const State23& st) {
    if (g_pesos_file.empty()) return;
    try {
        json redes = json::object();
        size_t n = 0;
        {
            std::lock_guard<std::mutex> lk(st.mtx);
            for (const auto& [f, r] : st.redes) {
                redes[f] = {
                    {"in_dim", r.in_dim}, {"h1_dim", r.h1_dim}, {"h2_dim", r.h2_dim},
                    {"fuente", r.fuente}, {"lr", r.lr}, {"ema", r.ema},
                    {"seen", r.seen}, {"supervised", r.supervised},
                    {"b3", r.b3}, {"W3", r.W3},
                    {"L1", layerToJson(r.L1)}, {"L2", layerToJson(r.L2)},
                    // ORDEN 3: sin el normalizador los pesos no significan
                    // nada al recargar — la red vería otra escala de entrada.
                    {"norm", r.norm.toJson()}
                };
                n++;
            }
        }
        json j = {
            {"__meta__", {{"version", PESOS_VERSION}, {"modulo", TAG}, {"redes", n}}},
            {"redes", redes}
        };
        // Escritura atómica: tmp + rename. Un kill a mitad del dump no puede
        // destruir el archivo bueno.
        fs::path tmp = g_pesos_file; tmp += ".tmp";
        { std::ofstream out(tmp); if (!out) return; out << j.dump(); }
        fs::rename(tmp, g_pesos_file);
        spdlog::info("[{}] 💾 pesos guardados: {} redes", TAG, n);
    } catch (const std::exception& e) {
        spdlog::warn("[{}] no se pudieron guardar los pesos: {}", TAG, e.what());
    }
}

static bool cargarPesos(State23& st) {
    if (g_pesos_file.empty() || !fs::exists(g_pesos_file)) {
        spdlog::info("[{}] sin pesos previos — las redes arrancan desde cero", TAG);
        return false;
    }
    try {
        std::ifstream in(g_pesos_file);
        json j; in >> j;
        const int ver = j.value("__meta__", json::object()).value("version", 0);
        if (ver != PESOS_VERSION) {
            spdlog::warn("[{}] ⚠️ pesos v{} != v{} — se descartan", TAG, ver, PESOS_VERSION);
            return false;
        }

        // Referencia al objeto VIVO dentro de `j` (ver la nota en class24.cpp):
        // iterar sobre el temporal que devuelve .value() es una referencia
        // colgante.
        if (!j.contains("redes") || !j["redes"].is_object()) {
            spdlog::warn("[{}] ⚠️ archivo de pesos sin sección 'redes' — se descarta", TAG);
            return false;
        }
        const json& redesJ = j["redes"];

        int cargadas = 0, rechazadas = 0;
        std::lock_guard<std::mutex> lk(st.mtx);
        for (auto& [f, r] : redesJ.items()) {
            MLP23 m;
            m.in_dim     = r.value("in_dim", 0);
            m.h1_dim     = r.value("h1_dim", 0);
            m.h2_dim     = r.value("h2_dim", 0);
            m.fuente     = r.value("fuente", f);
            m.lr         = r.value("lr", LR);
            m.ema        = r.value("ema", 0.0);
            m.seen       = r.value("seen", 0);
            m.supervised = r.value("supervised", 0);
            m.b3         = r.value("b3", 0.0);
            m.W3         = r.value("W3", std::vector<double>{});

            // La arquitectura se deriva de in_dim. Si la fórmula h1/h2 cambió
            // entre builds, los pesos guardados no corresponden a esta red.
            const bool arqOk = m.in_dim > 0 &&
                m.h1_dim == MLP23::h1(m.in_dim) && m.h2_dim == MLP23::h2(m.in_dim);
            const bool capasOk = arqOk &&
                r.contains("L1") && r.contains("L2") &&
                layerFromJson(r["L1"], m.L1) && layerFromJson(r["L2"], m.L2) &&
                m.L1.in_n == m.in_dim && m.L1.out_n == m.h1_dim &&
                m.L2.in_n == m.h1_dim && m.L2.out_n == m.h2_dim &&
                (int)m.W3.size() == m.h2_dim;

            if (!capasOk) {
                spdlog::warn("[{}] ⚠️ red '{}' con arquitectura inconsistente "
                             "(in={} h1={} h2={}) — descartada, NO se usa a medias",
                             TAG, f, m.in_dim, m.h1_dim, m.h2_dim);
                rechazadas++;
                continue;
            }
            // ORDEN 3: el normalizador es parte del contrato de entrada. Si no
            // está o no tiene la forma correcta, los pesos NO son utilizables:
            // se entrenaron sobre otra escala. Misma regla que la validación de
            // forma de las capas — descartar entera antes que usar a medias.
            if (!r.contains("norm") || !m.norm.fromJson(r["norm"], (size_t)m.in_dim)) {
                spdlog::warn("[{}] ⚠️ red '{}' sin normalizador válido — descartada "
                             "(los pesos se entrenaron sobre otra escala)", TAG, f);
                rechazadas++;
                continue;
            }
            st.redes[f] = std::move(m);
            cargadas++;
        }
        spdlog::info("[{}] 💾 pesos restaurados: {} redes, {} descartadas",
                     TAG, cargadas, rechazadas);
        for (const auto& [f, r] : st.redes)
            spdlog::info("[{}]   ↻ fuente='{}' dims={} seen={} sup={} ema={:.4f}",
                         TAG, f, r.in_dim, r.seen, r.supervised, r.ema);
        return cargadas > 0;
    } catch (const std::exception& e) {
        spdlog::warn("[{}] pesos ilegibles ({}) — se arranca desde cero", TAG, e.what());
        return false;
    }
}

// La simulación incluye este .cpp con -DMIIA_SIN_MAIN para ejercitar la lógica
// real sin arrancar el proceso. En producción la macro no existe.
#ifndef MIIA_SIN_MAIN
int main() {
    std::signal(SIGINT, miia_signal); std::signal(SIGTERM, miia_signal);
    fs::path base = fs::current_path() / ".." / "operador" / "aprendizaje";
    try { fs::create_directories(base / "logs");
          fs::create_directories(base / "state"); } catch (...) {}
    init_logger(TAG, (base / "logs" / "class23.log").string());

    g_pesos_file  = base / "state" / "class23_pesos.json";
    g_repaso_file = base / "state" / "class23_repaso.json";
    if (const char* e = std::getenv("CLASS23_SAVE_MIN")) {
        try {
            int v = std::stoi(e);
            if (v >= 1 && v <= 1440) g_save_min = v;
            else spdlog::warn("[{}] CLASS23_SAVE_MIN={} fuera de [1,1440] — se ignora", TAG, v);
        } catch (...) { /* valor inválido → default */ }
    }

    spdlog::info("[{}] ══ Filtro Neural Adaptativo v3.0 (entrenable) ══", TAG);
    spdlog::info("[{}] {} + {} → {}", TAG, CH_IN, CH_FEEDBACK, CH_OUT);
    spdlog::info("[{}] Arquitectura: IN → IN/2 → IN/4 → 1 (sigmoid), lr={}", TAG, LR);
    if (RunningNorm::legado())
        spdlog::warn("[{}] ⚠️ normalizador en modo LEGADO (ventana ~1000): la red no ve "
                     "el nivel del régimen", TAG);
    else
        spdlog::info("[{}] 📐 normalizador con ventana lenta: {:.0f} muestras",
                     TAG, RunningNorm::ventana());

    auto pub = connect_redis(TAG);
    if (!pub) { spdlog::error("[{}] Sin Redis.", TAG); return 1; }
    publish_ready(*pub, TAG, CH_IN);

    State23 st;

    // Restaurar antes de levantar los hilos: si el feedback llegara primero,
    // getOrCreate() crearía redes vacías con las mismas claves.
    cargarPesos(st);

    // REPASO: después de los pesos (un ejemplo sólo se carga si su red existe).
    configurar_repaso("CLASS23", TAG, st.repaso, st.repaso_on);
    if (st.repaso_on) {
        std::lock_guard<std::mutex> lk(st.mtx);
        std::unordered_map<std::string, int> dims;
        for (const auto& [k, r] : st.redes) dims[k] = r.in_dim;
        cargar_repaso(g_repaso_file, st.repaso, dims, TAG);
    }

    // Guardado periódico. Duerme de a 1 s para que el apagado no espere.
    std::thread saveThread([&]() {
        while (g_running.load()) {
            for (int i = 0; i < g_save_min * 60 && g_running.load(); i++)
                std::this_thread::sleep_for(std::chrono::seconds(1));
            if (!g_running.load()) break;
            guardarPesos(st);
            if (st.repaso_on) guardar_repaso(g_repaso_file, st.repaso, st.mtx, TAG);
        }
        guardarPesos(st);   // extra en cierre ordenado; con kill -9 no corre
        if (st.repaso_on) guardar_repaso(g_repaso_file, st.repaso, st.mtx, TAG);
    });
    saveThread.detach();
    spdlog::info("[{}] 💾 persistencia activa: cada {} min → {}",
                 TAG, g_save_min, g_pesos_file.string());

    // Hilo de entrenamiento (outcomes reales de class43)
    std::thread fb(feedback_loop, std::ref(st));

    // Heartbeat
    std::thread hb([&]() {
        while (g_running.load()) {
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if (!g_running.load()) break;
            const size_t pend = st.pendientesSize();   // toma pmtx, NO mtx
            std::lock_guard<std::mutex> lk(st.mtx);
            spdlog::info("[{}]   defecto10: sin_ticker={} no_relativo={} "
                         "otro_ticker_preservados={} lote_truncado={}",
                         TAG, st.fb_sin_ticker.load(), st.fb_no_relativo.load(),
                         st.fb_otro_ticker.load(), st.lote_truncado.load());
            spdlog::info("[{}]   {}", TAG, linea_repaso(st.repaso, st.repaso_on));
            spdlog::info("[{}] ❤️  total={} ok={} redes={} fb={} pending={} rech={}",
                         TAG, st.total.load(), st.ok.load(), st.redes.size(),
                         st.feedbacks.load(), pend, st.rechazados.load());
            for (auto& [f, r] : st.redes)
                spdlog::info("[{}]   red='{}' dims={} seen={} sup={} ema={:.4f} norm_n={}",
                             TAG, f, r.in_dim, r.seen, r.supervised, r.ema, r.norm.n);
        }
    });
    hb.detach();
    fb.detach();

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

                    // Aceptar type="vector", "analysis", "vectoidea" o sin tipo
                    std::string type = j.value("type", "");
                    if (!type.empty() && type != "vector" &&
                        type != "analysis" && type != "vectoidea") return;

                    // Extraer vector y fuente
                    std::vector<double> emb;
                    std::string fuente = j.value("fuente",
                                         j.value("origen",
                                         j.value("source", std::string("desconocido"))));

                    // ── ORDEN 1: ticker del instrumento ───────────────────
                    // class23 no leía el símbolo en absoluto: publicaba
                    // data.symbol = j["source"], o sea "class19" fijo.
                    const json& dIn = (j.contains("data") && j["data"].is_object())
                                      ? j["data"] : json::object();
                    std::string symbol = j.value("symbol",
                                         j.value("ticker",
                                         dIn.value("symbol",
                                         dIn.value("ticker", std::string("")))));
                    symbol = canonSymbol(symbol);  // DEFECTO 10: misma forma que el feedback

                    if (j.contains("vector") && j["vector"].is_array()) {
                        emb = sanitize(j["vector"]);
                    } else if (j.contains("data") && j["data"].is_object()) {
                        auto& d = j["data"];
                        if (d.contains("items") && d["items"].is_array()) {
                            for (auto& it : d["items"]) {
                                if (it.contains("embedding")) emb = sanitize(it["embedding"]);
                                else if (it.contains("vector")) emb = sanitize(it["vector"]);
                                if (!emb.empty()) break;
                            }
                        } else if (d.contains("embedding")) emb = sanitize(d["embedding"]);
                        else if (d.contains("vector"))    emb = sanitize(d["vector"]);
                    }
                    if (emb.empty()) return;

                    int in_dim = (int)emb.size();
                    const std::string key = claveRed(fuente, in_dim);
                    double ema_val = 0.0;
                    double score   = 0.5;
                    int    supervisados = 0;
                    // ORDEN 3: el vector NORMALIZADO. Es el que se puntúa y el
                    // que se guarda en pendientes, para que el entrenamiento de
                    // dentro de 48 h vea exactamente esto.
                    std::vector<double> emb_n;
                    {
                        std::lock_guard<std::mutex> lk(st.mtx);
                        auto& red   = getOrCreate(st, fuente, in_dim);
                        red.norm.observar(emb);
                        emb_n       = red.norm.aplicar(emb);
                        score       = red.forward(emb_n);
                        ema_val     = red.ema;
                        supervisados = red.supervised;
                    }

                    const std::string vid = make_id(TAG);
                    // Guardar la entrada para poder entrenar cuando llegue el
                    // outcome (horas después). Igual criterio que class24.
                    if (!st.guardarPendiente(vid, key, emb_n, symbol)) {
                        spdlog::warn("[{}] ⚠️ Pending lleno ({}) — vector {} no guardado",
                                     TAG, State23::PENDING_MAX, vid.substr(0, 8));
                    }

                    st.total++;
                    st.ok++;

                    json payload = {
                        {"id",     vid},
                        {"source", TAG},
                        {"type",   "analysis"},
                        {"text",   "neural score " + std::to_string(score).substr(0, 6)},
                        {"fuente", fuente},
                        {"origen", j.value("origen", fuente)},
                        // NIVEL SUPERIOR: class25A lee confianza/score de acá.
                        // Antes no se publicaban y el ensemble usaba 0.5 fijo.
                        {"confianza", score},
                        {"score",     score},
                        // Ticker arriba: es lo que class25A usa para agrupar.
                        {"symbol",    symbol},
                        {"ticker",    symbol},
                        {"data", {
                            {"symbol",    symbol},
                            {"ticker",    symbol},
                            {"score",     score},
                            {"metrics", {
                                {"ema",         ema_val},
                                {"in_dim",      in_dim},
                                {"supervised",  supervisados},
                                {"pendientes",  (int)st.pendientesSize()},
                                {"redes_total", (int)st.redes.size()}
                            }}
                        }},
                        {"ts", now_iso()}
                    };
                    pub->publish(CH_OUT, payload.dump());
                    spdlog::info("[{}] 📤 fuente='{}' in_dim={} score={:.4f} ema={:.4f} sup={}",
                                 TAG, fuente, in_dim, score, ema_val, supervisados);

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
