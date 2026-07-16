import type { ItemDefinition, RecipeDefinition } from '../data/types';
import type { SavedInventory, SavedItemInstance } from '../core/state';

export const BACKPACK_GRID_WIDTH = 8 as const;
export const BACKPACK_GRID_HEIGHT = 6 as const;
export const BACKPACK_BASE_WEIGHT_KG = 20 as const;
export const BACKPACK_GRIT_WEIGHT_KG = 2 as const;
export const TACTICAL_TRUNK_GRID_WIDTH = 6 as const;
export const TACTICAL_TRUNK_GRID_HEIGHT = 4 as const;
export const TACTICAL_TRUNK_WEIGHT_KG = 192 as const;

export type InventoryTransactionResult =
  | { success: true; inventory: SavedInventory }
  | { success: false; inventory: SavedInventory; reason: string };

export type TransferResult =
  | { success: true; source: SavedInventory; destination: SavedInventory }
  | { success: false; source: SavedInventory; destination: SavedInventory; reason: string };

export type CraftResult =
  | {
    success: true;
    inventory: SavedInventory;
    consumed: readonly { itemId: string; quantity: number }[];
    produced: { itemId: string; quantity: number };
  }
  | { success: false; inventory: SavedInventory; reason: string };

export interface AddItemRequest {
  definitionId: string;
  quantity: number;
  instanceIdBase: string;
  durability?: number;
}

export interface TransferRequest {
  instanceId: string;
  quantity: number;
  destinationInstanceId: string;
}

export type InventoryUseResult =
  | {
    success: true;
    inventory: SavedInventory;
    usedDefinitionId: string;
    usedQuantity: number;
  }
  | { success: false; inventory: SavedInventory; reason: string };

export type InventoryRepairResult =
  | {
    success: true;
    inventory: SavedInventory;
    targetInstanceId: string;
    restoredDurability: number;
    consumedDefinitionId: string | null;
  }
  | { success: false; inventory: SavedInventory; reason: string };

export function backpackWeightCapacity(grit: number): number {
  if (!Number.isSafeInteger(grit) || grit < 1 || grit > 6) {
    throw new RangeError('grit must be an integer between 1 and 6');
  }
  return BACKPACK_BASE_WEIGHT_KG + grit * BACKPACK_GRIT_WEIGHT_KG;
}

export function createBackpack(grit: number): SavedInventory {
  return createInventory(
    BACKPACK_GRID_WIDTH,
    BACKPACK_GRID_HEIGHT,
    backpackWeightCapacity(grit),
  );
}

export function createTacticalVehicleTrunk(): SavedInventory {
  return createInventory(
    TACTICAL_TRUNK_GRID_WIDTH,
    TACTICAL_TRUNK_GRID_HEIGHT,
    TACTICAL_TRUNK_WEIGHT_KG,
  );
}

export function createInventory(
  gridWidth: number,
  gridHeight: number,
  maxWeightKg: number,
): SavedInventory {
  assertPositiveInteger(gridWidth, 'gridWidth');
  assertPositiveInteger(gridHeight, 'gridHeight');
  if (!Number.isFinite(maxWeightKg) || maxWeightKg < 0) {
    throw new RangeError('maxWeightKg must be a non-negative finite number');
  }
  return { gridWidth, gridHeight, maxWeightKg, items: [] };
}

export function inventoryWeight(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
): number {
  const catalog = itemCatalog(definitions);
  return inventory.items.reduce((weight, item) => {
    const definition = catalog.get(item.definitionId);
    if (!definition) {
      throw new Error(`unknown item definition "${item.definitionId}"`);
    }
    return weight + definition.weightKg * item.quantity;
  }, 0);
}

export function countItem(inventory: Readonly<SavedInventory>, definitionId: string): number {
  return inventory.items.reduce(
    (quantity, item) => quantity + (item.definitionId === definitionId ? item.quantity : 0),
    0,
  );
}

