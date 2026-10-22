namespace Fully.Wms.Core.Models;

// Megrendelések (app/worker/routes/orders.js). Open orders: new -> picking -> packed (hold aside),
// then shipped, delivered or returned (Rendeléstörténet), or cancelled.

// GET /api/orders: open orders with availability (new and hold: ok or short).
public sealed record OrderRow(
    int Id, string Number, string? ExternalNumber, string Source, string Status, string Priority, string CustomerName,
    string? Company, string? City, string? Zip, string? Country, decimal CodAmount, string? Currency, string CreatedAt,
    string? OrderedAt, string? PackedAt, string? TrackingNumber, int? WaveId, int PartnerId, string PartnerCode,
    string PartnerName, int? CarrierId, string? CarrierName, string? CarrierCode, string? WaveNumber, int ItemCount,
    int LineCount, int PickedCount, string? Availability)
{
    public bool IsExpress => Priority == "express";
}

// The key figures follow the client and carrier filters, not the status tab or the search.
public sealed record OrderKpis(int New, int Hold, int Picking, int Packed, int Express, int Fulfillable);

public sealed record OrdersPage(List<OrderRow> Items, int Total, OrderKpis Kpis);

// GET /api/orders/:id (also for Rendeléstörténet).
public sealed record OrderDetail(
    int Id, string Number, string Status, string Priority, string Source, string? ExternalId, string? ExternalNumber,
    OrderPartner Partner, string CustomerName, string? Company, string? Email, string? Phone, string? Country, string? Zip,
    string? City, string? Address, string? PickupPointId, OrderCarrier? Carrier, string? CarrierService, decimal CodAmount,
    string? Currency, string? Note, OrderRef? Wave, OrderRef? Pickup, int PackageCount, decimal? WeightKg, string? TrackingNumber,
    string? TrackingUrl, DocumentRef? Label, bool CourierConfigured, string? OrderedAt, string CreatedAt, string? UpdatedAt,
    string? PackedAt, string? ShippedAt, string? ShippedDate, string? DeliveredAt, string? CancelledAt, int ItemCount,
    int PickedCount, int LineCount, string? Availability, List<OrderLine> Lines, List<OrderPick> Picks, List<OrderEvent> Events,
    List<OrderReturn> Returns)
{
    public bool IsExpress => Priority == "express";
}

public sealed record OrderPartner(int Id, string Code, string Name);

public sealed record OrderCarrier(int Id, string Name, string? CarrierCode);

public sealed record OrderRef(int Id, string Number, string? Status);

// Free and Available only while the order is new or on hold.
public sealed record OrderLine(
    int Id, int ProductId, int Qty, int PickedQty, string? ExternalLineId, string Sku, string Name, string? Ean, string? Unit,
    decimal? WeightKg, bool Active, int ReturnedQty, int? Free, bool? Available)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;
}

public sealed record OrderPick(
    int Id, int WaveId, string WaveNumber, string WaveStatus, string LocationCode, string Sku, string Lot, string Expiry,
    int Qty, int PickedQty, int ShortQty, int RestockedQty, string? PickedAt, string? PickedByName);

// type: created, status, note, label, sync, return
public sealed record OrderEvent(int Id, string At, string Type, string Text, string? UserName);

public sealed record OrderReturn(
    int Id, string Number, string? ReceivedAt, string? ReceivedDate, string? Reason, string? Note, string? CreatedByName,
    List<OrderReturnLine>? Lines, List<OrderReturnPhoto>? Photos);

// condition: sellable or damaged
public sealed record OrderReturnLine(int Id, int ReturnId, int ProductId, int Qty, string Condition, string Lot, string Expiry, string Sku, string Name, string? LocationCode);

public sealed record OrderReturnPhoto(int Id, string Filename, string? ContentType);

// POST /api/orders
public sealed record OrderCreated(int Id, string Number, bool Duplicate);

// PATCH /api/orders/:id: the groups that changed (címzett, szállítási cím, tételek ...).
public sealed record OrderSaved(bool Ok, List<string> Changed);
