using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.ViewModels;

// The signed-in user's own data (PATCH /api/me) and this device's settings: theme, server address.
public sealed partial class ProfileViewModel : PageViewModel
{
    public ProfileViewModel(ShellViewModel shell) : base(shell)
    {
        Name = shell.Me?.User.Name ?? "";
        Phone = shell.Me?.User.Phone ?? "";
        Theme = shell.Services.Settings.Theme switch { "Light" => 1, "Dark" => 2, _ => 0 };
    }

    public override string Title => "Saját fiók";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 600;

    public string Email => Shell.Me?.User.Email ?? "";
    public string RoleName => Shell.Me?.User.Role.Name ?? "";
    public string Server => Shell.Services.Api.BaseUri.Host;
    public string Version => typeof(ProfileViewModel).Assembly.GetName().Version?.ToString(3) ?? "";

    [ObservableProperty]
    public partial string Name { get; set; }

    [ObservableProperty]
    public partial string Phone { get; set; }

    [ObservableProperty]
    public partial string? NameError { get; set; }

    // 0: as the system, 1: light, 2: dark
    [ObservableProperty]
    public partial int Theme { get; set; }

    partial void OnThemeChanged(int value)
    {
        Shell.Services.Settings.Theme = value switch { 1 => "Light", 2 => "Dark", _ => null };
        Shell.Services.SaveSettings();
        App.ApplyTheme(Shell.Services.Settings.Theme);
    }

    [RelayCommand]
    Task SaveAsync() => RunAsync(async () =>
    {
        NameError = Name.Trim().Length == 0 ? "Add meg a neved." : null;
        if (NameError is not null) return;
        try
        {
            var me = await Api.PatchAsync<Me>("api/me", new { name = Name.Trim(), phone = Phone.Trim() });
            Shell.Me = me;
            Shell.Toast("Mentve.", ToastKind.Success);
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            NameError = e.Fields.GetValueOrDefault("name");
        }
    });

    [RelayCommand]
    Task ChangePasswordAsync() => Shell.NavigateAsync(new ChangePasswordViewModel(Shell, forced: false));
}
