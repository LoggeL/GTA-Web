import { describe, expect, it } from 'vitest';

import {
  computeCameraPlacement,
  computeCameraShakeOffset,
  normalizeCameraShakeIntensity,
  oppositeShoulder,
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
