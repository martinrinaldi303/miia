// sim26_retencion.cpp — ¿las redes aprenden y RETIENEN entre regímenes de mercado?
//
// 5-oct-2026: las filas «DepositoRepaso» corren el depósito de PRODUCCIÓN
// (miia_common.h) y el paso de repaso de producción. De ahí sale el valor por
// defecto de `cada` (4). La columna «ciclo entero» promedia las ruedas 31-120 del
// escenario A·B·A·B: es la que dice si el repaso gana en total, no sólo al volver.
//
// Ejecuta las redes REALES de producción (MLP24 de class24.cpp o MLP23 de
// class23.cpp, incluidas con -DMIIA_SIN_MAIN) y el RunningNorm real de
// miia_common.h, con el caudal y la forma de etiquetado que se midieron en el
// server. No reimplementa el entrenamiento: llama a trainSupervised().
//
// NO ES UNA PRUEBA VERDE/ROJO: imprime mediciones. Es de donde salieron la tasa
// de aprendizaje de class24 y la ventana del normalizador (1-oct-2026), y es lo
// que hay que volver a correr antes de tocar cualquiera de las dos.
//
// LO QUE SE MODELA, y de dónde sale cada número:
//   · 50 instrumentos, vector de 22 dims (8 propias + 14 compartidas): el
//     layout de class10 después del corte.
//   · ~380 vectores por instrumento y por rueda (mercado|64 entrenó ~5.000 por
//     día con 13 instrumentos; con 50 son ~19.000).
//   · TODOS los vectores de un instrumento en una rueda llevan LA MISMA
//     etiqueta. Medido el 18-sep: XLE 246/246, XLK 240/240, XLC 0/259. O sea:
//     por día entran 19.000 ejemplos pero sólo 50 etiquetas independientes.
//   · La etiqueta llega 2 ruedas después (horizonte de 48 h).
//   · La etiqueta es RELATIVA (¿le ganó al promedio?), como después del
//     arreglo del defecto 10: balanceada por construcción.
//
// LO QUE ES INVENTADO, y hay que decirlo: la SEÑAL. Se pone una relación
// verdadera entre una dim propia y el retorno relativo siguiente, de fuerza
// conocida (IC verdadero 0,05 = realista; 0,30 = fuerte, de control), y un
// régimen que la da vuelta y que se ve en el NIVEL de una dim compartida. La
// prueba no dice que esa señal exista en el mercado: dice qué hacen ESTAS redes
// cuando existe.
//
//   bash docs/simulaciones/build_sim26.sh

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <future>
#include <numeric>
#include <random>
#include <string>
#include <vector>

#ifdef TESTEAR_CLASS23
  #include "../../miia_cognitive/class23.cpp"
  #define MODULO "class23"
  static const double LR_BINARIO = LR, LR_ANTES = LR;
  struct Red {
      MLP23 m;
      Red(int in, unsigned s) : m(in, "sim", s) {}
      double puntuar(const std::vector<double>& x) { return m.forward(x); }
      void   entrenar(const std::vector<double>& x, double t) { m.trainSupervised(x, t); }
      void   repasar(const std::vector<double>& x, double t)  { m.repasar(x, t); }
      double& lr() { return m.lr; }
      RunningNorm& norm() { return m.norm; }
  };
#else
  #include "../../miia_cognitive/class24.cpp"
  #define MODULO "class24"
  static const double LR_BINARIO = LR, LR_ANTES = LR_ANTERIOR;
  struct Red {
      MLP24 m;
      Red(int in, unsigned s) : m(in, "sim", s) {}
      double puntuar(const std::vector<double>& x) { return m.score(x); }
      void   entrenar(const std::vector<double>& x, double t) { m.trainSupervised(x, t); }
      void   repasar(const std::vector<double>& x, double t)  { m.repasar(x, t); }
      double& lr() { return m.lr; }
      RunningNorm& norm() { return m.norm; }
  };
