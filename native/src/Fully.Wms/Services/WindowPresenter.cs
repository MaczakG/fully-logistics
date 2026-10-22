using Avalonia.Controls;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms.Services;

// The desktop's windows, like a classic Windows application: lists in the main window, every
// record in its own window (several side by side; opening an open record brings its window to the
// front), forms and small steps as modal dialogs over the window they were opened from. Closing a
// dialog reloads the page under it, closing a record window reloads the main window's list.
public sealed class WindowPresenter(ShellViewModel shell, Window main) : IPagePresenter
{
    readonly List<HostWindow> records = [];
    readonly List<HostWindow> dialogs = [];

    public IReadOnlyList<HostWindow> Records => records;
    public IReadOnlyList<HostWindow> Dialogs => dialogs;

    HostWindow? ActiveRecord => records.FirstOrDefault((w) => w.IsActive);

    // The window a call comes from: the dialog on top, the record window in use, or the main one.
    Window Top => dialogs.Count > 0 ? dialogs[^1] : ActiveRecord ?? (Window)main;

    public bool Takes(PageViewModel page) => page.Kind != PageKind.Page || (dialogs.Count == 0 && ActiveRecord is not null);

    public async Task ShowAsync(PageViewModel page)
    {
        if (page.Kind == PageKind.Dialog)
        {
            ShowDialog(page);
            await page.ReloadAsync();
            return;
        }
        if (page.RecordKey is { } key && records.FirstOrDefault((w) => w.Page.RecordKey == key) is { } open)
        {
            open.Activate();
            await open.Page.ReloadAsync();
            return;
        }
        var w = new HostWindow(page, dialog: false);
        // A little lower and to the right of the previous one, so they do not cover each other.
        if (records.Count > 0 && records[^1].Position is var p)
        {
            w.WindowStartupLocation = WindowStartupLocation.Manual;
            w.Position = new Avalonia.PixelPoint(p.X + 32, p.Y + 32);
        }
        records.Add(w);
        w.Closed += async (_, _) =>
        {
            records.Remove(w);
            if (shell.Current is { } current && shell.IsSignedIn) await current.ReloadAsync();
        };
        w.Show();
        await page.ReloadAsync();
    }

    void ShowDialog(PageViewModel page)
    {
        var owner = Top;
        var under = owner is HostWindow h ? h.Page : shell.Current;
        var w = new HostWindow(page, dialog: true);
        dialogs.Add(w);
        w.Closed += async (_, _) =>
        {
            dialogs.Remove(w);
            if (under is not null && shell.IsSignedIn) await under.ReloadAsync();
        };
        _ = w.ShowDialog(owner);
    }

    public Task<bool> BackAsync()
    {
        if (dialogs.Count > 0)
        {
            dialogs[^1].Close();
            return Task.FromResult(true);
        }
        if (ActiveRecord is { } r)
        {
            r.Close();
            return Task.FromResult(true);
        }
        return Task.FromResult(false);
    }

    // A tab of a list opened in a record window changes that window's page.
    public bool Replace(PageViewModel page)
    {
        if (dialogs.Count > 0 || ActiveRecord is not { } r) return false;
        var w = new HostWindow(page, dialog: false) { Position = r.Position, Width = r.Width, Height = r.Height, WindowStartupLocation = WindowStartupLocation.Manual };
        records.Add(w);
        w.Closed += (_, _) => records.Remove(w);
        w.Show();
        r.Close();
        _ = page.ReloadAsync();
        return true;
    }

    // The message box being shown, if any.
    public MessageWindow? Message { get; private set; }

    public async Task<bool> ConfirmAsync(DialogViewModel dialog)
    {
        var box = new MessageWindow(dialog);
        Message = box;
        try
        {
            await box.ShowDialog(Top);
        }
        finally
        {
            Message = null;
        }
        return await dialog.Result;
    }

    public void ActivateMain() => main.Activate();

    public void CloseAll()
    {
        foreach (var d in dialogs.ToList()) d.Close();
        foreach (var r in records.ToList()) r.Close();
    }
}
