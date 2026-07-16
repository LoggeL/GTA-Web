import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
import {
  WORLD_CELL_SIZE_METERS,
  boundsForCell,
  buildWorldChunkDefinition,
  cellContainsPoint,
  cellIdAt,
  cellIdFromCoordinates,
  hashWorldChunkDefinition,
  neighborCellIds,
  parseCellId,
  predictedCellId,
  streamingCellSet,
} from '../../src/navigation';

describe('256 meter world cells', () => {
  it('uses floor-based ids across positive and negative boundaries', () => {
    expect(WORLD_CELL_SIZE_METERS).toBe(256);
    expect(cellIdAt({ x: 0, z: 0 })).toBe('cell:0:0');
    expect(cellIdAt({ x: 255.999, z: -0.001 })).toBe('cell:0:-1');
    expect(cellIdAt({ x: -256, z: 256 })).toBe('cell:-1:1');
    expect(cellIdAt({ x: -256.001, z: -256.001 })).toBe('cell:-2:-2');
    expect(parseCellId(cellIdFromCoordinates({ x: -2, z: 3 }))).toEqual({ x: -2, z: 3 });
  });

  it('returns exact half-open bounds and eight unique neighbors', () => {
    expect(boundsForCell('cell:-1:2')).toEqual({
      minX: -256,
      maxX: 0,
      minZ: 512,
      maxZ: 768,
    });
    expect(cellContainsPoint('cell:-1:2', { x: -256, z: 512 })).toBe(true);
    expect(cellContainsPoint('cell:-1:2', { x: 0, z: 512 })).toBe(false);
    const neighbors = neighborCellIds('cell:0:0');
    expect(neighbors).toHaveLength(8);
    expect(new Set(neighbors).size).toBe(8);
    expect(neighbors).not.toContain('cell:0:0');
  });

  it('predicts travel cells and returns an ordered current/prefetch set', () => {
    expect(predictedCellId({ x: 250, z: 20 }, { x: 10, z: 0 }, 2)).toBe('cell:1:0');
    const cells = streamingCellSet({ x: 250, z: 20 }, { x: 10, z: 0 }, 2);

    expect(cells.currentCellId).toBe('cell:0:0');
    expect(cells.predictedCellId).toBe('cell:1:0');
    expect(cells.currentAndAdjacentCellIds).toHaveLength(9);
    expect(cells.prefetchCellIds).toHaveLength(12);
    expect(cells.prefetchCellIds[0]).toBe(cells.currentCellId);
  });

  it('rejects malformed ids and invalid prediction inputs', () => {
    expect(() => parseCellId('cell:1.2:0')).toThrow('Invalid cell id');
    expect(() => parseCellId('tile:1:0')).toThrow('Invalid cell id');
    expect(() => predictedCellId({ x: 0, z: 0 }, { x: 1, z: 1 }, -1)).toThrow(
      'predictionSeconds',
    );
  });
});

describe('world chunk definitions', () => {
  it('builds deterministic serializable manifests and cell-local content', () => {
    const city = generateCity('chunk-definition', 'low');
    const first = buildWorldChunkDefinition(city, 'cell:-1:0');
    const second = buildWorldChunkDefinition(city, 'cell:-1:0');
    const adjacent = buildWorldChunkDefinition(city, 'cell:0:0');

    expect(first).toEqual(second);
    expect(first.manifest.id).toBe('cell:-1:0');
    expect(first.manifest.schemaVersion).toBe(1);
    expect(first.manifest.neighbors).toHaveLength(8);
    expect(first.manifest.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(first.manifest.hash).not.toBe(adjacent.manifest.hash);
    expect(first.roads.length).toBeGreaterThan(0);
    expect(first.staticGeometryRecipes.length).toBeGreaterThan(0);
    expect(first.navNodes.length).toBeGreaterThan(0);
    expect(first.spawnZones).toHaveLength(2);
    expect(() => JSON.parse(JSON.stringify(first))).not.toThrow();
  });

  it('hashes transformed geometry, roads, spawn zones, and interior portals, not only ids', () => {
    const city = generateCity('chunk-definition-content-hash', 'low');
    const chunk = buildWorldChunkDefinition(city, 'cell:-1:0');
    const geometry = chunk.staticGeometryRecipes[0];
    const road = chunk.roads[0];
    const spawnZone = chunk.spawnZones[0];
    const interior = chunk.interiors[0];
    expect(geometry).toBeDefined();
    expect(road).toBeDefined();
    expect(spawnZone).toBeDefined();
    expect(interior).toBeDefined();
    if (!geometry || !road || !spawnZone || !interior) return;

    const variants = [
      {
        ...chunk,
        staticGeometryRecipes: chunk.staticGeometryRecipes.map((recipe, index) => index === 0
          ? { ...recipe, position: { ...recipe.position, x: recipe.position.x + 0.25 } }
          : recipe),
      },
      {
        ...chunk,
        staticGeometryRecipes: chunk.staticGeometryRecipes.map((recipe, index) => index === 0
          ? { ...recipe, scale: { ...recipe.scale, y: recipe.scale.y + 0.25 } }
          : recipe),
      },
      {
        ...chunk,
        roads: chunk.roads.map((recipe, index) => index === 0
          ? { ...recipe, width: recipe.width + 0.25 }
          : recipe),
      },
      {
        ...chunk,
        spawnZones: chunk.spawnZones.map((zone, index) => index === 0
          ? { ...zone, capacity: zone.capacity + 1 }
          : zone),
      },
      {
        ...chunk,
        interiors: chunk.interiors.map((portal, index) => index === 0
          ? { ...portal, position: { ...portal.position, z: portal.position.z + 0.25 } }
          : portal),
      },
    ];

    for (const variant of variants) {
      expect(hashWorldChunkDefinition(variant)).not.toBe(chunk.manifest.hash);
    }
  });

  it('uses canonical ordering and excludes the existing hash from its hash payload', () => {
    const city = generateCity('chunk-definition-canonical-hash', 'low');
    const chunk = buildWorldChunkDefinition(city, 'cell:-1:0');
    expect(hashWorldChunkDefinition(chunk)).toBe(chunk.manifest.hash);
    const reordered = {
      ...chunk,
      manifest: {
        ...chunk.manifest,
        hash: 'this-value-is-not-part-of-the-payload',
        neighbors: [...chunk.manifest.neighbors].reverse(),
        requiredAssets: [...chunk.manifest.requiredAssets].reverse(),
      },
      staticGeometryRecipes: [...chunk.staticGeometryRecipes].reverse(),
      roads: [...chunk.roads].reverse(),
      spawnZones: [...chunk.spawnZones].reverse(),
      navNodes: [...chunk.navNodes].reverse().map((node) => ({
        ...node,
        neighborIds: [...node.neighborIds].reverse(),
      })),
      interiors: [...chunk.interiors].reverse(),
    };

    expect(hashWorldChunkDefinition(reordered)).toBe(chunk.manifest.hash);
  });
});
