using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Users;

// Felhasználók: the users (GET /api/users) with their row actions, and the roles with the
// permission matrix (GET /api/roles): role x module x action, saved per role. The server enforces
// every rule (an active administrator always remains, the administrator role is locked, only an
// administrator touches an administrator's account); the screen mirrors them.
public sealed partial class UsersViewModel(ShellViewModel shell) : PageViewModel(shell)
{
    public override string Title => "Felhasználók";
    public override string? Module => "users";

    public static readonly IReadOnlyList<OrderChoice> States = [new(null, "Minden állapot"), new("1", "Aktív"), new("0", "Letiltott")];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsUsers), nameof(IsRoles))]
    public partial string Tab { get; set; } = "users";

    public bool IsUsers => Tab == "users";
    public bool IsRoles => Tab == "roles";

    bool Can(string action) => Shell.Me?.Can("users", action) == true;
    public bool CanCreate => Can("create");
    internal bool CanEdit => Can("edit");
    internal bool CanDelete => Can("delete");
    internal bool IAmAdmin => Shell.Me?.User.Role.IsAdmin == true;
    internal int MyId => Shell.Me?.User.Id ?? 0;

    // ------------------------------------------------------------------ users

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoUsers), nameof(TotalText))]
    public partial IReadOnlyList<UserItem> Users { get; set; } = [];

    [ObservableProperty] public partial string Search { get; set; } = "";
    [ObservableProperty] public partial List<OrderChoice> RoleFilters { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? RoleFilter { get; set; }
    [ObservableProperty] public partial OrderChoice State { get; set; } = States[0];
    [ObservableProperty] public partial UserItem? Selected { get; set; }

    public bool NoUsers => Users.Count == 0;
    public string TotalText => $"{Fmt.Int(Users.Count)} felhasználó";
    public string EmptyText => Search.Trim().Length > 0 || RoleFilter?.Key is not null || State.Key is not null
        ? "Nincs a szűrésnek megfelelő felhasználó." : "Még nincs felhasználó.";

    bool quiet;

    partial void OnRoleFilterChanged(OrderChoice? value) => Filter();
    partial void OnStateChanged(OrderChoice value) => Filter();

    void Filter()
    {
        OnPropertyChanged(nameof(EmptyText));
        if (!quiet && RoleFilters.Count > 0) _ = RunAsync(LoadUsersAsync);
    }

    partial void OnSelectedChanged(UserItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new UserFormViewModel(Shell, value.User.Id));
    }

    async Task LoadUsersAsync()
    {
        var page = await Api.GetAsync<UsersPage>(Query.Build("api/users",
            ("q", Search.Trim()), ("role_id", RoleFilter?.Key), ("active", State.Key), ("limit", 1000)));
        Users = page.Items.Select((u) => new UserItem(this, u)).ToList();
        OnPropertyChanged(nameof(EmptyText));
    }

    [RelayCommand]
    Task ApplyAsync() => RunAsync(LoadUsersAsync);

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new UserFormViewModel(Shell, null));

    internal async Task ResetPasswordAsync(UserRow u)
    {
        if (!await Shell.ConfirmAsync("Új ideiglenes jelszó",
            $"{u.Name} jelenlegi jelszava érvényét veszti, és minden eszközről kijelentkeztetjük. Az új, ideiglenes jelszót egyszer mutatjuk meg.",
            "Új jelszó kiadása")) return;
        await RunAsync(async () =>
        {
            var res = await Api.PostAsync<PasswordIssued>($"api/users/{u.Id}/reset-password");
            await Shell.NavigateAsync(new PasswordShownViewModel(Shell, u.Name, u.Email, res.Password));
        });
    }

    internal async Task LogoutAsync(UserRow u)
    {
        var self = u.Id == MyId;
        if (!await Shell.ConfirmAsync("Kijelentkeztetés",
            self ? "Minden más eszközödön kijelentkeztetünk. Ez a munkamenet megmarad." : $"{u.Name} minden eszközön ki lesz jelentkeztetve.",
            "Kijelentkeztetés")) return;
        await RunAsync(async () =>
        {
            var res = await Api.PostAsync<SessionsEnded>($"api/users/{u.Id}/logout");
            Shell.Toast($"{Fmt.Int(res.Count)} munkamenet megszűnt.", ToastKind.Success);
            await LoadUsersAsync();
        });
    }

    // A user who already recorded work is kept for the history: deactivated instead.
    internal async Task DeleteAsync(UserRow u)
    {
        if (!await Shell.ConfirmAsync("Felhasználó törlése", $"Biztosan törlöd {u.Name} ({u.Email}) fiókját?", "Törlés", danger: true)) return;
        try
        {
            await Api.DeleteAsync($"api/users/{u.Id}");
            Shell.Toast($"{u.Name} törölve.", ToastKind.Success);
            await RunAsync(LoadUsersAsync);
        }
        catch (ApiException e) when (e.Status == 409 && u.Active && CanEdit && e.Message.Contains("Tiltsd le"))
        {
            if (!await Shell.ConfirmAsync("Letiltás törlés helyett", e.Message, "Letiltás")) return;
            await RunAsync(async () =>
            {
                await Api.PatchAsync<UserRow>($"api/users/{u.Id}", new { active = false });
                Shell.Toast($"{u.Name} letiltva.", ToastKind.Success);
                await LoadUsersAsync();
            });
        }
        catch (ApiException e)
        {
            Shell.Toast(e.Message, ToastKind.Error);
        }
    }

    // ------------------------------------------------------------------ roles

    [ObservableProperty]
    public partial IReadOnlyList<RoleRow> Roles { get; set; } = [];

    [ObservableProperty]
    public partial IReadOnlyList<RoleChip> RoleChips { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RoleEditable), nameof(RoleLocked), nameof(ReadOnlyNote), nameof(CanRenameRole), nameof(CanDeleteRole),
        nameof(RoleUsersText), nameof(RoleDescription))]
    public partial RoleRow? Role { get; set; }

    [ObservableProperty]
    public partial IReadOnlyList<MatrixGroup> Matrix { get; set; } = [];

    [ObservableProperty]
    public partial IReadOnlyList<ColumnToggle> Columns { get; set; } = [];

    [ObservableProperty]
    public partial IReadOnlyList<OverviewGroup> Overview { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsDirty), nameof(DirtyText))]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand), nameof(DiscardCommand))]
    public partial int Dirty { get; set; }

    public bool RoleEditable => CanEdit && Role is { IsAdmin: false };
    public bool RoleLocked => Role?.IsAdmin == true;
    public bool ReadOnlyNote => Role is { IsAdmin: false } && !CanEdit;
    public bool CanRenameRole => CanEdit && Role is { IsAdmin: false };
    public bool CanDeleteRole => CanDelete && Role is { IsAdmin: false, UserCount: 0 };
    public string RoleUsersText => $"{Fmt.Int(Role?.UserCount ?? 0)} felhasználó";
    public string RoleDescription => string.IsNullOrEmpty(Role?.Description) ? "Nincs leírás." : Role.Description;
    public bool IsDirty => Dirty > 0;
    public string DirtyText => Dirty > 0 ? $"{Fmt.Int(Dirty)} mentetlen változás" : "Nincs mentetlen változás.";

    public static readonly string[] Actions = ["view", "create", "edit", "delete", "approve"];
    static readonly (string Key, string Label)[] Groups = [("warehouse", "Raktár"), ("commercial", "Kereskedelem"), ("admin", "Adminisztráció")];
    public IReadOnlyList<string> ActionLabels => Actions.Select((a) => MetaInfo.Label(Shell.Meta.Actions, a)).ToList();
    public string OverviewLegend => "M megtekintés, L létrehozás, Mó módosítás, T törlés, J jóváhagyás.";

    // Unsaved matrix changes per role; they stay while switching between roles.
    readonly Dictionary<int, HashSet<string>> drafts = [];

    static HashSet<string> Saved(RoleRow r) => r.Permissions.SelectMany((p) => p.Value.Select((a) => $"{p.Key}:{a}")).ToHashSet();
    HashSet<string> Current => Role is { } r ? drafts.GetValueOrDefault(r.Id) ?? Saved(r) : [];

    async Task LoadRolesAsync(int? select = null)
    {
        Roles = (await Api.GetAsync<ItemList<RoleRow>>("api/roles")).Items;
        var id = select ?? Role?.Id;
        Role = Roles.FirstOrDefault((r) => r.Id == id) ?? Roles.FirstOrDefault((r) => !r.IsAdmin) ?? Roles.FirstOrDefault();
        quiet = true;
        var keep = RoleFilter?.Key;
        RoleFilters = [new(null, "Minden szerepkör"), .. Roles.Select((r) => new OrderChoice(r.Id.ToString(), r.Name))];
        RoleFilter = RoleFilters.FirstOrDefault((r) => r.Key == keep) ?? RoleFilters[0];
        quiet = false;
        BuildMatrix();
        BuildOverview();
    }

    public override async Task LoadAsync()
    {
        await LoadRolesAsync(SelectAfterReload);
        SelectAfterReload = null;
        await LoadUsersAsync();
    }

    [RelayCommand]
    void ShowTab(string tab) => Tab = tab;

    [RelayCommand]
    void PickRole(RoleChip chip)
    {
        Role = chip.Role;
        BuildMatrix();
    }

    // Users of the role: the user list filtered to it.
    [RelayCommand]
    void ShowRoleUsers()
    {
        if (Role is null) return;
        RoleFilter = RoleFilters.FirstOrDefault((r) => r.Key == Role.Id.ToString());
        Tab = "users";
    }

    void BuildMatrix()
    {
        RoleChips = Roles.Select((r) => new RoleChip(r, r.Id == Role?.Id, drafts.ContainsKey(r.Id))).ToList();
        var modules = Shell.Meta.Modules;
        Matrix = Groups.Select((g) => new MatrixGroup(g.Label, modules.Where((m) => m.Group == g.Key)
            .Select((m) => new MatrixRow(this, m, Actions.Select((a) => m.Actions.TryGetValue(a, out var label) ? new MatrixCell(this, m.Key, a, label) : null).ToList()))
            .ToList())).Where((g) => g.Rows.Count > 0).ToList();
        Columns = Actions.Select((a) => new ColumnToggle(this, a, MetaInfo.Label(Shell.Meta.Actions, a))).ToList();
        Sync();
    }

    // The draft into the checkboxes and the row and column toggles.
    void Sync()
    {
        var set = Role?.IsAdmin == true ? null : Current;
        bool Has(string p) => set is null || set.Contains(p);
        foreach (var row in Matrix.SelectMany((g) => g.Rows))
        {
            foreach (var c in row.Cells.OfType<MatrixCell>()) c.Show(Has($"{c.ModuleKey}:{c.Action}"));
            var n = row.Cells.OfType<MatrixCell>().Count((c) => c.IsChecked);
            row.Show(n == 0 ? false : n == row.Cells.OfType<MatrixCell>().Count() ? true : null);
        }
        foreach (var col in Columns)
        {
            var cells = Matrix.SelectMany((g) => g.Rows).Select((r) => r.Cells[Array.IndexOf(Actions, col.Action)]).OfType<MatrixCell>().ToList();
            var n = cells.Count((c) => c.IsChecked);
            col.Show(n == 0 ? false : n == cells.Count ? true : null);
        }
        Dirty = Role is { } r && drafts.TryGetValue(r.Id, out var d) ? d.Except(Saved(r)).Count() + Saved(r).Except(d).Count() : 0;
        foreach (var chip in RoleChips) chip.HasDraft = drafts.ContainsKey(chip.Role.Id);
    }

    // One change to the draft, with the rule "any action needs view".
    internal void Change(Action<HashSet<string>> apply)
    {
        if (Role is not { } r || !RoleEditable) return;
        var set = new HashSet<string>(Current);
        apply(set);
        foreach (var m in Shell.Meta.Modules)
            if (m.Actions.Keys.Any((a) => a != "view" && set.Contains($"{m.Key}:{a}"))) set.Add($"{m.Key}:view");
        if (set.SetEquals(Saved(r))) drafts.Remove(r.Id);
        else drafts[r.Id] = set;
        Sync();
    }

    internal static void ClearRow(HashSet<string> set, string module)
    {
        foreach (var a in Actions) set.Remove($"{module}:{a}");
    }

    internal void Toggle(MatrixCell c, bool on) => Change((set) =>
    {
        if (on) set.Add($"{c.ModuleKey}:{c.Action}");
        else if (c.Action == "view") ClearRow(set, c.ModuleKey);
        else set.Remove($"{c.ModuleKey}:{c.Action}");
    });

    internal void ToggleRow(MatrixRow row, bool on) => Change((set) =>
    {
        if (on) foreach (var a in row.Module.Actions.Keys) set.Add($"{row.Module.Key}:{a}");
        else ClearRow(set, row.Module.Key);
    });

    internal void ToggleColumn(string action, bool on) => Change((set) =>
    {
        foreach (var m in Shell.Meta.Modules.Where((m) => m.Actions.ContainsKey(action)))
        {
            if (on) set.Add($"{m.Key}:{action}");
            else if (action == "view") ClearRow(set, m.Key);
            else set.Remove($"{m.Key}:{action}");
        }
    });

    [RelayCommand(CanExecute = nameof(IsDirty))]
    void Discard()
    {
        if (Role is { } r) drafts.Remove(r.Id);
        Sync();
    }

    [RelayCommand(CanExecute = nameof(IsDirty))]
    async Task SaveAsync()
    {
        if (Role is not { } r) return;
        var set = Current;
        var mine = Shell.Me?.User.Role.Id == r.Id;
        if (mine && CanEdit && !set.Contains("users:edit") && !await Shell.ConfirmAsync("Saját jogosultságod",
            "A saját szerepkörödből veszed el a Felhasználók módosítása jogot. Mentés után ezt a képernyőt már nem tudod szerkeszteni, csak egy adminisztrátor adhatja vissza. Folytatod?",
            "Mentés így")) return;
        await RunAsync(async () =>
        {
            var body = Shell.Meta.Modules.ToDictionary((m) => m.Key, (m) => m.Actions.Keys.Where((a) => set.Contains($"{m.Key}:{a}")).ToList());
            var res = await Api.PutAsync<RoleSaved>($"api/roles/{r.Id}/permissions", new { permissions = body });
            drafts.Remove(r.Id);
            var added = res.Added?.Count ?? 0;
            var removed = res.Removed?.Count ?? 0;
            Shell.Toast(added + removed > 0 ? $"{r.Name}: {Fmt.Int(added)} jog hozzáadva, {Fmt.Int(removed)} elvéve." : $"{r.Name}: nem változott semmi.", ToastKind.Success);
            if (res.Self) await Shell.RefreshMeAsync();
            await LoadRolesAsync(r.Id);
        });
    }

    [RelayCommand]
    Task NewRoleAsync() => Shell.NavigateAsync(new RoleFormViewModel(Shell, this, null));

    [RelayCommand]
    Task RenameRoleAsync() => Role is { } r ? Shell.NavigateAsync(new RoleFormViewModel(Shell, this, r)) : Task.CompletedTask;

    [RelayCommand]
    async Task DeleteRoleAsync()
    {
        if (Role is not { } r) return;
        if (!await Shell.ConfirmAsync("Szerepkör törlése", $"Biztosan törlöd a(z) {r.Name} szerepkört?", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/roles/{r.Id}");
            drafts.Remove(r.Id);
            Shell.Toast($"{r.Name} törölve.", ToastKind.Success);
            Role = null;
            await LoadRolesAsync();
        });
    }

    // A new role opens selected (RoleFormViewModel sets it before going back).
    internal int? SelectAfterReload { get; set; }

    void BuildOverview()
    {
        string[] shortName = ["M", "L", "Mó", "T", "J"];
        var modules = Shell.Meta.Modules;
        Overview = Groups.Select((g) => new OverviewGroup(g.Label, modules.Where((m) => m.Group == g.Key).Select((m) => new OverviewRow(m.Name,
            Roles.Select((r) => string.Join(" ", Actions.Select((a, i) => !m.Actions.ContainsKey(a) ? " " : r.Permissions.GetValueOrDefault(m.Key)?.Contains(a) == true ? shortName[i] : "·"))).ToList()))
            .ToList())).Where((g) => g.Rows.Count > 0).ToList();
    }
}

