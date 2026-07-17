import { distance2d, normalize2d, pointBlocked } from './math';
import {
  buildNpcNavigationGraph,
  NpcNavigator,
} from './npcNavigation';
import type {
  NpcNavigationGraph,
  NpcNavigationNode,
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
  low: 30,
  high: 72,
});

export const PEDESTRIAN_RELEVANCE_RADII = Object.freeze({
  /** Keeps population changes outside the close interaction/camera bubble. */
  minimumSpawnDistance: 26,
  maximumSpawnDistance: 108,
  /** Calm walkers beyond this radius are recycled onto a relevant sidewalk. */
  recycleBeyondDistance: 132,
  minimumPedestrianSpacing: 2.4,
});

/** Caps expensive relocation plus path setup work on every simulation tick. */
export const PEDESTRIAN_RELOCATION_BUDGET_PER_TICK = 3;

export const PEDESTRIAN_LOCAL_SEPARATION = Object.freeze({
  /** Two 0.32 m navigation capsules plus a small passing margin. */
  minimumDistance: 0.68,
  solverPasses: 4,
});

/**
 * Separation always scans the fixed actor pool. This makes the worst-case
 * neighbor work explicit instead of letting crowd density grow the hot path.
 */
export const PEDESTRIAN_SEPARATION_PAIR_BUDGET_PER_TICK = (
  PEDESTRIAN_CAPACITY.high
  * (PEDESTRIAN_CAPACITY.high - 1)
  / 2
  * PEDESTRIAN_LOCAL_SEPARATION.solverPasses
);

export interface PedestrianRelevanceDiagnostics {
  readonly cachedCandidateCount: number;
  readonly queuedRelocations: number;
  readonly candidateRebuildCount: number;
  readonly lastTickRelocationAttempts: number;
  readonly lastTickRelocations: number;
  readonly lastTickSeparationPairChecks: number;
}

export type PedestrianNpcState =
  | 'wander'
  | 'startle'
  | 'freeze'
  | 'flee'
  | 'witness-report'
  | 'recover';

export interface PedestrianTickContext {
  readonly obstacles?: readonly SimulationObstacle[];
  readonly playerPosition?: SimulationVec3;
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
const RELEVANCE_REFRESH_SECONDS = 0.5;
const RELEVANCE_REBASE_DISTANCE = 32;

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
  private relevanceAnchor: SimulationVec3 | null = null;
  private relevanceRefreshElapsed = Number.POSITIVE_INFINITY;
  private readonly relevanceCandidates: NpcNavigationNode[] = [];
  private readonly relocationQueue: PedestrianAgent[] = [];
  private readonly queuedRelocationIds = new Set<string>();
  private relocationQueueCursor = 0;
  private candidateRebuildCount = 0;
  private lastTickRelocationAttempts = 0;
  private lastTickRelocations = 0;
  private lastTickSeparationPairChecks = 0;

