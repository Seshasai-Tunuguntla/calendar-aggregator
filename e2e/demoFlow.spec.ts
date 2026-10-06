import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The demo as a recruiter would try it, in a real browser against the real API and database:
// "Try booking" -> pick a time -> book -> the manage page -> cancel. Every screen on the way is
// checked with axe (WCAG 2.2 A and AA rules) and for sideways scrolling, at 1280px and at 375px
// (the two projects in playwright.config.ts).

async function expectAccessible(page: Page, screen: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const found = violations.map((v) => `${v.id} (${v.impact}): ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(found, `axe on the ${screen}`).toEqual([]);
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(widths[0], `no sideways scrolling on the ${screen}`).toBeLessThanOrEqual(widths[1] ?? 0);
}

test('a guest books a time with the demo host, then cancels it from the manage page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Try booking' })).toBeVisible();
  await expectAccessible(page, 'sign-in page');

  // The booking page, in the guest's own time zone.
  await page.getByRole('link', { name: 'Try booking' }).click();
  await expect(page).toHaveURL(/\/book\/priya\/30-min-call$/);
  await expect(page.getByRole('heading', { level: 1, name: '30-min call' })).toBeVisible();
  await expect(page.getByText(/Times are in London \(GMT\+1\)/)).toBeVisible();
  const slot = page.locator('button.slot').first();
  await expect(slot).toBeVisible();
  await expectAccessible(page, 'booking page');

  // Pick a time; the form checks the details before anything is sent.
  const time = (await slot.textContent()) ?? '';
  await slot.click();
  await expect(slot).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByText('Enter your name')).toBeVisible();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await expectAccessible(page, 'booking form showing its errors');

  await page.getByLabel('Your name').fill('Playwright Guest');
  await page.getByLabel('Email for the invitation').fill('guest@example.com');
  await page.getByRole('button', { name: 'Book this time' }).click();

  // The confirmation: the time in the guest's zone, the manage link and what happens next.
  await expect(page.getByRole('heading', { level: 1, name: "You're booked with Priya Sharma" })).toBeFocused();
  await expect(page.getByText(new RegExp(`${time}–.*London \\(GMT\\+1\\)`))).toBeVisible();
  await expect(page.getByText(/This is the demo, so no invitation is sent/)).toBeVisible();
  await expectAccessible(page, 'confirmation');
  const manageUrl = (await page.locator('.manage-link__url code').textContent()) ?? '';
  expect(manageUrl).toMatch(/\/booking\/[A-Za-z0-9_-]{43}$/);

  // The manage page: its secret link stays out of Referer headers and search engines.
  const response = await page.goto(manageUrl);
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.getByRole('heading', { level: 1, name: '30-min call with Priya Sharma' })).toBeVisible();
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  await expectAccessible(page, 'manage page');

  // Cancel, after confirming.
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByRole('heading', { name: 'Cancel this booking?' })).toBeFocused();
  await expectAccessible(page, 'cancel confirmation');
  await page.getByRole('button', { name: 'Cancel booking' }).last().click();
  await expect(page.getByText("Cancelled. Priya Sharma's calendar has been updated.")).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Book a new time' })).toHaveAttribute('href', '/book/priya/30-min-call');
  await expectAccessible(page, 'cancelled booking');

  // The cancelled time is free again for the next guest.
  await page.getByRole('link', { name: 'Book a new time' }).click();
  await expect(page.locator('button.slot').first()).toHaveText(time);
});

test('"Try as host" opens the demo dashboard, and every host page passes the same checks', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try as host' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("You're trying the demo host")).toBeVisible();
  await expectAccessible(page, 'dashboard');

  for (const [path, heading] of [
    ['/calendars', 'Which calendars make you busy'],
    ['/availability', 'When guests can book you'],
    ['/event-types', 'What guests can book'],
    ['/account', 'Your account'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    // Wait for the page's data, not just its frame.
    await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
    await expectAccessible(page, `${heading} page`);
  }
});
