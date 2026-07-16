import { distance2d, headingFromDirection, normalize2d } from './math';
import type { SimulationRandom } from './random';
import type {
  CrimeEvent,
  PedestrianBehavior,
  PedestrianSnapshot,
  SimulationQuality,
  SimulationRoadRecipe,
  SimulationVec3,
  WitnessReportEvent,
} from './types';

export const PEDESTRIAN_CAPACITY: Readonly<Record<SimulationQuality, number>> = Object.freeze({
  low: 18,
  high: 45,
});

interface PedestrianAgent {
  id: string;
  active: boolean;
  position: SimulationVec3;
  heading: number;
  speed: number;
  behavior: PedestrianBehavior;
  target: SimulationVec3;
  fleeFrom: SimulationVec3;
  stateRemaining: number;
  pendingCrime: CrimeEvent | null;
  lastWitnessedCrimeId: string | null;
}

const FALLBACK_ROAD: SimulationRoadRecipe = {
  id: 'pedestrian-fallback-road',
  position: { x: 0, y: 0, z: 0 },
  width: 300,
  depth: 18,
};

export class PedestrianSystem {
  private readonly random: SimulationRandom;
  private readonly roads: readonly SimulationRoadRecipe[];
  private readonly agents: PedestrianAgent[];
  private readonly report: (event: WitnessReportEvent) => void;
  private quality: SimulationQuality;

  public constructor(
    random: SimulationRandom,
    quality: SimulationQuality,
    roads: readonly SimulationRoadRecipe[],
    report: (event: WitnessReportEvent) => void,
  ) {
    this.random = random;
    this.quality = quality;
    this.roads = roads.length > 0 ? roads : [FALLBACK_ROAD];
    this.report = report;
    this.agents = Array.from({ length: PEDESTRIAN_CAPACITY.high }, (_, index) => this.createAgent(index));
    this.applyActiveCount();
  }

  public setQuality(quality: SimulationQuality): void {
    this.quality = quality;
    this.applyActiveCount();
  }

  public observeCrime(crime: CrimeEvent): void {
    for (const agent of this.agents) {
      if (!agent.active || agent.lastWitnessedCrimeId === crime.id || agent.pendingCrime !== null) {
        continue;
      }
      const distance = distance2d(agent.position, crime.position);
      if (distance > 34) {
        continue;
      }

      agent.pendingCrime = crime;
      agent.fleeFrom = { ...crime.position };
      if (distance < 8 && crime.severity >= 2) {
        agent.behavior = 'flee';
        agent.stateRemaining = this.random.range(1.1, 2.2);
      } else {
        agent.behavior = 'witness-report';
        agent.stateRemaining = this.random.range(0.65, 1.85);
        agent.speed = 0;
      }
    }
  }

  public triggerPanic(position: Readonly<SimulationVec3>, radius: number, duration: number): void {
    for (const agent of this.agents) {
      if (!agent.active || distance2d(agent.position, position) > radius) {
        continue;
      }
      agent.fleeFrom = { ...position };
      agent.behavior = 'flee';
      agent.stateRemaining = Math.max(agent.stateRemaining, duration);
    }
  }

  public tick(deltaSeconds: number, simulationTime: number): void {
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    for (const agent of this.agents) {
      if (!agent.active) {
        continue;
      }
      switch (agent.behavior) {
        case 'wander':
          this.tickWander(agent, dt);
          break;
        case 'flee':
          this.tickFlee(agent, dt);
          break;
        case 'witness-report':
          this.tickWitness(agent, dt, simulationTime);
          break;
      }
    }
  }

  public getSnapshot(): readonly PedestrianSnapshot[] {
    return this.agents
      .filter((agent) => agent.active)
      .map((agent) => ({
        id: agent.id,
        position: { ...agent.position },
        heading: agent.heading,
        speed: agent.speed,
        behavior: agent.behavior,
        pendingCrimeId: agent.pendingCrime?.id ?? null,
      }));
  }

