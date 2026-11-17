using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Quotes;

// Ajánlatkészítő: the saved quotes (search, status), newest change first; a quote opens in its own
// window, a new one starts from the default tariffs.
public sealed partial class QuotesViewModel(ShellViewModel shell) : ListPageViewModel<QuoteRowItem>(shell)
{
    public override string Title => "Ajánlatkészítő";
    public override string? Module => "quotes";

    public IReadOnlyList<OrderChoice> Statuses { get; } =
        [new(null, "Mind"), .. shell.Meta.Statuses.GetValueOrDefault("quote")?.Select((s) => new OrderChoice(s.Key, s.Value.Label)) ?? []];

    [ObservableProperty] public partial OrderChoice? Status { get; set; }
    [ObservableProperty] public partial QuoteRowItem? Selected { get; set; }

    public bool CanCreate => Shell.Me?.Can("quotes", "create") == true;
    public bool CalculatorOnly => !CanCreate;
    public string EmptyText => Search.Trim().Length > 0 || Status?.Key is not null ? "Nincs a szűrésnek megfelelő ajánlat." : "Még nincs mentett ajánlat.";

    partial void OnStatusChanged(OrderChoice? value)
    {
        OnPropertyChanged(nameof(EmptyText));
        if (Loaded) _ = ReloadAsync();
    }

    partial void OnSelectedChanged(QuoteRowItem? value)
    {
        if (value is null) return;
        Selected = null;
        _ = Shell.NavigateAsync(new QuoteViewModel(Shell, value.Row.Id));
    }

    public override Task LoadAsync()
    {
        Status ??= Statuses[0];
        return base.LoadAsync();
    }

    protected override string ListPath() => Query.Build("api/quotes", ("q", Search.Trim()), ("status", Status?.Key));

    protected override async Task<(IReadOnlyList<QuoteRowItem> Items, int Total)> FetchAsync(int offset)
    {
        var page = await Api.GetAsync<Paged<QuoteRow>>(Query.Build(ListPath(), ("limit", PageSize), ("offset", offset)));
        OnPropertyChanged(nameof(EmptyText));
        return (page.Items.Select((r) => new QuoteRowItem(r)).ToList(), page.Total);
    }

    [RelayCommand]
    Task NewAsync() => Shell.NavigateAsync(new QuoteViewModel(Shell, null));
}

public sealed class QuoteRowItem(QuoteRow r)
{
    public QuoteRow Row { get; } = r;
    public string ClientText => Row.ClientName is { Length: > 0 } c ? c : Row.PartnerName ?? "Névtelen ügyfél";
    public string PartnerText => Row.PartnerId is null ? "" : $"Partner: {Row.PartnerName} ({Row.PartnerCode})";
    public string NetText => Fmt.Money(Row.MonthlyNet);
    public string UpdatedText => Fmt.DateTime(Row.UpdatedAt);
}
