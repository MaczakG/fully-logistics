using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Inbound;

// New inbound (POST /api/inbound) or edit of an expected / arrived one (PUT /api/inbound/:id):
// client, supplier, expected date, delivery note reference, pallets, cartons, note, and the lines
// (product of the client, expected quantity, lot, expiry).
public sealed partial class InboundFormViewModel : PageViewModel
{
    readonly InboundDetail? existing;

    public InboundFormViewModel(ShellViewModel shell, InboundDetail? existing) : base(shell)
    {
        this.existing = existing;
        ExpectedDate = existing is null ? DateTime.Today : existing.ExpectedDate is { Length: 10 } d ? DateTime.ParseExact(d, "yyyy-MM-dd", null) : null;
        ExternalRef = existing?.ExternalRef ?? "";
        Pallets = (existing?.Pallets ?? 0).ToString();
        Cartons = (existing?.Cartons ?? 0).ToString();
        Note = existing?.Note ?? "";
        if (existing is null) Lines.Add(new InboundFormLine(this));
        else
            foreach (var l in existing.Lines)
                Lines.Add(new InboundFormLine(this)
                {
                    LineId = l.Id,
                    Product = new ProductLookup(l.ProductId, existing.PartnerId, l.Sku, l.Name, l.Ean, l.Unit, existing.PartnerCode),
                    Qty = l.ExpectedQty.ToString(),
                    Lot = l.Lot,
                    Expiry = l.Expiry,
                });
    }

    public override string Title => existing is null ? "Új betárolás" : $"{existing.Number} szerkesztése";
    public override string? Module => "inbound";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 1000;
    public string SubmitText => existing is null ? "Betárolás rögzítése" : "Mentés";

    public ObservableCollection<InboundFormLine> Lines { get; } = [];