export function validateInventory(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const catalog = itemCatalog(definitions);
  const instanceIds = new Set<string>();

  if (!Number.isSafeInteger(inventory.gridWidth) || inventory.gridWidth < 1) {
    errors.push('gridWidth must be a positive integer');
  }
  if (!Number.isSafeInteger(inventory.gridHeight) || inventory.gridHeight < 1) {
    errors.push('gridHeight must be a positive integer');
  }
  if (!Number.isFinite(inventory.maxWeightKg) || inventory.maxWeightKg < 0) {
    errors.push('maxWeightKg must be non-negative and finite');
  }

  for (const item of inventory.items) {
    const definition = catalog.get(item.definitionId);
    if (!definition) {
      errors.push(`${item.instanceId} uses unknown definition "${item.definitionId}"`);
      continue;
    }
    const definitionErrors = validateItemDefinition(definition);
    if (definitionErrors.length > 0) {
      errors.push(...definitionErrors.map((error) => `${item.instanceId} definition: ${error}`));
    }
    if (!item.instanceId || instanceIds.has(item.instanceId)) {
      errors.push(`${item.instanceId || '(empty id)'} must have a unique instance id`);
    }
    instanceIds.add(item.instanceId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > definition.maximumStack) {
      errors.push(`${item.instanceId} quantity must be between 1 and ${definition.maximumStack}`);
    }
    if (!Number.isFinite(item.durability) || item.durability < 0 || item.durability > 100) {
      errors.push(`${item.instanceId} durability must be between 0 and 100`);
    }
    if (!definition.hasDurability && item.durability !== 100) {
      errors.push(`${item.instanceId} does not use durability and must remain at 100`);
    }
    if (definition.category === 'quest' && (definition.weightKg !== 0 || definition.discardable)) {
      errors.push(`${item.instanceId} quest definition must be weightless and non-discardable`);
    }
    if (typeof item.rotated !== 'boolean') {
      errors.push(`${item.instanceId} rotation must be a boolean`);
    }
    if (!Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y)) {
      errors.push(`${item.instanceId} position must use integer coordinates`);
    } else if (!fitsWithinGrid(inventory, item, definition)) {
      errors.push(`${item.instanceId} is outside the inventory grid`);
    }
  }

  for (let leftIndex = 0; leftIndex < inventory.items.length; leftIndex += 1) {
    const left = inventory.items[leftIndex];
    if (!left) {
      continue;
    }
    const leftDefinition = catalog.get(left.definitionId);
    if (!leftDefinition) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < inventory.items.length; rightIndex += 1) {
      const right = inventory.items[rightIndex];
      if (!right) {
        continue;
      }
      const rightDefinition = catalog.get(right.definitionId);
      if (rightDefinition && overlaps(left, leftDefinition, right, rightDefinition)) {
        errors.push(`${left.instanceId} overlaps ${right.instanceId}`);
      }
    }
  }

  try {
    if (inventoryWeight(inventory, definitions) > inventory.maxWeightKg + Number.EPSILON) {
      errors.push('inventory exceeds its maximum weight');
    }
  } catch {
    // Unknown ids are already reported above.
  }

  return errors;
}

export function addItem(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  request: Readonly<AddItemRequest>,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(inventory, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) {
    return failure(original, 'quantity must be a positive integer');
  }
  if (request.instanceIdBase.trim().length === 0) {
    return failure(original, 'instanceIdBase must not be empty');
  }

  const catalog = itemCatalog(definitions);
  const definition = catalog.get(request.definitionId);
  if (!definition) {
    return failure(original, `unknown item definition "${request.definitionId}"`);
  }
  const definitionErrors = validateItemDefinition(definition);
  if (definitionErrors.length > 0) {
    return failure(original, `item definition is invalid: ${definitionErrors.join('; ')}`);
  }
  const durability = definition.hasDurability ? (request.durability ?? 100) : 100;
  if (!Number.isFinite(durability) || durability < 0 || durability > 100) {
    return failure(original, 'durability must be between 0 and 100');
  }
  const addedWeight = definition.weightKg * request.quantity;
  if (inventoryWeight(inventory, definitions) + addedWeight > inventory.maxWeightKg + Number.EPSILON) {
    return failure(original, 'inventory weight limit would be exceeded');
  }

  const next = cloneInventory(inventory);
  let remaining = request.quantity;
  if (definition.maximumStack > 1) {
    for (const item of next.items) {
      if (item.definitionId !== definition.id || item.quantity >= definition.maximumStack) {
        continue;
      }
      const added = Math.min(remaining, definition.maximumStack - item.quantity);
      item.quantity += added;
      remaining -= added;
      if (remaining === 0) {
        return { success: true, inventory: next };
      }
    }
  }

  let newStackIndex = 0;
  while (remaining > 0) {
    const instanceId = newStackIndex === 0
      ? request.instanceIdBase
      : `${request.instanceIdBase}-${newStackIndex + 1}`;
    if (next.items.some((item) => item.instanceId === instanceId)) {
      return failure(original, `instance id "${instanceId}" already exists`);
    }
    const placement = findFirstPlacement(next, definition, catalog);
    if (!placement) {
      return failure(original, 'inventory has no valid grid placement for the item');
    }
    const quantity = Math.min(remaining, definition.maximumStack);
    next.items.push({
      instanceId,
      definitionId: definition.id,
      quantity,
      durability,
      ...placement,
    });
    remaining -= quantity;
    newStackIndex += 1;
  }

  return { success: true, inventory: next };
}

