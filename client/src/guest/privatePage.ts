import { useEffect } from 'react';

// Manage pages carry a secret token in their URL (/booking/<token>). These headers keep it out of
// the Referer header sent to any other site and out of search engines. The server sends them with
// the page itself (vite.config.ts in development, vercel.json in production; both tested against
// these values), and usePrivatePage adds the matching meta tags while the page is open.
export const PRIVATE_PAGE_PREFIX = '/booking/';
export const PRIVATE_PAGE_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

export function usePrivatePage(): void {
  useEffect(() => {
    const tags = [
      Object.assign(document.createElement('meta'), { name: 'referrer', content: 'no-referrer' }),
      Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' }),
    ];
    for (const tag of tags) document.head.append(tag);
    return () => {
      for (const tag of tags) tag.remove();
    };
  }, []);
}
