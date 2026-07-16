import { describe, expect, it, vi } from 'vitest';

import {
  NavigationRuntime,
  type CellId,
  type ChunkLoader,
  type MapMarker,
  type RoadGraph,
} from '../../src/navigation';

interface TestChunk {
  readonly id: CellId;
  readonly attempt: number;
}

const GRAPH: RoadGraph = {
  nodes: [
    { id: 'a', position: { x: 0, z: 0 }, district: 'arroyo-heights', roadIds: ['main', 'alternate'] },
    { id: 'b', position: { x: 100, z: 0 }, district: 'arroyo-heights', roadIds: ['main'] },
    { id: 'c', position: { x: 200, z: 0 }, district: 'arroyo-heights', roadIds: ['main', 'alternate'] },
    { id: 'd', position: { x: 100, z: 100 }, district: 'arroyo-heights', roadIds: ['alternate'] },
  ],
  edges: [
    { id: 'ab', fromNodeId: 'a', toNodeId: 'b', roadId: 'main', distanceMeters: 100, major: true },
    { id: 'bc', fromNodeId: 'b', toNodeId: 'c', roadId: 'main', distanceMeters: 100, major: true },
    { id: 'ad', fromNodeId: 'a', toNodeId: 'd', roadId: 'alternate', distanceMeters: 141, major: false },
    { id: 'dc', fromNodeId: 'd', toNodeId: 'c', roadId: 'alternate', distanceMeters: 141, major: false },
  ],
};

function loader(loaded: CellId[] = []): ChunkLoader<TestChunk> {
  return async (id, attempt) => {
    loaded.push(id);
    return { id, attempt };
  };
}

function runtime(
  chunkLoader: ChunkLoader<TestChunk> = loader(),
  platform: 'desktop' | 'mobile' = 'desktop',
): NavigationRuntime<TestChunk> {
  return new NavigationRuntime({
    graph: GRAPH,
    loader: chunkLoader,
    platform,
    retryDelaysMilliseconds: [0, 0],
    scheduler: async () => undefined,
    routeDeviationMeters: 25,
    arrivalDistanceMeters: 8,
  });
}

describe('NavigationRuntime streaming', () => {
  it('updates current and predicted cells while using the platform LRU policy', async () => {
    const navigation = runtime();
    const changed = vi.fn();
    navigation.events.on('cell:changed', changed);

    const result = await navigation.update({ x: 4, z: 4 }, { x: 300, z: 0 });

    expect(result.transition.committed).toBe(true);
    expect(result.currentCellId).toBe('cell:0:0');
    expect(result.predictedCellId).toBe('cell:2:0');
    expect(navigation.chunkSnapshot().inactiveLruLimit).toBe(2);
    expect(navigation.chunkSnapshot().inactiveLruCellIds).toContain('cell:2:0');
    expect(changed).toHaveBeenCalledWith({ previousCellId: null, currentCellId: 'cell:0:0' });
    expect(navigation.discoveredCellIds()).toEqual(['cell:0:0']);
  });

  it('preserves the last safe position at a failed boundary and explicitly retries', async () => {
    let available = false;
    const blocked: CellId = 'cell:1:0';
    const navigation = runtime(async (id, attempt) => {
      if (id === blocked && !available) throw new Error(`offline-${attempt}`);
      return { id, attempt };
    });
    await navigation.update({ x: 4, z: 4 });
    expect(navigation.failureState().failedBoundaries.map((entry) => entry.cellId)).toContain(blocked);

    const blockedUpdate = await navigation.update({ x: 260, z: 4 });
    expect(blockedUpdate.transition.committed).toBe(false);
    expect(blockedUpdate.currentCellId).toBe('cell:0:0');
    expect(blockedUpdate.safePosition).toEqual({ x: 4, z: 4 });

    available = true;
    expect((await navigation.retryFailedCell(blocked)).success).toBe(true);
    expect(navigation.failureState().failedBoundaries).toEqual([]);
    expect((await navigation.update({ x: 260, z: 4 })).transition.committed).toBe(true);
  });
});

