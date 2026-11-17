using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.Modules.Orders;
using Fully.Wms.Modules.Partners;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Settings;

// A location size: code, name, dimensions, load, order, active.
public sealed partial class SizeFormViewModel(ShellViewModel shell, LocationSize? size) : PartnerForm(shell)
{
    public LocationSize? Size { get; } = size;
    public override string Title => Size is { } s ? $"Méret: {s.Code}" : "Új raktárhely méret";
    public override string? Module => "settings";
    public string SubmitText => Size is null ? "Létrehozás" : "Mentés";
    public string? UsedNote => Size is { LocationCount: > 0 } s
        ? $"{Fmt.Int(s.LocationCount)} raktárhely használja ezt a méretet. A kód módosítása után a partnerek tárolási díjai megmaradnak." : null;

    [ObservableProperty] public partial string Code { get; set; } = size?.Code ?? "";
    [ObservableProperty] public partial string Name { get; set; } = size?.Name ?? "";
    [ObservableProperty] public partial string WidthCm { get; set; } = Text(size?.WidthCm);
    [ObservableProperty] public partial string DepthCm { get; set; } = Text(size?.DepthCm);
    [ObservableProperty] public partial string HeightCm { get; set; } = Text(size?.HeightCm);
    [ObservableProperty] public partial string MaxKg { get; set; } = Text(size?.MaxKg);
    [ObservableProperty] public partial string Sort { get; set; } = size?.Sort.ToString() ?? "";
    [ObservableProperty] public partial bool Active { get; set; } = size?.Active ?? true;

    static string Text(decimal? v) => v is { } n ? Fmt.Num(n, 1) : "";

    [RelayCommand]
    Task SaveAsync()
    {
        object? Num(string t) => t.Trim().Length == 0 ? null : Fmt.ParseNumber(t) is { } n ? n : t;
        var body = new Dictionary<string, object?>
        {
            ["code"] = Code.Trim().ToUpperInvariant(), ["name"] = Name.Trim(), ["width_cm"] = Num(WidthCm), ["depth_cm"] = Num(DepthCm),
            ["height_cm"] = Num(HeightCm), ["max_kg"] = Num(MaxKg), ["active"] = Active,
        };
        if (Sort.Trim().Length > 0)
        {
            if (!int.TryParse(Sort.Trim(), out var sort) || sort < 0)
            {
                Fail("sort", "Nem negatív egész számot adj meg.");
                return Task.CompletedTask;
            }
            body["sort"] = sort;
        }
        return SubmitAsync(async () =>
        {
            var res = Size is { } s
                ? await Api.PatchAsync<LocationSize>($"api/settings/sizes/{s.Id}", body)
                : await Api.PostAsync<LocationSize>("api/settings/sizes", body);
            Shell.Toast(Size is null ? $"{res.Code} méret létrehozva." : "Méret mentve.", ToastKind.Success);
            if (!string.IsNullOrEmpty(res.Warning)) Shell.Toast(res.Warning, ToastKind.Warning);
            await Shell.RefreshMetaAsync();
            await Shell.BackAsync();
        });
    }
}

