import type { VehicleDefinition } from '../data/types';

export type VehicleTireIndex = 0 | 1 | 2 | 3;
export type VehicleTireTarget =
  | 'front-left-tire'
  | 'front-right-tire'
  | 'rear-left-tire'
  | 'rear-right-tire';
export type VehicleDamageTarget = 'body' | 'engine' | VehicleTireTarget;
export type VehicleImpactSide = 'front' | 'rear' | 'left' | 'right';
export type VehicleIntegrityCondition = 'roadworthy' | 'damaged' | 'critical' | 'disabled';

export interface VehicleIntegrityState {
  readonly bodyHealth: number;
  readonly engineHealth: number;
  /** Front-left, front-right, rear-left, rear-right. */
  readonly tireHealth: readonly [number, number, number, number];
}

export type VehicleDamageEvent =
  | {
    readonly kind: 'collision';
    readonly impactSpeedMetersPerSecond: number;
    readonly side?: VehicleImpactSide;
  }
  | {
    readonly kind: 'direct';
    readonly amount: number;
    readonly target: VehicleDamageTarget;
  };

export interface VehicleDamageResult {
  readonly integrity: VehicleIntegrityState;
  readonly conditionBefore: VehicleIntegrityCondition;
  readonly conditionAfter: VehicleIntegrityCondition;
  readonly bodyDamage: number;
  readonly engineDamage: number;
  readonly tireDamage: readonly [number, number, number, number];
}

export interface VehiclePerformanceModifiers {
  readonly condition: VehicleIntegrityCondition;
  readonly engineOutput: number;
  readonly topSpeed: number;
  readonly grip: number;
  readonly braking: number;
  readonly steering: number;
}

export interface VehicleRepairQuote {
  readonly body: number;
  readonly engine: number;
  readonly tires: readonly [number, number, number, number];
  readonly total: number;
}

const HEALTH_MAXIMUM = 100;
const COLLISION_DAMAGE_SPEED_THRESHOLD = 2.5;
const ENGINE_DAMAGE_SPEED_THRESHOLD = 7;
const REFERENCE_DURABILITY = 86;
const FIELD_BODY_REPAIR = 30;
const FIELD_ENGINE_REPAIR = 22;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function normalizeHealth(value: number, label: string): number {
  assertFiniteNonNegative(value, label);
  return Math.min(HEALTH_MAXIMUM, value);
}

function normalizeIntegrity(state: Readonly<VehicleIntegrityState>): VehicleIntegrityState {
  if (state.tireHealth.length !== 4) {
    throw new RangeError('vehicle integrity must contain four tire health values');
  }
  return {
    bodyHealth: normalizeHealth(state.bodyHealth, 'body health'),
    engineHealth: normalizeHealth(state.engineHealth, 'engine health'),
    tireHealth: [
      normalizeHealth(state.tireHealth[0], 'front-left tire health'),
      normalizeHealth(state.tireHealth[1], 'front-right tire health'),
      normalizeHealth(state.tireHealth[2], 'rear-left tire health'),
      normalizeHealth(state.tireHealth[3], 'rear-right tire health'),
    ],
  };
}

function tireIndexFor(target: VehicleTireTarget): VehicleTireIndex {
  switch (target) {
    case 'front-left-tire': return 0;
    case 'front-right-tire': return 1;
    case 'rear-left-tire': return 2;
    case 'rear-right-tire': return 3;
  }
}

function durabilityDamageMultiplier(profile: Pick<VehicleDefinition, 'durability'>): number {
  return clamp(REFERENCE_DURABILITY / profile.durability, 0.58, 1.65);
}

export function createVehicleIntegrityState(): VehicleIntegrityState {
  return {
    bodyHealth: HEALTH_MAXIMUM,
    engineHealth: HEALTH_MAXIMUM,
    tireHealth: [HEALTH_MAXIMUM, HEALTH_MAXIMUM, HEALTH_MAXIMUM, HEALTH_MAXIMUM],
  };
}

export function restoreVehicleIntegrityToPercent(percent: number): VehicleIntegrityState {
  if (!Number.isFinite(percent) || percent < 0 || percent > HEALTH_MAXIMUM) {
    throw new RangeError('vehicle restore percentage must be between 0 and 100');
  }
  return {
    bodyHealth: percent,
    engineHealth: percent,
    tireHealth: [percent, percent, percent, percent],
  };
}

export function vehicleIntegrityCondition(
  input: Readonly<VehicleIntegrityState>,
): VehicleIntegrityCondition {
  const state = normalizeIntegrity(input);
  if (state.engineHealth <= 0) {
    return 'disabled';
  }
  const flatTires = state.tireHealth.filter((health) => health <= 0).length;
  if (state.engineHealth <= 25 || state.bodyHealth <= 15 || flatTires >= 2) {
    return 'critical';
  }
  if (
    state.engineHealth < 80
    || state.bodyHealth < 75
    || state.tireHealth.some((health) => health < 60)
  ) {
    return 'damaged';
  }
  return 'roadworthy';
}

