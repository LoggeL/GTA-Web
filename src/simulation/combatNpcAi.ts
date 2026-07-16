import {
  distance2d,
  headingFromDirection,
  normalize2d,
} from './math';
import {
  buildNpcNavigationGraph,
  NpcNavigator,
} from './npcNavigation';
import type {
  NpcNavigationGraph,
  NpcNavigationStatus,
} from './npcNavigation';
import {
  npcHasLineOfSight,
  NpcPerceptionSensor,
  npcVisibilityFactor,
} from './npcPerception';
import type { NpcPerceptionSnapshot } from './npcPerception';
import {
  chooseCombatNpcTactic,
  COMBAT_ROLE_AI_PROFILES,
} from './npcReactions';
import type { CombatNpcTactic } from './npcReactions';
import { SimulationRandom } from './random';
import type {
  CombatBehavior,
  CombatantSnapshot,
  CombatRole,
  SimulationObstacle,
  SimulationQuality,
  SimulationVec3,
} from './types';

export const COMBAT_NPC_CAPACITY: Readonly<Record<SimulationQuality, number>> = Object.freeze({
  low: 8,
  high: 20,
});

export type CombatNpcState =
  | 'patrol'
  | 'investigate'
  | 'suspicious'
  | 'engage'
  | 'reposition'
  | 'flee'
  | 'surrender'
  | 'incapacitated';

export interface CombatNpcPlayerObservation {
  readonly id?: string;
  readonly position: SimulationVec3;
  readonly crouching?: boolean;
  readonly lightLevel?: number;
  readonly coverExposure?: number;
  readonly movement?: number;
  readonly noise?: number;
  readonly threatening?: boolean;
}

export interface CombatNpcTickContext {
  readonly deltaSeconds: number;
  readonly player: CombatNpcPlayerObservation;
  readonly obstacles?: readonly SimulationObstacle[];
}

export interface CombatNpcAction {
  readonly sourceId: string;
  readonly role: CombatRole;
  readonly type: 'melee-attack' | 'projectile-attack' | 'surrender' | 'incapacitated';
  readonly damage: number;
  readonly targetId: string | null;
  readonly position: SimulationVec3;
}

export interface CombatNpcDamageResult {
  readonly targetId: string;
  readonly appliedDamage: number;
  readonly remainingHealth: number;
  readonly incapacitated: boolean;
}

export interface CombatNpcSnapshot {
  readonly id: string;
  readonly role: CombatRole;
  readonly position: SimulationVec3;
  readonly velocity: SimulationVec3;
  readonly heading: number;
  readonly speed: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly state: CombatNpcState;
  readonly tactic: CombatNpcTactic;
  readonly perception: NpcPerceptionSnapshot;
  readonly navigationStatus: NpcNavigationStatus;
  readonly recoveryCount: number;
}

export interface CombatNpcAimTarget {
  readonly id: string;
  readonly position: SimulationVec3;
  readonly velocity: SimulationVec3;
  readonly radiusMeters: number;
  readonly active: boolean;
  readonly visible: boolean;
  readonly hostile: boolean;
}

export interface CombatNpcSystemOptions {
  readonly seed?: number | string;
  readonly quality?: SimulationQuality;
  readonly navigationGraph?: NpcNavigationGraph;
  readonly onAction?: (action: CombatNpcAction) => void;
}

interface CombatNpcAgent {
  readonly id: string;
  readonly navigator: NpcNavigator;
  perception: NpcPerceptionSensor;
  active: boolean;
  role: CombatRole;
  position: SimulationVec3;
  velocity: SimulationVec3;
  heading: number;
  health: number;
  state: CombatNpcState;
  tactic: CombatNpcTactic;
  stateRemaining: number;
  attackRemaining: number;
  inactiveRemaining: number;
  patrolCenter: SimulationVec3;
  patrolTarget: SimulationVec3;
  lastKnownPlayer: SimulationVec3;
  navigationDestination: SimulationVec3 | null;
  flankSign: 1 | -1;
}

const DIRECT_NAVIGATION_GRAPH = buildNpcNavigationGraph([]);
const MAX_PENDING_ACTIONS = 256;

