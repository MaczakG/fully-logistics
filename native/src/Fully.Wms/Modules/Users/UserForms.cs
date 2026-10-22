using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Users;

// A user: new in a small window (a temporary password is shown once after saving), or one user in
// its own window with the open sessions and the latest activity.
public sealed partial class UserFormViewModel(ShellViewModel shell, int? id) : PageViewModel(shell)
{
    public int? Id { get; } = id;
    public bool IsNew => Id is null;
    public override string Title => Data?.Name ?? (IsNew ? "Új felhasználó" : "Felhasználó");
    public override string? Module => "users";
    public override PageKind Kind => IsNew ? PageKind.Dialog : PageKind.Record;
    public override string? RecordKey => Id is { } i ? $"user:{i}" : null;
    public override double DialogWidth => 640;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(ReadOnly), nameof(CanSave), nameof(LockedNote), nameof(IsSelf), nameof(ActiveHint),
        nameof(Sessions), nameof(MoreSessions), nameof(NoSessions), nameof(Activity), nameof(NoActivity), nameof(LoginText), nameof(CanToggleActive))]
    public partial UserDetail? Data { get; set; }

    [ObservableProperty] public partial List<OrderChoice> Roles { get; set; } = [];
    [ObservableProperty] public partial string Name { get; set; } = "";
    [ObservableProperty] public partial string Email { get; set; } = "";
    [ObservableProperty] public partial string Phone { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? Role { get; set; }
    [ObservableProperty] public partial bool Active { get; set; } = true;
    [ObservableProperty] public partial Dictionary<string, string> Errors { get; set; } = [];
    [ObservableProperty] public partial string? Error { get; set; }

    bool IAmAdmin => Shell.Me?.User.Role.IsAdmin == true;
    public bool IsSelf => Data?.Id == Shell.Me?.User.Id;
    bool Locked => Data is { IsAdmin: true } && !IAmAdmin;
    public bool ReadOnly => !IsNew && (Shell.Me?.Can("users", "edit") != true || Locked);
    public bool CanSave => !ReadOnly;
    public bool CanToggleActive => !ReadOnly && !IsSelf;
    public bool LockedNote => Locked;
    public string SubmitText => IsNew ? "Létrehozás" : "Mentés";
    public string ActiveHint => IsSelf ? "Saját magadat nem tilthatod le." : "Letiltáskor minden munkamenete azonnal megszűnik.";
    public IReadOnlyList<UserSession> Sessions => Data?.Sessions.Take(8).ToList() ?? [];
    public string? MoreSessions => Data is { Sessions.Count: > 8 } u ? $"és még {Fmt.Int(u.Sessions.Count - 8)} munkamenet" : null;
    public bool NoSessions => Sessions.Count == 0;
    public IReadOnlyList<UserActivity> Activity => Data?.Activity.Take(8).ToList() ?? [];
    public bool NoActivity => Activity.Count == 0;
    public string LoginText => Data is { } u
        ? $"Utolsó belépés: {(u.LastLoginAt is { } t ? Fmt.DateTime(t) : "még nem lépett be")}. Létrehozva: {Fmt.Date(u.CreatedAt)}."
        : "";

    List<RoleRow> roleRows = [];

    public override async Task LoadAsync()
    {
        roleRows = (await Api.GetAsync<ItemList<RoleRow>>("api/roles")).Items;
        // Only an administrator gives the administrator role.
        Roles = roleRows.Select((r) => new OrderChoice(r.Id.ToString(), r.IsAdmin && !IAmAdmin ? $"{r.Name} (csak adminisztrátor adhatja)" : r.Name)).ToList();
        if (Id is not { } id) return;
        var u = await Api.GetAsync<UserDetail>($"api/users/{id}");
        Data = u;
        Name = u.Name;
        Email = u.Email;
        Phone = u.Phone ?? "";
        Role = Roles.FirstOrDefault((r) => r.Key == u.RoleId.ToString());
        Active = u.Active;
        Errors = [];
        Error = null;
    }

    partial void OnNameChanged(string value) => Clear("name");
    partial void OnEmailChanged(string value) => Clear("email");
    partial void OnRoleChanged(OrderChoice? value) => Clear("role_id");

    void Clear(string key)
    {
        if (Errors.ContainsKey(key)) Errors = Errors.Where((e) => e.Key != key).ToDictionary();
    }

    [RelayCommand]
    async Task SaveAsync()
    {
        Error = null;
        if (Role is null)
        {
            Errors = new() { ["role_id"] = "Válassz szerepkört." };
            Error = "Ellenőrizd a megjelölt mezőket.";
            return;
        }
        var role = roleRows.First((r) => r.Id.ToString() == Role.Key);
        if (IsSelf && !role.IsAdmin && IAmAdmin && !await Shell.ConfirmAsync("Saját szerepkör",
            "Ezzel elveszíted az adminisztrátori jogaidat. Folytatod?", "Igen, módosítom")) return;
        await RunAsync(async () =>
        {
            var body = new Dictionary<string, object?> { ["name"] = Name.Trim(), ["email"] = Email.Trim(), ["phone"] = Phone.Trim(), ["role_id"] = role.Id };
            if (!IsNew && !IsSelf) body["active"] = Active;
            try
            {
                if (Id is { } id)
                {
                    await Api.PatchAsync<UserRow>($"api/users/{id}", body);
                    Shell.Toast($"{Name.Trim()} mentve.", ToastKind.Success);
                    if (IsSelf) await Shell.RefreshMeAsync();
                    await LoadAsync();
                    if (Shell.Presenter is not null && Shell.Current is { } main && main != this) _ = main.ReloadAsync();
                }
                else
                {
                    body["active"] = true;
                    var res = await Api.PostAsync<UserCreated>("api/users", body);
                    await Shell.BackAsync();
                    await Shell.NavigateAsync(new PasswordShownViewModel(Shell, res.Name, res.Email, res.Password));
                }
            }
            catch (ApiException e) when (e.Status is 400 or 409)
            {
                Errors = new Dictionary<string, string>(e.Fields);
                Error = e.Message;
            }
        });
    }
}

