using Avalonia.Controls;
using Avalonia.Interactivity;

namespace Fully.Wms.Modules.Orders;

public partial class OrderView : UserControl
{
    public OrderView() => InitializeComponent();

    // The courier's tracking page in the browser.
    async void OpenTracking(object? sender, RoutedEventArgs e)
    {
        if (DataContext is OrderViewModel { Data.TrackingUrl: { Length: > 0 } url } && TopLevel.GetTopLevel(this) is { } top)
            await top.Launcher.LaunchUriAsync(new Uri(url));
    }
}
