import { SeededRandom, type RandomSeed } from '../core/random';
import {
  policeResponseForLevel,
  type PoliceResponse,
  type WantedLevel,
  type WantedPhase,
} from './wanted';

export const POLICE_RESPONSE_SNAPSHOT_VERSION = 1 as const;

export interface PoliceResponsePosition {
  x: number;
  z: number;
}

/** A road-graph location that can safely host a response without blocking a junction. */
export interface RoadblockCandidate {
  id: string;
  position: PoliceResponsePosition;
  heading: number;
}

export interface PoliceUnitQuotas {
  footPatrols: number;
  armedOfficers: number;
  cruisers: number;
  flankCars: number;
  tacticalVans: number;
  armoredHeavies: number;
  marksmen: number;
}

export interface RoadblockDeployment {
  id: string;
  anchorId: string;
  position: PoliceResponsePosition;
  heading: number;
  reinforced: boolean;
  tireStrip: boolean;
}

export type HelicopterMode = 'inactive' | 'approach' | 'track' | 'search';
export type SpotlightMode = 'off' | 'tracking' | 'sweeping';

export interface TacticalHelicopterState {
  active: boolean;
  mode: HelicopterMode;
  position: {
    x: number;
    y: number;
    z: number;
  };
  target: PoliceResponsePosition;
  orbitRadians: number;
  spotlight: SpotlightMode;
}

export interface PoliceResponseSnapshot {
  version: typeof POLICE_RESPONSE_SNAPSHOT_VERSION;
  randomState: number;
  deploymentSequence: number;
  level: WantedLevel;
  phase: WantedPhase;
  capabilities: PoliceResponse[];
  units: PoliceUnitQuotas;
  roadblocks: RoadblockDeployment[];
  helicopter: TacticalHelicopterState;
}

export interface PoliceResponseTickContext {
  suspectPosition: PoliceResponsePosition;
  lastKnownPosition: PoliceResponsePosition;
  suspectVisible: boolean;
  roadblockCandidates?: readonly RoadblockCandidate[];
}

const EMPTY_POSITION: Readonly<PoliceResponsePosition> = Object.freeze({ x: 0, z: 0 });
const HELICOPTER_ALTITUDE = 52;
const HELICOPTER_ORBIT_RADIUS = 38;

const UNIT_QUOTAS: Readonly<Record<WantedLevel, Readonly<PoliceUnitQuotas>>> = Object.freeze({
  0: Object.freeze({
    footPatrols: 0, armedOfficers: 0, cruisers: 0, flankCars: 0,
    tacticalVans: 0, armoredHeavies: 0, marksmen: 0,
  }),
  1: Object.freeze({
    footPatrols: 2, armedOfficers: 0, cruisers: 0, flankCars: 0,
    tacticalVans: 0, armoredHeavies: 0, marksmen: 0,
  }),
  2: Object.freeze({
    footPatrols: 2, armedOfficers: 4, cruisers: 2, flankCars: 0,
    tacticalVans: 0, armoredHeavies: 0, marksmen: 0,
  }),
  3: Object.freeze({
    footPatrols: 2, armedOfficers: 6, cruisers: 3, flankCars: 2,
    tacticalVans: 0, armoredHeavies: 0, marksmen: 0,
  }),
  4: Object.freeze({
    footPatrols: 2, armedOfficers: 8, cruisers: 4, flankCars: 2,
    tacticalVans: 2, armoredHeavies: 2, marksmen: 2,
  }),
  5: Object.freeze({
    footPatrols: 2, armedOfficers: 10, cruisers: 5, flankCars: 3,
    tacticalVans: 3, armoredHeavies: 3, marksmen: 4,
  }),
});

const ROADBLOCK_COUNTS: Readonly<Record<WantedLevel, number>> = Object.freeze({
  0: 0,
  1: 0,
  2: 0,
  3: 1,
  4: 2,
  5: 3,
});

/**
 * Render-agnostic response planner. It emits stable unit budgets, road-graph
 * deployments, and an AI-only level-five helicopter target for the world layer.
 */
