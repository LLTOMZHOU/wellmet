import { html, raw, type SafeHtml } from './html.ts';
import type { Host } from './types.ts';

/**
 * The postmark seal: Wellmet's mark. A ring of text around "WM", with
 * cancellation waves to the right when `waves` is set. Decorative, so it
 * carries aria-hidden; the host's name is always written out beside it.
 */
export function seal(options: { waves?: boolean; className?: string } = {}): SafeHtml {
  const width = options.waves ? 132 : 64;
  // The ring text only reads at card size; the small brand mark keeps the rings and monogram.
  const ringText = options.waves
    ? raw('<text font-size="8.6" letter-spacing="3.2" fill="currentColor" font-family="IBM Plex Mono, ui-monospace, monospace"><textPath href="#seal-arc">WELL MET · WELL MET ·</textPath></text>')
    : '';
  return html`<svg class="${options.className ?? 'seal'}" viewBox="0 0 ${width} 64" width="${width}" height="64" aria-hidden="true" focusable="false">
  ${options.waves ? raw('<defs><path id="seal-arc" d="M32 32 m-22.5 0 a22.5 22.5 0 1 1 45 0 a22.5 22.5 0 1 1 -45 0"/></defs>') : ''}
  <g fill="none" stroke="currentColor">
    <circle cx="32" cy="32" r="30" stroke-width="${options.waves ? '1.6' : '3'}"/>
    ${options.waves ? raw('<circle cx="32" cy="32" r="16" stroke-width="1"/>') : ''}
  </g>
  ${ringText}
  <text x="32" y="${options.waves ? '36.5' : '41'}" text-anchor="middle" font-size="${options.waves ? '13' : '26'}" fill="currentColor" font-family="Newsreader, Georgia, serif" font-style="italic">wm</text>
  ${options.waves ? raw('<g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M66 22c8-5 12 5 20 0s12 5 20 0 12 5 20 0"/><path d="M66 32c8-5 12 5 20 0s12 5 20 0 12 5 20 0"/><path d="M66 42c8-5 12 5 20 0s12 5 20 0 12 5 20 0"/></g>') : ''}
</svg>`;
}

export interface PageOptions {
  title: string;
  host: Host;
  /** Adds the copy-button enhancement. Public pages only. */
  withScript?: boolean;
  bodyClass?: string;
}

export function page(options: PageOptions, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<meta name="robots" content="noindex">
<link rel="preload" href="/assets/fonts/newsreader-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/ibm-plex-mono-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/styles.css">
${options.withScript ? raw('<script src="/assets/copy.js" defer></script>') : ''}
</head>
<body class="${options.bodyClass ?? ''}">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <a class="brand" href="/">${seal({ className: 'seal seal--small' })}<span>${options.host.name}</span></a>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <span class="rule" aria-hidden="true"></span>
  <span>Scheduled with Wellmet</span>
  <span class="rule" aria-hidden="true"></span>
</footer>
</body>
</html>`;
}
