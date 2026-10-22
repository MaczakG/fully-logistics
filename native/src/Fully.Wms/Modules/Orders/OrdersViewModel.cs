using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Common;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Orders;

// GET /api/orders: the open orders (new, hold, picking, packed) with key figures, status tabs,
// filters and availability; new order, CSV import, the selected new orders to picking.
public sealed partial class OrdersViewModel(ShellViewModel shell) : ListPageViewModel<OrderRowItem>(shell)
{
    public override string Title => "Megrendelések";
    public override string? Module => "orders";

    static readonly (string Key, string Label)[] Tabs =
        [("", "Összes nyitott"), ("new", "Új"), ("hold", "Felfüggesztve"), ("picking", "Komissió alatt"), ("packed", "Feladásra kész")];

    public IReadOnlyList<OrderTab> StatusTabs { get; } = Tabs.Select((t) => new OrderTab(t.Key, t.Label)).ToList();

    public static readonly IReadOnlyList<OrderChoice> Priorities = [new(null, "Minden prioritás"), new("express", "Expressz"), new("normal", "Normál")];
    public static readonly IReadOnlyList<OrderChoice> Availabilities = [new(null, "Minden készlet"), new("ok", "Teljesíthető"), new("short", "Hiányos")];

    [ObservableProperty]
    public partial OrderTab? SelectedTab { get; set; }

    [ObservableProperty]
    public partial OrderKpis? Kpis { get; set; }

    [ObservableProperty]
    public partial List<OrderChoice> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<OrderChoice> Carriers { get; set; } = [];

    [ObservableProperty]
    public partial OrderChoice? Client { get; set; }

    [ObservableProperty]
    public partial OrderChoice? Carrier { get; set; }

    [ObservableProperty]
    public partial OrderChoice? Priority { get; set; } = Priorities[0];

    [ObservableProperty]
    public partial OrderChoice? Availability { get; set; } = Availabilities[0];

    [ObservableProperty]
    public partial OrderRowItem? Selected { get; set; }

    // The selection bar: how many are selected and how many of them can go to picking.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelection))]
    public partial string SelectionText { get; set; } = "";

    public bool HasSelection => SelectionText.Length > 0;
    public bool CanCreate => Shell.Me?.Can("orders", "create") == true;
    public bool CanImport => CanCreate && !Shell.IsPhone;
    public bool CanWave => Shell.Me?.Can("picking", "create") == true && !Shell.IsPhone;
    public string Status => SelectedTab?.Key ?? "";
    bool Filtered => Search.Trim().Length > 0 || Client?.Key is not null || Carrier?.Key is not null || Priority?.Key is not null || Availability?.Key is not null;
    public string EmptyText => Filtered ? "Nincs a szűrésnek megfelelő rendelés." : "Nincs nyitott rendelés.";

    bool quiet;

    partial void OnSelectedTabChanged(OrderTab? value)
    {
        foreach (var t in StatusTabs) t.IsSelected = t == value;
        Reload();
    }

    partial void OnClientChanged(OrderChoice? value) => Reload();
    partial void OnCarrierChanged(OrderChoice? value) => Reload();
    partial void OnPriorityChanged(OrderChoice? value) => Reload();
    partial void OnAvailabilityChanged(OrderChoice? value) => Reload();

    void Reload()
    {
        OnPropertyChanged(nameof(EmptyText));
        if (Loaded && !quiet) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(OrderRowItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new OrderViewModel(Shell, value.Row.Id));
    }

    protected override string ListPath() => Query.Build("api/orders",
        ("status", Status.Length > 0 ? Status : null), ("q", Search.Trim()), ("partner_id", Client?.Key), ("carrier_id", Carrier?.Key),
        ("priority", Priority?.Key), ("availability", Availability?.Key));

