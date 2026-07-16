import { EventBus } from '../core/events';
import { parseCellId, streamingCellSet } from './cells';
import {
  ChunkManager,
  type ChunkLoader,
  type ChunkRetryScheduler,
} from './chunk-manager';
import { createGpsRoute, findRoadRoute } from './road-graph';
import type {
  CellId,
  ChunkManagerSnapshot,
  ChunkTransitionResult,
  FailedChunkBoundary,
  GpsRoute,
  NavigationPoint,
  RoadClosureState,
  RoadGraph,
  RoadRoute,
  WorldChunkDefinition,
} from './types';

export const NAVIGATION_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export type MapMarkerKind =
  | 'mission'
  | 'property'
  | 'activity'
  | 'shop'
  | 'safehouse'
  | 'custom';

export interface MapMarker {
  readonly id: string;
  readonly kind: MapMarkerKind;
  readonly label: string;
  readonly position: NavigationPoint;
  readonly cellId: CellId;
  readonly reveal: 'discovered' | 'always';
  readonly missionId?: string;
}

export interface WaypointState {
  readonly id: string;
  readonly position: NavigationPoint;
  readonly label: string;
  readonly source: 'custom' | 'mission' | 'marker';
}

export interface RouteState {
  readonly status: 'idle' | 'pending' | 'active' | 'arrived' | 'unreachable';
  readonly roadRoute: RoadRoute | null;
  readonly gpsRoute: GpsRoute | null;
  readonly segmentIndex: number;
  readonly remainingDistanceMeters: number;
  readonly revision: number;
  readonly lastPlanReason: RoutePlanReason | null;
}

export type RoutePlanReason = 'waypoint' | 'deviation' | 'closure' | 'restore' | 'position-ready';

export interface NavigationFailureState {
  readonly failedBoundaries: readonly FailedChunkBoundary[];
  readonly roadClosures: readonly RoadClosureState[];
  readonly blockedCellId: CellId | null;
}

export interface NavigationUpdateResult {
  readonly transition: ChunkTransitionResult;
  readonly currentCellId: CellId | null;
  readonly predictedCellId: CellId;
  readonly safePosition: NavigationPoint | null;
  readonly route: RouteState;
  readonly failures: NavigationFailureState;
}

export interface NavigationRuntimeSnapshotV1 {
  readonly schemaVersion: typeof NAVIGATION_RUNTIME_SNAPSHOT_VERSION;
  readonly platform: 'desktop' | 'mobile';
  readonly position: NavigationPoint | null;
  readonly velocity: NavigationPoint;
  readonly predictedCellId: CellId | null;
  readonly waypoint: WaypointState | null;
  readonly routeStatus: RouteState['status'];
  readonly routeSegmentIndex: number;
  readonly discoveredCellIds: readonly CellId[];
  readonly markers: readonly MapMarker[];
  readonly filters: Readonly<Record<MapMarkerKind, boolean>>;
  readonly closedEdgeIds: readonly string[];
  readonly chunkManager: ChunkManagerSnapshot;
}

export interface NavigationRuntimeEventMap {
  'cell:changed': { previousCellId: CellId | null; currentCellId: CellId };
  'cell:discovered': { cellId: CellId };
  'route:changed': { route: RouteState; reason: RoutePlanReason };
  'route:progress': { segmentIndex: number; remainingDistanceMeters: number };
  'waypoint:arrived': { waypoint: WaypointState };
  'stream:failed': { failures: NavigationFailureState };
  'stream:recovered': { cellId: CellId };
}

export interface NavigationRuntimeOptions<TChunk = WorldChunkDefinition> {
  readonly graph: RoadGraph;
  readonly loader: ChunkLoader<TChunk>;
  readonly platform?: 'desktop' | 'mobile';
  readonly retryDelaysMilliseconds?: readonly [number, number];
  readonly scheduler?: ChunkRetryScheduler;
  readonly predictionSeconds?: number;
  readonly routeDeviationMeters?: number;
  readonly arrivalDistanceMeters?: number;
  readonly events?: EventBus<NavigationRuntimeEventMap>;
}

export type NavigationActionResult =
  | { success: true }
  | { success: false; reason: string };

const MARKER_KINDS: readonly MapMarkerKind[] = [
  'mission', 'property', 'activity', 'shop', 'safehouse', 'custom',
];

export class NavigationRuntime<TChunk = WorldChunkDefinition> {
  public readonly events: EventBus<NavigationRuntimeEventMap>;

