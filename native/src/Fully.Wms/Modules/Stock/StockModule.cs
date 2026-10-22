using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Stock;

// Készlet: stock per product, product page (locations, lots, reservations, movements), location
// page, transfer and manual correction. Scanning a code opens the location or the product.
static class StockModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("stock", (s) => new StockViewModel(s));
        PageLocator.Register<StockViewModel>(() => new StockView());
        PageLocator.Register<StockProductViewModel>(() => new StockProductView());
        PageLocator.Register<StockLocationViewModel>(() => new StockLocationView());
        PageLocator.Register<StockTransferViewModel>(() => new StockTransferView());
        PageLocator.Register<StockAdjustViewModel>(() => new StockAdjustView());
    }
}
