import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { createVehicleState } from '../../src/game/vehicle';
import {
  DEFAULT_VEHICLE_RECOVERY_SURFACE_Y,
  VEHICLE_UNSTUCK_CANDIDATE_COUNT,
  isVehicleRecoveryTransformSafe,
  planVehicleRecovery,
  resetVehicle,
  unstuckVehicle,
  uprightVehicle,
} from '../../src/game/vehicleRecovery';

describe('vehicle recovery', () => {
  it('uprights in place, normalizes pose, and preserves mechanical state', () => {
    const state = createVehicleState({ x: 10, y: -3, z: 20 }, 'pickup', {
      integrity: {
        bodyHealth: 54,
        engineHealth: 61,
        tireHealth: [100, 72, 48, 0],
      },
      upgrades: { engine: 2, brakes: 1, grip: 3, armor: 2 },
    });
    const integrity = state.integrity;
    const upgrades = state.upgrades;
    state.heading = Math.PI * 5;
    state.pitch = 1.1;
    state.roll = -1.35;
    state.speed = 18;
    state.steering = 0.8;
    state.occupied = true;

    const result = uprightVehicle(state, []);

    expect(result).toMatchObject({
      success: true,
      kind: 'upright',
      method: 'upright-in-place',
      attempts: 1,
      candidateIndex: null,
    });
    expect(state.position).toEqual({ x: 10, y: DEFAULT_VEHICLE_RECOVERY_SURFACE_Y, z: 20 });
    expect(state.heading).toBeCloseTo(-Math.PI);
    expect(state.pitch).toBe(0);
    expect(state.roll).toBe(0);
    expect(state.speed).toBe(0);
    expect(state.steering).toBe(0);
    expect(state.integrity).toBe(integrity);
    expect(state.upgrades).toBe(upgrades);
    expect(state.occupied).toBe(true);
  });

  it('searches nearby candidates in a stable vehicle-relative order', () => {
    const state = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    state.heading = 0;
    const obstruction: CollisionRect = {
      id: 'blocks-first-behind-candidate',
      minX: -2,
      maxX: 2,
      minZ: 0,
      maxZ: 5,
      height: 8,
    };
    const before = structuredClone(state);
    const request = { kind: 'unstuck', collisions: [obstruction] } as const;

    const firstPlan = planVehicleRecovery(state, request);
    const secondPlan = planVehicleRecovery(state, request);

    expect(firstPlan).toEqual(secondPlan);
    expect(firstPlan).toMatchObject({
      success: true,
      kind: 'unstuck',
      method: 'nearby-candidate',
      attempts: 2,
      candidateIndex: 1,
    });
    expect(state).toEqual(before);

    const result = unstuckVehicle(state, [obstruction]);
    expect(result).toEqual(firstPlan);
    expect(state.position.x).toBeGreaterThan(0);
    expect(state.position.z).toBeCloseTo(0);
  });

  it('uses each class collision radius when validating recovery space', () => {
    const wall: CollisionRect = {
      minX: 1,
      maxX: 2,
      minZ: -5,
      maxZ: 5,
      height: 5,
    };
    const transform = { position: { x: 0, y: 0.48, z: 0 }, heading: 0 };

    expect(isVehicleRecoveryTransformSafe(transform, 'compact', [wall])).toBe(false);
    expect(isVehicleRecoveryTransformSafe(transform, 'motorcycle', [wall])).toBe(true);
  });

  it('falls back to a known-safe transform after exhausting nearby offsets', () => {
    const state = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    state.speed = 9;
    const enclosure: CollisionRect = {
      minX: -25,
      maxX: 25,
      minZ: -25,
      maxZ: 25,
      height: 20,
    };
    const fallbackTransform = {
      position: { x: 100, y: 0.48, z: 80 },
      heading: Math.PI / 2,
    };

    const result = unstuckVehicle(state, [enclosure], { fallbackTransform });

    expect(result).toMatchObject({
      success: true,
      method: 'fallback-transform',
      attempts: VEHICLE_UNSTUCK_CANDIDATE_COUNT + 1,
      candidateIndex: null,
    });
    expect(state.position).toEqual(fallbackTransform.position);
    expect(state.heading).toBeCloseTo(Math.PI / 2);
    expect(state.speed).toBe(0);
  });

  it('resets exactly to a safe transform without repairing or replacing the vehicle', () => {
    const state = createVehicleState({ x: -20, y: 4, z: 12 }, 'sports', {
      integrity: {
        bodyHealth: 32,
        engineHealth: 44,
        tireHealth: [15, 35, 55, 75],
      },
      upgrades: { engine: 3, brakes: 2, grip: 1, armor: 0 },
    });
    const integrity = state.integrity;
    const upgrades = state.upgrades;
    state.speed = -11;
    state.steering = -0.9;
    state.pitch = -0.7;
    state.roll = 1.2;
    state.occupied = true;
    const target = {
      position: { x: 120, y: 0.48, z: -80 },
      heading: Math.PI * 4.5,
    };

    const result = resetVehicle(state, [], target);

    expect(result).toMatchObject({
      success: true,
      kind: 'reset',
      method: 'reset-transform',
      attempts: 1,
    });
    expect(state.position).toEqual(target.position);
    expect(state.heading).toBeCloseTo(Math.PI / 2);
    expect(state.pitch).toBe(0);
    expect(state.roll).toBe(0);
    expect(state.speed).toBe(0);
    expect(state.steering).toBe(0);
    expect(state.vehicleClassId).toBe('sports');
    expect(state.integrity).toBe(integrity);
    expect(state.upgrades).toBe(upgrades);
    expect(state.health).toBe(44);
    expect(state.occupied).toBe(true);
  });

  it('fails atomically when no requested reset transform is safe', () => {
    const state = createVehicleState({ x: 5, y: 0.48, z: 6 }, 'van');
    state.speed = 7;
    state.steering = 0.4;
    state.pitch = 0.3;
    state.roll = -0.5;
    const before = structuredClone(state);

    const result = resetVehicle(state, [], {
      position: { x: 600, y: 0.48, z: 0 },
      heading: 0,
    });

    expect(result).toEqual({
      success: false,
      kind: 'reset',
      method: 'none',
      attempts: 1,
      candidateIndex: null,
      transform: null,
    });
    expect(state).toEqual(before);
  });

  it('rejects a non-finite recovery surface without mutating state', () => {
    const state = createVehicleState({ x: 0, y: 0.48, z: 0 });
    const before = structuredClone(state);

    expect(() => uprightVehicle(state, [], { surfaceY: Number.NaN })).toThrow(
      'vehicle recovery surface y must be finite',
    );
    expect(state).toEqual(before);
  });
});
