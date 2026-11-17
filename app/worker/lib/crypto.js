// Encryption for stored third-party credentials (webshop API keys, courier and invoicing accounts).
// AES-256-GCM with the ENCRYPTION_KEY secret (32 random bytes, base64). Format: "v1:<iv b64>:<data b64>".
// Credentials are decrypted only inside the Worker and are never returned to the browser.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.ENCRYPTION_KEY) throw new Error('Hiányzik az ENCRYPTION_KEY titok a Worker beállításaiból.');
  const raw = unb64(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error('Az ENCRYPTION_KEY 32 bájtos, base64 kódolt kulcs legyen.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(JSON.stringify(value)));
  return `v1:${b64(iv)}:${b64(data)}`;
}

export async function decryptJson(env, text) {
  if (!text) return {};
  const [v, iv, data] = String(text).split(':');
  if (v !== 'v1') throw new Error('Ismeretlen titkosítási formátum.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(data));
  return JSON.parse(dec.decode(plain));
}

// For the browser: which credential fields are filled, never their values. "abc...xyz" for long keys.
export function maskCredentials(creds) {
  const out = {};
  for (const [k, v] of Object.entries(creds || {})) {
    const s = String(v ?? '');
    out[k] = s === '' ? '' : s.length > 8 ? `${s.slice(0, 2)}••••${s.slice(-2)}` : '••••';
  }
  return out;
}
