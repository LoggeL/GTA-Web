import { describe, expect, it } from 'vitest';

import {
  ChunkManager,
  currentAndAdjacentCellIds,
  type CellId,
  type ChunkLoader,
} from '../../src/navigation';

interface TestChunk {
  readonly id: CellId;
  readonly loadedAttempt: number;
}

function successfulLoader(loaded: CellId[] = []): ChunkLoader<TestChunk> {
  return async (id, attempt) => {
    loaded.push(id);
    return { id, loadedAttempt: attempt };
  };
}

describe('ChunkManager streaming and residency', () => {
  it('commits the current cell only after loading it and prefetches eight adjacent cells', async () => {
    const loaded: CellId[] = [];
    const manager = new ChunkManager({ loader: successfulLoader(loaded) });
    const result = await manager.transitionToCell('cell:0:0');
    const snapshot = manager.snapshot();

    expect(result.committed).toBe(true);
    expect(result.failedCellIds).toEqual([]);
    expect(new Set(loaded)).toEqual(new Set(currentAndAdjacentCellIds('cell:0:0')));
    expect(snapshot.currentCellId).toBe('cell:0:0');
    expect(snapshot.activeCellIds).toHaveLength(9);
    expect(snapshot.inactiveLruCellIds).toEqual([]);
  });

  it('keeps two inactive cells on desktop and one on mobile', async () => {
    const desktop = new ChunkManager({ loader: successfulLoader(), platform: 'desktop' });
    const mobile = new ChunkManager({ loader: successfulLoader(), platform: 'mobile' });

    await desktop.transitionToCell('cell:0:0');
    await desktop.transitionToCell('cell:1:0');
    await mobile.transitionToCell('cell:0:0');
    await mobile.transitionToCell('cell:1:0');

    expect(desktop.snapshot().inactiveLruLimit).toBe(2);
    expect(desktop.snapshot().inactiveLruCellIds).toHaveLength(2);
    expect(desktop.snapshot().entries.filter((entry) => entry.residency === 'ready')).toHaveLength(11);
    expect(mobile.snapshot().inactiveLruLimit).toBe(1);
    expect(mobile.snapshot().inactiveLruCellIds).toHaveLength(1);
    expect(mobile.snapshot().entries.filter((entry) => entry.residency === 'ready')).toHaveLength(10);
  });

  it('prefetches a non-adjacent predicted cell into the inactive LRU', async () => {
    const manager = new ChunkManager({ loader: successfulLoader() });
    const result = await manager.updateForPosition({ x: 4, z: 4 }, { x: 300, z: 0 }, 2);

    expect(result.committed).toBe(true);
    expect(manager.snapshot().inactiveLruCellIds).toContain('cell:2:0');
  });

  it('pins mission chunks across transitions and evicts them after the last mission unpins', async () => {
    const manager = new ChunkManager({ loader: successfulLoader(), platform: 'desktop' });
    await manager.pinForMission('mission-a', ['cell:10:10']);
    await manager.pinForMission('mission-b', ['cell:10:10']);
    await manager.transitionToCell('cell:0:0');
    await manager.transitionToCell('cell:1:0');

    expect(manager.isPinned('cell:10:10')).toBe(true);
    expect(manager.hasReadyChunk('cell:10:10')).toBe(true);
    manager.unpinMission('mission-a');
    expect(manager.isPinned('cell:10:10')).toBe(true);
    manager.unpinMission('mission-b');
    expect(manager.isPinned('cell:10:10')).toBe(false);
    expect(manager.hasReadyChunk('cell:10:10')).toBe(false);
  });

  it('produces a deterministic data-only snapshot', async () => {
    const manager = new ChunkManager({ loader: successfulLoader() });
    await manager.transitionToCell('cell:-1:2');
    await manager.pinForMission('night-train', ['cell:4:4']);
    const snapshot = manager.snapshot();
    const encoded = JSON.stringify(snapshot);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.missionPins).toEqual([
      { missionId: 'night-train', cellIds: ['cell:4:4'] },
    ]);
    expect(encoded).not.toContain('pending');
    expect(JSON.parse(encoded)).toEqual(snapshot);
  });
});

