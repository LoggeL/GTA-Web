import {
  CoreSaveService,
  InMemorySaveAdapter,
  PersistenceWriteError,
  SOLARA_GAMEPLAY_ANCHORS,
  SaveSlotReadError,
  createInitialSaveGame,
  resolveSolaraActivityMarker,
  resolveSolaraActivityTarget,
  resolveSolaraMissionTarget,
  serializeSaveGame,
  type GameSettings,
  type PersistenceWriteOperation,
  type SaveGameV1,
  type SavedInventory,
  type SavedItemInstance,
  type SaveService,
  type SaveSlotId,
} from '../core';
import {
  PLAYER_SPAWN,
  VEHICLE_SPAWN,
  WORLD_COMBAT_WEAPON_ORDER,
  WorldView,
  createWorldInputState,
  resolveCombatDamage,
  type WorldSnapshot,
  type WorldVehicleInitialization,
} from '../game';
import {
  ACTIVITIES,
  COLLECTIBLES,
  COLLECTIBLE_SETS,
  ITEMS,
  MISSIONS,
  PROPERTIES,
  RECIPES,
  SKILL_NODES,
  VEHICLES,
  WEAPONS,
  getVehicle,
  type ActivityDifficulty,
  type ActivityTypeId,
  type DialogueEntry,
  type MissionDefinition,
  type MissionId,
  type ObjectiveDefinition,
} from '../data';
import {
  CityStreamingController,
  baseResolutionScaleForRuntime,
} from '../game/CityStreamingController';
import { AUTHORED_INTERIORS } from '../game/InteriorRuntime';
import {
  DomInputAdapter,
  InputController,
  InputMap,
  TouchInput,
  toWorldInputState,
  type InputMode,
  type TouchControlAction,
} from '../input';
import {
  NavigationRuntime,
  buildRoadGraph,
  buildWorldChunkDefinition,
  cellIdAt,
  parseCellId,
} from '../navigation';
import type { CellId, MapMarker, NavigationFailureState, RoadGraph } from '../navigation';
import { IndexedDbSaveAdapter } from '../storage/IndexedDbSaveAdapter';
import { GameUI, type AlexPreset, type HudSnapshot, type OverlayPanel, type SaveSlotSummary } from '../ui/GameUI';
import { MapRenderer, type MapRenderModel } from '../ui/MapRenderer';
import { MinimapRenderer } from '../ui/MinimapRenderer';
import {
  GaragePanel,
  parseGaragePanelAction,
  type NearbyUnregisteredVehicle,
} from '../ui/GaragePanel';
import { SkillsPanel, parseSkillsPanelAction } from '../ui/SkillsPanel';
import { InventoryPanel, parseInventoryPanelAction } from '../ui/InventoryPanel';
import { EconomyPanel, parseEconomyPanelAction } from '../ui/EconomyPanel';
import {
  CampaignPanel,
  parseCampaignPanelAction,
  type CampaignPanelModel,
  type ObjectiveCardModel,
} from '../ui/CampaignPanel';
import { AudioEngine } from '../audio/AudioEngine';
import {
  DialogueRuntime,
  MissionRuntime,
  type MissionEnvironmentState,
  type MissionRuntimeEventMap,
} from '../runtime';
import type {
  CrimeEvent,
  EnemyDamageEvent,
  PlayerDamageEvent,
  WitnessReportEvent,
} from '../simulation';
import {
  applyVehicleUpgrade,
  createVehicleTrunk,
  isGaragePaint,
  registerVehicle,
  repaintVehicle,
  repairVehicle,
  retrieveVehicleFromGarage,
  calculateProgressionModifiers,
  addItem,
  assignQuickLoadout,
  autoSortTacticalContainer,
  accruePropertyPayouts,
  collectPropertyIncome,
  craftUnlockedRecipe,
  grantXp,
  inventoryWeight,
  levelProgress,
  moveItem,
  purchaseAttribute,
  purchaseProperty,
  purchaseShopItem,
  purchaseSkill,
  repairItemWithConsumable,
  resolvePropertyServiceModifiers,
  splitStack,
  tacticalInventorySaveFields,
  transferAllTacticalItems,
  transferTacticalItem,
  updateBackpackGritCapacity,
  upgradeProperty,
  useConsumable,
  WantedRuntime,
  completeActivity,
  completeCollectible,
  createActivityProgress,
  createActivitySaveFields,
  createCampaignState,
  createCollectibleProgress,
  createCollectibleSaveFields,
  getActivityAvailability,
  getCollectibleCategoryProgress,
  restoreActivityProgress,
  restoreCollectibleSaveFields,
  revealCollectibles,
  startActivity,
  visibleCollectibles,
  type ActivityProgressState,
  type ActivityVariant,
  type ActivityAvailability,
  type CampaignMissionGateStatus,
  type CollectibleProgressState,
  type CampaignState,
  type EconomyState,
  type GarageState,
  type GarageTransactionResult,
  type ProgressionState,
  type RoadblockCandidate,
  type TacticalContainerRef,
  type TacticalInventoryState,
  type WantedRuntimeSnapshot,
} from '../systems';
import { GAME_SAVE_VALIDATION_REGISTRY } from './save-validation-registry';
import {
  AUTOSAVE_RETRY_MILLISECONDS,
  isAutosaveScheduleDue,
} from './autosave-policy';

const DISTRICT_LABELS: Record<WorldSnapshot['district'], string> = {
  'neon-strand': 'Neon Strand',
  'alta-vista': 'Alta Vista',
  'arroyo-heights': 'Arroyo Heights',
  breakwater: 'Breakwater',
};

const formatPreset = (preset: AlexPreset): string => preset === 'feminine'
  ? 'Feminine Alex'
  : 'Masculine Alex';

