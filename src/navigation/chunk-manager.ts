import {
  currentAndAdjacentCellIds,
  parseCellId,
  streamingCellSet,
} from './cells';
import type {
  CellId,
  ChunkManagerSnapshot,
  ChunkPrefetchResult,
  ChunkResidency,
  ChunkTransitionResult,
  FailedChunkBoundary,
  NavigationPoint,
  RoadClosureState,
  WorldChunkDefinition,
} from './types';

export type ChunkLoader<TChunk> = (cellId: CellId, attempt: number) => Promise<TChunk>;
export type ChunkRetryScheduler = (
  delayMilliseconds: number,
  cellId: CellId,
  nextAttempt: number,
) => Promise<void>;

export interface ChunkManagerOptions<TChunk> {
  readonly loader: ChunkLoader<TChunk>;
  readonly platform?: 'desktop' | 'mobile';
  readonly retryDelaysMilliseconds?: readonly [number, number];
  readonly scheduler?: ChunkRetryScheduler;
}

interface ChunkEntry<TChunk> {
  readonly cellId: CellId;
  residency: ChunkResidency;
  attempts: number;
  lastAccess: number;
  error: string | null;
  data: TChunk | undefined;
  pending: Promise<TChunk> | null;
}

const DEFAULT_RETRY_DELAYS = [250, 750] as const;

const defaultScheduler: ChunkRetryScheduler = async (delayMilliseconds) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMilliseconds);
  });
};

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown chunk loading error';
}