describe('NavigationRuntime routing', () => {
  it('sets, progresses, replans, arrives, and clears a waypoint', async () => {
    const navigation = runtime();
    await navigation.update({ x: 0, z: 0 });
    expect(navigation.setWaypoint({
      id: 'goal', label: 'Goal', source: 'custom', position: { x: 200, z: 0 },
    }).success).toBe(true);
    expect(navigation.currentRoute.roadRoute?.edgeIds).toEqual(['ab', 'bc']);

    await navigation.update({ x: 100, z: 100 });
    expect(navigation.currentRoute.lastPlanReason).toBe('deviation');
    expect(navigation.currentRoute.roadRoute?.edgeIds).toEqual(['dc']);
    await navigation.update({ x: 198, z: 0 });
    expect(navigation.currentRoute.status).toBe('arrived');
    expect(navigation.currentRoute.remainingDistanceMeters).toBe(0);

    navigation.clearWaypoint();
    expect(navigation.currentWaypoint).toBeNull();
    expect(navigation.currentRoute.status).toBe('idle');
  });

  it('snaps an off-road custom waypoint to its reachable route target before arrival checks', async () => {
    const navigation = runtime();
    await navigation.update({ x: 0, z: 0 });

    expect(navigation.setWaypoint({
      id: 'off-road',
      label: 'Off-road map click',
      source: 'custom',
      position: { x: 200, z: 50 },
    }).success).toBe(true);

    expect(navigation.currentWaypoint).toEqual({
      id: 'off-road',
      label: 'Off-road map click',
      source: 'custom',
      position: { x: 200, z: 0 },
    });
    expect(navigation.currentRoute.roadRoute?.goalNodeId).toBe('c');

    await navigation.update({ x: 200, z: 0 });
    expect(navigation.currentRoute.status).toBe('arrived');
    expect(navigation.currentRoute.remainingDistanceMeters).toBe(0);
  });

  it('draws a direct local segment when both mission positions resolve to one road node', async () => {
    const navigation = runtime();
    await navigation.update({ x: 2, z: 2 });

    expect(navigation.setWaypoint({
      id: 'local-mission',
      label: 'Protect the garage',
      source: 'mission',
      position: { x: 28, z: 12 },
    }).success).toBe(true);

    expect(navigation.currentRoute.status).toBe('active');
    expect(navigation.currentRoute.roadRoute?.edgeIds).toEqual([]);
    expect(navigation.currentRoute.gpsRoute?.segments).toHaveLength(1);
    expect(navigation.currentRoute.remainingDistanceMeters).toBeCloseTo(Math.hypot(26, 10));

    await navigation.update({ x: 27, z: 12 });
    expect(navigation.currentRoute.status).toBe('arrived');
  });

  it('replans around closures and reports an unreachable destination', async () => {
    const navigation = runtime();
    await navigation.update({ x: 0, z: 0 });
    navigation.setWaypoint({
      id: 'goal', label: 'Goal', source: 'mission', position: { x: 200, z: 0 },
    });

    expect(navigation.closeRoadEdge('bc').success).toBe(true);
    expect(navigation.currentRoute.roadRoute?.edgeIds).toEqual(['ad', 'dc']);
    expect(navigation.closeRoadEdge('ad').success).toBe(false);
    expect(navigation.currentRoute.status).toBe('unreachable');
    expect(navigation.openRoadEdge('bc').success).toBe(true);
    expect(navigation.currentRoute.status).toBe('active');
    expect(navigation.closeRoadEdge('missing').success).toBe(false);
  });
});

describe('NavigationRuntime map, pins, and persistence', () => {
  const MARKERS: readonly MapMarker[] = [
    {
      id: 'home', kind: 'safehouse', label: 'Garage', position: { x: 4, z: 4 },
      cellId: 'cell:0:0', reveal: 'discovered',
    },
    {
      id: 'shop', kind: 'shop', label: 'Shop', position: { x: 260, z: 4 },
      cellId: 'cell:1:0', reveal: 'discovered',
    },
    {
      id: 'mission', kind: 'mission', label: 'Job', position: { x: 1_280, z: 4 },
      cellId: 'cell:5:0', reveal: 'discovered', missionId: 'night-train',
    },
  ];

  it('models fog, marker filters, and mission-pinned visibility', async () => {
    const navigation = runtime();
    await navigation.update({ x: 4, z: 4 });
    expect(navigation.setMarkers(MARKERS).success).toBe(true);
    expect(navigation.visibleMarkers().map((marker) => marker.id)).toEqual(['home']);

    expect((await navigation.pinMission('night-train', ['cell:5:0'])).success).toBe(true);
    expect(navigation.visibleMarkers().map((marker) => marker.id)).toEqual(['home', 'mission']);
    navigation.setMarkerFilter('mission', false);
    expect(navigation.visibleMarkers().map((marker) => marker.id)).toEqual(['home']);

    await navigation.update({ x: 260, z: 4 });
    expect(navigation.visibleMarkers().map((marker) => marker.id)).toEqual(['home', 'shop']);
    expect(navigation.unpinMission('night-train')).toEqual(['cell:5:0']);
  });

  it('round-trips serializable state and restores mobile LRU and mission pins', async () => {
    const first = runtime(loader(), 'mobile');
    await first.update({ x: 0, z: 0 });
    first.setWaypoint({ id: 'goal', label: 'Goal', source: 'custom', position: { x: 200, z: 0 } });
    first.closeRoadEdge('bc');
    first.setMarkers(MARKERS);
    first.setMarkerFilter('shop', false);
    await first.pinMission('night-train', ['cell:5:0']);
    const encoded = JSON.stringify(first.snapshot());

    const restored = runtime(loader(), 'mobile');
    expect((await restored.restore(JSON.parse(encoded) as unknown)).success).toBe(true);
    expect(restored.currentWaypoint?.id).toBe('goal');
    expect(restored.currentRoute.roadRoute?.edgeIds).toEqual(['ad', 'dc']);
    expect(restored.discoveredCellIds()).toEqual(['cell:0:0']);
    expect(restored.chunkSnapshot().inactiveLruLimit).toBe(1);
    expect(restored.chunkSnapshot().missionPins).toEqual([
      { missionId: 'night-train', cellIds: ['cell:5:0'] },
    ]);
    expect(restored.visibleMarkers().some((marker) => marker.id === 'shop')).toBe(false);

    const before = restored.snapshot();
    expect((await restored.restore({ schemaVersion: 99 })).success).toBe(false);
    expect(restored.snapshot()).toEqual(before);
  });
});