public sealed class UserItem(UsersViewModel page, UserRow u)
{
    public UserRow User { get; } = u;
    bool Self => User.Id == page.MyId;
    // Only an administrator touches an administrator's account.
    bool Locked => User.IsAdmin && !page.IAmAdmin;
    public bool IsMe => Self;
    public string LastText => User.LastLoginAt is { } t ? Fmt.DateTime(t) : "még nem lépett be";
    public bool NeverLoggedIn => User.LastLoginAt is null;
    public bool WaitsForPassword => User.Active && User.MustChangePassword;
    public string SessionsText => Fmt.Int(User.Sessions);
    public bool CanReset => page.CanEdit && !Locked && !Self;
    public bool CanLogout => page.CanEdit && !Locked && User.Sessions > 0;
    public bool CanDelete => page.CanDelete && !Locked && !Self;
    public RelayCommand ResetCommand => new(() => _ = page.ResetPasswordAsync(User));
    public RelayCommand LogoutCommand => new(() => _ = page.LogoutAsync(User));
    public RelayCommand DeleteCommand => new(() => _ = page.DeleteAsync(User));
}

public sealed partial class RoleChip(RoleRow role, bool selected, bool draft) : ObservableObject
{
    public RoleRow Role { get; } = role;
    public bool IsSelected { get; } = selected;
    public string Text => $"{Role.Name} {Fmt.Int(Role.UserCount)}";

