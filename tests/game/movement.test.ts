import { describe, expect, it } from 'vitest';

import type { CollisionRect } from '../../src/game/city';
import { CITY_HALF_SIZE } from '../../src/game/city';
import { cameraSafeFraction } from '../../src/game/collision';
import { PLAYER_RADIUS, createPlayerState, stepPlayer } from '../../src/game/player';
import { createWorldInputState } from '../../src/game/types';
import { createVehicleState, findVehicleExitPoint, stepVehicle } from '../../src/game/vehicle';

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