export function moveItem(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  x: number,
  y: number,
  rotated: boolean,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    return failure(original, 'item coordinates must be integers');
  }
  const catalog = itemCatalog(definitions);
  const item = original.items.find((candidate) => candidate.instanceId === instanceId);
  if (!item) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  const definition = catalog.get(item.definitionId);
  if (!definition) {
    return failure(original, `unknown item definition "${item.definitionId}"`);
  }

  const candidate: SavedItemInstance = { ...item, x, y, rotated };
  if (!fitsWithinGrid(original, candidate, definition)) {
    return failure(original, 'item would be outside the inventory grid');
  }
  const blocked = original.items.some((other) => {
    if (other.instanceId === instanceId) {
      return false;
    }
    const otherDefinition = catalog.get(other.definitionId);
    return otherDefinition ? overlaps(candidate, definition, other, otherDefinition) : true;
  });
  if (blocked) {
    return failure(original, 'item would overlap another item');
  }

  const next = cloneInventory(original);
  const target = next.items.find((entry) => entry.instanceId === instanceId);
  if (!target) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  Object.assign(target, { x, y, rotated });
  return { success: true, inventory: next };
}

export function splitStack(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  quantity: number,
  newInstanceId: string,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  const catalog = itemCatalog(definitions);
  const item = original.items.find((entry) => entry.instanceId === instanceId);
  if (!item) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  const definition = catalog.get(item.definitionId);
  if (!definition) {
    return failure(original, `unknown item definition "${item.definitionId}"`);
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity >= item.quantity) {
    return failure(original, 'split quantity must be positive and smaller than the stack');
  }
  if (!newInstanceId || original.items.some((entry) => entry.instanceId === newInstanceId)) {
    return failure(original, 'new stack instance id must be unique');
  }

  const placement = findFirstPlacement(original, definition, catalog);
  if (!placement) {
    return failure(original, 'inventory has no room for the split stack');
  }
  const next = cloneInventory(original);
  const source = next.items.find((entry) => entry.instanceId === instanceId);
  if (!source) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  source.quantity -= quantity;
  next.items.push({
    ...source,
    instanceId: newInstanceId,
    quantity,
    ...placement,
  });
  return { success: true, inventory: next };
}

/** Re-packs every existing stack without changing identity, quantity, or durability. */
export function autoSortInventory(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  const catalog = itemCatalog(definitions);
  const ordered = [...original.items].sort((left, right) => {
    const leftDefinition = catalog.get(left.definitionId)!;
    const rightDefinition = catalog.get(right.definitionId)!;
    const leftArea = leftDefinition.shape.width * leftDefinition.shape.height;
    const rightArea = rightDefinition.shape.width * rightDefinition.shape.height;
    return rightArea - leftArea
      || Math.max(rightDefinition.shape.width, rightDefinition.shape.height)
        - Math.max(leftDefinition.shape.width, leftDefinition.shape.height)
      || left.definitionId.localeCompare(right.definitionId)
      || left.instanceId.localeCompare(right.instanceId);
  });
  const packed: SavedInventory = {
    gridWidth: original.gridWidth,
    gridHeight: original.gridHeight,
    maxWeightKg: original.maxWeightKg,
    items: [],
  };
  const deadEnds = new Set<string>();
  if (!packInventoryItem(0, ordered, packed, catalog, deadEnds)) {
    return failure(original, 'inventory items could not be deterministically re-packed');
  }
  return { success: true, inventory: packed };
}

