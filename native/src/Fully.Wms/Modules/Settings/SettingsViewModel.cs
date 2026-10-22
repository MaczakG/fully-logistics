using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// Beállítások: company data, the warehouse and the costing of quotes, location sizes and
// locations, default tariffs, courier and invoicing accounts, the logs. One tab at a time, each
// loads its data when shown.
public sealed partial class SettingsViewModel : PageViewModel
{
    public SettingsViewModel(ShellViewModel shell, string? tab = null) : base(shell)
    {
        Company = new(this);
        Warehouse = new(this);
        Locations = new(this);
        Tariffs = new(this);
        Couriers = new(this);
        Invoicing = new(this);
        Log = new(this);
        Tabs =
        [
            new("company", "Cégadatok"), new("warehouse", "Raktár"), new("locations", "Raktárhelyek"), new("tariffs", "Alap tarifák"),
            new("couriers", "Futárszolgálatok"), new("invoicing", "Számlázó"), new("log", "Napló"),
        ];
        SelectedKey = tab ?? "company";
        foreach (var t in Tabs) t.IsSelected = t.Key == SelectedKey;
    }

    public override string Title => "Beállítások";
    public override string? Module => "settings";

    public CompanyTab Company { get; }
    public WarehouseTab Warehouse { get; }
    public LocationsTab Locations { get; }
    public TariffsTab Tariffs { get; }
    public CouriersTab Couriers { get; }
    public InvoicingTab Invoicing { get; }
    public LogTab Log { get; }
    public IReadOnlyList<PartnerTabChip> Tabs { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsCompany), nameof(IsWarehouse), nameof(IsLocations), nameof(IsTariffs), nameof(IsCouriers),
        nameof(IsInvoicing), nameof(IsLog))]
    public partial string SelectedKey { get; set; }

    public bool IsCompany => SelectedKey == "company";
    public bool IsWarehouse => SelectedKey == "warehouse";
    public bool IsLocations => SelectedKey == "locations";
    public bool IsTariffs => SelectedKey == "tariffs";
    public bool IsCouriers => SelectedKey == "couriers";
    public bool IsInvoicing => SelectedKey == "invoicing";
    public bool IsLog => SelectedKey == "log";

    internal bool Can(string action) => Shell.Me?.Can("settings", action) == true;
    public bool ReadOnly => !Can("edit");
    internal ApiClient ApiClient => Api;
    internal new Task<bool> RunAsync(Func<Task> action) => base.RunAsync(action);

    SettingsTab Current => SelectedKey switch
    {
        "warehouse" => Warehouse,
        "locations" => Locations,
        "tariffs" => Tariffs,
        "couriers" => Couriers,
        "invoicing" => Invoicing,
        "log" => Log,
        _ => Company,
    };

    public override Task LoadAsync() => Current.LoadAsync();

    [RelayCommand]
    Task SelectTabAsync(PartnerTabChip tab)
    {
        SelectedKey = tab.Key;
        foreach (var t in Tabs) t.IsSelected = t == tab;
        return RunAsync(Current.LoadAsync);
    }
}

// A tab of the settings: its own data and form errors ("values.order_base", "credentials.password").
public abstract partial class SettingsTab(SettingsViewModel page) : ObservableObject
{
    public SettingsViewModel Page { get; } = page;
    protected ShellViewModel Shell => Page.Shell;
    protected ApiClient Api => Page.ApiClient;
    public bool ReadOnly => Page.ReadOnly;
    public bool CanEdit => !Page.ReadOnly;

    [ObservableProperty]
    public partial Dictionary<string, string> Errors { get; set; } = [];

    [ObservableProperty]
    public partial string? Error { get; set; }

    public abstract Task LoadAsync();

    partial void OnErrorsChanged(Dictionary<string, string> value) => ShowErrors(value);

    // Errors of fields that are not properties of the tab (a tariff row, a credential).
    protected virtual void ShowErrors(Dictionary<string, string> errors)
    {
    }

    // Saves; refused fields (400, 409) show on the form.
    protected Task SubmitAsync(Func<Task> save) => Page.RunAsync(async () =>
    {
        Error = null;
        Errors = [];
        try
        {
            await save();
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });

    // A corrected field loses its error at once.
    protected override void OnPropertyChanged(PropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        if (e.PropertyName is null or nameof(Errors) or nameof(Error) || Errors is not { Count: > 0 }) return;
        if (PartnerFormat.Without(Errors, PartnerFormat.Snake(e.PropertyName)) is { } rest) Errors = rest;
    }
}
