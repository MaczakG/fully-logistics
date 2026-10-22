using System.Windows.Input;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;

namespace Fully.Wms.Controls;

public partial class ScanField : UserControl
{
    public static readonly StyledProperty<string> PlaceholderProperty =
        AvaloniaProperty.Register<ScanField, string>(nameof(Placeholder), "Vonalkód vagy cikkszám");

    // Runs with the code (trimmed, never empty) when Enter is pressed or the camera reads one.
    public static readonly StyledProperty<ICommand?> CommandProperty =
        AvaloniaProperty.Register<ScanField, ICommand?>(nameof(Command));

    // Desktop: the field takes the focus when it appears, so a hand scanner can be used at once.
    public static readonly StyledProperty<bool> AutoFocusProperty =
        AvaloniaProperty.Register<ScanField, bool>(nameof(AutoFocus), true);

    public ScanField()
    {
        InitializeComponent();
        Input.KeyDown += OnKeyDown;
        GoButton.Click += (_, _) => Submit(Input.Text);
        CameraButton.Click += OnCamera;
        CameraButton.IsVisible = App.Platform.Scanner is not null;
    }

    public string Placeholder
    {
        get => GetValue(PlaceholderProperty);
        set => SetValue(PlaceholderProperty, value);
    }

    public ICommand? Command
    {
        get => GetValue(CommandProperty);
        set => SetValue(CommandProperty, value);
    }

    public bool AutoFocus
    {
        get => GetValue(AutoFocusProperty);
        set => SetValue(AutoFocusProperty, value);
    }

    public void FocusInput() => Dispatcher.UIThread.Post(() => Input.Focus(), DispatcherPriority.Input);

    protected override void OnLoaded(RoutedEventArgs e)
    {
        base.OnLoaded(e);
        // Not on the phone: the on-screen keyboard would cover half of the screen.
        if (AutoFocus && !App.Platform.IsPhone) FocusInput();
    }

    void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key is not (Key.Enter or Key.Return)) return;
        e.Handled = true;
        Submit(Input.Text);
    }

    async void OnCamera(object? sender, RoutedEventArgs e)
    {
        if (App.Platform.Scanner is not { } scanner) return;
        try
        {
            var code = await scanner.ScanAsync();
            if (code is not null) Submit(code);
        }
        catch (InvalidOperationException ex)
        {
            if (DataContext is ViewModels.PageViewModel page) page.Shell.Toast(ex.Message, ViewModels.ToastKind.Error);
        }
    }

    void Submit(string? text)
    {
        var code = (text ?? "").Trim();
        Input.Text = "";
        if (code.Length == 0) return;
        if (Command?.CanExecute(code) == true) Command.Execute(code);
        if (!App.Platform.IsPhone) FocusInput();
    }
}