#endif

static const int N = 50, DIM = 22, PROPIAS = 8, REPS = 380, RETRASO = 2;
static const int DIM_SENAL = 3;      // el «change relativo»: la feature de la etiqueta
static const int DIM_REGIMEN = 8;    // una compartida, que marca el régimen por NIVEL

static double spearman(const std::vector<double>& a, const std::vector<double>& b) {
    const int n = (int)a.size();
    auto rk = [n](const std::vector<double>& v) {
        std::vector<int> o(n); std::iota(o.begin(), o.end(), 0);
        std::sort(o.begin(), o.end(), [&](int x, int y) { return v[x] < v[y]; });
        std::vector<double> r(n);
        for (int i = 0; i < n; ) {                      // empates: puesto promedio
            int j = i; while (j + 1 < n && v[o[j + 1]] == v[o[i]]) j++;
            for (int k = i; k <= j; k++) r[o[k]] = (i + j) / 2.0;
            i = j + 1;
        }
        return r;
    };
    auto ra = rk(a), rb = rk(b);
    double ma = (n - 1) / 2.0, sab = 0, sa = 0, sb = 0;
    for (int i = 0; i < n; i++) {
        sab += (ra[i] - ma) * (rb[i] - ma); sa += (ra[i] - ma) * (ra[i] - ma); sb += (rb[i] - ma) * (rb[i] - ma);
    }
    return (sa > 0 && sb > 0) ? sab / std::sqrt(sa * sb) : 0.0;
}

struct Dia {
    std::vector<std::vector<double>> primero;             // el vector de la mañana, por ticker
    std::vector<std::vector<std::vector<double>>> todos;  // [ticker][rep] normalizados
    std::vector<double> etiqueta;
};

struct Resultado { std::vector<double> ic, ic_senal, media_score, regimen; };

