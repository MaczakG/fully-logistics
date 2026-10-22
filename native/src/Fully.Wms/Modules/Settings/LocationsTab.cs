using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Common;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// Raktárhelyek: the location sizes (the monthly fee of each is set per client), and the locations
// with filters, one by one or many at once (from a pattern, size or other changes, activating,
// deleting the unused), CSV import and export. One location holds one partner's goods only.
public sealed partial class LocationsTab(SettingsViewModel page) : SettingsTab(page)
{
    const int PageSize = 100;

    public static readonly IReadOnlyList<OrderChoice> OccupiedChoices = [new(null, "Mind"), new("1", "Foglalt"), new("0", "Üres")];
    public static readonly IReadOnlyList<OrderChoice> ActiveChoices = [new(null, "Mind"), new("1", "Aktív"), new("0", "Inaktív")];

    public bool CanCreate => Page.Can("create");
    public bool CanDelete => Page.Can("delete");
    public bool CanSelect => Page.Can("edit") || Page.Can("delete");

    [ObservableProperty] public partial IReadOnlyList<SizeRow> Sizes { get; set; } = [];
    [ObservableProperty] public partial LocationSummary? Summary { get; set; }
    public ObservableCollection<LocationItem> Items { get; } = [];
    [ObservableProperty] public partial int Total { get; set; }
    [ObservableProperty] public partial bool HasMore { get; set; }

