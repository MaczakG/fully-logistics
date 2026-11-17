using Avalonia;

namespace Fully.Wms.Desktop;

sealed class Program
{
    // Nothing that needs Avalonia may run before StartWithClassicDesktopLifetime.
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    // Also used by the XAML previewer of Visual Studio and Rider.
    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
