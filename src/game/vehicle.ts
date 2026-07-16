import type { VehicleClassId } from '../data/types';
import type { CollisionRect } from './city';
import { CITY_HALF_SIZE } from './city';
import { circleIntersectsBuildings } from './collision';
import type { Vec3Data, VehicleUpgradeLevels, WorldInputState } from './types';
import {
  REFERENCE_VEHICLE_MASS_KG,
  moveVehicleCollisionBox,
  sampleVehicleSuspension,
  updateVehicleSuspension,
  vehicleMassResponseFactor,
  vehicleWorldVelocity,
} from './vehicleDynamics';
import type { VehicleImpactSnapshot, VehicleSuspensionState } from './vehicleDynamics';
import {
  applyVehicleDamage,
  createVehicleIntegrityState,
  vehiclePerformanceModifiers,
} from './vehicleIntegrity';
import type { VehicleIntegrityState } from './vehicleIntegrity';
import {
  DEFAULT_VEHICLE_CLASS_ID,
  requireVehicleDriveProfile,
  vehicleReverseSpeedMetersPerSecond,
  vehicleTopSpeedMetersPerSecond,
} from './vehicleProfiles';

export const VEHICLE_RADIUS = requireVehicleDriveProfile(DEFAULT_VEHICLE_CLASS_ID)
  .arcadeHandling.collisionRadiusMeters;
export const MAX_SAFE_EXIT_SPEED = 2.2;

export interface VehicleSimulationState {
  vehicleClassId: VehicleClassId;
  position: Vec3Data;
  heading: number;
  /** Optional tilt used by presentation/recovery; planar driving ignores it. */
  pitch?: number;
  /** Optional tilt used by presentation/recovery; planar driving ignores it. */
  roll?: number;
  speed: number;
  /** Signed velocity along the vehicle's right axis. */
  lateralSpeed?: number;
  steering: number;
  /** Latest four-contact suspension sample. */
  suspension?: VehicleSuspensionState;
  /** Retained until the next impact so callers can surface deterministic evidence. */
  lastImpact?: VehicleImpactSnapshot | null;
  /** Engine-health percentage retained for the existing HUD/world contract. */
  health: number;
  integrity: VehicleIntegrityState;
  upgrades: VehicleUpgradeLevels;
  occupied: boolean;
}

export interface VehicleStateOptions {
  readonly integrity?: VehicleIntegrityState;
  readonly upgrades?: Readonly<VehicleUpgradeLevels>;
}

export interface VehicleSurfaceState {
  /** Zero is dry and one is the authored maximum rain intensity. */
  readonly rainIntensity?: number;
  readonly stabilityMultiplier?: number;
  readonly brakingMultiplier?: number;
  readonly durabilityMultiplier?: number;
}

export function createVehicleState(
  position: Readonly<Vec3Data>,
  vehicleClassId: VehicleClassId = DEFAULT_VEHICLE_CLASS_ID,
  options: Readonly<VehicleStateOptions> = {},
): VehicleSimulationState {
  requireVehicleDriveProfile(vehicleClassId);
  const integrity = options.integrity
    ? {
        bodyHealth: options.integrity.bodyHealth,
        engineHealth: options.integrity.engineHealth,
        tireHealth: [...options.integrity.tireHealth] as [number, number, number, number],
      }
    : createVehicleIntegrityState();
  vehiclePerformanceModifiers(integrity);
  const upgrades = normalizeVehicleUpgrades(options.upgrades);
  const state: VehicleSimulationState = {
    vehicleClassId,
    position: { ...position },
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    lateralSpeed: 0,
    steering: 0,
    lastImpact: null,
    health: integrity.engineHealth,
    integrity,
    upgrades,
    occupied: false,
  };
  state.suspension = sampleVehicleSuspension(state, []);
  return state;
}

function normalizeVehicleUpgrades(
  upgrades: Readonly<VehicleUpgradeLevels> | undefined,
): VehicleUpgradeLevels {
  const source = upgrades ?? { engine: 0, brakes: 0, grip: 0, armor: 0 };
  const normalized = { ...source };
  for (const [key, tier] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(tier) || tier < 0 || tier > 3) {
      throw new RangeError(`${key} vehicle upgrade tier must be an integer from 0 to 3`);
    }
  }
  return normalized;
}

