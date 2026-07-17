import type { Page } from '@playwright/test';

import { expect } from './fixtures';

export type AlexPreset = 'Masculine Alex' | 'Feminine Alex';

export async function waitForSplash(page: Page): Promise<void> {
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { level: 1, name: 'HEATLINE' })).toBeVisible();
  await expect(page.getByText('SOLARA', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Solara' })).toBeVisible();
}

export async function openApplication(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await waitForSplash(page);
}

export async function enterMainMenu(page: Page): Promise<void> {
  await waitForSplash(page);
  await page.getByRole('button', { name: 'Enter Solara' }).click();
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'City of second chances.' })).toBeVisible();
}

export async function chooseSaveSlot(page: Page, slot: 1 | 2 | 3): Promise<void> {
  await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Choose a save' })).toBeVisible();
  const card = page.locator(`[data-save-list] article[data-slot="${slot}"]`);
  await expect(card.getByText(`Slot ${slot}`, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'New game' }).click();
}

export async function startNewGame(
  page: Page,
  slot: 1 | 2 | 3 = 1,
  preset: AlexPreset = 'Masculine Alex',
  url = '/',
): Promise<void> {
  await openApplication(page, url);
  await enterMainMenu(page);
  await chooseSaveSlot(page, slot);
  await expect(page.getByRole('heading', { level: 2, name: 'Choose Alex' })).toBeVisible();
  await expect(page.getByText(`Save slot ${slot}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${preset}`) }).click();
  // The loading screen may be mounted and removed between Playwright observations.
  // The visible HUD is the stable, user-facing completion boundary.
  await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 75_000 });
}

export async function expectPlayableWorldShell(page: Page): Promise<void> {
  await expect(page.getByLabel('3D game world').locator('canvas')).toBeVisible();
  await expect(page.locator('[data-hud-objective]')).toContainText('Past Due · Protect the garage');
  await expect(page.locator('[data-hud-district]')).toHaveText('Arroyo Heights');
  await expect(page.locator('[data-hud-money]')).toHaveText('$850');
  await expect(page.locator('[data-meter="health"]')).toHaveAttribute('aria-label', 'health: 100 of 100');
  await expect(page.getByLabel('Minimap')).toBeVisible();
}
