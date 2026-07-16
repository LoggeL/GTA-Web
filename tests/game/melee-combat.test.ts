import { describe, expect, it } from 'vitest';

import {
  createMeleeCombatState,
  performMeleeAttack,
  resolveMeleeDefense,
  stepMeleeCombat,
  tryMeleeDodge,
} from '../../src/game/meleeCombat';

describe('one-button melee combo and charged heavy attacks', () => {
  it('chains three increasingly forceful light attacks inside the combo window', () => {
    const original = createMeleeCombatState();
    const first = performMeleeAttack(original, { kind: 'light', baseDamage: 20 });
    expect(first).toMatchObject({ performed: true, comboStep: 0 });
    const secondReady = stepMeleeCombat(first.state, first.state.attackCooldownRemaining);
    const second = performMeleeAttack(secondReady, { kind: 'light', baseDamage: 20 });
    const thirdReady = stepMeleeCombat(second.state, second.state.attackCooldownRemaining);
    const third = performMeleeAttack(thirdReady, { kind: 'light', baseDamage: 20 });
    expect(second.comboStep).toBe(1);
    expect(third.comboStep).toBe(2);
    expect(second.damage).toBeGreaterThan(first.damage);
    expect(third.damage).toBeGreaterThan(second.damage);
    expect(third.state.comboStep).toBe(0);
    expect(original.stamina).toBe(original.maximumStamina);
  });

  it('resets an unfinished combo after its window expires', () => {
    const first = performMeleeAttack(createMeleeCombatState(), { kind: 'light', baseDamage: 20 });
    const expired = stepMeleeCombat(first.state, 1);
    const restarted = performMeleeAttack(expired, { kind: 'light', baseDamage: 20 });
    expect(expired.comboStep).toBe(0);
    expect(restarted.comboStep).toBe(0);
    expect(restarted.damage).toBeCloseTo(first.damage);
  });

  it('charges a heavy attack to increase damage, stamina cost, and stagger', () => {
    let state = createMeleeCombatState(120);
    state = stepMeleeCombat(state, 0.75, { chargingHeavy: true });
    const halfCharge = performMeleeAttack(state, { kind: 'heavy', baseDamage: 20 });
    const fullState = stepMeleeCombat(createMeleeCombatState(120), 1.5, { chargingHeavy: true });
    const fullCharge = performMeleeAttack(fullState, { kind: 'heavy', baseDamage: 20 });
    expect(halfCharge.chargedFraction).toBeCloseTo(0.5);
    expect(fullCharge.chargedFraction).toBe(1);
    expect(fullCharge.damage).toBeGreaterThan(halfCharge.damage);
    expect(fullCharge.staminaCost).toBeGreaterThan(halfCharge.staminaCost);
    expect(fullCharge.staggerSeconds).toBeGreaterThan(halfCharge.staggerSeconds);
    expect(fullCharge.state.heavyChargeSeconds).toBe(0);
  });

  it('fails safely when cooldown, stagger, or stamina prevent an attack', () => {
    const first = performMeleeAttack(createMeleeCombatState(), { kind: 'light', baseDamage: 20 });
    expect(performMeleeAttack(first.state, { kind: 'light', baseDamage: 20 }).reason).toBe('cooldown');
    expect(performMeleeAttack({ ...createMeleeCombatState(), staggerRemaining: 0.2 }, {
      kind: 'light', baseDamage: 20,
    }).reason).toBe('staggered');
    expect(performMeleeAttack({ ...createMeleeCombatState(), stamina: 1 }, {
      kind: 'heavy', baseDamage: 20,
    }).reason).toBe('insufficient-stamina');
  });
});

describe('block, dodge, and stamina', () => {
  it('blocks light attacks most effectively and can break an exhausted guard', () => {
    const blocking = stepMeleeCombat(createMeleeCombatState(), 0, { blocking: true });
    const light = resolveMeleeDefense(blocking, 30, 'light');
    const projectile = resolveMeleeDefense(blocking, 30, 'projectile');
    expect(light.blockedDamage).toBeGreaterThan(projectile.blockedDamage);
    expect(light.damageAfterDefense).toBeLessThan(projectile.damageAfterDefense);
    expect(light.state.stamina).toBeLessThan(blocking.stamina);

    const exhausted = { ...blocking, stamina: 2 };
    const brokenGuard = resolveMeleeDefense(exhausted, 40, 'heavy');
    expect(brokenGuard.guardBroken).toBe(true);
    expect(brokenGuard.state.blocking).toBe(false);
    expect(brokenGuard.state.staggerRemaining).toBeGreaterThan(0);
  });

  it('uses a stamina-costed dodge window to avoid all incoming damage', () => {
    const dodge = tryMeleeDodge(createMeleeCombatState());
    expect(dodge).toMatchObject({ performed: true, reason: null });
    expect(dodge.state.stamina).toBeLessThan(dodge.state.maximumStamina);
    const avoided = resolveMeleeDefense(dodge.state, 90, 'heavy');
    expect(avoided.avoided).toBe(true);
    expect(avoided.damageAfterDefense).toBe(0);
    expect(tryMeleeDodge(dodge.state).reason).toBe('cooldown');
  });

  it('regenerates stamina only while not blocking, charging, or attacking', () => {
    const tired = { ...createMeleeCombatState(), stamina: 40 };
    expect(stepMeleeCombat(tired, 1).stamina).toBe(62);
    expect(stepMeleeCombat(tired, 1, { blocking: true }).stamina).toBe(40);
    expect(stepMeleeCombat(tired, 1, { chargingHeavy: true }).stamina).toBe(40);
  });
});
