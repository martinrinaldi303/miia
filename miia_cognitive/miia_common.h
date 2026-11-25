#pragma once
// miia_common.h — Utilidades compartidas para class21-29
#include <string>
#include <cstdlib>
#include <vector>
#include <deque>
#include <set>
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <csignal>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <filesystem>
#include <fstream>
#include <numeric>
#include <unordered_map>
#include <random>
#include <cstdint>

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/sinks/rotating_file_sink.h>

using json  = nlohmann::json;
using Redis = sw::redis::Redis;
namespace fs = std::filesystem;

inline std::atomic<bool> g_running{true};
inline void miia_signal(int) { g_running.store(false); }

inline std::string now_iso() {
    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::gmtime(&t), "%Y-%m-%dT%H:%M:%SZ");
    return ss.str();
}

inline std::string make_id(const char* prefix = "cx") {
    auto ns = std::chrono::high_resolution_clock::now().time_since_epoch().count();
    std::stringstream ss; ss << prefix << "_" << std::hex << ns;
    return ss.str();
}

inline std::vector<double> sanitize(const json& arr) {
    std::vector<double> v;
    if (!arr.is_array()) return v;
    v.reserve(arr.size());
    for (const auto& e : arr) {
        double x = e.is_number() ? e.get<double>() : 0.0;
        v.push_back(std::isfinite(x) ? x : 0.0);
    }
    return v;
}

inline double avg_abs(const std::vector<double>& v) {
    if (v.empty()) return 0.5;
    double s = 0.0;
    for (double x : v) s += std::abs(x);
    return std::min(1.0, s / v.size());
}

inline double coseno(const std::vector<double>& a, const std::vector<double>& b) {
    if (a.empty() || a.size() != b.size()) return 0.0;
    double dot=0,ma=0,mb=0;
    for (size_t i=0;i<a.size();i++){dot+=a[i]*b[i];ma+=a[i]*a[i];mb+=b[i]*b[i];}
    double d=std::sqrt(ma*mb); return d==0.0?0.0:dot/d;
}

inline double estabilidad(const std::deque<std::vector<double>>& h) {
    if (h.size()<2) return 1.0;
    double s=0; int n=0;
    for (size_t i=1;i<h.size();i++){double x=coseno(h[i-1],h[i]);if(std::isfinite(x)){s+=x;n++;}}
    if (n==0) return 0.5;
    return (s/n+1.0)/2.0;
}

// ⚠️ Estas 18 palabras YA NO GOBIERNAN la coherencia: quedan sólo para el modo
// legado (`CLASS21_COHER_LEGACY=1`). Ver «Coherencia con el dominio financiero»
// más abajo — estaban en castellano sin tildes y el texto llega en inglés.
inline const std::vector<std::string> KEYWORDS = {
    "crisis","riesgo","colapso","volatilidad","mercado","inflacion",
    "recesion","caida","recuperacion","bolsa","precio","bono",
    "banco","deuda","credito","activo","portafolio","inversion"
};

inline std::set<std::string> tokenize(const std::string& txt) {
    std::set<std::string> out; std::string cur;
    for (unsigned char c:txt){
        if(std::isalpha(c)) cur+=(char)std::tolower(c);
        else{if(cur.size()>=4) out.insert(cur);cur.clear();}
    }
    if(cur.size()>=4) out.insert(cur);
    return out;
}

