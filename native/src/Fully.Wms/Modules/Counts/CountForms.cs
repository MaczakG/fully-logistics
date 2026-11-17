using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// The smaller steps of counting as dialogs (the web app's dialogs): a found product, the lot of a
// scanned product, a new count.

// POST /api/counts/:id/lines: a product found on the location that is not on its list. From a scan
// the candidates of the code are given; from "Talált termék" the product is searched.
public sealed partial class CountFoundViewModel(
    ShellViewModel shell, int countId, CountLocationRef location, IReadOnlyList<ResolvedProduct>? products, string? code,
    Action<CountLocationState, string> done) : PageViewModel(shell)
{
    public override string Title => products is null ? "Talált termék felvétele" : "Talált termék";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Dialog;

    public CountLocationRef Location { get; } = location;
    public IReadOnlyList<ResolvedProduct> Products { get; } = products ?? [];
    public bool FromScan => products is not null;
    public bool Searching => products is null;
    public bool Single => Products.Count == 1;
    public bool Several => Products.Count > 1;

    public string Intro => FromScan
        ? $"A(z) {Location.Code} helyen nincs nyilvántartva{(code is null ? "" : $": {code}")}."
        : $"Hely: {Location.Code}";

    public string? OtherPartner => Products.Any((p) => !p.SamePartner)
        ? $"{(Single ? "Ez a termék" : "Van köztük olyan termék, amely")} másik ügyfélé, mint a hely többi áruja. Egy helyen csak egy ügyfél áruja lehet: jelezd a raktárvezetőnek."
        : null;

    public string SingleText => Single ? $"{Products[0].Sku} {Products[0].Name} · {Products[0].PartnerName}" : "";

    [ObservableProperty]
    public partial ResolvedProduct? Chosen { get; set; } = products is { Count: > 0 } p ? p[0] : null;

    // The searched product (Talált termék).
    [ObservableProperty]
    public partial ProductLookup? Product { get; set; }

    [ObservableProperty]
    public partial string Qty { get; set; } = "1";

    [ObservableProperty]
    public partial string Lot { get; set; } = "";

    [ObservableProperty]
    public partial string Expiry { get; set; } = "";

    [ObservableProperty]
    public partial string? ProductError { get; set; }

    [ObservableProperty]
    public partial string? QtyError { get; set; }

    [ObservableProperty]
    public partial string? ExpiryError { get; set; }

    public Func<string?, CancellationToken, Task<IEnumerable<object>>> FindProducts => FindProductsAsync;

    async Task<IEnumerable<object>> FindProductsAsync(string? text, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var list = await Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("q", text.Trim())), ct);
        return list.Items;
    }

    partial void OnProductChanged(ProductLookup? value)
    {
        if (value is not null) ProductError = null;
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        ProductError = QtyError = ExpiryError = null;
        var productId = FromScan ? Chosen?.Id : Product?.Id;
        if (productId is null) ProductError = "Válassz terméket a listából.";
        if (!int.TryParse(Qty.Trim(), out var qty) || qty < 1) QtyError = "Legalább 1.";
        var expiry = Expiry.Trim();
        if (expiry.Length > 0 && !DateOnly.TryParseExact(expiry, "yyyy-MM-dd", out _)) ExpiryError = "ÉÉÉÉ-HH-NN formában add meg.";
        if (ProductError is not null || QtyError is not null || ExpiryError is not null) return;
        try
        {
            var res = await Api.PostAsync<CountLocationState>($"api/counts/{countId}/lines", new Dictionary<string, object?>
            {
                ["location_id"] = Location.Id, ["product_id"] = productId, ["counted_qty"] = qty, ["lot"] = Lot.Trim(), ["expiry"] = expiry.Length > 0 ? expiry : null,
            });
            var sku = FromScan ? Chosen!.Sku : Product!.Sku;
            done(res, $"Felvéve: {sku} {Fmt.Int(qty)} db.");
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            ProductError = e.Fields.GetValueOrDefault("product_id");
            QtyError = e.Fields.GetValueOrDefault("counted_qty") ?? e.Fields.GetValueOrDefault("add");
            ExpiryError = e.Fields.GetValueOrDefault("expiry");
            if (ProductError is null && QtyError is null && ExpiryError is null) throw;
        }
    });
}

// A scanned product with several lots on the location: which one was scanned.
public sealed partial class CountChooseLineViewModel(ShellViewModel shell, IReadOnlyList<CountLine> lines, Func<CountLine, Task> done) : PageViewModel(shell)
{
    public override string Title => "Melyik tétel?";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Dialog;

    public IReadOnlyList<CountLotChoice> Lines { get; } = lines.Select((l) => new CountLotChoice(l)).ToList();
    public string Intro => $"{lines[0].Sku} több lottal is van ezen a helyen. Válaszd ki, melyiket olvastad be.";

    [ObservableProperty]
    public partial CountLotChoice? Chosen { get; set; }

    public override Task LoadAsync()
    {
        Chosen ??= Lines[0];
        return Task.CompletedTask;
    }

