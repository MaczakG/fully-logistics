using Avalonia.Headless.XUnit;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Picking;
using Fully.Wms.Services;

namespace Fully.Wms.Tests;

// Picking as the warehouse uses it: a new wave from the preview, the tasks one after the other
// (location, product, quantity), a shortage, the packing station, closing the wave; and the PDA on
// the phone with the worker's rights.
// One collection with the other picking tests: they change the same waves and orders.
[Collection("Picking")]
public class PickingUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    [AvaloniaFact]
    public async Task Desktop_new_wave_pick_short_pack_and_close()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("picking");
        var list = Assert.IsType<WavesViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Screens.Save(window, "picking-list-desktop");

        // New wave: the preview follows the filters; the DEMO-MANCS orders are taken.
        await list.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<NewWaveViewModel>(shell.Current);
        await WaitAsync(() => form.Clients.Count > 1 && form.Preview.Contains("rendelés"));
        form.Client = form.Clients.Single((c) => c.Label.StartsWith("Mancsbirodalom"));
        await WaitAsync(() => form.PreviewNumbers.Length > 0 && form.PreviewTone == "info");
        Screens.Save(window, "picking-new-wave-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        var page = Assert.IsType<WaveViewModel>(shell.Current);
        Assert.NotNull(page.Data);
        Assert.True(page.Working);
        Assert.Equal("location", page.Step);
        Screens.Save(window, "picking-wave-start-desktop");

        // The product before the location is refused; the location, then the product.
        var task = page.Current!;
        await page.ScanCommand.ExecuteAsync(task.Product.Sku);
        Assert.Equal("danger", page.FeedbackTone);
        await page.ScanCommand.ExecuteAsync(task.Location.Code.ToLowerInvariant());
        Assert.Equal("product", page.Step);
        Assert.Equal("ok", page.FeedbackTone);
        await page.ScanCommand.ExecuteAsync("NINCS-ILYEN-KOD");
        Assert.Equal("danger", page.FeedbackTone);

        // Pick every task; the first one with more than one piece is counted, then shown.
        var shorted = false;
        for (var guard = 0; guard < 40 && page.Current is { } cur; guard++)
        {
            if (page.Step == "location") await page.ScanCommand.ExecuteAsync(cur.Location.Code);
            Assert.Equal("product", page.Step);
            if (!shorted && page.Data!.Progress.OpenTasks == 1 && page.Data.Progress.Picked > 0)
            {
                // The last task: a shortage, nothing found on the shelf.
                await page.ShortCommand.ExecuteAsync(null);
                var dlg = Assert.IsType<WaveShortViewModel>(shell.Current);
                Assert.False(dlg.Scanned);
                Screens.Save(window, "picking-short-desktop");
                await dlg.SaveCommand.ExecuteAsync(null);
                Assert.Same(page, shell.Current);
                Assert.Contains("Hiány rögzítve", page.Feedback);
                shorted = true;
                continue;
            }
            await page.ScanCommand.ExecuteAsync(cur.Product.Ean ?? cur.Product.Sku);
            if (cur.Remaining > 1)
            {
                Assert.Equal("qty", page.Step);
                Assert.Equal(cur.Remaining.ToString(), page.Qty);
                page.QtyMinusCommand.Execute(null);
                Assert.Equal((cur.Remaining - 1).ToString(), page.Qty);
                page.QtyPlusCommand.Execute(null);
                page.QtyPlusCommand.Execute(null);
                Assert.Equal(cur.Remaining.ToString(), page.Qty);
                Screens.Save(window, "picking-qty-desktop");
                await page.ConfirmCommand.ExecuteAsync(null);
            }
            Assert.Equal("ok", page.FeedbackTone);
            Assert.StartsWith("Kiszedve", page.Feedback);
        }
        Assert.False(page.Working);
        Assert.NotNull(page.FinishNotice);
        Screens.Save(window, "picking-wave-done-desktop");

        // The packing station of the wave: an order scanned, packed with a tracking number, undone.
        var ready = page.Data!.Orders.FirstOrDefault((o) => o.Ready);
        if (ready is null) Assert.Skip("Nincs csomagolható rendelés a hullámban.");
        await page.PackingCommand.ExecuteAsync(null);
        var station = Assert.IsType<PackingViewModel>(shell.Current);
        Assert.True(station.HasWave);
        Assert.Contains(station.Queue!.Ready, (o) => o.Id == ready.Id);
        await station.ScanCommand.ExecuteAsync(ready.Number);
        Assert.Equal(ready.Id, station.Order!.Id);
        Assert.True(station.ShowPackForm);
        Assert.True(station.UseManual);
        Screens.Save(window, "picking-packing-desktop");
        station.Tracking = "";
        await station.PackCommand.ExecuteAsync(null);
        if (station.Order.TrackingRequired) Assert.NotNull(station.TrackingError);
        station.Tracking = "NATUI0001";
        station.PackageCount = "2";
        await station.PackCommand.ExecuteAsync(null);
        Assert.True(station.IsPacked, station.Feedback);
        Assert.Equal("NATUI0001", station.Order.TrackingNumber);
        Assert.Contains(station.Queue!.Packed, (o) => o.Id == ready.Id);
        Screens.Save(window, "picking-packed-desktop");
        await station.UnpackCommand.ExecuteAsync(null);
        var unpack = Assert.IsType<UnpackViewModel>(shell.Current);
        await unpack.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(unpack.ReasonError);
        unpack.Reason = "native UI teszt";
        await unpack.SaveCommand.ExecuteAsync(null);
        Assert.Same(station, shell.Current);
        Assert.Equal("picking", station.Order!.Status);
        Assert.Equal("Csomagolás visszavonva.", station.Feedback);
        station.NextCommand.Execute(null);
        Assert.False(station.HasOrder);

        // Closing with a shortage asks first and reverts the incomplete orders.
        await shell.BackAsync();
        Assert.Same(page, shell.Current);
        var closing = page.CompleteCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        Assert.Equal($"{page.Data!.Number} lezárása", shell.Dialog!.Title);
        Screens.Save(window, "picking-complete-desktop");
        shell.Dialog.OkCommand.Execute(null);
        await closing;
        Assert.Equal("completed", page.Data!.Status);
        Assert.False(page.CanComplete);
        Screens.Save(window, "picking-wave-closed-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_worker_picks_the_open_wave()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("picking");
        var list = Assert.IsType<WavesViewModel>(shell.Current);
        Assert.True(list.CanCreate);
        Screens.Save(window, "picking-list-phone");

        // The demo data's wave in picking (H-2026-00002).
        var row = list.Items.FirstOrDefault((w) => w.Number == "H-2026-00002" && w.Status == "picking");
        if (row is null) Assert.Skip("A mintaadatok kiszedés alatti hulláma nincs meg (indítsd újra a szervert).");
        list.Selected = row;
        await WaitAsync(() => shell.Current is WaveViewModel { Data: not null });
        var page = (WaveViewModel)shell.Current!;
        Assert.True(page.Working);
        Assert.False(page.CanCancel);
        Screens.Save(window, "picking-wave-phone");

        var cur = page.Current!;
        await page.ScanCommand.ExecuteAsync(cur.Location.Code);
        Assert.Equal("product", page.Step);
        await page.ScanCommand.ExecuteAsync(cur.Product.Sku);
        if (cur.Remaining > 1)
        {
            Assert.Equal("qty", page.Step);
            Screens.Save(window, "picking-qty-phone");
            // A scanner that typed into the quantity: the digits stay, the code is a scan.
            page.Qty = "1" + cur.Product.Sku;
            await page.QuantityEnterCommand.ExecuteAsync(null);
            Assert.Equal("1", page.Qty);
            Assert.Equal("qty", page.Step);
            await page.ConfirmCommand.ExecuteAsync(null);
        }
        Assert.Equal("ok", page.FeedbackTone);
        Screens.Save(window, "picking-confirmed-phone");

        // "Kihagyás" moves on; the worker cannot close with a shortage.
        if (page.ShowSkip)
        {
            var before = page.Current!.Key;
            page.SkipCommand.Execute(null);
            Assert.NotEqual(before, page.Current!.Key);
        }
        Assert.True(page.CompleteNeedsApproval);

        // The packing station on the phone.
        await page.PackingCommand.ExecuteAsync(null);
        Assert.IsType<PackingViewModel>(shell.Current);
        Screens.Save(window, "picking-packing-phone");
    }

    [AvaloniaFact]
    public async Task Desktop_packing_station_is_one_window()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("picking");
        var list = Assert.IsType<WavesViewModel>(shell.Current);

        // The demo data's closed wave in its own window.
        await shell.NavigateAsync(new WaveViewModel(shell, 1));
        Screens.Settle();
        var waveWindow = Assert.Single(presenter.Records);
        var wave = Assert.IsType<WaveViewModel>(waveWindow.Page);
        Assert.Same(list, shell.Current);
        Assert.Equal("completed", wave.Data!.Status);
        Assert.False(wave.Working);
        Screens.Save(waveWindow, "picking-wave-window");

        // The packing station: one window; opening it with an order loads the order into it.
        waveWindow.Activate();
        await wave.PackingCommand.ExecuteAsync(null);
        Screens.Settle();
        Assert.Equal(2, presenter.Records.Count);
        var station = Assert.IsType<PackingViewModel>(presenter.Records[1].Page);
        Assert.True(station.HasWave);
        var order = wave.Data.Orders[0];
        await PackingViewModel.OpenAsync(shell, null, order.Id);
        Screens.Settle();
        Assert.Equal(2, presenter.Records.Count);
        Assert.Equal(order.Id, station.Order?.Id);
        Assert.False(station.HasWave);
        Assert.False(station.ShowPackForm);
        Screens.Save(presenter.Records[1], "picking-packing-window");
        presenter.CloseAll();
    }
}
