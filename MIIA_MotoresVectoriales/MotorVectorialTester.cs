// ============================================================
// MotorVectorialTester.cs — Test en Caliente de Motores C# (MIIA v2.0)
// ============================================================
// Ejecuta UNA sola pasada de test (no es un microservicio persistente).
// Inyecta mensajes en los canales de entrada de cada motor C# via
// Redis pub/sub y verifica que responden en sus canales de salida.
//
// Canales testeados:
//   class3  : class3_ingest         → class19_ingest
//   class10 : class10_ingest        → class19_ingest
//   class18 : class18_ingest        → class19_ingest
//   class35 : class25_output        → class35_output
//   class40 : class25_output        → class40_output
//   class41 : class25_output        → class41_output
//
// Correcciones respecto a la versión anterior:
//   - NO es un loop persistente (era: while(!cancelled))
//   - Canales corregidos (era: "class03_ingest", "class3_vectorial", etc.)
//   - Usa pub/sub Subscribe (era: Redis GET/SET polling por reflección)
//   - Timeout por canal con TaskCompletionSource
//   - Reporte JSON con pass/fail por motor
//   - Salida limpia tras el test
// ============================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StackExchange.Redis;

namespace MIIA_MotoresVectoriales
{
    public class MotorVectorialTester
    {
        // ── Rutas ────────────────────────────────────────────────────
        private static readonly string RootDir   = ResolveRoot();
        private static readonly string BaseDir   = Path.Combine(RootDir, "operador", "aprendizaje");
        private static readonly string ReportsDir = Path.Combine(BaseDir, "reports");
        private static readonly string LogsDir   = Path.Combine(BaseDir, "logs");
        private static readonly string LogFile   = Path.Combine(LogsDir, "MotorVectorialTester.log");

        private static string ResolveRoot()
        {
            try { return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..")); }
            catch { return Path.GetFullPath(AppContext.BaseDirectory); }
        }

        // ── Logger ───────────────────────────────────────────────────
        private static void Log(string msg, string nivel = "info")
        {
            string line = $"[{DateTime.Now:yyyy-MM-ddTHH:mm:ss}] [MVT/{nivel.ToUpper()}] {msg}";
            var color = nivel switch {
                "ok"    => ConsoleColor.Green,
                "warn"  => ConsoleColor.Yellow,
                "error" => ConsoleColor.Red,
                _       => ConsoleColor.Cyan,
            };
            Console.ForegroundColor = color;
            Console.WriteLine(line);
            Console.ResetColor();
            try { Directory.CreateDirectory(LogsDir); File.AppendAllText(LogFile, line + Environment.NewLine); }
            catch { }
        }

        // ── Definición de un test por motor ──────────────────────────
        private record MotorTest(
            string Motor,
            string Descripcion,
            string CanalEntrada,
            string CanalSalida,
            string PayloadJson
        );

        // ── Payload de test ──────────────────────────────────────────
        private static string MkVector() => JsonSerializer.Serialize(new {
            type       = "vector",
            source     = "MotorVectorialTester",
            vector     = new double[] { 0.72, -0.15, 0.44, 0.81, -0.32, 0.58, 0.10, -0.67 },
            confianza  = 0.75,
            coherencia = 0.70,
            dimension  = 8,
            ts         = DateTime.UtcNow.ToString("o"),
        });

        private static string MkDecision() => JsonSerializer.Serialize(new {
            type      = "analysis",
            source    = "MotorVectorialTester",
            texto     = "Test integral C# — MotorVectorialTester",
            decision  = "BUY",
            ticker    = "XLK",
            confianza = 0.72,
            score     = 0.72,
            ts        = DateTime.UtcNow.ToString("o"),
        });

        // ── Esperar un mensaje en un canal con timeout ───────────────
        private static async Task<(bool ok, string? msg)> WaitForMessage(
            ISubscriber sub, string canal, int timeoutMs, CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

            await sub.SubscribeAsync(RedisChannel.Literal(canal), (_, val) =>
            {
                if (!tcs.Task.IsCompleted)
                    tcs.TrySetResult(val.ToString());
            });

            using var timer = new CancellationTokenSource(timeoutMs);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timer.Token);

            try
            {
                var msg = await tcs.Task.WaitAsync(linked.Token);
                await sub.UnsubscribeAsync(RedisChannel.Literal(canal));
                return (true, msg);
            }
            catch (OperationCanceledException)
            {
                await sub.UnsubscribeAsync(RedisChannel.Literal(canal));
                return (false, null);
            }
        }

        // ── Punto de entrada ─────────────────────────────────────────
        public static async Task RunTestAsync(CancellationToken ct = default)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Directory.CreateDirectory(ReportsDir);

            Log("═══════════════════════════════════════════");
            Log("🔥 MotorVectorialTester — Test en Caliente");
            Log($"   Root: {RootDir}");
            Log("═══════════════════════════════════════════");

            // ── Conectar Redis ──────────────────────────────────────
            ConnectionMultiplexer? mux = null;
            var results = new List<object>();
            var t0 = Stopwatch.StartNew();

