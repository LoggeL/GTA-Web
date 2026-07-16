import { describe, expect, it } from 'vitest';

import { createDefaultBindings } from '../../src/core/settings';
import {
  BindingValidationError,
  INPUT_ACTIONS,
  InputMap,
  bindingMapValidationIssues,
  bindingSnapshotValidationIssues,
  isValidBindingMap,
  isValidBindingSnapshot,
  isValidKeyboardCode,
  isValidMouseCode,
} from '../../src/input';

describe('InputMap', () => {
  it('indexes every canonical default binding', () => {
    const map = new InputMap();

    expect(INPUT_ACTIONS).toHaveLength(17);
    for (const action of INPUT_ACTIONS) {
      expect(map.getBindings(action).length).toBeGreaterThan(0);
    }
    expect(map.getActionFor('keyboard', 'KeyW')).toBe('moveForward');
    expect(map.getActionFor('mouse', 'Mouse0')).toBe('primaryAction');
    expect(map.usesBinding('keyboard', 'KeyZ')).toBe(false);
  });

  it('returns defensive copies and serializable snapshots', () => {
    const map = new InputMap();
    const bindings = map.getBindings('moveForward');
    const snapshot = map.snapshot();

    (bindings[0] as { code: string }).code = 'ArrowUp';
    (snapshot.bindings.moveForward[0] as { code: string }).code = 'ArrowDown';

    expect(map.getActionFor('keyboard', 'KeyW')).toBe('moveForward');
    expect(map.getActionFor('keyboard', 'ArrowUp')).toBeUndefined();
    expect(JSON.parse(JSON.stringify(map.snapshot()))).toEqual(map.snapshot());
  });

  it('remaps keyboard bindings atomically while preserving other devices', () => {
    const map = new InputMap();
    map.setBindings('primaryAction', [
      { device: 'mouse', code: 'Mouse0' },
      { device: 'keyboard', code: 'KeyX' },
    ]);
    map.remapKeyboard('primaryAction', 'KeyZ');

    expect(map.getBindings('primaryAction')).toEqual([
      { device: 'mouse', code: 'Mouse0' },
      { device: 'keyboard', code: 'KeyZ' },
    ]);
    expect(map.getActionFor('keyboard', 'KeyX')).toBeUndefined();
    expect(map.getActionFor('keyboard', 'KeyZ')).toBe('primaryAction');
  });

  it('supports multiple keyboard bindings for one action', () => {
    const map = new InputMap();
    map.setKeyboardBindings('sprint', ['ShiftLeft', 'ShiftRight']);

    expect(map.getActionFor('keyboard', 'ShiftLeft')).toBe('sprint');
    expect(map.getActionFor('keyboard', 'ShiftRight')).toBe('sprint');
  });

  it('rejects invalid codes and conflicts without mutating the prior map', () => {
    const map = new InputMap();
    const before = map.snapshot();

    expect(() => map.remapKeyboard('moveForward', 'not-a-code')).toThrow(BindingValidationError);
    expect(() => map.remapKeyboard('moveForward', 'KeyS')).toThrow(BindingValidationError);
    expect(() => map.setKeyboardBindings('moveForward', [])).toThrow(BindingValidationError);
    expect(map.snapshot()).toEqual(before);
  });

  it('validates complete maps, unknown actions, duplicates, and missing actions', () => {
    const valid = createDefaultBindings();
    expect(isValidBindingMap(valid)).toBe(true);
    expect(bindingMapValidationIssues(valid)).toEqual([]);

    const invalid: Record<string, unknown> = {
      ...valid,
      moveForward: [
        { device: 'keyboard', code: 'KeyW' },
        { device: 'keyboard', code: 'KeyW' },
      ],
      moveBackward: [],
      debugTeleport: [{ device: 'keyboard', code: 'KeyT' }],
    };
    const issues = bindingMapValidationIssues(invalid);

    expect(issues.some((issue) => issue.path === 'bindings.debugTeleport')).toBe(true);
    expect(issues.some((issue) => issue.path === 'bindings.moveForward[1]')).toBe(true);
    expect(issues.some((issue) => issue.path === 'bindings.moveBackward')).toBe(true);
    expect(isValidBindingMap(invalid)).toBe(false);
  });

  it('round-trips a versioned snapshot and rejects bad versions', () => {
    const original = new InputMap();
    original.remapKeyboard('moveForward', 'ArrowUp');
    const snapshot = original.snapshot();
    const restored = new InputMap();

    restored.restore(JSON.parse(JSON.stringify(snapshot)) as unknown);
    expect(restored.toBindingMap()).toEqual(original.toBindingMap());
    expect(isValidBindingSnapshot(snapshot)).toBe(true);
    expect(bindingSnapshotValidationIssues({ ...snapshot, schemaVersion: 2 })).toEqual([
      { path: 'snapshot.schemaVersion', message: 'Unsupported binding snapshot version.' },
    ]);
    expect(() => restored.restore({ ...snapshot, schemaVersion: 2 })).toThrow(BindingValidationError);
  });

  it('recognizes only supported physical keyboard and mouse codes', () => {
    expect(isValidKeyboardCode('KeyA')).toBe(true);
    expect(isValidKeyboardCode('Digit9')).toBe(true);
    expect(isValidKeyboardCode('F24')).toBe(true);
    expect(isValidKeyboardCode('NumpadSubtract')).toBe(true);
    expect(isValidKeyboardCode('F25')).toBe(false);
    expect(isValidKeyboardCode('w')).toBe(false);
    expect(isValidMouseCode('Mouse4')).toBe(true);
    expect(isValidMouseCode('Mouse5')).toBe(false);
  });
});
