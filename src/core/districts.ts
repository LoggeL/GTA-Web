/**
 * Dependency-neutral authored coordinate contract for Solara.
 *
 * Data generation and application runtime targeting both depend on this file;
 * it must not import from the game or data layers. Road placements mirror the
 * immutable city grid: six roads per axis at 100 m intervals in each district.
 */
export const SOLARA_DISTRICTS = Object.freeze({
  'neon-strand': Object.freeze({
    id: 'neon-strand',
    minX: -600,
    maxX: 0,
    minZ: -600,
    maxZ: 0,
    gameplayAnchor: Object.freeze({ x: -230, z: -70 }),
  }),
  'alta-vista': Object.freeze({
    id: 'alta-vista',
    minX: 0,
    maxX: 600,
    minZ: -600,
    maxZ: 0,
    gameplayAnchor: Object.freeze({ x: 105, z: -80 }),
  }),
  'arroyo-heights': Object.freeze({
    id: 'arroyo-heights',
    minX: -600,
    maxX: 0,
    minZ: 0,
    maxZ: 600,
    gameplayAnchor: Object.freeze({ x: -190, z: 285 }),
  }),
  breakwater: Object.freeze({
    id: 'breakwater',
    minX: 0,
    maxX: 600,
    minZ: 0,
    maxZ: 600,
    gameplayAnchor: Object.freeze({ x: 105, z: 235 }),
  }),
} as const);

export type SolaraDistrictId = keyof typeof SOLARA_DISTRICTS;

export interface SolaraPlanarPosition {
  readonly x: number;
  readonly z: number;
}

export type SolaraPlacementIntent = 'road' | 'sidewalk';

export const SOLARA_DISTRICT_IDS = Object.freeze(
  Object.keys(SOLARA_DISTRICTS) as SolaraDistrictId[],
);

export const SOLARA_GAMEPLAY_ANCHORS: Readonly<
  Record<SolaraDistrictId, Readonly<SolaraPlanarPosition>>
> = Object.freeze(Object.fromEntries(
  SOLARA_DISTRICT_IDS.map((id) => [id, SOLARA_DISTRICTS[id].gameplayAnchor]),
) as Record<SolaraDistrictId, Readonly<SolaraPlanarPosition>>);

const ROAD_COUNT = 6;
const ROAD_START = 50;
const ROAD_SPACING = 100;
const STANDARD_ROAD_WIDTH = 18;
const MAJOR_ROAD_WIDTH = 26;
const ROAD_LANE_OFFSET = 2.6;
const SIDEWALK_CURB_OFFSET = 2.35;
const JUNCTION_STABILIZATION_DISTANCE = 32;
const DISTRICT_INTERIOR_MARGIN = 24;
const COORDINATE_PRECISION = 10;

interface RoadCoordinate {
  readonly coordinate: number;
  readonly distance: number;
  readonly index: number;
  readonly width: number;
}

function assertFiniteCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

function roundCoordinate(value: number): number {
  const rounded = Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableSalt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value) >>> 0;
}

function roadWidth(index: number): number {
  return index === 2 || index === 3 ? MAJOR_ROAD_WIDTH : STANDARD_ROAD_WIDTH;
}

function nearestRoadCoordinate(
  value: number,
  minimum: number,
): RoadCoordinate {
  let nearest: RoadCoordinate | null = null;
  for (let index = 0; index < ROAD_COUNT; index += 1) {
    const coordinate = minimum + ROAD_START + index * ROAD_SPACING;
    const distance = Math.abs(value - coordinate);
    if (
      nearest === null
      || distance < nearest.distance
      || (distance === nearest.distance && index < nearest.index)
    ) {
      nearest = { coordinate, distance, index, width: roadWidth(index) };
    }
  }
  if (nearest === null) throw new Error('Solara road table is empty');
  return nearest;
}

function preferredSide(
  value: number,
  road: Readonly<RoadCoordinate>,
  salt: number,
): -1 | 1 {
  if (value < road.coordinate) return -1;
  if (value > road.coordinate) return 1;
  return (salt & 1) === 0 ? -1 : 1;
}

