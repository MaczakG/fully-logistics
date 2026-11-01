using Fully.Wms.Core.Models;

namespace Fully.Wms.Core;

// The quote calculator: the monthly fees of a quote line by line, and the internal costing (staff,
// rented area, packaging) that is never printed. Mirrors calc() and costing() of the web app
// (app/public/assets/js/views/quotes.js) and quoteTotals() of the server, which keeps the monthly
// net of the list.
public static class QuoteCalc
{
    // Anything that is not a positive number counts as 0 (the server's rule).
    static decimal N(decimal v) => v > 0 ? v : 0;
    static decimal Pct(decimal v) => Math.Min(N(v), 100);

    static string F0(decimal v) => Fmt.Num(v, 0);
    static string F1(decimal v) => Fmt.Num(v, 1);
    static string Ftu(decimal v) => $"{Fmt.Num(v, 2)} Ft";

    static decimal FeeInt(int k, decimal b, decimal i2, decimal i3, decimal ix) => k switch
    {
        <= 1 => b,
        2 => b + i2,
        3 => b + i2 + i3,
        _ => b + i2 + i3 + ix * (k - 3),
    };

    // The fee of an order with a fractional average of items: between the two neighbouring whole numbers.
    public static decimal OrderFee(decimal avg, decimal b, decimal i2, decimal i3, decimal ix)
    {
        var a = Math.Max(1, avg);
        var lo = (int)Math.Floor(a);
        var hi = (int)Math.Ceiling(a);
        var w = a - lo;
        return FeeInt(lo, b, i2, i3, ix) * (1 - w) + FeeInt(hi, b, i2, i3, ix) * w;
    }

