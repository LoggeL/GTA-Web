import type { Page } from '@playwright/test';

import { PLAYER_SPAWN } from '../../src/game/city';
import { startNewGame } from './helpers';
import { expect, test } from './fixtures';

interface QaTrafficVehicle {
  readonly id: string;
  readonly classId: string;
  readonly behavior: string;
  readonly speed: number;
  readonly heading: number;
  readonly roadId: string;
  readonly x: number;
  readonly z: number;
}

interface QaTrafficSignal {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly phase: string;
  readonly horizontalAspect: string;
  readonly verticalAspect: string;
  readonly horizontalRoadIds: readonly string[];
  readonly verticalRoadIds: readonly string[];
  readonly secondsUntilChange: number;
}

interface QaApi {
  teleport(x: number, z: number): {
    vehiclePosition: { x: number; z: number };
  };
  snapshot(): {
    vehiclePosition: { x: number; z: number };
  } | null;
  trafficVehicles(): readonly QaTrafficVehicle[];
  trafficSignals(): readonly QaTrafficSignal[];
}

type QaWindow = Window & { __HEATLINE_QA__?: QaApi };

async function waitForQa(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as QaWindow).__HEATLINE_QA__));
}

async function stoppedSignalEvidence(page: Page): Promise<{
  actorId: string;
  signalId: string;
  ahead: number;
  speed: number;
  aspect: string;
} | null> {
  return page.evaluate(() => {
    const api = (window as QaWindow).__HEATLINE_QA__;
    if (!api) throw new Error('HEATLINE QA API is unavailable');
    const signals = api.trafficSignals();
    for (const actor of api.trafficVehicles()) {
      if (actor.behavior !== 'signal-yield') continue;
      const forwardX = -Math.sin(actor.heading);
      const forwardZ = -Math.cos(actor.heading);
      for (const signal of signals) {
        const horizontal = signal.horizontalRoadIds.includes(actor.roadId);
        const vertical = signal.verticalRoadIds.includes(actor.roadId);
        if (!horizontal && !vertical) continue;
        const ahead = (signal.x - actor.x) * forwardX
          + (signal.z - actor.z) * forwardZ;
        const aspect = horizontal
          ? signal.horizontalAspect
          : signal.verticalAspect;
        if (aspect !== 'green' && ahead >= 11.3 && ahead <= 48) {
          return {
            actorId: actor.id,
            signalId: signal.id,
            ahead,
            speed: actor.speed,
            aspect,
          };
        }
      }
    }
    return null;
  });
}

test.describe('M10 traffic intelligence, collisions, and signals', () => {
  test('renders a complete safe signal network and stops live traffic before red', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await waitForQa(page);

    const signalCount = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const signals = api.trafficSignals();
      if (signals.some((signal) => (
        signal.horizontalAspect === 'green'
        && signal.verticalAspect === 'green'
      ))) {
        throw new Error('A signal junction granted conflicting greens');
      }
      const focus = signals.find((signal) => (
        signal.horizontalRoadIds.includes('arroyo-heights-road-h-2')
        && signal.verticalRoadIds.includes('arroyo-heights-road-v-3')
      )) ?? signals[0];
      if (!focus) throw new Error('No traffic signals were generated');
      api.teleport(focus.x, focus.z);
      return signals.length;
    });
    expect(signalCount).toBeGreaterThan(30);

    await expect.poll(
      async () => (await stoppedSignalEvidence(page)) !== null,
      { timeout: 25_000, intervals: [100, 250, 500] },
    ).toBe(true);
    const stopped = await stoppedSignalEvidence(page);
    expect(stopped).not.toBeNull();
    expect(stopped?.ahead).toBeGreaterThanOrEqual(11.3);
    expect(stopped?.aspect).not.toBe('green');
    expect(Number.isFinite(stopped?.speed)).toBe(true);
  });

  test('physically separates an occupied player car from ambient traffic', async ({
    page,
    isMobile,
  }) => {
    test.skip(Boolean(isMobile), 'Desktop covers the player collision seam; mobile shares it');
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await waitForQa(page);
    const world = page.getByLabel('3D game world');
    await page.evaluate(({ x, z }) => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      api.teleport(x, z);
    }, { x: PLAYER_SPAWN.x, z: PLAYER_SPAWN.z });
    await page.keyboard.press('e');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');

    const targetId = await page.evaluate(() => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      if (!api) throw new Error('HEATLINE QA API is unavailable');
      const target = api.trafficVehicles()[0];
      if (!target) throw new Error('No ambient vehicle was available');
      const snapshot = api.teleport(target.x, target.z);
      if (
        Math.hypot(
          snapshot.vehiclePosition.x - target.x,
          snapshot.vehiclePosition.z - target.z,
        ) > 0.001
      ) {
        throw new Error('QA collision setup did not overlap the vehicles');
      }
      return target.id;
    });

    await expect.poll(async () => page.evaluate((id) => {
      const api = (window as QaWindow).__HEATLINE_QA__;
      const snapshot = api?.snapshot();
      const target = api?.trafficVehicles().find((vehicle) => vehicle.id === id);
      if (!snapshot || !target) return 0;
      return Math.hypot(
        snapshot.vehiclePosition.x - target.x,
        snapshot.vehiclePosition.z - target.z,
      );
    }, targetId)).toBeGreaterThan(2);
  });
});
