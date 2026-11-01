using Avalonia.Data.Converters;

namespace Fully.Wms.Modules.Common;

public static class CsvFormat
{
    public static readonly IValueConverter Columns = new FuncValueConverter<IReadOnlyList<string>?, string>((c) => c is null ? "" : string.Join("; ", c));
    public static readonly IValueConverter NonZero = new FuncValueConverter<int, bool>((n) => n != 0);
    public static readonly IValueConverter IsOk = new FuncValueConverter<string?, bool>((t) => t == "ok");
    public static readonly IValueConverter IsWarn = new FuncValueConverter<string?, bool>((t) => t == "warn");
    public static readonly IValueConverter IsDanger = new FuncValueConverter<string?, bool>((t) => t == "danger");
}
