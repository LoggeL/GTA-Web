import type {
  AttributeDefinition,
  AttributeId,
  SkillNodeDefinition,
  SkillTreeId,
} from '../data/types';

export const LEVEL_CAP = 20;
export const ATTRIBUTE_MINIMUM = 1;
export const ATTRIBUTE_MAXIMUM = 6;

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
  const unlockedInTree = unlockedDefinitions.filter((entry) => entry.tree === definition.tree).length;
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
    if (definition.exclusiveWith && !definitions.some((entry) => entry.id === definition.exclusiveWith)) {
      errors.push(`${definition.id} references missing exclusive skill "${definition.exclusiveWith}"`);
    }
  }
  for (const tree of ['combat', 'driving', 'streetcraft'] as const) {
    const treeCount = definitions.filter((definition) => definition.tree === tree).length;
    if (treeCount !== 8) {
      errors.push(`${tree} must contain exactly 8 nodes, found ${treeCount}`);
    }
  }
  if (definitions.length !== 24) {
    errors.push(`catalog must contain exactly 24 nodes, found ${definitions.length}`);
  }
  return errors;
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
