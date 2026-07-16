import { describe, expect, it } from 'vitest';

import {
  SAVE_CHECKSUM_ALGORITHM,
  SAVE_EXPORT_FORMAT,
  SAVE_EXPORT_FORMAT_VERSION,
  computeChecksum,
  parseSaveGame,
  type SaveEnvelopeV1,
} from '../../src/core/save-format';
import {
  CoreSaveService,
  InMemorySaveAdapter,
  PersistenceWriteError,
  SaveSlotReadError,
} from '../../src/core/save-service';
import {
  SAVE_GAME_VERSION,
  createInitialSaveGame,
  type SaveSlotId,
} from '../../src/core/state';

class GatedSaveAdapter extends InMemorySaveAdapter {
  private nextWriteGate: {
    started: () => void;
    wait: Promise<void>;
  } | null = null;

  public gateNextWrite(): { started: Promise<void>; release: () => void } {
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextWriteGate = { started: markStarted, wait };
    return { started, release };
  }

  public override async writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
  ): Promise<void> {
    const gate = this.nextWriteGate;
    this.nextWriteGate = null;
    if (gate) {
      gate.started();
      await gate.wait;
    }
    await super.writeSlotAtomic(slotId, active, backup);
  }
}

class FailingSaveAdapter extends InMemorySaveAdapter {
  private nextWriteFailure: unknown | undefined;

  public failNextWrite(error: unknown): void {
    this.nextWriteFailure = error;
  }

  public override async writeSlotAtomic(
    slotId: SaveSlotId,
    active: SaveEnvelopeV1,
    backup: SaveEnvelopeV1 | null,
  ): Promise<void> {
    if (this.nextWriteFailure !== undefined) {
      const error = this.nextWriteFailure;
      this.nextWriteFailure = undefined;
      throw error;
    }
    await super.writeSlotAtomic(slotId, active, backup);
  }
}

