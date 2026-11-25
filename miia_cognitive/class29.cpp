// class29.cpp — Balance Emocional y Cognitivo Global
// Temperatura DSL: "estable"|"alta"|"critica"|"baja" (sin tilde)
// Entradas: class21-24_output, class27_output, class28_output,
//           class7_output, class17_output, ui_stream, class29_input
// Salidas: class29_output, class29_feedback

#include "miia_common.h"
static constexpr const char* TAG        = "class29";
static constexpr const char* CH_OUT     = "class29_output";
static constexpr const char* CH_FEED    = "class29_feedback";
static const std::vector<std::string> CH_IN = {
    "class21_output","class22_output","class23_output","class24_output",
    "class27_output","class28_output","class7_output","class17_output",
    "ui_stream","class29_input"
};

// FUNCIÓN ÚNICA Y CANÓNICA DE TEMPERATURA (igual que el JS corregido)
static std::string calcTemp(double c){
    if(c>=0.85)return "estable";
    if(c>=0.60)return "alta";
    if(c>=0.35)return "critica";  // sin tilde
    return "baja";
}

static std::string calcTend(const std::deque<double>& cohs){
    if((int)cohs.size()<6)return "estable";
    double rec=0,ant=0;auto it=cohs.end();
    for(int i=0;i<3;i++){--it;rec+=*it;}rec/=3;
    for(int i=0;i<3;i++){--it;ant+=*it;}ant/=3;
    double d=rec-ant;
    if(d>0.05)return "subiendo";if(d<-0.05)return "bajando";return "estable";
}

static double cohProm(const std::deque<double>& c){
    if(c.empty())return 1.0;
    double s=std::accumulate(c.begin(),c.end(),0.0);
    return std::round((s/c.size())*1000)/1000.0;
}

struct State29{
    mutable std::mutex mtx;
    std::deque<double> coherencias;
    std::unordered_map<std::string,json> lastMsgs;
    std::set<std::string> processed;
    std::unordered_map<std::string,int> msgPerCh;
    std::atomic<uint64_t> totalMsgs{0};
    int64_t ultimaAct=0,ultimaPub=0;
};

