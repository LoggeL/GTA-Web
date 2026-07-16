import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { CITY_HALF_SIZE } from '../../src/game/city';
import { cameraSafeFraction } from '../../src/game/collision';
import { PLAYER_RADIUS, createPlayerState, stepPlayer } from '../../src/game/player';
import { createWorldInputState } from '../../src/game/types';
import {
  MAX_SAFE_EXIT_SPEED,
  createVehicleState,
  findVehicleExitPoint,
  stepVehicle,
  vehicleCanExit,
} from '../../src/game/vehicle';

describe('on-foot movement', () => {
  it('moves camera-relative, sprints, and returns to ground after jumping', () => {
    const player = createPlayerState({ x: 0, y: 0, z: 20 });
    const input = createWorldInputState();
    input.moveForward = 1;
    input.sprint = true;

    for (let frame = 0; frame < 60; frame += 1) {
      stepPlayer(player, input, 0, [], 1 / 60);
    }
    expect(player.position.z).toBeLessThan(12);
    expect(player.sprinting).toBe(true);

    input.moveForward = 0;
    input.sprint = false;
    input.jump = true;
    stepPlayer(player, input, 0, [], 1 / 60);
    expect(player.grounded).toBe(false);
    expect(player.position.y).toBeGreaterThan(0);
    input.jump = false;
    for (let frame = 0; frame < 90; frame += 1) {
      stepPlayer(player, input, 0, [], 1 / 60);
    }
    expect(player.grounded).toBe(true);
    expect(player.position.y).toBe(0);
  });

  it('stays inside world bounds and cannot pass through a building', () => {
    const input = createWorldInputState();
    input.moveRight = 1;
    const boundaryPlayer = createPlayerState({ x: CITY_HALF_SIZE - 1, y: 0, z: 0 });
    for (let frame = 0; frame < 30; frame += 1) {
      stepPlayer(boundaryPlayer, input, 0, [], 1 / 60);
    }
    expect(boundaryPlayer.position.x).toBeLessThanOrEqual(CITY_HALF_SIZE - PLAYER_RADIUS);

    const wall: CollisionRect = { minX: 2, maxX: 5, minZ: -2, maxZ: 2, height: 10 };
    const blockedPlayer = createPlayerState({ x: 0, y: 0, z: 0 });
    for (let frame = 0; frame < 90; frame += 1) {
      stepPlayer(blockedPlayer, input, 0, [wall], 1 / 60);
    }
    expect(blockedPlayer.position.x).toBeLessThanOrEqual(2 - PLAYER_RADIUS);
  });

  it('steps onto and off an authored low obstacle without losing grounding', () => {
    const player = createPlayerState({ x: 0, y: 0, z: 0 });
    const input = createWorldInputState();
    input.moveRight = 1;
    const step: CollisionRect = {
      id: 'test-step', minX: 1, maxX: 2.5, minZ: -1, maxZ: 1, height: 0.34, kind: 'step',
    };
    let sawStep = false;
    for (let frame = 0; frame < 70; frame += 1) {
      stepPlayer(player, input, 0, [step], 1 / 60);
      sawStep ||= player.traversalMode === 'stepping' && player.position.y === step.height;
    }
    expect(sawStep).toBe(true);
    expect(player.position.x).toBeGreaterThan(step.maxX + PLAYER_RADIUS);
    expect(player.position.y).toBe(0);
    expect(player.grounded).toBe(true);
  });

  it('performs a deterministic contextual vault and lands past the obstacle', () => {
    const player = createPlayerState({ x: 0, y: 0, z: 0 });
    const input = createWorldInputState();
    input.moveRight = 1;
    input.jump = true;
    const vault: CollisionRect = {
      id: 'test-vault', minX: 1, maxX: 2.1, minZ: -1, maxZ: 1, height: 0.9, kind: 'vault',
    };
    stepPlayer(player, input, 0, [vault], 1 / 60);
    expect(player.traversalMode).toBe('vaulting');
    input.jump = false;
    for (let frame = 0; frame < 30; frame += 1) {
      stepPlayer(player, input, 0, [vault], 1 / 60);
    }
    expect(player.traversalMode).toBe('grounded');
    expect(player.position.x).toBeGreaterThan(vault.maxX + PLAYER_RADIUS);
    expect(player.position.y).toBe(0);
  });

  it('recovers a grounded state deterministically after falling below the surface', () => {
    const player = createPlayerState({ x: 0, y: -2, z: 0 });
    player.grounded = false;
    player.velocity.y = -4;
    stepPlayer(player, createWorldInputState(), 0, [], 1 / 60);
    expect(player.position.y).toBe(0);
    expect(player.velocity.y).toBe(0);
    expect(player.grounded).toBe(true);
    expect(player.traversalMode).toBe('grounded');
  });
});

