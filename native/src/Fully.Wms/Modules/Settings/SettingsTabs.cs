using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// Cégadatok: printed on quotes, statements and invoices.
public sealed partial class CompanyTab(SettingsViewModel page) : SettingsTab(page)
{
    [ObservableProperty] public partial string Name { get; set; } = "";
    [ObservableProperty] public partial string TaxNumber { get; set; } = "";
    [ObservableProperty] public partial string EuVatNumber { get; set; } = "";
    [ObservableProperty] public partial string CompanyRegNumber { get; set; } = "";
    [ObservableProperty] public partial string Country { get; set; } = "HU";
    [ObservableProperty] public partial string Zip { get; set; } = "";
    [ObservableProperty] public partial string City { get; set; } = "";
    [ObservableProperty] public partial string Address { get; set; } = "";
    [ObservableProperty] public partial string Email { get; set; } = "";
    [ObservableProperty] public partial string Phone { get; set; } = "";
    [ObservableProperty] public partial string Website { get; set; } = "";
    [ObservableProperty] public partial string BankName { get; set; } = "";
    [ObservableProperty] public partial string BankAccount { get; set; } = "";

    public override async Task LoadAsync() => Fill(await Api.GetAsync<CompanySettings>("api/settings/company"));

    void Fill(CompanySettings c)
    {
        Name = c.Name ?? "";
        TaxNumber = c.TaxNumber ?? "";
        EuVatNumber = c.EuVatNumber ?? "";
        CompanyRegNumber = c.CompanyRegNumber ?? "";
        Country = c.Country ?? "HU";
        Zip = c.Zip ?? "";
        City = c.City ?? "";
        Address = c.Address ?? "";
        Email = c.Email ?? "";
        Phone = c.Phone ?? "";
        Website = c.Website ?? "";
        BankName = c.BankName ?? "";
        BankAccount = c.BankAccount ?? "";
        Errors = [];
    }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        Fill(await Api.PutAsync<CompanySettings>("api/settings/company", new
        {
            name = Name.Trim(), tax_number = TaxNumber.Trim(), eu_vat_number = EuVatNumber.Trim(), company_reg_number = CompanyRegNumber.Trim(),
            country = Country.Trim().ToUpperInvariant(), zip = Zip.Trim(), city = City.Trim(), address = Address.Trim(), email = Email.Trim(),
            phone = Phone.Trim(), website = Website.Trim(), bank_name = BankName.Trim(), bank_account = BankAccount.Trim(),
        }));
        Shell.Toast("Cégadatok mentve.", ToastKind.Success);
    });
}

// Raktár: the daily cut-off, opening hours, workdays, default courier; the costing assumptions of
// the quote calculator (rent, area, the racks of each size, staff, minute norms, packaging).
public sealed partial class WarehouseTab(SettingsViewModel page) : SettingsTab(page)
{
    static readonly string[] DayNames = ["Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat", "Vasárnap"];

    public IReadOnlyList<OrderChoice> CarrierChoices { get; } =
        [new("", "Nincs megadva"), .. page.Shell.Meta.Carriers.Where((c) => c.Key != "other").Select((c) => new OrderChoice(c.Key, c.Value))];

