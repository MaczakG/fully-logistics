using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// Ajánlatkészítő (app/worker/routes/quotes.js): saved quotes with the calculator's state, and what
// a new one starts from (the company, the default tariffs and terms, the sizes, the costing).

// GET /api/quotes
public sealed record QuoteRow(
    int Id, string Number, int? PartnerId, string? ClientName, string Status, decimal MonthlyNet, string CreatedAt, string UpdatedAt,
    string? PartnerName, string? PartnerCode, string? CreatedByName);

// GET /api/quotes/:id
public sealed record QuoteDetail(
    int Id, string Number, int? PartnerId, string? ClientName, string Status, decimal MonthlyNet, string CreatedAt, string UpdatedAt,
    string? PartnerName, string? PartnerCode, string? CreatedByName, QuoteData Data);

// GET /api/quotes/defaults. default_tariffs holds the flat tariffs by key and "storage" (by size code).
public sealed record QuoteDefaults(
    CompanySettings? Company, Dictionary<string, JsonElement>? DefaultTariffs, List<string> QuoteTerms, List<QuoteSize> Sizes,
    List<TariffInfo> Tariffs, CostingSettings Costing)
{
    public decimal Tariff(string key) =>
        DefaultTariffs is not null && DefaultTariffs.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : 0;

    public decimal Storage(string code) =>
        DefaultTariffs is not null && DefaultTariffs.TryGetValue("storage", out var s) && s.ValueKind == JsonValueKind.Object
            && s.TryGetProperty(code, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : 0;
}

public sealed record QuoteSize(int Id, string Code, string Name, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, decimal? MaxKg);

// GET /api/quotes/partner/:id: a client's contact, tariffs, storage prices and custom items.
public sealed record QuotePartner(
    QuotePartnerInfo Partner, QuotePartnerContact Contact, Dictionary<string, decimal> Tariffs, List<QuotePartnerStorage> Storage,
    List<QuotePartnerItem> CustomItems);

public sealed record QuotePartnerInfo(int Id, string Code, string Name, string Status);

public sealed record QuotePartnerContact(
    string Name, string? Code, string? TaxNumber, string? Address, string? Website, string? BillingEmail, string? ContactName,
    string? ContactPosition, string? ContactEmail, string? ContactPhone);

public sealed record QuotePartnerStorage(int SizeId, string Code, string Name, decimal Price);

public sealed record QuotePartnerItem(int Id, string Name, string Unit, decimal Price, string Kind);

// The calculator's state as the server keeps it (normalizeQuoteData): mutable, the form writes into
// it and QuoteCalc reads it. Some keys are camelCase on the wire.
public sealed class QuoteData
{
    public int Version { get; set; } = 1;
    public QuoteClient Client { get; set; } = new();
    [JsonPropertyName("offerDate")] public string? OfferDate { get; set; }
    [JsonPropertyName("validDays")] public decimal ValidDays { get; set; } = 30;
    public QuoteVolume Volume { get; set; } = new();
    public List<QuoteStorage> Storage { get; set; } = [];
    public Dictionary<string, decimal> Tariffs { get; set; } = [];
    public QuoteDiscounts Discounts { get; set; } = new();
    [JsonPropertyName("customItems")] public List<QuoteCustomItem> CustomItems { get; set; } = [];
    public List<string> Terms { get; set; } = [];
    public string Signer { get; set; } = "";
    public QuoteInternal Internal { get; set; } = new();
    public CompanySettings? Company { get; set; }

    public decimal Tariff(string key) => Tariffs.GetValueOrDefault(key);
}

public sealed class QuoteClient
{
    public string Name { get; set; } = "";
    public string Contact { get; set; } = "";
    public string Email { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Shop { get; set; } = "";
    public string Address { get; set; } = "";
    public string TaxNumber { get; set; } = "";
}

public sealed class QuoteVolume
{
    public decimal Orders { get; set; }
    public decimal Avg { get; set; } = 1;
    public decimal Inbound { get; set; }
    [JsonPropertyName("retPct")] public decimal RetPct { get; set; }
    [JsonPropertyName("moveIn")] public decimal MoveIn { get; set; }
    public decimal Hours { get; set; }
    [JsonPropertyName("codOrders")] public decimal CodOrders { get; set; }
    [JsonPropertyName("codAvg")] public decimal CodAvg { get; set; }
}

public sealed class QuoteStorage
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Dims { get; set; } = "";
    public decimal Qty { get; set; }
    public decimal Price { get; set; }
}

public sealed class QuoteDiscounts
{
    [JsonPropertyName("freeMoveIn")] public decimal FreeMoveIn { get; set; }
    [JsonPropertyName("freeStorageMonths")] public decimal FreeStorageMonths { get; set; }
    [JsonPropertyName("priceLockMonths")] public decimal PriceLockMonths { get; set; }
}

public sealed class QuoteCustomItem
{
    public string Name { get; set; } = "";
    public string Unit { get; set; } = "db";
    // per_unit or monthly
    public string Kind { get; set; } = "per_unit";
    public decimal Price { get; set; }
    public decimal Qty { get; set; }
}

// The quote's own copy of the costing assumptions (Beállítások > Raktár > Költségkalkuláció).
public sealed class QuoteInternal
{
    public decimal Rent { get; set; }
    public decimal AreaM2 { get; set; }
    public Dictionary<string, RackSetting> Racks { get; set; } = [];
    public decimal WorkerCost { get; set; }
    public decimal WorkerHours { get; set; }
    public decimal MinOrder { get; set; }
    public decimal MinItem { get; set; }
    public decimal MinInbound { get; set; }
    public decimal MinReturn { get; set; }
    [JsonPropertyName("costPack")] public decimal CostPack { get; set; }

    public static QuoteInternal From(CostingSettings c) => new()
    {
        Rent = c.Rent, AreaM2 = c.AreaM2, Racks = new Dictionary<string, RackSetting>(c.Racks), WorkerCost = c.WorkerCost,
        WorkerHours = c.WorkerHours, MinOrder = c.MinOrder, MinItem = c.MinItem, MinInbound = c.MinInbound, MinReturn = c.MinReturn,
        CostPack = c.PackCost,
    };
}