    public static QuoteResult Calc(QuoteData d)
    {
        var v = d.Volume;
        decimal T(string k) => k.EndsWith("_pct", StringComparison.Ordinal) ? Pct(d.Tariff(k)) : N(d.Tariff(k));
        var o = N(v.Orders);
        var avg = N(v.Avg);
        var items = new List<QuoteLine>();
        var perOrder = OrderFee(avg, T("order_base"), T("item_2"), T("item_3"), T("item_extra"));
        var base0 = o * T("order_base");
        var extraItems = o * (perOrder - T("order_base"));
        items.Add(QuoteLine.Group("Rendeléskezelés"));
        items.Add(new("Alap rendeléskezelés", "komissiózás, csomagolás, címke, átadás a futárnak", o, "rendelés", T("order_base"), base0));
        if (extraItems > 0.5m)
        {
            items.Add(new("További termékek a rendelésben",
                $"átl. {F1(avg > 0 ? avg : 1)} termék / rendelés: 2. termék {Ftu(T("item_2"))}, 3. termék {Ftu(T("item_3"))}, 4.-től {Ftu(T("item_extra"))} / db",
                o, "rendelés", perOrder - T("order_base"), extraItems));
        }
        var pack = o * T("packaging");
        if (pack > 0) items.Add(new("Csomagolóanyag", "doboz, töltőanyag, szalag", o, "rendelés", T("packaging"), pack));
        var handlingSum = base0 + extraItems;
        var dHp = T("discount_handling_pct");
        var dH = handlingSum * dHp / 100;
        if (dH > 0) items.Add(QuoteLine.Discount($"Kedvezmény a rendeléskezelésből ({F1(dHp)}%)", -dH));

        var storage = d.Storage.Where((s) => N(s.Qty) > 0).ToList();
        var dSp = T("discount_storage_pct");
        decimal storSum = 0;
        if (storage.Count > 0)
        {
            items.Add(QuoteLine.Group("Tárolás"));
            foreach (var s in storage)
            {
                var val = N(s.Qty) * N(s.Price);
                storSum += val;
                items.Add(new(s.Name.Length > 0 ? s.Name : s.Code, s.Dims, N(s.Qty), "hely / hó", N(s.Price), val));
            }
            var dS0 = storSum * dSp / 100;
            if (dS0 > 0) items.Add(QuoteLine.Discount($"Kedvezmény a tárolásból ({F1(dSp)}%)", -dS0));
        }
        var dS = storSum * dSp / 100;

        var inb = N(v.Inbound) * T("inbound_unit");
        var retP = Pct(v.RetPct);
        var retQ = o * retP / 100;
        var ret = retQ * T("return_unit");
        if (inb > 0 || ret > 0) items.Add(QuoteLine.Group("Áruátvétel és visszáru"));
        if (inb > 0) items.Add(new("Betárolás", "áruátvétel, mennyiségi ellenőrzés, polcra helyezés", N(v.Inbound), "db", T("inbound_unit"), inb));
        if (ret > 0) items.Add(new("Visszáru kezelése", $"becslés: a rendelések {F1(retP)}%-a", retQ, "csomag", T("return_unit"), ret));

        var extras = new List<QuoteLine>();
        var hours = N(v.Hours);
        var hourly = hours * T("hourly_work");
        if (hourly > 0) extras.Add(new("Óradíjas munka", "szettképzés, átcímkézés és egyéb kézi munka, becsült óraszám", hours, "óra", T("hourly_work"), hourly));
        var codO = N(v.CodOrders);
        var codAvg = N(v.CodAvg);
        var codP = T("cod_pct");
        var codFixed = codO * T("cod_fixed");
        var codPart = codO * codAvg * codP / 100;
        if (codFixed > 0) extras.Add(new("Utánvétkezelés, fix díj", "utánvétes rendelésenként", codO, "rendelés", T("cod_fixed"), codFixed));
        if (codPart > 0) extras.Add(new("Utánvétkezelés, arányos díj", $"az utánvét {F1(codP)}%-a, átlagosan {Fmt.Money(codAvg)} utánvéttel", codO, "rendelés", codAvg * codP / 100, codPart));
        foreach (var c in d.CustomItems)
        {
            var name = c.Name.Trim();
            var val = N(c.Qty) * N(c.Price);
            if (name.Length > 0 && val > 0)
            {
                var monthly = c.Kind == "monthly";
                extras.Add(new(name, monthly ? "havi fix díj" : "", N(c.Qty), monthly ? "hó" : c.Unit.Length > 0 ? c.Unit : "db", N(c.Price), val));
            }
        }
        if (extras.Count > 0)
        {
            items.Add(QuoteLine.Group("Kiegészítő szolgáltatások"));
            items.AddRange(extras);
        }

        var net = items.Sum((i) => i.Sum);
        var vatP = T("vat_pct");
        var vat = net * vatP / 100;
        var storNetMonthly = storSum - dS;
        var oneOff = new List<QuoteOneOff>();
        var freeQ = Math.Min(N(d.Discounts.FreeMoveIn), N(v.MoveIn));
        if (freeQ > 0) oneOff.Add(new($"Ingyenes betárolás beköltözéskor ({F0(freeQ)} db)", freeQ * T("inbound_unit")));
        var months = Math.Round(Math.Min(N(d.Discounts.FreeStorageMonths), 120), MidpointRounding.AwayFromZero);
        if (months > 0 && storNetMonthly > 0) oneOff.Add(new($"Ingyenes tárolás az első {F0(months)} hónapban", storNetMonthly * months));
        return new QuoteResult(items, net, vat, vatP, net + vat, o > 0 ? net / o : 0, net * 12, oneOff, oneOff.Sum((x) => x.Value), o, avg,
            storNetMonthly, d.Storage.Sum((s) => N(s.Qty)));
    }

