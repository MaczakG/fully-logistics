using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Picking;

// The pick list (Kiszedési lista) as an HTML page to print, like the web app's printed page: what
// is still to pick, by location in walking order, with a box to tick and the signatures.
public static class PickList
{
    public static DownloadedFile Build(WaveDetail w, Me me)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\"><title>Kiszedési lista ").Append(E(w.Number)).Append("</title><style>")
          .Append("body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#121518;margin:24px}h1{font-size:20px;margin:0 0 4px}")
          .Append("header{border-bottom:3px solid #E8BE3C;padding-bottom:8px;margin-bottom:12px}")
          .Append("table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #BEC3C8;padding:6px;text-align:left;vertical-align:top}")
          .Append("tr.group td{border-top:2px solid #121518}.box{width:18px}.box span{display:inline-block;width:14px;height:14px;border:1.5px solid #121518}")
          .Append(".mono{font-family:Consolas,monospace}.num{text-align:right;font-variant-numeric:tabular-nums;font-size:15px}.small{font-size:11px}")
          .Append(".sign{margin-top:40px}@media print{body{margin:10mm}}</style></head><body>");
        var inWave = w.Orders.Count((o) => o.InWave);
        sb.Append("<header><h1>Kiszedési lista: ").Append(E(w.Number)).Append("</h1>")
          .Append("Nyomtatva: ").Append(E(Fmt.DateTime(DateTimeOffset.UtcNow.ToString("o")))).Append(" · Komissiós: ")
          .Append(E(string.IsNullOrEmpty(w.PickerName) ? "................" : w.PickerName))
          .Append(" · ").Append(Fmt.Int(inWave)).Append(" rendelés · ").Append(Fmt.Int(w.Progress.Remaining)).Append(" db hátra</header>");
        var rows = w.Tasks.Where((t) => t.Remaining > 0 || t.IsOpen).ToList();
        sb.Append("<table><thead><tr><th>Kész</th><th>Hely</th><th>Cikkszám</th><th>Megnevezés</th><th>Tétel, lejárat</th><th class=\"num\">Db</th><th>Rendelések</th></tr></thead><tbody>");
        string? last = null;
        foreach (var t in rows)
        {
            var first = t.Location.Code != last;
            last = t.Location.Code;
            sb.Append(first ? "<tr class=\"group\">" : "<tr>")
              .Append("<td class=\"box\"><span></span></td><td class=\"mono\"><b>").Append(first ? E(t.Location.Code) : "").Append("</b></td>")
              .Append("<td class=\"mono\">").Append(E(t.Product.Sku)).Append("</td><td>").Append(E(t.Product.Name)).Append("</td>")
              .Append("<td>").Append(E(PickingFormat.LotText(t.Lot, t.Expiry))).Append("</td>")
              .Append("<td class=\"num\"><b>").Append(Fmt.Int(t.Remaining)).Append("</b></td>")
              .Append("<td class=\"mono small\">").Append(E(string.Join(", ", t.Orders))).Append("</td></tr>");
        }
        sb.Append("</tbody></table>");
        if (rows.Count == 0) sb.Append("<p>Nincs hátralévő tétel.</p>");
        sb.Append("<p class=\"sign\">Kiszedte: ................................ Ellenőrizte: ................................</p>");
        sb.Append("<p class=\"small\">").Append(E(me.Company.Name)).Append(", ").Append(E(me.User.Name)).Append("</p>");
        sb.Append("<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script></body></html>");
        return new DownloadedFile(Encoding.UTF8.GetBytes(sb.ToString()), "text/html", $"kiszedesi-lista-{w.Number}.html");
    }
}
