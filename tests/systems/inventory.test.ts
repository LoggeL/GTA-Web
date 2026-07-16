import { describe, expect, it } from 'vitest';

import type { ItemDefinition, RecipeDefinition } from '../../src/data/types';
import {
  addItem,
  countItem,
  craftRecipe,
  createInventory,
  damageItemDurability,
  durabilityCondition,
  inventoryWeight,
  moveItem,
  splitStack,
  transferItem,
  validateInventory,
} from '../../src/systems/inventory';

const ITEMS: readonly ItemDefinition[] = [
  {
    id: 'ammo', name: 'Ammo', description: '', category: 'ammo',
    shape: { width: 1, height: 1 }, weightKg: 0.1, maximumStack: 10,
    baseValue: 1, hasDurability: false, discardable: true,
  },
  {
    id: 'rifle', name: 'Rifle', description: '', category: 'weapon',
    shape: { width: 3, height: 1 }, weightKg: 5, maximumStack: 1,
    baseValue: 100, hasDurability: true, discardable: true,
  },
  {
    id: 'scrap', name: 'Scrap', description: '', category: 'component',
    shape: { width: 1, height: 1 }, weightKg: 0.2, maximumStack: 20,
    baseValue: 2, hasDurability: false, discardable: true,
  },
  {
    id: 'cloth', name: 'Cloth', description: '', category: 'component',
    shape: { width: 1, height: 1 }, weightKg: 0.1, maximumStack: 20,
    baseValue: 2, hasDurability: false, discardable: true,
  },
  {
    id: 'medkit', name: 'Medkit', description: '', category: 'consumable',
    shape: { width: 2, height: 2 }, weightKg: 1, maximumStack: 3,
    baseValue: 20, hasDurability: false, discardable: true,
  },
];

const MEDKIT_RECIPE: RecipeDefinition = {
  id: 'medkit-recipe',
  name: 'Medkit',
  description: '',
  bench: 'safehouse',
  ingredients: [{ itemId: 'scrap', quantity: 2 }, { itemId: 'cloth', quantity: 3 }],
  output: { itemId: 'medkit', quantity: 1 },
  craftSeconds: 1,
};

function mustAdd(
  inventory: ReturnType<typeof createInventory>,
  definitionId: string,
  quantity: number,
  id: string,
  durability?: number,
): ReturnType<typeof createInventory> {
  const result = addItem(inventory, ITEMS, {
    definitionId,
    quantity,
    instanceIdBase: id,
    durability,
  });
  if (!result.success) throw new Error(result.reason);
  return result.inventory;
}

