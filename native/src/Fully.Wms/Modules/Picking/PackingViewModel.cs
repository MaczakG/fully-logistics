using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Picking;

// The packing station: scan an order number or a product's code (the next order ready for packing
// that holds it), check the lines, give the parcel count and weight, then make the courier's label
// (POST /api/picking/orders/:id/pack mode=label) or type the tracking number of a label made on
// the courier's own site (mode=manual). On the desktop it is one window; opening it again with an
// order loads that order into it.
public sealed partial class PackingViewModel : PageViewModel
{
    PackingViewModel(ShellViewModel shell, int? waveId, int? orderId) : base(shell)
    {
        WaveId = waveId;
        pendingOrderId = orderId;
    }

    // Opens the packing station (the open one on the desktop), limited to a wave and with an order.
    public static Task OpenAsync(ShellViewModel shell, int? waveId, int? orderId)
    {
        if ((shell.Presenter as WindowPresenter)?.Records.Select((w) => w.Page).OfType<PackingViewModel>().FirstOrDefault() is { } open)
        {
            open.WaveId = waveId;
            open.pendingOrderId = orderId;
            return shell.NavigateAsync(open);
        }
        return shell.NavigateAsync(new PackingViewModel(shell, waveId, orderId));
    }

    int? pendingOrderId;

