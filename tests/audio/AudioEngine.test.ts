import { describe, expect, it } from 'vitest';

import { AudioEngine } from '../../src/audio/AudioEngine';

describe('AudioEngine radio state', () => {
  it('cycles through the three stations and then turns off without an AudioContext', () => {
    const audio = new AudioEngine();

    expect(audio.cycleStation()).toMatchObject({ station: 'coastline-fm', stationName: 'Coastline FM' });
    expect(audio.cycleStation()).toMatchObject({ station: 'low-tide-radio', stationName: 'Low Tide Radio' });
    expect(audio.cycleStation()).toMatchObject({ station: 'rustwave-88', stationName: 'Rustwave 88' });
    expect(audio.cycleStation()).toEqual({ station: null, stationName: 'Radio off', trackTitle: '', enabled: false });
  });

  it('moves to the next original track within a station', () => {
    const audio = new AudioEngine();
    const first = audio.playStation('coastline-fm');
    const second = audio.nextTrack();

    expect(first.trackTitle).toBe('Sunset Circuit');
    expect(second.trackTitle).toBe('Glass Highway');
  });
});