// One location: code, zone, size, kind, fixed client, pick order, note, active; who occupies it and
// its stock; deleting while it has no history.
public sealed partial class LocationFormViewModel(ShellViewModel shell, LocationsTab tab, int? id) : PartnerForm(shell)
{
    public int? Id { get; } = id;
    public bool IsNew => Id is null;
    public override string Title => Data is { } l ? $"Raktárhely: {l.Code}" : "Új raktárhely";
    public override string? Module => "settings";
    public override double DialogWidth => 720;
    public string SubmitText => IsNew ? "Létrehozás" : "Mentés";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(Occupied), nameof(OccupiedText), nameof(IsFree), nameof(CanToggleActive), nameof(ActiveHint),
        nameof(Stock), nameof(HasStock), nameof(CanDelete), nameof(NotDeletable))]
    public partial SettingsLocationDetail? Data { get; set; }

    [ObservableProperty] public partial IReadOnlyList<OrderChoice> SizeChoices { get; set; } = [];
    [ObservableProperty] public partial string Code { get; set; } = "";
    [ObservableProperty] public partial string Zone { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? Size { get; set; }
    [ObservableProperty] public partial OrderChoice? KindChoice { get; set; }
    [ObservableProperty] public partial OrderChoice? Partner { get; set; }
    [ObservableProperty] public partial string PickSequence { get; set; } = "0";
    [ObservableProperty] public partial string Note { get; set; } = "";
    [ObservableProperty] public partial bool Active { get; set; } = true;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSizeWarning))]
    public partial string? SizeWarning { get; set; }

    public IReadOnlyList<OrderChoice> Kinds { get; } = tab.KindChoices;
    public IReadOnlyList<OrderChoice> Partners { get; } = [new(null, "Nincs, bármelyik ügyfélé lehet"), .. tab.ClientChoices];
    public bool NoActiveSize => !tab.SizeList.Any((s) => s.Active);
    public bool Occupied => Data?.OccupantId is not null;
    public bool IsFree => Data is { OccupantId: null };
    public string OccupiedText => Data is { OccupantId: not null } l ? $"Most {l.OccupantName} áruja van rajta: {Fmt.Int(l.Qty)} db, {Fmt.Int(l.Products)} cikk." : "";
    bool CanDeleteRight => Shell.Me?.Can("settings", "delete") == true;
    public bool CanToggleActive => !IsNew && Shell.Me?.Can("settings", "edit") == true && ((CanDeleteRight && !Occupied) || Data?.Active == false);
    public string ActiveHint => Occupied && Data!.Active ? "Csak üres raktárhely inaktiválható." : !CanDeleteRight && Data?.Active == true ? "Az inaktiváláshoz Beállítások törlése jog kell." : "";
    public IReadOnlyList<LocationStockLine> Stock => Data?.Stock ?? [];
    public bool HasStock => Stock.Count > 0;
    public bool CanDelete => Data is { Deletable: true, OccupantId: null } && CanDeleteRight;
    public bool NotDeletable => Data is not null && CanDeleteRight && !CanDelete;
    public bool HasSizeWarning => SizeWarning is not null;
    public bool ReadOnly => !IsNew && Shell.Me?.Can("settings", "edit") != true;
    public bool CanSave => !ReadOnly;

    protected override string? ErrorKey(string property) => property switch
    {
        nameof(Size) => "size_id",
        nameof(KindChoice) => "kind",
        nameof(Partner) => "partner_id",
        _ => base.ErrorKey(property),
    };

    public override async Task LoadAsync()
    {
        if (Id is not { } id)
        {
            if (SizeChoices.Count == 0)
            {
                SizeChoices = tab.ActiveSizeChoices();
                KindChoice = Kinds.FirstOrDefault((k) => k.Key == "storage") ?? Kinds.FirstOrDefault();
                Partner = Partners[0];
            }
            return;
        }
        var l = await Api.GetAsync<SettingsLocationDetail>($"api/settings/locations/{id}");
        Data = l;
        SizeChoices = tab.ActiveSizeChoices(l.SizeId);
        Code = l.Code;
        Zone = l.Zone ?? "";
        Size = SizeChoices.FirstOrDefault((s) => s.Key == l.SizeId.ToString());
        KindChoice = Kinds.FirstOrDefault((k) => k.Key == l.Kind);
        Partner = Partners.FirstOrDefault((p) => p.Key == l.PartnerId?.ToString()) ?? Partners[0];
        PickSequence = l.PickSequence.ToString();
        Note = l.Note ?? "";
        Active = l.Active;
        Errors = [];
        SizeWarning = null;
    }

    partial void OnSizeChanged(OrderChoice? value) => SizeWarning = Occupied && value is not null && value.Key != Data!.SizeId.ToString()
        ? "A raktárhelyen készlet van. A méret módosítható, de a tárolási díj a mai naptól az új méret szerint számolódik." : null;

    [RelayCommand]
    async Task SaveAsync()
    {
        if (!int.TryParse(PickSequence.Trim().Length == 0 ? "0" : PickSequence.Trim(), out var seq) || seq < 0)
        {
            Fail("pick_sequence", "Nem negatív egész számot adj meg.");
            return;
        }
        if (Data is { OccupantId: not null } l && Size?.Key != l.SizeId.ToString() && !await Shell.ConfirmAsync("Foglalt raktárhely mérete",
            $"A(z) {l.Code} helyen {l.OccupantName} áruja van. A tárolási díj a mai naptól az új méret szerint számolódik. Módosítod?", "Módosítás")) return;
        await SubmitAsync(async () =>
        {
            var body = new Dictionary<string, object?>
            {
                ["code"] = Code.Trim(), ["zone"] = Zone.Trim(), ["size_id"] = Size?.Key is { } s ? int.Parse(s) : null, ["kind"] = KindChoice?.Key,
                ["partner_id"] = Partner?.Key is { } p ? int.Parse(p) : null, ["pick_sequence"] = seq, ["note"] = Note.Trim(),
            };
            if (!IsNew) body["active"] = Active;
            var res = Id is { } id
                ? await Api.PatchAsync<SettingsLocation>($"api/settings/locations/{id}", body)
                : await Api.PostAsync<SettingsLocation>("api/settings/locations", body);
            Shell.Toast(IsNew ? $"{res.Code} létrehozva." : $"{res.Code} mentve.", ToastKind.Success);
            if (!string.IsNullOrEmpty(res.Warning)) Shell.Toast(res.Warning, ToastKind.Warning);
            await Shell.BackAsync();
        });
    }

    [RelayCommand]
    async Task DeleteAsync()
    {
        if (Data is not { } l) return;
        if (!await Shell.ConfirmAsync("Raktárhely törlése", $"Biztosan törlöd a(z) {l.Code} raktárhelyet?", "Törlés", danger: true)) return;
        await RunAsync(async () =>
        {
            await Api.DeleteAsync($"api/settings/locations/{l.Id}");
            Shell.Toast($"{l.Code} törölve.", ToastKind.Success);
            await Shell.BackAsync();
        });
    }
}

