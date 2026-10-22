using AVFoundation;
using CoreFoundation;
using CoreGraphics;
using Foundation;
using Fully.Wms.Services;
using UIKit;

namespace Fully.Wms.iOS;

// Reads a barcode with the camera: a full-screen camera view that closes itself on the first code
// (EAN, Code 128, Code 39, QR, DataMatrix ...). The answer is the code as text, or null when the
// user closes the view.
public sealed class CameraScanner : IBarcodeScanner
{
    public async Task<string?> ScanAsync(CancellationToken ct = default)
    {
        var status = AVCaptureDevice.GetAuthorizationStatus(AVAuthorizationMediaType.Video);
        var allowed = status == AVAuthorizationStatus.Authorized
            || (status == AVAuthorizationStatus.NotDetermined && await AVCaptureDevice.RequestAccessForMediaTypeAsync(AVAuthorizationMediaType.Video));
        if (!allowed)
            throw new InvalidOperationException("A kamerához nincs engedély. Engedélyezd: Beállítások > Fully PDA > Kamera.");

        var top = IosPlatformServices.TopViewController() ?? throw new InvalidOperationException("A kamera most nem nyitható meg.");
        var scanner = new ScannerViewController();
        scanner.ModalPresentationStyle = UIModalPresentationStyle.FullScreen;
        top.PresentViewController(scanner, true, null);
        using (ct.Register(() => scanner.Finish(null)))
            return await scanner.Result;
    }
}

sealed class ScannerViewController : UIViewController
{
    readonly TaskCompletionSource<string?> result = new(TaskCreationOptions.RunContinuationsAsynchronously);
    readonly AVCaptureSession session = new();
    AVCaptureVideoPreviewLayer? preview;
    MetadataDelegate? metadataDelegate;
    UIView? frameView;

    public Task<string?> Result => result.Task;

    public override void ViewDidLoad()
    {
        base.ViewDidLoad();
        View!.BackgroundColor = UIColor.Black;

        var device = AVCaptureDevice.GetDefaultDevice(AVMediaTypes.Video);
        var input = device is null ? null : AVCaptureDeviceInput.FromDevice(device, out _);
        if (input is null || !session.CanAddInput(input))
        {
            ShowMessage("A kamera nem érhető el.");
        }
        else
        {
            session.AddInput(input);
            var output = new AVCaptureMetadataOutput();
            if (session.CanAddOutput(output))
            {
                session.AddOutput(output);
                metadataDelegate = new MetadataDelegate(this);
                output.SetDelegate(metadataDelegate, DispatchQueue.MainQueue);
                // Only the types the device supports may be asked for.
                var wanted = AVMetadataObjectType.EAN13Code | AVMetadataObjectType.EAN8Code | AVMetadataObjectType.UPCECode
                    | AVMetadataObjectType.Code128Code | AVMetadataObjectType.Code39Code | AVMetadataObjectType.Code93Code
                    | AVMetadataObjectType.ITF14Code | AVMetadataObjectType.Interleaved2of5Code
                    | AVMetadataObjectType.QRCode | AVMetadataObjectType.DataMatrixCode;
                output.MetadataObjectTypes = output.AvailableMetadataObjectTypes & wanted;
            }
            preview = new AVCaptureVideoPreviewLayer(session) { VideoGravity = AVLayerVideoGravity.ResizeAspectFill };
            View.Layer.AddSublayer(preview);
        }

        // Aiming frame in hi-vis yellow
        frameView = new UIView { UserInteractionEnabled = false };
        frameView.Layer.BorderColor = new CGColor(0.91f, 0.745f, 0.235f, 1f);
        frameView.Layer.BorderWidth = 3;
        View.AddSubview(frameView);

        var hint = new UILabel
        {
            Text = "Tartsd a vonalkódot a keretbe",
            TextColor = UIColor.White,
            TextAlignment = UITextAlignment.Center,
            Font = UIFont.BoldSystemFontOfSize(17),
            TranslatesAutoresizingMaskIntoConstraints = false,
        };
        View.AddSubview(hint);

        var close = new UIButton(UIButtonType.System) { TranslatesAutoresizingMaskIntoConstraints = false };
        close.SetTitle("Bezárás", UIControlState.Normal);
        close.SetTitleColor(new UIColor(0.07f, 0.08f, 0.09f, 1f), UIControlState.Normal);
        close.TitleLabel!.Font = UIFont.BoldSystemFontOfSize(18);
        close.BackgroundColor = new UIColor(0.91f, 0.745f, 0.235f, 1f);
        close.TouchUpInside += (_, _) => Finish(null);
        View.AddSubview(close);

        var guide = View.SafeAreaLayoutGuide;
        NSLayoutConstraint.ActivateConstraints(
        [
            hint.TopAnchor.ConstraintEqualTo(guide.TopAnchor, 24),
            hint.LeadingAnchor.ConstraintEqualTo(guide.LeadingAnchor, 16),
            hint.TrailingAnchor.ConstraintEqualTo(guide.TrailingAnchor, -16),
            close.BottomAnchor.ConstraintEqualTo(guide.BottomAnchor, -20),
            close.LeadingAnchor.ConstraintEqualTo(guide.LeadingAnchor, 20),
            close.TrailingAnchor.ConstraintEqualTo(guide.TrailingAnchor, -20),
            close.HeightAnchor.ConstraintEqualTo(56),
        ]);
    }

    public override void ViewDidLayoutSubviews()
    {
        base.ViewDidLayoutSubviews();
        var bounds = View!.Bounds;
        if (preview is not null) preview.Frame = bounds;
        if (frameView is not null)
        {
            var w = bounds.Width * 0.8;
            var h = Math.Min(w * 0.6, bounds.Height * 0.4);
            frameView.Frame = new CGRect((bounds.Width - w) / 2, (bounds.Height - h) / 2, w, h);
        }
    }

    public override void ViewDidAppear(bool animated)
    {
        base.ViewDidAppear(animated);
        // StartRunning blocks; Apple asks for it off the main thread.
        if (session.Inputs.Length > 0) DispatchQueue.GetGlobalQueue(DispatchQueuePriority.High).DispatchAsync(session.StartRunning);
    }

    public override void ViewWillDisappear(bool animated)
    {
        base.ViewWillDisappear(animated);
        if (session.Running) DispatchQueue.GetGlobalQueue(DispatchQueuePriority.High).DispatchAsync(session.StopRunning);
    }

    internal void Found(string code)
    {
        if (result.Task.IsCompleted) return;
        new UINotificationFeedbackGenerator().NotificationOccurred(UINotificationFeedbackType.Success);
        Finish(code);
    }

    public void Finish(string? code)
    {
        if (!result.TrySetResult(code)) return;
        InvokeOnMainThread(() => DismissViewController(true, null));
    }

    void ShowMessage(string text)
    {
        var label = new UILabel { Text = text, TextColor = UIColor.White, TextAlignment = UITextAlignment.Center, Lines = 0, Frame = View!.Bounds };
        label.AutoresizingMask = UIViewAutoresizing.FlexibleDimensions;
        View.AddSubview(label);
    }

    sealed class MetadataDelegate(ScannerViewController owner) : AVCaptureMetadataOutputObjectsDelegate
    {
        public override void DidOutputMetadataObjects(AVCaptureMetadataOutput captureOutput, AVMetadataObject[] metadataObjects, AVCaptureConnection connection)
        {
            foreach (var o in metadataObjects)
            {
                if (o is AVMetadataMachineReadableCodeObject code && !string.IsNullOrEmpty(code.StringValue))
                {
                    owner.Found(code.StringValue);
                    return;
                }
            }
        }
    }
}
