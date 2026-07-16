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
  low: 10,
  high: 24,
});

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

function intersectionOf(
  first: Readonly<SimulationRoadRecipe>,
  second: Readonly<SimulationRoadRecipe>,
): Readonly<SimulationVec3> | null {
  const firstVertical = roadIsVertical(first);
  if (firstVertical === roadIsVertical(second)) {
    return null;
  }
  const vertical = firstVertical ? first : second;
  const horizontal = firstVertical ? second : first;
  const x = vertical.position.x;
  const z = horizontal.position.z;
  if (
    Math.abs(z - vertical.position.z) > vertical.depth / 2
    || Math.abs(x - horizontal.position.x) > horizontal.width / 2
  ) {
    return null;
  }
  return { x, y: 0, z };
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

  public triggerPanic(position: Readonly<SimulationVec3>, radius: number, duration: number): void {
    for (const agent of this.agents) {
      if (agent.active && distance2d(agent.position, position) <= radius) {
        agent.panicRemaining = Math.max(agent.panicRemaining, duration);
      }
    }
  }

  public tick(context: TrafficTickContext): void {
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    for (const agent of this.agents) {
      if (!agent.active) {
        continue;
      }

      agent.panicRemaining = Math.max(0, agent.panicRemaining - dt);
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
      const intersectionYield = !obstructed && this.shouldYieldAtIntersection(agent);

      let targetSpeed = agent.cruiseSpeed;
      if (agent.panicRemaining > 0) {
        agent.behavior = 'panic';
        targetSpeed *= 1.32;
        agent.blockedSeconds = 0;
      } else if (sirenNearby) {
        agent.behavior = 'siren-yield';
        targetSpeed = 1.5;
        agent.blockedSeconds = 0;
      } else if (obstructed || intersectionYield) {
        agent.behavior = intersectionYield ? 'intersection-yield' : 'yield';
        targetSpeed = 0;
        agent.blockedSeconds += dt;
      } else {
        agent.behavior = 'cruise';
        agent.blockedSeconds = Math.max(0, agent.blockedSeconds - dt * 2);
      }

      if (agent.blockedSeconds > 1.5) {
        agent.behavior = 'recover';
        agent.recoveryRemaining = 0.8;
        agent.blockedSeconds = 0;
        continue;
      }

      const acceleration = targetSpeed > agent.speed ? 5.5 : 9;
      agent.speed = moveTowards(agent.speed, targetSpeed, acceleration * dt);
      this.advanceAgent(agent, dt, true);
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
        if (!agent.hasActivated) {
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
        this.moveAgent(agent, beforeTransition);
        this.applyRoadTransition(agent, transition);
        this.moveAgent(agent, Math.max(0, travelDistance - beforeTransition));
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
  ): void {
    const targetRoad = this.roads[transition.roadIndex];
    if (!targetRoad) {
      agent.plannedTransition = null;
      return;
    }
    agent.roadIndex = transition.roadIndex;
    agent.direction = transition.direction;
    agent.laneOffset = laneOffsetForRoad(targetRoad, agent.direction);
    agent.heading = roadHeading(targetRoad, agent.direction);
    if (roadIsVertical(targetRoad)) {
      agent.position.x = targetRoad.position.x + agent.laneOffset;
    } else {
      agent.position.z = targetRoad.position.z + agent.laneOffset;
    }
    agent.position.y = 0;
    agent.lastJunction = transition.junction;
    agent.plannedTransition = null;
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

    for (const other of this.agents) {
      if (!other.active || other === agent || other.roadIndex !== agent.roadIndex || other.direction !== agent.direction) {
        continue;
      }
      const deltaX = other.position.x - agent.position.x;
      const deltaZ = other.position.z - agent.position.z;
      const ahead = deltaX * direction.x + deltaZ * direction.z;
      const sideways = Math.abs(deltaX * direction.z - deltaZ * direction.x);
      if (ahead > 0 && ahead < 7.5 && sideways < 1.4) {
        return true;
      }
    }
    return false;
  }

  private shouldYieldAtIntersection(agent: TrafficAgent): boolean {
    const road = this.roadFor(agent);
    for (const other of this.agents) {
      if (!other.active || other === agent || other.behavior === 'recover') {
        continue;
      }
      const otherRoad = this.roadFor(other);
      const intersection = intersectionOf(road, otherRoad);
      if (!intersection) {
        continue;
      }
      const ahead = distanceAhead(agent, intersection);
      const otherAhead = distanceAhead(other, intersection);
      if (ahead <= 0 || ahead > 11 || otherAhead < -3 || otherAhead > 11) {
        continue;
      }
      if (Boolean(road.major) !== Boolean(otherRoad.major)) {
        if (!road.major) {
          return true;
        }
        continue;
      }
      if (agent.id > other.id) {
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
    agent.plannedTransition = null;
  }

  private recycleAgent(agent: TrafficAgent): void {
    agent.roadIndex = (agent.roadIndex + 1 + this.random.integer(0, this.roads.length - 1)) % this.roads.length;
    agent.direction = this.random.next() > 0.5 ? 1 : -1;
    agent.speed = 0;
    agent.behavior = 'cruise';
    agent.blockedSeconds = 0;
    agent.recoveryRemaining = 0;
    agent.panicRemaining = 0;
    agent.routeStep = 0;
    agent.lastJunction = null;
    agent.plannedTransition = null;
    this.placeOnRoad(agent, this.random.range(-0.45, 0.45));
    this.assignVehicleClass(agent);
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
