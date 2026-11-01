using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// POST /api/stock/adjust: manual correction with a reason (stock:approve). On an existing stock
// row, or on a new location / lot. mode: set (the counted quantity), add, remove.
public sealed partial class StockAdjustViewModel : PageViewModel
{
    public static readonly string[] Reasons = ["Leltáreltérés", "Sérült áru, selejtezés", "Talált áru", "Hibás könyvelés javítása", "Ügyfél kérésére", "Egyéb"];
    public static readonly string[] ModeLabels = ["Mennyiség beállítása (számolt érték)", "Hozzáadás", "Levonás"];
    static readonly string[] ModeKeys = ["set", "add", "remove"];

    public StockAdjustViewModel(ShellViewModel shell, ProductInfo product, IReadOnlyList<StockLocationRow> rows, StockLocationRow? row) : base(shell)
    {
        Product = product;
        Choices = [.. rows.Select((r) => new AdjustChoice(r)), new AdjustChoice(null)];
        Choice = Choices.FirstOrDefault((c) => c.Row == row) ?? Choices[0];
        Qty = Choice.Row?.Qty.ToString() ?? "";
    }

    public override string Title => $"Készletkorrekció: {Product.Sku}";
    public override string? Module => "stock";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 620;

    public ProductInfo Product { get; }
    public IReadOnlyList<AdjustChoice> Choices { get; }
    public IReadOnlyList<string> ReasonList => Reasons;
    public IReadOnlyList<string> Modes => ModeLabels;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsNew))]
    public partial AdjustChoice Choice { get; set; }

    public bool IsNew => Choice.Row is null;

    [ObservableProperty]
    public partial int Mode { get; set; }

    [ObservableProperty]
    public partial string Qty { get; set; }

    [ObservableProperty]
    public partial string LocationCode { get; set; } = "";

    [ObservableProperty]
    public partial string Lot { get; set; } = "";

    // YYYY-MM-DD or empty
    [ObservableProperty]
    public partial string Expiry { get; set; } = "";

    [ObservableProperty]
    public partial string? Reason { get; set; }

    [ObservableProperty]
    public partial string ReasonText { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    partial void OnChoiceChanged(AdjustChoice value)
    {
        if (value.Row is null && Mode == 2) Mode = 1;
        if (Mode == 0) Qty = value.Row?.Qty.ToString() ?? "";
    }

    partial void OnModeChanged(int value) => Qty = value == 0 ? Choice.Row?.Qty.ToString() ?? "" : "";

    [RelayCommand]
    void ScanLocation(string code) => LocationCode = code;

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var qty = Fmt.ParseNumber(Qty);
        Error = qty is not { } q || q < 0 || q % 1 != 0 ? "A mennyiség nulla vagy pozitív egész szám legyen."
            : Reason is null ? "Válaszd ki a korrekció okát."
            : IsNew && LocationCode.Trim().Length == 0 ? "Add meg a raktárhelyet."
            : null;
        if (Error is not null) return;
        var reason = ReasonText.Trim().Length > 0 ? $"{Reason}: {ReasonText.Trim()}" : Reason!;
        var row = Choice.Row;
        try
        {
            var res = await Api.PostAsync<AdjustResult>("api/stock/adjust", new
            {
                product_id = Product.Id,
                mode = ModeKeys[Mode],
                qty = (int)qty!.Value,
                reason,
                location_id = row?.LocationId,
                location_code = row is null ? LocationCode.Trim() : null,
                lot = row?.Lot ?? Lot.Trim(),
                expiry = row is not null ? (string.IsNullOrEmpty(row.Expiry) ? null : row.Expiry) : (Expiry.Trim().Length > 0 ? Expiry.Trim() : null),
            });
            Shell.Toast($"Korrekció könyvelve: {Fmt.Int(res.Before)} → {Fmt.Int(res.After)} {Product.UnitText}.", ToastKind.Success);
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            Error = string.Join(" ", e.Fields.Values.Prepend(e.Message));
        }
    });
}

// A row of the "Készletsor" choice: an existing stock row or a new location / lot.
public sealed record AdjustChoice(StockLocationRow? Row)
{
    public string Label => Row is null ? "Új hely vagy új sarzs" : StockText.RowLabel(Row);
}

public static class StockText
{
    public static string RowLabel(StockLocationRow r) =>
        $"{r.Code}{(r.Lot.Length > 0 ? $", sarzs {r.Lot}" : "")}{(r.Expiry.Length > 0 ? $", lejárat {Fmt.Date(r.Expiry)}" : "")}: {Fmt.Int(r.Qty)} db";
}
