using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Tests;

// The user and role answers read into the app's models, and the calls the app makes go through.
// The changes are made on users and roles the tests create (and delete).
[Collection("Users")]
public class UsersLiveTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Users_and_roles_read()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var users = await api.GetAsync<UsersPage>("api/users", Ct);
        Assert.Contains(users.Items, (u) => u.Email == LiveServer.Admin && u.IsAdmin && u.Sessions > 0);
        Assert.Contains(users.Items, (u) => u.Email == LiveServer.Worker && !u.IsAdmin);
        var me = users.Items.Single((u) => u.Email == LiveServer.Admin);
        var detail = await api.GetAsync<UserDetail>($"api/users/{me.Id}", Ct);
        Assert.Contains(detail.Sessions, (s) => s.Current);
        var roles = await api.GetAsync<ItemList<RoleRow>>("api/roles", Ct);
        var admin = roles.Items.Single((r) => r.IsAdmin);
        Assert.Contains("edit", admin.Permissions["users"]);
        var worker = roles.Items.Single((r) => r.Key == "warehouse_operator");
        Assert.Contains("edit", worker.Permissions["transport"]);
        Assert.Empty(worker.Permissions["users"]);
    }

    [Fact]
    public async Task User_created_reset_and_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var email = $"nativeteszt{DateTime.UtcNow:HHmmssfff}@example.com";
        var roles = (await api.GetAsync<ItemList<RoleRow>>("api/roles", Ct)).Items;
        var service = roles.Single((r) => r.Key == "customer_service");
        var created = await api.PostAsync<UserCreated>("api/users", new { name = "Native Teszt", email, role_id = service.Id }, Ct);
        Assert.Matches("^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$", created.Password);
        var dup = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<UserCreated>("api/users", new { name = "Más", email, role_id = service.Id }, Ct));
        Assert.True(dup.Fields.ContainsKey("email"));

        // The new user signs in with the temporary password and must change it.
        using (var user = new ApiClient(new Uri(LiveServer.Url!)))
        {
            var login = await user.PostAsync<LoginResult>("api/auth/login", new { email, password = created.Password }, Ct);
            Assert.True(login.MustChangePassword);
        }
        var saved = await api.PatchAsync<UserRow>($"api/users/{created.Id}", new { phone = "+36 30 111 2222" }, Ct);
        Assert.Equal("+36 30 111 2222", saved.Phone);
        Assert.Equal(1, saved.Sessions);
        var ended = await api.PostAsync<SessionsEnded>($"api/users/{created.Id}/logout", null, Ct);
        Assert.Equal(1, ended.Count);
        var reset = await api.PostAsync<PasswordIssued>($"api/users/{created.Id}/reset-password", null, Ct);
        Assert.NotEqual(created.Password, reset.Password);
        await api.DeleteAsync($"api/users/{created.Id}", Ct);
        var gone = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<UserDetail>($"api/users/{created.Id}", Ct));
        Assert.Equal(404, gone.Status);

        // Yourself: not disabled, not deleted.
        var me = (await api.GetAsync<UsersPage>("api/users", Ct)).Items.Single((u) => u.Email == LiveServer.Admin);
        var self = await Assert.ThrowsAsync<ApiException>(() => api.PatchAsync<UserRow>($"api/users/{me.Id}", new { active = false }, Ct));
        Assert.Equal(409, self.Status);
        var selfDelete = await Assert.ThrowsAsync<ApiException>(() => api.DeleteAsync($"api/users/{me.Id}", Ct));
        Assert.Equal(409, selfDelete.Status);
    }

    [Fact]
    public async Task Role_created_with_permissions_and_deleted()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var roles = (await api.GetAsync<ItemList<RoleRow>>("api/roles", Ct)).Items;
        var worker = roles.Single((r) => r.Key == "warehouse_operator");
        var name = $"Native szerep {DateTime.UtcNow:HHmmssfff}";
        var role = await api.PostAsync<RoleRow>("api/roles", new { name, description = "Teszt", copy_from = worker.Id }, Ct);
        Assert.Equal(worker.Permissions["transport"], role.Permissions["transport"]);
        var dup = await Assert.ThrowsAsync<ApiException>(() => api.PostAsync<RoleRow>("api/roles", new { name = name.ToUpperInvariant() }, Ct));
        Assert.True(dup.Fields.ContainsKey("name"));

        // Any action brings view with it.
        var body = new Dictionary<string, List<string>> { ["orders"] = ["edit"], ["stock"] = ["view"] };
        var saved = await api.PutAsync<RoleSaved>($"api/roles/{role.Id}/permissions", new { permissions = body }, Ct);
        Assert.Equal(["view", "edit"], saved.Permissions["orders"]);
        Assert.Empty(saved.Permissions["transport"]);
        Assert.Contains("orders:edit", saved.Added!);
        Assert.Contains("transport:edit", saved.Removed!);
        Assert.False(saved.Self);
        var bad = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<RoleSaved>($"api/roles/{role.Id}/permissions",
            new { permissions = new Dictionary<string, List<string>> { ["orders"] = ["approve"] } }, Ct));
        Assert.Equal(400, bad.Status);

        var renamed = await api.PatchAsync<RoleRow>($"api/roles/{role.Id}", new { name = name + " 2" }, Ct);
        Assert.Equal(name + " 2", renamed.Name);
        await api.DeleteAsync($"api/roles/{role.Id}", Ct);
        Assert.DoesNotContain((await api.GetAsync<ItemList<RoleRow>>("api/roles", Ct)).Items, (r) => r.Id == role.Id);

        var admin = roles.Single((r) => r.IsAdmin);
        var locked = await Assert.ThrowsAsync<ApiException>(() => api.PutAsync<RoleSaved>($"api/roles/{admin.Id}/permissions",
            new { permissions = new Dictionary<string, List<string>>() }, Ct));
        Assert.Equal(409, locked.Status);
    }

    [Fact]
    public async Task Worker_cannot_see_users()
    {
        using var api = await LiveServer.SignInAsync(LiveServer.Worker);
        var denied = await Assert.ThrowsAsync<ApiException>(() => api.GetAsync<UsersPage>("api/users", Ct));
        Assert.Equal(403, denied.Status);
    }
}
