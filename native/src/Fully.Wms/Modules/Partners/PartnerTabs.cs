using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Partners;

// Kapcsolattartók: one of them is the primary contact.
public sealed partial class PartnerContactsTab(PartnerViewModel page) : PartnerTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsEmpty))]
    public partial IReadOnlyList<ContactRow> Items { get; set; } = [];

    public bool CanEdit => Page.Can("edit");
    public bool IsEmpty => Items.Count == 0;

    public override async Task LoadAsync() =>
        Items = (await Api.GetAsync<ItemList<PartnerContact>>($"api/partners/{PartnerId}/contacts")).Items.Select((c) => new ContactRow(this, c)).ToList();

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new ContactFormViewModel(Shell, PartnerId, null, Items.Count == 0));

    internal Task EditAsync(PartnerContact c) => Shell.NavigateAsync(new ContactFormViewModel(Shell, PartnerId, c, false));

    internal Task PrimaryAsync(PartnerContact c) => Page.RunAsync(async () =>
    {
        await Api.PatchAsync<PartnerSaved>($"api/partners/{PartnerId}/contacts/{c.Id}", new { is_primary = true });
        Shell.Toast("Elsődleges kapcsolattartó beállítva.", ToastKind.Success);
        await Page.LoadAsync();
    });

    internal async Task RemoveAsync(PartnerContact c)
    {
        if (!await Shell.ConfirmAsync("Kapcsolattartó törlése", $"Biztosan törlöd: {c.Name}?", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}/contacts/{c.Id}");
            Shell.Toast("Kapcsolattartó törölve.", ToastKind.Success);
            await Page.LoadAsync();
        });
    }
}

public sealed class ContactRow(PartnerContactsTab tab, PartnerContact c)
{
    public PartnerContact Contact { get; } = c;
    public bool CanEdit => tab.CanEdit;
    public bool CanMakePrimary => tab.CanEdit && !Contact.IsPrimary;
    public RelayCommand EditCommand => new(() => _ = tab.EditAsync(Contact));
    public RelayCommand PrimaryCommand => new(() => _ = tab.PrimaryAsync(Contact));
    public RelayCommand RemoveCommand => new(() => _ = tab.RemoveAsync(Contact));
}

// Szerződés és dokumentumok: the contracts with their expiry, and the uploaded files.
public sealed partial class PartnerContractsTab(PartnerViewModel page) : PartnerTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoContracts))]
    public partial IReadOnlyList<ContractRow> ContractRows { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoDocuments))]
    public partial IReadOnlyList<DocumentRow> Documents { get; set; } = [];

    public bool CanEdit => Page.Can("edit");
    public bool NoContracts => ContractRows.Count == 0;
    public bool NoDocuments => Documents.Count == 0;
    internal List<PartnerContract> Contracts { get; private set; } = [];

    public override async Task LoadAsync()
    {
        var contracts = Api.GetAsync<ItemList<PartnerContract>>($"api/partners/{PartnerId}/contracts");
        var docs = Api.GetAsync<ItemList<PartnerDocument>>($"api/partners/{PartnerId}/documents");
        Contracts = (await contracts).Items;
        ContractRows = Contracts.Select((c) => new ContractRow(this, c)).ToList();
        Documents = (await docs).Items.Select((d) => new DocumentRow(this, d)).ToList();
    }

    internal static string Label(string? number, string? title) => string.Join(", ", new[] { number, title }.Where((s) => !string.IsNullOrEmpty(s)));

    [RelayCommand]
    Task NewContractAsync() => Shell.NavigateAsync(new ContractFormViewModel(Shell, PartnerId, null));

    [RelayCommand]
    Task UploadAsync() => Shell.NavigateAsync(new DocumentUploadViewModel(Shell, PartnerId, Contracts));

    internal Task EditContractAsync(PartnerContract c) => Shell.NavigateAsync(new ContractFormViewModel(Shell, PartnerId, c));

    internal async Task RemoveContractAsync(PartnerContract c)
    {
        var label = Label(c.Number, c.Title);
        var text = c.Documents > 0
            ? $"Biztosan törlöd: {label}? A hozzá kapcsolt {c.Documents} dokumentum megmarad, csak a kapcsolat szűnik meg."
            : $"Biztosan törlöd: {label}?";
        if (!await Shell.ConfirmAsync("Szerződés törlése", text, "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}/contracts/{c.Id}");
            Shell.Toast("Szerződés törölve.", ToastKind.Success);
            await Page.LoadAsync();
        });
    }

    internal Task OpenDocumentAsync(PartnerDocument d) => Page.RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/documents/{d.Id}")));

    internal Task EditDocumentAsync(PartnerDocument d) => Shell.NavigateAsync(new DocumentEditViewModel(Shell, PartnerId, d, Contracts));

    internal async Task RemoveDocumentAsync(PartnerDocument d)
    {
        if (!await Shell.ConfirmAsync("Dokumentum törlése", $"Biztosan törlöd: {d.Filename}? A fájl végleg törlődik.", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}/documents/{d.Id}");
            Shell.Toast("Dokumentum törölve.", ToastKind.Success);
            await Page.LoadAsync();
        });
    }
}