    [ObservableProperty]
    public partial List<PartnerLookup> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<PartnerLookup> Suppliers { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasClient))]
    public partial PartnerLookup? Client { get; set; }

    [ObservableProperty]
    public partial PartnerLookup? Supplier { get; set; }

    [ObservableProperty]
    public partial DateTime? ExpectedDate { get; set; }

    [ObservableProperty]
    public partial string ExternalRef { get; set; }

    [ObservableProperty]
    public partial string Pallets { get; set; }

    [ObservableProperty]
    public partial string Cartons { get; set; }

    [ObservableProperty]
    public partial string Note { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    [ObservableProperty]
    public partial string? ClientError { get; set; }

    public bool HasClient => Client is not null;

    public override async Task LoadAsync()
    {
        if (Clients.Count > 0) return;
        var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
        var suppliers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=supplier");
        var c = (await clients).Items;
        if (existing is not null && c.All((p) => p.Id != existing.PartnerId))
            c.Add(new PartnerLookup(existing.PartnerId, "client", existing.PartnerCode, existing.PartnerName, "inactive", null));
        Clients = c;
        Suppliers = (await suppliers).Items;
        if (existing is not null)
        {
            Client = Clients.FirstOrDefault((p) => p.Id == existing.PartnerId);
            Supplier = Suppliers.FirstOrDefault((p) => p.Id == existing.SupplierId);
        }
    }

    partial void OnClientChanged(PartnerLookup? oldValue, PartnerLookup? newValue)
    {
        // The products belong to the client: another client means choosing them again.
        if (oldValue is null || newValue is null || oldValue.Id == newValue.Id) return;
        var had = Lines.Any((l) => l.Product is not null);
        foreach (var l in Lines) l.Product = null;
        if (had) Shell.Toast("Másik ügyfelet választottál: a termékeket válaszd ki újra.", ToastKind.Info);
    }

    // The product search of the lines: the chosen client's active products.
    internal async Task<IEnumerable<object>> FindProductsAsync(string? text, CancellationToken ct)
    {
        if (Client is null || string.IsNullOrWhiteSpace(text)) return [];
        var list = await Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", Client.Id), ("q", text.Trim())), ct);
        return list.Items;
    }

    [RelayCommand]
    void AddLine() => Lines.Add(new InboundFormLine(this));

    internal void RemoveLine(InboundFormLine line)
    {
        if (Lines.Count == 1)
        {
            Shell.Toast("Legalább egy tétel kell.", ToastKind.Error);
            return;
        }
        Lines.Remove(line);
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        ClientError = Client is null ? "Válassz ügyfelet." : null;
        foreach (var l in Lines) l.Validate();
        var pallets = Fmt.ParseNumber(Pallets.Length == 0 ? "0" : Pallets);
        var cartons = Fmt.ParseNumber(Cartons.Length == 0 ? "0" : Cartons);
        if (pallets is not { } p || p < 0 || p % 1 != 0 || cartons is not { } c || c < 0 || c % 1 != 0) Error = "A raklap és a karton nulla vagy pozitív egész szám legyen.";
        if (ClientError is not null || Error is not null || Lines.Any((l) => l.Error is not null))
        {
            Error ??= "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        var body = new
        {
            partner_id = Client!.Id,
            supplier_id = Supplier?.Id,
            expected_date = ExpectedDate?.ToString("yyyy-MM-dd"),
            external_ref = ExternalRef.Trim(),
            pallets = (int)pallets!.Value,
            cartons = (int)cartons!.Value,
            note = Note.Trim(),
            lines = Lines.Select((l) => new
            {
                id = l.LineId,
                product_id = l.Product!.Id,
                expected_qty = l.Quantity,
                lot = l.Lot.Trim(),
                expiry = l.Expiry.Trim().Length == 0 ? null : l.Expiry.Trim(),
            }).ToList(),
        };
        try
        {
            if (existing is null)
            {
                var created = await Api.PostAsync<CreatedRef>("api/inbound", body);
                Shell.Toast($"{created.Number} betárolás rögzítve.", ToastKind.Success);
                await Shell.BackAsync();
                await Shell.NavigateAsync(new InboundViewModel(Shell, created.Id));
            }
            else
            {
                await Api.PutAsync<CreatedRef>($"api/inbound/{existing.Id}", body);
                Shell.Toast("Betárolás mentve.", ToastKind.Success);
                await Shell.BackAsync();
            }
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            ClientError = e.Fields.GetValueOrDefault("partner_id");
            for (var i = 0; i < Lines.Count; i++)
            {
                var msg = e.Fields.Where((f) => f.Key.StartsWith($"lines.{i}.", StringComparison.Ordinal)).Select((f) => f.Value).FirstOrDefault();
                if (msg is not null) Lines[i].Error = msg;
            }
            Error = e.Message;
        }
    });
}

public sealed partial class InboundFormLine(InboundFormViewModel form) : ObservableObject
{
    public int? LineId { get; init; }

    [ObservableProperty]
    public partial ProductLookup? Product { get; set; }

    [ObservableProperty]
    public partial string Qty { get; set; } = "";

    [ObservableProperty]
    public partial string Lot { get; set; } = "";

    [ObservableProperty]
    public partial string Expiry { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    public int Quantity => Fmt.ParseNumber(Qty) is { } q ? (int)q : 0;

    public Func<string?, CancellationToken, Task<IEnumerable<object>>> FindProducts => form.FindProductsAsync;

    public void Validate()
    {
        var q = Fmt.ParseNumber(Qty);
        Error = Product is null ? "Válassz terméket."
            : q is not { } v || v < 1 || v % 1 != 0 ? "A várt mennyiség legalább 1 legyen."
            : Expiry.Trim().Length > 0 && !DateOnly.TryParseExact(Expiry.Trim(), "yyyy-MM-dd", out _) ? "A lejárat formátuma: ÉÉÉÉ-HH-NN."
            : null;
    }

    [RelayCommand]
    void Remove() => form.RemoveLine(this);
}
