import { describe, expect, it } from 'vitest';

import { PLAYER_SPAWN, generateCity } from '../../src/game/city';
import { directionFromHeading, distance2d } from '../../src/simulation/math';
import { SimulationRandom, simulationSeed } from '../../src/simulation/random';
import {
  TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK,
  TRAFFIC_RELEVANCE_RADII,
  TrafficSystem,
  chooseTrafficVehicleClass,
} from '../../src/simulation/traffic';
import type { SimulationRoadRecipe } from '../../src/simulation/types';

const road: SimulationRoadRecipe = {
  id: 'test-road',
  position: { x: 0, y: 0, z: 0 },
  width: 18,
  depth: 600,
};

const PRODUCTION_WORLD_SEED = 'heatline-solara-world-v1';
const TRAFFIC_RANDOM_SALT = 0x4f219a;

describe('adaptive traffic pool', () => {
  it('uses the locked low/high active counts and deterministic placement', () => {
    const first = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    const second = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot()).toHaveLength(18);
    first.setQuality('high');
    expect(first.getSnapshot()).toHaveLength(42);
    first.setQuality('low');
    expect(first.getSnapshot()).toHaveLength(18);
  });

  it('yields to an obstruction, reverses, and recovers onto a road', () => {
    const traffic = new TrafficSystem(new SimulationRandom('obstruction-seed'), 'low', [road]);
    let first = traffic.getSnapshot()[0];
    expect(first).toBeDefined();

    for (let frame = 0; frame < 17; frame += 1) {
      first = traffic.getSnapshot()[0];
      if (!first) {
        throw new Error('Missing traffic agent');
      }
      const direction = directionFromHeading(first.heading);
      traffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [{ x: first.position.x + direction.x * 3, z: first.position.z + direction.z * 3, radius: 2 }],
      });
    }
    expect(traffic.getSnapshot()[0]?.behavior).toBe('recover');

    for (let frame = 0; frame < 10; frame += 1) {
      traffic.tick({ deltaSeconds: 0.1, sirenPosition: null, sirenRadius: 0, obstructions: [] });
    }
    expect(traffic.getSnapshot()[0]?.behavior).toBe('cruise');
  });

  it('supports panic and emergency-siren yielding hooks', () => {
    const traffic = new TrafficSystem(new SimulationRandom('hooks-seed'), 'low', [road]);
    const first = traffic.getSnapshot()[0];
    if (!first) {
      throw new Error('Missing traffic agent');
    }
    traffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: first.position,
      sirenRadius: 20,
      obstructions: [],
    });
    expect(traffic.getSnapshot()[0]?.behavior).toBe('siren-yield');

    traffic.triggerPanic(first.position, 20, 2);
    traffic.tick({ deltaSeconds: 0.1, sirenPosition: first.position, sirenRadius: 20, obstructions: [] });
    expect(traffic.getSnapshot()[0]?.behavior).toBe('panic');
  });

  it('expires panic and recovery clocks while higher pooled slots are throttled', () => {
    const panicTraffic = new TrafficSystem(
      new SimulationRandom('throttled-panic-traffic'),
      'high',
      [road],
    );
    const panicVehicle = panicTraffic.getSnapshot().at(-1);
    if (!panicVehicle) throw new Error('Missing throttled panic vehicle');
    panicTraffic.triggerPanic(panicVehicle.position, 0.1, 0.5);
    panicTraffic.tick({
      deltaSeconds: 0.1,
      sirenPosition: null,
      sirenRadius: 0,
      obstructions: [],
    });
    expect(panicTraffic.getSnapshot().find(({ id }) => id === panicVehicle.id)?.behavior)
      .toBe('panic');
    panicTraffic.setActorLimit(5);
    for (let frame = 0; frame < 10; frame += 1) {
      panicTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
    }
    panicTraffic.setActorLimit(42);
    expect(panicTraffic.getSnapshot().find(({ id }) => id === panicVehicle.id)).toMatchObject({
      behavior: 'cruise',
      panicRemaining: 0,
    });

    const recoveryTraffic = new TrafficSystem(
      new SimulationRandom('throttled-recovery-traffic'),
      'high',
      [road],
    );
    const recoveryVehicle = recoveryTraffic.getSnapshot().at(-1);
    if (!recoveryVehicle) throw new Error('Missing throttled recovery vehicle');
    for (let frame = 0; frame < 17; frame += 1) {
      const current = recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id);
      if (!current) throw new Error('Missing recovery vehicle');
      const direction = directionFromHeading(current.heading);
      recoveryTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [{
          x: current.position.x + direction.x * 3,
          z: current.position.z + direction.z * 3,
          radius: 2,
        }],
      });
    }
    expect(recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id)?.behavior)
      .toBe('recover');
    recoveryTraffic.setActorLimit(5);
    for (let frame = 0; frame < 10; frame += 1) {
      recoveryTraffic.tick({
        deltaSeconds: 0.1,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
    }
    recoveryTraffic.setActorLimit(42);
    expect(recoveryTraffic.getSnapshot().find(({ id }) => id === recoveryVehicle.id)?.behavior)
      .toBe('cruise');
  });

  it('uses deterministic district-weighted vehicle classes', () => {
    const sample = (district: 'neon-strand' | 'alta-vista' | 'arroyo-heights' | 'breakwater') => {
      const random = new SimulationRandom(`traffic-classes:${district}`);
      const counts = new Map<string, number>();
      for (let index = 0; index < 2_000; index += 1) {
        const classId = chooseTrafficVehicleClass(random, district);
        counts.set(classId, (counts.get(classId) ?? 0) + 1);
      }
      return counts;
    };
    const neon = sample('neon-strand');
    const alta = sample('alta-vista');
    const breakwater = sample('breakwater');
    expect(neon.get('compact') ?? 0).toBeGreaterThan(neon.get('van') ?? 0);
    expect(alta.get('sedan') ?? 0).toBeGreaterThan(alta.get('pickup') ?? 0);
    expect((breakwater.get('van') ?? 0) + (breakwater.get('pickup') ?? 0)).toBeGreaterThan(
      (breakwater.get('sports') ?? 0) + (breakwater.get('compact') ?? 0),
    );
  });

  it('claims and recycles a pooled vehicle without shrinking the traffic budget', () => {
    const traffic = new TrafficSystem(new SimulationRandom('claim-traffic'), 'low', [road]);
    const before = traffic.getSnapshot();
    const target = before[0];
    if (!target) throw new Error('Missing traffic claim target');
    const claimed = traffic.claimVehicle(target.id);
    expect(claimed).toEqual(target);
    const after = traffic.getSnapshot();
    expect(after).toHaveLength(before.length);
    expect(after.find((vehicle) => vehicle.id === target.id)?.position).not.toEqual(target.position);
    expect(traffic.claimVehicle('missing-traffic-id')).toBeNull();
  });

  it('keeps a dense deterministic road population around a moving player without close pop-in', () => {
    const roads = generateCity('ambient-traffic-locality', 'high').roads;
    const first = new TrafficSystem(
      new SimulationRandom('ambient-traffic-locality'),
      'high',
      roads,
    );
    const second = new TrafficSystem(
      new SimulationRandom('ambient-traffic-locality'),
      'high',
      [...roads].reverse(),
    );
    const playerPositions = [
      { x: -250, y: 0, z: -250 },
      { x: 250, y: 0, z: -250 },
      { x: 250, y: 0, z: 250 },
      { x: -250, y: 0, z: 250 },
    ] as const;
    let previous = new Map(first.getSnapshot().map((vehicle) => [vehicle.id, vehicle]));

    for (const playerPosition of playerPositions) {
      const context = {
        deltaSeconds: 0.01,
        playerPosition,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      } as const;
      first.tick(context);
      second.tick(context);
      const snapshot = first.getSnapshot();
      expect(second.getSnapshot()).toEqual(snapshot);
      expect(snapshot).toHaveLength(42);
      expect(snapshot.filter((vehicle) => (
        distance2d(vehicle.position, playerPosition)
          <= TRAFFIC_RELEVANCE_RADII.recycleBeyondDistance + 0.2
      )).length).toBeGreaterThanOrEqual(38);

      const relocated = snapshot.filter((vehicle) => {
        const prior = previous.get(vehicle.id);
        return prior !== undefined && distance2d(prior.position, vehicle.position) > 10;
      });
      for (const vehicle of relocated) {
        expect(distance2d(vehicle.position, playerPosition))
          .toBeGreaterThanOrEqual(TRAFFIC_RELEVANCE_RADII.minimumSpawnDistance - 0.2);
      }
      for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < snapshot.length; secondIndex += 1) {
          const firstVehicle = snapshot[firstIndex];
          const secondVehicle = snapshot[secondIndex];
          if (!firstVehicle || !secondVehicle) continue;
          expect(distance2d(firstVehicle.position, secondVehicle.position))
            .toBeGreaterThanOrEqual(TRAFFIC_RELEVANCE_RADII.minimumVehicleSpacing - 0.2);
        }
      }
      previous = new Map(snapshot.map((vehicle) => [vehicle.id, vehicle]));
    }
  });

  it('yields deterministically at intersections and avoids deadlock in a five-minute soak', () => {
    const crossingRoads: readonly SimulationRoadRecipe[] = [
      {
        id: 'major-vertical', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 18, depth: 600, major: true,
      },
      {
        id: 'local-horizontal', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 600, depth: 18,
      },
    ];
    const traffic = new TrafficSystem(new SimulationRandom('five-minute-traffic-soak'), 'low', crossingRoads);
    const stationarySeconds = new Map<string, number>();
    const maximumStationarySeconds = new Map<string, number>();
    let sawIntersectionYield = false;
    for (let frame = 0; frame < 3_000; frame += 1) {
      const playerPosition = {
        x: Math.sin(frame / 180) * 80,
        y: 0,
        z: 0,
      };
      traffic.tick({
        deltaSeconds: 0.1,
        playerPosition,
        sirenPosition: null,
        sirenRadius: 0,
        obstructions: [],
      });
      for (const vehicle of traffic.getSnapshot()) {
        sawIntersectionYield ||= vehicle.behavior === 'intersection-yield';
        const stationary = Math.abs(vehicle.speed) < 0.1
          ? (stationarySeconds.get(vehicle.id) ?? 0) + 0.1
          : 0;
        stationarySeconds.set(vehicle.id, stationary);
        maximumStationarySeconds.set(
          vehicle.id,
          Math.max(maximumStationarySeconds.get(vehicle.id) ?? 0, stationary),
        );
        expect(Number.isFinite(vehicle.position.x)).toBe(true);
        expect(Number.isFinite(vehicle.position.z)).toBe(true);
      }
    }
    expect(sawIntersectionYield).toBe(true);
    expect(Math.max(...maximumStationarySeconds.values())).toBeLessThan(3);
  });

  it.each(['low', 'high'] as const)(
    'keeps the exact production-seed %s pool collision-free for five minutes',
    (quality) => {
      const layout = generateCity(PRODUCTION_WORLD_SEED, quality);
      const citySeed = simulationSeed(`${layout.seed}:city-life`);
      const createTraffic = (roads: readonly SimulationRoadRecipe[]) => new TrafficSystem(
        new SimulationRandom((citySeed ^ TRAFFIC_RANDOM_SALT) >>> 0),
        quality,
        roads,
      );
      const first = createTraffic(layout.roads);
      const second = createTraffic([...layout.roads].reverse());
      const previousPositions = new Map(first.getSnapshot().map((vehicle) => [
        vehicle.id,
        { ...vehicle.position },
      ]));
      const stationarySeconds = new Map<string, number>();
      let maximumStationarySeconds = 0;
      let minimumPairDistance = Number.POSITIVE_INFINITY;
      let maximumPairChecks = 0;
      let closestPair = '';

      for (let frame = 0; frame < 3_000; frame += 1) {
        const context = {
          deltaSeconds: 0.1,
          playerPosition: PLAYER_SPAWN,
          sirenPosition: null,
          sirenRadius: 0,
          obstructions: [],
        } as const;
        first.tick(context);
        second.tick(context);
        const snapshot = first.getSnapshot();
        maximumPairChecks = Math.max(
          maximumPairChecks,
          first.getAvoidanceDiagnostics().lastTickPairChecks,
        );

        for (let firstIndex = 0; firstIndex < snapshot.length; firstIndex += 1) {
          const vehicle = snapshot[firstIndex];
          if (!vehicle) continue;
          const previous = previousPositions.get(vehicle.id);
          const stationary = previous && distance2d(previous, vehicle.position) < 0.01
            ? (stationarySeconds.get(vehicle.id) ?? 0) + 0.1
            : 0;
          stationarySeconds.set(vehicle.id, stationary);
          if (stationary > maximumStationarySeconds) {
            maximumStationarySeconds = stationary;
          }
          previousPositions.set(vehicle.id, { ...vehicle.position });

          for (let secondIndex = firstIndex + 1; secondIndex < snapshot.length; secondIndex += 1) {
            const other = snapshot[secondIndex];
            if (!other) continue;
            const pairDistance = distance2d(vehicle.position, other.position);
            if (pairDistance < minimumPairDistance) {
              minimumPairDistance = pairDistance;
              closestPair = JSON.stringify({
                time: (frame + 1) * 0.1,
                distance: pairDistance,
                first: vehicle,
                second: other,
              });
            }
          }
        }
        if (frame % 300 === 299) expect(second.getSnapshot()).toEqual(snapshot);
      }

      expect(minimumPairDistance, closestPair).toBeGreaterThanOrEqual(2);
      expect(maximumStationarySeconds).toBeLessThan(5);
      expect(maximumPairChecks).toBeLessThanOrEqual(
        TRAFFIC_AVOIDANCE_PAIR_BUDGET_PER_TICK,
      );
    },
  );
});
