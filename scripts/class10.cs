// ============================================================
// class10.cs — Motor de Features de Mercado (MIIA v2.0)
// ============================================================
// CORRECCIONES aplicadas:
//   1. ELIMINADO stub namespace StackExchange.Redis
//      → ahora usa el NuGet real (dotnet add package StackExchange.Redis)
//   2. ConnectAsync usa ConfigurationOptions con AbortOnConnectFail=false
//      → reintentos automáticos si Redis no está listo al arrancar
//   3. SubscribeAsync usa RedisChannel.Literal(ch)
//      → API correcta del NuGet real (string directo no funciona)
//   4. PublishAsync usa RedisChannel.Literal(ch)
//      → consistente con la API real
//   5. MotorVectorialTester.Main arranca class18 en background
//      → ambos motores corren en el mismo proceso (MOTORVECTORIAL)
//   6. Serilog sigue con stub propio (no instalado como NuGet todavía)
//
// ════════════════════════════════════════════════════════════
// ORDEN 1 (2026-08-03) — UN VECTOR POR INSTRUMENTO
// ════════════════════════════════════════════════════════════
// ANTES: un solo vector agregado con los 10 sectores adentro y sin `symbol`.
// Aguas abajo eso hacía que el sistema emitiera UNA predicción ("¿sube el
// mercado?"), con base rate ~78% — para superarla hay que acertar las caídas.
// AHORA: un envelope por cada uno de los 13 instrumentos, con `symbol`, para
// poder predecir "¿este ticker le gana al promedio?" (base rate ~50%).
//
// Vector de salida 64 dims [0,1] — PER TICKER:
//   0    : change_pct propio normalizado
//   1    : estado propio (1=up, 0.5=neutral, 0=down)
//   2    : precio relativo al open propio
//   3    : change RELATIVO al promedio de los 13     ← feature clave del label
//   4    : volatilidad propia (std del historial rolling)
//   5    : rank cross-seccional (0=peor, 1=mejor)
//   6    : z-score del change contra la sección transversal
//   7    : riesgo propio del sector (lo calcula class7)
//   8    : riesgoGlobal
//   9    : market_breadth (fracción "up")
//   10   : dispersión de la sección transversal
//   11   : momentum agregado
//   12-16: similitud con crisis históricas (class5)
//   17-29: change_pct de los 13 (contexto completo)
//   30-42: estado de los 13
//   43-55: precio relativo al open de los 13
//   56-63: reservado / ceros
//
// Instrumentos (13): XLK XLF XLE XLV XLY XLI XLB XLRE XLU XLC ARGT EWZ ILF
//   (ARGT/EWZ/ILF antes se descartaban: OfEtf() devolvía -1)
// ============================================================
#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading;
using System.Threading.Tasks;

// ── NuGet real: dotnet add package StackExchange.Redis ──────
// El stub fue eliminado. Con el NuGet instalado estos tipos
// vienen del paquete directamente.
using StackExchange.Redis;

// Serilog NuGet (v4.3.1) — usar Serilog.Log directamente, sin stub local

// ============================================================
// JSON options
// ============================================================
public static class JsonOpts10
{
    public static readonly JsonSerializerOptions D = new()
    {
        PropertyNameCaseInsensitive = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };
    public static readonly JsonSerializerOptions I = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };
}

// ============================================================
// Redis Config
// ============================================================
public static class RedisConfig10
{
    public static readonly string RedisUrl =
        Environment.GetEnvironmentVariable("REDIS_URL") ?? "localhost:6379";

    public static readonly string[] InputChannels =
    {
        "class10_ingest",
        "class7_output",   // sector ETFs: change_pct, precio, state, riesgoGlobal
        "class5_output",   // crisis históricas → similitud vectorial
        "class9_output"    // precios históricos → cache
    };

    public static readonly string OutputChannel = "class19_ingest";
    public static readonly string ReadyChannel  = "dotnet_ready";
    public static readonly string MotorID       = "class10_vectorial";
}

// ============================================================
// Paths
// ============================================================
public static class Paths10
{
    private static string Root() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));

    public static readonly string BaseDir    = Path.Combine(Root(), "operador", "aprendizaje");
    public static readonly string LogsDir    = Path.Combine(BaseDir, "logs");
    public static readonly string MetricsDir = Path.Combine(BaseDir, "metrics");

    public static void Ensure()
    {
        foreach (var d in new[] { LogsDir, MetricsDir })
            try { Directory.CreateDirectory(d); } catch { }
    }
}

// ============================================================
// Orden fijo de sectores — consistente con class7/class15
// ============================================================
public static class SectorIndex10
{
    // ⚠ ORDEN 1: el índice pasó de 10 a 13 instrumentos.
    //
    // ARGT, EWZ e ILF venían siendo DESCARTADOS acá: class7 los publica (ver su
    // mapa sector→etf) pero OfEtf() devolvía -1 y FromSectorState hacía `continue`.
    // Resultado: los tres instrumentos MENOS eficientes del universo —donde es
    // más plausible que exista señal— no tenían ni una dimensión en el vector
    // que alimenta a las redes.
    public static readonly string[] ETFs =
        { "XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU","XLC",
          "ARGT","EWZ","ILF" };

    public static readonly string[] Sectors =
    {
        "Technology","Financials","Energy","Healthcare",
        "Consumer Discretionary","Industrials","Materials",
        "Real Estate","Utilities","Communication Services",
        "MERVAL","Brazil","Latin America"
    };

    public static int Count => ETFs.Length;   // 13

    public static int OfEtf(string e)
    {
        if (string.IsNullOrEmpty(e)) return -1;
        string u = e.ToUpperInvariant();
        for (int i = 0; i < ETFs.Length; i++)
            if (ETFs[i] == u) return i;
        return -1;
    }

