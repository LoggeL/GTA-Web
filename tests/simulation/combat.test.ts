import { describe, expect, it } from 'vitest';

import { CombatSystem } from '../../src/simulation/combat';
import { SimulationRandom } from '../../src/simulation/random';
import type { CombatRole, EnemyDamageEvent, PlayerDamageEvent } from '../../src/simulation/types';

function advanceThreat(
  system: CombatSystem,
  playerPosition: { x: number; y: number; z: number },
  seconds: number,
): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) {
    system.tick({
      deltaSeconds: 0.1,
      playerPosition,
      playerThreatening: true,
      obstructions: [],
    });
  }
}

describe('combat role FSMs', () => {
  it('spawns all five roles with distinct durability and active behaviors', () => {
    const system = new CombatSystem(new SimulationRandom('roles'), 'low', () => undefined, () => undefined);
    const roles: readonly CombatRole[] = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'];
    roles.forEach((role, index) => {
      expect(system.spawn(role, { x: index * 4, y: 0, z: -10 })).not.toBeNull();
    });
    const snapshot = system.getSnapshot();
    expect(snapshot.map((agent) => agent.role)).toEqual(roles);
    expect(snapshot.find((agent) => agent.role === 'heavy')?.maxHealth).toBeGreaterThan(
      snapshot.find((agent) => agent.role === 'marksman')?.maxHealth ?? 0,
    );
  });

  it('transitions through suspicion to role-specific engagement and attacks', () => {
    const attacks: PlayerDamageEvent[] = [];
    const system = new CombatSystem(
      new SimulationRandom('fsm'),
      'low',
      () => undefined,
      (event) => attacks.push(event),
    );
    const brawler = system.spawn('brawler', { x: 0, y: 0, z: -1.5 });
    const flanker = system.spawn('flanker', { x: 8, y: 0, z: -8 });
    const marksman = system.spawn('marksman', { x: 0, y: 0, z: -5 });
    expect(brawler).not.toBeNull();
    expect(flanker).not.toBeNull();
    expect(marksman).not.toBeNull();

    advanceThreat(system, { x: 0, y: 0, z: 0 }, 1.2);
    const behaviors = new Map(system.getSnapshot().map((agent) => [agent.id, agent.behavior]));
    expect(['engage', 'reposition']).toContain(behaviors.get(brawler ?? ''));
    expect(behaviors.get(flanker ?? '')).toBe('reposition');
    expect(behaviors.get(marksman ?? '')).toBe('reposition');
    expect(attacks.some((attack) => attack.role === 'brawler' && attack.attack === 'melee')).toBe(true);
  });

  it('investigates alerts and lets vulnerable roles flee at low health', () => {
    const system = new CombatSystem(new SimulationRandom('alert'), 'low', () => undefined, () => undefined);
    const flanker = system.spawn('flanker', { x: 6, y: 0, z: 0 });
    if (!flanker) {
      throw new Error('Failed to spawn flanker');
    }
    system.alertAt({ x: 0, y: 0, z: 0 }, 20);
    expect(system.getSnapshot()[0]?.behavior).toBe('investigate');
    system.damage(flanker, 60, 'player');
    system.tick({
      deltaSeconds: 0.1,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerThreatening: true,
      obstructions: [],
    });
    expect(system.getSnapshot()[0]?.behavior).toBe('flee');
  });
});

describe('non-graphic damage and defeat pooling', () => {
  it('emits abstract impact events, briefly shows defeat, then reuses the slot', () => {
    const damageEvents: EnemyDamageEvent[] = [];
    const system = new CombatSystem(
      new SimulationRandom('pool'),
      'low',
      (event) => damageEvents.push(event),
      () => undefined,
    );
    const firstId = system.spawn('gunner', { x: 0, y: 0, z: 0 });
    if (!firstId) {
      throw new Error('Failed to spawn gunner');
    }
    const defeated = system.damage(firstId, 1_000, 'player');
    expect(defeated?.defeated).toBe(true);
    expect(defeated?.effect).toBe('abstract-impact-flash');
    expect(system.getSnapshot()[0]?.behavior).toBe('defeated');

    for (let frame = 0; frame < 13; frame += 1) {
      system.tick({
        deltaSeconds: 0.1,
        playerPosition: { x: 50, y: 0, z: 50 },
        playerThreatening: false,
        obstructions: [],
      });
    }
    expect(system.getSnapshot()).toHaveLength(0);
    expect(system.spawn('heavy', { x: 2, y: 0, z: 2 })).toBe(firstId);
    expect(damageEvents).toHaveLength(1);
  });

  it('honors the adaptive combat pool ceiling', () => {
    const system = new CombatSystem(new SimulationRandom('ceiling'), 'low', () => undefined, () => undefined);
    for (let index = 0; index < 8; index += 1) {
      expect(system.spawn('brawler', { x: index, y: 0, z: 0 })).not.toBeNull();
    }
    expect(system.spawn('brawler', { x: 20, y: 0, z: 0 })).toBeNull();
    system.setQuality('high');
    expect(system.spawn('brawler', { x: 20, y: 0, z: 0 })).not.toBeNull();
  });
});