// The temporary password: shown once, to hand over in person.
public sealed partial class PasswordShownViewModel(ShellViewModel shell, string name, string email, string password) : PageViewModel(shell)
{
    public override string Title => "Ideiglenes jelszó";
    public override string? Module => "users";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 520;
    public string Password { get; } = password;
    public string Note => $"Ezt a jelszót csak most látod. Add át {name} részére személyesen vagy telefonon, ne e-mailben.";
    public string Login => $"Bejelentkezés: {email}. Első belépéskor saját jelszót kell beállítania.";

    [RelayCommand]
    Task CloseAsync() => Shell.BackAsync();
}

// A role: name and description; a new one may start with the permissions of another.
public sealed partial class RoleFormViewModel : PageViewModel
{
    public RoleFormViewModel(ShellViewModel shell, UsersViewModel page, RoleRow? role) : base(shell)
    {
        this.page = page;
        Role = role;
        Name = role?.Name ?? "";
        Description = role?.Description ?? "";
        Sources = [new(null, "Ne másoljon, üresen indul"), .. page.Roles.Select((r) => new OrderChoice(r.Id.ToString(), r.Name))];
        CopyFrom = Sources[0];
    }

    readonly UsersViewModel page;
    public RoleRow? Role { get; }
    public bool IsNew => Role is null;
    public override string Title => Role is { } r ? $"Szerepkör: {r.Name}" : "Új szerepkör";
    public override string? Module => "users";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 480;
    public string SubmitText => IsNew ? "Létrehozás" : "Mentés";
    public IReadOnlyList<OrderChoice> Sources { get; }

    [ObservableProperty] public partial string Name { get; set; }
    [ObservableProperty] public partial string Description { get; set; }
    [ObservableProperty] public partial OrderChoice CopyFrom { get; set; }
    [ObservableProperty] public partial Dictionary<string, string> Errors { get; set; } = [];
    [ObservableProperty] public partial string? Error { get; set; }

    partial void OnNameChanged(string value)
    {
        if (Errors.ContainsKey("name")) Errors = [];
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        Error = null;
        try
        {
            if (Role is { } r)
            {
                await Api.PatchAsync<RoleRow>($"api/roles/{r.Id}", new { name = Name.Trim(), description = Description.Trim() });
                Shell.Toast("Szerepkör mentve.", ToastKind.Success);
            }
            else
            {
                var res = await Api.PostAsync<RoleRow>("api/roles", new Dictionary<string, object?>
                {
                    ["name"] = Name.Trim(), ["description"] = Description.Trim(), ["copy_from"] = CopyFrom.Key is { } c ? int.Parse(c) : null,
                });
                page.SelectAfterReload = res.Id;
                Shell.Toast($"{res.Name} szerepkör létrehozva. Most pipáld be a jogait.", ToastKind.Success);
            }
            await Shell.BackAsync();
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });
}
