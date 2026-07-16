import { COLLECTIBLES, COLLECTIBLE_SETS } from './collectibles';
import { ACTIVITIES, PROPERTIES } from './economy';
import { ITEMS, RECIPES, WEAPONS } from './items';
import { CHECKPOINTS, DIALOGUE, MISSIONS, MISSION_REWARDS, OBJECTIVES } from './missions';
import { ATTRIBUTES, SKILL_NODES } from './progression';
import { RADIO_STATIONS, RADIO_TRACKS } from './radio';
import type {
  ActivityDefinition,
  AttributeDefinition,
  CheckpointDefinition,
  CollectibleDefinition,
  CollectibleSetDefinition,
  DialogueEntry,
  ItemDefinition,
  MissionDefinition,
  MissionReward,
  ObjectiveDefinition,
  PropertyDefinition,
  RadioStationDefinition,
  RadioTrackDefinition,
  RecipeDefinition,
  SkillNodeDefinition,
  VehicleDefinition,
  WeaponDefinition,
} from './types';
import { VEHICLES } from './vehicles';

export interface DataRegistry<T> {
  readonly name: string;
  readonly values: readonly T[];
  readonly ids: readonly string[];
  readonly size: number;
  readonly get: (id: string) => T | undefined;
  readonly has: (id: string) => boolean;
  readonly require: (id: string) => T;
}

export interface RegistryValidationIssue {
  readonly registry: string;
  readonly path: string;
  readonly message: string;
}

export function createDataRegistry<T>(
  name: string,
  source: readonly T[],
  keyOf: (value: T) => string,
): DataRegistry<T> {
  const values = Object.freeze([...source]);
  const byId = new Map<string, T>();
  for (const value of values) {
    byId.set(keyOf(value), value);
  }
  const ids = Object.freeze([...byId.keys()]);

  return Object.freeze({
    name,
    values,
    ids,
    size: values.length,
    get: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
    require: (id: string) => {
      const value = byId.get(id);
      if (value === undefined) {
        throw new Error(`Unknown ${name} id: ${id}`);
      }
      return value;
    },
  });
}

const idOf = <T extends { readonly id: string }>(value: T): string => value.id;

export const missionRegistry = createDataRegistry<MissionDefinition>('mission', MISSIONS, idOf);
export const objectiveRegistry = createDataRegistry<ObjectiveDefinition>('objective', OBJECTIVES, idOf);
export const checkpointRegistry = createDataRegistry<CheckpointDefinition>('checkpoint', CHECKPOINTS, idOf);
export const missionRewardRegistry = createDataRegistry<MissionReward>('mission reward', MISSION_REWARDS, idOf);
export const dialogueRegistry = createDataRegistry<DialogueEntry>('dialogue', DIALOGUE, (entry) => entry.key);
export const attributeRegistry = createDataRegistry<AttributeDefinition>('attribute', ATTRIBUTES, idOf);
export const skillRegistry = createDataRegistry<SkillNodeDefinition>('skill', SKILL_NODES, idOf);
export const vehicleRegistry = createDataRegistry<VehicleDefinition>('vehicle', VEHICLES, idOf);
export const weaponRegistry = createDataRegistry<WeaponDefinition>('weapon', WEAPONS, idOf);
export const itemRegistry = createDataRegistry<ItemDefinition>('item', ITEMS, idOf);
export const recipeRegistry = createDataRegistry<RecipeDefinition>('recipe', RECIPES, idOf);
export const propertyRegistry = createDataRegistry<PropertyDefinition>('property', PROPERTIES, idOf);
export const activityRegistry = createDataRegistry<ActivityDefinition>('activity', ACTIVITIES, idOf);
export const collectibleRegistry = createDataRegistry<CollectibleDefinition>('collectible', COLLECTIBLES, idOf);
export const collectibleSetRegistry = createDataRegistry<CollectibleSetDefinition>(
  'collectible set',
  COLLECTIBLE_SETS,
  (definition) => definition.category,
);
export const radioStationRegistry = createDataRegistry<RadioStationDefinition>('radio station', RADIO_STATIONS, idOf);
export const radioTrackRegistry = createDataRegistry<RadioTrackDefinition>('radio track', RADIO_TRACKS, idOf);

