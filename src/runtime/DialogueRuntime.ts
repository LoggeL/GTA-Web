import { EventBus } from '../core/events';
import { DIALOGUE, MISSIONS } from '../data/missions';
import type { DialogueEntry, MissionDefinition, MissionId } from '../data/types';

const LEGACY_DIALOGUE_RUNTIME_SNAPSHOT_VERSION = 1 as const;
export const DIALOGUE_RUNTIME_SNAPSHOT_VERSION = 2 as const;

export type DialogueStatus = 'idle' | 'playing' | 'complete';
export type DialogueBranch = 'rule' | 'expose';

export interface DialogueRuntimeSnapshotV1 {
  snapshotVersion: typeof LEGACY_DIALOGUE_RUNTIME_SNAPSHOT_VERSION;
  status: DialogueStatus;
  requestedKeys: string[];
  lineKeys: string[];
  missingKeys: string[];
  index: number;
}

export interface DialogueRuntimeSnapshotV2 {
  snapshotVersion: typeof DIALOGUE_RUNTIME_SNAPSHOT_VERSION;
  status: DialogueStatus;
  requestedKeys: string[];
  lineKeys: string[];
  missingKeys: string[];
  index: number;
  reviewedKeys: string[];
}

export type DialogueRuntimeSnapshot = DialogueRuntimeSnapshotV2;

export interface DialogueRuntimeEventMap {
  'dialogue:started': {
    lineCount: number;
    missingKeys: readonly string[];
    excludedKeys: readonly string[];
  };
  'dialogue:line': { entry: DialogueEntry; index: number; lineCount: number };
  'dialogue:missing': { key: string };
  'dialogue:reviewed': { entries: readonly DialogueEntry[]; total: number };
  'dialogue:completed': { skipped: boolean };
  'dialogue:skipped': { remainingLines: number };
}

export interface DialogueStartResult {
  current: DialogueEntry | null;
  lineCount: number;
  missingKeys: readonly string[];
  excludedKeys: readonly string[];
}

export interface DialogueStartContext {
  /** Selects the single authored ending branch. Without it, branch-only lines stay hidden. */
  branch?: DialogueBranch;
}

export interface DialogueSequenceProgress {
  status: DialogueStatus;
  currentIndex: number | null;
  currentNumber: number;
  lineCount: number;
}

export type DialogueRestoreResult =
  | { success: true; migratedFromVersion: 1 | null }
  | { success: false; reason: string };

export function validateDialogueRuntimeSnapshot(value: unknown): DialogueRestoreResult {
  const result = parseSnapshot(value);
  return result.success
    ? { success: true, migratedFromVersion: result.migratedFromVersion }
    : result;
}

export interface DialogueRuntimeOptions {
  entries?: readonly DialogueEntry[];
  missions?: readonly MissionDefinition[];
  events?: EventBus<DialogueRuntimeEventMap>;
}

/**
 * Deterministic text-only sequence player. Missing content degrades safely and every
 * displayed or skipped story line is retained for a framework-neutral mission log.
 */
export class DialogueRuntime {
  public readonly events: EventBus<DialogueRuntimeEventMap>;

  private readonly entries: ReadonlyMap<string, DialogueEntry>;
  private readonly missions: readonly MissionDefinition[];
  private state: DialogueRuntimeSnapshotV2 = createIdleSnapshot();

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

  public get reviewedKeys(): readonly string[] {
    return [...this.state.reviewedKeys];
  }

  public get reviewEntries(): readonly DialogueEntry[] {
    return this.resolveEntries(this.state.reviewedKeys);
  }

  public get progress(): DialogueSequenceProgress {
    const lineCount = this.state.lineKeys.length;
    return {
      status: this.state.status,
      currentIndex: this.state.status === 'playing' ? this.state.index : null,
      currentNumber: this.state.status === 'playing'
        ? this.state.index + 1
        : this.state.status === 'complete' ? lineCount : 0,
      lineCount,
    };
  }

  public reviewMission(missionId: MissionId): readonly DialogueEntry[] {
    return this.reviewEntries.filter((entry) => entry.missionId === missionId);
  }

  public reviewEntry(key: string): DialogueEntry | null {
    return this.state.reviewedKeys.includes(key) ? this.entries.get(key) ?? null : null;
  }

