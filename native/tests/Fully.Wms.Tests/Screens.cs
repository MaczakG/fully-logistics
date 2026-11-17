using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Threading;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms.Tests;

// Opens the real main view in a headless window, signed in to the live test server, and saves
// screenshots when FL_SCREENSHOTS names a folder (to look at the screens without a display).
public static class Screens
{
    public static readonly string? Folder = Environment.GetEnvironmentVariable("FL_SCREENSHOTS");

    public static ShellViewModel NewShell(bool phone = false)
    {
        var folder = Path.Combine(TestApp.SettingsFolder, Guid.NewGuid().ToString("N"));
        var platform = new TestPlatform(folder, phone);
        var services = new AppServices(new Fully.Wms.Core.SettingsStore(folder), platform);
        if (LiveServer.Url is { } url) services.UseServer(url);
        return new ShellViewModel(services);
    }

    public static Window Open(ShellViewModel shell, double width, double height)
    {
        var window = new Window { Width = width, Height = height, Content = new MainView { DataContext = shell } };
        window.Show();
        Settle();
        return window;
    }

    public static async Task SignInAsync(ShellViewModel shell, string email)
    {
        await shell.StartAsync();
        var login = Assert.IsType<LoginViewModel>(shell.Current);
        login.Email = email;
        login.Password = LiveServer.Password;
        await login.LoginCommand.ExecuteAsync(null);
        Assert.True(shell.IsSignedIn, login.Error);
    }

    // Lets layout, bindings and pending UI work finish.
    public static void Settle()
    {
        for (var i = 0; i < 5; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
    }

    public static void Save(Window window, string name)
    {
        Settle();
        if (string.IsNullOrEmpty(Folder)) return;
        Directory.CreateDirectory(Folder);
        window.CaptureRenderedFrame()?.Save(Path.Combine(Folder, name + ".png"));
    }
}
