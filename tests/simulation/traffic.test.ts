import { describe, expect, it } from 'vitest';

import { directionFromHeading } from '../../src/simulation/math';
import { SimulationRandom } from '../../src/simulation/random';
import { TrafficSystem } from '../../src/simulation/traffic';
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
});

