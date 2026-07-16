import { describe, expect, it } from 'vitest';

import { COLLECTIBLES, COLLECTIBLE_SETS } from '../../src/data/collectibles';
import { ACTIVITIES } from '../../src/data/economy';
import { MISSIONS } from '../../src/data/missions';
import { ATTRIBUTES, SKILL_NODES } from '../../src/data/progression';
import type { SkillNodeDefinition } from '../../src/data/types';
import { createInitialSaveGame } from '../../src/core/state';
import {
  BASE_BACKPACK_WEIGHT_KG,
  INITIAL_BACKPACK_WEIGHT_KG,
  LEVEL_CAP,
  MAX_LEVEL_XP_THRESHOLD,
  calculateProgressionModifiers,
  calculateProgressionStat,
  createInitialProgressionState,
  endingStatMultiplier,
  grantXp,
  grantXpReward,
  levelForXp,
  levelProgress,
  listSkillUnlockEffects,
  purchaseAttribute,
  purchaseSkill,
  quoteXpReward,
  refundAttribute,
  refundSkill,
  restoreProgressionState,
  validateAttributeCatalog,
  validateProgressionState,
  validateSkillCatalog,
  xpRequiredForNextLevel,
  xpThresholdForLevel,
} from '../../src/systems/progression';
import type { ProgressionState } from '../../src/systems/progression';

function levelState(level: number): ProgressionState {
  return grantXp(createInitialProgressionState(), xpThresholdForLevel(level)).state;
}

function buySkill(state: Readonly<ProgressionState>, skillId: string): ProgressionState {
  const result = purchaseSkill(state, skillId, SKILL_NODES);
  if (!result.success) throw new Error(result.reason);
  return result.state;
}

function buyAttribute(state: Readonly<ProgressionState>, attributeId: Parameters<typeof purchaseAttribute>[1]): ProgressionState {
  const result = purchaseAttribute(state, attributeId);
  if (!result.success) throw new Error(result.reason);
  return result.state;
}

describe('level curve and XP reward policy', () => {
  it('uses a deterministic rising curve through the locked level-20 cap', () => {
    expect(xpRequiredForNextLevel(1)).toBe(500);
    expect(xpRequiredForNextLevel(2)).toBe(750);
    expect(xpRequiredForNextLevel(19)).toBe(5_000);
    expect(xpRequiredForNextLevel(LEVEL_CAP)).toBe(0);
    expect(MAX_LEVEL_XP_THRESHOLD).toBe(52_250);
    expect(xpThresholdForLevel(LEVEL_CAP)).toBe(MAX_LEVEL_XP_THRESHOLD);
    expect(levelForXp(MAX_LEVEL_XP_THRESHOLD - 1)).toBe(19);
    expect(levelForXp(MAX_LEVEL_XP_THRESHOLD)).toBe(20);
  });

  it('reports exact in-level progress and a stable capped state', () => {
    const levelTwoThreshold = xpThresholdForLevel(2);
    const midway = levelProgress({ level: 2, xp: levelTwoThreshold + 375 });
    expect(midway).toEqual({
      level: 2,
      capped: false,
      currentLevelThreshold: levelTwoThreshold,
      nextLevelThreshold: xpThresholdForLevel(3),
      xpEarnedInLevel: 375,
      xpRequiredInLevel: 750,
      xpRemaining: 375,
      fraction: 0.5,
    });
    expect(levelProgress({ level: 20, xp: MAX_LEVEL_XP_THRESHOLD + 3_000 })).toMatchObject({
      capped: true,
      xpRemaining: 0,
      fraction: 1,
      nextLevelThreshold: null,
    });
  });

  it('awards full first-completion XP, reduced repeat activity XP, and no duplicate discovery XP', () => {
    expect(quoteXpReward({
      source: 'activity', baseXp: 120, firstCompletion: true, difficultyMultiplier: 1.6,
    })).toMatchObject({ awardedXp: 192, eligible: true, repeatMultiplier: 1 });
    expect(quoteXpReward({
      source: 'activity', baseXp: 120, firstCompletion: false, difficultyMultiplier: 1.6,
    })).toMatchObject({ awardedXp: 48, eligible: true, repeatMultiplier: 0.25 });
    expect(quoteXpReward({
      source: 'discovery', baseXp: 150, firstCompletion: false,
    })).toMatchObject({ awardedXp: 0, eligible: false, repeatMultiplier: 0 });
    expect(quoteXpReward({
      source: 'mission', baseXp: 650, firstCompletion: false,
    }).awardedXp).toBe(0);
  });

  it('grants a quoted reward through the same immutable multi-level transaction', () => {
    const initial = createInitialProgressionState();
    const result = grantXpReward(initial, {
      source: 'mission', baseXp: 1_400, firstCompletion: true, rewardMultiplier: 1,
    });
    expect(result.reward.awardedXp).toBe(1_400);
    expect(result.state.level).toBe(3);
    expect(result).toMatchObject({ levelsGained: 2, skillPointsGained: 2, attributePointsGained: 1 });
    expect(initial).toEqual(createInitialProgressionState());
  });

  it('keeps authored mission XP larger than first-pass secondary activity and discovery XP', () => {
    const missionXp = MISSIONS.reduce((sum, mission) => sum + mission.rewards.xp, 0);
    const firstActivityXp = ACTIVITIES.reduce((sum, activity) => sum + activity.baseXp, 0);
    const discoveryXp = COLLECTIBLES.reduce((sum, collectible) => sum + collectible.reward.xp, 0)
      + COLLECTIBLE_SETS.reduce((sum, set) => sum + set.completionReward.xp, 0);
    expect(missionXp).toBeGreaterThan(firstActivityXp + discoveryXp);
  });
});

