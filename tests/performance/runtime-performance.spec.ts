import { startNewGame } from '../e2e/helpers';
import { expect, test } from '../e2e/fixtures';

interface PerformanceQaApi {
  teleport(x: number, z: number): unknown;
  audioState(): { readonly worldVoiceCount: number };
}

type PerformanceWindow = Window & { __HEATLINE_QA__?: PerformanceQaApi };

interface RuntimeSample {
  readonly heapBytes: number | null;
  readonly residentCells: number;
  readonly activeCollisions: number;
  readonly activeTraffic: number;
  readonly trafficLimit: number;
  readonly activePedestrians: number;
  readonly pedestrianLimit: number;
  readonly worldVoices: number;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function maximum(samples: readonly RuntimeSample[], key: keyof RuntimeSample): number {
  return Math.max(...samples.map((sample) => sample[key] ?? 0));
}

const configuredDuration = Number(process.env.HEATLINE_SOAK_SECONDS ?? '30');
const durationSeconds = Number.isFinite(configuredDuration) && configuredDuration > 0
  ? configuredDuration
  : 30;

test.describe('M8 browser performance and recovery', () => {
  test('runtime frame telemetry and pools stay within release bounds', async ({ page, isMobile }) => {
    test.setTimeout((durationSeconds + 45) * 1_000);
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await page.waitForFunction(() => Boolean((window as PerformanceWindow).__HEATLINE_QA__));
    await page.keyboard.press('e');
    await expect(page.getByLabel('3D game world')).toHaveAttribute('data-player-mode', 'vehicle');
    await page.waitForTimeout(1_500);

    await page.requestGC();
    const heapBefore = await page.evaluate(() => {
      const memory = (performance as Performance & {
        memory?: { readonly usedJSHeapSize: number };
      }).memory;
      return memory?.usedJSHeapSize ?? null;
    });

    const telemetry = await page.evaluate(async ({ durationMilliseconds }) => {
      const world = document.querySelector<HTMLElement>('[data-world-mount]');
      const api = (window as PerformanceWindow).__HEATLINE_QA__;
      if (!world || !api) throw new Error('Performance QA requires a running world and QA bridge');

      const route = [
        { x: -248, z: 244 },
        { x: -360, z: -340 },
        { x: 330, z: -330 },
        { x: 330, z: 330 },
        { x: -330, z: 330 },
        { x: 0, z: 0 },
      ];
      const frames: number[] = [];
      const samples: RuntimeSample[] = [];
      const startedAt = performance.now();
      let previousFrame = startedAt;
      let routeIndex = 0;

      const readNumber = (name: string): number => Number(world.dataset[name] ?? 0);
      const sample = (): void => {
        const memory = (performance as Performance & {
          memory?: { readonly usedJSHeapSize: number };
        }).memory;
        samples.push({
          heapBytes: memory?.usedJSHeapSize ?? null,
          residentCells: readNumber('visualResidentCells'),
          activeCollisions: readNumber('activeCollisions'),
          activeTraffic: readNumber('activeTraffic'),
          trafficLimit: readNumber('trafficLimit'),
          activePedestrians: readNumber('activePedestrians'),
          pedestrianLimit: readNumber('pedestrianLimit'),
          worldVoices: api.audioState().worldVoiceCount,
        });
      };

      sample();
      const interval = window.setInterval(() => {
        routeIndex = (routeIndex + 1) % route.length;
        const destination = route[routeIndex];
        if (destination) api.teleport(destination.x, destination.z);
        sample();
      }, 2_000);

      await new Promise<void>((resolve) => {
        const onFrame = (now: number): void => {
          frames.push(now - previousFrame);
          previousFrame = now;
          if (now - startedAt >= durationMilliseconds) resolve();
          else requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
      });
      window.clearInterval(interval);
      sample();
      return { frames: frames.slice(1), samples };
    }, { durationMilliseconds: durationSeconds * 1_000 });

    await page.requestGC();
    const heapAfter = await page.evaluate(() => {
      const memory = (performance as Performance & {
        memory?: { readonly usedJSHeapSize: number };
      }).memory;
      return memory?.usedJSHeapSize ?? null;
    });

    expect(telemetry.frames.length).toBeGreaterThan(durationSeconds * (isMobile ? 20 : 40));
    const averageMilliseconds = telemetry.frames.reduce((sum, frame) => sum + frame, 0)
      / telemetry.frames.length;
    const p95Milliseconds = percentile(telemetry.frames, 0.95);
    const maximumMilliseconds = Math.max(...telemetry.frames);
    const targetMilliseconds = isMobile ? 1000 / 30 : 1000 / 50;

    test.info().annotations.push({ type: 'performance', description: JSON.stringify({
      device: isMobile ? 'mobile' : 'desktop',
      durationSeconds,
      frames: telemetry.frames.length,
      averageMilliseconds: Number(averageMilliseconds.toFixed(2)),
      p95Milliseconds: Number(p95Milliseconds.toFixed(2)),
      maximumMilliseconds: Number(maximumMilliseconds.toFixed(2)),
      heapBefore,
      heapAfter,
    }) });

    expect(averageMilliseconds).toBeLessThanOrEqual(targetMilliseconds);
    expect(p95Milliseconds).toBeLessThanOrEqual(isMobile ? 40 : 25);
    expect(maximumMilliseconds).toBeLessThan(250);
    expect(maximum(telemetry.samples, 'residentCells')).toBeLessThanOrEqual(11);
    expect(maximum(telemetry.samples, 'worldVoices')).toBe(5);
    expect(maximum(telemetry.samples, 'activeTraffic')).toBeLessThanOrEqual(
      maximum(telemetry.samples, 'trafficLimit'),
    );
    expect(maximum(telemetry.samples, 'activePedestrians')).toBeLessThanOrEqual(
      maximum(telemetry.samples, 'pedestrianLimit'),
    );

    const heaps = telemetry.samples
      .map(({ heapBytes }) => heapBytes)
      .filter((value): value is number => value !== null);
    if (heaps.length >= 4) {
      const strictlyGrowing = heaps.slice(1).every((value, index) => value > heaps[index]!);
      expect(strictlyGrowing && heaps.at(-1)! - heaps[0]! > 4 * 1024 * 1024).toBe(false);
    }
    if (heapBefore !== null && heapAfter !== null) {
      expect(heapAfter).toBeLessThanOrEqual(heapBefore + Math.max(12 * 1024 * 1024, heapBefore * 0.25));
    }
  });

  test('WebGL context loss restores rendering and simulation', async ({ page }) => {
    test.setTimeout(45_000);
    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    const world = page.getByLabel('3D game world');
    const canvas = world.locator('canvas');

    const recovery = await canvas.evaluate(async (element) => {
      const canvasElement = element as HTMLCanvasElement;
      const context = canvasElement.getContext('webgl2') ?? canvasElement.getContext('webgl');
      const extension = context?.getExtension('WEBGL_lose_context');
      if (!extension) return { supported: false, lost: false, restored: false };

      return new Promise<{ supported: true; lost: boolean; restored: boolean }>((resolve, reject) => {
        let lost = false;
        const timeout = window.setTimeout(() => reject(new Error('WebGL context recovery timed out')), 8_000);
        canvasElement.addEventListener('webglcontextlost', (event) => {
          event.preventDefault();
          lost = true;
          window.setTimeout(() => extension.restoreContext(), 100);
        }, { once: true });
        canvasElement.addEventListener('webglcontextrestored', () => {
          window.clearTimeout(timeout);
          resolve({ supported: true, lost, restored: true });
        }, { once: true });
        extension.loseContext();
      });
    });

    test.skip(!recovery.supported, 'WEBGL_lose_context is unavailable in this browser');
    expect(recovery).toEqual({ supported: true, lost: true, restored: true });
    await expect(canvas).toBeVisible();
    const initialX = Number(await world.getAttribute('data-player-x'));
    const initialZ = Number(await world.getAttribute('data-player-z'));
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    const movedX = Number(await world.getAttribute('data-player-x'));
    const movedZ = Number(await world.getAttribute('data-player-z'));
    expect(Math.hypot(movedX - initialX, movedZ - initialZ)).toBeGreaterThan(0.25);
  });
});
