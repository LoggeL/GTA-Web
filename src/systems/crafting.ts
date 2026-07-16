import type { SavedInventory } from '../core/state';
import type { ItemDefinition, RecipeDefinition } from '../data/types';
import {
  countItem,
  craftRecipe,
  validateCraftingRecipe,
  type CraftResult,
} from './inventory';

export interface RecipeUnlockState {
  unlockedRecipeIds: string[];
}

export interface CraftPreview {
  readonly craftable: boolean;
  readonly recipeId: string;
  readonly reason: string | null;
  readonly missingIngredients: readonly { itemId: string; quantity: number }[];
  readonly output: { itemId: string; quantity: number } | null;
  readonly craftSeconds: number;
}

export type RecipeUnlockResult =
  | { success: true; state: RecipeUnlockState; recipeId: string }
  | { success: false; state: RecipeUnlockState; reason: string };

export function createLockedRecipeState(): RecipeUnlockState {
  return { unlockedRecipeIds: [] };
}

export function unlockRecipe(
  state: Readonly<RecipeUnlockState>,
  recipes: readonly RecipeDefinition[],
  recipeId: string,
): RecipeUnlockResult {
  const original = cloneUnlockState(state);
  const stateErrors = validateRecipeUnlockState(original, recipes);
  if (stateErrors.length > 0) return unlockFailure(original, `unlock state is invalid: ${stateErrors.join('; ')}`);
  const recipe = recipes.find((entry) => entry.id === recipeId);
  if (!recipe) return unlockFailure(original, `unknown recipe "${recipeId}"`);
  if (original.unlockedRecipeIds.includes(recipeId)) {
    return unlockFailure(original, `recipe "${recipeId}" is already unlocked`);
  }
  original.unlockedRecipeIds.push(recipeId);
  original.unlockedRecipeIds.sort((left, right) => left.localeCompare(right));
  return { success: true, state: original, recipeId };
}

export function validateRecipeUnlockState(
  state: Readonly<RecipeUnlockState>,
  recipes: readonly RecipeDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const recipeIds = new Set(recipes.map((recipe) => recipe.id));
  const found = new Set<string>();
  for (const recipeId of state.unlockedRecipeIds) {
    if (typeof recipeId !== 'string' || recipeId.length === 0) {
      errors.push('unlocked recipe ids must be non-empty strings');
    } else if (found.has(recipeId)) {
      errors.push(`recipe "${recipeId}" is unlocked more than once`);
    } else if (!recipeIds.has(recipeId)) {
      errors.push(`unknown unlocked recipe "${recipeId}"`);
    }
    found.add(recipeId);
  }
  return errors;
}

export function validateCraftingCatalog(
  recipes: readonly RecipeDefinition[],
  definitions: readonly ItemDefinition[],
): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const recipe of recipes) {
    if (!recipe.id || ids.has(recipe.id)) {
      errors.push(`recipe id "${recipe.id}" must be non-empty and unique`);
    }
    ids.add(recipe.id);
    errors.push(...validateCraftingRecipe(recipe, definitions).map((error) => `${recipe.id}: ${error}`));
  }
  return errors;
}

