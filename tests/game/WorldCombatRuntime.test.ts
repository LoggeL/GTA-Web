import { describe, expect, it } from 'vitest';

import {
  WORLD_COMBAT_WEAPON_ORDER,
  WorldCombatRuntime,
  type WorldCombatInput,
} from '../../src/game/WorldCombatRuntime';

const IDLE: WorldCombatInput = {
  fire: false,
  heavyAttackHeld: false,
  heavyAttackReleased: false,
  reload: false,
  cycleWeapon: false,
  blocking: false,
  dodge: false,
};

describe('WorldCombatRuntime', () => {
  it('makes every class and tier available through the quick-loadout cycle', () => {
    const runtime = new WorldCombatRuntime();
    const visited = new Set([runtime.snapshot().weapon.id]);
    for (let index = 0; index < WORLD_COMBAT_WEAPON_ORDER.length - 1; index += 1) {
      runtime.tick(0, { ...IDLE, cycleWeapon: true }, { reliabilityRoll: 0 });
      visited.add(runtime.snapshot().weapon.id);
    }
    expect(visited).toEqual(new Set(WORLD_COMBAT_WEAPON_ORDER));
    expect(runtime.snapshot().weaponCount).toBe(15);
  });

  it('uses magazine, reserve, cooldown, durability, and reload state', () => {
    const runtime = new WorldCombatRuntime();
    const before = runtime.snapshot();
    expect(before.weapon.id).toBe('pistol-tier-1');

    const fired = runtime.tick(0, { ...IDLE, fire: true }, { reliabilityRoll: 0 });
    expect(fired.shot?.fired).toBe(true);
    expect(runtime.snapshot().weaponState.roundsInMagazine).toBe(before.weapon.capacity - 1);
    expect(runtime.snapshot().weaponState.durability).toBeLessThan(100);

    const cooldown = runtime.tick(0, { ...IDLE, fire: true }, { reliabilityRoll: 0 });
    expect(cooldown.shot).toEqual(expect.objectContaining({ fired: false, reason: 'cooldown' }));
    runtime.tick(1, IDLE, { reliabilityRoll: 0 });
    const reload = runtime.tick(0, { ...IDLE, reload: true }, { reliabilityRoll: 0 });
    expect(reload.reloadStarted).toBe(true);
    runtime.tick(2, IDLE, { reliabilityRoll: 0 });
    expect(runtime.snapshot().weaponState.roundsInMagazine).toBe(before.weapon.capacity);
  });

  it('drives light combos, charged heavy attacks, blocking, and dodge stamina', () => {
    const runtime = new WorldCombatRuntime();
    runtime.selectWeapon('melee-tier-1');

    const light = runtime.tick(0, { ...IDLE, fire: true }, { reliabilityRoll: 0 });
    expect(light.meleeAttack).toEqual(expect.objectContaining({ performed: true, comboStep: 0 }));
    runtime.tick(0.35, IDLE, { reliabilityRoll: 0 });
    const second = runtime.tick(0, { ...IDLE, fire: true }, { reliabilityRoll: 0 });
    expect(second.meleeAttack).toEqual(expect.objectContaining({ performed: true, comboStep: 1 }));

    runtime.tick(1, { ...IDLE, heavyAttackHeld: true }, { reliabilityRoll: 0 });
    const heavy = runtime.tick(0.01, { ...IDLE, heavyAttackReleased: true }, { reliabilityRoll: 0 });
    expect(heavy.meleeAttack).toEqual(expect.objectContaining({ performed: true }));
    expect(heavy.meleeAttack?.chargedFraction).toBeGreaterThan(0.6);

    runtime.tick(1, { ...IDLE, blocking: true }, { reliabilityRoll: 0 });
    expect(runtime.snapshot().melee.blocking).toBe(true);
    const stamina = runtime.snapshot().melee.stamina;
    const dodge = runtime.tick(0, { ...IDLE, dodge: true }, { reliabilityRoll: 0 });
    expect(dodge.dodge?.performed).toBe(true);
    expect(runtime.snapshot().melee.stamina).toBeLessThan(stamina);
    const avoided = runtime.resolveIncomingDamage(20, 'melee', 0.5);
    expect(avoided.damageAfterDefenseAndCover).toBe(0);
    expect(avoided.melee.avoided).toBe(true);
  });
});
