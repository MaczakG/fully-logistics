// Courier integrations (GLS, DPD, Foxpost, MPL, DHL): labels and tracking.
//
// Contract used by the rest of the app (do not change the signatures without updating callers):
//   listCouriers()                         -> [{ code, name, credentialFields, settingFields }]
//   isConfigured(env, carrierCode)          -> Promise<boolean>  account saved and active
//   createLabel(ctx, orderId, { packages }) -> Promise<{ trackingNumber, documentId }>
//        books the shipment with the carrier, stores the label PDF in R2 (documents table),
//        writes orders.tracking_number and label_document_id. Throws HttpError with a Hungarian
//        message on failure, so the packing screen can fall back to a manual tracking number.
//   trackingUrl(carrierCode, trackingNumber) -> string ('' if unknown)
//   testConnection(env, carrierCode)        -> Promise<{ ok, message }>
//
// Stub until the adapters are implemented.

import { conflict } from '../../lib/http.js';

export const listCouriers = () => [];
export const isConfigured = async () => false;
export async function createLabel() {
  throw conflict('A futár API még nincs beállítva. Add meg kézzel a nyomkövetési számot.');
}
export const trackingUrl = () => '';
export const testConnection = async () => ({ ok: false, message: 'Nincs megvalósítva.' });
