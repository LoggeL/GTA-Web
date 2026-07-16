import { describe, expect, it } from 'vitest';

import type { ItemDefinition, RecipeDefinition } from '../../src/data/types';
import { ITEMS, RECIPES } from '../../src/data/items';
import {
  craftUnlockedRecipe,
  createLockedRecipeState,
  previewCraft,
  unlockRecipe,
  validateCraftingCatalog,
  validateRecipeUnlockState,
} from '../../src/systems/crafting';
import { addItem, countItem, createBackpack, createInventory } from '../../src/systems/inventory';

function inventoryWithIngredients(recipe: Readonly<RecipeDefinition>) {
  let inventory = createBackpack(6);
  for (const ingredient of recipe.ingredients) {
    const result = addItem(inventory, ITEMS, {
      definitionId: ingredient.itemId,
      quantity: ingredient.quantity,
      instanceIdBase: `${recipe.id}-${ingredient.itemId}`,
    });
    if (!result.success) throw new Error(result.reason);
    inventory = result.inventory;
  }
  return inventory;
}

describe('locked safehouse crafting', () => {
  it('validates all nine authored utility recipes and starts every recipe locked', () => {
    expect(RECIPES).toHaveLength(9);
    expect(validateCraftingCatalog(RECIPES, ITEMS)).toEqual([]);
    const locks = createLockedRecipeState();
    expect(locks.unlockedRecipeIds).toEqual([]);
    for (const recipe of RECIPES) {
      const preview = previewCraft(
        inventoryWithIngredients(recipe),
        ITEMS,
        RECIPES,
        locks,
        recipe.id,
        'safehouse',
      );
      expect(preview).toEqual(expect.objectContaining({ craftable: false, reason: 'recipe is locked' }));
    }
  });

  it('unlocks and atomically crafts every authored recipe at a safehouse bench', () => {
    let unlocks = createLockedRecipeState();
    for (const recipe of RECIPES) {
      const unlocked = unlockRecipe(unlocks, RECIPES, recipe.id);
      expect(unlocked.success).toBe(true);
      if (!unlocked.success) continue;
      unlocks = unlocked.state;
      const inventory = inventoryWithIngredients(recipe);
      expect(previewCraft(inventory, ITEMS, RECIPES, unlocks, recipe.id, 'safehouse').craftable).toBe(true);
      const crafted = craftUnlockedRecipe(
        inventory,
        ITEMS,
        RECIPES,
        unlocks,
        recipe.id,
        'safehouse',
        `output-${recipe.id}`,
      );
      expect(crafted.success, recipe.id).toBe(true);
      if (!crafted.success) continue;
      for (const ingredient of recipe.ingredients) {
        expect(countItem(crafted.inventory, ingredient.itemId), recipe.id).toBe(0);
      }
      expect(countItem(crafted.inventory, recipe.output.itemId), recipe.id).toBe(recipe.output.quantity);
    }
    expect(unlocks.unlockedRecipeIds).toHaveLength(9);
    expect(validateRecipeUnlockState(unlocks, RECIPES)).toEqual([]);
  });

  it('rejects field crafting, missing resources, and duplicate unlocks without mutation', () => {
    const recipe = RECIPES[0]!;
    const first = unlockRecipe(createLockedRecipeState(), RECIPES, recipe.id);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const duplicate = unlockRecipe(first.state, RECIPES, recipe.id);
    expect(duplicate).toEqual(expect.objectContaining({ success: false, state: first.state }));

    const inventory = inventoryWithIngredients(recipe);
    const field = craftUnlockedRecipe(inventory, ITEMS, RECIPES, first.state, recipe.id, 'field', 'field-output');
    expect(field).toEqual(expect.objectContaining({ success: false, inventory }));
    expect(previewCraft(createBackpack(6), ITEMS, RECIPES, first.state, recipe.id, 'safehouse'))
      .toEqual(expect.objectContaining({
        craftable: false,
        reason: 'required crafting components are missing',
      }));
    const corruptLocks = { unlockedRecipeIds: [recipe.id, recipe.id] };
    expect(craftUnlockedRecipe(
      inventory,
      ITEMS,
      RECIPES,
      corruptLocks,
      recipe.id,
      'safehouse',
      'corrupt-output',
    )).toEqual(expect.objectContaining({ success: false, inventory }));
  });

  it('never consumes ingredients when the shaped output cannot fit', () => {
    const definitions: readonly ItemDefinition[] = [
      {
        id: 'material', name: 'Material', description: '', category: 'component',
        shape: { width: 1, height: 1 }, weightKg: 0, maximumStack: 1,
        baseValue: 1, hasDurability: false, discardable: true,
      },
      {
        id: 'filler', name: 'Filler', description: '', category: 'component',
        shape: { width: 1, height: 1 }, weightKg: 0, maximumStack: 1,
        baseValue: 1, hasDurability: false, discardable: true,
      },
      {
        id: 'utility', name: 'Utility', description: '', category: 'consumable',
        shape: { width: 2, height: 2 }, weightKg: 0, maximumStack: 1,
        baseValue: 1, hasDurability: false, discardable: true,
      },
    ];
    const recipe: RecipeDefinition = {
      id: 'packed-grid', name: 'Packed', description: '', bench: 'safehouse',
      ingredients: [{ itemId: 'material', quantity: 1 }],
      output: { itemId: 'utility', quantity: 1 }, craftSeconds: 1,
    };
    let inventory = createInventory(2, 2, 10);
    for (const [id, definitionId] of [
      ['material', 'material'], ['fill-1', 'filler'], ['fill-2', 'filler'], ['fill-3', 'filler'],
    ] as const) {
      const result = addItem(inventory, definitions, { definitionId, quantity: 1, instanceIdBase: id });
      if (!result.success) throw new Error(result.reason);
      inventory = result.inventory;
    }
    const unlocks = { unlockedRecipeIds: [recipe.id] };
    const crafted = craftUnlockedRecipe(
      inventory,
      definitions,
      [recipe],
      unlocks,
      recipe.id,
      'safehouse',
      'utility-output',
    );
    expect(crafted).toEqual(expect.objectContaining({ success: false, inventory }));
    expect(countItem(crafted.inventory, 'material')).toBe(1);
  });

  it('rejects malformed recipes and complete weapon or armor outputs', () => {
    const component = ITEMS.find(({ id }) => id === 'component-scrap')!;
    const weapon = ITEMS.find(({ category }) => category === 'weapon')!;
    const armor = ITEMS.find(({ category }) => category === 'armor')!;
    const malformed: readonly RecipeDefinition[] = [weapon, armor].map((output, index) => ({
      id: `invalid-${index}`,
      name: 'Invalid',
      description: '',
      bench: 'safehouse',
      ingredients: [{ itemId: component.id, quantity: 1 }],
      output: { itemId: output.id, quantity: 1 },
      craftSeconds: 1,
    }));
    const errors = validateCraftingCatalog(malformed, ITEMS);
    expect(errors.filter((error) => error.includes('only ammunition, consumables, and attachments'))).toHaveLength(2);
  });
});