export const DATA_REGISTRIES = Object.freeze({
  missions: missionRegistry,
  objectives: objectiveRegistry,
  checkpoints: checkpointRegistry,
  missionRewards: missionRewardRegistry,
  dialogue: dialogueRegistry,
  attributes: attributeRegistry,
  skills: skillRegistry,
  vehicles: vehicleRegistry,
  weapons: weaponRegistry,
  items: itemRegistry,
  recipes: recipeRegistry,
  properties: propertyRegistry,
  activities: activityRegistry,
  collectibles: collectibleRegistry,
  collectibleSets: collectibleSetRegistry,
  radioStations: radioStationRegistry,
  radioTracks: radioTrackRegistry,
});

export const getMission = missionRegistry.get;
export const requireMission = missionRegistry.require;
export const getObjective = objectiveRegistry.get;
export const requireObjective = objectiveRegistry.require;
export const getCheckpoint = checkpointRegistry.get;
export const requireCheckpoint = checkpointRegistry.require;
export const getMissionReward = missionRewardRegistry.get;
export const requireMissionReward = missionRewardRegistry.require;
export const getDialogue = dialogueRegistry.get;
export const requireDialogue = dialogueRegistry.require;
export const getAttribute = attributeRegistry.get;
export const requireAttribute = attributeRegistry.require;
export const getSkill = skillRegistry.get;
export const requireSkill = skillRegistry.require;
export const getVehicle = vehicleRegistry.get;
export const requireVehicle = vehicleRegistry.require;
export const getWeapon = weaponRegistry.get;
export const requireWeapon = weaponRegistry.require;
export const getItem = itemRegistry.get;
export const requireItem = itemRegistry.require;
export const getRecipe = recipeRegistry.get;
export const requireRecipe = recipeRegistry.require;
export const getProperty = propertyRegistry.get;
export const requireProperty = propertyRegistry.require;
export const getActivity = activityRegistry.get;
export const requireActivity = activityRegistry.require;
export const getCollectible = collectibleRegistry.get;
export const requireCollectible = collectibleRegistry.require;
export const getCollectibleSet = collectibleSetRegistry.get;
export const requireCollectibleSet = collectibleSetRegistry.require;
export const getRadioStation = radioStationRegistry.get;
export const requireRadioStation = radioStationRegistry.require;
export const getRadioTrack = radioTrackRegistry.get;
export const requireRadioTrack = radioTrackRegistry.require;

function addIssue(
  issues: RegistryValidationIssue[],
  registry: string,
  path: string,
  message: string,
): void {
  issues.push({ registry, path, message });
}

function validateUniqueKeys<T>(
  issues: RegistryValidationIssue[],
  registry: string,
  values: readonly T[],
  keyOf: (value: T) => string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    if (key.length === 0) {
      addIssue(issues, registry, `[${index}]`, 'Registry key cannot be empty.');
    } else if (seen.has(key)) {
      addIssue(issues, registry, `[${index}]`, `Duplicate key: ${key}`);
    }
    seen.add(key);
  });
}

function validateCount(
  issues: RegistryValidationIssue[],
  registry: string,
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    addIssue(issues, registry, 'length', `Expected ${expected} entries, received ${actual}.`);
  }
}

