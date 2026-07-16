import {
  directionFromHeading,
  distance2d,
  headingFromDirection,
  normalize2d,
  pointBlocked,
} from './math';
import type { SimulationRandom } from './random';
import type {
  CombatBehavior,
  CombatRole,
  CombatantSnapshot,
  EnemyDamageEvent,
  PlayerDamageEvent,
  SimulationObstacle,
  SimulationQuality,
  SimulationVec3,
} from './types';
import type { WeaponTarget } from './weapons';

export const COMBAT_CAPACITY: Readonly<Record<SimulationQuality, number>> = Object.freeze({
  low: 8,
  high: 20,
});

interface RoleTuning {
  maxHealth: number;
  moveSpeed: number;
  preferredDistance: number;
  attackRange: number;
  attackDamage: number;
  attackCooldown: number;
  detectionRange: number;
  retreatHealthRatio: number;
}

const ROLE_TUNING: Readonly<Record<CombatRole, RoleTuning>> = Object.freeze({
  brawler: {
    maxHealth: 95,
    moveSpeed: 4.4,
    preferredDistance: 1.5,
    attackRange: 2.3,
    attackDamage: 14,
    attackCooldown: 0.9,
    detectionRange: 24,
    retreatHealthRatio: 0,
  },
  gunner: {
    maxHealth: 78,
    moveSpeed: 3.3,
    preferredDistance: 13,
    attackRange: 30,
    attackDamage: 8,
    attackCooldown: 0.42,
    detectionRange: 34,
    retreatHealthRatio: 0.16,
  },
  flanker: {
    maxHealth: 72,
    moveSpeed: 4.2,
    preferredDistance: 10,
    attackRange: 25,
    attackDamage: 7,
    attackCooldown: 0.36,
    detectionRange: 36,
    retreatHealthRatio: 0.2,
  },
  heavy: {
    maxHealth: 155,
    moveSpeed: 2.25,
    preferredDistance: 8,
    attackRange: 24,
    attackDamage: 13,
    attackCooldown: 0.7,
    detectionRange: 31,
    retreatHealthRatio: 0,
  },
  marksman: {
    maxHealth: 64,
    moveSpeed: 2.8,
    preferredDistance: 28,
    attackRange: 58,
    attackDamage: 18,
    attackCooldown: 1.2,
    detectionRange: 52,
    retreatHealthRatio: 0.25,
  },
});

interface CombatAgent {
  id: string;
  active: boolean;
  role: CombatRole;
  position: SimulationVec3;
  heading: number;
  health: number;
  maxHealth: number;
  behavior: CombatBehavior;
  alertness: number;
  attackRemaining: number;
  stateRemaining: number;
  defeatedRemaining: number;
  patrolTarget: SimulationVec3;
  lastKnownPlayer: SimulationVec3;
  flankSign: 1 | -1;
}

export interface CombatTickContext {
  deltaSeconds: number;
  playerPosition: SimulationVec3;
  playerThreatening: boolean;
  obstructions: readonly SimulationObstacle[];
}

export class CombatSystem {
  private readonly random: SimulationRandom;
  private readonly agents: CombatAgent[];
  private readonly onEnemyDamage: (event: EnemyDamageEvent) => void;
  private readonly onPlayerDamage: (event: PlayerDamageEvent) => void;
  private quality: SimulationQuality;
  private spawnLimit: number;

  public constructor(
    random: SimulationRandom,
    quality: SimulationQuality,
    onEnemyDamage: (event: EnemyDamageEvent) => void,
    onPlayerDamage: (event: PlayerDamageEvent) => void,
  ) {
    this.random = random;
    this.quality = quality;
    this.spawnLimit = COMBAT_CAPACITY[quality];
    this.onEnemyDamage = onEnemyDamage;
    this.onPlayerDamage = onPlayerDamage;
    this.agents = Array.from({ length: COMBAT_CAPACITY.high }, (_, index) => this.createPoolAgent(index));
  }

  public setQuality(quality: SimulationQuality): void {
    this.quality = quality;
    this.spawnLimit = COMBAT_CAPACITY[quality];
    this.agents.forEach((agent, index) => {
      if (index >= this.spawnLimit) {
        agent.active = false;
      }
    });
  }

