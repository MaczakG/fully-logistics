using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Fully.Wms.Core;

// Talks to the server's /api, the same API the web app used. Every rule (permissions, stock
// movements, the activity log) lives on the server; the app only shows and sends data.
//
// The session is the server's "fl_app_session" cookie. It is kept here as a plain token so the app
// can remember it between launches (SessionToken) and send it on every request. The server ends a
// session after 12 hours without use and after 7 days at most; then every call answers 401, which
// raises Unauthorized so the app can show the login screen.
public sealed class ApiClient : IDisposable
{
    public const string CookieName = "fl_app_session";

    // Requests that change something must carry this header (the server's CSRF check).
    const string ClientHeader = "fl-app";

    readonly HttpClient http;

    public ApiClient(Uri baseUri, HttpMessageHandler? handler = null)
    {
        BaseUri = new Uri(baseUri.GetLeftPart(UriPartial.Authority) + "/");
        // Cookies are handled by hand (the session token is all there is), so the handler must not.
        handler ??= new SocketsHttpHandler { UseCookies = false, AutomaticDecompression = DecompressionMethods.All, PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
        http = new HttpClient(handler) { BaseAddress = BaseUri, Timeout = TimeSpan.FromSeconds(30) };
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("FullyWms", typeof(ApiClient).Assembly.GetName().Version?.ToString(3) ?? "1.0"));
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        http.DefaultRequestHeaders.Add("x-requested-with", ClientHeader);
    }

    public Uri BaseUri { get; }

    // The session token from the login's Set-Cookie, or null when signed out.
    public string? SessionToken { get; set; }

    // Raised (on the calling thread) when the server says the session is gone.
    public event EventHandler? Unauthorized;

    public Task<T> GetAsync<T>(string path, CancellationToken ct = default) => SendAsync<T>(HttpMethod.Get, path, null, ct);
    public Task<T> PostAsync<T>(string path, object? body = null, CancellationToken ct = default) => SendAsync<T>(HttpMethod.Post, path, body ?? new { }, ct);
    public Task<T> PutAsync<T>(string path, object body, CancellationToken ct = default) => SendAsync<T>(HttpMethod.Put, path, body, ct);
    public Task<T> PatchAsync<T>(string path, object body, CancellationToken ct = default) => SendAsync<T>(HttpMethod.Patch, path, body, ct);
    public Task<T> DeleteAsync<T>(string path, CancellationToken ct = default) => SendAsync<T>(HttpMethod.Delete, path, null, ct);

    // For calls whose answer the app does not read.
    public Task PostAsync(string path, object? body = null, CancellationToken ct = default) => SendAsync<JsonElement>(HttpMethod.Post, path, body ?? new { }, ct);
    public Task DeleteAsync(string path, CancellationToken ct = default) => SendAsync<JsonElement>(HttpMethod.Delete, path, null, ct);

