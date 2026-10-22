using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Quotes;

// A quote in its own window: the form groups on the left (client, monthly volume, discounts,
// tariffs, own items, the company, terms), the live A4 paper on the right, and under the form the
// internal costing that is never printed. A new quote starts from the default tariffs, terms and
// costing; from a client it takes the client's data and tariffs. Saved, printed (or a PDF from
// the browser), copied, deleted. Closing the window with unsaved changes asks first.
public sealed partial class QuoteViewModel(ShellViewModel shell, int? id, int? partnerId = null) : PageViewModel(shell)
{
    static readonly (string Key, string Label)[] TariffGroupLabels =
        [("handling", "Rendeléskezelés"), ("inbound", "Betárolás és visszáru"), ("extra", "Extrák"), ("vat", "ÁFA")];

    public int? Id { get; private set; } = id;
    public override string Title => Number.Length > 0 ? $"Ajánlat {Number}" : "Új ajánlat";
    public override string? Module => "quotes";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => Id is { } i ? $"quote:{i}" : null;
    public override double RecordWidth => 1440;
    public override bool HasUnsavedChanges => Dirty;

    QuoteDefaults? defs;
    QuoteData data = new();
    bool loaded;
    bool quiet;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(RecordKey))]
    public partial string Number { get; set; } = "";

    [ObservableProperty] public partial bool Dirty { get; set; }
    [ObservableProperty] public partial string? CreatedByName { get; set; }
    [ObservableProperty] public partial string? TariffSource { get; set; }
    [ObservableProperty] public partial IReadOnlyList<OrderChoice> StatusChoices { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Status { get; set; }
    [ObservableProperty] public partial IReadOnlyList<OrderChoice> Clients { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPartner))]
    public partial OrderChoice? Partner { get; set; }

    [ObservableProperty] public partial DateTime? OfferDate { get; set; }
    [ObservableProperty] public partial string TermsText { get; set; } = "";
    [ObservableProperty] public partial PaperModel? Paper { get; set; }
    [ObservableProperty] public partial CostingModel? Costing { get; set; }
    [ObservableProperty] public partial string ClientText { get; set; } = "";

    [ObservableProperty] public partial IReadOnlyList<QuoteField> ClientFields { get; set; } = [];
    [ObservableProperty] public partial QuoteField? ValidDays { get; set; }
    [ObservableProperty] public partial IReadOnlyList<QuoteField> VolumeFields { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<QuoteField> DiscountFields { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<QuoteFieldGroup> TariffGroups { get; set; } = [];
    [ObservableProperty] public partial QuoteField? Signer { get; set; }
    [ObservableProperty] public partial IReadOnlyList<QuoteField> PlaceFields { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<QuoteRackRow> Racks { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<QuoteField> WorkFields { get; set; } = [];
    [ObservableProperty] public partial IReadOnlyList<QuoteField> MaterialFields { get; set; } = [];
    [ObservableProperty] public partial string CompanyName { get; set; } = "";
    [ObservableProperty] public partial IReadOnlyList<string> CompanyLines { get; set; } = [];
    [ObservableProperty] public partial string CompanyNote { get; set; } = "";

    public ObservableCollection<CustomItemRow> CustomItems { get; } = [];
    public bool NoCustomItems => CustomItems.Count == 0;
    public string CustomCount => CustomItems.Count > 0 ? $"({CustomItems.Count})" : "";

    bool Can(string action) => Shell.Me?.Can("quotes", action) == true;
    public bool CanSave => Id is null ? Can("create") : Can("edit");
    public bool ReadOnly => !CanSave;
    public bool CanDuplicate => Id is not null && Can("create");
    public bool CanDelete => Id is not null && Can("delete");
    public bool HasPartner => Partner?.Key is not null;
    public bool CanSeeSettings => Shell.Me?.Can("settings", "view") == true;

    // The company on the quote: the one saved with it once it left the drafts, otherwise today's.
    CompanySettings Company => Status?.Key != "draft" && data.Company is { Name.Length: > 0 } c ? c : defs?.Company ?? EmptyCompany;

    static readonly CompanySettings EmptyCompany = new(null, null, null, null, null, null, null, null, null, null, null, null, null);

    // Loaded once: the window keeps the edits when it comes to the front again or a dialog closes over it.
    public override async Task LoadAsync()
    {
        if (loaded) return;
        defs = await Api.GetAsync<QuoteDefaults>("api/quotes/defaults");
        var clients = (await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client")).Items
            .Select((p) => new OrderChoice(p.Id.ToString(), $"{p.Name} ({p.Code})")).ToList();
        quiet = true;
        StatusChoices = Shell.Meta.Statuses.GetValueOrDefault("quote")?.Select((s) => new OrderChoice(s.Key, s.Value.Label)).ToList()
            ?? [new("draft", "Piszkozat")];
        if (Id is { } i)
        {
            var q = await Api.GetAsync<QuoteDetail>($"api/quotes/{i}");
            // A saved client that is no longer in the active list still shows up.
            if (q.PartnerId is { } pid && clients.All((c) => c.Key != pid.ToString()))
                clients.Add(new(pid.ToString(), $"{q.PartnerName ?? "Ismeretlen ügyfél"} ({q.PartnerCode})"));
            Show(q);
            data = MergeSizes(q.Data);
            Clients = [new(null, "Új érdeklődő, nincs még partner"), .. clients];
            Partner = Clients.FirstOrDefault((c) => c.Key == q.PartnerId?.ToString()) ?? Clients[0];
        }
        else
        {
            data = NewData();
            Status = StatusChoices.FirstOrDefault((s) => s.Key == "draft") ?? StatusChoices[0];
            Clients = [new(null, "Új érdeklődő, nincs még partner"), .. clients];
            Partner = Clients[0];
            TariffSource = "a Beállítások alapértelmezett tarifái";
            if (partnerId is { } p && Clients.FirstOrDefault((c) => c.Key == p.ToString()) is { } client)
            {
                Partner = client;
                ApplyPartner(await Api.GetAsync<QuotePartner>($"api/quotes/partner/{p}"), client: true, tariffs: true);
            }
        }
        BuildForm();
        quiet = false;
        loaded = true;
        Recalc();
    }

    void Show(QuoteDetail q)
    {
        var was = quiet;
        quiet = true;
        Id = q.Id;
        Number = q.Number;
        CreatedByName = q.CreatedByName;
        Status = StatusChoices.FirstOrDefault((s) => s.Key == q.Status) ?? Status;
        quiet = was;
        OnPropertyChanged(nameof(RecordKey));
        OnPropertyChanged(nameof(CanSave));
        OnPropertyChanged(nameof(ReadOnly));
        OnPropertyChanged(nameof(CanDuplicate));
        OnPropertyChanged(nameof(CanDelete));
    }

    QuoteData NewData()
    {
        var d = defs!;
        return new QuoteData
        {
            OfferDate = QuoteFormat.Today,
            Storage = d.Sizes.Select((s) => new QuoteStorage { Code = s.Code, Name = s.Name, Dims = QuoteFormat.Dims(s), Price = d.Storage(s.Code) }).ToList(),
            Tariffs = d.Tariffs.ToDictionary((t) => t.Key, (t) => d.Tariff(t.Key)),
            Terms = [.. d.QuoteTerms],
            Signer = Shell.Me?.User.Name ?? "",
            Internal = QuoteInternal.From(d.Costing),
        };
    }

    // Saved quotes keep their sizes; sizes added since then appear with 0 locations.
    QuoteData MergeSizes(QuoteData q)
    {
        var d = defs!;
        foreach (var s in d.Sizes.Where((s) => q.Storage.All((x) => x.Code != s.Code)))
            q.Storage.Add(new QuoteStorage { Code = s.Code, Name = s.Name, Dims = QuoteFormat.Dims(s), Price = d.Storage(s.Code) });
        foreach (var t in d.Tariffs.Where((t) => !q.Tariffs.ContainsKey(t.Key))) q.Tariffs[t.Key] = 0;
        // Quotes saved before the costing get the settings' assumptions; the packaging price stays.
        if (!(q.Internal.WorkerHours > 0))
        {
            var pack = q.Internal.CostPack > 0 ? q.Internal.CostPack : d.Costing.PackCost;
            q.Internal = QuoteInternal.From(d.Costing);
            q.Internal.CostPack = pack;
        }
        return q;
    }

    // ------------------------------------------------------------------ the form

    void BuildForm()
    {
        var ro = ReadOnly;
        var d = data;
        var c = d.Client;
        Action ch = Changed;
        ClientFields =
        [
            QuoteField.Str("Ügyfél (cég) neve", c.Name, (v) => c.Name = v, ch, ro), QuoteField.Str("Kapcsolattartó", c.Contact, (v) => c.Contact = v, ch, ro),
            QuoteField.Str("E-mail", c.Email, (v) => c.Email = v, ch, ro), QuoteField.Str("Telefon", c.Phone, (v) => c.Phone = v, ch, ro),
            QuoteField.Str("Webshop", c.Shop, (v) => c.Shop = v, ch, ro), QuoteField.Str("Cím (nem kötelező)", c.Address, (v) => c.Address = v, ch, ro),
        ];
        ValidDays = QuoteField.Num("Érvényes (nap)", d.ValidDays, (v) => d.ValidDays = v, ch, ro);
        OfferDate = QuoteFormat.Date(d.OfferDate);
        var v = d.Volume;
        VolumeFields =
        [
            QuoteField.Num("Rendelés / hó", v.Orders, (x) => v.Orders = x, ch, ro),
            QuoteField.Num("Átl. termék / rendelés", v.Avg, (x) => v.Avg = x, ch, ro),
            QuoteField.Num("Betárolás / hó (db)", v.Inbound, (x) => v.Inbound = x, ch, ro),
            QuoteField.Num("Visszáru arány (%)", v.RetPct, (x) => v.RetPct = x, ch, ro),
            .. d.Storage.Select((s) => QuoteField.Num($"{s.Name} (db)", s.Qty, (x) => s.Qty = x, ch, ro, s.Dims, s.Code)),
            QuoteField.Num("Beköltözési készlet (db)", v.MoveIn, (x) => v.MoveIn = x, ch, ro),
            QuoteField.Num("Óradíjas munka (óra / hó)", v.Hours, (x) => v.Hours = x, ch, ro, "Szettképzés, átcímkézés."),
            QuoteField.Num("Utánvétes rendelés / hó", v.CodOrders, (x) => v.CodOrders = x, ch, ro),
            QuoteField.Num("Átlagos utánvét (Ft)", v.CodAvg, (x) => v.CodAvg = x, ch, ro),
        ];
        var disc = d.Discounts;
        DiscountFields =
        [
            QuoteField.Num("Kedvezmény a rendeléskezelésből (%)", d.Tariff("discount_handling_pct"), (x) => d.Tariffs["discount_handling_pct"] = x, ch, ro),
            QuoteField.Num("Kedvezmény a tárolásból (%)", d.Tariff("discount_storage_pct"), (x) => d.Tariffs["discount_storage_pct"] = x, ch, ro),
            QuoteField.Num("Ingyenes betárolás beköltözéskor (db, 0 = nincs)", disc.FreeMoveIn, (x) => disc.FreeMoveIn = x, ch, ro),
            QuoteField.Num("Ingyenes tárolás (első hónapok száma)", disc.FreeStorageMonths, (x) => disc.FreeStorageMonths = x, ch, ro),
            QuoteField.Num("Árgarancia (hónap, 0 = nincs)", disc.PriceLockMonths, (x) => disc.PriceLockMonths = x, ch, ro),
        ];
        BuildTariffs();
        BuildItems();
        Signer = QuoteField.Str("Aláíró neve, beosztása", d.Signer, (x) => d.Signer = x, ch, ro);
        TermsText = string.Join("\n", d.Terms);
        BuildCosting();
        ShowCompany();
    }

    void BuildTariffs()
    {
        var d = data;
        var ro = ReadOnly;
        var tariffs = defs!.Tariffs.Where((t) => t.Group != "discount").ToList();
        TariffGroups =
        [
            .. TariffGroupLabels.Where((g) => tariffs.Any((t) => t.Group == g.Key)).Select((g) => new QuoteFieldGroup(g.Label, tariffs.Where((t) => t.Group == g.Key)
                .Select((t) => QuoteField.Num($"{t.Label} ({t.Unit})", d.Tariff(t.Key), (x) => d.Tariffs[t.Key] = x, Changed, ro)).ToList())),
            new("Tárolás", d.Storage.Select((s) => QuoteField.Num($"{s.Name} (Ft / hely / hó)", s.Price, (x) => s.Price = x, Changed, ro, null, s.Code)).ToList()),
        ];
    }

    void BuildItems()
    {
        CustomItems.Clear();
        var i = 0;
        foreach (var it in data.CustomItems) CustomItems.Add(new CustomItemRow(it, ++i, Changed, Remove, ReadOnly));
        OnPropertyChanged(nameof(NoCustomItems));
        OnPropertyChanged(nameof(CustomCount));
    }

    void BuildCosting()
    {
        var i = data.Internal;
        var ro = ReadOnly;
        Action ch = Recalc;
        Action changed = Changed;
        PlaceFields =
        [
            QuoteField.Num("Havi raktárbérleti díj (Ft)", i.Rent, (x) => i.Rent = x, changed, ro),
            QuoteField.Num("Bérelt alapterület (m²)", i.AreaM2, (x) => i.AreaM2 = x, changed, ro),
        ];
        Racks = data.Storage.Select((s) =>
        {
            RackSetting R() => i.Racks.GetValueOrDefault(s.Code) ?? new RackSetting(0, 0, 0);
            return new QuoteRackRow(s.Code, s.Name.Length > 0 ? s.Name : s.Code,
            [
                QuoteField.Num("Állvány + folyosó (m²)", R().Area, (x) => i.Racks[s.Code] = R() with { Area = x }, changed, ro),
                QuoteField.Num("Szintek", R().Levels, (x) => i.Racks[s.Code] = R() with { Levels = x }, changed, ro),
                QuoteField.Num("Hely / szint", R().PerLevel, (x) => i.Racks[s.Code] = R() with { PerLevel = x }, changed, ro),
            ]);
        }).ToList();
        WorkFields =
        [
            QuoteField.Num("Egy raktáros havi költsége (Ft)", i.WorkerCost, (x) => i.WorkerCost = x, changed, ro, "bér és járulékok"),
            QuoteField.Num("Hasznos munkaóra / fő / hó", i.WorkerHours, (x) => i.WorkerHours = x, changed, ro),
            QuoteField.Num("Rendelés (perc)", i.MinOrder, (x) => i.MinOrder = x, changed, ro, "kiszedés, csomagolás"),
            QuoteField.Num("További termék (perc)", i.MinItem, (x) => i.MinItem = x, changed, ro, "termékenként"),
            QuoteField.Num("Betárolás (perc / db)", i.MinInbound, (x) => i.MinInbound = x, changed, ro),
            QuoteField.Num("Visszáru (perc / csomag)", i.MinReturn, (x) => i.MinReturn = x, changed, ro),
        ];
        MaterialFields = [QuoteField.Num("Csomagolóanyag beszerzés / rendelés (Ft)", i.CostPack, (x) => i.CostPack = x, changed, ro)];
    }

    void ShowCompany()
    {
        var c = Company;
        CompanyName = string.IsNullOrEmpty(c.Name) ? "Fully Logistics" : c.Name;
        CompanyLines = [.. QuoteFormat.CompanyLines(c, ", "), .. string.IsNullOrEmpty(c.BankAccount) ? Array.Empty<string>() : [$"Bankszámla: {c.BankAccount}"]];
        CompanyNote = Status?.Key != "draft" && data.Company is { Name.Length: > 0 }
            ? "Az ajánlat a mentéskori cégadatokat mutatja." : "A cégadatokat a Beállítások > Cégadatok fülön szerkesztheted.";
    }

    // ------------------------------------------------------------------ changes

    void Changed()
    {
        if (quiet) return;
        Dirty = true;
        Recalc();
    }

    void Recalc()
    {
        if (!loaded || defs is null) return;
        var r = QuoteCalc.Calc(data);
        Paper = PaperModel.Build(data, r, Company, Number);
        Costing = CostingModel.Build(data, r, QuoteCalc.Costing(data, r));
        ClientText = data.Client.Name.Length > 0 ? data.Client.Name : "Ügyfél még nincs megadva";
    }

    partial void OnStatusChanged(OrderChoice? value)
    {
        if (quiet || value is null) return;
        ShowCompany();
        Changed();
    }

    partial void OnOfferDateChanged(DateTime? value)
    {
        if (quiet) return;
        data.OfferDate = value?.ToString("yyyy-MM-dd");
        Changed();
    }

    partial void OnTermsTextChanged(string value)
    {
        if (quiet) return;
        data.Terms = value.Split('\n').Select((x) => x.TrimEnd('\r')).ToList();
        Changed();
    }

    partial void OnPartnerChanged(OrderChoice? value)
    {
        if (quiet) return;
        Changed();
        // A client chosen for a quote without a client name brings its data.
        if (value?.Key is not null && data.Client.Name.Length == 0) _ = LoadClientAsync();
    }

    void Remove(CustomItemRow row)
    {
        data.CustomItems.Remove(row.Item);
        BuildItems();
        Changed();
    }

    // Rebuilds the form after a change from outside it (a client loaded, defaults).
    void Refill()
    {
        quiet = true;
        BuildForm();
        quiet = false;
        Dirty = true;
        Recalc();
    }

    void ApplyPartner(QuotePartner res, bool client, bool tariffs)
    {
        var d = data;
        if (client)
        {
            var c = res.Contact;
            d.Client.Name = c.Name;
            d.Client.Contact = c.ContactName ?? "";
            d.Client.Email = c.ContactEmail is { Length: > 0 } e ? e : c.BillingEmail ?? "";
            d.Client.Phone = c.ContactPhone ?? "";
            d.Client.Shop = QuoteFormat.StripScheme(c.Website);
            d.Client.Address = c.Address ?? "";
        }
        if (tariffs)
        {
            foreach (var (k, v) in res.Tariffs) d.Tariffs[k] = v;
            foreach (var s in res.Storage)
            {
                if (d.Storage.FirstOrDefault((x) => x.Code == s.Code) is { } row) row.Price = s.Price;
                else d.Storage.Add(new QuoteStorage { Code = s.Code, Name = s.Name, Price = s.Price });
            }
            foreach (var ci in res.CustomItems)
            {
                if (d.CustomItems.FirstOrDefault((x) => string.Equals(x.Name.Trim(), ci.Name.Trim(), StringComparison.OrdinalIgnoreCase)) is { } row)
                {
                    row.Unit = ci.Unit;
                    row.Kind = ci.Kind;
                    row.Price = ci.Price;
                }
                else d.CustomItems.Add(new QuoteCustomItem { Name = ci.Name, Unit = ci.Unit, Kind = ci.Kind, Price = ci.Price, Qty = ci.Kind == "monthly" ? 1 : 0 });
            }
            TariffSource = $"{res.Partner.Name} egyedi tarifái";
        }
    }

    // ------------------------------------------------------------------ commands

    [RelayCommand]
    Task LoadClientAsync() => LoadPartnerAsync(client: true);

    [RelayCommand]
    Task LoadTariffsAsync() => LoadPartnerAsync(client: false);

    Task LoadPartnerAsync(bool client) => RunAsync(async () =>
    {
        if (Partner?.Key is not { } pid)
        {
            Shell.Toast("Előbb válassz ügyfelet.");
            return;
        }
        ApplyPartner(await Api.GetAsync<QuotePartner>($"api/quotes/partner/{pid}"), client, !client);
        Refill();
        Shell.Toast(client ? "Ügyféladatok betöltve." : "A partner tarifái betöltve.", ToastKind.Success);
    });

    [RelayCommand]
    void DefaultTariffs()
    {
        foreach (var t in defs!.Tariffs) data.Tariffs[t.Key] = defs.Tariff(t.Key);
        foreach (var s in data.Storage) s.Price = defs.Storage(s.Code);
        TariffSource = "a Beállítások alapértelmezett tarifái";
        Refill();
        Shell.Toast("Alapértelmezett tarifák betöltve.", ToastKind.Success);
    }

    [RelayCommand]
    void DefaultCosting()
    {
        data.Internal = QuoteInternal.From(defs!.Costing);
        Refill();
        Shell.Toast("A Beállítások költségkalkulációs értékei betöltve.", ToastKind.Success);
    }

    [RelayCommand]
    void DefaultTerms()
    {
        data.Terms = [.. defs!.QuoteTerms];
        Refill();
    }

    [RelayCommand]
    void AddItem()
    {
        data.CustomItems.Add(new QuoteCustomItem());
        BuildItems();
        Changed();
    }

    // Saves (new: gets its number); true when saved.
    [RelayCommand]
    public Task<bool> SaveAsync() => !CanSave ? Task.FromResult(false) : RunAsync(async () =>
    {
        data.Company = Company;
        var body = new Dictionary<string, object?>
        {
            ["partner_id"] = Partner?.Key is { } p ? int.Parse(p) : null, ["client_name"] = data.Client.Name, ["status"] = Status?.Key ?? "draft", ["data"] = data,
        };
        var wasNew = Id is null;
        var res = Id is { } i ? await Api.PatchAsync<QuoteDetail>($"api/quotes/{i}", body) : await Api.PostAsync<QuoteDetail>("api/quotes", body);
        Show(res);
        Dirty = false;
        Recalc();
        Shell.Toast(wasNew ? $"Ajánlat mentve: {res.Number}." : "Ajánlat mentve.", ToastKind.Success);
    });

    // The paper as a page to print or save as PDF; unsaved changes are saved first.
    [RelayCommand]
    async Task PrintAsync()
    {
        if ((Dirty || Id is null) && CanSave && !await SaveAsync()) return;
        if (Paper is not { } paper) return;
        await RunAsync(() => Shell.Services.Platform.OpenFileAsync(paper.Html($"arajanlat-{(Number.Length > 0 ? Number : "uj")}.html")));
    }

    [RelayCommand]
    async Task DuplicateAsync()
    {
        if (Id is not { } i) return;
        if (Dirty && CanSave && !await SaveAsync()) return;
        await RunAsync(async () =>
        {
            var res = await Api.PostAsync<QuoteDetail>($"api/quotes/{i}/duplicate");
            Shell.Toast($"Másolat elkészült: {res.Number}.", ToastKind.Success);
            await Shell.NavigateAsync(new QuoteViewModel(Shell, res.Id));
        });
    }

    [RelayCommand]
    async Task DeleteAsync()
    {
        if (Id is not { } i) return;
        if (!await Shell.ConfirmAsync("Ajánlat törlése", $"Biztosan törlöd: {Number}? Ez nem vonható vissza.", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/quotes/{i}");
            Dirty = false;
            Shell.Toast("Ajánlat törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }

    [RelayCommand]
    Task OpenSettingsAsync() => Shell.OpenModuleAsync("settings");
}
