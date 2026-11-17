namespace Fully.Wms.Core.Models;

// Rendeléstörténet (app/worker/routes/history.js): shipped, delivered, returned and cancelled
// orders; returns (VR) put the goods back into stock.

// GET /api/history: filters on shipping or creation date, client, carrier, status, text.
public sealed record HistoryRow(
    int Id, string Number, string? ExternalNumber, string Source, string Status, string Priority, string CustomerName,
    string? Company, string? Email, string? Phone, string? Country, string? Zip, string? City, string? Address,
    string? PickupPointId, string? TrackingNumber, int PackageCount, decimal? WeightKg, decimal CodAmount, string? Currency,
    string CreatedAt, string? PackedAt, string? ShippedAt, string? ShippedDate, string? DeliveredAt, string? CancelledAt,
    int PartnerId, string PartnerCode, string PartnerName, string? CarrierName, string? CarrierCode, int ItemCount, int ReturnCount);

// The key figures follow the filters without the status.
public sealed record HistoryKpis(int Shipped, int Delivered, int Returned, int Cancelled);

public sealed record HistoryPage(List<HistoryRow> Items, int Total, HistoryKpis Kpis);

// GET /api/history/:id/return-options: what can come back, the lots it shipped with, where it
// can go (returns zones for sellable goods, quarantine for damaged ones).
public sealed record ReturnOptions(ReturnOrderRef Order, bool CanReturn, List<ReturnOptionLine> Lines, List<ZoneRef> ReturnsZones, List<ZoneRef> QuarantineZones);

public sealed record ReturnOrderRef(int Id, string Number, string Status, int PartnerId);

public sealed record ReturnOptionLine(
    int ProductId, int Qty, string Sku, string Name, string? Ean, string? Unit, int Returned, int Returnable,
    ZoneRef? SuggestedLocation, List<ReturnLot> Lots)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;
}

public sealed record ReturnLot(string Lot, string Expiry, int Shipped, int Returned, int Returnable);

public sealed record ZoneRef(int Id, string Code);

// POST /api/history/:id/returns
public sealed record ReturnCreated(int Id, string Number, int Pieces);