export function discardItem(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  quantity: number,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  const item = original.items.find((entry) => entry.instanceId === instanceId);
  if (!item) return failure(original, `unknown item instance "${instanceId}"`);
  const definition = definitions.find((entry) => entry.id === item.definitionId);
  if (!definition) return failure(original, `unknown item definition "${item.definitionId}"`);
  if (definition.category === 'quest' || !definition.discardable) {
    return failure(original, 'quest and non-discardable items cannot be discarded');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) {
    return failure(original, 'discard quantity is invalid');
  }
  return {
    success: true,
    inventory: removeInstanceQuantity(original, instanceId, quantity),
  };
}

export function updateBackpackGritCapacity(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  grit: number,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  if (original.gridWidth !== BACKPACK_GRID_WIDTH || original.gridHeight !== BACKPACK_GRID_HEIGHT) {
    return failure(original, 'backpack must use the 8x6 tactical grid');
  }
  let maxWeightKg: number;
  try {
    maxWeightKg = backpackWeightCapacity(grit);
  } catch (error) {
    return failure(original, error instanceof Error ? error.message : 'invalid grit');
  }
  if (inventoryWeight(original, definitions) > maxWeightKg + Number.EPSILON) {
    return failure(original, 'new grit capacity would make the backpack overweight');
  }
  original.maxWeightKg = maxWeightKg;
  return { success: true, inventory: original };
}

export function transferItem(
  source: Readonly<SavedInventory>,
  destination: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  request: Readonly<TransferRequest>,
): TransferResult {
  const sourceOriginal = cloneInventory(source);
  const destinationOriginal = cloneInventory(destination);
  const sourceValidation = validateInventory(sourceOriginal, definitions);
  if (sourceValidation.length > 0) {
    return transferFailure(sourceOriginal, destinationOriginal, `source inventory is invalid: ${sourceValidation.join('; ')}`);
  }
  const destinationValidation = validateInventory(destinationOriginal, definitions);
  if (destinationValidation.length > 0) {
    return transferFailure(sourceOriginal, destinationOriginal, `destination inventory is invalid: ${destinationValidation.join('; ')}`);
  }
  const item = source.items.find((entry) => entry.instanceId === request.instanceId);
  if (!item) {
    return transferFailure(sourceOriginal, destinationOriginal, 'source item does not exist');
  }
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1 || request.quantity > item.quantity) {
    return transferFailure(sourceOriginal, destinationOriginal, 'transfer quantity is invalid');
  }
  if (destination.items.some((entry) => entry.instanceId === request.destinationInstanceId)) {
    return transferFailure(sourceOriginal, destinationOriginal, 'destination instance id already exists');
  }

  const sourceNext = cloneInventory(source);
  const sourceItem = sourceNext.items.find((entry) => entry.instanceId === request.instanceId);
  if (!sourceItem) {
    return transferFailure(sourceOriginal, destinationOriginal, 'source item does not exist');
  }
  sourceItem.quantity -= request.quantity;
  if (sourceItem.quantity === 0) {
    sourceNext.items = sourceNext.items.filter((entry) => entry.instanceId !== request.instanceId);
  }

  const added = addItem(destination, definitions, {
    definitionId: item.definitionId,
    quantity: request.quantity,
    instanceIdBase: request.destinationInstanceId,
    durability: item.durability,
  });
  if (!added.success) {
    return transferFailure(sourceOriginal, destinationOriginal, added.reason);
  }
  return { success: true, source: sourceNext, destination: added.inventory };
}