    public async Task<T> SendAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct = default)
    {
        using var req = Request(method, path);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body, body.GetType(), Json.Options), Encoding.UTF8, "application/json");
        using var res = await Send(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw Error(res, text);
        try
        {
            return JsonSerializer.Deserialize<T>(text, Json.Options)!;
        }
        catch (JsonException e)
        {
            throw new ApiException(0, "bad_response", $"A szerver válasza nem értelmezhető ({method} {path}).", null, e);
        }
    }

    // Uploads a file as multipart/form-data under "file", with extra form fields (CSV imports:
    // preview=1 answers what would be imported, preview=0 imports).
    public async Task<T> UploadAsync<T>(string path, byte[] file, string fileName, IReadOnlyDictionary<string, string>? fields = null, CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Post, path);
        var form = new MultipartFormDataContent();
        foreach (var (k, v) in fields ?? new Dictionary<string, string>()) form.Add(new StringContent(v), k);
        var content = new ByteArrayContent(file);
        content.Headers.ContentType = new MediaTypeHeaderValue(fileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? "text/csv" : "application/octet-stream");
        form.Add(content, "file", fileName);
        req.Content = form;
        using var res = await Send(req, ct).ConfigureAwait(false);
        var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw Error(res, text);
        return JsonSerializer.Deserialize<T>(text, Json.Options)!;
    }

    // A file from the server (PDF documents, CSV exports): its bytes, type and name.
    public async Task<DownloadedFile> DownloadAsync(string path, CancellationToken ct = default)
    {
        using var req = Request(HttpMethod.Get, path);
        using var res = await Send(req, ct).ConfigureAwait(false);
        var bytes = await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) throw Error(res, Encoding.UTF8.GetString(bytes));
        var name = res.Content.Headers.ContentDisposition?.FileNameStar ?? res.Content.Headers.ContentDisposition?.FileName?.Trim('"') ?? Path.GetFileName(path);
        return new DownloadedFile(bytes, res.Content.Headers.ContentType?.MediaType ?? "application/octet-stream", name);
    }

    HttpRequestMessage Request(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, path.TrimStart('/'));
        if (SessionToken is { Length: > 0 } token) req.Headers.Add("Cookie", $"{CookieName}={token}");
        return req;
    }

    async Task<HttpResponseMessage> Send(HttpRequestMessage req, CancellationToken ct)
    {
        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(req, ct).ConfigureAwait(false);
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ApiException(0, "timeout", "A szerver nem válaszolt időben. Ellenőrizd a hálózatot, és próbáld újra.", null);
        }
        catch (HttpRequestException e)
        {
            throw new ApiException(0, "offline", "Nem érem el a szervert. Ellenőrizd a hálózatot és a szerver címét.", null, e);
        }
        ReadSessionCookie(res);
        if (res.StatusCode == HttpStatusCode.Unauthorized && !req.RequestUri!.OriginalString.StartsWith("api/auth/", StringComparison.Ordinal))
        {
            SessionToken = null;
            Unauthorized?.Invoke(this, EventArgs.Empty);
        }
        return res;
    }

    // Login sets the cookie, logout clears it (Max-Age=0).
    void ReadSessionCookie(HttpResponseMessage res)
    {
        if (!res.Headers.TryGetValues("Set-Cookie", out var values)) return;
        foreach (var v in values)
        {
            var parts = v.Split(';', StringSplitOptions.TrimEntries);
            if (!parts[0].StartsWith(CookieName + "=", StringComparison.Ordinal)) continue;
            var token = parts[0][(CookieName.Length + 1)..];
            var cleared = token.Length == 0 || parts.Any((p) => p.Equals("Max-Age=0", StringComparison.OrdinalIgnoreCase));
            SessionToken = cleared ? null : token;
        }
    }

    static ApiException Error(HttpResponseMessage res, string text)
    {
        var status = (int)res.StatusCode;
        try
        {
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
            {
                var code = err.TryGetProperty("code", out var c) ? c.GetString() ?? "error" : "error";
                var message = err.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
                Dictionary<string, string>? fields = null;
                if (err.TryGetProperty("fields", out var f) && f.ValueKind == JsonValueKind.Object)
                    fields = f.EnumerateObject().ToDictionary((p) => p.Name, (p) => p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString()! : p.Value.ToString());
                return new ApiException(status, code, message.Length > 0 ? message : $"Hiba ({status}).", fields);
            }
        }
        catch (JsonException)
        {
            // Not our JSON (a proxy's error page): fall through to the generic message.
        }
        return status switch
        {
            401 => new ApiException(status, "unauthorized", "Be kell jelentkezned.", null),
            >= 500 => new ApiException(status, "server_error", $"A szerver hibát jelzett ({status}). Próbáld újra később.", null),
            _ => new ApiException(status, "error", $"Hiba ({status}).", null),
        };
    }

    public void Dispose() => http.Dispose();
}

public sealed record DownloadedFile(byte[] Bytes, string ContentType, string FileName);

// An error answer of the server: its Hungarian message, a code (bad_request, forbidden, not_found,
// conflict, password_change_required, ...) and, for forms, a message per field.
public sealed class ApiException(int status, string code, string message, IReadOnlyDictionary<string, string>? fields, Exception? inner = null)
    : Exception(message, inner)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public IReadOnlyDictionary<string, string> Fields { get; } = fields ?? new Dictionary<string, string>();
    public bool IsOffline => Status == 0 && Code is "offline" or "timeout";
}
