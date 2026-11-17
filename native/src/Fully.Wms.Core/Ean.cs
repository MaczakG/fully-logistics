namespace Fully.Wms.Core;

// A warning for a barcode that is not a valid EAN-8, UPC-A, EAN-13 or GTIN-14, or null. Only a
// hint (some clients use their own codes); the same rule as the server's eanWarning.
public static class Ean
{
    public static string? Warning(string? ean)
    {
        var s = (ean ?? "").Trim();
        if (s.Length == 0) return null;
        if (!s.All(char.IsAsciiDigit)) return "Az EAN nem csak számjegyekből áll. Ellenőrizd, hogy valóban vonalkód-e.";
        if (s.Length is not (8 or 12 or 13 or 14)) return $"Az EAN hossza {s.Length} számjegy. Szabványos hossz: 8, 12, 13 vagy 14.";
        var digits = s.Select((c) => c - '0').ToArray();
        var check = digits[^1];
        var sum = 0;
        for (var i = 0; i < digits.Length - 1; i++) sum += digits[digits.Length - 2 - i] * (i % 2 == 0 ? 3 : 1);
        var expected = (10 - sum % 10) % 10;
        return check == expected ? null : $"Az EAN ellenőrző számjegye hibás ({check} helyett {expected} lenne helyes).";
    }
}
