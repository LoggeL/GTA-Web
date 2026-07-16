import type { CollisionRect } from './city';
import { moveCircleWithCollisions } from './collision';
import type { Vec3Data, WorldInputState } from './types';

export const PLAYER_RADIUS = 0.58;
const WALK_SPEED = 5.4;
const SPRINT_SPEED = 9.2;
const CROUCH_SPEED = 2.75;
const GROUND_ACCELERATION = 22;
const AIR_ACCELERATION = 6;
const JUMP_VELOCITY = 8.2;
const GRAVITY = 22;

export interface PlayerSimulationState {
  position: Vec3Data;
  velocity: Vec3Data;
  heading: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  jumpLocked: boolean;
  stride: number;
}

export function createPlayerState(position: Readonly<Vec3Data>): PlayerSimulationState {
  return {
    position: { ...position },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    grounded: true,
    sprinting: false,
    crouching: false,
    jumpLocked: false,
    stride: 0,
  };
}

function damp(current: number, target: number, rate: number, deltaSeconds: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * deltaSeconds));
}

function shortestAngleDelta(current: number, target: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

export function stepPlayer(
  state: PlayerSimulationState,
  input: Readonly<WorldInputState>,
  cameraYaw: number,
  collisions: readonly CollisionRect[],
  deltaSeconds: number,
): void {
  const dt = Math.min(0.05, Math.max(0, deltaSeconds));
  const inputLength = Math.hypot(input.moveRight, input.moveForward);
  const normalizedRight = inputLength > 1 ? input.moveRight / inputLength : input.moveRight;
  const normalizedForward = inputLength > 1 ? input.moveForward / inputLength : input.moveForward;
  const forwardX = -Math.sin(cameraYaw);
  const forwardZ = -Math.cos(cameraYaw);
  const rightX = Math.cos(cameraYaw);
  const rightZ = -Math.sin(cameraYaw);
  const moveX = rightX * normalizedRight + forwardX * normalizedForward;
  const moveZ = rightZ * normalizedRight + forwardZ * normalizedForward;

  state.crouching = input.crouch && state.grounded;
  state.sprinting = input.sprint && !state.crouching && normalizedForward > 0.1 && inputLength > 0.1;
  const targetSpeed = state.crouching ? CROUCH_SPEED : state.sprinting ? SPRINT_SPEED : WALK_SPEED;
  const acceleration = state.grounded ? GROUND_ACCELERATION : AIR_ACCELERATION;
  state.velocity.x = damp(state.velocity.x, moveX * targetSpeed, acceleration, dt);
  state.velocity.z = damp(state.velocity.z, moveZ * targetSpeed, acceleration, dt);

  if (inputLength < 0.025 && state.grounded) {
    state.velocity.x = damp(state.velocity.x, 0, 28, dt);
    state.velocity.z = damp(state.velocity.z, 0, 28, dt);
  }

  if (input.jump && state.grounded && !state.jumpLocked && !state.crouching) {
    state.velocity.y = JUMP_VELOCITY;
    state.grounded = false;
    state.jumpLocked = true;
  }
  if (!input.jump) {
    state.jumpLocked = false;
  }

  if (!state.grounded) {
    state.velocity.y -= GRAVITY * dt;
  }

  const collisionResult = moveCircleWithCollisions(
    state.position,
    state.velocity.x * dt,
    state.velocity.z * dt,
    PLAYER_RADIUS,
    collisions,
  );
  if (collisionResult.blockedX) {
    state.velocity.x = 0;
  }
  if (collisionResult.blockedZ) {
    state.velocity.z = 0;
  }

  state.position.y += state.velocity.y * dt;
  if (state.position.y <= 0) {
    state.position.y = 0;
    state.velocity.y = 0;
    state.grounded = true;
  }

  const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  if (horizontalSpeed > 0.25) {
    const desiredHeading = Math.atan2(-state.velocity.x, -state.velocity.z);
    const turnRate = input.aim ? 20 : 11;
    state.heading += shortestAngleDelta(state.heading, input.aim ? cameraYaw : desiredHeading)
      * (1 - Math.exp(-turnRate * dt));
    state.stride += horizontalSpeed * dt;
  } else if (input.aim) {
    state.heading += shortestAngleDelta(state.heading, cameraYaw) * (1 - Math.exp(-20 * dt));
  }
}

