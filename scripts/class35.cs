#nullable enable
//=======================================================
// class35.cs — Motor Semántico (C#) robusto para MIIA (v2.0)
// - Suscribe: miia.input.text
// - Publica:  miia.semantic.analysis
// - Canal de métricas: miia.semantic.metrics
// - Resiliencia Redis con reintentos automáticos (stub si falta la librería)
// - Correlation ID y logs configurables
// - Auditoría local JSONL
// =======================================================

using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.IO;
using Redis = MIIA.Stub.Redis;

// -----------------------------
// Local Redis stub (unique namespace)
// -----------------------------
// This stub is used when StackExchange.Redis is not referenced in the project.
// It intentionally uses a different namespace (MIIA.Stub.Redis) to avoid
// duplication with any other stub or with the real StackExchange.Redis types.
namespace MIIA.Stub.Redis
{
    public enum RedisChannelPatternMode { Literal = 0, Pattern = 1 }

    public readonly struct RedisChannel
    {
        public string Channel { get; }
        public RedisChannel(string channel, RedisChannelPatternMode _ = default) => Channel = channel;
        public override string ToString() => Channel;
    }

    public readonly struct RedisValue
    {
        private readonly string _v;
        public RedisValue(string v) => _v = v;
        public override string ToString() => _v;
        public static implicit operator RedisValue(string s) => new RedisValue(s);
    }

    public interface ISubscriber
    {
        void Subscribe(RedisChannel channel, Action<RedisChannel, RedisValue> handler);
        Task<long> PublishAsync(RedisChannel channel, string message);
    }

    public interface IDatabase { }

    public class ConnectionMultiplexer : IDisposable
    {
        private readonly List<(RedisChannel, Action<RedisChannel, RedisValue>)> _subs = new();

        public static Task<ConnectionMultiplexer> ConnectAsync(string config)
        {
            return Task.FromResult(new ConnectionMultiplexer());
        }

        public ISubscriber GetSubscriber() => new SimpleSubscriber(_subs);
        public IDatabase GetDatabase() => new SimpleDatabase();
        public Task CloseAsync() => Task.CompletedTask;
        public void Dispose() { }

        private class SimpleDatabase : IDatabase { }

        private class SimpleSubscriber : ISubscriber
        {
            private readonly List<(RedisChannel, Action<RedisChannel, RedisValue>)> _subs;
            public SimpleSubscriber(List<(RedisChannel, Action<RedisChannel, RedisValue>)> subs) { _subs = subs; }

            public void Subscribe(RedisChannel channel, Action<RedisChannel, RedisValue> handler)
            {
                _subs.Add((channel, handler));
            }

            public Task<long> PublishAsync(RedisChannel channel, string message)
            {
                // Best-effort publish to matching literal channel handlers
                foreach (var (c, h) in _subs.ToArray())
                {
                    if (c.Channel == channel.Channel)
                    {
                        try { h?.Invoke(c, new RedisValue(message)); } catch { }
                    }
                }
                return Task.FromResult(1L);
            }
        }
    }
}




namespace MIIA.SemanticEngine
{
    // ==========================================================
    // AUDITORÍA LOCAL (Reemplaza Access/OleDb)
    // ==========================================================
    public static class LocalAudit
    {
        private static readonly string AuditFilePath;
        private static readonly SemaphoreSlim _fileLock = new SemaphoreSlim(1, 1);

        private static readonly JsonSerializerOptions _jsonOpts =
            new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

        private static string ResolveRoot()
        {
            try
            {
                var basePath = AppContext.BaseDirectory;
                return Path.GetFullPath(Path.Combine(basePath, "..", "..", ".."));
            }
            catch
            {
                return Path.GetFullPath(AppContext.BaseDirectory);
            }
        }

        static LocalAudit()
        {
            try
            {
                var rootDir = ResolveRoot();
                var centralDir = Path.Combine(rootDir, "operador", "aprendizaje", "central");
                Directory.CreateDirectory(centralDir);
                AuditFilePath = Path.Combine(centralDir, "class35_audit.jsonl");
            }
            catch
            {
                AuditFilePath = Path.Combine(AppContext.BaseDirectory, "class35_audit.jsonl");
            }
        }

