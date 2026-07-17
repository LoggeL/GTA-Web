import { startNewGame } from '../e2e/helpers';
import { expect, test } from '../e2e/fixtures';
import {
  ADAPTATION_WARMUP_MILLISECONDS,
  areAdjacentCells,
  average,
  collectAdjacentTravelTelemetry,
  maximum,
  percentile,
  readHeapBytes,
  readRuntimeDiagnostics,
  type PerformanceWindow,
  type RuntimeSample,
  type TeleportTiming,
} from './runtime-performance-support';

const STRESS_CADENCE_MILLISECONDS = 2_000;
const STRESS_TRANSITION_TIMEOUT_MILLISECONDS = 1_500;

const configuredDuration = Number(process.env.HEATLINE_SOAK_SECONDS ?? '30');
const durationSeconds = Number.isFinite(configuredDuration) && configuredDuration > 0
  ? configuredDuration
  : 30;
const stressDurationSeconds = Math.min(30, Math.max(12, durationSeconds));
const disableMultiDraw = process.env.HEATLINE_DISABLE_MULTI_DRAW === '1';

const disableMultiDrawInitScript = `
  (() => {
    for (const constructor of [
      globalThis.WebGLRenderingContext,
      globalThis.WebGL2RenderingContext,
    ]) {
      const prototype = constructor?.prototype;
      const original = prototype?.getExtension;
      if (!prototype || typeof original !== 'function') continue;
      Object.defineProperty(prototype, 'getExtension', {
        configurable: true,
        value(name) {
          if (name === 'WEBGL_multi_draw') return null;
          return original.call(this, name);
        },
      });
    }
  })();
`;

