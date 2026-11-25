//=======================================================
// class3.cs — Motor Vectorial Semántico (MIIA)
// VERSIÓN CORREGIDA v1.9.1
// Cambios respecto a la versión anterior:
//   1. ProcesarMensajeRedisAdapt: payload ahora incluye el vector real
//      (antes solo mandaba vector_size, ahora manda el array completo)
//   2. Publicar "dotnet_ready" al conectar Redis para que index.js sepa que está listo
//   3. Acepta campo "texto" además de "text" (compatibilidad con DSL v2.0)
//   4. Logs más claros: muestra qué canal escucha y dónde publica
//   5. Heartbeat reducido a 30s (antes 60s) para mejor monitoreo
//=======================================================

#nullable disable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Threading;
using StackExchange.Redis;


namespace LocalStubs.SerilogMinimal
{
    public static class Log
    {
        public static void Information(string template, params object[] args)
            => Console.WriteLine("[INFO] " + string.Format(template, args));

        public static void Error(Exception ex, string template, params object[] args)
        {
            try { Console.Error.WriteLine("[ERROR] " + string.Format(template, args) + " — " + (ex?.Message ?? "")); }
            catch { Console.Error.WriteLine("[ERROR] " + (ex?.Message ?? "Error")); }
        }

        public static void Error(string template, params object[] args)
            => Console.Error.WriteLine("[ERROR] " + string.Format(template, args));

        public static void Debug(string template, params object[] args)
            => Console.WriteLine("[DEBUG] " + string.Format(template, args));

        public static void Fatal(string template, params object[] args)
            => Console.Error.WriteLine("[FATAL] " + string.Format(template, args));
    }
}

namespace LocalStubs.MathNet.Numerics.LinearAlgebra
{
    public abstract class Vector<T>
    {
        public abstract int Count { get; }
        public abstract T this[int index] { get; set; }
        public abstract double L2Norm();
        public abstract double DotProduct(Vector<T> other);
        public abstract double[] ToArray();
        public static VectorBuilder<T> Build => new VectorBuilder<T>();
    }

    public class VectorBuilder<T>
    {
        public Vector<T> SparseOfIndexed(int length, IEnumerable<Tuple<int, double>> indexed)
        {
            var arr = new double[length];
            foreach (var t in indexed)
                if (t.Item1 >= 0 && t.Item1 < length) arr[t.Item1] = t.Item2;
            return (Vector<T>)(object)new LocalStubs.MathNet.Numerics.LinearAlgebra.Double.DenseVector(arr);
        }

        public Vector<T> OfArray(double[] arr)
            => (Vector<T>)(object)new LocalStubs.MathNet.Numerics.LinearAlgebra.Double.DenseVector(arr);
    }
}

namespace LocalStubs.MathNet.Numerics.LinearAlgebra.Double
{
    public sealed class DenseVector : LocalStubs.MathNet.Numerics.LinearAlgebra.Vector<double>
    {
        private double[] _data;
        public DenseVector(int size) { _data = new double[size]; }
        public DenseVector(double[] data) { _data = (double[])data.Clone(); }
        public override int Count => _data.Length;
        public override double this[int index] { get => _data[index]; set => _data[index] = value; }

        public override double L2Norm()
        {
            double s = 0;
            foreach (var v in _data) s += v * v;
            return Math.Sqrt(s);
        }

        public override double DotProduct(LocalStubs.MathNet.Numerics.LinearAlgebra.Vector<double> other)
        {
            if (other == null) return 0;
            if (other.Count != Count) throw new ArgumentException("Dimension mismatch");
            double s = 0;
            for (int i = 0; i < Count; i++) s += _data[i] * other[i];
            return s;
        }

        public static DenseVector OfArray(double[] arr) => new DenseVector(arr);

        public static DenseVector operator /(DenseVector v, double scalar)
        {
            var o = new double[v.Count];
            for (int i = 0; i < v.Count; i++) o[i] = v[i] / scalar;
            return new DenseVector(o);
        }

        public static DenseVector operator -(DenseVector a, DenseVector b)
        {
            if (a.Count != b.Count) throw new ArgumentException("Dimension mismatch");
            var o = new double[a.Count];
            for (int i = 0; i < a.Count; i++) o[i] = a[i] - b[i];
            return new DenseVector(o);
        }

        public override double[] ToArray() => (double[])_data.Clone();
    }
}

namespace LocalStubs.MicrosoftMLData
{
    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public sealed class VectorTypeAttribute : Attribute { public VectorTypeAttribute() { } }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public sealed class ColumnNameAttribute : Attribute { public ColumnNameAttribute(string name) { } }
}

namespace Class3Adaptado
{
    using LRedis = StackExchange.Redis;
    using LLog   = LocalStubs.SerilogMinimal;
    using LMath  = LocalStubs.MathNet.Numerics.LinearAlgebra;
    using LMathD = LocalStubs.MathNet.Numerics.LinearAlgebra.Double;
    using LML    = LocalStubs.MicrosoftMLData;