    [ObservableProperty]
    public partial bool HasDraft { get; set; } = draft;
}

public sealed record MatrixGroup(string Label, IReadOnlyList<MatrixRow> Rows);

// A module of the matrix: one checkbox per action it has (null where it has none) and "Mind".
public sealed partial class MatrixRow(UsersViewModel page, ModuleInfo module, IReadOnlyList<MatrixCell?> cells) : ObservableObject
{
    public ModuleInfo Module { get; } = module;
    public IReadOnlyList<MatrixCell?> Cells { get; } = cells;
    public bool Editable => page.RoleEditable;

    bool? all;
    bool quiet;

    public bool? All
    {
        get => all;
        set
        {
            if (quiet || value == all) return;
            page.ToggleRow(this, value != false);
        }
    }

    internal void Show(bool? value)
    {
        quiet = true;
        all = value;
        OnPropertyChanged(nameof(All));
        quiet = false;
    }
}

public sealed partial class MatrixCell(UsersViewModel page, string module, string action, string label) : ObservableObject
{
    public string ModuleKey { get; } = module;
    public string Action { get; } = action;
    public string Label { get; } = label;
    public bool Editable => page.RoleEditable;

    bool on;
    bool quiet;

    public bool IsChecked
    {
        get => on;
        set
        {
            if (quiet || value == on) return;
            page.Toggle(this, value);
        }
    }

    internal void Show(bool value)
    {
        quiet = true;
        on = value;
        OnPropertyChanged(nameof(IsChecked));
        quiet = false;
    }
}

public sealed partial class ColumnToggle(UsersViewModel page, string action, string label) : ObservableObject
{
    public string Action { get; } = action;
    public string Label { get; } = label;
    public bool Editable => page.RoleEditable;

    bool? all;
    bool quiet;

    public bool? All
    {
        get => all;
        set
        {
            if (quiet || value == all) return;
            page.ToggleColumn(Action, value != false);
        }
    }

    internal void Show(bool? value)
    {
        quiet = true;
        all = value;
        OnPropertyChanged(nameof(All));
        quiet = false;
    }
}

public sealed record OverviewGroup(string Label, IReadOnlyList<OverviewRow> Rows);

public sealed record OverviewRow(string Module, IReadOnlyList<string> Roles);