// ── Coherencia con el dominio financiero, INDEPENDIENTE DEL IDIOMA ──
//
// Reemplaza a `coherencia_jaccard`, que devolvía una CONSTANTE. Dos defectos
// independientes, los dos verificados leyendo el código el 27-sep-2026:
//
//   1 · LAS PALABRAS ESTABAN EN CASTELLANO Y EL TEXTO LLEGA EN INGLÉS. Las 18
//       KEYWORDS eran "crisis, riesgo, colapso, volatilidad…", y lo que entra
//       es el texto sintético de class10 ("market features XLK chg=…") o un
//       titular de Google News en inglés. Intersección 0 → devolvía el piso.
//
//   2 · Y AUNQUE EL TEXTO ESTUVIERA EN CASTELLANO, TAMPOCO PODÍA SUBIR. Dos
//       motivos que se suman:
//
//       · Jaccard divide por la UNIÓN. Con 18 keywords y un texto de 20
//         tokens, para pasar el piso de 0,3 harían falta ~11 de las 18
//         palabras en un solo texto. Nunca pasa. La métrica está mal elegida:
//         castiga el texto largo y el vocabulario grande.
//       · `tokenize` sólo guarda bytes que pasan `std::isalpha`, y en UTF-8
//         una vocal acentuada son DOS bytes (0xC3 0xB3 para 'ó') que no lo
//         pasan. "inflación" se partía en "inflaci" + "n" y "inflaci" no está
//         en la lista, que dice "inflacion" sin tilde. O sea que el castellano
//         REAL, con acentos, tampoco coincidía nunca.
//
// Medido sobre el chequeo del 27-sep: class21 pesa `coher` al 10 %, así que
// estaba sumando 0,10 × 0,3 = 0,03 fijo a las 108.933 señales. Un término
// constante no aporta al ranking — la misma lección que class22 pasando el
// 100 % y que el factor global de class27: **lo que es igual para los 50
// instrumentos no mueve un puesto.**
//
// LO QUE HACE AHORA:
//   · pliega los acentos a ASCII ANTES de tokenizar, así "inflación",
//     "inflacion" e "inflation" caen todos en el mismo concepto;
//   · reconoce RAÍCES, no palabras exactas, en castellano y en inglés;
//   · cuenta CONCEPTOS DISTINTOS y los acota, en vez de dividir por la unión.
//
// ⚠️ ALCANCE HONESTO: "cualquier idioma" quiere decir que no se ROMPE con
// ninguno y que funciona con los dos que de verdad llegan. Un titular en
// cirílico o en chino no tiene raíces en esta lista y cae al piso de 0,3 —
// igual que antes, pero ahora es una decisión escrita y no un accidente.
// Agregar un idioma es agregar raíces a CONCEPTOS.
//
// ⚠️ Y en el camino de MERCADO sigue siendo casi constante, porque el texto de
// class10 es sintético y dice lo mismo para los 50 instrumentos (~1 concepto →
// 0,475). Donde varía de verdad es en los caminos con texto real: el `resumen`
// de class11 vía class18, y las noticias de class3. No hay que esperar que esto
// solo cambie el orden del ranking.

// Raíces de 4+ caracteres: coincide si el token EMPIEZA con la raíz.
inline const std::vector<std::string> CONCEPTOS = {
    // riesgo y estrés
    "riesg","risk","crisis","crash","colaps","collaps","volatil","panic","panico",
    "recesi","recess","default","quiebra","bankrupt","contagio","contagion",
    // dirección
    "caid","fall","drop","slide","declin","baja","bajist","plunge","tumbl","sink",
    "sube","subid","alcist","rally","rise","gain","surge","jump","climb","advanc",
    "recuper","recover","rebound","rebote",
    // mercado e instrumentos
    "mercad","market","bolsa","stock","equit","share","accion","indice","index",
    "sector","fondo","fund","bono","bond","yield","rendimient","divisa","currenc",
    "dolar","dollar","commodit","materia","cripto","crypto",
    // precio y valuación
    "preci","price","valor","value","cotiza","quote","spread","prima","premium",
    "ganan","earning","profit","perdid","loss","ingres","revenue","margen","margin",
    // macro y política monetaria
    "inflaci","inflat","deflaci","deflat","tasa","rate","interes","interest",
    "central","reserv","federal","politic","polic","estimul","stimul",
    "crecimient","growth","empleo","employ","desempleo","unemploy",
    "deuda","debt","deficit","superavit","surplus","arancel","tariff","impuest",
    // crédito y balance
    "credit","credito","prestam","loan","liquidez","liquidit","solvenc","solven",
    "activo","asset","pasivo","liabilit","balance","capital",
    // cartera y decisión
    "portafoli","portfolio","cartera","invers","invest","compra","buy","venta",
    "sell","posicion","position","cobertur","hedge","apalanc","leverag",
    // oferta y demanda
    "demanda","demand","oferta","supply","produccion","product","consumo","consum",
    // resultados y expectativas
    "pronostic","forecast","guidance","expectativ","expect","estimacion","estimate",
    "informe","report","resultado","result",
};

// Palabras cortas del dominio, con coincidencia EXACTA. Van aparte porque una
// raíz de 3 caracteres genera falsos positivos (con prefijo, "fed" agarraría
// "fedex" y "gas" agarraría "gasto").
inline const std::vector<std::string> CONCEPTOS_EXACTOS = {
    "oil","gas","fed","bce","pib","gdp","etf","iva","tax","eur","usd","ppi","cpi",
};

// Cuántos conceptos distintos hacen falta para llegar a 1,0. Un titular
// financiero real toca 2 a 4; el texto sintético de class10 toca 1.
inline constexpr int COHER_CONCEPTOS_PLENO = 4;

