using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// GET /api/stock: per product on hand, reserved, blocked, available; filters by client and status.
public sealed partial class StockViewModel(ShellViewModel shell) : ListPageViewModel<StockRow>(shell)
{
    public override string Title => "Készlet";
    public override string? Module => "stock";

    public static readonly (string Key, string Label)[] StatusFilters =
    [
        ("", "Minden állapot"), ("attention", "Csak alacsony vagy elfogyott"), ("low", "Alacsony"), ("out", "Elfogyott"), ("ok", "Rendben"),
    ];

    public IReadOnlyList<string> StatusLabels { get; } = StatusFilters.Select((s) => s.Label).ToList();

    [ObservableProperty]
    public partial int StatusIndex { get; set; }

    [ObservableProperty]
    public partial List<PartnerLookup> Partners { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Partner { get; set; }

    [ObservableProperty]
    public partial StockSummary? Summary { get; set; }

    // A row chosen in the list: opens the product (and is cleared again).
    [ObservableProperty]
    public partial StockRow? Selected { get; set; }

    partial void OnStatusIndexChanged(int value) => _ = ReloadAsync();
    partial void OnPartnerChanged(PartnerLookup? value) => _ = ReloadAsync();

    partial void OnSelectedChanged(StockRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new StockProductViewModel(Shell, value.ProductId));
    }

    protected override string ListPath() => Query.Build("api/stock",
        ("q", Search.Trim()), ("partner_id", Partner?.Id), ("status", StatusFilters[Math.Clamp(StatusIndex, 0, StatusFilters.Length - 1)].Key));

    protected override async Task<(IReadOnlyList<StockRow> Items, int Total)> FetchAsync(int offset)
    {
        if (Partners.Count == 0)
        {
            var list = await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1");
            Partners = list.Items;
        }
        var page = await Api.GetAsync<StockPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Summary = page.Summary;
        return (page.Items, page.Total);
    }

    // A scanned or typed code: a location code opens the location, a code of exactly one product
    // opens the product, anything else filters the list.
    [RelayCommand]
    Task ScanAsync(string code) => RunAsync(async () =>
    {
        var locations = await Api.GetAsync<ItemList<LocationLookup>>(Query.Build("api/lookup/locations", ("q", code)));
        var location = locations.Items.FirstOrDefault((l) => string.Equals(l.Code, code, StringComparison.OrdinalIgnoreCase));
        if (location is not null)
        {
            await Shell.NavigateAsync(new StockLocationViewModel(Shell, location.Id));
            return;
        }
        var found = await Api.GetAsync<StockPage>(Query.Build("api/stock", ("q", code), ("limit", 2)));
        var exact = found.Items.Where((r) => string.Equals(r.Sku, code, StringComparison.OrdinalIgnoreCase) || r.Ean == code).ToList();
        if (exact.Count == 1 || found.Total == 1)
        {
            await Shell.NavigateAsync(new StockProductViewModel(Shell, (exact.Count == 1 ? exact[0] : found.Items[0]).ProductId));
            return;
        }
        Search = code;
        await ReloadAsync();
        if (Total == 0) Shell.Toast($"Nincs ilyen raktárhely vagy cikk: {code}", ToastKind.Warning);
    });

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        Search = "";
        Partner = null;
        StatusIndex = 0;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ExportAsync() => RunAsync(async () =>
    {
        var file = await Api.DownloadAsync(Query.Build("api/stock/export", ("q", Search.Trim()), ("partner_id", Partner?.Id),
            ("status", StatusFilters[StatusIndex].Key)));
        await Shell.Services.Platform.OpenFileAsync(file);
    });
}
