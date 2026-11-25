// =======================================================
// class41.cs (Motor de Riesgo y Probabilidad) — MIIA v2.0
// Versión corregida: uso CONSISTENTE de RedisStubs types,
// eliminación de ambigüedades de tipos (ISubscriber, IDatabase, etc.)
// y robustez extra en handlers (reflexión / defensivo).
// =======================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;


// FIX: usando StackExchange.Redis real — stub eliminado
// ANTES: namespace RedisStubs con SimpleSubscriber → class41 nunca recibía mensajes de class25
using StackExchange.Redis;


// =======================================================
// SystemBus5 (publicar eventos del sistema) - usa ISubscriber
// =======================================================
public static class SystemBus5
{
    private static readonly Dictionary<string, string> SYSTEM_CHANNELS =
        new()
        {
            { "LOG", "system.log" },
            { "ERROR", "system.error" },
            { "METRICS", "system.metrics" }
        };

    public static async Task PublishSystemEvent(
        ISubscriber redis,
        string type,
        object payload,
        string source = "unknown"
    )
    {
        if (redis == null) return;
        if (!SYSTEM_CHANNELS.ContainsKey(type)) return;

        var envelope = new
        {
            ts = DateTime.UtcNow.ToString("O"),
            source,
            type,
            payload
        };

        var json = JsonSerializer.Serialize(envelope);
        try
        {
            await redis.PublishAsync(SYSTEM_CHANNELS[type], json).ConfigureAwait(false);
        }
        catch { /* tolerate failures */ }
    }
}

// =======================================================
// Motor de Riesgo y Probabilidad (class41)
// =======================================================
namespace MIIA.Motores
{
    // FIX: RedisStubs eliminado; usa StackExchange.Redis

    public class MotorRiesgoProbabilidad
    {
        // =======================================================
        // Config loader
        // =======================================================
        private Dictionary<string, object> CargarConfiguracion()
        {
            try
            {
                string basePath = AppContext.BaseDirectory;
                string rootPath = Path.GetFullPath(Path.Combine(basePath, "..", "..", ".."));
                string configPath = Path.Combine(rootPath, "operador", "aprendizaje", "config");

                if (!Directory.Exists(configPath))
                    return new Dictionary<string, object>();

                var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

                foreach (var file in Directory.GetFiles(configPath, "*.json"))
                {
                    try
                    {
                        string json = File.ReadAllText(file);
                        var data = JsonSerializer.Deserialize<Dictionary<string, object>>(json);
                        if (data != null)
                        {
                            foreach (var kv in data) result[kv.Key] = kv.Value!;
                        }
                    }
                    catch { }
                }

                foreach (var file in Directory.GetFiles(configPath, "*.ini"))
                {
                    foreach (var line in File.ReadAllLines(file))
                    {
                        if (string.IsNullOrWhiteSpace(line)) continue;
                        if (line.TrimStart().StartsWith("#")) continue;
                        if (!line.Contains("=")) continue;

                        var parts = line.Split('=', 2);
                        result[parts[0].Trim()] = parts[1].Trim();
                    }
                }

                return result;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[class41] Error cargando configuraciones: {ex.Message}");
                return new Dictionary<string, object>();
            }
        }

        // =======================================================
        // Redis fields (using RedisStubs types explicitly)
        // =======================================================
        private readonly string redisUrl;
        private ConnectionMultiplexer? redis;
        private IDatabase? db;
        private ISubscriber? sub;
        private ConfigurationOptions opts = new ConfigurationOptions();

        private static readonly SemaphoreSlim _limiter = new SemaphoreSlim(4);

        // ── Canales, recableados el 26-sep-2026 ──────────────────────────────
        // ENTRADA. class41 parsea `Ensemble.Predictions` + `CurrentPrice`, o sea
        // un PRONÓSTICO, y lo único que produce esa forma es class40. Estaba
        // suscrito a `class25_output` (decisiones), así que caía siempre en su
        // guarda «preds vacíos» y salía. class40 y class41 son un PAR: por eso
        // los dos estaban muertos, y por eso se conectan juntos o no se conectan.
        //
        // SALIDA. `class41_output` no cambia: es un canal huérfano al revés
        // —CUATRO consumidores suscritos (class9, class11, class13, class25A) y
        // CERO productores en producción— así que llenarlo no pisa a nadie.
        private static readonly string ChannelIn =
            Environment.GetEnvironmentVariable("CLASS41_CH_IN")  ?? "class40_forecast";
        private static readonly string ChannelOut =
            Environment.GetEnvironmentVariable("CLASS41_CH_OUT") ?? "class41_output";