    public override string Title => "Csomagolóállomás";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => "packing";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWave))]
    public partial int? WaveId { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(QueueText), nameof(HasReady), nameof(HasPacked))]
    public partial PackingQueue? Queue { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasOrder), nameof(Booked), nameof(CanLabel), nameof(UseManual), nameof(ShowPackForm), nameof(IsPacked),
        nameof(MissingText), nameof(HasMissing), nameof(NotPackableText), nameof(BookedText), nameof(NoLabelText), nameof(PackedText), nameof(ShowUnpack),
        nameof(HasLabel), nameof(ShowBookedLabel), nameof(SubmitText), nameof(ToggleText), nameof(WeightHint), nameof(AddressText), nameof(CarrierText),
        nameof(HasCod), nameof(CodText), nameof(HasPickupPoint), nameof(HasNote), nameof(TrackingLabel), nameof(HasWaveLink), nameof(WaveLinkText))]
    public partial PackingOrder? Order { get; set; }

    // The tracking number typed by hand instead of the courier's API.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UseManual), nameof(SubmitText), nameof(ToggleText))]
    public partial bool Manual { get; set; }

    [ObservableProperty]
    public partial string? LabelError { get; set; }

    [ObservableProperty]
    public partial string PackageCount { get; set; } = "1";

    [ObservableProperty]
    public partial string Weight { get; set; } = "";

    [ObservableProperty]
    public partial string Tracking { get; set; } = "";

    [ObservableProperty]
    public partial string? PackageCountError { get; set; }

    [ObservableProperty]
    public partial string? WeightError { get; set; }

    [ObservableProperty]
    public partial string? TrackingError { get; set; }

    [ObservableProperty]
    public partial string Feedback { get; set; } = "";

    [ObservableProperty]
    public partial string FeedbackTone { get; set; } = "info";

    public bool CanEdit => Shell.Me?.Can("picking", "edit") == true;
    public bool HasWave => WaveId is not null;
    public bool HasReady => Queue is { Ready.Count: > 0 };
    public bool HasPacked => Queue is { Packed.Count: > 0 };

    public string QueueText => Queue is not { } q ? "" : $"{Fmt.Int(q.Ready.Count)} rendelés"
        + (q.StillPicking > 0 ? $", kiszedés alatt még {Fmt.Int(q.StillPicking)}" : "")
        + (q.Wave is { } w ? $" · {w.Number}" : "");

    public bool HasOrder => Order is not null;
    public bool Booked => Order is { Status: "picking", TrackingNumber.Length: > 0 };
    public bool CanLabel => Order is { Carrier.Configured: true } && !Booked;
    public bool UseManual => Manual || !CanLabel;
    public bool ShowPackForm => Order is { Status: "picking", AllPicked: true } && CanEdit;
    public bool IsPacked => Order?.Status == "packed";
    public bool HasLabel => Order?.Label is not null;
    public bool ShowBookedLabel => Booked && HasLabel;
    public bool ShowUnpack => IsPacked && CanEdit && Order?.PickupId is null;
    public string SubmitText => UseManual ? "Csomagolás lezárása" : "Címke készítése";
    public string ToggleText => UseManual ? "Címke a futár API-val" : "Kézi nyomkövetési szám";
    public string TrackingLabel => Order is { TrackingRequired: true } ? "Nyomkövetési szám" : "Nyomkövetési szám (nem kötelező)";
    public string? WeightHint => Order?.SuggestedWeightKg is { } kg ? $"A cikktörzs szerint {PickingFormat.Kg(kg)}" : null;

    public string? MissingText
    {
        get
        {
            if (Order is not { Status: "picking", AllPicked: false } o) return null;
            return $"Még nincs minden kiszedve: {string.Join(", ", o.Lines.Where((l) => !l.Done).Select((l) => $"{l.Sku} ({l.Qty - l.PickedQty} {l.UnitText})"))}.";
        }
    }

    public bool HasMissing => MissingText is not null;
    public bool HasWaveLink => HasMissing && Order?.Wave is not null;
    public string WaveLinkText => Order?.Wave is { } w ? $"Ugrás a(z) {w.Number} hullámra" : "";

    public string? NotPackableText => Order is { } o && o.Status is not ("picking" or "packed")
        ? $"Ez a rendelés nem csomagolható, az állapota: {Shell.Meta.Status("order", o.Status).Label}." : null;

    public string? BookedText => Booked
        ? $"A futárnál már van csomag ehhez a rendeléshez: {Order!.TrackingNumber}.{(HasLabel ? " A címkét lent újranyomtathatod." : "")} Zárd le a csomagolást." : null;

    public string? NoLabelText => ShowPackForm && !CanLabel && !Booked
        ? Order!.Carrier is { } c
            ? $"A(z) {PickingFormat.CarrierShort(c.Name, c.CarrierCode)} futár API még nincs beállítva, ezért a címkét a futár saját felületén készítsd el, és itt add meg a nyomkövetési számot."
            : "A rendeléshez nincs fuvarozó megadva."
        : null;

    public string? PackedText => Order is { Status: "packed" } o
        ? $"Becsomagolva {Fmt.DateTime(o.PackedAt)}: {Fmt.Int(o.PackageCount)} csomag{(o.WeightKg is > 0 and { } kg ? $", {PickingFormat.Kg(kg)}" : "")}"
          + (string.IsNullOrEmpty(o.TrackingNumber) ? "." : $", nyomkövetési szám: {o.TrackingNumber}.")
        : null;

    public string AddressText => Order is not { } o ? "" : string.Join(" ", new[] { o.Zip, o.City }.Where((x) => !string.IsNullOrEmpty(x)))
        + (string.IsNullOrEmpty(o.Address) ? "" : $", {o.Address}") + (o.Country is { Length: > 0 } c && c != "HU" ? $" ({c})" : "");

    public string CarrierText => Order is not { } o ? "" : (o.Carrier?.Name ?? "nincs megadva") + (string.IsNullOrEmpty(o.CarrierService) ? "" : $" · {o.CarrierService}");
    public bool HasCod => Order is { CodAmount: > 0 };
    public string CodText => Order is { } o ? $"Utánvét: {Fmt.Money(o.CodAmount)}" : "";
    public bool HasPickupPoint => !string.IsNullOrEmpty(Order?.PickupPointId);
    public bool HasNote => !string.IsNullOrEmpty(Order?.Note);

    // The view moves the focus to the tracking number (or the submit button) when an order opens.
    public event EventHandler? OrderOpened;

    // ------------------------------------------------------------------ loading

    public override async Task LoadAsync()
    {
        Queue = await Api.GetAsync<PackingQueue>(Query.Build("api/picking/packing", ("wave_id", WaveId)));
        if (pendingOrderId is { } id)
        {
            pendingOrderId = null;
            await ShowAsync(id);
        }
        else if (Order is { } o)
        {
            // Back from a dialog or the window brought to the front: the order as it is now.
            Order = await Api.GetAsync<PackingOrder>($"api/picking/orders/{o.Id}");
        }
    }

    async Task ShowAsync(int id)
    {
        try
        {
            Open(await Api.GetAsync<PackingOrder>($"api/picking/orders/{id}"));
            Say($"{Order!.Number}: {Order.CustomerName}. {(Order.Status == "picking" && Order.AllPicked ? "Ellenőrizd a tételeket, és csomagold be." : "")}".Trim(), "info");
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
    }

    void Open(PackingOrder o)
    {
        Manual = false;
        LabelError = null;
        PackageCountError = WeightError = TrackingError = null;
        Order = o;
        PackageCount = (o.PackageCount > 0 ? o.PackageCount : 1).ToString();
        Weight = o.WeightKg is { } w ? Fmt.Num(w) : o.SuggestedWeightKg is { } s ? Fmt.Num(s) : "";
        Tracking = o.TrackingNumber ?? "";
        OrderOpened?.Invoke(this, EventArgs.Empty);
    }

    void Say(string text, string tone)
    {
        Feedback = text;
        FeedbackTone = tone;
        var haptic = tone switch { "ok" => HapticKind.Success, "danger" => HapticKind.Error, _ => (HapticKind?)null };
        if (haptic is { } h) Shell.Services.Platform.Haptic(h);
    }

    // ------------------------------------------------------------------ actions

    [RelayCommand]
    Task ScanAsync(string code) => RunAsync(async () =>
    {
        try
        {
            Open(await Api.GetAsync<PackingOrder>(Query.Build("api/picking/packing/lookup", ("code", code.Trim()), ("wave_id", WaveId))));
            Say($"{Order!.Number}: {Order.CustomerName}.", "ok");
        }
        catch (ApiException e) when (e.Status is 400 or 404)
        {
            Say(e.Message, "danger");
        }
    });

    [RelayCommand]
    Task OpenOrderAsync(int id) => RunAsync(() => ShowAsync(id));

    [RelayCommand]
    void ToggleManual()
    {
        Manual = !Manual;
        LabelError = null;
        OrderOpened?.Invoke(this, EventArgs.Empty);
    }

    [RelayCommand]
    void Next()
    {
        Order = null;
        Say("Olvasd be a következő rendelést.", "info");
        OrderOpened?.Invoke(this, EventArgs.Empty);
    }

    [RelayCommand]
    Task AllWavesAsync()
    {
        WaveId = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task WaveAsync() => Order?.Wave is { } w ? Shell.NavigateAsync(new WaveViewModel(Shell, w.Id)) : Task.CompletedTask;

    [RelayCommand]
    Task PackAsync() => RunAsync(async () =>
    {
        if (Order is not { } o) return;
        PackageCountError = WeightError = TrackingError = null;
        var mode = UseManual ? "manual" : "label";
        var count = int.TryParse(PackageCount.Trim(), out var n) ? n : 0;
        if (count is < 1 or > 99) PackageCountError = "1 és 99 között adj meg számot.";
        decimal? weight = null;
        if (Weight.Trim().Length > 0)
        {
            weight = Fmt.ParseNumber(Weight);
            if (weight is not >= 0) WeightError = "Nem negatív számot adj meg.";
        }
        if (mode == "manual" && o.TrackingRequired && Tracking.Trim().Length == 0) TrackingError = "Add meg a nyomkövetési számot.";
        if (PackageCountError is not null || WeightError is not null || TrackingError is not null) return;
        try
        {
            var r = await Api.PostAsync<PackingOrder>($"api/picking/orders/{o.Id}/pack",
                new Dictionary<string, object?> { ["mode"] = mode, ["package_count"] = count, ["weight_kg"] = weight, ["tracking_number"] = mode == "manual" ? Tracking.Trim() : "" });
            Manual = false;
            LabelError = null;
            Order = r;
            Say($"{r.Number} becsomagolva.{(r.WaveCompleted ? " A hullám minden rendelése kész, a hullám lezárult." : "")}{(string.IsNullOrEmpty(r.Warning) ? "" : $" {r.Warning}")}",
                string.IsNullOrEmpty(r.Warning) ? "ok" : "danger");
            Queue = await Api.GetAsync<PackingQueue>(Query.Build("api/picking/packing", ("wave_id", WaveId)));
            if (r.Label is { } label) await OpenDocumentAsync(label.Id);
        }
        catch (ApiException e) when (mode == "label" && e.Status is 409 or 400)
        {
            // The courier refused, is not set up or did not answer: reload the order (the tracking
            // number may already be saved) and offer the manual tracking number.
            try { Order = await Api.GetAsync<PackingOrder>($"api/picking/orders/{o.Id}"); } catch (ApiException) { /* keep the old copy */ }
            LabelError = e.Message;
            Manual = true;
            Say(e.Message, "danger");
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            PackageCountError = e.Fields.GetValueOrDefault("package_count");
            WeightError = e.Fields.GetValueOrDefault("weight_kg");
            TrackingError = e.Fields.GetValueOrDefault("tracking_number");
            Say(e.Message, "danger");
        }
    });

    [RelayCommand]
    Task UnpackAsync() => Order is not { } o ? Task.CompletedTask : Shell.NavigateAsync(new UnpackViewModel(Shell, o, (r) =>
    {
        Open(r);
        Say("Csomagolás visszavonva.", "info");
    }));

    [RelayCommand]
    Task LabelAsync() => Order?.Label is { } l ? RunAsync(() => OpenDocumentAsync(l.Id)) : Task.CompletedTask;

    [RelayCommand]
    Task PackedLabelAsync(PackedOrder o) => o.LabelDocumentId is { } id ? RunAsync(() => OpenDocumentAsync(id)) : Task.CompletedTask;

    async Task OpenDocumentAsync(int id) => await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/documents/{id}"));
}
