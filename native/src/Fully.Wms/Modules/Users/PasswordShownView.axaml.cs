using Avalonia.Controls;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;

namespace Fully.Wms.Modules.Users;

public partial class PasswordShownView : UserControl
{
    public PasswordShownView() => InitializeComponent();

    async void Copy(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not PasswordShownViewModel vm) return;
        if (TopLevel.GetTopLevel(this)?.Clipboard is { } clipboard)
        {
            await clipboard.SetTextAsync(vm.Password);
            vm.Shell.Toast("Jelszó a vágólapon.", ViewModels.ToastKind.Success);
        }
        else
        {
            PasswordBox.SelectAll();
            PasswordBox.Focus();
        }
    }
}