const formatSavePlaytime = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m played` : `${minutes}m played`;
};

const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message
  : String(error);

const MISSION_INTERACTION_RADIUS_METERS = 12;
const COLLECTIBLE_INTERACTION_RADIUS_METERS = 8;

interface MissionWorldTarget {
  readonly missionId: MissionId;
  readonly objectiveId: string;
  readonly targetId: string;
  readonly targetIndex: number;
  readonly position: { readonly x: number; readonly z: number };
}

interface ActiveActivityRun {
  readonly run: ActivityVariant;
  readonly startedAtMs: number;
  step: number;
}

type MapFilterKind = 'mission' | 'property' | 'activity' | 'shop' | 'safehouse' | 'custom';

interface HeatlineQaApi {
  teleport(x: number, z: number): WorldSnapshot;
  face(x: number, z: number): WorldSnapshot;
  snapshot(): WorldSnapshot | null;
  trafficVehicles(): readonly {
    id: string;
    classId: string;
    behavior: string;
    speed: number;
    heading: number;
    roadId: string;
    x: number;
    z: number;
  }[];
  trafficSignals(): readonly {
    id: string;
    x: number;
    z: number;
    phase: string;
    horizontalAspect: string;
    verticalAspect: string;
    horizontalRoadIds: readonly string[];
    verticalRoadIds: readonly string[];
    secondsUntilChange: number;
  }[];
  pedestrians(): readonly {
    id: string;
    behavior: string;
    x: number;
    z: number;
  }[];
  setMoney(value: number): number;
  grantXp(amount: number): { level: number; xp: number; attributePoints: number; skillPoints: number };
  inventoryState(): {
    itemCount: number;
    weightKg: number;
    quickLoadout: SaveGameV1['quickLoadout'];
    unlockedRecipes: number;
  };
  accruePropertyPayouts(count?: number): Record<string, number>;
  setActiveVehicleClass(classId: string): WorldSnapshot;
  setActiveVehicleCondition(bodyHealth: number, engineHealth: number): WorldSnapshot;
  combatants(): readonly {
    id: string;
    role: string;
    behavior: string;
    state: string;
    tactic: string;
    awareness: number;
    health: number;
    heading: number;
    x: number;
    z: number;
  }[];
  seedCombatEncounter(x: number, z: number): readonly string[];
  selectWeapon(weaponId: string): WorldSnapshot;
  damageCombatant(targetId: string, amount: number): boolean;
  setWantedLevel(level: number): SaveGameV1['wanted'];
  advanceWanted(seconds: number, isVisible?: boolean, insideSearchArea?: boolean): SaveGameV1['wanted'];
  advanceWorld(seconds: number): { simulatedSeconds: number; wantedLevel: number };
  setPlayerCondition(health: number, armor: number): { health: number; armor: number };
  defeat(outcome: 'death' | 'arrest'): Promise<{ health: number; money: number; wantedLevel: number }>;
  campaignState(): CampaignQaSnapshot;
  startMission(missionId: string): CampaignQaSnapshot;
  advanceMissionObjective(choice?: 'rule' | 'expose'): CampaignQaSnapshot;
  failMission(reason?: string): CampaignQaSnapshot;
  retryMission(): CampaignQaSnapshot;
  completeMission(choice?: 'rule' | 'expose'): CampaignQaSnapshot;
  startActivity(activityId: string, difficultyId?: string): ContentQaSnapshot;
  completeActivity(): ContentQaSnapshot;
  collectCollectible(collectibleId: string): ContentQaSnapshot;
  contentState(): ContentQaSnapshot;
  audioState(): ReturnType<AudioEngine['snapshot']>;
  cycleRadio(): ReturnType<AudioEngine['cycleStation']>;
  nextRadioTrack(): ReturnType<AudioEngine['nextTrack']>;
}

interface CampaignQaSnapshot {
  readonly activeMissionId: string | null;
  readonly activeMissionStatus: string | null;
  readonly activeObjectiveIds: readonly string[];
  readonly availableMissionIds: readonly string[];
  readonly completedMissionIds: readonly string[];
  readonly checkpointId: string | null;
  readonly wantedLevel: number;
  readonly contacts: Readonly<Record<string, number>>;
  readonly ending: 'rule' | 'expose' | null;
  readonly storyComplete: boolean;
  readonly postgameFreeRoam: boolean;
  readonly reviewedDialogueKeys: readonly string[];
}

interface ContentQaSnapshot {
  readonly activeActivityId: string | null;
  readonly activityStep: number;
  readonly activities: Readonly<Record<string, number>>;
  readonly revealedCollectibles: number;
  readonly completedCollectibles: number;
  readonly collectibleCategories: Readonly<Record<string, { readonly completed: number; readonly total: number }>>;
}

type QaGlobal = typeof globalThis & {
  __HEATLINE_QA__?: HeatlineQaApi;
};

type PersistenceMode = 'indexeddb' | 'session-only';
type PersistenceFailureOperation = PersistenceWriteOperation | 'list-slots' | 'load-slot' | 'import-slot';

const SOFTWARE_WEBGL_RENDERER_PATTERN = /swiftshader|llvmpipe|softpipe|software|lavapipe/i;

/**
 * A software WebGL device is a valid fallback, but it is never a high-quality
 * target. Detect it before constructing the long-lived renderer so automatic
 * quality can disable antialiasing/shadows and start from the low-resolution
 * budget instead of spending the whole adaptation window above frame budget.
 */
function detectSoftwareWebGlRenderer(): boolean {
  const canvas = document.createElement('canvas');
  const attributes: WebGLContextAttributes = {
    antialias: false,
    powerPreference: 'high-performance',
  };
  const context = canvas.getContext('webgl2', attributes)
    ?? canvas.getContext('webgl', attributes);
  if (!context) return false;
  const debug = context.getExtension('WEBGL_debug_renderer_info') as {
    readonly UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const description = [
    String(context.getParameter(context.RENDERER)),
    debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '',
  ].join(' ');
  context.getExtension('WEBGL_lose_context')?.loseContext();
  return SOFTWARE_WEBGL_RENDERER_PATTERN.test(description);
}

function isAutomatedTestAudioMuted(): boolean {
  return (globalThis as typeof globalThis & {
    readonly __HEATLINE_TEST_AUDIO_MUTED__?: boolean;
  }).__HEATLINE_TEST_AUDIO_MUTED__ === true;
}

interface PersistenceFailureState {
  readonly operation: PersistenceFailureOperation;
  readonly slotId: SaveSlotId | null;
  readonly message: string;
  readonly emergencyExport: string | null;
  readonly sequence: number;
}

const nextAnimationFrame = (): Promise<void> => new Promise((resolve) => {
  let settled = false;
  let frameId: number | null = null;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (frameId !== null) cancelAnimationFrame(frameId);
    if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    resolve();
  };
  // Firefox and power-saving browsers may suspend rAF while a loading screen is
  // occluded. Loading must still advance; the world loop itself remains rAF-driven.
  timeoutId = globalThis.setTimeout(finish, 120);
  frameId = requestAnimationFrame(finish);
});

export class App {
  readonly #root: HTMLElement;
  readonly #saveService: SaveService;
  readonly #persistenceMode: PersistenceMode;
  readonly #softwareWebGlRenderer: boolean;
  readonly #audio = new AudioEngine({ muteOutput: isAutomatedTestAudioMuted() });
  readonly #ui: GameUI;
  readonly #minimap: MinimapRenderer;
  #settings: GameSettings;
  #world: WorldView | null = null;
  #inputController: InputController | null = null;
  #domInput: DomInputAdapter | null = null;
  #touchInput: TouchInput | null = null;
  #inputMode: InputMode = 'on-foot';
  #currentSave: SaveGameV1 | null = null;
  #activeSlot: SaveSlotId | null = null;
  #paused = false;
  #panelOpen = false;
  #quitting = false;
  #saveMenuOperationPending = false;
  #saveQueued = false;
  #saveToastQueued = false;
  #saveDrainPromise: Promise<boolean> | null = null;
  #lastSnapshotAt = 0;
  #lastAutosaveAt = 0;
  #autosaveRetryAt = 0;
  #autosaveBlocked = false;
  readonly #persistenceFailures = new Map<string, PersistenceFailureState>();
  #persistenceFailureSequence = 0;
  readonly #slotStatuses = new Map<SaveSlotId, SaveSlotSummary['status']>();
  #orientationBlocked = false;
  #lastVehicleSirenActive = false;
  #settingsSaveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  #navigation: NavigationRuntime | null = null;
  #cityStreaming: CityStreamingController | null = null;
  #navigationUpdatePending = false;
  #queuedNavigationSnapshot: WorldSnapshot | null = null;
  #navigationFailureNotified = false;
  #failedStreamCellId: CellId | null = null;
  #streamRetryPending = false;
  #roadGraph: RoadGraph | null = null;
  readonly #closedStreamEdgeIds = new Set<string>();
  #navigationDriveWaypointSet = false;
  #mapRenderer: MapRenderer | null = null;
  #garagePanel: GaragePanel | null = null;
  #skillsPanel: SkillsPanel | null = null;
  #inventoryPanel: InventoryPanel | null = null;
  #economyPanel: EconomyPanel | null = null;
  #campaignPanel: CampaignPanel | null = null;
  #missionRuntime: MissionRuntime | null = null;
  #dialogueRuntime: DialogueRuntime | null = null;
  #activityProgress: ActivityProgressState = createActivityProgress(ACTIVITIES);
  #collectibleProgress: CollectibleProgressState = createCollectibleProgress();
  #activeActivity: ActiveActivityRun | null = null;
  #missionTarget: MissionWorldTarget | null = null;
  #missionCombatantIds = new Set<string>();
  #missionEnvironmentBaseline: { timeOfDay: number; rainIntensity: number } | null = null;
  #missionRecoveryInProgress = false;
  #collectibleRevealSignature = '';
  #inventorySelection: string | null = null;
  #m5TransactionSequence = 0;
  #mapModel: MapRenderModel | null = null;
  readonly #mapMarkerFilters: Record<MapFilterKind, boolean> = {
    mission: true,
    property: true,
    activity: true,
    shop: true,
    safehouse: true,
    custom: true,
  };
  #lastWorldSnapshot: WorldSnapshot | null = null;
  #lastExteriorSnapshot: WorldSnapshot | null = null;
  readonly #pendingCrimes = new Map<string, CrimeEvent>();
  #wantedRuntime: WantedRuntime | null = null;
  #wantedSnapshot: WantedRuntimeSnapshot | null = null;
  #policeVisibleSeconds = 0;
  #defeatResolving = false;

  private constructor(
    root: HTMLElement,
    saveService: SaveService,
    settings: GameSettings,
    persistenceMode: PersistenceMode,
    softwareWebGlRenderer: boolean,
  ) {
    this.#root = root;
    this.#saveService = saveService;
    this.#persistenceMode = persistenceMode;
    this.#softwareWebGlRenderer = softwareWebGlRenderer;
    this.#settings = settings;
    this.#ui = new GameUI(root, {
      onRequestSaveSlots: () => void this.#showSaveSlots(),
      onStartNewGame: (slot, preset) => void this.#startNewGame(slot, preset),
      onContinueGame: (slot) => void this.#continueGame(slot),
      onDeleteSlot: (slot) => void this.#deleteSlot(slot),
      onExportSaveSlot: (slot) => void this.#exportSaveSlot(slot),
      onInspectSaveImport: (serialized) => this.#inspectSaveImport(serialized),
      onImportSave: (serialized, destination) => void this.#importSave(serialized, destination),
      onExportEmergencySave: (serialized) => this.#downloadSaveJson(
        serialized,
        `heatline-emergency-slot-${this.#activeSlot ?? 'unknown'}.json`,
      ),
      onResume: () => this.#resume(),
      onPause: () => this.#pause(),
      onQuitToMenu: () => void this.#quitToMenu(),
      onOpenPanel: (panel) => this.#openPanel(panel),
      onClosePanel: () => this.#closePanel(),
      onTouchAction: (action, active) => this.#touchAction(action, active),
      onSettingsChange: (nextSettings) => this.#updateSettings(nextSettings),
      onRetryStream: () => void this.#retryStreamFailure(),
      onReturnFromStreamFailure: () => void this.#quitToMenu(),
    }, settings);
    const minimapCanvas = root.querySelector<HTMLCanvasElement>('[data-minimap]');
    if (!minimapCanvas) throw new Error('Missing minimap canvas');
    this.#minimap = new MinimapRenderer(minimapCanvas);
    this.#applySettings();
    this.#bindGlobalEvents();
    this.#ui.showSplash();
    this.#refreshPersistenceWarning();
  }

  static async boot(root: HTMLElement): Promise<App> {
    let saveService: SaveService;
    let settings: GameSettings;
    let persistenceMode: PersistenceMode = 'indexeddb';
    try {
      if (!('indexedDB' in globalThis)) throw new Error('IndexedDB unavailable');
      saveService = new CoreSaveService(
        new IndexedDbSaveAdapter(),
        GAME_SAVE_VALIDATION_REGISTRY,
      );
      await saveService.initialize();
      settings = await saveService.loadSettings();
    } catch (error) {
      console.warn('Persistent saves are unavailable; using an in-memory session.', error);
      persistenceMode = 'session-only';
      saveService = new CoreSaveService(
        new InMemorySaveAdapter(),
        GAME_SAVE_VALIDATION_REGISTRY,
      );
      await saveService.initialize();
      settings = await saveService.loadSettings();
    }
    return new App(
      root,
      saveService,
      settings,
      persistenceMode,
      detectSoftwareWebGlRenderer(),
    );
  }

  async #unlockAudio(): Promise<void> {
    try {
      await this.#audio.unlock();
    } catch (error) {
      console.warn('Browser audio is unavailable; continuing without sound.', error);
    }
  }

  #beginSaveMenuOperation(): boolean {
    if (this.#saveMenuOperationPending) return false;
    this.#saveMenuOperationPending = true;
    this.#ui.setSaveMenuPending(true);
    return true;
  }

  #endSaveMenuOperation(): void {
    this.#saveMenuOperationPending = false;
    this.#ui.setSaveMenuPending(false);
  }

  async #showSaveSlots(): Promise<void> {
    void this.#unlockAudio();
    try {
      const summaries = await this.#saveService.listSlots();
      this.#slotStatuses.clear();
      const slots: SaveSlotSummary[] = summaries.map((summary) => {
        this.#slotStatuses.set(summary.slotId, summary.status);
        const preview = summary.preview;
        const activeMission = preview?.activeMissionId
          ? MISSIONS.find((mission) => mission.id === preview.activeMissionId)
          : undefined;
        return {
          slot: summary.slotId,
          status: summary.status,
          canExport: summary.status === 'ready'
            || summary.status === 'recovered'
            || summary.status === 'unsupported-version',
          level: preview?.level,
          mission: activeMission?.title ?? preview?.label,
          district: preview ? DISTRICT_LABELS[preview.activeDistrict] : undefined,
          playtimeSeconds: preview?.playtimeSeconds,
          updatedAt: preview?.updatedAt,
          preset: preview?.alexPreset,
        };
      });
      // listSlots just performed a fresh read/classification of every slot, so
      // any earlier per-slot load/export warning is now stale. Clear those and
      // the list failure together without briefly surfacing a lower-priority
      // warning between individual refreshes.
      for (const summary of summaries) {
        this.#persistenceFailures.delete(this.#persistenceFailureKey('load-slot', summary.slotId));
      }
      this.#persistenceFailures.delete(this.#persistenceFailureKey('list-slots', null));
      this.#refreshPersistenceWarning();
      this.#ui.showSaveSlots(slots);
    } catch (error: unknown) {
      console.error(error);
      this.#slotStatuses.clear();
      this.#recordPersistenceFailure(
        error,
        'Save slots could not be read. They are locked to prevent accidental replacement.',
        'list-slots',
        null,
      );
      this.#ui.showSaveSlots(([1, 2, 3] as const).map((slot) => ({
        slot,
        status: 'unavailable',
        canExport: false,
      })));
    }
  }

  async #startNewGame(slot: SaveSlotId, preset: AlexPreset): Promise<void> {
    if (!this.#beginSaveMenuOperation()) return;
    try {
      void this.#unlockAudio();
      const timestamp = Date.now();
      const save = createInitialSaveGame(slot, preset, { timestamp, seed: `slot-${slot}-${timestamp}` });
      save.player.transform.position = { ...PLAYER_SPAWN };
      save.player.lastSafeTransform.position = { ...PLAYER_SPAWN };
      save.missions['past-due'] = {
        state: 'available',
        checkpointId: null,
        completedObjectives: [],
      };
      save.player.money = 850;
      ensureStarterVehicle(save);
      ensureM5StarterInventory(save);
      try {
        await this.#saveService.saveSlot(save);
        this.#clearPersistenceFailure('save-slot', slot);
      } catch (error: unknown) {
        console.error(error);
        if (error instanceof PersistenceWriteError) {
          this.#recordPersistenceFailure(
            error,
            'The new game is running, but browser storage rejected its first save.',
            'save-slot',
            slot,
          );
        } else {
          this.#recordPersistenceFailure(
            error,
            'This slot is not safe to replace. Export or delete its existing data first.',
            'load-slot',
            slot,
          );
          await this.#showSaveSlots();
          return;
        }
      }
      await this.#loadGame(save, true);
    } finally {
      this.#endSaveMenuOperation();
    }
  }

  async #continueGame(slot: SaveSlotId): Promise<void> {
    if (!this.#beginSaveMenuOperation()) return;
    try {
      void this.#unlockAudio();
      try {
        const result = await this.#saveService.loadSlot(slot);
        if (!result) {
          this.#clearPersistenceFailure('load-slot', slot);
          this.#ui.toast('That save slot is empty.', 'warning');
          await this.#showSaveSlots();
          return;
        }
        this.#clearPersistenceFailure('load-slot', slot);
        await this.#loadGame(result.save, false);
        if (result.recoveredFromBackup) this.#ui.toast('Recovered the last known-good save.', 'warning');
      } catch (error) {
        console.error(error);
        const message = error instanceof SaveSlotReadError
          ? error.code === 'unsupported-version'
            ? `Slot ${slot} was created by a newer HEATLINE build. Export it or update the game; it was not changed.`
            : `Slot ${slot} is damaged and cannot be loaded. Delete it explicitly only after preserving any external backup.`
          : `Slot ${slot} could not be read because browser storage is temporarily unavailable. No data was changed.`;
        this.#recordPersistenceFailure(error, message, 'load-slot', slot);
        await this.#showSaveSlots();
      }
    } finally {
      this.#endSaveMenuOperation();
    }
  }

  async #loadGame(save: SaveGameV1, isNew: boolean): Promise<void> {
    this.#teardownWorld();
    ensureStarterVehicle(save);
    ensureM5StarterInventory(save);
    this.#currentSave = save;
    this.#activeSlot = save.slot.id;
    this.#lastSnapshotAt = performance.now();
    this.#lastAutosaveAt = performance.now();
    this.#autosaveRetryAt = 0;
    this.#autosaveBlocked = false;
    this.#ui.showLoading('Reading Solara street grid…', 12);
    await nextAnimationFrame();
    this.#ui.updateLoading('Building four districts…', 42);
    await nextAnimationFrame();

    const mount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
    if (!mount) throw new Error('Missing 3D world mount');
    const quality = this.#resolveQuality();
    mount.dataset.worldQuality = quality;
    mount.dataset.rendererClass = this.#softwareWebGlRenderer ? 'software' : 'hardware';
    const resolutionScale = baseResolutionScaleForRuntime(
      this.#settings.video.resolutionScale,
      this.#settings.video.quality,
      quality,
      matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
      this.#softwareWebGlRenderer,
    );
    const position = save.player.transform.position;
    this.#wantedRuntime = new WantedRuntime({
      seed: `${save.trafficSeed}:wanted-runtime`,
      modifiers: {
        nerve: save.player.attributes.nerve,
        ending: save.ending,
      },
    });
    this.#wantedSnapshot = this.#wantedRuntime.restoreState(save.wanted, position);
    this.#inputMode = 'on-foot';
    this.#inputController = this.#createInputController();
    try {
      this.#world = new WorldView({
        mount,
        seed: save.trafficSeed,
        quality,
        initialPosition: position,
        initialHeading: save.player.transform.rotation.y,
        initialVehicle: worldVehicleFromSave(save),
        reservedVehicleInstanceIds: save.ownedVehicles.map(({ instanceId }) => instanceId),
        timeOfDay: save.clock.timeOfDayMinutes / 1_440,
        rainIntensity: save.clock.weather === 'rain' ? 0.62 : 0,
        reducedMotion: this.#settings.accessibility.reducedMotion,
        cameraShake: this.#settings.accessibility.cameraShake,
        resolutionScale,
        aimAssistLevel: this.#settings.controls.aimAssist,
        aimAssistDevice: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
        desktopSoftLockEnabled: this.#settings.controls.softLock,
        enableDefaultControls: false,
        inputProvider: () => this.#consumeWorldInput(),
        onFrame: (frameMilliseconds) => this.#onWorldFrame(frameMilliseconds),
        onSnapshot: (snapshot) => this.#onWorldSnapshot(snapshot),
        onCrime: (event) => this.#onCrime(event),
        onWitnessReport: (event) => this.#onWitnessReport(event),
        onEnemyDamage: (event) => this.#onEnemyDamage(event),
        onPlayerDamage: (event) => this.#onPlayerDamage(event),
      });
    } catch (error) {
      console.error(error);
      this.#ui.showUnsupportedBrowser(
        'The 3D renderer could not start. Hardware acceleration may be disabled or WebGL2 may be unavailable.',
      );
      return;
    }

    this.#world.setPoliceResponse(save.wanted.level, save.wanted.phase);
    this.#world.seedCombatEncounter({
      x: 360,
      z: -320,
    });
    this.#initializeCampaignRuntime(save);
    this.#applyProgressionRuntimeModifiers();
    this.#syncWorldQuickLoadout();

    this.#domInput = new DomInputAdapter(this.#world.renderer.domElement, this.#inputController);
    this.#touchInput = new TouchInput(this.#root, this.#inputController);
    this.#initializeNavigation(this.#world);
    this.#wantedSnapshot = this.#wantedRuntime.restoreState(
      save.wanted,
      position,
      this.#roadblockCandidates(),
    );
    this.#applyWantedSnapshot(this.#wantedSnapshot, true);
    this.#installQaApi(this.#world);

    this.#ui.updateLoading('Starting traffic radio…', 82);
    this.#audio.setMix(this.#settings.audio);
    this.#audio.playStation('coastline-fm');
    await nextAnimationFrame();
    this.#ui.updateLoading('Welcome to Solara', 100);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
    this.#ui.showGame();
    this.#ui.setTouchMode(matchMedia('(pointer: coarse)').matches);
    this.#paused = false;
    this.#panelOpen = false;
    this.#world.start();
    this.#syncOrientationBlock();
    if (!this.#orientationBlocked) this.#world.focus();
    if (isNew) {
      if (this.#missionRuntime?.activeMission === null) this.#startCampaignMission('past-due');
    } else {
      this.#ui.toast('Welcome back to Solara', 'success');
      this.#resumeDialoguePresentation();
    }
  }

  #onWorldSnapshot(snapshot: WorldSnapshot): void {
    const now = performance.now();
    const deltaSeconds = Math.max(0, Math.min(1, (now - this.#lastSnapshotAt) / 1_000));
    this.#lastWorldSnapshot = snapshot;
    if (snapshot.interiorId === null) this.#lastExteriorSnapshot = snapshot;
    if (this.#inputMode !== snapshot.mode) {
      this.#inputMode = snapshot.mode;
      this.#inputController?.setMode(snapshot.mode);
    }
    if (
      snapshot.mode === 'vehicle'
      && !this.#navigationDriveWaypointSet
      && this.#missionRuntime?.activeMission === null
      && this.#activeActivity === null
    ) {
      this.#navigationDriveWaypointSet = true;
      this.#navigation?.setWaypoint({
        id: 'neon-strand-lookout',
        label: 'Neon Strand lookout',
        position: { x: -350, z: -350 },
        source: 'mission',
      });
      this.#ui.toast('GPS route set · Neon Strand lookout', 'info');
    }
    const worldMount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
    if (worldMount) {
      worldMount.dataset.playerMode = snapshot.mode;
      worldMount.dataset.playerX = snapshot.position.x.toFixed(2);
      worldMount.dataset.playerY = snapshot.position.y.toFixed(2);
      worldMount.dataset.playerZ = snapshot.position.z.toFixed(2);
      worldMount.dataset.district = snapshot.district;
      worldMount.dataset.traversalMode = snapshot.traversalMode;
      worldMount.dataset.cameraMode = snapshot.cameraMode;
      worldMount.dataset.shoulderSide = snapshot.shoulderSide;
      worldMount.dataset.worldPaused = String(snapshot.paused);
      worldMount.dataset.canInteract = String(snapshot.canInteract);
      worldMount.dataset.grounded = String(snapshot.grounded);
      worldMount.dataset.sprinting = String(snapshot.sprinting);
      worldMount.dataset.crouching = String(snapshot.crouching);
      worldMount.dataset.cameraShake = this.#settings.accessibility.cameraShake.toFixed(2);
      worldMount.dataset.interiorId = snapshot.interiorId ?? '';
      worldMount.dataset.interiorPhase = snapshot.interiorPhase;
      worldMount.dataset.vehicleInstanceId = snapshot.vehicleInstanceId;
      worldMount.dataset.vehicleClassId = snapshot.vehicleClassId;
      worldMount.dataset.vehicleRegistered = String(snapshot.vehicleRegistered);
      worldMount.dataset.vehiclePaint = snapshot.vehiclePaint;
      worldMount.dataset.vehicleSirenActive = String(snapshot.vehicleSirenActive);
      worldMount.dataset.vehicleCameraView = snapshot.vehicleCameraView;
      worldMount.dataset.wantedLevel = String(this.#currentSave?.wanted.level ?? 0);
      worldMount.dataset.wantedPhase = this.#currentSave?.wanted.phase ?? 'clear';
      worldMount.dataset.policeRoadblock = String(snapshot.policeResponse.roadblock);
      worldMount.dataset.policeHelicopter = String(snapshot.policeResponse.helicopter);
      worldMount.dataset.policeRoadblockCount = String(
        this.#wantedSnapshot?.police.roadblocks.length ?? 0,
      );
      worldMount.dataset.policeHelicopterMode =
        this.#wantedSnapshot?.police.helicopter.mode ?? 'inactive';
      worldMount.dataset.wantedSearchRadius = String(this.#wantedSnapshot?.searchRadius ?? 0);
      worldMount.dataset.activeWeaponId = snapshot.activeWeaponId;
      worldMount.dataset.activeWeaponClass = snapshot.activeWeaponClassId;
      worldMount.dataset.activeWeaponTier = String(snapshot.activeWeaponTier);
      worldMount.dataset.weaponDurability = snapshot.weaponDurability.toFixed(2);
      worldMount.dataset.weaponReloading = String(snapshot.weaponReloading);
      worldMount.dataset.meleeBlocking = String(snapshot.meleeBlocking);
      worldMount.dataset.softCover = String(snapshot.softCoverEngaged);
      worldMount.dataset.softCoverPeeking = String(snapshot.softCoverPeeking);
      worldMount.dataset.aimTargetId = snapshot.aimTargetId ?? '';
      worldMount.dataset.activeCombatants = String(snapshot.activeCombatants);
      const campaignRuntime = this.#missionRuntime;
      const campaignActive = campaignRuntime?.activeMission;
      const campaignSummary = campaignRuntime?.completionSummary();
      worldMount.dataset.activeMissionId = campaignActive?.missionId ?? '';
      worldMount.dataset.activeMissionStatus = campaignActive?.status ?? '';
      worldMount.dataset.activeObjectiveId = campaignRuntime?.activeObjectiveIds()[0] ?? '';
      worldMount.dataset.completedMissions = String(campaignSummary?.completedMissionCount ?? 0);
      worldMount.dataset.campaignEnding = campaignSummary?.ending ?? '';
      worldMount.dataset.postgameFreeRoam = String(campaignSummary?.postgameFreeRoam ?? false);
      worldMount.dataset.dialogueReviewCount = String(this.#dialogueRuntime?.reviewedKeys.length ?? 0);
      worldMount.dataset.activeActivityId = this.#activeActivity?.run.activityId ?? '';
      worldMount.dataset.completedCollectibles = String(this.#collectibleProgress.completedIds.length);
      if (this.#currentSave) {
        const modifiers = calculateProgressionModifiers(
          progressionStateFromSave(this.#currentSave),
          this.#currentSave.ending,
        );
        worldMount.dataset.rpgMaximumHealth = modifiers.maximumHealth.toFixed(2);
        worldMount.dataset.rpgCarryWeight = modifiers.backpackWeightKg.toFixed(2);
        worldMount.dataset.rpgMeleeDamage = modifiers.meleeDamageMultiplier.toFixed(4);
        worldMount.dataset.rpgWeaponSpread = modifiers.weaponSpreadMultiplier.toFixed(4);
        worldMount.dataset.rpgReloadTime = modifiers.reloadTimeMultiplier.toFixed(4);
        worldMount.dataset.rpgVehicleStability = modifiers.vehicleStabilityMultiplier.toFixed(4);
        worldMount.dataset.rpgVehicleBraking = modifiers.vehicleBrakingMultiplier.toFixed(4);
        worldMount.dataset.rpgVehicleDurability = modifiers.vehicleDurabilityMultiplier.toFixed(4);
        worldMount.dataset.rpgHeatGain = modifiers.heatGainMultiplier.toFixed(4);
        worldMount.dataset.rpgCashReward = modifiers.cashRewardMultiplier.toFixed(4);
      }
    }
    if (this.#currentSave) {
      this.#currentSave.playtimeSeconds += deltaSeconds;
      if (snapshot.interiorId === null) {
        this.#currentSave.player.transform.position = { ...snapshot.position };
        this.#currentSave.player.transform.rotation.y = snapshot.heading;
      }
      this.#currentSave.activeDistrict = snapshot.district;
      const persistentEnvironment = this.#missionEnvironmentBaseline ?? snapshot;
      this.#currentSave.clock.timeOfDayMinutes = Math.round(persistentEnvironment.timeOfDay * 1_440) % 1_440;
      this.#currentSave.clock.weather = persistentEnvironment.rainIntensity > 0.15 ? 'rain' : 'clear';
      if (snapshot.vehicleRegistered) {
        const savedVehicle = this.#currentSave.ownedVehicles.find(
          (vehicle) => vehicle.instanceId === snapshot.vehicleInstanceId,
        );
        if (savedVehicle) {
          savedVehicle.bodyHealth = snapshot.vehicleIntegrity.bodyHealth;
          savedVehicle.engineHealth = snapshot.vehicleIntegrity.engineHealth;
          savedVehicle.tireHealth = [...snapshot.vehicleIntegrity.tireHealth] as [number, number, number, number];
          savedVehicle.upgrades.engine = snapshot.vehicleUpgrades.engine;
          savedVehicle.upgrades.brakes = snapshot.vehicleUpgrades.brakes;
          savedVehicle.upgrades.grip = snapshot.vehicleUpgrades.grip;
          savedVehicle.upgrades.armor = snapshot.vehicleUpgrades.armor;
          savedVehicle.upgrades.paint = snapshot.vehiclePaint;
        }
      }
    }
    this.#tickWantedRuntime(snapshot, deltaSeconds, now);
    this.#tickCampaignRuntime(snapshot, deltaSeconds);
    this.#updateCollectibleDiscovery(snapshot);
    this.#lastSnapshotAt = now;

    this.#syncWorldAudio(snapshot);
    const campaignHud = this.#campaignHud(snapshot);
    const radio = this.#audio.snapshot();

    const hud: HudSnapshot = {
      health: this.#currentSave?.player.health ?? 100,
      maxHealth: this.#currentSave
        ? calculateProgressionModifiers(
          progressionStateFromSave(this.#currentSave),
          this.#currentSave.ending,
        ).maximumHealth
        : 100,
      armor: this.#currentSave?.player.armor ?? 0,
      stamina: snapshot.activeWeaponClassId === 'melee'
        ? snapshot.meleeStamina
        : snapshot.sprinting ? 72 : 100,
      wantedLevel: this.#currentSave?.wanted.level ?? 0,
      wantedSearching: ['investigating', 'search'].includes(this.#currentSave?.wanted.phase ?? 'clear'),
      wantedSearchRadius: this.#wantedSnapshot?.searchRadius ?? 0,
      objective: campaignHud.objective ?? (snapshot.interiorId
        ? `Explore ${snapshot.interiorLabel ?? 'the interior'}`
        : snapshot.mode === 'vehicle'
          ? 'Explore Solara by road'
          : 'Free roam · open Jobs to choose work'),
      objectiveDetail: campaignHud.detail ?? (snapshot.interiorId
        ? 'Press E at the marked doorway to return outside'
        : snapshot.mode === 'vehicle'
          ? 'Open Jobs for story missions and repeatable work'
          : 'Press J or use the Jobs button for the campaign board'),
      district: DISTRICT_LABELS[snapshot.district],
      timeLabel: this.#timeLabel(snapshot.timeOfDay),
      money: this.#currentSave?.player.money ?? 0,
      level: this.#currentSave?.player.level ?? 1,
      xpProgress: this.#currentSave
        ? levelProgress(progressionStateFromSave(this.#currentSave)).fraction * 100
        : 0,
      ammo: snapshot.activeWeaponClassId === 'melee' ? 0 : snapshot.weaponAmmo,
      ammoReserve: snapshot.activeWeaponClassId === 'melee' ? 0 : snapshot.weaponAmmoReserve,
      weapon: `${snapshot.activeWeaponName} · T${snapshot.activeWeaponTier} · ${Math.round(snapshot.weaponDurability)}%${snapshot.weaponReloading ? ' · RELOADING' : ''}`,
      speedKph: snapshot.mode === 'vehicle' ? snapshot.speedKph : undefined,
      vehicleName: snapshot.mode === 'vehicle' ? snapshot.vehicleName : undefined,
      vehicleHealth: snapshot.mode === 'vehicle' ? snapshot.vehicleIntegrity.engineHealth : undefined,
      radio: snapshot.mode === 'vehicle'
        ? snapshot.vehicleSirenActive
          ? 'SIREN ACTIVE'
          : radio.enabled
            ? `${radio.stationName} · ${radio.trackTitle}`
            : radio.stationName
        : undefined,
      interaction: campaignHud.interaction ?? snapshot.prompt?.replace('Press E to ', ''),
    };
    this.#ui.updateHud(hud);
    const navigationSnapshot = snapshot.interiorId
      ? (this.#lastExteriorSnapshot ?? snapshot)
      : snapshot;
    this.#drawNavigation(navigationSnapshot);
    if (snapshot.interiorId === null) this.#queueNavigationUpdate(snapshot);

    if (
      this.#currentSave
      && !this.#autosaveBlocked
      && isAutosaveScheduleDue({
        now,
        lastSuccessfulSaveAt: this.#lastAutosaveAt,
        retryAt: this.#autosaveRetryAt,
      })
      && !this.#paused
      && this.#isAutosaveSafe(snapshot)
    ) {
      void this.#saveNow(false);
    }
  }

  #onCrime(event: CrimeEvent): void {
    this.#pendingCrimes.set(event.id, event);
    while (this.#pendingCrimes.size > 24) {
      const oldest = this.#pendingCrimes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#pendingCrimes.delete(oldest);
    }
    if (event.kind === 'weapon-fire') this.#audio.playSfx('weapon');
    else if (event.kind === 'assault' || event.kind === 'hit-and-run') this.#audio.playSfx('impact');
    else this.#audio.playUi('warning');
    this.#ui.toast('Crime noticed · witnesses may report Alex', 'warning');
  }

  #onWitnessReport(event: WitnessReportEvent): void {
    const save = this.#currentSave;
    const runtime = this.#wantedRuntime;
    const crime = this.#pendingCrimes.get(event.crimeId);
    if (!save || !runtime || !crime) return;
    this.#pendingCrimes.delete(event.crimeId);
    const result = runtime.reportWitness({
      crimeId: event.crimeId,
      witnessId: event.witnessId,
      source: 'pedestrian',
      severity: Math.max(1, Math.min(5, Math.round(crime.severity))) as 1 | 2 | 3 | 4 | 5,
      confidence: event.confidence,
      suspectIdentified: event.confidence >= 0.58,
      position: { x: event.position.x, z: event.position.z },
    });
    if (!result.accepted) return;
    this.#policeVisibleSeconds = result.state.phase === 'pursuit' ? 6.5 : 0;
    const snapshot = runtime.tick(0, {
      playerPosition: { x: event.position.x, z: event.position.z },
      visibleToPolice: result.state.phase === 'pursuit',
      roadblockCandidates: this.#roadblockCandidates(),
    });
    this.#applyWantedSnapshot(snapshot);
    if (result.state.level === 0) {
      this.#ui.toast('Witness report logged · no active police response', 'info');
    } else {
      this.#audio.playSfx('siren');
      this.#ui.toast(
        result.state.phase === 'pursuit'
          ? `Witness identified Alex · wanted level ${result.state.level}`
          : `Police investigating · wanted level ${result.state.level}`,
        'warning',
      );
    }
  }

  #onEnemyDamage(event: EnemyDamageEvent): void {
    this.#audio.playSfx('impact');
    if (event.defeated) {
      const missionResolved = this.#recordMissionCombatDefeat(event.targetId);
      if (missionResolved) this.#world?.despawnCombatant(event.targetId);
      this.#ui.toast('Hostile incapacitated · non-graphic takedown', 'success');
    }
  }

  #onPlayerDamage(event: PlayerDamageEvent): void {
    const save = this.#currentSave;
    if (!save || this.#defeatResolving) return;
    this.#audio.playSfx('impact');
    const maximumHealth = 100 + Math.max(0, save.player.attributes.grit - 1) * 10;
    const damage = resolveCombatDamage({
      health: Math.min(maximumHealth, save.player.health),
      maximumHealth,
      armor: save.player.armor > 0
        ? { points: save.player.armor, maximumPoints: 100, durability: save.player.armor }
        : null,
    }, {
      amount: event.amount,
      kind: event.attack,
      armorPenetration: event.attack === 'projectile' ? 0.12 : 0.04,
    });
    save.player.health = damage.state.health;
    save.player.armor = damage.state.armor?.points ?? 0;
    if (damage.defeated) {
      void this.#resolvePlayerDefeat(save.wanted.level > 0 ? 'arrest' : 'death');
      return;
    }
    if (event.amount >= 12) {
      this.#ui.toast(`${event.role} hit · ${Math.ceil(save.player.health)} health`, 'warning');
    }
  }

  #tickWantedRuntime(snapshot: Readonly<WorldSnapshot>, deltaSeconds: number, _now: number): void {
    const save = this.#currentSave;
    const runtime = this.#wantedRuntime;
    if (!save || !runtime || deltaSeconds <= 0) return;
    const previous = runtime.getSnapshot();
    const visibleToPolice = previous.state.phase === 'pursuit' && this.#policeVisibleSeconds > 0;
    this.#policeVisibleSeconds = Math.max(0, this.#policeVisibleSeconds - deltaSeconds);
    const next = runtime.tick(deltaSeconds, {
      playerPosition: { x: snapshot.position.x, z: snapshot.position.z },
      visibleToPolice,
      roadblockCandidates: this.#roadblockCandidates(),
    });
    this.#applyWantedSnapshot(next);
    if (previous.state.level !== next.state.level || previous.state.phase !== next.state.phase) {
      if (next.state.level === 0) {
        this.#ui.toast('Wanted level cleared', 'success');
      } else if (next.state.phase === 'search') {
        this.#ui.toast('Line of sight broken · leave the search area', 'info');
      }
    }
  }

  #applyWantedSnapshot(snapshot: Readonly<WantedRuntimeSnapshot>, forceVisual = false): void {
    const save = this.#currentSave;
    if (!save) return;
    const responseChanged = save.wanted.level !== snapshot.state.level
      || save.wanted.phase !== snapshot.state.phase;
    this.#wantedSnapshot = snapshot;
    save.wanted = { ...snapshot.state };
    this.#world?.setPoliceResponsePlan(snapshot.police);
    if (forceVisual || responseChanged) {
      this.#world?.setPoliceResponse(snapshot.state.level, snapshot.state.phase);
    }
  }

  #roadblockCandidates(): readonly RoadblockCandidate[] {
    const graph = this.#roadGraph;
    if (!graph) return [];
    const nodes = new Map(graph.nodes.map((node) => [node.id, node.position]));
    return graph.edges.flatMap((edge) => {
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) return [];
      return [{
        id: `roadblock:${edge.id}`,
        position: {
          x: (from.x + to.x) / 2,
          z: (from.z + to.z) / 2,
        },
        heading: Math.atan2(to.x - from.x, to.z - from.z),
      }];
    });
  }

  async #resolvePlayerDefeat(outcome: 'death' | 'arrest'): Promise<void> {
    const save = this.#currentSave;
    const world = this.#world;
    const runtime = this.#wantedRuntime;
    if (!save || !world || !runtime || this.#defeatResolving) return;
    this.#defeatResolving = true;
    if (this.#missionRuntime?.activeMission?.status === 'active') {
      this.#missionRuntime.failMission(
        'player-defeat',
        outcome === 'arrest' ? 'Alex was arrested' : 'Alex was incapacitated',
      );
    }
    const penalty = runtime.resolveDefeat({
      cash: save.player.money,
      inventory: save.inventory,
    }, ITEMS, outcome);
    save.player.money = penalty.cash;
    save.inventory = penalty.inventory;
    save.player.health = calculateProgressionModifiers(
      progressionStateFromSave(save),
      save.ending,
    ).maximumHealth;
    save.player.armor = 0;
    this.#pendingCrimes.clear();
    this.#policeVisibleSeconds = 0;
    this.#applyWantedSnapshot(runtime.getSnapshot(), true);
    world.respawnPlayer(
      outcome === 'death' ? { x: -84, z: 102 } : { x: 96, z: -24 },
      outcome === 'death' ? Math.PI * 0.25 : -Math.PI * 0.5,
    );
    const loss = `$${penalty.cashLost.toLocaleString()} lost`;
    if (outcome === 'death') {
      this.#ui.showDialogue('Solara Clinic', `Alex was stabilized. ${loss}; carried contraband was surrendered.`);
    } else {
      this.#ui.showDialogue('Solara Police', `Alex was released from booking. ${loss}; carried contraband was confiscated.`);
    }
    await this.#saveNow(false);
    this.#defeatResolving = false;
  }

  #initializeCampaignRuntime(save: SaveGameV1): void {
    this.#missionRecoveryInProgress = true;
    const missionRuntime = new MissionRuntime({ campaign: campaignStateFromSave(save) });
    const dialogueRuntime = new DialogueRuntime();
    this.#missionRuntime = missionRuntime;
    this.#dialogueRuntime = dialogueRuntime;
    this.#activeActivity = null;
    this.#missionTarget = null;
    this.#clearMissionCombatants();
    this.#missionEnvironmentBaseline = null;
    this.#collectibleRevealSignature = '';

    const activities = restoreActivityProgress(save.activities, ACTIVITIES);
    this.#activityProgress = activities.success
      ? activities.state
      : createActivityProgress(ACTIVITIES);
    if (!activities.success) console.warn('Activity progress was reset.', activities.errors);

    const collectibles = restoreCollectibleSaveFields(save.collectibles, COLLECTIBLES);
    this.#collectibleProgress = collectibles.success
      ? collectibles.state
      : createCollectibleProgress();
    if (!collectibles.success) console.warn('Collectible progress was reset.', collectibles.errors);

    this.#bindCampaignRuntimeEvents(missionRuntime, dialogueRuntime);
    if (save.missionRuntime !== null) {
      const restored = missionRuntime.restore(save.missionRuntime);
      if (!restored.success) console.warn(`Mission snapshot was reset: ${restored.reason}`);
    }
    missionRuntime.setPlayerLevel(save.player.level);
    if (save.dialogueRuntime !== null) {
      const restored = dialogueRuntime.restore(save.dialogueRuntime);
      if (!restored.success) console.warn(`Dialogue snapshot was reset: ${restored.reason}`);
    }
    this.#ensureActiveMissionItems();
    this.#syncMissionWorldTarget();
    this.#activateCurrentMissionWantedResponse(false);
    this.#syncCampaignSave();
    this.#missionRecoveryInProgress = false;
  }

  #bindCampaignRuntimeEvents(
    missionRuntime: MissionRuntime,
    dialogueRuntime: DialogueRuntime,
  ): void {
    missionRuntime.events.on('mission:started', ({ missionId }) => {
      dialogueRuntime.startMission(missionId);
      this.#clearMissionCombatants();
      this.#ensureActiveMissionItems();
      this.#syncMissionWorldTarget();
      this.#activateCurrentMissionWantedResponse(true);
      this.#syncCampaignSave();
      this.#showCurrentDialogue();
      const definition = MISSIONS.find((mission) => mission.id === missionId);
      this.#ui.toast(`${definition?.title ?? missionId} started · GPS updated`, 'info');
      this.#renderCampaignPanelIfOpen();
      void this.#saveNow(false);
    });
    missionRuntime.events.on('objective:progressed', () => {
      this.#syncMissionWorldTarget();
      this.#renderCampaignPanelIfOpen();
    });
    missionRuntime.events.on('objective:completed', ({ objectiveId }) => {
      const objective = missionRuntime.activeMissionDefinition?.objectives.find(
        (entry) => entry.id === objectiveId,
      );
      this.#clearMissionCombatants();
      this.#syncMissionWorldTarget();
      this.#activateCurrentMissionWantedResponse(true);
      this.#syncCampaignSave();
      this.#ui.toast(`${objective?.title ?? 'Objective'} complete`, 'success');
      this.#renderCampaignPanelIfOpen();
    });
    missionRuntime.events.on('checkpoint:reached', ({ checkpointId }) => {
      this.#syncCampaignSave();
      this.#ui.toast(`Checkpoint reached · ${checkpointId}`, 'success');
      void this.#saveNow(false);
    });
    missionRuntime.events.on('mission:failed', ({ reason }) => {
      this.#syncCampaignSave();
      this.#ui.toast(`Mission failed · ${reason}`, 'warning');
      this.#renderCampaignPanelIfOpen();
      void this.#saveNow(false);
    });
    missionRuntime.events.on('mission:retried', () => {
      this.#missionRecoveryInProgress = true;
      try {
        this.#clearMissionCombatants();
        this.#recoverMissionCheckpoint();
        this.#syncMissionWorldTarget(true);
        this.#activateCurrentMissionWantedResponse(true);
        this.#syncCampaignSave();
      } finally {
        this.#missionRecoveryInProgress = false;
      }
      this.#ui.toast('Checkpoint restored', 'info');
      this.#renderCampaignPanelIfOpen();
    });
    missionRuntime.events.on('reward:granted', (payload) => this.#grantMissionReward(payload));
    missionRuntime.events.on('mission:completed', ({ missionId }) => {
      if (dialogueRuntime.status === 'playing') dialogueRuntime.skip();
      this.#missionTarget = null;
      this.#clearMissionCombatants();
      this.#removeMissionQuestItems(missionId);
      this.#syncCampaignSave();
      const definition = MISSIONS.find((mission) => mission.id === missionId);
      this.#navigation?.clearWaypoint();
      this.#ui.toast(`${definition?.title ?? missionId} complete · rewards banked`, 'success');
      this.#renderCampaignPanelIfOpen();
      void this.#saveNow(false);
    });
    missionRuntime.events.on('mission:abandoned', ({ missionId }) => {
      this.#missionTarget = null;
      this.#clearMissionCombatants();
      this.#removeMissionQuestItems(missionId);
      dialogueRuntime.reset();
      this.#syncCampaignSave();
      this.#navigation?.clearWaypoint();
      this.#renderCampaignPanelIfOpen();
      void this.#saveNow(false);
    });
    missionRuntime.events.on('mission:environment', (state) => this.#applyMissionEnvironment(state));

    dialogueRuntime.events.on('dialogue:line', () => {
      this.#showCurrentDialogue();
      this.#syncCampaignSave();
      this.#renderCampaignPanelIfOpen();
    });
    dialogueRuntime.events.on('dialogue:reviewed', () => {
      this.#syncCampaignSave();
      this.#renderCampaignPanelIfOpen();
    });
    dialogueRuntime.events.on('dialogue:completed', () => {
      this.#syncCampaignSave();
      this.#renderCampaignPanelIfOpen();
    });
  }

  #startCampaignMission(missionId: MissionId): boolean {
    const runtime = this.#missionRuntime;
    if (!runtime) return false;
    const result = runtime.startMission(missionId);
    if (!result.success) {
      this.#ui.toast(result.reason, 'warning');
      return false;
    }
    return true;
  }

  #grantMissionReward(payload: MissionRuntimeEventMap['reward:granted']): void {
    const save = this.#currentSave;
    const runtime = this.#missionRuntime;
    if (!save || !runtime) return;
    // MissionRuntime commits campaign state before emitting rewards. Mirror that state
    // first so finale income, prices, wanted behavior, and other runtime modifiers use
    // the newly chosen ending immediately instead of waiting for the next reload.
    this.#syncCampaignSave();
    const modifiers = calculateProgressionModifiers(progressionStateFromSave(save), runtime.campaignState.ending);
    const propertyModifiers = resolvePropertyServiceModifiers(
      this.#economyState(save),
      PROPERTIES,
      runtime.campaignState.ending,
    );
    const reputationMultiplier = modifiers.contactReputationRewardMultiplier
      * propertyModifiers.contactReputationMultiplier;
    const bonusReputationMultiplier = Math.max(0, reputationMultiplier - 1);
    if (bonusReputationMultiplier > 0) {
      for (const [contact, amount] of Object.entries(payload.rewards.reputation)) {
        if ((contact === 'juno' || contact === 'malik' || contact === 'priya') && amount !== undefined) {
          runtime.addContactReputation(contact, amount, bonusReputationMultiplier);
        }
      }
    }
    const cash = Math.floor(payload.rewards.cash * modifiers.cashRewardMultiplier);
    save.player.money = Math.min(Number.MAX_SAFE_INTEGER, save.player.money + cash);
    const progression = grantXp(progressionStateFromSave(save), payload.rewards.xp);
    applyProgressionStateToSave(save, progression.state);
    runtime.setPlayerLevel(progression.state.level);
    for (const grant of payload.rewards.items) {
      this.#grantItemToBackpackOrStash(grant.itemId, grant.quantity);
    }
    const payouts = accruePropertyPayouts(this.#economyState(save), PROPERTIES, 1);
    this.#commitEconomy(payouts);
    this.#applyProgressionRuntimeModifiers();
    this.#syncWorldQuickLoadout();
    this.#syncCampaignSave();
    this.#refreshNavigationMarkers();
    this.#audio.playSfx('cash');
  }

  #applyMissionEnvironment(state: Readonly<MissionEnvironmentState>): void {
    const world = this.#world;
    if (!world) return;
    if (state.phase === 'cleanup') {
      const baseline = this.#missionEnvironmentBaseline;
      world.setEnvironment({
        ...(baseline ? { timeOfDay: baseline.timeOfDay, rainIntensity: baseline.rainIntensity } : {}),
        clockRate: 1 / (24 * 60),
      });
      this.#missionEnvironmentBaseline = null;
      return;
    }
    const snapshot = world.getSnapshot();
    this.#missionEnvironmentBaseline ??= {
      timeOfDay: snapshot.timeOfDay,
      rainIntensity: snapshot.rainIntensity,
    };
    world.setEnvironment({
      ...(state.timeOverride ? { timeOfDay: missionTimeOfDay(state.timeOverride) } : {}),
      ...(state.weatherOverride ? { rainIntensity: state.weatherOverride === 'rain' ? 0.62 : 0 } : {}),
      clockRate: 0,
    });
  }

  #activateCurrentMissionWantedResponse(force: boolean): void {
    const objective = this.#missionRuntime?.activeObjectiveIds()
      .map((id) => this.#missionRuntime?.activeMissionDefinition?.objectives.find((entry) => entry.id === id))
      .find((entry) => entry?.completion.kind === 'lose-wanted');
    const level = objective?.initialWantedLevel;
    const runtime = this.#wantedRuntime;
    const world = this.#world;
    const save = this.#currentSave;
    if (!objective || level === undefined || !runtime || !world || !save) return;
    if (!force && save.wanted.level > 0) return;
    const position = world.getSnapshot().position;
    this.#pendingCrimes.clear();
    const wanted = runtime.escalate(
      level,
      { x: position.x, z: position.z },
      true,
      this.#roadblockCandidates(),
    );
    this.#policeVisibleSeconds = 6.5;
    this.#applyWantedSnapshot(wanted, true);
    this.#ui.toast(`Authored pursuit active · wanted level ${level}`, 'warning');
  }

  #showCurrentDialogue(): void {
    const entry = this.#dialogueRuntime?.currentLine;
    if (!entry) return;
    this.#ui.showDialogue(dialogueSpeakerLabel(entry), entry.text, 8_000);
  }

  #resumeDialoguePresentation(): void {
    this.#dialogueRuntime?.resume();
  }

  #syncCampaignSave(): void {
    const save = this.#currentSave;
    const runtime = this.#missionRuntime;
    const dialogue = this.#dialogueRuntime;
    if (!save || !runtime || !dialogue) return;
    const campaign = runtime.campaignState;
    save.missionRuntime = runtime.snapshot() as unknown as Readonly<Record<string, unknown>>;
    save.dialogueRuntime = dialogue.snapshot() as unknown as Readonly<Record<string, unknown>>;
    save.missions = Object.fromEntries(Object.entries(campaign.missions).flatMap(([missionId, progress]) => (
      progress ? [[missionId, {
        state: progress.state,
        checkpointId: progress.checkpointId,
        completedObjectives: [...progress.completedObjectives],
      }]] : []
    )));
    save.contacts = { ...campaign.contacts };
    save.ending = campaign.ending;
    save.worldFlags = {
      ...Object.fromEntries(Object.entries(save.worldFlags).filter(([, enabled]) => enabled)),
      ...Object.fromEntries(campaign.worldFlags.map((flag) => [flag, true])),
    };
    save.activities = createActivitySaveFields(this.#activityProgress, ACTIVITIES);
    save.collectibles = createCollectibleSaveFields(this.#collectibleProgress, COLLECTIBLES);
  }

  #tickCampaignRuntime(snapshot: Readonly<WorldSnapshot>, deltaSeconds: number): void {
    if (this.#missionRecoveryInProgress) return;
    const runtime = this.#missionRuntime;
    const active = runtime?.activeMission;
    const definition = runtime?.activeMissionDefinition;
    if (!runtime || !active || active.status !== 'active' || !definition) return;
    for (const targetId of this.#world?.getResolvedCombatantIds() ?? []) {
      if (!this.#missionCombatantIds.has(targetId)) continue;
      const resolved = this.#recordMissionCombatDefeat(targetId);
      this.#world?.despawnCombatant(targetId);
      if (resolved) this.#ui.toast('Hostile surrendered · encounter resolved', 'success');
    }
    const surviveObjective = runtime.activeObjectiveIds()
      .map((id) => definition.objectives.find((entry) => entry.id === id))
      .find((objective) => objective?.completion.kind === 'survive');
    const surviveDistance = surviveObjective && this.#missionTarget?.objectiveId === surviveObjective.id
      ? Math.hypot(
        snapshot.position.x - this.#missionTarget.position.x,
        snapshot.position.z - this.#missionTarget.position.z,
      )
      : 0;
    const ticked = runtime.tick(surviveObjective && surviveDistance > 38 ? 0 : deltaSeconds);
    if (!ticked.success || runtime.activeMission?.status !== 'active') return;
    for (const objectiveId of runtime.activeObjectiveIds()) {
      const objective = definition.objectives.find((entry) => entry.id === objectiveId);
      if (!objective) continue;
      const target = this.#missionTarget?.objectiveId === objectiveId ? this.#missionTarget : null;
      const distance = target
        ? Math.hypot(snapshot.position.x - target.position.x, snapshot.position.z - target.position.z)
        : Number.POSITIVE_INFINITY;
      if (objective.completion.kind === 'reach-destination'
        && distance <= objective.completion.radiusMeters) {
        runtime.updateObjective(objectiveId, { kind: 'position', distanceMeters: distance });
      }
      if (objective.completion.kind === 'lose-wanted') {
        const wantedLevel = this.#currentSave?.wanted.level ?? 0;
        if (wantedLevel <= objective.completion.maximumLevel) {
          runtime.updateObjective(objectiveId, { kind: 'wanted', level: wantedLevel });
        }
      }
      if (objective.type === 'eliminate' && distance <= 38) {
        this.#ensureMissionCombatEncounter(target?.position ?? snapshot.position);
      }
    }
    this.#syncMissionWorldTarget();
    this.#finishMissionIfReady();
  }

  #ensureMissionCombatEncounter(position: Readonly<{ x: number; z: number }>): void {
    if (this.#missionCombatantIds.size > 0) return;
    for (const id of this.#world?.seedCombatEncounter(position) ?? []) this.#missionCombatantIds.add(id);
    if (this.#missionCombatantIds.size > 0) {
      this.#ui.toast('Hostiles arrived · non-graphic encounter active', 'warning');
    }
  }

  #recordMissionCombatDefeat(targetId: string): boolean {
    if (!this.#missionCombatantIds.delete(targetId)) return false;
    const runtime = this.#missionRuntime;
    const definition = runtime?.activeMissionDefinition;
    const objectiveId = runtime?.activeObjectiveIds().find((id) => (
      definition?.objectives.find((entry) => entry.id === id)?.type === 'eliminate'
    ));
    const objective = definition?.objectives.find((entry) => entry.id === objectiveId);
    const progress = objectiveId ? runtime?.activeMission?.objectiveProgress[objectiveId] : undefined;
    if (!runtime || !objective || !progress) return false;
    if (objective.completion.kind === 'target-count') {
      runtime.updateObjective(objective.id, { kind: 'increment', amount: 1 });
    } else if (objective.completion.kind === 'all-targets') {
      const nextTarget = objective.targetIds.find((id) => !progress.completedTargetIds.includes(id));
      if (nextTarget) runtime.updateObjective(objective.id, { kind: 'target', targetId: nextTarget });
    }
    this.#syncMissionWorldTarget();
    this.#finishMissionIfReady();
    return true;
  }

  #clearMissionCombatants(): void {
    for (const targetId of this.#missionCombatantIds) this.#world?.despawnCombatant(targetId);
    this.#missionCombatantIds.clear();
  }

  #progressCurrentMissionObjective(force = false, choice?: 'rule' | 'expose'): boolean {
    const runtime = this.#missionRuntime;
    const definition = runtime?.activeMissionDefinition;
    const active = runtime?.activeMission;
    const objectiveId = runtime?.activeObjectiveIds()[0];
    const objective = definition?.objectives.find((entry) => entry.id === objectiveId);
    if (!runtime || !definition || !active || active.status !== 'active' || !objective) return false;
    const distance = this.#missionTarget && this.#lastWorldSnapshot
      ? Math.hypot(
        this.#lastWorldSnapshot.position.x - this.#missionTarget.position.x,
        this.#lastWorldSnapshot.position.z - this.#missionTarget.position.z,
      )
      : Number.POSITIVE_INFINITY;
    if (!force && objective.completion.kind !== 'choice-made'
      && distance > MISSION_INTERACTION_RADIUS_METERS) {
      this.#syncMissionWorldTarget(true);
      this.#ui.toast(`GPS set · ${Math.round(distance)} m to ${objective.title}`, 'info');
      return false;
    }
    const progress = active.objectiveProgress[objective.id];
    if (!progress) return false;
    if (!force && objective.type === 'eliminate') {
      const encounterPosition = this.#missionTarget?.position ?? this.#lastWorldSnapshot?.position;
      if (encounterPosition) this.#ensureMissionCombatEncounter(encounterPosition);
      this.#ui.toast('Resolve the marked encounter by surrender or non-graphic takedown', 'info');
      return false;
    }
    let result: ReturnType<MissionRuntime['updateObjective']>;
    switch (objective.completion.kind) {
      case 'all-targets': {
        const targetId = objective.targetIds.find((id) => !progress.completedTargetIds.includes(id));
        result = targetId
          ? runtime.updateObjective(objective.id, { kind: 'target', targetId })
          : runtime.updateObjective(objective.id, { kind: 'complete' });
        break;
      }
      case 'target-count':
        result = runtime.updateObjective(objective.id, { kind: 'increment', amount: 1 });
        break;
      case 'reach-destination':
        result = runtime.updateObjective(objective.id, { kind: 'position', distanceMeters: 0 });
        break;
      case 'survive':
        result = force
          ? runtime.updateObjective(objective.id, {
            kind: 'elapsed',
            seconds: Math.max(0, objective.completion.durationSeconds - progress.elapsedSeconds),
          })
          : { success: false, reason: 'Hold the marked area until the timer finishes' };
        break;
      case 'lose-wanted':
        result = force
          ? runtime.updateObjective(objective.id, { kind: 'wanted', level: 0 })
          : runtime.updateObjective(objective.id, {
            kind: 'wanted',
            level: this.#currentSave?.wanted.level ?? 0,
          });
        break;
      case 'choice-made':
        if (!choice) {
          this.#ui.toast('Choose Rule or Expose in the Jobs panel', 'info');
          return false;
        }
        result = runtime.updateObjective(objective.id, { kind: 'choice', choice });
        if (result.success) {
          this.#dialogueRuntime?.startMission(definition.id, { branch: choice });
          this.#showCurrentDialogue();
        }
        break;
      case 'composite':
        result = runtime.updateObjective(objective.id, { kind: 'complete' });
        break;
    }
    if (!result.success) {
      if (!force) this.#ui.toast(result.reason, 'warning');
      return false;
    }
    if (force && objective.completion.kind === 'lose-wanted' && this.#wantedRuntime) {
      this.#pendingCrimes.clear();
      this.#policeVisibleSeconds = 0;
      this.#applyWantedSnapshot(this.#wantedRuntime.clear(), true);
    }
    this.#syncMissionWorldTarget();
    this.#syncCampaignSave();
    this.#finishMissionIfReady();
    return true;
  }

  #finishMissionIfReady(): boolean {
    const runtime = this.#missionRuntime;
    if (!runtime?.activeMission || runtime.activeMission.status !== 'active'
      || runtime.activeObjectiveIds().length > 0) return false;
    const result = runtime.succeedMission();
    if (!result.success) return false;
    return true;
  }

  #syncMissionWorldTarget(forceWaypoint = false): void {
    const runtime = this.#missionRuntime;
    const definition = runtime?.activeMissionDefinition;
    const active = runtime?.activeMission;
    const objectiveId = runtime?.activeObjectiveIds()[0];
    const objective = definition?.objectives.find((entry) => entry.id === objectiveId);
    if (!runtime || !definition || !active || active.status !== 'active' || !objective
      || objective.completion.kind === 'choice-made' || objective.completion.kind === 'composite') {
      this.#missionTarget = null;
      return;
    }
    const progress = active.objectiveProgress[objective.id];
    if (!progress) return;
    const targetIndex = objective.completion.kind === 'all-targets'
      ? progress.completedTargetIds.length
      : objective.completion.kind === 'target-count' ? Math.floor(progress.current) : 0;
    const targetId = objective.targetIds[targetIndex % Math.max(1, objective.targetIds.length)] ?? objective.id;
    const position = missionObjectivePosition(definition, objective, targetIndex);
    const unchanged = this.#missionTarget?.objectiveId === objective.id
      && this.#missionTarget.targetIndex === targetIndex;
    this.#missionTarget = {
      missionId: definition.id,
      objectiveId: objective.id,
      targetId,
      targetIndex,
      position,
    };
    if (!unchanged || forceWaypoint) {
      this.#navigation?.setWaypoint({
        id: `mission:${objective.id}:${targetIndex}`,
        label: objective.title,
        position,
        source: 'mission',
      });
    }
  }

  #recoverMissionCheckpoint(): void {
    const runtime = this.#missionRuntime;
    const definition = runtime?.activeMissionDefinition;
    const checkpointId = runtime?.activeMission?.checkpoint.checkpointId;
    const checkpoint = definition?.checkpoints.find((entry) => entry.id === checkpointId)
      ?? definition?.checkpoints[0];
    if (!checkpoint || !this.#currentSave) return;
    this.#world?.recoverToSafePosition({ x: checkpoint.respawn.x, z: checkpoint.respawn.z });
    const modifiers = calculateProgressionModifiers(
      progressionStateFromSave(this.#currentSave),
      this.#currentSave.ending,
    );
    this.#currentSave.player.health = modifiers.maximumHealth * checkpoint.restore.healthPercent / 100;
    this.#currentSave.player.armor = checkpoint.restore.armorPercent;
    if (checkpoint.restore.vehicleHealthPercent !== undefined) {
      this.#world?.restoreActiveVehicleCondition(checkpoint.restore.vehicleHealthPercent);
    }
    if (checkpoint.restore.refillMissionItems) this.#ensureActiveMissionItems();
  }

  #campaignHud(snapshot: Readonly<WorldSnapshot>): {
    objective: string | null;
    detail: string | null;
    interaction: string | null;
  } {
    if (snapshot.interiorId) {
      return { objective: null, detail: null, interaction: null };
    }
    if (this.#activeActivity) {
      const definition = ACTIVITIES.find((entry) => entry.id === this.#activeActivity?.run.activityId);
      const target = this.#activityTarget(this.#activeActivity);
      const distance = Math.hypot(snapshot.position.x - target.x, snapshot.position.z - target.z);
      return {
        objective: `${definition?.name ?? 'Activity'} · ${this.#activeActivity.step + 1}/${this.#activeActivity.run.objectiveTemplate.length}`,
        detail: `${this.#activeActivity.run.difficultyId} variant ${this.#activeActivity.run.variantIndex + 1} · ${Math.round(distance)} m`,
        interaction: distance <= MISSION_INTERACTION_RADIUS_METERS ? 'advance activity checkpoint' : null,
      };
    }
    const runtime = this.#missionRuntime;
    const active = runtime?.activeMission;
    const definition = runtime?.activeMissionDefinition;
    if (active && definition) {
      if (active.status === 'failed') {
        return {
          objective: `${definition.title} failed`,
          detail: 'Open Jobs to retry the latest checkpoint',
          interaction: null,
        };
      }
      const objectiveId = runtime?.activeObjectiveIds()[0];
      const objective = definition.objectives.find((entry) => entry.id === objectiveId);
      const progress = objectiveId ? active.objectiveProgress[objectiveId] : undefined;
      if (objective && progress) {
        const distance = this.#missionTarget
          ? Math.hypot(
            snapshot.position.x - this.#missionTarget.position.x,
            snapshot.position.z - this.#missionTarget.position.z,
          )
          : null;
        const progressLabel = progress.target > 1
          ? ` · ${Math.floor(progress.current)}/${Math.floor(progress.target)}`
          : '';
        return {
          objective: `${definition.title} · ${objective.title}`,
          detail: `${objective.description}${distance === null ? '' : ` · ${Math.round(distance)} m`}${progressLabel}`,
          interaction: distance !== null && distance <= MISSION_INTERACTION_RADIUS_METERS
            && objective.completion.kind !== 'survive'
            ? `advance ${objective.title.toLowerCase()}`
            : null,
        };
      }
    }
    const nearby = this.#nearestCollectible(snapshot, COLLECTIBLE_INTERACTION_RADIUS_METERS);
    return nearby ? {
      objective: 'Free roam discovery',
      detail: `${nearby.definition.name} · ${Math.round(nearby.distance)} m`,
      interaction: `collect ${nearby.definition.name}`,
    } : { objective: null, detail: null, interaction: null };
  }

  #activityAccess(nowMs: number) {
    const save = this.#currentSave;
    return {
      level: save?.player.level ?? 1,
      nowMs,
      unlockedFlags: Object.entries(save?.worldFlags ?? {})
        .filter(([, enabled]) => enabled)
        .map(([flag]) => flag),
    };
  }

  #activityRewardContext() {
    const save = this.#currentSave;
    return {
      hustleLevel: save?.player.attributes.hustle ?? 1,
      sideHustle: save?.player.unlockedSkills.includes('streetcraft-side-hustle') ?? false,
      kingpin: save?.player.unlockedSkills.includes('streetcraft-kingpin') ?? false,
    };
  }

  #startRepeatableActivity(
    activityId: ActivityTypeId,
    difficultyId: ActivityDifficulty['id'],
  ): boolean {
    const save = this.#currentSave;
    if (!save) return false;
    if (this.#missionRuntime?.activeMission) {
      this.#ui.toast('Finish or abandon the active story mission first', 'warning');
      return false;
    }
    if (this.#activeActivity) {
      this.#ui.toast('Another activity is already active', 'warning');
      return false;
    }
    const nowMs = Date.now();
    const result = startActivity(this.#activityProgress, ACTIVITIES, {
      activityId,
      difficultyId,
      worldSeed: save.trafficSeed,
      access: this.#activityAccess(nowMs),
      rewardContext: this.#activityRewardContext(),
    });
    if (!result.success) {
      const reason = result.reason === 'cooldown'
        ? `Cooldown · ${formatDuration(result.cooldownRemainingMs)}`
        : result.reason === 'locked' ? 'Complete the linked story job first' : result.reason;
      this.#ui.toast(reason, 'warning');
      return false;
    }
    this.#activeActivity = { run: result.run, startedAtMs: nowMs, step: 0 };
    this.#setActivityWaypoint();
    if (this.#panelOpen) this.#ui.closePanel();
    this.#ui.toast(`${ACTIVITIES.find((entry) => entry.id === activityId)?.name ?? activityId} started`, 'info');
    return true;
  }

  #activityTarget(active: Readonly<ActiveActivityRun>): { x: number; z: number } {
    return resolveSolaraActivityTarget(
      active.run.district,
      active.run.seed,
      active.step,
    );
  }

  #setActivityWaypoint(): void {
    const active = this.#activeActivity;
    if (!active) return;
    const definition = ACTIVITIES.find((entry) => entry.id === active.run.activityId);
    this.#navigation?.setWaypoint({
      id: `activity:${active.run.runId}:${active.step}`,
      label: `${definition?.name ?? active.run.activityId} checkpoint ${active.step + 1}`,
      position: this.#activityTarget(active),
      source: 'mission',
    });
  }

  #advanceActiveActivity(force = false): boolean {
    const active = this.#activeActivity;
    if (!active) return false;
    const target = this.#activityTarget(active);
    const snapshot = this.#lastWorldSnapshot;
    const distance = snapshot
      ? Math.hypot(snapshot.position.x - target.x, snapshot.position.z - target.z)
      : Number.POSITIVE_INFINITY;
    if (!force && distance > MISSION_INTERACTION_RADIUS_METERS) {
      this.#setActivityWaypoint();
      this.#ui.toast(`Activity checkpoint · ${Math.round(distance)} m`, 'info');
      return false;
    }
    active.step += 1;
    if (active.step >= active.run.objectiveTemplate.length) return this.#completeActiveActivity();
    this.#setActivityWaypoint();
    this.#ui.toast(`Checkpoint ${active.step}/${active.run.objectiveTemplate.length}`, 'success');
    return true;
  }

  #completeActiveActivity(): boolean {
    const active = this.#activeActivity;
    const save = this.#currentSave;
    const definition = ACTIVITIES.find((entry) => entry.id === active?.run.activityId);
    if (!active || !save || !definition) return false;
    const nowMs = Date.now();
    const elapsedSeconds = Math.max(1, (nowMs - active.startedAtMs) / 1_000);
    const result = completeActivity(this.#activityProgress, ACTIVITIES, {
      activityId: active.run.activityId,
      difficultyId: active.run.difficultyId,
      worldSeed: save.trafficSeed,
      access: this.#activityAccess(nowMs),
      rewardContext: this.#activityRewardContext(),
      expectedRunId: active.run.runId,
      performance: definition.scoring === 'lowest-time'
        ? { timeSeconds: elapsedSeconds }
        : { score: Math.max(1, Math.round(1_000 * active.run.targetMultiplier - elapsedSeconds * 4)) },
    });
    if (!result.success) {
      this.#ui.toast(result.reason, 'warning');
      return false;
    }
    this.#activityProgress = result.state;
    save.player.money = Math.min(Number.MAX_SAFE_INTEGER, save.player.money + result.reward.cash);
    const progression = grantXp(progressionStateFromSave(save), result.reward.xp);
    applyProgressionStateToSave(save, progression.state);
    this.#missionRuntime?.setPlayerLevel(progression.state.level);
    const payouts = accruePropertyPayouts(this.#economyState(save), PROPERTIES, 1);
    this.#commitEconomy(payouts);
    this.#activeActivity = null;
    this.#navigation?.clearWaypoint();
    this.#syncCampaignSave();
    this.#audio.playSfx('cash');
    this.#ui.toast(`${definition.name} complete · $${result.reward.cash.toLocaleString('en-US')}`, 'success');
    this.#renderCampaignPanelIfOpen();
    void this.#saveNow(false);
    return true;
  }

  #updateCollectibleDiscovery(snapshot: Readonly<WorldSnapshot>): void {
    if (!this.#currentSave || snapshot.interiorId !== null) return;
    const scannerUnlocked = this.#currentSave.worldFlags['signal-scanner'] === true;
    const signature = [
      snapshot.district,
      Math.floor(snapshot.position.x / 18),
      Math.floor(snapshot.position.z / 18),
      scannerUnlocked,
    ].join(':');
    if (signature === this.#collectibleRevealSignature) return;
    this.#collectibleRevealSignature = signature;
    const revealedIds: string[] = [];
    const applyReveal = (event: Parameters<typeof revealCollectibles>[2]): void => {
      const result = revealCollectibles(this.#collectibleProgress, COLLECTIBLES, event);
      this.#collectibleProgress = result.state;
      revealedIds.push(...result.newlyRevealedIds);
    };
    applyReveal({
      kind: 'nearby',
      district: snapshot.district,
      x: snapshot.position.x,
      z: snapshot.position.z,
    });
    applyReveal({ kind: 'road-survey', district: snapshot.district });
    if (scannerUnlocked) {
      applyReveal({
        kind: 'signal-scan',
        district: snapshot.district,
        x: snapshot.position.x,
        z: snapshot.position.z,
        scannerUnlocked: true,
      });
    }
    if (revealedIds.length === 0) return;
    this.#syncCampaignSave();
    this.#refreshNavigationMarkers();
    this.#audio.playSfx('pickup');
    this.#ui.toast(
      revealedIds.length === 1 ? 'Discovery added to the map' : `${revealedIds.length} discoveries added to the map`,
      'info',
    );
    this.#renderCampaignPanelIfOpen();
  }

  #nearestCollectible(
    snapshot: Readonly<WorldSnapshot>,
    maximumDistance = Number.POSITIVE_INFINITY,
  ): { definition: (typeof COLLECTIBLES)[number]; distance: number } | null {
    const completed = new Set(this.#collectibleProgress.completedIds);
    let nearest: { definition: (typeof COLLECTIBLES)[number]; distance: number } | null = null;
    for (const definition of visibleCollectibles(this.#collectibleProgress, COLLECTIBLES)) {
      if (completed.has(definition.id) || definition.district !== snapshot.district) continue;
      const distance = Math.hypot(
        snapshot.position.x - definition.position.x,
        snapshot.position.z - definition.position.z,
      );
      if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) {
        nearest = { definition, distance };
      }
    }
    return nearest;
  }

  #completeCollectibleById(collectibleId: string, forceReveal = false): boolean {
    const save = this.#currentSave;
    const definition = COLLECTIBLES.find((entry) => entry.id === collectibleId);
    if (!save || !definition) return false;
    if (forceReveal && !this.#collectibleProgress.revealedIds.includes(collectibleId)) {
      const event = definition.revealRule === 'road-survey'
        ? { kind: 'road-survey' as const, district: definition.district }
        : definition.revealRule === 'signal-scan'
          ? {
            kind: 'signal-scan' as const,
            district: definition.district,
            x: definition.position.x,
            z: definition.position.z,
            scannerUnlocked: true,
          }
          : {
            kind: 'nearby' as const,
            district: definition.district,
            x: definition.position.x,
            z: definition.position.z,
          };
      this.#collectibleProgress = revealCollectibles(
        this.#collectibleProgress,
        COLLECTIBLES,
        event,
      ).state;
    }
    const warehouse = save.properties['breakwater-warehouse'];
    const result = completeCollectible(
      this.#collectibleProgress,
      COLLECTIBLES,
      COLLECTIBLE_SETS,
      collectibleId,
      {
        additionalSalvageComponents: save.player.unlockedSkills.includes('streetcraft-salvager') ? 1 : 0,
        salvageYieldMultiplier: warehouse?.owned ? warehouse.upgraded ? 1.5 : 1.2 : 1,
      },
    );
    if (!result.success) {
      if (!forceReveal) this.#ui.toast(result.reason, 'warning');
      return false;
    }
    this.#collectibleProgress = result.state;
    save.player.money = Math.min(Number.MAX_SAFE_INTEGER, save.player.money + result.reward.cash);
    const progression = grantXp(progressionStateFromSave(save), result.reward.xp);
    applyProgressionStateToSave(save, progression.state);
    this.#missionRuntime?.setPlayerLevel(progression.state.level);
    for (const grant of result.reward.items) this.#grantItemToBackpackOrStash(grant.itemId, grant.quantity);
    for (const flag of result.reward.unlockFlags) save.worldFlags[flag] = true;
    this.#syncCampaignSave();
    this.#refreshNavigationMarkers();
    this.#audio.playSfx('pickup');
    this.#ui.toast(
      result.categoryCompleted
        ? `${definition.name} collected · set complete`
        : `${definition.name} collected · ${result.categoryProgress.completed}/${result.categoryProgress.total}`,
      'success',
    );
    this.#renderCampaignPanelIfOpen();
    void this.#saveNow(false);
    return true;
  }

  #completeNearbyCollectible(): boolean {
    const snapshot = this.#lastWorldSnapshot;
    const nearest = snapshot
      ? this.#nearestCollectible(snapshot, COLLECTIBLE_INTERACTION_RADIUS_METERS)
      : null;
    return nearest ? this.#completeCollectibleById(nearest.definition.id) : false;
  }

  #handleCampaignWorldInteraction(): void {
    if (this.#completeNearbyCollectible()) return;
    if (this.#activeActivity) {
      this.#advanceActiveActivity();
      return;
    }
    this.#progressCurrentMissionObjective();
  }

  #syncWorldAudio(snapshot: Readonly<WorldSnapshot>): void {
    this.#audio.setWorldAudioState({
      active: !this.#paused && !this.#panelOpen && !this.#orientationBlocked,
      inVehicle: snapshot.mode === 'vehicle',
      speedKph: snapshot.speedKph,
      engineLoad: snapshot.mode === 'vehicle' ? Math.min(1, snapshot.speedKph / 120) : 0,
      rainIntensity: snapshot.rainIntensity,
      sirenActive: snapshot.vehicleSirenActive,
      interior: snapshot.interiorId !== null,
    });
    if (snapshot.vehicleSirenActive !== this.#lastVehicleSirenActive) {
      this.#lastVehicleSirenActive = snapshot.vehicleSirenActive;
      if (snapshot.vehicleSirenActive) this.#audio.playSfx('siren');
    }
  }

  #cycleRadio(): ReturnType<AudioEngine['cycleStation']> {
    const radio = this.#audio.cycleStation();
    this.#audio.playUi(radio.enabled ? 'confirm' : 'cancel');
    this.#ui.toast(
      radio.enabled ? `${radio.stationName} · ${radio.trackTitle}` : radio.stationName,
      'info',
    );
    return radio;
  }

  #syncOrientationBlock(): void {
    const blocked = this.#world !== null
      && this.#root.classList.contains('is-playing')
      && matchMedia('(pointer: coarse)').matches
      && matchMedia('(orientation: portrait)').matches;
    this.#orientationBlocked = blocked;
    this.#ui.setOrientationBlocked(blocked);
    if (!this.#world) return;
    this.#inputController?.releaseAll();
    if (blocked) {
      this.#audio.setWorldAudioState({ active: false });
      this.#world.pause();
      void this.#audio.suspend();
      return;
    }
    if (!this.#paused && !this.#panelOpen && !this.#failedStreamCellId) {
      if (this.#lastWorldSnapshot) this.#syncWorldAudio(this.#lastWorldSnapshot);
      this.#world.resume();
      this.#world.focus();
      void this.#audio.resume();
    }
  }

  #pause(): void {
    if (!this.#world) return;
    this.#paused = true;
    this.#inputController?.releaseAll();
    this.#audio.setWorldAudioState({ active: false });
    this.#world.pause();
    void this.#audio.suspend();
  }

  #resume(): void {
    if (!this.#world || this.#quitting) return;
    this.#paused = false;
    if (!this.#panelOpen && !this.#orientationBlocked && !this.#failedStreamCellId) {
      if (this.#lastWorldSnapshot) this.#syncWorldAudio(this.#lastWorldSnapshot);
      this.#world.resume();
      this.#world.focus();
      void this.#audio.resume();
    }
  }

  #openPanel(_panel: OverlayPanel): void {
    if (this.#quitting) return;
    this.#panelOpen = true;
    this.#inputController?.releaseAll();
    this.#audio.setWorldAudioState({ active: false });
    this.#world?.pause();
    this.#root.querySelector<HTMLElement>('[data-panel-body]')
      ?.classList.toggle('panel-body--map', _panel === 'map');
    if (_panel === 'map' && this.#lastWorldSnapshot) {
      this.#mapRenderer = null;
      this.#mapModel = null;
      this.#renderFullMap(
        this.#lastWorldSnapshot.interiorId
          ? (this.#lastExteriorSnapshot ?? this.#lastWorldSnapshot)
          : this.#lastWorldSnapshot,
      );
    }
    if (_panel === 'garage') {
      this.#renderGaragePanel();
    }
    if (_panel === 'skills') {
      this.#renderSkillsPanel();
    }
    if (_panel === 'inventory') {
      this.#renderInventoryPanel();
    }
    if (_panel === 'properties') {
      this.#renderEconomyPanel();
    }
    if (_panel === 'missions') {
      this.#renderCampaignPanel();
    }
  }

  #closePanel(): void {
    this.#panelOpen = false;
    this.#garagePanel = null;
    this.#skillsPanel = null;
    this.#inventoryPanel = null;
    this.#economyPanel = null;
    this.#campaignPanel = null;
    if (this.#world && !this.#paused && !this.#orientationBlocked && !this.#failedStreamCellId) {
      if (this.#lastWorldSnapshot) this.#syncWorldAudio(this.#lastWorldSnapshot);
      this.#world.resume();
      this.#world.focus();
    }
  }

  #renderGaragePanel(): void {
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    const save = this.#currentSave;
    const snapshot = this.#lastWorldSnapshot;
    if (!host || !save) return;
    if (snapshot?.interiorId !== 'moreno-garage') {
      this.#garagePanel = null;
      host.innerHTML = `
        <div class="garage-panel garage-panel--away">
          <p class="eyebrow">Service unavailable</p>
          <h3>Visit Moreno Garage</h3>
          <p>Park beside the purple service doorway in Arroyo Heights, enter on foot, then open this panel.</p>
        </div>
      `;
      return;
    }
    this.#garagePanel = new GaragePanel(host);
    this.#garagePanel.draw(this.#garageState(save), this.#nearbyRegistrationCandidate(snapshot));
  }

  #renderSkillsPanel(): void {
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    const save = this.#currentSave;
    if (!host || !save) return;
    this.#skillsPanel = new SkillsPanel(host);
    this.#skillsPanel.draw(progressionStateFromSave(save));
  }

  #renderCampaignPanelIfOpen(): void {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (this.#panelOpen && panel?.dataset.panel === 'missions') this.#renderCampaignPanel();
  }

  #renderCampaignPanel(): void {
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    const runtime = this.#missionRuntime;
    const dialogue = this.#dialogueRuntime;
    if (!host || !runtime || !dialogue) return;
    this.#campaignPanel = new CampaignPanel(host);
    this.#campaignPanel.draw(this.#campaignPanelModel(runtime, dialogue));
  }

  #campaignPanelModel(
    runtime: Readonly<MissionRuntime>,
    dialogue: Readonly<DialogueRuntime>,
  ): CampaignPanelModel {
    const campaign = runtime.campaignState;
    const active = runtime.activeMission;
    const activeDefinition = runtime.activeMissionDefinition;
    const missionLog = runtime.missionLog();
    const missionCards = missionLog.map((entry) => {
      const definition = MISSIONS.find((mission) => mission.id === entry.missionId)!;
      return {
        id: definition.id,
        number: definition.number,
        title: definition.title,
        subtitle: definition.subtitle,
        contact: contactLabel(definition.contact),
        district: DISTRICT_LABELS[definition.district],
        state: entry.state,
        gateReason: campaignGateReason(entry.gates),
        cashReward: definition.rewards.cash,
        xpReward: definition.rewards.xp,
      };
    });
    const objectives: ObjectiveCardModel[] = active && activeDefinition
      ? activeDefinition.objectives.map((objective) => {
        const progress = active.objectiveProgress[objective.id];
        const isActive = runtime.activeObjectiveIds().includes(objective.id);
        const distance = isActive && this.#missionTarget?.objectiveId === objective.id
          && this.#lastWorldSnapshot
          ? Math.hypot(
            this.#lastWorldSnapshot.position.x - this.#missionTarget.position.x,
            this.#lastWorldSnapshot.position.z - this.#missionTarget.position.z,
          )
          : null;
        return {
          id: objective.id,
          title: objective.title,
          description: objective.description,
          type: objective.type.replace('-', ' '),
          state: progress?.skipped ? 'skipped' : progress?.completed ? 'complete' : isActive ? 'active' : 'pending',
          current: progress?.current ?? 0,
          target: progress?.target ?? 1,
          distanceMeters: distance,
          actionLabel: !isActive || objective.completion.kind === 'choice-made'
            || objective.completion.kind === 'survive' || objective.type === 'eliminate'
            ? null
            : distance !== null && distance <= MISSION_INTERACTION_RADIUS_METERS
              ? 'Advance objective'
              : 'Track in world',
          choices: objective.completion.kind === 'choice-made'
            ? objective.completion.choices.filter(
              (choice): choice is 'rule' | 'expose' => choice === 'rule' || choice === 'expose',
            )
            : [],
        };
      })
      : [];
    const nowMs = Date.now();
    const activities = ACTIVITIES.map((definition) => {
      const progress = this.#activityProgress[definition.id];
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        completions: progress?.completions ?? 0,
        cooldownLabel: progress && progress.cooldownUntil > nowMs
          ? `${formatDuration(progress.cooldownUntil - nowMs)} cooldown`
          : null,
        bestLabel: definition.scoring === 'lowest-time'
          ? progress?.bestTimeSeconds === null || progress?.bestTimeSeconds === undefined
            ? null : `${progress.bestTimeSeconds.toFixed(1)} s best`
          : progress?.bestScore === null || progress?.bestScore === undefined
            ? null : `${progress.bestScore.toLocaleString('en-US')} best`,
        difficulties: definition.difficulties.map((difficulty) => {
          const availability = getActivityAvailability(
            this.#activityProgress,
            definition,
            difficulty.id,
            this.#activityAccess(nowMs),
          );
          return {
            id: difficulty.id,
            label: `${difficulty.id[0]!.toUpperCase()}${difficulty.id.slice(1)}`,
            available: availability.available && this.#activeActivity === null && runtime.activeMission === null,
            reason: activityAvailabilityReason(availability),
          };
        }),
      };
    });
    const collectibles = COLLECTIBLE_SETS.map((set) => {
      const progress = getCollectibleCategoryProgress(
        this.#collectibleProgress,
        COLLECTIBLES,
        set.category,
      );
      return {
        id: set.category,
        label: collectibleCategoryLabel(set.category),
        found: progress.completed,
        total: progress.total,
        completed: progress.completed === progress.total,
      };
    });
    const dialogueModel = (entry: DialogueEntry) => ({
      key: entry.key,
      missionTitle: MISSIONS.find((mission) => mission.id === entry.missionId)?.title ?? entry.missionId,
      speaker: dialogueSpeakerLabel(entry),
      text: entry.text,
    });
    return {
      missions: missionCards,
      activeMission: activeDefinition
        ? missionCards.find((mission) => mission.id === activeDefinition.id) ?? null
        : null,
      activeMissionStatus: active?.status ?? null,
      objectives,
      canFinishMission: Boolean(active?.status === 'active' && runtime.activeObjectiveIds().length === 0),
      contacts: { ...campaign.contacts },
      ending: campaign.ending,
      dialogue: {
        current: dialogue.currentLine ? dialogueModel(dialogue.currentLine) : null,
        hasNext: dialogue.progress.status === 'playing'
          && dialogue.progress.currentNumber < dialogue.progress.lineCount,
        history: dialogue.reviewEntries.map(dialogueModel),
      },
      activities,
      collectibles,
    };
  }

  readonly #onCampaignPanelClick = (event: Event): void => {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (!this.#panelOpen || panel?.dataset.panel !== 'missions') return;
    const action = parseCampaignPanelAction(event.target);
    if (!action) return;
    const runtime = this.#missionRuntime;
    const dialogue = this.#dialogueRuntime;
    if (!runtime || !dialogue) return;
    switch (action.type) {
      case 'start-mission':
        this.#startCampaignMission(action.missionId as MissionId);
        if (runtime.activeMission) this.#ui.closePanel();
        break;
      case 'objective-action': {
        const progressed = this.#progressCurrentMissionObjective();
        if (!progressed && runtime.activeMission?.status === 'active') this.#ui.closePanel();
        break;
      }
      case 'choose':
        this.#progressCurrentMissionObjective(false, action.choice);
        break;
      case 'finish-mission': {
        const result = runtime.succeedMission();
        if (!result.success) this.#ui.toast(result.reason, 'warning');
        break;
      }
      case 'retry-mission': {
        const result = runtime.retryMission();
        if (!result.success) this.#ui.toast(result.reason, 'warning');
        else this.#ui.closePanel();
        break;
      }
      case 'abandon-mission': {
        const result = runtime.abandonMission();
        if (!result.success) this.#ui.toast(result.reason, 'warning');
        else this.#ui.toast('Mission abandoned · progress reset to mission start', 'info');
        break;
      }
      case 'advance-dialogue':
        dialogue.advance();
        this.#showCurrentDialogue();
        break;
      case 'skip-dialogue':
        dialogue.skip();
        break;
      case 'start-activity':
        this.#startRepeatableActivity(
          action.activityId as ActivityTypeId,
          action.difficultyId as ActivityDifficulty['id'],
        );
        break;
    }
    this.#syncCampaignSave();
    this.#renderCampaignPanelIfOpen();
  };

  readonly #onSkillsPanelClick = (event: Event): void => {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (!this.#panelOpen || panel?.dataset.panel !== 'skills') return;
    const action = parseSkillsPanelAction(event.target);
    if (!action) return;
    const save = this.#currentSave;
    if (!save) return;
    const previousState = progressionStateFromSave(save);
    const result = action.type === 'attribute'
      ? purchaseAttribute(previousState, action.attributeId)
      : purchaseSkill(previousState, action.skillId, SKILL_NODES);
    if (!result.success) {
      this.#ui.toast(result.reason, 'warning');
      this.#renderSkillsPanel();
      return;
    }
    const previousModifiers = calculateProgressionModifiers(previousState, save.ending);
    const nextModifiers = calculateProgressionModifiers(result.state, save.ending);
    applyProgressionStateToSave(save, result.state);
    const capacity = updateBackpackGritCapacity(
      save.inventory,
      ITEMS,
      result.state.attributes.grit,
    );
    if (capacity.success) save.inventory = capacity.inventory;
    if (nextModifiers.maximumHealth > previousModifiers.maximumHealth) {
      save.player.health = Math.min(
        nextModifiers.maximumHealth,
        save.player.health + nextModifiers.maximumHealth - previousModifiers.maximumHealth,
      );
    }
    this.#applyProgressionRuntimeModifiers(nextModifiers);
    const label = action.type === 'attribute'
      ? `${action.attributeId[0]!.toUpperCase()}${action.attributeId.slice(1)} increased`
      : `${SKILL_NODES.find((definition) => definition.id === action.skillId)?.name ?? 'Skill'} unlocked`;
    this.#ui.toast(label, 'success');
    this.#renderSkillsPanel();
    void this.#saveNow(false);
  };

  #applyProgressionRuntimeModifiers(
    modifiers = this.#currentSave
      ? calculateProgressionModifiers(progressionStateFromSave(this.#currentSave), this.#currentSave.ending)
      : null,
  ): void {
    const save = this.#currentSave;
    if (!save || !modifiers) return;
    const propertyModifiers = resolvePropertyServiceModifiers(
      this.#economyState(save),
      PROPERTIES,
      save.ending,
    );
    this.#wantedSnapshot = this.#wantedRuntime?.setModifiers({
      nerve: save.player.attributes.nerve,
      ending: save.ending,
      heatGainMultiplier: 1,
      searchDurationMultiplier:
        (save.player.unlockedSkills.includes('driving-heat-sink') ? 0.82 : 1)
        * propertyModifiers.wantedSearchDurationMultiplier,
    }) ?? this.#wantedSnapshot;
    this.#world?.setProgressionModifiers?.({
      meleeDamageMultiplier: modifiers.meleeDamageMultiplier,
      weaponSpreadMultiplier: modifiers.weaponSpreadMultiplier,
      reloadTimeMultiplier: modifiers.reloadTimeMultiplier,
      vehicleStabilityMultiplier: modifiers.vehicleStabilityMultiplier,
      vehicleBrakingMultiplier: modifiers.vehicleBrakingMultiplier,
      vehicleDurabilityMultiplier: modifiers.vehicleDurabilityMultiplier,
      enemySuspicionTimeMultiplier: modifiers.enemySuspicionTimeMultiplier,
      crouchedNoiseMultiplier: save.player.unlockedSkills.includes('streetcraft-shadow') ? 0.8 : 1,
    });
  }

  #tacticalInventoryState(save: Readonly<SaveGameV1>): TacticalInventoryState {
    return {
      backpack: cloneSavedInventory(save.inventory),
      stash: save.stash.map((item) => ({ ...item })),
      trunks: Object.fromEntries(
        Object.entries(save.trunks).map(([id, trunk]) => [id, cloneSavedInventory(trunk)]),
      ),
      quickLoadout: {
        firearms: [...save.quickLoadout.firearms],
        melee: save.quickLoadout.melee,
        consumables: [...save.quickLoadout.consumables],
      },
      recipeUnlocks: { unlockedRecipeIds: [...save.unlockedRecipes] },
    };
  }

  #commitTacticalInventory(state: Readonly<TacticalInventoryState>): void {
    const save = this.#currentSave;
    if (!save) return;
    const fields = tacticalInventorySaveFields(state);
    save.inventory = fields.inventory;
    save.stash = fields.stash;
    save.trunks = fields.trunks;
    save.quickLoadout = fields.quickLoadout;
    save.unlockedRecipes = fields.unlockedRecipes;
  }

  #renderInventoryPanel(): void {
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    const save = this.#currentSave;
    if (!host || !save) return;
    const state = this.#tacticalInventoryState(save);
    if (this.#inventorySelection && !findTacticalItem(state, this.#inventorySelection)) {
      this.#inventorySelection = null;
    }
    const snapshot = this.#lastWorldSnapshot;
    const activeTrunkId = snapshot?.mode === 'vehicle' && snapshot.vehicleRegistered
      && state.trunks[snapshot.vehicleInstanceId]
      ? snapshot.vehicleInstanceId
      : null;
    this.#inventoryPanel = new InventoryPanel(host);
    this.#inventoryPanel.draw({
      tactical: state,
      selectedInstanceId: this.#inventorySelection,
      safehouseBench: snapshot?.interiorId === 'moreno-garage',
      activeTrunkId,
    });
  }

  readonly #onInventoryPanelClick = (event: Event): void => {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (!this.#panelOpen || panel?.dataset.panel !== 'inventory') return;
    const action = parseInventoryPanelAction(event.target);
    if (!action) return;
    const save = this.#currentSave;
    if (!save) return;
    let state = this.#tacticalInventoryState(save);
    const selected = this.#inventorySelection ? findTacticalItem(state, this.#inventorySelection) : null;
    let successLabel = '';
    let failureReason: string | null = null;

    if (action.type === 'select') {
      this.#inventorySelection = action.instanceId;
      this.#renderInventoryPanel();
      return;
    }

    if (action.type === 'move' || action.type === 'rotate' || action.type === 'split') {
      if (!selected || selected.container.kind !== 'backpack') {
        failureReason = 'Select a backpack item first.';
      } else if (action.type === 'move') {
        const moved = moveItem(
          state.backpack,
          ITEMS,
          selected.item.instanceId,
          action.x,
          action.y,
          selected.item.rotated,
        );
        if (moved.success) {
          state.backpack = moved.inventory;
          successLabel = 'Item moved';
        } else failureReason = moved.reason;
      } else if (action.type === 'rotate') {
        const moved = moveItem(
          state.backpack,
          ITEMS,
          selected.item.instanceId,
          selected.item.x,
          selected.item.y,
          !selected.item.rotated,
        );
        if (moved.success) {
          state.backpack = moved.inventory;
          successLabel = 'Item rotated';
        } else failureReason = moved.reason;
      } else {
        const quantity = Math.floor(selected.item.quantity / 2);
        const split = splitStack(
          state.backpack,
          ITEMS,
          selected.item.instanceId,
          quantity,
          this.#nextM5Id(`${selected.item.definitionId}-split`),
        );
        if (split.success) {
          state.backpack = split.inventory;
          successLabel = 'Stack split';
        } else failureReason = split.reason;
      }
    } else if (action.type === 'auto-sort') {
      const sorted = autoSortTacticalContainer(state, ITEMS, action.container);
      if (sorted.success) {
        state = sorted.state;
        successLabel = 'Container sorted';
      } else failureReason = sorted.reason;
    } else if (action.type === 'transfer' && selected) {
      const transfer = transferTacticalItem(state, ITEMS, {
        source: selected.container,
        destination: action.destination,
        instanceId: selected.item.instanceId,
        quantity: selected.item.quantity,
        destinationInstanceId: selected.item.instanceId,
      });
      if (transfer.success) {
        state = transfer.state;
        successLabel = `Moved to ${action.destination.kind}`;
      } else failureReason = transfer.reason;
    } else if (action.type === 'transfer-all') {
      const transfer = transferAllTacticalItems(state, ITEMS, action.source, action.destination);
      if (transfer.success) {
        state = transfer.state;
        successLabel = 'Items transferred';
      } else failureReason = transfer.reason;
    } else if (action.type === 'assign-loadout' || action.type === 'clear-loadout') {
      const itemId = action.type === 'clear-loadout' ? null : selected?.item.instanceId ?? null;
      const assigned = assignQuickLoadout(state, ITEMS, WEAPONS, action.slot, itemId);
      if (assigned.success) {
        state = assigned.state;
        successLabel = itemId ? 'Quick loadout updated' : 'Quick slot cleared';
      } else failureReason = assigned.reason;
    } else if (action.type === 'use' && selected) {
      if (selected.container.kind !== 'backpack') {
        failureReason = 'Consumables must be carried before use.';
      } else {
        const used = useConsumable(state.backpack, ITEMS, selected.item.instanceId, 1);
        if (used.success) {
          state.backpack = used.inventory;
          this.#applyConsumableEffect(used.usedDefinitionId);
          successLabel = `${ITEMS.find((item) => item.id === used.usedDefinitionId)?.name ?? 'Item'} used`;
        } else failureReason = used.reason;
      }
    } else if (action.type === 'repair' && selected) {
      if (selected.container.kind !== 'backpack') {
        failureReason = 'Repair targets and kits must be carried.';
      } else {
        const targetDefinition = ITEMS.find((item) => item.id === selected.item.definitionId);
        const kitDefinitionId = targetDefinition?.category === 'weapon'
          ? 'weapon-repair-kit'
          : targetDefinition?.category === 'armor' ? 'armor-repair-plate' : null;
        const kit = kitDefinitionId
          ? state.backpack.items.find((item) => item.definitionId === kitDefinitionId)
          : null;
        if (!kit) failureReason = 'No compatible repair item is carried.';
        else {
          const repaired = repairItemWithConsumable(
            state.backpack,
            ITEMS,
            selected.item.instanceId,
            kit.instanceId,
          );
          if (repaired.success) {
            state.backpack = repaired.inventory;
            successLabel = `Restored ${Math.round(repaired.restoredDurability)} durability`;
          } else failureReason = repaired.reason;
        }
      }
    } else if (action.type === 'craft') {
      const bench = this.#lastWorldSnapshot?.interiorId === 'moreno-garage' ? 'safehouse' : 'field';
      const crafted = craftUnlockedRecipe(
        state.backpack,
        ITEMS,
        RECIPES,
        state.recipeUnlocks,
        action.recipeId,
        bench,
        this.#nextM5Id(`crafted-${action.recipeId}`),
      );
      if (crafted.success) {
        state.backpack = crafted.inventory;
        successLabel = `${ITEMS.find((item) => item.id === crafted.produced.itemId)?.name ?? 'Item'} crafted`;
      } else failureReason = crafted.reason;
    } else if (action.type === 'transfer') {
      failureReason = 'Select an item to transfer.';
    }

    if (failureReason) {
      this.#ui.toast(failureReason, 'warning');
      this.#renderInventoryPanel();
      return;
    }
    this.#commitTacticalInventory(state);
    if (this.#inventorySelection && !findTacticalItem(state, this.#inventorySelection)) {
      this.#inventorySelection = null;
    }
    this.#syncWorldQuickLoadout();
    this.#ui.toast(successLabel || 'Inventory updated', 'success');
    this.#renderInventoryPanel();
    void this.#saveNow(false);
  };

  readonly #onInventoryDragStart = (event: DragEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('.inventory-item[data-instance-id]')) return;
    const instanceId = target.dataset.instanceId;
    if (!instanceId || !event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', instanceId);
  };

  readonly #onInventoryDragOver = (event: DragEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-inventory-action="move"]')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  };

  readonly #onInventoryDrop = (event: DragEvent): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-inventory-action="move"]')) return;
    const instanceId = event.dataTransfer?.getData('text/plain');
    if (!instanceId) return;
    event.preventDefault();
    this.#inventorySelection = instanceId;
    this.#onInventoryPanelClick(event);
  };

  #applyConsumableEffect(definitionId: string): void {
    const save = this.#currentSave;
    if (!save) return;
    const maximumHealth = calculateProgressionModifiers(
      progressionStateFromSave(save),
      save.ending,
    ).maximumHealth;
    if (definitionId === 'medkit') {
      const healingMultiplier = resolvePropertyServiceModifiers(
        this.#economyState(save),
        PROPERTIES,
        save.ending,
      ).foodHealingMultiplier;
      save.player.health = Math.min(maximumHealth, save.player.health + 45 * healingMultiplier);
    }
    if (definitionId === 'armor-repair-plate') save.player.armor = Math.min(100, save.player.armor + 35);
  }

  #syncWorldQuickLoadout(): void {
    const save = this.#currentSave;
    if (!save) return;
    const equipped = [
      save.quickLoadout.melee,
      ...save.quickLoadout.firearms,
    ].flatMap((instanceId) => {
      const item = save.inventory.items.find((candidate) => candidate.instanceId === instanceId);
      return item ? [item.definitionId] : [];
    });
    this.#world?.setCombatLoadout?.(equipped);
  }

  #economyState(save: Readonly<SaveGameV1>): EconomyState {
    return {
      cash: save.player.money,
      properties: Object.fromEntries(
        Object.entries(save.properties).map(([id, property]) => [id, { ...property }]),
      ),
    };
  }

  #commitEconomy(state: Readonly<EconomyState>): void {
    const save = this.#currentSave;
    if (!save) return;
    save.player.money = state.cash;
    save.properties = Object.fromEntries(
      Object.entries(state.properties).map(([id, property]) => [id, { ...property }]),
    );
  }

  #renderEconomyPanel(): void {
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    const save = this.#currentSave;
    if (!host || !save) return;
    const inventoryCanAccept = Object.fromEntries(ITEMS.map((definition) => {
      const result = addItem(save.inventory, ITEMS, {
        definitionId: definition.id,
        quantity: 1,
        instanceIdBase: `preview-${definition.id}`,
      });
      return [definition.id, result.success];
    }));
    this.#economyPanel = new EconomyPanel(host);
    this.#economyPanel.draw({
      economy: this.#economyState(save),
      ending: save.ending,
      progression: progressionStateFromSave(save),
      inventoryCanAccept,
    });
  }

  readonly #onEconomyPanelClick = (event: Event): void => {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (!this.#panelOpen || panel?.dataset.panel !== 'properties') return;
    const action = parseEconomyPanelAction(event.target);
    if (!action) return;
    const save = this.#currentSave;
    if (!save) return;
    let economy = this.#economyState(save);
    let successLabel = '';
    let failureReason: string | null = null;
    if (action.type === 'buy-item') {
      const definition = ITEMS.find((item) => item.id === action.itemId);
      if (!definition) failureReason = 'Shop item is unavailable.';
      else {
        const added = addItem(save.inventory, ITEMS, {
          definitionId: definition.id,
          quantity: 1,
          instanceIdBase: this.#nextM5Id(`shop-${definition.id}`),
        });
        if (!added.success) failureReason = added.reason;
        else {
          const purchased = purchaseShopItem(economy, definition, 1, {
            market: action.market,
            legitimateDiscountPercent: save.player.unlockedSkills.includes('streetcraft-silver-tongue') ? 10 : 0,
            ending: save.ending,
          });
          if (!purchased.success) failureReason = purchased.reason;
          else {
            economy = purchased.state;
            save.inventory = added.inventory;
            successLabel = `${definition.name} purchased · $${purchased.cost.toLocaleString('en-US')}`;
          }
        }
      }
    } else if (action.type === 'purchase-property' || action.type === 'upgrade-property') {
      const definition = PROPERTIES.find((property) => property.id === action.propertyId);
      if (!definition) failureReason = 'Property is unavailable.';
      else {
        const transaction = action.type === 'purchase-property'
          ? purchaseProperty(economy, definition)
          : upgradeProperty(economy, definition);
        if (!transaction.success) failureReason = transaction.reason;
        else {
          economy = transaction.state;
          successLabel = action.type === 'purchase-property'
            ? `${definition.name} purchased`
            : `${definition.upgrade.name} installed`;
        }
      }
    } else {
      const collected = collectPropertyIncome(
        economy,
        PROPERTIES,
        action.type === 'collect-all' ? 'all' : action.propertyId,
        save.ending,
      );
      if (collected.amount <= 0) failureReason = 'No property income is ready.';
      else {
        economy = collected.state;
        for (const grant of collected.grants) this.#grantItemToBackpackOrStash(grant.itemId, grant.quantity);
        successLabel = `Collected $${collected.amount.toLocaleString('en-US')}`;
      }
    }
    if (failureReason) {
      this.#ui.toast(failureReason, 'warning');
      this.#renderEconomyPanel();
      return;
    }
    this.#commitEconomy(economy);
    this.#applyProgressionRuntimeModifiers();
    this.#ui.toast(successLabel, 'success');
    this.#renderEconomyPanel();
    void this.#saveNow(false);
  };

  #grantItemToBackpackOrStash(definitionId: string, quantity: number): void {
    const save = this.#currentSave;
    const definition = ITEMS.find((item) => item.id === definitionId);
    if (!save || !definition || quantity <= 0) return;
    const added = addItem(save.inventory, ITEMS, {
      definitionId,
      quantity,
      instanceIdBase: this.#nextM5Id(`grant-${definitionId}`),
    });
    if (added.success) {
      save.inventory = added.inventory;
      return;
    }
    appendAbstractStash(save.stash, definition, quantity, () => this.#nextM5Id(`stash-${definitionId}`));
  }

  #ensureActiveMissionItems(): void {
    const save = this.#currentSave;
    const definition = this.#missionRuntime?.activeMissionDefinition;
    if (!save || !definition) return;
    for (const grant of definition.missionItems ?? []) {
      const currentQuantity = [
        ...save.inventory.items,
        ...save.stash,
        ...Object.values(save.trunks).flatMap((trunk) => trunk.items),
      ]
        .filter((item) => item.definitionId === grant.itemId)
        .reduce((total, item) => total + item.quantity, 0);
      const missing = Math.max(0, grant.quantity - currentQuantity);
      if (missing > 0) this.#grantItemToBackpackOrStash(grant.itemId, missing);
    }
  }

  #removeMissionQuestItems(missionId: MissionId): void {
    const save = this.#currentSave;
    const definition = MISSIONS.find((mission) => mission.id === missionId);
    if (!save || !definition) return;
    const questItemIds = new Set((definition.missionItems ?? [])
      .filter((grant) => ITEMS.find((item) => item.id === grant.itemId)?.category === 'quest')
      .map((grant) => grant.itemId));
    if (questItemIds.size === 0) return;
    save.inventory = {
      ...save.inventory,
      items: save.inventory.items.filter((item) => !questItemIds.has(item.definitionId)),
    };
    save.stash = save.stash.filter((item) => !questItemIds.has(item.definitionId));
    save.trunks = Object.fromEntries(Object.entries(save.trunks).map(([vehicleId, trunk]) => [
      vehicleId,
      { ...trunk, items: trunk.items.filter((item) => !questItemIds.has(item.definitionId)) },
    ]));
  }

  #nextM5Id(prefix: string): string {
    this.#m5TransactionSequence += 1;
    return `${prefix}-${this.#activeSlot ?? 0}-${this.#m5TransactionSequence}`;
  }

  #garageState(save: Readonly<SaveGameV1>): GarageState {
    const propertyModifiers = resolvePropertyServiceModifiers(
      this.#economyState(save),
      PROPERTIES,
      save.ending,
    );
    return {
      cash: save.player.money,
      trunkRowBonus: save.player.unlockedSkills.includes('driving-trunk-master') ? 1 : 0,
      vehicleRepairDiscountPercent: propertyModifiers.vehicleRepairDiscountPercent,
      ownedVehicles: save.ownedVehicles,
      trunks: save.trunks,
    };
  }

  #nearbyRegistrationCandidate(
    snapshot: Readonly<WorldSnapshot>,
  ): NearbyUnregisteredVehicle | null {
    if (snapshot.vehicleRegistered) return null;
    const distanceToServiceBay = Math.hypot(
      snapshot.vehiclePosition.x - VEHICLE_SPAWN.x,
      snapshot.vehiclePosition.z - VEHICLE_SPAWN.z,
    );
    if (distanceToServiceBay > 18) return null;
    return {
      instanceId: snapshot.vehicleInstanceId,
      definitionId: snapshot.vehicleClassId,
      registrationDiscountPercent: this.#currentSave
        ? resolvePropertyServiceModifiers(
          this.#economyState(this.#currentSave),
          PROPERTIES,
          this.#currentSave.ending,
        ).vehicleRegistrationDiscountPercent
        : 0,
    };
  }

  readonly #onGaragePanelClick = (event: Event): void => {
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (!this.#panelOpen || panel?.dataset.panel !== 'garage') return;
    const action = parseGaragePanelAction(event.target);
    if (!action) return;
    const save = this.#currentSave;
    const snapshot = this.#lastWorldSnapshot;
    if (!save || snapshot?.interiorId !== 'moreno-garage') {
      this.#ui.toast('Vehicle service is available inside Moreno Garage.', 'warning');
      return;
    }
    const state = this.#garageState(save);
    let result: GarageTransactionResult;
    let successLabel: string;
    switch (action.type) {
      case 'register': {
        const candidate = this.#nearbyRegistrationCandidate(snapshot);
        if (
          !candidate
          || candidate.instanceId !== action.vehicleInstanceId
          || candidate.definitionId !== action.vehicleDefinitionId
        ) {
          this.#ui.toast('That vehicle is no longer in the service bay.', 'warning');
          this.#renderGaragePanel();
          return;
        }
        result = registerVehicle(state, VEHICLES, {
          instanceId: candidate.instanceId,
          definitionId: candidate.definitionId,
          bodyHealth: snapshot.vehicleIntegrity.bodyHealth,
          engineHealth: snapshot.vehicleIntegrity.engineHealth,
          tireHealth: snapshot.vehicleIntegrity.tireHealth,
          paint: isGaragePaint(snapshot.vehiclePaint) ? snapshot.vehiclePaint : 'factory',
        });
        successLabel = 'Vehicle registered';
        break;
      }
      case 'upgrade':
        result = applyVehicleUpgrade(state, VEHICLES, {
          instanceId: action.vehicleInstanceId,
          upgrade: action.upgrade,
          targetTier: action.targetTier,
        });
        successLabel = `${action.upgrade} upgraded`;
        break;
      case 'repair-all':
        result = repairVehicle(state, VEHICLES, {
          instanceId: action.vehicleInstanceId,
          scope: 'all',
        });
        successLabel = 'Vehicle repaired';
        break;
      case 'paint':
        result = repaintVehicle(
          state,
          VEHICLES,
          action.vehicleInstanceId,
          action.paint,
        );
        successLabel = 'Paint applied';
        break;
      case 'retrieve':
        result = retrieveVehicleFromGarage(state, action.vehicleInstanceId);
        successLabel = 'Vehicle retrieved';
        break;
    }
    this.#commitGarageTransaction(
      result,
      successLabel,
      action.type === 'retrieve' ? action.vehicleInstanceId : undefined,
    );
  };

  #commitGarageTransaction(
    result: Readonly<GarageTransactionResult>,
    successLabel: string,
    retrievedVehicleInstanceId?: string,
  ): void {
    const save = this.#currentSave;
    if (!save) return;
    if (!result.success) {
      this.#ui.toast(result.reason, 'warning');
      this.#renderGaragePanel();
      return;
    }
    save.player.money = result.state.cash;
    save.ownedVehicles = result.state.ownedVehicles;
    save.trunks = result.state.trunks;
    const activeSnapshot = this.#lastWorldSnapshot;
    const activeVehicle = retrievedVehicleInstanceId
      ? save.ownedVehicles.find((vehicle) => vehicle.instanceId === retrievedVehicleInstanceId)
      : activeSnapshot
        ? save.ownedVehicles.find((vehicle) => vehicle.instanceId === activeSnapshot.vehicleInstanceId)
        : undefined;
    const definition = activeVehicle ? getVehicle(activeVehicle.definitionId) : undefined;
    if (activeVehicle && definition) {
      const record: WorldVehicleInitialization = {
        instanceId: activeVehicle.instanceId,
        classId: definition.id,
        registered: activeVehicle.registered,
        integrity: {
          bodyHealth: activeVehicle.bodyHealth,
          engineHealth: activeVehicle.engineHealth,
          tireHealth: [...activeVehicle.tireHealth] as [number, number, number, number],
        },
        upgrades: {
          engine: activeVehicle.upgrades.engine,
          brakes: activeVehicle.upgrades.brakes,
          grip: activeVehicle.upgrades.grip,
          armor: activeVehicle.upgrades.armor,
        },
        paint: activeVehicle.upgrades.paint,
      };
      if (retrievedVehicleInstanceId) {
        this.#world?.selectActiveVehicleRecord(record);
      } else {
        this.#world?.applyActiveVehicleRecord(record);
      }
    }
    const costLabel = result.cost > 0 ? ` · $${result.cost.toLocaleString('en-US')}` : '';
    this.#ui.toast(`${successLabel}${costLabel}`, 'success');
    this.#renderGaragePanel();
    void this.#saveNow(false);
  }

  async #quitToMenu(): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.#ui.showPause();
    this.#ui.setQuitSavePending(true);
    const saved = await this.#saveNow(false);
    if (!saved) {
      this.#ui.setQuitSavePending(
        false,
        'Progress was not saved. Retry, or export the emergency save before closing this tab.',
      );
      this.#quitting = false;
      return;
    }
    this.#ui.setQuitSavePending(false);
    this.#ui.hidePause();
    this.#teardownWorld();
    this.#currentSave = null;
    this.#activeSlot = null;
    this.#ui.showMainMenu();
    this.#quitting = false;
  }

  async #deleteSlot(slot: SaveSlotId): Promise<void> {
    if (!globalThis.confirm(`Delete save slot ${slot}? This cannot be undone.`)) return;
    if (!this.#beginSaveMenuOperation()) return;
    try {
      try {
        await this.#saveService.deleteSlot(slot);
        this.#clearSlotPersistenceFailure(slot);
        this.#audio.playUi('cancel');
        await this.#showSaveSlots();
      } catch (error: unknown) {
        console.error(error);
        this.#recordPersistenceFailure(
          error,
          `Slot ${slot} could not be deleted. Its existing data was not changed.`,
          'delete-slot',
          slot,
        );
      }
    } finally {
      this.#endSaveMenuOperation();
    }
  }

  async #exportSaveSlot(slot: SaveSlotId): Promise<void> {
    if (!this.#beginSaveMenuOperation()) return;
    try {
      try {
        const serialized = await this.#saveService.exportSlot(slot);
        this.#downloadSaveJson(serialized, `heatline-solara-slot-${slot}.json`);
        this.#clearPersistenceFailure('load-slot', slot);
      } catch (error: unknown) {
        console.error(error);
        const message = error instanceof SaveSlotReadError
          ? error.code === 'unsupported-version'
            ? `Slot ${slot} could not be exported, but its newer-version data remains protected.`
            : `Slot ${slot} has no intact snapshot to export.`
          : `Slot ${slot} could not be read for export. Browser storage may be temporarily unavailable; no data was changed.`;
        this.#recordPersistenceFailure(
          error,
          message,
          'load-slot',
          slot,
        );
        await this.#showSaveSlots();
      }
    } finally {
      this.#endSaveMenuOperation();
    }
  }

  #inspectSaveImport(serialized: string): void {
    const result = this.#saveService.inspectImport(serialized);
    if (!result.success) {
      this.#ui.showSaveImportError(result.errors.join(' · '));
      return;
    }
    const save = result.save;
    this.#ui.showSaveImportReview({
      valid: true,
      title: `Level ${save.player.level} · ${save.slot.label || 'Solara story'}`,
      detail: `${DISTRICT_LABELS[save.activeDistrict]} · ${formatPreset(save.alexPreset)} · ${formatSavePlaytime(save.playtimeSeconds)}`,
      sourceSlot: save.slot.id,
      updatedAt: save.slot.updatedAt,
      migratedFromVersion: result.migratedFrom,
    });
  }

  async #importSave(serialized: string, destination: SaveSlotId): Promise<void> {
    const status = this.#slotStatuses.get(destination);
    if (status === 'corrupt' || status === 'unsupported-version') {
      this.#ui.showSaveImportError(
        `Slot ${destination} is protected. Export or delete its existing data before importing.`,
      );
      return;
    }
    if (
      (status === 'ready' || status === 'recovered')
      && !globalThis.confirm(`Replace save slot ${destination} with this imported save?`)
    ) {
      return;
    }
    if (!this.#beginSaveMenuOperation()) return;
    try {
      try {
        await this.#saveService.importIntoSlot(serialized, destination, Date.now());
        this.#clearSlotPersistenceFailure(destination);
        this.#ui.resetSaveImport();
        await this.#showSaveSlots();
      } catch (error: unknown) {
        console.error(error);
        this.#recordPersistenceFailure(
          error,
          `The import did not replace slot ${destination}. Review the file or delete protected slot data first.`,
          'import-slot',
          destination,
        );
        this.#ui.showSaveImportError(
          error instanceof SaveSlotReadError
            ? `Slot ${destination} is protected: ${error.message}`
            : `Import failed: ${errorMessage(error)}`,
        );
      }
    } finally {
      this.#endSaveMenuOperation();
    }
  }

  #downloadSaveJson(serialized: string, filename: string): void {
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async #saveNow(showToast: boolean): Promise<boolean> {
    if (!this.#currentSave) return false;
    this.#saveQueued = true;
    this.#saveToastQueued ||= showToast;
    if (this.#saveDrainPromise) return this.#saveDrainPromise;
    this.#saveDrainPromise = this.#drainSaveQueue();
    try {
      return await this.#saveDrainPromise;
    } finally {
      this.#saveDrainPromise = null;
    }
  }

  async #drainSaveQueue(): Promise<boolean> {
    let allWritesSucceeded = true;
    while (this.#saveQueued && this.#currentSave) {
      this.#saveQueued = false;
      const showToast = this.#saveToastQueued;
      this.#saveToastQueued = false;
      const save = this.#currentSave;
      try {
        this.#syncCampaignSave();
        save.slot.updatedAt = Date.now();
        await this.#saveService.saveSlot(save);
        this.#lastAutosaveAt = performance.now();
        this.#autosaveRetryAt = 0;
        this.#autosaveBlocked = false;
        this.#clearPersistenceFailure('save-slot', save.slot.id);
        if (showToast) this.#ui.toast(`Saved to slot ${save.slot.id}`, 'success');
      } catch (error: unknown) {
        console.error(error);
        allWritesSucceeded = false;
        const retryable = error instanceof PersistenceWriteError;
        this.#autosaveRetryAt = retryable
          ? performance.now() + AUTOSAVE_RETRY_MILLISECONDS
          : 0;
        this.#autosaveBlocked = !retryable;
        this.#saveQueued = false;
        this.#saveToastQueued = false;
        let emergencyExport = error instanceof PersistenceWriteError
          ? error.emergencyExport
          : null;
        if (this.#currentSave?.slot.id === save.slot.id) {
          // A second save request may have mutated the authoritative in-memory
          // state while the failed write was pending. Export that newest state,
          // not merely the older envelope captured when the write began.
          this.#syncCampaignSave();
          try {
            const refreshedExport = serializeSaveGame(this.#currentSave, true);
            if (this.#saveService.inspectImport(refreshedExport).success) {
              emergencyExport = refreshedExport;
            }
          } catch (exportError: unknown) {
            console.error('Could not refresh the emergency save export.', exportError);
          }
        }
        const failureMessage = error instanceof SaveSlotReadError
          ? error.code === 'unsupported-version'
            ? 'This slot contains data from a newer build and is protected. Current progress remains in this tab; export the emergency save to another slot.'
            : 'This slot contains damaged protected data. Current progress remains in this tab; export it before deleting or replacing the stored slot.'
          : error instanceof PersistenceWriteError
            ? 'Progress could not be saved. Keep this tab open or export the emergency save.'
            : 'Current progress failed save validation. Automatic saves are paused until the data is corrected.';
        this.#recordPersistenceFailure(
          error,
          failureMessage,
          'save-slot',
          save.slot.id,
          emergencyExport,
        );
      }
    }
    return allWritesSucceeded;
  }

  #isAutosaveSafe(snapshot: Readonly<WorldSnapshot>): boolean {
    return snapshot.activeCombatants === 0
      && snapshot.policePhase !== 'pursuit'
      && snapshot.interiorPhase !== 'loading-enter'
      && snapshot.interiorPhase !== 'loading-exit'
      && !this.#defeatResolving
      && !this.#missionRecoveryInProgress
      && !this.#streamRetryPending
      && this.#failedStreamCellId === null;
  }

  #recordPersistenceFailure(
    error: unknown,
    fallbackMessage: string,
    operation: PersistenceFailureOperation,
    slotId: SaveSlotId | null,
    emergencyExportOverride?: string | null,
  ): void {
    const message = error instanceof PersistenceWriteError && error.code === 'quota-exceeded'
      ? 'Browser storage is full. Progress remains in this tab; export the emergency save before closing it.'
      : fallbackMessage;
    const resolvedOperation = error instanceof PersistenceWriteError ? error.operation : operation;
    const resolvedSlotId = error instanceof PersistenceWriteError ? error.slotId : slotId;
    const failure: PersistenceFailureState = {
      operation: resolvedOperation,
      slotId: resolvedSlotId,
      message,
      emergencyExport: emergencyExportOverride !== undefined
        ? emergencyExportOverride
        : error instanceof PersistenceWriteError
          ? error.emergencyExport
          : error instanceof SaveSlotReadError
            ? error.preservedSnapshot
            : null,
      sequence: this.#persistenceFailureSequence += 1,
    };
    this.#persistenceFailures.set(
      this.#persistenceFailureKey(resolvedOperation, resolvedSlotId),
      failure,
    );
    this.#refreshPersistenceWarning();
  }

  #clearPersistenceFailure(
    operation: PersistenceFailureOperation,
    slotId: SaveSlotId | null,
  ): void {
    this.#persistenceFailures.delete(this.#persistenceFailureKey(operation, slotId));
    this.#refreshPersistenceWarning();
  }

  #clearSlotPersistenceFailure(slotId: SaveSlotId): void {
    for (const [key, failure] of this.#persistenceFailures) {
      if (failure.slotId === slotId) this.#persistenceFailures.delete(key);
    }
    this.#refreshPersistenceWarning();
  }

  #persistenceFailureKey(
    operation: PersistenceFailureOperation,
    slotId: SaveSlotId | null,
  ): string {
    return `${operation}:${slotId ?? 'settings'}`;
  }

  #refreshPersistenceWarning(): void {
    const failures = [...this.#persistenceFailures.values()];
    const failure = failures.sort((left, right) => {
      const leftHasRecovery = left.emergencyExport === null ? 0 : 1;
      const rightHasRecovery = right.emergencyExport === null ? 0 : 1;
      return rightHasRecovery - leftHasRecovery || right.sequence - left.sequence;
    })[0];
    if (failure) {
      this.#ui.showPersistenceWarning({
        message: failure.message,
        emergencyExport: failure.emergencyExport,
      });
    } else if (this.#persistenceMode === 'session-only') {
      this.#ui.showPersistenceWarning({
        message: 'Browser storage is unavailable. This session can be played, but progress will be lost when the tab closes.',
      });
    } else {
      this.#ui.clearPersistenceWarning();
    }
  }

  #touchAction(action: string, active: boolean): void {
    if (!isTouchControlAction(action)) return;
    this.#inputController?.setTouchAction(action, active);
  }

  #resolveQuality(): 'low' | 'high' {
    if (this.#settings.video.quality !== 'auto') return this.#settings.video.quality;
    return this.#softwareWebGlRenderer
      || matchMedia('(pointer: coarse)').matches
      || innerWidth < 900
      ? 'low'
      : 'high';
  }

  #applySettings(): void {
    const root = document.documentElement;
    const subtitleSize = { small: '0.78rem', medium: '0.9rem', large: '1.08rem' }[
      this.#settings.accessibility.subtitleSize
    ];
    root.style.setProperty('--ui-scale', String(this.#settings.accessibility.uiScale));
    root.style.setProperty('--touch-control-scale', String(this.#settings.controls.touchControlScale));
    root.style.setProperty('--touch-control-opacity', String(this.#settings.controls.touchControlOpacity));
    root.style.setProperty('--subtitle-size', subtitleSize);
    root.style.setProperty(
      '--subtitle-background',
      this.#settings.accessibility.subtitleBackground ? 'rgb(7 18 27 / 84%)' : 'transparent',
    );
    document.body.classList.toggle('high-contrast', this.#settings.accessibility.highContrastIndicators);
    document.body.classList.toggle('reduced-motion', this.#settings.accessibility.reducedMotion);
    this.#audio.setMix(this.#settings.audio);
  }

  #updateSettings(settings: GameSettings): void {
    const inputChanged = this.#settings.controls.mouseSensitivity !== settings.controls.mouseSensitivity
      || this.#settings.controls.touchSensitivity !== settings.controls.touchSensitivity
      || this.#settings.controls.invertY !== settings.controls.invertY
      || JSON.stringify(this.#settings.controls.bindings) !== JSON.stringify(settings.controls.bindings);
    this.#settings = settings;
    this.#applySettings();
    const resolutionScale = baseResolutionScaleForRuntime(
      settings.video.resolutionScale,
      settings.video.quality,
      this.#world?.layout.quality ?? this.#resolveQuality(),
      matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
      this.#softwareWebGlRenderer,
    );
    const adaptiveLimits = this.#cityStreaming?.setBaseResolutionScale(resolutionScale);
    this.#world?.setPresentation({
      reducedMotion: settings.accessibility.reducedMotion,
      cameraShake: settings.accessibility.cameraShake,
      resolutionScale: adaptiveLimits?.resolutionScale ?? resolutionScale,
    });
    if (this.#cityStreaming) this.#applyCityStreaming();
    if (this.#world && inputChanged) this.#rebindWorldInput();
    if (this.#settingsSaveTimer !== null) globalThis.clearTimeout(this.#settingsSaveTimer);
    this.#settingsSaveTimer = globalThis.setTimeout(() => {
      this.#settingsSaveTimer = null;
      void this.#flushSettings();
    }, 180);
  }

  async #flushSettings(): Promise<void> {
    if (this.#settingsSaveTimer !== null) {
      globalThis.clearTimeout(this.#settingsSaveTimer);
      this.#settingsSaveTimer = null;
    }
    try {
      await this.#saveService.saveSettings(this.#settings);
      this.#clearPersistenceFailure('save-settings', null);
    } catch (error: unknown) {
      console.error(error);
      this.#recordPersistenceFailure(
        error,
        'Settings could not be saved. Gameplay can continue with the current values in this tab.',
        'save-settings',
        null,
      );
    }
  }

  #bindGlobalEvents(): void {
    this.#root.addEventListener('click', this.#onGaragePanelClick);
    this.#root.addEventListener('click', this.#onSkillsPanelClick);
    this.#root.addEventListener('click', this.#onInventoryPanelClick);
    this.#root.addEventListener('click', this.#onEconomyPanelClick);
    this.#root.addEventListener('click', this.#onCampaignPanelClick);
    this.#root.addEventListener('dragstart', this.#onInventoryDragStart);
    this.#root.addEventListener('dragover', this.#onInventoryDragOver);
    this.#root.addEventListener('drop', this.#onInventoryDrop);
    globalThis.addEventListener('keydown', (event) => {
      if (!this.#world || event.repeat) return;
      if (this.#quitting) {
        event.preventDefault();
        return;
      }
      const pauseBinding = this.#settings.controls.bindings.pause.some(
        (binding) => binding.device === 'keyboard' && binding.code === event.code,
      );
      if ((event.code === 'Escape' || pauseBinding) && (this.#panelOpen || this.#paused)) {
        event.preventDefault();
        if (this.#panelOpen) this.#ui.closePanel();
        else {
          this.#ui.hidePause();
          this.#resume();
        }
      } else if (event.code === 'KeyJ') {
        event.preventDefault();
        this.#ui.openPanel('missions');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.#world && !this.#paused && !this.#orientationBlocked) {
        this.#ui.showPause();
        this.#pause();
        void this.#saveNow(false);
      }
    });

    globalThis.addEventListener('resize', () => this.#syncOrientationBlock());
    globalThis.addEventListener('orientationchange', () => this.#syncOrientationBlock());

    globalThis.addEventListener('pagehide', () => {
      void this.#saveNow(false);
      void this.#flushSettings();
    });

    globalThis.addEventListener('unload', () => this.#touchInput?.destroy(), { once: true });
  }

  #teardownWorld(): void {
    delete (globalThis as QaGlobal).__HEATLINE_QA__;
    this.#domInput?.destroy();
    this.#domInput = null;
    this.#touchInput?.destroy();
    this.#touchInput = null;
    this.#inputController?.releaseAll();
    this.#inputController = null;
    this.#navigation = null;
    this.#cityStreaming = null;
    this.#navigationUpdatePending = false;
    this.#queuedNavigationSnapshot = null;
    this.#navigationFailureNotified = false;
    this.#failedStreamCellId = null;
    this.#streamRetryPending = false;
    this.#roadGraph = null;
    this.#closedStreamEdgeIds.clear();
    this.#navigationDriveWaypointSet = false;
    this.#pendingCrimes.clear();
    this.#wantedRuntime = null;
    this.#wantedSnapshot = null;
    this.#missionRuntime = null;
    this.#dialogueRuntime = null;
    this.#campaignPanel = null;
    this.#activityProgress = createActivityProgress(ACTIVITIES);
    this.#collectibleProgress = createCollectibleProgress();
    this.#activeActivity = null;
    this.#missionTarget = null;
    this.#missionCombatantIds.clear();
    this.#missionEnvironmentBaseline = null;
    this.#missionRecoveryInProgress = false;
    this.#collectibleRevealSignature = '';
    this.#policeVisibleSeconds = 0;
    this.#defeatResolving = false;
    this.#ui.hideStreamFailure();
    this.#world?.dispose();
    this.#world = null;
    this.#syncOrientationBlock();
    this.#mapRenderer = null;
    this.#mapModel = null;
    this.#inventorySelection = null;
    this.#lastWorldSnapshot = null;
    this.#lastExteriorSnapshot = null;
    this.#lastVehicleSirenActive = false;
    this.#audio.setWorldAudioState({ active: false });
    this.#audio.stopRadio();
  }

  #timeLabel(normalized: number): string {
    const minutes = Math.floor(((normalized % 1) + 1) % 1 * 1_440);
    const hour = Math.floor(minutes / 60);
    return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  #createInputController(): InputController {
    return new InputController({
      inputMap: new InputMap(this.#settings.controls.bindings),
      mode: this.#inputMode,
      mouseRadiansPerPixel: 0.0032 * this.#settings.controls.mouseSensitivity,
      touchRadiansPerPixel: 0.006 * this.#settings.controls.touchSensitivity,
      invertY: this.#settings.controls.invertY,
    });
  }

  #consumeWorldInput(): ReturnType<typeof toWorldInputState> {
    const controller = this.#inputController;
    if (!controller) return createWorldInputState();
    controller.setMode(this.#inputMode);
    const frame = controller.consumeFrame();
    if (frame.actions.pause.justPressed) {
      this.#ui.showPause();
      this.#pause();
      return createWorldInputState();
    }
    if (frame.actions.map.justPressed) {
      this.#ui.openPanel('map');
      return createWorldInputState();
    }
    if (frame.actions.inventory.justPressed) {
      this.#ui.openPanel('inventory');
      return createWorldInputState();
    }
    if (frame.mode === 'vehicle' && frame.commands.weaponRadial.justPressed) {
      this.#cycleRadio();
    }
    const input = toWorldInputState(frame);
    if (input.interact) this.#handleCampaignWorldInteraction();
    return input;
  }

  #rebindWorldInput(): void {
    const world = this.#world;
    if (!world) return;
    this.#domInput?.destroy();
    this.#touchInput?.destroy();
    this.#inputController = this.#createInputController();
    this.#domInput = new DomInputAdapter(world.renderer.domElement, this.#inputController);
    this.#touchInput = new TouchInput(this.#root, this.#inputController);
    if (!this.#panelOpen && !this.#paused) world.focus();
  }

  #initializeNavigation(world: WorldView): void {
    this.#cityStreaming = new CityStreamingController({
      platform: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
      quality: world.layout.quality,
      baseResolutionScale: baseResolutionScaleForRuntime(
        this.#settings.video.resolutionScale,
        this.#settings.video.quality,
        world.layout.quality,
        matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
        this.#softwareWebGlRenderer,
      ),
    });
    const graph = buildRoadGraph(world.layout);
    this.#roadGraph = graph;
    const forcedFailureCell = forcedStreamCellFromLocation();
    let forcedFailuresRemaining = forcedFailureCell ? 3 : 0;
    const navigation = new NavigationRuntime({
      graph,
      loader: async (id) => {
        if (id === forcedFailureCell && forcedFailuresRemaining > 0) {
          forcedFailuresRemaining -= 1;
          throw new Error(`QA-injected stream failure for ${id}`);
        }
        return buildWorldChunkDefinition(world.layout, id);
      },
      platform: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop',
    });
    navigation.setMarkers(this.#buildNavigationMarkers());
    this.#navigation = navigation;
    if (this.#activeActivity) this.#setActivityWaypoint();
    else if (this.#missionRuntime?.activeMission) this.#syncMissionWorldTarget(true);
    else {
      navigation.setWaypoint({
        id: 'starter-car',
        label: 'Moreno Rook',
        position: { x: VEHICLE_SPAWN.x, z: VEHICLE_SPAWN.z },
        source: 'mission',
      });
    }
    this.#queueNavigationUpdate(world.getSnapshot());
  }

  #buildNavigationMarkers(): readonly MapMarker[] {
    const entranceFor = (interiorId: string) => {
      const definition = AUTHORED_INTERIORS.find(({ id }) => id === interiorId);
      if (!definition) throw new Error(`Missing authored ${interiorId} entrance`);
      return definition.portal;
    };
    const garage = entranceFor('moreno-garage');
    const juno = entranceFor('juno-grid');
    const malik = entranceFor('malik-office');
    const priya = entranceFor('priya-workshop');
    const markers: MapMarker[] = [
      {
        id: 'moreno-garage', kind: 'safehouse', label: 'Moreno Garage',
        position: { x: garage.position.x, z: garage.position.z },
        cellId: garage.cellId, reveal: 'always',
      },
      {
        id: 'juno-vale', kind: 'mission', label: 'Juno Vale',
        position: { x: juno.position.x, z: juno.position.z },
        cellId: juno.cellId, reveal: 'always',
      },
      {
        id: 'malik-rook', kind: 'mission', label: 'Malik Rook',
        position: { x: malik.position.x, z: malik.position.z },
        cellId: malik.cellId, reveal: 'always',
      },
      {
        id: 'priya-shah', kind: 'mission', label: 'Priya Shah',
        position: { x: priya.position.x, z: priya.position.z },
        cellId: priya.cellId, reveal: 'always',
      },
    ];
    const unlocked = new Set(
      Object.entries(this.#currentSave?.worldFlags ?? {})
        .filter(([, enabled]) => enabled)
        .map(([flag]) => flag),
    );
    ACTIVITIES.forEach((definition, index) => {
      if (!unlocked.has(definition.unlockFlag)) return;
      const district = definition.districts[0];
      if (district === undefined) return;
      const position = resolveSolaraActivityMarker(district, index);
      markers.push({
        id: `activity:${definition.id}`,
        kind: 'activity',
        label: definition.name,
        position,
        cellId: cellIdAt(position),
        reveal: 'always',
      });
    });
    for (const definition of visibleCollectibles(this.#collectibleProgress, COLLECTIBLES)) {
      if (this.#collectibleProgress.completedIds.includes(definition.id)) continue;
      const position = { x: definition.position.x, z: definition.position.z };
      markers.push({
        id: `collectible:${definition.id}`,
        kind: 'custom',
        label: definition.name,
        position,
        cellId: cellIdAt(position),
        reveal: 'always',
      });
    }
    return markers;
  }

  #refreshNavigationMarkers(): void {
    this.#navigation?.setMarkers(this.#buildNavigationMarkers());
  }

  #campaignQaSnapshot(): CampaignQaSnapshot {
    const runtime = this.#missionRuntime;
    const summary = runtime?.completionSummary();
    const active = runtime?.activeMission;
    return {
      activeMissionId: active?.missionId ?? null,
      activeMissionStatus: active?.status ?? null,
      activeObjectiveIds: runtime?.activeObjectiveIds() ?? [],
      availableMissionIds: runtime?.availableMissionIds() ?? [],
      completedMissionIds: summary?.completedMissionIds ?? [],
      checkpointId: active?.checkpoint.checkpointId ?? null,
      wantedLevel: this.#currentSave?.wanted.level ?? 0,
      contacts: runtime?.campaignState.contacts ?? { juno: 0, malik: 0, priya: 0 },
      ending: runtime?.campaignState.ending ?? null,
      storyComplete: summary?.storyComplete ?? false,
      postgameFreeRoam: summary?.postgameFreeRoam ?? false,
      reviewedDialogueKeys: this.#dialogueRuntime?.reviewedKeys ?? [],
    };
  }

  #contentQaSnapshot(): ContentQaSnapshot {
    return {
      activeActivityId: this.#activeActivity?.run.activityId ?? null,
      activityStep: this.#activeActivity?.step ?? 0,
      activities: Object.fromEntries(
        ACTIVITIES.map((definition) => [
          definition.id,
          this.#activityProgress[definition.id]?.completions ?? 0,
        ]),
      ),
      revealedCollectibles: this.#collectibleProgress.revealedIds.length,
      completedCollectibles: this.#collectibleProgress.completedIds.length,
      collectibleCategories: Object.fromEntries(COLLECTIBLE_SETS.map((set) => [
        set.category,
        getCollectibleCategoryProgress(this.#collectibleProgress, COLLECTIBLES, set.category),
      ])),
    };
  }

  #qaCompleteMission(choice: 'rule' | 'expose' = 'rule'): CampaignQaSnapshot {
    const initialMissionId = this.#missionRuntime?.activeMission?.missionId;
    if (!initialMissionId) throw new Error('QA complete mission requires an active mission');
    for (let step = 0; step < 128; step += 1) {
      const active = this.#missionRuntime?.activeMission;
      if (!active || active.missionId !== initialMissionId) return this.#campaignQaSnapshot();
      if (active.status === 'failed') {
        const retried = this.#missionRuntime?.retryMission();
        if (!retried?.success) throw new Error(retried?.reason ?? 'Mission retry failed');
        continue;
      }
      const objectiveIds = this.#missionRuntime?.activeObjectiveIds() ?? [];
      if (objectiveIds.length === 0) {
        const completed = this.#missionRuntime?.succeedMission();
        if (!completed?.success) throw new Error(completed?.reason ?? 'Mission completion failed');
        continue;
      }
      if (!this.#progressCurrentMissionObjective(true, choice)) {
        throw new Error(`QA could not advance objective ${objectiveIds[0]}`);
      }
    }
    throw new Error(`QA mission ${initialMissionId} exceeded its objective step budget`);
  }

  #installQaApi(world: WorldView): void {
    const parameters = new URLSearchParams(globalThis.location.search);
    if (parameters.get('qa') !== '1') return;
    const api: HeatlineQaApi = {
      teleport: (x, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          throw new TypeError('QA teleport coordinates must be finite');
        }
        if (Math.abs(x) > 599 || Math.abs(z) > 599) {
          throw new RangeError('QA teleport coordinates must stay inside Solara');
        }
        world.recoverToSafePosition({ x, z });
        return world.getSnapshot();
      },
      face: (x, z) => world.orientPlayerToward({ x, z }),
      snapshot: () => this.#world?.getSnapshot() ?? null,
      trafficVehicles: () => world.getCitySimulationSnapshot().traffic.map((vehicle) => ({
        id: vehicle.id,
        classId: vehicle.classId,
        behavior: vehicle.behavior,
        speed: vehicle.speed,
        heading: vehicle.heading,
        roadId: vehicle.roadId,
        x: vehicle.position.x,
        z: vehicle.position.z,
      })),
      trafficSignals: () => world.getTrafficSignalSnapshot().junctions.map((signal) => ({
        id: signal.id,
        x: signal.position.x,
        z: signal.position.z,
        phase: signal.phase,
        horizontalAspect: signal.horizontalAspect,
        verticalAspect: signal.verticalAspect,
        horizontalRoadIds: signal.horizontalRoadIds,
        verticalRoadIds: signal.verticalRoadIds,
        secondsUntilChange: signal.secondsUntilChange,
      })),
      pedestrians: () => world.getCitySimulationSnapshot().pedestrians.map((pedestrian) => ({
        id: pedestrian.id,
        behavior: pedestrian.behavior,
        x: pedestrian.position.x,
        z: pedestrian.position.z,
      })),
      setMoney: (value) => {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new RangeError('QA money must be a non-negative safe integer');
        }
        if (!this.#currentSave) throw new Error('QA money requires an active save');
        this.#currentSave.player.money = value;
        this.#onWorldSnapshot(world.getSnapshot());
        return value;
      },
      grantXp: (amount) => {
        if (!Number.isSafeInteger(amount) || amount < 0) {
          throw new RangeError('QA XP must be a non-negative safe integer');
        }
        const save = this.#currentSave;
        if (!save) throw new Error('QA XP requires an active save');
        const result = grantXp(progressionStateFromSave(save), amount);
        applyProgressionStateToSave(save, result.state);
        const capacity = updateBackpackGritCapacity(
          save.inventory,
          ITEMS,
          result.state.attributes.grit,
        );
        if (capacity.success) save.inventory = capacity.inventory;
        this.#applyProgressionRuntimeModifiers();
        this.#onWorldSnapshot(world.getSnapshot());
        return {
          level: result.state.level,
          xp: result.state.xp,
          attributePoints: result.state.attributePoints,
          skillPoints: result.state.skillPoints,
        };
      },
      inventoryState: () => {
        const save = this.#currentSave;
        if (!save) throw new Error('QA inventory requires an active save');
        return {
          itemCount: save.inventory.items.length,
          weightKg: inventoryWeight(save.inventory, ITEMS),
          quickLoadout: {
            firearms: [...save.quickLoadout.firearms],
            melee: save.quickLoadout.melee,
            consumables: [...save.quickLoadout.consumables],
          },
          unlockedRecipes: save.unlockedRecipes.length,
        };
      },
      accruePropertyPayouts: (count = 1) => {
        if (!Number.isSafeInteger(count) || count < 0 || count > 100) {
          throw new RangeError('QA property payouts must be an integer from 0 through 100');
        }
        const save = this.#currentSave;
        if (!save) throw new Error('QA property payouts require an active save');
        const state = accruePropertyPayouts(this.#economyState(save), PROPERTIES, count);
        this.#commitEconomy(state);
        return Object.fromEntries(
          Object.entries(state.properties).map(([id, property]) => [id, property.uncollectedPayouts]),
        );
      },
      setActiveVehicleClass: (classId) => {
        const definition = getVehicle(classId);
        if (!definition) throw new Error(`Unknown QA vehicle class: ${classId}`);
        const snapshot = world.getSnapshot();
        world.applyActiveVehicleRecord({
          instanceId: snapshot.vehicleInstanceId,
          classId: definition.id,
          registered: false,
          paint: 'factory',
          integrity: {
            bodyHealth: 100,
            engineHealth: 100,
            tireHealth: [100, 100, 100, 100],
          },
          upgrades: { engine: 0, brakes: 0, grip: 0, armor: 0 },
        });
        return world.getSnapshot();
      },
      setActiveVehicleCondition: (bodyHealth, engineHealth) => {
        if (
          !Number.isFinite(bodyHealth)
          || bodyHealth < 0
          || bodyHealth > 100
          || !Number.isFinite(engineHealth)
          || engineHealth < 0
          || engineHealth > 100
        ) {
          throw new RangeError('QA vehicle condition must stay between 0 and 100');
        }
        const snapshot = world.getSnapshot();
        const record = this.#currentSave?.ownedVehicles.find(
          (vehicle) => vehicle.instanceId === snapshot.vehicleInstanceId,
        );
        const definition = record ? getVehicle(record.definitionId) : undefined;
        if (!record || !definition) {
          throw new Error('QA vehicle condition requires a registered active vehicle');
        }
        record.bodyHealth = bodyHealth;
        record.engineHealth = engineHealth;
        world.applyActiveVehicleRecord({
          instanceId: record.instanceId,
          classId: definition.id,
          registered: record.registered,
          integrity: {
            bodyHealth,
            engineHealth,
            tireHealth: [...record.tireHealth] as [number, number, number, number],
          },
          upgrades: {
            engine: record.upgrades.engine,
            brakes: record.upgrades.brakes,
            grip: record.upgrades.grip,
            armor: record.upgrades.armor,
          },
        });
        return world.getSnapshot();
      },
      combatants: () => world.getCombatNpcSnapshot().map((combatant) => ({
        id: combatant.id,
        role: combatant.role,
        behavior: combatant.state,
        state: combatant.state,
        tactic: combatant.tactic,
        awareness: combatant.perception.awareness,
        health: combatant.health,
        heading: combatant.heading,
        x: combatant.position.x,
        z: combatant.position.z,
      })),
      seedCombatEncounter: (x, z) => world.seedCombatEncounter({ x, z }),
      selectWeapon: (weaponId) => {
        // The QA hook deliberately exposes the complete authored arsenal so
        // milestone acceptance can exercise weapon cycling independently of a
        // player's persisted M5 quick-loadout choices.
        world.setCombatLoadout(WORLD_COMBAT_WEAPON_ORDER);
        return world.selectCombatWeapon(weaponId);
      },
      damageCombatant: (targetId, amount) => {
        if (!Number.isFinite(amount) || amount < 0) {
          throw new RangeError('QA combat damage must be finite and non-negative');
        }
        return world.damageCombatant(targetId, amount);
      },
      setWantedLevel: (value) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > 5) {
          throw new RangeError('QA wanted level must be an integer from 0 through 5');
        }
        const save = this.#currentSave;
        const runtime = this.#wantedRuntime;
        if (!save || !runtime) throw new Error('QA wanted level requires an active save');
        const level = value as 0 | 1 | 2 | 3 | 4 | 5;
        const snapshot = world.getSnapshot();
        // Acceptance scenarios need an exact, deterministic response level.
        // Clear already-observed crimes and the previous ladder state first so
        // a delayed pedestrian report cannot race this explicit QA command.
        this.#pendingCrimes.clear();
        const cleared = runtime.clear();
        const next = level === 0
          ? cleared
          : runtime.escalate(
            level,
            { x: snapshot.position.x, z: snapshot.position.z },
            true,
            this.#roadblockCandidates(),
          );
        this.#policeVisibleSeconds = level === 0 ? 0 : 6.5;
        this.#applyWantedSnapshot(next, true);
        return { ...next.state };
      },
      advanceWanted: (seconds, isVisible = false, insideSearchArea = false) => {
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
          throw new RangeError('QA wanted advance must be between 0 and 600 seconds');
        }
        const save = this.#currentSave;
        const runtime = this.#wantedRuntime;
        if (!save || !runtime) throw new Error('QA wanted advance requires an active save');
        const current = world.getSnapshot().position;
        const radius = runtime.getSnapshot().searchRadius;
        const playerPosition = insideSearchArea || isVisible
          ? { x: current.x, z: current.z }
          : { x: current.x + radius + 500, z: current.z + radius + 500 };
        const next = runtime.tick(seconds, {
          playerPosition,
          visibleToPolice: isVisible,
          roadblockCandidates: this.#roadblockCandidates(),
        });
        this.#policeVisibleSeconds = isVisible ? 6.5 : 0;
        this.#applyWantedSnapshot(next, true);
        return { ...next.state };
      },
      advanceWorld: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10) {
          throw new RangeError('QA world advance must be between 0 and 10 seconds');
        }
        const save = this.#currentSave;
        if (!save) throw new Error('QA world advance requires an active save');
        // Release acceptance drives the same public WorldView update seam in
        // fixed steps so simulation-time state machines do not depend on RAF
        // throughput when multiple software-rendered browser workers contend.
        const stepCount = Math.ceil(seconds / 0.1);
        let simulatedSeconds = 0;
        for (let index = 0; index < stepCount; index += 1) {
          const stepSeconds = Math.min(0.1, seconds - simulatedSeconds);
          if (stepSeconds <= Number.EPSILON) break;
          world.update(stepSeconds);
          simulatedSeconds += stepSeconds;
        }
        return {
          simulatedSeconds,
          wantedLevel: save.wanted.level,
        };
      },
      setPlayerCondition: (health, armor) => {
        if (!Number.isFinite(health) || health < 0 || health > 150) {
          throw new RangeError('QA health must stay between 0 and 150');
        }
        if (!Number.isFinite(armor) || armor < 0 || armor > 100) {
          throw new RangeError('QA armor must stay between 0 and 100');
        }
        const save = this.#currentSave;
        if (!save) throw new Error('QA player condition requires an active save');
        save.player.health = health;
        save.player.armor = armor;
        this.#onWorldSnapshot(world.getSnapshot());
        return { health: save.player.health, armor: save.player.armor };
      },
      defeat: async (outcome) => {
        await this.#resolvePlayerDefeat(outcome);
        const save = this.#currentSave;
        if (!save) throw new Error('QA defeat requires an active save');
        return {
          health: save.player.health,
          money: save.player.money,
          wantedLevel: save.wanted.level,
        };
      },
      campaignState: () => this.#campaignQaSnapshot(),
      startMission: (missionId) => {
        const definition = MISSIONS.find((entry) => entry.id === missionId);
        if (!definition) throw new Error(`Unknown QA mission: ${missionId}`);
        if (!this.#startCampaignMission(definition.id)) {
          throw new Error(`QA mission ${missionId} could not start`);
        }
        return this.#campaignQaSnapshot();
      },
      advanceMissionObjective: (choice) => {
        if (!this.#progressCurrentMissionObjective(true, choice)) {
          throw new Error('QA could not advance the current mission objective');
        }
        return this.#campaignQaSnapshot();
      },
      failMission: (reason = 'QA checkpoint recovery') => {
        const result = this.#missionRuntime?.failMission('scripted', reason);
        if (!result?.success) throw new Error(result?.reason ?? 'QA mission failure could not be applied');
        return this.#campaignQaSnapshot();
      },
      retryMission: () => {
        const result = this.#missionRuntime?.retryMission();
        if (!result?.success) throw new Error(result?.reason ?? 'QA mission retry failed');
        return this.#campaignQaSnapshot();
      },
      completeMission: (choice = 'rule') => this.#qaCompleteMission(choice),
      startActivity: (activityId, difficultyId = 'rookie') => {
        const definition = ACTIVITIES.find((entry) => entry.id === activityId);
        const difficulty = definition?.difficulties.find((entry) => entry.id === difficultyId);
        if (!definition || !difficulty) throw new Error(`Unknown QA activity: ${activityId}/${difficultyId}`);
        if (!this.#startRepeatableActivity(definition.id, difficulty.id)) {
          throw new Error(`QA activity ${activityId} could not start`);
        }
        return this.#contentQaSnapshot();
      },
      completeActivity: () => {
        if (!this.#activeActivity) throw new Error('QA complete activity requires an active activity');
        for (let step = 0; step < 16 && this.#activeActivity; step += 1) {
          if (!this.#advanceActiveActivity(true)) throw new Error('QA activity step could not advance');
        }
        if (this.#activeActivity) throw new Error('QA activity exceeded its step budget');
        return this.#contentQaSnapshot();
      },
      collectCollectible: (collectibleId) => {
        if (!this.#completeCollectibleById(collectibleId, true)) {
          throw new Error(`QA collectible ${collectibleId} could not complete`);
        }
        return this.#contentQaSnapshot();
      },
      contentState: () => this.#contentQaSnapshot(),
      audioState: () => this.#audio.snapshot(),
      cycleRadio: () => this.#cycleRadio(),
      nextRadioTrack: () => this.#audio.nextTrack(),
    };
    (globalThis as QaGlobal).__HEATLINE_QA__ = api;
    const wantedPreview = Number(parameters.get('wanted'));
    if (Number.isSafeInteger(wantedPreview) && wantedPreview >= 1 && wantedPreview <= 5) {
      api.setWantedLevel(wantedPreview);
    }
  }

  #queueNavigationUpdate(snapshot: WorldSnapshot): void {
    if (!this.#navigation) return;
    this.#queuedNavigationSnapshot = snapshot;
    if (this.#navigationUpdatePending) return;
    this.#navigationUpdatePending = true;
    void this.#drainNavigationUpdates();
  }

  async #drainNavigationUpdates(): Promise<void> {
    const navigation = this.#navigation;
    if (!navigation) {
      this.#navigationUpdatePending = false;
      return;
    }
    try {
      while (this.#queuedNavigationSnapshot && this.#navigation === navigation) {
        const snapshot = this.#queuedNavigationSnapshot;
        this.#queuedNavigationSnapshot = null;
        const result = await navigation.update(
          { x: snapshot.position.x, z: snapshot.position.z },
          { x: snapshot.velocity.x, z: snapshot.velocity.z },
        );
        if (this.#navigation !== navigation) return;
        if (!result.transition.committed && result.safePosition) {
          this.#world?.recoverToSafePosition(result.safePosition);
        }
        this.#syncClosedRoadEdges(result.failures);
        const mount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
        if (mount) {
          mount.dataset.currentCell = result.currentCellId ?? '';
          mount.dataset.predictedCell = result.predictedCellId;
          mount.dataset.routeStatus = result.route.status;
          mount.dataset.routeSegments = String(result.route.gpsRoute?.segments.length ?? 0);
          mount.dataset.activeCells = String(navigation.chunkSnapshot().activeCellIds.length);
          mount.dataset.roadClosures = String(result.failures.roadClosures.length);
          mount.dataset.closedRoadEdges = String(this.#closedStreamEdgeIds.size);
        }
        const streaming = this.#cityStreaming;
        if (streaming && result.currentCellId) {
          streaming.syncFailureState(
            result.failures.failedBoundaries,
            result.failures.roadClosures,
            performance.now(),
          );
          const transition = streaming.updateCells(result.currentCellId, result.predictedCellId);
          this.#applyCityStreaming();
          if (mount) {
            mount.dataset.renderableCells = String(transition.snapshot.renderableActiveCellIds.length);
            mount.dataset.residentCells = String(transition.snapshot.residentCellIds.length);
            mount.dataset.performanceLevel = transition.snapshot.performance.level;
            mount.dataset.trafficLimit = String(transition.snapshot.performance.limits.actors.traffic);
            mount.dataset.pedestrianLimit = String(transition.snapshot.performance.limits.actors.pedestrians);
          }
        }
        if (result.failures.blockedCellId) {
          this.#blockForStreamFailure(result.failures);
        } else if (result.failures.failedBoundaries.length > 0 && !this.#navigationFailureNotified) {
          this.#navigationFailureNotified = true;
          this.#ui.toast('A city block failed to load. A safe road closure is active.', 'warning');
        }
        if (this.#lastWorldSnapshot) this.#drawNavigation(this.#lastWorldSnapshot);
      }
    } finally {
      this.#navigationUpdatePending = false;
      if (this.#queuedNavigationSnapshot && this.#navigation === navigation) {
        this.#queueNavigationUpdate(this.#queuedNavigationSnapshot);
      }
    }
  }

  #blockForStreamFailure(failures: Readonly<NavigationFailureState>): void {
    const blockedCellId = failures.blockedCellId;
    if (!blockedCellId) return;
    const failure = failures.failedBoundaries.find(
      (candidate) => candidate.cellId === blockedCellId,
    );
    if (this.#failedStreamCellId !== blockedCellId) {
      this.#failedStreamCellId = blockedCellId;
      this.#inputController?.releaseAll();
      this.#audio.setWorldAudioState({ active: false });
      this.#world?.pause();
      void this.#audio.suspend();
    }
    const detail = failure?.error
      ? ` ${failure.error}`
      : '';
    this.#ui.showStreamFailure(
      `Solara could not load ${blockedCellId} after three attempts.${detail} Your last safe position is preserved behind a road closure.`,
    );
  }

  async #retryStreamFailure(): Promise<void> {
    const navigation = this.#navigation;
    const cellId = this.#failedStreamCellId;
    if (!navigation || !cellId || this.#streamRetryPending) return;
    this.#streamRetryPending = true;
    this.#ui.showStreamFailure(`Retrying ${cellId}…`);
    const result = await navigation.retryFailedCell(cellId);
    this.#streamRetryPending = false;
    if (this.#navigation !== navigation || this.#failedStreamCellId !== cellId) return;
    if (!result.success) {
      this.#ui.showStreamFailure(
        `The city block still could not load: ${result.reason}. Check your connection, then retry or return to the menu.`,
      );
      return;
    }

    this.#cityStreaming?.markCellReady(cellId);
    this.#failedStreamCellId = null;
    this.#navigationFailureNotified = false;
    this.#syncClosedRoadEdges(navigation.failureState());
    this.#ui.hideStreamFailure();
    this.#ui.toast('City streaming recovered.', 'success');
    const snapshot = this.#lastExteriorSnapshot ?? this.#lastWorldSnapshot;
    if (snapshot) this.#queueNavigationUpdate(snapshot);
    if (!this.#paused && !this.#panelOpen && !this.#orientationBlocked) {
      if (this.#lastWorldSnapshot) this.#syncWorldAudio(this.#lastWorldSnapshot);
      this.#world?.resume();
      this.#world?.focus();
      void this.#audio.resume();
    }
  }

  #syncClosedRoadEdges(failures: Readonly<NavigationFailureState>): void {
    const navigation = this.#navigation;
    const graph = this.#roadGraph;
    if (!navigation || !graph) return;
    this.#world?.setRoadClosures(failures.roadClosures);
    const failedCells = new Set(failures.failedBoundaries.map((failure) => failure.cellId));
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const nextClosedEdges = new Set<string>();
    for (const edge of graph.edges) {
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) continue;
      const fromFailed = failedCells.has(cellIdAt(from.position));
      const toFailed = failedCells.has(cellIdAt(to.position));
      if (fromFailed !== toFailed) nextClosedEdges.add(edge.id);
    }
    for (const edgeId of this.#closedStreamEdgeIds) {
      if (!nextClosedEdges.has(edgeId)) navigation.openRoadEdge(edgeId);
    }
    for (const edgeId of nextClosedEdges) {
      if (!this.#closedStreamEdgeIds.has(edgeId)) navigation.closeRoadEdge(edgeId);
    }
    this.#closedStreamEdgeIds.clear();
    nextClosedEdges.forEach((edgeId) => this.#closedStreamEdgeIds.add(edgeId));
  }

  #drawNavigation(snapshot: WorldSnapshot): void {
    if (snapshot.interiorId && this.#lastExteriorSnapshot) {
      snapshot = this.#lastExteriorSnapshot;
    }
    const navigation = this.#navigation;
    this.#minimap.draw(snapshot, navigation ? {
      routeSegments: navigation.nextRouteSegments(6),
      waypoint: navigation.currentWaypoint,
      markers: navigation.visibleMarkers(),
    } : {});
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (this.#panelOpen && panel?.dataset.panel === 'map') this.#renderFullMap(snapshot);
  }

  #renderFullMap(snapshot: WorldSnapshot): void {
    const world = this.#world;
    const navigation = this.#navigation;
    if (!world || !navigation) return;
    const host = this.#root.querySelector<HTMLElement>('[data-panel-body]');
    if (!host) return;
    let mapHost = host.querySelector<HTMLElement>('[data-map-render-host]');
    if (!mapHost) {
      host.innerHTML = `
        <div class="map-render-host" data-map-render-host></div>
        ${this.#mapControlsMarkup()}
      `;
      mapHost = host.querySelector<HTMLElement>('[data-map-render-host]');
      const controls = host.querySelector<HTMLElement>('.map-controls');
      this.#bindMapControls(controls);
    }
    if (!mapHost) return;
    this.#mapRenderer ??= new MapRenderer(mapHost, { roads: world.layout.roads });
    const route = navigation.currentRoute;
    this.#mapModel = this.#mapRenderer.draw({
      player: { position: { x: snapshot.position.x, z: snapshot.position.z }, heading: snapshot.heading },
      discoveredCellIds: navigation.discoveredCellIds(),
      markers: navigation.visibleMarkers(),
      waypoint: navigation.currentWaypoint,
      routeSegments: route.gpsRoute?.segments,
      routeSegmentIndex: route.segmentIndex,
    });
    const svg = mapHost.querySelector<SVGSVGElement>('svg[role="img"]');
    if (svg) {
      svg.dataset.mapCanvas = 'true';
      svg.setAttribute('tabindex', '0');
      svg.setAttribute('aria-describedby', 'map-help');
      svg.addEventListener('click', this.#onMapClick);
    }
  }

  #bindMapControls(controls: HTMLElement | null): void {
    controls?.querySelectorAll<HTMLButtonElement>('[data-map-waypoint]')
      .forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#setMarkerWaypoint(button.dataset.mapWaypoint ?? '');
      }));
    controls?.querySelector<HTMLButtonElement>('[data-map-clear-waypoint]')
      ?.addEventListener('click', (event) => {
        event.stopPropagation();
      this.#navigation?.clearWaypoint();
      this.#ui.toast('GPS waypoint cleared', 'info');
      if (this.#lastWorldSnapshot) this.#drawNavigation(this.#lastWorldSnapshot);
      });
    controls?.querySelectorAll<HTMLInputElement>('[data-map-filter]')
      .forEach((control) => control.addEventListener('change', (event) => {
        const kind = control.dataset.mapFilter as MapFilterKind;
        if (!(kind in this.#mapMarkerFilters)) return;
        event.stopPropagation();
        this.#mapMarkerFilters[kind] = control.checked;
        this.#navigation?.setMarkerFilter(kind, control.checked);
        if (this.#lastWorldSnapshot) this.#drawNavigation(this.#lastWorldSnapshot);
      }));
  }

  readonly #onMapClick = (event: MouseEvent): void => {
    const model = this.#mapModel;
    const navigation = this.#navigation;
    const svg = event.currentTarget;
    if (!model || !navigation || !(svg instanceof SVGSVGElement)) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const projection = model.projection;
    const screenX = (event.clientX - rect.left) / rect.width * projection.viewport.width;
    const screenY = (event.clientY - rect.top) / rect.height * projection.viewport.height;
    const withinMap = screenX >= projection.offsetX
      && screenX <= projection.offsetX + projection.contentWidth
      && screenY >= projection.offsetY
      && screenY <= projection.offsetY + projection.contentHeight;
    if (!withinMap) return;
    const position = {
      x: projection.bounds.minX + (screenX - projection.offsetX) / projection.scale,
      z: projection.bounds.minZ + (screenY - projection.offsetY) / projection.scale,
    };
    const result = navigation.setWaypoint({
      id: 'custom-waypoint',
      label: 'Custom waypoint',
      position,
      source: 'custom',
    });
    if (!result.success) {
      this.#ui.toast('That point cannot be routed from the street grid.', 'warning');
      return;
    }
    this.#ui.toast(`Custom waypoint · ${Math.round(position.x)}, ${Math.round(position.z)}`, 'success');
    if (this.#lastWorldSnapshot) this.#drawNavigation(this.#lastWorldSnapshot);
  };

  #setMarkerWaypoint(markerId: string): void {
    const navigation = this.#navigation;
    const marker = navigation?.visibleMarkers().find((candidate) => candidate.id === markerId);
    if (!navigation || !marker) return;
    const result = navigation.setWaypoint({
      id: `marker:${marker.id}`,
      label: marker.label,
      position: marker.position,
      source: 'marker',
    });
    this.#ui.toast(
      result.success ? `GPS route set · ${marker.label}` : `No street route to ${marker.label}`,
      result.success ? 'success' : 'warning',
    );
    if (this.#lastWorldSnapshot) this.#drawNavigation(this.#lastWorldSnapshot);
  }

  #mapControlsMarkup(): string {
    const checked = (kind: MapFilterKind): string =>
      this.#mapMarkerFilters[kind] ? 'checked' : '';
    return `
      <div class="map-controls" aria-label="Map controls">
        <p id="map-help">Click or tap the map to place a custom waypoint.</p>
        <div class="map-controls__routes" aria-label="Contact routes">
          <button type="button" data-map-waypoint="juno-vale">Juno</button>
          <button type="button" data-map-waypoint="malik-rook">Malik</button>
          <button type="button" data-map-waypoint="priya-shah">Priya</button>
          <button type="button" data-map-clear-waypoint>Clear GPS</button>
        </div>
        <fieldset><legend>Markers</legend>
          <label><input type="checkbox" data-map-filter="mission" ${checked('mission')}> Missions</label>
          <label><input type="checkbox" data-map-filter="safehouse" ${checked('safehouse')}> Safehouses</label>
          <label><input type="checkbox" data-map-filter="property" ${checked('property')}> Properties</label>
          <label><input type="checkbox" data-map-filter="activity" ${checked('activity')}> Activities</label>
          <label><input type="checkbox" data-map-filter="shop" ${checked('shop')}> Shops</label>
          <label><input type="checkbox" data-map-filter="custom" ${checked('custom')}> Discoveries</label>
        </fieldset>
      </div>
    `;
  }

  #onWorldFrame(frameMilliseconds: number): void {
    const streaming = this.#cityStreaming;
    if (!streaming) return;
    const decision = streaming.sampleRuntimeFrame(frameMilliseconds);
    if (!decision) return;
    this.#world?.setPresentation({ resolutionScale: decision.limits.resolutionScale });
    this.#applyCityStreaming();
    const mount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
    if (mount) {
      mount.dataset.performanceLevel = decision.level;
      mount.dataset.resolutionScale = decision.limits.resolutionScale.toFixed(2);
      mount.dataset.trafficLimit = String(decision.limits.actors.traffic);
      mount.dataset.pedestrianLimit = String(decision.limits.actors.pedestrians);
    }
  }

  #applyCityStreaming(): void {
    const streaming = this.#cityStreaming;
    const world = this.#world;
    if (!streaming || !world) return;
    const snapshot = streaming.snapshot();
    const visuals = world.setCityStreaming(
      snapshot.renderableActiveCellIds,
      snapshot.residentCellIds,
      snapshot.performance.limits.drawDensity,
    );
    const actorLimits = world.setActorLimits(snapshot.performance.limits.actors);
    const population = world.getCitySimulationSnapshot();
    const mount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
    if (!mount) return;
    mount.dataset.performanceLevel = snapshot.performance.level;
    mount.dataset.resolutionScale = snapshot.performance.limits.resolutionScale.toFixed(2);
    mount.dataset.visibleCells = String(visuals.visibleCellIds.length);
    mount.dataset.visibleStructures = String(visuals.structures.visible);
    mount.dataset.visibleProps = String(visuals.props.visible);
    mount.dataset.shadowInstances = String(visuals.shadowCastingInstances);
    mount.dataset.visualResidentCells = String(visuals.residentCellIds.length);
    mount.dataset.visualCreatedCells = String(visuals.createdCellIds.length);
    mount.dataset.visualEvictedCells = String(visuals.evictedCellIds.length);
    mount.dataset.activeCollisions = String(world.activeCollisionCount);
    mount.dataset.trafficLimit = String(actorLimits.traffic);
    mount.dataset.pedestrianLimit = String(actorLimits.pedestrians);
    mount.dataset.combatLimit = String(actorLimits.combat);
    mount.dataset.activeTraffic = String(population.traffic.length);
    mount.dataset.activePedestrians = String(population.pedestrians.length);
  }
}

