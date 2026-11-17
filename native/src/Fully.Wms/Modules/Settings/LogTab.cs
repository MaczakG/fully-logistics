using System.Collections.ObjectModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// Napló: who did what and when (every create, change, delete and approval), and the calls to and
// from outside systems (webshops, couriers, invoicing, the partner API) for troubleshooting.
public sealed partial class LogTab(SettingsViewModel page) : SettingsTab(page)
{
    const int PageSize = 50;

    public static readonly Dictionary<string, string> ActionLabels = new()
    {
        ["create"] = "Létrehozás", ["edit"] = "Módosítás", ["delete"] = "Törlés", ["approve"] = "Jóváhagyás", ["login"] = "Bejelentkezés", ["view"] = "Megtekintés",
    };

    public static readonly Dictionary<string, string> EntityLabels = new()
    {
        ["settings"] = "Beállítás", ["location"] = "Raktárhely", ["location_size"] = "Raktárhely méret", ["courier_account"] = "Futárfiók",
        ["user"] = "Felhasználó", ["role"] = "Szerepkör", ["order"] = "Rendelés", ["inbound"] = "Betárolás", ["wave"] = "Komissiós hullám",
        ["count"] = "Leltár", ["product"] = "Cikk", ["partner"] = "Partner", ["quote"] = "Ajánlat", ["statement"] = "Elszámolás", ["transport"] = "Fuvar",
        ["pickup"] = "Futárátvétel", ["return"] = "Visszáru", ["api_key"] = "API kulcs", ["webshop"] = "Webshop kapcsolat", ["document"] = "Dokumentum",
    };

