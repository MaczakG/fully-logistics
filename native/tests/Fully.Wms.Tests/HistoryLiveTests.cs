using System.Text.Json;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The history answers read into the app's models, and the calls the app makes go through: the
// export, a return with a photo, delivered, a note. The demo data's orders: 1 and 2 shipped, 3 and
// 4 delivered; this test uses 1 and 3, the screen test 2 and 4.
[Collection("Picking")]
public class HistoryLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    // A 1 x 1 PNG.
    internal static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

    [Fact]
    public async Task History_and_export_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<HistoryPage>("api/history?limit=50", Ct);
        var k = page.Kpis;
        Assert.Equal(k.Shipped + k.Delivered + k.Returned + k.Cancelled, page.Total);
        Assert.All(page.Items, (r) => Assert.Contains(r.Status, new[] { "shipped", "delivered", "returned", "cancelled" }));
        var shipped = await api.GetAsync<HistoryPage>("api/history?status=shipped&date_field=created&from=2020-01-01", Ct);
        Assert.All(shipped.Items, (r) => Assert.Equal("shipped", r.Status));
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<HistoryPage>("api/history?from=2026-02-02&to=2026-01-01", Ct));
        Assert.Equal(400, bad.Status);
        var csv = await api.DownloadAsync("api/history/export?status=delivered", Ct);
        Assert.Equal("text/csv", csv.ContentType);
        Assert.EndsWith(".csv", csv.FileName);
        Assert.Contains("Rendelésszám", System.Text.Encoding.UTF8.GetString(csv.Bytes));
    }

    [Fact]
    public async Task Return_with_photo_and_delivered()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var opts = await api.GetAsync<ReturnOptions>("api/history/3/return-options", Ct);
        if (!opts.CanReturn || opts.Lines.All((l) => l.Returnable == 0)) Assert.Skip("A 3-as rendelés már nem küldhető vissza (indítsd újra a szervert).");
        Assert.NotEmpty(opts.ReturnsZones);
        Assert.NotEmpty(opts.QuarantineZones);
        var line = opts.Lines.First((l) => l.Returnable > 0);
        Assert.NotEmpty(line.Lots);

        // Too many is refused per line; one piece goes back onto the suggested shelf.
        var tooMany = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<ReturnCreated>("api/history/3/returns", new
        {
            lines = new[] { new { product_id = line.ProductId, qty = line.Returnable + 5, condition = "sellable" } },
        }, Ct));
        Assert.Equal(400, tooMany.Status);
        Assert.Contains(tooMany.Fields.Keys, (key) => key.StartsWith("lines.0.", StringComparison.Ordinal));
        var lot = line.Lots.First((l) => l.Returnable > 0);
        var created = await api.PostAsync<ReturnCreated>("api/history/3/returns", new Dictionary<string, object?>
        {
            ["reason"] = "Sérült csomag", ["note"] = "native teszt",
            ["lines"] = new[] { new Dictionary<string, object?> { ["product_id"] = line.ProductId, ["qty"] = 1, ["condition"] = "sellable", ["lot"] = lot.Lot, ["expiry"] = lot.Expiry, ["location_id"] = line.SuggestedLocation?.Id } },
        }, Ct);
        Assert.Equal(1, created.Pieces);
        Assert.StartsWith("VR-", created.Number);
        var photo = await api.UploadAsync<JsonElement>($"api/history/returns/{created.Id}/photos", Png, "csomag.png", ct: Ct);
        Assert.True(photo.GetProperty("id").GetInt32() > 0);

        var o = await api.GetAsync<OrderDetail>("api/orders/3", Ct);
        Assert.Equal("returned", o.Status);
        var r = o.Returns.Single((x) => x.Id == created.Id);
        Assert.Equal("sellable", r.Lines!.Single().Condition);
        if (line.SuggestedLocation is { } s) Assert.Equal(s.Code, r.Lines!.Single().LocationCode);
        Assert.Equal("csomag.png", r.Photos!.Single().Filename);
        Assert.Equal(1, o.Lines.Single((l) => l.ProductId == line.ProductId).ReturnedQty);

        // Delivered, and a note on the closed order.
        var one = await api.GetAsync<OrderDetail>("api/orders/1", Ct);
        if (one.Status == "shipped")
        {
            await api.PostAsync("api/history/1/delivered", null, Ct);
            Assert.Equal("delivered", (await api.GetAsync<OrderDetail>("api/orders/1", Ct)).Status);
            var again = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync("api/history/1/delivered", null, Ct));
            Assert.Equal(409, again.Status);
        }
        await api.PostAsync("api/history/1/notes", new { text = "Native teszt: a vevő visszaigazolta." }, Ct);
        Assert.Contains((await api.GetAsync<OrderDetail>("api/orders/1", Ct)).Events, (e) => e.Text == "Native teszt: a vevő visszaigazolta.");
    }
}
