using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.Users;
using Fully.Wms.Services;

namespace Fully.Wms.Tests;

// The user screens: the list with its filters, a new user with the password shown once, the
// user's own window, a new password, deleting; a new role through the permission matrix.
[Collection("Users")]
public class UsersUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    static async Task AnswerAsync(Fully.Wms.ViewModels.ShellViewModel shell, bool ok = true)
    {
        await WaitAsync(() => shell.Dialog is not null);
        if (ok) shell.Dialog!.OkCommand.Execute(null);
        else shell.Dialog!.CancelCommand.Execute(null);
    }

    [AvaloniaFact]
    public async Task Desktop_users_new_reset_delete()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("users");
        var page = Assert.IsType<UsersViewModel>(shell.Current);
        Assert.Contains(page.Users, (u) => u.IsMe && !u.CanDelete && !u.CanReset);
        Screens.Save(window, "users-list-desktop");
        page.RoleFilter = page.RoleFilters.Single((r) => r.Label == "Raktáros");
        await WaitAsync(() => !page.IsLoading && page.Users.All((u) => u.User.RoleName == "Raktáros"));
        page.RoleFilter = page.RoleFilters[0];
        await WaitAsync(() => !page.IsLoading && page.Users.Count >= 2);

        // New: the role is required, the e-mail is checked; the password is shown once.
        await page.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<UserFormViewModel>(shell.Current);
        await WaitAsync(() => form.Roles.Count > 0);
        form.Name = "Teszt Tódor";
        form.Email = "rossz";
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("role_id"));
        form.Role = form.Roles.Single((r) => r.Label == "Ügyfélszolgálat");
        Assert.False(form.Errors.ContainsKey("role_id"));
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("email"));
        var email = $"todor{DateTime.UtcNow:HHmmssff}@example.com";
        form.Email = email;
        Screens.Save(window, "users-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        var shown = Assert.IsType<PasswordShownViewModel>(shell.Current);
        Assert.Contains("Teszt Tódor", shown.Note);
        Screens.Save(window, "users-password-desktop");
        await shown.CloseCommand.ExecuteAsync(null);
        Assert.Same(page, shell.Current);
        await WaitAsync(() => page.Users.Any((u) => u.User.Email == email));
        var item = page.Users.Single((u) => u.User.Email == email);
        Assert.True(item.WaitsForPassword && item.CanReset && item.CanDelete && !item.CanLogout);

        // The user's own window: a change saved, the sessions and the activity shown.
        page.Selected = item;
        await WaitAsync(() => shell.Current is UserFormViewModel { Data: not null });
        var user = (UserFormViewModel)shell.Current!;
        Assert.False(user.IsNew);
        Assert.True(user.NoSessions);
        user.Phone = "+36 30 555 1234";
        await user.SaveCommand.ExecuteAsync(null);
        Assert.Equal("+36 30 555 1234", user.Data!.Phone);
        Screens.Save(window, "users-user-desktop");
        await shell.BackAsync();

        // A new temporary password, then deleting (no history: deleted).
        item = page.Users.Single((u) => u.User.Email == email);
        item.ResetCommand.Execute(null);
        await AnswerAsync(shell);
        await WaitAsync(() => shell.Current is PasswordShownViewModel);
        await ((PasswordShownViewModel)shell.Current!).CloseCommand.ExecuteAsync(null);
        page.Users.Single((u) => u.User.Email == email).DeleteCommand.Execute(null);
        await AnswerAsync(shell);
        await WaitAsync(() => page.Users.All((u) => u.User.Email != email));
    }

    [AvaloniaFact]
    public async Task Desktop_role_matrix()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("users");
        var page = Assert.IsType<UsersViewModel>(shell.Current);
        page.ShowTabCommand.Execute("roles");
        Assert.False(page.RoleLocked);
        Screens.Save(window, "users-roles-desktop");

        // The administrator role is locked.
        page.PickRoleCommand.Execute(page.RoleChips.Single((c) => c.Role.IsAdmin));
        Assert.True(page.RoleLocked);
        Assert.False(page.RoleEditable);
        Assert.All(page.Matrix.SelectMany((g) => g.Rows), (r) => Assert.True(r.All));

        // A new role copied from Raktáros, changed in the matrix: any action brings view.
        await page.NewRoleCommand.ExecuteAsync(null);
        var form = Assert.IsType<RoleFormViewModel>(shell.Current);
        form.Name = $"Műszakvezető {DateTime.UtcNow:HHmmssff}";
        form.CopyFrom = form.Sources.Single((s) => s.Label == "Raktáros");
        Screens.Save(window, "users-role-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        Assert.Same(page, shell.Current);
        await WaitAsync(() => page.Role?.Name == form.Name.Trim());
        Assert.True(page.RoleEditable);
        var orders = page.Matrix.SelectMany((g) => g.Rows).Single((r) => r.Module.Key == "orders");
        Assert.Null(orders.All);
        orders.Cells[2]!.IsChecked = true;
        Assert.Equal(1, page.Dirty);
        var billing = page.Matrix.SelectMany((g) => g.Rows).Single((r) => r.Module.Key == "billing");
        billing.Cells[4]!.IsChecked = true;
        Assert.True(billing.Cells[0]!.IsChecked);
        Assert.Equal(3, page.Dirty);
        page.Columns[0].All = false;
        Assert.All(page.Matrix.SelectMany((g) => g.Rows), (r) => Assert.False(r.All));
        page.DiscardCommand.Execute(null);
        Assert.Equal(0, page.Dirty);
        Assert.Null(orders.All);
        billing.All = true;
        Assert.True(billing.All);
        Assert.Contains(page.RoleChips, (c) => c.HasDraft);
        Screens.Save(window, "users-matrix-desktop");
        await page.SaveCommand.ExecuteAsync(null);
        Assert.Equal(0, page.Dirty);
        Assert.Equal(5, page.Role!.Permissions["billing"].Count);

        // Deleted: no user has it.
        Assert.True(page.CanDeleteRole);
        var deleting = page.DeleteRoleCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await deleting;
        Assert.DoesNotContain(page.Roles, (r) => r.Name == form.Name.Trim());
    }

    [AvaloniaFact]
    public async Task Desktop_user_is_a_record_window()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("users");
        var page = Assert.IsType<UsersViewModel>(shell.Current);
        var worker = page.Users.Single((u) => u.User.Email == LiveServer.Worker);
        page.Selected = worker;
        Screens.Settle();
        var w = Assert.Single(presenter.Records);
        var user = Assert.IsType<UserFormViewModel>(w.Page);
        await WaitAsync(() => user.Data is not null);
        Assert.Equal("Raktáros", user.Role?.Label);
        Screens.Save(w, "users-user-window");
        await shell.NavigateAsync(new UserFormViewModel(shell, null));
        Screens.Settle();
        Assert.Single(presenter.Dialogs);
        Screens.Save(presenter.Dialogs[0], "users-new-dialog");
        presenter.CloseAll();
    }
}
