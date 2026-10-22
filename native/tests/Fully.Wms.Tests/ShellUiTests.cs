using Avalonia.Headless.XUnit;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Tests;

public class ShellUiTests
{
    [AvaloniaFact]
    public async Task Login_page_then_home_with_side_menu_on_desktop()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await shell.StartAsync();
        Screens.Save(window, "desktop-login");

        await Screens.SignInAsync(shell, LiveServer.Admin);
        Screens.Settle();
        Assert.IsType<HomeViewModel>(shell.Current);
        Assert.True(shell.ShowSidebar);
        Assert.Contains(shell.MenuItems, (m) => m.Key == "billing");
        Screens.Save(window, "desktop-home");
    }

    [AvaloniaFact]
    public async Task Phone_shows_warehouse_tiles_only_and_back_returns_home()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await shell.StartAsync();
        Screens.Save(window, "phone-login");

        await Screens.SignInAsync(shell, LiveServer.Worker);
        Screens.Settle();
        Assert.False(shell.ShowSidebar);
        Assert.All(shell.MenuItems, (m) => Assert.True(Modules.Find(m.Key)!.OnPhone));
        Screens.Save(window, "phone-home");

        await shell.OpenModuleAsync(shell.MenuItems.First().Key);
        Assert.True(shell.CanGoBack);
        await shell.BackAsync();
        Assert.IsType<HomeViewModel>(shell.Current);
    }

    [AvaloniaFact]
    public async Task Narrow_desktop_window_hides_the_side_menu()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 600, 800);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        Screens.Settle();
        Assert.True(shell.IsCompact);
        Assert.False(shell.ShowSidebar);
        window.Width = 1200;
        Screens.Settle();
        Assert.False(shell.IsCompact);
        Assert.True(shell.ShowSidebar);
    }
}
