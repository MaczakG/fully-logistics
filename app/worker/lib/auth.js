// Passwords, sessions and the first-run setup.
//
// Passwords: PBKDF2-SHA256, 100 000 iterations (the Workers runtime maximum), 16 byte random salt.
// Sessions: a random 32 byte token in an HttpOnly, Secure, SameSite=Strict cookie. Only its SHA-256
// hash is stored, so a database leak does not leak live sessions. Sessions expire after 12 hours
// without activity and after 7 days at most.
// Login lockout: 5 wrong passwords lock the account for 15 minutes.

import { all, first, run } from './db.js';
import { nowIso } from './time.js';

export const COOKIE = 'fl_app_session';
const ITERATIONS = 100000;
const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
export const MIN_PASSWORD = 10;

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two strings.
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2-sha256') return false;
  const got = await pbkdf2(password, unb64(salt), parseInt(iter, 10));
  return safeEqual(b64(got), hash);
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `A jelszó legalább ${MIN_PASSWORD} karakter legyen.`;
  if (password.length > 200) return 'A jelszó legfeljebb 200 karakter lehet.';
  return null;
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookieHeader(token, maxAgeSeconds, secure) {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join('; ');
}

const isSecure = (req) => new URL(req.url).protocol === 'https:';

export async function createSession(env, req, userId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await run(
    env.DB,
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    await sha256Hex(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + IDLE_MS).toISOString(),
    now.toISOString(),
    req.headers.get('cf-connecting-ip') || '',
    (req.headers.get('user-agent') || '').slice(0, 300),
  );
  return cookieHeader(token, IDLE_MS / 1000, isSecure(req));
}

export const clearCookie = (req) => cookieHeader('', 0, isSecure(req));

// Loads the session user with role and permissions, or null. Extends the idle timeout.
export async function loadSession(env, req) {
  const token = readCookie(req);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await first(
    env.DB,
    `SELECT s.token_hash, s.created_at AS session_created, s.expires_at, s.last_seen_at,
            u.id, u.email, u.name, u.phone, u.active, u.must_change_password, u.role_id,
            r.name AS role_name, r.key AS role_key, r.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = ?`,
    hash,
  );
  if (!row) return null;
  const now = Date.now();
  if (!row.active || Date.parse(row.expires_at) < now || Date.parse(row.session_created) + MAX_MS < now) {
    await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  // Extend at most once a minute to keep writes low.
  if (now - Date.parse(row.last_seen_at) > 60 * 1000) {
    await run(env.DB, 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
      new Date(now).toISOString(), new Date(now + IDLE_MS).toISOString(), hash);
  }
  const perms = row.is_admin ? [] : await all(env.DB, 'SELECT module, action FROM role_permissions WHERE role_id = ?', row.role_id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role_id: row.role_id,
    role_key: row.role_key,
    role_name: row.role_name,
    is_admin: !!row.is_admin,
    must_change_password: !!row.must_change_password,
    permissions: new Set(perms.map((p) => `${p.module}:${p.action}`)),
    session_hash: hash,
  };
}

export async function destroySession(env, req) {
  const token = readCookie(req);
  if (token) await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
}

// Checks credentials with lockout. Returns the user row or throws a message for the login form.
export async function checkLogin(env, email, password) {
  const user = await first(env.DB, 'SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  const generic = 'Hibás e-mail cím vagy jelszó.';
  if (!user) {
    // Same work as a real check, so response time does not reveal which emails exist.
    await verifyPassword(String(password || ''), `pbkdf2-sha256$${ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$x`);
    throw new Error(generic);
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    throw new Error('Túl sok sikertelen próbálkozás. Próbáld újra 15 perc múlva.');
  }
  const ok = await verifyPassword(String(password || ''), user.password_hash);
  if (!ok) {
    const failed = user.failed_logins + 1;
    await run(env.DB, 'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      failed >= LOCK_AFTER ? 0 : failed,
      failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS).toISOString() : null,
      user.id);
    throw new Error(generic);
  }
  if (!user.active) throw new Error('Ez a felhasználó le van tiltva.');
  await run(env.DB, 'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', nowIso(), user.id);
  return user;
}

export const userCount = async (env) => (await first(env.DB, 'SELECT COUNT(*) AS n FROM users')).n;
