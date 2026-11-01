namespace Fully.Wms.ViewModels;

// A module not built yet in the native app.
public sealed class PlaceholderViewModel(ShellViewModel shell, string module, string title) : PageViewModel(shell)
{
    public override string Title => title;
    public override string? Module => module;
}
