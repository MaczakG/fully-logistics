using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Billing;

// A line added by hand to a draft: name, group, quantity, unit, net unit price (negative: credit).
public sealed partial class ManualLineViewModel(ShellViewModel shell, int statementId, IEnumerable<BillingGroup> groups) : PartnerForm(shell)
{
    public override string Title => "Kézi tétel hozzáadása";
    public override string? Module => "billing";
    public IReadOnlyList<OrderChoice> Groups { get; } = groups.Select((g) => new OrderChoice(g.Key, g.Label)).ToList();

    [ObservableProperty] public partial string Name { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? Group { get; set; }
    [ObservableProperty] public partial string Qty { get; set; } = "1";
    [ObservableProperty] public partial string Unit { get; set; } = "db";
    [ObservableProperty] public partial string Price { get; set; } = "";

    public override Task LoadAsync()
    {
        Group ??= Groups.FirstOrDefault((g) => g.Key == "custom") ?? Groups.FirstOrDefault();
        return Task.CompletedTask;
    }

    [RelayCommand]
    Task SaveAsync()
    {
        object? Num(string t) => t.Trim().Length == 0 ? null : Fmt.ParseNumber(t) is { } n ? n : t;
        return SubmitAsync(async () =>
        {
            await Api.PostAsync<LineAdded>($"api/billing/statements/{statementId}/lines", new Dictionary<string, object?>
            {
                ["name"] = Name.Trim(), ["group"] = Group?.Key, ["qty"] = Num(Qty), ["unit"] = Unit.Trim(), ["price"] = Num(Price),
            });
            Shell.Toast("Tétel hozzáadva.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

// Voiding an approved or invoiced statement: the reason, and for an invoice that it was cancelled
// in the invoicing service.
public sealed partial class VoidViewModel(ShellViewModel shell, Statement statement) : PartnerForm(shell)
{
    public Statement Statement { get; } = statement;
    public override string Title => "Elszámolás érvénytelenítése";
    public override string? Module => "billing";
    public bool WasInvoiced => Statement.Status == "invoiced";
    public string InvoiceNote => WasInvoiced
        ? $"Ehhez az elszámoláshoz már készült számla ({Statement.InvoiceNumber}). Az érvénytelenítés nem sztornózza a számlát: előbb sztornózd a {(Statement.InvoiceProvider == "billingo" ? "Billingóban" : "Számlázz.hu-ban")}."
        : "";
    public string CancelledLabel => $"A(z) {Statement.InvoiceNumber} számlát sztornóztam";

    [ObservableProperty] public partial string Reason { get; set; } = "";
    [ObservableProperty] public partial bool InvoiceCancelled { get; set; }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        await Api.PostAsync($"api/billing/statements/{Statement.Id}/void", new { reason = Reason.Trim(), invoice_cancelled = InvoiceCancelled });
        Shell.Toast("Elszámolás érvénytelenítve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// A recorded item: client, day, hourly work or one of the client's per unit items, quantity, note.
public sealed partial class EntryFormViewModel : PartnerForm
{
    public static readonly IReadOnlyList<OrderChoice> Kinds = [new("hourly_work", "Óradíjas munka"), new("custom", "Egyedi tétel (darabonként)")];

    public EntryFormViewModel(ShellViewModel shell, IReadOnlyList<OrderChoice> clients, BillingEntry? entry, int? partnerId) : base(shell)
    {
        Entry = entry;
        Clients = clients;
        quiet = true;
        Client = clients.FirstOrDefault((c) => c.Key == (entry?.PartnerId ?? partnerId)?.ToString());
        Date = Quotes.QuoteFormat.Date(entry?.Date) ?? DateTime.Today;
        Kind = Kinds.FirstOrDefault((k) => k.Key == entry?.Kind) ?? Kinds[0];
        Qty = entry is null ? "" : Fmt.Num(entry.Qty, 2).Replace(" ", "");
        Note = entry?.Note ?? "";
        quiet = false;
    }

    public BillingEntry? Entry { get; }
    public bool IsNew => Entry is null;
    public override string Title => IsNew ? "Új tétel" : "Tétel módosítása";
    public override string? Module => "billing";
    public string SubmitText => IsNew ? "Rögzítés" : "Mentés";
    public IReadOnlyList<OrderChoice> Clients { get; }

    [ObservableProperty] public partial OrderChoice? Client { get; set; }
    [ObservableProperty] public partial DateTime? Date { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsCustom))]
    public partial OrderChoice Kind { get; set; }

    [ObservableProperty] public partial IReadOnlyList<OrderChoice> Items { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? Item { get; set; }
    [ObservableProperty] public partial string? ItemsNote { get; set; }
    [ObservableProperty] public partial string Qty { get; set; }
    [ObservableProperty] public partial string Note { get; set; }

    public bool IsCustom => Kind.Key == "custom";
    readonly bool quiet;

    protected override string? ErrorKey(string property) => property switch
    {
        nameof(Client) => "partner_id",
        nameof(Item) => "custom_item_id",
        _ => base.ErrorKey(property),
    };

    public override Task LoadAsync() => LoadItemsAsync();

    partial void OnClientChanged(OrderChoice? value)
    {
        if (!quiet) _ = RunAsync(LoadItemsAsync);
    }

    partial void OnKindChanged(OrderChoice value)
    {
        if (!quiet) _ = RunAsync(LoadItemsAsync);
    }

    // The client's per unit items that are active.
    async Task LoadItemsAsync()
    {
        if (!IsCustom) return;
        if (Client?.Key is not { } pid)
        {
            Items = [];
            ItemsNote = "Előbb válassz ügyfelet.";
            return;
        }
        var res = await Api.GetAsync<ItemList<BillingCustomItem>>($"api/billing/custom-items?partner_id={pid}");
        Items = res.Items.Where((i) => i.Kind == "per_unit" && i.Active)
            .Select((i) => new OrderChoice(i.Id.ToString(), $"{i.Name} ({BillingFormat.Money(i.Price)} / {i.Unit})")).ToList();
        Item = Items.FirstOrDefault((i) => i.Key == Entry?.CustomItemId?.ToString()) ?? (Items.Count == 1 ? Items[0] : null);
        ItemsNote = Items.Count == 0 ? "Ennek az ügyfélnek nincs darabonként számlázott egyedi tétele." : null;
    }

    [RelayCommand]
    Task SaveAsync()
    {
        object? Num(string t) => t.Trim().Length == 0 ? null : Fmt.ParseNumber(t) is { } n ? n : t;
        return SubmitAsync(async () =>
        {
            var body = new Dictionary<string, object?>
            {
                ["date"] = Date?.ToString("yyyy-MM-dd"), ["kind"] = Kind.Key, ["custom_item_id"] = IsCustom && Item?.Key is { } i ? int.Parse(i) : null,
                ["qty"] = Num(Qty), ["note"] = Note.Trim(),
            };
            if (Entry is { } e)
            {
                await Api.PatchAsync<object>($"api/billing/entries/{e.Id}", body);
                Shell.Toast("Tétel mentve.", ToastKind.Success);
            }
            else
            {
                body["partner_id"] = Client?.Key is { } p ? int.Parse(p) : null;
                await Api.PostAsync<NewId>("api/billing/entries", body);
                Shell.Toast("Tétel rögzítve.", ToastKind.Success);
            }
            await Shell.BackAsync();
        });
    }
}
