using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// One count (GET /api/counts/:id): figures, data, progress, the lines by location in walking
// order; from here counting, review and posting, the printable count sheet, deleting.
public sealed partial class CountViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    static readonly string[] Active = ["open", "counting", "counted"];

    public int Id { get; } = id;
    public override string Title => Data?.Number ?? "Leltár";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"count:{Id}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Status), nameof(Lead), nameof(Visible), nameof(IsActive), nameof(CanCount), nameof(CanReview),
        nameof(CountPrimary), nameof(ReviewPrimary), nameof(CountText), nameof(CanDelete), nameof(LocationsText), nameof(LinesText),
        nameof(DiffLines), nameof(DiffText), nameof(LocationsRatio), nameof(LinesRatio), nameof(LocationsDone), nameof(LinesDone),
        nameof(UncountedNotice), nameof(PostedNotice), nameof(Groups), nameof(InfoRows))]
    public partial CountDetail? Data { get; set; }

    public string? Status => Data?.Status;
    public string Lead => Data is null ? "" : $"{Data.TypeLabel}: {Data.Scope}";
    public bool Visible => Data?.CanSeeExpected == true;
    public bool IsActive => Data is not null && Active.Contains(Data.Status);
    public bool CanCount => IsActive && Shell.Me?.Can("counts", "edit") == true;
    public bool CanReview => Data?.Status is "counting" or "counted" && Shell.Me?.Can("counts", "approve") == true;
    public bool CanDelete => IsActive && Shell.Me?.Can("counts", "delete") == true;

    // The main step: review once counted, else counting.
    public bool ReviewPrimary => CanReview && (Data!.Status == "counted" || !CanCount);
    public bool CountPrimary => CanCount && !ReviewPrimary;
    public string CountText => Data?.Status == "open" ? "Számlálás indítása" : "Számlálás";

    public string LocationsText => Data is null ? "" : $"{Fmt.Int(Data.Progress.DoneLocations)} / {Fmt.Int(Data.Progress.Locations)}";
    public string LinesText => Data is null ? "" : $"{Fmt.Int(Data.Progress.CountedLines)} / {Fmt.Int(Data.Progress.Lines)}";
    public double LocationsRatio => Data is null ? 0 : CountsFormat.Ratio(Data.Progress.DoneLocations, Data.Progress.Locations);
    public double LinesRatio => Data is null ? 0 : CountsFormat.Ratio(Data.Progress.CountedLines, Data.Progress.Lines);
    public bool LocationsDone => Data is { Progress: { Locations: > 0 } p } && p.DoneLocations >= p.Locations;
    public bool LinesDone => Data is { Progress: { Lines: > 0 } p } && p.CountedLines >= p.Lines;

    // Lines whose counted quantity differs from the expected one (only when visible).
    public int DiffLines => Data?.Locations?.SelectMany((l) => l.Items ?? []).Count((l) => l.HasProduct && l.Diff is not (null or 0)) ?? 0;
    public string DiffText => Fmt.Int(DiffLines);

    public string? UncountedNotice => Data is { Status: "counted", Progress: var p } && p.CountedLines < p.Lines
        ? $"{Fmt.Int(p.Lines - p.CountedLines)} tétel nincs számolva: ezek nem változnak a könyveléskor." : null;
    public string? PostedNotice => Data?.Status == "posted" ? "Az eltérések könyvelve, a készlet a számolt mennyiségre állt." : null;

    public IReadOnlyList<CountGroup> Groups => Data?.Locations?.Select((l) => new CountGroup(l, Visible)).ToList() ?? [];

    public IReadOnlyList<CountInfo> InfoRows
    {
        get
        {
            if (Data is not { } c) return [];
            var rows = new List<CountInfo>
            {
                new("Típus", c.TypeLabel),
                new("Hatókör", c.Scope),
                new("Vak leltár", c.Blind ? "Igen" : "Nem"),
                new("Indította", $"{c.CreatedByName} · {Fmt.DateTime(c.CreatedAt)}"),
            };
            if (c.StartedAt is { } s) rows.Add(new("Számlálás kezdete", Fmt.DateTime(s)));
            if (c.CountedAt is { } ca) rows.Add(new("Számlálva", Fmt.DateTime(ca)));
            if (c.PostedAt is { } p) rows.Add(new("Könyvelte", $"{c.PostedByName} · {Fmt.DateTime(p)}"));
            if (c.CancelledAt is { } x) rows.Add(new("Törölve", Fmt.DateTime(x)));
            if (!string.IsNullOrEmpty(c.Note)) rows.Add(new("Megjegyzés", c.Note));
            return rows;
        }
    }

    public override async Task LoadAsync() => Data = await Api.GetAsync<CountDetail>($"api/counts/{Id}");

    [RelayCommand]
    Task CountAsync() => Shell.NavigateAsync(new CountingViewModel(Shell, Id));

    [RelayCommand]
    Task ReviewAsync() => Shell.NavigateAsync(new CountReviewViewModel(Shell, Id));

    [RelayCommand]
    Task PrintAsync() => Data is null ? Task.CompletedTask : Shell.Services.Platform.OpenFileAsync(CountSheet.Build(Data, Shell.Me!));

    [RelayCommand]
    Task DeleteAsync() => RunAsync(async () =>
    {
        if (Data is not { } c) return;
        if (!await Shell.ConfirmAsync("Leltár törlése", $"Biztosan törlöd a(z) {c.Number} leltárt? A rögzített számolások elvesznek, a készlet nem változik.", "Törlés", danger: true)) return;
        await Api.DeleteAsync($"api/counts/{c.Id}");
        Shell.Toast($"{c.Number} törölve.", ToastKind.Success);
        await LoadAsync();
    });
}

