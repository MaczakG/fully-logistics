using Avalonia;
using Avalonia.Controls;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Stock;

public partial class MovementList : UserControl
{
    public static readonly StyledProperty<IReadOnlyList<Movement>?> ItemsProperty =
        AvaloniaProperty.Register<MovementList, IReadOnlyList<Movement>?>(nameof(Items));

    public static readonly DirectProperty<MovementList, bool> IsEmptyProperty =
        AvaloniaProperty.RegisterDirect<MovementList, bool>(nameof(IsEmpty), (o) => o.IsEmpty);

    public MovementList() => InitializeComponent();

    public IReadOnlyList<Movement>? Items
    {
        get => GetValue(ItemsProperty);
        set => SetValue(ItemsProperty, value);
    }

    public bool IsEmpty => Items is { Count: 0 };

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == ItemsProperty) RaisePropertyChanged(IsEmptyProperty, !IsEmpty, IsEmpty);
    }
}