        // ── OPCIÓN A: Trigger de búsqueda activa hacia class1 ──────
        // Cuando el riesgo calculado es HIGH, class41 le pide a class1
        // que busque contexto noticioso real sobre ese ticker/sector.
        //
        // NOTA PARA MIGRACIÓN FUTURA (18 meses, Opción C):
        // Este disparo determinístico por nivel de riesgo debe
        // reemplazarse por una decisión generada por el modelo ya
        // entrenado (class25A/B), sin depender de un umbral fijo
        // ni de una API externa de lenguaje. Ver Mapa_de_MIIA.docx,
        // sección "Fase 3 — Investigación autónoma".
        private const string TriggerChannel = "class1_trigger";

        // =======================================================
        // Constructor
        // =======================================================
        public MotorRiesgoProbabilidad()
        {
            redisUrl = Environment.GetEnvironmentVariable("REDIS_URL") ?? "localhost:6379";
            // FIX: ConfigurationOptions de StackExchange.Redis real
            opts = new ConfigurationOptions { AbortOnConnectFail = false, ConnectTimeout = 5000 };
            opts.EndPoints.Add(redisUrl.Replace("redis://",""));
            opts.KeepAlive = 10;
            SetupGlobalExceptionHandlers();
        }

        private void SetupGlobalExceptionHandlers()
        {
            try
            {
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    try
                    {
                        Console.WriteLine("[class41] UnhandledException: " + (e.ExceptionObject?.ToString() ?? "null"));
                    }
                    catch { }
                };

                TaskScheduler.UnobservedTaskException += (s, e) =>
                {
                    try
                    {
                        Console.WriteLine("[class41] UnobservedTaskException: " + (e.Exception?.Message ?? "null"));
                        e.SetObserved();
                    }
                    catch { }
                };
            }
            catch { }
        }

        public async Task ConnectRedisAsync()
        {
            while (true)
            {
                try
                {
                    redis = await ConnectionMultiplexer.ConnectAsync(opts).ConfigureAwait(false);
                    db = redis.GetDatabase();
                    sub = redis.GetSubscriber();

                    if (redis != null)
                    {
                        // ConnectionFailed uses RedisStubs.ConnectionFailedEventArgs
                        redis.ConnectionFailed += (sender, args) =>
                        {
                            try
                            {
                                // defensivo: usar reflexión si la propiedad no está presente en el tipo concreto
                                string ft = "unknown";
                                try
                                {
                                    var prop = args.GetType().GetProperty("FailureType");
                                    if (prop != null)
                                    {
                                        var val = prop.GetValue(args);
                                        if (val != null) ft = val.ToString() ?? "unknown";
                                    }
                                }
                                catch { ft = "unknown"; }

                                Console.WriteLine("[class41] Redis connection failed: " + ft);
                                if (sub != null)
                                    _ = SystemBus5.PublishSystemEvent(sub, "ERROR", new { msg = "Redis connection failed", detail = ft }, "class41");
                            }
                            catch { }
                        };

                        redis.ConnectionRestored += (sender, args) =>
                        {
                            try
                            {
                                Console.WriteLine("[class41] Redis connection restored");
                                if (sub != null)
                                    _ = SystemBus5.PublishSystemEvent(sub, "LOG", new { msg = "Redis connection restored" }, "class41");
                            }
                            catch { }
                        };
                    }

                    Console.WriteLine("[class41] Redis (stub) conectado");
                    break;
                }
                catch
                {
                    Console.WriteLine("[class41] Redis no disponible, reintentando...");
                    await Task.Delay(5000).ConfigureAwait(false);
                }
            }
        }

