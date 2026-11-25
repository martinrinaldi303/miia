// ============================================================
// class18.cs — Motor de Features Multi-Fuente (MIIA v2.2)
// Compilado junto con class10.cs en la carpeta scripts/
// ============================================================
//
// CAMBIOS v2.2 respecto a v2.1:
//   NUEVAS FUENTES: class11, class13, class14 ahora son procesadas
//   en lugar de descartadas silenciosamente.
//
//   v2.1 solo aceptaba: portfolio_generated | lifecycle | lifecycle_event
//   v2.2 acepta además:
//     impact_analysis  (class11) → vector de 8 dims de impacto mediático
//     cluster_regime   (class13) → vector de 6 dims de régimen de mercado
//     user_features    (class14) → vector de 6 dims de perfil de usuario
//
//   Cada fuente produce un vector independiente con su propio
//   campo "fuente" para que class19 pueda rastrear el origen.
//   No se mezclan en un vector único: la mezcla la hacen las
//   redes C++ (class21-24) que reciben múltiples vectores.
//
// Vectores publicados a class19_ingest:
//
//   fuente="portfolio"  — 32 dims (igual que v2.1)
//     Dims  0-29: 5 campos × 6 activos (score/riesgo/momentum/peso/change)
//     Dim   30:   riesgoGlobal
//     Dim   31:   confianza del portfolio
//
//   fuente="impacto"    — 8 dims (NUEVO)
//     Dim 0: score agregado de impacto
//     Dim 1: confianza del análisis
//     Dim 2: relevancia_real (coincidencia con noticia)
//     Dim 3: actividad_score
//     Dim 4: alcance_score
//     Dim 5: engagement_score
//     Dim 6: viralidad_score
//     Dim 7: fuente_real (0 o 1)
//
//   fuente="cluster"    — 6 dims (NUEVO)
//     Dim 0: cluster_id normalizado (cluster / 3)
//     Dim 1: confianza del cluster
//     Dim 2: estabilidad del régimen
//     Dim 3: firmeza (1 - distancia_norm)
//     Dim 4: tendencia del vector_regime[0]
//     Dim 5: confianza_pronostico del vector_regime[1]
//
//   fuente="usuario"    — 6 dims (NUEVO)
//     Dim 0: tolerancia_riesgo (conservador=0, moderado=0.5, agresivo=1)
//     Dim 1: nivel_experiencia (principiante=0.33, intermedio=0.66, avanzado=1)
//     Dim 2: interacciones normalizadas (÷ 1000, cap 1)
//     Dim 3: decisiones_vistas normalizadas (÷ 500, cap 1)
//     Dim 4: accion sobre señal (ignoro=0, neutral=0.5, siguio=1)
//     Dim 5: plan (free=0, pro=1)
//
// NOTA: class19 tiene MIN_DIMS_ACTIVAS=10. Los vectores de 6-8 dims
//   deben tener al menos 10 dims para pasar el filtro. Por eso
//   class18 los publica con padding a 12 dims (dims extra = 0.5
//   como valor neutral, no cero, para no ser rechazados por
//   confianza mínima < 0.15).
// ============================================================

#nullable disable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading;
using System.Threading.Tasks;
using StackExchange.Redis;

// ── JSON Options ─────────────────────────────────────────────
public static class JsonOpts18
{
    public static readonly JsonSerializerOptions D18 = new()
    {
        PropertyNameCaseInsensitive = true,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };
}

// ── Redis Config ──────────────────────────────────────────────
public static class RedisConfig18
{
    public static readonly string RedisUrl18 =
        Environment.GetEnvironmentVariable("REDIS_URL") ?? "localhost:6379";

    public static readonly string[] InputChannels18 = { "class18_ingest" };
    public static readonly string OutputChannel18   = "class19_ingest";
    public static readonly string ReadyChannel18    = "dotnet_ready";
    public static readonly string MotorID18         = "class18_vectorial";
}