// Tömeges létrehozás: codes from a pattern (prefixes x racks x levels x positions), with a preview
// of the new codes and the existing ones that are left out.
public sealed partial class BulkCreateViewModel : PartnerForm
{
    public BulkCreateViewModel(ShellViewModel shell, LocationsTab tab) : base(shell)
    {
        SizeChoices = tab.ActiveSizeChoices();
        Kinds = tab.KindChoices;
        Partners = [new(null, "Nincs"), .. tab.ClientChoices];
        KindChoice = Kinds.FirstOrDefault((k) => k.Key == "storage") ?? Kinds.FirstOrDefault();
        Partner = Partners[0];
        Separator = Separators[0];
        Pad = Pads[1];
        ready = true;
    }

    public override string Title => "Raktárhelyek tömeges létrehozása";
    public override string? Module => "settings";
    public override double DialogWidth => 860;

    public static readonly IReadOnlyList<OrderChoice> Separators =
        [new("-", "Kötőjel: A-01-01"), new(".", "Pont: A.01.01"), new("/", "Perjel: A/01/01"), new("_", "Aláhúzás: A_01_01"), new("", "Nincs: A0101")];
    public static readonly IReadOnlyList<OrderChoice> Pads = [new("1", "1 jegy (1)"), new("2", "2 jegy (01)"), new("3", "3 jegy (001)"), new("4", "4 jegy (0001)")];

    public IReadOnlyList<OrderChoice> SizeChoices { get; }
    public IReadOnlyList<OrderChoice> Kinds { get; }
    public IReadOnlyList<OrderChoice> Partners { get; }

