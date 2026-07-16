import { CITY_HALF_SIZE, DISTRICTS, generateCity } from '../game/city';
import type { DistrictBounds, RoadRecipe } from '../game/city';
import {
  WORLD_CELL_SIZE_METERS,
  boundsForCell,
  cellIdFromCoordinates,
} from '../navigation/cells';
import type {
  CellId,
  GpsRouteSegment,
  NavigationPoint,
} from '../navigation/types';

export interface MapBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface MapViewport {
  readonly width: number;
  readonly height: number;
}

export interface MapScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapScreenRect extends MapScreenPoint {
  readonly width: number;
  readonly height: number;
}

export interface MapProjection {
  readonly bounds: MapBounds;
  readonly viewport: MapViewport;
  readonly padding: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

export interface MapDistrictInput extends MapBounds {
  readonly id: string;
  readonly label: string;
  readonly groundColor: number;
}

export interface MapRoadInput {
  readonly id: string;
  readonly position: NavigationPoint;
  readonly width: number;
  readonly depth: number;
  readonly major: boolean;
}

export type MapMarkerKind =
  | 'mission'
  | 'property'
  | 'activity'
  | 'shop'
  | 'safehouse'
  | 'custom';

export interface MapMarkerInput {
  readonly id: string;
  readonly kind: MapMarkerKind;
  readonly label: string;
  readonly position: NavigationPoint;
  readonly cellId: CellId;
  readonly reveal: 'discovered' | 'always';
  readonly missionId?: string;
}

export type MapMarkerFilters = Readonly<Partial<Record<MapMarkerKind, boolean>>>;

export interface MapWaypointInput {
  readonly label: string;
  readonly position: NavigationPoint;
}

export interface MapPlayerInput {
  readonly position: NavigationPoint;
  /** Game-world radians: 0 faces north (-Z), positive values turn west. */
  readonly heading: number;
}

export interface MapRenderState {
  readonly player: MapPlayerInput;
  readonly discoveredCellIds?: readonly CellId[];
  readonly markers?: readonly MapMarkerInput[];
  readonly markerFilters?: MapMarkerFilters;
  readonly pinnedMissionIds?: readonly string[];
  readonly waypoint?: MapWaypointInput | null;
  readonly routeSegments?: readonly GpsRouteSegment[];
  readonly routeSegmentIndex?: number;
}

export interface MapRendererOptions {
  /** Defaults to the authored 1,200m Solara city bounds. */
  readonly bounds?: MapBounds;
  /** Defaults to all four authored Solara districts. */
  readonly districts?: readonly MapDistrictInput[];
  /** Defaults to the canonical authored Solara road layout. */
  readonly roads?: readonly MapRoadInput[];
  readonly padding?: number;
  readonly maxRouteSegments?: number;
  readonly fallbackViewport?: MapViewport;
}

export interface MapFogCell {
  readonly cellId: CellId;
  readonly bounds: MapBounds;
  readonly discovered: boolean;
}

export interface SelectedMapRouteSegment {
  readonly index: number;
  readonly from: NavigationPoint;
  readonly to: NavigationPoint;
  readonly distanceMeters: number;
  readonly headingRadians: number;
}

export interface ProjectedMapDistrict {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly rect: MapScreenRect;
  readonly labelPosition: MapScreenPoint;
}

export interface ProjectedMapRoad {
  readonly id: string;
  readonly major: boolean;
  readonly rect: MapScreenRect;
}

export interface ProjectedMapFogCell {
  readonly cellId: CellId;
  readonly discovered: boolean;
  readonly rect: MapScreenRect;
}

export interface ProjectedMapMarker extends MapMarkerInput {
  readonly screenPosition: MapScreenPoint;
}

export interface ProjectedMapRouteSegment extends SelectedMapRouteSegment {
  readonly screenFrom: MapScreenPoint;
  readonly screenTo: MapScreenPoint;
}

export interface ProjectedMapWaypoint extends MapWaypointInput {
  readonly screenPosition: MapScreenPoint;
}

export interface ProjectedMapPlayer extends MapPlayerInput {
  readonly screenPosition: MapScreenPoint;
  readonly rotationDegrees: number;
  readonly headingLabel: string;
}

export interface MapAccessibilitySummary {
  readonly text: string;
  readonly playerDistrict: string;
  readonly playerHeading: string;
  readonly discoveredCellCount: number;
  readonly totalCellCount: number;
  readonly visibleMarkerLabels: readonly string[];
  readonly waypointLabel: string | null;
  readonly routeSegmentCount: number;
  readonly routeDistanceMeters: number;
}

export interface MapRenderModel {
  readonly projection: MapProjection;
  readonly districts: readonly ProjectedMapDistrict[];
  readonly roads: readonly ProjectedMapRoad[];
  readonly fogCells: readonly ProjectedMapFogCell[];
  readonly markers: readonly ProjectedMapMarker[];
  readonly routeSegments: readonly ProjectedMapRouteSegment[];
  readonly waypoint: ProjectedMapWaypoint | null;
  readonly player: ProjectedMapPlayer | null;
  readonly summary: MapAccessibilitySummary;
}

export const DEFAULT_MAP_BOUNDS: MapBounds = Object.freeze({
  minX: -CITY_HALF_SIZE,
  maxX: CITY_HALF_SIZE,
  minZ: -CITY_HALF_SIZE,
  maxZ: CITY_HALF_SIZE,
});

const DEFAULT_VIEWPORT: MapViewport = Object.freeze({ width: 960, height: 720 });
const DEFAULT_PADDING = 24;
const DEFAULT_ROUTE_SEGMENTS = 3;
const MARKER_COLORS: Readonly<Record<MapMarkerKind, string>> = Object.freeze({
  mission: '#ffbf3f',
  property: '#7bd88f',
  activity: '#ff6b8a',
  shop: '#61d5ff',
  safehouse: '#f5f7ff',
  custom: '#c59cff',
});

let canonicalRoads: readonly MapRoadInput[] | undefined;

export function createMapProjection(
  bounds: MapBounds,
  viewport: MapViewport,
  requestedPadding = DEFAULT_PADDING,
): MapProjection {
  assertBounds(bounds);
  assertViewport(viewport);
  if (!Number.isFinite(requestedPadding) || requestedPadding < 0) {
    throw new RangeError('map padding must be a finite non-negative number');
  }
  const maximumPadding = Math.max(0, Math.min(viewport.width, viewport.height) / 2 - 0.5);
  const padding = Math.min(requestedPadding, maximumPadding);
  const worldWidth = bounds.maxX - bounds.minX;
  const worldHeight = bounds.maxZ - bounds.minZ;
  const scale = Math.min(
    Math.max(1, viewport.width - padding * 2) / worldWidth,
    Math.max(1, viewport.height - padding * 2) / worldHeight,
  );
  const contentWidth = worldWidth * scale;
  const contentHeight = worldHeight * scale;
  return {
    bounds: { ...bounds },
    viewport: { ...viewport },
    padding,
    scale,
    offsetX: (viewport.width - contentWidth) / 2,
    offsetY: (viewport.height - contentHeight) / 2,
    contentWidth,
    contentHeight,
  };
}

export function projectMapPoint(
  point: NavigationPoint,
  projection: MapProjection,
): MapScreenPoint {
  return {
    x: projection.offsetX + (point.x - projection.bounds.minX) * projection.scale,
    y: projection.offsetY + (point.z - projection.bounds.minZ) * projection.scale,
  };
}

export function clipSegmentToBounds(
  segment: Readonly<{ from: NavigationPoint; to: NavigationPoint }>,
  bounds: MapBounds,
): { readonly from: NavigationPoint; readonly to: NavigationPoint } | null {
  assertBounds(bounds);
  const dx = segment.to.x - segment.from.x;
  const dz = segment.to.z - segment.from.z;
  const p = [-dx, dx, -dz, dz];
  const q = [
    segment.from.x - bounds.minX,
    bounds.maxX - segment.from.x,
    segment.from.z - bounds.minZ,
    bounds.maxZ - segment.from.z,
  ];
  let start = 0;
  let end = 1;

  for (let index = 0; index < p.length; index += 1) {
    const direction = p[index];
    const distanceToEdge = q[index];
    if (direction === undefined || distanceToEdge === undefined) continue;
    if (Math.abs(direction) <= Number.EPSILON) {
      if (distanceToEdge < 0) return null;
      continue;
    }
    const ratio = distanceToEdge / direction;
    if (direction < 0) {
      start = Math.max(start, ratio);
    } else {
      end = Math.min(end, ratio);
    }
    if (start > end) return null;
  }

  return {
    from: {
      x: segment.from.x + start * dx,
      z: segment.from.z + start * dz,
    },
    to: {
      x: segment.from.x + end * dx,
      z: segment.from.z + end * dz,
    },
  };
}

export function buildMapFogCells(
  bounds: MapBounds,
  discoveredCellIds: readonly CellId[],
): readonly MapFogCell[] {
  assertBounds(bounds);
  const discovered = new Set(discoveredCellIds);
  const minimumX = Math.floor(bounds.minX / WORLD_CELL_SIZE_METERS);
  const maximumX = Math.ceil(bounds.maxX / WORLD_CELL_SIZE_METERS) - 1;
  const minimumZ = Math.floor(bounds.minZ / WORLD_CELL_SIZE_METERS);
  const maximumZ = Math.ceil(bounds.maxZ / WORLD_CELL_SIZE_METERS) - 1;
  const cells: MapFogCell[] = [];

  for (let z = minimumZ; z <= maximumZ; z += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const cellId = cellIdFromCoordinates({ x, z });
      const clippedBounds = intersectBounds(boundsForCell(cellId), bounds);
      if (clippedBounds) {
        cells.push({
          cellId,
          bounds: clippedBounds,
          discovered: discovered.has(cellId),
        });
      }
    }
  }
  return cells;
}

