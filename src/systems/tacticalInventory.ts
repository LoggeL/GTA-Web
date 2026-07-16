import type { SaveGameV1, SavedInventory, SavedItemInstance } from '../core/state';
import type { ItemDefinition, RecipeDefinition, WeaponDefinition } from '../data/types';
import {
  addItem,
  autoSortInventory,
  backpackWeightCapacity,
  createBackpack,
  createTacticalVehicleTrunk,
  TACTICAL_TRUNK_GRID_HEIGHT,
  TACTICAL_TRUNK_GRID_WIDTH,
  TACTICAL_TRUNK_WEIGHT_KG,
  transferItem,
  validateInventory,
} from './inventory';
import { createLockedRecipeState, validateRecipeUnlockState, type RecipeUnlockState } from './crafting';

export const TACTICAL_INVENTORY_SNAPSHOT_VERSION = 1 as const;

export type QuickLoadoutSlot =
  | 'firearm-1'
  | 'firearm-2'
  | 'melee'
  | 'consumable-1'
  | 'consumable-2';

export interface QuickLoadout {
  firearms: [string | null, string | null];
  melee: string | null;
  consumables: [string | null, string | null];
}

export interface TacticalInventoryState {
  backpack: SavedInventory;
  /** Abstract, weightless storage: coordinates are canonical rather than spatial. */
  stash: SavedItemInstance[];
  /** Standard tactical trunks; vehicle/skill modifiers can replace this container upstream. */
  trunks: Record<string, SavedInventory>;
  quickLoadout: QuickLoadout;
  recipeUnlocks: RecipeUnlockState;
}

export interface TacticalInventorySnapshotV1 extends TacticalInventoryState {
  schemaVersion: typeof TACTICAL_INVENTORY_SNAPSHOT_VERSION;
}

export type TacticalInventorySaveFields = Pick<
  SaveGameV1,
  'inventory' | 'stash' | 'trunks' | 'quickLoadout' | 'unlockedRecipes'
>;

export type TacticalContainerRef =
  | { kind: 'backpack' }
  | { kind: 'stash' }
  | { kind: 'trunk'; vehicleInstanceId: string };

export interface TacticalTransferRequest {
  source: TacticalContainerRef;
  destination: TacticalContainerRef;
  instanceId: string;
  quantity: number;
  destinationInstanceId: string;
}

export type TacticalInventoryTransactionResult =
  | { success: true; state: TacticalInventoryState }
  | { success: false; state: TacticalInventoryState; reason: string };

export type TacticalInventoryRestoreResult =
  | { success: true; state: TacticalInventoryState }
  | { success: false; errors: readonly string[] };

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createQuickLoadout(): QuickLoadout {
  return { firearms: [null, null], melee: null, consumables: [null, null] };
}

export function createTacticalInventoryState(
  grit: number,
  vehicleInstanceIds: readonly string[] = [],
): TacticalInventoryState {
  const uniqueIds = new Set<string>();
  const trunks: Record<string, SavedInventory> = {};
  for (const vehicleInstanceId of [...vehicleInstanceIds].sort((left, right) => left.localeCompare(right))) {
    assertSafeId(vehicleInstanceId, 'vehicle instance id');
    if (uniqueIds.has(vehicleInstanceId)) throw new Error(`duplicate vehicle instance "${vehicleInstanceId}"`);
    uniqueIds.add(vehicleInstanceId);
    trunks[vehicleInstanceId] = createTacticalVehicleTrunk();
  }
  return {
    backpack: createBackpack(grit),
    stash: [],
    trunks,
    quickLoadout: createQuickLoadout(),
    recipeUnlocks: createLockedRecipeState(),
  };
}

