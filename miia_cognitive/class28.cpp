// class28.cpp — Conciencia Operativa Extendida
// Entradas: class21-24_output, class25_output
// Salidas: class25_ingest, ui_stream, class27_input, class28_output

#include "miia_common.h"
static constexpr const char* TAG      = "class28";
static constexpr const char* CH_OUT25 = "class25_ingest";
static constexpr const char* CH_UI    = "ui_stream";
static constexpr const char* CH_OUT27 = "class27_input";
static constexpr const char* CH_OUT28 = "class28_output";
static const std::vector<std::string> CH_IN = {
    "class21_output","class22_output","class23_output","class24_output","class25_output"
};

struct Asoc{std::string causa,efecto,ts;int fuerza=1;};

struct State28{
    mutable std::mutex     mtx;
    std::deque<json>       eventos;
    std::vector<Asoc>      asocs;
    std::set<std::string>  hashes;
    std::atomic<uint64_t>  total{0};
};

static fs::path MEM_FILE;
// Cuántos `conciencia_*.json` quedan en disco (en anillo; ver miia_common.h).
// Antes era un archivo por evento, sin tope. `CLASS28_JSON_MAX` lo cambia; 0 =
// no escribir ninguno.
static int g_json_max = 200;
static std::atomic<uint64_t> g_json_n{0};

static void guardar(const std::vector<Asoc>& v){
    try{json a=json::array();for(auto& x:v)a.push_back({{"causa",x.causa},{"efecto",x.efecto},{"fuerza",x.fuerza},{"ts",x.ts}});std::ofstream f(MEM_FILE);f<<a.dump(2);}catch(...){}
}
static void cargar(std::vector<Asoc>& v){
    try{if(!fs::exists(MEM_FILE))return;std::ifstream f(MEM_FILE);auto a=json::parse(f);for(auto& x:a)v.push_back({x.value("causa",""),x.value("efecto",""),x.value("ts",""),x.value("fuerza",1)});spdlog::info("[{}] 🧠 {} asociaciones",TAG,v.size());}catch(...){}
}

static bool esFinanciero(const std::string& s){
    static const std::vector<std::string> kw={"crisis","mercado","riesgo","financiero","inversion","inclusivo","oportunidad"};
    std::string sl;for(char c:s)sl+=(char)std::tolower(c);
    for(auto& k:kw)if(sl.find(k)!=std::string::npos)return true;
    return false;
}

static void analizar(State28& st,Redis& pub,const fs::path& jsonDir){
    std::lock_guard<std::mutex> lk(st.mtx);
    if((int)st.eventos.size()<2)return;
    auto& ul=st.eventos.back();auto& pr=st.eventos[st.eventos.size()-2];
    std::string causa=pr.value("type",pr.value("source",std::string("?")));
    std::string efecto=ul.value("type",ul.value("source",std::string("?")));
    if(causa.empty()||efecto.empty()||causa==efecto)return;
    Asoc* found=nullptr;
    for(auto& a:st.asocs)if(a.causa==causa&&a.efecto==efecto){found=&a;break;}
    if(!found){st.asocs.push_back({causa,efecto,now_iso(),1});found=&st.asocs.back();spdlog::info("[{}] 🔗 {}→{}",TAG,causa,efecto);}
    else{found->fuerza++;found->ts=now_iso();spdlog::info("[{}] 💪 {}→{} f={}",TAG,causa,efecto,found->fuerza);}
    bool coh=esFinanciero(causa)||esFinanciero(efecto);
    try{
        json s={{"ts",now_iso()},{"causa",causa},{"efecto",efecto},{"coherente",coh},{"fuerza",found->fuerza},{"veredicto",coh?"✅ Alineado.":"⚠️ No alineado."}};
        escribir_en_anillo(jsonDir,"conciencia_",g_json_n,g_json_max,s.dump(2));
        json env={{"id",make_id(TAG)},{"source",TAG},{"type","cognitive"},{"text",causa+"→"+efecto},{"data",s},{"ts",now_iso()},{"final",true}};
        pub.publish(CH_OUT25,env.dump());pub.publish(CH_OUT28,env.dump());
        json pulse={{"type","cognitive_pulse"},{"color",coh?"#00ff99":"#ff6666"},{"label",causa+"→"+efecto},{"intensity",std::min(1.0,found->fuerza/10.0)}};
        pub.publish(CH_UI,pulse.dump());
        if(!coh){json al={{"id",make_id(TAG)},{"source",TAG},{"type","alert_incoherence"},{"text","Incoherencia detectada"},{"data",s},{"ts",now_iso()}};pub.publish(CH_OUT27,al.dump());}
    }catch(const std::exception& e){spdlog::warn("[{}] Publish: {}",TAG,e.what());}
}