    public static readonly IReadOnlyList<OrderChoice> Results = [new(null, "Mind"), new("1", "Sikeres"), new("0", "Hibás")];
    public static readonly IReadOnlyList<OrderChoice> Directions = [new(null, "Mind"), new("out", "Kimenő (mi hívtuk)"), new("in", "Bejövő (minket hívtak)")];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAudit), nameof(IsIntegration))]
    public partial string Kind { get; set; } = "audit";

    public bool IsAudit => Kind == "audit";
    public bool IsIntegration => Kind == "integration";

    public ObservableCollection<AuditItem> Audit { get; } = [];
    public ObservableCollection<IntegrationItem> Calls { get; } = [];

    [ObservableProperty] public partial int Total { get; set; }
    [ObservableProperty] public partial bool HasMore { get; set; }
    [ObservableProperty] public partial string Search { get; set; } = "";
    [ObservableProperty] public partial List<OrderChoice> Modules { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? ModuleFilter { get; set; }
    [ObservableProperty] public partial List<OrderChoice> Users { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? UserFilter { get; set; }
    [ObservableProperty] public partial List<OrderChoice> Entities { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? EntityFilter { get; set; }
    [ObservableProperty] public partial List<OrderChoice> Systems { get; set; } = [];
    [ObservableProperty] public partial OrderChoice? SystemFilter { get; set; }
    [ObservableProperty] public partial OrderChoice Result { get; set; } = Results[0];
    [ObservableProperty] public partial OrderChoice Direction { get; set; } = Directions[0];
    [ObservableProperty] public partial DateTime? From { get; set; }
    [ObservableProperty] public partial DateTime? To { get; set; }
    [ObservableProperty] public partial AuditItem? Selected { get; set; }

    public string TotalText => $"{Fmt.Int(Total)} bejegyzés";
    public bool IsEmpty => Total == 0;
    public string EmptyText => Search.Trim().Length > 0 || From is not null || To is not null ? "Nincs a szűrésnek megfelelő bejegyzés." : "Még nincs bejegyzés.";

    bool quiet;

    partial void OnModuleFilterChanged(OrderChoice? value) => Filter();
    partial void OnUserFilterChanged(OrderChoice? value) => Filter();
    partial void OnEntityFilterChanged(OrderChoice? value) => Filter();
    partial void OnSystemFilterChanged(OrderChoice? value) => Filter();
    partial void OnResultChanged(OrderChoice value) => Filter();
    partial void OnDirectionChanged(OrderChoice value) => Filter();
    partial void OnFromChanged(DateTime? value) => Filter();
    partial void OnToChanged(DateTime? value) => Filter();

    void Filter()
    {
        if (!quiet && Modules.Count > 0) _ = Page.RunAsync(() => LoadPageAsync(0));
    }

    partial void OnSelectedChanged(AuditItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new LogEntryViewModel(Shell, value.Row));
    }

    public override async Task LoadAsync()
    {
        if (Modules.Count == 0)
        {
            var f = await Api.GetAsync<AuditFilters>("api/settings/audit/filters");
            quiet = true;
            Modules = [new(null, "Mind"), .. f.Modules.Select((m) => new OrderChoice(m.Key, m.Name))];
            Users = [new(null, "Mind"), .. f.Users.Select((u) => new OrderChoice(u.Id.ToString(), u.Active ? u.Name : $"{u.Name} (letiltva)"))];
            Entities = [new(null, "Mind"), .. f.Entities.Select((e) => new OrderChoice(e, EntityLabels.GetValueOrDefault(e, e)))];
            Systems = [new(null, "Mind"), .. f.Systems.Select((s) => new OrderChoice(s, s))];
            ModuleFilter = Modules[0];
            UserFilter = Users[0];
            EntityFilter = Entities[0];
            SystemFilter = Systems[0];
            quiet = false;
        }
        await LoadPageAsync(0);
    }

    string Filters(string path) => IsAudit
        ? Query.Build(path, ("q", Search.Trim()), ("module", ModuleFilter?.Key), ("user_id", UserFilter?.Key), ("entity", EntityFilter?.Key),
            ("from", From?.ToString("yyyy-MM-dd")), ("to", To?.ToString("yyyy-MM-dd")))
        : Query.Build(path, ("q", Search.Trim()), ("system", SystemFilter?.Key), ("ok", Result.Key), ("direction", Direction.Key),
            ("from", From?.ToString("yyyy-MM-dd")), ("to", To?.ToString("yyyy-MM-dd")));

    async Task LoadPageAsync(int offset)
    {
        if (IsAudit)
        {
            var page = await Api.GetAsync<Paged<AuditRow>>(Query.Build(Filters("api/settings/audit"), ("limit", PageSize), ("offset", offset)));
            if (offset == 0) Audit.Clear();
            foreach (var r in page.Items) Audit.Add(new AuditItem(r));
            Total = page.Total;
            HasMore = Audit.Count < Total;
        }
        else
        {
            var page = await Api.GetAsync<Paged<IntegrationRow>>(Query.Build(Filters("api/settings/integration-log"), ("limit", PageSize), ("offset", offset)));
            if (offset == 0) Calls.Clear();
            foreach (var r in page.Items) Calls.Add(new IntegrationItem(r));
            Total = page.Total;
            HasMore = Calls.Count < Total;
        }
        OnPropertyChanged(nameof(TotalText));
        OnPropertyChanged(nameof(IsEmpty));
        OnPropertyChanged(nameof(EmptyText));
    }

    [RelayCommand]
    Task ShowKindAsync(string kind)
    {
        Kind = kind;
        return Page.RunAsync(() => LoadPageAsync(0));
    }

    [RelayCommand]
    Task ApplyAsync() => Page.RunAsync(() => LoadPageAsync(0));

    [RelayCommand]
    Task MoreAsync() => Page.RunAsync(() => LoadPageAsync(IsAudit ? Audit.Count : Calls.Count));

    [RelayCommand]
    Task ExportAsync() => Page.RunAsync(async () =>
        await Shell.Services.Platform.OpenFileAsync(await Api.DownloadAsync(Filters("api/settings/audit/export"))));

    // Opened from elsewhere (a user's "Teljes napló"): the log of one user.
    internal void ShowUser(int userId)
    {
        quiet = true;
        UserFilter = Users.FirstOrDefault((u) => u.Key == userId.ToString()) ?? UserFilter;
        quiet = false;
    }
}

public sealed class AuditItem(AuditRow r)
{
    public AuditRow Row { get; } = r;
    public string AtText => Fmt.DateTime(Row.At);
    public string ActionText => LogTab.ActionLabels.GetValueOrDefault(Row.Action, Row.Action);
    public string EntityText => Row.Entity is { Length: > 0 } e ? LogTab.EntityLabels.GetValueOrDefault(e, e) : "";
    public bool HasDetails => Row.Details is { ValueKind: JsonValueKind.Object };
}

public sealed class IntegrationItem(IntegrationRow r)
{
    public IntegrationRow Row { get; } = r;
    public string AtText => Fmt.DateTime(Row.At);
    public string DirectionText => Row.Direction == "in" ? "Bejövő" : "Kimenő";
    public string ResultText => (Row.Ok ? "Sikeres" : "Hibás") + (Row.Status is { } s ? $" {s}" : "");
}

// One log entry: who, when, what, and the old and new values of what changed.
public sealed class LogEntryViewModel(ShellViewModel shell, AuditRow row) : PageViewModel(shell)
{
    public AuditRow Row { get; } = row;
    public override string Title => "Napló bejegyzés";
    public override string? Module => "settings";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 760;
    public string AtText => Fmt.DateTime(Row.At);
    public string What => $"{Row.ModuleName ?? Row.Module}, {LogTab.ActionLabels.GetValueOrDefault(Row.Action, Row.Action)}";

    public IReadOnlyList<LogChange> Changes { get; } = ChangesOf(row.Details);
    public bool HasChanges => Changes.Count > 0;
    public string Rest { get; } = RestOf(row.Details);
    public bool HasRest => Rest.Length > 0;

    static IReadOnlyList<LogChange> ChangesOf(JsonElement? details)
    {
        if (details is not { ValueKind: JsonValueKind.Object } d || !d.TryGetProperty("changes", out var c) || c.ValueKind != JsonValueKind.Object) return [];
        return c.EnumerateObject().Where((p) => p.Value.ValueKind == JsonValueKind.Array && p.Value.GetArrayLength() == 2)
            .Select((p) => new LogChange(p.Name, Show(p.Value[0]), Show(p.Value[1]))).ToList();
    }

    static string RestOf(JsonElement? details)
    {
        if (details is not { ValueKind: JsonValueKind.Object } d) return "";
        var rest = d.EnumerateObject().Where((p) => p.Name != "changes" || ChangesOf(details).Count == 0).ToDictionary((p) => p.Name, (p) => p.Value);
        return rest.Count == 0 ? "" : JsonSerializer.Serialize(rest, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    static string Show(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => "üres",
        JsonValueKind.String => v.GetString() is { Length: > 0 } s ? s : "üres",
        _ => v.GetRawText(),
    };
}

public sealed record LogChange(string Field, string Old, string New);
