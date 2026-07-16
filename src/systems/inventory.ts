import type { ItemDefinition, RecipeDefinition } from '../data/types';
import type { SavedInventory, SavedItemInstance } from '../core/state';

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

export function transferItem(
  source: Readonly<SavedInventory>,
  destination: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  request: Readonly<TransferRequest>,
): TransferResult {
  const sourceOriginal = cloneInventory(source);
  const destinationOriginal = cloneInventory(destination);
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
  if (bench !== recipe.bench) {
    return craftFailure(original, 'recipe requires a safehouse bench');
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