// ── Paths ─────────────────────────────────────────────────────
public static class Paths18
{
    private static string Root18() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));

    public static readonly string BaseDir18    = Path.Combine(Root18(), "operador", "aprendizaje");
    public static readonly string LogsDir18    = Path.Combine(BaseDir18, "logs");
    public static readonly string MetricsDir18 = Path.Combine(BaseDir18, "metrics");

    public static void Ensure18()
    {
        foreach (var d in new[] { LogsDir18, MetricsDir18 })
            try { Directory.CreateDirectory(d); } catch { }
    }
}

// ============================================================
// HELPERS COMUNES
// ============================================================
public static class VecUtils18
{
    public static string GetStr(JsonElement el, string name) =>
        el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() ?? "" : "";

    public static double GetDbl(JsonElement el, string name, double def = 0)
    {
        if (!el.TryGetProperty(name, out var p)) return def;
        if (p.TryGetDouble(out var d)) return d;
        if (p.ValueKind == JsonValueKind.String &&
            double.TryParse(p.GetString(), out var s)) return s;
        return def;
    }

    public static double Clamp(double v) =>
        double.IsFinite(v) ? Math.Max(0, Math.Min(1, v)) : 0;

    // Padding a targetLen con valor neutral 0.5 para pasar filtro
    // MIN_DIMS_ACTIVAS=10 en class19. Vectores de 8 y 6 dims se
    // rellenan a 12 para garantizar >= 10 dims activas.
    public static double[] PadNeutral(double[] vec, int targetLen = 12)
    {
        if (vec.Length >= targetLen) return vec;
        var padded = new double[targetLen];
        Array.Copy(vec, padded, vec.Length);
        for (int i = vec.Length; i < targetLen; i++)
            padded[i] = 0.5;   // neutral, no cero → cuenta como activa en class19
        return padded;
    }

    public static double Confidence(double[] vec)
    {
        if (vec == null || vec.Length == 0) return 0;
        int active = vec.Count(v => v > 0.001);
        double c = active / (double)vec.Length;
        return double.IsFinite(c) ? Math.Max(0, Math.Min(1, c)) : 0;
    }
}

// ============================================================
// EXTRACTOR — PORTFOLIO (32 dims, igual que v2.1)
// ============================================================
public static class PortfolioExtractor18
{
    private const int MAX_ASSETS = 6;
    private const int DIM        = 32;

    public static double[] Extract(JsonElement root)
    {
        JsonElement payload = root;
        if (root.TryGetProperty("data", out var dataEl) &&
            dataEl.ValueKind == JsonValueKind.Object &&
            (dataEl.TryGetProperty("details", out _) ||
             dataEl.TryGetProperty("portfolio_id", out _)))
            payload = dataEl;

        if (!payload.TryGetProperty("details", out var detailsEl) ||
            detailsEl.ValueKind != JsonValueKind.Array) return null;

        var vec    = new double[DIM];
        var assets = detailsEl.EnumerateArray().ToList();
        int n      = Math.Min(assets.Count, MAX_ASSETS);

        for (int i = 0; i < n; i++)
        {
            var a = assets[i];
            vec[i]             = VecUtils18.Clamp(VecUtils18.GetDbl(a, "score",    0.5));
            vec[MAX_ASSETS + i]   = VecUtils18.Clamp(VecUtils18.GetDbl(a, "riesgo",   0.5));
            vec[MAX_ASSETS*2 + i] = VecUtils18.Clamp(VecUtils18.GetDbl(a, "momentum", 0.5));
            vec[MAX_ASSETS*3 + i] = VecUtils18.Clamp(VecUtils18.GetDbl(a, "peso",
                                      1.0 / Math.Max(1, assets.Count)));
            double pct = VecUtils18.GetDbl(a, "change_pct", 0);
            vec[MAX_ASSETS*4 + i] = VecUtils18.Clamp((pct + 5.0) / 10.0);
        }

        double rg = VecUtils18.GetDbl(payload, "riesgoGlobal", -1);
        if (rg < 0 && root.TryGetProperty("riesgoGlobal", out var rgEl) &&
            rgEl.TryGetDouble(out double rgv)) rg = rgv;
        vec[30] = VecUtils18.Clamp(rg < 0 ? 0.5 : rg);
        vec[31] = VecUtils18.Clamp(VecUtils18.GetDbl(payload, "confidence",
                    VecUtils18.GetDbl(payload, "confianza", 0.5)));

        return vec;
    }

