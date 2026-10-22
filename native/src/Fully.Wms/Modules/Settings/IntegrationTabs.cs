using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

static class IntegrationForm
{
    // Developer-only settings (api_base_url points an adapter at a fake server) are never shown.
    static readonly HashSet<string> Hidden = ["api_base_url"];

    public static List<PlatformInput> Credentials(IEnumerable<PlatformField> defs, Dictionary<string, JsonElement>? masked) =>
        defs.Where((f) => !Hidden.Contains(f.Key)).Select((f) => PlatformInput.Credential(f, masked?.GetValueOrDefault(f.Key))).ToList();

    public static List<PlatformInput> Settings(IEnumerable<PlatformField> defs, Dictionary<string, JsonElement>? values) =>
        defs.Where((f) => !Hidden.Contains(f.Key))
            .Select((f) => PlatformInput.Setting(f, values is not null && values.TryGetValue(f.Key, out var v) ? v : f.Default)).ToList();

    // Only the credentials typed in: an empty field keeps the stored value.
    public static Dictionary<string, object?> CredentialValues(IEnumerable<PlatformInput> inputs) =>
        inputs.Where((c) => c.Text.Trim().Length > 0 || c.Choice?.Key is not null)
            .ToDictionary((c) => c.Key, (c) => (object?)(c.IsSelect ? c.Choice!.Key : c.Text));

    public static Dictionary<string, object?> SettingValues(IEnumerable<PlatformInput> inputs) =>
        inputs.ToDictionary((s) => s.Key, (s) => s.IsNumber && s.Text.Trim().Length > 0 && Fmt.ParseNumber(s.Text) is { } n ? n : s.SettingValue);

    // The server's field errors ("credentials.password") under the fields.
    public static void ShowErrors(Dictionary<string, string> errors, IEnumerable<PlatformInput> credentials, IEnumerable<PlatformInput> settings)
    {
        foreach (var c in credentials) c.Error = errors.GetValueOrDefault($"credentials.{c.Key}");
        foreach (var s in settings) s.Error = errors.GetValueOrDefault($"settings.{s.Key}");
    }
}

// Futárszolgálatok: our own courier accounts; labels and tracking work with these.
public sealed partial class CouriersTab(SettingsViewModel page) : SettingsTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(NoCouriers))]
    public partial IReadOnlyList<CourierCard> Cards { get; set; } = [];

    public bool NoCouriers => Cards.Count == 0;
    internal List<PartnerLookup> Carriers { get; private set; } = [];

    public override async Task LoadAsync()
    {
        var d = await Api.GetAsync<CourierList>("api/settings/couriers");
        Carriers = d.Carriers;
        Cards = d.Items.Select((c) => new CourierCard(this, c)).ToList();
    }

    internal Task EditAsync(CourierAccount c) => Shell.NavigateAsync(new CourierFormViewModel(Shell, c, Carriers, ReadOnly));

    internal Task TestAsync(CourierAccount c) => Page.RunAsync(async () =>
    {
        var res = await Api.PostAsync<ConnectionTest>($"api/settings/couriers/{c.Code}/test");
        Shell.Toast($"{c.Name}: {res.Message}", res.Ok ? ToastKind.Success : ToastKind.Error);
        await LoadAsync();
    });

    internal async Task ClearAsync(CourierAccount c)
    {
        if (!await Shell.ConfirmAsync("Hozzáférés törlése",
            $"A(z) {c.Name} tárolt hozzáférési adatait töröljük és a fiókot kikapcsoljuk. Utána újra meg kell adnod őket. Folytatod?", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/settings/couriers/{c.Code}/credentials");
            Shell.Toast($"{c.Name}: a hozzáférési adatok törölve, add meg újra őket.", ToastKind.Success);
            await LoadAsync();
        });
    }
}

public sealed class CourierCard(CouriersTab tab, CourierAccount c)
{
    static readonly (string Key, string Label)[] FeatureNames =
        [("tracking", "Nyomkövetés"), ("cod", "Utánvét"), ("pickupPoints", "Csomagpont, automata"), ("testMode", "Teszt rendszer")];