  private readonly graph: RoadGraph;
  private readonly chunks: ChunkManager<TChunk>;
  private readonly platform: 'desktop' | 'mobile';
  private readonly predictionSeconds: number;
  private readonly routeDeviationMeters: number;
  private readonly arrivalDistanceMeters: number;
  private position: NavigationPoint | null = null;
  private velocity: NavigationPoint = { x: 0, z: 0 };
  private predictedCell: CellId | null = null;
  private waypoint: WaypointState | null = null;
  private route: RouteState = emptyRoute('idle');
  private readonly discovered = new Set<CellId>();
  private markers: MapMarker[] = [];
  private filters: Record<MapMarkerKind, boolean> = defaultFilters();
  private readonly closedEdges = new Set<string>();

  public constructor(options: NavigationRuntimeOptions<TChunk>) {
    this.graph = options.graph;
    this.platform = options.platform ?? 'desktop';
    this.predictionSeconds = options.predictionSeconds ?? 2;
    this.routeDeviationMeters = options.routeDeviationMeters ?? 35;
    this.arrivalDistanceMeters = options.arrivalDistanceMeters ?? 12;
    assertNonNegativeFinite(this.predictionSeconds, 'predictionSeconds');
    assertNonNegativeFinite(this.routeDeviationMeters, 'routeDeviationMeters');
    assertNonNegativeFinite(this.arrivalDistanceMeters, 'arrivalDistanceMeters');
    this.events = options.events ?? new EventBus<NavigationRuntimeEventMap>();
    this.chunks = new ChunkManager<TChunk>({
      loader: options.loader,
      platform: this.platform,
      ...(options.retryDelaysMilliseconds
        ? { retryDelaysMilliseconds: options.retryDelaysMilliseconds }
        : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    });
  }

  public get currentCellId(): CellId | null {
    return this.chunks.currentCellId;
  }

  public get predictedCellId(): CellId | null {
    return this.predictedCell;
  }

  public get currentWaypoint(): WaypointState | null {
    return this.waypoint ? cloneJson(this.waypoint) : null;
  }

  public get currentRoute(): RouteState {
    return cloneJson(this.route);
  }

  public chunkSnapshot(): ChunkManagerSnapshot {
    return this.chunks.snapshot();
  }

  public failureState(): NavigationFailureState {
    const snapshot = this.chunks.snapshot();
    return {
      failedBoundaries: cloneJson(snapshot.failedBoundaries),
      roadClosures: cloneJson(snapshot.roadClosures),
      blockedCellId: snapshot.failedBoundaries.find(
        (failure) => failure.cellId === this.predictedCell,
      )?.cellId ?? null,
    };
  }

  public async update(
    position: NavigationPoint,
    velocity: NavigationPoint = { x: 0, z: 0 },
  ): Promise<NavigationUpdateResult> {
    assertPoint(position, 'position');
    assertPoint(velocity, 'velocity');
    const cells = streamingCellSet(position, velocity, this.predictionSeconds);
    this.predictedCell = cells.predictedCellId;
    const previousCellId = this.chunks.currentCellId;
    const transition = await this.chunks.updateForPosition(
      position,
      velocity,
      this.predictionSeconds,
    );
    if (transition.committed) {
      this.position = { ...position };
      this.velocity = { ...velocity };
      if (transition.currentCellId && transition.currentCellId !== previousCellId) {
        this.events.emit('cell:changed', {
          previousCellId,
          currentCellId: transition.currentCellId,
        });
      }
      if (transition.currentCellId && !this.discovered.has(transition.currentCellId)) {
        this.discovered.add(transition.currentCellId);
        this.events.emit('cell:discovered', { cellId: transition.currentCellId });
      }
      this.updateRouteProgress();
    }
    const failures = this.failureState();
    if (failures.failedBoundaries.length > 0) {
      this.events.emit('stream:failed', { failures });
    }
    return {
      transition,
      currentCellId: this.chunks.currentCellId,
      predictedCellId: cells.predictedCellId,
      safePosition: this.position ? { ...this.position } : null,
      route: this.currentRoute,
      failures,
    };
  }

  public setWaypoint(waypoint: Readonly<WaypointState>): NavigationActionResult {
    if (!waypoint.id.trim() || !waypoint.label.trim()) {
      return { success: false, reason: 'waypoint id and label cannot be empty' };
    }
    try {
      assertPoint(waypoint.position, 'waypoint position');
    } catch (error: unknown) {
      return { success: false, reason: errorMessage(error) };
    }
    this.waypoint = cloneJson(waypoint);
    if (!this.position) {
      this.route = emptyRoute('pending', this.route.revision + 1, 'waypoint');
      return { success: true };
    }
    return this.planRoute('waypoint');
  }

  public clearWaypoint(): void {
    this.waypoint = null;
    this.route = emptyRoute('idle', this.route.revision + 1, null);
  }

  public closeRoadEdge(edgeId: string): NavigationActionResult {
    if (!this.graph.edges.some((edge) => edge.id === edgeId)) {
      return { success: false, reason: `unknown road edge "${edgeId}"` };
    }
    this.closedEdges.add(edgeId);
    return this.waypoint && this.position ? this.planRoute('closure') : { success: true };
  }

  public openRoadEdge(edgeId: string): NavigationActionResult {
    this.closedEdges.delete(edgeId);
    return this.waypoint && this.position ? this.planRoute('closure') : { success: true };
  }

  public nextRouteSegments(count = 3): GpsRoute['segments'] {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('segment count must be a non-negative integer');
    }
    return this.route.gpsRoute?.segments.slice(
      this.route.segmentIndex,
      this.route.segmentIndex + count,
    ) ?? [];
  }

