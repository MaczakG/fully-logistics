using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Billing;

// Elszámolás: the month's statements and the recorded items in the main window, a statement in its
// own window, manual lines, voiding and the recorded items in dialogs.
static class BillingModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("billing", (s) => new BillingViewModel(s));
        PageLocator.Register<BillingViewModel>(() => new BillingView());
        PageLocator.Register<StatementViewModel>(() => new StatementView());
        PageLocator.Register<ManualLineViewModel>(() => new ManualLineView());
        PageLocator.Register<VoidViewModel>(() => new VoidView());
        PageLocator.Register<EntryFormViewModel>(() => new EntryFormView());
    }
}
