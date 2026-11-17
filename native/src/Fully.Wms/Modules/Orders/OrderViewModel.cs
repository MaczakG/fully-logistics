using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Picking;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Orders;

// One order (GET /api/orders/:id), open or closed (Megrendelések and Rendeléstörténet share it):
// where it is in its life, recipient and shipping, lines with free stock, picks, returns, the
// timeline with notes, and the actions of its status: edit, hold, release, cancel, to picking,
// packing, label, delivered, return.
public sealed partial class OrderViewModel(ShellViewModel shell, int id) : PageViewModel(shell)
{
    static readonly string[] Closed = ["shipped", "delivered", "returned", "cancelled"];
    static readonly string[] Returnable = ["shipped", "delivered", "returned"];
    static readonly (string Key, string Label)[] Life = [("new", "Új"), ("picking", "Komissió"), ("packed", "Csomagolva"), ("shipped", "Feladva"), ("delivered", "Kézbesítve")];

    // The return form of Rendeléstörténet (set by that module).
    public static Func<ShellViewModel, OrderDetail, PageViewModel>? ReturnForm { get; set; }

    public int Id { get; } = id;
    public override string Title => Data?.Number ?? "Rendelés";
    public override string? Module => Data is not null && Closed.Contains(Data.Status) ? "history" : "orders";
    public override PageKind Kind => PageKind.Record;
    public override string? RecordKey => $"order:{Id}";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Module), nameof(Status), nameof(Lead), nameof(IsClosed), nameof(CanEdit), nameof(CanHold),
        nameof(CanRelease), nameof(CanCancel), nameof(CanWave), nameof(CanPack), nameof(HasLabel), nameof(CanDeliver), nameof(CanReturn),
        nameof(Primary), nameof(Steps), nameof(ShowSteps), nameof(StateNotice), nameof(StateTone), nameof(AvailOk), nameof(AvailShort),
        nameof(HasCod), nameof(CodText), nameof(ShipRows), nameof(MetaRows), nameof(LinesHead), nameof(Lines), nameof(HasAvailability),
        nameof(HasReturns), nameof(HasPicks), nameof(Picks), nameof(Returns), nameof(CanNote), nameof(HasTracking), nameof(Events))]
    public partial OrderDetail? Data { get; set; }

    [ObservableProperty]
    public partial string NoteText { get; set; } = "";

    [ObservableProperty]
    public partial string? NoteError { get; set; }

    public string? Status => Data?.Status;
    public bool IsClosed => Data is not null && Closed.Contains(Data.Status);
    bool Can(string module, string action) => Shell.Me?.Can(module, action) == true;
    bool NewOrHold => Data?.Status is "new" or "hold";

    public string Lead => Data is null ? "" : string.Join(" · ", new[]
    {
        Data.Partner.Name, OrdersFormat.Source(Data.Source), string.IsNullOrEmpty(Data.ExternalNumber) ? null : Data.ExternalNumber,
    }.Where((x) => x is not null));

    public bool CanEdit => Can("orders", "edit") && NewOrHold;
    public bool CanHold => CanEdit && Data?.Status == "new";
    public bool CanRelease => CanEdit && Data?.Status == "hold";
    public bool CanCancel => Can("orders", "delete") && NewOrHold;
    public bool CanWave => Can("picking", "create") && Data?.Status == "new";
    public bool CanPack => Data?.Status == "picking" && Can("picking", "view");
    public bool HasLabel => Data?.Label is not null;
    public bool CanDeliver => Can("history", "edit") && Data?.Status == "shipped";
    public bool CanReturn => ReturnForm is not null && Can("history", "create") && Data is { } d && Returnable.Contains(d.Status) && d.Lines.Any((l) => l.ReturnedQty < l.Qty);

    // The one main action where the order is in its life.
    public string Primary
    {
        get
        {
            if (Data is not { } o) return "";
            if (o.Status == "new" && CanWave && o.Availability == "ok") return "wave";
            if (o.Status == "hold" && CanEdit) return "release";
            if (o.Status == "picking" && o.Lines.All((l) => l.PickedQty >= l.Qty) && Can("picking", "edit")) return "pack";
            if (o.Status == "packed" && o.Label is not null) return "label";
            return CanReturn ? "return" : "";
        }
    }

    public bool ShowSteps => Data is not null && Data.Status is not ("hold" or "cancelled" or "returned");

    public IReadOnlyList<OrderStep> Steps
    {
        get
        {
            if (Data is null) return [];
            var at = Array.FindIndex(Life, (s) => s.Key == Data.Status);
            return Life.Select((s, i) => new OrderStep(s.Label, i < at, i == at)).ToList();
        }
    }

    public string? StateNotice => Data?.Status switch
    {
        "hold" => "Felfüggesztve. A rendelés fel van függesztve, amíg fel nem oldod.",
        "cancelled" => "Sztornózva. A rendelés sztornózva.",
        "returned" => "Visszáru. A rendelés visszáruként érkezett vissza.",
        _ => null,
    };

    public string StateTone => Data?.Status == "cancelled" ? "danger" : "warn";
    public bool AvailOk => Data?.Availability == "ok";
    public bool AvailShort => Data?.Availability == "short";
    public bool HasCod => Data?.CodAmount > 0;
    public string CodText => Data is null ? "" : $"Utánvét {Fmt.Money(Data.CodAmount)}";
    public bool HasTracking => !string.IsNullOrEmpty(Data?.TrackingUrl);

    public IReadOnlyList<OrderInfo> ShipRows
    {
        get
        {
            if (Data is not { } o) return [];
            var rows = new List<OrderInfo>
            {
                new("Címzett", o.CustomerName + (string.IsNullOrEmpty(o.Company) ? "" : $"\n{o.Company}"), true),
                new("Cím", Address(o) + (o.Country is { Length: > 0 } c && c != "HU" ? $" ({c})" : "")),
            };
            if (!string.IsNullOrEmpty(o.PickupPointId)) rows.Add(new("Átvételi pont", o.PickupPointId));
            if (!string.IsNullOrEmpty(o.Email)) rows.Add(new("E-mail", o.Email));
            if (!string.IsNullOrEmpty(o.Phone)) rows.Add(new("Telefon", o.Phone));
            rows.Add(new("Fuvarozó", o.Carrier is { } cr ? cr.Name + (string.IsNullOrEmpty(o.CarrierService) ? "" : $" · {o.CarrierService}") : "nincs megadva"));
            if (!string.IsNullOrEmpty(o.TrackingNumber)) rows.Add(new("Nyomkövetés", o.TrackingNumber));
            if (o.PackedAt is not null) rows.Add(new("Csomag", $"{Fmt.Int(o.PackageCount)} db{(o.WeightKg is > 0 and { } kg ? $", {OrdersFormat.Kg(kg)}" : "")}"));
            return rows;
        }
    }

    public IReadOnlyList<OrderInfo> MetaRows
    {
        get
        {
            if (Data is not { } o) return [];
            var rows = new List<OrderInfo> { new("Ügyfél", $"{o.Partner.Name} ({o.Partner.Code})") };
            if (o.OrderedAt is { } oa) rows.Add(new("Rendelve", Fmt.DateTime(oa)));
            rows.Add(new("Beérkezett", Fmt.DateTime(o.CreatedAt)));
            rows.Add(new("Utánvét", o.CodAmount > 0 ? Fmt.Money(o.CodAmount) : "nincs"));
            if (o.Wave is { } w) rows.Add(new("Hullám", w.Number));
            if (o.PackedAt is { } pa) rows.Add(new("Becsomagolva", Fmt.DateTime(pa)));
            if (o.Pickup is { } pu) rows.Add(new("Futárátvétel", pu.Number));
            if (o.ShippedAt is { } sa) rows.Add(new("Feladva", Fmt.DateTime(sa)));
            if (o.DeliveredAt is { } da) rows.Add(new("Kézbesítve", Fmt.DateTime(da)));
            if (o.CancelledAt is { } ca) rows.Add(new("Sztornózva", Fmt.DateTime(ca)));
            if (!string.IsNullOrEmpty(o.Note)) rows.Add(new("Megjegyzés", o.Note));
            return rows;
        }
    }

    static string Address(OrderDetail o) =>
        string.Join(" ", new[] { o.Zip, o.City }.Where((x) => !string.IsNullOrEmpty(x))) + (string.IsNullOrEmpty(o.Address) ? "" : $", {o.Address}");

    public string LinesHead => Data is null ? "" : $"{Fmt.Int(Data.LineCount)} sor, {Fmt.Int(Data.ItemCount)} db";
    public bool HasAvailability => Data?.Availability is not null;
    public bool HasReturns => Data is { Returns.Count: > 0 };
    public bool HasPicks => Data is { Picks.Count: > 0 };
    public IReadOnlyList<OrderLineRow> Lines => Data?.Lines.Select((l) => new OrderLineRow(l)).ToList() ?? [];
    public IReadOnlyList<OrderPickRow> Picks => Data?.Picks.Select((p) => new OrderPickRow(p)).ToList() ?? [];
    public IReadOnlyList<OrderReturnRow> Returns => Data?.Returns.Select((r) => new OrderReturnRow(this, r)).ToList() ?? [];
    public IReadOnlyList<OrderEvent> Events => Data?.Events ?? [];

    // Notes: open orders under Megrendelések, closed ones under Rendeléstörténet.
    string? NoteEndpoint => Data is null ? null
        : IsClosed ? (Can("history", "edit") ? $"api/history/{Id}/notes" : null)
        : (Can("orders", "edit") ? $"api/orders/{Id}/notes" : null);

    public bool CanNote => NoteEndpoint is not null;

    public override async Task LoadAsync() => Data = await Api.GetAsync<OrderDetail>($"api/orders/{Id}");

    // ------------------------------------------------------------------ actions

    [RelayCommand]
    Task EditAsync() => Data is null ? Task.CompletedTask : Shell.NavigateAsync(new OrderFormViewModel(Shell, Data));

    [RelayCommand]
    Task HoldAsync() => Data is not { } o ? Task.CompletedTask : Shell.NavigateAsync(new OrderReasonViewModel(Shell,
        $"{o.Number} felfüggesztése", "A felfüggesztett rendelés nem kerül komissióba, amíg fel nem oldod.", "Ok", "Felfüggesztés", danger: false, required: true,
        (reason) => Api.PostAsync($"api/orders/{o.Id}/hold", new { reason }), "Felfüggesztve."));

    [RelayCommand]
    Task ReleaseAsync() => Data is not { } o ? Task.CompletedTask : Shell.NavigateAsync(new OrderReasonViewModel(Shell,
        $"{o.Number} feloldása", "A rendelés újra új állapotba kerül, és komissióba küldhető.", "Megjegyzés", "Feloldás", danger: false, required: false,
        (reason) => Api.PostAsync($"api/orders/{o.Id}/release", new { reason }), "Felfüggesztés feloldva."));

    [RelayCommand]
    Task CancelOrderAsync()
    {
        if (Data is not { } o) return Task.CompletedTask;
        var held = o.Picks.Where((p) => p.PickedQty - p.RestockedQty > 0).ToList();
        var text = "A sztornózott rendelés nem állítható vissza.";
        var warning = held.Count == 0 ? null
            : $"A rendeléshez már kiszedett áru tartozik: {string.Join(", ", held.Select((p) => $"{p.Sku} {p.PickedQty - p.RestockedQty} db ({p.LocationCode})"))}. Visszakönyveljük a kiszedés helyére: tedd vissza a polcra.";
        return Shell.NavigateAsync(new OrderReasonViewModel(Shell, $"{o.Number} sztornózása", text, "Ok", "Sztornózás", danger: true, required: true,
            (reason) => Api.PostAsync($"api/orders/{o.Id}/cancel", new { reason }), "Rendelés sztornózva.") { Warning = warning });
    }

    [RelayCommand]
    Task WaveAsync() => Data is not { } o ? Task.CompletedTask
        : Shell.NavigateAsync(new SendToPickingViewModel(Shell, [new WaveCandidate(o.Id, o.Number, o.Status, o.Availability, o.ItemCount)]));

    [RelayCommand]
    Task PackAsync() => PackingViewModel.OpenAsync(Shell, null, Id);

    [RelayCommand]
    Task WaveOpenAsync() => Data?.Wave is { } w && Can("picking", "view") ? Shell.NavigateAsync(new WaveViewModel(Shell, w.Id)) : Task.CompletedTask;

    [RelayCommand]
    Task LabelAsync() => Data?.Label is { } l ? RunAsync(() => OpenDocumentAsync(l.Id)) : Task.CompletedTask;

    internal async Task OpenDocumentAsync(int documentId) =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync($"api/documents/{documentId}"));

    internal Task OpenPhotoAsync(int documentId) => RunAsync(() => OpenDocumentAsync(documentId));

    [RelayCommand]
    Task DeliveredAsync() => RunAsync(async () =>
    {
        if (Data is not { } o) return;
        if (!await Shell.ConfirmAsync("Kézbesítve", $"Megjelölöd a(z) {o.Number} rendelést kézbesítettként?", "Kézbesítve")) return;
        await Api.PostAsync($"api/history/{o.Id}/delivered");
        Shell.Toast("Kézbesítettnek jelölve.", ToastKind.Success);
        await LoadAsync();
    });

    [RelayCommand]
    Task ReturnAsync() => Data is { } o && ReturnForm is { } form ? Shell.NavigateAsync(form(Shell, o)) : Task.CompletedTask;

    [RelayCommand]
    Task AddNoteAsync() => RunAsync(async () =>
    {
        if (NoteEndpoint is not { } path) return;
        NoteError = NoteText.Trim().Length == 0 ? "Írd be a megjegyzést." : null;
        if (NoteError is not null) return;
        try
        {
            await Api.PostAsync(path, new { text = NoteText.Trim() });
        }
        catch (ApiException e) when (e.Fields.ContainsKey("text"))
        {
            NoteError = e.Fields["text"];
            return;
        }
        NoteText = "";
        Shell.Toast("Megjegyzés hozzáadva.", ToastKind.Success);
        await LoadAsync();
    });
}