            try
            {
                mux = await ConnectionMultiplexer.ConnectAsync(new ConfigurationOptions {
                    EndPoints = { "localhost:6379" },
                    AbortOnConnectFail = false,
                    ConnectTimeout = 5000,
                });
                if (!mux.IsConnected) throw new Exception("No conectado");
                Log("✅ Redis conectado", "ok");
                results.Add(new { test = "redis", ok = true });
            }
            catch (Exception ex)
            {
                Log($"❌ Redis: {ex.Message}", "error");
                results.Add(new { test = "redis", ok = false, error = ex.Message });
                await GuardarReporte(results, t0); return;
            }

            var pub = mux.GetSubscriber();
            var db  = mux.GetDatabase();

            // ── Definir tests ───────────────────────────────────────
            var tests = new List<MotorTest>
            {
                new("class3",  "DSL Adaptador de Crisis",        "class3_ingest",  "class19_ingest", MkVector()),
                new("class10", "Motor Vectorial Principal",       "class10_ingest", "class19_ingest", MkVector()),
                new("class18", "Motor Vectorial de Portfolio",    "class18_ingest", "class19_ingest", MkVector()),
                new("class35", "Monitor de Coherencia",          "class25_output", "class35_output", MkDecision()),
                new("class40", "Motor Predictivo Híbrido (C#)",  "class25_output", "class40_output", MkDecision()),
                new("class41", "Motor de Riesgo y Probabilidad", "class25_output", "class41_output", MkDecision()),
            };

            // ── Ejecutar cada test ──────────────────────────────────
            int idx = 0;
            foreach (var t in tests)
            {
                idx++;
                Log($"\n▶ [{idx}/{tests.Count}] {t.Motor} — {t.Descripcion}");
                Log($"   {t.CanalEntrada} → {t.CanalSalida}");

                // Crear subscriber fresco por test para evitar colisiones
                var subForTest = mux.GetSubscriber();
                var tSw = Stopwatch.StartNew();

                // 1. Suscribir PRIMERO al canal de salida
                var waiter = WaitForMessage(subForTest, t.CanalSalida, 7_000, ct);

                // 2. Pequeño delay para que la suscripción esté activa
                await Task.Delay(150, ct);

                // 3. Publicar en el canal de entrada
                try
                {
                    await pub.PublishAsync(RedisChannel.Literal(t.CanalEntrada), t.PayloadJson);
                    Log($"   → Publicado en {t.CanalEntrada}");
                }
                catch (Exception ex)
                {
                    Log($"   ❌ Error publicando: {ex.Message}", "error");
                }

                // 4. Esperar respuesta
                var (ok, respuesta) = await waiter;
                tSw.Stop();

                string resumen = ok
                    ? respuesta?.Length > 0 ? respuesta[..Math.Min(80, respuesta.Length)] + "…" : "OK"
                    : "timeout";

                Log(ok
                    ? $"   ✅ {t.Motor} respondió en {tSw.ElapsedMilliseconds}ms"
                    : $"   ⚠️  {t.Motor} sin respuesta en 7s (¿está corriendo el .NET?)",
                    ok ? "ok" : "warn");

                results.Add(new {
                    test       = $"{t.Motor}→{t.CanalSalida}",
                    motor      = t.Motor,
                    ok,
                    latencia_ms = tSw.ElapsedMilliseconds,
                    resumen,
                });
            }

            mux.Dispose();
            await GuardarReporte(results, t0);
        }

        // ── Reporte ──────────────────────────────────────────────────
        private static async Task GuardarReporte(List<object> results, Stopwatch t0)
        {
            int ok    = 0;
            int total = results.Count;
            foreach (var r in results)
            {
                var json = JsonSerializer.Serialize(r);
                if (json.Contains("\"ok\":true")) ok++;
            }

            Log("\n═══════════════════════════════════════════");
            Log($"📋 RESULTADO: {ok}/{total} OK  |  {t0.ElapsedMilliseconds}ms total");
            foreach (var r in results)
            {
                var j = JsonSerializer.Serialize(r);
                bool passed = j.Contains("\"ok\":true");
                Log($"  {(passed ? "✅" : "⚠️ ")} {j}");
            }
            Log("═══════════════════════════════════════════");

            var reporte = new {
                ts          = DateTime.UtcNow.ToString("o"),
                duracion_ms = t0.ElapsedMilliseconds,
                grupo       = "MIIA_MotoresVectoriales (C#)",
                ok,
                total,
                resultados  = results,
            };

            string file = Path.Combine(
                Path.Combine(ResolveRoot(), "operador", "aprendizaje", "reports"),
                "MotorVectorialTester_report.json");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                await File.WriteAllTextAsync(file,
                    JsonSerializer.Serialize(reporte, new JsonSerializerOptions { WriteIndented = true }));
                Log($"📊 Reporte: {file}", "ok");
            }
            catch (Exception ex) { Log($"⚠️  No se pudo guardar reporte: {ex.Message}", "warn"); }
        }

        // ── Compatibilidad con Program.cs que llama a .Main() ────────
        // El Program.cs corre este tester cuando se invoca con --test
        public static async Task Main(string[] args)
        {
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
            await RunTestAsync(cts.Token);
        }
    }
}