export function validateTacticalInventoryState(
  state: Readonly<TacticalInventoryState>,
  definitions: readonly ItemDefinition[],
  weapons: readonly WeaponDefinition[],
  recipes: readonly RecipeDefinition[],
  grit: number,
): readonly string[] {
  const errors: string[] = [];
  const expectedBackpackWeight = safeBackpackCapacity(grit, errors);
  if (state.backpack.gridWidth !== 8 || state.backpack.gridHeight !== 6) {
    errors.push('backpack must use an 8x6 grid');
  }
  if (expectedBackpackWeight !== null && state.backpack.maxWeightKg !== expectedBackpackWeight) {
    errors.push(`backpack weight capacity must be ${expectedBackpackWeight}kg at Grit ${grit}`);
  }
  errors.push(...validateInventory(state.backpack, definitions).map((error) => `backpack: ${error}`));
  errors.push(...validateAbstractItems(state.stash, definitions, 'stash'));

  for (const [vehicleInstanceId, trunk] of Object.entries(state.trunks)) {
    if (!isSafeId(vehicleInstanceId)) errors.push(`trunk key "${vehicleInstanceId}" is unsafe`);
    if (
      trunk.gridWidth !== TACTICAL_TRUNK_GRID_WIDTH
      || trunk.gridHeight !== TACTICAL_TRUNK_GRID_HEIGHT
      || trunk.maxWeightKg !== TACTICAL_TRUNK_WEIGHT_KG
    ) {
      errors.push(`trunk "${vehicleInstanceId}" must use the standard 6x4 tactical capacity`);
    }
    errors.push(...validateInventory(trunk, definitions).map((error) => `trunks.${vehicleInstanceId}: ${error}`));
  }
  errors.push(...validateQuickLoadout(state.quickLoadout, state.backpack, definitions, weapons));
  errors.push(...validateRecipeUnlockState(state.recipeUnlocks, recipes).map((error) => `recipes: ${error}`));
  errors.push(...validateGlobalInstanceIds(state));
  return errors;
}

export function assignQuickLoadout(
  state: Readonly<TacticalInventoryState>,
  definitions: readonly ItemDefinition[],
  weapons: readonly WeaponDefinition[],
  slot: QuickLoadoutSlot,
  instanceId: string | null,
): TacticalInventoryTransactionResult {
  const original = cloneState(state);
  const next = cloneState(state);
  const backpackErrors = validateInventory(next.backpack, definitions);
  if (backpackErrors.length > 0) return transactionFailure(original, backpackErrors.join('; '));
  const currentErrors = validateQuickLoadout(next.quickLoadout, next.backpack, definitions, weapons);
  if (currentErrors.length > 0) return transactionFailure(original, currentErrors.join('; '));

  if (instanceId !== null) {
    const item = next.backpack.items.find((entry) => entry.instanceId === instanceId);
    if (!item) return transactionFailure(original, 'quick-loadout items must be carried in the backpack');
    const definition = definitions.find((entry) => entry.id === item.definitionId);
    if (!definition) return transactionFailure(original, `unknown item definition "${item.definitionId}"`);
    if (definition.hasDurability && item.durability <= 0) {
      return transactionFailure(original, 'broken items cannot be equipped');
    }
    const expected = quickSlotKind(slot);
    const actual = loadoutKind(definition, weapons);
    if (actual !== expected) {
      return transactionFailure(original, `${slot} only accepts ${expected} items`);
    }
    const assigned = quickLoadoutIds(next.quickLoadout).filter((id) => id !== currentSlotId(next.quickLoadout, slot));
    if (assigned.includes(instanceId)) {
      return transactionFailure(original, 'an item instance can occupy only one quick-loadout slot');
    }
  }
  setQuickSlot(next.quickLoadout, slot, instanceId);
  return { success: true, state: next };
}

