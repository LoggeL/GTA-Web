import { SAVE_GAME_VERSION, type SaveGameV1 } from './state';
import {
  validateSaveGame,
  type SaveValidationRegistry,
  type SaveValidationResult,
} from './save-validation';

export const SAVE_EXPORT_FORMAT = 'heatline-solara-save' as const;
export const SAVE_EXPORT_FORMAT_VERSION = 1 as const;
export const SAVE_CHECKSUM_ALGORITHM = 'fnv1a32' as const;

export interface SaveEnvelopeV1 {
  format: typeof SAVE_EXPORT_FORMAT;
  formatVersion: typeof SAVE_EXPORT_FORMAT_VERSION;
  checksum: {
    algorithm: typeof SAVE_CHECKSUM_ALGORITHM;
    value: string;
  };
  payload: SaveGameV1;
}

export type SaveMigrationResult =
  | { success: true; save: SaveGameV1; migratedFrom: number | null }
  | { success: false; errors: readonly string[] };

export type SaveImportResult =
  | { success: true; save: SaveGameV1; migratedFrom: number | null }
  | { success: false; errors: readonly string[] };

export interface SaveMigration {
  fromVersion: number;
  toVersion: number;
  apply(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export const DEFAULT_SAVE_MIGRATIONS: readonly SaveMigration[] = [
  {
    fromVersion: 0,
    toVersion: 1,
    apply: migrateVersionZero,
  },
  {
    fromVersion: 1,
    toVersion: 2,
    apply: migrateVersionOne,
  },
  {
    fromVersion: 2,
    toVersion: 3,
    apply: migrateVersionTwo,
  },
  {
    fromVersion: 3,
    toVersion: 4,
    apply: migrateVersionThree,
  },
];

/** Canonical JSON sorts object keys so checksum output is insertion-order independent. */
export function canonicalStringify(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

export function computeChecksum(value: unknown): string {
  const source = canonicalStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash.toString(16).padStart(8, '0');
}

export function createSaveEnvelope(save: SaveGameV1): SaveEnvelopeV1 {
  return {
    format: SAVE_EXPORT_FORMAT,
    formatVersion: SAVE_EXPORT_FORMAT_VERSION,
    checksum: {
      algorithm: SAVE_CHECKSUM_ALGORITHM,
      value: computeChecksum(save),
    },
    payload: cloneJson(save),
  };
}

export function validateSaveEnvelope(
  value: unknown,
  registry: SaveValidationRegistry = {},
): SaveImportResult {
  if (!isRecord(value)) {
    return { success: false, errors: ['save envelope must be an object'] };
  }
  if (value.format !== SAVE_EXPORT_FORMAT) {
    return { success: false, errors: [`save envelope format must be "${SAVE_EXPORT_FORMAT}"`] };
  }
  if (value.formatVersion !== SAVE_EXPORT_FORMAT_VERSION) {
    return { success: false, errors: ['save envelope format version is not supported'] };
  }
  if (!isRecord(value.checksum)) {
    return { success: false, errors: ['save envelope checksum must be an object'] };
  }
  if (value.checksum.algorithm !== SAVE_CHECKSUM_ALGORITHM) {
    return { success: false, errors: ['save envelope checksum algorithm is not supported'] };
  }
  if (typeof value.checksum.value !== 'string') {
    return { success: false, errors: ['save envelope checksum value must be a string'] };
  }

  let actualChecksum: string;
  try {
    actualChecksum = computeChecksum(value.payload);
  } catch (error: unknown) {
    return { success: false, errors: [`save payload is not serializable: ${errorMessage(error)}`] };
  }
  if (actualChecksum !== value.checksum.value) {
    return { success: false, errors: ['save checksum does not match its payload'] };
  }

  return migrateSaveGame(value.payload, registry);
}

export function serializeSaveGame(save: SaveGameV1, pretty = false): string {
  const envelope = createSaveEnvelope(save);
  return JSON.stringify(envelope, null, pretty ? 2 : undefined);
}

export function parseSaveGame(
  serialized: string,
  registry: SaveValidationRegistry = {},
): SaveImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    return { success: false, errors: [`save JSON could not be parsed: ${errorMessage(error)}`] };
  }
  return validateSaveEnvelope(parsed, registry);
}

export function migrateSaveGame(
  value: unknown,
  registry: SaveValidationRegistry = {},
  migrations: readonly SaveMigration[] = DEFAULT_SAVE_MIGRATIONS,
): SaveMigrationResult {
  if (!isRecord(value)) {
    return { success: false, errors: ['save payload must be an object'] };
  }

  const sourceVersion = readSchemaVersion(value);
  if (sourceVersion === null) {
    return { success: false, errors: ['save schemaVersion must be a non-negative integer'] };
  }
  if (sourceVersion > SAVE_GAME_VERSION) {
    return {
      success: false,
      errors: [`save schema version ${sourceVersion} is newer than supported version ${SAVE_GAME_VERSION}`],
    };
  }

  let currentVersion = sourceVersion;
  let current: Record<string, unknown> = { ...value };
  const visited = new Set<number>();

  try {
    while (currentVersion < SAVE_GAME_VERSION) {
      if (visited.has(currentVersion)) {
        return { success: false, errors: [`save migration cycle detected at version ${currentVersion}`] };
      }
      visited.add(currentVersion);
      const migration = migrations.find((candidate) => candidate.fromVersion === currentVersion);
      if (!migration || migration.toVersion <= currentVersion) {
        return { success: false, errors: [`no migration available from schema version ${currentVersion}`] };
      }
      current = migration.apply(current);
      currentVersion = migration.toVersion;
      current.schemaVersion = currentVersion;
    }
  } catch (error: unknown) {
    return { success: false, errors: [`save migration failed: ${errorMessage(error)}`] };
  }

  const validation: SaveValidationResult = validateSaveGame(current, registry);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }
  return {
    success: true,
    save: cloneJson(validation.save),
    migratedFrom: sourceVersion === SAVE_GAME_VERSION ? null : sourceVersion,
  };
}

