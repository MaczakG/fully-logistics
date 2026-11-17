using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Picking;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Orders;

// The order's forms as dialogs (the web app's dialogs): new and edit, a step with a reason (hold,
// release, cancel), sending to picking.

// POST /api/orders (manual order) or PATCH /api/orders/:id (new or hold only): recipient,
// shipping, COD and the lines; a line already picked keeps its product and at least that quantity.
public sealed partial class OrderFormViewModel : PageViewModel
{
    public OrderFormViewModel(ShellViewModel shell, OrderDetail? order) : base(shell)
    {
        Order = order;
        if (order is null)
        {
            Lines.Add(new OrderFormLine(this));
            return;
        }
        ExternalNumber = order.ExternalNumber ?? "";
        Priority = Priorities.First((p) => p.Key == order.Priority);
        CustomerName = order.CustomerName;
        Company = order.Company ?? "";
        Email = order.Email ?? "";
        Phone = order.Phone ?? "";
        Country = order.Country ?? "HU";
        Zip = order.Zip ?? "";
        City = order.City ?? "";
        Address = order.Address ?? "";
        CarrierService = order.CarrierService ?? "";
        PickupPointId = order.PickupPointId ?? "";
        Cod = order.CodAmount > 0 ? Fmt.Num(order.CodAmount) : "0";
        Note = order.Note ?? "";
        foreach (var l in order.Lines)
        {
            Lines.Add(new OrderFormLine(this)
            {
                LineId = l.Id, PickedQty = l.PickedQty, Qty = l.Qty.ToString(),
                Product = new ProductLookup(l.ProductId, order.Partner.Id, l.Sku, l.Name, l.Ean, l.Unit, order.Partner.Code),
            });
        }
        if (Lines.Count == 0) Lines.Add(new OrderFormLine(this));
    }

    public OrderDetail? Order { get; }
    public bool IsNew => Order is null;
    public override string Title => Order is null ? "Új rendelés" : $"{Order.Number} módosítása";
    public override string? Module => "orders";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 900;
    public string SubmitText => IsNew ? "Rendelés rögzítése" : "Mentés";
    public string ClientText => Order is null ? "" : $"{Order.Partner.Name} ({Order.Partner.Code})";

    public static readonly IReadOnlyList<OrderChoice> Priorities = [new("normal", "Normál"), new("express", "Expressz")];

    [ObservableProperty]
    public partial List<OrderChoice> Clients { get; set; } = [];