    public static int OfSector(string s)
    {
        if (string.IsNullOrEmpty(s)) return -1;
        for (int i = 0; i < Sectors.Length; i++)
            if (string.Equals(Sectors[i], s, StringComparison.OrdinalIgnoreCase)) return i;
        return -1;
    }
}

// ============================================================
// FEATURE EXTRACTOR — núcleo del motor
// Features matemáticas reales, sin TF-IDF
// ============================================================
public static class MarketFeatureExtractor10
{
    // Crisis históricas desde class5 (hasta 20 en memoria)
    private static readonly List<double[]> _crisisVectors = new();
    // Cache de precios para class43/class25
    private static readonly Dictionary<string, double> _priceCache = new();
    // Historial rolling de changes para volatilidad, POR SÍMBOLO.
    //
    // Estaba keyeado por `int idx`, la POSICIÓN del instrumento dentro de
    // SectorIndex10.ETFs. Con una lista fija de 13 eso funcionaba por accidente;
    // con el universo dinámico la posición no es estable —depende de qué
    // instrumentos vinieron en el payload— así que la volatilidad de XLK podía
    // calcularse sobre el historial de otro. La clave correcta siempre fue el
    // símbolo.
    private static readonly Dictionary<string, Queue<double>> _changeHist = new();

    // ── ANCHO DEL VECTOR POR INSTRUMENTO (26-sep-2026) ─────────────────────
    //
    // Era 64, con tres bloques indexados por POSICIÓN: dims 17-29 el change de
    // los 13, 30-42 su estado, 43-55 su precio relativo. Eso ataba el vector al
    // tamaño del universo, y de la peor manera:
    //
    //   · `OfEtf`/`OfSector` devolvían -1 para cualquier ticker fuera de la
    //     lista fija, y el bucle hacía `continue`: con el universo en 50, los 37
    //     nuevos NO recibían vector NINGUNO. No un vector a medias: ninguno. Y
    //     sin error, porque `continue` no avisa.
    //   · Y si se arreglaba sólo eso, `ctx[17 + i]` con i hasta 49 se va de
    //     rango en un double[64] y tira IndexOutOfRange. Los dos iban juntos.
    //
    // Ahora el bloque de contexto crudo se reemplaza por 10 ESTADÍSTICOS de la
    // sección transversal, que describen la misma distribución en un ancho fijo.
    // El vector deja de depender del tamaño del universo para siempre: ampliar a
    // 100 o bajar a 5 no cambia una sola dimensión.
    //
    // 22 = 8 propias del instrumento + 4 compartidas + 10 de la distribución.
    // NO hay dims de relleno: las 8 que sobraban en el layout viejo (56-63) eran
    // ceros permanentes, o sea capacidad de la red desperdiciada.
    //
    // ⚠️ LA CLAVE DE LA RED CAMBIA a `mercado|22`, y eso es deliberado: class23
    // y class24 keyean por "fuente|dim" justamente para que un cambio de
    // representación cree una red NUEVA en vez de reusar pesos entrenados sobre
    // otra escala. Se ve en el log al arrancar. El precio es que esa red
    // empieza de cero; la alternativa —pesos mal alineados en silencio— es el
    // modo de falla contra el que existe este proyecto.
    public const int DIM_TICKER = 22;

    public static void RegisterPrice(string ticker, double price)
    {
        if (!string.IsNullOrEmpty(ticker)) _priceCache[ticker] = price;
    }

    public static void RegisterCrisis(double[] v)
    {
        if (v?.Length > 0)
        {
            _crisisVectors.Add(v);
            if (_crisisVectors.Count > 20) _crisisVectors.RemoveAt(0);
        }
    }

    // Normalización: change_pct [-5%,+5%] → [0,1]
    private static double NormChange(double pct) =>
        Math.Max(0, Math.Min(1, (pct + 5.0) / 10.0));

    // Precio relativo al open: [-10%,+10%] → [0,1]
    private static double NormPriceRel(double precio, double open) =>
        open == 0 ? 0.5 : Math.Max(0, Math.Min(1, ((precio - open) / open + 0.1) / 0.2));

    // Estado: up→1, neutral→0.5, down→0
    private static double EncodeState(string s) =>
        s == "up" ? 1.0 : s == "down" ? 0.0 : 0.5;

