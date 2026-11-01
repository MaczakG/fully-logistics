using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Inbound;

// Betárolás: expected deliveries, receiving with a hand scanner or the phone's camera by typed
// quantity, putaway with the location suggestion, closing with the receiving report.
static class InboundModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("inbound", (s) => new InboundListViewModel(s));
        PageLocator.Register<InboundListViewModel>(() => new InboundListView());
        PageLocator.Register<InboundViewModel>(() => new InboundView());
        PageLocator.Register<InboundFormViewModel>(() => new InboundFormView());
        PageLocator.Register<InboundArriveViewModel>(() => new InboundArriveView());
        PageLocator.Register<InboundCompleteViewModel>(() => new InboundCompleteView());
        PageLocator.Register<InboundCancelViewModel>(() => new InboundCancelView());
        PageLocator.Register<InboundLineEditViewModel>(() => new InboundLineEditView());
        PageLocator.Register<InboundAddLineViewModel>(() => new InboundAddLineView());
    }
}
