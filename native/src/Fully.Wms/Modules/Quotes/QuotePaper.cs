using System.Globalization;
using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Quotes;

public static class QuoteFormat
{
    public static string F0(decimal v) => Fmt.Num(v, 0);
    public static string F1(decimal v) => Fmt.Num(v, 1);
    public static string F2(decimal v) => Fmt.Num(v, 2);
    // Whole forints, as the web app rounds them.
    public static string Ft(decimal v) => $"{Fmt.Num(Math.Round(v, MidpointRounding.AwayFromZero), 0)} Ft";
    // Unit prices with fillér.
    public static string Ftu(decimal v) => $"{Fmt.Num(v, 2)} Ft";
    public static string Money(decimal v) => v < 0 ? $"−{Ft(-v)}" : Ft(v);

    public static string Today => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Fmt.Budapest).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static DateTime? Date(string? iso) =>
        DateTime.TryParseExact(iso, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

    public static string DateLong(string? iso) => Date(iso) is { } d ? d.ToString("yyyy. MMMM d.", Fmt.Hu) : "";

    public static string AddDays(string iso, int days) => (Date(iso) ?? DateTime.Today).AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static string Dims(QuoteSize s) => s is { WidthCm: { } w, DepthCm: { } d, HeightCm: { } h } ? $"{F1(w)} × {F1(d)} × {F1(h)} cm" : "";

    // The company as printed: address, tax and company numbers, contacts, web.
    public static List<string> CompanyLines(CompanySettings c, string contactSeparator) =>
        new[]
        {
            string.Join(", ", new[] { string.Join(" ", new[] { c.Zip, c.City }.Where((x) => !string.IsNullOrEmpty(x))), c.Address }.Where((x) => !string.IsNullOrEmpty(x))),
            string.IsNullOrEmpty(c.TaxNumber) ? "" : $"Adószám: {c.TaxNumber}",
            string.IsNullOrEmpty(c.CompanyRegNumber) ? "" : $"Cégjegyzékszám: {c.CompanyRegNumber}",
            string.Join(contactSeparator, new[] { c.Email, c.Phone }.Where((x) => !string.IsNullOrEmpty(x))),
            StripScheme(c.Website),
        }.Where((x) => x.Length > 0).ToList();

    public static string StripScheme(string? url) => (url ?? "").Replace("https://", "").Replace("http://", "");
}

public sealed record PaperLine(bool IsGroup, bool IsDiscount, string Name, string Note, string QtyText, string PriceText, string SumText)
{
    public bool HasNote => Note.Length > 0;
    public bool IsItem => !IsGroup;
}

public sealed record PaperValue(string Name, string Value);

public sealed record PaperPair(string A, string AValue, string B, string BValue);