// Pliega a ASCII minúscula. Los dos bytes de UTF-8 de Latin-1/Latin Extended-A
// se mapean a su vocal; cualquier otro byte alto pasa a ser separador, así que
// un texto en otro alfabeto no produce tokens basura.
inline std::string plegar_texto(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        unsigned char c = (unsigned char)s[i];
        if (c < 0x80) { out += (char)std::tolower(c); continue; }
        if (c == 0xC3 && i + 1 < s.size()) {
            unsigned char d = (unsigned char)s[++i];
            switch (d) {
                case 0x80: case 0x81: case 0x82: case 0x83: case 0x84: case 0x85:
                case 0xA0: case 0xA1: case 0xA2: case 0xA3: case 0xA4: case 0xA5:
                    out += 'a'; break;
                case 0x87: case 0xA7: out += 'c'; break;
                case 0x88: case 0x89: case 0x8A: case 0x8B:
                case 0xA8: case 0xA9: case 0xAA: case 0xAB:
                    out += 'e'; break;
                case 0x8C: case 0x8D: case 0x8E: case 0x8F:
                case 0xAC: case 0xAD: case 0xAE: case 0xAF:
                    out += 'i'; break;
                case 0x91: case 0xB1: out += 'n'; break;
                case 0x92: case 0x93: case 0x94: case 0x95: case 0x96:
                case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6:
                    out += 'o'; break;
                case 0x99: case 0x9A: case 0x9B: case 0x9C:
                case 0xB9: case 0xBA: case 0xBB: case 0xBC:
                    out += 'u'; break;
                case 0x9D: case 0xBD: case 0xBF: out += 'y'; break;
                default: out += ' '; break;
            }
            continue;
        }
        out += ' ';   // cualquier otro byte alto: separador
    }
    return out;
}

// Tokeniza el texto ya plegado. Mínimo 3 caracteres —no 4 como `tokenize`—
// porque "oil", "fed" y "pib" son términos del dominio.
inline std::set<std::string> tokenizar_plegado(const std::string& texto) {
    std::set<std::string> out;
    std::string cur;
    for (char ch : plegar_texto(texto)) {
        unsigned char c = (unsigned char)ch;
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) cur += (char)c;
        else { if (cur.size() >= 3) out.insert(cur); cur.clear(); }
    }
    if (cur.size() >= 3) out.insert(cur);
    return out;
}

// Devuelve [0,3 , 1,0]. El piso de 0,3 y el 0,5 para texto vacío se conservan
// del comportamiento viejo para no mover la escala del score de class21.
inline double coherencia_dominio(const std::string& texto) {
    if (texto.empty()) return 0.5;
    const auto toks = tokenizar_plegado(texto);
    if (toks.empty()) return 0.3;

    std::set<std::string> vistos;   // conceptos DISTINTOS, no coincidencias
    for (const auto& t : toks) {
        for (const auto& raiz : CONCEPTOS)
            if (t.size() >= raiz.size() && t.compare(0, raiz.size(), raiz) == 0) {
                vistos.insert(raiz);
                break;
            }
        for (const auto& ex : CONCEPTOS_EXACTOS)
            if (t == ex) { vistos.insert(ex); break; }
    }
    const double frac = std::min(1.0, (double)vistos.size() / (double)COHER_CONCEPTOS_PLENO);
    return 0.3 + 0.7 * frac;
}

// Compatibilidad: el nombre viejo sigue existiendo y delega. `CLASS21_COHER_LEGACY=1`
// devuelve la constante de antes, para poder comparar sin recompilar.
inline double coherencia_jaccard(const std::string& texto) {
    static const bool legado = [] {
        const char* v = std::getenv("CLASS21_COHER_LEGACY");
        return v && std::string(v) == "1";
    }();
    if (!legado) return coherencia_dominio(texto);

    if (texto.empty()) return 0.5;
    auto tt = tokenize(texto);
    std::set<std::string> kk(KEYWORDS.begin(), KEYWORDS.end());
    if (tt.empty()) return 0.3;
    int inter = 0; for (auto& t : tt) if (kk.count(t)) inter++;
    int uni = (int)tt.size() + (int)kk.size() - inter;
    if (uni == 0) return 0.5;
    return std::max(0.3, (double)inter / uni);
}

