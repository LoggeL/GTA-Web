import { describe, expect, it } from 'vitest';

import {
  chooseCivilianReaction,
  chooseCombatNpcTactic,
  COMBAT_ROLE_AI_PROFILES,
} from '../../src/simulation/npcReactions';
import type { CombatRole } from '../../src/simulation/types';

describe('NPC reaction policies', () => {
  it('keeps civilian reactions deterministic and proportionate', () => {
    expect(chooseCivilianReaction({
      temperament: 'calm', severity: 1, distance: 28, sawEvent: false, directThreat: false,
    })).toBe('ignore');
    expect(chooseCivilianReaction({
      temperament: 'calm', severity: 3, distance: 2, sawEvent: true, directThreat: true,
    })).toBe('flee');
    expect(chooseCivilianReaction({
      temperament: 'cautious', severity: 2, distance: 10, sawEvent: true, directThreat: false,
    })).toBe('report');
  });

  it('defines distinct tuning and tactics for all five combat roles', () => {
    const roles: readonly CombatRole[] = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'];
    expect(Object.keys(COMBAT_ROLE_AI_PROFILES).sort()).toEqual([...roles].sort());
    expect(new Set(roles.map((role) => COMBAT_ROLE_AI_PROFILES[role].baseTactic)).size).toBe(5);
    expect(COMBAT_ROLE_AI_PROFILES.heavy.maxHealth).toBeGreaterThan(COMBAT_ROLE_AI_PROFILES.gunner.maxHealth);
    expect(COMBAT_ROLE_AI_PROFILES.marksman.preferredDistance).toBeGreaterThan(
      COMBAT_ROLE_AI_PROFILES.brawler.preferredDistance,
    );
  });

  it('reacts to blocked shots, distance, health, and surrender opportunities', () => {
    expect(chooseCombatNpcTactic({
      role: 'flanker', healthRatio: 1, playerDistance: 12, playerVisible: true, hasLineOfFire: true,
    })).toBe('flank');
    expect(chooseCombatNpcTactic({
      role: 'gunner', healthRatio: 1, playerDistance: 12, playerVisible: true, hasLineOfFire: false,
    })).toBe('flank');
    expect(chooseCombatNpcTactic({
      role: 'marksman', healthRatio: 1, playerDistance: 8, playerVisible: true, hasLineOfFire: true,
    })).toBe('seek-distance');
    expect(chooseCombatNpcTactic({
      role: 'flanker', healthRatio: 0.15, playerDistance: 18, playerVisible: false, hasLineOfFire: true,
    })).toBe('retreat');
    expect(chooseCombatNpcTactic({
      role: 'brawler', healthRatio: 0.05, playerDistance: 5, playerVisible: true, hasLineOfFire: true,
    })).toBe('surrender');
    expect(chooseCombatNpcTactic({
      role: 'heavy', healthRatio: 0.01, playerDistance: 8, playerVisible: true, hasLineOfFire: true,
    })).toBe('suppress');
  });
});
