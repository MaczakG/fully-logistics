using Avalonia;
using Avalonia.Controls;
using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Stock;

public static class StockFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter PiecesOnHand = new FuncValueConverter<int, string>((n) => $"{Fmt.Int(n)} db készleten");
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter NotPositive = new FuncValueConverter<int, bool>((n) => n <= 0);
    public static readonly IValueConverter Date = new FuncValueConverter<string?, string>((s) => Fmt.Date(s));
    public static readonly IValueConverter DateTime = new FuncValueConverter<string?, string>((s) => Fmt.DateTime(s));
    public static readonly IValueConverter Signed = new FuncValueConverter<int, string>((n) => n > 0 ? $"+{Fmt.Int(n)}" : Fmt.Int(n));
    public static readonly IValueConverter Positive = new FuncValueConverter<int, bool>((n) => n > 0);
    public static readonly IValueConverter Negative = new FuncValueConverter<int, bool>((n) => n < 0);
    public static readonly IValueConverter LotExpiry = new FuncValueConverter<StockLocationRow?, string>((r) =>
        r is null ? "" : string.Join(", ", new[] { r.Lot.Length > 0 ? $"sarzs {r.Lot}" : null, r.Expiry.Length > 0 ? $"lejárat {Fmt.Date(r.Expiry)}" : null }.Where((x) => x is not null)));
    public static readonly IValueConverter RowSummary = new FuncValueConverter<StockRow?, string>((r) =>
        r is null ? "" : $"Készleten {Fmt.Int(r.OnHand)}, foglalt {Fmt.Int(r.Reserved)}{(r.Blocked > 0 ? $", zárolt {Fmt.Int(r.Blocked)}" : "")}, {Fmt.Int(r.Locations)} helyen");
    public static readonly IValueConverter NotStorage = new FuncValueConverter<string?, bool>((k) => k != "storage");
    public static readonly IValueConverter Kg = new FuncValueConverter<decimal?, string>((v) => v is null ? "nincs megadva" : $"{Fmt.Num(v.Value, 3)} kg");
    public static readonly IValueConverter MovementDetail = new FuncValueConverter<Movement?, string>((m) => m is null ? "" : string.Join(" · ", new[]
    {
        m.Lot is { Length: > 0 } ? $"sarzs {m.Lot}" : null,
        m.Expiry is { Length: > 0 } ? $"lejárat {Fmt.Date(m.Expiry)}" : null,
        m.RefNumber ?? (m.RefType == "manual" ? "kézi" : null),
        m.UserName ?? "rendszer",
        m.Note is { Length: > 0 } ? m.Note : null,
    }.Where((x) => x is not null)));
    public static readonly IValueConverter RowLabel = new FuncValueConverter<StockLocationRow?, string>((r) => r is null ? "" : StockText.RowLabel(r));
    public static readonly IValueConverter LocationLotExpiry = new FuncValueConverter<LocationStockRow?, string>((r) =>
        r is null ? "" : string.Join(", ", new[] { r.Lot.Length > 0 ? $"sarzs {r.Lot}" : null, r.Expiry.Length > 0 ? $"lejárat {Fmt.Date(r.Expiry)}" : null, r.PartnerName }.Where((x) => x is not null)));
    public static readonly IValueConverter OrDash = new FuncValueConverter<string?, string>((s) => string.IsNullOrEmpty(s) ? "nincs" : s);
}

// ok / low / out of a stock row as a tag (the web app's wording and colours).
public sealed class StockStatusTag : Border
{
    public static readonly StyledProperty<string?> StatusProperty = AvaloniaProperty.Register<StockStatusTag, string?>(nameof(Status));
    readonly TextBlock text = new();

    public StockStatusTag()
    {
        Classes.Add("tag");
        Child = text;
    }

    public string? Status
    {
        get => GetValue(StatusProperty);
        set => SetValue(StatusProperty, value);
    }

    protected override Type StyleKeyOverride => typeof(Border);

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property != StatusProperty) return;
        var (label, tone) = Status switch
        {
            "ok" => ("Rendben", "ok"),
            "low" => ("Alacsony", "warn"),
            "out" => ("Elfogyott", "danger"),
            _ => (Status ?? "", ""),
        };
        text.Text = label;
        Classes.Remove("ok");
        Classes.Remove("warn");
        Classes.Remove("danger");
        if (tone.Length > 0) Classes.Add(tone);
    }
}
