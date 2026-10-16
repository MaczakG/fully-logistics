// Webshop integrations (Shopify, WooCommerce, Shoprenter, UNAS): order import and fulfilment.
//
// Contract used by the rest of the app:
//   listPlatforms()                       -> [{ code, name, credentialFields, settingFields }]
//   syncAll(env)                          -> Promise<void>  cron: import new orders from every active connection
//   syncConnection(env, connectionId)     -> Promise<{ imported, skipped, errors }>
//   pushFulfillments(env, orderIds)       -> Promise<void>  after shipping: send tracking numbers back
//   testConnection(env, connectionId)     -> Promise<{ ok, message }>
//
// Stub until the adapters are implemented.

export const listPlatforms = () => [];
export const syncAll = async () => {};
export const syncConnection = async () => ({ imported: 0, skipped: 0, errors: [] });
export const pushFulfillments = async () => {};
export const testConnection = async () => ({ ok: false, message: 'Nincs megvalósítva.' });