export function transferTacticalItem(
  state: Readonly<TacticalInventoryState>,
  definitions: readonly ItemDefinition[],
  request: Readonly<TacticalTransferRequest>,
): TacticalInventoryTransactionResult {
  const original = cloneState(state);
  if (containerKey(request.source) === containerKey(request.destination)) {
    return transactionFailure(original, 'source and destination containers must differ');
  }
  if (!isSafeId(request.destinationInstanceId)) {
    return transactionFailure(original, 'destination instance id must use a safe identifier');
  }
  const next = cloneState(state);
  const stashErrors = validateAbstractItems(next.stash, definitions, 'stash');
  if (stashErrors.length > 0) return transactionFailure(original, stashErrors.join('; '));
  const globalIdErrors = validateGlobalInstanceIds(next);
  if (globalIdErrors.length > 0) return transactionFailure(original, globalIdErrors.join('; '));
  const sourceItems = containerItems(next, request.source);
  if (!sourceItems) return transactionFailure(original, 'source container does not exist');
  const sourceItem = sourceItems.find((entry) => entry.instanceId === request.instanceId);
  if (!sourceItem) return transactionFailure(original, 'source item does not exist');
  if (
    !Number.isSafeInteger(request.quantity)
    || request.quantity < 1
    || request.quantity > sourceItem.quantity
  ) {
    return transactionFailure(original, 'transfer quantity is invalid');
  }
  if (
    request.destinationInstanceId === sourceItem.instanceId
    && request.quantity < sourceItem.quantity
  ) {
    return transactionFailure(original, 'a partial transfer requires a new destination instance id');
  }
  const existingGlobalIds = allInstanceIds(next);
  if (
    existingGlobalIds.has(request.destinationInstanceId)
    && !(request.destinationInstanceId === sourceItem.instanceId && request.quantity === sourceItem.quantity)
  ) {
    return transactionFailure(original, 'destination instance id already exists');
  }

  const sourceGrid = gridContainer(next, request.source);
  const destinationGrid = gridContainer(next, request.destination);
  if (request.source.kind !== 'stash' && !sourceGrid) {
    return transactionFailure(original, 'source grid container does not exist');
  }
  if (request.destination.kind !== 'stash' && !destinationGrid) {
    return transactionFailure(original, 'destination grid container does not exist');
  }

  if (sourceGrid && destinationGrid) {
    const moved = transferItem(sourceGrid, destinationGrid, definitions, {
      instanceId: request.instanceId,
      quantity: request.quantity,
      destinationInstanceId: request.destinationInstanceId,
    });
    if (!moved.success) return transactionFailure(original, moved.reason);
    setGridContainer(next, request.source, moved.source);
    setGridContainer(next, request.destination, moved.destination);
  } else if (sourceGrid && request.destination.kind === 'stash') {
    const definition = definitions.find((entry) => entry.id === sourceItem.definitionId);
    if (!definition) return transactionFailure(original, `unknown item definition "${sourceItem.definitionId}"`);
    const stashed = addToStash(next.stash, definition, request.quantity, sourceItem.durability, request.destinationInstanceId);
    if (!stashed.success) return transactionFailure(original, stashed.reason);
    next.stash = stashed.items;
    setGridContainer(next, request.source, removeContainerQuantity(sourceGrid, request.instanceId, request.quantity));
  } else if (request.source.kind === 'stash' && destinationGrid) {
    const added = addItem(destinationGrid, definitions, {
      definitionId: sourceItem.definitionId,
      quantity: request.quantity,
      instanceIdBase: request.destinationInstanceId,
      durability: sourceItem.durability,
    });
    if (!added.success) return transactionFailure(original, added.reason);
    next.stash = removeStashQuantity(next.stash, request.instanceId, request.quantity);
    setGridContainer(next, request.destination, added.inventory);
  } else {
    return transactionFailure(original, 'unsupported stash-to-stash transfer');
  }

  pruneQuickLoadout(next);
  const duplicateErrors = validateGlobalInstanceIds(next);
  if (duplicateErrors.length > 0) return transactionFailure(original, duplicateErrors.join('; '));
  return { success: true, state: next };
}

/** Moves every source stack as one all-or-nothing transaction. */
export function transferAllTacticalItems(
  state: Readonly<TacticalInventoryState>,
  definitions: readonly ItemDefinition[],
  source: TacticalContainerRef,
  destination: TacticalContainerRef,
): TacticalInventoryTransactionResult {
  const original = cloneState(state);
  if (containerKey(source) === containerKey(destination)) {
    return transactionFailure(original, 'source and destination containers must differ');
  }
  const initialItems = containerItems(original, source);
  if (!initialItems) return transactionFailure(original, 'source container does not exist');
  let working = cloneState(original);
  const orderedIds = [...initialItems]
    .sort((left, right) => left.definitionId.localeCompare(right.definitionId)
      || left.instanceId.localeCompare(right.instanceId))
    .map((item) => item.instanceId);
  for (const instanceId of orderedIds) {
    const current = containerItems(working, source)?.find((entry) => entry.instanceId === instanceId);
    if (!current) continue;
    const transferred = transferTacticalItem(working, definitions, {
      source,
      destination,
      instanceId,
      quantity: current.quantity,
      destinationInstanceId: instanceId,
    });
    if (!transferred.success) return transactionFailure(original, transferred.reason);
    working = transferred.state;
  }
  return { success: true, state: working };
}

