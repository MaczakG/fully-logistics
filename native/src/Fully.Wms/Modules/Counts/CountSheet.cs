using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Counts;

// The count sheet (Leltárív) as an HTML page to print, like the web app's: every location with its
// products, a box for the counted quantity, blank rows for goods found, signatures. The sheet goes
// to the counters, so a blind count's sheet never shows the expected quantities.
public static class CountSheet
{
    public static DownloadedFile Build(CountDetail c, Me me)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var withExpected = !c.Blind && c.CanSeeExpected;
        var cols = withExpected ? 7 : 6;
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\"><title>Leltárív ").Append(E(c.Number)).Append("</title><style>")
          .Append("body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#121518;margin:24px}h1{font-size:20px;margin:0 0 4px}")
          .Append("header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #E8BE3C;padding-bottom:8px;margin-bottom:12px}")
          .Append("dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;font-size:12px}dt{font-weight:bold;color:#59616A}dd{margin:0}")
          .Append("table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #BEC3C8;padding:6px;text-align:left;vertical-align:top}")
          .Append("tbody.loc tr:first-child td{border-top:2px solid #121518}.mono{font-family:Consolas,monospace}.r{text-align:right}")
          .Append(".box{width:80px;border:1.5px solid #121518}.blank td{height:26px}.muted{color:#59616A}th.group{background:#EEE;text-align:left}")
          .Append(".sign{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:40px}.sign span{display:block;border-top:1px solid #121518;margin-bottom:4px}")
          .Append("@media print{body{margin:10mm}}</style></head><body>");
        sb.Append("<header><div><div class=\"muted\">").Append(E(me.Company.Name)).Append("</div><h1>Leltárív ").Append(E(c.Number)).Append("</h1>")
          .Append(E($"{c.TypeLabel}: {c.Scope}")).Append("</div><dl>")
          .Append("<dt>Indítva</dt><dd>").Append(E(Fmt.DateTime(c.CreatedAt))).Append("</dd>")
          .Append("<dt>Vak leltár</dt><dd>").Append(c.Blind ? "Igen" : "Nem").Append("</dd>")
          .Append("<dt>Helyek, tételek</dt><dd>").Append(Fmt.Int(c.Progress.Locations)).Append(" hely, ").Append(Fmt.Int(c.Progress.Lines)).Append(" tétel</dd>")
          .Append("</dl></header>");
        sb.Append("<table><thead><tr><th>Hely</th><th>Cikkszám</th><th>Megnevezés</th><th>Lot · lejárat</th>")
          .Append(withExpected ? "<th class=\"r\">Várható</th>" : "").Append("<th class=\"r\">Számolt</th><th>Megjegyzés</th></tr></thead>");
        foreach (var loc in c.Locations ?? [])
        {
            var goods = (loc.Items ?? []).Where((l) => l.HasProduct).ToList();
            sb.Append("<tbody class=\"loc\">");
            if (goods.Count == 0)
            {
                sb.Append("<tr><td class=\"mono\">").Append(E(loc.Code)).Append("</td><td colspan=\"").Append(cols - 3)
                  .Append("\" class=\"muted\">Nyilvántartás szerint üres</td><td class=\"box\"></td><td></td></tr>");
            }
            for (var i = 0; i < goods.Count; i++)
            {
                var l = goods[i];
                sb.Append("<tr><td class=\"mono\"><b>").Append(i == 0 ? E(loc.Code) : "").Append("</b></td><td class=\"mono\">").Append(E(l.Sku))
                  .Append("</td><td>").Append(E(l.Name)).Append("</td><td>").Append(E(l.LotText)).Append("</td>")
                  .Append(withExpected ? $"<td class=\"r mono\">{CountsFormat.Qty(l.ExpectedQty)}</td>" : "")
                  .Append("<td class=\"box\"></td><td></td></tr>");
            }
            sb.Append("</tbody>");
        }
        sb.Append("<tbody><tr><th class=\"group\" colspan=\"").Append(cols).Append("\">Talált, nem nyilvántartott áru</th></tr>");
        for (var i = 0; i < 6; i++) sb.Append("<tr class=\"blank\">").Append(string.Concat(Enumerable.Repeat("<td></td>", cols))).Append("</tr>");
        sb.Append("</tbody></table>");
        sb.Append("<div class=\"sign\"><div><span></span>Számolta</div><div><span></span>Dátum</div><div><span></span>Aláírás</div></div>");
        sb.Append("<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script></body></html>");
        return new DownloadedFile(Encoding.UTF8.GetBytes(sb.ToString()), "text/html", $"leltariv-{c.Number}.html");
    }
}
