import type { DistrictId } from '../game/types';

export interface NavigationPoint {
  readonly x: number;
  readonly z: number;
}

export interface RoadGraphNode {
  readonly id: string;
  readonly position: NavigationPoint;
  readonly district: DistrictId;
  readonly roadIds: readonly string[];
}

export interface RoadGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly roadId: string;
  readonly distanceMeters: number;
  readonly major: boolean;
}

export interface RoadGraph {
  readonly nodes: readonly RoadGraphNode[];
  readonly edges: readonly RoadGraphEdge[];
}

export interface RoadRoute {
  readonly startNodeId: string;
  readonly goalNodeId: string;
  readonly nodeIds: readonly string[];
  readonly points: readonly NavigationPoint[];
  readonly edgeIds: readonly string[];
  readonly distanceMeters: number;
}

export interface GpsRouteSegment {
  readonly index: number;
  readonly from: NavigationPoint;
  readonly to: NavigationPoint;
  readonly distanceMeters: number;
  readonly headingRadians: number;
}

export interface GpsRoute {
  readonly points: readonly NavigationPoint[];
  readonly segments: readonly GpsRouteSegment[];
  readonly distanceMeters: number;
}

export type CellId = `cell:${number}:${number}`;

export interface CellCoordinates {
  readonly x: number;
  readonly z: number;
}

export interface CellBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface StreamingCellSet {
  readonly currentCellId: CellId;
  readonly predictedCellId: CellId;
  readonly currentAndAdjacentCellIds: readonly CellId[];
  readonly prefetchCellIds: readonly CellId[];
}

export interface ChunkStaticGeometryRecipe {
  readonly id: string;
  readonly kind: 'building' | 'prop';
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly scale: { readonly x: number; readonly y: number; readonly z: number };
  readonly sourceKind: string;
}

export interface ChunkRoadDefinition {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly width: number;
  readonly depth: number;
  readonly major: boolean;
}

export interface ChunkSpawnZone {
  readonly id: string;
  readonly kind: 'traffic' | 'pedestrian' | 'mission';
  readonly bounds: CellBounds;
  readonly capacity: number;
}

export interface ChunkNavNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly neighborIds: readonly string[];
}

export interface ChunkInteriorPortal {
  readonly id: string;
  readonly interiorId: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

export interface WorldChunkManifest {
  readonly schemaVersion: 1;
  readonly id: CellId;
  readonly district: DistrictId;
  readonly bounds: CellBounds;
  readonly neighbors: readonly CellId[];
  readonly seed: number;
  readonly requiredAssets: readonly string[];
  readonly hash: string;
  readonly version: number;
}

export interface WorldChunkDefinition {
  readonly manifest: WorldChunkManifest;
  readonly staticGeometryRecipes: readonly ChunkStaticGeometryRecipe[];
  readonly roads: readonly ChunkRoadDefinition[];
  readonly spawnZones: readonly ChunkSpawnZone[];
  readonly navNodes: readonly ChunkNavNode[];
  readonly interiors: readonly ChunkInteriorPortal[];
}

export type ChunkResidency = 'loading' | 'ready' | 'failed';

export interface FailedChunkBoundary {
  readonly cellId: CellId;
  readonly fromCellId: CellId | null;
  readonly attempts: number;
  readonly error: string;
}

export interface RoadClosureState {
  readonly id: string;
  readonly fromCellId: CellId | null;
  readonly toCellId: CellId;
  readonly reason: 'chunk-load-failed';
  readonly message: string;
}

export interface ChunkSnapshotEntry {
  readonly cellId: CellId;
  readonly residency: ChunkResidency;
  readonly attempts: number;
  readonly lastAccess: number;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly error: string | null;
}

export interface ChunkManagerSnapshot {
  readonly schemaVersion: 1;
  readonly platform: 'desktop' | 'mobile';
  readonly inactiveLruLimit: 2 | 1;
  readonly currentCellId: CellId | null;
  readonly activeCellIds: readonly CellId[];
  readonly inactiveLruCellIds: readonly CellId[];
  readonly entries: readonly ChunkSnapshotEntry[];
  readonly missionPins: readonly {
    readonly missionId: string;
    readonly cellIds: readonly CellId[];
  }[];
  readonly failedBoundaries: readonly FailedChunkBoundary[];
  readonly roadClosures: readonly RoadClosureState[];
}

export interface ChunkTransitionResult {
  readonly requestedCellId: CellId;
  readonly currentCellId: CellId | null;
  readonly committed: boolean;
  readonly readyCellIds: readonly CellId[];
  readonly failedCellIds: readonly CellId[];
}

export interface ChunkPrefetchResult {
  readonly readyCellIds: readonly CellId[];
  readonly failedCellIds: readonly CellId[];
}
