using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fully.Wms.Core;

// The server's JSON: snake_case names, SQLite flags as 0/1, dates as "YYYY-MM-DD" and times as ISO
// 8601 strings (kept as strings here; Fmt formats them for the screen).
public static class Json
{
    public static readonly JsonSerializerOptions Options = Create();

    static JsonSerializerOptions Create()
    {
        var o = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DictionaryKeyPolicy = null,
            NumberHandling = JsonNumberHandling.AllowReadingFromString,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        o.Converters.Add(new FlexBoolConverter());
        o.Converters.Add(new FlexStringConverter());
        o.MakeReadOnly(populateMissingResolver: true);
        return o;
    }
}

// true/false, 1/0 or "1"/"0"; null reads as false.
public sealed class FlexBoolConverter : JsonConverter<bool>
{
    public override bool HandleNull => true;

    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.True => true,
        JsonTokenType.False or JsonTokenType.Null => false,
        JsonTokenType.Number => reader.GetDouble() != 0,
        JsonTokenType.String => reader.GetString() is { } s && s is not ("" or "0" or "false"),
        _ => throw new JsonException($"Nem logikai érték: {reader.TokenType}"),
    };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options) => writer.WriteBooleanValue(value);
}

// A string field that the server sometimes fills with a number (codes, EANs, phone numbers).
public sealed class FlexStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.String => reader.GetString(),
        JsonTokenType.Number => System.Text.Encoding.UTF8.GetString(reader.ValueSpan),
        JsonTokenType.True => "true",
        JsonTokenType.False => "false",
        JsonTokenType.Null => null,
        _ => throw new JsonException($"Nem szöveg: {reader.TokenType}"),
    };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) => writer.WriteStringValue(value);
}