        public async Task RunAsync(CancellationToken token)
        {
            await ConnectRedisAsync().ConfigureAwait(false);

            if (sub == null)
            {
                Console.WriteLine("[class41] ERROR: subscriber nulo después de conectar Redis");
                return;
            }

            // FIX: RedisChannel.Literal + Action<RedisChannel,RedisValue>
            await sub.SubscribeAsync(RedisChannel.Literal(ChannelIn), async (ch41, msg41) =>
            {
                await _limiter.WaitAsync(token).ConfigureAwait(false);
                try
                {
                    try
                    {
                        // FIX CS0103: handler usa msg41 (RedisValue), no "message" (string del stub)
                        string json = msg41.ToString() ?? string.Empty;

                        var envelope = JsonSerializer.Deserialize<Class25Envelope>(
                            json,
                            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                        );

                        if (envelope == null)
                        {
                            await SystemBus5.PublishSystemEvent(sub, "LOG", new { msg = "class41 envelope nulo" }, "class41");
                            return;
                        }

                        if (envelope.Data.ValueKind != JsonValueKind.Object)
                        {
                            await SystemBus5.PublishSystemEvent(sub, "LOG", new { msg = "class41 data inválido" }, "class41");
                            return;
                        }

                        if (!string.Equals(envelope.Type, "forecast", StringComparison.OrdinalIgnoreCase))
                        {
                            return;
                        }

                        var input = envelope.Data.Deserialize<InputMessage>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

                        if (input == null)
                        {
                            await SystemBus5.PublishSystemEvent(sub, "LOG", new { msg = "class41 input interno nulo" }, "class41");
                            return;
                        }

                        double currentPrice = input.CurrentPrice;
                        List<Prediction>? preds = input.Ensemble?.Predictions;

                        if (preds == null || preds.Count == 0)
                        {
                            await SystemBus5.PublishSystemEvent(sub, "LOG", new { msg = "class41 WARNING: preds vacíos", ticker = input.Ticker }, "class41");
                            return;
                        }

                        double[] returns = CalculateReturnsFromPredictions(preds);

                        double probDown = CalcularProbCaida(preds, currentPrice);
                        double volatility = CalcularVolatilidad(returns);
                        double intervalWidthAvg = preds.Average(p => p.Upper - p.Lower);
                        double var90 = CalcularVaR(currentPrice, volatility);
                        double riskScore = CalcularRiskScore(probDown, volatility, intervalWidthAvg);
                        string riskLevel = ClasificarNivelRiesgo(riskScore);
                        string recommendation = GenerarRecomendacion(riskLevel);

                        string reason = riskLevel switch
                        {
                            "LOW" => "Riesgo bajo: condiciones estables.",
                            "MEDIUM" => "Riesgo medio: volatilidad moderada.",
                            "HIGH" => "Riesgo alto: alta probabilidad de caída.",
                            _ => "Evaluación no disponible."
                        };

                        var output = new OutputMessage
                        {
                            Ticker = input.Ticker,
                            Sector = input.Sector,
                            GeneratedAt = DateTime.UtcNow.ToString("o"),
                            RiskMetrics = new RiskMetrics
                            {
                                ProbDown = probDown,
                                Var90 = var90,
                                Volatility = volatility,
                                IntervalWidthAvg = intervalWidthAvg,
                                RiskScore = riskScore,
                                RiskLevel = riskLevel
                            },
                            Recommendation = recommendation,
                            Reason = reason,
                            Source = "class41",
                            Type = "risk_assessment",
                            CorrelationId = input.CorrelationId
                        };

                        string outJson = JsonSerializer.Serialize(output);

                        // Publish using ISubscriber
                        await sub.PublishAsync(RedisChannel.Literal(ChannelOut), (RedisValue)outJson).ConfigureAwait(false);

                        // ── OPCIÓN A: disparar búsqueda activa si el riesgo es HIGH ──
                        // Cuando class41 clasifica el riesgo como HIGH, le pedimos a
                        // class1 que investigue noticias reales sobre ese ticker/sector
                        // para dar contexto cualitativo a una condición que, numéricamente,
                        // ya se ve grave.
                        try
                        {
                            if (riskLevel == "HIGH" && sub != null)
                            {
                                var triggerPayload = new
                                {
                                    origen  = "class41",
                                    motivo  = "riesgo_alto",
                                    ticker  = output.Ticker,
                                    sector  = output.Sector,
                                    riskScore = Math.Round(riskScore, 4),
                                    riskLevel,
                                    queries = new[]
                                    {
                                        $"{output.Ticker} riesgo caida",
                                        $"{output.Sector} crisis mercado"
                                    },
                                    ts = DateTime.UtcNow.ToString("o")
                                };
                                string triggerJson = JsonSerializer.Serialize(triggerPayload);
                                await sub.PublishAsync(RedisChannel.Literal(TriggerChannel), (RedisValue)triggerJson).ConfigureAwait(false);

                                Console.WriteLine(
                                    $"[class41] 🔎 Trigger de búsqueda enviado a class1 → " +
                                    $"ticker={output.Ticker} sector={output.Sector} riskScore={riskScore:F3} (HIGH)");
                            }
                        }
                        catch (Exception triggerEx)
                        {
                            // El trigger es una mejora, no algo crítico — nunca debe
                            // tumbar el flujo principal de publicación del riesgo.
                            Console.WriteLine($"[class41] WARNING: trigger de búsqueda falló: {triggerEx.Message}");
                        }
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            await SystemBus5.PublishSystemEvent(sub, "ERROR", new { msg = $"class41 ERROR: {ex.Message}", stack = ex.StackTrace }, "class41");
                        }
                        catch { }
                    }
                }
                finally
                {
                    _limiter.Release();
                }
            }).ConfigureAwait(false);

