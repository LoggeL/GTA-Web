export type AlexPreset = 'masculine' | 'feminine';
export type OverlayPanel = 'map' | 'inventory' | 'skills' | 'properties' | 'missions' | 'settings';

export interface SaveSlotSummary {
  slot: 1 | 2 | 3;
  exists: boolean;
  level?: number;
  mission?: string;
  district?: string;
  playtimeSeconds?: number;
  updatedAt?: number;
  preset?: AlexPreset;
}

export interface HudSnapshot {
  health: number;
  maxHealth: number;
  armor: number;
  stamina: number;
  wantedLevel: number;
  wantedSearching: boolean;
  objective: string;
  objectiveDetail?: string;
  district: string;
  timeLabel: string;
  money: number;
  level: number;
  xpProgress: number;
  ammo: number;
  ammoReserve: number;
  weapon: string;
  speedKph?: number;
  vehicleName?: string;
  radio?: string;
  interaction?: string;
}

export interface GameUICallbacks {
  onRequestSaveSlots(): void;
  onStartNewGame(slot: 1 | 2 | 3, preset: AlexPreset): void;
  onContinueGame(slot: 1 | 2 | 3): void;
  onDeleteSlot(slot: 1 | 2 | 3): void;
  onResume(): void;
  onPause(): void;
  onQuitToMenu(): void;
  onOpenPanel(panel: OverlayPanel): void;
  onClosePanel(): void;
  onTouchAction(action: string, active: boolean): void;
}