  public setMarkers(markers: readonly MapMarker[]): NavigationActionResult {
    const ids = new Set<string>();
    for (const marker of markers) {
      if (!marker.id.trim() || ids.has(marker.id)) {
        return { success: false, reason: 'map marker ids must be non-empty and unique' };
      }
      ids.add(marker.id);
      try {
        assertPoint(marker.position, 'marker position');
        parseCellId(marker.cellId);
      } catch (error: unknown) {
        return { success: false, reason: errorMessage(error) };
      }
    }
    this.markers = cloneJson([...markers]);
    return { success: true };
  }

  public setMarkerFilter(kind: MapMarkerKind, visible: boolean): void {
    this.filters[kind] = visible;
  }

  public visibleMarkers(): readonly MapMarker[] {
    const pinnedMissions = new Set(this.chunks.snapshot().missionPins.map((pin) => pin.missionId));
    return this.markers.filter((marker) => this.filters[marker.kind]
      && (marker.reveal === 'always'
        || this.discovered.has(marker.cellId)
        || (marker.missionId !== undefined && pinnedMissions.has(marker.missionId))))
      .map((marker) => cloneJson(marker));
  }

  public discoveredCellIds(): readonly CellId[] {
    return [...this.discovered].sort((left, right) => left.localeCompare(right));
  }

  public async pinMission(missionId: string, cellIds: readonly CellId[]): Promise<NavigationActionResult> {
    try {
      const result = await this.chunks.pinForMission(missionId, cellIds);
      if (result.failedCellIds.length > 0) {
        return { success: false, reason: `mission cells failed: ${result.failedCellIds.join(', ')}` };
      }
      return { success: true };
    } catch (error: unknown) {
      return { success: false, reason: errorMessage(error) };
    }
  }

  public unpinMission(missionId: string): readonly CellId[] {
    return this.chunks.unpinMission(missionId);
  }

  public async retryFailedCell(cellId: CellId): Promise<NavigationActionResult> {
    try {
      await this.chunks.retryFailed(cellId);
      this.events.emit('stream:recovered', { cellId });
      return { success: true };
    } catch (error: unknown) {
      return { success: false, reason: errorMessage(error) };
    }
  }

  public snapshot(): NavigationRuntimeSnapshotV1 {
    return cloneJson({
      schemaVersion: NAVIGATION_RUNTIME_SNAPSHOT_VERSION,
      platform: this.platform,
      position: this.position,
      velocity: this.velocity,
      predictedCellId: this.predictedCell,
      waypoint: this.waypoint,
      routeStatus: this.route.status,
      routeSegmentIndex: this.route.segmentIndex,
      discoveredCellIds: this.discoveredCellIds(),
      markers: this.markers,
      filters: this.filters,
      closedEdgeIds: [...this.closedEdges].sort(),
      chunkManager: this.chunks.snapshot(),
    });
  }

