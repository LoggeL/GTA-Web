import { describe, expect, it } from 'vitest';

import {
  AudioEngine,
  type AudioScheduler,
} from '../../src/audio/AudioEngine';
import { RADIO_STATIONS } from '../../src/data/radio';

class FakeAudioParam {
  public value = 0;
  public readonly targets: number[] = [];

  public setValueAtTime(value: number): this {
    this.value = value;
    this.targets.push(value);
    return this;
  }

  public setTargetAtTime(value: number): this {
    this.value = value;
    this.targets.push(value);
    return this;
  }

  public exponentialRampToValueAtTime(value: number): this {
    this.value = value;
    this.targets.push(value);
    return this;
  }
}

class FakeAudioNode {
  public readonly connections: unknown[] = [];
  public disconnected = false;

  public connect(destination: unknown): unknown {
    this.connections.push(destination);
    return destination;
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGainNode extends FakeAudioNode {
  public readonly gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  public type: OscillatorType = 'sine';
  public readonly frequency = new FakeAudioParam();
  public startCalls = 0;
  public stopCalls = 0;

  public start(): void {
    this.startCalls += 1;
  }

  public stop(): void {
    this.stopCalls += 1;
  }
}

class FakeBufferSourceNode extends FakeAudioNode {
  public buffer: AudioBuffer | null = null;
  public loop = false;
  public startCalls = 0;
  public stopCalls = 0;

  public start(): void {
    this.startCalls += 1;
  }

  public stop(): void {
    this.stopCalls += 1;
  }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  public type: BiquadFilterType = 'lowpass';
  public readonly frequency = new FakeAudioParam();
}

class FakeAudioBuffer {
  readonly #samples: Float32Array;

  public constructor(length: number) {
    this.#samples = new Float32Array(length);
  }

  public getChannelData(): Float32Array {
    return this.#samples;
  }
}

class FakeAudioContext {
  public currentTime = 0;
  public state: AudioContextState = 'suspended';
  public readonly sampleRate = 64;
  public readonly destination = new FakeAudioNode() as unknown as AudioDestinationNode;
  public readonly gains: FakeGainNode[] = [];
  public readonly oscillators: FakeOscillatorNode[] = [];
  public readonly bufferSources: FakeBufferSourceNode[] = [];
  public readonly filters: FakeBiquadFilterNode[] = [];

  public createGain(): GainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  public createOscillator(): OscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  public createBiquadFilter(): BiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node as unknown as BiquadFilterNode;
  }

  public createBuffer(_channels: number, length: number): AudioBuffer {
    return new FakeAudioBuffer(length) as unknown as AudioBuffer;
  }

  public async resume(): Promise<void> {
    this.state = 'running';
  }

  public async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  public async close(): Promise<void> {
    this.state = 'closed';
  }
}

class ControlledScheduler implements AudioScheduler {
  public callback: (() => void) | null = null;
  public clearCalls = 0;
  readonly #handle = Symbol('audio-scheduler');

  public setInterval(callback: () => void): unknown {
    this.callback = callback;
    return this.#handle;
  }

  public clearInterval(handle: unknown): void {
    expect(handle).toBe(this.#handle);
    this.callback = null;
    this.clearCalls += 1;
  }

  public tick(): void {
    if (!this.callback) throw new Error('Audio scheduler is not running');
    this.callback();
  }
}

function createAudioHarness(): {
  audio: AudioEngine;
  context: FakeAudioContext;
  scheduler: ControlledScheduler;
} {
  const context = new FakeAudioContext();
  const scheduler = new ControlledScheduler();
  const audio = new AudioEngine({
    createContext: () => context as unknown as AudioContext,
    scheduler,
  });
  return { audio, context, scheduler };
}

describe('AudioEngine radio state', () => {
  it('cycles through the authoritative three-station catalog and then turns off', () => {
    const audio = new AudioEngine();

    expect(audio.cycleStation()).toMatchObject({
      station: 'coastline-fm',
      stationName: 'Coastline FM',
      trackId: 'coastline-fm-sodium-lights',
      trackTitle: 'Sodium Lights',
      contextState: 'unavailable',
    });
    expect(audio.cycleStation()).toMatchObject({
      station: 'low-tide-radio',
      stationName: 'Low Tide Radio',
      trackId: 'low-tide-radio-concrete-sun',
    });
    expect(audio.cycleStation()).toMatchObject({
      station: 'rustwave-88',
      stationName: 'Rustwave 88',
      trackId: 'rustwave-88-service-road',
    });
    const off = audio.cycleStation();
    expect(off).toMatchObject({
      station: null,
      stationName: 'Radio off',
      trackId: null,
      trackTitle: '',
      trackIndex: null,
      trackCount: 0,
      enabled: false,
    });
    expect(Object.isFrozen(off)).toBe(true);
    expect(Object.isFrozen(off.mix)).toBe(true);
  });

  it('derives every playable track id, title, duration, and order from radio.ts', () => {
    const audio = new AudioEngine();

    for (const station of RADIO_STATIONS) {
      const observed = [audio.playStation(station.id), audio.nextTrack(), audio.nextTrack()];
      expect(observed.map((snapshot) => ({
        id: snapshot.trackId,
        title: snapshot.trackTitle,
        durationSeconds: snapshot.trackDurationSeconds,
      }))).toEqual(station.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        durationSeconds: track.durationSeconds,
      })));
      expect(audio.nextTrack().trackId).toBe(station.tracks[0]?.id);
    }
  });

