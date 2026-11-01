using System.Globalization;
using System.Text;

namespace Fully.Wms.Core;

// "api/inbound" + ("status", "open") + ("q", "ABC") -> "api/inbound?status=open&q=ABC". Empty and
// null values are left out.
public static class Query
{
    public static string Build(string path, params (string Key, object? Value)[] values)
    {
        var sb = new StringBuilder(path);
        var sep = path.Contains('?') ? '&' : '?';
        foreach (var (key, value) in values)
        {
            var text = value switch
            {
                null => null,
                bool b => b ? "1" : "0",
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString(),
            };
            if (string.IsNullOrEmpty(text)) continue;
            sb.Append(sep).Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(text));
            sep = '&';
        }
        return sb.ToString();
    }
}

// A page of a list: the rows, how many there are in all, and per status counts where the list
// has them (the filter chips).
public sealed record Paged<T>(List<T> Items, int Total, Dictionary<string, int>? Counts);