export function autoSortTacticalContainer(
  state: Readonly<TacticalInventoryState>,
  definitions: readonly ItemDefinition[],
  container: TacticalContainerRef,
): TacticalInventoryTransactionResult {
  const original = cloneState(state);
  const next = cloneState(state);
  if (container.kind === 'stash') {
    const errors = validateAbstractItems(next.stash, definitions, 'stash');
    if (errors.length > 0) return transactionFailure(original, errors.join('; '));
    const categories = new Map(definitions.map((definition) => [definition.id, definition.category]));
    next.stash.sort((left, right) => (categories.get(left.definitionId) ?? '').localeCompare(categories.get(right.definitionId) ?? '')
      || left.definitionId.localeCompare(right.definitionId)
      || left.instanceId.localeCompare(right.instanceId));
    return { success: true, state: next };
  }
  const inventory = gridContainer(next, container);
  if (!inventory) return transactionFailure(original, 'container does not exist');
  const sorted = autoSortInventory(inventory, definitions);
  if (!sorted.success) return transactionFailure(original, sorted.reason);
  setGridContainer(next, container, sorted.inventory);
  return { success: true, state: next };
}

export function snapshotTacticalInventory(
  state: Readonly<TacticalInventoryState>,
): TacticalInventorySnapshotV1 {
  const cloned = cloneState(state);
  const sortedTrunks = Object.fromEntries(
    Object.entries(cloned.trunks).sort(([left], [right]) => left.localeCompare(right)),
  );
  cloned.recipeUnlocks.unlockedRecipeIds.sort((left, right) => left.localeCompare(right));
  return {
    schemaVersion: TACTICAL_INVENTORY_SNAPSHOT_VERSION,
    ...cloned,
    trunks: sortedTrunks,
  };
}

/** Maps the isolated domain directly onto the schema-v3 core save fields. */
export function tacticalInventorySaveFields(
  state: Readonly<TacticalInventoryState>,
): TacticalInventorySaveFields {
  const snapshot = snapshotTacticalInventory(state);
  return {
    inventory: snapshot.backpack,
    stash: snapshot.stash,
    trunks: snapshot.trunks,
    quickLoadout: snapshot.quickLoadout,
    unlockedRecipes: [...snapshot.recipeUnlocks.unlockedRecipeIds],
  };
}

export function restoreTacticalInventorySaveFields(
  fields: Readonly<TacticalInventorySaveFields>,
  definitions: readonly ItemDefinition[],
  weapons: readonly WeaponDefinition[],
  recipes: readonly RecipeDefinition[],
  grit: number,
  expectedVehicleInstanceIds?: readonly string[],
): TacticalInventoryRestoreResult {
  return restoreTacticalInventorySnapshot({
    schemaVersion: TACTICAL_INVENTORY_SNAPSHOT_VERSION,
    backpack: fields.inventory,
    stash: fields.stash,
    trunks: fields.trunks,
    quickLoadout: fields.quickLoadout,
    recipeUnlocks: { unlockedRecipeIds: fields.unlockedRecipes },
  }, definitions, weapons, recipes, grit, expectedVehicleInstanceIds);
}

export function restoreTacticalInventorySnapshot(
  value: unknown,
  definitions: readonly ItemDefinition[],
  weapons: readonly WeaponDefinition[],
  recipes: readonly RecipeDefinition[],
  grit: number,
  expectedVehicleInstanceIds?: readonly string[],
): TacticalInventoryRestoreResult {
  const parseErrors: string[] = [];
  const snapshot = parseSnapshot(value, parseErrors);
  if (!snapshot || parseErrors.length > 0) return { success: false, errors: parseErrors };
  const errors = [...validateTacticalInventoryState(snapshot, definitions, weapons, recipes, grit)];
  if (expectedVehicleInstanceIds) {
    const expected = [...new Set(expectedVehicleInstanceIds)].sort((left, right) => left.localeCompare(right));
    const actual = Object.keys(snapshot.trunks).sort((left, right) => left.localeCompare(right));
    if (expected.length !== expectedVehicleInstanceIds.length) {
      errors.push('expected vehicle instance ids must be unique');
    }
    if (expected.join('\0') !== actual.join('\0')) {
      errors.push('persisted trunks must exactly match the expected owned vehicles');
    }
  }
  if (errors.length > 0) return { success: false, errors };
  const { schemaVersion: _schemaVersion, ...state } = snapshot;
  void _schemaVersion;
  return { success: true, state: cloneState(state) };
}