public sealed class ContractRow(PartnerContractsTab tab, PartnerContract c)
{
    public PartnerContract Contract { get; } = c;
    public string NumberText => string.IsNullOrEmpty(Contract.Number) ? "nincs" : Contract.Number;
    public bool NoNumber => string.IsNullOrEmpty(Contract.Number);
    public string StartText => Fmt.Date(Contract.StartDate);
    public string EndText => Contract.EndDate is null ? "Határozatlan" : Fmt.Date(Contract.EndDate);

    // Active contracts that ran out or run out within 60 days.
    public string? ExpiryNote
    {
        get
        {
            if (Contract.Status != "active" || Contract.EndDate is null) return null;
            var today = DateOnly.ParseExact(PartnerFormat.Today, "yyyy-MM-dd", CultureInfo.InvariantCulture);
            var days = DateOnly.ParseExact(Contract.EndDate, "yyyy-MM-dd", CultureInfo.InvariantCulture).DayNumber - today.DayNumber;
            return days < 0 ? "lejárt" : days == 0 ? "ma jár le" : days <= 60 ? $"{days} nap múlva lejár" : null;
        }
    }

    public string NoticeText => $"{Fmt.Int(Contract.NoticeDays)} nap";
    public string DocumentsText => Fmt.Int(Contract.Documents);
    public bool CanEdit => tab.CanEdit;
    public RelayCommand EditCommand => new(() => _ = tab.EditContractAsync(Contract));
    public RelayCommand RemoveCommand => new(() => _ = tab.RemoveContractAsync(Contract));
}

public sealed class DocumentRow(PartnerContractsTab tab, PartnerDocument d)
{
    public PartnerDocument Document { get; } = d;
    public string SizeText => PartnerFormat.Bytes(Document.Size);
    public string KindText => PartnerFormat.DocumentKinds.GetValueOrDefault(Document.Kind, Document.Kind);
    public string ContractText => Document.ContractId is null ? "nincs" : PartnerContractsTab.Label(Document.ContractNumber, Document.ContractTitle);
    public bool NoContract => Document.ContractId is null;
    public string UploadedText => Fmt.DateTime(Document.UploadedAt);
    public bool CanEdit => tab.CanEdit;
    public RelayCommand OpenCommand => new(() => _ = tab.OpenDocumentAsync(Document));
    public RelayCommand EditCommand => new(() => _ = tab.EditDocumentAsync(Document));
    public RelayCommand RemoveCommand => new(() => _ = tab.RemoveDocumentAsync(Document));
}

// Tarifák: the flat fees and the storage prices per location size against the defaults of the
// settings, saved together; the custom items of the client.
public sealed partial class PartnerTariffsTab(PartnerViewModel page) : PartnerTab(page)
{
    static readonly (string Key, string Label)[] Groups =
        [("handling", "Rendeléskezelés"), ("inbound", "Betárolás és visszáru"), ("extra", "Extrák"), ("discount", "Kedvezmények"), ("vat", "ÁFA")];

