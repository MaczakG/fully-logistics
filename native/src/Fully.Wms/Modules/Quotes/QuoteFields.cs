using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;

namespace Fully.Wms.Modules.Quotes;

// One field of the calculator form, written straight into the quote's data: a number (anything
// that is not a positive number counts as 0, as on the server) or a text.
public sealed partial class QuoteField : ObservableObject
{
    readonly Action<string> write;
    readonly Action changed;
    bool quiet;

    QuoteField(string label, string text, Action<string> write, Action changed, bool number, string? hint, string? tag, bool readOnly)
    {
        Label = label;
        this.write = write;
        this.changed = changed;
        IsNumber = number;
        Hint = hint ?? "";
        Tag = tag ?? "";
        ReadOnly = readOnly;
        quiet = true;
        Text = text;
        quiet = false;
    }

    public string Label { get; }
    public string Hint { get; }
    public string Tag { get; }
    public bool IsNumber { get; }
    public bool ReadOnly { get; }
    public bool HasHint => Hint.Length > 0;
    public bool HasTag => Tag.Length > 0;

    [ObservableProperty]
    public partial string Text { get; set; } = "";

    partial void OnTextChanged(string value)
    {
        if (quiet) return;
        write(value);
        changed();
    }

    public static decimal Parse(string text) => Fmt.ParseNumber(text) is { } n && n > 0 ? n : 0;

    public static string Show(decimal v) => Fmt.Num(v, 4).Replace(" ", "");

    public static QuoteField Num(string label, decimal value, Action<decimal> set, Action changed, bool readOnly, string? hint = null, string? tag = null) =>
        new(label, Show(value), (t) => set(Parse(t)), changed, true, hint, tag, readOnly);

    public static QuoteField Str(string label, string value, Action<string> set, Action changed, bool readOnly, string? hint = null) =>
        new(label, value, set, changed, false, hint, null, readOnly);
}

public sealed record QuoteFieldGroup(string Label, IReadOnlyList<QuoteField> Fields);

// An own item of the quote: name, per unit or monthly, unit, price, monthly quantity.
public sealed partial class CustomItemRow : ObservableObject
{
    public static readonly IReadOnlyList<OrderChoice> Kinds = [new("per_unit", "Mennyiség alapján"), new("monthly", "Havi fix díj")];

    readonly QuoteCustomItem item;
    readonly Action changed;

    public CustomItemRow(QuoteCustomItem item, int index, Action changed, Action<CustomItemRow> remove, bool readOnly)
    {
        this.item = item;
        this.changed = changed;
        Index = index;
        ReadOnly = readOnly;
        Name = QuoteField.Str("Megnevezés", item.Name, (v) => item.Name = v, changed, readOnly);
        Unit = QuoteField.Str("Egység", item.Unit, (v) => item.Unit = v, changed, readOnly);
        Price = QuoteField.Num("Egységár (Ft)", item.Price, (v) => item.Price = v, changed, readOnly);
        Qty = QuoteField.Num("Mennyiség / hó", item.Qty, (v) => item.Qty = v, changed, readOnly);
        Kind = Kinds.FirstOrDefault((k) => k.Key == item.Kind) ?? Kinds[0];
        RemoveCommand = new RelayCommand(() => remove(this));
    }

    public QuoteCustomItem Item => item;
    public int Index { get; }
    public bool ReadOnly { get; }
    public bool CanEdit => !ReadOnly;
    public QuoteField Name { get; }
    public QuoteField Unit { get; }
    public QuoteField Price { get; }
    public QuoteField Qty { get; }
    public RelayCommand RemoveCommand { get; }

    [ObservableProperty]
    public partial OrderChoice Kind { get; set; }

    partial void OnKindChanged(OrderChoice value)
    {
        if (item.Kind == value.Key) return;
        item.Kind = value.Key!;
        changed();
    }
}

// The rack of one size in the quote's own costing: area with aisle, levels, places per level.
public sealed class QuoteRackRow(string code, string name, IReadOnlyList<QuoteField> fields)
{
    public string Code { get; } = code;
    public string Name { get; } = name;
    public IReadOnlyList<QuoteField> Fields { get; } = fields;
}

public sealed record CostKpi(string Label, string Value, string Hint, string Tone)
{
    public bool HasHint => Hint.Length > 0;
}

public sealed record CostRow(string Name, string Tag, IReadOnlyList<string> Notes, string Value, string Warn)
{
    public bool HasTag => Tag.Length > 0;
    public bool HasWarn => Warn.Length > 0;
}

