import { describe, expect, it } from 'vitest';
import { ITEMS, RECIPES } from '../../src/data';
import { addItem } from '../../src/systems/inventory';
import { createTacticalInventoryState } from '../../src/systems/tacticalInventory';
import { unlockRecipe } from '../../src/systems/crafting';
import {
  createInventoryPanelModel,
  parseInventoryPanelActionDataset,
  renderInventoryPanel,
} from '../../src/ui/InventoryPanel';

describe('InventoryPanel', () => {
  it('renders the shaped 8x6 backpack, loadout, storage, and nine recipes', () => {
    const state = createTacticalInventoryState(1, ['car-1']);
    const added = addItem(state.backpack, ITEMS, {
      definitionId: 'medkit', quantity: 1, instanceIdBase: 'medkit-1',
    });
    if (!added.success) throw new Error(added.reason);
    state.backpack = added.inventory;
    state.recipeUnlocks = RECIPES.reduce((unlocks, recipe) => {
      const result = unlockRecipe(unlocks, RECIPES, recipe.id);
      return result.success ? result.state : unlocks;
    }, state.recipeUnlocks);
    const model = createInventoryPanelModel({
      tactical: state,
      selectedInstanceId: 'medkit-1',
      safehouseBench: true,
      activeTrunkId: 'car-1',
    });
    expect(model.backpack.gridWidth).toBe(8);
    expect(model.backpack.gridHeight).toBe(6);
    expect(model.loadout).toHaveLength(5);
    expect(model.recipes).toHaveLength(9);
    expect(renderInventoryPanel(model)).toContain('data-inventory-panel="true"');
    expect(renderInventoryPanel(model)).toContain('aria-pressed="true"');
    expect(renderInventoryPanel(model)).not.toContain('data-inventory-action="move" data-inventory-x="0" data-inventory-y="0" aria-label="Move selected item to column 1, row 1" disabled');
  });

  it('parses touch/grid/loadout actions and rejects malformed coordinates', () => {
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '3', inventoryY: '2' }))
      .toEqual({ type: 'move', x: 3, y: 2 });
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'assign-loadout', loadoutSlot: 'firearm-1' }))
      .toEqual({ type: 'assign-loadout', slot: 'firearm-1' });
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'transfer', destinationKind: 'stash' }))
      .toEqual({ type: 'transfer', destination: { kind: 'stash' } });
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '-1', inventoryY: 'x' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '', inventoryY: '2' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: ' 3 ', inventoryY: '2' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '3.0', inventoryY: '2' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '8', inventoryY: '2' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'move', inventoryX: '3', inventoryY: '6' })).toBeNull();
    expect(parseInventoryPanelActionDataset({ inventoryAction: 'craft', recipeId: 'unknown-recipe' })).toBeNull();
  });

  it('ignores inherited trunk keys when the active vehicle has no owned trunk', () => {
    const state = createTacticalInventoryState(1);
    const model = createInventoryPanelModel({
      tactical: state,
      selectedInstanceId: null,
      safehouseBench: false,
      activeTrunkId: 'toString',
    });

    expect(model.activeTrunkId).toBeNull();
    expect(model.trunkItems).toEqual([]);
    expect(renderInventoryPanel(model)).toContain('Vehicle trunk');
    expect(renderInventoryPanel(model)).toContain('Enter an owned vehicle');
  });

  it('disables backpack-only contextual actions for stored items', () => {
    const state = createTacticalInventoryState(1);
    const added = addItem(state.backpack, ITEMS, {
      definitionId: 'medkit', quantity: 2, instanceIdBase: 'stored-medkit',
    });
    if (!added.success) throw new Error(added.reason);
    const stored = added.inventory.items[0];
    if (!stored) throw new Error('Expected a stored item fixture');
    state.stash = [{ ...stored, x: 0, y: 0, rotated: false }];

    const html = renderInventoryPanel(createInventoryPanelModel({
      tactical: state,
      selectedInstanceId: stored.instanceId,
      safehouseBench: false,
      activeTrunkId: null,
    }));

    expect(html).toContain('data-inventory-action="split" disabled aria-disabled="true"');
    expect(html).toContain('data-inventory-action="use" disabled aria-disabled="true"');
    expect(html).toContain('title="Move this item to the backpack first"');
    expect(html).toContain('data-inventory-action="move" data-inventory-x="0" data-inventory-y="0" aria-label="Move selected item to column 1, row 1" disabled aria-disabled="true"');
  });
});