export function previewCraft(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  recipes: readonly RecipeDefinition[],
  unlocks: Readonly<RecipeUnlockState>,
  recipeId: string,
  bench: 'safehouse' | 'field',
): CraftPreview {
  const recipe = recipes.find((entry) => entry.id === recipeId);
  if (!recipe) return failedPreview(recipeId, 'unknown recipe', [], null, 0);
  const unlockErrors = validateRecipeUnlockState(unlocks, recipes);
  if (unlockErrors.length > 0) {
    return failedPreview(recipeId, `unlock state is invalid: ${unlockErrors.join('; ')}`, [], recipe.output, recipe.craftSeconds);
  }
  const recipeErrors = validateCraftingRecipe(recipe, definitions);
  if (recipeErrors.length > 0) {
    return failedPreview(recipeId, `recipe is invalid: ${recipeErrors.join('; ')}`, [], recipe.output, recipe.craftSeconds);
  }
  if (!unlocks.unlockedRecipeIds.includes(recipeId)) {
    return failedPreview(recipeId, 'recipe is locked', [], recipe.output, recipe.craftSeconds);
  }
  if (bench !== 'safehouse') {
    return failedPreview(recipeId, 'recipe requires a safehouse bench', [], recipe.output, recipe.craftSeconds);
  }
  const required = combinedIngredients(recipe);
  const missingIngredients = [...required].flatMap(([itemId, quantity]) => {
    const missing = quantity - countItem(inventory, itemId);
    return missing > 0 ? [{ itemId, quantity: missing }] : [];
  });
  if (missingIngredients.length > 0) {
    return failedPreview(
      recipeId,
      'required crafting components are missing',
      missingIngredients,
      recipe.output,
      recipe.craftSeconds,
    );
  }
  const previewId = uniquePreviewId(inventory);
  const simulated = craftRecipe(inventory, definitions, recipe, bench, previewId);
  if (!simulated.success) {
    return failedPreview(recipeId, simulated.reason, [], recipe.output, recipe.craftSeconds);
  }
  return {
    craftable: true,
    recipeId,
    reason: null,
    missingIngredients: [],
    output: { ...recipe.output },
    craftSeconds: recipe.craftSeconds,
  };
}

export function craftUnlockedRecipe(
  inventory: Readonly<SavedInventory>,
  definitions: readonly ItemDefinition[],
  recipes: readonly RecipeDefinition[],
  unlocks: Readonly<RecipeUnlockState>,
  recipeId: string,
  bench: 'safehouse' | 'field',
  outputInstanceId: string,
): CraftResult {
  const original = cloneInventory(inventory);
  const recipe = recipes.find((entry) => entry.id === recipeId);
  if (!recipe) return { success: false, inventory: original, reason: `unknown recipe "${recipeId}"` };
  const unlockErrors = validateRecipeUnlockState(unlocks, recipes);
  if (unlockErrors.length > 0) {
    return { success: false, inventory: original, reason: `unlock state is invalid: ${unlockErrors.join('; ')}` };
  }
  if (!unlocks.unlockedRecipeIds.includes(recipeId)) {
    return { success: false, inventory: original, reason: 'recipe is locked' };
  }
  return craftRecipe(original, definitions, recipe, bench, outputInstanceId);
}

function combinedIngredients(recipe: Readonly<RecipeDefinition>): ReadonlyMap<string, number> {
  const combined = new Map<string, number>();
  for (const ingredient of recipe.ingredients) {
    combined.set(ingredient.itemId, (combined.get(ingredient.itemId) ?? 0) + ingredient.quantity);
  }
  return combined;
}

function uniquePreviewId(inventory: Readonly<SavedInventory>): string {
  const ids = new Set(inventory.items.map((item) => item.instanceId));
  let index = 1;
  while (ids.has(`__craft-preview-${index}__`)) index += 1;
  return `__craft-preview-${index}__`;
}

function failedPreview(
  recipeId: string,
  reason: string,
  missingIngredients: readonly { itemId: string; quantity: number }[],
  output: { itemId: string; quantity: number } | null,
  craftSeconds: number,
): CraftPreview {
  return {
    craftable: false,
    recipeId,
    reason,
    missingIngredients,
    output: output ? { ...output } : null,
    craftSeconds,
  };
}

function unlockFailure(state: RecipeUnlockState, reason: string): RecipeUnlockResult {
  return { success: false, state, reason };
}

function cloneUnlockState(state: Readonly<RecipeUnlockState>): RecipeUnlockState {
  return { unlockedRecipeIds: [...state.unlockedRecipeIds] };
}

function cloneInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return {
    gridWidth: inventory.gridWidth,
    gridHeight: inventory.gridHeight,
    maxWeightKg: inventory.maxWeightKg,
    items: inventory.items.map((item) => ({ ...item })),
  };
}