// The internal costing as shown under the form (never printed).
public sealed record CostingModel(
    string Warning, IReadOnlyList<CostKpi> Kpis, IReadOnlyList<CostRow> Work, string WorkTotalText, string WorkTotal, string RentHead,
    IReadOnlyList<CostRow> Sizes, string StorageTotalText, string StorageTotal, IReadOnlyList<CostRow> Summary, string Margin, bool MarginNegative,
    string MoveIn)
{
    public bool HasWarning => Warning.Length > 0;
    public bool HasSizes => Sizes.Count > 0;
    public bool HasMoveIn => MoveIn.Length > 0;

    public static CostingModel Build(QuoteData d, QuoteResult r, QuoteCosting k)
    {
        static decimal N(decimal v) => v > 0 ? v : 0;
        var f0 = QuoteFormat.F0;
        var f1 = QuoteFormat.F1;
        var f2 = QuoteFormat.F2;
        var ft = QuoteFormat.Ft;
        var i = d.Internal;
        var tone = k.Margin >= 0 ? "ok" : "danger";
        var missing = new List<string>();
        if (k.MissingRent) missing.Add("a raktár havi bérleti díja és alapterülete");
        if (k.MissingStaff) missing.Add("egy raktáros havi költsége");
        if (k.MissingRacks.Count > 0) missing.Add($"az állvány adatai ennél a méretnél: {string.Join(", ", k.MissingRacks)}");
        var warning = missing.Count > 0
            ? $"Hiányzik {string.Join(", ", missing)}, ezért ez a költség 0 Ft-tal számít. Add meg lent a Feltételezések alatt, vagy a Beállítások > Raktár fülön."
            : "";
        var kpis = new List<CostKpi>
        {
            new("Raktáros", $"{f2(k.Staff)} fő", $"{f1(k.Hours)} munkaóra / hó", ""),
            new("Foglalt terület", $"{f2(k.Area)} m²", N(i.AreaM2) > 0 ? $"a raktár {f2(k.AreaPct)}%-a" : "nincs megadva alapterület", ""),
            new("Közvetlen költség / hó", ft(k.Cost), "bér, bérleti díj, csomagolóanyag", ""),
            new("Fedezet / hó", ft(k.Margin), $"bevétel {ft(r.Net)}", tone),
            new("Fedezeti arány", $"{f1(k.Pct)}%", "", tone),
            new("Fedezet / rendelés", r.Orders > 0 ? ft(k.PerOrder) : "nincs rendelés", "", r.Orders > 0 ? tone : ""),
            new("Egyszeri kedvezmények megtérülése", r.OneOffTotal > 0 ? k.Margin > 0 ? $"{f1(k.Payback)} hónap" : "nem térül meg" : "nincs", "",
                r.OneOffTotal > 0 && k.Margin <= 0 ? "danger" : ""),
        };
        var work = k.Work.Select((w) => new CostRow(w.Name, "", [w.Key == "hourly" ? $"{f1(w.Qty)} óra" : $"{f1(w.Qty)} {w.Unit} × {f2(w.Minutes)} perc"],
            $"{f1(w.Hours)} óra", "")).ToList();
        var sizes = k.Sizes.Where((s) => s.Qty > 0).Select((s) => new CostRow(s.Name, s.Code,
        [
            s.M2 > 0 ? $"{f2(s.Rack.Area)} m² állvány / ({f0(s.Rack.Levels)} szint × {f0(s.Rack.PerLevel)} hely) = {f2(s.M2)} m² / hely" : "nincs megadva az állvány",
            $"{f0(s.Qty)} hely × {(s.M2 > 0 ? f2(s.M2) : "?")} m² = {f2(s.Area)} m² · bérlet {ft(s.RentPer)} / hely, díj {ft(s.Price)} / hely",
        ], ft(s.Rent), s.Price < s.RentPer ? "A tárolási díj kevesebb, mint a helyre eső bérleti díj." : "")).ToList();
        var summary = new List<CostRow>
        {
            new("Bevétel", "", ["az ajánlat havi nettó összege"], ft(r.Net), ""),
            new("Bérköltség", "", [$"{f2(k.Staff)} fő"], $"−{ft(k.Labour)}", ""),
            new("Raktárbérlet", "", [$"helyfoglalás szerint, {f2(k.Area)} m²"], $"−{ft(k.Rent)}", ""),
            new("Csomagolóanyag", "", [$"{f0(r.Orders)} rendelés × {ft(N(i.CostPack))}"], $"−{ft(k.Pack)}", ""),
        };
        return new CostingModel(warning, kpis, work,
            $"{f2(k.Hours)} óra / {f0(N(i.WorkerHours))} óra = {f2(k.Staff)} fő × {ft(N(i.WorkerCost))}", ft(k.Labour),
            k.RentPerM2 > 0 ? $"{QuoteFormat.Ftu(k.RentPerM2)} / m² / hó" : "", sizes,
            $"Összesen {f2(k.Area)} m²{(N(i.AreaM2) > 0 ? $", a raktár {f2(k.AreaPct)}%-a" : "")}", ft(k.Rent), summary, ft(k.Margin), k.Margin < 0,
            k.MoveInHours > 0
                ? $"Beköltözés egyszer: {f0(N(d.Volume.MoveIn))} db betárolása kb. {f1(k.MoveInHours)} munkaóra ({ft(k.MoveInCost)}), ez nincs benne a havi költségben."
                : "");
    }
}
