using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Counts;

public static class CountsFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
    public static readonly IValueConverter Positive = new FuncValueConverter<int?, bool>((n) => n > 0);
    public static readonly IValueConverter Negative = new FuncValueConverter<int?, bool>((n) => n < 0);

    // Desktop: the summary above the work; phone: below it (the scan field comes first).
    public static readonly IValueConverter RowOfSummary = new FuncValueConverter<bool, int>((compact) => compact ? 3 : 1);

    // The quantity of a line being counted: beside the product on the desktop, under it on the phone.
    public static readonly IValueConverter QtyColumn = new FuncValueConverter<bool, int>((compact) => compact ? 0 : 1);
    public static readonly IValueConverter QtyRow = new FuncValueConverter<bool, int>((compact) => compact ? 1 : 0);
    public static readonly IValueConverter QtyMargin = new FuncValueConverter<bool, Avalonia.Thickness>((compact) => compact ? new(0, 8, 0, 0) : new(0));

    public static readonly IValueConverter KpiColumns = new FuncValueConverter<bool, int>((compact) => compact ? 2 : 5);

    public static readonly Dictionary<string, string> TypeLabels = new()
    {
        ["cycle"] = "Ciklikus", ["zone"] = "Zóna", ["product"] = "Termék", ["full"] = "Teljes", ["locations"] = "Kijelölt helyek",
    };

    public static string TypeLabel(string? type) => type is not null && TypeLabels.TryGetValue(type, out var s) ? s : type ?? "";

    // "14:05" in Budapest time.
    public static string Time(string? iso) => DateTimeOffset.TryParse(iso, out var t)
        ? TimeZoneInfo.ConvertTime(t, Fmt.Budapest).ToString("HH:mm", Fmt.Hu) : "";

    public static double Ratio(int done, int total) => total <= 0 ? 0 : Math.Min(1, done / (double)total);

    // Quantities: empty when unknown, "+3" and "-2" for differences.
    public static string Qty(int? n) => n is { } v ? Fmt.Int(v) : "";
    public static string DiffText(int? d) => d is not { } v || v == 0 ? "" : v > 0 ? $"+{Fmt.Int(v)}" : Fmt.Int(v);

    public static readonly IValueConverter Type = new FuncValueConverter<string?, string>(TypeLabel);
    public static readonly IValueConverter RowRatio = new FuncValueConverter<CountRow?, double>((r) => r is null ? 0 : Ratio(r.DoneLocations, r.Locations));
    public static readonly IValueConverter RowDone = new FuncValueConverter<CountRow?, bool>((r) => r is not null && r.Locations > 0 && r.DoneLocations >= r.Locations);
    public static readonly IValueConverter RowProgress = new FuncValueConverter<CountRow?, string>((r) => r is null ? "" : $"{Fmt.Int(r.DoneLocations)} / {Fmt.Int(r.Locations)} hely");

    // "rejtett" while a blind count hides it; nothing before the first entry.
    public static readonly IValueConverter RowDiff = new FuncValueConverter<CountRow?, string>((r) => r is null ? ""
        : r.DiffLines is null ? "rejtett" : r.CountedLines > 0 ? Fmt.Int(r.DiffLines.Value) : "");

    public static readonly IValueConverter RowCreated = new FuncValueConverter<CountRow?, string>((r) => r is null ? ""
        : $"{r.CreatedByName}\n{Fmt.DateTime(r.CreatedAt)}".Trim());

    public static readonly IValueConverter RowCard = new FuncValueConverter<CountRow?, string>((r) => r is null ? "" : string.Join(" · ", new[]
    {
        TypeLabel(r.Type),
        $"{Fmt.Int(r.DoneLocations)} / {Fmt.Int(r.Locations)} hely kész",
        r.DiffLines is { } d && r.CountedLines > 0 ? $"{Fmt.Int(d)} eltérő tétel" : null,
        Fmt.DateTime(r.CreatedAt),
    }.Where((x) => x is not null)));
}
