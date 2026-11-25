// ============================================================================
// sim23_class21.cpp — class21: coherencia en cualquier idioma y voto siempre
// ----------------------------------------------------------------------------
// QUÉ PRUEBA, y por qué existe:
//
// El chequeo del 27-sep-2026 mostró dos cosas de class21 que no eran ruido:
//
//   class21_output 12 msgs  ·  class22/23/24_output 15 msgs cada uno
//   class21 ❤️  total=108933 ok=71232          ← se calla en el 34,6 %
//
// class25A cierra la ventana de un instrumento con `mods.size() >= 4`. Si
// class21 no publica, la ventana NO completa y se cierra por timeout a los 5 s
// decidiendo con TRES módulos — y con el voto parejo, sacar un módulo cambia el
// z del ensamble. Quién queda afuera lo elegía el umbral adaptativo de class21,
// aplicado a un score cuyo término de coherencia era una CONSTANTE.
//
// Esta prueba incluye `class21.cpp` y `miia_common.h` DE PRODUCCIÓN con
// -DMIIA_SIN_MAIN y ejercita las dos funciones reales: `coherencia_dominio` y
// `armarSalida21`. No reimplementa nada.
//
//   bash docs/simulaciones/build_sim23.sh
// ============================================================================

#include "../../miia_cognitive/class21.cpp"

#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

static int g_ok = 0, g_fallas = 0;

static void chk(bool cond, const std::string& msg, const std::string& extra = "") {
    if (cond) { g_ok++;     std::cout << "   [ok] "    << msg; }
    else      { g_fallas++; std::cout << "   [FALLA] " << msg; }
    if (!extra.empty()) std::cout << "   " << extra;
    std::cout << "\n";
}

static std::string f3(double v) {
    char b[32]; std::snprintf(b, sizeof b, "%.3f", v); return b;
}

