import { describe, expect, it } from 'vitest';

import type { SavedInventory } from '../../src/core/state';
import { ITEMS, RECIPES, WEAPONS } from '../../src/data/items';
import { unlockRecipe } from '../../src/systems/crafting';
import { addItem } from '../../src/systems/inventory';
import {
  assignQuickLoadout,
  autoSortTacticalContainer,
  createTacticalInventoryState,
  restoreTacticalInventorySaveFields,
  restoreTacticalInventorySnapshot,
  snapshotTacticalInventory,
  tacticalInventorySaveFields,
  transferAllTacticalItems,
  transferTacticalItem,
  validateTacticalInventoryState,
  type TacticalInventorySnapshotV1,
  type TacticalInventoryState,
} from '../../src/systems/tacticalInventory';

function carry(
  state: TacticalInventoryState,
  definitionId: string,
  quantity: number,
  instanceId: string,
  durability?: number,
): TacticalInventoryState {
  const result = addItem(state.backpack, ITEMS, {
    definitionId,
    quantity,
    instanceIdBase: instanceId,
    durability,
  });
  if (!result.success) throw new Error(result.reason);
  return { ...state, backpack: result.inventory };
}

function cloneSnapshot(snapshot: TacticalInventorySnapshotV1): TacticalInventorySnapshotV1 {
  return JSON.parse(JSON.stringify(snapshot)) as TacticalInventorySnapshotV1;
}