    // =======================================================
    // CONFIG LOADER
    // =======================================================
    public static class ConfigLoaderAdapt
    {
        public static Dictionary<string, object> CargarConfiguracionAdapt()
        {
            try
            {
                string basePath     = AppContext.BaseDirectory;
                string root         = Path.GetFullPath(Path.Combine(basePath, "..", "..", ".."));
                string configPath   = Path.Combine(root, "operador", "aprendizaje", "config");

                if (!Directory.Exists(configPath))
                    configPath = Path.Combine(basePath, "config");

                if (!Directory.Exists(configPath))
                    throw new DirectoryNotFoundException($"No existe la carpeta config: {configPath}");

                var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

                foreach (var file in Directory.GetFiles(configPath, "*.json"))
                {
                    try
                    {
                        var data = JsonSerializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                        if (data != null)
                            foreach (var kv in data) result[kv.Key] = kv.Value;
                    }
                    catch { }
                }

                foreach (var file in Directory.GetFiles(configPath, "*.ini"))
                {
                    foreach (var line in File.ReadAllLines(file))
                    {
                        string trimmed = line.Trim();
                        if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith("#")) continue;
                        if (!trimmed.Contains("=")) continue;
                        var parts = trimmed.Split("=", 2);
                        result[parts[0].Trim()] = parts[1].Trim();
                    }
                }

                return result;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[class3adapt] Error cargando configuraciones: {ex.Message}");
                return new Dictionary<string, object>();
            }
        }
    }

    // =======================================================
    // REDIS CONFIG
    // =======================================================
    public static class RedisConfigAdapt
    {
        public static readonly string RedisUrlAdapt =
            Environment.GetEnvironmentVariable("REDIS_URL") ?? "localhost:6379";

        // Canal de entrada: recibe textos desde class1, class2, class4
        public static readonly string[] RedisInputChannelsAdapt = new[] { "class3_ingest" };

        // Canal de salida: publica vectores hacia class19 (filtro semántico)
        public static readonly string RedisOutputChannelAdapt = "class19_ingest";

        // Canal de arranque: notifica a index.js que el motor está listo
        public static readonly string ReadyChannel = "dotnet_ready";

        public static readonly string MotorIDAdapt = "class3_vectorial";
    }

    // =======================================================
    // SYSTEM BUS
    // =======================================================
    public static class SystemBusAdapt
    {
        private static readonly Dictionary<string, string> SYSTEM_CHANNELS_ADAPT = new()
        {
            { "LOG",     "system.log"     },
            { "ERROR",   "system.error"   },
            { "METRICS", "system.metrics" }
        };

        public static async Task PublishSystemEventAdapt(
            LRedis.ISubscriber redisClient,
            string eventType,
            object payload,
            string source = "unknown")
        {
            if (!SYSTEM_CHANNELS_ADAPT.ContainsKey(eventType)) return;
            var envelope = new { ts = DateTime.UtcNow.ToString("O"), source, type = eventType, payload };
            await redisClient.PublishAsync(RedisChannel.Literal(SYSTEM_CHANNELS_ADAPT[eventType]), JsonSerializer.Serialize(envelope));
        }
    }

    // =======================================================
    // BASE PATHS
    // =======================================================
    public static class BasePathsAdapt
    {
        private static string ResolveRootAdapt()
        {
            try
            {
                var basePath = AppDomain.CurrentDomain.BaseDirectory;
                return Path.GetFullPath(Path.Combine(basePath, "..", "..", ".."));
            }
            catch { return Path.GetFullPath(AppContext.BaseDirectory); }
        }

        public static readonly string RootDirAdapt   = ResolveRootAdapt();
        public static readonly string BaseDirAdapt   = Path.Combine(RootDirAdapt, "operador", "aprendizaje");
        public static readonly string LogsDirAdapt   = Path.Combine(BaseDirAdapt, "logs");
        public static readonly string JsonDirAdapt   = Path.Combine(BaseDirAdapt, "json_guardados");
        public static readonly string RawDirAdapt    = Path.Combine(BaseDirAdapt, "raw");
        public static readonly string MetricsDirAdapt = Path.Combine(BaseDirAdapt, "metrics");
        public static readonly string ConfigDirAdapt = Path.Combine(BaseDirAdapt, "config");

        public static void EnsureDirectoriesAdapt()
        {
            foreach (var dir in new[] { LogsDirAdapt, JsonDirAdapt, RawDirAdapt, MetricsDirAdapt, ConfigDirAdapt })
            {
                try
                {
                    Directory.CreateDirectory(dir);
                    Console.WriteLine($"[class3adapt] 📁 Directorio verificado: {dir}");
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[class3adapt] ❌ Error creando {dir}: {ex.Message}");
                    throw;
                }
            }
        }
    }

    // =======================================================
    // LOGGER MANAGER
    // =======================================================
    public static class LoggerManagerAdapt
    {
        private static readonly string LogFileAdapt =
            Path.Combine(BasePathsAdapt.LogsDirAdapt, "class3adapt.log");

        public static void ConfigureAdapt()
        {
            BasePathsAdapt.EnsureDirectoriesAdapt();
            LLog.Log.Information("[class3adapt] Logger configurado.");
        }

        public static async Task GuardarEventoAsyncAdapt(string tipo, object payload)
        {
            var line = JsonSerializer.Serialize(new
            {
                ts = DateTime.UtcNow.ToString("o"), tipo, payload
            }) + Environment.NewLine;

            try
            {
                await File.AppendAllTextAsync(LogFileAdapt, line, Encoding.UTF8);
                var info = new FileInfo(LogFileAdapt);
                Console.WriteLine(info.Length > 0
                    ? $"[class3adapt] ✅ Log actualizado ({(info.Length / 1024.0):F2} KB)"
                    : "[class3adapt] ⚠️ Archivo log creado pero vacío.");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[class3adapt] ❌ Error guardando log: {e.Message}");
                try
                {
                    string fb = Path.Combine(BasePathsAdapt.BaseDirAdapt,
                        $"error_log_fallback_{DateTime.UtcNow:yyyyMMdd_HHmmss}.txt");
                    await File.WriteAllTextAsync(fb, line, Encoding.UTF8);
                    Console.WriteLine($"[class3adapt] Log alternativo guardado en {fb}");
                }
                catch { }
            }
        }
    }

    // =======================================================
    // MODELOS
    // =======================================================
    public class DocumentoAdapt
    {
        public string IdAdapt    { get; set; } = Guid.NewGuid().ToString();
        public string TextoAdapt { get; set; } = "";
        public double[] VectorAdapt { get; set; } = Array.Empty<double>();
    }

    // =======================================================
    // TF-IDF PROCESSOR
    // =======================================================
    public class TFIDFProcessorAdapt
    {
        private Dictionary<string, int> _vocabularioCacheAdapt = new(StringComparer.OrdinalIgnoreCase);
        private bool _vocabularioCacheActivoAdapt = false;

        public List<LMathD.DenseVector> CalcularTFIDFAdapt(List<string> documentosAdapt)
        {
            if (documentosAdapt == null || documentosAdapt.Count == 0)
                throw new ArgumentException("No se proporcionaron documentos.");

            var vocabulario = _vocabularioCacheActivoAdapt
                ? _vocabularioCacheAdapt
                : new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            var docTermFreqs = new List<Dictionary<int, double>>();
            int index = vocabulario.Count;

            foreach (var doc in documentosAdapt)
            {
                var tokens = PreprocesarTextoAdapt(doc);
                var tf = new Dictionary<int, double>();
                foreach (var token in tokens)
                {
                    if (!vocabulario.TryGetValue(token, out int termIndex))
                    {
                        termIndex = index++;
                        vocabulario[token] = termIndex;
                    }
                    tf[termIndex] = tf.GetValueOrDefault(termIndex, 0) + 1.0;
                }
                docTermFreqs.Add(tf);
            }

            _vocabularioCacheAdapt = vocabulario;
            _vocabularioCacheActivoAdapt = true;

            int docCount = documentosAdapt.Count;
            var docFreq = new int[vocabulario.Count];
            foreach (var tf in docTermFreqs)
                foreach (var k in tf.Keys) docFreq[k]++;

            var vectores = new List<LMathD.DenseVector>();
            var builder = LMath.Vector<double>.Build;
            const double eps = 1e-10;

            foreach (var tf in docTermFreqs)
            {
                var indexed = tf.Select(kv =>
                {
                    double tfNorm = 1.0 + Math.Log(kv.Value + eps);
                    double idf    = Math.Log((docCount + eps) / (1.0 + docFreq[kv.Key])) + 1.0;
                    return Tuple.Create(kv.Key, tfNorm * idf);
                });

                var vectorSparse = builder.SparseOfIndexed(vocabulario.Count, indexed);
                double norm = vectorSparse.L2Norm();
                if (norm > 0)
                {
                    var arr = new double[vectorSparse.Count];
                    for (int i = 0; i < vectorSparse.Count; i++) arr[i] = vectorSparse[i] / norm;
                    vectores.Add(new LMathD.DenseVector(arr));
                }
                else
                {
                    vectores.Add(new LMathD.DenseVector(vectorSparse.ToArray()));
                }
            }

            return vectores;
        }

        private List<string> PreprocesarTextoAdapt(string textoAdapt)
        {
            if (string.IsNullOrWhiteSpace(textoAdapt)) return new List<string>();

            var normalized = new string(textoAdapt.ToLowerInvariant()
                .Where(c => char.IsLetterOrDigit(c) || char.IsWhiteSpace(c)).ToArray());

            var tokens = normalized
                .Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .ToList();

            var stopwords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "el","la","los","las","un","una","unos","unas","de","del","y","a","en","por","para",
                "con","sin","se","que","como","más","menos","su","sus","es","fue","son","ser",
                "está","están","han","hay","the","and","an","in","on","of","for","with","without",
                "is","are","was","were","be","been","to","by","that","this","it","at","as","from"
            };

            tokens = tokens.Where(t => !stopwords.Contains(t) && t.Length > 2).ToList();

            var ngrams = new List<string>();
            for (int n = 1; n <= 3; n++)
                for (int i = 0; i <= tokens.Count - n; i++)
                    ngrams.Add(string.Join(" ", tokens.Skip(i).Take(n)));

            return ngrams;
        }
    }

    // =======================================================
    // VECTORIZADOR DE ANCHO FIJO — 26-sep-2026
    // =======================================================
    //
    // POR QUÉ EXISTE. El camino viejo llamaba a `GenerarVectoresAdapt()` en
    // CADA mensaje, y eso recalculaba el TF-IDF de TODO el corpus: para cada
    // documento pedía un `double[vocabulario.Count]` DENSO y guardaba la lista
    // entera en `VectoresAdapt`. Dos consecuencias, las dos medidas:
    //
    //   1. MEMORIA CUADRÁTICA. El tokenizador arma n-gramas de 1 a 3, así que
    //      el vocabulario crece ~6 entradas por documento como PISO (medido con
    //      titulares que se repiten mucho; con titulares reales, más). Lo
    //      retenido es N docs × V dims × 8 B:
    //          3.000 mensajes → 405 MB      10.000 (el tope) → ~4,7 GB
    //      El server tiene 4,3 GB disponibles y ya pierde ~59 MB/día por
    //      class30. Esto no era lento: tumbaba la VPS.
    //
    //   2. LA DIMENSIÓN CAMBIABA SOLA. `dimension = min(vocabulario, 128)`, y el
    //      vocabulario arranca en cero y crece. class23 y class24 crean UNA RED
    //      POR (fuente, dimensión) — justamente para que un cambio de
    //      representación no reuse pesos ajenos—, así que los primeros mensajes
    //      habrían creado `web|8`, `web|37`, `web|91`… una red nueva por cada
    //      dimensión hasta pasar 128. Docenas de redes basura con tres muestras
    //      cada una, y `actualizar()` renormaliza TODAS las claves: cada red
    //      muerta diluye a las vivas.
    //
    // EL ARREGLO es el mismo principio que el rediseño del vector de class10
    // (64 → 22 dims): el ancho NO PUEDE DEPENDER DEL CORPUS. Se hashea cada
    // término a uno de DIMS baldes fijos (feature hashing) y el IDF se estima
    // con contadores rodantes: DIMS + 1 números en total.
    //
    //   memoria  O(DIMS)               — constante, 65 doubles
    //   CPU      O(tokens del mensaje) — no vuelve a mirar el corpus
    //   clave    web|64, para siempre
    //
    // TRES DECISIONES, con su motivo:
    //
    //   · DIMS = 64 y SÓLO UNIGRAMAS. Con 64 baldes, sumar bigramas y trigramas
    //     da ~90 términos por titular: casi todos los baldes se prenden y el
    //     vector se vuelve un término CASI COMÚN a los 50 instrumentos. Es la
    //     misma trampa que class21 y class22 aportando una constante al
    //     ensamble — y una constante no mueve un puesto del ranking. Con
    //     unigramas quedan ~20-30 baldes activos de 64.
    //     Tampoco 128: a ~75 noticias por día, una red de 128 entradas tendría
    //     la peor relación muestras/parámetro del sistema, el problema que la
    //     evaluación offline ya midió en `impacto` con 12 dims.
    //
    //   · FNV-1a, NO `string.GetHashCode()`. En .NET Core el hash de string está
    //     ALEATORIZADO POR PROCESO: con él, cada reinicio del motor mandaría el
    //     mismo término a otro balde y la red entrenada sobre los baldes viejos
    //     quedaría midiendo otra cosa, sin un solo error en el log. (`meta.hash`
    //     de este archivo lo sigue usando, pero ahí sólo identifica un texto
    //     dentro de la corrida.)
    //
    //   · IDF CON OLVIDO, vida media 5.000 documentos. Misma decisión y misma
    //     constante que `g_base` en class25A: un IDF acumulado desde el arranque
    //     termina pesando el vocabulario de hace meses y no el flujo reciente.
    //     `CLASS3_IDF_VIDA_MEDIA=0` vuelve al acumulado sin olvido.
    public static class VectorHash3
    {
        public const int DIMS       = 64;
        public const int MAX_TOKENS = 400;   // acota el trabajo de un fragmento de PDF

        private static readonly double[] _df = new double[DIMS];
        private static double _docs = 0.0;
        private static readonly object _lock = new object();
        private static readonly double _decay;
        private static readonly double _vidaMedia;
        private static long _vectorizados = 0;

        public static long   Vectorizados => Interlocked.Read(ref _vectorizados);
        public static double VidaMedia    => _vidaMedia;
        public static double Documentos   { get { lock (_lock) { return _docs; } } }

        static VectorHash3()
        {
            double h = 5000.0;
            var raw = Environment.GetEnvironmentVariable("CLASS3_IDF_VIDA_MEDIA");
            // InvariantCulture a propósito: el server es Ubuntu y con locale
            // es-AR "5000.0" no parsea. Es el riesgo que sim17 ya cubre.
            if (!string.IsNullOrWhiteSpace(raw) &&
                double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && v >= 0)
                h = v;
            _vidaMedia = h;
            _decay     = h > 0 ? Math.Exp(-Math.Log(2.0) / h) : 1.0;
        }

        // Stopwords estáticas: el camino viejo rearmaba este HashSet en cada
        // llamada, o sea una vez por documento y por mensaje.
        private static readonly HashSet<string> STOP = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "el","la","los","las","un","una","unos","unas","de","del","y","a","en","por","para",
            "con","sin","se","que","como","más","menos","su","sus","es","fue","son","ser",
            "está","están","han","hay","the","and","an","in","on","of","for","with","without",
            "is","are","was","were","be","been","to","by","that","this","it","at","as","from"
        };

        // FNV-1a de 32 bits sobre los chars. Determinista entre procesos y entre
        // reinicios, que es lo único que se le pide.
        public static uint Fnv1a(string s)
        {
            uint h = 2166136261u;
            for (int i = 0; i < s.Length; i++)
            {
                h ^= s[i];
                h *= 16777619u;
            }
            return h;
        }

        public static int Balde(string token) => (int)(Fnv1a(token) % (uint)DIMS);

        public static List<string> Tokenizar(string texto)
        {
            var salida = new List<string>();
            if (string.IsNullOrWhiteSpace(texto)) return salida;

            var sb = new StringBuilder(texto.Length);
            foreach (var c in texto)
                sb.Append(char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : ' ');

            foreach (var t in sb.ToString().Split(SEPARADORES, StringSplitOptions.RemoveEmptyEntries))
            {
                if (t.Length <= 2 || STOP.Contains(t)) continue;
                salida.Add(t);
                if (salida.Count >= MAX_TOKENS) break;
            }
            return salida;
        }

        private static readonly char[] SEPARADORES = new char[] { ' ' };

        // Devuelve null si el texto no da ningún término utilizable.
        public static double[] Vectorizar(string texto, out int activas)
        {
            activas = 0;
            var tokens = Tokenizar(texto);
            if (tokens.Count == 0) return null;

            var tf = new double[DIMS];
            foreach (var t in tokens) tf[Balde(t)] += 1.0;

            var vec = new double[DIMS];
            lock (_lock)
            {
                // Se decae ANTES de contar este documento, así el peso de un
                // término sigue el flujo reciente y no el acumulado histórico.
                for (int i = 0; i < DIMS; i++) _df[i] *= _decay;
                _docs = _docs * _decay + 1.0;
                for (int i = 0; i < DIMS; i++) if (tf[i] > 0) _df[i] += 1.0;

                for (int i = 0; i < DIMS; i++)
                {
                    if (tf[i] <= 0) continue;
                    double tfn = 1.0 + Math.Log(tf[i]);
                    double idf = Math.Log((_docs + 1.0) / (1.0 + _df[i])) + 1.0;
                    vec[i] = tfn * idf;      // los dos factores son >= 1: nunca negativo
                }
            }

            // L2. Con todo no negativo esto deja cada componente en [0,1] —que es
            // lo que esperan class19 y las redes— y hace comparables dos textos
            // de largo distinto.
            double norma = 0.0;
            for (int i = 0; i < DIMS; i++) norma += vec[i] * vec[i];
            norma = Math.Sqrt(norma);
            if (!(norma > 0.0)) return null;

            for (int i = 0; i < DIMS; i++)
            {
                double x = vec[i] / norma;
                if (!double.IsFinite(x)) x = 0.0;
                vec[i] = x;
                if (x > 0.001) activas++;    // el mismo umbral que dimsActivas de class19
            }

            Interlocked.Increment(ref _vectorizados);
            return vec;
        }
    }

    // =======================================================
    // MOTOR VECTOIDES
    // =======================================================
    public class MotorVectoidesAdapt
    {
        public List<string> DocumentosAdapt { get; set; } = new();
        public List<LMathD.DenseVector> VectoresAdapt { get; set; } = new();

        private readonly TFIDFProcessorAdapt _tfidf = new();

        public void AgregarDocumentoAdapt(string textoAdapt)
        {
            if (string.IsNullOrWhiteSpace(textoAdapt))
                throw new ArgumentException("El texto no puede ser vacío.");
            DocumentosAdapt.Add(textoAdapt);
            if (DocumentosAdapt.Count > 10000) DocumentosAdapt.RemoveAt(0);
        }

        public List<LMathD.DenseVector> GenerarVectoresAdapt()
        {
            VectoresAdapt.Clear();
            var vectoresRaw = _tfidf.CalcularTFIDFAdapt(DocumentosAdapt);
            foreach (var v in vectoresRaw)
            {
                VectoresAdapt.Add(NormalizarVectorAdapt(v));
                if (VectoresAdapt.Count > 10000) VectoresAdapt.RemoveAt(0);
            }
            return VectoresAdapt;
        }

        public LMathD.DenseVector NormalizarVectorAdapt(LMathD.DenseVector vectorAdapt)
        {
            var norm = vectorAdapt.L2Norm();
            return norm > 0 ? (LMathD.DenseVector)(vectorAdapt / norm) : vectorAdapt;
        }

        public double SimilitudCosenoAdapt(LMathD.DenseVector v1, LMathD.DenseVector v2)
        {
            if (v1.Count != v2.Count) throw new ArgumentException("Los vectores deben tener la misma dimensión.");
            var denom = v1.L2Norm() * v2.L2Norm();
            return denom == 0 ? 0 : v1.DotProduct(v2) / denom;
        }

        public (int indice, double similitud) BuscarVectorMasCercanoAdapt(LMathD.DenseVector consulta)
        {
            if (VectoresAdapt.Count == 0)
                throw new InvalidOperationException("No hay vectores disponibles para búsqueda.");

            double maxSim = double.MinValue;
            int maxIdx = -1;
            for (int i = 0; i < VectoresAdapt.Count; i++)
            {
                double sim = SimilitudCosenoAdapt(consulta, VectoresAdapt[i]);
                if (sim > maxSim) { maxSim = sim; maxIdx = i; }
            }
            return (maxIdx, maxSim);
        }

        public KMeansResultAdapt PredecirConKMeansAdapt(int k = 2)
        {
            if (VectoresAdapt.Count < k)
                return new KMeansResultAdapt();

            try
            {
                var centros = new List<LMathD.DenseVector>();
                for (int i = 0; i < k; i++)
                    centros.Add(new LMathD.DenseVector(VectoresAdapt[i % VectoresAdapt.Count].ToArray()));

                var etiquetas = new int[VectoresAdapt.Count];
                bool changed = true;
                int iterations = 0;

                while (changed && iterations < 100)
                {
                    changed = false;
                    iterations++;

                    for (int i = 0; i < VectoresAdapt.Count; i++)
                    {
                        double best = double.MinValue;
                        int bestIdx = 0;
                        for (int c = 0; c < centros.Count; c++)
                        {
                            double sim = SimilitudCosenoAdapt(VectoresAdapt[i], centros[c]);
                            if (sim > best) { best = sim; bestIdx = c; }
                        }
                        if (etiquetas[i] != bestIdx) { etiquetas[i] = bestIdx; changed = true; }
                    }

                    for (int c = 0; c < k; c++)
                    {
                        var members = new List<double[]>();
                        for (int i = 0; i < VectoresAdapt.Count; i++)
                            if (etiquetas[i] == c) members.Add(VectoresAdapt[i].ToArray());
                        if (members.Count == 0) continue;
                        var len = members[0].Length;
                        var sum = new double[len];
                        foreach (var m in members)
                            for (int j = 0; j < len; j++) sum[j] += m[j];
                        for (int j = 0; j < len; j++) sum[j] /= members.Count;
                        centros[c] = new LMathD.DenseVector(sum);
                    }
                }

                var distancias = new double[VectoresAdapt.Count];
                for (int i = 0; i < VectoresAdapt.Count; i++)
                    distancias[i] = (VectoresAdapt[i] - centros[etiquetas[i]]).L2Norm();

                LLog.Log.Information("[class3adapt] ✅ Clustering OK. {0} grupos, {1} vectores.",
                    k, VectoresAdapt.Count);

                return new KMeansResultAdapt
                {
                    CentrosAdapt   = centros,
                    EtiquetasAdapt = etiquetas,
                    DistanciasAdapt = distancias
                };
            }
            catch (Exception ex)
            {
                LLog.Log.Error(ex, "[class3adapt] ❌ Error en K-Means.");
                return new KMeansResultAdapt();
            }
        }
    }

    public class KMeansResultAdapt
    {
        public List<LMathD.DenseVector> CentrosAdapt   { get; set; } = new();
        public int[]    EtiquetasAdapt  { get; set; } = Array.Empty<int>();
        public double[] DistanciasAdapt { get; set; } = Array.Empty<double>();
    }

    // =======================================================
    // ALMACENAMIENTO
    // =======================================================
    public class AlmacenamientoAprendizajeAdapt
    {
        private readonly string basePathAdapt;

        public AlmacenamientoAprendizajeAdapt(string basePath)
        {
            if (string.IsNullOrWhiteSpace(basePath))
                throw new ArgumentException("La ruta base no puede ser vacía.");
            this.basePathAdapt = basePath;
            Directory.CreateDirectory(basePath);
        }

        public void GuardarVectorAdapt(string archivoNombre, double[] vector)
        {
            var ruta = Path.Combine(basePathAdapt, archivoNombre);
            File.WriteAllText(ruta, JsonSerializer.Serialize(vector,
                new JsonSerializerOptions { WriteIndented = true }));
            LLog.Log.Information("[class3adapt] Vector guardado en {0}", ruta);
        }
    }

    // =======================================================
    // PROGRAM ADAPTADO — PUNTO DE ENTRADA
    // =======================================================
    public class ProgramAdaptado
    {
        private static MotorVectoidesAdapt             motorAdapt;
        private static AlmacenamientoAprendizajeAdapt  almacenamientoAdapt;
        private static LRedis.ISubscriber              redisSubscriberAdapt;

        public static async Task Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                LLog.Log.Fatal("[class3adapt] UnhandledException: {0}", e.ExceptionObject);

            TaskScheduler.UnobservedTaskException += (s, e) =>
            {
                LLog.Log.Fatal("[class3adapt] UnobservedTaskException: {0}",
                    e.Exception?.Message ?? e.Exception.ToString());
                e.SetObserved();
            };

            LoggerManagerAdapt.ConfigureAdapt();

            Console.WriteLine("[class3adapt] 🔧 Motor vectorial semántico iniciando...");
            Console.WriteLine($"[class3adapt] 📥 Canal de entrada : {string.Join(", ", RedisConfigAdapt.RedisInputChannelsAdapt)}");
            Console.WriteLine($"[class3adapt] 📤 Canal de salida  : {RedisConfigAdapt.RedisOutputChannelAdapt}");

            motorAdapt          = new MotorVectoidesAdapt();
            almacenamientoAdapt = new AlmacenamientoAprendizajeAdapt(BasePathsAdapt.BaseDirAdapt);

            var config = ConfigLoaderAdapt.CargarConfiguracionAdapt();
            LLog.Log.Debug("[class3adapt] Configuraciones cargadas: {0} claves", config.Count);

            // ── Conectar Redis con retry ──────────────────────────────────
            ConnectionMultiplexer redisConnectionAdapt = null;
            try
            {
                redisConnectionAdapt = await ConectarRedisConRetryAdapt();
                Console.WriteLine(redisConnectionAdapt.IsConnected
                    ? "[class3adapt] ✅ Redis conectado correctamente."
                    : "[class3adapt] ⚠️ Redis no conectado. Procesamiento limitado.");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[class3adapt] ❌ Redis no disponible: {ex.Message}");
                Console.WriteLine("[class3adapt] 🔁 Reintentando en 5 segundos...");
                await Task.Delay(5000);
                await Main(args);
                return;
            }

            // ── Publicar dotnet_ready para que index.js continúe el arranque ──
            try
            {
                redisSubscriberAdapt = redisConnectionAdapt.GetSubscriber();

                var readyMsg = JsonSerializer.Serialize(new
                {
                    source    = RedisConfigAdapt.MotorIDAdapt,
                    status    = "ready",
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    canales   = RedisConfigAdapt.RedisInputChannelsAdapt
                });

                await redisSubscriberAdapt.PublishAsync(RedisChannel.Literal(RedisConfigAdapt.ReadyChannel), readyMsg);
                Console.WriteLine($"[class3adapt] 📢 '{RedisConfigAdapt.ReadyChannel}' publicado — motor listo");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[class3adapt] ⚠️ No pudo publicar ready: {ex.Message}");
            }

            // ── Suscribir a canales de entrada ────────────────────────────
            try
            {
                foreach (var channelAdapt in RedisConfigAdapt.RedisInputChannelsAdapt)
                {
                    await redisSubscriberAdapt.SubscribeAsync(RedisChannel.Literal(channelAdapt), async (ch, msg) =>
                    {
                        try   { await ProcesarMensajeRedisAdapt(msg); }
                        catch (Exception ex)
                        { LLog.Log.Error(ex, "[class3adapt] Error en suscripción"); }
                    });

                    Console.WriteLine($"[class3adapt] 📡 Suscrito → {channelAdapt}");
                }
            }
            catch (Exception ex)
            {
                LLog.Log.Error(ex, "[class3adapt] Error al suscribirse a canales Redis");
            }

            Console.WriteLine("[class3adapt] 🚀 Pipeline activo. Esperando datos reales...");

            // ── Heartbeat cada 30 segundos ────────────────────────────────
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    // Los contadores son los del vectorizador de ancho fijo. El
                    // corpus de MotorVectoidesAdapt YA NO SE ALIMENTA desde el
                    // camino de mensajes (ver VECTORIZADOR DE ANCHO FIJO): informar
                    // docs:0 sería informar un número que dejó de existir.
                    Console.WriteLine(
                        "[class3adapt] ❤️ vectorizados:{0} publicados:{1} con_symbol:{2} " +
                        "sin_texto:{3} pocas_dims:{4} dims:{5} idf_vida_media:{6} | {7}",
                        VectorHash3.Vectorizados, _publicadosAdapt, _conSymbolAdapt,
                        _sinTextoAdapt, _pocasDimsAdapt, VectorHash3.DIMS,
                        VectorHash3.VidaMedia, DateTime.UtcNow.ToString("o"));
                    await Task.Delay(TimeSpan.FromSeconds(30));
                }
            });

            await Task.Delay(-1);
        }

        // =======================================================
        // PROCESAR MENSAJE — REESCRITO EL 26-sep-2026
        //
        // Antes: recalculaba el TF-IDF del corpus entero en cada mensaje
        //        (memoria cuadrática, dimensión variable) y tiraba el
        //        instrumento que class1 ya traía.
        // Ahora: un vector de ANCHO FIJO (VectorHash3) y el `symbol`
        //        propagado hasta class19 y las redes.
        // =======================================================
        private static long _publicadosAdapt   = 0;   // vectores que salieron
        private static long _sinTextoAdapt     = 0;   // mensajes sin texto utilizable
        private static long _pocasDimsAdapt    = 0;   // texto demasiado pobre
        private static long _conSymbolAdapt    = 0;   // de los publicados, con instrumento

        // class19 exige 10 dims activas (FILTRO.MIN_DIMS_ACTIVAS). Publicar por
        // debajo de eso sólo le llena el contador de rechazos: se descarta acá y
        // se cuenta, para que el chequeo distinga "texto pobre" de "no llegó nada".
        private const int MIN_ACTIVAS_ADAPT = 10;

        // El instrumento, con el MISMO orden de búsqueda que class19 (class19.js:238)
        // para que los dos resuelvan lo mismo. Devuelve null cuando no hay: mandar
        // la cadena "GENERAL" le cambiaría a class19 la métrica de cambio.
        public static string SymbolDe(JsonElement root)
        {
            string s = LeerStrAdapt(root, "symbol") ?? LeerStrAdapt(root, "ticker");
            if (s == null && root.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object)
                s = LeerStrAdapt(data, "symbol") ?? LeerStrAdapt(data, "ticker");
            if (string.IsNullOrWhiteSpace(s)) return null;
            s = s.Trim().ToUpperInvariant();
            // Mismo criterio que canonSymbol() de class23/class24 y que
            // _esSenalDeMercado de class43: lo que no es un instrumento, no es.
            if (s == "GENERAL" || s == "UNKNOWN" || s.StartsWith("CLASS")) return null;
            return s;
        }

        private static string LeerStrAdapt(JsonElement o, string prop)
        {
            if (o.ValueKind != JsonValueKind.Object) return null;
            if (!o.TryGetProperty(prop, out var v)) return null;
            return v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }

        private static async Task ProcesarMensajeRedisAdapt(LRedis.RedisValue msgAdapt)
        {
            try
            {
                if (msgAdapt.IsNullOrEmpty) return;

                string json = msgAdapt.ToString();
                if (string.IsNullOrWhiteSpace(json)) return;

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                // Validar campo id (contrato DSL)
                if (!root.TryGetProperty("id", out var idProp)) return;
                string id = idProp.GetString() ?? Guid.NewGuid().ToString();

                // Aceptar campo "texto" O "text" (compatibilidad DSL v1.9 y v2.0)
                string texto = LeerStrAdapt(root, "texto") ?? LeerStrAdapt(root, "text") ?? "";
                if (string.IsNullOrWhiteSpace(texto))
                {
                    Interlocked.Increment(ref _sinTextoAdapt);
                    return;
                }

                string symbol = SymbolDe(root);

                int activas;
                var vecArr = VectorHash3.Vectorizar(texto, out activas);
                if (vecArr == null)
                {
                    Interlocked.Increment(ref _sinTextoAdapt);
                    return;
                }
                if (activas < MIN_ACTIVAS_ADAPT)
                {
                    Interlocked.Increment(ref _pocasDimsAdapt);
                    return;
                }

                // Una muestra en disco cada 200, no una por mensaje. Antes escribía
                // un JSON por cada uno: con los fragmentos de PDF de class2/class5
                // son cientos de archivos por carga, sin que nadie los lea.
                long n = VectorHash3.Vectorizados;
                if (n % 200 == 1)
                    almacenamientoAdapt?.GuardarVectorAdapt(
                        $"vector_class3_{DateTime.UtcNow:yyyyMMdd_HHmmss}.json", vecArr);

                // ── Payload en formato DSL estándar ──────────────────────
                // Contrato definido en MIIA_v2_DSL_Redis.docx — canal class19_ingest
                var resultado = new Dictionary<string, object>
                {
                    ["id"]        = Guid.NewGuid().ToString(),
                    ["source"]    = RedisConfigAdapt.MotorIDAdapt,   // "class3_vectorial"
                    ["type"]      = "vector",
                    ["fuente"]    = "web",                            // → red web|64
                    ["vector"]    = vecArr,
                    ["dimension"] = VectorHash3.DIMS,
                    // class19 usa `confianza` si viene; mandarla explícita evita
                    // depender de su fallback (activas/dims, que da lo mismo hoy
                    // pero no tiene por qué seguir dándolo).
                    ["confianza"] = (double)activas / VectorHash3.DIMS,
                    ["text"]      = texto.Length > 300 ? texto.Substring(0, 300) : texto,
                    ["meta"]      = new
                    {
                        timestamp      = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                        texto_original = texto.Substring(0, Math.Min(200, texto.Length)),
                        hash           = texto.GetHashCode().ToString("x8"),
                        origen_id      = id,                       // id del mensaje original
                        dims_activas   = activas,
                        tokens         = VectorHash3.Tokenizar(texto).Count
                    },
                    ["ts"]        = DateTime.UtcNow.ToString("O")
                };
                // Sólo si hay instrumento. La ausencia del campo es lo que class19
                // resuelve a null, y de eso depende su métrica de cambio.
                if (symbol != null)
                {
                    resultado["symbol"] = symbol;
                    resultado["ticker"] = symbol;
                    Interlocked.Increment(ref _conSymbolAdapt);
                }

                if (redisSubscriberAdapt != null)
                {
                    await redisSubscriberAdapt.PublishAsync(
                        RedisChannel.Literal(RedisConfigAdapt.RedisOutputChannelAdapt),
                        JsonSerializer.Serialize(resultado));

                    Interlocked.Increment(ref _publicadosAdapt);

                    Console.WriteLine(
                        $"[class3adapt] 📨 Vector publicado → {RedisConfigAdapt.RedisOutputChannelAdapt} " +
                        $"| {symbol ?? "GENERAL"} dims:{VectorHash3.DIMS} activas:{activas}");
                }

                await LoggerManagerAdapt.GuardarEventoAsyncAdapt("vector_publicado", new
                {
                    id        = resultado["id"],
                    dimension = VectorHash3.DIMS,
                    activas,
                    symbol
                });
            }
            catch (JsonException) { /* JSON malformado — ignorar silenciosamente */ }
            catch (Exception ex)
            {
                LLog.Log.Error(ex, "[class3adapt] Error procesando mensaje Redis");
            }
        }

        // =======================================================
        // CONECTAR REDIS CON RETRY
        // =======================================================
        private static async Task<ConnectionMultiplexer>
            ConectarRedisConRetryAdapt()
        {
            while (true)
            {
                try
                {
                    // FIX: usar ConfigurationOptions igual que class10.cs y class18.cs
                    // .ConnectAsync(url) simple no tiene retry ni timeout configurables
                    var opts = new ConfigurationOptions {
                        EndPoints     = { RedisConfigAdapt.RedisUrlAdapt.Replace("redis://","") },
                        ConnectTimeout = 5000,
                        SyncTimeout    = 5000,
                        ReconnectRetryPolicy = new ExponentialRetry(500),
                        AbortOnConnectFail = false
                    };
                    var conn = await ConnectionMultiplexer.ConnectAsync(opts);
                    return conn;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[class3adapt] Redis retry en 5s: {ex.Message}");
                    await Task.Delay(5000);
                }
            }
        }
    }
}