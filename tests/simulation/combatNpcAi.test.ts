import { describe, expect, it } from 'vitest';

import {
  COMBAT_NPC_CAPACITY,
  CombatNpcSystem,
} from '../../src/simulation/combatNpcAi';
import type {
  CombatNpcAction,
  CombatNpcSystemOptions,
  CombatNpcTickContext,
} from '../../src/simulation/combatNpcAi';
import type { CombatRole } from '../../src/simulation/types';

const roles: readonly CombatRole[] = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'];

function createSeededEncounter(options: Readonly<CombatNpcSystemOptions> = {}): CombatNpcSystem {
  const system = new CombatNpcSystem({ seed: 'combat-npc-test', quality: 'low', ...options });
  const distances = [1.6, 14, 11, 8.5, 30];
  roles.forEach((role, index) => {
    expect(system.spawn(role, {
      x: 0,
      y: 0,
      z: -(distances[index] ?? 10),
    })).not.toBeNull();
  });
  return system;
}

function combatContext(overrides: Partial<CombatNpcTickContext['player']> = {}): CombatNpcTickContext {
  return {
    deltaSeconds: 0.1,
    player: {
      id: 'player',
      position: { x: 0, y: 0, z: 0 },
      lightLevel: 1,
      movement: 1,
      noise: 1,
      threatening: true,
      ...overrides,
    },
    obstacles: [],
  };
}

