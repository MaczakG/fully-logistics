using System.Text.Json.Serialization;

namespace Fully.Wms.Core.Models;

// GET /api/meta: the lookups every screen uses (status labels, partner types, carriers, location
// kinds, movement types, sizes, the permission matrix's modules). Loaded once after sign-in.
// Unlike the other answers its keys are camelCase.
public sealed record MetaInfo(
    Dictionary<string, Dictionary<string, StatusInfo>> Statuses,
    [property: JsonPropertyName("partnerTypes")] Dictionary<string, string> PartnerTypes,
    Dictionary<string, string> Carriers,
    [property: JsonPropertyName("webshopPlatforms")] Dictionary<string, string> WebshopPlatforms,
    [property: JsonPropertyName("movementTypes")] Dictionary<string, string> MovementTypes,
    [property: JsonPropertyName("locationKinds")] Dictionary<string, string> LocationKinds,
    List<TariffInfo> Tariffs,
    List<SizeInfo> Sizes,
    Dictionary<string, string> Actions,
    List<ModuleInfo> Modules)
{
    public static readonly MetaInfo Empty = new([], [], [], [], [], [], [], [], [], []);

    // The label and tone (info, accent, warn, ok, neutral, danger) of a status; the key itself if
    // the server does not know it.
    public StatusInfo Status(string group, string? key) =>
        key is not null && Statuses.TryGetValue(group, out var g) && g.TryGetValue(key, out var s) ? s : new StatusInfo(key ?? "", "neutral");

    public static string Label(Dictionary<string, string> map, string? key) => key is not null && map.TryGetValue(key, out var v) ? v : key ?? "";
}

public sealed record StatusInfo(string Label, string Tone);

public sealed record TariffInfo(string Key, string Label, string Unit, string Group);

public sealed record SizeInfo(int Id, string Code, string Name, decimal? WidthCm, decimal? DepthCm, decimal? HeightCm, decimal? MaxKg);

public sealed record ModuleInfo(string Key, string Name, string Group, Dictionary<string, string> Actions);
