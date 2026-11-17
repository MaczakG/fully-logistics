using System.ComponentModel;
using System.Globalization;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Partners;

// The partner dialogs: field errors from the server under their fields, the message on top.
public abstract partial class PartnerForm(ShellViewModel shell) : PageViewModel(shell)
{
    public override string? Module => "partners";
    public override PageKind Kind => PageKind.Dialog;

    [ObservableProperty]
    public partial Dictionary<string, string> Errors { get; set; } = [];

    [ObservableProperty]
    public partial string? Error { get; set; }

    partial void OnErrorsChanged(Dictionary<string, string> value) => ShowErrors(value);

    // A corrected field loses its error at once.
    protected override void OnPropertyChanged(PropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        if (e.PropertyName is null or nameof(Errors) or nameof(Error) || Errors is not { Count: > 0 }) return;
        if (PartnerFormat.Without(Errors, ErrorKey(e.PropertyName)) is { } rest) Errors = rest;
    }

    // The server's field name of a property.
    protected virtual string? ErrorKey(string property) => PartnerFormat.Snake(property);

    // Forms with their own field rows put the errors on them.
    protected virtual void ShowErrors(Dictionary<string, string> errors) { }

    protected void Fail(string key, string message)
    {
        Errors = new() { [key] = message };
        Error = "Ellenőrizd a megjelölt mezőket.";
    }

    // Saves; a refused answer (400, 409) shows on the form, the dialog stays open.
    protected Task SubmitAsync(Func<Task> save) => RunAsync(async () =>
    {
        Error = null;
        Errors = [];
        try
        {
            await save();
        }
        catch (ApiException e) when (e.Status is 400 or 409)
        {
            Errors = new Dictionary<string, string>(e.Fields);
            Error = e.Message;
        }
    });

    protected static DateTime? ParseDate(string? iso) =>
        DateTime.TryParseExact(iso, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
}

// Új partner: type, name with a suggested code, address, billing e-mail, website, the courier
// service of a carrier, note. Clients start with the default tariffs.
public sealed partial class PartnerNewViewModel : PartnerForm
{
    public PartnerNewViewModel(ShellViewModel shell, string type) : base(shell)
    {
        Types = shell.Meta.PartnerTypes.Select((t) => new OrderChoice(t.Key, t.Value)).ToList();
        CarrierChoices = [new("", "Nincs megadva"), .. shell.Meta.Carriers.Select((c) => new OrderChoice(c.Key, c.Value))];
        Type = Types.FirstOrDefault((t) => t.Key == type) ?? Types.FirstOrDefault() ?? new("client", "Ügyfél");
        CarrierCode = CarrierChoices[0];
    }

    public override string Title => "Új partner";
    public override double DialogWidth => 760;

    public IReadOnlyList<OrderChoice> Types { get; }
    public IReadOnlyList<OrderChoice> CarrierChoices { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsCarrier), nameof(IsClient))]
    public partial OrderChoice Type { get; set; }

    [ObservableProperty] public partial string Name { get; set; } = "";
    [ObservableProperty] public partial string Code { get; set; } = "";
    [ObservableProperty] public partial string TaxNumber { get; set; } = "";
    [ObservableProperty] public partial string Country { get; set; } = "HU";
    [ObservableProperty] public partial string Zip { get; set; } = "";
    [ObservableProperty] public partial string City { get; set; } = "";
    [ObservableProperty] public partial string Address { get; set; } = "";
    [ObservableProperty] public partial string BillingEmail { get; set; } = "";
    [ObservableProperty] public partial string Website { get; set; } = "";
    [ObservableProperty] public partial OrderChoice CarrierCode { get; set; }
    [ObservableProperty] public partial string Notes { get; set; } = "";

    public bool IsCarrier => Type.Key == "carrier";
    public bool IsClient => Type.Key == "client";

    // The code follows the name until it is typed by hand.
    bool codeTouched;
    bool suggesting;

    partial void OnNameChanged(string value)
    {
        if (codeTouched) return;
        suggesting = true;
        Code = PartnerFormat.SuggestCode(value);
        suggesting = false;
    }

    partial void OnCodeChanged(string value)
    {
        if (!suggesting) codeTouched = value.Length > 0;
    }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        var body = new Dictionary<string, object?>
        {
            ["type"] = Type.Key, ["name"] = Name.Trim(), ["code"] = Code.Trim().ToUpperInvariant(), ["tax_number"] = TaxNumber.Trim(),
            ["country"] = Country.Trim().ToUpperInvariant(), ["zip"] = Zip.Trim(), ["city"] = City.Trim(), ["address"] = Address.Trim(),
            ["billing_email"] = BillingEmail.Trim(), ["website"] = Website.Trim(), ["notes"] = Notes.Trim(),
        };
        if (IsCarrier) body["carrier_code"] = CarrierCode.Key ?? "";
        var res = await Api.PostAsync<PartnerCreated>("api/partners", body);
        Shell.Toast("Partner létrehozva.", ToastKind.Success);
        await Shell.BackAsync();
        await Shell.NavigateAsync(new PartnerViewModel(Shell, res.Id));
    });
}

