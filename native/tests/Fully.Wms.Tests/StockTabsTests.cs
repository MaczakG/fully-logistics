using Avalonia.Headless.XUnit;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Stock;

namespace Fully.Wms.Tests;

public class StockTabsTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("A-01-03", "A", "01", 3, 0)]
    [InlineData("A.01.03.2", "A", "01", 3, 2)]
    [InlineData("A0103", "A", "01", 3, 0)]
    [InlineData("P-12-04", "P", "12", 4, 0)]
    public void Map_reads_rack_level_and_position_from_the_code(string code, string zone, string rack, int level, int pos)
    {
        var p = MapLayout.Parse(code, zone);
        Assert.NotNull(p);
        Assert.Equal((rack, level, pos), p.Value);
    }

    [Theory]
    [InlineData("RAMPA")]
    [InlineData("KARANTEN")]
    public void Map_puts_other_codes_aside(string code) => Assert.Null(MapLayout.Parse(code, ""));

    [Theory]
    [InlineData("5999876003015", null)]
    [InlineData("5999876003016", "Az EAN ellenőrző számjegye hibás (6 helyett 5 lenne helyes).")]
    [InlineData("12345", "Az EAN hossza 5 számjegy. Szabványos hossz: 8, 12, 13 vagy 14.")]
    [InlineData("ABC123", "Az EAN nem csak számjegyekből áll. Ellenőrizd, hogy valóban vonalkód-e.")]
    [InlineData("", null)]
    public void Ean_warning_matches_the_server(string ean, string? warning) => Assert.Equal(warning, Ean.Warning(ean));

    [Fact]
    public async Task Tab_answers_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var locs = await api.GetAsync<LocationsPage>("api/stock/locations?limit=20", Ct);
        Assert.NotEmpty(locs.Summary.BySize);
        Assert.Equal(locs.Summary.BySize.Sum((s) => s.Total), locs.Summary.BySize.Sum((s) => s.Occupied + s.Empty));
        var map = await api.GetAsync<StockMapData>("api/stock/map", Ct);
        Assert.Contains("occupant", map.Columns);
        Assert.NotEmpty(map.Rows);
        var moves = await api.GetAsync<MovementsPage>("api/stock/movements?limit=5", Ct);
        Assert.True(moves.Total >= moves.Items.Count);
        var products = await api.GetAsync<ProductsPage>("api/products?limit=5", Ct);
        var p = await api.GetAsync<ProductRow>($"api/products/{products.Items[0].Id}", Ct);
        Assert.Equal(products.Items[0].Sku, p.Sku);
    }

    [Fact]
    public async Task Product_create_edit_deactivate_activate()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var client = (await api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client", Ct)).Items[0];
        var sku = $"NAT-{Guid.NewGuid():N}"[..14].ToUpperInvariant();
        var created = await api.PostAsync<ProductSaved>("api/products", new { partner_id = client.Id, sku, name = "Natív teszt cikk", ean = "12345", unit = "db", min_stock = 2 }, Ct);
        Assert.Contains(created.Warnings!, (w) => w.Contains("EAN"));
        await api.PatchAsync<ProductSaved>($"api/products/{created.Id}", new { name = "Natív teszt cikk 2", track_lot = true }, Ct);
        var p = await api.GetAsync<ProductRow>($"api/products/{created.Id}", Ct);
        Assert.Equal("Natív teszt cikk 2", p.Name);
        Assert.True(p.TrackLot);
        Assert.True(p.CanDeactivate);
        await api.PostAsync($"api/products/{created.Id}/deactivate", null, Ct);
        Assert.False((await api.GetAsync<ProductRow>($"api/products/{created.Id}", Ct)).Active);
        await api.PostAsync($"api/products/{created.Id}/activate", null, Ct);
        Assert.True((await api.GetAsync<ProductRow>($"api/products/{created.Id}", Ct)).Active);
    }

    [AvaloniaFact]
    public async Task Tabs_map_locations_catalogue_and_movements()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("stock");

        await StockTabs.Open(shell, "map");
        var map = Assert.IsType<StockMapViewModel>(shell.Current);
        Assert.NotEmpty(map.Zones);
        map.Highlight = map.Holders.FirstOrDefault();
        Screens.Settle();
        Assert.False(string.IsNullOrEmpty(map.Focus));
        Screens.Save(window, "stock-map-desktop");

        await StockTabs.Open(shell, "locations");
        var locs = Assert.IsType<LocationsViewModel>(shell.Current);
        Assert.NotEmpty(locs.Items);
        Screens.Save(window, "stock-locations-desktop");

        await StockTabs.Open(shell, "catalog");
        var cat = Assert.IsType<ProductsViewModel>(shell.Current);
        Assert.NotEmpty(cat.Items);
        Screens.Save(window, "stock-catalog-desktop");
        await cat.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<ProductFormViewModel>(shell.Current);
        form.Ean = "5999876003016";
        Assert.NotNull(form.EanWarning);
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("partner_id"));
        Screens.Save(window, "stock-product-form-desktop");
        await shell.BackAsync();

        await StockTabs.Open(shell, "movements");
        var moves = Assert.IsType<MovementsViewModel>(shell.Current);
        Assert.NotEmpty(moves.Items);
        Screens.Save(window, "stock-movements-desktop");

        // Back from a tab goes home (the tabs replace each other).
        await shell.BackAsync();
        Assert.IsType<Fully.Wms.ViewModels.HomeViewModel>(shell.Current);
    }

    [AvaloniaFact]
    public async Task Phone_map_fits()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("stock");
        await StockTabs.Open(shell, "map");
        Assert.NotEmpty(Assert.IsType<StockMapViewModel>(shell.Current).Zones);
        Screens.Save(window, "stock-map-phone");
    }
}
