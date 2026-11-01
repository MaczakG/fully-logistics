using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Billing;

// Elszámolás: the month's statements per client (made, recalculated, approved, invoiced), and the
// hourly work and per unit items recorded for the clients. One month at a time, the previous one
// by default; a statement opens in its own window.
public sealed partial class BillingViewModel : PageViewModel
{
    public BillingViewModel(ShellViewModel shell, string? tab = null) : base(shell)
    {
        Overview = new(this);
        Entries = new(this);
        Tabs = [new("statements", "Havi elszámolások"), new("entries", "Egyedi tételek és munkaórák")];
        SelectedKey = tab ?? "statements";
        foreach (var t in Tabs) t.IsSelected = t.Key == SelectedKey;
        Periods = BillingFormat.Periods(BillingFormat.DefaultPeriod);
        period = Periods.First((p) => p.Key == BillingFormat.DefaultPeriod);
    }

    public override string Title => "Elszámolás";
    public override string? Module => "billing";

    public OverviewTab Overview { get; }
    public EntriesTab Entries { get; }
    public IReadOnlyList<PartnerTabChip> Tabs { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsStatements), nameof(IsEntries), nameof(Lead))]
    public partial string SelectedKey { get; set; }

    public bool IsStatements => SelectedKey == "statements";
    public bool IsEntries => SelectedKey == "entries";
    public string Lead => IsStatements
        ? "Havi elszámolás ügyfelenként: rendeléskezelés a feladott rendelésekből, tárolás a napi pillanatképekből, áruátvétel, visszáru és a rögzített tételek."
        : "Óradíjas munka (szettképzés, átcímkézés) és darabonként számlázott egyedi tételek ügyfelenként és naponta. A havi elszámolás ezekből számol.";

    public List<OrderChoice> Periods { get; private set; }

    OrderChoice period;

    public OrderChoice Period
    {
        get => period;
        set
        {
            if (value is null || value.Key == period.Key) return;
            period = value;
            OnPropertyChanged();
            OnPropertyChanged(nameof(CanNext));
            OnPropertyChanged(nameof(PeriodLabel));
            _ = ReloadAsync();
        }
    }

    public string PeriodKey => Period.Key!;
    public string PeriodLabel => BillingFormat.Label(PeriodKey);
    public bool CanNext => string.CompareOrdinal(PeriodKey, BillingFormat.ThisMonth) < 0;

    internal bool Can(string action) => Shell.Me?.Can("billing", action) == true;
    internal ApiClient ApiClient => Api;
    internal new Task<bool> RunAsync(Func<Task> action) => base.RunAsync(action);

    public override Task LoadAsync() => IsStatements ? Overview.LoadAsync() : Entries.LoadAsync();

    [RelayCommand]
    Task SelectTabAsync(PartnerTabChip tab)
    {
        SelectedKey = tab.Key;
        foreach (var t in Tabs) t.IsSelected = t == tab;
        return ReloadAsync();
    }

    [RelayCommand]
    void Prev() => Go(BillingFormat.Shift(PeriodKey, -1));

    [RelayCommand]
    void Next()
    {
        if (CanNext) Go(BillingFormat.Shift(PeriodKey, 1));
    }

    internal void Go(string p)
    {
        if (Periods.All((x) => x.Key != p))
        {
            Periods = BillingFormat.Periods(p);
            OnPropertyChanged(nameof(Periods));
        }
        Period = Periods.First((x) => x.Key == p);
    }
}

// Havi elszámolások: per client the statement of the month, the month's figures, the coverage of
// the daily storage snapshots; drafts made or recalculated for every client or the selected ones.
public sealed partial class OverviewTab(BillingViewModel page) : ObservableObject
{
    public BillingViewModel Page { get; } = page;
    ShellViewModel Shell => Page.Shell;
    ApiClient Api => Page.ApiClient;

