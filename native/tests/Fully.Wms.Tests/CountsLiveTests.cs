using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The count answers read into the app's models, and the calls the app makes go through: a new
// count, entries (add, set, clear), a found product, location done, recount, finish, review,
// posting, deleting; a blind count hides the expected quantities from the worker.
[Collection("Counts")]
public class CountsLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Counts_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<Paged<CountRow>>("api/counts?status=all&limit=50", Ct);
        Assert.NotEmpty(page.Items);
        var options = await api.GetAsync<CountOptions>("api/counts/options", Ct);
        Assert.Equal("Ciklikus", options.Types["cycle"]);
        Assert.NotEmpty(options.Zones);
        foreach (var row in page.Items)
        {
            var c = await api.GetAsync<CountDetail>($"api/counts/{row.Id}", Ct);
            Assert.Equal(row.Number, c.Number);
            Assert.Equal(row.Lines, c.Progress.Lines);
            Assert.Equal(row.Locations, c.Locations!.Count);
            Assert.True(c.CanSeeExpected);
            Assert.All(c.Locations, (l) =>
            {
                Assert.Equal(l.Lines, l.Items!.Count);
                Assert.All(l.Items.Where((i) => i.HasProduct), (i) => Assert.NotNull(i.ExpectedQty));
            });
            var first = c.Locations[0];
            var state = await api.GetAsync<CountLocationState>($"api/counts/{c.Id}/locations/{first.LocationId}", Ct);
            Assert.Equal(first.Code, state.Location.Code);
            Assert.Equal(c.Number, state.Count.Number);
            var review = await api.GetAsync<CountReview>($"api/counts/{c.Id}/review", Ct);
            Assert.Equal(c.Progress.Lines, review.Summary.Lines);
            Assert.Equal(review.Summary.Lines, review.Lines.Count);
            Assert.All(review.Lines, (l) => Assert.False(string.IsNullOrEmpty(l.LocationCode)));
        }
    }

    [Fact]
    public async Task Blind_count_hides_expected_from_the_worker()
    {
        using var worker = await LiveServer.SignInAsync(LiveServer.Worker);
        var page = await worker.GetAsync<Paged<CountRow>>("api/counts?status=active", Ct);
        var blind = page.Items.FirstOrDefault((r) => r.Blind);
        if (blind is null) Assert.Skip("Nincs folyamatban lévő vak leltár a mintaadatokban.");
        Assert.Null(blind.DiffLines);
        var c = await worker.GetAsync<CountDetail>($"api/counts/{blind.Id}", Ct);
        Assert.False(c.CanSeeExpected);
        Assert.All(c.Locations!.SelectMany((l) => l.Items!), (l) => Assert.Null(l.ExpectedQty));
        var e = await Assert.ThrowsAsync<ApiException>(() => worker.GetAsync<CountReview>($"api/counts/{blind.Id}/review", Ct));
        Assert.Equal(403, e.Status);
    }

    [Fact]
    public async Task Count_flow_goes_through_and_posts()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var created = await api.PostAsync<CountCreated>("api/counts",
            new Dictionary<string, object?> { ["type"] = "cycle", ["limit"] = 2, ["zone"] = "C", ["blind"] = false, ["note"] = "native teszt" }, Ct);
        Assert.True(created.Locations >= 1);
        var c = await api.GetAsync<CountDetail>($"api/counts/{created.Id}", Ct);
        Assert.Equal("open", c.Status);
        Assert.Equal("cycle", c.Type);
        Assert.False(c.Blind);

        // Every product line: one added by a scan, then set to the expected quantity (no difference).
        foreach (var loc in c.Locations!)
        {
            foreach (var line in loc.Items!.Where((l) => l.HasProduct))
            {
                var added = await api.PutAsync<CountLocationState>($"api/counts/{c.Id}/lines/{line.Id}", new { add = 1 }, Ct);
                Assert.Equal(1, added.Lines.Single((l) => l.Id == line.Id).CountedQty);
                Assert.Equal("counting", added.Count.Status);
                var cleared = await api.PutAsync<CountLocationState>($"api/counts/{c.Id}/lines/{line.Id}", new Dictionary<string, object?> { ["counted_qty"] = null }, Ct);
                Assert.Null(cleared.Lines.Single((l) => l.Id == line.Id).CountedQty);
                var set = await api.PutAsync<CountLocationState>($"api/counts/{c.Id}/lines/{line.Id}", new { counted_qty = line.ExpectedQty }, Ct);
                Assert.Equal(line.ExpectedQty, set.Lines.Single((l) => l.Id == line.Id).CountedQty);
                Assert.Equal(0, set.Lines.Single((l) => l.Id == line.Id).Diff);
            }
        }

        // A found product on the first location: recorded, then removed again.
        var loc0 = c.Locations[0];
        var partnerId = loc0.Items!.FirstOrDefault((l) => l.HasProduct)?.PartnerId;
        var products = await api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", partnerId), ("q", "DEMO")), Ct);
        var found = products.Items.First((p) => loc0.Items!.All((l) => l.ProductId != p.Id));
        var resolved = await api.GetAsync<CountResolved>(Query.Build($"api/counts/{c.Id}/resolve", ("code", found.Sku), ("location_id", loc0.LocationId)), Ct);
        Assert.Contains(resolved.Products, (p) => p.Id == found.Id && p.Sku == found.Sku);
        var withFound = await api.PostAsync<CountLocationState>($"api/counts/{c.Id}/lines",
            new Dictionary<string, object?> { ["location_id"] = loc0.LocationId, ["product_id"] = found.Id, ["counted_qty"] = 2, ["lot"] = "", ["expiry"] = null }, Ct);
        var foundLine = withFound.Lines.Single((l) => l.ProductId == found.Id);
        Assert.True(foundLine.Added);
        Assert.Equal(2, foundLine.CountedQty);
        var removed = await api.DeleteAsync<CountLocationState>($"api/counts/{c.Id}/lines/{foundLine.Id}", Ct);
        Assert.DoesNotContain(removed.Lines, (l) => l.Id == foundLine.Id);

        // Location done, recount of the last location, done again; then finish.
        var done = await api.PostAsync<CountLocationState>($"api/counts/{c.Id}/locations/{loc0.LocationId}/complete", null, Ct);
        Assert.True(done.Location.Done);
        var last = c.Locations[^1];
        var again = await api.PostAsync<CountLocationState>($"api/counts/{c.Id}/locations/{last.LocationId}/recount", null, Ct);
        Assert.False(again.Location.Done);
        foreach (var l in again.Lines.Where((x) => x.HasProduct))
            await api.PutAsync<CountLocationState>($"api/counts/{c.Id}/lines/{l.Id}", new { counted_qty = l.ExpectedQty }, Ct);
        await api.PostAsync<CountLocationState>($"api/counts/{c.Id}/locations/{last.LocationId}/complete", null, Ct);
        foreach (var l in c.Locations.Where((x) => !x.Done))
            await api.PostAsync<CountLocationState>($"api/counts/{c.Id}/locations/{l.LocationId}/complete", null, Ct);
        var finished = await api.PostAsync<CountFinished>($"api/counts/{c.Id}/finish", null, Ct);
        Assert.Equal("counted", finished.Status);

        // Review: no difference; post with the moved lines confirmed.
        var review = await api.GetAsync<CountReview>($"api/counts/{c.Id}/review", Ct);
        Assert.Equal(0, review.Summary.Surplus + review.Summary.Shortage);
        Assert.Equal(review.Summary.Lines, review.Summary.Counted);
        var posted = await api.PostAsync<CountPosted>($"api/counts/{c.Id}/post",
            new { confirm_line_ids = review.Lines.Where((l) => l.Changed).Select((l) => l.Id).ToArray() }, Ct);
        Assert.True(posted.Done);
        Assert.NotNull(posted.Summary);
        var after = await api.GetAsync<CountDetail>($"api/counts/{c.Id}", Ct);
        Assert.Equal("posted", after.Status);
        Assert.All(after.Locations!.SelectMany((l) => l.Items!), (l) => Assert.True(l.Posted));
    }

    [Fact]
    public async Task Count_of_locations_can_be_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<CountCreated>("api/counts",
            new { type = "locations", location_codes = new[] { "NINCS-ILYEN" } }, Ct));
        Assert.Equal(400, bad.Status);
        Assert.True(bad.Fields.ContainsKey("location_codes"));
        var created = await api.PostAsync<CountCreated>("api/counts", new { type = "locations", location_codes = new[] { "C-01-02" }, blind = true }, Ct);
        Assert.Equal(1, created.Locations);
        await api.DeleteAsync($"api/counts/{created.Id}", Ct);
        var c = await api.GetAsync<CountDetail>($"api/counts/{created.Id}", Ct);
        Assert.Equal("cancelled", c.Status);
        Assert.NotNull(c.CancelledAt);
    }
}