function validateQuickLoadout(
  loadout: Readonly<QuickLoadout>,
  backpack: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  weapons: readonly WeaponDefinition[],
): readonly string[] {
  const errors: string[] = [];
  if (!Array.isArray(loadout.firearms) || loadout.firearms.length !== 2) {
    errors.push('quick loadout must contain exactly two firearm slots');
  }
  if (!Array.isArray(loadout.consumables) || loadout.consumables.length !== 2) {
    errors.push('quick loadout must contain exactly two consumable slots');
  }
  const slots: readonly [QuickLoadoutSlot, string | null][] = [
    ['firearm-1', loadout.firearms[0]],
    ['firearm-2', loadout.firearms[1]],
    ['melee', loadout.melee],
    ['consumable-1', loadout.consumables[0]],
    ['consumable-2', loadout.consumables[1]],
  ];
  const found = new Set<string>();
  for (const [slot, instanceId] of slots) {
    if (instanceId === null) continue;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      errors.push(`${slot} must reference a non-empty instance id or null`);
      continue;
    }
    if (found.has(instanceId)) errors.push(`quick-loadout item "${instanceId}" is assigned more than once`);
    found.add(instanceId);
    const item = backpack.items.find((entry) => entry.instanceId === instanceId);
    if (!item) {
      errors.push(`${slot} references an item outside the backpack`);
      continue;
    }
    const definition = definitions.find((entry) => entry.id === item.definitionId);
    if (!definition || loadoutKind(definition, weapons) !== quickSlotKind(slot)) {
      errors.push(`${slot} references the wrong item category`);
    } else if (definition.hasDurability && item.durability <= 0) {
      errors.push(`${slot} references a broken item`);
    }
  }
  return errors;
}

function validateAbstractItems(
  items: readonly SavedItemInstance[],
  definitions: readonly ItemDefinition[],
  path: string,
): readonly string[] {
  const errors: string[] = [];
  const catalog = new Map(definitions.map((definition) => [definition.id, definition]));
  const ids = new Set<string>();
  for (const item of items) {
    const definition = catalog.get(item.definitionId);
    if (!isSafeId(item.instanceId) || ids.has(item.instanceId)) {
      errors.push(`${path}.${item.instanceId || '(empty)'} must use a unique safe instance id`);
    }
    ids.add(item.instanceId);
    if (!definition) {
      errors.push(`${path}.${item.instanceId} uses unknown definition "${item.definitionId}"`);
      continue;
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > definition.maximumStack) {
      errors.push(`${path}.${item.instanceId} has an invalid quantity`);
    }
    if (!Number.isFinite(item.durability) || item.durability < 0 || item.durability > 100) {
      errors.push(`${path}.${item.instanceId} has invalid durability`);
    } else if (!definition.hasDurability && item.durability !== 100) {
      errors.push(`${path}.${item.instanceId} must remain at 100 durability`);
    }
    if (definition.category === 'quest' && (definition.weightKg !== 0 || definition.discardable)) {
      errors.push(`${path}.${item.instanceId} quest item must be weightless and non-discardable`);
    }
    if (item.x !== 0 || item.y !== 0 || item.rotated) {
      errors.push(`${path}.${item.instanceId} must use canonical abstract-storage coordinates`);
    }
  }
  return errors;
}

function validateGlobalInstanceIds(state: Readonly<TacticalInventoryState>): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const entries: readonly (readonly [string, readonly SavedItemInstance[]])[] = [
    ['backpack', state.backpack.items],
    ['stash', state.stash],
    ...Object.entries(state.trunks).map(([id, trunk]) => [`trunks.${id}`, trunk.items] as const),
  ];
  for (const [path, items] of entries) {
    for (const item of items) {
      if (ids.has(item.instanceId)) errors.push(`item instance "${item.instanceId}" is duplicated at ${path}`);
      ids.add(item.instanceId);
    }
  }
  return errors;
}

