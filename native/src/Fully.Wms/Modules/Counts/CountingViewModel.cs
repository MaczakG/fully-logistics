using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// Counting with a hand scanner or the phone's camera, location by location, like the web app:
// scan the location's label, then every piece (each scan adds one), or type the quantity of a line.
// A product that is not on the list is recorded as found. "Hely kész" records what was not found
// as 0; "Újraszámolás" starts the location again with fresh stock. Expected quantities show only
// when the count is not blind for the user.
public sealed partial class CountingViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    static readonly string[] Active = ["open", "counting", "counted"];

    public int Id { get; } = id;
    public override string Title => Data is null ? "Számlálás" : $"{Data.Number}: számlálás";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"counting:{Id}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Lead), nameof(CanWork), nameof(Blocked))]
    public partial CountDetail? Data { get; set; }

    // The location being counted (the server's state of it), null while choosing.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCurrent), nameof(Choosing), nameof(ScanPlaceholder), nameof(CurrentZone), nameof(Visible), nameof(HasGoods),
        nameof(EmptyNotice), nameof(StateText), nameof(CurrentDone), nameof(CurrentLeft), nameof(NextLocation), nameof(HasNext), nameof(AllDone), nameof(NextText))]
    public partial CountLocationState? Current { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ProgressRatio), nameof(ProgressText), nameof(ProgressDone))]
    public partial CountProgress? Progress { get; set; }

    [ObservableProperty]
    public partial string Feedback { get; set; } = "";

    [ObservableProperty]
    public partial string FeedbackTone { get; set; } = "info";

    public ObservableCollection<CountLocItem> Locations { get; } = [];
    public ObservableCollection<CountEntryItem> Lines { get; } = [];

    public bool CanEdit => Shell.Me?.Can("counts", "edit") == true;
    public bool CanWork => Data is not null && Active.Contains(Data.Status) && CanEdit;

    // Why there is nothing to count here.
    public string? Blocked => Data is null || CanWork ? null
        : !Active.Contains(Data.Status) ? $"A(z) {Data.Number} leltár {Shell.Meta.Status("count", Data.Status).Label.ToLowerInvariant()}, már nem számolható."
        : "A számlálás rögzítéséhez nincs jogosultságod.";

    public string Lead => Data is null ? "" : $"{Data.TypeLabel}: {Data.Scope}{(Data.Blind ? ". Vak leltár." : "")}";
    public bool HasCurrent => Current is not null;
    public bool Choosing => Current is null;
    public string ScanPlaceholder => Current is null ? "Raktárhely kódja" : "Termék vagy hely";
    public string CurrentZone => Current is { } c ? $"Raktárhely{(string.IsNullOrEmpty(c.Location.Zone) ? "" : $", {c.Location.Zone} zóna")}" : "";
    public bool Visible => Current?.Count.CanSeeExpected == true;
    public bool HasGoods => Current?.Lines.Any((l) => l.HasProduct) == true;
    public bool CurrentDone => Current?.Location.Done == true;
    public int CurrentLeft => Current?.Lines.Count((l) => l.HasProduct && !l.IsCounted) ?? 0;
    public string StateText => CurrentDone ? "Kész" : CurrentLeft > 0 ? $"{Fmt.Int(CurrentLeft)} tétel számolatlan" : "";

    public string? EmptyNotice => Current is { } c && !HasGoods
        ? (Visible || c.Lines.Any((l) => !l.HasProduct) ? "Nyilvántartás szerint üres hely. Ha árut találsz, olvasd be, különben jelöld késznek." : "Nincs nyilvántartott áru.")
        : null;

    public double ProgressRatio => Progress is null ? 0 : CountsFormat.Ratio(Progress.DoneLocations, Progress.Locations);
    public bool ProgressDone => Progress is { Locations: > 0 } p && p.DoneLocations >= p.Locations;
    public string ProgressText => Progress is null ? "" : $"{Fmt.Int(Progress.DoneLocations)} / {Fmt.Int(Progress.Locations)} hely kész";

    // The next location not done, in walking order after the current one.
    public CountLocItem? NextLocation
    {
        get
        {
            var at = Current is null ? -1 : Locations.ToList().FindIndex((l) => l.Location.LocationId == Current.Location.Id);
            return Locations.Skip(at + 1).FirstOrDefault((l) => !l.Done) ?? Locations.FirstOrDefault((l) => !l.Done);
        }
    }

    public bool HasNext => NextLocation is not null;
    public bool AllDone => Locations.Count > 0 && NextLocation is null;
    public string NextText => NextLocation is { } n ? $"Számlálás itt: {n.Location.Code}" : "";

    // The view moves the focus back to the scan field after an entry (not on the phone).
    public event EventHandler? ScanFocus;

    // ------------------------------------------------------------------ loading

    public override async Task LoadAsync()
    {
        await gate.WaitAsync();
        try
        {
            var d = await Api.GetAsync<CountDetail>($"api/counts/{Id}?lines=0");
            Data = d;
            Progress = d.Progress;
            Locations.Clear();
            foreach (var l in d.Locations ?? []) Locations.Add(new CountLocItem(this, l));
            if (Current is { } cur && CanWork) Apply(await Api.GetAsync<CountLocationState>($"api/counts/{Id}/locations/{cur.Location.Id}"));
            else if (!CanWork) Current = null;
            MarkCurrent();
            OnPropertyChanged(nameof(NextLocation));
            OnPropertyChanged(nameof(HasNext));
            OnPropertyChanged(nameof(AllDone));
            OnPropertyChanged(nameof(NextText));
        }
        finally
        {
            gate.Release();
        }
    }

    void Apply(CountLocationState res)
    {
        Current = res;
        Progress = res.Progress;
        if (Locations.FirstOrDefault((x) => x.Location.LocationId == res.Location.Id) is { } loc)
            loc.Update(res.Lines.Count((x) => x.IsCounted), res.Location.Done);
        var visible = res.Count.CanSeeExpected;
        Lines.Clear();
        foreach (var l in res.Lines.Where((x) => x.HasProduct)) Lines.Add(new CountEntryItem(this, l, visible));
        MarkCurrent();
    }

    void MarkCurrent()
    {
        foreach (var l in Locations) l.IsCurrent = l.Location.LocationId == Current?.Location.Id;
        OnPropertyChanged(nameof(NextLocation));
        OnPropertyChanged(nameof(HasNext));
        OnPropertyChanged(nameof(AllDone));
        OnPropertyChanged(nameof(NextText));
    }

    void Say(string text, string tone)
    {
        Feedback = text;
        FeedbackTone = tone;
        if (tone == "danger") Shell.Services.Platform.Haptic(HapticKind.Error);
        else if (tone == "ok") Shell.Services.Platform.Haptic(HapticKind.Success);
    }

    // Entries run one after the other: a scan right after typing a quantity never overtakes it.
    readonly SemaphoreSlim gate = new(1, 1);

    async Task ActAsync(Func<Task<CountLocationState?>> action)
    {
        await gate.WaitAsync();
        Shell.IsBusy = true;
        try
        {
            if (await action() is { } res) Apply(res);
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
        finally
        {
            Shell.IsBusy = false;
            gate.Release();
        }
    }

    // ------------------------------------------------------------------ locations

    internal Task OpenLocationAsync(int locationId, bool viaScan = false) => ActAsync(async () =>
    {
        var res = await Api.GetAsync<CountLocationState>($"api/counts/{Id}/locations/{locationId}");
        Say(viaScan ? $"{res.Location.Code}: olvasd be a termékeket." : $"{res.Location.Code} megnyitva.", "info");
        return res;
    });

    [RelayCommand]
    Task OpenNextAsync() => NextLocation is { } n ? OpenLocationAsync(n.Location.LocationId) : Task.CompletedTask;

    [RelayCommand]
    void Leave()
    {
        Current = null;
        Lines.Clear();
        Feedback = "";
        MarkCurrent();
        ScanFocus?.Invoke(this, EventArgs.Empty);
    }

    // ------------------------------------------------------------------ scanning

    [RelayCommand]
    async Task ScanAsync(string code)
    {
        code = code.Trim();
        if (code.Length == 0) return;
        if (Locations.FirstOrDefault((l) => string.Equals(l.Location.Code, code, StringComparison.OrdinalIgnoreCase)) is { } loc)
        {
            await OpenLocationAsync(loc.Location.LocationId, viaScan: true);
            return;
        }
        if (Current is not { } cur)
        {
            Say($"Ez nem raktárhely ebben a leltárban: {code}. Előbb olvasd be a hely címkéjét.", "danger");
            return;
        }
        var matches = cur.Lines.Where((l) => l.HasProduct && (l.Ean == code || string.Equals(l.Sku, code, StringComparison.OrdinalIgnoreCase))).ToList();
        if (matches.Count == 1)
        {
            await AddToAsync(matches[0], 1);
            return;
        }
        if (matches.Count > 1)
        {
            await Shell.NavigateAsync(new CountChooseLineViewModel(Shell, matches, (l) => AddToAsync(l, 1)));
            return;
        }
        CountResolved res;
        try
        {
            res = await Api.GetAsync<CountResolved>(Query.Build($"api/counts/{Id}/resolve", ("code", code), ("location_id", cur.Location.Id)));
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
            return;
        }
        if (res.Products.Count == 0)
        {
            Say($"Ismeretlen kód: {code}. Nem termék és nem hely ebben a leltárban.", "danger");
            return;
        }
        await Shell.NavigateAsync(new CountFoundViewModel(Shell, Id, cur.Location, res.Products, code, Found));
    }

    // A found product recorded by the dialog.
    void Found(CountLocationState res, string text)
    {
        Apply(res);
        Say(text, "ok");
    }

    // ------------------------------------------------------------------ entries

    internal Task AddToAsync(CountLine line, int add) => ActAsync(async () =>
    {
        var res = await Api.PutAsync<CountLocationState>($"api/counts/{Id}/lines/{line.Id}", new { add });
        var now = res.Lines.FirstOrDefault((l) => l.Id == line.Id);
        Say($"{line.Sku}{(line.Lot.Length > 0 ? $" ({line.Lot})" : "")}: {Fmt.Int(now?.CountedQty ?? 0)} {line.Unit}", "ok");
        flash = line.Id;
        return res;
    });

    internal Task SetQtyAsync(CountLine line, string value) => ActAsync(async () =>
    {
        int? qty = null;
        if (value.Length > 0)
        {
            if (!int.TryParse(value, out var n) || n < 0)
            {
                Say("A mennyiség nem negatív egész szám legyen.", "danger");
                return null;
            }
            qty = n;
        }
        var fresh = Current?.Lines.FirstOrDefault((l) => l.Id == line.Id) ?? line;
        if (qty == fresh.CountedQty) return null;
        // A dictionary, so "not counted" (null) is sent instead of being left out.
        var res = await Api.PutAsync<CountLocationState>($"api/counts/{Id}/lines/{line.Id}", new Dictionary<string, object?> { ["counted_qty"] = qty });
        Say(qty is null ? $"{line.Sku}: számolás törölve." : $"{line.Sku}: {Fmt.Int(qty.Value)} {line.Unit}", "ok");
        flash = line.Id;
        return res;
    });

    internal Task DecAsync(CountLine line) => line.CountedQty is > 0 ? AddToAsync(line, -1) : line.CountedQty is null ? SetQtyAsync(line, "0") : Task.CompletedTask;

    internal async Task RemoveAsync(CountLine line)
    {
        if (!await Shell.ConfirmAsync("Talált tétel törlése", $"Törlöd a(z) {line.Sku} tételt erről a helyről?", "Törlés", danger: true)) return;
        await ActAsync(async () =>
        {
            var res = await Api.DeleteAsync<CountLocationState>($"api/counts/{Id}/lines/{line.Id}");
            Say($"{line.Sku} törölve.", "ok");
            return res;
        });
    }

    // The line just changed is marked on the screen.
    int? flash;
    internal bool TakeFlash(int lineId) => flash == lineId;

    internal void AfterEntry() => ScanFocus?.Invoke(this, EventArgs.Empty);

    // ------------------------------------------------------------------ location actions

    [RelayCommand]
    async Task CompleteAsync()
    {
        if (Current is not { } cur) return;
        var left = cur.Lines.Where((l) => l.HasProduct && !l.IsCounted).ToList();
        if (left.Count > 0 && !await Shell.ConfirmAsync("Hely kész?",
                $"{left.Count} tétel nincs számolva ezen a helyen ({string.Join(", ", left.Take(3).Select((l) => l.Sku))}{(left.Count > 3 ? ", ..." : "")}). Ha késznek jelölöd, 0 darabnak rögzítjük őket.",
                "Kész, 0 darab"))
            return;
        var done = false;
        await ActAsync(async () =>
        {
            var r = await Api.PostAsync<CountLocationState>($"api/counts/{Id}/locations/{cur.Location.Id}/complete");
            Say($"{r.Location.Code} kész.", "ok");
            done = true;
            return r;
        });
        if (done) Leave();
    }

    [RelayCommand]
    async Task RecountAsync()
    {
        if (Current is not { } cur) return;
        if (!await Shell.ConfirmAsync("Hely újraszámolása", $"A(z) {cur.Location.Code} hely minden számolása törlődik, és a hely friss készlettel indul újra. Folytatod?", "Újraszámolás")) return;
        await ActAsync(async () =>
        {
            var r = await Api.PostAsync<CountLocationState>($"api/counts/{Id}/locations/{cur.Location.Id}/recount");
            Say($"{r.Location.Code}: kezdd újra a számolást.", "info");
            return r;
        });
    }

    [RelayCommand]
    Task AddProductAsync() => Current is not { } cur ? Task.CompletedTask
        : Shell.NavigateAsync(new CountFoundViewModel(Shell, Id, cur.Location, null, null, Found));

    [RelayCommand]
    Task FinishAsync() => RunAsync(async () =>
    {
        var p = Progress;
        var left = p is null ? 0 : p.Lines - p.CountedLines;
        if (!await Shell.ConfirmAsync("Számlálás befejezése",
                left > 0 ? $"{Fmt.Int(left)} tétel nincs számolva. Ezek nem változnak a könyveléskor. Befejezed a számlálást?" : "Minden tétel számolva. Befejezed a számlálást?",
                "Befejezés"))
            return;
        await Api.PostAsync<CountFinished>($"api/counts/{Id}/finish");
        Shell.Toast("A számlálás befejezve. A jóváhagyó könyvelheti az eltéréseket.", ToastKind.Success);
        await CountNav.BackToCountAsync(Shell, Id);
    });
}

