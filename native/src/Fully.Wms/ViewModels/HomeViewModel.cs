using Fully.Wms.Core.Models;

namespace Fully.Wms.ViewModels;

// Home: the modules as big tiles with the waiting work (GET /api/home), like the web app's PDA home.
public sealed class HomeViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Kezdőképernyő";

    public string Greeting => Shell.UserName;
    public string Role => Shell.UserRole;
    public string Cutoff => Shell.Me is { } me ? $"Napi rendelésleadási határidő: {me.Warehouse.Cutoff}" : "";

    public override async Task LoadAsync()
    {
        var counts = await Api.GetAsync<HomeCounts>("api/home");
        Shell.ApplyCounts(counts);
    }
}
