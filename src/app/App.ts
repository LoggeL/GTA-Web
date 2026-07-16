import {
  CoreSaveService,
  InMemorySaveAdapter,
  createInitialSaveGame,
  type GameSettings,
  type SaveGameV1,
  type SaveService,
  type SaveSlotId,
} from '../core';
import { PLAYER_SPAWN, WorldView, type WorldSnapshot, type WorldInputState } from '../game';
import { TouchInput } from '../input/TouchInput';
import { IndexedDbSaveAdapter } from '../storage/IndexedDbSaveAdapter';
import { GameUI, type AlexPreset, type HudSnapshot, type OverlayPanel, type SaveSlotSummary } from '../ui/GameUI';
import { MinimapRenderer } from '../ui/MinimapRenderer';
import { AudioEngine } from '../audio/AudioEngine';

const DISTRICT_LABELS: Record<WorldSnapshot['district'], string> = {
  'neon-strand': 'Neon Strand',
  'alta-vista': 'Alta Vista',
  'arroyo-heights': 'Arroyo Heights',
  breakwater: 'Breakwater',
};

const nextAnimationFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

export class App {
  readonly #root: HTMLElement;
  readonly #saveService: SaveService;
  readonly #audio = new AudioEngine();
  readonly #ui: GameUI;
  readonly #minimap: MinimapRenderer;
  readonly #touchInput: TouchInput;
  #settings: GameSettings;
  #world: WorldView | null = null;
  #currentSave: SaveGameV1 | null = null;
  #activeSlot: SaveSlotId | null = null;
  #paused = false;
  #panelOpen = false;
  #saving = false;
  #lastSnapshotAt = 0;
  #lastAutosaveAt = 0;
  #radioStation = 'Coastline FM';

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
    });
    const minimapCanvas = root.querySelector<HTMLCanvasElement>('[data-minimap]');
    if (!minimapCanvas) throw new Error('Missing minimap canvas');
    this.#minimap = new MinimapRenderer(minimapCanvas);
    this.#touchInput = new TouchInput(root, (input) => this.#world?.setInput(input));
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
    try {
      this.#world = new WorldView({
        mount,
        seed: save.trafficSeed,
        quality,
        initialPosition: position,
        initialHeading: save.player.transform.rotation.y,
        timeOfDay: save.clock.timeOfDayMinutes / 1_440,
        rainIntensity: save.clock.weather === 'rain' ? 0.62 : 0,
        reducedMotion: this.#settings.accessibility.reducedMotion,
        enableDefaultControls: true,
        onSnapshot: (snapshot) => this.#onWorldSnapshot(snapshot),
      });
    } catch (error) {
      console.error(error);
      this.#ui.showMainMenu();
      this.#ui.toast('WebGL2 could not start. Try a current browser or lower graphics settings.', 'warning');
      return;
    }

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
    if (this.#currentSave) {
      const delta = Math.max(0, Math.min(1, (now - this.#lastSnapshotAt) / 1_000));
      this.#currentSave.playtimeSeconds += delta;
      this.#currentSave.player.transform.position = { ...snapshot.position };
      this.#currentSave.player.transform.rotation.y = snapshot.heading;
      this.#currentSave.activeDistrict = snapshot.district;
      this.#currentSave.clock.timeOfDayMinutes = Math.round(snapshot.timeOfDay * 1_440) % 1_440;
      this.#currentSave.clock.weather = snapshot.rainIntensity > 0.15 ? 'rain' : 'clear';
    }
    this.#lastSnapshotAt = now;

    const hud: HudSnapshot = {
      health: this.#currentSave?.player.health ?? 100,
      maxHealth: 100 + Math.max(0, (this.#currentSave?.player.attributes.grit ?? 1) - 1) * 10,
      armor: this.#currentSave?.player.armor ?? 0,
      stamina: snapshot.sprinting ? 72 : 100,
      wantedLevel: 0,
      wantedSearching: false,
      objective: snapshot.mode === 'vehicle' ? 'Test the car through Arroyo Heights' : 'Reach the orange coupe by the garage',
      objectiveDetail: snapshot.mode === 'vehicle' ? 'Explore Solara or press E when stopped to exit' : 'Press E beside the car to drive',
      district: DISTRICT_LABELS[snapshot.district],
      timeLabel: this.#timeLabel(snapshot.timeOfDay),
      money: this.#currentSave?.player.money ?? 0,
      level: this.#currentSave?.player.level ?? 1,
      xpProgress: 0,
      ammo: 0,
      ammoReserve: 0,
      weapon: 'Unarmed',
      speedKph: snapshot.mode === 'vehicle' ? snapshot.speedKph : undefined,
      vehicleName: snapshot.mode === 'vehicle' ? 'Moreno Rook' : undefined,
      radio: snapshot.mode === 'vehicle' ? this.#radioStation : undefined,
      interaction: snapshot.prompt?.replace('Press E to ', ''),
    };
    this.#ui.updateHud(hud);
    this.#minimap.draw(snapshot);

    if (this.#currentSave && now - this.#lastAutosaveAt >= 90_000 && !this.#paused) {
      this.#lastAutosaveAt = now;
      void this.#saveNow(false);
    }
  }

  #pause(): void {
    if (!this.#world) return;
    this.#paused = true;
    this.#world.stop();
    this.#world.clearInput();
    void this.#audio.suspend();
  }

  #resume(): void {
    if (!this.#world) return;
    this.#paused = false;
    if (!this.#panelOpen) {
      this.#world.start();
      this.#world.focus();
      void this.#audio.resume();
    }
  }

  #openPanel(_panel: OverlayPanel): void {
    this.#panelOpen = true;
    this.#world?.stop();
    this.#world?.clearInput();
  }

  #closePanel(): void {
    this.#panelOpen = false;
    if (this.#world && !this.#paused) {
      this.#world.start();
      this.#world.focus();
    }
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
    const world = this.#world;
    if (!world) return;
    const input: Partial<WorldInputState> = {};
    if (action === 'interact') input.interact = active;
    if (action === 'sprint') input.sprint = active;
    if (action === 'jump') {
      input.jump = active;
      input.handbrake = active;
    }
    if (action === 'aim') input.aim = active;
    world.setInput(input);
  }

  #resolveQuality(): 'low' | 'high' {
    if (this.#settings.video.quality !== 'auto') return this.#settings.video.quality;
    return matchMedia('(pointer: coarse)').matches || innerWidth < 900 ? 'low' : 'high';
  }

  #applySettings(): void {
    document.documentElement.style.setProperty('--ui-scale', String(this.#settings.accessibility.uiScale));
    document.body.classList.toggle('high-contrast', this.#settings.accessibility.highContrastIndicators);
    this.#audio.setMix(this.#settings.audio);
  }

  #bindGlobalEvents(): void {
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
    });

    globalThis.addEventListener('unload', () => this.#touchInput.destroy(), { once: true });
  }

  #teardownWorld(): void {
    this.#world?.dispose();
    this.#world = null;
    this.#audio.stopRadio();
  }

  #timeLabel(normalized: number): string {
    const minutes = Math.floor(((normalized % 1) + 1) % 1 * 1_440);
    const hour = Math.floor(minutes / 60);
    return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
}