// Kapcsolattartó: name, position, e-mail, phone, note, primary.
public sealed partial class ContactFormViewModel(ShellViewModel shell, int partnerId, PartnerContact? contact, bool firstOne) : PartnerForm(shell)
{
    public PartnerContact? Contact { get; } = contact;
    public override string Title => Contact is null ? "Új kapcsolattartó" : "Kapcsolattartó szerkesztése";
    public string SubmitText => Contact is null ? "Felvétel" : "Mentés";

    [ObservableProperty] public partial string Name { get; set; } = contact?.Name ?? "";
    [ObservableProperty] public partial string Position { get; set; } = contact?.Position ?? "";
    [ObservableProperty] public partial string Email { get; set; } = contact?.Email ?? "";
    [ObservableProperty] public partial string Phone { get; set; } = contact?.Phone ?? "";
    [ObservableProperty] public partial string Notes { get; set; } = contact?.Notes ?? "";
    [ObservableProperty] public partial bool IsPrimary { get; set; } = contact?.IsPrimary ?? firstOne;

    // The primary contact stays primary until another one is made primary in the list.
    public bool PrimaryLocked => Contact?.IsPrimary == true || (Contact is null && firstOne);
    public string PrimaryHint => Contact?.IsPrimary == true ? "Másik elsődleges kapcsolattartót a listában jelölhetsz ki."
        : firstOne ? "Az első kapcsolattartó automatikusan elsődleges." : "Egy partnernek egy elsődleges kapcsolattartója van.";

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        var body = new Dictionary<string, object?>
        {
            ["name"] = Name.Trim(), ["position"] = Position.Trim(), ["email"] = Email.Trim(), ["phone"] = Phone.Trim(), ["notes"] = Notes.Trim(),
        };
        if (Contact?.IsPrimary != true) body["is_primary"] = IsPrimary;
        if (Contact is { } c) await Api.PatchAsync<PartnerSaved>($"api/partners/{partnerId}/contacts/{c.Id}", body);
        else await Api.PostAsync<NewId>($"api/partners/{partnerId}/contacts", body);
        Shell.Toast(Contact is null ? "Kapcsolattartó felvéve." : "Kapcsolattartó mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// Szerződés: number, title, start, end or indefinite, notice, status, note.
public sealed partial class ContractFormViewModel : PartnerForm
{
    public ContractFormViewModel(ShellViewModel shell, int partnerId, PartnerContract? contract) : base(shell)
    {
        this.partnerId = partnerId;
        Contract = contract;
        Statuses = shell.Meta.Statuses.GetValueOrDefault("contract", []).Select((s) => new OrderChoice(s.Key, s.Value.Label)).ToList();
        Number = contract?.Number ?? "";
        ContractTitle = contract?.Title ?? "Fulfillment szolgáltatási szerződés";
        Start = contract is null ? ParseDate(PartnerFormat.Today) : ParseDate(contract.StartDate);
        Indefinite = contract is null || contract.EndDate is null;
        End = ParseDate(contract?.EndDate);
        NoticeDays = (contract?.NoticeDays ?? 30).ToString();
        Status = Statuses.FirstOrDefault((s) => s.Key == (contract?.Status ?? "active")) ?? Statuses.FirstOrDefault() ?? new("active", "Hatályos");
        Notes = contract?.Notes ?? "";
    }

    readonly int partnerId;
    public PartnerContract? Contract { get; }
    public override string Title => Contract is null ? "Új szerződés" : "Szerződés szerkesztése";
    public override double DialogWidth => 640;
    public string SubmitText => Contract is null ? "Felvétel" : "Mentés";
    public IReadOnlyList<OrderChoice> Statuses { get; }

    [ObservableProperty] public partial string Number { get; set; }
    [ObservableProperty] public partial string ContractTitle { get; set; }
    [ObservableProperty] public partial DateTime? Start { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasEnd))]
    public partial bool Indefinite { get; set; }

