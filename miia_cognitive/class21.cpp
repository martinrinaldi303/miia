// class21.cpp — Filtro Cognitivo Adaptativo v2.2
// ============================================================
// ORDEN 3 (v2.2) — ESTADO POR INSTRUMENTO
//
//   El estado era GLOBAL: un solo `umbral`, un solo `histBool` y un solo
//   `histVec` de 10 vectores para los 13 instrumentos entrelazados.
//
//   Consecuencia medida sobre el código: `estabilidad(histVec)` está
//   documentada como estabilidad TEMPORAL del instrumento, pero con 13
//   tickers compartiendo un buffer de 10, los vectores previos al de XLK
//   son casi todos de OTROS instrumentos. O sea: medía cuánto se parecen
//   los 13 entre sí AHORA — dispersión transversal, no estabilidad. Y con
//   el signo al revés de lo que sirve: cuando la sección transversal se
//   abre (que es cuando hay señal relativa que capturar), estab BAJA y
//   class21 castiga.
//
//   Desde ORDEN 1 el sistema predice "¿este instrumento le gana al
//   promedio de los 13?". Un componente común a los 13 no aporta al
//   ranking: solo diluye. class21 pesa 25% del ensemble de class25A.
//
//   Ahora: `porTicker[sym]` con su propio umbral, histBool y histVec.
//   El umbral adaptativo pasa a ser por instrumento, así que cada uno
//   necesita sus 200 muestras — adapta 13× más lento, que es lo correcto
//   (antes un instrumento con caudal alto movía el umbral de todos).
//
// CAMBIOS vs v2.0:
//   1. umbral inicio: 0.70 → 0.35
//      antes los vectores de mercado (conf≈0.48) nunca pasaban
//   2. umbral mínimo en adaptar(): 0.50 → 0.20
//      permite que el sistema baje el umbral mientras aprende
//   3. Pesos score: conf*0.50+estab*0.30+coher*0.20
//               → conf*0.65+estab*0.25+coher*0.10
//      en mercados reales el texto es mínimo, la confianza
//      numérica es la señal más fiable
//   4. Usa campo "confianza" del envelope si existe
//      (class10 ya lo calcula correctamente = dims_activas/64)
//   5. Acepta type="vector" además de type="analysis"
//   6. Extrae vector de campo "vector" directo (formato class19)
//      además del formato antiguo data.items[].embedding
// Entrada: class21_ingest | Salida: class21_output
// ============================================================

#include "miia_common.h"
#include <map>
static constexpr const char* TAG   = "class21";
static constexpr const char* CH_IN = "class21_ingest";
static constexpr const char* CH_OUT= "class21_output";

// Estado de UN instrumento. Ver la nota de ORDEN 3 en la cabecera.
struct TickerState {
    double                          umbral = 0.35;  // FIX v2.1: era 0.70
    std::deque<bool>                histBool;
    std::deque<std::vector<double>> histVec;
    double                          avgScore = 0.0;
};

struct State {
    mutable std::mutex                 mtx;
    // std::map (no unordered_map) a propósito: la inserción no invalida
    // punteros a los elementos existentes.
    std::map<std::string,TickerState>  porTicker;
    std::atomic<uint64_t>              total{0},ok{0},rej{0};

    // Tope de instrumentos vivos. El universo son 13 + GENERAL; 64 deja
    // margen para tickers del chat sin permitir crecimiento sin límite si
    // aguas arriba empieza a llegar basura. Mismo criterio que MAX_VENTANAS
    // de class25A.
    static constexpr size_t MAX_TICKERS = 64;

    // Devuelve nullptr si se alcanzó el tope. Llamar con mtx TOMADO.
    TickerState* obtener(const std::string& tk) {
        auto it = porTicker.find(tk);
        if(it != porTicker.end()) return &it->second;
        if(porTicker.size() >= MAX_TICKERS) return nullptr;
        return &porTicker[tk];
    }
};

// Adaptación del umbral, POR INSTRUMENTO. Llamar con mtx TOMADO.
static void adaptarLocked(TickerState& ts, const std::string& tk) {
    if((int)ts.histBool.size()<200) return;
    int n=(int)std::count(ts.histBool.begin(),ts.histBool.end(),true);
    double tasa=(double)n/ts.histBool.size();
    if(tasa>0.80) ts.umbral=std::min(0.90,ts.umbral+0.05);
    else if(tasa<0.30) ts.umbral=std::max(0.20,ts.umbral-0.05);  // FIX: mínimo 0.20 era 0.50
    ts.histBool.clear();
    spdlog::info("[{}] 🔧 {} umbral→{:.3f} tasa={:.1f}%",TAG,tk,ts.umbral,tasa*100);
}

