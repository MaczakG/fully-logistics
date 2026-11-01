using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Transport;

// Futárátvételek (GET /api/transport/board): the day's board per carrier: packed orders waiting
// for a pickup, the pickups of the day with what is on them, COD; a day back and forth.
public sealed partial class TransportBoardViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Fuvarszervezés";
    public override string? Module => "transport";

    static readonly string[] Open = ["planned", "arrived"];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Cards), nameof(HasCards), nameof(DayLabel), nameof(IsToday), nameof(WaitingOrders), nameof(WaitingHint),
        nameof(AssignedOrders), nameof(AssignedHint), nameof(PickupCount), nameof(CodText), nameof(CodHint), nameof(NoCarrierText))]
    public partial TransportBoard? Data { get; set; }

    // The day shown (yyyy-MM-dd); the picker's value follows it.
    [ObservableProperty]
    public partial string Date { get; set; } = TransportFormat.Today;

    [ObservableProperty]
    public partial DateTime? DateValue { get; set; }

    public bool CanCreate => Shell.Me?.Can("transport", "create") == true;
    bool CanEdit => Shell.Me?.Can("transport", "edit") == true;

    public IReadOnlyList<CarrierCard> Cards => Data?.Carriers.Select((c) => new CarrierCard(this, c, CanCreate, CanEdit)).ToList() ?? [];
    public bool HasCards => Data is { Carriers.Count: > 0 };
    public bool IsToday => Data is not null && Date == Data.Today;
    public string DayLabel => TransportFormat.DateLong(Date) + (IsToday ? ", ma" : "");

    public int WaitingOrders => Data?.Totals.Waiting.Orders ?? 0;
    public string WaitingHint => $"{Fmt.Int(Data?.Totals.Waiting.Packages ?? 0)} csomag, minden fuvarozó";
    public int AssignedOrders => Data?.Totals.Assigned.Orders ?? 0;
    public string AssignedHint => $"{Fmt.Int(Data?.Totals.Assigned.Packages ?? 0)} csomag erre a napra";
    public int PickupCount => Data?.Totals.Pickups ?? 0;
    public string CodText => TransportFormat.Cod(Data?.Totals.Assigned.Cod);
    public string CodHint => $"{Fmt.Int(Data?.Totals.Assigned.CodOrders ?? 0)} utánvétes rendelés";

    public string? NoCarrierText => Data is { NoCarrier.Orders: > 0 } d
        ? $"{Fmt.Int(d.NoCarrier.Orders)} feladásra kész rendelésnek nincs fuvarozója, ezért egyik átvételhez sem rendelhető. Állítsd be a fuvarozót a Megrendeléseknél."
        : null;

    bool quiet;

    public override async Task LoadAsync()
    {
        Data = await Api.GetAsync<TransportBoard>(Query.Build("api/transport/board", ("date", Date)));
        quiet = true;
        DateValue = DateTime.ParseExact(Date, "yyyy-MM-dd", null);
        quiet = false;
    }

    partial void OnDateValueChanged(DateTime? value)
    {
        if (quiet || value is null) return;
        var d = value.Value.ToString("yyyy-MM-dd");
        if (d == Date) return;
        Date = d;
        _ = ReloadAsync();
    }

    [RelayCommand]
    Task DayAsync(string delta)
    {
        Date = DateTime.ParseExact(Date, "yyyy-MM-dd", null).AddDays(int.Parse(delta)).ToString("yyyy-MM-dd");
        return ReloadAsync();
    }

    [RelayCommand]
    Task TodayAsync()
    {
        Date = TransportFormat.Today;
        return ReloadAsync();
    }

    // A new pickup: for the day shown (today when it is in the past), of a carrier if chosen.
    internal Task NewPickupAsync(int? carrierId)
    {
        var today = Data?.Today ?? TransportFormat.Today;
        return Shell.NavigateAsync(new PickupFormViewModel(Shell, null, carrierId, string.CompareOrdinal(Date, today) < 0 ? today : Date));
    }

    [RelayCommand]
    Task NewAsync() => NewPickupAsync(null);

    internal Task OpenPickupAsync(int id) => Shell.NavigateAsync(new PickupViewModel(Shell, id));

    internal Task AssignAllAsync(BoardPickup p) => RunAsync(async () =>
    {
        var res = await Api.PostAsync<PickupAssigned>($"api/transport/pickups/{p.Id}/orders", new { all = true });
        Shell.Toast($"{Fmt.Int(res.Assigned)} rendelés a(z) {res.Pickup.Number} átvételhez rendelve.", ToastKind.Success);
        await LoadAsync();
    });

    [RelayCommand]
    Task TransportsAsync() => Shell.ReplaceAsync(new TransportsViewModel(Shell));

    internal static bool IsOpen(string status) => Open.Contains(status);
}

// A carrier on the board.
public sealed class CarrierCard(TransportBoardViewModel page, BoardCarrier c, bool canCreate, bool canEdit)
{
    public BoardCarrier Carrier { get; } = c;
    public string Label { get; } = TransportFormat.CarrierLabel(c.CarrierCode);
    public bool HasLabel => Label.Length > 0;
    public bool IsActive => Carrier.Waiting.Orders > 0 || Carrier.Pickups.Count > 0;
    public string WaitingText => Fmt.Int(Carrier.Waiting.Orders);
    public string WaitingSub => Carrier.Waiting.Orders > 0
        ? $"{Fmt.Int(Carrier.Waiting.Packages)} csomag{(Carrier.Waiting.CodOrders > 0 ? $", utánvét {TransportFormat.Cod(Carrier.Waiting.Cod)}" : "")}" : "nincs";
    public string AssignedText => Fmt.Int(Carrier.Assigned.Orders);
    public string AssignedSub => Carrier.Assigned.Orders > 0 ? $"{Fmt.Int(Carrier.Assigned.Packages)} csomag" : "erre a napra";
    public string CodText => TransportFormat.Cod(Carrier.Assigned.Cod);
    public string CodSub => $"{Fmt.Int(Carrier.Assigned.CodOrders)} utánvétes";
    public IReadOnlyList<BoardPickupItem> Pickups { get; } = c.Pickups.Select((p) => new BoardPickupItem(page, p, c, canEdit)).ToList();
    public bool HasPickups => Pickups.Count > 0;
    public bool CanNew => canCreate && Carrier.Status == "active";

    public RelayCommand NewCommand => new(() => _ = page.NewPickupAsync(Carrier.Id));
}

public sealed class BoardPickupItem(TransportBoardViewModel page, BoardPickup p, BoardCarrier c, bool canEdit)
{
    public BoardPickup Pickup { get; } = p;
    public string Sub => $"{(TransportFormat.Window(Pickup.WindowFrom, Pickup.WindowTo) is { Length: > 0 } w ? w : "nincs időablak")} · {Fmt.Int(Pickup.Totals.Orders)} rendelés"
        + (string.IsNullOrEmpty(Pickup.ManifestNumber) || Pickup.ManifestNumber == Pickup.Number ? "" : $" · {Pickup.ManifestNumber}");
    public bool CanAssignAll => TransportBoardViewModel.IsOpen(Pickup.Status) && canEdit && c.Waiting.Orders > 0;
    public string AssignText => $"Mind hozzá ({Fmt.Int(c.Waiting.Orders)})";
    public string OpenText => TransportBoardViewModel.IsOpen(Pickup.Status) ? "Manifeszt" : "Megnyitás";

    public RelayCommand AssignAllCommand => new(() => _ = page.AssignAllAsync(Pickup));
    public RelayCommand OpenCommand => new(() => _ = page.OpenPickupAsync(Pickup.Id));
}
