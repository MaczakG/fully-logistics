using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Partnerek (app/worker/routes/partners.js): clients, carriers and suppliers with contacts,
// contracts and documents; for clients tariffs, custom items, webshop connections and API keys.

// GET /api/partners
public sealed record PartnerRow(
    int Id, string Type, string Code, string Name, string Status, string? TaxNumber, string? Zip, string? City, string? BillingEmail,
    string? CarrierCode, string? Website, string CreatedAt, string? ContactName, string? ContactEmail, string? ContactPhone);

public sealed record PartnersPage(List<PartnerRow> Items, int Total, Dictionary<string, int> Counts);

// GET /api/partners/:id: the data, the tab counts and what keeps it from being deleted.
public sealed record PartnerDetail(
    int Id, string Type, string Code, string Name, string Status, string? TaxNumber, string? EuVatNumber, string? CompanyRegNumber,
    string? Country, string? Zip, string? City, string? Address, string? BillingName, string? BillingCountry, string? BillingZip,
    string? BillingCity, string? BillingAddress, string? BillingEmail, int PaymentDays, string? Website, string? CarrierCode,
    string? Notes, string CreatedAt, string? UpdatedAt, PartnerCounts Counts, List<DeleteBlocker> DeleteBlockers, bool CanDelete);

public sealed record PartnerCounts(int Contacts, int Contracts, int Documents, int Webshops, int ApiKeys, int CustomItems);

public sealed record DeleteBlocker(string Key, string Label, int Count);

public sealed record PartnerCreated(int Id, string Code);

public sealed record PartnerSaved(bool Ok, List<string>? Changed);

// The id of a new contact, contract, document, custom item.
public sealed record NewId(int Id);

public sealed record PartnerContact(int Id, string Name, string? Position, string? Email, string? Phone, bool IsPrimary, string? Notes);

public sealed record PartnerContract(
    int Id, string? Number, string Title, string? StartDate, string? EndDate, int NoticeDays, string Status, string? Notes, int Documents);

public sealed record PartnerDocument(
    int Id, string Kind, string Filename, string? ContentType, long Size, string UploadedAt, int? ContractId, string? ContractNumber,
    string? ContractTitle, string? UploadedByName);

// GET /api/partners/:id/tariffs: the flat tariffs and the storage prices next to the defaults.
public sealed record PartnerTariffs(List<PartnerTariff> Tariffs, List<StoragePrice> Storage, List<CustomItem> CustomItems);

public sealed record PartnerTariff(string Key, string Label, string Unit, string Group, decimal Value, decimal Default, bool Differs);

public sealed record StoragePrice(
    int SizeId, string Code, string Name, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, decimal? MaxKg, decimal Price,
    decimal Default, bool Differs);

public sealed record CustomItem(int Id, string Name, string Unit, decimal Price, string Kind, bool Active);

// GET /api/partners/:id/integrations
public sealed record PartnerIntegrations(List<WebshopPlatform> Platforms, List<WebshopConnection> Connections, List<ApiKeyRow> ApiKeys, string? ApiDocsUrl);

// A platform's form: credentials (stored encrypted, shown masked) and settings. Its keys are camelCase.
public sealed record WebshopPlatform(
    string Code, string Name,
    [property: JsonPropertyName("credentialFields")] List<PlatformField> CredentialFields,
    [property: JsonPropertyName("settingFields")] List<PlatformField> SettingFields);

public sealed record PlatformField(string Key, string? Label, string? Type, bool Required, string? Help, JsonElement? Default, List<FieldOption>? Options);

public sealed record FieldOption(string Value, string Label);

public sealed record WebshopConnection(
    int Id, int PartnerId, string Platform, string PlatformName, bool Available, string ShopUrl, bool Active,
    Dictionary<string, JsonElement>? Settings, Dictionary<string, JsonElement>? Credentials, string? CredentialsError, string? LastSyncAt,
    string? LastError, string CreatedAt);

public sealed record WebshopTested(WebshopTestResult Result, WebshopConnection Connection);

public sealed record WebshopTestResult(bool Ok, string Message);

public sealed record WebshopSynced(WebshopSyncResult Result, WebshopConnection Connection);

public sealed record WebshopSyncResult(bool Ok, int Imported, int Skipped, List<string> Errors);

public sealed record ApiKeyRow(int Id, string Name, string Prefix, string CreatedAt, string? LastUsedAt, string? RevokedAt, string? CreatedByName);

// The key itself is shown only once, right after it is made.
public sealed record ApiKeyCreated(int Id, string Key, string Prefix, string Name);

// GET /api/partners/:id/summary: per type, so every part is optional.
public sealed record PartnerSummary(
    string Type, string? Period, string? LastPeriod, int? Year, SummaryKpis Kpis, List<OccupiedSize>? OccupiedBySize,
    List<SummaryInbound>? OpenInbounds, List<OrdersByStatus>? OrdersByStatus, List<ShippedOrder>? LastShipped, StorageMonth? StorageMonth,
    List<ClientOrders>? ByClient, List<SummaryPickup>? LastPickups, List<SummaryInbound>? LastInbounds);

public sealed record SummaryKpis(
    int ActiveSkus, int OnHand, int OccupiedLocations, int OpenInbounds, int OrdersThisMonth, int OrdersLastMonth, int ShippedThisMonth,
    int ShippedLastMonth, int PickupsThisMonth, int InboundsThisYear, int ReceivedThisYear);

public sealed record OccupiedSize(int SizeId, string Code, string Name, int Locations);

public sealed record SummaryInbound(
    int Id, string Number, string Status, string? ExpectedDate, string? CompletedAt, string CreatedAt, string? ExternalRef, int Lines,
    int ExpectedQty, int ReceivedQty, string? ClientName, string? ClientCode);

public sealed record OrdersByStatus(string Status, int ThisMonth, int LastMonth);

public sealed record ShippedOrder(
    int Id, string Number, string? ExternalNumber, string CustomerName, string? City, string Status, string? ShippedAt, string? TrackingNumber,
    string? CarrierName, int Items);

public sealed record StorageMonth(string Period, int DaysInMonth, int DaysSnapshotted, List<StorageBySize> BySize, decimal Total);

public sealed record StorageBySize(int SizeId, string Code, string Name, int LocationDays, decimal AvgLocations, decimal Price, decimal Amount);

public sealed record ClientOrders(int Id, string Code, string Name, int Orders);

public sealed record SummaryPickup(
    int Id, string Number, string Date, string? WindowFrom, string? WindowTo, string Status, string? ManifestNumber, string? ClosedAt, int Orders);