// ── class21 SIEMPRE le habla a class25A — 27-sep-2026 ────────
//
// EL DEFECTO. class21 publicaba SÓLO cuando `score >= umbral` y descartaba el
// resto en silencio. Medido en el chequeo del 27-sep: `total=108933 ok=71232`,
// o sea que **se callaba en el 34,6 % de los vectores**. Y en el muestreo de
// 300 s del bus se vio el efecto directo:
//
//     class22_output 15 msgs · class23_output 15 · class24_output 15
//     class21_output 12 msgs      ← falta en 1 de cada 5 ventanas
//
// POR QUÉ IMPORTA, y no es cosmético. class25A cierra la ventana de un
// instrumento cuando junta CUATRO módulos:
//
//     completa = (mods.size() >= 4);          // class25A.cpp
//
// Si class21 no publica, la ventana **no completa nunca** y se cierra por
// TIMEOUT a los 5 s (`VENTANA_MS`), decidiendo con TRES módulos. Con el voto
// parejo por módulo, sacar uno cambia el z del ensamble — no agrega ruido,
// cambia la decisión. Y la capa 2 sólo reparte crédito entre las redes
// PRESENTES, así que class21 tampoco aprende de esas ventanas.
//
// Lo peor es QUIÉN elige esas ventanas: el umbral adaptativo de class21, que
// está en 0,768 de un techo de 0,90, aplicado a un score
// `conf*0,65 + estab*0,25 + coher*0,10` donde `coher` era una CONSTANTE (ver
// «Coherencia con el dominio financiero» en miia_common.h). O sea: la
// composición del ensamble que decide BUY/SELL variaba según un umbral movido
// en parte por un término sin información.
//
// EL ARREGLO. El juicio de class21 viaja como DATO (`pasa`, `umbral_propio`) en
// vez de como silencio. class25A recibe siempre sus cuatro votos, las ventanas
// dejan de vencer por timeout esperándolo, y no se pierde nada: quien quiera el
// filtro lo lee en `pasa`.
//
// `total` y `ok` NO cambian de significado —`ok` sigue contando los que pasan su
// umbral— así que la sección 8 del chequeo se sigue leyendo igual.
//
// ⚠️ ESTO CAMBIA DECISIONES, y por eso se anota: las ventanas que hoy deciden
// con 3 módulos van a decidir con 4. Es un arreglo de defecto, no una función
// nueva, así que viaja ENCENDIDO —igual que el defecto 10 y el ranking— con
// `CLASS21_SOLO_APROBADOS=1` para volver al comportamiento viejo sin recompilar.
static bool solo_aprobados_21() {
    static const bool v = [] {
        const char* e = std::getenv("CLASS21_SOLO_APROBADOS");
        return e && std::string(e) == "1";
    }();
    return v;
}

// Fuera del handler para que la simulación la ejercite sin Redis ni main, el
// mismo criterio que `recolectarLote` en class23/class24.
static json armarSalida21(const std::string& texto, const std::string& sym,
                          const std::string& fuente, const std::string& origen,
                          const std::vector<double>& vec,
                          double conf, double estab, double coher,
                          double score, double umb, bool pasa, uint64_t total) {
    const std::string nivel = score >= 0.70 ? "ALTA_CONFIANZA"
                            : score >= 0.45 ? "CONFIANZA_MEDIA"
                                            : "CONFIANZA_BAJA";
    return json{
        {"id",make_id(TAG)},
        {"source",TAG},
        {"type","analysis"},
        {"texto",texto},
        {"text",texto},
        {"modulo","CognitiveFilter"},
        {"fuente",fuente},
        {"origen",origen},
        // ── ORDEN 1: ticker del instrumento ──────────────
        // Sin esto, las señales de class21 caían todas en la
        // ventana "GENERAL" de class25A y las ventanas POR
        // TICKER nunca juntaban sus 4 redes: solo class23 y
        // class24 llevan símbolo. Se completarían siempre por
        // timeout y con medio ensemble.
        {"symbol",sym},
        {"ticker",sym},
        {"senal",nivel},
        {"confianza",score},
        {"score",score},
        // El juicio del filtro, como dato y no como silencio.
        {"pasa",pasa},
        {"umbral_propio",umb},
        {"data",{
            {"vector",vec},
            {"meta",{
                {"confianza_raw",conf},
                {"estabilidad",estab},
                {"coherencia",coher},
                {"umbral",umb},
                {"pasa",pasa},
                {"total",total}
            }}
        }},
        {"ts",now_iso()},
        {"final",true}
    };
}

