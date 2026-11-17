using Avalonia.Data.Converters;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Users;

public static class UserFormat
{
    public static readonly IValueConverter DateTime = new FuncValueConverter<string?, string>((s) => Fmt.DateTime(s));

    // "127.0.0.1, FullyWms/1.0.0 (ez a munkamenet)"
    public static readonly IValueConverter Device = new FuncValueConverter<UserSession?, string>((s) => s is null ? ""
        : $"{(string.IsNullOrEmpty(s.Ip) ? "ismeretlen IP" : s.Ip)}, {Trim(s.UserAgent)}{(s.Current ? " (ez a munkamenet)" : "")}");

    static string Trim(string? agent) => agent is { Length: > 60 } a ? a[..60] : agent ?? "";
}