function perceptionProfile(role: CombatRole) {
  const roleProfile = COMBAT_ROLE_AI_PROFILES[role];
  return {
    visionRange: roleProfile.visionRange,
    peripheralRange: role === 'brawler' ? 9 : 6,
    fieldOfViewRadians: role === 'marksman' ? Math.PI * 0.58 : Math.PI * 0.72,
    hearingRange: roleProfile.hearingRange,
    sightGainPerSecond: role === 'marksman' ? 0.9 : 0.78,
    hearingGainPerSecond: role === 'heavy' ? 0.64 : 0.52,
    awarenessDecayPerSecond: role === 'flanker' ? 0.09 : 0.12,
    memorySeconds: role === 'marksman' ? 7 : 5,
  };
}

function legacyBehavior(state: CombatNpcState): CombatBehavior {
  if (state === 'incapacitated') return 'defeated';
  if (state === 'surrender') return 'flee';
  return state;
}

function finiteDamage(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError('NPC damage must be finite');
  return Math.max(0, amount);
}

export class CombatNpcSystem {
  private readonly random: SimulationRandom;
  private readonly navigationGraph: NpcNavigationGraph;
  private readonly agents: CombatNpcAgent[];
  private readonly onAction: (action: CombatNpcAction) => void;
  private readonly pendingActions: CombatNpcAction[] = [];
  private readonly tickActions: CombatNpcAction[] = [];
  private quality: SimulationQuality;
  private requestedActorLimit = COMBAT_NPC_CAPACITY.high;

  public constructor(options: Readonly<CombatNpcSystemOptions> = {}) {
    this.random = new SimulationRandom(options.seed ?? 'solara-combat-npc-ai-v1');
    this.quality = options.quality ?? 'high';
    this.navigationGraph = options.navigationGraph ?? DIRECT_NAVIGATION_GRAPH;
    this.onAction = options.onAction ?? (() => undefined);
    this.agents = Array.from(
      { length: COMBAT_NPC_CAPACITY.high },
      (_, index) => this.createPoolAgent(index),
    );
  }

  public setQuality(quality: SimulationQuality): void {
    this.quality = quality;
  }

