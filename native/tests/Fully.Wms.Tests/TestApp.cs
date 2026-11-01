using Avalonia;
using Avalonia.Headless;
using Fully.Wms.Services;

[assembly: AvaloniaTestApplication(typeof(Fully.Wms.Tests.TestApp))]

namespace Fully.Wms.Tests;

// The real App (styles, templates, icons) on Avalonia's headless platform with Skia drawing, so a
// test can render a screen and save it as PNG.
public static class TestApp
{
    public static readonly string SettingsFolder = Path.Combine(Path.GetTempPath(), "fully-wms-tests", Guid.NewGuid().ToString("N"));

    public static AppBuilder BuildAvaloniaApp()
    {
        App.Platform = new TestPlatform(SettingsFolder);
        return AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false })
            .WithInterFont();
    }
}

public sealed class TestPlatform(string folder, bool phone = false) : DefaultPlatformServices
{
    public override bool IsPhone => phone;
    public override string? SettingsFolder => folder;

    // The documents a test opened (reports, labels, exports), kept instead of launching a program.
    public List<Core.DownloadedFile> Opened { get; } = [];

    public override Task OpenFileAsync(Core.DownloadedFile file)
    {
        Opened.Add(file);
        return Task.CompletedTask;
    }
}