function loadoutKind(
  definition: Readonly<ItemDefinition>,
  weapons: readonly WeaponDefinition[],
): 'firearm' | 'melee' | 'consumable' | null {
  if (definition.category === 'consumable') return 'consumable';
  if (definition.category !== 'weapon' || !definition.weaponId) return null;
  const weapon = weapons.find((entry) => entry.id === definition.weaponId);
  if (!weapon) return null;
  return weapon.classId === 'melee' ? 'melee' : 'firearm';
}

function quickSlotKind(slot: QuickLoadoutSlot): 'firearm' | 'melee' | 'consumable' {
  if (slot.startsWith('firearm')) return 'firearm';
  return slot === 'melee' ? 'melee' : 'consumable';
}

function quickLoadoutIds(loadout: Readonly<QuickLoadout>): string[] {
  return [...loadout.firearms, loadout.melee, ...loadout.consumables]
    .filter((id): id is string => id !== null);
}

function currentSlotId(loadout: Readonly<QuickLoadout>, slot: QuickLoadoutSlot): string | null {
  switch (slot) {
    case 'firearm-1': return loadout.firearms[0];
    case 'firearm-2': return loadout.firearms[1];
    case 'melee': return loadout.melee;
    case 'consumable-1': return loadout.consumables[0];
    case 'consumable-2': return loadout.consumables[1];
  }
}

function setQuickSlot(loadout: QuickLoadout, slot: QuickLoadoutSlot, instanceId: string | null): void {
  switch (slot) {
    case 'firearm-1': loadout.firearms[0] = instanceId; break;
    case 'firearm-2': loadout.firearms[1] = instanceId; break;
    case 'melee': loadout.melee = instanceId; break;
    case 'consumable-1': loadout.consumables[0] = instanceId; break;
    case 'consumable-2': loadout.consumables[1] = instanceId; break;
  }
}

function pruneQuickLoadout(state: TacticalInventoryState): void {
  const carriedIds = new Set(state.backpack.items.map((item) => item.instanceId));
  state.quickLoadout.firearms = state.quickLoadout.firearms.map((id) => (
    id !== null && carriedIds.has(id) ? id : null
  )) as [string | null, string | null];
  if (state.quickLoadout.melee !== null && !carriedIds.has(state.quickLoadout.melee)) {
    state.quickLoadout.melee = null;
  }
  state.quickLoadout.consumables = state.quickLoadout.consumables.map((id) => (
    id !== null && carriedIds.has(id) ? id : null
  )) as [string | null, string | null];
}

function addToStash(
  stash: readonly SavedItemInstance[],
  definition: Readonly<ItemDefinition>,
  quantity: number,
  durability: number,
  instanceIdBase: string,
): { success: true; items: SavedItemInstance[] } | { success: false; reason: string } {
  const next = stash.map((item) => ({ ...item }));
  let remaining = quantity;
  for (const stack of next) {
    if (
      stack.definitionId !== definition.id
      || stack.durability !== durability
      || stack.quantity >= definition.maximumStack
    ) continue;
    const added = Math.min(remaining, definition.maximumStack - stack.quantity);
    stack.quantity += added;
    remaining -= added;
    if (remaining === 0) return { success: true, items: next };
  }
  let index = 0;
  while (remaining > 0) {
    const instanceId = index === 0 ? instanceIdBase : `${instanceIdBase}-${index + 1}`;
    if (next.some((item) => item.instanceId === instanceId)) {
      return { success: false, reason: `stash instance id "${instanceId}" already exists` };
    }
    const stackQuantity = Math.min(remaining, definition.maximumStack);
    next.push({
      instanceId,
      definitionId: definition.id,
      quantity: stackQuantity,
      durability,
      x: 0,
      y: 0,
      rotated: false,
    });
    remaining -= stackQuantity;
    index += 1;
  }
  return { success: true, items: next };
}

