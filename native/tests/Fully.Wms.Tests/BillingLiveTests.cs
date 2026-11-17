using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The billing answers read into the app's models, and a statement through its life: made, a manual
// line added and removed, approved (the month's items locked), voided, made again, deleted. The
// recorded items: added, changed, deleted.
[Collection("Billing")]
public class BillingLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;
    static string Month => DateTime.UtcNow.ToString("yyyy-MM");

    [Fact]
    public async Task Overview_statement_and_its_lists_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var gen = await api.PostAsync<GenerateResult>("api/billing/statements/generate", new { period = Month, partner_ids = new[] { 1 } }, Ct);
        var made = Assert.Single(gen.Statements);
        var o = await api.GetAsync<BillingOverview>($"api/billing/overview?period={Month}", Ct);
        Assert.Equal(Month, o.Period);
        Assert.Contains(o.Groups, (g) => g.Key == "storage");
        var row = o.Items.Single((x) => x.PartnerId == 1);
        Assert.Equal(made.Id, row.StatementId);
        Assert.Equal("draft", row.Status);
        Assert.False(o.Invoicing.Configured);
        Assert.True(o.Snapshots.Expected > 0);

        var s = await api.GetAsync<Statement>($"api/billing/statements/{made.Id}", Ct);
        Assert.Equal("DEMO-MANCS", s.PartnerCode);
        Assert.False(s.Stale);
        Assert.NotEmpty(s.Lines);
        Assert.Equal(s.Net, s.Lines.Sum((l) => l.Amount));
        var bas = s.Lines.Single((l) => l.Key == "handling.order_base");
        Assert.Equal("orders", bas.Drill);
        Assert.Equal(8, s.Partner!.PaymentDays);
        Assert.NotEmpty(s.History!);

        var orders = await api.GetAsync<StatementDetails<DetailOrder>>($"api/billing/statements/{made.Id}/details?kind=orders", Ct);
        Assert.Equal(bas.Qty, orders.Total);
        var storage = await api.GetAsync<StatementDetails<DetailStorage>>($"api/billing/statements/{made.Id}/details?kind=storage", Ct);
        Assert.True(storage.DaysInMonth >= 28);
        Assert.All(storage.Items, (x) => Assert.False(string.IsNullOrEmpty(x.SizeCode)));
        await api.GetAsync<StatementDetails<DetailInbound>>($"api/billing/statements/{made.Id}/details?kind=inbound", Ct);
        await api.GetAsync<StatementDetails<DetailReturn>>($"api/billing/statements/{made.Id}/details?kind=returns", Ct);
        var entries = await api.GetAsync<StatementDetails<DetailEntry>>($"api/billing/statements/{made.Id}/details?kind=entries", Ct);
        Assert.Contains(entries.Items, (e) => e.Kind == "hourly_work" && e.Price > 0);

        var csv = await api.DownloadAsync($"api/billing/statements/{made.Id}/export", Ct);
        Assert.EndsWith(".csv", csv.FileName);
        var all = await api.DownloadAsync($"api/billing/overview/export?period={Month}", Ct);
        Assert.Equal($"elszamolasok-{Month}.csv", all.FileName);
    }

    [Fact]
    public async Task Statement_approved_voided_made_again_and_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var gen = await api.PostAsync<GenerateResult>("api/billing/statements/generate", new { period = Month, partner_ids = new[] { 2 } }, Ct);
        var id = Assert.Single(gen.Statements).Id;
        var before = await api.GetAsync<Statement>($"api/billing/statements/{id}", Ct);

        // A credit line by hand, then removed.
        var added = await api.PostAsync<LineAdded>($"api/billing/statements/{id}/lines",
            new { name = "Jóváírás teszt", group = "discount", qty = 1, unit = "db", price = -1000 }, Ct);
        Assert.Equal(before.Net - 1000, added.Net);
        var withLine = await api.GetAsync<Statement>($"api/billing/statements/{id}", Ct);
        Assert.True(withLine.Lines.Single((l) => l.Id == added.Id).Manual);
        var computed = withLine.Lines.First((l) => !l.Manual);
        var refused = await Assert.ThrowsAsync<ApiException>(() => api.DeleteAsync($"api/billing/statements/{id}/lines/{computed.Id}", Ct));
        Assert.Equal(409, refused.Status);
        await api.DeleteAsync($"api/billing/statements/{id}/lines/{added.Id}", Ct);

        // Approved: the month's items of the client are locked; no invoicing service yet.
        await api.PostAsync($"api/billing/statements/{id}/approve", null, Ct);
        var approved = await api.GetAsync<Statement>($"api/billing/statements/{id}", Ct);
        Assert.Equal("approved", approved.Status);
        Assert.Equal("Admin Anna", approved.ApprovedByName);
        var locked = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<NewId>("api/billing/entries",
            new { partner_id = 2, date = $"{Month}-01", kind = "hourly_work", qty = 1 }, Ct));
        Assert.Equal(409, locked.Status);
        var noInvoice = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<InvoiceIssued>($"api/billing/statements/{id}/invoice", null, Ct));
        Assert.False(string.IsNullOrEmpty(noInvoice.Message));

        // Voided with a reason, made again as a draft, deleted.
        var noReason = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync($"api/billing/statements/{id}/void", new { reason = "" }, Ct));
        Assert.True(noReason.Fields.ContainsKey("reason"));
        await api.PostAsync($"api/billing/statements/{id}/void", new { reason = "Teszt érvénytelenítés" }, Ct);
        var voided = await api.GetAsync<Statement>($"api/billing/statements/{id}", Ct);
        Assert.Equal("void", voided.Status);
        Assert.Equal("Teszt érvénytelenítés", voided.VoidReason);
        var again = await api.PostAsync<GenerateResult>("api/billing/statements/generate", new { period = Month, partner_ids = new[] { 2 } }, Ct);
        Assert.Equal(id, Assert.Single(again.Statements).Id);
        Assert.Equal(1, again.Updated);
        await api.DeleteAsync($"api/billing/statements/{id}", Ct);
        var gone = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<Statement>($"api/billing/statements/{id}", Ct));
        Assert.Equal(404, gone.Status);
    }

    [Fact]
    public async Task Entries_recorded_changed_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var items = await api.GetAsync<ItemList<BillingCustomItem>>("api/billing/custom-items?partner_id=1", Ct);
        var item = items.Items.First((i) => i.Kind == "per_unit" && i.Active);
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var created = await api.PostAsync<NewId>("api/billing/entries",
            new { partner_id = 1, date = today, kind = "custom", custom_item_id = item.Id, qty = 3, note = "Natív teszt" }, Ct);
        try
        {
            await api.PatchAsync<object>($"api/billing/entries/{created.Id}", new { qty = 4.5 }, Ct);
            var list = await api.GetAsync<BillingEntries>($"api/billing/entries?period={Month}&partner_id=1", Ct);
            var e = list.Items.Single((x) => x.Id == created.Id);
            Assert.Equal(4.5m, e.Qty);
            Assert.Equal(item.Name, e.ItemName);
            Assert.Equal(item.Price * 4.5m, e.Amount);
            Assert.False(e.Locked);
            var future = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<NewId>("api/billing/entries",
                new { partner_id = 1, date = DateTime.UtcNow.AddDays(3).ToString("yyyy-MM-dd"), kind = "hourly_work", qty = 1 }, Ct));
            Assert.True(future.Fields.ContainsKey("date"));
        }
        finally
        {
            await api.DeleteAsync($"api/billing/entries/{created.Id}", Ct);
        }
    }
}