    [RelayCommand]
    async Task SaveAsync()
    {
        if (Chosen is not { } c) return;
        await Shell.BackAsync();
        await done(c.Line);
    }
}

public sealed record CountLotChoice(CountLine Line)
{
    public string Label => Line.LotText.Length > 0 ? Line.LotText : "lot nélkül";
}

// POST /api/counts: a new count of the chosen kind.
public sealed partial class NewCountViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Új leltár";
    public override string? Module => "counts";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 680;

    public static readonly IReadOnlyList<CountChoice> TypeChoices =
    [
        new("cycle", "Ciklikus: a legrégebben számolt helyek"), new("zone", "Zóna: egy zóna minden helye"),
        new("product", "Termék: ahol a kiválasztott termékek vannak"), new("full", "Teljes: minden aktív tárolóhely"),
        new("locations", "Kijelölt helyek: kódok listája"),
    ];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsCycle), nameof(IsZone), nameof(IsProduct), nameof(IsFull), nameof(IsLocations))]
    public partial CountChoice Type { get; set; } = TypeChoices[0];

    public bool IsCycle => Type.Key == "cycle";
    public bool IsZone => Type.Key == "zone";
    public bool IsProduct => Type.Key == "product";
    public bool IsFull => Type.Key == "full";
    public bool IsLocations => Type.Key == "locations";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FullText), nameof(BusyText))]
    public partial CountOptions? Options { get; set; }

    [ObservableProperty]
    public partial List<CountChoice> Zones { get; set; } = [];

    // Cycle: any zone (Key null) or one; zone: the zone.
    [ObservableProperty]
    public partial CountChoice? CycleZone { get; set; }

    [ObservableProperty]
    public partial CountChoice? Zone { get; set; }

    [ObservableProperty]
    public partial string Limit { get; set; } = "20";

    [ObservableProperty]
    public partial ProductLookup? Product { get; set; }

    public ObservableCollection<ProductLookup> Chosen { get; } = [];

    [ObservableProperty]
    public partial string LocationCodes { get; set; } = "";

    [ObservableProperty]
    public partial bool Blind { get; set; } = true;

    [ObservableProperty]
    public partial string Note { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    public string FullText => $"Minden aktív tárolóhely bekerül ({Fmt.Int(Options?.StorageLocations ?? 0)} hely). Nagy raktárnál érdemes zónánként haladni.";
    public string? BusyText => Options is { LocationsInOpenCounts: > 0 } o
        ? $"{Fmt.Int(o.LocationsInOpenCounts)} hely már egy nyitott leltárban van. Egy hely egyszerre csak egy leltárban lehet." : null;

    public override async Task LoadAsync()
    {
        if (Options is not null) return;
        Options = await Api.GetAsync<CountOptions>("api/counts/options");
        var zones = Options.Zones.Select((z) => new CountChoice(z.Zone, $"{z.Zone} zóna ({Fmt.Int(z.Locations)} hely)")).ToList();
        Zones = zones;
        CycleZones = [new(null, "Bármely zóna"), .. zones];
        CycleZone = CycleZones[0];
        OnPropertyChanged(nameof(CycleZones));
    }

    public List<CountChoice> CycleZones { get; private set; } = [];

    public Func<string?, CancellationToken, Task<IEnumerable<object>>> FindProducts => FindProductsAsync;

    async Task<IEnumerable<object>> FindProductsAsync(string? text, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var list = await Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("q", text.Trim())), ct);
        return list.Items;
    }

    // A product picked in the search goes to the list.
    partial void OnProductChanged(ProductLookup? value)
    {
        if (value is null) return;
        if (Chosen.All((p) => p.Id != value.Id)) Chosen.Add(value);
        Avalonia.Threading.Dispatcher.UIThread.Post(() => Product = null);
    }

    [RelayCommand]
    void RemoveProduct(ProductLookup p) => Chosen.Remove(p);

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        var body = new Dictionary<string, object?> { ["type"] = Type.Key, ["blind"] = Blind, ["note"] = Note.Trim() };
        switch (Type.Key)
        {
            case "cycle":
                if (!int.TryParse(Limit.Trim(), out var limit) || limit is < 1 or > 500)
                {
                    Error = "A helyek száma 1 és 500 között legyen.";
                    return;
                }
                body["limit"] = limit;
                body["zone"] = CycleZone?.Key;
                break;
            case "zone":
                body["zone"] = Zone?.Key;
                break;
            case "product":
                body["product_ids"] = Chosen.Select((p) => p.Id).ToArray();
                break;
            case "locations":
                body["location_codes"] = LocationCodes.Split([' ', '\n', '\r', '\t', ',', ';'], StringSplitOptions.RemoveEmptyEntries);
                break;
        }
        try
        {
            var res = await Api.PostAsync<CountCreated>("api/counts", body);
            Shell.Toast($"{res.Number} elindítva: {Fmt.Int(res.Locations)} hely, {Fmt.Int(res.Lines)} tétel.", ToastKind.Success);
            await Shell.BackAsync();
            await Shell.NavigateAsync(new CountViewModel(Shell, res.Id));
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            Error = e.Message;
        }
    });
}
