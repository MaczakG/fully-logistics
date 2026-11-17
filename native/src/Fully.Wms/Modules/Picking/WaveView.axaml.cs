using Avalonia.Controls;
using Avalonia.Threading;

namespace Fully.Wms.Modules.Picking;

public partial class WaveView : UserControl
{
    WaveViewModel? vm;

    public WaveView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (vm is not null)
        {
            vm.QtyOpened -= OnQtyOpened;
            vm.ScanFocus -= OnScanFocus;
        }
        vm = DataContext as WaveViewModel;
        if (vm is not null)
        {
            vm.QtyOpened += OnQtyOpened;
            vm.ScanFocus += OnScanFocus;
        }
    }

    // The quantity is selected, so typing a number replaces the suggested one.
    void OnQtyOpened(object? sender, EventArgs e) => Dispatcher.UIThread.Post(() =>
    {
        QtyBox.Focus();
        QtyBox.SelectAll();
        QtyBox.BringIntoView();
    }, DispatcherPriority.Input);

    // After a confirmation the hand scanner types into the scan field again (not on the phone,
    // where focusing would pop up the keyboard).
    void OnScanFocus(object? sender, EventArgs e)
    {
        if (!App.Platform.IsPhone) Scan.FocusInput();
    }
}