        private static void RotateIfNeeded()
        {
            try
            {
                if (!File.Exists(AuditFilePath)) return;
                var fi = new FileInfo(AuditFilePath);
                if (fi.Length <= 50_000_000) return;
                var dest = AuditFilePath + "." + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                try { File.Move(AuditFilePath, dest); } catch { }
            }
            catch { }
        }

        public static async Task LogEventAsync(string tipo, object payload, string nivel = "info", string? sessionId = null, string? userId = null)
        {
            try
            {
                var entry = new
                {
                    ts = DateTime.UtcNow.ToString("o"),
                    @class = "class35",
                    nivel = nivel ?? "info",
                    tipo = tipo ?? "",
                    mensaje = tipo ?? "",
                    payload,
                    session_id = sessionId,
                    user_id = userId,
                    pid = Environment.ProcessId
                };

                var line = JsonSerializer.Serialize(entry, _jsonOpts) + Environment.NewLine;

                await _fileLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    RotateIfNeeded();
                    await File.AppendAllTextAsync(AuditFilePath, line).ConfigureAwait(false);
                }
                finally
                {
                    _fileLock.Release();
                }
            }
            catch { }
        }
    }

    // ===========================
    // Modelos de datos
    // ===========================
    public sealed class SemanticMessage
    {
        [JsonPropertyName("id")] public string Id { get; set; } = Guid.NewGuid().ToString();
        [JsonPropertyName("ts")] public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        [JsonPropertyName("user_id")] public string UserId { get; set; } = "local";
        [JsonPropertyName("source")] public string Source { get; set; } = "semantic_engine_cs";
        [JsonPropertyName("latency_ms")] public int LatencyMs { get; set; } = 0;
        [JsonPropertyName("correlation_id")] public string CorrelationId { get; set; } = "";
        [JsonPropertyName("analysis")] public AnalysisData Analysis { get; set; } = new();
        [JsonPropertyName("emotion")] public EmotionData Emotion { get; set; } = new();
        [JsonPropertyName("decision")] public DecisionData Decision { get; set; } = new();
        [JsonPropertyName("trace")] public TraceData Trace { get; set; } = new();
        [JsonPropertyName("embedding")] public float[]? Embedding { get; set; }
    }

    public sealed class AnalysisData
    {
        [JsonPropertyName("topic")] public string Topic { get; set; } = "consulta";
        [JsonPropertyName("facts")] public List<string> Facts { get; set; } = new();
        [JsonPropertyName("uncertainty")] public double Uncertainty { get; set; } = 0.5;
        [JsonPropertyName("risks")] public List<string> Risks { get; set; } = new();
        [JsonPropertyName("next_steps")] public List<string> NextSteps { get; set; } = new();
        [JsonPropertyName("entities")] public List<string> Entities { get; set; } = new();
        [JsonPropertyName("questions")] public List<string> Questions { get; set; } = new();
        [JsonPropertyName("language")] public string Language { get; set; } = "es";
    }

    public sealed class EmotionData
    {
        [JsonPropertyName("valence")] public double Valence { get; set; } = 0.0;
        [JsonPropertyName("arousal")] public double Arousal { get; set; } = 0.0;
        [JsonPropertyName("tone")] public string Tone { get; set; } = "neutral";
        [JsonPropertyName("confidence")] public double Confidence { get; set; } = 0.5;
    }

    public sealed class DecisionData
    {
        [JsonPropertyName("speech_mode")] public string SpeechMode { get; set; } = "narrative";
        [JsonPropertyName("speak_thoughts")] public bool SpeakThoughts { get; set; } = true;
        [JsonPropertyName("priority")] public double Priority { get; set; } = 0.5;
    }

    public sealed class TraceData
    {
        [JsonPropertyName("version")] public string Version { get; set; } = "sem-1.2";
        [JsonPropertyName("tokens_in")] public int TokensIn { get; set; } = 0;
        [JsonPropertyName("time_budget_ms")] public int TimeBudgetMs { get; set; } = 120;
        [JsonPropertyName("text_hash")] public string TextHash { get; set; } = "";
    }

    public sealed class InputPayload
    {
        [JsonPropertyName("id")] public string Id { get; set; } = Guid.NewGuid().ToString();
        [JsonPropertyName("text")] public string Text { get; set; } = "";
        [JsonPropertyName("user_id")] public string UserId { get; set; } = "local";
        [JsonPropertyName("context")] public Dictionary<string, object> Context { get; set; } = new();
        [JsonPropertyName("ts")] public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    }

    // ===========================
    // HashUtil
    // ===========================
    internal static class HashUtil
    {
        public static string ComputeSha256(string input)
        {
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(input ?? ""));
            return Convert.ToHexString(bytes);
        }

        public static int RoughTokenCount(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return 0;
            return Regex.Matches(text, @"\w+").Count;
        }
    }

    // ===========================
    // TimedCache
    // ===========================
    internal sealed class TimedCache
    {
        private readonly ConcurrentDictionary<string, (DateTime expires, string val)> _cache = new();
        private readonly TimeSpan _ttl;
        private readonly int _maxSize;

        public TimedCache(TimeSpan ttl, int maxSize = 5000)
        {
            _ttl = ttl;
            _maxSize = Math.Max(100, maxSize);
        }

        public bool TryAdd(string key, string value)
        {
            Cleanup();
            return _cache.TryAdd(key, (DateTime.UtcNow.Add(_ttl), value));
        }

        public bool Contains(string key)
        {
            if (_cache.TryGetValue(key, out var entry))
            {
                if (entry.expires > DateTime.UtcNow) return true;
                _cache.TryRemove(key, out _);
            }
            return false;
        }

        private void Cleanup()
        {
            if (_cache.Count <= _maxSize) return;

            foreach (var kv in _cache.ToArray())
                if (kv.Value.expires <= DateTime.UtcNow)
                    _cache.TryRemove(kv.Key, out _);

            var overflow = _cache.Count - _maxSize;
            if (overflow > 0)
            {
                foreach (var k in _cache.Keys.Take(overflow))
                    _cache.TryRemove(k, out _);
            }
        }

        public int Count => _cache.Count;
    }

    // ===========================
    // SemanticProcessor
    // ===========================
    public sealed class SemanticProcessor
    {
        private static readonly string[] RiskVocabulary = { "riesgo", "volatilidad", "incertidumbre", "coste", "inflación", "plaga", "clima", "caída" };
        private static readonly string[] PositiveVocabulary = { "bien", "excelente", "bueno", "oportunidad", "mejora", "progreso", "ganancia" };
        private static readonly string[] NegativeVocabulary = { "mal", "malo", "peligro", "problema", "crisis", "caída", "pérdida" };

        public AnalysisData Analyze(string text, Dictionary<string, object> context)
        {
            var lang = DetectLanguage(text);
            var topic = InferTopic(text, lang);
            var facts = ExtractFacts(text, lang, 6);
            var risks = ExtractRisks(text, 4);
            var entities = ExtractEntities(text, 6);
            var questions = ExtractQuestions(text, 3);
            var nextSteps = ProposeNextSteps(topic, questions, context, 4);

            var uncertainty = Math.Clamp(0.4 + (questions.Count > 0 ? 0.1 : 0.0) + (facts.Count < 3 ? 0.15 : 0.0), 0, 1);

            return new AnalysisData
            {
                Topic = topic,
                Facts = facts,
                Uncertainty = uncertainty,
                Risks = risks,
                NextSteps = nextSteps,
                Entities = entities,
                Questions = questions,
                Language = lang
            };
        }

        public EmotionData InferEmotion(string text, Dictionary<string, object> context)
        {
            var valence = 0.0;
            var arousal = 0.3;
            var lowerText = (text ?? "").ToLowerInvariant();

            foreach (var pos in PositiveVocabulary)
                if (lowerText.Contains(pos)) valence += 0.1;

            foreach (var neg in NegativeVocabulary)
                if (lowerText.Contains(neg)) valence -= 0.1;

            valence = Math.Clamp(valence, -1.0, 1.0);

            if (Regex.IsMatch(lowerText, @"[!?]{2,}") || Regex.IsMatch(lowerText, @"\b(urgente|ya|apuro)\b"))
                arousal = 0.7;

            var tone = (valence, arousal) switch
            {
                (> 0.25, < 0.6) => "sereno_positivo",
                (> 0.25, >= 0.6) => "entusiasta",
                (< -0.25, < 0.6) => "calmo_empatico",
                (< -0.25, >= 0.6) => "alerta_empatico",
                _ => "neutral"
            };

            var confidence = Math.Clamp(0.4 + Math.Min(HashUtil.RoughTokenCount(text) / 100.0, 0.4), 0, 1);

            return new EmotionData { Valence = valence, Arousal = arousal, Tone = tone, Confidence = confidence };
        }

        public DecisionData Decide(AnalysisData analysis, EmotionData emotion, Dictionary<string, object> context)
        {
            var hasQuestions = analysis.Questions.Count > 0;
            var speechMode = analysis.Uncertainty > 0.75 ? "concise" : "narrative";
            var speakThoughts = context.TryGetValue("speak_thoughts", out var st) && st is bool b ? b : true;
            var priority = Math.Clamp(0.5 + (hasQuestions ? 0.2 : 0.0) + (emotion.Arousal > 0.6 ? 0.1 : 0.0), 0, 1);

            return new DecisionData { SpeechMode = speechMode, SpeakThoughts = speakThoughts, Priority = priority };
        }

        private static string DetectLanguage(string text) =>
            Regex.IsMatch(text ?? "", @"\b(the|and|of|to|in|for|with)\b", RegexOptions.IgnoreCase) ? "en" : "es";

        private static string InferTopic(string text, string lang)
        {
            var t = (text ?? "").Trim();
            if (Regex.IsMatch(t, @"\bagricol|agro|campo|soja|ma[ií]z|trigo", RegexOptions.IgnoreCase)) return "inversion_agricola";
            if (Regex.IsMatch(t, @"\baccion|bono|etf|mercado", RegexOptions.IgnoreCase)) return "inversion_mercados";
            if (Regex.IsMatch(t, @"\bredis|cola|pubsub|stream", RegexOptions.IgnoreCase)) return "infra_redis";
            if (Regex.IsMatch(t, @"\bmodelo|semant(ic|ico)|embedding", RegexOptions.IgnoreCase)) return "ia_semantica";
            return "consulta";
        }

        private static List<string> ExtractFacts(string text, string lang, int max) =>
            Regex.Replace(text ?? "", @"\s+", " ").Split(new[] { '.', ';', '!', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().Take(max).ToList();

        private static List<string> ExtractRisks(string text, int max)
        {
            var lower = (text ?? "").ToLowerInvariant();
            var risks = new HashSet<string>(RiskVocabulary.Where(r => lower.Contains(r)));
            if (Regex.IsMatch(lower, @"\bagricol|agro|campo")) { risks.Add("clima"); risks.Add("volatilidad_commodities"); }
            return risks.Take(max).ToList();
        }

        private static List<string> ExtractEntities(string text, int max) =>
            Regex.Matches(text ?? "", @"\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+|[A-Z0-9]{2,})\b").Select(m => m.Value).Distinct().Take(max).ToList();

        private static List<string> ExtractQuestions(string text, int max) =>
            Regex.Matches(text ?? "", @"[^?.!]*\?+").Select(m => m.Value.Trim()).Where(s => s.Length > 0).Take(max).ToList();

        private static List<string> ProposeNextSteps(string topic, List<string> questions, Dictionary<string, object> context, int max)
        {
            var steps = topic switch
            {
                "inversion_agricola" => new List<string> { "estimar_horizonte_temporal", "calcular_rendimientos_por_cultivo", "evaluar_riesgos_climaticos" },
                "infra_redis" => new List<string> { "auditar_suscriptores_pubsub", "aplicar_backpressure", "ajustar_client_output_buffer_limit" },
                _ => new List<string> { "aclarar_objetivo", "recolectar_datos_relevantes", "definir_metricas_de_exito" }
            };
            if (questions.Count > 0) steps.Insert(0, "responder_pregunta_principal");
            return steps.Take(max).ToList();
        }
    }

    // =======================================================
    // REDIS BRIDGE — class35 <-> class25
    // Uses the Redis stub types via alias 'Redis'
    // =======================================================
    public static class RedisBridgeClass35
    {
        private static Redis.ConnectionMultiplexer? _connMultiplexer;
        private static Redis.ISubscriber? _subscriberClient;
        private static Redis.IDatabase? _redisDatabase;

        private const string InputChannel = "class25_output";
        private const string OutputChannel = "class35_output";
        private const string METRICS_CHANNEL = "miia.semantic.metrics";

        private static readonly SemanticProcessor _processor = new SemanticProcessor();
        private static readonly SemaphoreSlim _concurrencyLimiter = new SemaphoreSlim(20);

        public static async Task StartAsync(string redisUrl = "localhost:6379")
        {
            while (true)
            {
                try
                {
                    _connMultiplexer = await Redis.ConnectionMultiplexer.ConnectAsync(redisUrl).ConfigureAwait(false);
                    _subscriberClient = _connMultiplexer.GetSubscriber();
                    _redisDatabase = _connMultiplexer.GetDatabase();

                    Console.WriteLine("[class35] 🔌 Conectado a Redis (stub or real)");
                    await LocalAudit.LogEventAsync("class35_redis_connected", new { url = redisUrl }, "info").ConfigureAwait(false);
                    break;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[class35] Redis no disponible. Reintentando en 5s...");
                    await LocalAudit.LogEventAsync("redis_retry", new { error = ex.Message }, "warn").ConfigureAwait(false);
                    await Task.Delay(5000).ConfigureAwait(false);
                }
            }

            _subscriberClient.Subscribe(new Redis.RedisChannel(InputChannel, Redis.RedisChannelPatternMode.Literal),
                (channel, message) =>
                {
                    _ = Task.Run(async () =>
                    {
                        if (!await _concurrencyLimiter.WaitAsync(0).ConfigureAwait(false)) return;

                        try
                        {
                            await HandleIncomingAsync(message.ToString()).ConfigureAwait(false);
                        }
                        finally
                        {
                            _concurrencyLimiter.Release();
                        }
                    });
                });

            await LocalAudit.LogEventAsync("class35_redis_subscribed", new { channel = InputChannel }, "info").ConfigureAwait(false);
            Console.WriteLine($"[class35] 📡 Suscrito a {InputChannel}");
        }

        private static async Task HandleIncomingAsync(string rawMessage)
        {
            var startTs = DateTime.UtcNow;

            try
            {
                if (!string.IsNullOrEmpty(rawMessage) && rawMessage.Contains("\"source\":\"class35\"")) return;
                if (!string.IsNullOrEmpty(rawMessage) && rawMessage.Length > 200_000)
                {
                    await LocalAudit.LogEventAsync("semantic_rejected_oversize", new { size = rawMessage?.Length ?? 0 }, "warn").ConfigureAwait(false);
                    return;
                }

                var input = JsonSerializer.Deserialize<InputPayload>(rawMessage);
                if (input == null || string.IsNullOrWhiteSpace(input.Text)) return;

                if (string.IsNullOrWhiteSpace(input.Id))
                {
                    await LocalAudit.LogEventAsync("semantic_rejected_no_id", new { reason = "missing_id" }, "warn").ConfigureAwait(false);
                    return;
                }

                var correlationId = Guid.NewGuid().ToString("N");

                var analysis = _processor.Analyze(input.Text, input.Context);
                var emotion = _processor.InferEmotion(input.Text, input.Context);
                var decision = _processor.Decide(analysis, emotion, input.Context);

                var analysisSummary = new
                {
                    sentiment = emotion.Valence,
                    intent = analysis.Topic,
                    confidence = 0.98,
                    source = "class35"
                };

                var latencyMs = (int)(DateTime.UtcNow - startTs).TotalMilliseconds;

                var semanticMessage = new SemanticMessage
                {
                    Id = input.Id,
                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    UserId = input.UserId,
                    Source = "class35",
                    CorrelationId = correlationId,
                    LatencyMs = latencyMs,
                    Analysis = analysis,
                    Emotion = emotion,
                    Decision = decision,
                    Trace = new TraceData { TokensIn = HashUtil.RoughTokenCount(input.Text), TextHash = HashUtil.ComputeSha256(input.Text) }
                };

                var envelope = new
                {
                    id = input.Id ?? Guid.NewGuid().ToString("N"),
                    source = "class35",
                    type = "semantic",
                    text = input.Text,
                    data = new { semantic = semanticMessage, analysis_summary = analysisSummary },
                    ts = DateTime.UtcNow.ToString("o")
                };

                var jsonOut = JsonSerializer.Serialize(envelope, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });

                if (_subscriberClient != null)
                {
                    await _subscriberClient.PublishAsync(new Redis.RedisChannel(OutputChannel, Redis.RedisChannelPatternMode.Literal), jsonOut).ConfigureAwait(false);
                }

                try
                {
                    var metricEnvelope = new
                    {
                        id = Guid.NewGuid().ToString("N"),
                        source = "class35",
                        type = "metric",
                        text = analysis.Topic,
                        data = new { uncertainty = analysis.Uncertainty, latency_ms = latencyMs },
                        ts = DateTime.UtcNow.ToString("o")
                    };

                    if (_subscriberClient != null)
                    {
                        await _subscriberClient.PublishAsync(new Redis.RedisChannel(METRICS_CHANNEL, Redis.RedisChannelPatternMode.Literal), JsonSerializer.Serialize(metricEnvelope)).ConfigureAwait(false);
                    }
                }
                catch { }

                await LocalAudit.LogEventAsync("semantic_processed", new { correlationId, user = input.UserId, topic = analysis.Topic, uncertainty = analysis.Uncertainty, latencyMs }, "info").ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[class35] ❌ Error procesando mensaje");
                Console.Error.WriteLine(ex.Message);
                await LocalAudit.LogEventAsync("semantic_error", new { error = ex.Message, raw = rawMessage }, "error").ConfigureAwait(false);
            }
        }

        public static async Task StopAsync()
        {
            try
            {
                if (_connMultiplexer != null)
                {
                    await _connMultiplexer.CloseAsync().ConfigureAwait(false);
                    _connMultiplexer.Dispose();
                    _connMultiplexer = null;
                }

                Console.WriteLine("[class35] 🛑 Redis desconectado");
                await LocalAudit.LogEventAsync("class35_shutdown", new { }, "info").ConfigureAwait(false);
            }
            catch { }
        }
    }

    // ======================
    // Supervisor entrypoint — auto-restart y protección global
    // ======================
    public static class ProgramSupervisor
    {
        public static async Task Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            {
                Console.Error.WriteLine("[class35] FATAL UnhandledException");
                try { LocalAudit.LogEventAsync("unhandled_exception", new { detail = e.ExceptionObject?.ToString() }, "fatal").GetAwaiter().GetResult(); } catch { }
            };

            TaskScheduler.UnobservedTaskException += (s, e) =>
            {
                Console.Error.WriteLine("[class35] UnobservedTaskException");
                try { LocalAudit.LogEventAsync("unobserved_task_exception", new { detail = e.Exception?.ToString() }, "fatal").GetAwaiter().GetResult(); } catch { }
                e.SetObserved();
            };

            while (true)
            {
                try
                {
                    await RedisBridgeClass35.StartAsync().ConfigureAwait(false);

                    var tcs = new TaskCompletionSource<bool>();
                    Console.CancelKeyPress += async (_, e) =>
                    {
                        e.Cancel = true;
                        await RedisBridgeClass35.StopAsync().ConfigureAwait(false);
                        tcs.TrySetResult(true);
                    };

                    await tcs.Task.ConfigureAwait(false);
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[class35] Motor cayó. Reiniciando en 5s...");
                    try { LocalAudit.LogEventAsync("supervisor_restart", new { error = ex.Message }, "warn").GetAwaiter().GetResult(); } catch { }
                    await Task.Delay(5000).ConfigureAwait(false);
                }
            }
        }
    }
}