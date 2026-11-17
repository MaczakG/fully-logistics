using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;

namespace Fully.Wms.Modules.Partners;

public partial class DocumentUploadView : UserControl
{
    public DocumentUploadView() => InitializeComponent();

    async void PickFile(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not DocumentUploadViewModel vm || TopLevel.GetTopLevel(this) is not { } top) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions { Title = "Dokumentum feltöltése", AllowMultiple = false });
        if (files.Count == 0) return;
        await using var stream = await files[0].OpenReadAsync();
        using var mem = new MemoryStream();
        await stream.CopyToAsync(mem);
        vm.SetFile(files[0].Name, mem.ToArray());
    }
}
