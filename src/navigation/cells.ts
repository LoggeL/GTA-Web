import type {
  CellBounds,
  CellCoordinates,
  CellId,
  NavigationPoint,
  StreamingCellSet,
} from './types';

export const WORLD_CELL_SIZE_METERS = 256;

function assertCellCoordinate(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
}

export function cellIdFromCoordinates(coordinates: CellCoordinates): CellId {
  assertCellCoordinate(coordinates.x, 'cell x');
  assertCellCoordinate(coordinates.z, 'cell z');
  return `cell:${coordinates.x}:${coordinates.z}`;
}

export function parseCellId(id: string): CellCoordinates {
  const match = /^cell:(-?\d+):(-?\d+)$/.exec(id);
  if (match === null) {
    throw new Error(`Invalid cell id: ${id}`);
  }
  const x = Number(match[1]);
  const z = Number(match[2]);
  assertCellCoordinate(x, 'cell x');
  assertCellCoordinate(z, 'cell z');
  return { x, z };
}

export function cellCoordinatesAt(point: NavigationPoint): CellCoordinates {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) {
    throw new TypeError('Cell position must contain finite coordinates');
  }
  return {
    x: Math.floor(point.x / WORLD_CELL_SIZE_METERS),
    z: Math.floor(point.z / WORLD_CELL_SIZE_METERS),
  };
}

export function cellIdAt(point: NavigationPoint): CellId {
  return cellIdFromCoordinates(cellCoordinatesAt(point));
}

export function boundsForCell(id: CellId): CellBounds {
  const coordinates = parseCellId(id);
  const minX = coordinates.x * WORLD_CELL_SIZE_METERS;
  const minZ = coordinates.z * WORLD_CELL_SIZE_METERS;
  return {
    minX,
    maxX: minX + WORLD_CELL_SIZE_METERS,
    minZ,
    maxZ: minZ + WORLD_CELL_SIZE_METERS,
  };
}

export function neighborCellIds(id: CellId): readonly CellId[] {
  const coordinates = parseCellId(id);
  const neighbors: CellId[] = [];
  for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      if (xOffset === 0 && zOffset === 0) {
        continue;
      }
      neighbors.push(
        cellIdFromCoordinates({
          x: coordinates.x + xOffset,
          z: coordinates.z + zOffset,
        }),
      );
    }
  }
  return neighbors;
}

export function currentAndAdjacentCellIds(id: CellId): readonly CellId[] {
  return [id, ...neighborCellIds(id)];
}

export function predictedCellId(
  position: NavigationPoint,
  velocityMetersPerSecond: NavigationPoint,
  predictionSeconds: number = 2,
): CellId {
  if (!Number.isFinite(predictionSeconds) || predictionSeconds < 0) {
    throw new RangeError('predictionSeconds must be a finite non-negative number');
  }
  return cellIdAt({
    x: position.x + velocityMetersPerSecond.x * predictionSeconds,
    z: position.z + velocityMetersPerSecond.z * predictionSeconds,
  });
}

export function streamingCellSet(
  position: NavigationPoint,
  velocityMetersPerSecond: NavigationPoint,
  predictionSeconds: number = 2,
): StreamingCellSet {
  const currentCellId = cellIdAt(position);
  const predicted = predictedCellId(position, velocityMetersPerSecond, predictionSeconds);
  const currentAndAdjacent = currentAndAdjacentCellIds(currentCellId);
  const ordered = new Set<CellId>(currentAndAdjacent);
  for (const id of currentAndAdjacentCellIds(predicted)) {
    ordered.add(id);
  }
  return {
    currentCellId,
    predictedCellId: predicted,
    currentAndAdjacentCellIds: currentAndAdjacent,
    prefetchCellIds: [...ordered],
  };
}

export function cellContainsPoint(id: CellId, point: NavigationPoint): boolean {
  const bounds = boundsForCell(id);
  return (
    point.x >= bounds.minX &&
    point.x < bounds.maxX &&
    point.z >= bounds.minZ &&
    point.z < bounds.maxZ
  );
}
