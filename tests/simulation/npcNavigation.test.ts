import { describe, expect, it } from 'vitest';

import {
  buildNpcNavigationGraph,
  findNpcNavigationPath,
  NpcNavigator,
} from '../../src/simulation/npcNavigation';
import type { SimulationRoadRecipe } from '../../src/simulation/types';

const crossingRoads: readonly SimulationRoadRecipe[] = [
  {
    id: 'east-west',
    position: { x: 0, y: 0, z: 0 },
    width: 220,
    depth: 18,
  },
  {
    id: 'north-south',
    position: { x: 0, y: 0, z: 0 },
    width: 18,
    depth: 220,
  },
];

describe('deterministic NPC navigation', () => {
  it('builds connected sidewalk paths and crosses between roads', () => {
    const first = buildNpcNavigationGraph(crossingRoads);
    const second = buildNpcNavigationGraph([...crossingRoads].reverse());
    expect(first.nodes).toEqual(second.nodes);
    expect(first.nodes.length).toBeGreaterThan(40);
    expect(first.nodes.every((node) => node.neighbors.length > 0)).toBe(true);

    const path = findNpcNavigationPath(
      first,
      { x: -95, y: 0, z: 11.4 },
      { x: 11.4, y: 0, z: 95 },
    );
    expect(path.length).toBeGreaterThan(4);
    expect(path.at(-1)).toEqual({ x: 11.4, y: 0, z: 95 });
    expect(path.some((point) => Math.abs(point.x) < 20 && Math.abs(point.z) < 20)).toBe(true);
  });

  it('steers around a local obstruction and reaches its destination', () => {
    const navigator = new NpcNavigator(buildNpcNavigationGraph([]), 1);
    let position = { x: -6, y: 0, z: 0 };
    navigator.setDestination(position, { x: 6, y: 0, z: 0 });
    let status = navigator.getStatus();
    for (let frame = 0; frame < 400 && status !== 'arrived'; frame += 1) {
      const step = navigator.step(position, {
        deltaSeconds: 0.1,
        speed: 2,
        radius: 0.35,
        obstacles: [{ x: 0, z: 0, radius: 1.4 }],
      });
      position = step.position;
      status = step.status;
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.z)).toBe(true);
    }
    expect(status).toBe('arrived');
    expect(position.x).toBeGreaterThan(5.3);
  });

  it('enters bounded recovery and gives up safely when fully enclosed', () => {
    const navigator = new NpcNavigator(buildNpcNavigationGraph([]), -1);
    let position = { x: 0, y: 0, z: 0 };
    navigator.setDestination(position, { x: 20, y: 0, z: 0 });
    let sawRecovery = false;
    for (let frame = 0; frame < 40; frame += 1) {
      const step = navigator.step(position, {
        deltaSeconds: 0.1,
        speed: 2,
        radius: 0.4,
        obstacles: [{ x: 0, z: 0, radius: 50 }],
      });
      position = step.position;
      sawRecovery ||= step.status === 'recovering';
      if (step.status === 'unreachable') break;
    }
    expect(sawRecovery).toBe(true);
    expect(navigator.getStatus()).toBe('unreachable');
    expect(navigator.getRecoveryCount()).toBeLessThanOrEqual(4);
    expect(position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('rejects ambiguous duplicate road identifiers', () => {
    expect(() => buildNpcNavigationGraph([crossingRoads[0]!, crossingRoads[0]!]))
      .toThrow('unique ids');
  });
});