  it('automatically advances tracks at authored durations without scheduling missed beats', async () => {
    const { audio, context, scheduler } = createAudioHarness();
    await audio.unlock();
    const first = audio.playStation('coastline-fm');

    expect(first.trackTitle).toBe('Sodium Lights');
    expect(context.oscillators).toHaveLength(4);
    context.currentTime = 142.3;
    scheduler.tick();
    expect(audio.snapshot()).toMatchObject({
      trackId: 'coastline-fm-blue-hour',
      trackTitle: 'Blue Hour Circuit',
      trackIndex: 1,
    });
    expect(context.oscillators.length).toBeLessThan(12);

    context.currentTime = 298.3;
    scheduler.tick();
    expect(audio.snapshot()).toMatchObject({
      trackId: 'coastline-fm-mirage-exit',
      trackIndex: 2,
    });

    context.currentTime = 446.3;
    scheduler.tick();
    expect(audio.snapshot()).toMatchObject({
      trackId: 'coastline-fm-sodium-lights',
      trackIndex: 0,
    });
  });

  it('clamps mixer values and returns detached read-only mix snapshots', () => {
    const audio = new AudioEngine();
    const before = audio.snapshot();
    audio.setMix({ master: 2, music: -1, sfx: Number.NaN, ui: Number.POSITIVE_INFINITY, ambience: -5 });
    const after = audio.snapshot();

    expect(after.mix).toEqual({ master: 1, music: 0, sfx: 0.8, ui: 1, ambience: 0 });
    expect(before.mix).toEqual({ master: 0.8, music: 0.58, sfx: 0.8, ui: 0.7, ambience: 0.6 });
    expect(before.mix).not.toBe(after.mix);
  });

  it('hard-mutes automated output without changing the player-facing mix', async () => {
    const context = new FakeAudioContext();
    const audio = new AudioEngine({
      createContext: () => context as unknown as AudioContext,
      muteOutput: true,
    });
    audio.setMix({ master: 1, music: 1 });

    await audio.unlock();

    expect(audio.snapshot()).toMatchObject({
      mix: { master: 1, music: 1 },
      effectiveMaster: 0,
    });
    expect(context.gains[0]?.gain.targets.at(-1)).toBe(0);
  });
});

describe('AudioEngine context and bounded world voices', () => {
  it('reports unlock, suspend, resume, and destroy lifecycle through snapshots', async () => {
    const { audio, scheduler } = createAudioHarness();
    audio.playStation('coastline-fm');
    expect(audio.snapshot()).toMatchObject({ ready: false, contextState: 'unavailable', worldVoiceCount: 0 });

    await audio.unlock();
    expect(audio.snapshot()).toMatchObject({ ready: true, contextState: 'running', worldVoiceCount: 5 });
    expect(scheduler.callback).not.toBeNull();

    await audio.suspend();
    expect(audio.snapshot().contextState).toBe('suspended');
    await audio.resume();
    expect(audio.snapshot().contextState).toBe('running');

    audio.destroy();
    expect(audio.snapshot()).toMatchObject({
      ready: false,
      contextState: 'unavailable',
      worldVoiceCount: 0,
      enabled: false,
    });
    expect(scheduler.clearCalls).toBe(1);
  });

  it('updates rain, engine, siren, and context repeatedly without allocating more voices', async () => {
    const { audio, context } = createAudioHarness();
    await audio.unlock();
    const oscillatorCount = context.oscillators.length;
    const bufferSourceCount = context.bufferSources.length;

    for (let index = 0; index < 1_000; index += 1) {
      audio.setWorldAudioState({
        active: true,
        inVehicle: index % 3 !== 0,
        speedKph: index,
        engineLoad: index / 500,
        rainIntensity: 1 - index / 500,
        sirenActive: index % 2 === 0,
        interior: index % 5 === 0,
      });
    }

    expect(context.oscillators).toHaveLength(oscillatorCount);
    expect(context.bufferSources).toHaveLength(bufferSourceCount);
    expect(audio.snapshot()).toMatchObject({
      worldVoiceCount: 5,
      worldAudio: {
        active: true,
        inVehicle: false,
        speedKph: 400,
        engineLoad: 1,
        rainIntensity: 0,
        sirenActive: false,
        interior: false,
      },
    });

    audio.destroy();
    expect(context.oscillators.every((source) => source.stopCalls === 1 && source.disconnected)).toBe(true);
    expect(context.bufferSources.every((source) => source.stopCalls === 1 && source.disconnected)).toBe(true);
  });
});
