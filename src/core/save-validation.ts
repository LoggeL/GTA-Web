import {
  SAVE_GAME_VERSION,
  type DistrictId,
  type SaveGameV1,
  type SavedActivity,
  type SavedInventory,
  type SavedItemInstance,
  type SavedMissionProgress,
  type SavedProperty,
  type SavedVehicle,
  type TransformState,
} from './state';

export interface SaveValidationRegistry {
  itemIds?: ReadonlySet<string>;
  skillIds?: ReadonlySet<string>;
  vehicleIds?: ReadonlySet<string>;
  missionIds?: ReadonlySet<string>;
  propertyIds?: ReadonlySet<string>;
  activityIds?: ReadonlySet<string>;
  collectibleIds?: ReadonlySet<string>;
  recipeIds?: ReadonlySet<string>;
}

export type SaveValidationResult =
  | { valid: true; save: SaveGameV1; errors: readonly [] }
  | { valid: false; errors: readonly string[] };

export function validateSaveGame(
  value: unknown,
  registry: SaveValidationRegistry = {},
): SaveValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ['save must be an object'] };
  }

  validateLiteral(value.schemaVersion, SAVE_GAME_VERSION, 'schemaVersion', errors);
  validateSlot(value.slot, errors);
  validateOneOf(value.alexPreset, ['masculine', 'feminine'], 'alexPreset', errors);
  validatePlayer(value.player, registry, errors);
  validateInventory(value.inventory, 'inventory', registry, errors);
  validateItemArray(value.stash, 'stash', registry, errors);
  validateRecord(value.trunks, 'trunks', errors, (entry, path) => {
    validateInventory(entry, path, registry, errors);
  });
  validateQuickLoadout(value.quickLoadout, value.inventory, errors);
  validateUniqueStrings(value.unlockedRecipes, 'unlockedRecipes', errors);
  if (Array.isArray(value.unlockedRecipes)) {
    for (const recipeId of value.unlockedRecipes) {
      if (typeof recipeId === 'string') {
        validateRegistryId(recipeId, registry.recipeIds, `unlockedRecipes.${recipeId}`, errors);
      }
    }
  }
  validateVehicleArray(value.ownedVehicles, registry, errors);
  validateMissionRuntimeBoundary(value.missionRuntime, errors);
  validateDialogueRuntimeBoundary(value.dialogueRuntime, errors);
  validateRecord(value.missions, 'missions', errors, (entry, path, id) => {
    validateRegistryId(id, registry.missionIds, path, errors);
    validateMission(entry, path, errors);
  });
  validateNumberRecord(value.contacts, 'contacts', errors, 0, Number.MAX_SAFE_INTEGER);
  if (value.ending !== null) {
    validateOneOf(value.ending, ['rule', 'expose'], 'ending', errors);
  }
  validateWanted(value.wanted, errors);
  validateRecord(value.properties, 'properties', errors, (entry, path, id) => {
    validateRegistryId(id, registry.propertyIds, path, errors);
    validateProperty(entry, path, errors);
  });
  validateRecord(value.activities, 'activities', errors, (entry, path, id) => {
    validateRegistryId(id, registry.activityIds, path, errors);
    validateActivity(entry, path, errors);
  });
  validateCollectibles(value.collectibles, registry, errors);
  validateBooleanRecord(value.worldFlags, 'worldFlags', errors);
  validateNumber(value.playtimeSeconds, 'playtimeSeconds', errors, 0, Number.MAX_SAFE_INTEGER);
  validateInteger(value.trafficSeed, 'trafficSeed', errors, 0, 0xffff_ffff);
  validateDistrict(value.activeDistrict, 'activeDistrict', errors);
  validateNonEmptyString(value.activeCellId, 'activeCellId', errors);
  validateClock(value.clock, errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, save: value as unknown as SaveGameV1, errors: [] };
}

function validateMissionRuntimeBoundary(value: unknown, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    errors.push('missionRuntime must be an object or null');
    return;
  }
  validateLiteral(value.snapshotVersion, 1, 'missionRuntime.snapshotVersion', errors);
  if (!isRecord(value.campaign)) {
    errors.push('missionRuntime.campaign must be an object');
  }
  if (value.active !== null && !isRecord(value.active)) {
    errors.push('missionRuntime.active must be an object or null');
  }
}

function validateDialogueRuntimeBoundary(value: unknown, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    errors.push('dialogueRuntime must be an object or null');
    return;
  }
  if (value.snapshotVersion !== 1 && value.snapshotVersion !== 2) {
    errors.push('dialogueRuntime.snapshotVersion must equal 1 or 2');
  }
}

