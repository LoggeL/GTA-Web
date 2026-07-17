import {
  currentAndAdjacentCellIds,
  parseCellId,
} from '../navigation/cells';
import type {
  CellId,
  FailedChunkBoundary,
  RoadClosureState,
} from '../navigation/types';
import { COMBAT_CAPACITY } from '../simulation/combat';
import { PEDESTRIAN_CAPACITY } from '../simulation/pedestrians';
import { TRAFFIC_CAPACITY } from '../simulation/traffic';
import type { WorldQuality } from './types';

export type StreamingPlatform = 'desktop' | 'mobile';
export type AdaptivePerformanceLevel = 'full' | 'balanced' | 'minimum';
export type CellRetryStatus = 'waiting' | 'retrying' | 'exhausted';

/**
 * Runtime-only floor reserved for the sustained-pressure adaptive minimum.
 * The persisted/user-visible resolution setting remains constrained to [0.5, 1].
 */
export const MINIMUM_ADAPTIVE_RESOLUTION_SCALE = 0.35;
export const MOBILE_MINIMUM_ADAPTIVE_RESOLUTION_SCALE = 0.4;

export interface ActorLimits {
  readonly traffic: number;
  readonly pedestrians: number;
  readonly combat: number;
  readonly total: number;
}

export interface DrawDensityLimits {
  /** Roads stay visible so streamed boundaries never look like missing ground. */
  readonly roads: 1;
  readonly structures: number;
  readonly props: number;
  readonly actors: number;
  readonly shadows: number;
}

export interface CityStreamingLimits {
  readonly quality: WorldQuality;
  readonly performanceLevel: AdaptivePerformanceLevel;
  readonly actors: ActorLimits;
  readonly drawDensity: DrawDensityLimits;
  readonly resolutionScale: number;
}

export interface RollingFrameStats {
  readonly sampleCount: number;
  readonly averageMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly estimatedFramesPerSecond: number;
}

export interface CellRetryState {
  readonly cellId: CellId;
  readonly status: CellRetryStatus;
  readonly attemptsCompleted: number;
  readonly nextAttempt: number;
  readonly nextRetryAtMilliseconds: number | null;
}

export interface CityStreamingSnapshot {
  readonly schemaVersion: 1;
  readonly platform: StreamingPlatform;
  readonly quality: WorldQuality;
  readonly inactiveLruLimit: 2 | 1;
  readonly currentCellId: CellId | null;
  readonly predictedCellId: CellId | null;
  /** Desired current cell plus its eight neighbors, even while a cell is loading. */
  readonly activeCellIds: readonly CellId[];
  /** Active cells whose visual payload is not behind a failed boundary. */
  readonly renderableActiveCellIds: readonly CellId[];
  /** Oldest first, matching the navigation ChunkManager snapshot convention. */
  readonly inactiveLruCellIds: readonly CellId[];
  readonly residentCellIds: readonly CellId[];
  readonly prefetchCellIds: readonly CellId[];
  readonly failedBoundaries: readonly FailedChunkBoundary[];
  readonly roadClosures: readonly RoadClosureState[];
  readonly retryStates: readonly CellRetryState[];
  readonly performance: {
    readonly level: AdaptivePerformanceLevel;
    readonly limits: CityStreamingLimits;
    readonly frames: RollingFrameStats;
  };
}

export interface CityStreamingTransition {
  readonly activatedCellIds: readonly CellId[];
  readonly deactivatedCellIds: readonly CellId[];
  readonly evictedCellIds: readonly CellId[];
  readonly snapshot: CityStreamingSnapshot;
}

export interface AdaptivePerformanceDecision {
  readonly changed: boolean;
  readonly reason: 'collecting' | 'stable' | 'degraded' | 'recovered';
  readonly previousLevel: AdaptivePerformanceLevel;
  readonly level: AdaptivePerformanceLevel;
  readonly limits: CityStreamingLimits;
  readonly frames: RollingFrameStats;
}

export type CellRetryRequest =
  | {
    readonly accepted: true;
    readonly cellId: CellId;
    readonly attempt: number;
  }
  | {
    readonly accepted: false;
    readonly cellId: CellId;
    readonly reason: 'unknown-cell' | 'not-due' | 'retrying' | 'exhausted';
  };