    [ObservableProperty] public partial string Cutoff { get; set; } = "14:00";
    [ObservableProperty] public partial string Open { get; set; } = "";
    [ObservableProperty] public partial string Close { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? DefaultCarrierCode { get; set; }
    [ObservableProperty] public partial IReadOnlyList<Workday> Days { get; set; } = [];

    // Costing
    [ObservableProperty] public partial string Rent { get; set; } = "";
    [ObservableProperty] public partial string AreaM2 { get; set; } = "";
    [ObservableProperty] public partial string WorkerCost { get; set; } = "";
    [ObservableProperty] public partial string WorkerHours { get; set; } = "";
    [ObservableProperty] public partial string MinOrder { get; set; } = "";
    [ObservableProperty] public partial string MinItem { get; set; } = "";
    [ObservableProperty] public partial string MinInbound { get; set; } = "";
    [ObservableProperty] public partial string MinReturn { get; set; } = "";
    [ObservableProperty] public partial string PackCost { get; set; } = "";
    [ObservableProperty] public partial IReadOnlyList<RackRow> Racks { get; set; } = [];
    [ObservableProperty] public partial string RentPerM2Text { get; set; } = "";

    // The costing has its own errors and save.
    [ObservableProperty] public partial Dictionary<string, string> CostErrors { get; set; } = [];
    [ObservableProperty] public partial string? CostError { get; set; }

    public override async Task LoadAsync()
    {
        var w = Api.GetAsync<WarehouseSettings>("api/settings/warehouse");
        var c = Api.GetAsync<CostingSettings>("api/settings/costing");
        FillWarehouse(await w);
        FillCosting(await c);
    }

    void FillWarehouse(WarehouseSettings w)
    {
        Cutoff = w.Cutoff;
        Open = w.Open ?? "";
        Close = w.Close ?? "";
        DefaultCarrierCode = CarrierChoices.FirstOrDefault((c) => c.Key == (w.DefaultCarrierCode ?? "")) ?? CarrierChoices[0];
        Days = DayNames.Select((d, i) => new Workday(i + 1, d, w.Workdays.Contains(i + 1))).ToList();
        Errors = [];
    }

    void FillCosting(CostingSettings c)
    {
        Rent = Fmt.Num(c.Rent);
        AreaM2 = Fmt.Num(c.AreaM2);
        WorkerCost = Fmt.Num(c.WorkerCost);
        WorkerHours = Fmt.Num(c.WorkerHours);
        MinOrder = Fmt.Num(c.MinOrder);
        MinItem = Fmt.Num(c.MinItem);
        MinInbound = Fmt.Num(c.MinInbound);
        MinReturn = Fmt.Num(c.MinReturn);
        PackCost = Fmt.Num(c.PackCost);
        Racks = (c.Sizes ?? []).Select((s) => new RackRow(this, s, c.Racks.GetValueOrDefault(s.Code) ?? new RackSetting(0, 0, 0))).ToList();
        CostErrors = [];
        Preview();
    }

    partial void OnCostErrorsChanged(Dictionary<string, string> value)
    {
        foreach (var r in Racks) r.ShowErrors(value);
    }

    partial void OnRentChanged(string value) => Preview();
    partial void OnAreaM2Changed(string value) => Preview();

    static decimal Value(string text) => Math.Max(Fmt.ParseNumber(text) ?? 0, 0);

    // The rent of a m², and per size how many places would fit and the rent of one.
    internal void Preview()
    {
        var area = Value(AreaM2);
        var perM2 = area > 0 ? Value(Rent) / area : 0;
        RentPerM2Text = perM2 > 0 ? $"Bérleti díj: {Fmt.Num(perM2)} Ft / m² / hó." : "Add meg a bérleti díjat és az alapterületet.";
        foreach (var r in Racks)
        {
            var places = Value(r.Levels) * Value(r.PerLevel);
            var m2 = places > 0 ? Value(r.Area) / places : 0;
            r.M2Text = m2 > 0 ? $"{Fmt.Num(m2, 3)} m²" : "";
            r.FitsText = m2 > 0 && area > 0 ? $"{Fmt.Int((long)Math.Floor(area / m2))} db" : "";
            r.RentText = m2 > 0 && perM2 > 0 ? Fmt.Money(m2 * perM2) : "";
        }
    }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        FillWarehouse(await Api.PutAsync<WarehouseSettings>("api/settings/warehouse", new
        {
            cutoff = Cutoff.Trim(), open = Open.Trim(), close = Close.Trim(), default_carrier_code = DefaultCarrierCode?.Key ?? "",
            workdays = Days.Where((d) => d.On).Select((d) => d.Number).ToList(),
        }));
        Shell.Toast("Raktár beállítások mentve.", ToastKind.Success);
    });

    [RelayCommand]
    Task SaveCostingAsync() => Page.RunAsync(async () =>
    {
        CostError = null;
        object? Num(string text) => text.Trim().Length == 0 ? 0 : Fmt.ParseNumber(text) is { } n ? n : text;
        try
        {
            FillCosting(await Api.PutAsync<CostingSettings>("api/settings/costing", new Dictionary<string, object?>
            {
                ["rent"] = Num(Rent), ["area_m2"] = Num(AreaM2), ["worker_cost"] = Num(WorkerCost), ["worker_hours"] = Num(WorkerHours),
                ["min_order"] = Num(MinOrder), ["min_item"] = Num(MinItem), ["min_inbound"] = Num(MinInbound), ["min_return"] = Num(MinReturn),
                ["pack_cost"] = Num(PackCost),
                ["racks"] = Racks.ToDictionary((r) => r.Code, (r) => new Dictionary<string, object?> { ["area"] = Num(r.Area), ["levels"] = Num(r.Levels), ["per_level"] = Num(r.PerLevel) }),
            }));
            Shell.Toast("Költségkalkuláció mentve. Az új ajánlatok ezekkel az értékekkel indulnak.", ToastKind.Success);
        }
        catch (ApiException e) when (e.Status == 400)
        {
            CostErrors = new Dictionary<string, string>(e.Fields);
            CostError = e.Message;
        }
    });
}

public sealed partial class Workday(int number, string name, bool on) : ObservableObject
{
    public int Number { get; } = number;
    public string Name { get; } = name;

    [ObservableProperty]
    public partial bool On { get; set; } = on;
}

// The rack of one location size: area, levels, places per level, and what they give.
public sealed partial class RackRow(WarehouseTab tab, CostingSize size, RackSetting r) : ObservableObject
{
    public string Code { get; } = size.Code;
    public string Name { get; } = $"{size.Code} · {size.Name}";

