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
    save.inventory.items.push({
      instanceId: 'carry-sidearm',
      definitionId: 'test-sidearm',
      quantity: 1,
      durability: 87,
      x: 0,
      y: 0,
      rotated: false,
    });
    save.quickLoadout.firearms[0] = 'carry-sidearm';
    save.unlockedRecipes.push('test-recipe');
    const serialized = serializeSaveGame(save);

    const parsed = parseSaveGame(serialized, {
      itemIds: new Set(['test-sidearm']),
      recipeIds: new Set(['test-recipe']),
    });
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

  it('migrates Preview 1 schema saves through v4 with M4, M5, and M6 defaults', () => {
    const current = createInitialSaveGame(2, 'feminine');
    const legacy: Record<string, unknown> = { ...current, schemaVersion: 1 };
    delete legacy.wanted;
    delete legacy.quickLoadout;
    delete legacy.unlockedRecipes;
    delete legacy.missionRuntime;
    delete legacy.dialogueRuntime;

    const migrated = migrateSaveGame(legacy);

    expect(migrated.success).toBe(true);
    if (migrated.success) {
      expect(migrated.migratedFrom).toBe(1);
      expect(migrated.save.schemaVersion).toBe(4);
      expect(migrated.save.wanted).toEqual({
        level: 0,
        phase: 'clear',
        heat: 0,
        searchSecondsRemaining: 0,
      });
      expect(migrated.save.quickLoadout).toEqual({
        firearms: [null, null],
        melee: null,
        consumables: [null, null],
      });
      expect(migrated.save.unlockedRecipes).toEqual([]);
      expect(migrated.save.missionRuntime).toBeNull();
      expect(migrated.save.dialogueRuntime).toBeNull();
    }
  });

  it('migrates Preview 2 schema saves with independent M5 and M6 defaults', () => {
    const current = createInitialSaveGame(1, 'masculine');
    const legacy: Record<string, unknown> = {
      ...current,
      schemaVersion: 2,
      wanted: {
        level: 2,
        phase: 'pursuit',
        heat: 41,
        searchSecondsRemaining: 0,
      },
    };
    delete legacy.quickLoadout;
    delete legacy.unlockedRecipes;
    delete legacy.missionRuntime;
    delete legacy.dialogueRuntime;

    const migrated = migrateSaveGame(legacy);

    expect(migrated.success).toBe(true);
    if (migrated.success) {
      expect(migrated.migratedFrom).toBe(2);
      expect(migrated.save.schemaVersion).toBe(4);
      expect(migrated.save.wanted).toEqual(legacy.wanted);
      expect(migrated.save.quickLoadout).toEqual({
        firearms: [null, null],
        melee: null,
        consumables: [null, null],
      });
      expect(migrated.save.unlockedRecipes).toEqual([]);
      expect(migrated.save.missionRuntime).toBeNull();
      expect(migrated.save.dialogueRuntime).toBeNull();
      migrated.save.quickLoadout.firearms[0] = 'changed-after-migration';
      migrated.save.unlockedRecipes.push('changed-after-migration');
      expect(legacy).not.toHaveProperty('quickLoadout');
      expect(legacy).not.toHaveProperty('unlockedRecipes');
      expect(legacy).not.toHaveProperty('missionRuntime');
      expect(legacy).not.toHaveProperty('dialogueRuntime');
    }
  });

  it('migrates Preview 2.1 saves and validates the M6 runtime snapshot boundaries', () => {
    const current = createInitialSaveGame(1, 'masculine');
    current.missions['past-due'] = {
      state: 'active',
      checkpointId: 'past-due:garage-defense',
      completedObjectives: [],
    };
    const legacy: Record<string, unknown> = { ...current, schemaVersion: 3 };
    delete legacy.missionRuntime;
    delete legacy.dialogueRuntime;

    const migrated = migrateSaveGame(legacy);
    expect(migrated.success).toBe(true);
    if (migrated.success) {
      expect(migrated.migratedFrom).toBe(3);
      expect(migrated.save.schemaVersion).toBe(4);
      expect(migrated.save.missionRuntime).toBeNull();
      expect(migrated.save.dialogueRuntime).toBeNull();
      expect(migrated.save.missions['past-due']?.state).toBe('available');
      expect(current.missions['past-due']?.state).toBe('active');
    }

    const malformed = createInitialSaveGame(1, 'masculine');
    malformed.missionRuntime = { snapshotVersion: 99, campaign: {}, active: null };
    const validation = validateSaveGame(malformed);
    expect(validation.valid).toBe(false);
    if (!validation.valid) {
      expect(validation.errors).toContain('missionRuntime.snapshotVersion must equal 1');
    }

    const legacyDialogue = createInitialSaveGame(1, 'masculine');
    legacyDialogue.dialogueRuntime = { snapshotVersion: 1 };
    expect(validateSaveGame(legacyDialogue).valid).toBe(true);

    const currentDialogue = createInitialSaveGame(1, 'masculine');
    currentDialogue.dialogueRuntime = { snapshotVersion: 2 };
    expect(validateSaveGame(currentDialogue).valid).toBe(true);

    const malformedDialogue = createInitialSaveGame(1, 'masculine');
    malformedDialogue.dialogueRuntime = { snapshotVersion: 99 };
    const dialogueValidation = validateSaveGame(malformedDialogue);
    expect(dialogueValidation.valid).toBe(false);
    if (!dialogueValidation.valid) {
      expect(dialogueValidation.errors).toContain(
        'dialogueRuntime.snapshotVersion must equal 1 or 2',
      );
    }
  });

  it('rejects mission projections that disagree with the runtime restored on Continue', () => {
    const missingRuntime = createInitialSaveGame(1, 'masculine');
    missingRuntime.missions['past-due'] = {
      state: 'active',
      checkpointId: null,
      completedObjectives: [],
    };
    const missingRuntimeValidation = validateSaveGame(missingRuntime);
    expect(missingRuntimeValidation.valid).toBe(false);
    if (!missingRuntimeValidation.valid) {
      expect(missingRuntimeValidation.errors.join(' ')).toContain(
        'must match missionRuntime.campaign.activeMissionId null',
      );
    }

    const multipleActive = createInitialSaveGame(1, 'masculine');
    multipleActive.missions.first = {
      state: 'active',
      checkpointId: null,
      completedObjectives: [],
    };
    multipleActive.missions.second = {
      state: 'active',
      checkpointId: null,
      completedObjectives: [],
    };
    const multipleActiveValidation = validateSaveGame(multipleActive);
    expect(multipleActiveValidation.valid).toBe(false);
    if (!multipleActiveValidation.valid) {
      expect(multipleActiveValidation.errors).toContain(
        'missions must contain at most one active mission',
      );
    }

    const matched = createInitialSaveGame(1, 'masculine');
    matched.missions['past-due'] = {
      state: 'active',
      checkpointId: null,
      completedObjectives: [],
    };
    matched.missionRuntime = {
      snapshotVersion: 1,
      campaign: { activeMissionId: 'past-due' },
      active: { missionId: 'past-due' },
    };
    expect(validateSaveGame(matched).valid).toBe(true);
  });

  it('validates quick-loadout references and unlocked recipe ids', () => {
    const save = createInitialSaveGame(1, 'masculine');
    save.inventory.items.push({
      instanceId: 'carried-1',
      definitionId: 'sidearm',
      quantity: 1,
      durability: 100,
      x: 0,
      y: 0,
      rotated: false,
    });
    save.quickLoadout.firearms = ['carried-1', 'carried-1'];
    save.quickLoadout.melee = 'stash-only';
    save.quickLoadout.consumables = ['', null];
    save.stash.push({
      instanceId: 'stash-only',
      definitionId: 'knife',
      quantity: 1,
      durability: 100,
      x: 0,
      y: 0,
      rotated: false,
    });
    save.unlockedRecipes = ['known-recipe', 'known-recipe', 'unknown-recipe'];

    const result = validateSaveGame(save, {
      itemIds: new Set(['sidearm', 'knife']),
      recipeIds: new Set(['known-recipe']),
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('quickLoadout cannot assign'),
        expect.stringContaining('quickLoadout reference "stash-only"'),
        expect.stringContaining('quickLoadout.consumables[0]'),
        expect.stringContaining('unlockedRecipes[1] must be unique'),
        expect.stringContaining('unknown-recipe'),
      ]));
    }
  });

  it('does not launder malformed v2 M5 fields during migration', () => {
    const current = createInitialSaveGame(1, 'masculine');
    const malformed = {
      ...current,
      schemaVersion: 2,
      quickLoadout: null,
      unlockedRecipes: null,
    };

    const migrated = migrateSaveGame(malformed);

    expect(migrated.success).toBe(false);
    if (!migrated.success) {
      expect(migrated.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('quickLoadout must be an object'),
        expect.stringContaining('unlockedRecipes must be an array'),
      ]));
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
  it('round-trips a nonempty owned-vehicle trunk without losing cargo placement', async () => {
    const service = new CoreSaveService(new InMemorySaveAdapter());
    const save = createInitialSaveGame(2, 'masculine', { timestamp: 42 });
    save.ownedVehicles.push({
      instanceId: 'save-trunk-car',
      definitionId: 'compact',
      registered: true,
      garageSlot: 0,
      bodyHealth: 83,
      engineHealth: 71,
      tireHealth: [100, 90, 80, 70],
      upgrades: { engine: 1, brakes: 2, grip: 0, armor: 1, paint: 'coastal-teal' },
    });
    save.trunks['save-trunk-car'] = {
      gridWidth: 6,
      gridHeight: 4,
      maxWeightKg: 192,
      items: [{
        instanceId: 'trunk-ammo-001',
        definitionId: 'ammo-handgun',
        quantity: 24,
        durability: 100,
        x: 2,
        y: 1,
        rotated: false,
      }],
    };

    await service.saveSlot(save);
    save.trunks['save-trunk-car']!.items[0]!.quantity = 1;
    const loaded = await service.loadSlot(2);

    expect(loaded?.save.ownedVehicles[0]).toEqual(expect.objectContaining({
      instanceId: 'save-trunk-car',
      upgrades: expect.objectContaining({ paint: 'coastal-teal' }),
    }));
    expect(loaded?.save.trunks['save-trunk-car']).toEqual({
      gridWidth: 6,
      gridHeight: 4,
      maxWeightKg: 192,
      items: [{
        instanceId: 'trunk-ammo-001',
        definitionId: 'ammo-handgun',
        quantity: 24,
        durability: 100,
        x: 2,
        y: 1,
        rotated: false,
      }],
    });
  });

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
