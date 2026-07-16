import {
  SAVE_CHECKSUM_ALGORITHM,
  SAVE_EXPORT_FORMAT,
  SAVE_EXPORT_FORMAT_VERSION,
  computeChecksum,
  createSaveEnvelope,
  parseSaveGame,
  serializeSaveGame,
  validateSaveEnvelope,
  type SaveEnvelopeV1,
  type SaveImportResult,
} from './save-format';
import {
  createDefaultSettings,
  validateGameSettings,
  type GameSettings,
} from './settings';
import {
  SAVE_GAME_VERSION,
  type SaveGameV1,
  type SaveSlotId,
  type SaveSlotMetadata,
} from './state';
import { validateSaveGame, type SaveValidationRegistry } from './save-validation';

export const SAVE_SLOT_IDS: readonly SaveSlotId[] = [1, 2, 3];

const MAX_SAVE_COMMIT_ATTEMPTS = 8;

export interface StoredSaveSlotRecord {
  active: unknown;
  backup: unknown | null;
  /** Monotonic adapter-owned generation used for optimistic cross-tab commits. */
  revision: number;
}

/**
 * Persistence boundary designed for IndexedDB. Implementations must write the
 * active/backup pair in one transaction, leave the previously committed pair
 * unchanged when that write rejects, and return false on a revision mismatch.
 */
export interface SaveStorageAdapter {
  initialize(): Promise<void>;
  readSlot(slotId: SaveSlotId): Promise<StoredSaveSlotRecord | null>;
  writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
    /** Omit only for deliberate administrative/test replacement. */
    expectedRevision?: number,
  ): Promise<boolean>;
  deleteSlot(slotId: SaveSlotId): Promise<void>;
  readSettings(): Promise<unknown | null>;
  writeSettingsAtomic(settings: GameSettings): Promise<void>;
}

export type PersistenceWriteErrorCode = 'quota-exceeded' | 'storage-write-failed';
export type PersistenceWriteOperation = 'save-slot' | 'delete-slot' | 'save-settings';

/**
 * A durable-write failure with enough context for UI to keep a persistent
 * warning visible and offer a checksummed emergency export when game progress
 * could not be stored.
 */
export class PersistenceWriteError extends Error {
  public override readonly name = 'PersistenceWriteError';

  public constructor(
    public readonly code: PersistenceWriteErrorCode,
    public readonly operation: PersistenceWriteOperation,
    public readonly slotId: SaveSlotId | null,
    public readonly emergencyExport: string | null,
    cause: unknown,
  ) {
    const target = slotId === null ? 'settings' : `save slot ${slotId}`;
    const reason = code === 'quota-exceeded'
      ? 'browser storage quota was exceeded'
      : 'browser storage rejected the write';
    super(`${target} could not be persisted because ${reason}`, { cause });
  }
}

export type SaveSlotReadErrorCode = 'corrupt' | 'unsupported-version';

/** A failed load that never mutates or deletes the original stored snapshots. */
export class SaveSlotReadError extends Error {
  public override readonly name = 'SaveSlotReadError';

  public constructor(
    public readonly slotId: SaveSlotId,
    public readonly code: SaveSlotReadErrorCode,
    public readonly errors: readonly string[],
    /** Exact valid future-version envelope, when one can be preserved for export. */
    public readonly preservedSnapshot: string | null,
  ) {
    super(`save slot ${slotId} is ${code === 'corrupt' ? 'corrupt' : 'from a newer game version'}: ${errors.join('; ')}`);
  }
}

export type SaveSlotStatus =
  | 'empty'
  | 'ready'
  | 'recovered'
  | 'corrupt'
  | 'unsupported-version';

/** UI-safe fields copied only from a checksummed and fully validated save. */
export interface SaveSlotPreview {
  label: string;
  updatedAt: number;
  alexPreset: SaveGameV1['alexPreset'];
  level: number;
  activeMissionId: string | null;
  activeDistrict: SaveGameV1['activeDistrict'];
  playtimeSeconds: number;
}

export interface SaveSlotSummary {
  slotId: SaveSlotId;
  status: SaveSlotStatus;
  metadata: SaveSlotMetadata | null;
  preview: SaveSlotPreview | null;
}

export interface SaveLoadResult {
  save: SaveGameV1;
  recoveredFromBackup: boolean;
}

