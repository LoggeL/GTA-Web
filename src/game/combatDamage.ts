export type ArmorCondition = 'ready' | 'worn' | 'broken' | 'none';
export type CombatDamageKind = 'melee' | 'projectile' | 'environment';

export interface ArmorState {
  readonly points: number;
  readonly maximumPoints: number;
  readonly durability: number;
}

export interface CombatVitalState {
  readonly health: number;
  readonly maximumHealth: number;
  readonly armor: ArmorState | null;
}

export interface CombatDamageEvent {
  readonly amount: number;
  readonly kind: CombatDamageKind;
  readonly armorPenetration?: number;
  readonly coverDamageMultiplier?: number;
  readonly defenseDamageMultiplier?: number;
}

export interface CombatDamageResult {
  readonly state: CombatVitalState;
  readonly rawDamage: number;
  readonly damageAfterCoverAndDefense: number;
  readonly armorAbsorbed: number;
  readonly armorDurabilityLost: number;
  readonly healthDamage: number;
  readonly defeated: boolean;
  readonly effect: 'abstract-impact-flash';
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function normalizeArmor(input: Readonly<ArmorState>): ArmorState {
  assertFiniteNonNegative(input.points, 'armor points');
  assertFiniteNonNegative(input.maximumPoints, 'maximum armor points');
  assertFiniteNonNegative(input.durability, 'armor durability');
  if (input.maximumPoints <= 0) throw new RangeError('maximum armor points must be positive');
  if (input.points > input.maximumPoints || input.durability > 100) {
    throw new RangeError('armor exceeds its point or durability maximum');
  }
  return { ...input };
}

function normalizeVitals(input: Readonly<CombatVitalState>): CombatVitalState {
  assertFiniteNonNegative(input.health, 'combat health');
  assertFiniteNonNegative(input.maximumHealth, 'maximum combat health');
  if (input.maximumHealth <= 0 || input.health > input.maximumHealth) {
    throw new RangeError('combat health is outside its supported range');
  }
  return { ...input, armor: input.armor ? normalizeArmor(input.armor) : null };
}

export function createArmorState(maximumPoints = 100, durability = 100): ArmorState {
  return normalizeArmor({ points: maximumPoints, maximumPoints, durability });
}

export function createCombatVitalState(
  maximumHealth = 100,
  armor: Readonly<ArmorState> | null = null,
): CombatVitalState {
  return normalizeVitals({ health: maximumHealth, maximumHealth, armor: armor ? { ...armor } : null });
}

export function armorCondition(armor: Readonly<ArmorState> | null): ArmorCondition {
  if (!armor) return 'none';
  const normalized = normalizeArmor(armor);
  if (normalized.durability <= 0 || normalized.points <= 0) return 'broken';
  return normalized.durability < 25 ? 'worn' : 'ready';
}

export function resolveCombatDamage(
  inputState: Readonly<CombatVitalState>,
  event: Readonly<CombatDamageEvent>,
): CombatDamageResult {
  const state = normalizeVitals(inputState);
  assertFiniteNonNegative(event.amount, 'combat damage');
  const penetration = event.armorPenetration ?? 0;
  const coverMultiplier = event.coverDamageMultiplier ?? 1;
  const defenseMultiplier = event.defenseDamageMultiplier ?? 1;
  for (const [value, label] of [
    [penetration, 'armor penetration'],
    [coverMultiplier, 'cover damage multiplier'],
    [defenseMultiplier, 'defense damage multiplier'],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${label} must be in [0, 1]`);
    }
  }

  const mitigatedDamage = event.amount * coverMultiplier * defenseMultiplier;
  let armorAbsorbed = 0;
  let armorDurabilityLost = 0;
  let armor = state.armor ? { ...state.armor } : null;
  if (armor && armorCondition(armor) !== 'broken' && mitigatedDamage > 0) {
    const wornRatio = armor.durability < 25 ? armor.durability / 25 : 1;
    const absorptionEfficiency = (0.4 + wornRatio * 0.32) * (1 - penetration);
    armorAbsorbed = Math.min(armor.points, mitigatedDamage * absorptionEfficiency);
    armorDurabilityLost = Math.min(
      armor.durability,
      armorAbsorbed * 0.62 + mitigatedDamage * 0.04,
    );
    armor = {
      ...armor,
      points: Math.max(0, armor.points - armorAbsorbed),
      durability: Math.max(0, armor.durability - armorDurabilityLost),
    };
  }
  const healthDamage = Math.min(state.health, Math.max(0, mitigatedDamage - armorAbsorbed));
  const nextState: CombatVitalState = {
    health: Math.max(0, state.health - healthDamage),
    maximumHealth: state.maximumHealth,
    armor,
  };
  return {
    state: nextState,
    rawDamage: event.amount,
    damageAfterCoverAndDefense: mitigatedDamage,
    armorAbsorbed,
    armorDurabilityLost,
    healthDamage,
    defeated: nextState.health <= 0,
    effect: 'abstract-impact-flash',
  };
}

export function applyArmorRepairPlate(
  input: Readonly<ArmorState>,
  repairEfficiency = 1,
): ArmorState {
  const armor = normalizeArmor(input);
  assertFiniteNonNegative(repairEfficiency, 'armor repair efficiency');
  return {
    ...armor,
    points: Math.min(armor.maximumPoints, armor.points + 24 * repairEfficiency),
    durability: Math.min(100, armor.durability + 35 * repairEfficiency),
  };
}

export function replaceArmor(input: Readonly<CombatVitalState>, armor: Readonly<ArmorState> | null): CombatVitalState {
  const state = normalizeVitals(input);
  return { ...state, armor: armor ? normalizeArmor(armor) : null };
}