export class PoliceResponseDirector {
  private readonly random: SeededRandom;
  private deploymentSequence = 0;
  private level: WantedLevel = 0;
  private phase: WantedPhase = 'clear';
  private roadblocks: RoadblockDeployment[] = [];
  private helicopter = inactiveHelicopter();

  public constructor(seed: RandomSeed = 'heatline-police-response-v1') {
    this.random = new SeededRandom(seed);
  }

  public static fromSnapshot(snapshot: Readonly<PoliceResponseSnapshot>): PoliceResponseDirector {
    validatePoliceResponseSnapshot(snapshot);
    const director = new PoliceResponseDirector(snapshot.randomState);
    director.random.setState(snapshot.randomState);
    director.deploymentSequence = snapshot.deploymentSequence;
    director.level = snapshot.level;
    director.phase = snapshot.phase;
    director.roadblocks = snapshot.roadblocks.map(cloneRoadblock);
    director.helicopter = cloneHelicopter(snapshot.helicopter);
    return director;
  }

  public tick(
    deltaSeconds: number,
    level: WantedLevel,
    phase: WantedPhase,
    context: Readonly<PoliceResponseTickContext>,
  ): PoliceResponseSnapshot {
    assertFiniteNonNegative(deltaSeconds, 'deltaSeconds');
    validateLevelAndPhase(level, phase);
    validatePosition(context.suspectPosition, 'suspectPosition');
    validatePosition(context.lastKnownPosition, 'lastKnownPosition');

    this.level = level;
    this.phase = phase;
    if (level === 0) {
      this.roadblocks = [];
      this.helicopter = inactiveHelicopter();
      return this.getSnapshot();
    }

    const desiredRoadblocks = ROADBLOCK_COUNTS[level];
    if (context.roadblockCandidates === undefined) {
      this.roadblocks = this.roadblocks
        .slice(0, desiredRoadblocks)
        .map((deployment) => ({
          ...deployment,
          reinforced: level === 5,
          tireStrip: true,
        }));
    } else {
      this.reconcileRoadblocks(
        desiredRoadblocks,
        context.roadblockCandidates,
        context.lastKnownPosition,
        level === 5,
      );
    }
    this.tickHelicopter(deltaSeconds, context);
    return this.getSnapshot();
  }

  public clear(): PoliceResponseSnapshot {
    this.level = 0;
    this.phase = 'clear';
    this.roadblocks = [];
    this.helicopter = inactiveHelicopter();
    return this.getSnapshot();
  }

  public getSnapshot(): PoliceResponseSnapshot {
    return {
      version: POLICE_RESPONSE_SNAPSHOT_VERSION,
      randomState: this.random.getState(),
      deploymentSequence: this.deploymentSequence,
      level: this.level,
      phase: this.phase,
      capabilities: [...policeResponseForLevel(this.level)],
      units: { ...UNIT_QUOTAS[this.level] },
      roadblocks: this.roadblocks.map(cloneRoadblock),
      helicopter: cloneHelicopter(this.helicopter),
    };
  }

  private reconcileRoadblocks(
    desiredCount: number,
    candidates: readonly RoadblockCandidate[],
    lastKnownPosition: Readonly<PoliceResponsePosition>,
    reinforced: boolean,
  ): void {
    const validCandidates = uniqueValidCandidates(candidates);
    const candidateById = new Map(validCandidates.map((candidate) => [candidate.id, candidate]));
    this.roadblocks = this.roadblocks
      .filter((deployment) => candidateById.has(deployment.anchorId))
      .slice(0, desiredCount)
      .map((deployment) => ({ ...deployment, reinforced, tireStrip: true }));

    if (this.roadblocks.length >= desiredCount) {
      return;
    }

    const occupied = new Set(this.roadblocks.map((deployment) => deployment.anchorId));
    const available = validCandidates
      .filter((candidate) => !occupied.has(candidate.id))
      .filter((candidate) => {
        const distance = distance2d(candidate.position, lastKnownPosition);
        return distance >= 24 && distance <= 260;
      })
      .map((candidate) => ({
        candidate,
        score: Math.abs(distance2d(candidate.position, lastKnownPosition) - 92)
          + this.random.range(0, 18),
      }))
      .sort((left, right) => left.score - right.score || left.candidate.id.localeCompare(right.candidate.id));

    for (const { candidate } of available) {
      if (this.roadblocks.length >= desiredCount) {
        break;
      }
      this.roadblocks.push({
        id: `roadblock-${this.deploymentSequence.toString().padStart(4, '0')}`,
        anchorId: candidate.id,
        position: clonePosition(candidate.position),
        heading: normalizeRadians(candidate.heading),
        reinforced,
        tireStrip: true,
      });
      this.deploymentSequence += 1;
    }
  }

