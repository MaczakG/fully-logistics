using Avalonia;
using Avalonia.Controls;

namespace Fully.Wms.Controls;

// A status as a coloured tag, with the server's label and tone:
//   <ctl:StatusTag Group="inbound" Status="{Binding Status}" />
public sealed class StatusTag : Border
{
    public static readonly StyledProperty<string> GroupProperty = AvaloniaProperty.Register<StatusTag, string>(nameof(Group), "");
    public static readonly StyledProperty<string?> StatusProperty = AvaloniaProperty.Register<StatusTag, string?>(nameof(Status));

    readonly TextBlock text = new();

    public StatusTag()
    {
        Classes.Add("tag");
        Child = text;
    }

    public string Group
    {
        get => GetValue(GroupProperty);
        set => SetValue(GroupProperty, value);
    }

    public string? Status
    {
        get => GetValue(StatusProperty);
        set => SetValue(StatusProperty, value);
    }

    protected override Type StyleKeyOverride => typeof(Border);

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property != GroupProperty && change.Property != StatusProperty) return;
        var s = App.Meta.Status(Group, Status);
        text.Text = s.Label;
        foreach (var tone in new[] { "ok", "warn", "danger", "info", "hi" }) Classes.Remove(tone);
        var cls = s.Tone switch { "accent" => "hi", "neutral" => null, var t => t };
        if (cls is not null) Classes.Add(cls);
        IsVisible = !string.IsNullOrEmpty(Status);
    }
}
