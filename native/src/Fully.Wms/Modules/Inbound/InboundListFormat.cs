using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Inbound;

public static class InboundListFormat
{
    static string Today => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).ToString("yyyy-MM-dd");

    public static readonly IValueConverter IsLate = new FuncValueConverter<InboundRow?, bool>((r) =>
        r is { Status: "expected", ExpectedDate: { Length: > 0 } d } && string.CompareOrdinal(d, Today) < 0);

    public static readonly IValueConverter Overdue = new FuncValueConverter<int, string>((n) => n > 0 ? $"{Fmt.Int(n)} késésben" : "mai érkezés");

    public static readonly IValueConverter ReceivedOfExpected = new FuncValueConverter<InboundRow?, string>((r) => r is null ? "" : $"{Fmt.Int(r.ReceivedQty)} / {Fmt.Int(r.ExpectedQty)}");

    public static readonly IValueConverter CardLine = new FuncValueConverter<InboundRow?, string>((r) => r is null ? "" : string.Join(" · ", new[]
    {
        r.ExpectedDate is { Length: > 0 } d ? $"várható {Fmt.Date(d)}" : null,
        $"{Fmt.Int(r.LineCount)} tétel",
        $"átvett {Fmt.Int(r.ReceivedQty)} / {Fmt.Int(r.ExpectedQty)}",
        r.PutawayQty > 0 ? $"polcon {Fmt.Int(r.PutawayQty)}" : null,
        r.ExternalRef is { Length: > 0 } x ? x : null,
    }.Where((x) => x is not null)));
}
