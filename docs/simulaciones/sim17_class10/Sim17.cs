// ============================================================
// sim17 — el vector de class10 con el universo dinámico
// ============================================================
//
// QUÉ GUARDA. Hasta el 26-sep-2026 `FromSectorStatePerTicker` construía el
// vector con tres bloques indexados por POSICIÓN del instrumento dentro de una
// lista FIJA de 13 (`SectorIndex10.ETFs`). Eso tenía dos consecuencias, las dos
// medidas sobre el código y ninguna visible en ejecución:
//
//   1. `OfEtf`/`OfSector` devolvían -1 para cualquier ticker fuera de la lista y
//      el bucle hacía `continue`: con el universo en 50, los 37 nuevos **no
//      recibían vector NINGUNO**. Sin error, sin aviso.
//   2. Y arreglar sólo eso no alcanzaba: `ctx[17 + i]` con i hasta 49 se va de
//      rango en un `double[64]` y tira IndexOutOfRange.
//
// Ahora el contexto son 10 estadísticos de la sección transversal, así que el
// ancho no depende del tamaño del universo. Esta prueba lo verifica sobre
// **datos reales de mercado** (80 ventanas del volcado) y además bajo una
// **locale con coma decimal**, que es el riesgo concreto de correr en Ubuntu con
// LANG=es_AR.UTF-8.
//
//   dotnet run --project docs/simulaciones/sim17_class10

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;

public static class Sim17
{
    static int _ok, _fail;

    static void Chk(bool cond, string titulo, string nota = "")
    {
        if (cond) { _ok++;   Console.WriteLine($"   [ok] {titulo,-58} {nota}"); }
        else      { _fail++; Console.WriteLine($"   [FALLA] {titulo,-55} {nota}"); }
    }

    static void Titulo(string s) => Console.WriteLine($"\n{s}");

    // Los 50 de config/universo.json. Se listan acá a mano A PROPÓSITO: si
    // alguien cambia el JSON, esta prueba sigue verificando que el vector
    // funciona con 50 entradas cualesquiera, que es la propiedad que importa.
    static readonly string[] U13 = {
        "XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU","XLC","ARGT","EWZ","ILF" };
    static readonly string[] U50 = {
        "XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU","XLC","XLP",
        "SPY","QQQ","IWM","DIA","EFA","EEM",
        "EWJ","EWG","EWU","EWL","EWY","EWT","EWH","EWA","INDA","FXI","EWC","EWW",
        "ARGT","EWZ","ILF",
        "SMH","XBI","VNQ","XOP","KRE","ITB","JETS","IYT","XME","GDX","XRT","ARKK",
        "MTUM","QUAL","VTV","VUG","USMV","IWF" };

    /// Arma un payload `sector_state` igual al que publica class7.
    static JsonElement Payload(Dictionary<string, double> p0,
                               Dictionary<string, double> p1,
                               IEnumerable<string> tickers,
                               double riesgoGlobal = 0.5)
    {
        var sectors = new List<object>();
        foreach (var t in tickers)
        {
            if (!p0.TryGetValue(t, out var a) || !p1.TryGetValue(t, out var b)) continue;
            double chg = a > 0 ? (b - a) / a * 100.0 : 0.0;
            sectors.Add(new {
                sector = "Sector " + t,          // nombre irrelevante: manda `etf`
                etf    = t,
                change = chg,
                state  = chg > 0.15 ? "up" : chg < -0.15 ? "down" : "neutral",
                precio = b,
                open   = a,
                riesgo = 0.5,
            });
        }
        var json = JsonSerializer.Serialize(new {
            source = "class7", type = "sector_state", riesgoGlobal, sectors });
        return JsonDocument.Parse(json).RootElement;
    }

