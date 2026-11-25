// ============================================================
// sim9_ranking.cpp — prueba del RANKING TRANSVERSAL (class25A)
// ============================================================
//
// Qué arregla el ranking, medido el 15-sep-2026:
//
//   **MIIA emitió BUY en los 13 instrumentos a la vez.** En una pregunta
//   relativa eso es contradictorio: no pueden los 13 superar a su propio
//   promedio. La causa está en la decisión — cada instrumento se comparaba
//   contra su propia historia (`g_base`, su z) y NUNCA contra los otros doce.
//   No había sección transversal en ningún punto de la cadena.
//
// Qué prueba este archivo, ejecutando el código real de class25A:
//
//   1. La mezcla sale simétrica por construcción (tantos BUY como SELL).
//   2. **La beta se cancela**: sumarle lo mismo a todos los z —que es lo que
//      hace un movimiento de mercado— no cambia ni un puesto. Es la propiedad
//      que explica el patrón monótono de Q1 a Q4 del beta_test2, y la razón
//      principal para hacer este cambio.
//   3. La confianza por puesto es simétrica: el mejor y el peor dan el mismo
//      número. Arregla que el balde de 48 h fuera todo BUY (23.063 decisiones,
//      ni una SELL).
//   4. Sin sección transversal no se decide (mercado cerrado → HOLD).
//   5. La emisión es ~31 % y no depende del tamaño del universo: con 13 o con
//      100 instrumentos da lo mismo, así que el 12-oct no hay que recalibrar.
//
//   bash docs/simulaciones/build_sim9.sh
//   (o incluido en probar.ps1)

#include <cstdio>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <string>
#include <vector>

#include "../../miia_cognitive/class25A.cpp"

static int fallos = 0;
static void chequear(const char* que, bool ok, const std::string& detalle = "") {
    std::printf("   %s %-56s %s\n", ok ? "[ok]" : "[NO]", que, detalle.c_str());
    if (!ok) fallos++;
}

static void limpiarSeccion() {
    std::lock_guard<std::mutex> lk(g_xsec_mtx);
    g_xsec.clear();
}

// Mete n instrumentos con z = base + i*paso y devuelve el puesto de cada uno.
// Se llama dos veces por instrumento a propósito: la primera vuelta llena la
// sección (los primeros no la ven completa), la segunda es la que se mide.
static std::vector<Puesto> correrVentana(const std::vector<std::string>& tickers,
                                         const std::vector<double>& zs,
                                         int64_t ahora) {
    for (size_t i = 0; i < tickers.size(); ++i) ubicarEnSeccion(tickers[i], zs[i], ahora);
    std::vector<Puesto> out;
    for (size_t i = 0; i < tickers.size(); ++i)
        out.push_back(ubicarEnSeccion(tickers[i], zs[i], ahora));
    return out;
}

static std::string senalDe(const Puesto& p) {
    if (!p.hay) return "HOLD";
    if (p.pos < p.k)             return "BUY";
    if (p.pos >= p.n - p.k)      return "SELL";
    return "HOLD";
}

