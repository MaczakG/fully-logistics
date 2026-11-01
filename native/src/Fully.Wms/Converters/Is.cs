using System.Globalization;
using Avalonia.Data.Converters;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Converters;

// Small converters for bindings ({x:Static c:Is.Profile} ...).
public static class Is
{
    public static readonly IValueConverter Profile = new FuncValueConverter<object?, bool>((v) => v is ProfileViewModel);
    public static readonly IValueConverter Upper = new FuncValueConverter<string?, string>((v) => (v ?? "").ToUpper(CultureInfo.GetCultureInfo("hu-HU")));
    public static readonly IValueConverter Positive = new FuncValueConverter<decimal, bool>((v) => v > 0);
    public static readonly IValueConverter Zero = new FuncValueConverter<int, bool>((v) => v == 0);
    public static readonly IValueConverter Not = new FuncValueConverter<bool, bool>((v) => !v);
}
