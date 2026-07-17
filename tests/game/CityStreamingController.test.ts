import { describe, expect, it } from 'vitest';

import {
  CityStreamingController,
  MOBILE_MINIMUM_ADAPTIVE_RESOLUTION_SCALE,
  MINIMUM_ADAPTIVE_RESOLUTION_SCALE,
  baseResolutionScaleForQuality,
  baseResolutionScaleForRuntime,
} from '../../src/game/CityStreamingController';
import { currentAndAdjacentCellIds } from '../../src/navigation/cells';
import type {
  CellId,
  FailedChunkBoundary,
  RoadClosureState,
} from '../../src/navigation/types';

function sampleFrames(
  controller: CityStreamingController,
  durationMilliseconds: number,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    controller.sampleFrame(durationMilliseconds);
  }
}

describe('CityStreamingController cell residency', () => {
  it('exposes the current cell plus eight neighbors and a predicted prefetch', () => {
    const controller = new CityStreamingController({ platform: 'desktop' });
    const result = controller.updateCells('cell:0:0', 'cell:4:0');

    expect(result.snapshot.activeCellIds).toEqual(
      currentAndAdjacentCellIds('cell:0:0'),
    );
    expect(result.snapshot.activeCellIds).toHaveLength(9);
    expect(result.snapshot.renderableActiveCellIds).toHaveLength(9);
    expect(result.snapshot.prefetchCellIds).toEqual(['cell:4:0']);
    expect(result.snapshot.inactiveLruCellIds).toEqual(['cell:4:0']);
    expect(result.activatedCellIds).toHaveLength(9);
  });

  it('uses deterministic desktop and mobile inactive LRU budgets', () => {
    const desktopA = new CityStreamingController({ platform: 'desktop' });
    const desktopB = new CityStreamingController({ platform: 'desktop' });
    const mobile = new CityStreamingController({ platform: 'mobile' });

    for (const controller of [desktopA, desktopB, mobile]) {
      controller.updateCells('cell:0:0');
      controller.updateCells('cell:5:5');
    }

    const firstDesktop = desktopA.snapshot();
    const secondDesktop = desktopB.snapshot();
    expect(firstDesktop.inactiveLruLimit).toBe(2);
    expect(firstDesktop.inactiveLruCellIds).toHaveLength(2);
    expect(firstDesktop.inactiveLruCellIds).toEqual(
      secondDesktop.inactiveLruCellIds,
    );
    expect(firstDesktop.residentCellIds).toHaveLength(11);
    expect(mobile.snapshot().inactiveLruLimit).toBe(1);
    expect(mobile.snapshot().inactiveLruCellIds).toHaveLength(1);
    expect(mobile.snapshot().residentCellIds).toHaveLength(10);
  });

  it('reports activation, deactivation, and unique eviction deltas', () => {
    const controller = new CityStreamingController({ platform: 'mobile' });
    controller.updateCells('cell:0:0');
    const transition = controller.updateCells('cell:6:6');

    expect(transition.activatedCellIds).toHaveLength(9);
    expect(transition.deactivatedCellIds).toHaveLength(9);
    expect(new Set(transition.evictedCellIds).size).toBe(
      transition.evictedCellIds.length,
    );
    expect(transition.evictedCellIds).toHaveLength(8);
  });
});