    [ObservableProperty] public partial DateTime? End { get; set; }
    [ObservableProperty] public partial string NoticeDays { get; set; }
    [ObservableProperty] public partial OrderChoice Status { get; set; }
    [ObservableProperty] public partial string Notes { get; set; }

    public bool HasEnd => !Indefinite;

    protected override string? ErrorKey(string property) => property switch
    {
        nameof(End) or nameof(Indefinite) => "end_date",
        nameof(Start) => "start_date",
        nameof(ContractTitle) => "title",
        _ => base.ErrorKey(property),
    };

    partial void OnIndefiniteChanged(bool value)
    {
        if (value) End = null;
    }

    [RelayCommand]
    Task SaveAsync()
    {
        if (!Indefinite && End is null)
        {
            Fail("end_date", "Add meg a lejáratot, vagy jelöld határozatlannak.");
            return Task.CompletedTask;
        }
        if (!int.TryParse(NoticeDays.Trim(), out var notice) || notice is < 0 or > 3650)
        {
            Fail("notice_days", "0 és 3650 közötti egész számot adj meg.");
            return Task.CompletedTask;
        }
        return SubmitAsync(async () =>
        {
            var body = new Dictionary<string, object?>
            {
                ["number"] = Number.Trim(), ["title"] = ContractTitle.Trim(), ["start_date"] = Start?.ToString("yyyy-MM-dd"),
                ["end_date"] = Indefinite ? null : End?.ToString("yyyy-MM-dd"), ["notice_days"] = notice, ["status"] = Status.Key, ["notes"] = Notes.Trim(),
            };
            if (Contract is { } c) await Api.PatchAsync<PartnerSaved>($"api/partners/{partnerId}/contracts/{c.Id}", body);
            else await Api.PostAsync<NewId>($"api/partners/{partnerId}/contracts", body);
            Shell.Toast(Contract is null ? "Szerződés felvéve." : "Szerződés mentve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

// Dokumentum feltöltése: a file (20 MB at most), its kind and its contract.
public sealed partial class DocumentUploadViewModel : PartnerForm
{
    public DocumentUploadViewModel(ShellViewModel shell, int partnerId, IReadOnlyList<PartnerContract> contracts) : base(shell)
    {
        this.partnerId = partnerId;
        Contracts = [new(null, "Nincs hozzárendelve"), .. contracts.Select((c) => new OrderChoice(c.Id.ToString(), PartnerContractsTab.Label(c.Number, c.Title)))];
        Contract = Contracts[0];
        DocKind = Kinds[contracts.Count > 0 ? 0 : 1];
    }

    readonly int partnerId;
    public override string Title => "Dokumentum feltöltése";
    public static readonly IReadOnlyList<OrderChoice> Kinds = [new("contract", "Szerződés"), new("other", "Egyéb")];
    public IReadOnlyList<OrderChoice> Contracts { get; }
    public const long MaxBytes = 20 * 1024 * 1024;

    [ObservableProperty] public partial OrderChoice DocKind { get; set; }
    [ObservableProperty] public partial OrderChoice Contract { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FileText), nameof(HasFile))]
    public partial string? FileName { get; set; }

    byte[]? bytes;

    public bool HasFile => FileName is not null;

    protected override string? ErrorKey(string property) => property switch
    {
        nameof(DocKind) => "kind",
        nameof(Contract) => "contract_id",
        _ => base.ErrorKey(property),
    };
    public string FileText => FileName is null ? "Nincs kiválasztva fájl." : $"{FileName} ({PartnerFormat.Bytes(bytes?.LongLength ?? 0)})";

    public void SetFile(string name, byte[] data)
    {
        bytes = data;
        FileName = name;
        Errors = [];
        Error = null;
    }

    [RelayCommand]
    Task SaveAsync()
    {
        if (bytes is null || FileName is null)
        {
            Fail("file", "Válassz ki egy fájlt.");
            return Task.CompletedTask;
        }
        if (bytes.LongLength > MaxBytes)
        {
            Fail("file", "A fájl legfeljebb 20 MB lehet.");
            return Task.CompletedTask;
        }
        return SubmitAsync(async () =>
        {
            await Api.UploadAsync<NewId>($"api/partners/{partnerId}/documents", bytes, FileName,
                new Dictionary<string, string> { ["kind"] = DocKind.Key ?? "other", ["contract_id"] = Contract.Key ?? "" });
            Shell.Toast("Dokumentum feltöltve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

// Dokumentum adatai: kind and contract of an uploaded file.
public sealed partial class DocumentEditViewModel : PartnerForm
{
    public DocumentEditViewModel(ShellViewModel shell, int partnerId, PartnerDocument doc, IReadOnlyList<PartnerContract> contracts) : base(shell)
    {
        this.partnerId = partnerId;
        Document = doc;
        Contracts = [new(null, "Nincs hozzárendelve"), .. contracts.Select((c) => new OrderChoice(c.Id.ToString(), PartnerContractsTab.Label(c.Number, c.Title)))];
        Contract = Contracts.FirstOrDefault((c) => c.Key == doc.ContractId?.ToString()) ?? Contracts[0];
        DocKind = DocumentUploadViewModel.Kinds.FirstOrDefault((k) => k.Key == doc.Kind) ?? DocumentUploadViewModel.Kinds[1];
    }

    readonly int partnerId;
    public PartnerDocument Document { get; }
    public override string Title => "Dokumentum adatai";
    public override double DialogWidth => 480;
    public IReadOnlyList<OrderChoice> Contracts { get; }

    [ObservableProperty] public partial OrderChoice DocKind { get; set; }
    [ObservableProperty] public partial OrderChoice Contract { get; set; }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        await Api.PatchAsync<PartnerSaved>($"api/partners/{partnerId}/documents/{Document.Id}",
            new Dictionary<string, object?> { ["kind"] = DocKind.Key, ["contract_id"] = Contract.Key is { } c ? int.Parse(c) : null });
        Shell.Toast("Dokumentum mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// Egyedi tétel: a monthly fixed fee or a fee per recorded quantity.
public sealed partial class CustomItemFormViewModel(ShellViewModel shell, int partnerId, CustomItem? item) : PartnerForm(shell)
{
    public CustomItem? Item { get; } = item;
    public override string Title => Item is null ? "Új egyedi tétel" : "Egyedi tétel szerkesztése";
    public string SubmitText => Item is null ? "Felvétel" : "Mentés";
    public static readonly IReadOnlyList<OrderChoice> Kinds = [new("per_unit", "Mennyiség alapján"), new("monthly", "Havi fix díj")];

    [ObservableProperty] public partial string Name { get; set; } = item?.Name ?? "";
    [ObservableProperty] public partial OrderChoice ItemKind { get; set; } = Kinds.FirstOrDefault((k) => k.Key == item?.Kind) ?? Kinds[0];
    [ObservableProperty] public partial string Unit { get; set; } = item?.Unit ?? "db";
    [ObservableProperty] public partial string Price { get; set; } = item is null ? "" : Fmt.Num(item.Price);
    [ObservableProperty] public partial bool Active { get; set; } = item?.Active ?? true;

    protected override string? ErrorKey(string property) => property == nameof(ItemKind) ? "kind" : base.ErrorKey(property);

    [RelayCommand]
    Task SaveAsync()
    {
        if (Fmt.ParseNumber(Price) is not { } price || price < 0)
        {
            Fail("price", "Nem negatív számot adj meg.");
            return Task.CompletedTask;
        }
        return SubmitAsync(async () =>
        {
            var body = new Dictionary<string, object?> { ["name"] = Name.Trim(), ["kind"] = ItemKind.Key, ["unit"] = Unit.Trim(), ["price"] = price, ["active"] = Active };
            if (Item is { } it) await Api.PatchAsync<PartnerSaved>($"api/partners/{partnerId}/custom-items/{it.Id}", body);
            else await Api.PostAsync<NewId>($"api/partners/{partnerId}/custom-items", body);
            Shell.Toast(Item is null ? "Egyedi tétel felvéve." : "Egyedi tétel mentve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

// Webshop kapcsolat: platform (new only), shop address, active; the platform's own credential and
// setting fields. Saved credentials are never shown: an empty field keeps them.
public sealed partial class ConnectionFormViewModel : PartnerForm
{
    public ConnectionFormViewModel(ShellViewModel shell, int partnerId, IReadOnlyList<WebshopPlatform> platforms, WebshopConnection? connection) : base(shell)
    {
        this.partnerId = partnerId;
        this.platforms = platforms;
        Connection = connection;
        Platforms = platforms.Select((p) => new OrderChoice(p.Code, p.Name)).ToList();
        ShopUrl = connection?.ShopUrl ?? "";
        Active = connection?.Active ?? true;
        Platform = Platforms.FirstOrDefault((p) => p.Key == connection?.Platform) ?? Platforms[0];
    }

    readonly int partnerId;
    readonly IReadOnlyList<WebshopPlatform> platforms;
    public WebshopConnection? Connection { get; }
    public bool IsNew => Connection is null;
    public override string Title => IsNew ? "Új webshop kapcsolat" : "Webshop kapcsolat szerkesztése";
    public override double DialogWidth => 760;
    public string SubmitText => IsNew ? "Kapcsolat felvétele" : "Mentés";
    public IReadOnlyList<OrderChoice> Platforms { get; }
    public string PlatformText => Connection?.PlatformName ?? "";

    [ObservableProperty] public partial string ShopUrl { get; set; }
    [ObservableProperty] public partial bool Active { get; set; }
    [ObservableProperty] public partial OrderChoice Platform { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCredentials))]
    public partial IReadOnlyList<PlatformInput> Credentials { get; set; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSettings))]
    public partial IReadOnlyList<PlatformInput> Settings { get; set; } = [];

    public bool HasCredentials => Credentials.Count > 0;
    public bool HasSettings => Settings.Count > 0;

    partial void OnPlatformChanged(OrderChoice value)
    {
        var def = platforms.First((p) => p.Code == value.Key);
        var conn = Connection?.Platform == def.Code ? Connection : null;
        Credentials = def.CredentialFields.Select((f) => PlatformInput.Credential(f, conn?.Credentials?.GetValueOrDefault(f.Key))).ToList();
        Settings = def.SettingFields.Select((f) => PlatformInput.Setting(f, conn?.Settings is { } s && s.TryGetValue(f.Key, out var v) ? v : f.Default)).ToList();
    }

    protected override void ShowErrors(Dictionary<string, string> value)
    {
        foreach (var c in Credentials) c.Error = value.GetValueOrDefault($"cred_{c.Key}");
        foreach (var s in Settings) s.Error = value.GetValueOrDefault($"set_{s.Key}");
    }

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        var body = new Dictionary<string, object?> { ["shop_url"] = ShopUrl.Trim(), ["active"] = Active };
        var creds = Credentials.Where((c) => c.Text.Trim().Length > 0 || c.Choice?.Key is not null)
            .ToDictionary((c) => c.Key, (c) => (object?)(c.IsSelect ? c.Choice!.Key : c.Text.Trim()));
        if (IsNew || creds.Count > 0) body["credentials"] = creds;
        body["settings"] = Settings.ToDictionary((s) => s.Key, (s) => s.SettingValue);
        if (IsNew) body["platform"] = Platform.Key;
        if (Connection is { } c) await Api.PatchAsync<WebshopConnection>($"api/partners/{partnerId}/webshops/{c.Id}", body);
        else await Api.PostAsync<WebshopConnection>($"api/partners/{partnerId}/webshops", body);
        Shell.Toast(IsNew ? "Webshop kapcsolat felvéve. Teszteld a kapcsolatot." : "Webshop kapcsolat mentve.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// One field of a platform's form: text, secret, number, select or checkbox.
public sealed partial class PlatformInput : ObservableObject
{
    PlatformInput(PlatformField f)
    {
        Key = f.Key;
        Label = string.IsNullOrEmpty(f.Label) ? f.Key : f.Label;
        Type = (f.Type ?? "text").ToLowerInvariant();
        Options = f.Options?.Select((o) => new OrderChoice(o.Value, o.Label)).ToList() ?? [];
        Required = f.Required;
    }

    public string Key { get; }
    public string Label { get; }
    public string Type { get; }
    public bool Required { get; }
    public IReadOnlyList<OrderChoice> Options { get; }
    public string Hint { get; private set; } = "";
    public string Placeholder { get; private set; } = "";
    public bool IsCheck => Type is "checkbox" or "bool" or "boolean";
    public bool IsSelect => Type == "select";
    public bool IsSecret { get; private set; }
    public bool IsText => !IsCheck && !IsSelect;
    public bool IsNumber => Type is "number" or "int" or "integer" or "num";
    public char SecretChar => IsSecret ? '•' : '\0';
    public string LabelText => Required ? Label : $"{Label} (nem kötelező)";

    [ObservableProperty] public partial string Text { get; set; } = "";
    [ObservableProperty] public partial bool Checked { get; set; }
    [ObservableProperty] public partial OrderChoice? Choice { get; set; }
    [ObservableProperty] public partial string? Error { get; set; }

    // A credential: the saved value shows only masked; an empty field keeps it.
    public static PlatformInput Credential(PlatformField f, JsonElement? saved)
    {
        var masked = saved is { ValueKind: JsonValueKind.String } s ? s.GetString() : null;
        var input = new PlatformInput(f)
        {
            IsSecret = (f.Type ?? "password").ToLowerInvariant() is not ("text" or "url" or "email" or "select"),
            Placeholder = string.IsNullOrEmpty(masked) ? "" : $"Mentve: {masked}",
            Hint = string.Join(" ", new[] { string.IsNullOrEmpty(masked) ? "" : "Hagyd üresen, ha nem változik.", f.Help ?? "" }.Where((x) => x.Length > 0)),
        };
        if (input.IsSelect) input.Choice = null;
        return input;
    }

    public static PlatformInput Setting(PlatformField f, JsonElement? value)
    {
        var input = new PlatformInput(f) { Hint = f.Help ?? "" };
        if (value is { } v)
        {
            if (input.IsCheck) input.Checked = v.ValueKind == JsonValueKind.True || (v.ValueKind == JsonValueKind.Number && v.GetDecimal() != 0);
            else
            {
                var text = v.ValueKind switch { JsonValueKind.String => v.GetString() ?? "", JsonValueKind.Number => v.GetRawText(), _ => "" };
                if (input.IsSelect) input.Choice = input.Options.FirstOrDefault((o) => o.Key == text);
                else input.Text = text;
            }
        }
        return input;
    }

    public object? SettingValue => IsCheck ? Checked : IsSelect ? Choice?.Key : Text.Trim();
}

// Új API kulcs: what it is for. The key is shown once, in the next window.
public sealed partial class ApiKeyFormViewModel(ShellViewModel shell, int partnerId) : PartnerForm(shell)
{
    public override string Title => "Új API kulcs";
    public override double DialogWidth => 480;

    [ObservableProperty] public partial string Name { get; set; } = "";

    [RelayCommand]
    Task SaveAsync() => SubmitAsync(async () =>
    {
        var res = await Api.PostAsync<ApiKeyCreated>($"api/partners/{partnerId}/api-keys", new { name = Name.Trim() });
        await Shell.BackAsync();
        await Shell.NavigateAsync(new ApiKeyShownViewModel(Shell, res));
    });
}

public sealed partial class ApiKeyShownViewModel(ShellViewModel shell, ApiKeyCreated key) : PageViewModel(shell)
{
    public ApiKeyCreated Key { get; } = key;
    public override string Title => "API kulcs létrehozva";
    public override string? Module => "partners";
    public override PageKind Kind => PageKind.Dialog;
    public override double DialogWidth => 600;
    public string Label => $"API kulcs: {Key.Name}";
    public string Usage => $"Használat a kérés fejlécében: Authorization: Bearer {Key.Prefix}...";

    [RelayCommand]
    Task CloseAsync() => Shell.BackAsync();
}
