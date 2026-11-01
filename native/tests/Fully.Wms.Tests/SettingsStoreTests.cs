using Fully.Wms.Core;

namespace Fully.Wms.Tests;

// What the app remembers on the device: saved and read back; a device that still has an earlier
// default server address follows the server to its new one.
public class SettingsStoreTests
{
    static SettingsStore NewStore() => new(Path.Combine(TestApp.SettingsFolder, Guid.NewGuid().ToString("N")));

    [Fact]
    public void Saved_and_read_back()
    {
        var store = NewStore();
        Assert.Equal(AppSettings.DefaultServer, store.Load().Server);
        store.Save(new AppSettings { Server = "https://app.fully.hu", Email = "a@example.com", Session = "s" });
        var s = store.Load();
        Assert.Equal("https://app.fully.hu", s.Server);
        Assert.Equal("s", s.Session);
    }

    [Fact]
    public void An_old_default_address_moves_to_the_new_one()
    {
        var store = NewStore();
        store.Save(new AppSettings { Server = "https://18-185-119-189.sslip.io", Email = "a@example.com", Session = "old" });
        var s = store.Load();
        Assert.Equal(AppSettings.DefaultServer, s.Server);
        Assert.Null(s.Session);
        Assert.Equal("a@example.com", s.Email);
    }
}
