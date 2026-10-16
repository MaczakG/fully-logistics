// Invoicing integrations (Számlázz.hu Agent, Billingo API v3).
//
// Contract used by the rest of the app:
//   listProviders()                    -> [{ code, name, credentialFields, settingFields }]
//   issueInvoice(ctx, statementId)     -> Promise<{ invoiceNumber, documentId }>
//        creates the invoice for an approved statement with the provider chosen in Beállítások,
//        stores the PDF in R2 and updates the statement. Throws HttpError on failure.
//   testConnection(env, provider)      -> Promise<{ ok, message }>
//
// Stub until the adapters are implemented.

import { conflict } from '../../lib/http.js';

export const listProviders = () => [];
export async function issueInvoice() {
  throw conflict('A számlázó még nincs beállítva.');
}
export const testConnection = async () => ({ ok: false, message: 'Nincs megvalósítva.' });