export interface CityStreamingControllerOptions {
  readonly platform?: StreamingPlatform;
  readonly quality?: WorldQuality;
  readonly baseResolutionScale?: number;
  readonly retryDelaysMilliseconds?: readonly number[];
  readonly frameWindowSize?: number;
  readonly slowFrameThresholdMilliseconds?: number;
  readonly fastFrameThresholdMilliseconds?: number;
  readonly slowWindowsToDegrade?: number;
  readonly fastWindowsToRecover?: number;
}

interface InternalFailure {
  boundary: FailedChunkBoundary;
  closure: RoadClosureState;
  retry: CellRetryState;
}

const PERFORMANCE_LEVELS: readonly AdaptivePerformanceLevel[] = [
  'full',
  'balanced',
  'minimum',
];

const DEFAULT_RETRY_DELAYS_MILLISECONDS = [250, 750] as const;

const QUALITY_DRAW_DENSITY: Readonly<Record<WorldQuality, DrawDensityLimits>> = {
  low: Object.freeze({
    roads: 1,
    structures: 0.72,
    props: 0.55,
    actors: 0.68,
    shadows: 0.35,
  }),
  high: Object.freeze({
    roads: 1,
    structures: 1,
    props: 1,
    actors: 1,
    shadows: 1,
  }),
};

const LEVEL_ACTOR_SCALE: Readonly<Record<AdaptivePerformanceLevel, number>> = {
  full: 1,
  balanced: 0.8,
  minimum: 0.6,
};

const LEVEL_DENSITY_SCALE: Readonly<
  Record<AdaptivePerformanceLevel, Omit<DrawDensityLimits, 'roads'>>
> = {
  full: { structures: 1, props: 1, actors: 1, shadows: 1 },
  balanced: { structures: 0.9, props: 0.75, actors: 0.75, shadows: 0.6 },
  minimum: { structures: 0.78, props: 0.5, actors: 0.5, shadows: 0 },
};

const LEVEL_RESOLUTION_REDUCTION: Readonly<
  Record<AdaptivePerformanceLevel, number>
> = {
  full: 0,
  balanced: 0.1,
  minimum: 0.3,
};

