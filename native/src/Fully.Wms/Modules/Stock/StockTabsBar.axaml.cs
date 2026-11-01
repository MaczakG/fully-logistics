using System.Windows.Input;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;

namespace Fully.Wms.Modules.Stock;

public partial class StockTabsBar : UserControl
{
    public static readonly StyledProperty<string> ActiveProperty = AvaloniaProperty.Register<StockTabsBar, string>(nameof(Active), "stock");
    public static readonly StyledProperty<ICommand?> CommandProperty = AvaloniaProperty.Register<StockTabsBar, ICommand?>(nameof(Command));

    public StockTabsBar()
    {
        InitializeComponent();
        foreach (var b in Tabs())
            b.Click += (_, _) =>
            {
                var key = (string)b.Tag!;
                b.IsChecked = key == Active;
                if (key != Active && Command?.CanExecute(key) == true) Command.Execute(key);
            };
        Mark();
    }

    public string Active
    {
        get => GetValue(ActiveProperty);
        set => SetValue(ActiveProperty, value);
    }

    public ICommand? Command
    {
        get => GetValue(CommandProperty);
        set => SetValue(CommandProperty, value);
    }

    IEnumerable<ToggleButton> Tabs() => [Stock, Catalog, Movements, Map, Locations];

    void Mark()
    {
        foreach (var b in Tabs()) b.IsChecked = (string)b.Tag! == Active;
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == ActiveProperty) Mark();
    }
}
