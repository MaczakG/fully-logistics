using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Transport;

// One carrier pickup (GET /api/transport/pickups/:id): the manifest. At the ramp the parcels are
// scanned onto it (label or order number), the waiting packed orders of the carrier can be added
// in bulk; closing it ships every order on it. Printed as the handover sheet with signatures.
public sealed partial class PickupViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    public int Id { get; } = id;
    public override string Title => Data is { } p ? $"Futárátvétel {p.Number}" : "Futárátvétel";
    public override string? Module => "transport";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"pickup:{Id}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Lead), nameof(IsOpen), nameof(Editable), nameof(CanArrive), nameof(CanDelete), nameof(CanClose),
        nameof(Status), nameof(OrdersText), nameof(PackagesText), nameof(WeightText), nameof(CodText), nameof(CodHint), nameof(NotPackedText),
        nameof(NoTrackingText), nameof(ClosedText), nameof(ArrivedText), nameof(Manifest), nameof(HasManifest), nameof(ManifestEmpty),
        nameof(ManifestCount), nameof(Waiting), nameof(ShowWaiting), nameof(WaitingLead), nameof(AddAllText), nameof(TotalsText))]
    public partial PickupDetail? Data { get; set; }

    [ObservableProperty]
    public partial string Feedback { get; set; } = "";

    [ObservableProperty]
    public partial string FeedbackTone { get; set; } = "info";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AddSelectedText))]
    [NotifyCanExecuteChangedFor(nameof(AddSelectedCommand))]
    public partial int SelectedCount { get; set; }

    public string? Status => Data?.Status;
    public bool IsOpen => Data is { } p && TransportBoardViewModel.IsOpen(p.Status);
    bool Can(string action) => Shell.Me?.Can("transport", action) == true;
    public bool Editable => IsOpen && Can("edit");
    public bool CanArrive => Data?.Status == "planned" && Can("edit");
    public bool CanDelete => Data?.Status == "planned" && Can("delete");
    public bool CanClose => IsOpen && Can("approve") && Data!.Orders.Count > 0;

    public string Lead => Data is { } p
        ? $"{p.CarrierName}, {TransportFormat.DateLong(p.Date)}{(TransportFormat.Window(p.WindowFrom, p.WindowTo) is { Length: > 0 } w ? $", {w}" : "")}"
        : "";

    public string OrdersText => Fmt.Int(Data?.Totals.Orders ?? 0);
    public string PackagesText => Fmt.Int(Data?.Totals.Packages ?? 0);
    public string WeightText => TransportFormat.Kg(Data?.Totals.WeightKg ?? 0);
    public string CodText => TransportFormat.Cod(Data?.Totals.Cod);
    public string CodHint => $"{Fmt.Int(Data?.Totals.CodOrders ?? 0)} utánvétes";
    public string TotalsText => Data is { } p
        ? $"Összesen: {Fmt.Int(p.Totals.Packages)} csomag, {TransportFormat.Kg(p.Totals.WeightKg)}, utánvét {TransportFormat.Cod(p.Totals.Cod)}"
        : "";

    // Only while open: on a closed manifest the orders have since been delivered or returned.
    public string? NotPackedText => IsOpen && Data is { Problems.NotPacked.Count: > 0 } p
        ? $"Nem feladásra kész rendelés a manifeszten: {string.Join(", ", p.Problems.NotPacked)}. Vedd le őket, különben a manifeszt nem zárható le."
        : null;
    public string? NoTrackingText => IsOpen && Data!.Problems.NoTracking > 0
        ? $"{Fmt.Int(Data.Problems.NoTracking)} rendelésnek nincs nyomkövetési száma. Lezárható így is, de a webshop nem kap követési linket."
        : null;
    public string? ClosedText => Data is { Status: "closed" } p
        ? $"Lezárva {Fmt.DateTime(p.ClosedAt)}{(string.IsNullOrEmpty(p.ClosedByName) ? "" : $", {p.ClosedByName}")}, manifesztszám: {p.ManifestNumber ?? p.Number}. A rendelések feladva, a nyomkövetési számokat visszaküldjük a webshopoknak."
        : null;
    public string? ArrivedText => Data is { Status: "arrived" } p
        ? $"A futár {TransportFormat.Time(p.ArrivedAt)} óta a rámpán. Olvasd be az átadott csomagokat, majd zárd le a manifesztet."
        : null;

    public IReadOnlyList<ManifestRow> Manifest => Data?.Orders.Select((o, i) => new ManifestRow(this, o, i + 1, Editable)).ToList() ?? [];
    public bool HasManifest => Data is { Orders.Count: > 0 };
    public string ManifestEmpty => Editable
        ? "Még nincs rendelés a manifeszten. Olvasd be a csomagokat, vagy add hozzá a várakozókat lent."
        : "Nincs rendelés a manifeszten.";
    public string ManifestCount => $"{Fmt.Int(Data?.Orders.Count ?? 0)} rendelés";

    public IReadOnlyList<WaitingRow> Waiting { get; private set; } = [];
    public bool ShowWaiting => Editable && Waiting.Count > 0;
    public string WaitingLead => Data is { } p ? $"{Fmt.Int(p.Waiting.Count)} csomagolt {p.CarrierShort} rendelés, még nincs átvételen" : "";
    public string AddAllText => $"Mind hozzáadása ({Fmt.Int(Data?.Waiting.Count ?? 0)})";
    public string AddSelectedText => SelectedCount > 0 ? $"Kijelöltek hozzáadása ({Fmt.Int(SelectedCount)})" : "Kijelöltek hozzáadása";

    // The scan field takes the focus after every answer (desktop: a hand scanner keeps working).
    public event EventHandler? ScanFocus;

    public override async Task LoadAsync() => Show(await Api.GetAsync<PickupDetail>($"api/transport/pickups/{Id}"));

    void Show(PickupDetail p)
    {
        Waiting = p.Waiting.Select((o) => new WaitingRow(this, o)).ToList();
        SelectedCount = 0;
        Data = p;
    }

    internal void OnSelection() => SelectedCount = Waiting.Count((w) => w.IsSelected);

    void Say(string text, string tone)
    {
        Feedback = text;
        FeedbackTone = tone;
        var haptic = tone switch { "ok" => HapticKind.Success, "danger" => HapticKind.Error, _ => (HapticKind?)null };
        if (haptic is { } h) Shell.Services.Platform.Haptic(h);
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    // Scans one after the other: a fast scanner must not overtake the previous answer.
    readonly SemaphoreSlim serial = new(1, 1);

    [RelayCommand]
    async Task ScanAsync(string code)
    {
        await serial.WaitAsync();
        try
        {
            await RunAsync(async () =>
            {
                try
                {
                    var res = await Api.PostAsync<PickupScanned>($"api/transport/pickups/{Id}/scan", new { code = code.Trim() });
                    Show(res.Pickup);
                    Say(res.Message, res.Already ? "info" : "ok");
                }
                catch (ApiException e) when (e.Status is 400 or 404 or 409)
                {
                    Say(e.Message, "danger");
                }
            });
        }
        finally
        {
            serial.Release();
        }
    }

    Task AssignAsync(object body) => RunAsync(async () =>
    {
        var res = await Api.PostAsync<PickupAssigned>($"api/transport/pickups/{Id}/orders", body);
        Show(res.Pickup);
        Say($"{Fmt.Int(res.Assigned)} rendelés hozzáadva a manifeszthez.", "ok");
    });

    [RelayCommand(CanExecute = nameof(HasSelection))]
    Task AddSelectedAsync() => AssignAsync(new { order_ids = Waiting.Where((w) => w.IsSelected).Select((w) => w.Order.Id).ToList() });

    bool HasSelection() => SelectedCount > 0;

    [RelayCommand]
    Task AddAllAsync() => AssignAsync(new { all = true });

    [RelayCommand]
    void SelectAll()
    {
        var all = Waiting.Any((w) => !w.IsSelected);
        foreach (var w in Waiting) w.IsSelected = all;
    }

    internal Task RemoveAsync(ManifestOrder o) => RunAsync(async () =>
    {
        Show(await Api.DeleteAsync<PickupDetail>($"api/transport/pickups/{Id}/orders/{o.Id}"));
        Say($"{o.Number} levéve a manifesztről.", "info");
    });

    [RelayCommand]
    Task ArrivedAsync() => RunAsync(async () =>
    {
        Show(await Api.PostAsync<PickupDetail>($"api/transport/pickups/{Id}/arrived", new { }));
        Shell.Toast("A futár megérkezett.", ToastKind.Success);
        ScanFocus?.Invoke(this, EventArgs.Empty);
    });

    [RelayCommand]
    Task EditAsync() => Data is { } p ? Shell.NavigateAsync(new PickupFormViewModel(Shell, p, null, p.Date)) : Task.CompletedTask;

    [RelayCommand]
    Task CloseManifestAsync() => Data is { } p ? Shell.NavigateAsync(new PickupCloseViewModel(Shell, p)) : Task.CompletedTask;

    [RelayCommand]
    Task PrintAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(PickupManifest.Build(await Api.GetAsync<PickupDetail>($"api/transport/pickups/{Id}"))));

    [RelayCommand]
    Task CsvAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/transport/pickups/{Id}/manifest.csv")));

    [RelayCommand]
    async Task DeleteAsync()
    {
        if (Data is not { } p) return;
        if (!await Shell.ConfirmAsync("Futárátvétel törlése", $"Törlöd a(z) {p.Number} átvételt? A {Fmt.Int(p.Orders.Count)} rendelése újra feladásra vár.", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/transport/pickups/{Id}");
            Shell.Toast($"{p.Number} törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }

    [RelayCommand]
    Task OpenOrderAsync(int orderId) => Shell.NavigateAsync(new Orders.OrderViewModel(Shell, orderId));
}

// An order on the manifest.
public sealed class ManifestRow(PickupViewModel page, ManifestOrder o, int index, bool editable)
{
    public ManifestOrder Order { get; } = o;
    public string Index { get; } = index.ToString();
    public string Recipient => Order.CustomerName + (string.IsNullOrEmpty(Order.Company) ? "" : $", {Order.Company}");
    public string Place => string.IsNullOrEmpty(Order.PickupPointId) ? $"{Order.Zip} {Order.City}".Trim() : $"Átvételi pont: {Order.PickupPointId}";
    public bool HasTracking => !string.IsNullOrEmpty(Order.TrackingNumber);
    public string Packages => Fmt.Int(Order.PackageCount);
    public string Weight => TransportFormat.Kg(Order.WeightKg);
    public string Cod => Order.CodAmount != 0 ? TransportFormat.Cod(new() { [Order.Currency ?? "HUF"] = Order.CodAmount }) : "";
    public bool NotReady => Order.Status is not ("packed" or "shipped");
    public bool CanRemove => editable && Order.Status != "shipped";

    public RelayCommand RemoveCommand => new(() => _ = page.RemoveAsync(Order));
}

// A packed order of the carrier waiting for a pickup.
public sealed partial class WaitingRow(PickupViewModel page, ManifestOrder o) : ObservableObject
{
    public ManifestOrder Order { get; } = o;
    public string Place => $"{Order.Zip} {Order.City}".Trim();
    public string Packages => Fmt.Int(Order.PackageCount);
    public string Cod => Order.CodAmount != 0 ? TransportFormat.Cod(new() { [Order.Currency ?? "HUF"] = Order.CodAmount }) : "";
    public string Tracking => string.IsNullOrEmpty(Order.TrackingNumber) ? "nincs" : Order.TrackingNumber;
    public string PackedAt => Fmt.DateTime(Order.PackedAt);

    [ObservableProperty]
    public partial bool IsSelected { get; set; }

    partial void OnIsSelectedChanged(bool value) => page.OnSelection();
}
