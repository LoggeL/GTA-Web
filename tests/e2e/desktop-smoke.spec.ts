import {
  enterMainMenu,
  expectPlayableWorldShell,
  startNewGame,
} from './helpers';
import { expect, test } from './fixtures';

test.describe('M0 desktop browser smoke', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'Desktop-only smoke coverage');

  test('splash to slot and preset selection reaches the live HUD/world shell', async ({ page }) => {
    test.setTimeout(90_000);
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
    const cityMap = panel.locator('svg[role="img"]');
    await expect(cityMap).toBeVisible();
    await expect(cityMap).toHaveAttribute('aria-label', /Player in Arroyo Heights/);
    await expect(cityMap.locator('[data-district-id]')).toHaveCount(4);
    await expect(cityMap.locator('[data-player="true"]')).toHaveCount(1);
    expect(await cityMap.locator('[data-fog-cell-id]').count()).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Juno' }).click();
    expect(await cityMap.locator('[data-route-segment]').count()).toBeGreaterThan(0);
    await cityMap.click();
    await expect(page.locator('[data-toast]')).toContainText('Custom waypoint');
    await panel.getByLabel('Missions').uncheck();
    await expect(cityMap.locator('[data-marker-kind="mission"]')).toHaveCount(0);
    await expect(cityMap.locator('[data-marker-kind="safehouse"]')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Clear GPS' }).click();
    await expect(page.locator('[data-toast]')).toContainText('GPS waypoint cleared');
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

  test('accessibility and audio settings apply live and persist across reload', async ({ page }) => {
    await page.goto('/');
    await enterMainMenu(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    const uiScale = panel.getByLabel('UI scale');
    const masterVolume = panel.getByLabel('Master volume');
    const highContrast = panel.getByLabel('High-contrast objectives');

    await uiScale.fill('125');
    await masterVolume.fill('55');
    await highContrast.check();
    await expect(page.locator('html')).toHaveCSS('--ui-scale', '1.25');
    await expect(page.locator('body')).toHaveClass(/high-contrast/);
    await page.waitForTimeout(260);

    await page.reload();
    await enterMainMenu(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('region', { name: 'Game panel', exact: true }).getByLabel('UI scale')).toHaveValue('125');
    await expect(page.getByRole('region', { name: 'Game panel', exact: true }).getByLabel('Master volume')).toHaveValue('55');
    await expect(page.getByRole('region', { name: 'Game panel', exact: true }).getByLabel('High-contrast objectives')).toBeChecked();
  });

  test('desktop interaction course covers vehicle use, movement, crouch, sprint, and shoulder swap', async ({ page }) => {
    await startNewGame(page, 1, 'Masculine Alex');
    const world = page.getByLabel('3D game world');
    await expect(world).toHaveAttribute('data-can-interact', 'true');

    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await expect(world).toHaveAttribute('data-route-status', 'active');
    expect(Number(await world.getAttribute('data-route-segments'))).toBeGreaterThan(0);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'on-foot');

    const initialX = Number(await world.getAttribute('data-player-x'));
    const initialZ = Number(await world.getAttribute('data-player-z'));
    await page.keyboard.down('w');
    await page.waitForTimeout(420);
    await page.keyboard.up('w');
    const movedX = Number(await world.getAttribute('data-player-x'));
    const movedZ = Number(await world.getAttribute('data-player-z'));
    expect(Math.hypot(movedX - initialX, movedZ - initialZ)).toBeGreaterThan(0.25);

    await page.keyboard.down('c');
    await expect(world).toHaveAttribute('data-crouching', 'true');
    await page.keyboard.up('c');
    await expect(world).toHaveAttribute('data-crouching', 'false');

    await page.keyboard.down('w');
    await page.keyboard.down('Shift');
    await expect(world).toHaveAttribute('data-sprinting', 'true');
    await page.keyboard.up('Shift');
    await page.keyboard.up('w');

    const shoulder = await world.getAttribute('data-shoulder-side');
    await page.keyboard.press('q');
    await expect(world).not.toHaveAttribute('data-shoulder-side', shoulder ?? 'right');
  });

  test('keyboard bindings swap accessibly, cancel with Escape, and persist', async ({ page }) => {
    await page.goto('/');
    await enterMainMenu(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    let panel = page.getByRole('region', { name: 'Game panel', exact: true });
    let moveForward = panel.locator('button[data-binding-action="moveForward"]');
    let moveBackward = panel.locator('button[data-binding-action="moveBackward"]');

    await expect(panel.locator('button[data-binding-action]')).toHaveCount(15);
    await expect(moveForward).toHaveAccessibleName('Change Move forward binding, currently W');
    await expect(moveBackward).toHaveAccessibleName('Change Move backward binding, currently S');
    await moveForward.click();
    await expect(moveForward).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('status')).toContainText('Press a key for Move forward');
    await page.keyboard.press('s');
    await expect(panel.getByRole('button', {
      name: 'Change Move forward binding, currently S',
    })).toBeFocused();
    await expect(panel.getByRole('button', {
      name: 'Change Move backward binding, currently W',
    })).toBeVisible();
    await expect(panel.getByRole('status')).toContainText('Move backward moved to W');

    moveBackward = panel.locator('button[data-binding-action="moveBackward"]');
    await moveBackward.click();
    await page.keyboard.press('Escape');
    await expect(moveBackward).toHaveAttribute('aria-label', 'Change Move backward binding, currently W');
    await expect(moveBackward).not.toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('status')).toContainText('cancelled');

    await moveBackward.click();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await page.keyboard.press('z');
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Settings' }).click();
    panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel.locator('button[data-binding-action="moveBackward"]')).toHaveAccessibleName(
      'Change Move backward binding, currently W',
    );

    await page.waitForTimeout(260);
    await page.reload();
    await enterMainMenu(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    panel = page.getByRole('region', { name: 'Game panel', exact: true });
    moveForward = panel.locator('button[data-binding-action="moveForward"]');
    await expect(moveForward).toHaveAccessibleName('Change Move forward binding, currently S');
    await expect(moveForward).toBeVisible();
    await expect(panel.getByRole('button', {
      name: 'Change Move backward binding, currently W',
    })).toBeVisible();
  });
});
