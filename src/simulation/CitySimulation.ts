import type { Scene } from 'three';

import { COMBAT_NPC_CAPACITY, CombatNpcSystem } from './combatNpcAi';
import type { CombatNpcSnapshot } from './combatNpcAi';
import { directionFromHeading } from './math';
import { PEDESTRIAN_CAPACITY, PedestrianSystem } from './pedestrians';
import { SimulationRandom, simulationSeed } from './random';
import { TRAFFIC_CAPACITY, TrafficSystem } from './traffic';
import type {
  ActorPopulationLimits,
  CitySimulationOptions,
  CitySimulationSnapshot,
  CitySimulationTick,
  CitySimulationTickResult,
  CombatRole,
  CrimeEvent,
  CrimeReportInput,
  EnemyDamageEvent,
  PlayerDamageEvent,
  SimulationQuality,
  SimulationVec3,
  TrafficVehicleSnapshot,
  WeaponFireResult,
  WeaponDefinition,
  WeaponType,
} from './types';
import { SimulationVisualLayer } from './visuals';
import {
  createWeaponRuntime,
  stepWeaponRuntime,
  resolveWeaponHits,
  tryFireWeapon,
} from './weapons';
import type { WeaponRuntime } from './weapons';

function normalizedActorLimit(value: number, label: string, capacity: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} actor limit must be a non-negative safe integer`);
  }
  return Math.min(value, capacity);
}

function normalizedActorLimits(
  limits: Readonly<ActorPopulationLimits>,
): ActorPopulationLimits {
  return {
    traffic: normalizedActorLimit(limits.traffic, 'traffic', TRAFFIC_CAPACITY.high),
    pedestrians: normalizedActorLimit(
      limits.pedestrians,
      'pedestrian',
      PEDESTRIAN_CAPACITY.high,
    ),
    combat: normalizedActorLimit(limits.combat, 'combat', COMBAT_NPC_CAPACITY.high),
  };
}

export class CitySimulation {
  private readonly weaponRandom: SimulationRandom;
  private readonly traffic: TrafficSystem;
  private readonly pedestrians: PedestrianSystem;
  private readonly combat: CombatNpcSystem;
  private readonly weaponRuntime: WeaponRuntime;
  private readonly onCrime: (event: CrimeEvent) => void;
  private readonly onEnemyDamage: (event: EnemyDamageEvent) => void;
  private readonly onPlayerDamage: (event: PlayerDamageEvent) => void;
  private quality: SimulationQuality;
  private simulationTime = 0;
  private crimeSequence = 0;
  private lastCrimeId: string | null = null;
  private visuals: SimulationVisualLayer | null = null;
  private disposed = false;

  public constructor(options: CitySimulationOptions = {}) {
    const seed = simulationSeed(options.seed ?? 'solara-city-life-v1');
    this.quality = options.quality ?? 'high';
    this.weaponRandom = new SimulationRandom(seed ^ 0xb34821);
    this.onCrime = options.onCrime ?? (() => undefined);
    this.onEnemyDamage = options.onEnemyDamage ?? (() => undefined);
    this.onPlayerDamage = options.onPlayerDamage ?? (() => undefined);
    this.traffic = new TrafficSystem(
      new SimulationRandom(seed ^ 0x4f219a),
      this.quality,
      options.roads,
    );
    this.pedestrians = new PedestrianSystem(
      new SimulationRandom(seed ^ 0x9a712c),
      this.quality,
      this.traffic.roads,
      options.onWitnessReport ?? (() => undefined),
    );
    this.combat = new CombatNpcSystem({
      seed: seed ^ 0x71af0d,
      quality: this.quality,
      navigationGraph: this.pedestrians.getNavigationGraph(),
    });
    this.weaponRuntime = createWeaponRuntime();
    if (options.actorLimits) {
      this.setActorLimits(options.actorLimits);
    }
    if (options.seedCombatants !== false) {
      const anchor = this.traffic.roads[0]?.position ?? { x: 0, y: 0, z: 0 };
      this.combat.seedEncounter(anchor);
    }
  }

  public attach(scene: Scene): void {
    this.assertAlive();
    this.detach();
    this.visuals = new SimulationVisualLayer(scene);
    this.visuals.update(this.getSnapshot());
  }

  public detach(): void {
    this.visuals?.dispose();
    this.visuals = null;
  }

  public setVisible(visible: boolean): void {
    this.assertAlive();
    this.visuals?.setVisible(visible);
  }

  public setQuality(quality: SimulationQuality): void {
    this.assertAlive();
    this.quality = quality;
    this.traffic.setQuality(quality);
    this.pedestrians.setQuality(quality);
    this.combat.setQuality(quality);
    this.visuals?.update(this.getSnapshot());
  }

  public setActorLimits(
    limits: Readonly<ActorPopulationLimits>,
  ): ActorPopulationLimits {
    this.assertAlive();
    const normalized = normalizedActorLimits(limits);
    this.traffic.setActorLimit(normalized.traffic);
    this.pedestrians.setActorLimit(normalized.pedestrians);
    this.combat.setActorLimit(normalized.combat);
    const effective = this.getActorLimits();
    this.visuals?.update(this.getSnapshot());
    return effective;
  }

  public tick(context: CitySimulationTick): CitySimulationTickResult {
    this.assertAlive();
    const dt = Math.min(0.1, Math.max(0, context.deltaSeconds));
    this.simulationTime += dt;
    stepWeaponRuntime(this.weaponRuntime, dt);
    const input = context.input;
    let weaponFire: WeaponFireResult | null = null;

    if (input?.triggerPanic) {
      this.triggerPanic(context.playerPosition, 28, 3.5);
    }
    if (input?.fire) {
      const direction = input.aimDirection ?? directionFromHeading(context.playerHeading);
      weaponFire = this.fireWeapon(input.weapon ?? 'pistol', context.playerPosition, direction);
    }

    this.traffic.tick({
      deltaSeconds: dt,
      sirenPosition: input?.sirenActive ? context.playerPosition : null,
      sirenRadius: 24,
      obstructions: context.obstructions ?? [],
    });
    const combatActions = this.combat.tick({
      deltaSeconds: dt,
      player: {
        id: 'player',
        position: context.playerPosition,
        crouching: context.playerCrouching,
        lightLevel: context.playerLightLevel,
        coverExposure: context.playerCoverExposure,
        movement: context.playerMovement,
        noise: context.playerNoise ?? (input?.threatening || weaponFire?.fired ? 1 : 0),
        threatening: Boolean(input?.threatening || weaponFire?.fired),
      },
      obstacles: context.obstructions ?? [],
    });
    for (const action of combatActions) {
      if (action.type !== 'melee-attack' && action.type !== 'projectile-attack') continue;
      this.onPlayerDamage({
        sourceId: action.sourceId,
        role: action.role,
        amount: action.damage,
        attack: action.type === 'melee-attack' ? 'melee' : 'projectile',
      });
    }
    this.combat.drainActions();
    this.pedestrians.tick(dt, this.simulationTime, {
      obstacles: context.obstructions ?? [],
    });
    const snapshot = this.getSnapshot();
    this.visuals?.update(snapshot);
    return { snapshot, weaponFire };
  }

  public fireWeapon(
    type: WeaponType,
    origin: Readonly<SimulationVec3>,
    aimDirection: Readonly<SimulationVec3>,
  ): WeaponFireResult {
    this.assertAlive();
    const result = tryFireWeapon(
      this.weaponRuntime,
      type,
      origin,
      aimDirection,
      this.getWeaponTargets(),
      this.weaponRandom,
    );
    return this.applyWeaponResult(result, origin);
  }

  public fireResolvedWeapon(
    definition: Readonly<WeaponDefinition>,
    origin: Readonly<SimulationVec3>,
    aimDirection: Readonly<SimulationVec3>,
    noiseRadius = definition.type === 'melee' ? 12 : 42,
  ): WeaponFireResult {
    this.assertAlive();
    const result: WeaponFireResult = {
      weapon: definition.type,
      fired: true,
      cooldownRemaining: definition.cooldownSeconds,
      hits: resolveWeaponHits(
        definition,
        origin,
        aimDirection,
        this.getWeaponTargets(),
        this.weaponRandom,
      ),
    };
    return this.applyWeaponResult(result, origin, noiseRadius);
  }

  private applyWeaponResult(
    result: Readonly<WeaponFireResult>,
    origin: Readonly<SimulationVec3>,
    noiseRadius = result.weapon === 'melee' ? 12 : 42,
  ): WeaponFireResult {
    if (!result.fired) {
      return { ...result, hits: [...result.hits] };
    }

    for (const hit of result.hits) {
      this.damageEnemy(hit.targetId, hit.damage, 'player', origin);
    }
    const witnessedAction = result.weapon !== 'melee' || result.hits.length > 0;
    if (witnessedAction) {
      this.reportCrime({
        kind: result.weapon === 'melee' ? 'assault' : 'weapon-fire',
        sourceId: 'player',
        position: { ...origin },
        severity: result.hits.length > 0 ? 3 : 2,
      });
      const panicRadius = result.weapon === 'melee'
        ? 12
        : Math.max(18, Math.min(60, noiseRadius));
      this.triggerPanic(origin, panicRadius, result.weapon === 'melee' ? 2 : 4);
      this.combat.alertAt(origin, result.weapon === 'melee' ? 20 : Math.max(30, noiseRadius));
    }
    return { ...result, hits: [...result.hits] };
  }

  public reportCrime(input: CrimeReportInput): CrimeEvent {
    this.assertAlive();
    const id = input.id ?? `crime-${this.crimeSequence.toString().padStart(4, '0')}`;
    this.crimeSequence += 1;
    const event: CrimeEvent = {
      id,
      kind: input.kind,
      sourceId: input.sourceId,
      position: { ...input.position },
      severity: Math.max(1, Math.min(5, input.severity)),
      simulationTime: this.simulationTime,
    };
    this.lastCrimeId = event.id;
    this.onCrime(event);
    this.pedestrians.observeCrime(event);
    return event;
  }

  public triggerPanic(position: Readonly<SimulationVec3>, radius: number, duration: number): void {
    this.assertAlive();
    this.traffic.triggerPanic(position, Math.max(0, radius), Math.max(0, duration));
    this.pedestrians.triggerPanic(position, Math.max(0, radius), Math.max(0, duration));
  }

  public claimTrafficVehicle(id: string): TrafficVehicleSnapshot | null {
    this.assertAlive();
    const claimed = this.traffic.claimVehicle(id);
    if (!claimed) {
      return null;
    }
    this.reportCrime({
      kind: 'vehicle-theft',
      sourceId: 'player',
      position: claimed.position,
      severity: claimed.classId === 'police-cruiser' ? 4 : 2,
    });
    this.triggerPanic(claimed.position, 18, 2.5);
    this.visuals?.update(this.getSnapshot());
    return claimed;
  }

  public spawnEnemy(role: CombatRole, position: Readonly<SimulationVec3>): string | null {
    this.assertAlive();
    return this.combat.spawn(role, position);
  }

  public despawnEnemy(targetId: string): boolean {
    this.assertAlive();
    const despawned = this.combat.despawn(targetId);
    if (despawned) {
      this.visuals?.update(this.getSnapshot());
    }
    return despawned;
  }

  public damageEnemy(
    targetId: string,
    amount: number,
    sourceId = 'player',
    sourcePosition?: Readonly<SimulationVec3>,
  ): EnemyDamageEvent | null {
    this.assertAlive();
    const result = this.combat.damage(targetId, amount, sourcePosition);
    if (!result) return null;
    const event: EnemyDamageEvent = {
      targetId: result.targetId,
      sourceId,
      amount: result.appliedDamage,
      remainingHealth: result.remainingHealth,
      defeated: result.incapacitated,
      effect: 'abstract-impact-flash',
    };
    this.onEnemyDamage(event);
    return event;
  }

  /** Silent contextual takedown for a nearby unaware target while Alex is crouched. */
  public tryStealthTakedown(
    position: Readonly<SimulationVec3>,
    maximumDistance = 2.25,
  ): EnemyDamageEvent | null {
    this.assertAlive();
    const target = this.combat.getSnapshot()
      .filter((candidate) => (
        (candidate.state === 'patrol' || candidate.state === 'investigate')
        && candidate.perception.awareness < 0.6
      ))
      .map((candidate) => ({
        candidate,
        distance: Math.hypot(
          position.x - candidate.position.x,
          position.z - candidate.position.z,
        ),
      }))
      .filter(({ distance }) => distance <= maximumDistance)
      .sort((left, right) => left.distance - right.distance)[0]?.candidate;
    if (!target) return null;
    const result = this.damageEnemy(target.id, target.health, 'player', position);
    if (result) {
      this.reportCrime({
        kind: 'assault',
        sourceId: 'player',
        position: { ...target.position },
        severity: 2,
      });
    }
    return result;
  }

  public getCombatNpcSnapshot(): readonly CombatNpcSnapshot[] {
    this.assertAlive();
    return this.combat.getSnapshot();
  }

  public getSnapshot(): CitySimulationSnapshot {
    return {
      simulationTime: this.simulationTime,
      quality: this.quality,
      traffic: this.traffic.getSnapshot(),
      pedestrians: this.pedestrians.getSnapshot(),
      combatants: this.combat.getLegacySnapshot(),
      actorLimits: this.getActorLimits(),
      poolCapacity: {
        traffic: TRAFFIC_CAPACITY.high,
        pedestrians: PEDESTRIAN_CAPACITY.high,
        combatants: COMBAT_NPC_CAPACITY.high,
      },
      lastCrimeId: this.lastCrimeId,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.detach();
    this.disposed = true;
  }

  private assertAlive(): void {
    if (this.disposed) {
      throw new Error('CitySimulation has been disposed');
    }
  }

  private getActorLimits(): ActorPopulationLimits {
    return {
      traffic: this.traffic.getActorLimit(),
      pedestrians: this.pedestrians.getActorLimit(),
      combat: this.combat.getActorLimit(),
    };
  }

  private getWeaponTargets() {
    return this.combat.getAimTargets().map((target) => ({
      id: target.id,
      position: { ...target.position },
      radius: target.radiusMeters,
      active: target.active && target.hostile && target.visible,
    }));
  }
}