  /** Starts an explicit authored sequence; explicit keys are never branch-filtered. */
  public start(keys: readonly string[]): DialogueStartResult {
    return this.startFiltered(keys);
  }

  public startMission(
    missionId: MissionId,
    context: Readonly<DialogueStartContext> = {},
  ): DialogueStartResult {
    const mission = this.missions.find((definition) => definition.id === missionId);
    if (!mission) {
      return this.startFiltered([`mission:${missionId}`], missionId);
    }
    return this.startFiltered(
      mission.dialogueKeys,
      missionId,
      (entry) => entry.branch === undefined || entry.branch === context.branch,
    );
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
    this.markReviewed([this.state.lineKeys[this.state.index]!]);
    this.emitCurrentLine();
    return this.currentLine;
  }

  /** Re-emits the restored current line without advancing the sequence. */
  public resume(): DialogueEntry | null {
    const entry = this.currentLine;
    if (entry) {
      this.markReviewed([entry.key]);
      this.emitCurrentLine();
    }
    return entry;
  }

  public skip(): void {
    if (this.state.status !== 'playing') {
      return;
    }
    const remainingLines = this.state.lineKeys.length - this.state.index;
    this.markReviewed(this.state.lineKeys.slice(this.state.index));
    this.state.status = 'complete';
    this.state.index = this.state.lineKeys.length;
    this.events.emit('dialogue:skipped', { remainingLines });
    this.events.emit('dialogue:completed', { skipped: true });
  }

  /** Closes the current sequence while preserving story review history by default. */
  public reset(options: Readonly<{ clearReview?: boolean }> = {}): void {
    this.state = createIdleSnapshot(options.clearReview ? [] : this.state.reviewedKeys);
  }

  public clearReviewHistory(): void {
    this.state.reviewedKeys = [];
  }

  public snapshot(): DialogueRuntimeSnapshotV2 {
    return cloneJson(this.state);
  }

  public restore(value: unknown): DialogueRestoreResult {
    const parsed = parseSnapshot(value);
    if (!parsed.success) {
      return parsed;
    }

    const snapshot = parsed.snapshot;
    const resolvedKeys = snapshot.lineKeys.filter((key) => this.entries.has(key));
    const newlyMissing = [
      ...snapshot.lineKeys.filter((key) => !this.entries.has(key)),
      ...snapshot.reviewedKeys.filter((key) => !this.entries.has(key)),
    ];
    const missingKeys = uniqueStrings([...snapshot.missingKeys, ...newlyMissing]);
    const currentKey = snapshot.status === 'playing'
      ? snapshot.lineKeys[snapshot.index]
      : undefined;
    const resolvedBeforeCurrent = snapshot.lineKeys
      .slice(0, snapshot.index)
      .filter((key) => this.entries.has(key)).length;
    const adjustedIndex = currentKey && this.entries.has(currentKey)
      ? resolvedKeys.indexOf(currentKey)
      : Math.min(resolvedBeforeCurrent, resolvedKeys.length);
    const status = snapshot.status === 'playing' && adjustedIndex >= resolvedKeys.length
      ? 'complete'
      : snapshot.status;
    const reviewedKeys = uniqueStrings(snapshot.reviewedKeys.filter((key) => this.entries.has(key)));
    const adjustedCurrent = status === 'playing' ? resolvedKeys[adjustedIndex] : undefined;
    if (adjustedCurrent && !reviewedKeys.includes(adjustedCurrent)) {
      reviewedKeys.push(adjustedCurrent);
    }
    this.state = {
      snapshotVersion: DIALOGUE_RUNTIME_SNAPSHOT_VERSION,
      status,
      requestedKeys: [...snapshot.requestedKeys],
      lineKeys: resolvedKeys,
      missingKeys,
      index: status === 'complete' ? resolvedKeys.length : adjustedIndex,
      reviewedKeys,
    };
    return { success: true, migratedFromVersion: parsed.migratedFromVersion };
  }

