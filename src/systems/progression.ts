import type { EndingChoice } from '../core/state';
import { ATTRIBUTES, SKILL_NODES } from '../data/progression';
import type {
  AttributeDefinition,
  AttributeId,
  SkillNodeDefinition,
  SkillTreeId,
} from '../data/types';

export const LEVEL_CAP = 20;
export const ATTRIBUTE_MINIMUM = 1;
export const ATTRIBUTE_MAXIMUM = 6;
export const BASE_MAXIMUM_HEALTH = 100;
export const BASE_BACKPACK_WEIGHT_KG = 20;
export const INITIAL_BACKPACK_WEIGHT_KG = BASE_BACKPACK_WEIGHT_KG + 2 * ATTRIBUTE_MINIMUM;

export type XpRewardSource = 'mission' | 'activity' | 'discovery' | 'collection-set';
export type SkillRefundMode = 'reject-dependent' | 'cascade';

export interface ProgressionState {
  level: number;
  xp: number;
  attributePoints: number;
  skillPoints: number;
  attributes: Record<AttributeId, number>;
  unlockedSkills: string[];
}

export interface XpGrantResult {
  state: ProgressionState;
  levelsGained: number;
  skillPointsGained: number;
  attributePointsGained: number;
}

export interface XpRewardRequest {
  readonly source: XpRewardSource;
  readonly baseXp: number;
  readonly firstCompletion: boolean;
  readonly difficultyMultiplier?: number;
  readonly rewardMultiplier?: number;
}

export interface XpRewardQuote {
  readonly source: XpRewardSource;
  readonly awardedXp: number;
  readonly eligible: boolean;
  readonly firstCompletion: boolean;
  readonly repeatMultiplier: number;
}

export interface XpRewardGrantResult extends XpGrantResult {
  readonly reward: XpRewardQuote;
}

export interface LevelProgressSnapshot {
  readonly level: number;
  readonly capped: boolean;
  readonly currentLevelThreshold: number;
  readonly nextLevelThreshold: number | null;
  readonly xpEarnedInLevel: number;
  readonly xpRequiredInLevel: number;
  readonly xpRemaining: number;
  readonly fraction: number;
}

export interface ProgressionModifiers {
  readonly maximumHealth: number;
  readonly backpackWeightKg: number;
  readonly meleeDamageMultiplier: number;
  readonly weaponSpreadMultiplier: number;
  readonly reloadTimeMultiplier: number;
  readonly vehicleStabilityMultiplier: number;
  readonly vehicleBrakingMultiplier: number;
  readonly vehicleDurabilityMultiplier: number;
  readonly heatGainMultiplier: number;
  readonly enemySuspicionTimeMultiplier: number;
  readonly cashRewardMultiplier: number;
  readonly contactReputationRewardMultiplier: number;
  readonly unlockedEffects: readonly string[];
}

export type ProgressionValidationResult =
  | { readonly valid: true; readonly state: ProgressionState; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly string[] };

export type ProgressionRestoreResult =
  | { readonly success: true; readonly state: ProgressionState; readonly errors: readonly [] }
  | { readonly success: false; readonly state: ProgressionState; readonly errors: readonly string[] };

export type SkillRefundResult =
  | {
    readonly success: true;
    readonly state: ProgressionState;
    readonly refundedSkillIds: readonly string[];
    readonly pointsRefunded: number;
  }
  | {
    readonly success: false;
    readonly state: ProgressionState;
    readonly refundedSkillIds: readonly [];
    readonly pointsRefunded: 0;
    readonly reason: string;
  };

export type ProgressionTransactionResult =
  | { success: true; state: ProgressionState }
  | { success: false; state: ProgressionState; reason: string };

export function createInitialProgressionState(): ProgressionState {
  return {
    level: 1,
    xp: 0,
    attributePoints: 0,
    skillPoints: 0,
    attributes: {
      grit: 1,
      aim: 1,
      handling: 1,
      nerve: 1,
      hustle: 1,
    },
    unlockedSkills: [],
  };
}

/** XP required to advance from the supplied level to the next. */
export function xpRequiredForNextLevel(level: number): number {
  assertIntegerInRange(level, 1, LEVEL_CAP, 'level');
  return level === LEVEL_CAP ? 0 : 500 + (level - 1) * 250;
}