  private tickHelicopter(
    deltaSeconds: number,
    context: Readonly<PoliceResponseTickContext>,
  ): void {
    if (this.level !== 5) {
      this.helicopter = inactiveHelicopter();
      return;
    }

    const target = context.suspectVisible
      ? context.suspectPosition
      : context.lastKnownPosition;
    const orbitRadians = normalizeRadians(this.helicopter.orbitRadians + deltaSeconds * 0.32);
    const mode: HelicopterMode = context.suspectVisible
      ? 'track'
      : this.phase === 'search' ? 'search' : 'approach';
    this.helicopter = {
      active: true,
      mode,
      position: {
        x: target.x + Math.cos(orbitRadians) * HELICOPTER_ORBIT_RADIUS,
        y: HELICOPTER_ALTITUDE,
        z: target.z + Math.sin(orbitRadians) * HELICOPTER_ORBIT_RADIUS,
      },
      target: clonePosition(target),
      orbitRadians,
      spotlight: context.suspectVisible ? 'tracking' : 'sweeping',
    };
  }
}

export function policeUnitQuotasForLevel(level: WantedLevel): PoliceUnitQuotas {
  return { ...UNIT_QUOTAS[level] };
}

export function roadblockCountForLevel(level: WantedLevel): number {
  return ROADBLOCK_COUNTS[level];
}

export function validatePoliceResponseSnapshot(
  snapshot: Readonly<PoliceResponseSnapshot>,
): void {
  if (snapshot.version !== POLICE_RESPONSE_SNAPSHOT_VERSION) {
    throw new RangeError(`unsupported police response snapshot version ${String(snapshot.version)}`);
  }
  assertUint32(snapshot.randomState, 'randomState');
  if (!Number.isSafeInteger(snapshot.deploymentSequence) || snapshot.deploymentSequence < 0) {
    throw new RangeError('deploymentSequence must be a non-negative safe integer');
  }
  validateLevelAndPhase(snapshot.level, snapshot.phase);
  const expectedCapabilities = policeResponseForLevel(snapshot.level);
  if (!Array.isArray(snapshot.capabilities)
    || snapshot.capabilities.length !== expectedCapabilities.length
    || snapshot.capabilities.some((capability, index) => capability !== expectedCapabilities[index])) {
    throw new RangeError('police response capabilities do not match wanted level');
  }
  if (!isRecord(snapshot.units)) {
    throw new RangeError('police unit quotas must be an object');
  }
  const expectedUnits = UNIT_QUOTAS[snapshot.level];
  for (const key of Object.keys(expectedUnits) as (keyof PoliceUnitQuotas)[]) {
    if (snapshot.units[key] !== expectedUnits[key]) {
      throw new RangeError('police unit quotas do not match wanted level');
    }
  }
  if (!Array.isArray(snapshot.roadblocks)) {
    throw new RangeError('police roadblocks must be an array');
  }
  if (snapshot.roadblocks.length > ROADBLOCK_COUNTS[snapshot.level]) {
    throw new RangeError('snapshot contains too many roadblocks for its wanted level');
  }
  const ids = new Set<string>();
  const anchors = new Set<string>();
  for (const roadblock of snapshot.roadblocks) {
    if (!isRecord(roadblock)) {
      throw new RangeError('roadblock entries must be objects');
    }
    if (!roadblock.id || !roadblock.anchorId || ids.has(roadblock.id) || anchors.has(roadblock.anchorId)) {
      throw new RangeError('roadblocks must have unique non-empty ids and anchors');
    }
    ids.add(roadblock.id);
    anchors.add(roadblock.anchorId);
    validatePosition(roadblock.position, 'roadblock.position');
    if (!Number.isFinite(roadblock.heading)) {
      throw new RangeError('roadblock heading must be finite');
    }
    if (!roadblock.tireStrip || roadblock.reinforced !== (snapshot.level === 5)) {
      throw new RangeError('roadblock equipment does not match wanted level');
    }
  }
  if (!isRecord(snapshot.helicopter)) {
    throw new RangeError('helicopter state must be an object');
  }
  validateHelicopter(snapshot.helicopter, snapshot.level);
}