function sortedCellIds(values: Iterable<CellId>): CellId[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export class ChunkManager<TChunk = WorldChunkDefinition> {
  readonly #loader: ChunkLoader<TChunk>;
  readonly #platform: 'desktop' | 'mobile';
  readonly #inactiveLruLimit: 2 | 1;
  readonly #retryDelays: readonly [number, number];
  readonly #scheduler: ChunkRetryScheduler;
  readonly #entries = new Map<CellId, ChunkEntry<TChunk>>();
  readonly #missionPins = new Map<string, Set<CellId>>();
  readonly #failedBoundaries = new Map<CellId, FailedChunkBoundary>();
  readonly #roadClosures = new Map<string, RoadClosureState>();
  #currentCellId: CellId | null = null;
  #requiredCellIds = new Set<CellId>();
  #accessCounter = 0;

  public constructor(options: ChunkManagerOptions<TChunk>) {
    this.#loader = options.loader;
    this.#platform = options.platform ?? 'desktop';
    this.#inactiveLruLimit = this.#platform === 'desktop' ? 2 : 1;
    this.#retryDelays = options.retryDelaysMilliseconds ?? DEFAULT_RETRY_DELAYS;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    if (this.#retryDelays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new RangeError('Retry delays must be finite non-negative numbers');
    }
  }

  public get currentCellId(): CellId | null {
    return this.#currentCellId;
  }

  public get inactiveLruLimit(): 2 | 1 {
    return this.#inactiveLruLimit;
  }

  public hasReadyChunk(cellId: CellId): boolean {
    return this.#entries.get(cellId)?.residency === 'ready';
  }

  public getChunk(cellId: CellId): TChunk | undefined {
    const entry = this.#entries.get(cellId);
    if (entry?.residency !== 'ready') {
      return undefined;
    }
    this.#touch(entry);
    return entry.data;
  }

  public async transitionToCell(cellId: CellId): Promise<ChunkTransitionResult> {
    parseCellId(cellId);
    const previousCellId = this.#currentCellId;
    try {
      await this.#ensureLoaded(cellId, previousCellId, false);
    } catch {
      this.#evictInactive();
      return {
        requestedCellId: cellId,
        currentCellId: this.#currentCellId,
        committed: false,
        readyCellIds: this.#activeReadyCellIds(),
        failedCellIds: [cellId],
      };
    }

    this.#currentCellId = cellId;
    this.#requiredCellIds = new Set(currentAndAdjacentCellIds(cellId));
    const neighbors = currentAndAdjacentCellIds(cellId).slice(1);
    const prefetched = await this.#prefetch(neighbors, cellId);
    this.#evictInactive();
    return {
      requestedCellId: cellId,
      currentCellId: cellId,
      committed: true,
      readyCellIds: this.#activeReadyCellIds(),
      failedCellIds: prefetched.failedCellIds,
    };
  }

  public async updateForPosition(
    position: NavigationPoint,
    velocityMetersPerSecond: NavigationPoint,
    predictionSeconds: number = 2,
  ): Promise<ChunkTransitionResult> {
    const cells = streamingCellSet(position, velocityMetersPerSecond, predictionSeconds);
    const transition = await this.transitionToCell(cells.currentCellId);
    if (!transition.committed || this.#requiredCellIds.has(cells.predictedCellId)) {
      return transition;
    }

    const prediction = await this.#prefetch([cells.predictedCellId], cells.currentCellId);
    this.#evictInactive();
    return {
      ...transition,
      failedCellIds: sortedCellIds(
        new Set([...transition.failedCellIds, ...prediction.failedCellIds]),
      ),
    };
  }

  public async prefetchCells(cellIds: readonly CellId[]): Promise<ChunkPrefetchResult> {
    const result = await this.#prefetch(cellIds, this.#currentCellId);
    this.#evictInactive();
    return result;
  }

  public async pinForMission(
    missionId: string,
    cellIds: readonly CellId[],
  ): Promise<ChunkPrefetchResult> {
    if (missionId.trim().length === 0) {
      throw new Error('missionId cannot be empty');
    }
    const pinned = this.#missionPins.get(missionId) ?? new Set<CellId>();
    for (const cellId of cellIds) {
      parseCellId(cellId);
      pinned.add(cellId);
    }
    this.#missionPins.set(missionId, pinned);
    const result = await this.#prefetch(sortedCellIds(pinned), null);
    this.#evictInactive();
    return result;
  }

  public unpinMission(missionId: string): readonly CellId[] {
    const pinned = this.#missionPins.get(missionId);
    if (pinned === undefined) {
      return [];
    }
    this.#missionPins.delete(missionId);
    this.#evictInactive();
    return sortedCellIds(pinned);
  }

  public isPinned(cellId: CellId): boolean {
    for (const pinned of this.#missionPins.values()) {
      if (pinned.has(cellId)) {
        return true;
      }
    }
    return false;
  }

  public async retryFailed(cellId: CellId): Promise<TChunk> {
    const entry = this.#entries.get(cellId);
    if (entry?.residency !== 'failed') {
      const existing = this.getChunk(cellId);
      if (existing !== undefined) {
        return existing;
      }
    }
    const value = await this.#ensureLoaded(cellId, this.#currentCellId, true);
    this.#evictInactive();
    return value;
  }

  public snapshot(): ChunkManagerSnapshot {
    const entries = [...this.#entries.values()]
      .sort((left, right) => left.cellId.localeCompare(right.cellId))
      .map((entry) => ({
        cellId: entry.cellId,
        residency: entry.residency,
        attempts: entry.attempts,
        lastAccess: entry.lastAccess,
        active: this.#requiredCellIds.has(entry.cellId),
        pinned: this.isPinned(entry.cellId),
        error: entry.error,
      }));
    const inactiveLruCellIds = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.residency === 'ready' &&
          !this.#requiredCellIds.has(entry.cellId) &&
          !this.isPinned(entry.cellId),
      )
      .sort((left, right) => {
        const accessDifference = left.lastAccess - right.lastAccess;
        return accessDifference === 0
          ? left.cellId.localeCompare(right.cellId)
          : accessDifference;
      })
      .map((entry) => entry.cellId);
    const missionPins = [...this.#missionPins.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([missionId, cellIds]) => ({ missionId, cellIds: sortedCellIds(cellIds) }));

    return {
      schemaVersion: 1,
      platform: this.#platform,
      inactiveLruLimit: this.#inactiveLruLimit,
      currentCellId: this.#currentCellId,
      activeCellIds: this.#activeReadyCellIds(),
      inactiveLruCellIds,
      entries,
      missionPins,
      failedBoundaries: [...this.#failedBoundaries.values()].sort((left, right) =>
        left.cellId.localeCompare(right.cellId),
      ),
      roadClosures: [...this.#roadClosures.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
  }

  async #prefetch(
    source: readonly CellId[],
    fromCellId: CellId | null,
  ): Promise<ChunkPrefetchResult> {
    const cellIds = [...new Set(source)];
    for (const cellId of cellIds) {
      parseCellId(cellId);
    }
    const pending = cellIds.map((cellId) => this.#ensureLoaded(cellId, fromCellId, false));
    const results = await Promise.allSettled(pending);
    const readyCellIds: CellId[] = [];
    const failedCellIds: CellId[] = [];
    results.forEach((result, index) => {
      const cellId = cellIds[index];
      if (cellId === undefined) {
        return;
      }
      if (result.status === 'fulfilled') {
        readyCellIds.push(cellId);
      } else {
        failedCellIds.push(cellId);
      }
    });
    return {
      readyCellIds: sortedCellIds(readyCellIds),
      failedCellIds: sortedCellIds(failedCellIds),
    };
  }

  async #ensureLoaded(
    cellId: CellId,
    fromCellId: CellId | null,
    forceRetry: boolean,
  ): Promise<TChunk> {
    const existing = this.#entries.get(cellId);
    if (existing?.residency === 'ready' && existing.data !== undefined) {
      this.#touch(existing);
      return existing.data;
    }
    if (existing?.residency === 'loading' && existing.pending !== null) {
      this.#touch(existing);
      return existing.pending;
    }
    if (existing?.residency === 'failed' && !forceRetry) {
      this.#touch(existing);
      throw new Error(existing.error ?? `Chunk ${cellId} is unavailable`);
    }

    const entry: ChunkEntry<TChunk> = existing ?? {
      cellId,
      residency: 'loading',
      attempts: 0,
      lastAccess: 0,
      error: null,
      data: undefined,
      pending: null,
    };
    entry.residency = 'loading';
    entry.attempts = 0;
    entry.error = null;
    entry.data = undefined;
    this.#touch(entry);
    this.#entries.set(cellId, entry);
    const pending = this.#performLoad(entry, fromCellId).finally(() => {
      entry.pending = null;
    });
    entry.pending = pending;
    return pending;
  }

  async #performLoad(entry: ChunkEntry<TChunk>, fromCellId: CellId | null): Promise<TChunk> {
    let lastError = `Chunk ${entry.cellId} failed to load`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      entry.attempts = attempt;
      try {
        const data = await this.#loader(entry.cellId, attempt);
        entry.data = data;
        entry.error = null;
        entry.residency = 'ready';
        this.#clearFailure(entry.cellId);
        return data;
      } catch (error: unknown) {
        lastError = messageFromError(error);
        if (attempt <= 2) {
          const delay = this.#retryDelays[attempt - 1];
          if (delay === undefined) {
            break;
          }
          try {
            await this.#scheduler(delay, entry.cellId, attempt + 1);
          } catch (schedulerError: unknown) {
            lastError = messageFromError(schedulerError);
            break;
          }
        }
      }
    }

    entry.residency = 'failed';
    entry.data = undefined;
    entry.error = lastError;
    this.#recordFailure(entry, fromCellId);
    throw new Error(lastError);
  }

  #recordFailure(entry: ChunkEntry<TChunk>, fromCellId: CellId | null): void {
    this.#failedBoundaries.set(entry.cellId, {
      cellId: entry.cellId,
      fromCellId,
      attempts: entry.attempts,
      error: entry.error ?? 'Unknown chunk loading error',
    });
    const closureId = `road-closure:${fromCellId ?? 'outside'}:${entry.cellId}`;
    this.#roadClosures.set(closureId, {
      id: closureId,
      fromCellId,
      toCellId: entry.cellId,
      reason: 'chunk-load-failed',
      message: `Road temporarily closed while ${entry.cellId} is unavailable.`,
    });
  }

  #clearFailure(cellId: CellId): void {
    this.#failedBoundaries.delete(cellId);
    for (const [id, closure] of this.#roadClosures) {
      if (closure.toCellId === cellId) {
        this.#roadClosures.delete(id);
      }
    }
  }

  #activeReadyCellIds(): CellId[] {
    return sortedCellIds(
      [...this.#requiredCellIds].filter((cellId) => this.hasReadyChunk(cellId)),
    );
  }

  #touch(entry: ChunkEntry<TChunk>): void {
    this.#accessCounter += 1;
    entry.lastAccess = this.#accessCounter;
  }

  #evictInactive(): void {
    const candidates = [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.residency === 'ready' &&
          !this.#requiredCellIds.has(entry.cellId) &&
          !this.isPinned(entry.cellId),
      )
      .sort((left, right) => {
        const accessDifference = left.lastAccess - right.lastAccess;
        return accessDifference === 0
          ? left.cellId.localeCompare(right.cellId)
          : accessDifference;
      });
    const removalCount = Math.max(0, candidates.length - this.#inactiveLruLimit);
    for (let index = 0; index < removalCount; index += 1) {
      const entry = candidates[index];
      if (entry !== undefined) {
        this.#entries.delete(entry.cellId);
      }
    }
  }
}
