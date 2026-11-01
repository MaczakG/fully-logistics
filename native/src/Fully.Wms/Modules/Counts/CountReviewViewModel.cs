using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// Review and posting (GET /api/counts/:id/review, POST .../post), for users with counts approve:
// the differences by location, the lines whose stock moved since the count started (each needs a
// decision: recount the location, or confirm booking the counted quantity), then posting.
public sealed partial class CountReviewViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    public int Id { get; } = id;
    public override string Title => Data is null ? "Ellenőrzés és könyvelés" : $"{Data.Count.Number}: ellenőrzés";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"count-review:{Id}";

    readonly HashSet<int> confirmed = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Lead), nameof(Summary), nameof(Postable), nameof(CanPost), nameof(StatusNotice), nameof(StatusTone),
        nameof(CountedText), nameof(CountedHint), nameof(SurplusHint), nameof(ShortageHint))]
    public partial CountReview? Data { get; set; }

    // Only the differences and the lines whose stock moved (default), or every line.
    [ObservableProperty]
    public partial bool OnlyDiff { get; set; } = true;

    [ObservableProperty]
    public partial IReadOnlyList<ReviewGroup> Groups { get; set; } = [];

    [ObservableProperty]
    public partial string? ChangedNotice { get; set; }

    public bool CanApprove => Shell.Me?.Can("counts", "approve") == true;
    public bool CanEdit => Shell.Me?.Can("counts", "edit") == true;
    public string Lead => Data is null ? "" : $"{Data.Count.TypeLabel}: {Data.Count.Scope}";
    public ReviewSummary? Summary => Data?.Summary;
    public bool Postable => Data?.Count.Status is "counting" or "counted";
    public bool CanPost => Postable && Summary is { Counted: > 0 };
    public bool HasGroups => Groups.Count > 0;
    public string EmptyText => OnlyDiff ? "Nincs eltérés: minden számolt tétel egyezik a nyilvántartással." : "Nincs tétel.";

    public string? StatusNotice => Data is null || Postable ? null
        : Data.Count.Status == "posted" ? "Ez a leltár már könyvelve van." : $"A leltár állapota: {Shell.Meta.Status("count", Data.Count.Status).Label}.";
    public string StatusTone => Data?.Count.Status == "posted" ? "ok" : "info";

    public string CountedText => Summary is { } s ? $"{Fmt.Int(s.Counted)} / {Fmt.Int(s.Lines)}" : "";
    public string CountedHint => Summary is { } s ? s.Uncounted > 0 ? $"{Fmt.Int(s.Uncounted)} számolatlan, nem változik" : "minden tétel számolva" : "";
    public string SurplusHint => Summary is { SurplusQty: > 0 } s ? $"+{Fmt.Int(s.SurplusQty)} db" : " ";
    public string ShortageHint => Summary is { ShortageQty: > 0 } s ? $"-{Fmt.Int(s.ShortageQty)} db" : " ";

    public override async Task LoadAsync()
    {
        if (!CanApprove) return;
        Data = await Api.GetAsync<CountReview>($"api/counts/{Id}/review");
        confirmed.IntersectWith(Data.Lines.Where((l) => l.Changed).Select((l) => l.Id));
        Rebuild();
    }

    partial void OnOnlyDiffChanged(bool value)
    {
        OnPropertyChanged(nameof(EmptyText));
        Rebuild();
    }

    void Rebuild()
    {
        if (Data is null) return;
        static bool Interesting(ReviewLine l) => l.Changed || l.Diff is not (null or 0) || (l.Added && l.CountedQty > 0);
        var canRecount = Postable && CanEdit;
        Groups = Data.Lines.GroupBy((l) => l.LocationId).Select((g) =>
        {
            var all = g.ToList();
            var shown = OnlyDiff ? all.Where(Interesting).ToList() : all.Where((l) => l.HasProduct || all.Count == 1).ToList();
            return new ReviewGroup(this, g.Key, all[0].LocationCode, all[0].Zone, shown.Select((l) => new ReviewLineItem(this, l)).ToList(),
                canRecount && !all.Any((l) => l.Posted));
        }).Where((g) => g.Lines.Count > 0).ToList();
        OnPropertyChanged(nameof(HasGroups));
        UpdateChangedNotice();
    }

    internal bool IsConfirmed(int lineId) => confirmed.Contains(lineId);

    internal void SetConfirmed(int lineId, bool value)
    {
        if (value) confirmed.Add(lineId);
        else confirmed.Remove(lineId);
        UpdateChangedNotice();
    }

    void UpdateChangedNotice()
    {
        if (Data is not { Summary.Changed: > 0 } d || !Postable)
        {
            ChangedNotice = null;
            return;
        }
        var open = d.Lines.Count((l) => l.Changed && !confirmed.Contains(l.Id));
        ChangedNotice = $"{Fmt.Int(d.Summary.Changed)} tételnél mozgott a készlet a leltár indítása óta (kiszedés, betárolás, áttárolás). A várható mennyiség ezért elavult lehet.\n"
            + $"Tételenként döntsd el: számold újra a helyet, vagy jelöld be a „Könyvelhető” mezőt, és a készlet a számolt mennyiségre áll.{(open > 0 ? $" Még {Fmt.Int(open)} döntés hiányzik." : "")}";
    }

    internal Task RecountAsync(ReviewGroup g) => RunAsync(async () =>
    {
        if (!await Shell.ConfirmAsync("Hely újraszámolása", $"A(z) {g.Code} hely számolásai törlődnek, a hely friss készlettel indul újra. A számlálók a Számlálás képernyőn folytatják.", "Újraszámolás")) return;
        await Api.PostAsync<CountLocationState>($"api/counts/{Id}/locations/{g.LocationId}/recount");
        Shell.Toast($"{g.Code}: újraszámolásra vár.", ToastKind.Success);
        await LoadAsync();
    });

    [RelayCommand]
    Task PostAsync() => RunAsync(async () =>
    {
        if (Data is not { } d) return;
        var missing = d.Lines.Count((l) => l.Changed && l.CountedQty is not null && !l.Posted && !confirmed.Contains(l.Id));
        if (missing > 0)
        {
            Shell.Toast($"{missing} változott tételnél dönts: újraszámolás vagy „Könyvelhető”.", ToastKind.Error);
            return;
        }
        var s = d.Summary;
        var ok = await Shell.ConfirmAsync("Eltérések könyvelése",
            $"{Fmt.Int(s.Surplus)} többlet (+{Fmt.Int(s.SurplusQty)} db) és {Fmt.Int(s.Shortage)} hiány (-{Fmt.Int(s.ShortageQty)} db) könyvelése. A készlet a számolt mennyiségre áll."
            + (s.Uncounted > 0 ? $" A {Fmt.Int(s.Uncounted)} számolatlan tétel nem változik." : "") + " A könyvelés nem vonható vissza.",
            "Könyvelés");
        if (!ok) return;
        CountPosted res;
        do
        {
            res = await Api.PostAsync<CountPosted>($"api/counts/{Id}/post", new { confirm_line_ids = confirmed.ToArray() });
            if (!res.Done) Shell.Toast($"Könyvelés folyamatban, még {Fmt.Int(res.Remaining)} tétel...", ToastKind.Info);
        } while (!res.Done);
        Shell.Toast($"{d.Count.Number} könyvelve.", ToastKind.Success);
        await CountNav.BackToCountAsync(Shell, Id);
    });

    [RelayCommand]
    Task PrintAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(CountSheet.Build(await Api.GetAsync<CountDetail>($"api/counts/{Id}"), Shell.Me!)));
}

