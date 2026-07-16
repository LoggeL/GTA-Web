import { describe, expect, it } from 'vitest';

import { generateCity } from '../../src/game/city';
import {
  WORLD_CELL_SIZE_METERS,
  boundsForCell,
  buildWorldChunkDefinition,
  cellContainsPoint,
  cellIdAt,
  cellIdFromCoordinates,
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
});
