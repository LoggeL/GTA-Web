import type { Page } from '@playwright/test';

export interface PerformanceQaApi {
  teleport(x: number, z: number): unknown;
  face(x: number, z: number): unknown;
  snapshot(): {
    readonly position: { readonly x: number; readonly z: number };
    readonly speedMetersPerSecond: number;
  } | null;
  audioState(): { readonly worldVoiceCount: number };
}

export type PerformanceWindow = Window & { __HEATLINE_QA__?: PerformanceQaApi };

export interface RuntimeSample {
  readonly heapBytes: number | null;
  readonly residentCells: number;
  readonly activeCollisions: number;
  readonly activeTraffic: number;
  readonly trafficLimit: number;
  readonly activePedestrians: number;
  readonly pedestrianLimit: number;
  readonly worldVoices: number;
  readonly playerX?: number;
  readonly playerZ?: number;
  readonly speedMetersPerSecond?: number;
}

export interface CellTransitionTiming {
  readonly fromCell: string;
  readonly toCell: string;
  readonly atMilliseconds: number;
  readonly frameMilliseconds: number;
}

export interface FrameTiming {
  readonly atMilliseconds: number;
  readonly frameMilliseconds: number;
}

export interface RuntimeLifecycleEvent {
  readonly reason: 'start' | 'visibilitychange' | 'focus' | 'blur' | 'resize' | 'orientationchange' | 'end';
  readonly atMilliseconds: number;
  readonly visibilityState: DocumentVisibilityState;
  readonly focused: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface TeleportTiming {
  readonly fromCell: string;
  readonly toCell: string;
  readonly destination: { readonly x: number; readonly z: number };
  readonly settleMilliseconds: number;
  readonly settled: boolean;
}

export interface AdjacentFrameTelemetry {
  readonly elapsedMilliseconds: number;
  readonly frames: readonly number[];
  readonly frameTimeline: readonly FrameTiming[];
  readonly samples: readonly RuntimeSample[];
  readonly transitions: readonly CellTransitionTiming[];
  readonly visitedCells: readonly string[];
  readonly lifecycle: readonly RuntimeLifecycleEvent[];
}

export const ADAPTATION_WARMUP_MILLISECONDS = 10_000;

export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function maximum(samples: readonly RuntimeSample[], key: keyof RuntimeSample): number {
  if (samples.length === 0) return 0;
  return Math.max(...samples.map((sample) => sample[key] ?? 0));
}

export function areAdjacentCells(fromCell: string, toCell: string): boolean {
  const parse = (cell: string): readonly [number, number] | null => {
    const match = /^cell:(-?\d+):(-?\d+)$/.exec(cell);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };
  const from = parse(fromCell);
  const to = parse(toCell);
  if (!from || !to) return false;
  return Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1])) === 1;
}

export async function readHeapBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as Performance & {
      memory?: { readonly usedJSHeapSize: number };
    }).memory;
    return memory?.usedJSHeapSize ?? null;
  });
}

export async function readRuntimeDiagnostics(page: Page) {
  return page.evaluate(() => {
    const world = document.querySelector<HTMLElement>('[data-world-mount]');
    const canvas = world?.querySelector<HTMLCanvasElement>('canvas') ?? null;
    const context = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? null;
    const debug = context?.getExtension('WEBGL_debug_renderer_info') as {
      readonly UNMASKED_RENDERER_WEBGL: number;
      readonly UNMASKED_VENDOR_WEBGL: number;
    } | null;
    const renderer = context ? String(context.getParameter(context.RENDERER)) : 'unavailable';
    const vendor = context ? String(context.getParameter(context.VENDOR)) : 'unavailable';
    const unmaskedRenderer = context && debug
      ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : renderer;
    const unmaskedVendor = context && debug
      ? String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL))
      : vendor;
    const resolvedQuality = world?.dataset.worldQuality === 'low' ? 'low' : 'high';
    const maximumDevicePixelRatio = resolvedQuality === 'high' ? 2 : 1.25;
    const cssWidth = canvas?.clientWidth ?? 0;
    const cssHeight = canvas?.clientHeight ?? 0;
    const bufferWidth = context?.drawingBufferWidth ?? canvas?.width ?? 0;
    const bufferHeight = context?.drawingBufferHeight ?? canvas?.height ?? 0;
    const renderPixelRatio = cssWidth > 0 ? bufferWidth / cssWidth : 0;
    const cappedDevicePixelRatio = Math.min(devicePixelRatio || 1, maximumDevicePixelRatio);
    const inferredResolutionScale = cappedDevicePixelRatio > 0
      ? renderPixelRatio / cappedDevicePixelRatio
      : 0;
    const attributes = context?.getContextAttributes();
    const softwareRenderer = /swiftshader|llvmpipe|software|lavapipe/i.test(
      `${renderer} ${unmaskedRenderer}`,
    );

    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      webglVersion: context instanceof WebGL2RenderingContext ? 2 : context ? 1 : 0,
      debugRendererInfoAvailable: debug !== null,
      renderer,
      vendor,
      unmaskedRenderer,
      unmaskedVendor,
      softwareRenderer,
      antialias: attributes?.antialias ?? null,
      buffer: { width: bufferWidth, height: bufferHeight },
      cssBuffer: { width: cssWidth, height: cssHeight },
      renderPixelRatio: Number(renderPixelRatio.toFixed(3)),
      quality: resolvedQuality,
      qualitySetting: `auto-${resolvedQuality}`,
      rendererClass: world?.dataset.rendererClass ?? 'unknown',
      adaptiveLevel: world?.dataset.performanceLevel ?? 'unknown',
      reportedResolutionScale: world?.dataset.resolutionScale
        ? Number(world.dataset.resolutionScale)
        : null,
      inferredResolutionScale: Number(inferredResolutionScale.toFixed(3)),
      currentCell: world?.dataset.currentCell ?? 'unknown',
    };
  });
}

