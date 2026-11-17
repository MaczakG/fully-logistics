namespace Fully.Wms.Core.Models;

// The CSV imports of the server (inbound, orders, products ...): POST with preview=1 answers what
// would happen, preview=0 imports. Fields a given import does not have stay 0 / null.
public sealed record CsvImportResult(
    int Rows, int Valid, int Imported, int Created, int Updated, int Inbounds, int Orders,
    List<CsvLineMessage>? Errors, List<CsvLineMessage>? Warnings);

public sealed record CsvLineMessage(int Line, string Message);