describe('measured attribute, skill, and ending modifiers', () => {
  it('matches the backpack contract at Grit 1 and every later Grit point', () => {
    expect(BASE_BACKPACK_WEIGHT_KG).toBe(20);
    expect(INITIAL_BACKPACK_WEIGHT_KG).toBe(22);
    expect(calculateProgressionModifiers(createInitialProgressionState()).backpackWeightKg).toBe(22);
    const maximumGrit = {
      ...createInitialProgressionState(),
      attributes: { ...createInitialProgressionState().attributes, grit: 6 },
    };
    expect(calculateProgressionModifiers(maximumGrit).backpackWeightKg).toBe(32);
  });

  it('turns all five attributes and representative skills into exact runtime values', () => {
    const state: ProgressionState = {
      ...createInitialProgressionState(),
      attributes: { grit: 6, aim: 6, handling: 6, nerve: 6, hustle: 6 },
      unlockedSkills: [
        'combat-fast-hands',
        'combat-street-fighter',
        'combat-deadeye',
        'driving-road-warrior',
        'streetcraft-kingpin',
      ],
    };
    const modifiers = calculateProgressionModifiers(state, 'rule');
    expect(modifiers.maximumHealth).toBe(150);
    expect(modifiers.backpackWeightKg).toBe(32);
    expect(modifiers.meleeDamageMultiplier).toBeCloseTo(1.25 * 1.15);
    expect(modifiers.weaponSpreadMultiplier).toBeCloseTo(0.75);
    expect(modifiers.reloadTimeMultiplier).toBeCloseTo(0.85 * 0.85);
    expect(modifiers.vehicleStabilityMultiplier).toBeCloseTo(1.2);
    expect(modifiers.vehicleBrakingMultiplier).toBeCloseTo(1.2);
    expect(modifiers.vehicleDurabilityMultiplier).toBeCloseTo(1.1 * 1.2);
    expect(modifiers.heatGainMultiplier).toBeCloseTo(0.75 * 1.1);
    expect(modifiers.enemySuspicionTimeMultiplier).toBeCloseTo(1.25);
    expect(modifiers.cashRewardMultiplier).toBeCloseTo(1.25 * 1.15);
    expect(modifiers.contactReputationRewardMultiplier).toBeCloseTo(1.25 * 1.15);
    expect(modifiers.unlockedEffects).toEqual(['four-second-focus']);
  });

  it('makes every one of the 24 skill definitions observable through generic stat APIs', () => {
    expect(SKILL_NODES).toHaveLength(24);
    for (const definition of SKILL_NODES) {
      const state = { ...createInitialProgressionState(), unlockedSkills: [definition.id] };
      for (const effect of definition.effects) {
        if (effect.operation === 'unlock') {
          expect(listSkillUnlockEffects(state), definition.id).toContain(effect.value);
          continue;
        }
        const baseValue = effect.operation === 'multiply' ? 10 : 0;
        const expected = effect.operation === 'multiply'
          ? baseValue * (effect.value as number)
          : baseValue + (effect.value as number);
        expect(
          calculateProgressionStat(baseValue, effect.stat, state),
          `${definition.id}:${effect.stat}`,
        ).toBeCloseTo(expected);
      }
    }
  });

  it('exposes both ending branches as composable stat multipliers', () => {
    const state = createInitialProgressionState();
    expect(endingStatMultiplier('propertyIncome', 'rule')).toBe(1.2);
    expect(endingStatMultiplier('blackMarketPrice', 'rule')).toBe(0.9);
    expect(endingStatMultiplier('heatGain', 'rule')).toBe(1.1);
    expect(endingStatMultiplier('wantedSearchDuration', 'expose')).toBe(0.8);
    expect(endingStatMultiplier('legitimatePropertyPerk', 'expose')).toBe(1.2);
    expect(endingStatMultiplier('blackMarketPrice', 'expose')).toBe(1.1);
    expect(calculateProgressionStat(100, 'propertyIncome', state, ATTRIBUTES, SKILL_NODES, 'rule')).toBe(120);
    expect(calculateProgressionStat(100, 'wantedSearchDuration', state, ATTRIBUTES, SKILL_NODES, 'expose')).toBe(80);
  });
});

