namespace Fully.Wms.Core.Models;

// Fuvarszervezés (app/worker/routes/transport.js). Carrier pickups (FA-): the packed orders of a
// carrier go onto a manifest; closing it ships them. planned -> arrived -> closed, or cancelled.
// Transports (FU-): pallet and truck transports: requested -> booked -> in_transit -> delivered.

// Orders, parcels, weight and COD (per currency) of a group of orders.
public sealed record TransportTotals(int Orders, int Packages, decimal WeightKg, Dictionary<string, decimal> Cod, int CodOrders);

// GET /api/transport/board?date=: per carrier the waiting packed orders and the pickups of the day.
public sealed record TransportBoard(string Date, string Today, List<BoardCarrier> Carriers, TransportTotals NoCarrier, BoardTotals Totals);

public sealed record BoardTotals(TransportTotals Waiting, TransportTotals Assigned, int Pickups);

public sealed record BoardCarrier(int Id, string Code, string Name, string Status, string? CarrierCode, TransportTotals Waiting, TransportTotals Assigned, List<BoardPickup> Pickups);

public sealed record BoardPickup(
    int Id, string Number, int CarrierId, string Date, string? WindowFrom, string? WindowTo, string Status, string? ManifestNumber,
    string? ArrivedAt, string? ClosedAt, string? Note, TransportTotals Totals);

// GET /api/transport/pickups/:id: the manifest and, while open, the carrier's waiting orders.
public sealed record PickupDetail(
    int Id, string Number, int CarrierId, string Date, string? WindowFrom, string? WindowTo, string Status, string? ManifestNumber,
    int? ManifestDocumentId, string? Note, string? ClosedAt, string? ArrivedAt, string? CancelledAt, string CarrierName,
    string CarrierShort, string? CarrierCode, string? ClosedByName, string? CreatedByName, List<ManifestOrder> Orders,
    TransportTotals Totals, List<ManifestOrder> Waiting, PickupProblems Problems, PickupCompany Company);

public sealed record PickupProblems(List<string> NotPacked, int NoTracking);

public sealed record PickupCompany(string Name, string? Zip, string? City, string? Address, string? Phone);

public sealed record ManifestOrder(
    int Id, string Number, string? ExternalNumber, string Status, int PartnerId, string PartnerName, string PartnerCode,
    string CustomerName, string? Company, string? Country, string? Zip, string? City, string? Address, string? PickupPointId,
    string? CarrierService, string? TrackingNumber, int PackageCount, decimal? WeightKg, decimal CodAmount, string? Currency,
    string? PackedAt, int? PickupId);

public sealed record PickupCreated(int Id, string Number);

public sealed record PickupAssigned(int Assigned, PickupDetail Pickup);

public sealed record PickupScanned(PickupScanOrder Order, bool Already, string Message, PickupDetail Pickup);

public sealed record PickupScanOrder(int Id, string Number, string Status);

// done false: more orders to ship, call again with the same body.
public sealed record PickupClosed(bool Done, int Shipped, int Remaining, string? ManifestNumber);

// GET /api/transport/transports (and one transport).
public sealed record TransportRow(
    int Id, string Number, string Direction, int? PartnerId, int? CarrierId, string Date, string? TimeFrom, string? TimeTo,
    string? Origin, string? Destination, int Pallets, decimal? WeightKg, string? Vehicle, decimal? Price, string? CarrierRef,
    string Status, string? Note, string CreatedAt, string? UpdatedAt, string? CancelledAt, string? PartnerName, string? PartnerCode,
    string? CarrierName, string? CarrierShort, string? CreatedByName);
