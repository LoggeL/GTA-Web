import { describe, expect, it } from 'vitest';

import {
  applyArmorRepairPlate,
  armorCondition,
  createArmorState,
  createCombatVitalState,
  replaceArmor,
  resolveCombatDamage,
} from '../../src/game/combatDamage';

describe('armor and combat damage', () => {
  it('absorbs damage, loses points and durability, and never mutates source state', () => {
    const original = createCombatVitalState(100, createArmorState(100));
    const result = resolveCombatDamage(original, { amount: 50, kind: 'projectile' });
    expect(result.rawDamage).toBe(50);
    expect(result.armorAbsorbed).toBeCloseTo(36);
    expect(result.healthDamage).toBeCloseTo(14);
    expect(result.armorDurabilityLost).toBeGreaterThan(0);
    expect(result.state.health).toBeCloseTo(86);
    expect(result.state.armor?.points).toBeCloseTo(64);
    expect(result.effect).toBe('abstract-impact-flash');
    expect(original).toEqual(createCombatVitalState(100, createArmorState(100)));
  });

  it('stacks soft-cover and active-defense multipliers before armor', () => {
    const original = createCombatVitalState(100, createArmorState(50));
    const result = resolveCombatDamage(original, {
      amount: 40,
      kind: 'projectile',
      coverDamageMultiplier: 0.5,
      defenseDamageMultiplier: 0.5,
    });
    expect(result.damageAfterCoverAndDefense).toBe(10);
    expect(result.armorAbsorbed).toBeCloseTo(7.2);
    expect(result.healthDamage).toBeCloseTo(2.8);
  });

  it('lets penetration bypass armor and broken armor provides no protection', () => {
    const armored = createCombatVitalState(100, createArmorState(100));
    const penetrated = resolveCombatDamage(armored, {
      amount: 30, kind: 'projectile', armorPenetration: 1,
    });
    expect(penetrated.armorAbsorbed).toBe(0);
    expect(penetrated.healthDamage).toBe(30);

    const brokenArmor = createArmorState(100, 0);
    expect(armorCondition(brokenArmor)).toBe('broken');
    const broken = resolveCombatDamage(createCombatVitalState(100, brokenArmor), {
      amount: 30, kind: 'melee',
    });
    expect(broken.armorAbsorbed).toBe(0);
    expect(broken.healthDamage).toBe(30);
  });

  it('makes worn armor less effective than ready armor', () => {
    const ready = resolveCombatDamage(createCombatVitalState(100, createArmorState(100, 100)), {
      amount: 40, kind: 'projectile',
    });
    const worn = resolveCombatDamage(createCombatVitalState(100, createArmorState(100, 10)), {
      amount: 40, kind: 'projectile',
    });
    expect(armorCondition(createArmorState(100, 10))).toBe('worn');
    expect(worn.armorAbsorbed).toBeLessThan(ready.armorAbsorbed);
    expect(worn.healthDamage).toBeGreaterThan(ready.healthDamage);
  });

  it('repairs armor at a bounded field rate and supports equipment replacement', () => {
    const damaged = { points: 20, maximumPoints: 100, durability: 10 } as const;
    const repaired = applyArmorRepairPlate(damaged);
    expect(repaired).toEqual({ points: 44, maximumPoints: 100, durability: 45 });
    expect(applyArmorRepairPlate(repaired, 10)).toEqual({
      points: 100, maximumPoints: 100, durability: 100,
    });

    const unarmored = createCombatVitalState();
    expect(armorCondition(unarmored.armor)).toBe('none');
    expect(replaceArmor(unarmored, damaged).armor).toEqual(damaged);
    expect(replaceArmor(replaceArmor(unarmored, damaged), null).armor).toBeNull();
  });

  it('clamps lethal damage to remaining health and reports defeat', () => {
    const result = resolveCombatDamage(createCombatVitalState(60), {
      amount: 1_000, kind: 'environment',
    });
    expect(result.healthDamage).toBe(60);
    expect(result.state.health).toBe(0);
    expect(result.defeated).toBe(true);
  });
});
