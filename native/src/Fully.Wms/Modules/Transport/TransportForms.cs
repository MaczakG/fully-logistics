using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Transport;

static class TransportForm
{
    // "08:30" or empty; a time typed as "8:30" or "830" is read too.
    public static string? Time(string text)
    {
        var s = text.Trim();
        if (s.Length == 0) return "";
        if (s.Length is 3 or 4 && s.All(char.IsDigit)) s = s.PadLeft(4, '0').Insert(2, ":");
        return TimeOnly.TryParseExact(s, ["H:mm", "HH:mm"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var t) ? t.ToString("HH:mm") : null;
    }

    // Checks a time window; the errors go under the two fields.
    public static bool Window(string from, string to, string fromKey, string toKey, Dictionary<string, string> errors, out string f, out string t)
    {
        f = Time(from) ?? "";
        t = Time(to) ?? "";
        if (Time(from) is null) errors[fromKey] = "Óó:pp formában add meg (pl. 08:30).";
        if (Time(to) is null) errors[toKey] = "Óó:pp formában add meg (pl. 16:00).";
        if (errors.Count == 0 && f.Length > 0 && t.Length > 0 && string.CompareOrdinal(f, t) > 0) errors[toKey] = "Az elejénél későbbi időpontot adj meg.";
        return errors.Count == 0;
    }

    // After a change in a record window the list in the main window shows it at once.
    public static void RefreshMain(ShellViewModel shell, PageViewModel from)
    {
        if (shell.Presenter is not null && shell.Current is { } main && main != from) _ = main.ReloadAsync();
    }
}

// Új futárátvétel / módosítás: carrier (new only), day, time window, note.
public sealed partial class PickupFormViewModel(ShellViewModel shell, PickupDetail? pickup, int? carrierId, string date) : PageViewModel(shell)
{
    public PickupDetail? Pickup { get; } = pickup;
    public bool IsNew => Pickup is null;
    public override string Title => Pickup is { } p ? $"{p.Number} módosítása" : "Új futárátvétel";
    public override string? Module => "transport";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 520;

    public string CarrierText => Pickup?.CarrierName ?? "";
    public string SubmitText => IsNew ? "Átvétel felvétele" : "Mentés";

    [ObservableProperty]
    public partial List<PartnerLookup> Carriers { get; set; } = [];

    [ObservableProperty]
    public partial PartnerLookup? Carrier { get; set; }