    [ObservableProperty] public partial string Search { get; set; } = "";
    [ObservableProperty] public partial List<OrderChoice> Zones { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Zone { get; set; }
    [ObservableProperty] public partial List<OrderChoice> SizeFilters { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? SizeFilter { get; set; }
    [ObservableProperty] public partial List<OrderChoice> Kinds { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? KindFilter { get; set; }
    [ObservableProperty] public partial OrderChoice Occupied { get; set; } = OccupiedChoices[0];
    [ObservableProperty] public partial List<OrderChoice> Partners { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Partner { get; set; }
    [ObservableProperty] public partial OrderChoice Active { get; set; } = ActiveChoices[0];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelection), nameof(SelectionText), nameof(CanSelectMatching), nameof(SelectMatchingText))]
    public partial int SelectedCount { get; set; }

    public bool HasSelection => SelectedCount > 0;
    public string SelectionText => $"{Fmt.Int(SelectedCount)} kijelölve";
    public bool CanSelectMatching => SelectedCount > 0 && Total > SelectedCount;
    public string SelectMatchingText => $"Mind a {Fmt.Int(Total)} találat kijelölése";
    public string TotalText => $"{Fmt.Int(Total)} találat";
    public string EmptyText => Filtered ? "Nincs a szűrésnek megfelelő raktárhely." : "Még nincs raktárhely. Hozd létre őket egyenként vagy tömegesen.";
    public bool IsEmpty => Total == 0;
    bool Filtered => Search.Trim().Length > 0 || Zone?.Key is not null || SizeFilter?.Key is not null || KindFilter?.Key is not null
        || Occupied.Key is not null || Partner?.Key is not null || Active.Key is not null;
    public bool HasFilters => Filtered;

    public string KpiTotal => Fmt.Int(Summary?.Total ?? 0);
    public string KpiOccupied => Fmt.Int(Summary?.Occupied ?? 0);
    public string KpiOccupiedHint => Summary is { Total: > 0 } s ? $"{Fmt.Num(s.Occupied * 100m / s.Total, 0)} % kihasználtság" : "";
    public string KpiEmpty => Fmt.Int(Summary?.EmptyStorage ?? 0);
    public bool KpiEmptyWarn => Summary is { Total: > 0, EmptyStorage: 0 };
    public string KpiInactive => Fmt.Int((Summary?.Total ?? 0) - (Summary?.Active ?? 0));

    // The selection over pages: the ids, not the rows.
    readonly HashSet<int> selected = [];
    internal IReadOnlyCollection<int> SelectedIds => selected;
    internal List<LocationSize> SizeList { get; private set; } = [];
    internal List<OrderChoice> ClientChoices { get; private set; } = [];
    bool quiet;

    partial void OnZoneChanged(OrderChoice? value) => Filter();
    partial void OnSizeFilterChanged(OrderChoice? value) => Filter();
    partial void OnKindFilterChanged(OrderChoice? value) => Filter();
    partial void OnOccupiedChanged(OrderChoice value) => Filter();
    partial void OnPartnerChanged(OrderChoice? value) => Filter();
    partial void OnActiveChanged(OrderChoice value) => Filter();

    void Filter()
    {
        if (quiet) return;
        ClearSelection();
        _ = Page.RunAsync(() => LoadListAsync(0));
    }

    public override async Task LoadAsync()
    {
        if (ClientChoices.Count == 0)
        {
            var clients = await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1");
            ClientChoices = clients.Items.Select((p) => new OrderChoice(p.Id.ToString(), $"{p.Name} ({p.Code}){(p.Status == "active" ? "" : ", inaktív")}")).ToList();
            quiet = true;
            Partners = [new(null, "Mind"), .. ClientChoices];
            Partner = Partners[0];
            Kinds = [new(null, "Mind"), .. Shell.Meta.LocationKinds.Select((k) => new OrderChoice(k.Key, k.Value))];
            KindFilter = Kinds[0];
            quiet = false;
        }
        await LoadSizesAsync();
        await LoadListAsync(0);
    }

    async Task LoadSizesAsync()
    {
        SizeList = (await Api.GetAsync<ItemList<LocationSize>>("api/settings/sizes")).Items;
        Sizes = SizeList.Select((s) => new SizeRow(this, s)).ToList();
        quiet = true;
        var keep = SizeFilter?.Key;
        SizeFilters = [new(null, "Mind"), .. SizeList.Select((s) => new OrderChoice(s.Id.ToString(), $"{s.Code} {s.Name}"))];
        SizeFilter = SizeFilters.FirstOrDefault((s) => s.Key == keep) ?? SizeFilters[0];
        quiet = false;
    }

    string Filters(string path) => Query.Build(path, ("q", Search.Trim()), ("zone", Zone?.Key), ("size_id", SizeFilter?.Key), ("kind", KindFilter?.Key),
        ("occupied", Occupied.Key), ("partner_id", Partner?.Key), ("active", Active.Key));

    async Task LoadListAsync(int offset)
    {
        var page = await Api.GetAsync<SettingsLocationsPage>(Query.Build(Filters("api/settings/locations"), ("limit", PageSize), ("offset", offset)));
        if (offset == 0) Items.Clear();
        foreach (var l in page.Items) Items.Add(new LocationItem(this, l, selected.Contains(l.Id)));
        Total = page.Total;
        HasMore = Items.Count < Total;
        Summary = page.Summary;
        quiet = true;
        var keep = Zone?.Key;
        Zones = [new(null, "Mind"), .. page.Zones.Select((z) => new OrderChoice(z, z)), new("-", "Zóna nélkül")];
        Zone = Zones.FirstOrDefault((z) => z.Key == keep) ?? Zones[0];
        quiet = false;
        foreach (var name in new[] { nameof(TotalText), nameof(EmptyText), nameof(IsEmpty), nameof(HasFilters), nameof(KpiTotal), nameof(KpiOccupied),
            nameof(KpiOccupiedHint), nameof(KpiEmpty), nameof(KpiEmptyWarn), nameof(KpiInactive), nameof(CanSelectMatching), nameof(SelectMatchingText) })
            OnPropertyChanged(name);
    }

    [RelayCommand]
    Task ApplyAsync()
    {
        ClearSelection();
        return Page.RunAsync(() => LoadListAsync(0));
    }

    [RelayCommand]
    Task MoreAsync() => Page.RunAsync(() => LoadListAsync(Items.Count));

    [RelayCommand]
    Task ClearFiltersAsync()
    {
        quiet = true;
        Search = "";
        Zone = Zones.FirstOrDefault();
        SizeFilter = SizeFilters.FirstOrDefault();
        KindFilter = Kinds.FirstOrDefault();
        Occupied = OccupiedChoices[0];
        Partner = Partners.FirstOrDefault();
        Active = ActiveChoices[0];
        quiet = false;
        ClearSelection();
        return Page.RunAsync(() => LoadListAsync(0));
    }

    // The size's locations: the list filtered to it.
    internal Task FilterSizeAsync(LocationSize s)
    {
        quiet = true;
        Search = "";
        Zone = Zones.FirstOrDefault();
        KindFilter = Kinds.FirstOrDefault();
        Occupied = OccupiedChoices[0];
        Partner = Partners.FirstOrDefault();
        Active = ActiveChoices[0];
        SizeFilter = SizeFilters.FirstOrDefault((x) => x.Key == s.Id.ToString());
        quiet = false;
        ClearSelection();
        return Page.RunAsync(() => LoadListAsync(0));
    }

    // ------------------------------------------------------------------ selection

    internal void Select(LocationItem item, bool on)
    {
        if (on) selected.Add(item.Location.Id);
        else selected.Remove(item.Location.Id);
        SelectedCount = selected.Count;
    }

    [RelayCommand]
    void SelectPage()
    {
        var all = Items.Any((i) => !i.IsSelected);
        foreach (var i in Items) i.IsSelected = all;
    }

    [RelayCommand]
    Task SelectMatchingAsync() => Page.RunAsync(async () =>
    {
        var res = await Api.GetAsync<LocationIds>(Query.Build(Filters("api/settings/locations"), ("ids_only", 1)));
        foreach (var id in res.Ids) selected.Add(id);
        foreach (var i in Items) i.Show(true);
        SelectedCount = selected.Count;
    });

    [RelayCommand]
    internal void ClearSelection()
    {
        selected.Clear();
        foreach (var i in Items) i.Show(false);
        SelectedCount = 0;
    }

    // What the server left out, with the reason.
    internal Task ShowSkippedAsync(string title, IReadOnlyList<SkippedLocation> skipped)
    {
        if (skipped.Count == 0) return Task.CompletedTask;
        var list = string.Join("\n", skipped.Take(15).Select((s) => s.Code.Length > 0 ? $"{s.Code}: {s.Reason}" : s.Reason));
        var more = skipped.Count > 15 ? $"\nés még {Fmt.Int(skipped.Count - 15)}" : "";
        return Shell.ConfirmAsync(title, $"{Fmt.Int(skipped.Count)} raktárhely kimaradt.\n{list}{more}", "Rendben", "Bezárás");
    }

    // ------------------------------------------------------------------ sizes

    [RelayCommand]
    Task NewSizeAsync() => Shell.NavigateAsync(new SizeFormViewModel(Shell, null));

    internal Task EditSizeAsync(LocationSize s) => Shell.NavigateAsync(new SizeFormViewModel(Shell, s));

    internal async Task DeleteSizeAsync(LocationSize s)
    {
        if (!await Shell.ConfirmAsync("Méret törlése", $"Biztosan törlöd a(z) {s.Code} ({s.Name}) méretet? A partnereknél megadott díjai is törlődnek.", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/settings/sizes/{s.Id}");
            Shell.Toast($"{s.Code} méret törölve.", ToastKind.Success);
            await Shell.RefreshMetaAsync();
            await LoadSizesAsync();
        });
    }

    // ------------------------------------------------------------------ locations

    [RelayCommand]
    Task NewLocationAsync() => Shell.NavigateAsync(new LocationFormViewModel(Shell, this, null));

    internal Task OpenLocationAsync(SettingsLocation l) => Shell.NavigateAsync(new LocationFormViewModel(Shell, this, l.Id));

    [RelayCommand]
    Task BulkCreateAsync() => Shell.NavigateAsync(new BulkCreateViewModel(Shell, this));

    [RelayCommand]
    Task BulkSizeAsync() => Shell.NavigateAsync(new BulkChangeViewModel(Shell, this, sizeOnly: true));

    [RelayCommand]
    Task BulkEditAsync() => Shell.NavigateAsync(new BulkChangeViewModel(Shell, this, sizeOnly: false));

    [RelayCommand]
    Task BulkActivateAsync() => BulkUpdateAsync(new Dictionary<string, object?> { ["active"] = true }, "aktiválva");

    [RelayCommand]
    async Task BulkDeactivateAsync()
    {
        if (!await Shell.ConfirmAsync("Inaktiválás",
            $"A kijelölt {Fmt.Int(SelectedCount)} raktárhelyből az üreseket inaktiváljuk: ezekre nem lehet árut tenni, és nem jelennek meg a választólistákban.",
            "Inaktiválás")) return;
        await BulkUpdateAsync(new Dictionary<string, object?> { ["active"] = false }, "inaktiválva");
    }

    Task BulkUpdateAsync(Dictionary<string, object?> changes, string label) => Page.RunAsync(async () =>
    {
        changes["ids"] = selected.ToList();
        var res = await Api.PostAsync<BulkUpdated>("api/settings/locations/bulk-update", changes);
        Shell.Toast($"{Fmt.Int(res.Updated)} raktárhely {label}.", res.Updated > 0 ? ToastKind.Success : ToastKind.Info);
        ClearSelection();
        await LoadAsync();
        await ShowSkippedAsync("Kimaradt raktárhelyek", res.Skipped);
    });

    [RelayCommand]
    async Task BulkDeleteAsync()
    {
        if (!await Shell.ConfirmAsync("Raktárhelyek törlése",
            $"A kijelölt {Fmt.Int(SelectedCount)} raktárhelyből azokat töröljük, amelyeken még nem volt forgalom. A többit inaktiválhatod.", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            var res = await Api.PostAsync<BulkDeleted>("api/settings/locations/bulk-delete", new { ids = selected.ToList() });
            Shell.Toast($"{Fmt.Int(res.Deleted)} raktárhely törölve.", res.Deleted > 0 ? ToastKind.Success : ToastKind.Info);
            ClearSelection();
            await LoadAsync();
            await ShowSkippedAsync("Nem törölhető raktárhelyek", res.Skipped);
        });
    }

    [RelayCommand]
    Task ImportAsync() => Shell.NavigateAsync(new CsvImportViewModel(Shell, new CsvImportOptions(
        "settings", "Raktárhelyek importálása", "api/settings/locations/import",
        "Új kódnál létrehozzuk a raktárhelyet, meglévőnél a kitöltött oszlopok szerint módosítjuk (például a méretet). A Méret oszlopba a méret kódja kerüljön (M, L, XL, PAL), a Fix partner oszlopba az ügyfél kódja. Tipp: exportáld a listát, javítsd Excelben, és töltsd vissza.",
        "raktarhelyek.csv", ["Kód", "Zóna", "Méret", "Típus", "Fix partner", "Komissiós sorrend", "Aktív", "Megjegyzés"],
        (r) => $"{Fmt.Int(r.Created)} új és {Fmt.Int(r.Updated)} módosított raktárhely.")));

    [RelayCommand]
    Task ExportAsync() => Page.RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(Filters("api/settings/locations/export"))));

    internal IReadOnlyList<OrderChoice> ActiveSizeChoices(int? keep = null) =>
        SizeList.Where((s) => s.Active || s.Id == keep).Select((s) => new OrderChoice(s.Id.ToString(), $"{s.Code} {s.Name}{(s.Active ? "" : " (inaktív)")}")).ToList();

    internal IReadOnlyList<OrderChoice> KindChoices => Shell.Meta.LocationKinds.Select((k) => new OrderChoice(k.Key, k.Value)).ToList();
}

