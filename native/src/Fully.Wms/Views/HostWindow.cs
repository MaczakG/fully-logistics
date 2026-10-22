using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Views;

// A window for one page on the desktop: a record (an inbound, a product ...) beside the main
// window, or a small modal dialog for a form. Esc closes a dialog, Ctrl+W a record window, F5
// reloads the page.
public sealed class HostWindow : Window
{
    public HostWindow(PageViewModel page, bool dialog)
    {
        Page = page;
        ForDialog = dialog;
        DataContext = page;
        Content = new PageHost { DataContext = page };
        Icon = AppIcon;
        UpdateTitle();
        page.PropertyChanged += (_, e) => { if (e.PropertyName is nameof(PageViewModel.Title) or null) UpdateTitle(); };
        if (dialog)
        {
            Width = page.DialogWidth;
            MinWidth = 360;
            MinHeight = 160;
            SizeToContent = SizeToContent.Height;
            CanResize = true;
            ShowInTaskbar = false;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
        }
        else
        {
            Width = page.RecordWidth;
            Height = 780;
            MinWidth = 420;
            MinHeight = 400;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
    }

    public PageViewModel Page { get; }
    public bool ForDialog { get; }

    // Closes without asking about unsaved changes (signing out, already asked).
    public bool Force { get; set; }

    // A page with unsaved changes is closed only after a yes.
    protected override void OnClosing(WindowClosingEventArgs e)
    {
        base.OnClosing(e);
        if (e.Cancel || Force || e.CloseReason != WindowCloseReason.WindowClosing || !Page.HasUnsavedChanges) return;
        e.Cancel = true;
        _ = AskAsync();
    }

    async Task AskAsync()
    {
        if (!await Page.Shell.ConfirmAsync("Nem mentett változások", PageViewModel.UnsavedQuestion, "Bezárás mentés nélkül", "Mégse", danger: true)) return;
        Force = true;
        Close();
    }

    static WindowIcon? AppIcon => icon ??= LoadIcon();
    static WindowIcon? icon;

    static WindowIcon? LoadIcon()
    {
        try { return new WindowIcon(AssetLoader.Open(new Uri("avares://Fully.Wms/Assets/app.ico"))); }
        catch (Exception e) when (e is FileNotFoundException or InvalidOperationException) { return null; }
    }

    void UpdateTitle() => Title = ForDialog ? Page.Title : $"{Page.Title} · Fully WMS";

    // The dialog is never taller than the screen it opens on; its page scrolls.
    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);
        if (Screens.ScreenFromWindow(this) is { } screen)
        {
            var area = screen.WorkingArea.Size.ToSize(screen.Scaling);
            MaxHeight = area.Height * 0.9;
            if (!ForDialog)
            {
                Width = Math.Min(Width, area.Width * 0.92);
                Height = Math.Min(Height, area.Height * 0.9);
            }
        }
    }

    protected override async void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.Handled) return;
        if (e.Key == Key.Escape && ForDialog)
        {
            e.Handled = true;
            Close();
        }
        else if (e.Key == Key.W && e.KeyModifiers.HasFlag(KeyModifiers.Control) && !ForDialog)
        {
            e.Handled = true;
            Close();
        }
        else if (e.Key == Key.F5)
        {
            e.Handled = true;
            await Page.ReloadAsync();
        }
    }
}
