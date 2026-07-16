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
    await expect(touchControls.getByRole('button', { name: 'Reload' })).toBeVisible();

    const sprint = touchControls.locator('[data-touch-action="sprint"]');
    await sprint.dispatchEvent('pointerdown');
    await expect(sprint).toHaveClass(/is-active/);
    await sprint.dispatchEvent('pointerup');
    await expect(sprint).not.toHaveClass(/is-active/);

    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.teleport(-248, 243.5));
    const world = page.getByLabel('3D game world');
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
  });
});
