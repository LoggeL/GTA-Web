import { describe, expect, it } from 'vitest';

import { VEHICLES } from '../../src/data';
import type { VehicleClassId } from '../../src/data';
import { createWorldInputState } from '../../src/game/types';
import { createVehicleState, stepVehicle } from '../../src/game/vehicle';
import {
  applyVehicleDamage,
  applyVehicleRepairKit,
  calculateVehicleRepairQuote,
  createVehicleIntegrityState,
  restoreVehicleIntegrityToPercent,
  vehicleIntegrityCondition,
  vehiclePerformanceModifiers,
} from '../../src/game/vehicleIntegrity';
import {
  VEHICLE_DRIVE_PROFILES,
  requireVehicleDriveProfile,
  vehicleTopSpeedMetersPerSecond,
} from '../../src/game/vehicleProfiles';

describe('vehicle drive profiles', () => {
  it('uses the locked eight-class data registry as its only profile source', () => {
    expect(VEHICLE_DRIVE_PROFILES).toBe(VEHICLES);
    expect(VEHICLE_DRIVE_PROFILES.map((profile) => profile.id)).toEqual([
      'compact',
      'sedan',
      'muscle',
      'sports',
      'van',
      'pickup',
      'police-cruiser',
      'motorcycle',
    ]);

    const handlingSignatures = VEHICLE_DRIVE_PROFILES.map((profile) =>
      JSON.stringify(profile.arcadeHandling));
    expect(new Set(handlingSignatures).size).toBe(8);
  });

  it('drives every class to its distinct authored top speed deterministically', () => {
    const input = createWorldInputState();
    input.moveForward = 1;
    const attainedSpeeds = VEHICLE_DRIVE_PROFILES.map((profile) => {
      const vehicle = createVehicleState({ x: 0, y: 0.48, z: 100 }, profile.id);
      for (let frame = 0; frame < 30 * 60; frame += 1) {
        stepVehicle(vehicle, input, [], 1 / 60);
      }
      expect(vehicle.speed).toBeCloseTo(vehicleTopSpeedMetersPerSecond(profile), 6);
      return vehicle.speed;
    });

    expect(new Set(attainedSpeeds.map((speed) => speed.toFixed(6))).size).toBe(8);
  });

  it('makes sports, van, and motorcycle inputs visibly different at runtime', () => {
    const throttle = createWorldInputState();
    throttle.moveForward = 1;
    const sports = createVehicleState({ x: -40, y: 0.48, z: 100 }, 'sports');
    const van = createVehicleState({ x: 40, y: 0.48, z: 100 }, 'van');
    for (let frame = 0; frame < 120; frame += 1) {
      stepVehicle(sports, throttle, [], 1 / 60);
      stepVehicle(van, throttle, [], 1 / 60);
    }
    expect(sports.speed).toBeGreaterThan(van.speed * 2);

    const turn = createWorldInputState();
    turn.moveRight = 1;
    const motorcycle = createVehicleState({ x: -40, y: 0.48, z: 100 }, 'motorcycle');
    const turningVan = createVehicleState({ x: 40, y: 0.48, z: 100 }, 'van');
    motorcycle.speed = 10;
    turningVan.speed = 10;
    for (let frame = 0; frame < 60; frame += 1) {
      stepVehicle(motorcycle, turn, [], 1 / 60);
      stepVehicle(turningVan, turn, [], 1 / 60);
    }
    expect(Math.abs(motorcycle.heading)).toBeGreaterThan(Math.abs(turningVan.heading) * 2);

    const brake = createWorldInputState();
    brake.moveForward = -1;
    sports.speed = 20;
    van.speed = 20;
    for (let frame = 0; frame < 30; frame += 1) {
      stepVehicle(sports, brake, [], 1 / 60);
      stepVehicle(van, brake, [], 1 / 60);
    }
    expect(sports.speed).toBeLessThan(van.speed);
  });

  it('reduces acceleration and grip as the engine and tires deteriorate', () => {
    const healthy = createVehicleState({ x: -30, y: 0.48, z: 100 }, 'sedan');
    const damaged = createVehicleState({ x: 30, y: 0.48, z: 100 }, 'sedan');
    damaged.integrity = {
      bodyHealth: 55,
      engineHealth: 36,
      tireHealth: [100, 0, 100, 0],
    };
    damaged.health = damaged.integrity.engineHealth;
    const input = createWorldInputState();
    input.moveForward = 1;
    input.moveRight = 1;
    for (let frame = 0; frame < 120; frame += 1) {
      stepVehicle(healthy, input, [], 1 / 60);
      stepVehicle(damaged, input, [], 1 / 60);
    }
    expect(damaged.speed).toBeLessThan(healthy.speed);
    expect(Math.abs(damaged.heading)).toBeLessThan(Math.abs(healthy.heading));

    const disabled = createVehicleState({ x: 0, y: 0.48, z: 100 }, 'sedan');
    disabled.integrity = { ...createVehicleIntegrityState(), engineHealth: 0 };
    disabled.health = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      stepVehicle(disabled, input, [], 1 / 60);
    }
    expect(disabled.speed).toBe(0);

    const reverse = createWorldInputState();
    reverse.moveForward = -1;
    disabled.speed = -5;
    stepVehicle(disabled, reverse, [], 1 / 60);
    expect(disabled.speed).toBeGreaterThan(-5);
  });
});

