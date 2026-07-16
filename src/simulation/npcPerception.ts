import {
  clamp,
  directionFromHeading,
  distance2d,
  normalize2d,
} from './math';
import type { SimulationObstacle, SimulationVec3 } from './types';

export type NpcAwarenessBand = 'unaware' | 'curious' | 'suspicious' | 'detected';

export interface NpcPerceptionProfile {
  readonly visionRange: number;
  readonly peripheralRange: number;
  readonly fieldOfViewRadians: number;
  readonly hearingRange: number;
  readonly sightGainPerSecond: number;
  readonly hearingGainPerSecond: number;
  readonly awarenessDecayPerSecond: number;
  readonly memorySeconds: number;
}

export interface NpcPerceptionTarget {
  readonly id: string;
  readonly position: SimulationVec3;
  /** 0 means fully concealed; 1 is ordinary daylight exposure. */
  readonly visibility: number;
  /** 0 is silent; 1 is normal maximum hearing range; values above 1 are allowed. */
  readonly noise: number;
  readonly threatening: boolean;
}

export interface NpcPerceptionContext {
  readonly deltaSeconds: number;
  readonly observerPosition: SimulationVec3;
  readonly observerHeading: number;
  readonly target: NpcPerceptionTarget;
  readonly obstacles?: readonly SimulationObstacle[];
}

export interface NpcPerceptionSnapshot {
  readonly awareness: number;
  readonly band: NpcAwarenessBand;
  readonly targetVisible: boolean;
  readonly targetHeard: boolean;
  readonly secondsSinceSensed: number;
  readonly lastKnownPosition: SimulationVec3 | null;
  readonly lastSense: 'none' | 'sight' | 'sound' | 'alert';
}

export interface NpcVisibilityFactors {
  readonly lightLevel?: number;
  readonly crouching?: boolean;
  readonly coverExposure?: number;
  readonly movement?: number;
}

export const DEFAULT_NPC_PERCEPTION_PROFILE: NpcPerceptionProfile = Object.freeze({
  visionRange: 34,
  peripheralRange: 7,
  fieldOfViewRadians: Math.PI * 0.72,
  hearingRange: 28,
  sightGainPerSecond: 0.78,
  hearingGainPerSecond: 0.52,
  awarenessDecayPerSecond: 0.12,
  memorySeconds: 5,
});

export function npcVisibilityFactor(factors: Readonly<NpcVisibilityFactors>): number {
  const light = clamp(factors.lightLevel ?? 1, 0, 1);
  const cover = clamp(factors.coverExposure ?? 1, 0, 1);
  const movement = clamp(factors.movement ?? 0.5, 0, 1);
  const posture = factors.crouching ? 0.62 : 1;
  return clamp((0.22 + light * 0.58 + movement * 0.2) * cover * posture, 0.05, 1);
}

function segmentIntersectsObstacle(
  start: Readonly<SimulationVec3>,
  end: Readonly<SimulationVec3>,
  obstacle: Readonly<SimulationObstacle>,
): boolean {
  const segmentX = end.x - start.x;
  const segmentZ = end.z - start.z;
  const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
  if (lengthSquared <= 0.000001) return false;
  const projection = clamp(
    ((obstacle.x - start.x) * segmentX + (obstacle.z - start.z) * segmentZ) / lengthSquared,
    0.04,
    0.96,
  );
  const closestX = start.x + segmentX * projection;
  const closestZ = start.z + segmentZ * projection;
  return Math.hypot(obstacle.x - closestX, obstacle.z - closestZ) < obstacle.radius;
}

export function npcHasLineOfSight(
  start: Readonly<SimulationVec3>,
  end: Readonly<SimulationVec3>,
  obstacles: readonly SimulationObstacle[],
): boolean {
  return !obstacles.some((obstacle) => segmentIntersectsObstacle(start, end, obstacle));
}

export function npcTargetInVision(
  observerPosition: Readonly<SimulationVec3>,
  observerHeading: number,
  targetPosition: Readonly<SimulationVec3>,
  profile: Readonly<NpcPerceptionProfile>,
  visibility: number,
  obstacles: readonly SimulationObstacle[],
): boolean {
  const distance = distance2d(observerPosition, targetPosition);
  const effectiveVisibility = clamp(visibility, 0, 1);
  const effectiveRange = profile.visionRange * (0.35 + effectiveVisibility * 0.65);
  if (distance > effectiveRange) return false;
  if (distance > profile.peripheralRange) {
    const forward = directionFromHeading(observerHeading);
    const towardTarget = normalize2d({
      x: targetPosition.x - observerPosition.x,
      y: 0,
      z: targetPosition.z - observerPosition.z,
    });
    const dot = forward.x * towardTarget.x + forward.z * towardTarget.z;
    if (dot < Math.cos(profile.fieldOfViewRadians / 2)) return false;
  }
  return npcHasLineOfSight(observerPosition, targetPosition, obstacles);
}