  public seedEncounter(center: Readonly<SimulationVec3>): void {
    const roles: readonly CombatRole[] = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'];
    roles.forEach((role, index) => {
      const angle = (index / roles.length) * Math.PI * 2;
      const radius = 16 + index * 3;
      this.spawn(role, {
        x: center.x + Math.cos(angle) * radius,
        y: 0,
        z: center.z + Math.sin(angle) * radius,
      });
    });
  }

  public spawn(role: CombatRole, position: Readonly<SimulationVec3>): string | null {
    const agent = this.agents.slice(0, this.spawnLimit).find((candidate) => !candidate.active);
    if (!agent) {
      return null;
    }
    const tuning = ROLE_TUNING[role];
    agent.active = true;
    agent.role = role;
    agent.position = { ...position };
    agent.heading = this.random.range(-Math.PI, Math.PI);
    agent.health = tuning.maxHealth;
    agent.maxHealth = tuning.maxHealth;
    agent.behavior = 'patrol';
    agent.alertness = 0;
    agent.attackRemaining = this.random.range(0, tuning.attackCooldown);
    agent.stateRemaining = this.random.range(0.8, 2.2);
    agent.defeatedRemaining = 0;
    agent.lastKnownPlayer = { ...position };
    agent.flankSign = this.random.next() > 0.5 ? 1 : -1;
    this.choosePatrolTarget(agent);
    return agent.id;
  }

  public damage(targetId: string, amount: number, sourceId: string): EnemyDamageEvent | null {
    const agent = this.agents.find((candidate) => candidate.id === targetId && candidate.active);
    if (!agent || agent.behavior === 'defeated' || amount <= 0) {
      return null;
    }
    agent.health = Math.max(0, agent.health - amount);
    agent.behavior = agent.health <= 0 ? 'defeated' : 'engage';
    agent.alertness = 1;
    if (agent.health <= 0) {
      agent.defeatedRemaining = 1.1;
    }
    const event: EnemyDamageEvent = {
      targetId,
      sourceId,
      amount,
      remainingHealth: agent.health,
      defeated: agent.health <= 0,
      effect: 'abstract-impact-flash',
    };
    this.onEnemyDamage(event);
    return event;
  }

  public alertAt(position: Readonly<SimulationVec3>, radius: number): void {
    for (const agent of this.agents) {
      if (!agent.active || agent.behavior === 'defeated' || distance2d(agent.position, position) > radius) {
        continue;
      }
      agent.lastKnownPlayer = { ...position };
      agent.alertness = Math.max(agent.alertness, 0.62);
      if (agent.behavior === 'patrol') {
        agent.behavior = 'investigate';
      }
    }
  }

  public tick(context: CombatTickContext): void {
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    for (const agent of this.agents) {
      if (!agent.active) {
        continue;
      }
      if (agent.behavior === 'defeated') {
        agent.defeatedRemaining -= dt;
        if (agent.defeatedRemaining <= 0) {
          agent.active = false;
        }
        continue;
      }

      agent.attackRemaining = Math.max(0, agent.attackRemaining - dt);
      const tuning = ROLE_TUNING[agent.role];
      const distance = distance2d(agent.position, context.playerPosition);
      if (context.playerThreatening && distance <= tuning.detectionRange) {
        agent.lastKnownPlayer = { ...context.playerPosition };
        if (agent.behavior === 'patrol' || agent.behavior === 'investigate') {
          agent.behavior = 'suspicious';
          agent.stateRemaining = this.random.range(0.35, 0.85);
        }
      }

      switch (agent.behavior) {
        case 'patrol':
          this.tickPatrol(agent, dt, context.obstructions);
          break;
        case 'investigate':
          this.tickInvestigate(agent, dt, context.obstructions);
          break;
        case 'suspicious':
          this.tickSuspicious(agent, dt, context.playerPosition);
          break;
        case 'engage':
          this.tickEngage(agent, tuning, dt, context.playerPosition, context.obstructions);
          break;
        case 'reposition':
          this.tickReposition(agent, tuning, dt, context.playerPosition, context.obstructions);
          break;
        case 'flee':
          this.tickFlee(agent, tuning, dt, context.playerPosition, context.obstructions);
          break;
      }
    }
  }

