using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Készlet (app/worker/routes/stock.js). Quantities are whole pieces.

// GET /api/stock: one row per product. status: ok, low (below the minimum), out (nothing available).
public sealed record StockRow(
    int ProductId, int PartnerId, string PartnerCode, string PartnerName, string Sku, string Name, string? Ean, string? Unit,
    int MinStock, bool Active, bool TrackLot, bool TrackExpiry, int OnHand, int Reserved, int Blocked, int Available,
    int Locations, string? NextExpiry, string Status, string? StatusLabel);

public sealed record StockSummary(int Products, int OnHand, int Low, int Out);

public sealed record StockPage(List<StockRow> Items, int Total, StockSummary Summary);

// GET /api/stock/product/:id
public sealed record StockProduct(
    ProductInfo Product, ProductAvailability Availability, List<StockLocationRow> Locations,
    List<StockReservation> Reservations, List<Movement> Movements);

public sealed record ProductInfo(
    int Id, int PartnerId, string PartnerCode, string PartnerName, string Sku, string Name, string? Ean, string? Unit,
    decimal? WeightKg, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, int MinStock, bool TrackLot, bool TrackExpiry,
    bool Active, string? Notes, string? EanWarning)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;
}

// The availability helper of the server answers camelCase.
public sealed record ProductAvailability(
    [property: JsonPropertyName("onHand")] int OnHand, int Reserved, int Blocked, int Available, int Incoming, string Status, string? StatusLabel);

// A product's stock on one location, lot and expiry (expiry "" = none).
public sealed record StockLocationRow(
    int StockId, int LocationId, string Code, string? Zone, string Kind, string? KindLabel, string SizeCode, string Lot, string Expiry, int Qty);

public sealed record StockReservation(int Id, string Number, string Status, string? CustomerName, int Qty);

public sealed record Movement(
    int Id, string At, string? Date, string Type, string? TypeLabel, int PartnerId, string? PartnerCode, int ProductId, string? Sku,
    string? Name, string? Unit, int? LocationId, string? LocationCode, string? Lot, string? Expiry, int Qty, string? RefType,
    int? RefId, string? RefNumber, string? UserName, string? Note);

// GET /api/stock/locations/:id
public sealed record LocationDetail(LocationInfo Location, List<LocationStockRow> Stock, LastMovement? LastMovement);

public sealed record LocationInfo(
    int Id, string Code, string? Zone, string Kind, bool Active, string? Note, string SizeCode, string? SizeName,
    int? DedicatedId, string? DedicatedCode, string? DedicatedName, string? KindLabel);

public sealed record LocationStockRow(
    int ProductId, string Sku, string Name, string? Unit, int PartnerId, string PartnerCode, string PartnerName, string Lot, string Expiry, int Qty);

public sealed record LastMovement(string At, string Type, string? TypeLabel);

// GET /api/lookup/locations?q=: codes starting with q, for pickers and for telling a scanned
// location code from a product code.
public sealed record LocationLookup(int Id, string Code, string? Zone, string Kind, int SizeId, string SizeCode, int? PartnerId);

// { items: [...] } answers (lookups).
public sealed record ItemList<T>(List<T> Items);

public sealed record TransferResult(bool Ok, string From, string To);

public sealed record AdjustResult(bool Ok, int Before, int After, int Diff);

// GET /api/lookup/partners
public sealed record PartnerLookup(int Id, string Type, string Code, string Name, string Status, string? CarrierCode)
{
    public string Display => $"{Name} ({Code})";
}
