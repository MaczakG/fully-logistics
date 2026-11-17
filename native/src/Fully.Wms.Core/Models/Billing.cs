using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Elszámolás (app/worker/routes/billing.js): the monthly statements of the clients with their
// lines, drill-down lists and invoicing, and the hourly work and per unit items recorded for them.

// GET /api/billing/overview?period=
public sealed record BillingOverview(
    string Period, string Label, string From, string To, int Days, List<OverviewRow> Items, BillingKpis Kpis, SnapshotCoverage Snapshots,
    InvoicingStatus Invoicing, List<BillingGroup> Groups);

public sealed record OverviewRow(
    int PartnerId, string Code, string Name, string PartnerStatus, int? StatementId, string? Number, string Status, decimal? Net, decimal? Vat,
    decimal? Gross, string? InvoiceNumber, string? InvoiceError, int? InvoiceDocumentId, string? GeneratedAt, string? ApprovedAt, string? InvoicedAt);

public sealed record BillingKpis(
    decimal TotalNet, decimal InvoicedNet, int InvoicedCount, decimal DraftNet, int DraftCount, decimal ApprovedNet, int ApprovedCount, int MissingCount);

public sealed record SnapshotCoverage(int Recorded, int Expected, List<string> Missing, SnapshotRun? Last);

public sealed record SnapshotRun(string Date, string? TakenAt, int Rows, string? Source);

public sealed record InvoicingStatus(string Provider, string Name, bool Configured, string? Error);

public sealed record BillingGroup(string Key, string Label);

// POST /api/billing/statements/generate
public sealed record GenerateResult(string Period, int Created, int Updated, List<GenerateSkipped> Skipped, List<GeneratedStatement> Statements);

public sealed record GenerateSkipped(int PartnerId, string Name, int? StatementId, string Reason);

public sealed record GeneratedStatement(int Id, int PartnerId, string Number, string Status, decimal Net, decimal Gross);

// GET /api/billing/statements/:id
public sealed record Statement(
    int Id, string Number, int PartnerId, string Period, string Label, string Status, decimal Net, decimal VatPct, decimal Vat, decimal Gross,
    string? GeneratedAt, string? GeneratedByName, string? ApprovedAt, string? ApprovedByName, string? InvoiceProvider, string? InvoiceNumber,
    int? InvoiceDocumentId, string? InvoicedAt, string? InvoiceError, string? VoidedAt, string? VoidedByName, string? VoidReason,
    string PartnerCode, string PartnerName, StatementMeta? Meta, bool InvoiceBusy, bool InvoiceUncertain, bool Stale, StatementTotals? Fresh,
    List<StatementLine> Lines, StatementPartner? Partner, InvoicingStatus? Invoicing, List<BillingGroup> Groups, List<StatementEvent>? History);

public sealed record StatementMeta(int? DaysInMonth, int? SnapshotDays, List<string>? Warnings);

public sealed record StatementTotals(decimal Net, decimal Vat, decimal Gross);

// A line: computed from the month's data (key "handling.order_base" ...) or added by hand (manual).
public sealed record StatementLine(
    string Id, string Key, string Group, string Name, decimal Qty, string? Unit, decimal Price, string? PriceUnit, decimal Amount,
    JsonElement? Detail, string? Warn, bool Manual, string? CreatedBy, decimal Vat, decimal Gross)
{
    public string? Drill => Detail is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("drill", out var v) && v.ValueKind == JsonValueKind.String
        ? v.GetString() : null;

    public decimal? DetailNumber(string name) =>
        Detail is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;

    public bool DetailFlag(string name) => Detail is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    public decimal Bucket(string key) =>
        Detail is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty("buckets", out var b) && b.ValueKind == JsonValueKind.Object
            && b.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : 0;
}

public sealed record StatementPartner(
    int Id, string Code, string Name, string Status, string? TaxNumber, string? EuVatNumber, string? BillingName, string? BillingZip,
    string? BillingCity, string? BillingAddress, string? BillingCountry, string? BillingEmail, string? Zip, string? City, string? Address,
    int PaymentDays);

public sealed record StatementEvent(string At, string? Actor, string Summary);

public sealed record LineAdded(string Id, decimal Net, decimal Vat, decimal Gross);

// POST /api/billing/statements/:id/invoice
public sealed record InvoiceIssued(
    [property: JsonPropertyName("invoiceNumber")] string InvoiceNumber, [property: JsonPropertyName("documentId")] int? DocumentId, List<string>? Warnings);

// GET /api/billing/statements/:id/details?kind=: the drill-down lists.
public sealed record StatementDetails<T>(string Kind, int Total, int Limit, int Offset, List<T> Items, int? DaysInMonth);

public sealed record DetailOrder(
    int Id, string Number, string? ExternalNumber, string? ShippedDate, string Status, decimal CodAmount, string? Currency, string? CustomerName,
    decimal Pieces, decimal Fee);

public sealed record DetailStorage(
    int LocationId, string Code, string SizeCode, string SizeName, int Days, string? FirstDate, string? LastDate, decimal? Price, decimal Amount);

public sealed record DetailInbound(int Id, string Date, decimal Qty, string? Lot, string Sku, string Name, string? LocationCode, string? InboundNumber);

public sealed record DetailReturn(int Id, string Number, string? ReceivedDate, string? Reason, string? OrderNumber, decimal Pieces);

public sealed record DetailEntry(
    int Id, string Date, string Kind, decimal Qty, string? Note, int? CustomItemId, string? ItemName, string? CreatedByName, decimal? Price,
    string? Unit);

// GET /api/billing/entries
public sealed record BillingEntry(
    int Id, int PartnerId, string Date, string Kind, int? CustomItemId, decimal Qty, string? Note, string? CreatedAt, string PartnerName,
    string PartnerCode, string? ItemName, string? CreatedByName, string? StatementStatus, string? StatementNumber, string Unit, decimal? Price,
    decimal? Amount, bool Locked);

public sealed record BillingEntries(string Period, List<BillingEntry> Items, int Total, int Limit, int Offset);

// GET /api/billing/custom-items
public sealed record BillingCustomItem(int Id, string Name, string Unit, decimal Price, string Kind, bool Active);

public sealed record SnapshotTaken(string Date, int Rows);