  public getWeaponTargets(): readonly WeaponTarget[] {
    return this.agents.map((agent) => ({
      id: agent.id,
      position: { ...agent.position, y: 0.9 },
      radius: agent.role === 'heavy' ? 0.78 : 0.56,
      active: agent.active && agent.behavior !== 'defeated',
    }));
  }

  public getSnapshot(): readonly CombatantSnapshot[] {
    return this.agents
      .filter((agent) => agent.active)
      .map((agent) => ({
        id: agent.id,
        role: agent.role,
        position: { ...agent.position },
        heading: agent.heading,
        health: agent.health,
        maxHealth: agent.maxHealth,
        behavior: agent.behavior,
        alertness: agent.alertness,
      }));
  }

  private createPoolAgent(index: number): CombatAgent {
    return {
      id: `combatant-${index.toString().padStart(2, '0')}`,
      active: false,
      role: 'brawler',
      position: { x: 0, y: 0, z: 0 },
      heading: 0,
      health: 0,
      maxHealth: ROLE_TUNING.brawler.maxHealth,
      behavior: 'patrol',
      alertness: 0,
      attackRemaining: 0,
      stateRemaining: 0,
      defeatedRemaining: 0,
      patrolTarget: { x: 0, y: 0, z: 0 },
      lastKnownPlayer: { x: 0, y: 0, z: 0 },
      flankSign: 1,
    };
  }

  private choosePatrolTarget(agent: CombatAgent): void {
    const direction = directionFromHeading(this.random.range(-Math.PI, Math.PI));
    const distance = this.random.range(4, 12);
    agent.patrolTarget = {
      x: agent.position.x + direction.x * distance,
      y: 0,
      z: agent.position.z + direction.z * distance,
    };
  }

  private tickPatrol(agent: CombatAgent, dt: number, obstacles: readonly SimulationObstacle[]): void {
    const delta = {
      x: agent.patrolTarget.x - agent.position.x,
      y: 0,
      z: agent.patrolTarget.z - agent.position.z,
    };
    if (Math.hypot(delta.x, delta.z) < 0.7) {
      this.choosePatrolTarget(agent);
      return;
    }
    this.moveAgent(agent, normalize2d(delta), 1.15, dt, obstacles);
    agent.alertness = Math.max(0, agent.alertness - dt * 0.08);
  }

  private tickInvestigate(agent: CombatAgent, dt: number, obstacles: readonly SimulationObstacle[]): void {
    const delta = {
      x: agent.lastKnownPlayer.x - agent.position.x,
      y: 0,
      z: agent.lastKnownPlayer.z - agent.position.z,
    };
    if (Math.hypot(delta.x, delta.z) < 1.5) {
      agent.behavior = 'suspicious';
      agent.stateRemaining = 1.2;
      return;
    }
    this.moveAgent(agent, normalize2d(delta), 2.2, dt, obstacles);
  }

  private tickSuspicious(agent: CombatAgent, dt: number, playerPosition: Readonly<SimulationVec3>): void {
    const direction = normalize2d({
      x: playerPosition.x - agent.position.x,
      y: 0,
      z: playerPosition.z - agent.position.z,
    });
    agent.heading = headingFromDirection(direction.x, direction.z);
    agent.alertness = Math.min(1, agent.alertness + dt * 0.8);
    agent.stateRemaining -= dt;
    if (agent.stateRemaining <= 0) {
      agent.behavior = 'engage';
    }
  }