    public static string GetPortfolioId(JsonElement root)
    {
        string pid = VecUtils18.GetStr(root, "portfolio_id");
        if (string.IsNullOrEmpty(pid) &&
            root.TryGetProperty("data", out var d))
            pid = VecUtils18.GetStr(d, "portfolio_id");
        return pid;
    }
}

// ============================================================
// EXTRACTOR — IMPACTO MEDIÁTICO (class11 → 8 dims + padding a 12)
// ============================================================
public static class ImpactoExtractor18
{
    public static double[] Extract(JsonElement root)
    {
        // El payload viene en root o en root.data
        JsonElement data = root;
        if (root.TryGetProperty("data", out var d) &&
            d.ValueKind == JsonValueKind.Object) data = d;

        var vec = new double[8];

        // Dim 0: score agregado
        vec[0] = VecUtils18.Clamp(VecUtils18.GetDbl(root, "score",
                   VecUtils18.GetDbl(data, "score", 0.5)));

        // Dim 1: confianza
        vec[1] = VecUtils18.Clamp(VecUtils18.GetDbl(root, "confianza",
                   VecUtils18.GetDbl(data, "confianza", 0.5)));

        // Dims 2-7: métricas del objeto data o de root directamente
        JsonElement metrics = data;
        if (data.TryGetProperty("metrics", out var m) &&
            m.ValueKind == JsonValueKind.Object) metrics = m;

        // Dim 2: relevancia_real — puede ser bool o float
        if (root.TryGetProperty("relevanciaReal", out var rrEl))
            vec[2] = VecUtils18.Clamp(rrEl.ValueKind == JsonValueKind.True  ? 1.0 :
                                      rrEl.ValueKind == JsonValueKind.False ? 0.0 :
                                      rrEl.TryGetDouble(out var rrd) ? rrd : 0.5);
        else
            vec[2] = VecUtils18.Clamp(VecUtils18.GetDbl(data, "relevanciaReal", 0.5));

        // Dim 3-6: métricas normalizadas de actividad, alcance, engagement, viralidad
        vec[3] = VecUtils18.Clamp(VecUtils18.GetDbl(metrics, "actividad_score",  0.5));
        vec[4] = VecUtils18.Clamp(VecUtils18.GetDbl(metrics, "alcance_score",    0.5));
        vec[5] = VecUtils18.Clamp(VecUtils18.GetDbl(metrics, "engagement_score", 0.5));
        vec[6] = VecUtils18.Clamp(VecUtils18.GetDbl(metrics, "viralidad_score",  0.5));

        // Dim 7: fuente_real (bool)
        if (root.TryGetProperty("fuente_real", out var frEl) ||
            data.TryGetProperty("fuente_real", out frEl))
            vec[7] = frEl.ValueKind == JsonValueKind.True  ? 1.0 :
                     frEl.ValueKind == JsonValueKind.False ? 0.0 :
                     VecUtils18.Clamp(frEl.TryGetDouble(out var frd) ? frd : 0.0);

        // Rellenar a 12 dims con 0.5 para pasar MIN_DIMS_ACTIVAS=10 en class19
        return VecUtils18.PadNeutral(vec, 12);
    }
}

