using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Common;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Inbound;

// GET /api/inbound: status tabs with counts, key figures, filters; new inbound, CSV import.
public sealed partial class InboundListViewModel(ShellViewModel shell) : ListPageViewModel<InboundRow>(shell)
{
    public override string Title => "Betárolás";
    public override string? Module => "inbound";

    public static readonly (string Key, string Label)[] Tabs =
    [
        ("open", "Nyitott"), ("expected", "Várható"), ("arrived", "Megérkezett"), ("receiving", "Átvétel alatt"),
        ("completed", "Betárolva"), ("cancelled", "Sztornózva"), ("all", "Összes"),
    ];

    public IReadOnlyList<StatusTab> StatusTabs { get; } = Tabs.Select((t) => new StatusTab(t.Key, t.Label)).ToList();

    [ObservableProperty]
    public partial StatusTab? SelectedTab { get; set; }

    [ObservableProperty]
    public partial InboundKpis? Kpis { get; set; }

    [ObservableProperty]
    public partial List<PartnerLookup> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<PartnerLookup> Suppliers { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Client { get; set; }

    [ObservableProperty]
    public partial PartnerLookup? Supplier { get; set; }

    [ObservableProperty]
    public partial DateTime? From { get; set; }

    [ObservableProperty]
    public partial DateTime? To { get; set; }

    // From the "Eltéréssel lezárt" figure: completed with discrepancy since a date.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(DiscrepancyNotice))]
    public partial string? ClosedFrom { get; set; }

    [ObservableProperty]
    public partial InboundRow? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("inbound", "create") == true;
    public bool CanImport => CanCreate && !Shell.IsPhone;
    public string? DiscrepancyNotice => ClosedFrom is null ? null : $"Csak az eltéréssel lezárt betárolások {Fmt.Date(ClosedFrom)} óta.";
    public string Status => SelectedTab?.Key ?? "open";

    partial void OnSelectedTabChanged(StatusTab? value)
    {
        foreach (var t in StatusTabs) t.IsSelected = t == value;
        if (value is not null && Loaded) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(InboundRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new InboundViewModel(Shell, value.Id));
    }

    protected override string ListPath() => Query.Build("api/inbound",
        ("status", Status == "all" ? null : Status), ("q", Search.Trim()), ("partner_id", Client?.Id), ("supplier_id", Supplier?.Id),
        ("from", From?.ToString("yyyy-MM-dd")), ("to", To?.ToString("yyyy-MM-dd")),
        ("discrepancy", ClosedFrom is null ? null : "1"), ("closed_from", ClosedFrom));

    protected override async Task<(IReadOnlyList<InboundRow> Items, int Total)> FetchAsync(int offset)
    {
        SelectedTab ??= StatusTabs[0];
        if (Clients.Count == 0)
        {
            var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1");
            var suppliers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=supplier&all=1");
            Clients = (await clients).Items;
            Suppliers = (await suppliers).Items;
        }
        var page = await Api.GetAsync<InboundPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Kpis = page.Kpis;
        foreach (var t in StatusTabs) t.Count = page.Counts.GetValueOrDefault(t.Key);
        return (page.Items, page.Total);
    }

    // A scanned or typed inbound number or delivery note reference opens it when it is the only hit.
    [RelayCommand]
    Task ScanAsync(string code) => RunAsync(async () =>
    {
        var page = await Api.GetAsync<InboundPage>(Query.Build("api/inbound", ("q", code), ("limit", 2)));
        if (page.Total == 1)
        {
            await Shell.NavigateAsync(new InboundViewModel(Shell, page.Items[0].Id));
            return;
        }
        Search = code;
        SelectedTab = StatusTabs[^1];
        await ReloadAsync();
        if (Total == 0) Shell.Toast($"Nincs ilyen betárolás: {code}", ToastKind.Warning);
    });

    [RelayCommand]
    Task ShowAsync(string what)
    {
        // The key figures open their filtered list, like the web app's tiles.
        ClosedFrom = null;
        From = To = null;
        switch (what)
        {
            case "today":
                From = To = DateTime.ParseExact(Kpis?.Today ?? DateTime.Today.ToString("yyyy-MM-dd"), "yyyy-MM-dd", null);
                SelectedTab = StatusTabs.First((t) => t.Key == "expected");
                break;
            case "discrepancy":
                ClosedFrom = Kpis?.DiscrepancySince;
                SelectedTab = StatusTabs.First((t) => t.Key == "completed");
                break;
            default:
                SelectedTab = StatusTabs.First((t) => t.Key == what);
                break;
        }
        return ReloadAsync();
    }

    [RelayCommand]
    void SelectTab(StatusTab tab)
    {
        ClosedFrom = null;
        SelectedTab = tab;
    }

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        Search = "";
        Client = Supplier = null;
        From = To = null;
        ClosedFrom = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new InboundFormViewModel(Shell, null));

    [RelayCommand]
    Task ImportAsync() => Shell.NavigateAsync(new CsvImportViewModel(Shell, new CsvImportOptions(
        "inbound", "Betárolások importálása CSV-ből", "api/inbound/import",
        "Soronként egy tétel. Az azonos ügyfélkódú és külső hivatkozású sorokból egy betárolás lesz. Ha nincs külső hivatkozás, az azonos dátumú és beszállítójú sorok kerülnek egybe. A már importált hivatkozásokat kihagyjuk.",
        "betarolas-sablon.csv",
        ["Ügyfélkód", "Külső hivatkozás", "Várható dátum", "Cikkszám", "Mennyiség", "Sarzs", "Lejárat", "Beszállító kód"],
        (r) => $"{Fmt.Int(r.Inbounds)} betárolás jött létre ({Fmt.Int(r.Imported)} sor).")));
}

// A status tab with its count.
public sealed partial class StatusTab(string key, string label) : ObservableObject
{
    public string Key { get; } = key;
    public string Label { get; } = label;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Text))]
    public partial int Count { get; set; }

    [ObservableProperty]
    public partial bool IsSelected { get; set; }

    public string Text => $"{Label} {Fmt.Int(Count)}";
}
