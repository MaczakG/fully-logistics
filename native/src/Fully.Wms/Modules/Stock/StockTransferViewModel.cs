using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// POST /api/stock/transfer: moves a quantity of one stock row (location, lot, expiry) to another
// location, given by its code (scanned). The target must be empty or hold the same client's goods.
public sealed partial class StockTransferViewModel : PageViewModel
{
    public StockTransferViewModel(ShellViewModel shell, ProductInfo product, IReadOnlyList<StockLocationRow> rows, StockLocationRow? from) : base(shell)
    {
        Product = product;
        Rows = rows;
        From = from ?? rows.FirstOrDefault();
        Qty = From?.Qty.ToString() ?? "";
    }

    public override string Title => $"Áttárolás: {Product.Sku}";
    public override string? Module => "stock";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 600;

    public ProductInfo Product { get; }
    public IReadOnlyList<StockLocationRow> Rows { get; }

    [ObservableProperty]
    public partial StockLocationRow? From { get; set; }

    [ObservableProperty]
    public partial string ToCode { get; set; } = "";

    [ObservableProperty]
    public partial string Qty { get; set; }

    [ObservableProperty]
    public partial string Note { get; set; } = "";

    [ObservableProperty]
    public partial string? ToError { get; set; }

    [ObservableProperty]
    public partial string? QtyError { get; set; }

    partial void OnFromChanged(StockLocationRow? value) => Qty = value?.Qty.ToString() ?? "";

    // The scan field fills the target location.
    [RelayCommand]
    void ScanTarget(string code) => ToCode = code;

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        ToError = ToCode.Trim().Length == 0 ? "Olvasd be vagy írd be a cél raktárhelyet." : null;
        var qty = Fmt.ParseNumber(Qty);
        QtyError = From is null ? "Válaszd ki, honnan." : qty is not { } q || q < 1 || q % 1 != 0 ? "Pozitív egész szám legyen." : q > From.Qty ? $"Legfeljebb {Fmt.Int(From.Qty)}." : null;
        if (ToError is not null || QtyError is not null || From is null) return;
        try
        {
            var res = await Api.PostAsync<TransferResult>("api/stock/transfer", new
            {
                product_id = Product.Id,
                from_location_id = From.LocationId,
                lot = From.Lot,
                expiry = string.IsNullOrEmpty(From.Expiry) ? null : From.Expiry,
                to_location_code = ToCode.Trim(),
                qty = (int)qty!.Value,
                note = Note.Trim(),
            });
            Shell.Toast($"Áttárolva: {Fmt.Int((int)qty.Value)} {Product.UnitText}, {res.From} → {res.To}.", ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            ToError = e.Fields.GetValueOrDefault("to_location_code");
            QtyError = e.Fields.GetValueOrDefault("qty");
            if (ToError is null && QtyError is null) throw;
        }
    });
}
