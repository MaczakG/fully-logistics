using Avalonia.Controls;
using Avalonia.Interactivity;

namespace Fully.Wms.Views;

public partial class LoginView : UserControl
{
    public LoginView()
    {
        InitializeComponent();
    }

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        // The cursor goes where typing starts: the password when the e-mail is remembered.
        (string.IsNullOrEmpty(EmailBox.Text) ? EmailBox : PasswordBox).Focus();
    }
}
