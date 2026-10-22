using Avalonia.Controls;

namespace Fully.Wms.Modules.Orders;

public partial class OrdersView : UserControl
{
    public OrdersView() => InitializeComponent();

    // The selection boxes only for those who may start a wave (a column cannot bind its visibility).
    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        Table.Columns[0].IsVisible = DataContext is OrdersViewModel { CanWave: true };
    }
}
