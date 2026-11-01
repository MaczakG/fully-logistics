using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The quote answers read into the app's models; a quote saved from the app's data gets the same
// monthly net from the server as the app calculates; copied, its status changed, deleted.
[Collection("Quotes")]
public class QuotesLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Defaults_and_a_clients_tariffs_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var d = await api.GetAsync<QuoteDefaults>("api/quotes/defaults", Ct);
        Assert.False(string.IsNullOrEmpty(d.Company?.Name));
        Assert.NotEmpty(d.Sizes);
        Assert.Contains(d.Tariffs, (t) => t.Key == "order_base");
        Assert.True(d.Tariff("order_base") > 0);
        Assert.True(d.Storage(d.Sizes[0].Code) > 0);
        Assert.NotEmpty(d.QuoteTerms);
        Assert.True(d.Costing.WorkerHours > 0);
        Assert.NotEmpty(d.Costing.Racks);

        var p = await api.GetAsync<QuotePartner>("api/quotes/partner/1", Ct);
        Assert.Equal("DEMO-MANCS", p.Partner.Code);
        Assert.Equal(p.Partner.Name, p.Contact.Name);
        Assert.Contains("order_base", p.Tariffs.Keys);
        Assert.NotEmpty(p.Storage);
        var carrier = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<QuotePartner>("api/quotes/partner/4", Ct));
        Assert.Equal(400, carrier.Status);
    }

    [Fact]
    public async Task Saved_copied_and_deleted_with_the_same_total()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var d = await api.GetAsync<QuoteDefaults>("api/quotes/defaults", Ct);
        var data = new QuoteData
        {
            Client = new() { Name = "Natív Teszt Kft.", Email = "teszt@example.com", Shop = "nativteszt.hu" },
            OfferDate = "2026-10-22",
            Volume = new() { Orders = 420, Avg = 1.8m, Inbound = 600, RetPct = 2.5m, MoveIn = 2000, Hours = 6, CodOrders = 90, CodAvg = 12990 },
            Storage = d.Sizes.Select((s, i) => new QuoteStorage { Code = s.Code, Name = s.Name, Qty = 10 * (i + 1), Price = d.Storage(s.Code) }).ToList(),
            Tariffs = d.Tariffs.ToDictionary((t) => t.Key, (t) => d.Tariff(t.Key)),
            Discounts = new() { FreeMoveIn = 1000, FreeStorageMonths = 1, PriceLockMonths = 6 },
            CustomItems = [new() { Name = "Dedikált ügyintéző", Kind = "monthly", Price = 25000, Qty = 1 }],
            Terms = [.. d.QuoteTerms],
            Signer = "Teszt Elek",
            Internal = QuoteInternal.From(d.Costing),
        };
        data.Tariffs["discount_handling_pct"] = 5;
        var net = QuoteCalc.Calc(data).Net;
        var q = await api.PostAsync<QuoteDetail>("api/quotes", new Dictionary<string, object?> { ["partner_id"] = null, ["status"] = "draft", ["data"] = data }, Ct);
        try
        {
            Assert.StartsWith("AJ", q.Number);
            Assert.Equal("Natív Teszt Kft.", q.ClientName);
            Assert.Equal(Math.Round(net, 2), q.MonthlyNet);
            // What comes back calculates the same.
            Assert.Equal(Math.Round(net, 2), Math.Round(QuoteCalc.Calc(q.Data).Net, 2));
            Assert.Equal(1.8m, q.Data.Volume.Avg);
            Assert.Equal("monthly", Assert.Single(q.Data.CustomItems).Kind);
            Assert.Equal(d.Costing.WorkerHours, q.Data.Internal.WorkerHours);

            var sent = await api.PatchAsync<QuoteDetail>($"api/quotes/{q.Id}", new { status = "sent", partner_id = 1 }, Ct);
            Assert.Equal("sent", sent.Status);
            Assert.Equal("DEMO-MANCS", sent.PartnerCode);
            var list = await api.GetAsync<Paged<QuoteRow>>($"api/quotes?status=sent&q={Uri.EscapeDataString("Natív Teszt")}", Ct);
            Assert.Contains(list.Items, (r) => r.Id == q.Id && r.MonthlyNet == q.MonthlyNet);

            var copy = await api.PostAsync<QuoteDetail>($"api/quotes/{q.Id}/duplicate", null, Ct);
            Assert.NotEqual(q.Number, copy.Number);
            Assert.Equal("draft", copy.Status);
            Assert.Equal(q.MonthlyNet, copy.MonthlyNet);
            await api.DeleteAsync($"api/quotes/{copy.Id}", Ct);
        }
        finally
        {
            await api.DeleteAsync($"api/quotes/{q.Id}", Ct);
        }
        var gone = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<QuoteDetail>($"api/quotes/{q.Id}", Ct));
        Assert.Equal(404, gone.Status);
    }
}
