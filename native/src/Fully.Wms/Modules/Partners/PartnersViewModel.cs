using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Partners;

// GET /api/partners: clients, carriers and suppliers with the type tabs and their counts, search
// (name, code, tax number, town, e-mail) and status; a new partner.
public sealed partial class PartnersViewModel(ShellViewModel shell) : ListPageViewModel<PartnerRowItem>(shell)
{
    public override string Title => "Partnerek";
    public override string? Module => "partners";

    public IReadOnlyList<OrderTab> TypeTabs { get; } =
        [new("", "Összes"), new("client", "Ügyfelek"), new("carrier", "Fuvarozók"), new("supplier", "Beszállítók")];

    public static readonly IReadOnlyList<OrderChoice> Statuses = [new(null, "Minden állapot"), new("active", "Aktív"), new("inactive", "Inaktív")];

    [ObservableProperty]
    public partial OrderTab? SelectedTab { get; set; }

    [ObservableProperty]
    public partial OrderChoice Status { get; set; } = Statuses[0];

    [ObservableProperty]
    public partial PartnerRowItem? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("partners", "create") == true;
    public string EmptyText => Search.Trim().Length > 0 || Status.Key is not null
        ? "Nincs a szűrésnek megfelelő partner."
        : "Még nincs partner. Vedd fel az elsőt az Új partner gombbal.";

    bool quiet;

    partial void OnSelectedTabChanged(OrderTab? value)
    {
        foreach (var t in TypeTabs) t.IsSelected = t == value;
        Reload();
    }

    partial void OnStatusChanged(OrderChoice value) => Reload();

    void Reload()
    {
        OnPropertyChanged(nameof(EmptyText));
        if (Loaded && !quiet) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(PartnerRowItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new PartnerViewModel(Shell, value.Row.Id));
    }

    protected override string ListPath() => Query.Build("api/partners",
        ("type", SelectedTab?.Key is { Length: > 0 } t ? t : null), ("status", Status.Key), ("q", Search.Trim()));

    protected override async Task<(IReadOnlyList<PartnerRowItem> Items, int Total)> FetchAsync(int offset)
    {
        if (SelectedTab is null)
        {
            quiet = true;
            SelectedTab = TypeTabs[0];
            quiet = false;
        }
        var page = await Api.GetAsync<PartnersPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        foreach (var t in TypeTabs) t.Count = page.Counts.GetValueOrDefault(t.Key.Length > 0 ? t.Key : "all");
        return (page.Items.Select((r) => new PartnerRowItem(r, Shell.Meta)).ToList(), page.Total);
    }

    [RelayCommand]
    void SelectTab(OrderTab tab) => SelectedTab = tab;

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new PartnerNewViewModel(Shell, SelectedTab?.Key is { Length: > 0 } t ? t : "client"));
}

public sealed class PartnerRowItem(PartnerRow r, MetaInfo meta)
{
    public PartnerRow Row { get; } = r;
    public string Place => string.Join(" ", new[] { Row.Zip, Row.City }.Where((s) => !string.IsNullOrEmpty(s)));
    public string TypeText { get; } = MetaInfo.Label(meta.PartnerTypes, r.Type);
    public string CarrierText { get; } = r.Type == "carrier" && !string.IsNullOrEmpty(r.CarrierCode) ? MetaInfo.Label(meta.Carriers, r.CarrierCode) : "";
    public string ContactText => Row.ContactName ?? Row.BillingEmail ?? "";
    public bool NoContact => Row.ContactName is null;
    public string ContactSub => string.Join(", ", new[] { Row.ContactEmail, Row.ContactPhone }.Where((s) => !string.IsNullOrEmpty(s)));
}