  public async restore(value: unknown): Promise<NavigationActionResult> {
    const snapshot = validateSnapshot(value, this.graph, this.platform);
    if (!snapshot.success) {
      return snapshot;
    }
    for (const pin of this.chunks.snapshot().missionPins) {
      this.chunks.unpinMission(pin.missionId);
    }
    this.position = snapshot.value.position ? { ...snapshot.value.position } : null;
    this.velocity = { ...snapshot.value.velocity };
    this.predictedCell = snapshot.value.predictedCellId;
    this.waypoint = snapshot.value.waypoint ? cloneJson(snapshot.value.waypoint) : null;
    this.markers = cloneJson([...snapshot.value.markers]);
    this.filters = { ...snapshot.value.filters };
    this.discovered.clear();
    snapshot.value.discoveredCellIds.forEach((cellId) => this.discovered.add(cellId));
    this.closedEdges.clear();
    snapshot.value.closedEdgeIds.forEach((edgeId) => this.closedEdges.add(edgeId));
    for (const pin of snapshot.value.chunkManager.missionPins) {
      await this.chunks.pinForMission(pin.missionId, pin.cellIds);
    }
    if (this.position) {
      await this.chunks.updateForPosition(this.position, this.velocity, this.predictionSeconds);
    }
    this.route = emptyRoute(snapshot.value.routeStatus, this.route.revision + 1, 'restore');
    if (this.waypoint && this.position && snapshot.value.routeStatus !== 'arrived') {
      this.planRoute('restore');
    }
    return { success: true };
  }

  private planRoute(reason: RoutePlanReason): NavigationActionResult {
    if (!this.position || !this.waypoint) {
      this.route = emptyRoute('pending', this.route.revision + 1, reason);
      return { success: true };
    }
    const roadRoute = findRoadRoute(
      this.graph,
      this.position,
      this.waypoint.position,
      this.closedEdges,
    );
    if (!roadRoute) {
      this.route = emptyRoute('unreachable', this.route.revision + 1, reason);
      this.events.emit('route:changed', { route: this.currentRoute, reason });
      return { success: false, reason: 'waypoint is unreachable' };
    }
    const routeDestination = roadRoute.points[roadRoute.points.length - 1];
    if (this.waypoint.source === 'custom' && routeDestination) {
      // A map click can land well away from a driveable road. The road planner
      // already resolves that click to a deterministic goal node, so retain that
      // resolved point as the custom waypoint too. Route drawing, persistence,
      // and arrival checks now agree on the same reachable destination.
      this.waypoint = {
        ...this.waypoint,
        position: { ...routeDestination },
      };
    }
    const roadGpsRoute = createGpsRoute(roadRoute);
    const directDistance = distance(this.position, this.waypoint.position);
    const gpsRoute: GpsRoute = roadGpsRoute.segments.length === 0
      && directDistance > this.arrivalDistanceMeters
      ? {
          points: [{ ...this.position }, { ...this.waypoint.position }],
          segments: [{
            index: 0,
            from: { ...this.position },
            to: { ...this.waypoint.position },
            distanceMeters: directDistance,
            headingRadians: Math.atan2(
              this.waypoint.position.x - this.position.x,
              this.waypoint.position.z - this.position.z,
            ),
          }],
          distanceMeters: directDistance,
        }
      : roadGpsRoute;
    this.route = {
      status: 'active',
      roadRoute,
      gpsRoute,
      segmentIndex: 0,
      remainingDistanceMeters: gpsRoute.distanceMeters,
      revision: this.route.revision + 1,
      lastPlanReason: reason,
    };
    this.events.emit('route:changed', { route: this.currentRoute, reason });
    return { success: true };
  }

  private updateRouteProgress(): void {
    if (!this.position || !this.waypoint) {
      return;
    }
    if (distance(this.position, this.waypoint.position) <= this.arrivalDistanceMeters) {
      this.route = {
        ...this.route,
        status: 'arrived',
        remainingDistanceMeters: 0,
      };
      this.events.emit('waypoint:arrived', { waypoint: cloneJson(this.waypoint) });
      return;
    }
    if (this.route.status === 'pending') {
      this.planRoute('position-ready');
      return;
    }
    if (this.route.status !== 'active' || !this.route.gpsRoute || !this.route.roadRoute) {
      return;
    }
    if (this.route.roadRoute.edgeIds.some((edgeId) => this.closedEdges.has(edgeId))) {
      this.planRoute('closure');
      return;
    }
    const progress = closestRouteProgress(
      this.position,
      this.route.gpsRoute,
      this.route.segmentIndex,
    );
    if (progress.distanceFromRoute > this.routeDeviationMeters) {
      this.planRoute('deviation');
      return;
    }
    this.route = {
      ...this.route,
      segmentIndex: progress.segmentIndex,
      remainingDistanceMeters: progress.remainingDistanceMeters,
    };
    this.events.emit('route:progress', {
      segmentIndex: this.route.segmentIndex,
      remainingDistanceMeters: this.route.remainingDistanceMeters,
    });
  }
}

