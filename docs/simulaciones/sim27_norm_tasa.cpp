// sim27_norm_tasa.cpp — la ventana lenta del normalizador y la tasa de class24.
//
// Guarda de regresión (verde/rojo) de los dos cambios del 1-oct-2026. Incluye
// class24.cpp de producción con -DMIIA_SIN_MAIN: ejercita el RunningNorm real,
// el MLP24 real y el guardar/cargar real. Lo que MIDE cuánto aprenden y retienen
// las redes es sim26; esto sólo vigila que el mecanismo no se rompa.
//
//   bash docs/simulaciones/build_sim27.sh

#include <cmath>
#include <cstdio>
#include <fstream>
#include <random>
#include <vector>

#include "../../miia_cognitive/class24.cpp"

static int fallos = 0, total = 0;
static void check(const char* que, bool ok, const std::string& detalle = "") {
    total++;
    if (!ok) fallos++;
    std::printf("  %s  %s%s%s\n", ok ? " ok  " : "FALLA", que, detalle.empty() ? "" : "  — ", detalle.c_str());
}

// El RunningNorm de ANTES del cambio, copiado tal cual: es la referencia contra
// la que se compara el modo legado. Si alguien toca el modo legado, esto lo caza.
struct NormVieja {
    std::vector<double> mean, var; long long n = 0;
    void observar(const std::vector<double>& x) {
        if (mean.size() != x.size()) { mean.assign(x.size(), 0.0); var.assign(x.size(), 0.0); n = 0; }
        if (n == 0) { for (size_t i = 0; i < x.size(); i++) { mean[i] = x[i]; var[i] = 0.0; } n = 1; return; }
        for (size_t i = 0; i < x.size(); i++) {
            const double d = x[i] - mean[i];
            mean[i] += 0.001 * d;
            var[i]   = (1.0 - 0.001) * var[i] + 0.001 * d * d;
        }
        n++;
    }
};

// Una dim que marca el régimen por NIVEL: 0,30 durante `a` muestras y 0,70
// durante `b`. Devuelve cómo la ve la red en las últimas 5.000.
static double nivel_visto(double ventana, int a, int b) {
    RunningNorm::ventana() = ventana;
    RunningNorm nm; std::mt19937 rng(7); std::normal_distribution<double> g(0, 1);
    double acum = 0; int cuenta = 0;
    for (int i = 0; i < a + b; i++) {
        std::vector<double> x = { (i < a ? 0.30 : 0.70) + 0.02 * g(rng), g(rng) };
        nm.observar(x);
        const auto y = nm.aplicar(x);
        if (i >= a + b - 5000) { acum += y[0]; cuenta++; }
    }
    return acum / cuenta;
}

