// sim29_repaso.cpp — el REPASO de ejemplos viejos (5-oct-2026), contra el código real.
//
// Incluye class24.cpp (o class23.cpp con -DTESTEAR_CLASS23) con -DMIIA_SIN_MAIN y
// ejercita `DepositoRepaso` de miia_common.h y `entrenarLote` del módulo, tal cual
// los llama el feedback. No reimplementa nada.
//
// Lo que tiene que valer, y por qué cada cosa:
//   1. Un ejemplo por (red, instrumento, día): los ~380 vectores de un instrumento
//      en una rueda llevan la misma etiqueta; guardarlos todos es guardar lo mismo.
//   2. Se repasan sólo días ANTERIORES: repasar hoy es duplicar la tasa sobre el día.
//   3. El reservorio conserva días viejos cuando el depósito se llena.
//   4. Sólo etiquetas RELATIVAS de un instrumento real entran al depósito.
//   5. El repaso NO infla seen/sup: esos contadores van a la planilla.
//   6. Con el repaso apagado, el entrenamiento es BIT A BIT el de antes.
//   7. Guardar y cargar no pierde nada, y descarta lo que tiene forma rara.
//   8. Uno cada `cada` ejemplos nuevos.
//
//   bash docs/simulaciones/build_sim29.sh

#include <cstdio>
#include <string>
#include <vector>

#ifdef TESTEAR_CLASS23
  #include "../../miia_cognitive/class23.cpp"
  #define MODULO "class23"
  using Estado = State23;
  static auto& entrenar(Estado& st, std::vector<std::pair<std::string, std::vector<double>>>& l,
                        const std::string& s, const std::string& m, int64_t dts, double y) {
      static EntrenoFB23 r; r = entrenarLote23(st, l, s, m, dts, y); return r;
  }
  static int sup(const MLP23& r)  { return r.supervised; }
  static std::vector<double> firma(const MLP23& r) {
      std::vector<double> f = r.W3; f.push_back(r.b3);
      for (const auto& fila : r.L1.W) f.insert(f.end(), fila.begin(), fila.end());
      return f;
  }
  static MLP23& red(Estado& st, int dim) { return getOrCreate(st, "mercado", dim); }
  static void entrenarDirecto(MLP23& r, const std::vector<double>& x, double y) { r.trainSupervised(x, y); }
#else
  #include "../../miia_cognitive/class24.cpp"
  #define MODULO "class24"
  using Estado = State24;
  static auto& entrenar(Estado& st, std::vector<std::pair<std::string, std::vector<double>>>& l,
                        const std::string& s, const std::string& m, int64_t dts, double y) {
      static EntrenoFB r; r = entrenarLote(st, l, s, m, dts, y); return r;
  }
  static int sup(const MLP24& r)  { return r.supervised_count; }
  static std::vector<double> firma(const MLP24& r) {
      std::vector<double> f = r.W2; f.push_back(r.b2);
      for (const auto& fila : r.W1) f.insert(f.end(), fila.begin(), fila.end());
      return f;
  }
  static MLP24& red(Estado& st, int dim) { return getOrCreate(st, "mercado", dim); }
  static void entrenarDirecto(MLP24& r, const std::vector<double>& x, double y) { r.trainSupervised(x, y); }
#endif

static int fallos = 0, total = 0;
static void check(bool ok, const std::string& que) {
    total++; if (!ok) fallos++;
    std::printf("   %s %s\n", ok ? "[OK]  " : "[FALLA]", que.c_str());
}

static const int     DIM = 22;
static const int64_t DIA_MS = 86400000LL;
static std::vector<double> vec(int semilla) {
    std::mt19937 g(semilla); std::normal_distribution<double> n(0, 1);
    std::vector<double> v(DIM); for (auto& x : v) x = n(g); return v;
}
static std::vector<std::pair<std::string, std::vector<double>>> lote(int n, int semilla) {
    std::vector<std::pair<std::string, std::vector<double>>> l;
    for (int i = 0; i < n; i++) l.emplace_back("mercado|22", vec(semilla * 1000 + i));
    return l;
}

