import type { Scene } from 'three';

import { COMBAT_CAPACITY, CombatSystem } from './combat';
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
  SimulationQuality,
  SimulationVec3,
  WeaponFireResult,
  WeaponType,
} from './types';
import { SimulationVisualLayer } from './visuals';
import {
  createWeaponRuntime,
  stepWeaponRuntime,
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
    combat: normalizedActorLimit(limits.combat, 'combat', COMBAT_CAPACITY.high),
  };
}

export class CitySimulation {
  private readonly random: SimulationRandom;
  private readonly weaponRandom: SimulationRandom;
  private readonly traffic: TrafficSystem;
  private readonly pedestrians: PedestrianSystem;
  private readonly combat: CombatSystem;
  private readonly weaponRuntime: WeaponRuntime;
  private readonly onCrime: (event: CrimeEvent) => void;
  private quality: SimulationQuality;
  private simulationTime = 0;
  private crimeSequence = 0;
  private lastCrimeId: string | null = null;
  private visuals: SimulationVisualLayer | null = null;
  private disposed = false;

  public constructor(options: CitySimulationOptions = {}) {
    const seed = simulationSeed(options.seed ?? 'solara-city-life-v1');
    this.quality = options.quality ?? 'high';
    this.random = new SimulationRandom(seed ^ 0x71af0d);
    this.weaponRandom = new SimulationRandom(seed ^ 0xb34821);
    this.onCrime = options.onCrime ?? (() => undefined);
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
    this.combat = new CombatSystem(
      this.random,
      this.quality,
      options.onEnemyDamage ?? (() => undefined),
      options.onPlayerDamage ?? (() => undefined),
    );
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
    this.combat.tick({
      deltaSeconds: dt,
      playerPosition: context.playerPosition,
      playerThreatening: Boolean(input?.threatening || weaponFire?.fired),
      obstructions: context.obstructions ?? [],
    });
    this.pedestrians.tick(dt, this.simulationTime);
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
      this.combat.getWeaponTargets(),
      this.weaponRandom,
    );
    if (!result.fired) {
      return result;
    }

    for (const hit of result.hits) {
      this.combat.damage(hit.targetId, hit.damage, 'player');
    }
    const witnessedAction = type !== 'melee' || result.hits.length > 0;
    if (witnessedAction) {
      this.reportCrime({
        kind: type === 'melee' ? 'assault' : 'weapon-fire',
        sourceId: 'player',
        position: { ...origin },
        severity: result.hits.length > 0 ? 3 : 1,
      });
      const panicRadius = type === 'melee' ? 12 : 28;
      this.triggerPanic(origin, panicRadius, type === 'melee' ? 2 : 4);
      this.combat.alertAt(origin, type === 'melee' ? 20 : 60);
    }
    return result;
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

  public spawnEnemy(role: CombatRole, position: Readonly<SimulationVec3>): string | null {
    this.assertAlive();
    return this.combat.spawn(role, position);
  }

  public damageEnemy(targetId: string, amount: number, sourceId = 'player'): EnemyDamageEvent | null {
    this.assertAlive();
    return this.combat.damage(targetId, amount, sourceId);
  }

  public getSnapshot(): CitySimulationSnapshot {
    return {
      simulationTime: this.simulationTime,
      quality: this.quality,
      traffic: this.traffic.getSnapshot(),
      pedestrians: this.pedestrians.getSnapshot(),
      combatants: this.combat.getSnapshot(),
      actorLimits: this.getActorLimits(),
      poolCapacity: {
        traffic: TRAFFIC_CAPACITY.high,
        pedestrians: PEDESTRIAN_CAPACITY.high,
        combatants: COMBAT_CAPACITY.high,
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
}