public sealed record OrderStep(string Label, bool Done, bool Current);

public sealed record OrderInfo(string Label, string Value, bool Strong = false);

public sealed class OrderLineRow(OrderLine line)
{
    public OrderLine Line { get; } = line;
    public string Ean => string.IsNullOrEmpty(Line.Ean) ? "" : $"EAN {Line.Ean}";
    public string QtyText => OrdersFormat.Qty(Line.Qty, Line.UnitText);
    public string PickedText => OrdersFormat.Qty(Line.PickedQty, Line.UnitText);
    public bool AllPicked => Line.PickedQty >= Line.Qty;
    public string FreeText => Line.Free is { } f ? Fmt.Int(f) : "";
    public bool Available => Line.Available == true;
    public bool Unavailable => Line.Available == false;
    public string ReturnedText => Line.ReturnedQty > 0 ? OrdersFormat.Qty(Line.ReturnedQty, Line.UnitText) : "";

    public string CardLine => string.Join(" · ", new[]
    {
        $"rendelt {QtyText}", $"kiszedve {PickedText}",
        Line.Free is { } f ? $"szabad {Fmt.Int(f)}" : null,
        Line.ReturnedQty > 0 ? $"visszajött {ReturnedText}" : null,
    }.Where((x) => x is not null));
}

