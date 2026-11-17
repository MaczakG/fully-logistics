using System.Runtime.CompilerServices;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Users;

// Felhasználók: the users and the roles with the permission matrix.
static class UsersModule
{
    [ModuleInitializer]
    internal static void Register()
    {
        AppModules.Use("users", (s) => new UsersViewModel(s));
        PageLocator.Register<UsersViewModel>(() => new UsersView());
        PageLocator.Register<UserFormViewModel>(() => new UserFormView());
        PageLocator.Register<PasswordShownViewModel>(() => new PasswordShownView());
        PageLocator.Register<RoleFormViewModel>(() => new RoleFormView());
    }
}
