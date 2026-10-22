using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Common;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// The tabs of Készlet: Készlet, Cikktörzs, Mozgások, Térkép, Helyek. A tab replaces the page.
public static class StockTabs
{
    public static Task Open(ShellViewModel shell, string tab) => shell.ReplaceAsync(tab switch
    {
        "catalog" => new ProductsViewModel(shell),
        "movements" => new MovementsViewModel(shell),
        "map" => new StockMapViewModel(shell),
        "locations" => new LocationsViewModel(shell),
        _ => new StockViewModel(shell),
    });

    internal static async Task<List<PartnerLookup>> ClientsAsync(ApiClient api) =>
        (await api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1")).Items;
}

// ------------------------------------------------------------------ Helyek

// GET /api/stock/locations: which client holds which location, free ones by size.
public sealed partial class LocationsViewModel(ShellViewModel shell) : ListPageViewModel<LocationRow>(shell)
{
    public override string Title => "Raktárhelyek";
    public override string? Module => "stock";
    private new const int PageSize = 100;

    public static readonly (string Key, string Label)[] States = [("", "Mind"), ("empty", "Üres"), ("occupied", "Foglalt")];
    public IReadOnlyList<string> StateLabels { get; } = States.Select((s) => s.Label).ToList();

    [ObservableProperty]
    public partial int StateIndex { get; set; }

    [ObservableProperty]
    public partial SizeInfo? Size { get; set; }

    [ObservableProperty]
    public partial PartnerLookup? Partner { get; set; }

    [ObservableProperty]
    public partial KindChoice? LocationKind { get; set; }

    [ObservableProperty]
    public partial List<PartnerLookup> Partners { get; set; } = [];

    [ObservableProperty]
    public partial LocationsSummary? Summary { get; set; }

    [ObservableProperty]
    public partial LocationRow? Selected { get; set; }

    public IReadOnlyList<SizeInfo> Sizes => Shell.Meta.Sizes;
    public IReadOnlyList<KindChoice> Kinds { get; } = [.. App.Meta.LocationKinds.Select((k) => new KindChoice(k.Key, k.Value)), new KindChoice("all", "Minden típus")];

    partial void OnSelectedChanged(LocationRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new StockLocationViewModel(Shell, value.Id));
    }

    protected override string ListPath() => Query.Build("api/stock/locations", ("q", Search.Trim()), ("state", States[StateIndex].Key),
        ("size_id", Size?.Id), ("partner_id", Partner?.Id), ("kind", LocationKind?.Key ?? "storage"));

    protected override async Task<(IReadOnlyList<LocationRow> Items, int Total)> FetchAsync(int offset)
    {
        if (Partners.Count == 0) Partners = await StockTabs.ClientsAsync(Api);
        var page = await Api.GetAsync<LocationsPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Summary = page.Summary;
        return (page.Items, page.Total);
    }

    // The "Szabad" count of a size: the empty locations of that size.
    [RelayCommand]
    Task ShowEmptyAsync(SizeOccupancy size)
    {
        StateIndex = 1;
        Size = Sizes.FirstOrDefault((s) => s.Id == size.SizeId);
        return ReloadAsync();
    }

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        Search = "";
        StateIndex = 0;
        Size = null;
        Partner = null;
        LocationKind = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task TabAsync(string tab) => StockTabs.Open(Shell, tab);
}

public sealed record KindChoice(string Key, string Label);

// ------------------------------------------------------------------ Mozgások

// GET /api/stock/movements: the ledger, filters, CSV export. Opened with a product or a location
// as a filter from their pages.
public sealed partial class MovementsViewModel : ListPageViewModel<Movement>
{
    public MovementsViewModel(ShellViewModel shell, int? productId = null, string? productText = null, int? locationId = null, string? locationText = null) : base(shell)
    {
        ProductId = productId;
        ProductText = productText;
        LocationId = locationId;
        LocationText = locationText;
    }

