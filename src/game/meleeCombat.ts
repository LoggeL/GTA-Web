export type MeleeComboStep = 0 | 1 | 2;
export type MeleeAttackKind = 'light' | 'heavy';
export type MeleeDefenseKind = 'light' | 'heavy' | 'projectile';

export interface MeleeCombatState {
  readonly stamina: number;
  readonly maximumStamina: number;
  readonly comboStep: MeleeComboStep;
  readonly comboWindowRemaining: number;
  readonly attackCooldownRemaining: number;
  readonly heavyChargeSeconds: number;
  readonly blocking: boolean;
  readonly dodgeInvulnerabilityRemaining: number;
  readonly dodgeCooldownRemaining: number;
  readonly staggerRemaining: number;
}

export interface MeleeStepInput {
  readonly blocking?: boolean;
  readonly chargingHeavy?: boolean;
  readonly staminaRegenerationMultiplier?: number;
}

export interface MeleeAttackRequest {
  readonly kind: MeleeAttackKind;
  readonly baseDamage: number;
  readonly damageMultiplier?: number;
  readonly chargeSeconds?: number;
}

export interface MeleeAttackResult {
  readonly state: MeleeCombatState;
  readonly performed: boolean;
  readonly reason: 'cooldown' | 'staggered' | 'insufficient-stamina' | null;
  readonly damage: number;
  readonly staminaCost: number;
  readonly comboStep: MeleeComboStep;
  readonly chargedFraction: number;
  readonly staggerSeconds: number;
}

export interface MeleeDodgeResult {
  readonly state: MeleeCombatState;
  readonly performed: boolean;
  readonly reason: 'cooldown' | 'staggered' | 'insufficient-stamina' | null;
}

export interface MeleeDefenseResult {
  readonly state: MeleeCombatState;
  readonly incomingDamage: number;
  readonly damageAfterDefense: number;
  readonly avoided: boolean;
  readonly blockedDamage: number;
  readonly staminaSpent: number;
  readonly guardBroken: boolean;
}

const MAXIMUM_HEAVY_CHARGE_SECONDS = 1.5;
const DODGE_STAMINA_COST = 24;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function normalizeState(state: Readonly<MeleeCombatState>): MeleeCombatState {
  assertFiniteNonNegative(state.maximumStamina, 'maximum melee stamina');
  if (state.maximumStamina <= 0) throw new RangeError('maximum melee stamina must be positive');
  assertFiniteNonNegative(state.stamina, 'melee stamina');
  if (state.stamina > state.maximumStamina) throw new RangeError('melee stamina exceeds its maximum');
  for (const [value, label] of [
    [state.comboWindowRemaining, 'combo window'],
    [state.attackCooldownRemaining, 'attack cooldown'],
    [state.heavyChargeSeconds, 'heavy charge'],
    [state.dodgeInvulnerabilityRemaining, 'dodge invulnerability'],
    [state.dodgeCooldownRemaining, 'dodge cooldown'],
    [state.staggerRemaining, 'stagger time'],
  ] as const) assertFiniteNonNegative(value, label);
  return { ...state };
}

export function createMeleeCombatState(maximumStamina = 100): MeleeCombatState {
  assertFiniteNonNegative(maximumStamina, 'maximum melee stamina');
  if (maximumStamina <= 0) throw new RangeError('maximum melee stamina must be positive');
  return {
    stamina: maximumStamina,
    maximumStamina,
    comboStep: 0,
    comboWindowRemaining: 0,
    attackCooldownRemaining: 0,
    heavyChargeSeconds: 0,
    blocking: false,
    dodgeInvulnerabilityRemaining: 0,
    dodgeCooldownRemaining: 0,
    staggerRemaining: 0,
  };
}

export function stepMeleeCombat(
  inputState: Readonly<MeleeCombatState>,
  deltaSeconds: number,
  input: Readonly<MeleeStepInput> = {},
): MeleeCombatState {
  const state = normalizeState(inputState);
  assertFiniteNonNegative(deltaSeconds, 'melee step delta');
  const regenerationMultiplier = input.staminaRegenerationMultiplier ?? 1;
  assertFiniteNonNegative(regenerationMultiplier, 'melee stamina regeneration multiplier');
  const comboWindowRemaining = Math.max(0, state.comboWindowRemaining - deltaSeconds);
  const blocking = Boolean(input.blocking) && state.staggerRemaining <= 0;
  const charging = Boolean(input.chargingHeavy) && !blocking && state.staggerRemaining <= 0;
  const mayRegenerate = !blocking && !charging && state.attackCooldownRemaining <= 0;
  return {
    ...state,
    stamina: mayRegenerate
      ? Math.min(state.maximumStamina, state.stamina + deltaSeconds * 22 * regenerationMultiplier)
      : state.stamina,
    comboStep: comboWindowRemaining === 0 ? 0 : state.comboStep,
    comboWindowRemaining,
    attackCooldownRemaining: Math.max(0, state.attackCooldownRemaining - deltaSeconds),
    heavyChargeSeconds: charging
      ? Math.min(MAXIMUM_HEAVY_CHARGE_SECONDS, state.heavyChargeSeconds + deltaSeconds)
      : state.heavyChargeSeconds,
    blocking,
    dodgeInvulnerabilityRemaining: Math.max(0, state.dodgeInvulnerabilityRemaining - deltaSeconds),
    dodgeCooldownRemaining: Math.max(0, state.dodgeCooldownRemaining - deltaSeconds),
    staggerRemaining: Math.max(0, state.staggerRemaining - deltaSeconds),
  };
}

