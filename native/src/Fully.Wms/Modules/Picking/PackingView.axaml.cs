using Avalonia.Controls;
using Avalonia.Threading;

namespace Fully.Wms.Modules.Picking;

public partial class PackingView : UserControl
{
    PackingViewModel? vm;

    public PackingView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (vm is not null) vm.OrderOpened -= OnOrderOpened;
        vm = DataContext as PackingViewModel;
        if (vm is not null) vm.OrderOpened += OnOrderOpened;
    }

    // An order to pack: a scanned label lands in the tracking number; else the submit button takes
    // Enter. Without an order the scan field waits for the next one. Not on the phone, where
    // focusing a field pops up the keyboard.
    void OnOrderOpened(object? sender, EventArgs e)
    {
        if (App.Platform.IsPhone) return;
        Dispatcher.UIThread.Post(() =>
        {
            if (vm?.ShowPackForm == true && vm.UseManual) TrackingBox.Focus();
            else if (vm?.ShowPackForm == true) SubmitButton.Focus();
            else Scan.FocusInput();
        }, DispatcherPriority.Input);
    }
}