export function damageItemDurability(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  damage: number,
): InventoryTransactionResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return failure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  if (!Number.isFinite(damage) || damage < 0) {
    return failure(original, 'durability damage must be non-negative and finite');
  }
  const item = original.items.find((entry) => entry.instanceId === instanceId);
  if (!item) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  const definition = definitions.find((entry) => entry.id === item.definitionId);
  if (!definition?.hasDurability) {
    return failure(original, 'item does not use durability');
  }
  const next = cloneInventory(original);
  const target = next.items.find((entry) => entry.instanceId === instanceId);
  if (!target) {
    return failure(original, `unknown item instance "${instanceId}"`);
  }
  target.durability = Math.max(0, target.durability - damage);
  return { success: true, inventory: next };
}

export function repairItemDurability(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  amount: number,
): InventoryRepairResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return repairFailure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return repairFailure(original, 'repair amount must be positive and finite');
  }
  const item = original.items.find((entry) => entry.instanceId === instanceId);
  if (!item) return repairFailure(original, `unknown item instance "${instanceId}"`);
  const definition = definitions.find((entry) => entry.id === item.definitionId);
  if (!definition?.hasDurability) return repairFailure(original, 'item cannot be repaired');
  if (item.durability >= 100) return repairFailure(original, 'item is already fully repaired');
  const next = cloneInventory(original);
  const target = next.items.find((entry) => entry.instanceId === instanceId)!;
  const durabilityBefore = target.durability;
  target.durability = Math.min(100, target.durability + amount);
  return {
    success: true,
    inventory: next,
    targetInstanceId: instanceId,
    restoredDurability: target.durability - durabilityBefore,
    consumedDefinitionId: null,
  };
}

export function useConsumable(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  instanceId: string,
  quantity = 1,
): InventoryUseResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return useFailure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  const item = original.items.find((entry) => entry.instanceId === instanceId);
  if (!item) return useFailure(original, `unknown item instance "${instanceId}"`);
  const definition = definitions.find((entry) => entry.id === item.definitionId);
  if (definition?.category !== 'consumable') {
    return useFailure(original, 'only consumable items can be used this way');
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.quantity) {
    return useFailure(original, 'use quantity is invalid');
  }
  return {
    success: true,
    inventory: removeInstanceQuantity(original, instanceId, quantity),
    usedDefinitionId: definition.id,
    usedQuantity: quantity,
  };
}

export function repairItemWithConsumable(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  targetInstanceId: string,
  consumableInstanceId: string,
): InventoryRepairResult {
  const original = cloneInventory(inventory);
  const validation = validateInventory(original, definitions);
  if (validation.length > 0) {
    return repairFailure(original, `source inventory is invalid: ${validation.join('; ')}`);
  }
  const target = original.items.find((entry) => entry.instanceId === targetInstanceId);
  const consumable = original.items.find((entry) => entry.instanceId === consumableInstanceId);
  if (!target) return repairFailure(original, `unknown target instance "${targetInstanceId}"`);
  if (!consumable) return repairFailure(original, `unknown consumable instance "${consumableInstanceId}"`);
  if (target.instanceId === consumable.instanceId) {
    return repairFailure(original, 'repair target and consumable must differ');
  }
  const targetDefinition = definitions.find((entry) => entry.id === target.definitionId);
  const consumableDefinition = definitions.find((entry) => entry.id === consumable.definitionId);
  const repair = consumableDefinition?.id === 'weapon-repair-kit'
    ? { category: 'weapon', amount: 40 }
    : consumableDefinition?.id === 'armor-repair-plate'
      ? { category: 'armor', amount: 35 }
      : null;
  if (!repair || consumableDefinition?.category !== 'consumable') {
    return repairFailure(original, 'item is not a supported repair consumable');
  }
  if (!targetDefinition?.hasDurability || targetDefinition.category !== repair.category) {
    return repairFailure(original, `${consumableDefinition.name} cannot repair that target`);
  }
  if (target.durability >= 100) return repairFailure(original, 'item is already fully repaired');

  const next = removeInstanceQuantity(original, consumableInstanceId, 1);
  const nextTarget = next.items.find((entry) => entry.instanceId === targetInstanceId);
  if (!nextTarget) return repairFailure(original, 'repair target disappeared during transaction');
  const durabilityBefore = nextTarget.durability;
  nextTarget.durability = Math.min(100, nextTarget.durability + repair.amount);
  return {
    success: true,
    inventory: next,
    targetInstanceId,
    restoredDurability: nextTarget.durability - durabilityBefore,
    consumedDefinitionId: consumableDefinition.id,
  };
}

