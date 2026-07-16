import { describe, expect, it } from 'vitest';

import { createDefaultSettings } from '../../src/core';
import { InputMap } from '../../src/input';
import { formatKeyboardCode, remapKeyboardBinding } from '../../src/ui/GameUI';

describe('keyboard binding settings helpers', () => {
  it('formats physical keyboard codes as readable labels', () => {
    expect(formatKeyboardCode('KeyW')).toBe('W');
    expect(formatKeyboardCode('Digit7')).toBe('7');
    expect(formatKeyboardCode('ShiftLeft')).toBe('Left Shift');
    expect(formatKeyboardCode('ArrowUp')).toBe('Up Arrow');
    expect(formatKeyboardCode('NumpadSubtract')).toBe('Numpad Subtract');
  });

  it('atomically swaps an occupied key while retaining a valid binding for every action', () => {
    const original = createDefaultSettings();
    const result = remapKeyboardBinding(original, 'moveForward', 0, 'KeyS');

    expect(result.swappedAction).toBe('moveBackward');
    expect(result.settings.controls.bindings.moveForward).toEqual([
      { device: 'keyboard', code: 'KeyS' },
    ]);
    expect(result.settings.controls.bindings.moveBackward).toEqual([
      { device: 'keyboard', code: 'KeyW' },
    ]);
    expect(original.controls.bindings.moveForward[0]?.code).toBe('KeyW');
    expect(Object.values(result.settings.controls.bindings).every((bindings) => bindings.length > 0)).toBe(true);
    expect(() => new InputMap(result.settings.controls.bindings)).not.toThrow();
  });

  it('assigns an unused key without changing unrelated bindings', () => {
    const original = createDefaultSettings();
    const result = remapKeyboardBinding(original, 'moveForward', 0, 'KeyZ');

    expect(result.swappedAction).toBeUndefined();
    expect(result.settings.controls.bindings.moveForward[0]?.code).toBe('KeyZ');
    expect(result.settings.controls.bindings.moveBackward[0]?.code).toBe('KeyS');
    expect(() => new InputMap(result.settings.controls.bindings)).not.toThrow();
  });

  it('rejects unsupported codes and non-keyboard binding slots', () => {
    const settings = createDefaultSettings();
    expect(() => remapKeyboardBinding(settings, 'moveForward', 0, 'Unidentified')).toThrow(
      'Unsupported keyboard code',
    );
    expect(() => remapKeyboardBinding(settings, 'primaryAction', 0, 'KeyZ')).toThrow(
      'Missing keyboard binding',
    );
  });
});
