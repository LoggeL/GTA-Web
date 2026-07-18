import { describe, expect, it } from 'vitest';

import { PLAYER_SPAWN, generateCity } from '../../src/game/city';
import { distance2d, pointBlocked } from '../../src/simulation/math';
import {
  PEDESTRIAN_CAPACITY,
  PEDESTRIAN_COLLISION_RADIUS,
  PEDESTRIAN_COMEDIC_TUMBLE,
  PEDESTRIAN_EXTERNAL_COLLISION_PAIR_BUDGET_PER_TICK,
  PEDESTRIAN_RELOCATION_BUDGET_PER_TICK,
  PEDESTRIAN_RELEVANCE_RADII,
  PEDESTRIAN_SEPARATION_PAIR_BUDGET_PER_TICK,
  PedestrianSystem,
} from '../../src/simulation/pedestrians';
import { SimulationRandom, simulationSeed } from '../../src/simulation/random';
import type { CrimeEvent, SimulationRoadRecipe, WitnessReportEvent } from '../../src/simulation/types';

const road: SimulationRoadRecipe = {
  id: 'pedestrian-test-road',
  position: { x: 0, y: 0, z: 0 },
  width: 500,
  depth: 18,
};

const PRODUCTION_WORLD_SEED = 'heatline-solara-world-v1';
const PEDESTRIAN_RANDOM_SALT = 0x9a712c;

