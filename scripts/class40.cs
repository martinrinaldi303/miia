// =======================================================
// HybridForecastProcessor.cs (Motor Predictivo Híbrido Reescrito) — MIIA v2.0
// class40
// =======================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Numerics;
using System.Diagnostics.CodeAnalysis;

// NOTE: This file contains internal stubs for Redis and avoids external native dependencies
// so it can compile and run for local testing. Replace stubs with StackExchange.Redis and MathNet.Numerics for production.

// FIX: usando StackExchange.Redis real en lugar de stubs internos
// ANTES: stubs en MIIA.Motores → class40 nunca recibía mensajes de class25_output
using StackExchange.Redis;

namespace MIIA.Motores
{

    // =======================================================
    // HybridForecastProcessor — Motor predictivo híbrido
    // =======================================================
    public class HybridForecastProcessor : IDisposable
    {
        // =======================================================
        // 1. Redis — Inicialización de Conexión (NO conectar en constructor)
        // =======================================================
        private readonly string _redisEndpoint;
        private ConfigurationOptions _redisConfigOptions;
        private ConnectionMultiplexer? _redisConnection;
        private IDatabase? _redisDb;
        private ISubscriber? _redisSub;

        private volatile bool _isRedisConnected = false;
        private volatile bool _reconnecting = false;

        // Canales renombrados para claridad
        // ── Canales, recableados el 26-sep-2026 ──────────────────────────────
        // ANTES: entrada `class25_output`, salida `class40_output`. Las DOS mal:
        //
        //  · ENTRADA. class40 parsea {ticker, sector, horizonDays, series:[{ts,
        //    close}]} — una SERIE DE PRECIOS — y class25_output lleva decisiones.
        //    Nunca produjo nada, y no por el entrypoint: por el contrato. Ahora
        //    lee `class40_ingest`, que publica class9 desde su historial.
        //    Y de paso deja de leer la salida del propio sistema, o sea que el
        //    pronóstico ya no se alimenta de las decisiones que ayuda a tomar.
        //
        //  · SALIDA. `class40_output` YA tiene dos productores en producción
        //    (class45 como proxy de crisis y class44 con el LSTM). Un tercero
        //    los pisaría: el snapshot de crisis de class25A quedaría decidido
        //    por el orden de llegada. Sale por `class40_forecast`, que es suyo.
        private static readonly string MarketInputChannel =
            Environment.GetEnvironmentVariable("CLASS40_CH_IN")  ?? "class40_ingest";
        private static readonly string ForecastOutputChannel =
            Environment.GetEnvironmentVariable("CLASS40_CH_OUT") ?? "class40_forecast";

        // ── OPCIÓN A: Trigger de búsqueda activa hacia class1 ──────
        // Cuando la incertidumbre del pronóstico es alta (intervalo
        // de confianza muy ancho), class40 le pide a class1 que
        // busque contexto noticioso real sobre ese ticker/sector.
        //
        // NOTA PARA MIGRACIÓN FUTURA (18 meses, Opción C):
        // Esta lógica determinística (umbral fijo de incertidumbre)
        // debe reemplazarse por una decisión generada por el propio
        // modelo entrenado (class25A/B), sin depender de un umbral
        // hardcodeado ni de una API externa de lenguaje. Ver
        // documentación de migración en Mapa_de_MIIA.docx, sección
        // "Fase 3 — Investigación autónoma".
        private const string TriggerChannel = "class1_trigger";
        private const double UMBRAL_INCERTIDUMBRE = 0.08; // 8% del rango — ajustable

        // Limiter de concurrencia para evitar "tormenta" de procesamiento
        private static readonly SemaphoreSlim _limiter = new SemaphoreSlim(4);