// ============================================================
// EXTRACTOR — RÉGIMEN DE MERCADO (class13 → 6 dims + padding a 12)
// ============================================================
public static class ClusterExtractor18
{
    public static double[] Extract(JsonElement root)
    {
        JsonElement data = root;
        if (root.TryGetProperty("data", out var d) &&
            d.ValueKind == JsonValueKind.Object) data = d;

        var vec = new double[6];

        // Dim 0: dirección del régimen, leída de cluster_label — NO del id.
        //
        // El cluster_id es una etiqueta CATEGÓRICA cuyo significado cambiaba, y
        // había tres convenciones en conflicto:
        //   · class13.js:105 (init de centroides) → 1=bajista, 2=lateral
        //   · esta línea, antes                   → 1=lateral, 2=bajista  (invertido)
        //   · labelClusters() en runtime          → reasignaba por ranking, pisando ambas
        // Encima `clusterId / 3.0` trataba un id de categoría como escala ordinal,
        // como si el 2 fuera el doble de bajista que el 1.
        // Desde el arreglo de class13, `cluster_label` sí es absoluto.
        string lbl = VecUtils18.GetStr(data, "cluster_label");
        if (string.IsNullOrEmpty(lbl)) lbl = VecUtils18.GetStr(root, "cluster_label");
        vec[0] = lbl switch
        {
            "alcista" => 1.00,
            "lateral" => 0.50,
            "bajista" => 0.25,
            "crisis"  => 0.00,
            _         => 0.50,
        };

        // Dim 1: confianza del cluster
        vec[1] = VecUtils18.Clamp(VecUtils18.GetDbl(root, "confianza",
                   VecUtils18.GetDbl(data, "confianza", 0.5)));

        // Dim 2: estabilidad del régimen
        vec[2] = VecUtils18.Clamp(VecUtils18.GetDbl(data, "estabilidad",
                   VecUtils18.GetDbl(root, "estabilidad", 0.5)));

        // Dim 3: cobertura de entradas de class13 — cuántos de sus tres bloques
        // (pronóstico, riesgo, mercado) llegaron de verdad.
        //
        // ANTES era `1 - distancia_norm`, que es EXACTAMENTE la definición de
        // `confianza` en class13 — o sea, un duplicado literal de la dim 1. Dos
        // de seis dimensiones llevaban el mismo número, las dos saturadas cerca
        // de 0.999. La cobertura sí es información nueva: distingue un régimen
        // calculado con datos de uno calculado sobre los 0.5 de relleno.
        vec[3] = VecUtils18.Clamp(VecUtils18.GetDbl(data, "cobertura",
                   VecUtils18.GetDbl(root, "cobertura", 0.5)));

        // Dims 4-5: primeras 2 componentes del vector_regime
        // (tendencia[0] y confianza_pronostico[1])
        if (data.TryGetProperty("vector_regime", out var vrEl) &&
            vrEl.ValueKind == JsonValueKind.Array)
        {
            var elems = vrEl.EnumerateArray().ToList();
            if (elems.Count > 0 && elems[0].TryGetDouble(out var v0))
                vec[4] = VecUtils18.Clamp(v0);
            if (elems.Count > 1 && elems[1].TryGetDouble(out var v1))
                vec[5] = VecUtils18.Clamp(v1);
        }

        return VecUtils18.PadNeutral(vec, 12);
    }
}