describe('vehicle integrity and repairs', () => {
  it('moves deterministically through roadworthy, damaged, critical, and disabled states', () => {
    expect(vehicleIntegrityCondition(createVehicleIntegrityState())).toBe('roadworthy');
    expect(vehicleIntegrityCondition({
      bodyHealth: 70, engineHealth: 100, tireHealth: [100, 100, 100, 100],
    })).toBe('damaged');
    expect(vehicleIntegrityCondition({
      bodyHealth: 100, engineHealth: 25, tireHealth: [100, 100, 100, 100],
    })).toBe('critical');
    expect(vehicleIntegrityCondition({
      bodyHealth: 100, engineHealth: 0, tireHealth: [100, 100, 100, 100],
    })).toBe('disabled');

    const result = applyVehicleDamage(
      createVehicleIntegrityState(),
      requireVehicleDriveProfile('compact'),
      { kind: 'direct', amount: 100, target: 'engine' },
    );
    expect(result.conditionBefore).toBe('roadworthy');
    expect(result.conditionAfter).toBe('disabled');
    expect(result.integrity.engineHealth).toBe(0);
  });

  it('uses class durability for impacts and never mutates the source state', () => {
    const original = createVehicleIntegrityState();
    const event = { kind: 'collision', impactSpeedMetersPerSecond: 22, side: 'front' } as const;
    const sports = applyVehicleDamage(original, requireVehicleDriveProfile('sports'), event);
    const cruiser = applyVehicleDamage(original, requireVehicleDriveProfile('police-cruiser'), event);

    expect(sports.bodyDamage).toBeGreaterThan(cruiser.bodyDamage);
    expect(sports.engineDamage).toBeGreaterThan(cruiser.engineDamage);
    expect(original).toEqual(createVehicleIntegrityState());
    expect(sports.integrity.engineHealth).toBeGreaterThan(0);
  });

  it('targets all four tires consistently and side impacts damage the expected pair', () => {
    const profile = requireVehicleDriveProfile('sedan');
    const rearRight = applyVehicleDamage(
      createVehicleIntegrityState(),
      profile,
      { kind: 'direct', amount: 35, target: 'rear-right-tire' },
    );
    expect(rearRight.tireDamage.slice(0, 3)).toEqual([0, 0, 0]);
    expect(rearRight.tireDamage[3]).toBeGreaterThan(0);

    const leftImpact = applyVehicleDamage(
      createVehicleIntegrityState(),
      profile,
      { kind: 'collision', impactSpeedMetersPerSecond: 18, side: 'left' },
    );
    expect(leftImpact.tireDamage[0]).toBeGreaterThan(0);
    expect(leftImpact.tireDamage[1]).toBe(0);
    expect(leftImpact.tireDamage[2]).toBeGreaterThan(0);
    expect(leftImpact.tireDamage[3]).toBe(0);
  });

  it('derives field repairs, class-scaled quotes, and drive modifiers from integrity', () => {
    const damaged = {
      bodyHealth: 50,
      engineHealth: 40,
      tireHealth: [75, 50, 25, 0] as const,
    };
    const repaired = applyVehicleRepairKit(damaged);
    expect(repaired).toEqual({
      bodyHealth: 80,
      engineHealth: 62,
      tireHealth: damaged.tireHealth,
    });
    expect(applyVehicleRepairKit(repaired, 2).bodyHealth).toBe(100);

    const compactQuote = calculateVehicleRepairQuote(damaged, requireVehicleDriveProfile('compact'));
    const sportsQuote = calculateVehicleRepairQuote(damaged, requireVehicleDriveProfile('sports'));
    expect(compactQuote.total).toBeGreaterThan(0);
    expect(sportsQuote.total).toBeGreaterThan(compactQuote.total);
    expect(calculateVehicleRepairQuote(
      createVehicleIntegrityState(),
      requireVehicleDriveProfile('compact'),
    ).total).toBe(0);

    const healthyModifiers = vehiclePerformanceModifiers(createVehicleIntegrityState());
    const damagedModifiers = vehiclePerformanceModifiers(damaged);
    expect(healthyModifiers).toMatchObject({
      condition: 'roadworthy', engineOutput: 1, topSpeed: 1, grip: 1, braking: 1, steering: 1,
    });
    expect(damagedModifiers.engineOutput).toBeLessThan(healthyModifiers.engineOutput);
    expect(damagedModifiers.grip).toBeLessThan(healthyModifiers.grip);
  });

  it('restores every integrity channel to an authored checkpoint percentage', () => {
    expect(restoreVehicleIntegrityToPercent(55)).toEqual({
      bodyHealth: 55,
      engineHealth: 55,
      tireHealth: [55, 55, 55, 55],
    });
    expect(() => restoreVehicleIntegrityToPercent(-1)).toThrow(RangeError);
    expect(() => restoreVehicleIntegrityToPercent(101)).toThrow(RangeError);
  });

  it('rejects invalid damage and repair inputs', () => {
    const integrity = createVehicleIntegrityState();
    const profile = requireVehicleDriveProfile('compact');
    expect(() => applyVehicleDamage(integrity, profile, {
      kind: 'collision', impactSpeedMetersPerSecond: -1,
    })).toThrow(RangeError);
    expect(() => applyVehicleRepairKit(integrity, Number.NaN)).toThrow(RangeError);
  });

  it('keeps every class id accepted by the simulation constructor', () => {
    for (const classId of VEHICLE_DRIVE_PROFILES.map((profile) => profile.id) as VehicleClassId[]) {
      expect(createVehicleState({ x: 0, y: 0, z: 0 }, classId).vehicleClassId).toBe(classId);
    }
  });
});
