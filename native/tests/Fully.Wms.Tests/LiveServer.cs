using Fully.Wms.Core;

namespace Fully.Wms.Tests;

// Tests against a running server with the demo data (app/: see DEVELOPING.md). Set FL_TEST_SERVER,
// e.g. http://localhost:8899; without it these tests are skipped.
//   FL_TEST_SERVER=http://localhost:8899 dotnet test
public static class LiveServer
{
    public static readonly string? Url = Environment.GetEnvironmentVariable("FL_TEST_SERVER");
    public const string Admin = "admin@example.com";
    public const string Worker = "raktaros@example.com";
    public static readonly string Password = Environment.GetEnvironmentVariable("FL_TEST_PASSWORD") ?? "jelszo-12345";

    public static void SkipIfMissing()
    {
        if (string.IsNullOrEmpty(Url)) Assert.Skip("FL_TEST_SERVER nincs megadva.");
    }

    public static async Task<ApiClient> SignInAsync(string email)
    {
        SkipIfMissing();
        var api = new ApiClient(new Uri(Url!));
        await api.PostAsync("api/auth/login", new { email, password = Password });
        return api;
    }
}