describe('CoreSaveService persistence safety', () => {
  it('serializes overlapping autosaves so the backup is the immediately previous good save', async () => {
    const adapter = new GatedSaveAdapter();
    const service = new CoreSaveService(adapter);
    const first = createSaveWithMoney(1, 10, 1);
    const second = createSaveWithMoney(1, 20, 2);
    const third = createSaveWithMoney(1, 30, 3);
    await service.saveSlot(first);

    const gate = adapter.gateNextWrite();
    const secondWrite = service.saveSlot(second);
    await gate.started;
    const thirdWrite = service.saveSlot(third);
    gate.release();
    await Promise.all([secondWrite, thirdWrite]);

    const record = await adapter.readSlot(1);
    expect(readEnvelopeMoney(record?.active)).toBe(30);
    expect(readEnvelopeMoney(record?.backup)).toBe(20);

    if (!record || record.backup === null) throw new Error('expected active and backup saves');
    const corruptActive = record.active as SaveEnvelopeV1;
    corruptActive.payload.player.money = 999;
    await adapter.writeSlotAtomic(1, corruptActive, record.backup as SaveEnvelopeV1);
    await expect(service.loadSlot(1)).resolves.toMatchObject({
      recoveredFromBackup: true,
      save: { player: { money: 20 } },
    });
  });

  it('preserves committed snapshots and provides a valid emergency export on quota failure', async () => {
    const adapter = new FailingSaveAdapter();
    const service = new CoreSaveService(adapter);
    await service.saveSlot(createSaveWithMoney(1, 10, 1));
    await service.saveSlot(createSaveWithMoney(1, 20, 2));
    const committedBeforeFailure = await adapter.readSlot(1);

    const quotaError = new Error('browser storage quota is full');
    quotaError.name = 'QuotaExceededError';
    adapter.failNextWrite(quotaError);

    let failure: unknown;
    try {
      await service.saveSlot(createSaveWithMoney(1, 30, 3));
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(PersistenceWriteError);
    const writeError = failure as PersistenceWriteError;
    expect(writeError).toMatchObject({
      code: 'quota-exceeded',
      operation: 'save-slot',
      slotId: 1,
    });
    expect(writeError.cause).toBe(quotaError);
    expect(writeError.emergencyExport).not.toBeNull();
    const emergency = parseSaveGame(writeError.emergencyExport ?? '');
    expect(emergency.success && emergency.save.player.money).toBe(30);
    expect(await adapter.readSlot(1)).toEqual(committedBeforeFailure);

    const committed = await service.loadSlot(1);
    expect(committed?.save.player.money).toBe(20);
    expect(committed?.recoveredFromBackup).toBe(false);

    if (!committedBeforeFailure || committedBeforeFailure.backup === null) {
      throw new Error('expected committed active and backup saves');
    }
    const corruptActive = committedBeforeFailure.active as SaveEnvelopeV1;
    corruptActive.payload.player.money = 999;
    await adapter.writeSlotAtomic(
      1,
      corruptActive,
      committedBeforeFailure.backup as SaveEnvelopeV1,
    );
    expect((await service.loadSlot(1))?.save.player.money).toBe(10);
  });

  it('classifies ordinary write failures without discarding a checksummed rescue export', async () => {
    const adapter = new FailingSaveAdapter();
    const service = new CoreSaveService(adapter);
    adapter.failNextWrite(new Error('disk was disconnected'));

    await expect(service.saveSlot(createSaveWithMoney(2, 55, 1))).rejects.toMatchObject({
      name: 'PersistenceWriteError',
      code: 'storage-write-failed',
      operation: 'save-slot',
      slotId: 2,
      emergencyExport: expect.stringContaining(SAVE_EXPORT_FORMAT),
    });
    await expect(service.loadSlot(2)).resolves.toBeNull();
  });

  it('rejects future-version imports before touching the destination slot', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    await service.saveSlot(createSaveWithMoney(2, 44, 1));
    const destinationBeforeImport = await adapter.readSlot(2);
    const futureEnvelope = createFutureEnvelope(1, 88);
    const serialized = JSON.stringify(futureEnvelope);

    const inspection = service.inspectImport(serialized);
    expect(inspection.success).toBe(false);
    if (!inspection.success) {
      expect(inspection.errors).toContain(
        `save schema version ${SAVE_GAME_VERSION + 1} is newer than supported version ${SAVE_GAME_VERSION}`,
      );
    }
    await expect(service.importIntoSlot(serialized, 2, 100)).rejects.toThrow('newer than supported');
    expect(await adapter.readSlot(2)).toEqual(destinationBeforeImport);
    expect((await service.loadSlot(2))?.save.player.money).toBe(44);
  });

  it('preserves an intact future-version stored snapshot while failing safely', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const futureEnvelope = createFutureEnvelope(3, 77);
    await adapter.writeSlotAtomic(3, futureEnvelope, null);
    const storedBeforeLoad = await adapter.readSlot(3);

    expect((await service.listSlots())[2]).toEqual({
      slotId: 3,
      status: 'corrupt',
      metadata: null,
    });

    let failure: unknown;
    try {
      await service.loadSlot(3);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SaveSlotReadError);
    const readError = failure as SaveSlotReadError;
    expect(readError).toMatchObject({
      code: 'unsupported-version',
      slotId: 3,
    });
    expect(JSON.parse(readError.preservedSnapshot ?? '{}')).toEqual(futureEnvelope);
    expect(await adapter.readSlot(3)).toEqual(storedBeforeLoad);
  });

  it('does not recover past or overwrite an intact future active snapshot', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const futureEnvelope = createFutureEnvelope(1, 77);
    const olderBackup = createSaveEnvelopeForTest(createSaveWithMoney(1, 11, 1));
    await adapter.writeSlotAtomic(1, futureEnvelope, olderBackup);
    const storedBeforeOperations = await adapter.readSlot(1);

    expect((await service.listSlots())[0]?.status).toBe('corrupt');
    await expect(service.loadSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
    });
    await expect(service.saveSlot(createSaveWithMoney(1, 22, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
    });
    expect(await adapter.readSlot(1)).toEqual(storedBeforeOperations);

    await service.deleteSlot(1);
    await service.saveSlot(createSaveWithMoney(1, 22, 2));
    expect((await service.loadSlot(1))?.save.player.money).toBe(22);
  });

  it('does not misclassify a tampered future-version claim as a preservable export', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const tampered = createFutureEnvelope(1, 12);
    (tampered.payload as unknown as { player: { money: number } }).player.money = 999;
    await adapter.writeSlotAtomic(1, tampered, null);
    const storedBeforeLoad = await adapter.readSlot(1);

    await expect(service.loadSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
      preservedSnapshot: null,
    });
    expect(await adapter.readSlot(1)).toEqual(storedBeforeLoad);
  });
});

function createSaveWithMoney(slotId: SaveSlotId, money: number, timestamp: number) {
  const save = createInitialSaveGame(slotId, 'masculine', { timestamp });
  save.player.money = money;
  return save;
}

function readEnvelopeMoney(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('payload' in value)) return null;
  const envelope = value as SaveEnvelopeV1;
  return envelope.payload.player.money;
}

function createFutureEnvelope(slotId: SaveSlotId, money: number): SaveEnvelopeV1 {
  const current = createSaveWithMoney(slotId, money, 1);
  const payload = JSON.parse(JSON.stringify(current)) as unknown as Record<string, unknown>;
  payload.schemaVersion = SAVE_GAME_VERSION + 1;
  return {
    format: SAVE_EXPORT_FORMAT,
    formatVersion: SAVE_EXPORT_FORMAT_VERSION,
    checksum: {
      algorithm: SAVE_CHECKSUM_ALGORITHM,
      value: computeChecksum(payload),
    },
    payload,
  } as unknown as SaveEnvelopeV1;
}

function createSaveEnvelopeForTest(save: ReturnType<typeof createInitialSaveGame>): SaveEnvelopeV1 {
  const payload = JSON.parse(JSON.stringify(save)) as ReturnType<typeof createInitialSaveGame>;
  return {
    format: SAVE_EXPORT_FORMAT,
    formatVersion: SAVE_EXPORT_FORMAT_VERSION,
    checksum: {
      algorithm: SAVE_CHECKSUM_ALGORITHM,
      value: computeChecksum(payload),
    },
    payload,
  };
}
