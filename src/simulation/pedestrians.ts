import { distance2d, normalize2d } from './math';
import {
  buildNpcNavigationGraph,
  NpcNavigator,
} from './npcNavigation';
import type {
  NpcNavigationGraph,
  NpcNavigationStatus,
} from './npcNavigation';
import { npcHasLineOfSight } from './npcPerception';
import {
  chooseCivilianReaction,
} from './npcReactions';
import type {
  CivilianReaction,
  CivilianTemperament,
} from './npcReactions';
import type { SimulationRandom } from './random';
import type {
  CrimeEvent,
  PedestrianBehavior,
  PedestrianSnapshot,
  SimulationObstacle,
  SimulationQuality,
  SimulationRoadRecipe,
  SimulationVec3,
  WitnessReportEvent,
} from './types';

export const PEDESTRIAN_CAPACITY: Readonly<Record<SimulationQuality, number>> = Object.freeze({
  low: 18,
  high: 45,
});

export type PedestrianNpcState =
  | 'wander'
  | 'startle'
  | 'freeze'
  | 'flee'
  | 'witness-report'
  | 'recover';

export interface PedestrianTickContext {
  readonly obstacles?: readonly SimulationObstacle[];
}

export interface PedestrianNoiseEvent {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly radius: number;
  readonly severity: number;
  readonly directThreat?: boolean;
}

export interface PedestrianNpcSnapshot extends PedestrianSnapshot {
  readonly state: PedestrianNpcState;
  readonly temperament: CivilianTemperament;
  readonly reaction: CivilianReaction;
  readonly navigationStatus: NpcNavigationStatus;
  readonly recoveryCount: number;
  readonly stateRemaining: number;
}

interface PedestrianAgent {
  readonly id: string;
  readonly temperament: CivilianTemperament;
  readonly navigator: NpcNavigator;
  active: boolean;
  hasActivated: boolean;
  position: SimulationVec3;
  heading: number;
  speed: number;
  state: PedestrianNpcState;
  reaction: CivilianReaction;
  target: SimulationVec3;
  fleeFrom: SimulationVec3;
  stateRemaining: number;
  pendingCrime: CrimeEvent | null;
  lastWitnessedCrimeId: string | null;
  lastNoiseId: string | null;
}

const FALLBACK_ROAD: SimulationRoadRecipe = {
  id: 'pedestrian-fallback-road',
  position: { x: 0, y: 0, z: 0 },
  width: 300,
  depth: 18,
};

function legacyBehavior(state: PedestrianNpcState): PedestrianBehavior {
  if (state === 'flee') return 'flee';
  if (state === 'witness-report' || state === 'startle' || state === 'freeze') {
    return 'witness-report';
  }
  return 'wander';
}

function temperamentForIndex(index: number): CivilianTemperament {
  const temperaments: readonly CivilianTemperament[] = ['calm', 'cautious', 'nervous'];
  return temperaments[index % temperaments.length] ?? 'cautious';
}

export class PedestrianSystem {
  private readonly random: SimulationRandom;
  private readonly roads: readonly SimulationRoadRecipe[];
  private readonly navigationGraph: NpcNavigationGraph;
  private readonly agents: PedestrianAgent[];
  private readonly report: (event: WitnessReportEvent) => void;
  private quality: SimulationQuality;
  private requestedActorLimit = PEDESTRIAN_CAPACITY.high;

  public constructor(
    random: SimulationRandom,
    quality: SimulationQuality,
    roads: readonly SimulationRoadRecipe[],
    report: (event: WitnessReportEvent) => void,
  ) {
    this.random = random;
    this.quality = quality;
    this.roads = roads.length > 0 ? roads : [FALLBACK_ROAD];
    this.navigationGraph = buildNpcNavigationGraph(this.roads);
    this.report = report;
    this.agents = Array.from(
      { length: PEDESTRIAN_CAPACITY.high },
      (_, index) => this.createAgent(index),
    );
    this.applyActiveCount();
  }

  public setQuality(quality: SimulationQuality): void {
    this.quality = quality;
    this.applyActiveCount();
  }