function moveTowards(current: number, target: number, maximumDelta: number): number {
  if (Math.abs(target - current) <= maximumDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maximumDelta;
}

function positiveMultiplier(value: number | undefined, label: string): number {
  const resolved = value ?? 1;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${label} multiplier must be finite and positive`);
  }
  return resolved;
}

function applyRollingDrag(
  state: VehicleSimulationState,
  deltaSeconds: number,
  massResponse: number,
): void {
  const rollingDrag = (2.4 + Math.abs(state.speed) * 0.065) * massResponse;
  state.speed = moveTowards(state.speed, 0, rollingDrag * deltaSeconds);
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
  const stabilityMultiplier = positiveMultiplier(surface.stabilityMultiplier, 'vehicle stability');
  const brakingMultiplier = positiveMultiplier(surface.brakingMultiplier, 'vehicle braking');
  const durabilityMultiplier = positiveMultiplier(surface.durabilityMultiplier, 'vehicle durability');
  const profile = requireVehicleDriveProfile(state.vehicleClassId);
  const handling = profile.arcadeHandling;
  const condition = vehiclePerformanceModifiers(state.integrity);
  const massResponse = vehicleMassResponseFactor(profile.massKg);
  const brakeMassResponse = Math.min(1.4, Math.max(0.78, massResponse));
  const engineUpgrade = 1 + state.upgrades.engine * 0.06;
  const brakeUpgrade = 1 + state.upgrades.brakes * 0.08;
  const gripUpgrade = 1 + state.upgrades.grip * 0.05;
  const armorDamageMultiplier = 1 - state.upgrades.armor * 0.08;
  const maximumForwardSpeed = vehicleTopSpeedMetersPerSecond(profile)
    * condition.topSpeed
    * (1 + state.upgrades.engine * 0.025);
  const maximumReverseSpeed = vehicleReverseSpeedMetersPerSecond(profile) * condition.topSpeed;
  // Rain is intentionally mild: enough to lengthen braking and soften turn-in,
  // without making the arcade handling unpredictable on touch controls.
  const roadGrip = Math.min(1.45, (1 - rainIntensity * 0.14) * profile.grip * condition.grip * gripUpgrade * stabilityMultiplier);

  if (throttle > 0 && condition.engineOutput > 0) {
    const acceleration = profile.accelerationMetersPerSecondSquared * condition.engineOutput * engineUpgrade;
    state.speed = Math.min(maximumForwardSpeed, state.speed + acceleration * throttle * dt);
  } else if (throttle < 0) {
    if (state.speed > 0.25) {
      const braking = handling.brakeDecelerationMetersPerSecondSquared
        * condition.braking
        * roadGrip
        * brakeUpgrade
        * brakingMultiplier
        * brakeMassResponse;
      state.speed = Math.max(0, state.speed + braking * throttle * dt);
    } else if (condition.engineOutput > 0) {
      const reverseAcceleration = profile.accelerationMetersPerSecondSquared
        * 0.62
        * condition.engineOutput;
      state.speed = Math.max(-maximumReverseSpeed, state.speed + reverseAcceleration * throttle * dt);
    } else {
      applyRollingDrag(state, dt, massResponse);
    }
  } else {
    applyRollingDrag(state, dt, massResponse);
  }

  if (input.handbrake) {
    state.speed = moveTowards(
      state.speed,
      0,
      handling.handbrakeDecelerationMetersPerSecondSquared
        * condition.braking
        * roadGrip
        * brakeMassResponse
        * 0.72
        * dt,
    );
  }

  state.lateralSpeed = Number.isFinite(state.lateralSpeed) ? (state.lateralSpeed ?? 0) : 0;
  state.steering = moveTowards(
    state.steering,
    Math.min(1, Math.max(-1, input.moveRight)),
    handling.steeringResponsePerSecond
      * condition.steering
      * (0.55 + profile.turnResponse * 0.45)
      * massResponse
      * dt,
  );
  const speedRatio = maximumForwardSpeed <= 0
    ? 0
    : Math.min(1, Math.abs(state.speed) / maximumForwardSpeed);
  const speedSteering = (0.38 + speedRatio * 0.62)
    * (1 - speedRatio * (1 - handling.highSpeedSteeringFactor));
  const motionAuthority = Math.min(1, Math.hypot(state.speed, state.lateralSpeed) / 1.5);
  const steeringAuthority =
    (input.handbrake ? handling.handbrakeTurnMultiplier : 1)
    * speedSteering
    * roadGrip
    * (0.45 + profile.turnResponse * 0.55)
    * Math.min(1.35, massResponse)
    * motionAuthority;
  const velocityBeforeTurn = vehicleWorldVelocity(state);
  const direction = state.speed >= 0 ? 1 : -1;
  state.heading += state.steering
    * direction
    * steeringAuthority
    * handling.turnRateRadiansPerSecond
    * dt;

  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  state.speed = velocityBeforeTurn.x * forwardX + velocityBeforeTurn.z * forwardZ;
  state.lateralSpeed = velocityBeforeTurn.x * rightX + velocityBeforeTurn.z * rightZ;
  const lateralGripRate = (3.4 + roadGrip * 5.2)
    * (0.7 + profile.turnResponse * 0.3)
    * (input.handbrake ? 0.18 : 1);
  state.lateralSpeed *= Math.max(0, 1 - lateralGripRate * dt);
  if (Math.abs(state.speed) < 0.4) {
    state.lateralSpeed = moveTowards(state.lateralSpeed, 0, 4.5 * dt);
  }

  const velocity = vehicleWorldVelocity(state);
  const collisionResult = moveVehicleCollisionBox(
    state,
    velocity.x * dt,
    velocity.z * dt,
    collisions,
  );

  if (collisionResult.impactSide !== null) {
    const collisionMassScale = Math.sqrt(profile.massKg / REFERENCE_VEHICLE_MASS_KG);
    const equivalentImpactSpeed = collisionResult.normalSpeedMetersPerSecond
      * collisionMassScale
      * armorDamageMultiplier
      / durabilityMultiplier;
    const damage = applyVehicleDamage(state.integrity, profile, {
      kind: 'collision',
      impactSpeedMetersPerSecond: equivalentImpactSpeed,
      side: collisionResult.impactSide,
    });
    state.integrity = damage.integrity;
    state.health = state.integrity.engineHealth;
    state.lastImpact = {
      side: collisionResult.impactSide,
      normalSpeedMetersPerSecond: collisionResult.normalSpeedMetersPerSecond,
      equivalentImpactSpeedMetersPerSecond: equivalentImpactSpeed,
      blockedX: collisionResult.blockedX,
      blockedZ: collisionResult.blockedZ,
      collisionId: collisionResult.collisionId,
      bodyDamage: damage.bodyDamage,
      engineDamage: damage.engineDamage,
      tireDamage: damage.tireDamage,
    };
    if (collisionResult.impactSide === 'front' || collisionResult.impactSide === 'rear') {
      state.speed *= -0.16;
      state.lateralSpeed *= 0.55;
    } else {
      state.speed *= 0.72;
      state.lateralSpeed *= -0.2;
    }
  }
  updateVehicleSuspension(state, collisions, dt);
}

export function findVehicleExitPoint(
  state: Readonly<VehicleSimulationState>,
  collisions: readonly CollisionRect[],
): Vec3Data | null {
  const radius = requireVehicleDriveProfile(state.vehicleClassId).arcadeHandling.collisionRadiusMeters;
  const rightX = Math.cos(state.heading);
  const rightZ = -Math.sin(state.heading);
  const forwardX = -Math.sin(state.heading);
  const forwardZ = -Math.cos(state.heading);
  const candidates = [
    { x: state.position.x + rightX * (radius + 0.87), z: state.position.z + rightZ * (radius + 0.87) },
    { x: state.position.x - rightX * (radius + 0.87), z: state.position.z - rightZ * (radius + 0.87) },
    { x: state.position.x - forwardX * (radius + 1.17), z: state.position.z - forwardZ * (radius + 1.17) },
    { x: state.position.x + forwardX * (radius + 1.17), z: state.position.z + forwardZ * (radius + 1.17) },
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
  return state.occupied
    && Math.hypot(state.speed, state.lateralSpeed ?? 0) <= MAX_SAFE_EXIT_SPEED;
}