// ============================================================
// EXTRACTOR — PERFIL DE USUARIO (class14 → 6 dims + padding a 12)
// ============================================================
public static class UsuarioExtractor18
{
    public static double[] Extract(JsonElement root)
    {
        // El perfil puede llegar en root.perfil o en root directamente
        JsonElement perfil = root;
        if (root.TryGetProperty("perfil", out var p) &&
            p.ValueKind == JsonValueKind.Object) perfil = p;

        var vec = new double[6];

        // Dim 0: tolerancia_riesgo
        string tolerancia = VecUtils18.GetStr(perfil, "tolerancia_riesgo");
        if (string.IsNullOrEmpty(tolerancia))
            tolerancia = VecUtils18.GetStr(root, "tolerancia_riesgo");
        vec[0] = tolerancia == "conservador" ? 0.0 :
                 tolerancia == "agresivo"    ? 1.0 : 0.5;  // moderado o desconocido

        // Dim 1: nivel_experiencia
        string nivel = VecUtils18.GetStr(perfil, "nivel_experiencia");
        if (string.IsNullOrEmpty(nivel))
            nivel = VecUtils18.GetStr(root, "nivel_experiencia");
        vec[1] = nivel == "principiante" ? 0.33 :
                 nivel == "avanzado"     ? 1.0  : 0.66;  // intermedio o desconocido

        // Dim 2: interacciones normalizadas (÷ 1000, cap 1)
        double interacciones = VecUtils18.GetDbl(perfil, "interacciones",
                                 VecUtils18.GetDbl(root, "interacciones", 0));
        vec[2] = VecUtils18.Clamp(interacciones / 1000.0);

        // Dim 3: decisiones_vistas normalizadas (÷ 500, cap 1)
        double decisionesVistas = VecUtils18.GetDbl(perfil, "decisiones_vistas",
                                    VecUtils18.GetDbl(root, "decisiones_vistas", 0));
        vec[3] = VecUtils18.Clamp(decisionesVistas / 500.0);

        // Dim 4: accion del usuario sobre la última señal
        // siguio=1.0 (máximo acuerdo), consulto=0.7 (interés sin acción),
        // neutral/ausente=0.5, rechazo=0.1 (desacuerdo activo), ignoro=0.0
        string accion = VecUtils18.GetStr(root, "accion_usuario");
        vec[4] = accion == "siguio"  ? 1.0 :
                 accion == "consulto"? 0.7 :
                 accion == "rechazo" ? 0.1 :
                 accion == "ignoro"  ? 0.0 : 0.5;

        // Dim 5: plan del usuario (free=0, pro=1)
        string plan = VecUtils18.GetStr(root, "plan");
        if (string.IsNullOrEmpty(plan))
            plan = VecUtils18.GetStr(perfil, "plan");
        vec[5] = plan == "free" || string.IsNullOrEmpty(plan) ? 0.0 : 1.0;

        return VecUtils18.PadNeutral(vec, 12);
    }
}

// ============================================================
// RealtimeBus18
// ============================================================
public sealed class RealtimeBus18 : IAsyncDisposable
{
    private readonly string _url18;
    private ConnectionMultiplexer _mux18;
    private ISubscriber           _sub18;

    public bool IsConnected18 => _mux18?.IsConnected == true;
    public RealtimeBus18(string url) => _url18 = url;

    public async Task ConnectAsync18()
    {
        var cfg = ConfigurationOptions.Parse(_url18);
        cfg.AbortOnConnectFail   = false;
        cfg.ConnectRetry         = 5;
        cfg.ConnectTimeout       = 5000;
        cfg.ReconnectRetryPolicy = new ExponentialRetry(1000);
        _mux18 = await ConnectionMultiplexer.ConnectAsync(cfg);
        _sub18 = _mux18.GetSubscriber();
        Console.WriteLine($"[class18] 🔌 Redis → {_url18}");
    }

    public async Task SubscribeAsync18(string ch, Action<RedisChannel, RedisValue> h)
    {
        if (_sub18 == null) throw new InvalidOperationException("[class18] No conectado.");
        await _sub18.SubscribeAsync(RedisChannel.Literal(ch), h);
        Console.WriteLine($"[class18] 📡 {ch}");
    }

    public Task<long> PublishAsync18(string ch, string payload)
    {
        if (_sub18 == null) return Task.FromResult(0L);
        return _sub18.PublishAsync(RedisChannel.Literal(ch), payload);
    }

    public async ValueTask DisposeAsync()
    {
        try { if (_mux18 != null) await _mux18.CloseAsync(); } catch { }
        _mux18?.Dispose();
    }
}

// ============================================================
// Pipeline18 — enrutamiento multi-fuente
// ============================================================
public sealed class Pipeline18 : IAsyncDisposable
{
    private readonly RealtimeBus18   _bus18;
    private long _msgs18 = 0, _pub18 = 0;
    private readonly HashSet<string> _seen18 = new();

    public Pipeline18(RealtimeBus18 bus) => _bus18 = bus;

