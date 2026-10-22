using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.Stock;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms.Tests;

// The desktop's windows: a record opens in its own window (once per record), a form in a modal
// dialog over it, saving closes the dialog and reloads the record, questions are message boxes.
public class WindowsUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [AvaloniaFact]
    public async Task Records_open_in_windows_and_forms_in_dialogs()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("stock");
        var list = Assert.IsType<StockViewModel>(shell.Current);
        var row = list.Items.First((r) => r.Locations > 0);

        // A record: its own window, the main window keeps the list.
        await shell.NavigateAsync(new StockProductViewModel(shell, row.ProductId));
        Screens.Settle();
        var record = Assert.Single(presenter.Records);
        Assert.IsType<StockProductViewModel>(record.Page);
        Assert.Same(list, shell.Current);
        Assert.Contains(row.Sku, record.Title);
        Screens.Save(record, "window-record");

        // The same record again: the same window.
        await shell.NavigateAsync(new StockProductViewModel(shell, row.ProductId));
        Assert.Single(presenter.Records);

        // A form from the record: a modal dialog over it.
        record.Activate();
        Screens.Settle();
        var product = (StockProductViewModel)record.Page;
        await product.TransferCommand.ExecuteAsync(product.Rows[0]);
        Screens.Settle();
        var dialog = Assert.Single(presenter.Dialogs);
        Assert.IsType<StockTransferViewModel>(dialog.Page);
        Assert.True(dialog.Width <= 640);
        Screens.Save(dialog, "window-dialog");

        // Back (as after saving) closes the dialog only.
        await shell.BackAsync();
        Screens.Settle();
        Assert.Empty(presenter.Dialogs);
        Assert.Single(presenter.Records);

        // Back from the record window closes it.
        record.Activate();
        Screens.Settle();
        await shell.BackAsync();
        Screens.Settle();
        Assert.Empty(presenter.Records);
        Assert.Same(list, shell.Current);

        // Signing out closes every window.
        await shell.NavigateAsync(new StockProductViewModel(shell, row.ProductId));
        await shell.NavigateAsync(new ProfileViewModel(shell));
        Assert.NotEmpty(presenter.Records);
        Assert.NotEmpty(presenter.Dialogs);
        shell.SignedOut(null);
        Screens.Settle();
        Assert.Empty(presenter.Records);
        Assert.Empty(presenter.Dialogs);
    }

    [AvaloniaFact]
    public async Task Questions_are_message_boxes()
    {
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1000, 700);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        var answer = shell.ConfirmAsync("Törlés", "Biztosan?", "Törlés", danger: true);
        Screens.Settle();
        if (answer.IsFaulted) throw answer.Exception!;
        var box = Assert.IsType<MessageWindow>(presenter.Message);
        Screens.Save(box, "window-message");
        box.Close();
        Assert.False(await answer.WaitAsync(TimeSpan.FromSeconds(5), Ct));
        Assert.Null(shell.Dialog);
    }
}