    [ObservableProperty]
    public partial List<OrderChoice> Carriers { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasClient))]
    public partial OrderChoice? Client { get; set; }

    [ObservableProperty] public partial string ExternalNumber { get; set; } = "";
    [ObservableProperty] public partial OrderChoice Priority { get; set; } = Priorities[0];
    [ObservableProperty] public partial string CustomerName { get; set; } = "";
    [ObservableProperty] public partial string Company { get; set; } = "";
    [ObservableProperty] public partial string Email { get; set; } = "";
    [ObservableProperty] public partial string Phone { get; set; } = "";
    [ObservableProperty] public partial string Country { get; set; } = "HU";
    [ObservableProperty] public partial string Zip { get; set; } = "";
    [ObservableProperty] public partial string City { get; set; } = "";
    [ObservableProperty] public partial string Address { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? Carrier { get; set; }
    [ObservableProperty] public partial string CarrierService { get; set; } = "";
    [ObservableProperty] public partial string PickupPointId { get; set; } = "";
    [ObservableProperty] public partial string Cod { get; set; } = "0";
    [ObservableProperty] public partial string Note { get; set; } = "";

    // The server's message per field (customer_name, email, lines ...).
    [ObservableProperty]
    public partial Dictionary<string, string> Errors { get; set; } = [];

    [ObservableProperty]
    public partial string? Error { get; set; }

    public ObservableCollection<OrderFormLine> Lines { get; } = [];

    public bool HasClient => !IsNew || Client?.Id is not null;
    int? PartnerId => Order?.Partner.Id ?? Client?.Id;

    public override async Task LoadAsync()
    {
        if (Carriers.Count > 0) return;
        var carriers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier");
        if (IsNew)
        {
            var clients = await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client");
            Clients = [new(null, "Válassz ügyfelet"), .. clients.Items.Select((p) => new OrderChoice(p.Id.ToString(), $"{p.Name} ({p.Code})"))];
            Client = Clients[0];
        }
        Carriers = [new(null, "Nincs megadva"), .. (await carriers).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
        Carrier = Carriers.FirstOrDefault((c) => c.Id == Order?.Carrier?.Id) ?? Carriers[0];
    }

    // The products belong to the client: another client means choosing them again.
    partial void OnClientChanged(OrderChoice? oldValue, OrderChoice? newValue)
    {
        if (oldValue is null || oldValue.Key == newValue?.Key) return;
        Errors = Errors.Where((e) => e.Key != "partner_id").ToDictionary();
        Error = null;
        foreach (var l in Lines) l.Product = null;
    }

    internal async Task<IEnumerable<object>> FindProductsAsync(string? text, CancellationToken ct)
    {
        if (PartnerId is not { } partner || string.IsNullOrWhiteSpace(text)) return [];
        var list = await Api.GetAsync<ItemList<ProductLookup>>(Query.Build("api/lookup/products", ("partner_id", partner), ("q", text.Trim())), ct);
        return list.Items;
    }

    public string? FieldError(string key) => Errors.GetValueOrDefault(key);

    [RelayCommand]
    void AddLine() => Lines.Add(new OrderFormLine(this));

    internal void RemoveLine(OrderFormLine line)
    {
        if (Lines.Count == 1)
        {
            Shell.Toast("Legalább egy tétel kell.", ToastKind.Error);
            return;
        }
        Lines.Remove(line);
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        Errors = [];
        foreach (var l in Lines) l.Validate();
        if (IsNew && Client?.Id is null)
        {
            Errors = new() { ["partner_id"] = "Válassz ügyfelet." };
            Error = "Válassz ügyfelet.";
            return;
        }
        if (Lines.Any((l) => l.Error is not null))
        {
            Error = "Ellenőrizd a tételeket.";
            return;
        }
        var cod = Cod.Trim().Length == 0 ? 0 : Fmt.ParseNumber(Cod);
        if (cod is not >= 0)
        {
            Errors = new() { ["cod_amount"] = "Nem negatív számot adj meg." };
            Error = "Ellenőrizd az utánvétet.";
            return;
        }
        var body = new Dictionary<string, object?>
        {
            ["external_number"] = ExternalNumber.Trim(), ["priority"] = Priority.Key, ["customer_name"] = CustomerName.Trim(),
            ["company"] = Company.Trim(), ["email"] = Email.Trim(), ["phone"] = Phone.Trim(), ["country"] = Country.Trim(),
            ["zip"] = Zip.Trim(), ["city"] = City.Trim(), ["address"] = Address.Trim(), ["carrier_id"] = Carrier?.Id,
            ["carrier_service"] = CarrierService.Trim(), ["pickup_point_id"] = PickupPointId.Trim(), ["cod_amount"] = cod,
            ["note"] = Note.Trim(),
            ["lines"] = Lines.Select((l) => l.LineId is { } id
                ? new Dictionary<string, object?> { ["id"] = id, ["product_id"] = l.Product!.Id, ["qty"] = l.Quantity }
                : new Dictionary<string, object?> { ["product_id"] = l.Product!.Id, ["qty"] = l.Quantity }).ToList(),
        };
        try
        {
            if (Order is { } o)
            {
                var res = await Api.PatchAsync<OrderSaved>($"api/orders/{o.Id}", body);
                Shell.Toast(res.Changed.Count > 0 ? $"Mentve: {string.Join(", ", res.Changed)}." : "Nem változott semmi.", ToastKind.Success);
                await Shell.BackAsync();
            }
            else
            {
                body["partner_id"] = Client!.Id;
                var res = await Api.PostAsync<OrderCreated>("api/orders", body);
                Shell.Toast($"{res.Number} rögzítve.", ToastKind.Success);
                await Shell.BackAsync();
                await Shell.NavigateAsync(new OrderViewModel(Shell, res.Id));
            }
        }
        catch (ApiException e) when (e.Status == 400)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            for (var i = 0; i < Lines.Count; i++)
            {
                var msg = e.Fields.Where((f) => f.Key.StartsWith($"lines.{i}.", StringComparison.Ordinal)).Select((f) => f.Value).FirstOrDefault();
                if (msg is not null) Lines[i].Error = msg;
            }
            Error = e.Fields.GetValueOrDefault("lines") is { } linesError ? $"{e.Message} {linesError}" : e.Message;
        }
    });
}

// A line of the order form: product search within the client, quantity.
public sealed partial class OrderFormLine(OrderFormViewModel form) : ObservableObject
{
    public int? LineId { get; init; }
    public int PickedQty { get; init; }

    // Picked already: the product stays.
    public bool Locked => PickedQty > 0;
    public bool CanChange => !Locked;
    public string LockedText => Locked ? $"Már {Fmt.Int(PickedQty)} db kiszedve, a termék nem cserélhető." : "";

    [ObservableProperty]
    public partial ProductLookup? Product { get; set; }

    [ObservableProperty]
    public partial string Qty { get; set; } = "1";

    [ObservableProperty]
    public partial string? Error { get; set; }

    public int Quantity => int.TryParse(Qty.Trim(), out var q) ? q : 0;
    public bool HasClient => form.HasClient;

    public Func<string?, CancellationToken, Task<IEnumerable<object>>> FindProducts => form.FindProductsAsync;

    public void Validate() => Error = Product is null ? "Válassz terméket a listából."
        : Quantity < 1 ? "Legalább 1 legyen."
        : Quantity < PickedQty ? $"Már {Fmt.Int(PickedQty)} db ki van szedve, ennél kevesebb nem lehet."
        : null;

    [RelayCommand]
    void Remove() => form.RemoveLine(this);
}

