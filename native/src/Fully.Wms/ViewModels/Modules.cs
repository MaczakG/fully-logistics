namespace Fully.Wms.ViewModels;

// The menu: the same modules, groups and wording as the web app's side menu (app/public/assets/js/
// core/app.js MENU). Phone: only the warehouse group (the PDA).
public sealed record ModuleDef(string Key, string Label, string Hint, string Icon, string Group, Func<ShellViewModel, PageViewModel> Open)
{
    public bool OnPhone => Group == Modules.Warehouse;
}

public static class Modules
{
    public const string Warehouse = "Raktár";
    public const string Commercial = "Kereskedelem";
    public const string System = "Rendszer";

    public static readonly ModuleDef[] All =
    [
        new("inbound", "Betárolás", "Átvétel, polcra helyezés", "IconInbound", Warehouse, (s) => new PlaceholderViewModel(s, "inbound", "Betárolás")),
        new("orders", "Megrendelések", "Nyitott rendelések", "IconOrders", Warehouse, (s) => new PlaceholderViewModel(s, "orders", "Megrendelések")),
        new("picking", "Komissió", "Kiszedés, csomagolás", "IconPicking", Warehouse, (s) => new PlaceholderViewModel(s, "picking", "Komissió")),
        new("counts", "Leltár", "Leltárszámlálás", "IconCounts", Warehouse, (s) => new PlaceholderViewModel(s, "counts", "Leltár")),
        new("stock", "Készlet", "Cikk vagy hely keresése", "IconStock", Warehouse, (s) => new PlaceholderViewModel(s, "stock", "Készlet")),
        new("history", "Rendeléstörténet", "Lezárt rendelések, visszáru", "IconHistory", Warehouse, (s) => new PlaceholderViewModel(s, "history", "Rendeléstörténet")),
        new("transport", "Fuvarszervezés", "Futárátvétel, fuvarok", "IconTransport", Warehouse, (s) => new PlaceholderViewModel(s, "transport", "Fuvarszervezés")),
        new("partners", "Partnerek", "Ügyfelek, beszállítók", "IconPartners", Commercial, (s) => new PlaceholderViewModel(s, "partners", "Partnerek")),
        new("quotes", "Ajánlatkészítő", "Árajánlatok", "IconQuotes", Commercial, (s) => new PlaceholderViewModel(s, "quotes", "Ajánlatkészítő")),
        new("billing", "Elszámolás", "Havi elszámolás", "IconBilling", Commercial, (s) => new PlaceholderViewModel(s, "billing", "Elszámolás")),
        new("settings", "Beállítások", "Raktárhelyek, beállítások", "IconSettings", System, (s) => new PlaceholderViewModel(s, "settings", "Beállítások")),
        new("users", "Felhasználók", "Munkatársak, jogosultságok", "IconUsers", System, (s) => new PlaceholderViewModel(s, "users", "Felhasználók")),
    ];

    public static ModuleDef? Find(string key) => All.FirstOrDefault((m) => m.Key == key);
}
