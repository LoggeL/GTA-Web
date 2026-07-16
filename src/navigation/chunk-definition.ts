import { districtAt } from '../game/city';
import type { BuildingRecipe, CityLayout, PropRecipe, RoadRecipe } from '../game/city';
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
  const seed = hashText(`${layout.seed}:${coordinates.x}:${coordinates.z}`);
  const contentIdentity = JSON.stringify({
    id,
    seed,
    version,
    geometry: staticGeometryRecipes.map((recipe) => recipe.id),
    roads: roads.map((road) => road.id),
    nav: navNodes.map((node) => node.id),
  });
  const manifest: WorldChunkManifest = {
    schemaVersion: 1,
    id,
    district: districtAt(centerX, centerZ),
    bounds,
    neighbors: neighborCellIds(id),
    seed,
    requiredAssets: [],
    hash: hashHex(contentIdentity),
    version,
  };

  return {
    manifest,
    staticGeometryRecipes,
    roads,
    spawnZones: spawnZones(id, bounds),
    navNodes,
    interiors: [],
  };
}