export function selectMapMarkers(
  markers: readonly MapMarkerInput[],
  filters: MapMarkerFilters,
  discoveredCellIds: readonly CellId[],
  pinnedMissionIds: readonly string[],
  bounds: MapBounds,
): readonly MapMarkerInput[] {
  const discovered = new Set(discoveredCellIds);
  const pinnedMissions = new Set(pinnedMissionIds);
  return markers
    .filter((marker) => (filters[marker.kind] ?? true)
      && pointWithinBounds(marker.position, bounds)
      && (marker.reveal === 'always'
        || discovered.has(marker.cellId)
        || (marker.missionId !== undefined && pinnedMissions.has(marker.missionId))))
    .map((marker) => ({ ...marker, position: { ...marker.position } }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function selectMapRouteSegments(
  segments: readonly GpsRouteSegment[],
  currentSegmentIndex: number,
  maximumSegments: number,
  bounds: MapBounds,
): readonly SelectedMapRouteSegment[] {
  if (!Number.isSafeInteger(currentSegmentIndex) || currentSegmentIndex < 0) {
    throw new RangeError('current route segment index must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maximumSegments) || maximumSegments < 0) {
    throw new RangeError('maximum route segments must be a non-negative integer');
  }
  const selected: SelectedMapRouteSegment[] = [];
  const candidates = [...segments]
    .filter((segment) => segment.index >= currentSegmentIndex)
    .sort((left, right) => left.index - right.index);
  for (const segment of candidates) {
    if (selected.length >= maximumSegments) break;
    const clipped = clipSegmentToBounds(segment, bounds);
    if (!clipped) continue;
    selected.push({
      index: segment.index,
      from: clipped.from,
      to: clipped.to,
      distanceMeters: segment.distanceMeters,
      headingRadians: segment.headingRadians,
    });
  }
  return selected;
}

export function createMapRenderModel(
  state: MapRenderState,
  viewport: MapViewport,
  options: MapRendererOptions = {},
): MapRenderModel {
  assertPoint(state.player.position, 'player position');
  if (!Number.isFinite(state.player.heading)) {
    throw new TypeError('player heading must be finite');
  }
  const bounds = options.bounds ? { ...options.bounds } : { ...DEFAULT_MAP_BOUNDS };
  const districts = (options.districts ?? DISTRICTS)
    .map(copyDistrict)
    .sort((left, right) => left.id.localeCompare(right.id));
  const roads = (options.roads ?? defaultRoads())
    .map(copyRoad)
    .sort((left, right) => left.id.localeCompare(right.id));
  const maximumRouteSegments = options.maxRouteSegments ?? DEFAULT_ROUTE_SEGMENTS;
  if (!Number.isSafeInteger(maximumRouteSegments) || maximumRouteSegments < 0) {
    throw new RangeError('maxRouteSegments must be a non-negative integer');
  }
  const projection = createMapProjection(bounds, viewport, options.padding ?? DEFAULT_PADDING);
  const discoveredCellIds = state.discoveredCellIds ?? [];
  const fogCells = buildMapFogCells(bounds, discoveredCellIds);
  const selectedMarkers = selectMapMarkers(
    state.markers ?? [],
    state.markerFilters ?? {},
    discoveredCellIds,
    state.pinnedMissionIds ?? [],
    bounds,
  );
  const selectedRouteSegments = selectMapRouteSegments(
    state.routeSegments ?? [],
    state.routeSegmentIndex ?? 0,
    maximumRouteSegments,
    bounds,
  );
  const projectedDistricts = districts.flatMap((district) => {
    const visible = intersectBounds(district, bounds);
    if (!visible) return [];
    return [{
      id: district.id,
      label: district.label,
      color: colorToHex(district.groundColor),
      rect: projectMapBounds(visible, projection),
      labelPosition: projectMapPoint({
        x: (visible.minX + visible.maxX) / 2,
        z: (visible.minZ + visible.maxZ) / 2,
      }, projection),
    }];
  });
  const projectedRoads = roads.flatMap((road) => {
    const visible = intersectBounds(roadBounds(road), bounds);
    return visible ? [{
      id: road.id,
      major: road.major,
      rect: projectMapBounds(visible, projection),
    }] : [];
  });
  const projectedFog = fogCells.map((cell) => ({
    cellId: cell.cellId,
    discovered: cell.discovered,
    rect: projectMapBounds(cell.bounds, projection),
  }));
  const projectedMarkers = selectedMarkers.map((marker) => ({
    ...marker,
    screenPosition: projectMapPoint(marker.position, projection),
  }));
  const projectedRoute = selectedRouteSegments.map((segment) => ({
    ...segment,
    screenFrom: projectMapPoint(segment.from, projection),
    screenTo: projectMapPoint(segment.to, projection),
  }));
  const waypoint = state.waypoint && pointWithinBounds(state.waypoint.position, bounds)
    ? {
      ...state.waypoint,
      position: { ...state.waypoint.position },
      screenPosition: projectMapPoint(state.waypoint.position, projection),
    }
    : null;
  const player = pointWithinBounds(state.player.position, bounds)
    ? {
      position: { ...state.player.position },
      heading: state.player.heading,
      screenPosition: projectMapPoint(state.player.position, projection),
      rotationDegrees: mapHeadingDegrees(state.player.heading),
      headingLabel: mapHeadingLabel(state.player.heading),
    }
    : null;
  const summary = createAccessibilitySummary(
    state.player,
    districts,
    fogCells,
    projectedMarkers,
    waypoint,
    projectedRoute,
  );

  return {
    projection,
    districts: projectedDistricts,
    roads: projectedRoads,
    fogCells: projectedFog,
    markers: projectedMarkers,
    routeSegments: projectedRoute,
    waypoint,
    player,
    summary,
  };
}

export function renderMapSvg(model: MapRenderModel): string {
  const { width, height } = model.projection.viewport;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(model.summary.text)}" viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block;max-width:100%;background:#07121b">`,
    '<title>Solara city map</title>',
    `<desc>${escapeXml(model.summary.text)}</desc>`,
    '<g aria-hidden="true">',
    '<rect width="100%" height="100%" fill="#07121b"/>',
  ];

  for (const district of model.districts) {
    parts.push(rectMarkup(district.rect, {
      'data-district-id': district.id,
      fill: district.color,
      opacity: '0.72',
    }));
  }
  for (const road of model.roads) {
    parts.push(rectMarkup(road.rect, {
      'data-road-id': road.id,
      fill: road.major ? '#445665' : '#34444f',
      opacity: road.major ? '0.96' : '0.82',
    }));
  }
  for (const district of model.districts) {
    parts.push(`<text x="${formatNumber(district.labelPosition.x)}" y="${formatNumber(district.labelPosition.y)}" fill="#eaf4f6" fill-opacity="0.58" font-family="system-ui,sans-serif" font-size="12" font-weight="700" letter-spacing="1.5" text-anchor="middle">${escapeXml(district.label.toUpperCase())}</text>`);
  }
  for (const cell of model.fogCells) {
    if (cell.discovered) continue;
    parts.push(rectMarkup(cell.rect, {
      'data-fog-cell-id': cell.cellId,
      fill: '#061018',
      opacity: '0.82',
      stroke: '#132631',
      'stroke-width': '0.6',
    }));
  }
  for (const segment of model.routeSegments) {
    const line = lineAttributes(segment.screenFrom, segment.screenTo);
    parts.push(`<line ${line} stroke="#07121b" stroke-width="9" stroke-linecap="round"/>`);
    parts.push(`<line data-route-segment="${segment.index}" ${line} stroke="#55d8ff" stroke-width="4" stroke-linecap="round"/>`);
  }
  if (model.waypoint) {
    const { x, y } = model.waypoint.screenPosition;
    parts.push(`<g data-waypoint="true" transform="translate(${formatNumber(x)} ${formatNumber(y)})"><circle r="10" fill="none" stroke="#ffbf3f" stroke-width="3"/><circle r="3" fill="#ffbf3f"/><line x1="-14" y1="0" x2="-7" y2="0" stroke="#ffbf3f" stroke-width="2"/><line x1="7" y1="0" x2="14" y2="0" stroke="#ffbf3f" stroke-width="2"/><title>${escapeXml(model.waypoint.label)}</title></g>`);
  }
  for (const marker of model.markers) {
    const { x, y } = marker.screenPosition;
    parts.push(`<g data-marker-id="${escapeXml(marker.id)}" data-marker-kind="${marker.kind}" transform="translate(${formatNumber(x)} ${formatNumber(y)})"><circle r="7" fill="${MARKER_COLORS[marker.kind]}" stroke="#07121b" stroke-width="3"/><circle r="2" fill="#07121b"/><title>${escapeXml(marker.label)}</title></g>`);
  }
  if (model.player) {
    const { x, y } = model.player.screenPosition;
    parts.push(`<g data-player="true" data-heading="${escapeXml(model.player.headingLabel)}" transform="translate(${formatNumber(x)} ${formatNumber(y)}) rotate(${formatNumber(model.player.rotationDegrees)})"><path d="M 0 -13 L 9 10 L 0 6 L -9 10 Z" fill="#ffffff" stroke="#07121b" stroke-width="3"/><circle r="2.5" fill="#ff5e73"/></g>`);
  }
  parts.push(rectMarkup({
    x: model.projection.offsetX,
    y: model.projection.offsetY,
    width: model.projection.contentWidth,
    height: model.projection.contentHeight,
  }, {
    fill: 'none',
    stroke: '#9bb7c4',
    'stroke-width': '1.5',
    opacity: '0.72',
  }));
  parts.push('</g>', '</svg>');
  return parts.join('');
}

export class MapRenderer {
  readonly #target: HTMLElement;
  readonly #options: MapRendererOptions;

  public constructor(target: HTMLElement, options: MapRendererOptions = {}) {
    this.#target = target;
    this.#options = { ...options };
  }

  /** Measures the host on every draw so fullscreen and panel layouts stay responsive. */
  public draw(state: MapRenderState, viewport?: MapViewport): MapRenderModel {
    const measured = viewport ?? measuredViewport(this.#target, this.#options.fallbackViewport);
    const model = createMapRenderModel(state, measured, this.#options);
    this.#target.innerHTML = renderMapSvg(model);
    return model;
  }

  public clear(): void {
    this.#target.innerHTML = '';
  }
}

function defaultRoads(): readonly MapRoadInput[] {
  canonicalRoads ??= generateCity('heatline-solara-v1', 'low').roads.map(copyRoad);
  return canonicalRoads;
}

function copyDistrict(district: MapDistrictInput | DistrictBounds): MapDistrictInput {
  return {
    id: district.id,
    label: district.label,
    minX: district.minX,
    maxX: district.maxX,
    minZ: district.minZ,
    maxZ: district.maxZ,
    groundColor: district.groundColor,
  };
}

function copyRoad(road: MapRoadInput | RoadRecipe): MapRoadInput {
  return {
    id: road.id,
    position: { x: road.position.x, z: road.position.z },
    width: road.width,
    depth: road.depth,
    major: road.major,
  };
}

function measuredViewport(target: HTMLElement, fallback = DEFAULT_VIEWPORT): MapViewport {
  const rect = target.getBoundingClientRect();
  return {
    width: Number.isFinite(rect.width) && rect.width > 0 ? rect.width : fallback.width,
    height: Number.isFinite(rect.height) && rect.height > 0 ? rect.height : fallback.height,
  };
}

function projectMapBounds(bounds: MapBounds, projection: MapProjection): MapScreenRect {
  const topLeft = projectMapPoint({ x: bounds.minX, z: bounds.minZ }, projection);
  return {
    ...topLeft,
    width: (bounds.maxX - bounds.minX) * projection.scale,
    height: (bounds.maxZ - bounds.minZ) * projection.scale,
  };
}

function roadBounds(road: MapRoadInput): MapBounds {
  return {
    minX: road.position.x - road.width / 2,
    maxX: road.position.x + road.width / 2,
    minZ: road.position.z - road.depth / 2,
    maxZ: road.position.z + road.depth / 2,
  };
}

function intersectBounds(left: MapBounds, right: MapBounds): MapBounds | null {
  const intersection = {
    minX: Math.max(left.minX, right.minX),
    maxX: Math.min(left.maxX, right.maxX),
    minZ: Math.max(left.minZ, right.minZ),
    maxZ: Math.min(left.maxZ, right.maxZ),
  };
  return intersection.minX < intersection.maxX && intersection.minZ < intersection.maxZ
    ? intersection
    : null;
}

function pointWithinBounds(point: NavigationPoint, bounds: MapBounds): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.z)
    && point.x >= bounds.minX && point.x <= bounds.maxX
    && point.z >= bounds.minZ && point.z <= bounds.maxZ;
}

function mapHeadingDegrees(headingRadians: number): number {
  return normalizeDegrees(-headingRadians * 180 / Math.PI);
}

function mapHeadingLabel(headingRadians: number): string {
  const labels = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
  const index = Math.round(mapHeadingDegrees(headingRadians) / 45) % labels.length;
  return labels[index] ?? 'north';
}

function normalizeDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function createAccessibilitySummary(
  player: MapPlayerInput,
  districts: readonly MapDistrictInput[],
  fogCells: readonly MapFogCell[],
  markers: readonly ProjectedMapMarker[],
  waypoint: ProjectedMapWaypoint | null,
  routeSegments: readonly ProjectedMapRouteSegment[],
): MapAccessibilitySummary {
  const playerDistrict = districts.find((district) => pointWithinBounds(player.position, district))?.label
    ?? 'outside Solara';
  const playerHeading = mapHeadingLabel(player.heading);
  const discoveredCellCount = fogCells.filter((cell) => cell.discovered).length;
  const visibleMarkerLabels = markers.map((marker) => marker.label);
  const routeDistanceMeters = routeSegments.reduce(
    (total, segment) => total + segment.distanceMeters,
    0,
  );
  const markerText = visibleMarkerLabels.length === 0
    ? 'No visible markers.'
    : `${visibleMarkerLabels.length} visible ${plural(visibleMarkerLabels.length, 'marker')}: ${visibleMarkerLabels.join(', ')}.`;
  const waypointText = waypoint ? `Waypoint: ${waypoint.label}.` : 'No waypoint set.';
  const routeText = routeSegments.length === 0
    ? 'No GPS route displayed.'
    : `Showing ${routeSegments.length} next GPS ${plural(routeSegments.length, 'segment')}, ${Math.round(routeDistanceMeters)} meters.`;
  return {
    text: `Player in ${playerDistrict}, heading ${playerHeading}. ${discoveredCellCount} of ${fogCells.length} map cells discovered. ${markerText} ${waypointText} ${routeText}`,
    playerDistrict,
    playerHeading,
    discoveredCellCount,
    totalCellCount: fogCells.length,
    visibleMarkerLabels,
    waypointLabel: waypoint?.label ?? null,
    routeSegmentCount: routeSegments.length,
    routeDistanceMeters,
  };
}

function rectMarkup(rect: MapScreenRect, attributes: Readonly<Record<string, string>>): string {
  const serialized = Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(' ');
  return `<rect x="${formatNumber(rect.x)}" y="${formatNumber(rect.y)}" width="${formatNumber(rect.width)}" height="${formatNumber(rect.height)}" ${serialized}/>`;
}

function lineAttributes(from: MapScreenPoint, to: MapScreenPoint): string {
  return `x1="${formatNumber(from.x)}" y1="${formatNumber(from.y)}" x2="${formatNumber(to.x)}" y2="${formatNumber(to.y)}"`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function colorToHex(value: number): string {
  const color = Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  return `#${color.toString(16).padStart(6, '0')}`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function assertBounds(bounds: MapBounds): void {
  if (![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite)
    || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
    throw new RangeError('map bounds must be finite and have positive area');
  }
}

function assertViewport(viewport: MapViewport): void {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || viewport.width <= 0 || viewport.height <= 0) {
    throw new RangeError('map viewport must have finite positive dimensions');
  }
}

function assertPoint(point: NavigationPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) {
    throw new TypeError(`${label} must contain finite coordinates`);
  }
}