            while (!token.IsCancellationRequested)
            {
                await Task.Delay(50, token).ConfigureAwait(false);
            }
        }

        // =======================================================
        // Aux functions
        // =======================================================
        private double[] CalculateReturnsFromPredictions(List<Prediction> preds)
        {
            if (preds == null || preds.Count < 2) return Array.Empty<double>();

            double[] returns = new double[preds.Count - 1];
            for (int i = 1; i < preds.Count; i++)
            {
                returns[i - 1] = preds[i - 1].Value == 0 ? 0 : (preds[i].Value - preds[i - 1].Value) / preds[i - 1].Value;
            }
            return returns;
        }

        public double CalcularProbCaida(List<Prediction> preds, double precioActual)
        {
            if (preds == null || preds.Count == 0) return 0;
            int downCount = preds.Count(p => p.Lower < precioActual);
            return (double)downCount / preds.Count;
        }

        public double CalcularVolatilidad(double[] retornos)
        {
            if (retornos == null || retornos.Length == 0) return 0;
            double avg = retornos.Average();
            double sumSq = retornos.Sum(r => Math.Pow(r - avg, 2));
            return Math.Sqrt(sumSq / retornos.Length);
        }

        public double CalcularVaR(double price, double sigma)
        {
            const double Z = 1.65;
            return price * sigma * Z;
        }

        public double CalcularRiskScore(double probDown, double sigma, double intervalWidthAvg)
        {
            double val = 0.5 * probDown + 0.3 * sigma + 0.2 * intervalWidthAvg;
            return Math.Clamp(val, 0.0, 1.0);
        }

        public string ClasificarNivelRiesgo(double riskScore)
        {
            if (riskScore <= 0.33) return "LOW";
            if (riskScore <= 0.66) return "MEDIUM";
            return "HIGH";
        }

        public string GenerarRecomendacion(string riskLevel)
        {
            return riskLevel switch
            {
                "LOW" => "BUY",
                "MEDIUM" => "HOLD",
                "HIGH" => "REDUCE / AVOID",
                _ => "NO RECOMMENDATION"
            };
        }

        // =======================================================
        // DTOs (nullable everywhere)
        // =======================================================
        private sealed class Class25Envelope
        {
            [JsonPropertyName("id")] public string? Id { get; set; }
            [JsonPropertyName("source")] public string? Source { get; set; }
            [JsonPropertyName("type")] public string? Type { get; set; }
            [JsonPropertyName("text")] public string? Text { get; set; }
            [JsonPropertyName("data")] public JsonElement Data { get; set; }
            [JsonPropertyName("ts")] public string? Ts { get; set; }
        }

        public class InputMessage
        {
            [JsonPropertyName("ticker")] public string? Ticker { get; set; }
            [JsonPropertyName("sector")] public string? Sector { get; set; }
            [JsonPropertyName("horizonDays")] public int HorizonDays { get; set; }
            [JsonPropertyName("ensemble")] public Ensemble? Ensemble { get; set; }
            [JsonPropertyName("historicalVolatility")] public double HistoricalVolatility { get; set; }
            [JsonPropertyName("currentPrice")] public double CurrentPrice { get; set; }
            [JsonPropertyName("correlationId")] public string? CorrelationId { get; set; }
        }

        public class Ensemble
        {
            [JsonPropertyName("predictions")] public List<Prediction>? Predictions { get; set; }
        }

        public class Prediction
        {
            [JsonPropertyName("dayOffset")] public int DayOffset { get; set; }
            [JsonPropertyName("value")] public double Value { get; set; }
            [JsonPropertyName("lower")] public double Lower { get; set; }
            [JsonPropertyName("upper")] public double Upper { get; set; }
        }

        public class OutputMessage
        {
            [JsonPropertyName("ticker")] public string? Ticker { get; set; }
            [JsonPropertyName("sector")] public string? Sector { get; set; }
            [JsonPropertyName("generatedAt")] public string? GeneratedAt { get; set; }
            [JsonPropertyName("riskMetrics")] public RiskMetrics? RiskMetrics { get; set; }
            [JsonPropertyName("recommendation")] public string? Recommendation { get; set; }
            [JsonPropertyName("reason")] public string? Reason { get; set; }
            [JsonPropertyName("source")] public string Source { get; set; } = "class41";
            [JsonPropertyName("type")] public string Type { get; set; } = "risk_assessment";
            [JsonPropertyName("correlationId")] public string? CorrelationId { get; set; }
        }

        public class RiskMetrics
        {
            [JsonPropertyName("probDown")] public double ProbDown { get; set; }
            [JsonPropertyName("var90")] public double Var90 { get; set; }
            [JsonPropertyName("volatility")] public double Volatility { get; set; }
            [JsonPropertyName("intervalWidthAvg")] public double IntervalWidthAvg { get; set; }
            [JsonPropertyName("riskScore")] public double RiskScore { get; set; }
            [JsonPropertyName("riskLevel")] public string? RiskLevel { get; set; }
        }
    }
}