    [ObservableProperty]
    public partial IReadOnlyList<TariffGroup> TariffGroups { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoStorage))]
    public partial IReadOnlyList<TariffInput> Storage { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoCustom))]
    public partial IReadOnlyList<CustomItemRow> Custom { get; set; } = [];

    [ObservableProperty]
    public partial string DiffText { get; set; } = "";

    [ObservableProperty]
    public partial bool HasDiffs { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    public bool CanEdit => Page.Can("approve");
    public bool ReadOnly => !CanEdit;
    public bool NoStorage => Storage.Count == 0;
    public bool NoCustom => Custom.Count == 0;

    IEnumerable<TariffInput> Inputs => TariffGroups.SelectMany((g) => g.Items).Concat(Storage);

    public override async Task LoadAsync() => Show(await Api.GetAsync<PartnerTariffs>($"api/partners/{PartnerId}/tariffs"));

    void Show(PartnerTariffs t)
    {
        TariffGroups = Groups
            .Select((g) => new TariffGroup(g.Label, t.Tariffs.Where((x) => x.Group == g.Key)
                .Select((x) => new TariffInput(this, x.Key, x.Label, x.Unit, x.Unit, x.Default, x.Value, x.Unit.StartsWith('%'))).ToList()))
            .Where((g) => g.Items.Count > 0).ToList();
        Storage = t.Storage.Select((s) => new TariffInput(this, $"storage_{s.SizeId}", $"{s.Code} · {s.Name}", PartnerFormat.Dims(s), "Ft / hely / hó",
            s.Default, s.Price, false) { SizeId = s.SizeId }).ToList();
        Custom = t.CustomItems.Select((c) => new CustomItemRow(this, c)).ToList();
        Error = null;
        Refresh();
    }

    internal void Refresh()
    {
        var n = Inputs.Count((i) => i.Differs);
        HasDiffs = n > 0;
        DiffText = n > 0 ? $"{Fmt.Int(n)} díj eltér az alaptól" : "Minden díj az alapértéken";
    }

    [RelayCommand]
    Task SaveAsync() => Page.RunAsync(async () =>
    {
        Error = null;
        foreach (var i in Inputs) i.Error = null;
        var tariffs = new Dictionary<string, object?>();
        var storage = new Dictionary<string, object?>();
        foreach (var i in Inputs)
        {
            var v = i.Value.Trim().Length == 0 ? null : Fmt.ParseNumber(i.Value);
            if (i.Value.Trim().Length > 0 && v is null)
            {
                i.Error = "Számot várunk.";
                continue;
            }
            if (i.SizeId is { } size) storage[size.ToString()] = v;
            else tariffs[i.Key] = v;
        }
        if (Inputs.Any((i) => i.Error is not null))
        {
            Error = "Ellenőrizd a megjelölt díjakat.";
            return;
        }
        try
        {
            Show(await Api.PutAsync<PartnerTariffs>($"api/partners/{PartnerId}/tariffs", new { tariffs, storage }));
            Shell.Toast("Tarifák mentve.", ToastKind.Success);
        }
        catch (ApiException e) when (e.Status == 400)
        {
            foreach (var i in Inputs) i.Error = e.Fields.GetValueOrDefault(i.Key);
            Error = e.Message;
        }
    });

    [RelayCommand]
    async Task ResetAsync()
    {
        if (!await Shell.ConfirmAsync("Visszaállítás alapra",
            "Az összes díjtétel és tárolási díj a Beállítások alapértékére áll vissza. Az egyedi tételek megmaradnak.", "Visszaállítás")) return;
        await Page.RunAsync(async () =>
        {
            Show(await Api.PostAsync<PartnerTariffs>($"api/partners/{PartnerId}/tariffs/reset"));
            Shell.Toast("A díjak az alapértékre álltak vissza.", ToastKind.Success);
        });
    }

    [RelayCommand]
    Task NewItemAsync() => Shell.NavigateAsync(new CustomItemFormViewModel(Shell, PartnerId, null));

    internal Task EditItemAsync(CustomItem c) => Shell.NavigateAsync(new CustomItemFormViewModel(Shell, PartnerId, c));

    internal async Task RemoveItemAsync(CustomItem c)
    {
        if (!await Shell.ConfirmAsync("Egyedi tétel törlése", $"Biztosan törlöd: {c.Name}?", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}/custom-items/{c.Id}");
            Shell.Toast("Egyedi tétel törölve.", ToastKind.Success);
            await LoadAsync();
        });
    }
}

