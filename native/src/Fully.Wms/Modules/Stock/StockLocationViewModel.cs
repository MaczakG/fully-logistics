using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// GET /api/stock/locations/:id: what lies on a location (product, lot, expiry, quantity).
public sealed partial class StockLocationViewModel(ShellViewModel shell, int locationId) : PageViewModel(shell)
{
    public override string Title => Data?.Location.Code ?? "Raktárhely";
    public override string? Module => "stock";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Location), nameof(Rows), nameof(IsEmpty), nameof(LastMovementText), nameof(Dedicated))]
    public partial LocationDetail? Data { get; set; }

    public LocationInfo? Location => Data?.Location;
    public IReadOnlyList<LocationStockRow> Rows => Data?.Stock ?? [];
    public bool IsEmpty => Data is not null && Rows.Count == 0;
    public string Dedicated => Location?.DedicatedCode is { } code ? $"{Location.DedicatedName} ({code})" : "nincs";
    public string LastMovementText => Data?.LastMovement is { } m ? $"{m.TypeLabel ?? m.Type}, {Core.Fmt.DateTime(m.At)}" : "még nem volt";

    public override async Task LoadAsync() => Data = await Api.GetAsync<LocationDetail>($"api/stock/locations/{locationId}");

    [RelayCommand]
    Task OpenProductAsync(LocationStockRow row) => Shell.NavigateAsync(new StockProductViewModel(Shell, row.ProductId));

    [RelayCommand]
    Task MovementsAsync() => Location is null ? Task.CompletedTask
        : Shell.NavigateAsync(new MovementsViewModel(Shell, locationId: Location.Id, locationText: Location.Code));
}
