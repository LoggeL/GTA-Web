import type { VehicleClassId } from '../data/types';
import type { CollisionRect } from './city';
import { CITY_HALF_SIZE } from './city';
import { circleIntersectsBuildings } from './collision';
import type { Vec3Data } from './types';
import type { VehicleSimulationState } from './vehicle';
import { requireVehicleDriveProfile } from './vehicleProfiles';

export const DEFAULT_VEHICLE_RECOVERY_SURFACE_Y = 0.48;

export type VehicleRecoveryKind = 'upright' | 'unstuck' | 'reset';
export type VehicleRecoveryMethod =
  | 'upright-in-place'
  | 'nearby-candidate'
  | 'fallback-transform'
  | 'reset-transform'
  | 'none';

export interface VehicleRecoveryTransform {
  readonly position: Readonly<Vec3Data>;
  readonly heading: number;
}

interface NearbyRecoveryRequest {
  readonly collisions: readonly CollisionRect[];
  readonly surfaceY?: number;
  readonly fallbackTransform?: Readonly<VehicleRecoveryTransform>;
}

export type VehicleRecoveryRequest =
  | (NearbyRecoveryRequest & { readonly kind: 'upright' })
  | (NearbyRecoveryRequest & { readonly kind: 'unstuck' })
  | {
    readonly kind: 'reset';
    readonly collisions: readonly CollisionRect[];
    readonly transform: Readonly<VehicleRecoveryTransform>;
  };

export interface NearbyVehicleRecoveryOptions {
  readonly surfaceY?: number;
  readonly fallbackTransform?: Readonly<VehicleRecoveryTransform>;
}

interface VehicleRecoveryPlanBase {
  readonly kind: VehicleRecoveryKind;
  readonly attempts: number;
  readonly candidateIndex: number | null;
}

export type VehicleRecoveryPlan =
  | (VehicleRecoveryPlanBase & {
    readonly success: true;
    readonly method: Exclude<VehicleRecoveryMethod, 'none'>;
    readonly transform: VehicleRecoveryTransform;
  })
  | (VehicleRecoveryPlanBase & {
    readonly success: false;
    readonly method: 'none';
    readonly transform: null;
  });

const UNSTUCK_DIRECTION_COUNT = 8;
const DIAGONAL_SCALE = Math.SQRT1_2;