public sealed record TariffGroup(string Label, IReadOnlyList<TariffInput> Items);

// One fee: the default next to the client's own; "Eltér" when they differ.
public sealed partial class TariffInput(PartnerTariffsTab tab, string key, string label, string sub, string unit, decimal @default, decimal value, bool percent)
    : ObservableObject
{
    public string Key { get; } = key;
    public string Label { get; } = label;
    public string Sub { get; } = sub;
    public string Unit { get; } = unit;
    public int? SizeId { get; init; }
    public decimal Default { get; } = @default;
    public string DefaultText { get; } = percent ? $"{Fmt.Num(@default)} %" : $"{Fmt.Num(@default)} Ft";
    public bool ReadOnly => tab.ReadOnly;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Differs))]
    public partial string Value { get; set; } = Fmt.Num(value);

    [ObservableProperty]
    public partial string? Error { get; set; }

    public bool Differs => Fmt.ParseNumber(Value) is { } v && v != Default;

    partial void OnValueChanged(string value)
    {
        Error = null;
        tab.Refresh();
    }
}

public sealed class CustomItemRow(PartnerTariffsTab tab, CustomItem c)
{
    public CustomItem Item { get; } = c;
    public string KindText => Item.Kind == "monthly" ? "Havi fix díj" : "Mennyiség alapján";
    public string PriceText => $"{Fmt.Num(Item.Price)} Ft / {(Item.Kind == "monthly" ? "hó" : Item.Unit)}";
    public bool CanEdit => tab.CanEdit;
    public RelayCommand EditCommand => new(() => _ = tab.EditItemAsync(Item));
    public RelayCommand RemoveCommand => new(() => _ = tab.RemoveItemAsync(Item));
}