    [ObservableProperty] public partial BillingOverview? Data { get; set; }
    public ObservableCollection<OverviewItem> Items { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(GenerateText))]
    public partial int SelectedCount { get; set; }

    public bool CanCreate => Page.Can("create");
    public string GenerateText => SelectedCount > 0 ? $"Elszámolások készítése ({Fmt.Int(SelectedCount)} kijelölt)" : "Elszámolások készítése";
    public bool IsEmpty => Data is { Items.Count: 0 };

    public string? InvoicingWarning => Data?.Invoicing is { } inv ? InvoicingText(inv, Shell) : null;
    public bool InvoicingError => Data?.Invoicing.Error is { Length: > 0 };
    public string? SnapshotWarning => Data?.Snapshots is { Missing.Count: > 0 } s
        ? $"A tárolási díj a napi pillanatképekből számolódik. {BillingFormat.Label(Data.Period)} {Fmt.Int(s.Expected)} napjából {Fmt.Int(s.Missing.Count)} napra nincs pillanatkép, ezekre nem számolunk tárolást: {string.Join(", ", s.Missing.Take(10).Select(Fmt.Date))}{(s.Missing.Count > 10 ? " ..." : "")}"
        : null;
    public string SnapshotInfo => Data?.Snapshots.Last is { } l ? $"Utolsó pillanatkép: {Fmt.Date(l.Date)}, {Fmt.Int(l.Rows)} raktárhely" : "Még nincs tárolási pillanatkép.";

    public string TotalNet => Fmt.Money(Data?.Kpis.TotalNet ?? 0);
    public string TotalHint => $"{Page.PeriodLabel}, érvénytelenítettek nélkül";
    public string InvoicedNet => Fmt.Money(Data?.Kpis.InvoicedNet ?? 0);
    public string InvoicedHint => $"{Fmt.Int(Data?.Kpis.InvoicedCount ?? 0)} ügyfél";
    public bool InvoicedOk => Data?.Kpis.InvoicedCount > 0;
    public string DraftCount => Fmt.Int(Data?.Kpis.DraftCount ?? 0);
    public string DraftNet => Fmt.Money(Data?.Kpis.DraftNet ?? 0);
    public bool DraftWarn => Data?.Kpis.DraftCount > 0;
    public string ApprovedCount => Fmt.Int(Data?.Kpis.ApprovedCount ?? 0);
    public string ApprovedNet => Fmt.Money(Data?.Kpis.ApprovedNet ?? 0);
    public string MissingCount => Fmt.Int(Data?.Kpis.MissingCount ?? 0);
    public string SumGross => Fmt.Money(Data?.Items.Where((x) => x.Status is "draft" or "approved" or "invoiced").Sum((x) => x.Gross ?? 0) ?? 0);

    // The invoicing service is missing or broken: no invoices from the approved statements.
    internal static string? InvoicingText(InvoicingStatus inv, ShellViewModel shell)
    {
        if (inv.Error is { Length: > 0 } e) return e;
        if (inv.Configured) return null;
        var what = inv.Provider.Length > 0 ? $"A(z) {inv.Name} beállításai hiányosak" : "Még nincs beállítva számlázó";
        return $"{what}, ezért a jóváhagyott elszámolásokról nem tudsz számlát kiállítani. "
            + (shell.Me?.Can("settings", "view") == true ? "Beállítása: Beállítások > Számlázó." : "Kérd meg az adminisztrátort, hogy állítsa be (Beállítások > Számlázó).");
    }

    public async Task LoadAsync()
    {
        var d = await Api.GetAsync<BillingOverview>(Query.Build("api/billing/overview", ("period", Page.PeriodKey)));
        Data = d;
        Items.Clear();
        foreach (var x in d.Items) Items.Add(new OverviewItem(this, x));
        SelectedCount = 0;
        foreach (var name in new[]
        {
            nameof(IsEmpty), nameof(InvoicingWarning), nameof(InvoicingError), nameof(SnapshotWarning), nameof(SnapshotInfo), nameof(TotalNet), nameof(TotalHint),
            nameof(InvoicedNet), nameof(InvoicedHint), nameof(InvoicedOk), nameof(DraftCount), nameof(DraftNet), nameof(DraftWarn), nameof(ApprovedCount),
            nameof(ApprovedNet), nameof(MissingCount), nameof(SumGross),
        }) OnPropertyChanged(name);
    }

    internal void Selected() => SelectedCount = Items.Count((i) => i.IsSelected);

    internal Task OpenAsync(OverviewRow r) => r.StatementId is { } id ? Shell.NavigateAsync(new StatementViewModel(Shell, id)) : Task.CompletedTask;

    [RelayCommand]
    Task ExportAsync() => Page.RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(Query.Build("api/billing/overview/export", ("period", Page.PeriodKey)))));

    [RelayCommand]
    async Task SnapshotAsync()
    {
        if (!await Shell.ConfirmAsync("Pillanatkép rögzítése most",
            "Rögzítjük a mai napra, melyik raktárhelyen kinek az áruja van. Ma 23:00 után a rendszer magától is rögzíti a napi záró állapotot, ami ezt felülírja.",
            "Rögzítés")) return;
        await Page.RunAsync(async () =>
        {
            var r = await Api.PostAsync<SnapshotTaken>("api/billing/snapshot");
            Shell.Toast($"Pillanatkép rögzítve ({Fmt.Date(r.Date)}): {Fmt.Int(r.Rows)} raktárhely.", ToastKind.Success);
            await LoadAsync();
        });
    }

    // Drafts for every client with something to bill, or for the selected ones; the drafts'
    // computed lines are refreshed, their manual lines stay, approved and invoiced ones are left.
    [RelayCommand]
    async Task GenerateAsync()
    {
        var chosen = Items.Where((i) => i.IsSelected).ToList();
        var label = Page.PeriodLabel;
        var text = chosen.Count > 0
            ? $"A kijelölt {Fmt.Int(chosen.Count)} ügyfélnek ({string.Join(", ", chosen.Select((c) => c.Row.Name))}) elkészítjük vagy újraszámoljuk a {label} elszámolását."
            : $"Minden ügyfélnek elkészítjük vagy újraszámoljuk a {label} elszámolását, akinek volt számlázható tétele.";
        text += "\n\nA piszkozatok számított tételei frissülnek, a kézzel hozzáadott tételek megmaradnak. Jóváhagyott és számlázott elszámolásokhoz nem nyúlunk."
            + (chosen.Count > 0 ? " Kijelölt érvénytelenített elszámolás újra piszkozat lesz." : "");
        if (!await Shell.ConfirmAsync("Elszámolások készítése", text, "Elszámolások készítése")) return;
        await Page.RunAsync(async () =>
        {
            var body = new Dictionary<string, object?> { ["period"] = Page.PeriodKey };
            if (chosen.Count > 0) body["partner_ids"] = chosen.Select((c) => c.Row.PartnerId).ToList();
            var res = await Api.PostAsync<GenerateResult>("api/billing/statements/generate", body);
            Shell.Toast($"Kész: {Fmt.Int(res.Created)} új, {Fmt.Int(res.Updated)} újraszámolt elszámolás.", ToastKind.Success);
            await LoadAsync();
            var skipped = res.Skipped.Where((s) => !s.Reason.StartsWith("Nincs számlázható", StringComparison.Ordinal)).ToList();
            if (skipped.Count > 0)
                await Shell.ConfirmAsync("Kimaradt ügyfelek", string.Join("\n", skipped.Select((s) => $"{s.Name}: {s.Reason}")), "Rendben", "Bezárás");
        });
    }
}