    public override string Title => "Készletmozgások";
    public override string? Module => "stock";
    private new const int PageSize = 100;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProduct))]
    public partial int? ProductId { get; set; }

    [ObservableProperty]
    public partial string? ProductText { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasLocation))]
    public partial int? LocationId { get; set; }

    [ObservableProperty]
    public partial string? LocationText { get; set; }

    public bool HasProduct => ProductId is not null;
    public bool HasLocation => LocationId is not null;

    [ObservableProperty]
    public partial List<PartnerLookup> Partners { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Partner { get; set; }

    [ObservableProperty]
    public partial KindChoice? Type { get; set; }

    [ObservableProperty]
    public partial DateTime? From { get; set; }

    [ObservableProperty]
    public partial DateTime? To { get; set; }

    [ObservableProperty]
    public partial string Ref { get; set; } = "";

    [ObservableProperty]
    public partial MovementSums? Sums { get; set; }

    public IReadOnlyList<KindChoice> Types { get; } = App.Meta.MovementTypes.Select((k) => new KindChoice(k.Key, k.Value)).ToList();

    public string SumsText => Sums is null ? "" : $"{Fmt.Int(Total)} mozgás. Be: +{Fmt.Int(Sums.In)}, ki: -{Fmt.Int(Sums.Out)} db.";

    partial void OnSumsChanged(MovementSums? value) => OnPropertyChanged(nameof(SumsText));

    (string, object?)[] Filters() =>
    [
        ("q", Search.Trim()), ("partner_id", Partner?.Id), ("product_id", ProductId), ("location_id", LocationId), ("type", Type?.Key),
        ("from", From?.ToString("yyyy-MM-dd")), ("to", To?.ToString("yyyy-MM-dd")), ("ref", Ref.Trim()),
    ];

    protected override string ListPath() => Query.Build("api/stock/movements", Filters());

    protected override async Task<(IReadOnlyList<Movement> Items, int Total)> FetchAsync(int offset)
    {
        if (Partners.Count == 0) Partners = await StockTabs.ClientsAsync(Api);
        var page = await Api.GetAsync<MovementsPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Sums = page.Sums;
        LocationText ??= page.Items.FirstOrDefault((m) => m.LocationId == LocationId)?.LocationCode;
        return (page.Items, page.Total);
    }

    [RelayCommand]
    Task ClearProductAsync()
    {
        ProductId = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ClearLocationAsync()
    {
        LocationId = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        Search = Ref = "";
        Partner = null;
        Type = null;
        From = To = null;
        ProductId = LocationId = null;
        return ReloadAsync();
    }

    [RelayCommand]
    Task ExportAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(Query.Build("api/stock/movements/export", Filters()))));

    [RelayCommand]
    Task OpenProductAsync(Movement m) => Shell.NavigateAsync(new StockProductViewModel(Shell, m.ProductId));

    [RelayCommand]
    Task TabAsync(string tab) => StockTabs.Open(Shell, tab);
}

// ------------------------------------------------------------------ Cikktörzs

// GET /api/products: the catalogue; new product, edit, CSV import and export.
public sealed partial class ProductsViewModel(ShellViewModel shell) : ListPageViewModel<ProductRow>(shell)
{
    public override string Title => "Cikktörzs";
    public override string? Module => "stock";

    public static readonly (string Key, string Label)[] States = [("1", "Aktív"), ("0", "Inaktív"), ("all", "Mind")];
    public IReadOnlyList<string> StateLabels { get; } = States.Select((s) => s.Label).ToList();

    [ObservableProperty]
    public partial int StateIndex { get; set; }

    [ObservableProperty]
    public partial List<PartnerLookup> Partners { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Partner { get; set; }

    [ObservableProperty]
    public partial ProductRow? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("stock", "create") == true;
    public bool CanImport => CanCreate && !Shell.IsPhone;
    public bool CanEdit => Shell.Me?.Can("stock", "edit") == true;

    partial void OnSelectedChanged(ProductRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new StockProductViewModel(Shell, value.Id));
    }

    (string, object?)[] Filters() => [("q", Search.Trim()), ("partner_id", Partner?.Id), ("active", States[StateIndex].Key)];

    protected override string ListPath() => Query.Build("api/products", Filters());

