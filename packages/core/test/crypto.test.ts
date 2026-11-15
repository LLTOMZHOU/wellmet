import { describe, expect, it } from 'vitest';
import { deriveKeys, open, seal, signLink, sourceHash, verifyLink } from '../src/crypto.ts';

const key = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));

describe('stored tokens', () => {
  it('decrypt only with the same key and the same row context', async () => {
    const keys = await deriveKeys(key(1));
    const sealed = await seal(keys, 'refresh-token-value', 'connections:microsoft:refresh');
    expect(sealed).not.toContain('refresh-token-value');
    expect(await open(keys, sealed, 'connections:microsoft:refresh')).toBe('refresh-token-value');
    await expect(open(keys, sealed, 'connections:google:refresh')).rejects.toThrow();
    await expect(open(await deriveKeys(key(2)), sealed, 'connections:microsoft:refresh')).rejects.toThrow();
  });

  it('refuses a master key shorter than 32 bytes', async () => {
    await expect(deriveKeys(btoa('short'))).rejects.toThrow(/32/);
  });
});

describe('links', () => {
  it('rejects a tampered or foreign MAC', async () => {
    const keys = await deriveKeys(key(1));
    const mac = await signLink(keys, 'manage', 'booking-1');
    expect(await verifyLink(keys, 'manage', 'booking-1', mac)).toBe(true);
    expect(await verifyLink(keys, 'manage', 'booking-2', mac)).toBe(false);
    expect(await verifyLink(keys, 'manage', 'booking-1', mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(await verifyLink(keys, 'manage', 'booking-1', 'not base64!')).toBe(false);
    expect(await verifyLink(await deriveKeys(key(2)), 'manage', 'booking-1', mac)).toBe(false);
  });
});

describe('sources', () => {
  it('treats one IPv6 /64 as one source, and different networks as different', async () => {
    const keys = await deriveKeys(key(1));
    const a = await sourceHash(keys, '2001:db8:1:2:aaaa::1');
    expect(await sourceHash(keys, '2001:db8:1:2:bbbb::9')).toBe(a);
    expect(await sourceHash(keys, '2001:db8:1:3::1')).not.toBe(a);
    expect(await sourceHash(keys, '203.0.113.7')).not.toBe(await sourceHash(keys, '203.0.113.8'));
  });
});
