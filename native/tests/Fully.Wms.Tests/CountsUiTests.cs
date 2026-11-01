using Avalonia.Headless.XUnit;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Counts;

namespace Fully.Wms.Tests;

// Counting as the warehouse does it: a new count, the counting screen with scans, a typed
// quantity, a found product, location done, finishing, then review and posting; and the PDA on the
// phone with a blind count.
[Collection("Counts")]
public class CountsUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    [AvaloniaFact]
    public async Task Desktop_new_count_counting_review_and_posting()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("counts");
        var list = Assert.IsType<CountsViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Screens.Save(window, "counts-list-desktop");

        // The demo data's count.
        await shell.NavigateAsync(new CountViewModel(shell, list.Items[0].Id));
        var demo = Assert.IsType<CountViewModel>(shell.Current);
        Assert.NotEmpty(demo.Groups);
        Screens.Save(window, "counts-detail-desktop");
        await shell.BackAsync();

        // A new cycle count of two locations in zone C.
        await list.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<NewCountViewModel>(shell.Current);
        await WaitAsync(() => form.CycleZones.Count > 1);
        form.Limit = "2";
        form.CycleZone = form.CycleZones.Single((z) => z.Key == "C");
        form.Blind = false;
        Screens.Save(window, "counts-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Null(form.Error);
        var count = Assert.IsType<CountViewModel>(shell.Current);
        Assert.Equal("open", count.Status);
        Assert.True(count.CountPrimary);

        // Counting: the next location, a wrong code, the products.
        await count.CountCommand.ExecuteAsync(null);
        var counting = Assert.IsType<CountingViewModel>(shell.Current);
        Assert.True(counting.CanWork);
        Assert.True(counting.HasNext);
        Screens.Save(window, "counts-counting-start-desktop");
        await counting.ScanCommand.ExecuteAsync("NINCS-ILYEN-HELY");
        Assert.Equal("danger", counting.FeedbackTone);
        var first = counting.NextLocation!.Location;
        await counting.ScanCommand.ExecuteAsync(first.Code.ToLowerInvariant());
        Assert.Equal(first.Code, counting.Current!.Location.Code);
        if (counting.Lines.FirstOrDefault() is { } item)
        {
            // A scan adds one; a typed quantity replaces it.
            await counting.ScanCommand.ExecuteAsync(item.Line.Ean.Length > 0 ? item.Line.Ean : item.Line.Sku);
            Assert.Equal("ok", counting.FeedbackTone);
            Assert.Equal(1, counting.Current.Lines.Single((l) => l.Id == item.Line.Id).CountedQty);
            var typed = counting.Lines.Single((l) => l.Line.Id == item.Line.Id);
            typed.Qty = item.Line.ExpectedQty?.ToString() ?? "1";
            await typed.SaveCommand.ExecuteAsync(null);
            Assert.Equal(item.Line.ExpectedQty ?? 1, counting.Current.Lines.Single((l) => l.Id == item.Line.Id).CountedQty);
        }

        // A found product, searched by hand, then removed.
        var partner = counting.Current.Lines.FirstOrDefault((l) => l.HasProduct)?.PartnerId;
        var lookup = await shell.Services.Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", partner), ("q", "DEMO")), Ct);
        var product = lookup.Items.First((p) => counting.Current.Lines.All((l) => l.ProductId != p.Id));
        await counting.AddProductCommand.ExecuteAsync(null);
        var found = Assert.IsType<CountFoundViewModel>(shell.Current);
        Assert.True(found.Searching);
        await found.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(found.ProductError);
        found.Product = product;
        found.Qty = "3";
        Screens.Save(window, "counts-found-desktop");
        await found.SaveCommand.ExecuteAsync(null);
        Assert.Same(counting, shell.Current);
        var added = counting.Lines.Single((l) => l.Line.ProductId == product.Id);
        Assert.True(added.Line.Added);
        Assert.Equal(3, added.Line.CountedQty);
        Assert.StartsWith("Felvéve", counting.Feedback);
        Screens.Save(window, "counts-location-desktop");
        var removing = added.RemoveCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        shell.Dialog!.OkCommand.Execute(null);
        await removing;
        Assert.DoesNotContain(counting.Lines, (l) => l.Line.ProductId == product.Id);

        // Every location done (uncounted lines become 0 after the question), then finish.
        for (var guard = 0; guard < 10 && (counting.HasCurrent || counting.HasNext); guard++)
        {
            if (!counting.HasCurrent) await counting.OpenNextCommand.ExecuteAsync(null);
            var completing = counting.CompleteCommand.ExecuteAsync(null);
            for (var i = 0; i < 20 && shell.Dialog is null && !completing.IsCompleted; i++) { Screens.Settle(); await Task.Delay(20, Ct); }
            if (shell.Dialog is { } q)
            {
                Assert.Equal("Hely kész?", q.Title);
                q.OkCommand.Execute(null);
            }
            await completing;
            Assert.False(counting.HasCurrent);
        }
        Assert.True(counting.AllDone);
        Screens.Save(window, "counts-all-done-desktop");
        var finishing = counting.FinishCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        shell.Dialog!.OkCommand.Execute(null);
        await finishing;
        Assert.Same(count, shell.Current);
        Assert.Equal("counted", count.Status);
        Assert.True(count.ReviewPrimary);

        // Review and posting.
        await count.ReviewCommand.ExecuteAsync(null);
        var review = Assert.IsType<CountReviewViewModel>(shell.Current);
        Assert.True(review.CanPost);
        foreach (var line in review.Groups.SelectMany((g) => g.Lines).Where((l) => l.ShowConfirm)) line.Confirmed = true;
        review.OnlyDiff = false;
        Assert.True(review.HasGroups);
        Screens.Save(window, "counts-review-desktop");
        var posting = review.PostCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        Assert.Equal("Eltérések könyvelése", shell.Dialog!.Title);
        shell.Dialog.OkCommand.Execute(null);
        await posting;
        Assert.Same(count, shell.Current);
        Assert.Equal("posted", count.Status);
        Assert.NotNull(count.PostedNotice);
        Screens.Save(window, "counts-posted-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_worker_counts_the_blind_count()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("counts");
        var list = Assert.IsType<CountsViewModel>(shell.Current);
        Assert.False(list.CanCreate);
        Screens.Save(window, "counts-list-phone");
        var row = list.Items.FirstOrDefault((r) => r.Blind && r.Status is "open" or "counting");
        if (row is null) Assert.Skip("Nincs folyamatban lévő vak leltár a mintaadatokban.");

        list.Selected = row;
        await WaitAsync(() => shell.Current is CountViewModel { Data: not null });
        var count = (CountViewModel)shell.Current!;
        Assert.False(count.Visible);
        Assert.False(count.CanReview);
        Screens.Save(window, "counts-detail-phone");

        await count.CountCommand.ExecuteAsync(null);
        var counting = Assert.IsType<CountingViewModel>(shell.Current);
        Screens.Save(window, "counts-counting-phone");
        var next = counting.NextLocation;
        if (next is null) Assert.Skip("A mintaadatok leltárában nincs számolatlan hely.");
        await counting.ScanCommand.ExecuteAsync(next.Location.Code);
        Assert.True(counting.HasCurrent);
        Assert.False(counting.Visible);
        if (counting.Lines.FirstOrDefault() is { } item)
        {
            await counting.ScanCommand.ExecuteAsync(item.Line.Sku);
            Assert.Equal("ok", counting.FeedbackTone);
            Assert.Null(counting.Current!.Lines.Single((l) => l.Id == item.Line.Id).ExpectedQty);
        }
        Screens.Save(window, "counts-location-phone");
    }
}
