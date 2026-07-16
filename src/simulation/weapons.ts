import { clamp, normalize2d } from './math';
import type { SimulationRandom } from './random';
import type {
  SimulationVec3,
  WeaponDefinition,
  WeaponFireResult,
  WeaponHit,
  WeaponType,
} from './types';

export const WEAPON_DEFINITIONS: Readonly<Record<WeaponType, WeaponDefinition>> = Object.freeze({
  melee: { type: 'melee', damage: 28, range: 2.35, cooldownSeconds: 0.62, spreadRadians: 0.62, pellets: 1 },
  pistol: { type: 'pistol', damage: 24, range: 42, cooldownSeconds: 0.3, spreadRadians: 0.025, pellets: 1 },
  smg: { type: 'smg', damage: 11, range: 32, cooldownSeconds: 0.085, spreadRadians: 0.075, pellets: 1 },
  shotgun: { type: 'shotgun', damage: 9, range: 20, cooldownSeconds: 0.82, spreadRadians: 0.2, pellets: 8 },
  rifle: { type: 'rifle', damage: 31, range: 70, cooldownSeconds: 0.5, spreadRadians: 0.016, pellets: 1 },
});

export interface WeaponTarget {
  id: string;
  position: SimulationVec3;
  radius: number;
  active: boolean;
}

export interface WeaponRuntime {
  cooldowns: Record<WeaponType, number>;
}

export function createWeaponRuntime(): WeaponRuntime {
  return {
    cooldowns: { melee: 0, pistol: 0, smg: 0, shotgun: 0, rifle: 0 },
  };
}

export function stepWeaponRuntime(runtime: WeaponRuntime, deltaSeconds: number): void {
  const dt = Math.max(0, deltaSeconds);
  for (const type of Object.keys(runtime.cooldowns) as WeaponType[]) {
    runtime.cooldowns[type] = Math.max(0, runtime.cooldowns[type] - dt);
  }
}

function resolvePellet(
  definition: WeaponDefinition,
  origin: Readonly<SimulationVec3>,
  direction: Readonly<SimulationVec3>,
  angleOffset: number,
  targets: readonly WeaponTarget[],
): WeaponHit | null {
  const cosine = Math.cos(angleOffset);
  const sine = Math.sin(angleOffset);
  const rayX = direction.x * cosine - direction.z * sine;
  const rayZ = direction.x * sine + direction.z * cosine;
  let closestDistance = Number.POSITIVE_INFINITY;
  let closest: WeaponTarget | null = null;

  for (const target of targets) {
    if (!target.active) {
      continue;
    }
    const deltaX = target.position.x - origin.x;
    const deltaZ = target.position.z - origin.z;
    const distanceAlongRay = deltaX * rayX + deltaZ * rayZ;
    if (distanceAlongRay < 0 || distanceAlongRay > definition.range) {
      continue;
    }
    const perpendicular = Math.abs(deltaX * rayZ - deltaZ * rayX);
    const hitRadius = target.radius + (definition.type === 'melee' ? 0.75 : 0.16);
    if (perpendicular <= hitRadius && distanceAlongRay < closestDistance) {
      closestDistance = distanceAlongRay;
      closest = target;
    }
  }

  if (!closest) {
    return null;
  }
  const minimumFalloff = definition.type === 'shotgun' ? 0.32 : 0.68;
  const falloff = 1 - (closestDistance / definition.range) * (1 - minimumFalloff);
  return {
    targetId: closest.id,
    damage: definition.damage * clamp(falloff, minimumFalloff, 1),
    distance: closestDistance,
  };
}

export function tryFireWeapon(
  runtime: WeaponRuntime,
  type: WeaponType,
  origin: Readonly<SimulationVec3>,
  aimDirection: Readonly<SimulationVec3>,
  targets: readonly WeaponTarget[],
  random: SimulationRandom,
): WeaponFireResult {
  const definition = WEAPON_DEFINITIONS[type];
  const cooldown = runtime.cooldowns[type];
  if (cooldown > 0) {
    return { weapon: type, fired: false, cooldownRemaining: cooldown, hits: [] };
  }

  runtime.cooldowns[type] = definition.cooldownSeconds;
  const direction = normalize2d(aimDirection);
  const aggregated = new Map<string, WeaponHit>();
  for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
    const angle = definition.pellets === 1
      ? random.range(-definition.spreadRadians, definition.spreadRadians)
      : ((pellet / (definition.pellets - 1)) * 2 - 1) * definition.spreadRadians
        + random.range(-0.018, 0.018);
    const hit = resolvePellet(definition, origin, direction, angle, targets);
    if (!hit) {
      continue;
    }
    const previous = aggregated.get(hit.targetId);
    aggregated.set(hit.targetId, previous
      ? { ...hit, damage: previous.damage + hit.damage, distance: Math.min(previous.distance, hit.distance) }
      : hit);
  }

  return {
    weapon: type,
    fired: true,
    cooldownRemaining: definition.cooldownSeconds,
    hits: [...aggregated.values()],
  };
}