    [ObservableProperty] public partial string Prefixes { get; set; } = "A";
    [ObservableProperty] public partial OrderChoice Separator { get; set; }
    [ObservableProperty] public partial OrderChoice Pad { get; set; }
    [ObservableProperty] public partial string RackFrom { get; set; } = "1";
    [ObservableProperty] public partial string RackTo { get; set; } = "10";
    [ObservableProperty] public partial string LevelFrom { get; set; } = "1";
    [ObservableProperty] public partial string LevelTo { get; set; } = "4";
    [ObservableProperty] public partial string PosFrom { get; set; } = "";
    [ObservableProperty] public partial string PosTo { get; set; } = "";
    [ObservableProperty] public partial OrderChoice? Size { get; set; }
    [ObservableProperty] public partial OrderChoice? KindChoice { get; set; }
    [ObservableProperty] public partial OrderChoice? Partner { get; set; }
    [ObservableProperty] public partial string Zone { get; set; } = "";
    [ObservableProperty] public partial string PickStart { get; set; } = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(SubmitText), nameof(CanCreate))]
    public partial int CreateCount { get; set; }

    [ObservableProperty] public partial string? PreviewText { get; set; }
    [ObservableProperty] public partial string PreviewTone { get; set; } = "info";
    [ObservableProperty] public partial IReadOnlyList<string> PreviewCodes { get; set; } = [];
    [ObservableProperty] public partial string? ExistingText { get; set; }

    public string SubmitText => CreateCount > 0 ? $"Létrehozás ({Fmt.Int(CreateCount)} db)" : "Létrehozás";
    public bool CanCreate => CreateCount > 0;

    readonly bool ready;
    CancellationTokenSource? pending;

    // Every change of the pattern asks the server for a fresh preview (after a short pause).
    protected override void OnPropertyChanged(System.ComponentModel.PropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        if (!ready || e.PropertyName is nameof(CreateCount) or nameof(PreviewText) or nameof(PreviewTone) or nameof(PreviewCodes) or nameof(ExistingText)
            or nameof(SubmitText) or nameof(CanCreate) or nameof(Errors) or nameof(Error) or nameof(IsLoading) or nameof(LoadError)) return;
        pending?.Cancel();
        pending = new CancellationTokenSource();
        _ = PreviewAsync(pending.Token);
    }

    protected override string? ErrorKey(string property) => property switch
    {
        nameof(Size) => "size_id",
        nameof(Pad) => "pad",
        _ => base.ErrorKey(property),
    };

    Dictionary<string, object?> Body(bool preview)
    {
        object? Int(string t) => t.Trim().Length == 0 ? null : int.TryParse(t.Trim(), out var n) ? n : t;
        return new()
        {
            ["prefixes"] = Prefixes.Trim(), ["separator"] = Separator.Key ?? "", ["pad"] = int.Parse(Pad.Key!), ["rack_from"] = Int(RackFrom),
            ["rack_to"] = Int(RackTo), ["level_from"] = Int(LevelFrom), ["level_to"] = Int(LevelTo), ["pos_from"] = Int(PosFrom), ["pos_to"] = Int(PosTo),
            ["size_id"] = Size?.Key is { } s ? int.Parse(s) : null, ["kind"] = KindChoice?.Key, ["partner_id"] = Partner?.Key is { } p ? int.Parse(p) : null,
            ["zone"] = Zone.Trim(), ["pick_start"] = Int(PickStart), ["preview"] = preview,
        };
    }

    public override Task LoadAsync() => PreviewAsync(CancellationToken.None);

    async Task PreviewAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(300, ct);
            if (Size is null)
            {
                Show(0, "Válassz méretet az előnézethez.", "info", [], null);
                return;
            }
            var r = await Api.PostAsync<BulkPreview>("api/settings/locations/bulk", Body(true), ct);
            if (ct.IsCancellationRequested) return;
            var codes = r.Codes.Count > 40 ? [.. r.Codes.Take(32), "...", .. r.Codes.TakeLast(4)] : r.Codes;
            Show(r.Create, $"{Fmt.Int(r.Create)} új raktárhely" + (r.Existing.Count > 0 ? $", {Fmt.Int(r.Existing.Count)} már létezik, kimarad." : "."), "ok", codes,
                r.Existing.Count > 0 ? $"Kimarad: {string.Join(", ", r.Existing.Take(12))}{(r.Existing.Count > 12 ? " és a többi" : "")}" : null);
        }
        catch (OperationCanceledException)
        {
        }
        catch (ApiException e)
        {
            if (!ct.IsCancellationRequested) Show(0, e.Message, "warn", [], null);
        }
    }

    void Show(int count, string text, string tone, IReadOnlyList<string> codes, string? existing)
    {
        CreateCount = count;
        PreviewText = text;
        PreviewTone = tone;
        PreviewCodes = codes;
        ExistingText = existing;
    }

    [RelayCommand]
    Task SaveAsync() => !CanCreate ? Task.CompletedTask : SubmitAsync(async () =>
    {
        pending?.Cancel();
        var res = await Api.PostAsync<BulkCreated>("api/settings/locations/bulk", Body(false));
        Shell.Toast($"{Fmt.Int(res.Created)} raktárhely létrehozva.", ToastKind.Success);
        await Shell.BackAsync();
    });
}