export interface SaveService {
  initialize(): Promise<void>;
  listSlots(): Promise<readonly SaveSlotSummary[]>;
  loadSlot(slotId: SaveSlotId): Promise<SaveLoadResult | null>;
  saveSlot(save: SaveGameV1): Promise<SaveSlotMetadata>;
  deleteSlot(slotId: SaveSlotId): Promise<void>;
  loadSettings(): Promise<GameSettings>;
  saveSettings(settings: GameSettings): Promise<void>;
  exportSlot(slotId: SaveSlotId): Promise<string>;
  inspectImport(serialized: string): SaveImportResult;
  importIntoSlot(
    serialized: string,
    destination: SaveSlotId,
    timestamp: number,
  ): Promise<SaveGameV1>;
}

export class CoreSaveService implements SaveService {
  private readonly slotOperationTails = new Map<SaveSlotId, Promise<void>>();

  public constructor(
    private readonly adapter: SaveStorageAdapter,
    private readonly registry: SaveValidationRegistry = {},
  ) {}

  public async initialize(): Promise<void> {
    await this.adapter.initialize();
  }

  public async listSlots(): Promise<readonly SaveSlotSummary[]> {
    await Promise.all(SAVE_SLOT_IDS.map((slotId) => this.waitForSlotOperations(slotId)));
    return Promise.all(SAVE_SLOT_IDS.map(async (slotId): Promise<SaveSlotSummary> => {
      const record = await this.adapter.readSlot(slotId);
      if (!record) {
        return { slotId, status: 'empty', metadata: null, preview: null };
      }
      const inspection = this.inspectStoredSlot(record, slotId);
      if (inspection.status === 'unsupported-version') {
        return { slotId, status: inspection.status, metadata: null, preview: null };
      }
      if (inspection.status === 'ready' || inspection.status === 'recovered') {
        return {
          slotId,
          status: inspection.status,
          metadata: cloneJson(inspection.save.slot),
          preview: createSaveSlotPreview(inspection.save),
        };
      }
      return { slotId, status: 'corrupt', metadata: null, preview: null };
    }));
  }

  public async loadSlot(slotId: SaveSlotId): Promise<SaveLoadResult | null> {
    await this.waitForSlotOperations(slotId);
    const record = await this.adapter.readSlot(slotId);
    if (!record) {
      return null;
    }
    const inspection = this.inspectStoredSlot(record, slotId);
    if (inspection.status === 'ready' || inspection.status === 'recovered') {
      return {
        save: cloneJson(inspection.save),
        recoveredFromBackup: inspection.status === 'recovered',
      };
    }
    throw createSlotReadError(slotId, inspection);
  }

  public async saveSlot(save: SaveGameV1): Promise<SaveSlotMetadata> {
    const validation = validateSaveGame(save, this.registry);
    if (!validation.valid) {
      throw new Error(`cannot persist invalid save: ${validation.errors.join('; ')}`);
    }

    const activeEnvelope = createSaveEnvelope(validation.save);
    const slotId = activeEnvelope.payload.slot.id;
    const metadata = cloneJson(activeEnvelope.payload.slot);
    const emergencyExport = JSON.stringify(activeEnvelope, null, 2);

    return this.runSlotOperation(slotId, async () => {
      try {
        for (let attempt = 0; attempt < MAX_SAVE_COMMIT_ATTEMPTS; attempt += 1) {
          const existing = await this.adapter.readSlot(slotId);
          let backup: SaveEnvelopeV1 | null = null;
          if (existing) {
            const inspection = this.inspectStoredSlot(existing, slotId);
            if (inspection.status === 'unsupported-version' || inspection.status === 'corrupt') {
              throw createSlotReadError(slotId, inspection);
            }
            backup = createSaveEnvelope(inspection.save);
          }

          const committed = await this.adapter.writeSlotAtomic(
            slotId,
            activeEnvelope,
            backup,
            existing?.revision ?? 0,
          );
          if (committed) return cloneJson(metadata);
        }
        throw new Error(`save slot ${slotId} changed too often to commit safely`);
      } catch (error: unknown) {
        if (error instanceof PersistenceWriteError || error instanceof SaveSlotReadError) throw error;
        throw createPersistenceWriteError('save-slot', slotId, emergencyExport, error);
      }
    });
  }

  public async deleteSlot(slotId: SaveSlotId): Promise<void> {
    await this.runSlotOperation(slotId, async () => {
      try {
        await this.adapter.deleteSlot(slotId);
      } catch (error: unknown) {
        throw createPersistenceWriteError('delete-slot', slotId, null, error);
      }
    });
  }

