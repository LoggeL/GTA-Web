import type {
  CollectibleCategoryId,
  CollectibleDefinition,
  CollectibleSetDefinition,
  DistrictId,
  ItemGrant,
} from '../data/types';

export const COLLECTIBLE_PROGRESS_SNAPSHOT_VERSION = 1 as const;
export const COLLECTIBLE_NEARBY_REVEAL_METERS = 45;
export const COLLECTIBLE_SIGNAL_SCAN_METERS = 140;

export const COLLECTIBLE_SAVE_KEYS = Object.freeze({
  'salvage-cache': 'salvage',
  'stunt-jump': 'stunts',
  'signal-node': 'signals',
} as const satisfies Record<CollectibleCategoryId, string>);

export const COLLECTIBLE_REVEALED_SAVE_KEY = 'revealed' as const;

export interface CollectibleProgressState {
  readonly revealedIds: readonly string[];
  readonly completedIds: readonly string[];
}

export interface CollectibleProgressSnapshotV1 extends CollectibleProgressState {
  readonly schemaVersion: typeof COLLECTIBLE_PROGRESS_SNAPSHOT_VERSION;
}

/** Directly assignable to `SaveGameV1.collectibles`. */
export type CollectibleSaveFields = Record<string, string[]>;

export type CollectibleRevealEvent =
  | {
    readonly kind: 'nearby';
    readonly district: DistrictId;
    readonly x: number;
    readonly z: number;
  }
  | { readonly kind: 'road-survey'; readonly district: DistrictId }
  | {
    readonly kind: 'signal-scan';
    readonly district: DistrictId;
    readonly x: number;
    readonly z: number;
    readonly scannerUnlocked: boolean;
  };

export interface CollectibleRevealResult {
  readonly state: CollectibleProgressState;
  readonly newlyRevealedIds: readonly string[];
}

export interface CollectibleRewardContext {
  /** Streetcraft Salvager adds this many components to a salvage cache. */
  readonly additionalSalvageComponents?: number;
  /** Breakwater Warehouse and future modifiers scale salvage output. */
  readonly salvageYieldMultiplier?: number;
}

export interface CollectibleReward {
  readonly xp: number;
  readonly cash: number;
  readonly items: readonly ItemGrant[];
  readonly unlockFlags: readonly string[];
}

export type CompleteCollectibleResult =
  | {
    readonly success: true;
    readonly state: CollectibleProgressState;
    readonly transactionId: string;
    readonly collectible: CollectibleDefinition;
    readonly reward: CollectibleReward;
    readonly categoryCompleted: boolean;
    readonly categoryProgress: { readonly completed: number; readonly total: number };
  }
  | { readonly success: false; readonly state: CollectibleProgressState; readonly reason: string };

export type CollectibleRestoreResult =
  | { readonly success: true; readonly state: CollectibleProgressState }
  | { readonly success: false; readonly errors: readonly string[] };

const ACCEPTED_COMPLETION_KEYS = Object.freeze({
  salvage: 'salvage-cache',
  stunts: 'stunt-jump',
  signals: 'signal-node',
  'salvage-cache': 'salvage-cache',
  'stunt-jump': 'stunt-jump',
  'signal-node': 'signal-node',
} as const satisfies Record<string, CollectibleCategoryId>);
const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createCollectibleProgress(): CollectibleProgressState {
  return { revealedIds: [], completedIds: [] };
}

export function createCollectibleProgressSnapshot(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
): CollectibleProgressSnapshotV1 {
  const normalized = normalizeProgress(state, definitions);
  return {
    schemaVersion: COLLECTIBLE_PROGRESS_SNAPSHOT_VERSION,
    revealedIds: normalized.revealedIds,
    completedIds: normalized.completedIds,
  };
}

export function restoreCollectibleProgressSnapshot(
  value: unknown,
  definitions: readonly CollectibleDefinition[],
): CollectibleRestoreResult {
  if (!isRecord(value) || value.schemaVersion !== COLLECTIBLE_PROGRESS_SNAPSHOT_VERSION) {
    return { success: false, errors: ['collectible snapshot schemaVersion must be 1'] };
  }
  return restoreProgressArrays(value.revealedIds, value.completedIds, definitions, 'collectible snapshot');
}

export function createCollectibleSaveFields(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
): CollectibleSaveFields {
  const normalized = normalizeProgress(state, definitions);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const result: CollectibleSaveFields = {
    salvage: [],
    stunts: [],
    signals: [],
    [COLLECTIBLE_REVEALED_SAVE_KEY]: [...normalized.revealedIds],
  };
  for (const id of normalized.completedIds) {
    const definition = byId.get(id);
    if (!definition) continue;
    result[COLLECTIBLE_SAVE_KEYS[definition.category]]?.push(id);
  }
  return result;
}

