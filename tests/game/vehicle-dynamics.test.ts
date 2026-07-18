import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { createWorldInputState } from '../../src/game/types';
import {
  applyDynamicTrafficImpact,
  createVehicleState,
  stepVehicle,
} from '../../src/game/vehicle';
import {
  createVehicleCollisionBox,
  sampleVehicleSuspension,
  updateVehicleSuspension,
  vehicleCollisionBoxIntersectsRect,
  vehicleDriftAngle,
  vehicleMassResponseFactor,
} from '../../src/game/vehicleDynamics';
import { requireVehicleDriveProfile } from '../../src/game/vehicleProfiles';
import { InputController, toWorldInputState } from '../../src/input';

describe('measured arcade vehicle dynamics', () => {
  it('turns the player car toward the requested screen-space side', () => {
    const driveFromKey = (code: 'KeyA' | 'KeyD', speed = 12) => {
      const controller = new InputController({ mode: 'vehicle' });
      controller.keyDown(code);
      const input = toWorldInputState(controller.consumeFrame());
      const vehicle = createVehicleState({ x: 0, y: 0.48, z: 100 }, 'sports');
      vehicle.speed = speed;
      for (let frame = 0; frame < 15; frame += 1) {
        stepVehicle(vehicle, input, [], 1 / 60);
      }
      return vehicle;
    };

    const right = driveFromKey('KeyD');
    const left = driveFromKey('KeyA');

    expect(right.steering).toBeGreaterThan(0);
    expect(right.heading).toBeLessThan(0);
    expect(right.position.x).toBeGreaterThan(0);
    expect(left.steering).toBeLessThan(0);
    expect(left.heading).toBeGreaterThan(0);
    expect(left.position.x).toBeLessThan(0);

    const reversingRight = driveFromKey('KeyD', -12);
    const reversingLeft = driveFromKey('KeyA', -12);
    expect(reversingRight.steering).toBeGreaterThan(0);
    expect(reversingRight.heading).toBeGreaterThan(0);
    expect(reversingRight.position.x).toBeGreaterThan(0);
    expect(reversingLeft.steering).toBeLessThan(0);
    expect(reversingLeft.heading).toBeLessThan(0);
    expect(reversingLeft.position.x).toBeLessThan(0);
  });

  it('uses mass and turn response to separate nimble and heavy classes', () => {
    const motorcycleProfile = requireVehicleDriveProfile('motorcycle');
    const vanProfile = requireVehicleDriveProfile('van');
    expect(motorcycleProfile.massKg).toBeLessThan(vanProfile.massKg);
    expect(motorcycleProfile.turnResponse).toBeGreaterThan(vanProfile.turnResponse);
    expect(vehicleMassResponseFactor(motorcycleProfile.massKg)).toBeGreaterThan(
      vehicleMassResponseFactor(vanProfile.massKg),
    );

    const motorcycle = createVehicleState({ x: -40, y: 0.48, z: 100 }, 'motorcycle');
    const van = createVehicleState({ x: 40, y: 0.48, z: 100 }, 'van');
    motorcycle.speed = 15;
    van.speed = 15;
    const input = createWorldInputState();
    input.moveRight = 1;
    for (let frame = 0; frame < 60; frame += 1) {
      stepVehicle(motorcycle, input, [], 1 / 60);
      stepVehicle(van, input, [], 1 / 60);
    }

    expect(Math.abs(motorcycle.heading)).toBeGreaterThan(Math.abs(van.heading) * 4);
    expect(Math.abs(motorcycle.lateralSpeed ?? 0)).toBeGreaterThan(
      Math.abs(van.lateralSpeed ?? 0) * 2,
    );
    expect(motorcycle.steering).toBe(1);
    expect(van.steering).toBe(1);
  });

  it('turns handbrake input into controllable sustained drift instead of only braking', () => {
    const planted = createVehicleState({ x: -100, y: 0.48, z: 100 }, 'muscle');
    const drifting = createVehicleState({ x: 100, y: 0.48, z: 100 }, 'muscle');
    planted.speed = 22;
    drifting.speed = 22;
    const plantedInput = createWorldInputState();
    plantedInput.moveRight = 1;
    const driftInput = createWorldInputState();
    driftInput.moveRight = 1;
    driftInput.handbrake = true;

    for (let frame = 0; frame < 90; frame += 1) {
      stepVehicle(planted, plantedInput, [], 1 / 60);
      stepVehicle(drifting, driftInput, [], 1 / 60);
    }

    expect(Math.abs(drifting.lateralSpeed ?? 0)).toBeGreaterThan(
      Math.abs(planted.lateralSpeed ?? 0) * 4,
    );
    expect(Math.abs(vehicleDriftAngle(drifting))).toBeGreaterThan(0.45);
    expect(Math.abs(vehicleDriftAngle(planted))).toBeLessThan(0.1);
    expect(Math.abs(drifting.heading)).toBeGreaterThan(Math.abs(planted.heading) * 1.5);
    expect(Math.abs(drifting.speed)).toBeLessThan(Math.abs(planted.speed));
  });

  it('samples four suspension contacts and settles pitch over a low step', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    const step: CollisionRect = {
      id: 'front-axle-step',
      minX: -2,
      maxX: 2,
      minZ: -3,
      maxZ: 0,
      height: 0.34,
      kind: 'step',
    };
    const sample = sampleVehicleSuspension(vehicle, [step]);

    expect(sample.contacts.map((contact) => contact.corner)).toEqual([
      'front-left',
      'front-right',
      'rear-left',
      'rear-right',
    ]);
    expect(sample.groundedContactCount).toBe(4);
    expect(sample.contacts[0].groundHeight).toBe(0.34);
    expect(sample.contacts[1].groundHeight).toBe(0.34);
    expect(sample.contacts[2].groundHeight).toBe(0);
    expect(sample.contacts[0].compression).toBeGreaterThan(sample.contacts[2].compression);
    expect(sample.targetPitch).toBeGreaterThan(0.1);
    expect(sample.targetRoll).toBe(0);

    for (let frame = 0; frame < 60; frame += 1) {
      updateVehicleSuspension(vehicle, [step], 1 / 60);
    }
    expect(vehicle.position.y).toBeCloseTo(sample.targetRideHeight, 3);
    expect(vehicle.pitch).toBeCloseTo(sample.targetPitch, 3);
    expect(vehicle.roll).toBeCloseTo(0, 6);
    expect(vehicle.lastImpact).toBeNull();
  });

  it('makes mass materially affect measured braking distance and residual speed', () => {
    const motorcycle = createVehicleState({ x: -40, y: 0.48, z: 100 }, 'motorcycle');
    const sedan = createVehicleState({ x: 0, y: 0.48, z: 100 }, 'sedan');
    const van = createVehicleState({ x: 40, y: 0.48, z: 100 }, 'van');
    for (const vehicle of [motorcycle, sedan, van]) {
      vehicle.speed = 25;
    }
    const brake = createWorldInputState();
    brake.moveForward = -1;

    for (let frame = 0; frame < 60; frame += 1) {
      stepVehicle(motorcycle, brake, [], 1 / 60);
      stepVehicle(sedan, brake, [], 1 / 60);
      stepVehicle(van, brake, [], 1 / 60);
    }

    expect(motorcycle.speed).toBeLessThan(sedan.speed);
    expect(sedan.speed).toBeLessThan(van.speed);
    expect(motorcycle.position.z).toBeGreaterThan(sedan.position.z);
    expect(sedan.position.z).toBeGreaterThan(van.position.z);
  });

  it('uses the oriented collision box for front impacts and records damage evidence', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 3 }, 'compact');
    vehicle.speed = 15;
    const wall: CollisionRect = {
      id: 'front-wall',
      minX: -4,
      maxX: 4,
      minZ: 0,
      maxZ: 1,
      height: 8,
    };
    const box = createVehicleCollisionBox(vehicle);
    expect(box.halfLength * 2).toBe(
      requireVehicleDriveProfile('compact').arcadeHandling.collisionLengthMeters,
    );
    expect(vehicleCollisionBoxIntersectsRect(box, wall)).toBe(false);

    stepVehicle(vehicle, createWorldInputState(), [wall], 0.05);

    expect(vehicle.lastImpact).toMatchObject({
      side: 'front',
      blockedX: false,
      blockedZ: true,
      collisionId: 'front-wall',
    });
    expect(vehicle.lastImpact?.normalSpeedMetersPerSecond).toBeGreaterThan(14);
    expect(vehicle.lastImpact?.bodyDamage).toBeGreaterThan(10);
    expect(vehicle.lastImpact?.engineDamage).toBeGreaterThan(0);
    expect(vehicle.integrity.bodyHealth).toBeLessThan(90);
    expect(vehicle.speed).toBeLessThan(0);
  });

  it('classifies a lateral box impact and damages only the struck tire pair', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan');
    vehicle.lateralSpeed = 12;
    const wall: CollisionRect = {
      id: 'right-side-wall',
      minX: 1.2,
      maxX: 2.2,
      minZ: -4,
      maxZ: 4,
      height: 8,
    };

    stepVehicle(vehicle, createWorldInputState(), [wall], 0.05);

    expect(vehicle.lastImpact).toMatchObject({
      side: 'right',
      blockedX: true,
      blockedZ: false,
      collisionId: 'right-side-wall',
    });
    expect(vehicle.lastImpact?.tireDamage[0]).toBe(0);
    expect(vehicle.lastImpact?.tireDamage[1]).toBeGreaterThan(0);
    expect(vehicle.lastImpact?.tireDamage[2]).toBe(0);
    expect(vehicle.lastImpact?.tireDamage[3]).toBeGreaterThan(0);
    expect(vehicle.integrity.bodyHealth).toBeLessThan(100);
    expect(vehicle.lateralSpeed).toBeLessThan(0);
  });

  it('turns an external-to-ambient traffic normal into front impact damage evidence', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    const impact = applyDynamicTrafficImpact(vehicle, {
      ambientVehicleId: 'ambient-07',
      impactSpeed: 14,
      // At heading zero the vehicle faces -Z, so the ambient car is in front.
      impactNormal: { x: 0, z: -1 },
    });

    expect(impact).toMatchObject({
      side: 'front',
      normalSpeedMetersPerSecond: 14,
      blockedX: false,
      blockedZ: false,
      collisionId: 'traffic:ambient-07',
    });
    expect(impact?.bodyDamage).toBeGreaterThan(0);
    expect(impact?.engineDamage).toBeGreaterThan(0);
    expect(vehicle.lastImpact).toEqual(impact);
    expect(vehicle.health).toBe(vehicle.integrity.engineHealth);
  });

  it('classifies a right-side traffic strike using the reversed solver normal', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'sedan');
    const impact = applyDynamicTrafficImpact(vehicle, {
      ambientVehicleId: 'right-lane-car',
      impactSpeed: 12,
      // The traffic solver points from the player toward the car on the right.
      impactNormal: { x: 1, z: 0 },
    });

    expect(impact?.side).toBe('right');
    expect(impact?.tireDamage[0]).toBe(0);
    expect(impact?.tireDamage[1]).toBeGreaterThan(0);
    expect(impact?.tireDamage[2]).toBe(0);
    expect(impact?.tireDamage[3]).toBeGreaterThan(0);
  });

  it('uses vehicle mass, armor, and surface durability in dynamic impact scaling', () => {
    const base = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'van');
    const protectedVehicle = createVehicleState(
      { x: 0, y: 0.48, z: 0 },
      'van',
      { upgrades: { engine: 0, brakes: 0, grip: 0, armor: 3 } },
    );
    const evidence = {
      ambientVehicleId: 'cross-traffic',
      impactSpeed: 18,
      impactNormal: { x: 0, z: -1 },
    } as const;

    const baseImpact = applyDynamicTrafficImpact(base, evidence);
    const protectedImpact = applyDynamicTrafficImpact(
      protectedVehicle,
      evidence,
      { durabilityMultiplier: 1.5 },
    );
    const profile = requireVehicleDriveProfile('van');

    expect(baseImpact?.equivalentImpactSpeedMetersPerSecond).toBeCloseTo(
      evidence.impactSpeed * Math.sqrt(profile.massKg / 1_500),
      8,
    );
    expect(protectedImpact?.equivalentImpactSpeedMetersPerSecond).toBeCloseTo(
      (evidence.impactSpeed * Math.sqrt(profile.massKg / 1_500) * 0.76) / 1.5,
      8,
    );
    expect(protectedImpact?.bodyDamage).toBeLessThan(baseImpact?.bodyDamage ?? 0);
    expect(protectedImpact?.engineDamage).toBeLessThan(baseImpact?.engineDamage ?? 0);
  });

  it('ignores negligible contacts and bounds deterministic extreme collision damage', () => {
    const first = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    const second = createVehicleState({ x: 0, y: 0.48, z: 0 }, 'compact');
    const negligible = applyDynamicTrafficImpact(first, {
      ambientVehicleId: 'rolling-contact',
      impactSpeed: 2.5,
      impactNormal: { x: 0, z: -1 },
    });

    expect(negligible).toBeNull();
    expect(first.lastImpact).toBeNull();
    expect(first.integrity.bodyHealth).toBe(100);

    const severeEvidence = {
      ambientVehicleId: 'runaway-truck',
      impactSpeed: 1_000,
      impactNormal: { x: 0, z: -1 },
    } as const;
    const firstImpact = applyDynamicTrafficImpact(first, severeEvidence);
    const secondImpact = applyDynamicTrafficImpact(second, severeEvidence);

    expect(firstImpact).toEqual(secondImpact);
    expect(firstImpact?.bodyDamage).toBeLessThanOrEqual(100);
    expect(firstImpact?.engineDamage).toBeLessThanOrEqual(100);
    expect(first.integrity.bodyHealth).toBeGreaterThanOrEqual(0);
    expect(first.integrity.engineHealth).toBeGreaterThanOrEqual(0);
  });
});