function migrateVersionZero(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const player = isRecord(value.player) ? value.player : {};
  const transform = player.transform;
  return {
    ...value,
    schemaVersion: 1,
    player: {
      ...player,
      lastSafeTransform: player.lastSafeTransform ?? transform,
    },
    ending: value.ending ?? null,
    worldFlags: value.worldFlags ?? {},
    playtimeSeconds: value.playtimeSeconds ?? 0,
  };
}

function migrateVersionOne(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...value,
    schemaVersion: 2,
    wanted: value.wanted ?? {
      level: 0,
      phase: 'clear',
      heat: 0,
      searchSecondsRemaining: 0,
    },
  };
}

function migrateVersionTwo(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...value,
    schemaVersion: 3,
    quickLoadout: value.quickLoadout === undefined ? {
      firearms: [null, null],
      melee: null,
      consumables: [null, null],
    } : value.quickLoadout,
    unlockedRecipes: value.unlockedRecipes === undefined ? [] : value.unlockedRecipes,
  };
}

function migrateVersionThree(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...value,
    schemaVersion: 4,
    missionRuntime: value.missionRuntime === undefined ? null : value.missionRuntime,
    dialogueRuntime: value.dialogueRuntime === undefined ? null : value.dialogueRuntime,
  };
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, seen);
    const serialized = `[${value.map((entry) => canonicalize(entry, seen)).join(',')}]`;
    seen.delete(value);
    return serialized;
  }
  if (isRecord(value)) {
    assertNotCircular(value, seen);
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`);
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`unsupported value type: ${typeof value}`);
}

function assertNotCircular(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) {
    throw new TypeError('circular references are not serializable');
  }
  seen.add(value);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function readSchemaVersion(value: Readonly<Record<string, unknown>>): number | null {
  const version = value.schemaVersion;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? version
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
