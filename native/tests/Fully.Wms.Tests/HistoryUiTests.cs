using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.History;
using Fully.Wms.Modules.Orders;

namespace Fully.Wms.Tests;

// The history screens: the list with key figures, quick ranges and export, a closed order marked
// delivered, a return of everything with a photo (orders 2 and 4 of the demo data); the worker's
// phone sees the list only.
[Collection("Picking")]
public class HistoryUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    [AvaloniaFact]
    public async Task Desktop_history_delivered_and_return()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("history");
        var list = Assert.IsType<HistoryViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Assert.NotNull(list.Kpis);
        Screens.Save(window, "history-list-desktop");

        list.ShowCommand.Execute("delivered");
        await WaitAsync(() => !list.IsLoading && list.Items.All((i) => i.Row.Status == "delivered"));
        await list.RangeCommand.ExecuteAsync("30");
        Assert.NotNull(list.From);
        await list.ClearFiltersCommand.ExecuteAsync(null);
        Assert.Null(list.From);
        await list.ExportCommand.ExecuteAsync(null);
        var export = Assert.IsType<TestPlatform>(shell.Services.Platform).Opened.Single();
        Assert.EndsWith(".csv", export.FileName);

        // Order 2: delivered.
        await shell.NavigateAsync(new OrderViewModel(shell, 2));
        var two = Assert.IsType<OrderViewModel>(shell.Current);
        if (two.Status == "shipped")
        {
            Assert.True(two.CanDeliver);
            Screens.Save(window, "history-shipped-desktop");
            var delivering = two.DeliveredCommand.ExecuteAsync(null);
            await WaitAsync(() => shell.Dialog is not null);
            shell.Dialog!.OkCommand.Execute(null);
            await delivering;
            Assert.Equal("delivered", two.Status);
        }
        await shell.BackAsync();

        // Order 4: everything returned, with a photo.
        await shell.NavigateAsync(new OrderViewModel(shell, 4));
        var four = Assert.IsType<OrderViewModel>(shell.Current);
        if (!four.CanReturn) Assert.Skip("A 4-es rendelés már nem küldhető vissza (indítsd újra a szervert).");
        Assert.Equal("return", four.Primary);
        await four.ReturnCommand.ExecuteAsync(null);
        var form = Assert.IsType<ReturnFormViewModel>(shell.Current);
        await WaitAsync(() => form.Rows.Count > 0);
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Equal("Legalább egy tételnél adj meg darabszámot.", form.Error);
        form.AllCommand.Execute(null);
        Assert.All(form.Rows, (r) => Assert.NotEqual("0", r.Qty));
        // "Másik állapot": a damaged row for quarantine (left at 0 here); the goods go back onto a shelf.
        form.Rows[0].SplitCommand.Execute(null);
        Assert.Equal("damaged", form.Rows[1].Condition.Key);
        Assert.Equal("0", form.Rows[1].Qty);
        Assert.StartsWith("Karantén", form.Rows[1].Location!.Label);
        foreach (var row in form.Rows.Where((r) => r.Condition.Key == "sellable"))
            row.Location = row.Locations.FirstOrDefault((l) => l.Label.StartsWith("Vissza a polcra")) ?? row.Location;
        form.Reason = "Elállás (14 napon belül)";
        form.AddPhoto("doboz.png", HistoryLiveTests.Png);
        Screens.Save(window, "history-return-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Null(form.Error);
        Assert.Same(four, shell.Current);
        Assert.Equal("returned", four.Status);
        Assert.True(four.HasReturns);
        Assert.False(four.CanReturn);
        Assert.Single(four.Returns.Single().Photos);
        Screens.Save(window, "history-returned-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_worker_sees_history()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("history");
        var list = Assert.IsType<HistoryViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Screens.Save(window, "history-list-phone");
        list.Selected = list.Items[0];
        await WaitAsync(() => shell.Current is OrderViewModel { Data: not null });
        var order = (OrderViewModel)shell.Current!;
        Assert.False(order.CanReturn);
        Assert.False(order.CanDeliver);
        Screens.Save(window, "history-detail-phone");
    }
}