test.describe('M8 browser performance and recovery', () => {
  test('runtime frame telemetry meets release targets during adjacent-cell driving', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout((durationSeconds + ADAPTATION_WARMUP_MILLISECONDS / 1_000 + 45) * 1_000);
    if (disableMultiDraw) {
      await page.addInitScript({ content: disableMultiDrawInitScript });
    }
    await startNewGame(page, 1, 'Masculine Alex', '/?qa=1');
    await page.waitForFunction(() => Boolean((window as PerformanceWindow).__HEATLINE_QA__));
    await page.keyboard.press('e');
    const world = page.getByLabel('3D game world');
    await expect(world).toHaveAttribute('data-player-mode', 'vehicle');

    // Give the adaptive controller a complete, bounded observation period before
    // measuring. The release target applies to the quality level it settles on.
    await page.waitForTimeout(ADAPTATION_WARMUP_MILLISECONDS);
    const diagnosticsAfterWarmup = await readRuntimeDiagnostics(page);

    await world.locator('canvas').focus();
    await page.keyboard.down('w');
    const telemetry = await collectAdjacentTravelTelemetry(page, durationSeconds * 1_000);
    await page.keyboard.up('w');

    const diagnosticsAfterCourse = await readRuntimeDiagnostics(page);
    const averageMilliseconds = average(telemetry.frames);
    const p95Milliseconds = percentile(telemetry.frames, 0.95);
    const maximumMilliseconds = telemetry.frames.length > 0
      ? Math.max(...telemetry.frames)
      : 0;
    const estimatedFramesPerSecond = averageMilliseconds > 0 ? 1_000 / averageMilliseconds : 0;
    const targetFramesPerSecond = isMobile ? 30 : 60;
    const nominalFrameBudgetMilliseconds = 1_000 / targetFramesPerSecond;
    const softwareRenderer = diagnosticsAfterCourse.softwareRenderer;
    // A literal >=60 arithmetic assertion cannot pass a normal 59.94 Hz vsync
    // cadence. Hardware stays within 3% of the nominal budget; software WebGL
    // receives a bounded 10% scheduler tolerance but keeps the same 60/30 target.
    const averageFrameBudgetMilliseconds = nominalFrameBudgetMilliseconds
      * (softwareRenderer ? 1.1 : 1.03);
    const minimumHardwareFramesPerSecond = targetFramesPerSecond * 0.97;
    // Headless SwiftShader presents rAF on 120 Hz scheduler bands
    // (~8.3/16.7/25 ms). Keep the hardware p95 gate strict while allowing
    // three scheduler ticks only for the explicitly detected software path.
    const p95FrameBudgetMilliseconds = isMobile ? 40 : softwareRenderer ? 26 : 22;
    const transitionFrames = telemetry.transitions.map(({ frameMilliseconds }) => frameMilliseconds);
    const performanceDiagnostics = {
      device: isMobile ? 'mobile' : 'desktop',
      targetFramesPerSecond,
      targetPolicy: '60 FPS desktop / 30 FPS mobile; frame-budget acceptance accounts for vsync and bounded software-renderer scheduler jitter without changing the target; isolated host scheduler stalls remain diagnostic while ordinary cell transitions stay below 250 ms',
      nominalFrameBudgetMilliseconds: Number(nominalFrameBudgetMilliseconds.toFixed(2)),
      acceptedAverageFrameBudgetMilliseconds: Number(averageFrameBudgetMilliseconds.toFixed(2)),
      acceptedP95FrameBudgetMilliseconds: p95FrameBudgetMilliseconds,
      warmupMilliseconds: ADAPTATION_WARMUP_MILLISECONDS,
      durationSeconds,
      elapsedMilliseconds: Number(telemetry.elapsedMilliseconds.toFixed(2)),
      frames: telemetry.frames.length,
      estimatedFramesPerSecond: Number(estimatedFramesPerSecond.toFixed(2)),
      averageMilliseconds: Number(averageMilliseconds.toFixed(2)),
      p95Milliseconds: Number(p95Milliseconds.toFixed(2)),
      maximumMilliseconds: Number(maximumMilliseconds.toFixed(2)),
      ordinaryCellTransitions: telemetry.transitions.length,
      maximumTransitionFrameMilliseconds: Number(
        (transitionFrames.length > 0 ? Math.max(...transitionFrames) : 0).toFixed(2),
      ),
      visitedCells: telemetry.visitedCells,
      poolMaximums: {
        collisions: maximum(telemetry.samples, 'activeCollisions'),
        traffic: maximum(telemetry.samples, 'activeTraffic'),
        pedestrians: maximum(telemetry.samples, 'activePedestrians'),
        worldVoices: maximum(telemetry.samples, 'worldVoices'),
      },
      afterWarmup: diagnosticsAfterWarmup,
      afterCourse: diagnosticsAfterCourse,
    };
    test.info().annotations.push({
      type: 'performance',
      description: JSON.stringify(performanceDiagnostics),
    });
    await test.info().attach('adjacent-cell-performance.json', {
      body: JSON.stringify(performanceDiagnostics, null, 2),
      contentType: 'application/json',
    });

    expect(telemetry.frames.length, 'the measured rAF course produced no frames').toBeGreaterThan(0);
    expect(
      averageMilliseconds,
      `${targetFramesPerSecond} FPS frame budget (${diagnosticsAfterCourse.unmaskedRenderer})`,
    ).toBeLessThanOrEqual(averageFrameBudgetMilliseconds);
    if (!softwareRenderer) {
      expect(
        estimatedFramesPerSecond,
        `${targetFramesPerSecond} FPS hardware target`,
      ).toBeGreaterThanOrEqual(minimumHardwareFramesPerSecond);
    }
    expect(p95Milliseconds).toBeLessThanOrEqual(p95FrameBudgetMilliseconds);
    // Keep the absolute maximum in the attached diagnostics, but do not use an
    // isolated host/SwiftShader scheduling pause as a gameplay release gate.
    // Average and p95 constrain sustained cadence; the transition assertion
    // below enforces the plan's strict <250 ms ordinary chunk-transition bound.
    expect(telemetry.transitions.length, 'the course must cross an adjacent cell boundary')
      .toBeGreaterThanOrEqual(1);
    expect(
      telemetry.transitions.every(({ fromCell, toCell }) => areAdjacentCells(fromCell, toCell)),
      'realistic travel may only cross adjacent cells',
    ).toBe(true);
    expect(
      transitionFrames.every((frameMilliseconds) => frameMilliseconds < 250),
      'ordinary cell-transition frames must stay below 250 ms',
    ).toBe(true);
    expect(
      telemetry.samples.filter(({ activeTraffic, trafficLimit }) => activeTraffic > trafficLimit),
      'traffic actors exceeded their adaptive pool limit',
    ).toEqual([]);
    expect(
      telemetry.samples.filter(
        ({ activePedestrians, pedestrianLimit }) => activePedestrians > pedestrianLimit,
      ),
      'pedestrians exceeded their adaptive pool limit',
    ).toEqual([]);
    expect(maximum(telemetry.samples, 'worldVoices')).toBe(5);
  });

  test('runtime frame stress keeps far-teleport residency and heap growth bounded', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout((stressDurationSeconds + ADAPTATION_WARMUP_MILLISECONDS / 1_000 + 45) * 1_000);
    await startNewGame(page, 2, 'Feminine Alex', '/?qa=1');
    await page.waitForFunction(() => Boolean((window as PerformanceWindow).__HEATLINE_QA__));
    await page.waitForTimeout(ADAPTATION_WARMUP_MILLISECONDS);
    const diagnosticsAfterWarmup = await readRuntimeDiagnostics(page);

    await page.requestGC();
    const heapBefore = await readHeapBytes(page);
    const stress = await page.evaluate(async ({
      durationMilliseconds,
      cadenceMilliseconds,
      transitionTimeoutMilliseconds,
    }) => {
      const world = document.querySelector<HTMLElement>('[data-world-mount]');
      const api = (window as PerformanceWindow).__HEATLINE_QA__;
      if (!world || !api) throw new Error('Performance QA requires a running world and QA bridge');

      const route = [
        { x: -360, z: -340 },
        { x: 330, z: -330 },
        { x: 330, z: 330 },
        { x: -330, z: 330 },
        { x: 0, z: 0 },
        { x: -248, z: 244 },
      ];
      const samples: RuntimeSample[] = [];
      const teleports: TeleportTiming[] = [];
      const startedAt = performance.now();
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
      const waitForCell = async (fromCell: string): Promise<{
        readonly cell: string;
        readonly elapsedMilliseconds: number;
        readonly settled: boolean;
      }> => new Promise((resolve) => {
        const transitionStartedAt = performance.now();
        const poll = (): void => {
          const cell = world.dataset.currentCell ?? '';
          const elapsedMilliseconds = performance.now() - transitionStartedAt;
          if (cell && cell !== fromCell) {
            resolve({ cell, elapsedMilliseconds, settled: true });
          } else if (elapsedMilliseconds >= transitionTimeoutMilliseconds) {
            resolve({ cell, elapsedMilliseconds, settled: false });
          } else {
            window.setTimeout(poll, 16);
          }
        };
        poll();
      });

      sample();
      const sampleInterval = window.setInterval(sample, 250);
      while (performance.now() - startedAt < durationMilliseconds) {
        const cycleStartedAt = performance.now();
        const destination = route[routeIndex % route.length]!;
        routeIndex += 1;
        const fromCell = world.dataset.currentCell ?? '';
        api.teleport(destination.x, destination.z);
        const transition = await waitForCell(fromCell);
        teleports.push({
          fromCell,
          toCell: transition.cell,
          destination,
          settleMilliseconds: transition.elapsedMilliseconds,
          settled: transition.settled,
        });
        sample();

        const remainingCourseMilliseconds = durationMilliseconds - (performance.now() - startedAt);
        const remainingCycleMilliseconds = cadenceMilliseconds - (performance.now() - cycleStartedAt);
        const waitMilliseconds = Math.min(remainingCourseMilliseconds, remainingCycleMilliseconds);
        if (waitMilliseconds > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, waitMilliseconds));
        }
      }
      window.clearInterval(sampleInterval);
      sample();
      return {
        elapsedMilliseconds: performance.now() - startedAt,
        samples,
        teleports,
      };
    }, {
      durationMilliseconds: stressDurationSeconds * 1_000,
      cadenceMilliseconds: STRESS_CADENCE_MILLISECONDS,
      transitionTimeoutMilliseconds: STRESS_TRANSITION_TIMEOUT_MILLISECONDS,
    });
    await page.requestGC();
    const heapAfter = await readHeapBytes(page);
    const diagnosticsAfterCourse = await readRuntimeDiagnostics(page);

    const settleTimes = stress.teleports.map(({ settleMilliseconds }) => settleMilliseconds);
    const heaps = stress.samples
      .map(({ heapBytes }) => heapBytes)
      .filter((value): value is number => value !== null);
    const stressDiagnostics = {
      device: isMobile ? 'mobile' : 'desktop',
      course: 'deliberately non-ordinary far-teleport churn; FPS targets are asserted by adjacent travel',
      warmupMilliseconds: ADAPTATION_WARMUP_MILLISECONDS,
      durationSeconds: stressDurationSeconds,
      elapsedMilliseconds: Number(stress.elapsedMilliseconds.toFixed(2)),
      teleportCount: stress.teleports.length,
      settledTeleports: stress.teleports.filter(({ settled }) => settled).length,
      settleAverageMilliseconds: Number(average(settleTimes).toFixed(2)),
      settleP95Milliseconds: Number(percentile(settleTimes, 0.95).toFixed(2)),
      settleMaximumMilliseconds: Number((settleTimes.length ? Math.max(...settleTimes) : 0).toFixed(2)),
      maximumResidentCells: maximum(stress.samples, 'residentCells'),
      maximumActiveCollisions: maximum(stress.samples, 'activeCollisions'),
      heapBefore,
      heapAfter,
      heapDelta: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
      afterWarmup: diagnosticsAfterWarmup,
      afterCourse: diagnosticsAfterCourse,
    };
    test.info().annotations.push({
      type: 'stress',
      description: JSON.stringify(stressDiagnostics),
    });
    await test.info().attach('far-teleport-stress.json', {
      body: JSON.stringify({ ...stressDiagnostics, teleports: stress.teleports }, null, 2),
      contentType: 'application/json',
    });

    expect(stress.teleports.length).toBeGreaterThanOrEqual(6);
    expect(stress.teleports.filter(({ settled }) => !settled), 'far teleports that did not settle')
      .toEqual([]);
    expect(maximum(stress.samples, 'residentCells')).toBeLessThanOrEqual(isMobile ? 10 : 11);
    if (heaps.length >= 4) {
      const strictlyGrowing = heaps.slice(1).every((value, index) => value > heaps[index]!);
      expect(strictlyGrowing && heaps.at(-1)! - heaps[0]! > 4 * 1024 * 1024).toBe(false);
    }
    if (heapBefore !== null && heapAfter !== null) {
      expect(heapAfter).toBeLessThanOrEqual(
        heapBefore + Math.max(12 * 1024 * 1024, heapBefore * 0.25),
      );
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