export function vehiclePerformanceModifiers(
  input: Readonly<VehicleIntegrityState>,
): VehiclePerformanceModifiers {
  const state = normalizeIntegrity(input);
  const condition = vehicleIntegrityCondition(state);
  const engineRatio = state.engineHealth / HEALTH_MAXIMUM;
  const averageTireRatio = state.tireHealth.reduce((sum, health) => sum + health, 0)
    / (state.tireHealth.length * HEALTH_MAXIMUM);
  const flatTires = state.tireHealth.filter((health) => health <= 0).length;
  const bodyRatio = state.bodyHealth / HEALTH_MAXIMUM;
  const bodyStability = 0.8 + bodyRatio * 0.2;

  return {
    condition,
    engineOutput: engineRatio <= 0 ? 0 : 0.45 + Math.sqrt(engineRatio) * 0.55,
    topSpeed: engineRatio <= 0 ? 0 : 0.35 + Math.sqrt(engineRatio) * 0.65,
    grip: clamp((0.42 + averageTireRatio * 0.58 - flatTires * 0.09) * bodyStability, 0.2, 1),
    braking: clamp(0.35 + averageTireRatio * 0.65 - flatTires * 0.05, 0.2, 1),
    steering: clamp(0.4 + averageTireRatio * 0.6 - flatTires * 0.07, 0.2, 1),
  };
}

export function applyVehicleDamage(
  input: Readonly<VehicleIntegrityState>,
  profile: Pick<VehicleDefinition, 'durability'>,
  event: Readonly<VehicleDamageEvent>,
): VehicleDamageResult {
  const before = normalizeIntegrity(input);
  const conditionBefore = vehicleIntegrityCondition(before);
  const damageMultiplier = durabilityDamageMultiplier(profile);
  let requestedBodyDamage = 0;
  let requestedEngineDamage = 0;
  const requestedTireDamage: [number, number, number, number] = [0, 0, 0, 0];

  if (event.kind === 'collision') {
    assertFiniteNonNegative(event.impactSpeedMetersPerSecond, 'collision impact speed');
    const side = event.side ?? 'front';
    const damagingSpeed = Math.max(0, event.impactSpeedMetersPerSecond - COLLISION_DAMAGE_SPEED_THRESHOLD);
    requestedBodyDamage = damagingSpeed * 1.25 * damageMultiplier;
    const engineSpeed = Math.max(0, event.impactSpeedMetersPerSecond - ENGINE_DAMAGE_SPEED_THRESHOLD);
    const engineFactor = side === 'front' ? 0.72 : side === 'rear' ? 0.3 : 0.16;
    requestedEngineDamage = engineSpeed * engineFactor * damageMultiplier;

    if (side === 'left' || side === 'right') {
      const tireDamage = Math.max(0, event.impactSpeedMetersPerSecond - 5) * 0.5 * damageMultiplier;
      const tireIndices: readonly VehicleTireIndex[] = side === 'left' ? [0, 2] : [1, 3];
      for (const tireIndex of tireIndices) {
        requestedTireDamage[tireIndex] = tireDamage;
      }
    }
  } else {
    assertFiniteNonNegative(event.amount, 'direct vehicle damage');
    const damage = event.amount * damageMultiplier;
    if (event.target === 'body') {
      requestedBodyDamage = damage;
    } else if (event.target === 'engine') {
      requestedBodyDamage = damage * 0.18;
      requestedEngineDamage = damage;
    } else {
      requestedBodyDamage = damage * 0.06;
      requestedTireDamage[tireIndexFor(event.target)] = damage;
    }
  }

  const tireHealth: [number, number, number, number] = [...before.tireHealth];
  tireHealth.forEach((health, index) => {
    tireHealth[index as VehicleTireIndex] = Math.max(0, health - requestedTireDamage[index as VehicleTireIndex]);
  });
  const integrity: VehicleIntegrityState = {
    bodyHealth: Math.max(0, before.bodyHealth - requestedBodyDamage),
    engineHealth: Math.max(0, before.engineHealth - requestedEngineDamage),
    tireHealth,
  };
  const tireDamage: [number, number, number, number] = [
    before.tireHealth[0] - integrity.tireHealth[0],
    before.tireHealth[1] - integrity.tireHealth[1],
    before.tireHealth[2] - integrity.tireHealth[2],
    before.tireHealth[3] - integrity.tireHealth[3],
  ];

  return {
    integrity,
    conditionBefore,
    conditionAfter: vehicleIntegrityCondition(integrity),
    bodyDamage: before.bodyHealth - integrity.bodyHealth,
    engineDamage: before.engineHealth - integrity.engineHealth,
    tireDamage,
  };
}

export function applyVehicleRepairKit(
  input: Readonly<VehicleIntegrityState>,
  repairEfficiency = 1,
): VehicleIntegrityState {
  const state = normalizeIntegrity(input);
  assertFiniteNonNegative(repairEfficiency, 'vehicle repair efficiency');
  return {
    bodyHealth: Math.min(HEALTH_MAXIMUM, state.bodyHealth + FIELD_BODY_REPAIR * repairEfficiency),
    engineHealth: Math.min(HEALTH_MAXIMUM, state.engineHealth + FIELD_ENGINE_REPAIR * repairEfficiency),
    tireHealth: [...state.tireHealth],
  };
}

export function calculateVehicleRepairQuote(
  input: Readonly<VehicleIntegrityState>,
  profile: Pick<VehicleDefinition, 'baseValue'>,
): VehicleRepairQuote {
  const state = normalizeIntegrity(input);
  const serviceValue = profile.baseValue > 0 ? profile.baseValue : 26_000;
  const classMultiplier = clamp(Math.sqrt(serviceValue / 11_200), 0.75, 2.25);
  const body = Math.ceil((HEALTH_MAXIMUM - state.bodyHealth) * 1.7 * classMultiplier);
  const engine = Math.ceil((HEALTH_MAXIMUM - state.engineHealth) * 2.75 * classMultiplier);
  const tires: [number, number, number, number] = state.tireHealth.map(
    (health) => Math.ceil((HEALTH_MAXIMUM - health) * 0.9 * classMultiplier),
  ) as [number, number, number, number];

  return {
    body,
    engine,
    tires,
    total: body + engine + tires.reduce((sum, cost) => sum + cost, 0),
  };
}
