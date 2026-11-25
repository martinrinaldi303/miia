// class22.cpp — Filtro Rígido v2.1
// ============================================================
// ORDEN 3 (v2.2) — EMA POR INSTRUMENTO
//
//   `promedios` era UNA sola deque para los 13 instrumentos. evaluar()
//   encadenaba contra promedios.back() sin mirar de qué ticker venía el
//   vector, así que la EMA mezclaba XLK, ILF, EWZ… en una única serie.
//
//   Con RIGIDEZ=0.8 dos valores consecutivos son casi idénticos, o sea que
//   XLK e ILF recibían prácticamente EL MISMO número. class22 publicaba el
//   ticker correcto (ORDEN 1 propagó bien) y class25A lo metía en la ventana
//   del instrumento correcto — pero el VALOR era modo común.
//
//   Eso es el 25% del voto de cada decisión. En una predicción TRANSVERSAL
//   ("¿este instrumento le gana al promedio de los 13?") un término idéntico
//   para los 13 no aporta nada al ranking: solo diluye el 50% que sí podría
//   discriminar. ORDEN 1 se diseñó para producir 13 muestras independientes
//   y esto les inyectaba un componente compartido.
//
//   Ahora: `promedios[ticker]`, una cadena de rigidez por instrumento.
//
// CAMBIOS vs v2.0:
//   1. UMBRAL: 0.5 → 0.30
//      con score_ajustado = previo*0.8 + conf*0.2 y conf≈0.48
//      el score converge a ~0.48 después de varios mensajes
//      con umbral 0.50 nunca pasa; con 0.30 pasa correctamente
//   2. Acepta type="vector" además de type="analysis"
//      class19 manda type="vector" → antes rechazaba TODO
//   3. Extrae vector del campo "vector" directo (class19/class10)
//      además del formato antiguo data.items[].embedding
//   4. Usa campo "confianza" del envelope si existe
//   5. Cuenta total correctamente (antes solo contaba si había items[])
// Entrada: class22_ingest | Salida: class22_output
// ============================================================

#include "miia_common.h"
#include <map>
static constexpr const char* TAG    = "class22";
static constexpr const char* CH_IN  = "class22_ingest";
static constexpr const char* CH_OUT = "class22_output";

static constexpr double RIGIDEZ  = 0.8;
static constexpr double UMBRAL   = 0.30;  // FIX: era 0.5
static constexpr int    MAX_HIST = 100;

struct State {
    mutable std::mutex   mtx;
    // ORDEN 3: una cadena de rigidez POR INSTRUMENTO (antes: una sola global).
    std::map<std::string,std::deque<double>> promedios;
    std::atomic<uint64_t> total{0},ok{0};

    // Mismo tope y criterio que MAX_VENTANAS de class25A / MAX_TICKERS de class21.
    static constexpr size_t MAX_TICKERS = 64;
};

// Formula de rigidez: ajustado = previo * rigidez + nuevo * (1 - rigidez)
// `ticker` selecciona la cadena: sin esto la EMA mezclaba los 13 instrumentos.
static double evaluar(double prom_nuevo, State& st, const std::string& ticker) {
    if(!std::isfinite(prom_nuevo)) return 0.0;

    // Una sola sección crítica: leer el previo y escribir el ajustado tienen
    // que ser atómicos entre sí, si no dos mensajes del MISMO ticker pueden
    // intercalarse y encadenar contra un previo que ya quedó viejo.
    std::lock_guard<std::mutex> lk(st.mtx);

    auto it = st.promedios.find(ticker);
    if(it == st.promedios.end()){
        if(st.promedios.size() >= State::MAX_TICKERS){
            static bool avisado=false;
            if(!avisado){
                avisado=true;
                spdlog::warn("[{}] ⚠️ {} instrumentos simultáneos — se ignoran tickers "
                             "nuevos. Revisar qué llega de class19.",TAG,State::MAX_TICKERS);
            }
            return 0.0;   // < UMBRAL → el llamador lo descarta
        }
        it = st.promedios.emplace(ticker,std::deque<double>{}).first;
    }
    auto& serie = it->second;

    const double previo   = serie.empty() ? prom_nuevo : serie.back();
    double       ajustado = previo * RIGIDEZ + prom_nuevo * (1.0 - RIGIDEZ);
    if(!std::isfinite(ajustado)) ajustado = 0.0;

    serie.push_back(ajustado);
    if((int)serie.size() > MAX_HIST) serie.pop_front();
    return ajustado;
}

// Calcula promedio de valores absolutos del vector
static double prom_abs(const std::vector<double>& vec) {
    if(vec.empty()) return 0.0;
    double s=0.0;
    for(double x:vec) s+=std::abs(x);
    return s/vec.size();
}

