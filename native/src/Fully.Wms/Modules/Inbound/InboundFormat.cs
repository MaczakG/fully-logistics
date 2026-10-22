using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Inbound;

public static class InboundFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter LinesCount = new FuncValueConverter<int, string>((n) => $"{Fmt.Int(n)} tétel");
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
    public static readonly IValueConverter LotLabel = new FuncValueConverter<InboundLine?, string>((l) => l is null ? "" : ReceiveEntry.LotLabel(l));
    public static readonly IValueConverter SelectText = new FuncValueConverter<bool, string>((b) => b ? "Kiválasztva" : "Kiválaszt");
    public static readonly IValueConverter RowOfSummary = new FuncValueConverter<bool, int>((compact) => compact ? 3 : 1);
    public static readonly IValueConverter Date = new FuncValueConverter<string?, string>((s) => Fmt.Date(s));

    public static readonly IValueConverter TotalsLine = new FuncValueConverter<InboundTotals?, string>((t) => t is null ? ""
        : $"Várt {Fmt.Int(t.Expected)} · átvett {Fmt.Int(t.Received)} · sérült {Fmt.Int(t.Damaged)} · polcon {Fmt.Int(t.Putaway)}");

    public static readonly IValueConverter LineFigures = new FuncValueConverter<InboundLine?, string>((l) => l is null ? ""
        : $"várt {Fmt.Int(l.ExpectedQty)}\nátvett {Fmt.Int(l.ReceivedQty)}\nsérült {Fmt.Int(l.DamagedQty)}\npolcon {Fmt.Int(l.PutawayQty)}");

    public static readonly IValueConverter HistoryMeta = new FuncValueConverter<HistoryEntry?, string>((h) => h is null ? "" : $"{Fmt.DateTime(h.At)}{(string.IsNullOrEmpty(h.Actor) ? "" : $", {h.Actor}")}");

    static readonly Dictionary<string, string> Sources = new() { ["manual"] = "Kézi", ["csv"] = "CSV", ["api"] = "API" };

    public static string Source(string s) => Sources.GetValueOrDefault(s, s);

    public static readonly IValueConverter SourceLabel = new FuncValueConverter<string?, string>((s) => s is null ? "" : Source(s));

    public static readonly IValueConverter InfoRows = new FuncValueConverter<InboundDetail?, IReadOnlyList<InfoRow>>((d) =>
    {
        if (d is null) return [];
        var rows = new List<InfoRow>
        {
            new("Ügyfél", $"{d.PartnerName} ({d.PartnerCode})"),
            new("Beszállító", d.SupplierName ?? "nincs megadva"),
            new("Külső hivatkozás", string.IsNullOrEmpty(d.ExternalRef) ? "nincs" : d.ExternalRef),
            new("Forrás", Source(d.Source)),
            new("Várható érkezés", d.ExpectedDate is { Length: > 0 } x ? Fmt.Date(x) : "nincs megadva"),
            new("Megérkezett", d.ArrivedAt is { Length: > 0 } a ? Fmt.DateTime(a) : "még nem"),
            new("Raklap, karton", $"{Fmt.Int(d.Pallets)} raklap, {Fmt.Int(d.Cartons)} karton"),
            new("Érkezési megjegyzés", string.IsNullOrEmpty(d.ArrivalNote) ? "nincs" : d.ArrivalNote),
            new("Megjegyzés", string.IsNullOrEmpty(d.Note) ? "nincs" : d.Note),
            new("Rögzítette", $"{d.CreatedByName ?? "ismeretlen"}, {Fmt.DateTime(d.CreatedAt)}"),
        };
        if (d.CompletedAt is { Length: > 0 } c) rows.Add(new("Lezárta", $"{d.CompletedByName ?? "ismeretlen"}, {Fmt.DateTime(c)}"));
        return rows;
    });
}

public sealed record InfoRow(string Label, string Value);
