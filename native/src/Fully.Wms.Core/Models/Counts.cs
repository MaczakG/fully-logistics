namespace Fully.Wms.Core.Models;

// Leltár (app/worker/routes/counts.js). A count: open -> counting (first entry) -> counted (every
// line counted, or finished) -> posted, or cancelled before anything is booked. Its lines are a
// snapshot of the stock when it was started: one per location, product, lot and expiry, plus one
// line without product per empty location. Blind counts leave the expected quantities out
// (ExpectedQty null) for users who may not approve.

// GET /api/counts?status=active|all|open|...&type=&q=. DiffLines is null while a blind count hides it.
public sealed record CountRow(
    int Id, string Number, string Type, string Scope, bool Blind, string Status, string? Note, string CreatedAt,
    string? StartedAt, string? CountedAt, string? PostedAt, string? CreatedByName, int Lines, int CountedLines,
    int Locations, int DoneLocations, int? DiffLines);

// GET /api/counts/options: the choices of the new count form.
public sealed record CountOptions(Dictionary<string, string> Types, List<CountZone> Zones, int StorageLocations, int LocationsInOpenCounts);

public sealed record CountZone(string Zone, int Locations, int Storage);

public sealed record CountCreated(int Id, string Number, int Locations, int Lines);

public sealed record CountProgress(int Lines, int CountedLines, int Locations, int DoneLocations);

// GET /api/counts/:id (and the count of the review, without locations).
public sealed record CountDetail(
    int Id, string Number, string Type, string Scope, bool Blind, string Status, string? Note, string CreatedAt,
    string? StartedAt, string? CountedAt, string? PostedAt, string? CancelledAt, string? CreatedByName, string? PostedByName,
    string TypeLabel, bool CanSeeExpected, CountProgress Progress, List<CountLocation>? Locations);

public sealed record CountLocation(int LocationId, string Code, string? Zone, string? Kind, int Lines, int Counted, int ProductLines, bool Done, List<CountLine>? Items);

// A line. ProductId null: the line of an empty location. CountedQty null: not counted yet.
// ExpectedQty and PostedDiff are null when the user may not see them (blind count).
public sealed record CountLine(
    int Id, int LocationId, string LocationCode, string? Zone, int? ProductId, string Sku, string Name, string Ean, string Unit,
    int? PartnerId, string PartnerCode, string Lot, string Expiry, int? CountedQty, string CountedByName, string? CountedAt,
    bool Added, bool Posted, int? ExpectedQty, int? PostedDiff)
{
    public bool HasProduct => ProductId is not null;
    public bool IsCounted => CountedQty is not null;

    // The difference counted - expected (booked: the booked one), null when unknown.
    public int? Diff => CountedQty is null || ExpectedQty is null ? null : Posted ? PostedDiff ?? 0 : CountedQty - ExpectedQty;

    public string LotText => string.Join(" · ", new[] { Lot, Expiry.Length > 0 ? Fmt.Date(Expiry) : "" }.Where((x) => x.Length > 0));
}

// GET /api/counts/:id/locations/:locationId, and the answer of every entry on a location.
public sealed record CountLocationState(CountRef Count, CountLocationRef Location, List<CountLine> Lines, CountProgress Progress);

public sealed record CountRef(int Id, string Number, string Status, bool Blind, bool CanSeeExpected);

public sealed record CountLocationRef(int Id, string Code, string? Zone, string? Kind, bool Done);

// GET /api/counts/:id/resolve?code=&location_id=: products with the scanned EAN or SKU. SamePartner
// false: another client's product than the goods on the location.
public sealed record CountResolved(string Code, List<ResolvedProduct> Products);

public sealed record ResolvedProduct(
    int Id, int PartnerId, string Sku, string Name, string? Ean, string? Unit, bool TrackLot, bool TrackExpiry,
    string PartnerCode, string PartnerName, bool SamePartner);

public sealed record CountFinished(string Status, CountProgress Progress);

// GET /api/counts/:id/review (counts approve).
public sealed record CountReview(CountDetail Count, ReviewSummary Summary, List<ReviewLine> Lines);

public sealed record ReviewSummary(int Lines, int Counted, int Uncounted, int Matching, int Surplus, int Shortage, int SurplusQty, int ShortageQty, int Changed);

// changed: the stock of the product on the location moved since the count started.
public sealed record ReviewLine(
    int Id, int LocationId, int? ProductId, string Lot, string Expiry, int ExpectedQty, int? CountedQty, string? CountedAt,
    bool Added, string? PostedAt, int? PostedDiff, string? Sku, string? Name, string? Unit, string? PartnerCode,
    string? CountedByName, string LocationCode, string? Zone, int CurrentQty, bool Changed, bool Posted, int? Diff)
{
    public bool HasProduct => ProductId is not null;
    public string LotText => string.Join(" · ", new[] { Lot, Expiry.Length > 0 ? Fmt.Date(Expiry) : "" }.Where((x) => x.Length > 0));
}

// POST /api/counts/:id/post: { done: false, remaining } while there is more to book, then the summary.
public sealed record CountPosted(bool Done, int Posted, int Remaining, ReviewSummary? Summary);
