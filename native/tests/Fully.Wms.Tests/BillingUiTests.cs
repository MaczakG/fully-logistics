using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.Billing;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Tests;

// The billing screens: the month's overview, statements made for the selected client, a statement
// with its lines and drill-down lists, a manual line, approval, voiding, made again and deleted; the
// recorded items added, changed and deleted.
[Collection("Billing")]
public class BillingUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 150 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    static async Task AnswerAsync(ShellViewModel shell, bool ok = true)
    {
        await WaitAsync(() => shell.Dialog is not null);
        if (ok) shell.Dialog!.OkCommand.Execute(null);
        else shell.Dialog!.CancelCommand.Execute(null);
    }

    [AvaloniaFact]
    public async Task Desktop_statements_of_the_month()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1400, 1000);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("billing");
        var page = Assert.IsType<BillingViewModel>(shell.Current);
        var tab = page.Overview;
        await WaitAsync(() => tab.Data is not null);
        Assert.Equal(BillingFormat.DefaultPeriod, page.PeriodKey);
        Assert.True(page.CanNext);
        Assert.NotNull(tab.InvoicingWarning);

        // This month: the statement of one selected client made.
        page.NextCommand.Execute(null);
        await WaitAsync(() => !page.IsLoading && tab.Data?.Period == BillingFormat.ThisMonth);
        Assert.False(page.CanNext);
        var mancs = tab.Items.Single((i) => i.Row.PartnerId == 1);
        mancs.IsSelected = true;
        Assert.Equal(1, tab.SelectedCount);
        Assert.Contains("1 kijelölt", tab.GenerateText);
        var generating = tab.GenerateCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await generating;
        await WaitAsync(() => tab.Items.Single((i) => i.Row.PartnerId == 1).Row.Status == "draft");
        Screens.Save(window, "billing-overview");

        // The statement: lines by group, drill-down lists.
        tab.Items.Single((i) => i.Row.PartnerId == 1).OpenCommand.Execute(null);
        await WaitAsync(() => shell.Current is StatementViewModel { Data: not null, DrillKind: not null });
        var st = (StatementViewModel)shell.Current!;
        Assert.True(st.IsDraft && st.CanApprove && st.ApproveEnabled && st.CanAddLine && st.CanDelete);
        Assert.False(st.CanInvoice);
        Assert.Equal("orders", st.DrillKind);
        Assert.NotEmpty(st.DrillOrders);
        Assert.Contains(st.Groups, (g) => g.Label == "Tárolás");
        var bas = st.Groups[0].Lines[0];
        Assert.Contains("rendelés", bas.Sub);
        Assert.True(bas.CanDrill);
        Screens.Save(window, "billing-statement");
        await st.DrillCommand.ExecuteAsync(st.DrillTabs.Single((t) => t.Key == "storage"));
        Assert.True(st.IsStorage && st.DrillStorage.Count > 0);
        Assert.Contains("Arányos díj", st.DrillNote);
        window.Height = 2200;
        Screens.Save(window, "billing-statement-full");
        window.Height = 1000;

        // A manual credit line, then removed.
        var net = st.Data!.Net;
        await st.AddLineCommand.ExecuteAsync(null);
        var line = Assert.IsType<ManualLineViewModel>(shell.Current);
        await line.LoadAsync();
        Assert.Equal("custom", line.Group?.Key);
        await line.SaveCommand.ExecuteAsync(null);
        Assert.True(line.Errors.ContainsKey("name"));
        line.Name = "Kedvezmény teszt";
        line.Group = line.Groups.Single((g) => g.Key == "discount");
        line.Price = "-1500";
        Screens.Save(window, "billing-manual-line");
        await line.SaveCommand.ExecuteAsync(null);
        Assert.Same(st, shell.Current);
        await WaitAsync(() => st.Data?.Net == net - 1500);
        var manual = st.Groups.SelectMany((g) => g.Lines).Single((l) => l.Line.Manual);
        Assert.True(manual.CanRemove);
        Assert.StartsWith("Kézi tétel", manual.Sub);
        manual.RemoveCommand.Execute(null);
        await AnswerAsync(shell);
        await WaitAsync(() => st.Data?.Net == net);

        // Approved, voided with a reason, made again, deleted.
        var approving = st.ApproveCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await approving;
        Assert.True(st.IsApproved && st.CanVoid && st.CanInvoice);
        Assert.False(st.InvoiceEnabled);
        Assert.NotNull(st.InvoicingWarning);
        Screens.Save(window, "billing-approved");
        await st.VoidCommand.ExecuteAsync(null);
        var voiding = Assert.IsType<VoidViewModel>(shell.Current);
        await voiding.SaveCommand.ExecuteAsync(null);
        Assert.True(voiding.Errors.ContainsKey("reason"));
        voiding.Reason = "Hibás tarifával készült";
        await voiding.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => st.IsVoid);
        Assert.Contains("Hibás tarifával készült", st.VoidText);
        Assert.Equal("Újrakészítés piszkozatként", st.RegenerateText);
        await st.RegenerateCommand.ExecuteAsync(null);
        Assert.True(st.IsDraft);
        var deleting = st.DeleteCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await deleting;
        Assert.Same(page, shell.Current);
        await WaitAsync(() => !page.IsLoading && tab.Items.Single((i) => i.Row.PartnerId == 1).IsNone);
    }

    [AvaloniaFact]
    public async Task Desktop_recorded_items()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1400, 900);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("billing");
        var page = Assert.IsType<BillingViewModel>(shell.Current);
        await WaitAsync(() => page.Overview.Data is not null);
        await page.SelectTabCommand.ExecuteAsync(page.Tabs.Single((t) => t.Key == "entries"));
        page.Go(BillingFormat.ThisMonth);
        var tab = page.Entries;
        await WaitAsync(() => !page.IsLoading && tab.Clients.Count > 1 && tab.Items.Count > 0);
        var before = tab.Total;

        // A per unit item of a client.
        await tab.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<EntryFormViewModel>(shell.Current);
        await form.LoadAsync();
        form.Client = form.Clients.Single((c) => c.Key == "1");
        form.Kind = EntryFormViewModel.Kinds.Single((k) => k.Key == "custom");
        await WaitAsync(() => form.Items.Count > 0);
        Assert.NotNull(form.Item);
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("qty"));
        form.Qty = "5";
        form.Note = "Natív UI teszt";
        Screens.Save(window, "billing-entry-new");
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Same(page, shell.Current);
        await WaitAsync(() => !page.IsLoading && tab.Total == before + 1);
        var item = tab.Items.Single((i) => i.Entry.Note == "Natív UI teszt");
        Assert.True(item.CanEdit && item.CanDelete);
        Screens.Save(window, "billing-entries");

        // Changed, then deleted.
        item.EditCommand.Execute(null);
        await WaitAsync(() => shell.Current is EntryFormViewModel { IsNew: false });
        var edit = (EntryFormViewModel)shell.Current!;
        await edit.LoadAsync();
        Assert.Equal("5", edit.Qty);
        edit.Qty = "7";
        await edit.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => !page.IsLoading && tab.Items.Any((i) => i.Entry.Note == "Natív UI teszt" && i.Entry.Qty == 7));
        item = tab.Items.Single((i) => i.Entry.Note == "Natív UI teszt");
        item.DeleteCommand.Execute(null);
        await AnswerAsync(shell);
        await WaitAsync(() => !page.IsLoading && tab.Total == before);
    }
}