public sealed partial class OverviewItem(OverviewTab tab, OverviewRow r) : ObservableObject
{
    public OverviewRow Row { get; } = r;
    public bool HasStatement => Row.StatementId is not null;
    public bool IsNone => Row.Status == "none";
    public string Sub => Row.PartnerStatus == "inactive" ? $"{Row.Code} · inaktív" : Row.Code;
    public string NetText => HasStatement ? Fmt.Money(Row.Net ?? 0) : "";
    public string GrossText => HasStatement ? Fmt.Money(Row.Gross ?? 0) : "";
    public bool HasInvoiceError => string.IsNullOrEmpty(Row.InvoiceNumber) && !string.IsNullOrEmpty(Row.InvoiceError);
    public bool CanSelect => tab.CanCreate;

    [ObservableProperty]
    public partial bool IsSelected { get; set; }

    partial void OnIsSelectedChanged(bool value) => tab.Selected();

    public RelayCommand OpenCommand => new(() => _ = tab.OpenAsync(Row));
}

// Egyedi tételek és munkaórák: what was recorded for the clients in the month; a month whose
// statement is approved or invoiced is locked.
public sealed partial class EntriesTab(BillingViewModel page) : ObservableObject
{
    const int PageSize = 100;

    public BillingViewModel Page { get; } = page;
    ShellViewModel Shell => Page.Shell;
    ApiClient Api => Page.ApiClient;

