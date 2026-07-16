import { describe, expect, it } from 'vitest';

import type { ItemDefinition } from '../../src/data/types';
import {
  addItem,
  autoSortInventory,
  backpackWeightCapacity,
  createBackpack,
  createInventory,
  createTacticalVehicleTrunk,
  discardItem,
  isItemUsable,
  repairItemDurability,
  repairItemWithConsumable,
  updateBackpackGritCapacity,
  useConsumable,
  validateInventory,
} from '../../src/systems/inventory';

const ITEMS: readonly ItemDefinition[] = [
  {
    id: 'component', name: 'Component', description: '', category: 'component',
    shape: { width: 1, height: 1 }, weightKg: 0.5, maximumStack: 20,
    baseValue: 1, hasDurability: false, discardable: true,
  },
  {
    id: 'long-tool', name: 'Long Tool', description: '', category: 'weapon',
    shape: { width: 3, height: 1 }, weightKg: 2, maximumStack: 1,
    baseValue: 10, hasDurability: true, discardable: true, weaponId: 'tool-weapon',
  },
  {
    id: 'armor', name: 'Armor', description: '', category: 'armor',
    shape: { width: 2, height: 2 }, weightKg: 3, maximumStack: 1,
    baseValue: 10, hasDurability: true, discardable: true,
  },
  {
    id: 'medkit', name: 'Medkit', description: '', category: 'consumable',
    shape: { width: 1, height: 1 }, weightKg: 0.5, maximumStack: 3,
    baseValue: 10, hasDurability: false, discardable: true,
  },
  {
    id: 'weapon-repair-kit', name: 'Weapon Repair Kit', description: '', category: 'consumable',
    shape: { width: 1, height: 1 }, weightKg: 0.5, maximumStack: 3,
    baseValue: 10, hasDurability: false, discardable: true,
  },
  {
    id: 'armor-repair-plate', name: 'Armor Repair Plate', description: '', category: 'consumable',
    shape: { width: 1, height: 1 }, weightKg: 0.5, maximumStack: 3,
    baseValue: 10, hasDurability: false, discardable: true,
  },
  {
    id: 'quest', name: 'Quest', description: '', category: 'quest',
    shape: { width: 1, height: 1 }, weightKg: 0, maximumStack: 1,
    baseValue: 0, hasDurability: false, discardable: false,
  },
];

function add(
  inventory: ReturnType<typeof createInventory>,
  definitionId: string,
  quantity: number,
  instanceIdBase: string,
  durability?: number,
) {
  const result = addItem(inventory, ITEMS, { definitionId, quantity, instanceIdBase, durability });
  if (!result.success) throw new Error(result.reason);
  return result.inventory;
}

