using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// Beállítások: company, warehouse and costing, location sizes and locations, default tariffs,
// courier and invoicing accounts, the logs. The sizes, locations, courier accounts and log
// entries open in dialogs.
static class SettingsModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("settings", (s) => new SettingsViewModel(s));
        PageLocator.Register<SettingsViewModel>(() => new SettingsView());
        PageLocator.Register<SizeFormViewModel>(() => new SizeFormView());
        PageLocator.Register<LocationFormViewModel>(() => new LocationFormView());
        PageLocator.Register<BulkCreateViewModel>(() => new BulkCreateView());
        PageLocator.Register<BulkChangeViewModel>(() => new BulkChangeView());
        PageLocator.Register<CourierFormViewModel>(() => new CourierFormView());
        PageLocator.Register<LogEntryViewModel>(() => new LogEntryView());
    }
}
