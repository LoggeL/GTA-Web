import type { SaveValidationRegistry } from '../core';
import {
  ACTIVITIES,
  COLLECTIBLES,
  ITEMS,
  MISSIONS,
  PROPERTIES,
  RECIPES,
  SKILL_NODES,
  VEHICLES,
} from '../data';
import {
  validateDialogueRuntimeSnapshot,
  validateMissionRuntimeSnapshot,
} from '../runtime';

const ids = (definitions: readonly { readonly id: string }[]): ReadonlySet<string> =>
  new Set(definitions.map(({ id }) => id));

/** The authoritative registry boundary used by every production save service. */
export const GAME_SAVE_VALIDATION_REGISTRY: SaveValidationRegistry = Object.freeze({
  itemIds: ids(ITEMS),
  skillIds: ids(SKILL_NODES),
  vehicleIds: ids(VEHICLES),
  missionIds: ids(MISSIONS),
  propertyIds: ids(PROPERTIES),
  activityIds: ids(ACTIVITIES),
  collectibleIds: ids(COLLECTIBLES),
  recipeIds: ids(RECIPES),
  validateMissionRuntime: (value: unknown) => {
    const result = validateMissionRuntimeSnapshot(value);
    return result.success ? null : result.reason;
  },
  validateDialogueRuntime: (value: unknown) => {
    const result = validateDialogueRuntimeSnapshot(value);
    return result.success ? null : result.reason;
  },
});
