using Avalonia;
using Avalonia.Controls;
using Fully.Wms.Core;
using Fully.Wms.Services;

namespace Fully.Wms.Views;

public partial class MainWindow : Window
{
    readonly AppServices? services;
    PixelPoint normalPosition;
    Size normalSize;

    public MainWindow()
    {
        InitializeComponent();
    }

    public MainWindow(AppServices services) : this()
    {
        this.services = services;
        Restore(services.Settings.Window);
    }

    // The last size and place, if it still fits on one of the screens; otherwise the default
    // (1280 x 820, centred, never full screen).
    void Restore(WindowBounds? b)
    {
        if (b is null || b.Width < MinWidth || b.Height < MinHeight) return;
        var rect = new PixelRect(b.X, b.Y, b.Width, b.Height);
        var visible = Screens.All.Any((s) => s.WorkingArea.Intersect(rect) is { Width: >= 200, Height: >= 120 });
        if (!visible) return;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Position = new PixelPoint(b.X, b.Y);
        Width = b.Width;
        Height = b.Height;
        if (b.Maximized) WindowState = WindowState.Maximized;
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        // Remember the size and place while the window is normal, so a maximized window comes
        // back to them when restored.
        if (WindowState == WindowState.Normal && (change.Property == ClientSizeProperty || change.Property == WindowStateProperty))
        {
            normalSize = ClientSize;
            normalPosition = Position;
        }
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        base.OnClosing(e);
        if (services is null) return;
        if (WindowState == WindowState.Normal)
        {
            normalSize = ClientSize;
            normalPosition = Position;
        }
        if (normalSize.Width > 0)
        {
            services.Settings.Window = new WindowBounds(normalPosition.X, normalPosition.Y, (int)normalSize.Width, (int)normalSize.Height, WindowState == WindowState.Maximized);
            services.SaveSettings();
        }
    }
}
