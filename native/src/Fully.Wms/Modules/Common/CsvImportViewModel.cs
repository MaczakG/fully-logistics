using System.Collections.ObjectModel;
using System.Text;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Fully.Wms.Core;
using Fully.Wms.Core.Models;
using Fully.Wms.ViewModels;

namespace Fully.Wms.Modules.Common;

// CSV import of any module, like the web app's ui.csvImport: choose a file, the server checks it
// (preview), the user sees the rows, errors and warnings, then imports. A template with the
// expected columns can be saved. Desktop only (needs a file picker).
public sealed partial class CsvImportViewModel(ShellViewModel shell, CsvImportOptions options) : PageViewModel(shell)
{
    public override string Title => options.Title;
    public override string? Module => options.Module;
    public CsvImportOptions Options { get; } = options;

    byte[]? file;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasFile))]
    public partial string? FileName { get; set; }

    public bool HasFile => FileName is not null;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPreview), nameof(CanImport), nameof(Verdict), nameof(VerdictTone))]
    public partial CsvImportResult? Preview { get; set; }

    public bool HasPreview => Preview is not null;
    public bool CanImport => Preview is { Valid: > 0 };
    public ObservableCollection<CsvLineMessage> Errors { get; } = [];
    public ObservableCollection<CsvLineMessage> Warnings { get; } = [];

    public string Verdict => Preview is null ? ""
        : Preview.Valid == 0 ? "Nincs importálható sor."
        : Preview.Errors is { Count: > 0 } ? "A hibás sorok kimaradnak. Az importálás a többit rögzíti."
        : "Minden sor rendben. Indíthatod az importálást.";

    public string VerdictTone => Preview is null ? "" : Preview.Valid == 0 ? "danger" : Preview.Errors is { Count: > 0 } ? "warn" : "ok";

    [RelayCommand]
    async Task ChooseAsync()
    {
        var top = TopLevel.GetTopLevel(Shell.View);
        if (top is null) return;
        var files = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "CSV fájl kiválasztása",
            AllowMultiple = false,
            FileTypeFilter = [new FilePickerFileType("CSV") { Patterns = ["*.csv", "*.txt"] }],
        });
        if (files.Count == 0) return;
        await using var stream = await files[0].OpenReadAsync();
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);
        file = ms.ToArray();
        FileName = files[0].Name;
        await CheckAsync();
    }

    async Task CheckAsync() => await RunAsync(async () =>
    {
        Preview = null;
        Errors.Clear();
        Warnings.Clear();
        var res = await Api.UploadAsync<CsvImportResult>(Options.Endpoint, file!, FileName!, Fields("1"));
        foreach (var e in (res.Errors ?? []).Take(200)) Errors.Add(e);
        foreach (var w in (res.Warnings ?? []).Take(200)) Warnings.Add(w);
        Preview = res;
    });

    [RelayCommand]
    Task ImportAsync() => RunAsync(async () =>
    {
        if (file is null || FileName is null) return;
        var res = await Api.UploadAsync<CsvImportResult>(Options.Endpoint, file, FileName, Fields("0"));
        Shell.Toast(Options.DoneText(res), ToastKind.Success);
        await Shell.BackAsync();
    });

    // A CSV with the expected header, to fill in Excel (semicolons, UTF-8 with BOM like the web app).
    [RelayCommand]
    Task TemplateAsync()
    {
        var csv = "﻿" + string.Join(";", Options.TemplateColumns) + "\r\n";
        return Shell.Services.Platform.OpenFileAsync(new DownloadedFile(Encoding.UTF8.GetBytes(csv), "text/csv", Options.TemplateName));
    }

    Dictionary<string, string> Fields(string preview)
    {
        var f = new Dictionary<string, string>(Options.ExtraFields ?? new Dictionary<string, string>()) { ["preview"] = preview };
        return f;
    }
}

public sealed record CsvImportOptions(
    string Module, string Title, string Endpoint, string Help, string TemplateName, IReadOnlyList<string> TemplateColumns,
    Func<CsvImportResult, string> DoneText, IReadOnlyDictionary<string, string>? ExtraFields = null);
