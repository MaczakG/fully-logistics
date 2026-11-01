using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Inbound;

// The inbound's smaller steps as pages (the web app's dialogs): arrival, closing, cancelling,
// correcting a line, adding a line. Each goes back to the inbound when saved.

// POST /api/inbound/:id/arrive: pallets, cartons, arrival note. expected -> arrived.
public sealed partial class InboundArriveViewModel : PageViewModel
{
    public InboundArriveViewModel(ShellViewModel shell, InboundDetail d) : base(shell)
    {
        Inbound = d;
        Pallets = d.Pallets.ToString();
        Cartons = d.Cartons.ToString();
        Note = d.ArrivalNote ?? "";
    }

    public InboundDetail Inbound { get; }
    public bool First => Inbound.Status == "expected";
    public override string Title => First ? "Szállítmány megérkezett" : "Érkezési adatok";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;
    public string SubmitText => First ? "Megérkezett, kezdjük az átvételt" : "Mentés";

    [ObservableProperty]
    public partial string Pallets { get; set; }

    [ObservableProperty]
    public partial string Cartons { get; set; }

    [ObservableProperty]
    public partial string Note { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var pallets = Fmt.ParseNumber(Pallets.Length == 0 ? "0" : Pallets);
        var cartons = Fmt.ParseNumber(Cartons.Length == 0 ? "0" : Cartons);
        Error = pallets is not { } p || p < 0 || p % 1 != 0 || cartons is not { } c || c < 0 || c % 1 != 0 ? "A raklap és a karton nulla vagy pozitív egész szám legyen." : null;
        if (Error is not null) return;
        await Api.PostAsync($"api/inbound/{Inbound.Id}/arrive", new { pallets = (int)pallets!.Value, cartons = (int)cartons!.Value, note = Note.Trim() });
        Shell.Toast(First ? "Megérkezett. Kezdheted a számlálást." : "Érkezési adatok mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// POST /api/inbound/:id/complete. With a discrepancy only with inbound:approve and a reason.
public sealed partial class InboundCompleteViewModel(ShellViewModel shell, InboundDetail d) : PageViewModel(shell)
{
    public InboundDetail Inbound { get; } = d;
    public override string Title => $"{Inbound.Number} lezárása";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 760;

    public IReadOnlyList<InboundLine> Issues { get; } = d.Lines.Where((l) => l.HasDiscrepancy).ToList();
    public bool HasIssues => Issues.Count > 0;
    public bool CanApprove => Shell.Me?.Can("inbound", "approve") == true;
    public bool CanSubmit => !HasIssues || CanApprove;
    public bool NeedsReason => HasIssues && CanApprove;
    public bool Blocked => HasIssues && !CanApprove;
    public string SubmitText => HasIssues ? "Lezárás eltéréssel" : "Lezárás";

    [ObservableProperty]
    public partial string Note { get; set; } = "";

    [ObservableProperty]
    public partial string? NoteError { get; set; }

    public static string IssueText(InboundLine l) => string.Join(", ",
        (l.Issues ?? []).Select((i) => i.Text).Concat(l.PutawayQty < l.ReceivedQty ? [$"polcra nem került {l.ReceivedQty - l.PutawayQty}"] : []));

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        NoteError = NeedsReason && Note.Trim().Length < 3 ? "Írd le röviden az eltérés okát." : null;
        if (NoteError is not null) return;
        try
        {
            var r = await Api.PostAsync<InboundCompleteResult>($"api/inbound/{Inbound.Id}/complete", new { note = Note.Trim() });
            Shell.Toast(r.HasDiscrepancy ? "Lezárva eltéréssel." : "Betárolás lezárva.", ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.ContainsKey("note"))
        {
            NoteError = e.Fields["note"];
        }
    });
}

// POST /api/inbound/:id/cancel (inbound:delete), only while nothing of it is on a shelf.
public sealed partial class InboundCancelViewModel(ShellViewModel shell, InboundDetail d) : PageViewModel(shell)
{
    public InboundDetail Inbound { get; } = d;
    public override string Title => $"{Inbound.Number} sztornózása";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;

    [ObservableProperty]
    public partial string Reason { get; set; } = "";

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        await Api.PostAsync($"api/inbound/{Inbound.Id}/cancel", new { reason = Reason.Trim() });
        Shell.Toast("Betárolás sztornózva.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// POST /api/inbound/:id/lines/:lineId/receive with absolute quantities: correcting a line.
public sealed partial class InboundLineEditViewModel : PageViewModel
{
    readonly int inboundId;

    public InboundLineEditViewModel(ShellViewModel shell, int inboundId, InboundLine line) : base(shell)
    {
        this.inboundId = inboundId;
        Line = line;
        Received = line.ReceivedQty.ToString();
        Damaged = line.DamagedQty.ToString();
        Lot = line.Lot;
        Expiry = line.Expiry;
        Note = line.Note ?? "";
    }

    public InboundLine Line { get; }
    public override string Title => $"{Line.Sku} átvétele";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;
    public bool CanTrack => Line.PutawayQty == 0;
    public string Info => $"{Line.Name}. Várt: {Fmt.Int(Line.ExpectedQty)} {Line.UnitText}{(Line.PutawayQty > 0 ? $", polcon már {Fmt.Int(Line.PutawayQty)}" : "")}.";

    [ObservableProperty]
    public partial string Received { get; set; }

    [ObservableProperty]
    public partial string Damaged { get; set; }

    [ObservableProperty]
    public partial string Lot { get; set; }

    [ObservableProperty]
    public partial string Expiry { get; set; }

    [ObservableProperty]
    public partial string Note { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var r = Fmt.ParseNumber(Received);
        var d = Fmt.ParseNumber(Damaged.Length == 0 ? "0" : Damaged);
        Error = r is not { } rv || rv < 0 || rv % 1 != 0 ? "Az átvett mennyiség nulla vagy pozitív egész szám legyen."
            : d is not { } dv || dv < 0 || dv % 1 != 0 ? "A sérült mennyiség nulla vagy pozitív egész szám legyen."
            : dv > rv ? "A sérült mennyiség nem lehet több az átvettnél."
            : null;
        if (Error is not null) return;
        var body = new Dictionary<string, object?> { ["received_qty"] = (int)r!.Value, ["damaged_qty"] = (int)d!.Value, ["note"] = Note.Trim() };
        if (CanTrack)
        {
            body["lot"] = Lot.Trim();
            body["expiry"] = Expiry.Trim().Length == 0 ? null : Expiry.Trim();
        }
        try
        {
            await Api.PostAsync<InboundLineResult>($"api/inbound/{inboundId}/lines/{Line.Id}/receive", body);
            Shell.Toast("Tétel mentve.", ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            Error = $"{e.Message} {string.Join(" ", e.Fields.Values)}";
        }
    });
}

// POST /api/inbound/:id/lines: an unexpected product of the client, or another lot of a product.
public sealed partial class InboundAddLineViewModel(ShellViewModel shell, InboundDetail d) : PageViewModel(shell)
{
    public InboundDetail Inbound { get; } = d;
    public override string Title => "Nem várt termék vagy új sarzs";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 660;

    public ObservableCollection<ProductLookup> Products { get; } = [];

    [ObservableProperty]
    public partial string ProductSearch { get; set; } = "";

    [ObservableProperty]
    public partial ProductLookup? Product { get; set; }

    [ObservableProperty]
    public partial string Received { get; set; } = "";

    [ObservableProperty]
    public partial string Damaged { get; set; } = "0";

    [ObservableProperty]
    public partial string Lot { get; set; } = "";

    [ObservableProperty]
    public partial string Expiry { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    // Products of the inbound's client matching the typed text (or a scanned code).
    [RelayCommand]
    Task FindAsync() => RunAsync(async () =>
    {
        var list = await Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", Inbound.PartnerId), ("q", ProductSearch.Trim())));
        Products.Clear();
        foreach (var p in list.Items) Products.Add(p);
        Product = Products.Count == 1 ? Products[0] : null;
        if (Products.Count == 0) Error = "Nincs ilyen termék ennél az ügyfélnél.";
        else Error = null;
    });

    [RelayCommand]
    Task ScanAsync(string code)
    {
        ProductSearch = code;
        return FindAsync();
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var r = Fmt.ParseNumber(Received.Length == 0 ? "0" : Received);
        var d = Fmt.ParseNumber(Damaged.Length == 0 ? "0" : Damaged);
        Error = Product is null ? "Válassz terméket."
            : r is not { } rv || rv < 0 || rv % 1 != 0 || d is not { } dv || dv < 0 || dv % 1 != 0 ? "A mennyiségek nulla vagy pozitív egész számok legyenek."
            : null;
        if (Error is not null) return;
        try
        {
            await Api.PostAsync<InboundLineResult>($"api/inbound/{Inbound.Id}/lines", new
            {
                product_id = Product!.Id,
                received_qty = (int)r!.Value,
                damaged_qty = (int)d!.Value,
                lot = Lot.Trim(),
                expiry = Expiry.Trim().Length == 0 ? null : Expiry.Trim(),
            });
            Shell.Toast("Tétel felvéve.", ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            Error = $"{e.Message} {string.Join(" ", e.Fields.Values)}";
        }
    });
}
