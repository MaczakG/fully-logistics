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

// GET /api/stock/locations: occupancy of the locations, and the summary by size and by client.
public sealed record LocationRow(
    int Id, string Code, string? Zone, string Kind, bool Active, int SizeId, string SizeCode, string? SizeName,
    int? DedicatedPartnerId, string? DedicatedPartnerCode, string? DedicatedPartnerName, int? OccupantId, string? OccupantCode,
    string? OccupantName, int Products, int Qty, string? KindLabel);

public sealed record LocationsPage(List<LocationRow> Items, int Total, LocationsSummary Summary);

public sealed record LocationsSummary(
    [property: System.Text.Json.Serialization.JsonPropertyName("bySize")] List<SizeOccupancy> BySize,
    [property: System.Text.Json.Serialization.JsonPropertyName("byPartner")] List<PartnerOccupancy> ByPartner);

public sealed record SizeOccupancy(int SizeId, string Code, string Name, int Total, int Occupied, int Empty, int EmptyDedicated);

public sealed record PartnerOccupancy(int PartnerId, string Code, string Name, Dictionary<string, int> Sizes, int Total);

// GET /api/stock/map: compact rows [id, code, zone, size, kind, active, dedicated, occupant, products, qty].
public sealed record StockMapData(List<string> Columns, List<List<System.Text.Json.JsonElement>> Rows, List<MapPartner> Partners);

public sealed record MapPartner(int Id, string Code, string Name);

// GET /api/stock/movements
public sealed record MovementsPage(List<Movement> Items, int Total, MovementSums Sums);

public sealed record MovementSums(int In, int Out);

// GET /api/products and /api/products/:id
public sealed record ProductRow(
    int Id, int PartnerId, string PartnerCode, string PartnerName, string Sku, string Name, string? Ean, string? Unit,
    decimal? WeightKg, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, int MinStock, bool TrackLot, bool TrackExpiry,
    bool Active, string? Notes, int OnHand, string? EanWarning, bool CanDeactivate = false);

public sealed record ProductsPage(List<ProductRow> Items, int Total);

public sealed record ProductSaved(int Id, List<string>? Warnings);
