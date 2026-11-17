using Avalonia.Headless.XUnit;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;

namespace Fully.Wms.Tests;

// The order screens: the list with key figures, filters and selection, a new order from the form,
// edit, hold and release, a note, cancel; and the read-only view of the warehouse worker's phone.
[Collection("Picking")]
public class OrdersUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    [AvaloniaFact]
    public async Task Desktop_list_new_order_edit_hold_and_cancel()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("orders");
        var list = Assert.IsType<OrdersViewModel>(shell.Current);
        Assert.NotEmpty(list.Items);
        Assert.NotNull(list.Kpis);
        Screens.Save(window, "orders-list-desktop");

        // The key figure "Teljesíthető": new orders with full stock.
        await list.ShowCommand.ExecuteAsync("fulfillable");
        Assert.All(list.Items, (i) => Assert.Equal("ok", i.Row.Availability));
        // The selection offers the wave (the dialog is only looked at here).
        list.Items[0].IsSelected = true;
        Assert.StartsWith("1 kijelölve, ebből 1 indítható", list.SelectionText);
        Screens.Save(window, "orders-selected-desktop");
        await list.WaveCommand.ExecuteAsync(null);
        var send = Assert.IsType<SendToPickingViewModel>(shell.Current);
        Assert.True(send.HasOk);
        Screens.Save(window, "orders-wave-dialog-desktop");
        await shell.BackAsync();
        list.UnselectCommand.Execute(null);
        Assert.False(list.HasSelection);
        await list.ClearFiltersCommand.ExecuteAsync(null);

        // A new order for DEMO-KONYHA.
        await list.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<OrderFormViewModel>(shell.Current);
        await WaitAsync(() => form.Clients.Count > 1 && form.Carriers.Count > 1);
        await form.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(form.Error);
        form.Client = form.Clients.Single((c) => c.Label.Contains("DEMO-KONYHA"));
        var products = await shell.Services.Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", form.Client.Id), ("q", "DEMO")), Ct);
        form.CustomerName = "Native UI Teszt";
        form.Zip = "6720";
        form.City = "Szeged";
        form.Address = "Kárász utca 1.";
        form.Carrier = form.Carriers[1];
        form.Lines[0].Product = products.Items[0];
        form.Lines[0].Qty = "1";
        Screens.Save(window, "orders-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Null(form.Error);
        var order = Assert.IsType<OrderViewModel>(shell.Current);
        Assert.Equal("new", order.Status);
        Assert.True(order.CanEdit && order.CanHold && order.CanCancel);
        Screens.Save(window, "orders-detail-desktop");

        // Edit: another city.
        await order.EditCommand.ExecuteAsync(null);
        var edit = Assert.IsType<OrderFormViewModel>(shell.Current);
        await WaitAsync(() => edit.Carriers.Count > 1);
        Assert.Equal("Native UI Teszt", edit.CustomerName);
        Assert.Single(edit.Lines);
        edit.City = "Pécs";
        edit.Email = "nem-email";
        await edit.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(edit.Error);
        Assert.True(edit.Errors.ContainsKey("email"));
        edit.Email = "";
        await edit.SaveCommand.ExecuteAsync(null);
        Assert.Same(order, shell.Current);
        Assert.Equal("Pécs", order.Data!.City);

        // Hold (a reason is needed), release, a note.
        await order.HoldCommand.ExecuteAsync(null);
        var hold = Assert.IsType<OrderReasonViewModel>(shell.Current);
        await hold.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(hold.ReasonError);
        hold.Reason = "A vevő kérte";
        await hold.SaveCommand.ExecuteAsync(null);
        Assert.Equal("hold", order.Status);
        Assert.Equal("release", order.Primary);
        await order.ReleaseCommand.ExecuteAsync(null);
        await Assert.IsType<OrderReasonViewModel>(shell.Current).SaveCommand.ExecuteAsync(null);
        Assert.Equal("new", order.Status);
        order.NoteText = "Native UI megjegyzés";
        await order.AddNoteCommand.ExecuteAsync(null);
        Assert.Contains(order.Events, (e) => e.Text == "Native UI megjegyzés");

        // Cancel.
        await order.CancelOrderCommand.ExecuteAsync(null);
        var cancel = Assert.IsType<OrderReasonViewModel>(shell.Current);
        Assert.True(cancel.Danger);
        cancel.Reason = "native UI teszt";
        Screens.Save(window, "orders-cancel-desktop");
        await cancel.SaveCommand.ExecuteAsync(null);
        Assert.Equal("cancelled", order.Status);
        Assert.NotNull(order.StateNotice);
        Assert.False(order.CanEdit);
        Screens.Save(window, "orders-cancelled-desktop");
    }

    [AvaloniaFact]
    public async Task Phone_worker_sees_orders()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell(phone: true);
        var window = Screens.Open(shell, 390, 844);
        await Screens.SignInAsync(shell, LiveServer.Worker);
        await shell.OpenModuleAsync("orders");
        var list = Assert.IsType<OrdersViewModel>(shell.Current);
        Assert.False(list.CanCreate);
        Assert.NotEmpty(list.Items);
        Screens.Save(window, "orders-list-phone");
        list.Selected = list.Items.First((i) => i.Row.Status == "picking" || i.Row.Status == "new");
        await WaitAsync(() => shell.Current is OrderViewModel { Data: not null });
        var order = (OrderViewModel)shell.Current!;
        Assert.False(order.CanEdit);
        Assert.False(order.CanCancel);
        Assert.False(order.CanNote);
        Screens.Save(window, "orders-detail-phone");
    }
}
