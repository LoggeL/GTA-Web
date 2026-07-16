import { CITY_HALF_SIZE } from './city';
import type { CollisionRect } from './city';
import type { Vec3Data } from './types';

export function clampToCity(value: number, radius: number): number {
  return Math.min(CITY_HALF_SIZE - radius, Math.max(-CITY_HALF_SIZE + radius, value));
}

export function circleIntersectsBuildings(
  x: number,
  z: number,
  radius: number,
  collisions: readonly CollisionRect[],
): boolean {
  for (const collision of collisions) {
    const closestX = Math.max(collision.minX, Math.min(x, collision.maxX));
    const closestZ = Math.max(collision.minZ, Math.min(z, collision.maxZ));
    const deltaX = x - closestX;
    const deltaZ = z - closestZ;
    if (deltaX * deltaX + deltaZ * deltaZ < radius * radius) {
      return true;
    }
  }
  return false;
}

export function circleIntersectsRect(
  x: number,
  z: number,
  radius: number,
  collision: Readonly<CollisionRect>,
): boolean {
  const closestX = Math.max(collision.minX, Math.min(x, collision.maxX));
  const closestZ = Math.max(collision.minZ, Math.min(z, collision.maxZ));
  const deltaX = x - closestX;
  const deltaZ = z - closestZ;
  return deltaX * deltaX + deltaZ * deltaZ < radius * radius;
}

export function supportHeightAt(
  x: number,
  z: number,
  radius: number,
  collisions: readonly CollisionRect[],
): number {
  let height = 0;
  for (const collision of collisions) {
    if (collision.kind === 'step' && circleIntersectsRect(x, z, radius, collision)) {
      height = Math.max(height, collision.height);
    }
  }
  return height;
}

export function movementBlockersAtHeight(
  collisions: readonly CollisionRect[],
  footHeight: number,
): readonly CollisionRect[] {
  return collisions.filter((collision) => (
    collision.kind !== 'step' && collision.height > footHeight + 0.08
  ));
}

export function findVaultObstacle(
  x: number,
  z: number,
  radius: number,
  collisions: readonly CollisionRect[],
): CollisionRect | null {
  return collisions.find((collision) => (
    collision.kind === 'vault' && circleIntersectsRect(x, z, radius, collision)
  )) ?? null;
}

export function moveCircleWithCollisions(
  position: Vec3Data,
  deltaX: number,
  deltaZ: number,
  radius: number,
  collisions: readonly CollisionRect[],
): { blockedX: boolean; blockedZ: boolean } {
  const nextX = clampToCity(position.x + deltaX, radius);
  const blockedX = circleIntersectsBuildings(nextX, position.z, radius, collisions);
  if (!blockedX) {
    position.x = nextX;
  }

  const nextZ = clampToCity(position.z + deltaZ, radius);
  const blockedZ = circleIntersectsBuildings(position.x, nextZ, radius, collisions);
  if (!blockedZ) {
    position.z = nextZ;
  }

  return { blockedX, blockedZ };
}

function lineInterval(
  origin: number,
  direction: number,
  minimum: number,
  maximum: number,
  near: number,
  far: number,
): readonly [number, number] | null {
  if (Math.abs(direction) < 0.000001) {
    return origin >= minimum && origin <= maximum ? [near, far] : null;
  }

  const inverse = 1 / direction;
  let first = (minimum - origin) * inverse;
  let second = (maximum - origin) * inverse;
  if (first > second) {
    [first, second] = [second, first];
  }
  const nextNear = Math.max(near, first);
  const nextFar = Math.min(far, second);
  return nextNear <= nextFar ? [nextNear, nextFar] : null;
}

/**
 * Returns the unobstructed fraction of a target-to-camera segment. Buildings
 * only obstruct the camera when the segment is below their roof at impact.
 */
export function cameraSafeFraction(
  target: Readonly<Vec3Data>,
  desiredCamera: Readonly<Vec3Data>,
  collisions: readonly CollisionRect[],
  padding = 0.45,
): number {
  const directionX = desiredCamera.x - target.x;
  const directionY = desiredCamera.y - target.y;
  const directionZ = desiredCamera.z - target.z;
  const segmentMinX = Math.min(target.x, desiredCamera.x) - padding;
  const segmentMaxX = Math.max(target.x, desiredCamera.x) + padding;
  const segmentMinZ = Math.min(target.z, desiredCamera.z) - padding;
  const segmentMaxZ = Math.max(target.z, desiredCamera.z) + padding;
  let safeFraction = 1;

  for (const collision of collisions) {
    // Most streamed blockers are nowhere near the short follow-camera segment.
    // Reject them before the more expensive slab tests (which also allocate
    // interval tuples) without changing the exact intersection result.
    if (
      collision.maxX < segmentMinX
      || collision.minX > segmentMaxX
      || collision.maxZ < segmentMinZ
      || collision.minZ > segmentMaxZ
    ) {
      continue;
    }
    let interval = lineInterval(
      target.x,
      directionX,
      collision.minX - padding,
      collision.maxX + padding,
      0,
      safeFraction,
    );
    if (!interval) {
      continue;
    }
    interval = lineInterval(
      target.z,
      directionZ,
      collision.minZ - padding,
      collision.maxZ + padding,
      interval[0],
      interval[1],
    );
    if (!interval) {
      continue;
    }

    const hitFraction = interval[0];
    const hitHeight = target.y + directionY * hitFraction;
    if (hitHeight <= collision.height + padding) {
      safeFraction = Math.max(0.2, hitFraction - 0.035);
    }
  }

  return safeFraction;
}
