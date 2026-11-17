using Fully.Wms.Core;

namespace Fully.Wms.Services;

// The app's shared objects: the settings of this device, the API client and the platform.
public sealed class AppServices
{
    readonly SettingsStore store;

    public AppServices(SettingsStore store, IPlatformServices platform)
    {
        this.store = store;
        Platform = platform;
        Settings = store.Load();
        Api = CreateApi(Settings.Server);
        Api.SessionToken = Settings.Session;
    }

    public AppSettings Settings { get; }
    public IPlatformServices Platform { get; }
    public ApiClient Api { get; private set; }

    // Raised when a call finds the session gone (expired, or signed out elsewhere).
    public event EventHandler? SessionLost;

    // A new server address: a new client without a session.
    public void UseServer(string server)
    {
        var uri = NormalizeServer(server) ?? throw new ArgumentException("Érvénytelen szervercím.", nameof(server));
        if (uri.ToString().TrimEnd('/') == Api.BaseUri.ToString().TrimEnd('/')) return;
        Api.Unauthorized -= OnUnauthorized;
        Api.Dispose();
        Api = CreateApi(uri.ToString());
        Settings.Server = uri.ToString().TrimEnd('/');
        Settings.Session = null;
        SaveSettings();
    }

    public void SaveSettings()
    {
        Settings.Session = Api.SessionToken;
        try
        {
            store.Save(Settings);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Not being able to remember is no reason to stop working.
        }
    }

    // "fully.example.hu" -> https://fully.example.hu ; null when it is not a web address.
    public static Uri? NormalizeServer(string? text)
    {
        var s = (text ?? "").Trim();
        if (s.Length == 0) return null;
        if (!s.Contains("://", StringComparison.Ordinal)) s = "https://" + s;
        return Uri.TryCreate(s, UriKind.Absolute, out var uri) && uri.Scheme is "https" or "http" && uri.Host.Length > 0
            ? new Uri(uri.GetLeftPart(UriPartial.Authority))
            : null;
    }

    ApiClient CreateApi(string server)
    {
        var api = new ApiClient(NormalizeServer(server) ?? new Uri(AppSettings.DefaultServer));
        api.Unauthorized += OnUnauthorized;
        return api;
    }

    void OnUnauthorized(object? sender, EventArgs e) => SessionLost?.Invoke(this, EventArgs.Empty);
}
