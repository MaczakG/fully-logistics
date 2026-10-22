using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Inbound;

// One inbound (GET /api/inbound/:id): arrival, receiving by hand scanner or camera, putaway onto
// shelves with the server's location suggestion, closing, cancelling. The same flow as the web app:
//
// Receiving works by typed quantity. Scanning a product (or the line's "Mennyiség beírása" button)
// opens its quantity entry with 1 piece; every further scan of the same product adds one; typing
// a number replaces it. Nothing is counted until "Rögzítés". Scanning another product records the
// open entry first. A quantity over the expected one is confirmed. A location scanned while
// receiving switches to putaway.
//
// Putaway: scan the product (scanning it again steps to its next lot), then the location (or take
// the suggested one), confirm the quantity. Damaged pieces go to a quarantine location.
public sealed partial class InboundViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    static readonly string[] Open = ["expected", "arrived", "receiving"];
    static readonly string[] Editable = ["expected", "arrived"];
    static readonly string[] Closable = ["arrived", "receiving"];

    public int Id { get; } = id;
    public override string Title => Data?.Number ?? "Betárolás";
    public override string? Module => "inbound";

    bool modeChosen;
    LocationRef? putLocationRef;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Status), nameof(Working), nameof(IsExpected), nameof(CanArrive), nameof(CanArriveData),
        nameof(CanComplete), nameof(CanEditInbound), nameof(CanCancel), nameof(Totals), nameof(ReceivedHint), nameof(DamagedHint),
        nameof(PutawayHint), nameof(ToPut), nameof(ToPutText), nameof(Lead), nameof(StatusNotice), nameof(StatusNoticeTone),
        nameof(IssuesText), nameof(MissingTrackingText), nameof(AllPutAway), nameof(PutNotice), nameof(ShowReadOnlyLines))]
    public partial InboundDetail? Data { get; set; }

    // "receive" or "putaway"
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsReceiving), nameof(IsPutaway), nameof(ScanPlaceholder))]
    public partial string Mode { get; set; } = "receive";

    public bool IsReceiving => Mode == "receive";
    public bool IsPutaway => Mode == "putaway";

    public ObservableCollection<InboundLineItem> Lines { get; } = [];

    // The putaway list: what still waits for a shelf first.
    public ObservableCollection<InboundLineItem> PutLines { get; } = [];

    // The quantity being typed for a line (not saved yet).
    [ObservableProperty]
    public partial ReceiveEntry? Entry { get; set; }

    // Putaway form
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPutLine), nameof(PutLineText), nameof(PutSuggestion), nameof(PutDamaged), nameof(CanUseQuarantine),
        nameof(QuarantineText), nameof(NoQuarantineWarning))]
    public partial InboundLineItem? PutLine { get; set; }

    [ObservableProperty]
    public partial string PutLocation { get; set; } = "";

    [ObservableProperty]
    public partial string PutQty { get; set; } = "";

    // The line under the scan field: what happened, what to do next.
    [ObservableProperty]
    public partial string Feedback { get; set; } = "";

    // info, ok, warn, danger
    [ObservableProperty]
    public partial string FeedbackTone { get; set; } = "info";

    public string? Status => Data?.Status;
    public bool CanEdit => Shell.Me?.Can("inbound", "edit") == true;
    public bool Working => Data is not null && Closable.Contains(Data.Status) && CanEdit;
    public bool ShowReadOnlyLines => Data is not null && !Working;
    public bool IsExpected => Data?.Status == "expected";
    public bool CanArrive => IsExpected && CanEdit;
    public bool CanArriveData => Data is not null && Open.Contains(Data.Status) && !IsExpected && CanEdit;
    public bool CanComplete => Data is not null && Closable.Contains(Data.Status) && CanEdit;
    public bool CanEditInbound => Data is not null && Editable.Contains(Data.Status) && Shell.Me?.Can("inbound", "create") == true;
    public bool CanCancel => Data is { CanCancel: true } && Shell.Me?.Can("inbound", "delete") == true;
    public bool AllPutAway => Data is not null && Data.Totals.Received > 0 && Data.Lines.All((l) => l.PutawayQty == l.ReceivedQty);

    public InboundTotals? Totals => Data?.Totals;
    public int ToPut => Data?.Lines.Sum((l) => l.LeftToPut) ?? 0;
    public string ToPutText => ToPut > 0 ? $"{Fmt.Int(ToPut)} vár" : "";
    public string ScanPlaceholder => IsReceiving ? "Termék: EAN vagy cikkszám" : "Termék vagy raktárhely";

    public string Lead => Data is null ? "" : string.Join(", ", new[]
    {
        $"{Data.PartnerName} ({Data.PartnerCode})",
        Data.SupplierName is { Length: > 0 } s ? $"beszállító: {s}" : null,
        Data.ExpectedDate is { Length: > 0 } d ? $"várható: {Fmt.Date(d)}" : null,
    }.Where((x) => x is not null));

    public string ReceivedHint
    {
        get
        {
            if (Totals is null) return "";
            var diff = Totals.Received - Totals.Expected;
            return diff == 0 ? "egyezik a várttal" : diff > 0 ? $"{Fmt.Int(diff)} többlet" : $"{Fmt.Int(-diff)} hiány";
        }
    }

    public string DamagedHint => Totals is null ? "" : Totals.Damaged == 0 ? "nincs sérült áru" : Data is not null && Open.Contains(Data.Status) ? "karanténba tedd" : "sérült áru";
    public string PutawayHint => Totals is null ? "" : Totals.Received == 0 ? "még semmi" : $"{Totals.Putaway * 100 / Math.Max(Totals.Received, 1)}% az átvettből";

    // The status notice under the figures (arrival, cancelled, completed).
    public string? StatusNotice => Data?.Status switch
    {
        "expected" => CanEdit
            ? "A szállítmány még nem érkezett meg. Ha a rámpára állt, jelöld megérkezettnek (raklap, karton), és kezdheted az átvételt."
            : "A szállítmány még nem érkezett meg.",
        "cancelled" => $"Sztornózva {Fmt.DateTime(Data.CancelledAt)}.{(string.IsNullOrEmpty(Data.CancelReason) ? "" : $" Indoklás: {Data.CancelReason}")}",
        "completed" => Data.HasDiscrepancy
            ? $"Lezárva eltéréssel {Fmt.DateTime(Data.CompletedAt)}{(Data.CompletedByName is { } n ? $", {n}" : "")}. Indoklás: {Data.DiscrepancyNote}"
            : $"Betárolva eltérés nélkül {Fmt.DateTime(Data.CompletedAt)}{(Data.CompletedByName is { } m ? $", {m}" : "")}.",
        _ => null,
    };

    public string StatusNoticeTone => Data?.Status switch { "completed" => Data.HasDiscrepancy ? "warn" : "ok", _ => "info" };

    // Lines that differ from what was expected, one per row.
    public string? IssuesText
    {
        get
        {
            if (Data is null) return null;
            var rows = Data.Lines.Where((l) => l.Issues is { Count: > 0 })
                .Select((l) => $"{l.Sku}{(l.Lot.Length > 0 ? $" (sarzs {l.Lot})" : "")}: {string.Join(", ", l.Issues!.Select((i) => i.Text))}")
                .ToList();
            if (rows.Count == 0 || !(Closable.Contains(Data.Status) || Data.Status == "completed")) return null;
            var head = Data.Status == "completed" ? "" : "Eltérés a várt mennyiségtől. Lezárni csak jóváhagyással, indoklással lehet.\n";
            return head + string.Join("\n", rows.Select((r) => "• " + r));
        }
    }

    public string? MissingTrackingText
    {
        get
        {
            if (Data is null || !Closable.Contains(Data.Status)) return null;
            var skus = Data.Lines.Where((l) => l.LeftToPut > 0 && l.MissingTracking).Select((l) => l.Sku).ToList();
            return skus.Count == 0 ? null : $"Polcra helyezés előtt add meg a sarzsot vagy a lejáratot: {string.Join(", ", skus)}.";
        }
    }

    public string? PutNotice => Data is null || ToPut > 0 ? null
        : Data.Totals.Received > 0 ? "Minden átvett áru polcon van. Lezárhatod a betárolást." : "Még nincs átvett áru. Előbb számold meg a beérkezett termékeket.";

    public bool HasPutLine => PutLine is not null;
    public string PutLineText => PutLine is { } p ? $"{p.Line.Sku} {p.Line.Name}{(p.Line.Lot.Length > 0 ? $", sarzs {p.Line.Lot}" : "")}: {Fmt.Int(p.Line.LeftToPut)} {p.Line.UnitText} vár polcra" : "Válassz tételt: olvasd be a termék kódját, vagy válaszd ki lent.";
    public Suggestion? PutSuggestion => PutLine?.Line.Suggested;
    public int PutDamaged => PutLine?.Line.DamagedLeft ?? 0;
    public bool CanUseQuarantine => PutDamaged > 0 && Data?.Quarantine is not null;
    public string QuarantineText => PutLine is null || Data?.Quarantine is null ? "" : $"{Fmt.Int(Math.Min(PutDamaged, PutLine.Line.LeftToPut))} sérült karanténba ({Data.Quarantine.Code})";
    public bool NoQuarantineWarning => PutDamaged > 0 && Data?.Quarantine is null;

    // ------------------------------------------------------------------ loading

    public override async Task LoadAsync()
    {
        var d = await Api.GetAsync<InboundDetail>($"api/inbound/{Id}");
        Apply(d);
    }

    void Apply(InboundDetail d)
    {
        Data = d;
        if (!modeChosen)
        {
            // Straight to putaway when everything is counted and something waits for a shelf.
            var counting = d.Lines.Any((l) => l.ReceivedQty < l.ExpectedQty);
            Mode = !counting && d.Lines.Any((l) => l.ReceivedQty > l.PutawayQty) ? "putaway" : "receive";
            modeChosen = true;
            Say(IsReceiving
                ? "Olvasd be a terméket (vagy válaszd ki lent), írd be a beérkezett mennyiséget, és rögzítsd."
                : "Olvasd be a termék kódját (vagy válassz tételt), utána a raktárhely kódját, és erősítsd meg a mennyiséget.", "info");
        }
        var putId = PutLine?.Line.Id;
        Lines.Clear();
        foreach (var l in d.Lines) Lines.Add(new InboundLineItem(this, l));
        PutLines.Clear();
        foreach (var item in Lines.Where((x) => x.Line.LeftToPut > 0).Concat(Lines.Where((x) => x.Line.LeftToPut == 0))) PutLines.Add(item);
        // Keep the open entry and the selected putaway line across reloads.
        if (Entry is not null)
        {
            var line = d.Lines.FirstOrDefault((l) => l.Id == Entry.Line.Id);
            if (line is null) Entry = null;
            else Entry = Entry.With(line, d.Lines.Where((x) => x.ProductId == line.ProductId).ToList());
        }
        PutLine = putId is null ? null : Lines.FirstOrDefault((x) => x.Line.Id == putId && x.Line.LeftToPut > 0);
        if (PutLine is null && putId is not null) PutQty = "";
        MarkLines();
    }

    void MarkLines()
    {
        foreach (var item in Lines)
        {
            item.IsEntry = Entry?.Line.Id == item.Line.Id;
            item.IsPutSelected = PutLine?.Line.Id == item.Line.Id;
        }
    }

    InboundLine? LineById(int lineId) => Data?.Lines.FirstOrDefault((l) => l.Id == lineId);

    void Say(string text, string tone)
    {
        Feedback = text;
        FeedbackTone = tone;
        var haptic = tone switch { "ok" => HapticKind.Success, "warn" => HapticKind.Warning, "danger" => HapticKind.Error, _ => (HapticKind?)null };
        if (haptic is { } h) Shell.Services.Platform.Haptic(h);
    }

    // ------------------------------------------------------------------ modes

    [RelayCommand]
    async Task SetModeAsync(string mode)
    {
        if (Mode == mode) return;
        Mode = mode;
        Say(IsReceiving
            ? "Olvasd be a terméket (vagy válaszd ki lent), írd be a beérkezett mennyiséget, és rögzítsd."
            : "Olvasd be a termék kódját (vagy válassz tételt), utána a raktárhely kódját, és erősítsd meg a mennyiséget.", "info");
        // The received quantities changed the suggestions (they depend on how much is to be put away).
        if (IsPutaway) await RefreshAsync();
    }

    async Task RefreshAsync()
    {
        try
        {
            Apply(await Api.GetAsync<InboundDetail>($"api/inbound/{Id}"));
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
    }

    // ------------------------------------------------------------------ scanning

    // Scans are handled one after the other, so fast scanning never loses a code.
    readonly SemaphoreSlim scanLock = new(1, 1);

    [RelayCommand]
    Task ScanAsync(string code)
    {
        var mode = Mode;
        return SerialAsync(() => mode == "receive" ? ScanReceiveAsync(code) : ScanPutawayAsync(code));
    }

    // Scans and the actions that write run one at a time (a scan and a tap never record twice);
    // a server error shows in the feedback line.
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

    async Task ScanReceiveAsync(string code)
    {
        var matches = Data?.Lines.Where((l) => l.Matches(code)).ToList() ?? [];
        if (matches.Count > 0)
        {
            await ProductScannedAsync(matches);
            return;
        }
        InboundScanResult r;
        try
        {
            r = await Api.PostAsync<InboundScanResult>($"api/inbound/{Id}/scan", new { code, peek = true });
        }
        catch (ApiException e) when (e.Status == 400)
        {
            Say(e.Message, "danger");
            return;
        }
        switch (r.Result)
        {
            case "location" when r.Location is not null:
                Mode = "putaway";
                Entry = null;
                PutLocation = r.Location.Code;
                putLocationRef = r.Location;
                MarkLines();
                Say($"{r.Location.Code} raktárhely: átváltottunk polcra helyezésre. Válaszd ki a tételt.", "warn");
                await RefreshAsync();
                return;
            case "match" when r.LineId is not null:
                await RefreshAsync();
                if (LineById(r.LineId.Value) is { } l) await ProductScannedAsync([l]);
                return;
            case "unexpected" when r.Product is not null:
                Shell.Services.Platform.Haptic(HapticKind.Warning);
                var yes = await Shell.ConfirmAsync("Nem várt termék",
                    $"A(z) {r.Product.Sku} {r.Product.Name} nem szerepel ebben a betárolásban. Felveszed új tételként?", "Felveszem");
                if (!yes)
                {
                    Say($"{r.Product.Sku} nem került rögzítésre.", "warn");
                    return;
                }
                if (Entry is { Quantity: > 0 } && !await CommitEntryCoreAsync()) return;
                var added = await Api.PostAsync<InboundLineResult>($"api/inbound/{Id}/lines", new { product_id = r.Product.Id, received_qty = 0 });
                await RefreshAsync();
                if (LineById(added.Line.Id) is { } nl) OpenEntry(nl, scanned: true);
                Say($"{r.Product.Sku} új tételként felvéve. Írd be a beérkezett mennyiséget.", "info");
                return;
        }
    }

    async Task ProductScannedAsync(IReadOnlyList<InboundLine> matches)
    {
        if (Entry is { } e && matches.Any((m) => m.Id == e.Line.Id))
        {
            // The same product again: one more piece in the typed quantity (counting by scanning).
            e.Qty = ((e.Quantity ?? 0) + 1).ToString();
            Say($"{e.Line.Sku}: {Fmt.Int(e.Quantity ?? 0)} {e.Line.UnitText} beolvasva. Rögzítsd, vagy írd át a mennyiséget.", "ok");
            return;
        }
        // Another product while a quantity is typed: that quantity is recorded first.
        if (Entry is { Quantity: > 0 } && !await CommitEntryCoreAsync()) return;
        var line = matches.FirstOrDefault((x) => x.ReceivedQty < x.ExpectedQty) ?? matches[^1];
        OpenEntry(line, scanned: true);
        Say($"{line.Sku} {line.Name}{(matches.Count > 1 ? " (több sarzs: válaszd ki, melyik)" : "")}: írd be a mennyiséget, vagy olvasd be darabonként.", "ok");
    }

    void OpenEntry(InboundLine line, bool scanned)
    {
        var lots = Data?.Lines.Where((x) => x.ProductId == line.ProductId).ToList() ?? [line];
        Entry = new ReceiveEntry(line, lots, scanned ? "1" : "");
        MarkLines();
        EntryOpened?.Invoke(this, EventArgs.Empty);
    }

    // The view focuses and selects the quantity when an entry opens.
    public event EventHandler? EntryOpened;

    internal Task OpenEntryAsync(InboundLineItem item) => SerialAsync(async () =>
    {
        if (Entry is { } e && e.Line.Id != item.Line.Id && e.Quantity > 0 && !await CommitEntryCoreAsync()) return;
        OpenEntry(item.Line, scanned: false);
        Say($"{item.Line.Sku} {item.Line.Name}: írd be a beérkezett mennyiséget.", "info");
    });

    // The lot chosen in the entry (a product with several lines).
    internal void SwitchEntryLine(InboundLine line)
    {
        if (Entry is null) return;
        Entry = new ReceiveEntry(line, Entry.Lots, Entry.Qty) { Damaged = Entry.Damaged };
        MarkLines();
    }

    [RelayCommand]
    void CancelEntry()
    {
        Entry = null;
        MarkLines();
        Say("Mennyiség beírása megszakítva, semmi sem került rögzítésre.", "info");
    }

    [RelayCommand]
    Task CommitEntryAsync() => SerialAsync(async () => await CommitEntryCoreAsync());

    // Enter in the quantity field. A hand scanner that typed into it leaves its code at the end:
    // then the digits typed before it stay (or the quantity from before the scan), and the code
    // is handled as a scan.
    [RelayCommand]
    async Task QuantityEnterAsync()
    {
        if (Entry is not { } e) return;
        var value = e.Qty.Trim();
        if (value.Length <= 6 && value.All(char.IsAsciiDigit))
        {
            await CommitEntryAsync();
            return;
        }
        // Not a quantity: the scanner's code went into the field.
        var up = value.ToUpperInvariant();
        var codes = Data?.Lines.SelectMany((l) => new[] { l.Ean, l.Sku }).Where((c) => !string.IsNullOrEmpty(c)).Select((c) => c!.ToUpperInvariant()) ?? [];
        var hit = codes.Where((c) => up.EndsWith(c, StringComparison.Ordinal)).OrderByDescending((c) => c.Length).FirstOrDefault();
        var typed = hit is null ? "" : value[..^hit.Length];
        e.Qty = typed.Length is > 0 and <= 6 && typed.All(char.IsAsciiDigit) ? typed : typed.Length == 0 ? e.QtyAtOpen : "";
        await ScanAsync(hit ?? value);
    }

    // Records the typed quantity on the line (as a delta, so two scanners on one inbound add up).
    async Task<bool> CommitEntryCoreAsync()
    {
        if (Entry is not { } e) return false;
        var l = e.Line;
        e.ClearErrors();
        var qty = e.Quantity;
        if (qty is not (>= 1 and <= 100000)) e.QtyError = "Írd be a beérkezett darabszámot.";
        if (l.NeedsLot && e.Lot.Trim().Length == 0) e.LotError = "Add meg a sarzsot.";
        if (l.NeedsExpiry && e.Expiry.Trim().Length == 0) e.ExpiryError = "Add meg a lejáratot (ÉÉÉÉ-HH-NN).";
        if (e.HasErrors)
        {
            Say($"{l.Sku}: {string.Join(" ", new[] { e.QtyError, e.LotError, e.ExpiryError }.Where((x) => x is not null))}", "danger");
            return false;
        }
        var total = l.ReceivedQty + qty!.Value;
        if (l.ExpectedQty > 0 && total > l.ExpectedQty)
        {
            Shell.Services.Platform.Haptic(HapticKind.Warning);
            var yes = await Shell.ConfirmAsync("Több a vártnál",
                $"{l.Sku}: a várt {Fmt.Int(l.ExpectedQty)} {l.UnitText} helyett összesen {Fmt.Int(total)} {l.UnitText} lesz átvéve. Rögzíted?", "Rögzítem");
            if (!yes) return false;
        }
        var body = new Dictionary<string, object?> { ["add"] = qty.Value, ["damaged_add"] = e.Damaged ? qty.Value : 0 };
        if (l.NeedsLot) body["lot"] = e.Lot.Trim();
        if (l.NeedsExpiry) body["expiry"] = e.Expiry.Trim();
        try
        {
            var r = await Api.PostAsync<InboundLineResult>($"api/inbound/{Id}/lines/{l.Id}/receive", body);
            Entry = null;
            var after = r.Line;
            var over = after.ReceivedQty > after.ExpectedQty;
            Say($"{Fmt.Int(qty.Value)} {l.UnitText}{(e.Damaged ? " sérült" : "")} rögzítve: {l.Sku} {l.Name}, átvett {Fmt.Int(after.ReceivedQty)} / {Fmt.Int(after.ExpectedQty)}"
                + (over ? ", több a vártnál." : after.ReceivedQty == after.ExpectedQty ? ", kész." : "."), over ? "warn" : "ok");
            await RefreshAsync();
            return true;
        }
        catch (ApiException ex) when (ex.Status != 401)
        {
            e.QtyError = ex.Fields.GetValueOrDefault("received_qty") ?? ex.Fields.GetValueOrDefault("damaged_qty");
            e.LotError = ex.Fields.GetValueOrDefault("lot");
            e.ExpiryError = ex.Fields.GetValueOrDefault("expiry");
            Say(ex.Message, "danger");
            return false;
        }
    }

    // ------------------------------------------------------------------ putaway

    async Task ScanPutawayAsync(string code)
    {
        var matches = Data?.Lines.Where((l) => l.Matches(code)).ToList() ?? [];
        if (matches.Count > 0)
        {
            var open = matches.Where((l) => l.LeftToPut > 0).ToList();
            if (open.Count == 0)
            {
                Say($"{matches[0].Sku}: ebből nincs több polcra helyezendő áru.", "warn");
                return;
            }
            var idx = open.FindIndex((l) => l.Id == PutLine?.Line.Id);
            var pick = idx >= 0 ? open[(idx + 1) % open.Count] : open[0];
            SelectPutLine(pick);
            Say($"{pick.Sku} kiválasztva{(pick.Lot.Length > 0 ? $", sarzs {pick.Lot}" : "")}. Most olvasd be a raktárhelyet.{(open.Count > 1 ? " Több sarzs is vár: újabb beolvasással léptetsz." : "")}", "ok");
            return;
        }
        var found = await Api.GetAsync<ItemList<LocationLookup>>(Query.Build("api/lookup/locations", ("q", code.Trim())));
        var loc = found.Items.FirstOrDefault((x) => string.Equals(x.Code, code.Trim(), StringComparison.OrdinalIgnoreCase));
        if (loc is null)
        {
            Say($"Ismeretlen kód: {code}. Termék vagy raktárhely kódját olvasd be.", "danger");
            return;
        }
        if (loc.Kind is not ("storage" or "quarantine"))
        {
            Say($"{loc.Code} nem tároló- vagy karanténhely.", "danger");
            return;
        }
        PutLocation = loc.Code;
        putLocationRef = new LocationRef(loc.Id, loc.Code, loc.Kind);
        if (PutLine is null)
        {
            Say($"{loc.Code} megjegyezve. Most válaszd ki a tételt (termék beolvasása).", "warn");
            return;
        }
        Say($"{loc.Code}: erősítsd meg a mennyiséget, és helyezd polcra.", "ok");
    }

    internal void SelectPutLine(InboundLine line)
    {
        var item = Lines.FirstOrDefault((x) => x.Line.Id == line.Id);
        PutLine = item;
        var open = line.LeftToPut;
        var dmg = line.DamagedLeft;
        PutQty = (dmg > 0 && open > dmg ? open - dmg : open).ToString();
        MarkLines();
    }

    [RelayCommand]
    void UseSuggested()
    {
        if (PutSuggestion is not { } s) return;
        PutLocation = s.Code;
        putLocationRef = new LocationRef(s.Id, s.Code);
    }

    [RelayCommand]
    void UseQuarantine()
    {
        if (Data?.Quarantine is not { } q || PutLine is null) return;
        PutLocation = q.Code;
        putLocationRef = q;
        PutQty = Math.Min(PutDamaged, PutLine.Line.LeftToPut).ToString();
    }

    [RelayCommand]
    Task PutAwayAsync() => SerialAsync(async () =>
    {
        if (PutLine is not { } item) return;
        var l = item.Line;
        var code = PutLocation.Trim();
        var qty = Fmt.ParseNumber(PutQty);
        if (code.Length == 0)
        {
            Say("Olvasd be vagy írd be a raktárhelyet.", "danger");
            return;
        }
        if (qty is not { } q || q < 1 || q % 1 != 0)
        {
            Say("A mennyiség pozitív egész szám legyen.", "danger");
            return;
        }
        var body = new Dictionary<string, object?> { ["line_id"] = l.Id, ["qty"] = (int)q };
        if (putLocationRef is not null && string.Equals(putLocationRef.Code, code, StringComparison.OrdinalIgnoreCase)) body["location_id"] = putLocationRef.Id;
        else body["location_code"] = code;
        try
        {
            var r = await Api.PostAsync<InboundLineResult>($"api/inbound/{Id}/putaway", body);
            var left = r.Line.LeftToPut;
            Say($"{Fmt.Int((int)q)} {l.UnitText} {l.Sku} polcra: {r.Location?.Code ?? code}.{(left > 0 ? $" Még {Fmt.Int(left)} vár." : "")}", "ok");
            PutLocation = "";
            putLocationRef = null;
            if (left <= 0)
            {
                PutLine = null;
                PutQty = "";
            }
            else PutQty = left.ToString();
            // The suggestions follow what is on the shelves now.
            await RefreshAsync();
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
    });

    // ------------------------------------------------------------------ lines

    internal Task SaveTrackingAsync(InboundLineItem item, string field, string value) => SerialAsync(async () =>
    {
        var l = item.Line;
        var current = field == "lot" ? l.Lot : l.Expiry;
        if (current == value) return;
        try
        {
            await Api.PostAsync<InboundLineResult>($"api/inbound/{Id}/lines/{l.Id}/receive",
                new Dictionary<string, object?> { [field] = field == "lot" ? value : value.Length == 0 ? null : value });
            Say($"{l.Sku}: {(field == "lot" ? $"sarzs {(value.Length > 0 ? value : "törölve")}" : $"lejárat {(value.Length > 0 ? Fmt.Date(value) : "törölve")}")} mentve.", "ok");
            await RefreshAsync();
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Say(e.Message, "danger");
        }
    });

    internal Task EditLineAsync(InboundLineItem item) => Shell.NavigateAsync(new InboundLineEditViewModel(Shell, Id, item.Line));

    internal Task DeleteLineAsync(InboundLineItem item) => SerialAsync(async () =>
    {
        var l = item.Line;
        if (!await Shell.ConfirmAsync("Tétel törlése", $"Törlöd a(z) {l.Sku} tételt ({Fmt.Int(l.ReceivedQty)} {l.UnitText} átvéve)?", "Törlés", danger: true)) return;
        await Api.DeleteAsync($"api/inbound/{Id}/lines/{l.Id}");
        if (Entry?.Line.Id == l.Id) Entry = null;
        Shell.Toast("Tétel törölve.", ToastKind.Success);
        await RefreshAsync();
    });

    [RelayCommand]
    Task AddLineAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new InboundAddLineViewModel(Shell, Data));

    // ------------------------------------------------------------------ header actions

    [RelayCommand]
    Task ArriveAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new InboundArriveViewModel(Shell, Data));

    [RelayCommand]
    Task CompleteAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new InboundCompleteViewModel(Shell, Data));

    [RelayCommand]
    Task CancelInboundAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new InboundCancelViewModel(Shell, Data));

    [RelayCommand]
    Task EditAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new InboundFormViewModel(Shell, Data));

    // The receiving report (Átvételi jegyzőkönyv) as a printable page.
    [RelayCommand]
    Task ReportAsync() => Data is null ? Task.CompletedTask
        : Shell.Services.Platform.OpenFileAsync(InboundReport.Build(Data, Shell.Me!));
}