  public async loadSettings(): Promise<GameSettings> {
    const settings = await this.adapter.readSettings();
    return validateGameSettings(settings) ? cloneJson(settings) : createDefaultSettings();
  }

  public async saveSettings(settings: GameSettings): Promise<void> {
    if (!validateGameSettings(settings)) {
      throw new Error('cannot persist invalid settings');
    }
    try {
      await this.adapter.writeSettingsAtomic(cloneJson(settings));
    } catch (error: unknown) {
      throw createPersistenceWriteError('save-settings', null, null, error);
    }
  }

  public async exportSlot(slotId: SaveSlotId): Promise<string> {
    await this.waitForSlotOperations(slotId);
    const record = await this.adapter.readSlot(slotId);
    if (!record) {
      throw new Error(`save slot ${slotId} is empty`);
    }
    const inspection = this.inspectStoredSlot(record, slotId);
    if (inspection.status === 'unsupported-version') {
      return inspection.preserved.serialized;
    }
    if (inspection.status === 'ready' || inspection.status === 'recovered') {
      return serializeSaveGame(inspection.save, true);
    }
    throw createSlotReadError(slotId, inspection);
  }

  public inspectImport(serialized: string): SaveImportResult {
    return parseSaveGame(serialized, this.registry);
  }

  public async importIntoSlot(
    serialized: string,
    destination: SaveSlotId,
    timestamp: number,
  ): Promise<SaveGameV1> {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new RangeError('timestamp must be a non-negative finite number');
    }
    const imported = this.inspectImport(serialized);
    if (!imported.success) {
      throw new Error(`cannot import save: ${imported.errors.join('; ')}`);
    }

    const save = cloneJson(imported.save);
    save.slot = {
      id: destination,
      label: save.slot.label,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.saveSlot(save);
    return cloneJson(save);
  }

  private readEnvelopeForSlot(value: unknown, slotId: SaveSlotId): SaveImportResult {
    if (value === null) {
      return { success: false, errors: ['save snapshot is missing'] };
    }
    const result = validateSaveEnvelope(value, this.registry);
    if (result.success && result.save.slot.id !== slotId) {
      return { success: false, errors: [`save snapshot belongs to slot ${result.save.slot.id}`] };
    }
    return result;
  }

  /**
   * One preflight owns list/load/save/export classification. Future-version
   * snapshots intentionally win over an otherwise playable generation so no
   * operation can silently rotate away data written by a newer build.
   */
  private inspectStoredSlot(record: StoredSaveSlotRecord, slotId: SaveSlotId): StoredSlotInspection {
    const active = this.readEnvelopeForSlot(record.active, slotId);
    const backup = this.readEnvelopeForSlot(record.backup, slotId);
    const preserved = findUnsupportedSnapshot(record);
    const errors = [
      ...(active.success ? [] : active.errors),
      ...(backup.success ? [] : backup.errors),
    ];
    if (preserved !== null) {
      return { status: 'unsupported-version', preserved, errors };
    }
    if (active.success) {
      return { status: 'ready', save: active.save };
    }
    if (backup.success) {
      return { status: 'recovered', save: backup.save };
    }
    return { status: 'corrupt', errors };
  }

  /**
   * Serializes each slot's read/rotate/write sequence within one service.
   * Adapter-level revision checks cover independent services and browser tabs.
   */
  private runSlotOperation<Value>(
    slotId: SaveSlotId,
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const previous = this.slotOperationTails.get(slotId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.slotOperationTails.set(slotId, tail);
    void tail.then(() => {
      if (this.slotOperationTails.get(slotId) === tail) {
        this.slotOperationTails.delete(slotId);
      }
    });
    return result;
  }

  private async waitForSlotOperations(slotId: SaveSlotId): Promise<void> {
    await this.slotOperationTails.get(slotId);
  }
}

/** Deterministic test/development adapter with the same atomic commit semantics as IDB. */
export class InMemorySaveAdapter implements SaveStorageAdapter {
  private readonly slots = new Map<SaveSlotId, StoredSaveSlotRecord>();
  private settings: unknown | null = null;

  public async initialize(): Promise<void> {
    await Promise.resolve();
  }