function validateMissionDependencies(issues: RegistryValidationIssue[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (mission: MissionDefinition): void => {
    if (visited.has(mission.id)) {
      return;
    }
    if (visiting.has(mission.id)) {
      addIssue(issues, 'missions', mission.id, 'Mission prerequisite graph contains a cycle.');
      return;
    }

    visiting.add(mission.id);
    for (const prerequisiteId of mission.prerequisites) {
      const prerequisite = missionRegistry.get(prerequisiteId);
      if (prerequisite === undefined) {
        addIssue(issues, 'missions', `${mission.id}.prerequisites`, `Unknown mission: ${prerequisiteId}`);
      } else {
        visit(prerequisite);
      }
    }
    visiting.delete(mission.id);
    visited.add(mission.id);
  };

  MISSIONS.forEach(visit);
}

function validateMissionContent(issues: RegistryValidationIssue[]): void {
  MISSIONS.forEach((mission) => {
    const prefix = `${mission.id}:`;
    const localObjectiveIds = new Set(mission.objectives.map((objective) => objective.id));
    const reachable = new Set<string>();
    const pending = mission.objectives[0] === undefined ? [] : [mission.objectives[0].id];

    if (mission.objectives.length === 0) {
      addIssue(issues, 'missions', `${mission.id}.objectives`, 'Mission must define at least one objective.');
    }

    for (const objective of mission.objectives) {
      if (!objective.id.startsWith(prefix)) {
        addIssue(issues, 'missions', `${mission.id}.objectives`, `Objective ${objective.id} must use the mission prefix.`);
      }
      if (objective.targetIds.length === 0) {
        addIssue(issues, 'missions', objective.id, 'Objective must define at least one target.');
      }
      for (const nextId of objective.nextObjectiveIds) {
        if (!localObjectiveIds.has(nextId)) {
          addIssue(issues, 'missions', `${objective.id}.nextObjectiveIds`, `Unknown objective: ${nextId}`);
        }
      }
      if (
        objective.fallback.objectiveId !== undefined &&
        !localObjectiveIds.has(objective.fallback.objectiveId)
      ) {
        addIssue(
          issues,
          'missions',
          `${objective.id}.fallback`,
          `Unknown fallback objective: ${objective.fallback.objectiveId}`,
        );
      }
      if (
        objective.fallback.mode === 'alternate-objective' &&
        objective.fallback.objectiveId === undefined
      ) {
        addIssue(issues, 'missions', `${objective.id}.fallback`, 'Alternate fallback requires an objective id.');
      }
      if (objective.completion.kind === 'composite') {
        for (const requiredId of objective.completion.requiredObjectiveIds) {
          if (!localObjectiveIds.has(requiredId)) {
            addIssue(issues, 'missions', `${objective.id}.completion`, `Unknown objective: ${requiredId}`);
          }
        }
      }
      if (objective.completion.kind === 'lose-wanted') {
        if (objective.initialWantedLevel === undefined) {
          addIssue(
            issues,
            'missions',
            `${objective.id}.initialWantedLevel`,
            'Lose-wanted objective requires an initial wanted level.',
          );
        } else if (
          !Number.isSafeInteger(objective.initialWantedLevel)
          || objective.initialWantedLevel < 1
          || objective.initialWantedLevel > 5
        ) {
          addIssue(
            issues,
            'missions',
            `${objective.id}.initialWantedLevel`,
            'Initial wanted level must be a safe integer from 1 through 5.',
          );
        }
      } else if (objective.initialWantedLevel !== undefined) {
        addIssue(
          issues,
          'missions',
          `${objective.id}.initialWantedLevel`,
          'Only lose-wanted objectives may define an initial wanted level.',
        );
      }
      if (objective.activation !== undefined) {
        const choiceObjective = mission.objectives.find(
          (candidate) => candidate.id === objective.activation?.choiceObjectiveId,
        );
        if (choiceObjective?.completion.kind !== 'choice-made') {
          addIssue(issues, 'missions', `${objective.id}.activation`, 'Activation must reference a choice objective.');
        } else if (!choiceObjective.completion.choices.includes(objective.activation.choice)) {
          addIssue(issues, 'missions', `${objective.id}.activation`, `Unknown choice: ${objective.activation.choice}`);
        }
      }
    }

    while (pending.length > 0) {
      const currentId = pending.pop();
      if (currentId === undefined || reachable.has(currentId)) {
        continue;
      }
      reachable.add(currentId);
      const current = mission.objectives.find((objective) => objective.id === currentId);
      if (current !== undefined) {
        pending.push(...current.nextObjectiveIds);
        if (current.fallback.objectiveId !== undefined) {
          pending.push(current.fallback.objectiveId);
        }
      }
    }
    for (const objective of mission.objectives) {
      if (!reachable.has(objective.id)) {
        addIssue(issues, 'missions', objective.id, 'Objective is unreachable from the mission start.');
      }
    }

    if (mission.checkpoints.length === 0 || mission.checkpoints[0]?.afterObjectiveId !== null) {
      addIssue(issues, 'missions', `${mission.id}.checkpoints`, 'Mission must begin with an initial checkpoint.');
    }
    for (const missionCheckpoint of mission.checkpoints) {
      if (
        missionCheckpoint.afterObjectiveId !== null &&
        !localObjectiveIds.has(missionCheckpoint.afterObjectiveId)
      ) {
        addIssue(
          issues,
          'missions',
          `${missionCheckpoint.id}.afterObjectiveId`,
          `Unknown objective: ${missionCheckpoint.afterObjectiveId}`,
        );
      }
      if (
        !Number.isFinite(missionCheckpoint.respawn.x) ||
        !Number.isFinite(missionCheckpoint.respawn.y) ||
        !Number.isFinite(missionCheckpoint.respawn.z)
      ) {
        addIssue(issues, 'missions', `${missionCheckpoint.id}.respawn`, 'Checkpoint coordinates must be finite.');
      }
    }

    const missionItemIds = new Set<string>();
    for (const item of mission.missionItems ?? []) {
      const path = `${mission.id}.missionItems`;
      if (!itemRegistry.has(item.itemId)) {
        addIssue(issues, 'missions', path, `Unknown item: ${item.itemId}`);
      }
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        addIssue(issues, 'missions', path, 'Mission item quantities must be positive safe integers.');
      }
      if (missionItemIds.has(item.itemId)) {
        addIssue(issues, 'missions', path, `Duplicate mission item: ${item.itemId}`);
      }
      missionItemIds.add(item.itemId);
    }

    for (const dialogueKey of mission.dialogueKeys) {
      const entry = dialogueRegistry.get(dialogueKey);
      if (entry === undefined) {
        addIssue(issues, 'missions', `${mission.id}.dialogueKeys`, `Unknown dialogue key: ${dialogueKey}`);
      } else if (entry.missionId !== mission.id) {
        addIssue(issues, 'missions', `${mission.id}.dialogueKeys`, `${dialogueKey} belongs to ${entry.missionId}.`);
      }
    }
    for (const item of mission.rewards.items) {
      if (!itemRegistry.has(item.itemId)) {
        addIssue(issues, 'missions', `${mission.id}.rewards.items`, `Unknown item: ${item.itemId}`);
      }
      if (item.quantity <= 0) {
        addIssue(issues, 'missions', `${mission.id}.rewards.items`, 'Reward quantities must be positive.');
      }
    }
    if (mission.rewards.id !== `${mission.id}:reward`) {
      addIssue(issues, 'missions', `${mission.id}.rewards.id`, 'Mission reward id must use the mission prefix.');
    }
    if (mission.id === 'freehold') {
      const choices = mission.branchRewards?.map((reward) => reward.choice) ?? [];
      if (
        choices.length !== 2 ||
        !choices.includes('rule') ||
        !choices.includes('expose')
      ) {
        addIssue(issues, 'missions', 'freehold.branchRewards', 'Finale requires Rule and Expose branch rewards.');
      }
    } else if (mission.branchRewards !== undefined) {
      addIssue(issues, 'missions', `${mission.id}.branchRewards`, 'Only the finale may define ending rewards.');
    }
  });

  const usedDialogue = new Set(MISSIONS.flatMap((mission) => mission.dialogueKeys));
  for (const entry of DIALOGUE) {
    if (!usedDialogue.has(entry.key)) {
      addIssue(issues, 'dialogue', entry.key, 'Dialogue entry is not referenced by its mission.');
    }
  }

  const prologue = missionRegistry.get('past-due');
  if (prologue?.prerequisites.length !== 0) {
    addIssue(issues, 'missions', 'past-due.prerequisites', 'The prologue cannot have prerequisites.');
  }
  const convergence = missionRegistry.get('full-account');
  if (convergence?.prerequisites.length !== 9) {
    addIssue(issues, 'missions', 'full-account.prerequisites', 'Convergence must require all nine contact jobs.');
  }
  const finale = missionRegistry.get('freehold');
  if (finale?.prerequisites.length !== 1 || finale.prerequisites[0] !== 'full-account') {
    addIssue(issues, 'missions', 'freehold.prerequisites', 'The finale must require Full Account.');
  }
}