describe('tactical inventory', () => {
  it('fills existing stacks then creates deterministic row-major stacks', () => {
    const inventory = mustAdd(createInventory(4, 2, 20), 'ammo', 25, 'ammo-stack');

    expect(inventory.items.map(({ instanceId, quantity, x, y }) => ({ instanceId, quantity, x, y }))).toEqual([
      { instanceId: 'ammo-stack', quantity: 10, x: 0, y: 0 },
      { instanceId: 'ammo-stack-2', quantity: 10, x: 1, y: 0 },
      { instanceId: 'ammo-stack-3', quantity: 5, x: 2, y: 0 },
    ]);
    const toppedUp = mustAdd(inventory, 'ammo', 3, 'unused-id');
    expect(toppedUp.items[2]?.quantity).toBe(8);
    expect(inventory.items[2]?.quantity).toBe(5);
    expect(inventoryWeight(toppedUp, ITEMS)).toBeCloseTo(2.8);
  });

  it('rotates items when that is the first valid placement', () => {
    const result = addItem(createInventory(1, 3, 10), ITEMS, {
      definitionId: 'rifle', quantity: 1, instanceIdBase: 'rifle-1', durability: 80,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.inventory.items[0]?.rotated).toBe(true);
      expect(validateInventory(result.inventory, ITEMS)).toEqual([]);
    }
  });

  it('rejects overweight or full-grid additions atomically', () => {
    const small = createInventory(1, 1, 1);
    expect(addItem(small, ITEMS, {
      definitionId: 'rifle', quantity: 1, instanceIdBase: 'heavy',
    })).toEqual(expect.objectContaining({ success: false, inventory: small }));

    const full = mustAdd(createInventory(1, 1, 10), 'ammo', 1, 'occupant');
    const rejected = addItem(full, ITEMS, {
      definitionId: 'ammo', quantity: 20, instanceIdBase: 'more',
    });
    expect(rejected.success).toBe(false);
    expect(rejected.inventory).toEqual(full);
  });

  it('moves, rotates, splits, and rejects overlap', () => {
    let inventory = mustAdd(createInventory(4, 2, 20), 'ammo', 8, 'ammo-1');
    inventory = mustAdd(inventory, 'ammo', 2, 'ammo-2');
    const split = splitStack(inventory, ITEMS, 'ammo-1', 3, 'ammo-split');
    expect(split.success).toBe(true);
    if (!split.success) return;
    expect(split.inventory.items).toHaveLength(2);
    expect(countItem(split.inventory, 'ammo')).toBe(10);

    const blocked = moveItem(split.inventory, ITEMS, 'ammo-split', 0, 0, false);
    expect(blocked.success).toBe(false);
    const moved = moveItem(split.inventory, ITEMS, 'ammo-split', 3, 1, false);
    expect(moved.success).toBe(true);
  });

  it('transfers atomically and preserves durability', () => {
    const source = mustAdd(createInventory(3, 2, 20), 'rifle', 1, 'rifle-source', 42);
    const destination = createInventory(3, 2, 20);
    const transferred = transferItem(source, destination, ITEMS, {
      instanceId: 'rifle-source', quantity: 1, destinationInstanceId: 'rifle-destination',
    });
    expect(transferred.success).toBe(true);
    if (!transferred.success) return;
    expect(transferred.source.items).toEqual([]);
    expect(transferred.destination.items[0]?.durability).toBe(42);

    const noRoom = transferItem(source, createInventory(1, 1, 20), ITEMS, {
      instanceId: 'rifle-source', quantity: 1, destinationInstanceId: 'blocked',
    });
    expect(noRoom.success).toBe(false);
    expect(noRoom.source).toEqual(source);
  });

  it('tracks worn and broken durability without negative values', () => {
    const inventory = mustAdd(createInventory(3, 1, 20), 'rifle', 1, 'rifle', 30);
    const worn = damageItemDurability(inventory, ITEMS, 'rifle', 10);
    expect(worn.success).toBe(true);
    if (!worn.success) return;
    expect(durabilityCondition(worn.inventory.items[0]!)).toBe('worn');

    const broken = damageItemDurability(worn.inventory, ITEMS, 'rifle', 100);
    expect(broken.success).toBe(true);
    if (broken.success) {
      expect(broken.inventory.items[0]?.durability).toBe(0);
      expect(durabilityCondition(broken.inventory.items[0]!)).toBe('broken');
    }
  });

  it('crafts utilities as an all-or-nothing safehouse transaction', () => {
    let inventory = mustAdd(createInventory(5, 3, 20), 'scrap', 2, 'scrap');
    inventory = mustAdd(inventory, 'cloth', 3, 'cloth');
    const crafted = craftRecipe(inventory, ITEMS, MEDKIT_RECIPE, 'safehouse', 'crafted-medkit');

    expect(crafted.success).toBe(true);
    if (!crafted.success) return;
    expect(countItem(crafted.inventory, 'scrap')).toBe(0);
    expect(countItem(crafted.inventory, 'cloth')).toBe(0);
    expect(countItem(crafted.inventory, 'medkit')).toBe(1);
    expect(inventory).not.toEqual(crafted.inventory);

    const field = craftRecipe(inventory, ITEMS, MEDKIT_RECIPE, 'field', 'nope');
    expect(field.success).toBe(false);
    expect(field.inventory).toEqual(inventory);
  });

  it('reports malformed grid state', () => {
    const invalid = createInventory(2, 1, 20);
    invalid.items = [
      { instanceId: 'a', definitionId: 'ammo', quantity: 11, durability: 100, x: 0, y: 0, rotated: false },
      { instanceId: 'b', definitionId: 'ammo', quantity: 1, durability: 100, x: 0, y: 0, rotated: false },
    ];
    expect(validateInventory(invalid, ITEMS)).toEqual(expect.arrayContaining([
      expect.stringContaining('quantity'),
      expect.stringContaining('overlaps'),
    ]));
  });
});