// ── ORDEN 3 · Normalización POR FEATURE, en línea ────────────
//
// Reemplaza a normalize_zscore() (abajo) como preprocesamiento de las redes.
//
// EL DEFECTO QUE CORRIGE. normalize_zscore centra cada vector contra su
// PROPIA media ENTRE DIMENSIONES. Eso no es normalización de features:
//
//   · Borra el nivel. Si los 13 sectores suben lo mismo, la media del
//     vector sube con ellos y el vector normalizado sale IDÉNTICO. La red
//     literalmente no puede ver un movimiento de mercado uniforme.
//   · Mezcla unidades incompatibles en una sola media: change (~±0.03),
//     precio/open (~1.0), estado (0/0.5/1), riesgo (0-1), similitud con
//     crisis (0-1).
//   · Y en el vector de ORDEN 1 resta aproximadamente el promedio
//     transversal OTRA VEZ, porque las dims 17-55 SON la sección completa
//     — justo encima de la dim 3, que es la feature de la etiqueta.
//
// class24, por su parte, no normalizaba NADA: con Xavier ~sqrt(2/inDim) y
// lr=0.01, las dims de magnitud ~1.0 dominaban el gradiente y la dim 3
// (~0.005) era el input más débil de la red.
//
// ACÁ cada dimensión se estandariza contra SU propia historia. Hace
// comparables las escalas sin destruir el nivel, y es el MISMO código en
// class23 y class24 — antes cada una preprocesaba distinto el mismo
// envelope de class19.
//
// EMA en vez de Welford a propósito: las estadísticas de mercado derivan, y
// una media acumulada desde el arranque queda vieja. ALPHA=0.001 ≈ ventana
// efectiva de 1000 muestras.
//
// El vector NORMALIZADO es el que se guarda en `pending`, así el
// entrenamiento de dentro de 48 h usa exactamente lo que vio la inferencia
// y no lo que diga el normalizador de ese momento.
//
// ── VENTANA LENTA (1-oct-2026) ───────────────────────────────────────────
// Con ALPHA=0.001 la ventana eran ~1000 vectores. Con 50 instrumentos eso es
// MENOS DE UNA HORA, y tiene una consecuencia que el párrafo de arriba no vio:
// las dims COMPARTIDAS del vector (riesgo global, breadth, dispersión, los
// cuantiles de la sección) describen el régimen de mercado por su NIVEL, y una
// ventana de una hora se lo resta. Medido con sim26: una dim que vale 0,30 en
// un régimen y 0,70 en otro llegaba a la red como 0,000 y −0,002. La red no
// tenía con qué distinguir un régimen de otro — «sin destruir el nivel» era
// cierto contra normalize_zscore y falso contra el reloj.
//
// Ahora la ventana es de `ventana()` muestras (1.000.000 por defecto: unas 50
// ruedas de `mercado|22` con 50 instrumentos), y el alfa arranca en 1/n, igual
// que la base EWMA de class25A: al principio es un promedio acumulado y recién
// después empieza a olvidar. Así no arrastra el primer vector ni tarda semanas
// en tener un desvío utilizable.
//
//   MIIA_NORM_VENTANA=1000  → el comportamiento anterior, EXACTO (alfa fijo).
//
// Un normalizador cargado de un archivo viejo (sin `n_lento`) arranca la
// agenda en 1000, o sea con el alfa que traía, y de ahí decae suave: no hay
// escalón el día del despliegue.
struct RunningNorm {
    static constexpr double    ALPHA  = 0.001;  // el alfa LEGADO (ventana ~1000)
    static constexpr double    VENTANA_DEFECTO = 1000000.0;
    static constexpr double    SD_MIN = 1e-3;   // piso: evita dividir por ~0
    static constexpr double    CLAMP  = 5.0;    // acota outliers y el warmup
    static constexpr long long WARMUP = 200;    // antes de esto: solo centrar

    std::vector<double> mean, var;
    long long           n = 0;
    long long           n_lento = 0;   // contador de la agenda del alfa (1/n → 1/ventana)

    // Tamaño de la ventana, en muestras. Se lee del entorno UNA vez; las
    // simulaciones lo pisan para comparar los dos comportamientos en un mismo
    // proceso. Un valor <= 1000 es el modo legado.
    static double& ventana() {
        static double v = [] {
            if (const char* e = std::getenv("MIIA_NORM_VENTANA")) {
                try {
                    const double x = std::stod(e);
                    if (x >= 100.0 && x <= 1e9) return x;
                } catch (...) {}
            }
            return VENTANA_DEFECTO;
        }();
        return v;
    }
    static bool legado() { return ventana() <= 1000.0; }

    void observar(const std::vector<double>& x) {
        if (mean.size() != x.size()) {          // primera vez o cambio de dim
            mean.assign(x.size(), 0.0);
            var .assign(x.size(), 0.0);
            n = 0; n_lento = 0;
        }
        if (n == 0) {
            for (size_t i = 0; i < x.size(); i++) { mean[i] = x[i]; var[i] = 0.0; }
            n = 1; n_lento = 1;
            return;
        }
        n_lento++;
        const double a = legado() ? ALPHA
                                  : std::max(1.0 / ventana(), 1.0 / (double)n_lento);
        for (size_t i = 0; i < x.size(); i++) {
            const double d = x[i] - mean[i];    // delta con la media VIEJA
            mean[i] += a * d;
            var[i]   = (1.0 - a) * var[i] + a * d * d;
        }
        n++;
    }