const formatPlaytime = (seconds = 0): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const formatDate = (timestamp?: number): string => {
  if (!timestamp) return 'Never played';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export class GameUI {
  readonly #root: HTMLElement;
  readonly #callbacks: GameUICallbacks;
  #selectedSlot: 1 | 2 | 3 = 1;
  #toastTimer = 0;
  #dialogueTimer = 0;

  constructor(root: HTMLElement, callbacks: GameUICallbacks) {
    this.#root = root;
    this.#callbacks = callbacks;
    this.#renderShell();
    this.#bindEvents();
    this.showSplash();
  }

  showSplash(): void {
    this.#setVisibleScreen('splash-screen');
    this.#root.classList.remove('is-playing');
  }

  showMainMenu(): void {
    this.#setVisibleScreen('main-menu');
    this.#root.classList.remove('is-playing');
  }

  showSaveSlots(slots: SaveSlotSummary[]): void {
    this.#setVisibleScreen('save-slots');
    const container = this.#query<HTMLElement>('[data-save-list]');
    container.innerHTML = slots
      .map((slot) => {
        const slotTitle = slot.exists ? `Level ${slot.level ?? 1} · ${slot.mission ?? 'Free roam'}` : 'New story';
        const slotMeta = slot.exists
          ? `${slot.district ?? 'Arroyo Heights'} · ${formatPlaytime(slot.playtimeSeconds)} · ${formatDate(slot.updatedAt)}`
          : 'Begin Alex Moreno’s story';
        return `
          <article class="save-card ${slot.exists ? '' : 'is-empty'}" data-slot="${slot.slot}">
            <div>
              <span class="save-card__number">Slot ${slot.slot}</span>
              <h3>${slotTitle}</h3>
              <p>${slotMeta}</p>
            </div>
            <div class="save-card__actions">
              <button class="button button--primary" data-slot-action="${slot.exists ? 'continue' : 'new'}" data-slot="${slot.slot}">
                ${slot.exists ? 'Continue' : 'New game'}
              </button>
              ${
                slot.exists
                  ? `<button class="button button--quiet" data-slot-action="delete" data-slot="${slot.slot}" aria-label="Delete save slot ${slot.slot}">Delete</button>`
                  : ''
              }
            </div>
          </article>
        `;
      })
      .join('');
  }

  showPresetChoice(slot: 1 | 2 | 3): void {
    this.#selectedSlot = slot;
    this.#setVisibleScreen('preset-screen');
    this.#query<HTMLElement>('[data-preset-slot]').textContent = `Save slot ${slot}`;
  }

  showLoading(label = 'Building Arroyo Heights…', progress = 0): void {
    this.#setVisibleScreen('loading-screen');
    this.updateLoading(label, progress);
  }

  updateLoading(label: string, progress: number): void {
    this.#query<HTMLElement>('[data-loading-label]').textContent = label;
    const value = clampPercent(progress);
    const bar = this.#query<HTMLElement>('[data-loading-bar]');
    bar.style.setProperty('--progress', `${value}%`);
    bar.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  showGame(): void {
    this.#setVisibleScreen('game-hud');
    this.#root.classList.add('is-playing');
    this.closePanel();
  }

  updateHud(snapshot: HudSnapshot): void {
    this.#setMeter('health', snapshot.health, snapshot.maxHealth);
    this.#setMeter('armor', snapshot.armor, 100);
    this.#setMeter('stamina', snapshot.stamina, 100);
    this.#query<HTMLElement>('[data-hud-objective]').textContent = snapshot.objective;
    this.#query<HTMLElement>('[data-hud-objective-detail]').textContent = snapshot.objectiveDetail ?? '';
    this.#query<HTMLElement>('[data-hud-district]').textContent = snapshot.district;
    this.#query<HTMLElement>('[data-hud-time]').textContent = snapshot.timeLabel;
    this.#query<HTMLElement>('[data-hud-money]').textContent = `$${Math.floor(snapshot.money).toLocaleString()}`;
    this.#query<HTMLElement>('[data-hud-level]').textContent = `LV ${snapshot.level}`;
    this.#query<HTMLElement>('[data-hud-xp] span').style.width = `${clampPercent(snapshot.xpProgress)}%`;
    this.#query<HTMLElement>('[data-hud-weapon]').textContent = snapshot.weapon;
    this.#query<HTMLElement>('[data-hud-ammo]').textContent = `${snapshot.ammo} / ${snapshot.ammoReserve}`;
    this.#query<HTMLElement>('[data-hud-stars]').innerHTML = Array.from({ length: 5 }, (_, index) => {
      const active = index < snapshot.wantedLevel;
      return `<span class="wanted-star ${active ? 'is-active' : ''}" aria-hidden="true">★</span>`;
    }).join('');
    this.#query<HTMLElement>('[data-hud-wanted-label]').textContent =
      snapshot.wantedLevel === 0 ? '' : snapshot.wantedSearching ? 'SEARCHING' : 'PURSUIT';

    const vehicle = this.#query<HTMLElement>('[data-hud-vehicle]');
    vehicle.hidden = snapshot.speedKph === undefined;
    if (snapshot.speedKph !== undefined) {
      this.#query<HTMLElement>('[data-hud-speed]').textContent = String(Math.round(snapshot.speedKph));
      this.#query<HTMLElement>('[data-hud-vehicle-name]').textContent = snapshot.vehicleName ?? 'Vehicle';
      this.#query<HTMLElement>('[data-hud-radio]').textContent = snapshot.radio ?? 'Radio off';
    }

    const interaction = this.#query<HTMLElement>('[data-interaction]');
    interaction.hidden = !snapshot.interaction;
    interaction.querySelector('span')!.textContent = snapshot.interaction ?? '';
  }

  showPause(): void {
    this.#query<HTMLElement>('[data-pause-menu]').hidden = false;
    this.#root.classList.add('is-paused');
  }

  hidePause(): void {
    this.#query<HTMLElement>('[data-pause-menu]').hidden = true;
    this.#root.classList.remove('is-paused');
  }

  openPanel(panel: OverlayPanel, title?: string, body?: string): void {
    const overlay = this.#query<HTMLElement>('[data-panel]');
    overlay.hidden = false;
    overlay.dataset.panel = panel;
    this.#query<HTMLElement>('[data-panel-title]').textContent = title ?? panel[0]!.toUpperCase() + panel.slice(1);
    this.#query<HTMLElement>('[data-panel-body]').innerHTML = body ?? this.#defaultPanelContent(panel);
    this.#callbacks.onOpenPanel(panel);
  }

  closePanel(): void {
    const overlay = this.#query<HTMLElement>('[data-panel]');
    overlay.hidden = true;
    this.#callbacks.onClosePanel();
  }

  showDialogue(speaker: string, text: string, durationMs = 5200): void {
    window.clearTimeout(this.#dialogueTimer);
    const box = this.#query<HTMLElement>('[data-dialogue]');
    box.hidden = false;
    this.#query<HTMLElement>('[data-dialogue-speaker]').textContent = speaker;
    this.#query<HTMLElement>('[data-dialogue-text]').textContent = text;
    this.#dialogueTimer = window.setTimeout(() => {
      box.hidden = true;
    }, durationMs);
  }

  toast(message: string, tone: 'info' | 'success' | 'warning' = 'info'): void {
    window.clearTimeout(this.#toastTimer);
    const toast = this.#query<HTMLElement>('[data-toast]');
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    this.#toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3600);
  }

  setTouchMode(enabled: boolean): void {
    this.#root.classList.toggle('has-touch-controls', enabled);
  }

  destroy(): void {
    window.clearTimeout(this.#toastTimer);
    window.clearTimeout(this.#dialogueTimer);
    this.#root.replaceChildren();
  }

  #renderShell(): void {
    this.#root.innerHTML = `
      <div class="app-shell">
        <div class="world-mount" data-world-mount aria-label="3D game world"></div>

        <section id="splash-screen" class="screen splash-screen" data-screen>
          <div class="splash-screen__shade"></div>
          <div class="title-lockup">
            <p class="eyebrow">A Solara story</p>
            <h1>HEATLINE</h1>
            <p class="subtitle">SOLARA</p>
            <button class="button button--primary button--large" data-action="enter-menu">Enter Solara</button>
            <p class="microcopy">Original crime-action RPG · Headphones recommended</p>
          </div>
        </section>

        <section id="main-menu" class="screen menu-screen" data-screen hidden>
          <div class="menu-card">
            <p class="eyebrow">HEATLINE: SOLARA</p>
            <h2>City of second chances.</h2>
            <p>Save the garage. Work the contacts. Decide who owns Solara when the ledger opens.</p>
            <nav class="menu-actions" aria-label="Main menu">
              <button class="button button--primary" data-action="play">Play</button>
              <button class="button" data-action="open-settings">Settings</button>
              <button class="button" data-action="show-controls">Controls</button>
            </nav>
            <p class="content-note">Mature crime themes and non-graphic action violence.</p>
          </div>
        </section>

        <section id="save-slots" class="screen menu-screen" data-screen hidden>
          <div class="wide-card">
            <header class="section-heading">
              <div><p class="eyebrow">Campaign</p><h2>Choose a save</h2></div>
              <button class="button button--quiet" data-action="back-menu">Back</button>
            </header>
            <div class="save-list" data-save-list></div>
          </div>
        </section>

        <section id="preset-screen" class="screen menu-screen" data-screen hidden>
          <div class="wide-card preset-card">
            <p class="eyebrow" data-preset-slot>Save slot 1</p>
            <h2>Choose Alex</h2>
            <p>Alex’s history and dialogue stay the same. Choose the presentation you want to play.</p>
            <div class="preset-grid">
              <button class="preset-option" data-preset="masculine">
                <span class="preset-silhouette preset-silhouette--masculine" aria-hidden="true"></span>
                <strong>Masculine Alex</strong><small>Mechanic · former street racer</small>
              </button>
              <button class="preset-option" data-preset="feminine">
                <span class="preset-silhouette preset-silhouette--feminine" aria-hidden="true"></span>
                <strong>Feminine Alex</strong><small>Mechanic · former street racer</small>
              </button>
            </div>
            <button class="button button--quiet" data-action="back-slots">Back</button>
          </div>
        </section>

        <section id="loading-screen" class="screen loading-screen" data-screen hidden>
          <div class="loading-card">
            <p class="eyebrow">Solara municipal grid</p>
            <h2 data-loading-label>Building Arroyo Heights…</h2>
            <div class="loading-bar" data-loading-bar role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
            <p>Tip: lose police sight, then leave the search radius without being spotted.</p>
          </div>
        </section>

        <section id="game-hud" class="screen game-hud" data-screen hidden aria-label="Game HUD">
          <div class="hud-top-left">
            <div class="status-bars">
              <div class="meter meter--health" data-meter="health"><span></span><b>HEALTH</b></div>
              <div class="meter meter--armor" data-meter="armor"><span></span><b>ARMOR</b></div>
              <div class="meter meter--stamina" data-meter="stamina"><span></span><b>STAMINA</b></div>
            </div>
            <div class="wanted" aria-label="Wanted level"><div data-hud-stars></div><small data-hud-wanted-label></small></div>
          </div>

          <div class="hud-top-center objective-card">
            <small>CURRENT OBJECTIVE</small>
            <strong data-hud-objective>Explore Arroyo Heights</strong>
            <span data-hud-objective-detail></span>
          </div>

          <div class="hud-top-right">
            <strong data-hud-money>$0</strong>
            <span><b data-hud-level>LV 1</b><i class="xp-track" data-hud-xp><span></span></i></span>
            <small><span data-hud-district>Arroyo Heights</span> · <span data-hud-time>18:20</span></small>
          </div>

          <aside class="minimap" aria-label="Minimap">
            <canvas width="180" height="180" data-minimap></canvas>
            <span class="minimap__player" aria-hidden="true"></span>
            <b>N</b>
          </aside>

          <div class="weapon-card">
            <strong data-hud-weapon>Unarmed</strong>
            <span data-hud-ammo>0 / 0</span>
          </div>

          <div class="vehicle-card" data-hud-vehicle hidden>
            <span><strong data-hud-speed>0</strong><small>KM/H</small></span>
            <div><b data-hud-vehicle-name>Vehicle</b><small data-hud-radio>Radio off</small></div>
          </div>

          <div class="interaction-prompt" data-interaction hidden><kbd>E</kbd><span></span></div>
          <div class="dialogue-box" data-dialogue hidden><strong data-dialogue-speaker>Alex</strong><p data-dialogue-text></p></div>
          <div class="toast" data-toast hidden role="status"></div>

          <div class="touch-controls" aria-label="Touch controls">
            <div class="touch-stick" data-touch-stick><span></span></div>
            <div class="touch-camera" data-touch-camera></div>
            <button data-touch-action="interact" aria-label="Interact">E</button>
            <button data-touch-action="sprint" aria-label="Sprint">RUN</button>
            <button data-touch-action="jump" aria-label="Jump or handbrake">JUMP</button>
            <button data-touch-action="aim" aria-label="Aim">AIM</button>
            <button data-touch-action="fire" aria-label="Fire or attack">FIRE</button>
          </div>

          <nav class="quick-nav" aria-label="Game panels">
            <button data-open-panel="map">Map <kbd>M</kbd></button>
            <button data-open-panel="inventory">Inventory <kbd>I</kbd></button>
            <button data-open-panel="skills">Skills</button>
            <button data-action="pause">Pause <kbd>Esc</kbd></button>
          </nav>
        </section>

        <section class="pause-overlay" data-pause-menu hidden aria-label="Pause menu">
          <div class="menu-card">
            <p class="eyebrow">Game paused</p>
            <h2>Solara waits.</h2>
            <nav class="menu-actions">
              <button class="button button--primary" data-action="resume">Resume</button>
              <button class="button" data-open-panel="map">Map</button>
              <button class="button" data-open-panel="inventory">Inventory</button>
              <button class="button" data-open-panel="skills">Skills</button>
              <button class="button" data-open-panel="settings">Settings</button>
              <button class="button button--danger" data-action="quit-menu">Save and quit to menu</button>
            </nav>
          </div>
        </section>

        <section class="panel-overlay" data-panel hidden aria-label="Game panel">
          <div class="panel-card">
            <header class="section-heading">
              <div><p class="eyebrow">Alex Moreno</p><h2 data-panel-title>Map</h2></div>
              <button class="button button--quiet" data-action="close-panel">Close</button>
            </header>
            <div class="panel-body" data-panel-body></div>
          </div>
        </section>

        <div class="rotate-overlay" aria-live="polite">
          <div class="phone-rotate" aria-hidden="true"></div>
          <strong>Rotate to landscape</strong>
          <span>HEATLINE is designed for a wide screen.</span>
        </div>
      </div>
    `;
  }

  #bindEvents(): void {
    this.#root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const actionButton = target.closest<HTMLElement>('[data-action]');
      if (actionButton) this.#handleAction(actionButton.dataset.action ?? '');

      const slotButton = target.closest<HTMLElement>('[data-slot-action]');
      if (slotButton) {
        const slot = Number(slotButton.dataset.slot) as 1 | 2 | 3;
        const action = slotButton.dataset.slotAction;
        if (action === 'new') this.showPresetChoice(slot);
        if (action === 'continue') this.#callbacks.onContinueGame(slot);
        if (action === 'delete') this.#callbacks.onDeleteSlot(slot);
      }

      const preset = target.closest<HTMLElement>('[data-preset]')?.dataset.preset as AlexPreset | undefined;
      if (preset) this.#callbacks.onStartNewGame(this.#selectedSlot, preset);

      const panel = target.closest<HTMLElement>('[data-open-panel]')?.dataset.openPanel as OverlayPanel | undefined;
      if (panel) this.openPanel(panel);
    });

    this.#root.querySelectorAll<HTMLElement>('[data-touch-action]').forEach((button) => {
      const action = button.dataset.touchAction ?? '';
      const press = (event: Event): void => {
        event.preventDefault();
        this.#callbacks.onTouchAction(action, true);
        button.classList.add('is-active');
      };
      const release = (event: Event): void => {
        event.preventDefault();
        this.#callbacks.onTouchAction(action, false);
        button.classList.remove('is-active');
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
    });
  }

  #handleAction(action: string): void {
    switch (action) {
      case 'enter-menu':
      case 'back-menu':
        this.showMainMenu();
        break;
      case 'play':
        this.#callbacks.onRequestSaveSlots();
        break;
      case 'back-slots':
        this.#setVisibleScreen('save-slots');
        break;
      case 'open-settings':
        this.openPanel('settings');
        break;
      case 'show-controls':
        this.openPanel('settings', 'Controls', this.#controlsContent());
        break;
      case 'pause':
        this.showPause();
        this.#callbacks.onPause();
        break;
      case 'resume':
        this.hidePause();
        this.#callbacks.onResume();
        break;
      case 'quit-menu':
        this.hidePause();
        this.#callbacks.onQuitToMenu();
        break;
      case 'close-panel':
        this.closePanel();
        break;
      default:
        break;
    }
  }

  #setVisibleScreen(id: string): void {
    this.#root.querySelectorAll<HTMLElement>('[data-screen]').forEach((screen) => {
      screen.hidden = screen.id !== id;
    });
  }

  #setMeter(name: string, value: number, max: number): void {
    const meter = this.#query<HTMLElement>(`[data-meter="${name}"]`);
    meter.style.setProperty('--value', `${clampPercent((value / Math.max(max, 1)) * 100)}%`);
    meter.setAttribute('aria-label', `${name}: ${Math.round(value)} of ${Math.round(max)}`);
  }

  #defaultPanelContent(panel: OverlayPanel): string {
    if (panel === 'map') {
      return `<div class="map-placeholder"><div class="map-grid"></div><strong>SOLARA</strong><p>Neon Strand · Alta Vista · Arroyo Heights · Breakwater</p></div>`;
    }
    if (panel === 'inventory') {
      return `<div class="inventory-layout"><div><h3>Backpack</h3><div class="inventory-grid">${'<i></i>'.repeat(48)}</div></div><aside><h3>Loadout</h3><p>Unarmed</p><p>20.0 kg available</p><button class="button">Auto-sort</button></aside></div>`;
    }
    if (panel === 'skills') {
      return `<div class="skill-columns"><article><h3>Combat</h3><p>Steady Hands · Fast Hands · Thick Skin</p></article><article><h3>Driving</h3><p>Road Grip · Gearhead · Handbrake Ace</p></article><article><h3>Streetcraft</h3><p>Silver Tongue · Side Hustle · Light Fingers</p></article></div>`;
    }
    if (panel === 'properties') {
      return `<div class="list-panel"><p>Breakwater Warehouse</p><p>Neon Strand Club</p><p>Alta Vista Print Shop</p><p>Arroyo Diner</p><p>Coastline Car Wash</p></div>`;
    }
    if (panel === 'missions') {
      return `<div class="list-panel"><p><strong>Past Due</strong><br>Get the customer car back.</p><p>Three contacts will call after the garage is safe.</p></div>`;
    }
    return this.#settingsContent();
  }

  #settingsContent(): string {
    return `
      <form class="settings-grid">
        <label>Master volume <input type="range" min="0" max="100" value="80"></label>
        <label>Music volume <input type="range" min="0" max="100" value="65"></label>
        <label>Camera sensitivity <input type="range" min="20" max="200" value="100"></label>
        <label>UI scale <input type="range" min="80" max="130" value="100"></label>
        <label><input type="checkbox"> Reduce camera shake</label>
        <label><input type="checkbox"> High-contrast objectives</label>
        <label>Aim assist <select><option>Standard</option><option>Strong</option><option>Off</option></select></label>
        <label>Quality <select><option>Auto</option><option>High</option><option>Low</option></select></label>
      </form>
    `;
  }

  #controlsContent(): string {
    return `
      <div class="controls-grid">
        <span><kbd>WASD</kbd> Move / drive</span><span><kbd>Mouse</kbd> Camera / aim</span>
        <span><kbd>E</kbd> Interact / enter</span><span><kbd>Space</kbd> Jump / handbrake</span>
        <span><kbd>Shift</kbd> Sprint</span><span><kbd>C</kbd> Crouch / camera</span>
        <span><kbd>Tab</kbd> Weapon radial</span><span><kbd>M</kbd> City map</span>
      </div>
    `;
  }

  #query<T extends Element>(selector: string): T {
    const element = this.#root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }
}
