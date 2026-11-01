using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Quotes;

// Ajánlatkészítő: the saved quotes, and a quote with its live paper and internal costing in its
// own window.
static class QuotesModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("quotes", (s) => new QuotesViewModel(s));
        PageLocator.Register<QuotesViewModel>(() => new QuotesView());
        PageLocator.Register<QuoteViewModel>(() => new QuoteView());
    }
}