// A line on the receiving and putaway screens, with what the screen keeps per line.
public sealed partial class InboundLineItem(InboundViewModel page, InboundLine line) : ObservableObject
{
    public InboundLine Line { get; } = line;
    public InboundViewModel Page { get; } = page;

    [ObservableProperty]
    public partial bool IsEntry { get; set; }

    [ObservableProperty]
    public partial bool IsPutSelected { get; set; }

    [ObservableProperty]
    public partial string LotText { get; set; } = line.Lot;

    [ObservableProperty]
    public partial string ExpiryText { get; set; } = line.Expiry;

    public bool ShowTracking => (Line.TrackLot || Line.TrackExpiry) && Line.PutawayQty == 0;
    public bool CanDelete => Line.ExpectedQty == 0 && Line.PutawayQty == 0;
    public bool IsDone => Line.State == "done" && Line.DamagedQty == 0;
    public bool HasPutaways => Line.Putaways is { Count: > 0 };
    public double ReceivedRatio => Line.ReceivedQty == 0 ? 0 : Math.Min(1, Line.ReceivedQty / (double)Math.Max(Line.ExpectedQty, Line.ReceivedQty));
    public double PutRatio => Line.ReceivedQty == 0 ? 0 : Math.Min(1, Line.PutawayQty / (double)Line.ReceivedQty);
    public string ReceivedText => $"{Fmt.Int(Line.ReceivedQty)} / {Fmt.Int(Line.ExpectedQty)} {Line.UnitText}";
    public string PutText => Line.LeftToPut > 0 ? $"{Fmt.Int(Line.LeftToPut)} {Line.UnitText} polcra vár" : Line.ReceivedQty > 0 ? $"{Fmt.Int(Line.PutawayQty)} polcon, kész" : "nincs átvett áru";
    public string IssuesText => string.Join(", ", new[]
    {
        Line.Issues is { Count: > 0 } ? string.Join(", ", Line.Issues.Select((i) => i.Text)) : null,
        Line.TrackLot && Line.Lot.Length == 0 ? "sarzs hiányzik" : null,
        Line.TrackExpiry && Line.Expiry.Length == 0 ? "lejárat hiányzik" : null,
    }.Where((x) => x is not null));
    public string PutawaysText => string.Join("  ", (Line.Putaways ?? []).Select((p) => $"{p.LocationCode}: {Fmt.Int(p.Qty)}"));
    public string SuggestedText => Line.LeftToPut > 0 && Line.Suggested is { } s ? $"javasolt: {s.Code}" : "";
    public string DamagedText => Line.DamagedLeft > 0 ? $"{Fmt.Int(Line.DamagedLeft)} sérült, karanténba" : "";

