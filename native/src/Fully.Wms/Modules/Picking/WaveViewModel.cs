using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Picking;

// One wave (GET /api/picking/waves/:id): picking with a hand scanner or the phone's camera, the
// pick list, the orders, closing and cancelling. The same flow as the web app:
//
// The tasks come one after the other in walking order. For each: scan the location, then the
// product, then confirm the counted quantity (a single piece is confirmed by the product scan).
// Scanning another location of the list switches to its task. "Hiány" records what is not on the
// shelf (the server plans it from another location if it can), "Kihagyás" puts the task at the end.
public sealed partial class WaveViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    static readonly string[] Active = ["open", "picking", "picked"];

    public int Id { get; } = id;
    public override string Title => Data?.Number ?? "Hullám";
    public override string? Module => "picking";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"wave:{Id}";

    // Where the worker is: the current task, the step in it, the location and product scanned.
    int? locId;
    string locCode = "";
    string productCode = "";
    readonly List<string> skipped = [];
    bool greeted;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Status), nameof(IsActive), nameof(Working), nameof(Lead), nameof(CanComplete),
        nameof(CompleteNeedsApproval), nameof(CompleteHint), nameof(CanCancel), nameof(ReadyCount), nameof(ShowPackingButton), nameof(PackingText),
        nameof(PackingPrimary), nameof(ProgressRatio), nameof(ProgressDone), nameof(ProgressText), nameof(PickerText), nameof(CanChangePicker),
        nameof(ShowStart), nameof(HasNote), nameof(FinishNotice), nameof(FinishTone), nameof(HasTasks), nameof(OrdersInWave))]
    public partial WaveDetail? Data { get; set; }

    // The key of the task being worked on.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Current), nameof(HasCurrent), nameof(TaskPosition), nameof(ShowSkip), nameof(ScanPlaceholder),
        nameof(LotLine), nameof(OrdersLine), nameof(RemainingText))]
    public partial string? Key { get; set; }

    // location, product or qty
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(LocDone), nameof(LocCurrent), nameof(ProductDone), nameof(ProductCurrent), nameof(QtyCurrent),
        nameof(IsQtyStep), nameof(ShowRestart), nameof(ScanPlaceholder))]
    public partial string Step { get; set; } = "location";

    // The counted quantity (qty step).
    [ObservableProperty]
    public partial string Qty { get; set; } = "";

    [ObservableProperty]
    public partial string Feedback { get; set; } = "";

    // info, ok, warn, danger
    [ObservableProperty]
    public partial string FeedbackTone { get; set; } = "info";

    public ObservableCollection<PickTaskItem> Tasks { get; } = [];

    public string? Status => Data?.Status;
    public bool CanEdit => Shell.Me?.Can("picking", "edit") == true;
    public bool IsActive => Data is not null && Active.Contains(Data.Status);
    IEnumerable<PickTask> OpenTasks => Data?.Tasks.Where((t) => t.IsOpen) ?? [];
    public bool Working => IsActive && CanEdit && OpenTasks.Any();
    public bool HasTasks => Data is { Tasks.Count: > 0 };
    public IReadOnlyList<WaveOrderItem> OrdersInWave => Data?.Orders.Select((o) => new WaveOrderItem(this, o, o.Ready && CanEdit)).ToList() ?? [];

    public string Lead => Data is null ? "" : $"Létrehozta {Data.CreatedByName ?? "rendszer"}, {Fmt.DateTime(Data.CreatedAt)}";

    bool Missing => Data is not null && (Data.Progress.Remaining > 0 || Data.IncompleteOrders.Count > 0);
    public bool CanComplete => IsActive && CanEdit;
    public bool CompleteNeedsApproval => Missing && Shell.Me?.Can("picking", "approve") != true;
    public string? CompleteHint => CanComplete && CompleteNeedsApproval ? "Hiánnyal lezárni csak jóváhagyási joggal lehet." : null;
    public bool CanCancel => IsActive && Shell.Me?.Can("picking", "delete") == true;
    public int ReadyCount => Data?.Orders.Count((o) => o.Ready) ?? 0;
    public bool ShowPackingButton => ReadyCount > 0 && CanEdit;
    public string PackingText => $"Csomagolás ({Fmt.Int(ReadyCount)})";
    public bool PackingPrimary => IsActive && !OpenTasks.Any();

    public double ProgressRatio => Data is null ? 0 : PickingFormat.Ratio(Data.Progress.Picked, Data.Progress.Qty);
    public bool ProgressDone => Data is { Progress: { Qty: > 0 } p } && p.Picked >= p.Qty;

    public string ProgressText
    {
        get
        {
            if (Data is null) return "";
            var p = Data.Progress;
            return $"{Fmt.Int(p.Picked)} / {Fmt.Int(p.Qty)} db kiszedve{(p.Short > 0 ? $", hiány {Fmt.Int(p.Short)} db" : "")} · "
                + (p.OpenTasks > 0 ? $"{Fmt.Int(p.OpenTasks)} feladat van hátra" : "nincs hátralévő feladat");
        }
    }

    public string PickerText => $"Komissiós: {(string.IsNullOrEmpty(Data?.PickerName) ? "nincs kijelölve" : Data.PickerName)}";
    public bool CanChangePicker => IsActive && CanEdit;
    public bool ShowStart => Data?.Status == "open" && CanEdit;
    public bool HasNote => !string.IsNullOrEmpty(Data?.Note);

    // Under the work: everything done, or why there is nothing to do.
    public string? FinishNotice
    {
        get
        {
            if (Data is not { } w) return null;
            if (IsActive && !OpenTasks.Any())
            {
                var ready = ReadyCount;
                return string.Join(" ", new[]
                {
                    "Minden feladat kész.",
                    w.Progress.Short > 0 ? $"Hiány: {Fmt.Int(w.Progress.Short)} db." : null,
                    ready > 0 ? $"{Fmt.Int(ready)} rendelés csomagolható." : null,
                    w.IncompleteOrders.Count > 0 ? $"Hiányos rendelés: {string.Join(", ", w.IncompleteOrders)}. Lezáráskor ezek visszakerülnek új állapotba." : null,
                }.Where((x) => x is not null));
            }
            if (w.Status == "completed") return $"A hullám le van zárva{(w.CompletedAt is { Length: > 0 } c ? $" ({Fmt.DateTime(c)})" : "")}.";
            if (w.Status == "cancelled") return $"A hullám meg van szakítva. {w.Note}";
            return null;
        }
    }

    public string FinishTone => Data is null ? "info"
        : IsActive ? (Data.IncompleteOrders.Count > 0 ? "warn" : "ok")
        : Data.Status == "completed" ? "ok" : "warn";

    // ------------------------------------------------------------------ the current task

    public PickTask? Current => Data?.Tasks.FirstOrDefault((t) => t.Key == Key && t.IsOpen);
    public bool HasCurrent => Current is not null;

    // Open tasks in walking order, the skipped ones at the end (in the order they were skipped).
    List<PickTask> Queue()
    {
        var open = OpenTasks.ToList();
        var back = skipped.Select((k) => open.FirstOrDefault((t) => t.Key == k)).OfType<PickTask>();
        return [.. open.Where((t) => !skipped.Contains(t.Key)), .. back];
    }

    public string TaskPosition
    {
        get
        {
            var q = Queue();
            var pos = q.FindIndex((t) => t.Key == Key) + 1;
            return $"Feladat {Fmt.Int(pos)} / {Fmt.Int(q.Count)}";
        }
    }

    public bool LocDone => Step is "product" or "qty";
    public bool LocCurrent => Step == "location";
    public bool ProductDone => Step == "qty";
    public bool ProductCurrent => Step == "product";
    public bool QtyCurrent => Step == "qty";
    public bool IsQtyStep => Step == "qty";
    public bool ShowSkip => Queue().Count > 1;
    public bool ShowRestart => Step != "location";

    public string LotLine => Current is not { } t ? "" : string.Join(" · ", new[]
    {
        string.IsNullOrEmpty(t.Product.Ean) ? null : $"EAN {t.Product.Ean}",
        PickingFormat.LotText(t.Lot, t.Expiry) is { Length: > 0 } l ? l : null,
    }.Where((x) => x is not null));

    public string OrdersLine => Current is not { } t ? "" : (t.Orders.Count > 1 ? $"{t.Orders.Count} rendelés: " : "") + string.Join(", ", t.Orders);
    public string RemainingText => Current is not { } t ? "" : $"{Fmt.Int(t.Remaining)} {t.Product.UnitText}";

    // What to scan next (short enough for a handheld screen).
    public string ScanPlaceholder => Current is not { } t ? "Raktárhely vagy termék beolvasása"
        : Step switch { "location" => $"Hely: {t.Location.Code}", "product" => $"Termék: {t.Product.Sku}", _ => "Mennyiség megadása" };

    // The view focuses the quantity when the qty step opens, and the scan field after it.
    public event EventHandler? QtyOpened;
    public event EventHandler? ScanFocus;

    // ------------------------------------------------------------------ loading

    public override async Task LoadAsync() => Apply(await Api.GetAsync<WaveDetail>($"api/picking/waves/{Id}"));

    void Apply(WaveDetail w)
    {
        Data = w;
        ChooseNext();
        RefreshDerived();
        if (!greeted)
        {
            greeted = true;
            if (Working && Current is { } c) Say($"Kezdd itt: {c.Location.Code}. Olvasd be a helyet.", "info");
        }
    }

    async Task RefreshAsync()
    {
        try
        {
            Apply(await Api.GetAsync<WaveDetail>($"api/picking/waves/{Id}"));
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
    }

    // Keeps the current task while it is open; else the next one, on the same location first.
    void ChooseNext()
    {
        if (Current is not null) return;
        var q = Queue();
        var same = q.FirstOrDefault((t) => t.Location.Id == locId);
        Key = (same ?? q.FirstOrDefault())?.Key;
        Step = Current is { } cur && locId == cur.Location.Id ? "product" : "location";
        productCode = "";
    }

    // The task card and the pick list after the current task or step changed.
    void RefreshDerived()
    {
        OnPropertyChanged(nameof(Current));
        OnPropertyChanged(nameof(HasCurrent));
        OnPropertyChanged(nameof(TaskPosition));
        OnPropertyChanged(nameof(ShowSkip));
        OnPropertyChanged(nameof(ScanPlaceholder));
        OnPropertyChanged(nameof(LotLine));
        OnPropertyChanged(nameof(OrdersLine));
        OnPropertyChanged(nameof(RemainingText));
        var canChoose = IsActive && CanEdit;
        Tasks.Clear();
        string? lastLoc = null;
        foreach (var t in Data?.Tasks ?? [])
        {
            var first = t.Location.Code != lastLoc;
            lastLoc = t.Location.Code;
            Tasks.Add(new PickTaskItem(this, t, first, t.Key == Current?.Key, canChoose && t.IsOpen && t.Key != Current?.Key));
        }
    }

    void Say(string text, string tone)
    {
        Feedback = text;
        FeedbackTone = tone;
        var haptic = tone switch { "ok" => HapticKind.Success, "warn" => HapticKind.Warning, "danger" => HapticKind.Error, _ => (HapticKind?)null };
        if (haptic is { } h) Shell.Services.Platform.Haptic(h);
    }

    // ------------------------------------------------------------------ scanning

    // Scans and the actions that write run one at a time, so fast scanning never loses a code and a
    // scan and a tap never confirm twice.
    readonly SemaphoreSlim scanLock = new(1, 1);

    async Task SerialAsync(Func<Task> action)
    {
        await scanLock.WaitAsync();
        Shell.IsBusy = true;
        try
        {
            await action();
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
        finally
        {
            Shell.IsBusy = false;
            scanLock.Release();
        }
    }

    [RelayCommand]
    Task ScanAsync(string code) => SerialAsync(() => OnScanAsync(code.Trim()));

    async Task OnScanAsync(string code)
    {
        if (code.Length == 0) return;
        if (Current is not { } cur)
        {
            Say("Nincs több kiszedendő tétel ebben a hullámban.", "info");
            return;
        }
        bool IsLoc(PickTask t) => string.Equals(t.Location.Code, code, StringComparison.OrdinalIgnoreCase);
        if (IsLoc(cur))
        {
            if (Step == "location") SwitchTo(cur, "Hely rendben");
            else Say($"A hely már be van olvasva. Most a terméket olvasd be: {cur.Product.Sku}.", "info");
            return;
        }
        if (Queue().FirstOrDefault(IsLoc) is { } other)
        {
            SwitchTo(other, "Átváltva a helyre");
            return;
        }
        if (cur.Product.Matches(code))
        {
            if (Step == "location")
            {
                Say($"Előbb a helyet olvasd be: {cur.Location.Code}.", "danger");
                return;
            }
            if (Step == "qty")
            {
                Say("Add meg a mennyiséget, majd nyomd meg a Megerősítés gombot.", "info");
                QtyOpened?.Invoke(this, EventArgs.Empty);
                return;
            }
            productCode = code;
            if (cur.Remaining == 1)
            {
                await ConfirmCoreAsync(1);
                return;
            }
            Step = "qty";
            Qty = cur.Remaining.ToString();
            QtyOpened?.Invoke(this, EventArgs.Empty);
            Say($"Termék rendben: {cur.Product.Sku}. Számold meg: {Fmt.Int(cur.Remaining)} {cur.Product.UnitText} kell.", "ok");
            return;
        }
        // Not the current task: ask the server what the code is, to give a useful message.
        var r = await Api.GetAsync<WaveScanResult>(Query.Build($"api/picking/waves/{Id}/scan", ("code", code)));
        switch (r.Kind)
        {
            case "location":
                Say($"A(z) {r.Location?.Code} helyen nincs feladat ebben a hullámban. Ide menj: {cur.Location.Code}.", "danger");
                break;
            case "product":
                Say(Step == "location"
                    ? $"Előbb a helyet olvasd be: {cur.Location.Code}."
                    : $"Rossz termék ({r.Product?.Sku}). A(z) {cur.Location.Code} helyen ezt kell kiszedni: {cur.Product.Sku} {cur.Product.Name}.", "danger");
                break;
            case "order":
                Say($"Ez a(z) {r.Order?.Number} rendelés száma. Kiszedéshez a helyet és a terméket olvasd be.", "info");
                break;
            default:
                Say(r.Message ?? $"Ismeretlen kód: {code}.", "danger");
                break;
        }
    }

    void SwitchTo(PickTask task, string how)
    {
        Key = task.Key;
        locId = task.Location.Id;
        locCode = task.Location.Code;
        Step = "product";
        productCode = "";
        RefreshDerived();
        Say($"{how}: {task.Location.Code}. Most olvasd be a terméket: {task.Product.Sku}.", "ok");
    }

    // ------------------------------------------------------------------ quantity

    [RelayCommand]
    Task ConfirmAsync() => SerialAsync(() => ConfirmCoreAsync(ParseQty(Qty)));

    // Enter in the quantity field. A hand scanner that typed into it leaves its code at the end:
    // the digits typed before it stay, and the code is handled as a scan.
    [RelayCommand]
    async Task QuantityEnterAsync()
    {
        var value = Qty.Trim();
        if (value.Length <= 6 && value.All(char.IsAsciiDigit))
        {
            await ConfirmAsync();
            return;
        }
        var digits = new string(value.TakeWhile(char.IsAsciiDigit).ToArray());
        var cur = Current;
        var codes = cur is null ? [] : new[] { cur.Product.Ean, cur.Product.Sku, cur.Location.Code }.Where((c) => !string.IsNullOrEmpty(c)).Select((c) => c!);
        var hit = codes.Where((c) => value.EndsWith(c, StringComparison.OrdinalIgnoreCase)).OrderByDescending((c) => c.Length).FirstOrDefault();
        var typed = hit is null ? digits : value[..^hit.Length];
        Qty = typed.Length is > 0 and <= 6 && typed.All(char.IsAsciiDigit) ? typed : cur?.Remaining.ToString() ?? "";
        await ScanAsync(hit ?? value);
    }

    static int? ParseQty(string s) => s.Trim() is { Length: > 0 and <= 6 } t && t.All(char.IsAsciiDigit) ? int.Parse(t) : null;

    [RelayCommand]
    void QtyMinus() => Qty = Math.Max(1, (ParseQty(Qty) ?? 1) - 1).ToString();

    [RelayCommand]
    void QtyPlus() => Qty = Math.Min(Current?.Remaining ?? 1, (ParseQty(Qty) ?? 0) + 1).ToString();

    // Esc in the quantity: back to the product scan.
    [RelayCommand]
    void CancelQty()
    {
        if (Step != "qty") return;
        Step = "product";
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    async Task ConfirmCoreAsync(int? qty)
    {
        if (Current is not { } cur) return;
        if (qty is not { } q || q < 1 || q > cur.Remaining)
        {
            Say($"A mennyiség 1 és {Fmt.Int(cur.Remaining)} között legyen.", "danger");
            return;
        }
        try
        {
            var r = await Api.PostAsync<PickConfirmed>($"api/picking/waves/{Id}/confirm",
                new { pick_id = cur.PickId, location_code = locCode.Length > 0 ? locCode : cur.Location.Code, product_code = productCode, qty = q });
            productCode = "";
            Step = "product";
            await RefreshAsync();
            var next = Current;
            Say($"Kiszedve: {Fmt.Int(q)} {cur.Product.UnitText} {cur.Product.Sku}."
                + (r.Left > 0 ? $" Ennél a feladatnál még {Fmt.Int(r.Left)} van hátra." : "")
                + (next is not null ? $" Következő: {next.Location.Code}{(next.Location.Id == cur.Location.Id ? ", ugyanez a hely" : "")}." : " Minden tétel kész."), "ok");
            ScanFocus?.Invoke(this, EventArgs.Empty);
        }
        catch (ApiException e) when (e.Status is 409 or 404)
        {
            Say(e.Message, "danger");
            await RefreshAsync();
        }
    }

    // ------------------------------------------------------------------ task actions

    [RelayCommand]
    Task ShortAsync()
    {
        if (Current is not { } cur) return Task.CompletedTask;
        var scanned = Step == "qty";
        return Shell.NavigateAsync(new WaveShortViewModel(Shell, Id, cur, scanned, locCode.Length > 0 ? locCode : cur.Location.Code, productCode, (res) =>
        {
            Step = "location";
            locId = null;
            var moved = res.Moved.Count > 0 ? $" Pótlás innen: {string.Join(", ", res.Moved.Select((m) => $"{m.Code} ({m.Qty} db)"))}." : "";
            Say($"Hiány rögzítve: {Fmt.Int(res.Short)} {cur.Product.UnitText} {cur.Product.Sku}.{moved}{(res.Missing > 0 ? $" Nem pótolható: {Fmt.Int(res.Missing)} db." : "")}",
                res.Missing > 0 ? "danger" : "ok");
        }));
    }

    [RelayCommand]
    void Skip()
    {
        if (Current is not { } cur) return;
        skipped.Remove(cur.Key);
        skipped.Add(cur.Key);
        Key = null;
        ChooseNext();
        RefreshDerived();
        Say(Current is { } next ? $"Kihagyva. Következő hely: {next.Location.Code}." : "Kihagyva.", "info");
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    [RelayCommand]
    void Restart()
    {
        Step = "location";
        locId = null;
        productCode = "";
        RefreshDerived();
        Say("Kezdd újra: olvasd be a helyet.", "info");
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    // "Ez jön" in the pick list.
    internal void Choose(PickTask task)
    {
        Key = task.Key;
        Step = Current is { } cur && cur.Location.Id == locId ? "product" : "location";
        productCode = "";
        RefreshDerived();
        Say($"Következő feladat: {task.Location.Code}, {task.Product.Sku}.", "info");
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    // ------------------------------------------------------------------ wave actions

    [RelayCommand]
    Task StartAsync() => RunAsync(async () =>
    {
        Apply(await Api.PostAsync<WaveDetail>($"api/picking/waves/{Id}/start"));
        Shell.Toast("Kiszedés elindítva.", ToastKind.Success);
    });

    [RelayCommand]
    Task PickerAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new WavePickerViewModel(Shell, Data));

    [RelayCommand]
    Task CompleteAsync() => RunAsync(async () =>
    {
        if (Data is not { } w) return;
        var reverted = w.Orders.Where((o) => o.InWave && o.Status == "picking" && o.PickedCount < o.ItemCount).Select((o) => o.Number).ToList();
        var ok = await Shell.ConfirmAsync($"{w.Number} lezárása",
            Missing
                ? $"A hullámban hiány van. Lezáráskor a hiányos rendelések ({(reverted.Count > 0 ? string.Join(", ", reverted) : "nincs")}) visszakerülnek új állapotba; a már kiszedett tételeik a rendelésnél maradnak, a készlet nem változik."
                : "Minden tétel ki van szedve. A még be nem csomagolt rendelések a csomagolóállomáson továbbra is csomagolhatók.",
            Missing ? "Lezárás hiánnyal" : "Lezárás", danger: Missing);
        if (!ok) return;
        var r = await Api.PostAsync<WaveCompleted>($"api/picking/waves/{Id}/complete");
        Shell.Toast(r.Reverted.Count > 0 ? $"Lezárva. Új állapotba került: {string.Join(", ", r.Reverted)}." : "Hullám lezárva.", ToastKind.Success);
        await RefreshAsync();
    });

    [RelayCommand]
    Task CancelWaveAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new WaveCancelViewModel(Shell, Data));

    [RelayCommand]
    Task PrintAsync() => Data is null ? Task.CompletedTask : Shell.Services.Platform.OpenFileAsync(PickList.Build(Data, Shell.Me!));

    [RelayCommand]
    Task PackingAsync() => PackingViewModel.OpenAsync(Shell, Id, null);

    internal Task PackOrderAsync(WaveOrder order) => PackingViewModel.OpenAsync(Shell, Id, order.Id);
}

// An order of the wave, with its packing button.
public sealed partial class WaveOrderItem(WaveViewModel page, WaveOrder order, bool canPack) : ObservableObject
{
    public WaveOrder Order { get; } = order;
    public bool CanPack { get; } = canPack;
    public bool ShowTracking => !CanPack && !string.IsNullOrEmpty(Order.TrackingNumber);
    public bool NotInWave => !Order.InWave;

    [RelayCommand]
    Task PackAsync() => page.PackOrderAsync(Order);
}

// A row of the pick list.
public sealed partial class PickTaskItem(WaveViewModel page, PickTask task, bool firstOfLocation, bool isCurrent, bool canChoose) : ObservableObject
{
    public PickTask Task { get; } = task;
    public bool FirstOfLocation { get; } = firstOfLocation;
    public bool IsCurrent { get; } = isCurrent;
    public bool CanChoose { get; } = canChoose;
    public string LocationText => FirstOfLocation ? Task.Location.Code : "";
    public string LotText => PickingFormat.LotText(Task.Lot, Task.Expiry);
    public bool HasLot => LotText.Length > 0;
    public string ShortText => Task.Short > 0 ? $"hiány {Fmt.Int(Task.Short)}" : "";

    // Kész, Hiány, Most, Hátra
    public string StateText => Task.State == "done" ? "Kész" : Task.State == "short" ? "Hiány" : IsCurrent ? "Most" : "Hátra";
    public bool IsDone => Task.State == "done";
    public bool IsShort => Task.State == "short";

    public string CardLine => string.Join(" · ", new[]
    {
        $"kell {Fmt.Int(Task.Qty)}",
        $"kiszedve {Fmt.Int(Task.Picked)}",
        Task.Short > 0 ? $"hiány {Fmt.Int(Task.Short)}" : null,
        LotText.Length > 0 ? LotText : null,
    }.Where((x) => x is not null));

    [RelayCommand]
    void Choose() => page.Choose(Task);
}