    public ObservableCollection<EntryItem> Items { get; } = [];
    [ObservableProperty] public partial List<OrderChoice> Clients { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Client { get; set; }
    [ObservableProperty] public partial int Total { get; set; }
    [ObservableProperty] public partial bool HasMore { get; set; }

    public bool CanCreate => Page.Can("create");
    public bool IsEmpty => Total == 0;
    public string TotalText => $"{Fmt.Int(Total)} tétel";
    internal List<OrderChoice> ClientList { get; private set; } = [];
    bool quiet;

    partial void OnClientChanged(OrderChoice? value)
    {
        if (!quiet) _ = Page.RunAsync(() => LoadPageAsync(0));
    }

    public async Task LoadAsync()
    {
        if (ClientList.Count == 0)
        {
            var clients = await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
            ClientList = clients.Items.Select((c) => new OrderChoice(c.Id.ToString(), $"{c.Name} ({c.Code})")).ToList();
            quiet = true;
            Clients = [new(null, "Minden ügyfél"), .. ClientList];
            Client = Clients[0];
            quiet = false;
        }
        await LoadPageAsync(0);
    }

    async Task LoadPageAsync(int offset)
    {
        var d = await Api.GetAsync<BillingEntries>(Query.Build("api/billing/entries", ("period", Page.PeriodKey), ("partner_id", Client?.Key),
            ("limit", PageSize), ("offset", offset)));
        if (offset == 0) Items.Clear();
        foreach (var e in d.Items) Items.Add(new EntryItem(this, e));
        Total = d.Total;
        HasMore = Items.Count < Total;
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(TotalText));
    }

    [RelayCommand]
    Task MoreAsync() => Page.RunAsync(() => LoadPageAsync(Items.Count));

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new EntryFormViewModel(Shell, ClientList, null, Client?.Key is { } c ? int.Parse(c) : null));

    internal Task EditAsync(BillingEntry e) => Shell.NavigateAsync(new EntryFormViewModel(Shell, ClientList, e, null));

    internal async Task DeleteAsync(BillingEntry e)
    {
        if (!await Shell.ConfirmAsync("Tétel törlése", $"Törlöd: {e.PartnerName}, {Fmt.Date(e.Date)}, {BillingFormat.Qty(e.Qty, e.Unit)}?", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/billing/entries/{e.Id}");
            Shell.Toast("Tétel törölve.", ToastKind.Success);
            await LoadPageAsync(0);
        });
    }
}

public sealed class EntryItem(EntriesTab tab, BillingEntry e)
{
    public BillingEntry Entry { get; } = e;
    public string DateText => Fmt.Date(Entry.Date);
    public string ItemText => BillingFormat.KindText(Entry.Kind, Entry.ItemName);
    public bool HasNote => !string.IsNullOrEmpty(Entry.Note);
    public string QtyText => BillingFormat.Qty(Entry.Qty, Entry.Unit);
    public string PriceText => BillingFormat.Money(Entry.Price);
    public string AmountText => BillingFormat.Money(Entry.Amount);
    public string CreatedText => Fmt.DateTime(Entry.CreatedAt);
    public bool Locked => Entry.Locked;
    public string LockedTip => $"A(z) {Entry.StatementNumber} elszámolás már {(Entry.StatementStatus == "invoiced" ? "számlázva" : "jóváhagyva")}";
    public bool CanEdit => !Locked && tab.Page.Can("edit");
    public bool CanDelete => !Locked && tab.Page.Can("delete");
    public CommunityToolkit.Mvvm.Input.RelayCommand EditCommand => new(() => _ = tab.EditAsync(Entry));
    public CommunityToolkit.Mvvm.Input.RelayCommand DeleteCommand => new(() => _ = tab.DeleteAsync(Entry));
}
