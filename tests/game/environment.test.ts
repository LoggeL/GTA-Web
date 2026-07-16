import { describe, expect, it } from 'vitest';

import {
  advanceEnvironment,
  createEnvironmentState,
  dayPhaseAt,
  environmentPaletteAt,
  updateEnvironment,
} from '../../src/game/environment';

describe('day, night, and weather environment', () => {
  it('wraps the deterministic clock and reports named day phases', () => {
    const state = createEnvironmentState({ timeOfDay: 0.99, clockRate: 0.02 });
    advanceEnvironment(state, 1);
    expect(state.timeOfDay).toBeCloseTo(0.01);
    expect(dayPhaseAt(0.26)).toBe('dawn');
    expect(dayPhaseAt(0.5)).toBe('day');
    expect(dayPhaseAt(0.78)).toBe('evening');
    expect(dayPhaseAt(0.95)).toBe('night');
  });

  it('clamps weather controls and dims the sun during rain', () => {
    const state = createEnvironmentState();
    updateEnvironment(state, { rainIntensity: 4, timeOfDay: -0.25 });
    expect(state.rainIntensity).toBe(1);
    expect(state.timeOfDay).toBe(0.75);

    const clear = environmentPaletteAt(0.5, 0);
    const rainy = environmentPaletteAt(0.5, 1);
    expect(rainy.sunIntensity).toBeLessThan(clear.sunIntensity);
    expect(rainy.sky).not.toBe(clear.sky);
    expect(environmentPaletteAt(0.5, 0)).toEqual(clear);
  });
});

