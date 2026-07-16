import {
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
 * active/backup pair in one transaction (temporary record + pointer swap in IDB).
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
  public constructor(
    private readonly adapter: SaveStorageAdapter,
    private readonly registry: SaveValidationRegistry = {},
  ) {}

  public async initialize(): Promise<void> {
    await this.adapter.initialize();
  }

  public async listSlots(): Promise<readonly SaveSlotSummary[]> {
    return Promise.all(SAVE_SLOT_IDS.map(async (slotId): Promise<SaveSlotSummary> => {
      const record = await this.adapter.readSlot(slotId);
      if (!record) {
        return { slotId, status: 'empty', metadata: null };
      }
      const active = this.readEnvelopeForSlot(record.active, slotId);
      if (active.success) {
        return { slotId, status: 'ready', metadata: cloneJson(active.save.slot) };
      }
      const backup = this.readEnvelopeForSlot(record.backup, slotId);
      if (backup.success) {
        return { slotId, status: 'recovered', metadata: cloneJson(backup.save.slot) };
      }
      return { slotId, status: 'corrupt', metadata: null };
    }));
  }

  public async loadSlot(slotId: SaveSlotId): Promise<SaveLoadResult | null> {
    const record = await this.adapter.readSlot(slotId);
    if (!record) {
      return null;
    }

    const active = this.readEnvelopeForSlot(record.active, slotId);
    if (active.success) {
      return { save: cloneJson(active.save), recoveredFromBackup: false };
    }

    const backup = this.readEnvelopeForSlot(record.backup, slotId);
    if (backup.success) {
      return { save: cloneJson(backup.save), recoveredFromBackup: true };
    }

    throw new Error(`save slot ${slotId} is corrupt: ${[...active.errors, ...backup.errors].join('; ')}`);
  }

  public async saveSlot(save: SaveGameV1): Promise<SaveSlotMetadata> {
    const validation = validateSaveGame(save, this.registry);
    if (!validation.valid) {
      throw new Error(`cannot persist invalid save: ${validation.errors.join('; ')}`);
    }

    const slotId = validation.save.slot.id;
    const existing = await this.adapter.readSlot(slotId);
    let backup: SaveEnvelopeV1 | null = null;
    if (existing) {
      const active = this.readEnvelopeForSlot(existing.active, slotId);
      if (active.success) {
        backup = createSaveEnvelope(active.save);
      } else {
        const previousBackup = this.readEnvelopeForSlot(existing.backup, slotId);
        if (previousBackup.success) {
          backup = createSaveEnvelope(previousBackup.save);
        }
      }
    }

    await this.adapter.writeSlotAtomic(
      slotId,
      createSaveEnvelope(validation.save),
      backup,
    );
    return cloneJson(validation.save.slot);
  }

  public async deleteSlot(slotId: SaveSlotId): Promise<void> {
    await this.adapter.deleteSlot(slotId);
  }

  public async loadSettings(): Promise<GameSettings> {
    const settings = await this.adapter.readSettings();
    return validateGameSettings(settings) ? cloneJson(settings) : createDefaultSettings();
  }

  public async saveSettings(settings: GameSettings): Promise<void> {
    if (!validateGameSettings(settings)) {
      throw new Error('cannot persist invalid settings');
    }
    await this.adapter.writeSettingsAtomic(cloneJson(settings));
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
