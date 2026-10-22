using Avalonia.Controls;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Views;

public partial class PageHost : UserControl
{
    public PageHost()
    {
        InitializeComponent();
        Retry.Click += async (_, _) => { if (DataContext is PageViewModel p) await p.ReloadAsync(); };
    }
}
