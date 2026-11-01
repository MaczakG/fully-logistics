using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Picking;

// GET /api/picking/waves: the waves by status with key figures; new wave, packing station.
public sealed partial class WavesViewModel(ShellViewModel shell) : ListPageViewModel<WaveRow>(shell)
{
    public override string Title => "Komissió";
    public override string? Module => "picking";

    static readonly (string Key, string Label)[] Tabs = [("active", "Aktív"), ("completed", "Lezárt"), ("cancelled", "Megszakított"), ("all", "Összes")];

    public IReadOnlyList<WaveTab> StatusTabs { get; } = Tabs.Select((t) => new WaveTab(t.Key, t.Label)).ToList();

    [ObservableProperty]
    public partial WaveTab? SelectedTab { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(OpenCount), nameof(PickingCount), nameof(PickedCount))]
    public partial Dictionary<string, int> Counts { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PackingText), nameof(HasReady))]
    public partial int ReadyToPack { get; set; }

    [ObservableProperty]
    public partial WaveRow? Selected { get; set; }

    public int OpenCount => Counts.GetValueOrDefault("open");
    public int PickingCount => Counts.GetValueOrDefault("picking");
    public int PickedCount => Counts.GetValueOrDefault("picked");
    public bool HasReady => ReadyToPack > 0;
    public string PackingText => ReadyToPack > 0 ? $"Csomagolóállomás ({Fmt.Int(ReadyToPack)})" : "Csomagolóállomás";
    public bool CanCreate => Shell.Me?.Can("picking", "create") == true;
    public string Status => SelectedTab?.Key ?? "active";
    public string EmptyText => Status == "active" ? "Nincs aktív hullám. Indíts egyet az Új hullám gombbal." : "Nincs ilyen hullám.";

    partial void OnSelectedTabChanged(WaveTab? value)
    {
        foreach (var t in StatusTabs) t.IsSelected = t == value;
        OnPropertyChanged(nameof(EmptyText));
        if (value is not null && Loaded) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(WaveRow? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new WaveViewModel(Shell, value.Id));
    }

    protected override string ListPath() => Query.Build("api/picking/waves", ("status", Status));

    protected override async Task<(IReadOnlyList<WaveRow> Items, int Total)> FetchAsync(int offset)
    {
        SelectedTab ??= StatusTabs[0];
        var page = await Api.GetAsync<WavesPage>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        Counts = page.Counts;
        ReadyToPack = page.ReadyToPack;
        foreach (var t in StatusTabs)
        {
            t.Count = t.Key switch
            {
                "active" => OpenCount + PickingCount + PickedCount,
                "all" => null,
                _ => page.Counts.GetValueOrDefault(t.Key),
            };
        }
        return (page.Items, page.Total);
    }

    [RelayCommand]
    void SelectTab(WaveTab tab) => SelectedTab = tab;

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new NewWaveViewModel(Shell));

    [RelayCommand]
    Task PackingAsync() => PackingViewModel.OpenAsync(Shell, null, null);
}

// A status tab with its count ("Összes" has none).
public sealed partial class WaveTab(string key, string label) : ObservableObject
{
    public string Key { get; } = key;
    public string Label { get; } = label;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Text))]
    public partial int? Count { get; set; }

    [ObservableProperty]
    public partial bool IsSelected { get; set; }

    public string Text => Count is { } n ? $"{Label} {Fmt.Int(n)}" : Label;
}
