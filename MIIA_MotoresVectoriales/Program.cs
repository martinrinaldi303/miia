using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace MIIA_MotoresVectoriales
{
    public class Program
    {
        public static async Task Main(string[] args)
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.WriteLine("🧠 MIIA — Class services iniciando como microservicio (sin dependencias externas)...\n");

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                Console.WriteLine("🛑 Cancelación solicitada. Deteniendo servicios...");
                cts.Cancel();
            };

            var services = new List<ClassBaseService>
            {
                new Class3Service(),
                new Class10Service(),
                new Class18Service(),
                new Class35Service(),
                new Class40Service(),
                new Class41Service()
            };

            var tasks = new List<Task>();
            foreach (var svc in services)
            {
                tasks.Add(Task.Run(() => svc.RunAsync(cts.Token), CancellationToken.None));
            }

            await Task.WhenAll(tasks);
            Console.WriteLine("✅ Todos los servicios detenidos. Saliendo.");
        }
    }

    public abstract class ClassBaseService
    {
        protected readonly string ClassName;

        protected ClassBaseService(string name)
        {
            ClassName = name;
        }

        public async Task RunAsync(CancellationToken stoppingToken)
        {
            Console.WriteLine($"🚀 {ClassName} iniciado.");

            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ProcessAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"❌ Error en {ClassName}: {ex.Message}");
                }

                try
                {
                    await Task.Delay(500, stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }

            Console.WriteLine($"🛑 {ClassName} detenido.");
        }

        protected abstract Task ProcessAsync(CancellationToken token);
    }

    public class Class3Service : ClassBaseService
    {
        public Class3Service() : base("Class 3") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }

    public class Class10Service : ClassBaseService
    {
        public Class10Service() : base("Class 10") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }

    public class Class18Service : ClassBaseService
    {
        public Class18Service() : base("Class 18") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }

    public class Class35Service : ClassBaseService
    {
        public Class35Service() : base("Class 35") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }

    public class Class40Service : ClassBaseService
    {
        public Class40Service() : base("Class 40") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }

    public class Class41Service : ClassBaseService
    {
        public Class41Service() : base("Class 41") { }

        protected override async Task ProcessAsync(CancellationToken token)
        {
            await Task.CompletedTask;
        }
    }
}