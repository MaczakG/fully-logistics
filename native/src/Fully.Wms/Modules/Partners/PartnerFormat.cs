using System.Globalization;
using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Partners;

public static class PartnerFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter Money = new FuncValueConverter<decimal, string>((n) => Fmt.Money(n));
    public static readonly IValueConverter Num1 = new FuncValueConverter<decimal, string>((n) => Fmt.Num(n, 1));
    public static readonly IValueConverter DateText = new FuncValueConverter<string?, string>((s) => Fmt.Date(s));
    public static readonly IValueConverter DateTimeText = new FuncValueConverter<string?, string>((s) => Fmt.DateTime(s));
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");

    public static readonly Dictionary<string, string> DocumentKinds = new() { ["contract"] = "Szerződés", ["other"] = "Egyéb" };

    public static string Today => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).ToString("yyyy-MM-dd");

    // 2 048 000 -> "2 MB", 12 300 -> "12 KB"
    public static string Bytes(long n) => n >= 1048576 ? $"{Fmt.Num(n / 1048576m, 1)} MB" : n >= 1024 ? $"{Fmt.Num(n / 1024m, 0)} KB" : $"{Fmt.Int(n)} B";

    // "50 × 40 × 50 cm, max. 110 kg"
    public static string Dims(StoragePrice s)
    {
        var size = s.WidthCm is { } w && s.DepthCm is { } d && s.HeightCm is { } h ? $"{Fmt.Num(w, 1)} × {Fmt.Num(d, 1)} × {Fmt.Num(h, 1)} cm" : "";
        var kg = s.MaxKg is { } m ? $"max. {Fmt.Num(m, 1)} kg" : "";
        var text = string.Join(", ", new[] { size, kg }.Where((x) => x.Length > 0));
        return text.Length > 0 ? text : "nincs megadva";
    }

    // "2026-10" -> "2026. október"
    public static string Month(string? period) => DateTime.TryParseExact($"{period}-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
        ? d.ToString("yyyy. MMMM", Fmt.Hu) : period ?? "";

    // "BillingEmail" -> "billing_email": the server's field name of a form property.
    public static string Snake(string property) =>
        string.Concat(property.Select((c, i) => char.IsUpper(c) ? (i > 0 ? "_" : "") + char.ToLowerInvariant(c) : c.ToString()));

    // Takes a field's error away once the field changes.
    public static Dictionary<string, string>? Without(Dictionary<string, string> errors, string? key) =>
        key is not null && errors.ContainsKey(key) ? errors.Where((e) => e.Key != key).ToDictionary() : null;

    // "Kutyabarát Webshop Kft." -> "KUTYABARAT": the first word without accents, at most 12 letters.
    public static string SuggestCode(string name)
    {
        string[] skip = ["KFT", "ZRT", "BT", "NYRT", "EV", "KKT", "LTD", "GMBH", "SRO", "THE"];
        var plain = new string(name.Normalize(System.Text.NormalizationForm.FormD)
            .Where((c) => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray()).ToUpperInvariant();
        var words = new string(plain.Select((c) => c is >= 'A' and <= 'Z' or >= '0' and <= '9' ? c : ' ').ToArray())
            .Split(' ', StringSplitOptions.RemoveEmptyEntries).Where((w) => !skip.Contains(w));
        var first = words.FirstOrDefault() ?? "";
        return first.Length > 12 ? first[..12] : first;
    }
}
