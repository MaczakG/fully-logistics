namespace Fully.Wms.Core.Models;

// Felhasználók (app/worker/routes/users.js): the users with one role each, the roles and their
// permission matrix (module x action). An administrator role has every right and is locked.

// GET /api/users (and one user, a saved or a new one).
public sealed record UserRow(
    int Id, string Email, string Name, string? Phone, int RoleId, string RoleName, string RoleKey, bool IsAdmin, bool Active,
    bool MustChangePassword, bool Locked, string? LastLoginAt, string CreatedAt, int Sessions);

public sealed record UsersPage(List<UserRow> Items, int Total);

// GET /api/users/:id: the user with the open sessions (instead of their count) and the last 20 log lines.
public sealed record UserDetail(
    int Id, string Email, string Name, string? Phone, int RoleId, string RoleName, bool IsAdmin, bool Active, bool MustChangePassword,
    bool Locked, string? LastLoginAt, string CreatedAt, List<UserSession> Sessions, List<UserActivity> Activity);

public sealed record UserSession(string CreatedAt, string? LastSeenAt, string ExpiresAt, string? Ip, string? UserAgent, bool Current);

public sealed record UserActivity(int Id, string At, string Module, string Action, string? Entity, string? EntityId, string Summary);

// A new user, or a new temporary password: shown once.
public sealed record UserCreated(int Id, string Name, string Email, string Password);

public sealed record PasswordIssued(string Password);

public sealed record SessionsEnded(int Count);

// GET /api/roles: every role with its users and permissions (module -> actions).
public sealed record RoleRow(
    int Id, string Key, string Name, string? Description, bool IsAdmin, string? CreatedAt, int UserCount, int ActiveUserCount,
    Dictionary<string, List<string>> Permissions);

public sealed record RoleSaved(
    int Id, string Key, string Name, string? Description, bool IsAdmin, int UserCount, Dictionary<string, List<string>> Permissions,
    List<string>? Added, List<string>? Removed, bool Self);