    public CourierAccount Account { get; } = c;
    public string StateText => Account.Active ? "Aktív" : Account.Configured ? "Kikapcsolva" : "Nincs beállítva";
    public bool IsActive => Account.Active;
    public bool IsOff => !Account.Active && Account.Configured;
    public bool IsNew => !Account.Configured;
    public string CarrierText => Account.CarrierId is { } id ? tab.Carriers.FirstOrDefault((p) => p.Id == id)?.Name ?? "" : "nincs összekapcsolva";
    public bool NoCarrier => Account.CarrierId is null;
    public string AccessText => Account.Credentials?.Values.Any((v) => v.ValueKind == JsonValueKind.String && v.GetString()!.Length > 0) == true ? "megadva" : "nincs megadva";
    public string SavedText => Account.UpdatedAt is { } t ? Fmt.DateTime(t) : "soha";
    public IReadOnlyList<string> Features => FeatureNames.Select((f) => $"{(Account.Features?.GetValueOrDefault(f.Key) == true ? "✓" : "✗")} {f.Label}")
        .Concat(Account.Features?.GetValueOrDefault("closeRequired") == true ? ["! Napi zárás kötelező"] : []).ToList();
    public bool CanEdit => tab.CanEdit;
    public bool CanTest => tab.CanEdit && Account.Configured;
    public bool CanClear => tab.CanEdit && !string.IsNullOrEmpty(Account.Error);
    public string EditText => tab.CanEdit ? "Beállítás" : "Megtekintés";
    public RelayCommand EditCommand => new(() => _ = tab.EditAsync(Account));
    public RelayCommand TestCommand => new(() => _ = tab.TestAsync(Account));
    public RelayCommand ClearCommand => new(() => _ = tab.ClearAsync(Account));
}

// A courier account: active, its carrier partner, the adapter's credential and setting fields.
public sealed partial class CourierFormViewModel : PartnerForm
{
    public CourierFormViewModel(ShellViewModel shell, CourierAccount account, IEnumerable<PartnerLookup> carriers, bool readOnly) : base(shell)
    {
        Account = account;
        ReadOnly = readOnly;
        Carriers = [new(null, "Nincs összekapcsolva"), .. carriers.Where((p) => p.CarrierCode == account.Code)
            .Select((p) => new OrderChoice(p.Id.ToString(), $"{p.Name}{(p.Status == "active" ? "" : " (inaktív)")}"))];
        Carrier = Carriers.FirstOrDefault((p) => p.Key == account.CarrierId?.ToString()) ?? Carriers[0];
        Active = account.Active;
        Credentials = IntegrationForm.Credentials(account.CredentialFields, account.Credentials);
        Settings = IntegrationForm.Settings(account.SettingFields, account.Settings);
    }

    public CourierAccount Account { get; }
    public bool ReadOnly { get; }
    public bool CanSave => !ReadOnly;
    public bool CanEditFields => !ReadOnly;
    public override string Title => $"{Account.Name} beállításai";
    public override string? Module => "settings";
    public override double DialogWidth => 780;
    public IReadOnlyList<OrderChoice> Carriers { get; }
    public string CarrierHint => Carriers.Count > 1 ? "A rendeléseken ez a partner jelenik meg fuvarozóként."
        : $"Nincs {Account.Name} kódú fuvarozó partner. A Partnerek között veheted fel.";
    public IReadOnlyList<PlatformInput> Credentials { get; }
    public IReadOnlyList<PlatformInput> Settings { get; }
    public bool HasCredentials => Credentials.Count > 0;
    public bool HasSettings => Settings.Count > 0;

    [ObservableProperty] public partial bool Active { get; set; }
    [ObservableProperty] public partial OrderChoice Carrier { get; set; }

