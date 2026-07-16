import { directionFromHeading, distance2d, headingFromDirection, moveTowards } from './math';
import type { SimulationRandom } from './random';
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

function normalizedRoads(roads: readonly SimulationRoadRecipe[] | undefined): readonly SimulationRoadRecipe[] {
  const valid = roads?.filter((road) => road.width > 2 && road.depth > 2) ?? [];
  return valid.length > 0 ? valid.map((road) => ({ ...road, position: { ...road.position } })) : DEFAULT_ROADS;
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

export class TrafficSystem {
  public readonly roads: readonly SimulationRoadRecipe[];

  private readonly random: SimulationRandom;
  private readonly agents: TrafficAgent[];
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
        this.advanceAgent(agent, dt);
        if (agent.recoveryRemaining <= 0) {
          this.reassignRoad(agent);
        }
        continue;
      }

      const sirenNearby = context.sirenPosition !== null
        && distance2d(agent.position, context.sirenPosition) <= context.sirenRadius;
      const obstructed = this.isObstructed(agent, context.obstructions);

      let targetSpeed = agent.cruiseSpeed;
      if (agent.panicRemaining > 0) {
        agent.behavior = 'panic';
        targetSpeed *= 1.32;
        agent.blockedSeconds = 0;
      } else if (sirenNearby) {
        agent.behavior = 'siren-yield';
        targetSpeed = 1.5;
        agent.blockedSeconds = 0;
      } else if (obstructed) {
        agent.behavior = 'yield';
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
      this.advanceAgent(agent, dt);
    }
  }

  public getSnapshot(): readonly TrafficVehicleSnapshot[] {
    return this.agents
      .filter((agent) => agent.active)
      .map((agent) => ({
        id: agent.id,
        position: { ...agent.position },
        heading: agent.heading,
        speed: agent.speed,
        behavior: agent.behavior,
        roadId: this.roadFor(agent).id,
        panicRemaining: agent.panicRemaining,
      }));
  }

  private createAgent(index: number): TrafficAgent {
    const agent: TrafficAgent = {
      id: `traffic-${index.toString().padStart(2, '0')}`,
      active: false,
      hasActivated: false,
      position: { x: 0, y: 0, z: 0 },
      heading: 0,
      speed: 0,
      cruiseSpeed: this.random.range(7.5, 13.5),
      behavior: 'cruise',
      roadIndex: index % this.roads.length,
      laneOffset: 0,
      direction: this.random.next() > 0.5 ? 1 : -1,
      blockedSeconds: 0,
      recoveryRemaining: 0,
      panicRemaining: 0,
    };
    this.placeOnRoad(agent, this.random.range(-0.48, 0.48));
    return agent;
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

  private roadFor(agent: TrafficAgent): SimulationRoadRecipe {
    const road = this.roads[agent.roadIndex];
    if (!road) {
      throw new Error('Traffic agent references a missing road');
    }
    return road;
  }

  private placeOnRoad(agent: TrafficAgent, normalizedAlong: number): void {
    const road = this.roadFor(agent);
    const vertical = roadIsVertical(road);
    const laneSign = agent.direction > 0 ? -1 : 1;
    const narrowSize = vertical ? road.width : road.depth;
    agent.laneOffset = laneSign * Math.max(1.7, narrowSize * 0.23);
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

  private advanceAgent(agent: TrafficAgent, deltaSeconds: number): void {
    const road = this.roadFor(agent);
    const direction = directionFromHeading(agent.heading);
    agent.position.x += direction.x * agent.speed * deltaSeconds;
    agent.position.z += direction.z * agent.speed * deltaSeconds;
    const vertical = roadIsVertical(road);
    const halfLength = (vertical ? road.depth : road.width) / 2;
    const along = vertical ? agent.position.z - road.position.z : agent.position.x - road.position.x;
    if (along > halfLength) {
      if (vertical) {
        agent.position.z = road.position.z - halfLength;
      } else {
        agent.position.x = road.position.x - halfLength;
      }
    } else if (along < -halfLength) {
      if (vertical) {
        agent.position.z = road.position.z + halfLength;
      } else {
        agent.position.x = road.position.x + halfLength;
      }
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

  private reassignRoad(agent: TrafficAgent): void {
    agent.roadIndex = (agent.roadIndex + 1 + this.random.integer(0, this.roads.length - 1)) % this.roads.length;
    agent.direction = this.random.next() > 0.5 ? 1 : -1;
    agent.speed = 0;
    agent.behavior = 'cruise';
    agent.recoveryRemaining = 0;
    this.placeOnRoad(agent, this.random.range(-0.45, 0.45));
  }
}
