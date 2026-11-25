// ============================================================
// sim7_defecto10.cpp — prueba del DEFECTO 10
// ============================================================
//
// Qué prueba:
//
//   class23 y class24 guardaban sus predicciones en un mapa `pending` con la
//   hora pero SIN el instrumento. Cuando llegaba un resultado de class43, el
//   emparejamiento era sólo por hora: se llevaba hasta 50 vectores de la
//   ventana de 15 min —de CUALQUIER instrumento— y los entrenaba a todos con
//   la etiqueta de esa única decisión. El vector de XLK aprendía el resultado
//   de XLE.
//
//   Consecuencia: la red no puede aprender a distinguir instrumentos. Lo único
//   que puede aprender es la etiqueta promedio del momento — una señal de
//   tiempo, no de corte transversal. Y es justo lo transversal lo que se le
//   pregunta («¿este instrumento le gana al promedio?»).
//
//   Peor: las decisiones GENERAL son `absoluto` («¿subió el mercado?») y cada
//   una se llevaba hasta 50 vectores por instrumento. El 18-sep el 98 % de lo
//   que entrenó class24 en rueda llevó etiqueta 0.
//
// Cómo lo prueba: incluye el .cpp DE PRODUCCIÓN con -DMIIA_SIN_MAIN y llama a
// `recolectarLote()` tal cual la llama el feedback. No reimplementa la lógica.
//
//   bash docs/simulaciones/build_sim7.sh
//
// El mismo archivo prueba los dos módulos: -DTESTEAR_CLASS23 cambia el objetivo.

#include <cstdio>
#include <fstream>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#ifdef TESTEAR_CLASS23
  #include "../../miia_cognitive/class23.cpp"
  using Estado = State23;
  using Lote   = LoteFB23;
  #define MODULO      "class23"
  #define RECOLECTAR  recolectarLote23
  #define PENDIENTES  pendientes
  #define TOPE_LOTE   MAX_LOTE_FB23
  static void meter(Estado& st, const std::string& id, const std::string& key,
                    const std::vector<double>& x, const std::string& sym, int64_t ts) {
      st.pendientes[id] = State23::Pend{ key, x, ts, sym };
  }
#else
  #include "../../miia_cognitive/class24.cpp"
  using Estado = State24;
  using Lote   = LoteFB;
  #define MODULO      "class24"
  #define RECOLECTAR  recolectarLote
  #define PENDIENTES  pending
  #define TOPE_LOTE   MAX_LOTE_FB
  static void meter(Estado& st, const std::string& id, const std::string& key,
                    const std::vector<double>& x, const std::string& sym, int64_t ts) {
      st.pending[id] = PendingEntry{ x, ts, key, sym };
  }
#endif

// Los 13 del universo, más el agregado.
static const std::vector<std::string> UNIV = {
    "XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU","XLC","ARGT","EWZ","ILF"
};

static int fallos = 0;
static void chequear(const char* que, bool ok, const std::string& detalle = "") {
    std::printf("   %s %-58s %s\n", ok ? "[ok]" : "[NO]", que, detalle.c_str());
    if (!ok) fallos++;
}

// El ticker viaja DENTRO del vector (primer elemento = índice en UNIV, o -1
// para GENERAL). Es la única forma de verificar, desde el lote devuelto, de
// qué instrumento era cada vector: `lote` sólo trae (clave_de_red, vector).
static std::vector<double> vectorDe(const std::string& sym, int dim = 32) {
    std::vector<double> v(dim, 0.1);
    double marca = -1.0;
    for (size_t i = 0; i < UNIV.size(); ++i) if (UNIV[i] == sym) marca = (double)i;
    v[0] = marca;
    return v;
}
static std::string simboloDe(const std::vector<double>& v) {
    if (v.empty() || v[0] < 0) return "GENERAL";
    return UNIV[(size_t)(v[0] + 0.5)];
}