    [ObservableProperty] public partial string Area { get; set; } = Fmt.Num(r.Area);
    [ObservableProperty] public partial string Levels { get; set; } = Fmt.Num(r.Levels);
    [ObservableProperty] public partial string PerLevel { get; set; } = Fmt.Num(r.PerLevel);
    [ObservableProperty] public partial string M2Text { get; set; } = "";
    [ObservableProperty] public partial string FitsText { get; set; } = "";
    [ObservableProperty] public partial string RentText { get; set; } = "";
    [ObservableProperty] public partial string? AreaError { get; set; }
    [ObservableProperty] public partial string? LevelsError { get; set; }
    [ObservableProperty] public partial string? PerLevelError { get; set; }

    public string? Error => string.Join(" ", new[] { AreaError, LevelsError, PerLevelError }.Distinct().Where((e) => e is { Length: > 0 })) is { Length: > 0 } e ? e : null;

    partial void OnAreaChanged(string value)
    {
        AreaError = null;
        tab.Preview();
    }

    partial void OnLevelsChanged(string value)
    {
        LevelsError = null;
        tab.Preview();
    }

    partial void OnPerLevelChanged(string value)
    {
        PerLevelError = null;
        tab.Preview();
    }

    partial void OnAreaErrorChanged(string? value) => OnPropertyChanged(nameof(Error));
    partial void OnLevelsErrorChanged(string? value) => OnPropertyChanged(nameof(Error));
    partial void OnPerLevelErrorChanged(string? value) => OnPropertyChanged(nameof(Error));

    // The server's errors of this rack ("racks.M.levels").
    internal void ShowErrors(Dictionary<string, string> errors)
    {
        AreaError = errors.GetValueOrDefault($"racks.{Code}.area");
        LevelsError = errors.GetValueOrDefault($"racks.{Code}.levels");
        PerLevelError = errors.GetValueOrDefault($"racks.{Code}.per_level");
    }
}

// Alap tarifák: the prices new clients and new quotes start with; the quote terms.
public sealed partial class TariffsTab(SettingsViewModel page) : SettingsTab(page)
{
    static readonly (string Key, string Label)[] Groups =
        [("handling", "Rendeléskezelés"), ("inbound", "Betárolás és visszáru"), ("extra", "Egyéb szolgáltatások"), ("discount", "Kedvezmények"), ("vat", "Adó")];

    [ObservableProperty] public partial IReadOnlyList<DefaultTariffGroup> TariffGroups { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<DefaultPrice> Storage { get; set; } = [];
    [ObservableProperty] public partial string Terms { get; set; } = "";

    public bool NoStorage => Storage.Count == 0;

    public override async Task LoadAsync() => Fill(await Api.GetAsync<DefaultTariffs>("api/settings/tariffs"));

    void Fill(DefaultTariffs t)
    {
        TariffGroups = Groups.Select((g) => new DefaultTariffGroup(g.Label, t.Tariffs.Where((x) => x.Group == g.Key)
            .Select((x) => new DefaultPrice($"values.{x.Key}", x.Key, x.Label, x.Unit, t.Values.GetValueOrDefault(x.Key))).ToList()))
            .Where((g) => g.Items.Count > 0).ToList();
        Storage = t.Sizes.Where((s) => s.Active).Select((s) => new DefaultPrice($"storage.{s.Code}", s.Code, $"{s.Code} · {s.Name}", "Ft / hely / hó", t.Storage.GetValueOrDefault(s.Code))).ToList();
        OnPropertyChanged(nameof(NoStorage));
        Terms = string.Join("\n", t.QuoteTerms);
        Errors = [];
    }

    protected override void ShowErrors(Dictionary<string, string> errors)
    {
        foreach (var p in TariffGroups.SelectMany((g) => g.Items).Concat(Storage)) p.Error = errors.GetValueOrDefault(p.Field);
    }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        object? Num(string text) => text.Trim().Length == 0 ? 0 : Fmt.ParseNumber(text) is { } n ? n : text;
        await Api.PutAsync<DefaultTariffs>("api/settings/tariffs", new
        {
            values = TariffGroups.SelectMany((g) => g.Items).ToDictionary((p) => p.Key, (p) => Num(p.Value)),
            storage = Storage.ToDictionary((p) => p.Key, (p) => Num(p.Value)),
            quote_terms = Terms.Split('\n').Select((x) => x.Trim()).Where((x) => x.Length > 0).ToList(),
        });
        await LoadAsync();
        Shell.Toast("Alap tarifák mentve.", ToastKind.Success);
    });
}

public sealed record DefaultTariffGroup(string Label, IReadOnlyList<DefaultPrice> Items);

public sealed partial class DefaultPrice(string field, string key, string label, string unit, decimal value) : ObservableObject
{
    public string Field { get; } = field;
    public string Key { get; } = key;
    public string Label { get; } = label;
    public string Unit { get; } = unit;

    [ObservableProperty] public partial string Value { get; set; } = Fmt.Num(value);
    [ObservableProperty] public partial string? Error { get; set; }

    partial void OnValueChanged(string value) => Error = null;
}