public sealed class OrderPickRow(OrderPick pick)
{
    public OrderPick Pick { get; } = pick;
    public string WaveStatus => App.Meta.Status("wave", Pick.WaveStatus).Label;
    public string LotText => string.Join(" · ", new[] { Pick.Lot, Pick.Expiry.Length > 0 ? Fmt.Date(Pick.Expiry) : "" }.Where((x) => x.Length > 0));
    public string ShortText => Pick.ShortQty > 0 ? Fmt.Int(Pick.ShortQty) : "";
    public string RestockedText => Pick.RestockedQty > 0 ? Fmt.Int(Pick.RestockedQty) : "";
    public string WhoText => Pick.PickedAt is { } at ? $"{Pick.PickedByName}\n{Fmt.DateTime(at)}" : "";

    public string CardLine => string.Join(" · ", new[]
    {
        Pick.WaveNumber, Pick.LocationCode, $"terv {Fmt.Int(Pick.Qty)}", $"kiszedve {Fmt.Int(Pick.PickedQty)}",
        Pick.ShortQty > 0 ? $"hiány {Fmt.Int(Pick.ShortQty)}" : null,
    }.Where((x) => x is not null));
}

public sealed partial class OrderReturnRow(OrderViewModel page, OrderReturn r)
{
    public OrderReturn Return { get; } = r;
    public string Meta => $"{Fmt.DateTime(Return.ReceivedAt)}{(string.IsNullOrEmpty(Return.CreatedByName) ? "" : $", {Return.CreatedByName}")}";
    public string Text => string.Join(": ", new[] { Return.Reason, Return.Note }.Where((x) => !string.IsNullOrEmpty(x)));
    public bool HasText => Text.Length > 0;
    public IReadOnlyList<OrderReturnLineRow> Lines { get; } = (r.Lines ?? []).Select((l) => new OrderReturnLineRow(l)).ToList();
    public IReadOnlyList<OrderReturnPhotoItem> Photos { get; } = (r.Photos ?? []).Select((p) => new OrderReturnPhotoItem(page, p)).ToList();
    public bool HasPhotos => Photos.Count > 0;
}

public sealed class OrderReturnLineRow(OrderReturnLine line)
{
    public OrderReturnLine Line { get; } = line;
    public string QtyText => $"{Fmt.Int(Line.Qty)} db";
    public bool Damaged => Line.Condition == "damaged";
    public string ConditionText => Damaged ? "Sérült" : "Értékesíthető";
    public string Extra => string.Join(", ", new[]
    {
        Line.Lot.Length > 0 ? $"tétel {Line.Lot}" : null,
        Line.Expiry.Length > 0 ? $"lejárat {Fmt.Date(Line.Expiry)}" : null,
        string.IsNullOrEmpty(Line.LocationCode) ? null : $"→ {Line.LocationCode}",
    }.Where((x) => x is not null));
}

public sealed partial class OrderReturnPhotoItem(OrderViewModel page, OrderReturnPhoto photo)
{
    public OrderReturnPhoto Photo { get; } = photo;

    [RelayCommand]
    Task OpenAsync() => page.OpenPhotoAsync(Photo.Id);
}
