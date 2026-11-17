using Avalonia.Data.Converters;
using Fully.Wms.Core.Models;

namespace Fully.Wms.Modules.Inbound;

public static class InboundCompleteFormat
{
    public static readonly IValueConverter Issue = new FuncValueConverter<InboundLine?, string>((l) => l is null ? "" : InboundCompleteViewModel.IssueText(l));
}
