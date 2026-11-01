using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

public class ApiClientTests
{
    // Answers every request with the given response and remembers the requests.
    sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(answer(request));
        }
    }

    static HttpResponseMessage JsonResponse(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task Login_cookie_becomes_the_session_and_is_sent_back()
    {
        var handler = new FakeHandler((req) =>
        {
            var res = JsonResponse(HttpStatusCode.OK, """{"ok":true,"must_change_password":false}""");
            if (req.RequestUri!.AbsolutePath == "/api/auth/login")
                res.Headers.Add("Set-Cookie", "fl_app_session=abc123; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200");
            return res;
        });
        using var api = new ApiClient(new Uri("https://example.test"), handler);

        var login = await api.PostAsync<LoginResult>("api/auth/login", new { email = "a@b.hu", password = "x" }, TestContext.Current.CancellationToken);
        Assert.True(login.Ok);
        Assert.Equal("abc123", api.SessionToken);

        await api.GetAsync<HomeCounts>("api/home", TestContext.Current.CancellationToken);
        var second = handler.Requests[1];
        Assert.Equal("fl_app_session=abc123", string.Join(";", second.Headers.GetValues("Cookie")));
        Assert.Equal("fl-app", second.Headers.GetValues("x-requested-with").Single());
    }

    [Fact]
    public async Task Logout_cookie_clears_the_session()
    {
        var handler = new FakeHandler((_) =>
        {
            var res = JsonResponse(HttpStatusCode.OK, """{"ok":true}""");
            res.Headers.Add("Set-Cookie", "fl_app_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
            return res;
        });
        using var api = new ApiClient(new Uri("https://example.test"), handler) { SessionToken = "abc" };
        await api.PostAsync("api/auth/logout", null, TestContext.Current.CancellationToken);
        Assert.Null(api.SessionToken);
    }

    [Fact]
    public async Task Error_answer_carries_message_code_and_fields()
    {
        var handler = new FakeHandler((_) => JsonResponse(HttpStatusCode.BadRequest,
            """{"error":{"code":"bad_request","message":"Hibás adatok.","fields":{"qty":"Pozitív szám legyen."}}}"""));
        using var api = new ApiClient(new Uri("https://example.test"), handler);
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync("api/x", new { }, TestContext.Current.CancellationToken));
        Assert.Equal(400, e.Status);
        Assert.Equal("bad_request", e.Code);
        Assert.Equal("Hibás adatok.", e.Message);
        Assert.Equal("Pozitív szám legyen.", e.Fields["qty"]);
    }

    [Fact]
    public async Task Unauthorized_clears_the_session_and_raises_the_event()
    {
        var handler = new FakeHandler((_) => JsonResponse(HttpStatusCode.Unauthorized, """{"error":{"code":"unauthorized","message":"Be kell jelentkezned."}}"""));
        using var api = new ApiClient(new Uri("https://example.test"), handler) { SessionToken = "old" };
        var raised = 0;
        api.Unauthorized += (_, _) => raised++;
        await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<Me>("api/me", TestContext.Current.CancellationToken));
        Assert.Equal(1, raised);
        Assert.Null(api.SessionToken);
    }

    [Fact]
    public async Task Proxy_error_page_gives_a_readable_message()
    {
        var handler = new FakeHandler((_) => new HttpResponseMessage(HttpStatusCode.BadGateway) { Content = new StringContent("<html>502</html>") });
        using var api = new ApiClient(new Uri("https://example.test"), handler);
        var e = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<Me>("api/me", TestContext.Current.CancellationToken));
        Assert.Equal(502, e.Status);
        Assert.Contains("szerver hibát jelzett", e.Message);
    }

    [Fact]
    public void Json_reads_sqlite_flags_and_numbers_as_strings()
    {
        var me = System.Text.Json.JsonSerializer.Deserialize<Me>(
            """
            {"user":{"id":1,"email":"a@b.hu","name":"A","phone":null,"role":{"id":1,"key":"admin","name":"Admin","is_admin":1},"must_change_password":0},
             "permissions":{"stock":["view"]},"company":{"name":"Fully"},"warehouse":{"cutoff":"14:00","open":"","close":""}}
            """, Json.Options)!;
        Assert.True(me.User.Role.IsAdmin);
        Assert.False(me.User.MustChangePassword);
        Assert.True(me.Can("users", "delete"));
    }

    [Fact]
    public void Permissions_of_a_non_admin_come_from_the_map()
    {
        var me = new Me(new MeUser(2, "r@b.hu", "R", null, new MeRole(2, "raktaros", "Raktáros", false), false),
            new() { ["inbound"] = ["view", "edit"] }, new MeCompany("Fully"), new MeWarehouse("14:00", null, null));
        Assert.True(me.Can("inbound", "edit"));
        Assert.False(me.Can("inbound", "delete"));
        Assert.False(me.Can("billing"));
    }

    [Theory]
    [InlineData("12", 12)]
    [InlineData("1 234,5", 1234.5)]
    [InlineData("1234.5", 1234.5)]
    [InlineData("-3", -3)]
    public void ParseNumber_reads_what_people_type(string text, double expected) =>
        Assert.Equal((decimal)expected, Fmt.ParseNumber(text));

    [Theory]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData("1,2,3")]
    public void ParseNumber_refuses_non_numbers(string text) => Assert.Null(Fmt.ParseNumber(text));

    [Fact]
    public void Formats_are_hungarian()
    {
        Assert.Equal("2026. 10. 22.", Fmt.Date("2026-10-22"));
        Assert.Equal("1 234 Ft", Fmt.Money(1234).Replace(' ', ' '));
    }

    // The server's form parser takes only quoted names: name="file"; filename="...", in ASCII.
    [Fact]
    public async Task Upload_sends_quoted_form_names()
    {
        string? body = null;
        string? type = null;
        var handler = new FakeHandler((req) =>
        {
            body = req.Content!.ReadAsStringAsync().Result;
            type = req.Content.Headers.ContentType?.MediaType;
            return JsonResponse(HttpStatusCode.OK, """{"id":7,"filename":"x"}""");
        });
        using var api = new ApiClient(new Uri("https://example.test"), handler);
        await api.UploadAsync<System.Text.Json.JsonElement>("api/x", [1, 2, 3], "sérült doboz.jpg", new Dictionary<string, string> { ["preview"] = "1" }, TestContext.Current.CancellationToken);
        Assert.Equal("multipart/form-data", type);
        Assert.Contains("Content-Disposition: form-data; name=\"preview\"", body);
        Assert.Contains("Content-Disposition: form-data; name=\"file\"; filename=\"sérült doboz.jpg\"", body);
        Assert.Contains("Content-Type: image/jpeg", body);
    }
}
