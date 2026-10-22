using System.Text.Json;

namespace Fully.Wms.Core;

// What the app remembers on this device, in one small JSON file of the user's application data
// folder (Windows: %APPDATA%\FullyWms, macOS: ~/Library/Application Support/FullyWms, iOS: the
// app's own Library folder, set by the iOS app).
public sealed class AppSettings
{
    public const string DefaultServer = "https://18-185-119-189.sslip.io";

    public string Server { get; set; } = DefaultServer;
    public string? Email { get; set; }
    // The session token, kept so the user stays signed in like in a browser (the server ends the
    // session after 12 idle hours or 7 days). Signing out clears it.
    public string? Session { get; set; }
    // Desktop window position and size; null on first start (the window then opens centred).
    public WindowBounds? Window { get; set; }
    // Scan fields: show the on-screen keyboard (phones without a hardware scanner).
    public bool ScanKeyboard { get; set; } = true;
    // "Light", "Dark" or null (follow the system).
    public string? Theme { get; set; }
}

public sealed record WindowBounds(int X, int Y, int Width, int Height, bool Maximized);

public sealed class SettingsStore
{
    static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public SettingsStore(string? folder = null)
    {
        Folder = folder ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData, Environment.SpecialFolderOption.Create), "FullyWms");
    }

    public string Folder { get; }
    public string FilePath => Path.Combine(Folder, "settings.json");

    public AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath)) return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Options) ?? new AppSettings();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // A damaged or unreadable file: start over with the defaults.
        }
        return new AppSettings();
    }

    public void Save(AppSettings settings)
    {
        Directory.CreateDirectory(Folder);
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(settings, Options));
        File.Move(tmp, FilePath, overwrite: true);
        if (!OperatingSystem.IsWindows())
        {
            // The session token is in it: only the user may read the file.
            try { File.SetUnixFileMode(FilePath, UnixFileMode.UserRead | UnixFileMode.UserWrite); } catch (IOException) { }
        }
    }
}