    protected override async Task<(IReadOnlyList<OrderRowItem> Items, int Total)> FetchAsync(int offset)
    {
        if (SelectedTab is null)
        {
            quiet = true;
            SelectedTab = StatusTabs[0];
            quiet = false;
        }
        if (Clients.Count == 0)
        {
            var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
            var carriers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier");
            quiet = true;
            Clients = [new(null, "Minden ügyfél"), .. (await clients).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
            Carriers = [new(null, "Minden fuvarozó"), .. (await carriers).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
            Client = Clients[0];
            Carrier = Carriers[0];
            quiet = false;
        }
        var page = await Api.GetAsync<OrdersPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Kpis = page.Kpis;
        var k = page.Kpis;
        foreach (var t in StatusTabs)
        {
            t.Count = t.Key switch { "new" => k.New, "hold" => k.Hold, "picking" => k.Picking, "packed" => k.Packed, _ => k.New + k.Hold + k.Picking + k.Packed };
        }
        if (offset == 0) SelectionText = "";
        return (page.Items.Select((r) => new OrderRowItem(this, r)).ToList(), page.Total);
    }

    internal void SelectionChanged()
    {
        var picked = Items.Where((i) => i.IsSelected).ToList();
        var ready = picked.Count((i) => i.Row.Status == "new" && i.Row.Availability == "ok");
        SelectionText = picked.Count == 0 ? "" : $"{Fmt.Int(picked.Count)} kijelölve, ebből {Fmt.Int(ready)} indítható";
    }

    [RelayCommand]
    void SelectTab(OrderTab tab) => SelectedTab = tab;

    // The key figures open their filtered list, like the web app's tiles.
    [RelayCommand]
    Task ShowAsync(string what)
    {
        quiet = true;
        Priority = Priorities[0];
        Availability = Availabilities[0];
        switch (what)
        {
            case "fulfillable":
                SelectedTab = StatusTabs.First((t) => t.Key == "new");
                Availability = Availabilities[1];
                break;
            case "express":
                SelectedTab = StatusTabs[0];
                Priority = Priorities[1];
                break;
            default:
                SelectedTab = StatusTabs.First((t) => t.Key == what);
                break;
        }
        quiet = false;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        quiet = true;
        Search = "";
        Client = Clients.FirstOrDefault();
        Carrier = Carriers.FirstOrDefault();
        Priority = Priorities[0];
        Availability = Availabilities[0];
        quiet = false;
        return ReloadAsync();
    }

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new OrderFormViewModel(Shell, null));

    [RelayCommand]
    Task ImportAsync() => Shell.NavigateAsync(new CsvImportViewModel(Shell, new CsvImportOptions(
        "orders", "Rendelések importálása CSV-ből", "api/orders/import",
        "Minden sor egy rendeléstétel. Az azonos partnerkódú és rendelésszámú sorokból egy rendelés lesz, a címadatokat az első sorból vesszük. A futár: gls, dpd, foxpost, mpl vagy dhl. A már importált rendelésszámok kimaradnak.",
        "rendelesek-sablon.csv",
        ["Partnerkód", "Rendelésszám", "Vevő neve", "Cég", "E-mail", "Telefon", "Ország", "Irányítószám", "Város", "Cím",
         "Átvételi pont", "Futár", "Utánvét", "Cikkszám", "Mennyiség", "Megjegyzés"],
        (r) => $"{Fmt.Int(r.Imported)} rendelés importálva.")));

    [RelayCommand]
    Task WaveAsync() => Shell.NavigateAsync(new SendToPickingViewModel(Shell, Items.Where((i) => i.IsSelected).Select((i) => new WaveCandidate(i.Row.Id, i.Row.Number, i.Row.Status, i.Row.Availability, i.Row.ItemCount)).ToList()));

    [RelayCommand]
    void Unselect()
    {
        foreach (var i in Items) i.IsSelected = false;
        SelectionText = "";
    }
}

public sealed partial class OrderTab(string key, string label) : ObservableObject
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

// A choice of a select; Key null is "all" or "none".
public sealed record OrderChoice(string? Key, string Label)
{
    public int? Id => int.TryParse(Key, out var n) ? n : null;
}

// A row of the list with its selection box.
public sealed partial class OrderRowItem(OrdersViewModel page, OrderRow row) : ObservableObject
{
    public OrderRow Row { get; } = row;

    [ObservableProperty]
    public partial bool IsSelected { get; set; }

    partial void OnIsSelectedChanged(bool value) => page.SelectionChanged();

    public string Age => OrdersFormat.Age(Row.CreatedAt);
    public string AgeTone => Row.Status is "new" or "hold" ? OrdersFormat.AgeTone(Row.CreatedAt) : "";
    public string Place => string.Join(" ", new[] { Row.Zip, Row.City }.Where((x) => !string.IsNullOrEmpty(x)));
    public string PartnerPlace => Place.Length > 0 ? $"{Row.PartnerCode} · {Place}" : Row.PartnerCode;
    public string CarrierText => Row.CarrierName is null ? "nincs" : OrdersFormat.CarrierShort(Row.CarrierName, Row.CarrierCode);
    public bool NoCarrier => Row.CarrierName is null;
    public string ItemsText => $"{Fmt.Int(Row.ItemCount)} db";
    public string LinesText => $"{Fmt.Int(Row.LineCount)} sor";
    public string CodText => Row.CodAmount > 0 ? Fmt.Money(Row.CodAmount) : "nincs";
    public bool NoCod => Row.CodAmount <= 0;
    public bool AvailOk => Row.Availability == "ok";
    public bool AvailShort => Row.Availability == "short";
    public string PickedText => Row.Status == "picking" && Row.Availability is null ? $"{Fmt.Int(Row.PickedCount)}/{Fmt.Int(Row.ItemCount)} kiszedve" : "";

    public string CardLine => string.Join(" · ", new[]
    {
        Row.PartnerCode, Place.Length > 0 ? Place : null, $"{Fmt.Int(Row.ItemCount)} db", CarrierText,
        Row.CodAmount > 0 ? $"utánvét {Fmt.Money(Row.CodAmount)}" : null, Age,
    }.Where((x) => x is not null));
}