int main() {
    std::signal(SIGINT,miia_signal); std::signal(SIGTERM,miia_signal);
    fs::path base=fs::current_path()/".."/  "operador"/"aprendizaje";
    try{fs::create_directories(base/"logs");}catch(...){}
    init_logger(TAG,(base/"logs"/"class22.log").string());
    spdlog::info("[{}] ══ Filtro Rígido | rigidez={} umbral={} ══",TAG,RIGIDEZ,UMBRAL);
    spdlog::info("[{}] {} → {}",TAG,CH_IN,CH_OUT);
    spdlog::info("[{}] Acepta: type=vector|analysis, campo: vector|data.items[].embedding",TAG);

    auto pub=connect_redis(TAG);
    if(!pub){spdlog::error("[{}] Sin Redis.",TAG);return 1;}
    publish_ready(*pub,TAG,CH_IN);
    State st;

    std::thread hb([&](){
        while(g_running.load()){
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if(!g_running.load()) break;
            size_t nt; {std::lock_guard<std::mutex> lk(st.mtx); nt=st.promedios.size();}
            spdlog::info("[{}] ❤️  total={} ok={} tickers={}",
                TAG,st.total.load(),st.ok.load(),nt);
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

                    // ── FIX: acepta type="vector" y type="analysis" ───────
                    std::string type_val=j.value("type",std::string(""));
                    bool es_vector   = (type_val=="vector");
                    bool es_analysis = (type_val=="analysis");
                    if(!es_vector && !es_analysis) return;

                    // ── Extraer vector y confianza ────────────────────────
                    std::vector<double> vec;
                    std::string entrada=j.value("origen",
                        j.value("fuente",
                        j.value("source",std::string("unknown"))));

                    // ── ORDEN 1: símbolo del instrumento ──────────────────
                    // OJO: `entrada` es el ORIGEN ("class10_vectorial"), y se
                    // venía publicando como data.symbol — otra de las vías por
                    // las que el ticker real nunca llegaba a class25A.
                    const json dS = (j.contains("data")&&j["data"].is_object())
                                    ? j["data"] : json::object();
                    std::string sym = j.value("symbol",
                                      j.value("ticker",
                                      dS.value("symbol",
                                      dS.value("ticker",std::string("")))));
                    if(sym.empty()||sym=="unknown"||sym.rfind("class",0)==0)
                        sym="GENERAL";

                    // ── FLUJO A: formato class19 — campo "vector" directo ─
                    if(j.contains("vector")&&j["vector"].is_array()){
                        vec=sanitize(j["vector"]);
                        // usar confianza del envelope si la tiene
                        double conf_env=0.0;
                        if(j.contains("confianza")&&j["confianza"].is_number())
                            conf_env=j["confianza"].get<double>();
                        else
                            conf_env=prom_abs(vec);
                        conf_env=std::max(0.0,std::min(1.0,conf_env));

                        st.total++;
                        double score=evaluar(conf_env,st,sym);

                        if(score<UMBRAL){
                            spdlog::debug("[{}] Rechazado score={:.3f} < {}",TAG,score,UMBRAL);
                            return;
                        }
                        st.ok++;

                        json payload={
                            {"id",make_id(TAG)},
                            {"source",TAG},
                            {"type","analysis"},
                            {"text","Evaluación rígida para "+entrada},
                            {"fuente",j.value("fuente",std::string("desconocido"))},
                            {"origen",j.value("origen",std::string("desconocido"))},
                            {"symbol",sym},
                            {"ticker",sym},
                            {"data",{
                                {"symbol",sym},
                                {"ticker",sym},
                                {"origen_motor",entrada},
                                {"vector",vec},
                                {"confianza_raw",conf_env},
                                {"rigidez",RIGIDEZ},
                                {"score",score}
                            }},
                            {"confianza",score},
                            {"ts",now_iso()},
                            {"final",true}
                        };
                        pub->publish(CH_OUT,payload.dump());
                        spdlog::info("[{}] 📤 → {} score={:.3f} conf_env={:.3f}",
                            TAG,CH_OUT,score,conf_env);
                        return;
                    }

                    // ── FLUJO B: formato antiguo — data.items[].embedding ─
                    if(!j.contains("data")||!j["data"].is_object()) return;
                    auto& d=j["data"];
                    if(!d.contains("items")||!d["items"].is_array()) return;

                    for(auto& item:d["items"]){
                        // extraer embedding o vector del item
                        if(item.contains("embedding"))
                            vec=sanitize(item["embedding"]);
                        else if(item.contains("vector"))
                            vec=sanitize(item["vector"]);
                        if(vec.empty()) continue;

                        std::string src=item.value("source",
                            item.value("id",std::string("unknown")));

                        double prom=prom_abs(vec);
                        st.total++;
                        // FLUJO B es el formato legado (data.items[].embedding).
                        // `src` es el id/source del item, NO un ticker real, así
                        // que va a su propia cadena "GENERAL" y no contamina la
                        // de ningún instrumento.
                        double score=evaluar(prom,st,"GENERAL");

                        if(score<UMBRAL){
                            spdlog::debug("[{}] Rechazado score={:.3f}",TAG,score);
                            continue;
                        }
                        st.ok++;

                        json payload={
                            {"id",make_id(TAG)},
                            {"source",TAG},
                            {"type","analysis"},
                            {"text","Evaluación rígida para "+src},
                            {"data",{
                                {"symbol",src},
                                {"vector",vec},
                                {"rigidez",RIGIDEZ},
                                {"score",score}
                            }},
                            {"confianza",score},
                            {"ts",now_iso()},
                            {"final",true}
                        };
                        pub->publish(CH_OUT,payload.dump());
                        spdlog::info("[{}] 📤 → {} score={:.3f}",TAG,CH_OUT,score);
                    }
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