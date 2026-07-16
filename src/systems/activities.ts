import { hashSeed, SeededRandom, type RandomSeed } from '../core/random';
import type { SavedActivity } from '../core/state';
import type {
  ActivityDefinition,
  ActivityDifficulty,
  ActivityTypeId,
  DistrictId,
} from '../data/types';
import {
  quoteActivityIncome,
  type ActivityIncomeQuote,
  type CashRewardContext,
} from './economy';

export const ACTIVITY_PROGRESS_SNAPSHOT_VERSION = 1 as const;

/** Directly assignable to and restorable from `SaveGameV1.activities`. */
export type ActivityProgressState = Record<string, SavedActivity>;

export interface ActivityProgressSnapshotV1 {
  readonly schemaVersion: typeof ACTIVITY_PROGRESS_SNAPSHOT_VERSION;
  readonly activities: ActivityProgressState;
}

export interface ActivityAccessContext {
  readonly level: number;
  readonly nowMs: number;
  readonly unlockedFlags: readonly string[];
}

export interface ActivityVariant {
  readonly runId: string;
  readonly activityId: ActivityTypeId;
  readonly difficultyId: ActivityDifficulty['id'];
  readonly attemptNumber: number;
  readonly seed: number;
  readonly variantIndex: number;
  readonly district: DistrictId;
  readonly routeReversed: boolean;
  readonly targetMultiplier: number;
  readonly objectiveTemplate: readonly string[];
  readonly reward: ActivityIncomeQuote;
}

export interface StartActivityRequest {
  readonly activityId: ActivityTypeId;
  readonly difficultyId: ActivityDifficulty['id'];
  readonly worldSeed: RandomSeed;
  readonly access: ActivityAccessContext;
  readonly rewardContext?: Readonly<CashRewardContext>;
}

export type StartActivityResult =
  | { readonly success: true; readonly run: ActivityVariant }
  | { readonly success: false; readonly reason: string; readonly cooldownRemainingMs: number };

export interface ActivityPerformance {
  readonly score?: number;
  readonly timeSeconds?: number;
}

export interface CompleteActivityRequest extends StartActivityRequest {
  /** Compare-and-swap token returned by `startActivity`; prevents duplicate commits. */
  readonly expectedRunId: string;
  readonly performance: ActivityPerformance;
}

export interface CompletedActivityReward extends ActivityIncomeQuote {
  readonly firstCompletion: boolean;
}

export type CompleteActivityResult =
  | {
    readonly success: true;
    readonly state: ActivityProgressState;
    readonly transactionId: string;
    readonly run: ActivityVariant;
    readonly reward: CompletedActivityReward;
    readonly newBestScore: boolean;
    readonly newBestTime: boolean;
    readonly progress: SavedActivity;
  }
  | { readonly success: false; readonly state: ActivityProgressState; readonly reason: string };

export type ActivityProgressRestoreResult =
  | { readonly success: true; readonly state: ActivityProgressState }
  | { readonly success: false; readonly errors: readonly string[] };

export interface ActivityAvailability {
  readonly available: boolean;
  readonly reason: 'available' | 'locked' | 'level-required' | 'cooldown';
  readonly cooldownRemainingMs: number;
  readonly requiredLevel: number;
}

const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createActivityProgress(
  definitions: readonly ActivityDefinition[],
): ActivityProgressState {
  return Object.fromEntries(definitions.map((definition) => [definition.id, emptyActivityProgress()]));
}

export function createActivitySaveFields(
  state: Readonly<ActivityProgressState>,
  definitions: readonly ActivityDefinition[],
): ActivityProgressState {
  const result = createActivityProgress(definitions);
  for (const definition of definitions) {
    const saved = state[definition.id];
    if (saved) result[definition.id] = cloneSavedActivity(saved);
  }
  return result;
}

export function createActivityProgressSnapshot(
  state: Readonly<ActivityProgressState>,
  definitions: readonly ActivityDefinition[],
): ActivityProgressSnapshotV1 {
  return {
    schemaVersion: ACTIVITY_PROGRESS_SNAPSHOT_VERSION,
    activities: createActivitySaveFields(state, definitions),
  };
}

/**
 * Strictly validates known records but fills missing authored activities. This keeps
 * pre-M6 saves (whose activities object is empty) forwards compatible.
 */
export function restoreActivityProgress(
  value: unknown,
  definitions: readonly ActivityDefinition[],
): ActivityProgressRestoreResult {
  const errors = validateActivityProgress(value, definitions);
  if (errors.length > 0) return { success: false, errors };
  const source = value as Record<string, SavedActivity>;
  const state = createActivityProgress(definitions);
  for (const definition of definitions) {
    const saved = source[definition.id];
    if (saved) state[definition.id] = cloneSavedActivity(saved);
  }
  return { success: true, state };
}