describe('CityStreamingController quality and adaptive performance', () => {
  it('caps automatic low quality at 0.8 without rewriting explicit scales', () => {
    expect(baseResolutionScaleForQuality(1, 'auto', 'low')).toBe(0.8);
    expect(baseResolutionScaleForQuality(0.65, 'auto', 'low')).toBe(0.65);
    expect(baseResolutionScaleForQuality(1, 'auto', 'high')).toBe(1);
    expect(baseResolutionScaleForQuality(1, 'low', 'low')).toBe(1);
    expect(baseResolutionScaleForQuality(0.7, 'high', 'high')).toBe(0.7);
  });

  it('caps only automatic desktop software rendering at the stable full-level scale', () => {
    expect(baseResolutionScaleForRuntime(1, 'auto', 'low', 'desktop', true)).toBe(0.5);
    expect(baseResolutionScaleForRuntime(0.65, 'auto', 'low', 'desktop', true)).toBe(0.5);
    expect(baseResolutionScaleForRuntime(1, 'auto', 'low', 'mobile', true)).toBe(0.8);
    expect(baseResolutionScaleForRuntime(1, 'auto', 'low', 'desktop', false)).toBe(0.8);
    expect(baseResolutionScaleForRuntime(1, 'low', 'low', 'desktop', true)).toBe(1);
    expect(baseResolutionScaleForRuntime(1, 'auto', 'high', 'desktop', true)).toBe(1);
  });

  it('matches pooled actor capacities and exposes per-quality draw limits', () => {
    const controller = new CityStreamingController({ quality: 'high' });
    controller.updateCells('cell:0:0');
    const high = controller.snapshot().performance.limits;
    const low = controller.setQuality('low');

    expect(high.actors).toEqual({
      traffic: 42,
      pedestrians: 72,
      combat: 20,
      total: 134,
    });
    expect(low.actors).toEqual({
      traffic: 18,
      pedestrians: 30,
      combat: 8,
      total: 56,
    });
    expect(low.drawDensity.roads).toBe(1);
    expect(low.drawDensity.structures).toBeLessThan(high.drawDensity.structures);
    expect(low.drawDensity.props).toBeLessThan(high.drawDensity.props);

    const adaptiveLow = new CityStreamingController({
      quality: 'low',
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
    });
    sampleFrames(adaptiveLow, 30, 4);
    expect(adaptiveLow.snapshot().performance).toMatchObject({
      level: 'minimum',
      limits: {
        actors: {
          traffic: 10,
          pedestrians: 18,
        },
      },
    });
  });

  it('degrades and recovers with rolling-window hysteresis', () => {
    const controller = new CityStreamingController({
      quality: 'high',
      frameWindowSize: 4,
      slowFrameThresholdMilliseconds: 22,
      fastFrameThresholdMilliseconds: 15,
      slowWindowsToDegrade: 2,
      fastWindowsToRecover: 2,
    });
    const full = controller.snapshot().performance.limits;

    sampleFrames(controller, 30, 8);
    const balanced = controller.snapshot().performance;
    expect(balanced.level).toBe('balanced');
    expect(balanced.limits.resolutionScale).toBeLessThan(full.resolutionScale);
    expect(balanced.limits.actors.total).toBeLessThan(full.actors.total);

    sampleFrames(controller, 30, 8);
    expect(controller.snapshot().performance.level).toBe('minimum');

    sampleFrames(controller, 10, 8);
    expect(controller.snapshot().performance.level).toBe('balanced');
    sampleFrames(controller, 10, 8);
    const recovered = controller.snapshot().performance;
    expect(recovered.level).toBe('full');
    expect(recovered.limits).toEqual(full);
    expect(recovered.frames).toMatchObject({
      sampleCount: 4,
      averageMilliseconds: 10,
      p95Milliseconds: 10,
      estimatedFramesPerSecond: 100,
    });
  });

  it('keeps the public sampleFrame decision and per-sample frames contract', () => {
    const controller = new CityStreamingController({
      frameWindowSize: 3,
    });
    const decisions = [10, 20, 30, 40].map((frameMilliseconds) =>
      controller.sampleFrame(frameMilliseconds),
    );

    expect(decisions.map(({ changed, reason, previousLevel, level }) => ({
      changed,
      reason,
      previousLevel,
      level,
    }))).toEqual([
      {
        changed: false,
        reason: 'collecting',
        previousLevel: 'full',
        level: 'full',
      },
      {
        changed: false,
        reason: 'collecting',
        previousLevel: 'full',
        level: 'full',
      },
      {
        changed: false,
        reason: 'stable',
        previousLevel: 'full',
        level: 'full',
      },
      {
        changed: false,
        reason: 'stable',
        previousLevel: 'full',
        level: 'full',
      },
    ]);
    expect(decisions.map(({ frames }) => frames)).toEqual([
      {
        sampleCount: 1,
        averageMilliseconds: 10,
        p95Milliseconds: 10,
        estimatedFramesPerSecond: 100,
      },
      {
        sampleCount: 2,
        averageMilliseconds: 15,
        p95Milliseconds: 20,
        estimatedFramesPerSecond: 1_000 / 15,
      },
      {
        sampleCount: 3,
        averageMilliseconds: 20,
        p95Milliseconds: 30,
        estimatedFramesPerSecond: 50,
      },
      {
        sampleCount: 3,
        averageMilliseconds: 30,
        p95Milliseconds: 40,
        estimatedFramesPerSecond: 1_000 / 30,
      },
    ]);
  });

  it('emits runtime decisions only for adaptive level changes', () => {
    const options = {
      frameWindowSize: 2,
      slowFrameThresholdMilliseconds: 22,
      fastFrameThresholdMilliseconds: 15,
      slowWindowsToDegrade: 1,
      fastWindowsToRecover: 1,
    } as const;
    const publicController = new CityStreamingController(options);
    const runtimeController = new CityStreamingController(options);

    for (const frameMilliseconds of [30, 30, 30, 30, 10, 10, 10, 10]) {
      const publicDecision = publicController.sampleFrame(frameMilliseconds);
      const runtimeDecision =
        runtimeController.sampleRuntimeFrame(frameMilliseconds);

      if (publicDecision.changed) {
        expect(runtimeDecision).toEqual(publicDecision);
      } else {
        expect(runtimeDecision).toBeNull();
      }
    }

    expect(runtimeController.snapshot().performance).toEqual(
      publicController.snapshot().performance,
    );
  });

  it('reserves the desktop runtime floor for low-quality adaptive minimum and recovers', () => {
    expect(MINIMUM_ADAPTIVE_RESOLUTION_SCALE).toBe(0.35);
    const controller = new CityStreamingController({
      quality: 'low',
      baseResolutionScale: 0.8,
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
      fastWindowsToRecover: 1,
    });

    expect(controller.snapshot().performance.limits.resolutionScale).toBe(0.8);
    sampleFrames(controller, 30, 2);
    expect(controller.snapshot().performance.level).toBe('balanced');
    expect(controller.snapshot().performance.limits.resolutionScale).toBeCloseTo(0.7);
    sampleFrames(controller, 30, 2);
    expect(controller.snapshot().performance).toMatchObject({
      level: 'minimum',
      limits: { resolutionScale: MINIMUM_ADAPTIVE_RESOLUTION_SCALE },
    });

    sampleFrames(controller, 10, 2);
    expect(controller.snapshot().performance.level).toBe('balanced');
    expect(controller.snapshot().performance.limits.resolutionScale).toBeCloseTo(0.7);
    sampleFrames(controller, 10, 2);
    expect(controller.snapshot().performance).toMatchObject({
      level: 'full',
      limits: { resolutionScale: 0.8 },
    });

    const mobile = new CityStreamingController({
      platform: 'mobile',
      quality: 'low',
      baseResolutionScale: 0.8,
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
    });
    sampleFrames(mobile, 30, 4);
    expect(mobile.snapshot().performance).toMatchObject({
      level: 'minimum',
      limits: { resolutionScale: MOBILE_MINIMUM_ADAPTIVE_RESOLUTION_SCALE },
    });
    expect(MOBILE_MINIMUM_ADAPTIVE_RESOLUTION_SCALE).toBe(0.4);
  });

  it('keeps high-quality and configured-scale behavior unchanged above adaptive minimum', () => {
    const high = new CityStreamingController({
      quality: 'high',
      baseResolutionScale: 1,
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
    });
    sampleFrames(high, 30, 2);
    expect(high.snapshot().performance.limits.resolutionScale).toBe(0.9);
    sampleFrames(high, 30, 2);
    expect(high.snapshot().performance.limits.resolutionScale).toBe(0.7);

    const configuredMinimum = new CityStreamingController({
      quality: 'low',
      baseResolutionScale: 0.5,
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
    });
    sampleFrames(configuredMinimum, 30, 2);
    expect(configuredMinimum.snapshot().performance).toMatchObject({
      level: 'balanced',
      limits: { resolutionScale: 0.5 },
    });
    sampleFrames(configuredMinimum, 30, 2);
    expect(configuredMinimum.snapshot().performance).toMatchObject({
      level: 'minimum',
      limits: { resolutionScale: MINIMUM_ADAPTIVE_RESOLUTION_SCALE },
    });
  });

  it('rejects non-finite configured resolution scales at both entry points', () => {
    expect(() => new CityStreamingController({ baseResolutionScale: Number.NaN }))
      .toThrowError('baseResolutionScale must be between 0.5 and 1');
    expect(() => new CityStreamingController({
      baseResolutionScale: Number.POSITIVE_INFINITY,
    })).toThrowError('baseResolutionScale must be between 0.5 and 1');

    const controller = new CityStreamingController();
    expect(() => controller.setBaseResolutionScale(Number.NaN))
      .toThrowError('base resolution scale must be between 0.5 and 1');
    expect(() => controller.setBaseResolutionScale(Number.NEGATIVE_INFINITY))
      .toThrowError('base resolution scale must be between 0.5 and 1');
  });

  it('recovers at a normal 60 Hz frame interval with the default fast threshold', () => {
    const controller = new CityStreamingController({
      frameWindowSize: 4,
      slowWindowsToDegrade: 1,
      fastWindowsToRecover: 1,
    });
    sampleFrames(controller, 30, 4);
    expect(controller.snapshot().performance.level).toBe('balanced');

    sampleFrames(controller, 1_000 / 60, 4);
    expect(controller.snapshot().performance.level).toBe('full');
  });

  it('holds its level through neutral frame windows and supports a reset', () => {
    const controller = new CityStreamingController({
      frameWindowSize: 2,
      slowWindowsToDegrade: 1,
      fastWindowsToRecover: 1,
    });
    sampleFrames(controller, 30, 2);
    expect(controller.snapshot().performance.level).toBe('balanced');
    sampleFrames(controller, 19, 4);
    expect(controller.snapshot().performance.level).toBe('balanced');
    expect(controller.resetAdaptivePerformance().performanceLevel).toBe('full');
    expect(controller.snapshot().performance.frames.sampleCount).toBe(0);
  });
});

