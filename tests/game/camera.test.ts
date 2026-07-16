import { describe, expect, it } from 'vitest';

import { computeCameraPlacement, oppositeShoulder } from '../../src/game/camera';
import type { CollisionRect } from '../../src/game/city';

describe('third-person camera placement', () => {
  it('uses mirrored over-shoulder aim positions and a forward aim target', () => {
    const base = {
      target: { x: 0, y: 1.5, z: 0 },
      yaw: 0,
      pitch: 0.35,
      distance: 4,
      mode: 'aim' as const,
      collisions: [] as readonly CollisionRect[],
    };
    const right = computeCameraPlacement({ ...base, shoulderSide: 'right' });
    const left = computeCameraPlacement({ ...base, shoulderSide: 'left' });
    expect(right.position.x).toBeGreaterThan(0);
    expect(left.position.x).toBeLessThan(0);
    expect(right.position.x).toBeCloseTo(-left.position.x);
    expect(right.lookTarget.z).toBeLessThan(base.target.z);
    expect(oppositeShoulder('right')).toBe('left');
  });

  it('pulls the camera forward when a tall obstacle crosses its segment', () => {
    const wall: CollisionRect = { minX: -2, maxX: 2, minZ: 2, maxZ: 4, height: 10 };
    const clear = computeCameraPlacement({
      target: { x: 0, y: 1.5, z: 0 }, yaw: 0, pitch: 0.25, distance: 7,
      mode: 'follow', shoulderSide: 'right', collisions: [],
    });
    const obstructed = computeCameraPlacement({
      target: { x: 0, y: 1.5, z: 0 }, yaw: 0, pitch: 0.25, distance: 7,
      mode: 'follow', shoulderSide: 'right', collisions: [wall],
    });
    expect(obstructed.safeFraction).toBeLessThan(1);
    expect(obstructed.position.z).toBeLessThan(clear.position.z);
  });
});
