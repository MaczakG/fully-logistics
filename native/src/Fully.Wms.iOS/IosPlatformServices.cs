using Fully.Wms.Core;
using Fully.Wms.Services;
using Foundation;
using UIKit;

namespace Fully.Wms.iOS;

// The PDA on the phone: settings in the app's Library folder, the camera as barcode reader,
// documents through the share sheet (print, AirDrop, Files ...).
public sealed class IosPlatformServices : IPlatformServices
{
    public bool IsPhone => true;

    public string? SettingsFolder { get; } = Path.Combine(
        NSFileManager.DefaultManager.GetUrls(NSSearchPathDirectory.ApplicationSupportDirectory, NSSearchPathDomain.User)[0].Path!,
        "FullyWms");

    public IBarcodeScanner? Scanner { get; } = new CameraScanner();

    public Task OpenFileAsync(DownloadedFile file)
    {
        var folder = Path.Combine(Path.GetTempPath(), "FullyWms");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, DefaultPlatformServices.SafeName(file.FileName));
        File.WriteAllBytes(path, file.Bytes);

        var top = TopViewController();
        if (top is null) return Task.CompletedTask;
        var share = new UIActivityViewController([NSUrl.FromFilename(path)], null);
        if (share.PopoverPresentationController is { } popover)
        {
            // iPad: the sheet needs an anchor.
            popover.SourceView = top.View;
            popover.SourceRect = new CoreGraphics.CGRect(top.View!.Bounds.GetMidX(), top.View.Bounds.GetMidY(), 1, 1);
            popover.PermittedArrowDirections = 0;
        }
        top.PresentViewController(share, true, null);
        return Task.CompletedTask;
    }

    // The view controller on top (the app's, or one it presented).
    internal static UIViewController? TopViewController()
    {
        var window = UIApplication.SharedApplication.ConnectedScenes
            .OfType<UIWindowScene>()
            .SelectMany((s) => s.Windows)
            .FirstOrDefault((w) => w.IsKeyWindow);
        var vc = window?.RootViewController;
        while (vc?.PresentedViewController is { } presented) vc = presented;
        return vc;
    }
}
