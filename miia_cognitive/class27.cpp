// class27.cpp — Meta-Introspección Cognitiva
// Entradas: class25_output, class21-24_output, class29_output, class28_output
// Salida: class27_output

#include "miia_common.h"
static constexpr const char* TAG    = "class27";
static constexpr const char* CH_OUT = "class27_output";
static const std::vector<std::string> CH_IN = {
    "class25_output","class21_output","class22_output",
    "class23_output","class24_output","class29_output","class28_output"
};
static constexpr int64_t REFLECTION_TTL = 5*60*1000;
// Cuántas reflexiones quedan en disco (en anillo; ver miia_common.h). Antes era
// un archivo por reflexión, sin tope. `CLASS27_SNAPSHOTS_MAX` lo cambia; 0 = no
// escribir ninguna.
static int g_snap_max = 200;
static std::atomic<uint64_t> g_snap_n{0};

struct Ev { std::string ch,origin,text,summary,type,hash; double certainty=0,coherence=0; std::string ts; };

static Ev normalize(const std::string& ch, const json& j) {
    Ev e; e.ch=ch;
    e.origin=j.value("source",j.value("origen",ch));
    e.text=j.value("texto",j.value("text",j.value("decision",std::string(""))));
    e.type=j.value("type",j.value("tipo",std::string("")));
    e.certainty=j.value("confianza",j.value("score",j.value("certainty",0.0)));
    e.coherence=j.value("coherencia",j.value("coherence",e.certainty));
    e.ts=j.value("ts",now_iso());
    e.summary=e.text.substr(0,std::min((int)e.text.size(),200));
    e.hash=fnv1a(ch+"|"+e.origin+"|"+e.summary);
    return e;
}

static double tokenOv(const std::string& a,const std::string& b){
    auto w=[](const std::string& s){std::set<std::string> ws;std::string c;for(unsigned char x:s){if(std::isalnum(x))c+=(char)std::tolower(x);else{if(!c.empty())ws.insert(c);c.clear();}}if(!c.empty())ws.insert(c);return ws;};
    auto wa=w(a),wb=w(b);if(wa.empty()||wb.empty())return 0.0;
    int inter=0;for(auto& x:wa)if(wb.count(x))inter++;
    int uni=(int)wa.size()+(int)wb.size()-inter;return uni>0?(double)inter/uni:0.0;
}

static double linTrend(const std::deque<double>& v){
    int n=(int)v.size();if(n<2)return 0.0;
    double sx=0,sy=0,sxy=0,sxx=0;
    for(int i=0;i<n;i++){sx+=i;sy+=v[i];sxy+=i*v[i];sxx+=i*i;}
    double d=n*sxx-sx*sx;return d==0?0.0:(n*sxy-sx*sy)/d;
}

struct Pattern{std::string kind,detail;};

static std::vector<Pattern> detect(const std::deque<Ev>& buf){
    std::vector<Pattern> obs;if(buf.empty())return obs;
    auto rec=std::vector<Ev>(buf.size()>20?buf.end()-20:buf.begin(),buf.end());
    std::unordered_map<std::string,int> cnt;
    for(auto& e:rec)cnt[e.summary]++;
    for(auto& [k,c]:cnt)if(c>=4)obs.push_back({"repetition","Repetida ("+std::to_string(c)+"x): "+k});
    if(rec.size()>=2){
        std::string last=rec.back().text,prev;
        for(size_t i=0;i<rec.size()-1;i++)prev+=rec[i].text+" ";
        if(!last.empty()&&!prev.empty()&&tokenOv(last,prev)<0.05)
            obs.push_back({"jump","Salto lógico detectado"});
    }
    std::set<std::string> uniq;for(auto& e:rec)uniq.insert(e.summary);
    if((int)rec.size()>=8&&(int)uniq.size()<=2)obs.push_back({"stagnation","Estancamiento"});
    if(!rec.empty()){
        double ac=0,cc=0;for(auto& e:rec){ac+=e.certainty;cc+=e.coherence;}
        ac/=rec.size();cc/=rec.size();
        if(ac>0.8&&cc<0.4)obs.push_back({"overconfidence","Alta confianza sin coherencia"});
        std::deque<double> cohs;for(auto& e:rec)cohs.push_back(e.coherence);
        if((int)cohs.size()>=5&&linTrend(cohs)<-0.02)obs.push_back({"quality_drop","Coherencia en caída"});
    }
    return obs;
}

struct State27{
    mutable std::mutex mtx;
    std::deque<Ev> buf;
    std::set<std::string> seenMsg;
    std::unordered_map<std::string,int64_t> seenRef;
    std::unordered_map<std::string,int> errCount;
    int selfSeq=0;bool degraded=false;
};

static bool publishRef(Redis& pub,State27& st,const json& ref,const fs::path& snap){
    std::string h=ref.value("hash","");if(h.empty())return false;
    int64_t now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    {std::lock_guard<std::mutex> lk(st.mtx);auto it=st.seenRef.find(h);if(it!=st.seenRef.end()&&(now-it->second)<REFLECTION_TTL)return false;st.seenRef[h]=now;
     // seenRef no se purgaba nunca: una entrada por hash distinto, para siempre.
     // Pasado el TTL la entrada ya no decide nada, así que se puede soltar.
     if(st.seenRef.size()>2000){for(auto i=st.seenRef.begin();i!=st.seenRef.end();){if(now-i->second>=REFLECTION_TTL)i=st.seenRef.erase(i);else ++i;}}}
    try{pub.publish(CH_OUT,ref.dump());}catch(...){return false;}
    escribir_en_anillo(snap,"reflection_",g_snap_n,g_snap_max,ref.dump(2));
    spdlog::info("[{}] 🧠 → {} hash={}",TAG,CH_OUT,h.substr(0,8));
    return true;
}

