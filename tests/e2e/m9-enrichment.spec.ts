import type { Page } from '@playwright/test';

import { startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaActor {
  readonly x: number;
  readonly z: number;
}

interface QaTrafficActor extends QaActor {
  readonly classId: string;
}

interface QaApi {
  teleport(x: number, z: number): unknown;
  trafficVehicles(): readonly QaTrafficActor[];
  pedestrians(): readonly QaActor[];
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

interface NearbyPopulation {
  readonly traffic: number;
  readonly pedestrians: number;
  readonly trafficClasses: number;
}

async function teleport(page: Page, x: number, z: number): Promise<void> {
  await page.evaluate(({ targetX, targetZ }) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    api.teleport(targetX, targetZ);
  }, { targetX: x, targetZ: z });
}

async function nearbyPopulation(
  page: Page,
  trafficRadius: number,
  pedestrianRadius: number,
): Promise<NearbyPopulation> {
  return page.evaluate(({ trafficRange, pedestrianRange }) => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    const world = document.querySelector<HTMLElement>('[data-world-mount]');
    if (!api || !world) throw new Error('HEATLINE QA population telemetry is unavailable');
    const playerX = Number(world.dataset.playerX);
    const playerZ = Number(world.dataset.playerZ);
    const distance = (actor: QaActor) => Math.hypot(actor.x - playerX, actor.z - playerZ);
    const traffic = api.trafficVehicles();
    return {
      traffic: traffic.filter((actor) => distance(actor) <= trafficRange).length,
      pedestrians: api.pedestrians()
        .filter((actor) => distance(actor) <= pedestrianRange).length,
      trafficClasses: new Set(traffic.map(({ classId }) => classId)).size,
    };
  }, { trafficRange: trafficRadius, pedestrianRange: pedestrianRadius });
}

test.describe('M9 city-life enrichment acceptance', () => {
  test('keeps richly dressed streets and dense nearby city life across all districts', async ({
    page,
    isMobile,
  }) => {
    test.skip(Boolean(isMobile), 'The full four-district density matrix runs on desktop');
    test.setTimeout(75_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
    const world = page.getByLabel('3D game world');

    const trafficLimit = Number(await world.getAttribute('data-traffic-limit'));
    const pedestrianLimit = Number(await world.getAttribute('data-pedestrian-limit'));
    expect(trafficLimit).toBeGreaterThanOrEqual(18);
    expect(pedestrianLimit).toBeGreaterThanOrEqual(30);
    expect(Number(await world.getAttribute('data-visible-structures'))).toBeGreaterThan(300);
    expect(Number(await world.getAttribute('data-visible-props'))).toBeGreaterThan(30);

    const stops = [
      { x: -350, z: -350, district: 'neon-strand' },
      { x: 350, z: -350, district: 'alta-vista' },
      { x: 350, z: 350, district: 'breakwater' },
      { x: -350, z: 350, district: 'arroyo-heights' },
    ] as const;

    for (const stop of stops) {
      await teleport(page, stop.x, stop.z);
      await expect(world).toHaveAttribute('data-district', stop.district);
      await expect.poll(async () => {
        const population = await nearbyPopulation(page, 180, 132);
        return Math.min(
          population.traffic / Math.floor(trafficLimit * 0.78),
          population.pedestrians / Math.floor(pedestrianLimit * 0.75),
        );
      }).toBeGreaterThanOrEqual(1);
      const population = await nearbyPopulation(page, 180, 132);
      expect(population.trafficClasses).toBeGreaterThanOrEqual(trafficLimit >= 40 ? 6 : 5);
    }
  });

  test('retains a coherent enriched low-quality city on compact landscape mobile', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'The compact enrichment course runs on the mobile project');
    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');

    expect(Number(await world.getAttribute('data-traffic-limit'))).toBeGreaterThanOrEqual(10);
    expect(Number(await world.getAttribute('data-pedestrian-limit'))).toBeGreaterThanOrEqual(18);
    expect(Number(await world.getAttribute('data-visible-structures'))).toBeGreaterThan(300);
    expect(Number(await world.getAttribute('data-visible-props'))).toBeGreaterThanOrEqual(35);
    await expect(page.locator('[data-touch-layout]')).toBeVisible();

    const layout = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  });
});
