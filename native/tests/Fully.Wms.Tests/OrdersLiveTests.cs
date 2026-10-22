using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The order answers read into the app's models, and the calls the app makes go through: a manual
// order, edit, hold and release, a note, to picking and back, cancel. The order is made for the
// DEMO-KONYHA client, so the picking tests' orders are not touched (same collection: they share
// the stock and the waves).
[Collection("Picking")]
public class OrdersLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Orders_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<OrdersPage>("api/orders?limit=50", Ct);
        Assert.NotEmpty(page.Items);
        var k = page.Kpis;
        Assert.Equal(k.New + k.Hold + k.Picking + k.Packed, page.Total);
        Assert.All(page.Items.Where((o) => o.Status is "new" or "hold"), (o) => Assert.NotNull(o.Availability));
        foreach (var row in page.Items.Take(8))
        {
            var o = await api.GetAsync<OrderDetail>($"api/orders/{row.Id}", Ct);
            Assert.Equal(row.Number, o.Number);
            Assert.Equal(row.PartnerCode, o.Partner.Code);
            Assert.Equal(row.ItemCount, o.ItemCount);
            Assert.NotEmpty(o.Lines);
            Assert.NotEmpty(o.Events);
            if (o.Status is "new" or "hold") Assert.All(o.Lines, (l) => Assert.NotNull(l.Free));
        }
        // A shipped order (Rendeléstörténet) with its picks.
        var shipped = await api.GetAsync<OrderDetail>("api/orders/1", Ct);
        Assert.Equal("shipped", shipped.Status);
        Assert.NotEmpty(shipped.Picks);
        Assert.All(shipped.Picks, (p) => Assert.False(string.IsNullOrEmpty(p.LocationCode)));
    }

    [Fact]
    public async Task Order_lifecycle_goes_through()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var client = (await api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client", Ct)).Items.Single((p) => p.Code == "DEMO-KONYHA");
        var carrier = (await api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier", Ct)).Items.First();
        var products = await api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", client.Id), ("q", "DEMO")), Ct);
        Assert.NotEmpty(products.Items);

        // A manual order with one line of each product; the one with free stock stays.
        var created = await api.PostAsync<OrderCreated>("api/orders", new Dictionary<string, object?>
        {
            ["partner_id"] = client.Id, ["customer_name"] = "Native Teszt Elek", ["zip"] = "1111", ["city"] = "Budapest",
            ["address"] = "Teszt utca 1.", ["carrier_id"] = carrier.Id, ["cod_amount"] = 1990, ["note"] = "native teszt",
            ["lines"] = products.Items.Take(2).Select((p) => new { product_id = p.Id, qty = 1 }).ToArray(),
        }, Ct);
        Assert.False(created.Duplicate);
        var o = await api.GetAsync<OrderDetail>($"api/orders/{created.Id}", Ct);
        Assert.Equal("new", o.Status);
        Assert.Equal("manual", o.Source);
        Assert.Equal(1990m, o.CodAmount);
        Assert.Equal(carrier.Id, o.Carrier?.Id);
        Assert.NotNull(o.Availability);

        // Edit: the city, and only the lines with free stock (quantity 1).
        var keep = o.Lines.Where((l) => l.Free > 0).ToList();
        if (keep.Count == 0) keep = [o.Lines[0]];
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.PatchAsync<OrderSaved>($"api/orders/{o.Id}", new { email = "nem-email" }, Ct));
        Assert.Equal(400, bad.Status);
        Assert.True(bad.Fields.ContainsKey("email"));
        var saved = await api.PatchAsync<OrderSaved>($"api/orders/{o.Id}", new Dictionary<string, object?>
        {
            ["city"] = "Szeged", ["lines"] = keep.Select((l) => new { id = l.Id, product_id = l.ProductId, qty = 1 }).ToArray(),
        }, Ct);
        Assert.Contains("szállítási cím", saved.Changed);
        if (keep.Count < o.Lines.Count) Assert.Contains("tételek", saved.Changed);

        // Hold and release, a note.
        await api.PostAsync($"api/orders/{o.Id}/hold", new { reason = "native teszt" }, Ct);
        Assert.Equal("hold", (await api.GetAsync<OrderDetail>($"api/orders/{o.Id}", Ct)).Status);
        var notReleasable = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync($"api/orders/{o.Id}/hold", new { reason = "megint" }, Ct));
        Assert.Equal(409, notReleasable.Status);
        await api.PostAsync($"api/orders/{o.Id}/release", new { reason = "" }, Ct);
        await api.PostAsync($"api/orders/{o.Id}/notes", new { text = "Native teszt megjegyzés" }, Ct);
        o = await api.GetAsync<OrderDetail>($"api/orders/{o.Id}", Ct);
        Assert.Equal("new", o.Status);
        Assert.Equal("Szeged", o.City);
        Assert.Contains(o.Events, (e) => e.Text == "Native teszt megjegyzés" && e.Type == "note");

        // To picking when it is fulfillable, then the wave cancelled: the order is new again.
        if (o.Availability == "ok")
        {
            var wave = await api.PostAsync<WaveCreated>("api/picking/waves", new { order_ids = new[] { o.Id } }, Ct);
            var inWave = await api.GetAsync<OrderDetail>($"api/orders/{o.Id}", Ct);
            Assert.Equal("picking", inWave.Status);
            Assert.Equal(wave.Id, inWave.Wave?.Id);
            Assert.NotEmpty(inWave.Picks);
            await api.PostAsync($"api/picking/waves/{wave.Id}/cancel", new { reason = "native teszt" }, Ct);
            Assert.Equal("new", (await api.GetAsync<OrderDetail>($"api/orders/{o.Id}", Ct)).Status);
        }

        await api.PostAsync($"api/orders/{o.Id}/cancel", new { reason = "native teszt" }, Ct);
        o = await api.GetAsync<OrderDetail>($"api/orders/{o.Id}", Ct);
        Assert.Equal("cancelled", o.Status);
        Assert.NotNull(o.CancelledAt);
    }
}
