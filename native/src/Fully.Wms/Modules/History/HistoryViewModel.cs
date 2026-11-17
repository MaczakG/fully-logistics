using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.History;

// GET /api/history: shipped, delivered, returned and cancelled orders; search (tracking number
// too), dates on shipping or arrival with quick ranges, client, carrier, status; CSV export.
public sealed partial class HistoryViewModel(ShellViewModel shell) : ListPageViewModel<HistoryRowItem>(shell)
{
    public override string Title => "Rendeléstörténet";
    public override string? Module => "history";

    public static readonly IReadOnlyList<OrderChoice> DateFields = [new("shipped", "Feladás napja"), new("created", "Beérkezés napja")];

    [ObservableProperty]
    public partial HistoryKpis? Kpis { get; set; }

    [ObservableProperty]
    public partial List<OrderChoice> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<OrderChoice> Carriers { get; set; } = [];

    [ObservableProperty]
    public partial List<OrderChoice> Statuses { get; set; } = [];

    [ObservableProperty]
    public partial OrderChoice? Client { get; set; }

    [ObservableProperty]
    public partial OrderChoice? Carrier { get; set; }

    [ObservableProperty]
    public partial OrderChoice? Status { get; set; }

    [ObservableProperty]
    public partial OrderChoice DateField { get; set; } = DateFields[0];

    [ObservableProperty]
    public partial DateTime? From { get; set; }

    [ObservableProperty]
    public partial DateTime? To { get; set; }

    [ObservableProperty]
    public partial HistoryRowItem? Selected { get; set; }

    bool quiet;

    bool Filtered => Search.Trim().Length > 0 || From is not null || To is not null || Client?.Key is not null || Carrier?.Key is not null || Status?.Key is not null;
    public string EmptyText => Filtered ? "Nincs a szűrésnek megfelelő rendelés." : "Még nincs lezárt rendelés.";

    partial void OnClientChanged(OrderChoice? value) => Reload();
    partial void OnCarrierChanged(OrderChoice? value) => Reload();
    partial void OnStatusChanged(OrderChoice? value) => Reload();
    partial void OnDateFieldChanged(OrderChoice value) => Reload();
    partial void OnFromChanged(DateTime? value) => Reload();
    partial void OnToChanged(DateTime? value) => Reload();

    void Reload()
    {
        OnPropertyChanged(nameof(EmptyText));
        if (!Loaded || quiet) return;
        if (From is { } f && To is { } t && f > t)
        {
            Shell.Toast("A kezdő dátum nem lehet későbbi a záró dátumnál.", ToastKind.Error);
            return;
        }
        _ = ReloadAsync();
    }

    partial void OnSelectedChanged(HistoryRowItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new OrderViewModel(Shell, value.Row.Id));
    }

    // The filters without paging (the list and the export share them).
    string FilterPath(string path) => Query.Build(path,
        ("status", Status?.Key), ("q", Search.Trim()), ("date_field", DateField.Key), ("from", From?.ToString("yyyy-MM-dd")),
        ("to", To?.ToString("yyyy-MM-dd")), ("partner_id", Client?.Key), ("carrier_id", Carrier?.Key));

    protected override string ListPath() => FilterPath("api/history");

    protected override async Task<(IReadOnlyList<HistoryRowItem> Items, int Total)> FetchAsync(int offset)
    {
        if (Clients.Count == 0)
        {
            var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
            var carriers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier");
            quiet = true;
            Clients = [new(null, "Minden ügyfél"), .. (await clients).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
            Carriers = [new(null, "Minden fuvarozó"), .. (await carriers).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
            Statuses = [new(null, "Minden állapot"), .. new[] { "shipped", "delivered", "returned", "cancelled" }.Select((s) => new OrderChoice(s, Shell.Meta.Status("order", s).Label))];
            Client = Clients[0];
            Carrier = Carriers[0];
            Status = Statuses[0];
            quiet = false;
        }
        var page = await Api.GetAsync<HistoryPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Kpis = page.Kpis;
        return (page.Items.Select((r) => new HistoryRowItem(r)).ToList(), page.Total);
    }

    // The key figures open their status.
    [RelayCommand]
    void Show(string status) => Status = Statuses.FirstOrDefault((s) => s.Key == status) ?? Status;

    // Ma, 7 nap, 30 nap: up to today.
    [RelayCommand]
    Task RangeAsync(string days)
    {
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).Date;
        quiet = true;
        To = today;
        From = today.AddDays(-int.Parse(days));
        quiet = false;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        quiet = true;
        Search = "";
        From = To = null;
        DateField = DateFields[0];
        Client = Clients.FirstOrDefault();
        Carrier = Carriers.FirstOrDefault();
        Status = Statuses.FirstOrDefault();
        quiet = false;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ExportAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(FilterPath("api/history/export"))));
}

public sealed class HistoryRowItem(HistoryRow row)
{
    public HistoryRow Row { get; } = row;
    public string Place => string.Join(" ", new[] { Row.Zip, Row.City }.Where((x) => !string.IsNullOrEmpty(x)));
    public string PartnerPlace => Place.Length > 0 ? $"{Row.PartnerCode} · {Place}" : Row.PartnerCode;
    public string CarrierText => OrdersFormat.CarrierShort(Row.CarrierName, Row.CarrierCode);
    public string ItemsText => Fmt.Int(Row.ItemCount);
    public string CodText => Row.CodAmount > 0 ? Fmt.Money(Row.CodAmount) : "";
    public string ShippedText => Row.ShippedDate is { Length: > 0 } d ? Fmt.Date(d) : "nem";
    public bool NotShipped => string.IsNullOrEmpty(Row.ShippedDate);
    public string ShippedSub => Row.DeliveredAt is { } da ? $"Kézbesítve {Fmt.Date(da)}" : Row.CancelledAt is { } ca ? $"Sztornó {Fmt.Date(ca)}" : "";
    public string ReturnsText => Row.ReturnCount > 0 ? $"{Fmt.Int(Row.ReturnCount)} visszáru" : "";

    public string CardLine => string.Join(" · ", new[]
    {
        PartnerPlace, CarrierText.Length > 0 ? CarrierText : null, Row.TrackingNumber is { Length: > 0 } t ? t : null,
        Row.ShippedDate is { Length: > 0 } d ? $"feladva {Fmt.Date(d)}" : null, ReturnsText.Length > 0 ? ReturnsText : null,
    }.Where((x) => x is not null));
}