  public setActorLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('pedestrian actor limit must be a non-negative safe integer');
    }
    this.requestedActorLimit = Math.min(limit, PEDESTRIAN_CAPACITY.high);
    this.applyActiveCount();
    return this.getActorLimit();
  }

  public getActorLimit(): number {
    return Math.min(this.requestedActorLimit, PEDESTRIAN_CAPACITY[this.quality]);
  }

  public getNavigationGraph(): NpcNavigationGraph {
    return this.navigationGraph;
  }

  public observeCrime(
    crime: CrimeEvent,
    obstacles: readonly SimulationObstacle[] = [],
  ): void {
    for (const agent of this.agents) {
      if (!agent.active || agent.lastWitnessedCrimeId === crime.id || agent.pendingCrime !== null) {
        continue;
      }
      const distance = distance2d(agent.position, crime.position);
      if (distance > 34) continue;
      const sawEvent = npcHasLineOfSight(agent.position, crime.position, obstacles);
      const reaction = chooseCivilianReaction({
        temperament: agent.temperament,
        severity: crime.severity,
        distance,
        sawEvent,
        directThreat: distance < 8 && crime.severity >= 2,
      });
      if (reaction === 'ignore') continue;
      agent.pendingCrime = crime;
      agent.fleeFrom = { ...crime.position };
      this.applyReaction(agent, reaction, crime.position);
    }
  }

  public hearNoise(event: Readonly<PedestrianNoiseEvent>): void {
    const radius = Math.max(0, event.radius);
    for (const agent of this.agents) {
      if (
        !agent.active
        || agent.lastNoiseId === event.id
        || distance2d(agent.position, event.position) > radius
      ) {
        continue;
      }
      agent.lastNoiseId = event.id;
      const reaction = chooseCivilianReaction({
        temperament: agent.temperament,
        severity: event.severity,
        distance: distance2d(agent.position, event.position),
        sawEvent: false,
        directThreat: Boolean(event.directThreat),
      });
      if (reaction !== 'ignore') this.applyReaction(agent, reaction, event.position);
    }
  }

  public triggerPanic(position: Readonly<SimulationVec3>, radius: number, duration: number): void {
    for (const agent of this.agents) {
      if (!agent.active || distance2d(agent.position, position) > radius) continue;
      agent.fleeFrom = { ...position };
      agent.reaction = 'flee';
      this.beginFlee(agent, position, Math.max(agent.stateRemaining, duration));
    }
  }

  public tick(
    deltaSeconds: number,
    simulationTime: number,
    context: Readonly<PedestrianTickContext> = {},
  ): void {
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    const obstacles = context.obstacles ?? [];
    for (const agent of this.agents) {
      if (!agent.active) continue;
      switch (agent.state) {
        case 'wander':
        case 'recover':
          this.tickWander(agent, dt, obstacles);
          break;
        case 'startle':
        case 'freeze':
          this.tickPauseReaction(agent, dt);
          break;
        case 'flee':
          this.tickFlee(agent, dt, obstacles);
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
        behavior: legacyBehavior(agent.state),
        pendingCrimeId: agent.pendingCrime?.id ?? null,
      }));
  }

  public getNpcSnapshot(): readonly PedestrianNpcSnapshot[] {
    return this.agents
      .filter((agent) => agent.active)
      .map((agent) => ({
        id: agent.id,
        position: { ...agent.position },
        heading: agent.heading,
        speed: agent.speed,
        behavior: legacyBehavior(agent.state),
        pendingCrimeId: agent.pendingCrime?.id ?? null,
        state: agent.state,
        temperament: agent.temperament,
        reaction: agent.reaction,
        navigationStatus: agent.navigator.getStatus(),
        recoveryCount: agent.navigator.getRecoveryCount(),
        stateRemaining: Math.max(0, agent.stateRemaining),
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
      temperament: temperamentForIndex(index),
      navigator: new NpcNavigator(this.navigationGraph, index % 2 === 0 ? 1 : -1),
      active: false,
      hasActivated: false,
      position,
      heading: 0,
      speed: 0,
      state: 'wander',
      reaction: 'ignore',
      target: { ...position },
      fleeFrom: { ...position },
      stateRemaining: 0,
      pendingCrime: null,
      lastWitnessedCrimeId: null,
      lastNoiseId: null,
    };
    this.chooseWanderTarget(agent);
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
          agent.state = 'wander';
          this.chooseWanderTarget(agent);
        }
      } else if (!shouldBeActive) {
        agent.active = false;
      }
    });
  }

  private chooseWanderTarget(agent: PedestrianAgent): void {
    const candidates = this.navigationGraph.nodes.filter((node) => {
      const distance = distance2d(agent.position, node.position);
      return distance >= 7 && distance <= 46;
    });
    const picked = candidates.length > 0
      ? candidates[this.random.integer(0, candidates.length - 1)]
      : undefined;
    if (picked) {
      agent.target = { ...picked.position };
    } else {
      const angle = this.random.range(0, Math.PI * 2);
      const distance = this.random.range(7, 20);
      agent.target = {
        x: agent.position.x + Math.cos(angle) * distance,
        y: 0,
        z: agent.position.z + Math.sin(angle) * distance,
      };
    }
    agent.speed = this.random.range(0.8, 1.45);
    agent.state = 'wander';
    agent.reaction = 'ignore';
    agent.navigator.setDestination(agent.position, agent.target);
  }

  private applyReaction(
    agent: PedestrianAgent,
    reaction: CivilianReaction,
    stimulusPosition: Readonly<SimulationVec3>,
  ): void {
    agent.reaction = reaction;
    if (reaction === 'flee') {
      this.beginFlee(agent, stimulusPosition, this.random.range(1.1, 2.2));
      return;
    }
    agent.navigator.clear();
    agent.speed = 0;
    if (reaction === 'report') {
      agent.state = 'witness-report';
      agent.stateRemaining = this.random.range(0.65, 1.85);
    } else if (reaction === 'freeze') {
      agent.state = 'freeze';
      agent.stateRemaining = this.random.range(0.45, 1.1);
    } else {
      agent.state = 'startle';
      agent.stateRemaining = this.random.range(0.25, 0.65);
    }
  }

  private beginFlee(
    agent: PedestrianAgent,
    stimulusPosition: Readonly<SimulationVec3>,
    duration: number,
  ): void {
    const away = normalize2d({
      x: agent.position.x - stimulusPosition.x,
      y: 0,
      z: agent.position.z - stimulusPosition.z,
    });
    agent.state = 'flee';
    agent.stateRemaining = Math.max(0.1, duration);
    agent.target = {
      x: agent.position.x + away.x * 24,
      y: agent.position.y,
      z: agent.position.z + away.z * 24,
    };
    agent.navigator.setDestination(agent.position, agent.target);
  }

  private tickWander(
    agent: PedestrianAgent,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const step = agent.navigator.step(agent.position, {
      deltaSeconds: dt,
      speed: agent.speed,
      radius: 0.32,
      obstacles,
    });
    agent.position = step.position;
    if (step.speed > 0) agent.heading = step.heading;
    agent.state = step.status === 'recovering' ? 'recover' : 'wander';
    if (step.status === 'arrived' || step.status === 'unreachable') {
      this.chooseWanderTarget(agent);
    }
  }

  private tickPauseReaction(agent: PedestrianAgent, dt: number): void {
    agent.speed = 0;
    agent.stateRemaining -= dt;
    if (agent.stateRemaining > 0) return;
    if (agent.pendingCrime) {
      agent.state = 'witness-report';
      agent.stateRemaining = this.random.range(0.35, 0.85);
    } else {
      this.chooseWanderTarget(agent);
    }
  }

  private tickFlee(
    agent: PedestrianAgent,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const step = agent.navigator.step(agent.position, {
      deltaSeconds: dt,
      speed: 3.7,
      radius: 0.32,
      obstacles,
    });
    agent.position = step.position;
    agent.speed = step.speed;
    if (step.speed > 0) agent.heading = step.heading;
    agent.stateRemaining -= dt;
    if (agent.stateRemaining > 0 && step.status !== 'unreachable') return;
    agent.speed = 0;
    if (agent.pendingCrime) {
      agent.state = 'witness-report';
      agent.stateRemaining = this.random.range(0.4, 1.1);
      agent.navigator.clear();
    } else {
      this.chooseWanderTarget(agent);
    }
  }

  private tickWitness(agent: PedestrianAgent, dt: number, simulationTime: number): void {
    agent.speed = 0;
    agent.stateRemaining -= dt;
    if (agent.stateRemaining > 0 || !agent.pendingCrime) {
      if (agent.stateRemaining <= 0 && !agent.pendingCrime) this.chooseWanderTarget(agent);
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
    this.chooseWanderTarget(agent);
  }
}
