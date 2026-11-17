using Fully.Wms.ViewModels;

namespace Fully.Wms.Services;

// Shows records and dialogs in windows (the desktop). The shell asks it first and falls back to
// its own page stack for what it does not take.
public interface IPagePresenter
{
    // Whether this page goes into a window (a record, a dialog, or any page opened from a record
    // window).
    bool Takes(PageViewModel page);

    Task ShowAsync(PageViewModel page);

    // Closes the dialog on top, or the active record window. False: nothing was closed (the main
    // window's own Back).
    Task<bool> BackAsync();

    // Another page in place of the one in the record window in use (tabs). False: not in one.
    bool Replace(PageViewModel page);

    Task<bool> ConfirmAsync(DialogViewModel dialog);

    // Brings the main window to the front (a module was chosen in its menu).
    void ActivateMain();

    // A record window has changes not saved yet.
    bool HasUnsaved { get; }

    // Closes every record and dialog window (sign-out), without asking.
    void CloseAll();
}