describe('combat NPC deterministic roles and pooling', () => {
  it('preallocates a bounded pool and preserves hidden slots across adaptive limits', () => {
    const system = new CombatNpcSystem({ seed: 'pool', quality: 'low' });
    expect(COMBAT_NPC_CAPACITY).toEqual({ low: 8, high: 20 });
    expect(system.getPoolCapacity()).toBe(20);
    for (let index = 0; index < COMBAT_NPC_CAPACITY.low; index += 1) {
      expect(system.spawn(roles[index % roles.length] ?? 'brawler', { x: index, y: 0, z: 0 }))
        .toBe(`combatant-${index.toString().padStart(2, '0')}`);
    }
    expect(system.spawn('brawler', { x: 30, y: 0, z: 0 })).toBeNull();
    const lowSnapshot = system.getSnapshot();

    system.setQuality('high');
    for (let index = COMBAT_NPC_CAPACITY.low; index < COMBAT_NPC_CAPACITY.high; index += 1) {
      expect(system.spawn(roles[index % roles.length] ?? 'brawler', { x: index, y: 0, z: 0 })).not.toBeNull();
    }
    expect(system.getSnapshot()).toHaveLength(COMBAT_NPC_CAPACITY.high);
    system.setActorLimit(5);
    expect(system.getSnapshot()).toHaveLength(5);
    system.setActorLimit(COMBAT_NPC_CAPACITY.high);
    system.setQuality('low');
    expect(system.getSnapshot()).toEqual(lowSnapshot);
  });

  it('produces identical state, perception, movement, and actions for the same seed', () => {
    const firstActions: CombatNpcAction[] = [];
    const secondActions: CombatNpcAction[] = [];
    const first = createSeededEncounter({ onAction: (action) => firstActions.push(action) });
    const second = createSeededEncounter({ onAction: (action) => secondActions.push(action) });
    first.alertAt({ x: 0, y: 0, z: 0 }, 80, 1);
    second.alertAt({ x: 0, y: 0, z: 0 }, 80, 1);
    for (let frame = 0; frame < 80; frame += 1) {
      expect(first.tick(combatContext())).toEqual(second.tick(combatContext()));
      expect(first.getSnapshot()).toEqual(second.getSnapshot());
    }
    expect(firstActions).toEqual(secondActions);
    expect(firstActions.length).toBeGreaterThan(0);
    expect(() => JSON.parse(JSON.stringify(first.getSnapshot())) as unknown).not.toThrow();
  });

  it('demonstrates each role tactic and emits melee/projectile actions', () => {
    const actions: CombatNpcAction[] = [];
    const system = createSeededEncounter({ onAction: (action) => actions.push(action) });
    system.alertAt({ x: 0, y: 0, z: 0 }, 80, 1);
    const tacticsByRole = new Map<CombatRole, Set<string>>(
      roles.map((role) => [role, new Set<string>()]),
    );
    const statesByRole = new Map<CombatRole, Set<string>>(
      roles.map((role) => [role, new Set<string>()]),
    );
    for (let frame = 0; frame < 120; frame += 1) {
      system.tick(combatContext());
      for (const npc of system.getSnapshot()) {
        tacticsByRole.get(npc.role)?.add(npc.tactic);
        statesByRole.get(npc.role)?.add(npc.state);
      }
    }

    expect(tacticsByRole.get('brawler')).toContain('rush');
    expect(tacticsByRole.get('gunner')).toContain('hold-range');
    expect(tacticsByRole.get('flanker')).toContain('flank');
    expect(tacticsByRole.get('heavy')).toContain('suppress');
    expect(tacticsByRole.get('marksman')).toContain('seek-distance');
    expect(statesByRole.get('flanker')).toContain('reposition');
    expect(statesByRole.get('marksman')).toContain('engage');
    expect(actions.some((action) => action.role === 'brawler' && action.type === 'melee-attack')).toBe(true);
    for (const role of ['gunner', 'flanker', 'heavy', 'marksman'] as const) {
      expect(actions.some((action) => action.role === role && action.type === 'projectile-attack')).toBe(true);
    }

    const targets = system.getAimTargets();
    expect(targets.every((target) => (
      target.active
      && target.hostile
      && target.visible
      && target.radiusMeters > 0
    ))).toBe(true);
    expect(system.getLegacySnapshot().every((npc) => npc.alertness >= 0 && npc.alertness <= 1)).toBe(true);
  });

  it('reacts with retreat, surrender, and brief non-graphic incapacitation before reuse', () => {
    const actions: CombatNpcAction[] = [];
    const system = new CombatNpcSystem({
      seed: 'reactions-and-reuse',
      quality: 'low',
      onAction: (action) => actions.push(action),
    });
    const flanker = system.spawn('flanker', { x: 0, y: 0, z: -12 });
    const brawler = system.spawn('brawler', { x: 2, y: 0, z: -2 });
    const gunner = system.spawn('gunner', { x: -2, y: 0, z: -8 });
    if (!flanker || !brawler || !gunner) throw new Error('Expected three NPCs');

    system.damage(flanker, 60, { x: 0, y: 0, z: 0 });
    system.damage(brawler, 90, { x: 0, y: 0, z: 0 });
    for (let frame = 0; frame < 30; frame += 1) system.tick(combatContext());
    expect(system.getSnapshot().find((npc) => npc.id === flanker)?.state).toBe('flee');
    expect(system.getSnapshot().find((npc) => npc.id === brawler)?.state).toBe('surrender');
    expect(actions.some((action) => action.sourceId === brawler && action.type === 'surrender')).toBe(true);

    expect(system.damage(gunner, 1_000, { x: 0, y: 0, z: 0 })).toMatchObject({
      targetId: gunner,
      remainingHealth: 0,
      incapacitated: true,
    });
    expect(system.getSnapshot().find((npc) => npc.id === gunner)?.state).toBe('incapacitated');
    expect(system.getLegacySnapshot().find((npc) => npc.id === gunner)?.behavior).toBe('defeated');
    expect(system.getAimTargets().find((target) => target.id === gunner)?.active).toBe(false);
    expect(system.getAimTargets().find((target) => target.id === gunner)?.hostile).toBe(false);
    for (let frame = 0; frame < 13; frame += 1) system.tick(combatContext({ threatening: false, noise: 0 }));
    expect(system.getSnapshot().some((npc) => npc.id === gunner)).toBe(false);
    expect(system.spawn('heavy', { x: 4, y: 0, z: -4 })).toBe(gunner);
  });

  it('recovers from obstructions without NaNs during a five-minute fixed-step soak', () => {
    const first = createSeededEncounter();
    const second = createSeededEncounter();
    first.alertAt({ x: 0, y: 0, z: 0 }, 80, 1);
    second.alertAt({ x: 0, y: 0, z: 0 }, 80, 1);
    const obstacles = [
      { x: 0, z: -6, radius: 1.2 },
      { x: 3, z: -14, radius: 1.5 },
      { x: -2, z: -24, radius: 1 },
    ];
    for (let frame = 0; frame < 3_000; frame += 1) {
      const context = { ...combatContext(), obstacles };
      first.tick(context);
      second.tick(context);
      if (frame % 100 === 0) expect(first.getSnapshot()).toEqual(second.getSnapshot());
      for (const npc of first.getSnapshot()) {
        expect(Number.isFinite(npc.position.x)).toBe(true);
        expect(Number.isFinite(npc.position.z)).toBe(true);
        expect(npc.recoveryCount).toBeLessThanOrEqual(4);
      }
    }
    expect(first.drainActions().length).toBeLessThanOrEqual(256);
    expect(first.drainActions()).toHaveLength(0);
  });
});