    public async Task StartAsync18()
    {
        foreach (var ch in RedisConfig18.InputChannels18)
            await _bus18.SubscribeAsync18(ch, OnMsg18);

        Console.WriteLine("[class18] ✅ Multi-fuente activo");
        Console.WriteLine("[class18] 📋 Acepta: portfolio(32d) | impacto(12d) | cluster(12d) | usuario(12d)");

        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(30_000);
                Console.WriteLine($"[class18] ❤️  msgs={_msgs18} vectors={_pub18}");
            }
        });
    }

    private void OnMsg18(RedisChannel ch, RedisValue val)
    {
        Interlocked.Increment(ref _msgs18);
        string raw = val.ToString() ?? "";
        if (string.IsNullOrWhiteSpace(raw)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;

                // Anti-loop
                if (root.TryGetProperty("source", out var src) &&
                    src.GetString()?.StartsWith("class18") == true) return;

                string msgType = VecUtils18.GetStr(root, "type");

                // Buscar type también dentro de data si no está en root
                if (string.IsNullOrEmpty(msgType) &&
                    root.TryGetProperty("data", out var dEl))
                    msgType = VecUtils18.GetStr(dEl, "type");

                switch (msgType)
                {
                    // ── PORTFOLIO (class15/class17) ────────────────────────
                    case "portfolio_generated":
                    case "lifecycle":
                    case "lifecycle_event":
                        await ProcesarPortfolio(root, msgType);
                        break;

                    // ── IMPACTO MEDIÁTICO (class11) ────────────────────────
                    case "impact_analysis":
                        await ProcesarImpacto(root);
                        break;

                    // ── RÉGIMEN DE MERCADO (class13) ───────────────────────
                    case "cluster_regime":
                        await ProcesarCluster(root);
                        break;

                    // ── PERFIL / DECISIÓN DE USUARIO (class14) ─────────────
                    case "profile_update":
                    case "subscription_activated":
                    case "user_decision":
                        await ProcesarUsuario(root, msgType);
                        break;

                    default:
                        // validation_metrics de class43 y otros → ignorar
                        break;
                }
            }
            catch (Exception ex)
            {
                Serilog.Log.Error(ex, "[class18] OnMsg18 error");
            }
        });
    }

    // ── Portfolio ──────────────────────────────────────────────────────────
    private async Task ProcesarPortfolio(JsonElement root, string msgType)
    {
        string pid = PortfolioExtractor18.GetPortfolioId(root);
        double[] vec = PortfolioExtractor18.Extract(root);
        if (vec == null) return;

        if (!string.IsNullOrEmpty(pid))
        {
            string key = msgType + ":" + pid;
            lock (_seen18)
            {
                if (_seen18.Contains(key)) return;
                _seen18.Add(key);
                if (_seen18.Count > 500) _seen18.Clear();
            }
        }

        string userId = VecUtils18.GetStr(root, "user_id");
        await PublicarVector(vec, "portfolio", VecUtils18.Confidence(vec),
            $"portfolio_features pid={pid} user={userId}", pid ?? Guid.NewGuid().ToString(),
            new { tipo = "portfolio_features", dims = 32,
                  riesgoGlobal = vec.Length > 30 ? vec[30] : 0,
                  confianza_port = vec.Length > 31 ? vec[31] : 0,
                  portfolio_id = pid, user_id = userId });
    }

    // ── Impacto mediático ──────────────────────────────────────────────────
    private async Task ProcesarImpacto(JsonElement root)
    {
        double[] vec = ImpactoExtractor18.Extract(root);
        double confianza = VecUtils18.Clamp(
            VecUtils18.GetDbl(root, "confianza", VecUtils18.Confidence(vec)));

        string id = VecUtils18.GetStr(root, "id");
        if (string.IsNullOrEmpty(id)) id = Guid.NewGuid().ToString();

        // Dedup por id de impacto
        lock (_seen18)
        {
            string key = "impact:" + id;
            if (_seen18.Contains(key)) return;
            _seen18.Add(key);
            if (_seen18.Count > 500) _seen18.Clear();
        }

        double score = VecUtils18.GetDbl(root, "score", 0.5);
        await PublicarVector(vec, "impacto", confianza,
            $"impact_features score={score:F3} conf={confianza:F3}", id,
            new { tipo = "impact_features", dims = 12, dims_reales = 8,
                  score, confianza_impacto = confianza,
                  fuente_real = vec.Length > 7 && vec[7] > 0.5 },
            // La UNICA de las cuatro fuentes que trae instrumento. class11 manda
            // `symbol` en la raiz desde el 26-sep; si no viene (agregado), queda
            // GENERAL, que es el comportamiento de siempre.
            VecUtils18.GetStr(root, "symbol"));
    }

    // ── Régimen de mercado ─────────────────────────────────────────────────
    private async Task ProcesarCluster(JsonElement root)
    {
        double[] vec = ClusterExtractor18.Extract(root);
        double confianza = VecUtils18.Clamp(
            VecUtils18.GetDbl(root, "confianza", VecUtils18.Confidence(vec)));

        string id = VecUtils18.GetStr(root, "id");
        if (string.IsNullOrEmpty(id)) id = Guid.NewGuid().ToString();

        lock (_seen18)
        {
            string key = "cluster:" + id;
            if (_seen18.Contains(key)) return;
            _seen18.Add(key);
            if (_seen18.Count > 500) _seen18.Clear();
        }

        JsonElement data = root;
        if (root.TryGetProperty("data", out var d)) data = d;
        string label  = VecUtils18.GetStr(data, "cluster_label");
        double clustId = VecUtils18.GetDbl(data, "cluster_id", 1);

        await PublicarVector(vec, "cluster", confianza,
            $"cluster_features regimen={label} id={clustId} conf={confianza:F3}", id,
            new { tipo = "cluster_features", dims = 12, dims_reales = 6,
                  cluster_id = (int)clustId, cluster_label = label, confianza_cluster = confianza });
    }

    // ── Perfil / decisión de usuario ──────────────────────────────────────
    private async Task ProcesarUsuario(JsonElement root, string msgType)
    {
        // Solo vectorizar si hay perfil con datos útiles
        // profile_update sin perfil → ignorar
        string userId = VecUtils18.GetStr(root, "user_id");
        if (string.IsNullOrEmpty(userId)) return;

        double[] vec = UsuarioExtractor18.Extract(root);
        double confianza = VecUtils18.Confidence(vec);

        // Dedup por user_id + tipo (actualización de perfil no genera spam)
        lock (_seen18)
        {
            string key = "user:" + userId + ":" + msgType;
            if (_seen18.Contains(key)) return;
            _seen18.Add(key);
            if (_seen18.Count > 500) _seen18.Clear();
        }

        string plan    = VecUtils18.GetStr(root, "plan");
        string accion  = VecUtils18.GetStr(root, "accion_usuario");

        await PublicarVector(vec, "usuario", confianza,
            $"user_features user={userId} plan={plan} accion={accion}", userId,
            new { tipo = "user_features", dims = 12, dims_reales = 6,
                  user_id = userId, plan, accion_usuario = accion,
                  msg_type_origen = msgType });
    }

    // ── Publicador genérico ────────────────────────────────────────────────
    // `symbol` (26-sep-2026). class18 es un punto de convergencia y NINGUNA de
    // sus cuatro entradas era por instrumento, asi que todos sus vectores caian
    // en ticker GENERAL. Con el ranking transversal activo, GENERAL no emite: el
    // 67 % de la masa de class25a_pesos.json quedaba fuera de toda decision
    // publicada. class11 ya manda `symbol` por instrumento; aca se propaga.
    //
    // cluster (regimen) y usuario NO tienen instrumento y siguen en GENERAL: es
    // lo correcto, no una carencia. Inventarles un ticker seria peor.
    //
    // CLASS18_SYMBOL=0 vuelve al comportamiento anterior sin recompilar.
    private static readonly bool SymbolOn =
        Environment.GetEnvironmentVariable("CLASS18_SYMBOL") != "0";

    private async Task PublicarVector(
        double[] rawVec, string fuente, double confianza,
        string texto, string refId, object dataExtra, string symbol = null)
    {
        // Normalizar
        var vec = rawVec.Select(v =>
            double.IsFinite(v) ? Math.Max(0, Math.Min(1, v)) : 0).ToArray();

        int active = vec.Count(v => v > 0.001);

        // Sin instrumento se manda NULL, no la cadena "GENERAL".
        //
        // No es cosmetico: class19 resuelve el simbolo con
        //   String(msg.symbol ?? msg.ticker ?? ...).toUpperCase() || null
        // y despues decide la METRICA DE CAMBIO con `symbol !== null`. Mandando
        // "GENERAL" literal, los vectores de cluster/usuario/portfolio pasarian
        // de compararse por coseno a compararse por delta_max, que es otra cosa
        // y cambiaria cuantos pasan el filtro. Con null, el `??` de class19 lo
        // saltea y el comportamiento queda EXACTAMENTE como antes.
        string sym = SymbolOn && !string.IsNullOrWhiteSpace(symbol)
                   ? symbol.Trim().ToUpperInvariant() : null;

        var env = new
        {
            id        = Guid.NewGuid().ToString(),
            source    = RedisConfig18.MotorID18,
            type      = "vector",
            fuente,
            symbol    = sym,
            ticker    = sym,
            vector    = vec,
            texto,
            confianza,
            data      = dataExtra,
            ts        = DateTime.UtcNow.ToString("O")
        };

        await _bus18.PublishAsync18(
            RedisConfig18.OutputChannel18,
            JsonSerializer.Serialize(env, JsonOpts18.D18));

        Interlocked.Increment(ref _pub18);
        Console.WriteLine(
            $"[class18] 📤 [{fuente}/{sym ?? "GENERAL"}] ref={refId[..Math.Min(12,refId.Length)]} " +
            $"dims={vec.Length} active={active} conf={confianza:F3} → {RedisConfig18.OutputChannel18}");

        // Métricas JSONL
        try
        {
            Paths18.Ensure18();
            await File.AppendAllTextAsync(
                Path.Combine(Paths18.MetricsDir18, "class18_vectors.jsonl"),
                JsonSerializer.Serialize(new {
                    ts = DateTime.UtcNow.ToString("o"),
                    fuente, dims = vec.Length, active, confianza,
                    preview = vec.Take(6)
                }, JsonOpts18.D18) + Environment.NewLine);
        }
        catch { }
    }

    public async ValueTask DisposeAsync() => await Task.CompletedTask;
}