// Integrációk: webshop connections (test, sync now) and the client's partner API keys.
public sealed partial class PartnerIntegrationsTab(PartnerViewModel page) : PartnerTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPlatforms))]
    public partial PartnerIntegrations? Data { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoConnections))]
    public partial IReadOnlyList<ConnectionRow> Connections { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoKeys))]
    public partial IReadOnlyList<ApiKeyItem> Keys { get; set; } = [];

    // The answer of the last test or sync.
    [ObservableProperty]
    public partial string? Result { get; set; }

    [ObservableProperty]
    public partial string ResultTone { get; set; } = "ok";

    public bool CanEdit => Page.Can("approve");
    public bool ReadOnly => !CanEdit;
    public bool HasPlatforms => Data is { Platforms.Count: > 0 };
    public bool NoConnections => Connections.Count == 0;
    public bool NoKeys => Keys.Count == 0;
    public bool CanNewKey => CanEdit && Page.Data?.Status == "active";
    public string DocsUrl => new Uri(Api.BaseUri, Data?.ApiDocsUrl ?? "/api/v1/docs").ToString();

    public override async Task LoadAsync()
    {
        var d = await Api.GetAsync<PartnerIntegrations>($"api/partners/{PartnerId}/integrations");
        Data = d;
        Connections = d.Connections.Select((c) => new ConnectionRow(this, c)).ToList();
        Keys = d.ApiKeys.Select((k) => new ApiKeyItem(this, k)).ToList();
        OnPropertyChanged(nameof(CanNewKey));
    }

    void Replace(WebshopConnection c) => Connections = Connections.Select((r) => r.Connection.Id == c.Id ? new ConnectionRow(this, c) : r).ToList();

    [RelayCommand]
    Task NewConnectionAsync() => Data is { Platforms.Count: > 0 } d
        ? Shell.NavigateAsync(new ConnectionFormViewModel(Shell, PartnerId, d.Platforms, null))
        : Task.CompletedTask;

    internal async Task EditConnectionAsync(WebshopConnection c)
    {
        if (Data is not { } d) return;
        if (!d.Platforms.Any((p) => p.Code == c.Platform))
        {
            await Shell.ConfirmAsync("Webshop kapcsolat",
                $"A(z) {c.PlatformName} integráció most nem elérhető, ezért a kapcsolat beállításai nem módosíthatók. Törölni tudod.", "Rendben", "Bezárás");
            return;
        }
        await Shell.NavigateAsync(new ConnectionFormViewModel(Shell, PartnerId, d.Platforms, c));
    }

    internal async Task RemoveConnectionAsync(WebshopConnection c)
    {
        if (!await Shell.ConfirmAsync("Webshop kapcsolat törlése",
            $"Biztosan törlöd: {c.ShopUrl}? A mentett hozzáférési adatok is törlődnek, a már importált rendelések megmaradnak.", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/partners/{PartnerId}/webshops/{c.Id}");
            Shell.Toast("Webshop kapcsolat törölve.", ToastKind.Success);
            await Page.LoadAsync();
        });
    }

    internal Task TestAsync(WebshopConnection c) => Page.RunAsync(async () =>
    {
        var res = await Api.PostAsync<WebshopTested>($"api/partners/{PartnerId}/webshops/{c.Id}/test");
        ResultTone = res.Result.Ok ? "ok" : "danger";
        Result = $"{c.ShopUrl}: {res.Result.Message}";
        Replace(res.Connection);
    });

    internal Task SyncAsync(WebshopConnection c) => Page.RunAsync(async () =>
    {
        var res = await Api.PostAsync<WebshopSynced>($"api/partners/{PartnerId}/webshops/{c.Id}/sync");
        var r = res.Result;
        ResultTone = r.Ok && r.Errors.Count == 0 ? "ok" : r.Ok ? "warn" : "danger";
        Result = $"{c.ShopUrl}: " + (r.Ok ? $"{Fmt.Int(r.Imported)} rendelés importálva, {Fmt.Int(r.Skipped)} kihagyva." : "A szinkronizálás nem sikerült.")
            + string.Concat(r.Errors.Select((e) => $"\n• {e}"));
        Replace(res.Connection);
    });

    [RelayCommand]
    Task NewKeyAsync() => Shell.NavigateAsync(new ApiKeyFormViewModel(Shell, PartnerId));

    internal async Task RevokeAsync(ApiKeyRow k)
    {
        if (!await Shell.ConfirmAsync("API kulcs visszavonása",
            $"Visszavonod a(z) „{k.Name}” kulcsot ({k.Prefix}...)? Az ezt használó rendszer azonnal elveszti a hozzáférést. Ez nem vonható vissza.",
            "Visszavonás", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.PostAsync($"api/partners/{PartnerId}/api-keys/{k.Id}/revoke");
            Shell.Toast("API kulcs visszavonva.", ToastKind.Success);
            await Page.LoadAsync();
        });
    }
}

public sealed class ConnectionRow(PartnerIntegrationsTab tab, WebshopConnection c)
{
    public WebshopConnection Connection { get; } = c;
    public string Url => Connection.ShopUrl.Replace("https://", "");
    public string SyncText => Connection.LastSyncAt is { } t ? Fmt.DateTime(t) : "még nem volt";
    public string? ErrorText => !string.IsNullOrEmpty(Connection.CredentialsError) ? Connection.CredentialsError
        : string.IsNullOrEmpty(Connection.LastError) ? null : Connection.LastError;
    public bool CanEdit => tab.CanEdit;
    public bool CanSync => tab.CanEdit && Connection.Active;
    public RelayCommand TestCommand => new(() => _ = tab.TestAsync(Connection));
    public RelayCommand SyncCommand => new(() => _ = tab.SyncAsync(Connection));
    public RelayCommand EditCommand => new(() => _ = tab.EditConnectionAsync(Connection));
    public RelayCommand RemoveCommand => new(() => _ = tab.RemoveConnectionAsync(Connection));
}

public sealed class ApiKeyItem(PartnerIntegrationsTab tab, ApiKeyRow k)
{
    public ApiKeyRow Key { get; } = k;
    public string PrefixText => $"{Key.Prefix}...";
    public string CreatedText => Fmt.DateTime(Key.CreatedAt) + (Key.CreatedByName is { } n ? $", {n}" : "");
    public string UsedText => Key.LastUsedAt is { } t ? Fmt.DateTime(t) : "még nem";
    public bool Revoked => Key.RevokedAt is not null;
    public string RevokedText => Key.RevokedAt is { } t ? Fmt.DateTime(t) : "";
    public bool CanRevoke => tab.CanEdit && !Revoked;
    public RelayCommand RevokeCommand => new(() => _ = tab.RevokeAsync(Key));
}

