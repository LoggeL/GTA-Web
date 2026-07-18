import { InstancedMesh, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { CitySimulation } from '../../src/simulation/CitySimulation';
import { SimulationVisualLayer } from '../../src/simulation/visuals';
import type {
  CrimeEvent,
  EnemyDamageEvent,
  WitnessReportEvent,
} from '../../src/simulation/types';

describe('CitySimulation integration surface', () => {
  it('is deterministic, serializable, and honors adaptive population counts', () => {
    const first = new CitySimulation({ seed: 'city-seed', quality: 'low' });
    const second = new CitySimulation({ seed: 'city-seed', quality: 'low' });
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot().traffic).toHaveLength(18);
    expect(first.getSnapshot().pedestrians).toHaveLength(30);
    expect(first.getSnapshot().combatants).toHaveLength(5);
    expect(() => JSON.parse(JSON.stringify(first.getSnapshot())) as unknown).not.toThrow();

    first.setQuality('high');
    expect(first.getSnapshot().traffic).toHaveLength(42);
    expect(first.getSnapshot().pedestrians).toHaveLength(72);
    first.dispose();
    second.dispose();
  });

  it('applies arbitrary streaming limits and restores the fixed pools deterministically', () => {
    const simulation = new CitySimulation({
      seed: 'adaptive-actor-limits',
      quality: 'high',
      seedCombatants: false,
    });
    const roles = ['brawler', 'gunner', 'flanker', 'heavy', 'marksman'] as const;
    for (let index = 0; index < 20; index += 1) {
      expect(simulation.spawnEnemy(roles[index % roles.length] ?? 'brawler', {
        x: index * 2,
        y: 0,
        z: -index,
      })).toBe(`combatant-${index.toString().padStart(2, '0')}`);
    }

    const full = simulation.getSnapshot();
    expect(full.actorLimits).toEqual({ traffic: 42, pedestrians: 72, combat: 20 });
    expect(full.poolCapacity).toEqual({ traffic: 42, pedestrians: 72, combatants: 20 });
    expect([full.traffic.length, full.pedestrians.length, full.combatants.length]).toEqual([
      42,
      72,
      20,
    ]);

    expect(simulation.setActorLimits({ traffic: 18, pedestrians: 33, combat: 15 })).toEqual({
      traffic: 18,
      pedestrians: 33,
      combat: 15,
    });
    let throttled = simulation.getSnapshot();
    expect([throttled.traffic.length, throttled.pedestrians.length, throttled.combatants.length]).toEqual([
      18,
      33,
      15,
    ]);

    simulation.setQuality('low');
    expect(simulation.getSnapshot().actorLimits).toEqual({
      traffic: 18,
      pedestrians: 30,
      combat: 8,
    });
    simulation.setQuality('high');
    expect(simulation.getSnapshot().actorLimits).toEqual({
      traffic: 18,
      pedestrians: 33,
      combat: 15,
    });

    expect(simulation.setActorLimits({ traffic: 12, pedestrians: 22, combat: 10 })).toEqual({
      traffic: 12,
      pedestrians: 22,
      combat: 10,
    });
    throttled = simulation.getSnapshot();
    expect([throttled.traffic.length, throttled.pedestrians.length, throttled.combatants.length]).toEqual([
      12,
      22,
      10,
    ]);

    expect(simulation.setActorLimits({ traffic: 42, pedestrians: 72, combat: 20 })).toEqual(
      full.actorLimits,
    );
    const restored = simulation.getSnapshot();
    expect(restored.traffic).toEqual(full.traffic);
    expect(restored.pedestrians).toEqual(full.pedestrians);
    expect(restored.combatants).toEqual(full.combatants);
    expect(restored.poolCapacity).toEqual(full.poolCapacity);
    expect(simulation.spawnEnemy('brawler', { x: 100, y: 0, z: 100 })).toBeNull();
    simulation.dispose();
  });

  it('turns accepted weapon fire into damage, crime, panic, and combat alerting', () => {
    const crimes: CrimeEvent[] = [];
    const damage: EnemyDamageEvent[] = [];
    const simulation = new CitySimulation({
      seed: 'combat-integration',
      quality: 'low',
      seedCombatants: false,
      onCrime: (event) => crimes.push(event),
      onEnemyDamage: (event) => damage.push(event),
    });
    const nearbyVehicle = simulation.getSnapshot().traffic[0];
    if (!nearbyVehicle) {
      throw new Error('Missing traffic vehicle');
    }
    expect(simulation.spawnEnemy('brawler', {
      x: nearbyVehicle.position.x + 10,
      y: 0,
      z: nearbyVehicle.position.z,
    })).not.toBeNull();
    const result = simulation.tick({
      deltaSeconds: 1 / 60,
      playerPosition: nearbyVehicle.position,
      playerHeading: -Math.PI / 2,
      input: {
        fire: true,
        weapon: 'pistol',
        aimDirection: { x: 1, y: 0, z: 0 },
        threatening: true,
      },
    });
    expect(result.weaponFire?.fired).toBe(true);
    expect(result.weaponFire?.hits.length).toBeGreaterThan(0);
    expect(damage.length).toBeGreaterThan(0);
    expect(crimes[0]?.kind).toBe('weapon-fire');
    expect(result.snapshot.lastCrimeId).toBe(crimes[0]?.id);
    expect(result.snapshot.traffic.some((vehicle) => vehicle.behavior === 'panic')).toBe(true);
    simulation.dispose();
  });

  it('keeps tick and snapshot-free advance simulation and weapon results identical', () => {
    const tickSimulation = new CitySimulation({
      seed: 'advance-contract',
      quality: 'low',
    });
    const advanceSimulation = new CitySimulation({
      seed: 'advance-contract',
      quality: 'low',
    });
    const context = {
      deltaSeconds: 1 / 60,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeading: -Math.PI / 2,
      input: {
        fire: true,
        weapon: 'pistol' as const,
        aimDirection: { x: 1, y: 0, z: 0 },
        threatening: true,
      },
    };

    const tickResult = tickSimulation.tick(context);
    const advanceWeaponFire = advanceSimulation.advance(context);

    expect(advanceWeaponFire).toEqual(tickResult.weaponFire);
    expect(advanceSimulation.getSnapshot()).toEqual(tickResult.snapshot);
    tickSimulation.dispose();
    advanceSimulation.dispose();
  });

  it('exposes independently clocked traffic signals outside the per-frame snapshot', () => {
    const roads = [
      {
        id: 'test-horizontal',
        position: { x: 0, y: 0, z: 0 },
        width: 160,
        depth: 20,
        major: true,
      },
      {
        id: 'test-vertical',
        position: { x: 0, y: 0, z: 0 },
        width: 20,
        depth: 160,
        major: true,
      },
    ] as const;
    const simulation = new CitySimulation({
      seed: 'signal-api',
      quality: 'low',
      roads,
      seedCombatants: false,
    });

    const initial = simulation.getTrafficSignalSnapshot();
    expect(initial.junctions).toHaveLength(1);
    expect(initial.cycleClockSeconds).toBe(0);
    expect('trafficSignals' in simulation.getSnapshot()).toBe(false);

    simulation.advance({
      deltaSeconds: 0.1,
      playerPosition: { x: 500, y: 0, z: 500 },
      playerHeading: 0,
    });
    const advanced = simulation.getTrafficSignalSnapshot();
    expect(advanced.cycleClockSeconds).toBeCloseTo(0.1);
    expect(advanced.junctions[0]?.cyclePositionSeconds).not.toBe(
      initial.junctions[0]?.cyclePositionSeconds,
    );
    expect(() => JSON.parse(JSON.stringify(advanced)) as unknown).not.toThrow();
    simulation.dispose();
  });

  it('routes external vehicle contacts through the bounded ambient traffic solver', () => {
    const simulation = new CitySimulation({
      seed: 'external-collision-api',
      quality: 'low',
      seedCombatants: false,
    });
    simulation.attach(new Scene());
    const visualUpdate = vi.spyOn(SimulationVisualLayer.prototype, 'update');
    const target = simulation.getSnapshot().traffic[0];
    if (!target) throw new Error('Missing traffic collision target');

    try {
      const result = simulation.resolveTrafficVehicleCollision({
        position: { ...target.position },
        previousPosition: { ...target.position },
        heading: target.heading + Math.PI,
        speed: 18,
        lateralSpeed: 0,
        radius: 1.6,
      });

      expect(result.collided).toBe(true);
      expect(result.ambientVehicleIds).toContain(target.id);
      expect(result.primaryAmbientVehicleId).not.toBeNull();
      expect(result.pairChecks).toBeGreaterThan(0);
      expect(result.pairChecks).toBeLessThanOrEqual(36);
      expect(Number.isFinite(result.position.x)).toBe(true);
      expect(Number.isFinite(result.position.z)).toBe(true);
      expect(simulation.getSnapshot().traffic).toHaveLength(18);

      // Collision correction mutates domain state but presentation remains on
      // the normal low-quality cadence instead of forcing a snapshot/update.
      expect(visualUpdate).not.toHaveBeenCalled();
      simulation.advance({
        deltaSeconds: 0.01,
        playerPosition: { x: 500, y: 0, z: 500 },
        playerHeading: 0,
      });
      expect(visualUpdate).not.toHaveBeenCalled();
      simulation.advance({
        deltaSeconds: 0.03,
        playerPosition: { x: 500, y: 0, z: 500 },
        playerHeading: 0,
      });
      expect(visualUpdate).toHaveBeenCalledTimes(1);
    } finally {
      visualUpdate.mockRestore();
      simulation.dispose();
    }
  });

  it('resolves a crouch-context stealth takedown only within unaware range', () => {
    const crimes: CrimeEvent[] = [];
    const simulation = new CitySimulation({
      seed: 'stealth-takedown',
      quality: 'low',
      seedCombatants: false,
      onCrime: (event) => crimes.push(event),
    });
    const id = simulation.spawnEnemy('gunner', { x: 20, y: 0, z: 20 });
    if (!id) throw new Error('Missing stealth target');
    const target = simulation.getCombatNpcSnapshot().find((candidate) => candidate.id === id);
    if (!target) throw new Error('Missing detailed stealth target');
    const behind = {
      x: target.position.x + Math.sin(target.heading) * 1.4,
      y: 0,
      z: target.position.z + Math.cos(target.heading) * 1.4,
    };
    expect(simulation.tryStealthTakedown({ x: 40, y: 0, z: 40 })).toBeNull();
    expect(simulation.tryStealthTakedown(behind)).toMatchObject({
      targetId: id,
      defeated: true,
      effect: 'abstract-impact-flash',
    });
    expect(crimes.at(-1)).toMatchObject({ kind: 'assault', severity: 2 });
    expect(simulation.getCombatNpcSnapshot().find((candidate) => candidate.id === id)?.state)
      .toBe('incapacitated');
    simulation.dispose();
  });

  it('turns an ambient vehicle claim into a theft report while preserving the pool', () => {
    const crimes: CrimeEvent[] = [];
    const simulation = new CitySimulation({
      seed: 'traffic-theft',
      quality: 'low',
      seedCombatants: false,
      onCrime: (event) => crimes.push(event),
    });
    const target = simulation.getSnapshot().traffic[0];
    if (!target) throw new Error('Missing traffic vehicle');
    expect(simulation.claimTrafficVehicle(target.id)).toEqual(target);
    expect(simulation.getSnapshot().traffic).toHaveLength(18);
    expect(crimes.at(-1)).toMatchObject({ kind: 'vehicle-theft', sourceId: 'player' });
    simulation.dispose();
  });

  it('routes explicit crimes to witness callbacks', () => {
    const reports: WitnessReportEvent[] = [];
    const simulation = new CitySimulation({
      seed: 'witness-integration',
      quality: 'low',
      seedCombatants: false,
      onWitnessReport: (event) => reports.push(event),
    });
    const witness = simulation.getSnapshot().pedestrians[0];
    if (!witness) {
      throw new Error('Missing witness');
    }
    const crime = simulation.reportCrime({
      kind: 'vehicle-theft',
      sourceId: 'player',
      position: witness.position,
      severity: 2,
    });
    for (let frame = 0; frame < 60; frame += 1) {
      simulation.tick({
        deltaSeconds: 0.1,
        playerPosition: { x: 500, y: 0, z: 500 },
        playerHeading: 0,
      });
    }
    expect(reports.some((report) => report.crimeId === crime.id)).toBe(true);
    simulation.dispose();
  });

  it('attaches low-poly pooled visuals to a scene and disposes cleanly', () => {
    const scene = new Scene();
    const simulation = new CitySimulation({ seed: 'visuals', quality: 'low' });
    simulation.attach(scene);
    const fallbackRoot = scene.getObjectByName('city-simulation-visuals');
    expect(fallbackRoot).toBeDefined();
    expect(fallbackRoot?.children.filter((child) => child instanceof InstancedMesh))
      .toHaveLength(24);
    expect(fallbackRoot?.children.filter((child) => (
      child.visible && child.name.startsWith('low-quality-')
    ))).toHaveLength(1);
    simulation.detach();
    expect(scene.getObjectByName('city-simulation-visuals')).toBeUndefined();
    simulation.attach(scene, { supportsMultiDraw: true });
    const optimizedRoot = scene.getObjectByName('city-simulation-visuals');
    expect(optimizedRoot?.children.filter((child) => child instanceof InstancedMesh))
      .toHaveLength(24);
    expect(optimizedRoot?.children.filter((child) => (
      child.visible && child.name.startsWith('low-quality-')
    ))).toHaveLength(1);
    simulation.dispose();
    expect(scene.getObjectByName('city-simulation-visuals')).toBeUndefined();
    expect(() => simulation.tick({
      deltaSeconds: 0.1,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerHeading: 0,
    })).toThrow('disposed');
  });
});
