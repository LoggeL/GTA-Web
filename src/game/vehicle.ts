import type { CollisionRect } from './city';
import { CITY_HALF_SIZE } from './city';
import { circleIntersectsBuildings, moveCircleWithCollisions } from './collision';
import type { Vec3Data, WorldInputState } from './types';

export const VEHICLE_RADIUS = 1.48;
export const MAX_SAFE_EXIT_SPEED = 2.2;
const MAX_FORWARD_SPEED = 31;
const MAX_REVERSE_SPEED = 9;
const DRIVE_ACCELERATION = 17;
const REVERSE_ACCELERATION = 9;

export interface VehicleSimulationState {
  position: Vec3Data;
  heading: number;
  speed: number;
  steering: number;
  health: number;
  occupied: boolean;
}

export interface VehicleSurfaceState {
  /** Zero is dry and one is the authored maximum rain intensity. */
  readonly rainIntensity?: number;
}

export function createVehicleState(position: Readonly<Vec3Data>): VehicleSimulationState {
  return {
    position: { ...position },
    heading: 0,
    speed: 0,
    steering: 0,
    health: 100,
    occupied: false,
  };
}

function moveTowards(current: number, target: number, maximumDelta: number): number {
  if (Math.abs(target - current) <= maximumDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maximumDelta;
}

export function stepVehicle(
  state: VehicleSimulationState,
  input: Readonly<WorldInputState>,
  collisions: readonly CollisionRect[],
  deltaSeconds: number,
  surface: Readonly<VehicleSurfaceState> = {},
): void {
  const dt = Math.min(0.05, Math.max(0, deltaSeconds));
  const throttle = Math.min(1, Math.max(-1, input.moveForward));
  const rainIntensity = Math.min(1, Math.max(0, surface.rainIntensity ?? 0));
  // Rain is intentionally mild: enough to lengthen braking and soften turn-in,
  // without making the arcade handling unpredictable on touch controls.
  const roadGrip = 1 - rainIntensity * 0.14;

  if (throttle > 0) {
    state.speed = Math.min(MAX_FORWARD_SPEED, state.speed + DRIVE_ACCELERATION * throttle * dt);
  } else if (throttle < 0) {
    const acceleration = state.speed > 0.25 ? DRIVE_ACCELERATION * 1.65 : REVERSE_ACCELERATION;
    state.speed = Math.max(-MAX_REVERSE_SPEED, state.speed + acceleration * throttle * dt);
  } else {
    const rollingDrag = 2.4 + Math.abs(state.speed) * 0.065;
    state.speed = moveTowards(state.speed, 0, rollingDrag * dt);
  }

  if (input.handbrake) {
    state.speed = moveTowards(state.speed, 0, 9.5 * roadGrip * dt);
  }

  state.steering = moveTowards(state.steering, Math.min(1, Math.max(-1, input.moveRight)), 5.5 * dt);
  const speedRatio = Math.min(1, Math.abs(state.speed) / 12);
  const steeringAuthority =
    (input.handbrake ? 1.48 : 1)
    * (0.36 + speedRatio * 0.64)
    * roadGrip;
  const direction = state.speed >= 0 ? 1 : -1;
  state.heading += state.steering * direction * steeringAuthority * 1.55 * dt;

  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const beforeX = state.position.x;
  const beforeZ = state.position.z;
  const collisionResult = moveCircleWithCollisions(
    state.position,
    forwardX * state.speed * dt,
    forwardZ * state.speed * dt,
    VEHICLE_RADIUS,
    collisions,
  );

  if (collisionResult.blockedX || collisionResult.blockedZ) {
    const impactSpeed = Math.abs(state.speed);
    state.position.x = beforeX;
    state.position.z = beforeZ;
    state.speed *= -0.16;
    state.health = Math.max(0, state.health - impactSpeed * 0.42);
  }
}

export function findVehicleExitPoint(
  state: Readonly<VehicleSimulationState>,
  collisions: readonly CollisionRect[],
): Vec3Data | null {
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const candidates = [
    { x: state.position.x + rightX * 2.35, z: state.position.z + rightZ * 2.35 },
    { x: state.position.x - rightX * 2.35, z: state.position.z - rightZ * 2.35 },
    { x: state.position.x - forwardX * 2.65, z: state.position.z - forwardZ * 2.65 },
    { x: state.position.x + forwardX * 2.65, z: state.position.z + forwardZ * 2.65 },
  ];

  for (const candidate of candidates) {
    const withinBounds = Math.abs(candidate.x) <= CITY_HALF_SIZE - 0.7
      && Math.abs(candidate.z) <= CITY_HALF_SIZE - 0.7;
    if (withinBounds && !circleIntersectsBuildings(candidate.x, candidate.z, 0.62, collisions)) {
      return { x: candidate.x, y: 0, z: candidate.z };
    }
  }
  return null;
}

export function vehicleCanExit(state: Readonly<VehicleSimulationState>): boolean {
  return state.occupied && Math.abs(state.speed) <= MAX_SAFE_EXIT_SPEED;
}