function validateProgression(issues: RegistryValidationIssue[]): void {
  const expectedAttributes = new Set(['grit', 'aim', 'handling', 'nerve', 'hustle']);
  for (const attribute of ATTRIBUTES) {
    expectedAttributes.delete(attribute.id);
    if (attribute.minimum !== 1 || attribute.maximum !== 6) {
      addIssue(issues, 'attributes', attribute.id, 'Attributes must range from 1 to 6.');
    }
    if (attribute.effectsPerAddedPoint.length === 0) {
      addIssue(issues, 'attributes', attribute.id, 'Attribute must define at least one effect.');
    }
  }
  if (expectedAttributes.size > 0) {
    addIssue(issues, 'attributes', 'ids', `Missing attributes: ${[...expectedAttributes].join(', ')}`);
  }

  for (const tree of ['combat', 'driving', 'streetcraft'] as const) {
    const nodes = SKILL_NODES.filter((node) => node.tree === tree);
    const capstones = nodes.filter((node) => node.capstone);
    if (nodes.length !== 8) {
      addIssue(issues, 'skills', tree, `Expected 8 nodes, received ${nodes.length}.`);
    }
    if (capstones.length !== 2) {
      addIssue(issues, 'skills', tree, `Expected 2 capstones, received ${capstones.length}.`);
    }
  }

  for (const node of SKILL_NODES) {
    const expectedRequirement = node.tier === 1 ? 0 : node.tier === 2 ? 2 : 5;
    if (node.requiredNodesInTree !== expectedRequirement) {
      addIssue(issues, 'skills', node.id, `Tier ${node.tier} requires ${expectedRequirement} prior nodes.`);
    }
    if (node.capstone !== (node.tier === 3)) {
      addIssue(issues, 'skills', node.id, 'Only tier-three nodes may be capstones.');
    }
    if (node.capstone) {
      const exclusive = node.exclusiveWith === null ? undefined : skillRegistry.get(node.exclusiveWith);
      if (exclusive === undefined || exclusive.exclusiveWith !== node.id || exclusive.tree !== node.tree) {
        addIssue(issues, 'skills', node.id, 'Capstone exclusivity must be mutual within one tree.');
      }
    } else if (node.exclusiveWith !== null) {
      addIssue(issues, 'skills', node.id, 'Regular skill nodes cannot be mutually exclusive.');
    }
  }
}

