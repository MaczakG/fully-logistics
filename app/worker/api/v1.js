// Partner REST API (/api/v1). Every request carries a client partner's API key; ctx.apiPartner is
// that partner, and every query must be limited to its own data.

export function registerApi(router) {
  return router;
}
