import { VEHICLES } from '../data/vehicles';
import type { VehicleClassId } from '../data/types';
import type { DistrictId } from '../game/types';
import { buildRoadGraph } from '../navigation/road-graph';
import { directionFromHeading, distance2d, headingFromDirection, moveTowards } from './math';
import { SimulationRandom } from './random';
import type {
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
  maximumNeighborDistance: 30,
  predictionSeconds: 2.2,
  conflictDistance: 3.6,
  brakingMetersPerSecondSquared: 9,
  maximumIntersectionWaitSeconds: 0.6,
  intersectionPrioritySeconds: 2,
  intersectionCreepSpeed: 1.2,
  intersectionStopDistance: 3.4,
  transitionAbandonSeconds: 0.8,
  pairPasses: 2,
});

/** Fixed-pool ceiling for predictive vehicle-to-vehicle work on one tick. */
export const TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK = (
  TRAFFIC_CAPACITY.high
  * (TRAFFIC_CAPACITY.high - 1)
  / 2
  * (TRAFFIC_LOCAL_AVOIDANCE.pairPasses + 1)
);

export interface TrafficAvoidanceDiagnostics {
  readonly lastTickPairChecks: number;
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
  panicRemaining: number;
  intersectionWaitSeconds: number;
  intersectionPriorityRemaining: number;
  intersectionTicket: number;
  transitionWaitSeconds: number;
  routeStep: number;
  lastJunction: TrafficRoadJunction | null;
  plannedTransition: PlannedRoadTransition | null;
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

export interface TrafficTickContext {
  deltaSeconds: number;
  playerPosition?: SimulationVec3;
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
  private quality: SimulationQuality;
  private requestedActorLimit = TRAFFIC_CAPACITY.high;
  private relevanceAnchor: SimulationVec3 | null = null;
  private relevanceRefreshElapsed = Number.POSITIVE_INFINITY;
  private readonly peerSpeedCaps = new Float64Array(TRAFFIC_CAPACITY.high);
  private readonly peerYieldKinds = new Uint8Array(TRAFFIC_CAPACITY.high);
  private readonly nearestConflictDistances = new Float64Array(TRAFFIC_CAPACITY.high);
  private lastTickPairChecks = 0;
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
    return { lastTickPairChecks: this.lastTickPairChecks };
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
    if (context.playerPosition && this.isFinitePosition(context.playerPosition)) {
      this.maintainPlayerRelevance(context.playerPosition, dt);
    }
    this.prepareLocalAvoidance(dt);
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
      const obstructed = this.isObstructed(agent, context.obstructions);
      const peerYieldKind = this.peerYieldKinds[agentIndex] ?? 0;
      const intersectionYield = !obstructed && (peerYieldKind & 2) !== 0;
      const followingYield = (peerYieldKind & 1) !== 0;

      let targetSpeed = agent.cruiseSpeed;
      if (agent.panicRemaining > 0) {
        agent.behavior = 'panic';
        targetSpeed *= 1.32;
        agent.blockedSeconds = 0;
        agent.intersectionWaitSeconds = 0;
      } else if (sirenNearby) {
        agent.behavior = 'siren-yield';
        targetSpeed = 1.5;
        agent.blockedSeconds = 0;
        agent.intersectionWaitSeconds = Math.max(0, agent.intersectionWaitSeconds - dt * 2);
      } else if (obstructed || intersectionYield || followingYield) {
        agent.behavior = intersectionYield ? 'intersection-yield' : 'yield';
        if (obstructed) {
          targetSpeed = 0;
        } else if (followingYield) {
          targetSpeed = Math.min(targetSpeed, this.peerSpeedCaps[agentIndex] ?? targetSpeed);
        } else if (intersectionYield) {
          targetSpeed = (this.nearestConflictDistances[agentIndex]
            ?? Number.POSITIVE_INFINITY) > TRAFFIC_LOCAL_AVOIDANCE.intersectionStopDistance
            ? TRAFFIC_LOCAL_AVOIDANCE.intersectionCreepSpeed
            : 0;
        }
        agent.blockedSeconds = obstructed
          ? agent.blockedSeconds + dt
          : Math.max(0, agent.blockedSeconds - dt * 2);
        const canRequestIntersectionPriority = intersectionYield && !followingYield;
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
      }

