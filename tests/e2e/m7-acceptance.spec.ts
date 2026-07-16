import type { Locator, Page } from '@playwright/test';

import { expectPlayableWorldShell, startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface AudioQaSnapshot {
  station: 'coastline-fm' | 'low-tide-radio' | 'rustwave-88' | null;
  stationName: string;
  trackId: string | null;
  trackTitle: string;
  enabled: boolean;
  ready: boolean;
  contextState: string;
  mix: Readonly<Record<'master' | 'music' | 'sfx' | 'ui' | 'ambience', number>>;
  worldAudio: {
    active: boolean;
    inVehicle: boolean;
    rainIntensity: number;
    sirenActive: boolean;
  };
  worldVoiceCount: number;
}

interface M7QaApi {
  audioState(): AudioQaSnapshot;
  snapshot(): {
    vehiclePosition: { x: number; z: number };
    interactionTarget: { kind: string } | null;
  } | null;
  teleport(x: number, z: number): unknown;
  setWantedLevel(level: number): unknown;
}

type QaWindow = Window & { __HEATLINE_QA__?: M7QaApi };

const PANEL_BUTTONS = [
  'Map',
  'Inventory',
  'Jobs & mission log',
  'Skills',
  'Garage',
  'Economy',
  'Settings',
] as const;

async function waitForQa(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
}

async function audioState(page: Page): Promise<AudioQaSnapshot> {
  return page.evaluate(() => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    return api.audioState();
  });
}

async function expectBounded(locator: Locator, width: number, height: number): Promise<void> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-0.5);
  expect(bounds!.y).toBeGreaterThanOrEqual(-0.5);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 0.5);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height + 0.5);
}