function uniqueValidCandidates(candidates: readonly RoadblockCandidate[]): RoadblockCandidate[] {
  const seen = new Set<string>();
  const result: RoadblockCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.id || seen.has(candidate.id)) {
      continue;
    }
    validatePosition(candidate.position, `roadblock candidate ${candidate.id}`);
    if (!Number.isFinite(candidate.heading)) {
      throw new RangeError(`roadblock candidate ${candidate.id} heading must be finite`);
    }
    seen.add(candidate.id);
    result.push({
      ...candidate,
      position: clonePosition(candidate.position),
      heading: normalizeRadians(candidate.heading),
    });
  }
  return result;
}

function inactiveHelicopter(): TacticalHelicopterState {
  return {
    active: false,
    mode: 'inactive',
    position: { ...EMPTY_POSITION, y: 0 },
    target: { ...EMPTY_POSITION },
    orbitRadians: 0,
    spotlight: 'off',
  };
}

function cloneRoadblock(deployment: Readonly<RoadblockDeployment>): RoadblockDeployment {
  return { ...deployment, position: clonePosition(deployment.position) };
}

function cloneHelicopter(helicopter: Readonly<TacticalHelicopterState>): TacticalHelicopterState {
  return {
    ...helicopter,
    position: { ...helicopter.position },
    target: clonePosition(helicopter.target),
  };
}

function validateHelicopter(
  helicopter: Readonly<TacticalHelicopterState>,
  level: WantedLevel,
): void {
  validatePosition(helicopter.position, 'helicopter.position');
  if (!Number.isFinite(helicopter.position.y) || !Number.isFinite(helicopter.orbitRadians)) {
    throw new RangeError('helicopter altitude and orbit must be finite');
  }
  validatePosition(helicopter.target, 'helicopter.target');
  if ((level === 5) !== helicopter.active) {
    throw new RangeError('helicopter activation must match wanted level five');
  }
  if (!helicopter.active && (helicopter.mode !== 'inactive' || helicopter.spotlight !== 'off')) {
    throw new RangeError('inactive helicopter cannot have an active mode or spotlight');
  }
  if (helicopter.active
    && (!['approach', 'track', 'search'].includes(helicopter.mode)
      || !['tracking', 'sweeping'].includes(helicopter.spotlight))) {
    throw new RangeError('active helicopter requires a response mode and spotlight');
  }
  if (helicopter.orbitRadians < 0 || helicopter.orbitRadians >= Math.PI * 2) {
    throw new RangeError('helicopter orbit must be normalized');
  }
}

function validateLevelAndPhase(level: WantedLevel, phase: WantedPhase): void {
  if (!Number.isInteger(level) || level < 0 || level > 5) {
    throw new RangeError('wanted level must be an integer between 0 and 5');
  }
  if (!['clear', 'investigating', 'pursuit', 'search'].includes(phase)) {
    throw new RangeError('invalid wanted phase');
  }
  if ((level === 0) !== (phase === 'clear')) {
    throw new RangeError('only level zero may use the clear phase');
  }
}

function validatePosition(position: Readonly<PoliceResponsePosition>, label: string): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) {
    throw new RangeError(`${label} must contain finite coordinates`);
  }
}

function distance2d(
  left: Readonly<PoliceResponsePosition>,
  right: Readonly<PoliceResponsePosition>,
): number {
  return Math.hypot(left.x - right.x, left.z - right.z);
}

function clonePosition(position: Readonly<PoliceResponsePosition>): PoliceResponsePosition {
  return { x: position.x, z: position.z };
}

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value % fullTurn) + fullTurn) % fullTurn;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative and finite`);
  }
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 0x1_0000_0000) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