    [ObservableProperty]
    public partial DateTime? Day { get; set; } = DateTime.ParseExact(pickup?.Date ?? date, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    [ObservableProperty]
    public partial string WindowFrom { get; set; } = pickup?.WindowFrom ?? "";

    [ObservableProperty]
    public partial string WindowTo { get; set; } = pickup?.WindowTo ?? "";

    [ObservableProperty]
    public partial string Note { get; set; } = pickup?.Note ?? "";

    [ObservableProperty]
    public partial Dictionary<string, string> Errors { get; set; } = [];

    [ObservableProperty]
    public partial string? Error { get; set; }

    public DateTime MinDay => DateTime.ParseExact(TransportFormat.Today, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    partial void OnCarrierChanged(PartnerLookup? value) => Clear("carrier_id");
    partial void OnDayChanged(DateTime? value) => Clear("date");
    partial void OnWindowFromChanged(string value) => Clear("window_from");
    partial void OnWindowToChanged(string value) => Clear("window_to");

    void Clear(string key)
    {
        if (!Errors.ContainsKey(key)) return;
        var e = new Dictionary<string, string>(Errors);
        e.Remove(key);
        Errors = e;
    }

    public override async Task LoadAsync()
    {
        if (!IsNew || Carriers.Count > 0) return;
        Carriers = (await Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier")).Items;
        Carrier = Carriers.FirstOrDefault((c) => c.Id == carrierId);
        if (Carriers.Count == 0) Error = "Nincs aktív fuvarozó partner. Vedd fel a Partnerek között.";
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        var errors = new Dictionary<string, string>();
        if (IsNew && Carrier is null) errors["carrier_id"] = "Válassz fuvarozót.";
        if (Day is null) errors["date"] = "Kötelező mező.";
        TransportForm.Window(WindowFrom, WindowTo, "window_from", "window_to", errors, out var from, out var to);
        if (errors.Count > 0)
        {
            Errors = errors;
            Error = "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        var body = new Dictionary<string, object?>
        {
            ["date"] = Day!.Value.ToString("yyyy-MM-dd"), ["window_from"] = from, ["window_to"] = to, ["note"] = Note.Trim(),
        };
        try
        {
            if (Pickup is { } p)
            {
                await Api.PatchAsync<PickupDetail>($"api/transport/pickups/{p.Id}", body);
                Shell.Toast("Futárátvétel mentve.", ToastKind.Success);
                await Shell.BackAsync();
            }
            else
            {
                body["carrier_id"] = Carrier!.Id;
                var res = await Api.PostAsync<PickupCreated>("api/transport/pickups", body);
                Shell.Toast($"{res.Number} felvéve.", ToastKind.Success);
                await Shell.BackAsync();
                await Shell.NavigateAsync(new PickupViewModel(Shell, res.Id));
            }
        }
        catch (ApiException e) when (e.Status == 400)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });
}

// Manifeszt lezárása: what goes to the carrier, the carrier's manifest number (optional). Large
// manifests are shipped in parts: the call is repeated until the server says done.
public sealed partial class PickupCloseViewModel(ShellViewModel shell, PickupDetail pickup) : PageViewModel(shell)
{
    public PickupDetail Pickup { get; } = pickup;
    public override string Title => "Manifeszt lezárása";
    public override string? Module => "transport";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 480;

    public string Text
    {
        get
        {
            var t = Pickup.Totals;
            return $"{Fmt.Int(t.Orders)} rendelés, {Fmt.Int(t.Packages)} csomag{(t.WeightKg > 0 ? $", {TransportFormat.Kg(t.WeightKg)}" : "")}, utánvét {TransportFormat.Cod(t.Cod)} megy át a(z) {Pickup.CarrierName} futárnak.";
        }
    }

    public string? Warning => Pickup.Problems.NoTracking > 0 ? $"{Fmt.Int(Pickup.Problems.NoTracking)} rendelésnek nincs nyomkövetési száma." : null;
    public string Hint => $"Ha üresen hagyod, az átvétel száma lesz: {Pickup.Number}.";

    [ObservableProperty]
    public partial string ManifestNumber { get; set; } = pickup.ManifestNumber is { } m && m != pickup.Number ? m : "";

    [ObservableProperty]
    public partial string? Progress { get; set; }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        var body = new { manifest_number = ManifestNumber.Trim() };
        PickupClosed res;
        do
        {
            res = await Api.PostAsync<PickupClosed>($"api/transport/pickups/{Pickup.Id}/close", body);
            if (!res.Done) Progress = $"Feladás folyamatban, még {Fmt.Int(res.Remaining)} rendelés...";
        } while (!res.Done);
        Shell.Toast($"{Pickup.Number} lezárva: {Fmt.Int(res.Shipped)} rendelés feladva.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// A pallet transport: new (a small window) or one transport in its own window, with its next
// steps (booked, on the road, delivered, one step back) and deleting.
public sealed partial class TransportFormViewModel : PageViewModel
{
    public TransportFormViewModel(ShellViewModel shell, int? id) : base(shell) => Id = id;

    public int? Id { get; }
    public bool IsNew => Id is null;
    public override string Title => Data is { } t ? $"Fuvar {t.Number}" : IsNew ? "Új fuvar" : "Fuvar";
    public override string? Module => "transport";
    public override PageKind Kind => IsNew ? PageKind.Dialog : PageKind.Record;
    public override string? RecordKey => Id is { } id ? $"transport:{id}" : null;
    public override double DialogWidth => 820;

    public static readonly IReadOnlyList<OrderChoice> DirectionChoices = [new("out", "Kimenő (tőlünk)"), new("in", "Beérkező (hozzánk)")];

    static readonly Dictionary<string, string[]> Flow = new()
    {
        ["requested"] = ["booked"], ["booked"] = ["in_transit", "requested"], ["in_transit"] = ["delivered", "booked"],
    };
    static readonly Dictionary<string, string> NextLabel = new()
    {
        ["booked"] = "Lefoglalva", ["in_transit"] = "Úton van", ["delivered"] = "Leszállítva", ["requested"] = "Vissza ajánlatkérésre",
    };

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Status), nameof(CanSave), nameof(ReadOnly), nameof(Steps), nameof(CanDelete), nameof(ShowStatusBar),
        nameof(Footer), nameof(SubmitText))]
    public partial TransportRow? Data { get; set; }

    [ObservableProperty] public partial List<OrderChoice> Clients { get; set; } = [];
    [ObservableProperty] public partial List<OrderChoice> Carriers { get; set; } = [];
    [ObservableProperty] public partial OrderChoice Direction { get; set; } = DirectionChoices[0];
    [ObservableProperty] public partial OrderChoice? Client { get; set; }
    [ObservableProperty] public partial OrderChoice? Carrier { get; set; }
    [ObservableProperty] public partial DateTime? Day { get; set; }
    [ObservableProperty] public partial string TimeFrom { get; set; } = "";
    [ObservableProperty] public partial string TimeTo { get; set; } = "";
    [ObservableProperty] public partial string Pallets { get; set; } = "0";
    [ObservableProperty] public partial string Weight { get; set; } = "";
    [ObservableProperty] public partial string Vehicle { get; set; } = "";
    [ObservableProperty] public partial string Origin { get; set; } = "";
    [ObservableProperty] public partial string Destination { get; set; } = "";
    [ObservableProperty] public partial string CarrierRef { get; set; } = "";
    [ObservableProperty] public partial string Price { get; set; } = "";
    [ObservableProperty] public partial string Note { get; set; } = "";
    [ObservableProperty] public partial Dictionary<string, string> Errors { get; set; } = [];
    [ObservableProperty] public partial string? Error { get; set; }

    // A corrected field loses its error at once.
    partial void OnCarrierChanged(OrderChoice? value) => Clear("carrier_id");
    partial void OnDayChanged(DateTime? value) => Clear("date");
    partial void OnTimeFromChanged(string value) => Clear("time_from");
    partial void OnTimeToChanged(string value) => Clear("time_to");
    partial void OnPalletsChanged(string value) => Clear("pallets");
    partial void OnWeightChanged(string value) => Clear("weight_kg");
    partial void OnPriceChanged(string value) => Clear("price");

    void Clear(string key)
    {
        if (!Errors.ContainsKey(key)) return;
        var e = new Dictionary<string, string>(Errors);
        e.Remove(key);
        Errors = e;
    }

    bool Can(string action) => Shell.Me?.Can("transport", action) == true;
    public string? Status => Data?.Status;
    public bool CanSave => IsNew ? Can("create") : Data is { } t && t.Status != "cancelled" && Can("edit");
    public bool ReadOnly => !CanSave;
    public string SubmitText => IsNew ? "Fuvar felvétele" : "Mentés";
    public bool CanDelete => Data is { Status: not ("cancelled" or "delivered") } && Can("delete");
    public IReadOnlyList<TransportStep> Steps => Data is { } t && Can("edit") && Flow.TryGetValue(t.Status, out var next)
        ? next.Select((s) => new TransportStep(this, s, NextLabel[s], s == "requested" || (t.Status == "in_transit" && s == "booked"))).ToList()
        : [];
    public bool ShowStatusBar => Data is { Status: not "cancelled" } && (Steps.Count > 0 || CanDelete);
    public string? Footer => Data is { } t
        ? $"Felvette: {t.CreatedByName ?? "ismeretlen"}, {Fmt.DateTime(t.CreatedAt)}{(t.UpdatedAt is { } u && u != t.CreatedAt ? $". Utoljára módosítva: {Fmt.DateTime(u)}" : "")}."
        : null;

    public override async Task LoadAsync()
    {
        if (Clients.Count == 0)
        {
            var clients = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=client&all=1");
            var carriers = Api.GetAsync<ItemList<PartnerLookup>>("api/lookup/partners?type=carrier&all=1");
            Clients = [new(null, "Nincs megadva"), .. (await clients).Items.Select((p) => new OrderChoice(p.Id.ToString(), $"{p.Name} ({p.Code})"))];
            Carriers = [new(null, "Még nincs"), .. (await carriers).Items.Select((p) => new OrderChoice(p.Id.ToString(), p.Name))];
        }
        if (Id is { } id) Fill(await Api.GetAsync<TransportRow>($"api/transport/transports/{id}"));
        else if (Day is null)
        {
            Day = DateTime.ParseExact(TransportFormat.Today, "yyyy-MM-dd", CultureInfo.InvariantCulture);
            Client = Clients[0];
            Carrier = Carriers[0];
        }
    }

    void Fill(TransportRow t)
    {
        Data = t;
        Direction = DirectionChoices.FirstOrDefault((d) => d.Key == t.Direction) ?? DirectionChoices[0];
        Client = Clients.FirstOrDefault((c) => c.Key == t.PartnerId?.ToString()) ?? Clients[0];
        Carrier = Carriers.FirstOrDefault((c) => c.Key == t.CarrierId?.ToString()) ?? Carriers[0];
        Day = DateTime.ParseExact(t.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        TimeFrom = t.TimeFrom ?? "";
        TimeTo = t.TimeTo ?? "";
        Pallets = t.Pallets.ToString();
        Weight = t.WeightKg is { } w ? Fmt.Num(w) : "";
        Vehicle = t.Vehicle ?? "";
        Origin = t.Origin ?? "";
        Destination = t.Destination ?? "";
        CarrierRef = t.CarrierRef ?? "";
        Price = t.Price is { } p ? Fmt.Num(p) : "";
        Note = t.Note ?? "";
        Errors = [];
        Error = null;
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        var errors = new Dictionary<string, string>();
        if (Day is null) errors["date"] = "Kötelező mező.";
        TransportForm.Window(TimeFrom, TimeTo, "time_from", "time_to", errors, out var from, out var to);
        var pallets = Pallets.Trim().Length == 0 ? 0 : Fmt.ParseNumber(Pallets);
        if (pallets is not { } pl || pl < 0 || pl != Math.Floor(pl)) errors["pallets"] = "Nem negatív egész számot adj meg.";
        decimal? weight = Weight.Trim().Length == 0 ? null : Fmt.ParseNumber(Weight);
        if (Weight.Trim().Length > 0 && weight is not >= 0) errors["weight_kg"] = "Nem negatív számot adj meg.";
        decimal? price = Price.Trim().Length == 0 ? null : Fmt.ParseNumber(Price);
        if (Price.Trim().Length > 0 && price is not >= 0) errors["price"] = "Nem negatív számot adj meg.";
        if (errors.Count > 0)
        {
            Errors = errors;
            Error = "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        var body = new Dictionary<string, object?>
        {
            ["direction"] = Direction.Key, ["partner_id"] = Client?.Key is { } c ? int.Parse(c) : null,
            ["carrier_id"] = Carrier?.Key is { } ca ? int.Parse(ca) : null, ["date"] = Day!.Value.ToString("yyyy-MM-dd"),
            ["time_from"] = from, ["time_to"] = to, ["origin"] = Origin.Trim(), ["destination"] = Destination.Trim(),
            ["pallets"] = (int)pallets!.Value, ["weight_kg"] = weight, ["vehicle"] = Vehicle.Trim(), ["price"] = price,
            ["carrier_ref"] = CarrierRef.Trim(), ["note"] = Note.Trim(),
        };
        try
        {
            if (Id is { } id)
            {
                var res = await Api.PatchAsync<TransportRow>($"api/transport/transports/{id}", body);
                Fill(res);
                Shell.Toast($"{res.Number} mentve.", ToastKind.Success);
                TransportForm.RefreshMain(Shell, this);
            }
            else
            {
                var res = await Api.PostAsync<TransportRow>("api/transport/transports", body);
                Shell.Toast($"{res.Number} felvéve.", ToastKind.Success);
                await Shell.BackAsync();
            }
        }
        catch (ApiException e) when (e.Status == 400)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });

    internal Task StepAsync(string status) => RunAsync(async () =>
    {
        try
        {
            var res = await Api.PostAsync<TransportRow>($"api/transport/transports/{Id}/status", new { status });
            Fill(res);
            Shell.Toast($"{res.Number}: {Shell.Meta.Status("transport", status).Label}.", ToastKind.Success);
            TransportForm.RefreshMain(Shell, this);
        }
        catch (ApiException e) when (e.Status == 400)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });

    [RelayCommand]
    async Task DeleteAsync()
    {
        if (Data is not { } t) return;
        if (!await Shell.ConfirmAsync("Fuvar törlése", $"Törlöd a(z) {t.Number} fuvart? A fuvar törölt állapotba kerül, a rekord megmarad.", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/transport/transports/{t.Id}");
            Shell.Toast($"{t.Number} törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

public sealed class TransportStep(TransportFormViewModel form, string status, string label, bool back)
{
    public string Status { get; } = status;
    public string Label { get; } = label;
    public bool Back { get; } = back;
    public RelayCommand Command => new(() => _ = form.StepAsync(Status));
}
