using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Komissió (app/worker/routes/picking.js). A wave: open -> picking -> picked -> completed, or
// cancelled. Its picks are grouped into tasks (one per location, product, lot and expiry) in the
// walking order of the locations.

// GET /api/picking/waves?status=active|completed|cancelled|all
public sealed record WaveRow(
    int Id, string Number, string Status, string? Note, string CreatedAt, string? StartedAt, string? CompletedAt,
    string? PickerName, int OrderCount, int OpenOrders, int Qty, int Picked, int Short);

public sealed record WavesPage(List<WaveRow> Items, int Total, Dictionary<string, int> Counts, int ReadyToPack);

// GET /api/picking/waves/:id
public sealed record WaveDetail(
    int Id, string Number, string Status, int? PickerId, string? Note, string CreatedAt, string? StartedAt, string? CompletedAt,
    string? PickerName, string? CreatedByName, List<PickTask> Tasks, List<WaveOrder> Orders, WaveProgress Progress,
    List<string> IncompleteOrders);

public sealed record WaveProgress(int Qty, int Picked, int Short, int Remaining, int Tasks, int OpenTasks);

// state: open, short, done. pick_id is the first open pick of the task, sent back when confirming.
public sealed record PickTask(
    string Key, int PickId, List<int> PickIds, TaskLocation Location, TaskProduct Product, string Lot, string Expiry,
    int Qty, int Picked, int Short, int Remaining, bool Express, List<string> Orders, string State)
{
    public bool IsOpen => State == "open";
}

public sealed record TaskLocation(int Id, string Code, string? Zone);

public sealed record TaskProduct(int Id, string Sku, string Name, string? Ean, string? Unit)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;

    // The server's rule: the SKU in any case, or the EAN (leading zeros ignored).
    public bool Matches(string code)
    {
        var c = code.Trim();
        if (c.Length == 0) return false;
        if (string.Equals(Sku, c, StringComparison.OrdinalIgnoreCase)) return true;
        if (string.IsNullOrEmpty(Ean)) return false;
        if (Ean == c) return true;
        if (!c.All(char.IsAsciiDigit) || !Ean.All(char.IsAsciiDigit)) return false;
        var a = c.TrimStart('0');
        return a.Length > 0 && a == Ean.TrimStart('0');
    }
}

// An order of the wave (in_wave false: it was taken out of the wave since).
public sealed record WaveOrder(
    int Id, string Number, string? ExternalNumber, string Status, string Priority, string CustomerName, string? City,
    string? TrackingNumber, int? WaveId, string PartnerCode, string? CarrierName, string? CarrierCode, int ItemCount,
    int PickedCount, bool InWave, int WaveQty, int WavePicked, int WaveShort, bool Ready)
{
    public bool IsExpress => Priority == "express";
}

// GET /api/picking/waves/:id/scan?code=: kind location, product, order or unknown.
public sealed record WaveScanResult(string Kind, TaskLocation? Location, TaskProduct? Product, WaveScanOrder? Order, string? Message);

public sealed record WaveScanOrder(int Id, string Number, string Status);

public sealed record PickConfirmed(bool Ok, int Picked, int Left, string WaveStatus);

// moved: the missing pieces planned from other locations; missing: what no location has.
public sealed record PickShort(bool Ok, int Short, List<MovedQty> Moved, int Missing, string? WaveStatus);

public sealed record MovedQty(string Code, int Qty);

public sealed record WaveCompleted(bool Ok, List<string> Reverted);

public sealed record WaveCancelled(bool Ok, int Orders, List<Restocked> Restocked, int Packed);

// Its keys are camelCase (pickId).
public sealed record Restocked([property: JsonPropertyName("pickId")] int PickId, string Sku, int Qty, string Code, bool Fallback);

public sealed record WaveCreated(int Id, string Number, int Orders, int Picks, List<string> Skipped);

public sealed record UserLookup(int Id, string Name);

// GET /api/orders?status=new&availability=ok: the orders a new wave would take.
public sealed record OrderCandidate(int Id, string Number, int ItemCount, string Priority);

public sealed record OrderCandidates(List<OrderCandidate> Items, int Total);

// GET /api/picking/packing[?wave_id=]
public sealed record PackingQueue(List<ReadyOrder> Ready, List<PackedOrder> Packed, int StillPicking, WaveRef? Wave);

public sealed record WaveRef(int Id, string Number, string Status);

public sealed record ReadyOrder(
    int Id, string Number, string? ExternalNumber, string Priority, string CustomerName, string? City, decimal CodAmount,
    string CreatedAt, int? WaveId, string? WaveNumber, string PartnerCode, string? CarrierName, string? CarrierCode,
    int ItemCount, int LineCount)
{
    public bool IsExpress => Priority == "express";
}

public sealed record PackedOrder(
    int Id, string Number, string CustomerName, string? TrackingNumber, int? LabelDocumentId, int PackageCount,
    string? PackedAt, string? CarrierName, string? CarrierCode);

// GET /api/picking/orders/:id, packing/lookup, and the answer of pack and unpack.
public sealed record PackingOrder(
    int Id, string Number, string? ExternalNumber, string Status, string Priority, PackingPartner Partner, string CustomerName,
    string? Company, string? Phone, string? Email, string? Country, string? Zip, string? City, string? Address,
    string? PickupPointId, PackingCarrier? Carrier, string? CarrierService, decimal CodAmount, string? Currency, string? Note,
    WaveRef? Wave, int? PickupId, int PackageCount, decimal? WeightKg, string? TrackingNumber, string? TrackingUrl,
    DocumentRef? Label, string? PackedAt, List<PackingLine> Lines, bool AllPicked, bool TrackingRequired,
    decimal? SuggestedWeightKg, bool WaveCompleted = false, string? Warning = null)
{
    public bool IsExpress => Priority == "express";
}

public sealed record PackingPartner(int Id, string Code, string Name);

// configured: the courier's API is set up, so the label can be made from here.
public sealed record PackingCarrier(int Id, string Name, string? CarrierCode, bool Configured);

public sealed record PackingLine(int Id, int ProductId, int Qty, int PickedQty, string Sku, string Name, string? Ean, string? Unit, decimal? WeightKg)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;
    public bool Done => PickedQty >= Qty;
}

public sealed record DocumentRef(int Id, string? Filename);
