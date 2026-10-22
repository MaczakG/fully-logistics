using System.Collections.ObjectModel;
using Avalonia.Media;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Services;

namespace Fully.Wms.ViewModels;

// The frame around the pages: who is signed in, the menu, the page stack with Back and Home, short
// messages (toasts) and the confirmation dialog.
//
// Desktop: side menu on the left, the page on the right, in an ordinary window.
// Phone (and narrow windows): no side menu; the home page shows the modules as big tiles, like the
// web app's PDA mode, and the top bar has Back and Home.
public sealed partial class ShellViewModel : ViewModelBase
{
    readonly List<PageViewModel> stack = [];

    public ShellViewModel(AppServices services)
    {
        Services = services;
        services.SessionLost += (_, _) => Dispatcher.UIThread.Post(() => SignedOut("Lejárt a munkamenet, jelentkezz be újra."));
        IsCompact = services.Platform.IsPhone;
    }

    public AppServices Services { get; }
    public bool IsPhone => Services.Platform.IsPhone;

    // The main view, set when it is shown: file pickers and the clipboard are reached through it.
    public Avalonia.Visual? View { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsSignedIn), nameof(ShowSidebar), nameof(UserName), nameof(UserRole))]
    public partial Me? Me { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(CanGoBack), nameof(IsHome), nameof(ShowHomeButton))]
    public partial PageViewModel? Current { get; set; }

    // Narrow layout (phone, or a desktop window made narrow). Set by the main view on resize.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowSidebar), nameof(ShowHomeButton))]
    public partial bool IsCompact { get; set; }

    [ObservableProperty]
    public partial DialogViewModel? Dialog { get; set; }

    // Status labels and other lookups of the server (GET /api/meta), loaded after sign-in.
    public MetaInfo Meta { get; private set; } = MetaInfo.Empty;

    // A user action is running (buttons that start one are disabled meanwhile).
    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    public ObservableCollection<ToastViewModel> Toasts { get; } = [];
    public ObservableCollection<MenuGroupViewModel> Menu { get; } = [];

    public bool IsSignedIn => Me is not null;
    public bool ShowSidebar => IsSignedIn && !IsCompact;
    public bool CanGoBack => stack.Count > 1;
    public bool IsHome => Current is HomeViewModel;
    public bool ShowHomeButton => IsCompact && !IsHome;
    public string Title => Current?.Title ?? "";
    public string UserName => Me?.User.Name ?? "";
    public string UserRole => Me is null ? "" : $"{Me.User.Role.Name} · {Me.Company.Name}";

    // A page's title can change once its data has arrived (a product page shows the SKU).
    partial void OnCurrentChanged(PageViewModel? oldValue, PageViewModel? newValue)
    {
        if (oldValue is not null) oldValue.PropertyChanged -= OnPagePropertyChanged;
        if (newValue is not null) newValue.PropertyChanged += OnPagePropertyChanged;
    }

    void OnPagePropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(PageViewModel.Title) or null) OnPropertyChanged(nameof(Title));
    }

    partial void OnIsCompactChanged(bool value)
    {
        foreach (var p in stack) p.OnCompactChanged();
    }

    // ------------------------------------------------------------------ start, sign in, sign out

    // Signs in with the remembered session if there is one, else shows the login page.
    public async Task StartAsync()
    {
        if (string.IsNullOrEmpty(Services.Api.SessionToken))
        {
            ShowLogin(null);
            return;
        }
        try
        {
            var me = await Services.Api.GetAsync<Me>("api/me");
            await SignedInAsync(me);
        }
        catch (ApiException e)
        {
            ShowLogin(e.Status == 401 ? null : e.Message);
        }
    }

    void ShowLogin(string? message)
    {
        Me = null;
        Menu.Clear();
        stack.Clear();
        var login = new LoginViewModel(this) { Error = message };
        stack.Add(login);
        Current = login;
    }

    public async Task SignedInAsync(Me me)
    {
        Me = me;
        Services.SaveSettings();
        try
        {
            Meta = await Services.Api.GetAsync<MetaInfo>("api/meta");
        }
        catch (ApiException) when (Meta != MetaInfo.Empty)
        {
            // Keep the lookups of the previous sign-in.
        }
        App.Meta = Meta;
        BuildMenu();
        stack.Clear();
        if (me.User.MustChangePassword)
        {
            var change = new ChangePasswordViewModel(this, forced: true);
            stack.Add(change);
            Current = change;
            return;
        }
        var home = new HomeViewModel(this);
        stack.Add(home);
        Current = home;
        await home.ReloadAsync();
    }

    public void SignedOut(string? message)
    {
        if (!IsSignedIn && Current is LoginViewModel) return;
        Services.Api.SessionToken = null;
        Services.SaveSettings();
        ShowLogin(null);
        if (message is not null) Toast(message, ToastKind.Warning);
    }

    [RelayCommand]
    async Task LogoutAsync()
    {
        try
        {
            await Services.Api.PostAsync("api/auth/logout");
        }
        catch (ApiException)
        {
            // Signed out here either way; the server forgets the session when it expires.
        }
        SignedOut(null);
    }

    // ------------------------------------------------------------------ menu

    void BuildMenu()
    {
        Menu.Clear();
        if (Me is null) return;
        var visible = AppModules.All.Where((m) => Me.Can(m.Key) && (!IsPhone || m.OnPhone));
        foreach (var g in visible.GroupBy((m) => m.Group))
            Menu.Add(new MenuGroupViewModel(g.Key, g.Select((m) => new MenuItemViewModel(this, m)).ToList()));
    }

    public IEnumerable<MenuItemViewModel> MenuItems => Menu.SelectMany((g) => g.Items);

    // Fills the badges of the menu and the home tiles (GET /api/home).
    public void ApplyCounts(HomeCounts counts)
    {
        foreach (var item in MenuItems) item.Apply(counts);
    }

    // ------------------------------------------------------------------ navigation

    [RelayCommand]
    public async Task OpenModuleAsync(string key)
    {
        var def = AppModules.Find(key);
        if (def is null || Me is null || !Me.Can(key)) return;
        while (stack.Count > 1) stack.RemoveAt(stack.Count - 1);
        await ShowAsync(def.Open(this));
    }

    public Task NavigateAsync(PageViewModel page) => ShowAsync(page);

    // Another page in place of the current one (the tabs of a module): Back goes where it went.
    public async Task ReplaceAsync(PageViewModel page)
    {
        if (stack.Count > 1) stack.RemoveAt(stack.Count - 1);
        await ShowAsync(page);
    }

    async Task ShowAsync(PageViewModel page)
    {
        stack.Add(page);
        Current = page;
        UpdateActive();
        await page.ReloadAsync();
    }

    [RelayCommand]
    public async Task BackAsync()
    {
        if (stack.Count <= 1) return;
        stack.RemoveAt(stack.Count - 1);
        Current = stack[^1];
        UpdateActive();
        await Current.ReloadAsync();
    }

    [RelayCommand]
    public async Task HomeAsync()
    {
        if (!IsSignedIn || stack.Count == 0) return;
        while (stack.Count > 1) stack.RemoveAt(stack.Count - 1);
        Current = stack[0];
        UpdateActive();
        await Current.ReloadAsync();
    }

    [RelayCommand]
    Task RetryAsync() => Current?.ReloadAsync() ?? Task.CompletedTask;

    [RelayCommand]
    Task OpenProfileAsync()
    {
        if (Current is ProfileViewModel) return Task.CompletedTask;
        while (stack.Count > 1) stack.RemoveAt(stack.Count - 1);
        return ShowAsync(new ProfileViewModel(this));
    }

    void UpdateActive()
    {
        var module = Current?.Module;
        foreach (var item in MenuItems) item.IsActive = item.Key == module;
        OnPropertyChanged(nameof(CanGoBack));
    }

    // ------------------------------------------------------------------ actions, messages, dialogs

    // Runs a user action: one at a time, server errors become a red toast. Answers whether it ran
    // without an error.
    public async Task<bool> RunAsync(Func<Task> action, PageViewModel? page = null)
    {
        if (IsBusy) return false;
        IsBusy = true;
        try
        {
            await action();
            return true;
        }
        catch (ApiException e) when (e.Code == "password_change_required")
        {
            await NavigateAsync(new ChangePasswordViewModel(this, forced: true));
            return false;
        }
        catch (ApiException e) when (e.Status != 401)
        {
            Toast(e.Message, ToastKind.Error);
            return false;
        }
        catch (ApiException)
        {
            return false;
        }
        finally
        {
            IsBusy = false;
        }
    }

    public void Toast(string message, ToastKind kind = ToastKind.Info)
    {
        var toast = new ToastViewModel(message, kind);
        Toasts.Add(toast);
        while (Toasts.Count > 3) Toasts.RemoveAt(0);
        DispatcherTimer.RunOnce(() => Toasts.Remove(toast), TimeSpan.FromSeconds(kind == ToastKind.Error ? 7 : 4));
    }

    // A question with two buttons; answers true for the first.
    public async Task<bool> ConfirmAsync(string title, string message, string ok = "Rendben", string cancel = "Mégse", bool danger = false)
    {
        var dialog = new DialogViewModel(title, message, ok, cancel, danger);
        Dialog = dialog;
        try
        {
            return await dialog.Result;
        }
        finally
        {
            if (Dialog == dialog) Dialog = null;
        }
    }
}

