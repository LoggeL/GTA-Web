import {
  ACESFilmicToneMapping,
  ReinhardToneMapping,
  SRGBColorSpace,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  class FakeCanvas extends EventTarget {
    public className = '';
    public readonly style = {
      width: '',
      height: '',
      display: '',
    };

    public focus(): void {}

    public remove(): void {}
  }

  class FakeWebGLRenderer {
    public readonly constructorOptions: unknown;
    public readonly domElement = new FakeCanvas();
    public readonly extensions = {
      has: vi.fn(() => true),
    };
    public readonly shadowMap = {
      enabled: false,
      type: 0,
    };
    public outputColorSpace = '';
    public toneMapping = 0;
    public toneMappingExposure = 1;
    public readonly render = vi.fn();
    public readonly dispose = vi.fn();
    public readonly setPixelRatio = vi.fn();
    public readonly setSize = vi.fn();

    public constructor(options: unknown) {
      this.constructorOptions = options;
    }
  }

  return {
    ...actual,
    WebGLRenderer: FakeWebGLRenderer,
  };
});

import { WorldView } from '../../src/game/WorldView';

interface RendererHarness {
  readonly constructorOptions: {
    readonly antialias: boolean;
    readonly alpha: boolean;
    readonly powerPreference: string;
  };
  readonly render: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

function installBrowserWindow(): void {
  const browserWindow = new EventTarget();
  Object.defineProperty(browserWindow, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
  vi.stubGlobal('window', browserWindow);
}

function createMount(): HTMLElement {
  return {
    clientWidth: 960,
    clientHeight: 540,
    append: vi.fn(),
  } as unknown as HTMLElement;
}

describe('WorldView quality-specific tone mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('constructs low quality with Reinhard while retaining color and exposure policy', () => {
    installBrowserWindow();
    const world = new WorldView({
      mount: createMount(),
      seed: 'low-tone-mapping',
      quality: 'low',
      enableDefaultControls: false,
    });
    const renderer = world.renderer as unknown as RendererHarness;

    expect(world.layout.quality).toBe('low');
    expect(world.renderer.toneMapping).toBe(ReinhardToneMapping);
    expect(world.renderer.outputColorSpace).toBe(SRGBColorSpace);
    expect(world.renderer.toneMappingExposure).toBe(1.08);
    expect(world.renderer.shadowMap.enabled).toBe(false);
    expect(renderer.constructorOptions).toEqual({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });

    world.render();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalledWith(world.scene, world.camera);
    world.dispose();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('constructs high quality with the existing ACES renderer policy unchanged', () => {
    installBrowserWindow();
    const world = new WorldView({
      mount: createMount(),
      seed: 'high-tone-mapping',
      quality: 'high',
      enableDefaultControls: false,
    });
    const renderer = world.renderer as unknown as RendererHarness;

    expect(world.layout.quality).toBe('high');
    expect(world.renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(world.renderer.outputColorSpace).toBe(SRGBColorSpace);
    expect(world.renderer.toneMappingExposure).toBe(1.08);
    expect(world.renderer.shadowMap.enabled).toBe(true);
    expect(renderer.constructorOptions).toEqual({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });

    world.render();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalledWith(world.scene, world.camera);
    world.dispose();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