      if (agent.blockedSeconds > 1.5) {
        agent.behavior = 'recover';
        agent.recoveryRemaining = 0.8;
        agent.blockedSeconds = 0;
        continue;
      }

      const acceleration = targetSpeed > agent.speed ? 5.5 : 9;
      agent.speed = moveTowards(agent.speed, targetSpeed, acceleration * dt);
      const peerSpeedCap = this.peerSpeedCaps[agentIndex] ?? Number.POSITIVE_INFINITY;
      if (Number.isFinite(peerSpeedCap)) {
        agent.speed = Math.min(agent.speed, Math.max(0, peerSpeedCap));
      }
      this.advanceAgent(agent, dt, true);
    }
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
      panicRemaining: 0,
      intersectionWaitSeconds: 0,
      intersectionPriorityRemaining: 0,
      intersectionTicket: 0,
      transitionWaitSeconds: 0,
      routeStep: 0,
      lastJunction: null,
      plannedTransition: null,
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

  private prepareLocalAvoidance(deltaSeconds: number): void {
    this.peerSpeedCaps.fill(Number.POSITIVE_INFINITY);
    this.peerYieldKinds.fill(0);
    this.nearestConflictDistances.fill(Number.POSITIVE_INFINITY);
    this.lastTickPairChecks = 0;
    this.prepareNearestConflictDistances();

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
    const minimumDistance = TRAFFIC_LOCAL_AVOIDANCE.minimumCenterDistance;
    const leaderSpeed = Math.max(0, this.predictedSpeed(leaderIndex, leader));
    const followerSpeed = Math.max(0, this.predictedSpeed(followerIndex, follower));
    const relativeStoppingDistance = Math.max(
      0,
      (followerSpeed * followerSpeed - leaderSpeed * leaderSpeed)
        / (2 * TRAFFIC_LOCAL_AVOIDANCE.brakingMetersPerSecondSquared),
    );
    const desiredDistance = minimumDistance
      + Math.max(2.5, followerSpeed * 0.55)
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
      ? Math.min(agent.speed, speedCap)
      : agent.speed;
  }

  private hasTrafficPriority(
    first: Readonly<TrafficAgent>,
    second: Readonly<TrafficAgent>,
  ): boolean {
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
      const arrivalDifference = firstDistanceToConflict - secondDistanceToConflict;
      if (Math.abs(arrivalDifference) > 0.25) return arrivalDifference < 0;
    }
    return this.hasTrafficPriority(first, second);
  }

  private isObstructed(agent: TrafficAgent, obstacles: readonly SimulationObstacle[]): boolean {
    const direction = directionFromHeading(agent.heading);
    for (const obstacle of obstacles) {
      const deltaX = obstacle.x - agent.position.x;
      const deltaZ = obstacle.z - agent.position.z;
      const ahead = deltaX * direction.x + deltaZ * direction.z;
      const sideways = Math.abs(deltaX * direction.z - deltaZ * direction.x);
      if (ahead > 0 && ahead < 10 && sideways < obstacle.radius + 1.2) {
        return true;
      }
    }

    return false;
  }

  private finishLocalRecovery(agent: TrafficAgent): void {
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

  private recycleAgent(agent: TrafficAgent): void {
    if (this.relevanceAnchor && this.placeAgentNearPlayer(agent, this.relevanceAnchor)) {
      return;
    }
    agent.roadIndex = (agent.roadIndex + 1 + this.random.integer(0, this.roads.length - 1)) % this.roads.length;
    agent.direction = this.random.next() > 0.5 ? 1 : -1;
    this.resetAgentForPlacement(agent);
    this.placeOnRoad(agent, this.random.range(-0.45, 0.45));
    this.assignVehicleClass(agent);
  }

  private resetAgentForPlacement(agent: TrafficAgent): void {
    agent.speed = 0;
    agent.behavior = 'cruise';
    agent.blockedSeconds = 0;
    agent.recoveryRemaining = 0;
    agent.panicRemaining = 0;
    agent.intersectionWaitSeconds = 0;
    agent.routeStep = 0;
    agent.lastJunction = null;
    agent.plannedTransition = null;
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
        && agent.behavior === 'cruise'
        && agent.panicRemaining <= 0
        && agent.recoveryRemaining <= 0
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
  }
}