public sealed partial class ReviewGroup(CountReviewViewModel page, int locationId, string code, string? zone, IReadOnlyList<ReviewLineItem> lines, bool canRecount)
{
    public int LocationId { get; } = locationId;
    public string Code { get; } = code;
    public string ZoneText { get; } = string.IsNullOrEmpty(zone) ? "" : $"{zone} zóna";
    public IReadOnlyList<ReviewLineItem> Lines { get; } = lines;
    public bool CanRecount { get; } = canRecount;

    [RelayCommand]
    Task RecountAsync() => page.RecountAsync(this);
}

// A line of the review with its decision.
public sealed partial class ReviewLineItem(CountReviewViewModel page, ReviewLine line) : ObservableObject
{
    public ReviewLine Line { get; } = line;
    public bool IsEmptyLine => !Line.HasProduct;
    public bool IsProduct => Line.HasProduct;
    public string EmptyText => "Üres hely" + (Line.CountedQty == 0 ? ", üresnek számolva" : ", nincs számolva");
    public string ExpectedText => Fmt.Int(Line.ExpectedQty);
    public string CountedText => Line.CountedQty is { } n ? Fmt.Int(n) : "nincs";
    public bool NotCounted => Line.CountedQty is null;
    public string DiffText => Line.Diff is { } d && d != 0 ? CountsFormat.DiffText(d) : Line.CountedQty is null ? "" : "0";
    public bool IsSurplus => Line.Diff > 0;
    public bool IsShortage => Line.Diff < 0;
    public string CurrentText => Line.Changed ? Fmt.Int(Line.CurrentQty) : "";

    // The decision column: booked, a "Könyvelhető" box for a moved line, or "változott".
    public bool ShowPosted => Line.Posted;
    public bool ShowConfirm => !Line.Posted && Line.Changed && Line.CountedQty is not null && page.Postable;
    public bool ShowChanged => !Line.Posted && Line.Changed && !ShowConfirm;

    public bool Confirmed
    {
        get => page.IsConfirmed(Line.Id);
        set
        {
            page.SetConfirmed(Line.Id, value);
            OnPropertyChanged();
        }
    }

    public string CardLine => string.Join(" · ", new[]
    {
        Line.LotText.Length > 0 ? Line.LotText : null,
        $"várható {ExpectedText}",
        $"számolt {CountedText}",
        DiffText.Length > 0 && DiffText != "0" ? $"eltérés {DiffText}" : null,
        Line.Changed ? $"készlet most {CurrentText}" : null,
    }.Where((x) => x is not null));
}

static class CountNav
{
    // Back from a step of a count (counting, review) to the count. On the desktop the step's window
    // closes and the count's window comes to the front with fresh data.
    public static async Task BackToCountAsync(ShellViewModel shell, int id)
    {
        await shell.BackAsync();
        if (shell.Presenter is not null) await shell.NavigateAsync(new CountViewModel(shell, id));
    }
}
