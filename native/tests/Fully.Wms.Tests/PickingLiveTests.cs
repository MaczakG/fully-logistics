using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The picking answers read into the app's models, and the calls the app makes go through: a new
// wave, scans, confirmations, a shortage, packing and unpacking, the picker, cancelling.
// The flow uses the orders of the DEMO-BARSONY client, so it does not take the orders the UI test
// starts its wave with (DEMO-MANCS).
// One collection with the other picking tests: they change the same waves and orders.
[Collection("Picking")]
public class PickingLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Waves_and_packing_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var page = await api.GetAsync<WavesPage>("api/picking/waves?status=all&limit=50", Ct);
        Assert.NotEmpty(page.Items);
        Assert.Equal(page.Counts.Values.Sum(), page.Total);
        foreach (var row in page.Items)
        {
            var w = await api.GetAsync<WaveDetail>($"api/picking/waves/{row.Id}", Ct);
            Assert.Equal(row.Number, w.Number);
            Assert.Equal(row.Qty, w.Progress.Qty);
            Assert.Equal(row.Picked, w.Progress.Picked);
            Assert.Equal(w.Progress.Qty, w.Tasks.Sum((t) => t.Qty));
            Assert.Equal(w.Progress.OpenTasks, w.Tasks.Count((t) => t.IsOpen));
            Assert.All(w.Tasks, (t) =>
            {
                Assert.False(string.IsNullOrEmpty(t.Location.Code));
                Assert.False(string.IsNullOrEmpty(t.Product.Sku));
                Assert.Contains(t.PickId, t.PickIds);
                Assert.NotEmpty(t.Orders);
            });
            Assert.All(w.Orders, (o) => Assert.False(string.IsNullOrEmpty(o.PartnerCode)));
            foreach (var o in w.Orders.Take(3))
            {
                var p = await api.GetAsync<PackingOrder>($"api/picking/orders/{o.Id}", Ct);
                Assert.Equal(o.Number, p.Number);
                Assert.False(string.IsNullOrEmpty(p.Partner.Code));
                Assert.NotEmpty(p.Lines);
                Assert.Equal(p.Lines.All((l) => l.Done), p.AllPicked);
                if (o.InWave) Assert.Equal(w.Id, p.Wave?.Id);
            }
        }
        var queue = await api.GetAsync<PackingQueue>("api/picking/packing", Ct);
        Assert.Equal(page.ReadyToPack, queue.Ready.Count);
    }

    [Fact]
    public async Task Wave_pick_short_pack_unpack_cancel()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var client = (await api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client", Ct)).Items.Single((p) => p.Code == "DEMO-BARSONY");
        var candidates = await api.GetAsync<OrderCandidates>($"api/orders?status=new&availability=ok&partner_id={client.Id}&limit=10", Ct);
        if (candidates.Items.Count == 0) Assert.Skip("Nincs indítható rendelés a mintaadatokban (indítsd újra a szervert).");

        var created = await api.PostAsync<WaveCreated>("api/picking/waves", new { order_ids = candidates.Items.Select((o) => o.Id).ToArray(), note = "native teszt" }, Ct);
        Assert.Equal(candidates.Items.Count, created.Orders);
        Assert.Empty(created.Skipped);
        var w = await api.GetAsync<WaveDetail>($"api/picking/waves/{created.Id}", Ct);
        Assert.Equal("open", w.Status);
        Assert.Equal(created.Number, w.Number);
        Assert.True(w.Progress.OpenTasks >= 1);

        // The picker: set, then cleared with an explicit null.
        var worker = (await api.GetAsync<ItemList<UserLookup>>("api/lookup/users", Ct)).Items.First((u) => u.Name != "Admin Anna");
        var withPicker = await api.PatchAsync<WaveDetail>($"api/picking/waves/{w.Id}", new { picker_id = worker.Id }, Ct);
        Assert.Equal(worker.Id, withPicker.PickerId);
        Assert.Equal(worker.Name, withPicker.PickerName);
        var noPicker = await api.PatchAsync<WaveDetail>($"api/picking/waves/{w.Id}", new Dictionary<string, object?> { ["picker_id"] = null }, Ct);
        Assert.Null(noPicker.PickerId);

        // What a scanned code is.
        var first = w.Tasks.First((t) => t.IsOpen);
        var loc = await api.GetAsync<WaveScanResult>(Query.Build($"api/picking/waves/{w.Id}/scan", ("code", first.Location.Code)), Ct);
        Assert.Equal("location", loc.Kind);
        Assert.Equal(first.Location.Id, loc.Location!.Id);
        var prod = await api.GetAsync<WaveScanResult>(Query.Build($"api/picking/waves/{w.Id}/scan", ("code", first.Product.Ean ?? first.Product.Sku)), Ct);
        Assert.Equal("product", prod.Kind);
        Assert.Equal(first.Product.Sku, prod.Product!.Sku);
        var ord = await api.GetAsync<WaveScanResult>(Query.Build($"api/picking/waves/{w.Id}/scan", ("code", w.Orders[0].Number)), Ct);
        Assert.Equal("order", ord.Kind);
        Assert.Equal(w.Orders[0].Id, ord.Order!.Id);
        var unknown = await api.GetAsync<WaveScanResult>(Query.Build($"api/picking/waves/{w.Id}/scan", ("code", "NINCS-ILYEN-KOD")), Ct);
        Assert.Equal("unknown", unknown.Kind);
        Assert.False(string.IsNullOrEmpty(unknown.Message));
        Assert.True(first.Product.Matches(first.Product.Sku.ToLowerInvariant()));
        if (first.Product.Ean is { Length: > 0 } ean) Assert.True(first.Product.Matches("0" + ean));

        // A wrong location is refused with the field.
        var wrongLoc = w.Tasks.Select((t) => t.Location.Code).FirstOrDefault((c) => c != first.Location.Code) ?? "Z-99-99";
        var e = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickConfirmed>($"api/picking/waves/{w.Id}/confirm",
            new { pick_id = first.PickId, location_code = wrongLoc, product_code = first.Product.Sku, qty = 1 }, Ct));
        Assert.Equal(409, e.Status);
        Assert.True(e.Fields.ContainsKey("location_code"));

        // Every task but the last is picked; the last one is short.
        var open = w.Tasks.Where((t) => t.IsOpen).ToList();
        foreach (var t in open.Take(open.Count - 1))
        {
            var r = await api.PostAsync<PickConfirmed>($"api/picking/waves/{w.Id}/confirm",
                new { pick_id = t.PickId, location_code = t.Location.Code, product_code = t.Product.Sku, qty = t.Remaining }, Ct);
            Assert.Equal(t.Remaining, r.Picked);
            Assert.Equal(0, r.Left);
        }
        var last = open[^1];
        var s = await api.PostAsync<PickShort>($"api/picking/waves/{w.Id}/short", new { pick_id = last.PickId }, Ct);
        Assert.Equal(last.Remaining, s.Short);
        Assert.Equal(s.Short, s.Moved.Sum((m) => m.Qty) + s.Missing);

        w = await api.GetAsync<WaveDetail>($"api/picking/waves/{w.Id}", Ct);
        Assert.Contains(w.Status, new[] { "picking", "picked" });
        Assert.Equal(w.Progress.Short, w.Tasks.Sum((t) => t.Short));

        // Pack a ready order by hand (GLS needs a tracking number), then undo it.
        if (w.Orders.FirstOrDefault((o) => o.Ready) is { } ready)
        {
            var p = await api.GetAsync<PackingOrder>($"api/picking/orders/{ready.Id}", Ct);
            Assert.True(p.AllPicked);
            if (p.TrackingRequired)
            {
                var missing = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PackingOrder>($"api/picking/orders/{p.Id}/pack",
                    new { mode = "manual", package_count = 1, tracking_number = "" }, Ct));
                Assert.Equal(400, missing.Status);
            }
            var looked = await api.GetAsync<PackingOrder>(Query.Build("api/picking/packing/lookup", ("code", p.Number), ("wave_id", w.Id)), Ct);
            Assert.Equal(p.Id, looked.Id);
            var packed = await api.PostAsync<PackingOrder>($"api/picking/orders/{p.Id}/pack",
                new Dictionary<string, object?> { ["mode"] = "manual", ["package_count"] = 2, ["weight_kg"] = 3.5m, ["tracking_number"] = "NATIVE TESZT 1" }, Ct);
            Assert.Equal("packed", packed.Status);
            Assert.Equal(2, packed.PackageCount);
            Assert.Equal(3.5m, packed.WeightKg);
            Assert.Equal("NATIVETESZT1", packed.TrackingNumber);
            var queue = await api.GetAsync<PackingQueue>($"api/picking/packing?wave_id={w.Id}", Ct);
            Assert.Contains(queue.Packed, (x) => x.Id == p.Id);
            Assert.Equal(w.Id, queue.Wave?.Id);
            var unpacked = await api.PostAsync<PackingOrder>($"api/picking/orders/{p.Id}/unpack", new { reason = "native teszt" }, Ct);
            Assert.Equal("picking", unpacked.Status);
            Assert.True(string.IsNullOrEmpty(unpacked.TrackingNumber));
        }

        // Cancelling books the picked pieces back.
        var cancelled = await api.PostAsync<WaveCancelled>($"api/picking/waves/{w.Id}/cancel", new { reason = "native teszt" }, Ct);
        Assert.True(cancelled.Ok);
        Assert.Equal(w.Progress.Picked, cancelled.Restocked.Sum((x) => x.Qty));
        Assert.All(cancelled.Restocked, (x) =>
        {
            Assert.True(x.PickId > 0);
            Assert.False(string.IsNullOrEmpty(x.Code));
        });
        var after = await api.GetAsync<WaveDetail>($"api/picking/waves/{w.Id}", Ct);
        Assert.Equal("cancelled", after.Status);
    }
}
