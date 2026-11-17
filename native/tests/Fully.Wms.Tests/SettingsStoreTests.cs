using Fully.Wms.Core;

namespace Fully.Wms.Tests;

// What the app remembers on the device: saved and read back; a device that still has an earlier
// default server address follows the server to its new one.
public class SettingsStoreTests
{
    static SettingsStore NewStore() => new(Path.Combine(TestApp.SettingsFolder, Guid.NewGuid().ToString("N")));

    [Fact]
    public void The_default_server_is_the_live_one()
    {
        Assert.Equal("https://app.fully.hu", AppSettings.DefaultServer);
        Assert.Equal(AppSettings.DefaultServer, NewStore().Load().Server);
    }

    [Fact]
    public void Saved_and_read_back()
    {
        var store = NewStore();
        store.Save(new AppSettings { Server = "https://wms.example.com", Email = "a@example.com", Session = "s" });
        var s = store.Load();
        Assert.Equal("https://wms.example.com", s.Server);
        Assert.Equal("s", s.Session);
    }

    [Theory]
    [InlineData("https://18-185-119-189.sslip.io")]
    [InlineData("https://3-71-236-97.sslip.io")]
    public void An_old_default_address_moves_to_the_new_one(string old)
    {
        var store = NewStore();
        store.Save(new AppSettings { Server = old, Email = "a@example.com", Session = "old" });
        var s = store.Load();
        Assert.Equal(AppSettings.DefaultServer, s.Server);
        Assert.Null(s.Session);
        Assert.Equal("a@example.com", s.Email);
    }

    [Fact]
    public void The_live_address_keeps_its_session()
    {
        var store = NewStore();
        store.Save(new AppSettings { Server = AppSettings.DefaultServer, Session = "s" });
        Assert.Equal("s", store.Load().Session);
    }
}