int main(int argc, char** argv) {
    spdlog::set_level(spdlog::level::off);
    const int64_t T0 = 1758400000000LL;

    std::printf("\n=== class25A — RANKING TRANSVERSAL ==========================\n");

    // ── 1 · Con 13 instrumentos: k=2, mezcla simétrica ───────────────────
    std::printf("\n1 · Universo de 13 instrumentos\n");
    std::vector<std::string> u13 = {"XLK","XLF","XLE","XLV","XLY","XLI","XLB",
                                    "XLRE","XLU","XLC","ARGT","EWZ","ILF"};
    std::vector<double> z13;
    for (size_t i = 0; i < u13.size(); ++i) z13.push_back(-0.6 + 0.1 * (double)i);

    limpiarSeccion();
    auto p13 = correrVentana(u13, z13, T0);

    int buy = 0, sell = 0, hold = 0;
    for (auto& p : p13) {
        const std::string s = senalDe(p);
        if (s == "BUY") buy++; else if (s == "SELL") sell++; else hold++;
    }
    chequear("k = 2 con 13 instrumentos", p13[0].k == 2,
             "k=" + std::to_string(p13[0].k));
    chequear("la mezcla es SIMETRICA (tantos BUY como SELL)", buy == sell,
             "buy=" + std::to_string(buy) + " sell=" + std::to_string(sell) +
             " hold=" + std::to_string(hold));
    chequear("emision ~31 % (objetivo historico 25 %)",
             buy + sell == 4,
             std::to_string((buy + sell) * 100 / 13) + " %");
    chequear("el de z mas alto sale BUY", senalDe(p13.back()) == "BUY");
    chequear("el de z mas bajo sale SELL", senalDe(p13.front()) == "SELL");

    // ── 2 · LA BETA SE CANCELA ───────────────────────────────────────────
    // Un movimiento de mercado le suma lo mismo a todos los z. Con la banda,
    // eso corria el centro y daba vuelta la mezcla (el 15-sep: 76 % SELL en un
    // dia de baja). Con el ranking no puede mover un solo puesto.
    std::printf("\n2 · Beta: sumarle lo mismo a todos no cambia nada\n");
    for (double shock : { +2.0, -2.0, +10.0 }) {
        std::vector<double> z_shock;
        for (double z : z13) z_shock.push_back(z + shock);
        limpiarSeccion();
        auto p_shock = correrVentana(u13, z_shock, T0);
        bool iguales = true;
        for (size_t i = 0; i < p13.size(); ++i)
            if (p13[i].pos != p_shock[i].pos) iguales = false;
        int b2 = 0, s2 = 0;
        for (auto& p : p_shock) {
            const std::string s = senalDe(p);
            if (s == "BUY") b2++; else if (s == "SELL") s2++;
        }
        chequear(("shock de " + std::to_string((int)shock) + " sigma: mismos puestos").c_str(),
                 iguales, "buy=" + std::to_string(b2) + " sell=" + std::to_string(s2));
    }

    // ── 3 · Confianza por puesto: simetrica ──────────────────────────────
    std::printf("\n3 · Confianza por puesto\n");
    {
        const double c_mejor = confianzaPorPuesto(p13.back());
        const double c_peor  = confianzaPorPuesto(p13.front());
        chequear("el mejor y el peor dan la MISMA confianza",
                 std::fabs(c_mejor - c_peor) < 1e-12,
                 "mejor=" + std::to_string(c_mejor).substr(0, 5) +
                 " peor=" + std::to_string(c_peor).substr(0, 5));
        // El del medio: puesto 6 de 13, que es la mediana exacta.
        Puesto medio; medio.hay = true; medio.n = 13; medio.pos = 6;
        chequear("el del medio da 0,5 (sin conviccion)",
                 std::fabs(confianzaPorPuesto(medio) - 0.5) < 1e-12);
        chequear("las puntas dan 1,0 (maxima conviccion)",
                 std::fabs(c_mejor - 1.0) < 1e-12,
                 "= " + std::to_string(c_mejor).substr(0, 5));
        // Ningun puesto puede dar menos de 0,5: es lo que rompia la simetria
        // cuando la confianza era 0.5 + |score - neutro|.
        bool todas_ok = true;
        for (int i = 0; i < 13; ++i) {
            Puesto q; q.hay = true; q.n = 13; q.pos = i;
            const double c = confianzaPorPuesto(q);
            if (c < 0.5 - 1e-12 || c > 1.0 + 1e-12) todas_ok = false;
        }
        chequear("todos los puestos caen en [0,5 , 1]", todas_ok);
    }

    // ── 4 · Sin seccion transversal no se decide ─────────────────────────
    // Es el caso del mercado cerrado: 12 de las 13 ventanas no existen.
    std::printf("\n4 · Sin seccion transversal (mercado cerrado)\n");
    {
        limpiarSeccion();
        std::vector<std::string> pocos = {"XLK", "XLF", "XLE"};
        std::vector<double> zp = { 2.0, 0.0, -2.0 };
        auto pp = correrVentana(pocos, zp, T0);
        chequear("con 3 instrumentos no hay seccion", !pp[0].hay,
                 "n=" + std::to_string(pp[0].n) + " min=" + std::to_string(g_rank_min));
        chequear("y por lo tanto nadie emite",
                 senalDe(pp[0]) == "HOLD" && senalDe(pp[2]) == "HOLD");
    }

    // ── 5 · El agregado nunca participa ──────────────────────────────────
    std::printf("\n5 · El agregado (GENERAL) no emite\n");
    chequear("\"GENERAL\" es agregado",   esAgregado("GENERAL"));
    chequear("\"class19\" es agregado",   esAgregado("class19"));
    chequear("\"CLASS19\" es agregado",   esAgregado("CLASS19"));
    chequear("\"\" es agregado",          esAgregado(""));
    chequear("\"XLK\" NO es agregado",   !esAgregado("XLK"));

    // ── 6 · Escala a 100 instrumentos sin recalibrar ─────────────────────
    std::printf("\n6 · Universo de 100 (lo del 12-oct)\n");
    {
        limpiarSeccion();
        std::vector<std::string> u100; std::vector<double> z100;
        for (int i = 0; i < 100; ++i) {
            u100.push_back("T" + std::to_string(i));
            z100.push_back(-2.0 + 0.04 * i);
        }
        auto p100 = correrVentana(u100, z100, T0);
        int b = 0, s = 0;
        for (auto& p : p100) {
            const std::string sg = senalDe(p);
            if (sg == "BUY") b++; else if (sg == "SELL") s++;
        }
        chequear("k = 15 con 100 instrumentos", p100[0].k == 15,
                 "k=" + std::to_string(p100[0].k));
        chequear("sigue simetrica", b == s,
                 "buy=" + std::to_string(b) + " sell=" + std::to_string(s));
        chequear("la emision no cambia con el tamano del universo",
                 std::abs((b + s) * 100 / 100 - 31) <= 1,
                 std::to_string((b + s)) + " de 100");
    }

    // ── 7 · Los z viejos salen de la seccion ─────────────────────────────
    std::printf("\n7 · Frescura de la seccion (ventana de 15 min)\n");
    {
        limpiarSeccion();
        for (size_t i = 0; i < u13.size(); ++i)
            ubicarEnSeccion(u13[i], z13[i], T0 - 20 * 60 * 1000);   // 20 min antes
        Puesto tarde = ubicarEnSeccion("XLK", 1.0, T0);
        chequear("los z de hace 20 min ya no cuentan", !tarde.hay,
                 "n=" + std::to_string(tarde.n));
    }

    // ── 8 · Empates ──────────────────────────────────────────────────────
    // Desempatar por el nombre del mapa seria una decision alfabetica
    // disfrazada de senal: los empatados comparten el mejor puesto.
    std::printf("\n8 · Empates\n");
    {
        limpiarSeccion();
        std::vector<double> z_emp(u13.size(), 0.5);
        auto pe = correrVentana(u13, z_emp, T0);
        // Los empatados se reparten el puesto PROMEDIO, no el mejor. Con los 13
        // iguales eso los deja a todos en la mediana y NO emite nadie.
        //
        // Compartir el mejor puesto —la regla anterior— hacia que los 13
        // salieran BUY, o sea la patologia del 15-sep ("MIIA emitio BUY en los
        // 13 instrumentos a la vez") reaparecida por otro camino. Lo encontro
        // sim13 corriendo esta misma funcion sobre secciones reales.
        const double mediana = (13 - 1) / 2.0;
        bool todos_mediana = true, nadie_emite = true;
        for (auto& p : pe) {
            if (std::fabs(p.pos - mediana) > 1e-12) todos_mediana = false;
            if (senalDe(p) != "HOLD") nadie_emite = false;
        }
        chequear("13 z identicos quedan todos en la mediana", todos_mediana,
                 "pos=" + std::to_string(pe[0].pos).substr(0, 4));
        chequear("y por lo tanto NO emite ninguno", nadie_emite,
                 "sin dispersion no hay orden");

        // Un empate parcial tampoco regala la punta: dos empatados en los
        // puestos 1 y 2 quedan en 1,5 y ninguno entra en el k=2.
        limpiarSeccion();
        std::vector<double> z_par = z13;
        z_par[11] = z_par[12];                       // los dos mejores, empatados
        auto pp2 = correrVentana(u13, z_par, T0);
        int b2 = 0;
        for (auto& p : pp2) if (senalDe(p) == "BUY") b2++;
        chequear("un empate en la punta no agranda el lado BUY", b2 <= 2,
                 "buy=" + std::to_string(b2));
    }

    // ── 9 · Secciones transversales REALES del volcado ───────────────────
    // Las ocho secciones de arriba son ventanas armadas a mano. Esta corre el
    // mismo codigo sobre lo que MIIA scoreo de verdad, rueda por rueda, sacado
    // del volcado por sim13_ensamble.py.
    //
    // ⚠️ Con un matiz que conviene tener escrito: las filas viejas solo
    // conservan `score_final` (dentro del texto "ensemble=..."), y class25A
    // rankea por `z_ens`. El orden coincide salvo por el refuerzo bayesiano y
    // por el clamp, que no son monotonos. Desde el corte del 12-oct la columna
    // `score` guarda el numero y esto deja de ser una aproximacion.
    if (argc > 1) {
        std::printf("\n9 · Secciones REALES del volcado (%s)\n", argv[1]);
        std::ifstream f(argv[1]);
        if (!f) {
            std::printf("      no se pudo abrir el archivo — se saltea\n");
        } else {
            nlohmann::json j;
            try { f >> j; } catch (const std::exception& e) {
                std::printf("      JSON invalido: %s\n", e.what());
                j = nlohmann::json::object();
            }
            const auto& ruedas = j.value("ruedas", nlohmann::json::array());
            int    con_seccion = 0, simetricas = 0, emitidas = 0, puestos = 0;
            int    beta_iguales = 0, beta_probadas = 0;
            int    con_empate_ok = 0, tot_buy = 0, tot_sell = 0;
            int64_t t = T0;

            for (const auto& r : ruedas) {
                std::vector<std::string> tk;
                std::vector<double>      z;
                for (auto it = r["scores"].begin(); it != r["scores"].end(); ++it) {
                    tk.push_back(it.key());
                    z.push_back(it.value().get<double>());
                }
                if ((int)tk.size() < g_rank_min) continue;
                t += 60 * 60 * 1000;            // una hora entre ruedas: sin arrastre

                limpiarSeccion();
                auto ps = correrVentana(tk, z, t);
                int b = 0, sll = 0;
                for (auto& p : ps) {
                    const std::string sg = senalDe(p);
                    if (sg == "BUY") b++; else if (sg == "SELL") sll++;
                }
                con_seccion++;
                puestos  += (int)tk.size();
                emitidas += b + sll;
                tot_buy  += b;
                tot_sell += sll;
                std::vector<double> ord = z;
                std::sort(ord.begin(), ord.end());
                const bool hay_empate = std::adjacent_find(ord.begin(), ord.end()) != ord.end();
                if (!hay_empate) { con_empate_ok++; if (b == sll) simetricas++; }

                // La beta: el movimiento comun del mercado le suma lo mismo a
                // todos. Es lo que producia el patron monotono de Q1 a Q4.
                std::vector<double> z_shock;
                for (double v : z) z_shock.push_back(v + 0.35);
                limpiarSeccion();
                auto ps2 = correrVentana(tk, z_shock, t);
                bool ig = true;
                for (size_t i = 0; i < ps.size(); ++i)
                    if (ps[i].pos != ps2[i].pos) ig = false;
                beta_probadas++;
                if (ig) beta_iguales++;
            }

            if (con_seccion == 0) {
                std::printf("      ninguna rueda llego a %d instrumentos\n", g_rank_min);
            } else {
                const double emision = 100.0 * emitidas / puestos;
                std::printf("      %d ruedas con seccion · %d instrumentos en total\n",
                            con_seccion, puestos);
                // La simetria perfecta solo se puede exigir SIN empates: con
                // scores repetidos el reparto promedio deja huecos, y forzar
                // BUY = SELL exigiria desempatar por el nombre del mapa, que es
                // una decision alfabetica disfrazada de senal.
                chequear("simetrica en todas las ruedas SIN empates",
                         simetricas == con_empate_ok,
                         std::to_string(simetricas) + "/" + std::to_string(con_empate_ok) +
                         " (" + std::to_string(con_seccion - con_empate_ok) + " ruedas con empate)");
                chequear("y en el agregado BUY y SELL quedan parejos",
                         std::abs(tot_buy - tot_sell) * 20 <= tot_buy + tot_sell,
                         "buy=" + std::to_string(tot_buy) + " sell=" + std::to_string(tot_sell));
                chequear("la emision queda cerca del 31 % estructural",
                         emision > 25.0 && emision < 38.0,
                         std::to_string((int)emision) + " %");
                chequear("un shock de mercado no mueve un solo puesto",
                         beta_iguales == beta_probadas,
                         std::to_string(beta_iguales) + "/" + std::to_string(beta_probadas));
            }
        }
    }

    // ── 10 · El auto-neutro y la capa 1 de atribucion ────────────────────
    std::printf("\n10 · Auto-neutro observado y capa 1 retirada\n");
    {
        chequear("el neutro NO se aplica por defecto", !g_aplicar_neutro,
                 "CLASS25A_APLICAR_NEUTRO=1 lo devuelve");

        // Prueba de comportamiento: mover el neutro no puede cambiar un puesto.
        // Es la razon por la que dejar de aplicarlo no cambia ninguna decision
        // de instrumento.
        const double neutro_previo = g_neutro;
        limpiarSeccion();
        g_neutro = 0.30;
        auto pa = correrVentana(u13, z13, T0);
        limpiarSeccion();
        g_neutro = 0.85;
        auto pb = correrVentana(u13, z13, T0);
        g_neutro = neutro_previo;
        bool mismos = true;
        for (size_t i = 0; i < pa.size(); ++i)
            if (pa[i].pos != pb[i].pos) mismos = false;
        chequear("mover el neutro de 0,30 a 0,85 no mueve un puesto", mismos,
                 "el ranking no lo lee");

        // Guardas de regresion sobre el fuente: lo que sigue no se puede
        // ejercitar sin Redis, asi que se verifica que este escrito.
        std::ifstream f("../../miia_cognitive/class25A.cpp");
        if (!f) f = std::ifstream("miia_cognitive/class25A.cpp");
        std::string src((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
        if (src.empty()) {
            std::printf("      no se pudo leer class25A.cpp — se saltea\n");
        } else {
            const size_t g_ap = src.find("if (g_aplicar_neutro) {");
            const size_t asig = src.find("g_neutro = nuevo;");
            chequear("la asignacion del neutro esta detras de la bandera",
                     g_ap != std::string::npos && asig != std::string::npos &&
                     asig > g_ap && asig - g_ap < 200);

            // DEFECTO 2: la capa 1 usaba la regla vieja (clamp + renormalizar
            // TODO), que tapaba el aprendizaje de la capa 2. sim1 lo midio:
            // separacion 0,000 con ella prendida, 0,339 sin ella.
            const size_t fb = src.find("if (ch == CH_FB) {");
            const size_t fin = src.find("g_pesos.actualizarEvento(ups)", fb);
            const std::string bloque = (fb != std::string::npos && fin != std::string::npos)
                                     ? src.substr(fb, fin - fb) : std::string();
            chequear("el handler de feedback NO llama a actualizarPrefijo",
                     !bloque.empty() &&
                     bloque.find("g_pesos.actualizarPrefijo") == std::string::npos,
                     "la capa 1 esta retirada");
            chequear("y la capa 2 (actualizarEvento) sigue viva",
                     fin != std::string::npos);
            chequear("los feedbacks con `red` quedan CONTADOS",
                     bloque.find("g_fb_con_red++") != std::string::npos,
                     "si class43 vuelve a mandarla, se ve en el heartbeat");
        }
    }

    // ── 11 · La base con olvido (EWMA) ───────────────────────────────────
    // Ejercita observarBase/desvioBase, que son las que corren de verdad. Los
    // valores esperados salen de sim15_base_ewma.py, que es una implementacion
    // SEPARADA en Python: si alguien toca un lado y no el otro, esto se pone en
    // rojo. Comparar el C++ contra si mismo no probaria nada.
    std::printf("\n11 · Base con olvido (EWMA) — contra el modelo de sim15\n");
    {
        const double alpha_previo = g_base_alpha;
        g_base_alpha = 1.0 - std::pow(0.5, 1.0 / 5000.0);

        // Caso A: 30.000 muestras de una sinusoide alrededor de 0,50.
        BaseRed a;
        for (int i = 0; i < 30000; ++i)
            observarBase(a, 0.50 + 0.10 * std::sin(i / 137.0));
        chequear("caso A: la media coincide con sim15",
                 std::fabs(a.media - 0.498926297662) < 1e-9,
                 "media=" + std::to_string(a.media).substr(0, 8));
        chequear("caso A: el desvio coincide con sim15",
                 std::fabs(desvioBase(a) - 0.071023083921) < 1e-9,
                 "desvio=" + std::to_string(desvioBase(a)).substr(0, 8));

        // Caso B: con pocas muestras el alfa efectivo es 1/n, asi que da la
        // media exacta. Sin eso, las primeras muestras arrastrarian el cero
        // inicial y la red no tendria base creible despues de un reinicio.
        BaseRed b;
        for (double x : { 0.7, 0.3, 0.9, 0.1 }) observarBase(b, x);
        chequear("caso B: 4 muestras dan la media exacta, no una atenuada",
                 std::fabs(b.media - 0.5) < 1e-12,
                 "media=" + std::to_string(b.media).substr(0, 6));
        chequear("caso B: el desvio coincide con sim15",
                 std::fabs(desvioBase(b) - 0.316227766017) < 1e-9);

        // Una sola muestra: hay media pero NO hay desvio, asi que la guarda
        // sd > 1e-9 la deja afuera del z. Es lo correcto: con n=1 no se sabe
        // nada de la escala de esa red.
        BaseRed c; observarBase(c, 0.7);
        chequear("con n=1 hay media pero el desvio es 0", 
                 std::fabs(c.media - 0.7) < 1e-12 && desvioBase(c) == 0.0,
                 "no entra al z");

        // Rollback: CLASS25A_BASE_VIDA_MEDIA=0 => alfa 0 => alfa efectivo 1/n
        // siempre => media acumulada exacta, que es el comportamiento viejo.
        // (El desvio queda poblacional en vez de muestral: 1 % de diferencia a
        // las 50 muestras del minimo, y no cambia ninguna decision.)
        g_base_alpha = 0.0;
        BaseRed d;
        for (double x : { 0.1, 0.2, 0.3, 0.4 }) observarBase(d, x);
        chequear("vida media 0 vuelve a la media acumulada (rollback)",
                 std::fabs(d.media - 0.25) < 1e-12,
                 "media=" + std::to_string(d.media).substr(0, 6));

        // Lo que motivo el cambio: seguir un cambio de nivel. La acumulada
        // necesita ~180.000 muestras para el 90 % de un escalon; la EWMA de
        // 5.000, ~16.600, que es ~1,3 ruedas.
        g_base_alpha = 1.0 - std::pow(0.5, 1.0 / 5000.0);
        BaseRed e;
        for (int i = 0; i < 20000; ++i) observarBase(e, 0.50);
        int pasos = 0;
        while (e.media < 0.50 + 0.90 * 0.30 && pasos < 400000) {
            observarBase(e, 0.80); pasos++;
        }
        chequear("el 90 % de un cambio de nivel entra en ~1,3 ruedas",
                 pasos > 15000 && pasos < 18000,
                 std::to_string(pasos) + " muestras (13.000 por rueda)");

        g_base_alpha = alpha_previo;
    }

    std::printf("\n%s — class25A ranking\n\n", fallos == 0 ? "PASA" : "FALLA");
    return fallos == 0 ? 0 : 1;
}
