// Shared pieces of the invoicing adapters (szamlazz.js, billingo.js).

// Error from an invoicing provider. uncertain: the call may or may not have created the invoice
// (timeout, network error, 5xx), so the next attempt must look it up first.
export class ProviderError extends Error {
  constructor(message, { uncertain = false, status = null, code = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.uncertain = uncertain;
    this.status = status;
    this.providerCode = code;
  }
}

// The global fetch, wrapped so it is never called with a foreign `this` (Workers refuse that).
export const defaultFetch = (...args) => fetch(...args);
export const noLog = async () => {};
export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tests point the adapters at a local mock server through settings api_base. Only loopback
// addresses are accepted, which a deployed Worker cannot reach, so credentials can never be sent
// anywhere but the provider's official address.
export function baseUrl(settings, official) {
  const base = String((settings && settings.api_base) || '');
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base) ? base.replace(/\/$/, '') : official;
}

export const isTimeout = (err) => !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');

export const FULFILLMENT_OPTIONS = [
  { value: 'due_date', label: 'Fizetési határidő (időszakos elszámolás, legfeljebb az időszak végét követő 60. nap)' },
  { value: 'period_end', label: 'Az elszámolási időszak utolsó napja' },
  { value: 'issue_date', label: 'A számla kiállításának napja' },
];
export const FULFILLMENT_HELP = 'Időszakos elszámolásnál az Áfa tv. 58. §-a határozza meg a teljesítés napját. Egyeztesd a könyvelőddel.';

export const LANGUAGE_OPTIONS = [
  { value: 'hu', label: 'Magyar' },
  { value: 'en', label: 'Angol' },
  { value: 'de', label: 'Német' },
];
