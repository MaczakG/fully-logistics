using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The transport answers read into the app's models, and the calls the app makes go through. The
// demo data: FA-2026-00001 closed (GLS), FA-2026-00002 planned (FoxPost, orders 6 and 7, the
// screen test's), order 8 packed for GLS (this test's), FU-2026-00001 requested. Closing a
// manifest ships orders, so these run with the order tests.
[Collection("Picking")]
public class TransportLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Board_and_pickups_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var board = await api.GetAsync<TransportBoard>("api/transport/board", Ct);
        Assert.Equal(board.Today, board.Date);
        Assert.Contains(board.Carriers, (c) => c.Code == "DEMO-GLS" && c.CarrierCode == "gls");
        Assert.Equal(board.Carriers.Sum((c) => c.Waiting.Orders), board.Totals.Waiting.Orders);
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<TransportBoard>("api/transport/board?date=tegnap", Ct));
        Assert.Equal(400, bad.Status);

        var closed = await api.GetAsync<PickupDetail>("api/transport/pickups/1", Ct);
        Assert.Equal("closed", closed.Status);
        Assert.Equal(closed.Orders.Count, closed.Totals.Orders);
        Assert.Empty(closed.Waiting);
        Assert.False(string.IsNullOrEmpty(closed.Company.Name));
        var day = await api.GetAsync<TransportBoard>($"api/transport/board?date={closed.Date}", Ct);
        var item = day.Carriers.SelectMany((c) => c.Pickups).Single((p) => p.Id == 1);
        Assert.Equal(closed.Totals.Orders, item.Totals.Orders);
        var csv = await api.DownloadAsync("api/transport/pickups/1/manifest.csv", Ct);
        Assert.Equal("text/csv", csv.ContentType);
        Assert.Contains("Nyomkövetési szám", System.Text.Encoding.UTF8.GetString(csv.Bytes));
        var html = System.Text.Encoding.UTF8.GetString(Modules.Transport.PickupManifest.Build(closed).Bytes);
        Assert.Contains(closed.ManifestNumber!, html);
        Assert.Contains(closed.Orders[0].Number, html);

        var transports = await api.GetAsync<Paged<TransportRow>>("api/transport/transports?status=all", Ct);
        Assert.Contains(transports.Items, (t) => t.Number == "FU-2026-00001" && t.Direction == "in");
    }

    [Fact]
    public async Task Pickup_scanned_closed_and_shipped()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var eight = await api.GetAsync<OrderDetail>("api/orders/8", Ct);
        if (eight.Status != "packed") Assert.Skip("A 8-as rendelés már nem feladásra kész (indítsd újra a szervert).");
        var today = Modules.Transport.TransportFormat.Today;

        // A pickup of GLS for today; the window is checked.
        var wrong = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickupCreated>("api/transport/pickups",
            new { carrier_id = 4, date = today, window_from = "15:00", window_to = "14:00" }, Ct));
        Assert.Equal(400, wrong.Status);
        Assert.True(wrong.Fields.ContainsKey("window_to"));
        var created = await api.PostAsync<PickupCreated>("api/transport/pickups",
            new { carrier_id = 4, date = today, window_from = "14:00", window_to = "15:00", note = "Native teszt" }, Ct);
        Assert.StartsWith("FA-", created.Number);
        var p = await api.GetAsync<PickupDetail>($"api/transport/pickups/{created.Id}", Ct);
        Assert.Equal("planned", p.Status);
        Assert.Contains(p.Waiting, (o) => o.Id == 8);

        // Scanning: unknown, the parcel label, again, another carrier's order.
        var none = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickupScanned>($"api/transport/pickups/{p.Id}/scan", new { code = "NINCS-ILYEN" }, Ct));
        Assert.Equal(404, none.Status);
        var scanned = await api.PostAsync<PickupScanned>($"api/transport/pickups/{p.Id}/scan", new { code = eight.TrackingNumber }, Ct);
        Assert.False(scanned.Already);
        Assert.Equal(8, scanned.Order.Id);
        Assert.Contains(scanned.Pickup.Orders, (o) => o.Id == 8);
        var again = await api.PostAsync<PickupScanned>($"api/transport/pickups/{p.Id}/scan", new { code = eight.Number }, Ct);
        Assert.True(again.Already);
        var other = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickupScanned>($"api/transport/pickups/{p.Id}/scan", new { code = "R-2026-000006" }, Ct));
        Assert.Equal(409, other.Status);

        // Off the manifest and back with "Mind hozzá".
        var removed = await api.DeleteAsync<PickupDetail>($"api/transport/pickups/{p.Id}/orders/8", Ct);
        Assert.DoesNotContain(removed.Orders, (o) => o.Id == 8);
        var all = await api.PostAsync<PickupAssigned>($"api/transport/pickups/{p.Id}/orders", new { all = true }, Ct);
        Assert.True(all.Assigned >= 1);
        Assert.Contains(all.Pickup.Orders, (o) => o.Id == 8);

        // Edited, the courier at the ramp, closed: the orders are shipped.
        var edited = await api.PatchAsync<PickupDetail>($"api/transport/pickups/{p.Id}", new { window_from = "13:30", note = "Native teszt, módosítva" }, Ct);
        Assert.Equal("13:30", edited.WindowFrom);
        var arrived = await api.PostAsync<PickupDetail>($"api/transport/pickups/{p.Id}/arrived", null, Ct);
        Assert.Equal("arrived", arrived.Status);
        Assert.False(string.IsNullOrEmpty(arrived.ArrivedAt));
        var notDeletable = await Assert.ThrowsAsync<ApiException>(() => api.DeleteAsync($"api/transport/pickups/{p.Id}", Ct));
        Assert.Equal(409, notDeletable.Status);
        PickupClosed res;
        do res = await api.PostAsync<PickupClosed>($"api/transport/pickups/{p.Id}/close", new { manifest_number = "GLS-NATIVE-1" }, Ct);
        while (!res.Done);
        Assert.Equal(all.Pickup.Orders.Count, res.Shipped);
        Assert.Equal("GLS-NATIVE-1", res.ManifestNumber);
        var done = await api.GetAsync<PickupDetail>($"api/transport/pickups/{p.Id}", Ct);
        Assert.Equal("closed", done.Status);
        Assert.Empty(done.Waiting);
        Assert.Equal("shipped", (await api.GetAsync<OrderDetail>("api/orders/8", Ct)).Status);
        var closedAgain = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickupScanned>($"api/transport/pickups/{p.Id}/scan", new { code = "x" }, Ct));
        Assert.Equal(409, closedAgain.Status);
    }

    [Fact]
    public async Task Pickup_cancelled_releases_its_orders()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var created = await api.PostAsync<PickupCreated>("api/transport/pickups",
            new { carrier_id = 5, date = Modules.Transport.TransportFormat.Today }, Ct);
        var p = await api.GetAsync<PickupDetail>($"api/transport/pickups/{created.Id}", Ct);
        Assert.Equal("", p.WindowFrom);
        await api.DeleteAsync($"api/transport/pickups/{p.Id}", Ct);
        Assert.Equal("cancelled", (await api.GetAsync<PickupDetail>($"api/transport/pickups/{p.Id}", Ct)).Status);
        var past = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<PickupCreated>("api/transport/pickups",
            new { carrier_id = 5, date = "2020-01-01" }, Ct));
        Assert.True(past.Fields.ContainsKey("date"));
    }

    [Fact]
    public async Task Transport_through_its_steps()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var t = await api.PostAsync<TransportRow>("api/transport/transports", new Dictionary<string, object?>
        {
            ["direction"] = "out", ["partner_id"] = 1, ["carrier_id"] = null, ["date"] = Modules.Transport.TransportFormat.Today,
            ["time_from"] = "09:00", ["time_to"] = "11:00", ["origin"] = "Fully Logistics, Alsónémedi", ["destination"] = "Budapest",
            ["pallets"] = 3, ["weight_kg"] = 820.5m, ["vehicle"] = "", ["price"] = null, ["carrier_ref"] = "", ["note"] = "Native teszt",
        }, Ct);
        Assert.Equal("requested", t.Status);
        Assert.Equal("DEMO-MANCS", t.PartnerCode);
        Assert.Equal(820.5m, t.WeightKg);

        var noCarrier = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<TransportRow>($"api/transport/transports/{t.Id}/status", new { status = "booked" }, Ct));
        Assert.True(noCarrier.Fields.ContainsKey("carrier_id"));
        var badWindow = await Assert.ThrowsAsync<ApiException>(() => api.PatchAsync<TransportRow>($"api/transport/transports/{t.Id}",
            new { time_from = "12:00" }, Ct));
        Assert.True(badWindow.Fields.ContainsKey("time_to"));
        t = await api.PatchAsync<TransportRow>($"api/transport/transports/{t.Id}", new { carrier_id = 4, price = 45000, carrier_ref = "GLS-F-1" }, Ct);
        Assert.Equal("DEMO-GLS", t.CarrierShort);
        t = await api.PostAsync<TransportRow>($"api/transport/transports/{t.Id}/status", new { status = "booked" }, Ct);
        Assert.Equal("booked", t.Status);
        t = await api.PostAsync<TransportRow>($"api/transport/transports/{t.Id}/status", new { status = "in_transit" }, Ct);
        var skip = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<TransportRow>($"api/transport/transports/{t.Id}/status", new { status = "requested" }, Ct));
        Assert.Equal(409, skip.Status);
        t = await api.PostAsync<TransportRow>($"api/transport/transports/{t.Id}/status", new { status = "booked" }, Ct);
        Assert.Equal("booked", t.Status);

        var active = await api.GetAsync<Paged<TransportRow>>("api/transport/transports?q=GLS-F-1", Ct);
        Assert.Contains(active.Items, (r) => r.Id == t.Id);
        await api.DeleteAsync($"api/transport/transports/{t.Id}", Ct);
        Assert.Equal("cancelled", (await api.GetAsync<TransportRow>($"api/transport/transports/{t.Id}", Ct)).Status);
        var locked = await Assert.ThrowsAsync<ApiException>(() => api.PatchAsync<TransportRow>($"api/transport/transports/{t.Id}", new { pallets = 1 }, Ct));
        Assert.Equal(409, locked.Status);
    }
}
