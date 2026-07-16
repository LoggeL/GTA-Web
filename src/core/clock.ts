export interface FixedStepClockOptions {
  fixedStepSeconds?: number;
  maxFrameSeconds?: number;
  maxSubSteps?: number;
}

export interface FrameAdvance {
  rawDeltaSeconds: number;
  acceptedDeltaSeconds: number;
  simulationSteps: number;
  simulatedSeconds: number;
  droppedSeconds: number;
  interpolationAlpha: number;
}

export type SimulationUpdate = (stepSeconds: number) => void;

/** Accumulator clock with bounded catch-up work for deterministic simulation. */
export class FixedStepClock {
  public readonly fixedStepSeconds: number;
  public readonly maxFrameSeconds: number;
  public readonly maxSubSteps: number;

  private accumulatorSeconds = 0;
  private elapsedSimulationSeconds = 0;
  private lastTimestampMs: number | null = null;

  public constructor(options: FixedStepClockOptions = {}) {
    this.fixedStepSeconds = options.fixedStepSeconds ?? 1 / 60;
    this.maxFrameSeconds = options.maxFrameSeconds ?? 0.25;
    this.maxSubSteps = options.maxSubSteps ?? 8;

    assertPositiveFinite(this.fixedStepSeconds, 'fixedStepSeconds');
    assertPositiveFinite(this.maxFrameSeconds, 'maxFrameSeconds');
    if (!Number.isSafeInteger(this.maxSubSteps) || this.maxSubSteps < 1) {
      throw new RangeError('maxSubSteps must be a positive safe integer');
    }
  }

  public get simulationTimeSeconds(): number {
    return this.elapsedSimulationSeconds;
  }

  public get interpolationAlpha(): number {
    return this.accumulatorSeconds / this.fixedStepSeconds;
  }

  /**
   * Advances from a monotonic timestamp. The first timestamp establishes a
   * baseline and deliberately performs no simulation work.
   */
  public advance(timestampMs: number, update: SimulationUpdate): FrameAdvance {
    if (!Number.isFinite(timestampMs)) {
      throw new TypeError('timestampMs must be finite');
    }

    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      return this.emptyAdvance();
    }

    const deltaSeconds = Math.max(0, (timestampMs - this.lastTimestampMs) / 1_000);
    this.lastTimestampMs = timestampMs;
    return this.advanceBy(deltaSeconds, update);
  }

  /** Advances by an explicit duration, useful for deterministic tests and replays. */
  public advanceBy(deltaSeconds: number, update: SimulationUpdate): FrameAdvance {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('deltaSeconds must be a non-negative finite number');
    }

    const acceptedDeltaSeconds = Math.min(deltaSeconds, this.maxFrameSeconds);
    let droppedSeconds = deltaSeconds - acceptedDeltaSeconds;
    this.accumulatorSeconds += acceptedDeltaSeconds;

    let simulationSteps = 0;
    while (
      this.accumulatorSeconds + Number.EPSILON >= this.fixedStepSeconds
      && simulationSteps < this.maxSubSteps
    ) {
      update(this.fixedStepSeconds);
      this.accumulatorSeconds -= this.fixedStepSeconds;
      if (this.accumulatorSeconds < 0 && this.accumulatorSeconds > -Number.EPSILON) {
        this.accumulatorSeconds = 0;
      }
      this.elapsedSimulationSeconds += this.fixedStepSeconds;
      simulationSteps += 1;
    }

    if (this.accumulatorSeconds >= this.fixedStepSeconds) {
      const droppedSteps = Math.floor(
        (this.accumulatorSeconds + Number.EPSILON) / this.fixedStepSeconds,
      );
      const overflow = droppedSteps * this.fixedStepSeconds;
      droppedSeconds += overflow;
      this.accumulatorSeconds -= overflow;
      if (Math.abs(this.accumulatorSeconds) < Number.EPSILON * 10) {
        this.accumulatorSeconds = 0;
      }
    }

    return {
      rawDeltaSeconds: deltaSeconds,
      acceptedDeltaSeconds,
      simulationSteps,
      simulatedSeconds: simulationSteps * this.fixedStepSeconds,
      droppedSeconds,
      interpolationAlpha: this.interpolationAlpha,
    };
  }

  /** Clears wall-time history while optionally preserving simulated playtime. */
  public reset(preserveSimulationTime = false): void {
    this.accumulatorSeconds = 0;
    this.lastTimestampMs = null;
    if (!preserveSimulationTime) {
      this.elapsedSimulationSeconds = 0;
    }
  }

  /** Prevents time spent paused or backgrounded from becoming a catch-up frame. */
  public rebase(): void {
    this.lastTimestampMs = null;
  }

  private emptyAdvance(): FrameAdvance {
    return {
      rawDeltaSeconds: 0,
      acceptedDeltaSeconds: 0,
      simulationSteps: 0,
      simulatedSeconds: 0,
      droppedSeconds: 0,
      interpolationAlpha: this.interpolationAlpha,
    };
  }
}

export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface GameLoopCallbacks {
  update: SimulationUpdate;
  render: (interpolationAlpha: number, frame: Readonly<FrameAdvance>) => void;
}

/** Scheduler-independent loop shell. Browser code supplies requestAnimationFrame. */
export class GameLoop {
  private readonly clock: FixedStepClock;
  private readonly scheduler: FrameScheduler;
  private readonly callbacks: GameLoopCallbacks;
  private running = false;
  private scheduledHandle: unknown = null;

  public constructor(
    scheduler: FrameScheduler,
    callbacks: GameLoopCallbacks,
    options: FixedStepClockOptions = {},
  ) {
    this.scheduler = scheduler;
    this.callbacks = callbacks;
    this.clock = new FixedStepClock(options);
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get simulationTimeSeconds(): number {
    return this.clock.simulationTimeSeconds;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.clock.rebase();
    this.scheduleNextFrame();
  }

  public stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.scheduledHandle !== null) {
      this.scheduler.cancel(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    this.clock.rebase();
  }

  /** Executes one frame without requiring a browser or a running scheduler. */
  public advanceFrame(timestampMs: number): FrameAdvance {
    const frame = this.clock.advance(timestampMs, this.callbacks.update);
    this.callbacks.render(frame.interpolationAlpha, frame);
    return frame;
  }

  public reset(): void {
    this.clock.reset();
  }

  private readonly onScheduledFrame = (timestampMs: number): void => {
    this.scheduledHandle = null;
    if (!this.running) {
      return;
    }
    this.advanceFrame(timestampMs);
    this.scheduleNextFrame();
  };

  private scheduleNextFrame(): void {
    this.scheduledHandle = this.scheduler.request(this.onScheduledFrame);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}
