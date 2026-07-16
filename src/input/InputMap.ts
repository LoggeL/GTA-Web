import { createDefaultBindings } from '../core/settings';
import type {
  BindingDevice,
  BindingMap,
  BindingValidationIssue,
  InputAction,
  InputBinding,
  InputBindingSnapshot,
  ReadonlyBindingMap,
} from './types';
import { INPUT_ACTIONS } from './types';

const STANDARD_KEYBOARD_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backquote',
  'Backslash',
  'Backspace',
  'BracketLeft',
  'BracketRight',
  'CapsLock',
  'Comma',
  'ContextMenu',
  'ControlLeft',
  'ControlRight',
  'Delete',
  'End',
  'Enter',
  'Equal',
  'Escape',
  'Home',
  'Insert',
  'IntlBackslash',
  'IntlRo',
  'IntlYen',
  'MetaLeft',
  'MetaRight',
  'Minus',
  'NumLock',
  'PageDown',
  'PageUp',
  'Pause',
  'Period',
  'Quote',
  'ScrollLock',
  'Semicolon',
  'ShiftLeft',
  'ShiftRight',
  'Slash',
  'Space',
  'Tab',
]);

function bindingKey(device: BindingDevice, code: string): string {
  return `${device}:${code}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidKeyboardCode(code: string): boolean {
  if (STANDARD_KEYBOARD_CODES.has(code)) {
    return true;
  }
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    return true;
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return true;
  }
  return /^Numpad(?:[0-9]|Add|Comma|Decimal|Divide|Enter|Equal|Multiply|Subtract)$/.test(code);
}

export function isValidMouseCode(code: string): boolean {
  return /^Mouse[0-4]$/.test(code);
}

export function bindingMapValidationIssues(value: unknown): readonly BindingValidationIssue[] {
  const issues: BindingValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ path: 'bindings', message: 'Bindings must be an object.' }];
  }

  const expectedActions = new Set<string>(INPUT_ACTIONS);
  for (const key of Object.keys(value)) {
    if (!expectedActions.has(key)) {
      issues.push({ path: `bindings.${key}`, message: 'Unknown input action.' });
    }
  }

  const assigned = new Map<string, InputAction>();
  for (const action of INPUT_ACTIONS) {
    const bindings = value[action];
    if (!Array.isArray(bindings) || bindings.length === 0) {
      issues.push({ path: `bindings.${action}`, message: 'Every action needs at least one binding.' });
      continue;
    }

    const seenForAction = new Set<string>();
    bindings.forEach((candidate: unknown, index) => {
      const path = `bindings.${action}[${index}]`;
      if (!isRecord(candidate)) {
        issues.push({ path, message: 'Binding must be an object.' });
        return;
      }
      const device = candidate.device;
      const code = candidate.code;
      if (device !== 'keyboard' && device !== 'mouse') {
        issues.push({ path: `${path}.device`, message: 'Device must be keyboard or mouse.' });
        return;
      }
      if (typeof code !== 'string') {
        issues.push({ path: `${path}.code`, message: 'Binding code must be a string.' });
        return;
      }
      const valid = device === 'keyboard' ? isValidKeyboardCode(code) : isValidMouseCode(code);
      if (!valid) {
        issues.push({ path: `${path}.code`, message: `Invalid ${device} code: ${code}` });
        return;
      }

      const key = bindingKey(device, code);
      if (seenForAction.has(key)) {
        issues.push({ path, message: `Duplicate binding for ${device} ${code}.` });
        return;
      }
      seenForAction.add(key);
      const previousAction = assigned.get(key);
      if (previousAction !== undefined && previousAction !== action) {
        issues.push({
          path,
          message: `${device} ${code} is already bound to ${previousAction}.`,
        });
      } else {
        assigned.set(key, action);
      }
    });
  }
  return issues;
}

export function isValidBindingMap(value: unknown): value is ReadonlyBindingMap {
  return bindingMapValidationIssues(value).length === 0;
}

export function bindingSnapshotValidationIssues(value: unknown): readonly BindingValidationIssue[] {
  if (!isRecord(value)) {
    return [{ path: 'snapshot', message: 'Binding snapshot must be an object.' }];
  }
  if (value.schemaVersion !== 1) {
    return [{ path: 'snapshot.schemaVersion', message: 'Unsupported binding snapshot version.' }];
  }
  return bindingMapValidationIssues(value.bindings);
}

export function isValidBindingSnapshot(value: unknown): value is InputBindingSnapshot {
  return bindingSnapshotValidationIssues(value).length === 0;
}

export class BindingValidationError extends Error {
  public readonly issues: readonly BindingValidationIssue[];

  public constructor(issues: readonly BindingValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'BindingValidationError';
    this.issues = issues;
  }
}

function cloneBindings(source: ReadonlyBindingMap): BindingMap {
  const result = {} as BindingMap;
  for (const action of INPUT_ACTIONS) {
    result[action] = source[action].map((binding) => ({
      device: binding.device,
      code: binding.code,
    }));
  }
  return result;
}

export class InputMap {
  #bindings: BindingMap;
  #reverse = new Map<string, InputAction>();

  public constructor(bindings: ReadonlyBindingMap = createDefaultBindings()) {
    const issues = bindingMapValidationIssues(bindings);
    if (issues.length > 0) {
      throw new BindingValidationError(issues);
    }
    this.#bindings = cloneBindings(bindings);
    this.#rebuildReverseMap();
  }

  public getBindings(action: InputAction): readonly Readonly<InputBinding>[] {
    return this.#bindings[action].map((binding) => ({ ...binding }));
  }

  public getActionFor(device: BindingDevice, code: string): InputAction | undefined {
    return this.#reverse.get(bindingKey(device, code));
  }

  public usesBinding(device: BindingDevice, code: string): boolean {
    return this.#reverse.has(bindingKey(device, code));
  }

  public setBindings(action: InputAction, bindings: readonly Readonly<InputBinding>[]): void {
    const next = this.toBindingMap();
    next[action] = bindings.map((binding) => ({ ...binding }));
    this.#replace(next);
  }

  public setKeyboardBindings(action: InputAction, codes: readonly string[]): void {
    if (codes.length === 0) {
      throw new BindingValidationError([
        { path: `bindings.${action}`, message: 'At least one keyboard code is required.' },
      ]);
    }
    const next = this.toBindingMap();
    const nonKeyboard = next[action].filter((binding) => binding.device !== 'keyboard');
    next[action] = [
      ...nonKeyboard,
      ...codes.map((code) => ({ device: 'keyboard' as const, code })),
    ];
    this.#replace(next);
  }

  public remapKeyboard(action: InputAction, code: string): void {
    this.setKeyboardBindings(action, [code]);
  }

  public snapshot(): InputBindingSnapshot {
    return {
      schemaVersion: 1,
      bindings: cloneBindings(this.#bindings),
    };
  }

  public restore(snapshot: unknown): void {
    const issues = bindingSnapshotValidationIssues(snapshot);
    if (issues.length > 0) {
      throw new BindingValidationError(issues);
    }
    if (!isValidBindingSnapshot(snapshot)) {
      throw new Error('Binding snapshot validation was inconsistent.');
    }
    this.#replace(snapshot.bindings);
  }

  public toBindingMap(): BindingMap {
    return cloneBindings(this.#bindings);
  }

  #replace(bindings: ReadonlyBindingMap): void {
    const issues = bindingMapValidationIssues(bindings);
    if (issues.length > 0) {
      throw new BindingValidationError(issues);
    }
    this.#bindings = cloneBindings(bindings);
    this.#rebuildReverseMap();
  }

  #rebuildReverseMap(): void {
    this.#reverse = new Map<string, InputAction>();
    for (const action of INPUT_ACTIONS) {
      for (const binding of this.#bindings[action]) {
        this.#reverse.set(bindingKey(binding.device, binding.code), action);
      }
    }
  }
}
