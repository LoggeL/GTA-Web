import { describe, expect, it } from 'vitest';

import { ATTRIBUTES, SKILL_NODES } from '../../src/data/progression';
import {
  calculateAttributeEffects,
  calculateSkillStat,
  createInitialProgressionState,
  grantXp,
  hasSkillUnlock,
  purchaseAttribute,
  purchaseSkill,
  validateSkillCatalog,
  xpThresholdForLevel,
} from '../../src/systems/progression';

describe('progression', () => {
  it('awards one skill point per level and an attribute point on even levels', () => {
    const initial = createInitialProgressionState();
    const result = grantXp(initial, xpThresholdForLevel(6));

    expect(result.state.level).toBe(6);
    expect(result.levelsGained).toBe(5);
    expect(result.skillPointsGained).toBe(5);
    expect(result.attributePointsGained).toBe(3);
    expect(initial).toEqual(createInitialProgressionState());
  });

  it('caps level at 20 while retaining lifetime XP', () => {
    const result = grantXp(createInitialProgressionState(), Number.MAX_SAFE_INTEGER);

    expect(result.state.level).toBe(20);
    expect(result.state.skillPoints).toBe(19);
    expect(result.state.attributePoints).toBe(10);
  });

  it('spends attribute points and enforces the cap', () => {
    const initial = { ...createInitialProgressionState(), attributePoints: 1 };
    const purchased = purchaseAttribute(initial, 'grit');
    expect(purchased.success).toBe(true);
    if (!purchased.success) return;
    expect(purchased.state.attributes.grit).toBe(2);
    expect(purchased.state.attributePoints).toBe(0);

    const capped = {
      ...purchased.state,
      attributePoints: 1,
      attributes: { ...purchased.state.attributes, grit: 6 },
    };
    expect(purchaseAttribute(capped, 'grit').success).toBe(false);
  });

  it('validates and individually purchases every authored skill node', () => {
    expect(validateSkillCatalog(SKILL_NODES)).toEqual([]);

    for (const definition of SKILL_NODES) {
      const prerequisites = SKILL_NODES
        .filter((candidate) => (
          candidate.tree === definition.tree
          && candidate.id !== definition.id
          && candidate.id !== definition.exclusiveWith
          && !candidate.capstone
        ))
        .slice(0, definition.requiredNodesInTree)
        .map((candidate) => candidate.id);
      const state = {
        ...createInitialProgressionState(),
        skillPoints: 24,
        unlockedSkills: prerequisites,
      };
      const result = purchaseSkill(state, definition.id, SKILL_NODES);
      expect(result.success, definition.id).toBe(true);
    }
  });

  it('enforces tree prerequisites, available points, and exclusive capstones', () => {
    const noPoints = purchaseSkill(
      createInitialProgressionState(),
      'combat-steady-hands',
      SKILL_NODES,
    );
    expect(noPoints.success).toBe(false);

    const noPrerequisites = purchaseSkill(
      { ...createInitialProgressionState(), skillPoints: 1 },
      'combat-second-wind',
      SKILL_NODES,
    );
    expect(noPrerequisites.success).toBe(false);

    const capstoneBuild = {
      ...createInitialProgressionState(),
      skillPoints: 2,
      unlockedSkills: [
        'combat-steady-hands',
        'combat-fast-hands',
        'combat-thick-skin',
        'combat-second-wind',
        'combat-street-fighter',
      ],
    };
    const deadeye = purchaseSkill(capstoneBuild, 'combat-deadeye', SKILL_NODES);
    expect(deadeye.success).toBe(true);
    if (!deadeye.success) return;
    expect(purchaseSkill(deadeye.state, 'combat-juggernaut', SKILL_NODES).success).toBe(false);
  });

  it('resolves authored attribute and skill effects', () => {
    const state = {
      ...createInitialProgressionState(),
      attributes: {
        grit: 3,
        aim: 1,
        handling: 1,
        nerve: 1,
        hustle: 1,
      },
      unlockedSkills: ['combat-steady-hands', 'combat-deadeye'],
    };
    const effects = calculateAttributeEffects(state, ATTRIBUTES);

    expect(effects.maximumHealth).toBe(20);
    expect(effects.backpackWeightKg).toBe(4);
    expect(calculateSkillStat(1, 'firearmRecoil', state, SKILL_NODES)).toBeCloseTo(0.88);
    expect(hasSkillUnlock('four-second-focus', state, SKILL_NODES)).toBe(true);
  });
});
