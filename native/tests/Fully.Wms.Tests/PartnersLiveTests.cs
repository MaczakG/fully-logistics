using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The partner answers read into the app's models, and the calls the app makes go through. The demo
// data: clients 1-3, carriers 4 (GLS) and 5 (FoxPost), supplier 6. The changes are made on partners
// the tests create (and delete).
[Collection("Partners")]
public class PartnersLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Partners_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var all = await api.GetAsync<PartnersPage>("api/partners", Ct);
        Assert.Equal(all.Counts["client"] + all.Counts["carrier"] + all.Counts["supplier"], all.Counts["all"]);
        Assert.Contains(all.Items, (p) => p.Code == "DEMO-MANCS" && p.ContactName is not null);
        var carriers = await api.GetAsync<PartnersPage>("api/partners?type=carrier", Ct);
        Assert.All(carriers.Items, (p) => Assert.Equal("carrier", p.Type));
        var found = await api.GetAsync<PartnersPage>("api/partners?q=Kecskem", Ct);
        Assert.Contains(found.Items, (p) => p.Code == "DEMO-ALFOLDI");

        var p = await api.GetAsync<PartnerDetail>("api/partners/1", Ct);
        Assert.False(p.CanDelete);
        Assert.Contains(p.DeleteBlockers, (b) => b.Key == "orders");
        Assert.True(p.Counts.Contacts > 0);
        var contacts = await api.GetAsync<ItemList<PartnerContact>>("api/partners/1/contacts", Ct);
        Assert.Single(contacts.Items, (c) => c.IsPrimary);
        var t = await api.GetAsync<PartnerTariffs>("api/partners/1/tariffs", Ct);
        Assert.Contains(t.Tariffs, (x) => x.Key == "order_base");
        Assert.NotEmpty(t.Storage);
        var integ = await api.GetAsync<PartnerIntegrations>("api/partners/1/integrations", Ct);
        Assert.NotEmpty(integ.Platforms);
        Assert.All(integ.Platforms, (pl) => Assert.NotEmpty(pl.CredentialFields.Concat(pl.SettingFields)));

        var client = await api.GetAsync<PartnerSummary>("api/partners/1/summary", Ct);
        Assert.Equal("client", client.Type);
        Assert.NotNull(client.StorageMonth);
        Assert.True(client.Kpis.ActiveSkus > 0);
        var carrier = await api.GetAsync<PartnerSummary>("api/partners/4/summary", Ct);
        Assert.Equal("carrier", carrier.Type);
        Assert.NotNull(carrier.LastPickups);
        var supplier = await api.GetAsync<PartnerSummary>("api/partners/6/summary", Ct);
        Assert.Equal("supplier", supplier.Type);
        Assert.NotNull(supplier.LastInbounds);
        var notClient = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<PartnerTariffs>("api/partners/4/tariffs", Ct));
        Assert.Equal(400, notClient.Status);
    }

    [Fact]
    public async Task Client_created_filled_and_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var code = $"NT{DateTime.UtcNow:HHmmssfff}";
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PartnerCreated>("api/partners",
            new { type = "client", name = "Native Teszt Kft.", code = "x", tax_number = "123" }, Ct));
        Assert.True(bad.Fields.ContainsKey("code"));
        Assert.True(bad.Fields.ContainsKey("tax_number"));
        var created = await api.PostAsync<PartnerCreated>("api/partners",
            new { type = "client", name = "Native Teszt Kft.", code, tax_number = "12345678213", country = "hu", website = "nativeteszt.hu" }, Ct);
        var dup = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PartnerCreated>("api/partners", new { type = "client", name = "Másik", code }, Ct));
        Assert.Equal(409, dup.Status);
        var id = created.Id;
        var p = await api.GetAsync<PartnerDetail>($"api/partners/{id}", Ct);
        Assert.Equal("12345678-2-13", p.TaxNumber);
        Assert.Equal("https://nativeteszt.hu", p.Website);
        Assert.True(p.CanDelete);

        var saved = await api.PatchAsync<PartnerSaved>($"api/partners/{id}", new { payment_days = 15, billing_email = "szamla@nativeteszt.hu" }, Ct);
        Assert.Contains("payment_days", saved.Changed!);

        // Contacts: the first one is primary; another made primary takes it over.
        var c1 = await api.PostAsync<NewId>($"api/partners/{id}/contacts", new { name = "Első Ember", email = "elso@nativeteszt.hu" }, Ct);
        var c2 = await api.PostAsync<NewId>($"api/partners/{id}/contacts", new { name = "Második Ember" }, Ct);
        await api.PatchAsync<PartnerSaved>($"api/partners/{id}/contacts/{c2.Id}", new { is_primary = true }, Ct);
        var contacts = (await api.GetAsync<ItemList<PartnerContact>>($"api/partners/{id}/contacts", Ct)).Items;
        Assert.True(contacts.Single((c) => c.Id == c2.Id).IsPrimary);
        Assert.False(contacts.Single((c) => c.Id == c1.Id).IsPrimary);

        // A contract, a document linked to it, downloaded, unlinked.
        var badDates = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<NewId>($"api/partners/{id}/contracts",
            new { title = "Teszt", start_date = "2026-05-01", end_date = "2026-04-01" }, Ct));
        Assert.True(badDates.Fields.ContainsKey("end_date"));
        var contract = await api.PostAsync<NewId>($"api/partners/{id}/contracts",
            new Dictionary<string, object?> { ["title"] = "Fulfillment szerződés", ["number"] = "NT-1", ["start_date"] = "2026-01-01", ["end_date"] = null, ["notice_days"] = 60 }, Ct);
        var doc = await api.UploadAsync<NewId>($"api/partners/{id}/documents", System.Text.Encoding.UTF8.GetBytes("szerződés szövege"), "szerződés.txt",
            new Dictionary<string, string> { ["kind"] = "contract", ["contract_id"] = contract.Id.ToString() }, Ct);
        var docs = (await api.GetAsync<ItemList<PartnerDocument>>($"api/partners/{id}/documents", Ct)).Items;
        var d = docs.Single((x) => x.Id == doc.Id);
        Assert.Equal(contract.Id, d.ContractId);
        Assert.Equal("NT-1", d.ContractNumber);
        Assert.Equal("szerződés.txt", d.Filename);
        var file = await api.DownloadAsync($"api/documents/{doc.Id}", Ct);
        Assert.Equal("szerződés szövege", System.Text.Encoding.UTF8.GetString(file.Bytes));
        await api.PatchAsync<PartnerSaved>($"api/partners/{id}/documents/{doc.Id}", new Dictionary<string, object?> { ["kind"] = "other", ["contract_id"] = null }, Ct);
        Assert.Null((await api.GetAsync<ItemList<PartnerDocument>>($"api/partners/{id}/documents", Ct)).Items.Single().ContractId);
        Assert.Equal(0, (await api.GetAsync<ItemList<PartnerContract>>($"api/partners/{id}/contracts", Ct)).Items.Single().Documents);

        // Tariffs: changed, refused when negative, back to the defaults.
        var t = await api.GetAsync<PartnerTariffs>($"api/partners/{id}/tariffs", Ct);
        Assert.All(t.Tariffs, (x) => Assert.False(x.Differs));
        var size = t.Storage[0];
        var changed = await api.PutAsync<PartnerTariffs>($"api/partners/{id}/tariffs", new
        {
            tariffs = new Dictionary<string, object?> { ["order_base"] = 999 },
            storage = new Dictionary<string, object?> { [size.SizeId.ToString()] = size.Default + 100 },
        }, Ct);
        Assert.True(changed.Tariffs.Single((x) => x.Key == "order_base").Differs);
        Assert.True(changed.Storage[0].Differs);
        var negative = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<PartnerTariffs>($"api/partners/{id}/tariffs",
            new { tariffs = new Dictionary<string, object?> { ["vat_pct"] = 150 } }, Ct));
        Assert.True(negative.Fields.ContainsKey("vat_pct"));
        var reset = await api.PostAsync<PartnerTariffs>($"api/partners/{id}/tariffs/reset", null, Ct);
        Assert.All(reset.Tariffs, (x) => Assert.False(x.Differs));

        // A custom item, an API key (shown once), revoked.
        var item = await api.PostAsync<NewId>($"api/partners/{id}/custom-items", new { name = "Raklapfóliázás", unit = "raklap", price = 1500, kind = "per_unit" }, Ct);
        await api.PatchAsync<PartnerSaved>($"api/partners/{id}/custom-items/{item.Id}", new { active = false }, Ct);
        Assert.False((await api.GetAsync<PartnerTariffs>($"api/partners/{id}/tariffs", Ct)).CustomItems.Single().Active);
        var key = await api.PostAsync<ApiKeyCreated>($"api/partners/{id}/api-keys", new { name = "Native teszt" }, Ct);
        Assert.StartsWith(key.Prefix, key.Key);
        var integ = await api.GetAsync<PartnerIntegrations>($"api/partners/{id}/integrations", Ct);
        Assert.Null(integ.ApiKeys.Single().RevokedAt);
        await api.PostAsync($"api/partners/{id}/api-keys/{key.Id}/revoke", null, Ct);
        Assert.NotNull((await api.GetAsync<PartnerIntegrations>($"api/partners/{id}/integrations", Ct)).ApiKeys.Single().RevokedAt);

        // A webshop connection: credentials kept masked, a bad address refused, removed.
        var shopify = integ.Platforms.Single((pl) => pl.Code == "shopify");
        var noUrl = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<WebshopConnection>($"api/partners/{id}/webshops",
            new { platform = "shopify", shop_url = "http://bolt.hu", credentials = new { }, settings = new { } }, Ct));
        Assert.True(noUrl.Fields.ContainsKey("shop_url"));
        var conn = await api.PostAsync<WebshopConnection>($"api/partners/{id}/webshops",
            new { platform = "shopify", shop_url = "nativeteszt.myshopify.com", active = false, credentials = new { access_token = "shpat_titkos123456" }, settings = new { notify_customer = false } }, Ct);
        Assert.Equal("https://nativeteszt.myshopify.com", conn.ShopUrl);
        Assert.DoesNotContain("titkos123456", conn.Credentials!["access_token"].ToString());
        Assert.False(conn.Settings!["notify_customer"].GetBoolean());
        Assert.Contains(shopify.SettingFields, (f) => f.Key == "notify_customer");
        await api.DeleteAsync($"api/partners/{id}/webshops/{conn.Id}", Ct);

        // Deleted with everything on it.
        await api.DeleteAsync($"api/partners/{id}", Ct);
        var gone = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<PartnerDetail>($"api/partners/{id}", Ct));
        Assert.Equal(404, gone.Status);
    }

    [Fact]
    public async Task Partner_in_use_is_not_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var refused = await Assert.ThrowsAsync<ApiException>(() => api.DeleteAsync("api/partners/4", Ct));
        Assert.Equal(409, refused.Status);
        Assert.Contains("Inaktiváld", refused.Message);
    }

    [Fact]
    public async Task Worker_cannot_see_partners()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        var denied = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<PartnersPage>("api/partners", Ct));
        Assert.Equal(403, denied.Status);
    }
}