/** Total lifetime XP at which a level begins. */
export function xpThresholdForLevel(level: number): number {
  assertIntegerInRange(level, 1, LEVEL_CAP, 'level');
  let threshold = 0;
  for (let current = 1; current < level; current += 1) {
    threshold += xpRequiredForNextLevel(current);
  }
  return threshold;
}

export function levelForXp(xp: number): number {
  assertNonNegativeFinite(xp, 'xp');
  for (let level = LEVEL_CAP; level >= 1; level -= 1) {
    if (xp >= xpThresholdForLevel(level)) {
      return level;
    }
  }
  return 1;
}

export const MAX_LEVEL_XP_THRESHOLD = xpThresholdForLevel(LEVEL_CAP);

export function levelProgress(state: Pick<ProgressionState, 'level' | 'xp'>): LevelProgressSnapshot {
  assertIntegerInRange(state.level, 1, LEVEL_CAP, 'level');
  if (!Number.isSafeInteger(state.xp) || state.xp < 0) {
    throw new RangeError('xp must be a non-negative safe integer');
  }
  const currentLevelThreshold = xpThresholdForLevel(state.level);
  if (state.level === LEVEL_CAP) {
    return {
      level: state.level,
      capped: true,
      currentLevelThreshold,
      nextLevelThreshold: null,
      xpEarnedInLevel: Math.max(0, state.xp - currentLevelThreshold),
      xpRequiredInLevel: 0,
      xpRemaining: 0,
      fraction: 1,
    };
  }
  const nextLevelThreshold = xpThresholdForLevel(state.level + 1);
  const xpRequiredInLevel = nextLevelThreshold - currentLevelThreshold;
  const xpEarnedInLevel = Math.max(0, Math.min(xpRequiredInLevel, state.xp - currentLevelThreshold));
  return {
    level: state.level,
    capped: false,
    currentLevelThreshold,
    nextLevelThreshold,
    xpEarnedInLevel,
    xpRequiredInLevel,
    xpRemaining: xpRequiredInLevel - xpEarnedInLevel,
    fraction: xpRequiredInLevel === 0 ? 1 : xpEarnedInLevel / xpRequiredInLevel,
  };
}

export function quoteXpReward(request: Readonly<XpRewardRequest>): XpRewardQuote {
  assertNonNegativeFinite(request.baseXp, 'base xp reward');
  const difficultyMultiplier = request.difficultyMultiplier ?? 1;
  const rewardMultiplier = request.rewardMultiplier ?? 1;
  assertNonNegativeFinite(difficultyMultiplier, 'xp difficulty multiplier');
  assertNonNegativeFinite(rewardMultiplier, 'xp reward multiplier');
  if (typeof request.firstCompletion !== 'boolean') {
    throw new TypeError('firstCompletion must be a boolean');
  }

  const repeatMultiplier = request.firstCompletion
    ? 1
    : request.source === 'activity'
      ? 0.25
      : 0;
  const eligible = repeatMultiplier > 0 && request.baseXp > 0;
  const awardedXp = eligible
    ? Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.floor(request.baseXp * difficultyMultiplier * rewardMultiplier * repeatMultiplier),
    )
    : 0;
  return {
    source: request.source,
    awardedXp,
    eligible: awardedXp > 0,
    firstCompletion: request.firstCompletion,
    repeatMultiplier,
  };
}

export function grantXpReward(
  state: Readonly<ProgressionState>,
  request: Readonly<XpRewardRequest>,
): XpRewardGrantResult {
  const reward = quoteXpReward(request);
  return { ...grantXp(state, reward.awardedXp), reward };
}

export function grantXp(state: Readonly<ProgressionState>, amount: number): XpGrantResult {
  assertNonNegativeFinite(amount, 'amount');
  const previousLevel = state.level;
  const xp = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(state.xp + amount),
  );
  const level = Math.max(previousLevel, levelForXp(xp));
  const levelsGained = level - previousLevel;
  const skillPointsGained = levelsGained;
  const attributePointsGained = Math.floor(level / 2) - Math.floor(previousLevel / 2);

  return {
    state: {
      ...cloneProgression(state),
      xp,
      level,
      skillPoints: state.skillPoints + skillPointsGained,
      attributePoints: state.attributePoints + attributePointsGained,
    },
    levelsGained,
    skillPointsGained,
    attributePointsGained,
  };
}