// ============================================================
// Program18
// ============================================================
public static class Program18
{
    public static async Task RunAsync18()
    {
        Paths18.Ensure18();
        Console.WriteLine("╔══════════════════════════════════════════════════════╗");
        Console.WriteLine("║  class18 — Motor de Features Multi-Fuente v2.2       ║");
        Console.WriteLine("║  portfolio(32d) | impacto(12d) | cluster(12d) | usr(12d) ║");
        Console.WriteLine("╚══════════════════════════════════════════════════════╝");
        Console.WriteLine($"[class18] 📥 {string.Join(", ", RedisConfig18.InputChannels18)}");
        Console.WriteLine($"[class18] 📤 {RedisConfig18.OutputChannel18}");

        while (true)
        {
            try
            {
                await using var bus = new RealtimeBus18(RedisConfig18.RedisUrl18);
                try { await bus.ConnectAsync18(); }
                catch (Exception ex)
                {
                    Console.WriteLine($"[class18] ❌ Redis: {ex.Message} — 5s...");
                    await Task.Delay(5000);
                    continue;
                }

                await bus.PublishAsync18(RedisConfig18.ReadyChannel18,
                    JsonSerializer.Serialize(new {
                        source    = RedisConfig18.MotorID18,
                        status    = "ready",
                        version   = "2.2",
                        fuentes   = new[] {"portfolio","impacto","cluster","usuario"},
                        canales   = RedisConfig18.InputChannels18,
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                    }, JsonOpts18.D18));

                Console.WriteLine("[class18] 📢 ready v2.2");
                var pipeline = new Pipeline18(bus);
                await pipeline.StartAsync18();
                await Task.Delay(Timeout.Infinite);
            }
            catch (Exception ex)
            {
                Serilog.Log.Error(ex, "[class18] Caído — 5s...");
                await Task.Delay(5000);
            }
        }
    }
}
// ── NO hay Main aquí ──────────────────────────────────────────