    // Similitud coseno entre dos vectores
    private static double Coseno(double[] a, double[] b)
    {
        int n = Math.Min(a.Length, b.Length);
        double dot = 0, na = 0, nb = 0;
        for (int i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        double d = Math.Sqrt(na) * Math.Sqrt(nb);
        return d == 0 ? 0 : dot / d;
    }

    public static string GetStr(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() ?? "" : "";

    public static double GetDbl(JsonElement el, string name, double def = 0)
    {
        if (!el.TryGetProperty(name, out var p)) return def;
        if (p.TryGetDouble(out var d)) return d;
        if (p.ValueKind == JsonValueKind.String && double.TryParse(p.GetString(), out var s)) return s;
        return def;
    }

    // ── Vector desde sector_state de class7 ─────────────────
    // ════════════════════════════════════════════════════════════════════
    // ORDEN 1 — UN VECTOR POR INSTRUMENTO
    // ════════════════════════════════════════════════════════════════════
    //
    // POR QUÉ: hasta acá class10 emitía UN vector agregado con los 10 sectores
    // adentro, sin campo `symbol`. Aguas abajo eso significaba que el sistema
    // hacía UNA sola predicción ("¿sube el promedio del mercado?"), cuyo base
    // rate es ~78% en mercado alcista. Para superarlo hay que acertar las
    // caídas — el problema más difícil que existe.
    //
    // Con un vector por instrumento la pregunta pasa a ser "¿este ticker le
    // gana al promedio de los 13?", cuyo base rate es ~50% por construcción, y
    // además genera 13 muestras por ventana en vez de 1.
    //
    // LAYOUT (64 dims):
    //   [0]     NormChange propio
    //   [1]     EncodeState propio
    //   [2]     NormPriceRel propio
    //   [3]     change RELATIVO al promedio de los 13   ← la feature clave
    //   [4]     volatilidad propia (std del historial rolling)
    //   [5]     rank cross-seccional (0 = peor, 1 = mejor)
    //   [6]     z-score del change contra la sección transversal
    //   [7]     riesgo propio del sector (lo calcula class7)
    //   [8]     riesgoGlobal
    //   [9]     market_breadth
    //   [10]    dispersión de la sección transversal
    //   [11]    momentum de mercado
    //   [12-16] similitud con crisis históricas
    //   [17-29] NormChange de los 13 (contexto completo)
    //   [30-42] EncodeState de los 13
    //   [43-55] NormPriceRel de los 13
    //   [56-63] reservado (cero)
    //
    // Las dims 3, 5 y 6 son las que NO existían antes: describen la posición
    // del ticker DENTRO de la sección transversal, que es exactamente lo que
    // determina el retorno relativo. Sin ellas, pedirle a la red que prediga
    // "¿le gana al promedio?" sería pedirle que adivine.
    public sealed class TickerVector
    {
        public string Symbol { get; init; }
        public string Sector { get; init; }
        public double[] Vec  { get; init; }
        public double Change { get; init; }
        public double ChangeRelativo { get; init; }
        /// Fracción de los datos PROPIOS del instrumento que llegaron bien
        /// (precio, open, change, riesgo). Es lo que `confianza` siempre quiso
        /// medir: cuánto de esta observación es dato real. Ver la nota en
        /// PublishVectorsPerTicker.
        public double Completitud { get; init; } = 1.0;
    }

    // Una observación de la sección transversal. Reemplaza los siete arrays
    // paralelos indexados por posición: con el universo dinámico la posición no
    // significa nada, y mantener `syms[idx]`, `chg[idx]`… dimensionados por una
    // lista fija era justo lo que ataba el vector a 13 instrumentos.
    private sealed class Obs
    {
        public string Sym = "", Sector = "", State = "";
        public double Chg, Precio, Open, Riesgo;
    }

    // Cuantil por interpolación lineal sobre una lista YA ORDENADA.
    // Se usa el mismo método para los cinco, así que q10..q90 son comparables
    // entre sí y entre ventanas de distinto tamaño.
    private static double Cuantil(List<double> ordenada, double p)
    {
        int n = ordenada.Count;
        if (n == 0) return 0.0;
        if (n == 1) return ordenada[0];
        double pos = p * (n - 1);
        int lo = (int)Math.Floor(pos), hi = (int)Math.Ceiling(pos);
        if (lo == hi) return ordenada[lo];
        return ordenada[lo] + (pos - lo) * (ordenada[hi] - ordenada[lo]);
    }

    public static List<TickerVector> FromSectorStatePerTicker(JsonElement root)
    {
        var salida = new List<TickerVector>();
        if (!root.TryGetProperty("sectors", out var sArr) ||
            sArr.ValueKind != JsonValueKind.Array) return salida;

        double riesgoGlobal = GetDbl(root, "riesgoGlobal", 0.5);

        // ── Pasada 1: recolectar TODO lo que llegó ────────────────────────
        // Sin lista fija y sin índices. El símbolo sale del campo `etf`; si no
        // viene, se cae al mapa sector→etf, que sigue sirviendo para los
        // proveedores que mandan el sector y no el ticker (AlphaVantage).
        // Un instrumento que no se puede nombrar se saltea — pero ahora eso es
        // una excepción de datos, no la regla para 37 de 50.
        var obs = new List<Obs>();
        var vistos = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int sinNombre = 0;

        foreach (var s in sArr.EnumerateArray())
        {
            string etf    = GetStr(s, "etf");
            string sector = GetStr(s, "sector");
            string sym    = (etf ?? "").Trim().ToUpperInvariant();
            if (sym.Length == 0)
            {
                int idx = SectorIndex10.OfSector(sector);
                if (idx >= 0) sym = SectorIndex10.ETFs[idx];
            }
            if (sym.Length == 0) { sinNombre++; continue; }
            // El mismo ticker dos veces en un payload rompería la sección: se
            // queda el primero, que es el criterio del resto del sistema.
            if (!vistos.Add(sym)) continue;

            var o = new Obs {
                Sym    = sym,
                Sector = sector ?? "",
                Chg    = GetDbl(s, "change", 0),
                State  = GetStr(s, "state"),
                Precio = GetDbl(s, "precio", 0),
                Open   = GetDbl(s, "open",   0),
                Riesgo = GetDbl(s, "riesgo", 0.5),
            };
            obs.Add(o);

            if (!_changeHist.TryGetValue(sym, out var q))
            { q = new Queue<double>(20); _changeHist[sym] = q; }
            q.Enqueue(o.Chg);
            if (q.Count > 20) q.Dequeue();

            RegisterPrice(sym, o.Precio);
        }

        if (sinNombre > 0)
            Console.WriteLine($"[class10] ⚠️ {sinNombre} entradas de sector_state sin `etf` " +
                              $"ni sector reconocido — no entran a la sección transversal");
        if (obs.Count == 0) return salida;

        // ── Estadísticos de la sección transversal ────────────────────────
        var vivos    = obs.Select(o => o.Chg).ToList();
        double media = vivos.Average();
        double disp  = vivos.Count > 1
            ? Math.Sqrt(vivos.Select(c => (c - media) * (c - media)).Average())
            : 0.0;
        double breadth = (double)obs.Count(o => o.State == "up") / obs.Count;
        var positivos  = vivos.Where(c => c > 0).ToList();
        double moment  = positivos.Count > 0 ? Math.Min(1, positivos.Average() / 5.0) : 0;

        var ord = new List<double>(vivos); ord.Sort();
        double q10 = Cuantil(ord, 0.10), q25 = Cuantil(ord, 0.25),
               q50 = Cuantil(ord, 0.50), q75 = Cuantil(ord, 0.75),
               q90 = Cuantil(ord, 0.90);
        double peor = ord[0], mejor = ord[ord.Count - 1];
        double iqr  = q75 - q25;
        // Asimetría de Bowley: (q75 + q25 - 2·q50) / IQR, acotada en [-1,1] por
        // construcción. Se prefiere al tercer momento porque ése no está acotado
        // y con 5 instrumentos un outlier lo manda a cualquier parte — y acá
        // todas las dims tienen que vivir en [0,1].
        double skew = iqr > 1e-9 ? (q75 + q25 - 2.0 * q50) / iqr : 0.0;

        // Ranking: 0 = el que peor rindió, 1 = el mejor. Los EMPATES se reparten
        // el puesto promedio, igual que `ubicarEnSeccion` en class25A y `rangos`
        // en rank_ic.py. Sin eso, el orden de dos instrumentos con el mismo
        // change lo decidiría el orden de llegada del payload: ruido con forma
        // de señal, y encima distinto de cómo lo trata la decisión.
        var rank = new Dictionary<string, double>();
        {
            var porChg = obs.OrderBy(o => o.Chg).ToList();
            int i2 = 0;
            while (i2 < porChg.Count)
            {
                int j = i2;
                while (j + 1 < porChg.Count && porChg[j + 1].Chg == porChg[i2].Chg) j++;
                double medio = (i2 + j) / 2.0;
                double val   = porChg.Count > 1 ? medio / (porChg.Count - 1) : 0.5;
                for (int k = i2; k <= j; k++) rank[porChg[k].Sym] = val;
                i2 = j + 1;
            }
        }

        // ── Contexto COMPARTIDO: la distribución, no la lista ─────────────
        // Diez números que describen la sección transversal entera con un ancho
        // fijo. Antes eran 39 dims indexadas por posición; ahora ampliar el
        // universo no mueve una sola dimensión.
        var ctx = new double[DIM_TICKER];
        ctx[8]  = Math.Max(0, Math.Min(1, riesgoGlobal));
        ctx[9]  = breadth;
        ctx[10] = Math.Min(1, disp / 5.0);
        ctx[11] = moment;
        ctx[12] = NormChange(q10);
        ctx[13] = NormChange(q25);
        ctx[14] = NormChange(q50);
        ctx[15] = NormChange(q75);
        ctx[16] = NormChange(q90);
        ctx[17] = NormChange(mejor);
        ctx[18] = NormChange(peor);
        ctx[19] = Math.Max(0, Math.Min(1, (skew + 1.0) / 2.0));   // [-1,1] → [0,1]
        ctx[20] = Math.Min(1, iqr / 5.0);                          // misma escala que disp
        // Tamaño de la sección, normalizado. La red necesita saber sobre cuántos
        // instrumentos se calcularon los nueve de arriba: un q90 sobre 5 no dice
        // lo mismo que sobre 50. Se divide por 100 para que ampliar el universo
        // no sature la dim.
        ctx[21] = Math.Min(1, obs.Count / 100.0);

        // ── Pasada 2: un vector por instrumento ───────────────────────────
        foreach (var o in obs)
        {
            var vec = (double[])ctx.Clone();

            double chgRel = o.Chg - media;                  // el corazón del label relativo
            double zscore = disp > 1e-9 ? chgRel / disp : 0.0;

            double volProp = 0.0;
            if (_changeHist.TryGetValue(o.Sym, out var hist) && hist.Count > 1)
            {
                var h = hist.ToArray();
                double m = h.Average();
                volProp = Math.Min(1, Math.Sqrt(h.Select(c => (c - m) * (c - m)).Average()) / 5.0);
            }

            vec[0] = NormChange(o.Chg);
            vec[1] = EncodeState(o.State);
            vec[2] = NormPriceRel(o.Precio, o.Open);
            vec[3] = NormChange(chgRel);                    // relativo, misma escala que change
            vec[4] = volProp;
            vec[5] = rank.TryGetValue(o.Sym, out var rk) ? rk : 0.5;
            vec[6] = Math.Max(0, Math.Min(1, (zscore + 3.0) / 6.0));  // z ∈ [-3,3] → [0,1]
            vec[7] = Math.Max(0, Math.Min(1, o.Riesgo));

            salida.Add(new TickerVector {
                Symbol = o.Sym, Sector = o.Sector, Vec = vec,
                Change = o.Chg, ChangeRelativo = chgRel,
                // Completitud del dato PROPIO de este instrumento. Ver la nota
                // de `confianza` en PublishVectorsPerTicker.
                Completitud = (
                    (o.Precio > 0        ? 1 : 0) +
                    (o.Open   > 0        ? 1 : 0) +
                    (double.IsFinite(o.Chg) ? 1 : 0) +
                    (o.Riesgo >= 0 && o.Riesgo <= 1 ? 1 : 0)) / 4.0,
            });
        }

        return salida;
    }

    // ── Versión agregada (legacy) ────────────────────────────────────────
    // ⚠️ NO SE LLAMA DESDE NINGÚN LADO (verificado el 26-sep-2026): el único
    // consumidor de `class7_output`/sector_state es FromSectorStatePerTicker, y
    // el camino `class10_ingest` —que este comentario decía servir— publica el
    // vector inyectado TAL CUAL por PublishVector, sin pasar por acá.
    // Se conserva porque describe el layout viejo de 64 dims indexado por
    // posición, que es el que los pesos `mercado|64` vieron hasta el corte.
    // Si se borra, borrar también PublishVector si queda sin uso.
    public static double[] FromSectorState(JsonElement root)
    {
        if (!root.TryGetProperty("sectors", out var sArr) ||
            sArr.ValueKind != JsonValueKind.Array) return null;

        var vec = new double[64];
        double riesgoGlobal = GetDbl(root, "riesgoGlobal", 0.5);
        var changes = new List<double>();
        int upCount = 0, total = 0;

        foreach (var s in sArr.EnumerateArray())
        {
            string etf    = GetStr(s, "etf");
            string sector = GetStr(s, "sector");
            int idx = SectorIndex10.OfEtf(etf);
            if (idx < 0) idx = SectorIndex10.OfSector(sector);
            if (idx < 0) continue;

            double change = GetDbl(s, "change", 0);
            double precio = GetDbl(s, "precio", 0);
            double open   = GetDbl(s, "open",   0);
            string state  = GetStr(s, "state");

            vec[idx]      = NormChange(change);        // Dims 0-9
            vec[10 + idx] = EncodeState(state);        // Dims 10-19
            vec[20 + idx] = NormPriceRel(precio, open);// Dims 20-29

            // Historial rolling de changes para volatilidad, por SIMBOLO
            // (la clave dejo de ser la posicion: ver la nota de _changeHist).
            string symHist = string.IsNullOrEmpty(etf)
                           ? SectorIndex10.ETFs[idx] : etf.ToUpperInvariant();
            if (!_changeHist.TryGetValue(symHist, out var qHist))
            { qHist = new Queue<double>(20); _changeHist[symHist] = qHist; }
            qHist.Enqueue(change);
            if (qHist.Count > 20) qHist.Dequeue();

            if (!string.IsNullOrEmpty(etf)) RegisterPrice(etf, precio);
            if (state == "up") upCount++;
            total++;
            changes.Add(change);
        }

        // Dim 30: riesgoGlobal
        vec[30] = Math.Max(0, Math.Min(1, riesgoGlobal));

        // Dim 31: market_breadth (fracción sectores al alza)
        vec[31] = total > 0 ? (double)upCount / total : 0.5;

        // Dim 32: volatilidad (std dev de changes, normalizada)
        if (changes.Count > 1)
        {
            double mean = changes.Average();
            double var_ = changes.Select(c => (c - mean) * (c - mean)).Average();
            vec[32] = Math.Min(1, Math.Sqrt(var_) / 5.0);
        }

        // Dim 33: momentum (promedio de changes positivos)
        var pos = changes.Where(c => c > 0).ToList();
        vec[33] = pos.Count > 0 ? Math.Min(1, pos.Average() / 5.0) : 0;

        // Dims 34-38: similitud con crisis históricas
        if (_crisisVectors.Count > 0)
        {
            var slice = vec.Take(34).ToArray();
            int n = Math.Min(5, _crisisVectors.Count);
            for (int i = 0; i < n; i++)
            {
                double sim = Coseno(slice, _crisisVectors[_crisisVectors.Count - 1 - i]);
                vec[34 + i] = Math.Max(0, Math.Min(1, (sim + 1) / 2));
            }
        }

        return vec;
    }

    // ── Registrar crisis desde class5 ───────────────────────
    public static void RegisterFromCrisis(JsonElement root)
    {
        var v = new double[10];
        v[0] = Math.Min(1, GetDbl(root, "severidad",     0) / 10.0);
        v[1] = Math.Min(1, GetDbl(root, "duracion",      0) / 60.0);
        v[2] = Math.Min(1, GetDbl(root, "impacto_pib",   0) / 50.0);
        v[3] = Math.Min(1, GetDbl(root, "caida_mercado", 0) / 100.0);
        string tipo = GetStr(root, "tipo").ToLower();
        v[5] = tipo.Contains("financier") ? 1 : 0;
        v[6] = tipo.Contains("creditici") ? 1 : 0;
        v[7] = tipo.Contains("inflacion") ? 1 : 0;
        v[8] = tipo.Contains("recesion")  ? 1 : 0;
        RegisterCrisis(v);
    }
}

// ============================================================
// RealtimeBus10
// CORREGIDO: usa API real de StackExchange.Redis NuGet
//   - ConnectAsync con ConfigurationOptions (retry, timeout)
//   - SubscribeAsync con RedisChannel.Literal()
//   - PublishAsync con RedisChannel.Literal()
// ============================================================
public sealed class RealtimeBus10 : IAsyncDisposable
{
    private readonly string _url;
    private ConnectionMultiplexer _mux;    // tipo del NuGet real
    private ISubscriber           _sub;    // tipo del NuGet real

    public bool IsConnected => _mux?.IsConnected == true;

    public RealtimeBus10(string url) => _url = url;

    public async Task ConnectAsync()
    {
        // ConfigurationOptions da control sobre reintentos y timeout
        var cfg = ConfigurationOptions.Parse(_url);
        cfg.AbortOnConnectFail  = false;  // no crashear si Redis tarda en arrancar
        cfg.ConnectRetry        = 5;
        cfg.ConnectTimeout      = 5000;   // ms
        cfg.ReconnectRetryPolicy = new ExponentialRetry(1000);

        _mux = await ConnectionMultiplexer.ConnectAsync(cfg);
        _sub = _mux.GetSubscriber();
        Console.WriteLine($"[class10] 🔌 Redis conectado → {_url}");
    }

    // CORREGIDO: RedisChannel.Literal(ch) en lugar de string directo
    public async Task SubscribeAsync(
        string ch,
        Action<RedisChannel, RedisValue> handler)
    {
        if (_sub == null) throw new InvalidOperationException("[class10] Bus no conectado.");
        await _sub.SubscribeAsync(RedisChannel.Literal(ch), handler);
        Console.WriteLine($"[class10] 📡 {ch}");
    }

    // CORREGIDO: RedisChannel.Literal(ch)
    public Task<long> PublishAsync(string ch, string payload)
    {
        if (_sub == null) return Task.FromResult(0L);
        return _sub.PublishAsync(RedisChannel.Literal(ch), payload);
    }

    public async ValueTask DisposeAsync()
    {
        try { if (_mux != null) await _mux.CloseAsync(); } catch { }
        _mux?.Dispose();
    }
}

// ============================================================
// PIPELINE
// ============================================================
public sealed class Pipeline10 : IAsyncDisposable
{
    private readonly RealtimeBus10 _bus;
    private long _msgs      = 0;
    private long _published = 0;
    private DateTime _lastPub = DateTime.MinValue;
    private readonly TimeSpan _minGap = TimeSpan.FromSeconds(5);

    public Pipeline10(RealtimeBus10 bus) => _bus = bus;

    public async Task StartAsync()
    {
        foreach (var ch in RedisConfig10.InputChannels)
            await _bus.SubscribeAsync(ch, OnMsg);

        Console.WriteLine($"[class10] ✅ {RedisConfig10.InputChannels.Length} canales | → {RedisConfig10.OutputChannel}");
        Console.WriteLine($"[class10] 🔢 Features: {MarketFeatureExtractor10.DIM_TICKER} dims por instrumento (8 propias + 4 compartidas + 10 de la distribución) — INDEPENDIENTE del tamaño del universo");

        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(30000);
                Console.WriteLine($"[class10] ❤️  msgs={_msgs} vectors={_published}");
            }
        });
    }

    // Handler — los tipos RedisChannel/RedisValue vienen del NuGet real
    private void OnMsg(RedisChannel ch, RedisValue val)
    {
        Interlocked.Increment(ref _msgs);
        string channel = ch.ToString() ?? "";
        string raw     = val.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(raw)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;

                // Anti-loop: ignorar mensajes propios
                if (root.TryGetProperty("source", out var src) &&
                    src.GetString()?.StartsWith("class10") == true) return;

                double[] features = null;
                string tipo = "";

                switch (channel)
                {
                    case "class7_output":
                        string t = MarketFeatureExtractor10.GetStr(root, "type");

                        if (t == "sector_state")
                        {
                            // ORDEN 1: un envelope POR INSTRUMENTO en vez de uno agregado.
                            // El throttle se aplica al lote completo, no por ticker.
                            if ((DateTime.UtcNow - _lastPub) < _minGap) return;
                            _lastPub = DateTime.UtcNow;
                            var porTicker = MarketFeatureExtractor10.FromSectorStatePerTicker(root);
                            if (porTicker.Count == 0) return;
                            await PublishVectorsPerTicker(porTicker);
                            return;
                        }
                        else if (t == "prices_batch" &&
                                 root.TryGetProperty("precios", out var pr) &&
                                 pr.ValueKind == JsonValueKind.Object)
                        {
                            foreach (var p in pr.EnumerateObject())
                                if (p.Value.TryGetDouble(out var price))
                                    MarketFeatureExtractor10.RegisterPrice(p.Name, price);
                            // prices_batch solo actualiza cache, no publica vector
                            return;
                        }
                        break;

                    case "class5_output":
                        MarketFeatureExtractor10.RegisterFromCrisis(root);
                        Console.WriteLine("[class10] 🧠 Crisis registrada en memoria vectorial");
                        return;

                    case "class9_output":
                        string sym  = MarketFeatureExtractor10.GetStr(root, "symbol");
                        double last = MarketFeatureExtractor10.GetDbl(root, "ultimo", 0);
                        if (!string.IsNullOrEmpty(sym))
                            MarketFeatureExtractor10.RegisterPrice(sym, last);
                        return;

                    case "class10_ingest":
                        // Inyección directa de vector (bypass desde class9/class6)
                        if (root.TryGetProperty("vector", out var vArr) &&
                            vArr.ValueKind == JsonValueKind.Array)
                        {
                            features = vArr.EnumerateArray()
                                .Select(e => e.TryGetDouble(out var d) ? d : 0.0)
                                .ToArray();
                            tipo = "injected";
                        }
                        break;
                }

                if (features == null || features.Length == 0) return;

                // Throttle: máximo un vector cada 5 segundos
                if ((DateTime.UtcNow - _lastPub) < _minGap) return;
                _lastPub = DateTime.UtcNow;

                await PublishVector(features, tipo);
            }
            catch (Exception ex) { Console.WriteLine($"[class10] OnMsg error: {ex.Message}"); }
        });
    }

    // ── ORDEN 1: publica un envelope por instrumento ─────────────────────
    // El campo `symbol` va en el nivel superior Y en data: class19 lo propaga,
    // class23/24 lo etiquetan en su salida y class25A agrupa la ventana por él.
    // Sin `symbol` aguas abajo todo termina rotulado "class19" y class43 lo
    // verifica contra el promedio del mercado — que es el bug de raíz que este
    // rediseño viene a cerrar.
    private async Task PublishVectorsPerTicker(
        List<MarketFeatureExtractor10.TickerVector> lote)
    {
        int enviados = 0;
        foreach (var tv in lote)
        {
            var vec = new double[MarketFeatureExtractor10.DIM_TICKER];
            for (int i = 0; i < Math.Min(tv.Vec.Length, MarketFeatureExtractor10.DIM_TICKER); i++)
                vec[i] = double.IsFinite(tv.Vec[i]) ? Math.Max(0, Math.Min(1, tv.Vec[i])) : 0;

            int active = vec.Count(v => v > 0.001);

            // ── `confianza` pasa a ser COMPLETITUD DEL DATO (26-sep-2026) ───
            //
            // Era `active / 64.0`, o sea la fracción de dims no nulas. Eso medía
            // el LAYOUT del vector, no el mercado: las 48 dims compartidas y las
            // 8 siempre en cero daban casi el mismo conteo para los 13
            // instrumentos, así que `confianza` era prácticamente una constante
            // transversal. Y esa constante es la entrada principal de class21
            // (score = conf·0,65 + estab·0,25 + coher·0,10) y LA ÚNICA de class22
            // (EMA de confianza): la mitad del voto del ensemble no llevaba
            // información para distinguir instrumentos.
            //
            // Con 22 dims y ninguna muerta, `active/DIM` sería ~1,0 para todos:
            // el mismo problema, más marcado. Así que se mide lo que el campo
            // siempre quiso decir — cuánto de esta observación es dato real — y
            // eso SÍ varía por instrumento: con 50 tickers y un proveedor que
            // puede devolver 429, a algunos les falta precio u open.
            //
            // ⚠️ EFECTO ESPERADO EN class21/class22, para no leerlo como rotura:
            // con datos completos la confianza pasa de ~0,67 a 1,00, así que el
            // score de class21 sube a ~0,93 y su umbral adaptativo (techo 0,90)
            // deja de filtrar. class22 ya venía pasando el 100 % desde siempre.
            // O sea que los dos "filtros" quedan en pass-through — que es lo que
            // venían siendo de hecho, ahora visible. No cambia el ORDEN del
            // ranking, que lo deciden class23/mercado y class24/mercado.
            double confianza = Math.Max(0.0, Math.Min(1.0, tv.Completitud));

            var envelope = new
            {
                id        = Guid.NewGuid().ToString(),
                source    = RedisConfig10.MotorID,
                type      = "vector",
                fuente    = "mercado",
                symbol    = tv.Symbol,          // ← NIVEL SUPERIOR
                ticker    = tv.Symbol,          // alias: aguas abajo se lee cualquiera de los dos
                vector    = vec,
                texto     = $"market_features {tv.Symbol} chg={tv.Change:F2} rel={tv.ChangeRelativo:+0.00;-0.00}",
                confianza,
                data = new
                {
                    symbol          = tv.Symbol,
                    ticker          = tv.Symbol,
                    sector          = tv.Sector,
                    tipo            = "market_ticker",
                    dims            = MarketFeatureExtractor10.DIM_TICKER,
                    dims_activas    = active,
                    // Se publica aparte de `confianza` para que el chequeo pueda
                    // distinguir "faltan datos de este instrumento" (completitud
                    // baja) de "el vector salió raro" (dims_activas baja).
                    completitud     = tv.Completitud,
                    change          = tv.Change,
                    change_relativo = tv.ChangeRelativo,
                    riesgoGlobal    = vec[8],
                    market_breadth  = vec[9],
                    dispersion      = vec[10],
                    momentum        = vec[11],
                    ts              = DateTime.UtcNow.ToString("o"),
                    source          = RedisConfig10.MotorID
                },
                ts = DateTime.UtcNow.ToString("O")
            };

            await _bus.PublishAsync(
                RedisConfig10.OutputChannel,
                JsonSerializer.Serialize(envelope, JsonOpts10.D));
            Interlocked.Increment(ref _published);
            enviados++;
        }

        Console.WriteLine(
            $"[class10] 📤 {enviados} vectores POR TICKER → {RedisConfig10.OutputChannel} " +
            $"({string.Join(",", lote.Take(5).Select(t => t.Symbol))}{(lote.Count > 5 ? "…" : "")})");
    }

    private async Task PublishVector(double[] raw, string tipo)
    {
        // Normalizar a 64 dims, clamp [0,1]
        var vec = new double[64];
        for (int i = 0; i < Math.Min(raw.Length, 64); i++)
            vec[i] = double.IsFinite(raw[i]) ? Math.Max(0, Math.Min(1, raw[i])) : 0;

        int    active    = vec.Count(v => v > 0.001);
        double confianza = active / 64.0;

        var envelope = new
        {
            id        = Guid.NewGuid().ToString(),
            source    = RedisConfig10.MotorID,
            type      = "vector",
            fuente    = "mercado",
            vector    = vec,
            texto     = $"market_features tipo={tipo} dims=64 active={active}",
            confianza,
            data = new
            {
                tipo,
                dims          = 64,
                dims_activas  = active,
                riesgoGlobal  = active > 30 ? vec[30] : 0,
                market_breadth= active > 31 ? vec[31] : 0,
                volatilidad   = active > 32 ? vec[32] : 0,
                momentum      = active > 33 ? vec[33] : 0,
                ts            = DateTime.UtcNow.ToString("o"),
                source        = RedisConfig10.MotorID
            },
            ts = DateTime.UtcNow.ToString("O")
        };

        await _bus.PublishAsync(
            RedisConfig10.OutputChannel,
            JsonSerializer.Serialize(envelope, JsonOpts10.D));

        Interlocked.Increment(ref _published);
        Console.WriteLine(
            $"[class10] 📤 {tipo} " +
            $"confianza={confianza:F3} " +
            $"dims_activas={active}/64 " +
            $"→ {RedisConfig10.OutputChannel}");

        // Snapshot de métricas
        try
        {
            Paths10.Ensure();
            var snap = new
            {
                ts       = DateTime.UtcNow.ToString("o"),
                tipo,
                confianza,
                preview  = vec.Take(10)
            };
            await File.AppendAllTextAsync(
                Path.Combine(Paths10.MetricsDir, "class10_vectors.jsonl"),
                JsonSerializer.Serialize(snap, JsonOpts10.D) + Environment.NewLine);
        }
        catch { }
    }

    public async ValueTask DisposeAsync() => await Task.CompletedTask;
}

