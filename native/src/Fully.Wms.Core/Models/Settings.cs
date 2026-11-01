using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Beállítások (app/worker/routes/settings.js): company, warehouse and costing, location sizes and
// locations, default tariffs and quote terms, courier and invoicing accounts, the logs.

// GET|PUT /api/settings/company
public sealed record CompanySettings(
    string? Name, string? TaxNumber, string? EuVatNumber, string? CompanyRegNumber, string? Country, string? Zip, string? City,
    string? Address, string? Email, string? Phone, string? BankName, string? BankAccount, string? Website);

// GET|PUT /api/settings/warehouse: the daily cut-off, opening hours, workdays (1 Monday .. 7 Sunday).
public sealed record WarehouseSettings(string Cutoff, string? Open, string? Close, List<int> Workdays, string? DefaultCarrierCode);

// GET|PUT /api/settings/costing: the assumptions of the quotes' internal margin.
public sealed record CostingSettings(
    decimal Rent, decimal AreaM2, Dictionary<string, RackSetting> Racks, decimal WorkerCost, decimal WorkerHours, decimal MinOrder,
    decimal MinItem, decimal MinInbound, decimal MinReturn, decimal PackCost, List<CostingSize>? Sizes);

// A rack bay of one location size: its floor area with its share of the aisle, levels, places per level.
public sealed record RackSetting(decimal Area, decimal Levels, decimal PerLevel);

public sealed record CostingSize(int Id, string Code, string Name);

// GET /api/settings/tariffs: the default tariffs (values by key, storage by size code) and quote terms.
public sealed record DefaultTariffs(
    List<TariffInfo> Tariffs, List<TariffSize> Sizes, Dictionary<string, decimal> Values, Dictionary<string, decimal> Storage, List<string> QuoteTerms);

public sealed record TariffSize(int Id, string Code, string Name, bool Active);

// GET /api/settings/sizes
public sealed record LocationSize(
    int Id, string Code, string Name, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, decimal? MaxKg, int Sort, bool Active,
    int LocationCount, int ActiveLocationCount, int OccupiedCount, string? Warning);

// GET /api/settings/locations
public sealed record SettingsLocation(
    int Id, string Code, string? Zone, int SizeId, string SizeCode, string SizeName, string Kind, int? PartnerId, string? PartnerCode,
    string? PartnerName, int PickSequence, bool Active, string? Note, int? OccupantId, string? OccupantCode, string? OccupantName, int Qty,
    int Products, string? Warning);

public sealed record SettingsLocationsPage(List<SettingsLocation> Items, int Total, LocationSummary Summary, List<string> Zones);

public sealed record LocationSummary(int Total, int Active, int Occupied, int EmptyStorage);

public sealed record LocationIds(List<int> Ids, int Total);

// GET /api/settings/locations/:id: with the stock on it and whether it may be deleted.
public sealed record SettingsLocationDetail(
    int Id, string Code, string? Zone, int SizeId, string SizeCode, string SizeName, string Kind, int? PartnerId, string? PartnerName,
    int PickSequence, bool Active, string? Note, int? OccupantId, string? OccupantName, int Qty, int Products, List<LocationStockLine> Stock,
    bool Deletable);

public sealed record LocationStockLine(int ProductId, string Sku, string Name, string? Lot, string? Expiry, int Qty);

// POST /api/settings/locations/bulk (preview: the codes to make, the ones that exist)
public sealed record BulkPreview(int Total, int Create, List<string> Codes, List<string> Existing);

public sealed record BulkCreated(int Created, List<string> Skipped);

public sealed record BulkUpdated(int Updated, List<SkippedLocation> Skipped, int OccupiedResized);

public sealed record BulkDeleted(int Deleted, List<SkippedLocation> Skipped);

public sealed record SkippedLocation(string Code, string Reason);

// GET /api/settings/couriers: the courier accounts with the adapters' forms (credentials masked).
public sealed record CourierList(List<CourierAccount> Items, List<PartnerLookup> Carriers);

public sealed record CourierAccount(
    string Code, string Name,
    [property: JsonPropertyName("credentialFields")] List<PlatformField> CredentialFields,
    [property: JsonPropertyName("settingFields")] List<PlatformField> SettingFields,
    Dictionary<string, bool>? Features, bool Configured, bool Active, int? CarrierId, Dictionary<string, JsonElement>? Settings,
    Dictionary<string, JsonElement>? Credentials, string? LastError, string? UpdatedAt, string? Error);

public sealed record ConnectionTest(bool Ok, string Message);

// GET /api/settings/invoicing
public sealed record InvoicingSettings(string Provider, List<FieldOption> Choices, string? Error, List<InvoicingProvider> Providers);

public sealed record InvoicingProvider(
    string Code, string Name,
    [property: JsonPropertyName("credentialFields")] List<PlatformField> CredentialFields,
    [property: JsonPropertyName("settingFields")] List<PlatformField> SettingFields,
    Dictionary<string, JsonElement>? Settings, Dictionary<string, JsonElement>? Credentials);

// GET /api/settings/audit, /audit/filters, /integration-log
public sealed record AuditRow(
    int Id, string At, int? UserId, string? Actor, string Module, string Action, string? Entity, string? EntityId, string? Summary,
    JsonElement? Details, string? ModuleName);

public sealed record AuditFilters(List<ModuleName> Modules, List<string> Entities, List<AuditUser> Users, List<string> Systems);

public sealed record ModuleName(string Key, string Name);

public sealed record AuditUser(int Id, string Name, bool Active);

public sealed record IntegrationRow(
    int Id, string At, string System, string Direction, int? PartnerId, string? PartnerName, string? Action, bool Ok, int? Status,
    string? Message);