export function isItemUsable(
  item: Readonly<SavedItemInstance>,
  definition: Readonly<ItemDefinition>,
): boolean {
  return item.definitionId === definition.id && (!definition.hasDurability || item.durability > 0);
}

export function durabilityCondition(item: Readonly<SavedItemInstance>): 'broken' | 'worn' | 'ready' {
  if (item.durability <= 0) {
    return 'broken';
  }
  return item.durability < 25 ? 'worn' : 'ready';
}

export function craftRecipe(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  recipe: Readonly<RecipeDefinition>,
  bench: 'safehouse' | 'field',
  outputInstanceId: string,
): CraftResult {
  const original = cloneInventory(inventory);
  const inventoryErrors = validateInventory(original, definitions);
  if (inventoryErrors.length > 0) {
    return craftFailure(original, `source inventory is invalid: ${inventoryErrors.join('; ')}`);
  }
  const recipeErrors = validateCraftingRecipe(recipe, definitions);
  if (recipeErrors.length > 0) {
    return craftFailure(original, `recipe is invalid: ${recipeErrors.join('; ')}`);
  }
  if (bench !== 'safehouse' || bench !== recipe.bench) {
    return craftFailure(original, 'recipe requires a safehouse bench');
  }
  if (outputInstanceId.trim().length === 0) {
    return craftFailure(original, 'output instance id must not be empty');
  }
  const required = new Map<string, number>();
  for (const ingredient of recipe.ingredients) {
    required.set(ingredient.itemId, (required.get(ingredient.itemId) ?? 0) + ingredient.quantity);
  }
  for (const [itemId, quantity] of required) {
    if (countItem(inventory, itemId) < quantity) {
      return craftFailure(original, `missing ${quantity} of ingredient "${itemId}"`);
    }
  }

  let working = cloneInventory(inventory);
  for (const [itemId, quantity] of required) {
    working = removeItemQuantity(working, itemId, quantity);
  }
  const added = addItem(working, definitions, {
    definitionId: recipe.output.itemId,
    quantity: recipe.output.quantity,
    instanceIdBase: outputInstanceId,
  });
  if (!added.success) {
    return craftFailure(original, added.reason);
  }
  return {
    success: true,
    inventory: added.inventory,
    consumed: [...required].map(([itemId, quantity]) => ({ itemId, quantity })),
    produced: { itemId: recipe.output.itemId, quantity: recipe.output.quantity },
  };
}

export function validateCraftingRecipe(
  recipe: Readonly<RecipeDefinition>,
  definitions: readonly ItemDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const catalog = itemCatalog(definitions);
  if (recipe.bench !== 'safehouse') errors.push('recipe must be restricted to the safehouse bench');
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    errors.push('recipe must include at least one ingredient');
  }
  const ingredientIds = new Set<string>();
  for (const ingredient of recipe.ingredients ?? []) {
    if (ingredientIds.has(ingredient.itemId)) {
      errors.push(`ingredient "${ingredient.itemId}" must not be duplicated`);
    }
    ingredientIds.add(ingredient.itemId);
    const definition = catalog.get(ingredient.itemId);
    if (!definition) {
      errors.push(`ingredient "${ingredient.itemId}" is unknown`);
    } else if (definition.category !== 'component') {
      errors.push(`ingredient "${ingredient.itemId}" must be a crafting component`);
    }
    if (!Number.isSafeInteger(ingredient.quantity) || ingredient.quantity < 1) {
      errors.push(`ingredient "${ingredient.itemId}" quantity must be a positive integer`);
    }
  }
  const output = catalog.get(recipe.output?.itemId);
  if (!output) {
    errors.push(`output "${recipe.output?.itemId ?? ''}" is unknown`);
  } else {
    if (!['ammo', 'consumable', 'attachment'].includes(output.category)) {
      errors.push('only ammunition, consumables, and attachments may be crafted');
    }
    if (
      !Number.isSafeInteger(recipe.output.quantity)
      || recipe.output.quantity < 1
      || recipe.output.quantity > output.maximumStack
    ) {
      errors.push(`output quantity must be between 1 and ${output.maximumStack}`);
    }
  }
  if (!Number.isFinite(recipe.craftSeconds) || recipe.craftSeconds <= 0) {
    errors.push('craft time must be positive and finite');
  }
  return errors;
}

