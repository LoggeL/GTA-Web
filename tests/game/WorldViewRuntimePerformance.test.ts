import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

import { WorldView } from '../../src/game/WorldView';
import { MINIMUM_ADAPTIVE_RESOLUTION_SCALE } from '../../src/game/CityStreamingController';
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

interface PresentationHarness {
  disposed: boolean;
  reducedMotion: boolean;
  cameraShake: number;
  resolutionScale: number;
  camera: PerspectiveCamera;
  cameraShakeOffset: Vector3;
  cameraImpactStrength: number;
  resize: ReturnType<typeof vi.fn>;
  setPresentation(options: {
    readonly reducedMotion?: boolean;
    readonly cameraShake?: number;
    readonly resolutionScale?: number;
  }): void;
}

interface ResizeHarness {
  disposed: boolean;
  resolutionScale: number;
  layout: { readonly quality: 'low' | 'high' };
  mount: { readonly clientWidth: number; readonly clientHeight: number };
  renderer: {
    setPixelRatio: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
  };
  camera: {
    aspect: number;
    updateProjectionMatrix: ReturnType<typeof vi.fn>;
  };
  resize(width?: number, height?: number): void;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorldView adaptive resolution presentation', () => {
  it('accepts the runtime-only 0.35 floor and rejects non-finite presentation values', () => {
    const harness = Object.create(WorldView.prototype) as unknown as PresentationHarness;
    Object.assign(harness, {
      disposed: false,
      reducedMotion: false,
      cameraShake: 1,
      resolutionScale: 1,
      camera: new PerspectiveCamera(),
      cameraShakeOffset: new Vector3(),
      cameraImpactStrength: 0,
      resize: vi.fn(),
    });

    harness.setPresentation({ resolutionScale: 0.35 });
    expect(harness.resolutionScale).toBe(MINIMUM_ADAPTIVE_RESOLUTION_SCALE);
    expect(harness.resize).toHaveBeenCalledOnce();
    expect(() => harness.setPresentation({ resolutionScale: Number.NaN }))
      .toThrowError('resolutionScale must be finite');
    expect(() => harness.setPresentation({ resolutionScale: Number.POSITIVE_INFINITY }))
      .toThrowError('resolutionScale must be finite');
  });

  it('uses the same 0.35 contract as the renderer pixel-ratio floor', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const setPixelRatio = vi.fn();
    const setSize = vi.fn();
    const updateProjectionMatrix = vi.fn();
    const harness = Object.create(WorldView.prototype) as unknown as ResizeHarness;
    Object.assign(harness, {
      disposed: false,
      resolutionScale: MINIMUM_ADAPTIVE_RESOLUTION_SCALE,
      layout: { quality: 'low' },
      mount: { clientWidth: 640, clientHeight: 360 },
      renderer: { setPixelRatio, setSize },
      camera: { aspect: 1, updateProjectionMatrix },
    });

    harness.resize();

    expect(setPixelRatio).toHaveBeenCalledWith(MINIMUM_ADAPTIVE_RESOLUTION_SCALE);
    expect(setSize).toHaveBeenCalledWith(640, 360, false);
    expect(harness.camera.aspect).toBeCloseTo(640 / 360);
    expect(updateProjectionMatrix).toHaveBeenCalledOnce();
  });
});
