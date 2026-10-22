using Avalonia.Data.Converters;
using Fully.Wms.Core;

namespace Fully.Wms.Modules.Orders;

public static class OrdersFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);

    public static readonly Dictionary<string, string> Sources = new()
    {
        ["manual"] = "Kézi rögzítés", ["csv"] = "CSV import", ["api"] = "Partner API", ["shopify"] = "Shopify",
        ["woocommerce"] = "WooCommerce", ["shoprenter"] = "Shoprenter", ["unas"] = "UNAS",
    };

    public static string Source(string? s) => s is not null && Sources.TryGetValue(s, out var v) ? v : s ?? "";

    // "12 p", "5 ó", "3 nap" since the order arrived.
    public static string Age(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, out var t)) return "";
        var min = Math.Max(0, (int)Math.Round((DateTimeOffset.UtcNow - t).TotalMinutes));
        if (min < 60) return $"{min} p";
        var h = min / 60;
        return h < 48 ? $"{h} ó" : $"{h / 24} nap";
    }

    // Older than a day: warn, two days: danger.
    public static string AgeTone(string iso)
    {
        if (!DateTimeOffset.TryParse(iso, out var t)) return "";
        var h = (DateTimeOffset.UtcNow - t).TotalHours;
        return h >= 48 ? "danger" : h >= 24 ? "warn" : "";
    }

    // A courier's short name from /api/meta (GLS, DPD ...), else the partner's name.
    public static string CarrierShort(string? name, string? code) =>
        code is { Length: > 0 } c && c != "other" && App.Meta.Carriers.TryGetValue(c, out var s) ? s : name ?? "";

    public static string Kg(decimal kg) => $"{Fmt.Num(kg)} kg";

    public static string Qty(int n, string unit) => $"{Fmt.Int(n)} {unit}";
}

// Converters of the order detail.
public static class OrderFormat
{
    // Classes.primary="{Binding Primary, Converter={x:Static local:OrderFormat.Is}, ConverterParameter=wave}"
    public static readonly IValueConverter Is = new FuncValueConverter<string?, string?, bool>((value, key) => value is not null && value == key);
    // The server's message of a field: {Binding Errors, Converter=..., ConverterParameter=email}
    public static readonly IValueConverter FieldError = new FuncValueConverter<Dictionary<string, string>?, string?, string?>((errors, key) =>
        errors is not null && key is not null && errors.TryGetValue(key, out var v) ? v : null);
    public static readonly IValueConverter HasFieldError = new FuncValueConverter<Dictionary<string, string>?, string?, bool>((errors, key) =>
        errors is not null && key is not null && errors.ContainsKey(key));

    public static readonly IValueConverter PanelColumns = new FuncValueConverter<bool, int>((compact) => compact ? 1 : 2);
    public static readonly IValueConverter EventMeta = new FuncValueConverter<Core.Models.OrderEvent?, string>((e) => e is null ? ""
        : Fmt.DateTime(e.At) + (string.IsNullOrEmpty(e.UserName) ? "" : $" · {e.UserName}"));
}