        // =======================================================
        // 2. Constructor (NO conectar aquí)
        // =======================================================
        public HybridForecastProcessor()
        {
            _redisEndpoint = Environment.GetEnvironmentVariable("REDIS_URL") ?? "localhost:6379";

            var endpointParsed = _redisEndpoint.StartsWith("redis://", StringComparison.OrdinalIgnoreCase)
                ? _redisEndpoint["redis://".Length..]
                : _redisEndpoint;

            _redisConfigOptions = ConfigurationOptions.Parse(endpointParsed);
            _redisConfigOptions.AbortOnConnectFail = false;
            _redisConfigOptions.KeepAlive = 10;
        }

        // =======================================================
        // 2.1 ConnectRedisAsync — conectar con reintentos (async)
        // =======================================================
        private async Task ConnectRedisAsync()
        {
            if (_reconnecting) return;

            _reconnecting = true;

            while (true)
            {
                try
                {
                    // FIX: usar ConfigurationOptions real de StackExchange.Redis
                    var realOpts = new ConfigurationOptions {
                        AbortOnConnectFail = false,
                        ConnectTimeout = 5000,
                        SyncTimeout    = 5000,
                    };
                    // FIX CS1061: ConfigurationOptions.Endpoint no existe en StackExchange.Redis
                    // Usar la URL de Redis directamente desde variable de entorno
                    var redisHost40 = (Environment.GetEnvironmentVariable("REDIS_URL") 
                                      ?? "localhost:6379")
                                      .Replace("redis://", "")
                                      .Replace("rediss://", "");
                    realOpts.EndPoints.Add(redisHost40);
                    _redisConnection = await ConnectionMultiplexer.ConnectAsync(realOpts);
                    _redisDb = _redisConnection.GetDatabase();
                    _redisSub = _redisConnection.GetSubscriber();

                    _isRedisConnected = true;
                    Console.WriteLine("[class40] Redis (stub) inicializado");

                    _redisConnection.ConnectionFailed += (_, e) =>
                    {
                        try
                        {
                            Console.WriteLine("[class40] Redis FAIL (stub event)");
                            _isRedisConnected = false;
                            if (!_reconnecting)
                            {
                                Task.Run(async () =>
                                {
                                    await Task.Delay(1000);
                                    await ConnectRedisAsync();
                                });
                            }
                        }
                        catch { }
                    };

                    _redisConnection.ConnectionRestored += (_, e) =>
                    {
                        try
                        {
                            Console.WriteLine("[class40] Redis RESTORED (stub event)");
                            _isRedisConnected = true;
                        }
                        catch { }
                    };

                    break;
                }
                catch (Exception)
                {
                    Console.WriteLine("[class40] Redis no disponible (stub). Reintentando en 5s...");
                    await Task.Delay(5000);
                }
            }

            _reconnecting = false;
        }

