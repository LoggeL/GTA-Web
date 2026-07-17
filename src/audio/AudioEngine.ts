import {
  RADIO_STATIONS,
  RADIO_STATION_IDS,
  findRadioStation,
  type RadioStationId,
} from '../data/radio';
import type { RadioStationDefinition, RadioTrackDefinition } from '../data/types';

export type StationId = RadioStationId;

export interface AudioMix {
  master: number;
  music: number;
  sfx: number;
  ui: number;
  ambience: number;
}

export interface WorldAudioState {
  /** Whether the playable world is currently active. */
  active: boolean;
  inVehicle: boolean;
  speedKph: number;
  /** Normalized accelerator/engine effort in the range 0–1. */
  engineLoad: number;
  rainIntensity: number;
  sirenActive: boolean;
  interior: boolean;
}

export type AudioRuntimeState = 'unavailable' | 'suspended' | 'running' | 'closed' | 'interrupted';

export interface RadioSnapshot {
  readonly station: StationId | null;
  readonly stationName: string;
  readonly trackId: string | null;
  readonly trackTitle: string;
  readonly trackIndex: number | null;
  readonly trackCount: number;
  readonly trackDurationSeconds: number;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly contextState: AudioRuntimeState;
  readonly mix: Readonly<AudioMix>;
  /** Actual master gain after a harness-level output mute is applied. */
  readonly effectiveMaster: number;
  readonly worldAudio: Readonly<WorldAudioState>;
  /** Number of long-lived sources; frequent world updates never increase it. */
  readonly worldVoiceCount: number;
}

export interface AudioScheduler {
  setInterval(callback: () => void, intervalMilliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AudioEngineOptions {
  readonly createContext?: () => AudioContext;
  readonly scheduler?: AudioScheduler;
  /**
   * Hard output mute for automated browser runs. This intentionally leaves the
   * player-facing mix untouched so settings persistence can still be tested.
   */
  readonly muteOutput?: boolean;
}

interface ProceduralTrack {
  readonly definition: RadioTrackDefinition;
  readonly station: StationId;
  readonly rootHz: number;
  readonly waveform: OscillatorType;
  readonly scaleIntervals: readonly number[];
  readonly bass: readonly number[];
  readonly lead: readonly number[];
  readonly kick: readonly number[];
  readonly snare: readonly number[];
  readonly hat: readonly number[];
}

const DEFAULT_AUDIO_MIX: Readonly<AudioMix> = Object.freeze({
  master: 0.8,
  music: 0.58,
  sfx: 0.8,
  ui: 0.7,
  ambience: 0.6,
});

const DEFAULT_WORLD_AUDIO_STATE: Readonly<WorldAudioState> = Object.freeze({
  active: false,
  inVehicle: false,
  speedKph: 0,
  engineLoad: 0,
  rainIntensity: 0,
  sirenActive: false,
  interior: false,
});

const DEFAULT_SCHEDULER: AudioScheduler = {
  setInterval: (callback, intervalMilliseconds) => globalThis.setInterval(callback, intervalMilliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

const MIX_KEYS = ['master', 'music', 'sfx', 'ui', 'ambience'] as const satisfies readonly (keyof AudioMix)[];

const NOTE_ROOT_FREQUENCIES: Readonly<Record<string, number>> = Object.freeze({
  A: 110,
  B: 123.47,
  'B-flat': 116.54,
  C: 65.41,
  D: 73.42,
  E: 82.41,
  F: 87.31,
  G: 98,
});

const KICK_PATTERNS: Readonly<Record<RadioStationDefinition['genre'], readonly number[]>> = Object.freeze({
  electronic: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0]),
  beat: Object.freeze([1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0]),
  'garage-rock': Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0]),
});

