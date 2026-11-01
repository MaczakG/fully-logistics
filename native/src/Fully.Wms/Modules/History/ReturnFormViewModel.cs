using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.History;

// A return (POST /api/history/:id/returns, then the photos): what came back per product and lot,
// in which condition, where it goes. Sellable goods to the returns zone or back onto a shelf (the
// suggested one or any), damaged goods to quarantine. "Másik állapot" splits a product into a
// sellable and a damaged row.
public sealed partial class ReturnFormViewModel(ShellViewModel shell, OrderDetail order) : PageViewModel(shell)
{
    public static readonly IReadOnlyList<string> Reasons =
        ["Nem vette át a címzett", "Elállás (14 napon belül)", "Sérült csomag", "Téves termék", "Hibás termék", "Címzett ismeretlen", "Csere"];

    public OrderDetail Order { get; } = order;
    public override string Title => $"Visszáru: {Order.Number}";
    public override string? Module => "history";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 1000;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoZone), nameof(CanSave))]
    public partial ReturnOptions? Options { get; set; }

    public ObservableCollection<ReturnRowItem> Rows { get; } = [];
    public ObservableCollection<ReturnPhoto> Photos { get; } = [];

    [ObservableProperty]
    public partial string Reason { get; set; } = "";

    [ObservableProperty]
    public partial string Note { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    // Why nothing can be recorded (not returnable, everything back already).
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSave))]
    public partial string? Blocked { get; set; }

    public bool CanSave => Options is not null && Blocked is null;
    public bool NoZone => Options is { } o && (o.ReturnsZones.Count == 0 || o.QuarantineZones.Count == 0);
    public bool HasPhotos => Photos.Count > 0;

    public override async Task LoadAsync()
    {
        if (Options is not null) return;
        var o = await Api.GetAsync<ReturnOptions>($"api/history/{Order.Id}/return-options");
        Options = o;
        if (!o.CanReturn)
        {
            Blocked = "Ehhez a rendeléshez nem rögzíthető visszáru.";
            return;
        }
        var lines = o.Lines.Where((l) => l.Returnable > 0).ToList();
        if (lines.Count == 0)
        {
            Blocked = "A rendelés minden tétele visszajött már.";
            return;
        }
        foreach (var l in lines) Rows.Add(new ReturnRowItem(this, l, o));
    }

    internal void Split(ReturnRowItem row)
    {
        var copy = new ReturnRowItem(this, row.Line, Options!) { Condition = ReturnRowItem.Conditions[1] };
        Rows.Insert(Rows.IndexOf(row) + 1, copy);
    }

    // Everything returnable came back: one row per lot where it shipped from several.
    [RelayCommand]
    void All()
    {
        if (Options is null) return;
        var seen = new HashSet<int>();
        foreach (var row in Rows.ToList())
        {
            var pid = row.Line.ProductId;
            var open = row.Line.Lots.Where((l) => l.Returnable > 0).ToList();
            if (open.Count > 1)
            {
                var at = Rows.IndexOf(row);
                Rows.RemoveAt(at);
                if (!seen.Add(pid)) continue;
                foreach (var lot in open)
                {
                    var r = new ReturnRowItem(this, row.Line, Options) { Qty = lot.Returnable.ToString() };
                    r.Lot = r.Lots.FirstOrDefault((x) => x.Lot == lot);
                    Rows.Insert(at++, r);
                }
            }
            else
            {
                row.Qty = seen.Add(pid) ? row.Line.Returnable.ToString() : "0";
            }
        }
    }

    public void AddPhoto(string fileName, byte[] bytes)
    {
        Photos.Add(new ReturnPhoto(this, fileName, bytes));
        OnPropertyChanged(nameof(HasPhotos));
    }

    internal void RemovePhoto(ReturnPhoto p)
    {
        Photos.Remove(p);
        OnPropertyChanged(nameof(HasPhotos));
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        if (!CanSave) return;
        Error = null;
        foreach (var r in Rows) r.Error = null;
        var payload = new List<Dictionary<string, object?>>();
        var sent = new List<ReturnRowItem>();
        foreach (var r in Rows)
        {
            if (!int.TryParse(r.Qty.Trim().Length == 0 ? "0" : r.Qty.Trim(), out var qty) || qty < 0)
            {
                r.Error = "Nem negatív egész számot adj meg.";
                continue;
            }
            if (qty == 0) continue;
            var item = new Dictionary<string, object?> { ["product_id"] = r.Line.ProductId, ["qty"] = qty, ["condition"] = r.Condition.Key };
            if (r.HasLots && r.Lot is { } lot)
            {
                item["lot"] = lot.Lot.Lot;
                item["expiry"] = lot.Lot.Expiry;
            }
            if (r.IsOther)
            {
                if (r.OtherCode.Trim().Length == 0) r.Error = "Add meg a raktárhely kódját.";
                item["location_code"] = r.OtherCode.Trim();
            }
            else if (r.Location?.Id is { } locId) item["location_id"] = locId;
            payload.Add(item);
            sent.Add(r);
        }
        if (Rows.Any((r) => r.Error is not null))
        {
            Error = "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        if (payload.Count == 0)
        {
            Error = "Legalább egy tételnél adj meg darabszámot.";
            return;
        }
        ReturnCreated res;
        try
        {
            res = await Api.PostAsync<ReturnCreated>($"api/history/{Order.Id}/returns",
                new Dictionary<string, object?> { ["reason"] = Reason.Trim(), ["note"] = Note.Trim(), ["lines"] = payload });
        }
        catch (ApiException e) when (e.Status == 400)
        {
            for (var i = 0; i < sent.Count; i++)
            {
                var msg = e.Fields.Where((f) => f.Key.StartsWith($"lines.{i}.", StringComparison.Ordinal)).Select((f) => f.Value).FirstOrDefault();
                if (msg is not null) sent[i].Error = msg;
            }
            Error = e.Message;
            return;
        }
        var failed = 0;
        foreach (var p in Photos)
        {
            try
            {
                await Api.UploadAsync<JsonElement>($"api/history/returns/{res.Id}/photos", p.Bytes, p.FileName);
            }
            catch (ApiException)
            {
                failed++;
            }
        }
        Shell.Toast($"{res.Number} rögzítve: {Fmt.Int(res.Pieces)} db visszakerült a készletbe."
            + (Photos.Count > 0 ? $" Fotó: {Photos.Count - failed} feltöltve{(failed > 0 ? $", {failed} nem sikerült" : "")}." : ""),
            failed > 0 ? ToastKind.Error : ToastKind.Success);
        await Shell.BackAsync();
    });
}