  private startFiltered(
    keys: readonly string[],
    missionId?: MissionId,
    include: (entry: DialogueEntry) => boolean = () => true,
  ): DialogueStartResult {
    const lineKeys: string[] = [];
    const missingKeys: string[] = [];
    const excludedKeys: string[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || (missionId !== undefined && entry.missionId !== missionId)) {
        missingKeys.push(key);
        this.events.emit('dialogue:missing', { key });
      } else if (!include(entry)) {
        excludedKeys.push(key);
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
      reviewedKeys: [...this.state.reviewedKeys],
    };
    this.events.emit('dialogue:started', {
      lineCount: lineKeys.length,
      missingKeys: [...missingKeys],
      excludedKeys: [...excludedKeys],
    });
    if (lineKeys.length > 0) {
      this.markReviewed([lineKeys[0]!]);
      this.emitCurrentLine();
    } else {
      this.events.emit('dialogue:completed', { skipped: false });
    }
    return {
      current: this.currentLine,
      lineCount: lineKeys.length,
      missingKeys: [...missingKeys],
      excludedKeys: [...excludedKeys],
    };
  }

  private markReviewed(keys: readonly string[]): void {
    const added: DialogueEntry[] = [];
    for (const key of keys) {
      if (this.state.reviewedKeys.includes(key)) {
        continue;
      }
      const entry = this.entries.get(key);
      if (entry) {
        this.state.reviewedKeys.push(key);
        added.push(entry);
      }
    }
    if (added.length > 0) {
      this.events.emit('dialogue:reviewed', {
        entries: added,
        total: this.state.reviewedKeys.length,
      });
    }
  }

  private resolveEntries(keys: readonly string[]): DialogueEntry[] {
    const entries: DialogueEntry[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        entries.push(entry);
      }
    }
    return entries;
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

type ParsedSnapshotResult =
  | {
    success: true;
    snapshot: Omit<DialogueRuntimeSnapshotV2, 'snapshotVersion'>;
    migratedFromVersion: 1 | null;
  }
  | { success: false; reason: string };

function parseSnapshot(value: unknown): ParsedSnapshotResult {
  if (!isRecord(value)
    || (value.snapshotVersion !== LEGACY_DIALOGUE_RUNTIME_SNAPSHOT_VERSION
      && value.snapshotVersion !== DIALOGUE_RUNTIME_SNAPSHOT_VERSION)) {
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
  if (value.status === 'playing' && (value.lineKeys.length === 0 || index >= value.lineKeys.length)) {
    return { success: false, reason: 'playing dialogue snapshot has no current line' };
  }
  if (value.status === 'complete' && index !== value.lineKeys.length) {
    return { success: false, reason: 'complete dialogue snapshot index is invalid' };
  }
  if (value.status === 'idle' && (value.lineKeys.length !== 0 || index !== 0)) {
    return { success: false, reason: 'idle dialogue snapshot sequence is invalid' };
  }

  const migratedFromVersion = value.snapshotVersion === LEGACY_DIALOGUE_RUNTIME_SNAPSHOT_VERSION
    ? 1
    : null;
  if (migratedFromVersion === null && !isStringArray(value.reviewedKeys)) {
    return { success: false, reason: 'dialogue review history is invalid' };
  }
  const reviewedKeys = migratedFromVersion === 1
    ? legacyReviewedKeys(value.status, value.lineKeys, index)
    : value.reviewedKeys as string[];
  return {
    success: true,
    snapshot: {
      status: value.status,
      requestedKeys: [...value.requestedKeys],
      lineKeys: [...value.lineKeys],
      missingKeys: uniqueStrings(value.missingKeys),
      index,
      reviewedKeys: uniqueStrings(reviewedKeys),
    },
    migratedFromVersion,
  };
}

function legacyReviewedKeys(
  status: DialogueStatus,
  lineKeys: readonly string[],
  index: number,
): string[] {
  if (status === 'idle') {
    return [];
  }
  return status === 'complete'
    ? [...lineKeys]
    : lineKeys.slice(0, index + 1);
}

function createIdleSnapshot(reviewedKeys: readonly string[] = []): DialogueRuntimeSnapshotV2 {
  return {
    snapshotVersion: DIALOGUE_RUNTIME_SNAPSHOT_VERSION,
    status: 'idle',
    requestedKeys: [],
    lineKeys: [],
    missingKeys: [],
    index: 0,
    reviewedKeys: [...reviewedKeys],
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
