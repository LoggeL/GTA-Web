import type { Page } from '@playwright/test';

import { PLAYER_SPAWN, VEHICLE_SPAWN } from '../../src/game/city';
import { AUTHORED_INTERIORS } from '../../src/game/InteriorRuntime';
import { startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaTrafficVehicle {
  id: string;
  classId: string;
  behavior: string;
  x: number;
  z: number;
}

interface QaApi {
  teleport(x: number, z: number): unknown;
  snapshot(): {
    heading: number;
    speedMetersPerSecond: number;
    vehiclePosition: { x: number; z: number };
  } | null;
  trafficVehicles(): readonly QaTrafficVehicle[];
  setMoney(value: number): number;
  setActiveVehicleClass(classId: string): unknown;
  setActiveVehicleCondition(bodyHealth: number, engineHealth: number): unknown;
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

const GARAGE_PORTAL_POSITION = AUTHORED_INTERIORS.find(
  ({ id }) => id === 'moreno-garage',
)?.portal.position;

if (!GARAGE_PORTAL_POSITION) {
  throw new Error('Missing authored Moreno Garage portal');
}

async function qaTeleport(page: Page, x: number, z: number): Promise<void> {
  await page.evaluate(({ targetX, targetZ }) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    api.teleport(targetX, targetZ);
  }, { targetX: x, targetZ: z });
}

test.describe('M3 vehicles, ownership, and garage acceptance', () => {
  test('drives all eight classes and makes live traffic yield to a police siren', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop class matrix complements the dedicated mobile vehicle course');
    test.setTimeout(75_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');
    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
    await qaTeleport(page, PLAYER_SPAWN.x, PLAYER_SPAWN.z);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');

    const classIds = [
      'compact',
      'sedan',
      'muscle',
      'sports',
      'van',
      'pickup',
      'police-cruiser',
      'motorcycle',
    ] as const;
    for (const classId of classIds) {
      await qaTeleport(page, VEHICLE_SPAWN.x, VEHICLE_SPAWN.z);
      const before = await page.evaluate((id) => {
        const api = (window as QaWindow).__HEATLINE_QA__;
        if (!api) throw new Error('HEATLINE QA API is unavailable');
        api.setActiveVehicleClass(id);
        return api.snapshot();
      }, classId);
      if (!before) throw new Error('Missing pre-drive snapshot');
      await expect(world).toHaveAttribute('data-vehicle-class-id', classId);
      await page.keyboard.down('w');
      await page.keyboard.down('a');
      await page.waitForTimeout(460);
      await page.keyboard.up('a');
      await page.keyboard.up('w');
      const after = await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.snapshot());
      if (!after) throw new Error('Missing post-drive snapshot');
      expect(after.speedMetersPerSecond).toBeGreaterThan(0.15);
      expect(Math.hypot(
        after.vehiclePosition.x - before.vehiclePosition.x,
        after.vehiclePosition.z - before.vehiclePosition.z,
      )).toBeGreaterThan(0.04);
      expect(Math.abs(after.heading - before.heading)).toBeGreaterThan(0.001);
      await page.keyboard.press('r');
    }

    await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      api.setActiveVehicleClass('police-cruiser');
      const traffic = api.trafficVehicles()[0];
      if (!traffic) throw new Error('No traffic actor is available for the siren test');
      api.teleport(traffic.x, traffic.z);
    });
    const canvas = page.locator('canvas.world-view__canvas');
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
    await page.mouse.down({ button: 'left' });
    await expect(world).toHaveAttribute('data-vehicle-siren-active', 'true');
    await expect.poll(async () => page.evaluate(() => (
      (window as QaWindow).__HEATLINE_QA__?.trafficVehicles()
        .filter(({ behavior }) => behavior === 'siren-yield').length ?? 0
    ))).toBeGreaterThan(0);
    await page.mouse.up({ button: 'left' });
    await expect(world).toHaveAttribute('data-vehicle-siren-active', 'false');
  });

  test('steals, registers, upgrades, damages, and restores an ambient vehicle', async ({ page, isMobile }) => {
    test.skip(Boolean(isMobile), 'Desktop service workflow covers persistence; touch driving remains in the mobile smoke');
    test.setTimeout(50_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');
    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
    await page.evaluate(() => (window as QaWindow).__HEATLINE_QA__?.setMoney(100_000));

    const target = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const vehicle = api.trafficVehicles().find((candidate) => candidate.classId !== 'police-cruiser');
      if (!vehicle) throw new Error('No registerable ambient traffic vehicle was available');
      api.teleport(vehicle.x, vehicle.z);
      return vehicle;
    });
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');
    await expect(world).toHaveAttribute('data-vehicle-class-id', target.classId);
    await expect(world).toHaveAttribute('data-vehicle-registered', 'false');
    const stolenInstanceId = await world.getAttribute('data-vehicle-instance-id');
    expect(stolenInstanceId).toMatch(/^stolen-traffic-/);

    await qaTeleport(page, VEHICLE_SPAWN.x, VEHICLE_SPAWN.z);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'on-foot');
    await qaTeleport(page, GARAGE_PORTAL_POSITION.x, GARAGE_PORTAL_POSITION.z);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-interior-id', 'moreno-garage');

    await page.getByRole('navigation', { name: 'Game panels' })
      .getByRole('button', { name: 'Garage' })
      .click();
    let panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel.getByRole('heading', { name: 'Vehicle ownership and service' })).toBeVisible();
    await panel.locator('[data-garage-action="register"]').click();
    await expect(world).toHaveAttribute('data-vehicle-registered', 'true');
    await expect(panel.locator('[data-garage-slots]')).toHaveAttribute('data-garage-slots', '2/8');

    const stolenCard = panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`);
    await expect(stolenCard).toBeVisible();
    await stolenCard.locator('[data-garage-action="retrieve"]').click();
    await expect(panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`))
      .toHaveAttribute('data-garage-slot', '0');
    await expect(panel.locator(`[data-garage-vehicle="${stolenInstanceId}"] [data-garage-active]`))
      .toHaveAttribute('data-garage-active', 'true');
    await stolenCard.locator('[data-garage-action="upgrade"][data-upgrade-kind="engine"]').click();
    await expect(panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`)).toContainText('Engine · tier 1/3');
    await panel.locator(
      `[data-garage-vehicle="${stolenInstanceId}"] [data-garage-action="paint"][data-paint-id="sunset-orange"]`,
    ).click();
    await expect(panel.locator(
      `[data-garage-vehicle="${stolenInstanceId}"] [data-garage-action="paint"][data-paint-id="sunset-orange"]`,
    )).toHaveAttribute('aria-pressed', 'true');
    await expect(world).toHaveAttribute('data-vehicle-paint', 'sunset-orange');

    await page.evaluate(() => {
      (window as QaWindow).__HEATLINE_QA__?.setActiveVehicleCondition(54, 37);
    });
    await panel.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('navigation', { name: 'Game panels' })
      .getByRole('button', { name: 'Garage' })
      .click();
    panel = page.getByRole('region', { name: 'Game panel', exact: true });
    const damagedCard = panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`);
    await expect(damagedCard.getByLabel('Body health 54 percent')).toBeVisible();
    await expect(damagedCard.getByLabel('Engine health 37 percent')).toBeVisible();
    await expect(damagedCard.locator('[data-garage-action="repair-all"]')).toBeEnabled();

    await panel.getByRole('button', { name: 'Close' }).click();
    await world.locator('canvas').focus();
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-interior-id', '');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save and quit to menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 15_000 });
    await expect(world).toHaveAttribute('data-vehicle-instance-id', stolenInstanceId!);
    await expect(world).toHaveAttribute('data-vehicle-paint', 'sunset-orange');
    await qaTeleport(page, GARAGE_PORTAL_POSITION.x, GARAGE_PORTAL_POSITION.z);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-interior-id', 'moreno-garage');
    await page.getByRole('navigation', { name: 'Game panels' })
      .getByRole('button', { name: 'Garage' })
      .click();
    panel = page.getByRole('region', { name: 'Game panel', exact: true });
    await expect(panel.locator('[data-garage-slots]')).toHaveAttribute('data-garage-slots', '2/8');
    const restoredCard = panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`);
    await expect(restoredCard).toContainText('Engine · tier 1/3');
    await expect(restoredCard.getByLabel('Body health 54 percent')).toBeVisible();
    await expect(restoredCard.getByLabel('Engine health 37 percent')).toBeVisible();
    await expect(restoredCard.locator('[data-paint-id="sunset-orange"]')).toHaveAttribute('aria-pressed', 'true');
    await restoredCard.locator('[data-garage-action="repair-all"]').click();
    const repairedCard = panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`);
    await expect(repairedCard.getByLabel('Body health 100 percent')).toBeVisible();
    await expect(repairedCard.getByLabel('Engine health 100 percent')).toBeVisible();

    await panel.getByRole('button', { name: 'Close' }).click();
    await world.locator('canvas').focus();
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-interior-id', '');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save and quit to menu' }).click();
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('button', { name: 'Play' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('Game HUD')).toBeVisible({ timeout: 15_000 });
    await qaTeleport(page, GARAGE_PORTAL_POSITION.x, GARAGE_PORTAL_POSITION.z);
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-interior-id', 'moreno-garage');
    await page.getByRole('navigation', { name: 'Game panels' })
      .getByRole('button', { name: 'Garage' })
      .click();
    panel = page.getByRole('region', { name: 'Game panel', exact: true });
    const repairedAfterReload = panel.locator(`[data-garage-vehicle="${stolenInstanceId}"]`);
    await expect(repairedAfterReload.getByLabel('Body health 100 percent')).toBeVisible();
    await expect(repairedAfterReload.getByLabel('Engine health 100 percent')).toBeVisible();
  });
});