int main() {
    spdlog::set_level(spdlog::level::off);
    std::mt19937 rng(1); std::normal_distribution<double> g(0, 1);
    char buf[160];

    std::printf("\n1 · El modo legado es EXACTAMENTE el de antes (MIIA_NORM_VENTANA=1000)\n");
    {
        RunningNorm::ventana() = 1000.0;
        RunningNorm nueva; NormVieja vieja; double dif = 0;
        for (int i = 0; i < 5000; i++) {
            std::vector<double> x = { g(rng), 3 + 2 * g(rng), 0.5 };
            nueva.observar(x); vieja.observar(x);
            for (int k = 0; k < 3; k++)
                dif = std::max({ dif, std::fabs(nueva.mean[k] - vieja.mean[k]), std::fabs(nueva.var[k] - vieja.var[k]) });
        }
        std::snprintf(buf, sizeof buf, "diferencia máxima %.3g", dif);
        check("media y varianza idénticas al código anterior", dif == 0.0, buf);
        check("legado() lo informa", RunningNorm::legado());
    }

    std::printf("\n2 · La ventana lenta deja ver el NIVEL del régimen; la vieja lo borraba\n");
    {
        const double viejo = nivel_visto(1000.0, 30000, 20000);
        const double nuevo = nivel_visto(RunningNorm::VENTANA_DEFECTO, 30000, 20000);
        std::snprintf(buf, sizeof buf, "la red lo ve como %+.3f", viejo);
        check("con la ventana de 1.000 el régimen nuevo llega como ~0", std::fabs(viejo) < 0.2, buf);
        std::snprintf(buf, sizeof buf, "la red lo ve como %+.3f", nuevo);
        check("con la ventana lenta sigue visible 20.000 muestras después", nuevo > 0.5, buf);
        check("y por defecto NO está en modo legado", !RunningNorm::legado());
    }

    std::printf("\n3 · El arranque: promedio acumulado, sin arrastrar el primer vector\n");
    {
        RunningNorm::ventana() = RunningNorm::VENTANA_DEFECTO;
        RunningNorm nm; double suma = 0; const int K = 500;
        for (int i = 0; i < K; i++) { const double v = 3 + 2 * g(rng); suma += v; nm.observar({ v }); }
        std::snprintf(buf, sizeof buf, "media %.6f contra %.6f", nm.mean[0], suma / K);
        check("la media es el promedio aritmético de lo visto", std::fabs(nm.mean[0] - suma / K) < 1e-9, buf);
        std::snprintf(buf, sizeof buf, "desvío %.3f (verdadero 2)", std::sqrt(nm.var[0]));
        check("el desvío ya es utilizable a las 500 muestras", std::fabs(std::sqrt(nm.var[0]) - 2.0) < 0.3, buf);
        check("n_lento cuenta las muestras", nm.n_lento == K && nm.n == K);
        bool acotado = true;
        for (int i = 0; i < 2000; i++) {
            const auto y = nm.aplicar({ 3 + 50 * g(rng) });
            if (!std::isfinite(y[0]) || std::fabs(y[0]) > RunningNorm::CLAMP) acotado = false;
        }
        check("la salida sigue acotada por CLAMP y es finita", acotado);
    }

    std::printf("\n4 · Un archivo de pesos VIEJO no produce un escalón el día del despliegue\n");
    {
        RunningNorm::ventana() = RunningNorm::VENTANA_DEFECTO;
        json viejo = { {"n", 75000}, {"mean", {1.0}}, {"var", {0.25}} };      // sin n_lento
        RunningNorm nm;
        check("se carga", nm.fromJson(viejo, 1));
        check("la agenda arranca en 1000 (el alfa que traía), no en 75.000", nm.n_lento == 1000);
        nm.observar({ 2.0 });
        std::snprintf(buf, sizeof buf, "media %.9f, esperada %.9f", nm.mean[0], 1.0 + 1.0 / 1001.0);
        check("el primer paso usa alfa 1/1001", std::fabs(nm.mean[0] - (1.0 + 1.0 / 1001.0)) < 1e-12, buf);

        json chico = { {"n", 50}, {"mean", {1.0}}, {"var", {0.25}} };
        RunningNorm nc; nc.fromJson(chico, 1);
        check("uno con pocas muestras sigue donde estaba", nc.n_lento == 50);

        RunningNorm ida; for (int i = 0; i < 3000; i++) ida.observar({ g(rng), g(rng) });
        RunningNorm vuelta;
        check("guardar y cargar conserva n_lento",
              vuelta.fromJson(ida.toJson(), 2) && vuelta.n_lento == ida.n_lento && vuelta.n == ida.n);
        check("y rechaza un normalizador de otra dimensión", !RunningNorm().fromJson(ida.toJson(), 3));
    }

    std::printf("\n5 · La tasa de class24\n");
    {
        check("la tasa del binario es 0,0003", LR == 0.0003);
        check("la anterior (0,01) queda nombrada para la reversa", LR_ANTERIOR == 0.01);
        check("g_lr arranca en la del binario", g_lr == LR);
        MLP24 red(22, "mercado|22", 1);
        check("una red nueva nace con g_lr", red.lr == g_lr);

        // El archivo de pesos guarda `lr`. Uno escrito con 0,01 NO puede
        // devolverla: manda el binario.
        g_pesos_file = fs::temp_directory_path() / "sim27_class24_pesos.json";
        {
            State24 st;
            st.redes.emplace("mercado|22", MLP24(22, "mercado|22", 1));
            for (int i = 0; i < 300; i++) {
                std::vector<double> x(22); for (auto& v : x) v = g(rng);
                st.redes.at("mercado|22").norm.observar(x);
            }
            guardarPesos(st);
        }
        json j; { std::ifstream in(g_pesos_file); in >> j; }
        j["redes"]["mercado|22"]["lr"] = 0.01;
        { std::ofstream out(g_pesos_file); out << j.dump(); }
        State24 st2;
        const bool cargo = cargarPesos(st2);
        check("el archivo se carga", cargo && st2.redes.count("mercado|22") == 1);
        if (cargo) {
            std::snprintf(buf, sizeof buf, "lr cargada %.4f", st2.redes.at("mercado|22").lr);
            check("un archivo con lr=0,01 NO devuelve la tasa vieja", st2.redes.at("mercado|22").lr == g_lr, buf);
            check("y el normalizador vuelve con su agenda", st2.redes.at("mercado|22").norm.n_lento == 300);
        }
        std::error_code ec; fs::remove(g_pesos_file, ec);
    }

    std::printf("\n%s sim27: %d/%d checks\n\n", fallos == 0 ? "PASA —" : "FALLA —", total - fallos, total);
    return fallos == 0 ? 0 : 1;
}
