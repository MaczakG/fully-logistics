using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;

namespace Fully.Wms.ViewModels;

// Sign in with e-mail and password (POST /api/auth/login). The server address can be changed here,
// for example after the server moves to another machine.
public sealed partial class LoginViewModel : PageViewModel
{
    public LoginViewModel(ShellViewModel shell) : base(shell)
    {
        Email = shell.Services.Settings.Email ?? "";
        Server = shell.Services.Settings.Server;
    }

    public override string Title => "Bejelentkezés";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(LoginCommand))]
    public partial string Email { get; set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(LoginCommand))]
    public partial string Password { get; set; } = "";

    [ObservableProperty]
    public partial string Server { get; set; }

    [ObservableProperty]
    public partial bool ShowServer { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(LoginCommand))]
    public partial bool IsWorking { get; set; }

    public string ServerHost => AppServices.NormalizeServer(Server)?.Host ?? Server;

    bool CanLogin() => !IsWorking && Email.Trim().Length > 0 && Password.Length > 0;

    [RelayCommand(CanExecute = nameof(CanLogin))]
    async Task LoginAsync()
    {
        Error = null;
        if (AppServices.NormalizeServer(Server) is null)
        {
            Error = "A szerver címe nem érvényes (például: fully.example.hu).";
            ShowServer = true;
            return;
        }
        IsWorking = true;
        try
        {
            Shell.Services.UseServer(Server);
            var api = Shell.Services.Api;
            await api.PostAsync<LoginResult>("api/auth/login", new { email = Email.Trim(), password = Password });
            Shell.Services.Settings.Email = Email.Trim();
            var me = await api.GetAsync<Me>("api/me");
            Password = "";
            await Shell.SignedInAsync(me);
        }
        catch (ApiException e)
        {
            Error = e.Message;
            if (e.IsOffline) ShowServer = true;
        }
        finally
        {
            IsWorking = false;
        }
    }

    [RelayCommand]
    void ToggleServer() => ShowServer = !ShowServer;

    partial void OnServerChanged(string value) => OnPropertyChanged(nameof(ServerHost));
}