public sealed record MenuGroupViewModel(string Title, IReadOnlyList<MenuItemViewModel> Items);

public sealed partial class MenuItemViewModel(ShellViewModel shell, ModuleDef def) : ViewModelBase
{
    public string Key => def.Key;
    public string Label => def.Label;
    public Geometry? Icon => App.Icon(def.Icon);
    public ShellViewModel Shell => shell;

    // The tile's second line: the work waiting, else the module's description.
    [ObservableProperty]
    public partial string Meta { get; set; } = def.Hint;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasBadge), nameof(BadgeText))]
    public partial int Badge { get; set; }

    [ObservableProperty]
    public partial bool IsActive { get; set; }

    public bool HasBadge => Badge > 0;
    public string BadgeText => Fmt.Int(Badge);
    public bool IsBusy => Badge > 0;

    // The same counts and wording as the web app's tiles (app.js TILE_COUNTS).
    public void Apply(HomeCounts c)
    {
        if (!c.Has(Key)) return;
        (int n, string?[] text) = Key switch
        {
            "inbound" => (c.Get(Key, "open"), new[] { Part(c.Get(Key, "active"), "átvételre vár"), Part(c.Get(Key, "open") - c.Get(Key, "active"), "várható") }),
            "orders" => (c.Get(Key, "new"), new[] { Part(c.Get(Key, "new"), "új"), Part(c.Get(Key, "hold"), "felfüggesztve") }),
            "picking" => (c.Get(Key, "active") + c.Get(Key, "picked"), new[] { Part(c.Get(Key, "active"), "hullám kiszedésre"), Part(c.Get(Key, "picked"), "csomagolásra") }),
            "counts" => (c.Get(Key, "open"), new[] { Part(c.Get(Key, "open"), "nyitott leltár") }),
            "transport" => (c.Get(Key, "today"), new[] { Part(c.Get(Key, "today"), "futárátvétel ma") }),
            _ => (0, Array.Empty<string?>()),
        };
        Badge = n;
        var meta = string.Join(", ", text.Where((t) => t is not null));
        Meta = meta.Length > 0 ? meta : "Nincs teendő";
        OnPropertyChanged(nameof(IsBusy));
    }

    static string? Part(int n, string what) => n > 0 ? $"{Fmt.Int(n)} {what}" : null;

    [RelayCommand]
    Task OpenAsync() => shell.OpenModuleAsync(Key);
}

public enum ToastKind { Info, Success, Warning, Error }

public sealed class ToastViewModel(string message, ToastKind kind)
{
    public string Message { get; } = message;
    public ToastKind Kind { get; } = kind;
    public bool IsError => Kind == ToastKind.Error;
    public bool IsSuccess => Kind == ToastKind.Success;
    public bool IsWarning => Kind == ToastKind.Warning;
}

public sealed partial class DialogViewModel(string title, string message, string ok, string cancel, bool danger) : ViewModelBase
{
    readonly TaskCompletionSource<bool> result = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public string Title { get; } = title;
    public string Message { get; } = message;
    public string OkText { get; } = ok;
    public string CancelText { get; } = cancel;
    public bool IsDanger { get; } = danger;
    public Task<bool> Result => result.Task;

    [RelayCommand]
    void Ok() => result.TrySetResult(true);

    [RelayCommand]
    void Cancel() => result.TrySetResult(false);
}