// Összesítő: per type: a client's stock, orders and storage this month; a carrier's shipments and
// pickups; a supplier's inbounds.
public sealed partial class PartnerSummaryTab(PartnerViewModel page) : PartnerTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsClient), nameof(IsCarrier), nameof(IsSupplier), nameof(Kpis), nameof(ThisMonth), nameof(LastMonth),
        nameof(OccupiedHint), nameof(OrdersHint), nameof(StorageLead), nameof(StorageTotal), nameof(HasStorage), nameof(StorageEmpty),
        nameof(OrdersByStatus), nameof(OpenInbounds), nameof(LastShipped), nameof(ByClient), nameof(LastPickups), nameof(LastInbounds),
        nameof(StorageRows), nameof(YearText), nameof(OrdersLabel))]
    public partial PartnerSummary? Data { get; set; }

    public bool IsClient => Data?.Type == "client";
    public bool IsCarrier => Data?.Type == "carrier";
    public bool IsSupplier => Data?.Type == "supplier";
    public SummaryKpis? Kpis => Data?.Kpis;
    public string ThisMonth => PartnerFormat.Month(Data?.Period);
    public string LastMonth => PartnerFormat.Month(Data?.LastPeriod);
    public string YearText => Data?.Year?.ToString() ?? "";
    public string OrdersLabel => DateTime.TryParseExact($"{Data?.Period}-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
        ? $"Rendelés, {d.ToString("MMMM", Fmt.Hu)}" : "Rendelés ebben a hónapban";
    public string OccupiedHint => Data?.OccupiedBySize is { Count: > 0 } l ? string.Join(", ", l.Select((x) => $"{Fmt.Int(x.Locations)} {x.Code}")) : "nincs";
    public string OrdersHint => $"Előző hónap: {Fmt.Int(Kpis?.OrdersLastMonth ?? 0)}";
    public string StorageLead => Data?.StorageMonth is { } s
        ? $"A napi pillanatképek alapján ({Fmt.Int(s.DaysSnapshotted)} / {Fmt.Int(s.DaysInMonth)} nap), időarányos becslés." : "";
    public string StorageTotal => Data?.StorageMonth is { } s ? Fmt.Money(s.Total) : "";
    public bool HasStorage => Data?.StorageMonth is { BySize.Count: > 0 };
    public string StorageEmpty => Data?.StorageMonth is { DaysSnapshotted: > 0 }
        ? "Ebben a hónapban nem volt foglalt tárolóhelye." : "Ebben a hónapban még nincs napi tárolási pillanatkép.";

    public IReadOnlyList<OrdersByStatus> OrdersByStatus => Data?.OrdersByStatus ?? [];
    public IReadOnlyList<SummaryInbound> OpenInbounds => Data?.OpenInbounds ?? [];
    public IReadOnlyList<ShippedOrder> LastShipped => Data?.LastShipped ?? [];
    public IReadOnlyList<ClientOrders> ByClient => Data?.ByClient ?? [];
    public IReadOnlyList<SummaryPickup> LastPickups => Data?.LastPickups ?? [];
    public IReadOnlyList<SummaryInbound> LastInbounds => Data?.LastInbounds ?? [];
    public IReadOnlyList<StorageBySize> StorageRows => Data?.StorageMonth?.BySize ?? [];

    public override async Task LoadAsync() => Data = await Api.GetAsync<PartnerSummary>($"api/partners/{PartnerId}/summary");

    [RelayCommand]
    Task OpenOrderAsync(int id) => Shell.NavigateAsync(new Orders.OrderViewModel(Shell, id));

    [RelayCommand]
    Task OpenInboundAsync(int id) => Shell.NavigateAsync(new Inbound.InboundViewModel(Shell, id));

    [RelayCommand]
    Task OpenPartnerAsync(int id) => Shell.NavigateAsync(new PartnerViewModel(Shell, id, "summary"));
}