function removeItemQuantity(
  inventory: Readonly<SavedInventory>,
  definitionId: string,
  quantity: number,
): SavedInventory {
  const next = cloneInventory(inventory);
  let remaining = quantity;
  for (const item of next.items) {
    if (item.definitionId !== definitionId || remaining === 0) {
      continue;
    }
    const removed = Math.min(item.quantity, remaining);
    item.quantity -= removed;
    remaining -= removed;
  }
  next.items = next.items.filter((item) => item.quantity > 0);
  if (remaining !== 0) {
    throw new Error(`cannot remove unavailable item quantity for "${definitionId}"`);
  }
  return next;
}

function removeInstanceQuantity(
  inventory: Readonly<SavedInventory>,
  instanceId: string,
  quantity: number,
): SavedInventory {
  const next = cloneInventory(inventory);
  const item = next.items.find((entry) => entry.instanceId === instanceId);
  if (!item || quantity < 1 || quantity > item.quantity) {
    throw new Error(`cannot remove unavailable quantity from "${instanceId}"`);
  }
  item.quantity -= quantity;
  if (item.quantity === 0) {
    next.items = next.items.filter((entry) => entry.instanceId !== instanceId);
  }
  return next;
}

function packInventoryItem(
  index: number,
  ordered: readonly SavedItemInstance[],
  packed: SavedInventory,
  catalog: ReadonlyMap<string, ItemDefinition>,
  deadEnds: Set<string>,
): boolean {
  if (index >= ordered.length) return true;
  const item = ordered[index];
  if (!item) return true;
  const definition = catalog.get(item.definitionId);
  if (!definition) return false;
  const occupancy = inventoryOccupancyKey(packed, catalog);
  const deadEndKey = `${index}:${occupancy}`;
  if (deadEnds.has(deadEndKey)) return false;

  const orientations = definition.shape.width === definition.shape.height
    ? [false]
    : [false, true];
  for (const rotated of orientations) {
    const dimensions = itemDimensions(definition, rotated);
    for (let y = 0; y <= packed.gridHeight - dimensions.height; y += 1) {
      for (let x = 0; x <= packed.gridWidth - dimensions.width; x += 1) {
        const candidate = { ...item, x, y, rotated };
        const blocked = packed.items.some((placed) => {
          const placedDefinition = catalog.get(placed.definitionId);
          return !placedDefinition || overlaps(candidate, definition, placed, placedDefinition);
        });
        if (blocked) continue;
        packed.items.push(candidate);
        if (packInventoryItem(index + 1, ordered, packed, catalog, deadEnds)) return true;
        packed.items.pop();
      }
    }
  }
  deadEnds.add(deadEndKey);
  return false;
}

function inventoryOccupancyKey(
  inventory: Readonly<SavedInventory>,
  catalog: ReadonlyMap<string, ItemDefinition>,
): string {
  const occupied = Array.from({ length: inventory.gridWidth * inventory.gridHeight }, () => '0');
  for (const item of inventory.items) {
    const definition = catalog.get(item.definitionId);
    if (!definition) continue;
    const dimensions = itemDimensions(definition, item.rotated);
    for (let y = item.y; y < item.y + dimensions.height; y += 1) {
      for (let x = item.x; x < item.x + dimensions.width; x += 1) {
        occupied[y * inventory.gridWidth + x] = '1';
      }
    }
  }
  return occupied.join('');
}

