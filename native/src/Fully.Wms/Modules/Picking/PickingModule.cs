using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Picking;

// Komissió: waves of orders, picking with a hand scanner or the phone's camera (location, product,
// quantity), shortages, the packing station with the courier's label or a tracking number.
static class PickingModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("picking", (s) => new WavesViewModel(s));
        PageLocator.Register<WavesViewModel>(() => new WavesView());
        PageLocator.Register<WaveViewModel>(() => new WaveView());
        PageLocator.Register<PackingViewModel>(() => new PackingView());
        PageLocator.Register<NewWaveViewModel>(() => new NewWaveView());
        PageLocator.Register<WavePickerViewModel>(() => new WavePickerView());
        PageLocator.Register<WaveShortViewModel>(() => new WaveShortView());
        PageLocator.Register<WaveCancelViewModel>(() => new WaveCancelView());
        PageLocator.Register<UnpackViewModel>(() => new UnpackView());
    }
}
