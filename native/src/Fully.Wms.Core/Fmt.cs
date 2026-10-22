using System.Globalization;

namespace Fully.Wms.Core;

// Numbers, money and dates the Hungarian way, as the web app shows them (FL.fmt).
public static class Fmt
{
    public static readonly CultureInfo Hu = CultureInfo.GetCultureInfo("hu-HU");

    public static string Int(long n) => n.ToString("#,0", Hu);

    public static string Num(decimal n, int maxDecimals = 2) => n.ToString("#,0." + new string('#', maxDecimals), Hu);

    public static string Money(decimal n) => $"{Num(Math.Round(n), 0)} Ft";

    // "2026-10-22" or an ISO time -> "2026. 10. 22."
    public static string Date(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        if (iso.Length >= 10 && DateOnly.TryParseExact(iso[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
            return d.ToString("yyyy. MM. dd.", Hu);
        return iso;
    }

    // An ISO time -> "2026. 10. 22. 14:05" in Budapest time.
    public static string DateTime(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        if (!DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return iso;
        return TimeZoneInfo.ConvertTime(t, Budapest).ToString("yyyy. MM. dd. HH:mm", Hu);
    }

    public static TimeZoneInfo Budapest { get; } = FindBudapest();

    static TimeZoneInfo FindBudapest()
    {
        foreach (var id in new[] { "Europe/Budapest", "Central Europe Standard Time" })
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById(id); } catch (TimeZoneNotFoundException) { } catch (InvalidTimeZoneException) { }
        }
        return TimeZoneInfo.Local;
    }

    // Reads a number typed by a person: "1 234,5", "1234.5", "12" -> decimal; null if not a number.
    public static decimal? ParseNumber(string? text)
    {
        var s = (text ?? "").Trim().Replace(" ", "").Replace(" ", "").Replace(" ", "").Replace(',', '.');
        if (s.Length == 0) return null;
        return decimal.TryParse(s, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var n) ? n : null;
    }
}
