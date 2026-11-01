using Avalonia.Headless.XUnit;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Settings;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Tests;

// The settings screens: company, warehouse and costing, default tariffs with their errors; sizes
// and locations one by one and in bulk; courier and invoicing accounts; the logs. Nothing is
// saved over the demo settings; the sizes and locations are the test's own and are deleted.
[Collection("Partners")]
public class SettingsUiTests
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

    static async Task<SettingsViewModel> OpenAsync(ShellViewModel shell)
    {
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("settings");
        return Assert.IsType<SettingsViewModel>(shell.Current);
    }

    static Task ShowAsync(SettingsViewModel page, string key) => page.SelectTabCommand.ExecuteAsync(page.Tabs.Single((t) => t.Key == key));

    [AvaloniaFact]
    public async Task Desktop_company_warehouse_tariffs()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 900);
        var page = await OpenAsync(shell);
        await WaitAsync(() => page.Company.Name.Length > 0);
        Assert.False(page.ReadOnly);
        Screens.Save(window, "settings-company");

        // A wrong e-mail is refused under the field; the tab reloads the saved values.
        var email = page.Company.Email;
        page.Company.Email = "rossz";
        await page.Company.SaveCommand.ExecuteAsync(null);
        Assert.True(page.Company.Errors.ContainsKey("email"));
        Screens.Save(window, "settings-company-error");
        page.Company.Email = email;
        Assert.False(page.Company.Errors.ContainsKey("email"));
        await ShowAsync(page, "company");

        // Warehouse: the days, the costing with the racks' preview; a wrong rack refused.
        await ShowAsync(page, "warehouse");
        Assert.True(page.IsWarehouse && !page.IsCompany);
        await WaitAsync(() => page.Warehouse.Racks.Count > 0 && page.Warehouse.Days.Count == 7);
        Assert.Contains("Ft / m²", page.Warehouse.RentPerM2Text);
        var rack = page.Warehouse.Racks[0];
        Assert.EndsWith("m²", rack.M2Text);
        Screens.Save(window, "settings-warehouse");
        rack.Levels = "1,5";
        await page.Warehouse.SaveCostingCommand.ExecuteAsync(null);
        Assert.True(page.Warehouse.CostErrors.ContainsKey($"racks.{rack.Code}.levels"), string.Join(", ", page.Warehouse.CostErrors.Keys));
        Assert.NotNull(page.Warehouse.CostError);
        page.Warehouse.Open = "18:00";
        page.Warehouse.Close = "08:00";
        await page.Warehouse.SaveCommand.ExecuteAsync(null);
        Assert.True(page.Warehouse.Errors.ContainsKey("close"));
        Screens.Save(window, "settings-warehouse-errors");
        await ShowAsync(page, "warehouse");
        Assert.Empty(page.Warehouse.CostErrors);

        // Default tariffs: a negative price refused under its row.
        await ShowAsync(page, "tariffs");
        await WaitAsync(() => page.Tariffs.TariffGroups.Count > 0 && page.Tariffs.Storage.Count > 0);
        var price = page.Tariffs.TariffGroups[0].Items[0];
        price.Value = "-5";
        await page.Tariffs.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(price.Error);
        Screens.Save(window, "settings-tariffs");
        price.Value = "1";
        Assert.Null(price.Error);
        await ShowAsync(page, "tariffs");
    }

    [AvaloniaFact]
    public async Task Desktop_sizes_and_locations()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 1400);
        var page = await OpenAsync(shell);
        await ShowAsync(page, "locations");
        var tab = page.Locations;
        await WaitAsync(() => tab.Sizes.Count > 0 && tab.Items.Count > 0);
        Assert.True(tab.CanCreate && tab.CanSelect);
        Screens.Save(window, "settings-locations");

        var code = $"U{DateTime.UtcNow:mmssff}";
        try
        {
            // A new size: the code is required.
            await tab.NewSizeCommand.ExecuteAsync(null);
            var size = Assert.IsType<SizeFormViewModel>(shell.Current);
            await size.SaveCommand.ExecuteAsync(null);
            Assert.True(size.Errors.ContainsKey("code"));
            size.Code = code.ToLowerInvariant();
            size.Name = "Teszt polc";
            size.HeightCm = "30,5";
            size.Sort = "995";
            Screens.Save(window, "settings-size-new");
            await size.SaveCommand.ExecuteAsync(null);
            Assert.Same(page, shell.Current);
            await WaitAsync(() => tab.Sizes.Any((s) => s.Size.Code == code));
            var row = tab.Sizes.Single((s) => s.Size.Code == code);
            Assert.Equal("? × ? × 30,5 cm", row.Dims);
            Assert.Contains(shell.Meta.Sizes, (s) => s.Code == code);

            // In bulk: the preview counts the codes.
            await tab.BulkCreateCommand.ExecuteAsync(null);
            var bulk = Assert.IsType<BulkCreateViewModel>(shell.Current);
            await bulk.LoadAsync();
            Assert.False(bulk.CanCreate);
            bulk.Prefixes = code;
            bulk.RackTo = "2";
            bulk.LevelTo = "3";
            bulk.Size = bulk.SizeChoices.Single((s) => s.Label.StartsWith(code));
            bulk.KindChoice = bulk.Kinds.Single((k) => k.Key == "packing");
            bulk.Zone = "TESZT";
            await WaitAsync(() => bulk.CreateCount == 6);
            Assert.Contains($"{code}-02-03", bulk.PreviewCodes);
            Assert.Equal("Létrehozás (6 db)", bulk.SubmitText);
            Screens.Save(window, "settings-bulk-create");
            await bulk.SaveCommand.ExecuteAsync(null);
            Assert.Same(page, shell.Current);

            // The size's locations; all selected, changed at once.
            await WaitAsync(() => tab.Sizes.Any((s) => s.Size.Code == code && s.Size.LocationCount == 6));
            tab.Sizes.Single((s) => s.Size.Code == code).FilterCommand.Execute(null);
            await WaitAsync(() => !page.IsLoading && tab.Total == 6 && tab.Items.Count == 6);
            tab.SelectPageCommand.Execute(null);
            Assert.Equal(6, tab.SelectedCount);
            Assert.False(tab.CanSelectMatching);
            Screens.Save(window, "settings-locations-selected");
            await tab.BulkEditCommand.ExecuteAsync(null);
            var change = Assert.IsType<BulkChangeViewModel>(shell.Current);
            await change.SaveCommand.ExecuteAsync(null);
            Assert.NotNull(change.Error);
            change.Zone = "teszt2";
            change.PickSequence = "4";
            Screens.Save(window, "settings-bulk-change");
            await change.SaveCommand.ExecuteAsync(null);
            Assert.Same(page, shell.Current);
            await WaitAsync(() => !page.IsLoading && tab.Items.Count == 6 && tab.Items.All((i) => i.Location.Zone == "TESZT2" && i.Location.PickSequence == 4));
            Assert.Equal(0, tab.SelectedCount);

            // One location: its dialog, a note saved.
            await WaitAsync(() => tab.Items.Count > 0);
            tab.Items[0].OpenCommand.Execute(null);
            await WaitAsync(() => shell.Current is LocationFormViewModel { Data: not null });
            var loc = (LocationFormViewModel)shell.Current!;
            Assert.True(loc.IsFree && loc.CanDelete && loc.CanToggleActive);
            Assert.Equal("packing", loc.KindChoice?.Key);
            loc.Note = "Teszt megjegyzés";
            Screens.Save(window, "settings-location");
            await loc.SaveCommand.ExecuteAsync(null);
            Assert.Same(page, shell.Current);
            await WaitAsync(() => tab.Items.Any((i) => i.Location.Note == "Teszt megjegyzés"));

            // Deleted in bulk, then the unused size.
            tab.SelectPageCommand.Execute(null);
            var deleting = tab.BulkDeleteCommand.ExecuteAsync(null);
            await AnswerAsync(shell);
            await deleting;
            await WaitAsync(() => !page.IsLoading && tab.IsEmpty);
            row = tab.Sizes.Single((s) => s.Size.Code == code);
            Assert.True(row.CanDelete);
            row.DeleteCommand.Execute(null);
            await AnswerAsync(shell);
            await WaitAsync(() => tab.Sizes.All((s) => s.Size.Code != code));
        }
        finally
        {
            using var api = await LiveServer.SignInAsync(LiveServer.Admin);
            var sizes = await api.GetAsync<ItemList<LocationSize>>("api/settings/sizes", Ct);
            if (sizes.Items.FirstOrDefault((s) => s.Code == code) is { } left)
            {
                var ids = await api.GetAsync<LocationIds>($"api/settings/locations?size_id={left.Id}&ids_only=1", Ct);
                if (ids.Ids.Count > 0) await api.PostAsync<BulkDeleted>("api/settings/locations/bulk-delete", new { ids = ids.Ids }, Ct);
                await api.DeleteAsync($"api/settings/sizes/{left.Id}", Ct);
            }
        }
    }

    [AvaloniaFact]
    public async Task Desktop_couriers_invoicing_log()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 900);
        var page = await OpenAsync(shell);

        await ShowAsync(page, "couriers");
        await WaitAsync(() => page.Couriers.Cards.Count > 0);
        var gls = page.Couriers.Cards.Single((c) => c.Account.Code == "gls");
        Assert.True(gls.CanEdit);
        Screens.Save(window, "settings-couriers");
        gls.EditCommand.Execute(null);
        var form = Assert.IsType<CourierFormViewModel>(shell.Current);
        Assert.True(form.HasCredentials && form.Carriers.Count > 1);
        Assert.DoesNotContain(form.Settings, (s) => s.Key == "api_base_url");
        Screens.Save(window, "settings-courier");
        await shell.BackAsync();

        // Invoicing: choosing a service shows its fields (nothing saved).
        await ShowAsync(page, "invoicing");
        await WaitAsync(() => page.Invoicing.Data is not null);
        Assert.True(page.Invoicing.Manual);
        page.Invoicing.Choices.Single((c) => c.Code == "szamlazz").IsChosen = true;
        Assert.True(page.Invoicing.HasFields && page.Invoicing.HasCredentials);
        Assert.Single(page.Invoicing.Choices, (c) => c.IsChosen);
        Screens.Save(window, "settings-invoicing");
        await ShowAsync(page, "invoicing");
        Assert.True(page.Invoicing.Manual);

        // The log: the settings changes, one entry, the integration calls.
        await ShowAsync(page, "log");
        await WaitAsync(() => page.Log.Audit.Count > 0);
        page.Log.ModuleFilter = page.Log.Modules.Single((m) => m.Key == "settings");
        await WaitAsync(() => !page.IsLoading && page.Log.Audit.Count > 0 && page.Log.Audit.All((a) => a.Row.Module == "settings"));
        Screens.Save(window, "settings-log");
        page.Log.Selected = page.Log.Audit.FirstOrDefault((a) => a.HasDetails) ?? page.Log.Audit[0];
        var entry = Assert.IsType<LogEntryViewModel>(shell.Current);
        Assert.True(entry.HasChanges || entry.HasRest || entry.Row.Summary is not null);
        Screens.Save(window, "settings-log-entry");
        await shell.BackAsync();
        await page.Log.ExportCommand.ExecuteAsync(null);
        Assert.EndsWith(".csv", Assert.Single(((TestPlatform)shell.Services.Platform).Opened).FileName);
        await page.Log.ShowKindCommand.ExecuteAsync("integration");
        Assert.True(page.Log.IsIntegration);
        Screens.Save(window, "settings-log-integration");
    }
}
