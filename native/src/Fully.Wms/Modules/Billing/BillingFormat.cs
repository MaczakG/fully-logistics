using System.Globalization;
using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;

namespace Fully.Wms.Modules.Billing;

public static class BillingFormat
{
    static readonly string[] Months =
        ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"];

    public static string ThisMonth => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).ToString("yyyy-MM", CultureInfo.InvariantCulture);

    // The month billed by default: the previous one.
    public static string DefaultPeriod => Shift(ThisMonth, -1);

    public static string Label(string period) => $"{period[..4]}. {Months[int.Parse(period[5..7], CultureInfo.InvariantCulture) - 1]}";

    public static string Shift(string period, int months) =>
        new DateTime(int.Parse(period[..4], CultureInfo.InvariantCulture), int.Parse(period[5..7], CultureInfo.InvariantCulture), 1)
            .AddMonths(months).ToString("yyyy-MM", CultureInfo.InvariantCulture);

    // The last two years, newest first (and the one shown, if older).
    public static List<OrderChoice> Periods(string current)
    {
        var list = new List<OrderChoice>();
        for (var (p, i) = (ThisMonth, 0); i < 25; i++, p = Shift(p, -1)) list.Add(new(p, Label(p)));
        if (list.All((x) => x.Key != current)) list.Add(new(current, Label(current)));
        return list;
    }

    // Whole forints without fillér, others with two decimals.
    public static string Money(decimal? v) => v is not { } n ? "" : n == Math.Round(n) ? Fmt.Money(n) : $"{Fmt.Num(n, 2)} Ft";

    public static string Qty(decimal v, string? unit) => $"{Fmt.Num(v, 2)} {unit}".Trim();

    public static string Pct(decimal v, int decimals = 1) => $"{Fmt.Num(v, decimals)}%";

    public static string PriceText(StatementLine l) => l.PriceUnit switch
    {
        "%" => Pct(l.Price, 2),
        "Ft / hely / hó" => $"{Money(l.Price)} / hely / hó",
        _ => Money(l.Price),
    };

    public static string StatusText(string status) => status == "none" ? "Nincs elszámolás" : App.Meta.Status("statement", status).Label;

    // "1 db: 12 · 2 db: 5 rendelés", the empty buckets left out.
    public static string Buckets(StatementLine l) =>
        $"{string.Join(" · ", new[] { ("1 db", l.Bucket("1")), ("2 db", l.Bucket("2")), ("3 db", l.Bucket("3")), ("4+ db", l.Bucket("4+")) }
            .Where((b) => b.Item2 > 0).Select((b) => $"{b.Item1}: {Fmt.Int((long)b.Item2)}"))} rendelés";

    // What a line was made of, under its name.
    public static string LineSub(StatementLine l)
    {
        if (l.Manual) return $"Kézi tétel{(string.IsNullOrEmpty(l.CreatedBy) ? "" : $", {l.CreatedBy}")}";
        var drill = l.Drill;
        if (drill == "orders" && !l.DetailFlag("cod_only") && l.Key == "handling.order_base") return Buckets(l);
        if (drill == "orders" && l.Key == "handling.item_extra") return $"{Fmt.Int((long)(l.DetailNumber("extra_pieces") ?? 0))} db a 4. darabtól";
        if (drill == "storage")
            return $"{Fmt.Int((long)(l.DetailNumber("location_days") ?? 0))} helynap, {Fmt.Int((long)(l.DetailNumber("locations") ?? 0))} hely, {l.DetailNumber("days_in_month")} napos hónap";
        if (l.Group == "discount" && l.DetailNumber("base") is { } b) return $"{Pct(l.DetailNumber("pct") ?? 0, 2)} ennyiből: {Money(b)}";
        if (l.Key == "extra.cod_pct") return $"{Money(l.DetailNumber("cod_total") ?? 0)} utánvét";
        return "";
    }

    public static readonly IReadOnlyDictionary<string, string> DrillLabels = new Dictionary<string, string>
    {
        ["orders"] = "Rendelések", ["storage"] = "Tárolás helyenként", ["inbound"] = "Betárolás", ["returns"] = "Visszáru", ["entries"] = "Munkaórák és egyedi tételek",
    };

    // For the drill-down lists.
    public static readonly IValueConverter MoneyText = new FuncValueConverter<decimal?, string>(Money);
    public static readonly IValueConverter Whole = new FuncValueConverter<decimal, string>((v) => Fmt.Num(v, 0));
    public static readonly IValueConverter StoragePrice = new FuncValueConverter<decimal?, string>((v) => v is null ? "nincs ár" : Money(v));
    public static readonly IValueConverter Cod = new FuncValueConverter<DetailOrder?, string>((o) =>
        o is { CodAmount: > 0 } ? $"{Fmt.Num(o.CodAmount, 2)} {(o.Currency is null or "HUF" ? "Ft" : o.Currency)}" : "");
    public static readonly IValueConverter EntryItem = new FuncValueConverter<DetailEntry?, string>((e) =>
        e is null ? "" : e.Kind == "hourly_work" ? "Munkaóra" : e.ItemName ?? "Törölt tétel");
    public static readonly IValueConverter EntryKind = new FuncValueConverter<string?, string>((k) => k == "hourly_work" ? "Óradíjas munka" : "Egyedi tétel");
    public static readonly IValueConverter EntryQty = new FuncValueConverter<DetailEntry?, string>((e) => e is null ? "" : Qty(e.Qty, e.Unit));

    public static string KindText(string kind, string? itemName) => kind == "hourly_work" ? "Óradíjas munka" : itemName ?? "Törölt tétel";
}
