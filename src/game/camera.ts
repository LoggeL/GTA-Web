import type { CollisionRect } from './city';
import { cameraSafeFraction } from './collision';
import type { ShoulderSide, Vec3Data } from './types';

export interface CameraPlacementOptions {
  target: Readonly<Vec3Data>;
  yaw: number;
  pitch: number;
  distance: number;
  mode: 'follow' | 'aim' | 'vehicle';
  shoulderSide: ShoulderSide;
  collisions: readonly CollisionRect[];
}

export interface CameraPlacement {
  position: Vec3Data;
  lookTarget: Vec3Data;
  safeFraction: number;
  fov: number;
}

export interface CameraShakeOptions {
  /** Stable simulation time; wall-clock time would make captures nondeterministic. */
  elapsedSeconds: number;
  /** Normalized presentation setting in [0, 1]. */
  intensity: number;
  reducedMotion: boolean;
  speedMetersPerSecond: number;
  /** Short-lived normalized impulse in [0, 1]. */
  impactStrength: number;
}

export function normalizeCameraShakeIntensity(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('cameraShake must be finite');
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Produces a small deterministic camera displacement. Speed adds a gentle
 * high-frequency vibration while impacts add a stronger, caller-decayed pulse.
 */
export function computeCameraShakeOffset(options: Readonly<CameraShakeOptions>): Vec3Data {
  const intensity = normalizeCameraShakeIntensity(options.intensity);
  if (intensity === 0 || options.reducedMotion) {
    return { x: 0, y: 0, z: 0 };
  }

  const elapsedSeconds = Number.isFinite(options.elapsedSeconds) ? options.elapsedSeconds : 0;
  const speed = Number.isFinite(options.speedMetersPerSecond)
    ? Math.abs(options.speedMetersPerSecond)
    : 0;
  const impact = Number.isFinite(options.impactStrength)
    ? Math.min(1, Math.max(0, options.impactStrength))
    : 0;
  const speedStrength = Math.min(1, speed / 28);
  if (speedStrength === 0 && impact === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  const horizontalAmplitude = intensity * (speedStrength * 0.012 + impact * 0.055);
  const verticalAmplitude = intensity * (speedStrength * 0.016 + impact * 0.042);
  return {
    x: Math.sin(elapsedSeconds * 19.7 + 0.65) * horizontalAmplitude,
    y: (
      Math.sin(elapsedSeconds * 23.3 + 1.2) * 0.72
      + Math.sin(elapsedSeconds * 11.1 + 2.4) * 0.28
    ) * verticalAmplitude,
    z: Math.cos(elapsedSeconds * 17.9 + 0.35) * horizontalAmplitude * 0.68,
  };
}

export function oppositeShoulder(side: ShoulderSide): ShoulderSide {
  return side === 'right' ? 'left' : 'right';
}

export function computeCameraPlacement(options: Readonly<CameraPlacementOptions>): CameraPlacement {
  const horizontalDistance = Math.cos(options.pitch) * options.distance;
  const rightX = Math.cos(options.yaw);
  const rightZ = -Math.sin(options.yaw);
  const forwardX = -Math.sin(options.yaw);
  const forwardZ = -Math.cos(options.yaw);
  const shoulderDirection = options.shoulderSide === 'right' ? 1 : -1;
  const shoulderOffset = options.mode === 'aim' ? shoulderDirection * 0.72 : 0;
  const verticalOffset = options.mode === 'vehicle' ? 0.8 : 0;
  const desiredPosition: Vec3Data = {
    x: options.target.x + Math.sin(options.yaw) * horizontalDistance + rightX * shoulderOffset,
    y: options.target.y + Math.sin(options.pitch) * options.distance + verticalOffset,
    z: options.target.z + Math.cos(options.yaw) * horizontalDistance + rightZ * shoulderOffset,
  };
  const safeFraction = cameraSafeFraction(options.target, desiredPosition, options.collisions);
  const position: Vec3Data = {
    x: options.target.x + (desiredPosition.x - options.target.x) * safeFraction,
    y: Math.max(0.8, options.target.y + (desiredPosition.y - options.target.y) * safeFraction),
    z: options.target.z + (desiredPosition.z - options.target.z) * safeFraction,
  };
  const aimDistance = options.mode === 'aim' ? 14 : 0;
  const lookTarget: Vec3Data = {
    x: options.target.x + forwardX * aimDistance,
    y: options.target.y + (options.mode === 'aim' ? 0.18 : 0),
    z: options.target.z + forwardZ * aimDistance,
  };

  return {
    position,
    lookTarget,
    safeFraction,
    fov: options.mode === 'aim' ? 48 : options.mode === 'vehicle' ? 67 : 62,
  };
}