int main(){
    std::signal(SIGINT,miia_signal);std::signal(SIGTERM,miia_signal);
    fs::path base=fs::current_path()/".."/  "operador"/"aprendizaje";
    fs::path snapDir=base/"snapshots";
    try{fs::create_directories(base/"logs");fs::create_directories(snapDir);}catch(...){}
    init_logger(TAG,(base/"logs"/"class27.log").string());
    spdlog::info("[{}] ══ Meta-Introspección | {} canales ══",TAG,(int)CH_IN.size());
    g_snap_max=tope_archivos("CLASS27_SNAPSHOTS_MAX",g_snap_max);
    spdlog::info("[{}] 🗂️  snapshots en anillo: {} archivos como máximo",TAG,g_snap_max);
    auto pub=connect_redis(TAG);if(!pub){spdlog::error("[{}] Sin Redis.",TAG);return 1;}
    publish_ready(*pub,TAG,CH_IN[0]);
    State27 st;

    std::thread periodic([&](){
        while(g_running.load()){
            std::this_thread::sleep_for(std::chrono::seconds(30));
            if(!g_running.load())break;
            std::deque<Ev> snap_buf;std::unordered_map<std::string,int> ec;bool deg;
            {std::lock_guard<std::mutex> lk(st.mtx);snap_buf=st.buf;ec=st.errCount;deg=st.degraded;if(deg&&st.selfSeq==0){st.degraded=false;deg=false;}}
            auto pts=detect(snap_buf);
            // `kinds` (3-sep-2026): clave legible por máquina, además de la
            // descripción en castellano. Sin esto, class25A tendría que hacer
            // string-matching sobre "Alta confianza sin coherencia" para saber
            // que hubo overconfidence — frágil ante cualquier cambio de texto.
            std::vector<std::string> obs,recs,kinds;
            for(auto& p:pts){obs.push_back(p.detail);kinds.push_back(p.kind);
                if(p.kind=="repetition")recs.push_back("Consolidar resultados repetidos");
                // NOTA: detect() nunca produce kind=="contradiction" — emite
                // repetition | jump | stagnation | overconfidence | quality_drop.
                // Esta rama está muerta; se deja para no cambiar el contrato de
                // `recomendaciones` en el mismo deploy que agrega `kinds`.
                if(p.kind=="contradiction")recs.push_back("Verificación cruzada");
                if(p.kind=="quality_drop")recs.push_back("Evaluar calidad del modelo");
            }
            double ac=0;if(!snap_buf.empty()){for(auto& e:snap_buf)ac+=e.coherence;ac/=snap_buf.size();}
            std::string content;for(auto& x:obs)content+=x;for(auto& x:recs)content+=x;
            json ref={{"ts",now_iso()},{"origen",TAG},{"tipo","reflexion_cognitiva"},{"nivel","meta"},
                {"observaciones",obs},{"kinds",kinds},{"recomendaciones",recs},
                {"incoherencias",json::array()},
                {"alineacion_cerebro",ac},{"modo_degradado",deg},{"hash",fnv1a(content)},{"final",true}};
            try{publishRef(*pub,st,ref,snapDir);}catch(...){}
        }
    });
    periodic.detach();

    std::thread hb([&](){while(g_running.load()){std::this_thread::sleep_for(std::chrono::seconds(60));if(!g_running.load())break;size_t n;{std::lock_guard<std::mutex> lk(st.mtx);n=st.buf.size();}spdlog::info("[{}] ❤️  buf={}",TAG,n);}});
    hb.detach();

    while(g_running.load()){
        try{
            sw::redis::ConnectionOptions o;o.host="127.0.0.1";o.port=6379;
            o.connect_timeout=std::chrono::milliseconds(3000);o.socket_timeout=std::chrono::seconds(0);
            Redis subR(o);auto sub=subR.subscriber();
            sub.on_message([&](std::string ch,std::string raw){
                try{
                    auto j=json::parse(raw);if(j.value("source","")==TAG)return;
                    auto ev=normalize(ch,j);
                    {std::lock_guard<std::mutex> lk(st.mtx);
                     if(st.seenMsg.count(ev.hash))return;st.seenMsg.insert(ev.hash);
                     if(st.seenMsg.size()>5000)st.seenMsg.clear();
                     if(ev.origin==TAG){if(++st.selfSeq>=6)st.degraded=true;return;}
                     st.selfSeq=0;if(st.degraded)return;
                     st.buf.push_back(ev);if((int)st.buf.size()>100)st.buf.pop_front();}
                    std::deque<Ev> buf_copy;{std::lock_guard<std::mutex> lk(st.mtx);buf_copy=st.buf;}
                    auto pts=detect(buf_copy);
                    if(!pts.empty()){
                        std::vector<std::string> obs,kinds;std::string content;
                        for(auto& p:pts){obs.push_back(p.detail);kinds.push_back(p.kind);content+=p.detail;}
                        json ref={{"ts",now_iso()},{"origen",TAG},{"tipo","reflexion_cognitiva"},
                            {"observaciones",obs},{"kinds",kinds},{"hash",fnv1a(content)},{"final",true}};
                        try{publishRef(*pub,st,ref,snapDir);}catch(...){}
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