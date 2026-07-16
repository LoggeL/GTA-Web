import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { createWorldInputState } from '../../src/game/types';
import { createVehicleState, stepVehicle } from '../../src/game/vehicle';
import {
  createVehicleCollisionBox,
  sampleVehicleSuspension,
  updateVehicleSuspension,
  vehicleCollisionBoxIntersectsRect,
  vehicleDriftAngle,
  vehicleMassResponseFactor,
} from '../../src/game/vehicleDynamics';
import { requireVehicleDriveProfile } from '../../src/game/vehicleProfiles';

describe('measured arcade vehicle dynamics', () => {
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
});