describe('tactical inventory aggregate', () => {
  it('creates a valid 8x6 backpack, unlimited stash, locked recipes, and 6x4 trunks', () => {
    const state = createTacticalInventoryState(1, ['vehicle-b', 'vehicle-a']);
    expect(state.backpack).toEqual({ gridWidth: 8, gridHeight: 6, maxWeightKg: 22, items: [] });
    expect(Object.keys(state.trunks)).toEqual(['vehicle-a', 'vehicle-b']);
    expect(state.trunks['vehicle-a']).toEqual({ gridWidth: 6, gridHeight: 4, maxWeightKg: 192, items: [] });
    expect(state.stash).toEqual([]);
    expect(state.recipeUnlocks.unlockedRecipeIds).toEqual([]);
    expect(validateTacticalInventoryState(state, ITEMS, WEAPONS, RECIPES, 1)).toEqual([]);
  });

  it('enforces exactly two firearm, one melee, and two consumable slots', () => {
    let state = createTacticalInventoryState(6);
    state = carry(state, 'pistol-tier-1', 1, 'pistol');
    state = carry(state, 'smg-tier-1', 1, 'smg');
    state = carry(state, 'melee-tier-2', 1, 'melee');
    state = carry(state, 'medkit', 1, 'medkit');
    state = carry(state, 'armor-repair-plate', 1, 'plate');

    for (const [slot, instanceId] of [
      ['firearm-1', 'pistol'],
      ['firearm-2', 'smg'],
      ['melee', 'melee'],
      ['consumable-1', 'medkit'],
      ['consumable-2', 'plate'],
    ] as const) {
      const assigned = assignQuickLoadout(state, ITEMS, WEAPONS, slot, instanceId);
      expect(assigned.success).toBe(true);
      if (assigned.success) state = assigned.state;
    }
    expect(state.quickLoadout).toEqual({
      firearms: ['pistol', 'smg'],
      melee: 'melee',
      consumables: ['medkit', 'plate'],
    });
    expect(validateTacticalInventoryState(state, ITEMS, WEAPONS, RECIPES, 6)).toEqual([]);

    const wrongSlot = assignQuickLoadout(state, ITEMS, WEAPONS, 'firearm-1', 'medkit');
    expect(wrongSlot).toEqual(expect.objectContaining({ success: false, state }));
    const duplicate = assignQuickLoadout(state, ITEMS, WEAPONS, 'firearm-2', 'pistol');
    expect(duplicate).toEqual(expect.objectContaining({ success: false, state }));

    let brokenState = createTacticalInventoryState(6);
    brokenState = carry(brokenState, 'pistol-tier-1', 1, 'broken', 0);
    expect(assignQuickLoadout(brokenState, ITEMS, WEAPONS, 'firearm-1', 'broken').success).toBe(false);
  });

  it('transfers atomically among backpack, abstract stash, and trunk while pruning loadout', () => {
    let state = createTacticalInventoryState(6, ['sedan-1']);
    state = carry(state, 'pistol-tier-1', 1, 'pistol', 37);
    state = carry(state, 'ammo-handgun', 50, 'rounds');
    const equipped = assignQuickLoadout(state, ITEMS, WEAPONS, 'firearm-1', 'pistol');
    expect(equipped.success).toBe(true);
    if (!equipped.success) return;
    state = equipped.state;

    const deposited = transferTacticalItem(state, ITEMS, {
      source: { kind: 'backpack' },
      destination: { kind: 'stash' },
      instanceId: 'pistol',
      quantity: 1,
      destinationInstanceId: 'pistol',
    });
    expect(deposited.success).toBe(true);
    if (!deposited.success) return;
    expect(deposited.state.quickLoadout.firearms[0]).toBeNull();
    expect(deposited.state.stash[0]).toEqual(expect.objectContaining({
      instanceId: 'pistol', durability: 37, x: 0, y: 0, rotated: false,
    }));

    const partial = transferTacticalItem(deposited.state, ITEMS, {
      source: { kind: 'backpack' },
      destination: { kind: 'trunk', vehicleInstanceId: 'sedan-1' },
      instanceId: 'rounds',
      quantity: 20,
      destinationInstanceId: 'trunk-rounds',
    });
    expect(partial.success).toBe(true);
    if (!partial.success) return;
    expect(partial.state.backpack.items.find(({ instanceId }) => instanceId === 'rounds')?.quantity).toBe(30);
    expect(partial.state.trunks['sedan-1']?.items[0]?.quantity).toBe(20);

    const withdrawn = transferTacticalItem(partial.state, ITEMS, {
      source: { kind: 'stash' },
      destination: { kind: 'backpack' },
      instanceId: 'pistol',
      quantity: 1,
      destinationInstanceId: 'pistol',
    });
    expect(withdrawn.success).toBe(true);
    if (!withdrawn.success) return;
    expect(withdrawn.state.stash).toEqual([]);
    expect(withdrawn.state.backpack.items.find(({ instanceId }) => instanceId === 'pistol')?.durability).toBe(37);
    expect(validateTacticalInventoryState(withdrawn.state, ITEMS, WEAPONS, RECIPES, 6)).toEqual([]);
  });

  it('allows quest storage but retains quest weight/discard invariants', () => {
    let state = createTacticalInventoryState(1);
    state = carry(state, 'quest-encrypted-ledger', 1, 'ledger');
    const moved = transferTacticalItem(state, ITEMS, {
      source: { kind: 'backpack' },
      destination: { kind: 'stash' },
      instanceId: 'ledger',
      quantity: 1,
      destinationInstanceId: 'ledger',
    });
    expect(moved.success).toBe(true);
    if (!moved.success) return;
    expect(moved.state.stash[0]).toEqual(expect.objectContaining({ definitionId: 'quest-encrypted-ledger' }));
    expect(validateTacticalInventoryState(moved.state, ITEMS, WEAPONS, RECIPES, 1)).toEqual([]);
  });

  it('rolls back transfer-all if any shaped destination placement fails', () => {
    let state = createTacticalInventoryState(1, ['tiny']);
    state = carry(state, 'component-scrap', 1, 'scrap');
    state = carry(state, 'component-cloth', 1, 'cloth');
    const tiny: SavedInventory = { gridWidth: 1, gridHeight: 1, maxWeightKg: 100, items: [] };
    state = { ...state, trunks: { tiny } };
    const moved = transferAllTacticalItems(
      state,
      ITEMS,
      { kind: 'backpack' },
      { kind: 'trunk', vehicleInstanceId: 'tiny' },
    );
    expect(moved.success).toBe(false);
    expect(moved.state).toEqual(state);
  });

  it('auto-sorts either a shaped container or the unlimited abstract stash deterministically', () => {
    let state = createTacticalInventoryState(6);
    state = carry(state, 'rifle-tier-1', 1, 'rifle', 71);
    state = carry(state, 'component-cloth', 3, 'cloth');
    const sorted = autoSortTacticalContainer(state, ITEMS, { kind: 'backpack' });
    expect(sorted.success).toBe(true);
    if (!sorted.success) return;
    const repeated = autoSortTacticalContainer(state, ITEMS, { kind: 'backpack' });
    expect(repeated).toEqual(sorted);
  });

  it('round-trips a versioned snapshot and validates persistence invariants deeply', () => {
    let state = createTacticalInventoryState(4, ['owned-car']);
    state = carry(state, 'pistol-tier-2', 1, 'sidearm', 88);
    state = carry(state, 'medkit', 2, 'medkit');
    const equipped = assignQuickLoadout(state, ITEMS, WEAPONS, 'firearm-1', 'sidearm');
    if (!equipped.success) throw new Error(equipped.reason);
    state = equipped.state;
    const unlocked = unlockRecipe(state.recipeUnlocks, RECIPES, RECIPES[0]!.id);
    if (!unlocked.success) throw new Error(unlocked.reason);
    state = { ...state, recipeUnlocks: unlocked.state };
    const stored = transferTacticalItem(state, ITEMS, {
      source: { kind: 'backpack' }, destination: { kind: 'stash' },
      instanceId: 'medkit', quantity: 1, destinationInstanceId: 'stash-medkit',
    });
    if (!stored.success) throw new Error(stored.reason);
    state = stored.state;

    const snapshot = snapshotTacticalInventory(state);
    const restored = restoreTacticalInventorySnapshot(snapshot, ITEMS, WEAPONS, RECIPES, 4, ['owned-car']);
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    expect(snapshotTacticalInventory(restored.state)).toEqual(snapshot);
    const saveFields = tacticalInventorySaveFields(restored.state);
    const restoredFromSave = restoreTacticalInventorySaveFields(
      saveFields,
      ITEMS,
      WEAPONS,
      RECIPES,
      4,
      ['owned-car'],
    );
    expect(restoredFromSave.success).toBe(true);
    snapshot.backpack.items[0]!.durability = 1;
    expect(restored.state.backpack.items[0]?.durability).toBe(88);
  });

  it('rejects corrupted capacities, duplicates, loadout types, stash coordinates, and orphan trunks', () => {
    let state = createTacticalInventoryState(2, ['owned-car']);
    state = carry(state, 'pistol-tier-1', 1, 'item');
    const base = snapshotTacticalInventory(state);
    const cases: readonly [string, (snapshot: TacticalInventorySnapshotV1) => void][] = [
      ['capacity', (snapshot) => { snapshot.backpack.maxWeightKg = 999; }],
      ['duplicate', (snapshot) => { snapshot.stash.push({ ...snapshot.backpack.items[0]!, x: 0, y: 0, rotated: false }); }],
      ['loadout', (snapshot) => { snapshot.quickLoadout.consumables[0] = 'item'; }],
      ['stash coordinates', (snapshot) => {
        snapshot.stash.push({
          instanceId: 'stash-item', definitionId: 'medkit', quantity: 1,
          durability: 100, x: 1, y: 0, rotated: false,
        });
      }],
    ];
    for (const [label, mutate] of cases) {
      const corrupt = cloneSnapshot(base);
      mutate(corrupt);
      const restored = restoreTacticalInventorySnapshot(corrupt, ITEMS, WEAPONS, RECIPES, 2, ['owned-car']);
      expect(restored.success, label).toBe(false);
    }
    const orphan = restoreTacticalInventorySnapshot(base, ITEMS, WEAPONS, RECIPES, 2, ['different-car']);
    expect(orphan).toEqual(expect.objectContaining({ success: false }));
    expect(restoreTacticalInventorySnapshot({ schemaVersion: 99 }, ITEMS, WEAPONS, RECIPES, 2).success).toBe(false);
  });
});