// The selected locations at once: the size only, or kind, fixed client, zone and pick order
// (only what is filled in changes).
public sealed partial class BulkChangeViewModel : PartnerForm
{
    public BulkChangeViewModel(ShellViewModel shell, LocationsTab tab, bool sizeOnly) : base(shell)
    {
        this.tab = tab;
        SizeOnly = sizeOnly;
        SizeChoices = tab.ActiveSizeChoices();
        Kinds = [new(null, "Változatlan"), .. tab.KindChoices];
        Partners = [new(null, "Változatlan"), new("none", "Nincs fix partner"), .. tab.ClientChoices];
        KindChoice = Kinds[0];
        Partner = Partners[0];
    }

    readonly LocationsTab tab;
    public bool SizeOnly { get; }
    public bool IsOther => !SizeOnly;
    public override string Title => SizeOnly ? "Méret módosítása" : "Kijelöltek módosítása";
    public override string? Module => "settings";
    public override double DialogWidth => SizeOnly ? 480 : 640;
    public string Lead => SizeOnly
        ? $"A kijelölt {Fmt.Int(tab.SelectedCount)} raktárhely mérete erre változik:"
        : $"A kijelölt {Fmt.Int(tab.SelectedCount)} raktárhelyen csak azt módosítjuk, amit itt megadsz.";
    public string SubmitText => $"Módosítás ({Fmt.Int(tab.SelectedCount)} db)";
    public IReadOnlyList<OrderChoice> SizeChoices { get; }
    public IReadOnlyList<OrderChoice> Kinds { get; }
    public IReadOnlyList<OrderChoice> Partners { get; }

    [ObservableProperty] public partial OrderChoice? Size { get; set; }
    [ObservableProperty] public partial OrderChoice? KindChoice { get; set; }
    [ObservableProperty] public partial OrderChoice? Partner { get; set; }
    [ObservableProperty] public partial string Zone { get; set; } = "";
    [ObservableProperty] public partial string PickSequence { get; set; } = "";

    protected override string? ErrorKey(string property) => property == nameof(Size) ? "size_id" : base.ErrorKey(property);

    [RelayCommand]
    Task SaveAsync()
    {
        var body = new Dictionary<string, object?> { ["ids"] = tab.SelectedIds.ToList() };
        if (SizeOnly)
        {
            if (Size?.Key is not { } s)
            {
                Fail("size_id", "Válassz méretet.");
                return Task.CompletedTask;
            }
            body["size_id"] = int.Parse(s);
        }
        else
        {
            if (KindChoice?.Key is { } k) body["kind"] = k;
            if (Partner?.Key is { } p) body["partner_id"] = p == "none" ? null : int.Parse(p);
            if (Zone.Trim().Length > 0) body["zone"] = Zone.Trim();
            if (PickSequence.Trim().Length > 0)
            {
                if (!int.TryParse(PickSequence.Trim(), out var seq) || seq < 0)
                {
                    Fail("pick_sequence", "Nem negatív egész számot adj meg.");
                    return Task.CompletedTask;
                }
                body["pick_sequence"] = seq;
            }
            if (body.Count == 1)
            {
                Error = "Adj meg legalább egy módosítást.";
                return Task.CompletedTask;
            }
        }
        return SubmitAsync(async () =>
        {
            var res = await Api.PostAsync<BulkUpdated>("api/settings/locations/bulk-update", body);
            Shell.Toast($"{Fmt.Int(res.Updated)} raktárhely módosítva.{(res.OccupiedResized > 0 ? $" Ebből {Fmt.Int(res.OccupiedResized)} foglalt." : "")}", ToastKind.Success);
            tab.ClearSelection();
            await Shell.BackAsync();
            await tab.ShowSkippedAsync("Kimaradt raktárhelyek", res.Skipped);
        });
    }
}
