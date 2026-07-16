import type { WeaponDefinition } from '../data/types';
import {
  beginCombatWeaponReload,
  createCombatWeaponState,
  createMeleeCombatState,
  performMeleeAttack,
  requireCombatWeaponDefinition,
  resolveMeleeDefense,
  stepCombatWeapon,
  stepMeleeCombat,
  tryFireCombatWeapon,
  tryMeleeDodge,
  type CombatWeaponState,
  type FireCombatWeaponResult,
  type MeleeAttackResult,
  type MeleeCombatState,
  type MeleeDodgeResult,
  type MeleeDefenseResult,
} from './combatDomain';

export const WORLD_COMBAT_WEAPON_ORDER = Object.freeze([
  'melee-tier-1', 'pistol-tier-1', 'smg-tier-1', 'shotgun-tier-1', 'rifle-tier-1',
  'melee-tier-2', 'pistol-tier-2', 'smg-tier-2', 'shotgun-tier-2', 'rifle-tier-2',
  'melee-tier-3', 'pistol-tier-3', 'smg-tier-3', 'shotgun-tier-3', 'rifle-tier-3',
] as const);

export interface WorldCombatInput {
  readonly fire: boolean;
  readonly heavyAttackHeld: boolean;
  readonly heavyAttackReleased: boolean;
  readonly reload: boolean;
  readonly cycleWeapon: boolean;
  readonly blocking: boolean;
  readonly dodge: boolean;
}

export interface WorldCombatTickOptions {
  readonly reliabilityRoll: number;
  readonly spreadMultiplier?: number;
  readonly meleeDamageMultiplier?: number;
}

export interface WorldCombatFrame {
  readonly weaponChanged: boolean;
  readonly reloadStarted: boolean;
  readonly shot: FireCombatWeaponResult | null;
  readonly meleeAttack: MeleeAttackResult | null;
  readonly dodge: MeleeDodgeResult | null;
}

export interface WorldCombatSnapshot {
  readonly weapon: WeaponDefinition;
  readonly weaponState: CombatWeaponState;
  readonly melee: MeleeCombatState;
  readonly activeIndex: number;
  readonly weaponCount: number;
}

export interface WorldCombatDefenseResult {
  readonly melee: MeleeDefenseResult;
  readonly coverMultiplier: number;
  readonly damageAfterDefenseAndCover: number;
}

/** App-facing quick-loadout runtime built entirely from the pure M4 domains. */
export class WorldCombatRuntime {
  private readonly definitions = WORLD_COMBAT_WEAPON_ORDER.map(requireCombatWeaponDefinition);
  private readonly weaponStates = new Map<string, CombatWeaponState>();
  private activeIndex = 1;
  private melee = createMeleeCombatState();

  public constructor() {
    for (const definition of this.definitions) {
      this.weaponStates.set(definition.id, createCombatWeaponState(definition, {
        reserveAmmo: definition.classId === 'melee' ? 0 : definition.capacity * 4,
      }));
    }
  }

  public tick(
    deltaSeconds: number,
    input: Readonly<WorldCombatInput>,
    options: Readonly<WorldCombatTickOptions>,
  ): WorldCombatFrame {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('combat delta must be finite and non-negative');
    }
    for (const definition of this.definitions) {
      const state = this.requireWeaponState(definition);
      this.weaponStates.set(definition.id, stepCombatWeapon(definition, state, deltaSeconds));
    }

    let weaponChanged = false;
    if (input.cycleWeapon) {
      this.activeIndex = (this.activeIndex + 1) % this.definitions.length;
      weaponChanged = true;
    }
    const definition = this.activeDefinition;
    let state = this.requireWeaponState(definition);
    let reloadStarted = false;
    if (input.reload) {
      const reload = beginCombatWeaponReload(definition, state);
      state = reload.state;
      reloadStarted = reload.started;
      this.weaponStates.set(definition.id, state);
    }

    this.melee = stepMeleeCombat(this.melee, deltaSeconds, {
      blocking: definition.classId === 'melee' && input.blocking,
      chargingHeavy: input.heavyAttackHeld,
    });
    let dodge: MeleeDodgeResult | null = null;
    if (input.dodge) {
      dodge = tryMeleeDodge(this.melee);
      this.melee = dodge.state;
    }

    let meleeAttack: MeleeAttackResult | null = null;
    let shot: FireCombatWeaponResult | null = null;
    if (input.heavyAttackReleased) {
      meleeAttack = performMeleeAttack(this.melee, {
        kind: 'heavy',
        baseDamage: requireCombatWeaponDefinition('melee-tier-1').damage,
        damageMultiplier: options.meleeDamageMultiplier ?? 1,
      });
      this.melee = meleeAttack.state;
    } else if (input.fire && definition.classId === 'melee') {
      meleeAttack = performMeleeAttack(this.melee, {
        kind: 'light',
        baseDamage: definition.damage,
        damageMultiplier: options.meleeDamageMultiplier ?? 1,
      });
      this.melee = meleeAttack.state;
    } else if (input.fire) {
      shot = tryFireCombatWeapon(definition, state, {
        reliabilityRoll: options.reliabilityRoll,
        spreadMultiplier: options.spreadMultiplier,
      });
      this.weaponStates.set(definition.id, shot.state);
    }

    return { weaponChanged, reloadStarted, shot, meleeAttack, dodge };
  }

  public selectWeapon(weaponId: string): WorldCombatSnapshot {
    const index = this.definitions.findIndex((definition) => definition.id === weaponId);
    if (index < 0) throw new Error(`Weapon is not in the world quick loadout: ${weaponId}`);
    this.activeIndex = index;
    return this.snapshot();
  }

  public resolveIncomingDamage(
    amount: number,
    attack: 'melee' | 'projectile',
    coverMultiplier: number,
  ): WorldCombatDefenseResult {
    if (!Number.isFinite(coverMultiplier) || coverMultiplier < 0 || coverMultiplier > 1) {
      throw new RangeError('combat cover multiplier must be in [0, 1]');
    }
    const melee = resolveMeleeDefense(
      this.melee,
      amount,
      attack === 'melee' ? 'light' : 'projectile',
    );
    this.melee = melee.state;
    return {
      melee,
      coverMultiplier,
      damageAfterDefenseAndCover: melee.damageAfterDefense * coverMultiplier,
    };
  }

  public snapshot(): WorldCombatSnapshot {
    const weapon = this.activeDefinition;
    return {
      weapon,
      weaponState: { ...this.requireWeaponState(weapon) },
      melee: { ...this.melee },
      activeIndex: this.activeIndex,
      weaponCount: this.definitions.length,
    };
  }

  private get activeDefinition(): WeaponDefinition {
    const definition = this.definitions[this.activeIndex];
    if (!definition) throw new Error('World combat loadout has no active weapon');
    return definition;
  }

  private requireWeaponState(definition: Readonly<WeaponDefinition>): CombatWeaponState {
    const state = this.weaponStates.get(definition.id);
    if (!state) throw new Error(`Missing world combat state for ${definition.id}`);
    return state;
  }
}