function campaignStateFromSave(save: Readonly<SaveGameV1>): CampaignState {
  const campaign = createCampaignState(MISSIONS, save.player.level);
  campaign.contacts = {
    juno: Math.max(0, Math.floor(save.contacts.juno ?? 0)),
    malik: Math.max(0, Math.floor(save.contacts.malik ?? 0)),
    priya: Math.max(0, Math.floor(save.contacts.priya ?? 0)),
  };
  for (const definition of MISSIONS) {
    const saved = save.missions[definition.id];
    const progress = campaign.missions[definition.id];
    if (!saved || !progress) continue;
    progress.state = saved.state === 'active' ? 'available' : saved.state;
    progress.checkpointId = saved.checkpointId;
    progress.completedObjectives = saved.completedObjectives.filter((objectiveId) => (
      definition.objectives.some((objective) => objective.id === objectiveId)
    ));
    progress.choices = {};
  }
  campaign.activeMissionId = null;
  campaign.ending = save.ending;
  campaign.worldFlags = Object.entries(save.worldFlags)
    .filter(([, enabled]) => enabled)
    .map(([flag]) => flag);
  return campaign;
}

function missionTimeOfDay(value: NonNullable<MissionDefinition['timeOverride']>): number {
  return { dawn: 0.27, day: 0.5, evening: 0.75, night: 0.88 }[value];
}

