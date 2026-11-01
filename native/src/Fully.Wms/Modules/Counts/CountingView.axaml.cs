using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;

namespace Fully.Wms.Modules.Counts;

public partial class CountingView : UserControl
{
    CountingViewModel? vm;

    public CountingView()
    {
        InitializeComponent();
        // A quantity field left with a changed number saves it (like the web app's change event).
        AddHandler(InputElement.LostFocusEvent, OnLostFocus, RoutingStrategies.Bubble);
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (vm is not null) vm.ScanFocus -= OnScanFocus;
        vm = DataContext as CountingViewModel;
        if (vm is not null) vm.ScanFocus += OnScanFocus;
    }

    void OnLostFocus(object? sender, RoutedEventArgs e)
    {
        if (e.Source is TextBox { DataContext: CountEntryItem item }) _ = item.SaveIfChangedAsync();
    }

    // After an entry the hand scanner types into the scan field again (not on the phone, where
    // focusing would pop up the keyboard).
    void OnScanFocus(object? sender, EventArgs e)
    {
        if (!App.Platform.IsPhone) Scan.FocusInput();
    }
}
