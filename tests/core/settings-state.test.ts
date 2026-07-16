import { describe, expect, it } from 'vitest';

import {
  createDefaultBindings,
  createDefaultSettings,
  validateGameSettings,
} from '../../src/core/settings';
import { createInitialGameState, createInitialSaveGame } from '../../src/core/state';

describe('settings model', () => {
  it('provides all locked desktop defaults', () => {
    const bindings = createDefaultBindings();

    expect(bindings.moveForward).toEqual([{ device: 'keyboard', code: 'KeyW' }]);
    expect(bindings.primaryAction).toEqual([{ device: 'mouse', code: 'Mouse0' }]);
    expect(bindings.jumpHandbrake).toEqual([{ device: 'keyboard', code: 'Space' }]);
    expect(bindings.pause).toEqual([{ device: 'keyboard', code: 'Escape' }]);
  });

  it('returns independent defaults and validates persisted ranges', () => {
    const first = createDefaultSettings();
    const second = createDefaultSettings();
    first.controls.bindings.moveForward[0] = { device: 'keyboard', code: 'ArrowUp' };

    expect(second.controls.bindings.moveForward[0]?.code).toBe('KeyW');
    expect(validateGameSettings(first)).toBe(true);

    const invalid: unknown = {
      ...second,
      audio: { ...second.audio, master: 2 },
    };
    expect(validateGameSettings(invalid)).toBe(false);
  });
});

describe('initial serializable state', () => {
  it('creates deterministic, independent game state', () => {
    const first = createInitialGameState({ seed: 'test-city' });
    const second = createInitialGameState({ seed: 'test-city' });

    expect(first).toEqual(second);
    first.player.transform.position.x = 42;
    expect(second.player.transform.position.x).toBe(0);
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it('creates a complete new save with explicit clock and slot metadata', () => {
    const save = createInitialSaveGame(2, 'feminine', {
      seed: 123,
      timestamp: 10_000,
      label: 'Night run',
    });

    expect(save.schemaVersion).toBe(4);
    expect(save.slot).toEqual({
      id: 2,
      label: 'Night run',
      createdAt: 10_000,
      updatedAt: 10_000,
    });
    expect(save.player.level).toBe(1);
    expect(save.player.attributes).toEqual({ grit: 1, aim: 1, handling: 1, nerve: 1, hustle: 1 });
    expect(save.quickLoadout).toEqual({
      firearms: [null, null],
      melee: null,
      consumables: [null, null],
    });
    expect(save.unlockedRecipes).toEqual([]);
    expect(save.missionRuntime).toBeNull();
    expect(save.dialogueRuntime).toBeNull();
    expect(save.activeDistrict).toBe('arroyo-heights');
    expect(JSON.parse(JSON.stringify(save))).toEqual(save);
  });
});