function sortedCellIds(values: Iterable<CellId>): CellId[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function difference(left: Iterable<CellId>, right: ReadonlySet<CellId>): CellId[] {
  return sortedCellIds([...left].filter((cellId) => !right.has(cellId)));
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cloneBoundary(boundary: Readonly<FailedChunkBoundary>): FailedChunkBoundary {
  return { ...boundary };
}

function cloneClosure(closure: Readonly<RoadClosureState>): RoadClosureState {
  return { ...closure };
}

function cloneRetry(retry: Readonly<CellRetryState>): CellRetryState {
  return { ...retry };
}

function defaultResolutionScale(quality: WorldQuality): number {
  return quality === 'high' ? 1 : 0.8;
}

/**
 * Applies the low-quality ceiling only when automatic quality selection chose
 * the low path. Explicit quality choices keep the user's resolution slider as
 * an absolute scale, and lower slider values remain unchanged.
 */
export function baseResolutionScaleForQuality(
  configuredScale: number,
  qualitySetting: WorldQuality | 'auto',
  resolvedQuality: WorldQuality,
): number {
  return qualitySetting === 'auto' && resolvedQuality === 'low'
    ? Math.min(configuredScale, defaultResolutionScale('low'))
    : configuredScale;
}

/**
 * Keeps automatic low quality inside a stable full-level budget on desktop
 * software WebGL. Mobile has a separate 30 FPS target, while explicit user
 * quality choices and hardware rendering retain their configured ceiling.
 */
export function baseResolutionScaleForRuntime(
  configuredScale: number,
  qualitySetting: WorldQuality | 'auto',
  resolvedQuality: WorldQuality,
  platform: StreamingPlatform,
  softwareRenderer: boolean,
): number {
  const qualityScale = baseResolutionScaleForQuality(
    configuredScale,
    qualitySetting,
    resolvedQuality,
  );
  return softwareRenderer
    && platform === 'desktop'
    && qualitySetting === 'auto'
    && resolvedQuality === 'low'
    ? Math.min(qualityScale, 0.5)
    : qualityScale;
}

/**
 * Pure orchestration state for city visual residency and adaptive budgets.
 * Loading and rendering stay with the caller; this class only returns deterministic decisions.
 */
export class CityStreamingController {
  readonly #platform: StreamingPlatform;
  readonly #inactiveLruLimit: 2 | 1;
  readonly #retryDelaysMilliseconds: readonly number[];
  readonly #frameWindowSize: number;
  readonly #slowFrameThresholdMilliseconds: number;
  readonly #fastFrameThresholdMilliseconds: number;
  readonly #slowWindowsToDegrade: number;
  readonly #fastWindowsToRecover: number;
  readonly #lastAccess = new Map<CellId, number>();
  readonly #inactiveCells = new Set<CellId>();
  readonly #failures = new Map<CellId, InternalFailure>();
  readonly #frameSamples: number[] = [];
  #quality: WorldQuality;
  #baseResolutionScale: number;
  #currentCellId: CellId | null = null;
  #predictedCellId: CellId | null = null;
  #activeCellIds: readonly CellId[] = [];
  #accessCounter = 0;
  #performanceLevelIndex = 0;
  #samplesSinceEvaluation = 0;
  #slowWindowStreak = 0;
  #fastWindowStreak = 0;

  public constructor(options: CityStreamingControllerOptions = {}) {
    this.#platform = options.platform ?? 'desktop';
    this.#inactiveLruLimit = this.#platform === 'desktop' ? 2 : 1;
    this.#quality = options.quality ?? 'high';
    this.#baseResolutionScale = options.baseResolutionScale
      ?? defaultResolutionScale(this.#quality);
    this.#retryDelaysMilliseconds = [
      ...(options.retryDelaysMilliseconds ?? DEFAULT_RETRY_DELAYS_MILLISECONDS),
    ];
    this.#frameWindowSize = options.frameWindowSize ?? 60;
    this.#slowFrameThresholdMilliseconds =
      options.slowFrameThresholdMilliseconds ?? 22;
    this.#fastFrameThresholdMilliseconds =
      options.fastFrameThresholdMilliseconds ?? 17;
    this.#slowWindowsToDegrade = options.slowWindowsToDegrade ?? 2;
    this.#fastWindowsToRecover = options.fastWindowsToRecover ?? 4;

    if (
      !Number.isFinite(this.#baseResolutionScale)
      || this.#baseResolutionScale < 0.5
      || this.#baseResolutionScale > 1
    ) {
      throw new RangeError('baseResolutionScale must be between 0.5 and 1');
    }
    for (const delay of this.#retryDelaysMilliseconds) {
      assertFiniteNonNegative(delay, 'retry delay');
    }
    assertPositiveInteger(this.#frameWindowSize, 'frameWindowSize');
    assertFiniteNonNegative(
      this.#slowFrameThresholdMilliseconds,
      'slowFrameThresholdMilliseconds',
    );
    assertFiniteNonNegative(
      this.#fastFrameThresholdMilliseconds,
      'fastFrameThresholdMilliseconds',
    );
    if (
      this.#fastFrameThresholdMilliseconds
      >= this.#slowFrameThresholdMilliseconds
    ) {
      throw new RangeError('fast frame threshold must be lower than slow frame threshold');
    }
    assertPositiveInteger(this.#slowWindowsToDegrade, 'slowWindowsToDegrade');
    assertPositiveInteger(this.#fastWindowsToRecover, 'fastWindowsToRecover');
  }

  public get inactiveLruLimit(): 2 | 1 {
    return this.#inactiveLruLimit;
  }

  public updateCells(
    currentCellId: CellId,
    predictedCellId: CellId = currentCellId,
  ): CityStreamingTransition {
    parseCellId(currentCellId);
    parseCellId(predictedCellId);
    const previousActive = new Set(this.#activeCellIds);
    const previousResident = new Set(this.#residentCellIds());
    const activeCellIds = currentAndAdjacentCellIds(currentCellId);
    const nextActive = new Set(activeCellIds);

    this.#accessCounter += 1;
    for (const cellId of activeCellIds) {
      this.#lastAccess.set(cellId, this.#accessCounter);
      this.#inactiveCells.delete(cellId);
    }

    for (const cellId of previousActive) {
      if (!nextActive.has(cellId) && !this.#failures.has(cellId)) {
        this.#inactiveCells.add(cellId);
      }
    }

    if (!nextActive.has(predictedCellId) && !this.#failures.has(predictedCellId)) {
      this.#lastAccess.set(predictedCellId, this.#accessCounter);
      this.#inactiveCells.add(predictedCellId);
    }

    this.#currentCellId = currentCellId;
    this.#predictedCellId = predictedCellId;
    this.#activeCellIds = activeCellIds;
    const evictedCellIds = this.#evictInactive();
    const currentResident = new Set(this.#residentCellIds());

    return {
      activatedCellIds: difference(nextActive, previousActive),
      deactivatedCellIds: difference(previousActive, nextActive),
      evictedCellIds: sortedCellIds(new Set([
        ...evictedCellIds,
        ...difference(previousResident, currentResident),
      ])),
      snapshot: this.snapshot(),
    };
  }

  public setQuality(quality: WorldQuality): CityStreamingLimits {
    this.#quality = quality;
    return this.#limits();
  }

  public setBaseResolutionScale(scale: number): CityStreamingLimits {
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 1) {
      throw new RangeError('base resolution scale must be between 0.5 and 1');
    }
    this.#baseResolutionScale = scale;
    return this.#limits();
  }

  public markCellFailed(
    boundary: Readonly<FailedChunkBoundary>,
    atMilliseconds: number,
    closure?: Readonly<RoadClosureState>,
  ): CellRetryState {
    parseCellId(boundary.cellId);
    if (boundary.fromCellId !== null) {
      parseCellId(boundary.fromCellId);
    }
    assertPositiveInteger(boundary.attempts, 'failure attempts');
    assertFiniteNonNegative(atMilliseconds, 'failure timestamp');
    if (boundary.error.trim().length === 0) {
      throw new Error('failure error cannot be empty');
    }
    if (closure && closure.toCellId !== boundary.cellId) {
      throw new Error('road closure destination must match the failed cell');
    }

    const existing = this.#failures.get(boundary.cellId);
    const retry = existing?.boundary.attempts === boundary.attempts
      ? existing.retry
      : this.#retryStateFor(boundary, atMilliseconds);
    const roadClosure = closure
      ? cloneClosure(closure)
      : this.#closureFor(boundary);

    this.#failures.set(boundary.cellId, {
      boundary: cloneBoundary(boundary),
      closure: roadClosure,
      retry,
    });
    this.#inactiveCells.delete(boundary.cellId);
    return cloneRetry(retry);
  }

  /** Synchronizes directly with NavigationRuntime.failureState(). */
  public syncFailureState(
    failedBoundaries: readonly Readonly<FailedChunkBoundary>[],
    roadClosures: readonly Readonly<RoadClosureState>[],
    atMilliseconds: number,
  ): void {
    assertFiniteNonNegative(atMilliseconds, 'failure timestamp');
    const incoming = new Set(failedBoundaries.map((boundary) => boundary.cellId));
    for (const cellId of this.#failures.keys()) {
      if (!incoming.has(cellId)) {
        this.markCellReady(cellId);
      }
    }
    for (const boundary of failedBoundaries) {
      const closure = roadClosures.find(
        (candidate) => candidate.toCellId === boundary.cellId,
      );
      this.markCellFailed(boundary, atMilliseconds, closure);
    }
  }

  public markCellReady(cellId: CellId): void {
    parseCellId(cellId);
    this.#failures.delete(cellId);
    if (
      cellId === this.#predictedCellId
      && !this.#activeCellIds.includes(cellId)
    ) {
      this.#accessCounter += 1;
      this.#lastAccess.set(cellId, this.#accessCounter);
      this.#inactiveCells.add(cellId);
      this.#evictInactive();
    }
  }

  public retryDueCellIds(atMilliseconds: number): readonly CellId[] {
    assertFiniteNonNegative(atMilliseconds, 'retry timestamp');
    return sortedCellIds(
      [...this.#failures.values()]
        .filter(
          ({ retry }) =>
            retry.status === 'waiting'
            && retry.nextRetryAtMilliseconds !== null
            && retry.nextRetryAtMilliseconds <= atMilliseconds,
        )
        .map(({ boundary }) => boundary.cellId),
    );
  }

  /**
   * Claims a due automatic retry. Pass force=true for an explicit player/manual retry
   * after automatic attempts are exhausted.
   */
  public beginRetry(
    cellId: CellId,
    atMilliseconds: number,
    force = false,
  ): CellRetryRequest {
    parseCellId(cellId);
    assertFiniteNonNegative(atMilliseconds, 'retry timestamp');
    const failure = this.#failures.get(cellId);
    if (!failure) {
      return { accepted: false, cellId, reason: 'unknown-cell' };
    }
    if (failure.retry.status === 'retrying') {
      return { accepted: false, cellId, reason: 'retrying' };
    }
    if (failure.retry.status === 'exhausted' && !force) {
      return { accepted: false, cellId, reason: 'exhausted' };
    }
    if (
      failure.retry.status === 'waiting'
      && !force
      && (failure.retry.nextRetryAtMilliseconds ?? Infinity) > atMilliseconds
    ) {
      return { accepted: false, cellId, reason: 'not-due' };
    }

    const attempt = failure.retry.nextAttempt;
    failure.retry = {
      ...failure.retry,
      status: 'retrying',
      nextRetryAtMilliseconds: null,
    };
    return { accepted: true, cellId, attempt };
  }

  public sampleFrame(frameMilliseconds: number): AdaptivePerformanceDecision {
    const reason = this.#recordAndEvaluateFrame(frameMilliseconds);
    return this.#adaptivePerformanceDecision(reason);
  }

  /**
   * Records a runtime frame without materializing rolling stats, limits, or a
   * decision unless the adaptive performance level actually changes.
   */
  public sampleRuntimeFrame(
    frameMilliseconds: number,
  ): AdaptivePerformanceDecision | null {
    const reason = this.#recordAndEvaluateFrame(frameMilliseconds);
    return reason === 'degraded' || reason === 'recovered'
      ? this.#adaptivePerformanceDecision(reason)
      : null;
  }

  #recordAndEvaluateFrame(
    frameMilliseconds: number,
  ): AdaptivePerformanceDecision['reason'] {
    assertFiniteNonNegative(frameMilliseconds, 'frame duration');
    this.#frameSamples.push(frameMilliseconds);
    if (this.#frameSamples.length > this.#frameWindowSize) {
      this.#frameSamples.shift();
    }
    this.#samplesSinceEvaluation += 1;
    let reason: AdaptivePerformanceDecision['reason'] =
      this.#frameSamples.length < this.#frameWindowSize ? 'collecting' : 'stable';

    if (
      this.#frameSamples.length === this.#frameWindowSize
      && this.#samplesSinceEvaluation >= this.#frameWindowSize
    ) {
      this.#samplesSinceEvaluation = 0;
      const averageMilliseconds = this.#averageFrameMilliseconds();
      const p95Milliseconds = this.#p95FrameMilliseconds();
      const slow =
        averageMilliseconds >= this.#slowFrameThresholdMilliseconds
        || p95Milliseconds >= this.#slowFrameThresholdMilliseconds * 1.35;
      const fast =
        averageMilliseconds <= this.#fastFrameThresholdMilliseconds
        && p95Milliseconds < this.#slowFrameThresholdMilliseconds;

      this.#slowWindowStreak = slow ? this.#slowWindowStreak + 1 : 0;
      this.#fastWindowStreak = fast ? this.#fastWindowStreak + 1 : 0;

      if (
        this.#slowWindowStreak >= this.#slowWindowsToDegrade
        && this.#performanceLevelIndex < PERFORMANCE_LEVELS.length - 1
      ) {
        this.#performanceLevelIndex += 1;
        this.#slowWindowStreak = 0;
        this.#fastWindowStreak = 0;
        reason = 'degraded';
      } else if (
        this.#fastWindowStreak >= this.#fastWindowsToRecover
        && this.#performanceLevelIndex > 0
      ) {
        this.#performanceLevelIndex -= 1;
        this.#slowWindowStreak = 0;
        this.#fastWindowStreak = 0;
        reason = 'recovered';
      }
    }

    return reason;
  }

  #adaptivePerformanceDecision(
    reason: AdaptivePerformanceDecision['reason'],
  ): AdaptivePerformanceDecision {
    const level = this.#performanceLevel();
    const changed = reason === 'degraded' || reason === 'recovered';
    const previousLevelIndex = reason === 'degraded'
      ? this.#performanceLevelIndex - 1
      : reason === 'recovered'
        ? this.#performanceLevelIndex + 1
        : this.#performanceLevelIndex;
    const previousLevel = PERFORMANCE_LEVELS[previousLevelIndex] ?? level;
    return {
      changed,
      reason,
      previousLevel,
      level,
      limits: this.#limits(),
      frames: this.#frameStats(),
    };
  }

  public resetAdaptivePerformance(): CityStreamingLimits {
    this.#performanceLevelIndex = 0;
    this.#frameSamples.length = 0;
    this.#samplesSinceEvaluation = 0;
    this.#slowWindowStreak = 0;
    this.#fastWindowStreak = 0;
    return this.#limits();
  }

  public snapshot(): CityStreamingSnapshot {
    const failed = [...this.#failures.values()].sort((left, right) =>
      left.boundary.cellId.localeCompare(right.boundary.cellId),
    );
    const renderableActiveCellIds = this.#activeCellIds.filter(
      (cellId) => !this.#failures.has(cellId),
    );
    const inactiveLruCellIds = this.#orderedInactiveCells();
    const residentCellIds = sortedCellIds([
      ...renderableActiveCellIds,
      ...inactiveLruCellIds,
    ]);
    const prefetchCellIds =
      this.#predictedCellId !== null
      && !this.#activeCellIds.includes(this.#predictedCellId)
      && !this.#failures.has(this.#predictedCellId)
        ? [this.#predictedCellId]
        : [];

    return {
      schemaVersion: 1,
      platform: this.#platform,
      quality: this.#quality,
      inactiveLruLimit: this.#inactiveLruLimit,
      currentCellId: this.#currentCellId,
      predictedCellId: this.#predictedCellId,
      activeCellIds: [...this.#activeCellIds],
      renderableActiveCellIds,
      inactiveLruCellIds,
      residentCellIds,
      prefetchCellIds,
      failedBoundaries: failed.map(({ boundary }) => cloneBoundary(boundary)),
      roadClosures: failed.map(({ closure }) => cloneClosure(closure)),
      retryStates: failed.map(({ retry }) => cloneRetry(retry)),
      performance: {
        level: this.#performanceLevel(),
        limits: this.#limits(),
        frames: this.#frameStats(),
      },
    };
  }

  #retryStateFor(
    boundary: Readonly<FailedChunkBoundary>,
    atMilliseconds: number,
  ): CellRetryState {
    const retryDelay = this.#retryDelaysMilliseconds[boundary.attempts - 1];
    return {
      cellId: boundary.cellId,
      status: retryDelay === undefined ? 'exhausted' : 'waiting',
      attemptsCompleted: boundary.attempts,
      nextAttempt: boundary.attempts + 1,
      nextRetryAtMilliseconds:
        retryDelay === undefined ? null : atMilliseconds + retryDelay,
    };
  }

  #closureFor(boundary: Readonly<FailedChunkBoundary>): RoadClosureState {
    return {
      id: `road-closure:${boundary.fromCellId ?? 'outside'}:${boundary.cellId}`,
      fromCellId: boundary.fromCellId,
      toCellId: boundary.cellId,
      reason: 'chunk-load-failed',
      message: `Road temporarily closed while ${boundary.cellId} is unavailable.`,
    };
  }

  #residentCellIds(): readonly CellId[] {
    return sortedCellIds([
      ...this.#activeCellIds.filter((cellId) => !this.#failures.has(cellId)),
      ...this.#inactiveCells,
    ]);
  }

  #orderedInactiveCells(): CellId[] {
    return [...this.#inactiveCells].sort((left, right) => {
      const difference =
        (this.#lastAccess.get(left) ?? 0) - (this.#lastAccess.get(right) ?? 0);
      return difference === 0 ? left.localeCompare(right) : difference;
    });
  }

  #evictInactive(): CellId[] {
    const ordered = this.#orderedInactiveCells();
    const removalCount = Math.max(0, ordered.length - this.#inactiveLruLimit);
    const evicted = ordered.slice(0, removalCount);
    for (const cellId of evicted) {
      this.#inactiveCells.delete(cellId);
      this.#lastAccess.delete(cellId);
    }
    return evicted;
  }

  #performanceLevel(): AdaptivePerformanceLevel {
    return PERFORMANCE_LEVELS[this.#performanceLevelIndex] ?? 'minimum';
  }

  #limits(): CityStreamingLimits {
    const level = this.#performanceLevel();
    const actorScale = LEVEL_ACTOR_SCALE[level];
    const baseDensity = QUALITY_DRAW_DENSITY[this.#quality];
    const levelDensity = LEVEL_DENSITY_SCALE[level];
    const usesLowQualityAdaptiveMinimum =
      this.#quality === 'low' && level === 'minimum';
    const adaptiveMinimumResolutionScale = this.#platform === 'mobile'
      ? MOBILE_MINIMUM_ADAPTIVE_RESOLUTION_SCALE
      : MINIMUM_ADAPTIVE_RESOLUTION_SCALE;
    const resolutionReduction = usesLowQualityAdaptiveMinimum
      ? defaultResolutionScale('low') - adaptiveMinimumResolutionScale
      : LEVEL_RESOLUTION_REDUCTION[level];
    const resolutionFloor = usesLowQualityAdaptiveMinimum
      ? adaptiveMinimumResolutionScale
      : 0.5;
    const traffic = Math.max(
      1,
      Math.floor(TRAFFIC_CAPACITY[this.#quality] * actorScale),
    );
    const pedestrians = Math.max(
      1,
      Math.floor(PEDESTRIAN_CAPACITY[this.#quality] * actorScale),
    );
    const combat = Math.max(
      1,
      Math.floor(COMBAT_CAPACITY[this.#quality] * actorScale),
    );
    return {
      quality: this.#quality,
      performanceLevel: level,
      actors: {
        traffic,
        pedestrians,
        combat,
        total: traffic + pedestrians + combat,
      },
      drawDensity: {
        roads: 1,
        structures: clamp01(baseDensity.structures * levelDensity.structures),
        props: clamp01(baseDensity.props * levelDensity.props),
        actors: clamp01(baseDensity.actors * levelDensity.actors),
        shadows: clamp01(baseDensity.shadows * levelDensity.shadows),
      },
      resolutionScale: Math.max(
        resolutionFloor,
        this.#baseResolutionScale - resolutionReduction,
      ),
    };
  }

  #frameStats(): RollingFrameStats {
    if (this.#frameSamples.length === 0) {
      return {
        sampleCount: 0,
        averageMilliseconds: 0,
        p95Milliseconds: 0,
        estimatedFramesPerSecond: 0,
      };
    }
    const averageMilliseconds = this.#averageFrameMilliseconds();
    const p95Milliseconds = this.#p95FrameMilliseconds();
    return {
      sampleCount: this.#frameSamples.length,
      averageMilliseconds,
      p95Milliseconds,
      estimatedFramesPerSecond:
        averageMilliseconds === 0 ? 0 : 1_000 / averageMilliseconds,
    };
  }

  #averageFrameMilliseconds(): number {
    const total = this.#frameSamples.reduce((sum, value) => sum + value, 0);
    return this.#frameSamples.length === 0
      ? 0
      : total / this.#frameSamples.length;
  }

  #p95FrameMilliseconds(): number {
    if (this.#frameSamples.length === 0) return 0;
    const sorted = [...this.#frameSamples].sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[p95Index] ?? 0;
  }
}
