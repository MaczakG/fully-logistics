using Avalonia;
using Avalonia.iOS;
using Foundation;

namespace Fully.Wms.iOS;

// Starts the shared app as the PDA: phone screens, warehouse modules, camera scanning.
[Register("AppDelegate")]
#pragma warning disable CA1711 // the name iOS expects
public partial class AppDelegate : AvaloniaAppDelegate<App>
#pragma warning restore CA1711
{
    protected override AppBuilder CustomizeAppBuilder(AppBuilder builder)
    {
        App.Platform = new IosPlatformServices();
        return base.CustomizeAppBuilder(builder).WithInterFont();
    }
}