export function purchaseAttribute(
  state: Readonly<ProgressionState>,
  attribute: AttributeId,
): ProgressionTransactionResult {
  const current = state.attributes[attribute];
  if (state.attributePoints < 1) {
    return failure(state, 'no attribute points are available');
  }
  if (current >= ATTRIBUTE_MAXIMUM) {
    return failure(state, `${attribute} is already at its maximum`);
  }

  const next = cloneProgression(state);
  next.attributes[attribute] = current + 1;
  next.attributePoints -= 1;
  return { success: true, state: next };
}

export function refundAttribute(
  state: Readonly<ProgressionState>,
  attribute: AttributeId,
): ProgressionTransactionResult {
  const current = state.attributes[attribute];
  if (current <= ATTRIBUTE_MINIMUM) {
    return failure(state, `${attribute} is already at its minimum`);
  }
  const next = cloneProgression(state);
  next.attributes[attribute] = current - 1;
  next.attributePoints += 1;
  return { success: true, state: next };
}

export function purchaseSkill(
  state: Readonly<ProgressionState>,
  skillId: string,
  definitions: readonly SkillNodeDefinition[],
): ProgressionTransactionResult {
  const definition = definitions.find((entry) => entry.id === skillId);
  if (!definition) {
    return failure(state, `unknown skill "${skillId}"`);
  }
  if (state.unlockedSkills.includes(skillId)) {
    return failure(state, `${skillId} is already unlocked`);
  }
  if (state.skillPoints < definition.cost) {
    return failure(state, 'not enough skill points');
  }

  const unlockedDefinitions = definitions.filter((entry) => state.unlockedSkills.includes(entry.id));
  const unlockedInTree = unlockedDefinitions.filter((entry) => (
    entry.tree === definition.tree && entry.tier < definition.tier
  )).length;
  if (unlockedInTree < definition.requiredNodesInTree) {
    return failure(
      state,
      `${skillId} requires ${definition.requiredNodesInTree} unlocked nodes in ${definition.tree}`,
    );
  }

  const mutuallyExclusive = unlockedDefinitions.some((entry) => (
    entry.id === definition.exclusiveWith || entry.exclusiveWith === definition.id
  ));
  if (mutuallyExclusive) {
    return failure(state, `${skillId} conflicts with an unlocked capstone`);
  }

  const next = cloneProgression(state);
  next.skillPoints -= definition.cost;
  next.unlockedSkills.push(definition.id);
  return { success: true, state: next };
}

export function refundSkill(
  state: Readonly<ProgressionState>,
  skillId: string,
  definitions: readonly SkillNodeDefinition[],
  mode: SkillRefundMode = 'reject-dependent',
): SkillRefundResult {
  if (mode !== 'reject-dependent' && mode !== 'cascade') {
    throw new RangeError(`unknown skill refund mode "${String(mode)}"`);
  }
  const definition = definitions.find((entry) => entry.id === skillId);
  if (!definition) {
    return skillRefundFailure(state, `unknown skill "${skillId}"`);
  }
  if (!state.unlockedSkills.includes(skillId)) {
    return skillRefundFailure(state, `${skillId} is not unlocked`);
  }

  const removed = new Set<string>([skillId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of definitions) {
      if (!state.unlockedSkills.includes(candidate.id) || removed.has(candidate.id)) continue;
      const remainingInTree = definitions.filter((entry) => (
        entry.tree === candidate.tree
        && entry.tier < candidate.tier
        && state.unlockedSkills.includes(entry.id)
        && !removed.has(entry.id)
      )).length;
      if (remainingInTree >= candidate.requiredNodesInTree) continue;
      if (mode === 'reject-dependent') {
        return skillRefundFailure(
          state,
          `cannot refund ${skillId} while ${candidate.id} depends on its tree count`,
        );
      }
      removed.add(candidate.id);
      changed = true;
    }
  }

  const refundedSkillIds = definitions
    .filter((entry) => removed.has(entry.id))
    .map((entry) => entry.id);
  const pointsRefunded = definitions
    .filter((entry) => removed.has(entry.id))
    .reduce((sum, entry) => sum + entry.cost, 0);
  const next = cloneProgression(state);
  next.unlockedSkills = next.unlockedSkills.filter((id) => !removed.has(id));
  next.skillPoints += pointsRefunded;
  return { success: true, state: next, refundedSkillIds, pointsRefunded };
}

