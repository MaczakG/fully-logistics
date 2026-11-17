using Avalonia;
using Avalonia.Controls;

namespace Fully.Wms.Views;

public partial class HomeView : UserControl
{
    // Tiles per row: two on a phone, more as the window grows (one tile is at least 190 px wide).
    public static readonly StyledProperty<int> TileColumnsProperty = AvaloniaProperty.Register<HomeView, int>(nameof(TileColumns), 2);

    public HomeView() => InitializeComponent();

    public int TileColumns
    {
        get => GetValue(TileColumnsProperty);
        set => SetValue(TileColumnsProperty, value);
    }

    protected override void OnSizeChanged(SizeChangedEventArgs e)
    {
        base.OnSizeChanged(e);
        TileColumns = Math.Clamp((int)((e.NewSize.Width - 22) / 190), 2, 6);
    }
}
