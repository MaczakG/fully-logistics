using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Stock;

public static class StockTabsFormat
{
    public static readonly IValueConverter Occupancy = new FuncValueConverter<SizeOccupancy?, string>((z) => z is null ? ""
        : $"{Fmt.Int(z.Occupied)} / {Fmt.Int(z.Total)} foglalt ({(z.Total == 0 ? 0 : z.Occupied * 100 / z.Total)}%){(z.EmptyDedicated > 0 ? $", {Fmt.Int(z.EmptyDedicated)} fix szabad" : "")}");

    public static readonly IValueConverter Occupant = new FuncValueConverter<LocationRow?, string>((l) => l is null ? ""
        : l.OccupantName is { } n ? $"{n} ({l.OccupantCode}), {Fmt.Int(l.Products)} cikk" : l.DedicatedPartnerCode is { } d ? $"üres, fix hely: {d}" : "üres");

    public static readonly IValueConverter Tracking = new FuncValueConverter<ProductRow?, string>((p) => p is null ? ""
        : (p.TrackLot, p.TrackExpiry) switch { (true, true) => "sarzs, lejárat", (true, false) => "sarzs", (false, true) => "lejárat", _ => "" });

    public static readonly IValueConverter ActiveText = new FuncValueConverter<bool, string>((a) => a ? "Aktív" : "Inaktív");
}