export function performMeleeAttack(
  inputState: Readonly<MeleeCombatState>,
  request: Readonly<MeleeAttackRequest>,
): MeleeAttackResult {
  const state = normalizeState(inputState);
  assertFiniteNonNegative(request.baseDamage, 'melee base damage');
  const damageMultiplier = request.damageMultiplier ?? 1;
  assertFiniteNonNegative(damageMultiplier, 'melee damage multiplier');
  const chargeSeconds = clamp(request.chargeSeconds ?? state.heavyChargeSeconds, 0, MAXIMUM_HEAVY_CHARGE_SECONDS);
  const chargedFraction = request.kind === 'heavy' ? chargeSeconds / MAXIMUM_HEAVY_CHARGE_SECONDS : 0;
  const comboStep = state.comboWindowRemaining > 0 ? state.comboStep : 0;
  const lightCosts = [8, 10, 14] as const;
  const lightDamage = [0.92, 1.08, 1.34] as const;
  const staminaCost = request.kind === 'light'
    ? lightCosts[comboStep]
    : 22 + chargedFraction * 10;
  const blocked = (reason: Exclude<MeleeAttackResult['reason'], null>): MeleeAttackResult => ({
    state: { ...state }, performed: false, reason, damage: 0, staminaCost, comboStep, chargedFraction, staggerSeconds: 0,
  });
  if (state.staggerRemaining > 0) return blocked('staggered');
  if (state.attackCooldownRemaining > 0) return blocked('cooldown');
  if (state.stamina < staminaCost) return blocked('insufficient-stamina');

  const nextCombo = request.kind === 'light' ? ((comboStep + 1) % 3) as MeleeComboStep : 0;
  const damageFactor = request.kind === 'light'
    ? lightDamage[comboStep]
    : 1.45 + chargedFraction * 1.05;
  const attackCooldownRemaining = request.kind === 'light'
    ? [0.28, 0.32, 0.46][comboStep] ?? 0.28
    : 0.68 + chargedFraction * 0.32;
  const nextState: MeleeCombatState = {
    ...state,
    stamina: state.stamina - staminaCost,
    comboStep: nextCombo,
    comboWindowRemaining: request.kind === 'light' && nextCombo !== 0 ? 0.78 : 0,
    attackCooldownRemaining,
    heavyChargeSeconds: 0,
    blocking: false,
  };
  return {
    state: nextState,
    performed: true,
    reason: null,
    damage: request.baseDamage * damageFactor * damageMultiplier,
    staminaCost,
    comboStep,
    chargedFraction,
    staggerSeconds: request.kind === 'heavy' ? 0.28 + chargedFraction * 0.48 : comboStep === 2 ? 0.24 : 0.08,
  };
}

export function tryMeleeDodge(inputState: Readonly<MeleeCombatState>): MeleeDodgeResult {
  const state = normalizeState(inputState);
  const blocked = (reason: Exclude<MeleeDodgeResult['reason'], null>): MeleeDodgeResult => ({
    state: { ...state }, performed: false, reason,
  });
  if (state.staggerRemaining > 0) return blocked('staggered');
  if (state.dodgeCooldownRemaining > 0 || state.dodgeInvulnerabilityRemaining > 0) return blocked('cooldown');
  if (state.stamina < DODGE_STAMINA_COST) return blocked('insufficient-stamina');
  return {
    state: {
      ...state,
      stamina: state.stamina - DODGE_STAMINA_COST,
      blocking: false,
      dodgeInvulnerabilityRemaining: 0.3,
      dodgeCooldownRemaining: 0.82,
    },
    performed: true,
    reason: null,
  };
}

export function resolveMeleeDefense(
  inputState: Readonly<MeleeCombatState>,
  incomingDamage: number,
  kind: MeleeDefenseKind,
): MeleeDefenseResult {
  const state = normalizeState(inputState);
  assertFiniteNonNegative(incomingDamage, 'incoming melee damage');
  if (state.dodgeInvulnerabilityRemaining > 0) {
    return {
      state: { ...state }, incomingDamage, damageAfterDefense: 0, avoided: true,
      blockedDamage: incomingDamage, staminaSpent: 0, guardBroken: false,
    };
  }
  if (!state.blocking || state.staggerRemaining > 0) {
    return {
      state: { ...state }, incomingDamage, damageAfterDefense: incomingDamage, avoided: false,
      blockedDamage: 0, staminaSpent: 0, guardBroken: false,
    };
  }

  const efficiency = kind === 'light' ? 0.72 : kind === 'heavy' ? 0.48 : 0.25;
  const idealBlockedDamage = incomingDamage * efficiency;
  const idealStaminaCost = idealBlockedDamage * 0.72;
  const staminaSpent = Math.min(state.stamina, idealStaminaCost);
  const staminaFraction = idealStaminaCost <= 0 ? 1 : staminaSpent / idealStaminaCost;
  const blockedDamage = idealBlockedDamage * staminaFraction;
  const guardBroken = idealStaminaCost > state.stamina;
  return {
    state: {
      ...state,
      stamina: state.stamina - staminaSpent,
      blocking: !guardBroken,
      staggerRemaining: guardBroken ? 0.62 : state.staggerRemaining,
    },
    incomingDamage,
    damageAfterDefense: incomingDamage - blockedDamage,
    avoided: false,
    blockedDamage,
    staminaSpent,
    guardBroken,
  };
}
