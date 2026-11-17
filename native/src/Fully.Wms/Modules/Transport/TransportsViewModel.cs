using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Transport;

// Raklapos fuvarok (GET /api/transport/transports): pallet and truck transports for the clients,
// from the request to the delivery; status, direction, client, days and search.
public sealed partial class TransportsViewModel(ShellViewModel shell) : ListPageViewModel<TransportRowItem>(shell)
{
    public override string Title => "Fuvarszervezés";
    public override string? Module => "transport";

    public static readonly IReadOnlyList<OrderChoice> StatusChoices =
    [
        new("active", "Aktív"), new("all", "Mind"), new("requested", "Ajánlatkérés"), new("booked", "Lefoglalva"),
        new("in_transit", "Úton"), new("delivered", "Leszállítva"), new("cancelled", "Törölve"),
    ];

    public static readonly IReadOnlyList<OrderChoice> DirectionChoices = [new(null, "Mind"), new("out", "Kimenő"), new("in", "Beérkező")];

    [ObservableProperty] public partial OrderChoice Status { get; set; } = StatusChoices[0];
    [ObservableProperty] public partial OrderChoice Direction { get; set; } = DirectionChoices[0];
    [ObservableProperty] public partial List<OrderChoice> Clients { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Client { get; set; }
    [ObservableProperty] public partial DateTime? From { get; set; }
    [ObservableProperty] public partial DateTime? To { get; set; }
    [ObservableProperty] public partial TransportRowItem? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("transport", "create") == true;
    public string EmptyText => Status.Key == "active" && !Filtered ? "Nincs aktív fuvar." : "Nincs a szűrésnek megfelelő fuvar.";
    bool Filtered => Search.Trim().Length > 0 || From is not null || To is not null || Client?.Key is not null || Direction.Key is not null;

    bool quiet;

    partial void OnStatusChanged(OrderChoice value) => Reload();
    partial void OnDirectionChanged(OrderChoice value) => Reload();
    partial void OnClientChanged(OrderChoice? value) => Reload();
    partial void OnFromChanged(DateTime? value) => Reload();
    partial void OnToChanged(DateTime? value) => Reload();

    void Reload()
    {
        OnPropertyChanged(nameof(EmptyText));
        if (!Loaded || quiet) return;
        _ = ReloadAsync();
    }

    partial void OnSelectedChanged(TransportRowItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new TransportFormViewModel(Shell, value.Row.Id));
    }

    protected override string ListPath() => Query.Build("api/transport/transports",
        ("status", Status.Key), ("direction", Direction.Key), ("partner_id", Client?.Key), ("from", From?.ToString("yyyy-MM-dd")),
        ("to", To?.ToString("yyyy-MM-dd")), ("q", Search.Trim()));

    protected override async Task<(IReadOnlyList<TransportRowItem> Items, int Total)> FetchAsync(int offset)
    {
        if (Clients.Count == 0)
        {
            var clients = await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1");
            quiet = true;
            Clients = [new(null, "Minden ügyfél"), .. clients.Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
            Client = Clients[0];
            quiet = false;
        }
        var page = await Api.GetAsync<Paged<TransportRow>>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        return (page.Items.Select((r) => new TransportRowItem(r)).ToList(), page.Total);
    }

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new TransportFormViewModel(Shell, null));

    [RelayCommand]
    Task BoardAsync() => Shell.ReplaceAsync(new TransportBoardViewModel(Shell));

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        quiet = true;
        Search = "";
        From = To = null;
        Status = StatusChoices[0];
        Direction = DirectionChoices[0];
        Client = Clients.FirstOrDefault();
        quiet = false;
        OnPropertyChanged(nameof(EmptyText));
        return ReloadAsync();
    }
}

public sealed class TransportRowItem(TransportRow r)
{
    public TransportRow Row { get; } = r;
    public string DateText => Fmt.Date(Row.Date);
    public string WindowText => TransportFormat.Window(Row.TimeFrom, Row.TimeTo);
    public string DirectionText => TransportFormat.Directions.GetValueOrDefault(Row.Direction, Row.Direction);
    public bool IsIn => Row.Direction == "in";
    public string ClientText => Row.PartnerCode ?? "nincs";
    public bool NoClient => Row.PartnerCode is null;
    public string From => string.IsNullOrEmpty(Row.Origin) ? "?" : Row.Origin;
    public string ToText => $"→ {(string.IsNullOrEmpty(Row.Destination) ? "?" : Row.Destination)}";
    public string Pallets => $"{Fmt.Int(Row.Pallets)} rkl";
    public string Weight => TransportFormat.Kg(Row.WeightKg);
    public string CarrierText => Row.CarrierShort ?? "nincs";
    public bool NoCarrier => Row.CarrierShort is null;
    public string CarrierSub => !string.IsNullOrEmpty(Row.CarrierRef) ? Row.CarrierRef : Row.Vehicle ?? "";
    public string PriceText => Row.Price is { } p ? Fmt.Money(p) : "";

    // The phone's card: day and window, client, load, carrier.
    public string CardLine => string.Join(" · ", new[]
    {
        $"{DateText} {WindowText}".Trim(), DirectionText, Row.PartnerCode, Pallets, Weight, Row.CarrierShort,
    }.Where((s) => !string.IsNullOrEmpty(s)));
    public string Route => $"{From} {ToText}";
}