// La simulación incluye este .cpp con -DMIIA_SIN_MAIN para ejercitar
// armarSalida21() y la coherencia sin arrancar el proceso ni Redis.
#ifndef MIIA_SIN_MAIN
int main() {
    std::signal(SIGINT,miia_signal); std::signal(SIGTERM,miia_signal);
    fs::path base=fs::current_path()/".."/  "operador"/"aprendizaje";
    try{fs::create_directories(base/"logs");}catch(...){}
    init_logger(TAG,(base/"logs"/"class21.log").string());
    spdlog::info("[{}] ══ Filtro Adaptativo | {} → {} ══",TAG,CH_IN,CH_OUT);
    spdlog::info("[{}] umbral_inicio=0.35 umbral_min=0.20 pesos=conf*0.65+estab*0.25+coher*0.10",TAG);

    auto pub=connect_redis(TAG);
    if(!pub){spdlog::error("[{}] Sin Redis.",TAG);return 1;}
    publish_ready(*pub,TAG,CH_IN);
    State st;

    std::thread hb([&](){
        while(g_running.load()){
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if(!g_running.load()) break;
            // Ya no hay UN umbral: se informa la media y el rango sobre los
            // instrumentos vivos, para que un outlier no quede escondido.
            double umin=1e9,umax=-1e9,usum=0; size_t nt=0;
            {
                std::lock_guard<std::mutex> lk(st.mtx);
                for(const auto& kv : st.porTicker){
                    const double u=kv.second.umbral;
                    usum+=u; umin=std::min(umin,u); umax=std::max(umax,u); nt++;
                }
            }
            if(nt==0){umin=umax=0.0;}
            spdlog::info("[{}] ❤️  total={} ok={} tickers={} umbral med={:.3f} [{:.3f}..{:.3f}]",
                TAG,st.total.load(),st.ok.load(),nt,
                nt?usum/(double)nt:0.0,umin,umax);
        }
    });
    hb.detach();

    while(g_running.load()){
        try{
            sw::redis::ConnectionOptions o;
            o.host="127.0.0.1";o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);
            o.socket_timeout=std::chrono::seconds(0);
            Redis subR(o); auto sub=subR.subscriber();

            sub.on_message([&](std::string /*ch*/,std::string raw){
                try{
                    auto j=json::parse(raw);
                    if(j.value("source","")==TAG) return;

                    // ── FIX: aceptar type="vector" y type="analysis" ──────
                    std::string type_val=j.value("type",std::string(""));
                    bool es_vector   = (type_val=="vector");
                    bool es_analysis = (type_val=="analysis");
                    if(!es_vector && !es_analysis) return;

                    // ── Extraer vector ────────────────────────────────────
                    std::vector<double> vec;
                    std::string texto=j.value("texto",j.value("text",std::string("")));

                    // Formato nuevo class19: campo "vector" directo
                    if(j.contains("vector")&&j["vector"].is_array()){
                        vec=sanitize(j["vector"]);
                    }
                    // Formato antiguo: data.items[].embedding o data.vector
                    else if(j.contains("data")&&j["data"].is_object()){
                        auto& d=j["data"];
                        if(d.contains("items")&&d["items"].is_array()){
                            for(auto& it:d["items"]){
                                if(it.contains("embedding"))
                                    vec=sanitize(it["embedding"]);
                                else if(it.contains("vector"))
                                    vec=sanitize(it["vector"]);
                                texto=it.value("text",it.value("texto",texto));
                                if(!vec.empty()) break;
                            }
                        } else if(d.contains("vector"))
                            vec=sanitize(d["vector"]);
                        else if(d.contains("embedding"))
                            vec=sanitize(d["embedding"]);
                    }
                    if(vec.empty()) return;

                    // ── ORDEN 1: símbolo del instrumento ──────────────────
                    const json dS = (j.contains("data")&&j["data"].is_object())
                                    ? j["data"] : json::object();
                    std::string sym = j.value("symbol",
                                      j.value("ticker",
                                      dS.value("symbol",
                                      dS.value("ticker",std::string("")))));
                    if(sym.empty()||sym=="unknown"||sym.rfind("class",0)==0)
                        sym="GENERAL";

                    // ── FIX: usar confianza del envelope si existe ────────
                    // class10 calcula dims_activas/64 que es más fiable que avg_abs
                    double conf;
                    if(j.contains("confianza")&&j["confianza"].is_number())
                        conf=j["confianza"].get<double>();
                    else
                        conf=avg_abs(vec);
                    // Clamp a [0,1]
                    conf=std::max(0.0,std::min(1.0,conf));

                    // ── ORDEN 3: estabilidad y umbral del PROPIO instrumento ──
                    double estab,umb;
                    {
                        std::lock_guard<std::mutex> lk(st.mtx);
                        TickerState* ts = st.obtener(sym);
                        if(!ts){
                            static bool avisado=false;
                            if(!avisado){
                                avisado=true;
                                spdlog::warn("[{}] ⚠️ {} instrumentos simultáneos — se ignoran "
                                             "tickers nuevos. Revisar qué llega de class19.",
                                             TAG,State::MAX_TICKERS);
                            }
                            return;
                        }
                        estab=estabilidad(ts->histVec);
                        umb  =ts->umbral;
                    }

                    // ── FIX: pesos ajustados para señal de mercado ────────
                    // texto de market es mínimo → menos peso a coher
                    double coher=coherencia_jaccard(texto);
                    double score=conf*0.65+estab*0.25+coher*0.10;

                    {
                        std::lock_guard<std::mutex> lk(st.mtx);
                        auto it = st.porTicker.find(sym);
                        if(it != st.porTicker.end()){
                            TickerState& ts = it->second;
                            ts.histVec.push_back(vec);
                            if((int)ts.histVec.size()>10) ts.histVec.pop_front();
                            ts.histBool.push_back(score>=umb);
                            ts.avgScore=ts.avgScore*0.9+score*0.1;
                            // Adaptar acá, bajo el MISMO lock: antes era una
                            // llamada suelta al final del handler que volvía a
                            // tomar el mutex.
                            adaptarLocked(ts,sym);
                        }
                    }

                    st.total++;
                    const bool pasa = (score>=umb);
                    if(pasa) st.ok++; else st.rej++;

                    // Ver «class21 SIEMPRE le habla a class25A», arriba.
                    if(pasa || !solo_aprobados_21()){
                        json env = armarSalida21(
                            texto, sym,
                            j.value("fuente",std::string("desconocido")),
                            j.value("origen",std::string("desconocido")),
                            vec, conf, estab, coher, score, umb, pasa,
                            st.total.load());
                        pub->publish(CH_OUT,env.dump());
                        if(pasa)
                            spdlog::info("[{}] 📤 {} {} score={:.3f} conf={:.3f} estab={:.3f} coher={:.3f}",
                                TAG,env["senal"].get<std::string>(),sym,score,conf,estab,coher);
                        else
                            spdlog::debug("[{}] 📤 {} NO pasa ({:.3f} < {:.3f}) — se manda igual, "
                                          "class25A necesita sus 4 módulos",TAG,sym,score,umb);
                    } else {
                        spdlog::debug("[{}] ↩ Rechazado y NO publicado (modo legado) "
                                      "score={:.3f} < umbral={:.3f}",TAG,score,umb);
                    }
                    // adaptar() ya corrió arriba, dentro del lock del registro.
                }catch(const json::exception& e){
                    spdlog::warn("[{}] JSON: {}",TAG,e.what());
                }catch(...){}
            });

            sub.subscribe(CH_IN);
            spdlog::info("[{}] 📡 Suscrito a {}",TAG,CH_IN);
            while(g_running.load()) sub.consume();
        }catch(const std::exception& e){
            if(g_running.load()){
                spdlog::warn("[{}] {}",TAG,e.what());
                std::this_thread::sleep_for(std::chrono::seconds(3));
            }
        }
    }
    return 0;
}
#endif  // MIIA_SIN_MAIN
