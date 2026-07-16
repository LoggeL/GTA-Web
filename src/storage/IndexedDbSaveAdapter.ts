import type {
  GameSettings,
  SaveEnvelopeV1,
  SaveSlotId,
  SaveStorageAdapter,
  StoredSaveSlotRecord,
} from '../core';

interface SlotRow extends StoredSaveSlotRecord {
  slotId: SaveSlotId;
}

interface MetaRow {
  key: 'settings';
  value: GameSettings;
}

const DATABASE_NAME = 'heatline-solara';
const DATABASE_VERSION = 1;
const SLOT_STORE = 'save-slots';
const META_STORE = 'meta';

export class IndexedDbSaveAdapter implements SaveStorageAdapter {
  #database: IDBDatabase | null = null;

  async initialize(): Promise<void> {
    if (this.#database) return;
    this.#database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener('upgradeneeded', () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SLOT_STORE)) {
          database.createObjectStore(SLOT_STORE, { keyPath: 'slotId' });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('Could not open save database')));
      request.addEventListener('blocked', () => reject(new Error('Save database upgrade is blocked by another tab')));
    });
    this.#database.addEventListener('versionchange', () => {
      this.#database?.close();
      this.#database = null;
    });
  }

  async readSlot(slotId: SaveSlotId): Promise<StoredSaveSlotRecord | null> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(SLOT_STORE, 'readonly');
    const request = transaction.objectStore(SLOT_STORE).get(slotId);
    const row = await this.#request<SlotRow | undefined>(request);
    await this.#transaction(transaction);
    return row ? { active: row.active, backup: row.backup } : null;
  }

  async writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
  ): Promise<void> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(SLOT_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(SLOT_STORE).put({ slotId, active, backup } satisfies SlotRow);
    await this.#transaction(transaction);
  }

  async deleteSlot(slotId: SaveSlotId): Promise<void> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(SLOT_STORE, 'readwrite');
    transaction.objectStore(SLOT_STORE).delete(slotId);
    await this.#transaction(transaction);
  }

  async readSettings(): Promise<unknown | null> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(META_STORE, 'readonly');
    const request = transaction.objectStore(META_STORE).get('settings');
    const row = await this.#request<MetaRow | undefined>(request);
    await this.#transaction(transaction);
    return row?.value ?? null;
  }

  async writeSettingsAtomic(settings: GameSettings): Promise<void> {
    const database = this.#requireDatabase();
    const transaction = database.transaction(META_STORE, 'readwrite', { durability: 'strict' });
    transaction.objectStore(META_STORE).put({ key: 'settings', value: settings } satisfies MetaRow);
    await this.#transaction(transaction);
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  #requireDatabase(): IDBDatabase {
    if (!this.#database) throw new Error('IndexedDbSaveAdapter must be initialized before use');
    return this.#database;
  }

  #request<Value>(request: IDBRequest<Value>): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')));
    });
  }

  #transaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')));
      transaction.addEventListener('error', () => reject(transaction.error ?? new Error('IndexedDB transaction failed')));
    });
  }
}
