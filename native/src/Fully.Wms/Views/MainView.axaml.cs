using Avalonia;
using Avalonia.Controls;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Views;

public partial class MainView : UserControl
{
    // Below this width the side menu gives way to the home tiles and the top bar's Home button.
    public const double CompactWidth = 760;

    public MainView()
    {
        InitializeComponent();
    }

    protected override void OnSizeChanged(SizeChangedEventArgs e)
    {
        base.OnSizeChanged(e);
        if (DataContext is not ShellViewModel shell) return;
        var compact = shell.IsPhone || e.NewSize.Width < CompactWidth;
        shell.IsCompact = compact;
        Classes.Set("compact", compact);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (DataContext is not ShellViewModel shell) return;
        Classes.Set("compact", shell.IsCompact);
        shell.View = this;
    }
}