describe('purchases and deterministic refunds', () => {
  it('enforces lower-tier purchases before tier 2 and five lower-tier nodes before a capstone', () => {
    let state = levelState(8);
    expect(purchaseSkill(state, 'combat-second-wind', SKILL_NODES).success).toBe(false);
    state = buySkill(state, 'combat-steady-hands');
    state = buySkill(state, 'combat-fast-hands');
    state = buySkill(state, 'combat-second-wind');
    expect(purchaseSkill(state, 'combat-deadeye', SKILL_NODES).success).toBe(false);
    state = buySkill(state, 'combat-thick-skin');
    state = buySkill(state, 'combat-street-fighter');
    state = buySkill(state, 'combat-scavenger');
    state = buySkill(state, 'combat-deadeye');
    expect(state.unlockedSkills).toContain('combat-deadeye');
    expect(purchaseSkill(state, 'combat-juggernaut', SKILL_NODES).success).toBe(false);
  });

  it('refunds standalone nodes and attributes without mutating source state', () => {
    let state = levelState(2);
    state = buySkill(state, 'combat-steady-hands');
    state = buyAttribute(state, 'grit');
    const skillRefund = refundSkill(state, 'combat-steady-hands', SKILL_NODES);
    expect(skillRefund).toMatchObject({ success: true, pointsRefunded: 1, refundedSkillIds: ['combat-steady-hands'] });
    if (skillRefund.success) expect(skillRefund.state.skillPoints).toBe(1);
    const attributeRefund = refundAttribute(state, 'grit');
    expect(attributeRefund.success).toBe(true);
    if (attributeRefund.success) {
      expect(attributeRefund.state.attributes.grit).toBe(1);
      expect(attributeRefund.state.attributePoints).toBe(1);
    }
    expect(state).toMatchObject({ skillPoints: 0, attributePoints: 0, unlockedSkills: ['combat-steady-hands'] });
  });

  it('rejects a dependency-breaking refund or cascades it in stable catalog order', () => {
    let state = levelState(4);
    state = buySkill(state, 'combat-steady-hands');
    state = buySkill(state, 'combat-fast-hands');
    state = buySkill(state, 'combat-second-wind');
    const rejected = refundSkill(state, 'combat-steady-hands', SKILL_NODES);
    expect(rejected).toMatchObject({ success: false, pointsRefunded: 0 });

    const cascaded = refundSkill(state, 'combat-steady-hands', SKILL_NODES, 'cascade');
    expect(cascaded).toMatchObject({
      success: true,
      refundedSkillIds: ['combat-steady-hands', 'combat-second-wind'],
      pointsRefunded: 2,
    });
    if (cascaded.success) {
      expect(cascaded.state.unlockedSkills).toEqual(['combat-fast-hands']);
      expect(cascaded.state.skillPoints).toBe(2);
      expect(validateProgressionState(cascaded.state).valid).toBe(true);
    }
  });
});

