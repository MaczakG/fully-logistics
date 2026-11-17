using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Transport;

// The handover manifest (Átadás-átvételi manifeszt) as an HTML page to print, like the web app's
// printed pickup page: the company, the manifest number, the carrier and the day, the totals, the
// orders with tracking numbers, and the signatures of the two sides.
public static class PickupManifest
{
    public static DownloadedFile Build(PickupDetail p)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var win = TransportFormat.Window(p.WindowFrom, p.WindowTo);
        var t = p.Totals;
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\"><title>Manifeszt ").Append(E(p.ManifestNumber ?? p.Number)).Append("</title><style>")
          .Append("body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#121518;margin:24px}h1{font-size:20px;margin:4px 0}")
          .Append("header{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #E8BE3C;padding-bottom:8px;margin-bottom:12px}")
          .Append("dl{display:grid;grid-template-columns:auto auto;gap:2px 12px;margin:0}dt{color:#5B6168}dd{margin:0;font-weight:bold}")
          .Append(".kpis{display:flex;gap:28px;margin:10px 0 14px}.kpis b{display:block;font-size:18px}")
          .Append("table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #BEC3C8;padding:5px 6px;text-align:left;vertical-align:top}")
          .Append("tfoot td{border-top:2px solid #121518;font-weight:bold}.num{text-align:right;font-variant-numeric:tabular-nums}")
          .Append(".mono{font-family:Consolas,monospace}.small{font-size:11px;color:#5B6168}")
          .Append(".sign{display:grid;grid-template-columns:1fr 1fr 1fr;gap:28px;margin-top:44px}.sign p{margin:16px 0 0;border-bottom:1px solid #121518;padding-bottom:2px}")
          .Append("@media print{body{margin:10mm}}</style></head><body>");
        sb.Append("<header><div><p class=\"small\">").Append(E(p.Company.Name)).Append(" · ")
          .Append(E(string.Join(" ", new[] { p.Company.Zip, p.Company.City, p.Company.Address }.Where((s) => !string.IsNullOrEmpty(s)))))
          .Append("</p><h1>Átadás-átvételi manifeszt</h1></div><dl>")
          .Append("<dt>Manifesztszám</dt><dd class=\"mono\">").Append(E(p.ManifestNumber ?? p.Number)).Append("</dd>")
          .Append("<dt>Fuvarozó</dt><dd>").Append(E(p.CarrierName)).Append("</dd>")
          .Append("<dt>Átvétel napja</dt><dd>").Append(E(Fmt.Date(p.Date))).Append(win.Length > 0 ? $", {E(win)}" : "").Append("</dd></dl></header>");
        sb.Append("<div class=\"kpis\"><div>Rendelés<b>").Append(Fmt.Int(t.Orders)).Append("</b></div><div>Csomag<b>").Append(Fmt.Int(t.Packages))
          .Append("</b></div><div>Súly<b>").Append(E(TransportFormat.Kg(t.WeightKg))).Append("</b></div><div>Utánvét<b>")
          .Append(E(TransportFormat.Cod(t.Cod))).Append("</b></div></div>");
        sb.Append("<table><thead><tr><th class=\"num\">#</th><th>Rendelés</th><th>Ügyfél</th><th>Címzett</th><th>Nyomkövetési szám</th>")
          .Append("<th class=\"num\">Csomag</th><th class=\"num\">Súly</th><th class=\"num\">Utánvét</th></tr></thead><tbody>");
        var i = 0;
        foreach (var o in p.Orders)
        {
            var place = string.IsNullOrEmpty(o.PickupPointId) ? $"{o.Zip} {o.City}" : $"Átvételi pont: {o.PickupPointId}";
            sb.Append("<tr><td class=\"num\">").Append(++i).Append("</td><td class=\"mono\">").Append(E(o.Number))
              .Append(string.IsNullOrEmpty(o.ExternalNumber) ? "" : $"<br><span class=\"small\">{E(o.ExternalNumber)}</span>")
              .Append("</td><td>").Append(E(o.PartnerCode)).Append("</td><td>").Append(E(o.CustomerName))
              .Append(string.IsNullOrEmpty(o.Company) ? "" : $", {E(o.Company)}").Append("<br><span class=\"small\">").Append(E(place)).Append("</span></td>")
              .Append("<td class=\"mono\">").Append(string.IsNullOrEmpty(o.TrackingNumber) ? "nincs" : E(o.TrackingNumber)).Append("</td>")
              .Append("<td class=\"num\">").Append(Fmt.Int(o.PackageCount)).Append("</td><td class=\"num\">").Append(E(TransportFormat.Kg(o.WeightKg)))
              .Append("</td><td class=\"num\">").Append(o.CodAmount != 0 ? E(TransportFormat.Cod(new() { [o.Currency ?? "HUF"] = o.CodAmount })) : "").Append("</td></tr>");
        }
        sb.Append("</tbody>");
        if (p.Orders.Count > 0)
        {
            sb.Append("<tfoot><tr><td colspan=\"5\">Összesen</td><td class=\"num\">").Append(Fmt.Int(t.Packages)).Append("</td><td class=\"num\">")
              .Append(E(TransportFormat.Kg(t.WeightKg))).Append("</td><td class=\"num\">").Append(E(TransportFormat.Cod(t.Cod))).Append("</td></tr></tfoot>");
        }
        sb.Append("</table>");
        if (p.Orders.Count == 0) sb.Append("<p>Nincs rendelés a manifeszten.</p>");
        sb.Append("<div class=\"sign\"><div><span class=\"small\">Átadó (").Append(E(p.Company.Name)).Append(")</span><p>Név:</p><p>Aláírás:</p></div>")
          .Append("<div><span class=\"small\">Átvevő (futár, ").Append(E(p.CarrierName)).Append(")</span><p>Név:</p><p>Aláírás:</p></div>")
          .Append("<div><span class=\"small\">Időpont</span><p>&nbsp;</p></div></div>");
        sb.Append("<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script></body></html>");
        return new DownloadedFile(Encoding.UTF8.GetBytes(sb.ToString()), "text/html", $"manifeszt-{p.Number}.html");
    }
}