function removeContainerQuantity(
  inventory: Readonly<SavedInventory>,
  instanceId: string,
  quantity: number,
): SavedInventory {
  const next = cloneInventory(inventory);
  const item = next.items.find((entry) => entry.instanceId === instanceId)!;
  item.quantity -= quantity;
  if (item.quantity === 0) next.items = next.items.filter((entry) => entry.instanceId !== instanceId);
  return next;
}

function removeStashQuantity(
  stash: readonly SavedItemInstance[],
  instanceId: string,
  quantity: number,
): SavedItemInstance[] {
  const next = stash.map((item) => ({ ...item }));
  const item = next.find((entry) => entry.instanceId === instanceId)!;
  item.quantity -= quantity;
  return next.filter((entry) => entry.quantity > 0);
}

function containerItems(
  state: Readonly<TacticalInventoryState>,
  container: TacticalContainerRef,
): readonly SavedItemInstance[] | null {
  if (container.kind === 'backpack') return state.backpack.items;
  if (container.kind === 'stash') return state.stash;
  return state.trunks[container.vehicleInstanceId]?.items ?? null;
}

function gridContainer(
  state: Readonly<TacticalInventoryState>,
  container: TacticalContainerRef,
): SavedInventory | null {
  if (container.kind === 'backpack') return state.backpack;
  if (container.kind === 'trunk') return state.trunks[container.vehicleInstanceId] ?? null;
  return null;
}

function setGridContainer(
  state: TacticalInventoryState,
  container: TacticalContainerRef,
  inventory: SavedInventory,
): void {
  if (container.kind === 'backpack') state.backpack = inventory;
  else if (container.kind === 'trunk') state.trunks[container.vehicleInstanceId] = inventory;
}

function containerKey(container: TacticalContainerRef): string {
  return container.kind === 'trunk' ? `trunk:${container.vehicleInstanceId}` : container.kind;
}

function allInstanceIds(state: Readonly<TacticalInventoryState>): Set<string> {
  return new Set([
    ...state.backpack.items.map((item) => item.instanceId),
    ...state.stash.map((item) => item.instanceId),
    ...Object.values(state.trunks).flatMap((trunk) => trunk.items.map((item) => item.instanceId)),
  ]);
}

function parseSnapshot(value: unknown, errors: string[]): TacticalInventorySnapshotV1 | null {
  if (!isRecord(value)) {
    errors.push('tactical inventory snapshot must be an object');
    return null;
  }
  if (value.schemaVersion !== TACTICAL_INVENTORY_SNAPSHOT_VERSION) {
    errors.push(`schemaVersion must be ${TACTICAL_INVENTORY_SNAPSHOT_VERSION}`);
  }
  const backpack = parseInventory(value.backpack, 'backpack', errors);
  const stash = parseItemArray(value.stash, 'stash', errors);
  const trunks: Record<string, SavedInventory> = {};
  if (!isRecord(value.trunks)) {
    errors.push('trunks must be an object');
  } else {
    for (const [id, entry] of Object.entries(value.trunks)) {
      const trunk = parseInventory(entry, `trunks.${id}`, errors);
      if (trunk) trunks[id] = trunk;
    }
  }
  const quickLoadout = parseQuickLoadout(value.quickLoadout, errors);
  let recipeUnlocks: RecipeUnlockState | null = null;
  if (!isRecord(value.recipeUnlocks) || !Array.isArray(value.recipeUnlocks.unlockedRecipeIds)) {
    errors.push('recipeUnlocks.unlockedRecipeIds must be an array');
  } else {
    const unlockedRecipeIds: string[] = [];
    value.recipeUnlocks.unlockedRecipeIds.forEach((entry, index) => {
      if (typeof entry !== 'string') errors.push(`recipeUnlocks.unlockedRecipeIds[${index}] must be a string`);
      else unlockedRecipeIds.push(entry);
    });
    recipeUnlocks = { unlockedRecipeIds };
  }
  if (!backpack || !stash || !quickLoadout || !recipeUnlocks) return null;
  return {
    schemaVersion: TACTICAL_INVENTORY_SNAPSHOT_VERSION,
    backpack,
    stash,
    trunks,
    quickLoadout,
    recipeUnlocks,
  };
}

