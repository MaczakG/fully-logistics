using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.VisualTree;

namespace Fully.Wms.Controls;

// Opening a row of a table like in a Windows application: double click or Enter opens it, a single
// click only selects. The opened row is written into the bound property (the view model opens
// it and clears the property):
//   <DataGrid ctl:RowOpen.Item="{Binding Selected}" ... />
public static class RowOpen
{
    public static readonly AttachedProperty<object?> ItemProperty =
        AvaloniaProperty.RegisterAttached<DataGrid, object?>("Item", typeof(RowOpen), defaultBindingMode: Avalonia.Data.BindingMode.TwoWay);

    public static object? GetItem(DataGrid grid) => grid.GetValue(ItemProperty);
    public static void SetItem(DataGrid grid, object? value) => grid.SetValue(ItemProperty, value);

    static bool registered;

    public static void Register()
    {
        if (registered) return;
        registered = true;
        InputElement.DoubleTappedEvent.AddClassHandler<DataGrid>((grid, e) =>
        {
            if (!grid.IsSet(ItemProperty) || e.Source is not Visual v || v.FindAncestorOfType<DataGridRow>(includeSelf: true) is null) return;
            Open(grid);
            e.Handled = true;
        });
        InputElement.KeyDownEvent.AddClassHandler<DataGrid>((grid, e) =>
        {
            if (!grid.IsSet(ItemProperty) || e.Key is not (Key.Enter or Key.Return) || grid.SelectedItem is null) return;
            Open(grid);
            e.Handled = true;
        }, RoutingStrategies.Tunnel);
    }

    static void Open(DataGrid grid)
    {
        if (grid.SelectedItem is { } item) grid.SetCurrentValue(ItemProperty, item);
    }
}
