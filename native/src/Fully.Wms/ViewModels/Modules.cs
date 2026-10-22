namespace Fully.Wms.ViewModels;

// The menu: the same modules, groups and wording as the web app's side menu (app/public/assets/js/
// core/app.js MENU). Phone: only the warehouse group (the PDA).
public sealed class ModuleDef(string key, string label, string hint, string icon, string group)
{
    public string Key { get; } = key;
    public string Label { get; } = label;
    public string Hint { get; } = hint;
    public string Icon { get; } = icon;
    public string Group { get; } = group;
    public bool OnPhone => Group == Modules.Warehouse;

    // The module's first page. Set by the module itself (Modules.Use); until then a placeholder.
    public Func<ShellViewModel, PageViewModel> Open { get; internal set; } = (s) => new PlaceholderViewModel(s, key, label);
}

public static class Modules
{
    public const string Warehouse = "Raktár";
    public const string Commercial = "Kereskedelem";
    public const string System = "Rendszer";

    public static readonly ModuleDef[] All =
    [
        new("inbound", "Betárolás", "Átvétel, polcra helyezés", "IconInbound", Warehouse),
        new("orders", "Megrendelések", "Nyitott rendelések", "IconOrders", Warehouse),
        new("picking", "Komissió", "Kiszedés, csomagolás", "IconPicking", Warehouse),
        new("counts", "Leltár", "Leltárszámlálás", "IconCounts", Warehouse),
        new("stock", "Készlet", "Cikk vagy hely keresése", "IconStock", Warehouse),
        new("history", "Rendeléstörténet", "Lezárt rendelések, visszáru", "IconHistory", Warehouse),
        new("transport", "Fuvarszervezés", "Futárátvétel, fuvarok", "IconTransport", Warehouse),
        new("partners", "Partnerek", "Ügyfelek, beszállítók", "IconPartners", Commercial),
        new("quotes", "Ajánlatkészítő", "Árajánlatok", "IconQuotes", Commercial),
        new("billing", "Elszámolás", "Havi elszámolás", "IconBilling", Commercial),
        new("settings", "Beállítások", "Raktárhelyek, beállítások", "IconSettings", System),
        new("users", "Felhasználók", "Munkatársak, jogosultságok", "IconUsers", System),
    ];

    public static ModuleDef? Find(string key) => All.FirstOrDefault((m) => m.Key == key);

    // Each module registers its first page and its views from its own file, with a module
    // initializer, so modules can be added without touching this list:
    //   [ModuleInitializer] internal static void Register() { Modules.Use("stock", (s) => new StockViewModel(s)); ... }
    public static void Use(string key, Func<ShellViewModel, PageViewModel> open) =>
        (Find(key) ?? throw new ArgumentException($"Ismeretlen modul: {key}", nameof(key))).Open = open;
}