    // No muta: se puede llamar desde un método const.
    std::vector<double> aplicar(const std::vector<double>& x) const {
        std::vector<double> out(x.size(), 0.0);
        const bool listo = (n >= WARMUP);
        for (size_t i = 0; i < x.size(); i++) {
            if (i >= mean.size()) { out[i] = 0.0; continue; }
            const double c = x[i] - mean[i];
            // Durante el warmup la varianza todavía no es fiable: se centra
            // pero no se escala, en vez de dividir por un sd ruidoso.
            const double sd = listo ? std::max(SD_MIN, std::sqrt(var[i])) : 1.0;
            out[i] = std::max(-CLAMP, std::min(CLAMP, c / sd));
        }
        return out;
    }

    json toJson() const {
        return json{{"n", n}, {"n_lento", n_lento}, {"mean", mean}, {"var", var}};
    }

    // Devuelve false si el JSON no describe un normalizador de `dim`
    // dimensiones — el llamador descarta la red entera, igual que hace con
    // una matriz de forma equivocada.
    bool fromJson(const json& j, size_t dim) {
        if (!j.is_object() || !j.contains("mean") || !j.contains("var")) return false;
        auto m = j["mean"].get<std::vector<double>>();
        auto v = j["var"] .get<std::vector<double>>();
        if (m.size() != dim || v.size() != dim) return false;
        for (double q : m) if (!std::isfinite(q)) return false;
        for (double q : v) if (!std::isfinite(q) || q < 0.0) return false;
        mean = std::move(m); var = std::move(v);
        n = j.value("n", (long long)0);
        // Archivo anterior a la ventana lenta: sus estadísticas son las de la
        // última hora, con alfa 0,001. Se retoma desde ESE alfa (1/1000) y decae
        // de ahí, en vez de saltar de golpe a 1/n con n en las decenas de miles.
        n_lento = j.value("n_lento", std::min(n, (long long)(1.0 / ALPHA)));
        if (n_lento < 1 && n > 0) n_lento = 1;
        return true;
    }
};

// LEGADO — ya no lo usa ninguna red (ver RunningNorm arriba). Se conserva
// porque sigue siendo correcto para lo que sí es un embedding homogéneo.
inline std::vector<double> normalize_zscore(const std::vector<double>& v) {
    if (v.empty()) return v;
    double mean=0; for(double x:v) mean+=x; mean/=v.size();
    double sd=0; for(double x:v) sd+=(x-mean)*(x-mean); sd=std::sqrt(sd/v.size());
    if(sd==0) sd=1.0;
    std::vector<double> out(v.size());
    for(size_t i=0;i<v.size();i++) out[i]=(v[i]-mean)/sd;
    return out;
}

inline std::vector<double> resize_vec(const std::vector<double>& v, size_t n) {
    std::vector<double> out(n,0.0);
    for(size_t i=0;i<std::min(v.size(),n);i++) out[i]=v[i];
    return out;
}

// ── ARCHIVOS EN ANILLO (1-oct-2026) ──────────────────────────────────────
// class27 escribía un archivo por reflexión (`reflection_<ms>.json`) y class28
// uno por evento (`conciencia_<ticks>.json`), con el reloj en el nombre: cada
// escritura creaba un archivo NUEVO y nadie los borraba. Medido en el server el
// 1-oct: **1.351.589 archivos y 5,3 GB** sólo en `snapshots/`. Nadie los lee:
// son rastro para depurar.
//
// Ahora el nombre lleva un CASILLERO (contador % tope) en vez del reloj, así
// que la carpeta queda acotada a `tope` archivos por prefijo y los nuevos pisan
// a los más viejos. El más reciente se reconoce por la fecha de modificación.
//
//   tope = 0  → no se escribe nada.
//
// Si la carpeta no existe se la vuelve a crear: el 26-sep se borró
// `json_guardados/` con el sistema corriendo y, como los módulos sólo la crean
// al arrancar, las escrituras fallaron en silencio desde ese día.
inline int tope_archivos(const char* variable, int defecto) {
    if (const char* e = std::getenv(variable)) {
        try {
            const int v = std::stoi(e);
            if (v >= 0 && v <= 100000) return v;
        } catch (...) {}
    }
    return defecto;
}

inline fs::path ruta_en_anillo(const fs::path& dir, const std::string& prefijo,
                               uint64_t n, int tope) {
    return dir / (prefijo + std::to_string(n % (uint64_t)std::max(1, tope)) + ".json");
}

inline bool escribir_en_anillo(const fs::path& dir, const std::string& prefijo,
                               std::atomic<uint64_t>& contador, int tope,
                               const std::string& contenido) {
    if (tope <= 0) return false;
    const fs::path p = ruta_en_anillo(dir, prefijo, contador.fetch_add(1), tope);
    try {
        std::ofstream f(p);
        if (!f) {                                   // ¿se borró la carpeta en caliente?
            std::error_code ec;
            fs::create_directories(dir, ec);
            f.open(p);
            if (!f) return false;
        }
        f << contenido;
        return true;
    } catch (...) { return false; }
}