    protected override void ShowErrors(Dictionary<string, string> errors) => IntegrationForm.ShowErrors(errors, Credentials, Settings);

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        await Api.PutAsync<CourierAccount>($"api/settings/couriers/{Account.Code}", new Dictionary<string, object?>
        {
            ["active"] = Active, ["carrier_id"] = Carrier.Key is { } c ? int.Parse(c) : null,
            ["credentials"] = IntegrationForm.CredentialValues(Credentials), ["settings"] = IntegrationForm.SettingValues(Settings),
        });
        Shell.Toast($"{Account.Name} beállításai mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// Számlázó: the invoicing service the approved statements are invoiced with.
public sealed partial class InvoicingTab(SettingsViewModel page) : SettingsTab(page)
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ServerError), nameof(CanClear))]
    public partial InvoicingSettings? Data { get; set; }

    [ObservableProperty] public partial IReadOnlyList<ProviderChoice> Choices { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Manual), nameof(NotInstalled), nameof(NotInstalledText), nameof(HasFields), nameof(CanTest))]
    public partial string Chosen { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCredentials))]
    public partial IReadOnlyList<PlatformInput> Credentials { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSettings))]
    public partial IReadOnlyList<PlatformInput> Settings { get; set; } = [];

    public string? ServerError => Data?.Error is { Length: > 0 } e ? e : null;
    public bool CanClear => ServerError is not null && CanEdit;
    public bool Manual => Chosen.Length == 0;
    InvoicingProvider? Provider => Data?.Providers.FirstOrDefault((p) => p.Code == Chosen);
    public bool NotInstalled => Chosen.Length > 0 && Provider is null;
    public string NotInstalledText => $"A(z) {Data?.Choices.FirstOrDefault((c) => c.Value == Chosen)?.Label ?? Chosen} csatlakozás még nincs telepítve ebben a verzióban. A választásodat elmentjük, a hozzáférési adatokat a telepítés után adhatod meg.";
    public bool HasFields => Provider is not null;
    public bool HasCredentials => Credentials.Count > 0;
    public bool HasSettings => Settings.Count > 0;
    public bool CanTest => CanEdit && Chosen.Length > 0;
    public bool CanEditFields => CanEdit;

    public override async Task LoadAsync() => Show(await Api.GetAsync<InvoicingSettings>("api/settings/invoicing"));

    void Show(InvoicingSettings d)
    {
        Data = d;
        Choices = d.Choices.Select((c) => new ProviderChoice(this, c.Value, c.Label, c.Value == d.Provider)).ToList();
        Choose(d.Provider);
        Errors = [];
    }

    internal void Choose(string code)
    {
        Chosen = code;
        foreach (var c in Choices) c.Show(c.Code == code);
        var p = Provider;
        Credentials = p is null ? [] : IntegrationForm.Credentials(p.CredentialFields, p.Credentials);
        Settings = p is null ? [] : IntegrationForm.Settings(p.SettingFields, p.Settings);
    }

    protected override void ShowErrors(Dictionary<string, string> errors) => IntegrationForm.ShowErrors(errors, Credentials, Settings);

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        var body = new Dictionary<string, object?>
        {
            ["provider"] = Chosen, ["settings"] = new Dictionary<string, object?>(), ["credentials"] = new Dictionary<string, object?>(),
        };
        if (Provider is not null)
        {
            body["settings"] = new Dictionary<string, object?> { [Chosen] = IntegrationForm.SettingValues(Settings) };
            body["credentials"] = new Dictionary<string, object?> { [Chosen] = IntegrationForm.CredentialValues(Credentials) };
        }
        Show(await Api.PutAsync<InvoicingSettings>("api/settings/invoicing", body));
        Shell.Toast("Számlázó beállítások mentve.", ToastKind.Success);
    });

    [RelayCommand]
    Task TestAsync() => Page.RunAsync(async () =>
    {
        if (Chosen != Data?.Provider)
        {
            Shell.Toast("Előbb mentsd a választott számlázót, utána teszteld.");
            return;
        }
        var res = await Api.PostAsync<ConnectionTest>("api/settings/invoicing/test", new { provider = Chosen });
        Shell.Toast(res.Message, res.Ok ? ToastKind.Success : ToastKind.Error);
    });

    [RelayCommand]
    async Task ClearAsync()
    {
        if (!await Shell.ConfirmAsync("Hozzáférés törlése", "A számlázók tárolt hozzáférési adatait töröljük. Utána újra meg kell adnod őket. Folytatod?", "Törlés", danger: true)) return;
        await Page.RunAsync(async () =>
        {
            Show(await Api.DeleteAsync<InvoicingSettings>("api/settings/invoicing/credentials"));
            Shell.Toast("A számlázó hozzáférési adatai törölve, add meg újra őket.", ToastKind.Success);
        });
    }
}

public sealed partial class ProviderChoice(InvoicingTab tab, string code, string label, bool current) : ObservableObject
{
    public string Code { get; } = code;
    public string Label { get; } = label;
    public bool Current { get; } = current;

    bool on;

    public bool IsChosen
    {
        get => on;
        set
        {
            if (!value || on) return;
            tab.Choose(Code);
        }
    }

    internal void Show(bool value)
    {
        on = value;
        OnPropertyChanged(nameof(IsChosen));
    }
}