export function countSkillsInTree(
  state: Readonly<ProgressionState>,
  tree: SkillTreeId,
  definitions: readonly SkillNodeDefinition[],
): number {
  return definitions.filter(
    (definition) => definition.tree === tree && state.unlockedSkills.includes(definition.id),
  ).length;
}

/** Additive attribute bonuses keyed by the authored stat names. */
export function calculateAttributeEffects(
  state: Readonly<ProgressionState>,
  definitions: readonly AttributeDefinition[],
): Readonly<Record<string, number>> {
  const effects: Record<string, number> = {};
  for (const definition of definitions) {
    const addedPoints = Math.max(0, state.attributes[definition.id] - definition.minimum);
    for (const effect of definition.effectsPerAddedPoint) {
      effects[effect.stat] = (effects[effect.stat] ?? 0) + effect.amount * addedPoints;
    }
  }
  return effects;
}

/** Applies numeric authored skill effects in stable catalog order. */
export function calculateSkillStat(
  baseValue: number,
  stat: string,
  state: Readonly<ProgressionState>,
  definitions: readonly SkillNodeDefinition[],
): number {
  if (!Number.isFinite(baseValue)) {
    throw new TypeError('baseValue must be finite');
  }
  let value = baseValue;
  for (const definition of definitions) {
    if (!state.unlockedSkills.includes(definition.id)) {
      continue;
    }
    for (const effect of definition.effects) {
      if (effect.stat !== stat || typeof effect.value !== 'number') {
        continue;
      }
      value = effect.operation === 'multiply' ? value * effect.value : value + effect.value;
    }
  }
  return value;
}

export function calculateProgressionStat(
  baseValue: number,
  stat: string,
  state: Readonly<ProgressionState>,
  attributeDefinitions: readonly AttributeDefinition[] = ATTRIBUTES,
  skillDefinitions: readonly SkillNodeDefinition[] = SKILL_NODES,
  ending: EndingChoice | null = null,
): number {
  if (!Number.isFinite(baseValue)) {
    throw new TypeError('baseValue must be finite');
  }
  let value = baseValue;
  for (const definition of attributeDefinitions) {
    const addedPoints = Math.max(0, state.attributes[definition.id] - definition.minimum);
    for (const effect of definition.effectsPerAddedPoint) {
      if (effect.stat !== stat) continue;
      const total = effect.amount * addedPoints;
      value = effect.unit === 'flat' ? value + total : value * (1 + total / 100);
    }
  }
  value = calculateSkillStat(value, stat, state, skillDefinitions);
  return value * endingStatMultiplier(stat, ending);
}

export function listSkillUnlockEffects(
  state: Readonly<ProgressionState>,
  definitions: readonly SkillNodeDefinition[] = SKILL_NODES,
): readonly string[] {
  const values: string[] = [];
  for (const definition of definitions) {
    if (!state.unlockedSkills.includes(definition.id)) continue;
    for (const effect of definition.effects) {
      if (effect.operation === 'unlock' && typeof effect.value === 'string' && !values.includes(effect.value)) {
        values.push(effect.value);
      }
    }
  }
  return values;
}

export function calculateProgressionModifiers(
  state: Readonly<ProgressionState>,
  ending: EndingChoice | null = null,
  attributeDefinitions: readonly AttributeDefinition[] = ATTRIBUTES,
  skillDefinitions: readonly SkillNodeDefinition[] = SKILL_NODES,
): ProgressionModifiers {
  const calculate = (baseValue: number, stat: string): number => calculateProgressionStat(
    baseValue,
    stat,
    state,
    attributeDefinitions,
    skillDefinitions,
    ending,
  );
  return {
    maximumHealth: calculate(BASE_MAXIMUM_HEALTH, 'maximumHealth'),
    backpackWeightKg: calculate(INITIAL_BACKPACK_WEIGHT_KG, 'backpackWeightKg'),
    meleeDamageMultiplier: calculate(1, 'meleeDamage'),
    weaponSpreadMultiplier: calculate(1, 'weaponSpread'),
    reloadTimeMultiplier: calculate(1, 'reloadTime'),
    vehicleStabilityMultiplier: calculate(1, 'vehicleStability'),
    vehicleBrakingMultiplier: calculate(1, 'vehicleBraking'),
    vehicleDurabilityMultiplier: calculate(1, 'vehicleDurability'),
    heatGainMultiplier: calculate(1, 'heatGain'),
    enemySuspicionTimeMultiplier: calculate(1, 'enemySuspicionTime'),
    cashRewardMultiplier: calculate(1, 'cashReward'),
    contactReputationRewardMultiplier: calculate(1, 'contactReputationReward'),
    unlockedEffects: listSkillUnlockEffects(state, skillDefinitions),
  };
}