// ── REPASO DE EJEMPLOS VIEJOS (experience replay) — 5-oct-2026 ────────────
// class23 y class24 entrenan EN LÍNEA: cada ejemplo nuevo mueve los pesos y
// nada vuelve a mostrarles lo que vieron antes. sim26 midió la consecuencia:
// cuando el mercado cambia de régimen y vuelve, las dos redes arrancan
// ordenando AL REVÉS (class24 −0,45, class23 −0,14 en las primeras 5 ruedas).
// Aprender el régimen nuevo pisa el viejo.
//
// El depósito guarda, por red, UN ejemplo por (instrumento, día) con su
// etiqueta, y por cada ejemplo nuevo que se entrena se repasa uno viejo sacado
// al azar. Tres reglas, y las tres importan:
//
//   1. Sólo días ANTERIORES al del ejemplo que se está entrenando. Repasar el
//      día de hoy no es memoria: es duplicar la tasa sobre el día, que es justo
//      lo que hacía a class24 memorizar el día (la tasa se bajó el 1-oct).
//   2. Un ejemplo por (red, instrumento, día). Los ~380 vectores de un
//      instrumento en una rueda llevan LA MISMA etiqueta: guardar todos sería
//      guardar la misma información 380 veces.
//   3. Tope por red con muestreo de reservorio: al llenarse, cada ejemplo nuevo
//      reemplaza a uno al azar con probabilidad tope/vistos. Así el depósito
//      sigue siendo una muestra pareja de TODA la historia —incluidos los
//      regímenes viejos, que son lo que se quiere recordar—, y no sólo de los
//      últimos días como haría una cola FIFO.
//
// No es thread-safe por sí mismo: se usa bajo el mutex de las redes.
struct DepositoRepaso {
    struct Ejemplo {
        std::vector<double> x;      // vector YA NORMALIZADO, como se entrenó
        double              y = 0;  // etiqueta: 1 = le ganó al promedio
        std::string         sym;
        int64_t             dia = 0;  // día UTC de la decisión (epoch / 86.400.000)
    };
    struct PorRed {
        std::vector<Ejemplo> ej;
        uint64_t ofrecidos = 0;       // para el reservorio
    };

    std::unordered_map<std::string, PorRed> redes;
    std::unordered_map<std::string, int64_t> recientes;   // "red|sym|dia" → dia
    size_t   tope = 10000;
    // Un repaso cada `cada` ejemplos nuevos. Elegido con sim26 (5-oct-2026),
    // corriendo las redes reales con este depósito:
    //   cada 1 → retiene más al volver un régimen, pero al final de un régimen
    //            largo ordena PEOR (class24 0,68 → 0,35): el pasado le tira.
    //   cada 4 → class23 mejora en todo (ciclo 0,48 → 0,52, vuelve el régimen
    //            −0,14 → +0,33); class24 queda neutra en el ciclo (0,46 → 0,44)
    //            y retiene algo mejor (−0,45 → −0,28).
    int      cada = 4;
    uint64_t nuevos = 0;
    uint64_t agregados = 0, reemplazados = 0, repasados = 0, sin_viejos = 0;
    std::mt19937_64 rng{20261012};

    static int64_t diaDe(int64_t ts_ms) { return ts_ms / 86400000LL; }

    // ¿A este ejemplo nuevo le toca repaso? Uno cada `cada`.
    bool toca() { return (nuevos++ % (uint64_t)std::max(1, cada)) == 0; }

    // Devuelve true si el ejemplo entró (nuevo o por reservorio).
    bool agregar(const std::string& red, const std::string& sym, int64_t dia,
                 const std::vector<double>& x, double y) {
        if (tope == 0 || x.empty()) return false;
        const std::string k = red + "|" + sym + "|" + std::to_string(dia);
        if (recientes.count(k)) return false;
        recientes[k] = dia;
        // La clave sólo hace falta para los días que todavía pueden recibir
        // feedback (~3 días). Se poda para que no crezca para siempre.
        if (recientes.size() > 20000) {
            int64_t mx = 0;
            for (const auto& [_, d] : recientes) mx = std::max(mx, d);
            for (auto it = recientes.begin(); it != recientes.end(); )
                it = (it->second < mx - 10) ? recientes.erase(it) : std::next(it);
        }
        auto& pr = redes[red];
        pr.ofrecidos++;
        if (pr.ej.size() < tope) {
            pr.ej.push_back({x, y, sym, dia});
            agregados++;
            return true;
        }
        const uint64_t j = rng() % pr.ofrecidos;
        if (j < tope) {
            pr.ej[(size_t)j] = {x, y, sym, dia};
            reemplazados++;
            return true;
        }
        return false;
    }

