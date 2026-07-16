import type { VehicleImpactSide } from './vehicleIntegrity';
import type { CollisionRect } from './city';
import { clampToCity, supportHeightAt } from './collision';
import type { Vec3Data } from './types';
import type { VehicleSimulationState } from './vehicle';
import { requireVehicleDriveProfile } from './vehicleProfiles';

export const REFERENCE_VEHICLE_MASS_KG = 1_500;

export type VehicleSuspensionCorner =
  | 'front-left'
  | 'front-right'
  | 'rear-left'
  | 'rear-right';

export interface VehicleSuspensionContact {
  readonly corner: VehicleSuspensionCorner;
  readonly position: Readonly<Vec3Data>;
  readonly groundHeight: number;
  readonly compression: number;
  readonly grounded: boolean;
}

export interface VehicleSuspensionState {
  readonly contacts: readonly [
    VehicleSuspensionContact,
    VehicleSuspensionContact,
    VehicleSuspensionContact,
    VehicleSuspensionContact,
  ];
  readonly groundedContactCount: number;
  readonly targetRideHeight: number;
  readonly targetPitch: number;
  readonly targetRoll: number;
}

export interface VehicleCollisionBox {
  readonly center: { readonly x: number; readonly z: number };
  readonly heading: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly corners: readonly [
    { readonly x: number; readonly z: number },
    { readonly x: number; readonly z: number },
    { readonly x: number; readonly z: number },
    { readonly x: number; readonly z: number },
  ];
}

export interface VehicleCollisionMoveResult {
  readonly blockedX: boolean;
  readonly blockedZ: boolean;
  readonly impactSide: VehicleImpactSide | null;
  readonly impactNormal: { readonly x: number; readonly z: number } | null;
  readonly normalSpeedMetersPerSecond: number;
  readonly collisionId: string | null;
}

