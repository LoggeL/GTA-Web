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
