using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.Stock;

namespace Fully.Wms.Tests;

public class StockUiTests
{
    [AvaloniaFact]
    public async Task Desktop_list_product_and_location_pages()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("stock");
        var list = Assert.IsType<StockViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Assert.NotNull(list.Summary);
        Screens.Save(window, "stock-list-desktop");

        list.Selected = list.Items.First((r) => r.Locations > 0);
        await Task.Delay(300, TestContext.Current.CancellationToken);
        Screens.Settle();
        var product = Assert.IsType<StockProductViewModel>(shell.Current);
        Assert.NotNull(product.Data);
        Screens.Save(window, "stock-product-desktop");

        await product.OpenLocationCommand.ExecuteAsync(product.Rows[0]);
        var location = Assert.IsType<StockLocationViewModel>(shell.Current);
        Assert.NotEmpty(location.Rows);
        Screens.Save(window, "stock-location-desktop");

        await shell.BackAsync();
        await product.TransferCommand.ExecuteAsync(product.Rows[0]);
        Assert.IsType<StockTransferViewModel>(shell.Current);
        Screens.Save(window, "stock-transfer-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_scan_opens_location_or_product()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("stock");
        var list = Assert.IsType<StockViewModel>(shell.Current);
        Screens.Save(window, "stock-list-phone");

        var row = list.Items.First((r) => r.Locations > 0);
        await list.ScanCommand.ExecuteAsync(row.Sku);
        var product = Assert.IsType<StockProductViewModel>(shell.Current);
        Assert.Equal(row.ProductId, product.ProductId);
        Screens.Save(window, "stock-product-phone");

        var code = product.Rows[0].Code;
        await shell.BackAsync();
        await list.ScanCommand.ExecuteAsync(code.ToLowerInvariant());
        var location = Assert.IsType<StockLocationViewModel>(shell.Current);
        Assert.Equal(code, location.Location!.Code);
        Screens.Save(window, "stock-location-phone");

        await shell.BackAsync();
        await list.ScanCommand.ExecuteAsync("NINCS-ILYEN-KOD-123");
        Assert.IsType<StockViewModel>(shell.Current);
        Assert.Equal(0, list.Total);
    }
}