describe('pedestrian life and witnesses', () => {
  it('uses deterministic adaptive pools', () => {
    const reports: WitnessReportEvent[] = [];
    const first = new PedestrianSystem(new SimulationRandom('ped-seed'), 'low', [road], (event) => reports.push(event));
    const second = new PedestrianSystem(new SimulationRandom('ped-seed'), 'low', [road], () => undefined);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot()).toHaveLength(30);
    first.setQuality('high');
    expect(first.getSnapshot()).toHaveLength(72);
  });

  it('separates an on-foot player from exact pedestrian overlap within the fixed budget', () => {
    const system = new PedestrianSystem(
      new SimulationRandom('on-foot-pedestrian-collision'),
      'low',
      [road],
      () => undefined,
    );
    system.setActorLimit(1);
    const target = system.getNpcSnapshot()[0];
    if (!target) throw new Error('Missing on-foot collision target');

    const result = system.resolveExternalCollision({
      kind: 'on-foot',
      position: { ...target.position },
      previousPosition: { ...target.position },
      velocity: { x: 0, z: 0 },
      radius: 0.58,
    });
    const correctedTarget = system.getNpcSnapshot()[0];
    if (!correctedTarget) throw new Error('Missing corrected pedestrian');

    expect(result.collided).toBe(true);
    expect(result.newPedestrianIds).toEqual([target.id]);
    expect(result.pairChecks).toBeLessThanOrEqual(
      PEDESTRIAN_EXTERNAL_COLLISION_PAIR_BUDGET_PER_TICK,
    );
    expect(distance2d(result.position, correctedTarget.position)).toBeGreaterThanOrEqual(
      0.58 + PEDESTRIAN_COLLISION_RADIUS,
    );
    expect(correctedTarget.state).toBe('startle');
    expect(system.getSnapshot()).toHaveLength(1);
  });

  it('sweeps a fast vehicle contact into one bounded comedic tumble and recovery', () => {
    const system = new PedestrianSystem(
      new SimulationRandom('vehicle-pedestrian-sweep'),
      'low',
      [road],
      () => undefined,
    );
    system.setActorLimit(1);
    system.tick(0.1, 0.1);
    const target = system.getNpcSnapshot()[0];
    if (!target) throw new Error('Missing swept collision target');

    const swept = system.resolveExternalCollision({
      kind: 'vehicle',
      previousPosition: {
        x: target.position.x - 9,
        y: 0,
        z: target.position.z,
      },
      position: {
        x: target.position.x + 9,
        y: 0,
        z: target.position.z,
      },
      velocity: { x: 24, z: 0 },
      radius: 1.25,
    });
    expect(swept.collided).toBe(true);
    expect(swept.primaryPedestrianId).toBe(target.id);
    expect(swept.position.x).toBeLessThan(target.position.x);
    expect(swept.impactSpeed).toBeGreaterThan(20);
    expect(swept.velocity.x).toBeLessThan(12);
    expect(swept.newPedestrianIds).toEqual([target.id]);
    expect(system.getNpcSnapshot()[0]).toMatchObject({
      state: 'tumble',
      behavior: 'flee',
      motion: {
        kind: 'comedic-tumble',
        impactSpeed: swept.impactSpeed,
      },
    });

    const currentTarget = system.getNpcSnapshot()[0];
    if (!currentTarget) throw new Error('Missing sustained contact target');
    const sustained = system.resolveExternalCollision({
      kind: 'vehicle',
      position: { ...currentTarget.position },
      previousPosition: { ...currentTarget.position },
      velocity: { x: 8, z: 0 },
      radius: 1.25,
    });
    expect(sustained.collided).toBe(false);
    expect(sustained.newPedestrianIds).toEqual([]);

    let maximumHeight = 0;
    let groundTouches = 0;
    let wasAirborne = false;
    for (let frame = 0; frame < 70; frame += 1) {
      system.tick(0.05, 0.15 + frame * 0.05);
      const pedestrian = system.getNpcSnapshot()[0];
      if (!pedestrian) throw new Error('Missing tumbling pedestrian');
      maximumHeight = Math.max(maximumHeight, pedestrian.position.y);
      if (pedestrian.position.y > 0.001) {
        wasAirborne = true;
      } else if (wasAirborne) {
        groundTouches += 1;
        wasAirborne = false;
      }
      expect(pedestrian.position.y).toBeGreaterThanOrEqual(0);
      if (pedestrian.state !== 'tumble') break;
    }
    const recovered = system.getNpcSnapshot()[0];
    if (!recovered) throw new Error('Missing recovered pedestrian');
    expect(maximumHeight).toBeGreaterThan(1);
    expect(maximumHeight).toBeLessThan(3.5);
    expect(groundTouches).toBeLessThanOrEqual(
      PEDESTRIAN_COMEDIC_TUMBLE.maximumBounces + 1,
    );
    expect(recovered.state).toBe('flee');
    expect(recovered.position.y).toBe(0);
    expect(recovered.motion).toEqual({ kind: 'grounded' });
    expect(distance2d(recovered.position, target.position)).toBeGreaterThan(4);
    expect(distance2d(recovered.position, target.position)).toBeLessThan(20);
    const landingOverlap = system.resolveExternalCollision({
      kind: 'vehicle',
      position: { ...recovered.position },
      previousPosition: { ...recovered.position },
      velocity: { x: 20, z: 0 },
      radius: 1.25,
    });
    expect(landingOverlap.collided).toBe(false);
    expect(landingOverlap.newPedestrianIds).toEqual([]);
  });

  it('keeps a launched pedestrian outside walls without growing the pool', () => {
    const system = new PedestrianSystem(
      new SimulationRandom('pedestrian-tumble-wall-safety'),
      'low',
      [road],
      () => undefined,
    );
    system.setActorLimit(1);
    system.tick(0.1, 0.1);
    const target = system.getNpcSnapshot()[0];
    if (!target) throw new Error('Missing tumble wall target');
    const obstacle = {
      x: target.position.x + 3,
      z: target.position.z,
      radius: 1.25,
    };
    const result = system.resolveExternalCollision({
      kind: 'vehicle',
      previousPosition: { x: target.position.x - 7, y: 0, z: target.position.z },
      position: { x: target.position.x + 7, y: 0, z: target.position.z },
      velocity: { x: 20, z: 0 },
      radius: 1.25,
    }, [obstacle]);
    expect(result.newImpactSpeed).toBeGreaterThan(
      PEDESTRIAN_COMEDIC_TUMBLE.minimumImpactSpeed,
    );

    for (let frame = 0; frame < 55; frame += 1) {
      system.tick(0.05, 0.15 + frame * 0.05, { obstacles: [obstacle] });
      const pedestrian = system.getNpcSnapshot()[0];
      if (!pedestrian) throw new Error('Missing wall-safe tumble');
      expect(pointBlocked(pedestrian.position, 0.32, [obstacle])).toBe(false);
    }
    expect(system.getSnapshot()).toHaveLength(1);
  });

  it('keeps pedestrian displacement outside static obstacles', () => {
    const system = new PedestrianSystem(
      new SimulationRandom('pedestrian-wall-safety'),
      'low',
      [road],
      () => undefined,
    );
    system.setActorLimit(1);
    const target = system.getNpcSnapshot()[0];
    if (!target) throw new Error('Missing wall-safety target');
    const obstacle = {
      x: target.position.x + 0.85,
      z: target.position.z,
      radius: 0.3,
    };
    const result = system.resolveExternalCollision({
      kind: 'on-foot',
      position: { ...target.position },
      velocity: { x: 0, z: 0 },
      radius: 0.58,
    }, [obstacle]);
    const correctedTarget = system.getNpcSnapshot()[0];
    if (!correctedTarget) throw new Error('Missing wall-safe pedestrian');

    expect(result.collided).toBe(true);
    expect(pointBlocked(correctedTarget.position, 0.32, [obstacle])).toBe(false);
    expect(distance2d(result.position, correctedTarget.position)).toBeGreaterThanOrEqual(
      0.58 + PEDESTRIAN_COLLISION_RADIUS,
    );
  });

  it('flees nearby serious crime, then submits one witness report', () => {
    const reports: WitnessReportEvent[] = [];
    const system = new PedestrianSystem(new SimulationRandom('witness-seed'), 'low', [road], (event) => reports.push(event));
    const witness = system.getSnapshot()[0];
    if (!witness) {
      throw new Error('Missing pedestrian');
    }
    const crime: CrimeEvent = {
      id: 'crime-test',
      kind: 'assault',
      sourceId: 'player',
      position: { ...witness.position },
      severity: 3,
      simulationTime: 0,
    };
    system.observeCrime(crime);
    expect(system.getSnapshot().find((pedestrian) => pedestrian.id === witness.id)?.behavior).toBe('flee');

    for (let frame = 0; frame < 60; frame += 1) {
      system.tick(0.1, frame * 0.1);
    }
    expect(reports.some((report) => report.crimeId === crime.id && report.witnessId === witness.id)).toBe(true);
    const reportCount = reports.length;
    for (let frame = 0; frame < 20; frame += 1) {
      system.tick(0.1, 6 + frame * 0.1);
    }
    expect(reports).toHaveLength(reportCount);
  });

  it('finishes a witness lifecycle while its pooled slot is adaptively throttled', () => {
    const reports: WitnessReportEvent[] = [];
    const system = new PedestrianSystem(
      new SimulationRandom('throttled-witness-seed'),
      'high',
      [road],
      (event) => reports.push(event),
    );
    const witness = system.getSnapshot().at(-1);
    if (!witness) throw new Error('Missing throttled witness');
    const crime: CrimeEvent = {
      id: 'crime-throttled-witness',
      kind: 'assault',
      sourceId: 'player',
      position: { ...witness.position },
      severity: 5,
      simulationTime: 0,
    };

    system.observeCrime(crime);
    expect(system.getNpcSnapshot().find(({ id }) => id === witness.id)?.state).toBe('flee');
    expect(system.setActorLimit(10)).toBe(10);
    expect(system.getSnapshot().some(({ id }) => id === witness.id)).toBe(false);

    for (let frame = 0; frame < 60; frame += 1) {
      system.tick(0.1, frame * 0.1);
    }

    const witnessReports = reports.filter((report) => (
      report.crimeId === crime.id && report.witnessId === witness.id
    ));
    expect(witnessReports).toHaveLength(1);
    expect(witnessReports[0]?.simulationTime).toBeLessThan(6);

    expect(system.setActorLimit(PEDESTRIAN_CAPACITY.high)).toBe(PEDESTRIAN_CAPACITY.high);
    expect(system.getNpcSnapshot().find(({ id }) => id === witness.id)).toMatchObject({
      state: 'wander',
      behavior: 'wander',
      pendingCrimeId: null,
    });
    for (let frame = 0; frame < 20; frame += 1) {
      system.tick(0.1, 6 + frame * 0.1);
    }
    expect(reports.filter((report) => (
      report.crimeId === crime.id && report.witnessId === witness.id
    ))).toHaveLength(1);
  });

  it('enters flee state through the general panic hook', () => {
    const system = new PedestrianSystem(new SimulationRandom('panic-seed'), 'low', [road], () => undefined);
    const pedestrian = system.getSnapshot()[0];
    if (!pedestrian) {
      throw new Error('Missing pedestrian');
    }
    system.triggerPanic(pedestrian.position, 5, 2);
    expect(system.getSnapshot()[0]?.behavior).toBe('flee');
    for (let frame = 0; frame < 23; frame += 1) {
      system.tick(0.1, frame * 0.1);
    }
    expect(system.getSnapshot()[0]?.behavior).toBe('wander');
  });

  it('uses connected nav, deterministic temperaments, and obstacle recovery', () => {
    const first = new PedestrianSystem(new SimulationRandom('ped-nav'), 'low', [road], () => undefined);
    const second = new PedestrianSystem(new SimulationRandom('ped-nav'), 'low', [road], () => undefined);
    expect(first.getNavigationGraph().nodes.length).toBeGreaterThan(20);
    expect(first.getNpcSnapshot().map(({ temperament }) => temperament).slice(0, 6)).toEqual([
      'calm', 'cautious', 'nervous', 'calm', 'cautious', 'nervous',
    ]);
    for (let frame = 0; frame < 200; frame += 1) {
      const pedestrian = first.getNpcSnapshot()[0];
      const obstacle = pedestrian
        ? [{ x: pedestrian.position.x, z: pedestrian.position.z, radius: 1.4 }]
        : [];
      first.tick(0.1, frame * 0.1, { obstacles: obstacle });
      second.tick(0.1, frame * 0.1, { obstacles: obstacle });
      expect(first.getNpcSnapshot()).toEqual(second.getNpcSnapshot());
    }
    expect(first.getNpcSnapshot().every((pedestrian) => (
      Number.isFinite(pedestrian.position.x)
      && Number.isFinite(pedestrian.position.z)
      && pedestrian.recoveryCount <= 4
    ))).toBe(true);
  });

  it('reacts to non-visual noise without fabricating a witness report', () => {
    const reports: WitnessReportEvent[] = [];
    const system = new PedestrianSystem(
      new SimulationRandom('ped-noise'),
      'low',
      [road],
      (event) => reports.push(event),
    );
    const pedestrian = system.getSnapshot()[0];
    if (!pedestrian) throw new Error('Missing pedestrian');
    system.hearNoise({
      id: 'noise-1',
      position: pedestrian.position,
      radius: 10,
      severity: 4,
      directThreat: true,
    });
    expect(system.getNpcSnapshot()[0]).toMatchObject({
      state: 'flee',
      reaction: 'flee',
      pendingCrimeId: null,
    });
    for (let frame = 0; frame < 50; frame += 1) system.tick(0.1, frame * 0.1);
    expect(reports).toHaveLength(0);
  });

  it('repopulates valid sidewalks densely and deterministically as the player crosses districts', () => {
    const roads = generateCity('ambient-pedestrian-locality', 'high').roads;
    const first = new PedestrianSystem(
      new SimulationRandom('ambient-pedestrian-locality'),
      'high',
      roads,
      () => undefined,
    );
    const second = new PedestrianSystem(
      new SimulationRandom('ambient-pedestrian-locality'),
      'high',
      [...roads].reverse(),
      () => undefined,
    );
    const playerPositions = [
      { x: -250, y: 0, z: -250 },
      { x: 250, y: 0, z: -250 },
      { x: 250, y: 0, z: 250 },
      { x: -250, y: 0, z: 250 },
    ] as const;
    for (const [index, playerPosition] of playerPositions.entries()) {
      const ticksToDrainRelocations = Math.ceil(
        PEDESTRIAN_CAPACITY.high / PEDESTRIAN_RELOCATION_BUDGET_PER_TICK,
      ) + 4;
      for (let tick = 0; tick < ticksToDrainRelocations; tick += 1) {
        const before = new Map(first.getSnapshot().map((pedestrian) => [
          pedestrian.id,
          pedestrian,
        ]));
        const simulationTime = index * ticksToDrainRelocations * 0.01 + tick * 0.01;
        first.tick(0.01, simulationTime, { playerPosition });
        second.tick(0.01, simulationTime, { playerPosition });
        const snapshot = first.getSnapshot();
        expect(second.getSnapshot()).toEqual(snapshot);

        const diagnostics = first.getRelevanceDiagnostics();
        expect(diagnostics.lastTickRelocationAttempts)
          .toBeLessThanOrEqual(PEDESTRIAN_RELOCATION_BUDGET_PER_TICK);
        expect(diagnostics.lastTickRelocations)
          .toBeLessThanOrEqual(diagnostics.lastTickRelocationAttempts);
        expect(diagnostics.candidateRebuildCount).toBe(index + 1);
        expect(diagnostics.cachedCandidateCount).toBeGreaterThan(0);

        const relocated = snapshot.filter((pedestrian) => {
          const prior = before.get(pedestrian.id);
          return prior !== undefined && distance2d(prior.position, pedestrian.position) > 8;
        });
        expect(relocated).toHaveLength(diagnostics.lastTickRelocations);
        expect(relocated.length).toBeLessThanOrEqual(PEDESTRIAN_RELOCATION_BUDGET_PER_TICK);
        for (const pedestrian of relocated) {
          expect(distance2d(pedestrian.position, playerPosition))
            .toBeGreaterThanOrEqual(PEDESTRIAN_RELEVANCE_RADII.minimumSpawnDistance - 0.2);
          expect(distance2d(pedestrian.position, playerPosition))
            .toBeLessThanOrEqual(PEDESTRIAN_RELEVANCE_RADII.maximumSpawnDistance + 0.2);
          expect(Math.min(...first.getNavigationGraph().nodes.map((node) =>
            distance2d(node.position, pedestrian.position))))
            .toBeLessThan(0.02);
          for (const other of snapshot) {
            if (other.id === pedestrian.id) continue;
            expect(distance2d(pedestrian.position, other.position))
              .toBeGreaterThanOrEqual(
                PEDESTRIAN_RELEVANCE_RADII.minimumPedestrianSpacing - 0.05,
              );
          }
        }
      }

      const snapshot = first.getSnapshot();
      expect(snapshot).toHaveLength(PEDESTRIAN_CAPACITY.high);
      expect(snapshot.filter((pedestrian) => (
        distance2d(pedestrian.position, playerPosition)
          <= PEDESTRIAN_RELEVANCE_RADII.recycleBeyondDistance + 0.2
      )).length).toBeGreaterThanOrEqual(60);
    }
  });

  it('preserves the moving-player pool and avoids pedestrian deadlock for five minutes', () => {
    const roads = generateCity('ambient-pedestrian-five-minute-soak', 'low').roads;
    const first = new PedestrianSystem(
      new SimulationRandom('ambient-pedestrian-five-minute-soak'),
      'low',
      roads,
      () => undefined,
    );
    const second = new PedestrianSystem(
      new SimulationRandom('ambient-pedestrian-five-minute-soak'),
      'low',
      [...roads].reverse(),
      () => undefined,
    );
    const expectedIds = first.getSnapshot().map(({ id }) => id);
    const stationarySeconds = new Map<string, number>();
    const maximumStationarySeconds = new Map<string, number>();
    let minimumRelevantCount = Number.POSITIVE_INFINITY;

    for (let frame = 0; frame < 3_000; frame += 1) {
      const pathPhase = (frame % 1_200) / 1_200;
      const playerPosition = {
        x: pathPhase < 0.5
          ? -450 + pathPhase * 1_800
          : 1_350 - pathPhase * 1_800,
        y: 0,
        z: 0,
      };
      const context = { playerPosition } as const;
      first.tick(0.1, frame * 0.1, context);
      second.tick(0.1, frame * 0.1, context);
      expect(first.getRelevanceDiagnostics().lastTickRelocationAttempts)
        .toBeLessThanOrEqual(PEDESTRIAN_RELOCATION_BUDGET_PER_TICK);
      expect(first.getRelevanceDiagnostics().lastTickRelocations)
        .toBeLessThanOrEqual(PEDESTRIAN_RELOCATION_BUDGET_PER_TICK);
      const snapshot = first.getNpcSnapshot();
      expect(snapshot.map(({ id }) => id)).toEqual(expectedIds);
      for (const pedestrian of snapshot) {
        const stationary = pedestrian.speed < 0.05
          ? (stationarySeconds.get(pedestrian.id) ?? 0) + 0.1
          : 0;
        stationarySeconds.set(pedestrian.id, stationary);
        maximumStationarySeconds.set(
          pedestrian.id,
          Math.max(maximumStationarySeconds.get(pedestrian.id) ?? 0, stationary),
        );
        expect(Number.isFinite(pedestrian.position.x)).toBe(true);
        expect(Number.isFinite(pedestrian.position.z)).toBe(true);
        expect(pedestrian.recoveryCount).toBeLessThanOrEqual(4);
      }
      if (frame % 100 === 99) {
        minimumRelevantCount = Math.min(
          minimumRelevantCount,
          snapshot.filter((pedestrian) => (
            distance2d(pedestrian.position, playerPosition)
              <= PEDESTRIAN_RELEVANCE_RADII.recycleBeyondDistance + 2
          )).length,
        );
        expect(second.getNpcSnapshot()).toEqual(snapshot);
      }
    }

    expect(minimumRelevantCount).toBeGreaterThanOrEqual(25);
    expect(Math.max(...maximumStationarySeconds.values())).toBeLessThan(5);
  }, 15_000);

  it.each(['low', 'high'] as const)(
    'keeps the exact production-seed %s pool locally separated for sixty seconds',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const citySeed = simulationSeed(`${layout.seed}:city-life`);
      const createSystem = (roads: readonly SimulationRoadRecipe[]) => new PedestrianSystem(
        new SimulationRandom((citySeed ^ PEDESTRIAN_RANDOM_SALT) >>> 0),
        quality,
        roads,
        () => undefined,
      );
      const first = createSystem(layout.roads);
      const second = createSystem([...layout.roads].reverse());
      const previousPositions = new Map(first.getSnapshot().map((pedestrian) => [
        pedestrian.id,
        { ...pedestrian.position },
      ]));
      const stationarySeconds = new Map<string, number>();
      let maximumStationarySeconds = 0;
      let minimumPairDistance = Number.POSITIVE_INFINITY;
      let maximumPairChecks = 0;

      for (let frame = 0; frame < 600; frame += 1) {
        const simulationTime = (frame + 1) * 0.1;
        const context = { playerPosition: PLAYER_SPAWN } as const;
        first.tick(0.1, simulationTime, context);
        second.tick(0.1, simulationTime, context);
        const snapshot = first.getSnapshot();
        maximumPairChecks = Math.max(
          maximumPairChecks,
          first.getRelevanceDiagnostics().lastTickSeparationPairChecks,
        );

        for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
          const pedestrian = snapshot[firstIndex];
          if (!pedestrian) continue;
          const previous = previousPositions.get(pedestrian.id);
          const stationary = previous && distance2d(previous, pedestrian.position) < 0.01
            ? (stationarySeconds.get(pedestrian.id) ?? 0) + 0.1
            : 0;
          stationarySeconds.set(pedestrian.id, stationary);
          maximumStationarySeconds = Math.max(maximumStationarySeconds, stationary);
          previousPositions.set(pedestrian.id, { ...pedestrian.position });

          for (let secondIndex = firstIndex + 1; secondIndex < snapshot.length; secondIndex += 1) {
            const other = snapshot[secondIndex];
            if (!other) continue;
            minimumPairDistance = Math.min(
              minimumPairDistance,
              distance2d(pedestrian.position, other.position),
            );
          }
        }
        if (frame % 60 === 59) expect(second.getSnapshot()).toEqual(snapshot);
      }

      expect(minimumPairDistance).toBeGreaterThanOrEqual(0.5);
      expect(maximumStationarySeconds).toBeLessThan(5);
      expect(maximumPairChecks).toBeLessThanOrEqual(
        PEDESTRIAN_SEPARATION_PAIR_BUDGET_PER_TICK,
      );
    },
  );
});