public sealed class SizeRow(LocationsTab tab, LocationSize s)
{
    public LocationSize Size { get; } = s;
    public string Dims
    {
        get
        {
            decimal?[] d = [Size.WidthCm, Size.DepthCm, Size.HeightCm];
            return d.Any((x) => x is not null) ? $"{string.Join(" × ", d.Select((x) => x is { } v ? Fmt.Num(v, 1) : "?"))} cm" : "";
        }
    }
    public string MaxKg => Size.MaxKg is { } kg ? $"{Fmt.Num(kg)} kg" : "";
    public string LocationsText => Fmt.Int(Size.LocationCount);
    public string OccupiedText => $"{Fmt.Int(Size.OccupiedCount)} foglalt";
    public string Status => Size.Active ? "active" : "inactive";
    public bool CanEdit => tab.CanEdit;
    public bool CanDelete => tab.CanDelete && Size.LocationCount == 0;
    public string DeleteTip => Size.LocationCount > 0 ? "Használt méret: csak inaktiválható" : "Törlés";
    public RelayCommand EditCommand => new(() => _ = tab.EditSizeAsync(Size));
    public RelayCommand DeleteCommand => new(() => _ = tab.DeleteSizeAsync(Size));
    public RelayCommand FilterCommand => new(() => _ = tab.FilterSizeAsync(Size));
}

public sealed partial class LocationItem(LocationsTab tab, SettingsLocation l, bool selected) : ObservableObject
{
    public SettingsLocation Location { get; } = l;
    public string KindText => Core.Models.MetaInfo.Label(tab.Page.Shell.Meta.LocationKinds, Location.Kind);
    public bool IsFree => Location.OccupantId is null;
    public string OccupantText => Location.OccupantName ?? "üres";
    public string OccupantSub => Location.OccupantId is null ? "" : $"{Fmt.Int(Location.Qty)} db, {Fmt.Int(Location.Products)} cikk";
    public string SequenceText => Location.PickSequence > 0 ? Location.PickSequence.ToString() : "";
    public string Status => Location.Active ? "active" : "inactive";
    public bool CanSelect => tab.CanSelect;

    bool on = selected;
    bool quiet;

    public bool IsSelected
    {
        get => on;
        set
        {
            if (value == on) return;
            on = value;
            OnPropertyChanged();
            if (!quiet) tab.Select(this, value);
        }
    }

    internal void Show(bool value)
    {
        quiet = true;
        IsSelected = value;
        quiet = false;
    }

    public RelayCommand OpenCommand => new(() => _ = tab.OpenLocationAsync(Location));
}
