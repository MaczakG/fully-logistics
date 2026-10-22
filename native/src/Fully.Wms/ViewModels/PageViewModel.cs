using CommunityToolkit.Mvvm.ComponentModel;
using Fully.Wms.Core;

namespace Fully.Wms.ViewModels;

// How a page is shown on the desktop. The phone (and the tests) show every page in the one view,
// one after the other, with Back.
public enum PageKind
{
    // A list or start page: in the main window.
    Page,
    // One record (an inbound, a product, an order ...): in its own window, several side by side.
    Record,
    // A form or a small step (edit, new, arrival, settings ...): a small modal window over the
    // window it was opened from; saving goes back (Shell.BackAsync) and closes it.
    Dialog,
}

// One screen. The shell keeps them in a stack (home, list, detail ...) and calls LoadAsync every
// time a page comes to the front, so a list shows fresh data after returning from a detail.
public abstract partial class PageViewModel(ShellViewModel shell) : ViewModelBase
{
    public ShellViewModel Shell { get; } = shell;
    protected ApiClient Api => Shell.Services.Api;

    public abstract string Title { get; }

    // The module this page belongs to (highlights it in the side menu), null for home.
    public virtual string? Module => null;

    public virtual PageKind Kind => PageKind.Page;

    // Records: the same key means the same record, so its open window comes to the front instead
    // of a second one ("inbound:12"). Null: always a new window.
    public virtual string? RecordKey => null;

    // Dialogs: the width of the window (its height follows the content).
    public virtual double DialogWidth => 560;

    // Records: the width of their window.
    public virtual double RecordWidth => 1120;

    // Changes not saved yet (a quote being written): closing its window asks first.
    public virtual bool HasUnsavedChanges => false;

    public const string UnsavedQuestion = "A módosítások nincsenek mentve. Bezárod mentés nélkül?";

    [ObservableProperty]
    public partial bool IsLoading { get; set; }

    // A message that replaces the page when it could not be loaded.
    [ObservableProperty]
    public partial string? LoadError { get; set; }

    public bool IsCompact => Shell.IsCompact;

    public virtual Task LoadAsync() => Task.CompletedTask;

    // Loads with the busy indicator; a failure shows on the page with a retry button.
    public async Task ReloadAsync()
    {
        IsLoading = true;
        LoadError = null;
        try
        {
            await LoadAsync();
        }
        catch (ApiException e) when (e.Status != 401)
        {
            LoadError = e.Message;
        }
        finally
        {
            IsLoading = false;
        }
    }

    // Runs a user action: errors become a toast, the busy flag guards against double taps.
    protected Task<bool> RunAsync(Func<Task> action) => Shell.RunAsync(action, this);

    internal void OnCompactChanged() => OnPropertyChanged(nameof(IsCompact));
}
