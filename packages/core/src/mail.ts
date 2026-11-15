/**
 * A plain-text email as raw MIME, for Cloudflare's send_email binding. Kept
 * dependency-free: one part, UTF-8, quoted-printable body, encoded subject.
 */
export function buildMime(options: { from: string; fromName: string; to: string; subject: string; body: string; now: number; messageIdDomain: string }): string {
  const headers = [
    `From: ${encodeWord(options.fromName)} <${options.from}>`,
    `To: <${options.to}>`,
    `Subject: ${encodeWord(options.subject)}`,
    `Date: ${new Date(options.now).toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${options.messageIdDomain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${quotedPrintable(options.body)}`;
}

/** RFC 2047 encoded word, only when the text isn't plain ASCII. Strips line breaks (header injection). */
function encodeWord(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  let b = '';
  for (const byte of bytes) b += String.fromCharCode(byte);
  return `=?utf-8?B?${btoa(b)}?=`;
}

function quotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'));
  let out = '';
  let line = '';
  const push = (chunk: string) => {
    if (line.length + chunk.length > 75) {
      out += `${line}=\r\n`;
      line = '';
    }
    line += chunk;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out += `${line}\r\n`;
      line = '';
      i++;
      continue;
    }
    const printable = (b >= 33 && b <= 126 && b !== 61) || b === 32;
    push(printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  // A space at the end of a line must be encoded.
  return out + line.replace(/ $/, '=20');
}