  private tickEngage(
    agent: CombatAgent,
    tuning: RoleTuning,
    dt: number,
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const healthRatio = agent.health / agent.maxHealth;
    if (tuning.retreatHealthRatio > 0 && healthRatio <= tuning.retreatHealthRatio) {
      agent.behavior = 'flee';
      agent.stateRemaining = 4;
      return;
    }

    const distance = distance2d(agent.position, playerPosition);
    const towardPlayer = normalize2d({
      x: playerPosition.x - agent.position.x,
      y: 0,
      z: playerPosition.z - agent.position.z,
    });
    agent.heading = headingFromDirection(towardPlayer.x, towardPlayer.z);

    if (agent.role === 'flanker') {
      agent.behavior = 'reposition';
      agent.stateRemaining = this.random.range(0.8, 1.5);
      return;
    }
    if (agent.role === 'marksman' && distance < tuning.preferredDistance * 0.62) {
      agent.behavior = 'reposition';
      agent.stateRemaining = 1.2;
      return;
    }

    if (distance > tuning.preferredDistance * 1.15) {
      this.moveAgent(agent, towardPlayer, tuning.moveSpeed, dt, obstacles);
    } else if (distance < tuning.preferredDistance * 0.62 && agent.role !== 'brawler') {
      this.moveAgent(agent, { x: -towardPlayer.x, y: 0, z: -towardPlayer.z }, tuning.moveSpeed * 0.8, dt, obstacles);
    }
    this.tryAttack(agent, tuning, distance);
  }

  private tickReposition(
    agent: CombatAgent,
    tuning: RoleTuning,
    dt: number,
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const toward = normalize2d({
      x: playerPosition.x - agent.position.x,
      y: 0,
      z: playerPosition.z - agent.position.z,
    });
    const distance = distance2d(agent.position, playerPosition);
    const retreat = agent.role === 'marksman' && distance < tuning.preferredDistance;
    const direction = retreat
      ? { x: -toward.x, y: 0, z: -toward.z }
      : { x: -toward.z * agent.flankSign, y: 0, z: toward.x * agent.flankSign };
    this.moveAgent(agent, direction, tuning.moveSpeed, dt, obstacles);
    agent.stateRemaining -= dt;
    this.tryAttack(agent, tuning, distance);
    if (agent.stateRemaining <= 0) {
      agent.behavior = 'engage';
      agent.flankSign = agent.flankSign === 1 ? -1 : 1;
    }
  }

  private tickFlee(
    agent: CombatAgent,
    tuning: RoleTuning,
    dt: number,
    playerPosition: Readonly<SimulationVec3>,
    obstacles: readonly SimulationObstacle[],
  ): void {
    const away = normalize2d({
      x: agent.position.x - playerPosition.x,
      y: 0,
      z: agent.position.z - playerPosition.z,
    });
    this.moveAgent(agent, away, tuning.moveSpeed * 1.15, dt, obstacles);
    agent.stateRemaining -= dt;
    if (agent.stateRemaining <= 0) {
      agent.active = false;
    }
  }

  private tryAttack(agent: CombatAgent, tuning: RoleTuning, distance: number): void {
    if (distance > tuning.attackRange || agent.attackRemaining > 0) {
      return;
    }
    agent.attackRemaining = tuning.attackCooldown;
    this.onPlayerDamage({
      sourceId: agent.id,
      role: agent.role,
      amount: tuning.attackDamage,
      attack: agent.role === 'brawler' ? 'melee' : 'projectile',
    });
  }

  private moveAgent(
    agent: CombatAgent,
    direction: Readonly<SimulationVec3>,
    speed: number,
    dt: number,
    obstacles: readonly SimulationObstacle[],
  ): void {
    let movement = normalize2d(direction);
    let candidate = {
      x: agent.position.x + movement.x * speed * dt,
      y: 0,
      z: agent.position.z + movement.z * speed * dt,
    };
    if (pointBlocked(candidate, agent.role === 'heavy' ? 0.8 : 0.55, obstacles)) {
      movement = { x: -movement.z, y: 0, z: movement.x };
      candidate = {
        x: agent.position.x + movement.x * speed * dt,
        y: 0,
        z: agent.position.z + movement.z * speed * dt,
      };
    }
    if (!pointBlocked(candidate, agent.role === 'heavy' ? 0.8 : 0.55, obstacles)) {
      agent.position = candidate;
    }
    agent.heading = headingFromDirection(movement.x, movement.z);
  }
}