int main(){
    std::signal(SIGINT,miia_signal);std::signal(SIGTERM,miia_signal);
    fs::path base=fs::current_path()/".."/  "operador"/"aprendizaje";
    fs::path jdir=base/"json_guardados";
    MEM_FILE=base/"conciencia_memoria.json";
    try{fs::create_directories(base/"logs");fs::create_directories(jdir);}catch(...){}
    init_logger(TAG,(base/"logs"/"class28.log").string());
    spdlog::info("[{}] ══ Conciencia Operativa ══",TAG);
    g_json_max=tope_archivos("CLASS28_JSON_MAX",g_json_max);
    spdlog::info("[{}] 🗂️  json en anillo: {} archivos como máximo",TAG,g_json_max);
    auto pub=connect_redis(TAG);if(!pub){spdlog::error("[{}] Sin Redis.",TAG);return 1;}
    publish_ready(*pub,TAG,CH_IN[0]);
    State28 st;cargar(st.asocs);

    std::thread per([&](){int t=0;while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(20));if(!g_running.load())break;if(++t%6==0){std::lock_guard<std::mutex> lk(st.mtx);if(!st.asocs.empty()){int c=0;for(auto& a:st.asocs)if(esFinanciero(a.causa+a.efecto))c++;spdlog::info("[{}] 🪞 {}/{} alineadas",TAG,c,(int)st.asocs.size());try{json m={{"type","self_evaluation"},{"alignment",100.0*c/st.asocs.size()},{"total",(int)st.asocs.size()}};pub->publish(CH_UI,m.dump());}catch(...){}guardar(st.asocs);}}}}); per.detach();
    std::thread hb([&](){while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(30));if(!g_running.load())break;size_t e,a;{std::lock_guard<std::mutex> lk(st.mtx);e=st.eventos.size();a=st.asocs.size();}spdlog::info("[{}] ❤️  ev={} asoc={}",TAG,e,a);}}); hb.detach();

    while(g_running.load()){
        try{
            sw::redis::ConnectionOptions o;o.host="127.0.0.1";o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);o.socket_timeout=std::chrono::seconds(0);
            Redis subR(o);auto sub=subR.subscriber();
            sub.on_message([&](std::string /*ch*/,std::string raw){
                try{
                    auto j=json::parse(raw);if(j.value("source","")==TAG)return;
                    std::string h=fnv1a(raw);{std::lock_guard<std::mutex> lk(st.mtx);if(st.hashes.count(h))return;st.hashes.insert(h);if(st.hashes.size()>5000)st.hashes.clear();}
                    {std::lock_guard<std::mutex> lk(st.mtx);st.eventos.push_back(j);if((int)st.eventos.size()>300)st.eventos.pop_front();}
                    st.total++;analizar(st,*pub,jdir);
                }catch(...){}
            });
            for(auto& c:CH_IN)sub.subscribe(c);
            spdlog::info("[{}] ✅ Suscrito a {} canales",TAG,(int)CH_IN.size());
            while(g_running.load())sub.consume();
        }catch(const std::exception& e){if(g_running.load()){spdlog::warn("[{}] {}",TAG,e.what());std::this_thread::sleep_for(std::chrono::seconds(3));}}
    }
    guardar(st.asocs);return 0;
}
