// sim28_anillo.cpp — class27 y class28 ya no acumulan archivos sin tope.
//
// Ejercita `escribir_en_anillo` de miia_common.h (el código real) y vigila que
// class27.cpp y class28.cpp no vuelvan a poner el reloj en el nombre del archivo.
// Medido en el server el 1-oct-2026: 1.351.589 archivos y 5,3 GB en snapshots/.
//
//   bash docs/simulaciones/build_sim28.sh

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "../../miia_cognitive/miia_common.h"

static int fallos = 0, total = 0;
static void check(const char* que, bool ok, const std::string& detalle = "") {
    total++;
    if (!ok) fallos++;
    std::printf("  %s  %s%s%s\n", ok ? " ok  " : "FALLA", que, detalle.empty() ? "" : "  — ", detalle.c_str());
}

static int contar(const fs::path& d) {
    int n = 0; std::error_code ec;
    for (auto it = fs::directory_iterator(d, ec); !ec && it != fs::directory_iterator(); ++it) n++;
    return n;
}

static std::string leer(const fs::path& p) {
    std::ifstream f(p); std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

int main(int argc, char** argv) {
    const fs::path raiz = argc > 1 ? fs::path(argv[1]) : fs::path(".");
    const fs::path dir = fs::temp_directory_path() / "miia_sim28_anillo";
    std::error_code ec; fs::remove_all(dir, ec); fs::create_directories(dir);

    std::printf("\n1 · El anillo acota la carpeta\n");
    {
        std::atomic<uint64_t> n{0};
        bool todas = true;
        for (int i = 0; i < 5000; i++)
            todas = escribir_en_anillo(dir, "reflection_", n, 50, "{\"i\":" + std::to_string(i) + "}") && todas;
        check("las 5.000 escrituras salen bien", todas);
        check("y quedan 50 archivos, no 5.000", contar(dir) == 50, std::to_string(contar(dir)) + " archivos");
        check("el último pisó a los viejos (el casillero 49 tiene la escritura 4.999)",
              leer(dir / "reflection_49.json") == "{\"i\":4999}");
        check("un casillero nunca queda con contenido a medias de otra escritura",
              leer(dir / "reflection_0.json") == "{\"i\":4950}");
    }

    std::printf("\n2 · Dos prefijos en la misma carpeta no se pisan\n");
    {
        std::atomic<uint64_t> n{0};
        for (int i = 0; i < 300; i++) escribir_en_anillo(dir, "conciencia_", n, 20, "x");
        check("50 de uno + 20 del otro", contar(dir) == 70, std::to_string(contar(dir)) + " archivos");
    }

    std::printf("\n3 · Tope 0 = no escribir\n");
    {
        const fs::path d0 = dir / "cero"; fs::create_directories(d0);
        std::atomic<uint64_t> n{0};
        const bool r = escribir_en_anillo(d0, "reflection_", n, 0, "x");
        check("devuelve false y no crea nada", !r && contar(d0) == 0);
    }

    std::printf("\n4 · Si borran la carpeta con el sistema corriendo, se recrea\n");
    {
        const fs::path d1 = dir / "borrada";
        std::atomic<uint64_t> n{0};
        check("la primera escritura sobre una carpeta que no existe funciona",
              escribir_en_anillo(d1, "conciencia_", n, 10, "a") && contar(d1) == 1);
        fs::remove_all(d1, ec);
        check("y después de borrarla en caliente, también",
              escribir_en_anillo(d1, "conciencia_", n, 10, "b") && contar(d1) == 1);
    }

    std::printf("\n5 · El tope sale del entorno, con límites\n");
    {
        check("sin variable → el valor por defecto", tope_archivos("MIIA_SIM28_NO_EXISTE", 200) == 200);
#ifdef _WIN32
        _putenv("MIIA_SIM28_V=37"); _putenv("MIIA_SIM28_B=abc"); _putenv("MIIA_SIM28_N=-5");
#else
        setenv("MIIA_SIM28_V", "37", 1); setenv("MIIA_SIM28_B", "abc", 1); setenv("MIIA_SIM28_N", "-5", 1);
#endif
        check("valor válido se respeta", tope_archivos("MIIA_SIM28_V", 200) == 37);
        check("basura → por defecto", tope_archivos("MIIA_SIM28_B", 200) == 200);
        check("negativo → por defecto", tope_archivos("MIIA_SIM28_N", 200) == 200);
    }

    std::printf("\n6 · class27 y class28 usan el anillo (guarda contra la regresión)\n");
    {
        const std::string c27 = leer(raiz / "miia_cognitive" / "class27.cpp");
        const std::string c28 = leer(raiz / "miia_cognitive" / "class28.cpp");
        check("se pudieron leer los dos fuentes", !c27.empty() && !c28.empty());
        check("class27 escribe por el anillo", c27.find("escribir_en_anillo(snap,\"reflection_\"") != std::string::npos);
        check("class27 ya no pone el reloj en el nombre",
              c27.find("\"reflection_\"+std::to_string(now)") == std::string::npos);
        check("class27 purga seenRef", c27.find("st.seenRef.erase") != std::string::npos);
        check("class28 escribe por el anillo", c28.find("escribir_en_anillo(jsonDir,\"conciencia_\"") != std::string::npos);
        check("class28 ya no pone el reloj en el nombre",
              c28.find("\"conciencia_\"+std::to_string") == std::string::npos);
    }

    fs::remove_all(dir, ec);
    std::printf("\n%s sim28: %d/%d checks\n\n", fallos == 0 ? "PASA —" : "FALLA —", total - fallos, total);
    return fallos == 0 ? 0 : 1;
}
