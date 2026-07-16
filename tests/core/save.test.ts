import { describe, expect, it } from 'vitest';

import {
  SAVE_CHECKSUM_ALGORITHM,
  SAVE_EXPORT_FORMAT,
  SAVE_EXPORT_FORMAT_VERSION,
  canonicalStringify,
  computeChecksum,
  createSaveEnvelope,
  migrateSaveGame,
  parseSaveGame,
  serializeSaveGame,
  validateSaveEnvelope,
  type SaveEnvelopeV1,
} from '../../src/core/save-format';
import { CoreSaveService, InMemorySaveAdapter } from '../../src/core/save-service';
import { validateSaveGame } from '../../src/core/save-validation';
import { createDefaultSettings } from '../../src/core/settings';
import { createInitialSaveGame } from '../../src/core/state';

describe('save validation and format', () => {
  it('accepts initial state and reports range and registry violations', () => {
    const save = createInitialSaveGame(1, 'masculine');
    expect(validateSaveGame(save).valid).toBe(true);

    save.player.level = 21;
    save.player.unlockedSkills.push('missing-skill');
    const result = validateSaveGame(save, { skillIds: new Set(['steady-hands']) });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('player.level'),
        expect.stringContaining('missing-skill'),
      ]));
    }
  });

  it('canonicalizes object keys and detects envelope tampering', () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe(canonicalStringify({ a: 1, b: 2 }));
    expect(computeChecksum({ b: 2, a: 1 })).toBe(computeChecksum({ a: 1, b: 2 }));

    const envelope = createSaveEnvelope(createInitialSaveGame(1, 'masculine'));
    envelope.payload.player.money = 500;
    const result = validateSaveEnvelope(envelope);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain('checksum');
    }
  });

  it('round-trips exports and rejects malformed JSON', () => {
    const save = createInitialSaveGame(3, 'feminine', { timestamp: 7 });
    save.player.money = 250;
    const serialized = serializeSaveGame(save);

    const parsed = parseSaveGame(serialized);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.save).toEqual(save);
      expect(parsed.migratedFrom).toBeNull();
    }
    expect(parseSaveGame('{nope').success).toBe(false);
  });

  it('migrates version-zero payloads before validating them', () => {
    const current = createInitialSaveGame(1, 'masculine');
    const player: Record<string, unknown> = { ...current.player };
    delete player.lastSafeTransform;
    const legacy: Record<string, unknown> = {
      ...current,
      schemaVersion: 0,
      player,
    };
    delete legacy.ending;
    delete legacy.worldFlags;
    delete legacy.playtimeSeconds;

    const migrated = migrateSaveGame(legacy);

    expect(migrated.success).toBe(true);
    if (migrated.success) {
      expect(migrated.migratedFrom).toBe(0);
      expect(migrated.save.ending).toBeNull();
      expect(migrated.save.player.lastSafeTransform).toEqual(current.player.transform);
    }
  });

  it('verifies legacy envelopes before migration', () => {
    const current = createInitialSaveGame(1, 'masculine');
    const legacy = { ...current, schemaVersion: 0 };
    const envelope = {
      format: SAVE_EXPORT_FORMAT,
      formatVersion: SAVE_EXPORT_FORMAT_VERSION,
      checksum: {
        algorithm: SAVE_CHECKSUM_ALGORITHM,
        value: computeChecksum(legacy),
      },
      payload: legacy,
    };

    const result = validateSaveEnvelope(envelope);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.migratedFrom).toBe(0);
    }
  });
});

describe('CoreSaveService', () => {
  it('persists defensive copies and retains the previous good snapshot', async () => {
    const adapter = new InMemorySaveAdapter();
    const service = new CoreSaveService(adapter);
    const first = createInitialSaveGame(1, 'masculine', { timestamp: 1 });
    first.player.money = 10;
    await service.saveSlot(first);

    const second = createInitialSaveGame(1, 'masculine', { timestamp: 2 });
    second.player.money = 20;
    await service.saveSlot(second);
    second.player.money = 999;

    const loaded = await service.loadSlot(1);
    expect(loaded?.save.player.money).toBe(20);
    expect(loaded?.recoveredFromBackup).toBe(false);

    const record = await adapter.readSlot(1);
    if (!record || record.backup === null) {
      throw new Error('expected active and backup snapshots');
    }
    const corruptActive = record.active as SaveEnvelopeV1;
    const backup = record.backup as SaveEnvelopeV1;
    corruptActive.payload.player.money = 777;
    await adapter.writeSlotAtomic(1, corruptActive, backup);

    const recovered = await service.loadSlot(1);
    expect(recovered?.recoveredFromBackup).toBe(true);
    expect(recovered?.save.player.money).toBe(10);
    expect((await service.listSlots())[0]?.status).toBe('recovered');
  });

  it('loads defaults, saves settings, exports, and imports to another slot', async () => {
    const service = new CoreSaveService(new InMemorySaveAdapter());
    await service.initialize();
    expect(await service.loadSettings()).toEqual(createDefaultSettings());

    const settings = createDefaultSettings();
    settings.accessibility.reducedMotion = true;
    await service.saveSettings(settings);
    expect((await service.loadSettings()).accessibility.reducedMotion).toBe(true);

    const save = createInitialSaveGame(1, 'feminine', { timestamp: 5, label: 'Source' });
    save.player.money = 900;
    await service.saveSlot(save);
    const exported = await service.exportSlot(1);
    const imported = await service.importIntoSlot(exported, 3, 99);

    expect(imported.slot).toEqual({ id: 3, label: 'Source', createdAt: 99, updatedAt: 99 });
    expect(imported.player.money).toBe(900);
    expect((await service.loadSlot(3))?.save).toEqual(imported);
  });
});