export const deriveProgressionModifiers = calculateProgressionModifiers;

export function endingStatMultiplier(stat: string, ending: EndingChoice | null): number {
  if (ending === 'rule') {
    if (stat === 'propertyIncome') return 1.2;
    if (stat === 'blackMarketPrice') return 0.9;
    if (stat === 'heatGain') return 1.1;
  } else if (ending === 'expose') {
    if (stat === 'wantedSearchDuration') return 0.8;
    if (stat === 'legitimatePropertyPerk') return 1.2;
    if (stat === 'blackMarketPrice') return 1.1;
  }
  return 1;
}

export function hasSkillUnlock(
  unlockValue: string,
  state: Readonly<ProgressionState>,
  definitions: readonly SkillNodeDefinition[],
): boolean {
  return definitions.some((definition) => state.unlockedSkills.includes(definition.id)
    && definition.effects.some((effect) => (
      effect.operation === 'unlock' && effect.value === unlockValue
    )));
}

export function validateSkillCatalog(definitions: readonly SkillNodeDefinition[]): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      errors.push(`duplicate skill id "${definition.id}"`);
    }
    ids.add(definition.id);
    const expectedRequirement = definition.tier === 1 ? 0 : definition.tier === 2 ? 2 : 5;
    if (definition.cost !== 1) {
      errors.push(`${definition.id} must cost exactly one skill point`);
    }
    if (definition.requiredNodesInTree !== expectedRequirement) {
      errors.push(`${definition.id} has an invalid tier prerequisite`);
    }
    if (definition.capstone !== (definition.tier === 3)) {
      errors.push(`${definition.id} capstone flag must match tier 3`);
    }
    if (definition.capstone !== (definition.exclusiveWith !== null)) {
      errors.push(`${definition.id} exclusivity must be present only for capstones`);
    }
    if (definition.effects.length === 0) {
      errors.push(`${definition.id} must define at least one measured effect`);
    }
    for (const effect of definition.effects) {
      if (!effect.stat) errors.push(`${definition.id} contains an effect without a stat`);
      if (effect.operation === 'unlock') {
        if (typeof effect.value !== 'string' || effect.value.length === 0) {
          errors.push(`${definition.id} unlock effects require a non-empty string value`);
        }
      } else if (typeof effect.value !== 'number' || !Number.isFinite(effect.value)) {
        errors.push(`${definition.id} numeric effects require a finite value`);
      }
    }
    if (definition.exclusiveWith) {
      const exclusive = definitions.find((entry) => entry.id === definition.exclusiveWith);
      if (!exclusive) {
        errors.push(`${definition.id} references missing exclusive skill "${definition.exclusiveWith}"`);
      } else {
        if (exclusive.tree !== definition.tree) {
          errors.push(`${definition.id} exclusive capstone must be in the same tree`);
        }
        if (exclusive.exclusiveWith !== definition.id) {
          errors.push(`${definition.id} exclusive relationship must be reciprocal`);
        }
      }
    }
  }
  for (const tree of ['combat', 'driving', 'streetcraft'] as const) {
    const treeDefinitions = definitions.filter((definition) => definition.tree === tree);
    const treeCount = treeDefinitions.length;
    if (treeCount !== 8) {
      errors.push(`${tree} must contain exactly 8 nodes, found ${treeCount}`);
    }
    const regularCount = treeDefinitions.filter((definition) => !definition.capstone).length;
    const capstoneCount = treeDefinitions.filter((definition) => definition.capstone).length;
    if (regularCount !== 6 || capstoneCount !== 2) {
      errors.push(`${tree} must contain six regular nodes and two capstones`);
    }
    const tierCounts = [1, 2, 3].map((tier) => (
      treeDefinitions.filter((definition) => definition.tier === tier).length
    ));
    if (tierCounts[0] !== 3 || tierCounts[1] !== 3 || tierCounts[2] !== 2) {
      errors.push(`${tree} must contain three tier-1, three tier-2, and two tier-3 nodes`);
    }
  }
  if (definitions.length !== 24) {
    errors.push(`catalog must contain exactly 24 nodes, found ${definitions.length}`);
  }
  return errors;
}

