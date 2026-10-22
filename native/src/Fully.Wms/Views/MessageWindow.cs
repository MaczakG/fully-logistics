using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Views;

// A question with two buttons as a small modal window (Shell.ConfirmAsync on the desktop).
// Enter answers the first button, Esc the second.
public sealed class MessageWindow : Window
{
    readonly DialogViewModel dialog;

    public MessageWindow(DialogViewModel dialog)
    {
        this.dialog = dialog;
        Title = dialog.Title;
        Width = 460;
        SizeToContent = SizeToContent.Height;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        // The theme's paper colour, following light and dark.
        Bind(BackgroundProperty, this.GetResourceObservable("Paper"));

        var ok = new Button { Content = dialog.OkText, MinWidth = 110 };
        ok.Classes.Add("primary");
        if (dialog.IsDanger) ok.Classes.Add("danger");
        ok.Click += (_, _) => Answer(true);
        var cancel = new Button { Content = dialog.CancelText, MinWidth = 110 };
        cancel.Click += (_, _) => Answer(false);

        Content = new StackPanel
        {
            Margin = new Thickness(20),
            Spacing = 16,
            Children =
            {
                new TextBlock { Text = dialog.Title, Classes = { "h2" }, TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                new TextBlock { Text = dialog.Message, TextWrapping = Avalonia.Media.TextWrapping.Wrap },
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, HorizontalAlignment = HorizontalAlignment.Right, Children = { cancel, ok } },
            },
        };
        Opened += (_, _) => ok.Focus();
        Closed += (_, _) => dialog.CancelCommand.Execute(null);
    }

    void Answer(bool yes)
    {
        if (yes) dialog.OkCommand.Execute(null);
        else dialog.CancelCommand.Execute(null);
        Close();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.Key == Key.Escape) { e.Handled = true; Answer(false); }
        else if (e.Key is Key.Enter or Key.Return) { e.Handled = true; Answer(true); }
    }
}