function parseInventory(value: unknown, path: string, errors: string[]): SavedInventory | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (typeof value.gridWidth !== 'number') errors.push(`${path}.gridWidth must be a number`);
  if (typeof value.gridHeight !== 'number') errors.push(`${path}.gridHeight must be a number`);
  if (typeof value.maxWeightKg !== 'number') errors.push(`${path}.maxWeightKg must be a number`);
  const items = parseItemArray(value.items, `${path}.items`, errors);
  if (
    typeof value.gridWidth !== 'number'
    || typeof value.gridHeight !== 'number'
    || typeof value.maxWeightKg !== 'number'
    || !items
  ) return null;
  return { gridWidth: value.gridWidth, gridHeight: value.gridHeight, maxWeightKg: value.maxWeightKg, items };
}

function parseItemArray(value: unknown, path: string, errors: string[]): SavedItemInstance[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return null;
  }
  const items: SavedItemInstance[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    const valid = typeof entry.instanceId === 'string'
      && typeof entry.definitionId === 'string'
      && typeof entry.quantity === 'number'
      && typeof entry.durability === 'number'
      && typeof entry.x === 'number'
      && typeof entry.y === 'number'
      && typeof entry.rotated === 'boolean';
    if (!valid) {
      errors.push(`${path}[${index}] has malformed item fields`);
      return;
    }
    items.push({
      instanceId: entry.instanceId as string,
      definitionId: entry.definitionId as string,
      quantity: entry.quantity as number,
      durability: entry.durability as number,
      x: entry.x as number,
      y: entry.y as number,
      rotated: entry.rotated as boolean,
    });
  });
  return items;
}

function parseQuickLoadout(value: unknown, errors: string[]): QuickLoadout | null {
  if (!isRecord(value)) {
    errors.push('quickLoadout must be an object');
    return null;
  }
  const firearms = parseNullableStringTuple(value.firearms, 'quickLoadout.firearms', errors);
  const consumables = parseNullableStringTuple(value.consumables, 'quickLoadout.consumables', errors);
  if (value.melee !== null && typeof value.melee !== 'string') {
    errors.push('quickLoadout.melee must be a string or null');
  }
  if (!firearms || !consumables || (value.melee !== null && typeof value.melee !== 'string')) return null;
  return { firearms, melee: value.melee as string | null, consumables };
}

function parseNullableStringTuple(
  value: unknown,
  path: string,
  errors: string[],
): [string | null, string | null] | null {
  if (!Array.isArray(value) || value.length !== 2) {
    errors.push(`${path} must contain exactly two entries`);
    return null;
  }
  if (value.some((entry) => entry !== null && typeof entry !== 'string')) {
    errors.push(`${path} entries must be strings or null`);
    return null;
  }
  return [value[0] as string | null, value[1] as string | null];
}

function cloneState(state: Readonly<TacticalInventoryState>): TacticalInventoryState {
  return {
    backpack: cloneInventory(state.backpack),
    stash: state.stash.map((item) => ({ ...item })),
    trunks: Object.fromEntries(Object.entries(state.trunks).map(([id, trunk]) => [id, cloneInventory(trunk)])),
    quickLoadout: {
      firearms: [...state.quickLoadout.firearms],
      melee: state.quickLoadout.melee,
      consumables: [...state.quickLoadout.consumables],
    },
    recipeUnlocks: { unlockedRecipeIds: [...state.recipeUnlocks.unlockedRecipeIds] },
  };
}

function cloneInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return {
    gridWidth: inventory.gridWidth,
    gridHeight: inventory.gridHeight,
    maxWeightKg: inventory.maxWeightKg,
    items: inventory.items.map((item) => ({ ...item })),
  };
}

function safeBackpackCapacity(grit: number, errors: string[]): number | null {
  try {
    return backpackWeightCapacity(grit);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'invalid grit');
    return null;
  }
}

function transactionFailure(
  state: TacticalInventoryState,
  reason: string,
): TacticalInventoryTransactionResult {
  return { success: false, state, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && !RESERVED_KEYS.has(value);
}

function assertSafeId(value: string, label: string): void {
  if (!isSafeId(value)) throw new TypeError(`${label} must use a safe non-reserved identifier`);
}
