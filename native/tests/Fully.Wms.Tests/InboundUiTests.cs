using Avalonia.Headless.XUnit;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Inbound;

namespace Fully.Wms.Tests;

// The receiving screen as a worker uses it: scan, count by scanning, type a quantity, record,
// confirm an overage, switch to putaway, take the suggested location.
public class InboundUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [AvaloniaFact]
    public async Task Desktop_receive_by_scanning_and_typed_quantity_then_putaway()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("inbound");
        var list = Assert.IsType<InboundListViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Screens.Save(window, "inbound-list-desktop");

        var row = list.Items.FirstOrDefault((r) => r.Status == "receiving") ?? list.Items[0];
        await shell.NavigateAsync(new InboundViewModel(shell, row.Id));
        var page = Assert.IsType<InboundViewModel>(shell.Current);
        Assert.NotNull(page.Data);
        if (page.IsExpected)
        {
            await page.ArriveCommand.ExecuteAsync(null);
            var arrive = Assert.IsType<InboundArriveViewModel>(shell.Current);
            await arrive.SaveCommand.ExecuteAsync(null);
            Assert.Same(page, shell.Current);
        }
        Assert.True(page.Working);
        await page.SetModeCommand.ExecuteAsync("receive");

        var line = page.Data!.Lines.FirstOrDefault((l) => l.LeftToReceive > 2 && !l.NeedsLot && !l.NeedsExpiry && l.Ean is { Length: > 0 });
        if (line is null) Assert.Skip("Nincs számolható tétel a mintaadatokban.");

        // Scan opens the entry with 1; the same product again adds one.
        await page.ScanCommand.ExecuteAsync(line.Ean!);
        Assert.NotNull(page.Entry);
        Assert.Equal(line.Id, page.Entry!.Line.Id);
        Assert.Equal("1", page.Entry.Qty);
        await page.ScanCommand.ExecuteAsync(line.Ean!);
        Assert.Equal("2", page.Entry.Qty);
        Assert.Equal("ok", page.FeedbackTone);
        Screens.Save(window, "inbound-entry-desktop");

        // A typed quantity, recorded.
        page.Entry.Qty = "2";
        await page.CommitEntryCommand.ExecuteAsync(null);
        Assert.Null(page.Entry);
        Assert.Equal("ok", page.FeedbackTone);
        Assert.Equal(line.ReceivedQty + 2, page.Data.Lines.Single((l) => l.Id == line.Id).ReceivedQty);

        // More than expected asks first; "Mégse" records nothing.
        await page.ScanCommand.ExecuteAsync(line.Sku);
        page.Entry!.Qty = (line.LeftToReceive + 5).ToString();
        var commit = page.CommitEntryCommand.ExecuteAsync(null);
        for (var i = 0; i < 50 && shell.Dialog is null; i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.NotNull(shell.Dialog);
        Assert.Equal("Több a vártnál", shell.Dialog!.Title);
        Screens.Save(window, "inbound-overage-desktop");
        shell.Dialog.CancelCommand.Execute(null);
        await commit;
        Assert.NotNull(page.Entry);
        page.CancelEntryCommand.Execute(null);

        // Putaway: the product, then the suggested location, then the quantity.
        await page.SetModeCommand.ExecuteAsync("putaway");
        await page.ScanCommand.ExecuteAsync(line.Sku);
        Assert.NotNull(page.PutLine);
        Assert.NotNull(page.PutSuggestion);
        page.UseSuggestedCommand.Execute(null);
        Assert.Equal(page.PutSuggestion!.Code, page.PutLocation);
        page.PutQty = "1";
        Screens.Save(window, "inbound-putaway-desktop");
        var before = page.Data.Lines.Single((l) => l.Id == line.Id).PutawayQty;
        await page.PutAwayCommand.ExecuteAsync(null);
        Assert.Equal("ok", page.FeedbackTone);
        Assert.Equal(before + 1, page.Data.Lines.Single((l) => l.Id == line.Id).PutawayQty);
        Screens.Save(window, "inbound-after-putaway-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_worker_receives_a_tracked_product()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("inbound");
        var list = Assert.IsType<InboundListViewModel>(shell.Current);
        Screens.Save(window, "inbound-list-phone");

        // An open inbound with a lot or expiry tracked line that has nothing on a shelf yet.
        InboundViewModel? page = null;
        InboundLine? line = null;
        foreach (var row in list.Items)
        {
            var p = new InboundViewModel(shell, row.Id);
            await shell.NavigateAsync(p);
            line = p.Data!.Lines.FirstOrDefault((l) => (l.NeedsLot || l.NeedsExpiry) && l.Ean is { Length: > 0 });
            if (line is not null) { page = p; break; }
            await shell.BackAsync();
        }
        if (page is null || line is null) Assert.Skip("Nincs sarzskövetett, polcra még nem került tétel a mintaadatokban.");
        if (page.IsExpected)
        {
            await page.ArriveCommand.ExecuteAsync(null);
            await Assert.IsType<InboundArriveViewModel>(shell.Current).SaveCommand.ExecuteAsync(null);
        }
        Screens.Save(window, "inbound-detail-phone");

        await page.SetModeCommand.ExecuteAsync("receive");
        await page.ScanCommand.ExecuteAsync(line.Ean!);
        var entry = Assert.IsType<ReceiveEntry>(page.Entry);
        entry.Qty = "4";
        await page.CommitEntryCommand.ExecuteAsync(null);
        // Lot or expiry is missing: nothing is recorded, the fields say why.
        Assert.NotNull(page.Entry);
        Assert.Equal("danger", page.FeedbackTone);
        Assert.True(entry.LotError is not null || entry.ExpiryError is not null);
        Screens.Save(window, "inbound-entry-phone");

        if (line.NeedsLot) entry.Lot = "NAT-TESZT-1";
        if (line.NeedsExpiry) entry.Expiry = "2028-12-31";
        await page.CommitEntryCommand.ExecuteAsync(null);
        Assert.Null(page.Entry);
        Assert.Equal("ok", page.FeedbackTone);
        var after = page.Data!.Lines.Single((l) => l.Id == line.Id);
        Assert.Equal(line.ReceivedQty + 4, after.ReceivedQty);
        if (line.NeedsLot) Assert.Equal("NAT-TESZT-1", after.Lot);
        Screens.Save(window, "inbound-recorded-phone");
    }
}
