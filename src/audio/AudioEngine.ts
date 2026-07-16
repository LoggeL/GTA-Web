export type StationId = 'coastline-fm' | 'low-tide-radio' | 'rustwave-88';

export interface AudioMix {
  master: number;
  music: number;
  sfx: number;
  ui: number;
  ambience: number;
}

interface ProceduralTrack {
  id: string;
  station: StationId;
  title: string;
  bpm: number;
  rootHz: number;
  waveform: OscillatorType;
  scale: readonly number[];
  bass: readonly number[];
  lead: readonly number[];
  kick: readonly number[];
  snare: readonly number[];
  hat: readonly number[];
}

export interface RadioSnapshot {
  station: StationId | null;
  stationName: string;
  trackTitle: string;
  enabled: boolean;
}

const STATION_NAMES: Record<StationId, string> = {
  'coastline-fm': 'Coastline FM',
  'low-tide-radio': 'Low Tide Radio',
  'rustwave-88': 'Rustwave 88',
};

const TRACKS: readonly ProceduralTrack[] = [
  {
    id: 'sunset-circuit',
    station: 'coastline-fm',
    title: 'Sunset Circuit',
    bpm: 112,
    rootHz: 110,
    waveform: 'sine',
    scale: [0, 2, 4, 7, 9],
    bass: [0, -1, 0, 2, 0, -1, 4, 2, 0, -1, 0, 2, 4, 2, -1, 2],
    lead: [7, -1, 9, -1, 11, 9, 7, -1, 4, -1, 7, 9, 11, -1, 9, 7],
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1],
  },
  {
    id: 'glass-highway',
    station: 'coastline-fm',
    title: 'Glass Highway',
    bpm: 124,
    rootHz: 98,
    waveform: 'triangle',
    scale: [0, 3, 5, 7, 10],
    bass: [0, 0, -1, 0, 3, 3, -1, 3, 5, 5, -1, 5, 3, 3, 0, -1],
    lead: [10, -1, 7, 5, 7, -1, 10, 12, 15, -1, 12, 10, 7, 5, 3, -1],
    kick: [1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  {
    id: 'afterimage',
    station: 'coastline-fm',
    title: 'Afterimage',
    bpm: 102,
    rootHz: 123.47,
    waveform: 'sine',
    scale: [0, 2, 3, 7, 10],
    bass: [0, -1, -1, 0, 7, -1, -1, 7, 3, -1, -1, 3, 2, -1, 0, -1],
    lead: [-1, 10, -1, 7, -1, 12, 10, -1, -1, 7, 10, -1, 15, -1, 12, 10],
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0],
  },
  {
    id: 'backstreet-ledger',
    station: 'low-tide-radio',
    title: 'Backstreet Ledger',
    bpm: 88,
    rootHz: 82.41,
    waveform: 'triangle',
    scale: [0, 3, 5, 7, 10],
    bass: [0, -1, 0, -1, 3, -1, -1, 3, 5, -1, 3, -1, 0, -1, 10, -1],
    lead: [-1, -1, 7, -1, -1, 10, 7, -1, -1, 5, -1, 3, 5, -1, 7, -1],
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
  },
  {
    id: 'concrete-tide',
    station: 'low-tide-radio',
    title: 'Concrete Tide',
    bpm: 94,
    rootHz: 92.5,
    waveform: 'sine',
    scale: [0, 2, 5, 7, 9],
    bass: [0, -1, 0, 2, -1, -1, 5, -1, 7, -1, 5, -1, 2, -1, 0, -1],
    lead: [9, -1, -1, 7, -1, 5, -1, 2, 0, -1, 2, -1, 5, 7, -1, -1],
    kick: [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1],
  },
  {
    id: 'quiet-money',
    station: 'low-tide-radio',
    title: 'Quiet Money',
    bpm: 78,
    rootHz: 73.42,
    waveform: 'triangle',
    scale: [0, 3, 5, 8, 10],
    bass: [0, -1, -1, 0, -1, -1, 5, -1, 8, -1, -1, 5, 3, -1, -1, -1],
    lead: [-1, 10, -1, -1, 8, -1, 5, -1, -1, 3, -1, 5, -1, 8, 10, -1],
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0],
  },
  {
    id: 'breaker-line',
    station: 'rustwave-88',
    title: 'Breaker Line',
    bpm: 136,
    rootHz: 82.41,
    waveform: 'sawtooth',
    scale: [0, 3, 5, 7, 10],
    bass: [0, 0, 0, -1, 3, 3, 3, -1, 5, 5, 7, -1, 3, 3, 0, -1],
    lead: [12, -1, 12, 10, 7, -1, 7, 5, 3, -1, 5, 7, 10, 7, 5, -1],
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  {
    id: 'salt-and-static',
    station: 'rustwave-88',
    title: 'Salt & Static',
    bpm: 148,
    rootHz: 73.42,
    waveform: 'square',
    scale: [0, 2, 5, 7, 9],
    bass: [0, 0, 5, 0, 7, 7, 5, -1, 0, 0, 9, 7, 5, 2, 0, -1],
    lead: [12, 12, -1, 9, 7, -1, 9, 12, 14, -1, 12, 9, 7, 5, 2, -1],
    kick: [1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  {
    id: 'last-drawbridge',
    station: 'rustwave-88',
    title: 'Last Drawbridge',
    bpm: 126,
    rootHz: 98,
    waveform: 'sawtooth',
    scale: [0, 3, 5, 7, 10],
    bass: [0, -1, 0, 3, 5, -1, 3, -1, 0, -1, 7, 5, 3, -1, 0, -1],
    lead: [10, 7, 5, -1, 7, 10, 12, -1, 15, 12, 10, 7, 5, 3, 0, -1],
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
  },
] as const;

const STATIONS: readonly StationId[] = ['coastline-fm', 'low-tide-radio', 'rustwave-88'];

const midiRatio = (semitones: number): number => 2 ** (semitones / 12);

export class AudioEngine {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #music: GainNode | null = null;
  #sfx: GainNode | null = null;
  #ui: GainNode | null = null;
  #ambience: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #station: StationId | null = null;
  #trackIndex = 0;
  #step = 0;
  #nextStepAt = 0;
  #scheduler: ReturnType<typeof setInterval> | undefined;
  #mix: AudioMix = { master: 0.8, music: 0.58, sfx: 0.8, ui: 0.7, ambience: 0.6 };

  get ready(): boolean {
    return this.#context !== null;
  }

  async unlock(): Promise<void> {
    if (!this.#context) this.#createGraph();
    if (this.#context?.state === 'suspended') await this.#context.resume();
  }

  setMix(next: Partial<AudioMix>): void {
    this.#mix = { ...this.#mix, ...next };
    this.#applyMix();
  }

  playStation(station: StationId): RadioSnapshot {
    this.#station = station;
    this.#trackIndex = 0;
    this.#step = 0;
    this.#nextStepAt = (this.#context?.currentTime ?? 0) + 0.05;
    this.#startScheduler();
    return this.snapshot();
  }

  cycleStation(): RadioSnapshot {
    const index = this.#station ? STATIONS.indexOf(this.#station) : -1;
    const next = STATIONS[(index + 1) % (STATIONS.length + 1)];
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
    this.#nextStepAt = (this.#context?.currentTime ?? 0) + 0.05;
    return this.snapshot();
  }

  stopRadio(): void {
    this.#station = null;
    if (this.#scheduler !== undefined) globalThis.clearInterval(this.#scheduler);
    this.#scheduler = undefined;
  }

  snapshot(): RadioSnapshot {
    const track = this.#currentTrack();
    return {
      station: this.#station,
      stationName: this.#station ? STATION_NAMES[this.#station] : 'Radio off',
      trackTitle: track?.title ?? '',
      enabled: this.#station !== null,
    };
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

  setRain(level: number): void {
    const context = this.#context;
    const output = this.#ambience;
    if (!context || !output || level <= 0.01) return;
    this.#noiseHit(context.currentTime, 0.8, 5200, Math.min(0.035, level * 0.035), output);
  }

  async suspend(): Promise<void> {
    if (this.#context?.state === 'running') await this.#context.suspend();
  }

  async resume(): Promise<void> {
    if (this.#context?.state === 'suspended') await this.#context.resume();
  }

  destroy(): void {
    this.stopRadio();
    void this.#context?.close();
    this.#context = null;
  }

  #createGraph(): void {
    const context = new AudioContext({ latencyHint: 'interactive' });
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
    this.#applyMix();
  }

  #applyMix(): void {
    const now = this.#context?.currentTime ?? 0;
    this.#master?.gain.setTargetAtTime(this.#mix.master, now, 0.02);
    this.#music?.gain.setTargetAtTime(this.#mix.music, now, 0.02);
    this.#sfx?.gain.setTargetAtTime(this.#mix.sfx, now, 0.02);
    this.#ui?.gain.setTargetAtTime(this.#mix.ui, now, 0.02);
    this.#ambience?.gain.setTargetAtTime(this.#mix.ambience, now, 0.02);
  }

  #startScheduler(): void {
    if (this.#scheduler || !this.#context) return;
    this.#nextStepAt = this.#context.currentTime + 0.05;
    this.#scheduler = globalThis.setInterval(() => this.#scheduleAhead(), 40);
  }

  #scheduleAhead(): void {
    const context = this.#context;
    const track = this.#currentTrack();
    if (!context || !track || !this.#music) return;
    const stepDuration = 60 / track.bpm / 4;
    while (this.#nextStepAt < context.currentTime + 0.16) {
      this.#scheduleStep(track, this.#step, this.#nextStepAt);
      this.#nextStepAt += stepDuration;
      this.#step = (this.#step + 1) % 16;
      if (this.#step === 0 && Math.floor(context.currentTime / (stepDuration * 64)) % 2 === 1) {
        const tracks = this.#stationTracks();
        this.#trackIndex %= Math.max(1, tracks.length);
      }
    }
  }

  #scheduleStep(track: ProceduralTrack, step: number, time: number): void {
    if (!this.#music) return;
    const bassNote = track.bass[step] ?? -1;
    const leadNote = track.lead[step] ?? -1;
    if (bassNote >= 0) this.#tone(track.rootHz * midiRatio(bassNote), time, 0.14, 'triangle', 0.045, this.#music);
    if (leadNote >= 0) {
      const scaleOffset = track.scale[leadNote % track.scale.length] ?? 0;
      const octave = Math.floor(leadNote / track.scale.length) * 12;
      this.#tone(track.rootHz * 2 * midiRatio(scaleOffset + octave), time, 0.1, track.waveform, 0.018, this.#music);
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
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), time + duration);
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
}
