import { describe, expect, it, vi } from 'vitest';

import { FixedStepClock, GameLoop, type FrameScheduler } from '../../src/core/clock';

describe('FixedStepClock', () => {
  it('runs exact fixed updates and exposes interpolation', () => {
    const clock = new FixedStepClock({ fixedStepSeconds: 1 / 60 });
    const update = vi.fn();

    const half = clock.advanceBy(1 / 120, update);
    const whole = clock.advanceBy(1 / 120, update);

    expect(half.simulationSteps).toBe(0);
    expect(half.interpolationAlpha).toBeCloseTo(0.5);
    expect(whole.simulationSteps).toBe(1);
    expect(whole.interpolationAlpha).toBeCloseTo(0);
    expect(update).toHaveBeenCalledWith(1 / 60);
    expect(clock.simulationTimeSeconds).toBeCloseTo(1 / 60);
  });

  it('caps catch-up work and reports dropped time', () => {
    const clock = new FixedStepClock({
      fixedStepSeconds: 0.01,
      maxFrameSeconds: 0.1,
      maxSubSteps: 3,
    });

    const result = clock.advanceBy(1, () => undefined);

    expect(result.acceptedDeltaSeconds).toBe(0.1);
    expect(result.simulationSteps).toBe(3);
    expect(result.simulatedSeconds).toBeCloseTo(0.03);
    expect(result.droppedSeconds).toBeCloseTo(0.97);
    expect(result.interpolationAlpha).toBeCloseTo(0);
  });

  it('rebases wall time after pause instead of catching up', () => {
    const clock = new FixedStepClock({ fixedStepSeconds: 0.01 });
    const update = vi.fn();

    expect(clock.advance(100, update).simulationSteps).toBe(0);
    expect(clock.advance(120, update).simulationSteps).toBe(2);
    clock.rebase();
    expect(clock.advance(10_000, update).simulationSteps).toBe(0);
  });
});

class TestScheduler implements FrameScheduler {
  public callback: ((timestampMs: number) => void) | null = null;
  public cancel = vi.fn<(handle: unknown) => void>();
  private handle = 0;

  public request(callback: (timestampMs: number) => void): unknown {
    this.callback = callback;
    this.handle += 1;
    return this.handle;
  }

  public fire(timestampMs: number): void {
    const callback = this.callback;
    if (!callback) {
      throw new Error('no frame is scheduled');
    }
    this.callback = null;
    callback(timestampMs);
  }
}

describe('GameLoop', () => {
  it('schedules frames without depending on DOM globals', () => {
    const scheduler = new TestScheduler();
    const update = vi.fn();
    const render = vi.fn();
    const loop = new GameLoop(scheduler, { update, render }, { fixedStepSeconds: 0.01 });

    loop.start();
    loop.start();
    scheduler.fire(0);
    scheduler.fire(20);
    loop.stop();

    expect(update).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(loop.isRunning).toBe(false);
    expect(scheduler.cancel).toHaveBeenCalledOnce();
  });
});
