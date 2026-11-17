using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The settings answers read into the app's models, and the calls the app makes go through. The
// sizes and locations are the tests' own (packing places, so putaway never suggests them) and are
// deleted again; changed settings are put back. Same collection as the partners: their tariffs
// list the sizes.
[Collection("Partners")]
public class SettingsLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Settings_read_and_saved()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var company = await api.GetAsync<CompanySettings>("api/settings/company", Ct);
        var phone = $"+36 1 {DateTime.UtcNow:HHmmss}";
        var saved = await api.PutAsync<CompanySettings>("api/settings/company", company with { Phone = phone }, Ct);
        Assert.Equal(phone, saved.Phone);
        Assert.Equal(company.Name, saved.Name);
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<CompanySettings>("api/settings/company", company with { Email = "rossz" }, Ct));
        Assert.True(bad.Fields.ContainsKey("email"));
        await api.PutAsync<CompanySettings>("api/settings/company", company, Ct);

        var w = await api.GetAsync<WarehouseSettings>("api/settings/warehouse", Ct);
        Assert.Matches("^[0-2][0-9]:[0-5][0-9]$", w.Cutoff);
        Assert.NotEmpty(w.Workdays);
        var refused = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<WarehouseSettings>("api/settings/warehouse",
            new { cutoff = w.Cutoff, open = "18:00", close = "08:00", workdays = Array.Empty<int>() }, Ct));
        Assert.True(refused.Fields.ContainsKey("close") && refused.Fields.ContainsKey("workdays"));

        var c = await api.GetAsync<CostingSettings>("api/settings/costing", Ct);
        Assert.NotEmpty(c.Sizes!);
        Assert.True(c.Rent > 0 && c.AreaM2 > 0);
        var code = c.Sizes![0].Code;
        var costing = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<CostingSettings>("api/settings/costing",
            new Dictionary<string, object?> { ["rent"] = -1, ["racks"] = new Dictionary<string, object> { [code] = new { area = 1, levels = 1.5, per_level = 2 } } }, Ct));
        Assert.True(costing.Fields.ContainsKey("rent") && costing.Fields.ContainsKey($"racks.{code}.levels"));

        var t = await api.GetAsync<DefaultTariffs>("api/settings/tariffs", Ct);
        Assert.NotEmpty(t.Tariffs);
        Assert.All(t.Tariffs, (x) => Assert.True(t.Values.ContainsKey(x.Key)));
        Assert.NotEmpty(t.QuoteTerms);
        var tariffs = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<DefaultTariffs>("api/settings/tariffs",
            new { values = new Dictionary<string, object> { [t.Tariffs[0].Key] = -5 }, storage = t.Storage, quote_terms = t.QuoteTerms }, Ct));
        Assert.True(tariffs.Fields.ContainsKey($"values.{t.Tariffs[0].Key}"));
    }

    [Fact]
    public async Task Sizes_and_locations_one_by_one_and_in_bulk()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var stamp = DateTime.UtcNow.ToString("mmssff");
        var size = await api.PostAsync<LocationSize>("api/settings/sizes",
            new { code = $"T{stamp}", name = "Teszt méret", width_cm = 40, depth_cm = 60, height_cm = 30.5, max_kg = 25, sort = 990, active = true }, Ct);
        try
        {
            Assert.Equal(30.5m, size.HeightCm);
            var sizes = await api.GetAsync<ItemList<LocationSize>>("api/settings/sizes", Ct);
            Assert.Contains(sizes.Items, (s) => s.Id == size.Id && s.LocationCount == 0);

            // Bulk: the preview, then the codes made; again: all exist.
            var pattern = new Dictionary<string, object?>
            {
                ["prefixes"] = $"T{stamp}", ["separator"] = "-", ["pad"] = 2, ["rack_from"] = 1, ["rack_to"] = 2, ["level_from"] = 1, ["level_to"] = 3,
                ["size_id"] = size.Id, ["kind"] = "packing", ["zone"] = "TESZT", ["preview"] = true,
            };
            var preview = await api.PostAsync<BulkPreview>("api/settings/locations/bulk", pattern, Ct);
            Assert.Equal(6, preview.Create);
            Assert.Contains($"T{stamp}-02-03", preview.Codes);
            pattern["preview"] = false;
            var made = await api.PostAsync<BulkCreated>("api/settings/locations/bulk", pattern, Ct);
            Assert.Equal(6, made.Created);
            var again = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<BulkCreated>("api/settings/locations/bulk", pattern, Ct));
            Assert.Equal(409, again.Status);

            var list = await api.GetAsync<SettingsLocationsPage>($"api/settings/locations?size_id={size.Id}&limit=100", Ct);
            Assert.Equal(6, list.Total);
            Assert.All(list.Items, (l) => Assert.True(l.Kind == "packing" && l.Zone == "TESZT" && l.OccupantId is null));
            Assert.Contains("TESZT", list.Zones);
            var ids = await api.GetAsync<LocationIds>($"api/settings/locations?size_id={size.Id}&ids_only=1", Ct);
            Assert.Equal(6, ids.Ids.Count);

            // One by one: a new one, changed, its detail.
            var one = await api.PostAsync<SettingsLocation>("api/settings/locations",
                new { code = $"T{stamp}-X", size_id = size.Id, kind = "packing", pick_sequence = 0 }, Ct);
            Assert.Equal("T", one.Zone);
            var dup = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<SettingsLocation>("api/settings/locations",
                new { code = $"T{stamp}-X", size_id = size.Id }, Ct));
            Assert.True(dup.Fields.ContainsKey("code"));
            await api.PatchAsync<SettingsLocation>($"api/settings/locations/{one.Id}", new { note = "Teszt hely", pick_sequence = 7 }, Ct);
            var detail = await api.GetAsync<SettingsLocationDetail>($"api/settings/locations/{one.Id}", Ct);
            Assert.True(detail.Deletable);
            Assert.Equal(7, detail.PickSequence);
            Assert.Equal("Teszt hely", detail.Note);
            Assert.Empty(detail.Stock);

            // The selected at once: changed, deactivated, deleted.
            var all = ids.Ids.Append(one.Id).ToList();
            var updated = await api.PostAsync<BulkUpdated>("api/settings/locations/bulk-update", new { ids = all, zone = "teszt2", pick_sequence = 5 }, Ct);
            Assert.Equal(7, updated.Updated);
            var off = await api.PostAsync<BulkUpdated>("api/settings/locations/bulk-update", new { ids = all, active = false }, Ct);
            Assert.Equal(7, off.Updated);
            var inactive = await api.GetAsync<SettingsLocationsPage>($"api/settings/locations?size_id={size.Id}&active=0&zone=TESZT2", Ct);
            Assert.Equal(7, inactive.Total);
            var deleted = await api.PostAsync<BulkDeleted>("api/settings/locations/bulk-delete", new { ids = all }, Ct);
            Assert.Equal(7, deleted.Deleted);
            Assert.Empty(deleted.Skipped);
        }
        finally
        {
            var left = await api.GetAsync<LocationIds>($"api/settings/locations?size_id={size.Id}&ids_only=1", Ct);
            if (left.Ids.Count > 0) await api.PostAsync<BulkDeleted>("api/settings/locations/bulk-delete", new { ids = left.Ids }, Ct);
            await api.DeleteAsync($"api/settings/sizes/{size.Id}", Ct);
        }
        var gone = await api.GetAsync<ItemList<LocationSize>>("api/settings/sizes", Ct);
        Assert.DoesNotContain(gone.Items, (s) => s.Id == size.Id);
    }

    [Fact]
    public async Task A_used_size_is_not_deleted_and_an_occupied_location_stays()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var sizes = await api.GetAsync<ItemList<LocationSize>>("api/settings/sizes", Ct);
        var used = sizes.Items.First((s) => s.LocationCount > 0);
        var refused = await Assert.ThrowsAsync<ApiException>(() => api.DeleteAsync($"api/settings/sizes/{used.Id}", Ct));
        Assert.Equal(409, refused.Status);
        var occupied = await api.GetAsync<SettingsLocationsPage>("api/settings/locations?occupied=1&limit=1", Ct);
        var loc = Assert.Single(occupied.Items);
        Assert.NotNull(loc.OccupantName);
        Assert.True(loc.Qty > 0);
        var detail = await api.GetAsync<SettingsLocationDetail>($"api/settings/locations/{loc.Id}", Ct);
        Assert.NotEmpty(detail.Stock);
        Assert.False(detail.Deletable && detail.OccupantId is null);
        var off = await api.PostAsync<BulkUpdated>("api/settings/locations/bulk-update", new { ids = new[] { loc.Id }, active = false }, Ct);
        Assert.Equal(0, off.Updated);
        Assert.Equal(loc.Code, Assert.Single(off.Skipped).Code);
        var del = await api.PostAsync<BulkDeleted>("api/settings/locations/bulk-delete", new { ids = new[] { loc.Id } }, Ct);
        Assert.Equal(0, del.Deleted);
    }

    [Fact]
    public async Task Couriers_invoicing_and_logs_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var couriers = await api.GetAsync<CourierList>("api/settings/couriers", Ct);
        var gls = couriers.Items.Single((c) => c.Code == "gls");
        Assert.NotEmpty(gls.CredentialFields);
        Assert.NotNull(gls.Features);
        Assert.Contains(couriers.Carriers, (p) => p.CarrierCode == "gls");
        var test = await api.PostAsync<ConnectionTest>("api/settings/couriers/gls/test", null, Ct);
        Assert.False(string.IsNullOrEmpty(test.Message));

        var inv = await api.GetAsync<InvoicingSettings>("api/settings/invoicing", Ct);
        Assert.Contains(inv.Choices, (c) => c.Value == "");
        Assert.Contains(inv.Providers, (p) => p.Code == "szamlazz" && p.CredentialFields.Count > 0);

        var filters = await api.GetAsync<AuditFilters>("api/settings/audit/filters", Ct);
        Assert.Contains(filters.Modules, (m) => m.Key == "settings");
        Assert.Contains(filters.Users, (u) => u.Name.Length > 0);
        var audit = await api.GetAsync<Paged<AuditRow>>("api/settings/audit?module=settings&limit=20", Ct);
        Assert.True(audit.Total > 0);
        Assert.All(audit.Items, (a) => Assert.Equal("settings", a.Module));
        var calls = await api.GetAsync<Paged<IntegrationRow>>("api/settings/integration-log?limit=20", Ct);
        Assert.True(calls.Items.Count <= 20);
        var file = await api.DownloadAsync("api/settings/audit/export?module=settings", Ct);
        Assert.EndsWith(".csv", file.FileName);
    }
}