describe('advanced tactical inventory invariants', () => {
  it('builds the authored backpack and trunk capacities from Grit', () => {
    expect(backpackWeightCapacity(1)).toBe(22);
    expect(backpackWeightCapacity(6)).toBe(32);
    expect(() => backpackWeightCapacity(0)).toThrow(/grit/i);
    expect(createBackpack(3)).toEqual({ gridWidth: 8, gridHeight: 6, maxWeightKg: 26, items: [] });
    expect(createTacticalVehicleTrunk()).toEqual({ gridWidth: 6, gridHeight: 4, maxWeightKg: 192, items: [] });
  });

  it('auto-sorts shaped items deterministically without changing item state', () => {
    let inventory = add(createInventory(4, 3, 20), 'component', 4, 'parts');
    inventory = add(inventory, 'long-tool', 1, 'tool', 43);
    const moved = autoSortInventory(inventory, ITEMS);
    const repeated = autoSortInventory(inventory, ITEMS);
    expect(moved).toEqual(repeated);
    expect(moved.success).toBe(true);
    if (!moved.success) return;
    expect(moved.inventory.items.map(({ instanceId, quantity, durability }) => ({ instanceId, quantity, durability })))
      .toEqual(expect.arrayContaining([
        { instanceId: 'tool', quantity: 1, durability: 43 },
        { instanceId: 'parts', quantity: 4, durability: 100 },
      ]));
    expect(validateInventory(moved.inventory, ITEMS)).toEqual([]);
  });

  it('never discards quest items and applies Grit changes atomically', () => {
    let backpack = add(createBackpack(1), 'quest', 1, 'mission-item');
    backpack = add(backpack, 'component', 20, 'heavy-components');
    const questRejected = discardItem(backpack, ITEMS, 'mission-item', 1);
    expect(questRejected.success).toBe(false);
    expect(questRejected.inventory).toEqual(backpack);

    const upgraded = updateBackpackGritCapacity(backpack, ITEMS, 6);
    expect(upgraded.success).toBe(true);
    if (!upgraded.success) return;
    expect(upgraded.inventory.maxWeightKg).toBe(32);
    expect(updateBackpackGritCapacity(upgraded.inventory, ITEMS, 0)).toEqual(
      expect.objectContaining({ success: false, inventory: upgraded.inventory }),
    );
  });

  it('uses consumables and repairs weapons or armor as atomic transactions', () => {
    let inventory = add(createInventory(8, 3, 40), 'long-tool', 1, 'weapon', 12);
    inventory = add(inventory, 'armor', 1, 'armor', 80);
    inventory = add(inventory, 'weapon-repair-kit', 2, 'weapon-kits');
    inventory = add(inventory, 'armor-repair-plate', 1, 'armor-plate');
    inventory = add(inventory, 'medkit', 2, 'medkits');

    const repairedWeapon = repairItemWithConsumable(inventory, ITEMS, 'weapon', 'weapon-kits');
    expect(repairedWeapon.success).toBe(true);
    if (!repairedWeapon.success) return;
    expect(repairedWeapon.inventory.items.find(({ instanceId }) => instanceId === 'weapon')?.durability).toBe(52);
    expect(repairedWeapon.inventory.items.find(({ instanceId }) => instanceId === 'weapon-kits')?.quantity).toBe(1);

    const wrongTarget = repairItemWithConsumable(repairedWeapon.inventory, ITEMS, 'armor', 'weapon-kits');
    expect(wrongTarget.success).toBe(false);
    expect(wrongTarget.inventory).toEqual(repairedWeapon.inventory);

    const repairedArmor = repairItemWithConsumable(repairedWeapon.inventory, ITEMS, 'armor', 'armor-plate');
    expect(repairedArmor.success).toBe(true);
    if (!repairedArmor.success) return;
    expect(repairedArmor.inventory.items.find(({ instanceId }) => instanceId === 'armor')?.durability).toBe(100);
    expect(repairedArmor.restoredDurability).toBe(20);

    const used = useConsumable(repairedArmor.inventory, ITEMS, 'medkits');
    expect(used.success).toBe(true);
    if (!used.success) return;
    expect(used.inventory.items.find(({ instanceId }) => instanceId === 'medkits')?.quantity).toBe(1);
    expect(useConsumable(used.inventory, ITEMS, 'weapon').success).toBe(false);

    const direct = repairItemDurability(repairedWeapon.inventory, ITEMS, 'weapon', 100);
    expect(direct.success).toBe(true);
    if (direct.success) expect(direct.inventory.items.find(({ instanceId }) => instanceId === 'weapon')?.durability).toBe(100);
    const weapon = inventory.items.find(({ instanceId }) => instanceId === 'weapon')!;
    expect(isItemUsable({ ...weapon, durability: 0 }, ITEMS[1]!)).toBe(false);
  });

  it('detects corrupt non-durable and quest persistence values', () => {
    const invalidDefinitions: readonly ItemDefinition[] = [{
      ...ITEMS[6]!,
      weightKg: 1,
      discardable: true,
    }];
    const inventory = createInventory(1, 1, 10);
    inventory.items.push({
      instanceId: 'quest', definitionId: 'quest', quantity: 1,
      durability: 50, x: 0, y: 0, rotated: false,
    });
    expect(validateInventory(inventory, invalidDefinitions)).toEqual(expect.arrayContaining([
      expect.stringContaining('must remain at 100'),
      expect.stringContaining('weightless and non-discardable'),
    ]));
  });
});
