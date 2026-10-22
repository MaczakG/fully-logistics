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

    // After a page arrived (status counts for the filter chips ...).
    protected virtual void OnPage(Paged<T> page, bool first) { }

    public override async Task LoadAsync()
    {
        var page = await Api.GetAsync<Paged<T>>(Query.Build(ListPath(), ("limit", PageSize), ("offset", 0)));
        Items.Clear();
        foreach (var it in page.Items) Items.Add(it);
        Total = page.Total;
        HasMore = Items.Count < Total;
        Loaded = true;
        OnPage(page, true);
    }

    [RelayCommand]
    Task MoreAsync() => RunAsync(async () =>
    {
        var page = await Api.GetAsync<Paged<T>>(Query.Build(ListPath(), ("limit", PageSize), ("offset", Items.Count)));
        foreach (var it in page.Items) Items.Add(it);
        Total = page.Total;
        HasMore = Items.Count < Total && page.Items.Count > 0;
        OnPage(page, false);
    });

    [RelayCommand]
    Task ApplyAsync() => ReloadAsync();
}
