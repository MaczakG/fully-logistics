using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Media;
using Fully.Wms.Core;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms;

public partial class App : Application
{
    // Set by the platform project before the app starts (desktop: Program, iOS: AppDelegate).
    public static IPlatformServices Platform { get; set; } = new DefaultPlatformServices();

    // The server's lookups (status labels ...) for converters and controls; set at sign-in.
    public static Fully.Wms.Core.Models.MetaInfo Meta { get; set; } = Fully.Wms.Core.Models.MetaInfo.Empty;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
        Controls.RowOpen.Register();
    }

    public override void OnFrameworkInitializationCompleted()
    {
        // Without a lifetime (tests, the XAML previewer) nothing starts by itself.
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var shell = CreateShell();
            var window = new MainWindow(shell.Services) { DataContext = shell };
            desktop.MainWindow = window;
            // Records in their own windows, forms in modal dialogs (like a Windows application).
            shell.Presenter = new WindowPresenter(shell, window);
            desktop.ShutdownRequested += (_, _) => shell.Services.SaveSettings();
            _ = shell.StartAsync();
        }
        else if (ApplicationLifetime is ISingleViewApplicationLifetime single)
        {
            var shell = CreateShell();
            single.MainView = new MainView { DataContext = shell };
            _ = shell.StartAsync();
        }
        base.OnFrameworkInitializationCompleted();
    }

    public static ShellViewModel CreateShell()
    {
        var services = new AppServices(new SettingsStore(Platform.SettingsFolder), Platform);
        ApplyTheme(services.Settings.Theme);
        return new ShellViewModel(services);
    }

    public static void ApplyTheme(string? theme)
    {
        if (Current is null) return;
        Current.RequestedThemeVariant = theme switch
        {
            "Light" => Avalonia.Styling.ThemeVariant.Light,
            "Dark" => Avalonia.Styling.ThemeVariant.Dark,
            _ => Avalonia.Styling.ThemeVariant.Default,
        };
    }

    // An icon geometry from Styles/Icons.axaml by key (IconInbound, IconStock, ...).
    public static Geometry? Icon(string key) =>
        Current is not null && Current.TryGetResource(key, Current.ActualThemeVariant, out var value) ? value as Geometry : null;
}