function awarenessBand(awareness: number): NpcAwarenessBand {
  if (awareness >= 0.82) return 'detected';
  if (awareness >= 0.5) return 'suspicious';
  if (awareness >= 0.18) return 'curious';
  return 'unaware';
}

export class NpcPerceptionSensor {
  private readonly profile: NpcPerceptionProfile;
  private awareness = 0;
  private targetVisible = false;
  private targetHeard = false;
  private secondsSinceSensed: number;
  private lastKnownPosition: SimulationVec3 | null = null;
  private lastSense: NpcPerceptionSnapshot['lastSense'] = 'none';
  private pendingAlert: { position: SimulationVec3; strength: number } | null = null;

  public constructor(profile: Readonly<NpcPerceptionProfile> = DEFAULT_NPC_PERCEPTION_PROFILE) {
    if (
      profile.visionRange < 0
      || profile.peripheralRange < 0
      || profile.hearingRange < 0
      || profile.memorySeconds < 0
    ) {
      throw new RangeError('NPC perception distances and memory must be non-negative');
    }
    this.profile = { ...profile };
    this.secondsSinceSensed = this.profile.memorySeconds + 1;
  }

  public reset(): void {
    this.awareness = 0;
    this.targetVisible = false;
    this.targetHeard = false;
    this.secondsSinceSensed = this.profile.memorySeconds + 1;
    this.lastKnownPosition = null;
    this.lastSense = 'none';
    this.pendingAlert = null;
  }

  public injectAlert(position: Readonly<SimulationVec3>, strength: number): void {
    const normalizedStrength = clamp(strength, 0, 1);
    if (!this.pendingAlert || normalizedStrength >= this.pendingAlert.strength) {
      this.pendingAlert = {
        position: { ...position },
        strength: normalizedStrength,
      };
    }
  }

  public tick(context: Readonly<NpcPerceptionContext>): NpcPerceptionSnapshot {
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    const obstacles = context.obstacles ?? [];
    const distance = distance2d(context.observerPosition, context.target.position);
    this.targetVisible = npcTargetInVision(
      context.observerPosition,
      context.observerHeading,
      context.target.position,
      this.profile,
      context.target.visibility,
      obstacles,
    );
    const audibleDistance = this.profile.hearingRange * Math.max(0, context.target.noise);
    this.targetHeard = context.target.noise > 0.01 && distance <= audibleDistance;

    if (this.targetVisible) {
      const proximity = 1 - clamp(distance / Math.max(0.001, this.profile.visionRange), 0, 1);
      const threatMultiplier = context.target.threatening ? 1.65 : 1;
      this.awareness += this.profile.sightGainPerSecond
        * (0.35 + proximity * 0.65)
        * clamp(context.target.visibility, 0.05, 1)
        * threatMultiplier
        * dt;
      this.lastKnownPosition = { ...context.target.position };
      this.lastSense = 'sight';
      this.secondsSinceSensed = 0;
    } else if (this.targetHeard) {
      const proximity = 1 - clamp(distance / Math.max(0.001, audibleDistance), 0, 1);
      this.awareness += this.profile.hearingGainPerSecond
        * (0.3 + proximity * 0.7)
        * clamp(context.target.noise, 0, 2)
        * dt;
      this.lastKnownPosition = { ...context.target.position };
      this.lastSense = 'sound';
      this.secondsSinceSensed = 0;
    } else if (this.pendingAlert) {
      this.awareness = Math.max(this.awareness, this.pendingAlert.strength * 0.72);
      this.lastKnownPosition = { ...this.pendingAlert.position };
      this.lastSense = 'alert';
      this.secondsSinceSensed = 0;
    } else {
      this.secondsSinceSensed += dt;
      const memoryMultiplier = this.secondsSinceSensed <= this.profile.memorySeconds ? 0.3 : 1;
      this.awareness -= this.profile.awarenessDecayPerSecond * memoryMultiplier * dt;
    }
    this.pendingAlert = null;
    this.awareness = clamp(this.awareness, 0, 1);
    if (this.awareness <= 0.001 && this.secondsSinceSensed > this.profile.memorySeconds) {
      this.lastSense = 'none';
      this.lastKnownPosition = null;
    }
    return this.getSnapshot();
  }

  public getSnapshot(): NpcPerceptionSnapshot {
    return {
      awareness: this.awareness,
      band: awarenessBand(this.awareness),
      targetVisible: this.targetVisible,
      targetHeard: this.targetHeard,
      secondsSinceSensed: this.secondsSinceSensed,
      lastKnownPosition: this.lastKnownPosition ? { ...this.lastKnownPosition } : null,
      lastSense: this.lastSense,
    };
  }
}