export interface VehicleImpactSnapshot {
  readonly side: VehicleImpactSide;
  readonly normalSpeedMetersPerSecond: number;
  readonly equivalentImpactSpeedMetersPerSecond: number;
  readonly blockedX: boolean;
  readonly blockedZ: boolean;
  readonly collisionId: string | null;
  readonly bodyDamage: number;
  readonly engineDamage: number;
  readonly tireDamage: readonly [number, number, number, number];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function vehicleMassResponseFactor(massKg: number): number {
  if (!Number.isFinite(massKg) || massKg <= 0) {
    throw new RangeError('vehicle mass must be finite and positive');
  }
  return clamp(Math.sqrt(REFERENCE_VEHICLE_MASS_KG / massKg), 0.72, 1.6);
}

export function vehicleDriftAngle(state: Readonly<VehicleSimulationState>): number {
  const lateralSpeed = state.lateralSpeed ?? 0;
  if (Math.abs(state.speed) < 0.001 && Math.abs(lateralSpeed) < 0.001) {
    return 0;
  }
  return Math.atan2(lateralSpeed, Math.max(0.001, Math.abs(state.speed)));
}

export function vehicleWorldVelocity(
  state: Readonly<VehicleSimulationState>,
): { readonly x: number; readonly z: number } {
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const lateralSpeed = state.lateralSpeed ?? 0;
  return {
    x: forwardX * state.speed + rightX * lateralSpeed,
    z: forwardZ * state.speed + rightZ * lateralSpeed,
  };
}

function suspensionContact(
  state: Readonly<VehicleSimulationState>,
  corner: VehicleSuspensionCorner,
  localRight: number,
  localForward: number,
  collisions: readonly CollisionRect[],
): VehicleSuspensionContact {
  const profile = requireVehicleDriveProfile(state.vehicleClassId);
  const handling = profile.arcadeHandling;
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const x = state.position.x + rightX * localRight + forwardX * localForward;
  const z = state.position.z + rightZ * localRight + forwardZ * localForward;
  const groundHeight = supportHeightAt(x, z, 0.16, collisions);
  const distanceToGround = state.position.y - groundHeight;
  const rayLength = handling.rideHeightMeters + handling.suspensionTravelMeters;
  return {
    corner,
    position: { x, y: groundHeight, z },
    groundHeight,
    compression: clamp(
      (rayLength - distanceToGround) / (handling.suspensionTravelMeters * 2),
      0,
      1,
    ),
    grounded: distanceToGround <= rayLength + 0.04,
  };
}

export function sampleVehicleSuspension(
  state: Readonly<VehicleSimulationState>,
  collisions: readonly CollisionRect[],
): VehicleSuspensionState {
  const profile = requireVehicleDriveProfile(state.vehicleClassId);
  const handling = profile.arcadeHandling;
  const halfWheelbase = handling.wheelbaseMeters / 2;
  const halfTrack = handling.trackWidthMeters / 2;
  const contacts: VehicleSuspensionState['contacts'] = [
    suspensionContact(state, 'front-left', -halfTrack, halfWheelbase, collisions),
    suspensionContact(state, 'front-right', halfTrack, halfWheelbase, collisions),
    suspensionContact(state, 'rear-left', -halfTrack, -halfWheelbase, collisions),
    suspensionContact(state, 'rear-right', halfTrack, -halfWheelbase, collisions),
  ];
  const groundedContacts = contacts.filter((contact) => contact.grounded);
  const groundedContactCount = groundedContacts.length;
  const averageGroundHeight = groundedContactCount === 0
    ? state.position.y - handling.rideHeightMeters
    : groundedContacts.reduce((sum, contact) => sum + contact.groundHeight, 0) / groundedContactCount;
  const frontHeight = (contacts[0].groundHeight + contacts[1].groundHeight) / 2;
  const rearHeight = (contacts[2].groundHeight + contacts[3].groundHeight) / 2;
  const leftHeight = (contacts[0].groundHeight + contacts[2].groundHeight) / 2;
  const rightHeight = (contacts[1].groundHeight + contacts[3].groundHeight) / 2;

  return {
    contacts,
    groundedContactCount,
    targetRideHeight: averageGroundHeight + handling.rideHeightMeters,
    targetPitch: groundedContactCount < 2
      ? 0
      : clamp(Math.atan2(frontHeight - rearHeight, handling.wheelbaseMeters), -0.32, 0.32),
    targetRoll: groundedContactCount < 2
      ? 0
      : clamp(Math.atan2(rightHeight - leftHeight, handling.trackWidthMeters), -0.32, 0.32),
  };
}

export function updateVehicleSuspension(
  state: VehicleSimulationState,
  collisions: readonly CollisionRect[],
  deltaSeconds: number,
): VehicleSuspensionState {
  const suspension = sampleVehicleSuspension(state, collisions);
  const profile = requireVehicleDriveProfile(state.vehicleClassId);
  const dt = clamp(deltaSeconds, 0, 0.05);
  const response = clamp(8 * vehicleMassResponseFactor(profile.massKg), 5, 12);
  const blend = 1 - Math.exp(-response * dt);
  state.position.y += (suspension.targetRideHeight - state.position.y) * blend;
  state.pitch = (state.pitch ?? 0) + (suspension.targetPitch - (state.pitch ?? 0)) * blend;
  state.roll = (state.roll ?? 0) + (suspension.targetRoll - (state.roll ?? 0)) * blend;
  state.suspension = suspension;
  return suspension;
}

function collisionBoxAt(
  state: Readonly<VehicleSimulationState>,
  x: number,
  z: number,
): VehicleCollisionBox {
  const handling = requireVehicleDriveProfile(state.vehicleClassId).arcadeHandling;
  const halfWidth = handling.collisionWidthMeters / 2;
  const halfLength = handling.collisionLengthMeters / 2;
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const corner = (rightScale: number, forwardScale: number) => ({
    x: x + rightX * halfWidth * rightScale + forwardX * halfLength * forwardScale,
    z: z + rightZ * halfWidth * rightScale + forwardZ * halfLength * forwardScale,
  });
  return {
    center: { x, z },
    heading: state.heading,
    halfWidth,
    halfLength,
    corners: [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)],
  };
}

export function createVehicleCollisionBox(
  state: Readonly<VehicleSimulationState>,
): VehicleCollisionBox {
  return collisionBoxAt(state, state.position.x, state.position.z);
}