function validateVehiclesAndWeapons(issues: RegistryValidationIssue[]): void {
  const handlingSignatures = new Set<string>();
  for (const vehicle of VEHICLES) {
    if (
      vehicle.accelerationMetersPerSecondSquared <= 0 ||
      vehicle.topSpeedKph <= 0 ||
      vehicle.massKg <= 0 ||
      vehicle.durability <= 0
    ) {
      addIssue(issues, 'vehicles', vehicle.id, 'Vehicle performance values must be positive.');
    }
    if (vehicle.grip <= 0 || vehicle.grip > 1 || vehicle.turnResponse <= 0 || vehicle.turnResponse > 1) {
      addIssue(issues, 'vehicles', vehicle.id, 'Grip and turn response must be in the range (0, 1].');
    }
    const handling = vehicle.arcadeHandling;
    if (
      handling.reverseSpeedKph <= 0
      || handling.reverseSpeedKph >= vehicle.topSpeedKph
      || handling.brakeDecelerationMetersPerSecondSquared <= 0
      || handling.handbrakeDecelerationMetersPerSecondSquared <= 0
      || handling.steeringResponsePerSecond <= 0
      || handling.turnRateRadiansPerSecond <= 0
      || handling.handbrakeTurnMultiplier <= 0
      || handling.collisionRadiusMeters <= 0
      || handling.collisionWidthMeters <= 0
      || handling.collisionLengthMeters <= 0
      || handling.wheelbaseMeters <= 0
      || handling.trackWidthMeters <= 0
      || handling.rideHeightMeters <= 0
      || handling.suspensionTravelMeters <= 0
    ) {
      addIssue(issues, 'vehicles', `${vehicle.id}.arcadeHandling`, 'Arcade handling values must be positive and reverse speed must be below top speed.');
    }
    if (handling.highSpeedSteeringFactor <= 0 || handling.highSpeedSteeringFactor > 1) {
      addIssue(issues, 'vehicles', `${vehicle.id}.arcadeHandling.highSpeedSteeringFactor`, 'High-speed steering must be in the range (0, 1].');
    }
    if (
      handling.wheelbaseMeters > handling.collisionLengthMeters
      || handling.trackWidthMeters > handling.collisionWidthMeters
    ) {
      addIssue(issues, 'vehicles', `${vehicle.id}.arcadeHandling`, 'Wheel contacts must fit inside the collision box.');
    }
    const handlingSignature = JSON.stringify(handling);
    if (handlingSignatures.has(handlingSignature)) {
      addIssue(issues, 'vehicles', `${vehicle.id}.arcadeHandling`, 'Every vehicle class must have a distinct arcade handling profile.');
    }
    handlingSignatures.add(handlingSignature);
    if (vehicle.id === 'police-cruiser' && (vehicle.registerable || vehicle.baseValue !== 0)) {
      addIssue(issues, 'vehicles', vehicle.id, 'Police cruisers cannot be registered or sold.');
    }
  }

  for (const classId of ['melee', 'pistol', 'smg', 'shotgun', 'rifle'] as const) {
    const definitions = WEAPONS.filter((weapon) => weapon.classId === classId);
    if (definitions.length !== 3 || ![1, 2, 3].every((tier) => definitions.some((weapon) => weapon.tier === tier))) {
      addIssue(issues, 'weapons', classId, 'Each weapon class must define exactly tiers 1, 2, and 3.');
    }
  }
  for (const weapon of WEAPONS) {
    if (weapon.damage <= 0 || weapon.durability <= 0 || weapon.durability > 100 || weapon.value < 0) {
      addIssue(issues, 'weapons', weapon.id, 'Weapon values are outside supported ranges.');
    }
    if (weapon.classId === 'melee') {
      if (weapon.ammoCaliber !== null || weapon.capacity !== 0) {
        addIssue(issues, 'weapons', weapon.id, 'Melee definitions cannot use ammunition.');
      }
    } else if (weapon.ammoCaliber === null || weapon.capacity <= 0) {
      addIssue(issues, 'weapons', weapon.id, 'Firearm definitions require ammunition and capacity.');
    }
  }
}