// ==========================================================
// Diagnóstico robusto (standalone, safe)
// ==========================================================
public static class DiagnosticoProbabilidades2
{
    public static void Imprimir(
        string origen,
        IDictionary<string, double>? probabilidades,
        string estado = "desconocido"
    )
    {
        try
        {
            Console.WriteLine();
            Console.WriteLine("════════════════════════════════════════════");
            Console.WriteLine("🧠 DIAGNÓSTICO DE PROBABILIDADES");
            Console.WriteLine($"• Origen : {origen}");
            Console.WriteLine($"• Estado : {estado}");
            Console.WriteLine($"• UTC    : {DateTime.UtcNow:O}");
            Console.WriteLine("════════════════════════════════════════════");

            if (probabilidades == null || probabilidades.Count == 0)
            {
                Console.WriteLine("⚠️  No se recibieron probabilidades.");
                Console.WriteLine("════════════════════════════════════════════");
                return;
            }

            double suma = 0.0;
            int validas = 0;

            foreach (var kv in probabilidades)
            {
                if (double.IsNaN(kv.Value) || double.IsInfinity(kv.Value))
                {
                    Console.WriteLine($"❌ {kv.Key,-22} → valor inválido");
                    continue;
                }

                double p = Math.Clamp(kv.Value, 0.0, 1.0);
                suma += p;
                validas++;

                Console.WriteLine(
                    $"• {kv.Key,-22} → {(p * 100):F2}% {Barra(p)}"
                );
            }

            Console.WriteLine("════════════════════════════════════════════");

            if (validas == 0)
            {
                Console.WriteLine("❌ No hubo probabilidades válidas.");
            }
            else
            {
                Console.WriteLine($"Σ Confianza total : {(suma * 100):F02}%");

                if (suma < 0.85)
                    Console.WriteLine("⚠️  Baja confianza global (incertidumbre elevada).");
                else if (suma > 1.15)
                    Console.WriteLine("⚠️  Sobreconfianza detectada (posible sesgo).");
                else
                    Console.WriteLine("✅ Distribución probabilística saludable.");
            }

            Console.WriteLine("════════════════════════════════════════════");
        }
        catch (Exception ex)
        {
            try
            {
                Console.WriteLine("❌ Fallo interno en DiagnosticoProbabilidades");
                Console.WriteLine(ex.Message);
            }
            catch { }
        }
    }

    private static string Barra(double p)
    {
        try
        {
            int bloques = (int)Math.Round(p * 20);
            bloques = Math.Max(0, Math.Min(20, bloques));
            return "[" + new string('█', bloques) + new string('░', 20 - bloques) + "]";
        }
        catch
        {
            return "[????????????????????]";
        }
    }
}

// ==========================================================
// Program41 entrypoint — evita duplicados de 'Program'
// ==========================================================
public static class Program41
{
    public static async Task<int> Main(string[] args)
    {
        var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            Console.WriteLine("[class41] Cancel requested, shutting down...");
            cts.Cancel();
        };

        try
        {
            var processor = new MIIA.Motores.MotorRiesgoProbabilidad();
            Console.WriteLine("[class41] Starting MotorRiesgoProbabilidad...");
            await processor.RunAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine("[class41] Execution cancelled.");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[class41] Fatal error: " + ex.Message);
            return 1;
        }

        Console.WriteLine("[class41] Exiting normally.");
        return 0;
    }
}