// signo(d): +1 o −1 según el régimen de la rueda d.
template <typename F>
static Resultado correr(double lr, double rho, int dias, F signo, unsigned semilla, int repaso = 0, int cada = 1) {
    std::mt19937 rng(semilla);
    std::normal_distribution<double> g(0, 1);
    Red red(DIM, semilla);
    red.lr() = lr;

    std::vector<Dia> hist;
    Resultado R;
    // WHAT-IF, no está en producción: un «repaso» de ejemplos viejos. Guarda UN
    // ejemplo por instrumento y rueda, y por cada ejemplo nuevo entrena además
    // uno viejo al azar. Es lo que haría falta para que aprender el régimen
    // nuevo no pise el anterior.
    std::vector<std::pair<std::vector<double>, double>> memoria;
    // repaso == 2: el DepositoRepaso de PRODUCCIÓN (miia_common.h), con sus tres
    // reglas — sólo días anteriores, uno por (instrumento, día), reservorio —, y
    // el paso de repaso de producción, que no toca los contadores.
    DepositoRepaso dep;
    dep.cada = cada;       // uno cada `cada` ejemplos nuevos, como en producción

    for (int d = 0; d < dias; d++) {
        const double sg = signo(d);
        Dia D; D.primero.resize(N); D.todos.resize(N); D.etiqueta.resize(N);
        std::vector<double> ret(N), senal(N);
        std::vector<std::vector<double>> base(N, std::vector<double>(PROPIAS));
        for (int i = 0; i < N; i++) for (int k = 0; k < PROPIAS; k++) base[i][k] = g(rng);
        const double nivel = sg > 0 ? 0.30 : 0.70;       // el régimen, como NIVEL de una compartida

        // Los vectores llegan intercalados, como en producción: una pasada por
        // los 50 instrumentos, y otra, y otra. El normalizador los ve en ese orden.
        double acum_reg = 0; long n_reg = 0;
        for (int rep = 0; rep < REPS; rep++) {
            std::vector<double> comp(DIM - PROPIAS);
            for (auto& c : comp) c = 0.5 + 0.05 * g(rng);
            comp[DIM_REGIMEN - PROPIAS] = nivel + 0.02 * g(rng);
            for (int i = 0; i < N; i++) {
                std::vector<double> x(DIM);
                for (int k = 0; k < PROPIAS; k++) x[k] = base[i][k] + 0.3 * g(rng);
                for (int k = PROPIAS; k < DIM; k++) x[k] = comp[k - PROPIAS];
                red.norm().observar(x);                 // exactamente como el ingest
                x = red.norm().aplicar(x);
                acum_reg += x[DIM_REGIMEN]; n_reg++;
                if (rep == 0) D.primero[i] = x;
                D.todos[i].push_back(std::move(x));
            }
        }

        // Lo que pasa DESPUÉS: el retorno relativo, y de ahí la etiqueta.
        double media = 0;
        for (int i = 0; i < N; i++) {
            senal[i] = sg * base[i][DIM_SENAL];
            ret[i]   = rho * senal[i] + std::sqrt(1 - rho * rho) * g(rng);
            media += ret[i];
        }
        media /= N;
        for (int i = 0; i < N; i++) { ret[i] -= media; D.etiqueta[i] = ret[i] > 0 ? 1.0 : 0.0; }

        // La red opina a la mañana, ANTES de haber visto nada de esta rueda.
        std::vector<double> sc(N);
        double ms = 0;
        for (int i = 0; i < N; i++) { sc[i] = red.puntuar(D.primero[i]); ms += sc[i]; }
        R.ic.push_back(spearman(sc, ret));
        R.ic_senal.push_back(spearman(sc, senal));
        R.media_score.push_back(ms / N);
        R.regimen.push_back(acum_reg / n_reg);
        hist.push_back(std::move(D));

        // Entrena con la rueda de hace RETRASO días, en el orden en que llega.
        if (d >= RETRASO) {
            Dia& T = hist[d - RETRASO];
            const int64_t dia = d - RETRASO;
            if (repaso == 1)
                for (int i = 0; i < N; i++) memoria.emplace_back(T.todos[i][0], T.etiqueta[i]);
            for (int rep = 0; rep < REPS; rep++)
                for (int i = 0; i < N; i++) {
                    if (repaso == 2)
                        dep.agregar("sim", "T" + std::to_string(i), dia, T.todos[i][rep], T.etiqueta[i]);
                    red.entrenar(T.todos[i][rep], T.etiqueta[i]);
                    if (repaso == 1) {
                        const auto& m = memoria[rng() % memoria.size()];
                        red.entrenar(m.first, m.second);
                    } else if (repaso == 2 && dep.toca()) {
                        if (const auto* e = dep.sortear("sim", dia)) red.repasar(e->x, e->y);
                    }
                }
            T.todos.clear(); T.todos.shrink_to_fit();
        }
    }
    return R;
}

static double prom(const std::vector<double>& v, int a, int b) {
    double s = 0; for (int i = a; i < b; i++) s += v[i]; return s / (b - a);
}
static double desvio(const std::vector<double>& v, int a, int b) {
    double m = prom(v, a, b), s = 0; for (int i = a; i < b; i++) s += (v[i] - m) * (v[i] - m);
    return std::sqrt(s / (b - a - 1));
}

struct Config { std::string nombre; double lr; double ventana; int repaso = 0; int cada = 1; };