function projectionRange(
  points: readonly { readonly x: number; readonly z: number }[],
  axisX: number,
  axisZ: number,
): readonly [number, number] {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const projection = point.x * axisX + point.z * axisZ;
    minimum = Math.min(minimum, projection);
    maximum = Math.max(maximum, projection);
  }
  return [minimum, maximum];
}

export function vehicleCollisionBoxIntersectsRect(
  box: Readonly<VehicleCollisionBox>,
  rect: Readonly<CollisionRect>,
): boolean {
  const rectCorners = [
    { x: rect.minX, z: rect.minZ },
    { x: rect.maxX, z: rect.minZ },
    { x: rect.maxX, z: rect.maxZ },
    { x: rect.minX, z: rect.maxZ },
  ];
  const axes = [
    { x: Math.cos(box.heading), z: -Math.sin(box.heading) },
    { x: -Math.sin(box.heading), z: -Math.cos(box.heading) },
    { x: 1, z: 0 },
    { x: 0, z: 1 },
  ];
  return axes.every((axis) => {
    const boxRange = projectionRange(box.corners, axis.x, axis.z);
    const rectRange = projectionRange(rectCorners, axis.x, axis.z);
    return boxRange[1] > rectRange[0] && rectRange[1] > boxRange[0];
  });
}

function blockingCollision(
  box: Readonly<VehicleCollisionBox>,
  collisions: readonly CollisionRect[],
): CollisionRect | null {
  return collisions.find((collision) =>
    collision.kind !== 'step' && vehicleCollisionBoxIntersectsRect(box, collision)) ?? null;
}

function classifyImpactSide(
  state: Readonly<VehicleSimulationState>,
  normalX: number,
  normalZ: number,
): VehicleImpactSide {
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const forwardDot = normalX * forwardX + normalZ * forwardZ;
  const rightDot = normalX * rightX + normalZ * rightZ;
  if (Math.abs(forwardDot) >= Math.abs(rightDot)) {
    return forwardDot <= 0 ? 'front' : 'rear';
  }
  return rightDot <= 0 ? 'right' : 'left';
}

export function moveVehicleCollisionBox(
  state: VehicleSimulationState,
  deltaX: number,
  deltaZ: number,
  collisions: readonly CollisionRect[],
): VehicleCollisionMoveResult {
  const handling = requireVehicleDriveProfile(state.vehicleClassId).arcadeHandling;
  const boundingRadius = Math.hypot(
    handling.collisionWidthMeters / 2,
    handling.collisionLengthMeters / 2,
  );
  const requestedX = state.position.x + deltaX;
  const nextX = clampToCity(requestedX, boundingRadius);
  const collisionX = Math.abs(deltaX) <= 0.000001
    ? null
    : blockingCollision(collisionBoxAt(state, nextX, state.position.z), collisions);
  const blockedX = collisionX !== null;
  if (!blockedX) {
    state.position.x = nextX;
  }

  const requestedZ = state.position.z + deltaZ;
  const nextZ = clampToCity(requestedZ, boundingRadius);
  const collisionZ = Math.abs(deltaZ) <= 0.000001
    ? null
    : blockingCollision(collisionBoxAt(state, state.position.x, nextZ), collisions);
  const blockedZ = collisionZ !== null;
  if (!blockedZ) {
    state.position.z = nextZ;
  }

  if (!blockedX && !blockedZ) {
    return {
      blockedX,
      blockedZ,
      impactSide: null,
      impactNormal: null,
      normalSpeedMetersPerSecond: 0,
      collisionId: null,
    };
  }

  let normalX = blockedX ? -Math.sign(deltaX) : 0;
  let normalZ = blockedZ ? -Math.sign(deltaZ) : 0;
  const normalLength = Math.hypot(normalX, normalZ) || 1;
  normalX /= normalLength;
  normalZ /= normalLength;
  const velocity = vehicleWorldVelocity(state);
  return {
    blockedX,
    blockedZ,
    impactSide: classifyImpactSide(state, normalX, normalZ),
    impactNormal: { x: normalX, z: normalZ },
    normalSpeedMetersPerSecond: Math.abs(velocity.x * normalX + velocity.z * normalZ),
    collisionId: collisionX?.id ?? collisionZ?.id ?? null,
  };
}