const SNARE_PATTERN = Object.freeze([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);

const midiRatio = (semitones: number): number => 2 ** (semitones / 12);

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  if (Number.isNaN(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function clamp01(value: number, fallback = 0): number {
  return clamp(value, 0, 1, fallback);
}

function scaleIntervalsFor(scale: string): readonly number[] {
  const normalized = scale.toLowerCase();
  if (normalized.includes('dorian')) return [0, 2, 3, 5, 7, 9, 10];
  if (normalized.includes('mixolydian')) return [0, 2, 4, 5, 7, 9, 10];
  if (normalized.includes('minor pentatonic')) return [0, 3, 5, 7, 10];
  if (normalized.includes('minor')) return [0, 2, 3, 5, 7, 8, 10];
  return [0, 2, 4, 5, 7, 9, 11];
}

function seededUnitRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function rootFrequencyFor(scale: string): number {
  const note = scale.split(' ')[0] ?? 'A';
  return NOTE_ROOT_FREQUENCIES[note] ?? 110;
}

function waveformFor(
  genre: RadioStationDefinition['genre'],
  seed: number,
): OscillatorType {
  if (genre === 'garage-rock') return seed % 2 === 0 ? 'sawtooth' : 'square';
  if (genre === 'beat') return seed % 2 === 0 ? 'triangle' : 'sine';
  return seed % 2 === 0 ? 'sine' : 'triangle';
}

function createProceduralTrack(
  station: (typeof RADIO_STATIONS)[number],
  definition: RadioTrackDefinition,
): ProceduralTrack {
  const random = seededUnitRandom(definition.seed);
  const scaleIntervals = scaleIntervalsFor(definition.scale);
  const bass = Array.from({ length: 16 }, (_, step) => {
    if (step % 4 !== 0 && random() < 0.72) return -1;
    const degree = Math.floor(random() * Math.min(4, scaleIntervals.length));
    return scaleIntervals[degree] ?? 0;
  });
  const lead = Array.from({ length: 16 }, () => {
    if (random() < (station.genre === 'garage-rock' ? 0.68 : 0.5)) return -1;
    return Math.floor(random() * scaleIntervals.length * 2);
  });
  const hat = Array.from({ length: 16 }, (_, step) => {
    if (station.genre === 'garage-rock') return step % 2 === 0 ? 1 : Number(random() > 0.35);
    if (station.genre === 'electronic') return step % 2 === 0 ? 1 : Number(random() > 0.72);
    return Number(random() > 0.4);
  });

  return {
    definition,
    station: station.id,
    rootHz: rootFrequencyFor(definition.scale),
    waveform: waveformFor(station.genre, definition.seed),
    scaleIntervals,
    bass,
    lead,
    kick: KICK_PATTERNS[station.genre],
    snare: SNARE_PATTERN,
    hat,
  };
}

const TRACKS: readonly ProceduralTrack[] = RADIO_STATIONS.flatMap((station) =>
  station.tracks.map((track) => createProceduralTrack(station, track)),
);

function normalizeContextState(context: AudioContext | null): AudioRuntimeState {
  if (!context) return 'unavailable';
  const state = String(context.state);
  if (state === 'running' || state === 'suspended' || state === 'closed' || state === 'interrupted') {
    return state;
  }
  return 'unavailable';
}

function safeStop(source: AudioScheduledSourceNode | null): void {
  if (!source) return;
  try {
    source.stop();
  } catch {
    // A source may already be stopped by a closing AudioContext.
  }
  source.disconnect();
}

export class AudioEngine {
  readonly #createContext: () => AudioContext;
  readonly #schedulerApi: AudioScheduler;
  readonly #muteOutput: boolean;
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #music: GainNode | null = null;
  #sfx: GainNode | null = null;
  #ui: GainNode | null = null;
  #ambience: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #engineOscillator: OscillatorNode | null = null;
  #engineGain: GainNode | null = null;
  #rainSource: AudioBufferSourceNode | null = null;
  #rainGain: GainNode | null = null;
  #sirenOscillator: OscillatorNode | null = null;
  #sirenModulator: OscillatorNode | null = null;
  #sirenGain: GainNode | null = null;
  #ambienceOscillator: OscillatorNode | null = null;
  #ambienceGain: GainNode | null = null;
  #station: StationId | null = null;
  #trackIndex = 0;
  #step = 0;
  #trackStartedAt = 0;
  #trackEndsAt = 0;
  #nextStepAt = 0;
  #scheduler: unknown | undefined;
  #mix: AudioMix = { ...DEFAULT_AUDIO_MIX };
  #worldAudio: WorldAudioState = { ...DEFAULT_WORLD_AUDIO_STATE };

  public constructor(options: AudioEngineOptions = {}) {
    this.#createContext = options.createContext
      ?? (() => new AudioContext({ latencyHint: 'interactive' }));
    this.#schedulerApi = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#muteOutput = options.muteOutput ?? false;
  }

  get ready(): boolean {
    return this.#context !== null && this.#context.state !== 'closed';
  }

  async unlock(): Promise<void> {
    if (!this.#context) this.#createGraph();
    const context = this.#context;
    if (!context) return;
    if (context.state !== 'running' && context.state !== 'closed') await context.resume();
    if (this.#station) {
      if (this.#trackEndsAt <= 0) this.#anchorCurrentTrack(context.currentTime + 0.05);
      this.#startScheduler();
    }
    this.#applyWorldAudio();
  }

  setMix(next: Partial<AudioMix>): void {
    for (const key of MIX_KEYS) {
      const value = next[key];
      if (value === undefined) continue;
      this.#mix[key] = clamp01(value, this.#mix[key]);
    }
    this.#applyMix();
  }

  setWorldAudioState(next: Partial<WorldAudioState>): void {
    this.#worldAudio = {
      active: next.active ?? this.#worldAudio.active,
      inVehicle: next.inVehicle ?? this.#worldAudio.inVehicle,
      speedKph: clamp(next.speedKph ?? this.#worldAudio.speedKph, 0, 400, this.#worldAudio.speedKph),
      engineLoad: clamp01(next.engineLoad ?? this.#worldAudio.engineLoad, this.#worldAudio.engineLoad),
      rainIntensity: clamp01(
        next.rainIntensity ?? this.#worldAudio.rainIntensity,
        this.#worldAudio.rainIntensity,
      ),
      sirenActive: next.sirenActive ?? this.#worldAudio.sirenActive,
      interior: next.interior ?? this.#worldAudio.interior,
    };
    this.#applyWorldAudio();
  }

  playStation(station: StationId): RadioSnapshot {
    if (!findRadioStation(station)) throw new RangeError(`Unknown radio station: ${station}`);
    this.#station = station;
    this.#trackIndex = 0;
    this.#step = 0;
    const context = this.#context;
    if (context) this.#anchorCurrentTrack(context.currentTime + 0.05);
    else this.#clearTrackTiming();
    this.#startScheduler();
    return this.snapshot();
  }

  cycleStation(): RadioSnapshot {
    const index = this.#station ? RADIO_STATION_IDS.indexOf(this.#station) : -1;
    const next = RADIO_STATION_IDS[index + 1];
    if (!next) {
      this.stopRadio();
      return this.snapshot();
    }
    return this.playStation(next);
  }

  nextTrack(): RadioSnapshot {
    const tracks = this.#stationTracks();
    if (tracks.length === 0) return this.snapshot();
    this.#trackIndex = (this.#trackIndex + 1) % tracks.length;
    this.#step = 0;
    const context = this.#context;
    if (context) this.#anchorCurrentTrack(context.currentTime + 0.05);
    else this.#clearTrackTiming();
    return this.snapshot();
  }

  stopRadio(): void {
    this.#station = null;
    this.#trackIndex = 0;
    this.#step = 0;
    this.#clearTrackTiming();
    if (this.#scheduler !== undefined) this.#schedulerApi.clearInterval(this.#scheduler);
    this.#scheduler = undefined;
  }

  snapshot(): RadioSnapshot {
    const station = this.#station ? findRadioStation(this.#station) : undefined;
    const track = this.#currentTrack();
    const tracks = this.#stationTracks();
    return Object.freeze({
      station: this.#station,
      stationName: station?.name ?? 'Radio off',
      trackId: track?.definition.id ?? null,
      trackTitle: track?.definition.title ?? '',
      trackIndex: track ? this.#trackIndex : null,
      trackCount: tracks.length,
      trackDurationSeconds: track?.definition.durationSeconds ?? 0,
      enabled: this.#station !== null,
      ready: this.ready,
      contextState: normalizeContextState(this.#context),
      mix: Object.freeze({ ...this.#mix }),
      effectiveMaster: this.#muteOutput ? 0 : this.#mix.master,
      worldAudio: Object.freeze({ ...this.#worldAudio }),
      worldVoiceCount: this.#worldVoiceCount(),
    });
  }

  playUi(kind: 'confirm' | 'cancel' | 'navigate' | 'warning' = 'navigate'): void {
    const context = this.#context;
    const output = this.#ui;
    if (!context || !output) return;
    const frequencies: Record<typeof kind, readonly [number, number]> = {
      confirm: [660, 880],
      cancel: [420, 280],
      navigate: [520, 620],
      warning: [220, 180],
    };
    const [first, second] = frequencies[kind];
    this.#tone(first, context.currentTime, 0.055, 'sine', 0.06, output);
    this.#tone(second, context.currentTime + 0.055, 0.075, 'sine', 0.045, output);
  }

  playSfx(kind: 'impact' | 'weapon' | 'pickup' | 'cash' | 'siren'): void {
    const context = this.#context;
    const output = this.#sfx;
    if (!context || !output) return;
    const now = context.currentTime;
    if (kind === 'impact') {
      this.#noiseHit(now, 0.09, 480, 0.12, output);
      this.#tone(95, now, 0.12, 'sine', 0.1, output, 44);
    } else if (kind === 'weapon') {
      this.#noiseHit(now, 0.07, 1300, 0.17, output);
      this.#tone(120, now, 0.1, 'square', 0.055, output, 48);
    } else if (kind === 'pickup') {
      this.#tone(440, now, 0.07, 'triangle', 0.065, output);
      this.#tone(660, now + 0.06, 0.1, 'triangle', 0.055, output);
    } else if (kind === 'cash') {
      this.#tone(740, now, 0.05, 'sine', 0.05, output);
      this.#tone(990, now + 0.045, 0.08, 'sine', 0.045, output);
    } else {
      this.#tone(520, now, 0.34, 'sine', 0.07, output, 680);
      this.#tone(390, now + 0.34, 0.34, 'sine', 0.07, output, 280);
    }
  }

  /** Backward-compatible rain control now updates one continuous bounded voice. */
  setRain(level: number): void {
    this.setWorldAudioState({ active: true, rainIntensity: level });
  }

  async suspend(): Promise<void> {
    if (this.#context?.state === 'running') await this.#context.suspend();
  }

  async resume(): Promise<void> {
    if (this.#context && this.#context.state !== 'running' && this.#context.state !== 'closed') {
      await this.#context.resume();
    }
  }

  destroy(): void {
    this.stopRadio();
    this.#destroyWorldVoices();
    void this.#context?.close();
    this.#context = null;
    this.#master = null;
    this.#music = null;
    this.#sfx = null;
    this.#ui = null;
    this.#ambience = null;
    this.#noise = null;
    this.#worldAudio = { ...DEFAULT_WORLD_AUDIO_STATE };
  }

  #createGraph(): void {
    const context = this.#createContext();
    const master = context.createGain();
    const music = context.createGain();
    const sfx = context.createGain();
    const ui = context.createGain();
    const ambience = context.createGain();
    music.connect(master);
    sfx.connect(master);
    ui.connect(master);
    ambience.connect(master);
    master.connect(context.destination);
    this.#context = context;
    this.#master = master;
    this.#music = music;
    this.#sfx = sfx;
    this.#ui = ui;
    this.#ambience = ambience;
    this.#noise = this.#createNoiseBuffer(context);
    this.#createWorldVoices(context);
    this.#applyMix();
    this.#applyWorldAudio();
  }

  #createWorldVoices(context: AudioContext): void {
    const sfx = this.#sfx;
    const ambience = this.#ambience;
    const noise = this.#noise;
    if (!sfx || !ambience || !noise) return;
    const now = context.currentTime;

    const engine = context.createOscillator();
    const engineGain = context.createGain();
    engine.type = 'sawtooth';
    engine.frequency.setValueAtTime(62, now);
    engineGain.gain.setValueAtTime(0, now);
    engine.connect(engineGain);
    engineGain.connect(sfx);
    engine.start(now);

    const rain = context.createBufferSource();
    const rainFilter = context.createBiquadFilter();
    const rainGain = context.createGain();
    rain.buffer = noise;
    rain.loop = true;
    rainFilter.type = 'highpass';
    rainFilter.frequency.setValueAtTime(2400, now);
    rainGain.gain.setValueAtTime(0, now);
    rain.connect(rainFilter);
    rainFilter.connect(rainGain);
    rainGain.connect(ambience);
    rain.start(now);

    const siren = context.createOscillator();
    const sirenModulator = context.createOscillator();
    const sirenModulationGain = context.createGain();
    const sirenGain = context.createGain();
    siren.type = 'sine';
    siren.frequency.setValueAtTime(590, now);
    sirenModulator.type = 'sine';
    sirenModulator.frequency.setValueAtTime(0.78, now);
    sirenModulationGain.gain.setValueAtTime(125, now);
    sirenGain.gain.setValueAtTime(0, now);
    sirenModulator.connect(sirenModulationGain);
    sirenModulationGain.connect(siren.frequency);
    siren.connect(sirenGain);
    sirenGain.connect(sfx);
    siren.start(now);
    sirenModulator.start(now);

    const cityAmbience = context.createOscillator();
    const cityAmbienceGain = context.createGain();
    cityAmbience.type = 'sine';
    cityAmbience.frequency.setValueAtTime(46, now);
    cityAmbienceGain.gain.setValueAtTime(0, now);
    cityAmbience.connect(cityAmbienceGain);
    cityAmbienceGain.connect(ambience);
    cityAmbience.start(now);

    this.#engineOscillator = engine;
    this.#engineGain = engineGain;
    this.#rainSource = rain;
    this.#rainGain = rainGain;
    this.#sirenOscillator = siren;
    this.#sirenModulator = sirenModulator;
    this.#sirenGain = sirenGain;
    this.#ambienceOscillator = cityAmbience;
    this.#ambienceGain = cityAmbienceGain;
  }

  #applyMix(): void {
    const now = this.#context?.currentTime ?? 0;
    this.#master?.gain.setTargetAtTime(this.#muteOutput ? 0 : this.#mix.master, now, 0.02);
    this.#music?.gain.setTargetAtTime(this.#mix.music, now, 0.02);
    this.#sfx?.gain.setTargetAtTime(this.#mix.sfx, now, 0.02);
    this.#ui?.gain.setTargetAtTime(this.#mix.ui, now, 0.02);
    this.#ambience?.gain.setTargetAtTime(this.#mix.ambience, now, 0.02);
  }

  #applyWorldAudio(): void {
    const context = this.#context;
    if (!context) return;
    const now = context.currentTime;
    const state = this.#worldAudio;
    const active = Number(state.active);
    const speedRatio = Math.min(1, state.speedKph / 180);
    const engineAudible = active * Number(state.inVehicle);
    this.#engineOscillator?.frequency.setTargetAtTime(
      58 + speedRatio * 92 + state.engineLoad * 54,
      now,
      0.055,
    );
    this.#engineGain?.gain.setTargetAtTime(
      engineAudible * (0.018 + speedRatio * 0.026 + state.engineLoad * 0.022),
      now,
      0.08,
    );
    this.#rainGain?.gain.setTargetAtTime(
      active * state.rainIntensity * (state.interior ? 0.009 : 0.042),
      now,
      0.12,
    );
    this.#sirenGain?.gain.setTargetAtTime(
      active * Number(state.inVehicle && state.sirenActive) * 0.05,
      now,
      0.06,
    );
    this.#ambienceGain?.gain.setTargetAtTime(
      active * (state.interior ? 0.006 : 0.014),
      now,
      0.18,
    );
  }

  #startScheduler(): void {
    if (this.#scheduler !== undefined || !this.#context || !this.#station) return;
    if (this.#trackEndsAt <= 0) this.#anchorCurrentTrack(this.#context.currentTime + 0.05);
    this.#scheduler = this.#schedulerApi.setInterval(() => this.#scheduleAhead(), 40);
  }

  #scheduleAhead(): void {
    const context = this.#context;
    if (!context || !this.#station || !this.#music) return;
    const now = context.currentTime;
    const horizon = now + 0.16;
    this.#advanceExpiredTracks(now);
    this.#resyncScheduleIfBehind(now);

    while (true) {
      const track = this.#currentTrack();
      if (!track) return;
      if (
        this.#trackEndsAt > 0
        && this.#trackEndsAt <= this.#nextStepAt
        && this.#trackEndsAt < horizon
      ) {
        this.#advanceTrackAt(this.#trackEndsAt);
        continue;
      }
      if (this.#nextStepAt >= horizon) return;
      this.#scheduleStep(track, this.#step, this.#nextStepAt);
      this.#nextStepAt += 60 / track.definition.bpm / 4;
      this.#step = (this.#step + 1) % 16;
    }
  }

  #advanceExpiredTracks(now: number): void {
    while (this.#trackEndsAt > 0 && now >= this.#trackEndsAt) {
      this.#advanceTrackAt(this.#trackEndsAt);
    }
  }

  #advanceTrackAt(startAt: number): void {
    const tracks = this.#stationTracks();
    if (tracks.length === 0) {
      this.#clearTrackTiming();
      return;
    }
    this.#trackIndex = (this.#trackIndex + 1) % tracks.length;
    this.#step = 0;
    this.#anchorCurrentTrack(startAt);
  }

  #resyncScheduleIfBehind(now: number): void {
    const track = this.#currentTrack();
    if (!track || this.#nextStepAt >= now) return;
    const stepDuration = 60 / track.definition.bpm / 4;
    const elapsedSteps = Math.max(0, Math.ceil((now - this.#trackStartedAt) / stepDuration));
    this.#step = elapsedSteps % 16;
    this.#nextStepAt = this.#trackStartedAt + elapsedSteps * stepDuration;
  }

  #anchorCurrentTrack(startAt: number): void {
    const track = this.#currentTrack();
    if (!track) {
      this.#clearTrackTiming();
      return;
    }
    this.#trackStartedAt = startAt;
    this.#trackEndsAt = startAt + track.definition.durationSeconds;
    this.#nextStepAt = startAt;
  }

  #clearTrackTiming(): void {
    this.#trackStartedAt = 0;
    this.#trackEndsAt = 0;
    this.#nextStepAt = 0;
  }

  #scheduleStep(track: ProceduralTrack, step: number, time: number): void {
    if (!this.#music) return;
    const bassNote = track.bass[step] ?? -1;
    const leadNote = track.lead[step] ?? -1;
    if (bassNote >= 0) {
      this.#tone(track.rootHz * midiRatio(bassNote), time, 0.14, 'triangle', 0.045, this.#music);
    }
    if (leadNote >= 0) {
      const scaleOffset = track.scaleIntervals[leadNote % track.scaleIntervals.length] ?? 0;
      const octave = Math.floor(leadNote / track.scaleIntervals.length) * 12;
      this.#tone(
        track.rootHz * 2 * midiRatio(scaleOffset + octave),
        time,
        0.1,
        track.waveform,
        0.018,
        this.#music,
      );
    }
    if (track.kick[step]) this.#kick(time, this.#music);
    if (track.snare[step]) this.#noiseHit(time, 0.075, 1800, 0.032, this.#music);
    if (track.hat[step]) this.#noiseHit(time, 0.025, 7200, 0.012, this.#music);
  }

  #tone(
    frequency: number,
    time: number,
    duration: number,
    type: OscillatorType,
    volume: number,
    output: AudioNode,
    endFrequency?: number,
  ): void {
    const context = this.#context;
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, time);
    if (endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), time + duration);
    }
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(gain);
    gain.connect(output);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
  }

  #kick(time: number, output: AudioNode): void {
    this.#tone(145, time, 0.16, 'sine', 0.085, output, 42);
  }

  #noiseHit(time: number, duration: number, frequency: number, volume: number, output: AudioNode): void {
    const context = this.#context;
    if (!context || !this.#noise) return;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = this.#noise;
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(Math.max(0.0002, volume), time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  #createNoiseBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let state = 0x5f3759df;
    for (let index = 0; index < samples.length; index += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      samples[index] = (state / 0xffffffff) * 2 - 1;
    }
    return buffer;
  }

  #stationTracks(): readonly ProceduralTrack[] {
    return this.#station ? TRACKS.filter((track) => track.station === this.#station) : [];
  }

  #currentTrack(): ProceduralTrack | undefined {
    const tracks = this.#stationTracks();
    return tracks[this.#trackIndex % Math.max(1, tracks.length)];
  }

  #worldVoiceCount(): number {
    return [
      this.#engineOscillator,
      this.#rainSource,
      this.#sirenOscillator,
      this.#sirenModulator,
      this.#ambienceOscillator,
    ].filter((source) => source !== null).length;
  }

  #destroyWorldVoices(): void {
    safeStop(this.#engineOscillator);
    safeStop(this.#rainSource);
    safeStop(this.#sirenOscillator);
    safeStop(this.#sirenModulator);
    safeStop(this.#ambienceOscillator);
    this.#engineOscillator = null;
    this.#engineGain = null;
    this.#rainSource = null;
    this.#rainGain = null;
    this.#sirenOscillator = null;
    this.#sirenModulator = null;
    this.#sirenGain = null;
    this.#ambienceOscillator = null;
    this.#ambienceGain = null;
  }
}
