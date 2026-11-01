using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The inbound answers read into the app's models, and the receiving calls the app makes go
// through: arrival, peek scan, typed quantity, putaway, line correction.
public class InboundLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task List_and_detail_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<InboundPage>("api/inbound?status=open&limit=50", Ct);
        Assert.Equal(page.Counts["open"], page.Total);
        Assert.NotNull(page.Kpis.Today);
        foreach (var row in page.Items)
        {
            var d = await api.GetAsync<InboundDetail>($"api/inbound/{row.Id}", Ct);
            Assert.Equal(row.Number, d.Number);
            Assert.Equal(row.LineCount, d.Lines.Count);
            Assert.Equal(row.ExpectedQty, d.Totals.Expected);
            Assert.All(d.Lines, (l) => Assert.False(string.IsNullOrEmpty(l.Sku)));
            Assert.All(d.Lines.Where((l) => l.LeftToPut > 0 || l.ExpectedQty > l.ReceivedQty), (l) => Assert.NotNull(l.Suggested));
        }
    }

    [Fact]
    public async Task Receiving_flow_goes_through()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<InboundPage>("api/inbound?status=open&limit=50", Ct);
        // An open inbound with a line without lot and expiry tracking.
        InboundDetail? d = null;
        InboundLine? line = null;
        foreach (var row in page.Items)
        {
            var x = await api.GetAsync<InboundDetail>($"api/inbound/{row.Id}", Ct);
            line = x.Lines.FirstOrDefault((l) => !l.TrackLot && !l.TrackExpiry && l.Ean is { Length: > 0 } && l.Suggested is not null);
            if (line is not null) { d = x; break; }
        }
        if (d is null || line is null) Assert.Skip("Nincs megfelelő nyitott betárolás a mintaadatokban.");

        if (d.Status == "expected")
            await api.PostAsync($"api/inbound/{d.Id}/arrive", new { pallets = 1, cartons = 4, note = "native teszt" }, Ct);

        var peek = await api.PostAsync<InboundScanResult>($"api/inbound/{d.Id}/scan", new { code = line.Ean, peek = true }, Ct);
        Assert.Equal("match", peek.Result);
        Assert.Equal(line.Id, peek.LineId);

        var received = await api.PostAsync<InboundLineResult>($"api/inbound/{d.Id}/lines/{line.Id}/receive", new { add = 3, damaged_add = 0 }, Ct);
        Assert.Equal(line.ReceivedQty + 3, received.Line.ReceivedQty);
        Assert.Equal("receiving", received.Status);

        var fresh = await api.GetAsync<InboundDetail>($"api/inbound/{d.Id}", Ct);
        var target = fresh.Lines.Single((l) => l.Id == line.Id).Suggested!;
        var put = await api.PostAsync<InboundLineResult>($"api/inbound/{d.Id}/putaway", new { line_id = line.Id, qty = 2, location_id = target.Id }, Ct);
        Assert.Equal(target.Code, put.Location!.Code);
        Assert.Equal(line.PutawayQty + 2, put.Line.PutawayQty);

        // Correction with absolute quantities, not below what is on the shelf.
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<InboundLineResult>($"api/inbound/{d.Id}/lines/{line.Id}/receive",
            new { received_qty = put.Line.PutawayQty - 1, damaged_qty = 0 }, Ct));
        Assert.Equal(409, e.Status);
        var fixedLine = await api.PostAsync<InboundLineResult>($"api/inbound/{d.Id}/lines/{line.Id}/receive",
            new { received_qty = put.Line.ReceivedQty, damaged_qty = 1, note = "native teszt" }, Ct);
        Assert.Equal(1, fixedLine.Line.DamagedQty);
        Assert.Contains(fixedLine.Line.Issues!, (i) => i.Kind == "damaged");
    }

    [Fact]
    public async Task Scan_tells_location_and_foreign_product_apart()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<InboundPage>("api/inbound?status=open&limit=50", Ct);
        if (page.Items.Count < 2) Assert.Skip("Kevés nyitott betárolás a mintaadatokban.");
        var a = await api.GetAsync<InboundDetail>($"api/inbound/{page.Items[0].Id}", Ct);
        var b = (await Task.WhenAll(page.Items.Skip(1).Select((r) => api.GetAsync<InboundDetail>($"api/inbound/{r.Id}", Ct))))
            .FirstOrDefault((x) => x.PartnerId != a.PartnerId);
        var loc = (await api.GetAsync<ItemList<LocationLookup>>("api/lookup/locations?q=", Ct)).Items.First((l) => l.Kind == "storage");

        var asLocation = await api.PostAsync<InboundScanResult>($"api/inbound/{a.Id}/scan", new { code = loc.Code, peek = true }, Ct);
        Assert.Equal("location", asLocation.Result);
        Assert.Equal(loc.Code, asLocation.Location!.Code);

        if (b is null) return;
        var foreign = b.Lines.First().Sku;
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<InboundScanResult>($"api/inbound/{a.Id}/scan", new { code = foreign, peek = true }, Ct));
        Assert.Equal(400, e.Status);
        Assert.Contains(b.PartnerCode, e.Message);
    }

    [Fact]
    public void Line_matches_sku_and_ean_with_or_without_leading_zeros()
    {
        var l = new InboundLine(1, 1, 1, 10, 0, 0, "", "", null, 0, null, null, "ABC-1", "Teszt", "05999876001042", "db",
            false, false, true, null, null, 0, [], [], null);
        Assert.True(l.Matches("abc-1"));
        Assert.True(l.Matches("05999876001042"));
        Assert.True(l.Matches("5999876001042"));
        Assert.False(l.Matches("5999876001043"));
        Assert.Equal("todo", l.State);
    }
}
