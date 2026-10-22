using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.ViewModels;

// POST /api/me/password { current, next }. Forced after the first login with an initial password
// (until then the server refuses everything else); otherwise opened from the profile.
public sealed partial class ChangePasswordViewModel(ShellViewModel shell, bool forced) : PageViewModel(shell)
{
    public const int MinLength = 10;

    public override string Title => "Jelszó módosítása";
    public bool Forced { get; } = forced;

    [ObservableProperty]
    public partial string Current { get; set; } = "";

    [ObservableProperty]
    public partial string Next { get; set; } = "";

    [ObservableProperty]
    public partial string Again { get; set; } = "";

    [ObservableProperty]
    public partial string? CurrentError { get; set; }

    [ObservableProperty]
    public partial string? NextError { get; set; }

    [ObservableProperty]
    public partial string? AgainError { get; set; }

    [RelayCommand]
    async Task SaveAsync()
    {
        CurrentError = Current.Length == 0 ? "Add meg a jelenlegi jelszavad." : null;
        NextError = Next.Length < MinLength ? $"Legalább {MinLength} karakter legyen." : null;
        AgainError = Again != Next ? "A két új jelszó nem egyezik." : null;
        if (CurrentError is not null || NextError is not null || AgainError is not null) return;
        try
        {
            await Api.PostAsync("api/me/password", new { current = Current, next = Next });
        }
        catch (ApiException e) when (e.Fields.Count > 0)
        {
            CurrentError = e.Fields.GetValueOrDefault("current");
            NextError = e.Fields.GetValueOrDefault("next");
            return;
        }
        catch (ApiException e)
        {
            Shell.Toast(e.Message, ToastKind.Error);
            return;
        }
        Shell.Toast("A jelszó megváltozott.", ToastKind.Success);
        Current = Next = Again = "";
        if (Forced) await Shell.SignedInAsync(await Api.GetAsync<Me>("api/me"));
        else await Shell.BackAsync();
    }

    [RelayCommand]
    Task LogoutAsync() => Shell.LogoutCommand.ExecuteAsync(null);
}