    [RelayCommand]
    Task EnterAsync() => Page.OpenEntryAsync(this);

    [RelayCommand]
    Task EditAsync() => Page.EditLineAsync(this);

    [RelayCommand]
    Task DeleteAsync() => Page.DeleteLineAsync(this);

    [RelayCommand]
    void Select() => Page.SelectPutLine(Line);

    [RelayCommand]
    Task SaveLotAsync() => Page.SaveTrackingAsync(this, "lot", LotText.Trim());

    [RelayCommand]
    Task SaveExpiryAsync() => Page.SaveTrackingAsync(this, "expiry", ExpiryText.Trim());
}

// The typed quantity of a line while receiving.
public sealed partial class ReceiveEntry : ObservableObject
{
    public ReceiveEntry(InboundLine line, IReadOnlyList<InboundLine> lots, string qty)
    {
        Line = line;
        Lots = lots;
        Qty = qty;
        QtyAtOpen = qty;
    }

    public InboundLine Line { get; }
    public IReadOnlyList<InboundLine> Lots { get; }
    public string QtyAtOpen { get; }
    public bool HasLots => Lots.Count > 1;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Quantity))]
    public partial string Qty { get; set; }

    [ObservableProperty]
    public partial bool Damaged { get; set; }

    [ObservableProperty]
    public partial string Lot { get; set; } = "";

    [ObservableProperty]
    public partial string Expiry { get; set; } = "";

    [ObservableProperty]
    public partial string? QtyError { get; set; }

    [ObservableProperty]
    public partial string? LotError { get; set; }

    [ObservableProperty]
    public partial string? ExpiryError { get; set; }

    public int? Quantity => Qty.Trim() is { Length: > 0 and <= 6 } t && t.All(char.IsAsciiDigit) ? int.Parse(t) : null;
    public bool HasErrors => QtyError is not null || LotError is not null || ExpiryError is not null;
    public string Left => Fmt.Int(Line.LeftToReceive);

    public void ClearErrors() => QtyError = LotError = ExpiryError = null;

    // The same entry over a fresh copy of the line (after a reload).
    public ReceiveEntry With(InboundLine line, IReadOnlyList<InboundLine> lots) =>
        new(line, lots, Qty) { Damaged = Damaged, Lot = Lot, Expiry = Expiry };

    public static string LotLabel(InboundLine l) =>
        $"{(l.Lot.Length > 0 ? l.Lot : "sarzs nélkül")}{(l.Expiry.Length > 0 ? $", lejárat {Fmt.Date(l.Expiry)}" : "")} ({Fmt.Int(l.ReceivedQty)} / {Fmt.Int(l.ExpectedQty)})";
}