function dialogueSpeakerLabel(entry: Readonly<DialogueEntry>): string {
  return {
    alex: 'Alex Moreno',
    juno: 'Juno Vale',
    malik: 'Malik Rook',
    priya: 'Priya Shah',
    dispatch: 'Solara Dispatch',
    system: 'Mission update',
  }[entry.speaker];
}

function contactLabel(contact: MissionDefinition['contact']): string {
  return {
    garage: 'Moreno Garage',
    juno: 'Juno Vale',
    malik: 'Malik Rook',
    priya: 'Priya Shah',
    'all-contacts': 'All contacts',
  }[contact];
}

function campaignGateReason(gates: Readonly<CampaignMissionGateStatus>): string | null {
  const reasons: string[] = [];
  if (!gates.level.met) reasons.push(`Level ${gates.level.required}`);
  if (gates.reputation && !gates.reputation.met) {
    reasons.push(`${contactLabel(gates.reputation.contact)} reputation ${gates.reputation.required}`);
  }
  if (gates.missingPrerequisiteIds.length > 0) {
    const titles = gates.missingPrerequisiteIds.map((id) => (
      MISSIONS.find((mission) => mission.id === id)?.title ?? id
    ));
    reasons.push(`Complete ${titles.join(', ')}`);
  }
  return reasons.length > 0 ? reasons.join(' · ') : null;
}

