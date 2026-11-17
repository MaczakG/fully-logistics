using System.Runtime.CompilerServices;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.History;

// Rendeléstörténet: closed orders with search and export; the order detail (from Megrendelések)
// with delivered and the return form.
static class HistoryModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("history", (s) => new HistoryViewModel(s));
        PageLocator.Register<HistoryViewModel>(() => new HistoryView());
        PageLocator.Register<ReturnFormViewModel>(() => new ReturnFormView());
        OrderViewModel.ReturnForm = (shell, order) => new ReturnFormViewModel(shell, order);
    }
}
