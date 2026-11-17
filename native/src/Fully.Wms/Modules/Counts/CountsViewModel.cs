using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Counts;

// GET /api/counts: the counts by status and type, search; new count.
public sealed partial class CountsViewModel(ShellViewModel shell) : ListPageViewModel<CountRow>(shell)
{
    public override string Title => "Leltár";
    public override string? Module => "counts";

    static readonly (string Key, string Label)[] Statuses =
    [
        ("active", "Folyamatban"), ("all", "Mind"), ("open", "Nyitott"), ("counting", "Számlálás alatt"),
        ("counted", "Könyvelésre vár"), ("posted", "Könyvelve"), ("cancelled", "Törölve"),
    ];

    public IReadOnlyList<CountTab> StatusTabs { get; } = Statuses.Select((s) => new CountTab(s.Key, s.Label)).ToList();

    public static readonly IReadOnlyList<CountChoice> Types =
    [
        new(null, "Minden típus"), new("cycle", "Ciklikus"), new("zone", "Zóna"), new("product", "Termék"),
        new("full", "Teljes"), new("locations", "Kijelölt helyek"),
    ];

    [ObservableProperty]
    public partial CountTab? SelectedTab { get; set; }

    [ObservableProperty]
    public partial CountChoice? Type { get; set; } = Types[0];

    [ObservableProperty]
    public partial CountRow? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("counts", "create") == true;
    public string Status => SelectedTab?.Key ?? "active";
    public string EmptyText => Status == "active" ? "Nincs folyamatban lévő leltár." : "Nincs a szűrésnek megfelelő leltár.";

    partial void OnSelectedTabChanged(CountTab? value)
    {
        foreach (var t in StatusTabs) t.IsSelected = t == value;
        OnPropertyChanged(nameof(EmptyText));
        if (value is not null && Loaded) _ = ReloadAsync();
    }

    partial void OnTypeChanged(CountChoice? value)
    {
        if (Loaded) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(CountRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new CountViewModel(Shell, value.Id));
    }

    protected override string ListPath()
    {
        SelectedTab ??= StatusTabs[0];
        return Query.Build("api/counts", ("status", Status), ("type", Type?.Key), ("q", Search.Trim()));
    }

    [RelayCommand]
    void SelectTab(CountTab tab) => SelectedTab = tab;

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new NewCountViewModel(Shell));
}

public sealed partial class CountTab(string key, string label) : ObservableObject
{
    public string Key { get; } = key;
    public string Label { get; } = label;

    [ObservableProperty]
    public partial bool IsSelected { get; set; }
}

// A choice of a select; Key null is "all" or "none".
public sealed record CountChoice(string? Key, string Label);
