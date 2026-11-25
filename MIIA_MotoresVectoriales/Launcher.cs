using System;
using System.Threading.Tasks;

public class Launcher
{
    public static async Task Main(string[] args)
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("🚀 Iniciando MIIA — Motores Vectoriales (class3, class10, class18, class40, class41)");
        Console.ResetColor();

        using var cts = new System.Threading.CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            Console.WriteLine("🛑 Cancelación solicitada...");
            cts.Cancel();
        };

        // FIX: agregar class40 (Motor Predictivo Híbrido) y class41 (Motor de Riesgo)
        // Antes no estaban aquí → nunca arrancaban → no generaban escenarios de crisis
        var tareas = new Task[]
        {
            EjecutarClass3(args),
            EjecutarClass10(args),
            EjecutarClass18(args),
            EjecutarClass40(args),
            EjecutarClass41(args)
        };

        await Task.WhenAll(tareas);
        Console.WriteLine("✅ Todos los motores detenidos.");
    }

    private static async Task EjecutarClass3(string[] args)
    {
        try
        {
            // class3.cs expone ProgramAdaptado.Main()
            await ProgramAdaptado.Main(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Launcher] ❌ Error en class3: {ex.Message}");
        }
    }

    private static async Task EjecutarClass10(string[] args)
    {
        try
        {
            // class10.cs expone MotorVectorialTester.Main() → Program10.RunAsync()
            await Program10.RunAsync(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Launcher] ❌ Error en class10: {ex.Message}");
        }
    }

    private static async Task EjecutarClass18(string[] args)
    {
        try
        {
            // class18.cs expone ProgramVectorial.Main()
            await MIIA.VectorialEngine.ProgramVectorial.Main(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Launcher] ❌ Error en class18: {ex.Message}");
        }
    }

    private static async Task EjecutarClass40(string[] args)
    {
        try
        {
            // class40.cs: Motor Predictivo Híbrido
            // Suscribe a class25_output y genera pronósticos (class40_output)
            await Program.Main(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Launcher] ❌ Error en class40: {ex.Message}");
        }
    }

    private static async Task EjecutarClass41(string[] args)
    {
        try
        {
            // class41.cs: Motor de Riesgo y Probabilidad
            // Suscribe a class25_output y genera análisis de riesgo (class41_output)
            await Program41.Main(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Launcher] ❌ Error en class41: {ex.Message}");
        }
    }
}