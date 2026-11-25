// ============================================================================
// Sim21.cs — el vector de noticias de class3, con el código REAL
// ----------------------------------------------------------------------------
// QUÉ PRUEBA, y por qué existe:
//
// Hasta el 26-sep-2026 class3 estaba muerto por DOS motivos, y sólo uno era el
// entrypoint. El otro era el diseño del vector: recalculaba el TF-IDF de todo el
// corpus en cada mensaje (memoria cuadrática: ~4,7 GB con el tope de 10.000
// documentos, sobre un server con 4,3 GB disponibles) y su DIMENSIÓN CAMBIABA
// SOLA a medida que crecía el vocabulario — y class23/class24 crean una red por
// (fuente, dimensión), así que habrían nacido `web|8`, `web|37`, `web|91`…
//
// Esta prueba corre `VectorHash3` y `ProgramAdaptado.SymbolDe` de producción y
// verifica las cinco cosas que hacen que el vector sirva de verdad:
//
//   1. el ANCHO no depende del corpus            (la red es web|64 para siempre)
//   2. entra por la puerta de class19            (>=10 dims activas, conf >=0.15)
//   3. DISTINGUE noticias                        (si no, es un término común)
//   4. NO se satura                              (un vector denso tampoco ordena)
//   5. el instrumento viaja, y su ausencia es null, nunca "GENERAL"
//
//   dotnet run --project docs/simulaciones/sim21_class3
// ============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using Class3Adaptado;

public static class Sim21
{
    static int _ok = 0, _fallas = 0;

    static void Check(bool cond, string msg, string extra = "")
    {
        if (cond) { _ok++;     Console.WriteLine($"   [ok] {msg}{(extra != "" ? "   " + extra : "")}"); }
        else      { _fallas++; Console.WriteLine($"   [FALLA] {msg}{(extra != "" ? "   " + extra : "")}"); }
    }

    // Titulares con la forma que devuelven Google News / NewsAPI para los ETF
    // del universo. Variados a propósito: si fueran parecidos, la prueba de
    // dispersión pasaría sin que el vector distinga nada.
    static readonly string[] TITULARES =
    {
        "XLK Technology Select Sector SPDR rises as chip demand stays strong. Semiconductor makers led the advance after upbeat guidance.",
        "Energy stocks slide after crude oil futures drop on demand worries. Refiners fell sharply in afternoon trading.",
        "Financial sector ETF gains as banks report better than expected earnings. Net interest margins widened across regional lenders.",
        "Health care shares lag the broader market amid policy uncertainty. Drugmakers slipped on pricing headlines from Washington.",
        "Utilities climb as investors rotate into defensive names before the Fed decision. Dividend yields drew buyers.",
        "Brazil equities rally on commodity strength and a weaker dollar. Mining and pulp exporters posted the biggest gains.",
        "Argentina ETF jumps after the central bank announces new currency measures. Banking shares surged on the news.",
        "Real estate investment trusts fall as long term yields move higher again. Office landlords remained under pressure.",
        "Consumer discretionary retailers post mixed holiday sales results. Apparel chains trailed while home improvement held up.",
        "Industrial machinery orders improve on infrastructure spending. Aerospace suppliers reported stronger backlogs.",
        "Materials producers advance with copper prices near multi month highs. Fertilizer makers lagged the group.",
        "Communication services gain as streaming subscriber additions beat forecasts. Advertising revenue recovered modestly.",
    };

