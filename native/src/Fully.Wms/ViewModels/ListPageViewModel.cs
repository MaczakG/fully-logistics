using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;

namespace Fully.Wms.ViewModels;

// A list page of the server's paged lists (GET path?limit=&offset= -> { items, total, counts }):
// search, filters, "Továbbiak" for the next page.
public abstract partial class ListPageViewModel<T>(ShellViewModel shell) : PageViewModel(shell)
{
    protected const int PageSize = 50;

    public ObservableCollection<T> Items { get; } = [];

    [ObservableProperty]
    public partial string Search { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TotalText), nameof(IsEmpty))]
    public partial int Total { get; set; }

    [ObservableProperty]
    public partial bool HasMore { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsEmpty))]
    public partial bool Loaded { get; set; }

    public string TotalText => $"{Fmt.Int(Total)} tétel";
    public bool IsEmpty => Loaded && Total == 0;

    // The list's address and filters, e.g. Query.Build("api/inbound", ("status", Status), ("q", Search)).
    protected abstract string ListPath();

    // One page from the server. Lists whose answer carries more than { items, total, counts }
    // (a summary ...) override this and keep the rest.
    protected virtual async Task<(IReadOnlyList<T> Items, int Total)> FetchAsync(int offset)
    {
        var page = await Api.GetAsync<Paged<T>>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        OnCounts(page.Counts);
        return (page.Items, page.Total);
    }

    // Per status counts of the list (the filter chips), where it has them.
    protected virtual void OnCounts(Dictionary<string, int>? counts) { }

    public override async Task LoadAsync()
    {
        var (items, total) = await FetchAsync(0);
        Items.Clear();
        foreach (var it in items) Items.Add(it);
        Total = total;
        HasMore = Items.Count < Total;
        Loaded = true;
    }

    [RelayCommand]
    Task MoreAsync() => RunAsync(async () =>
    {
        var (items, total) = await FetchAsync(Items.Count);
        foreach (var it in items) Items.Add(it);
        Total = total;
        HasMore = Items.Count < Total && items.Count > 0;
    });

    [RelayCommand]
    Task ApplyAsync() => ReloadAsync();
}