function validateQuickLoadout(
  value: unknown,
  inventoryValue: unknown,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push('quickLoadout must be an object');
    return;
  }
  validateNullableStringTuple(value.firearms, 'quickLoadout.firearms', errors);
  validateNullableStringTuple(value.consumables, 'quickLoadout.consumables', errors);
  if (value.melee !== null) {
    validateNonEmptyString(value.melee, 'quickLoadout.melee', errors);
  }
  const references = [
    ...(Array.isArray(value.firearms) ? value.firearms : []),
    value.melee,
    ...(Array.isArray(value.consumables) ? value.consumables : []),
  ].filter((entry): entry is string => typeof entry === 'string');
  if (new Set(references).size !== references.length) {
    errors.push('quickLoadout cannot assign an item instance more than once');
  }
  if (isRecord(inventoryValue) && Array.isArray(inventoryValue.items)) {
    const carriedIds = new Set(inventoryValue.items.flatMap((entry) => (
      isRecord(entry) && typeof entry.instanceId === 'string' ? [entry.instanceId] : []
    )));
    for (const reference of references) {
      if (!carriedIds.has(reference)) {
        errors.push(`quickLoadout reference "${reference}" must exist in inventory`);
      }
    }
  }
}

function validateNullableStringTuple(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length !== 2) {
    errors.push(`${path} must contain exactly two entries`);
    return;
  }
  value.forEach((entry, index) => {
    if (entry !== null) {
      validateNonEmptyString(entry, `${path}[${index}]`, errors);
    }
  });
}

function validateWanted(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('wanted must be an object');
    return;
  }
  validateInteger(value.level, 'wanted.level', errors, 0, 5);
  validateOneOf(
    value.phase,
    ['clear', 'investigating', 'pursuit', 'search'],
    'wanted.phase',
    errors,
  );
  validateNumber(value.heat, 'wanted.heat', errors, 0, Number.MAX_SAFE_INTEGER);
  validateNumber(
    value.searchSecondsRemaining,
    'wanted.searchSecondsRemaining',
    errors,
    0,
    10_000,
  );
  if (value.level === 0 && value.phase !== 'clear') {
    errors.push('wanted.phase must be clear at level zero');
  }
  if (typeof value.level === 'number' && value.level > 0 && value.phase === 'clear') {
    errors.push('wanted.phase cannot be clear above level zero');
  }
}

function validateSlot(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('slot must be an object');
    return;
  }
  validateInteger(value.id, 'slot.id', errors, 1, 3);
  validateNonEmptyString(value.label, 'slot.label', errors);
  validateNumber(value.createdAt, 'slot.createdAt', errors, 0, Number.MAX_SAFE_INTEGER);
  validateNumber(value.updatedAt, 'slot.updatedAt', errors, 0, Number.MAX_SAFE_INTEGER);
  if (
    typeof value.createdAt === 'number'
    && typeof value.updatedAt === 'number'
    && value.updatedAt < value.createdAt
  ) {
    errors.push('slot.updatedAt must not precede slot.createdAt');
  }
}

function validatePlayer(
  value: unknown,
  registry: SaveValidationRegistry,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push('player must be an object');
    return;
  }
  validateTransform(value.transform, 'player.transform', errors);
  validateTransform(value.lastSafeTransform, 'player.lastSafeTransform', errors);
  validateNumber(value.health, 'player.health', errors, 0, 1_000);
  validateNumber(value.armor, 'player.armor', errors, 0, 1_000);
  validateInteger(value.money, 'player.money', errors, 0, Number.MAX_SAFE_INTEGER);
  validateInteger(value.level, 'player.level', errors, 1, 20);
  validateInteger(value.xp, 'player.xp', errors, 0, Number.MAX_SAFE_INTEGER);
  validateInteger(value.attributePoints, 'player.attributePoints', errors, 0, 25);
  validateInteger(value.skillPoints, 'player.skillPoints', errors, 0, 24);

  if (!isRecord(value.attributes)) {
    errors.push('player.attributes must be an object');
  } else {
    for (const attribute of ['grit', 'aim', 'handling', 'nerve', 'hustle'] as const) {
      validateInteger(value.attributes[attribute], `player.attributes.${attribute}`, errors, 1, 6);
    }
  }

  if (!Array.isArray(value.unlockedSkills)) {
    errors.push('player.unlockedSkills must be an array');
  } else {
    validateUniqueStrings(value.unlockedSkills, 'player.unlockedSkills', errors);
    for (const skillId of value.unlockedSkills) {
      if (typeof skillId === 'string') {
        validateRegistryId(skillId, registry.skillIds, `player.unlockedSkills.${skillId}`, errors);
      }
    }
  }
}

