namespace Fully.Wms.Core.Models;

// GET /api/me: who is signed in, what they may do, the company and the warehouse hours.
public sealed record Me(MeUser User, Dictionary<string, string[]> Permissions, MeCompany Company, MeWarehouse Warehouse)
{
    // The server's matrix: module key -> allowed actions (view, create, edit, delete, approve).
    // An administrator has every action of every module.
    public bool Can(string module, string action = "view") =>
        User.Role.IsAdmin || (Permissions.TryGetValue(module, out var actions) && actions.Contains(action));
}

public sealed record MeUser(int Id, string Email, string Name, string? Phone, MeRole Role, bool MustChangePassword);

public sealed record MeRole(int Id, string Key, string Name, bool IsAdmin);

public sealed record MeCompany(string Name);

// cutoff: the daily order cut-off ("14:00"); open and close may be empty.
public sealed record MeWarehouse(string Cutoff, string? Open, string? Close);

public sealed record LoginResult(bool Ok, bool MustChangePassword);

// GET /api/home: work waiting in each module the user may open (missing = no permission).
public sealed record HomeCounts(Dictionary<string, Dictionary<string, int>> Counts)
{
    public int Get(string module, string key) =>
        Counts.TryGetValue(module, out var c) && c.TryGetValue(key, out var n) ? n : 0;

    public bool Has(string module) => Counts.ContainsKey(module);
}
