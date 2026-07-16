import { describe, expect, it } from 'vitest';

import { SimulationRandom } from '../../src/simulation/random';
import {
  WEAPON_DEFINITIONS,
  createWeaponRuntime,
  stepWeaponRuntime,
  tryFireWeapon,
} from '../../src/simulation/weapons';
import type { WeaponTarget } from '../../src/simulation/weapons';

const closeTarget: WeaponTarget = {
  id: 'target-close',
  position: { x: 0, y: 0, z: -10 },
  radius: 0.6,
  active: true,
};

describe('representative weapon logic', () => {
  it('defines every required weapon family with distinct behavior', () => {
    expect(Object.keys(WEAPON_DEFINITIONS).sort()).toEqual(['melee', 'pistol', 'rifle', 'shotgun', 'smg']);
    expect(WEAPON_DEFINITIONS.melee.range).toBeLessThan(WEAPON_DEFINITIONS.pistol.range);
    expect(WEAPON_DEFINITIONS.smg.cooldownSeconds).toBeLessThan(WEAPON_DEFINITIONS.rifle.cooldownSeconds);
    expect(WEAPON_DEFINITIONS.shotgun.pellets).toBeGreaterThan(1);
  });

  it('resolves a ray hit and enforces per-weapon cooldowns', () => {
    const runtime = createWeaponRuntime();
    const random = new SimulationRandom('pistol-shot');
    const first = tryFireWeapon(
      runtime,
      'pistol',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      [closeTarget],
      random,
    );
    expect(first.fired).toBe(true);
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0]?.targetId).toBe(closeTarget.id);

    const blocked = tryFireWeapon(
      runtime,
      'pistol',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      [closeTarget],
      random,
    );
    expect(blocked.fired).toBe(false);
    stepWeaponRuntime(runtime, WEAPON_DEFINITIONS.pistol.cooldownSeconds);
    expect(tryFireWeapon(
      runtime,
      'pistol',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      [closeTarget],
      random,
    ).fired).toBe(true);
  });

  it('applies range limits, melee reach, and aggregated shotgun pellets', () => {
    const runtime = createWeaponRuntime();
    const random = new SimulationRandom('range-shots');
    const distant: WeaponTarget = {
      id: 'distant',
      position: { x: 0, y: 0, z: -52 },
      radius: 0.7,
      active: true,
    };
    expect(tryFireWeapon(runtime, 'pistol', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, [distant], random).hits)
      .toHaveLength(0);
    expect(tryFireWeapon(runtime, 'rifle', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, [distant], random).hits)
      .toHaveLength(1);

    const meleeTarget: WeaponTarget = { ...closeTarget, id: 'melee', position: { x: 0, y: 0, z: -2 } };
    expect(tryFireWeapon(runtime, 'melee', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, [meleeTarget], random).hits)
      .toHaveLength(1);

    const shotgunTarget: WeaponTarget = { ...closeTarget, id: 'shotgun', position: { x: 0, y: 0, z: -5 }, radius: 1 };
    const shotgun = tryFireWeapon(
      runtime,
      'shotgun',
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      [shotgunTarget],
      random,
    );
    expect(shotgun.hits).toHaveLength(1);
    expect(shotgun.hits[0]?.damage).toBeGreaterThan(WEAPON_DEFINITIONS.shotgun.damage);
  });
});