public sealed record CountInfo(string Label, string Value);

// A location of the count with its lines (a location without goods shows its empty line).
public sealed class CountGroup(CountLocation location, bool visible)
{
    public CountLocation Location { get; } = location;
    public string ZoneText => string.IsNullOrEmpty(Location.Zone) ? "" : $"{Location.Zone} zóna";
    public bool IsDone => Location.Done;
    public bool IsPartial => !Location.Done && Location.Counted > 0;
    public string StateText => Location.Done ? "Kész" : Location.Counted > 0 ? "Folyamatban" : "Nincs számolva";

    public IReadOnlyList<CountLineRow> Lines { get; } = Rows(location, visible);

    static List<CountLineRow> Rows(CountLocation loc, bool visible)
    {
        var items = loc.Items ?? [];
        var hasGoods = items.Any((l) => l.HasProduct);
        return items.Where((l) => l.HasProduct || !hasGoods).Select((l) => new CountLineRow(l, visible)).ToList();
    }
}

// A line as the detail shows it.
public sealed class CountLineRow(CountLine line, bool visible)
{
    public CountLine Line { get; } = line;
    public bool Visible { get; } = visible;
    public bool IsEmptyLine => !Line.HasProduct;
    public bool IsProduct => Line.HasProduct;
    public string EmptyText => "Nyilvántartás szerint üres hely" + (Line.CountedQty == 0 ? ": üresnek számolva" : "");
    public int? Diff => Visible ? Line.Diff : null;
    public string ExpectedText => Visible ? CountsFormat.Qty(Line.ExpectedQty) : "";
    public string CountedText => Line.CountedQty is { } n ? Fmt.Int(n) : "nincs";
    public bool NotCounted => Line.CountedQty is null;
    public string DiffText => CountsFormat.DiffText(Diff);
    public bool IsSurplus => Diff > 0;
    public bool IsShortage => Diff < 0;
    public string WhoText => Line.CountedAt is { } at ? $"{Line.CountedByName}\n{Fmt.DateTime(at)}" : Line.CountedByName;

    public string CardLine => string.Join(" · ", new[]
    {
        Line.LotText.Length > 0 ? Line.LotText : null,
        Visible ? $"várható {CountsFormat.Qty(Line.ExpectedQty)}" : null,
        $"számolt {CountedText}",
        DiffText.Length > 0 ? $"eltérés {DiffText}" : null,
    }.Where((x) => x is not null));
}
