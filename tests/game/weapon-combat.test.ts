import { describe, expect, it } from 'vitest';

import type { WeaponClassId } from '../../src/data/types';
import {
  COMBAT_WEAPON_DEFINITIONS,
  addCombatWeaponReserveAmmo,
  beginCombatWeaponReload,
  createCombatWeaponState,
  deriveWeaponHandling,
  repairCombatWeapon,
  requireCombatWeaponDefinition,
  stepCombatWeapon,
  tryFireCombatWeapon,
  weaponCondition,
} from '../../src/game/weaponCombat';

describe('combat weapon registry profiles', () => {
  it('uses all five classes and all three authored tiers without a second tuning registry', () => {
    const classIds: readonly WeaponClassId[] = ['melee', 'pistol', 'smg', 'shotgun', 'rifle'];
    expect(COMBAT_WEAPON_DEFINITIONS).toHaveLength(15);
    for (const classId of classIds) {
      const tiers = COMBAT_WEAPON_DEFINITIONS.filter((weapon) => weapon.classId === classId);
      expect(tiers.map((weapon) => weapon.tier)).toEqual([1, 2, 3]);
      expect(tiers[2]?.damage).toBeGreaterThan(tiers[0]?.damage ?? 0);
      expect(tiers[2]?.value).toBeGreaterThan(tiers[0]?.value ?? -1);
      if (classId !== 'melee') {
        expect(tiers[2]?.durability).toBeGreaterThan(tiers[0]?.durability ?? 0);
        expect(tiers[2]?.capacity).toBeGreaterThan(tiers[0]?.capacity ?? 0);
        expect(tiers[2]?.recoil).toBeLessThan(tiers[0]?.recoil ?? 0);
      }
    }
  });

  it('derives distinct runtime handling, pellet, noise, and wear semantics', () => {
    const pistol1 = requireCombatWeaponDefinition('pistol-tier-1');
    const pistol3 = requireCombatWeaponDefinition('pistol-tier-3');
    const tier1 = deriveWeaponHandling(pistol1, createCombatWeaponState(pistol1));
    const tier3 = deriveWeaponHandling(pistol3, createCombatWeaponState(pistol3));
    expect(tier3.damage).toBeGreaterThan(tier1.damage);
    expect(tier3.spreadRadians).toBeLessThan(tier1.spreadRadians);
    expect(tier3.durabilityLossPerShot).toBeLessThan(tier1.durabilityLossPerShot);

    const shotgun = requireCombatWeaponDefinition('shotgun-tier-2');
    const shotgunHandling = deriveWeaponHandling(shotgun, createCombatWeaponState(shotgun));
    expect(shotgunHandling.pelletCount).toBe(8);
    expect(shotgunHandling.damagePerPellet * shotgunHandling.pelletCount).toBeCloseTo(shotgun.damage);
    expect(shotgunHandling.noiseRadiusMeters).toBeGreaterThan(tier1.noiseRadiusMeters);
  });
});