describe('catalog, save restore, and point-accounting validation', () => {
  it('validates the locked five attributes and three complete eight-node trees', () => {
    expect(validateAttributeCatalog(ATTRIBUTES)).toEqual([]);
    expect(validateSkillCatalog(SKILL_NODES)).toEqual([]);
    for (const tree of ['combat', 'driving', 'streetcraft'] as const) {
      const definitions = SKILL_NODES.filter((skill) => skill.tree === tree);
      expect(definitions).toHaveLength(8);
      expect(definitions.filter((skill) => skill.capstone)).toHaveLength(2);
    }
  });

  it('detects malformed costs, incomplete catalogs, and non-reciprocal capstones', () => {
    const first = SKILL_NODES[0];
    const deadeye = SKILL_NODES.find((skill) => skill.id === 'combat-deadeye');
    if (!first || !deadeye) throw new Error('required test definitions are missing');
    const broken: SkillNodeDefinition[] = SKILL_NODES.map((skill) => {
      if (skill.id === first.id) return { ...skill, cost: 2 as 1 };
      if (skill.id === deadeye.id) return { ...skill, exclusiveWith: null };
      return { ...skill };
    });
    expect(validateSkillCatalog(broken).join(' ')).toMatch(/cost exactly one|exclusive/i);
    expect(validateSkillCatalog(SKILL_NODES.slice(0, 23))).not.toEqual([]);
    const firstAttribute = ATTRIBUTES[0];
    if (!firstAttribute) throw new Error('required attribute definition is missing');
    expect(validateAttributeCatalog([...ATTRIBUTES, firstAttribute])).not.toEqual([]);
  });

  it('round-trips a legitimately earned and purchased build in canonical catalog order', () => {
    let state = levelState(6);
    state = buySkill(state, 'combat-steady-hands');
    state = buySkill(state, 'combat-fast-hands');
    state = buySkill(state, 'combat-second-wind');
    state = buySkill(state, 'driving-road-grip');
    state = buyAttribute(state, 'grit');
    state = buyAttribute(state, 'aim');
    state = buyAttribute(state, 'aim');
    const reversed = { ...state, unlockedSkills: [...state.unlockedSkills].reverse() };

    const validation = validateProgressionState(reversed);
    expect(validation.valid).toBe(true);
    const restored = restoreProgressionState(reversed);
    expect(restored.success).toBe(true);
    expect(restored.state).toEqual(state);
    expect(restored.state).not.toBe(state);
    expect(restored.state.attributes).not.toBe(state.attributes);
  });

  it('restores directly from the existing SaveGameV1 player subset', () => {
    const save = createInitialSaveGame(1, 'masculine', { timestamp: 123, seed: 'progression-save' });
    const restored = restoreProgressionState(save.player);
    expect(restored).toMatchObject({ success: true, state: createInitialProgressionState() });
    expect(calculateProgressionModifiers(restored.state).backpackWeightKg).toBe(save.inventory.maxWeightKg);
  });

  it('rejects XP, points, prerequisites, duplicates, unknown ids, and capstone conflicts', () => {
    expect(validateProgressionState({ ...createInitialProgressionState(), level: 2 }).valid).toBe(false);
    expect(validateProgressionState({ ...createInitialProgressionState(), skillPoints: 1 }).valid).toBe(false);
    expect(validateProgressionState({
      ...createInitialProgressionState(), unlockedSkills: ['unknown-skill'],
    }).valid).toBe(false);
    expect(validateProgressionState({
      ...createInitialProgressionState(), unlockedSkills: ['combat-steady-hands', 'combat-steady-hands'],
    }).valid).toBe(false);

    const missingPrerequisites: ProgressionState = {
      ...levelState(4),
      skillPoints: 2,
      unlockedSkills: ['combat-second-wind'],
    };
    expect(validateProgressionState(missingPrerequisites).valid).toBe(false);

    const conflict: ProgressionState = {
      ...levelState(8),
      skillPoints: 0,
      unlockedSkills: [
        'combat-steady-hands', 'combat-fast-hands', 'combat-thick-skin',
        'combat-second-wind', 'combat-street-fighter',
        'combat-deadeye', 'combat-juggernaut',
      ],
    };
    const conflictValidation = validateProgressionState(conflict);
    expect(conflictValidation.valid).toBe(false);
    if (!conflictValidation.valid) expect(conflictValidation.errors.join(' ')).toMatch(/conflicts/);
  });

  it('fails closed to a fresh build when restoring malformed external state', () => {
    const malformed = {
      ...levelState(5),
      attributes: { grit: 99, aim: 1, handling: 1, nerve: 1, hustle: 1 },
    };
    const restored = restoreProgressionState(malformed);
    expect(restored.success).toBe(false);
    expect(restored.errors.length).toBeGreaterThan(0);
    expect(restored.state).toEqual(createInitialProgressionState());
  });
});
