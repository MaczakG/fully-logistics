using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;

namespace Fully.Wms.Modules.Partners;

public partial class ApiKeyShownView : UserControl
{
    public ApiKeyShownView() => InitializeComponent();

    async void Copy(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not ApiKeyShownViewModel vm) return;
        if (TopLevel.GetTopLevel(this)?.Clipboard is { } clipboard)
        {
            await clipboard.SetTextAsync(vm.Key.Key);
            vm.Shell.Toast("A kulcs a vágólapon van.", ViewModels.ToastKind.Success);
        }
        else
        {
            KeyBox.SelectAll();
            KeyBox.Focus();
        }
    }
}
