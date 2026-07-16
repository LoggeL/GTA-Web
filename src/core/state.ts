import { SeededRandom, type RandomSeed } from './random';

export const GAME_STATE_VERSION = 1 as const;
export const SAVE_GAME_VERSION = 3 as const;

export type SaveSlotId = 1 | 2 | 3;
export type AlexPreset = 'masculine' | 'feminine';
export type EndingChoice = 'rule' | 'expose';
export type DistrictId = 'neon-strand' | 'alta-vista' | 'arroyo-heights' | 'breakwater';
export type WeatherKind = 'clear' | 'rain';
export type GameMode = 'boot' | 'menu' | 'loading' | 'playing' | 'paused';
export type MissionRuntimePhase = 'inactive' | 'active' | 'checkpoint' | 'complete' | 'failed';
export type WantedPhase = 'clear' | 'investigating' | 'pursuit' | 'search';

export interface Vector3State {
  x: number;
  y: number;
  z: number;
}

export interface RotationState {
  x: number;
  y: number;
  z: number;
}

export interface TransformState {
  position: Vector3State;
  rotation: RotationState;
}

export interface WorldClockState {
  elapsedSeconds: number;
  day: number;
  timeOfDayMinutes: number;
  weather: WeatherKind;
}

export interface RuntimePlayerState {
  transform: TransformState;
  health: number;
  maxHealth: number;
  armor: number;
  stamina: number;
  maxStamina: number;
  inVehicleId: string | null;
  isSafe: boolean;
}

export interface MissionRuntimeState {
  activeMissionId: string | null;
  objectiveId: string | null;
  checkpointId: string | null;
  phase: MissionRuntimePhase;
  objectiveProgress: Record<string, number>;
}

export interface WantedState {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  phase: WantedPhase;
  heat: number;
  searchSecondsRemaining: number;
}

/** Authoritative mutable simulation data. It deliberately contains no render objects. */
export interface GameState {
  stateVersion: typeof GAME_STATE_VERSION;
  mode: GameMode;
  clock: WorldClockState;
  player: RuntimePlayerState;
  activeDistrict: DistrictId;
  activeCellId: string;
  mission: MissionRuntimeState;
  worldFlags: Record<string, boolean>;
  trafficSeed: number;
  wanted: WantedState;
  settingsReference: 'global';
  dirty: boolean;
  lastSaveTimestamp: number | null;
}

export interface CharacterAttributes {
  grit: number;
  aim: number;
  handling: number;
  nerve: number;
  hustle: number;
}

export interface SavedItemInstance {
  instanceId: string;
  definitionId: string;
  quantity: number;
  durability: number;
  x: number;
  y: number;
  rotated: boolean;
}

export interface SavedInventory {
  gridWidth: number;
  gridHeight: number;
  maxWeightKg: number;
  items: SavedItemInstance[];
}

export interface SavedQuickLoadout {
  firearms: [string | null, string | null];
  melee: string | null;
  consumables: [string | null, string | null];
}

export interface SavedVehicle {
  instanceId: string;
  definitionId: string;
  registered: boolean;
  garageSlot: number;
  bodyHealth: number;
  engineHealth: number;
  tireHealth: [number, number, number, number];
  upgrades: {
    engine: number;
    brakes: number;
    grip: number;
    armor: number;
    paint: string;
  };
}

export interface SavedMissionProgress {
  state: 'locked' | 'available' | 'active' | 'complete';
  checkpointId: string | null;
  completedObjectives: string[];
}

export interface SavedProperty {
  owned: boolean;
  upgraded: boolean;
  uncollectedPayouts: number;
}

export interface SavedActivity {
  completions: number;
  cooldownUntil: number;
  bestScore: number | null;
  bestTimeSeconds: number | null;
}

export interface SaveSlotMetadata {
  id: SaveSlotId;
  label: string;
  createdAt: number;
  updatedAt: number;
}