int main() {
    spdlog::set_level(spdlog::level::off);
    const int S = 3;                                    // semillas por caso
    auto uno    = [](int)   { return 1.0; };
    auto tramos = [](int d) { return ((d / 30) % 2 == 1) ? -1.0 : 1.0; };   // A B A B, 30 ruedas c/u

    std::vector<Config> cfgs = {
        { "ANTES   (tasa " + std::to_string(LR_ANTES).substr(0, 6) + ", ventana 1.000)  ", LR_ANTES, 1000.0 },
    };
    for (double lr : { 0.01, 0.003, 0.001, 0.0003, 0.0001 })
        cfgs.push_back({ std::string(lr == LR_BINARIO ? "AHORA → " : "        ") +
                         "tasa " + std::to_string(lr).substr(0, 6) + ", ventana lenta   ", lr, RunningNorm::VENTANA_DEFECTO });
    cfgs.push_back({ "what-if 1-oct: AHORA + repaso ingenuo     ", LR_BINARIO, RunningNorm::VENTANA_DEFECTO, 1 });
    for (int cada : { 1, 2, 4, 8 })
        cfgs.push_back({ "DepositoRepaso, 1 repaso cada " + std::to_string(cada) + " nuevos   ",
                         LR_BINARIO, RunningNorm::VENTANA_DEFECTO, 2, cada });

    std::printf("\n══ %s — sim26: aprender y retener (%d semillas por caso) ══\n", MODULO, S);
    std::printf("   %d instrumentos · %d dims · %d vectores por instrumento y rueda · etiqueta a %d ruedas\n",
                N, DIM, REPS, RETRASO);
    std::printf("   «señal» = correlación entre lo que ordena la red y la señal verdadera (+1 perfecto, <0 al revés)\n\n");
    std::printf("   configuración                          │ UN régimen, 93 ruedas     │ CUATRO tramos A·B·A·B de 30 ruedas (IC 0,30)            │ régimen que VE la red\n");
    std::printf("                                          │ señal IC.30 · señal IC.05 │ A fin │ B 1ras5 │ B fin │ A vuelve 1ras5 │ B vuelve 1ras5 │   en A    en B\n");

    for (const auto& c : cfgs) {
        RunningNorm::ventana() = c.ventana;             // global: una config a la vez
        std::vector<std::future<Resultado>> f30, f05, ftr;
        for (int s = 0; s < S; s++) {
            f30.push_back(std::async(std::launch::async, [&, s] { return correr(c.lr, 0.30, 93, uno, 100 + s, c.repaso, c.cada); }));
            f05.push_back(std::async(std::launch::async, [&, s] { return correr(c.lr, 0.05, 93, uno, 300 + s, c.repaso, c.cada); }));
            ftr.push_back(std::async(std::launch::async, [&, s] { return correr(c.lr, 0.30, 120, tramos, 200 + s, c.repaso, c.cada); }));
        }
        double s30 = 0, s05 = 0, a1 = 0, b0 = 0, b1 = 0, a2 = 0, b2 = 0, ra = 0, rb = 0, tot = 0;
        for (int s = 0; s < S; s++) {
            auto R = f30[s].get(); s30 += prom(R.ic_senal, 33, 93);
            R = f05[s].get();      s05 += prom(R.ic_senal, 33, 93);
            R = ftr[s].get();
            a1 += prom(R.ic_senal, 15, 30);  b0 += prom(R.ic_senal, 30, 35);  b1 += prom(R.ic_senal, 45, 60);
            a2 += prom(R.ic_senal, 60, 65);  b2 += prom(R.ic_senal, 90, 95);
            tot += prom(R.ic_senal, 30, 120);
            ra += prom(R.regimen, 60, 90);   rb += prom(R.regimen, 90, 120);
        }
        std::printf("   %s │   %+.2f    ·   %+.2f     │ %+.2f │  %+.2f  │ %+.2f │     %+.2f      │     %+.2f      │  %+.2f   %+.2f  │ ciclo entero %+.2f\n",
                    c.nombre.c_str(), s30 / S, s05 / S, a1 / S, b0 / S, b1 / S, a2 / S, b2 / S, ra / S, rb / S, tot / S);
        std::fflush(stdout);
    }
    std::printf("\n   Cómo leerlo: «A vuelve» y «B vuelve» son la retención. Positivo = la red reconoció el régimen\n");
    std::printf("   que ya había visto y ordenó bien desde la primera rueda; negativo = lo había olvidado.\n\n");
    return 0;
}
