import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSettings } from '../../src/core';
import { GameUI, type GameUICallbacks } from '../../src/ui/GameUI';

class FakeClassList {
  readonly values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }

  toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(token);
    if (enabled) this.values.add(token);
    else this.values.delete(token);
    return enabled;
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  hidden = false;
  inert = false;
  id = '';
  innerHTML = '';
  isConnected = true;
  textContent: string | null = '';
  readonly childrenBySelector = new Map<string, FakeElement>();
  readonly listsBySelector = new Map<string, FakeElement[]>();
  readonly listeners = new Map<string, Array<(event: { target: FakeElement }) => void>>();
  readonly focusableElements: FakeElement[] = [];
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  addEventListener(type: string, listener: (event: { target: FakeElement }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector<T extends FakeElement>(selector: string): T | null {
    return (this.childrenBySelector.get(selector) as T | undefined) ?? null;
  }

  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    if (selector.includes('button:not([disabled])')) return this.focusableElements as T[];
    return (this.listsBySelector.get(selector) ?? []) as T[];
  }

  closest<T extends FakeElement>(selector: string): T | null {
    if (selector === '[data-action]' && this.dataset.action) return this as unknown as T;
    if (selector === '[data-binding-action]' && this.dataset.bindingAction) return this as unknown as T;
    return null;
  }

  matches(selector: string): boolean {
    if (selector === '[data-panel]') return Object.hasOwn(this.dataset, 'panel');
    if (selector === '[data-pause-menu]') return Object.hasOwn(this.dataset, 'pauseMenu');
    if (selector === '[data-stream-failure]') return Object.hasOwn(this.dataset, 'streamFailure');
    return false;
  }

  contains(element: FakeElement): boolean {
    return element === this || this.children.some((child) => child.contains(element));
  }

  focus(): void {
    if (this.hidden || this.inert) return;
    for (let element = this.parentElement; element; element = element.parentElement) {
      if (element.hidden || element.inert) return;
    }
    fakeDocument.activeElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  replaceChildren(): void {
    this.innerHTML = '';
  }

  click(): void {
    for (const listener of rootElement.listeners.get('click') ?? []) listener({ target: this });
  }
}

const fakeDocument: { activeElement: FakeElement | null } = { activeElement: null };
let rootElement: FakeElement;
let windowListeners: Map<string, Array<(event: Record<string, unknown>) => void>>;

function dispatchWindow(type: string, event: Record<string, unknown>): void {
  for (const listener of windowListeners.get(type) ?? []) listener(event);
}

function createCallbacks(): GameUICallbacks {
  return {
    onRequestSaveSlots: vi.fn(),
    onStartNewGame: vi.fn(),
    onContinueGame: vi.fn(),
    onDeleteSlot: vi.fn(),
    onExportSaveSlot: vi.fn(),
    onInspectSaveImport: vi.fn(),
    onImportSave: vi.fn(),
    onExportEmergencySave: vi.fn(),
    onResume: vi.fn(),
    onPause: vi.fn(),
    onQuitToMenu: vi.fn(),
    onOpenPanel: vi.fn(),
    onClosePanel: vi.fn(),
    onTouchAction: vi.fn(),
    onSettingsChange: vi.fn(),
    onRetryStream: vi.fn(),
    onReturnFromStreamFailure: vi.fn(),
  };
}

function createHarness(): {
  callbacks: GameUICallbacks;
  overlay: FakeElement;
  message: FakeElement;
  retry: FakeElement;
  returnToMenu: FakeElement;
  binding: FakeElement;
  bindingStatus: FakeElement;
  game: FakeElement;
  pause: FakeElement;
  pauseTitle: FakeElement;
  resume: FakeElement;
  quit: FakeElement;
  panel: FakeElement;
  panelTitle: FakeElement;
  panelRegion: FakeElement;
  closePanel: FakeElement;
  touchMenu: FakeElement;
  persistenceWarning: FakeElement;
  persistenceMessage: FakeElement;
  emergencyExport: FakeElement;
  ui: GameUI;
} {
  rootElement = new FakeElement();
  const splash = new FakeElement();
  splash.id = 'splash-screen';
  const game = new FakeElement();
  game.id = 'game-hud';
  const overlay = new FakeElement();
  overlay.hidden = true;
  overlay.dataset.streamFailure = '';
  const message = new FakeElement();
  const retry = new FakeElement();
  retry.dataset.action = 'retry-stream';
  const returnToMenu = new FakeElement();
  returnToMenu.dataset.action = 'return-stream-menu';
  const binding = new FakeElement();
  binding.dataset.bindingAction = 'moveForward';
  binding.dataset.bindingIndex = '0';
  const bindingStatus = new FakeElement();
  const pause = new FakeElement();
  pause.hidden = true;
  pause.dataset.pauseMenu = '';
  const pauseTitle = new FakeElement();
  const resume = new FakeElement();
  resume.dataset.action = 'resume';
  const quit = new FakeElement();
  quit.dataset.action = 'quit-menu';
  pause.childrenBySelector.set('[data-pause-title]', pauseTitle);
  pause.childrenBySelector.set('[data-action="resume"]', resume);
  pause.focusableElements.push(resume, quit);
  const panel = new FakeElement();
  panel.hidden = true;
  panel.dataset.panel = '';
  const panelTitle = new FakeElement();
  const panelBody = new FakeElement();
  const panelRegion = new FakeElement();
  const closePanel = new FakeElement();
  closePanel.dataset.action = 'close-panel';
  panel.childrenBySelector.set('[data-panel-title]', panelTitle);
  panel.childrenBySelector.set('[data-action="close-panel"]', closePanel);
  panel.focusableElements.push(closePanel);
  const touchMenu = new FakeElement();
  touchMenu.dataset.action = 'pause';
  const persistenceWarning = new FakeElement();
  persistenceWarning.hidden = true;
  const persistenceMessage = new FakeElement();
  const emergencyExport = new FakeElement();
  emergencyExport.hidden = true;
  emergencyExport.dataset.action = 'export-emergency-save';

  rootElement.append(splash, game, pause, panel, overlay, persistenceWarning);
  game.append(touchMenu, binding, bindingStatus);
  pause.append(pauseTitle, resume, quit);
  panel.append(panelTitle, panelBody, panelRegion, closePanel);
  overlay.append(message, retry, returnToMenu);
  persistenceWarning.append(persistenceMessage, emergencyExport);

  rootElement.listsBySelector.set('[data-screen]', [splash, game]);
  rootElement.listsBySelector.set('[data-touch-action]', []);
  rootElement.listsBySelector.set('[data-binding-action]', [binding]);
  rootElement.childrenBySelector.set('[data-stream-failure]', overlay);
  rootElement.childrenBySelector.set('[data-stream-failure-message]', message);
  rootElement.childrenBySelector.set('[data-stream-retry]', retry);
  rootElement.childrenBySelector.set('[data-binding-status]', bindingStatus);
  rootElement.childrenBySelector.set('[data-binding-action="moveForward"][data-binding-index="0"]', binding);
  rootElement.childrenBySelector.set('[data-action="retry-stream"]', retry);
  rootElement.childrenBySelector.set('[data-action="return-stream-menu"]', returnToMenu);
  rootElement.childrenBySelector.set('[data-pause-menu]', pause);
  rootElement.childrenBySelector.set('[data-pause-title]', pauseTitle);
  rootElement.childrenBySelector.set('[data-panel]', panel);
  rootElement.childrenBySelector.set('[data-panel-title]', panelTitle);
  rootElement.childrenBySelector.set('[data-panel-body]', panelBody);
  rootElement.childrenBySelector.set('[data-panel-region]', panelRegion);
  rootElement.childrenBySelector.set('[data-action="close-panel"]', closePanel);
  rootElement.childrenBySelector.set('[data-action="pause"]', touchMenu);
  rootElement.childrenBySelector.set('[data-persistence-warning]', persistenceWarning);
  rootElement.childrenBySelector.set('[data-persistence-warning-message]', persistenceMessage);
  rootElement.childrenBySelector.set('[data-action="export-emergency-save"]', emergencyExport);
  overlay.focusableElements.push(retry, returnToMenu);

  const callbacks = createCallbacks();
  const ui = new GameUI(rootElement as unknown as HTMLElement, callbacks, createDefaultSettings());
  return {
    callbacks,
    overlay,
    message,
    retry,
    returnToMenu,
    binding,
    bindingStatus,
    game,
    pause,
    pauseTitle,
    resume,
    quit,
    panel,
    panelTitle,
    panelRegion,
    closePanel,
    touchMenu,
    persistenceWarning,
    persistenceMessage,
    emergencyExport,
    ui,
  };
}

beforeEach(() => {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLButtonElement', FakeElement);
  vi.stubGlobal('document', fakeDocument);
  windowListeners = new Map();
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener));
    }),
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => 1),
  });
  fakeDocument.activeElement = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GameUI stream failure blocker', () => {
  it('renders an initially hidden accessible alert dialog with recovery actions', () => {
    const { overlay, ui } = createHarness();

    expect(overlay.hidden).toBe(true);
    expect(rootElement.innerHTML).toContain('role="alertdialog"');
    expect(rootElement.innerHTML).toContain('aria-labelledby="stream-failure-title"');
    expect(rootElement.innerHTML).toContain('aria-describedby="stream-failure-message"');
    expect(rootElement.innerHTML).toContain('data-action="retry-stream"');
    expect(rootElement.innerHTML).toContain('data-action="return-stream-menu"');
    expect(rootElement.innerHTML).toContain('class="touch-menu-button"');
    expect(rootElement.innerHTML).toContain('aria-label="Pause game and open menu"');
    expect(rootElement.innerHTML).toContain('data-pause-menu hidden role="dialog" aria-modal="true"');
    expect(rootElement.innerHTML).toContain('data-panel hidden role="dialog" aria-modal="true"');
    expect(rootElement.innerHTML).toContain('data-dialogue hidden role="status" aria-live="polite"');
    expect(rootElement.innerHTML).toContain('data-persistence-warning hidden role="alert"');
    expect(rootElement.innerHTML).toContain('data-action="export-emergency-save"');
    expect(rootElement.innerHTML).toContain('data-save-import-file type="file"');
    expect(rootElement.innerHTML).toContain('data-save-import-destination disabled');
    expect(rootElement.innerHTML).toContain('data-action="confirm-save-import" disabled');
    expect(rootElement.innerHTML.match(/data-meter="(?:health|armor|stamina)" role="progressbar"/g)).toHaveLength(3);
    expect(rootElement.innerHTML).toContain('data-hud-xp role="progressbar"');

    ui.destroy();
  });

  it('shows the supplied failure, focuses Retry, and hides without changing pause state', () => {
    const { message, overlay, retry, ui } = createHarness();
    rootElement.classList.add('is-paused');

    ui.showStreamFailure('Breakwater chunk timed out after three attempts.');

    expect(overlay.hidden).toBe(false);
    expect(message.textContent).toBe('Breakwater chunk timed out after three attempts.');
    expect(fakeDocument.activeElement).toBe(retry);
    expect(rootElement.classList.contains('has-stream-failure')).toBe(true);
    expect(rootElement.classList.contains('is-paused')).toBe(true);

    ui.hideStreamFailure();

    expect(overlay.hidden).toBe(true);
    expect(rootElement.classList.contains('has-stream-failure')).toBe(false);
    expect(rootElement.classList.contains('is-paused')).toBe(true);
  });

  it('cancels an in-progress keyboard binding capture before blocking the UI', () => {
    const { binding, bindingStatus, retry, ui } = createHarness();
    binding.click();
    expect(binding.dataset.capturing).toBe('true');

    ui.showStreamFailure('Arroyo Heights failed to stream.');

    expect(binding.dataset.capturing).toBeUndefined();
    expect(binding.attributes.has('aria-pressed')).toBe(false);
    expect(binding.textContent).toBe('W');
    expect(bindingStatus.textContent).toContain('cancelled because world streaming stopped');
    expect(fakeDocument.activeElement).toBe(retry);
  });

  it('clears stale inert state before focusing a newly revealed higher-priority blocker', () => {
    const { overlay, pause, retry, touchMenu, ui } = createHarness();

    ui.showGame();
    touchMenu.focus();
    touchMenu.click();
    expect(overlay.inert).toBe(true);

    ui.showStreamFailure('Neon Strand failed to stream.');

    expect(overlay.inert).toBe(false);
    expect(pause.inert).toBe(true);
    expect(fakeDocument.activeElement).toBe(retry);
  });

  it('keeps the blocker up for Retry and dismisses before returning to the menu', () => {
    const { callbacks, overlay, retry, returnToMenu, ui } = createHarness();
    ui.showStreamFailure('Alta Vista failed to stream.');

    retry.click();
    expect(callbacks.onRetryStream).toHaveBeenCalledOnce();
    expect(overlay.hidden).toBe(false);

    returnToMenu.click();
    expect(overlay.hidden).toBe(true);
    expect(callbacks.onReturnFromStreamFailure).toHaveBeenCalledOnce();
  });

  it('keeps a persistence warning visible, exports its emergency snapshot, and makes it inert under a modal', () => {
    const {
      callbacks,
      persistenceWarning,
      persistenceMessage,
      emergencyExport,
      touchMenu,
      ui,
    } = createHarness();

    ui.showPersistenceWarning({
      message: 'Slot 2 could not be written because browser storage is full.',
      emergencyExport: '{"format":"heatline-solara-save"}',
    });

    expect(persistenceWarning.hidden).toBe(false);
    expect(persistenceMessage.textContent).toContain('storage is full');
    expect(emergencyExport.hidden).toBe(false);
    emergencyExport.click();
    expect(callbacks.onExportEmergencySave).toHaveBeenCalledWith('{"format":"heatline-solara-save"}');

    ui.showGame();
    touchMenu.click();
    expect(persistenceWarning.hidden).toBe(false);
    expect(persistenceWarning.inert).toBe(true);

    ui.hidePause();
    expect(persistenceWarning.inert).toBe(false);
    ui.clearPersistenceWarning();
    expect(persistenceWarning.hidden).toBe(true);
  });

  it('opens from the touch menu, nests the panel accessibly, and restores focus and inert state', () => {
    const {
      callbacks,
      game,
      pause,
      pauseTitle,
      resume,
      panel,
      panelTitle,
      panelRegion,
      touchMenu,
      ui,
    } = createHarness();

    ui.showGame();
    touchMenu.focus();
    touchMenu.click();
    expect(callbacks.onPause).toHaveBeenCalledOnce();
    expect(pause.hidden).toBe(false);
    expect(fakeDocument.activeElement === pauseTitle).toBe(true);
    expect(game.inert).toBe(true);

    resume.focus();
    ui.openPanel('settings');
    expect(panel.hidden).toBe(false);
    expect(panelRegion.dataset.panel).toBe('settings');
    expect(fakeDocument.activeElement === panelTitle).toBe(true);
    expect(pause.inert).toBe(true);
    expect(panel.inert).toBe(false);

    ui.closePanel();
    expect(panel.hidden).toBe(true);
    expect(fakeDocument.activeElement === resume).toBe(true);
    expect(pause.inert).toBe(false);
    expect(game.inert).toBe(true);

    ui.hidePause();
    expect(pause.hidden).toBe(true);
    expect(fakeDocument.activeElement === touchMenu).toBe(true);
    expect(game.inert).toBe(false);
  });

  it('wraps modal Tab focus and handles panel then pause Escape without leaking the key', () => {
    const { callbacks, pause, resume, quit, panel, touchMenu, ui } = createHarness();
    const keyboardEvent = (key: string, shiftKey = false) => ({
      key,
      code: key,
      shiftKey,
      repeat: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    });

    ui.showGame();
    vi.mocked(callbacks.onClosePanel).mockClear();
    touchMenu.focus();
    touchMenu.click();
    quit.focus();
    const forwardTab = keyboardEvent('Tab');
    dispatchWindow('keydown', forwardTab);
    expect(fakeDocument.activeElement === resume).toBe(true);
    expect(forwardTab.preventDefault).toHaveBeenCalledOnce();

    const reverseTab = keyboardEvent('Tab', true);
    dispatchWindow('keydown', reverseTab);
    expect(fakeDocument.activeElement === quit).toBe(true);

    resume.focus();
    ui.openPanel('settings');
    const closePanelEvent = keyboardEvent('Escape');
    dispatchWindow('keydown', closePanelEvent);
    expect(panel.hidden).toBe(true);
    expect(pause.hidden).toBe(false);
    expect(callbacks.onClosePanel).toHaveBeenCalledOnce();
    expect(closePanelEvent.stopImmediatePropagation).toHaveBeenCalledOnce();

    const resumeEvent = keyboardEvent('Escape');
    dispatchWindow('keydown', resumeEvent);
    expect(pause.hidden).toBe(true);
    expect(callbacks.onResume).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement === touchMenu).toBe(true);
  });
});
