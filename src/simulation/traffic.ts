import { VEHICLES } from '../data/vehicles';
import type { VehicleClassId } from '../data/types';
import type { DistrictId } from '../game/types';
import { buildRoadGraph } from '../navigation/road-graph';
import { directionFromHeading, distance2d, headingFromDirection, moveTowards } from './math';
import { SimulationRandom } from './random';
import {
  TRAFFIC_SIGNAL_STOP_LINE_DISTANCE,
  TrafficSignalSystem,
} from './traffic-signals';
import type { TrafficSignalSystemSnapshot } from './traffic-signals';
import type {
  ExternalTrafficCollisionResult,
  ExternalTrafficVehicleState,
  SimulationObstacle,
  SimulationQuality,
  SimulationRoadRecipe,
  SimulationVec3,
  TrafficBehavior,
  TrafficVehicleSnapshot,
} from './types';

export const TRAFFIC_CAPACITY: Readonly<Record<SimulationQuality, number>> = Object.freeze({
  low: 18,
  high: 42,
});

export const TRAFFIC_RELEVANCE_RADII = Object.freeze({
  /** Nothing is recycled into the immediate camera/gameplay bubble. */
  minimumSpawnDistance: 58,
  maximumSpawnDistance: 152,
  /** Cruising actors beyond this radius are no longer contributing to the scene. */
  recycleBeyondDistance: 178,
  minimumVehicleSpacing: 9,
});

export const TRAFFIC_LOCAL_AVOIDANCE = Object.freeze({
  minimumCenterDistance: 2.4,
  followingLateralTolerance: 2.2,
  maximumNeighborDistance: 42,
  predictionSeconds: 3.2,
  conflictDistance: 3.6,
  brakingMetersPerSecondSquared: 9,
  maximumIntersectionWaitSeconds: 0.6,
  intersectionPrioritySeconds: 2,
  intersectionCreepSpeed: 1.2,
  intersectionStopDistance: 3.4,
  transitionAbandonSeconds: 1.4,
  pairPasses: 2,
  collisionPasses: 3,
});

/** Fixed-pool ceiling for predictive and contact vehicle-to-vehicle work on one tick. */
export const TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK = (
  TRAFFIC_CAPACITY.high
  * (TRAFFIC_CAPACITY.high - 1)
  / 2
  * (
    TRAFFIC_LOCAL_AVOIDANCE.pairPasses
    + TRAFFIC_LOCAL_AVOIDANCE.collisionPasses
    + 1
  )
  + TRAFFIC_CAPACITY.high
);

/** External/player contact resolution checks each fixed ambient slot at most twice. */
export const TRAFFIC_EXTERNAL_COLLISION_PAIR_BUDGET_PER_CALL = (
  TRAFFIC_CAPACITY.high * 2
);

export interface TrafficAvoidanceDiagnostics {
  readonly lastTickPairChecks: number;
  readonly lastTickCollisionResolutions: number;
}

interface TrafficAgent {
  id: string;
  classId: VehicleClassId;
  active: boolean;
  hasActivated: boolean;
  position: SimulationVec3;
  heading: number;
  speed: number;
  cruiseSpeed: number;
  behavior: TrafficBehavior;
  roadIndex: number;
  laneOffset: number;
  direction: 1 | -1;
  blockedSeconds: number;
  recoveryRemaining: number;
  recoveryAttempts: number;
  panicRemaining: number;
  intersectionWaitSeconds: number;
  intersectionPriorityRemaining: number;
  intersectionTicket: number;
  transitionWaitSeconds: number;
  routeStep: number;
  lastJunction: TrafficRoadJunction | null;
  plannedTransition: PlannedRoadTransition | null;
  collisionRadius: number;
  signalSpeedCap: number;
  signalPriority: -1 | 0 | 1;
  permissiveLeftYield: boolean;
}

interface TrafficRoadJunction {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly roadIndices: readonly number[];
}

type RoadTransitionKind = 'continue' | 'left' | 'right';

interface RoadTransitionOption {
  readonly roadIndex: number;
  readonly direction: 1 | -1;
  readonly kind: RoadTransitionKind;
}

interface PlannedRoadTransition extends RoadTransitionOption {
  readonly junction: TrafficRoadJunction;
  /** Signed distance ahead of the junction center at which lane centers meet. */
  readonly triggerAhead: number;
}

interface SweptCircleContact {
  readonly time: number;
  readonly normalX: number;
  readonly normalZ: number;
}

export interface TrafficTickContext {
  deltaSeconds: number;
  playerPosition?: SimulationVec3;
  externalVehicle?: Readonly<ExternalTrafficVehicleState> | null;
  sirenPosition: SimulationVec3 | null;
  sirenRadius: number;
  obstructions: readonly SimulationObstacle[];
}

const DEFAULT_ROADS: readonly SimulationRoadRecipe[] = [
  { id: 'fallback-east-west-a', position: { x: 0, y: 0, z: -60 }, width: 480, depth: 18, major: true },
  { id: 'fallback-east-west-b', position: { x: 0, y: 0, z: 60 }, width: 480, depth: 18 },
  { id: 'fallback-north-south-a', position: { x: -60, y: 0, z: 0 }, width: 18, depth: 480, major: true },
  { id: 'fallback-north-south-b', position: { x: 60, y: 0, z: 0 }, width: 18, depth: 480 },
];

const JUNCTION_DECISION_DISTANCE = 16;
const JUNCTION_RELEASE_DISTANCE = 22;
const JUNCTION_EPSILON = 0.001;
const LANE_ALIGNMENT_METERS_PER_SECOND = 6;
const ROUTE_TURN_PROBABILITY = 0.38;
const RELEVANCE_REFRESH_SECONDS = 0.5;
const RELEVANCE_REBASE_DISTANCE = 42;
const JUNCTION_SPAWN_CLEARANCE = 12;
const PLACEMENT_ATTEMPTS_PER_ROAD = 4;
const CONTACT_EPSILON = 0.01;
const DEFAULT_EXTERNAL_COLLISION_RADIUS = 1.35;
const SIGNAL_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED = 6.5;
const SIGNAL_YELLOW_REACTION_SECONDS = 0.65;
const OBSTACLE_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED = 3.2;

function normalizedContactNormal(
  deltaX: number,
  deltaZ: number,
  fallbackHeading: number,
  deterministicSign: 1 | -1,
): { readonly x: number; readonly z: number } {
  const length = Math.hypot(deltaX, deltaZ);
  if (length > 0.000001) {
    return { x: deltaX / length, z: deltaZ / length };
  }
  const direction = directionFromHeading(fallbackHeading);
  return { x: direction.x * deterministicSign, z: direction.z * deterministicSign };
}

function sweptCircleContact(
  startDeltaX: number,
  startDeltaZ: number,
  endDeltaX: number,
  endDeltaZ: number,
  minimumDistance: number,
  fallbackHeading: number,
  deterministicSign: 1 | -1,
): SweptCircleContact | null {
  const minimumDistanceSquared = minimumDistance * minimumDistance;
  const startDistanceSquared = startDeltaX * startDeltaX + startDeltaZ * startDeltaZ;
  const endDistanceSquared = endDeltaX * endDeltaX + endDeltaZ * endDeltaZ;
  const relativeDeltaX = endDeltaX - startDeltaX;
  const relativeDeltaZ = endDeltaZ - startDeltaZ;
  const quadraticA = relativeDeltaX * relativeDeltaX + relativeDeltaZ * relativeDeltaZ;
  if (
    startDistanceSquared >= minimumDistanceSquared
    && quadraticA > 0.0000001
  ) {
    const quadraticB = 2 * (
      startDeltaX * relativeDeltaX
      + startDeltaZ * relativeDeltaZ
    );
    const quadraticC = startDistanceSquared - minimumDistanceSquared;
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
    if (discriminant >= 0) {
      const entryTime = (-quadraticB - Math.sqrt(discriminant)) / (2 * quadraticA);
      if (entryTime >= 0 && entryTime <= 1) {
        const contactDeltaX = startDeltaX + relativeDeltaX * entryTime;
        const contactDeltaZ = startDeltaZ + relativeDeltaZ * entryTime;
        const normal = normalizedContactNormal(
          contactDeltaX,
          contactDeltaZ,
          fallbackHeading,
          deterministicSign,
        );
        return { time: entryTime, normalX: normal.x, normalZ: normal.z };
      }
    }
  }

  if (endDistanceSquared < minimumDistanceSquared) {
    // Existing overlaps and numerical edge cases still need deterministic
    // endpoint separation, but a separated start always takes the swept entry
    // above so center-crossing impacts remain on their starting side.
    const normal = normalizedContactNormal(
      endDeltaX,
      endDeltaZ,
      fallbackHeading,
      deterministicSign,
    );
    return { time: 1, normalX: normal.x, normalZ: normal.z };
  }

  // The pair began overlapped and separated during this step; do not rewind it.
  return null;
}