test.describe('M7 audio, accessibility, and responsive acceptance', () => {
  test('desktop radio, mixer, camera shake, and modal focus work end to end', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop-only audio and keyboard course');
    test.setTimeout(60_000);

    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await expectPlayableWorldShell(page);
    await waitForQa(page);

    await expect.poll(() => audioState(page)).toMatchObject({
      station: 'coastline-fm',
      trackId: 'coastline-fm-sodium-lights',
      trackTitle: 'Sodium Lights',
      ready: true,
      contextState: 'running',
      worldVoiceCount: 5,
    });

    const world = page.getByLabel('3D game world');
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await expect.poll(() => audioState(page)).toMatchObject({
      station: 'coastline-fm',
      worldAudio: { inVehicle: true },
    });
    await expect(page.locator('[data-hud-radio]')).toContainText('Coastline FM · Sodium Lights');

    await page.keyboard.press('Tab');
    await expect.poll(() => audioState(page)).toMatchObject({
      station: 'low-tide-radio',
      trackId: 'low-tide-radio-concrete-sun',
    });
    await expect(page.locator('[data-hud-radio]')).toContainText('Low Tide Radio · Concrete Sun');

    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'on-foot');
    expect((await audioState(page)).station).toBe('low-tide-radio');
    await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      const snapshot = api?.snapshot();
      if (!api || !snapshot) throw new Error('HEATLINE QA world snapshot is unavailable');
      api.teleport(snapshot.vehiclePosition.x, snapshot.vehiclePosition.z);
    });
    await expect.poll(() => page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.interactionTarget?.kind ?? null,
    )).toBe('vehicle');
    await world.locator('canvas').focus();
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await expect(page.locator('[data-hud-radio]')).toContainText('Low Tide Radio · Concrete Sun');

    await page.keyboard.press('Escape');
    const pause = page.locator('[data-pause-menu]');
    await expect(pause).toBeVisible();
    await expect(pause.getByRole('heading', { level: 2, name: 'Pause menu' })).toBeFocused();
    await expect.poll(() => audioState(page)).toMatchObject({ contextState: 'suspended' });
    await page.keyboard.press('Tab');
    await expect(pause.getByRole('button', { name: 'Resume' })).toBeFocused();

    const settingsLauncher = pause.getByRole('button', { name: 'Settings' });
    await settingsLauncher.click();
    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2, name: 'Settings' })).toBeFocused();
    await panel.getByLabel('Master volume').fill('43');
    await panel.getByLabel('Music volume').fill('37');
    await panel.getByLabel('Effects volume').fill('61');
    await panel.getByLabel('UI volume').fill('52');
    await panel.getByLabel('Ambience volume').fill('29');
    await panel.getByLabel('Camera shake').fill('0');
    await panel.getByLabel('High-contrast objectives').check();

    await expect.poll(() => audioState(page)).toMatchObject({
      mix: { master: 0.43, music: 0.37, sfx: 0.61, ui: 0.52, ambience: 0.29 },
    });
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(settingsLauncher).toBeFocused();
    await pause.getByRole('button', { name: 'Resume' }).click();
    await expect(pause).toBeHidden();
    await expect(world).toHaveAttribute('data-camera-shake', '0.00');
    await expect.poll(() => audioState(page)).toMatchObject({ contextState: 'running' });

    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.setWantedLevel(3));
    await expect(page.locator('body')).toHaveClass(/high-contrast/);
    await expect(page.locator('.wanted')).toHaveCSS('outline-style', 'solid');
  });

  test('touch-only menu, campaign board, compact objective, and portrait pause recover safely', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only touch and orientation course');
    test.setTimeout(60_000);

    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    await expectPlayableWorldShell(page);
    await waitForQa(page);

    const world = page.getByLabel('3D game world');
    const touchMenu = page.getByRole('button', { name: 'Pause game and open menu' });
    await expect(touchMenu).toBeVisible();
    await touchMenu.tap();
    const pause = page.locator('[data-pause-menu]');
    await expect(pause).toBeVisible();
    await expect.poll(() => audioState(page)).toMatchObject({ contextState: 'suspended' });

    await pause.getByRole('button', { name: 'Jobs & mission log' }).tap();
    const panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.mission-card')).toHaveCount(12);
    await expect(panel.locator('.activity-card')).toHaveCount(5);
    await expect(panel.locator('[data-collectible-set]')).toHaveCount(3);
    await panel.getByRole('button', { name: 'Close' }).tap();
    await pause.getByRole('button', { name: 'Resume' }).tap();
    await expect(pause).toBeHidden();

    await page.setViewportSize({ width: 667, height: 375 });
    const objective = page.locator('.hud-top-center');
    await expect(objective).toBeVisible();
    await expect(page.locator('[data-hud-objective]')).toContainText('Past Due');
    await expectBounded(objective, 667, 375);
    await expectBounded(touchMenu, 667, 375);

    const touchTargets = await page.locator('[data-touch-action]:visible, .touch-menu-button:visible')
      .evaluateAll((elements) => elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label'), width: bounds.width, height: bounds.height };
      }));
    expect(touchTargets).toHaveLength(10);
    for (const target of touchTargets) {
      expect(target.width, `${target.label} is narrower than 44px`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
    }

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByText('Rotate to landscape', { exact: true })).toBeVisible();
    await expect(world).toHaveAttribute('data-world-paused', 'true');
    await expect.poll(() => audioState(page)).toMatchObject({
      contextState: 'suspended',
      worldAudio: { active: false },
    });

    await page.setViewportSize({ width: 667, height: 375 });
    await expect(page.getByText('Rotate to landscape', { exact: true })).toBeHidden();
    await expect(world).toHaveAttribute('data-world-paused', 'false');
    await expect.poll(() => audioState(page)).toMatchObject({ contextState: 'running' });
    await expect(touchMenu).toBeVisible();
  });

  test('every game panel stays bounded at both required viewport sizes', async ({ page, isMobile }) => {
    test.setTimeout(75_000);
    await startNewGame(page, 3, isMobile ? 'Feminine Alex' : 'Masculine Alex', '/?qa=1');
    await expectPlayableWorldShell(page);

    const sizes = isMobile
      ? [{ width: 844, height: 390 }, { width: 667, height: 375 }]
      : [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }];

    for (const size of sizes) {
      await page.setViewportSize(size);
      if (isMobile) await page.getByRole('button', { name: 'Pause game and open menu' }).tap();
      else await page.keyboard.press('Escape');

      const pause = page.locator('[data-pause-menu]');
      await expect(pause).toBeVisible();
      await expectBounded(pause.locator('.menu-card'), size.width, size.height);

      for (const name of PANEL_BUTTONS) {
        const launcher = pause.getByRole('button', { name });
        if (isMobile) await launcher.tap();
        else await launcher.click();
        const overlay = page.locator('.panel-overlay[data-panel]');
        await expect(overlay).toBeVisible();
        await expectBounded(overlay.locator('.panel-card'), size.width, size.height);
        const close = overlay.getByRole('button', { name: 'Close' });
        if (isMobile) await close.tap();
        else await close.click();
        await expect(overlay).toBeHidden();
        await expect(pause).toBeVisible();
      }

      const overlayButtons = await pause.getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { label: button.textContent?.trim(), height: bounds.height };
      }));
      if (isMobile) {
        for (const button of overlayButtons) {
          expect(button.height, `${button.label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
        }
      }

      if (isMobile) await pause.getByRole('button', { name: 'Resume' }).tap();
      else await pause.getByRole('button', { name: 'Resume' }).click();
      await expect(pause).toBeHidden();
    }
  });
});
