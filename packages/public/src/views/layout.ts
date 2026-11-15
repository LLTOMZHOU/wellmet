import { html, raw, type SafeHtml } from '@wellmet/contracts/html';

export interface PageOptions {
  title: string;
  /** Adds the copy-button enhancement. Public pages only. */
  withScript?: boolean;
  /** Adds in-place date switching on booking pages. */
  withDays?: boolean;
}

/**
 * Every public page is a two-column sheet split by a 2px rule: `left` holds
 * who and what, `right` holds the thing to act on. Narrow screens stack them.
 */
export function sheet(left: SafeHtml, right: SafeHtml, options: { tone?: 'plain' | 'wide-left' | 'poster' } = {}): SafeHtml {
  const tone = options.tone && options.tone !== 'plain' ? ` sheet--${options.tone}` : '';
  return html`<div class="sheet${tone}">
  <section class="sheet__left">${left}</section>
  <section class="sheet__right">${right}</section>
</div>`;
}

export function topRow(right?: SafeHtml): SafeHtml {
  return html`<header class="toprow">
  <a class="wordmark" href="/">Wellmet</a>
  ${right ?? ''}
</header>`;
}

export function page(options: PageOptions, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<meta name="robots" content="noindex">
<link rel="preload" href="/assets/fonts/inter-tight-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/styles.css">
${options.withScript ? raw('<script src="/assets/copy.js" defer></script>') : ''}
${options.withDays ? raw('<script src="/assets/days.js" defer></script>') : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
${body}
</main>
</body>
</html>`;
}
