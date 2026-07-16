import {
  CoreSaveService,
  InMemorySaveAdapter,
  createInitialSaveGame,
  type GameSettings,
  type SaveGameV1,
  type SaveService,
  type SaveSlotId,
} from '../core';
import {
  PLAYER_SPAWN,
  VEHICLE_SPAWN,
  WorldView,
  createWorldInputState,
  type WorldSnapshot,
  type WorldVehicleInitialization,
} from '../game';
import { VEHICLES, getVehicle } from '../data';
import { CityStreamingController } from '../game/CityStreamingController';
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
import type { CellId, NavigationFailureState, RoadGraph } from '../navigation';
import { IndexedDbSaveAdapter } from '../storage/IndexedDbSaveAdapter';
import { GameUI, type AlexPreset, type HudSnapshot, type OverlayPanel, type SaveSlotSummary } from '../ui/GameUI';
import { MapRenderer, type MapRenderModel } from '../ui/MapRenderer';
import { MinimapRenderer } from '../ui/MinimapRenderer';
import {
  GaragePanel,
  parseGaragePanelAction,
  type NearbyUnregisteredVehicle,
} from '../ui/GaragePanel';
import { AudioEngine } from '../audio/AudioEngine';
import {
  applyVehicleUpgrade,
  createVehicleTrunk,
  isGaragePaint,
  registerVehicle,
  repaintVehicle,
  repairVehicle,
  retrieveVehicleFromGarage,
  type GarageState,
  type GarageTransactionResult,
} from '../systems';

const DISTRICT_LABELS: Record<WorldSnapshot['district'], string> = {
  'neon-strand': 'Neon Strand',
  'alta-vista': 'Alta Vista',
  'arroyo-heights': 'Arroyo Heights',
  breakwater: 'Breakwater',
};

type MapFilterKind = 'mission' | 'property' | 'activity' | 'shop' | 'safehouse' | 'custom';

interface HeatlineQaApi {
  teleport(x: number, z: number): WorldSnapshot;
  snapshot(): WorldSnapshot | null;
  trafficVehicles(): readonly {
    id: string;
    classId: string;
    behavior: string;
    x: number;
    z: number;
  }[];
  setMoney(value: number): number;
  setActiveVehicleClass(classId: string): WorldSnapshot;
  setActiveVehicleCondition(bodyHealth: number, engineHealth: number): WorldSnapshot;
}

type QaGlobal = typeof globalThis & {
  __HEATLINE_QA__?: HeatlineQaApi;
};

const nextAnimationFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export class App {
  readonly #root: HTMLElement;
  readonly #saveService: SaveService;
  readonly #audio = new AudioEngine();
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
  #saving = false;
  #lastSnapshotAt = 0;
  #lastAutosaveAt = 0;
  #radioStation = 'Coastline FM';
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

  private constructor(root: HTMLElement, saveService: SaveService, settings: GameSettings) {
    this.#root = root;
    this.#saveService = saveService;
    this.#settings = settings;
    this.#ui = new GameUI(root, {
      onRequestSaveSlots: () => void this.#showSaveSlots(),
      onStartNewGame: (slot, preset) => void this.#startNewGame(slot, preset),
      onContinueGame: (slot) => void this.#continueGame(slot),
      onDeleteSlot: (slot) => void this.#deleteSlot(slot),
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
  }

  static async boot(root: HTMLElement): Promise<App> {
    let saveService: SaveService;
    try {
      if (!('indexedDB' in globalThis)) throw new Error('IndexedDB unavailable');
      saveService = new CoreSaveService(new IndexedDbSaveAdapter());
      await saveService.initialize();
    } catch (error) {
      console.warn('Persistent saves are unavailable; using an in-memory session.', error);
      saveService = new CoreSaveService(new InMemorySaveAdapter());
      await saveService.initialize();
    }
    const settings = await saveService.loadSettings();
    return new App(root, saveService, settings);
  }

  async #showSaveSlots(): Promise<void> {
    const summaries = await this.#saveService.listSlots();
    const slots: SaveSlotSummary[] = summaries.map((summary) => {
      const metadata = summary.metadata;
      const exists = summary.status !== 'empty' && summary.status !== 'corrupt';
      return {
        slot: summary.slotId,
        exists,
        level: exists ? 1 : undefined,
        mission: summary.status === 'recovered' ? 'Recovered backup' : exists ? 'Solara free roam' : undefined,
        district: exists ? 'Arroyo Heights' : undefined,
        updatedAt: metadata?.updatedAt,
      };
    });
    this.#ui.showSaveSlots(slots);
  }

  async #startNewGame(slot: SaveSlotId, preset: AlexPreset): Promise<void> {
    void this.#audio.unlock();
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
    await this.#saveService.saveSlot(save);
    await this.#loadGame(save, true);
  }

  async #continueGame(slot: SaveSlotId): Promise<void> {
    void this.#audio.unlock();
    try {
      const result = await this.#saveService.loadSlot(slot);
      if (!result) {
        this.#ui.toast('That save slot is empty.', 'warning');
        await this.#showSaveSlots();
        return;
      }
      await this.#loadGame(result.save, false);
      if (result.recoveredFromBackup) this.#ui.toast('Recovered the last known-good save.', 'warning');
    } catch (error) {
      console.error(error);
      this.#ui.toast('The save could not be loaded. Export or delete it from the save menu.', 'warning');
    }
  }

  async #loadGame(save: SaveGameV1, isNew: boolean): Promise<void> {
    this.#teardownWorld();
    ensureStarterVehicle(save);
    this.#currentSave = save;
    this.#activeSlot = save.slot.id;
    this.#lastSnapshotAt = performance.now();
    this.#lastAutosaveAt = performance.now();
    this.#ui.showLoading('Reading Solara street grid…', 12);
    await nextAnimationFrame();
    this.#ui.updateLoading('Building four districts…', 42);
    await nextAnimationFrame();

    const mount = this.#root.querySelector<HTMLElement>('[data-world-mount]');
    if (!mount) throw new Error('Missing 3D world mount');
    const quality = this.#resolveQuality();
    const position = save.player.transform.position;
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
        resolutionScale: this.#settings.video.resolutionScale,
        enableDefaultControls: false,
        inputProvider: () => this.#consumeWorldInput(),
        onFrame: (frameMilliseconds) => this.#onWorldFrame(frameMilliseconds),
        onSnapshot: (snapshot) => this.#onWorldSnapshot(snapshot),
      });
    } catch (error) {
      console.error(error);
      this.#ui.showUnsupportedBrowser(
        'The 3D renderer could not start. Hardware acceleration may be disabled or WebGL2 may be unavailable.',
      );
      return;
    }

    this.#domInput = new DomInputAdapter(this.#world.renderer.domElement, this.#inputController);
    this.#touchInput = new TouchInput(this.#root, this.#inputController);
    this.#initializeNavigation(this.#world);
    this.#installQaApi(this.#world);

    this.#ui.updateLoading('Starting traffic radio…', 82);
    this.#audio.setMix(this.#settings.audio);
    const radio = this.#audio.playStation('coastline-fm');
    this.#radioStation = radio.stationName;
    await nextAnimationFrame();
    this.#ui.updateLoading('Welcome to Solara', 100);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
    this.#ui.showGame();
    this.#ui.setTouchMode(matchMedia('(pointer: coarse)').matches);
    this.#world.start();
    this.#world.focus();
    this.#paused = false;
    this.#panelOpen = false;
    if (isNew) {
      this.#ui.showDialogue('Alex Moreno', 'One quiet morning. That was all I asked for. Then the tow truck hit the gate.');
      this.#ui.toast('Past Due started · Reach the orange coupe', 'info');
    } else {
      this.#ui.toast('Welcome back to Solara', 'success');
    }
  }

  #onWorldSnapshot(snapshot: WorldSnapshot): void {
    const now = performance.now();
    this.#lastWorldSnapshot = snapshot;
    if (snapshot.interiorId === null) this.#lastExteriorSnapshot = snapshot;
    if (this.#inputMode !== snapshot.mode) {
      this.#inputMode = snapshot.mode;
      this.#inputController?.setMode(snapshot.mode);
    }
    if (snapshot.mode === 'vehicle' && !this.#navigationDriveWaypointSet) {
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
      worldMount.dataset.interiorId = snapshot.interiorId ?? '';
      worldMount.dataset.interiorPhase = snapshot.interiorPhase;
      worldMount.dataset.vehicleInstanceId = snapshot.vehicleInstanceId;
      worldMount.dataset.vehicleClassId = snapshot.vehicleClassId;
      worldMount.dataset.vehicleRegistered = String(snapshot.vehicleRegistered);
      worldMount.dataset.vehiclePaint = snapshot.vehiclePaint;
      worldMount.dataset.vehicleSirenActive = String(snapshot.vehicleSirenActive);
      worldMount.dataset.vehicleCameraView = snapshot.vehicleCameraView;
    }
    if (this.#currentSave) {
      const delta = Math.max(0, Math.min(1, (now - this.#lastSnapshotAt) / 1_000));
      this.#currentSave.playtimeSeconds += delta;
      if (snapshot.interiorId === null) {
        this.#currentSave.player.transform.position = { ...snapshot.position };
        this.#currentSave.player.transform.rotation.y = snapshot.heading;
      }
      this.#currentSave.activeDistrict = snapshot.district;
      this.#currentSave.clock.timeOfDayMinutes = Math.round(snapshot.timeOfDay * 1_440) % 1_440;
      this.#currentSave.clock.weather = snapshot.rainIntensity > 0.15 ? 'rain' : 'clear';
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
    this.#lastSnapshotAt = now;

    const hud: HudSnapshot = {
      health: this.#currentSave?.player.health ?? 100,
      maxHealth: 100 + Math.max(0, (this.#currentSave?.player.attributes.grit ?? 1) - 1) * 10,
      armor: this.#currentSave?.player.armor ?? 0,
      stamina: snapshot.sprinting ? 72 : 100,
      wantedLevel: 0,
      wantedSearching: false,
      objective: snapshot.interiorId
        ? `Explore ${snapshot.interiorLabel ?? 'the interior'}`
        : snapshot.mode === 'vehicle'
          ? 'Test the car through Arroyo Heights'
          : 'Reach the orange coupe by the garage',
      objectiveDetail: snapshot.interiorId
        ? 'Press E at the marked doorway to return outside'
        : snapshot.mode === 'vehicle'
          ? 'Explore Solara or press E when stopped to exit'
          : 'Press E beside the car to drive',
      district: DISTRICT_LABELS[snapshot.district],
      timeLabel: this.#timeLabel(snapshot.timeOfDay),
      money: this.#currentSave?.player.money ?? 0,
      level: this.#currentSave?.player.level ?? 1,
      xpProgress: 0,
      ammo: 0,
      ammoReserve: 0,
      weapon: 'Unarmed',
      speedKph: snapshot.mode === 'vehicle' ? snapshot.speedKph : undefined,
      vehicleName: snapshot.mode === 'vehicle' ? snapshot.vehicleName : undefined,
      vehicleHealth: snapshot.mode === 'vehicle' ? snapshot.vehicleIntegrity.engineHealth : undefined,
      radio: snapshot.mode === 'vehicle'
        ? snapshot.vehicleSirenActive ? 'SIREN ACTIVE' : this.#radioStation
        : undefined,
      interaction: snapshot.prompt?.replace('Press E to ', ''),
    };
    this.#ui.updateHud(hud);
    const navigationSnapshot = snapshot.interiorId
      ? (this.#lastExteriorSnapshot ?? snapshot)
      : snapshot;
    this.#drawNavigation(navigationSnapshot);
    if (snapshot.interiorId === null) this.#queueNavigationUpdate(snapshot);

    if (this.#currentSave && now - this.#lastAutosaveAt >= 90_000 && !this.#paused) {
      this.#lastAutosaveAt = now;
      void this.#saveNow(false);
    }
  }

  #pause(): void {
    if (!this.#world) return;
    this.#paused = true;
    this.#inputController?.releaseAll();
    this.#world.pause();
    void this.#audio.suspend();
  }

  #resume(): void {
    if (!this.#world) return;
    this.#paused = false;
    if (!this.#panelOpen) {
      this.#world.resume();
      this.#world.focus();
      void this.#audio.resume();
    }
  }

  #openPanel(_panel: OverlayPanel): void {
    this.#panelOpen = true;
    this.#inputController?.releaseAll();
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
  }

  #closePanel(): void {
    this.#panelOpen = false;
    this.#garagePanel = null;
    if (this.#world && !this.#paused) {
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

  #garageState(save: Readonly<SaveGameV1>): GarageState {
    return {
      cash: save.player.money,
      trunkRowBonus: save.player.unlockedSkills.includes('driving-trunk-master') ? 1 : 0,
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
    await this.#saveNow(true);
    this.#teardownWorld();
    this.#currentSave = null;
    this.#activeSlot = null;
    this.#ui.showMainMenu();
  }

  async #deleteSlot(slot: SaveSlotId): Promise<void> {
    if (!globalThis.confirm(`Delete save slot ${slot}? This cannot be undone.`)) return;
    await this.#saveService.deleteSlot(slot);
    this.#audio.playUi('cancel');
    await this.#showSaveSlots();
  }

  async #saveNow(showToast: boolean): Promise<void> {
    if (!this.#currentSave || this.#saving) return;
    this.#saving = true;
    try {
      this.#currentSave.slot.updatedAt = Date.now();
      await this.#saveService.saveSlot(this.#currentSave);
      if (showToast) this.#ui.toast(`Saved to slot ${this.#activeSlot ?? ''}`, 'success');
    } catch (error) {
      console.error(error);
      this.#ui.toast('Save failed. Keep this tab open and try again.', 'warning');
    } finally {
      this.#saving = false;
    }
  }

  #touchAction(action: string, active: boolean): void {
    if (!isTouchControlAction(action)) return;
    this.#inputController?.setTouchAction(action, active);
  }

  #resolveQuality(): 'low' | 'high' {
    if (this.#settings.video.quality !== 'auto') return this.#settings.video.quality;
    return matchMedia('(pointer: coarse)').matches || innerWidth < 900 ? 'low' : 'high';
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
    const adaptiveLimits = this.#cityStreaming?.setBaseResolutionScale(settings.video.resolutionScale);
    this.#world?.setPresentation({
      reducedMotion: settings.accessibility.reducedMotion,
      resolutionScale: adaptiveLimits?.resolutionScale ?? settings.video.resolutionScale,
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
    } catch (error) {
      console.error(error);
      this.#ui.toast('Settings could not be saved.', 'warning');
    }
  }

  #bindGlobalEvents(): void {
    this.#root.addEventListener('click', this.#onGaragePanelClick);
    globalThis.addEventListener('keydown', (event) => {
      if (!this.#world || event.repeat) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        if (this.#panelOpen) this.#ui.closePanel();
        else if (this.#paused) {
          this.#ui.hidePause();
          this.#resume();
        } else {
          this.#ui.showPause();
          this.#pause();
        }
      } else if (event.code === 'KeyM') {
        event.preventDefault();
        this.#ui.openPanel('map');
      } else if (event.code === 'KeyI') {
        event.preventDefault();
        this.#ui.openPanel('inventory');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.#world && !this.#paused) {
        this.#ui.showPause();
        this.#pause();
        void this.#saveNow(false);
      }
    });

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
    this.#ui.hideStreamFailure();
    this.#world?.dispose();
    this.#world = null;
    this.#mapRenderer = null;
    this.#mapModel = null;
    this.#lastWorldSnapshot = null;
    this.#lastExteriorSnapshot = null;
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
    return toWorldInputState(controller.consumeFrame());
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
      baseResolutionScale: this.#settings.video.resolutionScale,
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
    navigation.setMarkers([
      {
        id: 'moreno-garage', kind: 'safehouse', label: 'Moreno Garage',
        position: { x: PLAYER_SPAWN.x, z: PLAYER_SPAWN.z },
        cellId: cellIdAt(PLAYER_SPAWN), reveal: 'always',
      },
      {
        id: 'juno-vale', kind: 'mission', label: 'Juno Vale',
        position: { x: -350, z: -350 }, cellId: cellIdAt({ x: -350, z: -350 }), reveal: 'always',
      },
      {
        id: 'malik-rook', kind: 'mission', label: 'Malik Rook',
        position: { x: 350, z: -350 }, cellId: cellIdAt({ x: 350, z: -350 }), reveal: 'always',
      },
      {
        id: 'priya-shah', kind: 'mission', label: 'Priya Shah',
        position: { x: 350, z: 350 }, cellId: cellIdAt({ x: 350, z: 350 }), reveal: 'always',
      },
    ]);
    navigation.setWaypoint({
      id: 'starter-car',
      label: 'Moreno Rook',
      position: { x: VEHICLE_SPAWN.x, z: VEHICLE_SPAWN.z },
      source: 'mission',
    });
    this.#navigation = navigation;
    this.#queueNavigationUpdate(world.getSnapshot());
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
      snapshot: () => this.#world?.getSnapshot() ?? null,
      trafficVehicles: () => world.getCitySimulationSnapshot().traffic.map((vehicle) => ({
        id: vehicle.id,
        classId: vehicle.classId,
        behavior: vehicle.behavior,
        x: vehicle.position.x,
        z: vehicle.position.z,
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
    };
    (globalThis as QaGlobal).__HEATLINE_QA__ = api;
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
    if (!this.#paused && !this.#panelOpen) {
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
        </fieldset>
      </div>
    `;
  }

  #onWorldFrame(frameMilliseconds: number): void {
    const streaming = this.#cityStreaming;
    if (!streaming) return;
    const decision = streaming.sampleFrame(frameMilliseconds);
    if (!decision.changed) return;
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
