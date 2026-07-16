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
  let safeFraction = 1;

  for (const collision of collisions) {
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