describe('arcade vehicle physics', () => {
  it('accelerates, steers, brakes, and takes non-explosive collision damage', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 20 });
    const input = createWorldInputState();
    input.moveForward = 1;
    input.moveRight = 0.25;
    const wall: CollisionRect = { minX: -12, maxX: 12, minZ: -4, maxZ: -2, height: 8 };

    for (let frame = 0; frame < 180; frame += 1) {
      stepVehicle(vehicle, input, [wall], 1 / 60);
    }
    expect(vehicle.position.z).toBeGreaterThan(-2);
    expect(vehicle.health).toBeLessThan(100);
    expect(vehicle.health).toBeGreaterThanOrEqual(0);

    input.moveForward = 0;
    input.handbrake = true;
    const speedBeforeBrake = Math.abs(vehicle.speed);
    for (let frame = 0; frame < 30; frame += 1) {
      stepVehicle(vehicle, input, [wall], 1 / 60);
    }
    expect(Math.abs(vehicle.speed)).toBeLessThan(speedBeforeBrake);
  });

  it('finds a collision-safe side for vehicle exit', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 });
    const blockedRight: CollisionRect = { minX: 1, maxX: 4, minZ: -2, maxZ: 2, height: 4 };
    const exit = findVehicleExitPoint(vehicle, [blockedRight]);
    expect(exit).not.toBeNull();
    expect(exit?.x).toBeLessThan(0);
  });

  it('allows exit only when occupied and moving at a safe speed', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 });
    expect(vehicleCanExit(vehicle)).toBe(false);
    vehicle.occupied = true;
    vehicle.speed = MAX_SAFE_EXIT_SPEED;
    expect(vehicleCanExit(vehicle)).toBe(true);
    vehicle.speed = MAX_SAFE_EXIT_SPEED + 0.01;
    expect(vehicleCanExit(vehicle)).toBe(false);
  });

  it('slightly reduces turn-in and handbrake grip on rain-slick roads', () => {
    const dry = createVehicleState({ x: 0, y: 0.48, z: 80 });
    const wet = createVehicleState({ x: 0, y: 0.48, z: 80 });
    const input = createWorldInputState();
    input.moveForward = 1;
    input.moveRight = 1;

    for (let frame = 0; frame < 90; frame += 1) {
      stepVehicle(dry, input, [], 1 / 60, { rainIntensity: 0 });
      stepVehicle(wet, input, [], 1 / 60, { rainIntensity: 1 });
    }
    expect(Math.abs(wet.heading)).toBeLessThan(Math.abs(dry.heading));

    input.moveForward = 0;
    input.handbrake = true;
    const drySpeed = Math.abs(dry.speed);
    const wetSpeed = Math.abs(wet.speed);
    stepVehicle(dry, input, [], 1 / 60, { rainIntensity: 0 });
    stepVehicle(wet, input, [], 1 / 60, { rainIntensity: 1 });
    expect(drySpeed - Math.abs(dry.speed)).toBeGreaterThan(
      wetSpeed - Math.abs(wet.speed),
    );
  });

  it('refuses an exit when every candidate side is obstructed', () => {
    const vehicle = createVehicleState({ x: 0, y: 0.48, z: 0 });
    const enclosure: CollisionRect = { minX: -4, maxX: 4, minZ: -4, maxZ: 4, height: 5 };
    expect(findVehicleExitPoint(vehicle, [enclosure])).toBeNull();
  });
});

describe('camera collision', () => {
  it('shortens the target-to-camera segment in front of a building', () => {
    const wall: CollisionRect = { minX: -2, maxX: 2, minZ: 3, maxZ: 5, height: 12 };
    const fraction = cameraSafeFraction(
      { x: 0, y: 2, z: 0 },
      { x: 0, y: 5, z: 8 },
      [wall],
    );
    expect(fraction).toBeGreaterThanOrEqual(0.2);
    expect(fraction).toBeLessThan(1);
  });
});
