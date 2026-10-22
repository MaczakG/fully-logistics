using Avalonia.Controls;

namespace Fully.Wms.Modules.Transport;

public partial class PickupView : UserControl
{
    PickupViewModel? vm;

    public PickupView() => InitializeComponent();

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (vm is not null) vm.ScanFocus -= OnScanFocus;
        vm = DataContext as PickupViewModel;
        if (vm is not null) vm.ScanFocus += OnScanFocus;
    }

    // After every scan the field is ready for the next parcel. Not on the phone, where focusing a
    // field pops up the keyboard.
    void OnScanFocus(object? sender, EventArgs e)
    {
        if (!App.Platform.IsPhone) Scan.FocusInput();
    }
}
