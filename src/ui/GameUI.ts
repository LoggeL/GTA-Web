import type { GameSettings, InputAction, InputBinding } from '../core';
import { isValidKeyboardCode } from '../input';

export type AlexPreset = 'masculine' | 'feminine';
export type OverlayPanel = 'map' | 'inventory' | 'skills' | 'garage' | 'properties' | 'missions' | 'settings';

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
  wantedSearchRadius?: number;
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
  vehicleHealth?: number;
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
  onSettingsChange(settings: GameSettings): void;
  onRetryStream?(): void;
  onReturnFromStreamFailure?(): void;
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

const INPUT_ACTION_LABELS: Readonly<Record<InputAction, string>> = {
  moveForward: 'Move forward',
  moveBackward: 'Move backward',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  primaryAction: 'Primary action',
  aim: 'Aim',
  sprint: 'Sprint',
  jumpHandbrake: 'Jump / handbrake',
  crouchCamera: 'Crouch / vehicle camera',
  interactEnterExit: 'Interact / enter / exit',
  meleeContext: 'Melee / context action',
  reloadVehicleReset: 'Reload / vehicle reset',
  shoulderSwap: 'Shoulder swap',
  weaponRadial: 'Weapon radial',
  inventory: 'Inventory',
  map: 'City map',
  pause: 'Pause',
};

const KEYBOARD_CODE_LABELS: Readonly<Record<string, string>> = {
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ArrowDown: 'Down Arrow',
  ArrowLeft: 'Left Arrow',
  ArrowRight: 'Right Arrow',
  ArrowUp: 'Up Arrow',
  Backquote: 'Backquote',
  Backslash: 'Backslash',
  Backspace: 'Backspace',
  BracketLeft: 'Left Bracket',
  BracketRight: 'Right Bracket',
  CapsLock: 'Caps Lock',
  Comma: 'Comma',
  ContextMenu: 'Context Menu',
  ControlLeft: 'Left Control',
  ControlRight: 'Right Control',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Equal: 'Equals',
  Escape: 'Escape',
  Home: 'Home',
  Insert: 'Insert',
  IntlBackslash: 'International Backslash',
  IntlRo: 'International Ro',
  IntlYen: 'International Yen',
  MetaLeft: 'Left Command',
  MetaRight: 'Right Command',
  Minus: 'Minus',
  NumLock: 'Number Lock',
  PageDown: 'Page Down',
  PageUp: 'Page Up',
  Pause: 'Pause / Break',
  Period: 'Period',
  Quote: 'Quote',
  ScrollLock: 'Scroll Lock',
  Semicolon: 'Semicolon',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  Slash: 'Slash',
  Space: 'Space',
  Tab: 'Tab',
};

export interface KeyboardBindingSwap {
  settings: GameSettings;
  previousCode: string;
  swappedAction?: InputAction;
}

export type TouchControlLayout = Readonly<Record<
  string,
  readonly [ariaLabel: string, text: string, hidden: boolean]
>>;

const ON_FOOT_TOUCH_CONTROL_LAYOUT: TouchControlLayout = {
  interact: ['Interact', 'E', false],
  sprint: ['Sprint', 'RUN', false],
  jump: ['Jump', 'JUMP', false],
  crouch: ['Crouch', 'CROUCH', false],
  aim: ['Aim', 'AIM', false],
  fire: ['Fire or attack', 'FIRE', false],
  melee: ['Charge heavy attack', 'HEAVY', false],
  reload: ['Reload', 'RELOAD', false],
  weaponRadial: ['Cycle weapon', 'SWAP', false],
};

const VEHICLE_TOUCH_CONTROL_LAYOUT: TouchControlLayout = {
  interact: ['Exit vehicle', 'EXIT', false],
  sprint: ['Sprint', 'RUN', true],
  jump: ['Handbrake', 'BRAKE', false],
  crouch: ['Vehicle camera', 'CAM', false],
  aim: ['Vehicle aim', 'AIM', false],
  fire: ['Vehicle action or siren', 'ACTION', false],
  melee: ['Charge heavy attack', 'HEAVY', true],
  reload: ['Vehicle reset', 'RESET', false],
  weaponRadial: ['Cycle radio station', 'RADIO', false],
};

/** Returns the complete touch action contract for the active player mode. */
export function getTouchControlLayout(vehicleMode: boolean): TouchControlLayout {
  return vehicleMode ? VEHICLE_TOUCH_CONTROL_LAYOUT : ON_FOOT_TOUCH_CONTROL_LAYOUT;
}