/**
 * Accepts the original `salvage`/`stunts`/`signals` keys and canonical category
 * aliases. Completed collectibles are implicitly revealed for pre-M6 saves.
 */
export function restoreCollectibleSaveFields(
  value: unknown,
  definitions: readonly CollectibleDefinition[],
): CollectibleRestoreResult {
  if (!isRecord(value)) return { success: false, errors: ['collectibles must be an object'] };
  const errors: string[] = [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const completedIds: string[] = [];
  let revealedIds: string[] = [];

  for (const [key, entry] of Object.entries(value)) {
    if (RESERVED_RECORD_KEYS.has(key)) {
      errors.push(`collectibles.${key} is not a supported save key`);
      continue;
    }
    if (!Array.isArray(entry)) {
      errors.push(`collectibles.${key} must be an array`);
      continue;
    }
    const ids = validateIdArray(entry, `collectibles.${key}`, byId, errors);
    if (key === COLLECTIBLE_REVEALED_SAVE_KEY) {
      revealedIds = ids;
      continue;
    }
    const category = ACCEPTED_COMPLETION_KEYS[key as keyof typeof ACCEPTED_COMPLETION_KEYS];
    if (!category) {
      errors.push(`collectibles.${key} is not a supported save key`);
      continue;
    }
    for (const id of ids) {
      const definition = byId.get(id);
      if (definition && definition.category !== category) {
        errors.push(`collectibles.${key}.${id} belongs to ${definition.category}`);
      }
      completedIds.push(id);
    }
  }
  const duplicateCompleted = findDuplicate(completedIds);
  if (duplicateCompleted) errors.push(`collectible completion ${duplicateCompleted} is duplicated`);
  if (errors.length > 0) return { success: false, errors };
  revealedIds = [...new Set([...revealedIds, ...completedIds])];
  return {
    success: true,
    state: normalizeProgress({ revealedIds, completedIds }, definitions),
  };
}

export function revealCollectibles(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
  event: Readonly<CollectibleRevealEvent>,
): CollectibleRevealResult {
  validateRevealEvent(event);
  const revealed = new Set(state.revealedIds);
  const completed = new Set(state.completedIds);
  const newlyRevealedIds: string[] = [];
  for (const definition of definitions) {
    if (revealed.has(definition.id) || completed.has(definition.id)) continue;
    if (!matchesRevealEvent(definition, event)) continue;
    revealed.add(definition.id);
    newlyRevealedIds.push(definition.id);
  }
  return {
    state: normalizeProgress({ revealedIds: [...revealed], completedIds: [...completed] }, definitions),
    newlyRevealedIds,
  };
}

export function isCollectibleRevealed(
  state: Readonly<CollectibleProgressState>,
  id: string,
): boolean {
  return state.revealedIds.includes(id) || state.completedIds.includes(id);
}

export function visibleCollectibles(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
): readonly CollectibleDefinition[] {
  const visible = new Set([...state.revealedIds, ...state.completedIds]);
  return definitions.filter((definition) => visible.has(definition.id));
}

export function getCollectibleCategoryProgress(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
  category: CollectibleCategoryId,
): { readonly completed: number; readonly total: number } {
  const completed = new Set(state.completedIds);
  const categoryDefinitions = definitions.filter((definition) => definition.category === category);
  return {
    completed: categoryDefinitions.filter((definition) => completed.has(definition.id)).length,
    total: categoryDefinitions.length,
  };
}

export function completeCollectible(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
  sets: readonly CollectibleSetDefinition[],
  collectibleId: string,
  context: Readonly<CollectibleRewardContext> = {},
): CompleteCollectibleResult {
  const definition = definitions.find((entry) => entry.id === collectibleId);
  if (!definition) return collectibleFailure(state, `unknown collectible "${collectibleId}"`);
  if (state.completedIds.includes(collectibleId)) {
    return collectibleFailure(state, `collectible "${collectibleId}" is already complete`);
  }
  if (!isCollectibleRevealed(state, collectibleId)) {
    return collectibleFailure(state, `collectible "${collectibleId}" has not been revealed`);
  }
  const set = sets.find((entry) => entry.category === definition.category);
  if (!set) return collectibleFailure(state, `missing collectible set "${definition.category}"`);
  const rewardContextError = validateRewardContext(context);
  if (rewardContextError) return collectibleFailure(state, rewardContextError);

  const next = normalizeProgress({
    revealedIds: state.revealedIds,
    completedIds: [...state.completedIds, collectibleId],
  }, definitions);
  const categoryProgress = getCollectibleCategoryProgress(next, definitions, definition.category);
  const categoryCompleted = categoryProgress.completed === set.count;
  const perItemRewards = scaleItemRewards(definition, context);
  const xp = definition.reward.xp + (categoryCompleted ? set.completionReward.xp : 0);
  const cash = definition.reward.cash + (categoryCompleted ? set.completionReward.cash : 0);
  if (!Number.isSafeInteger(xp) || !Number.isSafeInteger(cash)) {
    return collectibleFailure(state, 'collectible reward exceeds safe integer range');
  }
  return {
    success: true,
    state: next,
    transactionId: `collectible:${definition.id}`,
    collectible: definition,
    reward: {
      xp,
      cash,
      items: perItemRewards,
      unlockFlags: categoryCompleted ? [set.completionReward.unlockFlag] : [],
    },
    categoryCompleted,
    categoryProgress,
  };
}

function matchesRevealEvent(
  definition: Readonly<CollectibleDefinition>,
  event: Readonly<CollectibleRevealEvent>,
): boolean {
  if (definition.district !== event.district) return false;
  if (event.kind === 'road-survey') return definition.revealRule === 'road-survey';
  if (event.kind === 'signal-scan') {
    return event.scannerUnlocked
      && definition.revealRule === 'signal-scan'
      && planarDistanceSquared(definition.position.x, definition.position.z, event.x, event.z)
        <= COLLECTIBLE_SIGNAL_SCAN_METERS ** 2;
  }
  return definition.revealRule === 'nearby'
    && planarDistanceSquared(definition.position.x, definition.position.z, event.x, event.z)
      <= COLLECTIBLE_NEARBY_REVEAL_METERS ** 2;
}

function scaleItemRewards(
  definition: Readonly<CollectibleDefinition>,
  context: Readonly<CollectibleRewardContext>,
): readonly ItemGrant[] {
  if (definition.category !== 'salvage-cache') {
    return definition.reward.items.map((item) => ({ ...item }));
  }
  const bonus = context.additionalSalvageComponents ?? 0;
  const multiplier = context.salvageYieldMultiplier ?? 1;
  return definition.reward.items.map((item) => ({
    itemId: item.itemId,
    quantity: Math.ceil(item.quantity * multiplier) + bonus,
  }));
}

function validateRewardContext(context: Readonly<CollectibleRewardContext>): string | null {
  const bonus = context.additionalSalvageComponents ?? 0;
  if (!Number.isSafeInteger(bonus) || bonus < 0) {
    return 'additional salvage components must be a non-negative safe integer';
  }
  const multiplier = context.salvageYieldMultiplier ?? 1;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    return 'salvage yield multiplier must be finite and at least one';
  }
  return null;
}

