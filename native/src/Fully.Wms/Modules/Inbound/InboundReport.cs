using System.Net;
using System.Text;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Inbound;

// The receiving report (Átvételi jegyzőkönyv) as an HTML page to print or save, with the same
// content as the web app's printed page: header data, lines with differences, signatures.
public static class InboundReport
{
    public static DownloadedFile Build(InboundDetail d, Me me)
    {
        static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"hu\"><head><meta charset=\"utf-8\"><title>Átvételi jegyzőkönyv ").Append(E(d.Number)).Append("</title><style>")
          .Append("body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#121518;margin:24px}h1{font-size:20px;margin:0}")
          .Append("header{display:flex;justify-content:space-between;border-bottom:3px solid #E8BE3C;padding-bottom:8px;margin-bottom:12px}")
          .Append("dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{font-weight:bold;color:#59616A}")
          .Append("table{width:100%;border-collapse:collapse;margin:14px 0}th,td{border-bottom:1px solid #BEC3C8;padding:5px 6px;text-align:left}")
          .Append(".r{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:bold}")
          .Append(".sign{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:48px}.sign span{display:block;border-top:1px solid #121518;margin-bottom:4px}")
          .Append("@media print{body{margin:10mm}}</style></head><body>");
        sb.Append("<header><div><b>").Append(E(me.Company.Name)).Append("</b><br>Raktár, áruátvétel</div><div style=\"text-align:right\"><h1>Átvételi jegyzőkönyv</h1>")
          .Append(E(d.Number)).Append("</div></header>");
        sb.Append("<dl>")
          .Append("<dt>Ügyfél</dt><dd>").Append(E($"{d.PartnerName} ({d.PartnerCode})")).Append("</dd>")
          .Append("<dt>Beszállító</dt><dd>").Append(E(d.SupplierName)).Append("</dd>")
          .Append("<dt>Külső hivatkozás</dt><dd>").Append(E(d.ExternalRef)).Append("</dd>")
          .Append("<dt>Várható érkezés</dt><dd>").Append(E(Fmt.Date(d.ExpectedDate))).Append("</dd>")
          .Append("<dt>Megérkezett</dt><dd>").Append(E(Fmt.DateTime(d.ArrivedAt))).Append("</dd>")
          .Append("<dt>Lezárva</dt><dd>").Append(E(d.CompletedAt is null ? App.Meta.Status("inbound", d.Status).Label : Fmt.DateTime(d.CompletedAt))).Append("</dd>")
          .Append("<dt>Raklap, karton</dt><dd>").Append(E($"{Fmt.Int(d.Pallets)} raklap, {Fmt.Int(d.Cartons)} karton")).Append("</dd>")
          .Append("</dl>");
        sb.Append("<table><thead><tr><th>Cikkszám</th><th>Megnevezés</th><th>Sarzs</th><th>Lejárat</th><th class=\"r\">Várt</th><th class=\"r\">Átvett</th><th class=\"r\">Sérült</th><th class=\"r\">Eltérés</th><th>Polcra</th></tr></thead><tbody>");
        foreach (var l in d.Lines)
        {
            var diff = l.ReceivedQty - l.ExpectedQty;
            sb.Append("<tr><td>").Append(E(l.Sku)).Append("</td><td>").Append(E(l.Name)).Append("</td><td>").Append(E(l.Lot)).Append("</td><td>").Append(E(Fmt.Date(l.Expiry)))
              .Append("</td><td class=\"r\">").Append(Fmt.Int(l.ExpectedQty)).Append("</td><td class=\"r\">").Append(Fmt.Int(l.ReceivedQty))
              .Append("</td><td class=\"r\">").Append(Fmt.Int(l.DamagedQty)).Append("</td><td class=\"r\">").Append(diff > 0 ? "+" : "").Append(Fmt.Int(diff))
              .Append("</td><td>").Append(E(string.Join(", ", (l.Putaways ?? []).Select((p) => $"{p.LocationCode}: {p.Qty}")))).Append("</td></tr>");
        }
        var t = d.Totals;
        sb.Append("</tbody><tfoot><tr><td colspan=\"4\">Összesen</td><td class=\"r\">").Append(Fmt.Int(t.Expected)).Append("</td><td class=\"r\">").Append(Fmt.Int(t.Received))
          .Append("</td><td class=\"r\">").Append(Fmt.Int(t.Damaged)).Append("</td><td class=\"r\">").Append(Fmt.Int(t.Received - t.Expected))
          .Append("</td><td>").Append(Fmt.Int(t.Putaway)).Append(" polcon</td></tr></tfoot></table>");
        if (!string.IsNullOrEmpty(d.ArrivalNote)) sb.Append("<p><b>Érkezési megjegyzés:</b> ").Append(E(d.ArrivalNote)).Append("</p>");
        if (d.HasDiscrepancy) sb.Append("<p><b>Eltérés oka:</b> ").Append(E(d.DiscrepancyNote)).Append("</p>");
        sb.Append("<div class=\"sign\"><div><span></span>Átadó (sofőr, beszállító)</div><div><span></span>Átvevő (").Append(E(me.Company.Name))
          .Append(")</div><div><span></span>Dátum</div></div>");
        sb.Append("<p style=\"font-size:11px\">Nyomtatva: ").Append(E(Fmt.DateTime(DateTimeOffset.UtcNow.ToString("o")))).Append(", ").Append(E(me.User.Name)).Append("</p>");
        sb.Append("<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script></body></html>");
        return new DownloadedFile(Encoding.UTF8.GetBytes(sb.ToString()), "text/html", $"atveteli-jegyzokonyv-{d.Number}.html");
    }
}
