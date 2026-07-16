import { describe, expect, it } from 'vitest';

import {
  npcHasLineOfSight,
  NpcPerceptionSensor,
  npcTargetInVision,
  npcVisibilityFactor,
} from '../../src/simulation/npcPerception';

const profile = {
  visionRange: 30,
  peripheralRange: 5,
  fieldOfViewRadians: Math.PI / 2,
  hearingRange: 20,
  sightGainPerSecond: 1,
  hearingGainPerSecond: 0.5,
  awarenessDecayPerSecond: 0.25,
  memorySeconds: 1,
};

describe('NPC perception', () => {
  it('combines posture, cover, movement, and light into bounded visibility', () => {
    const exposed = npcVisibilityFactor({ lightLevel: 1, movement: 1 });
    const concealed = npcVisibilityFactor({
      lightLevel: 0.1,
      movement: 0,
      crouching: true,
      coverExposure: 0.25,
    });
    expect(exposed).toBe(1);
    expect(concealed).toBeGreaterThanOrEqual(0.05);
    expect(concealed).toBeLessThan(exposed * 0.2);
  });

  it('applies view cones, peripheral awareness, and obstacle line of sight', () => {
    const observer = { x: 0, y: 0, z: 0 };
    const ahead = { x: 0, y: 0, z: -12 };
    expect(npcTargetInVision(observer, 0, ahead, profile, 1, [])).toBe(true);
    expect(npcTargetInVision(observer, 0, { x: 12, y: 0, z: 0 }, profile, 1, [])).toBe(false);
    expect(npcTargetInVision(observer, 0, { x: 3, y: 0, z: 0 }, profile, 1, [])).toBe(true);
    expect(npcHasLineOfSight(observer, ahead, [{ x: 0, z: -6, radius: 2 }])).toBe(false);
    expect(npcTargetInVision(observer, 0, ahead, profile, 1, [{ x: 0, z: -6, radius: 2 }])).toBe(false);
  });

  it('hears unseen targets, detects visible threats, remembers, then decays', () => {
    const sensor = new NpcPerceptionSensor(profile);
    const baseContext = {
      deltaSeconds: 0.1,
      observerPosition: { x: 0, y: 0, z: 0 },
      observerHeading: 0,
      target: {
        id: 'player',
        position: { x: 0, y: 0, z: -10 },
        visibility: 1,
        noise: 1,
        threatening: true,
      },
      obstacles: [] as const,
    };
    for (let frame = 0; frame < 20; frame += 1) sensor.tick(baseContext);
    expect(sensor.getSnapshot()).toMatchObject({
      band: 'detected',
      targetVisible: true,
      targetHeard: true,
      lastSense: 'sight',
      lastKnownPosition: baseContext.target.position,
    });

    const blocked = sensor.tick({
      ...baseContext,
      target: { ...baseContext.target, noise: 0, threatening: false },
      obstacles: [{ x: 0, z: -5, radius: 2 }],
    });
    expect(blocked.targetVisible).toBe(false);
    expect(blocked.lastKnownPosition).toEqual(baseContext.target.position);
    for (let frame = 0; frame < 80; frame += 1) {
      sensor.tick({
        ...baseContext,
        target: { ...baseContext.target, position: { x: 100, y: 0, z: 100 }, noise: 0, threatening: false },
      });
    }
    expect(sensor.getSnapshot()).toMatchObject({
      awareness: 0,
      band: 'unaware',
      lastKnownPosition: null,
      lastSense: 'none',
    });
    expect(() => JSON.stringify(sensor.getSnapshot())).not.toThrow();
  });

  it('accepts deterministic squad alerts without omniscient sight', () => {
    const sensor = new NpcPerceptionSensor(profile);
    sensor.injectAlert({ x: 9, y: 0, z: -3 }, 0.8);
    const snapshot = sensor.tick({
      deltaSeconds: 0.1,
      observerPosition: { x: 0, y: 0, z: 0 },
      observerHeading: 0,
      target: {
        id: 'player',
        position: { x: 100, y: 0, z: 100 },
        visibility: 0,
        noise: 0,
        threatening: false,
      },
    });
    expect(snapshot.lastSense).toBe('alert');
    expect(snapshot.targetVisible).toBe(false);
    expect(snapshot.lastKnownPosition).toEqual({ x: 9, y: 0, z: -3 });
    expect(snapshot.band).toBe('suspicious');
  });
});