    protected override async Task<(IReadOnlyList<ProductRow> Items, int Total)> FetchAsync(int offset)
    {
        if (Partners.Count == 0) Partners = await StockTabs.ClientsAsync(Api);
        var page = await Api.GetAsync<ProductsPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        return (page.Items, page.Total);
    }

    [RelayCommand]
    Task ScanAsync(string code)
    {
        Search = code;
        return ReloadAsync();
    }

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new ProductFormViewModel(Shell, null));

    [RelayCommand]
    Task EditAsync(ProductRow p) => Shell.NavigateAsync(new ProductFormViewModel(Shell, p));

    [RelayCommand]
    Task ExportAsync() => RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(Query.Build("api/products/export", Filters()))));

    [RelayCommand]
    Task ImportAsync() => Shell.NavigateAsync(new CsvImportViewModel(Shell, new CsvImportOptions(
        "stock", "Cikkek importálása CSV-ből", "api/products/import",
        "Az ügyfélkód és a cikkszám azonosítja a cikket: a meglévőket frissítjük (az üres cella nem változtat semmit), az újakat felvesszük. Új cikkhez a megnevezés kötelező. Méretek külön oszlopban vagy egyben is jöhetnek (pl. 30x20x10). A követés oszlopokba igen vagy nem kerüljön.",
        "cikktorzs-sablon.csv",
        ["Ügyfélkód", "Cikkszám", "Megnevezés", "EAN", "Egység", "Súly (kg)", "Szélesség (cm)", "Mélység (cm)", "Magasság (cm)", "Minimum készlet", "Sarzskövetés", "Lejáratkövetés"],
        (r) => $"{Fmt.Int(r.Created)} új és {Fmt.Int(r.Updated)} módosított cikk.")));

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        Search = "";
        Partner = null;
        StateIndex = 0;
        return ReloadAsync();
    }

    [RelayCommand]
    Task TabAsync(string tab) => StockTabs.Open(Shell, tab);
}

// POST /api/products (new) or PATCH /api/products/:id. The client of a product never changes.
public sealed partial class ProductFormViewModel : PageViewModel
{
    readonly ProductRow? existing;

    public ProductFormViewModel(ShellViewModel shell, ProductRow? existing) : base(shell)
    {
        this.existing = existing;
        Sku = existing?.Sku ?? "";
        Name = existing?.Name ?? "";
        Ean = existing?.Ean ?? "";
        Unit = existing?.Unit ?? "db";
        MinStock = (existing?.MinStock ?? 0).ToString();
        Weight = Num(existing?.WeightKg);
        Width = Num(existing?.WidthCm);
        Depth = Num(existing?.DepthCm);
        Height = Num(existing?.HeightCm);
        TrackLot = existing?.TrackLot ?? false;
        TrackExpiry = existing?.TrackExpiry ?? false;
        Notes = existing?.Notes ?? "";
    }