/** Returns the canonical quadrant for any finite or out-of-bounds world point. */
export function solaraDistrictAt(x: number, z: number): SolaraDistrictId {
  assertFiniteCoordinate(x, 'x');
  assertFiniteCoordinate(z, 'z');
  if (z < 0) return x < 0 ? 'neon-strand' : 'alta-vista';
  return x < 0 ? 'arroyo-heights' : 'breakwater';
}

/**
 * Corrects the legacy rotated-sign convention while retaining authored local
 * magnitudes. The result is kept away from quadrant seams and city edges.
 */
export function normalizeSolaraDistrictPosition(
  district: SolaraDistrictId,
  preferred: Readonly<SolaraPlanarPosition>,
): SolaraPlanarPosition {
  assertFiniteCoordinate(preferred.x, 'preferred.x');
  assertFiniteCoordinate(preferred.z, 'preferred.z');
  const definition = SOLARA_DISTRICTS[district];
  const xMagnitude = clamp(
    Math.abs(preferred.x),
    DISTRICT_INTERIOR_MARGIN,
    600 - DISTRICT_INTERIOR_MARGIN,
  );
  const zMagnitude = clamp(
    Math.abs(preferred.z),
    DISTRICT_INTERIOR_MARGIN,
    600 - DISTRICT_INTERIOR_MARGIN,
  );
  return {
    x: definition.maxX <= 0 ? -xMagnitude : xMagnitude,
    z: definition.maxZ <= 0 ? -zMagnitude : zMagnitude,
  };
}

/**
 * Resolves a preferred point onto a deterministic same-district traffic lane.
 * Buildings are authored outside the full road envelope and street props are
 * authored beyond the curb, so this remains player-clear for every city seed.
 */
export function resolveSolaraRoadPosition(
  district: SolaraDistrictId,
  preferred: Readonly<SolaraPlanarPosition>,
  salt = 0,
): SolaraPlanarPosition {
  const normalized = normalizeSolaraDistrictPosition(district, preferred);
  const definition = SOLARA_DISTRICTS[district];
  const xRoad = nearestRoadCoordinate(normalized.x, definition.minX);
  const zRoad = nearestRoadCoordinate(normalized.z, definition.minZ);
  const normalizedSalt = stableSalt(salt);
  const vertical = xRoad.distance < zRoad.distance
    || (xRoad.distance === zRoad.distance && (normalizedSalt & 2) === 0);

  if (vertical) {
    const side = (normalizedSalt & 1) === 0 ? -1 : 1;
    const junctionSide = (normalizedSalt & 4) === 0 ? -1 : 1;
    return {
      x: roundCoordinate(xRoad.coordinate + side * ROAD_LANE_OFFSET),
      z: roundCoordinate(
        zRoad.distance <= JUNCTION_STABILIZATION_DISTANCE
          ? zRoad.coordinate + junctionSide * ROAD_LANE_OFFSET
          : normalized.z,
      ),
    };
  }
  const side = (normalizedSalt & 1) === 0 ? -1 : 1;
  const junctionSide = (normalizedSalt & 4) === 0 ? -1 : 1;
  return {
    x: roundCoordinate(
      xRoad.distance <= JUNCTION_STABILIZATION_DISTANCE
        ? xRoad.coordinate + junctionSide * ROAD_LANE_OFFSET
        : normalized.x,
    ),
    z: roundCoordinate(zRoad.coordinate + side * ROAD_LANE_OFFSET),
  };
}

/**
 * Resolves a point into the unobstructed pedestrian band between curb and
 * street furniture. The 2.35 m offset stays inside the city building setback
 * and inside the prop-free pedestrian envelope.
 */
