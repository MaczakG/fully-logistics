namespace Fully.Wms.Core.Models;

// Betárolás (app/worker/routes/inbound.js). Statuses: expected -> arrived -> receiving -> completed,
// or cancelled.

// GET /api/inbound: one row per inbound with line totals.
public sealed record InboundRow(
    int Id, string Number, int PartnerId, string PartnerCode, string PartnerName, int? SupplierId, string? SupplierCode,
    string? SupplierName, string Source, string? ExternalRef, string? ExpectedDate, string? ArrivedAt, string? CompletedAt,
    string Status, int Pallets, int Cartons, bool HasDiscrepancy, string CreatedAt, int LineCount, int ExpectedQty,
    int ReceivedQty, int DamagedQty, int PutawayQty);

public sealed record InboundKpis(int ExpectedToday, int Overdue, int Arrived, int Receiving, int Discrepancy30d, string Today, string DiscrepancySince);

public sealed record InboundPage(List<InboundRow> Items, int Total, Dictionary<string, int> Counts, InboundKpis Kpis);

// GET /api/inbound/:id
public sealed record InboundDetail(
    int Id, string Number, int PartnerId, string PartnerCode, string PartnerName, int? SupplierId, string? SupplierCode,
    string? SupplierName, string Source, string? ExternalRef, string? ExpectedDate, string Status, int Pallets, int Cartons,
    string? Note, string? ArrivalNote, string? ArrivedAt, string? CompletedAt, string? CompletedByName, string? CancelledAt,
    string? CancelReason, bool HasDiscrepancy, string? DiscrepancyNote, string? CreatedByName, string CreatedAt,
    List<InboundLine> Lines, InboundTotals Totals, bool Discrepancy, bool CanCancel, LocationRef? Quarantine,
    List<HistoryEntry> History);

public sealed record InboundTotals(int Lines, int Expected, int Received, int Damaged, int Putaway);

// received_qty: every piece that arrived (damaged ones too), damaged_qty: the damaged part,
// putaway_qty: what went onto shelves. open_qty = received - put away.
public sealed record InboundLine(
    int Id, int InboundId, int ProductId, int ExpectedQty, int ReceivedQty, int DamagedQty, string Lot, string Expiry,
    int? LocationId, int PutawayQty, string? Note, string? ReceivedAt, string Sku, string Name, string? Ean, string? Unit,
    bool TrackLot, bool TrackExpiry, bool ProductActive, string? LocationCode, string? ReceivedByName, int OpenQty,
    List<LineIssue>? Issues, List<Putaway>? Putaways, Suggestion? Suggested)
{
    public string UnitText => string.IsNullOrEmpty(Unit) ? "db" : Unit;
    public bool HasDiscrepancy => ReceivedQty != ExpectedQty || DamagedQty > 0 || PutawayQty < ReceivedQty;
    // Lot and expiry can be given until something of the line is on a shelf.
    public bool NeedsLot => TrackLot && Lot.Length == 0 && PutawayQty == 0;
    public bool NeedsExpiry => TrackExpiry && Expiry.Length == 0 && PutawayQty == 0;
    public bool MissingTracking => (TrackLot && Lot.Length == 0) || (TrackExpiry && Expiry.Length == 0);
    public int LeftToReceive => Math.Max(ExpectedQty - ReceivedQty, 0);
    public int LeftToPut => Math.Max(ReceivedQty - PutawayQty, 0);

    // Damaged pieces not yet in quarantine.
    public int DamagedLeft => Math.Max(DamagedQty - (Putaways ?? []).Where((p) => p.LocationKind == "quarantine").Sum((p) => p.Qty), 0);

    // todo, partial, done, over, extra (not expected)
    public string State => ExpectedQty == 0 ? "extra" : ReceivedQty == 0 ? "todo" : ReceivedQty < ExpectedQty ? "partial" : ReceivedQty == ExpectedQty ? "done" : "over";

    // EAN, lot and expiry in one line: "EAN 599... · sarzs A1 · lejárat 2027. 03. 31."
    public string Codes => string.Join(" · ", new[]
    {
        string.IsNullOrEmpty(Ean) ? "nincs EAN" : $"EAN {Ean}",
        Lot.Length > 0 ? $"sarzs {Lot}" : null,
        Expiry.Length > 0 ? $"lejárat {Fmt.Date(Expiry)}" : null,
    }.Where((x) => x is not null));

    // Does a scanned code name this line's product (SKU, or EAN also without leading zeros)?
    public bool Matches(string code)
    {
        var c = code.Trim();
        if (string.Equals(Sku, c, StringComparison.OrdinalIgnoreCase)) return true;
        if (string.IsNullOrEmpty(Ean)) return false;
        if (Ean == c) return true;
        return c.All(char.IsAsciiDigit) && Ean.TrimStart('0') == c.TrimStart('0');
    }
}

// kind: unexpected, short, over, damaged
public sealed record LineIssue(string Kind, int Qty, string Text);

public sealed record Putaway(int Qty, string At, string LocationCode, string LocationKind, string? UserName);

// The putaway suggestion of the server: an existing location with room for the product (kind
// "existing") or an empty one of a fitting size ("empty"), and why.
public sealed record Suggestion(int Id, string Code, string? SizeCode, string Kind, string? Reason, int? Room);

public sealed record LocationRef(int Id, string Code, string? Kind = null);

public sealed record HistoryEntry(string At, string? Actor, string? Action, string Summary);

// POST /api/inbound/:id/scan
//   counted: { line, status } ; match (peek): { line_id } ; unexpected: { product } ; location: { location }
public sealed record InboundScanResult(string Result, InboundLine? Line, string? Status, int? LineId, ScannedProduct? Product, LocationRef? Location);

public sealed record ScannedProduct(int Id, string Sku, string Name, bool Active);

// POST receive / lines: { line, status } ; putaway: { line, location }
public sealed record InboundLineResult(InboundLine Line, string? Status, LocationRef? Location);

public sealed record InboundCompleteResult(bool Ok, bool HasDiscrepancy);

public sealed record CreatedRef(int Id, string Number, bool Duplicate);

// GET /api/lookup/products
public sealed record ProductLookup(int Id, int PartnerId, string Sku, string Name, string? Ean, string? Unit, string PartnerCode)
{
    public string Display => $"{Sku} {Name}";
}
