import {
  enterMainMenu,
  expectPlayableWorldShell,
  startNewGame,
} from './helpers';
import { expect, test } from './fixtures';

test.describe('M0 desktop browser smoke', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'Desktop-only smoke coverage');

  test('splash to slot and preset selection reaches the live HUD/world shell', async ({ page }) => {
    await startNewGame(page, 1, 'Masculine Alex');
    await expectPlayableWorldShell(page);
    await expect(page.locator('[data-dialogue-speaker]')).toHaveText('Alex Moreno');
    await expect(page.locator('[data-toast]')).toContainText('Past Due started');
  });

  test('a newly created slot persists across reload and can continue', async ({ page }) => {
    await startNewGame(page, 2, 'Feminine Alex');
    await expectPlayableWorldShell(page);

    await page.reload();
    await enterMainMenu(page);
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
    const slot = page.locator('[data-save-list] article[data-slot="2"]');
    await expect(slot.getByText('Slot 2', { exact: true })).toBeVisible();
    await expect(slot.getByText(/Level 1 · Solara free roam/)).toBeVisible();
    await slot.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 15_000 });
    await expectPlayableWorldShell(page);
    await expect(page.locator('[data-toast]')).toHaveText('Welcome back to Solara');
  });

  test('keyboard map and pause interactions open and close their accessible overlays', async ({ page }) => {
    await startNewGame(page, 3, 'Masculine Alex');
    await page.keyboard.press('m');

    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2, name: 'Map' })).toBeVisible();
    await expect(panel.getByText(/Neon Strand · Alta Vista · Arroyo Heights · Breakwater/)).toBeVisible();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();

    await page.keyboard.press('Escape');
    const pause = page.getByLabel('Pause menu');
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Map' }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(pause).toBeVisible();
    await pause.getByRole('button', { name: 'Resume' }).click();
    await expect(pause).toBeHidden();
    await expect(page.getByLabel('Game HUD')).toBeVisible();
  });
});