// A location of the count as a button: done, partly counted or not counted; the current one marked.
public sealed partial class CountLocItem(CountingViewModel page, CountLocation location) : ObservableObject
{
    public CountLocation Location { get; } = location;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Partial))]
    public partial int Counted { get; set; } = location.Counted;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Partial))]
    public partial bool Done { get; set; } = location.Done;

    [ObservableProperty]
    public partial bool IsCurrent { get; set; }

    public bool Partial => !Done && Counted > 0;

    internal void Update(int counted, bool done)
    {
        Counted = counted;
        Done = done;
    }

    [RelayCommand]
    Task OpenAsync() => page.OpenLocationAsync(Location.LocationId);
}

// A product line of the location being counted, with its quantity field.
public sealed partial class CountEntryItem : ObservableObject
{
    readonly CountingViewModel page;

    public CountEntryItem(CountingViewModel page, CountLine line, bool visible)
    {
        this.page = page;
        Line = line;
        Visible = visible;
        qty = line.CountedQty?.ToString() ?? "";
        IsFlash = page.TakeFlash(line.Id);
    }

    public CountLine Line { get; }
    public bool Visible { get; }
    public bool IsFlash { get; }
    public bool IsCounted => Line.IsCounted;

    string qty;

    // The typed quantity; saved on Enter or when the field is left.
    public string Qty
    {
        get => qty;
        set => SetProperty(ref qty, value);
    }

