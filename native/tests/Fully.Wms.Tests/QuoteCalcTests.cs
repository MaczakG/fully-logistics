using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The quote calculation on the owner's example of the original calculator, with the same numbers
// the server's tests (app/test/quotes.test.mjs) expect from calc(), costing() and quoteTotals().
public class QuoteCalcTests
{
    static QuoteData Example() => new()
    {
        Client = new() { Name = "Példa Webshop Kft.", Contact = "Kovács Anna", Email = "anna@peldawebshop.hu", Shop = "peldawebshop.hu" },
        OfferDate = "2026-10-16",
        Volume = new() { Orders = 300, Avg = 1.5m, Inbound = 450, RetPct = 3, MoveIn = 3000 },
        Storage =
        [
            new() { Code = "M", Name = "Polchely M", Qty = 20, Price = 780 }, new() { Code = "L", Name = "Polchely L", Qty = 15, Price = 990 },
            new() { Code = "XL", Name = "Polchely XL", Qty = 5, Price = 1350 }, new() { Code = "PAL", Name = "Raklaphely", Qty = 0, Price = 0 },
        ],
        Tariffs = new()
        {
            ["order_base"] = 600, ["item_2"] = 80, ["item_3"] = 60, ["item_extra"] = 50, ["packaging"] = 150, ["inbound_unit"] = 49,
            ["return_unit"] = 499, ["vat_pct"] = 27, ["discount_handling_pct"] = 10, ["discount_storage_pct"] = 0,
        },
        Discounts = new() { FreeMoveIn = 3000, FreeStorageMonths = 1, PriceLockMonths = 12 },
        Terms = ["Az árak nettó árak."],
        Internal = new()
        {
            Rent = 2400000, AreaM2 = 1200, WorkerCost = 520000, WorkerHours = 150, MinOrder = 3, MinItem = 0.5m, MinInbound = 0.3m, MinReturn = 5, CostPack = 100,
            Racks = new()
            {
                ["M"] = new(1.5m, 5, 2), ["L"] = new(2, 4, 2), ["XL"] = new(1.2m, 3, 1), ["PAL"] = new(7.2m, 3, 2),
            },
        },
    };

    [Fact]
    public void The_original_example()
    {
        var r = QuoteCalc.Calc(Example());
        // 300 x 600 + 300 x 40 (avg 1.5) + 300 x 150 - 10% of handling + 37 200 storage + 450 x 49 + 9 x 499
        Assert.Equal(281541m, Math.Round(r.Net, 2));
        Assert.Equal(357557.07m, Math.Round(r.Gross, 2));
        Assert.Equal(147000m + 37200m, Math.Round(r.OneOffTotal));
        Assert.Equal(938.47m, Math.Round(r.PerOrder, 2));
        Assert.Equal(["Rendeléskezelés", "Tárolás", "Áruátvétel és visszáru"], r.Items.Where((i) => i.IsGroup).Select((i) => i.Name));
        Assert.Contains(r.Items, (i) => i.IsDiscount && i.Name.Contains("10%"));
        Assert.Equal(40, r.Locations);
    }

    [Fact]
    public void Cod_hourly_custom_items_and_limits()
    {
        var d = Example();
        d.Volume.Avg = 2.7m;
        d.Volume.Hours = 12;
        d.Volume.CodOrders = 80;
        d.Volume.CodAvg = 14990;
        d.Tariffs["hourly_work"] = 6500;
        d.Tariffs["cod_fixed"] = 150;
        d.Tariffs["cod_pct"] = 1.2m;
        var before = QuoteCalc.Calc(Example());
        var r = QuoteCalc.Calc(d);
        Assert.Contains(r.Items, (i) => i.Name == "Utánvétkezelés, arányos díj" && Math.Round(i.Sum, 2) == 80 * 14990 * 0.012m);
        Assert.Contains(r.Items, (i) => i.Name == "Óradíjas munka" && i.Sum == 78000);
        Assert.Equal("Kiegészítő szolgáltatások", r.Items.Last((i) => i.IsGroup).Name);
        Assert.True(r.Net > before.Net);

        // Percentages over 100 count as 100; items without a name are left out.
        var e = Example();
        e.Tariffs["discount_handling_pct"] = 250;
        e.CustomItems = [new() { Name = "Dedikált ügyfélszolgálat", Kind = "monthly", Price = 25000, Qty = 1 }, new() { Name = "", Price = 999, Qty = 9 }];
        var x = QuoteCalc.Calc(e);
        var handling = x.Items.Where((i) => !i.IsGroup && !i.IsDiscount).Take(3).Sum((i) => i.Sum) - 300 * 150;
        Assert.Equal(-handling, x.Items.Single((i) => i.IsDiscount).Sum);
        Assert.Contains(x.Items, (i) => i.Name == "Dedikált ügyfélszolgálat" && i.Unit == "hó");
        Assert.DoesNotContain(x.Items, (i) => i.Price == 999);

        var empty = QuoteCalc.Calc(new QuoteData { Volume = new() { Orders = 0 }, Discounts = new() { FreeStorageMonths = 2 } });
        Assert.Equal(0, empty.Net);
        Assert.Equal(0, empty.PerOrder);
        Assert.Empty(empty.OneOff);
    }

    [Fact]
    public void Internal_costing()
    {
        var d = Example();
        var k = QuoteCalc.Costing(d, QuoteCalc.Calc(d));
        // 300 orders x 3 min + 150 further items x 0.5 + 450 pieces x 0.3 + 9 returns x 5 = 1155 min
        Assert.Equal(19.25m, k.Hours);
        Assert.Equal(0.1283m, Math.Round(k.Staff, 4));
        Assert.Equal(66733m, Math.Round(k.Labour));
        // 2 400 000 Ft / 1 200 m² = 2 000 Ft per m²; 20 M x 0.15 + 15 L x 0.25 + 5 XL x 0.4 = 8.75 m²
        Assert.Equal(2000m, k.RentPerM2);
        Assert.Equal(8.75m, k.Area);
        Assert.Equal(17500m, k.Rent);
        var m = k.Sizes.Single((s) => s.Code == "M");
        Assert.Equal(0.15m, m.M2);
        Assert.Equal(8000, m.Fits);
        Assert.Equal(300m, m.RentPer);
        Assert.Equal(2400m, k.Sizes.Single((s) => s.Code == "PAL").RentPer);
        Assert.Equal(30000m, k.Pack);
        Assert.Equal(114233m, Math.Round(k.Cost));
        Assert.Equal(167308m, Math.Round(k.Margin));
        Assert.Equal(59.43m, Math.Round(k.Pct, 2));
        Assert.False(k.MissingRent || k.MissingStaff);
        Assert.Empty(k.MissingRacks);
        Assert.Equal(15m, k.MoveInHours);

        // Nothing set: no cost, and what is missing.
        var empty = Example();
        empty.Internal = new();
        var e = QuoteCalc.Costing(empty, QuoteCalc.Calc(empty));
        Assert.Equal(0, e.Cost);
        Assert.True(e.MissingRent && e.MissingStaff);
        Assert.Equal(["M", "L", "XL"], e.MissingRacks);
    }
}