// ============================================================
// Program10
// ============================================================
public static class Program10
{
    public static async Task RunAsync(string[] _)
    {
        Paths10.Ensure();
        Console.WriteLine("╔══════════════════════════════════════════╗");
        Console.WriteLine("║  class10 — Motor de Features de Mercado  ║");
        Console.WriteLine("║  v2.0 — Features matemáticas reales      ║");
        Console.WriteLine("║  Redis: NuGet StackExchange.Redis real    ║");
        Console.WriteLine("╚══════════════════════════════════════════╝");

        while (true)
        {
            try
            {
                await using var bus = new RealtimeBus10(RedisConfig10.RedisUrl);

                try { await bus.ConnectAsync(); }
                catch (Exception ex)
                {
                    Console.WriteLine($"[class10] ❌ Redis: {ex.Message} — reintentando en 5s...");
                    await Task.Delay(5000);
                    continue;
                }

                // Notificar que el motor está listo
                var ready = JsonSerializer.Serialize(new
                {
                    source    = RedisConfig10.MotorID,
                    status    = "ready",
                    version   = "2.0",
                    canales   = RedisConfig10.InputChannels,
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                }, JsonOpts10.D);

                await bus.PublishAsync(RedisConfig10.ReadyChannel, ready);
                Console.WriteLine("[class10] 📢 dotnet_ready publicado");

                var pipeline = new Pipeline10(bus);
                await pipeline.StartAsync();
                await Task.Delay(Timeout.Infinite);
            }
            catch (Exception ex)
            {
                Serilog.Log.Error(ex, "[class10] Caído — reiniciando en 5s...");
                await Task.Delay(5000);
            }
        }
    }
}