function findFirstPlacement(
  inventory: Readonly<SavedInventory>,
  definition: Readonly<ItemDefinition>,
  catalog: ReadonlyMap<string, ItemDefinition>,
): { x: number; y: number; rotated: boolean } | null {
  const orientations = definition.shape.width === definition.shape.height
    ? [false]
    : [false, true];
  for (const rotated of orientations) {
    const dimensions = itemDimensions(definition, rotated);
    for (let y = 0; y <= inventory.gridHeight - dimensions.height; y += 1) {
      for (let x = 0; x <= inventory.gridWidth - dimensions.width; x += 1) {
        const candidate: SavedItemInstance = {
          instanceId: '__candidate__',
          definitionId: definition.id,
          quantity: 1,
          durability: 100,
          x,
          y,
          rotated,
        };
        const blocked = inventory.items.some((item) => {
          const otherDefinition = catalog.get(item.definitionId);
          return !otherDefinition || overlaps(candidate, definition, item, otherDefinition);
        });
        if (!blocked) {
          return { x, y, rotated };
        }
      }
    }
  }
  return null;
}

function fitsWithinGrid(
  inventory: Readonly<SavedInventory>,
  item: Readonly<SavedItemInstance>,
  definition: Readonly<ItemDefinition>,
): boolean {
  const dimensions = itemDimensions(definition, item.rotated);
  return item.x >= 0
    && item.y >= 0
    && item.x + dimensions.width <= inventory.gridWidth
    && item.y + dimensions.height <= inventory.gridHeight;
}

function overlaps(
  left: Readonly<SavedItemInstance>,
  leftDefinition: Readonly<ItemDefinition>,
  right: Readonly<SavedItemInstance>,
  rightDefinition: Readonly<ItemDefinition>,
): boolean {
  const leftSize = itemDimensions(leftDefinition, left.rotated);
  const rightSize = itemDimensions(rightDefinition, right.rotated);
  return left.x < right.x + rightSize.width
    && left.x + leftSize.width > right.x
    && left.y < right.y + rightSize.height
    && left.y + leftSize.height > right.y;
}

function itemDimensions(
  definition: Readonly<ItemDefinition>,
  rotated: boolean,
): { width: number; height: number } {
  return rotated
    ? { width: definition.shape.height, height: definition.shape.width }
    : { width: definition.shape.width, height: definition.shape.height };
}

function itemCatalog(definitions: readonly ItemDefinition[]): ReadonlyMap<string, ItemDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function validateItemDefinition(definition: Readonly<ItemDefinition>): readonly string[] {
  const errors: string[] = [];
  if (
    !Number.isSafeInteger(definition.shape.width)
    || !Number.isSafeInteger(definition.shape.height)
    || definition.shape.width < 1
    || definition.shape.height < 1
  ) {
    errors.push('shape dimensions must be positive integers');
  }
  if (!Number.isFinite(definition.weightKg) || definition.weightKg < 0) {
    errors.push('weight must be non-negative and finite');
  }
  if (!Number.isSafeInteger(definition.maximumStack) || definition.maximumStack < 1) {
    errors.push('maximum stack must be a positive integer');
  }
  if (
    definition.category === 'quest'
    && (definition.weightKg !== 0 || definition.discardable || definition.maximumStack !== 1)
  ) {
    errors.push('quest items must be weightless and non-discardable with maximum stack 1');
  }
  return errors;
}

function cloneInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return {
    gridWidth: inventory.gridWidth,
    gridHeight: inventory.gridHeight,
    maxWeightKg: inventory.maxWeightKg,
    items: inventory.items.map((item) => ({ ...item })),
  };
}

function failure(inventory: SavedInventory, reason: string): InventoryTransactionResult {
  return { success: false, inventory, reason };
}

function craftFailure(inventory: SavedInventory, reason: string): CraftResult {
  return { success: false, inventory, reason };
}

function useFailure(inventory: SavedInventory, reason: string): InventoryUseResult {
  return { success: false, inventory, reason };
}

function repairFailure(inventory: SavedInventory, reason: string): InventoryRepairResult {
  return { success: false, inventory, reason };
}

function transferFailure(
  source: SavedInventory,
  destination: SavedInventory,
  reason: string,
): TransferResult {
  return { success: false, source, destination, reason };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}