    /// Precios sintéticos para los 37 que no están en el extracto del volcado.
    /// Se marcan como sintéticos a propósito: lo que esta prueba verifica de
    /// ellos es ESTRUCTURAL (que reciban vector), no estadístico.
    static void CompletarSinteticos(Dictionary<string, double> p0,
                                    Dictionary<string, double> p1, int semilla)
    {
        var rnd = new Random(semilla);
        foreach (var t in U50)
        {
            if (p0.ContainsKey(t)) continue;
            double baseP = 20.0 + rnd.NextDouble() * 400.0;     // 20 a 420
            double r     = (rnd.NextDouble() - 0.5) * 0.04;      // ±2 %
            p0[t] = Math.Round(baseP, 2);
            p1[t] = Math.Round(baseP * (1 + r), 2);
        }
    }

    const int DIM = 22;   // lo que esta prueba espera; se compara contra el código

    public static int Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine("\n══════════════════════════════════════════════════════════════");
        Console.WriteLine("  sim17 · el vector de class10 con el universo dinámico");
        Console.WriteLine("══════════════════════════════════════════════════════════════");

        // ── Datos reales del volcado ──────────────────────────────────────
        string raiz = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
                                                    "..", "..", "..", "..", "..", ".."));
        string ruta = Path.Combine(raiz, "docs", "simulaciones", "datos", "precios_ventanas.json");
        if (!File.Exists(ruta))
        {
            Console.WriteLine($"   [FALLA] no encuentro {ruta}");
            return 1;
        }
        var doc   = JsonDocument.Parse(File.ReadAllText(ruta));
        var casos = doc.RootElement.GetProperty("casos");
        Console.WriteLine($"\n      datos: {casos.GetArrayLength()} ventanas REALES de `precios` " +
                          $"({doc.RootElement.GetProperty("_origen").GetString()})");

        var ventanas = new List<(Dictionary<string,double> p0, Dictionary<string,double> p1)>();
        foreach (var c in casos.EnumerateArray())
        {
            var a = new Dictionary<string,double>();
            var b = new Dictionary<string,double>();
            foreach (var kv in c.GetProperty("p0").EnumerateObject()) a[kv.Name] = kv.Value.GetDouble();
            foreach (var kv in c.GetProperty("p1").EnumerateObject()) b[kv.Name] = kv.Value.GetDouble();
            ventanas.Add((a, b));
        }

        // ── 1 · El ancho del vector ───────────────────────────────────────
        Titulo("1 · El ancho del vector ya no depende del universo");
        Chk(MarketFeatureExtractor10.DIM_TICKER == DIM,
            "class10 declara DIM_TICKER = 22",
            $"código={MarketFeatureExtractor10.DIM_TICKER} prueba={DIM}");

        var (q0, q1) = ventanas[0];
        var v13 = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(q0, q1, U13));
        Chk(v13.Count == 13, "con 13 instrumentos salen 13 vectores", $"{v13.Count}");
        Chk(v13.All(t => t.Vec.Length == DIM), $"y todos de {DIM} dims",
            v13.Count > 0 ? $"{v13[0].Vec.Length}" : "");

        var p0_50 = new Dictionary<string,double>(q0);
        var p1_50 = new Dictionary<string,double>(q1);
        CompletarSinteticos(p0_50, p1_50, 17);
        var v50 = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(p0_50, p1_50, U50));
        Chk(v50.Count == 50, "con 50 instrumentos salen 50 vectores",
            $"{v50.Count}  (el código viejo daba 13: los 37 nuevos se descartaban)");
        Chk(v50.All(t => t.Vec.Length == DIM), $"y siguen siendo {DIM} dims — ancho FIJO",
            "ampliar el universo no cambia una sola dimensión");

        // Los 37 que antes se caían, uno por uno.
        var salieron = new HashSet<string>(v50.Select(t => t.Symbol));
        var nuevos   = U50.Where(t => !U13.Contains(t)).ToArray();
        int faltan   = nuevos.Count(t => !salieron.Contains(t));
        Chk(faltan == 0, $"los {nuevos.Length} instrumentos nuevos reciben vector",
            faltan == 0 ? "ninguno descartado" : $"{faltan} SIN vector");

        // ── 2 · Ninguna dimensión muerta ──────────────────────────────────
        Titulo("2 · Ninguna dimensión queda siempre en cero");
        var nuncaDistintoDeCero = new bool[DIM];
        for (int d = 0; d < DIM; d++) nuncaDistintoDeCero[d] = true;
        int nVentanas = 0;
        foreach (var (a, b) in ventanas)
        {
            var vs = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(a, b, U13));
            foreach (var tv in vs)
                for (int d = 0; d < DIM; d++)
                    if (Math.Abs(tv.Vec[d]) > 1e-9) nuncaDistintoDeCero[d] = false;
            nVentanas++;
        }
        var muertas = Enumerable.Range(0, DIM).Where(d => nuncaDistintoDeCero[d]).ToArray();
        Chk(muertas.Length == 0,
            "las 22 dims toman valor en las 80 ventanas reales",
            muertas.Length == 0
                ? "0 muertas  (el layout viejo tenía 13: simCrisis 12-16 y 56-63)"
                : "muertas: " + string.Join(",", muertas));

        // ── 3 · Qué es propio y qué es compartido ─────────────────────────
        Titulo("3 · 8 dims propias del instrumento, 14 compartidas");
        var w = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(q0, q1, U13));
        int propias = 0, compartidas = 0;
        for (int d = 0; d < DIM; d++)
        {
            bool todasIguales = w.All(t => Math.Abs(t.Vec[d] - w[0].Vec[d]) < 1e-12);
            if (todasIguales) compartidas++; else propias++;
        }
        Chk(propias >= 6, "al menos 6 dims difieren entre instrumentos",
            $"propias={propias} compartidas={compartidas}");
        // Las 10 de la distribución (12-21) TIENEN que ser idénticas: describen la
        // sección, no al instrumento. Si alguna variara, se filtró algo propio.
        bool distrIdentica = Enumerable.Range(12, 10)
            .All(d => w.All(t => Math.Abs(t.Vec[d] - w[0].Vec[d]) < 1e-12));
        Chk(distrIdentica, "las 10 de la distribución son idénticas en la ventana",
            "describen la sección transversal, no al instrumento");
        // Y las 8 primeras tienen que variar en al menos una.
        bool propiasVarian = Enumerable.Range(0, 8)
            .Any(d => w.Any(t => Math.Abs(t.Vec[d] - w[0].Vec[d]) > 1e-9));
        Chk(propiasVarian, "las dims 0-7 varían por instrumento", "");

        // ── 4 · Independencia del tamaño declarado ────────────────────────
        Titulo("4 · Los estadísticos dependen de lo que LLEGÓ, no de una lista fija");
        // Mismos 13 valores, pero el payload declara 50 tickers de los cuales
        // sólo 13 traen precio: el resto se saltea por falta de dato. Los
        // estadísticos tienen que dar EXACTAMENTE lo mismo que con 13.
        var soloTrece = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(q0, q1, U50));
        Chk(soloTrece.Count == 13,
            "un payload de 50 con datos de 13 produce 13 vectores",
            $"{soloTrece.Count}");
        bool mismos = soloTrece.Count == 13 && Enumerable.Range(12, 10).All(d =>
            Math.Abs(soloTrece[0].Vec[d] - w.First(t => t.Symbol == soloTrece[0].Symbol).Vec[d]) < 1e-12);
        Chk(mismos, "y los mismos 10 estadísticos, dígito por dígito",
            "el vector no mira ninguna lista fija");

        // ── 5 · Rango [0,1] ──────────────────────────────────────────────
        Titulo("5 · Todas las dims quedan en [0,1] (lo que class19 y las redes esperan)");
        double min = double.MaxValue, max = double.MinValue;
        int finitas = 0, total = 0;
        foreach (var (a, b) in ventanas)
        {
            var vs = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(a, b, U13));
            foreach (var tv in vs) foreach (var x in tv.Vec)
            {
                total++;
                if (double.IsFinite(x)) finitas++;
                min = Math.Min(min, x); max = Math.Max(max, x);
            }
        }
        Chk(finitas == total, "ningún NaN ni infinito", $"{finitas}/{total}");
        Chk(min >= -1e-9 && max <= 1 + 1e-9, "rango dentro de [0,1]",
            $"[{min:F6} .. {max:F6}]");

        // ── 6 · Empates: puesto promedio ─────────────────────────────────
        Titulo("6 · Los empates se reparten el puesto PROMEDIO");
        // Cinco instrumentos con el MISMO change: sin promediar, el orden lo
        // decidiría el orden de llegada del payload. Es la misma regla que
        // `ubicarEnSeccion` de class25A y `rangos()` de rank_ic.py — si
        // difirieran, el IC mediría un orden que el sistema no tomó.
        var pe0 = new Dictionary<string,double>();
        var pe1 = new Dictionary<string,double>();
        foreach (var t in U13) { pe0[t] = 100.0; pe1[t] = 101.0; }   // +1 % todos
        var emp = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(pe0, pe1, U13));
        bool rankMedio = emp.All(t => Math.Abs(t.Vec[5] - 0.5) < 1e-9);
        Chk(rankMedio, "con los 13 empatados, todos quedan en el rank 0,5",
            rankMedio ? "nadie gana por orden de llegada"
                      : "rangos: " + string.Join(" ", emp.Select(t => t.Vec[5].ToString("F3"))));
        bool relCero = emp.All(t => Math.Abs(t.ChangeRelativo) < 1e-9);
        Chk(relCero, "y el change relativo es 0 para todos", "no hay sección que ordenar");

        // ── 7 · Completitud del dato ─────────────────────────────────────
        Titulo("7 · `confianza` mide completitud del dato, no el layout");
        var inc0 = new Dictionary<string,double>(q0);
        var inc1 = new Dictionary<string,double>(q1);
        inc0["XLK"] = 0;                       // sin `open`: el proveedor falló
        var incompleto = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(inc0, inc1, U13));
        var xlk   = incompleto.FirstOrDefault(t => t.Symbol == "XLK");
        var otros = incompleto.Where(t => t.Symbol != "XLK").ToList();
        Chk(xlk != null && xlk.Completitud < 1.0,
            "un instrumento sin `open` baja su completitud",
            xlk != null ? $"XLK={xlk.Completitud:F2}" : "XLK ausente");
        Chk(otros.Count > 0 && otros.All(t => Math.Abs(t.Completitud - 1.0) < 1e-9),
            "y los que tienen dato completo quedan en 1,00",
            $"{otros.Count} instrumentos");

        // ── 8 · La misma corrida bajo locale con COMA decimal ─────────────
        // Es el riesgo real de Ubuntu con LANG=es_AR.UTF-8 / es_ES.UTF-8: un
        // `double.Parse` o un `ToString()` sensible a la cultura cambia de
        // comportamiento y los números salen distintos SIN error.
        Titulo("8 · Bajo locale es-AR (coma decimal) — el riesgo de Ubuntu");
        // OJO CON EL MÉTODO. `_changeHist` es estático y AVANZA en cada llamada
        // (es el historial rodante de 20 muestras del que sale volProp, dim 4),
        // así que dos llamadas seguidas con el MISMO payload ya difieren en esa
        // dim. La primera versión de esta prueba comparaba una corrida contra la
        // otra y daba 9,4e-3 de diferencia: parecía un bug de locale y era el
        // historial avanzando. Es el mismo error que este proyecto viene
        // cazando — atribuirle una causa a una diferencia sin medir la
        // diferencia de referencia.
        //
        // Así que primero se mide la DERIVA propia de dos llamadas bajo la
        // MISMA cultura, y después se exige que con coma decimal la diferencia
        // no sea mayor que ésa. Si el locale afectara algo, la segunda
        // diferencia sería mucho más grande.
        Func<List<double[]>> corrida = () =>
            MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(q0, q1, U13))
                .OrderBy(t => t.Symbol).Select(t => (double[])t.Vec.Clone()).ToList();
        Func<List<double[]>, List<double[]>, (double max, int dim)> difMax = (x, y) =>
        {
            double m = 0; int dd = -1;
            for (int i = 0; i < Math.Min(x.Count, y.Count); i++)
                for (int d = 0; d < DIM; d++)
                {
                    double e = Math.Abs(x[i][d] - y[i][d]);
                    if (e > m) { m = e; dd = d; }
                }
            return (m, dd);
        };

        var a1 = corrida();
        var a2 = corrida();                       // misma cultura: sólo deriva
        var (derivaMax, derivaDim) = difMax(a1, a2);
        Console.WriteLine($"      deriva entre dos llamadas iguales: {derivaMax:E1} " +
                          $"(dim {derivaDim} = volProp, el historial rodante avanza)");

        var previa = Thread.CurrentThread.CurrentCulture;
        double locMax; int locDim; int nEs;
        List<double[]> b1;
        try
        {
            var esAR = new CultureInfo("es-AR");
            Thread.CurrentThread.CurrentCulture   = esAR;
            Thread.CurrentThread.CurrentUICulture = esAR;
            Console.WriteLine($"      cultura activa: {CultureInfo.CurrentCulture.Name} · " +
                              $"separador decimal = '{CultureInfo.CurrentCulture.NumberFormat.NumberDecimalSeparator}'");
            b1 = corrida();
            nEs = b1.Count;
            (locMax, locDim) = difMax(a2, b1);
        }
        finally
        {
            Thread.CurrentThread.CurrentCulture   = previa;
            Thread.CurrentThread.CurrentUICulture = previa;
        }
        Console.WriteLine($"      con coma decimal:                  {locMax:E1} (dim {locDim})");
        Chk(nEs == 13, "con coma decimal salen los 13 vectores igual", $"{nEs}");
        // El umbral es la deriva propia, con un margen de 2×: si el locale
        // metiera mano, la diferencia saltaría órdenes de magnitud (un
        // double.Parse que interpreta "0.5" como 5 no se equivoca por 1e-3).
        Chk(locMax <= Math.Max(derivaMax * 2, 1e-12),
            "y la diferencia NO supera la deriva propia del historial",
            $"{locMax:E1} <= {Math.Max(derivaMax * 2, 1e-12):E1}");
        // Prueba directa e independiente de la anterior: los estadísticos de la
        // distribución (12-21) NO dependen del historial, así que con coma
        // decimal tienen que ser idénticos dígito por dígito.
        double distMax = 0;
        for (int i = 0; i < 13; i++)
            for (int d = 12; d < DIM; d++)
                distMax = Math.Max(distMax, Math.Abs(a2[i][d] - b1[i][d]));
        Chk(distMax < 1e-12,
            "los 10 estadísticos, idénticos dígito por dígito",
            $"dif. = {distMax:E1}  (no dependen del historial: prueba limpia del locale)");

        // ── 9 · Cómo se ve la sección con datos reales ────────────────────
        Titulo("9 · La sección transversal sobre una ventana real");
        var muestra = MarketFeatureExtractor10.FromSectorStatePerTicker(Payload(q0, q1, U13));
        Console.WriteLine("      ticker   chg%     rel%     rank    z(d6)   q50(d14)");
        foreach (var t in muestra.OrderByDescending(t => t.Change).Take(4))
            Console.WriteLine($"      {t.Symbol,-7} {t.Change,7:F3} {t.ChangeRelativo,8:F3} " +
                              $"{t.Vec[5],7:F3} {t.Vec[6],7:F3} {t.Vec[14],9:F4}");
        Console.WriteLine("      …");
        foreach (var t in muestra.OrderBy(t => t.Change).Take(2))
            Console.WriteLine($"      {t.Symbol,-7} {t.Change,7:F3} {t.ChangeRelativo,8:F3} " +
                              $"{t.Vec[5],7:F3} {t.Vec[6],7:F3} {t.Vec[14],9:F4}");
        double sumaRel = muestra.Sum(t => t.ChangeRelativo);
        Chk(Math.Abs(sumaRel) < 1e-9,
            "los change relativos suman 0 — la vara es el promedio de la ventana",
            $"suma = {sumaRel:E1}");

        // ── Resumen ──────────────────────────────────────────────────────
        Console.WriteLine($"\n{(_fail == 0 ? "PASA" : "FALLA")} — vector de class10  " +
                          $"({_ok} ok, {_fail} fallas, {nVentanas} ventanas reales)\n");
        return _fail == 0 ? 0 : 1;
    }
}