    // Un ejemplo al azar de esta red, de un día ANTERIOR a `dia`. nullptr si no hay.
    const Ejemplo* sortear(const std::string& red, int64_t dia) {
        auto it = redes.find(red);
        if (it == redes.end() || it->second.ej.empty()) { sin_viejos++; return nullptr; }
        const auto& v = it->second.ej;
        // Hasta 8 intentos al azar; casi siempre alcanza con uno, porque los
        // días anteriores son la enorme mayoría del depósito.
        for (int t = 0; t < 8; t++) {
            const Ejemplo& e = v[(size_t)(rng() % v.size())];
            if (e.dia < dia) { repasados++; return &e; }
        }
        sin_viejos++;
        return nullptr;
    }

    size_t total() const {
        size_t n = 0;
        for (const auto& [_, pr] : redes) n += pr.ej.size();
        return n;
    }

    json toJson() const {
        json r = json::object();
        for (const auto& [red, pr] : redes) {
            json arr = json::array();
            for (const auto& e : pr.ej)
                arr.push_back({{"x", e.x}, {"y", e.y}, {"s", e.sym}, {"d", e.dia}});
            r[red] = {{"ofrecidos", pr.ofrecidos}, {"ej", arr}};
        }
        return {{"version", 1}, {"tope", tope}, {"redes", r}};
    }

    // Carga lo que haya; un ejemplo con forma rara se descarta, no se usa a medias.
    // `dims` dice la dimensión de cada red viva: un ejemplo de otra dimensión no
    // se puede repasar en esa red.
    size_t fromJson(const json& j, const std::unordered_map<std::string, int>& dims) {
        size_t n = 0;
        if (j.value("version", 0) != 1 || !j.contains("redes") || !j["redes"].is_object()) return 0;
        for (auto& [red, pj] : j["redes"].items()) {
            auto d = dims.find(red);
            if (d == dims.end() || !pj.contains("ej") || !pj["ej"].is_array()) continue;
            auto& pr = redes[red];
            pr.ofrecidos = pj.value("ofrecidos", (uint64_t)0);
            for (const auto& e : pj["ej"]) {
                if (pr.ej.size() >= tope) break;
                // Cada ejemplo en su propio try: un valor con el tipo equivocado
                // hace tirar a nlohmann, y sin esto UN ejemplo roto vaciaba el
                // depósito entero (lo encontró sim29).
                try {
                    std::vector<double> x = e.value("x", std::vector<double>{});
                    if ((int)x.size() != d->second) continue;
                    bool finito = true;
                    for (double v : x) if (!std::isfinite(v)) { finito = false; break; }
                    if (!finito) continue;
                    const double y = e.value("y", -1.0);
                    if (y < 0.0 || y > 1.0) continue;
                    Ejemplo ej{std::move(x), y, e.value("s", std::string("")), e.value("d", (int64_t)0)};
                    recientes[red + "|" + ej.sym + "|" + std::to_string(ej.dia)] = ej.dia;
                    pr.ej.push_back(std::move(ej));
                    n++;
                } catch (...) { continue; }
            }
            pr.ofrecidos = std::max<uint64_t>(pr.ofrecidos, pr.ej.size());
        }
        return n;
    }
};

// Variables de entorno del repaso, iguales en class23 y class24.
//   CLASS2X_REPASO=0          → apagado (el comportamiento anterior, exacto)
//   CLASS2X_REPASO_TOPE=N     → ejemplos por red (por defecto 10.000)
inline bool repaso_activo(const char* variable) {
    const char* e = std::getenv(variable);
    return !(e && std::string(e) == "0");
}

// Lee CLASS2X_REPASO y CLASS2X_REPASO_TOPE. `prefijo` = "CLASS23" o "CLASS24".
inline void configurar_repaso(const std::string& prefijo, const char* tag,
                              DepositoRepaso& dep, bool& activo) {
    activo = repaso_activo((prefijo + "_REPASO").c_str());
    if (const char* e = std::getenv((prefijo + "_REPASO_TOPE").c_str())) {
        try {
            const long v = std::stol(e);
            if (v >= 100 && v <= 200000) dep.tope = (size_t)v;
            else spdlog::warn("[{}] {}_REPASO_TOPE={} fuera de [100,200000] — se ignora",
                              tag, prefijo, v);
        } catch (...) {}
    }
    if (const char* e = std::getenv((prefijo + "_REPASO_CADA").c_str())) {
        try {
            const int v = std::stoi(e);
            if (v >= 1 && v <= 100) dep.cada = v;
            else spdlog::warn("[{}] {}_REPASO_CADA={} fuera de [1,100] — se ignora", tag, prefijo, v);
        } catch (...) {}
    }
    if (activo)
        spdlog::info("[{}] 🔁 repaso ACTIVO: un ejemplo viejo cada {} nuevos, tope {} por red "
                     "({}_REPASO=0 lo apaga)", tag, dep.cada, dep.tope, prefijo);
    else
        spdlog::warn("[{}] ⚠️ repaso APAGADO por {}_REPASO=0 — entrenamiento como antes del "
                     "5-oct", tag, prefijo);
}

