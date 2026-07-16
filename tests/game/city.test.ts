import { describe, expect, it } from 'vitest';

import {
  DISTRICTS,
  PLAYER_SPAWN,
  VEHICLE_SPAWN,
  districtAt,
  generateCity,
} from '../../src/game/city';
import { circleIntersectsBuildings } from '../../src/game/collision';

describe('procedural Solara layout', () => {
  it('is deterministic for a seed and quality level', () => {
    const first = generateCity('layout-seed', 'high');
    const second = generateCity('layout-seed', 'high');

    expect(first).toEqual(second);
    expect(first.roads).toHaveLength(50);
    expect(first.buildings).toHaveLength(300);
    expect(first.props).toHaveLength(184);
    expect(first.traversalObstacles).toHaveLength(2);
    expect(first.collisions).toHaveLength(first.buildings.length + first.traversalObstacles.length);
  });

  it('changes recipes for a different seed and reduces low-quality density', () => {
    const first = generateCity('layout-seed', 'high');
    const different = generateCity('different-layout-seed', 'high');
    const low = generateCity('layout-seed', 'low');

    expect(different.buildings).not.toEqual(first.buildings);
    expect(low.buildings).toHaveLength(200);
    expect(low.props).toHaveLength(88);
    expect(low.roads).toHaveLength(first.roads.length);
  });

  it('covers four named districts and keeps starter actors out of buildings', () => {
    const city = generateCity('starter-safety', 'high');
    expect(DISTRICTS.map((district) => district.id)).toEqual([
      'neon-strand',
      'alta-vista',
      'arroyo-heights',
      'breakwater',
    ]);
    expect(districtAt(-1, -1)).toBe('neon-strand');
    expect(districtAt(1, -1)).toBe('alta-vista');
    expect(districtAt(-1, 1)).toBe('arroyo-heights');
    expect(districtAt(1, 1)).toBe('breakwater');
    expect(circleIntersectsBuildings(PLAYER_SPAWN.x, PLAYER_SPAWN.z, 0.58, city.collisions)).toBe(false);
    expect(circleIntersectsBuildings(VEHICLE_SPAWN.x, VEHICLE_SPAWN.z, 1.48, city.collisions)).toBe(false);
  });
});
