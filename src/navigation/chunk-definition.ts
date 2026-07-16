import { districtAt } from '../game/city';
import type { BuildingRecipe, CityLayout, PropRecipe, RoadRecipe } from '../game/city';
import { AUTHORED_INTERIORS } from '../game/InteriorRuntime';
import { boundsForCell, neighborCellIds, parseCellId } from './cells';
import { buildRoadGraph } from './road-graph';
import type {
  CellBounds,
  CellId,
  ChunkNavNode,
  ChunkRoadDefinition,
  ChunkSpawnZone,
  ChunkStaticGeometryRecipe,
  WorldChunkDefinition,
  WorldChunkManifest,
} from './types';

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashHex(value: string): string {
  return hashText(value).toString(16).padStart(8, '0');
}

function canonicalSerialize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Chunk hash payload numbers must be finite');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSerialize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported chunk hash payload value: ${typeof value}`);
}

function canonicalIdOrder<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => {
    const idOrder = left.id.localeCompare(right.id);
    return idOrder === 0
      ? canonicalSerialize(left).localeCompare(canonicalSerialize(right))
      : idOrder;
  });
}

/** Hashes all authored chunk content while deliberately excluding the hash field itself. */
export function hashWorldChunkDefinition(definition: WorldChunkDefinition): string {
  const payload = {
    manifest: {
      schemaVersion: definition.manifest.schemaVersion,
      id: definition.manifest.id,
      district: definition.manifest.district,
      bounds: definition.manifest.bounds,
      neighbors: [...definition.manifest.neighbors].sort((left, right) => left.localeCompare(right)),
      seed: definition.manifest.seed,
      requiredAssets: [...definition.manifest.requiredAssets].sort((left, right) => left.localeCompare(right)),
      version: definition.manifest.version,
    },
    staticGeometryRecipes: canonicalIdOrder(definition.staticGeometryRecipes),
    roads: canonicalIdOrder(definition.roads),
    spawnZones: canonicalIdOrder(definition.spawnZones),
    navNodes: canonicalIdOrder(definition.navNodes).map((node) => ({
      ...node,
      neighborIds: [...node.neighborIds].sort((left, right) => left.localeCompare(right)),
    })),
    interiors: canonicalIdOrder(definition.interiors),
  };
  return hashHex(canonicalSerialize(payload));
}

function pointInside(bounds: CellBounds, x: number, z: number): boolean {
  return x >= bounds.minX && x < bounds.maxX && z >= bounds.minZ && z < bounds.maxZ;
}

function rectangleIntersects(
  bounds: CellBounds,
  centerX: number,
  centerZ: number,
  width: number,
  depth: number,
): boolean {
  return (
    centerX + width / 2 >= bounds.minX &&
    centerX - width / 2 < bounds.maxX &&
    centerZ + depth / 2 >= bounds.minZ &&
    centerZ - depth / 2 < bounds.maxZ
  );
}

function buildingGeometry(building: BuildingRecipe): ChunkStaticGeometryRecipe {
  return {
    id: building.id,
    kind: 'building',
    position: building.position,
    scale: { x: building.width, y: building.height, z: building.depth },
    sourceKind: building.roofStyle,
  };
}

function propGeometry(prop: PropRecipe): ChunkStaticGeometryRecipe {
  return {
    id: prop.id,
    kind: 'prop',
    position: prop.position,
    scale: { x: prop.scale, y: prop.scale, z: prop.scale },
    sourceKind: prop.kind,
  };
}

function roadDefinition(road: RoadRecipe): ChunkRoadDefinition {
  return {
    id: road.id,
    position: road.position,
    width: road.width,
    depth: road.depth,
    major: road.major,
  };
}

function spawnZones(id: CellId, bounds: CellBounds): readonly ChunkSpawnZone[] {
  const margin = 24;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  return [
    {
      id: `${id}:traffic-zone`,
      kind: 'traffic',
      bounds: {
        minX: bounds.minX + margin,
        maxX: bounds.maxX - margin,
        minZ: bounds.minZ + margin,
        maxZ: bounds.maxZ - margin,
      },
      capacity: 8,
    },
    {
      id: `${id}:pedestrian-zone`,
      kind: 'pedestrian',
      bounds: {
        minX: centerX - 48,
        maxX: centerX + 48,
        minZ: bounds.minZ + margin,
        maxZ: bounds.maxZ - margin,
      },
      capacity: 14,
    },
  ];
}

export function buildWorldChunkDefinition(
  layout: CityLayout,
  id: CellId,
  version: number = 1,
): WorldChunkDefinition {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('Chunk version must be a positive safe integer');
  }
  const bounds = boundsForCell(id);
  const coordinates = parseCellId(id);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const roads = layout.roads
    .filter((road) => rectangleIntersects(bounds, road.position.x, road.position.z, road.width, road.depth))
    .map(roadDefinition)
    .sort((left, right) => left.id.localeCompare(right.id));
  const staticGeometryRecipes: ChunkStaticGeometryRecipe[] = [
    ...layout.buildings
      .filter((building) =>
        rectangleIntersects(
          bounds,
          building.position.x,
          building.position.z,
          building.width,
          building.depth,
        ),
      )
      .map(buildingGeometry),
    ...layout.props
      .filter((prop) => pointInside(bounds, prop.position.x, prop.position.z))
      .map(propGeometry),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const graph = buildRoadGraph(layout);
  const graphEdges = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const from = graphEdges.get(edge.fromNodeId) ?? new Set<string>();
    from.add(edge.toNodeId);
    graphEdges.set(edge.fromNodeId, from);
    const to = graphEdges.get(edge.toNodeId) ?? new Set<string>();
    to.add(edge.fromNodeId);
    graphEdges.set(edge.toNodeId, to);
  }
  const navNodes: ChunkNavNode[] = graph.nodes
    .filter((node) => pointInside(bounds, node.position.x, node.position.z))
    .map((node) => ({
      id: node.id,
      x: node.position.x,
      z: node.position.z,
      neighborIds: [...(graphEdges.get(node.id) ?? [])].sort(),
    }));
  const interiors = AUTHORED_INTERIORS
    .filter((definition) => definition.portal.cellId === id)
    .map((definition) => ({
      id: definition.portal.id,
      interiorId: definition.id,
      position: { ...definition.portal.position },
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const seed = hashText(`${layout.seed}:${coordinates.x}:${coordinates.z}`);
  const chunkSpawnZones = spawnZones(id, bounds);
  const manifest: WorldChunkManifest = {
    schemaVersion: 1,
    id,
    district: districtAt(centerX, centerZ),
    bounds,
    neighbors: neighborCellIds(id),
    seed,
    requiredAssets: [],
    hash: '',
    version,
  };
  const definition: WorldChunkDefinition = {
    manifest,
    staticGeometryRecipes,
    roads,
    spawnZones: chunkSpawnZones,
    navNodes,
    interiors,
  };
  return {
    ...definition,
    manifest: {
      ...manifest,
      hash: hashWorldChunkDefinition(definition),
    },
  };
}
