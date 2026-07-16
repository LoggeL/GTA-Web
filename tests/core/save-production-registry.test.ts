import { describe, expect, it } from 'vitest';

import { GAME_SAVE_VALIDATION_REGISTRY } from '../../src/app/save-validation-registry';
import {
  CoreSaveService,
  InMemorySaveAdapter,
  createInitialSaveGame,
  serializeSaveGame,
} from '../../src/core';
import {
  ACTIVITIES,
  COLLECTIBLES,
  ITEMS,
  MISSIONS,
  PROPERTIES,
  RECIPES,
  SKILL_NODES,
  VEHICLES,
} from '../../src/data';

describe('production save validation registry', () => {
  it('contains every authoritative persisted-definition registry', () => {
    const cases = [
      [GAME_SAVE_VALIDATION_REGISTRY.itemIds, ITEMS],
      [GAME_SAVE_VALIDATION_REGISTRY.skillIds, SKILL_NODES],
      [GAME_SAVE_VALIDATION_REGISTRY.vehicleIds, VEHICLES],
      [GAME_SAVE_VALIDATION_REGISTRY.missionIds, MISSIONS],
      [GAME_SAVE_VALIDATION_REGISTRY.propertyIds, PROPERTIES],
      [GAME_SAVE_VALIDATION_REGISTRY.activityIds, ACTIVITIES],
      [GAME_SAVE_VALIDATION_REGISTRY.collectibleIds, COLLECTIBLES],
      [GAME_SAVE_VALIDATION_REGISTRY.recipeIds, RECIPES],
    ] as const;

    for (const [registry, definitions] of cases) {
      expect(registry).toBeDefined();
      expect(registry?.size).toBe(definitions.length);
      expect(definitions.every(({ id }) => registry?.has(id))).toBe(true);
    }
  });

  it('rejects a checksummed import with an unknown production registry id', () => {
    const service = new CoreSaveService(
      new InMemorySaveAdapter(),
      GAME_SAVE_VALIDATION_REGISTRY,
    );
    const save = createInitialSaveGame(1, 'masculine', {
      timestamp: 1_000,
      seed: 'production-registry-test',
    });
    save.player.unlockedSkills = ['unknown-production-skill'];

    const result = service.inspectImport(serializeSaveGame(save, true));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join(' ')).toContain('unknown-production-skill');
    }
  });

  it('rejects checksummed imports with malformed nested runtime snapshots', () => {
    const service = new CoreSaveService(
      new InMemorySaveAdapter(),
      GAME_SAVE_VALIDATION_REGISTRY,
    );
    const missionSave = createInitialSaveGame(1, 'masculine', {
      timestamp: 1_000,
      seed: 'production-mission-runtime-test',
    });
    missionSave.missionRuntime = {
      snapshotVersion: 1,
      campaign: {},
      active: null,
    };
    const dialogueSave = createInitialSaveGame(2, 'feminine', {
      timestamp: 1_000,
      seed: 'production-dialogue-runtime-test',
    });
    dialogueSave.dialogueRuntime = {
      snapshotVersion: 2,
      status: 'playing',
      requestedKeys: [],
      lineKeys: [],
      missingKeys: [],
      reviewedKeys: [],
      index: 0,
    };

    const missionResult = service.inspectImport(serializeSaveGame(missionSave, true));
    const dialogueResult = service.inspectImport(serializeSaveGame(dialogueSave, true));

    expect(missionResult.success).toBe(false);
    expect(dialogueResult.success).toBe(false);
    if (!missionResult.success) {
      expect(missionResult.errors.join(' ')).toContain('missionRuntime is invalid');
    }
    if (!dialogueResult.success) {
      expect(dialogueResult.errors.join(' ')).toContain('dialogueRuntime is invalid');
    }
  });
});
