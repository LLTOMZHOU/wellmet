/**
 * Keep Wellmet out of search results, AI training sets and archives.
 *
 * Every response carries `X-Robots-Tag` (and every page the same directives in
 * a meta tag), which is what removes a page from Google and Bing. They must be
 * allowed to fetch pages to read it: a page they are barred from fetching can
 * still be listed, as a bare link, when another site links to it.
 *
 * robots.txt turns away every other crawler. The exception is an assistant
 * fetching a page because a person asked it to (ChatGPT, Claude, Perplexity,
 * Mistral): handing a booking link to your own assistant is how visitors'
 * agents book, and it stores nothing.
 */

export const ROBOTS_DIRECTIVES = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

export const ROBOTS_TXT = `# Wellmet is a personal booking page. It is not for search results,
# AI training or archives.
#
# Google and Bing may fetch pages only to read the "noindex" on every
# response, which keeps them out of results. Assistants fetching a page
# because a person asked them to may use it to book. Everyone else: please don't.

User-agent: Googlebot
User-agent: Bingbot
User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
User-agent: MistralAI-User
Allow: /

User-agent: *
Disallow: /
`;

export function robotsTxt(): Response {
  return new Response(ROBOTS_TXT, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-robots-tag': ROBOTS_DIRECTIVES },
  });
}

/** The same response with `X-Robots-Tag` set. Copies headers, since a fetched or cached response's are read-only. */
export function withNoIndex(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('x-robots-tag', ROBOTS_DIRECTIVES);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
