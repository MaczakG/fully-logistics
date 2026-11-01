using System.Globalization;
using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Transport;

public static class TransportFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsInfo = new FuncValueConverter<string?, bool>((t) => t == "info");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
    public static readonly IValueConverter IsCancelled = new FuncValueConverter<string?, bool>((s) => s == "cancelled");
    public static readonly IValueConverter CardColumns = new FuncValueConverter<bool, int>((compact) => compact ? 1 : 2);
    // Form rows: "4,2" is four fields side by side on the desktop, two on the phone.
    public static readonly IValueConverter Columns = new FuncValueConverter<bool, string, int>((compact, spec) =>
    {
        var parts = (spec ?? "1").Split(',');
        return int.Parse(compact && parts.Length > 1 ? parts[1] : compact ? "1" : parts[0]);
    });
    public static readonly IValueConverter KpiColumns = new FuncValueConverter<bool, int>((compact) => compact ? 2 : 4);

    // COD per currency: "12 990 Ft" or "12 990 Ft + 40 EUR".
    public static string Cod(Dictionary<string, decimal>? cod)
    {
        var parts = (cod ?? []).Where((p) => p.Value != 0).Select((p) => p.Key == "HUF" ? Fmt.Money(p.Value) : $"{Fmt.Num(p.Value, 2)} {p.Key}").ToList();
        return parts.Count > 0 ? string.Join(" + ", parts) : Fmt.Money(0);
    }

    public static string Window(string? from, string? to) =>
        string.IsNullOrEmpty(from) && string.IsNullOrEmpty(to) ? "" : $"{(string.IsNullOrEmpty(from) ? "?" : from)}-{(string.IsNullOrEmpty(to) ? "?" : to)}";

    // "2026. október 22., csütörtök"
    public static string DateLong(string? iso) => DateTime.TryParseExact(iso, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
        ? d.ToString("yyyy. MMMM d., dddd", Fmt.Hu) : iso ?? "";

    // An ISO time -> "14:05" in Budapest time.
    public static string Time(string? iso) => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)
        ? TimeZoneInfo.ConvertTime(t, Fmt.Budapest).ToString("HH:mm", Fmt.Hu) : "";

    public static string Kg(decimal? kg) => kg is { } v ? $"{Fmt.Num(v)} kg" : "";

    public static string CarrierLabel(string? code) => code is { Length: > 0 } c && App.Meta.Carriers.TryGetValue(c, out var s) ? s : "";

    public static readonly Dictionary<string, string> Directions = new() { ["out"] = "Kimenő", ["in"] = "Beérkező" };

    public static string Today => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).ToString("yyyy-MM-dd");

    // "08:30": hours and minutes, or empty.
    public static bool IsTime(string s) => s.Length == 0 || (TimeOnly.TryParseExact(s, "HH:mm", out _) && s.Length == 5);
}
