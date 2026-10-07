import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The link-preview tags in index.html: what Slack, LinkedIn, iMessage, X and others show when
// someone shares the app's link.
const html = new DOMParser().parseFromString(readFileSync(join(process.cwd(), 'index.html'), 'utf8'), 'text/html');
const meta = (key: string) => html.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute('content') ?? '';

describe('link previews', () => {
  it('have a description, and Open Graph and Twitter titles and descriptions that agree', () => {
    expect(meta('description').length).toBeGreaterThan(50);
    // Search engines cut descriptions at about 160 characters.
    expect(meta('description').length).toBeLessThanOrEqual(160);
    expect(meta('twitter:title')).toBe(meta('og:title'));
    // X and LinkedIn cut titles past about 60 characters; search results show about 60.
    expect(meta('og:title').length).toBeLessThanOrEqual(60);
    expect(html.title.length).toBeGreaterThanOrEqual(30);
    expect(html.title.length).toBeLessThanOrEqual(60);
    expect(meta('twitter:description')).toBe(meta('og:description'));
    expect(meta('twitter:card')).toBe('summary_large_image');
  });

  it('use absolute https URLs on the site itself, which is the live link in the README', () => {
    const site = new URL(meta('og:url'));
    expect(site.protocol).toBe('https:');
    for (const image of [meta('og:image'), meta('twitter:image')]) expect(new URL(image).origin).toBe(site.origin);
    const readme = readFileSync(join(process.cwd(), '../README.md'), 'utf8');
    expect(readme).toContain(`**Live demo: <${site.origin}>**`);
  });

  it("point at an image that's ours, in public/, at the size the tags declare", () => {
    const file = readFileSync(join(process.cwd(), 'public', new URL(meta('og:image')).pathname));
    expect(file.subarray(1, 4).toString()).toBe('PNG');
    expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([Number(meta('og:image:width')), Number(meta('og:image:height'))]);
    expect([meta('og:image:width'), meta('og:image:height')]).toEqual(['1200', '630']);
    expect(meta('og:image:alt')).not.toBe('');
    expect(meta('twitter:image:alt')).toBe(meta('og:image:alt'));
  });
});