    public string InfoLine => string.Join(" · ", new[]
    {
        Line.LotText.Length > 0 ? $"Lot: {Line.LotText}" : null,
        Line.Ean.Length > 0 ? $"EAN {Line.Ean}" : null,
    }.Where((x) => x is not null));

    public bool HasInfo => InfoLine.Length > 0;
    public string ExpectedText => $"Nyilvántartás: {CountsFormat.Qty(Line.ExpectedQty)} {Line.Unit}";
    public string WhoText => Line.IsCounted && Line.CountedByName.Length > 0 ? $"{Line.CountedByName}, {CountsFormat.Time(Line.CountedAt)}" : "";
    public bool HasWho => WhoText.Length > 0;

    [RelayCommand]
    Task IncAsync() => page.AddToAsync(Line, 1);

    [RelayCommand]
    Task DecAsync() => page.DecAsync(Line);

    [RelayCommand]
    async Task SaveAsync()
    {
        await page.SetQtyAsync(Line, Qty.Trim());
        page.AfterEntry();
    }

    // Leaving the field saves it, unless nothing changed.
    internal Task SaveIfChangedAsync() => Qty.Trim() == (Line.CountedQty?.ToString() ?? "") ? Task.CompletedTask : page.SetQtyAsync(Line, Qty.Trim());

    [RelayCommand]
    Task RemoveAsync() => page.RemoveAsync(Line);
}
