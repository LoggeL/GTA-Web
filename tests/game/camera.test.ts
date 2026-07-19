import { describe, expect, it } from 'vitest';

import {
  computeCameraPlacement,
  computeCameraShakeOffset,
  normalizeCameraShakeIntensity,
  oppositeShoulder,
  smoothFollowYaw,
} from '../../src/game/camera';
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

  it('preserves camera placement when streamed blockers are outside the segment bounds', () => {
    const base = {
      target: { x: 4, y: 1.5, z: -3 },
      yaw: 0.35,
      pitch: 0.28,
      distance: 7,
      mode: 'follow' as const,
      shoulderSide: 'right' as const,
    };
    const clear = computeCameraPlacement({ ...base, collisions: [] });
    const withFarBlockers = computeCameraPlacement({
      ...base,
      collisions: Array.from({ length: 200 }, (_, index): CollisionRect => ({
        minX: 100 + index * 4,
        maxX: 103 + index * 4,
        minZ: -300 - index * 3,
        maxZ: -297 - index * 3,
        height: 80,
      })),
    });
    expect(withFarBlockers).toEqual(clear);
  });
});

describe('camera shake presentation', () => {
  it('normalizes finite setting values and rejects non-finite input', () => {
    expect(normalizeCameraShakeIntensity(-0.2)).toBe(0);
    expect(normalizeCameraShakeIntensity(0.45)).toBe(0.45);
    expect(normalizeCameraShakeIntensity(1.4)).toBe(1);
    expect(() => normalizeCameraShakeIntensity(Number.NaN)).toThrow(TypeError);
    expect(() => normalizeCameraShakeIntensity(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('is deterministic and combines subtle speed and stronger impact motion', () => {
    const base = {
      elapsedSeconds: 2.75,
      intensity: 0.8,
      reducedMotion: false,
      speedMetersPerSecond: 22,
      impactStrength: 0.65,
    };
    const first = computeCameraShakeOffset(base);
    const second = computeCameraShakeOffset(base);
    const speedOnly = computeCameraShakeOffset({ ...base, impactStrength: 0 });
    expect(first).toEqual(second);
    expect(Math.hypot(first.x, first.y, first.z)).toBeGreaterThan(
      Math.hypot(speedOnly.x, speedOnly.y, speedOnly.z),
    );
    expect(Math.abs(first.x)).toBeLessThanOrEqual(0.055 * 0.8 + 0.012 * 0.8);
    expect(Math.abs(first.y)).toBeLessThanOrEqual(0.042 * 0.8 + 0.016 * 0.8);
  });

  it('returns exact zero when disabled, motion is reduced, or the actor is stationary', () => {
    const moving = {
      elapsedSeconds: 1.2,
      intensity: 1,
      reducedMotion: false,
      speedMetersPerSecond: 28,
      impactStrength: 1,
    };
    expect(computeCameraShakeOffset({ ...moving, intensity: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(computeCameraShakeOffset({ ...moving, reducedMotion: true })).toEqual({ x: 0, y: 0, z: 0 });
    expect(computeCameraShakeOffset({
      ...moving,
      speedMetersPerSecond: 0,
      impactStrength: 0,
    })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('fixed follow-camera yaw', () => {
  it('converges smoothly without overshooting the target heading', () => {
    const first = smoothFollowYaw(0, 1, 0.1);
    const second = smoothFollowYaw(first, 1, 0.1);

    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(1);
  });

  it('takes the short arc when the heading crosses the ±pi wrap point', () => {
    const current = Math.PI - 0.05;
    const target = -Math.PI + 0.05;
    const next = smoothFollowYaw(current, target, 0.1);

    expect(next).toBeGreaterThan(current);
    expect(next - current).toBeLessThan(0.1);
  });

  it('holds at zero elapsed time and validates its tuning inputs', () => {
    expect(smoothFollowYaw(0.8, -1.4, 0)).toBe(0.8);
    expect(smoothFollowYaw(0.8, -1.4, -1)).toBe(0.8);
    expect(() => smoothFollowYaw(Number.NaN, 0, 0.1)).toThrow(TypeError);
    expect(() => smoothFollowYaw(0, 0, 0.1, 0)).toThrow(RangeError);
  });
});
