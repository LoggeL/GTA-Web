import { WEAPONS } from '../data/items';
import type { WeaponClassId, WeaponDefinition } from '../data/types';

export type WeaponCondition = 'ready' | 'worn' | 'broken';
export type WeaponActionBlockReason =
  | 'cooldown'
  | 'reloading'
  | 'empty'
  | 'broken'
  | 'malfunction'
  | 'not-a-firearm'
  | 'magazine-full'
  | 'no-reserve-ammo';

export interface CombatWeaponState {
  readonly weaponId: string;
  readonly roundsInMagazine: number;
  readonly reserveAmmo: number;
  readonly durability: number;
  readonly cooldownRemaining: number;
  readonly reloadRemaining: number;
  readonly recoilBloom: number;
  readonly shotsFired: number;
}

export interface CombatWeaponStateOptions {
  readonly roundsInMagazine?: number;
  readonly reserveAmmo?: number;
  readonly durability?: number;
}

export interface WeaponHandlingSnapshot {
  readonly condition: WeaponCondition;
  readonly damage: number;
  readonly spreadRadians: number;
  readonly recoilRadians: number;
  readonly reliability: number;
  readonly rangeMeters: number;
  readonly pelletCount: number;
  readonly damagePerPellet: number;
  readonly noiseRadiusMeters: number;
  readonly reloadSeconds: number;
  readonly durabilityLossPerShot: number;
}

export interface FireCombatWeaponRequest {
  /** A caller-supplied seeded roll in [0, 1); no hidden randomness is used. */
  readonly reliabilityRoll: number;
  /** Multiplicative spread modifier from aim attributes, skills, or movement. */
  readonly spreadMultiplier?: number;
}

export interface FireCombatWeaponResult {
  readonly state: CombatWeaponState;
  readonly fired: boolean;
  readonly consumedRound: boolean;
  readonly reason: WeaponActionBlockReason | null;
  readonly handling: WeaponHandlingSnapshot;
}

export interface ReloadCombatWeaponResult {
  readonly state: CombatWeaponState;
  readonly started: boolean;
  readonly reason: WeaponActionBlockReason | null;
  readonly reloadSeconds: number;
}

export const COMBAT_WEAPON_DEFINITIONS: readonly WeaponDefinition[] = WEAPONS;

const BASE_SPREAD_RADIANS: Readonly<Record<WeaponClassId, number>> = Object.freeze({
  melee: 0,
  pistol: 0.018,
  smg: 0.042,
  shotgun: 0.14,
  rifle: 0.012,
});

const BASE_RELOAD_SECONDS: Readonly<Record<WeaponClassId, number>> = Object.freeze({
  melee: 0,
  pistol: 1.35,
  smg: 1.7,
  shotgun: 2.25,
  rifle: 1.95,
});