int main() {
    std::cout << "\n============================================================\n";
    std::cout << "  sim23 · class21: coherencia multilingue y voto siempre\n";
    std::cout << "============================================================\n\n";

    // ── 1 · el defecto que lo tenía clavado ─────────────────────────────────
    //
    // Con las 18 KEYWORDS en castellano y Jaccard sobre la unión, CUALQUIER
    // texto real devolvía exactamente el piso 0,3. Esa constante entraba al
    // score de class21 al 10 %: 0,03 fijo en las 108.933 señales.
    std::cout << "1 · Antes devolvia una CONSTANTE (modo legado)\n";
    {
        // El modo legado se lee una sola vez por proceso, así que acá se
        // reproduce la fórmula vieja en vez de tocar el entorno.
        auto jaccard_viejo = [](const std::string& texto) {
            if (texto.empty()) return 0.5;
            auto tt = tokenize(texto);
            std::set<std::string> kk(KEYWORDS.begin(), KEYWORDS.end());
            if (tt.empty()) return 0.3;
            int inter = 0; for (auto& t : tt) if (kk.count(t)) inter++;
            int uni = (int)tt.size() + (int)kk.size() - inter;
            if (uni == 0) return 0.5;
            return std::max(0.3, (double)inter / uni);
        };
        const std::vector<std::string> reales = {
            "market features XLK chg=0.012 est=1 rel=0.004",
            "Energy stocks slide after crude oil futures drop on demand worries",
            "impacto mediatico: 3 titulares, sentimiento +1, cuota 0.45",
            "La inflación de septiembre aceleró y el mercado descuenta otra suba de tasas",
        };
        bool todosPiso = true;
        for (const auto& t : reales) if (jaccard_viejo(t) != 0.3) todosPiso = false;
        chk(todosPiso, "los 4 textos reales daban 0.300 con la regla vieja",
            "ingles, castellano CON tildes y el texto sintetico de class10");
    }

    // ── 2 · ahora distingue, y en los dos idiomas ───────────────────────────
    std::cout << "\n2 · Ahora varia, en ingles y en castellano\n";
    {
        const double en = coherencia_dominio(
            "Energy stocks slide after crude oil futures drop on demand worries");
        const double es = coherencia_dominio(
            "La inflación de septiembre aceleró y el mercado descuenta otra suba de tasas");
        const double nada = coherencia_dominio(
            "El equipo local gano el partido con dos goles en el segundo tiempo");
        chk(en > 0.3, "un titular financiero en INGLES pasa el piso", "en=" + f3(en));
        chk(es > 0.3, "uno en CASTELLANO con tildes tambien", "es=" + f3(es));
        chk(nada < en && nada < es,
            "y uno que no es del dominio queda por debajo de los dos",
            "deportes=" + f3(nada));
        chk(en <= 1.0 && es <= 1.0 && nada >= 0.3,
            "todo dentro de [0.3 , 1.0], la misma escala que antes",
            "min=" + f3(nada) + " max=" + f3(std::max(en, es)));
    }

    // ── 3 · LOS ACENTOS, que era el motivo de que el castellano fallara ─────
    //
    // `tokenize` sólo guarda bytes que pasan isalpha, y en UTF-8 'ó' son dos
    // bytes que no lo pasan: "inflación" se partía en "inflaci" + "n". La
    // lista decía "inflacion" sin tilde, así que el castellano REAL no
    // coincidía nunca. Ahora se pliega antes de tokenizar.
    std::cout << "\n3 · Con tilde y sin tilde tienen que dar LO MISMO\n";
    {
        const double conTilde = coherencia_dominio("La inflación y la recesión golpean al crédito");
        const double sinTilde = coherencia_dominio("La inflacion y la recesion golpean al credito");
        chk(conTilde == sinTilde, "mismo valor con y sin tildes",
            "con=" + f3(conTilde) + " sin=" + f3(sinTilde));
        chk(conTilde > 0.3, "y las dos pasan el piso", f3(conTilde));
        chk(plegar_texto("Inflación ÑOÑO ü Ç") == "inflacion nono u c",
            "el pliegue mapea los acentos que usa el castellano",
            "'" + plegar_texto("Inflación ÑOÑO ü Ç") + "'");
    }

    // ── 4 · no se rompe con otros alfabetos ─────────────────────────────────
    //
    // Alcance honesto: la lista de raices es es/en. Un titular en cirilico o en
    // chino cae al piso — igual que antes, pero ahora por decision escrita. Lo
    // que NO puede pasar es que produzca tokens basura o que se caiga.
    std::cout << "\n4 · Otro alfabeto: cae al piso, no explota\n";
    {
        const double ru = coherencia_dominio("Рынок акций упал после решения центрального банка");
        const double zh = coherencia_dominio("市场在央行决定后下跌");
        chk(ru >= 0.3 && ru <= 1.0, "cirilico devuelve un valor valido", "ru=" + f3(ru));
        chk(zh >= 0.3 && zh <= 1.0, "chino tambien", "zh=" + f3(zh));
        chk(tokenizar_plegado("市场在央行决定后下跌").empty(),
            "y no fabrica tokens basura con bytes altos");
        // Mezcla: un titular en ingles con un nombre en chino sigue funcionando.
        const double mix = coherencia_dominio("Chinese market 市场 slides as the central bank cuts rates");
        chk(mix > 0.3, "un texto MEZCLADO sigue reconociendo lo que entiende",
            "mix=" + f3(mix));
    }

    // ── 5 · monotonia: mas conceptos, mas coherencia ────────────────────────
    std::cout << "\n5 · Mas conceptos del dominio, mas coherencia\n";
    {
        const double c1 = coherencia_dominio("the market opened today");
        const double c2 = coherencia_dominio("the market and the price moved today");
        const double c3 = coherencia_dominio("market price inflation risk bond yield credit");
        chk(c1 < c2 && c2 <= c3, "crece con la cantidad de conceptos distintos",
            f3(c1) + " < " + f3(c2) + " <= " + f3(c3));
        chk(c3 == 1.0, "y satura en 1.0 con " + std::to_string(COHER_CONCEPTOS_PLENO) + " conceptos",
            f3(c3));
        // Un concepto repetido no cuenta dos veces: si contara coincidencias en
        // vez de conceptos, repetir una palabra inflaria el score.
        const double rep = coherencia_dominio("market market market market market market");
        chk(rep == c1, "repetir la MISMA palabra no sube nada",
            "repetido=" + f3(rep) + " una vez=" + f3(c1));
    }

    // ── 6 · el texto de class10 sigue siendo casi comun, y hay que decirlo ──
    //
    // El arreglo NO convierte a class21 en un aportante transversal por si
    // solo: el texto de mercado es sintetico y dice lo mismo para los 50.
    std::cout << "\n6 · En el camino de MERCADO sigue siendo casi constante\n";
    {
        const double a = coherencia_dominio("market features XLK chg=0.012 est=1 rel=0.004");
        const double b = coherencia_dominio("market features XLE chg=-0.008 est=0 rel=-0.011");
        const double c = coherencia_dominio("market features EWZ chg=0.003 est=0.5 rel=0.001");
        chk(a == b && b == c,
            "los tres instrumentos dan el MISMO valor — es un termino comun",
            f3(a));
        chk(a > 0.3, "ya no es el piso, pero no distingue instrumentos",
            "un termino comun no mueve un puesto del ranking");
    }

    // ── 7 · EL OTRO ARREGLO: class21 publica siempre ────────────────────────
    std::cout << "\n7 · El envelope sale igual cuando NO pasa el umbral\n";
    {
        const std::vector<double> vec = {0.1, 0.2, 0.3, 0.4};
        // score 0.40 contra umbral 0.768: con la regla vieja esto no se publicaba
        const json noPasa = armarSalida21("market features XLK chg=0.01", "XLK",
                                          "mercado", "class19", vec,
                                          0.40, 0.50, 0.475, 0.40, 0.768, false, 99);
        const json siPasa = armarSalida21("market features XLK chg=0.01", "XLK",
                                          "mercado", "class19", vec,
                                          0.90, 0.80, 0.475, 0.85, 0.768, true, 100);

        chk(noPasa.contains("score") && noPasa["score"].get<double>() == 0.40,
            "lleva su score aunque no pase", f3(noPasa["score"].get<double>()));
        chk(noPasa["pasa"].get<bool>() == false && siPasa["pasa"].get<bool>() == true,
            "y el juicio del filtro viaja como DATO, no como silencio");
        chk(noPasa["umbral_propio"].get<double>() == 0.768,
            "con el umbral propio del instrumento, para poder auditarlo");

        // Lo que class25A necesita para contar el modulo y armar la ventana.
        chk(noPasa["symbol"] == "XLK" && noPasa["ticker"] == "XLK",
            "el instrumento va en la raiz (asi class25A elige la ventana)");
        chk(noPasa["source"] == "class21",
            "y el `source` es class21, que es como class25A cuenta el modulo");
        chk(noPasa.contains("fuente") && noPasa["fuente"] == "mercado",
            "la `fuente` se propaga: es parte de la clave de peso");
        chk(noPasa["data"]["meta"]["coherencia"].get<double>() == 0.475,
            "y la coherencia queda en meta, medible desde el chequeo");

        // El nivel sigue saliendo de los mismos tres cortes: no aparece un
        // valor nuevo que un consumidor viejo no sepa leer.
        const std::string n1 = noPasa["senal"].get<std::string>();
        const std::string n2 = siPasa["senal"].get<std::string>();
        chk((n1 == "CONFIANZA_BAJA" || n1 == "CONFIANZA_MEDIA" || n1 == "ALTA_CONFIANZA") &&
            (n2 == "CONFIANZA_BAJA" || n2 == "CONFIANZA_MEDIA" || n2 == "ALTA_CONFIANZA"),
            "`senal` no estrena valores nuevos", n1 + " / " + n2);
        chk(n1 == "CONFIANZA_BAJA" && n2 == "ALTA_CONFIANZA",
            "y sigue saliendo de los mismos cortes 0.45 / 0.70");
    }

    // ── 8 · el interruptor de vuelta ────────────────────────────────────────
    std::cout << "\n8 · El interruptor para volver atras existe\n";
    {
        // Sin la variable, el modo legado tiene que estar APAGADO: el arreglo
        // viaja encendido porque es un defecto, no una funcion nueva.
        chk(solo_aprobados_21() == false,
            "sin CLASS21_SOLO_APROBADOS, class21 publica siempre (el arreglo)",
            "solo_aprobados=false");
    }

    std::cout << "\n------------------------------------------------------------\n";
    if (g_fallas == 0)
        std::cout << "PASA — class21 multilingue y votando siempre  (" << g_ok << " ok, 0 fallas)\n";
    else
        std::cout << "FALLA — " << g_fallas << " de " << (g_ok + g_fallas) << "\n";
    std::cout << "------------------------------------------------------------\n\n";
    return g_fallas == 0 ? 0 : 1;
}