function closestRouteProgress(
  point: NavigationPoint,
  route: GpsRoute,
  minimumSegmentIndex: number,
): { segmentIndex: number; distanceFromRoute: number; remainingDistanceMeters: number } {
  if (route.segments.length === 0) {
    return { segmentIndex: 0, distanceFromRoute: distance(point, route.points[0] ?? point), remainingDistanceMeters: 0 };
  }
  let bestIndex = Math.min(minimumSegmentIndex, route.segments.length - 1);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = bestIndex; index < route.segments.length; index += 1) {
    const segment = route.segments[index];
    if (!segment) continue;
    const candidate = pointToSegmentDistance(point, segment.from, segment.to);
    if (candidate < bestDistance) {
      bestDistance = candidate;
      bestIndex = index;
    }
  }
  const segment = route.segments[bestIndex];
  let remaining = segment ? distance(point, segment.to) : 0;
  for (let index = bestIndex + 1; index < route.segments.length; index += 1) {
    remaining += route.segments[index]?.distanceMeters ?? 0;
  }
  return { segmentIndex: bestIndex, distanceFromRoute: bestDistance, remainingDistanceMeters: remaining };
}

function pointToSegmentDistance(point: NavigationPoint, from: NavigationPoint, to: NavigationPoint): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = dx * dx + dz * dz;
  if (length === 0) return distance(point, from);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / length));
  return distance(point, { x: from.x + t * dx, z: from.z + t * dz });
}

function distance(left: NavigationPoint, right: NavigationPoint): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function emptyRoute(
  status: RouteState['status'],
  revision = 0,
  reason: RoutePlanReason | null = null,
): RouteState {
  return {
    status,
    roadRoute: null,
    gpsRoute: null,
    segmentIndex: 0,
    remainingDistanceMeters: 0,
    revision,
    lastPlanReason: reason,
  };
}

function defaultFilters(): Record<MapMarkerKind, boolean> {
  return { mission: true, property: true, activity: true, shop: true, safehouse: true, custom: true };
}

function validateSnapshot(
  value: unknown,
  graph: RoadGraph,
  platform: 'desktop' | 'mobile',
): { success: true; value: NavigationRuntimeSnapshotV1 } | { success: false; reason: string } {
  if (!isRecord(value) || value.schemaVersion !== NAVIGATION_RUNTIME_SNAPSHOT_VERSION) {
    return { success: false, reason: 'navigation snapshot version is unsupported' };
  }
  const snapshot = value as unknown as NavigationRuntimeSnapshotV1;
  if (snapshot.platform !== platform || !isPointOrNull(snapshot.position) || !isPoint(snapshot.velocity)) {
    return { success: false, reason: 'navigation snapshot platform or position is invalid' };
  }
  if (!Array.isArray(snapshot.discoveredCellIds)
    || !Array.isArray(snapshot.markers)
    || !Array.isArray(snapshot.closedEdgeIds)
    || !isRecord(snapshot.filters)
    || !isRecord(snapshot.chunkManager)) {
    return { success: false, reason: 'navigation snapshot collections are invalid' };
  }
  try {
    snapshot.discoveredCellIds.forEach(parseCellId);
    snapshot.markers.forEach((marker) => {
      parseCellId(marker.cellId);
      assertPoint(marker.position, 'marker position');
    });
  } catch (error: unknown) {
    return { success: false, reason: errorMessage(error) };
  }
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  if (snapshot.closedEdgeIds.some((id) => !edgeIds.has(id))) {
    return { success: false, reason: 'navigation snapshot contains an unknown road closure' };
  }
  if (!MARKER_KINDS.every((kind) => typeof snapshot.filters[kind] === 'boolean')) {
    return { success: false, reason: 'navigation snapshot marker filters are invalid' };
  }
  return { success: true, value: snapshot };
}

function assertPoint(value: NavigationPoint, label: string): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.z)) {
    throw new TypeError(`${label} must contain finite coordinates`);
  }
}

function isPoint(value: unknown): value is NavigationPoint {
  return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.z === 'number' && Number.isFinite(value.z);
}

function isPointOrNull(value: unknown): value is NavigationPoint | null {
  return value === null || isPoint(value);
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative and finite`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