  private createAgent(index: number): PedestrianAgent {
    const road = this.roads[index % this.roads.length] ?? FALLBACK_ROAD;
    const vertical = road.depth > road.width;
    const normalizedAlong = this.random.range(-0.47, 0.47);
    const side = this.random.next() > 0.5 ? 1 : -1;
    const sidewalkOffset = (vertical ? road.width : road.depth) / 2 + this.random.range(2.2, 4.4);
    const position: SimulationVec3 = vertical
      ? {
          x: road.position.x + side * sidewalkOffset,
          y: 0,
          z: road.position.z + normalizedAlong * road.depth,
        }
      : {
          x: road.position.x + normalizedAlong * road.width,
          y: 0,
          z: road.position.z + side * sidewalkOffset,
        };
    const agent: PedestrianAgent = {
      id: `pedestrian-${index.toString().padStart(2, '0')}`,
      active: false,
      position,
      heading: 0,
      speed: 0,
      behavior: 'wander',
      target: { ...position },
      fleeFrom: { ...position },
      stateRemaining: 0,
      pendingCrime: null,
      lastWitnessedCrimeId: null,
    };
    this.chooseWanderTarget(agent);
    return agent;
  }

  private applyActiveCount(): void {
    const count = PEDESTRIAN_CAPACITY[this.quality];
    this.agents.forEach((agent, index) => {
      const shouldBeActive = index < count;
      if (shouldBeActive && !agent.active) {
        agent.active = true;
        agent.behavior = 'wander';
        this.chooseWanderTarget(agent);
      } else if (!shouldBeActive) {
        agent.active = false;
      }
    });
  }

  private chooseWanderTarget(agent: PedestrianAgent): void {
    const angle = this.random.range(0, Math.PI * 2);
    const distance = this.random.range(6, 22);
    agent.target = {
      x: agent.position.x + Math.cos(angle) * distance,
      y: 0,
      z: agent.position.z + Math.sin(angle) * distance,
    };
    agent.speed = this.random.range(0.8, 1.45);
  }

  private tickWander(agent: PedestrianAgent, deltaSeconds: number): void {
    const delta = {
      x: agent.target.x - agent.position.x,
      y: 0,
      z: agent.target.z - agent.position.z,
    };
    const remaining = Math.hypot(delta.x, delta.z);
    if (remaining < 0.5) {
      this.chooseWanderTarget(agent);
      return;
    }
    const direction = normalize2d(delta);
    agent.position.x += direction.x * agent.speed * deltaSeconds;
    agent.position.z += direction.z * agent.speed * deltaSeconds;
    agent.heading = headingFromDirection(direction.x, direction.z);
  }

  private tickFlee(agent: PedestrianAgent, deltaSeconds: number): void {
    const direction = normalize2d({
      x: agent.position.x - agent.fleeFrom.x,
      y: 0,
      z: agent.position.z - agent.fleeFrom.z,
    });
    agent.speed = 3.7;
    agent.position.x += direction.x * agent.speed * deltaSeconds;
    agent.position.z += direction.z * agent.speed * deltaSeconds;
    agent.heading = headingFromDirection(direction.x, direction.z);
    agent.stateRemaining -= deltaSeconds;
    if (agent.stateRemaining <= 0) {
      if (agent.pendingCrime) {
        agent.behavior = 'witness-report';
        agent.stateRemaining = this.random.range(0.4, 1.1);
        agent.speed = 0;
      } else {
        agent.behavior = 'wander';
        this.chooseWanderTarget(agent);
      }
    }
  }

  private tickWitness(agent: PedestrianAgent, deltaSeconds: number, simulationTime: number): void {
    agent.speed = 0;
    agent.stateRemaining -= deltaSeconds;
    if (agent.stateRemaining > 0 || !agent.pendingCrime) {
      return;
    }
    const crime = agent.pendingCrime;
    const distance = distance2d(agent.position, crime.position);
    this.report({
      crimeId: crime.id,
      witnessId: agent.id,
      position: { ...agent.position },
      confidence: Math.max(0.35, Math.min(1, 1 - distance / 55 + crime.severity * 0.06)),
      simulationTime,
    });
    agent.lastWitnessedCrimeId = crime.id;
    agent.pendingCrime = null;
    agent.behavior = 'wander';
    this.chooseWanderTarget(agent);
  }
}

