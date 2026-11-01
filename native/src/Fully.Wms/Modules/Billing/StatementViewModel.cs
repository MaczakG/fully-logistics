using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Billing;

// One client's statement of a month in its own window: the data, the totals, the lines by group
// (with the manual ones of a draft), the drill-down lists and the history. A draft is recalculated,
// added to, deleted or approved; an approved one invoiced or voided; an invoiced one voided, its
// PDF opened; a void one made again as a draft.
public sealed partial class StatementViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    public int Id { get; } = id;
    public override string Title => Data is { } s ? $"{s.PartnerName}, {s.Label}" : "Elszámolás";
    public override string? Module => "billing";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"statement:{Id}";

    static readonly string[] DrillOrder = ["orders", "storage", "inbound", "returns", "entries"];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title))]
    public partial Statement? Data { get; set; }

    [ObservableProperty] public partial IReadOnlyList<StatementGroupItem> Groups { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<PartnerTabChip> DrillTabs { get; set; } = [];
    [ObservableProperty] public partial string? DrillKind { get; set; }
    [ObservableProperty] public partial string? DrillNote { get; set; }
    [ObservableProperty] public partial int DrillTotal { get; set; }
    [ObservableProperty] public partial bool DrillHasMore { get; set; }

    public ObservableCollection<DetailOrder> DrillOrders { get; } = [];
    public ObservableCollection<DetailStorage> DrillStorage { get; } = [];
    public ObservableCollection<DetailInbound> DrillInbound { get; } = [];
    public ObservableCollection<DetailReturn> DrillReturns { get; } = [];
    public ObservableCollection<DetailEntry> DrillEntries { get; } = [];

    bool Can(string action) => Shell.Me?.Can("billing", action) == true;
    string Status => Data?.Status ?? "";
    public bool IsDraft => Status == "draft";
    public bool IsApproved => Status == "approved";
    public bool IsInvoiced => Status == "invoiced";
    public bool IsVoid => Status == "void";
    public bool CanRegenerate => (IsDraft || IsVoid) && Can("create");
    public string RegenerateText => IsVoid ? "Újrakészítés piszkozatként" : "Újraszámolás";
    public bool CanAddLine => IsDraft && Can("edit");
    public bool CanDelete => IsDraft && Can("delete");
    public bool CanApprove => IsDraft && Can("approve");
    public bool ApproveEnabled => CanApprove && Data?.Stale == false;
    public bool CanVoid => (IsApproved || IsInvoiced) && Can("approve");
    public bool CanInvoice => IsApproved && Can("approve");
    public bool InvoiceEnabled => CanInvoice && Data?.Invoicing?.Configured == true && Data?.InvoiceBusy == false;
    public bool HasInvoicePdf => IsInvoiced && Data?.InvoiceDocumentId is not null;
    public bool CanRefetchPdf => IsInvoiced && Data?.InvoiceDocumentId is null && Can("approve");
    public bool HasLines => Data is { Lines.Count: > 0 };
    public bool HasDrill => DrillTabs.Count > 0;
    public bool HasHistory => Data?.History is { Count: > 0 };

    public string StatusText => BillingFormat.StatusText(Status);
    public string VoidText => IsVoid ? $"Érvénytelenítve {Fmt.DateTime(Data!.VoidedAt)} ({Data.VoidedByName ?? "ismeretlen"}): {Data.VoidReason}" : "";
    public string StaleText => Data is { Stale: true, Fresh: { } f }
        ? $"A piszkozat készítése óta változtak az adatok vagy a tarifák. Friss nettó összeg: {Fmt.Money(f.Net)}. Jóváhagyás előtt számold újra." : "";
    public string InvoiceErrorText => Data?.InvoiceError is { Length: > 0 } e ? IsInvoiced ? e : $"A legutóbbi számlázási kísérlet nem sikerült: {e}" : "";
    public bool InvoiceErrorIsWarn => IsInvoiced;
    public bool ShowUncertain => Data is { InvoiceUncertain: true } && IsApproved;
    public bool ShowBusy => Data?.InvoiceBusy == true;
    public string? InvoicingWarning => IsApproved && Data?.Invoicing is { } inv ? OverviewTab.InvoicingText(inv, Shell) : null;
    public string Warnings => string.Join("\n", Data?.Meta?.Warnings ?? []);

    // The data panel
    public string PartnerText => Data is { } s ? $"{s.PartnerName} ({s.PartnerCode})" : "";
    public string BillingAddress
    {
        get
        {
            if (Data?.Partner is not { } p) return "";
            var address = string.Join(" ", new[] { p.BillingZip is { Length: > 0 } z ? z : p.Zip, p.BillingCity is { Length: > 0 } c ? c : p.City,
                p.BillingAddress is { Length: > 0 } a ? a : p.Address }.Where((x) => !string.IsNullOrEmpty(x)));
            var name = p.BillingName is { Length: > 0 } n && n != Data.PartnerName ? $"{n}\n" : "";
            return address.Length > 0 ? name + address : "";
        }
    }
    public bool NoBillingAddress => Data is not null && BillingAddress.Length == 0;
    public string TaxNumber => Data?.Partner is { } p ? p.TaxNumber is { Length: > 0 } t ? t : p.EuVatNumber ?? "" : "";
    public bool NoTaxNumber => Data is not null && TaxNumber.Length == 0;
    public string PaymentDays => $"{Data?.Partner?.PaymentDays ?? 0} nap";
    public string GeneratedText => Data is { } s ? $"{Fmt.DateTime(s.GeneratedAt)}{(s.GeneratedByName is { } n ? $" ({n})" : "")}" : "";
    public string ApprovedText => Data?.ApprovedAt is { } at ? $"{Data.ApprovedByName}, {Fmt.DateTime(at)}" : "";
    public bool HasApproved => Data?.ApprovedAt is not null;
    public string InvoiceText => Data is { InvoiceNumber.Length: > 0 } s
        ? $"{s.InvoiceNumber} ({(s.InvoiceProvider == "billingo" ? "Billingo" : "Számlázz.hu")}, {Fmt.DateTime(s.InvoicedAt)})" : "";
    public bool HasInvoice => InvoiceText.Length > 0;
    public string NetText => Fmt.Money(Data?.Net ?? 0);
    public string VatLabel => $"ÁFA {BillingFormat.Pct(Data?.VatPct ?? 0)}";
    public string VatText => Fmt.Money(Data?.Vat ?? 0);
    public string GrossText => Fmt.Money(Data?.Gross ?? 0);
    public string LinesHead => $"Tétel · Nettó · ÁFA {BillingFormat.Pct(Data?.VatPct ?? 0)} · Bruttó";

    public override async Task LoadAsync()
    {
        var s = await Api.GetAsync<Statement>($"api/billing/statements/{Id}");
        Data = s;
        var editable = s.Status == "draft" && Can("edit");
        Groups = s.Groups.Where((g) => s.Lines.Any((l) => l.Group == g.Key)).Select((g) =>
        {
            var lines = s.Lines.Where((l) => l.Group == g.Key).ToList();
            var shown = new HashSet<string>();
            return new StatementGroupItem(g.Label, lines.Select((l) => new StatementLineItem(this, l, l.Drill is { } d && BillingFormat.DrillLabels.ContainsKey(d) && shown.Add(d),
                editable && l.Manual)).ToList(), Fmt.Money(lines.Sum((l) => l.Amount)), Fmt.Money(lines.Sum((l) => l.Vat)), Fmt.Money(lines.Sum((l) => l.Gross)));
        }).ToList();
        var drills = s.Lines.Select((l) => l.Drill).OfType<string>().Distinct().Where(BillingFormat.DrillLabels.ContainsKey)
            .OrderBy((k) => Array.IndexOf(DrillOrder, k)).ToList();
        DrillTabs = drills.Select((k) => new PartnerTabChip(k, BillingFormat.DrillLabels[k])).ToList();
        foreach (var n in new[]
        {
            nameof(IsDraft), nameof(IsApproved), nameof(IsInvoiced), nameof(IsVoid), nameof(CanRegenerate), nameof(RegenerateText), nameof(CanAddLine), nameof(CanDelete),
            nameof(CanApprove), nameof(ApproveEnabled), nameof(CanVoid), nameof(CanInvoice), nameof(InvoiceEnabled), nameof(HasInvoicePdf), nameof(CanRefetchPdf),
            nameof(HasLines), nameof(HasDrill), nameof(HasHistory), nameof(StatusText), nameof(VoidText), nameof(StaleText), nameof(InvoiceErrorText),
            nameof(InvoiceErrorIsWarn), nameof(ShowUncertain), nameof(ShowBusy), nameof(InvoicingWarning), nameof(Warnings), nameof(PartnerText),
            nameof(BillingAddress), nameof(NoBillingAddress), nameof(TaxNumber), nameof(NoTaxNumber), nameof(PaymentDays), nameof(GeneratedText),
            nameof(ApprovedText), nameof(HasApproved), nameof(InvoiceText), nameof(HasInvoice), nameof(NetText), nameof(VatLabel), nameof(VatText),
            nameof(GrossText),
        }) OnPropertyChanged(n);
        var kind = DrillKind is { } k0 && drills.Contains(k0) ? k0 : drills.FirstOrDefault();
        if (kind is not null) await LoadDrillAsync(kind, 0);
    }

    // ------------------------------------------------------------------ drill-down

    async Task LoadDrillAsync(string kind, int offset)
    {
        DrillKind = kind;
        foreach (var t in DrillTabs) t.IsSelected = t.Key == kind;
        var path = Query.Build($"api/billing/statements/{Id}/details", ("kind", kind), ("limit", 100), ("offset", offset));
        int total;
        int count;
        switch (kind)
        {
            case "orders":
                (total, count) = await FillAsync(DrillOrders, path, offset);
                var b = Data?.Lines.FirstOrDefault((l) => l.Key == "handling.order_base");
                DrillNote = b is null ? null : $"Darabszám szerint: {BillingFormat.Buckets(b)}. A kezelési díj az elszámolás tarifáival számolva.";
                break;
            case "storage":
                var s = await Api.GetAsync<StatementDetails<DetailStorage>>(path);
                if (offset == 0) DrillStorage.Clear();
                foreach (var x in s.Items) DrillStorage.Add(x);
                (total, count) = (s.Total, DrillStorage.Count);
                DrillNote = $"Arányos díj = napok × havi ár / {s.DaysInMonth} nap. A helyenkénti összegek kerekítés miatt eltérhetnek a méretenkénti tételtől.";
                break;
            case "inbound":
                (total, count) = await FillAsync(DrillInbound, path, offset);
                DrillNote = null;
                break;
            case "returns":
                (total, count) = await FillAsync(DrillReturns, path, offset);
                DrillNote = null;
                break;
            default:
                (total, count) = await FillAsync(DrillEntries, path, offset);
                DrillNote = null;
                break;
        }
        DrillTotal = total;
        DrillHasMore = count < total;
        OnPropertyChanged(nameof(IsOrders));
        OnPropertyChanged(nameof(IsStorage));
        OnPropertyChanged(nameof(IsInbound));
        OnPropertyChanged(nameof(IsReturns));
        OnPropertyChanged(nameof(IsEntries));
        OnPropertyChanged(nameof(DrillEmpty));
    }

    async Task<(int, int)> FillAsync<T>(ObservableCollection<T> list, string path, int offset)
    {
        var d = await Api.GetAsync<StatementDetails<T>>(path);
        if (offset == 0) list.Clear();
        foreach (var x in d.Items) list.Add(x);
        return (d.Total, list.Count);
    }

    public bool IsOrders => DrillKind == "orders";
    public bool IsStorage => DrillKind == "storage";
    public bool IsInbound => DrillKind == "inbound";
    public bool IsReturns => DrillKind == "returns";
    public bool IsEntries => DrillKind == "entries";
    public bool DrillEmpty => DrillTotal == 0;

    [RelayCommand]
    Task DrillAsync(PartnerTabChip tab) => RunAsync(() => LoadDrillAsync(tab.Key, 0));

    internal Task ShowDrillAsync(string kind) => RunAsync(() => LoadDrillAsync(kind, 0));

    [RelayCommand]
    Task DrillMoreAsync() => DrillKind is { } k
        ? RunAsync(() => LoadDrillAsync(k, k switch
        {
            "orders" => DrillOrders.Count, "storage" => DrillStorage.Count, "inbound" => DrillInbound.Count, "returns" => DrillReturns.Count, _ => DrillEntries.Count,
        }))
        : Task.CompletedTask;

    // ------------------------------------------------------------------ actions

    [RelayCommand]
    Task ExportAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/billing/statements/{Id}/export")));

    [RelayCommand]
    Task RegenerateAsync() => RunAsync(async () =>
    {
        var r = await Api.PostAsync<GenerateResult>("api/billing/statements/generate", new { period = Data!.Period, partner_ids = new[] { Data.PartnerId } });
        if (r.Skipped.Count > 0) Shell.Toast(r.Skipped[0].Reason, ToastKind.Error);
        else Shell.Toast("Újraszámolva.", ToastKind.Success);
        await LoadAsync();
    });

    [RelayCommand]
    Task AddLineAsync() => Shell.NavigateAsync(new ManualLineViewModel(Shell, Id, Data!.Groups));

    internal async Task RemoveLineAsync(StatementLine l)
    {
        if (!await Shell.ConfirmAsync("Kézi tétel törlése", $"Törlöd ezt a tételt: {l.Name}?", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/billing/statements/{Id}/lines/{Uri.EscapeDataString(l.Id)}");
            Shell.Toast("Tétel törölve.", ToastKind.Success);
            await LoadAsync();
        });
    }

    [RelayCommand]
    async Task DeleteAsync()
    {
        if (!await Shell.ConfirmAsync("Piszkozat törlése", $"Törlöd a(z) {Data!.Number} piszkozatot? A kézi tételei is elvesznek.", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/billing/statements/{Id}");
            Shell.Toast("Piszkozat törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }

    [RelayCommand]
    async Task ApproveAsync()
    {
        var s = Data!;
        if (!await Shell.ConfirmAsync("Elszámolás jóváhagyása",
            $"{s.PartnerName}, {s.Label}: bruttó {Fmt.Money(s.Gross)}. Jóváhagyás után a tételek nem módosíthatók, és kiállíthatod a számlát.", "Jóváhagyás")) return;
        await RunAsync(async () =>
        {
            await Api.PostAsync($"api/billing/statements/{Id}/approve");
            Shell.Toast("Jóváhagyva.", ToastKind.Success);
            await LoadAsync();
        });
    }

    // Issues the invoice in the invoicing service; an invoiced statement without its PDF fetches it.
    [RelayCommand]
    async Task InvoiceAsync()
    {
        var s = Data!;
        if (IsApproved && !await Shell.ConfirmAsync("Számla kiállítása",
            $"Kiállítjuk a számlát a(z) {s.Invoicing?.Name} rendszerben: {s.PartnerName}, bruttó {Fmt.Money(s.Gross)}, {s.Partner?.PaymentDays ?? 0} napos fizetési határidővel.",
            "Számla kiállítása")) return;
        var wasApproved = IsApproved;
        var ok = await RunAsync(async () =>
        {
            var r = await Api.PostAsync<InvoiceIssued>($"api/billing/statements/{Id}/invoice");
            foreach (var w in r.Warnings ?? []) Shell.Toast(w);
            Shell.Toast(wasApproved ? $"Számla kiállítva: {r.InvoiceNumber}." : "Számla PDF letöltve.", ToastKind.Success);
        });
        await ReloadAsync();
        _ = ok;
    }

    [RelayCommand]
    Task InvoicePdfAsync() => Data?.InvoiceDocumentId is { } doc
        ? RunAsync(async () => await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/documents/{doc}")))
        : Task.CompletedTask;

    [RelayCommand]
    Task VoidAsync() => Shell.NavigateAsync(new VoidViewModel(Shell, Data!));

    [RelayCommand]
    Task OpenPartnerAsync() => Data is { } s && Shell.Me?.Can("partners", "view") == true
        ? Shell.NavigateAsync(new PartnerViewModel(Shell, s.PartnerId)) : Task.CompletedTask;
}

public sealed record StatementGroupItem(string Label, IReadOnlyList<StatementLineItem> Lines, string Net, string Vat, string Gross)
{
    public string TotalLabel => $"{Label} összesen";
}

public sealed class StatementLineItem(StatementViewModel page, StatementLine l, bool drill, bool removable)
{
    public StatementLine Line { get; } = l;
    public string Sub { get; } = BillingFormat.LineSub(l);
    public bool HasSub => Sub.Length > 0;
    public bool HasWarn => !string.IsNullOrEmpty(Line.Warn);
    public string QtyText => BillingFormat.Qty(Line.Qty, Line.Unit);
    public string PriceText => BillingFormat.PriceText(Line);
    public string NetText => Fmt.Money(Line.Amount);
    public string VatText => Fmt.Money(Line.Vat);
    public string GrossText => Fmt.Money(Line.Gross);
    public bool CanDrill { get; } = drill;
    public bool CanRemove { get; } = removable;
    public string DrillTip => Line.Drill is { } d ? $"Részletek: {BillingFormat.DrillLabels.GetValueOrDefault(d, d)}" : "";
    public RelayCommand DrillCommand => new(() => _ = page.ShowDrillAsync(Line.Drill!));
    public RelayCommand RemoveCommand => new(() => _ = page.RemoveLineAsync(Line));
}
