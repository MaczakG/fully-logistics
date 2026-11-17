using Avalonia;
using Avalonia.Controls;

namespace Fully.Wms.Controls;

// Lays its children out in equal columns, row by row; each row is as tall as its tallest child
// (a UniformGrid makes every row as tall as the tallest of all).
//   <ItemsPanelTemplate><ctl:ColumnsPanel Columns="2" /></ItemsPanelTemplate>
public sealed class ColumnsPanel : Panel
{
    public static readonly StyledProperty<int> ColumnsProperty = AvaloniaProperty.Register<ColumnsPanel, int>(nameof(Columns), 2);

    static ColumnsPanel() => AffectsMeasure<ColumnsPanel>(ColumnsProperty);

    public int Columns
    {
        get => GetValue(ColumnsProperty);
        set => SetValue(ColumnsProperty, value);
    }

    int Count => Math.Max(Columns, 1);

    protected override Size MeasureOverride(Size availableSize)
    {
        var n = Count;
        var width = double.IsInfinity(availableSize.Width) ? double.PositiveInfinity : availableSize.Width / n;
        double height = 0, row = 0, widest = 0;
        for (var i = 0; i < Children.Count; i++)
        {
            var child = Children[i];
            child.Measure(new Size(width, double.PositiveInfinity));
            row = Math.Max(row, child.DesiredSize.Height);
            widest = Math.Max(widest, child.DesiredSize.Width);
            if (i % n == n - 1 || i == Children.Count - 1)
            {
                height += row;
                row = 0;
            }
        }
        return new Size(double.IsInfinity(width) ? widest * n : availableSize.Width, height);
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var n = Count;
        var width = finalSize.Width / n;
        double y = 0;
        for (var start = 0; start < Children.Count; start += n)
        {
            var end = Math.Min(start + n, Children.Count);
            double row = 0;
            for (var i = start; i < end; i++) row = Math.Max(row, Children[i].DesiredSize.Height);
            for (var i = start; i < end; i++) Children[i].Arrange(new Rect((i - start) * width, y, width, row));
            y += row;
        }
        return finalSize;
    }
}