function validateItemsAndRecipes(issues: RegistryValidationIssue[]): void {
  for (const item of ITEMS) {
    if (item.shape.width <= 0 || item.shape.height <= 0 || item.shape.width > 8 || item.shape.height > 6) {
      addIssue(issues, 'items', item.id, 'Item shape must fit within the 8x6 backpack.');
    }
    if (item.weightKg < 0 || item.maximumStack <= 0 || item.baseValue < 0) {
      addIssue(issues, 'items', item.id, 'Item weight, stack, or value is outside its supported range.');
    }
    if (item.category === 'weapon' && (item.weaponId === undefined || !weaponRegistry.has(item.weaponId))) {
      addIssue(issues, 'items', item.id, 'Weapon item must reference a weapon definition.');
    }
    if (item.category === 'quest' && (item.weightKg !== 0 || item.discardable)) {
      addIssue(issues, 'items', item.id, 'Quest items must be weightless and non-discardable.');
    }
  }

  for (const weapon of WEAPONS) {
    const item = itemRegistry.get(weapon.id);
    if (item?.weaponId !== weapon.id) {
      addIssue(issues, 'weapons', weapon.id, 'Every weapon must have a matching inventory item.');
    }
  }

  for (const recipe of RECIPES) {
    if (recipe.ingredients.length === 0 || recipe.craftSeconds <= 0) {
      addIssue(issues, 'recipes', recipe.id, 'Recipe requires ingredients and a positive craft time.');
    }
    for (const ingredient of recipe.ingredients) {
      if (!itemRegistry.has(ingredient.itemId)) {
        addIssue(issues, 'recipes', `${recipe.id}.ingredients`, `Unknown item: ${ingredient.itemId}`);
      }
      if (ingredient.quantity <= 0) {
        addIssue(issues, 'recipes', `${recipe.id}.ingredients`, 'Ingredient quantities must be positive.');
      }
    }
    const output = itemRegistry.get(recipe.output.itemId);
    if (output === undefined) {
      addIssue(issues, 'recipes', `${recipe.id}.output`, `Unknown item: ${recipe.output.itemId}`);
    } else if (output.category === 'weapon' || output.category === 'armor') {
      addIssue(issues, 'recipes', `${recipe.id}.output`, 'Complete weapons and armor cannot be crafted.');
    } else if (recipe.output.quantity <= 0 || recipe.output.quantity > output.maximumStack) {
      addIssue(issues, 'recipes', `${recipe.id}.output`, 'Output quantity must fit one valid item stack.');
    }
  }
}

