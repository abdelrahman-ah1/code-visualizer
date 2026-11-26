// On native Windows the backend reports C++ as an unsupported platform, not a missing install.
import { expect, test } from '@playwright/test';
test('native Windows shows a platform message, not install advice', async ({ page }) => {
  await page.route('**/api/health', async (route) => {
    const r = await route.fetch(); const j = await r.json();
    await route.fulfill({ response: r, json: { ...j, cpp: { available: false, gpp: false, gdb: false, unsupported_platform: true } } });
  });
  await page.goto('/'); await page.getByLabel('Language').selectOption('cpp');
  await expect(page.getByTestId('cpp-unsupported')).toContainText('not available on native Windows');
  await expect(page.getByTestId('cpp-unsupported')).toContainText('Python mode works here');
  await expect(page.getByTestId('cpp-missing')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run and record' })).toBeDisabled();
  await page.getByLabel('Language').selectOption('python');
  await expect(page.getByTestId('cpp-unsupported')).toHaveCount(0);
});
