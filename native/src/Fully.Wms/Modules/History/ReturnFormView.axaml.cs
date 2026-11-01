using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;

namespace Fully.Wms.Modules.History;

public partial class ReturnFormView : UserControl
{
    public ReturnFormView() => InitializeComponent();

    // Photos from the disk (desktop) or the photo library (phone).
    async void PickPhotos(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not ReturnFormViewModel vm || TopLevel.GetTopLevel(this) is not { } top) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Fotók a visszáruról",
            AllowMultiple = true,
            FileTypeFilter = [FilePickerFileTypes.ImageAll],
        });
        foreach (var f in files)
        {
            await using var stream = await f.OpenReadAsync();
            using var mem = new MemoryStream();
            await stream.CopyToAsync(mem);
            vm.AddPhoto(f.Name, mem.ToArray());
        }
    }
}
