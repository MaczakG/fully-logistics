using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Picking;

// The smaller steps of picking and packing as dialogs (the web app's dialogs): new wave, picker,
// shortage, cancelling a wave, undoing a packing.

// A choice of a select; Key null is "Mind" or "nincs".
public sealed record Choice(string? Key, string Label)
{
    public int? Id => int.TryParse(Key, out var n) ? n : null;
}

// POST /api/picking/waves. The wave is made of the new orders whose every line is in stock:
// express first, then the oldest; the preview shows which ones before starting.
public sealed partial class NewWaveViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Új hullám";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 720;

    public static readonly IReadOnlyList<Choice> Priorities = [new(null, "Mind"), new("express", "Csak expressz"), new("normal", "Csak normál")];

    [ObservableProperty]
    public partial List<Choice> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<Choice> Carriers { get; set; } = [];

    [ObservableProperty]
    public partial List<Choice> Users { get; set; } = [];

    [ObservableProperty]
    public partial Choice? Client { get; set; }

    [ObservableProperty]
    public partial Choice? Carrier { get; set; }

    [ObservableProperty]
    public partial Choice? Priority { get; set; } = Priorities[0];

    [ObservableProperty]
    public partial Choice? Picker { get; set; }

    [ObservableProperty]
    public partial string Max { get; set; } = "30";

    // The orders the wave would take, and the preview text (info, warn or danger).
    [ObservableProperty]
    public partial string Preview { get; set; } = "Rendelések keresése...";

    [ObservableProperty]
    public partial string PreviewNumbers { get; set; } = "";

    [ObservableProperty]
    public partial string PreviewTone { get; set; } = "info";

    [ObservableProperty]
    public partial string? Error { get; set; }

    List<OrderCandidate> candidates = [];
    int previewSeq;

    public override async Task LoadAsync()
    {
        if (Users.Count == 0)
        {
            var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
            var carriers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier");
            var users = Api.GetAsync<ItemList<UserLookup>>("api/lookup/users");
            Clients = [new(null, "Mind"), .. (await clients).Items.Select((p) => new Choice(p.Id.ToString(), p.Name))];
            Carriers = [new(null, "Mind"), .. (await carriers).Items.Select((p) => new Choice(p.Id.ToString(), p.Name))];
            Users = [new(null, "Aki elindítja"), .. (await users).Items.Select((u) => new Choice(u.Id.ToString(), u.Name))];
            Client = Clients[0];
            Carrier = Carriers[0];
            Picker = Users[0];
        }
        await PreviewAsync();
    }

    partial void OnClientChanged(Choice? value) => _ = PreviewAsync();
    partial void OnCarrierChanged(Choice? value) => _ = PreviewAsync();
    partial void OnPriorityChanged(Choice? value) => _ = PreviewAsync();
    partial void OnMaxChanged(string value) => _ = PreviewAsync();

    int Limit => Math.Clamp(int.TryParse(Max.Trim(), out var n) ? n : 30, 1, 200);

    async Task PreviewAsync()
    {
        if (Users.Count == 0) return;
        var seq = ++previewSeq;
        try
        {
            var r = await Api.GetAsync<OrderCandidates>(Query.Build("api/orders", ("status", "new"), ("availability", "ok"),
                ("partner_id", Client?.Key), ("carrier_id", Carrier?.Key), ("priority", Priority?.Key), ("limit", Limit)));
            if (seq != previewSeq) return;
            candidates = r.Items;
            var items = candidates.Sum((o) => o.ItemCount);
            if (candidates.Count == 0)
            {
                Preview = "Nincs olyan új rendelés, amelyhez minden tétel elérhető.";
                PreviewNumbers = "";
                PreviewTone = "warn";
                return;
            }
            Preview = $"{Fmt.Int(candidates.Count)} rendelés, {Fmt.Int(items)} db kerül a hullámba"
                + (r.Total > candidates.Count ? $" (további {Fmt.Int(r.Total - candidates.Count)} teljesíthető rendelés vár)." : ".");
            PreviewNumbers = string.Join(", ", candidates.Take(12).Select((o) => o.Number)) + (candidates.Count > 12 ? ", ..." : "");
            PreviewTone = "info";
        }
        catch (ApiException e) when (e.Status != 401)
        {
            if (seq != previewSeq) return;
            candidates = [];
            Preview = e.Message;
            PreviewNumbers = "";
            PreviewTone = "danger";
        }
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        if (candidates.Count == 0)
        {
            Error = "Nincs indítható rendelés.";
            return;
        }
        try
        {
            var res = await Api.PostAsync<WaveCreated>("api/picking/waves", new { order_ids = candidates.Select((o) => o.Id).ToArray(), picker_id = Picker?.Id });
            Shell.Toast($"{res.Number} elindítva: {Fmt.Int(res.Orders)} rendelés.", ToastKind.Success);
            await Shell.BackAsync();
            await Shell.NavigateAsync(new WaveViewModel(Shell, res.Id));
        }
        catch (ApiException e) when (e.Status is 400 or 404 or 409)
        {
            Error = e.Message;
            await PreviewAsync();
        }
    });
}

// PATCH /api/picking/waves/:id { picker_id }: who picks the wave.
public sealed partial class WavePickerViewModel : PageViewModel
{
    public WavePickerViewModel(ShellViewModel shell, WaveDetail wave) : base(shell) => Wave = wave;

    public WaveDetail Wave { get; }
    public override string Title => "Komissiós";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Dialog;