function validateEconomy(issues: RegistryValidationIssue[]): void {
  for (const property of PROPERTIES) {
    if (property.purchasePrice <= 0 || property.basePayout <= 0) {
      addIssue(issues, 'properties', property.id, 'Property prices and payouts must be positive.');
    }
    if (property.upgrade.cost !== property.purchasePrice * 0.5) {
      addIssue(issues, 'properties', property.id, 'Property upgrade must cost 50% of purchase price.');
    }
    if (property.payoutCap !== 3 || property.upgrade.payoutMultiplier !== 1.5 || property.upgrade.perkMultiplier !== 1.5) {
      addIssue(issues, 'properties', property.id, 'Property cap and upgrade multipliers do not match the design.');
    }
    if (property.perks.length < 2) {
      addIssue(issues, 'properties', property.id, 'Property must encode both authored perk effects.');
    }
  }

  const variantSeedSalts = new Set<number>();
  for (const activity of ACTIVITIES) {
    if (
      !Number.isSafeInteger(activity.baseCash) || activity.baseCash <= 0
      || !Number.isSafeInteger(activity.baseXp) || activity.baseXp <= 0
      || !Number.isSafeInteger(activity.cooldownMinutes) || activity.cooldownMinutes <= 0
    ) {
      addIssue(issues, 'activities', activity.id, 'Activity rewards and cooldown must be positive.');
    }
    if (activity.unlockFlag !== `activity-${activity.id}`) {
      addIssue(issues, 'activities', `${activity.id}.unlockFlag`, 'Activity unlock flag must match its id.');
    }
    if (!Number.isSafeInteger(activity.variantSeedSalt) || activity.variantSeedSalt <= 0) {
      addIssue(issues, 'activities', `${activity.id}.variantSeedSalt`, 'Variant seed salt must be a positive safe integer.');
    } else if (variantSeedSalts.has(activity.variantSeedSalt)) {
      addIssue(issues, 'activities', `${activity.id}.variantSeedSalt`, 'Variant seed salts must be unique.');
    }
    variantSeedSalts.add(activity.variantSeedSalt);
    if (!Number.isSafeInteger(activity.variantCount) || activity.variantCount < 2) {
      addIssue(issues, 'activities', `${activity.id}.variantCount`, 'Activity must expose at least two seeded variants.');
    }
    if (activity.districts.length === 0 || new Set(activity.districts).size !== activity.districts.length) {
      addIssue(issues, 'activities', `${activity.id}.districts`, 'Activity districts must be non-empty and unique.');
    }
    if (activity.objectiveTemplate.length === 0) {
      addIssue(issues, 'activities', `${activity.id}.objectiveTemplate`, 'Activity objective template cannot be empty.');
    }
    const difficulties = new Set<string>(activity.difficulties.map((difficulty) => difficulty.id));
    if (
      activity.difficulties.length !== 3 ||
      !['rookie', 'professional', 'legend'].every((id) => difficulties.has(id))
    ) {
      addIssue(issues, 'activities', activity.id, 'Activity must define all three difficulty bands.');
    }
    let previousLevel = 0;
    let previousReward = 0;
    let previousTarget = 0;
    for (const difficulty of activity.difficulties) {
      if (
        !Number.isSafeInteger(difficulty.levelRequirement)
        || difficulty.levelRequirement <= previousLevel
        || !Number.isFinite(difficulty.rewardMultiplier)
        || difficulty.rewardMultiplier <= previousReward
        || !Number.isFinite(difficulty.targetMultiplier)
        || difficulty.targetMultiplier <= previousTarget
      ) {
        addIssue(issues, 'activities', `${activity.id}.${difficulty.id}`, 'Difficulty requirements and multipliers must increase by band.');
      }
      previousLevel = difficulty.levelRequirement;
      previousReward = difficulty.rewardMultiplier;
      previousTarget = difficulty.targetMultiplier;
    }
  }
}

function validateCollectibles(issues: RegistryValidationIssue[]): void {
  const expectedRules = {
    'salvage-cache': 'nearby',
    'stunt-jump': 'road-survey',
    'signal-node': 'signal-scan',
  } as const;
  if (COLLECTIBLE_SETS.length !== 3 || new Set(COLLECTIBLE_SETS.map((set) => set.category)).size !== 3) {
    addIssue(issues, 'collectibleSets', 'catalog', 'Expected one unique completion set per collectible category.');
  }
  for (const set of COLLECTIBLE_SETS) {
    const definitions = COLLECTIBLES.filter((collectible) => collectible.category === set.category);
    if (definitions.length !== set.count) {
      addIssue(issues, 'collectibles', set.category, `Expected ${set.count}, received ${definitions.length}.`);
    }
    definitions.forEach((definition, index) => {
      if (definition.ordinal !== index + 1) {
        addIssue(issues, 'collectibles', definition.id, 'Category ordinals must be consecutive.');
      }
    });
    if (
      !Number.isSafeInteger(set.completionReward.xp) || set.completionReward.xp <= 0
      || !Number.isSafeInteger(set.completionReward.cash) || set.completionReward.cash <= 0
      || set.completionReward.unlockFlag.length === 0
    ) {
      addIssue(issues, 'collectibleSets', set.category, 'Completion rewards and unlock flag must be populated.');
    }
  }
  for (const collectible of COLLECTIBLES) {
    if (collectible.position.district !== collectible.district) {
      addIssue(issues, 'collectibles', collectible.id, 'Position and collectible districts must match.');
    }
    if (!Number.isFinite(collectible.position.x) || !Number.isFinite(collectible.position.z)) {
      addIssue(issues, 'collectibles', collectible.id, 'Collectible position must be finite.');
    }
    if (collectible.revealRule !== expectedRules[collectible.category]) {
      addIssue(issues, 'collectibles', `${collectible.id}.revealRule`, 'Reveal rule does not match the collectible category.');
    }
    if (
      !Number.isSafeInteger(collectible.reward.xp) || collectible.reward.xp <= 0
      || !Number.isSafeInteger(collectible.reward.cash) || collectible.reward.cash < 0
    ) {
      addIssue(issues, 'collectibles', `${collectible.id}.reward`, 'Collectible cash and XP rewards must be safe non-negative values.');
    }
    for (const item of collectible.reward.items) {
      if (!itemRegistry.has(item.itemId)) {
        addIssue(issues, 'collectibles', `${collectible.id}.reward`, `Unknown item: ${item.itemId}`);
      }
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        addIssue(issues, 'collectibles', `${collectible.id}.reward`, 'Item reward quantity must be a positive safe integer.');
      }
    }
  }
}