function validateInventory(
  value: unknown,
  path: string,
  registry: SaveValidationRegistry,
  errors: string[],
): value is SavedInventory {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateInteger(value.gridWidth, `${path}.gridWidth`, errors, 1, 64);
  validateInteger(value.gridHeight, `${path}.gridHeight`, errors, 1, 64);
  validateNumber(value.maxWeightKg, `${path}.maxWeightKg`, errors, 0, 10_000);
  validateItemArray(value.items, `${path}.items`, registry, errors);
  return true;
}

function validateItemArray(
  value: unknown,
  path: string,
  registry: SaveValidationRegistry,
  errors: string[],
): value is SavedItemInstance[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  const instanceIds = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    validateNonEmptyString(entry.instanceId, `${entryPath}.instanceId`, errors);
    if (typeof entry.instanceId === 'string') {
      if (instanceIds.has(entry.instanceId)) {
        errors.push(`${entryPath}.instanceId must be unique within ${path}`);
      }
      instanceIds.add(entry.instanceId);
    }
    validateNonEmptyString(entry.definitionId, `${entryPath}.definitionId`, errors);
    if (typeof entry.definitionId === 'string') {
      validateRegistryId(entry.definitionId, registry.itemIds, entryPath, errors);
    }
    validateInteger(entry.quantity, `${entryPath}.quantity`, errors, 1, Number.MAX_SAFE_INTEGER);
    validateNumber(entry.durability, `${entryPath}.durability`, errors, 0, 100);
    validateInteger(entry.x, `${entryPath}.x`, errors, 0, 63);
    validateInteger(entry.y, `${entryPath}.y`, errors, 0, 63);
    if (typeof entry.rotated !== 'boolean') {
      errors.push(`${entryPath}.rotated must be a boolean`);
    }
  });
  return true;
}