const BASE_WEAR_PER_SHOT: Readonly<Record<WeaponClassId, number>> = Object.freeze({
  melee: 0.24,
  pistol: 0.19,
  smg: 0.1,
  shotgun: 0.32,
  rifle: 0.16,
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertWeaponMatches(
  definition: Readonly<WeaponDefinition>,
  state: Readonly<CombatWeaponState>,
): void {
  if (definition.id !== state.weaponId) {
    throw new Error(`weapon state ${state.weaponId} cannot use definition ${definition.id}`);
  }
}

function assertState(definition: Readonly<WeaponDefinition>, state: Readonly<CombatWeaponState>): void {
  assertWeaponMatches(definition, state);
  assertFiniteNonNegative(state.roundsInMagazine, 'rounds in magazine');
  assertFiniteNonNegative(state.reserveAmmo, 'reserve ammo');
  assertFiniteNonNegative(state.durability, 'weapon durability');
  assertFiniteNonNegative(state.cooldownRemaining, 'weapon cooldown');
  assertFiniteNonNegative(state.reloadRemaining, 'weapon reload time');
  assertFiniteNonNegative(state.recoilBloom, 'weapon recoil bloom');
  assertFiniteNonNegative(state.shotsFired, 'weapon shot count');
  if (
    !Number.isSafeInteger(state.roundsInMagazine)
    || !Number.isSafeInteger(state.reserveAmmo)
    || !Number.isSafeInteger(state.shotsFired)
  ) {
    throw new RangeError('weapon ammunition and shot count must use safe integers');
  }
  if (state.roundsInMagazine > definition.capacity || state.durability > 100) {
    throw new RangeError('weapon state exceeds its magazine or durability limit');
  }
  if (definition.classId === 'melee' && (state.roundsInMagazine !== 0 || state.reserveAmmo !== 0)) {
    throw new RangeError('melee weapons cannot contain ammunition');
  }
}

export function getCombatWeaponDefinition(id: string): WeaponDefinition | undefined {
  return COMBAT_WEAPON_DEFINITIONS.find((definition) => definition.id === id);
}

export function requireCombatWeaponDefinition(id: string): WeaponDefinition {
  const definition = getCombatWeaponDefinition(id);
  if (!definition) {
    throw new Error(`Unknown combat weapon definition: ${id}`);
  }
  return definition;
}

export function createCombatWeaponState(
  definition: Readonly<WeaponDefinition>,
  options: Readonly<CombatWeaponStateOptions> = {},
): CombatWeaponState {
  const firearm = definition.classId !== 'melee';
  const state: CombatWeaponState = {
    weaponId: definition.id,
    roundsInMagazine: firearm ? (options.roundsInMagazine ?? definition.capacity) : 0,
    reserveAmmo: firearm ? (options.reserveAmmo ?? 0) : 0,
    durability: options.durability ?? 100,
    cooldownRemaining: 0,
    reloadRemaining: 0,
    recoilBloom: 0,
    shotsFired: 0,
  };
  assertState(definition, state);
  return state;
}

export function weaponCondition(durability: number): WeaponCondition {
  assertFiniteNonNegative(durability, 'weapon durability');
  if (durability > 100) {
    throw new RangeError('weapon durability cannot exceed 100');
  }
  if (durability <= 0) return 'broken';
  return durability < 25 ? 'worn' : 'ready';
}

export function deriveWeaponHandling(
  definition: Readonly<WeaponDefinition>,
  state: Readonly<CombatWeaponState>,
  spreadMultiplier = 1,
): WeaponHandlingSnapshot {
  assertState(definition, state);
  if (!Number.isFinite(spreadMultiplier) || spreadMultiplier <= 0) {
    throw new RangeError('weapon spread multiplier must be finite and positive');
  }
  const condition = weaponCondition(state.durability);
  const wornRatio = condition === 'worn' ? (25 - state.durability) / 25 : 0;
  const durabilityQuality = clamp(definition.durability / 100, 0.25, 1);
  const pelletCount = definition.classId === 'shotgun' ? 8 : 1;
  const recoilRadians = definition.recoil * 0.045;
  const spreadRadians = (
    BASE_SPREAD_RADIANS[definition.classId]
    + recoilRadians * 0.35
    + state.recoilBloom * 0.018
  ) * (1 + wornRatio * 0.75) * spreadMultiplier;

  return {
    condition,
    damage: definition.damage,
    spreadRadians,
    recoilRadians: recoilRadians * (1 + wornRatio * 0.55),
    reliability: condition === 'broken' ? 0 : 1 - wornRatio * 0.28,
    rangeMeters: definition.rangeMeters,
    pelletCount,
    damagePerPellet: definition.damage / pelletCount,
    noiseRadiusMeters: definition.suppressed ? 5 : definition.classId === 'shotgun' ? 58 : 42,
    reloadSeconds: BASE_RELOAD_SECONDS[definition.classId],
    durabilityLossPerShot: BASE_WEAR_PER_SHOT[definition.classId]
      * (1 + (1 - durabilityQuality) * 0.8),
  };
}

export function tryFireCombatWeapon(
  definition: Readonly<WeaponDefinition>,
  inputState: Readonly<CombatWeaponState>,
  request: Readonly<FireCombatWeaponRequest>,
): FireCombatWeaponResult {
  assertState(definition, inputState);
  if (!Number.isFinite(request.reliabilityRoll) || request.reliabilityRoll < 0 || request.reliabilityRoll >= 1) {
    throw new RangeError('weapon reliability roll must be in [0, 1)');
  }
  const handling = deriveWeaponHandling(definition, inputState, request.spreadMultiplier ?? 1);
  const blocked = (reason: WeaponActionBlockReason): FireCombatWeaponResult => ({
    state: { ...inputState },
    fired: false,
    consumedRound: false,
    reason,
    handling,
  });

  if (definition.classId === 'melee') return blocked('not-a-firearm');
  if (handling.condition === 'broken') return blocked('broken');
  if (inputState.reloadRemaining > 0) return blocked('reloading');
  if (inputState.cooldownRemaining > 0) return blocked('cooldown');
  if (inputState.roundsInMagazine <= 0) return blocked('empty');
  if (request.reliabilityRoll >= handling.reliability) {
    return {
      state: { ...inputState, cooldownRemaining: 0.24, recoilBloom: Math.max(0, inputState.recoilBloom - 0.08) },
      fired: false,
      consumedRound: false,
      reason: 'malfunction',
      handling,
    };
  }

  const state: CombatWeaponState = {
    ...inputState,
    roundsInMagazine: inputState.roundsInMagazine - 1,
    durability: Math.max(0, inputState.durability - handling.durabilityLossPerShot),
    cooldownRemaining: 1 / definition.fireRatePerSecond,
    recoilBloom: Math.min(1.5, inputState.recoilBloom + definition.recoil * 0.32),
    shotsFired: inputState.shotsFired + 1,
  };
  return { state, fired: true, consumedRound: true, reason: null, handling };
}

export function beginCombatWeaponReload(
  definition: Readonly<WeaponDefinition>,
  inputState: Readonly<CombatWeaponState>,
  reloadSpeedMultiplier = 1,
): ReloadCombatWeaponResult {
  assertState(definition, inputState);
  if (!Number.isFinite(reloadSpeedMultiplier) || reloadSpeedMultiplier <= 0) {
    throw new RangeError('reload speed multiplier must be finite and positive');
  }
  const reloadSeconds = BASE_RELOAD_SECONDS[definition.classId] / reloadSpeedMultiplier;
  const blocked = (reason: WeaponActionBlockReason): ReloadCombatWeaponResult => ({
    state: { ...inputState }, started: false, reason, reloadSeconds,
  });
  if (definition.classId === 'melee') return blocked('not-a-firearm');
  if (weaponCondition(inputState.durability) === 'broken') return blocked('broken');
  if (inputState.reloadRemaining > 0) return blocked('reloading');
  if (inputState.roundsInMagazine >= definition.capacity) return blocked('magazine-full');
  if (inputState.reserveAmmo <= 0) return blocked('no-reserve-ammo');
  return {
    state: { ...inputState, reloadRemaining: reloadSeconds },
    started: true,
    reason: null,
    reloadSeconds,
  };
}

export function stepCombatWeapon(
  definition: Readonly<WeaponDefinition>,
  inputState: Readonly<CombatWeaponState>,
  deltaSeconds: number,
): CombatWeaponState {
  assertState(definition, inputState);
  assertFiniteNonNegative(deltaSeconds, 'weapon step delta');
  const reloadRemaining = Math.max(0, inputState.reloadRemaining - deltaSeconds);
  let roundsInMagazine = inputState.roundsInMagazine;
  let reserveAmmo = inputState.reserveAmmo;
  if (inputState.reloadRemaining > 0 && reloadRemaining === 0) {
    const transferred = Math.min(definition.capacity - roundsInMagazine, reserveAmmo);
    roundsInMagazine += transferred;
    reserveAmmo -= transferred;
  }
  return {
    ...inputState,
    roundsInMagazine,
    reserveAmmo,
    cooldownRemaining: Math.max(0, inputState.cooldownRemaining - deltaSeconds),
    reloadRemaining,
    recoilBloom: Math.max(0, inputState.recoilBloom - deltaSeconds * 1.8),
  };
}

export function addCombatWeaponReserveAmmo(
  definition: Readonly<WeaponDefinition>,
  inputState: Readonly<CombatWeaponState>,
  quantity: number,
): CombatWeaponState {
  assertState(definition, inputState);
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError('reserve ammunition quantity must be a non-negative safe integer');
  }
  if (definition.classId === 'melee' && quantity > 0) {
    throw new RangeError('melee weapons cannot receive reserve ammunition');
  }
  return { ...inputState, reserveAmmo: inputState.reserveAmmo + quantity };
}

export function repairCombatWeapon(
  definition: Readonly<WeaponDefinition>,
  inputState: Readonly<CombatWeaponState>,
  durabilityRestored: number,
): CombatWeaponState {
  assertState(definition, inputState);
  assertFiniteNonNegative(durabilityRestored, 'weapon repair amount');
  return { ...inputState, durability: Math.min(100, inputState.durability + durabilityRestored) };
}