/** Returns a readable, layout-independent label for a KeyboardEvent.code value. */
export function formatKeyboardCode(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const suffix = code.slice(6).replace(/([a-z])([A-Z])/g, '$1 $2');
    return `Numpad ${suffix}`;
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEYBOARD_CODE_LABELS[code] ?? code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Replaces one keyboard binding without ever exposing a duplicate map. If the
 * requested key is already assigned, the two binding slots exchange keys.
 */
export function remapKeyboardBinding(
  settings: GameSettings,
  action: InputAction,
  bindingIndex: number,
  code: string,
): KeyboardBindingSwap {
  if (!isValidKeyboardCode(code)) throw new Error(`Unsupported keyboard code: ${code}`);
  const next = cloneSettings(settings);
  const target = next.controls.bindings[action][bindingIndex];
  if (!target || target.device !== 'keyboard') {
    throw new Error(`Missing keyboard binding at ${action}[${bindingIndex}]`);
  }

  const previousCode = target.code;
  let owner: { action: InputAction; index: number; binding: InputBinding } | undefined;
  for (const [candidateAction, bindings] of Object.entries(next.controls.bindings) as [InputAction, InputBinding[]][]) {
    const candidateIndex = bindings.findIndex((binding) => binding.device === 'keyboard' && binding.code === code);
    if (candidateIndex >= 0) {
      owner = { action: candidateAction, index: candidateIndex, binding: bindings[candidateIndex]! };
      break;
    }
  }

  if (owner?.action === action && owner.index === bindingIndex) {
    return { settings: next, previousCode };
  }

  target.code = code;
  if (owner) owner.binding.code = previousCode;
  return {
    settings: next,
    previousCode,
    swappedAction: owner?.action === action ? undefined : owner?.action,
  };
}

interface BindingCapture {
  action: InputAction;
  bindingIndex: number;
}

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Returns a wrap target only when focus would otherwise leave a modal. */
export function modalFocusWrapTarget<T extends Element>(
  focusable: readonly T[],
  activeElement: Element | null,
  shiftKey: boolean,
): T | null {
  if (focusable.length === 0) return null;
  const activeIndex = focusable.indexOf(activeElement as T);
  if (activeIndex < 0) return shiftKey ? focusable.at(-1) ?? null : focusable[0] ?? null;
  if (shiftKey && activeIndex === 0) return focusable.at(-1) ?? null;
  if (!shiftKey && activeIndex === focusable.length - 1) return focusable[0] ?? null;
  return null;
}

export class GameUI {
  readonly #root: HTMLElement;
  readonly #callbacks: GameUICallbacks;
  #settings: GameSettings;
  #selectedSlot: 1 | 2 | 3 = 1;
  #toastTimer = 0;
  #dialogueTimer = 0;
  #bindingCapture: BindingCapture | null = null;
  #streamFailureReturnFocus: HTMLElement | null = null;
  #pauseReturnFocus: HTMLElement | null = null;
  #panelReturnFocus: HTMLElement | null = null;
  #touchVehicleMode: boolean | null = null;

  readonly #handleBindingKeyDown = (event: KeyboardEvent): void => {
    const capture = this.#bindingCapture;
    if (!capture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') {
      this.#cancelBindingCapture('Binding change cancelled.');
      return;
    }
    if (!isValidKeyboardCode(event.code)) {
      this.#setBindingStatus('That key is not supported. Press another key, or Escape to cancel.');
      return;
    }
    this.#applyKeyboardBinding(capture, event.code);
  };

  readonly #handleModalKeyDown = (event: KeyboardEvent): void => {
    if (this.#bindingCapture) return;
    const modal = this.#activeModal();
    if (!modal) return;

    if (event.key === 'Tab') {
      const focusable = this.#modalFocusableElements(modal);
      const wrapTarget = modalFocusWrapTarget(focusable, document.activeElement, event.shiftKey);
      if (!wrapTarget) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      wrapTarget.focus({ preventScroll: true });
      return;
    }

    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (modal.matches('[data-panel]')) {
      this.closePanel();
    } else if (modal.matches('[data-pause-menu]')) {
      this.hidePause();
      this.#callbacks.onResume();
    }
  };

  readonly #handleModalFocusIn = (event: FocusEvent): void => {
    const modal = this.#activeModal();
    const target = event.target;
    if (!modal || !(target instanceof Element) || modal.contains(target)) return;
    this.#focusModal(modal);
  };

  constructor(root: HTMLElement, callbacks: GameUICallbacks, settings: GameSettings) {
    this.#root = root;
    this.#callbacks = callbacks;
    this.#settings = cloneSettings(settings);
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

  showUnsupportedBrowser(reason = 'WebGL2 could not start on this device.'): void {
    this.#setVisibleScreen('unsupported-screen');
    this.#query<HTMLElement>('[data-unsupported-reason]').textContent = reason;
    this.#root.classList.remove('is-playing');
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
    const xpProgress = clampPercent(snapshot.xpProgress);
    const xpMeter = this.#query<HTMLElement>('[data-hud-xp]');
    xpMeter.querySelector<HTMLElement>('span')!.style.width = `${xpProgress}%`;
    xpMeter.setAttribute('aria-valuenow', String(Math.round(xpProgress)));
    this.#query<HTMLElement>('[data-hud-weapon]').textContent = snapshot.weapon;
    this.#query<HTMLElement>('[data-hud-ammo]').textContent = `${snapshot.ammo} / ${snapshot.ammoReserve}`;
    this.#query<HTMLElement>('[data-hud-stars]').innerHTML = Array.from({ length: 5 }, (_, index) => {
      const active = index < snapshot.wantedLevel;
      return `<span class="wanted-star ${active ? 'is-active' : ''}" aria-hidden="true">★</span>`;
    }).join('');
    const wanted = this.#query<HTMLElement>('.wanted');
    const searchRadius = Math.max(0, Math.round(snapshot.wantedSearchRadius ?? 0));
    const wantedMode = snapshot.wantedSearching ? 'SEARCH' : 'PURSUIT';
    this.#query<HTMLElement>('[data-hud-wanted-label]').textContent = snapshot.wantedLevel === 0
      ? ''
      : `${wantedMode}${searchRadius > 0 ? ` · ${searchRadius}M` : ''}`;
    wanted.setAttribute(
      'aria-label',
      snapshot.wantedLevel === 0
        ? 'Wanted level 0, clear'
        : `Wanted level ${snapshot.wantedLevel}, ${wantedMode.toLowerCase()}, search radius ${searchRadius} meters`,
    );

    const vehicle = this.#query<HTMLElement>('[data-hud-vehicle]');
    vehicle.hidden = snapshot.speedKph === undefined;
    if (snapshot.speedKph !== undefined) {
      this.#query<HTMLElement>('[data-hud-speed]').textContent = String(Math.round(snapshot.speedKph));
      this.#query<HTMLElement>('[data-hud-vehicle-name]').textContent = snapshot.vehicleName ?? 'Vehicle';
      this.#query<HTMLElement>('[data-hud-radio]').textContent = snapshot.radio ?? 'Radio off';
      const health = clampPercent(snapshot.vehicleHealth ?? 100);
      const healthMeter = this.#query<HTMLElement>('[data-hud-vehicle-health]');
      healthMeter.style.setProperty('--vehicle-health', `${health}%`);
      healthMeter.setAttribute('aria-valuenow', String(Math.round(health)));
      this.#query<HTMLElement>('[data-hud-vehicle-health-label]').textContent = `ENGINE ${Math.round(health)}%`;
    }
    this.#setTouchLayout(snapshot.speedKph !== undefined);

    const interaction = this.#query<HTMLElement>('[data-interaction]');
    interaction.hidden = !snapshot.interaction;
    interaction.querySelector('span')!.textContent = snapshot.interaction ?? '';
  }

  showPause(): void {
    const overlay = this.#query<HTMLElement>('[data-pause-menu]');
    if (overlay.hidden) this.#pauseReturnFocus = this.#currentFocusWithinRoot();
    overlay.hidden = false;
    this.#root.classList.add('is-paused');
    this.#syncModalInertState();
    this.#focusModal(overlay, '[data-pause-title]');
  }

  hidePause(): void {
    const overlay = this.#query<HTMLElement>('[data-pause-menu]');
    if (overlay.hidden) return;
    overlay.hidden = true;
    this.#root.classList.remove('is-paused');
    this.#syncModalInertState();
    const returnFocus = this.#pauseReturnFocus;
    this.#pauseReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  /** Blocks the in-game UI until world streaming recovers or the player leaves. */
  showStreamFailure(message: string): void {
    this.#cancelBindingCapture('Binding change cancelled because world streaming stopped.');
    const overlay = this.#query<HTMLElement>('[data-stream-failure]');
    if (overlay.hidden) {
      const activeElement = document.activeElement;
      this.#streamFailureReturnFocus = activeElement instanceof HTMLElement && this.#root.contains(activeElement)
        ? activeElement
        : null;
    }
    this.#query<HTMLElement>('[data-stream-failure-message]').textContent = message;
    overlay.hidden = false;
    this.#root.classList.add('has-stream-failure');
    this.#syncModalInertState();
    this.#query<HTMLButtonElement>('[data-stream-retry]').focus({ preventScroll: true });
  }

  /** Removes the streaming blocker without changing the world's pause state. */
  hideStreamFailure(): void {
    const overlay = this.#query<HTMLElement>('[data-stream-failure]');
    if (overlay.hidden) return;
    overlay.hidden = true;
    this.#root.classList.remove('has-stream-failure');
    this.#syncModalInertState();
    const returnFocus = this.#streamFailureReturnFocus;
    this.#streamFailureReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  openPanel(panel: OverlayPanel, title?: string, body?: string): void {
    this.#cancelBindingCapture();
    const overlay = this.#query<HTMLElement>('[data-panel]');
    if (overlay.hidden) this.#panelReturnFocus = this.#currentFocusWithinRoot();
    overlay.hidden = false;
    overlay.dataset.panel = panel;
    const region = this.#root.querySelector<HTMLElement>('[data-panel-region]');
    if (region) region.dataset.panel = panel;
    this.#query<HTMLElement>('[data-panel-title]').textContent = title ?? panel[0]!.toUpperCase() + panel.slice(1);
    this.#query<HTMLElement>('[data-panel-body]').innerHTML = body ?? this.#defaultPanelContent(panel);
    this.#callbacks.onOpenPanel(panel);
    this.#syncModalInertState();
    this.#focusModal(overlay, '[data-panel-title]');
  }

  closePanel(): void {
    this.#cancelBindingCapture();
    const overlay = this.#query<HTMLElement>('[data-panel]');
    if (overlay.hidden) {
      this.#callbacks.onClosePanel();
      return;
    }
    overlay.hidden = true;
    this.#callbacks.onClosePanel();
    this.#syncModalInertState();
    const returnFocus = this.#panelReturnFocus;
    this.#panelReturnFocus = null;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
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

  setSettings(settings: GameSettings): void {
    this.#cancelBindingCapture();
    this.#settings = cloneSettings(settings);
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (panel?.dataset.panel === 'settings' && !panel.hidden) {
      this.#query<HTMLElement>('[data-panel-body]').innerHTML = this.#settingsContent();
    }
  }

  destroy(): void {
    this.#cancelBindingCapture();
    window.removeEventListener('keydown', this.#handleBindingKeyDown, true);
    window.removeEventListener('keydown', this.#handleModalKeyDown, true);
    window.removeEventListener('focusin', this.#handleModalFocusIn, true);
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
            <div class="loading-bar" data-loading-bar role="progressbar" aria-label="Loading Solara" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
            <p>Tip: lose police sight, then leave the search radius without being spotted.</p>
          </div>
        </section>

        <section id="unsupported-screen" class="screen menu-screen" data-screen hidden>
          <div class="menu-card" role="alert">
            <p class="eyebrow">Compatibility check</p>
            <h2>Solara needs WebGL2.</h2>
            <p data-unsupported-reason>WebGL2 could not start on this device.</p>
            <p>Try a current version of Chrome, Edge, Firefox, or Safari with hardware acceleration enabled.</p>
            <button class="button" data-action="back-menu">Return to menu</button>
          </div>
        </section>

        <section id="game-hud" class="screen game-hud" data-screen hidden aria-label="Game HUD">
          <div class="hud-top-left">
            <div class="status-bars">
              <div class="meter meter--health" data-meter="health" role="progressbar" aria-label="health: 100 of 100" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span></span><b>HEALTH</b></div>
              <div class="meter meter--armor" data-meter="armor" role="progressbar" aria-label="armor: 0 of 100" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span><b>ARMOR</b></div>
              <div class="meter meter--stamina" data-meter="stamina" role="progressbar" aria-label="stamina: 100 of 100" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span></span><b>STAMINA</b></div>
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
            <span><b data-hud-level>LV 1</b><i class="xp-track" data-hud-xp role="progressbar" aria-label="Experience toward next level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></i></span>
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
            <div>
              <b data-hud-vehicle-name>Vehicle</b><small data-hud-radio>Radio off</small>
              <span class="vehicle-condition" data-hud-vehicle-health role="progressbar" aria-label="Vehicle engine health" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i></i></span>
              <small data-hud-vehicle-health-label>ENGINE 100%</small>
            </div>
          </div>

          <div class="interaction-prompt" data-interaction hidden><kbd>E</kbd><span></span></div>
          <div class="dialogue-box" data-dialogue hidden role="status" aria-live="polite" aria-atomic="true"><strong data-dialogue-speaker>Alex</strong><p data-dialogue-text></p></div>
          <div class="toast" data-toast hidden role="status"></div>

          <button type="button" class="touch-menu-button" data-action="pause" aria-label="Pause game and open menu"><span aria-hidden="true">☰</span><b>Menu</b></button>

          <div class="touch-controls" data-touch-layout="on-foot" aria-label="On-foot touch controls">
            <div class="touch-stick" data-touch-stick role="group" aria-label="Movement stick">
              <span></span><small data-touch-stick-label>MOVE</small>
            </div>
            <div class="touch-camera" data-touch-camera></div>
            <button data-touch-action="interact" aria-label="Interact">E</button>
            <button data-touch-action="sprint" aria-label="Sprint">RUN</button>
            <button data-touch-action="jump" aria-label="Jump">JUMP</button>
            <button data-touch-action="crouch" aria-label="Crouch">CROUCH</button>
            <button data-touch-action="aim" aria-label="Aim">AIM</button>
            <button data-touch-action="fire" aria-label="Fire or attack">FIRE</button>
            <button data-touch-action="melee" aria-label="Charge heavy attack">HEAVY</button>
            <button data-touch-action="reload" aria-label="Reload">RELOAD</button>
            <button data-touch-action="weaponRadial" aria-label="Cycle weapon">SWAP</button>
          </div>

          <nav class="quick-nav" aria-label="Game panels">
            <button data-open-panel="map">Map <kbd>M</kbd></button>
            <button data-open-panel="inventory">Inventory <kbd>I</kbd></button>
            <button data-open-panel="missions">Jobs <kbd>J</kbd></button>
            <button data-open-panel="skills">Skills</button>
            <button data-open-panel="garage">Garage</button>
            <button data-open-panel="properties">Economy</button>
            <button data-action="pause">Pause <kbd>Esc</kbd></button>
          </nav>
        </section>

        <section class="pause-overlay" data-pause-menu hidden role="dialog" aria-modal="true" aria-labelledby="pause-menu-title">
          <div class="menu-card">
            <p class="eyebrow">Game paused</p>
            <h2 id="pause-menu-title" data-pause-title tabindex="-1">Pause menu</h2>
            <p class="pause-tagline">Solara waits.</p>
            <nav class="menu-actions">
              <button class="button button--primary" data-action="resume">Resume</button>
              <button class="button" data-open-panel="map">Map</button>
              <button class="button" data-open-panel="inventory">Inventory</button>
              <button class="button" data-open-panel="missions">Jobs & mission log</button>
              <button class="button" data-open-panel="skills">Skills</button>
              <button class="button" data-open-panel="garage">Garage</button>
              <button class="button" data-open-panel="properties">Economy</button>
              <button class="button" data-open-panel="settings">Settings</button>
              <button class="button button--danger" data-action="quit-menu">Save and quit to menu</button>
            </nav>
          </div>
        </section>

        <section class="panel-overlay" data-panel hidden role="dialog" aria-modal="true" aria-labelledby="game-panel-title">
          <div class="panel-region" data-panel-region role="region" aria-label="Game panel">
            <div class="panel-card">
              <header class="section-heading">
                <div><p class="eyebrow">Alex Moreno</p><h2 id="game-panel-title" data-panel-title tabindex="-1">Map</h2></div>
                <button class="button button--quiet" data-action="close-panel">Close</button>
              </header>
              <div class="panel-body" data-panel-body></div>
            </div>
          </div>
        </section>

        <section
          class="stream-failure-overlay"
          data-stream-failure
          hidden
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="stream-failure-title"
          aria-describedby="stream-failure-message"
        >
          <div class="stream-failure-card">
            <p class="eyebrow">World stream interrupted</p>
            <h2 id="stream-failure-title">Solara stopped loading.</h2>
            <p id="stream-failure-message" data-stream-failure-message>
              A required city area could not be loaded.
            </p>
            <div class="stream-failure-actions">
              <button class="button button--primary" data-action="retry-stream" data-stream-retry>Retry</button>
              <button class="button button--quiet" data-action="return-stream-menu">Return to menu</button>
            </div>
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
    window.addEventListener('keydown', this.#handleBindingKeyDown, true);
    window.addEventListener('keydown', this.#handleModalKeyDown, true);
    window.addEventListener('focusin', this.#handleModalFocusIn, true);
    this.#root.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const actionButton = target.closest<HTMLElement>('[data-action]');
      if (actionButton) this.#handleAction(actionButton.dataset.action ?? '');

      const bindingButton = target.closest<HTMLButtonElement>('[data-binding-action]');
      if (bindingButton) this.#startBindingCapture(bindingButton);

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

    this.#root.addEventListener('input', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
        this.#handleSettingsInput(target);
      }
    });
  }

  #setTouchLayout(vehicleMode: boolean): void {
    if (this.#touchVehicleMode === vehicleMode) return;
    this.#touchVehicleMode = vehicleMode;

    const controls = this.#query<HTMLElement>('.touch-controls');
    controls.dataset.touchLayout = vehicleMode ? 'vehicle' : 'on-foot';
    controls.setAttribute('aria-label', vehicleMode ? 'Vehicle touch controls' : 'On-foot touch controls');

    const stick = this.#query<HTMLElement>('[data-touch-stick]');
    stick.setAttribute('aria-label', vehicleMode ? 'Steering and throttle stick' : 'Movement stick');
    this.#query<HTMLElement>('[data-touch-stick-label]').textContent = vehicleMode ? 'DRIVE' : 'MOVE';

    const layouts = getTouchControlLayout(vehicleMode);

    for (const [action, [label, text, hidden]] of Object.entries(layouts)) {
      const button = this.#query<HTMLButtonElement>(`[data-touch-action="${action}"]`);
      if (button.classList.contains('is-active')) {
        this.#callbacks.onTouchAction(action, false);
        button.classList.remove('is-active');
      }
      button.hidden = hidden;
      button.setAttribute('aria-label', label);
      button.textContent = text;
    }
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
      case 'retry-stream':
        this.#callbacks.onRetryStream?.();
        break;
      case 'return-stream-menu':
        this.hideStreamFailure();
        this.#callbacks.onReturnFromStreamFailure?.();
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
    const safeMax = Math.max(max, 1);
    const safeValue = Math.max(0, Math.min(safeMax, value));
    meter.style.setProperty('--value', `${clampPercent((safeValue / safeMax) * 100)}%`);
    meter.setAttribute('aria-label', `${name}: ${Math.round(safeValue)} of ${Math.round(safeMax)}`);
    meter.setAttribute('aria-valuemax', String(Math.round(safeMax)));
    meter.setAttribute('aria-valuenow', String(Math.round(safeValue)));
  }

  #currentFocusWithinRoot(): HTMLElement | null {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLElement && this.#root.contains(activeElement)
      ? activeElement
      : null;
  }

  #activeModal(): HTMLElement | null {
    const streamFailure = this.#root.querySelector<HTMLElement>('[data-stream-failure]');
    if (streamFailure && !streamFailure.hidden) return streamFailure;
    const panel = this.#root.querySelector<HTMLElement>('[data-panel]');
    if (panel && !panel.hidden) return panel;
    const pause = this.#root.querySelector<HTMLElement>('[data-pause-menu]');
    return pause && !pause.hidden ? pause : null;
  }

  #modalFocusableElements(modal: HTMLElement): HTMLElement[] {
    return [...modal.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)]
      .filter((element) => !element.hidden && !element.inert && element.getAttribute('aria-hidden') !== 'true');
  }

  #focusModal(modal: HTMLElement, preferredSelector?: string): void {
    const preferred = preferredSelector
      ? modal.querySelector<HTMLElement>(preferredSelector)
      : null;
    const target = preferred ?? this.#modalFocusableElements(modal)[0];
    target?.focus({ preventScroll: true });
  }

  #syncModalInertState(): void {
    const activeModal = this.#activeModal();
    this.#root.querySelectorAll<HTMLElement>('[data-screen]').forEach((screen) => {
      const containsModal = activeModal !== null && screen.contains(activeModal);
      screen.inert = activeModal !== null && !containsModal;
      for (const child of screen.children) {
        if (!(child instanceof HTMLElement)) continue;
        child.inert = activeModal !== null
          && containsModal
          && child !== activeModal
          && !child.contains(activeModal);
      }
    });
    for (const selector of ['[data-pause-menu]', '[data-panel]', '[data-stream-failure]']) {
      const overlay = this.#root.querySelector<HTMLElement>(selector);
      if (overlay) overlay.inert = activeModal !== null && overlay !== activeModal;
    }
    this.#root.classList.toggle('has-modal', activeModal !== null);
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
    if (panel === 'garage') {
      return `<div class="list-panel"><p>Enter Moreno Garage in Arroyo Heights to register, repair, and upgrade vehicles.</p></div>`;
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
    const settings = this.#settings;
    const checked = (value: boolean): string => value ? 'checked' : '';
    return `
      <form class="settings-grid">
        <fieldset><legend>Audio</legend>
          <label>Master volume <input data-setting="audio.master" type="range" min="0" max="100" value="${Math.round(settings.audio.master * 100)}"></label>
          <label>Music volume <input data-setting="audio.music" type="range" min="0" max="100" value="${Math.round(settings.audio.music * 100)}"></label>
          <label>Effects volume <input data-setting="audio.sfx" type="range" min="0" max="100" value="${Math.round(settings.audio.sfx * 100)}"></label>
          <label>UI volume <input data-setting="audio.ui" type="range" min="0" max="100" value="${Math.round(settings.audio.ui * 100)}"></label>
          <label>Ambience volume <input data-setting="audio.ambience" type="range" min="0" max="100" value="${Math.round(settings.audio.ambience * 100)}"></label>
        </fieldset>
        <fieldset><legend>Controls</legend>
          <label>Mouse sensitivity <input data-setting="controls.mouseSensitivity" type="range" min="10" max="300" value="${Math.round(settings.controls.mouseSensitivity * 100)}"></label>
          <label>Touch sensitivity <input data-setting="controls.touchSensitivity" type="range" min="10" max="300" value="${Math.round(settings.controls.touchSensitivity * 100)}"></label>
          <label><input data-setting="controls.invertY" type="checkbox" ${checked(settings.controls.invertY)}> Invert camera Y</label>
          <label><input data-setting="controls.softLock" type="checkbox" ${checked(settings.controls.softLock)}> Desktop soft lock</label>
          <label>Aim assist <select data-setting="controls.aimAssist">
            ${selectOptions(['off', 'low', 'medium', 'high'], settings.controls.aimAssist)}
          </select></label>
          <label>Touch size <input data-setting="controls.touchControlScale" type="range" min="75" max="150" value="${Math.round(settings.controls.touchControlScale * 100)}"></label>
          <label>Touch opacity <input data-setting="controls.touchControlOpacity" type="range" min="25" max="100" value="${Math.round(settings.controls.touchControlOpacity * 100)}"></label>
        </fieldset>
        ${this.#keyboardBindingsContent()}
        <fieldset><legend>Accessibility</legend>
          <label>UI scale <input data-setting="accessibility.uiScale" type="range" min="75" max="150" value="${Math.round(settings.accessibility.uiScale * 100)}"></label>
          <label>Camera shake <input data-setting="accessibility.cameraShake" type="range" min="0" max="100" value="${Math.round(settings.accessibility.cameraShake * 100)}"></label>
          <label><input data-setting="accessibility.reducedMotion" type="checkbox" ${checked(settings.accessibility.reducedMotion)}> Reduced motion</label>
          <label><input data-setting="accessibility.highContrastIndicators" type="checkbox" ${checked(settings.accessibility.highContrastIndicators)}> High-contrast objectives</label>
          <label><input data-setting="accessibility.subtitleBackground" type="checkbox" ${checked(settings.accessibility.subtitleBackground)}> Subtitle background</label>
          <label>Subtitle size <select data-setting="accessibility.subtitleSize">
            ${selectOptions(['small', 'medium', 'large'], settings.accessibility.subtitleSize)}
          </select></label>
        </fieldset>
        <fieldset><legend>Video</legend>
          <label>Quality <select data-setting="video.quality">
            ${selectOptions(['auto', 'low', 'high'], settings.video.quality)}
          </select></label>
          <label>Resolution scale <input data-setting="video.resolutionScale" type="range" min="50" max="100" value="${Math.round(settings.video.resolutionScale * 100)}"></label>
        </fieldset>
      </form>
    `;
  }

  #handleSettingsInput(control: HTMLInputElement | HTMLSelectElement): void {
    const path = control.dataset.setting;
    if (!path) return;
    const percent = (): number => Number(control.value) / 100;
    switch (path) {
      case 'audio.master': this.#settings.audio.master = percent(); break;
      case 'audio.music': this.#settings.audio.music = percent(); break;
      case 'audio.sfx': this.#settings.audio.sfx = percent(); break;
      case 'audio.ui': this.#settings.audio.ui = percent(); break;
      case 'audio.ambience': this.#settings.audio.ambience = percent(); break;
      case 'controls.mouseSensitivity': this.#settings.controls.mouseSensitivity = percent(); break;
      case 'controls.touchSensitivity': this.#settings.controls.touchSensitivity = percent(); break;
      case 'controls.touchControlScale': this.#settings.controls.touchControlScale = percent(); break;
      case 'controls.touchControlOpacity': this.#settings.controls.touchControlOpacity = percent(); break;
      case 'controls.invertY': this.#settings.controls.invertY = readCheckbox(control); break;
      case 'controls.softLock': this.#settings.controls.softLock = readCheckbox(control); break;
      case 'controls.aimAssist':
        if (isChoice(control.value, ['off', 'low', 'medium', 'high'])) this.#settings.controls.aimAssist = control.value;
        break;
      case 'accessibility.uiScale': this.#settings.accessibility.uiScale = percent(); break;
      case 'accessibility.cameraShake': this.#settings.accessibility.cameraShake = percent(); break;
      case 'accessibility.reducedMotion': this.#settings.accessibility.reducedMotion = readCheckbox(control); break;
      case 'accessibility.highContrastIndicators': this.#settings.accessibility.highContrastIndicators = readCheckbox(control); break;
      case 'accessibility.subtitleBackground': this.#settings.accessibility.subtitleBackground = readCheckbox(control); break;
      case 'accessibility.subtitleSize':
        if (isChoice(control.value, ['small', 'medium', 'large'])) this.#settings.accessibility.subtitleSize = control.value;
        break;
      case 'video.quality':
        if (isChoice(control.value, ['auto', 'low', 'high'])) this.#settings.video.quality = control.value;
        break;
      case 'video.resolutionScale': this.#settings.video.resolutionScale = percent(); break;
      default: return;
    }
    this.#callbacks.onSettingsChange(cloneSettings(this.#settings));
  }

  #keyboardBindingsContent(): string {
    const rows = (Object.entries(this.#settings.controls.bindings) as [InputAction, InputBinding[]][])
      .map(([action, bindings]) => {
        const keyboardBindings = bindings
          .map((binding, bindingIndex) => ({ binding, bindingIndex }))
          .filter(({ binding }) => binding.device === 'keyboard');
        if (keyboardBindings.length === 0) return '';
        const actionLabel = INPUT_ACTION_LABELS[action];
        const buttons = keyboardBindings.map(({ binding, bindingIndex }) => {
          const keyLabel = formatKeyboardCode(binding.code);
          return `<button type="button" class="binding-key" data-binding-action="${action}" data-binding-index="${bindingIndex}" aria-label="Change ${escapeHtml(actionLabel)} binding, currently ${escapeHtml(keyLabel)}" aria-describedby="keyboard-binding-help">${escapeHtml(keyLabel)}</button>`;
        }).join('');
        return `<div class="binding-row"><span>${escapeHtml(actionLabel)}</span><div class="binding-row__keys">${buttons}</div></div>`;
      })
      .join('');
    return `
      <fieldset class="settings-bindings"><legend>Keyboard bindings</legend>
        <p class="binding-help" id="keyboard-binding-help" data-binding-status role="status" aria-live="polite">Select a key, then press its replacement. Keys already in use are swapped.</p>
        <div class="keyboard-bindings">${rows}</div>
      </fieldset>
    `;
  }

  #startBindingCapture(button: HTMLButtonElement): void {
    const action = button.dataset.bindingAction as InputAction | undefined;
    const bindingIndex = Number(button.dataset.bindingIndex);
    if (!action || !Number.isInteger(bindingIndex)) return;
    const binding = this.#settings.controls.bindings[action]?.[bindingIndex];
    if (!binding || binding.device !== 'keyboard') return;
    this.#cancelBindingCapture();
    this.#bindingCapture = { action, bindingIndex };
    button.dataset.capturing = 'true';
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', `Press a key for ${INPUT_ACTION_LABELS[action]}. Escape cancels.`);
    button.textContent = 'Press a key…';
    this.#setBindingStatus(`Press a key for ${INPUT_ACTION_LABELS[action]}. Escape cancels.`);
    button.focus();
  }

  #applyKeyboardBinding(capture: BindingCapture, code: string): void {
    const result = remapKeyboardBinding(this.#settings, capture.action, capture.bindingIndex, code);
    this.#bindingCapture = null;
    this.#settings = result.settings;
    this.#callbacks.onSettingsChange(cloneSettings(this.#settings));
    const actionLabel = INPUT_ACTION_LABELS[capture.action];
    const keyLabel = formatKeyboardCode(code);
    const swapMessage = result.swappedAction
      ? ` ${INPUT_ACTION_LABELS[result.swappedAction]} moved to ${formatKeyboardCode(result.previousCode)}.`
      : '';
    this.#refreshBindingControls(`${actionLabel} is now ${keyLabel}.${swapMessage}`, capture);
  }

  #cancelBindingCapture(message?: string): void {
    const capture = this.#bindingCapture;
    if (!capture) return;
    this.#bindingCapture = null;
    this.#refreshBindingControls(message ?? 'Select a key to change its binding.', capture);
  }

  #refreshBindingControls(message: string, focus?: BindingCapture): void {
    this.#root.querySelectorAll<HTMLButtonElement>('[data-binding-action]').forEach((button) => {
      const action = button.dataset.bindingAction as InputAction | undefined;
      const bindingIndex = Number(button.dataset.bindingIndex);
      if (!action || !Number.isInteger(bindingIndex)) return;
      const binding = this.#settings.controls.bindings[action]?.[bindingIndex];
      if (!binding || binding.device !== 'keyboard') return;
      const keyLabel = formatKeyboardCode(binding.code);
      button.textContent = keyLabel;
      button.setAttribute('aria-label', `Change ${INPUT_ACTION_LABELS[action]} binding, currently ${keyLabel}`);
      button.removeAttribute('aria-pressed');
      delete button.dataset.capturing;
    });
    this.#setBindingStatus(message);
    if (focus) {
      this.#root.querySelector<HTMLButtonElement>(
        `[data-binding-action="${focus.action}"][data-binding-index="${focus.bindingIndex}"]`,
      )?.focus();
    }
  }

  #setBindingStatus(message: string): void {
    const status = this.#root.querySelector<HTMLElement>('[data-binding-status]');
    if (status) status.textContent = message;
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

function cloneSettings(settings: GameSettings): GameSettings {
  return JSON.parse(JSON.stringify(settings)) as GameSettings;
}

function readCheckbox(control: HTMLInputElement | HTMLSelectElement): boolean {
  return control instanceof HTMLInputElement && control.checked;
}

function isChoice<const Value extends string>(value: string, choices: readonly Value[]): value is Value {
  return choices.includes(value as Value);
}

function selectOptions<const Value extends string>(choices: readonly Value[], selected: Value): string {
  return choices
    .map((choice) => `<option value="${choice}" ${choice === selected ? 'selected' : ''}>${choice[0]!.toUpperCase()}${choice.slice(1)}</option>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
