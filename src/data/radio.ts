import type { RadioStationDefinition, RadioTrackDefinition } from './types';

export const RADIO_STATIONS: readonly RadioStationDefinition[] = [
  {
    id: 'coastline-fm',
    name: 'Coastline FM',
    genre: 'electronic',
    description: 'Bright procedural electronic loops for seafront drives.',
    tracks: [
      {
        id: 'coastline-fm-sodium-lights',
        title: 'Sodium Lights',
        bpm: 118,
        durationSeconds: 142,
        seed: 17011,
        scale: 'F minor pentatonic',
        layers: ['four-on-floor-kit', 'glass-pluck', 'warm-bass', 'night-pad'],
      },
      {
        id: 'coastline-fm-blue-hour',
        title: 'Blue Hour Circuit',
        bpm: 124,
        durationSeconds: 156,
        seed: 17029,
        scale: 'A Dorian',
        layers: ['syncopated-kit', 'pulse-bass', 'soft-chords', 'arp-sequence'],
      },
      {
        id: 'coastline-fm-mirage-exit',
        title: 'Mirage Exit',
        bpm: 112,
        durationSeconds: 148,
        seed: 17047,
        scale: 'C minor',
        layers: ['half-time-kit', 'sub-bass', 'vapor-pad', 'delayed-lead'],
      },
    ],
  },
  {
    id: 'low-tide-radio',
    name: 'Low Tide Radio',
    genre: 'beat',
    description: 'Original hip-hop-inspired instrumental beats with no sampled recordings.',
    tracks: [
      {
        id: 'low-tide-radio-concrete-sun',
        title: 'Concrete Sun',
        bpm: 88,
        durationSeconds: 162,
        seed: 28001,
        scale: 'D minor pentatonic',
        layers: ['dry-break-kit', 'round-bass', 'electric-keys', 'vinyl-noise-synth'],
      },
      {
        id: 'low-tide-radio-palm-shadow',
        title: 'Palm Shadow',
        bpm: 94,
        durationSeconds: 154,
        seed: 28019,
        scale: 'G minor',
        layers: ['swing-kit', 'upright-style-bass-synth', 'muted-chords', 'bell-motif'],
      },
      {
        id: 'low-tide-radio-late-receipt',
        title: 'Late Receipt',
        bpm: 82,
        durationSeconds: 168,
        seed: 28037,
        scale: 'B-flat minor',
        layers: ['loose-kit', 'sub-bass', 'filtered-keys', 'monophonic-lead'],
      },
    ],
  },
  {
    id: 'rustwave-88',
    name: 'Rustwave 88',
    genre: 'garage-rock',
    description: 'Procedural garage-rock energy built from synthesized drums, bass, and guitar-like tones.',
    tracks: [
      {
        id: 'rustwave-88-service-road',
        title: 'Service Road Static',
        bpm: 148,
        durationSeconds: 138,
        seed: 39011,
        scale: 'E minor',
        layers: ['live-style-kit', 'driven-bass', 'power-chord-synth', 'feedback-lead'],
      },
      {
        id: 'rustwave-88-rusted-signal',
        title: 'Rusted Signal',
        bpm: 136,
        durationSeconds: 151,
        seed: 39031,
        scale: 'A minor pentatonic',
        layers: ['room-kit', 'pick-bass-synth', 'fuzz-chords', 'octave-melody'],
      },
      {
        id: 'rustwave-88-open-shutter',
        title: 'Open Shutter',
        bpm: 158,
        durationSeconds: 144,
        seed: 39041,
        scale: 'D Mixolydian',
        layers: ['fast-kit', 'overdrive-bass', 'wide-chords', 'short-solo-synth'],
      },
    ],
  },
] as const satisfies readonly RadioStationDefinition[];

export const RADIO_TRACKS: readonly RadioTrackDefinition[] = (
  RADIO_STATIONS as readonly RadioStationDefinition[]
).flatMap((station) => station.tracks);
