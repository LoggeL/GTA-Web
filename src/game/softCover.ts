export type CoverShoulder = 'left' | 'right';
export type CoverHeight = 'low' | 'high';
export type CoverCorner = 'left' | 'right' | null;

export interface CoverPoint {
  readonly x: number;
  readonly z: number;
}

export interface SoftCoverSurface {
  readonly id: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly heightMeters: number;
}

export interface SoftCoverRequest {
  readonly position: CoverPoint;
  readonly surfaces: readonly SoftCoverSurface[];
  readonly crouching: boolean;
  readonly aiming: boolean;
  readonly shoulder: CoverShoulder;
  readonly requestPeek?: boolean;
  /** Unit direction from the player toward the threat. Omit to evaluate the facing cover itself. */
  readonly threatDirection?: CoverPoint;
  readonly maximumCoverDistanceMeters?: number;
}

export interface SoftCoverResult {
  readonly engaged: boolean;
  readonly coverId: string | null;
  readonly coverHeight: CoverHeight | null;
  readonly distanceMeters: number;
  readonly normal: CoverPoint | null;
  readonly corner: CoverCorner;
  readonly peeking: boolean;
  readonly exposure: number;
  readonly incomingDamageMultiplier: number;
  /** Soft cover never snaps or corrects the player position. */
  readonly positionCorrection: null;
}

interface CoverCandidate {
  surface: SoftCoverSurface;
  distance: number;
  normal: CoverPoint;
  edge: 'west' | 'east' | 'north' | 'south';
  edgeCoordinate: number;
  edgeMinimum: number;
  edgeMaximum: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalize(point: Readonly<CoverPoint>): CoverPoint {
  const length = Math.hypot(point.x, point.z);
  if (length < 0.000001) return { x: 0, z: -1 };
  return { x: point.x / length, z: point.z / length };
}

function validateSurface(surface: Readonly<SoftCoverSurface>): void {
  if (!surface.id) throw new Error('soft cover surface id must not be empty');
  if (![surface.minX, surface.maxX, surface.minZ, surface.maxZ, surface.heightMeters].every(Number.isFinite)) {
    throw new RangeError(`soft cover surface ${surface.id} must contain finite values`);
  }
  if (surface.minX >= surface.maxX || surface.minZ >= surface.maxZ || surface.heightMeters <= 0) {
    throw new RangeError(`soft cover surface ${surface.id} has invalid bounds or height`);
  }
}

function nearestCandidate(position: Readonly<CoverPoint>, surface: Readonly<SoftCoverSurface>): CoverCandidate {
  const clampedX = clamp(position.x, surface.minX, surface.maxX);
  const clampedZ = clamp(position.z, surface.minZ, surface.maxZ);
  const offsetX = position.x - clampedX;
  const offsetZ = position.z - clampedZ;
  if (Math.hypot(offsetX, offsetZ) > 0.000001) {
    const normal = normalize({ x: offsetX, z: offsetZ });
    if (Math.abs(normal.x) >= Math.abs(normal.z)) {
      return {
        surface,
        distance: Math.hypot(offsetX, offsetZ),
        normal,
        edge: normal.x < 0 ? 'west' : 'east',
        edgeCoordinate: clampedZ,
        edgeMinimum: surface.minZ,
        edgeMaximum: surface.maxZ,
      };
    }
    return {
      surface,
      distance: Math.hypot(offsetX, offsetZ),
      normal,
      edge: normal.z < 0 ? 'north' : 'south',
      edgeCoordinate: clampedX,
      edgeMinimum: surface.minX,
      edgeMaximum: surface.maxX,
    };
  }

  const edges = [
    { distance: position.x - surface.minX, normal: { x: -1, z: 0 }, edge: 'west' as const, coordinate: position.z, minimum: surface.minZ, maximum: surface.maxZ },
    { distance: surface.maxX - position.x, normal: { x: 1, z: 0 }, edge: 'east' as const, coordinate: position.z, minimum: surface.minZ, maximum: surface.maxZ },
    { distance: position.z - surface.minZ, normal: { x: 0, z: -1 }, edge: 'north' as const, coordinate: position.x, minimum: surface.minX, maximum: surface.maxX },
    { distance: surface.maxZ - position.z, normal: { x: 0, z: 1 }, edge: 'south' as const, coordinate: position.x, minimum: surface.minX, maximum: surface.maxX },
  ].sort((left, right) => left.distance - right.distance);
  const nearest = edges[0];
  if (!nearest) throw new Error('soft cover edge calculation failed');
  return {
    surface,
    distance: nearest.distance,
    normal: nearest.normal,
    edge: nearest.edge,
    edgeCoordinate: nearest.coordinate,
    edgeMinimum: nearest.minimum,
    edgeMaximum: nearest.maximum,
  };
}

export function resolveSoftCover(request: Readonly<SoftCoverRequest>): SoftCoverResult {
  if (![request.position.x, request.position.z].every(Number.isFinite)) {
    throw new RangeError('soft cover player position must be finite');
  }
  const maximumDistance = request.maximumCoverDistanceMeters ?? 1.15;
  if (!Number.isFinite(maximumDistance) || maximumDistance <= 0) {
    throw new RangeError('maximum soft cover distance must be finite and positive');
  }
  request.surfaces.forEach(validateSurface);
  const candidate = request.surfaces
    .map((surface) => nearestCandidate(request.position, surface))
    .filter((entry) => entry.distance <= maximumDistance && entry.surface.heightMeters >= 0.65)
    .sort((left, right) => left.distance - right.distance || left.surface.id.localeCompare(right.surface.id))[0];

  if (!request.crouching || !candidate) {
    return {
      engaged: false, coverId: null, coverHeight: null, distanceMeters: candidate?.distance ?? Number.POSITIVE_INFINITY,
      normal: null, corner: null, peeking: false, exposure: 1, incomingDamageMultiplier: 1, positionCorrection: null,
    };
  }

  const cornerThreshold = 0.78;
  const negativeDistance = candidate.edgeCoordinate - candidate.edgeMinimum;
  const positiveDistance = candidate.edgeMaximum - candidate.edgeCoordinate;
  const corner: CoverCorner = negativeDistance <= cornerThreshold
    ? 'left'
    : positiveDistance <= cornerThreshold
      ? 'right'
      : null;
  const peeking = Boolean(request.requestPeek)
    && request.aiming
    && corner !== null
    && corner === request.shoulder;
  const coverHeight: CoverHeight = candidate.surface.heightMeters >= 1.25 ? 'high' : 'low';
  const threatDirection = request.threatDirection ? normalize(request.threatDirection) : null;
  const threatBehindCover = !threatDirection
    || threatDirection.x * candidate.normal.x + threatDirection.z * candidate.normal.z < -0.18;
  let exposure = request.aiming
    ? coverHeight === 'high' ? 0.34 : 0.54
    : coverHeight === 'high' ? 0.1 : 0.28;
  if (peeking) exposure = coverHeight === 'high' ? 0.62 : 0.72;
  if (!threatBehindCover) exposure = 1;

  return {
    engaged: true,
    coverId: candidate.surface.id,
    coverHeight,
    distanceMeters: candidate.distance,
    normal: candidate.normal,
    corner,
    peeking,
    exposure,
    incomingDamageMultiplier: exposure,
    positionCorrection: null,
  };
}
