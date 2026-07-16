import {
  ACTIVITIES,
  assertDataRegistriesValid,
  ATTRIBUTES,
  CHECKPOINTS,
  COLLECTIBLES,
  COLLECTIBLE_SETS,
  DATA_REGISTRIES,
  DEFAULT_COLLECTIBLE_SEED,
  DIALOGUE,
  generateCollectibles,
  getMission,
  ITEMS,
  MISSIONS,
  MISSION_REWARDS,
  OBJECTIVES,
  PROPERTIES,
  RADIO_STATIONS,
  RADIO_TRACKS,
  RECIPES,
  requireItem,
  requireMission,
  SKILL_NODES,
  validateDataRegistries,
  VEHICLES,
  WEAPONS,
} from '../../src/data';
import { describe, expect, it } from 'vitest';

describe('HEATLINE data registries', () => {
  it('passes the full cross-registry validation suite', () => {
    expect(validateDataRegistries()).toEqual([]);
    expect(() => assertDataRegistriesValid()).not.toThrow();
  });

  it('exposes stable lookup helpers with fail-fast required lookups', () => {
    expect(getMission('past-due')?.number).toBe(1);
    expect(requireMission('freehold').number).toBe(12);
    expect(requireItem('medkit').category).toBe('consumable');
    expect(getMission('not-a-mission')).toBeUndefined();
    expect(() => requireMission('not-a-mission')).toThrow('Unknown mission id: not-a-mission');
    expect(DATA_REGISTRIES.collectibles.size).toBe(60);
  });

  it('keeps every top-level content contract serializable', () => {
    const encoded = JSON.stringify({
      missions: MISSIONS,
      attributes: ATTRIBUTES,
      skills: SKILL_NODES,
      vehicles: VEHICLES,
      weapons: WEAPONS,
      items: ITEMS,
      recipes: RECIPES,
      properties: PROPERTIES,
      activities: ACTIVITIES,
      collectibles: COLLECTIBLES,
      radio: RADIO_STATIONS,
    });

    expect(encoded).toContain('Past Due');
    expect(encoded).toContain('Coastline FM');
    expect(() => JSON.parse(encoded)).not.toThrow();
  });
});