  public setActorLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('combat NPC actor limit must be a non-negative safe integer');
    }
    this.requestedActorLimit = Math.min(limit, COMBAT_NPC_CAPACITY.high);
    return this.getActorLimit();
  }

  public getActorLimit(): number {
    return Math.min(this.requestedActorLimit, COMBAT_NPC_CAPACITY[this.quality]);
  }

  public getPoolCapacity(): number {
    return COMBAT_NPC_CAPACITY.high;
  }

  public seedEncounter(center: Readonly<SimulationVec3>): readonly string[] {
    const roles: readonly CombatRole[] = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'];
    return roles.flatMap((role, index) => {
      const angle = (index / roles.length) * Math.PI * 2;
      const id = this.spawn(role, {
        x: center.x + Math.cos(angle) * (12 + index * 3),
        y: center.y,
        z: center.z + Math.sin(angle) * (12 + index * 3),
      });
      return id ? [id] : [];
    });
  }

  public spawn(
    role: CombatRole,
    position: Readonly<SimulationVec3>,
    patrolCenter: Readonly<SimulationVec3> = position,
  ): string | null {
    const agent = this.agents
      .slice(0, this.getActorLimit())
      .find((candidate) => !candidate.active);
    if (!agent) return null;
    const profile = COMBAT_ROLE_AI_PROFILES[role];
    agent.active = true;
    agent.role = role;
    agent.position = { ...position };
    agent.velocity = { x: 0, y: 0, z: 0 };
    agent.heading = this.random.range(-Math.PI, Math.PI);
    agent.health = profile.maxHealth;
    agent.state = 'patrol';
    agent.tactic = profile.baseTactic;
    agent.stateRemaining = this.random.range(1.2, 2.5);
    agent.attackRemaining = this.random.range(0, profile.attackCooldownSeconds);
    agent.inactiveRemaining = 0;
    agent.patrolCenter = { ...patrolCenter };
    agent.patrolTarget = { ...position };
    agent.lastKnownPlayer = { ...position };
    agent.navigationDestination = null;
    agent.flankSign = this.random.next() >= 0.5 ? 1 : -1;
    agent.perception = new NpcPerceptionSensor(perceptionProfile(role));
    agent.navigator.clear();
    this.choosePatrolTarget(agent);
    return agent.id;
  }

  public despawn(id: string): boolean {
    const agent = this.findActiveAgent(id);
    if (!agent) return false;
    this.deactivate(agent);
    return true;
  }

  public damage(
    id: string,
    amount: number,
    sourcePosition?: Readonly<SimulationVec3>,
  ): CombatNpcDamageResult | null {
    const agent = this.findActiveAgent(id);
    if (!agent || agent.state === 'incapacitated' || agent.state === 'surrender') return null;
    const appliedDamage = Math.min(agent.health, finiteDamage(amount));
    if (appliedDamage <= 0) return null;
    agent.health -= appliedDamage;
    if (sourcePosition) {
      agent.lastKnownPlayer = { ...sourcePosition };
      agent.perception.injectAlert(sourcePosition, 1);
    }
    if (agent.health <= 0) {
      agent.health = 0;
      agent.state = 'incapacitated';
      agent.tactic = 'surrender';
      agent.inactiveRemaining = 1.2;
      agent.navigator.clear();
      agent.velocity = { x: 0, y: 0, z: 0 };
      this.emitAction(agent, 'incapacitated', 0, null);
    } else {
      agent.state = 'engage';
      agent.stateRemaining = 0;
    }
    return {
      targetId: id,
      appliedDamage,
      remainingHealth: agent.health,
      incapacitated: agent.health <= 0,
    };
  }

  public alertAt(
    position: Readonly<SimulationVec3>,
    radius: number,
    strength = 0.72,
  ): void {
    const effectiveRadius = Math.max(0, radius);
    for (const agent of this.activeAgents()) {
      if (
        agent.state === 'incapacitated'
        || agent.state === 'surrender'
        || distance2d(agent.position, position) > effectiveRadius
      ) {
        continue;
      }
      agent.lastKnownPlayer = { ...position };
      agent.perception.injectAlert(position, strength);
      if (agent.state === 'patrol') {
        this.changeState(agent, 'investigate', this.random.range(3.5, 5.5));
        this.navigateTo(agent, position);
      }
    }
  }

  public tick(context: Readonly<CombatNpcTickContext>): readonly CombatNpcAction[] {
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    const obstacles = context.obstacles ?? [];
    this.tickActions.splice(0, this.tickActions.length);
    for (const agent of this.activeAgents()) {
      if (agent.state === 'incapacitated') {
        agent.inactiveRemaining -= dt;
        if (agent.inactiveRemaining <= 0) this.deactivate(agent);
        continue;
      }
      if (agent.state === 'surrender') {
        agent.velocity = { x: 0, y: 0, z: 0 };
        continue;
      }

      agent.attackRemaining = Math.max(0, agent.attackRemaining - dt);
      const visibility = npcVisibilityFactor({
        lightLevel: context.player.lightLevel,
        crouching: context.player.crouching,
        coverExposure: context.player.coverExposure,
        movement: context.player.movement,
      });
      const perception = agent.perception.tick({
        deltaSeconds: dt,
        observerPosition: agent.position,
        observerHeading: agent.heading,
        target: {
          id: context.player.id ?? 'player',
          position: context.player.position,
          visibility,
          noise: Math.max(0, context.player.noise ?? 0),
          threatening: Boolean(context.player.threatening),
        },
        obstacles,
      });
      if (perception.lastKnownPosition) {
        agent.lastKnownPlayer = { ...perception.lastKnownPosition };
      }
      this.applyPerceptionTransition(agent, perception);
      agent.stateRemaining -= dt;

      switch (agent.state) {
        case 'patrol':
          this.tickPatrol(agent, dt, obstacles);
          break;
        case 'investigate':
          this.tickInvestigate(agent, dt, obstacles);
          break;
        case 'suspicious':
          this.tickSuspicious(agent, perception, context.player.position);
          break;
        case 'engage':
          this.tickEngage(agent, dt, context, perception, obstacles);
          break;
        case 'reposition':
          this.tickReposition(agent, dt, context, perception, obstacles);
          break;
        case 'flee':
          this.tickFlee(agent, dt, context.player.position, obstacles);
          break;
      }
    }
    return [...this.tickActions];
  }

  public drainActions(): readonly CombatNpcAction[] {
    return this.pendingActions.splice(0, this.pendingActions.length);
  }

  public getSnapshot(): readonly CombatNpcSnapshot[] {
    return this.activeAgents().map((agent) => {
      const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
      return {
        id: agent.id,
        role: agent.role,
        position: { ...agent.position },
        velocity: { ...agent.velocity },
        heading: agent.heading,
        speed: Math.hypot(agent.velocity.x, agent.velocity.z),
        health: agent.health,
        maxHealth: profile.maxHealth,
        state: agent.state,
        tactic: agent.tactic,
        perception: agent.perception.getSnapshot(),
        navigationStatus: agent.navigator.getStatus(),
        recoveryCount: agent.navigator.getRecoveryCount(),
      };
    });
  }

  /** Compatibility adapter for the existing city-simulation visual contract. */
  public getLegacySnapshot(): readonly CombatantSnapshot[] {
    return this.getSnapshot().map((agent) => ({
      id: agent.id,
      role: agent.role,
      position: { ...agent.position },
      heading: agent.heading,
      health: agent.health,
      maxHealth: agent.maxHealth,
      behavior: legacyBehavior(agent.state),
      alertness: agent.perception.awareness,
    }));
  }

  public getAimTargets(): readonly CombatNpcAimTarget[] {
    return this.getSnapshot().map((agent) => ({
      id: agent.id,
      position: { ...agent.position, y: agent.position.y + 0.9 },
      velocity: { ...agent.velocity },
      radiusMeters: agent.role === 'heavy' ? 0.78 : 0.56,
      active: agent.state !== 'incapacitated',
      visible: agent.state !== 'incapacitated',
      hostile: agent.state !== 'incapacitated' && agent.state !== 'surrender',
    }));
  }

  private createPoolAgent(index: number): CombatNpcAgent {
    const role: CombatRole = 'brawler';
    return {
      id: `combatant-${index.toString().padStart(2, '0')}`,
      navigator: new NpcNavigator(this.navigationGraph, index % 2 === 0 ? 1 : -1),
      perception: new NpcPerceptionSensor(perceptionProfile(role)),
      active: false,
      role,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      heading: 0,
      health: 0,
      state: 'patrol',
      tactic: 'rush',
      stateRemaining: 0,
      attackRemaining: 0,
      inactiveRemaining: 0,
      patrolCenter: { x: 0, y: 0, z: 0 },
      patrolTarget: { x: 0, y: 0, z: 0 },
      lastKnownPlayer: { x: 0, y: 0, z: 0 },
      navigationDestination: null,
      flankSign: 1,
    };
  }

  private activeAgents(): CombatNpcAgent[] {
    return this.agents.slice(0, this.getActorLimit()).filter((agent) => agent.active);
  }

  private findActiveAgent(id: string): CombatNpcAgent | null {
    return this.activeAgents().find((agent) => agent.id === id) ?? null;
  }

  private deactivate(agent: CombatNpcAgent): void {
    agent.active = false;
    agent.velocity = { x: 0, y: 0, z: 0 };
    agent.navigator.clear();
    agent.navigationDestination = null;
  }

  private choosePatrolTarget(agent: CombatNpcAgent): void {
    const angle = this.random.range(-Math.PI, Math.PI);
    const distance = this.random.range(4, 11);
    agent.patrolTarget = {
      x: agent.patrolCenter.x + Math.cos(angle) * distance,
      y: agent.patrolCenter.y,
      z: agent.patrolCenter.z + Math.sin(angle) * distance,
    };
    this.navigateTo(agent, agent.patrolTarget);
  }

  private applyPerceptionTransition(
    agent: CombatNpcAgent,
    perception: Readonly<NpcPerceptionSnapshot>,
  ): void {
    if (agent.state === 'flee' || agent.state === 'reposition' || agent.state === 'engage') return;
    if (perception.band === 'detected') {
      if (agent.state !== 'suspicious') {
        this.changeState(agent, 'suspicious', 0.35);
      } else if (agent.stateRemaining <= 0) {
        this.changeState(agent, 'engage', 0);
      }
      return;
    }
    if (perception.band === 'suspicious' && perception.targetVisible) {
      if (agent.state === 'patrol' || agent.state === 'investigate') {
        this.changeState(agent, 'suspicious', 0.75);
      }
      return;
    }
    if (perception.band === 'curious' && agent.state === 'patrol') {
      this.changeState(agent, 'investigate', 4.5);
      this.navigateTo(agent, agent.lastKnownPlayer);
    }
  }

  private tickPatrol(
    agent: CombatNpcAgent,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const navigation = this.moveAlongNavigation(agent, 1.15, dt, obstacles);
    if (navigation === 'arrived' || navigation === 'unreachable') this.choosePatrolTarget(agent);
  }

  private tickInvestigate(
    agent: CombatNpcAgent,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    this.navigateTo(agent, agent.lastKnownPlayer);
    const navigation = this.moveAlongNavigation(agent, 2.25, dt, obstacles);
    if (navigation === 'arrived' || agent.stateRemaining <= 0) {
      this.changeState(agent, 'suspicious', 1.25);
    }
  }

  private tickSuspicious(
    agent: CombatNpcAgent,
    perception: Readonly<NpcPerceptionSnapshot>,
    playerPosition: Readonly<SimulationVec3>,
  ): void {
    agent.velocity = { x: 0, y: 0, z: 0 };
    const target = perception.targetVisible ? playerPosition : agent.lastKnownPlayer;
    const direction = normalize2d({
      x: target.x - agent.position.x,
      y: 0,
      z: target.z - agent.position.z,
    });
    agent.heading = headingFromDirection(direction.x, direction.z);
    if (agent.stateRemaining > 0) return;
    if (perception.band === 'detected') {
      this.changeState(agent, 'engage', 0);
    } else if (perception.band === 'unaware') {
      this.changeState(agent, 'patrol', 0);
      this.choosePatrolTarget(agent);
    } else {
      this.changeState(agent, 'investigate', 2.5);
      this.navigateTo(agent, agent.lastKnownPlayer);
    }
  }

  private tickEngage(
    agent: CombatNpcAgent,
    dt: number,
    context: Readonly<CombatNpcTickContext>,
    perception: Readonly<NpcPerceptionSnapshot>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    if (!perception.targetVisible && perception.secondsSinceSensed > 2.5) {
      this.changeState(agent, 'investigate', 4.5);
      this.navigateTo(agent, agent.lastKnownPlayer);
      return;
    }
    const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
    const playerDistance = distance2d(agent.position, context.player.position);
    const lineOfFire = npcHasLineOfSight(agent.position, context.player.position, obstacles);
    const tactic = chooseCombatNpcTactic({
      role: agent.role,
      healthRatio: agent.health / profile.maxHealth,
      playerDistance,
      playerVisible: perception.targetVisible,
      hasLineOfFire: lineOfFire,
    });
    agent.tactic = tactic;
    if (tactic === 'surrender') {
      this.changeState(agent, 'surrender', 0);
      this.emitAction(agent, 'surrender', 0, context.player.id ?? 'player');
      return;
    }
    if (tactic === 'retreat') {
      this.changeState(agent, 'flee', 5.5);
      this.setFleeDestination(agent, context.player.position);
      return;
    }
    if (tactic === 'flank') {
      this.changeState(agent, 'reposition', this.random.range(1.2, 2.1));
      this.setRepositionDestination(agent, context.player.position, false);
      return;
    }
    if (tactic === 'seek-distance' && playerDistance < profile.minimumDistance) {
      this.changeState(agent, 'reposition', 1.8);
      this.setRepositionDestination(agent, context.player.position, true);
      return;
    }

    const toward = normalize2d({
      x: context.player.position.x - agent.position.x,
      y: 0,
      z: context.player.position.z - agent.position.z,
    });
    if (playerDistance > profile.preferredDistance * 1.15) {
      this.moveDirect(agent, toward, profile.moveSpeed, dt, obstacles);
    } else if (playerDistance < profile.minimumDistance) {
      this.moveDirect(agent, { x: -toward.x, y: 0, z: -toward.z }, profile.moveSpeed * 0.85, dt, obstacles);
    } else {
      agent.velocity = { x: 0, y: 0, z: 0 };
      agent.heading = headingFromDirection(toward.x, toward.z);
    }
    this.tryAttack(agent, context.player, playerDistance, perception.targetVisible && lineOfFire);
  }

  private tickReposition(
    agent: CombatNpcAgent,
    dt: number,
    context: Readonly<CombatNpcTickContext>,
    perception: Readonly<NpcPerceptionSnapshot>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
    const navigation = this.moveAlongNavigation(agent, profile.moveSpeed, dt, obstacles);
    const playerDistance = distance2d(agent.position, context.player.position);
    const lineOfFire = npcHasLineOfSight(agent.position, context.player.position, obstacles);
    this.tryAttack(agent, context.player, playerDistance, perception.targetVisible && lineOfFire);
    if (navigation === 'arrived' || navigation === 'unreachable' || agent.stateRemaining <= 0) {
      agent.flankSign = agent.flankSign === 1 ? -1 : 1;
      this.changeState(agent, 'engage', 0);
    }
  }

  private tickFlee(
    agent: CombatNpcAgent,
    dt: number,
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    if (
      !agent.navigationDestination
      || distance2d(agent.navigationDestination, playerPosition) < 20
    ) {
      this.setFleeDestination(agent, playerPosition);
    }
    const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
    this.moveAlongNavigation(agent, profile.moveSpeed * 1.15, dt, obstacles);
    if (agent.stateRemaining <= 0) this.deactivate(agent);
  }

  private tryAttack(
    agent: CombatNpcAgent,
    player: Readonly<CombatNpcPlayerObservation>,
    distance: number,
    clearShot: boolean,
  ): void {
    const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
    if (distance > profile.attackRange || !clearShot || agent.attackRemaining > 0) return;
    agent.attackRemaining = profile.attackCooldownSeconds;
    this.emitAction(
      agent,
      agent.role === 'brawler' ? 'melee-attack' : 'projectile-attack',
      profile.attackDamage,
      player.id ?? 'player',
    );
  }

  private moveDirect(
    agent: CombatNpcAgent,
    direction: Readonly<SimulationVec3>,
    speed: number,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const destination = {
      x: agent.position.x + direction.x * Math.max(3, speed * 1.5),
      y: agent.position.y,
      z: agent.position.z + direction.z * Math.max(3, speed * 1.5),
    };
    this.navigateTo(agent, destination);
    this.moveAlongNavigation(agent, speed, dt, obstacles);
  }

  private navigateTo(agent: CombatNpcAgent, destination: Readonly<SimulationVec3>): void {
    if (
      agent.navigationDestination
      && distance2d(agent.navigationDestination, destination) <= 1.5
      && agent.navigator.getStatus() !== 'unreachable'
    ) {
      return;
    }
    agent.navigationDestination = { ...destination };
    agent.navigator.setDestination(agent.position, destination);
  }

  private moveAlongNavigation(
    agent: CombatNpcAgent,
    speed: number,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): NpcNavigationStatus {
    const previous = agent.position;
    const step = agent.navigator.step(agent.position, {
      deltaSeconds: dt,
      speed,
      radius: agent.role === 'heavy' ? 0.8 : 0.55,
      obstacles,
    });
    agent.position = step.position;
    agent.velocity = dt > 0
      ? {
          x: (step.position.x - previous.x) / dt,
          y: 0,
          z: (step.position.z - previous.z) / dt,
        }
      : { x: 0, y: 0, z: 0 };
    if (step.speed > 0) agent.heading = step.heading;
    return step.status;
  }

  private setRepositionDestination(
    agent: CombatNpcAgent,
    playerPosition: Readonly<SimulationVec3>,
    retreat: boolean,
  ): void {
    const toward = normalize2d({
      x: playerPosition.x - agent.position.x,
      y: 0,
      z: playerPosition.z - agent.position.z,
    });
    const profile = COMBAT_ROLE_AI_PROFILES[agent.role];
    const direction = retreat
      ? { x: -toward.x, y: 0, z: -toward.z }
      : { x: -toward.z * agent.flankSign, y: 0, z: toward.x * agent.flankSign };
    const distance = retreat ? 12 : Math.max(8, profile.preferredDistance * 0.8);
    this.navigateTo(agent, {
      x: agent.position.x + direction.x * distance,
      y: agent.position.y,
      z: agent.position.z + direction.z * distance,
    });
  }

  private setFleeDestination(
    agent: CombatNpcAgent,
    playerPosition: Readonly<SimulationVec3>,
  ): void {
    const away = normalize2d({
      x: agent.position.x - playerPosition.x,
      y: 0,
      z: agent.position.z - playerPosition.z,
    });
    this.navigateTo(agent, {
      x: agent.position.x + away.x * 30,
      y: agent.position.y,
      z: agent.position.z + away.z * 30,
    });
  }

  private changeState(
    agent: CombatNpcAgent,
    state: CombatNpcState,
    stateRemaining: number,
  ): void {
    agent.state = state;
    agent.stateRemaining = stateRemaining;
    if (state !== 'patrol' && state !== 'investigate' && state !== 'reposition' && state !== 'flee') {
      agent.navigator.clear();
      agent.navigationDestination = null;
    }
  }

  private emitAction(
    agent: CombatNpcAgent,
    type: CombatNpcAction['type'],
    damage: number,
    targetId: string | null,
  ): void {
    const action: CombatNpcAction = {
      sourceId: agent.id,
      role: agent.role,
      type,
      damage,
      targetId,
      position: { ...agent.position },
    };
    if (this.pendingActions.length >= MAX_PENDING_ACTIONS) this.pendingActions.shift();
    this.pendingActions.push(action);
    this.tickActions.push(action);
    this.onAction(action);
  }
}
