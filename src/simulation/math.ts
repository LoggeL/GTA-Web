import type { SimulationObstacle, SimulationVec3 } from './types';

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function moveTowards(current: number, target: number, maximumDelta: number): number {
  if (Math.abs(target - current) <= maximumDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maximumDelta;
}

export function distance2d(first: Readonly<SimulationVec3>, second: Readonly<SimulationVec3>): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
}

export function normalize2d(vector: Readonly<SimulationVec3>): SimulationVec3 {
  const length = Math.hypot(vector.x, vector.z);
  if (length < 0.000001) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: vector.x / length, y: 0, z: vector.z / length };
}

export function headingFromDirection(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

export function directionFromHeading(heading: number): SimulationVec3 {
  return { x: -Math.sin(heading), y: 0, z: -Math.cos(heading) };
}

export function pointBlocked(
  position: Readonly<SimulationVec3>,
  radius: number,
  obstacles: readonly SimulationObstacle[],
): boolean {
  return obstacles.some((obstacle) => Math.hypot(position.x - obstacle.x, position.z - obstacle.z) < radius + obstacle.radius);
}

