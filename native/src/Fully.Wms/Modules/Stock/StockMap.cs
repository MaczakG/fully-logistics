using System.Text.RegularExpressions;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Stock;

// One location on the map.
public sealed partial class MapCell : ObservableObject
{
    readonly StockMapViewModel map;

    public MapCell(StockMapViewModel map, int id, string code, string zone, string size, string kind, bool active, int? dedicatedId, int? occupantId,
        int products, int qty, IReadOnlyDictionary<int, MapPartner> partners)
    {
        this.map = map;
        Id = id;
        Code = code;
        Zone = zone;
        Size = size;
        Kind = kind;
        Active = active;
        DedicatedId = dedicatedId;
        OccupantId = occupantId;
        Products = products;
        Qty = qty;
        Occupant = occupantId is { } o ? partners.GetValueOrDefault(o) : null;
        Dedicated = dedicatedId is { } d ? partners.GetValueOrDefault(d) : null;
    }

    public int Id { get; }
    public string Code { get; }
    public string Zone { get; }
    public string Size { get; }
    public string Kind { get; }
    public bool Active { get; }
    public int? DedicatedId { get; }
    public int? OccupantId { get; }
    public int Products { get; }
    public int Qty { get; }
    public MapPartner? Occupant { get; }
    public MapPartner? Dedicated { get; }

    // Filled by the layout: rack, level and position from the code.
    public string Rack { get; set; } = "";
    public int Level { get; set; }
    public int Pos { get; set; }
    public bool Wide { get; set; }

    // occupied, empty, dedicated (empty but kept for a client), inactive
    public string State => !Active ? "inactive" : OccupantId is not null ? "occupied" : DedicatedId is not null ? "dedicated" : "empty";
    public bool IsOccupied => State == "occupied";
    public bool IsEmpty => State == "empty";
    public bool IsDedicated => State == "dedicated";
    public bool IsInactive => State == "inactive";
    public bool IsQuarantine => Kind == "quarantine";

    public string Number => Wide ? Code : Pos > 0 ? $"{Level}.{Pos}" : Level.ToString();
    public string Who => Occupant?.Code ?? "";

    public string Label => string.Join(", ", new[]
    {
        Code, $"{Size} méret",
        State switch { "occupied" => "foglalt", "empty" => "szabad", "dedicated" => "fix hely, üres", _ => "inaktív" },
        Kind != "storage" ? MetaInfo.Label(App.Meta.LocationKinds, Kind) : null,
        Occupant is { } o ? $"{o.Name} ({o.Code}), {Fmt.Int(Products)} cikk, {Fmt.Int(Qty)} db" : null,
        Dedicated is { } d && d.Id != Occupant?.Id ? $"fix hely: {d.Name}" : null,
    }.Where((x) => x is not null));

    [ObservableProperty]
    public partial bool IsHighlighted { get; set; }

    [ObservableProperty]
    public partial bool IsDimmed { get; set; }

    [RelayCommand]
    Task OpenAsync() => map.OpenAsync(this);
}

public sealed record MapZone(string Name, string Summary, IReadOnlyList<MapRack> Racks, bool Flat);

public sealed record MapRack(string Name, IReadOnlyList<MapLevel> Levels);

public sealed record MapLevel(int Level, IReadOnlyList<MapCell> Cells);

// Zones -> racks -> levels (top first, as you look at the rack) -> positions, from the codes:
// A-01-03, A.01.03.2, A0103. A code that does not split this way goes under "Egyéb helyek".
public static partial class MapLayout
{
    [GeneratedRegex(@"\d+")]
    private static partial Regex Numbers();

    [GeneratedRegex(@"^[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]+")]
    private static partial Regex Letters();

    static readonly StringComparer Natural = StringComparer.Create(Fmt.Hu, System.Globalization.CompareOptions.NumericOrdering);

    public static (string Rack, int Level, int Pos)? Parse(string code, string zone)
    {
        var rest = code;
        if (zone.Length > 0 && rest.StartsWith(zone, StringComparison.OrdinalIgnoreCase)) rest = rest[zone.Length..];
        var nums = Numbers().Matches(rest).Select((m) => m.Value).ToList();
        if (nums.Count == 1 && nums[0].Length is 4 or 6) nums = Enumerable.Range(0, nums[0].Length / 2).Select((i) => nums[0].Substring(i * 2, 2)).ToList();
        if (nums.Count < 2) return null;
        return (nums[0], int.Parse(nums[1]), nums.Count > 2 ? int.Parse(nums[2]) : 0);
    }

    public static IEnumerable<MapZone> Zones(IReadOnlyList<MapCell> cells)
    {
        var zones = new Dictionary<string, Dictionary<string, List<MapCell>>>();
        var other = new List<MapCell>();
        foreach (var c in cells)
        {
            var p = Parse(c.Code, c.Zone);
            if (p is null)
            {
                c.Wide = true;
                other.Add(c);
                continue;
            }
            (c.Rack, c.Level, c.Pos) = p.Value;
            var z = c.Zone.Length > 0 ? c.Zone : Letters().Match(c.Code).Value;
            if (!zones.TryGetValue(z, out var racks)) zones[z] = racks = [];
            if (!racks.TryGetValue(c.Rack, out var list)) racks[c.Rack] = list = [];
            list.Add(c);
        }
        foreach (var (name, racks) in zones.OrderBy((z) => z.Key, Natural))
        {
            var all = racks.Values.SelectMany((x) => x).ToList();
            yield return new MapZone(name.Length > 0 ? $"{name} zóna" : "Zóna nélkül", Summary(all),
                racks.OrderBy((r) => r.Key, Natural).Select((r) => new MapRack(r.Key,
                    r.Value.GroupBy((c) => c.Level).OrderByDescending((g) => g.Key)
                        .Select((g) => new MapLevel(g.Key, g.OrderBy((c) => c.Pos).ToList())).ToList())).ToList(), false);
        }
        if (other.Count > 0)
            yield return new MapZone("Egyéb helyek", "Átvételi, csomagoló, visszáru és a mintától eltérő kódú helyek",
                [new MapRack("", [new MapLevel(0, other.OrderBy((c) => c.Code, Natural).ToList())])], true);
    }

    static string Summary(IReadOnlyList<MapCell> cells)
    {
        var store = cells.Where((c) => c.Active && c.Kind is "storage" or "quarantine").ToList();
        var occ = store.Count((c) => c.OccupantId is not null);
        return $"{Fmt.Int(store.Count)} hely, {Fmt.Int(occ)} foglalt ({(store.Count == 0 ? 0 : occ * 100 / store.Count)}%), {Fmt.Int(store.Count - occ)} szabad";
    }
}