// La línea del heartbeat. Prefijo FIJO «repaso:», lo parsea el chequeo diario.
//   ejemplos     = lo que hay hoy en el depósito (todas las redes)
//   agregados    = ejemplos nuevos que entraron sin reemplazar a nadie
//   reemplazados = entradas por reservorio, con el depósito lleno
//   repasados    = pasos de repaso hechos desde el arranque
//   sin_viejos   = pedidos de repaso sin un día anterior disponible (al arrancar, normal)
inline std::string linea_repaso(const DepositoRepaso& d, bool activo) {
    std::ostringstream s;
    s << "repaso: modo=" << (activo ? "ACTIVO" : "APAGADO")
      << " ejemplos=" << d.total() << " redes=" << d.redes.size()
      << " agregados=" << d.agregados << " reemplazados=" << d.reemplazados
      << " repasados=" << d.repasados << " sin_viejos=" << d.sin_viejos
      << " cada=" << d.cada << " tope=" << d.tope;
    return s.str();
}

// Escritura atómica, igual que los pesos. El json se arma bajo el lock (rápido)
// y se escribe afuera, para no frenar al entrenamiento con E/S de disco.
inline void guardar_repaso(const fs::path& archivo, const DepositoRepaso& dep,
                           std::mutex& mtx, const char* tag) {
    if (archivo.empty()) return;
    try {
        json j; size_t n;
        { std::lock_guard<std::mutex> lk(mtx); j = dep.toJson(); n = dep.total(); }
        fs::path tmp = archivo; tmp += ".tmp";
        { std::ofstream out(tmp); if (!out) return; out << j.dump(); }
        fs::rename(tmp, archivo);
        spdlog::info("[{}] 💾 repaso guardado: {} ejemplos → {}", tag, n,
                     archivo.filename().string());
    } catch (const std::exception& e) {
        spdlog::warn("[{}] no se pudo guardar el repaso: {}", tag, e.what());
    }
}

inline void cargar_repaso(const fs::path& archivo, DepositoRepaso& dep,
                          const std::unordered_map<std::string, int>& dims, const char* tag) {
    if (archivo.empty() || !fs::exists(archivo)) {
        spdlog::info("[{}] repaso: sin depósito previo — arranca vacío", tag);
        return;
    }
    try {
        std::ifstream in(archivo); json j; in >> j;
        const size_t n = dep.fromJson(j, dims);
        spdlog::info("[{}] 💾 repaso restaurado: {} ejemplos en {} redes", tag, n, dep.redes.size());
    } catch (const std::exception& e) {
        spdlog::warn("[{}] repaso ilegible ({}) — arranca vacío", tag, e.what());
    }
}

inline std::string fnv1a(const std::string& s) {
    uint64_t h=14695981039346656037ULL;
    for(unsigned char c:s){h^=c;h*=1099511628211ULL;}
    std::stringstream ss; ss<<std::hex<<h; return ss.str();
}

inline void init_logger(const std::string& name, const std::string& logFile) {
    try {
        auto con  = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
        auto file = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(logFile,5*1024*1024,3);
        auto logger = std::make_shared<spdlog::logger>(name,spdlog::sinks_init_list{con,file});
        logger->set_level(spdlog::level::info);
        logger->set_pattern("[%Y-%m-%d %H:%M:%S] [%^%l%$] %v");
        spdlog::set_default_logger(logger);
    } catch(...) { spdlog::set_pattern("[%Y-%m-%d %H:%M:%S] [%^%l%$] %v"); }
}

inline std::unique_ptr<Redis> connect_redis(const std::string& tag, int retries=3) {
    for(int i=0;i<retries;i++){
        try{
            sw::redis::ConnectionOptions o;
            o.host="127.0.0.1"; o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);
            o.socket_timeout=std::chrono::milliseconds(5000);
            auto r=std::make_unique<Redis>(o); r->ping();
            spdlog::info("[{}] ✅ Redis conectado",tag); return r;
        }catch(const std::exception& e){
            spdlog::warn("[{}] Redis intento {}/{}: {}",tag,i+1,retries,e.what());
            if(i<retries-1) std::this_thread::sleep_for(std::chrono::seconds(3));
        }
    }
    return nullptr;
}

inline void publish_ready(Redis& r, const std::string& src, const std::string& ch) {
    try{
        json m={{{"source",src},{"type",src+"_ready"},{"canal",ch},{"ts",now_iso()}}};
        r.publish(src+"_ready",m.dump());
        spdlog::info("[{}] 📡 {}_ready publicado",src,src);
    }catch(...){}
}
