import { describe, expect, it } from 'vitest';
import { ROBOTS_DIRECTIVES, ROBOTS_TXT, robotsTxt, withNoIndex } from '../src/robots.ts';

/** The rules that apply to one user agent: its own group if it has one, else the "*" group. */
function rulesFor(agent: string): string[] {
  const groups = ROBOTS_TXT.split(/\n\s*\n/).map((g) => g.split('\n').filter((l) => l && !l.startsWith('#')));
  const own = groups.find((g) => g.some((l) => l.toLowerCase() === `user-agent: ${agent.toLowerCase()}`));
  return (own ?? groups.find((g) => g.includes('User-agent: *')) ?? []).filter((l) => !l.startsWith('User-agent'));
}

describe('keeping Wellmet out of search and training', () => {
  it('turns away crawlers by default, AI training crawlers included', () => {
    for (const bot of ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'PerplexityBot', 'SomeNewBot']) {
      expect(rulesFor(bot)).toEqual(['Disallow: /']);
    }
  });

  it('lets search engines fetch pages so they read the noindex, and lets a person\'s own assistant book', () => {
    for (const bot of ['Googlebot', 'Bingbot', 'ChatGPT-User', 'Claude-User']) {
      expect(rulesFor(bot)).toEqual(['Allow: /']);
    }
  });

  it('serves robots.txt as plain text', async () => {
    const res = robotsTxt();
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(ROBOTS_TXT);
  });

  it('marks any response noindex, even one whose headers are read-only', async () => {
    const original = Response.redirect('https://meet.example/b/x', 303);
    const marked = withNoIndex(original);
    expect(marked.headers.get('x-robots-tag')).toBe(ROBOTS_DIRECTIVES);
    expect(marked.status).toBe(303);
    expect(marked.headers.get('location')).toBe('https://meet.example/b/x');
    expect(ROBOTS_DIRECTIVES).toContain('noindex');
  });
});
