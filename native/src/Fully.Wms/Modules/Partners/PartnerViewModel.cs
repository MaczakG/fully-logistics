using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Partners;

// One partner in its own window (GET /api/partners/:id) with its tabs: basic data, contacts,
// contracts and documents, and for clients the tariffs and the integrations; the summary.
public sealed partial class PartnerViewModel : PageViewModel
{
    public PartnerViewModel(ShellViewModel shell, int id, string? tab = null) : base(shell)
    {
        Id = id;
        Basic = new(this);
        Contacts = new(this);
        Contracts = new(this);
        Tariffs = new(this);
        Integrations = new(this);
        Summary = new(this);
        SelectedKey = tab ?? "basic";
    }

    public int Id { get; }
    public override string Title => Data?.Name ?? "Partner";
    public override string? Module => "partners";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"partner:{Id}";

    public PartnerBasicTab Basic { get; }
    public PartnerContactsTab Contacts { get; }
    public PartnerContractsTab Contracts { get; }
    public PartnerTariffsTab Tariffs { get; }
    public PartnerIntegrationsTab Integrations { get; }
    public PartnerSummaryTab Summary { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Lead), nameof(Status), nameof(IsClient))]
    public partial PartnerDetail? Data { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsBasic), nameof(IsContacts), nameof(IsContracts), nameof(IsTariffs), nameof(IsIntegrations), nameof(IsSummary))]
    public partial string SelectedKey { get; set; }

    [ObservableProperty]
    public partial IReadOnlyList<PartnerTabChip> Tabs { get; set; } = [];

    public bool IsBasic => SelectedKey == "basic";
    public bool IsContacts => SelectedKey == "contacts";
    public bool IsContracts => SelectedKey == "contracts";
    public bool IsTariffs => SelectedKey == "tariffs";
    public bool IsIntegrations => SelectedKey == "integrations";
    public bool IsSummary => SelectedKey == "summary";

    public string? Status => Data?.Status;
    public bool IsClient => Data?.Type == "client";
    public string Lead => Data is { } p
        ? MetaInfo.Label(Shell.Meta.PartnerTypes, p.Type)
          + (p.Type == "carrier" && !string.IsNullOrEmpty(p.CarrierCode) ? $", {MetaInfo.Label(Shell.Meta.Carriers, p.CarrierCode)}" : "")
          + $" · {p.Code}"
        : "";

    internal bool Can(string action) => Shell.Me?.Can("partners", action) == true;
    internal ApiClient ApiClient => Api;
    internal new Task<bool> RunAsync(Func<Task> action) => base.RunAsync(action);

    PartnerTab Current => SelectedKey switch
    {
        "contacts" => Contacts,
        "contracts" => Contracts,
        "tariffs" => Tariffs,
        "integrations" => Integrations,
        "summary" => Summary,
        _ => Basic,
    };

    public override async Task LoadAsync()
    {
        var p = await Api.GetAsync<PartnerDetail>($"api/partners/{Id}");
        Data = p;
        Basic.Fill(p);
        if (p.Type != "client" && SelectedKey is "tariffs" or "integrations") SelectedKey = "basic";
        Tabs =
        [
            Tab("basic", "Alapadatok", null),
            Tab("contacts", "Kapcsolattartók", p.Counts.Contacts),
            Tab("contracts", "Szerződés és dokumentumok", p.Counts.Contracts + p.Counts.Documents),
            .. p.Type == "client" ? new[] { Tab("tariffs", "Tarifák", null), Tab("integrations", "Integrációk", null) } : [],
            Tab("summary", "Összesítő", null),
        ];
        await Current.LoadAsync();
    }

    PartnerTabChip Tab(string key, string label, int? count) =>
        new(key, count is { } n ? $"{label} {Fmt.Int(n)}" : label) { IsSelected = key == SelectedKey };

    [RelayCommand]
    Task SelectTabAsync(PartnerTabChip tab)
    {
        SelectedKey = tab.Key;
        foreach (var t in Tabs) t.IsSelected = t == tab;
        return RunAsync(Current.LoadAsync);
    }
}

public sealed partial class PartnerTabChip(string key, string text) : ObservableObject
{
    public string Key { get; } = key;
    public string Text { get; } = text;

