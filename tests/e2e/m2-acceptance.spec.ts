import type { Page } from '@playwright/test';

import { startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaApi {
  teleport(x: number, z: number): unknown;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

async function qaTeleport(page: Page, x: number, z: number): Promise<void> {
  await page.evaluate(({ targetX, targetZ }) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    api.teleport(targetX, targetZ);
  }, { targetX: x, targetZ: z });
}

async function interact(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) {
    await page.keyboard.press('e');
    return;
  }
  const button = page.locator('[data-touch-action="interact"]');
  await button.dispatchEvent('pointerdown');
  await page.waitForTimeout(45);
  await button.dispatchEvent('pointerup');
}

test.describe('M2 city streaming and navigation acceptance', () => {
  test('traverses all districts and round-trips the Moreno Garage interior', async ({ page, isMobile }) => {
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');
    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));

    expect(Number(await world.getAttribute('data-visual-resident-cells'))).toBeGreaterThan(0);
    expect(Number(await world.getAttribute('data-visual-resident-cells'))).toBeLessThanOrEqual(11);
    expect(Number(await world.getAttribute('data-active-collisions'))).toBeGreaterThan(0);
    expect(Number(await world.getAttribute('data-active-traffic'))).toBeGreaterThan(0);

    await interact(page, Boolean(isMobile));
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await interact(page, Boolean(isMobile));
    await expect(world).toHaveAttribute('data-player-mode', 'on-foot');
    await expect(world).toHaveAttribute('data-can-interact', 'true');

    await interact(page, Boolean(isMobile));
    await expect(world).toHaveAttribute('data-interior-phase', 'interior');
    await expect(world).toHaveAttribute('data-interior-id', 'moreno-garage');
    await expect(page.locator('[data-hud-objective]')).toContainText('Explore Moreno Garage');
    await interact(page, Boolean(isMobile));
    await expect(world).toHaveAttribute('data-interior-phase', 'exterior');
    await expect(world).toHaveAttribute('data-interior-id', '');

    const destinations = [
      { x: -350, z: -350, district: 'neon-strand', cell: 'cell:-2:-2' },
      { x: 350, z: -350, district: 'alta-vista', cell: 'cell:1:-2' },
      { x: 350, z: 350, district: 'breakwater', cell: 'cell:1:1' },
      { x: -350, z: 350, district: 'arroyo-heights', cell: 'cell:-2:1' },
    ] as const;
    for (const destination of destinations) {
      await qaTeleport(page, destination.x, destination.z);
      await expect(world).toHaveAttribute('data-district', destination.district);
      await expect(world).toHaveAttribute('data-current-cell', destination.cell);
      const resident = Number(await world.getAttribute('data-visual-resident-cells'));
      expect(resident).toBeGreaterThan(0);
      expect(resident).toBeLessThanOrEqual(11);
    }
  });

  test('cross-city GPS reaches its authored target', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop map interaction drives this route acceptance');
    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');
    await page.keyboard.press('m');
    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await panel.getByRole('button', { name: 'Malik' }).click();
    await expect(page.locator('[data-toast]')).toContainText(/GPS route set|No street route/);
    expect(await panel.locator('svg[role="img"] [data-route-segment]').count()).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(world).toHaveAttribute('data-route-status', 'active');
    expect(Number(await world.getAttribute('data-route-segments'))).toBeGreaterThan(0);

    await qaTeleport(page, 350, -350);
    await expect(world).toHaveAttribute('data-district', 'alta-vista');
    await expect(world).toHaveAttribute('data-route-status', 'arrived');
  });

  test('forced stream failure clamps safely and Retry restores play', async ({ page }) => {
    await startNewGame(
      page,
      3,
      'Masculine Alex',
      '/?qa=1&streamFailCell=cell%3A1%3A0',
    );
    const world = page.getByLabel('3D game world');
    await qaTeleport(page, 300, 120);

    const blocker = page.getByRole('alertdialog', { name: 'Solara stopped loading.' });
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText('after three attempts');
    await expect(world).toHaveAttribute('data-world-paused', 'true');
    expect(Number(await world.getAttribute('data-player-x'))).toBeLessThan(0);
    expect(Number(await world.getAttribute('data-road-closures'))).toBeGreaterThan(0);
    expect(Number(await world.getAttribute('data-closed-road-edges'))).toBeGreaterThan(0);

    await blocker.getByRole('button', { name: 'Retry' }).click();
    await expect(blocker).toBeHidden();
    await expect(world).toHaveAttribute('data-world-paused', 'false');
    await qaTeleport(page, 300, 120);
    await expect(world).toHaveAttribute('data-current-cell', 'cell:1:0');
    await expect(world).toHaveAttribute('data-road-closures', '0');
  });

  test('forced stream failure can save and return to the menu', async ({ page }) => {
    await startNewGame(
      page,
      1,
      'Feminine Alex',
      '/?qa=1&streamFailCell=cell%3A1%3A0',
    );
    await qaTeleport(page, 300, 120);
    const blocker = page.getByRole('alertdialog', { name: 'Solara stopped loading.' });
    await expect(blocker).toBeVisible();
    await blocker.getByRole('button', { name: 'Return to menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
  });
});