describe('firearm ammunition, reload, and cooldown state', () => {
  it('fires immutably, consumes one round, wears the weapon, and enforces cooldown', () => {
    const definition = requireCombatWeaponDefinition('pistol-tier-1');
    const original = createCombatWeaponState(definition, { roundsInMagazine: 2, reserveAmmo: 4 });
    const first = tryFireCombatWeapon(definition, original, { reliabilityRoll: 0 });
    expect(first).toMatchObject({ fired: true, consumedRound: true, reason: null });
    expect(first.state.roundsInMagazine).toBe(1);
    expect(first.state.durability).toBeLessThan(original.durability);
    expect(first.state.shotsFired).toBe(1);
    expect(original.roundsInMagazine).toBe(2);
    expect(original.durability).toBe(100);

    expect(tryFireCombatWeapon(definition, first.state, { reliabilityRoll: 0 })).toMatchObject({
      fired: false,
      reason: 'cooldown',
    });
    const ready = stepCombatWeapon(definition, first.state, 1);
    const second = tryFireCombatWeapon(definition, ready, { reliabilityRoll: 0 });
    expect(second.state.roundsInMagazine).toBe(0);
    const empty = tryFireCombatWeapon(definition, stepCombatWeapon(definition, second.state, 1), { reliabilityRoll: 0 });
    expect(empty).toMatchObject({ fired: false, consumedRound: false, reason: 'empty' });
  });

  it('transfers only available reserve rounds when a timed reload completes', () => {
    const definition = requireCombatWeaponDefinition('pistol-tier-1');
    const original = createCombatWeaponState(definition, { roundsInMagazine: 2, reserveAmmo: 7 });
    const reload = beginCombatWeaponReload(definition, original);
    expect(reload.started).toBe(true);
    expect(reload.state.reloadRemaining).toBeGreaterThan(0);
    expect(tryFireCombatWeapon(definition, reload.state, { reliabilityRoll: 0 }).reason).toBe('reloading');

    const halfway = stepCombatWeapon(definition, reload.state, reload.reloadSeconds / 2);
    expect(halfway.roundsInMagazine).toBe(2);
    const complete = stepCombatWeapon(definition, halfway, reload.reloadSeconds / 2);
    expect(complete.roundsInMagazine).toBe(9);
    expect(complete.reserveAmmo).toBe(0);
    expect(original).toMatchObject({ roundsInMagazine: 2, reserveAmmo: 7, reloadRemaining: 0 });
  });

  it('rejects invalid reloads and can add deterministic reserve ammunition', () => {
    const rifle = requireCombatWeaponDefinition('rifle-tier-2');
    const full = createCombatWeaponState(rifle);
    expect(beginCombatWeaponReload(rifle, full).reason).toBe('magazine-full');
    const fired = tryFireCombatWeapon(rifle, full, { reliabilityRoll: 0 }).state;
    expect(beginCombatWeaponReload(rifle, fired).reason).toBe('no-reserve-ammo');
    const stocked = addCombatWeaponReserveAmmo(rifle, fired, 14);
    expect(stocked.reserveAmmo).toBe(14);
    expect(fired.reserveAmmo).toBe(0);
  });
});

describe('weapon durability and reliability', () => {
  it('degrades accuracy and reliability below 25 and becomes unusable at zero', () => {
    const definition = requireCombatWeaponDefinition('smg-tier-1');
    const healthy = createCombatWeaponState(definition);
    const worn = createCombatWeaponState(definition, { durability: 10 });
    const healthyHandling = deriveWeaponHandling(definition, healthy);
    const wornHandling = deriveWeaponHandling(definition, worn);
    expect(weaponCondition(worn.durability)).toBe('worn');
    expect(wornHandling.spreadRadians).toBeGreaterThan(healthyHandling.spreadRadians);
    expect(wornHandling.recoilRadians).toBeGreaterThan(healthyHandling.recoilRadians);
    expect(wornHandling.reliability).toBeLessThan(1);

    const malfunction = tryFireCombatWeapon(definition, worn, { reliabilityRoll: 0.99 });
    expect(malfunction).toMatchObject({ fired: false, consumedRound: false, reason: 'malfunction' });
    expect(malfunction.state.roundsInMagazine).toBe(worn.roundsInMagazine);

    const broken = createCombatWeaponState(definition, { durability: 0 });
    expect(tryFireCombatWeapon(definition, broken, { reliabilityRoll: 0 })).toMatchObject({
      fired: false,
      reason: 'broken',
    });
  });

  it('repairs broken weapons without exceeding the universal 100-point cap', () => {
    const definition = requireCombatWeaponDefinition('rifle-tier-1');
    const broken = createCombatWeaponState(definition, { durability: 0 });
    const worn = repairCombatWeapon(definition, broken, 20);
    expect(weaponCondition(worn.durability)).toBe('worn');
    const ready = repairCombatWeapon(definition, worn, 20);
    expect(weaponCondition(ready.durability)).toBe('ready');
    expect(repairCombatWeapon(definition, ready, 1_000).durability).toBe(100);
  });

  it('routes melee definitions to the dedicated brawling domain', () => {
    const definition = requireCombatWeaponDefinition('melee-tier-3');
    const state = createCombatWeaponState(definition);
    expect(state).toMatchObject({ roundsInMagazine: 0, reserveAmmo: 0 });
    expect(tryFireCombatWeapon(definition, state, { reliabilityRoll: 0 }).reason).toBe('not-a-firearm');
    expect(beginCombatWeaponReload(definition, state).reason).toBe('not-a-firearm');
  });
});
