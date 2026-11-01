using Avalonia.Headless.XUnit;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Transport;
using Fully.Wms.Core;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Tests;

// The transport screens: the day's board, the demo data's open FoxPost pickup (FA-2026-00002,
// orders 6 and 7) scanned, edited and closed, a new pickup deleted, the pallet transports with a
// new one through its steps; the pickup as its own window; the worker's phone.
[Collection("Picking")]
public class TransportUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    [AvaloniaFact]
    public async Task Desktop_board_pickup_closed()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("transport");
        var board = Assert.IsType<TransportBoardViewModel>(shell.Current);
        Assert.NotNull(board.Data);
        Assert.True(board.IsToday);
        Assert.Contains(board.Cards, (c) => c.Carrier.Code == "DEMO-GLS");
        Screens.Save(window, "transport-board-desktop");

        // The day of the demo pickups.
        await board.DayCommand.ExecuteAsync("-1");
        Assert.False(board.IsToday);
        board.DateValue = new DateTime(2026, 10, 17);
        await WaitAsync(() => !board.IsLoading && board.Data?.Date == "2026-10-17");
        var fox = board.Cards.Single((c) => c.Carrier.Code == "DEMO-FOXPOST");
        var item = fox.Pickups.SingleOrDefault((p) => p.Pickup.Number == "FA-2026-00002");
        Assert.NotNull(item);
        Screens.Save(window, "transport-board-day-desktop");
        if (item.Pickup.Status != "planned") Assert.Skip("Az FA-2026-00002 már nem tervezett (indítsd újra a szervert).");
        Assert.Equal("Manifeszt", item.OpenText);

        // The manifest: one off, scanned back, an unknown code.
        item.OpenCommand.Execute(null);
        await WaitAsync(() => shell.Current is PickupViewModel { Data: not null });
        var p = (PickupViewModel)shell.Current!;
        Assert.True(p.Editable && p.CanArrive && p.CanDelete && p.CanClose);
        Assert.Equal(2, p.Manifest.Count);
        Screens.Save(window, "transport-pickup-desktop");
        var seven = p.Manifest.Single((m) => m.Order.Number == "R-2026-000007");
        seven.RemoveCommand.Execute(null);
        await WaitAsync(() => p.Manifest.Count == 1);
        Assert.Equal("info", p.FeedbackTone);
        Assert.Contains(p.Waiting, (w) => w.Order.Id == 7);
        await p.ScanCommand.ExecuteAsync("R-2026-000007");
        Assert.Equal("ok", p.FeedbackTone);
        Assert.Equal(2, p.Manifest.Count);
        await p.ScanCommand.ExecuteAsync("NINCS-ILYEN");
        Assert.Equal("danger", p.FeedbackTone);
        Assert.Contains("NINCS-ILYEN", p.Feedback);
        Screens.Save(window, "transport-pickup-scan-desktop");

        // The courier arrives; the window is changed (checked first).
        await p.ArrivedCommand.ExecuteAsync(null);
        Assert.Equal("arrived", p.Status);
        Assert.False(p.CanDelete);
        Assert.NotNull(p.ArrivedText);
        await p.EditCommand.ExecuteAsync(null);
        var edit = Assert.IsType<PickupFormViewModel>(shell.Current);
        Assert.False(edit.IsNew);
        edit.WindowFrom = "17:00";
        edit.WindowTo = "16:00";
        await edit.SaveCommand.ExecuteAsync(null);
        Assert.True(edit.Errors.ContainsKey("window_to"));
        edit.WindowFrom = "1630";
        edit.WindowTo = "17:30";
        Screens.Save(window, "transport-pickup-edit-desktop");
        await edit.SaveCommand.ExecuteAsync(null);
        Assert.Same(p, shell.Current);
        Assert.Equal("17:30", p.Data!.WindowTo);
        Assert.Equal("16:30", p.Data.WindowFrom);

        // Print, CSV, closing with the carrier's manifest number.
        await p.PrintCommand.ExecuteAsync(null);
        await p.CsvCommand.ExecuteAsync(null);
        var opened = Assert.IsType<TestPlatform>(shell.Services.Platform).Opened;
        Assert.Contains(opened, (f) => f.FileName.EndsWith(".html") && System.Text.Encoding.UTF8.GetString(f.Bytes).Contains("Átadás-átvételi manifeszt"));
        Assert.Contains(opened, (f) => f.FileName.EndsWith(".csv"));
        await p.CloseManifestCommand.ExecuteAsync(null);
        var close = Assert.IsType<PickupCloseViewModel>(shell.Current);
        Assert.Contains("2 rendelés", close.Text);
        close.ManifestNumber = "FOX-NATIVE-1";
        Screens.Save(window, "transport-pickup-close-desktop");
        await close.SaveCommand.ExecuteAsync(null);
        Assert.Same(p, shell.Current);
        Assert.Equal("closed", p.Status);
        Assert.False(p.Editable);
        Assert.Contains("FOX-NATIVE-1", p.ClosedText);
        Screens.Save(window, "transport-pickup-closed-desktop");
        await shell.BackAsync();
    }

    [AvaloniaFact]
    public async Task Desktop_new_pickup_and_transport()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("transport");
        var board = Assert.IsType<TransportBoardViewModel>(shell.Current);

        // A new pickup: the carrier is required; saved, it opens; deleted, back to the board.
        await board.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<PickupFormViewModel>(shell.Current);
        await WaitAsync(() => form.Carriers.Count > 0);
        Assert.True(form.IsNew);
        Assert.Null(form.Carrier);
        form.WindowFrom = "8:00";
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("carrier_id"));
        form.Carrier = form.Carriers.Single((c) => c.Code == "DEMO-GLS");
        Assert.False(form.Errors.ContainsKey("carrier_id"));
        form.WindowTo = "10:00";
        Screens.Save(window, "transport-pickup-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        var p = Assert.IsType<PickupViewModel>(shell.Current);
        await WaitAsync(() => p.Data is not null);
        Assert.Equal("08:00", p.Data!.WindowFrom);
        Assert.Equal("planned", p.Status);
        var deleting = p.DeleteCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        shell.Dialog!.OkCommand.Execute(null);
        await deleting;
        Assert.Same(board, shell.Current);

        // The pallet transports: a new one, through its steps, deleted.
        await board.TransportsCommand.ExecuteAsync(null);
        var list = Assert.IsType<TransportsViewModel>(shell.Current);
        await WaitAsync(() => list.Loaded);
        Screens.Save(window, "transport-list-desktop");
        await list.NewCommand.ExecuteAsync(null);
        var t = Assert.IsType<TransportFormViewModel>(shell.Current);
        await WaitAsync(() => t.Clients.Count > 0 && t.Day is not null);
        Assert.True(t.CanSave);
        Assert.False(t.ShowStatusBar);
        t.Direction = TransportFormViewModel.DirectionChoices[1];
        t.Client = t.Clients.First((c) => c.Label.Contains("DEMO-BARSONY"));
        t.TimeFrom = "25:00";
        t.Pallets = "2,5";
        await t.SaveCommand.ExecuteAsync(null);
        Assert.True(t.Errors.ContainsKey("time_from"));
        Assert.True(t.Errors.ContainsKey("pallets"));
        t.TimeFrom = "07:30";
        t.Pallets = "4";
        t.Weight = "1 250,5";
        t.Origin = "Bársonybőr gyártó, Szeged";
        t.Destination = "Fully Logistics, Alsónémedi";
        t.Vehicle = "12 t ponyvás";
        t.Note = "Native UI teszt";
        Screens.Save(window, "transport-form-new-desktop");
        await t.SaveCommand.ExecuteAsync(null);
        Assert.Same(list, shell.Current);
        await WaitAsync(() => !list.IsLoading && list.Items.Any((i) => i.Row.Note == "Native UI teszt"));
        var row = list.Items.First((i) => i.Row.Note == "Native UI teszt");
        Assert.Equal("requested", row.Row.Status);
        Assert.Equal(1250.5m, row.Row.WeightKg);

        list.Selected = row;
        await WaitAsync(() => shell.Current is TransportFormViewModel { Data: not null });
        var rec = (TransportFormViewModel)shell.Current!;
        Assert.Equal(PageKind.Record, rec.Kind);
        Assert.Equal(["booked"], rec.Steps.Select((s) => s.Status));
        rec.Steps[0].Command.Execute(null);
        await WaitAsync(() => rec.Errors.ContainsKey("carrier_id"));
        rec.Carrier = rec.Carriers.First((c) => c.Label.StartsWith("GLS"));
        rec.Price = "38 000";
        await rec.SaveCommand.ExecuteAsync(null);
        Assert.Equal(38000m, rec.Data!.Price);
        rec.Steps[0].Command.Execute(null);
        await WaitAsync(() => rec.Status == "booked");
        Assert.Equal(["in_transit", "requested"], rec.Steps.Select((s) => s.Status));
        Assert.True(rec.Steps[1].Back);
        Screens.Save(window, "transport-form-desktop");
        var deleting2 = rec.DeleteCommand.ExecuteAsync(null);
        await WaitAsync(() => shell.Dialog is not null);
        shell.Dialog!.OkCommand.Execute(null);
        await deleting2;
        Assert.Same(list, shell.Current);
        Assert.DoesNotContain(list.Items, (i) => i.Row.Id == row.Row.Id);
        await list.BoardCommand.ExecuteAsync(null);
        Assert.IsType<TransportBoardViewModel>(shell.Current);
    }

    [AvaloniaFact]
    public async Task Desktop_pickup_is_a_record_window()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("transport");
        var board = Assert.IsType<TransportBoardViewModel>(shell.Current);

        // The closed demo pickup in its own window; the same one again only comes to the front.
        await shell.NavigateAsync(new PickupViewModel(shell, 1));
        Screens.Settle();
        var w = Assert.Single(presenter.Records);
        var p = Assert.IsType<PickupViewModel>(w.Page);
        Assert.Same(board, shell.Current);
        Assert.Equal("closed", p.Status);
        Assert.False(p.Editable);
        Screens.Save(w, "transport-pickup-window");
        await shell.NavigateAsync(new PickupViewModel(shell, 1));
        Screens.Settle();
        Assert.Single(presenter.Records);

        // The demo transport in its own window.
        await shell.NavigateAsync(new TransportFormViewModel(shell, 1));
        Screens.Settle();
        Assert.Equal(2, presenter.Records.Count);
        var t = Assert.IsType<TransportFormViewModel>(presenter.Records[1].Page);
        await WaitAsync(() => t.Data is not null);
        Screens.Save(presenter.Records[1], "transport-form-window");
        presenter.CloseAll();
    }

    [AvaloniaFact]
    public async Task Phone_worker_board_and_pickup()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("transport");
        var board = Assert.IsType<TransportBoardViewModel>(shell.Current);
        Assert.True(board.IsCompact);
        Assert.False(board.CanCreate);
        Assert.All(board.Cards, (c) => Assert.False(c.CanNew));
        Screens.Save(window, "transport-board-phone");

        // The closed demo pickup: read only.
        await shell.NavigateAsync(new PickupViewModel(shell, 1));
        var p = Assert.IsType<PickupViewModel>(shell.Current);
        Assert.False(p.Editable);
        Assert.False(p.CanClose);
        Assert.NotEmpty(p.Manifest);
        Screens.Save(window, "transport-pickup-phone");
        await shell.BackAsync();

        // The worker scans at the ramp but cannot close the manifest (approve).
        var pickups = await shell.Services.Api.GetAsync<Paged<PickupRowLite>>("api/transport/pickups?status=planned", Ct);
        if (pickups.Items.FirstOrDefault() is { } open)
        {
            await shell.NavigateAsync(new PickupViewModel(shell, open.Id));
            var o = Assert.IsType<PickupViewModel>(shell.Current);
            Assert.True(o.Editable);
            Assert.False(o.CanClose);
            Assert.False(o.CanDelete);
            Screens.Save(window, "transport-pickup-open-phone");
            await shell.BackAsync();
        }

        await board.TransportsCommand.ExecuteAsync(null);
        var list = Assert.IsType<TransportsViewModel>(shell.Current);
        await WaitAsync(() => list.Loaded);
        Assert.False(list.CanCreate);
        Screens.Save(window, "transport-list-phone");
    }

    public sealed record PickupRowLite(int Id, string Number, string Status);
}
