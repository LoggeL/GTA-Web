import type { CollisionRect } from './city';
import {
  circleIntersectsBuildings,
  findVaultObstacle,
  moveCircleWithCollisions,
  movementBlockersAtHeight,
  supportHeightAt,
} from './collision';
import type { TraversalMode, Vec3Data, WorldInputState } from './types';

export const PLAYER_RADIUS = 0.58;
const WALK_SPEED = 5.4;
const SPRINT_SPEED = 9.2;
const CROUCH_SPEED = 2.75;
const GROUND_ACCELERATION = 22;
const AIR_ACCELERATION = 6;
const JUMP_VELOCITY = 8.2;
const GRAVITY = 22;
const VAULT_DURATION = 0.42;

interface VaultMotion {
  start: Vec3Data;
  end: Vec3Data;
  elapsed: number;
  duration: number;
  peakHeight: number;
}

export interface PlayerSimulationState {
  position: Vec3Data;
  velocity: Vec3Data;
  heading: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  jumpLocked: boolean;
  stride: number;
  traversalMode: TraversalMode;
  surfaceHeight: number;
  vault: VaultMotion | null;
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
    traversalMode: 'grounded',
    surfaceHeight: 0,
    vault: null,
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

  if (state.vault) {
    advanceVault(state, dt, collisions);
    return;
  }

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

  const canStartTraversal = input.jump
    && state.grounded
    && !state.jumpLocked
    && !state.crouching
    && inputLength > 0.1;
  if (canStartTraversal) {
    const directionLength = Math.max(0.000001, Math.hypot(moveX, moveZ));
    const directionX = moveX / directionLength;
    const directionZ = moveZ / directionLength;
    const probeDistance = PLAYER_RADIUS + 0.72;
    const obstacle = findVaultObstacle(
      state.position.x + directionX * probeDistance,
      state.position.z + directionZ * probeDistance,
      PLAYER_RADIUS,
      collisions,
    );
    if (obstacle && startVault(state, obstacle, directionX, directionZ, collisions)) {
      state.jumpLocked = true;
      advanceVault(state, dt, collisions);
      return;
    }
  }

  if (input.jump && state.grounded && !state.jumpLocked && !state.crouching) {
    state.velocity.y = JUMP_VELOCITY;
    state.grounded = false;
    state.jumpLocked = true;
    state.traversalMode = 'airborne';
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
    movementBlockersAtHeight(collisions, state.position.y),
  );
  if (collisionResult.blockedX) {
    state.velocity.x = 0;
  }
  if (collisionResult.blockedZ) {
    state.velocity.z = 0;
  }

  const supportHeight = supportHeightAt(
    state.position.x,
    state.position.z,
    PLAYER_RADIUS * 0.55,
    collisions,
  );
  state.surfaceHeight = supportHeight;
  if (state.grounded) {
    state.position.y = supportHeight;
  } else {
    state.position.y += state.velocity.y * dt;
  }
  if (state.position.y <= supportHeight && state.velocity.y <= 0) {
    state.position.y = supportHeight;
    state.velocity.y = 0;
    state.grounded = true;
  }
  state.traversalMode = state.grounded
    ? supportHeight > 0 ? 'stepping' : 'grounded'
    : 'airborne';

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

/** Applies a dynamic correction without bypassing authored static blockers. */
export function movePlayerCollisionCircle(
  state: PlayerSimulationState,
  deltaX: number,
  deltaZ: number,
  collisions: readonly CollisionRect[],
): void {
  const result = moveCircleWithCollisions(
    state.position,
    deltaX,
    deltaZ,
    PLAYER_RADIUS,
    movementBlockersAtHeight(collisions, state.position.y),
  );
  if (result.blockedX) state.velocity.x = 0;
  if (result.blockedZ) state.velocity.z = 0;
}

function startVault(
  state: PlayerSimulationState,
  obstacle: Readonly<CollisionRect>,
  directionX: number,
  directionZ: number,
  collisions: readonly CollisionRect[],
): boolean {
  const projectedCorners = [
    (obstacle.minX - state.position.x) * directionX + (obstacle.minZ - state.position.z) * directionZ,
    (obstacle.minX - state.position.x) * directionX + (obstacle.maxZ - state.position.z) * directionZ,
    (obstacle.maxX - state.position.x) * directionX + (obstacle.minZ - state.position.z) * directionZ,
    (obstacle.maxX - state.position.x) * directionX + (obstacle.maxZ - state.position.z) * directionZ,
  ];
  const farEdge = Math.max(...projectedCorners);
  const distance = Math.min(4.5, Math.max(1.75, farEdge + PLAYER_RADIUS + 0.16));
  const end = {
    x: state.position.x + directionX * distance,
    y: 0,
    z: state.position.z + directionZ * distance,
  };
  const solidEndBlockers = collisions.filter((collision) => collision !== obstacle && collision.kind !== 'step');
  if (circleIntersectsBuildings(end.x, end.z, PLAYER_RADIUS, solidEndBlockers)) {
    return false;
  }
  state.vault = {
    start: { ...state.position },
    end,
    elapsed: 0,
    duration: VAULT_DURATION,
    peakHeight: obstacle.height + 0.48,
  };
  state.velocity = { x: 0, y: 0, z: 0 };
  state.grounded = false;
  state.traversalMode = 'vaulting';
  state.heading = Math.atan2(-directionX, -directionZ);
  return true;
}

function advanceVault(
  state: PlayerSimulationState,
  deltaSeconds: number,
  collisions: readonly CollisionRect[],
): void {
  const vault = state.vault;
  if (!vault) {
    return;
  }
  vault.elapsed = Math.min(vault.duration, vault.elapsed + deltaSeconds);
  const amount = vault.elapsed / vault.duration;
  const eased = amount * amount * (3 - 2 * amount);
  state.position.x = vault.start.x + (vault.end.x - vault.start.x) * eased;
  state.position.z = vault.start.z + (vault.end.z - vault.start.z) * eased;
  state.position.y = Math.max(0, Math.sin(Math.PI * amount) * vault.peakHeight);
  state.stride += deltaSeconds * 5;
  state.traversalMode = 'vaulting';
  if (amount >= 1) {
    const support = supportHeightAt(state.position.x, state.position.z, PLAYER_RADIUS * 0.55, collisions);
    state.position.y = support;
    state.surfaceHeight = support;
    state.grounded = true;
    state.velocity = { x: 0, y: 0, z: 0 };
    state.vault = null;
    state.traversalMode = support > 0 ? 'stepping' : 'grounded';
  }
}