int main() {
    spdlog::set_level(spdlog::level::off);
    std::printf("\n══ %s — sim29: el repaso de ejemplos viejos ══\n\n", MODULO);

    // ── 1 · el depósito solo ────────────────────────────────────
    std::printf(" 1 · el depósito\n");
    {
        DepositoRepaso d;
        check(d.agregar("r", "XLK", 100, vec(1), 1.0), "el primer ejemplo de (red, XLK, día 100) entra");
        check(!d.agregar("r", "XLK", 100, vec(2), 1.0), "el segundo del MISMO (red, instrumento, día) no entra");
        check(d.agregar("r", "XLE", 100, vec(3), 0.0), "otro instrumento el mismo día sí entra");
        check(d.agregar("r", "XLK", 101, vec(4), 0.0), "el mismo instrumento otro día sí entra");
        check(d.total() == 3, "quedan 3 ejemplos");

        check(d.sortear("r", 100) == nullptr, "pidiendo repaso el día 100 no devuelve nada: no hay días anteriores");
        check(d.sin_viejos == 1, "y lo cuenta en sin_viejos");
        bool siempre_viejo = true;
        for (int i = 0; i < 500; i++) {
            const auto* e = d.sortear("r", 101);
            if (!e || e->dia >= 101) { siempre_viejo = false; break; }
        }
        check(siempre_viejo, "el día 101 sólo repasa ejemplos del día 100 (nunca el de hoy)");
        check(d.sortear("otra", 500) == nullptr, "una red sin depósito no devuelve nada");
    }
    {
        DepositoRepaso d; d.tope = 100;
        for (int dia = 0; dia < 10000; dia++) d.agregar("r", "XLK", dia, vec(dia), dia % 2);
        int64_t mn = 1 << 30, mx = 0; int viejos = 0;
        for (const auto& e : d.redes["r"].ej) {
            mn = std::min(mn, e.dia); mx = std::max(mx, e.dia);
            if (e.dia < 5000) viejos++;
        }
        check(d.redes["r"].ej.size() == 100, "con tope 100 y 10.000 días ofrecidos quedan 100");
        check(viejos >= 30 && viejos <= 70,
              "reservorio: la mitad vieja de la historia sigue representada (" + std::to_string(viejos) + " de 100 < día 5000)");
        check(mn < 1000, "sigue habiendo días de los primeros mil (" + std::to_string(mn) + ")");
    }

    // ── 2 · qué entra al depósito ───────────────────────────────
    std::printf("\n 2 · qué entra al depósito\n");
    {
        Estado st; red(st, DIM);
        auto l1 = lote(5, 1); entrenar(st, l1, "XLK", "relativo", 100 * DIA_MS, 1.0);
        check(st.repaso.total() == 1, "lote relativo de XLK (5 vectores) → 1 ejemplo en el depósito");
        auto l2 = lote(5, 2); entrenar(st, l2, "GENERAL", "absoluto", 100 * DIA_MS, 1.0);
        check(st.repaso.total() == 1, "lote GENERAL/absoluto → no entra (es la dirección del mercado)");
        auto l3 = lote(5, 3); entrenar(st, l3, "XLE", "absoluto", 100 * DIA_MS, 1.0);
        check(st.repaso.total() == 1, "ticker real con etiqueta absoluta → no entra");
        auto l4 = lote(5, 4); entrenar(st, l4, "XLE", "relativo", 100 * DIA_MS, 0.0);
        check(st.repaso.total() == 2, "XLE relativo → entra");
    }
    {
        Estado st; red(st, DIM);
        for (int dia = 100; dia < 103; dia++) { auto l = lote(8, dia); entrenar(st, l, "XLK", "relativo", dia * DIA_MS, 1.0); }
        const uint64_t antes = st.repaso.repasados;
        int rep = 0;
        for (int i = 0; i < 20; i++) { auto l = lote(8, 900 + i); rep += entrenar(st, l, "GENERAL", "absoluto", 110 * DIA_MS, 0.0).repasados; }
        check(rep == 0 && st.repaso.repasados == antes,
              "entrenando con GENERAL/absoluto no se repasan ejemplos relativos (no se mezclan las preguntas)");
    }

    // ── 3 · contadores intactos y frecuencia ────────────────────
    std::printf("\n 3 · el repaso no infla los contadores de la planilla\n");
    {
        Estado st; auto& r = red(st, DIM);
        int entrenados = 0, repasados = 0;
        for (int dia = 100; dia < 130; dia++)
            for (int t = 0; t < 10; t++) {
                auto l = lote(40, dia * 100 + t);
                const auto& e = entrenar(st, l, "T" + std::to_string(t), "relativo", dia * DIA_MS, (dia + t) % 2);
                entrenados += e.entrenados; repasados += e.repasados;
            }
        check(sup(r) == entrenados,
              "supervisados = " + std::to_string(sup(r)) + " = ejemplos nuevos (" + std::to_string(entrenados) + "), no se suman los repasos");
        check(repasados > 0, "hubo repasos (" + std::to_string(repasados) + ")");
        const double frac = (double)repasados / entrenados;
        check(frac > 0.20 && frac <= 0.25 + 1e-9,
              "uno cada " + std::to_string(st.repaso.cada) + ": " + std::to_string(repasados) + " de " +
              std::to_string(entrenados) + " (el primer día no tiene días anteriores)");
        check(st.repaso.total() == 30 * 10, "un ejemplo por (instrumento, día): 300");
    }

    // ── 4 · apagado = comportamiento anterior exacto ────────────
    std::printf("\n 4 · con el repaso apagado, el entrenamiento es el de antes\n");
    {
        Estado st; st.repaso_on = false; auto& r = red(st, DIM);
        Estado ref; auto& rr = red(ref, DIM);
        for (int dia = 100; dia < 110; dia++) {
            auto l = lote(30, dia);
            auto copia = l;
            entrenar(st, l, "XLK", "relativo", dia * DIA_MS, dia % 2);
            for (auto& [k, x] : copia) entrenarDirecto(rr, x, dia % 2);
        }
        check(firma(r) == firma(rr), "pesos idénticos bit a bit a entrenar sin repaso");
        check(st.repaso.total() == 0 && st.repaso.repasados == 0, "y el depósito queda vacío");
    }
    {
        Estado st; auto& r = red(st, DIM);
        Estado ref; st.repaso_on = true; auto& rr = red(ref, DIM); ref.repaso_on = false;
        for (int dia = 100; dia < 110; dia++) {
            auto l = lote(30, dia); auto c = l;
            entrenar(st, l, "XLK", "relativo", dia * DIA_MS, dia % 2);
            entrenar(ref, c, "XLK", "relativo", dia * DIA_MS, dia % 2);
        }
        check(firma(r) != firma(rr), "con el repaso prendido los pesos SÍ difieren (el repaso hace algo)");
    }

    // ── 5 · guardar y cargar ────────────────────────────────────
    std::printf("\n 5 · guardar y cargar\n");
    {
        DepositoRepaso d;
        for (int dia = 0; dia < 50; dia++) d.agregar("mercado|22", "XLK", dia, vec(dia), dia % 2);
        const json j = d.toJson();
        DepositoRepaso c;
        const size_t n = c.fromJson(j, {{"mercado|22", DIM}});
        check(n == 50 && c.total() == 50, "50 ejemplos guardados, 50 cargados");
        check(c.redes["mercado|22"].ej[7].x == d.redes["mercado|22"].ej[7].x, "los vectores vuelven exactos");
        check(!c.agregar("mercado|22", "XLK", 49, vec(1), 1.0), "después de cargar, un día ya guardado no se duplica");

        DepositoRepaso otra;
        check(otra.fromJson(j, {{"mercado|22", 64}}) == 0, "si la red ahora tiene otra dimensión, no se carga nada");
        check(otra.fromJson(j, {}) == 0, "si la red no existe, no se carga nada");

        json roto = j;
        roto["redes"]["mercado|22"]["ej"][0]["y"] = 7.0;
        roto["redes"]["mercado|22"]["ej"][1]["x"][0] = "no";
        DepositoRepaso r; const size_t m = r.fromJson(roto, {{"mercado|22", DIM}});
        check(m == 48, "una etiqueta fuera de [0,1] y un vector con basura se descartan (48 de 50)");
        json vieja = j; vieja["version"] = 99;
        DepositoRepaso v;
        check(v.fromJson(vieja, {{"mercado|22", DIM}}) == 0, "una versión desconocida no se carga");
    }

    // ── 6 · la línea del heartbeat ──────────────────────────────
    std::printf("\n 6 · la línea del heartbeat\n");
    {
        DepositoRepaso d; d.agregar("r", "XLK", 1, vec(1), 1.0);
        const std::string s = linea_repaso(d, true);
        check(s.rfind("repaso: modo=ACTIVO ejemplos=1 ", 0) == 0, "empieza con el prefijo fijo que lee el chequeo: " + s);
        check(linea_repaso(d, false).find("modo=APAGADO") != std::string::npos, "apagado lo dice");
    }

    std::printf("\n   %s: %d de %d\n\n", fallos == 0 ? "TODO EN VERDE" : "HAY FALLAS", total - fallos, total);
    return fallos == 0 ? 0 : 1;
}