// A step of the order with a reason: hold, release (reason optional), cancel.
public sealed partial class OrderReasonViewModel(
    ShellViewModel shell, string title, string text, string label, string submit, bool danger, bool required, Func<string, Task> action, string done) : PageViewModel(shell)
{
    public override string Title => title;
    public override string? Module => "orders";
    public override PageKind Kind => PageKind.Dialog;
    public string Text { get; } = text;
    public string Label { get; } = required ? label : $"{label} (nem kötelező)";
    public string SubmitText { get; } = submit;
    public bool Danger { get; } = danger;

    // A warning above the field (goods already picked for a cancelled order).
    public string? Warning { get; init; }

    [ObservableProperty]
    public partial string Reason { get; set; } = "";

    [ObservableProperty]
    public partial string? ReasonError { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        ReasonError = required && Reason.Trim().Length == 0 ? "Add meg az okát." : null;
        if (ReasonError is not null) return;
        try
        {
            await action(Reason.Trim());
        }
        catch (ApiException e) when (e.Fields.ContainsKey("reason"))
        {
            ReasonError = e.Fields["reason"];
            return;
        }
        Shell.Toast(done, ToastKind.Success);
        await Shell.BackAsync();
    });
}

// An order offered to a wave.
public sealed record WaveCandidate(int Id, string Number, string Status, string? Availability, int ItemCount);

// POST /api/picking/waves with the selected orders: only new orders with full stock go; the others
// are named. A conflict (stock taken meanwhile) shows the server's reasons per order.
public sealed partial class SendToPickingViewModel : PageViewModel
{
    public SendToPickingViewModel(ShellViewModel shell, IReadOnlyList<WaveCandidate> orders) : base(shell)
    {
        var fresh = orders.Where((o) => o.Status == "new").ToList();
        Ok = fresh.Where((o) => o.Availability == "ok").ToList();
        var shortOnes = fresh.Where((o) => o.Availability != "ok").Select((o) => o.Number).ToList();
        var notNew = orders.Where((o) => o.Status != "new").Select((o) => o.Number).ToList();
        ShortText = shortOnes.Count > 0 ? $"Nincs elég szabad készlet, ezért kimarad: {string.Join(", ", shortOnes)}." : null;
        NotNewText = notNew.Count > 0 ? $"Nem új állapotú, ezért kimarad: {string.Join(", ", notNew)}." : null;
    }

    public IReadOnlyList<WaveCandidate> Ok { get; }
    public bool HasOk => Ok.Count > 0;
    public string? ShortText { get; }
    public string? NotNewText { get; }
    public override string Title => "Komissióba küldés";
    public override string? Module => "orders";
    public override PageKind Kind => PageKind.Dialog;

    public string OkText => HasOk
        ? $"{Fmt.Int(Ok.Count)} rendelés, összesen {Fmt.Int(Ok.Sum((o) => o.ItemCount))} db kerül a hullámba. A kiszedési helyeket a rendszer lejárat szerint (FEFO) jelöli ki."
        : "A kijelölt rendelések közül egyik sem indítható: komissióba csak új, teljes készlettel rendelkező rendelés küldhető.";
    public string SubmitText => $"Hullám indítása ({Fmt.Int(Ok.Count)} rendelés)";

    [ObservableProperty]
    public partial List<OrderChoice> Users { get; set; } = [];

    [ObservableProperty]
    public partial OrderChoice? Picker { get; set; }

    [ObservableProperty]
    public partial string Note { get; set; } = "";

    // The server's refusal, with its reason per order number.
    [ObservableProperty]
    public partial string? Error { get; set; }

    public override async Task LoadAsync()
    {
        if (Users.Count > 0 || !HasOk) return;
        var users = await Api.GetAsync<ItemList<UserLookup>>("api/lookup/users");
        Users = [new(null, "Aki elindítja"), .. users.Items.Select((u) => new OrderChoice(u.Id.ToString(), u.Name))];
        Picker = Users[0];
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        if (!HasOk) return;
        Error = null;
        try
        {
            var res = await Api.PostAsync<WaveCreated>("api/picking/waves",
                new Dictionary<string, object?> { ["order_ids"] = Ok.Select((o) => o.Id).ToArray(), ["picker_id"] = Picker?.Id, ["note"] = Note.Trim() });
            Shell.Toast($"{res.Number} hullám elindítva: {Fmt.Int(res.Orders)} rendelés.{(res.Skipped.Count > 0 ? $" Kimaradt: {string.Join(", ", res.Skipped)}." : "")}", ToastKind.Success);
            await Shell.BackAsync();
            if (Shell.Me?.Can("picking", "view") == true) await Shell.NavigateAsync(new WaveViewModel(Shell, res.Id));
        }
        catch (ApiException e) when (e.Status == 409)
        {
            Error = e.Message + (e.Fields.Count > 0 ? "\n" + string.Join("\n", e.Fields.Select((f) => $"• {f.Key}: {f.Value}")) : "");
        }
    });
}