describe('campaign content', () => {
  it('defines twelve numbered missions and complete flattened registries', () => {
    expect(MISSIONS).toHaveLength(12);
    expect(MISSION_REWARDS).toHaveLength(12);
    expect(MISSIONS.map((mission) => mission.number)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(OBJECTIVES).toHaveLength(50);
    expect(CHECKPOINTS).toHaveLength(37);
    expect(DIALOGUE).toHaveLength(50);
  });

  it('gates convergence behind all nine contact jobs and the finale behind convergence', () => {
    const convergence = requireMission('full-account');
    expect(new Set(convergence.prerequisites)).toEqual(
      new Set(MISSIONS.slice(1, 10).map((mission) => mission.id)),
    );
    expect(requireMission('freehold').prerequisites).toEqual(['full-account']);
  });

  it('models both finale branches and their distinct ending dialogue', () => {
    const finale = requireMission('freehold');
    const choice = finale.objectives.find((objective) => objective.id === 'freehold:choose-future');
    const rule = finale.objectives.find((objective) => objective.id === 'freehold:rule-network');
    const expose = finale.objectives.find((objective) => objective.id === 'freehold:expose-network');

    expect(choice?.completion).toEqual({ kind: 'choice-made', choices: ['rule', 'expose'] });
    expect(rule?.activation).toEqual({ choiceObjectiveId: choice?.id, choice: 'rule' });
    expect(expose?.activation).toEqual({ choiceObjectiveId: choice?.id, choice: 'expose' });
    expect(finale.dialogueKeys).toEqual(expect.arrayContaining(['freehold.rule', 'freehold.expose']));
    expect(finale.branchRewards?.map((reward) => reward.choice)).toEqual(['rule', 'expose']);
  });

  it('gives every mission recovery checkpoints, rewards, and owned dialogue keys', () => {
    for (const mission of MISSIONS) {
      expect(mission.objectives.length).toBeGreaterThanOrEqual(4);
      expect(mission.checkpoints.length).toBeGreaterThanOrEqual(3);
      expect(mission.checkpoints[0]?.afterObjectiveId).toBeNull();
      expect(mission.rewards.xp).toBeGreaterThan(0);
      expect(mission.dialogueKeys.length).toBeGreaterThanOrEqual(4);
      for (const key of mission.dialogueKeys) {
        expect(DIALOGUE.find((entry) => entry.key === key)?.missionId).toBe(mission.id);
      }
    }
  });

  it('authors valid, unique checkpoint-refill item definitions only where needed', () => {
    const authoredMissionItems = Object.fromEntries(
      MISSIONS
        .filter((mission) => mission.missionItems !== undefined)
        .map((mission) => [mission.id, mission.missionItems]),
    );

    expect(authoredMissionItems).toEqual({
      'past-due': [
        { itemId: 'pistol-tier-1', quantity: 1 },
        { itemId: 'medkit', quantity: 1 },
        { itemId: 'vehicle-repair-kit', quantity: 1 },
      ],
      'glass-house': [{ itemId: 'quest-listening-device', quantity: 1 }],
    });

    for (const mission of MISSIONS) {
      const missionItems = mission.missionItems ?? [];
      expect(new Set(missionItems.map((item) => item.itemId)).size).toBe(missionItems.length);
      for (const item of missionItems) {
        expect(requireItem(item.itemId).id).toBe(item.itemId);
        expect(Number.isSafeInteger(item.quantity) && item.quantity > 0).toBe(true);
      }
    }
  });

  it('authors bounded initial response levels exclusively for every lose-wanted objective', () => {
    const loseWantedObjectives = OBJECTIVES.filter(
      (objective) => objective.completion.kind === 'lose-wanted',
    );

    expect(Object.fromEntries(
      loseWantedObjectives.map((objective) => [objective.id, objective.initialWantedLevel]),
    )).toEqual({
      'rolling-stock:lose-police': 2,
      'last-call:rain-getaway': 2,
      'container-zero:extract-malik': 2,
      'black-grid:escape-tactical-search': 3,
      'freehold:escape-response': 5,
    });
    expect(loseWantedObjectives.every(
      (objective) => Number.isSafeInteger(objective.initialWantedLevel)
        && (objective.initialWantedLevel ?? 0) >= 1
        && (objective.initialWantedLevel ?? 0) <= 5,
    )).toBe(true);
    expect(OBJECTIVES.every(
      (objective) => objective.completion.kind === 'lose-wanted'
        || objective.initialWantedLevel === undefined,
    )).toBe(true);
  });
});

describe('progression, vehicle, and inventory content', () => {
  it('defines five capped attributes and three complete eight-node skill trees', () => {
    expect(ATTRIBUTES.map((attribute) => attribute.id)).toEqual([
      'grit',
      'aim',
      'handling',
      'nerve',
      'hustle',
    ]);
    expect(ATTRIBUTES.every((attribute) => attribute.minimum === 1 && attribute.maximum === 6)).toBe(true);

    for (const tree of ['combat', 'driving', 'streetcraft']) {
      const nodes = SKILL_NODES.filter((node) => node.tree === tree);
      expect(nodes).toHaveLength(8);
      expect(nodes.filter((node) => node.capstone)).toHaveLength(2);
      expect(nodes.filter((node) => node.tier === 2).every((node) => node.requiredNodesInTree === 2)).toBe(true);
      expect(nodes.filter((node) => node.tier === 3).every((node) => node.requiredNodesInTree === 5)).toBe(true);
    }
  });

  it('defines all eight distinct vehicle classes', () => {
    expect(VEHICLES.map((vehicle) => vehicle.id)).toEqual([
      'compact',
      'sedan',
      'muscle',
      'sports',
      'van',
      'pickup',
      'police-cruiser',
      'motorcycle',
    ]);
    expect(new Set(VEHICLES.map((vehicle) => vehicle.topSpeedKph)).size).toBe(8);
    expect(VEHICLES.find((vehicle) => vehicle.id === 'police-cruiser')?.registerable).toBe(false);
  });

  it('defines three tiers for each of the five weapon classes', () => {
    expect(WEAPONS).toHaveLength(15);
    for (const classId of ['melee', 'pistol', 'smg', 'shotgun', 'rifle']) {
      const weapons = WEAPONS.filter((weapon) => weapon.classId === classId);
      expect(weapons.map((weapon) => weapon.tier)).toEqual([1, 2, 3]);
    }
  });

  it('provides item records for every weapon and all nine utility recipes', () => {
    expect(WEAPONS.every((weapon) => ITEMS.some((item) => item.weaponId === weapon.id))).toBe(true);
    expect(RECIPES).toHaveLength(9);
    expect(RECIPES.map((recipe) => recipe.output.itemId)).toEqual(
      expect.arrayContaining([
        'ammo-handgun',
        'ammo-smg',
        'ammo-rifle',
        'ammo-shotgun',
        'medkit',
        'armor-repair-plate',
        'attachment-suppressor',
        'weapon-repair-kit',
        'vehicle-repair-kit',
      ]),
    );
  });
});

describe('economy, exploration, and radio content', () => {
  it('defines five upgradable properties and five seeded activity types', () => {
    expect(PROPERTIES).toHaveLength(5);
    for (const property of PROPERTIES) {
      expect(property.upgrade.cost).toBe(property.purchasePrice * 0.5);
      expect(property.upgrade.payoutMultiplier).toBe(1.5);
      expect(property.perks.length).toBeGreaterThanOrEqual(2);
    }

    expect(ACTIVITIES).toHaveLength(5);
    for (const activity of ACTIVITIES) {
      expect(activity.difficulties.map((difficulty) => difficulty.id)).toEqual([
        'rookie',
        'professional',
        'legend',
      ]);
      expect(activity.cooldownMinutes).toBeGreaterThan(0);
    }
  });

  it('generates exactly 60 deterministic collectibles in the authored category split', () => {
    expect(COLLECTIBLES).toEqual(generateCollectibles(DEFAULT_COLLECTIBLE_SEED));
    expect(generateCollectibles(101)).toEqual(generateCollectibles(101));
    expect(generateCollectibles(101).map((entry) => entry.position)).not.toEqual(
      generateCollectibles(102).map((entry) => entry.position),
    );
    expect(COLLECTIBLE_SETS.map((set) => [set.category, set.count])).toEqual([
      ['salvage-cache', 30],
      ['stunt-jump', 20],
      ['signal-node', 10],
    ]);
  });

  it('defines three original stations with three procedural tracks apiece', () => {
    expect(RADIO_STATIONS.map((station) => station.name)).toEqual([
      'Coastline FM',
      'Low Tide Radio',
      'Rustwave 88',
    ]);
    expect(RADIO_TRACKS).toHaveLength(9);
    expect(RADIO_STATIONS.every((station) => station.tracks.length === 3)).toBe(true);
    expect(new Set(RADIO_TRACKS.map((track) => track.seed)).size).toBe(9);
  });
});
