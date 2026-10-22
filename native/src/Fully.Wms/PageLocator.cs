using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms;

// Page view model -> its view. A plain list instead of a name lookup by reflection, so the iOS
// build (trimmed) keeps every view.
public sealed class PageLocator : IDataTemplate
{
    static readonly Dictionary<Type, Func<Control>> Views = new()
    {
        [typeof(LoginViewModel)] = () => new LoginView(),
        [typeof(ChangePasswordViewModel)] = () => new ChangePasswordView(),
        [typeof(HomeViewModel)] = () => new HomeView(),
        [typeof(ProfileViewModel)] = () => new ProfileView(),
        [typeof(PlaceholderViewModel)] = () => new PlaceholderView(),
        [typeof(Modules.Common.CsvImportViewModel)] = () => new Modules.Common.CsvImportView(),
    };

    public static void Register<TViewModel>(Func<Control> create) where TViewModel : PageViewModel => Views[typeof(TViewModel)] = create;

    public Control? Build(object? param) =>
        param is not null && Views.TryGetValue(param.GetType(), out var create)
            ? create()
            : new TextBlock { Text = $"Hiányzó nézet: {param?.GetType().Name}" };

    public bool Match(object? data) => data is PageViewModel;
}