function normalizeProgress(
  state: Readonly<CollectibleProgressState>,
  definitions: readonly CollectibleDefinition[],
): CollectibleProgressState {
  const revealed = new Set([...state.revealedIds, ...state.completedIds]);
  const completed = new Set(state.completedIds);
  return {
    revealedIds: definitions.filter((definition) => revealed.has(definition.id)).map((definition) => definition.id),
    completedIds: definitions.filter((definition) => completed.has(definition.id)).map((definition) => definition.id),
  };
}

function restoreProgressArrays(
  revealedValue: unknown,
  completedValue: unknown,
  definitions: readonly CollectibleDefinition[],
  path: string,
): CollectibleRestoreResult {
  const errors: string[] = [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const revealedIds = validateIdArray(revealedValue, `${path}.revealedIds`, byId, errors);
  const completedIds = validateIdArray(completedValue, `${path}.completedIds`, byId, errors);
  if (errors.length > 0) return { success: false, errors };
  return { success: true, state: normalizeProgress({ revealedIds, completedIds }, definitions) };
}

function validateIdArray(
  value: unknown,
  path: string,
  byId: ReadonlyMap<string, CollectibleDefinition>,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(`${path}[${index}] must be a string`);
    } else if (!byId.has(entry)) {
      errors.push(`${path}.${entry} is not an authored collectible`);
    } else if (seen.has(entry)) {
      errors.push(`${path}.${entry} is duplicated`);
    } else {
      ids.push(entry);
      seen.add(entry);
    }
  });
  return ids;
}

function validateRevealEvent(event: Readonly<CollectibleRevealEvent>): void {
  if (event.kind === 'road-survey') return;
  if (!Number.isFinite(event.x) || !Number.isFinite(event.z)) {
    throw new RangeError('collectible reveal coordinates must be finite');
  }
}

function planarDistanceSquared(ax: number, az: number, bx: number, bz: number): number {
  return (ax - bx) ** 2 + (az - bz) ** 2;
}

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function collectibleFailure(
  state: Readonly<CollectibleProgressState>,
  reason: string,
): CompleteCollectibleResult {
  return { success: false, state: cloneCollectibleProgress(state), reason };
}

function cloneCollectibleProgress(
  state: Readonly<CollectibleProgressState>,
): CollectibleProgressState {
  return { revealedIds: [...state.revealedIds], completedIds: [...state.completedIds] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
