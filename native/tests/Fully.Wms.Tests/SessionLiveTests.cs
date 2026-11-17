using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

public class SessionLiveTests
{
    [Fact]
    public async Task Worker_signs_in_and_reads_home_counts()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        Assert.NotNull(api.SessionToken);
        var me = await api.GetAsync<Me>("api/me", TestContext.Current.CancellationToken);
        Assert.Equal(LiveServer.Worker, me.User.Email);
        var home = await api.GetAsync<HomeCounts>("api/home", TestContext.Current.CancellationToken);
        Assert.Equal(home.Has("inbound"), me.Can("inbound"));
    }

    [Fact]
    public async Task Meta_has_the_status_labels()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        var meta = await api.GetAsync<MetaInfo>("api/meta", TestContext.Current.CancellationToken);
        Assert.Equal("Várható", meta.Status("inbound", "expected").Label);
        Assert.Equal("accent", meta.Status("wave", "picking").Tone);
        Assert.NotEmpty(meta.Sizes);
        Assert.Equal("Tárolóhely", MetaInfo.Label(meta.LocationKinds, "storage"));
        Assert.Equal("ismeretlen", meta.Status("inbound", "ismeretlen").Label);
    }

    [Fact]
    public async Task Wrong_password_is_a_readable_error()
    {
        LiveServer.SkipIfMissing();
        using var api = new ApiClient(new Uri(LiveServer.Url!));
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync("api/auth/login", new { email = LiveServer.Worker, password = "rossz-jelszo-123" }, TestContext.Current.CancellationToken));
        Assert.Equal(400, e.Status);
        Assert.False(string.IsNullOrWhiteSpace(e.Message));
    }

    [Fact]
    public async Task Logout_ends_the_session()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        var token = api.SessionToken;
        await api.PostAsync("api/auth/logout", null, TestContext.Current.CancellationToken);
        Assert.Null(api.SessionToken);
        api.SessionToken = token;
        var e = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<Me>("api/me", TestContext.Current.CancellationToken));
        Assert.Equal(401, e.Status);
    }
}
