using Fully.Wms.Core;

namespace Fully.Wms.Services;

// What differs between the desktop and the phone. The platform project sets App.Platform.
public interface IPlatformServices
{
    // The PDA: phone screens, warehouse modules only, camera scanning.
    bool IsPhone { get; }

    // Where the settings file lives (null: the user's application data folder).
    string? SettingsFolder { get; }

    // A camera barcode reader, or null where there is none (the desktop uses a USB scanner, which
    // types into the focused field like a keyboard).
    IBarcodeScanner? Scanner { get; }

    // Shows a downloaded document (PDF label, delivery note, CSV): opens it on the desktop, shares
    // or previews it on the phone.
    Task OpenFileAsync(DownloadedFile file);
}

public interface IBarcodeScanner
{
    // Opens the camera and answers the first code read, or null when the user closes it.
    Task<string?> ScanAsync(CancellationToken ct = default);
}

// The desktop: files go to the temporary folder and open with the system's default program.
public class DefaultPlatformServices : IPlatformServices
{
    public virtual bool IsPhone => false;
    public virtual string? SettingsFolder => null;
    public virtual IBarcodeScanner? Scanner => null;

    public virtual Task OpenFileAsync(DownloadedFile file)
    {
        var folder = Path.Combine(Path.GetTempPath(), "FullyWms");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, SafeName(file.FileName));
        File.WriteAllBytes(path, file.Bytes);
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
        return Task.CompletedTask;
    }

    public static string SafeName(string name)
    {
        var bad = Path.GetInvalidFileNameChars();
        var clean = new string(name.Select((c) => bad.Contains(c) ? '_' : c).ToArray()).Trim();
        return clean.Length > 0 ? clean : "dokumentum";
    }
}