describe('ChunkManager retry and failure boundaries', () => {
  it('retries exactly twice with injected backoff before closing the failed boundary', async () => {
    const attempts: number[] = [];
    const scheduled: Array<{ delay: number; cellId: CellId; nextAttempt: number }> = [];
    const manager = new ChunkManager<TestChunk>({
      loader: async (id, attempt) => {
        attempts.push(attempt);
        throw new Error(`network-${id}-${attempt}`);
      },
      retryDelaysMilliseconds: [100, 300],
      scheduler: async (delay, cellId, nextAttempt) => {
        scheduled.push({ delay, cellId, nextAttempt });
      },
    });
    const result = await manager.transitionToCell('cell:0:0');
    const snapshot = manager.snapshot();

    expect(result.committed).toBe(false);
    expect(manager.currentCellId).toBeNull();
    expect(attempts).toEqual([1, 2, 3]);
    expect(scheduled).toEqual([
      { delay: 100, cellId: 'cell:0:0', nextAttempt: 2 },
      { delay: 300, cellId: 'cell:0:0', nextAttempt: 3 },
    ]);
    expect(snapshot.failedBoundaries).toEqual([
      {
        cellId: 'cell:0:0',
        fromCellId: null,
        attempts: 3,
        error: 'network-cell:0:0-3',
      },
    ]);
    expect(snapshot.roadClosures[0]).toMatchObject({
      fromCellId: null,
      toCellId: 'cell:0:0',
      reason: 'chunk-load-failed',
    });
  });

  it('commits a ready current cell while exposing an adjacent load failure', async () => {
    const failedId: CellId = 'cell:1:0';
    const manager = new ChunkManager<TestChunk>({
      loader: async (id, attempt) => {
        if (id === failedId) {
          throw new Error(`blocked-${attempt}`);
        }
        return { id, loadedAttempt: attempt };
      },
      retryDelaysMilliseconds: [0, 0],
      scheduler: async () => undefined,
    });
    const result = await manager.transitionToCell('cell:0:0');
    const snapshot = manager.snapshot();

    expect(result.committed).toBe(true);
    expect(result.failedCellIds).toEqual([failedId]);
    expect(snapshot.activeCellIds).toHaveLength(8);
    expect(snapshot.failedBoundaries[0]).toMatchObject({
      cellId: failedId,
      fromCellId: 'cell:0:0',
      attempts: 3,
    });
  });

  it('clears the boundary and road closure after an explicit successful retry', async () => {
    const failedId: CellId = 'cell:1:0';
    let available = false;
    const manager = new ChunkManager<TestChunk>({
      loader: async (id, attempt) => {
        if (id === failedId && !available) {
          throw new Error('offline');
        }
        return { id, loadedAttempt: attempt };
      },
      retryDelaysMilliseconds: [0, 0],
      scheduler: async () => undefined,
    });
    await manager.transitionToCell('cell:0:0');
    expect(manager.snapshot().roadClosures).toHaveLength(1);

    available = true;
    await manager.retryFailed(failedId);
    const snapshot = manager.snapshot();
    expect(snapshot.failedBoundaries).toEqual([]);
    expect(snapshot.roadClosures).toEqual([]);
    expect(snapshot.activeCellIds).toHaveLength(9);
  });

  it('preserves the prior current cell when a requested destination cannot commit', async () => {
    let blocked: CellId | null = null;
    const manager = new ChunkManager<TestChunk>({
      loader: async (id, attempt) => {
        if (id === blocked) {
          throw new Error('unavailable');
        }
        return { id, loadedAttempt: attempt };
      },
      retryDelaysMilliseconds: [0, 0],
      scheduler: async () => undefined,
    });
    await manager.transitionToCell('cell:0:0');
    blocked = 'cell:5:5';
    const result = await manager.transitionToCell(blocked);

    expect(result.committed).toBe(false);
    expect(result.currentCellId).toBe('cell:0:0');
    expect(manager.currentCellId).toBe('cell:0:0');
  });
});