    static string Num(decimal? v) => v is null ? "" : v.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);

    public bool IsNew => existing is null;
    public override string Title => IsNew ? "Új cikk" : $"{existing!.Sku} szerkesztése";
    public override string? Module => "stock";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 880;
    public string SubmitText => IsNew ? "Cikk felvétele" : "Mentés";
    public string? FixedPartner => existing is null ? null : $"{existing.PartnerName} ({existing.PartnerCode})";

    [ObservableProperty]
    public partial List<PartnerLookup> Partners { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Partner { get; set; }

    [ObservableProperty]
    public partial string Sku { get; set; }

    [ObservableProperty]
    public partial string Name { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(EanWarning))]
    public partial string Ean { get; set; }

    [ObservableProperty]
    public partial string Unit { get; set; }

    [ObservableProperty]
    public partial string MinStock { get; set; }

    [ObservableProperty]
    public partial string Weight { get; set; }

    [ObservableProperty]
    public partial string Width { get; set; }

    [ObservableProperty]
    public partial string Depth { get; set; }

    [ObservableProperty]
    public partial string Height { get; set; }

    [ObservableProperty]
    public partial bool TrackLot { get; set; }

    [ObservableProperty]
    public partial bool TrackExpiry { get; set; }

    [ObservableProperty]
    public partial string Notes { get; set; }

    [ObservableProperty]
    public partial Dictionary<string, string> Errors { get; set; } = [];

    [ObservableProperty]
    public partial string? Error { get; set; }

    // The same rule as the server (worker/routes/stock.js eanWarning): a hint, not an error.
    public string? EanWarning => Core.Ean.Warning(Ean);

    public override async Task LoadAsync()
    {
        if (IsNew && Partners.Count == 0) Partners = (await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client")).Items;
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        var nums = new Dictionary<string, decimal?>();
        var errors = new Dictionary<string, string>();
        foreach (var (key, text) in new[] { ("weight_kg", Weight), ("width_cm", Width), ("depth_cm", Depth), ("height_cm", Height) })
        {
            if (text.Trim().Length == 0) { nums[key] = null; continue; }
            var n = Fmt.ParseNumber(text);
            if (n is not { } v || v < 0) errors[key] = "Nulla vagy pozitív szám legyen.";
            else nums[key] = v;
        }
        var min = Fmt.ParseNumber(MinStock.Length == 0 ? "0" : MinStock);
        if (min is not { } m || m < 0 || m % 1 != 0) errors["min_stock"] = "Nulla vagy pozitív egész szám legyen.";
        if (IsNew && Partner is null) errors["partner_id"] = "Válassz ügyfelet.";
        if (Sku.Trim().Length == 0) errors["sku"] = "Kötelező mező.";
        if (Name.Trim().Length == 0) errors["name"] = "Kötelező mező.";
        Errors = errors;
        if (errors.Count > 0) { Error = "Ellenőrizd a megjelölt mezőket."; return; }
        var body = new Dictionary<string, object?>
        {
            ["sku"] = Sku.Trim(), ["name"] = Name.Trim(), ["ean"] = Ean.Trim(), ["unit"] = Unit.Trim().Length == 0 ? "db" : Unit.Trim(),
            ["min_stock"] = (int)min!.Value, ["weight_kg"] = nums["weight_kg"], ["width_cm"] = nums["width_cm"], ["depth_cm"] = nums["depth_cm"],
            ["height_cm"] = nums["height_cm"], ["track_lot"] = TrackLot, ["track_expiry"] = TrackExpiry, ["notes"] = Notes.Trim(),
        };
        try
        {
            ProductSaved res;
            if (IsNew)
            {
                body["partner_id"] = Partner!.Id;
                res = await Api.PostAsync<ProductSaved>("api/products", body);
            }
            else res = await Api.PatchAsync<ProductSaved>($"api/products/{existing!.Id}", body);
            Shell.Toast(IsNew ? "Cikk felvéve." : "Cikk mentve.", ToastKind.Success);
            foreach (var w in res.Warnings ?? []) Shell.Toast(w, ToastKind.Info);
            await Shell.BackAsync();
            if (IsNew) await Shell.NavigateAsync(new StockProductViewModel(Shell, res.Id));
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });
}

// ------------------------------------------------------------------ Térkép

