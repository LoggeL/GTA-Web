import { EventBus } from '../core/events';
import { DIALOGUE, MISSIONS } from '../data/missions';
import type { DialogueEntry, MissionDefinition, MissionId } from '../data/types';

export const DIALOGUE_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export type DialogueStatus = 'idle' | 'playing' | 'complete';

export interface DialogueRuntimeSnapshotV1 {
  snapshotVersion: typeof DIALOGUE_RUNTIME_SNAPSHOT_VERSION;
  status: DialogueStatus;
  requestedKeys: string[];
  lineKeys: string[];
  missingKeys: string[];
  index: number;
}

export interface DialogueRuntimeEventMap {
  'dialogue:started': { lineCount: number; missingKeys: readonly string[] };
  'dialogue:line': { entry: DialogueEntry; index: number; lineCount: number };
  'dialogue:missing': { key: string };
  'dialogue:completed': { skipped: boolean };
  'dialogue:skipped': { remainingLines: number };
}

export interface DialogueStartResult {
  current: DialogueEntry | null;
  lineCount: number;
  missingKeys: readonly string[];
}

export type DialogueRestoreResult =
  | { success: true }
  | { success: false; reason: string };

export interface DialogueRuntimeOptions {
  entries?: readonly DialogueEntry[];
  missions?: readonly MissionDefinition[];
  events?: EventBus<DialogueRuntimeEventMap>;
}

/** Deterministic text-only sequence player; missing keys are skipped, never thrown. */
export class DialogueRuntime {
  public readonly events: EventBus<DialogueRuntimeEventMap>;

  private readonly entries: ReadonlyMap<string, DialogueEntry>;
  private readonly missions: readonly MissionDefinition[];
  private state: DialogueRuntimeSnapshotV1 = createIdleSnapshot();

  public constructor(options: DialogueRuntimeOptions = {}) {
    const entries = options.entries ?? DIALOGUE;
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
    this.missions = options.missions ?? MISSIONS;
    this.events = options.events ?? new EventBus<DialogueRuntimeEventMap>();
  }

  public get status(): DialogueStatus {
    return this.state.status;
  }

  public get currentLine(): DialogueEntry | null {
    if (this.state.status !== 'playing') {
      return null;
    }
    const key = this.state.lineKeys[this.state.index];
    return key ? this.entries.get(key) ?? null : null;
  }

  public get missingKeys(): readonly string[] {
    return [...this.state.missingKeys];
  }

  public start(keys: readonly string[]): DialogueStartResult {
    return this.startFiltered(keys);
  }

  public startMission(missionId: MissionId): DialogueStartResult {
    const mission = this.missions.find((definition) => definition.id === missionId);
    if (!mission) {
      return this.startFiltered([`mission:${missionId}`], missionId);
    }
    return this.startFiltered(mission.dialogueKeys, missionId);
  }

  public advance(): DialogueEntry | null {
    if (this.state.status !== 'playing') {
      return null;
    }
    if (this.state.index + 1 >= this.state.lineKeys.length) {
      this.state.status = 'complete';
      this.state.index = this.state.lineKeys.length;
      this.events.emit('dialogue:completed', { skipped: false });
      return null;
    }
    this.state.index += 1;
    this.emitCurrentLine();
    return this.currentLine;
  }

  public skip(): void {
    if (this.state.status !== 'playing') {
      return;
    }
    const remainingLines = this.state.lineKeys.length - this.state.index;
    this.state.status = 'complete';
    this.state.index = this.state.lineKeys.length;
    this.events.emit('dialogue:skipped', { remainingLines });
    this.events.emit('dialogue:completed', { skipped: true });
  }

  public reset(): void {
    this.state = createIdleSnapshot();
  }

  public snapshot(): DialogueRuntimeSnapshotV1 {
    return cloneJson(this.state);
  }

  public restore(value: unknown): DialogueRestoreResult {
    if (!isRecord(value) || value.snapshotVersion !== DIALOGUE_RUNTIME_SNAPSHOT_VERSION) {
      return { success: false, reason: 'dialogue snapshot version is not supported' };
    }
    if (value.status !== 'idle' && value.status !== 'playing' && value.status !== 'complete') {
      return { success: false, reason: 'dialogue snapshot status is invalid' };
    }
    if (!isStringArray(value.requestedKeys)
      || !isStringArray(value.lineKeys)
      || !isStringArray(value.missingKeys)
      || !Number.isSafeInteger(value.index)) {
      return { success: false, reason: 'dialogue snapshot sequence is invalid' };
    }
    const index = value.index as number;
    if (index < 0 || index > value.lineKeys.length) {
      return { success: false, reason: 'dialogue snapshot index is out of range' };
    }

    const resolvedKeys = value.lineKeys.filter((key) => this.entries.has(key));
    const newlyMissing = value.lineKeys.filter((key) => !this.entries.has(key));
    const missingKeys = [...new Set([...value.missingKeys, ...newlyMissing])];
    const currentKey = value.status === 'playing' ? value.lineKeys[index] : undefined;
    const resolvedBeforeCurrent = value.lineKeys
      .slice(0, index)
      .filter((key) => this.entries.has(key)).length;
    const adjustedIndex = currentKey && this.entries.has(currentKey)
      ? resolvedKeys.indexOf(currentKey)
      : Math.min(resolvedBeforeCurrent, resolvedKeys.length);
    const status = value.status === 'playing' && adjustedIndex >= resolvedKeys.length
      ? 'complete'
      : value.status;
    this.state = {
      snapshotVersion: DIALOGUE_RUNTIME_SNAPSHOT_VERSION,
      status,
      requestedKeys: [...value.requestedKeys],
      lineKeys: resolvedKeys,
      missingKeys,
      index: adjustedIndex,
    };
    return { success: true };
  }

  private startFiltered(keys: readonly string[], missionId?: MissionId): DialogueStartResult {
    const lineKeys: string[] = [];
    const missingKeys: string[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || (missionId !== undefined && entry.missionId !== missionId)) {
        missingKeys.push(key);
        this.events.emit('dialogue:missing', { key });
      } else {
        lineKeys.push(key);
      }
    }
    this.state = {
      snapshotVersion: DIALOGUE_RUNTIME_SNAPSHOT_VERSION,
      status: lineKeys.length > 0 ? 'playing' : 'complete',
      requestedKeys: [...keys],
      lineKeys,
      missingKeys,
      index: 0,
    };
    this.events.emit('dialogue:started', {
      lineCount: lineKeys.length,
      missingKeys: [...missingKeys],
    });
    if (lineKeys.length > 0) {
      this.emitCurrentLine();
    } else {
      this.events.emit('dialogue:completed', { skipped: false });
    }
    return {
      current: this.currentLine,
      lineCount: lineKeys.length,
      missingKeys: [...missingKeys],
    };
  }

  private emitCurrentLine(): void {
    const entry = this.currentLine;
    if (!entry) {
      return;
    }
    this.events.emit('dialogue:line', {
      entry,
      index: this.state.index,
      lineCount: this.state.lineKeys.length,
    });
  }
}

function createIdleSnapshot(): DialogueRuntimeSnapshotV1 {
  return {
    snapshotVersion: DIALOGUE_RUNTIME_SNAPSHOT_VERSION,
    status: 'idle',
    requestedKeys: [],
    lineKeys: [],
    missingKeys: [],
    index: 0,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