function normalizedRoads(roads: readonly SimulationRoadRecipe[] | undefined): readonly SimulationRoadRecipe[] {
  const valid = roads?.filter((road) => road.width > 2 && road.depth > 2) ?? [];
  const normalized = (valid.length > 0 ? valid : DEFAULT_ROADS)
    .map((road) => ({ ...road, position: { ...road.position } }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error('Traffic roads require unique ids');
  }
  return normalized;
}

function roadIsVertical(road: SimulationRoadRecipe): boolean {
  return road.depth > road.width;
}

function roadHeading(road: SimulationRoadRecipe, direction: 1 | -1): number {
  if (roadIsVertical(road)) {
    return headingFromDirection(0, direction);
  }
  return headingFromDirection(direction, 0);
}

function districtForRoad(road: Readonly<SimulationRoadRecipe>): DistrictId {
  if (road.district) {
    return road.district;
  }
  if (road.position.x < 0) {
    return road.position.z < 0 ? 'neon-strand' : 'arroyo-heights';
  }
  return road.position.z < 0 ? 'alta-vista' : 'breakwater';
}

export function chooseTrafficVehicleClass(
  random: SimulationRandom,
  district: DistrictId,
): VehicleClassId {
  const totalWeight = VEHICLES.reduce(
    (total, vehicle) => total + vehicle.trafficWeightByDistrict[district],
    0,
  );
  let remaining = random.next() * totalWeight;
  for (const vehicle of VEHICLES) {
    remaining -= vehicle.trafficWeightByDistrict[district];
    if (remaining < 0) {
      return vehicle.id;
    }
  }
  return VEHICLES[VEHICLES.length - 1]?.id ?? 'compact';
}

function distanceAhead(
  agent: Readonly<TrafficAgent>,
  point: Readonly<SimulationVec3>,
): number {
  const direction = directionFromHeading(agent.heading);
  return (point.x - agent.position.x) * direction.x
    + (point.z - agent.position.z) * direction.z;
}

function roadLength(road: Readonly<SimulationRoadRecipe>): number {
  return roadIsVertical(road) ? road.depth : road.width;
}

function roadAlongCoordinate(
  road: Readonly<SimulationRoadRecipe>,
  position: Readonly<SimulationVec3>,
): number {
  return roadIsVertical(road) ? position.z : position.x;
}

function roadCenterAlongCoordinate(road: Readonly<SimulationRoadRecipe>): number {
  return roadIsVertical(road) ? road.position.z : road.position.x;
}

function laneOffsetMagnitude(road: Readonly<SimulationRoadRecipe>): number {
  const narrowSize = roadIsVertical(road) ? road.width : road.depth;
  return Math.max(0.35, Math.min(Math.max(1.7, narrowSize * 0.23), narrowSize / 2 - 0.5));
}

/** Coordinate offset from a road centerline for right-hand traffic. */
function laneOffsetForRoad(
  road: Readonly<SimulationRoadRecipe>,
  direction: 1 | -1,
): number {
  const magnitude = laneOffsetMagnitude(road);
  return roadIsVertical(road) ? -direction * magnitude : direction * magnitude;
}

function roadExtendsFromJunction(
  road: Readonly<SimulationRoadRecipe>,
  junction: Readonly<TrafficRoadJunction>,
  direction: 1 | -1,
): boolean {
  const directedEnd = roadCenterAlongCoordinate(road) + direction * roadLength(road) / 2;
  const junctionAlong = roadAlongCoordinate(road, junction.position);
  return (directedEnd - junctionAlong) * direction > JUNCTION_EPSILON;
}

function junctionIsDirectedRoadEnd(
  road: Readonly<SimulationRoadRecipe>,
  junction: Readonly<TrafficRoadJunction>,
  direction: 1 | -1,
): boolean {
  const directedEnd = roadCenterAlongCoordinate(road) + direction * roadLength(road) / 2;
  return Math.abs(roadAlongCoordinate(road, junction.position) - directedEnd) <= JUNCTION_EPSILON;
}

function rightTurnDirection(
  currentRoad: Readonly<SimulationRoadRecipe>,
  currentDirection: 1 | -1,
): 1 | -1 {
  // With +x east and +z south in the scene, a right turn from a vertical road
  // reverses the scalar axis direction; a right turn from a horizontal road keeps it.
  return roadIsVertical(currentRoad) ? currentDirection === 1 ? -1 : 1 : currentDirection;
}

function buildTrafficJunctions(
  roads: readonly SimulationRoadRecipe[],
): readonly (readonly TrafficRoadJunction[])[] {
  const roadIndexById = new Map(roads.map((road, index) => [road.id, index]));
  const graph = buildRoadGraph({
    roads: roads.map((road) => ({
      ...road,
      district: road.district ?? districtForRoad(road),
      major: Boolean(road.major),
    })),
  });
  const junctions = graph.nodes.map((node): TrafficRoadJunction => ({
    id: node.id,
    position: { x: node.position.x, y: 0, z: node.position.z },
    roadIndices: node.roadIds
      .map((roadId) => roadIndexById.get(roadId))
      .filter((index): index is number => index !== undefined)
      .sort((left, right) => left - right),
  }));
  const byRoad: TrafficRoadJunction[][] = Array.from({ length: roads.length }, () => []);
  for (const junction of junctions) {
    for (const roadIndex of junction.roadIndices) {
      byRoad[roadIndex]?.push(junction);
    }
  }
  for (const [roadIndex, roadJunctions] of byRoad.entries()) {
    const road = roads[roadIndex];
    if (!road) continue;
    roadJunctions.sort((left, right) => {
      const difference = roadAlongCoordinate(road, left.position)
        - roadAlongCoordinate(road, right.position);
      return Math.abs(difference) > JUNCTION_EPSILON
        ? difference
        : left.id.localeCompare(right.id);
    });
  }
  return byRoad;
}

export class TrafficSystem {
  public readonly roads: readonly SimulationRoadRecipe[];

  private readonly random: SimulationRandom;
  private readonly agents: TrafficAgent[];
  private readonly junctionsByRoad: readonly (readonly TrafficRoadJunction[])[];
  private readonly signals: TrafficSignalSystem;
  private readonly signalJunctionIds: ReadonlySet<string>;
  private quality: SimulationQuality;
  private requestedActorLimit = TRAFFIC_CAPACITY.high;
  private relevanceAnchor: SimulationVec3 | null = null;
  private relevanceRefreshElapsed = Number.POSITIVE_INFINITY;
  private readonly peerSpeedCaps = new Float64Array(TRAFFIC_CAPACITY.high);
  private readonly peerYieldKinds = new Uint8Array(TRAFFIC_CAPACITY.high);
  private readonly nearestConflictDistances = new Float64Array(TRAFFIC_CAPACITY.high);
  private readonly previousPositionX = new Float64Array(TRAFFIC_CAPACITY.high);
  private readonly previousPositionZ = new Float64Array(TRAFFIC_CAPACITY.high);
  private previousPositionsValid = false;
  private lastTickPairChecks = 0;
  private lastTickCollisionResolutions = 0;
  private nextIntersectionTicket = 1;

  public constructor(
    random: SimulationRandom,
    quality: SimulationQuality,
    roads?: readonly SimulationRoadRecipe[],
  ) {
    this.random = random;
    this.quality = quality;
    this.roads = normalizedRoads(roads);
    this.junctionsByRoad = buildTrafficJunctions(this.roads);
    this.signals = new TrafficSignalSystem(this.roads);
    this.signalJunctionIds = new Set(
      this.signals.getSnapshot().junctions.map(({ id }) => id),
    );
    this.agents = Array.from({ length: TRAFFIC_CAPACITY.high }, (_, index) => this.createAgent(index));
    this.applyActiveCount();
  }

  public setQuality(quality: SimulationQuality): void {
    this.quality = quality;
    this.applyActiveCount();
  }

  public setActorLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('traffic actor limit must be a non-negative safe integer');
    }
    this.requestedActorLimit = Math.min(limit, TRAFFIC_CAPACITY.high);
    this.applyActiveCount();
    return this.getActorLimit();
  }

  public getActorLimit(): number {
    return Math.min(this.requestedActorLimit, TRAFFIC_CAPACITY[this.quality]);
  }

  public getAvoidanceDiagnostics(): TrafficAvoidanceDiagnostics {
    return {
      lastTickPairChecks: this.lastTickPairChecks,
      lastTickCollisionResolutions: this.lastTickCollisionResolutions,
    };
  }

  public getTrafficSignalSnapshot(): TrafficSignalSystemSnapshot {
    return this.signals.getSnapshot();
  }

  public triggerPanic(position: Readonly<SimulationVec3>, radius: number, duration: number): void {
    for (const agent of this.agents) {
      if (agent.active && distance2d(agent.position, position) <= radius) {
        agent.panicRemaining = Math.max(agent.panicRemaining, duration);
      }
    }
  }

  public tick(context: TrafficTickContext): void {
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    this.signals.tick(dt);
    if (context.playerPosition && this.isFinitePosition(context.playerPosition)) {
      this.maintainPlayerRelevance(context.playerPosition, dt);
    }
    this.capturePreviousPositions();
    this.prepareSignalControls(dt);
    this.prepareLocalAvoidance(dt, context.externalVehicle);
    for (const [agentIndex, agent] of this.agents.entries()) {
      if (!agent.active) {
        this.tickInactiveAgent(agent, dt);
        continue;
      }

      agent.panicRemaining = Math.max(0, agent.panicRemaining - dt);
      agent.intersectionPriorityRemaining = Math.max(
        0,
        agent.intersectionPriorityRemaining - dt,
      );
      if (agent.intersectionPriorityRemaining <= 0) agent.intersectionTicket = 0;
      if (agent.behavior === 'recover') {
        agent.recoveryRemaining -= dt;
        agent.speed = moveTowards(agent.speed, -2.4, 9 * dt);
        this.advanceAgent(agent, dt, false);
        if (agent.recoveryRemaining <= 0) {
          this.finishLocalRecovery(agent);
        }
        continue;
      }

      const sirenNearby = context.sirenPosition !== null
        && distance2d(agent.position, context.sirenPosition) <= context.sirenRadius;
      const obstacleSpeedCap = this.obstacleSpeedCap(agent, context.obstructions);
      const obstacleYield = Number.isFinite(obstacleSpeedCap)
        && obstacleSpeedCap < agent.cruiseSpeed;
      const obstacleBlocked = obstacleSpeedCap <= 0.15;
      const peerYieldKind = this.peerYieldKinds[agentIndex] ?? 0;
      const intersectionYield = !obstacleYield && (peerYieldKind & 2) !== 0;
      const followingYield = (peerYieldKind & 1) !== 0;
      const signalYield = agent.signalPriority < 0;
      const peerSpeedCap = this.peerSpeedCaps[agentIndex] ?? Number.POSITIVE_INFINITY;

      let targetSpeed = agent.cruiseSpeed;
      if (agent.panicRemaining > 0) {
        agent.behavior = 'panic';
        targetSpeed *= 1.32;
        agent.blockedSeconds = 0;
        agent.intersectionWaitSeconds = 0;
      } else if (sirenNearby) {
        agent.behavior = 'siren-yield';
        targetSpeed = Math.min(1.5, agent.signalSpeedCap, obstacleSpeedCap, peerSpeedCap);
        agent.blockedSeconds = 0;
        agent.intersectionWaitSeconds = Math.max(0, agent.intersectionWaitSeconds - dt * 2);
      } else if (signalYield || obstacleYield || intersectionYield || followingYield) {
        const intersectionSpeedCap = intersectionYield
          ? (this.nearestConflictDistances[agentIndex]
              ?? Number.POSITIVE_INFINITY) > TRAFFIC_LOCAL_AVOIDANCE.intersectionStopDistance
            ? TRAFFIC_LOCAL_AVOIDANCE.intersectionCreepSpeed
            : 0
          : Number.POSITIVE_INFINITY;
        targetSpeed = Math.min(
          targetSpeed,
          agent.signalSpeedCap,
          obstacleSpeedCap,
          peerSpeedCap,
          intersectionSpeedCap,
        );
        agent.behavior = signalYield
          ? 'signal-yield'
          : intersectionYield
            ? 'intersection-yield'
            : 'yield';
        agent.blockedSeconds = obstacleBlocked
          ? agent.blockedSeconds + dt
          : Math.max(0, agent.blockedSeconds - dt * 2);
      const canRequestIntersectionPriority = intersectionYield
          && !followingYield
          && !signalYield
          || agent.permissiveLeftYield;
        agent.intersectionWaitSeconds = canRequestIntersectionPriority
          ? agent.intersectionWaitSeconds + dt
          : Math.max(0, agent.intersectionWaitSeconds - dt * 2);
        if (
          canRequestIntersectionPriority
          && agent.intersectionWaitSeconds
            >= TRAFFIC_LOCAL_AVOIDANCE.maximumIntersectionWaitSeconds
        ) {
          agent.intersectionPriorityRemaining = Math.max(
            agent.intersectionPriorityRemaining,
            TRAFFIC_LOCAL_AVOIDANCE.intersectionPrioritySeconds,
          );
          if (agent.intersectionTicket === 0) {
            agent.intersectionTicket = this.nextIntersectionTicket;
            this.nextIntersectionTicket += 1;
          }
          agent.intersectionWaitSeconds = 0;
        }
      } else {
        agent.behavior = 'cruise';
        agent.blockedSeconds = Math.max(0, agent.blockedSeconds - dt * 2);
        agent.intersectionWaitSeconds = Math.max(0, agent.intersectionWaitSeconds - dt * 2);
        agent.recoveryAttempts = Math.max(0, agent.recoveryAttempts - dt);
      }

      if (agent.blockedSeconds > 1.5) {
        agent.behavior = 'recover';
        agent.recoveryRemaining = 0.8;
        agent.recoveryAttempts += 1;
        agent.blockedSeconds = 0;
        continue;
      }

      const acceleration = targetSpeed > agent.speed ? 5.5 : 9;
      agent.speed = moveTowards(agent.speed, targetSpeed, acceleration * dt);
      agent.speed = Math.min(
        agent.speed,
        Math.max(0, peerSpeedCap),
        Math.max(0, agent.signalSpeedCap),
      );
      this.advanceAgent(agent, dt, true);
    }
    this.resolveVehicleCollisions();
  }

  /**
   * Adaptive limits hide pooled vehicles, but their short-lived behavior
   * clocks must keep advancing so a restored slot cannot resurrect stale
   * panic or recovery state.
   */
  private tickInactiveAgent(agent: TrafficAgent, deltaSeconds: number): void {
    agent.panicRemaining = Math.max(0, agent.panicRemaining - deltaSeconds);
    agent.intersectionWaitSeconds = Math.max(
      0,
      agent.intersectionWaitSeconds - deltaSeconds,
    );
    agent.intersectionPriorityRemaining = Math.max(
      0,
      agent.intersectionPriorityRemaining - deltaSeconds,
    );
    if (agent.intersectionPriorityRemaining <= 0) agent.intersectionTicket = 0;
    if (agent.behavior === 'recover') {
      agent.recoveryRemaining -= deltaSeconds;
      if (agent.recoveryRemaining > 0) return;
      this.finishLocalRecovery(agent);
    }
    if (agent.panicRemaining > 0) {
      agent.behavior = 'panic';
      agent.blockedSeconds = 0;
      return;
    }
    if (agent.behavior !== 'cruise') {
      agent.behavior = 'cruise';
      agent.blockedSeconds = 0;
      agent.recoveryRemaining = 0;
      agent.speed = Math.min(Math.max(0, agent.speed), agent.cruiseSpeed);
    }
  }

  public getSnapshot(): readonly TrafficVehicleSnapshot[] {
    return this.agents
      .filter((agent) => agent.active)
      .map((agent) => this.snapshotFor(agent));
  }

  /**
   * Hands an ambient vehicle to the player and immediately recycles its pooled
   * traffic actor onto another road, preserving the fixed population budget.
   */
  public claimVehicle(id: string): TrafficVehicleSnapshot | null {
    const agent = this.agents.find((candidate) => candidate.active && candidate.id === id);
    if (!agent) {
      return null;
    }
    const claimed = this.snapshotFor(agent);
    this.recycleAgent(agent);
    return claimed;
  }

  /**
   * Resolves a player or other externally simulated vehicle against the fixed
   * ambient pool. The returned transform/velocities belong to the caller,
   * while equal-and-opposite contact response is applied to ambient agents.
   */
  public resolveExternalVehicleCollision(
    state: Readonly<ExternalTrafficVehicleState>,
  ): ExternalTrafficCollisionResult {
    if (
      !this.isFinitePosition(state.position)
      || (state.previousPosition && !this.isFinitePosition(state.previousPosition))
      || !Number.isFinite(state.heading)
      || !Number.isFinite(state.speed)
      || (state.lateralSpeed !== undefined && !Number.isFinite(state.lateralSpeed))
    ) {
      throw new RangeError('external traffic vehicle state must be finite');
    }
    const radius = state.radius ?? DEFAULT_EXTERNAL_COLLISION_RADIUS;
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new RangeError('external traffic vehicle radius must be finite and positive');
    }

    const previous = state.previousPosition ?? state.position;
    const position: SimulationVec3 = { ...state.position };
    let speed = state.speed;
    let lateralSpeed = state.lateralSpeed ?? 0;
    let impactSpeed = 0;
    let impactNormal: { readonly x: number; readonly z: number } | null = null;
    let primaryAmbientVehicleId: string | null = null;
    let pairChecks = 0;
    const ambientVehicleIds = new Set<string>();

    for (let pass = 0; pass < 2; pass += 1) {
      let contactsThisPass = 0;
      for (const [agentIndex, agent] of this.agents.entries()) {
        if (!agent.active) continue;
        pairChecks += 1;
        const minimumDistance = radius + agent.collisionRadius;
        const canSweep = pass === 0 && this.previousPositionsValid;
        const startDeltaX = canSweep
          ? (this.previousPositionX[agentIndex] ?? agent.position.x) - previous.x
          : agent.position.x - position.x;
        const startDeltaZ = canSweep
          ? (this.previousPositionZ[agentIndex] ?? agent.position.z) - previous.z
          : agent.position.z - position.z;
        const endDeltaX = agent.position.x - position.x;
        const endDeltaZ = agent.position.z - position.z;
        const contact = sweptCircleContact(
          startDeltaX,
          startDeltaZ,
          endDeltaX,
          endDeltaZ,
          minimumDistance,
          state.heading,
          agent.id < 'external-vehicle' ? -1 : 1,
        );
        if (!contact) continue;
        contactsThisPass += 1;
        if (primaryAmbientVehicleId === null) {
          primaryAmbientVehicleId = agent.id;
          impactNormal = { x: contact.normalX, z: contact.normalZ };
        }

        if (canSweep && contact.time < 1) {
          position.x = previous.x + (position.x - previous.x) * contact.time;
          position.z = previous.z + (position.z - previous.z) * contact.time;
          const priorAgentX = this.previousPositionX[agentIndex] ?? agent.position.x;
          const priorAgentZ = this.previousPositionZ[agentIndex] ?? agent.position.z;
          agent.position.x = priorAgentX
            + (agent.position.x - priorAgentX) * contact.time;
          agent.position.z = priorAgentZ
            + (agent.position.z - priorAgentZ) * contact.time;
        }

        const currentDeltaX = agent.position.x - position.x;
        const currentDeltaZ = agent.position.z - position.z;
        const currentDistance = Math.hypot(currentDeltaX, currentDeltaZ);
        const correction = Math.max(
          CONTACT_EPSILON,
          minimumDistance + CONTACT_EPSILON - currentDistance,
        ) / 2;
        position.x -= contact.normalX * correction;
        position.z -= contact.normalZ * correction;
        agent.position.x += contact.normalX * correction;
        agent.position.z += contact.normalZ * correction;

        const externalForward = directionFromHeading(state.heading);
        const externalRightX = -externalForward.z;
        const externalRightZ = externalForward.x;
        const externalVelocityX = externalForward.x * speed
          + externalRightX * lateralSpeed;
        const externalVelocityZ = externalForward.z * speed
          + externalRightZ * lateralSpeed;
        const ambientForward = directionFromHeading(agent.heading);
        const ambientVelocityX = ambientForward.x * agent.speed;
        const ambientVelocityZ = ambientForward.z * agent.speed;
        const relativeNormalVelocity = (
          ambientVelocityX - externalVelocityX
        ) * contact.normalX + (
          ambientVelocityZ - externalVelocityZ
        ) * contact.normalZ;
        const closingSpeed = Math.max(0, -relativeNormalVelocity);
        if (closingSpeed > 0.05) {
          const impulse = closingSpeed * 0.54;
          const resolvedExternalX = externalVelocityX - impulse * contact.normalX;
          const resolvedExternalZ = externalVelocityZ - impulse * contact.normalZ;
          const resolvedAmbientX = ambientVelocityX + impulse * contact.normalX;
          const resolvedAmbientZ = ambientVelocityZ + impulse * contact.normalZ;
          speed = resolvedExternalX * externalForward.x
            + resolvedExternalZ * externalForward.z;
          lateralSpeed = resolvedExternalX * externalRightX
            + resolvedExternalZ * externalRightZ;
          agent.speed = Math.max(
            -2.4,
            Math.min(
              agent.cruiseSpeed * 1.08,
              resolvedAmbientX * ambientForward.x
                + resolvedAmbientZ * ambientForward.z,
            ),
          );
          if (
            closingSpeed > impactSpeed + 0.000001
            || (
              Math.abs(closingSpeed - impactSpeed) <= 0.000001
              && agent.id < (primaryAmbientVehicleId ?? agent.id)
            )
          ) {
            impactSpeed = closingSpeed;
            impactNormal = { x: contact.normalX, z: contact.normalZ };
            primaryAmbientVehicleId = agent.id;
          }
        }
        ambientVehicleIds.add(agent.id);
      }
      if (contactsThisPass === 0) break;
    }
    for (const [agentIndex, agent] of this.agents.entries()) {
      if (!ambientVehicleIds.has(agent.id)) continue;
      this.previousPositionX[agentIndex] = agent.position.x;
      this.previousPositionZ[agentIndex] = agent.position.z;
    }

    return {
      collided: ambientVehicleIds.size > 0,
      position,
      speed,
      lateralSpeed,
      impactSpeed,
      impactNormal,
      primaryAmbientVehicleId,
      ambientVehicleIds: [...ambientVehicleIds],
      pairChecks,
    };
  }

  private createAgent(index: number): TrafficAgent {
    const roadIndex = index % this.roads.length;
    const road = this.roads[roadIndex];
    if (!road) {
      throw new Error('Traffic pool requires at least one road');
    }
    const agent: TrafficAgent = {
      id: `traffic-${index.toString().padStart(2, '0')}`,
      classId: 'compact',
      active: false,
      hasActivated: false,
      position: { x: 0, y: 0, z: 0 },
      heading: 0,
      speed: 0,
      cruiseSpeed: this.random.range(7.5, 13.5),
      behavior: 'cruise',
      roadIndex,
      laneOffset: 0,
      direction: this.random.next() > 0.5 ? 1 : -1,
      blockedSeconds: 0,
      recoveryRemaining: 0,
      recoveryAttempts: 0,
      panicRemaining: 0,
      intersectionWaitSeconds: 0,
      intersectionPriorityRemaining: 0,
      intersectionTicket: 0,
      transitionWaitSeconds: 0,
      routeStep: 0,
      lastJunction: null,
      plannedTransition: null,
      collisionRadius: VEHICLES[0]?.arcadeHandling.collisionRadiusMeters ?? 1.48,
      signalSpeedCap: Number.POSITIVE_INFINITY,
      signalPriority: 0,
      permissiveLeftYield: false,
    };
    this.placeOnRoad(agent, this.random.range(-0.48, 0.48));
    this.assignVehicleClass(agent);
    return agent;
  }

  private snapshotFor(agent: Readonly<TrafficAgent>): TrafficVehicleSnapshot {
    return {
      id: agent.id,
      classId: agent.classId,
      position: { ...agent.position },
      heading: agent.heading,
      speed: agent.speed,
      behavior: agent.behavior,
      roadId: this.roadFor(agent).id,
      panicRemaining: agent.panicRemaining,
    };
  }

  private applyActiveCount(): void {
    const count = this.getActorLimit();
    this.agents.forEach((agent, index) => {
      const shouldBeActive = index < count;
      if (shouldBeActive && !agent.active) {
        agent.active = true;
        if (
          this.relevanceAnchor
          && agent.behavior === 'cruise'
          && agent.panicRemaining <= 0
          && agent.recoveryRemaining <= 0
          && this.placeAgentNearPlayer(agent, this.relevanceAnchor)
        ) {
          agent.hasActivated = true;
        } else if (!agent.hasActivated) {
          agent.hasActivated = true;
          agent.speed = this.random.range(1, agent.cruiseSpeed * 0.65);
          this.placeOnRoad(agent, this.random.range(-0.48, 0.48));
        }
      } else if (!shouldBeActive) {
        agent.active = false;
      }
    });
  }

  private roadFor(agent: Pick<TrafficAgent, 'roadIndex'>): SimulationRoadRecipe {
    const road = this.roads[agent.roadIndex];
    if (!road) {
      throw new Error('Traffic agent references a missing road');
    }
    return road;
  }

  private placeOnRoad(agent: TrafficAgent, normalizedAlong: number): void {
    const road = this.roadFor(agent);
    const vertical = roadIsVertical(road);
    agent.laneOffset = laneOffsetForRoad(road, agent.direction);
    if (vertical) {
      agent.position.x = road.position.x + agent.laneOffset;
      agent.position.z = road.position.z + normalizedAlong * road.depth;
    } else {
      agent.position.x = road.position.x + normalizedAlong * road.width;
      agent.position.z = road.position.z + agent.laneOffset;
    }
    agent.position.y = 0;
    agent.heading = roadHeading(road, agent.direction);
  }

  private advanceAgent(
    agent: TrafficAgent,
    deltaSeconds: number,
    allowTransitions: boolean,
  ): void {
    const travelDistance = agent.speed * deltaSeconds;
    if (!allowTransitions || travelDistance <= 0) {
      this.moveAgent(agent, travelDistance);
      this.keepAgentOnRoad(agent);
      this.alignAgentToLane(agent, deltaSeconds);
      return;
    }

    this.releasePassedJunction(agent);
    this.planUpcomingTransition(agent);
    const transition = agent.plannedTransition;
    if (transition !== null) {
      const ahead = distanceAhead(agent, transition.junction.position);
      const distanceToTransition = ahead - transition.triggerAhead;
      if (distanceToTransition <= travelDistance + JUNCTION_EPSILON) {
        const beforeTransition = Math.max(0, distanceToTransition);
        const afterTransition = Math.max(0, travelDistance - beforeTransition);
        this.moveAgent(agent, beforeTransition);
        if (!this.applyRoadTransition(agent, transition, afterTransition)) {
          agent.speed = 0;
          agent.behavior = 'intersection-yield';
          agent.blockedSeconds = 0;
          agent.transitionWaitSeconds += deltaSeconds;
          if (
            agent.transitionWaitSeconds
              >= TRAFFIC_LOCAL_AVOIDANCE.transitionAbandonSeconds
          ) {
            agent.plannedTransition = null;
            agent.lastJunction = transition.junction;
            agent.transitionWaitSeconds = 0;
          }
          this.keepAgentOnRoad(agent);
          this.alignAgentToLane(agent, deltaSeconds);
          return;
        }
        this.moveAgent(agent, afterTransition);
        this.keepAgentOnRoad(agent);
        this.alignAgentToLane(agent, deltaSeconds);
        return;
      }
    }

    this.moveAgent(agent, travelDistance);
    this.keepAgentOnRoad(agent);
    this.alignAgentToLane(agent, deltaSeconds);
  }

  private moveAgent(agent: TrafficAgent, distance: number): void {
    const direction = directionFromHeading(agent.heading);
    agent.position.x += direction.x * distance;
    agent.position.z += direction.z * distance;
  }

  private releasePassedJunction(agent: TrafficAgent): void {
    if (
      agent.lastJunction !== null
      && distance2d(agent.position, agent.lastJunction.position) > JUNCTION_RELEASE_DISTANCE
    ) {
      agent.lastJunction = null;
    }
  }

  private planUpcomingTransition(agent: TrafficAgent): void {
    if (agent.plannedTransition !== null) return;
    const road = this.roadFor(agent);
    const junction = (this.junctionsByRoad[agent.roadIndex] ?? [])
      .filter((candidate) => candidate !== agent.lastJunction)
      .map((candidate) => ({ candidate, ahead: distanceAhead(agent, candidate.position) }))
      .filter(({ ahead }) => ahead >= -JUNCTION_EPSILON && ahead <= JUNCTION_DECISION_DISTANCE)
      .sort((left, right) => {
        const difference = left.ahead - right.ahead;
        return Math.abs(difference) > JUNCTION_EPSILON
          ? difference
          : left.candidate.id.localeCompare(right.candidate.id);
      })[0]?.candidate;
    if (!junction) return;

    const decisionRandom = new SimulationRandom([
      agent.id,
      agent.cruiseSpeed.toFixed(6),
      agent.routeStep,
      road.id,
      junction.id,
    ].join(':'));
    agent.routeStep += 1;
    const atRoadEnd = junctionIsDirectedRoadEnd(road, junction, agent.direction);
    const continuations = this.continuationOptions(agent, junction);
    if (atRoadEnd && continuations.length > 0) {
      this.setPlannedTransition(agent, junction, decisionRandom.pick(continuations));
      return;
    }

    const turns = this.turnOptions(agent, junction);
    if (atRoadEnd && turns.length > 0) {
      const rightTurns = turns.filter(({ kind }) => kind === 'right');
      const selected = decisionRandom.pick(rightTurns.length > 0 ? rightTurns : turns);
      if (selected.kind === 'right') {
        this.setPlannedTransition(agent, junction, selected);
      } else {
        // A terminating T-junction may only offer a left exit. Turn at the
        // node rather than waiting for a lane connector beyond the road end.
        this.setPlannedTransition(agent, junction, selected, 0);
      }
      return;
    }

    if (!atRoadEnd && turns.length > 0 && decisionRandom.next() < ROUTE_TURN_PROBABILITY) {
      this.setPlannedTransition(agent, junction, decisionRandom.pick(turns));
      return;
    }

    // Continue through this node on the current road. Remembering the node
    // prevents repeated route decisions while its turn envelope is crossed.
    agent.lastJunction = junction;
  }

  private continuationOptions(
    agent: Readonly<TrafficAgent>,
    junction: Readonly<TrafficRoadJunction>,
  ): readonly RoadTransitionOption[] {
    const currentRoad = this.roadFor(agent);
    return junction.roadIndices
      .filter((roadIndex) => roadIndex !== agent.roadIndex)
      .map((roadIndex) => ({ roadIndex, road: this.roads[roadIndex] }))
      .filter((candidate): candidate is { roadIndex: number; road: SimulationRoadRecipe } =>
        candidate.road !== undefined
        && roadIsVertical(candidate.road) === roadIsVertical(currentRoad)
        && roadExtendsFromJunction(candidate.road, junction, agent.direction))
      .map(({ roadIndex }) => ({ roadIndex, direction: agent.direction, kind: 'continue' as const }))
      .sort((left, right) => left.roadIndex - right.roadIndex);
  }

  private turnOptions(
    agent: Readonly<TrafficAgent>,
    junction: Readonly<TrafficRoadJunction>,
  ): readonly RoadTransitionOption[] {
    const currentRoad = this.roadFor(agent);
    const rightDirection = rightTurnDirection(currentRoad, agent.direction);
    const options: RoadTransitionOption[] = [];
    for (const roadIndex of junction.roadIndices) {
      if (roadIndex === agent.roadIndex) continue;
      const road = this.roads[roadIndex];
      if (!road || roadIsVertical(road) === roadIsVertical(currentRoad)) continue;
      if (roadExtendsFromJunction(road, junction, rightDirection)) {
        options.push({ roadIndex, direction: rightDirection, kind: 'right' });
      }
      const leftDirection = rightDirection === 1 ? -1 : 1;
      if (roadExtendsFromJunction(road, junction, leftDirection)) {
        options.push({ roadIndex, direction: leftDirection, kind: 'left' });
      }
    }
    return options.sort((left, right) => {
      const roadDifference = left.roadIndex - right.roadIndex;
      if (roadDifference !== 0) return roadDifference;
      return left.kind.localeCompare(right.kind);
    });
  }

  private setPlannedTransition(
    agent: TrafficAgent,
    junction: Readonly<TrafficRoadJunction>,
    option: Readonly<RoadTransitionOption>,
    triggerAheadOverride?: number,
  ): void {
    const targetRoad = this.roads[option.roadIndex];
    if (!targetRoad) return;
    const laneMagnitude = laneOffsetMagnitude(targetRoad);
    agent.plannedTransition = {
      ...option,
      junction,
      triggerAhead: triggerAheadOverride
        ?? (option.kind === 'right' ? laneMagnitude : option.kind === 'left' ? -laneMagnitude : 0),
    };
  }

  private applyRoadTransition(
    agent: TrafficAgent,
    transition: Readonly<PlannedRoadTransition>,
    remainingDistance: number,
  ): boolean {
    const targetRoad = this.roads[transition.roadIndex];
    if (!targetRoad) {
      agent.plannedTransition = null;
      return false;
    }
    const targetLaneOffset = laneOffsetForRoad(targetRoad, transition.direction);
    let candidateX = roadIsVertical(targetRoad)
      ? targetRoad.position.x + targetLaneOffset
      : agent.position.x;
    let candidateZ = roadIsVertical(targetRoad)
      ? agent.position.z
      : targetRoad.position.z + targetLaneOffset;
    const targetHeading = roadHeading(targetRoad, transition.direction);
    candidateX += -Math.sin(targetHeading) * remainingDistance;
    candidateZ += -Math.cos(targetHeading) * remainingDistance;
    for (const other of this.agents) {
      if (
        !other.active
        || other === agent
        || other.roadIndex !== transition.roadIndex
      ) {
        continue;
      }
      const deltaX = other.position.x - candidateX;
      const deltaZ = other.position.z - candidateZ;
      if (
        deltaX * deltaX + deltaZ * deltaZ
          < TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance
            * TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance
      ) {
        return false;
      }
    }
    agent.roadIndex = transition.roadIndex;
    agent.direction = transition.direction;
    agent.laneOffset = targetLaneOffset;
    agent.heading = roadHeading(targetRoad, agent.direction);
    if (roadIsVertical(targetRoad)) {
      agent.position.x = targetRoad.position.x + agent.laneOffset;
    } else {
      agent.position.z = targetRoad.position.z + agent.laneOffset;
    }
    agent.position.y = 0;
    agent.lastJunction = transition.junction;
    agent.plannedTransition = null;
    agent.transitionWaitSeconds = 0;
    return true;
  }

  private keepAgentOnRoad(agent: TrafficAgent): void {
    const road = this.roadFor(agent);
    const center = roadCenterAlongCoordinate(road);
    const halfLength = roadLength(road) / 2;
    const along = roadAlongCoordinate(road, agent.position);
    if (along >= center - halfLength - JUNCTION_EPSILON && along <= center + halfLength + JUNCTION_EPSILON) {
      return;
    }

    const exitedAtMaximum = along > center + halfLength;
    const overshoot = exitedAtMaximum
      ? along - (center + halfLength)
      : center - halfLength - along;
    agent.direction = exitedAtMaximum ? -1 : 1;
    agent.laneOffset = laneOffsetForRoad(road, agent.direction);
    agent.heading = roadHeading(road, agent.direction);
    const returnedAlong = exitedAtMaximum
      ? center + halfLength - overshoot
      : center - halfLength + overshoot;
    if (roadIsVertical(road)) {
      agent.position.z = returnedAlong;
    } else {
      agent.position.x = returnedAlong;
    }
    agent.speed = Math.min(agent.speed, 3);
    agent.lastJunction = null;
    agent.plannedTransition = null;
  }

  private alignAgentToLane(agent: TrafficAgent, deltaSeconds: number): void {
    const road = this.roadFor(agent);
    const maximumDelta = LANE_ALIGNMENT_METERS_PER_SECOND * deltaSeconds;
    if (roadIsVertical(road)) {
      agent.position.x = moveTowards(
        agent.position.x,
        road.position.x + agent.laneOffset,
        maximumDelta,
      );
    } else {
      agent.position.z = moveTowards(
        agent.position.z,
        road.position.z + agent.laneOffset,
        maximumDelta,
      );
    }
  }

  private capturePreviousPositions(): void {
    for (const [index, agent] of this.agents.entries()) {
      this.previousPositionX[index] = agent.position.x;
      this.previousPositionZ[index] = agent.position.z;
    }
    this.previousPositionsValid = true;
  }

  private prepareSignalControls(deltaSeconds: number): void {
    for (const agent of this.agents) {
      agent.signalSpeedCap = Number.POSITIVE_INFINITY;
      agent.signalPriority = 0;
      agent.permissiveLeftYield = false;
      if (!agent.active) continue;
      const road = this.roadFor(agent);
      let upcomingJunction: TrafficRoadJunction | null = null;
      let upcomingAhead = Number.POSITIVE_INFINITY;
      for (const junction of this.junctionsByRoad[agent.roadIndex] ?? []) {
        if (!this.signalJunctionIds.has(junction.id)) continue;
        const ahead = distanceAhead(agent, junction.position);
        if (
          ahead < -JUNCTION_RELEASE_DISTANCE
          || ahead > TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance
        ) {
          continue;
        }
        if (
          ahead < upcomingAhead - JUNCTION_EPSILON
          || (
            Math.abs(ahead - upcomingAhead) <= JUNCTION_EPSILON
            && (
              upcomingJunction === null
              || junction.id < upcomingJunction.id
            )
          )
        ) {
          upcomingJunction = junction;
          upcomingAhead = ahead;
        }
      }
      if (!upcomingJunction) continue;

      const distanceToStopLine = upcomingAhead - TRAFFIC_SIGNAL_STOP_LINE_DISTANCE;
      const aspect = this.signals.aspectFor(upcomingJunction.id, road);
      if (distanceToStopLine < -JUNCTION_EPSILON) {
        // Once a car has genuinely crossed the bar it must clear the
        // junction, even if the phase changes inside the conflict envelope.
        // Equality is still a legal stop at the bar, not permission to run it.
        agent.signalPriority = 1;
        continue;
      }

      const exitIsClear = this.hasClearSignalExit(agent, upcomingJunction);
      const isPermissiveLeft = agent.plannedTransition?.kind === 'left';
      const hasLeftAuthority = isPermissiveLeft && agent.intersectionTicket > 0;
      const yieldsPermissiveLeft = isPermissiveLeft
        && this.hasConflictingOpposingMovement(
          agent,
          upcomingJunction,
          hasLeftAuthority,
        );
      const yieldsProtectedLeft = !isPermissiveLeft
        && this.hasOpposingProtectedLeft(agent, upcomingJunction);
      if (
        aspect === 'green'
        && exitIsClear
        && !yieldsPermissiveLeft
        && !yieldsProtectedLeft
      ) {
        agent.signalPriority = 1;
        continue;
      }
      if (
        aspect === 'green'
        && exitIsClear
        && isPermissiveLeft
        && yieldsPermissiveLeft
      ) {
        agent.permissiveLeftYield = true;
      }

      const forwardSpeed = Math.max(0, agent.speed);
      const stoppingDistance = forwardSpeed * forwardSpeed
        / (2 * SIGNAL_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED);
      const yellowCommitDistance = stoppingDistance
        + forwardSpeed * SIGNAL_YELLOW_REACTION_SECONDS;
      if (
        aspect === 'yellow'
        && exitIsClear
        && !yieldsPermissiveLeft
        && !yieldsProtectedLeft
        && distanceToStopLine <= yellowCommitDistance
      ) {
        agent.signalPriority = 1;
        continue;
      }

      agent.signalPriority = -1;
      const brakingCap = Math.sqrt(
        2
        * SIGNAL_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED
        * Math.max(0, distanceToStopLine),
      );
      const oneTickCap = Math.max(0, distanceToStopLine)
        / Math.max(0.001, deltaSeconds);
      agent.signalSpeedCap = Math.min(brakingCap, oneTickCap);
    }
  }

  private hasConflictingOpposingMovement(
    agent: Readonly<TrafficAgent>,
    junction: Readonly<TrafficRoadJunction>,
    committedOnly: boolean,
  ): boolean {
    const directionX = -Math.sin(agent.heading);
    const directionZ = -Math.cos(agent.heading);
    const maximumDistance = TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance;
    const agentAhead = Math.max(0, distanceAhead(agent, junction.position));
    const leftClearSeconds = (
      agentAhead + TRAFFIC_LOCAL_AVOIDANCE.conflictDistance
    ) / Math.max(6, agent.speed) + 0.5;
    for (const other of this.agents) {
      if (
        !other.active
        || other === agent
        || !junction.roadIndices.includes(other.roadIndex)
      ) {
        continue;
      }
      const otherDirectionX = -Math.sin(other.heading);
      const otherDirectionZ = -Math.cos(other.heading);
      const headingAlignment = directionX * otherDirectionX
        + directionZ * otherDirectionZ;
      if (headingAlignment > -0.78) continue;
      const otherTransition = other.plannedTransition;
      if (
        otherTransition?.junction.id === junction.id
        && otherTransition.kind === 'left'
      ) {
        continue;
      }
      const otherAhead = distanceAhead(other, junction.position);
      if (otherAhead < -TRAFFIC_LOCAL_AVOIDANCE.conflictDistance) continue;
      if (committedOnly) {
        const distanceToStopLine = otherAhead - TRAFFIC_SIGNAL_STOP_LINE_DISTANCE;
        const stoppingDistance = Math.max(0, other.speed) ** 2
          / (2 * SIGNAL_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED);
        if (
          distanceToStopLine < -JUNCTION_EPSILON
          || (
            other.speed > 1
            && distanceToStopLine
              <= stoppingDistance
                + other.speed * SIGNAL_YELLOW_REACTION_SECONDS
          )
        ) {
          return true;
        }
        continue;
      }
      const opposingArrivalSeconds = Math.max(0, otherAhead)
        / Math.max(6, other.speed);
      if (
        otherAhead <= maximumDistance
        && opposingArrivalSeconds <= leftClearSeconds + 0.35
      ) {
        return true;
      }
    }
    return false;
  }

  private hasOpposingProtectedLeft(
    agent: Readonly<TrafficAgent>,
    junction: Readonly<TrafficRoadJunction>,
  ): boolean {
    const agentAhead = distanceAhead(agent, junction.position);
    const distanceToStopLine = agentAhead - TRAFFIC_SIGNAL_STOP_LINE_DISTANCE;
    const stoppingDistance = Math.max(0, agent.speed) ** 2
      / (2 * SIGNAL_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED);
    if (
      distanceToStopLine < -JUNCTION_EPSILON
      || (
        agent.speed > 1
        && distanceToStopLine
          <= stoppingDistance + agent.speed * SIGNAL_YELLOW_REACTION_SECONDS
      )
    ) {
      // A through/right driver that can no longer stop comfortably keeps its
      // initial priority; the protected left begins behind that cleared car.
      return false;
    }
    const directionX = -Math.sin(agent.heading);
    const directionZ = -Math.cos(agent.heading);
    for (const other of this.agents) {
      if (
        !other.active
        || other === agent
        || other.intersectionTicket <= 0
        || other.plannedTransition?.kind !== 'left'
        || other.plannedTransition.junction.id !== junction.id
      ) {
        continue;
      }
      const otherDirectionX = -Math.sin(other.heading);
      const otherDirectionZ = -Math.cos(other.heading);
      const headingAlignment = directionX * otherDirectionX
        + directionZ * otherDirectionZ;
      if (headingAlignment > -0.78) continue;
      const otherAhead = distanceAhead(other, junction.position);
      if (
        otherAhead >= -TRAFFIC_LOCAL_AVOIDANCE.conflictDistance
        && otherAhead <= TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance
      ) {
        return true;
      }
    }
    return false;
  }

  private hasClearSignalExit(
    agent: Readonly<TrafficAgent>,
    junction: Readonly<TrafficRoadJunction>,
  ): boolean {
    const transition = agent.plannedTransition;
    const exitRoadIndex = transition?.roadIndex ?? agent.roadIndex;
    const exitRoad = this.roads[exitRoadIndex];
    if (!exitRoad) return false;
    const exitDirectionSign = transition?.direction ?? agent.direction;
    const exitLaneOffset = transition
      ? laneOffsetForRoad(exitRoad, transition.direction)
      : agent.laneOffset;
    const exitHeading = transition
      ? roadHeading(exitRoad, exitDirectionSign)
      : agent.heading;
    const exitDirectionX = -Math.sin(exitHeading);
    const exitDirectionZ = -Math.cos(exitHeading);
    const minimumExitProgress = transition
      ? -JUNCTION_EPSILON
      : -TRAFFIC_SIGNAL_STOP_LINE_DISTANCE;
    for (const other of this.agents) {
      if (!other.active || other === agent) continue;
      if (
        distance2d(other.position, junction.position)
          < TRAFFIC_SIGNAL_STOP_LINE_DISTANCE - JUNCTION_EPSILON
      ) {
        // Do not enter behind a stale turn or a car still clearing the prior
        // phase. This makes the all-red interval effective under congestion.
        return false;
      }
      if (other.roadIndex !== exitRoadIndex) continue;
      const otherDirectionX = -Math.sin(other.heading);
      const otherDirectionZ = -Math.cos(other.heading);
      const headingAlignment = exitDirectionX * otherDirectionX
        + exitDirectionZ * otherDirectionZ;
      if (headingAlignment < 0.78) continue;
      const deltaX = other.position.x - junction.position.x;
      const deltaZ = other.position.z - junction.position.z;
      const aheadFromJunction = deltaX * exitDirectionX + deltaZ * exitDirectionZ;
      if (
        aheadFromJunction < minimumExitProgress
        || aheadFromJunction
          > JUNCTION_RELEASE_DISTANCE + agent.collisionRadius + other.collisionRadius
      ) {
        continue;
      }
      const sideways = roadIsVertical(exitRoad)
        ? Math.abs(other.position.x - (exitRoad.position.x + exitLaneOffset))
        : Math.abs(other.position.z - (exitRoad.position.z + exitLaneOffset));
      if (sideways <= TRAFFIC_LOCAL_AVOIDANCE.followingLateralTolerance) {
        return false;
      }
    }
    return true;
  }

  private prepareLocalAvoidance(
    deltaSeconds: number,
    externalVehicle: Readonly<ExternalTrafficVehicleState> | null | undefined,
  ): void {
    this.peerSpeedCaps.fill(Number.POSITIVE_INFINITY);
    this.peerYieldKinds.fill(0);
    this.nearestConflictDistances.fill(Number.POSITIVE_INFINITY);
    this.lastTickPairChecks = 0;
    this.prepareNearestConflictDistances();
    this.prepareExternalVehicleAvoidance(externalVehicle, deltaSeconds);

    for (let pass = 0; pass < TRAFFIC_LOCAL_AVOIDANCE.pairPasses; pass += 1) {
      for (let firstIndex = 0; firstIndex < this.agents.length; firstIndex += 1) {
        const first = this.agents[firstIndex];
        if (!first?.active) continue;
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < this.agents.length;
          secondIndex += 1
        ) {
          const second = this.agents[secondIndex];
          if (!second?.active) continue;
          this.lastTickPairChecks += 1;
          this.preparePairAvoidance(
            firstIndex,
            first,
            secondIndex,
            second,
            deltaSeconds,
          );
        }
      }
    }
  }

  private prepareExternalVehicleAvoidance(
    externalVehicle: Readonly<ExternalTrafficVehicleState> | null | undefined,
    deltaSeconds: number,
  ): void {
    if (
      !externalVehicle
      || !this.isFinitePosition(externalVehicle.position)
      || !Number.isFinite(externalVehicle.heading)
      || !Number.isFinite(externalVehicle.speed)
      || (
        externalVehicle.lateralSpeed !== undefined
        && !Number.isFinite(externalVehicle.lateralSpeed)
      )
    ) {
      return;
    }
    const externalRadius = externalVehicle.radius ?? DEFAULT_EXTERNAL_COLLISION_RADIUS;
    if (!Number.isFinite(externalRadius) || externalRadius <= 0) return;

    const externalDirectionX = -Math.sin(externalVehicle.heading);
    const externalDirectionZ = -Math.cos(externalVehicle.heading);
    const externalRightX = -externalDirectionZ;
    const externalRightZ = externalDirectionX;
    const externalVelocityX = externalDirectionX * externalVehicle.speed
      + externalRightX * (externalVehicle.lateralSpeed ?? 0);
    const externalVelocityZ = externalDirectionZ * externalVehicle.speed
      + externalRightZ * (externalVehicle.lateralSpeed ?? 0);
    const externalSpeedMagnitude = Math.hypot(externalVelocityX, externalVelocityZ);
    const maximumDistance = TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance;

    for (const [agentIndex, agent] of this.agents.entries()) {
      if (!agent.active || agent.behavior === 'recover') continue;
      this.lastTickPairChecks += 1;
      const deltaX = externalVehicle.position.x - agent.position.x;
      const deltaZ = externalVehicle.position.z - agent.position.z;
      const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
      if (distanceSquared > maximumDistance * maximumDistance) continue;
      const directionX = -Math.sin(agent.heading);
      const directionZ = -Math.cos(agent.heading);
      const ahead = deltaX * directionX + deltaZ * directionZ;
      const combinedRadius = agent.collisionRadius + externalRadius;
      if (ahead <= -combinedRadius || ahead > maximumDistance) continue;
      const sideways = Math.abs(deltaX * directionZ - deltaZ * directionX);
      const headingAlignment = directionX * externalDirectionX
        + directionZ * externalDirectionZ;
      const externalAlongSpeed = externalVelocityX * directionX
        + externalVelocityZ * directionZ;

      if (
        sideways <= combinedRadius + 0.75
        && (headingAlignment > 0.35 || externalSpeedMagnitude <= 0.5)
      ) {
        this.applyExternalFollowingLimit(
          agentIndex,
          agent,
          ahead,
          combinedRadius,
          Math.max(0, externalAlongSpeed),
          deltaSeconds,
        );
        continue;
      }

      const agentSpeed = Math.max(0, this.predictedSpeed(agentIndex, agent));
      const relativeVelocityX = externalVelocityX - directionX * agentSpeed;
      const relativeVelocityZ = externalVelocityZ - directionZ * agentSpeed;
      const relativeSpeedSquared = relativeVelocityX * relativeVelocityX
        + relativeVelocityZ * relativeVelocityZ;
      if (relativeSpeedSquared <= 0.000001) continue;
      const closestTime = Math.min(
        TRAFFIC_LOCAL_AVOIDANCE.predictionSeconds,
        Math.max(
          0,
          -(deltaX * relativeVelocityX + deltaZ * relativeVelocityZ)
            / relativeSpeedSquared,
        ),
      );
      if (closestTime <= 0) continue;
      const closestX = deltaX + relativeVelocityX * closestTime;
      const closestZ = deltaZ + relativeVelocityZ * closestTime;
      const predictiveClearance = combinedRadius + 0.75;
      if (
        closestX * closestX + closestZ * closestZ
          >= predictiveClearance * predictiveClearance
      ) {
        continue;
      }
      const availableDistance = Math.max(
        0,
        agentSpeed * closestTime - combinedRadius - 0.75,
      );
      const brakingCap = Math.sqrt(
        2
        * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared
        * availableDistance,
      );
      const oneTickCap = availableDistance / Math.max(0.001, deltaSeconds);
      this.setPeerLimit(agentIndex, 2, Math.min(brakingCap, oneTickCap));
    }
  }

  private applyExternalFollowingLimit(
    followerIndex: number,
    follower: Readonly<TrafficAgent>,
    centerDistance: number,
    combinedRadius: number,
    leaderSpeed: number,
    deltaSeconds: number,
  ): void {
    const followerSpeed = Math.max(0, this.predictedSpeed(followerIndex, follower));
    const relativeStoppingDistance = Math.max(
      0,
      (followerSpeed * followerSpeed - leaderSpeed * leaderSpeed)
        / (2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared),
    );
    const desiredDistance = combinedRadius
      + Math.max(3, followerSpeed * 0.9)
      + relativeStoppingDistance;
    if (centerDistance >= desiredDistance) return;

    const availableDistance = Math.max(0, centerDistance - combinedRadius);
    const brakingCap = Math.sqrt(
      leaderSpeed * leaderSpeed
      + 2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared * availableDistance,
    );
    const oneTickCap = availableDistance / Math.max(0.001, deltaSeconds);
    this.setPeerLimit(followerIndex, 1, Math.min(brakingCap, oneTickCap));
  }

  private resolveVehicleCollisions(): void {
    this.lastTickCollisionResolutions = 0;
    for (
      let pass = 0;
      pass < TRAFFIC_LOCAL_AVOIDANCE.collisionPasses;
      pass += 1
    ) {
      let contactsThisPass = 0;
      for (let firstIndex = 0; firstIndex < this.agents.length; firstIndex += 1) {
        const first = this.agents[firstIndex];
        if (!first?.active) continue;
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < this.agents.length;
          secondIndex += 1
        ) {
          const second = this.agents[secondIndex];
          if (!second?.active) continue;
          this.lastTickPairChecks += 1;
          const minimumDistance = first.collisionRadius + second.collisionRadius;
          const startDeltaX = pass === 0
            ? (this.previousPositionX[secondIndex] ?? second.position.x)
              - (this.previousPositionX[firstIndex] ?? first.position.x)
            : second.position.x - first.position.x;
          const startDeltaZ = pass === 0
            ? (this.previousPositionZ[secondIndex] ?? second.position.z)
              - (this.previousPositionZ[firstIndex] ?? first.position.z)
            : second.position.z - first.position.z;
          const endDeltaX = second.position.x - first.position.x;
          const endDeltaZ = second.position.z - first.position.z;
          const contact = sweptCircleContact(
            startDeltaX,
            startDeltaZ,
            endDeltaX,
            endDeltaZ,
            minimumDistance,
            first.heading,
            first.id < second.id ? 1 : -1,
          );
          if (!contact) continue;
          contactsThisPass += 1;

          if (pass === 0 && contact.time < 1) {
            const priorFirstX = this.previousPositionX[firstIndex] ?? first.position.x;
            const priorFirstZ = this.previousPositionZ[firstIndex] ?? first.position.z;
            const priorSecondX = this.previousPositionX[secondIndex] ?? second.position.x;
            const priorSecondZ = this.previousPositionZ[secondIndex] ?? second.position.z;
            first.position.x = priorFirstX
              + (first.position.x - priorFirstX) * contact.time;
            first.position.z = priorFirstZ
              + (first.position.z - priorFirstZ) * contact.time;
            second.position.x = priorSecondX
              + (second.position.x - priorSecondX) * contact.time;
            second.position.z = priorSecondZ
              + (second.position.z - priorSecondZ) * contact.time;
          }

          const currentDistance = distance2d(first.position, second.position);
          const separation = Math.max(
            CONTACT_EPSILON,
            minimumDistance + CONTACT_EPSILON - currentDistance,
          );
          const firstPinnedAtSignal = first.signalPriority < 0
            && first.signalSpeedCap <= 0.15;
          const secondPinnedAtSignal = second.signalPriority < 0
            && second.signalSpeedCap <= 0.15;
          if (firstPinnedAtSignal && !secondPinnedAtSignal) {
            second.position.x += contact.normalX * separation;
            second.position.z += contact.normalZ * separation;
          } else if (secondPinnedAtSignal && !firstPinnedAtSignal) {
            first.position.x -= contact.normalX * separation;
            first.position.z -= contact.normalZ * separation;
          } else {
            const correction = separation / 2;
            first.position.x -= contact.normalX * correction;
            first.position.z -= contact.normalZ * correction;
            second.position.x += contact.normalX * correction;
            second.position.z += contact.normalZ * correction;
          }
          this.applyAmbientImpact(first, second, contact.normalX, contact.normalZ);
          this.lastTickCollisionResolutions += 1;
        }
      }
      if (contactsThisPass === 0) break;
    }
    for (const agent of this.agents) {
      if (!agent.active || agent.signalPriority >= 0) continue;
      agent.speed = Math.min(agent.speed, Math.max(0, agent.signalSpeedCap));
    }
  }

  private applyAmbientImpact(
    first: TrafficAgent,
    second: TrafficAgent,
    normalX: number,
    normalZ: number,
  ): void {
    const firstDirection = directionFromHeading(first.heading);
    const secondDirection = directionFromHeading(second.heading);
    const firstVelocityX = firstDirection.x * first.speed;
    const firstVelocityZ = firstDirection.z * first.speed;
    const secondVelocityX = secondDirection.x * second.speed;
    const secondVelocityZ = secondDirection.z * second.speed;
    const relativeNormalVelocity = (
      secondVelocityX - firstVelocityX
    ) * normalX + (
      secondVelocityZ - firstVelocityZ
    ) * normalZ;
    const closingSpeed = Math.max(0, -relativeNormalVelocity);
    if (closingSpeed <= 0.05) return;

    const headingAlignment = firstDirection.x * secondDirection.x
      + firstDirection.z * secondDirection.z;
    if (headingAlignment > 0.65) {
      // Near-equal-mass impulse: the rear car sheds speed while transferring a
      // small, bounded amount of momentum to the leader.
      const impulse = closingSpeed * 0.54;
      const resolvedFirstX = firstVelocityX - impulse * normalX;
      const resolvedFirstZ = firstVelocityZ - impulse * normalZ;
      const resolvedSecondX = secondVelocityX + impulse * normalX;
      const resolvedSecondZ = secondVelocityZ + impulse * normalZ;
      first.speed = Math.max(
        0,
        Math.min(
          first.cruiseSpeed * 1.08,
          resolvedFirstX * firstDirection.x + resolvedFirstZ * firstDirection.z,
        ),
      );
      second.speed = Math.max(
        0,
        Math.min(
          second.cruiseSpeed * 1.08,
          resolvedSecondX * secondDirection.x + resolvedSecondZ * secondDirection.z,
        ),
      );
      return;
    }

    if (headingAlignment < -0.35) {
      first.speed = Math.min(Math.max(0, first.speed) * 0.12, 1.2);
      second.speed = Math.min(Math.max(0, second.speed) * 0.12, 1.2);
      if (first.roadIndex === second.roadIndex) {
        const yieldingAgent = this.hasTrafficPriority(first, second) ? second : first;
        if (yieldingAgent.behavior !== 'recover') {
          this.reverseAgentRoute(yieldingAgent);
        }
      }
      return;
    }

    // For a side impact, established unsignalized priority decides which car
    // can clear the conflict first; both still lose speed.
    const firstHasPriority = this.hasTrafficPriority(first, second);
    first.speed = Math.max(0, first.speed) * (firstHasPriority ? 0.52 : 0.16);
    second.speed = Math.max(0, second.speed) * (firstHasPriority ? 0.16 : 0.52);
  }

  private prepareNearestConflictDistances(): void {
    const maximumDistance = TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance;
    for (let firstIndex = 0; firstIndex < this.agents.length; firstIndex += 1) {
      const first = this.agents[firstIndex];
      if (!first?.active) continue;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < this.agents.length;
        secondIndex += 1
      ) {
        const second = this.agents[secondIndex];
        if (!second?.active) continue;
        this.lastTickPairChecks += 1;
        const deltaX = second.position.x - first.position.x;
        const deltaZ = second.position.z - first.position.z;
        if (deltaX * deltaX + deltaZ * deltaZ > maximumDistance * maximumDistance) continue;
        const firstDirectionX = -Math.sin(first.heading);
        const firstDirectionZ = -Math.cos(first.heading);
        const secondDirectionX = -Math.sin(second.heading);
        const secondDirectionZ = -Math.cos(second.heading);
        const headingAlignment = firstDirectionX * secondDirectionX
          + firstDirectionZ * secondDirectionZ;
        if (Math.abs(headingAlignment) >= 0.22) continue;
        const firstVertical = Math.abs(firstDirectionZ) >= Math.abs(firstDirectionX);
        const secondVertical = Math.abs(secondDirectionZ) >= Math.abs(secondDirectionX);
        if (firstVertical === secondVertical) continue;
        const conflictX = firstVertical ? first.position.x : second.position.x;
        const conflictZ = firstVertical ? second.position.z : first.position.z;
        const firstAhead = (conflictX - first.position.x) * firstDirectionX
          + (conflictZ - first.position.z) * firstDirectionZ;
        const secondAhead = (conflictX - second.position.x) * secondDirectionX
          + (conflictZ - second.position.z) * secondDirectionZ;
        const releaseDistance = TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance;
        if (
          firstAhead < -releaseDistance
          || secondAhead < -releaseDistance
          || firstAhead > maximumDistance
          || secondAhead > maximumDistance
        ) {
          continue;
        }
        this.nearestConflictDistances[firstIndex] = Math.min(
          this.nearestConflictDistances[firstIndex] ?? Number.POSITIVE_INFINITY,
          Math.max(0, firstAhead),
        );
        this.nearestConflictDistances[secondIndex] = Math.min(
          this.nearestConflictDistances[secondIndex] ?? Number.POSITIVE_INFINITY,
          Math.max(0, secondAhead),
        );
      }
    }
  }

  private preparePairAvoidance(
    firstIndex: number,
    first: Readonly<TrafficAgent>,
    secondIndex: number,
    second: Readonly<TrafficAgent>,
    deltaSeconds: number,
  ): void {
    const deltaX = second.position.x - first.position.x;
    const deltaZ = second.position.z - first.position.z;
    const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
    const maximumDistance = TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance;
    if (distanceSquared > maximumDistance * maximumDistance) return;

    const firstDirectionX = -Math.sin(first.heading);
    const firstDirectionZ = -Math.cos(first.heading);
    const secondDirectionX = -Math.sin(second.heading);
    const secondDirectionZ = -Math.cos(second.heading);
    const headingAlignment = firstDirectionX * secondDirectionX
      + firstDirectionZ * secondDirectionZ;

    if (
      headingAlignment > 0.78
      && first.behavior !== 'recover'
      && second.behavior !== 'recover'
    ) {
      const firstAhead = deltaX * firstDirectionX + deltaZ * firstDirectionZ;
      const firstSideways = Math.abs(
        deltaX * firstDirectionZ - deltaZ * firstDirectionX,
      );
      if (firstSideways <= TRAFFIC_LOCAL_AVOIDANCE.followingLateralTolerance) {
        if (Math.abs(firstAhead) < 0.000001) {
          if (first.id < second.id) {
            this.applyFollowingLimit(secondIndex, second, firstIndex, first, 0, deltaSeconds);
          } else {
            this.applyFollowingLimit(firstIndex, first, secondIndex, second, 0, deltaSeconds);
          }
        } else if (firstAhead > 0) {
          this.applyFollowingLimit(
            firstIndex,
            first,
            secondIndex,
            second,
            firstAhead,
            deltaSeconds,
          );
        } else {
          this.applyFollowingLimit(
            secondIndex,
            second,
            firstIndex,
            first,
            -firstAhead,
            deltaSeconds,
          );
        }
        return;
      }
    }

    if (Math.abs(headingAlignment) < 0.22) {
      const firstVertical = Math.abs(firstDirectionZ) >= Math.abs(firstDirectionX);
      const secondVertical = Math.abs(secondDirectionZ) >= Math.abs(secondDirectionX);
      if (firstVertical !== secondVertical) {
        const conflictX = firstVertical ? first.position.x : second.position.x;
        const conflictZ = firstVertical ? second.position.z : first.position.z;
        const firstAhead = (conflictX - first.position.x) * firstDirectionX
          + (conflictZ - first.position.z) * firstDirectionZ;
        const secondAhead = (conflictX - second.position.x) * secondDirectionX
          + (conflictZ - second.position.z) * secondDirectionZ;
        const releaseDistance = TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance;
        if (
          firstAhead >= -releaseDistance
          && secondAhead >= -releaseDistance
          && firstAhead <= maximumDistance
          && secondAhead <= maximumDistance
        ) {
          const firstHasPriority = this.hasConflictPriority(
            first,
            firstAhead,
            second,
            secondAhead,
          );
          if (firstHasPriority) {
            if (
              secondAhead
                <= (this.nearestConflictDistances[secondIndex]
                  ?? Number.POSITIVE_INFINITY) + 0.25
            ) {
              this.applyConflictLimit(secondIndex, secondAhead, deltaSeconds);
            }
          } else {
            if (
              firstAhead
                <= (this.nearestConflictDistances[firstIndex]
                  ?? Number.POSITIVE_INFINITY) + 0.25
            ) {
              this.applyConflictLimit(firstIndex, firstAhead, deltaSeconds);
            }
          }
          return;
        }
      }
    }

    // Parallel traffic in separate lanes cannot converge laterally. Turning
    // and crossing headings continue through the predictive conflict test.
    if (Math.abs(headingAlignment) > 0.78) return;

    const firstSpeed = this.predictedSpeed(firstIndex, first);
    const secondSpeed = this.predictedSpeed(secondIndex, second);
    const relativeVelocityX = secondDirectionX * secondSpeed
      - firstDirectionX * firstSpeed;
    const relativeVelocityZ = secondDirectionZ * secondSpeed
      - firstDirectionZ * firstSpeed;
    const relativeSpeedSquared = relativeVelocityX * relativeVelocityX
      + relativeVelocityZ * relativeVelocityZ;
    const currentDistance = Math.sqrt(distanceSquared);
    let closestTime = 0;
    if (relativeSpeedSquared > 0.000001) {
      closestTime = Math.min(
        TRAFFIC_LOCAL_AVOIDANCE.predictionSeconds,
        Math.max(
          0,
          -(deltaX * relativeVelocityX + deltaZ * relativeVelocityZ)
            / relativeSpeedSquared,
        ),
      );
    } else if (currentDistance >= TRAFFIC_LOCAL_AVOIDANCE.conflictDistance) {
      return;
    }
    const closestX = deltaX + relativeVelocityX * closestTime;
    const closestZ = deltaZ + relativeVelocityZ * closestTime;
    if (
      closestX * closestX + closestZ * closestZ
        >= TRAFFIC_LOCAL_AVOIDANCE.conflictDistance
          * TRAFFIC_LOCAL_AVOIDANCE.conflictDistance
    ) {
      return;
    }

    const firstAtClosestX = first.position.x + firstDirectionX * firstSpeed * closestTime;
    const firstAtClosestZ = first.position.z + firstDirectionZ * firstSpeed * closestTime;
    const secondAtClosestX = second.position.x + secondDirectionX * secondSpeed * closestTime;
    const secondAtClosestZ = second.position.z + secondDirectionZ * secondSpeed * closestTime;
    const conflictX = (firstAtClosestX + secondAtClosestX) * 0.5;
    const conflictZ = (firstAtClosestZ + secondAtClosestZ) * 0.5;
    const firstAhead = (conflictX - first.position.x) * firstDirectionX
      + (conflictZ - first.position.z) * firstDirectionZ;
    const secondAhead = (conflictX - second.position.x) * secondDirectionX
      + (conflictZ - second.position.z) * secondDirectionZ;
    const firstHasPriority = this.hasConflictPriority(
      first,
      firstAhead,
      second,
      secondAhead,
    );
    if (firstHasPriority) {
      this.applyConflictLimit(secondIndex, secondAhead, deltaSeconds);
    } else {
      this.applyConflictLimit(firstIndex, firstAhead, deltaSeconds);
    }
  }

  private applyFollowingLimit(
    followerIndex: number,
    follower: Readonly<TrafficAgent>,
    leaderIndex: number,
    leader: Readonly<TrafficAgent>,
    centerDistance: number,
    deltaSeconds: number,
  ): void {
    const minimumDistance = follower.collisionRadius + leader.collisionRadius;
    const leaderSpeed = Math.max(0, this.predictedSpeed(leaderIndex, leader));
    const followerSpeed = Math.max(0, this.predictedSpeed(followerIndex, follower));
    const relativeStoppingDistance = Math.max(
      0,
      (followerSpeed * followerSpeed - leaderSpeed * leaderSpeed)
        / (2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared),
    );
    const desiredDistance = minimumDistance
      + Math.max(3, followerSpeed * 0.9)
      + relativeStoppingDistance;
    if (centerDistance >= desiredDistance) return;

    const availableDistance = Math.max(0, centerDistance - minimumDistance);
    const brakingCap = Math.sqrt(
      leaderSpeed * leaderSpeed
      + 2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared * availableDistance,
    );
    const oneTickCap = availableDistance / Math.max(0.001, deltaSeconds);
    this.setPeerLimit(followerIndex, 1, Math.min(brakingCap, oneTickCap));
  }

  private applyConflictLimit(
    agentIndex: number,
    distanceToConflict: number,
    deltaSeconds: number,
  ): void {
    const agent = this.agents[agentIndex];
    if (agent?.signalPriority === 1) {
      // A vehicle already released by a green/yellow phase (or clearing the
      // stop bar) must leave the conflict envelope during the all-red buffer.
      // Re-applying unsignalized priority here can strand it in the junction.
      return;
    }
    const availableDistance = Math.max(
      0,
      distanceToConflict - TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance,
    );
    const brakingCap = Math.sqrt(
      2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared * availableDistance,
    );
    const oneTickCap = availableDistance / Math.max(0.001, deltaSeconds);
    this.setPeerLimit(agentIndex, 2, Math.min(brakingCap, oneTickCap));
  }

  private setPeerLimit(agentIndex: number, yieldKind: 1 | 2, speedCap: number): void {
    const existingCap = this.peerSpeedCaps[agentIndex] ?? Number.POSITIVE_INFINITY;
    this.peerSpeedCaps[agentIndex] = Math.min(existingCap, Math.max(0, speedCap));
    const existingKind = this.peerYieldKinds[agentIndex] ?? 0;
    this.peerYieldKinds[agentIndex] = existingKind | yieldKind;
  }

  private predictedSpeed(agentIndex: number, agent: Readonly<TrafficAgent>): number {
    const speedCap = this.peerSpeedCaps[agentIndex] ?? Number.POSITIVE_INFINITY;
    return agent.speed >= 0
      ? Math.min(agent.speed, speedCap, agent.signalSpeedCap)
      : agent.speed;
  }

  private hasTrafficPriority(
    first: Readonly<TrafficAgent>,
    second: Readonly<TrafficAgent>,
  ): boolean {
    if (first.signalPriority !== second.signalPriority) {
      return first.signalPriority > second.signalPriority;
    }
    const firstPriority = first.intersectionTicket > 0;
    const secondPriority = second.intersectionTicket > 0;
    if (firstPriority !== secondPriority) return firstPriority;
    if (firstPriority && secondPriority) {
      return first.intersectionTicket < second.intersectionTicket;
    }
    const firstMajor = Boolean(this.roadFor(first).major);
    const secondMajor = Boolean(this.roadFor(second).major);
    if (firstMajor !== secondMajor) return firstMajor;
    return first.id < second.id;
  }

  private hasConflictPriority(
    first: Readonly<TrafficAgent>,
    firstDistanceToConflict: number,
    second: Readonly<TrafficAgent>,
    secondDistanceToConflict: number,
  ): boolean {
    if (first.signalPriority !== second.signalPriority) {
      return first.signalPriority > second.signalPriority;
    }
    const committedDistance = TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance;
    const firstCommitted = Math.abs(firstDistanceToConflict) <= committedDistance;
    const secondCommitted = Math.abs(secondDistanceToConflict) <= committedDistance;
    if (firstCommitted !== secondCommitted) return firstCommitted;
    const firstPriority = first.intersectionTicket > 0;
    const secondPriority = second.intersectionTicket > 0;
    if (firstPriority !== secondPriority) return firstPriority;
    if (firstCommitted && secondCommitted) {
      if (firstDistanceToConflict < 0 && secondDistanceToConflict >= 0) return true;
      if (secondDistanceToConflict < 0 && firstDistanceToConflict >= 0) return false;
      const distanceDifference = Math.abs(firstDistanceToConflict)
        - Math.abs(secondDistanceToConflict);
      if (Math.abs(distanceDifference) > 0.000001) return distanceDifference < 0;
    }
    if (firstDistanceToConflict >= 0 && secondDistanceToConflict >= 0) {
      const firstArrivalSeconds = firstDistanceToConflict / Math.max(
        TRAFFIC_LOCAL_AVOIDANCE.intersectionCreepSpeed,
        first.speed,
      );
      const secondArrivalSeconds = secondDistanceToConflict / Math.max(
        TRAFFIC_LOCAL_AVOIDANCE.intersectionCreepSpeed,
        second.speed,
      );
      const arrivalDifference = firstArrivalSeconds - secondArrivalSeconds;
      if (Math.abs(arrivalDifference) > 0.35) return arrivalDifference < 0;
    }
    return this.hasTrafficPriority(first, second);
  }

  private obstacleSpeedCap(
    agent: Readonly<TrafficAgent>,
    obstacles: readonly SimulationObstacle[],
  ): number {
    const direction = directionFromHeading(agent.heading);
    const forwardSpeed = Math.max(0, agent.speed);
    const stoppingDistance = forwardSpeed * forwardSpeed
      / (2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared);
    const lookahead = Math.min(
      TRAFFIC_LOCAL_AVOIDANCE.maximumNeighborDistance,
      Math.max(14, stoppingDistance + forwardSpeed * 1.1 + 7),
    );
    let speedCap = Number.POSITIVE_INFINITY;
    for (const obstacle of obstacles) {
      const deltaX = obstacle.x - agent.position.x;
      const deltaZ = obstacle.z - agent.position.z;
      const ahead = deltaX * direction.x + deltaZ * direction.z;
      const sideways = Math.abs(deltaX * direction.z - deltaZ * direction.x);
      if (
        ahead <= 0
        || ahead > lookahead
        || sideways >= obstacle.radius + 1.35
      ) continue;
      const availableDistance = Math.max(0, ahead - obstacle.radius - 1.4);
      speedCap = Math.min(
        speedCap,
        Math.sqrt(
          2
          * OBSTACLE_COMFORTABLE_BRAKING_METERS_PER_SECOND_SQUARED
          * availableDistance,
        ),
      );
    }

    return speedCap;
  }

  private finishLocalRecovery(agent: TrafficAgent): void {
    if (agent.recoveryAttempts >= 2) {
      this.reverseAgentRoute(agent);
      agent.recoveryAttempts = 0;
    }
    agent.speed = 0;
    agent.behavior = 'cruise';
    agent.blockedSeconds = 0;
    agent.recoveryRemaining = 0;
    agent.intersectionWaitSeconds = 0;
    agent.intersectionPriorityRemaining = 0;
    agent.intersectionTicket = 0;
    agent.transitionWaitSeconds = 0;
    agent.plannedTransition = null;
  }

  private reverseAgentRoute(agent: TrafficAgent): void {
    const road = this.roadFor(agent);
    agent.direction = agent.direction === 1 ? -1 : 1;
    agent.laneOffset = laneOffsetForRoad(road, agent.direction);
    agent.heading = roadHeading(road, agent.direction);
    agent.lastJunction = null;
    agent.plannedTransition = null;
    agent.transitionWaitSeconds = 0;
  }

  private recycleAgent(agent: TrafficAgent): void {
    if (this.relevanceAnchor && this.placeAgentNearPlayer(agent, this.relevanceAnchor)) {
      this.syncPreviousPosition(agent);
      return;
    }
    agent.roadIndex = (agent.roadIndex + 1 + this.random.integer(0, this.roads.length - 1)) % this.roads.length;
    agent.direction = this.random.next() > 0.5 ? 1 : -1;
    this.resetAgentForPlacement(agent);
    this.placeOnRoad(agent, this.random.range(-0.45, 0.45));
    this.assignVehicleClass(agent);
    this.syncPreviousPosition(agent);
  }

  private syncPreviousPosition(agent: TrafficAgent): void {
    const agentIndex = this.agents.indexOf(agent);
    if (agentIndex < 0) return;
    this.previousPositionX[agentIndex] = agent.position.x;
    this.previousPositionZ[agentIndex] = agent.position.z;
  }

  private resetAgentForPlacement(agent: TrafficAgent): void {
    agent.speed = 0;
    agent.behavior = 'cruise';
    agent.blockedSeconds = 0;
    agent.recoveryRemaining = 0;
    agent.recoveryAttempts = 0;
    agent.panicRemaining = 0;
    agent.intersectionWaitSeconds = 0;
    agent.intersectionPriorityRemaining = 0;
    agent.intersectionTicket = 0;
    agent.transitionWaitSeconds = 0;
    agent.routeStep = 0;
    agent.lastJunction = null;
    agent.plannedTransition = null;
    agent.signalSpeedCap = Number.POSITIVE_INFINITY;
    agent.signalPriority = 0;
    agent.permissiveLeftYield = false;
  }

  private maintainPlayerRelevance(
    playerPosition: Readonly<SimulationVec3>,
    deltaSeconds: number,
  ): void {
    this.relevanceRefreshElapsed += deltaSeconds;
    const firstSample = this.relevanceAnchor === null;
    const playerDisplacement = this.relevanceAnchor
      ? distance2d(this.relevanceAnchor, playerPosition)
      : Number.POSITIVE_INFINITY;
    const rebasing = firstSample || playerDisplacement >= RELEVANCE_REBASE_DISTANCE;
    if (!rebasing && this.relevanceRefreshElapsed < RELEVANCE_REFRESH_SECONDS) {
      return;
    }

    this.relevanceAnchor = { ...playerPosition };
    this.relevanceRefreshElapsed = 0;
    const maximumRecycles = rebasing
      ? this.getActorLimit()
      : this.quality === 'high' ? 3 : 2;
    const recyclable = this.agents
      .filter((agent) => (
        agent.active
        && (
          rebasing
          || (
            agent.behavior === 'cruise'
            && agent.panicRemaining <= 0
            && agent.recoveryRemaining <= 0
          )
        )
        && distance2d(agent.position, playerPosition)
          > TRAFFIC_RELEVANCE_RADII.recycleBeyondDistance
      ))
      .sort((left, right) => {
        const distanceDifference = distance2d(right.position, playerPosition)
          - distance2d(left.position, playerPosition);
        return Math.abs(distanceDifference) > 0.000001
          ? distanceDifference
          : left.id.localeCompare(right.id);
      });

    let recycled = 0;
    for (const agent of recyclable) {
      if (recycled >= maximumRecycles) break;
      if (this.placeAgentNearPlayer(agent, playerPosition)) {
        recycled += 1;
      }
    }
  }

  private placeAgentNearPlayer(
    agent: TrafficAgent,
    playerPosition: Readonly<SimulationVec3>,
  ): boolean {
    const maximumAttempts = Math.max(
      24,
      this.roads.length * PLACEMENT_ATTEMPTS_PER_ROAD,
    );
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const roadIndex = this.random.integer(0, this.roads.length - 1);
      const road = this.roads[roadIndex];
      if (!road) continue;
      const direction: 1 | -1 = this.random.next() >= 0.5 ? 1 : -1;
      const laneOffset = laneOffsetForRoad(road, direction);
      const vertical = roadIsVertical(road);
      const lateralCoordinate = vertical
        ? road.position.x + laneOffset
        : road.position.z + laneOffset;
      const playerLateralCoordinate = vertical
        ? playerPosition.x
        : playerPosition.z;
      const lateralDistance = Math.abs(lateralCoordinate - playerLateralCoordinate);
      const radius = this.random.range(
        TRAFFIC_RELEVANCE_RADII.minimumSpawnDistance,
        TRAFFIC_RELEVANCE_RADII.maximumSpawnDistance,
      );
      if (lateralDistance > radius) continue;

      const alongDistance = Math.sqrt(Math.max(
        0,
        radius * radius - lateralDistance * lateralDistance,
      ));
      const preferredSign: 1 | -1 = this.random.next() >= 0.5 ? 1 : -1;
      for (const sign of [preferredSign, preferredSign === 1 ? -1 : 1] as const) {
        const playerAlong = vertical ? playerPosition.z : playerPosition.x;
        const roadCenter = roadCenterAlongCoordinate(road);
        const length = roadLength(road);
        const along = playerAlong + sign * alongDistance;
        const normalizedAlong = (along - roadCenter) / length;
        if (normalizedAlong < -0.47 || normalizedAlong > 0.47) continue;
        const position: SimulationVec3 = vertical
          ? { x: lateralCoordinate, y: 0, z: along }
          : { x: along, y: 0, z: lateralCoordinate };
        if (
          (this.junctionsByRoad[roadIndex] ?? []).some((junction) =>
            distance2d(position, junction.position) < JUNCTION_SPAWN_CLEARANCE)
          || this.agents.some((other) => (
            other.active
            && other !== agent
            && distance2d(position, other.position)
              < TRAFFIC_RELEVANCE_RADII.minimumVehicleSpacing
          ))
        ) {
          continue;
        }

        agent.roadIndex = roadIndex;
        agent.direction = direction;
        this.resetAgentForPlacement(agent);
        this.placeOnRoad(agent, normalizedAlong);
        this.assignVehicleClass(agent);
        return true;
      }
    }
    return false;
  }

  private isFinitePosition(position: Readonly<SimulationVec3>): boolean {
    return Number.isFinite(position.x)
      && Number.isFinite(position.y)
      && Number.isFinite(position.z);
  }

  private assignVehicleClass(agent: TrafficAgent): void {
    const road = this.roadFor(agent);
    const classRandom = new SimulationRandom([
      agent.id,
      road.id,
      agent.direction,
      agent.cruiseSpeed.toFixed(6),
      agent.position.x.toFixed(3),
      agent.position.z.toFixed(3),
    ].join(':'));
    agent.classId = chooseTrafficVehicleClass(classRandom, districtForRoad(road));
    agent.collisionRadius = VEHICLES.find(({ id }) => id === agent.classId)
      ?.arcadeHandling.collisionRadiusMeters
      ?? 1.48;
  }
}