// GET /api/stock/map: zones, racks and levels drawn from the location codes (A-01-03 = zone A,
// rack 01, level 3), every location coloured by its state; a client's locations highlighted.
public sealed partial class StockMapViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Raktártérkép";
    public override string? Module => "stock";

    List<MapCell> cells = [];

    public ObservableCollection<MapZone> Zones { get; } = [];

    [ObservableProperty]
    public partial List<MapPartner> Holders { get; set; } = [];

    [ObservableProperty]
    public partial MapPartner? Highlight { get; set; }

    [ObservableProperty]
    public partial int StateIndex { get; set; }

    [ObservableProperty]
    public partial SizeInfo? Size { get; set; }

    [ObservableProperty]
    public partial string Code { get; set; } = "";

    [ObservableProperty]
    public partial string Focus { get; set; } = "";

    [ObservableProperty]
    public partial string TotalsText { get; set; } = "";

    public IReadOnlyList<string> StateLabels { get; } = ["Mind", "Szabad", "Foglalt"];
    public IReadOnlyList<SizeInfo> Sizes => Shell.Meta.Sizes;

    partial void OnHighlightChanged(MapPartner? value) => Apply();
    partial void OnStateIndexChanged(int value) => Apply();
    partial void OnSizeChanged(SizeInfo? value) => Apply();
    partial void OnCodeChanged(string value) => Apply();

    public override async Task LoadAsync()
    {
        var data = await Api.GetAsync<StockMapData>("api/stock/map");
        var partners = data.Partners.ToDictionary((p) => p.Id);
        int Col(string name) => data.Columns.IndexOf(name);
        int? IntOrNull(JsonElement e) => e.ValueKind == JsonValueKind.Number ? e.GetInt32() : null;
        cells = data.Rows.Select((r) => new MapCell(this,
            r[Col("id")].GetInt32(), r[Col("code")].GetString() ?? "", r[Col("zone")].ValueKind == JsonValueKind.String ? r[Col("zone")].GetString() ?? "" : "",
            r[Col("size")].GetString() ?? "", r[Col("kind")].GetString() ?? "", r[Col("active")].GetInt32() == 1,
            IntOrNull(r[Col("dedicated")]), IntOrNull(r[Col("occupant")]), r[Col("products")].GetInt32(), r[Col("qty")].GetInt32(), partners)).ToList();
        Holders = data.Partners;
        Zones.Clear();
        foreach (var z in MapLayout.Zones(cells)) Zones.Add(z);
        var store = cells.Where((c) => c.Active && c.Kind is "storage" or "quarantine").ToList();
        var occ = store.Count((c) => c.OccupantId is not null);
        var ded = store.Count((c) => c.OccupantId is null && c.DedicatedId is not null);
        TotalsText = $"{Fmt.Int(store.Count)} tárolóhely, {Fmt.Int(occ)} foglalt ({(store.Count == 0 ? 0 : occ * 100 / store.Count)}%), {Fmt.Int(store.Count - occ)} szabad{(ded > 0 ? $", ebből {Fmt.Int(ded)} fix hely" : "")}.";
        Apply();
    }

    // Filters dim what does not match; the highlighted client's locations get a frame.
    void Apply()
    {
        var text = Code.Trim().ToUpperInvariant();
        var hits = 0;
        foreach (var c in cells)
        {
            var mine = Highlight is not null && (c.OccupantId == Highlight.Id || (c.OccupantId is null && c.DedicatedId == Highlight.Id));
            var match = (Highlight is null || mine) && (Size is null || c.Size == Size.Code)
                && (StateIndex == 0 || (StateIndex == 1 ? c.Active && c.OccupantId is null : c.OccupantId is not null))
                && (text.Length == 0 || c.Code.ToUpperInvariant().Contains(text, StringComparison.Ordinal));
            c.IsHighlighted = mine;
            c.IsDimmed = !match;
            if (match) hits++;
        }
        if (Highlight is not null)
        {
            var own = cells.Where((c) => c.OccupantId == Highlight.Id).ToList();
            var free = cells.Count((c) => c.Active && c.OccupantId is null && c.DedicatedId == Highlight.Id);
            var bySize = string.Join(", ", own.GroupBy((c) => c.Size).Select((g) => $"{g.Count()} {g.Key}"));
            Focus = $"{Highlight.Name}: {Fmt.Int(own.Count)} foglalt hely ({(bySize.Length > 0 ? bySize : "nincs")}){(free > 0 ? $", {Fmt.Int(free)} üres fix hely" : "")}.";
        }
        else Focus = Size is not null || StateIndex > 0 || text.Length > 0 ? $"{Fmt.Int(hits)} hely felel meg a szűrésnek." : "";
    }

    internal Task OpenAsync(MapCell cell) => Shell.NavigateAsync(new StockLocationViewModel(Shell, cell.Id));

    [RelayCommand]
    void ClearHighlight() => Highlight = null;

    [RelayCommand]
    Task TabAsync(string tab) => StockTabs.Open(Shell, tab);
}