function activityAvailabilityReason(availability: Readonly<ActivityAvailability>): string | null {
  switch (availability.reason) {
    case 'available': return null;
    case 'locked': return 'Complete the linked story job';
    case 'level-required': return `Reach level ${availability.requiredLevel}`;
    case 'cooldown': return `${formatDuration(availability.cooldownRemainingMs)} cooldown`;
  }
}

function collectibleCategoryLabel(category: (typeof COLLECTIBLE_SETS)[number]['category']): string {
  return {
    'salvage-cache': 'Salvage caches',
    'stunt-jump': 'Stunt jumps',
    'signal-node': 'Signal nodes',
  }[category];
}

function missionObjectivePosition(
  definition: Readonly<MissionDefinition>,
  objective: Readonly<ObjectiveDefinition>,
  targetIndex: number,
): { x: number; z: number } {
  const objectiveIndex = Math.max(0, definition.objectives.findIndex((entry) => entry.id === objective.id));
  const checkpointIndex = Math.min(
    definition.checkpoints.length - 1,
    Math.floor(objectiveIndex * definition.checkpoints.length / Math.max(1, definition.objectives.length)),
  );
  const checkpoint = definition.checkpoints[Math.max(0, checkpointIndex)];
  const base = definition.id === 'past-due' && objectiveIndex === 0
    ? { x: PLAYER_SPAWN.x, z: PLAYER_SPAWN.z }
    : checkpoint
      ? { x: checkpoint.respawn.x, z: checkpoint.respawn.z }
      : SOLARA_GAMEPLAY_ANCHORS[definition.district];
  const targetDistrict = checkpoint?.respawn.district ?? definition.district;
  return resolveSolaraMissionTarget({
    district: targetDistrict,
    missionId: definition.id,
    objectiveId: objective.id,
    objectiveIndex,
    targetIndex,
    base,
  });
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function progressionStateFromSave(save: Readonly<SaveGameV1>): ProgressionState {
  return {
    level: save.player.level,
    xp: save.player.xp,
    attributePoints: save.player.attributePoints,
    skillPoints: save.player.skillPoints,
    attributes: { ...save.player.attributes },
    unlockedSkills: [...save.player.unlockedSkills],
  };
}

function applyProgressionStateToSave(save: SaveGameV1, state: Readonly<ProgressionState>): void {
  save.player.level = state.level;
  save.player.xp = state.xp;
  save.player.attributePoints = state.attributePoints;
  save.player.skillPoints = state.skillPoints;
  save.player.attributes = { ...state.attributes };
  save.player.unlockedSkills = [...state.unlockedSkills];
}

function cloneSavedInventory(inventory: Readonly<SavedInventory>): SavedInventory {
  return {
    gridWidth: inventory.gridWidth,
    gridHeight: inventory.gridHeight,
    maxWeightKg: inventory.maxWeightKg,
    items: inventory.items.map((item) => ({ ...item })),
  };
}

function findTacticalItem(
  state: Readonly<TacticalInventoryState>,
  instanceId: string,
): { container: TacticalContainerRef; item: SavedItemInstance } | null {
  const backpack = state.backpack.items.find((item) => item.instanceId === instanceId);
  if (backpack) return { container: { kind: 'backpack' }, item: backpack };
  const stash = state.stash.find((item) => item.instanceId === instanceId);
  if (stash) return { container: { kind: 'stash' }, item: stash };
  for (const [vehicleInstanceId, trunk] of Object.entries(state.trunks)) {
    const item = trunk.items.find((candidate) => candidate.instanceId === instanceId);
    if (item) return { container: { kind: 'trunk', vehicleInstanceId }, item };
  }
  return null;
}

function appendAbstractStash(
  stash: SavedItemInstance[],
  definition: (typeof ITEMS)[number],
  quantity: number,
  nextId: () => string,
): void {
  let remaining = quantity;
  for (const item of stash) {
    if (item.definitionId !== definition.id || item.quantity >= definition.maximumStack) continue;
    const added = Math.min(remaining, definition.maximumStack - item.quantity);
    item.quantity += added;
    remaining -= added;
    if (remaining === 0) return;
  }
  while (remaining > 0) {
    const stackQuantity = Math.min(remaining, definition.maximumStack);
    stash.push({
      instanceId: nextId(),
      definitionId: definition.id,
      quantity: stackQuantity,
      durability: 100,
      x: 0,
      y: 0,
      rotated: false,
    });
    remaining -= stackQuantity;
  }
}

function ensureStarterVehicle(save: SaveGameV1): void {
  if (save.worldFlags['starter-vehicle-granted']) return;
  if (save.ownedVehicles.length > 0) {
    save.worldFlags['starter-vehicle-granted'] = true;
    return;
  }
  const definition = getVehicle('compact');
  if (!definition) {
    throw new Error('Missing compact starter vehicle definition');
  }
  const instanceId = 'moreno-rook';
  save.ownedVehicles.push({
    instanceId,
    definitionId: definition.id,
    registered: true,
    garageSlot: 0,
    bodyHealth: 100,
    engineHealth: 100,
    tireHealth: [100, 100, 100, 100],
    upgrades: {
      engine: 0,
      brakes: 0,
      grip: 0,
      armor: 0,
      paint: 'factory',
    },
  });
  save.trunks[instanceId] = createVehicleTrunk(definition, 0);
  save.worldFlags['starter-vehicle-granted'] = true;
}

function ensureM5StarterInventory(save: SaveGameV1): void {
  const capacity = updateBackpackGritCapacity(save.inventory, ITEMS, save.player.attributes.grit);
  if (capacity.success) save.inventory = capacity.inventory;
  if (save.worldFlags['m5-starter-inventory-granted']) {
    if (save.unlockedRecipes.length === 0) save.unlockedRecipes = RECIPES.map((recipe) => recipe.id);
    return;
  }
  const grants = [
    { definitionId: 'melee-tier-1', quantity: 1, instanceIdBase: 'starter-melee' },
    { definitionId: 'pistol-tier-1', quantity: 1, instanceIdBase: 'starter-pistol' },
    { definitionId: 'ammo-handgun', quantity: 24, instanceIdBase: 'starter-handgun-ammo' },
    { definitionId: 'medkit', quantity: 1, instanceIdBase: 'starter-medkit' },
    { definitionId: 'weapon-repair-kit', quantity: 1, instanceIdBase: 'starter-weapon-repair' },
    { definitionId: 'component-scrap', quantity: 6, instanceIdBase: 'starter-scrap' },
    { definitionId: 'component-cloth', quantity: 6, instanceIdBase: 'starter-cloth' },
    { definitionId: 'component-chemicals', quantity: 6, instanceIdBase: 'starter-chemicals' },
    { definitionId: 'component-electronics', quantity: 4, instanceIdBase: 'starter-electronics' },
    { definitionId: 'component-powder', quantity: 6, instanceIdBase: 'starter-powder' },
  ] as const;
  for (const grant of grants) {
    if (save.inventory.items.some((item) => item.instanceId === grant.instanceIdBase)) continue;
    const added = addItem(save.inventory, ITEMS, grant);
    if (added.success) {
      save.inventory = added.inventory;
      continue;
    }
    const definition = ITEMS.find((item) => item.id === grant.definitionId);
    if (definition) appendAbstractStash(save.stash, definition, grant.quantity, () => grant.instanceIdBase);
  }
  const melee = save.inventory.items.find((item) => item.instanceId === 'starter-melee');
  const pistol = save.inventory.items.find((item) => item.instanceId === 'starter-pistol');
  const medkit = save.inventory.items.find((item) => item.instanceId === 'starter-medkit');
  save.quickLoadout = {
    firearms: [pistol?.instanceId ?? null, null],
    melee: melee?.instanceId ?? null,
    consumables: [medkit?.instanceId ?? null, null],
  };
  save.unlockedRecipes = RECIPES.map((recipe) => recipe.id);
  save.worldFlags['m5-starter-inventory-granted'] = true;
}

function worldVehicleFromSave(save: Readonly<SaveGameV1>): WorldVehicleInitialization {
  const vehicle = [...save.ownedVehicles]
    .sort((left, right) => left.garageSlot - right.garageSlot || left.instanceId.localeCompare(right.instanceId))
    .find((candidate) => getVehicle(candidate.definitionId) !== undefined);
  if (!vehicle) {
    throw new Error('Save has no valid garage vehicle');
  }
  const definition = getVehicle(vehicle.definitionId);
  if (!definition) {
    throw new Error(`Unknown saved vehicle definition: ${vehicle.definitionId}`);
  }
  return {
    instanceId: vehicle.instanceId,
    classId: definition.id,
    registered: vehicle.registered,
    paint: vehicle.upgrades.paint,
    integrity: {
      bodyHealth: vehicle.bodyHealth,
      engineHealth: vehicle.engineHealth,
      tireHealth: [...vehicle.tireHealth] as [number, number, number, number],
    },
    upgrades: {
      engine: vehicle.upgrades.engine,
      brakes: vehicle.upgrades.brakes,
      grip: vehicle.upgrades.grip,
      armor: vehicle.upgrades.armor,
    },
  };
}

const TOUCH_CONTROL_ACTIONS = new Set<TouchControlAction>([
  'fire', 'aim', 'sprint', 'jump', 'crouch', 'interact', 'melee', 'reload',
  'shoulderSwap', 'weaponRadial', 'inventory', 'map', 'pause',
]);

function isTouchControlAction(value: string): value is TouchControlAction {
  return TOUCH_CONTROL_ACTIONS.has(value as TouchControlAction);
}

function forcedStreamCellFromLocation(): CellId | null {
  const value = new URLSearchParams(globalThis.location.search).get('streamFailCell');
  if (!value) return null;
  try {
    parseCellId(value);
    return value as CellId;
  } catch {
    console.warn(`Ignoring invalid streamFailCell QA parameter: ${value}`);
    return null;
  }
}
