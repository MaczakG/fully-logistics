using Avalonia.Headless.XUnit;
using Fully.Wms.Modules.Partners;
using Fully.Wms.Services;

namespace Fully.Wms.Tests;

// The partner screens: the list with its type tabs, a demo client's tabs, a new client filled in
// through every tab and deleted, a carrier and a supplier in their own windows.
[Collection("Partners")]
public class PartnersUiTests
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    static async Task WaitAsync(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) { Screens.Settle(); await Task.Delay(20, Ct); }
        Assert.True(done());
    }

    static async Task AnswerAsync(Fully.Wms.ViewModels.ShellViewModel shell, Task action, bool ok = true)
    {
        await WaitAsync(() => shell.Dialog is not null);
        if (ok) shell.Dialog!.OkCommand.Execute(null);
        else shell.Dialog!.CancelCommand.Execute(null);
        await action;
    }

    [AvaloniaFact]
    public async Task Desktop_list_and_demo_client()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("partners");
        var list = Assert.IsType<PartnersViewModel>(shell.Current);
        Assert.True(list.TypeTabs[0].Count >= 6);
        Screens.Save(window, "partners-list-desktop");
        list.SelectTabCommand.Execute(list.TypeTabs[2]);
        await WaitAsync(() => !list.IsLoading && list.Items.All((i) => i.Row.Type == "carrier"));
        Assert.All(list.Items, (i) => Assert.NotEmpty(i.CarrierText));
        list.SelectTabCommand.Execute(list.TypeTabs[0]);
        list.Search = "Mancs";
        await list.ApplyCommand.ExecuteAsync(null);
        var row = Assert.Single(list.Items);

        list.Selected = row;
        await WaitAsync(() => shell.Current is PartnerViewModel { Data: not null });
        var p = (PartnerViewModel)shell.Current!;
        Assert.True(p.IsClient);
        Assert.Equal(6, p.Tabs.Count);
        Assert.Equal("Mancsbirodalom Webáruház Kft.", p.Basic.Name);
        Screens.Save(window, "partners-basic-desktop");

        // Delete: in use, so it offers to deactivate; cancelled.
        await AnswerAsync(shell, p.Basic.DeleteCommand.ExecuteAsync(null), ok: false);
        Assert.Equal("active", p.Status);

        foreach (var (key, name) in new[] { ("contacts", "contacts"), ("contracts", "contracts"), ("tariffs", "tariffs"), ("integrations", "integrations"), ("summary", "summary") })
        {
            await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == key));
            Screens.Save(window, $"partners-{name}-desktop");
        }
        Assert.Contains(p.Contacts.Items, (c) => c.Contact.IsPrimary);
        Assert.NotEmpty(p.Contracts.ContractRows);
        Assert.True(p.Tariffs.HasDiffs);
        Assert.NotEmpty(p.Integrations.Data!.Platforms);
        Assert.True(p.Summary.IsClient);
        Assert.NotEmpty(p.Summary.OrdersByStatus);
    }

    [AvaloniaFact]
    public async Task Desktop_new_client_through_its_tabs()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var window = Screens.Open(shell, 1280, 820);
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("partners");
        var list = Assert.IsType<PartnersViewModel>(shell.Current);

        // New: the code follows the name; a refused field shows under it.
        await list.NewCommand.ExecuteAsync(null);
        var form = Assert.IsType<PartnerNewViewModel>(shell.Current);
        form.Name = "Kutyabarát Ürge Kft.";
        Assert.Equal("KUTYABARAT", form.Code);
        form.Code = $"UI{DateTime.UtcNow:HHmmssff}";
        form.Name = "Kutyabarát Ürge Kft. UI";
        Assert.StartsWith("UI", form.Code);
        form.TaxNumber = "123";
        await form.SaveCommand.ExecuteAsync(null);
        Assert.True(form.Errors.ContainsKey("tax_number"));
        form.TaxNumber = "";
        form.City = "Szeged";
        Screens.Save(window, "partners-new-desktop");
        await form.SaveCommand.ExecuteAsync(null);
        var p = Assert.IsType<PartnerViewModel>(shell.Current);
        await WaitAsync(() => p.Data is not null);
        Assert.True(p.Data!.CanDelete);

        // Basic data.
        p.Basic.PaymentDays = "500";
        await p.Basic.SaveCommand.ExecuteAsync(null);
        Assert.True(p.Basic.Errors.ContainsKey("payment_days"));
        p.Basic.PaymentDays = "30";
        p.Basic.Address = "Fő utca 1.";
        p.Basic.CopyAddressCommand.Execute(null);
        Assert.Equal("Szeged", p.Basic.BillingCity);
        await p.Basic.SaveCommand.ExecuteAsync(null);
        Assert.Equal(30, p.Data!.PaymentDays);
        Assert.Equal("Fő utca 1.", p.Data.BillingAddress);

        // A contact (the first is primary).
        await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == "contacts"));
        await p.Contacts.NewCommand.ExecuteAsync(null);
        var contact = Assert.IsType<ContactFormViewModel>(shell.Current);
        Assert.True(contact.IsPrimary && contact.PrimaryLocked);
        contact.Name = "Ürge Ödön";
        contact.Email = "rossz-cim";
        await contact.SaveCommand.ExecuteAsync(null);
        Assert.True(contact.Errors.ContainsKey("email"));
        contact.Email = "odon@urge.example";
        Assert.Empty(contact.Errors);
        Screens.Save(window, "partners-contact-desktop");
        await contact.SaveCommand.ExecuteAsync(null);
        Assert.Same(p, shell.Current);
        await WaitAsync(() => p.Contacts.Items.Count == 1);
        Assert.True(p.Contacts.Items[0].Contact.IsPrimary);

        // A contract, then a document for it.
        await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == "contracts"));
        await p.Contracts.NewContractCommand.ExecuteAsync(null);
        var contract = Assert.IsType<ContractFormViewModel>(shell.Current);
        Assert.True(contract.Indefinite);
        contract.Indefinite = false;
        await contract.SaveCommand.ExecuteAsync(null);
        Assert.True(contract.Errors.ContainsKey("end_date"));
        contract.End = DateTime.Today.AddDays(30);
        contract.Number = "UI-1";
        Screens.Save(window, "partners-contract-desktop");
        await contract.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => p.Contracts.ContractRows.Count == 1);
        Assert.NotNull(p.Contracts.ContractRows[0].ExpiryNote);
        await p.Contracts.UploadCommand.ExecuteAsync(null);
        var upload = Assert.IsType<DocumentUploadViewModel>(shell.Current);
        await upload.SaveCommand.ExecuteAsync(null);
        Assert.True(upload.Errors.ContainsKey("file"));
        upload.SetFile("szerződés.pdf", "%PDF-1.4 teszt"u8.ToArray());
        upload.Contract = upload.Contracts[1];
        await upload.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => p.Contracts.Documents.Count == 1);
        Assert.Equal("UI-1, Fulfillment szolgáltatási szerződés", p.Contracts.Documents[0].ContractText);
        Assert.Equal("szerződés.pdf", p.Contracts.Documents[0].Document.Filename);
        p.Contracts.Documents[0].OpenCommand.Execute(null);
        await WaitAsync(() => Assert.IsType<TestPlatform>(shell.Services.Platform).Opened.Count == 1);
        Screens.Save(window, "partners-contracts-filled-desktop");

        // Tariffs: one changed and saved, then back to the defaults; a custom item.
        await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == "tariffs"));
        Assert.False(p.Tariffs.HasDiffs);
        var baseFee = p.Tariffs.TariffGroups[0].Items[0];
        baseFee.Value = "abc";
        await p.Tariffs.SaveCommand.ExecuteAsync(null);
        Assert.NotNull(baseFee.Error);
        p.Tariffs.TariffGroups[0].Items[0].Value = "777";
        Assert.True(p.Tariffs.HasDiffs);
        await p.Tariffs.SaveCommand.ExecuteAsync(null);
        Assert.True(p.Tariffs.TariffGroups[0].Items[0].Differs);
        Screens.Save(window, "partners-tariffs-changed-desktop");
        await AnswerAsync(shell, p.Tariffs.ResetCommand.ExecuteAsync(null));
        Assert.False(p.Tariffs.HasDiffs);
        await p.Tariffs.NewItemCommand.ExecuteAsync(null);
        var item = Assert.IsType<CustomItemFormViewModel>(shell.Current);
        item.Name = "Raklapfóliázás";
        item.Unit = "raklap";
        item.Price = "1 500";
        await item.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => p.Tariffs.Custom.Count == 1);
        Assert.Equal($"{Fully.Wms.Core.Fmt.Num(1500)} Ft / raklap", p.Tariffs.Custom[0].PriceText);

        // Integrations: an API key shown once, revoked; a Shopify connection form, removed.
        await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == "integrations"));
        await p.Integrations.NewKeyCommand.ExecuteAsync(null);
        var keyForm = Assert.IsType<ApiKeyFormViewModel>(shell.Current);
        keyForm.Name = "Webshop backend";
        await keyForm.SaveCommand.ExecuteAsync(null);
        var shown = Assert.IsType<ApiKeyShownViewModel>(shell.Current);
        Assert.StartsWith(shown.Key.Prefix, shown.Key.Key);
        Screens.Save(window, "partners-apikey-desktop");
        await shown.CloseCommand.ExecuteAsync(null);
        await WaitAsync(() => p.Integrations.Keys.Count == 1);
        p.Integrations.Keys[0].RevokeCommand.Execute(null);
        await AnswerAsync(shell, Task.CompletedTask);
        await WaitAsync(() => p.Integrations.Keys.Count == 1 && p.Integrations.Keys[0].Revoked);

        await p.Integrations.NewConnectionCommand.ExecuteAsync(null);
        var conn = Assert.IsType<ConnectionFormViewModel>(shell.Current);
        conn.Platform = conn.Platforms.Single((x) => x.Key == "shopify");
        Assert.True(conn.HasCredentials && conn.HasSettings);
        Assert.Contains(conn.Settings, (s) => s.IsCheck && s.Checked);
        conn.ShopUrl = "http://rossz.hu";
        await conn.SaveCommand.ExecuteAsync(null);
        Assert.True(conn.Errors.ContainsKey("shop_url"));
        conn.ShopUrl = "urge-ui.myshopify.com";
        Assert.False(conn.Errors.ContainsKey("shop_url"));
        conn.Active = false;
        conn.Credentials.Single((c) => c.Key == "access_token").Text = "shpat_uiteszt123456";
        Screens.Save(window, "partners-connection-desktop");
        await conn.SaveCommand.ExecuteAsync(null);
        await WaitAsync(() => p.Integrations.Connections.Count == 1);
        Assert.False(p.Integrations.Connections[0].CanSync);
        Screens.Save(window, "partners-integrations-filled-desktop");
        p.Integrations.Connections[0].RemoveCommand.Execute(null);
        await AnswerAsync(shell, Task.CompletedTask);
        await WaitAsync(() => p.Integrations.Connections.Count == 0);

        // Deleted: back to the list.
        await p.SelectTabCommand.ExecuteAsync(p.Tabs.Single((t) => t.Key == "basic"));
        await AnswerAsync(shell, p.Basic.DeleteCommand.ExecuteAsync(null));
        Assert.Same(list, shell.Current);
    }

    [AvaloniaFact]
    public async Task Desktop_carrier_and_supplier_windows()
    {
        LiveServer.SkipIfMissing();
        var shell = Screens.NewShell();
        var main = Screens.Open(shell, 1280, 820);
        var presenter = new WindowPresenter(shell, main);
        shell.Presenter = presenter;
        await Screens.SignInAsync(shell, LiveServer.Admin);
        await shell.OpenModuleAsync("partners");

        await shell.NavigateAsync(new PartnerViewModel(shell, 4, "summary"));
        Screens.Settle();
        var carrier = Assert.IsType<PartnerViewModel>(Assert.Single(presenter.Records).Page);
        await WaitAsync(() => carrier.Summary.Data is not null);
        Assert.Equal(4, carrier.Tabs.Count);
        Assert.True(carrier.Summary.IsCarrier);
        Assert.NotEmpty(carrier.Summary.LastPickups);
        Screens.Save(presenter.Records[0], "partners-carrier-window");

        await shell.NavigateAsync(new PartnerViewModel(shell, 6, "summary"));
        Screens.Settle();
        var supplier = Assert.IsType<PartnerViewModel>(presenter.Records[1].Page);
        await WaitAsync(() => supplier.Summary.Data is not null);
        Assert.True(supplier.Summary.IsSupplier);
        Screens.Save(presenter.Records[1], "partners-supplier-window");

        // A dialog of the record: modal over it, the record reloads after.
        await supplier.SelectTabCommand.ExecuteAsync(supplier.Tabs.Single((t) => t.Key == "contacts"));
        await shell.NavigateAsync(new ContactFormViewModel(shell, 6, null, false));
        Screens.Settle();
        Assert.Single(presenter.Dialogs);
        Screens.Save(presenter.Dialogs[0], "partners-contact-dialog");
        presenter.CloseAll();
    }
}