export async function collectAdjacentTravelTelemetry(
  page: Page,
  durationMilliseconds: number,
): Promise<AdjacentFrameTelemetry> {
  return page.evaluate(async ({ courseDurationMilliseconds }) => {
    const worldMount = document.querySelector<HTMLElement>('[data-world-mount]');
    const api = (window as PerformanceWindow).__HEATLINE_QA__;
    if (!worldMount || !api) {
      throw new Error('Performance QA requires a running world and QA bridge');
    }

    const frames: number[] = [];
    const frameTimeline: FrameTiming[] = [];
    const samples: RuntimeSample[] = [];
    const transitions: CellTransitionTiming[] = [];
    const lifecycle: RuntimeLifecycleEvent[] = [];
    const visitedCells = new Set<string>();
    const startedAt = performance.now();
    let previousFrame = startedAt;
    let previousCell = worldMount.dataset.currentCell ?? '';
    let nextSampleAt = startedAt;
    if (previousCell) visitedCells.add(previousCell);

    const readNumber = (name: string): number => Number(worldMount.dataset[name] ?? 0);
    const recordLifecycle = (reason: RuntimeLifecycleEvent['reason']): void => {
      lifecycle.push({
        reason,
        atMilliseconds: performance.now() - startedAt,
        visibilityState: document.visibilityState,
        focused: document.hasFocus(),
        viewport: { width: innerWidth, height: innerHeight },
      });
    };
    const onVisibilityChange = (): void => recordLifecycle('visibilitychange');
    const onFocus = (): void => recordLifecycle('focus');
    const onBlur = (): void => recordLifecycle('blur');
    const onResize = (): void => recordLifecycle('resize');
    const onOrientationChange = (): void => recordLifecycle('orientationchange');
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onOrientationChange);
    recordLifecycle('start');
    const sample = (): void => {
      const memory = (performance as Performance & {
        memory?: { readonly usedJSHeapSize: number };
      }).memory;
      const snapshot = api.snapshot();
      samples.push({
        heapBytes: memory?.usedJSHeapSize ?? null,
        residentCells: readNumber('visualResidentCells'),
        activeCollisions: readNumber('activeCollisions'),
        activeTraffic: readNumber('activeTraffic'),
        trafficLimit: readNumber('trafficLimit'),
        activePedestrians: readNumber('activePedestrians'),
        pedestrianLimit: readNumber('pedestrianLimit'),
        worldVoices: api.audioState().worldVoiceCount,
        playerX: snapshot?.position.x ?? readNumber('playerX'),
        playerZ: snapshot?.position.z ?? readNumber('playerZ'),
        speedMetersPerSecond: snapshot?.speedMetersPerSecond ?? 0,
      });
    };

    sample();
    await new Promise<void>((resolve) => {
      const onFrame = (now: number): void => {
          const frameMilliseconds = now - previousFrame;
          frames.push(frameMilliseconds);
          frameTimeline.push({
            atMilliseconds: now - startedAt,
            frameMilliseconds,
          });
          previousFrame = now;

        const currentCell = worldMount.dataset.currentCell ?? previousCell;
        if (currentCell && currentCell !== previousCell) {
          transitions.push({
            fromCell: previousCell,
            toCell: currentCell,
            atMilliseconds: now - startedAt,
            frameMilliseconds,
          });
          previousCell = currentCell;
          visitedCells.add(currentCell);
        }
        if (now >= nextSampleAt) {
          sample();
          nextSampleAt = now + 500;
        }

        if (now - startedAt >= courseDurationMilliseconds) resolve();
        else requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      });
      recordLifecycle('end');
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onOrientationChange);
      sample();
      return {
        elapsedMilliseconds: performance.now() - startedAt,
        frames: frames.slice(1),
        frameTimeline: frameTimeline.slice(1),
        samples,
        transitions,
        visitedCells: [...visitedCells],
        lifecycle,
      };
  }, { courseDurationMilliseconds: durationMilliseconds });
}
