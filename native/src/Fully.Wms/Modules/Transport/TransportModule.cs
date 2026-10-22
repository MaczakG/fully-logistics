using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Transport;

// Fuvarszervezés: the day's carrier pickups with the manifest scanned at the ramp and closed to
// ship the orders, and the pallet transports from the request to the delivery.
static class TransportModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("transport", (s) => new TransportBoardViewModel(s));
        PageLocator.Register<TransportBoardViewModel>(() => new TransportBoardView());
        PageLocator.Register<PickupViewModel>(() => new PickupView());
        PageLocator.Register<PickupFormViewModel>(() => new PickupFormView());
        PageLocator.Register<PickupCloseViewModel>(() => new PickupCloseView());
        PageLocator.Register<TransportsViewModel>(() => new TransportsView());
        PageLocator.Register<TransportFormViewModel>(() => new TransportFormView());
    }
}