int main(int argc, char** argv) {
    spdlog::set_level(spdlog::level::off);   // el test habla, el módulo no

    const int64_t DTS   = 1758400000000LL;   // instante de la decisión
    const int64_t DESDE = DTS - 900000;      // la ventana real del código
    const int64_t HASTA = DTS + 120000;

    // Una rueda real: ~600 predicciones en la ventana de 15 min repartidas
    // entre los 13 instrumentos (~46 cada uno), más GENERAL, más vectores
    // FUERA de la ventana que no debe tocar nadie.
    const int POR_TICKER = 46;
    const int FUERA      = 40;

    std::printf("\n=== %s — DEFECTO 10 =========================================\n", MODULO);

    Estado st;
    int n_dentro = 0;
    for (size_t t = 0; t < UNIV.size(); ++t)
        for (int k = 0; k < POR_TICKER; ++k, ++n_dentro)
            meter(st, UNIV[t] + "#" + std::to_string(k), "mercado|32",
                  vectorDe(UNIV[t]), UNIV[t], DTS - 60000 - (k * 1000));
    for (int k = 0; k < POR_TICKER; ++k, ++n_dentro)
        meter(st, "GENERAL#" + std::to_string(k), "mercado|32",
              vectorDe("GENERAL"), "GENERAL", DTS - 60000 - (k * 1000));
    for (int k = 0; k < FUERA; ++k)
        meter(st, "viejo#" + std::to_string(k), "mercado|32",
              vectorDe("XLK"), "XLK", DESDE - 600000 - (k * 1000));

    const size_t total_inicial = st.PENDIENTES.size();
    std::printf("   pending inicial: %zu vectores (%d en ventana, %d fuera)\n\n",
                total_inicial, n_dentro, FUERA);

    // ── 1 · Un feedback de XLK se lleva SÓLO los de XLK ───────────────────
    std::printf("1 · Feedback de XLK\n");
    Lote r = RECOLECTAR(st, "XLK", DTS, DESDE, HASTA);

    int ajenos = 0;
    std::set<std::string> vistos;
    for (auto& [clave, x] : r.lote) { vistos.insert(simboloDe(x)); if (simboloDe(x) != "XLK") ajenos++; }
    chequear("el lote trae sólo vectores de XLK", ajenos == 0,
             ajenos ? std::to_string(ajenos) + " ajenos" : "");
    chequear("un solo instrumento en el lote", vistos.size() == 1,
             "instrumentos: " + std::to_string(vistos.size()));
    chequear("se llevó los 46 de XLK que estaban en ventana",
             (int)r.lote.size() == POR_TICKER,
             "lote=" + std::to_string(r.lote.size()));

    // ── 2 · Los de otros instrumentos quedan INTACTOS ─────────────────────
    // Es la mitad que importa: antes se los llevaba puestos el primer feedback
    // que cayera en la ventana, y se perdían para su propia etiqueta.
    const int esperados_ajenos = POR_TICKER * (int)(UNIV.size() - 1) + POR_TICKER; // 12 tickers + GENERAL
    std::printf("\n2 · Los demás instrumentos\n");
    chequear("contó los que estaban en ventana y no eran suyos",
             r.otro_ticker == esperados_ajenos,
             "otro_ticker=" + std::to_string(r.otro_ticker) +
             " esperado=" + std::to_string(esperados_ajenos));
    chequear("siguen en pending, no se borraron",
             st.PENDIENTES.size() == total_inicial - POR_TICKER,
             "pending=" + std::to_string(st.PENDIENTES.size()) +
             " esperado=" + std::to_string(total_inicial - POR_TICKER));
    int quedan_xlk_ventana = 0;
    for (auto& [id, p] : st.PENDIENTES)
        if (p.symbol == "XLK" && p.ts_ms >= DESDE && p.ts_ms <= HASTA) quedan_xlk_ventana++;
    chequear("no quedó ningún XLK sin consumir en la ventana", quedan_xlk_ventana == 0);

    // ── 3 · Lo de afuera de la ventana no se toca ─────────────────────────
    int fuera_quedan = 0;
    for (auto& [id, p] : st.PENDIENTES) if (p.ts_ms < DESDE) fuera_quedan++;
    std::printf("\n3 · Fuera de la ventana\n");
    chequear("los 40 vectores viejos de XLK siguen ahí", fuera_quedan == FUERA,
             "quedan=" + std::to_string(fuera_quedan));

    // ── 4 · GENERAL sólo se lleva GENERAL ─────────────────────────────────
    // Es la contaminación que midió el 18-sep: una etiqueta «¿subió el
    // mercado?» que se llevaba 50 vectores de instrumentos.
    std::printf("\n4 · Feedback de GENERAL (etiqueta `absoluto`)\n");
    Lote g = RECOLECTAR(st, "GENERAL", DTS, DESDE, HASTA);
    int g_ajenos = 0;
    for (auto& [clave, x] : g.lote) if (simboloDe(x) != "GENERAL") g_ajenos++;
    chequear("no se lleva ni un vector de instrumento", g_ajenos == 0,
             g_ajenos ? std::to_string(g_ajenos) + " ajenos" : "");
    chequear("se lleva los 46 vectores GENERAL", (int)g.lote.size() == POR_TICKER,
             "lote=" + std::to_string(g.lote.size()));

    // ── 5 · canonSymbol: los dos lados hablan el mismo idioma ─────────────
    std::printf("\n5 · Forma canónica del instrumento\n");
    chequear("\"class19\" -> GENERAL", canonSymbol("class19") == "GENERAL");
    chequear("\"CLASS19\" -> GENERAL", canonSymbol("CLASS19") == "GENERAL");
    chequear("\"\" -> GENERAL",        canonSymbol("")        == "GENERAL");
    chequear("\"unknown\" -> GENERAL", canonSymbol("unknown") == "GENERAL");
    chequear("\"XLK\" se respeta",     canonSymbol("XLK")     == "XLK");

    // ── 6 · Cuánto contaminaba la regla vieja ─────────────────────────────
    // La vieja tomaba hasta MAX_LOTE_FB de la ventana sin mirar el ticker.
    // Con 13 instrumentos + GENERAL repartidos parejo, la proporción de
    // vectores ajenos que entrenaba con una etiqueta que no era la suya es
    // 1 − 1/14.
    std::printf("\n6 · La regla vieja, para tener la referencia\n");
    const double ajena = 1.0 - 1.0 / (double)(UNIV.size() + 1);
    std::printf("   con %zu instrumentos + GENERAL en la ventana, de cada 50 vectores\n"
                "   que tomaba un feedback, ~%.0f eran de OTRO instrumento (%.0f %%)\n",
                UNIV.size(), 50.0 * ajena, 100.0 * ajena);
    std::printf("   y además se los borraba: perdían su propia etiqueta.\n");

    // ── 7 · EL CONTRATO con class43, con el payload REAL ─────────────────
    // Acá no se inventa el mensaje: se lee el que capturó sim8 ejecutando los
    // dos caminos de verificación de class43. Si alguien renombra `ticker` o
    // `label_modo` en class43.js, sim8 lo captura con el nombre nuevo y esta
    // sección se pone en rojo — en vez de que el entrenamiento se apague en
    // silencio y nos enteremos tres semanas después por el heartbeat.
    std::printf("\n7 · Contrato con class43 (payload capturado por sim8)\n");
    {
        const char* ruta = (argc > 1) ? argv[1]
                         : "docs/simulaciones/datos/feedback_class43.json";
        std::ifstream f(ruta);
        if (!f) {
            std::printf("   [NO] no se pudo abrir %s\n", ruta);
            std::printf("        corre antes: node docs/simulaciones/sim8_contrato_feedback.js\n");
            fallos++;
        } else {
            json datos; f >> datos;
            const auto& casos = datos.at("casos");
            chequear("sim8 capturo los cuatro casos", casos.size() == 4,
                     "casos=" + std::to_string(casos.size()));
            for (const auto& c : casos) {
                const std::string nombre  = c.value("caso", std::string("?"));
                const json&       payload = c.at("payload");
                const GuardFB     g       = evaluarFeedback(payload);
                const std::string cruda   = payload.value("ticker", std::string("?"));
                chequear((nombre.substr(0, 38) + " -> aceptado").c_str(), g.acepta,
                         "sym=" + g.sym + " modo=" + g.modo);
                chequear((nombre.substr(0, 38) + " -> mismo ticker").c_str(),
                         g.sym == canonSymbol(cruda));
            }

            // Y los dos modos de rotura, sobre el MISMO payload real.
            json roto = casos.at(0).at("payload");
            roto.erase("ticker");
            const GuardFB g1 = evaluarFeedback(roto);
            chequear("sin `ticker` -> rechazado por SinTicker",
                     !g1.acepta && g1.motivo == MotivoFB::SinTicker);

            json roto2 = casos.at(0).at("payload");
            roto2["ticker"]     = "XLK";
            roto2["label_modo"] = "absoluto";
            const GuardFB g2 = evaluarFeedback(roto2);
            chequear("ticker real con `absoluto` -> rechazado por NoRelativo",
                     !g2.acepta && g2.motivo == MotivoFB::NoRelativo);

            json gen = casos.at(0).at("payload");
            gen["ticker"] = "GENERAL"; gen["label_modo"] = "absoluto";
            chequear("GENERAL con `absoluto` -> ACEPTADO (es su modo)",
                     evaluarFeedback(gen).acepta);
        }
    }

    // ── 8 · El borde del tope del lote ───────────────────────────────────
    // Un instrumento con más vectores que el tope. Lo que NO puede pasar es
    // que los que sobran se borren: su feedback ya pasó, así que no van a
    // tener otro. Que mueran por TTL es pérdida, pero es pérdida limpia;
    // entrenarlos con la etiqueta de otro seria corrupcion.
    std::printf("\n8 · Borde del tope del lote (tope = %d)\n", TOPE_LOTE);
    {
        Estado st2;
        const int DE_MAS = TOPE_LOTE + 50;
        for (int k = 0; k < DE_MAS; ++k)
            meter(st2, "XLK#" + std::to_string(k), "mercado|32",
                  vectorDe("XLK"), "XLK", DTS - 60000 - (k * 100));
        Lote t = RECOLECTAR(st2, "XLK", DTS, DESDE, HASTA);
        chequear("el lote se corta en el tope", (int)t.lote.size() == TOPE_LOTE,
                 "lote=" + std::to_string(t.lote.size()));
        chequear("cuenta los truncados", t.truncados == DE_MAS - TOPE_LOTE,
                 "truncados=" + std::to_string(t.truncados) +
                 " esperado=" + std::to_string(DE_MAS - TOPE_LOTE));
        chequear("los truncados NO se borran (mueren por TTL, no corrompen)",
                 st2.PENDIENTES.size() == (size_t)(DE_MAS - TOPE_LOTE),
                 "quedan=" + std::to_string(st2.PENDIENTES.size()));
        chequear("con el caudal real de rueda (~43 por ticker) no trunca",
                 43 < TOPE_LOTE, "tope=" + std::to_string(TOPE_LOTE));
    }

    std::printf("\n%s — %s\n\n", fallos == 0 ? "PASA" : "FALLA", MODULO);
    return fallos == 0 ? 0 : 1;
}
