using CommunityToolkit.Mvvm.ComponentModel;
using Fully.Wms.Core;

namespace Fully.Wms.ViewModels;

// One screen. The shell keeps them in a stack (home, list, detail ...) and calls LoadAsync every
// time a page comes to the front, so a list shows fresh data after returning from a detail.
public abstract partial class PageViewModel(ShellViewModel shell) : ViewModelBase
{
    public ShellViewModel Shell { get; } = shell;
    protected ApiClient Api => Shell.Services.Api;

    public abstract string Title { get; }

    // The module this page belongs to (highlights it in the side menu), null for home.
    public virtual string? Module => null;

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