export function validateAttributeCatalog(definitions: readonly AttributeDefinition[]): readonly string[] {
  const errors: string[] = [];
  const expectedIds: readonly AttributeId[] = ['grit', 'aim', 'handling', 'nerve', 'hustle'];
  const ids = new Set<AttributeId>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) errors.push(`duplicate attribute id "${definition.id}"`);
    ids.add(definition.id);
    if (definition.minimum !== ATTRIBUTE_MINIMUM || definition.maximum !== ATTRIBUTE_MAXIMUM) {
      errors.push(`${definition.id} must use the locked 1-6 range`);
    }
    if (definition.effectsPerAddedPoint.length === 0) {
      errors.push(`${definition.id} must define at least one measured effect`);
    }
    for (const effect of definition.effectsPerAddedPoint) {
      if (!effect.stat || !Number.isFinite(effect.amount)) {
        errors.push(`${definition.id} contains an invalid attribute effect`);
      }
    }
  }
  for (const id of expectedIds) {
    if (!ids.has(id)) errors.push(`attribute catalog is missing "${id}"`);
  }
  if (definitions.length !== expectedIds.length) {
    errors.push(`attribute catalog must contain exactly ${expectedIds.length} definitions`);
  }
  return errors;
}

export function validateProgressionState(
  value: unknown,
  skillDefinitions: readonly SkillNodeDefinition[] = SKILL_NODES,
  attributeDefinitions: readonly AttributeDefinition[] = ATTRIBUTES,
): ProgressionValidationResult {
  const errors = [
    ...validateSkillCatalog(skillDefinitions).map((error) => `skill catalog: ${error}`),
    ...validateAttributeCatalog(attributeDefinitions).map((error) => `attribute catalog: ${error}`),
  ];
  if (!isRecord(value)) {
    return { valid: false, errors: [...errors, 'progression state must be an object'] };
  }

  if (!isSafeIntegerInRange(value.level, 1, LEVEL_CAP)) {
    errors.push(`level must be an integer between 1 and ${LEVEL_CAP}`);
  }
  if (!isSafeIntegerInRange(value.xp, 0, Number.MAX_SAFE_INTEGER)) {
    errors.push('xp must be a non-negative safe integer');
  }
  if (!isSafeIntegerInRange(value.attributePoints, 0, Math.floor(LEVEL_CAP / 2))) {
    errors.push('attributePoints is outside the earned point range');
  }
  if (!isSafeIntegerInRange(value.skillPoints, 0, LEVEL_CAP - 1)) {
    errors.push('skillPoints is outside the earned point range');
  }

  const attributeIds: readonly AttributeId[] = ['grit', 'aim', 'handling', 'nerve', 'hustle'];
  let attributes: Record<AttributeId, number> | null = null;
  if (!isRecord(value.attributes)) {
    errors.push('attributes must be an object');
  } else {
    const attributeRecord = value.attributes;
    const unknownAttributeIds = Object.keys(attributeRecord).filter(
      (id) => !attributeIds.includes(id as AttributeId),
    );
    if (unknownAttributeIds.length > 0) {
      errors.push(`attributes contains unknown keys: ${unknownAttributeIds.join(', ')}`);
    }
    for (const id of attributeIds) {
      if (!isSafeIntegerInRange(attributeRecord[id], ATTRIBUTE_MINIMUM, ATTRIBUTE_MAXIMUM)) {
        errors.push(`${id} must be an integer between ${ATTRIBUTE_MINIMUM} and ${ATTRIBUTE_MAXIMUM}`);
      }
    }
    if (attributeIds.every((id) => isSafeIntegerInRange(
      attributeRecord[id], ATTRIBUTE_MINIMUM, ATTRIBUTE_MAXIMUM,
    ))) {
      attributes = {
        grit: attributeRecord.grit as number,
        aim: attributeRecord.aim as number,
        handling: attributeRecord.handling as number,
        nerve: attributeRecord.nerve as number,
        hustle: attributeRecord.hustle as number,
      };
    }
  }

  let unlockedIds: string[] | null = null;
  if (!Array.isArray(value.unlockedSkills)) {
    errors.push('unlockedSkills must be an array');
  } else if (!value.unlockedSkills.every((id) => typeof id === 'string')) {
    errors.push('unlockedSkills must contain only strings');
  } else {
    const ids = value.unlockedSkills as string[];
    if (new Set(ids).size !== ids.length) errors.push('unlockedSkills must not contain duplicates');
    const knownIds = new Set(skillDefinitions.map((definition) => definition.id));
    const unknownIds = ids.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) errors.push(`unlockedSkills contains unknown ids: ${unknownIds.join(', ')}`);
    unlockedIds = [...ids];
  }

  if (
    errors.length > 0
    || attributes === null
    || unlockedIds === null
    || typeof value.level !== 'number'
    || typeof value.xp !== 'number'
    || typeof value.attributePoints !== 'number'
    || typeof value.skillPoints !== 'number'
  ) {
    return { valid: false, errors };
  }

  const state: ProgressionState = {
    level: value.level,
    xp: value.xp,
    attributePoints: value.attributePoints,
    skillPoints: value.skillPoints,
    attributes,
    unlockedSkills: skillDefinitions
      .filter((definition) => unlockedIds?.includes(definition.id))
      .map((definition) => definition.id),
  };
  const expectedLevel = levelForXp(state.xp);
  if (state.level !== expectedLevel) {
    errors.push(`level ${state.level} does not match lifetime xp (expected ${expectedLevel})`);
  }

  const unlocked = new Set(state.unlockedSkills);
  for (const definition of skillDefinitions) {
    if (!unlocked.has(definition.id)) continue;
    const prerequisiteCount = skillDefinitions.filter((candidate) => (
      candidate.tree === definition.tree
      && candidate.tier < definition.tier
      && unlocked.has(candidate.id)
    )).length;
    if (prerequisiteCount < definition.requiredNodesInTree) {
      errors.push(`${definition.id} does not satisfy its ${definition.requiredNodesInTree}-node prerequisite`);
    }
    if (definition.exclusiveWith && unlocked.has(definition.exclusiveWith)) {
      errors.push(`${definition.id} conflicts with ${definition.exclusiveWith}`);
    }
  }

  const spentSkillPoints = skillDefinitions
    .filter((definition) => unlocked.has(definition.id))
    .reduce((sum, definition) => sum + definition.cost, 0);
  const earnedSkillPoints = state.level - 1;
  if (spentSkillPoints + state.skillPoints !== earnedSkillPoints) {
    errors.push(
      `skill point accounting must equal ${earnedSkillPoints} earned points, found ${spentSkillPoints} spent and ${state.skillPoints} available`,
    );
  }
  const spentAttributePoints = attributeIds.reduce(
    (sum, id) => sum + state.attributes[id] - ATTRIBUTE_MINIMUM,
    0,
  );
  const earnedAttributePoints = Math.floor(state.level / 2);
  if (spentAttributePoints + state.attributePoints !== earnedAttributePoints) {
    errors.push(
      `attribute point accounting must equal ${earnedAttributePoints} earned points, found ${spentAttributePoints} spent and ${state.attributePoints} available`,
    );
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, state, errors: [] };
}

export function restoreProgressionState(
  value: unknown,
  skillDefinitions: readonly SkillNodeDefinition[] = SKILL_NODES,
  attributeDefinitions: readonly AttributeDefinition[] = ATTRIBUTES,
): ProgressionRestoreResult {
  const validation = validateProgressionState(value, skillDefinitions, attributeDefinitions);
  if (!validation.valid) {
    return { success: false, state: createInitialProgressionState(), errors: validation.errors };
  }
  return { success: true, state: cloneProgression(validation.state), errors: [] };
}

function cloneProgression(state: Readonly<ProgressionState>): ProgressionState {
  return {
    ...state,
    attributes: { ...state.attributes },
    unlockedSkills: [...state.unlockedSkills],
  };
}

function failure(state: Readonly<ProgressionState>, reason: string): ProgressionTransactionResult {
  return { success: false, state: cloneProgression(state), reason };
}

function skillRefundFailure(
  state: Readonly<ProgressionState>,
  reason: string,
): SkillRefundResult {
  return {
    success: false,
    state: cloneProgression(state),
    refundedSkillIds: [],
    pointsRefunded: 0,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function assertIntegerInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}