function normalizeHeading(heading: number): number {
  const wrapped = ((heading + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function normalizeTransform(
  transform: Readonly<VehicleRecoveryTransform>,
): VehicleRecoveryTransform | null {
  const { x, y, z } = transform.position;
  if (![x, y, z, transform.heading].every(Number.isFinite)) {
    return null;
  }
  return {
    position: { x, y, z },
    heading: normalizeHeading(transform.heading),
  };
}

function recoveryRadius(vehicleClassId: VehicleClassId): number {
  return requireVehicleDriveProfile(vehicleClassId).arcadeHandling.collisionRadiusMeters;
}

export function isVehicleRecoveryTransformSafe(
  transform: Readonly<VehicleRecoveryTransform>,
  vehicleClassId: VehicleClassId,
  collisions: readonly CollisionRect[],
): boolean {
  const normalized = normalizeTransform(transform);
  if (normalized === null) {
    return false;
  }
  const radius = recoveryRadius(vehicleClassId);
  const { x, z } = normalized.position;
  return Math.abs(x) <= CITY_HALF_SIZE - radius
    && Math.abs(z) <= CITY_HALF_SIZE - radius
    && !circleIntersectsBuildings(x, z, radius, collisions);
}

function nearbyCandidates(
  state: Readonly<VehicleSimulationState>,
  surfaceY: number,
): readonly VehicleRecoveryTransform[] {
  if (!Number.isFinite(state.position.x) || !Number.isFinite(state.position.z)) {
    return [];
  }
  const heading = Number.isFinite(state.heading) ? normalizeHeading(state.heading) : 0;
  const forwardX = -Math.sin(heading);
  const forwardZ = -Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightZ = -Math.sin(heading);
  const directions: readonly (readonly [number, number])[] = [
    [-forwardX, -forwardZ],
    [rightX, rightZ],
    [-rightX, -rightZ],
    [forwardX, forwardZ],
    [(-forwardX + rightX) * DIAGONAL_SCALE, (-forwardZ + rightZ) * DIAGONAL_SCALE],
    [(-forwardX - rightX) * DIAGONAL_SCALE, (-forwardZ - rightZ) * DIAGONAL_SCALE],
    [(forwardX + rightX) * DIAGONAL_SCALE, (forwardZ + rightZ) * DIAGONAL_SCALE],
    [(forwardX - rightX) * DIAGONAL_SCALE, (forwardZ - rightZ) * DIAGONAL_SCALE],
  ];
  const radius = recoveryRadius(state.vehicleClassId);
  const distances = [
    radius * 2 + 1,
    radius * 3 + 2,
    radius * 5 + 3,
    radius * 8 + 4,
  ];
  const candidates: VehicleRecoveryTransform[] = [];
  for (const distance of distances) {
    for (const [directionX, directionZ] of directions) {
      candidates.push({
        position: {
          x: state.position.x + directionX * distance,
          y: surfaceY,
          z: state.position.z + directionZ * distance,
        },
        heading,
      });
    }
  }
  return candidates;
}

function failedPlan(
  kind: VehicleRecoveryKind,
  attempts: number,
): VehicleRecoveryPlan {
  return {
    success: false,
    kind,
    method: 'none',
    attempts,
    candidateIndex: null,
    transform: null,
  };
}

export function planVehicleRecovery(
  state: Readonly<VehicleSimulationState>,
  request: Readonly<VehicleRecoveryRequest>,
): VehicleRecoveryPlan {
  if (request.kind === 'reset') {
    const transform = normalizeTransform(request.transform);
    if (
      transform !== null
      && isVehicleRecoveryTransformSafe(transform, state.vehicleClassId, request.collisions)
    ) {
      return {
        success: true,
        kind: request.kind,
        method: 'reset-transform',
        attempts: 1,
        candidateIndex: null,
        transform,
      };
    }
    return failedPlan(request.kind, 1);
  }

  const surfaceY = request.surfaceY ?? DEFAULT_VEHICLE_RECOVERY_SURFACE_Y;
  if (!Number.isFinite(surfaceY)) {
    throw new TypeError('vehicle recovery surface y must be finite');
  }
  const heading = Number.isFinite(state.heading) ? normalizeHeading(state.heading) : 0;
  let attempts = 0;

  if (request.kind === 'upright') {
    attempts += 1;
    const inPlace = normalizeTransform({
      position: { x: state.position.x, y: surfaceY, z: state.position.z },
      heading,
    });
    if (
      inPlace !== null
      && isVehicleRecoveryTransformSafe(inPlace, state.vehicleClassId, request.collisions)
    ) {
      return {
        success: true,
        kind: request.kind,
        method: 'upright-in-place',
        attempts,
        candidateIndex: null,
        transform: inPlace,
      };
    }
  }

  const candidates = nearbyCandidates(state, surfaceY);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    attempts += 1;
    if (isVehicleRecoveryTransformSafe(candidate, state.vehicleClassId, request.collisions)) {
      return {
        success: true,
        kind: request.kind,
        method: 'nearby-candidate',
        attempts,
        candidateIndex,
        transform: candidate,
      };
    }
  }

  if (request.fallbackTransform !== undefined) {
    attempts += 1;
    const fallback = normalizeTransform(request.fallbackTransform);
    if (
      fallback !== null
      && isVehicleRecoveryTransformSafe(fallback, state.vehicleClassId, request.collisions)
    ) {
      return {
        success: true,
        kind: request.kind,
        method: 'fallback-transform',
        attempts,
        candidateIndex: null,
        transform: fallback,
      };
    }
  }

  return failedPlan(request.kind, attempts);
}

/** Applies only pose/motion recovery; damage, upgrades, ownership, and occupancy survive. */
export function applyVehicleRecovery(
  state: VehicleSimulationState,
  plan: Readonly<VehicleRecoveryPlan>,
): VehicleRecoveryPlan {
  if (!plan.success) {
    return plan;
  }
  state.position.x = plan.transform.position.x;
  state.position.y = plan.transform.position.y;
  state.position.z = plan.transform.position.z;
  state.heading = plan.transform.heading;
  state.pitch = 0;
  state.roll = 0;
  state.speed = 0;
  state.lateralSpeed = 0;
  state.steering = 0;
  state.lastImpact = null;
  return plan;
}

export function recoverVehicle(
  state: VehicleSimulationState,
  request: Readonly<VehicleRecoveryRequest>,
): VehicleRecoveryPlan {
  return applyVehicleRecovery(state, planVehicleRecovery(state, request));
}

export function uprightVehicle(
  state: VehicleSimulationState,
  collisions: readonly CollisionRect[],
  options: Readonly<NearbyVehicleRecoveryOptions> = {},
): VehicleRecoveryPlan {
  return recoverVehicle(state, { kind: 'upright', collisions, ...options });
}

export function unstuckVehicle(
  state: VehicleSimulationState,
  collisions: readonly CollisionRect[],
  options: Readonly<NearbyVehicleRecoveryOptions> = {},
): VehicleRecoveryPlan {
  return recoverVehicle(state, { kind: 'unstuck', collisions, ...options });
}

export function resetVehicle(
  state: VehicleSimulationState,
  collisions: readonly CollisionRect[],
  transform: Readonly<VehicleRecoveryTransform>,
): VehicleRecoveryPlan {
  return recoverVehicle(state, { kind: 'reset', collisions, transform });
}

export const VEHICLE_UNSTUCK_CANDIDATE_COUNT = UNSTUCK_DIRECTION_COUNT * 4;