  public constructor(
    random: SimulationRandom,
    quality: SimulationQuality,
    roads: readonly SimulationRoadRecipe[],
    report: (event: WitnessReportEvent) => void,
  ) {
    this.random = random;
    this.quality = quality;
    this.roads = (roads.length > 0 ? roads : [FALLBACK_ROAD])
      .map((road) => ({ ...road, position: { ...road.position } }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(this.roads.map(({ id }) => id)).size !== this.roads.length) {
      throw new Error('Pedestrian roads require unique ids');
    }
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

  public getRelevanceDiagnostics(): PedestrianRelevanceDiagnostics {
    return {
      cachedCandidateCount: this.relevanceCandidates.length,
      queuedRelocations: this.relocationQueue.length - this.relocationQueueCursor,
      candidateRebuildCount: this.candidateRebuildCount,
      lastTickRelocationAttempts: this.lastTickRelocationAttempts,
      lastTickRelocations: this.lastTickRelocations,
      lastTickSeparationPairChecks: this.lastTickSeparationPairChecks,
    };
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
    this.lastTickRelocationAttempts = 0;
    this.lastTickRelocations = 0;
    this.lastTickSeparationPairChecks = 0;
    if (context.playerPosition && this.isFinitePosition(context.playerPosition)) {
      this.maintainPlayerRelevance(context.playerPosition, dt, obstacles);
    }
    for (const agent of this.agents) {
      if (!agent.active && agent.state === 'wander') continue;
      switch (agent.state) {
        case 'wander':
          this.tickWander(agent, dt, obstacles);
          break;
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
    this.resolveLocalSeparation(obstacles);
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
        }
        if (this.relevanceAnchor) {
          this.queueRelocationIfNeeded(agent, this.relevanceAnchor);
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

  private resolveLocalSeparation(obstacles: readonly SimulationObstacle[]): void {
    const minimumDistance = PEDESTRIAN_LOCAL_SEPARATION.minimumDistance;
    const minimumDistanceSquared = minimumDistance * minimumDistance;
    for (let pass = 0; pass < PEDESTRIAN_LOCAL_SEPARATION.solverPasses; pass += 1) {
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
          this.lastTickSeparationPairChecks += 1;

          let deltaX = second.position.x - first.position.x;
          let deltaZ = second.position.z - first.position.z;
          const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
          if (distanceSquared >= minimumDistanceSquared) continue;

          let distance = Math.sqrt(distanceSquared);
          if (distance < 0.000001) {
            // A stable axis derived from fixed pool slots keeps exact overlaps
            // deterministic without consuming random state.
            const fallback = (firstIndex * 31 + secondIndex * 17) & 3;
            deltaX = fallback === 0 ? 1 : fallback === 1 ? 0 : fallback === 2 ? -1 : 0;
            deltaZ = fallback === 0 ? 0 : fallback === 1 ? 1 : fallback === 2 ? 0 : -1;
            distance = 1;
          }
          const normalX = deltaX / distance;
          const normalZ = deltaZ / distance;
          const overlap = minimumDistance - Math.sqrt(distanceSquared);
          const passingSign = ((firstIndex + secondIndex) & 1) === 0 ? 1 : -1;
          const passingBias = Math.min(0.12, overlap * 0.24) * passingSign;
          const correctionX = normalX * overlap - normalZ * passingBias;
          const correctionZ = normalZ * overlap + normalX * passingBias;
          const firstMoving = this.agentCanSidestep(first);
          const secondMoving = this.agentCanSidestep(second);
          const firstShare = firstMoving === secondMoving ? 0.5 : firstMoving ? 1 : 0;
          const secondShare = firstMoving === secondMoving ? 0.5 : secondMoving ? 1 : 0;

          this.moveIfClear(
            first,
            -correctionX * firstShare,
            -correctionZ * firstShare,
            obstacles,
          );
          this.moveIfClear(
            second,
            correctionX * secondShare,
            correctionZ * secondShare,
            obstacles,
          );
        }
      }
    }
  }

  private agentCanSidestep(agent: Readonly<PedestrianAgent>): boolean {
    return agent.state === 'wander' || agent.state === 'recover' || agent.state === 'flee';
  }

  private moveIfClear(
    agent: PedestrianAgent,
    deltaX: number,
    deltaZ: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    if (Math.abs(deltaX) + Math.abs(deltaZ) < 0.000001) return;
    const originalX = agent.position.x;
    const originalZ = agent.position.z;
    agent.position.x = originalX + deltaX;
    agent.position.z = originalZ + deltaZ;
    if (!pointBlocked(agent.position, 0.32, obstacles)) return;

    agent.position.x = originalX + deltaX;
    agent.position.z = originalZ;
    if (!pointBlocked(agent.position, 0.32, obstacles)) return;

    agent.position.x = originalX;
    agent.position.z = originalZ + deltaZ;
    if (!pointBlocked(agent.position, 0.32, obstacles)) return;

    agent.position.x = originalX;
    agent.position.z = originalZ;
  }

  private maintainPlayerRelevance(
    playerPosition: Readonly<SimulationVec3>,
    deltaSeconds: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    this.relevanceRefreshElapsed += deltaSeconds;
    const firstSample = this.relevanceAnchor === null;
    const playerDisplacement = this.relevanceAnchor
      ? distance2d(this.relevanceAnchor, playerPosition)
      : Number.POSITIVE_INFINITY;
    const rebasing = firstSample || playerDisplacement >= RELEVANCE_REBASE_DISTANCE;
    if (rebasing) {
      this.relevanceAnchor = { ...playerPosition };
      this.rebuildRelevanceCandidates(playerPosition);
      this.clearRelocationQueue();
      this.enqueueFarAgents(playerPosition);
      this.relevanceRefreshElapsed = 0;
    } else if (this.relevanceRefreshElapsed >= RELEVANCE_REFRESH_SECONDS) {
      this.enqueueFarAgents(playerPosition);
      this.relevanceRefreshElapsed = 0;
    }
    this.processRelocationQueue(playerPosition, obstacles);
  }

  private rebuildRelevanceCandidates(playerPosition: Readonly<SimulationVec3>): void {
    this.relevanceCandidates.length = 0;
    for (const node of this.navigationGraph.nodes) {
      const distance = distance2d(node.position, playerPosition);
      if (
        distance >= PEDESTRIAN_RELEVANCE_RADII.minimumSpawnDistance
        && distance <= PEDESTRIAN_RELEVANCE_RADII.maximumSpawnDistance
      ) {
        this.relevanceCandidates.push(node);
      }
    }
    this.candidateRebuildCount += 1;
  }

  private clearRelocationQueue(): void {
    this.relocationQueue.length = 0;
    this.relocationQueueCursor = 0;
    this.queuedRelocationIds.clear();
  }

  private enqueueFarAgents(playerPosition: Readonly<SimulationVec3>): void {
    for (const agent of this.agents) {
      this.queueRelocationIfNeeded(agent, playerPosition);
    }
  }

  private queueRelocationIfNeeded(
    agent: PedestrianAgent,
    playerPosition: Readonly<SimulationVec3>,
  ): void {
    if (
      !this.queuedRelocationIds.has(agent.id)
      && agent.active
      && agent.state === 'wander'
      && agent.pendingCrime === null
      && distance2d(agent.position, playerPosition)
        > PEDESTRIAN_RELEVANCE_RADII.recycleBeyondDistance
    ) {
      this.queuedRelocationIds.add(agent.id);
      this.relocationQueue.push(agent);
    }
  }

  private processRelocationQueue(
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    while (
      this.lastTickRelocationAttempts < PEDESTRIAN_RELOCATION_BUDGET_PER_TICK
      && this.relocationQueueCursor < this.relocationQueue.length
    ) {
      const agent = this.relocationQueue[this.relocationQueueCursor];
      this.relocationQueueCursor += 1;
      this.lastTickRelocationAttempts += 1;
      if (!agent) continue;
      this.queuedRelocationIds.delete(agent.id);
      if (
        agent.active
        && agent.state === 'wander'
        && agent.pendingCrime === null
        && distance2d(agent.position, playerPosition)
          > PEDESTRIAN_RELEVANCE_RADII.recycleBeyondDistance
        && this.placeAgentNearPlayer(agent, playerPosition, obstacles)
      ) {
        this.lastTickRelocations += 1;
      }
    }
    if (this.relocationQueueCursor >= this.relocationQueue.length) {
      this.clearRelocationQueue();
    }
  }

  private placeAgentNearPlayer(
    agent: PedestrianAgent,
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): boolean {
    if (this.relevanceCandidates.length === 0) return false;

    const startIndex = this.random.integer(0, this.relevanceCandidates.length - 1);
    for (let offset = 0; offset < this.relevanceCandidates.length; offset += 1) {
      const node = this.relevanceCandidates[
        (startIndex + offset) % this.relevanceCandidates.length
      ];
      const playerDistance = node ? distance2d(node.position, playerPosition) : 0;
      if (
        !node
        || playerDistance < PEDESTRIAN_RELEVANCE_RADII.minimumSpawnDistance
        || playerDistance > PEDESTRIAN_RELEVANCE_RADII.maximumSpawnDistance
        || pointBlocked(node.position, 0.38, obstacles)
        || this.agents.some((other) => (
          other.active
          && other !== agent
          && distance2d(node.position, other.position)
            < PEDESTRIAN_RELEVANCE_RADII.minimumPedestrianSpacing
        ))
      ) {
        continue;
      }
      agent.navigator.clear();
      agent.position = { ...node.position };
      agent.heading = 0;
      agent.speed = 0;
      agent.state = 'wander';
      agent.reaction = 'ignore';
      agent.target = { ...node.position };
      agent.fleeFrom = { ...node.position };
      agent.stateRemaining = 0;
      agent.pendingCrime = null;
      this.chooseWanderTargetFromNode(agent, node);
      return true;
    }
    return false;
  }

  private chooseWanderTargetFromNode(
    agent: PedestrianAgent,
    node: Readonly<NpcNavigationNode>,
  ): void {
    let picked: NpcNavigationNode | undefined;
    if (node.neighbors.length > 0) {
      const startIndex = this.random.integer(0, node.neighbors.length - 1);
      for (let offset = 0; offset < node.neighbors.length; offset += 1) {
        const neighborId = node.neighbors[(startIndex + offset) % node.neighbors.length];
        const neighbor = neighborId
          ? this.navigationGraph.nodeById.get(neighborId)
          : undefined;
        if (neighbor && distance2d(node.position, neighbor.position) > 0.05) {
          picked = neighbor;
          break;
        }
      }
    }
    if (!picked) {
      this.chooseWanderTarget(agent);
      return;
    }
    agent.target = { ...picked.position };
    agent.speed = this.random.range(0.8, 1.45);
    agent.state = 'wander';
    agent.reaction = 'ignore';
    agent.navigator.setDestination(agent.position, agent.target);
  }

  private isFinitePosition(position: Readonly<SimulationVec3>): boolean {
    return Number.isFinite(position.x)
      && Number.isFinite(position.y)
      && Number.isFinite(position.z);
  }
}