function validateVehicleArray(
  value: unknown,
  registry: SaveValidationRegistry,
  errors: string[],
): value is SavedVehicle[] {
  if (!Array.isArray(value)) {
    errors.push('ownedVehicles must be an array');
    return false;
  }
  if (value.length > 8) {
    errors.push('ownedVehicles cannot contain more than 8 vehicles');
  }
  const instanceIds = new Set<string>();
  value.forEach((entry, index) => {
    const path = `ownedVehicles[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      return;
    }
    validateNonEmptyString(entry.instanceId, `${path}.instanceId`, errors);
    if (typeof entry.instanceId === 'string') {
      if (instanceIds.has(entry.instanceId)) {
        errors.push(`${path}.instanceId must be unique`);
      }
      instanceIds.add(entry.instanceId);
    }
    validateNonEmptyString(entry.definitionId, `${path}.definitionId`, errors);
    if (typeof entry.definitionId === 'string') {
      validateRegistryId(entry.definitionId, registry.vehicleIds, path, errors);
    }
    if (typeof entry.registered !== 'boolean') {
      errors.push(`${path}.registered must be a boolean`);
    }
    validateInteger(entry.garageSlot, `${path}.garageSlot`, errors, 0, 7);
    validateNumber(entry.bodyHealth, `${path}.bodyHealth`, errors, 0, 100);
    validateNumber(entry.engineHealth, `${path}.engineHealth`, errors, 0, 100);
    if (!Array.isArray(entry.tireHealth) || entry.tireHealth.length !== 4) {
      errors.push(`${path}.tireHealth must contain four values`);
    } else {
      entry.tireHealth.forEach((health, tireIndex) => {
        validateNumber(health, `${path}.tireHealth[${tireIndex}]`, errors, 0, 100);
      });
    }
    if (!isRecord(entry.upgrades)) {
      errors.push(`${path}.upgrades must be an object`);
    } else {
      for (const upgrade of ['engine', 'brakes', 'grip', 'armor'] as const) {
        validateInteger(entry.upgrades[upgrade], `${path}.upgrades.${upgrade}`, errors, 0, 3);
      }
      validateNonEmptyString(entry.upgrades.paint, `${path}.upgrades.paint`, errors);
    }
  });
  return true;
}

function validateMission(value: unknown, path: string, errors: string[]): value is SavedMissionProgress {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateOneOf(value.state, ['locked', 'available', 'active', 'complete'], `${path}.state`, errors);
  if (value.checkpointId !== null) {
    validateNonEmptyString(value.checkpointId, `${path}.checkpointId`, errors);
  }
  validateUniqueStrings(value.completedObjectives, `${path}.completedObjectives`, errors);
  return true;
}

function validateProperty(value: unknown, path: string, errors: string[]): value is SavedProperty {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  if (typeof value.owned !== 'boolean') {
    errors.push(`${path}.owned must be a boolean`);
  }
  if (typeof value.upgraded !== 'boolean') {
    errors.push(`${path}.upgraded must be a boolean`);
  }
  validateInteger(value.uncollectedPayouts, `${path}.uncollectedPayouts`, errors, 0, 3);
  return true;
}

function validateActivity(value: unknown, path: string, errors: string[]): value is SavedActivity {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateInteger(value.completions, `${path}.completions`, errors, 0, Number.MAX_SAFE_INTEGER);
  validateNumber(value.cooldownUntil, `${path}.cooldownUntil`, errors, 0, Number.MAX_SAFE_INTEGER);
  validateNullableNumber(value.bestScore, `${path}.bestScore`, errors, 0, Number.MAX_SAFE_INTEGER);
  validateNullableNumber(value.bestTimeSeconds, `${path}.bestTimeSeconds`, errors, 0, Number.MAX_SAFE_INTEGER);
  return true;
}

function validateCollectibles(
  value: unknown,
  registry: SaveValidationRegistry,
  errors: string[],
): void {
  validateRecord(value, 'collectibles', errors, (entry, path) => {
    validateUniqueStrings(entry, path, errors);
    if (Array.isArray(entry)) {
      for (const id of entry) {
        if (typeof id === 'string') {
          validateRegistryId(id, registry.collectibleIds, `${path}.${id}`, errors);
        }
      }
    }
  });
}

function validateClock(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('clock must be an object');
    return;
  }
  validateInteger(value.day, 'clock.day', errors, 1, Number.MAX_SAFE_INTEGER);
  validateNumber(value.timeOfDayMinutes, 'clock.timeOfDayMinutes', errors, 0, 1_440, false);
  validateOneOf(value.weather, ['clear', 'rain'], 'clock.weather', errors);
}

function validateTransform(value: unknown, path: string, errors: string[]): value is TransformState {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateVector(value.position, `${path}.position`, errors);
  validateVector(value.rotation, `${path}.rotation`, errors);
  return true;
}

function validateVector(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    validateNumber(value[axis], `${path}.${axis}`, errors, -1_000_000, 1_000_000);
  }
}

function validateBooleanRecord(value: unknown, path: string, errors: string[]): void {
  validateRecord(value, path, errors, (entry, entryPath) => {
    if (typeof entry !== 'boolean') {
      errors.push(`${entryPath} must be a boolean`);
    }
  });
}

function validateNumberRecord(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): void {
  validateRecord(value, path, errors, (entry, entryPath) => {
    validateNumber(entry, entryPath, errors, min, max);
  });
}

function validateRecord(
  value: unknown,
  path: string,
  errors: string[],
  validateEntry: (entry: unknown, path: string, id: string) => void,
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [id, entry] of Object.entries(value)) {
    if (id.length === 0) {
      errors.push(`${path} keys must not be empty`);
      continue;
    }
    validateEntry(entry, `${path}.${id}`, id);
  }
}

function validateUniqueStrings(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  const found = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    } else if (found.has(entry)) {
      errors.push(`${path}[${index}] must be unique`);
    } else {
      found.add(entry);
    }
  });
}

function validateRegistryId(
  id: string,
  allowed: ReadonlySet<string> | undefined,
  path: string,
  errors: string[],
): void {
  if (allowed && !allowed.has(id)) {
    errors.push(`${path} references unknown registry id "${id}"`);
  }
}

function validateDistrict(value: unknown, path: string, errors: string[]): value is DistrictId {
  return validateOneOf(
    value,
    ['neon-strand', 'alta-vista', 'arroyo-heights', 'breakwater'],
    path,
    errors,
  );
}

function validateLiteral(
  value: unknown,
  expected: string | number,
  path: string,
  errors: string[],
): void {
  if (value !== expected) {
    errors.push(`${path} must equal ${String(expected)}`);
  }
}

function validateOneOf<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  path: string,
  errors: string[],
): value is Value {
  if (typeof value !== 'string' || !choices.includes(value as Value)) {
    errors.push(`${path} must be one of: ${choices.join(', ')}`);
    return false;
  }
  return true;
}

function validateNonEmptyString(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    errors.push(`${path} must be a non-empty string no longer than 256 characters`);
    return false;
  }
  return true;
}

function validateNullableNumber(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): void {
  if (value !== null) {
    validateNumber(value, path, errors, min, max);
  }
}

function validateInteger(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    errors.push(`${path} must be an integer between ${min} and ${max}`);
    return false;
  }
  return true;
}

function validateNumber(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
  inclusiveMax = true,
): value is number {
  const validMax = inclusiveMax
    ? typeof value === 'number' && value <= max
    : typeof value === 'number' && value < max;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || !validMax) {
    const relation = inclusiveMax ? 'and' : 'and less than';
    errors.push(`${path} must be a finite number between ${min} ${relation} ${max}`);
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