export function resolveSolaraSidewalkPosition(
  district: SolaraDistrictId,
  preferred: Readonly<SolaraPlanarPosition>,
  salt = 0,
): SolaraPlanarPosition {
  const normalized = normalizeSolaraDistrictPosition(district, preferred);
  const definition = SOLARA_DISTRICTS[district];
  const xRoad = nearestRoadCoordinate(normalized.x, definition.minX);
  const zRoad = nearestRoadCoordinate(normalized.z, definition.minZ);
  const normalizedSalt = stableSalt(salt);
  const vertical = xRoad.distance < zRoad.distance
    || (xRoad.distance === zRoad.distance && (normalizedSalt & 2) === 0);

  if (vertical) {
    const side = preferredSide(normalized.x, xRoad, normalizedSalt);
    return {
      x: roundCoordinate(
        xRoad.coordinate + side * (xRoad.width / 2 + SIDEWALK_CURB_OFFSET),
      ),
      z: roundCoordinate(normalized.z),
    };
  }
  const side = preferredSide(normalized.z, zRoad, normalizedSalt);
  return {
    x: roundCoordinate(normalized.x),
    z: roundCoordinate(
      zRoad.coordinate + side * (zRoad.width / 2 + SIDEWALK_CURB_OFFSET),
    ),
  };
}

export function resolveSolaraPosition(
  district: SolaraDistrictId,
  preferred: Readonly<SolaraPlanarPosition>,
  intent: SolaraPlacementIntent,
  salt = 0,
): SolaraPlanarPosition {
  return intent === 'road'
    ? resolveSolaraRoadPosition(district, preferred, salt)
    : resolveSolaraSidewalkPosition(district, preferred, salt);
}

/** Stable FNV-1a hash used only to spread authored coordinate candidates. */
export function solaraCoordinateSalt(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export interface SolaraMissionTargetRequest {
  readonly district: SolaraDistrictId;
  readonly missionId: string;
  readonly objectiveId: string;
  readonly objectiveIndex: number;
  readonly targetIndex: number;
  readonly base: Readonly<SolaraPlanarPosition>;
}

/** Pure counterpart of the runtime mission target calculation. */
export function resolveSolaraMissionTarget(
  request: Readonly<SolaraMissionTargetRequest>,
): SolaraPlanarPosition {
  const hash = solaraCoordinateSalt(`${request.missionId}:${request.objectiveId}`);
  const angle = ((hash % 360) + request.targetIndex * 83) * Math.PI / 180;
  const radius = request.missionId === 'past-due'
    && request.objectiveIndex === 0
    && request.targetIndex === 0
    ? 28
    : request.targetIndex === 0
      ? 6
      : 18 + (request.targetIndex % 3) * 7;
  const preferred = {
    x: request.base.x + Math.cos(angle) * radius,
    z: request.base.z + Math.sin(angle) * radius,
  };
  return resolveSolaraRoadPosition(
    request.district,
    preferred,
    hash ^ Math.imul(request.targetIndex + 1, 0x9e3779b1),
  );
}

export function resolveSolaraActivityTarget(
  district: SolaraDistrictId,
  seed: number,
  step: number,
): SolaraPlanarPosition {
  const base = SOLARA_GAMEPLAY_ANCHORS[district];
  const normalizedSeed = stableSalt(seed);
  const normalizedStep = Math.max(0, Math.trunc(step));
  const angle = ((normalizedSeed % 360) + normalizedStep * 97) * Math.PI / 180;
  const radius = 34 + ((normalizedSeed >>> (normalizedStep % 12)) & 31);
  return resolveSolaraRoadPosition(
    district,
    {
      x: base.x + Math.cos(angle) * radius,
      z: base.z + Math.sin(angle) * radius,
    },
    normalizedSeed ^ Math.imul(normalizedStep + 1, 0x85ebca6b),
  );
}

export function resolveSolaraActivityMarker(
  district: SolaraDistrictId,
  activityIndex: number,
): SolaraPlanarPosition {
  const base = SOLARA_GAMEPLAY_ANCHORS[district];
  const index = Math.max(0, Math.trunc(activityIndex));
  return resolveSolaraRoadPosition(
    district,
    { x: base.x + index * 9 - 18, z: base.z + index * 7 - 14 },
    solaraCoordinateSalt(`activity-marker:${district}:${index}`),
  );
}
