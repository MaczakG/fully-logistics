using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Orders;

// Megrendelések: the open orders with availability, new and edited orders, CSV import, hold,
// release, cancel, sending to picking; the order detail shared with Rendeléstörténet.
static class OrdersModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("orders", (s) => new OrdersViewModel(s));
        PageLocator.Register<OrdersViewModel>(() => new OrdersView());
        PageLocator.Register<OrderViewModel>(() => new OrderView());
        PageLocator.Register<OrderFormViewModel>(() => new OrderFormView());
        PageLocator.Register<OrderReasonViewModel>(() => new OrderReasonView());
        PageLocator.Register<SendToPickingViewModel>(() => new SendToPickingView());
    }
}
