import { clamp } from './math';
import type { CombatRole } from './types';

export type CivilianTemperament = 'calm' | 'cautious' | 'nervous';
export type CivilianReaction = 'ignore' | 'startle' | 'freeze' | 'flee' | 'report';
export type CombatNpcTactic =
  | 'rush'
  | 'hold-range'
  | 'flank'
  | 'suppress'
  | 'seek-distance'
  | 'retreat'
  | 'surrender';

export interface CivilianReactionInput {
  readonly temperament: CivilianTemperament;
  readonly severity: number;
  readonly distance: number;
  readonly sawEvent: boolean;
  readonly directThreat: boolean;
}

export interface CombatRoleAiProfile {
  readonly role: CombatRole;
  readonly maxHealth: number;
  readonly moveSpeed: number;
  readonly preferredDistance: number;
  readonly minimumDistance: number;
  readonly attackRange: number;
  readonly attackDamage: number;
  readonly attackCooldownSeconds: number;
  readonly visionRange: number;
  readonly hearingRange: number;
  readonly retreatHealthRatio: number;
  readonly surrenderHealthRatio: number;
  readonly baseTactic: Exclude<CombatNpcTactic, 'retreat' | 'surrender'>;
}

export interface CombatReactionInput {
  readonly role: CombatRole;
  readonly healthRatio: number;
  readonly playerDistance: number;
  readonly playerVisible: boolean;
  readonly hasLineOfFire: boolean;
}

export const COMBAT_ROLE_AI_PROFILES: Readonly<Record<CombatRole, CombatRoleAiProfile>> = Object.freeze({
  brawler: Object.freeze({
    role: 'brawler',
    maxHealth: 95,
    moveSpeed: 4.4,
    preferredDistance: 1.45,
    minimumDistance: 0,
    attackRange: 2.35,
    attackDamage: 14,
    attackCooldownSeconds: 0.9,
    visionRange: 27,
    hearingRange: 31,
    retreatHealthRatio: 0,
    surrenderHealthRatio: 0.07,
    baseTactic: 'rush',
  }),
  gunner: Object.freeze({
    role: 'gunner',
    maxHealth: 78,
    moveSpeed: 3.3,
    preferredDistance: 14,
    minimumDistance: 7,
    attackRange: 31,
    attackDamage: 8,
    attackCooldownSeconds: 0.44,
    visionRange: 38,
    hearingRange: 34,
    retreatHealthRatio: 0.15,
    surrenderHealthRatio: 0.08,
    baseTactic: 'hold-range',
  }),
  flanker: Object.freeze({
    role: 'flanker',
    maxHealth: 72,
    moveSpeed: 4.25,
    preferredDistance: 11,
    minimumDistance: 5,
    attackRange: 26,
    attackDamage: 7,
    attackCooldownSeconds: 0.38,
    visionRange: 40,
    hearingRange: 36,
    retreatHealthRatio: 0.2,
    surrenderHealthRatio: 0.09,
    baseTactic: 'flank',
  }),
  heavy: Object.freeze({
    role: 'heavy',
    maxHealth: 155,
    moveSpeed: 2.3,
    preferredDistance: 8.5,
    minimumDistance: 3,
    attackRange: 25,
    attackDamage: 13,
    attackCooldownSeconds: 0.72,
    visionRange: 34,
    hearingRange: 37,
    retreatHealthRatio: 0,
    surrenderHealthRatio: 0,
    baseTactic: 'suppress',
  }),
  marksman: Object.freeze({
    role: 'marksman',
    maxHealth: 64,
    moveSpeed: 2.85,
    preferredDistance: 30,
    minimumDistance: 18,
    attackRange: 60,
    attackDamage: 18,
    attackCooldownSeconds: 1.25,
    visionRange: 60,
    hearingRange: 30,
    retreatHealthRatio: 0.26,
    surrenderHealthRatio: 0.1,
    baseTactic: 'seek-distance',
  }),
});

export function chooseCivilianReaction(
  input: Readonly<CivilianReactionInput>,
): CivilianReaction {
  const severity = clamp(input.severity, 0, 5);
  if (input.directThreat || (severity >= 2 && input.distance <= 8)) return 'flee';
  if (!input.sawEvent) {
    if (severity >= 4 && input.distance <= 24) return 'startle';
    return 'ignore';
  }
  const temperamentBias = input.temperament === 'nervous'
    ? 0.75
    : input.temperament === 'cautious'
      ? 0.25
      : -0.25;
  const danger = severity + temperamentBias - input.distance / 24;
  if (danger >= 3.1) return 'flee';
  if (danger >= 1.55) return 'report';
  if (danger >= 0.75) return 'freeze';
  return 'startle';
}

export function chooseCombatNpcTactic(
  input: Readonly<CombatReactionInput>,
): CombatNpcTactic {
  const profile = COMBAT_ROLE_AI_PROFILES[input.role];
  const healthRatio = clamp(input.healthRatio, 0, 1);
  if (
    profile.surrenderHealthRatio > 0
    && healthRatio <= profile.surrenderHealthRatio
    && input.playerVisible
    && input.playerDistance <= Math.max(12, profile.preferredDistance)
  ) {
    return 'surrender';
  }
  if (profile.retreatHealthRatio > 0 && healthRatio <= profile.retreatHealthRatio) {
    return 'retreat';
  }
  if (!input.hasLineOfFire && input.role !== 'brawler') return 'flank';
  if (input.role === 'marksman' && input.playerDistance < profile.minimumDistance) {
    return 'seek-distance';
  }
  if (input.role === 'gunner' && input.playerDistance < profile.minimumDistance) {
    return 'hold-range';
  }
  return profile.baseTactic;
}