    [ObservableProperty]
    public partial bool IsSelected { get; set; }
}

// A tab of the partner window: loads its own data when it is shown.
public abstract class PartnerTab(PartnerViewModel page) : ObservableObject
{
    public PartnerViewModel Page { get; } = page;
    protected ShellViewModel Shell => Page.Shell;
    protected ApiClient Api => Page.ApiClient;
    protected int PartnerId => Page.Id;
    public virtual Task LoadAsync() => Task.CompletedTask;
}

// Alapadatok: company data, address, billing, note; saving, deleting (or deactivating).
public sealed partial class PartnerBasicTab(PartnerViewModel page) : PartnerTab(page)
{
    public static readonly IReadOnlyList<OrderChoice> StatusChoices = [new("active", "Aktív"), new("inactive", "Inaktív")];

    public IReadOnlyList<OrderChoice> CarrierChoices { get; } =
        [new("", "Nincs megadva"), .. page.Shell.Meta.Carriers.Select((c) => new OrderChoice(c.Key, c.Value))];

    [ObservableProperty] public partial string Name { get; set; } = "";
    [ObservableProperty] public partial string Code { get; set; } = "";
    [ObservableProperty] public partial OrderChoice Status { get; set; } = StatusChoices[0];
    [ObservableProperty] public partial string TaxNumber { get; set; } = "";
    [ObservableProperty] public partial string EuVatNumber { get; set; } = "";
    [ObservableProperty] public partial string CompanyRegNumber { get; set; } = "";
    [ObservableProperty] public partial string Website { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? CarrierCode { get; set; }
    [ObservableProperty] public partial string Country { get; set; } = "HU";
    [ObservableProperty] public partial string Zip { get; set; } = "";
    [ObservableProperty] public partial string City { get; set; } = "";
    [ObservableProperty] public partial string Address { get; set; } = "";
    [ObservableProperty] public partial string BillingName { get; set; } = "";
    [ObservableProperty] public partial string BillingCountry { get; set; } = "HU";
    [ObservableProperty] public partial string BillingZip { get; set; } = "";
    [ObservableProperty] public partial string BillingCity { get; set; } = "";
    [ObservableProperty] public partial string BillingAddress { get; set; } = "";
    [ObservableProperty] public partial string BillingEmail { get; set; } = "";
    [ObservableProperty] public partial string PaymentDays { get; set; } = "8";
    [ObservableProperty] public partial string Notes { get; set; } = "";
    [ObservableProperty] public partial Dictionary<string, string> Errors { get; set; } = [];
    [ObservableProperty] public partial string? Error { get; set; }
    [ObservableProperty] public partial string TypeText { get; set; } = "";
    [ObservableProperty] public partial string Stamp { get; set; } = "";
    [ObservableProperty] public partial bool IsCarrier { get; set; }

    public bool CanEdit => Page.Can("edit");
    public bool ReadOnly => !CanEdit;
    public bool CanDelete => Page.Can("delete");

    protected override void OnPropertyChanged(PropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        if (e.PropertyName is null or nameof(Errors) or nameof(Error) || Errors is not { Count: > 0 }) return;
        if (PartnerFormat.Without(Errors, PartnerFormat.Snake(e.PropertyName)) is { } rest) Errors = rest;
    }

    internal void Fill(PartnerDetail p)
    {
        Name = p.Name;
        Code = p.Code;
        Status = StatusChoices.FirstOrDefault((s) => s.Key == p.Status) ?? StatusChoices[0];
        TaxNumber = p.TaxNumber ?? "";
        EuVatNumber = p.EuVatNumber ?? "";
        CompanyRegNumber = p.CompanyRegNumber ?? "";
        Website = p.Website ?? "";
        CarrierCode = CarrierChoices.FirstOrDefault((c) => c.Key == (p.CarrierCode ?? "")) ?? CarrierChoices[0];
        Country = p.Country ?? "HU";
        Zip = p.Zip ?? "";
        City = p.City ?? "";
        Address = p.Address ?? "";
        BillingName = p.BillingName ?? "";
        BillingCountry = p.BillingCountry ?? "HU";
        BillingZip = p.BillingZip ?? "";
        BillingCity = p.BillingCity ?? "";
        BillingAddress = p.BillingAddress ?? "";
        BillingEmail = p.BillingEmail ?? "";
        PaymentDays = p.PaymentDays.ToString();
        Notes = p.Notes ?? "";
        TypeText = MetaInfo.Label(Shell.Meta.PartnerTypes, p.Type);
        IsCarrier = p.Type == "carrier";
        Stamp = $"Létrehozva: {Fmt.DateTime(p.CreatedAt)}, módosítva: {Fmt.DateTime(p.UpdatedAt)}";
        Errors = [];
        Error = null;
    }

    // The company's address into the billing fields (the name only if empty).
    [RelayCommand]
    void CopyAddress()
    {
        if (BillingName.Trim().Length == 0) BillingName = Name;
        BillingCountry = Country;
        BillingZip = Zip;
        BillingCity = City;
        BillingAddress = Address;
        Shell.Toast("A cégadatokat átmásoltam a számlázási mezőkbe. Mentsd el.");
    }

    [RelayCommand]
    Task SaveAsync() => Page.RunAsync(async () =>
    {
        Error = null;
        if (!int.TryParse(PaymentDays.Trim(), out var days) || days is < 0 or > 365)
        {
            Errors = new() { ["payment_days"] = "0 és 365 közötti egész számot adj meg." };
            Error = "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        var body = new Dictionary<string, object?>
        {
            ["name"] = Name.Trim(), ["code"] = Code.Trim().ToUpperInvariant(), ["status"] = Status.Key, ["tax_number"] = TaxNumber.Trim(),
            ["eu_vat_number"] = EuVatNumber.Trim(), ["company_reg_number"] = CompanyRegNumber.Trim(), ["website"] = Website.Trim(),
            ["country"] = Country.Trim().ToUpperInvariant(), ["zip"] = Zip.Trim(), ["city"] = City.Trim(), ["address"] = Address.Trim(),
            ["billing_name"] = BillingName.Trim(), ["billing_country"] = BillingCountry.Trim().ToUpperInvariant(), ["billing_zip"] = BillingZip.Trim(),
            ["billing_city"] = BillingCity.Trim(), ["billing_address"] = BillingAddress.Trim(), ["billing_email"] = BillingEmail.Trim(),
            ["payment_days"] = days, ["notes"] = Notes.Trim(),
        };
        if (IsCarrier) body["carrier_code"] = CarrierCode?.Key ?? "";
        try
        {
            var res = await Api.PatchAsync<PartnerSaved>($"api/partners/{PartnerId}", body);
            Shell.Toast(res.Changed is { Count: > 0 } ? "Partner adatai mentve." : "Nem változott semmi.", ToastKind.Success);
            await Page.LoadAsync();
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });

    // Only a partner without orders, products, stock ... can be deleted; else it can be deactivated.
    [RelayCommand]
    async Task DeleteAsync()
    {
        if (Page.Data is not { } p) return;
        if (!p.CanDelete)
        {
            var list = string.Join(", ", p.DeleteBlockers.Select((b) => $"{Fmt.Int(b.Count)} {b.Label}"));
            var canDeactivate = CanEdit && p.Status == "active";
            var text = $"{p.Name} partnerhez már tartoznak adatok: {list}. "
                + (canDeactivate ? "Inaktiváld inkább: a története megmarad, de új rendelés és betárolás nem rögzíthető rá." : "A partner története így megmarad.");
            var ok = await Shell.ConfirmAsync("A partner nem törölhető", text, canDeactivate ? "Inaktiválás" : "Rendben", canDeactivate ? "Mégse" : "Bezárás");
            if (!ok || !canDeactivate) return;
            await Page.RunAsync(async () =>
            {
                await Api.PatchAsync<PartnerSaved>($"api/partners/{PartnerId}", new { status = "inactive" });
                Shell.Toast("A partner inaktív lett.", ToastKind.Success);
                await Page.LoadAsync();
            });
            return;
        }
        if (!await Shell.ConfirmAsync("Partner törlése",
            $"Biztosan törlöd: {p.Name}? A kapcsolattartói, szerződései, dokumentumai, tarifái és API kulcsai is törlődnek. Ez nem vonható vissza.",
            "Végleges törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}");
            Shell.Toast("Partner törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}