function validateRadio(issues: RegistryValidationIssue[]): void {
  for (const station of RADIO_STATIONS) {
    if (station.tracks.length !== 3) {
      addIssue(issues, 'radioStations', station.id, `Expected 3 tracks, received ${station.tracks.length}.`);
    }
    for (const track of station.tracks) {
      if (track.bpm < 60 || track.bpm > 200 || track.durationSeconds <= 0 || track.layers.length === 0) {
        addIssue(issues, 'radioTracks', track.id, 'Track synthesis values are outside supported ranges.');
      }
    }
  }
}

export function validateDataRegistries(): readonly RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];

  validateCount(issues, 'missions', MISSIONS.length, 12);
  validateCount(issues, 'missionRewards', MISSION_REWARDS.length, 12);
  validateCount(issues, 'attributes', ATTRIBUTES.length, 5);
  validateCount(issues, 'skills', SKILL_NODES.length, 24);
  validateCount(issues, 'vehicles', VEHICLES.length, 8);
  validateCount(issues, 'weapons', WEAPONS.length, 15);
  validateCount(issues, 'properties', PROPERTIES.length, 5);
  validateCount(issues, 'activities', ACTIVITIES.length, 5);
  validateCount(issues, 'collectibles', COLLECTIBLES.length, 60);
  validateCount(issues, 'collectibleSets', COLLECTIBLE_SETS.length, 3);
  validateCount(issues, 'radioStations', RADIO_STATIONS.length, 3);
  validateCount(issues, 'radioTracks', RADIO_TRACKS.length, 9);

  validateUniqueKeys(issues, 'missions', MISSIONS, idOf);
  validateUniqueKeys(issues, 'missionRewards', MISSION_REWARDS, idOf);
  validateUniqueKeys(issues, 'objectives', OBJECTIVES, idOf);
  validateUniqueKeys(issues, 'checkpoints', CHECKPOINTS, idOf);
  validateUniqueKeys(issues, 'dialogue', DIALOGUE, (entry) => entry.key);
  validateUniqueKeys(issues, 'attributes', ATTRIBUTES, idOf);
  validateUniqueKeys(issues, 'skills', SKILL_NODES, idOf);
  validateUniqueKeys(issues, 'vehicles', VEHICLES, idOf);
  validateUniqueKeys(issues, 'weapons', WEAPONS, idOf);
  validateUniqueKeys(issues, 'items', ITEMS, idOf);
  validateUniqueKeys(issues, 'recipes', RECIPES, idOf);
  validateUniqueKeys(issues, 'properties', PROPERTIES, idOf);
  validateUniqueKeys(issues, 'activities', ACTIVITIES, idOf);
  validateUniqueKeys(issues, 'collectibles', COLLECTIBLES, idOf);
  validateUniqueKeys(issues, 'collectibleSets', COLLECTIBLE_SETS, (definition) => definition.category);
  validateUniqueKeys(issues, 'radioStations', RADIO_STATIONS, idOf);
  validateUniqueKeys(issues, 'radioTracks', RADIO_TRACKS, idOf);

  MISSIONS.forEach((mission, index) => {
    if (mission.number !== index + 1) {
      addIssue(issues, 'missions', mission.id, `Expected mission number ${index + 1}, received ${mission.number}.`);
    }
  });

  validateMissionDependencies(issues);
  validateMissionContent(issues);
  validateProgression(issues);
  validateVehiclesAndWeapons(issues);
  validateItemsAndRecipes(issues);
  validateEconomy(issues);
  validateCollectibles(issues);
  validateRadio(issues);

  return issues;
}

export const validateRegistries = validateDataRegistries;

export function assertDataRegistriesValid(): void {
  const issues = validateDataRegistries();
  if (issues.length === 0) {
    return;
  }
  const details = issues
    .map((issue) => `[${issue.registry}] ${issue.path}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid HEATLINE data registries:\n${details}`);
}

export const assertValidRegistries = assertDataRegistriesValid;