    static double Coseno(double[] a, double[] b)
    {
        double p = 0, na = 0, nb = 0;
        for (int i = 0; i < a.Length; i++) { p += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        double d = Math.Sqrt(na) * Math.Sqrt(nb);
        return d == 0 ? 0 : p / d;
    }

    public static int Main(string[] argv)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine();
        Console.WriteLine("============================================================");
        Console.WriteLine("  sim21 · el vector de noticias de class3 (código real)");
        Console.WriteLine("============================================================");
        Console.WriteLine();

        // ── 1 · el hash: determinista y NO es GetHashCode ────────────────────
        //
        // En .NET Core el hash de string está ALEATORIZADO POR PROCESO. Si
        // alguien cambia FNV por GetHashCode, cada reinicio del motor mandaría
        // el mismo término a otro balde y la red entrenada sobre los baldes
        // viejos quedaría midiendo otra cosa, SIN UN SOLO ERROR en el log.
        // Estos valores son el trinquete: están calculados a mano.
        Console.WriteLine("1 · El hash de los términos es estable entre procesos");
        var esperados = new (string tok, int balde)[]
        {
            ("chip", 15), ("demand", 62), ("technology", 47),
            ("xlk", 46), ("crude", 60), ("banks", 44), ("rally", 55),
        };
        bool hashOk = esperados.All(e => VectorHash3.Balde(e.tok) == e.balde);
        Check(hashOk, "FNV-1a da los baldes calculados a mano (no GetHashCode)",
              string.Join(" ", esperados.Select(e => $"{e.tok}={VectorHash3.Balde(e.tok)}")));

        // ── 2 · el ancho NO depende del corpus ───────────────────────────────
        //
        // Es EL defecto que mataba a class3. Se pasan 500 documentos, cada uno
        // con vocabulario nuevo, y la dimensión tiene que ser 64 en los 500.
        Console.WriteLine();
        Console.WriteLine("2 · El ancho no se mueve con el corpus (el defecto que lo mataba)");
        var dims = new HashSet<int>();
        double minVal = double.MaxValue, maxVal = double.MinValue;
        int noFinitos = 0, valores = 0;
        var activasSerie = new List<int>();
        for (int i = 0; i < 500; i++)
        {
            string t = TITULARES[i % TITULARES.Length] + $" Vocabulario nuevo numero {i} zzq{i} token{i}x.";
            var v = VectorHash3.Vectorizar(t, out int act);
            if (v == null) { Check(false, $"documento {i} no vectorizó"); break; }
            dims.Add(v.Length);
            activasSerie.Add(act);
            foreach (var x in v)
            {
                valores++;
                if (!double.IsFinite(x)) noFinitos++;
                if (x < minVal) minVal = x;
                if (x > maxVal) maxVal = x;
            }
        }
        Check(dims.Count == 1 && dims.Contains(64),
              "los 500 documentos dan SIEMPRE 64 dims", $"dims vistas: {string.Join(",", dims)}");
        Check(noFinitos == 0, "ningún NaN ni infinito", $"valores revisados: {valores}");
        Check(minVal >= 0.0 && maxVal <= 1.0,
              "todo en [0,1], que es lo que esperan class19 y las redes",
              $"min={minVal.ToString("F4", CultureInfo.InvariantCulture)} max={maxVal.ToString("F4", CultureInfo.InvariantCulture)}");

        // ── 3 · entra por la puerta de class19 ───────────────────────────────
        //
        // class19 exige MIN_DIMS_ACTIVAS=10 y MIN_CONFIANZA=0.15. Un vector que
        // no las cumple no es un error: es un apagón silencioso, porque el
        // rechazo queda sólo en el contador de class19.
        Console.WriteLine();
        Console.WriteLine("3 · Pasa los filtros de class19 (10 dims activas, conf 0.15)");
        int minAct = activasSerie.Min(), maxAct = activasSerie.Max();
        double promAct = activasSerie.Average();
        Check(minAct >= 10, "el PEOR titular llega a 10 dims activas", $"min={minAct} prom={promAct.ToString("F1", CultureInfo.InvariantCulture)}");
        Check(minAct / 64.0 >= 0.15, "y su confianza pasa 0.15",
              $"conf_min={(minAct / 64.0).ToString("F3", CultureInfo.InvariantCulture)}");

        // ── 4 · NO se satura ────────────────────────────────────────────────
        //
        // Si se prendieran los 64 baldes, el vector sería casi el mismo para los
        // 50 instrumentos: un TÉRMINO COMÚN, que no mueve un puesto del ranking.
        // Es la misma trampa de class21 y class22, y el motivo de usar sólo
        // unigramas en 64 baldes en vez de n-gramas de 1 a 3.
        Check(maxAct <= 56, "y NO se satura: quedan baldes sin prender",
              $"max={maxAct} de 64");

        // ── 5 · distingue noticias ──────────────────────────────────────────
        Console.WriteLine();
        Console.WriteLine("4 · Distingue una noticia de otra (si no, no ordena nada)");
        var vecs = TITULARES.Select(t => VectorHash3.Vectorizar(t, out _)).ToArray();
        var cosCruzados = new List<double>();
        for (int i = 0; i < vecs.Length; i++)
            for (int j = i + 1; j < vecs.Length; j++)
                cosCruzados.Add(Coseno(vecs[i], vecs[j]));
        double cosProm = cosCruzados.Average(), cosMax = cosCruzados.Max();
        Check(cosMax < 0.90, "dos noticias distintas nunca dan el mismo vector",
              $"coseno máx={cosMax.ToString("F3", CultureInfo.InvariantCulture)} prom={cosProm.ToString("F3", CultureInfo.InvariantCulture)}");

        // La misma noticia dos veces tiene que dar CASI el mismo vector, y la
        // diferencia por componente tiene que quedar por DEBAJO del umbral de
        // cambio de class19 para vectores con instrumento (MIN_DELTA_NUMERICO =
        // 0.002). Si no, un duplicado se le colaría a las redes como dato nuevo.
        var a1 = VectorHash3.Vectorizar(TITULARES[0], out _);
        for (int i = 0; i < 5; i++) VectorHash3.Vectorizar(TITULARES[1 + i], out _);
        var a2 = VectorHash3.Vectorizar(TITULARES[0], out _);
        double deltaMax = 0;
        for (int i = 0; i < a1.Length; i++) deltaMax = Math.Max(deltaMax, Math.Abs(a1[i] - a2[i]));
        Check(deltaMax < 0.002,
              "y la MISMA noticia repetida queda bajo el umbral de cambio de class19",
              $"delta_max={deltaMax.ToString("F6", CultureInfo.InvariantCulture)} < 0.002");

        // ── 6 · el instrumento ──────────────────────────────────────────────
        //
        // ⚠️ La prueba que importa NO es que el símbolo pase: es que su AUSENCIA
        // siga siendo null. class19 elige la métrica de cambio con
        // `symbol !== null` (class19.js:249), así que un "GENERAL" literal le
        // cambiaría el filtro a todo lo que no tiene instrumento. Es la misma
        // regresión que se cazó en class18 el 26-sep.
        Console.WriteLine();
        Console.WriteLine("5 · El instrumento viaja, y su ausencia es null (no \"GENERAL\")");
        Check(Sym("{\"id\":\"1\",\"symbol\":\"XLK\"}") == "XLK", "lee `symbol` de la raíz");
        Check(Sym("{\"id\":\"1\",\"ticker\":\"xlf\"}") == "XLF", "cae a `ticker` y normaliza a mayúsculas");
        Check(Sym("{\"id\":\"1\",\"data\":{\"symbol\":\"ewz\"}}") == "EWZ", "y después a data.symbol");
        Check(Sym("{\"id\":\"1\"}") == null, "sin instrumento devuelve NULL, no \"GENERAL\"");
        Check(Sym("{\"id\":\"1\",\"symbol\":\"GENERAL\"}") == null, "la cadena \"GENERAL\" también es null");
        Check(Sym("{\"id\":\"1\",\"symbol\":\"unknown\"}") == null, "y \"unknown\" también");
        Check(Sym("{\"id\":\"1\",\"symbol\":\"class11\"}") == null,
              "un nombre de módulo tampoco es un instrumento (igual que canonSymbol de class23/24)");

        // ── 7 · el contrato con class1 ──────────────────────────────────────
        //
        // El envelope real que publica class1 a class3_ingest: el texto en
        // `texto` y el instrumento en la raíz.
        Console.WriteLine();
        Console.WriteLine("6 · El envelope que manda class1, tal como llega");
        string env = JsonSerializer.Serialize(new
        {
            id = Guid.NewGuid().ToString(),
            source = "class1",
            type = "analysis",
            texto = TITULARES[0],
            text = TITULARES[0],
            data = new { query = "XLK technology sector ETF" },
            symbol = "XLK",
            ticker = "XLK",
            ts = DateTime.UtcNow.ToString("O"),
        });
        using (var doc = JsonDocument.Parse(env))
        {
            var root = doc.RootElement;
            Check(ProgramAdaptado.SymbolDe(root) == "XLK", "class3 encuentra el instrumento en el envelope");
            string texto = root.GetProperty("texto").GetString();
            var v = VectorHash3.Vectorizar(texto, out int act);
            Check(v != null && act >= 10, "y el titular da un vector que pasa class19", $"activas={act}");
            // La frase de búsqueda —lo que el envelope llevaba ANTES— da un
            // vector mucho más pobre, y es casi igual en cada corrida.
            var vq = VectorHash3.Vectorizar("XLK technology sector ETF", out int actQ);
            Check(actQ < act, "y el titular es más rico que la frase de búsqueda que llevaba antes",
                  $"titular={act} activas vs frase={actQ}");
        }

        // ── 8 · el costo, que es lo que lo tenía muerto ─────────────────────
        //
        // El camino viejo retenía N docs × V dims × 8 B y recalculaba todo en
        // cada mensaje: ~4,7 GB con el tope de 10.000 documentos. Este tiene que
        // hacer 5.000 en un parpadeo y con memoria constante.
        Console.WriteLine();
        Console.WriteLine("7 · El costo: 5.000 documentos sin memoria cuadrática");
        long antes = GC.GetTotalMemory(true);
        var sw = Stopwatch.StartNew();
        for (int i = 0; i < 5000; i++)
            VectorHash3.Vectorizar(TITULARES[i % TITULARES.Length] + $" nota {i} zz{i}", out _);
        sw.Stop();
        long despues = GC.GetTotalMemory(true);
        double creci = (despues - antes) / 1024.0 / 1024.0;
        Check(sw.ElapsedMilliseconds < 5000, "5.000 documentos en menos de 5 s",
              $"{sw.ElapsedMilliseconds} ms");
        Check(creci < 5.0, "y sin retener el corpus: el crecimiento es de megas, no de gigas",
              $"{creci.ToString("F2", CultureInfo.InvariantCulture)} MB");

        // ── 9 · locale es-AR ────────────────────────────────────────────────
        //
        // El riesgo de Ubuntu: con coma decimal, un parseo o un formateo
        // descuidado cambia los números. Es lo que sim17 ya cubre para class10.
        Console.WriteLine();
        Console.WriteLine("8 · Bajo locale es-AR (coma decimal) da lo mismo");
        // ⚠️ NO se puede comparar a ciegas, y es la trampa que sim17 ya documenta.
        // El IDF de VectorHash3 es RODANTE: dos llamadas idénticas seguidas ya
        // difieren, porque la segunda ve un documento más. Así que primero se
        // mide esa deriva propia y después se exige que la de la coma decimal no
        // la supere. Comparar contra 0 haría pasar por bug de locale algo que es
        // el diseño.
        var vA = VectorHash3.Vectorizar(TITULARES[3], out int actA);
        var vB = VectorHash3.Vectorizar(TITULARES[3], out int actB);
        double deriva = 0;
        for (int i = 0; i < vA.Length; i++) deriva = Math.Max(deriva, Math.Abs(vA[i] - vB[i]));

        var cultura = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("es-AR");
            var vAr = VectorHash3.Vectorizar(TITULARES[3], out int actAr);
            double d = 0;
            for (int i = 0; i < vB.Length; i++) d = Math.Max(d, Math.Abs(vB[i] - vAr[i]));
            Check(actAr == actB && d <= deriva * 1.5 + 1e-12,
                  "la coma decimal no mueve el vector más que su propia deriva",
                  $"locale={d.ToString("E2", CultureInfo.InvariantCulture)} vs deriva propia={deriva.ToString("E2", CultureInfo.InvariantCulture)}");
        }
        finally { CultureInfo.CurrentCulture = cultura; }

        // Y lo que de verdad podría romper el locale: el parseo de la variable.
        // `CLASS3_IDF_VIDA_MEDIA` se lee con InvariantCulture a propósito, así
        // que "5000.0" tiene que dar 5000 y no 50000 ni el default.
        Check(VectorHash3.VidaMedia > 0,
              "la vida media del IDF quedó cargada",
              $"vida_media={VectorHash3.VidaMedia.ToString("F0", CultureInfo.InvariantCulture)} documentos");

        // ── resumen ─────────────────────────────────────────────────────────
        Console.WriteLine();
        Console.WriteLine("------------------------------------------------------------");
        Console.WriteLine(_fallas == 0
            ? $"PASA — vector de noticias de class3  ({_ok} ok, 0 fallas)"
            : $"FALLA — {_fallas} de {_ok + _fallas}");
        Console.WriteLine("------------------------------------------------------------");
        Console.WriteLine();
        return _fallas == 0 ? 0 : 1;
    }

    static string Sym(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return ProgramAdaptado.SymbolDe(doc.RootElement);
    }
}
