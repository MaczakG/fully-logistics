using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The stock answers read into the app's models, and a transfer and a correction go through
// (each is undone at the end, so the demo data stays as it was).
public class StockLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Stock_list_product_and_location_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<StockPage>("api/stock?limit=5", Ct);
        Assert.True(page.Total >= page.Items.Count);
        Assert.Equal(page.Summary.Products, (await api.GetAsync<StockPage>("api/stock?limit=1", Ct)).Summary.Products);
        var row = page.Items.First((r) => r.Locations > 0);
        Assert.Contains(row.Status, new[] { "ok", "low", "out" });

        var product = await api.GetAsync<StockProduct>($"api/stock/product/{row.ProductId}", Ct);
        Assert.Equal(row.Sku, product.Product.Sku);
        Assert.Equal(row.OnHand, product.Availability.OnHand);
        Assert.Equal(product.Availability.OnHand, product.Locations.Sum((l) => l.Qty));

        var loc = product.Locations[0];
        var detail = await api.GetAsync<LocationDetail>($"api/stock/locations/{loc.LocationId}", Ct);
        Assert.Equal(loc.Code, detail.Location.Code);
        Assert.Contains(detail.Stock, (s) => s.ProductId == row.ProductId && s.Qty == loc.Qty);

        var lookup = await api.GetAsync<ItemList<LocationLookup>>(Query.Build("api/lookup/locations", ("q", loc.Code)), Ct);
        Assert.Contains(lookup.Items, (l) => l.Code == loc.Code);
    }

    [Fact]
    public async Task Transfer_moves_stock_and_back()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var (product, from) = await FirstStockRow(api);
        var empty = (await api.GetAsync<ItemList<LocationLookup>>("api/lookup/locations?q=", Ct)).Items
            .First((l) => l.Kind == "storage" && l.Id != from.LocationId && l.PartnerId is null);
        var probe = await api.GetAsync<LocationDetail>($"api/stock/locations/{empty.Id}", Ct);
        if (probe.Stock.Count > 0) Assert.Skip("Nincs üres raktárhely a mintaadatokban.");

        var res = await api.PostAsync<TransferResult>("api/stock/transfer",
            new { product_id = product.Product.Id, from_location_id = from.LocationId, lot = from.Lot, expiry = NullIfEmpty(from.Expiry), to_location_code = empty.Code, qty = 1, note = "native teszt" }, Ct);
        Assert.Equal(from.Code, res.From);
        Assert.Equal(empty.Code, res.To);

        var back = await api.PostAsync<TransferResult>("api/stock/transfer",
            new { product_id = product.Product.Id, from_location_id = empty.Id, lot = from.Lot, expiry = NullIfEmpty(from.Expiry), to_location_code = from.Code, qty = 1, note = "native teszt vissza" }, Ct);
        Assert.Equal(from.Code, back.To);
    }

    [Fact]
    public async Task Transfer_to_unknown_location_names_the_field()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var (product, from) = await FirstStockRow(api);
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<TransferResult>("api/stock/transfer",
            new { product_id = product.Product.Id, from_location_id = from.LocationId, lot = from.Lot, expiry = NullIfEmpty(from.Expiry), to_location_code = "NINCS-ILYEN-HELY", qty = 1 }, Ct));
        Assert.Equal(400, e.Status);
        Assert.True(e.Fields.ContainsKey("to_location_code"));
    }

    [Fact]
    public async Task Adjust_add_then_remove()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var (product, row) = await FirstStockRow(api);
        var add = await api.PostAsync<AdjustResult>("api/stock/adjust",
            new { product_id = product.Product.Id, location_id = row.LocationId, lot = row.Lot, expiry = NullIfEmpty(row.Expiry), mode = "add", qty = 2, reason = "Hibás könyvelés javítása: native teszt" }, Ct);
        Assert.Equal(row.Qty, add.Before);
        Assert.Equal(row.Qty + 2, add.After);
        var remove = await api.PostAsync<AdjustResult>("api/stock/adjust",
            new { product_id = product.Product.Id, location_id = row.LocationId, lot = row.Lot, expiry = NullIfEmpty(row.Expiry), mode = "remove", qty = 2, reason = "Hibás könyvelés javítása: native teszt vissza" }, Ct);
        Assert.Equal(row.Qty, remove.After);
    }

    [Fact]
    public async Task Worker_without_approve_cannot_adjust()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        var me = await api.GetAsync<Me>("api/me", Ct);
        if (me.Can("stock", "approve")) Assert.Skip("A raktáros szerepkörnek van korrekciós joga.");
        var (product, row) = await FirstStockRow(api);
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<AdjustResult>("api/stock/adjust",
            new { product_id = product.Product.Id, location_id = row.LocationId, lot = row.Lot, mode = "add", qty = 1, reason = "teszt" }, Ct));
        Assert.Equal(403, e.Status);
    }

    static object? NullIfEmpty(string s) => s.Length == 0 ? null : s;

    static async Task<(StockProduct, StockLocationRow)> FirstStockRow(ApiClient api)
    {
        var page = await api.GetAsync<StockPage>("api/stock?limit=50", Ct);
        foreach (var r in page.Items.Where((r) => r.OnHand > 2))
        {
            var p = await api.GetAsync<StockProduct>($"api/stock/product/{r.ProductId}", Ct);
            var row = p.Locations.FirstOrDefault((l) => l.Kind == "storage" && l.Qty > 2);
            if (row is not null) return (p, row);
        }
        Assert.Skip("Nincs készlet a mintaadatokban.");
        throw new InvalidOperationException();
    }
}
