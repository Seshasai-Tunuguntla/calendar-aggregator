import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Takes the README's screenshots of the real app (see screenshots.config.ts), and the image link
// previews show (client/public/og-image.png, 1200x630 as Open Graph and Twitter cards expect).
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };
const LINK_PREVIEW = { width: 1200, height: 630 };

// `ready`: something only the finished page shows, so the shot never catches it loading.
async function shoot(page: Page, name: string, size: { width: number; height: number }, ready: Locator, { fullPage = false, file = `../docs/screenshots/${name}.png` } = {}) {
  await page.setViewportSize(size);
  await expect(ready).toBeVisible();
  await expect(page.getByRole('status', { name: /Loading|Finding/ })).toHaveCount(0);
  await page.screenshot({ path: fileURLToPath(new URL(file, import.meta.url)), fullPage, animations: 'disabled' });
}

test('screenshots', async ({ page }) => {
  await page.goto('/login');
  await shoot(page, 'sign-in', DESKTOP, page.getByRole('link', { name: 'Try booking' }));

  // The guest's side.
  await page.getByRole('link', { name: 'Try booking' }).click();
  const slot = page.locator('button.slot').nth(1);
  await expect(slot).toBeVisible();
  await slot.click();
  // Off the picked time, so the image shows its selected state rather than the focus ring.
  await page.locator('h1').click();
  await shoot(page, 'og-image', LINK_PREVIEW, page.getByLabel('Your name'), { file: '../client/public/og-image.png' });
  await page.getByLabel('Your name').fill('Alex Kim');
  await page.getByLabel('Email for the invitation').fill('alex@example.com');
  await page.locator('h1').click();
  const form = page.getByRole('button', { name: 'Book this time' });
  await shoot(page, 'booking-page', DESKTOP, form);
  await shoot(page, 'booking-page-phone', PHONE, form, { fullPage: true });
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: 'Book this time' }).click();
  await shoot(page, 'confirmation', DESKTOP, page.getByRole('heading', { name: "You're booked with Priya Sharma" }));
  const manageUrl = (await page.locator('.manage-link__url code').textContent()) ?? '';
  await page.goto(manageUrl);
  await page.getByRole('button', { name: 'Reschedule' }).click();
  await shoot(page, 'manage-page-phone', PHONE, page.locator('button.slot').first(), { fullPage: true });

  // The host's side.
  await page.goto('/login');
  await page.getByRole('button', { name: 'Try as host' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await shoot(page, 'dashboard', DESKTOP, page.getByRole('heading', { name: 'Coming up' }));
  await page.goto('/calendars');
  await shoot(page, 'calendars', DESKTOP, page.getByText('Holidays in India'));
  await page.goto('/availability');
  await shoot(page, 'availability', DESKTOP, page.getByRole('heading', { name: 'What guests see next week' }), { fullPage: true });
});