export function restoreActivityProgressSnapshot(
  value: unknown,
  definitions: readonly ActivityDefinition[],
): ActivityProgressRestoreResult {
  if (!isRecord(value) || value.schemaVersion !== ACTIVITY_PROGRESS_SNAPSHOT_VERSION) {
    return { success: false, errors: ['activity snapshot schemaVersion must be 1'] };
  }
  return restoreActivityProgress(value.activities, definitions);
}

export function validateActivityProgress(
  value: unknown,
  definitions: readonly ActivityDefinition[],
): readonly string[] {
  if (!isRecord(value)) return ['activities must be an object'];
  const errors: string[] = [];
  const knownIds = new Set(definitions.map((definition) => definition.id));
  for (const [id, entry] of Object.entries(value)) {
    const path = `activities.${id}`;
    if (RESERVED_RECORD_KEYS.has(id) || !knownIds.has(id as ActivityTypeId)) {
      errors.push(`${path} is not an authored activity`);
      continue;
    }
    if (!isRecord(entry)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    validateSafeInteger(entry.completions, `${path}.completions`, errors, 0);
    validateSafeInteger(entry.cooldownUntil, `${path}.cooldownUntil`, errors, 0);
    validateNullableMetric(entry.bestScore, `${path}.bestScore`, errors, true);
    validateNullableMetric(entry.bestTimeSeconds, `${path}.bestTimeSeconds`, errors, false);
  }
  return errors;
}

export function getActivityAvailability(
  state: Readonly<ActivityProgressState>,
  definition: Readonly<ActivityDefinition>,
  difficultyId: ActivityDifficulty['id'],
  access: Readonly<ActivityAccessContext>,
): ActivityAvailability {
  assertAccess(access);
  const difficulty = definition.difficulties.find((entry) => entry.id === difficultyId);
  if (!difficulty) {
    throw new RangeError(`unknown activity difficulty "${difficultyId}"`);
  }
  const progress = state[definition.id] ?? emptyActivityProgress();
  const cooldownRemainingMs = Math.max(0, progress.cooldownUntil - access.nowMs);
  if (!access.unlockedFlags.includes(definition.unlockFlag)) {
    return {
      available: false,
      reason: 'locked',
      cooldownRemainingMs,
      requiredLevel: difficulty.levelRequirement,
    };
  }
  if (access.level < difficulty.levelRequirement) {
    return {
      available: false,
      reason: 'level-required',
      cooldownRemainingMs,
      requiredLevel: difficulty.levelRequirement,
    };
  }
  if (cooldownRemainingMs > 0) {
    return {
      available: false,
      reason: 'cooldown',
      cooldownRemainingMs,
      requiredLevel: difficulty.levelRequirement,
    };
  }
  return {
    available: true,
    reason: 'available',
    cooldownRemainingMs: 0,
    requiredLevel: difficulty.levelRequirement,
  };
}

export function startActivity(
  state: Readonly<ActivityProgressState>,
  definitions: readonly ActivityDefinition[],
  request: Readonly<StartActivityRequest>,
): StartActivityResult {
  const definition = definitions.find((entry) => entry.id === request.activityId);
  if (!definition) return { success: false, reason: `unknown activity "${request.activityId}"`, cooldownRemainingMs: 0 };
  let availability: ActivityAvailability;
  try {
    availability = getActivityAvailability(state, definition, request.difficultyId, request.access);
  } catch (error) {
    return { success: false, reason: errorMessage(error), cooldownRemainingMs: 0 };
  }
  if (!availability.available) {
    return {
      success: false,
      reason: availability.reason,
      cooldownRemainingMs: availability.cooldownRemainingMs,
    };
  }
  const progress = state[definition.id] ?? emptyActivityProgress();
  return {
    success: true,
    run: createActivityVariant(definition, request.difficultyId, request.worldSeed,
      progress.completions, request.rewardContext),
  };
}

export function createActivityVariant(
  definition: Readonly<ActivityDefinition>,
  difficultyId: ActivityDifficulty['id'],
  worldSeed: RandomSeed,
  completedAttempts: number,
  rewardContext: Readonly<CashRewardContext> = {},
): ActivityVariant {
  if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 0) {
    throw new RangeError('completedAttempts must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(definition.variantCount) || definition.variantCount < 2) {
    throw new RangeError('activity variantCount must be an integer of at least two');
  }
  if (definition.districts.length === 0) throw new RangeError('activity must define at least one district');
  const difficulty = definition.difficulties.find((entry) => entry.id === difficultyId);
  if (!difficulty) throw new RangeError(`unknown activity difficulty "${difficultyId}"`);
  const seed = hashSeed(`${String(worldSeed)}:${definition.variantSeedSalt}:${difficultyId}:${completedAttempts}`);
  const random = new SeededRandom(seed);
  const variantIndex = random.integer(0, definition.variantCount);
  const district = random.pick(definition.districts);
  const routeReversed = random.chance(0.5);
  const attemptNumber = completedAttempts + 1;
  const runId = [
    definition.id,
    difficultyId,
    attemptNumber,
    variantIndex + 1,
    seed.toString(16).padStart(8, '0'),
  ].join(':');
  return {
    runId,
    activityId: definition.id,
    difficultyId,
    attemptNumber,
    seed,
    variantIndex,
    district,
    routeReversed,
    targetMultiplier: difficulty.targetMultiplier,
    objectiveTemplate: [...definition.objectiveTemplate],
    reward: quoteActivityIncome(definition, difficultyId, rewardContext),
  };
}

export function completeActivity(
  state: Readonly<ActivityProgressState>,
  definitions: readonly ActivityDefinition[],
  request: Readonly<CompleteActivityRequest>,
): CompleteActivityResult {
  const started = startActivity(state, definitions, request);
  if (!started.success) return activityFailure(state, started.reason);
  if (started.run.runId !== request.expectedRunId) {
    return activityFailure(state, 'activity run token is stale or does not match the seeded variant');
  }
  const definition = definitions.find((entry) => entry.id === request.activityId);
  if (!definition) return activityFailure(state, `unknown activity "${request.activityId}"`);
  const performanceError = validatePerformance(definition, request.performance);
  if (performanceError) return activityFailure(state, performanceError);
  const prior = state[definition.id] ?? emptyActivityProgress();
  const cooldownMs = definition.cooldownMinutes * 60_000;
  const cooldownUntil = request.access.nowMs + cooldownMs;
  if (!Number.isSafeInteger(cooldownUntil)) {
    return activityFailure(state, 'activity cooldown timestamp exceeds safe integer range');
  }

  const score = request.performance.score;
  const timeSeconds = request.performance.timeSeconds;
  const newBestScore = score !== undefined && (prior.bestScore === null || score > prior.bestScore);
  const newBestTime = timeSeconds !== undefined
    && (prior.bestTimeSeconds === null || timeSeconds < prior.bestTimeSeconds);
  const progress: SavedActivity = {
    completions: prior.completions + 1,
    cooldownUntil,
    bestScore: newBestScore ? score ?? null : prior.bestScore,
    bestTimeSeconds: newBestTime ? timeSeconds ?? null : prior.bestTimeSeconds,
  };
  const next = cloneActivityProgress(state);
  next[definition.id] = progress;
  return {
    success: true,
    state: next,
    transactionId: `activity:${started.run.runId}`,
    run: started.run,
    reward: { ...started.run.reward, firstCompletion: prior.completions === 0 },
    newBestScore,
    newBestTime,
    progress: cloneSavedActivity(progress),
  };
}

export function cloneActivityProgress(
  state: Readonly<ActivityProgressState>,
): ActivityProgressState {
  return Object.fromEntries(
    Object.entries(state).map(([id, progress]) => [id, cloneSavedActivity(progress)]),
  );
}

function validatePerformance(
  definition: Readonly<ActivityDefinition>,
  performance: Readonly<ActivityPerformance>,
): string | null {
  if (performance.score !== undefined
    && (!Number.isSafeInteger(performance.score) || performance.score < 0)) {
    return 'activity score must be a non-negative safe integer';
  }
  if (performance.timeSeconds !== undefined
    && (!Number.isFinite(performance.timeSeconds) || performance.timeSeconds <= 0)) {
    return 'activity time must be positive and finite';
  }
  if (definition.scoring === 'lowest-time' && performance.timeSeconds === undefined) {
    return 'lowest-time activity requires a completion time';
  }
  if (definition.scoring === 'highest-score' && performance.score === undefined) {
    return 'highest-score activity requires a score';
  }
  return null;
}

function assertAccess(access: Readonly<ActivityAccessContext>): void {
  if (!Number.isSafeInteger(access.level) || access.level < 1 || access.level > 20) {
    throw new RangeError('activity access level must be an integer between 1 and 20');
  }
  if (!Number.isSafeInteger(access.nowMs) || access.nowMs < 0) {
    throw new RangeError('activity access nowMs must be a non-negative safe integer');
  }
}

function validateSafeInteger(
  value: unknown,
  path: string,
  errors: string[],
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum) {
    errors.push(`${path} must be a safe integer of at least ${minimum}`);
  }
}

function validateNullableMetric(
  value: unknown,
  path: string,
  errors: string[],
  integer: boolean,
): void {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || (integer && !Number.isSafeInteger(value))) {
    errors.push(`${path} must be null or a non-negative${integer ? ' safe integer' : ' finite number'}`);
  }
}

function emptyActivityProgress(): SavedActivity {
  return { completions: 0, cooldownUntil: 0, bestScore: null, bestTimeSeconds: null };
}

function cloneSavedActivity(progress: Readonly<SavedActivity>): SavedActivity {
  return {
    completions: progress.completions,
    cooldownUntil: progress.cooldownUntil,
    bestScore: progress.bestScore,
    bestTimeSeconds: progress.bestTimeSeconds,
  };
}

function activityFailure(
  state: Readonly<ActivityProgressState>,
  reason: string,
): CompleteActivityResult {
  return { success: false, state: cloneActivityProgress(state), reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