// A product (and lot) coming back.
public sealed partial class ReturnRowItem : ObservableObject
{
    public static readonly IReadOnlyList<ReturnChoice> Conditions = [new("sellable", "Értékesíthető", null), new("damaged", "Sérült", null)];

    readonly ReturnFormViewModel form;
    readonly ReturnOptions options;

    public ReturnRowItem(ReturnFormViewModel form, ReturnOptionLine line, ReturnOptions options)
    {
        this.form = form;
        this.options = options;
        Line = line;
        Lots = line.Lots.Where((l) => l.Returnable > 0).Select((l) => new ReturnLotChoice(l)).ToList();
        Lot = Lots.FirstOrDefault();
        Condition = Conditions[0];
    }

    public ReturnOptionLine Line { get; }
    public IReadOnlyList<ReturnLotChoice> Lots { get; }

    // A choice only when there is something to choose or to show.
    public bool HasLots => Line.Lots.Count > 1 || Line.Lots.Any((l) => l.Lot.Length > 0 || l.Expiry.Length > 0);

    public string Info => $"Rendelve {Fmt.Int(Line.Qty)} {Line.UnitText}{(Line.Returned > 0 ? $", már visszajött {Fmt.Int(Line.Returned)}" : "")}, visszaküldhető {Fmt.Int(Line.Returnable)}";

    [ObservableProperty]
    public partial string Qty { get; set; } = "0";

    [ObservableProperty]
    public partial ReturnLotChoice? Lot { get; set; }

    [ObservableProperty]
    public partial ReturnChoice Condition { get; set; }

    [ObservableProperty]
    public partial List<ReturnChoice> Locations { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsOther))]
    public partial ReturnChoice? Location { get; set; }

    [ObservableProperty]
    public partial string OtherCode { get; set; } = "";

    [ObservableProperty]
    public partial string? Error { get; set; }

    public bool IsOther => Location?.Key == "other";

    // Sellable: the returns zones, back onto the suggested shelf, or another location; damaged: quarantine.
    partial void OnConditionChanged(ReturnChoice value)
    {
        var list = new List<ReturnChoice>();
        if (value.Key == "damaged")
        {
            list.AddRange(options.QuarantineZones.Select((z) => new ReturnChoice($"id:{z.Id}", $"Karantén: {z.Code}", z.Id)));
        }
        else
        {
            list.AddRange(options.ReturnsZones.Select((z) => new ReturnChoice($"id:{z.Id}", $"Visszáru zóna: {z.Code}", z.Id)));
            if (Line.SuggestedLocation is { } s && options.ReturnsZones.All((z) => z.Id != s.Id))
                list.Add(new ReturnChoice($"id:{s.Id}", $"Vissza a polcra: {s.Code}", s.Id));
            list.Add(new ReturnChoice("other", "Másik raktárhely...", null));
        }
        Locations = list;
        Location = list.FirstOrDefault();
        OtherCode = "";
    }

    public Func<string?, CancellationToken, Task<IEnumerable<object>>> FindLocations => FindLocationsAsync;

    async Task<IEnumerable<object>> FindLocationsAsync(string? text, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        var list = await form.Shell.Services.Api.GetAsync<ItemList<LocationLookup>>(Query.Build("api/lookup/locations", ("q", text.Trim())), ct);
        return list.Items.Select((l) => l.Code);
    }

    [RelayCommand]
    void Split() => form.Split(this);
}

// Key: sellable / damaged, or "id:12" / "other" for a location.
public sealed record ReturnChoice(string Key, string Label, int? Id);

public sealed record ReturnLotChoice(ReturnLot Lot)
{
    public string Label => $"{(Lot.Lot.Length > 0 ? Lot.Lot : "Tétel nélkül")}{(Lot.Expiry.Length > 0 ? $", lejárat {Fmt.Date(Lot.Expiry)}" : "")} (visszaküldhető {Fmt.Int(Lot.Returnable)})";
}

public sealed partial class ReturnPhoto(ReturnFormViewModel form, string fileName, byte[] bytes)
{
    public string FileName { get; } = fileName;
    public byte[] Bytes { get; } = bytes;
    public string SizeText => Bytes.Length < 1024 * 1024 ? $"{Fmt.Int((Bytes.Length + 1023) / 1024)} KB" : $"{Fmt.Num(Bytes.Length / 1024m / 1024m, 1)} MB";

    [RelayCommand]
    void Remove() => form.RemovePhoto(this);
}
