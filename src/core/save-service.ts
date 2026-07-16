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

export interface StoredSaveSlotRecord {
  active: unknown;
  backup: unknown | null;
}

/**
 * Persistence boundary designed for IndexedDB. Implementations must write the
 * active/backup pair in one transaction (temporary record + pointer swap in IDB)
 * and leave the previously committed pair unchanged when that write rejects.
 */
export interface SaveStorageAdapter {
  initialize(): Promise<void>;
  readSlot(slotId: SaveSlotId): Promise<StoredSaveSlotRecord | null>;
  writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
  ): Promise<void>;
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

export type SaveSlotStatus = 'empty' | 'ready' | 'recovered' | 'corrupt';

export interface SaveSlotSummary {
  slotId: SaveSlotId;
  status: SaveSlotStatus;
  metadata: SaveSlotMetadata | null;
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
        return { slotId, status: 'empty', metadata: null };
      }
      const active = this.readEnvelopeForSlot(record.active, slotId);
      if (active.success) {
        return { slotId, status: 'ready', metadata: cloneJson(active.save.slot) };
      }
      // Never treat a last-generation backup as the playable source when the
      // active snapshot is an intact save from a newer build. Doing so would
      // let the next autosave silently overwrite the only future-version copy.
      if (inspectUnsupportedSnapshot(record.active) !== null) {
        return { slotId, status: 'corrupt', metadata: null };
      }
      const backup = this.readEnvelopeForSlot(record.backup, slotId);
      if (backup.success) {
        return { slotId, status: 'recovered', metadata: cloneJson(backup.save.slot) };
      }
      return { slotId, status: 'corrupt', metadata: null };
    }));
  }

  public async loadSlot(slotId: SaveSlotId): Promise<SaveLoadResult | null> {
    await this.waitForSlotOperations(slotId);
    const record = await this.adapter.readSlot(slotId);
    if (!record) {
      return null;
    }

    const active = this.readEnvelopeForSlot(record.active, slotId);
    if (active.success) {
      return { save: cloneJson(active.save), recoveredFromBackup: false };
    }
    const unsupportedActive = inspectUnsupportedSnapshot(record.active);
    if (unsupportedActive !== null) {
      throw new SaveSlotReadError(
        slotId,
        'unsupported-version',
        active.errors,
        unsupportedActive.serialized,
      );
    }

    const backup = this.readEnvelopeForSlot(record.backup, slotId);
    if (backup.success) {
      return { save: cloneJson(backup.save), recoveredFromBackup: true };
    }

    const errors = [...active.errors, ...backup.errors];
    const preserved = findUnsupportedSnapshot(record);
    throw new SaveSlotReadError(
      slotId,
      preserved === null ? 'corrupt' : 'unsupported-version',
      errors,
      preserved?.serialized ?? null,
    );
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
        const existing = await this.adapter.readSlot(slotId);
        let backup: SaveEnvelopeV1 | null = null;
        if (existing) {
          const active = this.readEnvelopeForSlot(existing.active, slotId);
          const previousBackup = this.readEnvelopeForSlot(existing.backup, slotId);
          const preserved = findUnsupportedSnapshot(existing);
          if (preserved !== null) {
            throw new SaveSlotReadError(
              slotId,
              'unsupported-version',
              [
                ...(active.success ? [] : active.errors),
                ...(previousBackup.success ? [] : previousBackup.errors),
              ],
              preserved.serialized,
            );
          }
          if (active.success) {
            backup = createSaveEnvelope(active.save);
          } else if (previousBackup.success) {
            backup = createSaveEnvelope(previousBackup.save);
          }
        }

        await this.adapter.writeSlotAtomic(slotId, activeEnvelope, backup);
        return cloneJson(metadata);
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
    const loaded = await this.loadSlot(slotId);
    if (!loaded) {
      throw new Error(`save slot ${slotId} is empty`);
    }
    return serializeSaveGame(loaded.save, true);
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
   * Serializes each slot's read/rotate/write sequence. Without this queue, two
   * overlapping autosaves can both rotate the same stale active snapshot and
   * silently skip the newer last-known-good backup.
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
  ): Promise<void> {
    const next: StoredSaveSlotRecord = {
      active: cloneJson(active),
      backup: backup ? cloneJson(backup) : null,
    };
    // A real IDB adapter replaces this pair and its active pointer in one transaction.
    this.slots.set(slotId, next);
    await Promise.resolve();
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