export interface SaveGameV1 {
  schemaVersion: typeof SAVE_GAME_VERSION;
  slot: SaveSlotMetadata;
  alexPreset: AlexPreset;
  player: {
    transform: TransformState;
    lastSafeTransform: TransformState;
    health: number;
    armor: number;
    money: number;
    level: number;
    xp: number;
    attributePoints: number;
    skillPoints: number;
    attributes: CharacterAttributes;
    unlockedSkills: string[];
  };
  inventory: SavedInventory;
  stash: SavedItemInstance[];
  trunks: Record<string, SavedInventory>;
  quickLoadout: SavedQuickLoadout;
  unlockedRecipes: string[];
  ownedVehicles: SavedVehicle[];
  missions: Record<string, SavedMissionProgress>;
  contacts: Record<string, number>;
  ending: EndingChoice | null;
  wanted: WantedState;
  properties: Record<string, SavedProperty>;
  activities: Record<string, SavedActivity>;
  collectibles: Record<string, string[]>;
  worldFlags: Record<string, boolean>;
  playtimeSeconds: number;
  trafficSeed: number;
  activeDistrict: DistrictId;
  activeCellId: string;
  clock: {
    day: number;
    timeOfDayMinutes: number;
    weather: WeatherKind;
  };
}

export interface InitialGameStateOptions {
  seed?: RandomSeed;
  mode?: GameMode;
  timestamp?: number | null;
}

export interface InitialSaveGameOptions {
  seed?: RandomSeed;
  timestamp?: number;
  label?: string;
}

export const STARTING_TRANSFORM: Readonly<TransformState> = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
});

export function createInitialGameState(options: InitialGameStateOptions = {}): GameState {
  const trafficSeed = new SeededRandom(options.seed ?? 'heatline-solara').getState();

  return {
    stateVersion: GAME_STATE_VERSION,
    mode: options.mode ?? 'menu',
    clock: {
      elapsedSeconds: 0,
      day: 1,
      timeOfDayMinutes: 8 * 60,
      weather: 'clear',
    },
    player: {
      transform: cloneTransform(STARTING_TRANSFORM),
      health: 100,
      maxHealth: 100,
      armor: 0,
      stamina: 100,
      maxStamina: 100,
      inVehicleId: null,
      isSafe: true,
    },
    activeDistrict: 'arroyo-heights',
    activeCellId: 'arroyo-heights:garage',
    mission: {
      activeMissionId: null,
      objectiveId: null,
      checkpointId: null,
      phase: 'inactive',
      objectiveProgress: {},
    },
    worldFlags: {},
    trafficSeed,
    wanted: {
      level: 0,
      phase: 'clear',
      heat: 0,
      searchSecondsRemaining: 0,
    },
    settingsReference: 'global',
    dirty: false,
    lastSaveTimestamp: options.timestamp ?? null,
  };
}

export function createInitialSaveGame(
  slotId: SaveSlotId,
  alexPreset: AlexPreset,
  options: InitialSaveGameOptions = {},
): SaveGameV1 {
  const timestamp = options.timestamp ?? 0;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError('timestamp must be a non-negative finite number');
  }
  const trafficSeed = new SeededRandom(options.seed ?? `heatline-slot-${slotId}`).getState();

  return {
    schemaVersion: SAVE_GAME_VERSION,
    slot: {
      id: slotId,
      label: options.label ?? `Slot ${slotId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    alexPreset,
    player: {
      transform: cloneTransform(STARTING_TRANSFORM),
      lastSafeTransform: cloneTransform(STARTING_TRANSFORM),
      health: 100,
      armor: 0,
      money: 0,
      level: 1,
      xp: 0,
      attributePoints: 0,
      skillPoints: 0,
      attributes: {
        grit: 1,
        aim: 1,
        handling: 1,
        nerve: 1,
        hustle: 1,
      },
      unlockedSkills: [],
    },
    inventory: {
      gridWidth: 8,
      gridHeight: 6,
      maxWeightKg: 22,
      items: [],
    },
    stash: [],
    trunks: {},
    quickLoadout: {
      firearms: [null, null],
      melee: null,
      consumables: [null, null],
    },
    unlockedRecipes: [],
    ownedVehicles: [],
    missions: {},
    contacts: {
      juno: 0,
      malik: 0,
      priya: 0,
    },
    ending: null,
    wanted: {
      level: 0,
      phase: 'clear',
      heat: 0,
      searchSecondsRemaining: 0,
    },
    properties: {},
    activities: {},
    collectibles: {
      salvage: [],
      stunts: [],
      signals: [],
    },
    worldFlags: {},
    playtimeSeconds: 0,
    trafficSeed,
    activeDistrict: 'arroyo-heights',
    activeCellId: 'arroyo-heights:garage',
    clock: {
      day: 1,
      timeOfDayMinutes: 8 * 60,
      weather: 'clear',
    },
  };
}

export function cloneTransform(transform: Readonly<TransformState>): TransformState {
  return {
    position: { ...transform.position },
    rotation: { ...transform.rotation },
  };
}