static void publicar(State29& st,Redis& pub,const fs::path& metricsDir){
    
    double cp;std::string temp,tend;int nm;
    {std::lock_guard<std::mutex> lk(st.mtx);cp=cohProm(st.coherencias);temp=calcTemp(cp);tend=calcTend(st.coherencias);nm=(int)st.coherencias.size();}
    json est={{"coherencia",cp},{"temperatura",temp},{"temp_score",cp},{"n_muestras",nm},{"tendencia",tend},
        {"timestamp",(int64_t)std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count()},
        {"ts",now_iso()},{"totalMensajes",(int64_t)st.totalMsgs.load()}};
    json env={{"id",make_id(TAG)},{"source",TAG},{"type","state"},
        {"text","Balance coh:"+std::to_string(cp).substr(0,5)+" temp:"+temp+" tend:"+tend},
        {"data",est},{"ts",now_iso()}};
    try{
        pub.publish(CH_OUT,env.dump());
        spdlog::info("[{}] 🧠 coh:{:.3f} temp:{} tend:{}",TAG,cp,temp,tend);
        if(cp<0.5){
            json al={{"id",make_id(TAG)},{"source",TAG},{"type","metric"},{"text","Coherencia baja ("+std::to_string(cp).substr(0,5)+")"},{"data",{{"valor",cp},{"temperatura",temp}}},{"ts",now_iso()}};
            pub.publish(CH_OUT,al.dump());spdlog::warn("[{}] ⚠️ Coherencia baja: {:.3f}",TAG,cp);
        }
    }catch(const std::exception& e){spdlog::error("[{}] publicar: {}",TAG,e.what());}
    try{std::ofstream f(metricsDir/"class29_balance.json");f<<est.dump(2);}catch(...){}
    {std::lock_guard<std::mutex> lk(st.mtx);st.ultimaPub=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
}

int main(){
    std::signal(SIGINT,miia_signal);std::signal(SIGTERM,miia_signal);
    fs::path base=fs::current_path()/".."/  "operador"/"aprendizaje";
    fs::path mdir=base/"metrics";
    try{fs::create_directories(base/"logs");fs::create_directories(mdir);}catch(...){}
    init_logger(TAG,(base/"logs"/"class29.log").string());
    spdlog::info("[{}] ══ Balance Cognitivo Global | temp: estable|alta|critica|baja ══",TAG);
    auto pub=connect_redis(TAG);if(!pub){spdlog::error("[{}] Sin Redis.",TAG);return 1;}
    publish_ready(*pub,TAG,"class29_input");
    State29 st;

    // Balance cada 20s
    std::thread bal([&](){while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(20));if(!g_running.load())break;publicar(st,*pub,mdir);}});bal.detach();
    // Monitor inactividad cada 90s
    std::thread inact([&](){while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(90));if(!g_running.load())break;int64_t now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();int64_t ua;{std::lock_guard<std::mutex> lk(st.mtx);ua=st.ultimaAct;}if(ua>0&&now-ua>180000){std::lock_guard<std::mutex> lk(st.mtx);st.coherencias.push_back(0.1);if((int)st.coherencias.size()>100)st.coherencias.pop_front();spdlog::warn("[{}] ❄️ Inactividad — coherencia reducida",TAG);}}});inact.detach();
    std::thread hb([&](){while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(30));if(!g_running.load())break;double cp;std::string t;{std::lock_guard<std::mutex> lk(st.mtx);cp=cohProm(st.coherencias);t=calcTemp(cp);}spdlog::info("[{}] ❤️  coh:{:.3f} temp:{} total:{}",TAG,cp,t,st.totalMsgs.load());}});hb.detach();

    while(g_running.load()){
        try{
            sw::redis::ConnectionOptions o;o.host="127.0.0.1";o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);o.socket_timeout=std::chrono::seconds(0);
            Redis subR(o);auto sub=subR.subscriber();
            sub.on_message([&](std::string ch,std::string raw){
                try{
                    auto j=json::parse(raw);if(j.value("source","")==TAG)return;
                    std::string id=j.value("id","");
                    if(!id.empty()){std::lock_guard<std::mutex> lk(st.mtx);if(st.processed.count(id))return;st.processed.insert(id);if(st.processed.size()>5000)st.processed.clear();}
                    st.totalMsgs++;{std::lock_guard<std::mutex> lk(st.mtx);st.msgPerCh[ch]++;}

                    // class29_input: coherencia directa
                    if(ch=="class29_input"){
                        double c=j.value("coherenciaPromedio",1.0);
                        if(!std::isfinite(c))return;
                        c=std::max(0.0,std::min(1.0,c));
                        {std::lock_guard<std::mutex> lk(st.mtx);st.coherencias.push_back(c);if((int)st.coherencias.size()>100)st.coherencias.pop_front();st.ultimaAct=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
                        double cp=cohProm([&]{std::lock_guard<std::mutex> lk(st.mtx);return st.coherencias;}());
                        spdlog::info("[{}] 📡 coh={:.3f} global={:.3f}",TAG,c,cp);
                        if(cp<0.5){
                            double delta=std::round((0.75-cp)*1000)/1000.0;
                            try{json fb={{"id",make_id(TAG)},{"source",TAG},{"type","adjustment"},{"text","Ajuste sugerido"},{"data",{{"delta",delta},{"ts",now_iso()}}},{"ts",now_iso()}};pub->publish(CH_FEED,fb.dump());spdlog::warn("[{}] ⚠️ Ajuste +{:.3f}",TAG,delta);}catch(...){}
                        }
                        return;
                    }

                    // Calcular coherencia si tenemos mercado+portafolio
                    {std::lock_guard<std::mutex> lk(st.mtx);
                     st.lastMsgs[ch]=j;st.ultimaAct=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
                     if(st.lastMsgs.count("class7_output")&&st.lastMsgs.count("class17_output")){
                         try{
                             auto& mkt=st.lastMsgs["class7_output"];auto& pt=st.lastMsgs["class17_output"];
                             double rg=mkt.value("riesgoGlobal",0.5);
                             double rp=0;int n=0;auto port=pt.value("portafolio",json::array());
                             for(auto& a:port){rp+=a.value("peso",0.0);n++;}if(n>0)rp/=n;
                             double coh=1.0-std::abs(rg-rp);coh=std::round(coh*1000)/1000.0;
                             st.coherencias.push_back(coh);if((int)st.coherencias.size()>100)st.coherencias.pop_front();
                         }catch(...){}
                     }
                    }
                }catch(...){}
            });
            for(auto& c:CH_IN)sub.subscribe(c);
            spdlog::info("[{}] ✅ Suscrito a {} canales",TAG,(int)CH_IN.size());
            while(g_running.load())sub.consume();
        }catch(const std::exception& e){if(g_running.load()){spdlog::warn("[{}] {}",TAG,e.what());std::this_thread::sleep_for(std::chrono::seconds(3));}}
    }
    return 0;
}