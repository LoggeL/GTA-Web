import { describe, expect, it } from 'vitest';

import { WorldView } from '../../src/game/WorldView';
import type { CollisionRect } from '../../src/game/city';
import type { SimulationObstacle } from '../../src/simulation';

interface CollisionCacheHarness {
  exteriorCollisions: readonly CollisionRect[];
  exteriorCollisionCache: readonly CollisionRect[];
  exteriorObstructions: readonly SimulationObstacle[];
  roadClosureVisual: { readonly collisions: readonly CollisionRect[] };
  policeResponseVisual: { readonly collisions: readonly CollisionRect[] };
  interiorRuntime: {
    readonly currentDefinition: {
      readonly scene: { readonly collisions: readonly CollisionRect[] };
    } | null;
  };
  activeCollisions(): readonly CollisionRect[];
  rebuildExteriorCollisionCache(): void;
}

function collision(id: string, x: number): CollisionRect {
  return {
    id,
    minX: x,
    maxX: x + 4,
    minZ: -2,
    maxZ: 2,
    height: 8,
    kind: 'solid',
  };
}

describe('WorldView runtime collision derivations', () => {
  it('reuses one exterior collision and obstruction derivation until world inputs change', () => {
    const exterior = [collision('building', 0)];
    const road = [collision('closure', 10)];
    const police = [collision('roadblock', 20)];
    const harness = Object.create(WorldView.prototype) as unknown as CollisionCacheHarness;
    Object.assign(harness, {
      exteriorCollisions: exterior,
      exteriorCollisionCache: [],
      exteriorObstructions: [],
      roadClosureVisual: { collisions: road },
      policeResponseVisual: { collisions: police },
      interiorRuntime: { currentDefinition: null },
    });

    harness.rebuildExteriorCollisionCache();
    const first = harness.activeCollisions();
    expect(first).toEqual([...exterior, ...road, ...police]);
    expect(harness.activeCollisions()).toBe(first);
    expect(harness.exteriorObstructions).toEqual([
      { x: 2, z: 0, radius: 2 },
      { x: 12, z: 0, radius: 2 },
      { x: 22, z: 0, radius: 2 },
    ]);
  });

  it('uses authored interior collisions without rebuilding the exterior cache', () => {
    const interior = [collision('interior-wall', -4)];
    const exteriorCache = [collision('building', 0)];
    const harness = Object.create(WorldView.prototype) as unknown as CollisionCacheHarness;
    Object.assign(harness, {
      exteriorCollisions: exteriorCache,
      exteriorCollisionCache: exteriorCache,
      exteriorObstructions: [],
      roadClosureVisual: { collisions: [] },
      policeResponseVisual: { collisions: [] },
      interiorRuntime: { currentDefinition: { scene: { collisions: interior } } },
    });
    expect(harness.activeCollisions()).toBe(interior);
    expect(harness.exteriorCollisionCache).toBe(exteriorCache);
  });
});