  public async readSlot(slotId: SaveSlotId): Promise<StoredSaveSlotRecord | null> {
    const record = this.slots.get(slotId);
    return Promise.resolve(record ? cloneJson(record) : null);
  }

  public async writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
    expectedRevision?: number,
  ): Promise<boolean> {
    const current = this.slots.get(slotId);
    const currentRevision = current?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      return Promise.resolve(false);
    }
    const next: StoredSaveSlotRecord = {
      active: cloneJson(active),
      backup: backup ? cloneJson(backup) : null,
      revision: currentRevision + 1,
    };
    // A real IDB adapter replaces this pair and its active pointer in one transaction.
    this.slots.set(slotId, next);
    await Promise.resolve();
    return true;
  }

  public async deleteSlot(slotId: SaveSlotId): Promise<void> {
    this.slots.delete(slotId);
    await Promise.resolve();
  }

  public async readSettings(): Promise<unknown | null> {
    return Promise.resolve(this.settings === null ? null : cloneJson(this.settings));
  }

  public async writeSettingsAtomic(settings: GameSettings): Promise<void> {
    this.settings = cloneJson(settings);
    await Promise.resolve();
  }
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

interface UnsupportedSnapshot {
  schemaVersion: number;
  serialized: string;
}

type StoredSlotInspection =
  | { status: 'ready'; save: SaveGameV1 }
  | { status: 'recovered'; save: SaveGameV1 }
  | { status: 'corrupt'; errors: readonly string[] }
  | {
    status: 'unsupported-version';
    preserved: UnsupportedSnapshot;
    errors: readonly string[];
  };

function createSaveSlotPreview(save: SaveGameV1): SaveSlotPreview {
  return {
    label: save.slot.label,
    updatedAt: save.slot.updatedAt,
    alexPreset: save.alexPreset,
    level: save.player.level,
    activeMissionId: runtimeActiveMissionId(save),
    activeDistrict: save.activeDistrict,
    playtimeSeconds: save.playtimeSeconds,
  };
}

function runtimeActiveMissionId(save: Readonly<SaveGameV1>): string | null {
  const runtime = save.missionRuntime;
  if (!isRecord(runtime) || !isRecord(runtime.campaign)) return null;
  const activeMissionId = runtime.campaign.activeMissionId;
  return typeof activeMissionId === 'string' ? activeMissionId : null;
}

function createSlotReadError(
  slotId: SaveSlotId,
  inspection: Extract<StoredSlotInspection, { status: 'corrupt' | 'unsupported-version' }>,
): SaveSlotReadError {
  return new SaveSlotReadError(
    slotId,
    inspection.status,
    inspection.errors,
    inspection.status === 'unsupported-version' ? inspection.preserved.serialized : null,
  );
}

function findUnsupportedSnapshot(record: StoredSaveSlotRecord): UnsupportedSnapshot | null {
  return inspectUnsupportedSnapshot(record.active) ?? inspectUnsupportedSnapshot(record.backup);
}

/**
 * Recognizes only an intact, checksummed envelope. A tampered payload that
 * merely claims a future schema remains corruption and is never presented as a
 * trustworthy preserved export.
 */
function inspectUnsupportedSnapshot(value: unknown): UnsupportedSnapshot | null {
  if (!isRecord(value)
    || value.format !== SAVE_EXPORT_FORMAT
    || value.formatVersion !== SAVE_EXPORT_FORMAT_VERSION
    || !isRecord(value.checksum)
    || value.checksum.algorithm !== SAVE_CHECKSUM_ALGORITHM
    || typeof value.checksum.value !== 'string'
    || !isRecord(value.payload)) {
    return null;
  }
  const schemaVersion = value.payload.schemaVersion;
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) <= SAVE_GAME_VERSION) {
    return null;
  }
  try {
    if (computeChecksum(value.payload) !== value.checksum.value) return null;
    return {
      schemaVersion: schemaVersion as number,
      serialized: JSON.stringify(value, null, 2),
    };
  } catch {
    return null;
  }
}

function createPersistenceWriteError(
  operation: PersistenceWriteOperation,
  slotId: SaveSlotId | null,
  emergencyExport: string | null,
  cause: unknown,
): PersistenceWriteError {
  return new PersistenceWriteError(
    isQuotaExceededError(cause) ? 'quota-exceeded' : 'storage-write-failed',
    operation,
    slotId,
    emergencyExport,
    cause,
  );
}

function isQuotaExceededError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /\bquota\b/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
