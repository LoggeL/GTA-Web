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
    expectedRevision?: number,
  ): Promise<boolean> {
    const gate = this.nextWriteGate;
    this.nextWriteGate = null;
    if (gate) {
      gate.started();
      await gate.wait;
    }
    return super.writeSlotAtomic(slotId, active, backup, expectedRevision);
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
    expectedRevision?: number,
  ): Promise<boolean> {
    if (this.nextWriteFailure !== undefined) {
      const error = this.nextWriteFailure;
      this.nextWriteFailure = undefined;
      throw error;
    }
    return super.writeSlotAtomic(slotId, active, backup, expectedRevision);
  }
}

describe('CoreSaveService persistence safety', () => {
  it('exposes previews only from checksummed, fully validated active or backup saves', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const first = createInitialSaveGame(2, 'feminine', {
      timestamp: 41,
      label: 'Coastal run',
    });
    first.player.level = 6;
    first.activeDistrict = 'neon-strand';
    first.playtimeSeconds = 3_721;
    first.missions['dock-run'] = {
      state: 'available',
      checkpointId: null,
      completedObjectives: [],
    };
    first.missions['coastal-heat'] = {
      state: 'active',
      checkpointId: 'reach-pier',
      completedObjectives: [],
    };
    first.missionRuntime = {
      snapshotVersion: 1,
      campaign: { activeMissionId: 'coastal-heat' },
      active: { missionId: 'coastal-heat' },
    };
    await service.saveSlot(first);

    expect((await service.listSlots())[1]).toEqual({
      slotId: 2,
      status: 'ready',
      metadata: {
        id: 2,
        label: 'Coastal run',
        createdAt: 41,
        updatedAt: 41,
      },
      preview: {
        label: 'Coastal run',
        updatedAt: 41,
        alexPreset: 'feminine',
        level: 6,
        activeMissionId: 'coastal-heat',
        activeDistrict: 'neon-strand',
        playtimeSeconds: 3_721,
      },
    });

    const second = createSaveWithMoney(2, 90, 42);
    second.player.level = 19;
    second.activeDistrict = 'breakwater';
    await service.saveSlot(second);
    const record = await adapter.readSlot(2);
    if (!record || record.backup === null) throw new Error('expected a backup generation');
    const tamperedActive = record.active as SaveEnvelopeV1;
    tamperedActive.payload.player.level = 20;
    await adapter.writeSlotAtomic(2, tamperedActive, record.backup as SaveEnvelopeV1);

    expect((await service.listSlots())[1]).toMatchObject({
      status: 'recovered',
      preview: {
        label: 'Coastal run',
        updatedAt: 41,
        alexPreset: 'feminine',
        level: 6,
        activeMissionId: 'coastal-heat',
        activeDistrict: 'neon-strand',
        playtimeSeconds: 3_721,
      },
    });
  });

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

  it('retries a cross-service conflict so active and backup are the two newest commits', async () => {
    const adapter = new GatedSaveAdapter();
    const firstService = new CoreSaveService(adapter);
    const secondService = new CoreSaveService(adapter);
    await firstService.saveSlot(createSaveWithMoney(1, 10, 1));

    const gate = adapter.gateNextWrite();
    const firstTabWrite = firstService.saveSlot(createSaveWithMoney(1, 20, 2));
    await gate.started;
    const secondTabWrite = secondService.saveSlot(createSaveWithMoney(1, 30, 3));
    await secondTabWrite;
    gate.release();
    await firstTabWrite;

    const record = await adapter.readSlot(1);
    expect(readEnvelopeMoney(record?.active)).toBe(20);
    expect(readEnvelopeMoney(record?.backup)).toBe(30);
    expect(readEnvelopeMoney(record?.backup)).not.toBe(10);
    expect(record?.revision).toBe(3);
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
      status: 'unsupported-version',
      metadata: null,
      preview: null,
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
    const preservedSerialization = JSON.stringify(futureEnvelope, null, 2);
    expect(readError.preservedSnapshot).toBe(preservedSerialization);
    await expect(service.exportSlot(3)).resolves.toBe(preservedSerialization);
    await expect(service.saveSlot(createSaveWithMoney(3, 99, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
      preservedSnapshot: preservedSerialization,
    });
    expect(await adapter.readSlot(3)).toEqual(storedBeforeLoad);
  });

  it('does not recover past or overwrite an intact future active snapshot', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const futureEnvelope = createFutureEnvelope(1, 77);
    const olderBackup = createSaveEnvelopeForTest(createSaveWithMoney(1, 11, 1));
    await adapter.writeSlotAtomic(1, futureEnvelope, olderBackup);
    const storedBeforeOperations = await adapter.readSlot(1);

    expect((await service.listSlots())[0]).toMatchObject({
      status: 'unsupported-version',
      preview: null,
    });
    await expect(service.loadSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
    });
    await expect(service.exportSlot(1)).resolves.toBe(JSON.stringify(futureEnvelope, null, 2));
    await expect(service.saveSlot(createSaveWithMoney(1, 22, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
    });
    expect(await adapter.readSlot(1)).toEqual(storedBeforeOperations);

    await service.deleteSlot(1);
    await service.saveSlot(createSaveWithMoney(1, 22, 2));
    expect((await service.loadSlot(1))?.save.player.money).toBe(22);
  });

  it('preflights an intact future backup before exposing a valid active generation', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const currentActive = createSaveEnvelopeForTest(createSaveWithMoney(2, 31, 1));
    const futureBackup = createFutureEnvelope(2, 88);
    const futureSerialization = JSON.stringify(futureBackup, null, 2);
    await adapter.writeSlotAtomic(2, currentActive, futureBackup);
    const storedBeforeOperations = await adapter.readSlot(2);

    expect((await service.listSlots())[1]).toEqual({
      slotId: 2,
      status: 'unsupported-version',
      metadata: null,
      preview: null,
    });
    await expect(service.loadSlot(2)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
      preservedSnapshot: futureSerialization,
    });
    await expect(service.exportSlot(2)).resolves.toBe(futureSerialization);
    await expect(service.saveSlot(createSaveWithMoney(2, 44, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'unsupported-version',
    });
    expect(await adapter.readSlot(2)).toEqual(storedBeforeOperations);
  });

  it('refuses every destructive path for unrecoverable corruption until explicit deletion', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const corrupt = createSaveEnvelopeForTest(createSaveWithMoney(1, 12, 1));
    corrupt.payload.player.money = 999;
    await adapter.writeSlotAtomic(1, corrupt, null);
    const storedBeforeOperations = await adapter.readSlot(1);
    const importSource = JSON.stringify(
      createSaveEnvelopeForTest(createSaveWithMoney(2, 55, 4)),
      null,
      2,
    );

    expect((await service.listSlots())[0]).toEqual({
      slotId: 1,
      status: 'corrupt',
      metadata: null,
      preview: null,
    });
    await expect(service.loadSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
      slotId: 1,
      preservedSnapshot: null,
    });
    await expect(service.exportSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
    });
    await expect(service.saveSlot(createSaveWithMoney(1, 22, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
    });
    await expect(service.importIntoSlot(importSource, 1, 5)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
    });
    expect(await adapter.readSlot(1)).toEqual(storedBeforeOperations);

    await service.deleteSlot(1);
    await service.importIntoSlot(importSource, 1, 6);
    expect((await service.loadSlot(1))?.save.player.money).toBe(55);
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
    await expect(service.exportSlot(1)).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
      preservedSnapshot: null,
    });
    await expect(service.saveSlot(createSaveWithMoney(1, 25, 2))).rejects.toMatchObject({
      name: 'SaveSlotReadError',
      code: 'corrupt',
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
