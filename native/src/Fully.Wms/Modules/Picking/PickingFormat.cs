using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Picking;

public static class PickingFormat
{
    public static readonly IValueConverter Int = new FuncValueConverter<int, string>((n) => Fmt.Int(n));
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
    public static readonly IValueConverter DateTime = new FuncValueConverter<string?, string>((s) => Fmt.DateTime(s));

    // Desktop: the summary and actions above the work; phone: below it (the scan field comes first).
    public static readonly IValueConverter RowOfSummary = new FuncValueConverter<bool, int>((compact) => compact ? 3 : 1);

    // The packing station: the queue beside the order on the desktop, under it on the phone.
    public static readonly IValueConverter SpanOfMain = new FuncValueConverter<bool, int>((compact) => compact ? 2 : 1);
    public static readonly IValueConverter ColumnOfSide = new FuncValueConverter<bool, int>((compact) => compact ? 0 : 1);
    public static readonly IValueConverter RowOfSide = new FuncValueConverter<bool, int>((compact) => compact ? 1 : 0);
    public static readonly IValueConverter SideMargin = new FuncValueConverter<bool, Avalonia.Thickness>((compact) => compact ? new(0) : new(16, 0, 0, 0));

    public static double Ratio(int done, int total) => total <= 0 ? 0 : Math.Min(1, done / (double)total);

    public static readonly IValueConverter WaveRatio = new FuncValueConverter<WaveRow?, double>((w) => w is null ? 0 : Ratio(w.Picked, w.Qty));
    public static readonly IValueConverter WaveDone = new FuncValueConverter<WaveRow?, bool>((w) => w is not null && w.Qty > 0 && w.Picked >= w.Qty);
    public static readonly IValueConverter WavePicked = new FuncValueConverter<WaveRow?, string>((w) => w is null ? "" : $"{Fmt.Int(w.Picked)} / {Fmt.Int(w.Qty)} db");
    public static readonly IValueConverter ShortQty = new FuncValueConverter<int, string>((n) => n > 0 ? $"{Fmt.Int(n)} db" : "");
    public static readonly IValueConverter Picker = new FuncValueConverter<string?, string>((n) => string.IsNullOrEmpty(n) ? "nincs" : n);

    public static readonly IValueConverter WaveStarted = new FuncValueConverter<WaveRow?, string>((w) => w is null ? ""
        : Fmt.DateTime(w.StartedAt ?? w.CreatedAt) + (w.CompletedAt is { Length: > 0 } c ? $"\nLezárva {Fmt.DateTime(c)}" : ""));

    public static readonly IValueConverter WaveCardLine = new FuncValueConverter<WaveRow?, string>((w) => w is null ? "" : string.Join(" · ", new[]
    {
        $"{Fmt.Int(w.OrderCount)} rendelés",
        $"komissiós: {(string.IsNullOrEmpty(w.PickerName) ? "nincs" : w.PickerName)}",
        w.Short > 0 ? $"hiány {Fmt.Int(w.Short)} db" : null,
        Fmt.DateTime(w.StartedAt ?? w.CreatedAt),
    }.Where((x) => x is not null)));

    // A courier's short name from /api/meta (GLS, DPD ...), else the partner's name.
    public static string CarrierShort(string? name, string? code) =>
        code is { Length: > 0 } c && c != "other" && App.Meta.Carriers.TryGetValue(c, out var s) ? s : name ?? "";

    public static readonly IValueConverter OrderCarrier = new FuncValueConverter<WaveOrder?, string>((o) => o is null ? "" : CarrierShort(o.CarrierName, o.CarrierCode));
    public static readonly IValueConverter ReadyCarrier = new FuncValueConverter<ReadyOrder?, string>((o) => o is null ? ""
        : o.CarrierName is null ? "nincs fuvarozó" : CarrierShort(o.CarrierName, o.CarrierCode));
    public static readonly IValueConverter PackedCarrier = new FuncValueConverter<PackedOrder?, string>((o) => o is null ? "" : CarrierShort(o.CarrierName, o.CarrierCode));

    public static readonly IValueConverter OrderCustomer = new FuncValueConverter<WaveOrder?, string>((o) => o is null ? ""
        : string.Join(" · ", new[] { o.PartnerCode, o.City }.Where((x) => !string.IsNullOrEmpty(x))));
    public static readonly IValueConverter OrderPicked = new FuncValueConverter<WaveOrder?, string>((o) => o is null ? "" : $"{Fmt.Int(o.PickedCount)} / {Fmt.Int(o.ItemCount)}");
    public static readonly IValueConverter OrderAllPicked = new FuncValueConverter<WaveOrder?, bool>((o) => o is not null && o.PickedCount >= o.ItemCount);
    public static readonly IValueConverter OrderShort = new FuncValueConverter<WaveOrder?, string>((o) => o is { WaveShort: > 0 } ? $"hiány {Fmt.Int(o.WaveShort)}" : "");
    public static readonly IValueConverter OrderCardLine = new FuncValueConverter<WaveOrder?, string>((o) => o is null ? "" : string.Join(" · ", new[]
    {
        $"kiszedve {Fmt.Int(o.PickedCount)} / {Fmt.Int(o.ItemCount)}",
        o.WaveShort > 0 ? $"hiány {Fmt.Int(o.WaveShort)}" : null,
        CarrierShort(o.CarrierName, o.CarrierCode) is { Length: > 0 } c ? c : null,
        !o.InWave ? "már nincs a hullámban" : null,
    }.Where((x) => x is not null)));

    public static readonly IValueConverter ReadySub = new FuncValueConverter<ReadyOrder?, string>((o) => o is null ? ""
        : o.PartnerCode + (o.WaveNumber is { Length: > 0 } w ? $" · {w}" : ""));
    public static readonly IValueConverter ReadyCardLine = new FuncValueConverter<ReadyOrder?, string>((o) => o is null ? "" : string.Join(" · ", new[]
    {
        o.PartnerCode, o.WaveNumber, $"{Fmt.Int(o.ItemCount)} db",
        o.CarrierName is null ? "nincs fuvarozó" : CarrierShort(o.CarrierName, o.CarrierCode),
    }.Where((x) => !string.IsNullOrEmpty(x))));

    public static readonly IValueConverter PackedTime = new FuncValueConverter<PackedOrder?, string>((o) => o is null ? "" : Time(o.PackedAt));

    // "14:05" in Budapest time.
    public static string Time(string? iso) => DateTimeOffset.TryParse(iso, out var t)
        ? TimeZoneInfo.ConvertTime(t, Fmt.Budapest).ToString("HH:mm", Fmt.Hu) : "";

    public static string Kg(decimal kg) => $"{Fmt.Num(kg)} kg";

    public static string LotText(string lot, string expiry) => string.Join(" · ", new[]
    {
        lot.Length > 0 ? $"Tétel {lot}" : null,
        expiry.Length > 0 ? $"Lejárat {Fmt.Date(expiry)}" : null,
    }.Where((x) => x is not null));
}