describe('CityStreamingController failure boundaries and retries', () => {
  const failedCellId: CellId = 'cell:1:0';

  it('closes a failed boundary, schedules retry, and recovers the cell', () => {
    const controller = new CityStreamingController({
      retryDelaysMilliseconds: [250, 750],
    });
    controller.updateCells('cell:0:0');
    const retry = controller.markCellFailed(
      {
        cellId: failedCellId,
        fromCellId: 'cell:0:0',
        attempts: 1,
        error: 'offline',
      },
      1_000,
    );
    const failed = controller.snapshot();

    expect(retry).toMatchObject({
      status: 'waiting',
      attemptsCompleted: 1,
      nextAttempt: 2,
      nextRetryAtMilliseconds: 1_250,
    });
    expect(failed.renderableActiveCellIds).not.toContain(failedCellId);
    expect(failed.roadClosures).toEqual([
      expect.objectContaining({
        id: 'road-closure:cell:0:0:cell:1:0',
        fromCellId: 'cell:0:0',
        toCellId: failedCellId,
        reason: 'chunk-load-failed',
      }),
    ]);
    expect(controller.retryDueCellIds(1_249)).toEqual([]);
    expect(controller.retryDueCellIds(1_250)).toEqual([failedCellId]);
    expect(controller.beginRetry(failedCellId, 1_250)).toEqual({
      accepted: true,
      cellId: failedCellId,
      attempt: 2,
    });

    controller.markCellReady(failedCellId);
    const recovered = controller.snapshot();
    expect(recovered.failedBoundaries).toEqual([]);
    expect(recovered.roadClosures).toEqual([]);
    expect(recovered.retryStates).toEqual([]);
    expect(recovered.renderableActiveCellIds).toContain(failedCellId);
  });

  it('exhausts automatic retries but permits an explicit manual retry', () => {
    const controller = new CityStreamingController({
      retryDelaysMilliseconds: [0, 0],
    });
    controller.markCellFailed(
      {
        cellId: failedCellId,
        fromCellId: null,
        attempts: 3,
        error: 'still unavailable',
      },
      500,
    );

    expect(controller.snapshot().retryStates[0]).toMatchObject({
      status: 'exhausted',
      nextAttempt: 4,
      nextRetryAtMilliseconds: null,
    });
    expect(controller.beginRetry(failedCellId, 500)).toEqual({
      accepted: false,
      cellId: failedCellId,
      reason: 'exhausted',
    });
    expect(controller.beginRetry(failedCellId, 500, true)).toEqual({
      accepted: true,
      cellId: failedCellId,
      attempt: 4,
    });
  });

  it('synchronizes navigation-native failures and provided road closures', () => {
    const controller = new CityStreamingController();
    const boundary: FailedChunkBoundary = {
      cellId: 'cell:2:0',
      fromCellId: 'cell:1:0',
      attempts: 2,
      error: 'timeout',
    };
    const closure: RoadClosureState = {
      id: 'navigation-closure',
      fromCellId: 'cell:1:0',
      toCellId: 'cell:2:0',
      reason: 'chunk-load-failed',
      message: 'Take the signed detour.',
    };

    controller.syncFailureState([boundary], [closure], 2_000);
    expect(controller.snapshot()).toMatchObject({
      failedBoundaries: [boundary],
      roadClosures: [closure],
    });
    controller.syncFailureState([], [], 2_100);
    expect(controller.snapshot().roadClosures).toEqual([]);
  });

  it('rejects invalid timing and cell inputs early', () => {
    const controller = new CityStreamingController();

    expect(() => controller.sampleFrame(Number.NaN)).toThrow(/frame duration/);
    expect(() => controller.sampleRuntimeFrame(Number.NaN)).toThrow(/frame duration/);
    expect(() => controller.updateCells('not-a-cell' as CellId)).toThrow(
      /Invalid cell id/,
    );
    expect(
      () => new CityStreamingController({ baseResolutionScale: 0.2 }),
    ).toThrow(/baseResolutionScale/);
  });
});
