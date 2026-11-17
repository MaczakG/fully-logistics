using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// Leltár: cycle, zone, product, full and location counts; counting location by location with a
// hand scanner or the phone's camera; review of the differences and posting; the count sheet.
static class CountsModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("counts", (s) => new CountsViewModel(s));
        PageLocator.Register<CountsViewModel>(() => new CountsView());
        PageLocator.Register<CountViewModel>(() => new CountView());
        PageLocator.Register<CountingViewModel>(() => new CountingView());
        PageLocator.Register<CountReviewViewModel>(() => new CountReviewView());
        PageLocator.Register<NewCountViewModel>(() => new NewCountView());
        PageLocator.Register<CountFoundViewModel>(() => new CountFoundView());
        PageLocator.Register<CountChooseLineViewModel>(() => new CountChooseLineView());
    }
}
