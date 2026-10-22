using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// GET /api/stock/product/:id: availability, stock by location and lot (earliest expiry first),
// reservations, the last movements. Transfer needs stock:edit, correction stock:approve.
public sealed partial class StockProductViewModel(ShellViewModel shell, int productId) : PageViewModel(shell)
{
    public override string Title => Data?.Product.Sku ?? "Cikk";
    public override string? Module => "stock";

    public int ProductId { get; } = productId;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Product), nameof(Availability), nameof(Rows), nameof(Reservations), nameof(Movements),
        nameof(HasRows), nameof(HasReservations), nameof(Dimensions), nameof(Tracking), nameof(CanTransfer), nameof(CanDeactivate), nameof(CanActivate))]
    public partial StockProduct? Data { get; set; }

    public ProductInfo? Product => Data?.Product;
    public ProductAvailability? Availability => Data?.Availability;
    public IReadOnlyList<StockLocationRow> Rows => Data?.Locations ?? [];
    public IReadOnlyList<StockReservation> Reservations => Data?.Reservations ?? [];
    public IReadOnlyList<Movement> Movements => Data?.Movements ?? [];
    public bool HasRows => Rows.Count > 0;
    public bool HasReservations => Reservations.Count > 0;

    public bool CanEdit => Shell.Me?.Can("stock", "edit") == true;
    public bool CanApprove => Shell.Me?.Can("stock", "approve") == true;
    public bool CanDelete => Shell.Me?.Can("stock", "delete") == true;
    public bool CanDeactivate => CanDelete && Product?.Active == true;
    public bool CanActivate => CanDelete && Product?.Active == false;
    public bool CanTransfer => CanEdit && HasRows;

    public string Dimensions => Product is { } p && (p.WidthCm ?? p.DepthCm ?? p.HeightCm) is not null
        ? $"{Dim(p.WidthCm)} x {Dim(p.DepthCm)} x {Dim(p.HeightCm)} cm"
        : "nincs megadva";

    public string Tracking => Product is null ? "" : (Product.TrackLot, Product.TrackExpiry) switch
    {
        (true, true) => "sarzs, lejárat",
        (true, false) => "sarzs",
        (false, true) => "lejárat",
        _ => "nincs",
    };

    static string Dim(decimal? v) => v is null ? "?" : Fmt.Num(v.Value, 1);

    public override async Task LoadAsync() =>
        Data = await Api.GetAsync<StockProduct>($"api/stock/product/{ProductId}");

    [RelayCommand]
    Task TransferAsync(StockLocationRow? row) =>
        Data is null ? Task.CompletedTask : Shell.NavigateAsync(new StockTransferViewModel(Shell, Data.Product, Rows, row ?? Rows.FirstOrDefault()));

    [RelayCommand]
    Task AdjustAsync(StockLocationRow? row) =>
        Data is null ? Task.CompletedTask : Shell.NavigateAsync(new StockAdjustViewModel(Shell, Data.Product, Rows, row));

    [RelayCommand]
    Task OpenLocationAsync(StockLocationRow row) => Shell.NavigateAsync(new StockLocationViewModel(Shell, row.LocationId));

    [RelayCommand]
    Task MovementsAsync() => Product is null ? Task.CompletedTask
        : Shell.NavigateAsync(new MovementsViewModel(Shell, productId: Product.Id, productText: $"{Product.Sku} {Product.Name}"));

    // The product's data (Cikkadatok): the catalogue form with this product.
    [RelayCommand]
    Task EditAsync() => RunAsync(async () =>
    {
        var row = await Api.GetAsync<ProductRow>($"api/products/{ProductId}");
        await Shell.NavigateAsync(new ProductFormViewModel(Shell, row));
    });

    [RelayCommand]
    Task DeactivateAsync() => RunAsync(async () =>
    {
        if (Product is null) return;
        if (!await Shell.ConfirmAsync("Cikk inaktiválása",
                $"Inaktiválod a(z) {Product.Sku} cikket? Utána nem lehet rendelni és betárolni, amíg újra nem aktiválod.", "Inaktiválás", danger: true)) return;
        await Api.PostAsync($"api/products/{ProductId}/deactivate");
        Shell.Toast("A cikk inaktív lett.", ToastKind.Success);
        await LoadAsync();
    });

    [RelayCommand]
    Task ActivateAsync() => RunAsync(async () =>
    {
        await Api.PostAsync($"api/products/{ProductId}/activate");
        Shell.Toast("A cikk újra aktív.", ToastKind.Success);
        await LoadAsync();
    });
}
