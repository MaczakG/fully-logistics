using Avalonia.Controls;
using Avalonia.Threading;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Inbound;

public partial class InboundView : UserControl
{
    InboundViewModel? vm;

    public InboundView()
    {
        InitializeComponent();
        LotChoice.SelectionChanged += (_, _) =>
        {
            if (vm?.Entry is { } e && LotChoice.SelectedItem is InboundLine l && l.Id != e.Line.Id) vm.SwitchEntryLine(l);
        };
    }

    protected override void OnDataContextChanged(EventArgs e)
    {
        base.OnDataContextChanged(e);
        if (vm is not null)
        {
            vm.EntryOpened -= OnEntryOpened;
            vm.PropertyChanged -= OnPropertyChanged;
        }
        vm = DataContext as InboundViewModel;
        if (vm is not null)
        {
            vm.EntryOpened += OnEntryOpened;
            vm.PropertyChanged += OnPropertyChanged;
        }
    }

    // A new entry: the quantity is selected, so typing a number replaces the 1 of the scan.
    void OnEntryOpened(object? sender, EventArgs e) => Dispatcher.UIThread.Post(() =>
    {
        QtyBox.Focus();
        QtyBox.SelectAll();
        QtyBox.BringIntoView();
    }, DispatcherPriority.Input);

    // After recording (the entry closes) the hand scanner types into the scan field again.
    void OnPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(InboundViewModel.Entry) && vm?.Entry is null && !App.Platform.IsPhone) Scan.FocusInput();
    }
}
