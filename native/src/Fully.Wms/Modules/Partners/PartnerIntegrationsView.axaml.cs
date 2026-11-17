using Avalonia.Controls;
using Avalonia.Interactivity;

namespace Fully.Wms.Modules.Partners;

public partial class PartnerIntegrationsView : UserControl
{
    public PartnerIntegrationsView() => InitializeComponent();

    // The partner API's documentation on the server, in the browser.
    async void OpenDocs(object? sender, RoutedEventArgs e)
    {
        if (DataContext is PartnerIntegrationsTab tab && TopLevel.GetTopLevel(this) is { } top)
            await top.Launcher.LaunchUriAsync(new Uri(tab.DocsUrl));
    }
}
