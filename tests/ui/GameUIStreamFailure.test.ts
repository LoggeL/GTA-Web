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
  id = '';
  innerHTML = '';
  isConnected = true;
  textContent: string | null = '';
  readonly childrenBySelector = new Map<string, FakeElement>();
  readonly listsBySelector = new Map<string, FakeElement[]>();
  readonly listeners = new Map<string, Array<(event: { target: FakeElement }) => void>>();

  addEventListener(type: string, listener: (event: { target: FakeElement }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector<T extends FakeElement>(selector: string): T | null {
    return (this.childrenBySelector.get(selector) as T | undefined) ?? null;
  }

  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    return (this.listsBySelector.get(selector) ?? []) as T[];
  }

  closest<T extends FakeElement>(selector: string): T | null {
    if (selector === '[data-action]' && this.dataset.action) return this as unknown as T;
    if (selector === '[data-binding-action]' && this.dataset.bindingAction) return this as unknown as T;
    return null;
  }

  contains(element: FakeElement): boolean {
    return element === this || [...this.childrenBySelector.values()].includes(element);
  }

  focus(): void {
    fakeDocument.activeElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
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

function createCallbacks(): GameUICallbacks {
  return {
    onRequestSaveSlots: vi.fn(),
    onStartNewGame: vi.fn(),
    onContinueGame: vi.fn(),
    onDeleteSlot: vi.fn(),
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
  ui: GameUI;
} {
  rootElement = new FakeElement();
  const splash = new FakeElement();
  splash.id = 'splash-screen';
  const game = new FakeElement();
  game.id = 'game-hud';
  const overlay = new FakeElement();
  overlay.hidden = true;
  const message = new FakeElement();
  const retry = new FakeElement();
  retry.dataset.action = 'retry-stream';
  const returnToMenu = new FakeElement();
  returnToMenu.dataset.action = 'return-stream-menu';
  const binding = new FakeElement();
  binding.dataset.bindingAction = 'moveForward';
  binding.dataset.bindingIndex = '0';
  const bindingStatus = new FakeElement();

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

  const callbacks = createCallbacks();
  const ui = new GameUI(rootElement as unknown as HTMLElement, callbacks, createDefaultSettings());
  return { callbacks, overlay, message, retry, returnToMenu, binding, bindingStatus, ui };
}

beforeEach(() => {
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLButtonElement', FakeElement);
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
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
});
