using System.Text;
using Avalonia.Headless.XUnit;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Partners;
using Fully.Wms.Modules.Quotes;
using Fully.Wms.Services;
using Fully.Wms.ViewModels;
using Fully.Wms.Views;

namespace Fully.Wms.Tests;

// The quote screens: the list; a new quote written with the paper and the internal costing
// following every change, saved, printed, copied and deleted; one started from a client; closing
// with unsaved changes asks first.
[Collection("Quotes")]
public class QuotesUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 150 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    static async Task AnswerAsync(ShellViewModel shell, bool ok = true)
    {
        await WaitAsync(() => shell.Dialog is not null);
        if (ok) shell.Dialog!.OkCommand.Execute(null);
        else shell.Dialog!.CancelCommand.Execute(null);
    }

    static QuoteField Field(IEnumerable<QuoteField> fields, string label) => fields.First((f) => f.Label.StartsWith(label, StringComparison.Ordinal));

    [AvaloniaFact]
    public async Task Desktop_new_quote_saved_printed_copied_deleted()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1500, 1000);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("quotes");
        var list = Assert.IsType<QuotesViewModel>(shell.Current);
        Assert.True(list.CanCreate);
        await list.NewCommand.ExecuteAsync(null);
        var q = Assert.IsType<QuoteViewModel>(shell.Current);
        await WaitAsync(() => q.Paper is not null && q.Costing is not null);
        Assert.Equal("Új ajánlat", q.Title);
        Assert.False(q.Dirty);
        Assert.Equal("draft", q.Status?.Key);
        Assert.Equal("mentéskor kap számot", q.Paper!.Number);
        Assert.Contains("Admin", q.Signer!.Text);

        // The volume: the paper and the costing follow every change.
        Field(q.ClientFields, "Ügyfél (cég) neve").Text = "Teszt Webshop Kft.";
        Field(q.ClientFields, "Webshop").Text = "tesztwebshop.hu";
        Field(q.VolumeFields, "Rendelés / hó").Text = "300";
        Field(q.VolumeFields, "Átl. termék").Text = "1,5";
        Field(q.VolumeFields, "Betárolás / hó").Text = "450";
        Field(q.VolumeFields, "Visszáru arány").Text = "3";
        q.VolumeFields.First((f) => f.Tag == "M").Text = "20";
        q.VolumeFields.First((f) => f.Tag == "L").Text = "15";
        Field(q.VolumeFields, "Beköltözési készlet").Text = "3000";
        Field(q.DiscountFields, "Kedvezmény a rendeléskezelésből").Text = "10";
        Field(q.DiscountFields, "Ingyenes betárolás").Text = "3000";
        Field(q.DiscountFields, "Árgarancia").Text = "12";
        Assert.True(q.Dirty);
        Assert.True(q.HasUnsavedChanges);
        Assert.Equal("Teszt Webshop Kft.", q.Paper!.ClientName);
        Assert.Contains("tesztwebshop.hu", q.Paper.Sub);
        Assert.Contains(q.Paper.Lines, (l) => l.IsDiscount && l.Name.Contains("10%"));
        Assert.Contains(q.Paper.Lines, (l) => l.IsGroup && l.Name == "Tárolás");
        Assert.StartsWith("Az ajánlott díjakat a szerződéskötéstől számított 12 hónapig", q.Paper.Terms[0]);
        Assert.True(q.Paper.HasOneOff);
        Assert.Equal(7, q.Costing!.Kpis.Count);
        Assert.Contains(q.Costing.Sizes, (s) => s.Tag == "M");

        // An own item.
        q.AddItemCommand.Execute(null);
        var item = Assert.Single(q.CustomItems);
        item.Name.Text = "Raklapfóliázás";
        item.Unit.Text = "raklap";
        item.Price.Text = "1500";
        item.Qty.Text = "6";
        Assert.Contains(q.Paper.Lines, (l) => l.Name == "Raklapfóliázás" && l.SumText == QuoteFormat.Ft(9000));
        Screens.Save(window, "quote-new");
        window.Height = 3000;
        Screens.Save(window, "quote-new-full");
        window.Height = 1000;

        // Saved: a number, the server's monthly net is the one on the paper.
        Assert.True(await q.SaveAsync());
        Assert.StartsWith("AJ", q.Number);
        Assert.False(q.Dirty);
        Assert.Equal($"Ajánlat {q.Number}", q.Title);
        Assert.Equal(q.Number, q.Paper.Number);
        using var api = await LiveServer.SignInAsync(LiveServer.Admin);
        var saved = await api.GetAsync<QuoteDetail>($"api/quotes/{q.Id}", Ct);
        Assert.Equal(q.Paper.NetText, Fmt.Money(saved.MonthlyNet));
        Assert.Equal("Raklapfóliázás", Assert.Single(saved.Data.CustomItems).Name);

        // Sent and printed: the change is saved first, the page opens in the browser.
        q.Status = q.StatusChoices.Single((s) => s.Key == "sent");
        Assert.True(q.Dirty);
        await q.PrintCommand.ExecuteAsync(null);
        Assert.False(q.Dirty);
        var page = Assert.Single(Assert.IsType<TestPlatform>(shell.Services.Platform).Opened);
        Assert.Equal($"arajanlat-{q.Number}.html", page.FileName);
        var html = Encoding.UTF8.GetString(page.Bytes);
        Assert.Contains("Fulfillment árajánlat", html);
        Assert.Contains("Teszt Webshop Kft.", html);
        Assert.DoesNotContain("Belső", html);
        Assert.Equal("sent", (await api.GetAsync<QuoteDetail>($"api/quotes/{q.Id}", Ct)).Status);

        // Copied: a new draft in front; both deleted.
        var number = q.Number;
        await q.DuplicateCommand.ExecuteAsync(null);
        var copy = Assert.IsType<QuoteViewModel>(shell.Current);
        await WaitAsync(() => copy.Paper is not null);
        Assert.NotEqual(number, copy.Number);
        Assert.Equal("draft", copy.Status?.Key);
        Assert.Equal("Teszt Webshop Kft.", copy.Paper!.ClientName);
        var deleting = copy.DeleteCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await deleting;
        Assert.Same(q, shell.Current);
        deleting = q.DeleteCommand.ExecuteAsync(null);
        await AnswerAsync(shell);
        await deleting;
        Assert.Same(list, shell.Current);
        await WaitAsync(() => !list.IsLoading && list.Loaded);
        Assert.DoesNotContain(list.Items, (r) => r.Row.Number == number);
        Screens.Save(window, "quotes-list");
    }

    [AvaloniaFact]
    public async Task Desktop_quote_for_a_client_and_unsaved_changes()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1500, 1000);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("partners");
        await shell.NavigateAsync(new PartnerViewModel(shell, 1));
        var partner = Assert.IsType<PartnerViewModel>(shell.Current);
        await WaitAsync(() => partner.Data is not null);
        Assert.True(partner.CanQuote);
        await partner.QuoteCommand.ExecuteAsync(null);
        var q = Assert.IsType<QuoteViewModel>(shell.Current);
        await WaitAsync(() => q.Paper is not null);
        Assert.Equal(partner.Data!.Name, q.Paper!.ClientName);
        Assert.Equal("1", q.Partner?.Key);
        Assert.Contains(partner.Data.Name, q.TariffSource);
        Assert.False(q.Dirty);
        Screens.Save(window, "quote-for-client");

        // Default tariffs, then back to the client's.
        q.DefaultTariffsCommand.Execute(null);
        Assert.True(q.Dirty);
        Assert.Contains("alapértelmezett", q.TariffSource);
        await q.LoadTariffsCommand.ExecuteAsync(null);
        Assert.Contains(partner.Data.Name, q.TariffSource);

        // Leaving with unsaved changes asks; "Mégse" stays.
        var back = shell.BackAsync();
        await AnswerAsync(shell, ok: false);
        await back;
        Assert.Same(q, shell.Current);
        back = shell.BackAsync();
        await AnswerAsync(shell);
        await back;
        Assert.Same(partner, shell.Current);
    }

    [AvaloniaFact]
    public async Task Desktop_window_with_unsaved_changes_asks_before_closing()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("quotes");
        await shell.NavigateAsync(new QuoteViewModel(shell, null));
        Screens.Settle();
        var w = Assert.Single(presenter.Records);
        var q = Assert.IsType<QuoteViewModel>(w.Page);
        await WaitAsync(() => q.Paper is not null);
        Assert.Equal(1440, w.Width);
        Screens.Save(w, "quote-window");
        Field(q.VolumeFields, "Rendelés / hó").Text = "100";
        Assert.True(presenter.HasUnsaved);

        w.Close();
        Screens.Settle();
        Assert.IsType<MessageWindow>(presenter.Message).Answer(false);
        Screens.Settle();
        Assert.Single(presenter.Records);
        w.Close();
        Screens.Settle();
        Assert.IsType<MessageWindow>(presenter.Message).Answer(true);
        Screens.Settle();
        Assert.Empty(presenter.Records);
    }
}