        // =======================================================
        // 3. CargarConfiguracion — carga JSON / INI desde carpeta config
        // =======================================================
        public Dictionary<string, object> CargarConfiguracion()
        {
            try
            {
                string basePath = AppContext.BaseDirectory;
                string rootPath = Path.GetFullPath(Path.Combine(basePath, @"..\"));
                string configFolder = Path.Combine(rootPath, @"operador\aprendizaje\config");

                if (!Directory.Exists(configFolder))
                    throw new DirectoryNotFoundException($"Carpeta de configuración no encontrada: {configFolder}");

                var configuracion = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

                foreach (var archivo in Directory.GetFiles(configFolder, "*.json"))
                {
                    try
                    {
                        string contenido = File.ReadAllText(archivo);
                        var datos = JsonSerializer.Deserialize<Dictionary<string, object>>(contenido);
                        if (datos != null)
                        {
                            foreach (var kvp in datos)
                                configuracion[kvp.Key] = kvp.Value!;
                        }
                    }
                    catch { }
                }

                foreach (var archivo in Directory.GetFiles(configFolder, "*.ini"))
                {
                    try
                    {
                        foreach (var lineaRaw in File.ReadAllLines(archivo))
                        {
                            var linea = lineaRaw.Trim();
                            if (string.IsNullOrWhiteSpace(linea) || linea.StartsWith("#") || !linea.Contains("="))
                                continue;

                            var partes = linea.Split('=', 2);
                            var clave = partes[0].Trim();
                            var valor = partes[1].Trim();
                            configuracion[clave] = valor;
                        }
                    }
                    catch { }
                }

                return configuracion;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[HybridForecastProcessor] Error cargando configuración: {ex.Message}");
                return new Dictionary<string, object>();
            }
        }

        // =======================================================
        // 4. EjecutarAsync — bucle principal de suscripción y procesamiento
        // =======================================================
        public async Task EjecutarAsync(CancellationToken cancelToken)
        {
            await ConnectRedisAsync();

            if (_redisSub == null)
            {
                Console.WriteLine("[class40] ERROR: subscriber nulo después de conectar Redis");
                return;
            }

            // FIX: RedisChannel.Literal + handler tipo Action<RedisChannel,RedisValue>
            await _redisSub.SubscribeAsync(RedisChannel.Literal(MarketInputChannel),
                async (canal, msg) =>
            {
                await _limiter.WaitAsync();
                try
                {
                    try
                    {
                        string json = msg.ToString() ?? string.Empty;

                        var envelope = JsonSerializer.Deserialize<Class25Envelope>(
                            json,
                            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                        );

                        if (envelope == null)
                        {
                            Console.WriteLine("[class40] Envelope nulo");
                            return;
                        }

                        if (envelope.Data.ValueKind != JsonValueKind.Object)
                        {
                            Console.WriteLine("[class40] Data inválido");
                            return;
                        }

                        if (!string.Equals(envelope.Type, "forecast_input", StringComparison.OrdinalIgnoreCase))
                        {
                            return;
                        }

                        var entrada = envelope.Data.Deserialize<EntradaMercado>(
                            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
                        );

                        if (entrada == null)
                        {
                            Console.WriteLine("[class40] EntradaMercado nulo dentro de envelope");
                            return;
                        }

                        var puntosValidos = entrada.Series?
                            .Where(p => p != null && p.Close >= 0 && !string.IsNullOrWhiteSpace(p.Timestamp))
                            .OrderBy(p =>
                            {
                                if (DateTime.TryParse(p.Timestamp, null, DateTimeStyles.AdjustToUniversal, out var dt))
                                    return dt;
                                return DateTime.MinValue;
                            })
                            .ToList() ?? new List<PuntoMercado>();

                        if (puntosValidos.Count == 0)
                        {
                            Console.WriteLine("HybridForecastProcessor WARNING: series vacía");
                            return;
                        }

                        double[] valores = puntosValidos.Select(p => p.Close).ToArray();

                        double minVal = valores.Min();
                        double maxVal = valores.Max();
                        double rango = maxVal - minVal;
                        if (Math.Abs(rango) < 1e-12) rango = 1.0;

                        double[] normalizados = valores.Select(v => (v - minVal) / rango).ToArray();

                        int horizonte = Math.Max(1, entrada.HorizonDays);

                        double[] arimaPred = null!;
                        double[] ssaPred = null!;
                        double[] fourierPred = null!;
                        double[] lstmPred = null!;

                        try { arimaPred = PredecirArima(normalizados, horizonte); } catch { arimaPred = Array.Empty<double>(); }
                        try { ssaPred = PredecirSsa(normalizados, horizonte); } catch { ssaPred = Array.Empty<double>(); }
                        try { fourierPred = PredecirFourier(normalizados, horizonte); } catch { fourierPred = Array.Empty<double>(); }
                        try { lstmPred = PredecirLstm(normalizados, horizonte); } catch { lstmPred = Array.Empty<double>(); }

                        double[] ensamblado = CombinarModelos(arimaPred, ssaPred, fourierPred, lstmPred);
                        if (ensamblado.Length == 0)
                            ensamblado = Enumerable.Repeat(normalizados.LastOrDefault(), horizonte).ToArray();

                        double[] arimaDesnorm = arimaPred?.Select(v => v * rango + minVal).ToArray() ?? Array.Empty<double>();
                        double[] ssaDesnorm = ssaPred?.Select(v => v * rango + minVal).ToArray() ?? Array.Empty<double>();
                        double[] fourierDesnorm = fourierPred?.Select(v => v * rango + minVal).ToArray() ?? Array.Empty<double>();
                        double[] lstmDesnorm = lstmPred?.Select(v => v * rango + minVal).ToArray() ?? Array.Empty<double>();
                        double[] ensambladoDesnorm = ensamblado.Select(v => v * rango + minVal).ToArray();

                        var residuos = new List<double>();
                        for (int i = 0; i < ensamblado.Length; i++)
                        {
                            var preds = new List<double>();
                            if (arimaPred != null && i < arimaPred.Length) preds.Add(arimaPred[i]);
                            if (ssaPred != null && i < ssaPred.Length) preds.Add(ssaPred[i]);
                            if (fourierPred != null && i < fourierPred.Length) preds.Add(fourierPred[i]);
                            if (lstmPred != null && i < lstmPred.Length) preds.Add(lstmPred[i]);

                            double avg = preds.Count > 0 ? preds.Average() : ensamblado[i];
                            residuos.Add(ensamblado[i] - avg);
                        }

                        double sigma = CalcularDesviacionEstandar(residuos) * rango;

                        var salida = new PronosticoMercado
                        {
                            Ticker = entrada.Ticker ?? string.Empty,
                            Sector = entrada.Sector ?? string.Empty,
                            HorizonDays = horizonte,
                            GeneratedAt = DateTime.UtcNow.ToString("o"),
                            ModelOutputs = new SalidasModelos
                            {
                                Arima = arimaDesnorm,
                                Ssa = ssaDesnorm,
                                Fourier = fourierDesnorm,
                                Lstm = lstmDesnorm
                            },
                            Ensemble = new EnsambladoPronostico
                            {
                                Predictions = new List<PuntoPrediccion>()
                            }
                        };

                        for (int dia = 1; dia <= horizonte; dia++)
                        {
                            double val = ensambladoDesnorm[Math.Min(dia - 1, ensambladoDesnorm.Length - 1)];
                            salida.Ensemble.Predictions.Add(new PuntoPrediccion
                            {
                                DayOffset = dia,
                                Value = val,
                                Lower = val - 1.96 * sigma,
                                Upper = val + 1.96 * sigma
                            });
                        }

                        string jsonSalida = JsonSerializer.Serialize(salida);

                        if (_redisSub != null)
                        {
                            await _redisSub.PublishAsync(RedisChannel.Literal(ForecastOutputChannel), jsonSalida);
                        }

                        Console.WriteLine($"HybridForecastProcessor OK {DateTime.UtcNow:o}");

                        // ── OPCIÓN A: disparar búsqueda activa si la incertidumbre es alta ──
                        // El ancho del intervalo de confianza (Upper-Lower) promedio,
                        // relativo al rango de precios, mide cuán incierto está el
                        // pronóstico. Si supera UMBRAL_INCERTIDUMBRE, le pedimos a
                        // class1 que investigue noticias reales sobre ese ticker/sector
                        // para que el resto del pipeline tenga contexto cualitativo
                        // además del numérico.
                        try
                        {
                            double anchoPromedio = salida.Ensemble.Predictions.Count > 0
                                ? salida.Ensemble.Predictions.Average(p => p.Upper - p.Lower)
                                : 0.0;
                            double anchoRelativo = rango > 1e-9 ? anchoPromedio / rango : 0.0;

                            if (anchoRelativo > UMBRAL_INCERTIDUMBRE && _redisSub != null)
                            {
                                var triggerPayload = new
                                {
                                    origen   = "class40",
                                    motivo   = "incertidumbre_alta",
                                    ticker   = salida.Ticker,
                                    sector   = salida.Sector,
                                    ancho_relativo = Math.Round(anchoRelativo, 4),
                                    umbral   = UMBRAL_INCERTIDUMBRE,
                                    queries  = new[]
                                    {
                                        $"{salida.Ticker} noticias hoy",
                                        $"{salida.Sector} mercado análisis"
                                    },
                                    ts = DateTime.UtcNow.ToString("o")
                                };
                                string triggerJson = JsonSerializer.Serialize(triggerPayload);
                                await _redisSub.PublishAsync(RedisChannel.Literal(TriggerChannel), triggerJson);

                                Console.WriteLine(
                                    $"[class40] 🔎 Trigger de búsqueda enviado a class1 → " +
                                    $"ticker={salida.Ticker} sector={salida.Sector} " +
                                    $"ancho_relativo={anchoRelativo:P1} (umbral={UMBRAL_INCERTIDUMBRE:P0})");
                            }
                        }
                        catch (Exception triggerEx)
                        {
                            // El trigger es una mejora, no algo crítico — nunca debe
                            // tumbar el flujo principal de publicación del pronóstico.
                            Console.WriteLine($"[class40] WARNING: trigger de búsqueda falló: {triggerEx.Message}");
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"HybridForecastProcessor ERROR: {ex.Message}");
                    }
                }
                finally
                {
                    _limiter.Release();
                }
            });

            while (!cancelToken.IsCancellationRequested)
            {
                try
                {
                    if (!_isRedisConnected && !_reconnecting)
                    {
                        await ConnectRedisAsync();
                    }

                    await Task.Delay(1000, cancelToken);
                }
                catch (TaskCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"HybridForecastProcessor LOOP ERROR: {ex.Message}");
                    await Task.Delay(1000);
                }
            }
        }

        // =======================================================
        // 5. Utilidades estadísticas
        // =======================================================
        private double CalcularDesviacionEstandar(List<double> valores)
        {
            if (valores == null || valores.Count == 0) return 0.0;
            double media = valores.Average();
            double sumaCuadrados = valores.Sum(v => (v - media) * (v - media));
            return Math.Sqrt(sumaCuadrados / valores.Count);
        }

        // =======================================================
        // 6. Modelos predictivos (stubs seguros)
        // =======================================================
        private double[] PredecirArima(double[] serie, int horizonte)
        {
            if (serie.Length < 3)
                return Enumerable.Repeat(serie.LastOrDefault(), horizonte).ToArray();

            double ultimo = serie.Length > 0 ? serie[^1] : 0.0;
            return Enumerable.Repeat(ultimo, horizonte).ToArray();
        }

        private double[] PredecirSsa(double[] serie, int horizonte)
        {
            if (serie.Length < 3)
                return Enumerable.Repeat(serie.LastOrDefault(), horizonte).ToArray();

            double ultimo = serie.Length > 0 ? serie[^1] : 0.0;
            return Enumerable.Repeat(ultimo, horizonte).ToArray();
        }

        private double[] PredecirFourier(double[] serie, int horizonte)
        {
            int n = serie.Length;
            if (n == 0) return Enumerable.Repeat(0.0, horizonte).ToArray();
            if (n < 3)
                return Enumerable.Repeat(serie.LastOrDefault(), horizonte).ToArray();

            int window = Math.Min(5, n);
            var tail = serie.Skip(Math.Max(0, n - window)).ToArray();
            double promedio = tail.Average();
            return Enumerable.Repeat(promedio, horizonte).ToArray();
        }

        private double[] PredecirLstm(double[] serie, int horizonte)
        {
            if (serie.Length < 3)
                return Enumerable.Repeat(serie.LastOrDefault(), horizonte).ToArray();

            double ultimo = serie.Length > 0 ? serie[^1] : 0.0;
            return Enumerable.Repeat(ultimo, horizonte).ToArray();
        }

        // =======================================================
        // 7. Ensamble y combinación de modelos
        // =======================================================
        private double[] CombinarModelos(
            double[]? arima,
            double[]? ssa,
            double[]? fourier,
            double[]? lstm)
        {
            var modelos = new List<(double[]? preds, double peso)>
            {
                (arima, 0.30),
                (ssa, 0.30),
                (fourier, 0.20),
                (lstm, 0.20)
            };

            var validos = modelos.Where(m => m.preds is not null && m.preds.Length > 0).ToList();
            if (validos.Count == 0) return Array.Empty<double>();

            double totalPeso = validos.Sum(v => v.peso);
            var pesosNorm = validos.Select(v => v.peso / totalPeso).ToArray();

            int longitud = validos.Max(v => v.preds!.Length);
            var resultado = new double[longitud];

            for (int i = 0; i < longitud; i++)
            {
                double acumulado = 0.0;
                for (int m = 0; m < validos.Count; m++)
                {
                    var p = validos[m].preds!;
                    if (i < p.Length) acumulado += p[i] * pesosNorm[m];
                }
                resultado[i] = acumulado;
            }

            return resultado;
        }

        // =======================================================
        // 8. DTOs de entrada / salida (sin warnings de nullabilidad)
        // =======================================================
        private sealed class Class25Envelope
        {
            [JsonPropertyName("id")]
            public string Id { get; set; } = string.Empty;

            [JsonPropertyName("source")]
            public string Source { get; set; } = string.Empty;

            [JsonPropertyName("type")]
            public string Type { get; set; } = string.Empty;

            [JsonPropertyName("text")]
            public string Text { get; set; } = string.Empty;

            [JsonPropertyName("data")]
            public JsonElement Data { get; set; }

            [JsonPropertyName("ts")]
            public string Ts { get; set; } = string.Empty;
        }

        private sealed class EntradaMercado
        {
            [JsonPropertyName("ticker")]
            public string Ticker { get; set; } = string.Empty;

            [JsonPropertyName("sector")]
            public string Sector { get; set; } = string.Empty;

            [JsonPropertyName("horizonDays")]
            public int HorizonDays { get; set; }

            [JsonPropertyName("series")]
            public List<PuntoMercado> Series { get; set; } = new();
        }

        private sealed class PuntoMercado
        {
            [JsonPropertyName("ts")]
            public string Timestamp { get; set; } = string.Empty;

            [JsonPropertyName("close")]
            public double Close { get; set; }
        }

        private sealed class PronosticoMercado
        {
            [JsonPropertyName("ticker")]
            public string Ticker { get; set; } = string.Empty;

            [JsonPropertyName("sector")]
            public string Sector { get; set; } = string.Empty;

            [JsonPropertyName("horizonDays")]
            public int HorizonDays { get; set; }

            [JsonPropertyName("generatedAt")]
            public string GeneratedAt { get; set; } = string.Empty;

            [JsonPropertyName("models")]
            public SalidasModelos ModelOutputs { get; set; } = new();

            [JsonPropertyName("ensemble")]
            public EnsambladoPronostico Ensemble { get; set; } = new();
        }

        private sealed class SalidasModelos
        {
            [JsonPropertyName("arima")]
            public double[] Arima { get; set; } = Array.Empty<double>();

            [JsonPropertyName("ssa")]
            public double[] Ssa { get; set; } = Array.Empty<double>();

            [JsonPropertyName("fourier")]
            public double[] Fourier { get; set; } = Array.Empty<double>();

            [JsonPropertyName("lstm")]
            public double[] Lstm { get; set; } = Array.Empty<double>();
        }

        private sealed class EnsambladoPronostico
        {
            [JsonPropertyName("predictions")]
            public List<PuntoPrediccion> Predictions { get; set; } = new();
        }

        private sealed class PuntoPrediccion
        {
            [JsonPropertyName("dayOffset")]
            public int DayOffset { get; set; }

            [JsonPropertyName("value")]
            public double Value { get; set; }

            [JsonPropertyName("lower")]
            public double Lower { get; set; }

            [JsonPropertyName("upper")]
            public double Upper { get; set; }
        }

        // =======================================================
        // 9. IDisposable — cierre seguro de recursos
        // =======================================================
        public void Dispose()
        {
            try
            {
                _redisConnection?.Dispose();
            }
            catch
            {
                // evitar excepciones en cierre
            }
        }

        // =======================================================
        // 10. Protección global (llamar desde entrypoint)
        // =======================================================
        public static void RegisterGlobalExceptionHandlers()
        {
            try
            {
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                {
                    try
                    {
                        Console.WriteLine("[class40] UnhandledException: " + (e.ExceptionObject as Exception)?.Message);
                    }
                    catch { }
                };

                TaskScheduler.UnobservedTaskException += (s, e) =>
                {
                    try
                    {
                        Console.WriteLine("[class40] UnobservedTaskException: " + e.Exception?.Message);
                        e.SetObserved();
                    }
                    catch { }
                };
            }
            catch { }
        }
    }
}

// ==========================================================
// 🧠 DIAGNÓSTICO ROBUSTO DE PROBABILIDADES — TERMINAL
// ==========================================================
public static class DiagnosticoProbabilidades
{
    public static void Imprimir(
        string origen,
        IDictionary<string, double>? probabilidades,
        string estado = "desconocido"
    )
    {
        try
        {
            Console.WriteLine("");
            Console.WriteLine("────────────────────────────────────────────");
            Console.WriteLine("🧠 DIAGNÓSTICO DE PROBABILIDADES");
            Console.WriteLine($"• Origen : {origen}");
            Console.WriteLine($"• Estado : {estado}");
            Console.WriteLine($"• TS     : {DateTime.UtcNow:o}");
            Console.WriteLine("────────────────────────────────────────────");

            if (probabilidades == null || probabilidades.Count == 0)
            {
                Console.WriteLine("⚠️  No hay probabilidades disponibles.");
                Console.WriteLine("────────────────────────────────────────────");
                return;
            }

            double suma = 0;
            int validas = 0;

            foreach (var kv in probabilidades)
            {
                if (double.IsNaN(kv.Value) || double.IsInfinity(kv.Value))
                {
                    Console.WriteLine($"❌ {kv.Key,-20} → valor inválido");
                    continue;
                }

                var p = Math.Max(0, Math.Min(1, kv.Value));
                suma += p;
                validas++;

                Console.WriteLine(
                    $"• {kv.Key,-20} → {(p * 100):F2}% {Barra(p)}"
                );
            }

            Console.WriteLine("────────────────────────────────────────────");

            if (validas > 0)
            {
                Console.WriteLine($"Σ Suma normalizada : {(suma * 100):F02}%");

                if (suma < 0.9)
                    Console.WriteLine("⚠️  Advertencia: baja confianza global.");
                else if (suma > 1.1)
                    Console.WriteLine("⚠️  Advertencia: sobreconfianza detectada.");
                else
                    Console.WriteLine("✅ Distribución dentro de rango esperado.");
            }
            else
            {
                Console.WriteLine("❌ No se encontraron probabilidades válidas.");
            }

            Console.WriteLine("────────────────────────────────────────────");
        }
        catch (Exception ex)
        {
            try
            {
                Console.WriteLine("❌ Error en Diagnóstico de Probabilidades");
                Console.WriteLine(ex.Message);
            }
            catch { }
        }
    }

    private static string Barra(double p)
    {
        try
        {
            int blocks = (int)Math.Round(p * 20);
            blocks = Math.Max(0, Math.Min(20, blocks));
            return "[" + new string('█', blocks) + new string('░', 20 - blocks) + "]";
        }
        catch
        {
            return "[????????????????????]";
        }
    }
}

// ==========================================================
// Program entrypoint — agrega un Main para resolver CS5001
// ==========================================================
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (s, e) =>
        {
            e.Cancel = true;
            Console.WriteLine("[class40] Cancel requested, shutting down...");
            cts.Cancel();
        };

        try
        {
            MIIA.Motores.HybridForecastProcessor.RegisterGlobalExceptionHandlers();

            using var processor = new MIIA.Motores.HybridForecastProcessor();

            Console.WriteLine("[class40] Starting processor...");
            await processor.EjecutarAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine("[class40] Execution cancelled.");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[class40] Fatal error: " + ex.Message);
            return 1;
        }

        Console.WriteLine("[class40] Exiting normally.");
        return 0;
    }
}