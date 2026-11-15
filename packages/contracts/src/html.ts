/**
 * A tiny HTML helper. `html` escapes every interpolated value unless it is
 * already a `SafeHtml` (the result of another `html` call or of `raw`).
 * Guest-supplied text always passes through here, never through `raw`.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (value instanceof SafeHtml) return value.value;
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Trusted markup only: constants written in this codebase. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