// The printed quote, ready to show: what the web app draws on its A4 "paper" (never the internal costing).
public sealed record PaperModel(
    string CompanyName, IReadOnlyList<string> CompanyLines, string Number, string DateText, string ValidText, string Sub,
    string ClientName, bool NoClient, IReadOnlyList<string> ClientLines, IReadOnlyList<string> Basis, IReadOnlyList<PaperLine> Lines,
    string NetText, string VatLabel, string VatText, string GrossText, string PerOrderText, string YearlyText, string OneOffTotalText,
    IReadOnlyList<PaperValue> OneOff, IReadOnlyList<PaperPair> UnitPrices, IReadOnlyList<string> Terms, string SignLeft, string SignRight)
{
    public bool HasOneOff => OneOff.Count > 0;
    public bool HasTerms => Terms.Count > 0;

    public static PaperModel Build(QuoteData d, QuoteResult r, CompanySettings c, string? number)
    {
        static decimal N(decimal v) => v > 0 ? v : 0;
        static decimal Pct(decimal v) => Math.Min(N(v), 100);
        var f1 = QuoteFormat.F1;
        var f0 = QuoteFormat.F0;
        var ftu = QuoteFormat.Ftu;
        var date = QuoteFormat.Date(d.OfferDate) is not null ? d.OfferDate! : QuoteFormat.Today;
        var valid = (int)Math.Round(Math.Min(N(d.ValidDays), 365), MidpointRounding.AwayFromZero);
        var validTo = QuoteFormat.AddDays(date, valid > 0 ? valid : 30);
        var terms = d.Terms.Select((x) => x.Trim()).Where((x) => x.Length > 0).ToList();
        var lockMonths = Math.Round(Math.Min(N(d.Discounts.PriceLockMonths), 120), MidpointRounding.AwayFromZero);
        if (lockMonths > 0) terms.Insert(0, $"Az ajánlott díjakat a szerződéskötéstől számított {f0(lockMonths)} hónapig nem emeljük.");
        var cl = d.Client;
        var v = d.Volume;
        var stored = d.Storage.Where((s) => N(s.Qty) > 0).ToList();
        var basis = new[]
        {
            $"{f0(r.Orders)} rendelés, átl. {f1(r.Avg > 0 ? r.Avg : 1)} termék / rendelés",
            stored.Count > 0 ? string.Join(", ", stored.Select((s) => $"{f0(N(s.Qty))} db {(s.Name.Length > 0 ? s.Name : s.Code)}")) : "tárolóhely nélkül",
            $"{f0(N(v.Inbound))} db betárolás, {f1(Pct(v.RetPct))}% visszáru",
            N(v.Hours) > 0 ? $"{f1(N(v.Hours))} óra kézi munka" : "",
            N(v.CodOrders) > 0 ? $"{f0(N(v.CodOrders))} utánvétes rendelés" : "",
        }.Where((x) => x.Length > 0).ToList();
        decimal T(string k) => k.EndsWith("_pct", StringComparison.Ordinal) ? Pct(d.Tariff(k)) : N(d.Tariff(k));
        var unit = new List<(string, string)>
        {
            ("Alap rendeléskezelés", $"{ftu(T("order_base"))} / rendelés"), ("2. termék", ftu(T("item_2"))), ("3. termék", ftu(T("item_3"))),
            ("4. és további termék", $"{ftu(T("item_extra"))} / db"), ("Csomagolóanyag", $"{ftu(T("packaging"))} / rendelés"),
            ("Betárolás", $"{ftu(T("inbound_unit"))} / db"), ("Visszáru kezelése", $"{ftu(T("return_unit"))} / csomag"),
        };
        unit.AddRange(d.Storage.Where((s) => N(s.Price) > 0).Select((s) => (s.Name.Length > 0 ? s.Name : s.Code, $"{ftu(N(s.Price))} / hó")));
        if (T("hourly_work") > 0) unit.Add(("Óradíjas munka", $"{ftu(T("hourly_work"))} / óra"));
        if (T("cod_fixed") > 0) unit.Add(("Utánvétkezelés, fix", $"{ftu(T("cod_fixed"))} / rendelés"));
        if (T("cod_pct") > 0) unit.Add(("Utánvétkezelés, arányos", $"az utánvét {f1(T("cod_pct"))}%-a"));
        unit.AddRange(d.CustomItems.Where((x) => x.Name.Trim().Length > 0)
            .Select((x) => (x.Name.Trim(), $"{ftu(N(x.Price))} / {(x.Kind == "monthly" ? "hó" : x.Unit.Length > 0 ? x.Unit : "db")}")));
        var pairs = new List<PaperPair>();
        for (var i = 0; i < unit.Count; i += 2)
            pairs.Add(new(unit[i].Item1, unit[i].Item2, i + 1 < unit.Count ? unit[i + 1].Item1 : "", i + 1 < unit.Count ? unit[i + 1].Item2 : ""));
        var lines = r.Items.Select((i) => i.IsGroup
            ? new PaperLine(true, false, i.Name, "", "", "", "")
            : new PaperLine(false, i.IsDiscount, i.Name, i.Note, i.Qty is { } q ? $"{f1(q)} {i.Unit}" : "", i.Price is { } p ? ftu(p) : "", QuoteFormat.Money(i.Sum))).ToList();
        var company = string.IsNullOrEmpty(c.Name) ? "Fully Logistics" : c.Name;
        return new PaperModel(
            company, QuoteFormat.CompanyLines(c, " · "), string.IsNullOrEmpty(number) ? "mentéskor kap számot" : number,
            QuoteFormat.DateLong(date), $"{QuoteFormat.DateLong(validTo).TrimEnd('.')}-ig",
            $"Raktározás, rendeléskezelés és csomagolás{(cl.Shop.Length > 0 ? $" a(z) {cl.Shop} webshop részére" : "")}.",
            cl.Name.Length > 0 ? cl.Name : "ügyfél neve", cl.Name.Length == 0,
            new[] { cl.Contact, string.Join(" · ", new[] { cl.Email, cl.Phone }.Where((x) => x.Length > 0)), cl.Address }.Where((x) => x.Length > 0).ToList(),
            basis, lines, QuoteFormat.Ft(r.Net), $"ÁFA ({f1(r.VatPct)}%)", QuoteFormat.Ft(r.Vat), QuoteFormat.Ft(r.Gross),
            r.Orders > 0 ? QuoteFormat.Ft(r.PerOrder) : "nincs rendelés", QuoteFormat.Ft(r.Yearly), QuoteFormat.Ft(r.OneOffTotal),
            r.OneOff.Select((x) => new PaperValue(x.Name, QuoteFormat.Money(-x.Value))).ToList(), pairs, terms,
            d.Signer.Length > 0 ? $"{company}\n{d.Signer}" : company, $"{(cl.Name.Length > 0 ? cl.Name : "Ajánlatkérő")}\nelfogadó aláírás, dátum");
    }

    // The same as an HTML page to print or save as PDF from the browser.
    public DownloadedFile Html(string fileName)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\"><title>").Append(E(Number)).Append(" árajánlat</title><style>")
          .Append("body{font:13px/1.5 Arial,Helvetica,sans-serif;color:#121518;margin:0;background:#fff}.qp{max-width:800px;margin:0 auto;padding:0 28px 28px}")
          .Append(".hz{height:8px;margin:0 -28px 20px;background:repeating-linear-gradient(-45deg,#E8BE3C 0 12px,#121518 12px 24px)}")
          .Append("header{display:flex;justify-content:space-between;gap:24px;padding-bottom:14px;border-bottom:2px solid #121518}")
          .Append(".brand{display:flex;gap:12px}.brand svg{width:40px;height:40px;flex:none}.co{font-weight:800;font-size:18px;letter-spacing:.06em;text-transform:uppercase}")
          .Append(".det,.muted{font-size:12px;color:#59616A}dl{margin:0;font-size:12px;text-align:right}dl div{display:flex;gap:10px;justify-content:flex-end}dt{color:#59616A}dd{margin:0;font-weight:600}")
          .Append("h2{margin:20px 0 4px;font-size:26px;font-weight:800}.sub{margin:0 0 16px;color:#59616A}")
          .Append(".parties{display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;margin-bottom:20px}.parties span{display:block}")
          .Append(".lbl,.sec{font:600 10px/1.3 Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;color:#59616A}.sec{margin:20px 0 6px}")
          .Append("table{width:100%;border-collapse:collapse}th{padding:6px 8px 6px 0;text-align:left;border-bottom:2px solid #121518;font:600 10px Consolas,monospace;text-transform:uppercase;color:#59616A}")
          .Append("td{padding:6px 8px 6px 0;border-bottom:1px solid #D3D7DB;vertical-align:top}.r{text-align:right;white-space:nowrap;font-family:Consolas,monospace;font-size:12px}")
          .Append(".note{display:block;font-size:11px;color:#59616A}.grp td{background:#F1F2F4;font:600 10px Consolas,monospace;text-transform:uppercase;padding:5px 8px}.disc td{color:#1D6B3F}")
          .Append(".tot{width:340px;margin:12px 0 0 auto}.tot td{border:0;padding:4px 0}.big td{border-top:2px solid #121518;padding-top:8px;font-size:16px;font-weight:800}")
          .Append(".hl{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}.hl div{padding:12px;background:#F1F2F4;border:1px solid #D3D7DB;border-top:4px solid #121518}")
          .Append(".hl span{display:block;font-size:11px;color:#59616A}.hl b{font-family:Consolas,monospace;font-size:16px}")
          .Append("ul{margin:0;padding-left:18px;list-style:square}.fine{margin-top:14px;font-size:12px;color:#59616A}")
          .Append(".sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:36px;font-size:12px;color:#59616A}.sign div{border-top:1px solid #121518;padding-top:4px;text-align:center}")
          .Append("tr,.tot,.hl,.sign,li{break-inside:avoid}@media print{.qp{max-width:none;padding:0}.hz{margin:0 0 6mm}body{font-size:9.5pt}}")
          .Append("</style></head><body><article class=\"qp\"><div class=\"hz\"></div><header><div class=\"brand\">")
          .Append("<svg viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" fill=\"#E8BE3C\"/><path d=\"M8 7h17v5.5H14v3.5h9v5.5h-9V26H8z\" fill=\"#121518\"/></svg><div><div class=\"co\">")
          .Append(E(CompanyName)).Append("</div><div class=\"det\">").Append(string.Join("<br>", CompanyLines.Select(E))).Append("</div></div></div><dl>")
          .Append("<div><dt>Ajánlatszám</dt><dd>").Append(E(Number)).Append("</dd></div><div><dt>Kelte</dt><dd>").Append(E(DateText))
          .Append("</dd></div><div><dt>Érvényes</dt><dd>").Append(E(ValidText)).Append("</dd></div></dl></header>")
          .Append("<h2>Fulfillment árajánlat</h2><p class=\"sub\">").Append(E(Sub)).Append("</p><div class=\"parties\"><div><div class=\"lbl\">Ajánlatkérő</div><b>")
          .Append(NoClient ? "<i class=\"muted\">ügyfél neve</i>" : E(ClientName)).Append("</b>").Append(string.Concat(ClientLines.Select((l) => $"<span>{E(l)}</span>")))
          .Append("</div><div><div class=\"lbl\">A kalkuláció alapja (havi)</div>").Append(string.Concat(Basis.Select((l) => $"<span>{E(l)}</span>"))).Append("</div></div>")
          .Append("<div class=\"sec\">Havi díjak részletezése</div><table><thead><tr><th>Tétel</th><th class=\"r\">Mennyiség</th><th class=\"r\">Egységár</th><th class=\"r\">Havi összeg</th></tr></thead><tbody>");
        foreach (var l in Lines)
        {
            if (l.IsGroup) sb.Append("<tr class=\"grp\"><td colspan=\"4\">").Append(E(l.Name)).Append("</td></tr>");
            else sb.Append(l.IsDiscount ? "<tr class=\"disc\">" : "<tr>").Append("<td>").Append(E(l.Name))
                .Append(l.HasNote ? $"<span class=\"note\">{E(l.Note)}</span>" : "").Append("</td><td class=\"r\">").Append(E(l.QtyText))
                .Append("</td><td class=\"r\">").Append(E(l.PriceText)).Append("</td><td class=\"r\">").Append(E(l.SumText)).Append("</td></tr>");
        }
        sb.Append("</tbody></table><table class=\"tot\"><tr><td>Nettó havi díj</td><td class=\"r\">").Append(E(NetText)).Append("</td></tr><tr><td>")
          .Append(E(VatLabel)).Append("</td><td class=\"r\">").Append(E(VatText)).Append("</td></tr><tr class=\"big\"><td>Bruttó havi díj</td><td class=\"r\">")
          .Append(E(GrossText)).Append("</td></tr></table><div class=\"hl\"><div><span>Teljes költség / rendelés (nettó)</span><b>").Append(E(PerOrderText))
          .Append("</b></div><div><span>Becsült éves díj (nettó)</span><b>").Append(E(YearlyText)).Append("</b></div><div><span>Egyszeri kedvezmények értéke</span><b>")
          .Append(E(OneOffTotalText)).Append("</b></div></div>");
        if (HasOneOff)
        {
            sb.Append("<div class=\"sec\">Egyszeri kedvezmények induláskor</div><table><tbody>");
            foreach (var x in OneOff) sb.Append("<tr class=\"disc\"><td>").Append(E(x.Name)).Append("</td><td class=\"r\">").Append(E(x.Value)).Append("</td></tr>");
            sb.Append("</tbody></table>");
        }
        sb.Append("<div class=\"sec\">Egységárak</div><table><tbody>");
        foreach (var p in UnitPrices)
            sb.Append("<tr><td>").Append(E(p.A)).Append("</td><td class=\"r\">").Append(E(p.AValue)).Append("</td><td style=\"padding-left:24px\">").Append(E(p.B))
              .Append("</td><td class=\"r\">").Append(E(p.BValue)).Append("</td></tr>");
        sb.Append("</tbody></table>");
        if (HasTerms) sb.Append("<div class=\"sec\">Feltételek</div><ul>").Append(string.Concat(Terms.Select((t) => $"<li>{E(t)}</li>"))).Append("</ul>");
        sb.Append("<p class=\"fine\">A havi díj a megadott forgalom alapján készült becslés, a számlázás a ténylegesen teljesített mennyiségek szerint történik.</p>")
          .Append("<div class=\"sign\"><div>").Append(E(SignLeft).Replace("\n", "<br>")).Append("</div><div>").Append(E(SignRight).Replace("\n", "<br>"))
          .Append("</div></div></article><script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script></body></html>");
        return new DownloadedFile(Encoding.UTF8.GetBytes(sb.ToString()), "text/html", fileName);
    }
}
