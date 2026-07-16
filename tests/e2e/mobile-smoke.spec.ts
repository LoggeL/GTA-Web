import { expectPlayableWorldShell, startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaApi {
  teleport(x: number, z: number): unknown;
  snapshot(): {
    cameraYaw: number;
    heading: number;
    speedMetersPerSecond: number;
    vehiclePosition: { x: number; z: number };
  } | null;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

test.describe('M0 mobile landscape browser smoke', () => {
  test.skip(({ isMobile }) => !isMobile, 'Mobile-only smoke coverage');

  test('landscape gameplay exposes touch controls and portrait shows the rotate blocker', async ({ page }) => {
    test.setTimeout(90_000);
    await startNewGame(page, 1, 'Feminine Alex', '/?qa=1');
    await expectPlayableWorldShell(page);

    const touchControls = page.locator('[data-touch-layout]');
    await expect(touchControls).toBeVisible();
    await expect(touchControls).toHaveAttribute('data-touch-layout', 'on-foot');
    await expect(touchControls).toHaveAccessibleName('On-foot touch controls');
    await expect(touchControls.getByRole('button', { name: 'Interact' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Sprint' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Jump', exact: true })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Crouch', exact: true })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Aim' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Fire or attack' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Charge heavy attack' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Cycle weapon' })).toBeVisible();

    const world = page.getByLabel('3D game world');
    const weaponBeforeSwap = await world.getAttribute('data-active-weapon-id');
    const weaponSwap = touchControls.locator('[data-touch-action="weaponRadial"]');
    await weaponSwap.dispatchEvent('pointerdown');
    await expect(weaponSwap).toHaveClass(/is-active/);
    await expect.poll(() => world.getAttribute('data-active-weapon-id')).not.toBe(weaponBeforeSwap);
    await weaponSwap.dispatchEvent('pointerup');
    await expect(weaponSwap).not.toHaveClass(/is-active/);

    const heavyAttack = touchControls.locator('[data-touch-action="melee"]');
    await heavyAttack.dispatchEvent('pointerdown');
    await expect(heavyAttack).toHaveClass(/is-active/);
    await heavyAttack.dispatchEvent('pointerup');
    await expect(heavyAttack).not.toHaveClass(/is-active/);

    const sprint = touchControls.locator('[data-touch-action="sprint"]');
    await sprint.dispatchEvent('pointerdown');
    await expect(sprint).toHaveClass(/is-active/);
    await sprint.dispatchEvent('pointerup');
    await expect(sprint).not.toHaveClass(/is-active/);

    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.teleport(-248, 243.5));
    const interact = touchControls.locator('[data-touch-action="interact"]');
    await interact.dispatchEvent('pointerdown');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await interact.dispatchEvent('pointerup');
    await expect(touchControls).toHaveAttribute('data-touch-layout', 'vehicle');
    await expect(touchControls).toHaveAccessibleName('Vehicle touch controls');
    await expect(touchControls.getByRole('group', { name: 'Steering and throttle stick' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Exit vehicle' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Handbrake' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Vehicle camera' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Vehicle reset' })).toBeVisible();
    await expect(touchControls.getByRole('button', { name: 'Sprint' })).toBeHidden();
    await expect(touchControls.getByRole('button', { name: 'Charge heavy attack' })).toBeHidden();
    await expect(touchControls.getByRole('button', { name: 'Cycle radio station' })).toBeVisible();

    const cameraToggle = touchControls.getByRole('button', { name: 'Vehicle camera' });
    await cameraToggle.dispatchEvent('pointerdown');
    await expect(world).toHaveAttribute('data-vehicle-camera-view', 'close');
    await cameraToggle.dispatchEvent('pointerup');

    const stick = touchControls.getByRole('group', { name: 'Steering and throttle stick' });
    const stickBox = await stick.boundingBox();
    expect(stickBox).not.toBeNull();
    const centerX = stickBox!.x + stickBox!.width / 2;
    const centerY = stickBox!.y + stickBox!.height / 2;
    await stick.dispatchEvent('pointerdown', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: centerX,
      clientY: centerY - stickBox!.height * 0.32,
    });
    await expect.poll(async () => page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.speedMetersPerSecond ?? 0,
    )).toBeGreaterThan(0.4);

    const headingBeforeSteer = await page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.heading ?? 0,
    );
    await stick.dispatchEvent('pointermove', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: centerX + stickBox!.width * 0.3,
      clientY: centerY - stickBox!.height * 0.24,
    });
    await expect.poll(async () => Math.abs(await page.evaluate(
      (before) => ((window as QaWindow).__HEATLINE_QA__?.snapshot()?.heading ?? before) - before,
      headingBeforeSteer,
    ))).toBeGreaterThan(0.03);
    await stick.dispatchEvent('pointerup', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: centerX,
      clientY: centerY,
    });

    const camera = touchControls.locator('[data-touch-camera]');
    const yawBeforeDrag = await page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.cameraYaw ?? 0,
    );
    await camera.dispatchEvent('pointerdown', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 560,
      clientY: 130,
    });
    await camera.dispatchEvent('pointermove', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 620,
      clientY: 150,
    });
    await camera.dispatchEvent('pointerup', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: 620,
      clientY: 150,
    });
    await expect.poll(async () => Math.abs(await page.evaluate(
      (before) => ((window as QaWindow).__HEATLINE_QA__?.snapshot()?.cameraYaw ?? before) - before,
      yawBeforeDrag,
    ))).toBeGreaterThan(0.05);

    const speedBeforeBrake = await page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.speedMetersPerSecond ?? 0,
    );
    const handbrake = touchControls.getByRole('button', { name: 'Handbrake' });
    await handbrake.dispatchEvent('pointerdown');
    await expect.poll(async () => page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.speedMetersPerSecond ?? 0,
    )).toBeLessThan(speedBeforeBrake);
    await handbrake.dispatchEvent('pointerup');

    const positionBeforeReset = await page.evaluate(
      () => (window as QaWindow).__HEATLINE_QA__?.snapshot()?.vehiclePosition ?? { x: 0, z: 0 },
    );
    const reset = touchControls.getByRole('button', { name: 'Vehicle reset' });
    await reset.dispatchEvent('pointerdown');
    await expect.poll(async () => page.evaluate((before) => {
      const after = (window as QaWindow).__HEATLINE_QA__?.snapshot()?.vehiclePosition;
      return after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    }, positionBeforeReset)).toBeGreaterThan(1);
    await reset.dispatchEvent('pointerup');

    await interact.dispatchEvent('pointerdown');
    await expect(world).toHaveAttribute('data-player-mode', 'on-foot');
    await interact.dispatchEvent('pointerup');
    await expect(touchControls).toHaveAttribute('data-touch-layout', 'on-foot');

    const rotateMessage = page.getByText('Rotate to landscape', { exact: true });
    await expect(rotateMessage).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rotateMessage).toBeVisible();
    await expect(page.getByText('HEATLINE is designed for a wide screen.', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(rotateMessage).toBeHidden();
    await expect(touchControls).toBeVisible();

    const actionBounds = await touchControls.locator('[data-touch-action]:visible').evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return {
          action: (button as HTMLElement).dataset.touchAction,
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        };
      }),
    );
    expect(actionBounds).toHaveLength(9);
    for (const bounds of actionBounds) {
      expect(bounds.left, `${bounds.action} crosses the left viewport edge`).toBeGreaterThanOrEqual(0);
      expect(bounds.top, `${bounds.action} crosses the top viewport edge`).toBeGreaterThanOrEqual(0);
      expect(bounds.right, `${bounds.action} crosses the right viewport edge`).toBeLessThanOrEqual(844);
      expect(bounds.bottom, `${bounds.action} crosses the bottom viewport edge`).toBeLessThanOrEqual(390);
    }
  });
});