    // The internal costing: the work of the volume in hours by the minute norms (plus the hourly
    // work) as a share of a worker's monthly cost; the rent of the floor area the client's
    // locations take; the packaging bought. What the quote brings in less these is the margin.
    public static QuoteCosting Costing(QuoteData d, QuoteResult r)
    {
        var i = d.Internal;
        var v = d.Volume;
        var o = r.Orders;
        var work = new List<QuoteWork>
        {
            new("orders", "Rendelés kiszedése, csomagolása", o, "rendelés", N(i.MinOrder)),
            new("items", "További termékek a rendelésekben", o * Math.Max(r.Avg - 1, 0), "termék", N(i.MinItem)),
            new("inbound", "Betárolás", N(v.Inbound), "db", N(i.MinInbound)),
            new("returns", "Visszáru", o * Pct(v.RetPct) / 100, "csomag", N(i.MinReturn)),
        };
        if (N(v.Hours) > 0) work.Add(new("hourly", "Óradíjas munka", N(v.Hours), "óra", 60));
        var hours = work.Sum((w) => w.Hours);
        var workerHours = N(i.WorkerHours);
        var staff = workerHours > 0 ? hours / workerHours : 0;
        var labour = staff * N(i.WorkerCost);
        var moveInHours = N(v.MoveIn) * N(i.MinInbound) / 60;

        var totalArea = N(i.AreaM2);
        var rentPerM2 = totalArea > 0 ? N(i.Rent) / totalArea : 0;
        var sizes = d.Storage.Select((s) =>
        {
            var rk = i.Racks.GetValueOrDefault(s.Code) ?? new RackSetting(0, 0, 0);
            var rack = new RackSetting(N(rk.Area), N(rk.Levels), N(rk.PerLevel));
            var m2 = rack.Area > 0 && rack.Levels > 0 && rack.PerLevel > 0 ? rack.Area / (rack.Levels * rack.PerLevel) : 0;
            var qty = N(s.Qty);
            return new QuoteSizeCost(s.Code, s.Name.Length > 0 ? s.Name : s.Code, qty, rack, m2, qty * m2, N(s.Price),
                m2 > 0 && totalArea > 0 ? (long)Math.Floor(totalArea / m2) : 0, m2 * rentPerM2, qty * m2 * rentPerM2);
        }).ToList();
        var area = sizes.Sum((s) => s.Area);
        var rent = sizes.Sum((s) => s.Rent);
        var pack = o * N(i.CostPack);
        var cost = labour + rent + pack;
        var m = r.Net - cost;
        return new QuoteCosting(work, hours, staff, labour, moveInHours, workerHours > 0 ? moveInHours / workerHours * N(i.WorkerCost) : 0,
            rentPerM2, sizes, area, totalArea > 0 ? area / totalArea * 100 : 0, rent, pack, cost, m, r.Net > 0 ? m / r.Net * 100 : 0,
            o > 0 ? m / o : 0, m > 0 && r.OneOffTotal > 0 ? r.OneOffTotal / m : 0,
            !(N(i.Rent) > 0 && totalArea > 0), !(N(i.WorkerCost) > 0 && workerHours > 0),
            sizes.Where((s) => s.Qty > 0 && s.M2 == 0).Select((s) => s.Code).ToList());
    }
}

// A line of the monthly fees; a group heading has only its name.
public sealed record QuoteLine(string Name, string Note, decimal? Qty, string Unit, decimal? Price, decimal Sum, bool IsDiscount = false, bool IsGroup = false)
{
    public static QuoteLine Group(string name) => new(name, "", null, "", null, 0, IsGroup: true);
    public static QuoteLine Discount(string name, decimal sum) => new(name, "", null, "", null, sum, IsDiscount: true);
}

public sealed record QuoteOneOff(string Name, decimal Value);

public sealed record QuoteResult(
    IReadOnlyList<QuoteLine> Items, decimal Net, decimal Vat, decimal VatPct, decimal Gross, decimal PerOrder, decimal Yearly,
    IReadOnlyList<QuoteOneOff> OneOff, decimal OneOffTotal, decimal Orders, decimal Avg, decimal StorNetMonthly, decimal Locations);

public sealed record QuoteWork(string Key, string Name, decimal Qty, string Unit, decimal Minutes)
{
    public decimal Hours => Qty * Minutes / 60;
}

public sealed record QuoteSizeCost(
    string Code, string Name, decimal Qty, RackSetting Rack, decimal M2, decimal Area, decimal Price, long Fits, decimal RentPer, decimal Rent);

public sealed record QuoteCosting(
    IReadOnlyList<QuoteWork> Work, decimal Hours, decimal Staff, decimal Labour, decimal MoveInHours, decimal MoveInCost, decimal RentPerM2,
    IReadOnlyList<QuoteSizeCost> Sizes, decimal Area, decimal AreaPct, decimal Rent, decimal Pack, decimal Cost, decimal Margin, decimal Pct,
    decimal PerOrder, decimal Payback, bool MissingRent, bool MissingStaff, IReadOnlyList<string> MissingRacks);
