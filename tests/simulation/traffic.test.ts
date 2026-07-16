import { describe, expect, it } from 'vitest';

import { directionFromHeading } from '../../src/simulation/math';
import { SimulationRandom } from '../../src/simulation/random';
import { TrafficSystem, chooseTrafficVehicleClass } from '../../src/simulation/traffic';
import type { SimulationRoadRecipe } from '../../src/simulation/types';

const road: SimulationRoadRecipe = {
  id: 'test-road',
  position: { x: 0, y: 0, z: 0 },
  width: 18,
  depth: 600,
};

describe('adaptive traffic pool', () => {
  it('uses the locked low/high active counts and deterministic placement', () => {
    const first = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    const second = new TrafficSystem(new SimulationRandom('traffic-seed'), 'low', [road]);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot()).toHaveLength(10);
    first.setQuality('high');
    expect(first.getSnapshot()).toHaveLength(24);
    first.setQuality('low');
    expect(first.getSnapshot()).toHaveLength(10);
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

  it('yields deterministically at intersections and avoids deadlock in a five-minute soak', () => {
    const crossingRoads: readonly SimulationRoadRecipe[] = [
      {
        id: 'major-vertical', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 18, depth: 240, major: true,
      },
      {
        id: 'local-horizontal', district: 'arroyo-heights',
        position: { x: 0, y: 0, z: 0 }, width: 240, depth: 18,
      },
    ];
    const traffic = new TrafficSystem(new SimulationRandom('five-minute-traffic-soak'), 'low', crossingRoads);
    const stationarySeconds = new Map<string, number>();
    const maximumStationarySeconds = new Map<string, number>();
    let sawIntersectionYield = false;
    for (let frame = 0; frame < 3_000; frame += 1) {
      traffic.tick({ deltaSeconds: 0.1, sirenPosition: null, sirenRadius: 0, obstructions: [] });
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
});