    [ObservableProperty]
    public partial List<Choice> Users { get; set; } = [];

    [ObservableProperty]
    public partial Choice? Picker { get; set; }

    public override async Task LoadAsync()
    {
        if (Users.Count > 0) return;
        var users = await Api.GetAsync<ItemList<UserLookup>>("api/lookup/users");
        Users = [new(null, "Nincs kijelölve"), .. users.Items.Select((u) => new Choice(u.Id.ToString(), u.Name))];
        Picker = Users.FirstOrDefault((u) => u.Id == Wave.PickerId) ?? Users[0];
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        // A dictionary, so a null picker is sent (and clears it) instead of being left out.
        await Api.PatchAsync<WaveDetail>($"api/picking/waves/{Wave.Id}", new Dictionary<string, object?> { ["picker_id"] = Picker?.Id });
        Shell.Toast("Komissiós mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// POST /api/picking/waves/:id/short: what is not on the shelf. What was found is confirmed first
// (only after scanning the location and the product); the server plans the rest from other
// locations if it can.
public sealed partial class WaveShortViewModel(
    ShellViewModel shell, int waveId, PickTask task, bool scanned, string locationCode, string productCode, Action<PickShort> done) : PageViewModel(shell)
{
    public PickTask Task { get; } = task;
    public bool Scanned { get; } = scanned;
    public override string Title => $"Hiány: {Task.Location.Code}, {Task.Product.Sku}";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Dialog;

    public string Text => $"A helyen {Fmt.Int(Task.Remaining)} {Task.Product.UnitText} kellene. A hiányzó részt megpróbáljuk másik helyről pótolni; ha nincs máshol, a rendelés hiánnyal marad.";
    public string FoundHint => $"0 és {Fmt.Int(Task.Remaining - 1)} között";

    [ObservableProperty]
    public partial string Found { get; set; } = "0";

    [ObservableProperty]
    public partial string? FoundError { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var found = 0;
        if (Scanned)
        {
            var text = Found.Trim();
            if (!int.TryParse(text.Length == 0 ? "0" : text, out found) || found < 0 || found >= Task.Remaining)
            {
                FoundError = $"0 és {Fmt.Int(Task.Remaining - 1)} között adj meg számot.";
                return;
            }
        }
        FoundError = null;
        if (found > 0)
        {
            await Api.PostAsync<PickConfirmed>($"api/picking/waves/{waveId}/confirm",
                new { pick_id = Task.PickId, location_code = locationCode, product_code = productCode, qty = found });
        }
        var fresh = await Api.GetAsync<WaveDetail>($"api/picking/waves/{waveId}");
        var t = fresh.Tasks.FirstOrDefault((x) => x.Key == Task.Key);
        var res = t is not { IsOpen: true } ? new PickShort(true, 0, [], 0, null)
            : await Api.PostAsync<PickShort>($"api/picking/waves/{waveId}/short", new { pick_id = t.PickId });
        done(res);
        await Shell.BackAsync();
    });
}

// POST /api/picking/waves/:id/cancel { reason }: the orders go back to new, what was picked is
// booked back to where it was taken from.
public sealed partial class WaveCancelViewModel(ShellViewModel shell, WaveDetail wave) : PageViewModel(shell)
{
    public WaveDetail Wave { get; } = wave;
    public override string Title => $"{Wave.Number} megszakítása";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Dialog;

    public string Text => "A rendelések visszakerülnek új állapotba."
        + (Wave.Progress.Picked > 0 ? $" A már kiszedett {Fmt.Int(Wave.Progress.Picked)} db-ot visszakönyveljük oda, ahonnan kivették: tedd vissza a polcra." : "")
        + " A becsomagolt rendelések nem változnak.";

    [ObservableProperty]
    public partial string Reason { get; set; } = "";

    [ObservableProperty]
    public partial string? ReasonError { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        ReasonError = Reason.Trim().Length == 0 ? "Add meg az okát." : null;
        if (ReasonError is not null) return;
        try
        {
            var r = await Api.PostAsync<WaveCancelled>($"api/picking/waves/{Wave.Id}/cancel", new { reason = Reason.Trim() });
            Shell.Toast("Hullám megszakítva." + (r.Restocked.Count > 0
                ? $" Visszakönyvelve: {string.Join(", ", r.Restocked.Select((x) => $"{x.Sku} {x.Qty} db ({x.Code})"))}." : ""), ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.ContainsKey("reason"))
        {
            ReasonError = e.Fields["reason"];
        }
    });
}

// POST /api/picking/orders/:id/unpack { reason }: back to waiting for packing.
public sealed partial class UnpackViewModel(ShellViewModel shell, PackingOrder order, Action<PackingOrder> done) : PageViewModel(shell)
{
    public PackingOrder Order { get; } = order;
    public override string Title => $"{Order.Number}: csomagolás visszavonása";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Dialog;

    [ObservableProperty]
    public partial string Reason { get; set; } = "";

    [ObservableProperty]
    public partial string? ReasonError { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        ReasonError = Reason.Trim().Length == 0 ? "Add meg az okát." : null;
        if (ReasonError is not null) return;
        try
        {
            var r = await Api.PostAsync<PackingOrder>($"api/picking/orders/{Order.Id}/unpack", new { reason = Reason.Trim() });
            done(r);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.ContainsKey("reason"))
        {
            ReasonError = e.Fields["reason"];
        }
    });
}
