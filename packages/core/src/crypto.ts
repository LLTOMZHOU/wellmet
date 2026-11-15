/**
 * Keys derived from the one MASTER_KEY secret (32+ random bytes, base64):
 *  - enc:  AES-256-GCM for provider tokens at rest, bound to their row by AAD;
 *  - link: HMAC-SHA256 for guest manage links and approval links;
 *  - src:  HMAC-SHA256 that turns a caller's address into an opaque source id.
 * Web Crypto only, so this runs the same in Workers and in Node tests.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Keys {
  enc: CryptoKey;
  link: CryptoKey;
  src: CryptoKey;
}

export async function deriveKeys(masterKeyBase64: string): Promise<Keys> {
  const master = fromBase64(masterKeyBase64);
  if (master.length < 32) throw new Error('MASTER_KEY must be at least 32 random bytes, base64-encoded.');
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  type DeriveArgs = Parameters<SubtleCrypto['deriveKey']>;
  const derive = (info: string, algorithm: DeriveArgs[2], usages: DeriveArgs[4]) =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('wellmet/v1'), info: enc.encode(info) },
      base,
      algorithm,
      false,
      usages,
    );
  const [encKey, linkKey, srcKey] = await Promise.all([
    derive('enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    derive('link', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']),
    derive('src', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { enc: encKey, link: linkKey, src: srcKey };
}

/** AES-GCM; `context` (for example "connections:microsoft:refresh") must match on decrypt. */
export async function seal(keys: Keys, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, keys.enc, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

export async function open(keys: Keys, sealed: string, context: string): Promise<string> {
  const bytes = fromBase64Url(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(context) },
    keys.enc,
    bytes.slice(12),
  );
  return dec.decode(pt);
}

export type LinkPurpose = 'manage' | 'approve';

/** The MAC half of a link such as /b/{id}.{mac}. */
export async function signLink(keys: Keys, purpose: LinkPurpose, id: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', keys.link, enc.encode(`${purpose}:${id}`));
  return toBase64Url(new Uint8Array(sig));
}

/** Constant-time check of a link MAC. */
export async function verifyLink(keys: Keys, purpose: LinkPurpose, id: string, mac: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64Url(mac);
  } catch {
    return false;
  }
  if (sig.length !== 32) return false;
  return crypto.subtle.verify('HMAC', keys.link, sig, enc.encode(`${purpose}:${id}`));
}

/**
 * Opaque, stable id for where a request came from. IPv6 addresses are cut to
 * their /64, since one household or phone usually holds a whole /64.
 */
export async function sourceHash(keys: Keys, address: string): Promise<string> {
  const normalized = address.includes(':') ? address.split(':').slice(0, 4).join(':').toLowerCase() : address.trim();
  const sig = await crypto.subtle.sign('HMAC', keys.src, enc.encode(normalized));
  return toBase64Url(new Uint8Array(sig).slice(0, 16));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newId(): string {
  return crypto.randomUUID();
}

// --- base64 -------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url.');
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return fromBase64(padded);
}