// ============================================================
// PUNTO DE ENTRADA ÚNICO — MIIA_MotoresVectoriales
// Arranca class10 (features de mercado) +
//         class18 (features de portfolio) en el mismo proceso
// class18.cs debe estar en la misma carpeta scripts/
// ============================================================
public static class MotorVectorialTester
{
    public static async Task Main(string[] args)
    {
        // class18 en background — si falla se loguea y reintenta
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    await Program18.RunAsync18();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[class18] ❌ Caído: {ex.Message} — reintentando en 10s...");
                    await Task.Delay(10000);
                }
            }
        });

        // ── class40 + class41, el PAR de pronóstico y riesgo (26-sep-2026) ──
        //
        // APAGADOS POR DEFECTO. Se suben el 12-oct y se encienden con una
        // variable, de a uno, para poder ATRIBUIRLES algo: el corte ya cambia
        // diez cosas y encenderlos junto con todo lo demás los vuelve
        // indistinguibles del resto.
        //
        // Hoy encenderlos NO cambia ninguna decisión publicada: su salida
        // desemboca en `mult_umbral`, y con el ranking activo esa rama del
        // if/else de class25A no se ejecuta (decide por POSICIÓN, no por
        // umbral). Lo que sí cambia es lo que ven class9, class11 y class13,
        // que llevan meses recibiendo `class41_output` vacío.
        //
        // ⚠️ El día que se los quiera como VOTANTES del z, releer antes la nota
        // de las notas internas sobre la auto-referencia: cerrarían un lazo en el que las
        // decisiones de MIIA alimentan el pronóstico que decide las decisiones
        // de MIIA. Que ahora lean precios (class40_ingest) y no `class25_output`
        // saca la peor parte de ese lazo, pero no lo elimina.
        if (Environment.GetEnvironmentVariable("CLASS40_ACTIVO") == "1")
        {
            Console.WriteLine("[motor] ▶ class40 ACTIVO (class40_ingest → class40_forecast)");
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    try { await Program.Main(args); }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[class40] ❌ Caído: {ex.Message} — reintentando en 10s...");
                    }
                    await Task.Delay(10000);
                }
            });
        }

        if (Environment.GetEnvironmentVariable("CLASS41_ACTIVO") == "1")
        {
            Console.WriteLine("[motor] ▶ class41 ACTIVO (class40_forecast → class41_output)");
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    try { await Program41.Main(args); }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[class41] ❌ Caído: {ex.Message} — reintentando en 10s...");
                    }
                    await Task.Delay(10000);
                }
            });
        }

        // ── class3, la cadena de noticias hasta las redes (26-sep-2026) ──
        //
        // APAGADO POR DEFECTO, por el mismo motivo que class40/41: el corte del
        // 12-oct ya cambia diez cosas y encenderlo junto con todo lo demás lo
        // vuelve indistinguible del resto.
        //
        // QUÉ CAMBIA AL ENCENDERLO, para decidirlo con el número delante:
        // class3 vectoriza el texto de cada noticia (class1) y de cada fragmento
        // de PDF (class2, class5) y lo publica en `class19_ingest` con el
        // instrumento puesto. Eso crea una RED NUEVA `web|64` en class21-24 —con
        // su peso arrancando en PESO_INICIAL— y agrega una sexta clave a las
        // ventanas por instrumento de class25A. O sea: **cambia el orden del
        // ranking**, que es más de lo que hacen class40 y class41 hoy.
        //
        // Lo que NO cambia: el camino de mercado (class10) y el de portfolio
        // (class18) siguen iguales, y sin la variable class3 no se suscribe a
        // nada, así que el costo de subirlo apagado es cero.
        if (Environment.GetEnvironmentVariable("CLASS3_ACTIVO") == "1")
        {
            Console.WriteLine("[motor] ▶ class3 ACTIVO (class3_ingest → class19_ingest, red web|64)");
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    try { await Class3Adaptado.ProgramAdaptado.Main(args); }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[class3] ❌ Caído: {ex.Message} — reintentando en 10s...");
                    }
                    await Task.Delay(10000);
                }
            });
        }

        // class10 bloquea el proceso principal
        await Program10.RunAsync(args);
    }
}